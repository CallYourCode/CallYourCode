/* THE DISPOSABLE-SINK TRIM ROUTE (#569 item 2).
 *
 * POST /session/:id/trim-log drops the front of a TEST- session's log and keeps
 * the newest N. It is a TEST/admin path: the session's DISPLAY NAME must start
 * with TEST- and the request must echo that exact name, so nothing a person
 * talks to can be emptied by a mistyped pane id. Pane ids are short, similar and
 * reassigned, which is precisely why the confirmation exists.
 *
 * THE CONTRACT: a trim does NOT push a live frame. The engine used to broadcast
 * `{t:"log-trimmed"}`, but no app ever decoded it, so an attached
 * app showed the deleted tail until it re-attached anyway. Rather than teach the
 * app to drop rows for a disposable-sink op, the trim is picked up by the next
 * attach-ok replay. This file pins both halves: the route trims and answers with
 * the counts, a listening socket hears nothing about it, and the very next
 * attach hands over the SHORTENED log.
 *
 * AND THE LOG IS APPEND-ONLY EITHER WAY. A trim never rewrites a line: the kept
 * tail becomes a NEW chat file and the meta pointer flips, so the old file is
 * still on disk afterwards. That is asserted here because "we shortened it by
 * rewriting the file" is the shape that loses a conversation when it goes wrong.
 *
 *   bun test agent-engine/src/chat/trim-log.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";

import { wireCore, type WireCore, wireId } from "../test-utils/wire-core.ts";
import { chatStore } from "../sessions/session-state.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { dataDirOf, metaForSession, readChatLog } from "../test-utils/builders.ts";
import { PANE, defaultSessionIdOf } from "../test-utils/fake-herdr.ts";
/* The harness id the fake herdr reports for PANE: what the disk records
 * (meta.json sessionId, the chat log) are keyed by, never the pane id. */
const PANE_SID = defaultSessionIdOf(PANE);
import { until } from "../test-utils/wait.ts";
import { chatRoutes } from "../routes/chat.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";
import { dispatchClientFrame } from "../transport/frames.ts";
import { dispatchSessionFrame } from "../runtime/mcp.ts";
import type { Sock } from "../transport/sock.ts";

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

/** The session's own MCP socket: the only honest way to write agent replies. */
function mcpSock(sessionId: string): Sock {
  return {
    data: { role: "session", sessionId, terms: new Map() },
    readyState: 1,
    remoteAddr: "127.0.0.1",
    send(s: string) { return s.length; },
    close() { /* nothing holds it */ },
  } as unknown as Sock;
}

/** A live pane with `n` agent replies in its log, and the shipped routes over a
 *  real Bun.serve on port 0. requireOwner passes because the request arrives on
 *  loopback with no x-forwarded-for, which is the "on this host" branch. */
async function boot(n: number): Promise<{ c: WireCore; r: ServedRoutes }> {
  core = await wireCore({ with: ["frames"] });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  const mcp = mcpSock(PANE);
  for (let i = 0; i < n; i++) {
    await dispatchSessionFrame(mcp, { t: "chat", text: `m${i}`, msgId: crypto.randomUUID() });
  }
  expect(core.byHandle(PANE)!.chat.length).toBe(n);
  http = serveRoutes({ groups: [chatRoutes, sessionOpsRoutes], ctx: { adapter: core.adapter } });
  return { c: core, r: http };
}

const rename = (r: ServedRoutes, name: string) =>
  r.post(`/session/${encodeURIComponent(wireId(PANE))}/rename`, { name });

const trim = (r: ServedRoutes, body: unknown, id = wireId(PANE)) =>
  r.post(`/session/${encodeURIComponent(id)}/trim-log`, body);

