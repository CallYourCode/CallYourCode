/* FEED INPUT TO A SESSION (#513, narrowed to input-only by #515).
 *
 * ONE engine route gives a script a plain way to reach a session, always naming
 * its author:
 *
 *   POST /session/<id>/agent-message {author, text}
 *     lands "<author>: <text>" in the agent's pane so the agent READS it, and
 *     that is all: no chat row, no forced reply. It goes through the SAME
 *     deliverToAgent a fired schedule uses -- a message fed INTO the session, not
 *     one FROM a person, so nothing litters the chat and silence is allowed.
 *
 * There is NO chat-message route any more (#515): no route may write a chat row
 * on a script's behalf, because that is impersonation. The only words that reach
 * his chat are the agent's own, through its MCP.
 *
 * This proves agent-message reaches the pane and writes nothing to the chat,
 * that its author validation still holds, that a pane which cannot take it says
 * so with the retry advice a caller needs, and that the removed chat-message
 * route 404s. It judges by what is IN THE PANE and what is on disk, never by
 * status codes alone.
 *
 * The route runs on a port-0 Bun.serve over the real route group; the delivery
 * behind it is wireCore's real MuxAdapter over a FakeHerdr. No engine.
 *
 *   bun test agent-engine/src/chat/sendmsg.test.ts
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";

import { sessionOpsRoutes } from "../routes/session-ops.ts";
import { stateFile } from "../storage/datadir.ts";
import { wireCore, type WireCore, wireId } from "../test-utils/wire-core.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";

/* A permission prompt, trimmed from a live capture (the full ones are in
 * blocked.test.ts). A pane sitting on one of these swallows anything typed at it
 * and answers the prompt with the enter behind it, so the guard types nothing. */
const PERMISSION_SCREEN = [
  "⏺ Write(note.txt)",
  "",
  "────────────────────────────────────────────────────────────────────────────────",
  " Create file",
  " note.txt",
  " Do you want to create note.txt?",
  " ❯ 1. Yes",
  "   2. Yes, allow all edits during this session (shift+tab)",
  "   3. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");

const priorSettle = process.env.DELIVER_SETTLE_MS;
beforeAll(() => { process.env.DELIVER_SETTLE_MS = "5"; });
afterAll(() => {
  if (priorSettle === undefined) delete process.env.DELIVER_SETTLE_MS;
  else process.env.DELIVER_SETTLE_MS = priorSettle;
});

let core: WireCore | null = null;
let http: ServedRoutes | null = null;
afterEach(async () => {
  http?.stop();
  http = null;
  await core?.stop();
  core = null;
});

/** How long a text this route accepts. server.ts passes SEND_MSG_MAX; a small
 *  number here makes the route's own cap testable without a 64KB body. */
const SEND_MSG_MAX = 120;

async function rig(o: Parameters<typeof wireCore>[0] = {}): Promise<{ c: WireCore; h: ServedRoutes }> {
  core = await wireCore({ with: ["delivery"], ...o });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  http = serveRoutes({
    groups: [sessionOpsRoutes],
    ctx: { adapter: core.adapter, sendMsgMax: SEND_MSG_MAX },
  });
  return { c: core, h: http };
}

/** Post to the session on a pane; the route is keyed by the wire id. An id
 *  nobody hosts rides as is, so the 404 branch is still reachable. */
const send = (h: ServedRoutes, handle: string, body: unknown) =>
  h.post(`/session/${encodeURIComponent(wireId(handle))}/agent-message`, body);

/** The deliveries the Stop hook has on record for a pane, off disk.
 *  deliverToAgent records none, so an input message leaves this empty. */
async function hookDeliveries(pane: string): Promise<unknown[]> {
  const f = Bun.file(stateFile("reply-state.json"));
  if (!(await f.exists())) return [];
  const st = await f.json().catch(() => null) as any;
  return (st?.sessions?.[pane]?.deliveries ?? []) as unknown[];
}

// ---------------------------------------------------------------- agent-message

