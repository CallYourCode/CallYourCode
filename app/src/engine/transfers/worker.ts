import * as rows from './rows';
import type {TransferRow} from './rows';
import * as clipVault from '../../audio/clipVault';
import {cyclog} from '@/shared/logging';
import {expBackoff} from '@/shared/backoff';
import {EngineOffline} from '../contract';
import {putImage} from '../../features/media/imageCache';
import * as drain from '../sync/drain';
import * as sync from '../sync';
import {connOf, notifyNow, sessions} from '../store/registry';
import type {CycEngineMessage} from '../store/types';

// The resumable-transfer worker (Lane A). A single event-driven loop, at most
// two transfers active at once, one chunk in flight per transfer. It runs only
// when the owning engine is live; offline it sleeps and sets no timers, and
// it wakes on the connected edge (sync.onConnected -> pump()). Every step
// persists progress, so a reload resumes from `acked`, never from byte zero.
//
// A chunk request is at most one tunnel CHUNK, so a flap loses at most the chunk
// in flight; a GET after any reconnect resyncs `have` before the next PUT.
// Both connectivity edges drive the worker: the disconnected edge cuts the
// step in flight at once (no waiting out the step deadline on a dead pipe),
// and the connected edge clears any pending backoff so a queued row retries
// the moment the engine is back, resuming from the chunks the engine holds.

// The engine's chunk size. The engine is the source of truth (begin returns it),
// but the app slices at the same size so the first PUT is already aligned.
export const CHUNK = 262144;

// The ONE per-step deadline: every transfer request (begin, a chunk PUT, the
// GET resync, finish) gets this long in total, wall clock, from the moment it
// is issued. Defined here and nowhere else; the client takes the signal and
// sets no timeout of its own.
export const STEP_DEADLINE_MS = 30_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const MAX_ACTIVE = 2;

// The pipelined-PUT flow control. The pipe's own bufferedAmount drain is the
// real gate (the worker awaits client.tunnelDrain between sends); this cap is
// the safety net so an engine that accepts bytes but stalls on the replies can
// never accumulate unbounded pending responses. At the cap the worker awaits
// one outstanding PUT to settle before firing the next.
export const MAX_OUTSTANDING = 32;

// Transfer-route statuses that mean "retry cannot help": a malformed begin
// (400), over the size cap (413), a hash mismatch at finish (422). A 404 is
// NOT here: the engine lost the chunk dir (sweeper, restart on a fresh data
// dir), and the right move is to begin again from zero.
const GONE_STATUSES = new Set([400, 413, 422]);

// The engine's size caps per kind (routes/transfer.ts CAP: /user-audio 300 MB,
// /upload 50 MB), for the failed bubble's reason when a 413 names no `max`.
const KIND_CAP: Record<TransferRow['kind'], number> = {
  'user-audio': 300 * 1024 * 1024,
  upload: 50 * 1024 * 1024
};

function fmtBytes(n: number): string {
  const trim = (v: number) => String(Math.round(v * 10) / 10);
  if (n >= 1024 * 1024 * 1024) return `${trim(n / (1024 * 1024 * 1024))} GB`;
  if (n >= 1024 * 1024) return `${trim(n / (1024 * 1024))} MB`;
  if (n >= 1024) return `${trim(n / 1024)} KB`;
  return `${n} B`;
}

function stepDeadlineMs(): number {
  const t = Number(
    (window as unknown as {__cycTransferDeadlineMs?: number}).__cycTransferDeadlineMs
  );
  return t > 0 ? t : STEP_DEADLINE_MS;
}

function backoffBaseMs(): number {
  const t = Number((window as unknown as {__cycTransferBackoffMs?: number}).__cycTransferBackoffMs);
  return t > 0 ? t : BACKOFF_MIN_MS;
}

function backoffFor(attempts: number): number {
  // full jitter of one base step, exponent clamped at 0 (expOffset -1).
  return expBackoff(
    {baseMs: backoffBaseMs(), capMs: BACKOFF_MAX_MS, expOffset: -1, jitter: 'plusBase'},
    attempts,
    Math.random()
  );
}

