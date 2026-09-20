/* STOP A PI-LANE ROW (personal adapter): the engine side of the agents-bar hand.
 *
 * The route POST /session-agents/<id>/stop is gated on CYC_PIAGENT_ADAPTER, finds
 * the run by agentId in the session's parsed runs (only a pi-lane, never a
 * subagent), and kills the live pi-run process GROUP found by the recorded launch
 * task. The route itself boots the whole server, so these prove the pieces it
 * composes: the gate, the find, the launch-command carry, and the /proc kill.
 *
 * THE ONE PLACE THIS TIER SPAWNS. killPiRunByTask's whole subject is reading
 * /proc and signalling a process group; there is no seam under it and a fake
 * would prove nothing, so the kill test starts two detached `bash` processes of
 * its own and reaps them in afterEach. Nothing else here touches a process.
 *
 *   bun test agent-engine/src/adapters/agentstop.test.ts
 */

import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAgentRuns, registerRunEnricher, type AgentRun } from "../sessions/session-events.ts";
import { piAdapterEnabled, piTaskText, piRunByAgentId, killPiRunByTask,
  piLaneFromToolUse, enrichPiRuns } from "./piagent.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";

// recent, since the parser sweeps runs left open for four hours as phantoms.
let stamp = Date.now() - 20 * 60_000;
const at = () => new Date((stamp += 60_000)).toISOString();

const ROOT = await tmpDir("cyc-stop-");
let nth = 0;
function jsonl(records: any[]): string {
  const p = join(ROOT, `session-${nth++}.jsonl`);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

const piLaunch = (id: string, cmd: string) => ({
  type: "assistant", timestamp: at(),
  message: { content: [{ type: "tool_use", id, name: "Bash",
    input: { command: cmd, run_in_background: true } }] },
});
const piLaunched = (toolUseId: string, taskId: string) => ({
  type: "user", timestamp: at(),
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId,
    content: `Command running in the background. Task ID: ${taskId}` }] },
});

// A detached process in its OWN group, like a real background pi-run launch,
// carrying the task verbatim in its argv so /proc/<pid>/cmdline contains it. The
// `sleep` child shares bash's group, so killing the group must take both.
// (`sleep 30; :` keeps bash resident: a single-command `-c` gets exec-optimized
// away, which would drop the positional args this test needs on the argv.)
const spawned: { child: ChildProcess; detached: boolean }[] = [];
function fakePiRun(task: string, detached = true): ChildProcess {
  const child = spawn("bash", ["-c", "sleep 30; :", "pi-run-fake", task],
    { detached, stdio: "ignore" });
  child.unref();
  spawned.push({ child, detached });
  return child;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Whether any live process's argv carries this task. The scan killPiRunByTask
 *  itself does, used to WAIT for the fake runs to appear rather than sleeping a
 *  guessed 400ms. */
async function inProc(task: string): Promise<boolean> {
  for (const pid of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(pid)) continue;
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (cmdline && cmdline.replace(/\0/g, " ").includes(task)) return true;
  }
  return false;
}

afterEach(() => {
  for (const { child, detached } of spawned) {
    if (!child.pid) continue;
    /* A detached run leads its own group and takes its `sleep` child with it. An
     * undetached one is in OUR group, so it is signalled by pid alone: killing
     * the group would be killing ourselves. */
    if (detached) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    try { process.kill(child.pid, "SIGKILL"); } catch {}
  }
  spawned.length = 0;
  registerRunEnricher(null); // undo any enricher a test registered (adapter inversion)
});

test("the gate is off unless CYC_PIAGENT_ADAPTER=1 (the route 404s with it unset)", () => {
  /* piAdapterEnabled reads process.env on EVERY call and caches nothing, which
   * is what makes this scoped set/restore safe: no module captured the value at
   * import, so nothing outside this test can see it. */
  const saved = process.env.CYC_PIAGENT_ADAPTER;
  try {
    delete process.env.CYC_PIAGENT_ADAPTER;
    expect(piAdapterEnabled()).toBe(false);
    // exactly "1": a truthy-looking value is not the flag
    for (const v of ["", "0", "true", "yes", "01", " 1"]) {
      process.env.CYC_PIAGENT_ADAPTER = v;
      expect(piAdapterEnabled()).toBe(false);
    }
    process.env.CYC_PIAGENT_ADAPTER = "1";
    expect(piAdapterEnabled()).toBe(true);
  } finally {
    if (saved === undefined) delete process.env.CYC_PIAGENT_ADAPTER;
    else process.env.CYC_PIAGENT_ADAPTER = saved;
  }
});

test("a pi-lane run carries its launch command, and piTaskText reads the task", async () => {
  // The inversion: readAgentRuns recognizes pi lanes only through a
  // registered enricher, exactly what the composition root registers behind the
  // flag. This unit test bypasses the root, so register it here.
  registerRunEnricher({ fromToolUse: piLaneFromToolUse, enrichRuns: enrichPiRuns });
  const task = "verify the corpus proof";
  const cmd = `cd /wt && /home/user/bin/pi-run --provider grok --model grok-4.6 -p "${task}"`;
  const runs = await readAgentRuns(jsonl([
    piLaunch("toolu_1", cmd),
    piLaunched("toolu_1", "wq7ftz3k2"),
  ]));
  const run = runs.find((r) => r.source === "pi");
  expect(run?.command).toBe(cmd);
  expect(piTaskText(run!.command!)).toBe(task);
});

