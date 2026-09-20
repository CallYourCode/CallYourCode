/* The pi REPLY CHANNEL (engine/harness/pi/reply-channel.js), the pi twin of
 * the cyc output MCP (engine/mcp/src/server.ts). It proves:
 *   - the tool set, descriptions and input schemas mirror the MCP;
 *   - speak/chat/show POST the SAME body the MCP sends to /agent/reply, and
 *     return the SAME tool result the MCP returns;
 *   - errors (empty text, no pane, unreachable, wedged, engine-rejected) are
 *     reported to the model plainly by throwing the SAME message the MCP shows,
 *     which pi turns into an error tool result (never an unhandled crash);
 *   - the #505 idempotency-key reuse on retry;
 *   - the endpoint resolver is PINNED to engine/shared/engine-url.ts
 *     (resolveEngine), and the pane-id resolver is PINNED to
 *     engine/mcp/src/paneid.ts (resolvePaneId), so the twin cannot drift.
 *
 *   bun test agent-engine/src/adapters/reply-channel.test.ts
 */

import { describe, expect, test, afterEach } from "bun:test";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// the extension module under test (plain CJS)
import { registerReplyTools } from "../../../harness/pi/reply-channel.js";
// @ts-expect-error CJS module, _internal is attached at runtime
import { _internal as rc } from "../../../harness/pi/reply-channel.js";
// the shared sources this twin is pinned to
import { resolveEngine, type EngineTarget } from "../../../shared/engine-url.ts";
import { resolvePaneId as mcpResolvePaneId, type ProcResolver } from "../../../mcp/src/paneid.ts";

type PostedBody = {
  pane?: string;
  kind?: string;
  text?: string;
  path?: string;
  msgId?: string;
  key?: string;
  channels?: string[];
};
type ToolDef = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: unknown) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
};

/** A stub pi that records the tools registerReplyTools registers. */
function stubPi() {
  const tools = new Map<string, ToolDef>();
  return {
    tools,
    registerTool(t: ToolDef) {
      tools.set(t.name, t);
    },
  };
}

/** A fake POST that records every call and answers from a queue of results (an
 *  object resolves, an Error rejects). */
