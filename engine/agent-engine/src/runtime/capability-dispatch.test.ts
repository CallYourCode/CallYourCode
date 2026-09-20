/* THE CAPABILITY DISPATCH, standalone. Proves the dumb-forwarder:
 * resolve-and-forward, harness-native-first input brokering with mux fallback,
 * absence answered (never policed), and SessionRef built here and never leaked.
 *
 *   bun test agent-engine/src/runtime/capability-dispatch.test.ts
 */

import { test, expect } from "bun:test";
import { makeCapabilityDispatch, type DispatchSessionFacts, type DispatchWiring, type MuxInputBaseline } from "./capability-dispatch.ts";
import type { HarnessCapabilities, SessionRef, CommandResult, TranscriptOpts } from "./capabilities.ts";
import type { AgentConversation } from "../readers/types.ts";

const emptyConversation = (harnessSessionId: string | null): AgentConversation => ({
  harnessSessionId, model: null, contextPct: null, title: null, blocked: null,
  lifecycle: "running", messages: [], events: [], runs: [],
});

/* A claude-shaped harness: meta reads answer, compact + usage present, but NO
 * native input path (sendText/interrupt undefined) so input falls to the mux. */
function claudeCaps(seen: SessionRef[], opts?: (TranscriptOpts | undefined)[]): HarnessCapabilities {
  return {
    model: async (s) => { seen.push(s); return "claude-opus-4-8"; },
    context: async () => ({ used: 420_000, total: 1_000_000, pct: 42 }),
    transcript: async (s, o) => { opts?.push(o); return emptyConversation(s.harnessSessionId); },
    status: () => "running",
    blocked: async () => ({ ask: null, why: "unread" }),
    compact: async () => ({ ok: true, tell: "compacting this context" }),
    // usage is an ACCOUNT fact: no SessionRef, only the force flag; `forced`
    // rides back so a test proves the flag reached the adapter untouched.
    usage: async (force) => ({ windows: [], account: "acct", fetchedAt: 123, forced: force }),
  };
}

/* Everything the interface allows, so the ARGUMENT plumbing of the three
 * harness-meaning commands can be asserted rather than just their presence. */
function fullCaps(log: string[]): HarnessCapabilities {
  return {
    model: async () => "m",
    context: async () => ({ used: 1, total: 100, pct: 1 }),
    transcript: async (s) => emptyConversation(s.harnessSessionId),
    status: () => "running",
    blocked: async () => ({ ask: null, why: "unread" }),
    compact: async () => { log.push("compact"); return { ok: true, tell: "compacted" }; },
    setModel: async (_s, model) => { log.push(`setModel:${model}`); return { ok: true, tell: `model is ${model}` }; },
    answer: async (_s, choice, fp) => { log.push(`answer:${choice}:${fp}`); return { ok: true, tell: "pressed" }; },
  };
}

/* A codex-shaped harness: meta reads answer, but NO compact, NO usage, NO native
 * input (all the absent-member cases in one adapter). */
function codexCaps(): HarnessCapabilities {
  return {
    model: async () => "gpt-5.6-sol",
    context: async () => ({ used: null, total: null, pct: 10 }),
    transcript: async (s) => emptyConversation(s.harnessSessionId),
    status: () => "started",
    blocked: async () => ({ ask: null, why: "unsupported" }),
  };
}

/* A piagent-shaped harness: it OWNS its input path (the native-override example),
 * so the broker must route input straight into it and never touch the mux. */
function nativeInputCaps(log: string[]): HarnessCapabilities {
  return {
    model: async () => null,
    context: async () => null,
    transcript: async (s) => emptyConversation(s.harnessSessionId),
    status: () => "running",
    blocked: async () => ({ ask: null, why: "unsupported" }),
    sendText: async (_s, text) => { log.push(`native:${text}`); return { ok: true, tell: "native send" }; },
    interrupt: async () => { log.push("native:interrupt"); return { ok: true, tell: "native interrupt" }; },
  };
}

function wiringOf(
  facts: Record<string, DispatchSessionFacts>,
  harness: Record<string, HarnessCapabilities>,
  muxLog: string[],
  kinds?: { kind: string; active: boolean }[],
): DispatchWiring {
  const muxInput: MuxInputBaseline = {
    sendText: async (ref, text) => { muxLog.push(`mux:${ref.handle}:${text}`); return { ok: true, tell: "typed" }; },
    interrupt: async (ref) => { muxLog.push(`mux:${ref.handle}:interrupt`); return { ok: true, tell: "sent ctrl-c" }; },
  };
  return {
    sessionOf: (id) => facts[id],
    harnessFor: (kind) => harness[kind] ?? null,
    // default: every wired kind, all active (the usage/harnesses tests override)
    harnessKinds: () => kinds ?? Object.keys(harness).map((kind) => ({ kind, active: true })),
    muxInput,
  };
}

