// cyc-output: a pi EXTENSION that streams a pi pane's live events to cyc.
//
// WHY THIS EXISTS. Today cyc learns what a pi pane did by tailing pi's
// transcript jsonl (agent-engine readers/pi.ts). That works for any pi -- one
// cyc started, one started by hand, an old build -- and STAYS the source of
// truth. This extension is an ADDITIONAL, lower-latency live source for a pi
// pane cyc itself launched: pi loads it with `-e <this file>` and sets
// CYC_PI_EVENT_SOCK, and it forwards lifecycle events over a unix socket the
// engine listens on. If the socket is absent or an event ever throws, it
// degrades to nothing and the transcript path covers the pane exactly as
// before. It never blocks pi and never throws out of a handler.
//
// FRAMES (newline-delimited JSON, engine is the server, this is the client):
//   {t:"pi.session", sessionId, cwd, model}   identity, on session_start
//   {t:"pi.event", kind, id, ts, ...}         one renderable row
//     kind:"prompt"|"reply"  text            a user/assistant message
//     kind:"tool"            tool, text      a tool call
//     kind:"status"          status          "working" | "idle"
//
// STABLE IDS. A message/tool frame carries `id`, the SAME durable id pi writes
// to the transcript record, so the engine consumer dedupes a frame against the
// transcript-derived row (agent-engine chat/ingest logSession is idempotent on
// that id). For a message that is the session leaf entry id
// (sessionManager.getLeafEntry().id, which becomes the jsonl record id); for a
// tool it is the toolCallId (the transcript's own toolCall id).
//
// Plain JS on purpose: jiti-importable, dependency-light (node:net only), so
// pi loads it with no build step.

const net = require("node:net");
const { registerReplyTools } = require("./reply-channel.js");

const TOOL_CAP = 200; // one-line tool summaries, matches the engine's TEXT_CAP
const BODY_CAP = 2000; // prompts/replies keep their body (engine BODY_CAP)

// -------------------------------------------------------------------------
// HTTP SESSION-ID ANNOUNCE. pi's identity now reaches the engine the SAME
// reliable way the other three harnesses do: an HTTP POST to the engine's
// /harness/announce endpoint (claude's hook, codex's notify, and the opencode
// cyc plugin all POST there). This is the race-free identity path; the unix
// socket below STAYS for the live status/transcript stream (pi-specific
// richness) and its pi.session frame is a harmless idempotent backstop (the
// engine dedupes on the session id). Mirrors engine/harness/opencode/
// callyourcode.ts announceSession exactly: once per session id per process,
// fail-silent, a short AbortSignal timeout, witnesses off the process env.

const ANNOUNCE_TIMEOUT_MS = 2000;

// One announce per pi session id per extension process. The engine's
// recordHookBind is idempotent (hook-announce.ts recordHookBind, latest-wins),
// so a dropped POST is harmless: the retained socket pi.session re-send on
// (re)connect is the backstop. Marked announced on first attempt so a second
// call for the same sid never re-POSTs.
const announcedSessions = new Set();

/** POST the pi session id + pid/pane/cwd witnesses to the engine's announce
 *  endpoint, fail-silent: never throws, swallows every failure (dead engine,
 *  closed port, timeout). The witnesses ride the pane's own environment --
 *  HERDR_PANE_ID is set by herdr in each pane it opens, TMUX_PANE by tmux --
 *  exactly the source the opencode plugin and claude hook read, so no engine
 *  env-add is needed. AGENT_PORT defaults to the loopback engine port 10101. */
