/* ATTACH, THE PAGE WAY (the pointer-pages brief; DECISIONS.md).
 *
 * The conversation is served in fixed pages of 100 by seq. Attaching answers ONE
 * frame the app can paint from once: the pointer (where the unread divider is
 * drawn and where autoplay begins), the tail page id, the page holding the
 * pointer, and the two pages themselves. Any page between them is fetched over
 * GET /session/<id>/page/<n>, which is contract.test.ts's E8.
 *
 * Opening NO LONGER marks the chat read; the marker advances only as the app
 * REPORTS progress (playing, viewing, scrolling). That is asserted here and in
 * unread.test.ts.
 *
 * WHAT THIS FILE IS ABOUT, in one sentence: not losing words. A page that
 * changes after it was sealed, a marker that rewinds, a pointer that skips the
 * first unread line -- each of those is silent when it regresses, and each of
 * them costs him a message he was told he had read.
 *
 * NO ENGINE PROCESS. wireCore performs server.ts's own ordered boot in-process,
 * and the frames go in through the SHIPPED dispatcher (dispatchClientFrame), so
 * "attach" here is the same function a sealed DataChannel client reaches.
 *
 *   bun test agent-engine/src/chat/attach.test.ts
 */

import { test, expect, afterAll, afterEach } from "bun:test";

import { wireCore, sessionsFrame, type WireCore, type FakeClient, wireId } from "../test-utils/wire-core.ts";
import { chatStore } from "../sessions/session-state.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { dispatchClientFrame } from "../transport/frames.ts";
import { dispatchSessionFrame } from "../runtime/mcp.ts";
import { onUtterance } from "./deliver.ts";
import { PAGE_SIZE } from "../runtime/pages.ts";
import { DELTA_PAGES_MAX, wirePage } from "./attach.ts";
import type { Sock } from "../transport/sock.ts";

/* THE PAUSE BETWEEN A BODY AND ITS ENTER, shortened for this file. 250ms is the
 * measured settle a real pane needs between send_text and the enter that
 * submits it; the fake pane needs none, and paying it per delivery is seconds
 * of wall clock for a number nothing here asserts. (delivery-guard.test.ts owns
 * the settle itself.) */
const priorSettle = process.env.DELIVER_SETTLE_MS;
process.env.DELIVER_SETTLE_MS = "5";
afterAll(() => {
  if (priorSettle === undefined) delete process.env.DELIVER_SETTLE_MS;
  else process.env.DELIVER_SETTLE_MS = priorSettle;
});

let core: WireCore | null = null;
afterEach(async () => {
  /* Every queued chat append on disk before the tmp tree goes: an append still
   * in flight when the directory is removed prints an ENOENT nobody can act on. */
  await chatStore.flush();
  await core?.stop();
  core = null;
});

/* THE SESSION'S OWN MCP SOCKET: the role a session's tool process wears, and
 * the only honest way to put an AGENT message in a log. It is deliberately NOT
 * in wire.ts's client set, so what it receives is an ack and never a broadcast:
 * "did the app hear about this" stays a question only a client can answer. */
function mcpSock(sessionId: string): { sock: Sock; said: Record<string, any>[] } {
  const said: Record<string, any>[] = [];
  const sock = {
    data: { role: "session", sessionId, terms: new Map() },
    readyState: 1,
    remoteAddr: "127.0.0.1",
    send(s: string) { try { said.push(JSON.parse(s)); } catch { /* not json */ } return s.length; },
    close() { /* nothing holds it */ },
  } as unknown as Sock;
  return { sock, said };
}

/* Seed `n` AGENT replies through the real reply path, so every one of them is
 * stamped by stampTs, numbered by ensureSeqs and appended to the log exactly as
 * a live reply is. All `role:"claude"`, so on a fresh chat they are all unread
 * and the pointer sits at the very first. */
async function seedReplies(c: WireCore, n: number, prefix = "m"): Promise<void> {
  const mcp = mcpSock(PANE);
  for (let i = 0; i < n; i++) {
    await dispatchSessionFrame(mcp.sock, { t: "chat", text: `${prefix}${i}`, msgId: crypto.randomUUID() });
  }
  const chat = c.byHandle(PANE)!.chat;
  if (chat.length < n) throw new Error(`seeded ${chat.length} of ${n} replies`);
}