test("agent-message feeds '<author>: <text>' into the pane, writing no chat row and forcing no reply", async () => {
  const { c, h } = await rig();
  const cl = c.client();

  const res = await send(h, PANE, { author: "DemoAgent", text: "the build is green" });
  const body = await res.json() as any;
  expect(res.status, "a deliverable message should answer 200").toBe(200);
  expect(body.ok).toBe(true);
  expect(typeof body.ts, "a delivered message carries the ts it was stamped with").toBe("number");

  /* IT REACHED THE AGENT, as "<author>: <text>" with nothing appended after it.
   * `submitted` is what the pane actually received: the engine having tried is a
   * different question, and only this one answers the second. */
  expect(c.submitted.map((s) => s.text),
    `the pane never received the message: ${JSON.stringify(c.submitted)}`)
    .toEqual(["DemoAgent: the build is green"]);
  expect(c.submitted[0].text, "an input message must carry no reply instruction")
    .not.toMatch(/\(Reply/);

  // NO chat row: an input message litters nothing in the conversation, on the
  // wire or in the session's own log.
  expect(cl.of("chat"), "an input message broadcast a chat frame").toEqual([]);
  expect(c.byHandle(PANE)!.chat, "an input message wrote a chat row").toEqual([]);

  // NO reply obligation: nothing recorded for the Stop hook to enforce, so the
  // turn is free to stop silently.
  expect(await hookDeliveries(PANE), "an input message armed the Stop hook").toEqual([]);
});

test("agent-message refuses empty author/text with a 400, and an unknown session with a 404", async () => {
  const { c, h } = await rig();

  for (const bad of [
    { author: "", text: "hi" },
    { author: "x", text: "" },
    { author: "   ", text: "hi" },
    { text: "hi" },
    { author: "x" },
  ]) {
    const r = await send(h, PANE, bad);
    expect(r.status, `should reject ${JSON.stringify(bad)}`).toBe(400);
    expect((await r.json()).ok).toBe(false);
  }

  const gone = await send(h, "w9:p9", { author: "x", text: "hi" });
  expect(gone.status).toBe(404);
  expect((await gone.json()).error).toBe("no such session");

  // and not one of those refusals touched the pane
  expect(c.herdr.texts, "a refused message was typed at the pane anyway").toEqual([]);
  expect(c.submitted).toEqual([]);
});

test("agent-message rejects an author that forges a second speaker (control chars)", async () => {
  const { c, h } = await rig();

  /* A newline (or a carriage return) in the author renders "<author>: <text>" as
   * TWO lines, the second forging a different speaker into the agent's input.
   * TEXT is deliberately not guarded the same way -- a multi-line body under one
   * honest author prefix is a legitimate message -- and the prefix stays honest
   * precisely because the author cannot break out of it. */
  for (const author of ["Example\nDemoAgent", "Example\rDemoAgent", "a\tb"]) {
    const r = await send(h, PANE, { author, text: "the build is green" });
    expect(r.status, `should reject author ${JSON.stringify(author)}`).toBe(400);
    expect((await r.json()).ok).toBe(false);
  }
  expect(c.submitted.some((s) => s.text.includes("DemoAgent")),
    `a forged author leaked into the pane: ${JSON.stringify(c.submitted)}`).toBe(false);

  // a plain space in the author is NOT a control char and stays allowed
  const ok = await send(h, PANE, { author: "usage alert", text: "hi" });
  expect(ok.status, "a space in the author is a legitimate name, not a forge").toBe(200);
  expect(c.submitted.map((s) => s.text)).toEqual(["usage alert: hi"]);
});

test("a text past this engine's cap is refused, and nothing is typed", async () => {
  /* The route's own size check, separate from the transport caps
   * (body-limits.test.ts owns those): the number is ctx.sendMsgMax, so an engine
   * configured smaller refuses smaller. */
  const { c, h } = await rig();
  const r = await send(h, PANE, { author: "bot", text: "x".repeat(SEND_MSG_MAX + 1) });
  expect(r.status).toBe(400);
  expect(String((await r.json()).error)).toContain(String(SEND_MSG_MAX));
  expect(c.herdr.texts).toEqual([]);

  // and the exact cap is accepted, so the boundary is the boundary
  const ok = await send(h, PANE, { author: "bot", text: "y".repeat(SEND_MSG_MAX) });
  expect(ok.status).toBe(200);
});

test("a pane that cannot take it right now is a 503 that says whether to try again", async () => {
  /* The same distinction deliverToAgent draws for a schedule: a pane sitting on
   * a permission prompt was NOT typed at, so the caller may offer the message
   * again once he has answered it. A 503 with no `retriable` on it is a caller
   * guessing. */
  const { c, h } = await rig({ screens: { [PANE]: PERMISSION_SCREEN } });

  const r = await send(h, PANE, { author: "cron", text: "run the nightly" });
  expect(r.status).toBe(503);
  const body = await r.json() as any;
  expect(body.ok).toBe(false);
  expect(body.retriable, "a message nothing was typed for was not offered a retry").toBe(true);
  expect(String(body.error)).toMatch(/choose|prompt/i);

  expect(c.herdr.texts, "the message was typed at a chooser, where typing is swallowed").toEqual([]);
  expect(c.herdr.keys.filter((k) => k.keys.includes("enter")),
    "an enter was pressed at a permission prompt, which answers it").toEqual([]);
});

// ----------------------------------------------------------------- chat-message

test("the chat-message route is gone: no script may write a chat row on a session's behalf", async () => {
  /* #515 removed impersonation: the only words that reach his chat are the
   * agent's own, through its MCP. A POST to the old route now matches nothing
   * and 404s, and it wrote nothing. */
  const { c, h } = await rig();
  const cl = c.client();

  const r = await h.post(`/session/${encodeURIComponent(wireId(PANE))}/chat-message`, {
    author: "usage-alert", text: "you are at 80% of today's budget",
  });
  expect(r.status, "the chat-message route must be gone").toBe(404);

  expect(c.byHandle(PANE)!.chat.map((m) => m.text),
    "the removed route still wrote a chat row").not.toContain("you are at 80% of today's budget");
  expect(cl.of("chat"), "the removed route still broadcast a chat frame").toEqual([]);
  expect(c.herdr.texts, "the removed route still typed at the pane").toEqual([]);
});
