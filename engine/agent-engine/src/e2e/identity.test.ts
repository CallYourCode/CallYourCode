/* AGENT IDENTITY, END TO END (adapters lane 2).
 *
 * The wire names an AGENT: `id` on a sessions row is the agent id, minted
 * once and stable for the life of the conversation, and the harness session
 * id (claude's uuid, codex's rollout id, ...) is an attribute of that row that
 * changes in place. These five scenarios drive a real booted engine over the
 * sealed channel and the fake herdr and ask, for every way a session's id or
 * pane can move underneath a conversation, whether the agent id and its chat
 * stayed put:
 *
 *   1. the engine is SIGKILLed and booted again on the same data dir:
 *      same agent id, same chat, seq continues where it left off;
 *   2. a /clear-style roll on the same live pane: same agent id, the old
 *      session id in pastSessions, and one system row saying so;
 *   3. the pane closes and the conversation comes back in a NEW pane under the
 *      old id (--resume): same agent id, history attached;
 *   4. the pane HANDLE changes under a live session (a tmux server restart
 *      renumbering, an epoch bump) with the same id: same agent id, and no
 *      carry code ran;
 *   5. a v1 data dir (pane ids leaked into session fields, the reserved keys
 *      field) boots migrated, with no nameless agent minted for anything.
 *
 * Runtime is one engine boot per scenario (plus one reboot) and nothing
 * sleeps for its own sake. bun run test:e2e.
 */

import { test, expect, afterEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startEngine, openSealedClient, hasE2ETransport, PANE,
  readAgentMetas, readChatLog, dataDirOf, type Engine } from "./harness.ts";
import { mintAgentId } from "../runtime/agentmeta.ts";

let engine: Engine | null = null;
afterEach(async () => { await engine?.stop(); engine = null; });

const U1 = "5efab001-1111-4aaa-8bbb-000000000001";
const U2 = "5efab002-2222-4ccc-8ddd-000000000002";
const NEW_PANE = "w7:p7";

async function until<T>(f: () => T | undefined | false | null, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`never happened within ${ms}ms: ${what}`);
    await Bun.sleep(50);
  }
}

async function untilAsync<T>(f: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`never happened within ${ms}ms: ${what}`);
    await Bun.sleep(50);
  }
}

/** the latest sessions frame's rows on a sealed socket's frame log */
const rowsOf = (frames: Record<string, any>[]): any[] =>
  [...frames].reverse().find((f) => f.t === "sessions")?.list ?? [];

/** attach to an agent over a fresh sealed socket and return what came back:
 *  the attach-ok's messages (history) plus the socket for live frames */
async function attach(e: Engine, agentId: string) {
  const { ws, frames } = await openSealedClient(e);
  ws.send(JSON.stringify({ t: "attach", id: agentId, since: 0 }));
  const ok = await until(() => frames.find((f) => f.t === "attach-ok"), 5_000, `attach-ok for ${agentId}`);
  const history: any[] = ((ok.pages as any[]) ?? []).flatMap((p) => p.messages ?? []);
  return { ws, frames, ok, history };
}

/** the agent replies through its session socket; resolves with the chat frame */
async function reply(e: Engine, session: WebSocket, frames: Record<string, any>[], text: string) {
  session.send(JSON.stringify({ t: "chat", text, msgId: crypto.randomUUID() }));
  return until(() => frames.find((f) => f.t === "chat" && f.text === text), 5_000, `the reply "${text}" as a chat frame`);
}

test.skipIf(!hasE2ETransport)("1. SIGKILL and reboot on the same data dir: same agent id, same chat, seq continues", async () => {
  engine = await startEngine({ sessionIds: { [PANE]: U1 } });
  const e = engine;
  const session = await e.session();
  const agentId = await e.wireIdOf(PANE);
  expect(agentId).toMatch(/^ag-[A-Za-z0-9_-]{16}$/);

  const a = await attach(e, agentId);
  const first = await reply(e, session, a.frames, "before the crash");
  expect(first.id, "a chat frame names the agent").toBe(agentId);
  const lastSeq = Number(first.seq);
  expect(Number.isInteger(lastSeq)).toBe(true);
  // the record is on disk before the crash: the adopt flushed it, and the chat
  // pointer follows on the meta save debounce (150 ms), which the crash waits out
  const metaBefore = await untilAsync(async () => {
    const m = (await readAgentMetas(e.dir)).get(agentId);
    return m?.chat ? m : undefined;
  }, 5_000, "the agent's meta naming its chat");
  expect([...(await readAgentMetas(e.dir)).keys()], "one agent record for the one pane").toEqual([agentId]);
  expect(metaBefore.sessionId).toBe(U1);
  a.ws.close();

  await e.reboot("SIGKILL");

  const { ws, frames } = await openSealedClient(e);
  const row = rowsOf(frames).find((s) => s.harnessSessionId === U1);
  expect(row, "the rebooted engine lists the agent under its session id").toBeTruthy();
  expect(row.id, "the same agent id after the reboot").toBe(agentId);
  expect(row.alive, "the pane is still there, so the row is alive").toBe(true);
  ws.close();

  const b = await attach(e, agentId);
  expect(b.history.map((m) => m.text), "the chat came back with the agent").toContain("before the crash");
  const session2 = await e.session();
  const next = await reply(e, session2, b.frames, "after the reboot");
  expect(next.id).toBe(agentId);
  expect(Number(next.seq), "seq continues from the chat file, not from zero").toBe(lastSeq + 1);
  b.ws.close();
  expect((await readAgentMetas(e.dir)).size, "the reboot minted nothing new").toBe(1);
}, 60_000);

