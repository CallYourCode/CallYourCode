/* TranscriptSupport for pi / codex / opencode, proven on captured fixtures, and
 * the one wired fact that goes with it.
 *
 * Each harness has its own on-disk shape. The unit half feeds that shape and
 * asks for the same four answers the app already renders for Claude:
 * conversation messages, model name, context (or a clean null), and
 * working/idle edges. Captured fixtures rather than authored ones, because the
 * whole risk here is a real file having a field where we guessed it would not.
 *
 * The seam half is the pair of facts a fixture cannot prove: that a non-claude
 * pane's model and context ride the sessions contract WITHOUT its harness
 * narration leaking into the chat stream, and that Stop on such a pane is a mux
 * ctrl+c rather than a claude-only hook. Both are the shipped modules over a
 * FakeHerdr and a REAL MuxAdapter; no engine process anywhere.
 *
 * ENV IS SET AT FILE SCOPE, once, and restored: PI_SESSIONS_DIR and CODEX_HOME
 * are read per call by the readers, so the wiring below points them at this
 * file's own tmp trees and nothing here can ever reach a real one.
 *
 *   bun test agent-engine/src/chat/transcripts.test.ts
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import {
  CODEX_TRANSCRIPT,
  OPENCODE_TRANSCRIPT,
  PI_TRANSCRIPT,
  encodePiCwd,
} from "./transcripts.ts";
import { wireCore, type WireCore, type FakeClient, wireId } from "../test-utils/wire-core.ts";
import { HARNESS_CWD } from "../test-utils/fake-herdr.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";
import { dispatchClientFrame } from "../transport/frames.ts";

const PI_FIXTURE = new URL("../fixtures/pi-session.jsonl", import.meta.url).pathname;
const CODEX_FIXTURE = new URL("../fixtures/codex-rollout.jsonl", import.meta.url).pathname;
const OPENCODE_FIXTURE = new URL("../fixtures/opencode-session.json", import.meta.url).pathname;

const PI_ID = "01a01059-2c50-729b-93ba-9e0c814a537b";
const CODEX_ID = "01a0106d-3a0d-72e3-8676-f83e7f8377a2";
const OPENCODE_ID = "ses_fef9371fbffewhWV3LZjuWdmn8";
const PI_CWD = "/home/user/projects/wt-612-engine-multiharness";

/* A BOUND THAT MEASURES THE LOADED MACHINE, NOT THE BEHAVIOR. until()'s default
 * is 2s; the seam polls below wait on a real reconcile that, under `bun test
 * --parallel` with a worker per core, is competing for the CPU that publishes
 * the very condition being polled. These tests time out about one full run in
 * ten that way -- never in isolation, only under contention. Nothing about the
 * claims changes: the condition still has to become true, and a real regression
 * still fails here with the caller's own sentence; the wider bound only buys the
 * loaded box the time to schedule the work. */
const LOADED_MS = 10_000;

/* This file's throwaway harness homes, and the paths the fixtures were copied
 * to inside them. Built once in beforeAll so the env swap happens at file scope
 * and the seam wiring below (which reads PI_SESSIONS_DIR on its first reconcile)
 * already has it. */
let piHome = "";
let codexHome = "";
let piPath = "";
let codexPath = "";
/** The same pi fixture, filed under the cwd every fake pane reports. */
let piPanePath = "";
const prev: Record<string, string | undefined> = {};

beforeAll(async () => {
  piHome = await tmpDir("cyc-pi-");
  codexHome = await tmpDir("cyc-codex-");
  const piBody = await Bun.file(PI_FIXTURE).text();

  piPath = join(piHome, encodePiCwd(PI_CWD), `2026-08-17T15-31-14-640Z_${PI_ID}.jsonl`);
  await mkdir(join(piPath, ".."), { recursive: true });
  await writeFile(piPath, piBody);

  piPanePath = join(piHome, encodePiCwd(HARNESS_CWD), `2026-08-17T15-31-14-640Z_${PI_ID}.jsonl`);
  await mkdir(join(piPanePath, ".."), { recursive: true });
  await writeFile(piPanePath, piBody);

  codexPath = join(codexHome, "sessions", "2026", "08", "17",
    `rollout-2026-08-17T17-53-08-${CODEX_ID}.jsonl`);
  await mkdir(join(codexPath, ".."), { recursive: true });
  await writeFile(codexPath, await Bun.file(CODEX_FIXTURE).text());

  prev.PI_SESSIONS_DIR = process.env.PI_SESSIONS_DIR;
  prev.CODEX_HOME = process.env.CODEX_HOME;
  process.env.PI_SESSIONS_DIR = piHome;
  process.env.CODEX_HOME = codexHome;
});

