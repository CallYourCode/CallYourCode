import {cyclog} from '@/shared/logging';
import {expBackoff} from '@/shared/backoff';
import * as intents from '../intents';
import {
  APP_ENGINE_KEY,
  isSendKind,
  STALE_SEND_REASON,
  type Intent,
  type IntentKind
} from '../intents';
import * as conn from './connection';
import * as lease from './lease';

/* The intent drain (offline design v2, section 3; F1: per-session in flight).
 *
 * One queue per engine, FIFO, one SEND in flight per session. It runs on every settled
 * edge and on every kick (a new intent, a transfer result, a retry tap) while
 * the engine is reachable, and stops at the first intent the engine cannot
 * take right now. It never polls: offline is silence, then one edge.
 *
 * One tab per origin drains: the lease holder (lease.ts). A kick in any other
 * tab is nothing; that tab's rows reach the holder through the shared store
 * (intents.ts announces each write), and a tab that takes the lease re-reads
 * the store and drains what it finds.
 *
 * An executor per kind does the actual write and answers with an outcome:
 *   done       the engine has it (an HTTP answer said ok, or a fire-and-forget
 *              frame was written); the row is removed.
 *   inflight   the frame is written and the engine will answer (a send: ack);
 *              the row stays in flight and the queue waits for settled(id).
 *   waiting    the row cannot go yet for a reason of its own (a send whose
 *              transfer is still moving); it stays queued at the head and the
 *              drain ends here. The queue is FIFO: the rows behind it wait for
 *              the bytes, and the transfer's result kicks the drain again.
 *   transient  the engine was not reachable, timed out, or answered 5xx, 408
 *              or 429; the row stays queued and the drain ends until the next
 *              edge, or a 1 s..30 s jittered retry while the engine stays up.
 *   {failed}   the engine refused definitively (any other 4xx); the row is
 *              marked failed with the reason and the executor has reverted
 *              the local apply. The drain goes on with the next row.
 *
 * ONE SEND IN FLIGHT PER SESSION, NOT PER ENGINE (F1). A send held in flight
 * (awaiting its ack) or waiting on its bytes holds only its own session's later
 * sends; every other intent -- another session's send, a read mark, a rename --
 * drains past it. So a stuck send to a dead session no longer freezes the whole
 * engine's queue, read marks never wait behind a send, and sessions with work
 * pending share the wire round-robin (one send each in flight, the rest behind).
 * A session's own sends still go one at a time, in store order.
 *
 * Global settings queue under APP_ENGINE_KEY (the app server, not an engine)
 * and drain on any engine's edge or kick. */

export type DrainOutcome = 'done' | 'inflight' | 'waiting' | 'transient' | {failed: string};
export type Executor = (intent: Intent) => Promise<DrainOutcome> | DrainOutcome;

export const RETRY_BASE_MS = 1_000;
export const RETRY_CAP_MS = 30_000;

// HTTP status -> transient or definitive.
export function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429 || status === 0;
}

const executors = new Map<IntentKind, Executor>();
const running = new Set<string>();
const rekick = new Set<string>();
// The send each session has in flight, awaiting the engine's ack. Keyed by the
// session id, not the engine (F1): a stuck send to one session must not hold
// the whole engine's queue. The value carries the engine key so a slot can be
// found and freed by the intent id alone, for a row another tab erased.
const inflight = new Map<string, {id: string; engineKey: string}>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retryAttempt = new Map<string, number>();
const waiters = new Map<string, Array<(ok: boolean) => void>>();
const followers = new Map<string, Array<(ok: boolean) => void>>();
let random: () => number = Math.random;

export function registerExecutor(kind: IntentKind, fn: Executor): void {
  executors.set(kind, fn);
}

export function reachable(engineKey: string): boolean {
  if (engineKey === APP_ENGINE_KEY) return conn.engineKeys().some((k) => reachable(k));
  const st = conn.engineState(engineKey);
  return st === 'settled' || st === 'draining' || st === 'live';
}

// A send this engine has in flight (the first, when several sessions do). The
// slot is per session now; this answers per engine for the status word and the
// tests that assert a single-session engine's one in-flight send.
export function inflightOf(engineKey: string): string | undefined {
  for (const slot of inflight.values()) if (slot.engineKey === engineKey) return slot.id;
  return undefined;
}

