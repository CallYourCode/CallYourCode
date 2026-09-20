// cyc reply-channel: the pi pane's way to answer INTO the CallYourCode app.
//
// WHY THIS EXISTS. The other three harnesses (claude/codex/opencode) reach the
// user through the cyc output MCP (engine/mcp/src/server.ts), whose speak/chat/
// show tools each POST one message to the engine's /agent/reply. pi has no MCP
// support, so a pi agent could receive the user's message and have no way to
// answer. This module registers the SAME three tools as pi extension tools, so
// a pi pane replies through the identical /agent/reply doorway.
//
// FAITHFUL TWIN, NOT A SECOND CONTRACT. The MCP (server.ts) is the authoritative
// contract: tool names, descriptions, input schemas, the POST body, the engine
// endpoint resolution and the pane-identity resolution are all mirrored here.
// Sharing one module across the two is unreasonable -- the MCP is a bundled,
// nodenext, Bun-fetch package; pi loads this as plain CJS under node -- so this
// is a faithful port. Two tests pin it to the shared source it twins:
//   - resolveEngineTarget is pinned to engine/shared/engine-url.ts resolveEngine
//     (the canonical resolver server.ts itself mirrors), and
//   - resolvePaneId is pinned to engine/mcp/src/paneid.ts resolvePaneId,
// so the twin cannot silently drift from server.ts's behaviour.
//
// RUNTIME. pi runs under node, whose fetch (undici) has no unix-socket option,
// so the POST goes over node:http (a socketPath for the unix socket, host/port
// for the TCP loopback). Plain CJS, node built-ins only, so pi loads it with no
// build step, exactly like cyc-output.js beside it.

