/* cyc CLI: the pure functions, and `run()` driven against a loopback fake
 * engine (Bun.serve on 127.0.0.1:0) that serves canned /agents and records
 * every POST. No real engine, no herdr, no harness (cyc-cli plan section 8).
 *
 *   bun test scripts/cyc.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import {
  run, engineOrigin, tildify, renderAgentsTable, resolveTarget,
  sniffPhotoMime, cmdHook, cmdVoice, hookScriptPath, HOOK_SCRIPTS,
  type AgentsReply, type Env,
} from "./cyc.ts";

// ---------------------------------------------------------------------------
// the loopback fake engine

type Post = { path: string; contentType: string | null; json: any; raw: Uint8Array };

function startFake(init?: {
  agents?: AgentsReply;
  reply?: (path: string) => { status: number; body: unknown } | undefined;
}) {
  let agents: AgentsReply = init?.agents ?? { ok: true, mux: "herdr", agents: [] };
  const posts: Post[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/agents") return Response.json(agents);
      if (req.method === "POST") {
        const raw = new Uint8Array(await req.arrayBuffer());
        const ct = req.headers.get("content-type");
        let json: any = null;
        try { json = ct?.includes("application/json") ? JSON.parse(new TextDecoder().decode(raw)) : null; }
        catch { /* raw body */ }
        posts.push({ path: url.pathname, contentType: ct, json, raw });
        const r = init?.reply?.(url.pathname);
        if (r) return Response.json(r.body, { status: r.status });
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    posts,
    setAgents: (a: AgentsReply) => { agents = a; },
    stop: () => server.stop(true),
  };
}

const servers: Array<{ stop: () => void }> = [];
afterEach(() => { while (servers.length) servers.pop()!.stop(); });
function fake(init?: Parameters<typeof startFake>[0]) {
  const f = startFake(init);
  servers.push(f);
  return f;
}

const AGENTS: AgentsReply = {
  ok: true,
  mux: "herdr",
  agents: [
    { agentId: "ag-3fK9x2mPq81LbR0w", name: "deploy watcher", cwd: "/home/tester/projects/foo",
      pane: "w1:p1", harness: "claude", status: "working", alive: true, sessionId: "uuid-self" },
    { agentId: "ag-8Qw1nT5cZk2vXo9d", name: "herdr", cwd: "/home/tester/projects/callyourcode",
      pane: "w2:p3", harness: "codex", status: "idle", alive: true, sessionId: "uuid-other" },
  ],
};

const SELF = "ag-3fK9x2mPq81LbR0w";
const OTHER = "ag-8Qw1nT5cZk2vXo9d";

function env(url: string, extra: Env = {}): Env {
  return { CYC_ENGINE_URL: url, HOME: "/home/tester", ...extra };
}
function cli(argv: string[], e: Env, stdin: Uint8Array = new Uint8Array(0)) {
  return run(argv, { env: e, stdin: async () => stdin });
}

// ---------------------------------------------------------------------------
// pure helpers

test("engineOrigin precedence: CYC_ENGINE_URL, then VOICE_ENGINE_URL, then the default", () => {
  expect(engineOrigin({ CYC_ENGINE_URL: "http://a:1/" })).toBe("http://a:1");
  expect(engineOrigin({ VOICE_ENGINE_URL: "http://b:2" })).toBe("http://b:2");
  expect(engineOrigin({ CYC_ENGINE_URL: "http://a:1", VOICE_ENGINE_URL: "http://b:2" })).toBe("http://a:1");
  // hermetic default: on a box RUNNING an engine, the real ~/.callyourcode
  // engine.sock would win the probe, so the default case pins an empty data dir.
  expect(engineOrigin({ CYC_DATA_DIR: "/nonexistent-cyc-test-scratch" })).toBe("http://127.0.0.1:10101");
});

test("tildify collapses the home prefix only", () => {
  expect(tildify("/home/tester/projects/foo", "/home/tester")).toBe("~/projects/foo");
  expect(tildify("/home/tester", "/home/tester")).toBe("~");
  expect(tildify("/etc/hosts", "/home/tester")).toBe("/etc/hosts");
  expect(tildify("/home/testerX/y", "/home/tester")).toBe("/home/testerX/y"); // not a path boundary
});

test("renderAgentsTable is docker-ps shaped and never shows the pane or session id", () => {
  const table = renderAgentsTable(AGENTS, "/home/tester");
  const lines = table.split("\n");
  expect(lines[0]).toMatch(/^AGENT ID\s+NAME\s+FOLDER\s+MUX\s+HARNESS\s+STATUS$/);
  expect(lines).toHaveLength(3);
  expect(lines[1]).toContain("ag-3fK9x2mPq81LbR0w");
  expect(lines[1]).toContain("deploy watcher");
  expect(lines[1]).toContain("~/projects/foo");
  expect(lines[1]).toContain("herdr");
  expect(lines[1]).toContain("working");
  // the pane id and the session id are internal, never rendered
  expect(table).not.toContain("w1:p1");
  expect(table).not.toContain("uuid-self");
});

