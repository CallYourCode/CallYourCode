/* Durable running intent is separate from pane bindings and chat metadata.
 * Neither of those means 'was running at power loss'. Only a successful poll
 * of the SAME boot/server can turn running intent into a deliberate stop. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "../storage/datadir.ts";
import { rpc, socketPath } from "../terminal/herdr.ts";
import { hookBindFor, hookAnnouncementVersion } from "../terminal/hook-announce.ts";
import type { MultiplexerAdapter } from "../adapters/mux-adapter.ts";
import { withAgentEnv } from "../runtime/agent-env.ts";
import { isHarnessSessionId } from "../runtime/ids.ts";
import { agentIdOfProc } from "../runtime/agents.ts";
import { sessions } from "./session-state.ts";
import { bindSpawnedPane } from "./carry.ts";
import { claimLaunch, waitForLaunch } from "./launch-claims.ts";

export type Incarnation = { bootId: string; herdrInstance: string };
export type RunningAgent = Incarnation & {
  agentId: string; running: boolean; paneId: string; workspace: string;
  cwd: string; harness: string; sessionId: string | null; attempted?: Incarnation;
};
export type RestorablePane = { paneId: string; cwd: string; shell: boolean; busy: boolean };
type Decision = { action: "skip" | "pane" | "reopen"; reason: string };
const same = (a: Incarnation, b: Incarnation) => a.bootId === b.bootId && a.herdrInstance === b.herdrInstance;
export function restoreDecision(r: RunningAgent, now: Incarnation, pane: RestorablePane | null, duplicate: boolean): Decision {
  if (!r.running) return { action: "skip", reason: "stopped" };
  if (same(r, now)) return { action: "skip", reason: "same-instance" };
  if (r.attempted && same(r.attempted, now)) return { action: "skip", reason: "already-attempted" };
  if (duplicate) return { action: "skip", reason: "duplicate" };
  if (!r.sessionId || !isHarnessSessionId(r.sessionId)) return { action: "skip", reason: "no-session-id" };
  if (!pane) return { action: "reopen", reason: "pane-missing" };
  if (pane.busy || !pane.shell) return { action: "skip", reason: "busy" };
  if (pane.cwd !== r.cwd) return { action: "reopen", reason: "cwd-changed" };
  return { action: "pane", reason: "shell-ready" };
}

type RawPane = { pane_id: string; workspace_id: string; cwd?: string; foreground_cwd?: string; agent?: string; launch_pending?: boolean; agent_session?: { value: string } };
type Snapshot = { agents: RawPane[]; panes: RawPane[] };
type Log = (event: string, fields: Record<string, unknown>) => void;

/** The socket inode + nanosecond birth stamp is server-owned, stable
 * across engine deploys and replaced when herdr binds a new listening socket.
 * Unlike a PID it also distinguishes container PID-namespace restarts. */
export function incarnation(): Incarnation {
  const st = statSync(socketPath(), { bigint: true });
  return { bootId: readFileSync(process.env.CYC_BOOT_ID_FILE ?? "/proc/sys/kernel/random/boot_id", "utf8").trim(),
    herdrInstance: `${st.dev}:${st.ino}:${st.birthtimeNs || st.ctimeNs}` };
}
async function snapshot(): Promise<{ now: Incarnation; snap: Snapshot }> {
  const before = incarnation();
  const result = await rpc("session.snapshot", {});
  const now = incarnation();
  if (!same(before, now)) throw new Error("herdr changed while reading snapshot");
  if (!Array.isArray(result?.snapshot?.panes) || !Array.isArray(result?.snapshot?.agents)) throw new Error("invalid herdr snapshot");
  return { now, snap: result.snapshot };
}
export function shellProcess(info: { shell_pid?: number; foreground_processes?: Array<{ pid: number; name: string }> }): boolean {
  const ps = info.foreground_processes;
  return !!info.shell_pid && ps?.length === 1 && ps[0]!.pid === info.shell_pid && /^(?:zsh|bash|fish|sh|dash|ksh|nu)$/.test(ps[0]!.name);
}
async function paneState(p: RawPane): Promise<RestorablePane> {
  const res = await rpc("pane.process_info", { pane_id: p.pane_id });
  const shell = shellProcess(res?.process_info ?? {});
  const cwd = res?.process_info?.foreground_processes?.[0]?.cwd ?? p.foreground_cwd ?? p.cwd ?? "";
  return { paneId: p.pane_id, cwd, shell, busy: !shell || p.launch_pending === true };
}

/* fsync both file and directory: atomic rename alone protects an engine crash,
 * not a loss of power before the filesystem has committed the new intent. */