/** Boot one wiring with a live pane, ready to take frames. */
async function boot(): Promise<WireCore> {
  core = await wireCore({ with: ["frames"] });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  return core;
}

/** Attach a client and hand back the answer. */
async function attach(
  c: WireCore,
  id: string,
  client?: FakeClient,
  extra: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const page = client ?? c.client();
  // the frame is keyed by the wire id; a handle is translated, an unknown id rides as is
  await dispatchClientFrame(page.sock, { t: "attach", id: wireId(id), ...extra });
  await until(() => page.last("attach-ok") !== undefined, { what: `an attach-ok for ${id}` });
  return page.last("attach-ok")!;
}

/** The sessions-list row for PANE, as a client is handed it: the engine-owned
 *  unread lives there and nowhere else. */
const row = (): any =>
  ((sessionsFrame().list as any[]).find((s) => s.id === wireId(PANE)));

test("a short chat attaches with one page: the pointer sits at the first unread", async () => {
  const c = await boot();
  await seedReplies(c, 12);

  const ok = await attach(c, PANE);
  expect(ok.known).toBe(true);
  expect(ok.pageSize).toBe(PAGE_SIZE);
  expect(ok.total).toBe(12);
  expect(ok.tailPage).toBe(0);
  // fresh chat, nothing read: the pointer is the first message's seq
  expect(ok.pointer).toBe(0);
  expect(ok.pointerPage).toBe(0);
  // ONE page, because the pointer page and the tail page are the same. Two
  // copies of one page would be the app painting the same twelve lines twice.
  expect(ok.pages.length).toBe(1);
  const p = ok.pages[0];
  expect(p.page).toBe(0);
  expect(p.sealed, "the tail page must never be sealed: it is the one that grows").toBe(false);
  expect(p.version, "version is the seq just past the page's last message").toBe(12);
  expect(p.messages.length).toBe(12);
  expect(p.messages[0].text).toBe("m0"); // oldest-first INSIDE a page
  expect(p.messages[11].text).toBe("m11");
  expect(p.messages[0].seq).toBe(0);
  expect(p.messages.every((x: any) => x.id === wireId(PANE)),
    "every message is routed to this session, whatever id its own record carries").toBe(true);
});

test("an over-100 chat attaches with the pointer page AND the tail page, and seals the rest", async () => {
  const c = await boot();
  await seedReplies(c, 150); // pages 0 (full) and 1 (tail, 50)

  const ok = await attach(c, PANE);
  expect(ok.total).toBe(150);
  expect(ok.tailPage).toBe(1);
  // nothing read, so the pointer is on page 0 and the tail is page 1: both go out
  expect(ok.pointer).toBe(0);
  expect(ok.pointerPage).toBe(0);
  expect(ok.pages.length).toBe(2);

  const p0 = ok.pages.find((p: any) => p.page === 0)!;
  const p1 = ok.pages.find((p: any) => p.page === 1)!;
  expect(p0.sealed, "a page below the tail is full and final FOREVER").toBe(true);
  expect(p0.version).toBe(100);
  expect(p0.messages.length).toBe(100);
  expect(p0.messages[0].text).toBe("m0");
  expect(p1.sealed).toBe(false);
  expect(p1.messages.length).toBe(50);
  expect(p1.messages[0].text).toBe("m100");
  expect(p1.messages[49].text).toBe("m149");
});

test("a sealed page is immutable: the tail grows, page 0 does not move a byte", async () => {
  /* THE PROMISE THE APP'S DISK CACHE IS BUILT ON (S1): a stored page with
   * sealed:true is served unconditionally and never version-checked again. If
   * a later message could change page 0's bytes -- its version, its seal, or
   * which messages it holds -- every cached page in the app would be a lie it
   * has no way to notice. Asserted by taking the page twice with a hundred
   * messages written in between. */
  const c = await boot();
  await seedReplies(c, 101); // page 0 sealed the instant seq 100 landed
  const s = c.byHandle(PANE)!;
  const before = JSON.stringify(wirePage(s, 0));
  expect(JSON.parse(before).sealed).toBe(true);

  await seedReplies(c, 100, "later"); // 201 messages: the tail is page 2 now
  expect(JSON.stringify(wirePage(s, 0)),
    "page 0 changed after it was sealed; every app that cached it is now wrong " +
    "and cannot know").toBe(before);
  // ...and the page that was the tail is sealed now, at its own frozen version
  const p1 = wirePage(s, 1);
  expect(p1.sealed).toBe(true);
  expect(p1.version).toBe(200);
  expect(wirePage(s, 2).sealed, "the new tail must be the only unsealed page").toBe(false);
});