// A send's slot key is its session; a send always names one. Nothing else takes
// a slot, so nothing else needs a key.
function slotKey(intent: Intent): string {
  return intent.sessionId ?? intent.id;
}

// Resolves once the intent is taken (true) or definitively refused (false).
// In memory only: after a reload the caller is gone and the row drains alone.
export function whenSettled(id: string): Promise<boolean> {
  const row = intents.get(id);
  if (!row) return Promise.resolve(true);
  if (row.state === 'failed') return Promise.resolve(false);
  return new Promise((resolve) => {
    const list = waiters.get(id) ?? [];
    list.push(resolve);
    waiters.set(id, list);
  });
}

// Resolves once the intent is taken (true) or gone untaken (false): a refusal
// is not the end of it. The row stays on the shelf, owed again on the retry
// tap, and this promise follows it through as many retries as it takes. The
// composer's kept box waits on this one: the words leave the box when the
// engine has the message, whichever attempt got it there.
export function whenTaken(id: string): Promise<boolean> {
  if (!intents.get(id)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const list = followers.get(id) ?? [];
    list.push(resolve);
    followers.set(id, list);
  });
}

function resolveWaiters(id: string, ok: boolean) {
  const list = waiters.get(id);
  if (list) {
    waiters.delete(id);
    for (const fn of list) fn(ok);
  }
  // Followers ride out a refusal (the row is still there, still owed) and
  // resolve only when the row is taken or is no longer owed.
  if (ok || !intents.get(id)) {
    const rest = followers.get(id);
    if (rest) {
      followers.delete(id);
      for (const fn of rest) fn(ok);
    }
  }
}

export function retryMs(attempt: number, rnd: number = random()): number {
  return expBackoff({baseMs: RETRY_BASE_MS, capMs: RETRY_CAP_MS, jitter: 'scale'}, attempt, rnd);
}

function clearRetry(engineKey: string) {
  const t = retryTimers.get(engineKey);
  if (t !== undefined) {
    clearTimeout(t);
    retryTimers.delete(engineKey);
  }
}

function scheduleRetry(engineKey: string) {
  clearRetry(engineKey);
  if (!reachable(engineKey)) return;
  const n = retryAttempt.get(engineKey) ?? 0;
  const wait = retryMs(n);
  retryAttempt.set(engineKey, n + 1);
  cyclog('intents.retry', {engine: engineKey, attempt: n, waitMs: wait});
  retryTimers.set(
    engineKey,
    setTimeout(() => {
      retryTimers.delete(engineKey);
      kick(engineKey);
    }, wait)
  );
}

// Run the queue of one engine to its first stop.
export function kick(engineKey: string): void {
  if (!lease.isLeader()) return;
  if (running.has(engineKey)) {
    rekick.add(engineKey);
    return;
  }
  void run(engineKey);
}

// The next intent this engine can take right now: a non-send (a read mark, a
// rename, a reorder, a settings patch) never waits behind a send, so those come
// first and a stuck send holds none of them (F1: read-progress never waits
// behind sends). Then the oldest send of a session with no send in flight and
// none stalled on its bytes this pass -- FIFO within a session, round-robin
// across them.
function nextEligible(engineKey: string, stalled: Set<string>): Intent | undefined {
  const q = intents.queuedFor(engineKey);
  for (const i of q) if (!isSendKind(i.kind)) return i;
  for (const i of q) {
    const key = slotKey(i);
    if (inflight.has(key) || stalled.has(key)) continue;
    return i;
  }
  return undefined;
}