function persist(path: string, rows: RunningAgent[]): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify({ version: 1, agents: rows }) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(tmp, path);
  const d = openSync(dir, "r");
  try { fsyncSync(d); } finally { closeSync(d); }
}
function load(path: string): RunningAgent[] {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const value = JSON.parse(text);
  if (value.version !== 1 || !Array.isArray(value.agents)) throw new Error("invalid running intent file");
  for (const r of value.agents) {
    if (!/^ag-[A-Za-z0-9_-]{16}$/.test(r.agentId) || typeof r.running !== "boolean" ||
        !["paneId", "workspace", "cwd", "harness", "bootId", "herdrInstance"].every((k) => typeof r[k] === "string") ||
        !(r.sessionId === null || isHarnessSessionId(r.sessionId))) throw new Error("invalid running agent record");
  }
  return value.agents;
}
async function duplicate(r: RunningAgent, snap: Snapshot): Promise<boolean> {
  for (const p of snap.panes) {
    const sid = p.agent_session?.value ?? hookBindFor(p.pane_id)?.sessionId;
    const s = [...sessions.values()].find((s) => s.alive && s.muxHandle === p.pane_id);
    const matches = sid === r.sessionId || s?.agentId === r.agentId || s?.harnessSessionId === r.sessionId;
    if (p.launch_pending && matches) return true; // herdr's own resume already owns it
    const sameCwd = (p.foreground_cwd ?? p.cwd) === r.cwd;
    if (p.agent) {
      if (matches) return true;
      // An agent still starting in the same folder is not proof of absence.
      if (!sid && p.agent === r.harness && sameCwd) return true;
    } else if (matches || sameCwd) {
      // Herdr can lag classification. Check the actual foreground processes,
      // including unstamped panes, but never treat a stale shell bind as live.
      const res = await rpc("pane.process_info", { pane_id: p.pane_id });
      const info = res?.process_info;
      if (!info) throw new Error(`cannot rule out a duplicate in ${p.pane_id}`);
      if (shellProcess(info)) continue;
      if (matches || (sameCwd && info.foreground_processes?.some((p: { name?: string; cmdline?: string }) => agentIdOfProc(p.name ?? "", p.cmdline ?? "") === r.harness))) return true;
    }
  }
  return false;
}