test("attaching to a session this engine does not have is answered and MARKED", async () => {
  /* An answer rather than silence, and it says "not here" rather than "empty":
   * a page that reached a chat on the wrong engine keeps whatever it holds and
   * stops waiting, instead of painting over a real conversation with nothing. */
  const c = await boot();
  const ok = await attach(c, "w9:pNOSUCH");
  expect(ok.id, "the answer must come back for the id that was asked, the key the page waits on")
    .toBe("w9:pNOSUCH");
  expect(ok.known).toBe(false);
  expect(ok.pages, "the engine sent pages for a session it does not have").toBeUndefined();
  expect(ok.total, "an unknown session must claim no length").toBeUndefined();
  expect(ok.pointer).toBeUndefined();
});

test("attaching with no id at all detaches, and is answered with silence on purpose", async () => {
  /* The one attach that gets NO frame back: `{t:"attach"}` with an empty id is
   * a client saying it left every chat. There is no session to answer about,
   * and an attach-ok for "" would be an answer about a conversation that does
   * not exist. What it must do is drop this socket's attachment, or notify
   * would go on believing the page is watching whatever it had open. */
  const c = await boot();
  const page = c.client({ attach: wireId(PANE) });
  await dispatchClientFrame(page.sock, { t: "attach", id: "" });
  expect(page.sock.data.attached, "an empty attach must detach the socket").toBeNull();
  expect(page.of("attach-ok"), "there is no session to answer about").toEqual([]);
});

test("attach-ok carries the authoritative queued list: set rows ride, cleared ones do not", async () => {
  /* A dequeue is a patch: no seq changes, so the have/tailVersion check
   * cannot see it, and a client that missed the live `dequeued` frame kept
   * "Queued for Claude" on a delivered message forever (2026-09-06). The
   * attach answer therefore always says which user rows are queued NOW. */
  const c = await boot();
  await seedReplies(c, 3);
  const s = c.byHandle(PANE)!;
  s.chat.push(
    { id: s.id, role: "user", text: "went in", ts: 5000, queued: true } as never,
    { id: s.id, role: "user", text: "still waiting", ts: 6000, queued: true } as never,
  );
  const ok1 = await attach(c, PANE);
  expect(ok1.queued).toEqual([5000, 6000]);

  // the delivery cleared one flag: the next attach says so
  delete (s.chat.find((m: any) => m.ts === 5000) as any).queued;
  const ok2 = await attach(c, PANE, c.client());
  expect(ok2.queued).toEqual([6000]);

  // nothing queued is an EMPTY list, not an absent field: absence means an
  // old engine and lets the app fall back to its heuristic
  delete (s.chat.find((m: any) => m.ts === 6000) as any).queued;
  const ok3 = await attach(c, PANE, c.client());
  expect(ok3.queued).toEqual([]);
});

test("opening does NOT mark read; a progress report through the end does", async () => {
  const c = await boot();
  await seedReplies(c, 5);
  expect(row().unread).toBe(5);

  // attach (open) and leave: the marker must not move
  const page = c.client();
  const ok = await attach(c, PANE, page);
  expect(row().unread, "opening the chat moved the marker; opening is not reading").toBe(5);

  // report progress through the last seq: what a device that reached the bottom does
  await dispatchClientFrame(page.sock, { t: "progress", id: wireId(PANE), seq: ok.total - 1 });
  expect(row().unread).toBe(0);
});