// The transfer half of the engine client the worker leans on. Kept minimal so a
// unit test can plant a fake conn with just these methods.
export type TransferOpts = {signal?: AbortSignal};
export type TransferClient = {
  transferBegin(
    body: {
      kind: TransferRow['kind'];
      sessionId: string;
      size: number;
      mime: string;
      name?: string;
      sha256: string;
      cid?: string;
      durationS?: number;
    },
    opts?: TransferOpts
  ): Promise<{id: string; chunk: number; have: number[]}>;
  transferPut(id: string, n: number, bytes: Blob, opts?: TransferOpts): Promise<{have: number[]}>;
  // Backpressure for the pipelined PUT loop: resolves when the tunnel's send
  // buffer has drained under its low-water mark. Optional so a test/mock client
  // without it leaves the send unthrottled (a no-op await).
  tunnelDrain?(): Promise<void>;
  transferGet(
    id: string,
    opts?: TransferOpts
  ): Promise<{have: number[]; size: number; chunk: number; done: boolean}>;
  // `fronted` is the engine's x-cyc-fronted: 1 on the reply: this status is
  // the fronted route's own verdict (/upload, /user-audio), not the transfer
  // route's or the tunnel's.
  transferFinish(
    id: string,
    opts?: TransferOpts
  ): Promise<{ok: boolean; status: number; body: unknown; fronted?: boolean}>;
  // Best-effort DELETE of a transfer the app walked away from (cancel). Never
  // throws, never retried; the engine's sweeper covers a DELETE that never lands.
  transferDelete?(id: string): Promise<void>;
  // The engine URL a finished upload paints from (the image cache key).
  uploadUrl(uploadId: string): string;
};

type ResultHandler = (row: TransferRow) => void;
const resultHandlers = new Set<ResultHandler>();

// Registered by each send path (voice notes, attachments): when a transfer
// finishes, the waiting send intent picks up row.result and sends its
// message. Returns the unsubscribe.
export function onResult(fn: ResultHandler): () => void {
  resultHandlers.add(fn);
  return () => {
    resultHandlers.delete(fn);
  };
}

const active = new Set<string>();
const backoffTimers = new Map<string, ReturnType<typeof setTimeout>>();

// The steps now in flight for a row. begin, GET and finish keep at most one in
// the air, but the pipelined PUT phase keeps up to MAX_OUTSTANDING, so this is
// a SET of controllers per row, not one. The disconnected edge and cancel abort
// every controller in the set at once: a request already on a dead pipe can
// never answer, and without the cut it would hold its deadline out; a cancel
// must cut ALL outstanding segment PUTs, not just one.
const inflight = new Map<string, Set<AbortController>>();

function addInflight(key: string, ctl: AbortController): void {
  let set = inflight.get(key);
  if (!set) inflight.set(key, (set = new Set()));
  set.add(ctl);
}

function removeInflight(key: string, ctl: AbortController): void {
  const set = inflight.get(key);
  if (!set) return;
  set.delete(ctl);
  if (set.size === 0) inflight.delete(key);
}

// Cut every step in flight for a row, with an optional reason (an edge-driven
// abort carries EngineOffline so the catch parks the row for the reconnect).
function abortInflight(key: string, reason?: unknown): void {
  const set = inflight.get(key);
  if (!set) return;
  for (const ctl of [...set]) ctl.abort(reason);
}

// The connected edge (connected AND hello settled) is the worker's only wake
// from outside; it sets no timer of its own while offline. The edge outruns
// any backoff timer: a queued row of the engine that just settled retries NOW
// (its begin or GET resyncs `have` from the engine, and only the missing
// chunks move) instead of sleeping out a backoff armed while the pipe was
// dead, and its attempts reset so the next transient failure backs off small.
sync.onConnected((engineKey) => {
  for (const row of rows.all()) {
    if (row.state !== 'queued') continue;
    if (sessions.get(row.sessionId)?.engineKey !== engineKey) continue;
    clearBackoff(row.key);
    if (row.attempts) {
      row.attempts = 0;
      rows.put(row);
    }
  }
  pump();
});

// The disconnected edge: cut this engine's in-flight steps at once. The catch
// in runTransfer routes the EngineOffline to state 'queued' with id and acked
// kept, so the next connected edge resumes from the chunks the engine holds.
sync.onDisconnected((engineKey) => {
  for (const key of [...inflight.keys()]) {
    const row = rows.get(key);
    if (!row || sessions.get(row.sessionId)?.engineKey !== engineKey) continue;
    abortInflight(key, new EngineOffline(engineKey));
  }
});

// Keys whose enqueue is still parking the bytes and writing the row: `enqueue`
// returns at once, the row exists only after that work. A drain step that runs
// in between (the send's own kick, or a settled edge) finds no row and no bytes
// and must not read that as a lost recording.
const enqueuing = new Map<string, Promise<boolean>>();
export function isEnqueuing(key: string): boolean {
  return enqueuing.has(key);
}