async function run(engineKey: string): Promise<void> {
  running.add(engineKey);
  rekick.delete(engineKey);
  // Sessions whose head send cannot go THIS pass because its bytes are still
  // moving (a 'waiting' send). Pass-local: the transfer's result kicks a fresh
  // run, which tries it again. A send in flight (awaiting an ack) is held in
  // `inflight` and outlives the pass.
  const stalled = new Set<string>();
  try {
    while (lease.isLeader() && reachable(engineKey)) {
      const next = nextEligible(engineKey, stalled);
      if (!next) break;
      const exec = executors.get(next.kind);
      if (!exec) {
        // Every kind registers its executor at module load; a row without one
        // is a build defect, and the queue stops at it rather than spinning.
        cyclog('intents.no-executor', {id: next.id, kind: next.kind});
        break;
      }
      // A send the engine never confirmed for over INTENT_STALE_MS is NOT
      // re-sent: it is failed here (once), surfacing as a bubble the user can
      // retry. The retry tap renews the row (intents.renew) so the next pass
      // does write it. Only sends expire; marks and renames drain whenever they
      // can. This is the guard that stopped six copies of an ancient 02:00
      // send from landing whenever a long-dead engine finally reconnected.
      if (isSendKind(next.kind) && intents.isStale(next)) {
        intents.setState(next.id, 'failed', STALE_SEND_REASON);
        cyclog('intents.expired', {
          id: next.id,
          kind: next.kind,
          ageMs: Date.now() - next.createdAt,
          session: next.sessionId,
          why: 'a send the engine never confirmed for over a day is failed, not re-sent'
        });
        resolveWaiters(next.id, false);
        continue;
      }
      intents.setState(next.id, 'inflight');
      intents.noteAttempt(next.id);
      let outcome: DrainOutcome;
      try {
        outcome = await exec(next);
      } catch (err) {
        cyclog('intents.executor-threw', {id: next.id, kind: next.kind, err});
        outcome = 'transient';
      }
      // The intent was settled by an ack, failed, or requeued by the pipe
      // going down while the executor ran: that path already put the row where
      // it belongs, so this pass leaves it alone.
      const row = intents.get(next.id);
      if (!row || row.state !== 'inflight') continue;
      if (outcome === 'inflight') {
        // The send is written; its ack (settled) or the pipe going down frees
        // this slot. The loop goes on to the other sessions and the reads.
        inflight.set(slotKey(next), {id: next.id, engineKey});
        continue;
      }
      if (outcome === 'done') {
        retryAttempt.delete(engineKey);
        intents.remove(next.id);
        resolveWaiters(next.id, true);
        continue;
      }
      if (outcome === 'waiting') {
        intents.setState(next.id, 'queued');
        // Only this session's later sends wait for the bytes; the rest go on.
        stalled.add(slotKey(next));
        continue;
      }
      if (outcome === 'transient') {
        // The engine is unreachable or answered 5xx/408/429: engine-wide, so
        // the whole drain ends and a jittered retry re-runs it.
        intents.setState(next.id, 'queued');
        scheduleRetry(engineKey);
        break;
      }
      intents.setState(next.id, 'failed', outcome.failed);
      cyclog('intents.failed', {id: next.id, kind: next.kind, why: outcome.failed});
      resolveWaiters(next.id, false);
    }
  } finally {
    running.delete(engineKey);
  }
  // A kick that arrived while we ran is not lost: the queue may have grown.
  if (rekick.has(engineKey)) kick(engineKey);
}

// Free the in-flight slot an intent holds, whichever engine it is on, and
// name that engine. The slot is found by the id, not through the row: a row
// another tab erased (a remote settle, a remote gone) is no longer in the
// store, and its slot must not stay taken until the next edge.
function releaseInflight(id: string): string | undefined {
  for (const [key, slot] of inflight) {
    if (slot.id !== id) continue;
    inflight.delete(key);
    return slot.engineKey;
  }
  return undefined;
}

// The engine took an in-flight intent (a send's ack, or its echo). The slot
// is freed by the id: a row another tab already erased is not in the store,
// and its slot must not stay taken until the next edge.
export function settled(id: string): void {
  const row = intents.get(id);
  intents.remove(id);
  resolveWaiters(id, true);
  const engineKey = releaseInflight(id) ?? row?.engineKey;
  if (engineKey === undefined) return;
  retryAttempt.delete(engineKey);
  kick(engineKey);
}

// The engine, or the transfer under it, refused an intent for good. A failed
// head holds nothing: the rows behind it go now, whether the refusal came
// while the row was in flight or while it waited on its bytes at the head.
export function fail(id: string, why: string): void {
  const engineKey = releaseInflight(id);
  const row = intents.get(id);
  if (!row) {
    if (engineKey !== undefined) kick(engineKey);
    return;
  }
  intents.setState(id, 'failed', why);
  cyclog('intents.failed', {id, kind: row.kind, why});
  resolveWaiters(id, false);
  kick(row.engineKey);
}

