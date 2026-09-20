/* The transcript ingest (ingest.ts; design A.4, A.5): the tail pointer, the
 * initial backfill and what a restart resumes. Fake adapter, fake deps, no
 * engine, no disk: the "transcript" is a list of spans the stub hands back
 * for [from, to), so the test can see exactly which bytes were asked for.
 *
 *   bun test agent-engine/src/chat/ingest.test.ts
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { initChatlog, resetForTest as resetChatlog } from "./chatlog.ts";
import { initIngest, syncIngest, hasIngest, backfillInProgress, resetForTest as resetIngest,
  BACKFILL_SPAN, type IngestSession } from "./ingest.ts";
import type { OverlayBatch } from "../adapters/mux-adapter.ts";
import type { TailPointer } from "../runtime/agentmeta.ts";
import type { SessionRec } from "./sessionrec.ts";
import type { SessionEvent } from "../sessions/session-events.ts";
import { until } from "../test-utils/wait.ts";

const SID = "1e5e5e5e-1111-4aaa-8bbb-000000000001";
const LINE = 1024; // every fake transcript line is this long (a span is a whole number of lines)

let sessions: Map<string, IngestSession>;
let tails: Map<string, TailPointer>; // `${aid}|${sid}`
let appended: SessionRec[];
let logs: { event: string; fields: Record<string, unknown> }[];
let spansRead: [number, number][];
let liveCb: ((b: OverlayBatch) => void) | null;
let subscribedFrom: (number | null)[];
let fileSize: number;

const ev = (i: number): SessionEvent =>
  ({ uuid: `u${i}`, ts: 1_000_000 + i, kind: "reply", text: `line ${i}`, off: i * LINE });

/** The fake transcript: line i occupies [i*LINE, (i+1)*LINE). A span read
 *  returns every whole line inside [from, to) and stands at the byte past the
 *  last one; a fileSize that is not a whole number of lines is a torn last
 *  line, which is never consumed. */
async function readSpan(_p: string, from: number, to: number): Promise<OverlayBatch> {
  spansRead.push([from, to]);
  const end = Math.min(to, fileSize);
  const events: SessionEvent[] = [];
  let at = from;
  while (at + LINE <= end) { events.push(ev(at / LINE)); at += LINE; }
  return { events, queueOps: [], consumed: [], delivered: [], offset: at };
}

function mkSession(): IngestSession {
  const s: IngestSession = {
    id: "ag-1", muxHandle: "w1:p1", alive: true, viaMux: true, status: "idle", busy: false,
    harnessSessionId: SID, chat: [], log: [], agent: { id: "claude" },
  } as IngestSession;
  sessions.set(s.id, s);
  return s;
}

beforeEach(() => {
  sessions = new Map();
  tails = new Map();
  appended = [];
  logs = [];
  spansRead = [];
  liveCb = null;
  subscribedFrom = [];
  fileSize = 0;
  resetChatlog();
  resetIngest();
  initChatlog({
    chatOf: (id) => sessions.get(id)?.chat,
    restoredChats: () => new Map(),
    persistPatch: () => {},
    broadcast: () => {},
    chatRefFor: (id) => ({ aid: id, chatId: "c1" }),
    indexMsgBlobs: () => {},
    appendMsg: () => {},
    appendRec: (_aid, _chatId, rec) => { appended.push(rec); },
  });
  initIngest({
    sessionOf: (id) => sessions.get(id),
    sessions: () => sessions.values(),
    broadcastSessions: () => {},
    subscribe: (_h, cb, from) => {
      subscribedFrom.push(from);
      liveCb = cb;
      // the real adapter starts at `from` when it is inside the file, else at EOF
      const at = from !== null && from >= 0 && from <= fileSize ? from : fileSize;
      return { stop: () => { liveCb = null; }, at };
    },
    readTranscriptSpan: readSpan,
    subscribeStatus: () => () => {},
    transcriptFile: () => ({ path: "/fake/t.jsonl", sessionId: SID }),
    tailOf: (aid, sid) => tails.get(`${aid}|${sid}`),
    setTail: (aid, sid, ptr) => { if (ptr) tails.set(`${aid}|${sid}`, ptr); else tails.delete(`${aid}|${sid}`); },
    log: (event, fields) => logs.push({ event, fields }),
  });
});
afterEach(() => { resetIngest(); resetChatlog(); });

const ptr = () => tails.get(`ag-1|${SID}`);
const backfilled = () => until(() => !backfillInProgress() && !ptr()?.bf, { what: "the backfill to finish" });