// Settles once the key's bytes are parked and its row written (true), or the
// write failed (false). A key that is not enqueuing settles false: its row is
// either long on disk or never was.
export function enqueued(key: string): Promise<boolean> {
  return enqueuing.get(key) ?? Promise.resolve(rows.get(key) !== undefined);
}

function clearBackoff(key: string): void {
  const t = backoffTimers.get(key);
  if (t !== undefined) {
    clearTimeout(t);
    backoffTimers.delete(key);
  }
}

function clientFor(sessionId: string): TransferClient | null {
  const s = sessions.get(sessionId);
  const owner = s && connOf(s.engineKey);
  if (!s || !owner || !sync.isLive(owner)) return null;
  return owner.client as unknown as TransferClient;
}

// The send intent a row belongs to: its own key for a voice note, or the
// owning message's cid for an attachment (several rows share one message).
export function ownerOf(row: TransferRow): string {
  return row.ownerCid ?? row.key;
}

function messageFor(row: TransferRow): CycEngineMessage | undefined {
  const cid = ownerOf(row);
  return sessions.get(row.sessionId)?.messages.find((m) => (m as CycEngineMessage).cid === cid) as
    CycEngineMessage | undefined;
}

// Progress for the owning message: acked over total across every row of that
// message, so a two-image send shows one honest percentage.
function paintProgress(row: TransferRow): void {
  const m = messageFor(row);
  if (!m) return;
  const cid = ownerOf(row);
  let acked = 0;
  let total = 0;
  for (const r of rows.all()) {
    if (ownerOf(r) !== cid || r.sessionId !== row.sessionId) continue;
    const n = chunkCount(r.size);
    total += n;
    acked += r.state === 'done' ? n : Math.min(n, r.acked.length);
  }
  m.sendPct = total > 0 ? acked / total : 0;
  notifyNow();
}

function chunkCount(size: number): number {
  return size <= 0 ? 0 : Math.ceil(size / CHUNK);
}

// The union of the current acked and an engine-reported have, ascending. acked
// only ever GROWS from engine truth: a pipelined pass resolves segment PUTs out
// of order, and each response's have is authoritative cumulative state, so a
// merge (never a replace) keeps every confirmed segment.
function unionSorted(acked: number[], have: number[]): number[] {
  const s = new Set(acked);
  for (const n of have) s.add(n);
  return [...s].sort((a, b) => a - b);
}

function statusOf(err: unknown): number | undefined {
  const s = (err as {status?: number})?.status;
  return typeof s === 'number' ? s : undefined;
}

// The cap a 413 names in its body ({error, max}), when the client passed it on.
function maxOf(err: unknown): number | undefined {
  const m = (err as {max?: number})?.max;
  return typeof m === 'number' && m > 0 ? m : undefined;
}

// The row was cancelled (discarded) under a step in flight: it is no longer in
// the store, or the store holds a newer row under the same key. Every await in
// the worker is followed by this check, so a cancelled row is never written
// back (a put would resurrect it) and no further chunk or finish goes out.
function dropped(row: TransferRow): boolean {
  return rows.get(row.key) !== row;
}

function isGone(status: number | undefined): boolean {
  return status !== undefined && GONE_STATUSES.has(status);
}

function isNotFound(status: number | undefined): boolean {
  return status === 404;
}

function is4xx(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500;
}

// Forget the engine-side id so the next attempt begins again from zero. Used
// when the engine answers 404 for an id it once knew (its chunk dir is gone).
function forgetId(row: TransferRow): void {
  delete row.id;
  row.acked = [];
  rows.put(row);
}