function fakePost(results: (object | Error)[]) {
  const calls: { target: unknown; path: string; body: PostedBody }[] = [];
  let i = 0;
  const post = async (target: unknown, path: string, body: PostedBody) => {
    calls.push({ target, path, body });
    const r = results[Math.min(i, results.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return r;
  };
  return { post, calls };
}

/** A deterministic uuid source: u1, u2, ... so msgId/key are assertable. */
function seqUuid() {
  let n = 0;
  return () => `u${++n}`;
}

const TARGET = { kind: "tcp" as const, origin: "http://127.0.0.1:19099" };

function wire(opts: Partial<Parameters<typeof registerReplyTools>[1]> = {}) {
  const pi = stubPi();
  const fp = fakePost((opts as any)._results ?? [{ ok: true }]);
  const ret = registerReplyTools(pi as any, {
    env: { HERDR_PANE_ID: "w1:p3" },
    paneId: "w1:p3",
    target: TARGET,
    post: fp.post,
    uuid: seqUuid(),
    confirmMs: 15_000,
    ...opts,
  });
  return { pi, calls: fp.calls, ret };
}

describe("the reply channel mirrors the MCP tool set", () => {
  test("registers exactly speak, chat and show with the MCP descriptions and schemas", () => {
    const { pi } = wire();
    expect([...pi.tools.keys()].sort()).toEqual(["chat", "show", "speak"]);

    const speak = pi.tools.get("speak")!;
    expect(speak.description).toBe(rc.SPEAK_DESCRIPTION);
    expect(speak.parameters).toEqual({
      type: "object",
      properties: { text: { type: "string", description: "What to say, as plain spoken prose." } },
      required: ["text"],
    });

    const chat = pi.tools.get("chat")!;
    expect(chat.description).toBe(rc.CHAT_DESCRIPTION);
    expect(chat.parameters).toEqual({
      type: "object",
      properties: { text: { type: "string", description: "The written reply." } },
      required: ["text"],
    });

    const show = pi.tools.get("show")!;
    expect(show.description).toBe(rc.SHOW_DESCRIPTION);
    expect(show.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string", description: "Absolute path of the file to display." } },
      required: ["path"],
    });
  });

  test("the descriptions are the exact MCP strings", () => {
    expect(rc.SPEAK_DESCRIPTION).toBe(
      "Say something out loud to the user. This gets TTS output and is the only way they hear you. Keep it short and conversational: no markdown, no code blocks, no file paths.",
    );
    expect(rc.CHAT_DESCRIPTION).toBe(
      "Send a written reply to the user, as a message in the CallYourCode chat. Write it as a message rather than as terminal output. Light markdown is fine, for a file, charts or interactive html or a long formatted document use the show tool instead.",
    );
    expect(rc.SHOW_DESCRIPTION.startsWith("Display a file in the CallYourCode app.")).toBe(true);
    expect(rc.CHANNELS).toEqual(["speak", "chat", "show"]);
  });
});

describe("speak and chat POST the MCP body and return the MCP result", () => {
  test("speak posts {pane,kind,text,msgId,key,channels} and returns the spoke ack", async () => {
    const { pi, calls } = wire();
    const res = await pi.tools.get("speak")!.execute("tc-1", { text: "hi" });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/agent/reply");
    expect(calls[0].target).toBe(TARGET);
    expect(calls[0].body).toEqual({
      pane: "w1:p3",
      kind: "speak",
      text: "hi",
      msgId: "u2",
      key: "u1",
      channels: ["speak", "chat", "show"],
    });
    expect(res).toEqual({ content: [{ type: "text", text: "spoke (msgId: u2)" }], details: {} });
  });

  test("chat posts kind:chat and returns the chat ack", async () => {
    const { pi, calls } = wire();
    const res = await pi.tools.get("chat")!.execute("tc-1", { text: "written" });
    expect(calls[0].body.kind).toBe("chat");
    expect(calls[0].body.text).toBe("written");
    expect(res.content[0].text).toBe("sent to the chat (msgId: u2)");
  });

  test("text is trimmed and an empty text is refused before any POST", async () => {
    const { pi, calls } = wire();
    await expect(pi.tools.get("speak")!.execute("tc-1", { text: "   " })).rejects.toThrow(
      "speak failed: text is empty, there is nothing to send",
    );
    expect(calls).toHaveLength(0);
  });

  test("no pane id: refused with the MCP message, no POST", async () => {
    const { pi, calls } = wire({ paneId: null });
    await expect(pi.tools.get("speak")!.execute("tc-1", { text: "hi" })).rejects.toThrow(
      "speak failed: this session has no HERDR_PANE_ID, so the engine cannot route to it. Answer in the terminal instead.",
    );
    expect(calls).toHaveLength(0);
  });

  test("a wedged engine (AbortError) reports the confirm-timeout message", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const { pi } = wire({ _results: [abort] } as any);
    await expect(pi.tools.get("speak")!.execute("tc-1", { text: "hi" })).rejects.toThrow(
      "speak failed: agent engine did not confirm within 15s, so the user cannot hear you. Retry the tool call.",
    );
  });

  test("an unreachable engine reports the unreachable message with the endpoint label", async () => {
    const { pi } = wire({ _results: [new Error("ECONNREFUSED")] } as any);
    await expect(pi.tools.get("chat")!.execute("tc-1", { text: "hi" })).rejects.toThrow(
      "chat failed: agent engine unreachable at http://127.0.0.1:19099/agent/reply, so the user cannot read you. Retry the tool call.",
    );
  });

  test("an engine that answers ok:false relays its message with the retry note", async () => {
    const { pi } = wire({ _results: [{ ok: false, message: "not registered yet" }] } as any);
    await expect(pi.tools.get("speak")!.execute("tc-1", { text: "hi" })).rejects.toThrow(
      "speak failed: not registered yet. Retry the tool call.",
    );
  });
});

