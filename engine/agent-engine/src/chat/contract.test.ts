/* CONTRACT.md, BOUNDARY 2 (engine <-> app): THE ENGINE HALF OF THE ENFORCEMENT.
 *
 * WHY THIS FILE EXISTS
 *
 * CONTRACT.md is the frozen agreement between this engine and the app, and this
 * file is the only thing that holds the engine to it. It pins six invariants on
 * the wire this engine speaks (E1-E4, E7, E8; E5/E6 were window-model invariants
 * the pointer-page model retired), plus the plugin declaration burst and L1, and
 * every test below is TITLED with the invariant's id so a violation fails with
 * the name of the clause it broke rather than a sentence somebody has to map
 * back to the contract by hand.
 *
 * Several of these are also proven, in more detail, by the file that owns the
 * feature (attach.test.ts for the pages, events-history.test.ts for E9). They
 * are re-asserted here UNDER THE INVARIANT'S NAME because the contract is the
 * thing a future edit has to argue with, and an argument needs the id in the
 * failure.
 *
 * E7 is the one this file made true. The two delivery-failure echoes in
 * server.ts sent a "(message not sent: ...)" bubble to the one socket that
 * asked, never logged it, never broadcast it, and stamped a raw Date.now(): a
 * ghost bubble that existed on one device and died on reload. They go through
 * noticeChat now (log + stampTs + broadcast), the same shape as the restart
 * notice.
 *
 * NOT HERE, ON PURPOSE: "the sealed DataChannel is the only client wire". That
 * sentence cannot be proven without the real transport, so it lives in
 * e2e/roundtrip.test.ts, which dials one. Everything else is provable in
 * process: wireCore performs server.ts's own ordered boot, the frames go in
 * through the SHIPPED dispatcher, and the HTTP halves run against the SHIPPED
 * route group over a real Bun.serve on port 0.
 *
 *   bun test agent-engine/src/chat/contract.test.ts
 */