test("progress is forward-only; an explicit backward write is the one exception", async () => {
  const c = await boot();
  await seedReplies(c, 5);
  const page = c.client();

  await dispatchClientFrame(page.sock, { t: "progress", id: wireId(PANE), seq: 4 }); // done through the end
  expect(row().unread).toBe(0);

  /* An ordinary (stale) report for an earlier seq must not rewind. Two devices
   * catching up at once is the ordinary case, and a rewind there re-reads him
   * messages he has already seen -- and re-speaks them. */
  await dispatchClientFrame(page.sock, { t: "progress", id: wireId(PANE), seq: 1 });
  expect(row().unread, "an ordinary progress report rewound the marker").toBe(0);

  // explicit:true IS mark-unread: it parks the marker back and the count returns
  await dispatchClientFrame(page.sock, { t: "progress", id: wireId(PANE), seq: 1, explicit: true });
  expect(row().unread, "an explicit backward progress did not un-read anything").toBeGreaterThan(0);
});

test("a progress report the log cannot address moves nothing", async () => {
  /* Two shapes that used to be indistinguishable from "read it all": a seq
   * before the first message (nothing at or below it, so no ts to sit on) and a
   * seq that is not a number at all. Either one silently marking the chat read
   * is the losing direction -- the messages are still there and he is never
   * told about them again. */
  const c = await boot();
  await seedReplies(c, 3);
  const page = c.client();

  await dispatchClientFrame(page.sock, { t: "progress", id: wireId(PANE), seq: -1 });
  expect(row().unread, "a seq below the log marked the chat read").toBe(3);
  await dispatchClientFrame(page.sock, { t: "progress", id: wireId(PANE), seq: "banana" });
  expect(row().unread, "an unparseable seq marked the chat read").toBe(3);
  await dispatchClientFrame(page.sock, { t: "progress", id: "w9:pNOSUCH", seq: 2 });
  expect(row().unread, "a progress report for another session moved this one's marker").toBe(3);
});

test("unread is exactly the agent messages past the reported pointer", async () => {
  const c = await boot();
  await seedReplies(c, 6); // 6 agent messages, seq 0..5, all unread
  expect(row().unread).toBe(6);

  const page = c.client();
  await dispatchClientFrame(page.sock, { t: "progress", id: wireId(PANE), seq: 2 }); // done through seq 2
  // seq 3, 4, 5 remain past the marker
  expect(row().unread).toBe(3);

  /* AND THE POINTER FOLLOWS IT: the next attach draws the divider above seq 3,
   * not back at the top. The count and the divider are the same fact shown
   * twice, and a pointer that disagreed with the count is the read-marker bug
   * this guards against. */
  const ok = await attach(c, PANE);
  expect(ok.pointer, "the divider did not follow the marker").toBe(3);
  expect(ok.pointerPage).toBe(0);
});

test("with nothing unread the pointer sits past the newest seq and the pages collapse to the tail",
  async () => {
    /* The common case, and the one an off-by-one hides in. Read to the end of a
     * two-page log: the pointer must be one PAST the newest seq (so no divider
     * draws), its page clamps to the tail, and the attach answer carries the
     * tail alone rather than shipping page 0 for a divider nobody will draw. */
    const c = await boot();
    await seedReplies(c, 150);
    const page = c.client();
    await dispatchClientFrame(page.sock, { t: "progress", id: wireId(PANE), seq: 149 });
    expect(row().unread).toBe(0);

    const ok = await attach(c, PANE);
    expect(ok.pointer, "the pointer must sit one past the newest seq when nothing is unread")
      .toBe(150);
    expect(ok.pointerPage, "the pointer page must clamp into the real range").toBe(1);
    expect(ok.pages.map((p: any) => p.page)).toEqual([1]);
  });

test("a user message reads everything above it, and the next reply is unread again", async () => {
  /* #452: his own message reads the conversation above it (the marker moves
   * with the utterance), and the reply that comes back after it is news. The
   * two together are what makes the unread count mean "things I have not seen"
   * rather than "things since I last tapped". */
  core = await wireCore({ with: ["delivery", "frames"] });
  const c = core;
  await until(() => c.sessions.size === 1, { what: "the pane to reconcile" });
  await seedReplies(c, 3);
  expect(row().unread).toBe(3);

  const page = c.client();
  await onUtterance(page.sock, { id: wireId(PANE), text: "I read all that" });
  expect(row().unread, "his own message did not read the conversation above it (#452)").toBe(0);

  await seedReplies(c, 1, "after");
  expect(row().unread, "the reply that followed his message is not news").toBe(1);
  const ok = await attach(c, PANE);
  expect(ok.pages[0].messages.at(-1).text).toBe("after0");
  expect(ok.pointer, "the divider must sit on the reply, not on his own message").toBe(4);
});