const http = require("node:http");
const { existsSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");

// -------------------------------------------------------- endpoint resolution
// A faithful twin of engine/shared/engine-url.ts (resolveEngine / defaultSockPath)
// and the AGENT_PORT half of engine/shared/ports.ts. server.ts carries the same
// logic as its own inline twin; this ports it once more for node CJS.

const DEFAULT_AGENT_PORT = 10101;

function homeOf(env) {
  const h = env.HOME;
  return h && h.trim() ? h : homedir();
}

function expandTilde(p, env) {
  if (p === "~") return homeOf(env);
  if (p.startsWith("~/")) return join(homeOf(env), p.slice(2));
  return p;
}

function finite(v) {
  if (v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** AGENT_PORT the way ports.ts resolves it: an explicit AGENT_PORT wins, else
 *  CYC_PORT_BASE+1, else 10101. */
function agentPort(env) {
  const own = finite(env.AGENT_PORT);
  if (own !== null) return own;
  const base = finite(env.CYC_PORT_BASE);
  if (base !== null) return base + 1;
  return DEFAULT_AGENT_PORT;
}

/** The base data dir: CYC_DATA_DIR, else ~/.callyourcode. */
function dataDirOf(env) {
  const d = env.CYC_DATA_DIR;
  if (d && d.trim()) return d.trim().replace(/\/+$/, "");
  return join(homeOf(env), ".callyourcode");
}

/** Where the engine's local unix socket lives: CYC_ENGINE_SOCK wins; else
 *  <dataDir>/engine.sock for the default engine, <dataDir>/engine-<port>.sock
 *  for an offset-port instance. */
function defaultSockPath(env) {
  const override = env.CYC_ENGINE_SOCK;
  if (override && override.trim()) return expandTilde(override.trim(), env);
  const port = agentPort(env);
  const name = port === DEFAULT_AGENT_PORT ? "engine.sock" : `engine-${port}.sock`;
  return join(dataDirOf(env), name);
}

/** Parse an explicit CYC_ENGINE_URL into a target. Throws on a shape this
 *  resolver does not accept, so a typo fails loud rather than reaching the
 *  default. Mirrors engine-url.ts parseEngineUrl. */
function parseEngineUrl(raw, env) {
  const v = raw.trim();
  if (v.startsWith("unix:")) {
    return { kind: "unix", path: expandTilde(v.slice("unix:".length), env) };
  }
  const u = new URL(v); // throws on garbage
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(
      `CYC_ENGINE_URL: unsupported scheme ${u.protocol} (use http://host:port or unix:/path.sock)`,
    );
  }
  return { kind: "tcp", origin: u.origin };
}

/** The engine target for this env: the canonical CYC_ENGINE_URL when set, else
 *  the local socket if it exists on disk, else the TCP loopback default. This is
 *  the exact preference order server.ts (and engine-url.ts resolveEngine) uses.
 *  `fileExists` is injectable so a unit test can pin the sock/TCP branch without
 *  touching the filesystem; production hits real existsSync. */
function resolveEngineTarget(env, fileExists) {
  const exists = fileExists || existsSync;
  const raw = (env.CYC_ENGINE_URL || "").trim();
  if (raw) return parseEngineUrl(raw, env);
  const sock = defaultSockPath(env);
  if (exists(sock)) return { kind: "unix", path: sock };
  return { kind: "tcp", origin: `http://127.0.0.1:${agentPort(env)}` };
}

/** A human-readable label for a target, for error messages. */
function engineLabel(t) {
  return t.kind === "unix" ? `unix:${t.path}` : t.origin;
}

// ------------------------------------------------------------ pane identity
// A faithful twin of engine/mcp/src/paneid.ts (resolvePaneId + helpers). The pi
// pane's own env carries HERDR_PANE_ID (herdr stamps it) or TMUX_PANE (tmux), so
// own-env resolution is what fires in practice; the ancestry walk-up is the same
// scrubbed-env fallback the MCP keeps, ported for parity so the pin test can
// prove the two agree.

const MAX_HOPS = 8;

/** The pane id carried by OUR OWN env, exact precedence and `??` semantics. */
function ownEnvPaneId(env) {
  return env.HERDR_PANE_ID ?? env.VOICE_SESSION_ID ?? env.TMUX_PANE ?? null;
}

/** The pane id carried by an ANCESTOR's env, accepting only plausible values. */
function ancestorEnvPaneId(env) {
  const herdr = env.HERDR_PANE_ID;
  if (herdr && herdr.length > 0) return herdr;
  const voice = env.VOICE_SESSION_ID;
  if (voice && voice.length > 0) return voice;
  const tmux = env.TMUX_PANE;
  if (tmux && /^%\d+$/.test(tmux)) return tmux;
  return null;
}

/** THE PANE ID FOR THIS SESSION. Own env first and unchanged; only when it
 *  yields nothing do we walk up from `startPpid` through the ancestry. Bounded,
 *  never throws, never loops forever. `resolver` is injectable for tests. */
function resolvePaneId(ownEnv, resolver, startPpid) {
  const own = ownEnvPaneId(ownEnv);
  if (own != null) return own;
  if (!resolver || !Number.isInteger(startPpid)) return null;
  let pid = startPpid;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (!Number.isInteger(pid) || pid <= 1) break;
    const env = resolver.env(pid);
    if (env) {
      const id = ancestorEnvPaneId(env);
      if (id) return id;
    }
    const parent = resolver.ppid(pid);
    if (parent == null) break;
    pid = parent;
  }
  return null;
}

/** Parse a Linux /proc/<pid>/environ blob into a plain object. */
function parseProcEnviron(blob) {
  const env = {};
  for (const rec of blob.split("\0")) {
    if (!rec) continue;
    const eq = rec.indexOf("=");
    if (eq <= 0) continue;
    env[rec.slice(0, eq)] = rec.slice(eq + 1);
  }
  return env;
}

/** Read a pid's PPID from Linux /proc/<pid>/stat (split after the last ')'). */
function ppidFromProcStat(stat) {
  const rp = stat.lastIndexOf(")");
  if (rp < 0) return null;
  const rest = stat.slice(rp + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

/** The default resolver: Linux reads /proc directly. Every read is guarded and
 *  returns null on failure, so the walk degrades to "no id" rather than
 *  throwing. (darwin's ps path is the MCP's; a pi pane on darwin resolves from
 *  its own env, which always carries the id, so it never needs the walk-up.) */
const defaultProcResolver = {
  env(pid) {
    if (!Number.isInteger(pid) || pid <= 1) return null;
    try {
      return parseProcEnviron(readFileSync(`/proc/${pid}/environ`, "utf8"));
    } catch {
      return null;
    }
  },
  ppid(pid) {
    if (!Number.isInteger(pid) || pid <= 1) return null;
    try {
      return ppidFromProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return null;
    }
  },
};

// ------------------------------------------------------------ the loopback POST

const REPLY_PATH = "/agent/reply";

/** How long a POST waits for the engine to confirm (server.ts #447). The HTTP
 *  response IS the ack; a dead engine is refused at connect and fails fast, so
 *  this bound only bites a wedged engine. The env override exists so a test can
 *  prove the bound without spending it (server.ts CYC_MCP_CONFIRM_MS). */
function confirmMsOf(env) {
  return Number(env.CYC_MCP_CONFIRM_MS) || 15_000;
}

/** ONE POST over node:http, and its JSON body is the ack. A wedged engine is
 *  aborted at `timeoutMs` and rejects with an AbortError (name === "AbortError",
 *  the branch server.ts turns into the confirm-timeout message); a refused/reset
 *  connection rejects with the underlying error (the unreachable branch); a
 *  non-2xx throws like a transport failure. Resolves with the parsed JSON body,
 *  which is a real ack the caller hands back. */
function postJson(target, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      method: "POST",
      path,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    };
    if (target.kind === "unix") {
      options.socketPath = target.path;
      // the host is ignored for a unix socket but node wants one present
      options.host = "localhost";
    } else {
      const u = new URL(target.origin);
      options.host = u.hostname;
      options.port = u.port || (u.protocol === "https:" ? 443 : 80);
    }
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        data += c;
      });
      res.on("end", () => {
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          done(reject, new Error(`the engine answered HTTP ${status}`));
          return;
        }
        try {
          done(resolve, JSON.parse(data));
        } catch (e) {
          done(reject, e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
    const timer = setTimeout(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      try {
        req.destroy(err);
      } catch {
        /* ignore */
      }
      done(reject, err);
    }, timeoutMs);
    if (timer.unref) timer.unref();
    req.on("error", (err) => done(reject, err));
    req.write(payload);
    req.end();
  });
}

