/* The pi output EXTENSION artifact (engine/harness/pi/cyc-output.js), driven
 * against a stub `pi` and a real unix socket the test listens on. It proves:
 *  - session_start sends a {t:"pi.session"} identity frame;
 *  - a message_end and a tool_call send {t:"pi.event"} frames with stable ids;
 *  - a handler throwing internally never crashes (the transcript path covers);
 *  - with no CYC_PI_EVENT_SOCK it streams nothing but still announces identity.
 *
 * No real pi: the stub records pi.on handlers so the test emits events itself.
 *
 *   bun test agent-engine/src/adapters/pi-extension.test.ts
 */

import { describe, expect, test, afterEach, beforeAll, afterAll } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
// the extension is plain CJS; import its factory (module.exports = activate)
import activate from "../../../harness/pi/cyc-output.js";
// @ts-expect-error CJS module, _internal is attached at runtime
import { _internal as piInternal } from "../../../harness/pi/cyc-output.js";

const announce = piInternal as {
  announceSession: (
    sessionId: string | undefined,
    cwd: string | null,
    env?: Record<string, string | undefined>,
  ) => Promise<void>;
  announcedSessions: Set<string>;
};

type Handler = (event: unknown, ctx: unknown) => void;

/** A stub pi whose `on` records handlers so the test can emit events. `throwOn`
 *  makes pi.on throw for one event (an old pi missing that event). */
function stubPi(throwOn?: string) {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    on(name: string, fn: Handler) {
      if (name === throwOn) throw new Error(`no such event: ${name}`);
      handlers.set(name, fn);
    },
    emit(name: string, event: unknown, ctx: unknown) {
      handlers.get(name)?.(event, ctx);
    },
  };
}

/** A fake engine: the unix socket server the extension connects to. Collects
 *  parsed frames and lets a test await the actual events it needs (the client
 *  connecting, a frame matching a predicate) instead of a blind wall-clock
 *  delay. */
async function fakeEngine(sockPath: string) {
  const frames: any[] = [];
  const sockets = new Set<Socket>();
  const frameListeners = new Set<(frame: any) => void>();
  let resolveConnected: () => void;
  const connected = new Promise<void>((r) => { resolveConnected = r; });
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    resolveConnected();
    let buf = "";
    socket.on("data", (c) => {
      buf += c.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          const frame = JSON.parse(line);
          frames.push(frame);
          for (const fn of frameListeners) fn(frame);
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(sockPath, () => r()));
  return {
    frames,
    connected,
    /** Resolves with the first frame matching predicate, already-received or
     *  yet to arrive: the frame event itself, not the wall clock. */
    waitForFrame(predicate: (frame: any) => boolean) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<any>((resolve) => {
        const fn = (frame: any) => {
          if (predicate(frame)) {
            frameListeners.delete(fn);
            resolve(frame);
          }
        };
        frameListeners.add(fn);
      });
    },
    close() {
      for (const s of sockets) try { s.destroy(); } catch { /* ignore */ }
      try { server.close(); } catch { /* ignore */ }
      try { unlinkSync(sockPath); } catch { /* ignore */ }
    },
  };
}

const ctxFor = (leafId?: string) => ({
  cwd: "/work",
  model: { id: "grok-4.6" },
  sessionManager: {
    getSessionId: () => "sess-abc",
    getLeafEntry: () => (leafId ? { id: leafId } : undefined),
    getLeafId: () => leafId ?? null,
  },
});

// HERMETIC ANNOUNCE GUARD. session_start now fires an HTTP announce to
// AGENT_PORT (default 10101). Pin it at a refused loopback port for the whole
// file so no session_start emitted by these tests can reach a real engine on
// :10101; the announce is fail-silent, so a refused port is a no-op. Tests
// that assert the POST override AGENT_PORT at their own capture server.
let prevAgentPort: string | undefined;
beforeAll(() => { prevAgentPort = process.env.AGENT_PORT; process.env.AGENT_PORT = "1"; });
afterAll(() => {
  if (prevAgentPort === undefined) delete process.env.AGENT_PORT;
  else process.env.AGENT_PORT = prevAgentPort;
});

