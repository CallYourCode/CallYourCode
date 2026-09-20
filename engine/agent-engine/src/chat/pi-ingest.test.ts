/* The pi output extension CONSUMER, into the same downstream the transcript
 * feeds. A frame becomes a session-log row (logSession) or a working/idle edge
 * (applyJsonlStatus), and a row that the transcript ALSO produces (same durable
 * id) is not duplicated: the extension is a faster live source, never a second
 * copy.
 *
 *   bun test agent-engine/src/chat/pi-ingest.test.ts
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { initChatlog, resetForTest as resetChatlog } from "./chatlog.ts";
import { initIngest, syncIngest, applyPiFrame, hasIngest, resetForTest as resetIngest, type IngestSession } from "./ingest.ts";
import type { OverlayBatch } from "../adapters/mux-adapter.ts";
import type { SessionRec } from "./sessionrec.ts";
import type { PiFrame } from "../adapters/pi-events.ts";

const SID = "9e5e5e5e-2222-4aaa-8bbb-000000000002";

let sessions: Map<string, IngestSession>;
let appended: SessionRec[];
let broadcasts: number;
let liveCb: ((b: OverlayBatch) => void) | null;

function mkPiSession(): IngestSession {
  // a pi pane: no claudeSessionId, keyed by its harness id
  const s: IngestSession = {
    id: "ag-pi", muxHandle: "w1:p9", alive: true, viaMux: true, status: "idle", busy: false,
    harnessSessionId: SID, chat: [], log: [], agent: { id: "pi" },
  } as IngestSession;
  sessions.set(s.id, s);
  return s;
}

beforeEach(() => {
  sessions = new Map();
  appended = [];
  broadcasts = 0;
  liveCb = null;
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
    broadcastSessions: () => { broadcasts++; },
    subscribe: (_h, cb, _from) => { liveCb = cb; return { stop: () => { liveCb = null; }, at: 0 }; },
    readTranscriptSpan: async () => ({ events: [], queueOps: [], consumed: [], delivered: [], offset: 0 }),
    subscribeStatus: () => () => {},
    // no pi server in this wiring: applyPiFrame is called by the test directly,
    // exactly as the live subscribePiEvents callback would
    transcriptFile: () => ({ path: "/fake/pi.jsonl", sessionId: SID }),
    tailOf: () => undefined,
    setTail: () => {},
    log: () => {},
    now: () => 5_000,
  });
});
afterEach(() => { resetIngest(); resetChatlog(); });

describe("a pi extension frame feeds the session log", () => {
  test("a reply frame becomes a reply row keyed by its durable id", () => {
    const s = mkPiSession();
    const added = applyPiFrame("ag-pi", { t: "pi.event", kind: "reply", id: "leaf-1", ts: 100, text: "hi there" });
    expect(added).toBe(true);
    expect(s.log.map((r) => [r.kind, r.text, r.src!.rid])).toEqual([["reply", "hi there", "leaf-1"]]);
    expect(appended.length).toBe(1);
  });

  test("a tool frame becomes a tool row with its chip name", () => {
    const s = mkPiSession();
    applyPiFrame("ag-pi", { t: "pi.event", kind: "tool", id: "call-2", ts: 101, tool: "bash", text: "ls" });
    expect(s.log[0]).toMatchObject({ kind: "tool", text: "ls", tool: { name: "bash" }, src: { rid: "call-2" } });
  });
});

describe("dedup against the transcript", () => {
  test("a row the extension delivered is NOT duplicated when the transcript later carries the same id", () => {
    const s = mkPiSession();
    syncIngest(); // starts the transcript live tail (captures liveCb)
    // the extension is first (faster): it logs the reply keyed by leaf-1
    applyPiFrame("ag-pi", { t: "pi.event", kind: "reply", id: "leaf-1", ts: 200, text: "answer" });
    expect(s.log.length).toBe(1);
    // moments later the SAME row arrives from the transcript tail (same rid)
    liveCb!({
      events: [{ uuid: "leaf-1", ts: 200, kind: "reply", text: "answer", off: 0 }],
      queueOps: [], consumed: [], delivered: [], offset: 512,
    });
    // still one row: logSession is idempotent on h|sid|rid
    expect(s.log.length).toBe(1);
    expect(appended.length).toBe(1);
  });

  test("the reverse order dedupes too (transcript first, then the extension frame)", () => {
    const s = mkPiSession();
    syncIngest();
    liveCb!({
      events: [{ uuid: "leaf-9", ts: 300, kind: "reply", text: "done", off: 0 }],
      queueOps: [], consumed: [], delivered: [], offset: 512,
    });
    const added = applyPiFrame("ag-pi", { t: "pi.event", kind: "reply", id: "leaf-9", ts: 300, text: "done" });
    expect(added).toBe(false); // already logged by the transcript
    expect(s.log.length).toBe(1);
  });
});

/* THE ENGINE-SPAWNED pi STREAM (root cause of the dead binding, TASK B).
 *
 * pi's reader declares NO sessionEvents source, so the adapter's transcript
 * `subscribe` answers null for a pi pane -- exactly as it does in production.
 * startIngest USED to bail on that null (`if (!sub) return`) BEFORE it ever
 * called subscribePiEvents, so an engine-spawned pi bound its socket, streamed
 * frames into the buffer, and never had a consumer attached: engine.log carried
 * zero ingest.pi-event lines ever. This pins the fix at the seam that broke:
 * with a null transcript tail, the pi extension stream must still attach and
 * carry frames. */