describe("a transcript this engine has never read", () => {
  test("the tail starts at EOF and the backfill reads [0, EOF) in spans, saving progress, then drops bf", async () => {
    const s = mkSession();
    fileSize = 2 * BACKFILL_SPAN + 5 * LINE; // three spans' worth
    syncIngest();
    expect(hasIngest("ag-1")).toBe(true);
    expect(subscribedFrom).toEqual([null]);
    expect(ptr()).toEqual({ h: "claude", off: fileSize, bf: { at: 0, to: fileSize } });
    expect(logs[0]).toMatchObject({ event: "ingest.start", fields: { off: fileSize, backfill: fileSize } });

    await backfilled();
    // three forward spans, each bounded by BACKFILL_SPAN
    expect(spansRead.length).toBe(3);
    expect(spansRead[0]).toEqual([0, BACKFILL_SPAN]);
    expect(spansRead.every(([a, b]) => b - a <= BACKFILL_SPAN)).toBe(true);
    // every line became one record, on this session's log, in file order
    const n = Math.floor(fileSize / LINE);
    expect(s.log.length).toBe(n);
    expect(appended.length).toBe(n);
    expect(s.log.map((r) => r.src!.rid)).toEqual(Array.from({ length: n }, (_, i) => `u${i}`));
    expect(s.log[0]).toMatchObject({ seq: 0, kind: "reply", src: { h: "claude", sid: SID, rid: "u0", off: 0 } });
    // the pointer keeps the tail's offset and no longer owes a backfill
    expect(ptr()).toEqual({ h: "claude", off: fileSize });
    const done = logs.find((l) => l.event === "ingest.backfill.done")!;
    expect(done.fields).toMatchObject({ from: 0, to: fileSize, added: n, spans: 3 });
  });

  test("an empty transcript owes no backfill", async () => {
    mkSession();
    fileSize = 0;
    syncIngest();
    expect(ptr()).toEqual({ h: "claude", off: 0 });
    expect(backfillInProgress()).toBeNull();
    expect(spansRead).toEqual([]);
  });

  test("a torn last line ends the job at the last whole line; the tail owns the rest", async () => {
    const s = mkSession();
    fileSize = 4 * LINE + 17; // 4 whole lines and a partial fifth
    syncIngest();
    await backfilled();
    expect(s.log.length).toBe(4);
    expect(ptr()).toEqual({ h: "claude", off: fileSize });
    // one span for the whole lines, one that confirms the rest is no whole line
    expect(spansRead).toEqual([[0, fileSize], [4 * LINE, fileSize]]);
  });
});

describe("a restart", () => {
  test("resumes the tail at the saved pointer and does not re-read the file", async () => {
    const s = mkSession();
    fileSize = 10 * LINE;
    tails.set(`ag-1|${SID}`, { h: "claude", off: 7 * LINE, rid: "u6", ts: 1_000_006 });
    syncIngest();
    expect(subscribedFrom).toEqual([7 * LINE]);
    expect(logs[0]).toMatchObject({ event: "ingest.resume", fields: { off: 7 * LINE } });
    expect(backfillInProgress()).toBeNull();
    expect(spansRead).toEqual([]);
    expect(s.log.length).toBe(0); // the records are in the log file already, not re-minted here
  });

  test("resumes an interrupted backfill from its bf progress, reading only what is left", async () => {
    const s = mkSession();
    fileSize = 3 * BACKFILL_SPAN;
    tails.set(`ag-1|${SID}`, { h: "claude", off: fileSize, bf: { at: 2 * BACKFILL_SPAN, to: fileSize } });
    syncIngest();
    expect(logs[0]).toMatchObject({ event: "ingest.resume", fields: { backfill: { at: 2 * BACKFILL_SPAN, to: fileSize } } });
    await backfilled();
    expect(spansRead).toEqual([[2 * BACKFILL_SPAN, fileSize]]);
    expect(s.log[0].src!.off).toBe(2 * BACKFILL_SPAN);
    expect(ptr()).toEqual({ h: "claude", off: fileSize });
  });
});

describe("the live tail", () => {
  test("appends each batch once (a replay past the pointer adds nothing) and moves the pointer", async () => {
    const s = mkSession();
    fileSize = 0;
    syncIngest();
    const batch: OverlayBatch = { events: [ev(0), ev(1)], queueOps: [], consumed: [], delivered: [], offset: 2 * LINE };
    liveCb!(batch);
    expect(s.log.map((r) => r.src!.rid)).toEqual(["u0", "u1"]);
    expect(ptr()).toEqual({ h: "claude", off: 2 * LINE, rid: "u1", ts: 1_000_001 });
    expect(logs.find((l) => l.event === "ingest.append")?.fields).toMatchObject({ added: 2, off: 2 * LINE });

    liveCb!(batch); // the same bytes again (a watcher re-fire, a re-subscribe)
    expect(s.log.length).toBe(2);
    expect(appended.length).toBe(2);
    expect(logs.filter((l) => l.event === "ingest.append").length).toBe(1);
  });

  test("a delivered record is a `delivered` fact keyed by the user record it landed as", async () => {
    const s = mkSession();
    fileSize = 0;
    syncIngest();
    liveCb!({ events: [], queueOps: [], consumed: [], offset: LINE,
      delivered: [{ text: "do the thing", uuid: "uD", ts: 1_000_009, off: 0 }] });
    expect(s.log.map((r) => [r.kind, r.text, r.src!.rid])).toEqual([["delivered", "do the thing", "delivered:uD"]]);
  });

  test("the ingest stops when the session dies or rotates, and its pointer stays", async () => {
    const s = mkSession();
    fileSize = 0;
    syncIngest();
    expect(hasIngest("ag-1")).toBe(true);
    s.alive = false;
    syncIngest();
    expect(hasIngest("ag-1")).toBe(false);
    expect(ptr()).toEqual({ h: "claude", off: 0 });
  });
});
