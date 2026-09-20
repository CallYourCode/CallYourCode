/* MuxAdapter against a fake Multiplexer.
 *
 * The adapter wraps today's Multiplexer + today's server helpers without a
 * live herdr: a fake Multiplexer records every pane call, and a throwaway
 * claude transcript proves conversation() really reads events and runs through
 * the readers/claude.ts seam.
 *
 *   bun test agent-engine/src/adapters/mux.test.ts
 */

import { test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentStatus, Multiplexer, MuxAgent } from "../terminal/mux.ts";
import type { AgentLifecycle } from "../readers/types.ts";
import { sessionFilePath } from "../readers/claude.ts";
import { tmpDir } from "../test-utils/tmp.ts";

const { MuxAdapter, PaneNotReady } = await import("./mux-adapter.ts");

type Rpc = { method: string; pane: string; text?: string; keys?: string[] };

/** A Multiplexer that records every pane call and answers readPane with `screen`.
 *  `emit` pushes a NEW snapshot to every registered listener, the way herdr does
 *  when a pane appears or dies. */
function fakeMux(agents: MuxAgent[], screen = "") {
  const rpcs: Rpc[] = [];
  let current = agents;
  const listeners: Array<(a: MuxAgent[]) => void> = [];
  const mux: Multiplexer & { rpcs: Rpc[]; emit(next: MuxAgent[]): void } = {
    rpcs,
    emit(next) { current = next; for (const cb of listeners) cb(next); },
    onAgents(cb) {
      listeners.push(cb);
      cb(current); // mirror HerdrClient: emit the snapshot already held
    },
    start() {},
    async readPane(paneId, _lines) {
      rpcs.push({ method: "pane.read", pane: paneId });
      return { text: screen, truncated: false };
    },
    async sendText(paneId, text) {
      rpcs.push({ method: "pane.send_text", pane: paneId, text });
    },
    async sendKeys(paneId, ...keys) {
      rpcs.push({ method: "pane.send_keys", pane: paneId, keys });
    },
    async renamePane() {},
    async closePane() {},
    workspaceOf() { return null; },
    knownCwds() { return []; },
    async newTab() { return "w9:p1"; },
  };
  return mux;
}

const CLAUDE: MuxAgent = {
  paneId: "w1:p1",
  name: "my-project",
  cwd: "/tmp/my-project",
  status: "working",
  agent: "claude",
  agentSession: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", kind: "id", source: "herdr:claude" },
  workspace: "w1",
  tab: "t1",
  displayAgent: null,
  stateChangeSeq: 3,
};

test("capabilities advertises terminalViewer and typedInput", () => {
  const adapter = new MuxAdapter(fakeMux([]));
  expect(adapter.capabilities()).toEqual({ terminalViewer: true, typedInput: true, nativeDone: true });
});

test("resolveHandle maps the raw env pane id to the opaque handle, or null when unknown", () => {
  const adapter = new MuxAdapter(fakeMux([CLAUDE]));
  adapter.onAgents(() => {});
  expect(adapter.resolveHandle("w1:p1")).toBe("w1:p1");
  expect(adapter.resolveHandle("w9:ghost-pane")).toBeNull();
  expect(adapter.resolveHandle("")).toBeNull();
});

test("resolveHandle maps a bare TMUX_PANE %N onto the reuse-proof composite handle", () => {
  /* The tmux lane's handle is `%N~pid~epoch` (tmux.ts paneKey) while the MCP's
   * env only carries TMUX_PANE=%N; the pane-id segment resolves it. `%1` must
   * not swallow `%10` (the separator bounds the match). */
  const k1 = { ...CLAUDE, paneId: "%1~111~1000" };
  const k10 = { ...CLAUDE, paneId: "%10~222~1000", cwd: "/tmp/other" };
  const adapter = new MuxAdapter(fakeMux([k1, k10]));
  adapter.onAgents(() => {});
  expect(adapter.resolveHandle("%1")).toBe("%1~111~1000");
  expect(adapter.resolveHandle("%10")).toBe("%10~222~1000");
  expect(adapter.resolveHandle("%2")).toBeNull();
});

