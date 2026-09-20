/* THE RESTART PRE-FLIGHT (session-ops.ts restartPreflight), the pure
 * mode/sid/command decision the /restart route returns verbatim. Tested
 * directly rather than through the route because restartPane's quit-watch
 * (interrupt presses + waitForAgentGone + real timers) is not what this
 * decision is, and the decision is where the resume-by-id wiring lives.
 *
 * The four gates and the command, per harness:
 *   (a) resume with no id           -> 400 "nothing to resume"
 *   (b) a uuid / a ses_ id          -> pass the shape gate
 *   (c) a pane-shaped sid           -> 400 "not a plain id"
 *   (d) the typed command           == withAgentEnv(reader.launch.resume(sid), aid)
 *       (claude byte-identical to today: the regression pin)
 *   (e) a reader with no launch     -> 409 "not supported"
 *
 *   bun test agent-engine/src/routes/restart-preflight.test.ts
 */

import { test, expect } from "bun:test";
import { restartPreflight } from "./session-ops.ts";
import { withAgentEnv } from "../runtime/agent-env.ts";
import type { Multiplexer, MuxAgent } from "../terminal/mux.ts";

const { MuxAdapter } = await import("../adapters/mux-adapter.ts");

const AID = "ag-0123456789abcdef";
const CLAUDE = "6f1c2b3a-9d8e-4f70-a1b2-c3d4e5f60718";
const CODEX = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b"; // uuidv7
const OPENCODE = "ses_fdb060bd7ffe5FdHc7yVVdct3p"; // real, ses_ + 26 alnum

/** A do-nothing mux: restartPreflight only reads launchCommand/resumeCommand,
 *  which resolve through the REAL readers table, so no pane is ever touched. */
function fakeMux(): Multiplexer {
  return {
    onAgents(cb: (a: MuxAgent[]) => void) { cb([]); },
    start() {},
    async readPane() { return { text: "", truncated: false }; },
    async sendText() {}, async sendKeys() {}, async renamePane() {}, async closePane() {},
    workspaceOf() { return null; }, knownCwds() { return []; },
    async newTab() { return "w9:p1"; },
  } as unknown as Multiplexer;
}
const adapter = new MuxAdapter(fakeMux());

/** A session Pick shaped exactly as the route hands restartPreflight one. The
 *  resume id is the one harnessSessionId for every harness now (the claude-only
 *  second field was retired). */
function sess(kind: string, name: string, harnessSessionId: string | null) {
  return { agent: { id: kind, name }, agentId: AID, harnessSessionId };
}

test("(d) resume: each harness's command equals withAgentEnv(reader.resume(sid), aid)", () => {
  const cases: Array<[string, string, string]> = [
    ["claude", "Claude", CLAUDE],
    ["codex", "Codex", CODEX],
    ["opencode", "opencode", OPENCODE],
  ];
  for (const [kind, name, sid] of cases) {
    // every harness carries its resume id on the one harnessSessionId.
    const s = sess(kind, name, sid);
    const pre = restartPreflight(s, "resume", adapter);
    expect(pre.ok, `${kind} resume`).toBe(true);
    if (!pre.ok) continue;
    expect(pre.sid).toBe(sid);
    expect(pre.cmd).toBe(withAgentEnv(adapter.resumeCommand(kind, sid)!, AID));
  }
});

test("(d) claude resume is byte-identical to today: the regression pin", () => {
  const pre = restartPreflight(sess("claude", "Claude", CLAUDE), "resume", adapter);
  expect(pre.ok).toBe(true);
  if (!pre.ok) return;
  expect(pre.cmd).toBe(`env CYC_AGENT_ID=${AID} claude --dangerously-skip-permissions --resume ${CLAUDE}`);
});

test("opencode resume types the --auto --session form", () => {
  const pre = restartPreflight(sess("opencode", "opencode", OPENCODE), "resume", adapter);
  expect(pre.ok).toBe(true);
  if (!pre.ok) return;
  expect(pre.cmd).toBe(`env CYC_AGENT_ID=${AID} opencode --auto --session ${OPENCODE}`);
});

test("fresh uses the launch command and never looks at the id", () => {
  const pre = restartPreflight(sess("opencode", "opencode", null), "fresh", adapter);
  expect(pre.ok).toBe(true);
  if (!pre.ok) return;
  expect(pre.cmd).toBe(withAgentEnv(adapter.launchCommand("opencode")!, AID));
  expect(pre.cmd).toContain("opencode --auto");
});

test("(a) resume with no id refuses with 400 'nothing to resume'", () => {
  const pre = restartPreflight(sess("opencode", "opencode", null), "resume", adapter);
  expect(pre.ok).toBe(false);
  if (pre.ok) return;
  expect(pre.status).toBe(400);
  expect(pre.error).toContain("nothing to resume");
});

/* The old "(b) the `??` belt" test is retired with the belt:
 * it exercised a claude row with harnessSessionId null but a claude id present,
 * a state the invariant proves cannot occur (carry.ts / reconcile.ts set the
 * one id for every harness, and the claude id was only ever derived from it),
 * so there is nothing left for a belt to recover. */

test("(c) a pane-shaped sid is refused with 400 'not a plain id'", () => {
  for (const bad of ["w7:p1", "%3~4711~1700000000", "tmux:%3"]) {
    const pre = restartPreflight(sess("codex", "Codex", bad), "resume", adapter);
    expect(pre.ok, bad).toBe(false);
    if (pre.ok) continue;
    expect(pre.status).toBe(400);
    expect(pre.error).toBe("that pane's session id is not a plain id");
  }
});

test("(e) a reader with no launch command refuses with 409", () => {
  // a stub adapter for an agent whose reader omits launch (launchCommand null)
  const noLaunch = { launchCommand: () => null, resumeCommand: () => null };
  const fresh = restartPreflight(sess("aider", "Aider", null), "fresh", noLaunch);
  expect(fresh.ok).toBe(false);
  if (!fresh.ok) expect(fresh.status).toBe(409);
  const resume = restartPreflight(sess("aider", "Aider", CLAUDE), "resume", noLaunch);
  expect(resume.ok).toBe(false);
  if (!resume.ok) {
    expect(resume.status).toBe(409);
    expect(resume.error).toContain("not supported");
  }
});
