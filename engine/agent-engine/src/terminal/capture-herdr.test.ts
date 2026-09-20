/* PER-HARNESS IDENTITY CAPTURE ON THE HERDR LANE, through the full core.
 *
 * herdr reports no pane pids, so the announce's HERDR_PANE_ID witness is the
 * only binding path there, and it used to be gated to claude (herdr.ts:420,
 * :484-488). Widened (E5a/E5b): an announced bind is read for EVERY harness,
 * and a witness pane binds when it has any agent stamp, with a harness-carrying
 * announce required to match the pane's stamp. This proves codex (harness-less
 * notify) and opencode (harness:"opencode" plugin) capture, the harness-match
 * negative, and the claude regression.
 *
 * NO ENGINE PROCESS: wireCore over a FakeHerdr and a REAL adapter, the same rig
 * announce-resume.test.ts uses.
 *
 *   bun test agent-engine/src/terminal/capture-herdr.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { wireCore, type WireCore } from "../test-utils/wire-core.ts";
import { until } from "../test-utils/wait.ts";
import { handleAnnounce, hookBindFor, pendingAnnounces } from "./hook-announce.ts";

const CODEX_PANE = "w1:p1";
const OPENCODE_PANE = "w1:p2";
const CLAUDE_PANE = "w2:p1";
const PI_PANE = "w1:p4";
const PI_UNSTAMPED_PANE = "w1:p5";

const CODEX_ID = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b"; // uuidv7
const PI_ID = "3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9"; // pi session uuid
const PI_ID2 = "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d"; // the unstamped-pane pi session
const PI_ID3 = "b2c3d4e5-6f7a-4b8c-9d0e-1f2a3b4c5d6e"; // the one that must NOT land on claude
const OPENCODE_ID = "ses_fdb060bd7ffe5FdHc7yVVdct3p"; // real, ses_ + 26 alnum
const OPENCODE_ID2 = "ses_aaaa1111bbbb2222cccc3333dd"; // the one that must NOT land on claude
const CLAUDE_GUESS = "5efab001-1111-4aaa-8bbb-000000000001";

let core: WireCore | null = null;
afterEach(async () => { await core?.stop(); core = null; });

/** An announce resolved the herdr way: no pids, the pane env id is the witness.
 *  resolveAgentPid null keeps the witnesses (no nested-strip). Distinct pids so
 *  handleAnnounce's per-pid parking slot never collides across cases. */
const announce = (sessionId: string, herdrPane: string, pid: number, harness?: string) =>
  handleAnnounce({ sessionId, pid, cwd: "/tmp/x", herdrPane, ...(harness ? { harness } : {}) },
    { resolveAgentPid: async () => null });

test("a codex announce (harness-less) binds on its herdr witness; the row is harness-not-claude", async () => {
  core = await wireCore({
    with: ["frames"], agentStatus: "idle",
    panes: [CODEX_PANE], agents: { [CODEX_PANE]: "codex" }, noSession: [CODEX_PANE],
  });
  await until(() => !!core!.byHandle(CODEX_PANE), { what: "the codex pane to park" });

  const r = await announce(CODEX_ID, CODEX_PANE, 4321);
  expect(r.ok).toBe(true);

  await until(() => core!.byHandle(CODEX_PANE)?.harnessSessionId === CODEX_ID,
    { what: "the codex announced id to bind" });
  const s = core.byHandle(CODEX_PANE)!;
  // the codex id lands on the ONE session-id field and the row is tagged codex;
  // the wire derives a null claude jsonl id from that (contract.test.ts pins it).
  expect(s.harnessSessionId).toBe(CODEX_ID);
  expect(s.agent.id).toBe("codex");
});

test("an opencode announce (harness:opencode) binds on its herdr witness; ses_ id on the one field", async () => {
  core = await wireCore({
    with: ["frames"], agentStatus: "idle",
    panes: [OPENCODE_PANE], agents: { [OPENCODE_PANE]: "opencode" }, noSession: [OPENCODE_PANE],
  });
  await until(() => !!core!.byHandle(OPENCODE_PANE), { what: "the opencode pane to park" });

  const r = await announce(OPENCODE_ID, OPENCODE_PANE, 4322, "opencode");
  expect(r.ok).toBe(true);

  await until(() => core!.byHandle(OPENCODE_PANE)?.harnessSessionId === OPENCODE_ID,
    { what: "the opencode announced ses_ id to bind" });
  const s = core.byHandle(OPENCODE_PANE)!;
  expect(s.harnessSessionId).toBe(OPENCODE_ID);
  expect(s.agent.id).toBe("opencode");
});

test("a pi announce (harness:pi) binds on its herdr witness; uuid id on the one field", async () => {
  core = await wireCore({
    with: ["frames"], agentStatus: "idle",
    panes: [PI_PANE], agents: { [PI_PANE]: "pi" }, noSession: [PI_PANE],
  });
  await until(() => !!core!.byHandle(PI_PANE), { what: "the pi pane to park" });

  // the same /harness/announce path the pi extension now POSTs on session_start
  const r = await announce(PI_ID, PI_PANE, 4325, "pi");
  expect(r.ok).toBe(true);

  await until(() => core!.byHandle(PI_PANE)?.harnessSessionId === PI_ID,
    { what: "the pi announced uuid to bind" });
  const s = core.byHandle(PI_PANE)!;
  expect(s.harnessSessionId).toBe(PI_ID);
  expect(s.agent.id).toBe("pi");
});