import { test, expect, afterEach, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { wireCore, type WireCore, type FakeClient, wireId } from "../test-utils/wire-core.ts";
import { chatStore } from "../sessions/session-state.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { chatRoutes } from "../routes/chat.ts";
import { dispatchClientFrame } from "../transport/frames.ts";
import { dispatchSessionFrame } from "../runtime/mcp.ts";
import { onUtterance } from "./deliver.ts";
import type { Sock } from "../transport/sock.ts";

/* TWO ENV VARS, SET FOR THE WHOLE FILE (the file-scope rule), because both are
 * facts about the engine under test rather than about one case:
 *
 *   CYC_PLUGINS_TEST loads the fixture plugin. It is the only plugin with real
 *   hooks, so it is the one whose decl would show a leak if the spec/decl split
 *   ever broke.
 *
 *   ENGINE_AGENT is the RETIRED filter (#587). Before #587 this variable decided
 *   which panes counted as sessions, and setting it to "codex" made every claude
 *   pane invisible by construction -- which is what he reported. Setting it for
 *   the whole file, rather than for one test, is the stronger claim: NOTHING
 *   below is filtered by it, including the mixed fleet L1 asserts on. */
const prevPlugins = process.env.CYC_PLUGINS_TEST;
const prevAgent = process.env.ENGINE_AGENT;
const prevSettle = process.env.DELIVER_SETTLE_MS;
process.env.CYC_PLUGINS_TEST = "1";
process.env.ENGINE_AGENT = "codex";
/* And the third: the measured 250ms settle between a body and its enter, which
 * a fake pane does not need and which nothing here asserts. */
process.env.DELIVER_SETTLE_MS = "5";
afterAll(() => {
  if (prevPlugins === undefined) delete process.env.CYC_PLUGINS_TEST;
  else process.env.CYC_PLUGINS_TEST = prevPlugins;
  if (prevAgent === undefined) delete process.env.ENGINE_AGENT;
  else process.env.ENGINE_AGENT = prevAgent;
  if (prevSettle === undefined) delete process.env.DELIVER_SETTLE_MS;
  else process.env.DELIVER_SETTLE_MS = prevSettle;
});

let core: WireCore | null = null;
let http: ServedRoutes | null = null;
afterEach(async () => {
  /* Every queued chat append on disk before the tmp tree goes: an append still
   * in flight when the directory is removed prints an ENOENT nobody can act on. */
  await chatStore.flush();
  http?.stop();
  http = null;
  await core?.stop();
  core = null;
});

/** The session's own MCP socket: the only honest way to put an AGENT line in a
 *  log. Never in wire.ts's client set, so what a CLIENT saw stays a separate
 *  question from what the tool was acked. */
function mcpSock(sessionId: string): Sock {
  return {
    data: { role: "session", sessionId, terms: new Map() },
    readyState: 1, remoteAddr: "127.0.0.1",
    send(s: string) { return s.length; }, close() { /* nothing holds it */ },
  } as unknown as Sock;
}

async function boot(opts: Parameters<typeof wireCore>[0] = {}): Promise<WireCore> {
  core = await wireCore({ with: ["delivery", "plugins", "frames"], ...opts });
  await until(() => core!.sessions.size >= 1, { what: "the fleet to reconcile" });
  return core;
}

/** The shipped chat routes (pages, search, the activity pager) over port 0. */
function routes(c: WireCore): ServedRoutes {
  http = serveRoutes({ groups: [chatRoutes], ctx: { adapter: c.adapter } });
  return http;
}

/** `n` agent replies through the real reply path. */
async function seed(c: WireCore, n: number, id = PANE): Promise<void> {
  const mcp = mcpSock(id);
  for (let i = 0; i < n; i++) {
    await dispatchSessionFrame(mcp, { t: "chat", text: `m${i}`, msgId: crypto.randomUUID() });
  }
  expect(c.sessionOf(id)!.chat.length).toBe(n);
}

/** Attach and hand back the answer frame. */
async function attach(c: WireCore, id: string, client?: FakeClient): Promise<Record<string, any>> {
  const page = client ?? c.client();
  // the frame is keyed by the wire id; a handle is translated, an unknown id rides as is
  await dispatchClientFrame(page.sock, { t: "attach", id: wireId(id) });
  await until(() => page.last("attach-ok") !== undefined, { what: `an attach-ok for ${id}` });
  return page.last("attach-ok")!;
}

/** The conversation the app is handed on attach, oldest-first, gathered across
 *  the pointer + tail pages and de-duped by seq. This is the page-era
 *  replacement for "the chat frames that followed a chat-start". */
function attachMsgs(ok: Record<string, any> | undefined): any[] {
  const bySeq = new Map<number, any>();
  for (const p of ok?.pages ?? []) for (const m of p.messages) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

test("E1 attach-always-answered: every attach gets an attach-ok, success says known: true out loud",
  async () => {
    const c = await boot();
    await seed(c, 3);

    /* The owned session. The contract's addition over attach.test.ts is the
     * explicit `known: true`: absence must mean "an engine older than this
     * field", never "the engine chose not to say". */
    const ok = await attach(c, PANE);
    expect(ok.known,
      "the success attach-ok does not carry `known: true` explicitly; a reader must not " +
      "have to invent a value the sender did not send").toBe(true);
    expect(ok.total, "total must be the whole log length").toBe(3);
    expect(attachMsgs(ok).map((m) => m.text),
      "the attach answer's pages do not hold the whole short log, oldest-first")
      .toEqual(["m0", "m1", "m2"]);

    /* The unknown session: answered and marked, so a page that reached a chat on
     * the wrong engine keeps what it holds and stops waiting rather than
     * painting over it. */
    const missing = "w9:pNOSUCH";
    const miss = await attach(c, missing);
    expect(miss.id, "the answer must come back for the id that was asked, the key the page waits on")
      .toBe(missing);
    expect(miss.known, "an unknown session must be marked known: false").toBe(false);
    expect(miss.pages, "an unknown session must carry no pages").toBeUndefined();
  });

test("E2 pages-cover-the-log: attach hands the pointer + tail pages, GET /page fills the gap, and " +
  "together they cover the log once with the middle sealed", async () => {
    const c = await boot();
    const N = 250; // pages 0, 1 full and sealed; page 2 the tail (50)
    await seed(c, N);
    const r = routes(c);

    const ok = await attach(c, PANE);
    expect(ok.total).toBe(N);
    expect(ok.tailPage).toBe(2);
    // nothing read, so the pointer is on page 0; attach carries page 0 and the tail
    expect(ok.pointerPage).toBe(0);
    expect(ok.pages.map((p: any) => p.page).sort()).toEqual([0, 2]);

    // the gap (page 1) is fetched over HTTP, and is sealed and immutable
    const p1 = await r.get(`/session/${encodeURIComponent(wireId(PANE))}/page/1`)
      .then((x) => x.json() as Promise<any>);
    expect(p1.sealed, "a page below the tail must be sealed").toBe(true);
    expect(p1.messages.length).toBe(100);

    // union of the two attach pages + the fetched middle covers the log exactly once
    const all = [...ok.pages.flatMap((p: any) => p.messages), ...p1.messages];
    const seqs = all.map((m: any) => m.seq).sort((x, y) => x - y);
    expect(new Set(seqs).size, "a message appeared on more than one page").toBe(N);
    expect(seqs[0]).toBe(0);
    expect(seqs[N - 1]).toBe(N - 1);
    // no holes either: the seqs are 0..N-1 with nothing missing
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i));
    // the sealed pages are full and final; only the tail is short
    expect(ok.pages.find((p: any) => p.page === 0)!.sealed).toBe(true);
    expect(ok.pages.find((p: any) => p.page === 2)!.sealed).toBe(false);
    // and a message's page is floor(seq / pageSize), for every message
    for (const m of all) expect(Math.floor(m.seq / ok.pageSize)).toBe(
      [...ok.pages, p1].find((p: any) => p.messages.includes(m))!.page);
  });