test("listAgents/onAgents project MuxAgent into MuxAgentInfo", () => {
  const adapter = new MuxAdapter(fakeMux([CLAUDE]));
  let projected: unknown = null;
  adapter.onAgents((a) => { projected = a; });
  const listed = adapter.listAgents();
  expect(listed).toEqual([
    {
      handle: "w1:p1",
      title: "my-project",
      cwd: "/tmp/my-project",
      lifecycle: "running",
      kind: "claude",
      harnessSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      agentSession: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", kind: "id", source: "herdr:claude" },
      workspace: "w1",
      tab: "t1",
      displayAgent: null,
      stateChangeSeq: 3,
      statusHint: "working",
    },
  ]);
  expect(projected).toEqual(listed);
});

test("sendInput is deliverToPane: reads, types, submits, then reads back to confirm", async () => {
  const inputScreen = [
    "────────────────────────────────────────",
    "❯",
    "────────────────────────────────────────",
    "  model · ctx 1%",
  ].join("\n");
  const mux = fakeMux([CLAUDE], inputScreen);
  const adapter = new MuxAdapter(mux);
  adapter.onAgents(() => {});

  await adapter.sendInput("w1:p1", "hello", "d-test");

  /* Two reads now: the pre-send guard read, then the post-enter confirm that
   * makes a committed delivery a true receipt. The confirm reads the same empty
   * input box, so the body is taken as consumed and the send succeeds. */
  expect(mux.rpcs.filter((r) => r.method === "pane.read"))
    .toEqual([{ method: "pane.read", pane: "w1:p1" }, { method: "pane.read", pane: "w1:p1" }]);
  expect(mux.rpcs.filter((r) => r.method === "pane.send_text"))
    .toEqual([{ method: "pane.send_text", pane: "w1:p1", text: "hello" }]);
  expect(mux.rpcs.filter((r) => r.method === "pane.send_keys"))
    .toEqual([{ method: "pane.send_keys", pane: "w1:p1", keys: ["enter"] }]);
});

test("sendInput refuses a chooser without typing anything", async () => {
  const chooser = await Bun.file(join(import.meta.dir, "..", "fixtures", "pane-permission-prompt.txt")).text();
  const mux = fakeMux([CLAUDE], chooser);
  const adapter = new MuxAdapter(mux);
  adapter.onAgents(() => {});

  await expect(adapter.sendInput("w1:p1", "hello", "d-test")).rejects.toBeInstanceOf(PaneNotReady);
  expect(mux.rpcs.filter((r) => r.method === "pane.send_text")).toHaveLength(0);
});

test("interrupt is sendKeys(ctrl+c)", async () => {
  const mux = fakeMux([CLAUDE]);
  const adapter = new MuxAdapter(mux);

  await adapter.interrupt("w1:p1");

  expect(mux.rpcs.filter((r) => r.method === "pane.send_keys"))
    .toEqual([{ method: "pane.send_keys", pane: "w1:p1", keys: ["ctrl+c"] }]);
});