const claudeFacts: DispatchSessionFacts = {
  handle: "pane-1", cwd: "/w/claude", harnessSessionId: "csid-1", kind: "claude",
  name: "Claude", viaMux: true, alive: true,
};
const codexFacts: DispatchSessionFacts = {
  handle: "pane-2", cwd: "/w/codex", harnessSessionId: "csid-2", kind: "codex",
  name: "Codex", viaMux: true, alive: true,
};
const piFacts: DispatchSessionFacts = {
  handle: "pane-3", cwd: "/w/pi", harnessSessionId: null, kind: "pi",
  name: "Pi", viaMux: true, alive: true,
};

test("read forwards each meta read to the session's harness and builds the SessionRef", async () => {
  const seen: SessionRef[] = [];
  const d = makeCapabilityDispatch(wiringOf(
    { a: claudeFacts }, { claude: claudeCaps(seen) }, [],
  ));
  expect(await d.read("model", "a")).toBe("claude-opus-4-8");
  expect(await d.read("contextPct", "a")).toBe(42);
  expect(await d.read("status", "a")).toBe("running");
  expect(await d.read("blocked", "a")).toEqual({ ask: null, why: "unread" });
  const tr = await d.read("transcript", "a");
  expect(tr?.harnessSessionId).toBe("csid-1");
  // the SessionRef the dispatch built carries the facts, and only the facts
  expect(seen[0]).toEqual({ handle: "pane-1", cwd: "/w/claude", harnessSessionId: "csid-1" });
});

test("read answers null for an unknown session or a name-only agent", async () => {
  const d = makeCapabilityDispatch(wiringOf({ a: claudeFacts }, {}, []));
  expect(await d.read("model", "missing")).toBeNull();  // no such session
  expect(await d.read("model", "a")).toBeNull();          // no harness for kind
});

test("command sendText/interrupt fall back to the mux baseline when the harness has no native path", async () => {
  const muxLog: string[] = [];
  const d = makeCapabilityDispatch(wiringOf(
    { a: claudeFacts }, { claude: claudeCaps([]) }, muxLog,
  ));
  const r: CommandResult = await d.command("sendText", "a", { text: "hi" });
  expect(r).toEqual({ ok: true, tell: "typed" });
  await d.command("interrupt", "a");
  expect(muxLog).toEqual(["mux:pane-1:hi", "mux:pane-1:interrupt"]);
});

test("command routes input into the harness-native path when present, never the mux", async () => {
  const native: string[] = [];
  const muxLog: string[] = [];
  const d = makeCapabilityDispatch(wiringOf(
    { a: piFacts }, { pi: nativeInputCaps(native) }, muxLog,
  ));
  expect(await d.command("sendText", "a", { text: "yo" })).toEqual({ ok: true, tell: "native send" });
  expect(await d.command("interrupt", "a")).toEqual({ ok: true, tell: "native interrupt" });
  expect(native).toEqual(["native:yo", "native:interrupt"]);
  expect(muxLog).toEqual([]); // the mux baseline was never touched
});

test("command forwards compact to the harness and answers absence with {ok:false, tell}", async () => {
  const d = makeCapabilityDispatch(wiringOf(
    { a: claudeFacts, b: codexFacts }, { claude: claudeCaps([]), codex: codexCaps() }, [],
  ));
  expect(await d.command("compact", "a")).toEqual({ ok: true, tell: "compacting this context" });
  const refused = await d.command("compact", "b");
  expect(refused.ok).toBe(false);
  expect(refused.tell).toBe("compacting from here is not supported for Codex yet");
});

test("command answers an unknown session without touching any harness", async () => {
  const d = makeCapabilityDispatch(wiringOf({}, {}, []));
  const r = await d.command("compact", "nope");
  expect(r.ok).toBe(false);
  expect(r.tell).toBe("that session is not known to this engine");
});

test("has: input available on a live mux session, per-harness presence for the rest", async () => {
  const d = makeCapabilityDispatch(wiringOf(
    { a: claudeFacts, b: codexFacts }, { claude: claudeCaps([]), codex: codexCaps() }, [],
  ));
  // input: claude has no native path but is a live mux session -> baseline answers
  expect(d.has("sendText", "a")).toBe(true);
  expect(d.has("interrupt", "a")).toBe(true);
  // compact: present on claude, absent on codex
  expect(d.has("compact", "a")).toBe(true);
  expect(d.has("compact", "b")).toBe(false);
  // setModel/answer absent on both fakes
  expect(d.has("setModel", "a")).toBe(false);
  expect(d.has("answer", "a")).toBe(false);
  // unknown session
  expect(d.has("sendText", "missing")).toBe(false);
});

