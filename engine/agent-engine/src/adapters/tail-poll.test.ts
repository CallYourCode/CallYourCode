/* THE TAIL HEARTBEAT (activity latency): a transcript append must reach the
 * overlay/status tails even when fs.watch delivers nothing.
 *
 * Why this exists: the transcript jsonl is written incrementally (measured
 * 2026-09-05: tool_use/text records are on disk within ~30ms of their record
 * timestamp, mid-turn, not at turn completion), yet the live engine showed
 * drain bursts 1.6-3.9s behind disk because the fs.watch change events for
 * consecutive appends arrived late or coalesced -- and a lost event would
 * strand the tail until the NEXT append. MuxAdapter now re-pumps every live
 * tail on a TAIL_POLL_MS heartbeat, bounding that worst case.
 *
 * NON-VACUITY BY CONSTRUCTION: every test here injects a WatcherPool whose
 * watchFn NEVER fires its callback. The only pump triggers left are the one
 * initial flush at subscribe time (before any append) and the heartbeat, so
 * a batch that arrives after an append can only have come from the poll.
 *
 *   bun test agent-engine/src/adapters/tail-poll.test.ts
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { FSWatcher } from "node:fs";
import { tmpDir } from "../test-utils/tmp.ts";
import { sessionFilePath } from "../sessions/session-events.ts";
import { WatcherPool } from "../runtime/watcher-pool.ts";
import { MuxAdapter, type OverlayBatch } from "./mux-adapter.ts";
import type { Multiplexer, MuxAgent } from "../terminal/mux.ts";

const CWD = "/tmp/tail-poll-proj";
const UUID = "11aa22bb-33cc-4d44-8e55-66ff77889900";
let root: string;
let prevProjects: string | undefined;

beforeEach(async () => {
  root = await tmpDir("tail-poll");
  prevProjects = process.env.CYC_PROJECTS_DIR;
  process.env.CYC_PROJECTS_DIR = join(root, "projects");
});
afterEach(() => {
  if (prevProjects === undefined) delete process.env.CYC_PROJECTS_DIR;
  else process.env.CYC_PROJECTS_DIR = prevProjects;
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

const PANE: MuxAgent = {
  paneId: "w1:p1",
  name: "tail-poll",
  cwd: CWD,
  status: "working",
  agent: "claude",
  agentSession: { id: UUID, kind: "id", source: "herdr:claude" },
  workspace: "w1",
  tab: "t1",
  displayAgent: null,
  stateChangeSeq: 1,
};

/** Seed the transcript at the exact path the adapter resolves, with one
 *  pre-existing line so a delivered batch holding old bytes would be caught. */
function seed(): string {
  const path = sessionFilePath(CWD, UUID)!;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, toolLine("Read", "old-before-subscribe") + "\n");
  return path;
}

function toolLine(name: string, marker: string): string {
  return JSON.stringify({
    type: "assistant", uuid: `u-${marker}`, timestamp: new Date().toISOString(),
    message: { content: [{ type: "tool_use", id: `toolu_${marker}`, name, input: { file_path: marker } }] },
  });
}

function promptLine(marker: string): string {
  return JSON.stringify({
    type: "user", uuid: `u-${marker}`, timestamp: new Date().toISOString(),
    promptId: `p-${marker}`, message: { content: `run the ${marker} step` },
  });
}

function adapterOn(pool: WatcherPool): MuxAdapter {
  const a = new MuxAdapter(stubMux([PANE]), undefined, (x) => x, pool);
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

test("a mid-turn appended tool record reaches the overlay batch via the heartbeat alone", async () => {
  const path = seed();
  const adapter = adapterOn(inertPool());
  const batches: OverlayBatch[] = [];
  const sub = adapter.subscribe("w1:p1", (b) => batches.push(b), null);
  expect(sub).not.toBeNull();

  // quiet beats deliver nothing: no bytes moved, no callback
  await new Promise((r) => setTimeout(r, 2 * MuxAdapter.TAIL_POLL_MS + 100));
  expect(batches.length).toBe(0);

  appendFileSync(path, toolLine("Bash", "mid-turn") + "\n");
  const got = await until(() => batches.length > 0, 6 * MuxAdapter.TAIL_POLL_MS);
  expect(got).toBe(true);
  // only the NEW record, as a tool event; the pre-subscribe line stays consumed
  const events = batches.flatMap((b) => b.events);
  expect(events.length).toBe(1);
  expect(events[0].kind).toBe("tool");
  expect(events[0].tool).toBe("Bash");
  expect(events[0].uuid).toBe("u-mid-turn");
  sub!.stop();
});

test("a prompt append reaches the status tail as a working edge via the heartbeat alone", async () => {
  const path = seed();
  const adapter = adapterOn(inertPool());
  const edges: string[] = [];
  const unsub = adapter.subscribeStatus("w1:p1", (e) => edges.push(e));
  expect(unsub).not.toBeNull();

  appendFileSync(path, promptLine("edge") + "\n");
  const got = await until(() => edges.length > 0, 6 * MuxAdapter.TAIL_POLL_MS);
  expect(got).toBe(true);
  expect(edges[0]).toBe("working");
  unsub!();
});

test("stopping the last tail stops the heartbeat: a later append moves nothing", async () => {
  const path = seed();
  const adapter = adapterOn(inertPool());
  const batches: OverlayBatch[] = [];
  const sub = adapter.subscribe("w1:p1", (b) => batches.push(b), null);
  expect(sub).not.toBeNull();
  // let the initial flush-at-subscribe drain settle before stopping, so the
  // append below cannot be picked up by that already-scheduled drain
  await new Promise((r) => setTimeout(r, 50));
  sub!.stop();

  appendFileSync(path, toolLine("Bash", "after-stop") + "\n");
  await new Promise((r) => setTimeout(r, 3 * MuxAdapter.TAIL_POLL_MS + 100));
  expect(batches.length).toBe(0);
});
