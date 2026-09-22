/* THE TRANSCRIPT INGEST (L3 feature; design A.4, A.5) and the
 * thinking-indicator status tail.
 *
 * One ingest per alive, mux-owned session with a transcript: the adapter
 * watches the harness jsonl and hands each drain back as a batch; every event
 * in it becomes a `t:"s"` session record in the agent's OWN chat log
 * (chatlog.ts logSession, idempotent on the record's src key), and the tail
 * pointer (agentmeta.ts `tails[sid]`) moves to the byte just past the last
 * complete line, so a restart resumes where it stopped instead of re-reading
 * the file or skipping to its end. The app is not consulted: the ingest runs
 * whether or not anyone is attached, because the log is the engine's record
 * of what the harness did, and an attach paints it from the log's pages.
 *
 * A transcript this engine has never read gets an INITIAL BACKFILL: the live
 * tail starts at EOF at once (new events stream immediately) and a job reads
 * [0, EOF) forward in 1 MB spans, one job at a time engine-wide, yielding to
 * the loop between spans, progress saved in the pointer's `bf` so a restart
 * resumes the job. Backfilled records get high seqs and old ts: seq is
 * storage order, ts is display order (sessionrec.ts).
 *
 * The status tail is deliberately separate: the indicator needs every turn
 * edge, open or not, and wants none of the record machinery. Both share the
 * adapter's watcher pool. PRECEDENCE: the mux stays the only source of
 * `blocked`; a jsonl edge owns working<->idle only, in BOTH directions: once
 * the transcript has closed a turn, the mux's `working` is not a turn until
 * the transcript opens one (reconcile.ts reads jsonlStatus for this).
 */

import type { SessionEvent } from "../sessions/session-events.ts";
import type { OverlayBatch, TailSub } from "../adapters/mux-adapter.ts";
import { piFrameToEvent, piFrameStatus, type PiFrame } from "../adapters/pi-events.ts";
import type { TailPointer } from "../runtime/agentmeta.ts";
import { awaitingQueue, awaitingByText, clearAwaiting, clearQueued, logSession,
  type ChatSession } from "./chatlog.ts";
import { turnSinceFor } from "./turn.ts";
import { noteReply } from "./reply-trace.ts";
import { reduceStatus, deriveBusy } from "../sessions/status-reducer.ts";
import type { AgentStatus } from "../terminal/mux.ts";
import type { ChatMsg } from "./chatmsg.ts";
import type { SessionRec, SessionRecKind } from "./sessionrec.ts";

export type IngestSession = ChatSession & {
  id: string;
  muxHandle: string;
  alive: boolean;
  viaMux: boolean;
  status: string;
  busy: boolean;
  jsonlStatus?: "working" | "idle";
  turnSince?: number;
  harnessSessionId: string | null;
  chat: ChatMsg[];
  log: SessionRec[];
  agent: { id: string };
};

export type IngestDeps = {
  sessionOf(id: string): IngestSession | undefined;
  sessions(): Iterable<IngestSession>;
  broadcastSessions(): void;
  /** the adapter's transcript tail from a pointer (null: never read, start at EOF) */
  subscribe(muxHandle: string, cb: (batch: OverlayBatch) => void, from: number | null): TailSub | null;
  /** the adapter's backfill read of [from, to); `handle` names the pane so the
   *  span parses with that harness's own event extraction (claude when absent) */
  readTranscriptSpan(path: string, from: number, to: number, handle?: string): Promise<OverlayBatch>;
  subscribeStatus(muxHandle: string, cb: (edge: "working" | "idle") => void): (() => void) | null;
  /** the adapter's pi output-extension frame stream for this pane, or null for
   *  a pane with no such server (non-pi, hand-started, old pi). Optional so a
   *  minimal test wiring can omit it and get the transcript-only behaviour. */
  subscribePiEvents?(muxHandle: string, cb: (frame: PiFrame) => void): (() => void) | null;
  transcriptFile(muxHandle: string): { path: string; sessionId?: string | null } | null;
  /** the agent's saved pointer for one harness session id, and its writer
   *  (the writer schedules the debounced meta save) */
  tailOf(agentId: string, sid: string): TailPointer | undefined;
  setTail(agentId: string, sid: string, ptr: TailPointer | undefined): void;
  log(event: string, fields: Record<string, unknown>): void;
  /** the clock a turn stamp reads; injectable so a seam test pins the instants */
  now?: () => number;
};

/** One span of a backfill read, and how the job yields between spans. */
export const BACKFILL_SPAN = 1 << 20;