// --------------------------------------------------------------- the tools
// Names, descriptions, input schemas and semantics mirror the cyc output MCP
// (engine/mcp/src/server.ts) exactly. Input schemas are plain JSON Schema, which
// pi validates the same as a TypeBox schema (pi-ai validateToolArguments takes
// either); they are byte-identical to the MCP's inputSchema for each tool.

const CHANNELS = ["speak", "chat", "show"];

const SHOW_DESCRIPTION = [
  "Display a file in the CallYourCode app. Use this instead of reading file contents aloud or pasting them into chat.",
  "",
  "Images appear in the chat itself. Short markdown or diffs appear inline; longer ones become a card that opens a formatted page or a diff viewer.",
  "",
  "An .html file becomes a full-screen interactive page: it runs its own scripts, can send data back (cyc.submit) and keep state (cyc.save / cyc.load). Anything fits in one page: a question round, an editable task list, a log viewer, a chart, a step-through. Look at a working example in callyourcode/engine/mcp/examples/ and adapt.",
  "",
  "Hard limits, all enforced: the page is sandboxed on an opaque origin; it cannot reach the app or engine; alert/confirm/prompt do not exist; https CDNs work, plain http and ws do not; 1MB max or nothing shows; submit bodies 64KB, saved state 256KB; the viewer sets data-cyc-theme=\"dark|light\" on <html>; assume a phone-sized touch screen.",
].join("\n");

const SPEAK_DESCRIPTION =
  "Say something out loud to the user. This gets TTS output and is the only way they hear you. Keep it short and conversational: no markdown, no code blocks, no file paths.";
const CHAT_DESCRIPTION =
  "Send a written reply to the user, as a message in the CallYourCode chat. Write it as a message rather than as terminal output. Light markdown is fine, for a file, charts or interactive html or a long formatted document use the show tool instead.";

const TEXT_SCHEMA = (what) => ({
  type: "object",
  properties: { text: { type: "string", description: what } },
  required: ["text"],
});
const SHOW_SCHEMA = {
  type: "object",
  properties: { path: { type: "string", description: "Absolute path of the file to display." } },
  required: ["path"],
};

const UNCONFIRMED_MAX = 8;

/** Register speak/chat/show on `pi`. Every dependency is injectable so a
 *  hermetic test drives it with a stub pi and a fake `post`; production reads
 *  process.env, resolves the pane and endpoint, and POSTs over node:http.
 *
 *  Errors are reported to the model plainly by THROWING a plain Error whose
 *  message is exactly what the MCP puts in its isError result: pi's tool runner
 *  catches an execute() throw and turns it into an error tool result
 *  (createErrorToolResult, agent-loop.ts), so nothing here crashes pi. */