test.skipIf(!hasE2ETransport)("2. a /clear-style roll on the same pane: same agent id, old id in pastSessions, no chat pill", async () => {
  engine = await startEngine({ sessionIds: { [PANE]: U1 } });
  const e = engine;
  const session = await e.session();
  const agentId = await e.wireIdOf(PANE);
  const a = await attach(e, agentId);
  await reply(e, session, a.frames, "said under the first id");

  await e.rollSession(U2); // the same live pane now reports U2
  // The roll is adopted (meta rolls to U2), but a plain rollover is
  // same-conversation churn and paints NO chat pill (owner call 2026-09-08).
  await until(async () => (await readAgentMetas(e.dir)).get(agentId)?.sessionId === U2, 5_000,
    "the roll to be adopted on disk");
  expect(a.frames.some((f) => f.t === "chat" && f.kind === "system"),
    "a plain rollover paints no system pill").toBe(false);

  expect(await e.wireIdOf(PANE), "the pane's agent id did not change").toBe(agentId);
  const meta = (await readAgentMetas(e.dir)).get(agentId)!;
  expect(meta.sessionId).toBe(U2);
  expect(meta.pastSessions).toEqual([U1]);
  expect((await readAgentMetas(e.dir)).size, "a roll is not a second agent").toBe(1);

  // both ids reach the same conversation, and the history is one log
  const log = await readChatLog(e.dir, U2);
  expect(log.map((m) => m.text)).toEqual(["said under the first id"]);
  expect((await readChatLog(e.dir, U1)).length, "the old id reads the same log").toBe(log.length);
  a.ws.close();
}, 60_000);

test.skipIf(!hasE2ETransport)("3. the pane closes and the session returns in a NEW pane under the old id (--resume): same agent id, history attached", async () => {
  engine = await startEngine({ sessionIds: { [PANE]: U1 } });
  const e = engine;
  const session = await e.session();
  const agentId = await e.wireIdOf(PANE);
  const a = await attach(e, agentId);
  await reply(e, session, a.frames, "said before the pane closed");
  a.ws.close();

  await e.setAgentGone(true, PANE);
  {
    const { ws, frames } = await openSealedClient(e);
    const row = rowsOf(frames).find((s) => s.id === agentId);
    expect(row, "a conversation with rows stays listed when its pane dies").toBeTruthy();
    expect(row.alive).toBe(false);
    ws.close();
  }

  // claude --resume <U1> in a brand-new pane: the new handle reports the old id
  await e.becomePane(PANE, NEW_PANE);
  expect(await e.wireIdOf(NEW_PANE), "the old id in a new pane is the same agent").toBe(agentId);
  {
    const { ws, frames } = await openSealedClient(e);
    const rows = rowsOf(frames).filter((s) => s.id === agentId || s.harnessSessionId === U1);
    expect(rows.length, "one row for the agent, not one per pane").toBe(1);
    expect(rows[0].alive).toBe(true);
    ws.close();
  }
  const b = await attach(e, agentId);
  expect(b.history.map((m) => m.text)).toContain("said before the pane closed");
  b.ws.close();
  expect((await readAgentMetas(e.dir)).size, "a resume is not a second agent").toBe(1);
  expect(e.lines.some((l) => l.includes("[carry]")), "no carry ran: the index answered").toBe(false);
}, 60_000);