type Ingest = { sid: string; path: string | null; handle: string; sub: TailSub | null; piUnsub?: (() => void) | null };
const ingests = new Map<string, Ingest>(); // session id -> live tail
type StatusTail = { csid: string; unsub: () => void };
const statusTails = new Map<string, StatusTail>(); // session id -> watch

let deps: IngestDeps | null = null;
export function initIngest(d: IngestDeps): void {
  deps = d;
}
const D = (): IngestDeps => {
  if (!deps) throw new Error("ingest not initialised");
  return deps;
};

export function hasIngest(id: string): boolean {
  return ingests.has(id);
}

// A queue-operation record names the exact text we typed into the pane, so
// it maps straight back to the bubble. Enqueue is implied (we mark queued on
// delivery); consumption is what the user is waiting to see.
function applyQueueOp(op: "enqueue" | "consumed", content: string, paneId: string) {
  if (op !== "consumed") return;
  markInContext(content, paneId);
}

/* The delivered text turned up as a user record (or the queue released it):
 * the message is in claude's context, so drop the "waiting" mark.
 *
 * The record carries only the typed text, not the delivery id, so the exact
 * awaitingByText reverse index is what resolves the text back to the id armed at
 * send time. That index REPLACED a substring scan of the pane's chat (kept only
 * because there was no reverse index before): the exact lookup is what the index
 * exists to make possible, and a scan that matched on `content.includes(m.text)`
 * could clear the wrong bubble when one queued message's text was a prefix of
 * another's. `paneId` is no longer consulted. */
export function markInContext(content: string, _paneId?: string) {
  const cid = awaitingByText.get(content);
  if (cid === undefined) return;
  const hit = awaitingQueue.get(cid);
  clearAwaiting(cid);
  if (hit) clearQueued(hit.sessionId, hit.ts);
}

/** A transcript event as the record the log keeps of it. */
function recOf(s: IngestSession, sid: string, ev: SessionEvent) {
  const kind: SessionRecKind = ev.kind;
  return {
    ts: ev.ts,
    kind,
    text: ev.text,
    ...(ev.tool ? { tool: { name: ev.tool } } : {}),
    // where an input reached the agent from, for the overlay's source chip
    ...(ev.source ? { source: ev.source } : {}),
    ...(ev.sender ? { sender: ev.sender } : {}),
    src: { h: s.agent.id, sid, rid: ev.uuid, off: ev.off ?? 0 },
  };
}

/** Append one batch's records to the session's log; returns how many were
 *  new (the rest were already logged: a replay past the pointer). */
function appendBatch(s: IngestSession, sid: string, batch: OverlayBatch, live: boolean): number {
  let added = 0;
  for (const ev of batch.events) {
    if (!logSession(s, recOf(s, sid, ev))) continue;
    added++;
    /* An ingested reply row REACHED the user (it renders in the app chat), so
     * it counts for the Stop hook's "something has to have reached them" --
     * only live rows: a backfilled old reply answered an old message. Without
     * this, a session that answers in its terminal is blocked by the hook for
     * an answer the user already has (live 2026-09-22). */
    if (live && ev.kind === "reply") noteReply(s.agent.id);
  }
  /* A.5: the app's own message landing in the transcript is the `delivered`
   * fact, logged with the user record's identity as its key. Backfill skips
   * it: an old landing is not news, and the bubble it would clear is gone. */
  if (live) {
    for (const d of batch.delivered) {
      if (!d.uuid) continue;
      if (logSession(s, { ts: d.ts, kind: "delivered", text: d.text,
        src: { h: s.agent.id, sid, rid: `delivered:${d.uuid}`, off: d.off } })) added++;
    }
  }
  return added;
}

/* THE PI EXTENSION FRAME -> the SAME downstream the transcript feeds.
 *
 * A pi pane cyc launched also streams live events over a unix socket (the pi
 * output extension, adapters/pi-events.ts). Each frame lands here and becomes
 * exactly what a transcript record would: a session-log row (logSession) or a
 * working/idle edge (applyJsonlStatus). Both are ADDITIVE and DEDUPED:
 *  - a prompt/reply/tool frame carries the durable id pi also writes to the
 *    transcript record, so its `src.rid` matches the transcript row's and
 *    logSession keeps one (idempotent on h|sid|rid);
 *  - a status frame goes to applyJsonlStatus, which ignores a repeat edge.
 * A `pi.session` identity frame is not a log row and is a no-op here: its
 * identity is consumed earlier and independently by PiEventServer.onSession,
 * the tap the adapter attaches at spawn (adapters/pi-events.ts onSession +
 * mux-adapter.ts spawn), which records the pane bind. It must NOT be consumed
 * here: this ingest handler only attaches once a sid already exists (sidOf
 * below returns before subscribing), the chicken-and-egg the onSession tap
 * breaks by running before any sid is known.
 *
 * Returns true when a new row was logged (a status edge or an identity frame
 * returns false), for a test to assert on. */