/** Every text the next attach would hand a fresh page, oldest first. */
async function replayed(c: WireCore): Promise<string[]> {
  const page = c.client();
  await dispatchClientFrame(page.sock, { t: "attach", id: wireId(PANE) });
  await until(() => page.last("attach-ok") !== undefined, { what: "an attach-ok" });
  return ((page.last("attach-ok")!.pages as any[]) ?? [])
    .flatMap((p) => (p.messages ?? []).map((m: any) => String(m.text)));
}

test("trim-log drops the front, answers with the counts, and pushes no live frame", async () => {
  const { c, r } = await boot(4);
  expect((await rename(r, "TEST-SINK")).ok, "the sink must be renamed disposable first").toBe(true);

  /* A client that is ATTACHED and recording. Registered before the trim, so
   * "it heard nothing" is a real absence rather than a socket that was not
   * there yet. */
  const watcher = c.client();
  await dispatchClientFrame(watcher.sock, { t: "attach", id: wireId(PANE) });
  watcher.clear();

  const res = await trim(r, { name: "TEST-SINK", keep: 1 });
  const body = await res.json() as { ok: boolean; dropped: number; kept: number; name: string };
  expect(res.ok).toBe(true);
  expect(body.ok).toBe(true);
  expect(body.name, "the answer names the session it acted on").toBe("TEST-SINK");
  expect(body.dropped, "three of the four messages are dropped").toBe(3);
  expect(body.kept, "one is kept").toBe(1);
  // the NEWEST is what is kept: `keep` drops the front
  expect(c.byHandle(PANE)!.chat.map((m) => m.text)).toEqual(["m3"]);

  expect(watcher.of("log-trimmed"),
    "a log-trimmed frame was pushed. No app decodes it, so it is a frame " +
    "nobody reads and a second answer waiting to disagree with the next attach").toEqual([]);
  expect(watcher.frames,
    "the trim pushed SOMETHING to an attached client; the contract is that it pushes " +
    `nothing at all. Got: ${JSON.stringify(watcher.frames.map((f) => f.t))}`).toEqual([]);

  /* The listener IS a live broadcast recipient: a fresh reply still reaches it,
   * so the silence above is a real absence, not a dead socket. */
  await dispatchSessionFrame(mcpSock(PANE), { t: "chat", text: "after-trim", msgId: crypto.randomUUID() });
  expect(watcher.of("chat").map((f) => f.text),
    "a normal broadcast no longer lands on this socket, so the silence proved nothing")
    .toEqual(["after-trim"]);

  // and the next attach is where the app learns about the trim
  expect(await replayed(c), "the next attach did not replay the TRIMMED log")
    .toEqual(["m3", "after-trim"]);
});

test("keep: 0 empties the log, and the next attach says so rather than replaying a ghost",
  async () => {
    const { c, r } = await boot(3);
    await rename(r, "TEST-SINK");
    const body = await trim(r, { name: "TEST-SINK" }).then((x) => x.json() as Promise<any>);
    expect(body.dropped).toBe(3);
    expect(body.kept).toBe(0);
    expect(c.byHandle(PANE)!.chat).toEqual([]);

    const page = c.client();
    await dispatchClientFrame(page.sock, { t: "attach", id: wireId(PANE) });
    await until(() => page.last("attach-ok") !== undefined, { what: "an attach-ok" });
    const ok = page.last("attach-ok")!;
    expect(ok.known, "an emptied session is still a session this engine has").toBe(true);
    expect(ok.total).toBe(0);
    expect(ok.pages.length, "an empty log still has a tail page to ask for").toBe(1);
    expect(ok.pages[0].messages).toEqual([]);
  });

