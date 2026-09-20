/* THE PluginCore SHAPE, standalone. Proves the ONE typed core API is
 * constructible over injected wiring and forwards each member to the right
 * backer: the three host verbs + agentIds to the PluginHost, read/command/has/
 * usage to the dispatch, and the core services (tts, searchChat, notifyDevices,
 * inputTransform registration, paneTerminalStream) to their plain members.
 *
 * This file is the PATTERN the rest of the unit tier copies: the real module is
 * constructed with typed fakes at its own declared seams, nothing boots, and the
 * only I/O is the store writes the test itself asked for, inside a tmp dir this
 * file owns. A forwarder is only worth testing if the test can tell the
 * difference between "forwarded" and "reimplemented", so every fake below
 * records WHICH backer was reached and with what.
 *
 *   bun test agent-engine/src/plugins/platform/core.test.ts
 */

import { expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import {
  makePluginCore, makeInputTransformRegistry,
  type PluginCoreServices, type NotifyPayload, type EngineNotifyPayload, type ChatSearchResult, type OutgoingInput,
} from "./core.ts";
import { makeCapabilityDispatch, type DispatchSessionFacts } from "../../runtime/capability-dispatch.ts";
import type { HostWiring } from "./host.ts";
import type { HarnessCapabilities, TranscriptOpts } from "../../runtime/capabilities.ts";
import type { AgentConversation } from "../../readers/types.ts";
import type { TerminalHandlers, TerminalSession } from "../../terminal/terminal.ts";
import { tmpDir } from "../../test-utils/tmp.ts";

/* CYC_DATA_DIR is set ONCE for the whole file and restored in afterAll: the
 * store paths are computed lazily from it, and a mid-file flip would move a
 * store out from under a host that had already cached its dir. Each test that
 * writes picks its own plugin id / agent id, so one base dir is enough. */
let base = "";
const oldEnv = process.env.CYC_DATA_DIR;
beforeAll(async () => {
  base = await tmpDir("cyc-core-");
  process.env.CYC_DATA_DIR = base;
});
afterAll(() => {
  if (oldEnv === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = oldEnv;
});

const conv = (id: string | null): AgentConversation => ({
  harnessSessionId: id, model: null, contextPct: null, title: null, blocked: null,
  lifecycle: "running", messages: [], events: [], runs: [],
});

/* A claude-shaped harness: every meta read answers, compact and usage are
 * present, and there is deliberately NO native sendText, so input has to reach
 * the mux baseline for the brokering assertion below to mean anything. */
const transcriptOpts: (TranscriptOpts | undefined)[] = [];
const claudeCaps: HarnessCapabilities = {
  model: async () => "claude-opus-4-8",
  context: async () => ({ used: 550_000, total: 1_000_000, pct: 55 }),
  transcript: async (s, opts) => { transcriptOpts.push(opts); return conv(s.harnessSessionId); },
  status: () => "running",
  blocked: async () => ({ ask: null, why: "unread" }),
  compact: async () => ({ ok: true, tell: "compacting this context" }),
  usage: async (force) => ({ shape: "claude", n: 1, forced: force }),
};

const facts: Record<string, DispatchSessionFacts> = {
  s1: { handle: "pane-1", cwd: "/w", harnessSessionId: "csid", kind: "claude", name: "Claude", viaMux: true, alive: true },
};

type Sink = {
  notified: NotifyPayload[];
  engineNotified: EngineNotifyPayload[];
  sampled: string[];
  termOpens: { sessionId: string; cols: number; rows: number }[];
  muxTyped: string[];
  reg: ReturnType<typeof makeInputTransformRegistry>;
};

function sinkOf(): Sink {
  return { notified: [], engineNotified: [], sampled: [], termOpens: [], muxTyped: [], reg: makeInputTransformRegistry() };
}

function servicesOf(sink: Sink): PluginCoreServices {
  const dispatch = makeCapabilityDispatch({
    sessionOf: (id) => facts[id],
    harnessFor: (kind) => (kind === "claude" ? claudeCaps : null),
    harnessKinds: () => [{ kind: "claude", active: true }, { kind: "codex", active: false }],
    muxInput: {
      sendText: async (_r, t) => { sink.muxTyped.push(t); return { ok: true, tell: "typed" }; },
      interrupt: async () => { sink.muxTyped.push("\x03"); return { ok: true, tell: "sent ctrl-c" }; },
    },
  });
  const searchResult: ChatSearchResult = {
    total: 1, scanned: 3, matches: [{ seq: 2, ts: 100, role: "user", excerpt: "hello there" }],
  };
  return {
    dispatch,
    tts: {
      list: async () => ["Aria", "Kai"],
      sample: async (v) => { sink.sampled.push(v); return v ? "YmFzZTY0" : null; },
      voiceOf: () => "",
      setVoice: () => {},
      globalDefault: () => "",
      setDefault: () => {},
      sessionExists: () => true,
    },
    searchChat: (sessionId, q) => (facts[sessionId] && q ? searchResult : null),
    notifyDevices: async (n) => { sink.notified.push(n); },
    notifyEngine: async (n) => { sink.engineNotified.push(n); },
    registerInputTransform: (id, hook) => sink.reg.register(id, hook),
    paneTerminalStream: (sessionId, cols, rows) => {
      sink.termOpens.push({ sessionId, cols, rows });
      const s: TerminalSession = { resize() {}, input() {}, scroll() {}, release() {} };
      return facts[sessionId] ? s : null;
    },
  };
}

const hostWiring: HostWiring = { sessionFor: () => null, deliverText: async () => ({ ok: true }) };

/* ------------------------------- host verbs ------------------------------- */

test("the host verbs are the plugin's own scope", async () => {
  const core = makePluginCore("demo", hostWiring, servicesOf(sinkOf()));
  await core.store().put("cfg", { a: 1 });
  expect(await core.store().get("cfg")).toEqual({ a: 1 });
  await core.agentStore("ag-x1").put("k", 7);
  expect(await core.agentStore("ag-x1").get("k")).toBe(7);
  // the store dir is under the plugin id, proving the scope binding
  expect(core.store().dir).toContain(join("plugins", "demo"));
});

test("two plugins over the same wiring never share a store", async () => {
  const a = makePluginCore("alpha", hostWiring, servicesOf(sinkOf()));
  const b = makePluginCore("beta", hostWiring, servicesOf(sinkOf()));
  await a.store().put("who", "alpha");
  await b.store().put("who", "beta");
  expect(await a.store().get("who")).toBe("alpha");
  expect(await b.store().get("who")).toBe("beta");
  // and the agent axis is scoped by BOTH the agent and the plugin
  expect(a.agentStore("ag-1").dir).not.toBe(b.agentStore("ag-1").dir);
  expect(a.agentStore("ag-1").dir).not.toBe(a.agentStore("ag-2").dir);
});

test("agentIds enumerates the scopes on disk, not the sessions the engine knows", async () => {
  const core = makePluginCore("enum", hostWiring, servicesOf(sinkOf()));
  // no session ever existed for either of these; the store write is what makes
  // the scope, which is exactly what agentIds() reports
  await core.agentStore("ag-zeta").put("k", 1);
  await core.agentStore("ag-alpha").put("k", 1);
  const ids = await core.agentIds();
  expect(ids).toContain("ag-alpha");
  expect(ids).toContain("ag-zeta");
  expect([...ids].sort()).toEqual(ids); // sorted, so a caller can diff two reads
});

test("deliver carries the host's three answers back to the plugin unchanged", async () => {
  const sent: { how: string; note?: string; text: string }[] = [];
  // (a) no live session: retriable, because a snapshot may simply not exist yet
  const noSession = makePluginCore("demo", hostWiring, servicesOf(sinkOf()));
  expect(await noSession.deliver("ag-x", { text: "hi" }))
    .toEqual({ ok: false, retriable: true, why: expect.stringContaining("no live session") });

  // (b) the guard: the pane moved to another directory, so nothing is delivered
  const live = makePluginCore("demo", {
    sessionFor: () => ({ cwd: "/proj/b" }),
    deliverText: async (_aid, m) => { sent.push(m); return { ok: true }; },
    realPathOf: async (p) => p,
  }, servicesOf(sinkOf()));
  const refused = await live.deliver("ag-x", { text: "hi", guardCwd: "/proj/a" });
  expect(refused.ok).toBe(false);
  expect(refused.retriable).toBeUndefined(); // waiting will not help
  expect(sent).toHaveLength(0);

  // (c) the happy path, with `how` defaulted from the plugin id
  expect(await live.deliver("ag-x", { text: "do it" })).toMatchObject({ ok: true });
  expect(sent).toEqual([{ how: "DEMO", note: undefined, text: "do it" }]);
});

/* -------------------------------- dispatch -------------------------------- */

test("read / command / has / usage forward through the dispatch", async () => {
  const sink = sinkOf();
  const core = makePluginCore("demo", hostWiring, servicesOf(sink));
  expect(await core.read("model", "s1")).toBe("claude-opus-4-8");
  expect(await core.read("contextPct", "s1")).toBe(55);
  expect(await core.read("status", "s1")).toBe("running");
  expect(await core.read("blocked", "s1")).toEqual({ ask: null, why: "unread" });
  expect(await core.read("model", "unknown")).toBeNull();
  expect(await core.command("compact", "s1")).toEqual({ ok: true, tell: "compacting this context" });
  expect(await core.command("sendText", "s1", { text: "hi" })).toEqual({ ok: true, tell: "typed" });
  expect(sink.muxTyped).toEqual(["hi"]); // brokered to the mux baseline, not invented here
  expect(core.has("compact", "s1")).toBe(true);
  expect(core.has("setModel", "s1")).toBe(false);
  // usage keys on the harness KIND now, and force defaults to false through core
  expect(await core.usage("claude")).toEqual({ shape: "claude", n: 1, forced: false });
  expect(await core.usage("claude", true)).toEqual({ shape: "claude", n: 1, forced: true });
  // harnesses() forwards the wiring's kinds + live-agent flags untouched
  expect(core.harnesses()).toEqual([{ kind: "claude", active: true }, { kind: "codex", active: false }]);
});

test("read('transcript') passes its windowing options straight through", async () => {
  const core = makePluginCore("demo", hostWiring, servicesOf(sinkOf()));
  transcriptOpts.length = 0;
  const tr = await core.read("transcript", "s1", { limit: 5, before: 99 });
  expect(tr?.harnessSessionId).toBe("csid");
  // a forwarder that dropped opts would still answer a transcript, so the opts
  // themselves are the assertion
  expect(transcriptOpts).toEqual([{ limit: 5, before: 99 }]);
});

test("a command the harness cannot do is ANSWERED, not thrown", async () => {
  const core = makePluginCore("demo", hostWiring, servicesOf(sinkOf()));
  const r = await core.command("setModel", "s1", { model: "haiku" });
  expect(r.ok).toBe(false);
  expect(r.tell).toBe("switching the model is not supported for Claude yet");
  const gone = await core.command("compact", "unknown");
  expect(gone).toEqual({ ok: false, tell: "that session is not known to this engine" });
});

/* ----------------------------- core services ------------------------------ */

test("the core services are plain members reached directly", async () => {
  const sink = sinkOf();
  const core = makePluginCore("demo", hostWiring, servicesOf(sink));
  expect(await core.tts.list()).toEqual(["Aria", "Kai"]);
  expect(await core.tts.sample("Aria")).toBe("YmFzZTY0");
  expect(sink.sampled).toEqual(["Aria"]);
  expect(core.searchChat("s1", "hello")?.total).toBe(1);
  expect(core.searchChat("unknown", "hello")).toBeNull();
  await core.notifyDevices({ title: "T", body: "B", sessionId: "s1" });
  expect(sink.notified).toEqual([{ title: "T", body: "B", sessionId: "s1" }]);
  // the engine-level, session-less push forwards to its own backer, untouched
  await core.notifyEngine({ plugin: "usage-card", title: "93% of the 5-hour limit", body: "acct · resets soon", subTag: "5 hours", open: "usage:linux" });
  expect(sink.engineNotified).toEqual([
    { plugin: "usage-card", title: "93% of the 5-hour limit", body: "acct · resets soon", subTag: "5 hours", open: "usage:linux" },
  ]);
});

test("tts.sample answers null rather than guessing when the engine cannot render", async () => {
  const core = makePluginCore("voice", hostWiring, servicesOf(sinkOf()));
  expect(await core.tts.sample("")).toBeNull();
});

test("notifyDevices carries the optional tag through untouched", async () => {
  const sink = sinkOf();
  const core = makePluginCore("usage-card", hostWiring, servicesOf(sink));
  await core.notifyDevices({ title: "T", body: "B", sessionId: "s1", tag: "usage" });
  expect(sink.notified[0].tag).toBe("usage"); // no reshaping on the way out
});

/* ------------------------------ inputTransform ---------------------------- */

test("inputTransform registers a hook under the plugin id", () => {
  const sink = sinkOf();
  const core = makePluginCore("dials", hostWiring, servicesOf(sink));
  core.inputTransform(() => ({ postfix: "\n(reply briefly)" }));
  const hooks = sink.reg.hooks();
  expect(hooks).toHaveLength(1);
  const input: OutgoingInput = { sessionId: "s1", text: "do it", channels: ["chat"] };
  expect(hooks[0](input)).toEqual({ postfix: "\n(reply briefly)" });
});

test("the registry is keyed by plugin id: re-registering replaces, it never stacks", () => {
  const sink = sinkOf();
  const dials = makePluginCore("dials", hostWiring, servicesOf(sink));
  dials.inputTransform(() => ({ postfix: "one" }));
  dials.inputTransform(() => ({ postfix: "two" }));
  expect(sink.reg.hooks()).toHaveLength(1); // a reload must not double the postfix
  expect(sink.reg.hooks()[0]({ sessionId: "s1", text: "t", channels: [] })).toEqual({ postfix: "two" });

  // a second plugin is a second entry, and clear() removes only its own
  const other = makePluginCore("ctx", hostWiring, { ...servicesOf(sink), registerInputTransform: (id, h) => sink.reg.register(id, h) });
  other.inputTransform(() => ({ prefix: "ctx: " }));
  expect(sink.reg.hooks()).toHaveLength(2);
  sink.reg.clear("ctx");
  expect(sink.reg.hooks()).toHaveLength(1);
  expect(sink.reg.hooks()[0]({ sessionId: "s1", text: "t", channels: [] })).toEqual({ postfix: "two" });
});

test("a hook that returns nothing leaves the message untouched", () => {
  const sink = sinkOf();
  const core = makePluginCore("quiet", hostWiring, servicesOf(sink));
  core.inputTransform(() => {});
  expect(sink.reg.hooks()[0]({ sessionId: "s1", text: "t", channels: [] })).toBeUndefined();
});

/* ---------------------------- paneTerminalStream -------------------------- */

test("paneTerminalStream opens the pane byte stream, null when the session is unknown", () => {
  const sink = sinkOf();
  const core = makePluginCore("tui", hostWiring, servicesOf(sink));
  const h: TerminalHandlers = { onFrame() {}, onSize() {}, onClosed() {} };
  expect(core.paneTerminalStream("s1", 80, 24, h)).not.toBeNull();
  expect(core.paneTerminalStream("unknown", 80, 24, h)).toBeNull();
  // the geometry is the plugin's, not a default the forwarder invented
  expect(sink.termOpens).toEqual([
    { sessionId: "s1", cols: 80, rows: 24 },
    { sessionId: "unknown", cols: 80, rows: 24 },
  ]);
});

test("a plugin never receives an adapter reference, only values", async () => {
  const core = makePluginCore("demo", hostWiring, servicesOf(sinkOf()));
  /* The dumb-forwarder rule with teeth: no member of PluginCore hands back
   * anything holding a SessionRef, a mux handle or a harness object. If any of
   * these ever started answering with the live object, this walk would find the
   * pane handle in it. */
  const answers = [
    await core.read("model", "s1"),
    await core.read("contextPct", "s1"),
    await core.read("blocked", "s1"),
    await core.command("compact", "s1"),
    await core.usage("claude"),
    core.searchChat("s1", "hello"),
  ];
  expect(JSON.stringify(answers)).not.toContain("pane-1");
});
