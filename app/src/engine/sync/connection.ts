import {cyclog} from '@/shared/logging';
import {expBackoff} from '@/shared/backoff';

// The connection manager: one state machine per engine, and the ONE word the
// UI ever sees about connectivity. The client keeps doing the dialing; when it
// dials, and how long it waits between failed dials, is decided here. Nothing
// in this file touches the document, the window or a toast: visibility and
// radio facts arrive as calls (setHidden, setOnline, poke) from the store.
//
// States, per engine:
//   idle      not dialing (hidden for 30 s, or the radio said offline)
//   dialing   the client is trying to seal a pipe
//   sealed    the pipe is sealed (client status 'connected')
//   settled   the host frame and the first sessions frame both landed
//   draining  intents queued or transfers moving
//   live      nothing owed
//   down      the pipe is gone; a backoff timer decides when the next dial goes

export type EngineSyncState =
  | 'idle'
  | 'dialing'
  | 'sealed'
  | 'settled'
  | 'draining'
  | 'live'
  | 'down';

export type SyncStatus = 'offline' | 'connecting' | 'syncing' | 'live';

export type PokeReason = 'visible' | 'online' | 'intent' | 'open-chat' | 'pull';

export const HIDDEN_STOP_MS = 30_000;
export const CONNECTING_SHOW_MS = 5_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;

// What the manager needs from a client: dial now, naming who asked. False when
// the client will not dial (closed, or held for pairing / identity).
export interface Dialer {
  redialNow(caller: string): boolean;
}

type Engine = {
  key: string;
  state: EngineSyncState;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  dialer: Dialer | null;
  hostSeen: boolean;
  sessionsSeen: boolean;
  queued: number;
};

const engines = new Map<string, Engine>();
const statusSubs = new Set<(s: SyncStatus) => void>();
const connectedSubs = new Set<(engineKey: string) => void>();
const disconnectedSubs = new Set<(engineKey: string) => void>();
const synced = new Map<string, number>();
let settledEdge: ((engineKey: string) => void) | null = null;

let hidden = false;
let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
let online = true;
let transfersActive = false;
let lastPokeAt = 0;
let showTimer: ReturnType<typeof setTimeout> | undefined;
let lastStatus: SyncStatus = 'offline';
let random: () => number = Math.random;

function engine(key: string): Engine {
  let e = engines.get(key);
  if (!e) {
    e = {
      key,
      state: 'idle',
      attempt: 0,
      timer: undefined,
      dialer: null,
      hostSeen: false,
      sessionsSeen: false,
      queued: 0
    };
    engines.set(key, e);
  }
  return e;
}

// Attempt n waits min(30000, 1000 * 2^n) scaled by 0.75..1.25.
export function backoffMs(attempt: number, rnd: number = random()): number {
  return expBackoff(
    {baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS, jitter: 'scale'},
    attempt,
    rnd
  );
}

function clearTimer(e: Engine) {
  if (e.timer !== undefined) {
    clearTimeout(e.timer);
    e.timer = undefined;
  }
}

function setState(e: Engine, next: EngineSyncState) {
  if (e.state === next) return;
  const was = e.state;
  e.state = next;
  cyclog('sync.state', {engine: e.key, was, now: next});
  emitStatus();
}

export function status(): SyncStatus {
  const list = [...engines.values()];
  if (list.length && list.every((e) => e.state === 'live')) return 'live';
  if (list.some((e) => e.state === 'sealed' || e.state === 'settled' || e.state === 'draining'))
    return 'syncing';
  if (
    list.some((e) => e.state === 'dialing' || (e.state === 'down' && e.timer !== undefined)) &&
    Date.now() - lastPokeAt < CONNECTING_SHOW_MS
  )
    return 'connecting';
  return 'offline';
}

function emitStatus() {
  const now = status();
  if (now === lastStatus) return;
  lastStatus = now;
  for (const cb of [...statusSubs]) cb(now);
}

// The connecting word is time-boxed: re-evaluate once the window closes so a
// still-failing dial reads as offline without anyone asking.
function armShowTimer() {
  if (showTimer !== undefined) clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    showTimer = undefined;
    emitStatus();
  }, CONNECTING_SHOW_MS);
}

export function engineState(engineKey: string): EngineSyncState {
  return engines.get(engineKey)?.state ?? 'idle';
}

export function engineKeys(): string[] {
  return [...engines.keys()];
}

export function onStatus(cb: (s: SyncStatus) => void): () => void {
  statusSubs.add(cb);
  return () => {
    statusSubs.delete(cb);
  };
}

export function onConnected(cb: (engineKey: string) => void): () => void {
  connectedSubs.add(cb);
  return () => {
    connectedSubs.delete(cb);
  };
}

export function onDisconnected(cb: (engineKey: string) => void): () => void {
  disconnectedSubs.add(cb);
  return () => {
    disconnectedSubs.delete(cb);
  };
}

// The store's own settled-edge work (re-attach, drain, refresh) runs before any
// onConnected subscriber hears about the edge.
export function setSettledEdge(fn: ((engineKey: string) => void) | null): void {
  settledEdge = fn;
}

// The store registers each engine's client before start().
export function register(engineKey: string, dialer: Dialer): void {
  engine(engineKey).dialer = dialer;
}

function dial(e: Engine, caller: string) {
  clearTimer(e);
  if (e.dialer?.redialNow(caller)) setState(e, 'dialing');
}

function canDial(): boolean {
  return online && !(hidden && hiddenTimer === undefined);
}