function registerReplyTools(pi, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const paneId =
    o.paneId !== undefined
      ? o.paneId
      : resolvePaneId(env, defaultProcResolver, typeof process !== "undefined" ? process.ppid : undefined);
  const target = o.target || resolveEngineTarget(env);
  const label = engineLabel(target);
  const confirmMs = o.confirmMs !== undefined ? o.confirmMs : confirmMsOf(env);
  const uuid = o.uuid || randomUUID;
  const post = o.post || ((t, path, body) => postJson(t, path, body, confirmMs));

  // THE IDEMPOTENCY KEYS of the utterances still awaiting confirmation (#505):
  // a retry of the SAME text reuses its key so the engine dedupes it against
  // whichever attempt landed. One entry per in-flight text, bounded.
  const unconfirmed = new Map(); // text -> idempotency key

  async function handleSay(kind, args) {
    const unreachable = kind === "speak" ? "the user cannot hear you" : "the user cannot read you";
    try {
      const text = String((args && args.text) != null ? args.text : "").trim();
      if (!text) throw new Error("text is empty, there is nothing to send");
      if (!paneId) {
        throw new Error(
          "this session has no HERDR_PANE_ID, so the engine cannot route to it. Answer in the terminal instead.",
        );
      }
      let key = unconfirmed.get(text);
      if (!key) {
        key = uuid();
        unconfirmed.set(text, key);
        while (unconfirmed.size > UNCONFIRMED_MAX) {
          unconfirmed.delete(unconfirmed.keys().next().value);
        }
      }
      const msgId = uuid();
      let m;
      try {
        m = await post(target, REPLY_PATH, { pane: paneId, kind, text, msgId, key, channels: CHANNELS });
      } catch (err) {
        const why =
          err && err.name === "AbortError"
            ? `agent engine did not confirm within ${confirmMs / 1000}s, so ${unreachable}. Retry the tool call.`
            : `agent engine unreachable at ${label}${REPLY_PATH}, so ${unreachable}. Retry the tool call.`;
        throw new Error(why);
      }
      if (!m || !m.ok) {
        // the entry stays in `unconfirmed` on purpose: the retry reuses this key.
        throw new Error(`${(m && m.message) || "the engine rejected the message"}. Retry the tool call.`);
      }
      unconfirmed.delete(text); // confirmed: the next identical text is new
      return {
        content: [
          { type: "text", text: `${kind === "speak" ? "spoke" : "sent to the chat"} (msgId: ${msgId})` },
        ],
        details: {},
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${kind} failed: ${msg}`);
    }
  }

  async function handleShow(args) {
    try {
      const path = String((args && args.path) != null ? args.path : "").trim();
      if (!path) throw new Error("path is empty");
      if (!paneId) {
        throw new Error("this session has no HERDR_PANE_ID, so the engine cannot route to it.");
      }
      let m;
      try {
        m = await post(target, REPLY_PATH, { pane: paneId, kind: "show", path, channels: CHANNELS });
      } catch {
        throw new Error(`agent engine unreachable at ${label}${REPLY_PATH}.`);
      }
      if (!m || !m.ok) throw new Error((m && m.message) || "the engine rejected the message");
      return { content: [{ type: "text", text: `${m.message}: ${path}` }], details: {} };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`show failed: ${msg}`);
    }
  }

  const tools = [
    {
      name: "speak",
      label: "Speak",
      description: SPEAK_DESCRIPTION,
      parameters: TEXT_SCHEMA("What to say, as plain spoken prose."),
      execute: (_id, params) => handleSay("speak", params),
    },
    {
      name: "chat",
      label: "Chat",
      description: CHAT_DESCRIPTION,
      parameters: TEXT_SCHEMA("The written reply."),
      execute: (_id, params) => handleSay("chat", params),
    },
    {
      name: "show",
      label: "Show",
      description: SHOW_DESCRIPTION,
      parameters: SHOW_SCHEMA,
      execute: (_id, params) => handleShow(params),
    },
  ];

  for (const t of tools) {
    try {
      pi.registerTool(t);
    } catch {
      // an old pi without registerTool, or a stub in a test: skip that tool,
      // never throw out of the extension factory.
    }
  }

  return { handleSay, handleShow, paneId, target, unconfirmed };
}

module.exports = { registerReplyTools };
// test seams: the pure resolvers pinned to the shared source, plus the POST.
module.exports._internal = {
  resolveEngineTarget,
  defaultSockPath,
  agentPort,
  engineLabel,
  parseEngineUrl,
  resolvePaneId,
  ownEnvPaneId,
  ancestorEnvPaneId,
  parseProcEnviron,
  ppidFromProcStat,
  defaultProcResolver,
  postJson,
  confirmMsOf,
  CHANNELS,
  REPLY_PATH,
  SHOW_DESCRIPTION,
  SPEAK_DESCRIPTION,
  CHAT_DESCRIPTION,
};