// Store bytes first, then the row, then wake the loop. Returns the key at once;
// never throws for a size under the engine's cap (the begin does the capping).
//
// Idempotent per key while the key is live: a second enqueue under a key whose
// row is queued, active or done (or still being parked) changes nothing, so two
// paths racing to move the same recording (the settlement's early queue and a
// commit that queues defensively) end in ONE transfer, one engine copy, one
// msgId. Only a 'gone' row is re-enqueued: that is the retry of a refused send.
export function enqueue(
  blob: Blob,
  meta: {
    key: string;
    sessionId: string;
    kind: TransferRow['kind'];
    mime?: string;
    name?: string;
    durationS?: number;
    replyTo?: import('../../types').CycReplyTo;
    ts?: number;
    // The message this row belongs to when it is not the row's own key (an
    // attachment of a multi-file message).
    ownerCid?: string;
  }
): string {
  const key = meta.key;
  const existing = rows.get(key);
  if (enqueuing.has(key) || (existing && existing.state !== 'gone')) {
    cyclog('transfer.enqueue.dedup', {
      key,
      session: meta.sessionId,
      state: existing?.state ?? 'enqueuing',
      why: 'this key is already parked or moving; the one live transfer stands'
    });
    pump();
    return key;
  }
  const mime = meta.mime || blob.type || 'application/octet-stream';
  const written = parkAndWrite()
    .catch((err) => {
      cyclog('transfer.enqueue-failed', {key, session: meta.sessionId, err: String(err)});
      return false;
    })
    .finally(() => {
      enqueuing.delete(key);
    });
  enqueuing.set(key, written);
  return key;

  async function parkAndWrite(): Promise<boolean> {
    await clipVault.park({
      key,
      cid: meta.ownerCid ?? key,
      sessionId: meta.sessionId,
      blob,
      mime,
      durationS: meta.durationS,
      replyTo: meta.replyTo,
      ts: meta.ts ?? Date.now(),
      // Parked by the transfer: the composer's recovery sweep (which puts
      // unclaimed recordings back in the box after a reload) leaves it alone,
      // whatever the kind; the transfer row resumes it instead.
      transfer: true,
      // And an attachment's bytes belong to a message row, never a recording.
      ...(meta.kind === 'upload' ? {attachment: true} : {})
    });
    const sha256 = await sha256hex(blob);
    const now = Date.now();
    const ok = await rows.put({
      key,
      sessionId: meta.sessionId,
      kind: meta.kind,
      blobKey: key,
      size: blob.size,
      mime,
      name: meta.name,
      durationS: meta.durationS,
      ownerCid: meta.ownerCid,
      sha256,
      chunk: CHUNK,
      acked: [],
      state: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now
    });
    cyclog('transfer.enqueued', {
      key,
      session: meta.sessionId,
      kind: meta.kind,
      bytes: blob.size,
      chunks: chunkCount(blob.size),
      why: 'bytes parked and a durable transfer row written; the worker drives it when live'
    });
    pump();
    return ok;
  }
}

// Blob -> ArrayBuffer, cross-environment: real browsers have Blob.arrayBuffer;
// a jsdom Blob (the vitest environment) does not, so fall back to FileReader.
function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as ArrayBuffer);
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(blob);
  });
}