test("has: a dead or non-mux session has no input baseline", () => {
  const dead: DispatchSessionFacts = { ...claudeFacts, alive: false };
  const offMux: DispatchSessionFacts = { ...claudeFacts, viaMux: false };
  const d = makeCapabilityDispatch(wiringOf(
    { dead, offMux }, { claude: claudeCaps([]) }, [],
  ));
  expect(d.has("sendText", "dead")).toBe(false);
  expect(d.has("sendText", "offMux")).toBe(false);
});

test("usage keys on the harness KIND, forwards its own shape, threads force, never reshapes", async () => {
  const d = makeCapabilityDispatch(wiringOf(
    { a: claudeFacts, b: codexFacts }, { claude: claudeCaps([]), codex: codexCaps() }, [],
  ));
  // keyed by kind, not a session id; the ADAPTER's shape comes back untouched
  expect(await d.usage("claude", false)).toEqual({ windows: [], account: "acct", fetchedAt: 123, forced: false });
  // force threads straight through to the adapter (the refresh button)
  expect(await d.usage("claude", true)).toEqual({ windows: [], account: "acct", fetchedAt: 123, forced: true });
  expect(await d.usage("codex", false)).toBeUndefined();   // codex has no usage member
  expect(await d.usage("nobody", false)).toBeUndefined();  // no adapter for the kind
});

test("harnesses forwards the wiring's kinds with their live-agent flags, untouched", async () => {
  const kinds = [{ kind: "claude", active: false }, { kind: "codex", active: true }, { kind: "opencode", active: false }];
  const d = makeCapabilityDispatch(wiringOf(
    { a: claudeFacts }, { claude: claudeCaps([]) }, [], kinds,
  ));
  expect(d.harnesses()).toEqual(kinds);
});

test("read('transcript') hands the windowing options to the adapter untouched", async () => {
  const opts: (TranscriptOpts | undefined)[] = [];
  const d = makeCapabilityDispatch(wiringOf({ a: claudeFacts }, { claude: claudeCaps([], opts) }, []));
  await d.read("transcript", "a", { limit: 20, before: 900, maxBytes: 4096 });
  await d.read("transcript", "a");
  // dropping opts would still answer a transcript, so the opts ARE the assertion
  expect(opts).toEqual([{ limit: 20, before: 900, maxBytes: 4096 }, undefined]);
});

test("every read answers null for a name-only agent, not a half-filled shape", async () => {
  const d = makeCapabilityDispatch(wiringOf({ a: claudeFacts }, {}, []));
  for (const k of ["model", "contextPct", "transcript", "status", "blocked"] as const) {
    expect(await d.read(k, "a")).toBeNull();
  }
});

test("compact / setModel / answer forward their arguments, not just the call", async () => {
  const log: string[] = [];
  const d = makeCapabilityDispatch(wiringOf({ a: { ...claudeFacts, kind: "full" } }, { full: fullCaps(log) }, []));
  expect(await d.command("compact", "a")).toEqual({ ok: true, tell: "compacted" });
  expect(await d.command("setModel", "a", { model: "opus" })).toEqual({ ok: true, tell: "model is opus" });
  expect(await d.command("answer", "a", { choice: "2", fingerprint: "fp-9" })).toEqual({ ok: true, tell: "pressed" });
  expect(log).toEqual(["compact", "setModel:opus", "answer:2:fp-9"]);
});

test("missing command arguments become empty strings, never undefined on the wire", async () => {
  const log: string[] = [];
  const muxLog: string[] = [];
  const d = makeCapabilityDispatch(wiringOf({ a: { ...claudeFacts, kind: "full" } }, { full: fullCaps(log) }, muxLog));
  await d.command("setModel", "a");
  await d.command("answer", "a");
  await d.command("sendText", "a");
  // an adapter that string-formats its argument must never render "undefined"
  expect(log).toEqual(["setModel:", "answer::"]);
  expect(muxLog).toEqual(["mux:pane-1:"]);
});

test("setModel and answer absence get their own sentence, named for the agent", async () => {
  const d = makeCapabilityDispatch(wiringOf({ b: codexFacts }, { codex: codexCaps() }, []));
  expect((await d.command("setModel", "b", { model: "x" })).tell)
    .toBe("switching the model is not supported for Codex yet");
  expect((await d.command("answer", "b", { choice: "1", fingerprint: "f" })).tell)
    .toBe("answering from here is not supported for Codex yet");
});