let cleanup: (() => void) | null = null;
afterEach(() => { delete process.env.CYC_PI_EVENT_SOCK; if (cleanup) { cleanup(); cleanup = null; } });

describe("the pi output extension", () => {
  test("streams session identity, a message and a tool as frames with stable ids", async () => {
    const sockPath = join(tmpdir(), `pi-ext-${process.pid}-${Date.now()}.sock`);
    const engine = await fakeEngine(sockPath);
    cleanup = () => engine.close();
    process.env.CYC_PI_EVENT_SOCK = sockPath;

    const pi = stubPi();
    activate(pi as any);
    await engine.connected; // the client socket connects

    pi.emit("session_start", { type: "session_start", reason: "new" }, ctxFor("leaf-0"));
    pi.emit("turn_start", { type: "turn_start", turnIndex: 0 }, ctxFor("leaf-0"));
    pi.emit("message_end",
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "all done" }], timestamp: 111 } },
      ctxFor("leaf-1"));
    pi.emit("tool_call",
      { type: "tool_call", toolCallId: "call-7", toolName: "bash", input: { command: "ls -la" } },
      ctxFor("leaf-1"));
    pi.emit("agent_end", { type: "agent_end", messages: [] }, ctxFor("leaf-1"));
    // agent_end's idle status is the last frame this run produces: waiting for
    // it off the wall clock guarantees every earlier frame already arrived.
    await engine.waitForFrame((f) => f.t === "pi.event" && f.kind === "status" && f.status === "idle");

    const session = engine.frames.find((f) => f.t === "pi.session");
    expect(session).toMatchObject({ sessionId: "sess-abc", cwd: "/work", model: "grok-4.6" });

    const reply = engine.frames.find((f) => f.t === "pi.event" && f.kind === "reply");
    expect(reply).toMatchObject({ kind: "reply", id: "leaf-1", text: "all done" });

    const tool = engine.frames.find((f) => f.t === "pi.event" && f.kind === "tool");
    expect(tool).toMatchObject({ kind: "tool", id: "call-7", tool: "bash", text: "ls -la" });

    const statuses = engine.frames.filter((f) => f.t === "pi.event" && f.kind === "status").map((f) => f.status);
    expect(statuses).toEqual(["working", "idle"]);
  });

  test("a handler throwing internally never crashes, and later frames still flow", async () => {
    const sockPath = join(tmpdir(), `pi-ext-throw-${process.pid}-${Date.now()}.sock`);
    const engine = await fakeEngine(sockPath);
    cleanup = () => engine.close();
    process.env.CYC_PI_EVENT_SOCK = sockPath;

    const pi = stubPi();
    activate(pi as any);
    await engine.connected;

    // a ctx whose accessor throws: the safe() wrapper must swallow it
    const boomCtx = { cwd: "/w", model: { id: "m" }, sessionManager: { getLeafEntry() { throw new Error("boom"); }, getSessionId() { return "s"; } } };
    expect(() => pi.emit("message_end",
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }], timestamp: 1 } },
      boomCtx)).not.toThrow();

    // a good tool frame after the throw still gets through
    pi.emit("tool_call", { type: "tool_call", toolCallId: "call-ok", toolName: "read", input: { path: "/f" } }, ctxFor("leaf"));
    await engine.waitForFrame((f) => f.t === "pi.event" && f.id === "call-ok");
    expect(engine.frames.some((f) => f.t === "pi.event" && f.id === "call-ok")).toBe(true);
  });

  test("the pi.session frame keeps its sessionId even when cwd/model getters throw", async () => {
    // pi's real ExtensionContext exposes cwd/model as GETTERS that call
    // assertActive() first, which throws for a stale instance after a reload.
    // The sessionId is what the engine binds the pane from, so it must survive
    // a throwing cwd/model read rather than the whole identity frame being lost.
    const sockPath = join(tmpdir(), `pi-ext-getter-${process.pid}-${Date.now()}.sock`);
    const engine = await fakeEngine(sockPath);
    cleanup = () => engine.close();
    process.env.CYC_PI_EVENT_SOCK = sockPath;

    const pi = stubPi();
    activate(pi as any);
    await engine.connected;

    const staleCtx = {
      get cwd(): string { throw new Error("stale"); },
      get model(): { id: string } { throw new Error("stale"); },
      sessionManager: { getSessionId: () => "sess-live" },
    };
    expect(() => pi.emit("session_start", { type: "session_start", reason: "reload" }, staleCtx)).not.toThrow();

    const session = await engine.waitForFrame((f) => f.t === "pi.session");
    expect(session.sessionId).toBe("sess-live");
    expect(session.cwd).toBeUndefined();
    expect(session.model).toBeUndefined();
  });

  /* A plain `pi` (loaded from pi's global extensions, not launched by cyc) has
   * no event socket, but it MUST still announce its session id: without it the
   * engine never binds the pane's harness session, never tails the transcript,
   * and the app shows replies with no session rows. So: no stream handlers,
   * exactly one session_start handler, and firing it POSTs the announce. */
  test("without CYC_PI_EVENT_SOCK it streams nothing but still announces", async () => {
    delete process.env.CYC_PI_EVENT_SOCK;
    const posts: any[] = [];
    let got: (b: any) => void = () => {};
    const posted = new Promise<any>((r) => { got = r; });
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json().catch(() => null);
        posts.push({ path: new URL(req.url).pathname, body });
        got(body);
        return new Response("ok");
      },
    });
    const prevPort = process.env.AGENT_PORT;
    process.env.AGENT_PORT = String(server.port);
    try {
      const pi = stubPi();
      activate(pi as any);
      expect([...pi.handlers.keys()]).toEqual(["tool_call", "session_start"]);
      pi.emit("session_start", { type: "session_start", reason: "startup" }, ctxFor());
      const body = await posted;
      expect(posts).toHaveLength(1);
      expect(posts[0].path).toBe("/harness/announce");
      expect(body).toMatchObject({ sessionId: "sess-abc", cwd: "/work", harness: "pi" });
    } finally {
      process.env.AGENT_PORT = prevPort;
      server.stop(true);
      announce.announcedSessions.clear();
    }
  });

  /* The capture-race fix: the identity is re-announced whenever the socket
   * (re)connects, so a session_start that fired before the engine listener was
   * ready still binds the pane. Driven with a FAKE sink whose connect timing
   * the test controls (no real socket): the sink is best-effort and only
   * "delivers" while connected, exactly as the real one drops before connect. */
  function fakeSink() {
    const sent: any[] = [];
    let connected = false;
    let onConnect: (() => void) | null = null;
    const sink = {
      send(frame: any) { if (connected) sent.push(frame); },
      close() {},
    };
    return {
      sent,
      make: (_sockPath: string, cb?: () => void) => { onConnect = cb ?? null; return sink; },
      connect() { connected = true; onConnect?.(); },
      drop() { connected = false; },
    };
  }

  test("session_start BEFORE connect -> exactly one pi.session is (re)sent on connect", () => {
    process.env.CYC_PI_EVENT_SOCK = "unused-with-a-fake-sink";
    const fs = fakeSink();
    const pi = stubPi();
    activate(pi as any, { makeSink: fs.make });

    // the session names itself before any listener is ready: dropped for now
    pi.emit("session_start", { type: "session_start", reason: "new" }, ctxFor());
    expect(fs.sent.filter((f) => f.t === "pi.session")).toHaveLength(0);

    // the socket comes up: the cached identity is re-announced, exactly once
    fs.connect();
    const sessions = fs.sent.filter((f) => f.t === "pi.session");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: "sess-abc", cwd: "/work", model: "grok-4.6" });
  });

  test("session_start AFTER connect -> sent once, no duplicate from the earlier connect", () => {
    process.env.CYC_PI_EVENT_SOCK = "unused-with-a-fake-sink";
    const fs = fakeSink();
    const pi = stubPi();
    activate(pi as any, { makeSink: fs.make });

    fs.connect(); // connect first, with nothing cached yet: no identity sent
    expect(fs.sent.filter((f) => f.t === "pi.session")).toHaveLength(0);

    pi.emit("session_start", { type: "session_start", reason: "new" }, ctxFor());
    expect(fs.sent.filter((f) => f.t === "pi.session")).toHaveLength(1);
  });

  test("a reconnect re-announces the identity", () => {
    process.env.CYC_PI_EVENT_SOCK = "unused-with-a-fake-sink";
    const fs = fakeSink();
    const pi = stubPi();
    activate(pi as any, { makeSink: fs.make });

    pi.emit("session_start", { type: "session_start", reason: "new" }, ctxFor());
    fs.connect();
    expect(fs.sent.filter((f) => f.t === "pi.session")).toHaveLength(1);

    fs.drop();
    fs.connect(); // a reconnect after a drop re-sends the cached identity
    expect(fs.sent.filter((f) => f.t === "pi.session")).toHaveLength(2);
  });

  /* THE HTTP IDENTITY ANNOUNCE (stage 1 of the adapter contract). pi now
   * POSTs its session id to /harness/announce, the same race-free path the
   * other three harnesses use, mirroring the opencode plugin's announceSession.
   * Driven against a local Bun.serve, exactly as callyourcode.test.ts does. */
  type Captured = { path: string; body: any };
  function serveCapture() {
    const captured: Captured[] = [];
    const waiters = new Set<(c: Captured) => void>();
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        let body: any = null;
        try { body = await req.json(); } catch { body = null; }
        const c = { path: url.pathname, body };
        captured.push(c);
        for (const w of waiters) w(c);
        return new Response("ok");
      },
    });
    return {
      port: server.port,
      captured,
      /** Resolve on the next captured request (the POST event itself, not the
       *  wall clock), so a fire-and-forget announce is awaited without sleeping. */
      waitForPost() {
        if (captured.length) return Promise.resolve(captured[captured.length - 1]);
        return new Promise<Captured>((resolve) => {
          const w = (c: Captured) => { waiters.delete(w); resolve(c); };
          waiters.add(w);
        });
      },
      stop: () => server.stop(true),
    };
  }

  afterEach(() => { announce.announcedSessions.clear(); });

  test("session start POSTs exactly one /harness/announce with the pi body", async () => {
    const s = serveCapture();
    const env = { AGENT_PORT: String(s.port), HERDR_PANE_ID: "w1:p3", TMUX_PANE: "%7" };
    try {
      await announce.announceSession("sess-pi-1", "/home/me/proj", env);
      // a second call for the same sid must not POST again (once per sid)
      await announce.announceSession("sess-pi-1", "/home/me/proj", env);
    } finally {
      s.stop();
    }
    expect(s.captured.length).toBe(1);
    const req = s.captured[0];
    expect(req.path).toBe("/harness/announce");
    expect(req.body).toMatchObject({
      sessionId: "sess-pi-1",
      pid: process.pid,
      cwd: "/home/me/proj",
      herdrPane: "w1:p3",
      tmuxPane: "%7",
      harness: "pi",
      event: "session_start",
    });
  });

  test("witnesses fall back to null when the env is bare", async () => {
    const s = serveCapture();
    const env = { AGENT_PORT: String(s.port) };
    try {
      await announce.announceSession("sess-pi-bare", null, env);
    } finally {
      s.stop();
    }
    expect(s.captured.length).toBe(1);
    expect(s.captured[0].body).toMatchObject({
      sessionId: "sess-pi-bare",
      cwd: null,
      herdrPane: null,
      tmuxPane: null,
      harness: "pi",
    });
  });

  test("a dead port swallows silently (no throw)", async () => {
    const s = serveCapture();
    const deadPort = s.port;
    s.stop();
    const env = { AGENT_PORT: String(deadPort) };
    await expect(announce.announceSession("sess-pi-dead", "/x", env)).resolves.toBeUndefined();
  });

  test("a missing sessionId never POSTs", async () => {
    const s = serveCapture();
    const env = { AGENT_PORT: String(s.port) };
    try {
      await announce.announceSession(undefined, "/x", env);
    } finally {
      s.stop();
    }
    expect(s.captured.length).toBe(0);
  });

  test("session_start fires exactly one announce through the real handler", async () => {
    const s = serveCapture();
    const sockPath = join(tmpdir(), `pi-ext-ann-${process.pid}-${Date.now()}.sock`);
    const engine = await fakeEngine(sockPath);
    cleanup = () => engine.close();
    process.env.CYC_PI_EVENT_SOCK = sockPath;
    const prevPort = process.env.AGENT_PORT;
    process.env.AGENT_PORT = String(s.port);
    try {
      const pi = stubPi();
      activate(pi as any);
      await engine.connected;
      pi.emit("session_start", { type: "session_start", reason: "new" }, ctxFor("leaf-0"));
      // the announce is fire-and-forget (void); await the POST event itself
      await s.waitForPost();
    } finally {
      s.stop();
      if (prevPort === undefined) delete process.env.AGENT_PORT;
      else process.env.AGENT_PORT = prevPort;
    }
    const posts = s.captured.filter((c) => c.path === "/harness/announce");
    expect(posts.length).toBe(1);
    expect(posts[0].body).toMatchObject({ sessionId: "sess-abc", harness: "pi", event: "session_start" });
  });

  test("an old pi missing an event (pi.on throws) does not abort the rest", async () => {
    const sockPath = join(tmpdir(), `pi-ext-old-${process.pid}-${Date.now()}.sock`);
    const engine = await fakeEngine(sockPath);
    cleanup = () => engine.close();
    process.env.CYC_PI_EVENT_SOCK = sockPath;

    const pi = stubPi("tool_call"); // this pi has no tool_call event
    expect(() => activate(pi as any)).not.toThrow();
    // the other handlers are still registered
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("message_end")).toBe(true);
    expect(pi.handlers.has("tool_call")).toBe(false);
  });
});