test("conversation reads real events and runs through the claude reader", async () => {
  const uuid = "11111111-2222-3333-4444-555555555555";
  const cwd = await tmpDir("cyc-mux-conv-");
  const path = sessionFilePath(cwd, uuid)!;
  const mungedDir = join(path, "..");
  try {
    expect(path).toBeTruthy();
    mkdirSync(mungedDir, { recursive: true });
    const ts = "2026-08-18T12:00:00.000Z";
    writeFileSync(path, [
      JSON.stringify({ type: "user", uuid: "u1", timestamp: ts, promptId: "p1", message: { content: "hello there" } }),
      JSON.stringify({ type: "assistant", uuid: "u2", timestamp: ts, message: { content: [{ type: "text", text: "hi from claude" }] } }),
      JSON.stringify({ type: "assistant", uuid: "u3", timestamp: ts, message: { content: [{ type: "tool_use", id: "tu_1", name: "Agent", input: { description: "the profile pane" } }] } }),
    ].join("\n") + "\n");

    const agent: MuxAgent = { ...CLAUDE, cwd, agentSession: { id: uuid, kind: "id", source: "herdr:claude" } };
    const adapter = new MuxAdapter(fakeMux([agent]));
    adapter.onAgents(() => {});

    const conv = await adapter.conversation("w1:p1");

    expect(conv.harnessSessionId).toBe(uuid);
    expect(conv.lifecycle).toBe("running");
    /* conversation() reads the screen for `blocked` now, so even the empty
     * screen the fake mux serves is a real observation (read ok, no dialog) --
     * not a null the way the earlier stub answered. */
    expect(conv.blocked).toEqual({ ask: null, why: "unrecognised" });
    expect(Array.isArray(conv.events)).toBe(true);
    expect(conv.events.some((e) => e.kind === "prompt")).toBe(true);
    expect(conv.events.some((e) => e.kind === "reply")).toBe(true);
    expect(Array.isArray(conv.runs)).toBe(true);
    expect(conv.runs).toHaveLength(1);
    expect(conv.runs[0].desc).toBe("the profile pane");
    expect(conv.messages).toHaveLength(2);
  } finally {
    // the munged transcript dir lives OUTSIDE the tmp dir (claude's own path
    // munging puts it under ~/.claude/projects), so it is removed by hand;
    // tmpDir() takes care of `cwd` itself.
    rmSync(mungedDir, { recursive: true, force: true });
  }
});

/* The spawn-side pane ops are the Multiplexer verbs under agent-shaped
 * names, with workspaceOf(near) and the cwd label folded into spawn. */
test("spawn/rename/close/knownCwds map onto the Multiplexer verbs", async () => {
  const calls: string[] = [];
  let lastTab: any = null;
  const mux: Multiplexer = {
    onAgents() {},
    start() {},
    async readPane() { return { text: "", truncated: false }; },
    async sendText() {},
    async sendKeys() {},
    async renamePane(pane, label) { calls.push(`rename:${pane}:${label}`); },
    async closePane(pane) { calls.push(`close:${pane}`); },
    workspaceOf(pane) { calls.push(`workspaceOf:${pane}`); return "ws-9"; },
    knownCwds() { calls.push("knownCwds"); return ["/a", "/b"]; },
    async newTab(opts) { lastTab = opts; calls.push("newTab"); return "w9:p42"; },
  };
  const adapter = new MuxAdapter(mux);

  const { handle } = await adapter.spawn({ cwd: "/a/b", nearHandle: "w1:p1", command: "claude" });
  expect(handle).toBe("w9:p42");
  expect(calls).toEqual(["workspaceOf:w1:p1", "newTab"]);
  expect(lastTab).toEqual({ workspaceId: "ws-9", cwd: "/a/b", label: "b", command: "claude" });

  await adapter.rename("w1:p1", "newname");
  await adapter.close("w1:p1");
  expect(adapter.knownCwds()).toEqual(["/a", "/b"]);
  expect(calls).toEqual([
    "workspaceOf:w1:p1", "newTab", "rename:w1:p1:newname", "close:w1:p1", "knownCwds",
  ]);
});

test("spawn with no nearHandle opens a tab with no workspace", async () => {
  let lastTab: any = null;
  const mux: Multiplexer = {
    onAgents() {},
    start() {},
    async readPane() { return { text: "", truncated: false }; },
    async sendText() {},
    async sendKeys() {},
    async renamePane() {},
    async closePane() {},
    workspaceOf() { return "ws-1"; },
    knownCwds() { return []; },
    async newTab(opts) { lastTab = opts; return "w9:p1"; },
  };
  const adapter = new MuxAdapter(mux);

  await adapter.spawn({ cwd: "/a/b/c", command: "claude" });

  expect(lastTab).toEqual({ workspaceId: null, cwd: "/a/b/c", label: "c", command: "claude" });
});

/* ---- the projection, one status and one agent kind at a time ---- */