export function applyPiFrame(id: string, frame: PiFrame): boolean {
  const d = D();
  const s = d.sessionOf(id);
  if (!s || !s.alive) return false;
  const sid = sidOf(s);
  if (!sid) return false;
  const status = piFrameStatus(frame);
  if (status) {
    applyJsonlStatus(id, status);
    return false;
  }
  const ev = piFrameToEvent(frame);
  if (!ev) return false;
  const rec = logSession(s, recOf(s, sid, ev));
  if (rec) d.log("ingest.pi-event", { session: id, sid, kind: ev.kind, rid: ev.uuid });
  return !!rec;
}

// Reconcile ingests with the live session set: one per alive, mux-owned
// session with a transcript. Called on attach, client close and every mux
// snapshot (the snapshot call doubles as the retry path for files that were
// missing when the session appeared). A rotated session (new sid) drops its
// old tail and starts one against the new file with that file's pointer.
export function syncIngest() {
  const d = D();
  for (const [id, w] of [...ingests]) {
    const s = d.sessionOf(id);
    const sid = s ? sidOf(s) : null;
    if (!s || !s.alive || !s.viaMux || sid !== w.sid) stopIngest(id, s ? "rotated/dead" : "gone");
  }
  for (const s of d.sessions()) {
    if (s.alive && s.viaMux && !ingests.has(s.id)) startIngest(s.id);
  }
  pumpBackfill();
}

/** The harness session id the transcript is keyed by: the claude uuid for
 *  claude (the only harness the tail reads today), else the harness id. Every
 *  harness carries it on the one harnessSessionId now. */
function sidOf(s: IngestSession): string | null {
  return s.harnessSessionId;
}

export function startIngest(id: string) {
  const d = D();
  const s = d.sessionOf(id);
  if (!s) return;
  const sid = sidOf(s);
  if (!sid) return;
  /* The path may be a jsonl (claude/codex) OR opencode's `db#sessionId`: the
   * adapter's subscribe dispatches on the reader's declared sessionEvents slot
   * and answers null for anything it cannot tail, so the append-only check
   * that used to live here is the adapter's decision now. */
  const located = d.transcriptFile(s.muxHandle);
  const path = located?.path ?? null;
  const saved = d.tailOf(s.id, sid);
  /* THE TRANSCRIPT OVERLAY TAIL (claude/codex/opencode). Null for a harness
   * whose reader declares no sessionEvents source -- pi is exactly that, so its
   * subscribe always answers null -- or before the transcript file exists.
   * Either way the pi extension stream below is an INDEPENDENT live source and
   * must still attach, so this is no longer a hard bail. */
  const sub = path
    ? d.subscribe(s.muxHandle, (batch) => {
        // a user record landing IS the message entering context
        for (const text of batch.consumed) markInContext(text, id);
        for (const q of batch.queueOps) applyQueueOp(q.op, q.content, id);
        const owner = d.sessionOf(id);
        if (!owner) return;
        const added = appendBatch(owner, sid, batch, true);
        const cur = d.tailOf(owner.id, sid) ?? { h: owner.agent.id, off: 0 };
        const last = batch.events[batch.events.length - 1];
        d.setTail(owner.id, sid, { ...cur, off: batch.offset,
          ...(last ? { rid: last.uuid, ts: last.ts } : {}) });
        if (added) d.log("ingest.append", { session: id, sid, added, off: batch.offset });
      }, saved ? saved.off : null)
    : null;
  /* PI OUTPUT EXTENSION (additive), attached INDEPENDENTLY of the transcript
   * tail. Its frames feed the SAME log + status as the transcript, deduped by
   * the frame's durable id (applyPiFrame). Gating it behind `sub` (or the
   * transcript path) is exactly why an engine-spawned pi never delivered a live
   * frame: pi's reader declares no sessionEvents, so `sub` is always null and
   * startIngest returned before ever subscribing. It attaches whenever the pane
   * has a pi-event server; a pane with no server (non-pi, hand-started, old pi)
   * yields null and stays transcript-only, unchanged. */
  const piUnsub = d.subscribePiEvents?.(s.muxHandle, (frame) => applyPiFrame(id, frame)) ?? null;
  if (!sub && !piUnsub) return; // neither live source: retried on the next snapshot
  ingests.set(id, { sid, path, handle: s.muxHandle, sub, piUnsub });
  /* Tail bookkeeping (pointer + backfill) is the TRANSCRIPT tail's alone; a
   * pi-only ingest carries no transcript offset, so it is skipped. */
  if (sub) {
    if (!saved) {
      /* NEVER READ BEFORE: the tail starts at EOF (sub.at) and the backfill
       * owes [0, at). A transcript that is empty so far owes nothing. */
      const ptr: TailPointer = { h: s.agent.id, off: sub.at, ...(sub.at > 0 ? { bf: { at: 0, to: sub.at } } : {}) };
      d.setTail(s.id, sid, ptr);
      d.log("ingest.start", { session: id, sid, off: sub.at, backfill: sub.at });
    } else {
      d.log("ingest.resume", { session: id, sid, off: saved.off, ...(saved.bf ? { backfill: saved.bf } : {}) });
    }
  }
  pumpBackfill();
}

