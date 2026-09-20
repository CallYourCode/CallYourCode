/* THE HARNESS ACTIVITY TAILS through the adapter (subscribe's reader
 * dispatch): a codex pane's rollout jsonl and an opencode pane's sqlite db
 * both feed OverlayBatches, riding the same WatcherPool + 250ms heartbeat the
 * claude tail rides (tail-poll.test.ts proves the claude lane; this file
 * proves the two new ones and the dispatch itself).
 *
 * NON-VACUITY: like tail-poll.test.ts, every adapter here gets a WatcherPool
 * whose watchFn NEVER fires, so a batch that arrives after an append/insert
 * can only have come from the heartbeat.
 *
 *   bun test agent-engine/src/adapters/harness-tails.test.ts
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { FSWatcher } from "node:fs";
import { tmpDir } from "../test-utils/tmp.ts";
import { WatcherPool } from "../runtime/watcher-pool.ts";
import { MuxAdapter, type OverlayBatch } from "./mux-adapter.ts";
import type { Multiplexer, MuxAgent } from "../terminal/mux.ts";

const CODEX_UUID = "01aa2233-44bb-7000-8000-556677889900";
const OC_SID = "ses_aaaa0000bbbbCCCCddddEEEE01";
let root: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await tmpDir("harness-tails");
  for (const k of ["CODEX_HOME", "OPENCODE_DB", "CYC_PROJECTS_DIR"]) savedEnv[k] = process.env[k];
  process.env.CODEX_HOME = join(root, "codex-home");
  process.env.OPENCODE_DB = join(root, "opencode.db");
  process.env.CYC_PROJECTS_DIR = join(root, "projects");
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A pool whose fs.watch NEVER fires: the heartbeat is the only mover. */
const inertPool = () =>
  new WatcherPool(() => ({ close() {} }) as unknown as FSWatcher);

const stubMux = (agents: MuxAgent[]): Multiplexer =>
  ({
    onAgents(cb: (a: MuxAgent[]) => void) { cb(agents); },
    start() {},
    async readPane() { return { text: "", truncated: false }; },
    async sendText() {}, async sendKeys() {},
    async renamePane() {}, async closePane() {},
    workspaceOf() { return null; }, knownCwds() { return []; },
    async newTab() { return "w9:p1"; },
  }) as unknown as Multiplexer;

const pane = (agent: string, id: string): MuxAgent => ({
  paneId: "w1:p1",
  name: "hx-tails",
  cwd: "/tmp/hx-proj",
  status: "working",
  agent,
  agentSession: { id, kind: "id", source: `test:${agent}` },
  workspace: "w1",
  tab: "t1",
  displayAgent: null,
  stateChangeSeq: 1,
});

function adapterOn(agents: MuxAgent[], pool: WatcherPool): MuxAdapter {
  const a = new MuxAdapter(stubMux(agents), undefined, (x) => x, pool);
  a.onAgents(() => {});
  return a;
}

const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
};
const BEATS = MuxAdapter.TAIL_POLL_MS * 8;

/* ------------------------------------------------------------------ codex */

const codexItemLine = (id: string, cmd: string): string =>
  JSON.stringify({ timestamp: new Date().toISOString(), ordinal: 1, type: "event_msg",
    payload: { type: "item_completed", thread_id: CODEX_UUID, turn_id: CODEX_UUID,
      item: { type: "CommandExecution", id, command: ["bash", "-c", cmd] } } });