// The user tapped retry on a failed row: it is owed again, at the back.
export function requeue(id: string): void {
  const row = intents.get(id);
  if (!row) return;
  intents.setState(id, 'queued');
  kick(row.engineKey);
}

// The ack deadline lapsed on a send in flight (a connected-but-frozen engine,
// or a lost frame): mark it due now and kick, so the ONE writer -- the drain
// executor -- writes the same frame with the same cid on its next pass. It
// writes no frame itself. A cid still in flight releases its slot and goes back
// to 'queued' (unless the row is gone or already failed); a cid that is not in
// flight (already settled, or still queued) is a no-op beyond the kick.
export function redeliver(id: string): void {
  const engineKey = releaseInflight(id);
  const row = intents.get(id);
  if (row && row.state !== 'failed') intents.setState(id, 'queued');
  const key = engineKey ?? row?.engineKey;
  if (key !== undefined) kick(key);
}

// The user discarded the message: the row goes, and a head that was waiting
// on its bytes no longer holds the rows behind it.
export function drop(id: string): void {
  const row = intents.get(id);
  intents.remove(id);
  resolveWaiters(id, false);
  const engineKey = releaseInflight(id) ?? row?.engineKey;
  if (engineKey !== undefined) kick(engineKey);
}

function onEdge(engineKey: string) {
  retryAttempt.delete(engineKey);
  kick(engineKey);
  kick(APP_ENGINE_KEY);
}

function onDown(engineKey: string) {
  clearRetry(engineKey);
  // Every session's in-flight send on this engine is owed again: the pipe that
  // carried it is gone, so no ack can arrive on it.
  for (const [key, slot] of [...inflight]) {
    if (slot.engineKey !== engineKey) continue;
    inflight.delete(key);
    if (intents.get(slot.id)) intents.setState(slot.id, 'queued');
  }
  if (!reachable(APP_ENGINE_KEY)) clearRetry(APP_ENGINE_KEY);
}

function onIntentsChanged(engineKey: string) {
  if (engineKey === APP_ENGINE_KEY) return;
  if (!conn.engineKeys().includes(engineKey)) return;
  conn.noteQueued(engineKey, intents.count(engineKey));
}

// Another tab wrote or erased a row: the holder drains what a follower
// queued; a follower learns the fate of a row it waits on. An erased row
// that was in flight here (the other tab saw its ack, or discarded it) frees
// its slot now: the rows behind it must not wait for the next edge.
function onRemoteRow(id: string, engineKey: string, row: intents.Intent | undefined) {
  if (!row) {
    resolveWaiters(id, true);
    const held = releaseInflight(id);
    if (held !== undefined) kick(held);
    return;
  }
  if (row.state === 'failed') {
    resolveWaiters(id, false);
    return;
  }
  if (row.state === 'queued') kick(engineKey);
}

// This tab took the lease: every row on disk is its to drain now, including
// what a dead holder left in flight.
async function onLease() {
  await intents.reload();
  for (const k of intents.engineKeysWithIntents()) kick(k);
}

let subs: Array<() => void> = [];
function unsubscribe() {
  for (const off of subs) off();
  subs = [];
}
function subscribe() {
  unsubscribe();
  subs = [
    conn.onConnected(onEdge),
    conn.onDisconnected(onDown),
    intents.onChange(onIntentsChanged),
    intents.onRemoteChange(onRemoteRow),
    lease.onLeader(onLease)
  ];
}
subscribe();

export function activeTimers(): number {
  return retryTimers.size;
}

// Test seam: forget every engine's drain state and re-subscribe to the sync
// seam (which tests reset too).
export function __resetForTest(rnd?: () => number): void {
  for (const k of [...retryTimers.keys()]) clearRetry(k);
  running.clear();
  rekick.clear();
  inflight.clear();
  retryAttempt.clear();
  waiters.clear();
  followers.clear();
  random = rnd ?? Math.random;
  unsubscribe();
  lease.__resetForTest();
  subscribe();
}