test("resolveTarget matches on the stable id", () => {
  expect(resolveTarget(OTHER, AGENTS.agents)?.sessionId).toBe("uuid-other");
  expect(resolveTarget("ag-nope", AGENTS.agents)).toBeNull();
});

test("sniffPhotoMime reads the magic bytes", () => {
  expect(sniffPhotoMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe("image/png");
  expect(sniffPhotoMime(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe("image/jpeg");
  expect(sniffPhotoMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
  const webp = new Uint8Array(12);
  webp.set([0x52, 0x49, 0x46, 0x46], 0); webp.set([0x57, 0x45, 0x42, 0x50], 8);
  expect(sniffPhotoMime(webp)).toBe("image/webp");
  const heic = new Uint8Array(12);
  heic.set([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70], 0); heic.set([0x68, 0x65, 0x69, 0x63], 8);
  expect(sniffPhotoMime(heic)).toBe("image/heic");
  expect(sniffPhotoMime(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
});

// ---------------------------------------------------------------------------
// commands over the fake engine

test("cyc agents fetches GET /agents and prints the table", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["agents"], env(f.url));
  expect(r.code).toBe(0);
  expect(r.out).toContain("AGENT ID");
  expect(r.out).toContain("ag-3fK9x2mPq81LbR0w");
  expect(r.out).toContain("~/projects/foo");
});

test("cyc agent rename takes the agent id explicitly and POSTs /session/<sid>/rename", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["agent", "rename", SELF, "new name"], env(f.url)); // no env identity at all
  expect(r.code).toBe(0);
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0].path).toBe("/session/uuid-self/rename");
  expect(f.posts[0].json).toEqual({ name: "new name" });
});

test("cyc agent rename ignores env identity: the explicit id wins, CYC_AGENT_ID is inert", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["agent", "rename", OTHER, "x"],
    env(f.url, { CYC_AGENT_ID: SELF, HERDR_PANE_ID: "w1:p1" }));
  expect(r.code).toBe(0);
  expect(f.posts[0].path).toBe("/session/uuid-other/rename");
});

test("cyc agent rename with no name clears the override (empty name)", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["agent", "rename", SELF], env(f.url));
  expect(r.code).toBe(0);
  expect(f.posts[0].json).toEqual({ name: "" });
});

test("cyc agent rename without an agent id is usage, exit 2", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["agent", "rename"], env(f.url));
  expect(r.code).toBe(2);
  expect(f.posts).toHaveLength(0);
});

test("cyc agent message leads with the recipient, --from names the sender, honest author line", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["agent", "message", OTHER, "--from", SELF, "staging is green"], env(f.url));
  expect(r.code).toBe(0);
  expect(f.posts[0].path).toBe("/session/uuid-other/agent-message");
  expect(f.posts[0].json).toEqual({ author: `${SELF} (deploy watcher)`, text: "staging is green" });
});

test("cyc agent message without --from is usage, exit 2, nothing posted", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["agent", "message", OTHER, "hi there"], env(f.url));
  expect(r.code).toBe(2);
  expect(r.err).toContain("--from <fromAgentId>");
  expect(f.posts).toHaveLength(0);
});

test("cyc agent message with --from but no sender value is usage, exit 2", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["agent", "message", OTHER, "--from"], env(f.url));
  expect(r.code).toBe(2);
  expect(r.err).toContain("--from <fromAgentId>");
  expect(f.posts).toHaveLength(0);
});

test("cyc agent message with an unknown SENDER id is exit 1, nothing posted", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["agent", "message", OTHER, "--from", "ag-nope", "hi"], env(f.url));
  expect(r.code).toBe(1);
  expect(r.err).toBe("no such agent: ag-nope");
  expect(f.posts).toHaveLength(0);
});

test("cyc agent message to an unknown TARGET id is exit 1, nothing posted", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["agent", "message", "ag-nope", "--from", SELF, "hi"], env(f.url));
  expect(r.code).toBe(1);
  expect(r.err).toBe("no such agent: ag-nope");
  expect(f.posts).toHaveLength(0);
});

test("a 503 retriable becomes 'pane busy, retry shortly', exit 1", async () => {
  const f = fake({
    agents: AGENTS,
    reply: (p) => p.endsWith("/agent-message")
      ? { status: 503, body: { ok: false, retriable: true, error: "on a permission prompt" } }
      : undefined,
  });
  const r = await cli(["agent", "message", OTHER, "--from", SELF, "hi"], env(f.url));
  expect(r.code).toBe(1);
  expect(r.err).toBe("pane busy, retry shortly");
});