afterAll(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ------------------------------------------------------- the readers (unit)

test("pi fixture: messages, model, clean-null context, working/idle edges", async () => {
  const lines = (await Bun.file(PI_FIXTURE).text()).trim().split("\n");
  const located = PI_TRANSCRIPT.locate({ id: PI_ID, kind: "id", source: "herdr:pi" }, PI_CWD);
  expect(located?.sessionId).toBe(PI_ID);
  expect(located?.path).toBe(piPath);

  const msgs = await PI_TRANSCRIPT.messages!(located!.path);
  expect(msgs.length, "a real pi session has a conversation").toBeGreaterThan(0);
  expect(msgs.some((m) => m.role === "user" && m.text.includes("wire the TranscriptSupport table"))).toBe(true);
  expect(msgs.some((m) => m.role === "claude" && m.text.includes("TranscriptSupport"))).toBe(true);

  expect(await PI_TRANSCRIPT.model(located!.path)).toBe("grok-4.6");
  /* FAIL OPEN (2026-09-02): the fixture's one assistant message carries
   * usage {input:7082, cacheRead:512, cacheWrite:0}; 7,594 in context against
   * the 1M default (pi writes no window into the file) floors to 0, a number,
   * not the old "no window, no answer" null. */
  expect(await PI_TRANSCRIPT.contextPct(located!.path),
    "pi tokens against the 1M default: 7594 / 1M floors to 0").toBe(0);

  const user = lines.find((l) => l.includes('"role":"user"'))!;
  const tool = lines.find((l) => l.includes("toolUse"))!;
  expect(PI_TRANSCRIPT.turnEdge(user)).toBe("working");
  expect(PI_TRANSCRIPT.turnEdge(tool)).toBe("working");
  expect(PI_TRANSCRIPT.turnEdge(JSON.stringify({
    type: "message",
    message: { role: "assistant", stopReason: "stop" },
  }))).toBe("idle");
});

test("codex fixture: messages, model, context percent, working/idle edges", async () => {
  const lines = (await Bun.file(CODEX_FIXTURE).text()).trim().split("\n");
  const located = CODEX_TRANSCRIPT.locate(
    { id: CODEX_ID, kind: "id", source: "herdr:codex" }, "/tmp");
  expect(located?.path).toBe(codexPath);

  const msgs = await CODEX_TRANSCRIPT.messages!(located!.path);
  expect(msgs.length).toBeGreaterThan(0);
  expect(msgs.some((m) => m.role === "user" && m.text.includes("single word pong"))).toBe(true);
  expect(msgs.some((m) => m.role === "claude" && m.text === "pong")).toBe(true);
  expect(msgs.some((m) => m.text.includes("recommended_plugins")),
    "harness dumps are not conversation").toBe(false);

  expect(await CODEX_TRANSCRIPT.model(located!.path)).toBe("gpt-5.6-sol");
  expect(await CODEX_TRANSCRIPT.contextPct(located!.path)).toBe(5); // 13569 / 258400

  const started = lines.find((l) => l.includes("task_started"))!;
  const done = lines.find((l) => l.includes("task_complete"))!;
  expect(CODEX_TRANSCRIPT.turnEdge(started)).toBe("working");
  expect(CODEX_TRANSCRIPT.turnEdge(done)).toBe("idle");
});

test("opencode fixture: messages, model, clean-null context, working/idle edges", async () => {
  const located = OPENCODE_TRANSCRIPT.locate(
    { id: OPENCODE_FIXTURE, kind: "path", source: "test" }, PI_CWD);
  expect(located).not.toBeNull();

  const msgs = await OPENCODE_TRANSCRIPT.messages!(located!.path);
  expect(msgs.length).toBeGreaterThan(0);
  expect(msgs.some((m) => m.role === "user" && m.text.includes("single word pong"))).toBe(true);
  expect(msgs.some((m) => m.role === "claude" && m.text === "pong")).toBe(true);

  expect(await OPENCODE_TRANSCRIPT.model(located!.path)).toBe("deepseek-v4-pro");
  /* FAIL OPEN (2026-09-02): the newest assistant message's tokens
   * {input:8806, cache:{read:0, write:0}} against the 1M default (opencode
   * writes no window into the session row) floors to 0, a number. */
  expect(await OPENCODE_TRANSCRIPT.contextPct(located!.path),
    "opencode tokens against the 1M default: 8806 / 1M floors to 0").toBe(0);

  expect(OPENCODE_TRANSCRIPT.turnEdge(JSON.stringify({ role: "user" }))).toBe("working");
  expect(OPENCODE_TRANSCRIPT.turnEdge(JSON.stringify({ type: "step-finish", reason: "stop" })))
    .toBe("idle");
});

/* THE ARITHMETIC, on records in the fixtures' own shapes with numbers big enough
 * to land on a digit (the captured fixtures are tiny sessions that floor to 0).
 * Fail open (2026-09-02): tokens off the harness's record, window off
 * contextWindowFor (1M default, the harness's own where it reports one). */
test("pi: the newest assistant usage against the 1M default, and null with no usage", async () => {
  const dir = await tmpDir("cyc-pi-ctx-");
  const rec = (input: number, cacheRead: number) => JSON.stringify({
    type: "message", id: "m", timestamp: "2026-08-17T15:32:45.015Z",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: "grok-4.6",
      usage: { input, output: 90, cacheRead, cacheWrite: 0, reasoning: 28, totalTokens: input + cacheRead + 90 } },
  });
  const model = JSON.stringify({ type: "model_change", id: "a", timestamp: "2026-08-17T15:31:14.968Z", provider: "xai", modelId: "grok-4.6" });
  const path = join(dir, "s.jsonl");
  await writeFile(path, [model, rec(100_000, 0), rec(200_000, 50_000)].join("\n") + "\n");
  expect(await PI_TRANSCRIPT.contextPct(path), "newest wins: 250k of 1M").toBe(25);
  const claude = join(dir, "c.jsonl");
  await writeFile(claude, [
    JSON.stringify({ type: "model_change", id: "a", timestamp: "t", provider: "anthropic", modelId: "claude-haiku-4-5-20251001" }),
    rec(100_000, 0).replace('"model":"grok-4.6"', '"model":"claude-haiku-4-5-20251001"'),
  ].join("\n") + "\n");
  expect(await PI_TRANSCRIPT.contextPct(claude), "pi on haiku takes haiku's 200k override").toBe(50);
  const empty = join(dir, "e.jsonl");
  await writeFile(empty, model + "\n");
  expect(await PI_TRANSCRIPT.contextPct(empty), "no assistant usage yet is no reading").toBeNull();
});