test("REGRESSION (pi): a pi announce whose witness pane herdr has NOT stamped still BINDS on the witness", async () => {
  // The live intermittent-capture bug: the engine launches pi as `node .../cli.js`
  // and herdr frequently does not classify it, so the pane sits in the snapshot
  // with agent_status "unknown" and NO agent field for its short life. The
  // herdrPane witness is the identity; an unresolved stamp is not a reason to
  // withhold the bind, so this must capture deterministically without any stamp.
  core = await wireCore({
    with: ["frames"], agentStatus: "idle",
    panes: [PI_UNSTAMPED_PANE], agents: { [PI_UNSTAMPED_PANE]: "" }, noSession: [PI_UNSTAMPED_PANE],
  });
  // the unstamped pane is not a session in its own right (herdr never classified
  // it), so it does not list -- the announce is the only identity it will get
  const r = await announce(PI_ID2, PI_UNSTAMPED_PANE, 4326, "pi");
  expect(r.ok).toBe(true);

  await until(() => hookBindFor(PI_UNSTAMPED_PANE)?.sessionId === PI_ID2,
    { what: "the pi announce to bind on its unstamped witness pane" });
  expect(hookBindFor(PI_UNSTAMPED_PANE)?.sessionId).toBe(PI_ID2);
  expect(pendingAnnounces().some((p) => p.sessionId === PI_ID2),
    "the announce is retired, not left parked").toBe(false);
});

test("NEGATIVE (pi): a pi announce whose witness pane is stamped a DIFFERENT harness (claude) does NOT bind", async () => {
  // Anti-theft: a stale HERDR_PANE_ID must not put pi's id onto a pane herdr HAS
  // classified as a real, different harness. A RESOLVED cross-harness stamp is
  // the one case the witness bind still rejects.
  core = await wireCore({
    with: ["frames"], agentStatus: "idle",
    panes: [CLAUDE_PANE], agents: { [CLAUDE_PANE]: "claude" },
    sessionIds: { [CLAUDE_PANE]: CLAUDE_GUESS },
  });
  await until(() => core!.byHandle(CLAUDE_PANE)?.harnessSessionId === CLAUDE_GUESS,
    { what: "the claude pane to hold its own id" });

  const r = await announce(PI_ID3, CLAUDE_PANE, 4327, "pi");
  expect(r.ok).toBe(true);

  core.herdr.setStatus(CLAUDE_PANE, "working");
  await until(() => core!.byHandle(CLAUDE_PANE)?.status === "working",
    { what: "the status snapshot (which also processed the parked announce) to land" });
  const s = core.byHandle(CLAUDE_PANE)!;
  expect(s.harnessSessionId, "the pi id must not have stolen the claude pane").toBe(CLAUDE_GUESS);
  expect(hookBindFor(CLAUDE_PANE)?.sessionId, "pi never bound onto the claude pane").not.toBe(PI_ID3);
});

test("NEGATIVE: an opencode-harness announce whose witness pane is a claude pane does NOT bind", async () => {
  core = await wireCore({
    with: ["frames"], agentStatus: "idle",
    panes: [CLAUDE_PANE], agents: { [CLAUDE_PANE]: "claude" },
    sessionIds: { [CLAUDE_PANE]: CLAUDE_GUESS },
  });
  await until(() => core!.byHandle(CLAUDE_PANE)?.harnessSessionId === CLAUDE_GUESS,
    { what: "the claude pane to hold its own id" });

  // the harness field (opencode) does not match the pane's stamp (claude): parked, never bound
  const r = await announce(OPENCODE_ID2, CLAUDE_PANE, 4323, "opencode");
  expect(r.ok).toBe(true);

  // force a snapshot to run the pending-announce placement, then confirm the claude row is untouched
  core.herdr.setStatus(CLAUDE_PANE, "working");
  await until(() => core!.byHandle(CLAUDE_PANE)?.status === "working",
    { what: "the status snapshot (which also processed the parked announce) to land" });
  const s = core.byHandle(CLAUDE_PANE)!;
  expect(s.harnessSessionId, "the opencode id must not have stolen the claude pane").toBe(CLAUDE_GUESS);
});

test("REGRESSION: a claude announce still binds on its witness, exactly as before", async () => {
  core = await wireCore({
    with: ["frames"], agentStatus: "idle",
    panes: [CLAUDE_PANE], agents: { [CLAUDE_PANE]: "claude" }, noSession: [CLAUDE_PANE],
  });
  await until(() => !!core!.byHandle(CLAUDE_PANE), { what: "the claude pane to park" });

  // a harness-less claude hook announce (the shape the installed hook sends)
  const r = await announce(CLAUDE_GUESS, CLAUDE_PANE, 4324);
  expect(r.ok).toBe(true);

  await until(() => core!.byHandle(CLAUDE_PANE)?.harnessSessionId === CLAUDE_GUESS,
    { what: "the claude announced id to bind" });
  const s = core.byHandle(CLAUDE_PANE)!;
  expect(s.harnessSessionId, "a claude announce sets the one session-id field").toBe(CLAUDE_GUESS);
});
