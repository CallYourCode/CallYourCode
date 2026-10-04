/* CARRY, what is left of it (carry.ts, adapters lane 2).
 *
 * The agent id keys the row, the chat and the meta, so a harness id rolling
 * moves nothing. Two operations remain and each has one rule worth pinning:
 *
 *   adoptSession   idempotent; the previous id goes to pastSessions ONCE; a
 *                  --resume of a past id pulls it back to current; the meta is
 *                  flushed NOW, not on a debounce
 *   absorb         a provisional folds into its real agent AT MOST ONCE; the
 *                  tombstone (mergedInto) lands before the merged chat; a
 *                  provisional that never reached disk leaves no directory
 *   mergeChats     a UNION keyed by the row, never by the session id every row
 *                  of one chat shares
 *
 * PURE UNIT: a throwaway data dir, the session-state singleton reset per test,
 * no engine, no sockets.
 *
 *   bun test agent-engine/src/sessions/carry.test.ts
 */

import { expect, test, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as S from "./session-state.ts";
import { adoptSession, absorb, mergeChats, carryDirectHandleBind } from "./carry.ts";
import { tmpDataDir } from "../test-utils/tmp.ts";
import { seedAgent, readAgentMetas, readChatLog } from "../test-utils/builders.ts";
import { until } from "../test-utils/wait.ts";
import type { ChatMsg } from "../chat/chatmsg.ts";

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const { root, data } = await tmpDataDir("cyc-carry-");
process.env.CYC_DATA_DIR = data;
afterAll(() => {
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
});

const deps: S.SessionStateDeps = { noteMinted: () => {}, broadcastSessions: () => {}, lineageOf: () => undefined };

const U1 = "5efab001-1111-4aaa-8bbb-000000000001";
const U2 = "5efab002-2222-4ccc-8ddd-000000000002";
const U3 = "5efab003-3333-4eee-8fff-000000000003";

beforeEach(async () => {
  // a flush the previous test started (adoptSession writes NOW, unawaited)
  // must land before the data dir goes, or its record surfaces in this test
  await S.settleAgentSaves();
  S.resetForTest();
  await rm(join(data, "agents"), { recursive: true, force: true });
  await rm(join(data, "state"), { recursive: true, force: true });
});

const metaOnDisk = async (agentId: string) =>
  JSON.parse(await Bun.file(join(data, "agents", agentId, "meta.json")).text());

/** A live Session row with only the fields carry.ts touches. */
const live = (agentId: string, sessionId: string | null, chat: ChatMsg[] = []) => {
  const s = { id: agentId, agentId, agent: { id: "claude" }, cwd: "/w", chat, log: [], harnessSessionId: sessionId,
    heardTs: 0, doneSeq: 0, seenDoneSeq: 0, notified: false, filedTs: 0 } as never as S.Session;
  S.sessions.set(agentId, s);
  return s;
};

const row = (id: string, text: string, ts: number, extra: Partial<ChatMsg> = {}): ChatMsg =>
  ({ id, role: "user", text, ts, ...extra }) as ChatMsg;

// ------------------------------------------------------------- adoptSession

test("adopting the id an agent already answers to changes nothing and reports no roll", async () => {
  const { agentId } = await seedAgent(root, U1, [row("x", "hi", 1)]);
  await S.loadSessionState(deps);
  S.sessionStateReady();
  expect(adoptSession(agentId, U1)).toBe(false);
  expect(adoptSession(agentId, U1)).toBe(false);
  const meta = S.metaFor(agentId);
  expect(meta.sessionId).toBe(U1);
  expect(meta.pastSessions).toBeUndefined();
});

test("a new id rolls the agent: the old id goes to pastSessions once, the meta is flushed now", async () => {
  const { agentId } = await seedAgent(root, U1, [row("x", "hi", 1)]);
  await S.loadSessionState(deps);
  S.sessionStateReady();
  const s = live(agentId, U1);

  expect(adoptSession(agentId, U2), "a roll from U1 to U2 is a roll").toBe(true);
  expect(adoptSession(agentId, U2), "adopting the current id again is not").toBe(false);
  const meta = S.metaFor(agentId);
  expect(meta.sessionId).toBe(U2);
  expect(meta.pastSessions).toEqual([U1]);
  // the live row follows (the one id, carried for claude and every harness)
  expect(s.harnessSessionId).toBe(U2);
  // both ids name the agent
  expect(S.agentIdFor(U1)).toBe(agentId);
  expect(S.agentIdFor(U2)).toBe(agentId);
  // and disk has it without waiting for a debounce
  await until(async () => (await metaOnDisk(agentId)).sessionId === U2, { what: "the flushed meta" });
  expect((await metaOnDisk(agentId)).pastSessions).toEqual([U1]);
});

test("rolling on again never files the same past id twice", async () => {
  const { agentId } = await seedAgent(root, U1, [row("x", "hi", 1)]);
  await S.loadSessionState(deps);
  S.sessionStateReady();
  adoptSession(agentId, U2);
  adoptSession(agentId, U3);
  expect(S.metaFor(agentId).pastSessions).toEqual([U1, U2]);
  // a resume of U1 pulls it back to current; U3 joins the past, U1 leaves it
  expect(adoptSession(agentId, U1)).toBe(true);
  expect(S.metaFor(agentId).sessionId).toBe(U1);
  expect(S.metaFor(agentId).pastSessions).toEqual([U2, U3]);
  // and forward again: U1 is filed once, not twice
  adoptSession(agentId, U3);
  expect(S.metaFor(agentId).pastSessions).toEqual([U2, U1]);
});

test("the first id of an agent that had none is not a roll", async () => {
  await S.loadSessionState(deps);
  S.sessionStateReady();
  const fresh = S.freshAgentId();
  S.metaFor(fresh);
  expect(adoptSession(fresh, U1), "the first id is birth, not rollover").toBe(false);
  expect(S.metaFor(fresh).sessionId).toBe(U1);
  expect(S.metaFor(fresh).pastSessions).toBeUndefined();
});

// ------------------------------------------------------------------- absorb

test("a provisional that said things folds into its agent: rows union, index repoints, one record on disk", async () => {
  const { agentId } = await seedAgent(root, U1, [row("x", "before", 1000, { seq: 0 })]);
  await S.loadSessionState(deps);
  S.sessionStateReady();
  const target = live(agentId, U1, [row(agentId, "before", 1000, { seq: 0 })]);

  const pid = S.freshAgentId();
  const prov = live(pid, null, [row(pid, "said while parked", 2000, { msgId: "m-parked" })]);
  S.metaFor(pid);
  S.chatRefFor(pid); // the provisional reached disk: it has a chat file
  await S.flushAgentSave(pid);
  expect(await Bun.file(join(data, "agents", pid, "meta.json")).exists(), "the provisional's record").toBe(true);
  S.indexSession("w9:p9", pid);

  absorb(prov, agentId);

  // in memory, synchronously
  expect(S.sessions.has(pid)).toBe(false);
  expect(S.agentMetas.has(pid)).toBe(false);
  expect(target.chat.map((m) => m.text)).toEqual(["before", "said while parked"]);
  expect(target.chat.every((m) => m.id === agentId), "a folded row keeps the provisional's id").toBe(true);
  expect(S.sessionIndex.get("w9:p9"), "the provisional's keys point at the survivor").toBe(agentId);
  // on disk: the tombstone, then the merged chat under the target
  await until(async () => (await metaOnDisk(pid)).mergedInto === agentId, { what: "the tombstone" });
  await until(async () => (await readChatLog(root, U1)).length === 2, { what: "the merged chat under the target" });
  expect((await readChatLog(root, U1)).map((m) => m.text)).toEqual(["before", "said while parked"]);
});

test("absorb runs at most once: a provisional already merged is left alone", async () => {
  const { agentId } = await seedAgent(root, U1, []);
  const { agentId: other } = await seedAgent(root, U2, []);
  await S.loadSessionState(deps);
  S.sessionStateReady();
  const target = live(agentId, U1, []);
  live(other, U2, []);

  const pid = S.freshAgentId();
  const prov = live(pid, null, [row(pid, "once", 2000, { msgId: "m-once" })]);
  S.metaFor(pid);
  absorb(prov, agentId);
  expect(target.chat.map((m) => m.text)).toEqual(["once"]);

  // a second call, even towards a different agent, does nothing: the record
  // is gone and the (stale) row's rows do not land twice anywhere
  absorb(prov, other);
  expect(S.sessions.get(other)!.chat).toEqual([]);
  expect(target.chat.map((m) => m.text)).toEqual(["once"]);
  // and a tombstoned record is refused too
  S.agentMetas.set(pid, { v: 2, agentId: pid, sessionId: null, mergedInto: agentId });
  absorb(prov, other);
  expect(S.sessions.get(other)!.chat).toEqual([]);
  await until(async () => (await readChatLog(root, U1)).length === 1, { what: "the one merged write to land" });
});

test("a provisional that never reached disk leaves no directory behind", async () => {
  const { agentId } = await seedAgent(root, U1, []);
  await S.loadSessionState(deps);
  S.sessionStateReady();
  live(agentId, U1, []);
  const pid = S.freshAgentId();
  const prov = live(pid, null, []); // parked, said nothing
  S.metaFor(pid);
  absorb(prov, agentId);
  // the debounced save and the flush share one gate (persistable); driving
  // the flush is the same proof as waiting the debounce out, without the wait
  await S.flushAgentSave(pid);
  await S.flushAgentSave(agentId);
  expect((await readAgentMetas(root)).size, "the survivor's record alone").toBe(1);
  expect(await Bun.file(join(data, "agents", pid, "meta.json")).exists(),
    "a nameless tombstone is exactly the litter this rule exists to stop").toBe(false);
  expect((await readAgentMetas(root)).size).toBe(1);
});

test("absorb into an agent no pane hosts yet lands the rows in its restored chat", async () => {
  const { agentId } = await seedAgent(root, U1, [row("x", "restored", 1000, { seq: 0 })]);
  await S.loadSessionState(deps);
  S.sessionStateReady();
  expect(S.sessions.has(agentId)).toBe(false);
  const pid = S.freshAgentId();
  const prov = live(pid, null, [row(pid, "parked words", 2000, { msgId: "m-p" })]);
  S.metaFor(pid);
  absorb(prov, agentId);
  expect(S.restoredChats.get(agentId)!.map((m) => m.text)).toEqual(["restored", "parked words"]);
  await until(async () => (await readChatLog(root, U1)).length === 2, { what: "the merged chat on disk" });
});

test("absorb folds the session records too, onto ONE seq axis with the messages, and writes both kinds", async () => {
  const { agentId } = await seedAgent(root, U1, [row("x", "before", 1000, { seq: 0 })]);
  await S.loadSessionState(deps);
  S.sessionStateReady();
  const target = live(agentId, U1, [row(agentId, "before", 1000, { seq: 0 })]);
  target.log = [{ seq: 1, ts: 1500, id: "se-t", kind: "status", text: "status: working", status: "working" }];

  const pid = S.freshAgentId();
  const prov = live(pid, null, [row(pid, "parked", 2000, { msgId: "m-p", seq: 1 })]);
  prov.log = [{ seq: 0, ts: 1800, id: "se-p", kind: "ask", text: "Allow?" },
    { seq: 2, ts: 2500, id: "se-p2", kind: "tool", text: "Read a", src: { h: "claude", sid: "u", rid: "r1", off: 0 } }];
  S.metaFor(pid);
  absorb(prov, agentId);

  // one axis, in ts order, dense from 0
  expect(target.chat.map((m) => [m.text, m.seq])).toEqual([["before", 0], ["parked", 3]]);
  expect(target.log.map((r) => [r.text, r.seq])).toEqual([["status: working", 1], ["Allow?", 2], ["Read a", 4]]);
  // on disk: the merged file carries both kinds, interleaved by seq
  await until(async () => (await readChatLog(root, U1)).length === 2, { what: "the merged chat on disk" });
  const meta = S.metaFor(agentId);
  const loaded = await S.chatStore.loadLog(agentId, meta.chat!);
  expect(loaded.recs.map((r) => r.seq)).toEqual([1, 2, 4]);
  expect(loaded.msgs.map((m) => m.seq)).toEqual([0, 3]);
});

test("absorbing an agent into itself is a no-op", async () => {
  const { agentId } = await seedAgent(root, U1, []);
  await S.loadSessionState(deps);
  const s = live(agentId, U1, [row(agentId, "kept", 1)]);
  absorb(s, agentId);
  expect(S.sessions.get(agentId)).toBe(s);
  expect(s.chat.length).toBe(1);
});

// ------------------------------------------------- carryDirectHandleBind
/* The engine-owned pi direct bind. pi is engine-spawned, so the engine owns
 * the pane handle (adoptAgentId's binding) and pi's own socket delivers the
 * session id straight to the engine. This carries it onto the bound agent with
 * NO herdr snapshot of the pane in between: the determinism the herdr-lift path
 * misses on. */

const HANDLE = "w7:p3";
const PI_AID = "ag-0123456789abcdef";        // the engine's pre-minted pi agent id

test("the direct bind fills a NULL id onto the engine's own pane, with no herdr snapshot", async () => {
  await S.loadSessionState(deps);
  S.sessionStateReady();
  // spawn-time state ONLY: a pane binding + a null-id meta, exactly what
  // adoptAgentId leaves. No mux/herdr snapshot of the pane has run.
  S.adoptAgentId(HANDLE, PI_AID);
  const s = live(PI_AID, null);        // the engine's own freshly-spawned pi row
  s.muxHandle = HANDLE;
  expect(S.metaFor(PI_AID).sessionId).toBeNull();

  // pi's socket delivers its session uuid: carry it DIRECTLY
  expect(carryDirectHandleBind(HANDLE, U2)).toBe(PI_AID);
  expect(S.metaFor(PI_AID).sessionId).toBe(U2); // the row's id, filled deterministically
  expect(s.harnessSessionId).toBe(U2);          // the live session, set directly
  expect(S.metaFor(PI_AID).pastSessions).toBeUndefined(); // filling a null id is not a roll
  // and it indexed the id so reconcile resolves the same agent
  expect(S.sessionBySessionId(U2)?.id).toBe(PI_AID);
});

test("idempotence: the later reconcile carry of the same id is a no-op", async () => {
  await S.loadSessionState(deps);
  S.sessionStateReady();
  S.adoptAgentId(HANDLE, PI_AID);
  const s = live(PI_AID, null);
  s.muxHandle = HANDLE;

  expect(carryDirectHandleBind(HANDLE, U2)).toBe(PI_AID);
  // reconcile's carry of the SAME id later: adoptSession reports no roll
  expect(adoptSession(PI_AID, U2)).toBe(false);
  // a second direct delivery of the same id is a no-op too
  expect(carryDirectHandleBind(HANDLE, U2)).toBe(PI_AID);
  expect(S.metaFor(PI_AID).sessionId).toBe(U2);
  expect(S.metaFor(PI_AID).pastSessions).toBeUndefined();
});

test("a DIFFERENT id arriving is not clobbered here: it defers to rollover", async () => {
  await S.loadSessionState(deps);
  S.sessionStateReady();
  S.adoptAgentId(HANDLE, PI_AID);
  const s = live(PI_AID, U2);          // already answering to U2
  S.metaFor(PI_AID).sessionId = U2;

  // U3 arriving on the socket must NOT clobber the live U2: no return, no roll
  expect(carryDirectHandleBind(HANDLE, U3)).toBeNull();
  expect(S.metaFor(PI_AID).sessionId).toBe(U2); // untouched
  expect(s.harnessSessionId).toBe(U2);
  expect(S.metaFor(PI_AID).pastSessions).toBeUndefined(); // no rollover here
  expect(S.sessionBySessionId(U3)).toBeUndefined();       // and U3 was not indexed
});

test("an unbound handle carries nothing: no session is invented", async () => {
  await S.loadSessionState(deps);
  S.sessionStateReady();
  expect(carryDirectHandleBind("w9:p9", U1)).toBeNull();
  expect(S.sessionBySessionId(U1)).toBeUndefined();
});

// --------------------------------------------------------------- mergeChats

test("mergeChats is a union keyed by the row, not by the session id the rows share", () => {
  /* Every row of one chat carries the same `id` (its session). Keying a union
   * by it collapsed a whole chat to one row. The audio id or the idempotency
   * key names a row; a row with neither is the same row only when role, time
   * and text all agree. */
  const a: ChatMsg[] = [
    row("A", "one", 10, { msgId: "m1" }),
    row("A", "two", 20, { key: "k2" }),
    row("A", "three", 30),
  ];
  const b: ChatMsg[] = [
    row("B", "one", 10, { msgId: "m1" }),        // same row (audio id)
    row("B", "two again", 25, { key: "k2" }),    // same row (idempotency key)
    row("B", "three", 30),                       // same row (role, ts, text)
    row("B", "four", 5),                         // new, and earlier
  ];
  const out = mergeChats(a, b);
  expect(out.map((m) => m.text)).toEqual(["four", "one", "two", "three"]);
  // ordered by ts and re-sequenced
  expect(out.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
  // the first operand's row wins a tie
  expect(out.find((m) => m.msgId === "m1")!.id).toBe("A");
});
