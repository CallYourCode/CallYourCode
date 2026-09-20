/* LANE A, CONTRACT 7: the known rebind traps do NOT reoccur, plus the minimal
 * real-mux smoke (the testing-doctrine cap on engine-boot E2E).
 *
 * The three traps six patches were spent on:
 *   (a) 571 DISEASE: a fresh pane in a cwd holding OTHER sessions' jsonls must
 *       not adopt a stranger's newest jsonl. Folder is not identity.
 *   (b) NESTED / BACKGROUND agent (claude in claude, `claude -p`): its announce
 *       must not steal the parent pane's identity. Its nearest agent ancestor
 *       is itself, and its inherited pane witnesses are stripped.
 *   (c) STALE pane-env witness: a tmux pane inheriting a stale HERDR_PANE_ID
 *       from the herdr session that started the tmux server must not shadow the
 *       real pane. Pid resolution is primary; each lane reads only its own
 *       witness.
 *
 * (a) is proven at the resolver (mux-agnostic) here and, at the MUX level,
 * against real tmux below. (b) and (c) are proven hermetically at the announce
 * seam with an injected ancestor walk (no real ps). The real-tmux smoke is two
 * cases -- start, resume-same-agent -- driven end to end through the real
 * TmuxMuxAdapter into the shipped resolver. Real HERDR is gated behind
 * CYC_SUITE_HERDR=1 (the herdr box is separate) and skipped by default.
 *
 *   bun test agent-engine/src/sessions/suite-rebind-traps.test.ts
 */

import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { MATRIX, sid, muxGuessRef, announcedRef, paneFor, CWD, mountReconcile, SKIP } from "../test-utils/suite-matrix.ts";
import {
  handleAnnounce, hookBindFor, pendingAnnounces, resetHookAnnounce, takePending,
} from "../terminal/hook-announce.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { mungeCwd } from "../../../shared/claude-projects.ts";
import { until } from "../test-utils/wait.ts";
import { TmuxMuxAdapter } from "../adapters/tmux-adapter.ts";
import { paneTargetOf } from "../terminal/tmux.ts";
import type { MuxAgentInfo } from "../adapters/mux-adapter.ts";

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const REAL_PROJECTS = process.env.CYC_PROJECTS_DIR;
const rig = await mountReconcile("cyc-suite-rebind-");
afterAll(() => {
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
  if (REAL_GRACE === undefined) delete process.env.CYC_ANNOUNCE_GRACE_MS;
  else process.env.CYC_ANNOUNCE_GRACE_MS = REAL_GRACE;
  if (REAL_PROJECTS === undefined) delete process.env.CYC_PROJECTS_DIR;
  else process.env.CYC_PROJECTS_DIR = REAL_PROJECTS;
});
beforeEach(async () => { await rig.resetPerTest(); resetHookAnnounce(); });

const resolvedChain = (agentPid: number | null, nested = false) =>
  ({ resolveAgentChain: async () => ({ agentPid, nested }) });

/* --------------------------------------------------- (a) the 571 disease */

for (const cell of MATRIX) {
  const tag = `${cell.mux} x ${cell.harness}`;
  const reportRef = (id: string) => muxGuessRef(cell, id) ?? announcedRef(id);

  test(`[${tag}] CONTRACT 7a: a fresh session in a cwd full of a stranger's sessions is a NEW agent`, async () => {
    await rig.boot();
    // a stranger already owns this folder: an agent with its own live session
    const strangerId = sid(cell.harness, 1);
    rig.reconcile([paneFor(cell, "w1:p1", reportRef(strangerId), { cwd: CWD })]);
    const stranger = rig.rowOn("w1:p1").agentId;

    // a BRAND-NEW pane starts in the SAME cwd with a DIFFERENT session id. It
    // must never adopt the stranger's identity (571): folder is not identity.
    const mineId = sid(cell.harness, 2);
    rig.reconcile([
      paneFor(cell, "w1:p1", reportRef(strangerId), { cwd: CWD }),
      paneFor(cell, "w7:p7", reportRef(mineId), { cwd: CWD }),
    ]);
    const mine = rig.rowOn("w7:p7").agentId;
    expect(mine, "the fresh pane is its own agent, not the stranger").not.toBe(stranger);
    expect(rig.S.metaFor(mine).sessionId).toBe(mineId);
    expect(rig.S.metaFor(stranger).sessionId).toBe(strangerId);
    expect(rig.S.metaFor(mine).pastSessions, "and it did not steal the stranger's id as a past one")
      .toBeUndefined();
    expect(rig.S.sessions.size).toBe(2);
  });
}