test("every mux status maps onto the coarse lifecycle core keys `alive` on", () => {
  /* `alive` gates whether the mux input baseline can answer at all (the
   * capability dispatch reads it), so an idle pane read as anything but a
   * listed, alive session would grey out its own send button. */
  const want: Record<AgentStatus, AgentLifecycle> = {
    blocked: "blocked",
    working: "running",
    done: "running",
    idle: "started",
    unknown: "started",
  };
  /* Object.entries widens the key to `string` and the value to the union's
   * union, so both sides are re-narrowed here rather than at the call. The map
   * above is what is being asserted; this is only how it is walked. */
  for (const [status, lifecycle] of Object.entries(want) as [AgentStatus, AgentLifecycle][]) {
    const adapter = new MuxAdapter(fakeMux([{ ...CLAUDE, status }]));
    adapter.onAgents(() => {});
    expect(adapter.listAgents()[0].lifecycle, `status ${status}`).toBe(lifecycle);
    expect(adapter.listAgents()[0].statusHint).toBe(status); // the raw hint survives too
  }
});

test("harnessSessionId is derived ONLY for a claude pane with a real id", () => {
  /* The harness session id is what opens a transcript. A codex pane's own
   * agent_session is a different namespace, and reading it as a claude session
   * id would send the reader looking for a file that never existed. */
  const cases: { agent: string; session: MuxAgent["agentSession"]; want: string | null }[] = [
    { agent: "claude", session: { id: "sid-1", kind: "id", source: "herdr:claude" }, want: "sid-1" },
    /* kind "path" rather than "id": the OTHER member of AgentSessionRef's union
     * (agents.ts), and the one that must not be read as a claude session id.
     * This case named a `kind: "name"` that the type has never had, so it was
     * asserting about a shape nothing can produce. */
    { agent: "claude", session: { id: "some-path", kind: "path", source: "herdr:claude" }, want: null },
    { agent: "claude", session: null, want: null },
    /* A pre-minted ref (tmux spawn path): the id is the ENGINE's stable agent
     * id for a cold pane, not a harness session id, and lifting it would send
     * the readers after a transcript that does not exist. The session stays
     * keyed by its pane handle, the same parked shape herdr's lane has. */
    { agent: "claude", session: { id: "ag-TESTPRELINK00001", kind: "id", source: "tmux:premint" }, want: null },
    /* A parked ref (hand-started pane, no transcript yet): the id is the PANE
     * HANDLE, refused for the same reason as the pre-mint above. */
    { agent: "claude", session: { id: "%7", kind: "id", source: "tmux:parked" }, want: null },
    { agent: "codex", session: { id: "sid-2", kind: "id", source: "herdr:codex" }, want: null },
    { agent: "pi", session: { id: "sid-3", kind: "id", source: "herdr:pi" }, want: null },
  ];
  for (const c of cases) {
    const adapter = new MuxAdapter(fakeMux([{ ...CLAUDE, agent: c.agent, agentSession: c.session }]));
    adapter.onAgents(() => {});
    const info = adapter.listAgents()[0];
    expect(info.harnessSessionId, `${c.agent}/${c.session?.kind}`).toBe(c.want);
    // ...but the raw ref is carried through for ANY agent, because codex and
    // opencode locate their transcripts from it
    expect(info.agentSession).toEqual(c.session);
  }
});

test("listAgents answers empty before the first snapshot, and resolveHandle answers null", () => {
  // the engine calls these during boot, before onAgents has fired once
  const adapter = new MuxAdapter(fakeMux([CLAUDE]));
  expect(adapter.listAgents()).toEqual([]);
  expect(adapter.resolveHandle("w1:p1")).toBeNull();
});

test("a later snapshot REPLACES the list rather than adding to it", () => {
  /* A pane that has gone must stop being listed: a stale row keeps a dead
   * session looking alive in the sessions frame, and resolveHandle would keep
   * handing the MCP a handle for a pane that no longer exists. */
  const mux = fakeMux([CLAUDE]);
  const adapter = new MuxAdapter(mux);
  const seen: string[][] = [];
  adapter.onAgents((a) => seen.push(a.map((x) => x.handle)));
  expect(adapter.resolveHandle("w1:p1")).toBe("w1:p1");

  const other: MuxAgent = { ...CLAUDE, paneId: "w2:p2", name: "other" };
  mux.emit([other]);
  expect(adapter.listAgents().map((a) => a.handle)).toEqual(["w2:p2"]);
  expect(adapter.resolveHandle("w1:p1")).toBeNull(); // the dead pane is gone
  expect(adapter.resolveHandle("w2:p2")).toBe("w2:p2");

  mux.emit([]);
  expect(adapter.listAgents()).toEqual([]);
  expect(seen).toEqual([["w1:p1"], ["w2:p2"], []]);
});

