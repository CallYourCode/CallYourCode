/* LANE A, CONTRACT 1-3: start, stop/resume, same-folder-different-session.
 *
 * The identity spine, proven for every {tmux, herdr} x {claude, codex,
 * opencode, pi} cell through the shipped resolver (reconcile.ts:resolvePane +
 * the onAgents rebuild) with each mux's own evidence shape:
 *
 *   1. START           a freshly started pane is ONE row with a stable agent
 *                      id, keyed by that id, its conversation its own.
 *   2. STOP / RESUME   the pane closes (row greys out, chat kept), then a
 *                      --resume writes the same id back: the SAME agent id
 *                      comes back with the same conversation, no second row.
 *   3. SAME FOLDER     a DIFFERENT session started in the same cwd is a NEW
 *                      agent, never the earlier one. Folder is NOT identity.
 *
 * This asserts the CONTRACT, not the implementation's shape: the resolver takes
 * normalized MuxAgentInfo, so tmux's folder-linked stamp and herdr's
 * agent_session stamp are two evidence channels into the ONE rule, and the
 * outcome is identical. tmux + a non-claude harness has no folder locate, so
 * its identity arrives by announce -- expressed here, not hidden.
 *
 *   bun test agent-engine/src/sessions/suite-start-resume.test.ts
 */

import { test, expect, beforeEach, afterAll } from "bun:test";
import {
  MATRIX, CWD, sid, muxGuessRef, announcedRef, paneFor, mountReconcile,
  type Cell,
} from "../test-utils/suite-matrix.ts";
import type { MuxAgentInfo } from "../adapters/mux-adapter.ts";

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const rig = await mountReconcile("cyc-suite-startresume-");
afterAll(() => {
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
  if (REAL_GRACE === undefined) delete process.env.CYC_ANNOUNCE_GRACE_MS;
  else process.env.CYC_ANNOUNCE_GRACE_MS = REAL_GRACE;
});

beforeEach(async () => { await rig.resetPerTest(); });

const AGENT_ID_RE = /^ag-[A-Za-z0-9_-]{16}$/;

/** The ref a fresh pane reports at START: the mux's own guess where it has one
 *  (herdr always, tmux+claude), else the announce that is the only identity
 *  channel for a non-claude tmux pane. Either way it delivers the id. */
function startRef(cell: Cell, id: string) {
  return muxGuessRef(cell, id) ?? announcedRef(id);
}