test("piRunByAgentId finds only pi runs; a subagent id or an unknown id is null (404)", () => {
  const runs: AgentRun[] = [
    { toolUseId: "t1", agentId: "pi-1", ts: 0, desc: "", endedTs: null, tokens: null,
      source: "pi", command: 'pi-run -p "x"' },
    { toolUseId: "t2", agentId: "sub-1", ts: 0, desc: "", endedTs: null, tokens: null },
  ];
  expect(piRunByAgentId(runs, "pi-1")?.agentId).toBe("pi-1");
  expect(piRunByAgentId(runs, "sub-1"), "never touch a non-pi run").toBeNull();
  expect(piRunByAgentId(runs, "nope"), "unknown agentId is a 404").toBeNull();
});

test("piRunByAgentId refuses an empty id rather than matching an unstarted lane", () => {
  /* A lane that has not reported its Task ID yet has agentId:null. An empty id
   * off the wire must not fall through and match it, or the stop button on one
   * row would kill a different, still-starting lane. */
  const runs: AgentRun[] = [
    { toolUseId: "t1", agentId: null, ts: 0, desc: "", endedTs: null, tokens: null,
      source: "pi", command: 'pi-run -p "x"' },
  ];
  expect(piRunByAgentId(runs, "")).toBeNull();
  expect(piRunByAgentId([], "pi-1")).toBeNull();
});

test("piRunByAgentId returns the first pi run with that id and nothing else", () => {
  const runs: AgentRun[] = [
    { toolUseId: "t0", agentId: "dup", ts: 0, desc: "", endedTs: null, tokens: null },
    { toolUseId: "t1", agentId: "dup", ts: 0, desc: "", endedTs: null, tokens: null,
      source: "pi", command: 'pi-run -p "a"' },
  ];
  // the non-pi row shares the id and comes first; the finder must skip it
  expect(piRunByAgentId(runs, "dup")?.toolUseId).toBe("t1");
});

test("killPiRunByTask kills only the matched pi run's group, and 'not running' otherwise", async () => {
  const tag = Math.random().toString(36).slice(2);
  const taskA = `verify the corpus proof ${tag}`;
  const taskB = `design the schematics ${tag}`;
  const a = fakePiRun(taskA);
  const b = fakePiRun(taskB);
  // wait for the real thing the kill reads (the argv in /proc), not a guessed
  // number of milliseconds
  await until(async () => (await inProc(taskA)) && (await inProc(taskB)),
    { what: "both fake pi runs to appear in /proc" });

  expect(await killPiRunByTask(taskA), "the matched pi run was not killed").toBe(true);
  await until(() => !alive(a.pid!), { what: "the matched run's group to die" });
  expect(alive(a.pid!), "the matched run's group survived the kill").toBe(false);
  expect(alive(b.pid!), "an unmatched pi run was killed too").toBe(true);

  // no live process carries this task: the route answers {ok:false,error:'not running'}
  expect(await killPiRunByTask(`no such task ${tag}`), "a dead/absent task must not report a kill")
    .toBe(false);
  // an empty task (a run with no recorded command) never sweeps a pattern
  expect(await killPiRunByTask(""), "an empty task must match nothing").toBe(false);
});

test("killPiRunByTask matches the task EXACTLY, never as a loose prefix", async () => {
  /* The task rides on argv verbatim and the match is a substring of that argv,
   * so a stop on one lane must not take a sibling whose task merely starts the
   * same way. Only the longer task's process carries the longer string. */
  const tag = Math.random().toString(36).slice(2);
  const short = `ship the fix ${tag}`;
  const long = `${short} and the docs too`;
  const shortRun = fakePiRun(short);
  const longRun = fakePiRun(long);
  await until(async () => (await inProc(short)) && (await inProc(long)),
    { what: "both fake pi runs to appear in /proc" });

  expect(await killPiRunByTask(long)).toBe(true);
  await until(() => !alive(longRun.pid!), { what: "the longer task's group to die" });
  expect(alive(shortRun.pid!), "the shorter task's run was taken too").toBe(true);
});

test("killPiRunByTask never signals this engine's own process group", async () => {
  /* The guard that matters most: a task word that happened to land in this
   * engine's own argv would otherwise make it kill itself, taking every session
   * with it. The fake run here is spawned UNDETACHED, so it sits in this
   * process's group; the scan finds its cmdline, resolves its pgrp to ours, and
   * must skip it. Nothing is signalled and everything is still alive after.
   *
   * (Deliberately NOT done by passing a string off this process's own argv:
   * under `bun test --parallel` the workers do not share the runner's group,
   * so such a test would SIGTERM the test runner itself. Measured.) */
  const tag = Math.random().toString(36).slice(2);
  const task = `in our own group ${tag}`;
  const ours = fakePiRun(task, false);
  await until(() => inProc(task), { what: "the in-group fake run to appear in /proc" });

  expect(await killPiRunByTask(task), "the engine signalled its own group").toBe(false);
  expect(alive(ours.pid!), "the in-group run was killed anyway").toBe(true);
  expect(alive(process.pid)).toBe(true);
});

test("killPiRunByTask on a task nobody is running is false, not a throw", async () => {
  expect(await killPiRunByTask(`nothing-anywhere-${Math.random().toString(36).slice(2)}`)).toBe(false);
});