test("E8 page-route-always-answered: a known page is served (empty beyond the log), an unknown " +
  "session is a marked 404", async () => {
    const c = await boot();
    await seed(c, 5);
    const r = routes(c);

    // a page beyond the log is a well-defined empty answer, never a hang or a 500
    const beyond = await r.get(`/session/${encodeURIComponent(wireId(PANE))}/page/9`);
    expect(beyond.ok).toBe(true);
    const bj = await beyond.json() as any;
    expect(bj.page).toBe(9);
    expect(bj.messages, "a page beyond the log must be an explicit empty page").toEqual([]);
    expect(bj.version, "an empty page reports its own base seq as its version").toBe(900);

    // an unknown session is a marked 404, the page-route twin of E1's unknown attach
    const miss = await r.get("/session/does-not-exist/page/0");
    expect(miss.status, "an unknown session's page must 404, not 200 with an empty log").toBe(404);
    expect((await miss.json() as any).known,
      "an unknown session's page must be marked known: false").toBe(false);
  });

test("E3 one-message-shape: a live chat frame and an attach-page message carry only the " +
  "documented fields", async () => {
    /* The documented shape, CONTRACT.md boundary 2. A field the engine emits
     * that is not on this list DOES NOT EXIST as far as the app is concerned
     * (the app rebuilds frames field by field), so emitting one is either dead
     * weight or a second shape growing in the dark.
     *
     * Two carriers: a live broadcast rides `{t:"chat", id, ...}`; a message
     * inside an attach page carries no `t` (the page frame carries it) but does
     * carry `seq`, its place in the conversation. One ALLOWED set covers both. */
    const ALLOWED = new Set(["t", "id", "seq", "role", "text", "ts", "msgId", "mid", "kind",
      "durationS", "file", "upload", "uploads", "queued", "cid", "scheduled", "wordsFailed"]);

    const c = await boot();
    await seed(c, 6);
    const collector = c.client();

    // a live agent reply, broadcast as it lands
    await dispatchSessionFrame(mcpSock(PANE), { t: "chat", text: "live reply", msgId: crypto.randomUUID() });
    expect(collector.of("chat").some((f) => f.role === "claude" && f.text === "live reply"),
      "a live agent reply never arrived as a {t:'chat'} frame").toBe(true);

    // a user utterance echo (the ack, E4's frame, here only for its shape)
    await onUtterance(collector.sock, { id: wireId(PANE), text: "typed by hand", cid: "cid-e3-shape" });
    expect(collector.of("chat").some((f) => f.role === "user" && f.text === "typed by hand"),
      "the user echo never arrived as a {t:'chat'} frame").toBe(true);

    // an attach replay: the conversation rides inside the answer's pages
    const ok = await attach(c, PANE, collector);
    const sample = [...collector.of("chat"), ...attachMsgs(ok)];
    expect(sample.length, "the sample collected nothing; the test is not testing").toBeGreaterThan(6);

    for (const f of sample) {
      expect(["user", "claude"].includes(f.role),
        `a message carries role '${f.role}'. The contract allows 'user' | 'claude' and nothing ` +
        `else: ${JSON.stringify(f)}`).toBe(true);
      const strays = Object.keys(f).filter((k) => !ALLOWED.has(k));
      expect(strays,
        `a message carries undocumented field(s) ${JSON.stringify(strays)}. The app rebuilds ` +
        "frames field by field, so a field added anywhere else does not exist; one that leaks " +
        `anyway is a shape drifting away from the contract: ${JSON.stringify(f)}`).toEqual([]);
    }

    /* AND THERE IS NO SECOND SHAPE. No user-message frame, no agent-message
     * frame, no partial-message frame: every conversation line on this socket
     * arrived as `{t:"chat"}`, and the queue state rides its own tiny frame by
     * (id, ts) rather than carrying a second copy of the message. */
    const carriers = new Set(collector.frames.map((f) => f.t as string));
    for (const banned of ["user-message", "agent-message", "message", "chat-start", "older"]) {
      expect(carriers.has(banned), `a second conversation-line shape is on the wire: ${banned}`)
        .toBe(false);
    }
  });