test.skipIf(!hasE2ETransport)("4. the pane handle changes under a live session (epoch bump), same id: same agent id, no carry", async () => {
  engine = await startEngine({ sessionIds: { [PANE]: U1 } });
  const e = engine;
  const session = await e.session();
  const agentId = await e.wireIdOf(PANE);
  const a = await attach(e, agentId);
  await reply(e, session, a.frames, "said on the first handle");

  // a tmux server restart: the same live claude, the same uuid, a new handle
  await e.becomePane(PANE, NEW_PANE);
  expect(await e.wireIdOf(NEW_PANE)).toBe(agentId);
  const { ws, frames } = await openSealedClient(e);
  const rows = rowsOf(frames).filter((s) => s.id === agentId);
  expect(rows.length).toBe(1);
  expect(rows[0].alive).toBe(true);
  expect(rows[0].harnessSessionId).toBe(U1);
  ws.close();

  // the new pane delivers into the same conversation
  const session2 = await e.session(NEW_PANE);
  const more = await reply(e, session2, a.frames, "said on the second handle");
  expect(more.id).toBe(agentId);
  expect((await readChatLog(e.dir, U1)).map((m) => m.text))
    .toEqual(["said on the first handle", "said on the second handle"]);
  a.ws.close();
  expect((await readAgentMetas(e.dir)).size).toBe(1);
  expect(e.lines.some((l) => l.includes("[carry]")), "no carry code ran for a handle change").toBe(false);
  const meta = (await readAgentMetas(e.dir)).get(agentId)!;
  expect(meta.pastSessions, "the id never changed, so nothing is past").toBeUndefined();
}, 60_000);

test.skipIf(!hasE2ETransport)("5. a v1 data dir boots migrated: v2 on disk, every record listed, no nameless agent minted", async () => {
  /* Anonymised copies of the SHAPES a real v1 agents/ held: a uuid-keyed
   * record with pane ids leaked into pastSessions and the reserved keys
   * field; a record whose CURRENT id is a pane handle; a record with no chat
   * at all; and a merged record. Written by hand rather than through
   * seedAgent, which writes v2. */
  const A = mintAgentId(), B = mintAgentId(), C = mintAgentId(), D = mintAgentId();
  engine = await startEngine({
    sessionIds: { [PANE]: U1 },
    seed: async (dir) => {
      const agents = join(dataDirOf(dir), "agents");
      const put = async (id: string, meta: unknown, rows: string[] = []) => {
        await mkdir(join(agents, id, "chats"), { recursive: true });
        await writeFile(join(agents, id, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
        if (rows.length) {
          await writeFile(join(agents, id, "chats", "c1.jsonl"),
            rows.map((text, i) => JSON.stringify({ t: "m", id, role: "claude", text, ts: 1_700_000_000_000 + i })).join("\n") + "\n");
        }
      };
      // A: the live pane's own conversation, v1, pane ids leaked into pastSessions
      await put(A, { v: 1, agentId: A, sessionId: U1, pastSessions: ["w7:p1", U2, "%3~4711~99"], name: "planner",
        chats: [{ id: "c1", createdAt: 1 }], chat: "c1", keys: { x: 1 } }, ["kept across the migration"]);
      // B: a dead conversation keyed by a pane handle (the v1 carry leak)
      await put(B, { v: 1, agentId: B, sessionId: "w9:p1G", pastSessions: [U2],
        chats: [{ id: "c1", createdAt: 1 }], chat: "c1" }, ["an older conversation"]);
      // C: a record with nothing in it (43 of 110 in the live copy)
      await put(C, { v: 1, agentId: C, sessionId: "w3:p2" });
      // D: merged into B
      await put(D, { v: 1, agentId: D, sessionId: U2, mergedInto: B });
    },
  });
  const e = engine;
  await e.session();

  const metas = await readAgentMetas(e.dir);
  expect([...metas.keys()].sort(), "exactly the seeded records, nothing minted").toEqual([A, B, C, D].sort());
  for (const m of metas.values()) {
    expect(m.v).toBe(2);
    expect("keys" in m, "the reserved keys field is gone").toBe(false);
  }
  expect(metas.get(A)!).toMatchObject({ agentId: A, sessionId: U1, pastSessions: [U2], name: "planner", chat: "c1" });
  expect(metas.get(B)!.sessionId, "a pane handle is not a session id").toBeNull();
  expect(metas.get(B)!.pastSessions).toEqual([U2]);
  expect(metas.get(C)!).toEqual({ v: 2, agentId: C, sessionId: null });
  expect(metas.get(D)!.mergedInto).toBe(B);

  const { ws, frames } = await openSealedClient(e);
  const rows = rowsOf(frames);
  expect(rows.map((s) => s.id).sort(), "every non-merged record with rows is listed; merged ones are not")
    .toEqual([A, B].sort());
  const live = rows.find((s) => s.id === A);
  expect(live.alive, "the pane reporting U1 is agent A, alive").toBe(true);
  expect(live.harnessSessionId).toBe(U1);
  expect(live.name).toBe("planner");
  expect(rows.find((s) => s.id === B).alive).toBe(false);
  ws.close();

  const a = await attach(e, A);
  expect(a.history.map((m) => m.text)).toEqual(["kept across the migration"]);
  a.ws.close();
  expect(await e.wireIdOf(PANE)).toBe(A);
  expect(e.lines.filter((l) => /migrated/.test(l)).length, "the migration is reported").toBeGreaterThan(0);
}, 60_000);
