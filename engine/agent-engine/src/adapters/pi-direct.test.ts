/* LANE B (design Gap 1): the real pi HarnessReader and pi DIRECT input.
 *
 * FIVE tests that stand alone (no host ~/.pi, no real pi process):
 *   1-3  the reader (readers/pi.ts) over a FAKE pi transcript written to a temp
 *        PI_SESSIONS_DIR, in the exact on-disk shape learned READ-ONLY from a
 *        real host transcript (session / model_change / message records).
 *   4    the direct-input WIRE (adapters/pi-direct.ts) proven against a FAKE pi
 *        RPC endpoint that parses pi's JSON-line control protocol.
 *   5    the adapter ROUTING (adapters/mux-adapter.ts): a pi pane with a live
 *        endpoint takes his message DIRECTLY (no keystrokes), and pi without an
 *        endpoint -- and every keystroke harness -- falls back to typing.
 *
 *   bun test agent-engine/src/adapters/pi-direct.test.ts
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../test-utils/tmp.ts";
import { encodePiCwd } from "../chat/transcripts.ts";
import { piReader } from "../readers/pi.ts";
import { piPromptFrame, piRpcEndpoint, type DirectInputSink } from "./pi-direct.ts";
import type { Multiplexer, MuxAgent } from "../terminal/mux.ts";

const { MuxAdapter } = await import("./mux-adapter.ts");

/* ----------------------------------------------------- a fake pi transcript */

const PI_CWD = "/home/x/proj";
const PI_ID = "b1000000-0000-4000-8000-00000000abcd";
const TS = "2026-09-02T20-21-28-955Z";

/** The pi session jsonl in its confirmed record shape. A session header, a
 *  model_change (grok-4.6), a user turn, then an assistant turn with usage and
 *  a stop reason -- the tail edge and the context read both come off this. */
function piTranscript(): string {
  return [
    JSON.stringify({ type: "session", version: 3, id: PI_ID, timestamp: "2026-09-02T20:21:28.955Z", cwd: PI_CWD }),
    JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-02T20:21:29.000Z", provider: "xai", modelId: "grok-4.6" }),
    JSON.stringify({ type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-09-02T20:21:29.001Z", thinkingLevel: "medium" }),
    JSON.stringify({ type: "message", id: "u1", parentId: "t1", timestamp: "2026-09-02T20:21:30.000Z",
      message: { role: "user", content: [{ type: "text", text: "run the tests please" }] } }),
    JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-02T20:21:35.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "On it." }], model: "grok-4.6", provider: "xai",
        stopReason: "stop", usage: { input: 2, output: 40, cacheRead: 5000, cacheWrite: 500, totalTokens: 5542 } } }),
  ].join("\n") + "\n";
}

let root = "";
let piPath = "";

beforeEach(async () => {
  root = await tmpDir("cyc-pireader-");
  process.env.PI_SESSIONS_DIR = root;
  const dir = join(root, encodePiCwd(PI_CWD));
  mkdirSync(dir, { recursive: true });
  piPath = join(dir, `${TS}_${PI_ID}.jsonl`);
  writeFileSync(piPath, piTranscript());
});

afterEach(() => {
  delete process.env.PI_SESSIONS_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- 1. detect + locate */

test("piReader: detects the pi kind and locates a session jsonl under the cwd slug", () => {
  expect(piReader.tag).toBe("pi");
  expect(piReader.detect({ kindStamp: "pi", cwd: PI_CWD, sessionRef: null })).toBe(true);
  expect(piReader.detect({ kindStamp: "codex", cwd: PI_CWD, sessionRef: null })).toBe(false);

  // locate a session by id + cwd -> its jsonl under --<cwd-with-dashes>--
  const byId = piReader.locate({ id: PI_ID, kind: "id", source: "herdr:pi" }, PI_CWD);
  expect(byId?.sessionId).toBe(PI_ID);
  expect(byId?.path).toBe(piPath);

  // and by a direct path ref, the way a previousSessionFile link carries it
  const byPath = piReader.locate({ id: piPath, kind: "path", source: "herdr:pi" }, PI_CWD);
  expect(byPath?.path).toBe(piPath);
  expect(byPath?.sessionId).toBe(PI_ID);
});

/* ----------------------------------------------------- 2. turnEdge + context + messages */

test("piReader: reads the conversation, context, and working/idle edges from the tail", async () => {
  const msgs = await piReader.messages!(piPath);
  expect(msgs.map((m) => m.role)).toEqual(["user", "claude"]);
  expect(msgs[0].text).toBe("run the tests please");
  expect(msgs[1].text).toBe("On it.");

  // a user turn and a toolUse stop are WORKING; a plain stop is IDLE
  const userLine = JSON.stringify({ type: "message", message: { role: "user", content: [] } });
  const toolLine = JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "toolUse" } });
  const doneLine = JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop" } });
  expect(piReader.turnEdge(userLine)).toBe("working");
  expect(piReader.turnEdge(toolLine)).toBe("working");
  expect(piReader.turnEdge(doneLine)).toBe("idle");

  // context is a number off the newest assistant usage (input+cacheRead+cacheWrite
  // against the model window); 5502 / 1M floors to 0 but is a number, not null
  expect(await piReader.contextPct(piPath)).toBe(0);
});