test("every registered callback is handed the snapshot the mux already holds", () => {
  // HerdrClient emits immediately to a late subscriber; the adapter must carry
  // that one-for-one or a plugin registered after boot never sees an agent
  const adapter = new MuxAdapter(fakeMux([CLAUDE]));
  const a: number[] = [];
  const b: number[] = [];
  adapter.onAgents((list) => a.push(list.length));
  adapter.onAgents((list) => b.push(list.length));
  expect(a).toEqual([1]);
  expect(b).toEqual([1]);
});

/* ---- the raw pass-throughs, which deliberately skip the chooser guard ---- */

test("sendText and sendKeys go straight to the mux, with no screen read", async () => {
  /* These are the two shell-typing call sites (the restart command, the chooser
   * digit). They must NOT read the pane first: the restart types into a bare
   * shell after the agent quit, and a chooser guard there would refuse the very
   * keystroke that brings the agent back. */
  const chooser = await Bun.file(join(import.meta.dir, "..", "fixtures", "pane-permission-prompt.txt")).text();
  const mux = fakeMux([CLAUDE], chooser);
  const adapter = new MuxAdapter(mux);
  adapter.onAgents(() => {});
  await adapter.sendText("w1:p1", "claude --resume x");
  await adapter.sendKeys("w1:p1", "enter");
  await adapter.sendKeys("w1:p1", "2");
  expect(mux.rpcs.filter((r) => r.method === "pane.read")).toHaveLength(0);
  expect(mux.rpcs.map((r) => r.method)).toEqual(["pane.send_text", "pane.send_keys", "pane.send_keys"]);
});

test("interrupt does not read the screen either: ctrl-c always goes", async () => {
  // a pane wedged on a dialog is exactly when interrupt is needed most
  const chooser = await Bun.file(join(import.meta.dir, "..", "fixtures", "pane-permission-prompt.txt")).text();
  const mux = fakeMux([CLAUDE], chooser);
  const adapter = new MuxAdapter(mux);
  adapter.onAgents(() => {});
  await adapter.interrupt("w1:p1");
  expect(mux.rpcs).toEqual([{ method: "pane.send_keys", pane: "w1:p1", keys: ["ctrl+c"] }]);
});

/* ---- the reader table the adapter dispatches on ---- */

test("hasTranscript / launchCommand / resumeCommand answer per agent kind", () => {
  const adapter = new MuxAdapter(fakeMux([]));
  expect(adapter.hasTranscript("claude")).toBe(true);
  expect(adapter.hasTranscript("codex")).toBe(true);
  expect(adapter.hasTranscript("opencode")).toBe(true);
  expect(adapter.hasTranscript("pi")).toBe(true);
  // an agent nobody wrote a reader for: name-only, no capabilities. Answering
  // "yes" here would send the engine looking for a transcript that never exists.
  expect(adapter.hasTranscript("mystery-agent")).toBe(false);
  expect(adapter.launchCommand("mystery-agent")).toBeNull();
  expect(adapter.resumeCommand("mystery-agent", "sid")).toBeNull();
  // claude has both, and the resume command names the session it resumes
  expect(adapter.launchCommand("claude")).toBeTruthy();
  expect(adapter.resumeCommand("claude", "sid-9")).toContain("sid-9");
});