test("E4 echo-is-the-ack: an accepted utterance is broadcast back as a user chat frame carrying " +
  "the sender's cid, to every client", async () => {
    const c = await boot();
    const a = c.client();
    const b = c.client();

    await onUtterance(a.sock, { id: wireId(PANE), text: "ack me", cid: "cid-e4-ack" });

    /* The SECOND socket is the assertion. An echo sent back to the sender alone
     * would satisfy the sender's requeue logic while every other device shows a
     * conversation with a hole in it until the next attach. */
    const onB = b.of("chat").find((f) => f.role === "user" && f.cid === "cid-e4-ack");
    expect(onB,
      "the utterance echo never reached a client that was not the sender. The echo IS the " +
      "delivery ack and it must be a broadcast: sender-only, the other phone's chat is missing " +
      `the message until its next attach. Frames on B: ${JSON.stringify(b.frames.map((f) => f.t))}`)
      .toBeTruthy();
    expect(onB!.text, "the echo does not carry the message body").toBe("ack me");

    const onA = a.of("chat").find((f) => f.role === "user" && f.cid === "cid-e4-ack");
    expect(onA,
      "the echo reached the second client but not the sender, whose optimistic bubble now " +
      "never settles: no echo = not delivered, so the app would requeue a message that landed")
      .toBeTruthy();
    // and it is ONE echo, not one per client-visible event: a doubled echo would
    // settle the bubble and then draw a second one beside it
    expect(a.of("chat").filter((f) => f.cid === "cid-e4-ack").length).toBe(1);
    // the echo carries the engine's seq, so the bubble settles into the log's order
    expect(typeof onA!.seq).toBe("number");
  });