/* ----------------------------------------------- 3. friendly model + launch/resume + input method */

test("piReader: surfaces the raw model id and carries launch/resume + direct input", async () => {
  // pi records the raw id "grok-4.6"; the reader surfaces it verbatim (like
  // codex/opencode), and the friendly "Grok 4.6" is applied downstream
  expect(await piReader.model(piPath)).toBe("grok-4.6");

  // pi HAS a real resume verb, so resume is a command, not fabricated. The
  // launch program is the shipped `pi` binary (no personal wrapper).
  expect(piReader.launch?.command).toBe("pi");
  expect(piReader.launch?.resume(PI_ID)).toBe(`pi --session ${PI_ID}`);

  // pi declares the first-class DIRECT input path
  expect(piReader.inputDelivery).toBe("direct");
});

/* --------------------------------------------------- 4. the direct-input wire vs a fake pi endpoint */

/** A FAKE pi RPC endpoint: it parses pi's JSON-LINE control protocol exactly as
 *  the real `runRpcMode` does (one command object per line) and records the
 *  commands. It never launches pi; it proves our writer emits the frame pi
 *  dispatches as `session.prompt(message, ...)`. */
function fakePiRpc(): { sink: DirectInputSink; commands: Array<Record<string, unknown>> } {
  const commands: Array<Record<string, unknown>> = [];
  let buf = "";
  const sink: DirectInputSink = {
    write(line) {
      buf += line;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (raw.trim()) commands.push(JSON.parse(raw));
      }
    },
  };
  return { sink, commands };
}

test("pi-direct: piRpcEndpoint writes a well-formed `prompt` command the fake pi endpoint accepts", async () => {
  // the wire frame is newline-terminated and parses to pi's prompt command
  const frame = piPromptFrame("hello pi", "fixed-id");
  expect(frame.endsWith("\n")).toBe(true);
  expect(JSON.parse(frame.trim())).toEqual({ id: "fixed-id", type: "prompt", message: "hello pi" });

  const pi = fakePiRpc();
  const endpoint = piRpcEndpoint(pi.sink);
  await endpoint.send("run the tests please");

  expect(pi.commands).toHaveLength(1);
  expect(pi.commands[0].type).toBe("prompt");
  expect(pi.commands[0].message).toBe("run the tests please");
  expect(typeof pi.commands[0].id).toBe("string"); // pi keys its response by this id
});

/* ---------------------------------------------- 5. the adapter routes pi direct, others keystroke */

type Rpc = { method: string; pane: string; text?: string; keys?: string[] };

/** A Multiplexer that records every pane call and answers readPane with a
 *  healthy input box that ECHOES what was typed into it, so the KEYSTROKE
 *  fallback passes the echo gate (the body appears on screen), submits on the
 *  enter, and reads an empty box back as consumed. A real composer echoes; a
 *  fake that never did would refuse every non-claude keystroke send. */