/* Plant a sparse (or gapped) seq axis directly. ensureSeqs leaves a fully
 * numbered increasing run alone, so these seqs survive onto the wire. */
function plantSeqs(c: WireCore, seqs: number[]): void {
  const s = c.byHandle(PANE)!;
  s.chat.length = 0;
  s.log.length = 0;
  s.heardTs = 1e15; // pointer clamps to the tail; old two-page attach is tail-only
  for (const seq of seqs) {
    s.chat.push({ id: s.id, role: "claude", text: `m${seq}`, ts: 1000 + seq, seq } as never);
  }
  /* A non-empty log makes ensureSeqs keep a gapped message axis (strictly
   * increasing is enough). An empty log would renumber by position and the
   * sparse overnight case would disappear. */
  s.log.push({ seq: seqs[0] ?? 0, ts: 1, id: "se-plant", kind: "status", text: "plant" } as never);
}

function seqsOn(ok: Record<string, any>): number[] {
  const out: number[] = [];
  for (const p of ok.pages ?? []) {
    for (const m of p.messages ?? []) if (typeof m.seq === "number") out.push(m.seq);
  }
  return out.sort((a, b) => a - b);
}

/* THE 09-15 HAVE LIE. A FAITHFUL port of the SHIPPED master logic
 * (app/src/engine/store.ts pageFullyHeld + haveOf as of master a356def),
 * both branches, so fail-before is proven against the real code, not a
 * simplification. engineTotal is a ROW COUNT; on a sparse axis a high page
 * whose base exceeds that count has expected <= 0 and is vacuously
 * "fully held", so haveOf claims a tail page the device holds one row of. */
function oldPageFullyHeld(opts: {
  engineTotal: number | undefined;
  heldSeqs: number[];
  pageSize: number;
  n: number;
}): boolean {
  const { engineTotal, heldSeqs, pageSize, n } = opts;
  const lo = n * pageSize;
  const hi = lo + pageSize;
  const expected = engineTotal !== undefined ? Math.min(hi, engineTotal) - lo : pageSize;
  if (expected <= 0) return true;
  let count = 0;
  for (const seq of heldSeqs) if (seq >= lo && seq < hi) count++;
  return count >= expected;
}

function oldHaveOf(opts: {
  engineTotal: number | undefined;
  heldSeqs: number[];
  pageSize: number;
}): { tailPage: number; tailVersion: number } | undefined {
  const { engineTotal, heldSeqs, pageSize } = opts;
  const highestHeldSeq = heldSeqs.length ? Math.max(...heldSeqs) : -1;
  if (highestHeldSeq < 0) return undefined;
  const page = Math.floor(highestHeldSeq / pageSize);
  if (!oldPageFullyHeld({ engineTotal, heldSeqs, pageSize, n: page })) return undefined;
  return { tailPage: page, tailVersion: highestHeldSeq + 1 };
}

test("frontier: overnight sparse wake delivers (F, T]; the have lie would skip", async () => {
  /* Scaled 09-15 overnight: row count ~half of max seq, device previously
   * caught up at F, tail advanced to T on another device, waking device holds
   * ONE row of the new tail page. On master, haveOf + pageFullyHeld claimed
   * the whole tail (expected went negative) and attach sent pages: []. */
  const c = await boot();
  const seqs: number[] = [];
  for (let i = 0; i <= 250; i += 2) seqs.push(i); // 126 rows, T = 250
  plantSeqs(c, seqs);
  const F = 154;
  const T = 250;
  const engineTotal = seqs.length;
  expect(engineTotal).toBeLessThan(T); // sparse: count is not a seq bound

  /* The waking device holds ONE row of the new tail page (seq T on page 2).
   * The faithful master port runs its real count branch when expected > 0 and
   * hits the vacuity (expected <= 0) here because engineTotal is a row count. */
  const lie = oldHaveOf({ engineTotal, heldSeqs: [T], pageSize: PAGE_SIZE });
  expect(lie, "the old pageFullyHeld vacuity is the fail-before: one held row on page 2 plus count-as-seq-bound must claim the whole tail").toEqual({
    tailPage: 2, tailVersion: T + 1,
  });

  const skipped = await attach(c, PANE, c.client(), { have: lie });
  expect(skipped.pages).toEqual([]);
  expect(skipped.deltaBase, "legacy have must not grow a frontier field").toBeUndefined();
  expect(c.logs.some((l) => l.event === "attach.legacy-have"),
    "legacy have is logged as deprecated").toBe(true);

  const ok = await attach(c, PANE, c.client(), { frontier: F });
  const got = seqsOn(ok);
  const want = seqs.filter((q) => q > F && q <= T);
  expect(got.filter((q) => q > F && q <= T),
    "frontier attach must deliver every seq in (F, T]").toEqual(want);
  expect(ok.deltaBase).toBe(F + 1);
  expect(ok.pages.length).toBeGreaterThan(1); // old tail-only attach would miss page 1
});