test("E7/F2 a delivery failure lands on the sender's row, not in a broadcast notice: it is a " +
  "`send-failed` on the cid to the sender only, the message is not written, and no line is logged " +
  "or broadcast", async () => {
    /* Both error paths in one wiring. The missing-attachment branch refuses
     * before any keystroke, so failKeys does not touch it; the refused-keystroke
     * branch is exactly what failKeys: () => true produces (herdr refuses the
     * enter, injectUserMessage rolls back, dropDead speaks).
     *
     * THE REPORT MOVED (F2). It used to be a grey notice bubble routed through
     * noticeChat -- logged, stamped and broadcast to every device -- for a
     * message only ONE device ever saw. That is now a `send-failed {id, cid,
     * reason}` on the SENDER'S socket alone: the row that showed the single
     * 'sent' tick flips to 'failed' with the reason and a retry tap, matching
     * the offline precedent, and the devices that never saw the send are told
     * nothing. E7 (every-line-is-logged) still governs genuine chat lines
     * (replies, the restart notice); a delivery failure is no longer one. */
    const c = await boot({ failKeys: () => true });
    await seed(c, 2); // real rows the failure must NOT join

    /* AN ATTACHMENT THIS ENGINE MINTED WHOSE FILE IS GONE. A made-up uploadId is
     * a forge and is dropped in silence; the failure only fires for an id we
     * actually wrote and then lost, so the file is staged, the wiring is redone
     * (which is how makeUploads inherits the ids already on disk, exactly as a
     * boot does), and only then is the file removed. */
    const uploadId = crypto.randomUUID();
    const staged = join(c.uploads!.dir, `${uploadId}-gone.txt`);
    await Bun.write(staged, "gone");
    await c.reset();
    await until(() => c.sessions.size >= 1, { what: "the pane after the re-wire" });
    expect(c.uploads!.minted.has(uploadId), "the staged upload was not inherited at boot").toBe(true);
    await unlink(staged);

    const a = c.client();
    const b = c.client();

    // path one: the attachment that is no longer on disk
    await onUtterance(a.sock, { id: wireId(PANE), cid: "cid-e7-attach", text: "see the file",
      upload: { uploadId, name: "gone.txt", mime: "text/plain", size: 4,
        path: "/tmp/forged-path", image: false } });
    const attachFail = a.of("send-failed").find((f) => f.cid === "cid-e7-attach");
    expect(attachFail,
      "the missing-attachment failure never reached the sender's row as a send-failed on its cid")
      .toBeTruthy();
    expect(String(attachFail!.reason), "the reason does not name the missing file").toMatch(/gone\.txt/);
    expect(String(attachFail!.reason)).toMatch(/no longer on the engine/);

    // path two: a live pane that refuses the keystrokes
    await onUtterance(a.sock, { id: wireId(PANE), cid: "cid-e7-refused", text: "this will be refused" });
    const refuseFail = a.of("send-failed").find((f) => f.cid === "cid-e7-refused");
    expect(refuseFail, "the refused-delivery failure never reached the sender's row").toBeTruthy();
    expect(String(refuseFail!.reason)).toMatch(/not delivered/);

    /* THE FAILURE IS THE SENDER'S, NOT A BROADCAST. B never saw either send, so
     * it gets no notice bubble and no send-failed of its own. This is the whole
     * point of the move: the old bubble was broadcast to every device for a
     * message one device sent. */
    expect(b.of("chat").filter((f) => f.role === "claude"),
      `a delivery failure was broadcast to a device that never saw the send; B: ${JSON.stringify(b.frames.map((f) => f.t))}`)
      .toEqual([]);
    expect(b.of("send-failed"),
      "a send-failed was broadcast rather than sent to the sender's socket alone").toEqual([]);

    // ...and NEITHER message is in the log: they never landed.
    expect(c.byHandle(PANE)!.chat.some((m) => m.text === "this will be refused"),
      "a message that was never delivered was written into the conversation anyway").toBe(false);
    expect(c.byHandle(PANE)!.chat.some((m) => m.text === "see the file"),
      "the missing-attachment message was written into the conversation anyway").toBe(false);

    /* AND NO NOTICE LEAKED INTO THE LOG. A fresh attach replays the two seeded
     * rows and nothing else: a delivery failure is a frame on the row now, never
     * a logged chat line. */
    const chats = attachMsgs(await attach(c, PANE));
    expect(chats.some((f) => /message not sent|not delivered/.test(f.text ?? "")),
      "a delivery failure leaked back into the logged conversation as a notice bubble").toBe(false);
  });

/* E-plugins (#479): the hello burst declares plugins, functions never ride it,
 * and an engine with none sends the identical bytes it always did.
 *
 * The declaration is additive and sits right after `can`. This is the tabs rule
 * applied to a second engine-declared UI structure: the app renders exactly what
 * it is given, absence means "old engine, fall back", and the SPEC's hooks
 * (render/rpc/html) stay on the engine -- only the static decl crosses. The
 * fixture plugin (CYC_PLUGINS_TEST, set for this whole file) is the only plugin
 * with hooks that would serialise to something recognisable if the split ever
 * leaked. */
async function helloFrames(c: WireCore): Promise<Record<string, any>[]> {
  const client = c.client();
  c.hello(client);
  return client.frames;
}