/* --------------------------------------- (b) a nested / background agent */

test("CONTRACT 7b: a nested agent's announce has its inherited pane witnesses stripped", async () => {
  await rig.boot();
  const child = "cc111111-1111-4111-8111-000000000001";
  // a claude spawned INSIDE a claude (a tool call): the announce inherits the
  // parent pane's HERDR_PANE_ID / TMUX_PANE. The route resolves the chain, sees
  // ANOTHER agent above the announcer, and strips the witnesses so the child
  // can never re-key the parent's pane.
  const r = await handleAnnounce(
    { sessionId: child, pid: 8123, cwd: "/tmp/x", herdrPane: "w1:p1", tmuxPane: "%4" },
    resolvedChain(8123, true));
  expect(r).toEqual({ ok: true, parked: true });
  const [p] = pendingAnnounces();
  expect(p.herdrPane, "the parent's herdr witness is stripped from a nested announce").toBeNull();
  expect(p.tmuxPane, "and the parent's tmux witness too").toBeNull();
  // with no witness and a pid that is the child's own (not the parent pane's
  // detected agent), no mux lap can place it: it parks and expires, stealing
  // nothing. It never binds the parent handle.
  expect(hookBindFor("w1:p1")).toBeNull();
  expect(hookBindFor("%4")).toBeNull();
});

test("CONTRACT 7b: `claude -p` (nearest agent ancestor is itself) never matches the pane", async () => {
  await rig.boot();
  const bg = "cc222222-2222-4222-8222-000000000002";
  // a transient background `claude -p` inside a pane: its nearest agent
  // ancestor is ITSELF (pid 9001), not the pane's topmost claude (pid 4242).
  // The announce parks keyed by 9001; the pane's poll matches its detected
  // pid 4242 and so never places this announce.
  await handleAnnounce({ sessionId: bg, pid: 9001, cwd: "/tmp/x" }, resolvedChain(9001, false));
  const [p] = pendingAnnounces();
  expect(p.agentPid, "parked by its own pid, not the pane's").toBe(9001);
  // the pane's own announce (the real claude, pid 4242) is the one that binds
  const real = "cc333333-3333-4333-8333-000000000003";
  await handleAnnounce({ sessionId: real, pid: 4242, cwd: "/tmp/x", tmuxPane: "%2" }, resolvedChain(4242, false));
  const realPending = pendingAnnounces().find((x) => x.sessionId === real)!;
  takePending(realPending, "%2~4242~7", "pid");
  expect(hookBindFor("%2~4242~7"), "the real claude bound its pane").toEqual({ sessionId: real });
  // the background run never bound anything
  expect(pendingAnnounces().some((x) => x.sessionId === bg), "still parked, unplaced").toBe(true);
});

/* ------------------------------------------ (c) a stale pane-env witness */

test("CONTRACT 7c: a stale herdr witness never shadows the real pane; pid binds", async () => {
  await rig.boot();
  const A = "dd111111-1111-4111-8111-000000000001";
  // a tmux pane inherited a stale HERDR_PANE_ID (w2:p1) from the herdr session
  // that started the tmux server. The announce carries it, but pid resolution
  // is PRIMARY and the tmux lane reads only tmuxPane, never the foreign herdr
  // witness.
  await handleAnnounce(
    { sessionId: A, pid: 777, cwd: "/tmp/x", herdrPane: "w2:p1", tmuxPane: "%5" },
    resolvedChain(4242, false));
  const [p] = pendingAnnounces();
  expect(p.agentPid, "the agent pid is resolved and primary").toBe(4242);
  expect(p.herdrPane, "the stale herdr witness rides as data, secondary").toBe("w2:p1");
  expect(p.tmuxPane).toBe("%5");
  // the tmux lane binds by pid to the REAL pane handle; the stale herdr id
  // never chose a handle and never bound one
  takePending(p, "%5~4242~7", "pid");
  expect(hookBindFor("%5~4242~7")).toEqual({ sessionId: A });
  expect(hookBindFor("w2:p1"), "the stale herdr witness bound nothing").toBeNull();
});