test("opencode: the newest assistant tokens, the session row as fallback, 1M default", async () => {
  const dir = await tmpDir("cyc-oc-ctx-");
  const dump = (messages: any[], session: any) => JSON.stringify({ session, messages, parts: [] });
  const asst = (input: number, read: number, t: number) => ({
    id: `m${t}`, time_created: t,
    data: { role: "assistant", modelID: "deepseek-v4-pro", providerID: "deepseek", finish: "stop",
      tokens: { total: input + read + 3, input, output: 3, reasoning: 20, cache: { write: 0, read } } },
  });
  const session = { id: "ses_x", model: { id: "deepseek-v4-pro", providerID: "deepseek", variant: "default" },
    tokens_input: 400_000, tokens_cache_read: 0 };
  const a = join(dir, "a.json");
  await writeFile(a, dump([asst(100_000, 0, 1), asst(300_000, 50_000, 2)], session));
  expect(await OPENCODE_TRANSCRIPT.contextPct(a), "newest assistant message: 350k of 1M").toBe(35);
  const b = join(dir, "b.json");
  await writeFile(b, dump([{ id: "u", time_created: 1, data: { role: "user" } }], session));
  expect(await OPENCODE_TRANSCRIPT.contextPct(b), "no assistant tokens: the session row's 400k").toBe(40);
  const c = join(dir, "c.json");
  await writeFile(c, dump([], { id: "ses_y", model: { id: "kimi-k3" } }));
  expect(await OPENCODE_TRANSCRIPT.contextPct(c), "no tokens anywhere is no reading").toBeNull();
});