// Boot: the connecting window opens. The store dials the clients itself.
export function start(): void {
  lastPokeAt = Date.now();
  armShowTimer();
  emitStatus();
}

// Reset the backoff and dial now, whatever the timer said.
export function poke(reason: PokeReason): void {
  lastPokeAt = Date.now();
  armShowTimer();
  for (const e of engines.values()) {
    e.attempt = 0;
    if (e.state !== 'idle' && e.state !== 'down') continue;
    dial(e, 'poke:' + reason);
  }
  emitStatus();
}

// The client started a dial it decided on itself (connect, paired, trust).
export function noteDialing(engineKey: string): void {
  const e = engine(engineKey);
  if (e.state !== 'idle' && e.state !== 'down') return;
  clearTimer(e);
  setState(e, 'dialing');
}

// The client lost its pipe (a failed dial, a close, a presumed death).
export function noteDown(engineKey: string): void {
  const e = engine(engineKey);
  const wasUp = e.state === 'settled' || e.state === 'draining' || e.state === 'live';
  e.hostSeen = false;
  e.sessionsSeen = false;
  clearTimer(e);
  setState(e, 'down');
  if (wasUp) for (const cb of [...disconnectedSubs]) cb(e.key);
}

// The client wants a redial: arm the next dial per backoff, unless the page is
// parked or the radio is off. Returns the wait it armed (0 when parked).
export function schedule(engineKey: string): number {
  const e = engine(engineKey);
  clearTimer(e);
  if (!canDial()) {
    setState(e, 'idle');
    return 0;
  }
  setState(e, 'down');
  const wait = backoffMs(e.attempt);
  cyclog('sync.backoff', {engine: e.key, attempt: e.attempt, waitMs: wait});
  e.attempt++;
  e.timer = setTimeout(() => {
    e.timer = undefined;
    dial(e, 'backoff');
  }, wait);
  return wait;
}

// The client sealed a pipe (status 'connected').
export function noteSealed(engineKey: string): void {
  const e = engine(engineKey);
  clearTimer(e);
  e.hostSeen = false;
  e.sessionsSeen = false;
  setState(e, 'sealed');
}

function maybeSettle(e: Engine) {
  if (e.state !== 'sealed' || !e.hostSeen || !e.sessionsSeen) return;
  e.attempt = 0;
  setState(e, 'settled');
  settledEdge?.(e.key);
  for (const cb of [...connectedSubs]) cb(e.key);
  reweigh(e);
}

export function noteHost(engineKey: string): void {
  const e = engine(engineKey);
  e.hostSeen = true;
  maybeSettle(e);
}

export function noteSessions(engineKey: string): void {
  const e = engine(engineKey);
  e.sessionsSeen = true;
  maybeSettle(e);
}

// settled/draining/live follow what is owed: queued intents or moving transfers.
function reweigh(e: Engine) {
  if (e.state !== 'settled' && e.state !== 'draining' && e.state !== 'live') return;
  setState(e, e.queued > 0 || transfersActive ? 'draining' : 'live');
}

export function noteQueued(engineKey: string, queued: number): void {
  const e = engine(engineKey);
  e.queued = queued;
  reweigh(e);
}

export function noteTransfers(active: boolean): void {
  transfersActive = active;
  for (const e of engines.values()) reweigh(e);
}

// Visibility, as a fact from the store. Hidden for 30 s stops the dialing;
// visible again is the caller's poke.
export function setHidden(on: boolean): void {
  hidden = on;
  if (hiddenTimer !== undefined) {
    clearTimeout(hiddenTimer);
    hiddenTimer = undefined;
  }
  if (!on) return;
  hiddenTimer = setTimeout(() => {
    hiddenTimer = undefined;
    park('hidden');
  }, HIDDEN_STOP_MS);
}

// navigator.onLine, as a fact from the store. Advisory: false parks the dial,
// true is the caller's poke, and a poke always dials.
export function setOnline(on: boolean): void {
  online = on;
  if (!on) park('offline');
}

function park(why: string) {
  for (const e of engines.values()) {
    if (e.state !== 'dialing' && e.state !== 'down') continue;
    clearTimer(e);
    cyclog('sync.parked', {engine: e.key, why});
    setState(e, 'idle');
  }
}

export function noteSynced(sessionId: string, at: number): void {
  synced.set(sessionId, at);
}

export function syncedAt(sessionId: string): number | undefined {
  return synced.get(sessionId);
}

export function activeTimers(): number {
  let n = hiddenTimer !== undefined ? 1 : 0;
  if (showTimer !== undefined) n++;
  for (const e of engines.values()) if (e.timer !== undefined) n++;
  return n;
}

// Test seams: drop the engine states only (subscribers made at module load,
// like the transfer worker's, stay), or everything.
export function __resetLiveForTest(rnd?: () => number): void {
  for (const e of engines.values()) clearTimer(e);
  engines.clear();
  synced.clear();
  if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
  hiddenTimer = undefined;
  if (showTimer !== undefined) clearTimeout(showTimer);
  showTimer = undefined;
  hidden = false;
  online = true;
  transfersActive = false;
  lastPokeAt = 0;
  lastStatus = 'offline';
  random = rnd ?? Math.random;
}

export function __resetForTest(rnd?: () => number): void {
  __resetLiveForTest(rnd);
  statusSubs.clear();
  connectedSubs.clear();
  disconnectedSubs.clear();
  settledEdge = null;
}
