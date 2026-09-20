/* PERSONAL ADAPTER proof (agent-engine/src/adapters/piagent.ts).
 *
 * A background pi-run Bash launch + its matching <task-notification> must
 * become ONE AgentRun tagged source:"pi" with the model label and the closing
 * ts/tokens -- but only when CYC_PIAGENT_ADAPTER=1. With the flag off the same
 * transcript emits NOTHING, so the vanilla engine is byte-identical.
 */

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAgentRuns, registerRunEnricher } from "../sessions/session-events.ts";
import { modelLabel, piTaskText, piLaneFromToolUse, enrichPiRuns } from "./piagent.ts";
import { tmpDir } from "../test-utils/tmp.ts";

/* The adapter inversion: readAgentRuns recognizes pi lanes ONLY
 * through a registered enricher, never by reading the env itself. The
 * composition root registers one behind CYC_PIAGENT_ADAPTER; these unit tests
 * bypass the root, so enablePi() does the same registration the root does.
 *
 * NOTE THAT THIS FILE SETS NO ENV AT ALL. It used to set CYC_PIAGENT_ADAPTER
 * here, which proved nothing: the parser reads the enricher, never the flag.
 * The flag itself is proven where it is actually read, in agentstop.test.ts. */
function enablePi(): void {
  registerRunEnricher({ fromToolUse: piLaneFromToolUse, enrichRuns: enrichPiRuns });
}

// recent, since the parser sweeps runs left open for four hours as phantoms.
let stamp = Date.now() - 20 * 60_000;
const at = () => new Date((stamp += 60_000)).toISOString();

const ROOT = await tmpDir("cyc-pi-");
let nth = 0;
function jsonl(records: any[]): string {
  const p = join(ROOT, `session-${nth++}.jsonl`);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

// a background Bash launching a pi-lane
const piLaunch = (id: string, cmd: string) => ({
  type: "assistant", timestamp: at(),
  message: { content: [{ type: "tool_use", id, name: "Bash",
    input: { command: cmd, run_in_background: true } }] },
});

// the launch result: same shape as any background agent (Task ID: <id>)
const piLaunched = (toolUseId: string, taskId: string) => ({
  type: "user", timestamp: at(),
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId,
    content: `Command running in the background. Task ID: ${taskId}` }] },
});