describe("show mirrors the MCP show tool", () => {
  test("posts kind:show with the path and returns '<message>: <path>'", async () => {
    const { pi, calls } = wire({ _results: [{ ok: true, message: "showing" }] } as any);
    const res = await pi.tools.get("show")!.execute("tc-1", { path: "/tmp/x.md" });
    expect(calls[0].body).toEqual({
      pane: "w1:p3",
      kind: "show",
      path: "/tmp/x.md",
      channels: ["speak", "chat", "show"],
    });
    expect(res.content[0].text).toBe("showing: /tmp/x.md");
  });

  test("an empty path is refused before any POST", async () => {
    const { pi, calls } = wire();
    await expect(pi.tools.get("show")!.execute("tc-1", { path: "" })).rejects.toThrow(
      "show failed: path is empty",
    );
    expect(calls).toHaveLength(0);
  });

  test("an unreachable engine reports the show-unreachable message", async () => {
    const { pi } = wire({ _results: [new Error("nope")] } as any);
    await expect(pi.tools.get("show")!.execute("tc-1", { path: "/p" })).rejects.toThrow(
      "show failed: agent engine unreachable at http://127.0.0.1:19099/agent/reply.",
    );
  });
});

describe("the #505 idempotency key: reuse on retry, fresh after success", () => {
  test("a retry of the same text reuses its key; a new utterance after success mints a new one", async () => {
    const { pi, calls } = wire({ _results: [{ ok: false, message: "slow" }, { ok: true }, { ok: true }] } as any);
    const speak = pi.tools.get("speak")!;
    // first attempt fails (ok:false): the key is retained for the retry
    await expect(speak.execute("tc", { text: "same" })).rejects.toThrow("Retry the tool call.");
    // the retry (same text) reuses the SAME key, with a fresh msgId
    await speak.execute("tc", { text: "same" });
    expect(calls[1].body.key).toBe(calls[0].body.key);
    expect(calls[1].body.msgId).not.toBe(calls[0].body.msgId);
    // after that success the entry is cleared, so the next identical text is NEW
    await speak.execute("tc", { text: "same" });
    expect(calls[2].body.key).not.toBe(calls[0].body.key);
  });
});

/* --------------------------------------------------------------- the POST */

describe("postJson over node:http", () => {
  let server: Server | null = null;
  afterEach(() => {
    if (server) {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      server = null;
    }
  });

  test("POSTs the body to a unix socket and parses the JSON ack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-post-"));
    const sock = join(dir, "e.sock");
    let seen = "";
    server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        seen = b;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, message: "logged" }));
      });
    });
    await new Promise<void>((r) => server!.listen(sock, () => r()));
    const out = await rc.postJson({ kind: "unix", path: sock }, "/agent/reply", { pane: "p", kind: "chat" }, 5000);
    expect(out).toEqual({ ok: true, message: "logged" });
    expect(JSON.parse(seen)).toEqual({ pane: "p", kind: "chat" });
  });

  test("a non-2xx status throws a transport error, not an ack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-post-"));
    const sock = join(dir, "e.sock");
    server = createServer((_req, res) => {
      res.statusCode = 503;
      res.end("no");
    });
    await new Promise<void>((r) => server!.listen(sock, () => r()));
    await expect(rc.postJson({ kind: "unix", path: sock }, "/agent/reply", {}, 5000)).rejects.toThrow(
      "the engine answered HTTP 503",
    );
  });

  test("a wedged engine aborts at the timeout with an AbortError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-post-"));
    const sock = join(dir, "e.sock");
    server = createServer(() => {
      /* never responds */
    });
    await new Promise<void>((r) => server!.listen(sock, () => r()));
    await expect(rc.postJson({ kind: "unix", path: sock }, "/agent/reply", {}, 60)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("a dead endpoint rejects (unreachable), never hangs", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "rc-post-")), "nothing.sock");
    await expect(rc.postJson({ kind: "unix", path: sock }, "/agent/reply", {}, 5000)).rejects.toBeDefined();
  });
});