test("cyc agent photo <agentId> - reads stdin, sniffs the mime, POSTs the raw bytes", async () => {
  const f = fake({ agents: AGENTS });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const r = await cli(["agent", "photo", SELF, "-"], env(f.url), png);
  expect(r.code).toBe(0);
  expect(f.posts[0].path).toBe("/session/uuid-self/photo");
  expect(f.posts[0].contentType).toBe("image/png");
  expect([...f.posts[0].raw]).toEqual([...png]);
});

test("cyc agent photo <agentId> --clear POSTs an empty body", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["agent", "photo", SELF, "--clear"], env(f.url));
  expect(r.code).toBe(0);
  expect(f.posts[0].path).toBe("/session/uuid-self/photo");
  expect(f.posts[0].raw.length).toBe(0);
});

test("cyc agent photo with non-image bytes is refused before the POST", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["agent", "photo", SELF, "-"], env(f.url),
    new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  expect(r.code).toBe(1);
  expect(f.posts).toHaveLength(0);
});

test("cyc plugin leads with the agent id and posts {session, args}", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["plugin", SELF, "crons", "list"], env(f.url));
  expect(r.code).toBe(0);
  expect(f.posts[0].path).toBe("/plugin/crons/rpc/list");
  expect(f.posts[0].json).toEqual({ session: "uuid-self", args: null });
});

test("cyc plugin parses json-args; the leading agent id names any agent's scope", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(
    ["plugin", OTHER, "crons", "create", '{"kind":"once","name":"call mum"}'],
    env(f.url));
  expect(r.code).toBe(0);
  expect(f.posts[0].path).toBe("/plugin/crons/rpc/create");
  expect(f.posts[0].json).toEqual({ session: "uuid-other", args: { kind: "once", name: "call mum" } });
});

test("cyc plugin without an agent id / op is usage, exit 2, nothing posted (env is not identity)", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["plugin", "crons", "list"], env(f.url, { CYC_AGENT_ID: SELF }));
  expect(r.code).toBe(2);
  expect(r.err).toContain("cyc plugin <agentId> <pluginId> <op>");
  expect(f.posts).toHaveLength(0);
});

test("cyc plugin with an unknown agent id is exit 1, nothing posted", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["plugin", "ag-nope", "crons", "list"], env(f.url));
  expect(r.code).toBe(1);
  expect(r.err).toBe("no such agent: ag-nope");
  expect(f.posts).toHaveLength(0);
});

