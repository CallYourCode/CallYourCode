/* THE RESOLUTION RULE (reconcile.ts, adapters lane 2, design section 1).
 *
 * Every mux pane resolves to ONE agent id through resolvePane, in this order:
 * an explicit link (`link.from`) in the index; the announced id in the index;
 * an unknown id in a pane already bound to an agent that is not live
 * elsewhere (the same-pane rollover); otherwise a new agent. No id yet: the
 * pre-mint, the binding, or a provisional that never reaches disk. A guessed
 * (non-announced) id waits out the announce grace. And every agent with a
 * conversation on disk is a row, dead when no pane hosts it.
 *
 * PURE UNIT over the shipped reconcile: session-state's maps in a throwaway
 * data dir, chatlog and tails given the smallest deps they need, the poll
 * driven by hand with MuxAgentInfo rows. No engine, no sockets, no mux.
 *
 *   bun test agent-engine/src/sessions/reconcile.test.ts
 */

import { expect, test, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as S from "./session-state.ts";
import { makeReconcile, resolvePane, evidenceOf, tickOf, resetReconcileForTest, announceGraceMs } from "./reconcile.ts";
import { initChatlog } from "../chat/chatlog.ts";
import { initIngest } from "../chat/ingest.ts";
import { ANNOUNCED_SOURCE, PREMINT_SOURCE, PARKED_SOURCE } from "../runtime/agents.ts";
import { tmpDataDir } from "../test-utils/tmp.ts";
import { seedAgent, readAgentMetas } from "../test-utils/builders.ts";
import { until } from "../test-utils/wait.ts";
import type { MuxAgentInfo } from "../adapters/mux-adapter.ts";
import type { AgentSessionRef } from "../runtime/agents.ts";

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const { root, data } = await tmpDataDir("cyc-reconcile-");
process.env.CYC_DATA_DIR = data;
afterAll(() => {
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
  if (REAL_GRACE === undefined) delete process.env.CYC_ANNOUNCE_GRACE_MS;
  else process.env.CYC_ANNOUNCE_GRACE_MS = REAL_GRACE;
});

const U1 = "5efab001-1111-4aaa-8bbb-000000000001";
const U2 = "5efab002-2222-4ccc-8ddd-000000000002";
const U3 = "5efab003-3333-4eee-8fff-000000000003";
const CWD = "/home/x/proj";

const deps: S.SessionStateDeps = { noteMinted: () => {}, broadcastSessions: () => {}, lineageOf: () => undefined };
let broadcasts: unknown[] = [];
let clock = 1_000_000;

initChatlog({
  chatOf: (id) => S.sessions.get(id)?.chat ?? S.restoredChats.get(id),
  restoredChats: () => S.restoredChats,
  persistPatch: (id, mts, set, unset) => S.persistPatch(id, mts, set, unset),
  broadcast: (m) => { broadcasts.push(m); },
  chatRefFor: (id) => S.chatRefFor(id),
  indexMsgBlobs: (aid, m) => S.indexMsgBlobs(aid, m),
  appendMsg: (aid, chatId, m) => S.chatStore.appendMsg(aid, chatId, m),
  appendRec: (aid, chatId, rec) => S.chatStore.appendRec(aid, chatId, rec),
});
initIngest({
  sessionOf: (id) => S.sessions.get(id),
  sessions: () => S.sessions.values(),
  broadcastSessions: () => {},
  subscribe: () => null,
  readTranscriptSpan: async () => ({ events: [], queueOps: [], consumed: [], delivered: [], offset: 0 }),
  subscribeStatus: () => null,
  transcriptFile: () => null,
  tailOf: () => undefined,
  setTail: () => {},
  log: () => {},
});

const reconcile = makeReconcile({
  hasTranscript: () => false,
  canParseScreen: () => false, nativeDone: false,
  sweepTails: () => {},
  broadcastSessions: () => {},
  now: () => clock,
});

beforeEach(async () => {
  S.resetForTest();
  resetReconcileForTest();
  // let the previous test's in-flight writes (a flushed meta, a chat append,
  // a binding save) land before the tree is thrown away, or one of them
  // re-creates an agent dir under this test's feet
  await S.chatStore.flush();
  await new Promise((r) => setTimeout(r, 50));
  await rm(join(data, "agents"), { recursive: true, force: true });
  await rm(join(data, "state"), { recursive: true, force: true });
  process.env.CYC_ANNOUNCE_GRACE_MS = "0";
  broadcasts = [];
  clock = 1_000_000;
});

const boot = async () => { await S.loadSessionState(deps); S.sessionStateReady(); };

/** One pane as the mux reports it. */
function pane(handle: string, ref: AgentSessionRef | null, over: Partial<MuxAgentInfo> = {}): MuxAgentInfo {
  return {
    handle, title: "proj", cwd: CWD, lifecycle: "running", kind: "claude",
    harnessSessionId: ref && ref.kind === "id" && ref.source !== PREMINT_SOURCE && ref.source !== PARKED_SOURCE ? ref.id : null,
    agentSession: ref, workspace: "w", tab: null, displayAgent: null, stateChangeSeq: 0, statusHint: "idle",
    ...over,
  };
}
const announced = (id: string, link?: AgentSessionRef["link"]): AgentSessionRef =>
  ({ id, kind: "id", source: ANNOUNCED_SOURCE, ...(link ? { link } : {}) });
const guessed = (id: string): AgentSessionRef => ({ id, kind: "id", source: "herdr:claude" });
const premint = (agentId: string): AgentSessionRef => ({ id: agentId, kind: "id", source: PREMINT_SOURCE });
const parked: AgentSessionRef = { id: "", kind: "id", source: PARKED_SOURCE };

/** resolvePane over a one-pane tick, for the direct-call tests. */
const resolveOne = (p: MuxAgentInfo) => resolvePane(p, evidenceOf(p), tickOf([p], [evidenceOf(p)], clock));

const rowOn = (handle: string) => S.sessionByHandle(handle)!;
const systemRows = (agentId: string) =>
  (S.sessions.get(agentId)?.chat ?? []).filter((m) => m.kind === "system").map((m) => m.text);

// ------------------------------------------------------------- the rule

test("rule 1: a link's `from` in the index names the agent, before any pane matching", async () => {
  const { agentId: linked } = await seedAgent(root, U1, [{ id: "r", role: "user", text: "old", ts: 1 }]);
  const { agentId: other } = await seedAgent(root, U2, [{ id: "r", role: "user", text: "other", ts: 1 }]);
  await boot();
  // the pane is live under `other` (its own session), then announces a NEW
  // id U3 that says it was forked from U1: the link wins over the pane
  reconcile([pane("w1:p1", announced(U2))]);
  expect(rowOn("w1:p1").agentId).toBe(other);
  const r = resolveOne(pane("w1:p1", announced(U3, { kind: "fork", from: U1 })));
  expect(r).toEqual({ agentId: linked, sessionId: U3, how: "link" });
  reconcile([pane("w1:p1", announced(U3, { kind: "fork", from: U1 }))]);
  expect(rowOn("w1:p1").agentId).toBe(linked);
  expect(S.metaFor(linked).sessionId).toBe(U3);
  expect(S.metaFor(linked).pastSessions).toEqual([U1]);
  expect(systemRows(linked)).toEqual(["new session (fork)"]);
  // `other` lost its pane and is listed dead, its chat intact and unmerged
  expect(S.sessions.get(other)!.alive).toBe(false);
  expect(S.sessions.get(other)!.chat.map((m) => m.text)).toEqual(["other"]);
  expect(S.metaFor(other).mergedInto).toBeUndefined();
});

test("a link whose `from` nobody knows is no evidence: the rest of the rule decides", async () => {
  await boot();
  const r = resolveOne(pane("w1:p1", announced(U3, { kind: "fork", from: U1 })));
  expect(r.how).toBe("new");
});

/* THE "LIVE ELSEWHERE" GUARD IS ORDER-INDEPENDENT (defect from 2026-09-02).
 * Each scenario runs in both pane orders through `orders`: the outcome must
 * be the same whichever pane the mux lists first. */
const orders = [["w1:p1", "w2:p2"], ["w2:p2", "w1:p1"]] as const;
const inOrder = (order: readonly string[], byHandle: Record<string, MuxAgentInfo>) => order.map((h) => byHandle[h]!);

for (const order of orders) {
  test(`rule 1 guard: a link from an id LIVE in another pane is a fork, a new agent (order ${order.join(",")})`, async () => {
    await boot();
    reconcile([pane("w2:p2", announced(U1))]);
    const a = rowOn("w2:p2").agentId;
    // U1 keeps running in w2:p2; w1:p1 announces U3 saying it came from U1
    reconcile(inOrder(order, { "w2:p2": pane("w2:p2", announced(U1)), "w1:p1": pane("w1:p1", announced(U3, { kind: "fork", from: U1 })) }));
    expect(rowOn("w2:p2").agentId).toBe(a);
    expect(rowOn("w1:p1").agentId).not.toBe(a);
    expect(S.sessions.size).toBe(2);
    expect(S.metaFor(a).sessionId).toBe(U1);
    expect(S.metaFor(a).pastSessions).toBeUndefined();
    expect(S.metaFor(rowOn("w1:p1").agentId).sessionId).toBe(U3);
  });

  for (const held of ["w1:p1", "w2:p2"] as const) {
    test(`rule 3 guard: A's id resumed in a second pane, then a stranger in the pane holding A's row (row on ${held}, order ${order.join(",")})`, async () => {
      // A holds `held` with U1; U1 is resumed in the other pane too
      // (one row, the pane listed first keeps it); then `held` announces an
      // unknown U2. U2 is a stranger: A stays with U1 and the pane running U1.
      const other = held === "w1:p1" ? "w2:p2" : "w1:p1";
      await boot();
      reconcile([pane(held, announced(U1))]);
      const a = rowOn(held).agentId;
      reconcile([pane(held, announced(U1)), pane(other, announced(U1))]);
      expect(S.sessions.size).toBe(1);
      expect(rowOn(held).agentId).toBe(a);
      reconcile(inOrder(order, { [held]: pane(held, announced(U2)), [other]: pane(other, announced(U1)) }));
      expect(S.metaFor(a).sessionId).toBe(U1);
      expect(S.metaFor(a).pastSessions).toBeUndefined();
      expect(S.sessionByHandle(other)?.agentId, "the pane running A's id keeps A's row").toBe(a);
      expect(rowOn(held).agentId).not.toBe(a);
      expect(S.metaFor(rowOn(held).agentId).sessionId).toBe(U2);
      expect(S.sessions.size).toBe(2);
      expect(systemRows(a)).toEqual([]);
    });
  }

  test(`rule 3 guard off a restored binding: A's id reopened elsewhere, a stranger in A's old pane (order ${order.join(",")})`, async () => {
    // After a restart the binding still names A on w1:p1 and A is a dead
    // row with history. The user reopened A (--resume U1) in w2:p2; a
    // stranger U2 sits in w1:p1. A's history must go with U1, not with U2.
    const { agentId: a } = await seedAgent(root, U1, [{ id: "r", role: "user", text: "history", ts: 1 }], { cwd: CWD });
    await boot();
    S.recordBinding("w1:p1", { agentId: a, sessionId: U1, cwd: CWD });
    const bindingsFile = join(data, "state", "pane-bindings.json");
    await until(async () => (await Bun.file(bindingsFile).text().catch(() => "")).includes(a), { what: "the binding" });
    S.resetForTest();
    resetReconcileForTest();
    await boot();
    expect(S.bindingOf("w1:p1")).toMatchObject({ agentId: a, alive: true });
    reconcile([]);
    expect(S.sessions.get(a)!.alive).toBe(false);
    reconcile(inOrder(order, { "w1:p1": pane("w1:p1", announced(U2)), "w2:p2": pane("w2:p2", announced(U1)) }));
    expect(S.metaFor(a).sessionId).toBe(U1);
    expect(S.metaFor(a).pastSessions).toBeUndefined();
    expect(rowOn("w2:p2").agentId).toBe(a);
    expect(rowOn("w2:p2").chat.map((m) => m.text)).toEqual(["history"]);
    expect(rowOn("w1:p1").agentId).not.toBe(a);
    expect(rowOn("w1:p1").chat).toEqual([]);
    expect(S.sessions.size).toBe(2);
  });

  test(`rule 3 guard: a past id of A live in another pane also blocks the rollover (order ${order.join(",")})`, async () => {
    const { agentId: a } = await seedAgent(root, U2, [{ id: "r", role: "user", text: "x", ts: 1 }], { pastSessions: [U1] });
    await boot();
    reconcile([pane("w1:p1", announced(U2))]);
    expect(rowOn("w1:p1").agentId).toBe(a);
    // the old session U1 is resumed in w2:p2 while w1:p1 turns over to a stranger U3
    reconcile(inOrder(order, { "w1:p1": pane("w1:p1", announced(U3)), "w2:p2": pane("w2:p2", announced(U1)) }));
    expect(rowOn("w2:p2").agentId).toBe(a);
    expect(rowOn("w1:p1").agentId).not.toBe(a);
    expect(S.metaFor(a).sessionId).toBe(U1);
    expect(S.metaFor(a).pastSessions).toEqual([U2]);
  });

  test(`the same UNKNOWN id in two panes is one agent, and the pane bound to it keeps the row (order ${order.join(",")})`, async () => {
    // U1 is nobody's; both panes report it in the same tick. One agent, one
    // row, and NOT one fresh agent per pane (which is what resolving each pane
    // against the rows rebuilt so far happened to avoid, by order)
    await boot();
    reconcile(inOrder(order, { "w1:p1": pane("w1:p1", announced(U1)), "w2:p2": pane("w2:p2", announced(U1)) }));
    expect(S.sessions.size).toBe(1);
    expect(S.agentMetas.size).toBe(1);
    const a = S.sessionIndex.get(U1)!;
    expect(S.sessions.get(a)!.muxHandle).toBe(order[0]);
    // A rolls to an unknown U2 in its own pane while the other pane reports
    // U2 too: still one agent (A), and A's own pane keeps the row whichever
    // the mux listed first
    const held = order[0], other = order[1];
    reconcile(inOrder([other, held], { [held]: pane(held, announced(U2)), [other]: pane(other, announced(U2)) }));
    expect(S.sessions.size).toBe(1);
    expect(S.sessionIndex.get(U2)).toBe(a);
    expect(S.metaFor(a).sessionId).toBe(U2);
    expect(S.sessions.get(a)!.muxHandle, "the pane whose continuity named A keeps its row").toBe(held);
  });

  for (const announcer of ["w1:p1", "w2:p2"] as const) {
    test(`two silent panes bound alive to A after a restart, then ${announcer} announces a fresh id: A rolls, whichever pane held the row (order ${order.join(",")})`, async () => {
      /* ADV (b): both bindings name A (alive) after a restart and neither
       * pane has announced yet, so the silent tick parks A's row on one of
       * them, by list order. Then one pane says a fresh U2. There is no
       * evidence that A runs anywhere else (a row placed by a binding is not
       * evidence), so U2 is A's rollover: one row, A = U2, in the announcing
       * pane. The same in both orders and for both announcers; the old code
       * minted a stranger whenever the silent tick had parked the row on the
       * other pane, i.e. depending on the mux's order. */
      await boot();
      const a = await bindBothToA();
      S.resetForTest();
      resetReconcileForTest();
      await boot();
      expect(S.bindingOf("w1:p1")).toMatchObject({ agentId: a, alive: true });
      expect(S.bindingOf("w2:p2")).toMatchObject({ agentId: a, alive: true });
      reconcile(inOrder(order, { "w1:p1": pane("w1:p1", parked), "w2:p2": pane("w2:p2", parked) }));
      expect(S.sessions.size).toBe(1);
      expect(S.sessions.get(a)!.muxHandle).toBe(order[0]);
      const other = announcer === "w1:p1" ? "w2:p2" : "w1:p1";
      reconcile(inOrder(order, { [announcer]: pane(announcer, announced(U2)), [other]: pane(other, parked) }));
      expect(S.sessionIndex.get(U2), "the fresh id is A's rollover, not a stranger").toBe(a);
      expect(S.metaFor(a).sessionId).toBe(U2);
      expect(S.sessions.size).toBe(1);
      expect(S.sessions.get(a)!.muxHandle, "A's row is on the pane that spoke").toBe(announcer);
    });
  }

  test(`the same start state (A's row parked on w1:p1), w1:p1 announces a fresh id; only the announce tick's order varies (order ${order.join(",")})`, async () => {
    /* ADV (b2): the repro of the mid-tick read. With the row on w1:p1 and
     * w2:p2 listed first, the old code rebuilt A's row for w2:p2 (silent,
     * bound) and then read THAT row as "A is live elsewhere" when it came to
     * w1:p1: a stranger for U2 and A moved to the silent pane. */
    await boot();
    const a = await bindBothToA();
    S.resetForTest();
    resetReconcileForTest();
    await boot();
    reconcile([pane("w1:p1", parked), pane("w2:p2", parked)]);
    expect(S.sessions.get(a)!.muxHandle).toBe("w1:p1");
    reconcile(inOrder(order, { "w1:p1": pane("w1:p1", announced(U2)), "w2:p2": pane("w2:p2", parked) }));
    expect(S.sessionIndex.get(U2)).toBe(a);
    expect(S.metaFor(a).sessionId).toBe(U2);
    expect(S.sessions.size).toBe(1);
    expect(S.sessions.get(a)!.muxHandle).toBe("w1:p1");
  });
}

/** Two panes whose persisted bindings both name A, alive: A runs U1 in
 *  w1:p1, then U1 is resumed in w2:p2 listed first, so the row moves there
 *  while w1:p1's binding (skipped, not dead) keeps naming A. Waits for the
 *  bindings file to carry both. */
async function bindBothToA(): Promise<string> {
  reconcile([pane("w1:p1", announced(U1))]);
  const a = rowOn("w1:p1").agentId;
  reconcile([pane("w2:p2", announced(U1)), pane("w1:p1", announced(U1))]);
  expect(S.sessions.get(a)!.muxHandle).toBe("w2:p2");
  expect(S.bindingOf("w1:p1")).toMatchObject({ agentId: a, alive: true });
  expect(S.bindingOf("w2:p2")).toMatchObject({ agentId: a, alive: true });
  // the file is written once per tick by concurrent writes; the last to land
  // can be the stale one, so re-save until it carries both handles
  const bindingsFile = join(data, "state", "pane-bindings.json");
  await until(async () => {
    try {
      const j = JSON.parse(await Bun.file(bindingsFile).text());
      if (j["w1:p1"]?.alive === true && j["w2:p2"]?.alive === true) return true;
    } catch { /* not yet */ }
    S.savePaneBindings();
    return false;
  }, { what: "both bindings to reach disk" });
  return a;
}

test("the shape gate: a pane id (or any non-harness id) the mux reports as the session is no evidence (defect B)", async () => {
  /* 57 real metas carry a pane id ("w3:p1") where their session id belongs
   * (the 2026-09-02 survey): v1 keyed an unannounced pane by its pane id and
   * the carry wrote that through. Whatever puts a pane id in the session
   * field now, it must read as "nothing reported": the pane still
   * gets its row (provisional or bound), nothing indexes the pane id, and no
   * meta is written with it. Announced, guessed, claude and non-claude alike. */
  await boot();
  const OC = "ses_7f3a2b1c9d8e0f4a5b6c7d";
  for (const bad of ["w1:p1", "herdr:w1:p1", "%3", "%3~4711~1700000000", "tmux:%3", "red:p1", "label"]) {
    for (const ref of [guessed(bad), announced(bad)]) {
      const ev = evidenceOf(pane("w1:p1", ref));
      expect(ev.sessionId, `${ref.source} ${bad}`).toBeNull();
      expect(evidenceOf(pane("w1:p1", ref, { kind: "codex", harnessSessionId: null })).sessionId, `codex ${bad}`).toBeNull();
    }
  }
  // the harness shapes pass, for every harness kind
  expect(evidenceOf(pane("w1:p1", announced(U1))).sessionId).toBe(U1);
  expect(evidenceOf(pane("w1:p1", guessed(U2))).sessionId).toBe(U2);
  expect(evidenceOf(pane("w1:p1", guessed(OC), { kind: "opencode", harnessSessionId: null })).sessionId).toBe(OC);
  // and through a whole tick: the pane resolves, but the pane id names nothing
  reconcile([pane("w1:p1", guessed("w1:p1"))]);
  expect(rowOn("w1:p1").harnessSessionId).toBeNull();
  expect(S.sessionIndex.has("w1:p1")).toBe(false);
  expect(S.metaFor(rowOn("w1:p1").agentId).sessionId).toBeNull();
});

test("rule 2: an announced id in the index is that agent, whatever pane it shows up in", async () => {
  const { agentId } = await seedAgent(root, U1, [{ id: "r", role: "user", text: "history", ts: 1 }]);
  await boot();
  expect(S.sessions.get(agentId)?.alive, "listed dead before any pane hosts it").toBeUndefined();
  reconcile([]); // a poll with no panes: the dead row appears
  expect(S.sessions.get(agentId)!.alive).toBe(false);
  reconcile([pane("w7:p3", announced(U1))]);
  const s = rowOn("w7:p3");
  expect(s.agentId).toBe(agentId);
  expect(s.id).toBe(agentId);
  expect(s.alive).toBe(true);
  expect(s.harnessSessionId).toBe(U1);
  expect(s.chat.map((m) => m.text)).toEqual(["history"]);
  // adopting the agent's CURRENT id is not a roll: no divider, and a second
  // poll changes nothing
  reconcile([pane("w7:p3", announced(U1))]);
  expect(systemRows(agentId)).toEqual([]);
  expect(S.sessions.size).toBe(1);
});

test("rule 2 by a past id: a --resume of an older session joins the same agent and says so", async () => {
  const { agentId } = await seedAgent(root, U2, [{ id: "r", role: "user", text: "x", ts: 1 }], { pastSessions: [U1] });
  await boot();
  reconcile([pane("w1:p1", announced(U1))]);
  expect(rowOn("w1:p1").agentId).toBe(agentId);
  expect(S.metaFor(agentId).sessionId).toBe(U1);
  expect(S.metaFor(agentId).pastSessions).toEqual([U2]);
  // a --resume is same-conversation churn: adopted and logged, but no chat pill
  expect(systemRows(agentId)).toEqual([]);
});

test("rule 3: an unknown id in the pane an agent holds is that agent rolling (same-pane rollover)", async () => {
  await boot();
  reconcile([pane("w1:p1", announced(U1))]);
  const agentId = rowOn("w1:p1").agentId;
  // /clear: claude announces a fresh id from the same pane
  reconcile([pane("w1:p1", announced(U2))]);
  expect(rowOn("w1:p1").agentId).toBe(agentId);
  expect(S.sessions.size).toBe(1);
  expect(S.metaFor(agentId).sessionId).toBe(U2);
  expect(S.metaFor(agentId).pastSessions).toEqual([U1]);
  expect(S.agentIdFor(U1)).toBe(agentId);
  expect(S.agentIdFor(U2)).toBe(agentId);
  // a plain rollover is same-conversation churn: no chat pill
  expect(systemRows(agentId)).toEqual([]);
  // the harness's own word, when it gives one: a `clear` IS a user-meaningful
  // reset, so it still paints its pill
  reconcile([pane("w1:p1", announced(U3, { kind: "clear", from: U2 }))]);
  expect(systemRows(agentId)).toEqual(["new session (clear)"]);
  expect(S.metaFor(agentId).pastSessions).toEqual([U1, U2]);
});

/* THE ROLLOVER CHAT PILL IS ONLY FOR A USER-MEANINGFUL RESET (owner call
 * 2026-09-08, "this is not needed"). Every same-conversation continuation is
 * suppressed; `clear`/`fork` still paint. A claude compact re-announces the
 * pane twice in quick succession ("link compact" then a plain roll), so ONE
 * compact used to mint TWO useless pills; here that same double announce must
 * write ZERO. The detection (adoption, pastSessions) is untouched throughout. */
test("a compact-kind rollover writes NO chat pill; a clear-kind one writes exactly one", async () => {
  await boot();
  reconcile([pane("w1:p1", announced(U1))]);
  const agentId = rowOn("w1:p1").agentId;

  // an auto-compaction announces a fresh id linked `compact` from the old one
  reconcile([pane("w1:p1", announced(U2, { kind: "compact", from: U1 }))]);
  expect(rowOn("w1:p1").agentId, "the compact was still adopted onto the same agent").toBe(agentId);
  expect(S.metaFor(agentId).sessionId).toBe(U2);
  expect(S.metaFor(agentId).pastSessions).toEqual([U1]);
  expect(systemRows(agentId), "a compact paints no pill").toEqual([]);

  // a /clear IS a user-meaningful reset: it paints its one pill
  reconcile([pane("w1:p1", announced(U3, { kind: "clear", from: U2 }))]);
  expect(systemRows(agentId), "a clear still paints exactly one pill").toEqual(["new session (clear)"]);
});

test("two rapid re-announces of ONE compact write zero chat pills total", async () => {
  await boot();
  reconcile([pane("w1:p1", announced(U1))]);
  const agentId = rowOn("w1:p1").agentId;

  // the observed double announce: "link compact" (U2 linked from U1), then a
  // plain re-announce of the same new id one tick later.
  reconcile([pane("w1:p1", announced(U2, { kind: "compact", from: U1 }))]);
  reconcile([pane("w1:p1", announced(U2))]);
  expect(rowOn("w1:p1").agentId).toBe(agentId);
  expect(S.metaFor(agentId).sessionId).toBe(U2);
  expect(systemRows(agentId), "one compact, two announces, ZERO pills").toEqual([]);
});

test("rule 3 does not fire when the bound agent is live in ANOTHER pane: the id is a new agent", async () => {
  await boot();
  reconcile([pane("w1:p1", announced(U1))]);
  const a = rowOn("w1:p1").agentId;
  // the agent moved: its id now shows in w2:p2, and a stranger's fresh id
  // shows in the pane it left. A binding on w1:p1 still names `a`.
  reconcile([pane("w2:p2", announced(U1)), pane("w1:p1", announced(U2))]);
  expect(rowOn("w2:p2").agentId).toBe(a);
  expect(rowOn("w1:p1").agentId).not.toBe(a);
  expect(S.sessions.size).toBe(2);
  expect(S.metaFor(a).pastSessions).toBeUndefined();
});

test("rule 4: an unknown id in a new pane is a new agent, even in the folder of an old one", async () => {
  /* Owner decision 2026-09-02: matching is on session ids, never on the
   * folder. A fresh id in a fresh pane is a new agent, whatever its cwd. */
  const { agentId: old } = await seedAgent(root, U1, [{ id: "r", role: "user", text: "old", ts: 1 }], { cwd: CWD });
  await boot();
  reconcile([pane("w9:p9", announced(U2), { cwd: CWD })]);
  const s = rowOn("w9:p9");
  expect(s.agentId).not.toBe(old);
  expect(s.agentId).toMatch(/^ag-[A-Za-z0-9_-]{16}$/);
  expect(S.sessions.get(old)!.alive).toBe(false);
  expect(S.metaFor(s.agentId).sessionId).toBe(U2);
  expect(systemRows(s.agentId)).toEqual([]);
});

test("rule 5: a pre-minted CYC_AGENT_ID names the agent before any session id exists", async () => {
  await boot();
  const minted = S.freshAgentId();
  reconcile([pane("w1:p1", premint(minted))]);
  expect(rowOn("w1:p1").agentId).toBe(minted);
  expect(rowOn("w1:p1").harnessSessionId).toBeNull();
  // the hook speaks: the id joins the pre-minted agent, no roll (its first id)
  reconcile([pane("w1:p1", announced(U1))]);
  expect(rowOn("w1:p1").agentId).toBe(minted);
  expect(S.metaFor(minted).sessionId).toBe(U1);
  expect(systemRows(minted)).toEqual([]);
  expect(S.sessions.size).toBe(1);
});

test("rule 5: a parked pane gets a provisional agent that is never written to disk", async () => {
  await boot();
  reconcile([pane("w1:p1", parked)]);
  const prov = rowOn("w1:p1").agentId;
  expect(prov).toMatch(/^ag-/);
  expect(rowOn("w1:p1").harnessSessionId).toBeNull();
  // stable across polls: the live row on the handle keeps it
  reconcile([pane("w1:p1", parked)]);
  expect(rowOn("w1:p1").agentId).toBe(prov);
  S.flushAgentSave(prov);
  await new Promise((r) => setTimeout(r, 200));
  expect((await readAgentMetas(root)).size, "a provisional with no session id and no chat must not litter agents/").toBe(0);
  // the pane closes having said nothing: the row goes, and no record follows
  reconcile([]);
  expect(S.sessions.has(prov)).toBe(false);
  expect(S.agentMetas.has(prov)).toBe(false);
  await new Promise((r) => setTimeout(r, 200));
  expect((await readAgentMetas(root)).size).toBe(0);
});

test("a provisional that then announces a KNOWN id folds into that agent (absorb, once)", async () => {
  const { agentId } = await seedAgent(root, U1, [{ id: "r", role: "user", text: "kept", ts: 1 }]);
  await boot();
  reconcile([pane("w1:p1", parked)]);
  const prov = rowOn("w1:p1").agentId;
  expect(prov).not.toBe(agentId);
  reconcile([pane("w1:p1", announced(U1))]);
  expect(rowOn("w1:p1").agentId).toBe(agentId);
  expect(S.sessions.has(prov)).toBe(false);
  expect(S.sessions.size).toBe(1);
  expect(S.sessions.get(agentId)!.chat.map((m) => m.text)).toEqual(["kept"]);
});

test("the announce grace: a GUESSED id waits, an ANNOUNCED id does not", async () => {
  process.env.CYC_ANNOUNCE_GRACE_MS = "10000";
  expect(announceGraceMs()).toBe(10_000);
  await boot();
  reconcile([pane("w1:p1", guessed(U1))]);
  const prov = rowOn("w1:p1").agentId;
  expect(rowOn("w1:p1").harnessSessionId, "a guess must not name the session inside the grace").toBeNull();
  expect(S.agentIdFor(U1), "nor reach the index").toBe(U1);
  // the pane's own hook speaks inside the grace with a DIFFERENT id (the
  // guess was a stale transcript in the cwd): the announce wins outright
  reconcile([pane("w1:p1", announced(U2))]);
  expect(rowOn("w1:p1").agentId).toBe(prov);
  expect(rowOn("w1:p1").harnessSessionId).toBe(U2);
  expect(S.agentIdFor(U1)).toBe(U1);
  // a second, silent pane: its guess counts once ITS OWN grace has run out
  // (the clock starts at the pane's first sight, not at boot)
  clock += 5_000;
  reconcile([pane("w1:p1", announced(U2)), pane("w2:p2", guessed(U3))]);
  expect(rowOn("w2:p2").harnessSessionId).toBeNull();
  clock += 9_999;
  reconcile([pane("w1:p1", announced(U2)), pane("w2:p2", guessed(U3))]);
  expect(rowOn("w2:p2").harnessSessionId, "9.999s after first sight is still inside the grace").toBeNull();
  clock += 2;
  reconcile([pane("w1:p1", announced(U2)), pane("w2:p2", guessed(U3))]);
  expect(rowOn("w2:p2").harnessSessionId).toBe(U3);
  expect(S.agentIdFor(U3)).toBe(rowOn("w2:p2").agentId);
});

test("the same agent in two panes is one row; the first pane of the tick keeps it", async () => {
  await boot();
  reconcile([pane("w1:p1", announced(U1)), pane("w1:p2", announced(U1))]);
  expect(S.sessions.size).toBe(1);
  expect(rowOn("w1:p1").harnessSessionId).toBe(U1);
  expect(S.sessionByHandle("w1:p2")).toBeUndefined();
});

// ------------------------------------------------- bindings and dead rows

test("the pane binding carries an unannounced pane across an engine restart (same mux epoch)", async () => {
  await boot();
  reconcile([pane("w1:p1", announced(U1))]);
  const agentId = rowOn("w1:p1").agentId;
  S.sessions.get(agentId)!.chat.push({ id: agentId, role: "user", text: "said", ts: 5 } as never);
  expect(S.bindingOf("w1:p1")).toMatchObject({ agentId, sessionId: U1, cwd: CWD, alive: true });
  const bindingsFile = join(data, "state", "pane-bindings.json");
  await until(async () => (await Bun.file(bindingsFile).text().catch(() => "")).includes(agentId),
    { what: "the binding to reach disk" });
  await until(async () => (await readAgentMetas(root)).get(agentId)?.sessionId === U1,
    { what: "the adopt's flushed meta to reach disk" });
  // the restart: the in-memory state is gone, the binding file remains
  S.resetForTest();
  resetReconcileForTest();
  await boot();
  expect(S.bindingOf("w1:p1")).toMatchObject({ agentId, alive: true });
  // the pane is still there but has not announced yet (parked): continuity
  reconcile([pane("w1:p1", parked)]);
  expect(rowOn("w1:p1").agentId).toBe(agentId);
  // and a fresh id in that pane is the SAME agent rolling (rule 3 off the binding)
  reconcile([pane("w1:p1", announced(U2))]);
  expect(rowOn("w1:p1").agentId).toBe(agentId);
  expect(S.metaFor(agentId).pastSessions).toEqual([U1]);
});

test("a DEAD binding never joins: the pane exited, whatever comes back is new", async () => {
  await boot();
  reconcile([pane("w1:p1", announced(U1))]);
  const agentId = rowOn("w1:p1").agentId;
  S.sessions.get(agentId)!.chat.push({ id: agentId, role: "user", text: "said", ts: 5 } as never);
  reconcile([]); // the pane is gone
  expect(S.sessions.get(agentId)!.alive).toBe(false);
  expect(S.bindingOf("w1:p1")!.alive).toBe(false);
  reconcile([pane("w1:p1", announced(U2))]); // the handle comes back with a stranger
  expect(rowOn("w1:p1").agentId).not.toBe(agentId);
  expect(S.metaFor(agentId).pastSessions).toBeUndefined();
});

test("a binding for another folder does not join either", async () => {
  await boot();
  reconcile([pane("w1:p1", announced(U1))]);
  const agentId = rowOn("w1:p1").agentId;
  S.resetForTest();
  resetReconcileForTest();
  await boot();
  reconcile([pane("w1:p1", announced(U2), { cwd: "/somewhere/else" })]);
  expect(rowOn("w1:p1").agentId).not.toBe(agentId);
});

test("every agent with a conversation on disk is a row, dead when no pane hosts it", async () => {
  const { agentId: talked } = await seedAgent(root, U1, [{ id: "r", role: "claude", text: "hello", ts: 1000 }],
    { cwd: "/home/x/spoken", harness: "codex" });
  const { agentId: silent } = await seedAgent(root, U2, []);
  const { agentId: merged } = await seedAgent(root, U3, [{ id: "r", role: "user", text: "gone", ts: 1 }],
    { mergedInto: talked });
  await boot();
  reconcile([]);
  expect([...S.sessions.keys()]).toEqual([talked]);
  const s = S.sessions.get(talked)!;
  expect(s.id).toBe(talked);
  expect(s.alive).toBe(false);
  expect(s.muxHandle).toBe("");
  expect(s.harnessSessionId).toBe(U1);
  expect(s.agent.id).toBe("codex");
  expect(s.name).toBe("spoken");
  expect(s.chat.map((m) => m.text)).toEqual(["hello"]);
  expect(S.sessions.has(silent), "a session id and nothing said has nothing to show").toBe(false);
  expect(S.sessions.has(merged), "a merged record is its survivor's").toBe(false);
  expect(S.agentIdFor(U3), "but its ids still name the survivor").toBe(talked);
});

test("seq continuity: a restart seeds the row's clocks from the agent's own chat file", async () => {
  const { agentId } = await seedAgent(root, U1, [
    { id: "r", role: "user", text: "q", ts: 1000, seq: 0 },
    { id: "r", role: "claude", text: "a", ts: 2000, seq: 1 },
  ], { read: { heardTs: 1500, doneSeq: 4, seenDoneSeq: 3, notified: false, filedTs: 0 } });
  await boot();
  reconcile([pane("w1:p1", announced(U1))]);
  const s = rowOn("w1:p1");
  expect(s.agentId).toBe(agentId);
  expect(s.chat.map((m) => m.seq)).toEqual([0, 1]);
  expect(s.heardTs).toBe(1500);
  expect(s.doneSeq).toBe(4);
  expect(s.seenDoneSeq).toBe(3);
  await until(async () => (await readAgentMetas(root)).get(agentId)?.sessionId === U1, { what: "the meta" });
});