async function sha256hex(blob: Blob): Promise<string> {
  const buf = await blobBytes(blob);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The connected edge, and the enqueue edge: look for transfers to move.
export function wake(): void {
  pump();
}

function pump(): void {
  for (const row of rows.all()) {
    if (active.size >= MAX_ACTIVE) break;
    if (row.state !== 'queued') continue;
    if (active.has(row.key)) continue;
    if (backoffTimers.has(row.key)) continue; // waiting out a transient failure
    if (!clientFor(row.sessionId)) continue; // its engine is not connected: sleep
    active.add(row.key);
    void runTransfer(row.key).finally(() => {
      active.delete(row.key);
      pump();
    });
  }
}

async function runTransfer(key: string): Promise<void> {
  const row = rows.get(key);
  if (!row || row.state === 'done' || row.state === 'gone') return;
  const client = clientFor(row.sessionId);
  if (!client) return; // went offline between pump() and here; wait for wake

  row.state = 'active';
  rows.put(row);

  const blob = await clipVault.get(row.blobKey);
  if (dropped(row)) return; // cancelled while reading the vault
  if (!blob) {
    // The bytes are gone from the vault (evicted, or a park that never
    // landed): there is nothing left to send. Definitive.
    finishGone(row, 'the parked bytes are gone from the vault, so there is nothing to transfer');
    return;
  }
  const bytes = blob.blob;

  // Each request gets the one step deadline; a 404 from the engine for an id it
  // once knew forgets the id and begins again from zero, once, right away.
  let reBegun = false;
  try {
    for (;;) {
      try {
        await moveBytes(row, client, bytes);
        return;
      } catch (err) {
        if (dropped(row)) return; // cancelled under the step that threw
        const status = statusOf(err);
        if (!isNotFound(status) || !row.id || reBegun) throw err;
        reBegun = true;
        cyclog('transfer.rebegin', {
          key,
          session: row.sessionId,
          acked: row.acked.length,
          why: 'the engine answered 404 for a transfer it once knew (chunk dir gone); beginning again from zero'
        });
        forgetId(row);
      }
    }
  } catch (err) {
    if (dropped(row)) return; // cancelled: nothing to write back, nothing to retry
    const status = statusOf(err);
    if (isGone(status) || (err as StepError)?.fronted) {
      // A 413 names the cap it was over: the bubble shows that reason, from
      // the engine's own `max` when it sent one, else the known cap for the kind.
      const refused =
        status === 413
          ? `too large (over ${fmtBytes(maxOf(err) ?? KIND_CAP[row.kind])})`
          : undefined;
      finishGone(row, `the engine refused with ${status}; retry cannot help`, refused);
      return;
    }
    if (isNotFound(status)) {
      // A 404 at begin itself, or a second 404 right after the re-begin: never
      // gone. Forget the id and back off; the next attempt begins from zero.
      forgetId(row);
      scheduleRetry(row, 'the engine answered 404; the next attempt begins from zero');
      return;
    }
    if (err instanceof EngineOffline || !clientFor(row.sessionId)) {
      // The transport dropped: no timer, no polling. Stay queued and wait for
      // the connected edge to wake the worker.
      row.state = 'queued';
      rows.put(row);
      cyclog('transfer.dropped', {
        key,
        session: row.sessionId,
        acked: row.acked.length,
        why: 'the link dropped mid-transfer; the transfer waits for reconnect and resumes from acked'
      });
      return;
    }
    // Connected but the step failed (a deadline, a 5xx): back off with jitter.
    scheduleRetry(row, String((err as Error)?.message ?? err));
  }
}

// A finish refusal, thrown so the one catch above routes it. `fronted` marks
// the fronted route's own 4xx (returned verbatim through finish): definitive.
type StepError = Error & {status: number; fronted?: boolean};
function stepErr(message: string, status: number, fronted = false): StepError {
  return Object.assign(new Error(message), {status, fronted});
}

// The finished upload's image bytes, keyed exactly as the remote path keys
// them (`client.uploadUrl(uploadId)`, what renderHub resolves the echoed
// message's upload to). Only images (the cache is the image cache); a finish
// without an uploadId (a voice note's msgId) has no URL to key by.
function cacheOwnImage(row: TransferRow, client: TransferClient, bytes: Blob): void {
  if (row.kind !== 'upload' || !/^image\//i.test(row.mime)) return;
  const uploadId = (row.result as {uploadId?: unknown} | undefined)?.uploadId;
  if (typeof uploadId !== 'string' || !uploadId) return;
  const blob = bytes.type === row.mime ? bytes : new Blob([bytes], {type: row.mime});
  putImage(client.uploadUrl(uploadId), blob);
}

// One pass over the bytes: begin or resync, PUT the missing chunks, finish.
// Throws with a `status` on any HTTP refusal; the caller decides what it means.
async function moveBytes(row: TransferRow, client: TransferClient, bytes: Blob): Promise<void> {
  // begin (idempotent) learns the id and the engine's current `have`, so a
  // reconnect resyncs progress before the next PUT.
  if (!row.id) {
    const b = await withDeadline(row.key, (signal) =>
      client.transferBegin(
        {
          kind: row.kind,
          sessionId: row.sessionId,
          size: row.size,
          mime: row.mime,
          name: row.name,
          sha256: row.sha256,
          cid: ownerOf(row),
          durationS: row.durationS
        },
        {signal}
      )
    );
    if (dropped(row)) return;
    row.id = b.id;
    row.chunk = b.chunk;
    row.acked = [...b.have].sort((a, c) => a - c);
    rows.put(row);
  } else {
    const g = await withDeadline(row.key, (signal) => client.transferGet(row.id!, {signal}));
    if (dropped(row)) return;
    row.acked = [...g.have].sort((a, c) => a - c);
    rows.put(row);
  }

  const count = chunkCount(row.size);
  paintProgress(row);

  // The PIPELINED PUT phase. The worker fires the missing segments back to
  // back, gated ONLY by the pipe's bufferedAmount drain between sends (the
  // whole flow control), and consumes each response asynchronously as a
  // cumulative durability ack. The ordered reliable DataChannel owns delivery;
  // the engine answers as it writes each segment to its own file, so the
  // responses are order-independent and a `have` is authoritative cumulative
  // state. MAX_OUTSTANDING caps the pending responses so an engine that takes
  // bytes but stalls on the replies cannot accumulate unbounded state.
  const missing: number[] = [];
  const have = new Set(row.acked);
  for (let n = 0; n < count; n++) if (!have.has(n)) missing.push(n);

  const outstanding = new Set<Promise<void>>();
  // The first rejection seen from any segment PUT, thrown after the whole pass
  // drains so the other outstanding segments still land. runTransfer's catch
  // then decides what the status means (gone, re-begin, park, or backoff), and
  // the failed index is simply still-missing on the next pass.
  let firstError: unknown;

  for (const n of missing) {
    if (dropped(row)) return; // cancelled: no more PUTs, no finish
    if (!clientFor(row.sessionId)) break; // lost the link: drain what is out, then park below
    // At the safety cap, wait for one outstanding response before firing more,
    // so the pending set never exceeds MAX_OUTSTANDING.
    while (outstanding.size >= MAX_OUTSTANDING) await Promise.race(outstanding);
    if (dropped(row) || !clientFor(row.sessionId)) break;

    const slice = bytes.slice(n * row.chunk, Math.min((n + 1) * row.chunk, row.size));
    const step = deadlineStep(row.key, (signal) => client.transferPut(row.id!, n, slice, {signal}));
    const p: Promise<void> = step.promise
      .then((put) => {
        if (dropped(row)) return;
        // UNION, never replace: an out-of-order resolve (a smaller cumulative
        // have arriving after a larger one) must never regress acked.
        row.acked = unionSorted(row.acked, put.have);
        row.attempts = 0; // a segment landed: the link is working, reset backoff
        rows.put(row);
        paintProgress(row);
      })
      .catch((err) => {
        if (firstError === undefined) firstError = err;
      })
      .finally(() => {
        outstanding.delete(p);
      });
    outstanding.add(p);

    // The one gate AND the response-await anchor. Wait for the sealed tunnel to
    // drain under its low-water mark: dispatch is serialized by the drain (not
    // by MAX_OUTSTANDING), and only once this segment's frames are handed to
    // the channel post-drain do we arm its 30s deadline, so a segment queued
    // behind backpressure cannot mass-timeout on a shared t0 clock.
    await client.tunnelDrain?.();
    step.arm();
  }

  // Await every outstanding response before deciding: a segment still in the
  // air could yet land (or fail) and its ack belongs in acked either way.
  while (outstanding.size > 0) await Promise.race(outstanding);

  if (dropped(row)) return; // cancelled while the pass drained
  if (firstError !== undefined) throw firstError; // routes through runTransfer's catch
  if (!clientFor(row.sessionId)) {
    // Lost the link mid-pass and nothing threw (every outstanding settled
    // cleanly before the drop): stay queued and wait for the connected edge.
    row.state = 'queued';
    rows.put(row);
    return;
  }

  // Every chunk is on the engine: assemble, verify, hand to the fronted route.
  const fin = await withDeadline(row.key, (signal) => client.transferFinish(row.id!, {signal}));
  if (dropped(row)) return; // cancelled under finish: its result has no taker
  if (fin.ok) {
    row.state = 'done';
    row.result = fin.body as TransferRow['result'];
    rows.put(row);
    paintProgress(row);
    cyclog('transfer.done', {key: row.key, session: row.sessionId, kind: row.kind, size: row.size});
    // An own image goes into the image cache under the engine URL the bubble
    // resolves to after the echo (client.uploadUrl), from the bytes still in
    // hand: after a reload it paints from here, no fetch, no black box. Before
    // the vault release, so the bytes are never gone without a cache copy.
    cacheOwnImage(row, client, bytes);
    // The bytes are on the engine now; release the local copy, then let the
    // waiting intent send its message from the result.
    void clipVault.release(
      row.blobKey,
      'the engine finished the transfer and holds the bytes',
      {session: row.sessionId},
      {byTransfer: true}
    );
    for (const fn of [...resultHandlers]) fn(row);
    return;
  }
  if (fin.status === 409) {
    // Incomplete on the engine's side (a chunk we thought acked is missing):
    // resync `have` and PUT again, never gone.
    throw stepErr('transfer finish: engine reports incomplete', 409);
  }
  if (isNotFound(fin.status)) {
    // The engine lost the chunk dir: the caller forgets the id and begins again.
    throw stepErr(`transfer finish failed: HTTP ${fin.status}`, fin.status);
  }
  if (fin.status === 422 || (fin.fronted && is4xx(fin.status))) {
    // Gone: the transfer's own hash mismatch (422), or the fronted route's own
    // 4xx handed back verbatim (x-cyc-fronted: 1; its cap, a bad file). Retry
    // cannot help. Any other 4xx (401/403/429 from the tunnel or the transfer
    // route itself) is transient and retried below, never gone.
    throw stepErr(`transfer finish failed: HTTP ${fin.status}`, fin.status, true);
  }
  throw stepErr(`transfer finish failed: HTTP ${fin.status}`, fin.status);
}

function scheduleRetry(row: TransferRow, why: string): void {
  row.state = 'queued';
  row.attempts += 1;
  rows.put(row);
  const wait = backoffFor(row.attempts);
  cyclog('transfer.retry', {
    key: row.key,
    session: row.sessionId,
    attempts: row.attempts,
    waitMs: wait,
    why
  });
  clearBackoff(row.key);
  backoffTimers.set(
    row.key,
    setTimeout(() => {
      backoffTimers.delete(row.key);
      pump();
    }, wait)
  );
}

// `refused` is the reason in the bubble's words (a 413's cap), kept on the row
// so a reload paints the same reason (the send-voice executor reads it).
function finishGone(row: TransferRow, why: string, refused?: string): void {
  row.state = 'gone';
  if (refused) row.refused = refused;
  rows.put(row);
  const owner = ownerOf(row);
  const m = messageFor(row);
  if (m) {
    m.status = 'failed';
    // A voice note's copy is released with the row: retry cannot bring it back.
    if (row.kind === 'user-audio') m.clipLost = true;
    if (refused) m.failReason = refused;
    delete m.sendPct;
    notifyNow();
  }
  cyclog('transfer.gone', {key: row.key, owner, session: row.sessionId, why});
  // Every terminal outcome kicks the owner's drain: done through the result
  // handlers above, gone here through fail, so the sends queued behind this
  // one go on at once instead of waiting for an unrelated edge.
  drain.fail(owner, refused ?? why);
  void clipVault.release(row.blobKey, why, {session: row.sessionId}, {byTransfer: true});
  // The message is definitively failed: its queued siblings have nothing left
  // to move for (a sibling already in flight finishes on its own, harmlessly).
  if (row.ownerCid) {
    for (const r of rows.all()) {
      if (r.ownerCid !== row.ownerCid || r.key === row.key || r.state !== 'queued') continue;
      clearBackoff(r.key);
      r.state = 'gone';
      rows.put(r);
      void clipVault.release(
        r.blobKey,
        'a sibling attachment of the same message was refused',
        {session: r.sessionId},
        {byTransfer: true}
      );
    }
  }
}

// The one deadline, per step. Aborts the request's signal AND rejects at the
// deadline, so a stalled pipe can neither hold the slot nor leak a hanging
// fetch. The controller joins the row's in-flight SET while the step is in
// flight (a pipelined PUT phase has several at once), so the disconnected edge
// and a cancel can cut every step the moment the pipe is known dead instead of
// letting it wait out the whole deadline.
//
// The deadline is anchored at RESPONSE-AWAIT, not at dispatch. `deadlineStep`
// starts the request and joins the row's in-flight set at once (so an abort can
// cut it the instant it is fired), but the 30s timer is armed only when `arm()`
// is called. A serial step (begin, GET, finish) arms it immediately via
// `withDeadline`; a pipelined PUT arms it once its frames have been handed to
// the channel post-drain, so a segment queued behind backpressure keys its
// deadline on its own send and 56 segments never inherit one shared t0 start.
function deadlineStep<T>(
  key: string,
  run: (signal: AbortSignal) => Promise<T>
): {promise: Promise<T>; arm: () => void} {
  const ctl = new AbortController();
  addInflight(key, ctl);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  let rejectCut!: (e: unknown) => void;
  const cut = new Promise<never>((_, reject) => {
    rejectCut = reject;
  });
  ctl.signal.addEventListener(
    'abort',
    () => {
      // An edge-driven abort carries EngineOffline as its reason; rethrow it
      // so the catch in runTransfer parks the row for the connected edge
      // even when the aborted request itself never settles.
      const reason = (ctl.signal as {reason?: unknown}).reason;
      rejectCut(reason instanceof Error ? reason : new Error('transfer step aborted'));
    },
    {once: true}
  );
  const arm = () => {
    if (done || timer !== undefined) return;
    timer = setTimeout(() => {
      // Reject first, then abort: the deadline's own words win the race over
      // the abort listener's generic ones.
      rejectCut(new Error('transfer step stalled: no answer within the deadline'));
      ctl.abort();
    }, stepDeadlineMs());
  };
  const promise = Promise.race([run(ctl.signal), cut]).finally(() => {
    done = true;
    if (timer !== undefined) clearTimeout(timer);
    removeInflight(key, ctl);
  });
  return {promise, arm};
}

function withDeadline<T>(key: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const step = deadlineStep(key, run);
  step.arm();
  return step.promise;
}

// The two prune points. A row that is done or gone has nothing left to move,
// and stays only until its message settles: the engine echoed the send (the
// intent is removed by settleSend) or the message was discarded. Then
// the row goes, so the loop never scans dead rows and the store never grows.
export function prune(cid: string): number {
  let removed = 0;
  for (const r of rows.all()) {
    if (ownerOf(r) !== cid) continue;
    if (r.state !== 'done' && r.state !== 'gone') continue;
    clearBackoff(r.key);
    rows.remove(r.key);
    removed++;
  }
  if (removed) {
    cyclog('transfer.pruned', {
      cid,
      rows: removed,
      why: 'the owning message settled (echoed or discarded); its finished transfer rows are removed'
    });
  }
  return removed;
}

// The discard point. The message is gone, so every transfer row it owned goes
// with it, whatever its state: a queued row simply goes; an active row goes
// too, and the worker abandons its step on the next `dropped` check (no more
// chunks, no finish, nothing written back). The bytes a live row held in the
// vault are released (the worker's own release, the one the vault accepts),
// and a transfer the engine had begun is DELETEd best-effort, once, only while
// its engine is live; a DELETE that never lands is the engine sweeper's to
// clean. Done and gone rows released their bytes already and go like prune.
export function cancel(cid: string): number {
  let removed = 0;
  for (const r of rows.all()) {
    if (ownerOf(r) !== cid) continue;
    const live = r.state === 'queued' || r.state === 'active';
    clearBackoff(r.key);
    rows.remove(r.key);
    removed++;
    if (!live) continue;
    // Cut every step in flight NOW: a discarded message's segment PUTs have no
    // taker, and without the abort they would ride out their whole deadlines.
    // The dropped() check after every await keeps the abandoned steps from
    // writing anything back.
    abortInflight(r.key);
    void clipVault.release(
      r.blobKey,
      'the owning message was discarded before the transfer finished',
      {session: r.sessionId},
      {byTransfer: true}
    );
    if (r.id) {
      const client = clientFor(r.sessionId);
      if (client?.transferDelete) void Promise.resolve(client.transferDelete(r.id)).catch(() => {});
    }
  }
  if (removed) {
    cyclog('transfer.cancelled', {
      cid,
      rows: removed,
      why: 'the owning message was discarded; its transfer rows are removed, queued and active ones too, and their bytes released'
    });
  }
  return removed;
}

// Vault recovery takes back a parked recording whose send was never committed
// (the tab died in the pre-commit window, so no intent on disk names this
// transfer and no message will ever resume it): the row is removed so the
// worker does not move bytes the composer owns again, the bytes STAY in the
// vault (they are the recording being restored), and a transfer the engine
// had begun is DELETEd best-effort (its sweeper covers one that never lands).
// True when the key is free for the composer (no row, or the live row was
// removed); false for a done or gone row, whose bytes the worker has already
// settled and released: those are not the composer's to take back.
export function reclaim(key: string): boolean {
  const r = rows.get(key);
  if (!r) return true;
  if (r.state === 'done' || r.state === 'gone') return false;
  clearBackoff(r.key);
  rows.remove(r.key);
  // Cut every step in flight, exactly as cancel does: the row is gone, so an
  // answer has no row to write back to; aborting frees the slot now.
  abortInflight(r.key);
  cyclog('transfer.reclaimed', {
    key,
    session: r.sessionId,
    acked: r.acked.length,
    why:
      'no committed send names this transfer (killed pre-commit); the composer takes ' +
      'the recording back, the row goes, the bytes stay parked'
  });
  if (r.id) {
    const client = clientFor(r.sessionId);
    if (client?.transferDelete) void Promise.resolve(client.transferDelete(r.id)).catch(() => {});
  }
  return true;
}

// Boot: restore rows and wire the clipVault sweeper to spare in-flight bytes.
// Memoized as the one hydration promise, so every caller that awaits it (the
// store's boot, the vault recovery sweep) gets actual completion, not a flag
// set before the disk read finished.
let hydration: Promise<TransferRow[]> | null = null;
export function hydrateTransfers(): Promise<TransferRow[]> {
  hydration ??= rows.hydrate().then((restored) => {
    pump();
    return restored;
  });
  return hydration;
}

// Test seam: reset module state between cases.
export function __resetForTest(): void {
  for (const t of backoffTimers.values()) clearTimeout(t);
  backoffTimers.clear();
  for (const set of inflight.values()) for (const ctl of set) ctl.abort();
  inflight.clear();
  active.clear();
  resultHandlers.clear();
  hydration = null;
}

// The transfer rows a session's in-flight sends reference, re-exported so the
// clipVault sweeper (holding) never evicts bytes a live transfer still needs.
export {heldKeys} from './rows';
export {get as rowOf, all as allRows} from './rows';