export function startAutoRestore(deps: {
  adapter: MultiplexerAdapter; log: Log; notify(body: string): Promise<unknown>;
}): void {
  const log: Log = (event, fields) => { console.log(`[${event}] ${JSON.stringify(fields)}`); deps.log(event, fields); };
  const path = join(dataDir(), "state", "running-agents.json");
  let rows: RunningAgent[];
  try { rows = load(path); } catch (e) {
    log("restore.disabled", { error: String(e) });
    void deps.notify(`Restored 0 agents. Recovery state could not be read: ${String(e)}`).catch(() => {});
    return;
  }
  let observing = false;
  let active = false;
  const save = () => persist(path, rows);

  const launching = new Set<string>();
  async function observe(): Promise<void> {
    if (!observing || active) return;
    active = true;
    const observed = rows.map((r) => ({ ...r }));
    const version = new Map(observed.map((r) => [r.agentId, JSON.stringify(r)]));
    try {
      const { now, snap } = await snapshot();
      const updates = new Map<string, RunningAgent>();
      for (const s of sessions.values()) {
        if (!s.alive || !s.viaMux || launching.has(s.agentId)) continue;
        const p = snap.agents.find((p) => p.pane_id === s.muxHandle && p.agent);
        if (!p) continue;
        updates.set(s.agentId, { agentId: s.agentId, running: true, paneId: s.muxHandle,
          workspace: p.workspace_id, cwd: s.cwd, harness: s.agent.id, sessionId: s.harnessSessionId, ...now });
      }
      for (const r of observed) {
        if (!r.running || !same(r, now) || launching.has(r.agentId)) continue;
        if (snap.agents.some((p) => p.pane_id === r.paneId && p.agent)) continue;
        const p = snap.panes.find((p) => p.pane_id === r.paneId);
        // Positive process evidence, not a temporarily absent agent stamp.
        if (p && !(await paneState(p)).shell) continue;
        updates.set(r.agentId, { ...r, running: false });
      }
      if (!same(now, incarnation())) throw new Error("herdr changed during observation");
      const changes: Array<{ row: RunningAgent; before: RunningAgent | null }> = [];
      for (const update of updates.values()) {
        if (launching.has(update.agentId)) continue;
        const row = rows.find((r) => r.agentId === update.agentId);
        // Recovery may have advanced this row while the process checks awaited.
        // Never overwrite a newer launch/attempt with an older observation.
        if (JSON.stringify(row) !== version.get(update.agentId)) continue;
        const next = { ...row, ...update };
        if (JSON.stringify(next) === JSON.stringify(row)) continue;
        if (row) { changes.push({ row, before: { ...row } }); Object.assign(row, next); }
        else { rows.push(next); changes.push({ row: next, before: null }); }
      }
      if (changes.length) {
        try { save(); } catch (e) {
          for (const change of changes) {
            if (change.before) Object.assign(change.row, change.before);
            else rows.splice(rows.indexOf(change.row), 1);
          }
          throw e;
        }
        for (const { row } of changes) log(row.running ? "restore.running" : "restore.stopped", {
          agentId: row.agentId, paneId: row.paneId, sessionId: row.sessionId,
        });
      }
    } catch (e) { log("restore.observe-failed", { error: String(e) }); }
    finally { active = false; }
  }

  async function recover(): Promise<void> {
    let ready: Awaited<ReturnType<typeof snapshot>> | undefined;
    const deadline = Date.now() + 30_000;
    do {
      try { ready = await snapshot(); break; } catch { await Bun.sleep(500); }
    } while (Date.now() < deadline);
    if (!ready) {
      log("restore.unavailable", { reason: "herdr did not answer within 30s" });
      await deps.notify("Restored 0 agents. Recovery failed: herdr did not answer within 30s.");
      return;
    }
    const epoch = ready.now;
    // Keep recording deliberate exits even during a long sequential recovery.
    // Old-incarnation shells cannot mark an agent stopped; in-flight rows are
    // excluded, and the observation version check protects their later commit.
    observing = true;
    deps.adapter.onAgents(() => void observe());
    const timer = setInterval(() => void observe(), 1000);
    timer.unref();
    let restored = 0, candidates = 0;
    const failures: string[] = [];
    for (const r of rows) {
      // Log every decision, but never consume an attempt on a normal deploy.
      const early = restoreDecision(r, epoch, null, false);
      if (["stopped", "same-instance", "already-attempted"].includes(early.reason)) {
        log("restore.skip", { agentId: r.agentId, reason: early.reason }); continue;
      }
      candidates++;
      r.attempted = epoch;
      save(); // claim durably BEFORE any external action, including failures
      const release = claimLaunch(r.agentId, r.sessionId);
      launching.add(r.agentId);
      try {
        if (!release) throw new Error("concurrent app reopen owns this agent or session");
        const { now, snap } = await snapshot();
        if (!same(epoch, now)) throw new Error("herdr changed during recovery");
        const raw = snap.panes.find((p) => p.pane_id === r.paneId);
        const pane = raw ? await paneState(raw) : null;
        // The attempt has just been claimed; decide against its prior value.
        const decision = restoreDecision({ ...r, attempted: undefined }, now, pane, await duplicate(r, snap));
        log(`restore.${decision.action}`, { agentId: r.agentId, paneId: r.paneId, reason: decision.reason });
        if (decision.action === "skip") throw new Error(decision.reason);
        const command = r.sessionId ? deps.adapter.resumeCommand(r.harness, r.sessionId) : null;
        if (!command) throw new Error(`no exact resume command for ${r.harness}`);
        if (!same(epoch, incarnation())) throw new Error("herdr changed before launch");
        if (decision.action === "pane") bindSpawnedPane(r.paneId, r.agentId);
        log("restore.launch", { agentId: r.agentId, paneId: r.paneId, sessionId: r.sessionId, mode: decision.action });
        const launchedAfter = hookAnnouncementVersion();
        const { handle } = await deps.adapter.spawn({ cwd: r.cwd, command: withAgentEnv(command, r.agentId),
          workspaceId: r.workspace, ...(decision.action === "pane" ? { existingHandle: r.paneId } : {}) });
        bindSpawnedPane(handle, r.agentId);
        await waitForLaunch(r.agentId, r.sessionId, handle, 60_000, launchedAfter);
        if (!same(epoch, incarnation())) throw new Error("herdr changed while waiting for announce");
        r.paneId = handle;
        Object.assign(r, epoch);
        save();
        restored++;
        log("restore.detected", { agentId: r.agentId, paneId: handle, sessionId: r.sessionId });
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        failures.push(`${r.agentId}: ${why}`);
        log("restore.failed", { agentId: r.agentId, paneId: r.paneId, reason: why });
      } finally { launching.delete(r.agentId); release?.(); }
    }
    log("restore.summary", { restored, candidates, failures });
    if (candidates) await deps.notify(`Restored ${restored} agents.${failures.length ? `\n${failures.join("\n")}` : ""}`);
    await observe();
  }
  void recover().catch((e) => {
    log("restore.disabled", { error: String(e) });
    void deps.notify(`Agent recovery aborted: ${String(e)}`).catch(() => {});
  });
}