test("opencode sqlite: the session-row fallback counts tokens_cache_read off the live db, not just the fixture", async () => {
  /* The json dump carries the whole session row, so the fixture path always
   * saw tokens_cache_read; the sqlite path has to SELECT the column or the
   * cache-read term silently reads as 0 on every real opencode.db. */
  const dir = await tmpDir("cyc-oc-db-");
  const { Database } = await import("bun:sqlite");
  const dbPath = join(dir, "opencode.db");
  const db = new Database(dbPath);
  db.run("create table session (id text primary key, model text, tokens_input integer, tokens_cache_read integer)");
  db.run("create table message (id text, session_id text, time_created integer, data text)");
  db.run("create table part (message_id text, session_id text, time_created integer, data text)");
  db.query("insert into session values (?, ?, ?, ?)").run(
    "ses_db", JSON.stringify({ id: "deepseek-v4-pro", providerID: "deepseek", variant: "default" }),
    300_000, 100_000);
  db.close();
  expect(await OPENCODE_TRANSCRIPT.contextPct(`${dbPath}#ses_db`),
    "input 300k + cache read 100k of the 1M default").toBe(40);
});

test("codex: the reported window wins, and a transcript without one takes the 1M default", async () => {
  const dir = await tmpDir("cyc-codex-ctx-");
  const turn = JSON.stringify({ timestamp: "t", type: "turn_context", payload: { model: "gpt-5.6-sol" } });
  const count = (total: number, win?: number) => JSON.stringify({
    timestamp: "t", type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, ...(win ? { model_context_window: win } : {}) } },
  });
  const reported = join(dir, "r.jsonl");
  await writeFile(reported, [turn, count(129_200, 258_400)].join("\n") + "\n");
  expect(await CODEX_TRANSCRIPT.contextPct(reported), "codex's own 258,400 window").toBe(50);
  const bare = join(dir, "b.jsonl");
  await writeFile(bare, [turn, count(250_000)].join("\n") + "\n");
  expect(await CODEX_TRANSCRIPT.contextPct(bare), "no window written yet: 250k of the 1M default").toBe(25);
});

test("a session id no harness wrote resolves to nothing, rather than to somebody else's file",
  async () => {
    /* The refusal every locate shares. These read a directory named by a value
     * that ultimately comes off a herdr snapshot, so "not found" has to be null
     * rather than a nearest match: an id that resolved to the newest file in the
     * tree would put a stranger's conversation on the row. */
    expect(PI_TRANSCRIPT.locate({ id: "not-a-session", kind: "id", source: "herdr:pi" }, PI_CWD))
      .toBeNull();
    expect(CODEX_TRANSCRIPT.locate({ id: "not-a-session", kind: "id", source: "herdr:codex" }, "/tmp"))
      .toBeNull();
    expect(OPENCODE_TRANSCRIPT.locate(null, PI_CWD)).toBeNull();
    /* opencode's `path` form is a store LOCATION, not a claim that the store
     * exists, so it is passed through verbatim and the emptiness is discovered
     * on the read. That distinction is what lets a captured dump and the live
     * sqlite db go down the same code path. */
    const missing = OPENCODE_TRANSCRIPT.locate(
      { id: join(piHome, "nope.json"), kind: "path", source: "test" }, PI_CWD);
    expect(missing!.path).toBe(join(piHome, "nope.json"));
    expect(await OPENCODE_TRANSCRIPT.messages!(missing!.path),
      "a store that is not there must read as nothing, never throw").toEqual([]);
    expect(OPENCODE_ID.startsWith("ses_"), "the opencode fixture is still the one we captured")
      .toBe(true);
  });

// -------------------------------------------------------------- the wire (seam)

let core: WireCore | null = null;
afterEach(async () => {
  await core?.stop();
  core = null;
});

const listOf = (client: FakeClient): any[] => (client.last("sessions")?.list as any[]) ?? [];