const done = (taskId: string, tokens: number) => ({
  type: "user", timestamp: at(),
  message: { content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<usage><subagent_tokens>${tokens}</subagent_tokens></usage>\n</task-notification>` },
});

// a normal background build must NOT become a pi row
const plainBash = (id: string, taskId: string) => [
  { type: "assistant", timestamp: at(),
    message: { content: [{ type: "tool_use", id, name: "Bash",
      input: { command: "bun build agent-engine/src/runtime/server.ts --target bun", run_in_background: true } }] } },
  { type: "user", timestamp: at(),
    message: { content: [{ type: "tool_result", tool_use_id: id,
      content: `Command running in the background. Task ID: ${taskId}` }] } },
];

/* The registry is module state shared by every test in this file, so it is
 * dropped after each one: a leftover enricher would make the "flag OFF" test
 * (which proves the vanilla engine is byte-identical) pass for the wrong
 * reason, or fail depending on order. */
afterEach(() => { registerRunEnricher(null); });

test("modelLabel folds provider and model to one badge", () => {
  expect(modelLabel("grok", "grok-4.6")).toBe("grok-4.6");
  expect(modelLabel("opus", "4.8")).toBe("opus 4.8");
  expect(modelLabel("", "grok-4.6")).toBe("grok-4.6");
  expect(modelLabel("claude-bridge", "claude-opus-4-8")).toBe("opus 4.8");
  expect(modelLabel("anthropic", "claude-opus-4-8")).toBe("opus 4.8");
  expect(modelLabel("opencode-go", "kimi-k3")).toBe("kimi-k3");
});

test("modelLabel degrades to whichever half it has", () => {
  // the badge is chrome: it must never be empty-looking or say "undefined"
  expect(modelLabel("", "")).toBe("");
  expect(modelLabel("grok", "")).toBe("grok");
  expect(modelLabel("  grok  ", "  grok-4.6  ")).toBe("grok-4.6"); // trimmed both sides
  // the provider adds nothing once the model already spells its family out
  expect(modelLabel("GROK", "grok-4.6")).toBe("grok-4.6");
  // a claude-family model under a non-claude provider keeps both, because the
  // provider is then telling you something (which bridge ran it)
  expect(modelLabel("bedrock", "claude-opus-4-8")).toBe("bedrock claude-opus-4-8");
});

test("piTaskText takes the LONGEST quoted string, which is the -p argument", () => {
  /* The stop route matches this verbatim against a live process's cmdline, so a
   * shorter incidental quote (a redirect target, a grep pattern) winning here
   * would make stop silently kill nothing. */
  const cmd = `cd /wt && pi-run --provider grok -p "verify the corpus proof end to end" > "$SP/lane.log"`;
  expect(piTaskText(cmd)).toBe("verify the corpus proof end to end");
  expect(piTaskText(`pi-run -p 'single quoted task here'`)).toBe("single quoted task here");
  expect(piTaskText("pi-run --provider grok")).toBe("");   // nothing quoted at all
  expect(piTaskText("")).toBe("");
});

test("piLaneFromToolUse refuses everything that is not a background pi launch", () => {
  // the direct unit, with no transcript in the way: each guard on its own
  const ts = Date.now();
  const bash = (input: unknown) => ({ id: "t1", name: "Bash", input });
  expect(piLaneFromToolUse({ id: "t1", name: "Task", input: {} }, ts)).toBeNull();
  expect(piLaneFromToolUse(bash({ command: "pi-run -p 'x'" }), ts)).toBeNull(); // not background
  expect(piLaneFromToolUse(bash({ command: "pi-run -p 'x'", run_in_background: "yes" }), ts)).toBeNull();
  expect(piLaneFromToolUse(bash({ run_in_background: true }), ts)).toBeNull();  // no command
  expect(piLaneFromToolUse(bash({ command: 42, run_in_background: true }), ts)).toBeNull();
  expect(piLaneFromToolUse(null, ts)).toBeNull();
  expect(piLaneFromToolUse(undefined, ts)).toBeNull();
});

test("the row carries the raw launch command, which is the only handle stop has", () => {
  // pi-run writes no pidfile; the recorded command is what the stop route reads
  // the task out of, so it must ride UNTOUCHED and uncapped
  const cmd = `/home/user/bin/pi-run --provider grok --model grok-4.6 -p "${"a task ".repeat(30).trim()}"`;
  const run = piLaneFromToolUse({ id: "t1", name: "Bash", input: { command: cmd, run_in_background: true } }, 1)!;
  expect(run.command).toBe(cmd);
  expect(run.toolUseId).toBe("t1");
  expect(run.agentId).toBeNull();   // filled later, from the launch result
  expect(run.endedTs).toBeNull();
});

test("a long task is truncated for the ROW, with an ellipsis so it reads as cut", () => {
  // eight words is the word cap, so the LENGTH cap only bites on long words
  const cmd = `pi-run --provider grok --model grok-4.6 -p "${"averyverylongwordindeed ".repeat(8).trim()}"`;
  const run = piLaneFromToolUse({ id: "t1", name: "Bash", input: { command: cmd, run_in_background: true } }, 1)!;
  expect(run.desc.length).toBeLessThanOrEqual(81); // DESC_CAP + the ellipsis
  expect(run.desc.endsWith("…")).toBe(true);
});

test("a lane with nothing to describe still gets a name", () => {
  // no --provider, no --model, no quoted task: the row must say SOMETHING, or
  // the agents bar draws a blank chip
  const run = piLaneFromToolUse(
    { id: "t1", name: "Bash", input: { command: "/home/user/bin/pi-run", run_in_background: true } }, 1)!;
  expect(run.desc).toBe("pi-lane");
  expect(run.model).toBeUndefined();
});

test("--flag=value is read the same as --flag value", () => {
  const run = piLaneFromToolUse({ id: "t1", name: "Bash",
    input: { command: `pi-run --provider=grok --model="grok-4.6" -p "do it"`, run_in_background: true } }, 1)!;
  expect(run.model).toBe("grok-4.6");
});

test("leading env assignments do not hide the program that was invoked", () => {
  // `VOICE_URL=... pi-run ...` is a real launch shape; reading the first token
  // literally would see the assignment and refuse the lane
  const run = piLaneFromToolUse({ id: "t1", name: "Bash",
    input: { command: `FOO=1 BAR=2 /home/user/bin/pi-run --provider grok -p "x"`, run_in_background: true } }, 1);
  expect(run?.source).toBe("pi");
});

test("a pi-run mentioned as an ARGUMENT is not the invoked program", () => {
  /* The discriminator is anchored to the program, not to the string. These are
   * the shapes that used to light up the agents bar with phantom lanes. */
  for (const cmd of [
    "grep -r pi-run .", "echo /home/user/bin/pi-run", "cd /wt && cat pi-run",
    "vim pi-workflow", "./pi-runner --go", "pi-run-history --tail",
  ]) {
    expect(piLaneFromToolUse({ id: "t1", name: "Bash", input: { command: cmd, run_in_background: true } }, 1)).toBeNull();
  }
});

test("a Bash background launch keeps the pi-lane OPEN until its notification", async () => {
  enablePi();
  // the EXACT phrase a Bash background launch emits: no "the", id behind "ID:"
  const bgResult = (toolUseId: string, id: string) => ({
    type: "user", timestamp: at(),
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId,
      content: `Command running in background with ID: ${id}. Output is being written to: /tmp/out.log` }] },
  });

  // OPEN: launch + Bash-background result, notification not yet in the file
  let runs = await readAgentRuns(jsonl([
    piLaunch("toolu_bg", `/home/user/bin/pi-run --provider claude-bridge --model claude-opus-4-8 "ship it"`),
    bgResult("toolu_bg", "bc3sb0bg4"),
  ]));
  expect(runs.length).toBe(1);
  expect(runs[0].source).toBe("pi");
  expect(runs[0].agentId).toBe("bc3sb0bg4");
  expect(runs[0].endedTs).toBeNull();          // still RUNNING
  expect(runs[0].model).toBe("opus 4.8");       // shortened label

  // CLOSED: the matching notification arrives with tokens
  runs = await readAgentRuns(jsonl([
    piLaunch("toolu_bg", `/home/user/bin/pi-run --provider claude-bridge --model claude-opus-4-8 "ship it"`),
    bgResult("toolu_bg", "bc3sb0bg4"),
    done("bc3sb0bg4", 42_000),
  ]));
  expect(runs.length).toBe(1);
  expect(runs[0].endedTs).not.toBeNull();
  expect(runs[0].tokens).toBe("42k");
});

test("with the flag ON a background pi-run is one pi-tagged AgentRun", async () => {
  enablePi();
  const runs = await readAgentRuns(jsonl([
    piLaunch("toolu_pi", `/home/user/bin/pi-run --provider grok --model grok-4.6 "verify the corpus proof end to end"`),
    piLaunched("toolu_pi", "wq7ftz3k2"),
    done("wq7ftz3k2", 217_000),
  ]));

  expect(runs.length).toBe(1);
  const r = runs[0];
  expect(r.source).toBe("pi");
  expect(r.model).toBe("grok-4.6");
  expect(r.desc).toContain("grok-4.6");
  expect(r.desc).toContain("verify the corpus proof");
  expect(r.agentId).toBe("wq7ftz3k2"); // captured from Task ID:
  expect(r.endedTs).not.toBeNull();     // closed by its notification
  expect(r.tokens).toBe("217k");
});

test("with the flag OFF the same transcript emits nothing", async () => {
  // flag unset (afterEach deletes it)
  const runs = await readAgentRuns(jsonl([
    piLaunch("toolu_pi", `/home/user/bin/pi-run --provider grok --model grok-4.6 "verify the corpus proof end to end"`),
    piLaunched("toolu_pi", "wq7ftz3k2"),
    done("wq7ftz3k2", 217_000),
  ]));
  expect(runs.length).toBe(0);
});

test("a plain background build is never a pi row, even with the flag ON", async () => {
  enablePi();
  const runs = await readAgentRuns(jsonl([
    ...plainBash("toolu_build", "bd1122334455"),
  ]));
  expect(runs.length).toBe(0);
});

// a Bash launch with an arbitrary command + background flag
const bgLaunch = (id: string, cmd: string, bg: boolean) => ({
  type: "assistant", timestamp: at(),
  message: { content: [{ type: "tool_use", id, name: "Bash",
    input: { command: cmd, run_in_background: bg } }] },
});

test("strings that merely CONTAIN pi-run/pi-workflow are never a pi row (flag ON)", async () => {
  enablePi();
  const negatives = [
    "grep pi-run foo.log",
    "echo pi-workflow done",
    "git log --grep=pi-run",
    "less pi-workflow.md",
    "cat /home/user/state/pi-run-history.jsonl",
  ];
  let total = 0;
  for (const cmd of negatives) {
    const runs = await readAgentRuns(jsonl([bgLaunch("toolu_neg", cmd, true)]));
    total += runs.length;
  }
  expect(total).toBe(0);
});

test("a FOREGROUND pi-run is not a lane (flag ON)", async () => {
  enablePi();
  const runs = await readAgentRuns(jsonl([
    bgLaunch("toolu_fg", `/home/user/bin/pi-run --provider grok --model grok-4.6 "do it"`, false),
  ]));
  expect(runs.length).toBe(0);
});

test("the real launch shape (cd + export + /home/user/bin/pi-run, background) is ONE pi row", async () => {
  enablePi();
  const cmd = `cd /home/x/wt && export VOICE_URL=http://127.0.0.1:1 && /home/user/bin/pi-run --provider grok --model grok-4.6 "verify the corpus proof end to end"`;
  const runs = await readAgentRuns(jsonl([
    piLaunch("toolu_real", cmd),
    piLaunched("toolu_real", "real12345"),
  ]));
  expect(runs.length).toBe(1);
  expect(runs[0].source).toBe("pi");
  expect(runs[0].model).toBe("grok-4.6");
});

test("the real backslash line-continuation shape (opus lane, background) is ONE pi row", async () => {
  enablePi();
  const cmd = `cd /home/x/wt && export VOICE_URL=http://127.0.0.1:1 && \\\n/home/user/bin/pi-run --provider claude-bridge --model claude-opus-4-8 -p "ship the continuation fix" > "$SP/lane.log" 2>&1; echo "X=$?"`;
  const runs = await readAgentRuns(jsonl([
    piLaunch("toolu_cont", cmd),
    piLaunched("toolu_cont", "cont0808"),
  ]));
  expect(runs.length).toBe(1);
  expect(runs[0].source).toBe("pi");
  expect(runs[0].model).toBeTruthy();
  expect(runs[0].model!.toLowerCase()).toContain("opus");
  expect(runs[0].desc.toLowerCase()).toContain("opus");
});

test("the backslash shape with SP=... on its own first line is ONE pi row", async () => {
  enablePi();
  const cmd = `SP=/tmp/x\ncd /home/x/wt && export VOICE_URL=http://127.0.0.1:1 && \\\n/home/user/bin/pi-run --provider claude-bridge --model claude-opus-4-8 -p "do the thing" > "$SP/lane.log" 2>&1`;
  const runs = await readAgentRuns(jsonl([
    piLaunch("toolu_sp", cmd),
    piLaunched("toolu_sp", "sp0909"),
  ]));
  expect(runs.length).toBe(1);
  expect(runs[0].source).toBe("pi");
  expect(runs[0].model!.toLowerCase()).toContain("opus");
});

test("the `timeout N pi-run` shape is ONE pi row", async () => {
  enablePi();
  const runs = await readAgentRuns(jsonl([
    piLaunch("toolu_to", `timeout 14400 /home/user/bin/pi-run --provider grok --model grok-4.6 "long haul"`),
    piLaunched("toolu_to", "to9988"),
  ]));
  expect(runs.length).toBe(1);
  expect(runs[0].source).toBe("pi");
});

test("a pi-workflow lane is recognized too", async () => {
  enablePi();
  const runs = await readAgentRuns(jsonl([
    piLaunch("toolu_wf", `pi-workflow --provider claude --model opus-4.8 "ship the adapter"`),
    piLaunched("toolu_wf", "wf99887766"),
  ]));
  expect(runs.length).toBe(1);
  expect(runs[0].source).toBe("pi");
  expect(runs[0].model).toBe("claude opus-4.8");
  expect(runs[0].endedTs).toBeNull(); // still running (no notification yet)
});