/* -------------------------------------------- the pins to the shared source */

describe("resolveEngineTarget is pinned to shared/engine-url.ts resolveEngine", () => {
  // a temp HOME + data dir so no case touches the real ~/.callyourcode; both
  // resolvers read env.HOME and hit real existsSync, so an on-disk sock file is
  // how the unix branch is exercised for both at once.
  const home = mkdtempSync(join(tmpdir(), "rc-home-"));
  const data = mkdtempSync(join(tmpdir(), "rc-data-"));
  const existingSock = join(data, "engine.sock");
  writeFileSync(existingSock, ""); // the default engine.sock exists on disk

  const cases: Record<string, string | undefined>[] = [
    { HOME: home, CYC_ENGINE_URL: "unix:/abs/one.sock" },
    { HOME: home, CYC_ENGINE_URL: "http://127.0.0.1:12345" },
    { HOME: home, CYC_ENGINE_SOCK: existingSock },
    { HOME: home, CYC_DATA_DIR: data }, // engine.sock exists -> unix
    { HOME: home }, // nothing exists on disk under a fresh HOME -> tcp default
    { HOME: home, AGENT_PORT: "10999" }, // offset port -> engine-10999.sock, tcp :10999
    { HOME: home, CYC_PORT_BASE: "10200" }, // AGENT_PORT = 10201 -> tcp :10201
  ];

  for (const [i, env] of cases.entries()) {
    test(`case ${i}: ${JSON.stringify(env)} resolves identically`, () => {
      const mine = rc.resolveEngineTarget(env) as EngineTarget;
      const shared = resolveEngine(env);
      expect(mine).toEqual(shared);
    });
  }
});

describe("resolvePaneId is pinned to mcp/src/paneid.ts resolvePaneId", () => {
  // a fake proc table so the walk-up is hermetic (no real /proc).
  function fakeResolver(table: Record<number, { ppid: number | null; env: Record<string, string> | null }>): ProcResolver {
    return {
      env: (pid) => table[pid]?.env ?? null,
      ppid: (pid) => table[pid]?.ppid ?? null,
    };
  }

  const scenarios: {
    name: string;
    own: Record<string, string | undefined>;
    table: Record<number, { ppid: number | null; env: Record<string, string> | null }>;
    startPpid: number;
  }[] = [
    {
      name: "own HERDR_PANE_ID wins, no walk-up",
      own: { HERDR_PANE_ID: "w1:p1", TMUX_PANE: "%9" },
      table: {},
      startPpid: 100,
    },
    {
      name: "own VOICE_SESSION_ID when no herdr",
      own: { VOICE_SESSION_ID: "vs-7" },
      table: {},
      startPpid: 100,
    },
    {
      name: "own TMUX_PANE last",
      own: { TMUX_PANE: "%3" },
      table: {},
      startPpid: 100,
    },
    {
      name: "scrubbed own env, ancestor carries HERDR_PANE_ID",
      own: {},
      table: { 100: { ppid: 40, env: { HERDR_PANE_ID: "w2:p5" } }, 40: { ppid: 1, env: {} } },
      startPpid: 100,
    },
    {
      name: "scrubbed own env, ancestor TMUX_PANE shaped %N",
      own: {},
      table: { 100: { ppid: 1, env: { TMUX_PANE: "%42" } } },
      startPpid: 100,
    },
    {
      name: "no id anywhere",
      own: {},
      table: { 100: { ppid: 1, env: { FOO: "bar" } } },
      startPpid: 100,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const resolver = fakeResolver(s.table);
      const mine = rc.resolvePaneId(s.own, resolver, s.startPpid);
      const shared = mcpResolvePaneId(s.own, resolver, s.startPpid);
      expect(mine).toBe(shared);
    });
  }
});