test("cyc plugin with bad JSON args is exit 2 BEFORE any request", async () => {
  const f = fake({ agents: AGENTS });
  const r = await cli(["plugin", SELF, "crons", "create", "{not json"], env(f.url));
  expect(r.code).toBe(2);
  expect(f.posts).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// exit codes, lifecycle pass-throughs, transport failure

test("an engine refusal is exit 1 with the engine's reason", async () => {
  const f = fake({
    agents: AGENTS,
    reply: (p) => p.endsWith("/rename") ? { status: 404, body: { ok: false, error: "no such session" } } : undefined,
  });
  const r = await cli(["agent", "rename", SELF, "x"], env(f.url));
  expect(r.code).toBe(1);
  expect(r.err).toBe("no such session");
});

test("explicit help is success (exit 0); no command and unknown are usage (exit 2)", async () => {
  const f = fake();
  expect((await cli(["help"], env(f.url))).code).toBe(0);
  expect((await cli(["--help"], env(f.url))).code).toBe(0);
  expect((await cli([], env(f.url))).code).toBe(2);
  const unknown = await cli(["frobnicate"], env(f.url));
  expect(unknown.code).toBe(2);
  expect(unknown.err).toContain("unknown command");
});

test("lifecycle verbs are exec pass-throughs, not wire calls", async () => {
  const e = env("http://127.0.0.1:10101");
  const install = await run(["install"], { env: e, stdin: async () => new Uint8Array(0) });
  expect(install.exec?.[0]).toBe("sh");
  expect(install.exec?.[1]).toMatch(/scripts\/install\.sh$/);

  const start = await run(["start"], { env: e, stdin: async () => new Uint8Array(0) });
  expect(start.exec?.[0]).toBe("sh");
  expect(start.exec?.[1]).toMatch(/scripts\/services\.sh$/);
  expect(start.exec?.[2]).toBe("start");

  const stop = await run(["stop"], { env: e, stdin: async () => new Uint8Array(0) });
  expect(stop.exec?.[0]).toBe("sh");
  expect(stop.exec?.[1]).toMatch(/scripts\/services\.sh$/);
  expect(stop.exec?.[2]).toBe("stop");

  const uninstall = await run(["uninstall"], { env: e, stdin: async () => new Uint8Array(0) });
  expect(uninstall.exec?.[0]).toBe("sh");
  expect(uninstall.exec?.[1]).toMatch(/scripts\/services\.sh$/);
  expect(uninstall.exec?.[2]).toBe("uninstall");

  const pair = await run(["pair"], { env: e, stdin: async () => new Uint8Array(0) });
  expect(pair.exec?.[0]).toBe("bun");
  expect(pair.exec?.[1]).toMatch(/agent-engine\/src\/security\/pairkey\.ts$/);

  const model = await run(["model", "whisper", "8"], { env: e, stdin: async () => new Uint8Array(0) });
  expect(model.exec?.[0]).toBe("bun");
  expect(model.exec?.[1]).toMatch(/agent-engine\/src\/runtime\/model\.ts$/);
  expect(model.exec?.slice(2)).toEqual(["whisper", "8"]);
});

test("cyc voice off|on|status route to the matching services.sh voice-* action", async () => {
  const e = env("http://127.0.0.1:10101");
  for (const [sub, action] of [["off", "voice-off"], ["on", "voice-on"], ["status", "voice-status"]]) {
    const r = await run(["voice", sub], { env: e, stdin: async () => new Uint8Array(0) });
    expect(r.code).toBe(0);
    expect(r.exec?.[0]).toBe("sh");
    expect(r.exec?.[1]).toMatch(/scripts\/services\.sh$/);
    expect(r.exec?.[2]).toBe(action);
    expect(r.err).toBeUndefined();
  }
});

test("bare cyc voice reports status (voice-status), no wire call", async () => {
  const e = env("http://127.0.0.1:10101");
  const r = await run(["voice"], { env: e, stdin: async () => new Uint8Array(0) });
  expect(r.code).toBe(0);
  expect(r.exec?.slice(1)).toEqual([expect.stringMatching(/scripts\/services\.sh$/), "voice-status"]);
});

test("cyc voice with an unknown subcommand is usage (exit 2), nothing exec'd", () => {
  const bad = cmdVoice(["mute"]);
  expect(bad.code).toBe(2);
  expect(bad.exec).toBeUndefined();
  expect(bad.err).toContain("cyc voice <off|on|status>");
});

test("cyc mcp is an exec pass-through to the local engine's MCP server", async () => {
  const e = env("http://127.0.0.1:10101");
  const r = await run(["mcp"], { env: e, stdin: async () => new Uint8Array(0) });
  expect(r.exec?.[0]).toBe("bun");
  // A RELATIVE-to-this-checkout path, not a machine-specific one baked in a config.
  expect(r.exec?.[1]).toMatch(/engine\/mcp\/src\/server\.ts$/);
});

test("cyc hook <name> resolves a whitelisted hook to python3 + the local script", async () => {
  const e = env("http://127.0.0.1:10101");
  const r = await run(["hook", "enforce-voice-reply", "--codex-notify"], { env: e, stdin: async () => new Uint8Array(0) });
  expect(r.exec?.[0]).toBe("python3");
  expect(r.exec?.[1]).toMatch(/engine\/hooks\/enforce-voice-reply\.py$/);
  expect(r.exec?.slice(2)).toEqual(["--codex-notify"]); // args pass through verbatim
});

test("cyc hook covers every hook the harness installer wires", () => {
  // The codex shell guard lives outside engine/hooks; the launcher still knows it.
  expect(hookScriptPath("enforce-shell-async")).toMatch(/engine\/harness\/codex\/enforce-shell-async\.py$/);
  expect(hookScriptPath("announce-session")).toMatch(/engine\/hooks\/announce-session\.py$/);
  expect(Object.keys(HOOK_SCRIPTS).sort()).toEqual(
    ["announce-session", "enforce-bash-async", "enforce-shell-async", "enforce-voice-reply"],
  );
});

test("cyc hook refuses an unknown name (exit 2), never runs an arbitrary path", () => {
  const bad = cmdHook(["../../../etc/passwd"]);
  expect(bad.code).toBe(2);
  expect(bad.exec).toBeUndefined();
  expect(bad.err).toMatch(/unknown hook/);
  expect(cmdHook([]).code).toBe(2); // no name at all
});

test("a dead engine is exit 1 with a reach-the-engine reason, not a crash", async () => {
  const f = startFake({ agents: AGENTS });
  const url = f.url;
  f.stop(); // now nothing is listening on that port
  const r = await cli(["agents"], env(url));
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/could not reach the engine/);
});