test("E-plugins: the hello burst carries a decl-only plugins frame after `can`", async () => {
  const c = await boot();
  const frames = await helloFrames(c);
  const can = frames.find((f) => f.t === "can");
  expect(can, "no `can` frame in the burst").toBeTruthy();
  expect(can!.list, "the `can` list must advertise the plugins capability so an app knows to " +
    "expect the frame and the /plugin routes").toContain("plugins");

  const idxCan = frames.findIndex((f) => f.t === "can");
  const idxPlugins = frames.findIndex((f) => f.t === "plugins");
  expect(idxPlugins, "no `{t:'plugins'}` frame arrived despite a loaded plugin").toBeGreaterThanOrEqual(0);
  expect(idxPlugins, "the plugins frame must follow `can`, not precede it").toBeGreaterThan(idxCan);

  const fx = (frames[idxPlugins].list ?? []).find((p: any) => p.id === "fixture");
  expect(fx, "the fixture plugin is not in the declared list").toBeTruthy();
  // the decl shape, and NOT one function byte
  expect(fx.card).toEqual({ title: "Fixture Card", refreshFloorS: 5 });
  expect(fx.panel).toEqual({ icon: "gear", label: "Fixture", needsSession: true,
    ops: ["echo", "big"], toolbarDefault: false });
  expect(Array.isArray(fx.composer)).toBe(true);
  /* Scoped to the FIXTURE decl (the one plugin with hooks): scanning the whole
   * frame false-trips on legitimate content -- the reply-dials plugin's prompt
   * bits include "interactive html page", which is a bit he types, not a hook.
   * The fixture is where a leaked function/hook would actually surface. */
  const flat = JSON.stringify(fx);
  expect(flat.includes("render") || flat.includes("rpc") || flat.includes("html") || flat.includes("boom"),
    "a hook name reached the wire; render/rpc/html/dedupe must stay engine-side").toBe(false);
});

test("E-plugins: a default engine declares the usage-card built-in (engine-level card, no panel)",
  async () => {
    const c = await boot();
    const frames = await helloFrames(c);
    const pl = frames.find((f) => f.t === "plugins");
    expect(pl, "a real engine ships the usage-card built-in, so it must send a plugins frame")
      .toBeTruthy();
    const usage = (pl!.list ?? []).find((p: any) => p.id === "usage-card");
    expect(usage, "the usage-card plugin is not declared").toBeTruthy();
    expect(usage.card).toEqual({ title: "Plan usage", refreshFloorS: 5 });
    expect(usage.panel, "the usage card is a card, not a panel").toBeUndefined();
    expect(frames.find((f) => f.t === "can")!.list).toContain("plugins");
  });

test("E-plugins: a default engine declares reply-dials, and its composer == the fixture (#585)",
  async () => {
    /* The reply dials are a compiled-in built-in (#585), so a real engine's burst
     * carries them. Its composer decl (default names, value 3) is the checked-in
     * fixture the app spec reads too, so both ends assert against one file and
     * cannot drift. */
    const c = await boot();
    const frames = await helloFrames(c);
    const pl = frames.find((f) => f.t === "plugins");
    const dials = (pl!.list ?? []).find((p: any) => p.id === "reply-dials");
    expect(dials, "the reply-dials plugin is not declared on a default engine").toBeTruthy();
    const fixture = JSON.parse(readFileSync(
      new URL("../fixtures/reply-dials.decl.json", import.meta.url).pathname, "utf8"));
    expect(dials).toEqual(fixture);
    /* SHIP DEFAULT (his call): bits + verbosity ship on, complexity ships OFF, so
     * a fresh engine declares TWO widgets in pill order. */
    expect(dials.composer.map((w: any) => [w.type, w.key])).toEqual([
      ["menu", "bits"], ["slider", "verbosity"],
    ]);
  });

test("E-plugins: a default engine declares the model-indicator built-in (#563 example)", async () => {
  /* The example plugin rides the real burst of a real wiring: the seam server.ts
   * wires (modelOf) is what puts it in the list, so this proves the end-to-end
   * declaration, not just the decl-shaping the plugins unit test covers. */
  const c = await boot();
  const frames = await helloFrames(c);
  const pl = frames.find((f) => f.t === "plugins");
  const model = (pl!.list ?? []).find((p: any) => p.id === "model-indicator");
  expect(model, "the model-indicator plugin is not declared").toBeTruthy();
  expect(model.panel).toEqual({ icon: "🤖", label: "Model", needsSession: true, ops: ["model"],
    dock: "side", badge: "model", toolbarDefault: false });
  expect(model.card, "the model indicator is a panel, not a card").toBeUndefined();
});