async function announceSession(sessionId, cwd, env) {
  const e = env || process.env;
  try {
    if (!sessionId || announcedSessions.has(sessionId)) return;
    announcedSessions.add(sessionId);
    const port = e.AGENT_PORT || "10101";
    const body = JSON.stringify({
      sessionId,
      pid: process.pid,
      cwd: cwd == null ? null : cwd,
      herdrPane: e.HERDR_PANE_ID != null ? e.HERDR_PANE_ID : null,
      tmuxPane: e.TMUX_PANE != null ? e.TMUX_PANE : null,
      harness: "pi",
      event: "session_start",
    });
    await fetch(`http://127.0.0.1:${port}/harness/announce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(ANNOUNCE_TIMEOUT_MS),
    });
  } catch {
    /* fails silent, always */
  }
}

/** The socket sink: an at-most-one unix client to CYC_PI_EVENT_SOCK. Every
 *  write is best effort. Before the connection is up, or after it drops, a
 *  small bounded backlog holds frames so the first few events are not lost to
 *  a startup race; past the cap they are dropped (the transcript still has
 *  them). Nothing here can throw into a pi handler.
 *
 *  onConnect (optional) fires each time the socket (re)connects, AFTER the
 *  backlog is flushed. The identity frame is delivered through this hook (a
 *  re-send from the caller's cache) rather than the backlog, so a session_start
 *  that fired before the engine listener was ready still reaches it on connect,
 *  and a reconnect after a drop re-announces it -- exactly once per connect. */
function makeSink(sockPath, onConnect) {
  let sock = null;
  let connected = false;
  let closed = false;
  const backlog = [];
  const BACKLOG_MAX = 256;

  function flush() {
    if (!connected || !sock) return;
    while (backlog.length) {
      const line = backlog.shift();
      try {
        sock.write(line);
      } catch {
        // the write failed: the 'error'/'close' handler will re-open; put it
        // back only if there is room, else let it go.
        if (backlog.length < BACKLOG_MAX) backlog.unshift(line);
        return;
      }
    }
  }

  function connect() {
    if (closed || sock) return;
    try {
      sock = net.createConnection(sockPath);
    } catch {
      sock = null;
      return;
    }
    sock.on("connect", () => {
      connected = true;
      flush();
      // re-announce the cached identity (if any) now that a listener is up.
      if (onConnect) {
        try {
          onConnect();
        } catch {
          // a caller bug must never crash pi from the socket callback
        }
      }
    });
    const drop = () => {
      connected = false;
      sock = null;
      // do not hammer: a cyc-launched pi has its server up before pi starts,
      // so a drop means the engine went away; the transcript path covers it.
    };
    sock.on("error", drop);
    sock.on("close", drop);
    // never keep pi alive for this socket
    if (sock.unref) sock.unref();
  }

  connect();

  return {
    send(frame) {
      if (closed) return;
      let line;
      try {
        line = JSON.stringify(frame) + "\n";
      } catch {
        return; // unserialisable frame: skip it, never throw
      }
      if (connected && sock) {
        try {
          sock.write(line);
          return;
        } catch {
          connected = false;
        }
      }
      // not connected: a pi.session is re-announced from the caller's cache on
      // (re)connect (see onConnect), so it is NOT queued here -- queuing it too
      // would deliver the identity twice. Every other frame uses the bounded
      // backlog so the first few events survive the startup race.
      if (frame && frame.t === "pi.session") {
        if (!sock) connect();
        return;
      }
      if (backlog.length < BACKLOG_MAX) backlog.push(line);
      if (!sock) connect();
    },
    close() {
      closed = true;
      backlog.length = 0;
      if (sock) {
        try {
          sock.end();
        } catch {
          // ignore
        }
        sock = null;
      }
    },
  };
}

/** Flatten a pi message's content to plain text (text parts only; thinking and
 *  tool-call parts are not the row's body). */
function contentText(message) {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c.trim();
  if (!Array.isArray(c)) return "";
  const parts = [];
  for (const p of c) {
    if (p && p.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("").trim();
}

function cap(text, n) {
  return text.length > n ? text.slice(0, n) + "\u2026" : text;
}

/** A compact one-line summary of a tool call's input, for the tool chip. */
function toolText(toolName, input) {
  if (input && typeof input === "object") {
    // the common shapes: bash command, a file path
    if (typeof input.command === "string") return cap(input.command, TOOL_CAP);
    if (typeof input.path === "string") return cap(input.path, TOOL_CAP);
    if (typeof input.file_path === "string") return cap(input.file_path, TOOL_CAP);
    if (typeof input.pattern === "string") return cap(input.pattern, TOOL_CAP);
  }
  return toolName || "";
}

/** The durable id for a message frame: the session leaf entry id, which is the
 *  id pi writes to the transcript record, so the engine dedupes across the two
 *  sources. Null-safe: a missing manager or entry yields undefined and the
 *  consumer falls back to the transcript row. */
function leafId(ctx) {
  try {
    const sm = ctx && ctx.sessionManager;
    if (!sm) return undefined;
    const e = sm.getLeafEntry && sm.getLeafEntry();
    if (e && typeof e.id === "string") return e.id;
    const id = sm.getLeafId && sm.getLeafId();
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

function sessionIdOf(ctx) {
  try {
    const sm = ctx && ctx.sessionManager;
    return sm && sm.getSessionId ? sm.getSessionId() : undefined;
  } catch {
    return undefined;
  }
}

/** cwd/model come off the ExtensionContext as GETTERS (pi's real ctx defines
 *  `get cwd()` / `get model()`, and each getter first calls assertActive(),
 *  which THROWS for a stale extension instance after a reload/session swap).
 *  Read each behind its own try/catch so a throwing getter yields undefined
 *  rather than aborting the whole identity frame -- the sessionId is the field
 *  that unblocks resume, so it must survive a cwd/model read that throws. */
function cwdOf(ctx) {
  try {
    return ctx && typeof ctx.cwd === "string" ? ctx.cwd : undefined;
  } catch {
    return undefined;
  }
}

function modelOf(ctx) {
  try {
    const m = ctx && ctx.model;
    return m && typeof m.id === "string" ? m.id : undefined;
  } catch {
    return undefined;
  }
}

/** The extension factory pi calls with its API. Exported as default AND as a
 *  named `activate` so a test can drive it against a stub pi without pi. */
function activate(pi, deps) {
  /* THE REPLY CHANNEL (reply-channel.js): register speak/chat/show so a pi agent
   * can answer INTO the app the same way the MCP harnesses do. This is
   * independent of the event-stream socket below -- a pi pane must be able to
   * reply whether or not cyc is streaming its events -- so it runs first and
   * unconditionally. It is self-guarding: a pi lacking registerTool (or a test
   * stub) skips silently rather than throwing out of the factory. */
  try {
    registerReplyTools(pi);
  } catch {
    // never let the reply-channel registration crash the extension load
  }

  // never throw out of a handler: wrap every one so a bad frame or a socket
  // hiccup can never crash pi or abort its turn.
  const safe = (fn) => (event, ctx) => {
    try {
      fn(event, ctx);
    } catch {
      // swallow: the transcript path is the source of truth
    }
  };

  const on = (name, fn) => {
    try {
      pi.on(name, safe(fn));
    } catch {
      // an old pi without this event: skip it, keep the rest
    }
  };

  const sockPath = process.env.CYC_PI_EVENT_SOCK;
  if (!sockPath) {
    /* NOT LAUNCHED BY CYC (a plain `pi` typed into a pane, loading this file
     * from pi's global extensions): no event stream, but the engine still has
     * to learn which session this pane is, or it never tails the transcript
     * and the chat shows replies with no session rows. The announce is an
     * HTTP POST, independent of the socket, so it runs here too. */
    on("session_start", (_event, ctx) => {
      void announceSession(sessionIdOf(ctx), cwdOf(ctx));
    });
    return;
  }

  // last-known session identity, cached the moment session_start names it, so a
  // (re)connect can re-announce it to an engine listener that was not yet ready
  // when the one-shot session_start fired. This is the fix for the capture race:
  // the identity survives a socket that came up (or came back) after the emit.
  let lastSession = null;

  // a test seam: inject a fake sink whose connect timing it controls; pi always
  // calls activate(pi) with one arg, so the real makeSink is used in production.
  const makeSinkFn = (deps && deps.makeSink) || makeSink;
  const sink = makeSinkFn(sockPath, () => {
    // on every (re)connect: if we already know who this pane is, re-send the
    // identity so a late-ready engine listener still binds the pane. Idempotent
    // on the engine (recordHookBind is latest-wins), so a duplicate is harmless.
    if (lastSession) sink.send(lastSession);
  });

  // identity, so cyc can bind the pane from the extension too. Each field is
  // read through its own null-safe accessor so a throwing ctx getter can never
  // drop the frame: the sessionId is what the engine binds the pane from.
  on("session_start", (_event, ctx) => {
    const sessionId = sessionIdOf(ctx);
    const cwd = cwdOf(ctx);
    const frame = {
      t: "pi.session",
      sessionId,
      cwd,
      model: modelOf(ctx),
    };
    lastSession = frame; // cache it so a (re)connect can re-announce it
    sink.send(frame);
    // the RELIABLE identity path: POST the session id to /harness/announce,
    // the same race-free way claude/codex/opencode capture theirs. Fire-and-
    // forget, fail-silent; the socket re-send above is the backstop.
    void announceSession(sessionId, cwd);
  });

  // live working/idle: the agent loop is the turn. turn_start opens it,
  // agent_end closes it. The consumer feeds these to the same jsonl-status
  // path the transcript turn edges feed, which dedupes repeats.
  on("turn_start", () => {
    sink.send({ t: "pi.event", kind: "status", status: "working", ts: Date.now() });
  });
  on("agent_end", () => {
    sink.send({ t: "pi.event", kind: "status", status: "idle", ts: Date.now() });
  });

  // a finalized message -> a prompt/reply row. id is the durable leaf id.
  on("message_end", (event, ctx) => {
    const msg = event && event.message;
    if (!msg) return;
    const role = msg.role;
    const kind = role === "user" ? "prompt" : role === "assistant" ? "reply" : null;
    if (!kind) return; // toolResult rows arrive via tool_result, not here
    const text = cap(contentText(msg), BODY_CAP);
    if (!text) return; // an empty assistant frame (a pure tool-call turn) is not a row
    sink.send({
      t: "pi.event",
      kind,
      id: leafId(ctx),
      ts: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
      text,
    });
  });

  // a tool call -> a tool row. id is the toolCallId, which is also the
  // transcript's own toolCall id, so it dedupes there.
  on("tool_call", (event) => {
    if (!event || typeof event.toolCallId !== "string") return;
    sink.send({
      t: "pi.event",
      kind: "tool",
      id: event.toolCallId,
      ts: Date.now(),
      tool: event.toolName,
      text: toolText(event.toolName, event.input),
    });
  });

  // best-effort teardown: close the socket when pi shuts the session down and
  // when the process exits, so no stale client lingers.
  on("session_shutdown", () => sink.close());
  const bye = () => {
    try {
      sink.close();
    } catch {
      // ignore
    }
  };
  try {
    process.once("exit", bye);
    process.once("SIGINT", bye);
    process.once("SIGTERM", bye);
  } catch {
    // ignore: some hosts restrict process listeners
  }
}

module.exports = activate;
module.exports.activate = activate;
module.exports.default = activate;
// test seams (pure, no socket): the frame builders the handlers use, plus the
// HTTP announce and its once-per-sid guard (driven by pi-extension.test.ts
// against a local Bun.serve, exactly as the opencode plugin test does).
module.exports._internal = {
  contentText,
  toolText,
  cap,
  TOOL_CAP,
  BODY_CAP,
  announceSession,
  announcedSessions,
  ANNOUNCE_TIMEOUT_MS,
};