function seedCodex(): string {
  const dir = join(process.env.CODEX_HOME!, "sessions", "2026", "09", "05");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-05T10-00-00-${CODEX_UUID}.jsonl`);
  writeFileSync(path, codexItemLine("exec-before", "echo old") + "\n");
  return path;
}

test("a codex pane's rollout tails: an appended item_completed lands as a codex tool event, moved by the heartbeat alone", async () => {
  const path = seedCodex();
  const adapter = adapterOn([pane("codex", CODEX_UUID)], inertPool());
  const batches: OverlayBatch[] = [];
  const sub = adapter.subscribe("w1:p1", (b) => batches.push(b), null);
  expect(sub).not.toBeNull();
  const at = sub!.at; // EOF of the seed line: the old row is not replayed
  expect(at).toBeGreaterThan(0);

  appendFileSync(path, codexItemLine("exec-live", "git status") + "\n");
  expect(await until(() => batches.length > 0, BEATS)).toBe(true);
  const evs = batches.flatMap((b) => b.events);
  expect(evs).toHaveLength(1);
  expect(evs[0]).toMatchObject({ uuid: "exec-live", kind: "tool", tool: "exec",
    text: "exec: git status", off: at });
  expect(batches[batches.length - 1].offset).toBeGreaterThan(at);
  sub!.stop();
});

test("the backfill span read parses with the pane's harness: codex lines for a codex handle, none for a claude default", async () => {
  const path = seedCodex();
  const adapter = adapterOn([pane("codex", CODEX_UUID)], inertPool());
  const size = Bun.file(path).size;
  const withHandle = await adapter.readTranscriptSpan(path, 0, size, "w1:p1");
  expect(withHandle.events).toHaveLength(1);
  expect(withHandle.events[0]).toMatchObject({ uuid: "exec-before", kind: "tool" });
  // no handle: the claude parser (the pre-existing callers' behaviour), which
  // sees nothing in a codex line
  const without = await adapter.readTranscriptSpan(path, 0, size);
  expect(without.events).toEqual([]);
  expect(without.offset).toBe(size); // bytes still consumed: the pointer moves
});

/* --------------------------------------------------------------- opencode */

const OC_TOOL = (cmd: string) => ({
  type: "tool", tool: "bash", callID: "bash_1",
  state: { status: "completed", input: { command: cmd }, output: "", title: cmd,
    time: { start: 1, end: 2 } },
});

function seedOpencode(rows: Array<[string, number, unknown]>): string {
  const path = process.env.OPENCODE_DB!;
  const db = new Database(path);
  db.run(`CREATE TABLE part (
    id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`);
  const ins = db.prepare("insert into part values (?, 'msg_1', ?, ?, ?, ?)");
  for (const [id, t, data] of rows) ins.run(id, OC_SID, t, t, JSON.stringify(data));
  db.close();
  return path;
}

test("an opencode pane's db tails: history flushes on subscribe, a new terminal tool part lands via the heartbeat, cursor rides offset", async () => {
  const path = seedOpencode([
    ["prt_hist", 1000, OC_TOOL("cat old.txt")],
    ["prt_txt", 1005, { type: "text", text: "hi" }],
  ]);
  const adapter = adapterOn([pane("opencode", OC_SID)], inertPool());
  const batches: OverlayBatch[] = [];
  const sub = adapter.subscribe("w1:p1", (b) => batches.push(b), null);
  expect(sub).not.toBeNull();
  expect(sub!.at).toBe(0); // never read: the first drain IS the history

  expect(await until(() => batches.length > 0, BEATS)).toBe(true);
  expect(batches[0].events).toHaveLength(1);
  expect(batches[0].events[0]).toMatchObject({ uuid: "prt_hist", kind: "tool", tool: "bash",
    text: "bash: cat old.txt" });
  expect(batches[0].offset).toBe(1005); // the cursor: max time_updated seen

  const db = new Database(path);
  db.run("insert into part values ('prt_new', 'msg_2', ?, 2000, 2001, ?)",
    [OC_SID, JSON.stringify(OC_TOOL("ls -la"))]);
  db.close();
  expect(await until(() => batches.length > 1, BEATS)).toBe(true);
  const late = batches.slice(1).flatMap((b) => b.events);
  expect(late).toEqual([expect.objectContaining({ uuid: "prt_new", text: "bash: ls -la" })]);
  expect(batches[batches.length - 1].offset).toBe(2001);
  sub!.stop();
});

test("a resumed opencode tail (a saved cursor) replays nothing before it", async () => {
  seedOpencode([["prt_old", 1000, OC_TOOL("cat old.txt")], ["prt_new", 3000, OC_TOOL("pwd")]]);
  const adapter = adapterOn([pane("opencode", OC_SID)], inertPool());
  const batches: OverlayBatch[] = [];
  const sub = adapter.subscribe("w1:p1", (b) => batches.push(b), 2000);
  expect(sub).not.toBeNull();
  expect(sub!.at).toBe(2000);
  expect(await until(() => batches.length > 0, BEATS)).toBe(true);
  expect(batches.flatMap((b) => b.events)).toEqual([
    expect.objectContaining({ uuid: "prt_new", text: "bash: pwd" }),
  ]);
  sub!.stop();
});

/* --------------------------------------------------------------- dispatch */

test("a harness with no declared sessionEvents gets no tail (pi's events ride its socket)", async () => {
  const adapter = adapterOn([pane("pi", "01bb0000-0000-7000-8000-000000000001")], inertPool());
  expect(adapter.subscribe("w1:p1", () => {}, null)).toBeNull();
});