export function stopIngest(id: string, why: string) {
  const w = ingests.get(id);
  if (!w) return;
  ingests.delete(id);
  w.sub?.stop();
  if (w.piUnsub) { try { w.piUnsub(); } catch { /* ignore */ } }
  console.log(`[ingest] - ${id} (${why})`);
}

/* ------------------------------------------------------------ the backfill */

/* ONE JOB AT A TIME, LOWEST PRIORITY. The queue is whatever live ingest still
 * carries a `bf` pointer; the pump picks the first, reads one span, saves the
 * progress, yields, and looks again. Nothing on the attach path waits on it:
 * the pages ship whatever the log holds, and the app's ts sort places what
 * the job appends later. */
let backfilling: string | null = null;

function pumpBackfill(): void {
  if (backfilling) return;
  const d = D();
  for (const [id, w] of ingests) {
    const s = d.sessionOf(id);
    if (!s) continue;
    if (!w.path) continue; // a pi-only ingest has no transcript file to backfill
    const ptr = d.tailOf(s.id, w.sid);
    if (!ptr?.bf) continue;
    backfilling = id;
    void runBackfill(id, w, ptr.bf.at, ptr.bf.to)
      .catch((e) => d.log("ingest.backfill.error", { session: id, sid: w.sid, error: String(e) }))
      .finally(() => { backfilling = null; pumpBackfill(); });
    return;
  }
}

async function runBackfill(id: string, w: Ingest, from: number, to: number): Promise<void> {
  const d = D();
  const path = w.path;
  if (!path) return; // a pi-only ingest has no transcript file (pumpBackfill skips it)
  const t0 = performance.now();
  let at = from;
  let added = 0;
  let spans = 0;
  d.log("ingest.backfill.start", { session: id, sid: w.sid, from, to });
  while (at < to) {
    if (ingests.get(id) !== w) { d.log("ingest.backfill.stop", { session: id, sid: w.sid, at, to }); return; }
    const s = d.sessionOf(id);
    if (!s) return;
    let end = Math.min(to, at + BACKFILL_SPAN);
    let batch = await d.readTranscriptSpan(path, at, end, w.handle);
    // a line longer than a span: widen until it fits (or the job's end)
    while (batch.offset === at && end < to) {
      end = Math.min(to, end + BACKFILL_SPAN);
      batch = await d.readTranscriptSpan(path, at, end, w.handle);
    }
    added += appendBatch(s, w.sid, batch, false);
    spans++;
    at = batch.offset > at ? batch.offset : to; // a torn last line ends the job
    const cur = d.tailOf(s.id, w.sid);
    if (cur) d.setTail(s.id, w.sid, { ...cur, ...(at < to ? { bf: { at, to } } : { bf: undefined }) });
    await new Promise<void>((r) => setTimeout(r, 0)); // the loop first, always
  }
  const cur = d.tailOf(id, w.sid);
  if (cur?.bf) { const { bf: _bf, ...rest } = cur; d.setTail(id, w.sid, rest); }
  d.log("ingest.backfill.done", { session: id, sid: w.sid, from, to, added, spans,
    ms: Math.round(performance.now() - t0) });
}

/** TEST/OPS: whether any backfill is running right now, and for whom. */
export function backfillInProgress(): string | null {
  return backfilling;
}

/* ---------------------------------------------------------- status tail */