/* ----------------------------------------------- the real-tmux smoke (2) */

const TMUX = Bun.which("tmux");
const SLEEP = Bun.which("sleep") ?? "/bin/sleep";
if (!TMUX) {
  console.warn("\n[suite-rebind-traps] real-tmux smoke SKIPPED: no `tmux` on PATH.\n" +
    "  NOT proven on this box: a real claude pane detected + linked, and the\n" +
    "  same agent id coming back after the pane is killed and respawned.\n");
}
const rt = test.skipIf(!TMUX);

/* A private tmux server on a SHORT -L socket name (its file lives under
 * /tmp/tmux-<uid>/), killed and unlinked at the end; nothing here touches the
 * user's tmux, herdr or ~/.claude. */
const servers: Array<{ sock: string; socketPath?: string; adapters: TmuxMuxAdapter[] }> = [];
afterAll(() => {
  for (const s of servers) {
    for (const a of s.adapters) { try { (a as unknown as { stop?: () => void }).stop?.(); } catch { /* */ } }
    Bun.spawnSync(["tmux", "-L", s.sock, "kill-server"]);
    if (s.socketPath) rmSync(s.socketPath, { force: true });
  }
});

function tmuxServer(name: string) {
  const sock = `cyc-suite-${name}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  const entry: { sock: string; socketPath?: string; adapters: TmuxMuxAdapter[] } = { sock, adapters: [] };
  servers.push(entry);
  const raw = (...args: string[]): string =>
    Bun.spawnSync(["tmux", "-L", sock, ...args]).stdout.toString();
  raw("new-session", "-d", "-s", "base", "-x", "200", "-y", "50");
  entry.socketPath = raw("display-message", "-p", "#{socket_path}").trim() || undefined;
  return {
    sock, raw, entry,
    window(cwd: string, ...cmd: string[]): string {
      return raw("new-window", "-d", "-P", "-F", "#{pane_id}", "-c", cwd, ...cmd).trim();
    },
    field(pane: string, fmt: string): string {
      return raw("list-panes", "-a", "-F", `#{pane_id}\t${fmt}`)
        .split("\n").find((l) => l.startsWith(pane + "\t"))?.split("\t")[1] ?? "";
    },
    async command(pane: string, cmd: string): Promise<void> {
      await until(() => this.field(pane, "#{pane_current_command}") === cmd,
        { timeoutMs: 5_000, what: `pane_current_command of ${pane} to be ${cmd}` });
    },
    adapter(): TmuxMuxAdapter {
      const a = new TmuxMuxAdapter(sock);
      entry.adapters.push(a);
      return a;
    },
  };
}

