/* TmuxMuxAdapter against a fake tmux Multiplexer.
 *
 * The tmux adapter wraps TmuxMux + tmuxDriver behind the same
 * MultiplexerAdapter interface the herdr adapter implements. It must satisfy
 * that interface without a live tmux server, so this file injects a fake
 * tmux-shaped Multiplexer (pane ids are `%N`, sessions are `base`) and asserts
 * the adapter projects agents, guards delivery, and interrupts through it.
 * A codex pane with no linked session proves the empty conversation shape is
 * returned rather than thrown.
 *
 *   bun test agent-engine/src/adapters/tmux-adapter.test.ts
 */

import { test, expect } from "bun:test";
import type { AgentStatus, Multiplexer, MuxAgent } from "../terminal/mux.ts";
import type { AgentLifecycle } from "../readers/types.ts";
import { MuxAdapter } from "./mux-adapter.ts";
import { TmuxMuxAdapter } from "./tmux-adapter.ts";

/* A tmux -L socket NAME nobody else could be using. Nothing here ever calls
 * start(), so no tmux server is contacted at all, but a name that could collide
 * with a real one is not a thing to write down in a test. */
const SOCKET = `cyc-tmux-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

type Rpc = { method: string; pane: string; text?: string; keys?: string[] };

/** A tmux-shaped Multiplexer that records every pane call and answers
 *  readPane with `screen`. */
function fakeTmux(agents: MuxAgent[], screen = "") {
  const rpcs: Rpc[] = [];
  const mux: Multiplexer & { rpcs: Rpc[] } = {
    rpcs,
    onAgents(cb) {
      cb(agents); // mirror TmuxMux.onAgents: emit the snapshot already held
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
    async newTab() { return "%9"; },
  };
  return mux;
}

const CLAUDE: MuxAgent = {
  paneId: "%1",
  name: "my-project",
  cwd: "/tmp/my-project",
  status: "working",
  agent: "claude",
  agentSession: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", kind: "id", source: "tmux:claude" },
  workspace: "base",
  tab: null,
  displayAgent: null,
  stateChangeSeq: 2,
};

const CODEX: MuxAgent = {
  paneId: "%2",
  name: "codex-proj",
  cwd: "/tmp/codex-proj",
  status: "idle",
  agent: "codex",
  agentSession: null,
  workspace: "base",
  tab: null,
  displayAgent: null,
  stateChangeSeq: 1,
};

test("default construction advertises tmux capabilities and lists nothing", () => {
  const adapter = new TmuxMuxAdapter(SOCKET);
  expect(adapter.capabilities()).toEqual({ terminalViewer: true, typedInput: true, nativeDone: false });
  // start() was never called, so no tmux poll ran and the snapshot is empty.
  expect(adapter.listAgents()).toEqual([]);
  // the tmux terminal driver reflows a pane in place, so a rotation is a
  // resize and not a respawn (the hub reads this to decide)
  expect(adapter.terminalCanResize).toBe(true);
});

test("the tmux adapter IS the mux adapter: it reimplements no verb", () => {
  /* The whole point of this adapter. If this ever stopped being true, every behaviour
   * proven in mux.test.ts would need proving a second time here, and the two
   * copies would drift the way deliverToPane once did. */
  const adapter = new TmuxMuxAdapter(SOCKET, fakeTmux([]));
  expect(adapter).toBeInstanceOf(MuxAdapter);
  expect(Object.getOwnPropertyNames(TmuxMuxAdapter.prototype)).toEqual(["constructor"]);
});

test("listAgents/onAgents project a tmux MuxAgent into MuxAgentInfo", () => {
  const adapter = new TmuxMuxAdapter("s", fakeTmux([CLAUDE]));
  let projected: unknown = null;
  adapter.onAgents((a) => { projected = a; });
  const listed = adapter.listAgents();
  expect(listed).toEqual([
    {
      handle: "%1",
      title: "my-project",
      cwd: "/tmp/my-project",
      lifecycle: "running",
      kind: "claude",
      harnessSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      agentSession: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", kind: "id", source: "tmux:claude" },
      workspace: "base",
      tab: null,
      displayAgent: null,
      stateChangeSeq: 2,
      statusHint: "working",
    },
  ]);
  expect(projected).toEqual(listed);
});

test("sendInput is deliverToPane: reads, types, submits, then reads back to confirm through tmux", async () => {
  const inputScreen = [
    "────────────────────────────────────────",
    "❯",
    "────────────────────────────────────────",
    "  model · ctx 1%",
  ].join("\n");
  const mux = fakeTmux([CLAUDE], inputScreen);
  const adapter = new TmuxMuxAdapter("s", mux);
  adapter.onAgents(() => {});

  await adapter.sendInput("%1", "hello", "d-test");

  /* Two reads: the pre-send guard read and the post-enter confirm. The confirm
   * reads the same empty input box, so the body is consumed and the send is a
   * true receipt. */
  expect(mux.rpcs.filter((r) => r.method === "pane.read"))
    .toEqual([{ method: "pane.read", pane: "%1" }, { method: "pane.read", pane: "%1" }]);
  expect(mux.rpcs.filter((r) => r.method === "pane.send_text"))
    .toEqual([{ method: "pane.send_text", pane: "%1", text: "hello" }]);
  expect(mux.rpcs.filter((r) => r.method === "pane.send_keys"))
    .toEqual([{ method: "pane.send_keys", pane: "%1", keys: ["enter"] }]);
});

test("interrupt is sendKeys(ctrl+c) through tmux", async () => {
  const mux = fakeTmux([CLAUDE]);
  const adapter = new TmuxMuxAdapter("s", mux);

  await adapter.interrupt("%1");

  expect(mux.rpcs.filter((r) => r.method === "pane.send_keys"))
    .toEqual([{ method: "pane.send_keys", pane: "%1", keys: ["ctrl+c"] }]);
});

test("conversation for an unlinked codex pane returns the empty shape, never throws", async () => {
  const mux = fakeTmux([CODEX]);
  const adapter = new TmuxMuxAdapter("s", mux);
  adapter.onAgents(() => {});

  const conv = await adapter.conversation("%2");

  expect(conv.harnessSessionId).toBeNull();
  expect(conv.model).toBeNull();
  expect(conv.contextPct).toBeNull();
  expect(conv.title).toBeNull();
  expect(conv.messages).toEqual([]);
  expect(conv.events).toEqual([]);
  expect(conv.runs).toEqual([]);
  expect(conv.lifecycle).toBe("started");
  /* Taxonomy (server.ts askOf): unsupported = this pane kind has no screen
   * parser; unrecognised = we have the screen and could not parse it. An
   * unlinked codex pane has no parseScreen (codexReader omits it), so the
   * adapter must say unsupported rather than point the claude parser at a
   * foreign screen. canParseScreen is kind-based now; this is the legitimate
   * taxonomy, not a product regression. */
  expect(conv.blocked).toEqual({ ask: null, why: "unsupported" });
});

test("a handle the tmux snapshot does not list is `gone`, not an error", async () => {
  // the pane died between the app asking and the engine answering; the
  // conversation shape still has to come back so the row can be drawn as dead
  const adapter = new TmuxMuxAdapter(SOCKET, fakeTmux([CLAUDE]));
  adapter.onAgents(() => {});
  const conv = await adapter.conversation("%404");
  expect(conv.lifecycle).toBe("gone");
  expect(conv.harnessSessionId).toBeNull();
  expect(conv.messages).toEqual([]);
});

test("resolveHandle answers for a tmux %N pane and null for anything else", () => {
  /* The MCP registers with TMUX_PANE, which is `%N` here and `wN:pM` on herdr.
   * The adapter is the only thing that knows which namespace it is in. */
  const adapter = new TmuxMuxAdapter(SOCKET, fakeTmux([CLAUDE, CODEX]));
  adapter.onAgents(() => {});
  expect(adapter.resolveHandle("%1")).toBe("%1");
  expect(adapter.resolveHandle("%2")).toBe("%2");
  expect(adapter.resolveHandle("%9")).toBeNull();
  expect(adapter.resolveHandle("w1:p1")).toBeNull(); // a herdr id means nothing here
  expect(adapter.resolveHandle("")).toBeNull();
});

test("the status projection is the SAME one the herdr adapter uses", () => {
  // inherited, not copied: a tmux pane and a herdr pane in the same state must
  // sort and gate identically in the sessions frame
  const want: Record<AgentStatus, AgentLifecycle> = {
    blocked: "blocked", working: "running", done: "running", idle: "started", unknown: "started",
  };
  // Object.entries widens the key back to `string`; the map above is the claim.
  for (const [status, lifecycle] of Object.entries(want) as [AgentStatus, AgentLifecycle][]) {
    const adapter = new TmuxMuxAdapter(SOCKET, fakeTmux([{ ...CLAUDE, status }]));
    adapter.onAgents(() => {});
    expect(adapter.listAgents()[0].lifecycle, `status ${status}`).toBe(lifecycle);
  }
});

test("a codex pane with no linked session carries no harness session id", () => {
  const adapter = new TmuxMuxAdapter(SOCKET, fakeTmux([CODEX]));
  adapter.onAgents(() => {});
  const info = adapter.listAgents()[0];
  expect(info.kind).toBe("codex");
  expect(info.harnessSessionId).toBeNull();
  expect(info.agentSession).toBeNull();
  expect(info.workspace).toBe("base"); // tmux has one workspace and no tabs
  expect(info.tab).toBeNull();
});

test("the raw typed-input pass-throughs reach tmux with no screen read", async () => {
  const mux = fakeTmux([CLAUDE]);
  const adapter = new TmuxMuxAdapter(SOCKET, mux);
  adapter.onAgents(() => {});
  await adapter.sendText("%1", "claude --resume x");
  await adapter.sendKeys("%1", "enter");
  expect(mux.rpcs).toEqual([
    { method: "pane.send_text", pane: "%1", text: "claude --resume x" },
    { method: "pane.send_keys", pane: "%1", keys: ["enter"] },
  ]);
});

test("spawn / rename / close map onto the tmux Multiplexer verbs", async () => {
  const calls: string[] = [];
  let lastTab: unknown = null;
  const mux: Multiplexer = {
    onAgents(cb) { cb([CLAUDE]); },
    start() {},
    async readPane() { return { text: "", truncated: false }; },
    async sendText() {}, async sendKeys() {},
    async renamePane(p, label) { calls.push(`rename:${p}:${label}`); },
    async closePane(p) { calls.push(`close:${p}`); },
    workspaceOf(p) { calls.push(`workspaceOf:${p}`); return "base"; },
    knownCwds() { return ["/a"]; },
    async newTab(opts) { lastTab = opts; calls.push("newTab"); return "%42"; },
  };
  const adapter = new TmuxMuxAdapter(SOCKET, mux);
  const { handle } = await adapter.spawn({ cwd: "/tmp/proj", nearHandle: "%1", command: "claude" });
  expect(handle).toBe("%42");
  expect(lastTab).toEqual({ workspaceId: "base", cwd: "/tmp/proj", label: "proj", command: "claude" });
  await adapter.rename("%1", "newname");
  await adapter.close("%1");
  expect(adapter.knownCwds()).toEqual(["/a"]);
  expect(calls).toEqual(["workspaceOf:%1", "newTab", "rename:%1:newname", "close:%1"]);
});