describe("a pi pane with no transcript tail still attaches the extension stream", () => {
  test("startIngest subscribes to pi events even when the transcript tail is null", () => {
    let piCb: ((frame: PiFrame) => void) | null = null;
    let subscribeCalls = 0;
    // re-wire ingest to pi's REAL shape: subscribe (the transcript overlay tail)
    // answers null (pi declares no sessionEvents), and the pane HAS a pi-event
    // server whose callback we capture.
    initIngest({
      sessionOf: (id) => sessions.get(id),
      sessions: () => sessions.values(),
      broadcastSessions: () => { broadcasts++; },
      subscribe: () => { subscribeCalls++; return null; }, // pi: no sessionEvents tail
      readTranscriptSpan: async () => ({ events: [], queueOps: [], consumed: [], delivered: [], offset: 0 }),
      subscribeStatus: () => () => {},
      subscribePiEvents: (_h, cb) => { piCb = cb; return () => { piCb = null; }; },
      transcriptFile: () => ({ path: "/fake/pi.jsonl", sessionId: SID }),
      tailOf: () => undefined,
      setTail: () => {},
      log: () => {},
      now: () => 5_000,
    });
    const s = mkPiSession();

    syncIngest(); // the snapshot path that starts an ingest for a live pane

    // BEFORE the fix this is null: startIngest returned at the transcript-tail
    // bail before reaching subscribePiEvents.
    expect(piCb).not.toBeNull();
    expect(hasIngest("ag-pi")).toBe(true);
    expect(subscribeCalls).toBe(1); // the transcript tail was tried once, answered null

    // and a frame delivered through that captured callback becomes a log row
    piCb!({ t: "pi.event", kind: "reply", id: "leaf-e1", ts: 100, text: "live from pi" });
    expect(s.log.map((r) => [r.kind, r.text, r.src!.rid])).toEqual([["reply", "live from pi", "leaf-e1"]]);
    expect(appended.length).toBe(1);
  });
});

describe("a status frame drives working/idle", () => {
  test("a working then idle edge moves the session status, and a repeat is ignored", () => {
    const s = mkPiSession();
    const working: PiFrame = { t: "pi.event", kind: "status", status: "working" };
    expect(applyPiFrame("ag-pi", working)).toBe(false); // a status edge is not a log-row add
    expect(s.status).toBe("working");
    expect(s.busy).toBe(true);
    const b0 = broadcasts;
    applyPiFrame("ag-pi", working); // the same edge again: ignored, no broadcast
    expect(broadcasts).toBe(b0);
    applyPiFrame("ag-pi", { t: "pi.event", kind: "status", status: "idle" });
    expect(s.status).toBe("idle");
    expect(s.busy).toBe(false);
  });

  test("an identity (pi.session) frame is not a log row", () => {
    const s = mkPiSession();
    expect(applyPiFrame("ag-pi", { t: "pi.session", sessionId: "x", cwd: "/w", model: "grok-4.6" })).toBe(false);
    expect(s.log.length).toBe(0);
  });
});