describe("the foreground guard (claude's enforce-bash-async, ported)", () => {
  const fire = (pi: ReturnType<typeof stubPi>, input: Record<string, unknown>) => {
    let out: unknown;
    pi.handlers.get("tool_call")!(
      { toolName: "bash", input },
      {},
    );
    // the handler is sync in the extension; re-invoke capturing the return
    out = (pi.handlers.get("tool_call") as (e: unknown, c: unknown) => unknown)(
      { toolName: "bash", input }, {},
    );
    return out as { block?: boolean; reason?: string } | undefined;
  };

  test("no timeout blocks; a bounded timeout passes; backgrounded passes", () => {
    delete process.env.CYC_PI_EVENT_SOCK;
    const pi = stubPi();
    activate(pi as any);
    expect(fire(pi, { command: "sleep 999" })?.block).toBe(true);
    expect(fire(pi, { command: "sleep 999", timeout: 3600 })?.block).toBe(true);
    expect(fire(pi, { command: "echo hi", timeout: 10 })).toBeUndefined();
    expect(fire(pi, { command: "bun test > /tmp/o.log 2>&1 &" })).toBeUndefined();
    expect(fire(pi, { command: "nohup long-build" })).toBeUndefined();
  });

  test("non-bash tools and empty commands pass untouched", () => {
    delete process.env.CYC_PI_EVENT_SOCK;
    const pi = stubPi();
    activate(pi as any);
    expect((pi.handlers.get("tool_call") as any)({ toolName: "read", input: { path: "/x" } }, {})).toBeUndefined();
    expect(fire(pi, {})).toBeUndefined();
  });
});