test("legacy have that matches still skips (un-reloaded phone)", async () => {
  const c = await boot();
  await seedReplies(c, 12);
  const first = await attach(c, PANE);
  const tail = first.tailPage as number;
  const tailVersion = first.pages.find((p: any) => p.page === tail).version as number;
  const ok = await attach(c, PANE, c.client(), { have: { tailPage: tail, tailVersion } });
  expect(ok.pages).toEqual([]);
  expect(ok.deltaBase).toBeUndefined();
  expect(c.logs.some((l) => l.event === "attach.legacy-have")).toBe(true);
});

test("frontier far behind T delivers exactly the newest 20 pages and deltaBase is the cap", async () => {
  const c = await boot();
  const seqs: number[] = [];
  for (let p = 0; p < 25; p++) seqs.push(p * PAGE_SIZE);
  seqs.push(2499);
  plantSeqs(c, seqs);
  const T = 2499;
  const F = 0;
  const lo = T + 1 - DELTA_PAGES_MAX * PAGE_SIZE; // 500
  const ok = await attach(c, PANE, c.client(), { frontier: F });
  expect(ok.pages.length).toBe(DELTA_PAGES_MAX);
  const pages = ok.pages.map((p: any) => p.page).sort((a: number, b: number) => a - b);
  expect(pages).toEqual(Array.from({ length: DELTA_PAGES_MAX }, (_, i) => 5 + i));
  expect(ok.deltaBase).toBe(lo);
  expect(seqsOn(ok).at(-1)).toBe(T);
});

test("frontier at or past T is genuinely caught up: pages empty", async () => {
  const c = await boot();
  await seedReplies(c, 12);
  const ok = await attach(c, PANE, c.client(), { frontier: 11 });
  expect(ok.pages).toEqual([]);
  expect(ok.deltaBase).toBe(12);
});

test("a frontier past the newest seq is a STALE AXIS: serve the cold tail, log the mismatch", async () => {
  /* The owner's phone cached rows from an older, longer engine axis (seqs up to
   * 133361) and states that as its frontier; this engine's axis is far shorter
   * (tailVersion 12). On master that frontier took the F >= T branch and skipped
   * every page (pagesSkipped, empty pages), so the device never received the
   * real tail and wedged on stale mid-history. It must instead be treated as a
   * cold attach: the newest pages ride, a deltaBase rides, and the mismatch is
   * logged so the axis-skew is visible. */
  const c = await boot();
  await seedReplies(c, 12); // T = 11, tailVersion = 12
  const ok = await attach(c, PANE, c.client(), { frontier: 133361 });
  expect(ok.pages.length, "a stale-axis frontier must NOT skip: the cold tail rides").toBe(1);
  expect(ok.pages[0].page).toBe(0);
  expect(ok.pages[0].messages.length).toBe(12);
  expect(ok.deltaBase, "a cold attach carries a deltaBase, not the F >= T skip").toBe(0);
  expect(c.logs.some((l) => l.event === "attach.axis-mismatch"),
    "the axis mismatch must be logged").toBe(true);
  const mm = c.logs.find((l) => l.event === "attach.axis-mismatch")!;
  expect(mm.fields.frontier).toBe(133361);
  expect(mm.fields.tailVersion).toBe(12);
});