test("the trim writes a NEW chat file and leaves the old one as history", async () => {
  /* THE APPEND-ONLY RULE (the design). No existing line is ever rewritten, so a
   * trim cannot corrupt the log it is shortening: the kept tail is written to a
   * fresh file, the meta pointer flips to it, and the file that held the whole
   * conversation is still there. */
  const { c, r } = await boot(4);
  await rename(r, "TEST-SINK");
  // the meta save is debounced, so the record reaches disk a moment after the
  // first line is logged; everything below is about which FILE it points at
  const before = await until(async () => (await metaForSession(c.root, PANE_SID))?.chat != null,
    { what: "the agent record to reach disk" }).then(() => metaForSession(c.root, PANE_SID));
  const oldChat = before!.chat!;

  await trim(r, { name: "TEST-SINK", keep: 2 });
  const after = await until(async () => (await metaForSession(c.root, PANE_SID))?.chat !== oldChat,
    { what: "the meta pointer to flip to the new chat file" })
    .then(() => metaForSession(c.root, PANE_SID));

  expect(after!.chat, "the trim reused the old chat file").not.toBe(oldChat);
  expect(after!.chats!.map((x) => x.id),
    "the old chat file was forgotten instead of kept as history")
    .toEqual([oldChat, after!.chat!]);
  // the old file is untouched on disk, all four lines of it
  const oldPath = join(dataDirOf(c.root), "agents", after!.agentId, "chats", `${oldChat}.jsonl`);
  const oldLines = (await Bun.file(oldPath).text()).trim().split("\n");
  expect(oldLines.length, "the trim rewrote the file it was shortening").toBe(4);
  // and the live log is the kept tail, on disk as well as in memory
  await until(async () => (await readChatLog(c.root, PANE_SID)).length === 2,
    { what: "the kept tail to reach the new chat file" });
  expect((await readChatLog(c.root, PANE_SID)).map((m) => m.text)).toEqual(["m2", "m3"]);
});

test("a session that is not named TEST- is refused, and nothing is dropped", async () => {
  /* The whole point of the guard. His own conversations are unrecoverable, and
   * the only caller of this route is a test rig. */
  const { c, r } = await boot(3);
  const res = await trim(r, { name: c.byHandle(PANE)!.name, keep: 0 });
  expect(res.status).toBe(403);
  const body = await res.json() as any;
  expect(body.ok).toBe(false);
  expect(body.error, "the refusal must name the session it protected, so a rig can say why")
    .toContain("TEST-");
  expect(c.byHandle(PANE)!.chat.length, "a refused trim dropped messages anyway").toBe(3);
});

test("a name that does not echo the session's is a 409, and nothing is dropped", async () => {
  const { c, r } = await boot(3);
  await rename(r, "TEST-SINK");
  const res = await trim(r, { name: "TEST-OTHER", keep: 0 });
  expect(res.status,
    "a mistyped pane id landed on a real chat and emptied it; the echo is the guard").toBe(409);
  expect((await res.json() as any).error).toContain("TEST-SINK");
  expect(c.byHandle(PANE)!.chat.length).toBe(3);

  // ...and a request with no name at all is the same refusal, not a default
  expect((await trim(r, { keep: 0 })).status).toBe(409);
  expect(c.byHandle(PANE)!.chat.length).toBe(3);
});

test("an unmeasurable keep is a 400, and an unknown session is a 404", async () => {
  const { c, r } = await boot(2);
  await rename(r, "TEST-SINK");
  /* Everything Number() cannot turn into a count >= 0. (NaN itself is not in
   * the list because JSON has no NaN: it crosses the wire as null, which IS a
   * number the route accepts -- it means the documented default, keep nothing.) */
  for (const keep of [-1, -0.5, "lots", {}]) {
    const res = await trim(r, { name: "TEST-SINK", keep });
    expect(res.status, `keep: ${JSON.stringify(keep)} was accepted`).toBe(400);
  }
  expect(c.byHandle(PANE)!.chat.length).toBe(2);
  // a keep LARGER than the log is not an error: it drops nothing
  const big = await trim(r, { name: "TEST-SINK", keep: 99 }).then((x) => x.json() as Promise<any>);
  expect(big).toMatchObject({ ok: true, dropped: 0, kept: 2 });

  const missing = await trim(r, { name: "TEST-SINK", keep: 0 }, "w9:pNOSUCH");
  expect(missing.status).toBe(404);
});
