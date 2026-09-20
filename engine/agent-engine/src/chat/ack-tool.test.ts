/* THE OTHER HALF OF #447: WHAT THE TOOL DOES WHEN NO ACK COMES.
 *
 * ack.test.ts holds the ENGINE's half -- the said ack is issued after logChat,
 * carries the seq that proves it, and a reply with nowhere durable to go is
 * answered ok:false rather than dropped in silence. That leaves one fact it
 * cannot state, because it is not a fact about the engine at all:
 *
 *   THE TOOL CALL MUST FAIL, WITHIN A BOUND, IN WORDS THAT NAME THE RETRY.
 *
 * "the tool call errors" is a property of the MCP PROCESS. Its one confirm wait
 * (CONFIRM_MS, the loopback POST's abort deadline) and its handling of a refused
 * or erroring engine live in engine/mcp/src/server.ts, which is spawned per session
 * and runs the code it was born with -- so it is driven here as what it is: a
 * real process, over its real stdio JSON-RPC, against stub engines this file
 * serves as plain HTTP for POST /agent/reply.
 *
 * The engines are stubs on purpose. Each one is a single behaviour the tool has
 * to survive, and none of them needs a session graph, a chat log or a pane:
 *
 *   nothing listening        the session cannot reach its engine at all
 *   answers ok:false         the engine had nowhere durable to put the reply
 *   answers 503              the engine took the POST and could not complete it
 *   answers ok:true          the happy path, so the wait itself is proven to end
 *
 * NO ENGINE IS BOOTED. Every server here is a Bun.serve on port 0.
 *
 *   bun test agent-engine/src/chat/ack-tool.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";


const MCP_DIR = join(import.meta.dir, "..", "..", "..", "mcp");
/** The pane id the tool registers as. Never resolved by anything here: these
 *  stubs answer by shape, not by session. */
const PANE = "w1:p1";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) { try { cleanups.pop()!(); } catch { /* already gone */ } }
});

/* A STUB ENGINE over the LOOPBACK POST the tool uses now (mcp-http): one HTTP
 * handler for POST /agent/reply, and one rule for how it answers a delivery. The
 * response body IS the ack, so `reply(m)` returns the JSON to hand back, or the
 * sentinel "die" to model an engine that took the request and could not complete
 * it (a 503, the HTTP shape of the old mid-call socket drop). `seen` captures the
 * last body so a test can assert what the tool sent. There is no register step
 * any more, so nothing waits on a handshake: the first POST is the delivery. */
function stubEngine(reply: (m: any) => any) {
  const state = { seen: null as any };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/agent/reply") {
        return new Response("no", { status: 404 });
      }
      let m: any;
      try { m = await req.json(); } catch { return new Response("bad", { status: 400 }); }
      state.seen = m;
      const out = reply(m);
      if (out === "die") return new Response("gone", { status: 503 });
      return Response.json(out);
    },
  });
  cleanups.push(() => server.stop(true));
  // Handed to the tool as VOICE_ENGINE_URL (a ws:// url for back-compat); the
  // MCP derives the http base from it and POSTs /agent/reply to this same port.
  return { state, url: `ws://127.0.0.1:${server.port}/ws`, stop: () => server.stop(true) };
}

/** A port nothing is listening on: taken from the OS and handed straight back.
 *  The same trick freePort() plays for the boot harness, spelled here so no unit
 *  or seam file has to write a port number. */
function deadUrl(): string {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const url = `ws://127.0.0.1:${probe.port}/ws`;
  probe.stop(true);
  return url;
}

/* Drive the real engine/mcp/src/server.ts over its stdio MCP protocol: initialize,
 * then tools/call, reading the JSON-RPC result the tool returns. This is the
 * only place "the tool call errors" can be asserted about the tool itself. */
async function mcpProc(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    cwd: MCP_DIR,
    env: { ...process.env, ...env },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  cleanups.push(() => { try { proc.kill(); } catch { /* gone */ } });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const drain = async () => {
    const reader = (proc.stdout as ReadableStream).getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      buf += dec.decode(value as Uint8Array);
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && pending.has(m.id)) {
          const p = pending.get(m.id)!; pending.delete(m.id);
          if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
        }
      }
    }
  };
  void drain();
  let nextId = 1;
  const write = (o: unknown) => {
    (proc.stdin as any).write(JSON.stringify(o) + "\n");
    (proc.stdin as any).flush?.();
  };
  const rpc = (method: string, params: unknown) => {
    const id = nextId++;
    return new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write({ jsonrpc: "2.0", id, method, params });
    });
  };
  await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ack-test", version: "1" },
  });
  write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  return { call: (name: string, args: unknown) => rpc("tools/call", { name, arguments: args }) };
}

const toolText = (r: any) => (r?.content ?? []).map((c: any) => c?.text ?? "").join("");

/* THE SHIPPED CONFIRM WAIT, pinned by reading the line that declares it.
 *
 * The tool now does one loopback POST whose response IS the ack; the wait below
 * bounds a WEDGED engine (accepts the connection, never answers) before the
 * fetch is aborted. A dead engine rejects at connect, faster, so the number is
 * only about the wedged case. It is pinned here off the source: fifteen seconds,
 * with the env override present so the bound test measures the shipped wait.
 * Change the constant and this fails; change the test and the diff says you did. */