test("a pi pane's model and context ride the sessions contract", async () => {
  /* The row's `model` comes off the pi session file as a DISPLAY name ("Grok 4.6"), the same
   * composed-here contract sessions-frame.ts states for every harness: the pi
   * reader surfaces the raw id ("grok-4.6"), and the context cache maps it to
   * the display name for the row, so the list never shows a bare id where a
   * claude row shows "Opus 4.8". (Before, the generic branch stored the raw id
   * as the display name and the list showed "claude-fable-5" / "grok-4.6".) */
  core = await wireCore({
    panes: ["w1:p1"], agents: { "w1:p1": "pi" }, sessionIds: { "w1:p1": PI_ID },
    with: ["sessions"],
  });
  const c = core;
  const client = c.client();
  await until(() => !!c.byHandle("w1:p1"), { what: "the pi pane to reconcile" });
  await until(() => {
    c.hello(client);
    return listOf(client).find((s) => s.id === wireId("w1:p1"))?.model === "Grok 4.6";
  }, { what: "the pi row to grow a mapped model name from its session file" });

  const row = listOf(client).find((s) => s.id === wireId("w1:p1"));
  expect(row.agentId, "the row does not say which coding agent it is").toBe("pi");
  expect(row.contextPct, "pi tokens against the 1M default ride the row: 7594 / 1M floors to 0").toBe(0);
  // the overlay gate (wire name kept for the app): pi now declares an activity
  // tail, so its row advertises its harness id and the app paints its rows.
  expect(row.claudeSessionId, "the pi row must open the app's session-row overlay").toBe(PI_ID);
});

test("a pi pane's conversation enters the chat stream; non-turns do not", async () => {
  /* pi's transcript IS its conversation, the same as claude/codex/opencode:
   * the reader now declares a sessionEvents tail (readers/pi.ts piEventsSince),
   * so a pi pane's user prompts and assistant replies land in the chat log
   * HOWEVER the pane was started. Until this, pi alone had no such tail: only a
   * pi that cyc itself launched streamed rows (over the extension socket), so a
   * pi opened by hand in a mux pane showed replies but no session messages and
   * the app sat on "Queued". This is the guardrail's inverse: the real turns
   * MUST show (they are the conversation, not the agent talking to itself), and
   * the records that are NOT turns -- toolResult rows, the session/model_change
   * bookkeeping lines -- must never become chat bubbles. */
  core = await wireCore({
    panes: ["w1:p1"], agents: { "w1:p1": "pi" }, sessionIds: { "w1:p1": PI_ID },
    with: ["frames"],
  });
  const c = core;
  await until(() => !!c.byHandle("w1:p1"), { what: "the pi pane to reconcile" });

  /* The tail starts at the file's END on first bind (startAtEnd: a resumed
   * session never replays its history), so the fixture already on disk is NOT
   * expected in the log; a turn written AFTER the bind is. Each beat appends a
   * fresh turn until one lands, so the test never races the subscribe. */
  const page = c.client();
  let n = 0;
  const stamp = () => new Date().toISOString();
  await until(() => {
    n++;
    appendFileSync(piPanePath,
      JSON.stringify({ type: "message", id: `u-live-${n}`, parentId: null, timestamp: stamp(),
        message: { role: "user", content: [{ type: "text", text: `live prompt ${n}` }], timestamp: Date.now() } }) + "\n"
      + JSON.stringify({ type: "message", id: `a-live-${n}`, parentId: null, timestamp: stamp(),
        message: { role: "assistant", content: [{ type: "text", text: `live reply ${n}` }],
          stopReason: "stop", timestamp: Date.now() } }) + "\n"
      + JSON.stringify({ type: "message", id: `r-live-${n}`, parentId: null, timestamp: stamp(),
        message: { role: "toolResult", toolCallId: "x", toolName: "bash",
          content: [{ type: "text", text: `tool output ${n}` }], isError: false, timestamp: Date.now() } }) + "\n");
    void dispatchClientFrame(page.sock, { t: "attach", id: wireId("w1:p1"), since: 0 });
    return (page.last("attach-ok")?.total as number ?? 0) > 0;
  }, { timeoutMs: LOADED_MS, what: "a live pi turn to reach the chat log" });

  const ok = page.last("attach-ok")!;
  const texts = ((ok.pages as any[]) ?? [])
    .flatMap((p) => (p.messages ?? []).map((m: any) => String(m.text)));
  expect(texts.some((t) => /^live prompt \d+$/.test(t)),
    "the user's prompt did not reach the chat stream").toBe(true);
  expect(texts.some((t) => /^live reply \d+$/.test(t)),
    "the assistant reply did not reach the chat stream").toBe(true);
  expect(texts.some((t) => t.includes("tool output")),
    "a toolResult record became a chat row").toBe(false);
  expect(texts.some((t) => t.includes("wire the TranscriptSupport table")),
    "the history already on disk was replayed into the chat").toBe(false);
  // a bookkeeping record (no role message) is never a bubble
  const kinds = ((ok.pages as any[]) ?? [])
    .flatMap((p) => (p.messages ?? []).map((m: any) => m.kind));
  expect(kinds.every((k: string) => k !== "status" && k !== "session"),
    "a non-turn record became a chat row").toBe(true);
});