test("E-plugins: an engine with no fixture declares exactly the built-ins, and nothing test-only",
  async () => {
    /* THE WORD "DEFAULT" IN THE THREE TESTS ABOVE IS A SHORTHAND, and on its own
     * it is not true: CYC_PLUGINS_TEST is set for this whole file, so every
     * burst above carries the fixture beside the built-ins. Each of those tests
     * asks about ONE built-in and is right about it -- but nothing was left
     * asking the sentence #479 actually promises, which is about the LIST:
     *
     *     "an engine with none sends the identical bytes it always did"
     *
     * A fixture that leaked into a real engine's declaration would be invisible
     * to every assertion in this file, because every assertion in this file
     * looks for one id and ignores the rest. So this one boots WITHOUT the
     * fixture and pins the whole set.
     *
     * THE ENV IS MOVED MID-FILE, which the suite's rule otherwise forbids, and
     * this is the one seam where that is the honest thing to do: loadPlugins
     * reads CYC_PLUGINS_TEST INSIDE the call, on every call (registry.ts), so it
     * is the module's own switch rather than a value captured at import. Tests
     * within a file run one at a time, the wiring is per-test, and the finally
     * puts the process back exactly as it was -- which is the same seam
     * plugins.test.ts uses for the same reason. */
    const had = process.env.CYC_PLUGINS_TEST;
    let frames: Record<string, any>[];
    try {
      delete process.env.CYC_PLUGINS_TEST;
      frames = await helloFrames(await boot());
    } finally {
      if (had === undefined) delete process.env.CYC_PLUGINS_TEST;
      else process.env.CYC_PLUGINS_TEST = had;
    }

    const pl = frames.find((f) => f.t === "plugins");
    expect(pl, "a real engine ships built-ins, so it must still send a plugins frame").toBeTruthy();
    const ids = (pl!.list ?? []).map((p: any) => p.id).sort();

    /* THE WHOLE SET, SPELLED OUT, and what it is a set OF. loadPlugins takes a
     * deps bag and declares a built-in only where the dep behind it exists
     * (registry.ts), so this is the list for the wiring wireCore's "plugins"
     * layer builds -- the crons ticker and the voice proxy are not in it,
     * because this file does not wire a schedule store or a voice engine and
     * server.ts's own list would name them.
     *
     * That still makes it worth pinning. A built-in ARRIVING is as much a change
     * to the app's bar as one leaving, and both should be decisions somebody
     * made on purpose rather than a diff nobody read; and no dep in this bag can
     * explain a `fixture` appearing, which is the leak the assertion below is
     * really for. */
    expect(ids, "the built-in set this wiring declares has changed").toEqual([
      "ctx", "files", "git", "model-indicator", "reply-dials",
      "search", "stop", "tui", "usage-card",
    ]);
    expect(ids, "the test fixture reached a burst with CYC_PLUGINS_TEST unset")
      .not.toContain("fixture");
    // ...and the capability is advertised whether or not a fixture is loaded
    expect(frames.find((f) => f.t === "can")!.list).toContain("plugins");
  });

/* L1 every-stamped-pane-listed. A pane the multiplexer stamps as running an agent
 * is a session row, whatever the agent; the engine never hides a session by agent
 * id. Each row carries `agent` (display name) and `agentId` (the stamp), and a row
 * for an agent the engine cannot read carries the nulls (contextPct, model, ask)
 * rather than a value borrowed from another agent. The wire's claudeSessionId is
 * each row's OWN overlay-capable id since the harness-event-tails lane: derived
 * from the reader's declared sessionEvents slot, so a codex/opencode row carries
 * its own harness id there (never claude's), and a slotless harness stays null.
 *
 * This is the invariant #587 established: the old engine filtered the herdr
 * snapshot on ONE agent id, so a codex or opencode pane was invisible by
 * construction, which is what he reported. */
async function sessionsList(c: WireCore): Promise<any[]> {
  const frames = await helloFrames(c);
  return frames.find((f) => f.t === "sessions")?.list ?? [];
}

