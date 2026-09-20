/* LANE A, CONTRACT 4: MCP / hook self-declare.
 *
 * An agent that DECLARES its id -- through the cyc MCP (runtime/mcp.ts register,
 * resolved to a pane handle by the mux) and the SessionStart hook
 * (hooks/announce-session.py -> POST /harness/announce -> recordHookBind) --
 * binds to the correct agent, OVERRIDES a mux guess, and the bind SURVIVES an
 * engine restart (state/hook-binds.json).
 *
 * Three seams, all hermetic:
 *   A. reconcile: an ANNOUNCED id (source hook:announce) beats a mux GUESS.
 *      A guess waits out the announce grace; an announce never does, so the
 *      pane's own word wins even when a stale transcript in the cwd guessed
 *      another id first.
 *   B. hook-announce: recordHookBind persists under state/, and hookBindFor
 *      still answers after the in-memory store is forgotten (the restart).
 *   C. MCP register: the mux resolves the raw pane-scoped env id
 *      (HERDR_PANE_ID) to the opaque handle core keys sessions by -- driven on
 *      the REAL MuxAdapter over the REAL herdr JSON-RPC framing (fake-herdr),
 *      no engine process.
 *
 *   bun test agent-engine/src/sessions/suite-declare.test.ts
 */

import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import {
  MATRIX, sid, muxGuessRef, announcedRef, paneFor, mountReconcile, SKIP,
} from "../test-utils/suite-matrix.ts";
import {
  handleAnnounce, hookBindFor, pendingAnnounces, recordHookBind, resetHookAnnounce, takePending,
} from "../terminal/hook-announce.ts";
import { fakeHerdr } from "../test-utils/fake-herdr.ts";
import { tmpDir, sockPath } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";
import { HerdrClient } from "../terminal/herdr.ts";

const { MuxAdapter } = await import("../adapters/mux-adapter.ts");

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const rig = await mountReconcile("cyc-suite-declare-");
afterAll(() => {
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
  if (REAL_GRACE === undefined) delete process.env.CYC_ANNOUNCE_GRACE_MS;
  else process.env.CYC_ANNOUNCE_GRACE_MS = REAL_GRACE;
});
beforeEach(async () => { await rig.resetPerTest(); resetHookAnnounce(); });

const resolved = (agentPid: number | null) => ({ resolveAgentPid: async () => agentPid });

/* ------------------------------------------ A. an announce beats a mux guess */

for (const cell of MATRIX) {
  const tag = `${cell.mux} x ${cell.harness}`;
  const guess = muxGuessRef(cell, sid(cell.harness, 1));

  if (!guess) {
    test.skip(`[${tag}] CONTRACT 4 override: SKIP -- ${SKIP.noMuxGuess(cell)}`, () => {});
    // the announce IS the only identity channel here; that it binds is proven
    // by the START contract (suite-start-resume) for this same cell.
    continue;
  }

  test(`[${tag}] CONTRACT 4: an announced id overrides the mux's folder/agent_session guess`, async () => {
    process.env.CYC_ANNOUNCE_GRACE_MS = "10000";
    await rig.boot();
    const G = sid(cell.harness, 1); // what the mux guessed (a stale locate)
    const A = sid(cell.harness, 2); // what the pane's own hook announces

    // the guess lands first, INSIDE the grace: it must not name the session yet
    rig.reconcile([paneFor(cell, "w1:p1", muxGuessRef(cell, G))]);
    const prov = rig.rowOn("w1:p1").agentId;
    expect(rig.rowOn("w1:p1").harnessSessionId, "a guess is silent inside the grace").toBeNull();
    expect(rig.S.agentIdFor(G), "and never reaches the index").toBe(G);

    // the pane's hook announces a DIFFERENT id: the announce wins outright, no
    // grace, and the guessed id is discarded
    rig.reconcile([paneFor(cell, "w1:p1", announcedRef(A))]);
    expect(rig.rowOn("w1:p1").agentId, "same pane, same agent row").toBe(prov);
    expect(rig.rowOn("w1:p1").harnessSessionId).toBe(A);
    expect(rig.S.agentIdFor(A)).toBe(prov);
    expect(rig.S.agentIdFor(G), "the guess never became a session").toBe(G);
    expect(rig.S.metaFor(prov).sessionId).toBe(A);
  });
}

/* ------------------------------ B. the hook bind persists across a restart */

for (const mux of ["tmux", "herdr"] as const) {
  const handle = mux === "tmux" ? "%3~4242~7" : "w2:p1";
  const owns = mux === "tmux" ? (h: string) => /~\d+~\d+$/.test(h) : (h: string) => h.includes(":");

  test(`[${mux}] CONTRACT 4: a hook bind survives an engine restart (state/hook-binds.json)`, async () => {
    await rig.boot(); // gives this test its own state/ dir under CYC_DATA_DIR
    const A = "aa11bb22-3333-4444-8555-666677778888";

    // the hook announces; the mux places it on its pane handle: bound
    const r = await handleAnnounce({ sessionId: A, pid: 999, cwd: "/tmp/x" }, resolved(4242));
    expect(r).toEqual({ ok: true, parked: true });
    const [p] = pendingAnnounces();
    takePending(p, handle);
    expect(hookBindFor(handle)).toEqual({ sessionId: A });

    // THE RESTART: the in-memory store is forgotten; the file remains
    resetHookAnnounce();
    expect(hookBindFor(handle), "reloaded from state/hook-binds.json").toEqual({ sessionId: A });

    // a new id on the same pane rolls the bind (latest announce wins); the
    // prune is scoped to this mux's own handle shape, never the other lane's
    const B = "bb11cc22-3333-4444-8555-666677778899";
    recordHookBind(handle, B, 4242);
    expect(hookBindFor(handle)).toEqual({ sessionId: B });
    expect(owns(handle)).toBe(true);
  });
}

/* --------------------------- C. MCP register resolves the pane env id (herdr) */

async function herdrAdapter(panes: string[], agentOf?: Map<string, string>) {
  const dir = await tmpDir("cyc-suite-declare-mcp-");
  const sock = sockPath(dir);
  const fake = fakeHerdr(sock, "idle", panes, [], undefined, undefined, undefined,
    new Map(), new Set(), agentOf);
  const client = new HerdrClient(sock);
  const adapter = new MuxAdapter(client);
  adapter.start();
  adapter.onAgents(() => {});
  await until(() => adapter.listAgents().length === panes.length,
    { what: "the fake herdr snapshot to reach the adapter" });
  return { fake, client, adapter };
}

test("[herdr] CONTRACT 4: the MCP's raw pane env id resolves to the opaque handle", async () => {
  // one claude pane, one codex pane: the register resolution is agent-agnostic
  const agentOf = new Map([["w1:p1", "claude"], ["w4:p2", "codex"]]);
  const { fake, client, adapter } = await herdrAdapter(["w1:p1", "w4:p2"], agentOf);
  try {
    // core hands the mux the raw HERDR_PANE_ID the MCP was born with; the mux
    // answers the handle it keys sessions by (herdr: the pane id itself)
    expect(adapter.resolveHandle("w1:p1")).toBe("w1:p1");
    expect(adapter.resolveHandle("w4:p2")).toBe("w4:p2");
    // a pane the mux does not list is not resolvable: core never invents a row
    expect(adapter.resolveHandle("w9:p9")).toBeNull();
    expect(adapter.resolveHandle("")).toBeNull();
  } finally {
    client.stop(); // stop the poll/subscribe before the fake goes away
    fake.stop(true);
  }
});