test("a harness with no adapter at all still gets the mux input baseline", async () => {
  /* A name-only agent: harnessFor answers null. Reads go dark (above), but the
   * pane is still a pane, so typing into it must keep working; only the harness
   * MEANINGS are unavailable. */
  const muxLog: string[] = [];
  const d = makeCapabilityDispatch(wiringOf({ a: claudeFacts }, {}, muxLog));
  expect(await d.command("sendText", "a", { text: "hi" })).toEqual({ ok: true, tell: "typed" });
  expect(await d.command("interrupt", "a")).toEqual({ ok: true, tell: "sent ctrl-c" });
  expect(muxLog).toEqual(["mux:pane-1:hi", "mux:pane-1:interrupt"]);
  expect((await d.command("compact", "a")).tell).toBe("compacting from here is not supported for Claude yet");
});

test("brokering is per member: a native sendText does not drag interrupt with it", async () => {
  /* piagent grew its native lane control one member at a time. The broker asks
   * about EACH member, so a half-native adapter must still reach the mux for the
   * half it does not implement. */
  const muxLog: string[] = [];
  const halfNative: HarnessCapabilities = {
    model: async () => null,
    context: async () => null,
    transcript: async (s) => emptyConversation(s.harnessSessionId),
    status: () => "running",
    blocked: async () => ({ ask: null, why: "unsupported" }),
    sendText: async () => ({ ok: true, tell: "native send" }),
  };
  const d = makeCapabilityDispatch(wiringOf({ a: piFacts }, { pi: halfNative }, muxLog));
  expect(await d.command("sendText", "a", { text: "yo" })).toEqual({ ok: true, tell: "native send" });
  expect(await d.command("interrupt", "a")).toEqual({ ok: true, tell: "sent ctrl-c" });
  expect(muxLog).toEqual(["mux:pane-3:interrupt"]);
  // has() has to agree with where command() actually went
  expect(d.has("sendText", "a")).toBe(true);
  expect(d.has("interrupt", "a")).toBe(true); // via the live mux baseline
});

test("has: a native input path answers true even on a dead, off-mux session", () => {
  /* piagent's lane is not the pane. If the mux pane is gone, its own input path
   * is still there, so greying the send button would be wrong. */
  const native: string[] = [];
  const offline: DispatchSessionFacts = { ...piFacts, viaMux: false, alive: false };
  const d = makeCapabilityDispatch(wiringOf({ a: offline }, { pi: nativeInputCaps(native) }, []));
  expect(d.has("sendText", "a")).toBe(true);
  expect(d.has("interrupt", "a")).toBe(true);
  expect(d.has("compact", "a")).toBe(false);
});

test("command does not police liveness: refusal is the mux baseline's to give", async () => {
  /* The dispatch NEVER refuses (section 4). A dead session still forwards to the
   * baseline, which is the layer that owns the "pane not ready" sentence. If the
   * dispatch ever started short-circuiting here, this refusal would change
   * wording and the app would show the wrong reason. */
  const muxLog: string[] = [];
  const wiring = wiringOf({ dead: { ...claudeFacts, alive: false } }, { claude: claudeCaps([]) }, muxLog);
  wiring.muxInput = {
    sendText: async () => ({ ok: false, tell: "that pane is not ready" }),
    interrupt: async () => ({ ok: false, tell: "that pane is not ready" }),
  };
  const d = makeCapabilityDispatch(wiring);
  expect(await d.command("sendText", "dead", { text: "hi" })).toEqual({ ok: false, tell: "that pane is not ready" });
  expect(d.has("sendText", "dead")).toBe(false); // but the button is greyed
});

test("the dispatch resolves the session on EVERY call, never caching facts", async () => {
  /* A pane can be rebound under a session id (the pane-identity bug). If the
   * dispatch memoized sessionOf, a read after a rebind would answer for the old
   * pane, which is precisely the failure that rollover chased for weeks. */
  const seen: SessionRef[] = [];
  let facts: DispatchSessionFacts = { ...claudeFacts, handle: "pane-1" };
  const d = makeCapabilityDispatch({
    sessionOf: (id) => (id === "a" ? facts : undefined),
    harnessFor: () => claudeCaps(seen),
    harnessKinds: () => [{ kind: "claude", active: true }],
    muxInput: { sendText: async () => ({ ok: true, tell: "" }), interrupt: async () => ({ ok: true, tell: "" }) },
  });
  await d.read("model", "a");
  facts = { ...facts, handle: "pane-9", cwd: "/w/moved" };
  await d.read("model", "a");
  expect(seen.map((s) => s.handle)).toEqual(["pane-1", "pane-9"]);
  expect(seen[1].cwd).toBe("/w/moved");
});