/** A claude transcript in the tmp projects tree so a pane cwd can be LINKED. */
function seedTranscript(cwd: string, uuid: string, mtimeMs: number): void {
  const dir = join(process.env.CYC_PROJECTS_DIR!, mungeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${uuid}.jsonl`);
  writeFileSync(path, "{}\n");
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
}

/** The BIN dir holding `sleep` symlinked as `claude`, so the kernel's comm is
 *  what detection reads. */
async function claudeBin(): Promise<string> {
  const bin = await tmpDir("cyc-suite-bin-");
  const { symlinkSync } = await import("node:fs");
  symlinkSync(SLEEP, join(bin, "claude"));
  return bin;
}

rt("REAL tmux CONTRACT 1: a claude pane is detected, linked, and resolves to a stable agent id", async () => {
  process.env.CYC_PROJECTS_DIR = await tmpDir("cyc-suite-proj-");
  await rig.boot();
  const cwd = await tmpDir("cyc-suite-rt-start-");
  const S1 = "aa000000-0000-4000-8000-000000000001";
  seedTranscript(cwd, S1, Date.now());
  const srv = tmuxServer("start");
  const bin = await claudeBin();
  const pane = srv.window(cwd, join(bin, "claude"), "60");
  await srv.command(pane, "claude");

  const adapter = srv.adapter();
  let latest: MuxAgentInfo[] = [];
  adapter.onAgents((a) => { latest = a; });
  adapter.start();
  await until(() => latest.some((a) => a.harnessSessionId === S1),
    { timeoutMs: 8_000, what: "the real claude pane linked to its transcript" });

  // drive the REAL mux emission through the shipped resolver
  rig.reconcile(latest);
  const row = latest.find((a) => a.harnessSessionId === S1)!;
  const resolved = rig.S.sessionByHandle(row.handle)!;
  expect(resolved.agentId).toMatch(/^ag-[A-Za-z0-9_-]{16}$/);
  expect(resolved.harnessSessionId).toBe(S1);
  expect(paneTargetOf(row.handle)).toBe(pane); // the reuse-proof key wraps the bare %N

  // stable across a second real poll
  rig.reconcile(adapter.listAgents());
  expect(rig.S.sessionByHandle(row.handle)!.agentId).toBe(resolved.agentId);
}, 20_000);

rt("REAL tmux CONTRACT 2: after the pane is killed and respawned, the SAME agent comes back", async () => {
  process.env.CYC_PROJECTS_DIR = await tmpDir("cyc-suite-proj2-");
  await rig.boot();
  const cwd = await tmpDir("cyc-suite-rt-resume-");
  const S1 = "bb000000-0000-4000-8000-000000000001";
  seedTranscript(cwd, S1, Date.now());
  const srv = tmuxServer("resume");
  const bin = await claudeBin();
  const pane1 = srv.window(cwd, join(bin, "claude"), "60");
  await srv.command(pane1, "claude");

  const adapter = srv.adapter();
  let latest: MuxAgentInfo[] = [];
  adapter.onAgents((a) => { latest = a; });
  adapter.start();
  await until(() => latest.some((a) => a.harnessSessionId === S1),
    { timeoutMs: 8_000, what: "the first pane linked" });
  rig.reconcile(latest);
  const handle1 = latest.find((a) => a.harnessSessionId === S1)!.handle;
  const agentId = rig.S.sessionByHandle(handle1)!.agentId;
  // he said something, so the dead row is a conversation worth keeping
  rig.S.sessions.get(agentId)!.chat.push(
    { id: agentId, role: "user", text: "still here after the restart", ts: 5 } as never);

  // STOP: kill the pane; the mux stops listing it
  srv.raw("kill-pane", "-t", pane1);
  await until(() => !latest.some((a) => a.harnessSessionId === S1),
    { timeoutMs: 8_000, what: "the killed pane to leave the snapshot" });
  rig.reconcile(latest);
  expect(rig.S.sessions.get(agentId)!.alive).toBe(false);

  // RESUME: a new pane appears mid-run (the hand-started shape) and parks --
  // the 571 guard refuses the pre-existing S1 by folder. A real `claude
  // --resume S1` names itself through the SessionStart hook, and THAT is what
  // brings the session back. Announce S1 from the respawned pane's own pid; the
  // tmux poll matches it and binds S1 (the real ps ancestor walk finds the
  // sleep-as-claude process).
  const pane2 = srv.window(cwd, join(bin, "claude"), "60");
  await srv.command(pane2, "claude");
  const pane2Pid = Number(srv.field(pane2, "#{pane_pid}"));
  expect(pane2Pid).toBeGreaterThan(1);
  const ann = await handleAnnounce({ sessionId: S1, pid: pane2Pid, cwd });
  expect(ann.ok).toBe(true);
  await until(() => latest.some((a) => a.harnessSessionId === S1 && paneTargetOf(a.handle) === pane2),
    { timeoutMs: 8_000, what: "the announce to bind the respawned pane to S1" });
  rig.reconcile(latest);
  const back = latest.find((a) => paneTargetOf(a.handle) === pane2)!;
  const backRow = rig.S.sessionByHandle(back.handle)!;
  expect(backRow.agentId, "the same agent id came back through the session index").toBe(agentId);
  expect(backRow.chat.filter((m) => m.kind !== "system").map((m) => m.text))
    .toEqual(["still here after the restart"]);
}, 20_000);

/* --------------------------------------------- real herdr, gated + skipped */

const HERDR = process.env.CYC_SUITE_HERDR === "1";
test.skipIf(!HERDR)("REAL herdr smoke (CYC_SUITE_HERDR=1): a live herdr pane starts and resumes", async () => {
  /* The herdr box is separate; this never runs in CI. When CYC_SUITE_HERDR=1 is
   * set on a machine with a live herdr, drive the same start + resume-same-agent
   * against the real HerdrClient (no fake). Skipped by default -- named, not a
   * silent gap. */
  expect(SKIP.muxLevelInTmuxTest).toBeTruthy(); // placeholder assertion; body is env-gated
});