test("the shipped confirm wait is fifteen seconds, whatever a test asks for", async () => {
  const src = await Bun.file(
    join(import.meta.dir, "..", "..", "..", "mcp", "src", "server.ts")
  ).text();
  const line = src.split("\n").find((l) => l.includes("const CONFIRM_MS"));
  expect(line, "CONFIRM_MS is not declared where this test looks for it").toBeDefined();
  expect(line, "the shipped confirm wait is no longer fifteen seconds").toContain("15_000");
  expect(line, "the override is gone, so a bound test could no longer shorten the wait")
    .toContain("CYC_MCP_CONFIRM_MS");
});

test("a dead engine makes the tool error within a bound, naming the retry", async () => {
  /* The session cannot reach its engine at all: nothing is listening on the
   * port, so the loopback POST is refused at connect. The tool must surface that
   * as a retryable error and NEVER hang the session, because a hung tool call is
   * a claude that never finishes its turn. A refused connection fails at once, so
   * no timer is even spent -- the confirm wait is shortened here only to prove no
   * path silently falls back to the long wait. */
  const mcp = await mcpProc({ HERDR_PANE_ID: PANE, VOICE_ENGINE_URL: deadUrl(),
    CYC_MCP_CONFIRM_MS: "400" });

  const at = Date.now();
  const res = await mcp.call("chat", { text: "is anyone home" });
  const took = Date.now() - at;

  expect(res.isError, "the tool reported success while the engine was unreachable").toBe(true);
  expect(toolText(res), "a dead engine did not tell the agent to retry, so the reply is just lost")
    .toMatch(/retry|terminal/i);
  /* Bounded well above the refusal, so a give-up that never happens fails here
   * rather than hanging: the give-up is the whole subject. */
  expect(took, `the tool took ${took}ms to give up on a dead engine`).toBeLessThan(4_000);
}, 15_000);

test("an engine that cannot keep the reply errors the tool and names the retry", async () => {
  /* The engine is up and answers HONESTLY that it dropped the reply -- which is
   * exactly what ack.test.ts proves it does for a pane it has no session for.
   * The tool must surface that as an error rather than as success, or the Stop
   * hook is told a reply happened that did not. */
  const engine = stubEngine(() => ({
    ok: false,
    message: "this session is not registered with the engine yet; retry the reply in a moment",
  }));
  const mcp = await mcpProc({ HERDR_PANE_ID: "w9:ghost-pane", VOICE_ENGINE_URL: engine.url });

  const at = Date.now();
  const res = await mcp.call("chat", { text: "no session for me, so keep nothing" });
  const took = Date.now() - at;

  expect(res.isError, "the tool reported success for a reply the engine dropped").toBe(true);
  expect(toolText(res), "the error does not name the retry the Stop hook needs").toMatch(/retry/i);
  expect(took, `the tool waited ${took}ms for an answer it already had`).toBeLessThan(4_000);
});

test("an engine that accepts then dies before acking errors the tool at once", async () => {
  /* The mid-call death, over HTTP: an engine that takes the POST and cannot
   * complete it, answering 503 rather than an ack. The tool fails on that
   * response rather than sitting until CONFIRM_MS (15s), so a wedged engine never
   * makes a session wait a quarter of a minute to find out. */
  const engine = stubEngine(() => "die");
  const mcp = await mcpProc({ HERDR_PANE_ID: PANE, VOICE_ENGINE_URL: engine.url });

  const at = Date.now();
  const res = await mcp.call("chat", { text: "you accepted this and then vanished" });
  const took = Date.now() - at;

  expect(res.isError, "the tool reported success for a reply the engine never confirmed").toBe(true);
  expect(toolText(res), "the error does not name the retry").toMatch(/retry/i);
  expect(took, `the tool waited ${took}ms after the socket dropped instead of failing at once`)
    .toBeLessThan(4_000);
});

test("an ack the engine confirms ends the wait and reports the msgId it used", async () => {
  /* The happy path, and it is not a formality: it is what proves the three
   * failures above are failures of the ENGINE's answer rather than a tool that
   * cannot succeed at all. The msgId comes back so the agent's own logs can be
   * lined up against the engine's. */
  const engine = stubEngine(() => ({ ok: true, message: "sent to the chat", seq: 7 }));
  const mcp = await mcpProc({ HERDR_PANE_ID: PANE, VOICE_ENGINE_URL: engine.url });

  const res = await mcp.call("chat", { text: "this one lands" });
  const seen = engine.state.seen;
  expect(res.isError, `a confirmed reply was reported as an error: ${toolText(res)}`)
    .toBeFalsy();
  expect(toolText(res)).toContain("sent to the chat");
  expect(toolText(res)).toContain(seen.msgId);
  /* AND IT CARRIED AN IDEMPOTENCY KEY (#505). The tool mints one per logical
   * utterance and REUSES it on a retry, which is what makes "Retry the tool
   * call" safe instead of duplicating; the engine's half of that is in
   * dedupe.test.ts. */
  expect(typeof seen.key, "the tool sent no idempotency key, so a retry would double the reply")
    .toBe("string");
});