for (const cell of MATRIX) {
  const tag = `${cell.mux} x ${cell.harness}`;

  test(`[${tag}] CONTRACT 1 start: a fresh pane is one row with a stable agent id`, async () => {
    await rig.boot();
    const S1 = sid(cell.harness, 1);
    rig.reconcile([paneFor(cell, "w1:p1", startRef(cell, S1))]);

    const row = rig.rowOn("w1:p1");
    expect(row.agentId, "keyed by an engine agent id, never a pane or session id").toMatch(AGENT_ID_RE);
    expect(row.id).toBe(row.agentId);
    expect(row.alive).toBe(true);
    expect(row.harnessSessionId, "the pane's session is recorded on the row").toBe(S1);
    expect(row.cwd).toBe(CWD);
    expect(rig.S.sessions.size).toBe(1);
    expect(rig.S.metaFor(row.agentId).sessionId).toBe(S1);
    // its conversation is the row's own log, owned by the agent id
    expect(row.chat).toEqual([]);
    expect(rig.systemRows(row.agentId), "a first start is no rollover: no divider").toEqual([]);

    // STABLE across a second poll: the same id resolves to the same agent
    // through the index, one row, no churn
    const first = row.agentId;
    rig.reconcile([paneFor(cell, "w1:p1", startRef(cell, S1))]);
    expect(rig.rowOn("w1:p1").agentId).toBe(first);
    expect(rig.S.sessions.size).toBe(1);
  });

  test(`[${tag}] CONTRACT 2 stop then resume: the SAME agent comes back, chat carried, no second row`, async () => {
    await rig.boot();
    const S1 = sid(cell.harness, 1);
    rig.reconcile([paneFor(cell, "w1:p1", startRef(cell, S1))]);
    const agentId = rig.rowOn("w1:p1").agentId;
    // he said something, so the dead row is a conversation worth keeping
    rig.S.sessions.get(agentId)!.chat.push(
      { id: agentId, role: "user", text: "carry me across the stop", ts: 5 } as never);

    // STOP: the pane closes. The row greys out; its chat survives; no purge.
    rig.reconcile([]);
    const dead = rig.S.sessions.get(agentId)!;
    expect(dead.alive).toBe(false);
    expect(dead.chat.map((m) => m.text)).toEqual(["carry me across the stop"]);

    // RESUME: `--resume S1` writes the same id back on a (possibly new) pane.
    rig.reconcile([paneFor(cell, "w2:p2", startRef(cell, S1))]);
    const back = rig.rowOn("w2:p2");
    expect(back.agentId, "resume returns the SAME agent id").toBe(agentId);
    expect(back.alive).toBe(true);
    expect(back.harnessSessionId).toBe(S1);
    expect(back.chat.map((m) => m.text), "the conversation came back with it").toEqual([
      "carry me across the stop",
    ]);
    expect(rig.S.sessions.size, "one row, never two").toBe(1);
    // resuming the agent's OWN current id is not a roll: no divider
    expect(rig.systemRows(agentId)).toEqual([]);
  });

  test(`[${tag}] CONTRACT 3 same folder, different session: a NEW agent, never the earlier one`, async () => {
    await rig.boot();
    const S1 = sid(cell.harness, 1);
    const S2 = sid(cell.harness, 2);
    rig.reconcile([paneFor(cell, "w1:p1", startRef(cell, S1))]);
    const first = rig.rowOn("w1:p1").agentId;

    // a DIFFERENT session starts in the SAME cwd, in a fresh pane
    rig.reconcile([
      paneFor(cell, "w1:p1", startRef(cell, S1)),
      paneFor(cell, "w9:p9", startRef(cell, S2), { cwd: CWD }),
    ]);
    const second = rig.rowOn("w9:p9").agentId;
    expect(second, "the folder is not identity: a new session is a new agent").not.toBe(first);
    expect(second).toMatch(AGENT_ID_RE);
    expect(rig.rowOn("w9:p9").cwd).toBe(CWD);
    expect(rig.rowOn("w1:p1").cwd).toBe(CWD);
    expect(rig.S.sessions.size).toBe(2);
    expect(rig.S.metaFor(second).sessionId).toBe(S2);
    // neither pane rolled: two distinct starts, no divider on either
    expect(rig.systemRows(first)).toEqual([]);
    expect(rig.systemRows(second)).toEqual([]);
  });
}

/* One order-independence check standing in for the whole matrix: the
 * same-folder rule cannot depend on which pane the mux listed first, whatever
 * the harness. Run for a herdr claude cell (the channel with a mux guess) and
 * a tmux codex cell (the announce-only channel), both pane orders. */
const orderCells = MATRIX.filter((c) =>
  (c.mux === "herdr" && c.harness === "claude") || (c.mux === "tmux" && c.harness === "codex"));
for (const cell of orderCells) {
  for (const order of [["w1:p1", "w9:p9"], ["w9:p9", "w1:p1"]] as const) {
    test(`[${cell.mux} x ${cell.harness}] same-folder is a new agent in pane order ${order.join(",")}`, async () => {
      await rig.boot();
      const S1 = sid(cell.harness, 1);
      const S2 = sid(cell.harness, 2);
      rig.reconcile([paneFor(cell, "w1:p1", startRef(cell, S1))]);
      const first = rig.rowOn("w1:p1").agentId;
      const byHandle: Record<string, MuxAgentInfo> = {
        "w1:p1": paneFor(cell, "w1:p1", startRef(cell, S1)),
        "w9:p9": paneFor(cell, "w9:p9", startRef(cell, S2), { cwd: CWD }),
      };
      rig.reconcile(order.map((h) => byHandle[h]!));
      expect(rig.rowOn("w9:p9").agentId).not.toBe(first);
      expect(rig.rowOn("w1:p1").agentId).toBe(first);
      expect(rig.S.sessions.size).toBe(2);
    });
  }
}