/* Apply a derived turn edge to a session's status, exactly as a snapshot edge
 * would, and push it. `blocked` is left strictly alone.
 *
 * The verdict is RECORDED on the session either way (jsonlStatus), because
 * the snapshot rebuild reads it: a jsonl idle has to outlive the next herdr
 * poll, or herdr's own `working` (a spinner, a background shell, "waiting for
 * background agents": its claude detector reports all of these) stamps the
 * row back to working with a fresh turn stamp, silently, and the next real
 * prompt then finds the row already working and keeps that stamp. That was
 * "thinking · 7m" seconds into a turn (2026-09-02, turn-age.test.ts). An idle
 * edge while the row already shows herdr's idle/done keeps that richer value
 * and pushes nothing; it only closes the door on herdr's working. */
export function applyJsonlStatus(id: string, edge: "working" | "idle") {
  const d = D();
  const s = d.sessionOf(id);
  if (!s || !s.alive || s.status === "blocked") return;
  /* The status decision is the ONE rule table (status-reducer.ts), fed here as
   * a transcript observation: dedupe on the carry, ALWAYS record the verdict
   * (the outlive-the-poll seam the snapshot rebuild reads back), and an idle
   * edge while the row is not working keeps the mux's richer idle/done and
   * pushes nothing. Only a real move (changed) runs the side effects below. */
  // IngestSession.status is the loose local `string`; it only ever holds an
  // AgentStatus value, so the reducer reads it as one.
  const r = reduceStatus({ status: s.status as AgentStatus, jsonlStatus: s.jsonlStatus }, { source: "transcript", edge });
  s.jsonlStatus = r.jsonlStatus; // record the verdict either way
  if (!r.changed) return;
  const from = s.status;
  s.status = r.status;
  s.busy = deriveBusy(r.status, s.alive);
  s.turnSince = turnSinceFor({ status: from, turnSince: s.turnSince }, edge, undefined, d.now);
  d.log("status.edge", { session: id, pane: s.muxHandle, from, to: edge, source: "jsonl" });
  // the edge is a fact of the session: a status record (design A.1), the
  // same line the snapshot path writes for a mux-seen change
  if (from !== edge) logSession(s, { ts: (d.now ?? Date.now)(), kind: "status", text: `status: ${edge}`, status: edge });
  d.broadcastSessions();
}

export function startStatusTail(id: string) {
  const d = D();
  const s = d.sessionOf(id);
  if (!s) return;
  const located = d.transcriptFile(s.muxHandle);
  const csid = located?.sessionId ?? (s.agent.id === "claude" ? s.harnessSessionId : null);
  const path = located?.path ?? null;
  if (!path || !csid || path.includes("#")) return; // no append-only file; retried on the next snapshot
  const unsub = d.subscribeStatus(s.muxHandle, (edge) => applyJsonlStatus(id, edge));
  if (!unsub) return;
  statusTails.set(id, { csid, unsub });
}

export function stopStatusTail(id: string, why: string) {
  const w = statusTails.get(id);
  if (!w) return;
  statusTails.delete(id);
  w.unsub();
  void why;
}

// Keep the status tails in step with the live session set: one per alive,
// mux-owned session with a resolvable transcript. A rotated session drops its
// old watch and re-resolves against the new file.
export function syncStatusTails() {
  const d = D();
  for (const [id, w] of [...statusTails]) {
    const s = d.sessionOf(id);
    const located = s ? d.transcriptFile(s.muxHandle) : null;
    if (!s || !s.alive || !s.viaMux || (located?.sessionId ?? (s.agent.id === "claude" ? s.harnessSessionId : null)) !== w.csid) {
      stopStatusTail(id, s ? "rotated/dead" : "gone");
    }
  }
  for (const s of d.sessions()) {
    if (s.alive && s.viaMux && d.transcriptFile(s.muxHandle) && !statusTails.has(s.id)) startStatusTail(s.id);
  }
}

/** TEST ONLY: close every ingest and status watch and forget the deps, so a
 *  second in-process wiring does not inherit fs watchers pointed at the
 *  previous one's transcripts. Each stop is the adapter's own, so the pooled
 *  watcher underneath is released too. No-op in production, which never
 *  re-wires. */
export function resetForTest(): void {
  for (const [id] of [...ingests]) stopIngest(id, "test reset");
  for (const [id] of [...statusTails]) stopStatusTail(id, "test reset");
  ingests.clear();
  statusTails.clear();
  backfilling = null;
  deps = null;
}