test("codex reader exposes the permissive launch command (engine can launch + restart codex)", () => {
  // codex's launch capability moved onto its reader (readers/codex.ts): the
  // fresh command is the byte-exact YOLO-mode flag, the analog of claude's
  // --dangerously-skip-permissions. Its presence is what flips
  // routes/session-ops.ts off the "codex has no launch command yet" refusal, so
  // engine-launch and a fresh Restart both work for codex now.
  const adapter = new MuxAdapter(fakeMux([]));
  // The permissive flag plus `-c check_for_update_on_startup=false`, which stops
  // codex's on-startup CLI update check from gating app bring-up.
  expect(adapter.launchCommand("codex")).toBe(
    "codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false",
  );
  // resume exists to satisfy the required launch type and uses codex's real
  // resume-by-id form; it names the session it resumes.
  expect(adapter.resumeCommand("codex", "sid-7")).toContain("sid-7");
  expect(adapter.resumeCommand("codex", "sid-7")).toContain("resume");
});

test("canParseScreen is false for an unknown handle and for a kind with no screen reader", () => {
  // it gates the delivery guard: claiming a screen can be parsed when it cannot
  // is how a message gets typed into a permission dialog
  const adapter = new MuxAdapter(fakeMux([{ ...CLAUDE, agent: "mystery-agent" }]));
  adapter.onAgents(() => {});
  expect(adapter.canParseScreen("w1:p1")).toBe(false);
  expect(adapter.canParseScreen("w9:nope")).toBe(false);
});

test("spawn labels the tab with the last real path segment", () => {
  // a trailing slash or a root cwd must not produce an empty tab label
  const labels: (string | undefined)[] = [];
  const mux: Multiplexer = {
    onAgents() {}, start() {},
    async readPane() { return { text: "", truncated: false }; },
    async sendText() {}, async sendKeys() {},
    async renamePane() {}, async closePane() {},
    workspaceOf() { return null; },
    knownCwds() { return []; },
    async newTab(opts) { labels.push(opts.label); return "w9:p1"; },
  };
  const adapter = new MuxAdapter(mux);
  return (async () => {
    await adapter.spawn({ cwd: "/a/b/c/", command: "claude" });
    await adapter.spawn({ cwd: "/", command: "claude" });
    await adapter.spawn({ cwd: "", command: "claude" });
    expect(labels).toEqual(["c", "claude", "claude"]);
  })();
});

test("capabilities are a fact about the mux, not about a session", () => {
  // Hermes-class transports answer false here; core reads this to decide
  // whether a terminal button exists at all
  const adapter = new MuxAdapter(fakeMux([]));
  expect(adapter.capabilities()).toEqual({ terminalViewer: true, typedInput: true, nativeDone: true });
  expect(adapter.capabilities()).toEqual(adapter.capabilities()); // stable
});

/* THE SEAM THAT SPLIT (2026-08-23): the tmux lane once built TWO TmuxMux
 * instances, one inside the adapter (the polled one) and one from makeMux
 * (which a spawn path could use), so a /new-session pre-link could land in a
 * mux nobody polled and the spawned agent never surfaced. This pins every
 * factory path onto ONE instance per process: the mux the adapter enumerates
 * IS the mux any other factory hands out for the same socket. */
test("tmux lane: makeAdapter polls the exact TmuxMux instance makeMux returns", async () => {
  const env = { CYC_MUX: "tmux", CYC_TMUX_SOCKET: "cyc-seam-pin" };
  const { makeAdapter } = await import("./factory.ts");
  const { makeMux } = await import("../terminal/mux.ts");
  const { sharedTmuxMux } = await import("../terminal/tmux.ts");
  const adapter = makeAdapter(env) as InstanceType<typeof MuxAdapter>;
  const spawnSide = makeMux(env);
  expect(adapter.backingMux).toBe(spawnSide);
  expect(adapter.backingMux).toBe(sharedTmuxMux("cyc-seam-pin"));
  // a second adapter build must not mint a fresh mux either
  const again = makeAdapter(env) as InstanceType<typeof MuxAdapter>;
  expect(again.backingMux).toBe(spawnSide);
});

test("adapter.start() starts the backing mux poll (the production boot path)", () => {
  /* server.ts calls adapter.start() once at the end of boot; this is the hop
   * that turns it into mux.start(). If this forwarding broke, the tmux poll
   * would simply never run and the engine would list nothing, silently. */
  let started = 0;
  const counting: Multiplexer = { ...fakeMux([]), start() { started++; } };
  const adapter = new MuxAdapter(counting);
  adapter.start();
  expect(started).toBe(1);
});