test("L1 every-stamped-pane-listed: a mixed claude/codex/opencode fleet lists all three, named",
  async () => {
    // three panes in one workspace, three different agent stamps. The opencode one
    // is stamped `herdr:opencode` to prove the engine normalizes the alias.
    const c = await boot({
      panes: ["w1:p1", "w1:p2", "w1:p3"],
      agents: { "w1:p1": "claude", "w1:p2": "codex", "w1:p3": "herdr:opencode" },
    });
    await until(() => c.sessions.size === 3, { what: "all three panes to reconcile" });
    const list = await sessionsList(c);

    expect(list.length, "all three stamped panes are sessions, none hidden by agent").toBe(3);
    const byPane = (handle: string) => list.find((s: any) => s.id === wireId(handle))!;
    const claude = byPane("w1:p1");
    const codex = byPane("w1:p2");
    const oc = byPane("w1:p3");

    // the display name rides the row, per agent (not one harness name for all)
    expect(claude.agent).toBe("Claude");
    expect(codex.agent).toBe("Codex");
    expect(oc.agent, "the display name keeps opencode's own lowercase spelling").toBe("opencode");
    // the raw normalized id is on the wire too, herdr:opencode folded to opencode
    expect(claude.agentId).toBe("claude");
    expect(codex.agentId).toBe("codex");
    expect(oc.agentId).toBe("opencode");

    // an agent the engine cannot read carries the nulls, never a borrowed value
    for (const row of [codex, oc]) {
      expect(row.contextPct, "no context for an unreadable agent").toBeNull();
      expect(row.model, "no model for an unreadable agent").toBeNull();
      /* THE OVERLAY-CAPABLE ID (harness-event-tails): codex and opencode
       * readers declare the sessionEvents slot, so each row advertises its
       * OWN harness id under the historical wire key; the borrowed-value
       * guard stays as never-claude's-id. */
      expect(row.claudeSessionId, "the overlay id is this row's own harness id")
        .toBe(row.harnessSessionId);
      expect(row.claudeSessionId, "never claude's id borrowed onto another agent")
        .not.toBe(claude.harnessSessionId);
    }
    /* COLLAPSE PARITY: the core keeps ONE session-id field
     * now, and the wire's claudeSessionId is DERIVED from it and the reader's
     * declared activity slot. For claude it is exactly harnessSessionId
     * (byte-identical to the retired field); codex/opencode carry their own
     * ids (above). */
    expect(claude.claudeSessionId, "claude's wire claude id is its one harness id")
      .toBe(claude.harnessSessionId);
  });

test("L1: a blocked codex row says a question is waiting but does not guess its buttons",
  async () => {
    const c = await boot({
      panes: ["w1:p1", "w1:p2"],
      agents: { "w1:p1": "claude", "w1:p2": "codex" },
    });
    await until(() => c.sessions.size === 2, { what: "both panes to reconcile" });
    // the codex pane goes to a permission prompt; herdr's own per-agent scraper
    // reports `blocked`, so the engine trusts the status but not a claude parser
    c.herdr.setStatus("w1:p2", "blocked");
    await until(() => c.byHandle("w1:p2")?.status === "blocked",
      { what: "the blocked status to reconcile" });

    const codex = (await sessionsList(c)).find((s: any) => s.id === wireId("w1:p2"))!;
    expect(codex.status, "herdr's blocked status is honoured").toBe("blocked");
    // the app is told a session is waiting (askUnknown) but no buttons are offered,
    // because reading a codex prompt as claude's would be a guess
    expect(codex.ask ?? null, "no borrowed buttons for an unparsed dialog").toBeNull();
    expect(codex.askUnknown, "the app still learns the session is waiting").toBe(true);
  });

test("L1: the retired ENGINE_AGENT filter is gone -- it is set for this whole file and lists " +
  "every agent anyway", async () => {
    /* Before #587 this env var WAS the filter; ENGINE_AGENT=codex would have
     * hidden the claude pane -- and every test above would have been running
     * against a one-pane fleet without saying so. */
    expect(process.env.ENGINE_AGENT, "the retired variable is not even set, so this proves nothing")
      .toBe("codex");
    const c = await boot({
      panes: ["w1:p1", "w1:p2"],
      agents: { "w1:p1": "claude", "w1:p2": "codex" },
    });
    await until(() => c.sessions.size === 2, { what: "both panes to reconcile" });
    const list = await sessionsList(c);
    expect(list.length, "ENGINE_AGENT no longer filters anything").toBe(2);
    expect(list.map((s: any) => s.agentId).sort()).toEqual(["claude", "codex"]);
  });