function fakeMux(agents: MuxAgent[]): Multiplexer & { rpcs: Rpc[] } {
  const rpcs: Rpc[] = [];
  const held = new Map<string, string>();
  const box = (paneId: string) =>
    ["────────────", `\u276f ${held.get(paneId) ?? ""}`, "────────────", "  model \u00b7 ctx 1%"].join("\n");
  const mux = {
    rpcs,
    onAgents(cb: (a: MuxAgent[]) => void) { cb(agents); },
    start() {},
    async readPane(paneId: string) { rpcs.push({ method: "pane.read", pane: paneId }); return { text: box(paneId), truncated: false }; },
    async sendText(paneId: string, text: string) { rpcs.push({ method: "pane.send_text", pane: paneId, text }); held.set(paneId, (held.get(paneId) ?? "") + text); },
    async sendKeys(paneId: string, ...keys: string[]) { rpcs.push({ method: "pane.send_keys", pane: paneId, keys }); if (keys.includes("enter")) held.set(paneId, ""); },
    async renamePane() {},
    async closePane() {},
    workspaceOf() { return null; },
    knownCwds() { return []; },
    async newTab() { return "w9:p1"; },
  } as unknown as Multiplexer & { rpcs: Rpc[] };
  return mux;
}

function paneOf(paneId: string, agent: string): MuxAgent {
  return {
    paneId, name: "proj", cwd: PI_CWD, status: "idle", agent,
    agentSession: { id: PI_ID, kind: "id", source: `herdr:${agent}` },
    workspace: "w1", tab: null, displayAgent: null, stateChangeSeq: 0,
  } as MuxAgent;
}

test("adapter: a pi pane with a live endpoint takes input DIRECTLY; no endpoint and other harnesses type", async () => {
  const PI_PANE = "w1:pi";
  const CLAUDE_PANE = "w1:cl";
  const mux = fakeMux([paneOf(PI_PANE, "pi"), paneOf(CLAUDE_PANE, "claude")]);
  const adapter = new MuxAdapter(mux);
  adapter.onAgents(() => {});

  // the seam knows how each pane takes input
  expect(adapter.inputMethod(PI_PANE)).toBe("direct");
  expect(adapter.inputMethod(CLAUDE_PANE)).toBe("keystroke");

  // register a live pi endpoint and send: it reaches pi over the direct channel,
  // and NOT a single keystroke is typed at that pane
  const pi = fakePiRpc();
  adapter.registerDirectInput(PI_PANE, piRpcEndpoint(pi.sink));
  await adapter.sendInput(PI_PANE, "direct hello", "d-direct");

  expect(pi.commands.map((c) => c.message)).toEqual(["direct hello"]);
  expect(mux.rpcs.filter((r) => r.pane === PI_PANE)).toEqual([]); // no read, no type, no enter

  // clear the endpoint: the same pi pane now FALLS BACK to keystrokes (type + enter)
  adapter.registerDirectInput(PI_PANE, null);
  await adapter.sendInput(PI_PANE, "fallback hello", "d-fallback");
  expect(pi.commands.map((c) => c.message)).toEqual(["direct hello"]); // endpoint untouched
  expect(mux.rpcs.filter((r) => r.pane === PI_PANE && r.method === "pane.send_text"))
    .toEqual([{ method: "pane.send_text", pane: PI_PANE, text: "fallback hello" }]);
  expect(mux.rpcs.filter((r) => r.pane === PI_PANE && r.method === "pane.send_keys"))
    .toEqual([{ method: "pane.send_keys", pane: PI_PANE, keys: ["enter"] }]);

  // a keystroke harness never consults the endpoint registry at all
  await adapter.sendInput(CLAUDE_PANE, "typed hello", "d-typed");
  expect(mux.rpcs.filter((r) => r.pane === CLAUDE_PANE && r.method === "pane.send_text"))
    .toEqual([{ method: "pane.send_text", pane: CLAUDE_PANE, text: "typed hello" }]);
});

test("Stop interrupts pi with Escape (its interrupt key) and claude with ctrl+c", async () => {
  const PI_PANE = "w1:pi";
  const CLAUDE_PANE = "w1:cl";
  const mux = fakeMux([paneOf(PI_PANE, "pi"), paneOf(CLAUDE_PANE, "claude")]);
  const adapter = new MuxAdapter(mux);
  adapter.onAgents(() => {});
  await adapter.interrupt(PI_PANE);
  await adapter.interrupt(CLAUDE_PANE);
  const keys = mux.rpcs.filter((r) => r.method === "pane.send_keys").map((r) => [r.pane, r.keys]);
  expect(keys).toEqual([[PI_PANE, ["escape"]], [CLAUDE_PANE, ["ctrl+c"]]]);
});