test("Stop on a pi pane sends the mux its interrupt key (Escape), not a claude hook", async () => {
  /* Stop is a MULTIPLEXER verb. The claude lane has a hook that can end a turn
   * politely, and reaching for it on a pane running something else would stop
   * nothing at all while looking, on this side, exactly like success. */
  core = await wireCore({
    panes: ["w1:p2"], agents: { "w1:p2": "pi" }, sessionIds: { "w1:p2": PI_ID },
    with: ["frames"],
  });
  const c = core;
  await until(() => !!c.byHandle("w1:p2"),
    { timeoutMs: LOADED_MS, what: "the pi pane to reconcile" });
  const client = c.client();

  await dispatchClientFrame(client.sock, { t: "interrupt", id: wireId("w1:p2") });
  await until(() => c.herdr.keys.some((k) => k.paneId === "w1:p2" && k.keys.includes("escape")),
    { timeoutMs: LOADED_MS, what: "the interrupt to reach the pi pane as escape" });
  // ctrl+c only clears pi's input box; it must not be what Stop sends
  expect(c.herdr.keys.some((k) => k.paneId === "w1:p2" && k.keys.includes("ctrl+c"))).toBe(false);

  // and nothing was TYPED at it: an interrupt is keys, never text
  expect(c.herdr.texts.filter((t) => t.paneId === "w1:p2")).toEqual([]);
});

test("Stop is the same mux verb whatever the pane runs, and presses nothing on a dead one",
  async () => {
    /* Two claims in one wiring. The first is that the ctrl+c above is not a
     * pi-shaped special case: a claude pane takes the identical path, so there
     * is one Stop and not two. The second is the refusal -- a session herdr no
     * longer lists has no pane to press, and pressing anyway would send keys to
     * whatever now owns that pane id. */
    core = await wireCore({
      panes: ["w1:p1", "w1:p2"], agents: { "w1:p2": "codex" }, with: ["frames"],
    });
    const c = core;
    await until(() => c.sessions.size === 2,
      { timeoutMs: LOADED_MS, what: "the mixed fleet to reconcile" });
    const client = c.client();

    await dispatchClientFrame(client.sock, { t: "interrupt", id: wireId("w1:p1") }); // claude
    await dispatchClientFrame(client.sock, { t: "interrupt", id: wireId("w1:p2") }); // codex
    await until(() =>
      c.herdr.keys.some((k) => k.paneId === "w1:p1" && k.keys.includes("ctrl+c")) &&
      c.herdr.keys.some((k) => k.paneId === "w1:p2" && k.keys.includes("ctrl+c")),
      { timeoutMs: LOADED_MS, what: "both interrupts to reach their panes" });

    // now the codex pane goes away, and its dead row must press nothing
    await c.herdr.setAgentGone("w1:p2", true);
    await until(() => !c.byHandle("w1:p2") || c.byHandle("w1:p2")!.alive === false,
      { timeoutMs: LOADED_MS, what: "the pane's exit to be reconciled" });
    const before = c.herdr.keys.length;

    await dispatchClientFrame(client.sock, { t: "interrupt", id: wireId("w1:p2") });
    expect(c.herdr.keys.length, "Stop pressed a key on a pane herdr no longer lists")
      .toBe(before);
  });
