import {INTENTS, transactionOn} from '@/shared/browser';
import {cyclog} from '@/shared/logging';
import type {CycReplyTo} from '../types';
import type {CycUpload} from './contract';

/* Every user mutation is durable (offline design v2, section 3).
 *
 * An intent is one thing the user did that the engine has not taken yet: a
 * send, a rename, a reorder, a mark-unread, a heard mark, a scroll position, a
 * settings patch. It is written here (memory + the cyc-clips `intents` store)
 * the moment the user acts, applied to the local state at once, and drained to
 * the engine in FIFO order per engine by sync/drain.ts whenever the engine is
 * reachable. Nothing is dropped for being old and nothing is marked failed
 * for a transient reason; only a definitive engine answer (a 4xx that is not
 * 408/429) fails an intent, and then the local apply is reverted.
 *
 * Coalescing: a kind that carries a latest-wins value (rename, reorder,
 * mark-unread, progress) or a mergeable one (heard: max ts; settings: patches
 * merged) names a coalesceKey; a new intent with the same key folds into the
 * queued row, keeping that row's place in the queue. Sends never coalesce. */

export type IntentKind =
  | 'send-text'
  | 'send-voice'
  | 'send-files'
  | 'rename'
  | 'reorder'
  | 'mark-unread'
  | 'heard'
  | 'progress'
  | 'session-settings'
  | 'global-settings';

export type IntentState = 'queued' | 'inflight' | 'failed';

export type Intent = {
  id: string;
  engineKey: string;
  sessionId?: string;
  kind: IntentKind;
  coalesceKey?: string;
  payload: unknown;
  createdAt: number;
  attempts: number;
  // How many times the drain has actually written this send's frame to the
  // wire (only send kinds set it). It counts wire writes, not drain passes:
  // `attempts` bumps on every pass, including transfer-`waiting` and
  // transient/reconnect passes that write no frame, so the ack escalation
  // (10 s -> 20 s -> 30 s) is derived from this count, not from `attempts`.
  // Persisted alongside `attempts` so a reload keeps the escalation position.
  wireWrites?: number;
  state: IntentState;
  lastError?: string;
  // The message row a send intent paints (CycMessage.id: its one durable string
  // row id).
  localId?: string;
};

// What an attachment send remembers about each of its files while their
// transfers are in flight: enough to draw the bubble (name, size, preview
// shape) and to rebuild the wire's uploads (anchors) from the results.
export type AttachMeta = {
  name: string;
  mime: string;
  size: number;
  image: boolean;
  durationS?: number;
  width?: number;
  height?: number;
  fromPage?: {label: string; page: string};
  at: number;
  textLen?: number;
  wireAt: number;
  wireTextLen?: number;
};

// The payload of a send-text, send-voice or send-files intent: the message as
// the user made it and the wire that carries it. Its id is the cid.
export type SendPayload = {
  cid: string;
  sessionId: string;
  ts: number;

  text: string;
  kind: 'text' | 'voice';
  durationS?: number;
  msgId?: string;
  replyTo?: CycReplyTo;
  wordsPending?: boolean;
  upload?: CycUpload;
  uploads?: CycUpload[];

  wire: string;
  wireUploads?: CycUpload[];
  words?: string[];

  // A voice note whose recorded bytes are kept in the clipVault under this key
  // (== cid). Its transfer is the clip upload, not a wire send, so retry and
  // reconnect re-read these bytes and re-upload rather than replaying `wire`.
  clipKey?: string;
  // The transfer row (cyc-clips `transfers`) this intent waits on: the message
  // wire goes out only once that row is done. A voice note's transferKey is
  // its clipKey; an attachment send lists its rows in transferKeys.
  transferKey?: string;
  transferKeys?: string[];
  // Per transfer key, for an attachment intent (dropped once the wire is sent).
  attachMeta?: Record<string, AttachMeta>;

  partials?: {id: string; text: string; upToS: number}[];
};

// The row shows `title.text` when the engine sends a title (it always does:
// the engine resolves the rename override into the title), so a rename applies
// to both the name and the title text; `before` holds both revert targets.
export type RenamePayload = {
  paneId: string;
  name: string;
  before: {name: string; title: string | null};
};
// order: paneIds in their new order; before: each paneId's order field as it
// stood before the first local apply of this row (the revert target).
export type ReorderPayload = {order: string[]; before: Record<string, number | undefined>};
export type UnreadPayload = {
  paneId: string;
  unread: boolean;
  before: {unread: number; marked: boolean};
};
/* A SIGHTING: the durable row identity a device saw. `mid` is the engine's
 * restart- and renumber-invariant row key; `msgId` is the older audio-clip
 * shape the engine still resolves; `ts` is the instant, the fallback identity
 * for a legacy row with no mid and the coalesce key (furthest wins). */
export type HeardPayload = {paneId: string; mid?: string; msgId?: string; ts: number};
export type ProgressPayload = {paneId: string; seq: number; explicit: boolean};
export type SessionSettingsPayload = {paneId: string; patch: Record<string, boolean | null>};
export type GlobalSettingsPayload = {patch: Record<string, unknown>};

// Global settings live on the app server, not on any engine: their intents
// queue under this key and drain whenever any engine edge or retry fires.
export const APP_ENGINE_KEY = 'app';

export const INTENTS_MAX_PER_ENGINE = 500;
// A send older than this the engine never confirmed is NOT re-sent on its own
// and NOT painted as still sending: it surfaces once as a failed bubble the
// user can retry (which renews it). Auto-resending ancient sends is how six
// delivered copies of one 02:00 message landed.
export const INTENT_STALE_MS = 24 * 60 * 60 * 1000;
export const STALE_SEND_REASON =
  'This message waited over a day without the engine confirming it. Tap to send it now.';

const SEND_KINDS: ReadonlySet<IntentKind> = new Set(['send-text', 'send-voice', 'send-files']);
export function isSendKind(kind: IntentKind): boolean {
  return SEND_KINDS.has(kind);
}

// A session id is `<engineKey>|<paneId>`; the engine key is a ws URL and never
// carries a bar, the pane id may.
export function engineKeyOfSessionId(sessionId: string): string {
  const bar = sessionId.indexOf('|');
  return bar < 0 ? sessionId : sessionId.slice(0, bar);
}

// The cyc-clips v6 migration: one legacy outbox row becomes one send intent,
// payload verbatim, queued whatever the row said (a `failed` outbox row was a
// transient failure marked definitive, log-audit A2).
export function intentFromOutbox(row: unknown): Intent | null {
  const r = row as Partial<SendPayload> & {attempts?: unknown};
  if (!r || typeof r.cid !== 'string' || !r.cid || typeof r.sessionId !== 'string') return null;
  const kind: IntentKind = r.clipKey
    ? 'send-voice'
    : r.transferKeys?.length
      ? 'send-files'
      : 'send-text';
  return {
    id: r.cid,
    engineKey: engineKeyOfSessionId(r.sessionId),
    sessionId: r.sessionId,
    kind,
    payload: r,
    createdAt: Number(r.ts) || Date.now(),
    attempts: Number(r.attempts) || 0,
    state: 'queued'
  };
}

const live = new Map<string, Intent>();
const changeSubs = new Set<(engineKey: string) => void>();
const remoteSubs = new Set<(id: string, engineKey: string, row: Intent | undefined) => void>();
let hydrated = false;
let order = 0;
const seqOf = new Map<string, number>();
// The latest write of each row: true once its transaction completed.
const writes = new Map<string, Promise<boolean>>();

export function onChange(cb: (engineKey: string) => void): () => void {
  changeSubs.add(cb);
  return () => {
    changeSubs.delete(cb);
  };
}

// Another tab of this origin wrote (row) or erased (undefined) an intent; the
// copy here has been brought up to date from disk.
export function onRemoteChange(
  cb: (id: string, engineKey: string, row: Intent | undefined) => void
): () => void {
  remoteSubs.add(cb);
  return () => {
    remoteSubs.delete(cb);
  };
}

function changed(engineKey: string): void {
  for (const cb of [...changeSubs]) cb(engineKey);
}

/* The tabs of one origin share the intents store, and one of them (the lease
 * holder, sync/lease.ts) drains it. Each write here is announced to the other
 * tabs once it is on disk, so the holder sees a row a follower queued and a
 * follower sees its row go when the holder has drained it. The announcement
 * names the row only; the receiver reads it from disk. */

export const CHANNEL_NAME = 'cyc-intents';
type Notice = {t: 'row' | 'gone'; id: string; engineKey: string};

let channel: BroadcastChannel | null = null;
if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (ev) => void onNotice(ev.data as Notice);
}

function announce(n: Notice): void {
  channel?.postMessage(n);
}

async function onNotice(n: Notice): Promise<void> {
  if (!n || typeof n.id !== 'string' || typeof n.engineKey !== 'string') return;
  const row =
    n.t === 'row'
      ? await transactionOn<Intent | undefined>(
          INTENTS,
          'readonly',
          (s) => s.get(n.id) as IDBRequest<Intent | undefined>
        )
      : null;
  if (row) absorb(row);
  else if (live.has(n.id)) {
    live.delete(n.id);
    seqOf.delete(n.id);
  }
  if (n.engineKey) changed(n.engineKey);
  for (const cb of [...remoteSubs]) cb(n.id, n.engineKey, row ?? undefined);
}

// Writes that go in the same transaction as a row's first write: what the
// row supersedes on disk (the box's composition it was sent from) goes as the
// row lands, in one commit, so a tab killed at any point holds one or the
// other, never both and never neither.
export type Alongside = {stores: string[]; run: (tx: IDBTransaction) => void};

// The row goes to disk after `after` settles: a send's row is written only
// once the bytes it names are on disk, so a row on disk is always a row that
// can be sent after a reload. A row removed while it waited is not written.
function save(i: Intent, after?: Promise<unknown>, alongside?: Alongside): Promise<boolean> {
  const write = () =>
    transactionOn([INTENTS, ...(alongside?.stores ?? [])], 'readwrite', (s, tx) => {
      alongside?.run(tx);
      return s.put(i);
    }).then((r) => {
      announce({t: 'row', id: i.id, engineKey: i.engineKey});
      return r !== null;
    });
  const p = after
    ? after.then(
        () => (live.get(i.id) === i ? write() : false),
        () => false
      )
    : write();
  writes.set(i.id, p);
  return p;
}

function erase(id: string, engineKey: string): void {
  writes.delete(id);
  void transactionOn(INTENTS, 'readwrite', (s) => s.delete(id)).then(() => {
    announce({t: 'gone', id, engineKey});
  });
}

// Settles once the row's latest write has completed (true) or failed (false).
// The composer clears a sent message only after this: a tab killed before the
// row is on disk would otherwise lose the message with nothing to show for it.
export function committed(id: string): Promise<boolean> {
  return writes.get(id) ?? Promise.resolve(false);
}

// A row read from disk joins the copy held here. A row in flight on disk
// belongs to a drain that is gone (this tab's before a reload, or a dead
// tab's): it is owed again from the start. A row already held keeps its
// localId (the bubble it painted in this tab) and, while this tab's own drain
// has it in flight, its state; it takes the rest from disk.
/* Ids reaped OR settled this page-life. erase() is an async IndexedDB delete,
 * and the drain-lease reload() re-reads the store the moment the lease lands:
 * on fkfm3's first reaping boot (2026-09-06 16:05:09) both fossils were reaped
 * and then re-absorbed from disk in the same millisecond because the delete
 * had not committed yet. The SAME race strands a settled send: settleSend ->
 * remove() -> erase() is async, and a reload() (a lease handover) or another
 * tab's re-announce that reads the store before the delete commits absorbs the
 * row straight back, and paintPendingSends resurrects a 'sending' bubble the
 * engine already took (the stuck 02:00 send). A tombstone keeps a removed id
 * out of `live` for the rest of the page's life; the committed delete makes it
 * permanent. A deliberate re-creation of the same id (a failed send owed again
 * on the retry tap, same cid) clears the tombstone in put(). */
const reapedIds = new Set<string>();

function absorb(r: Intent): void {
  if (!r || typeof r.id !== 'string' || typeof r.engineKey !== 'string' || !r.kind) return;
  if (reapedIds.has(r.id)) return;
  if (r.state === 'inflight') r.state = 'queued';
  const held = live.get(r.id);
  if (held) {
    if (held.localId !== undefined) r.localId = held.localId;
    if (held.state === 'inflight') r.state = 'inflight';
    Object.assign(held, r);
    if (r.lastError === undefined) delete held.lastError;
    return;
  }
  // The bubble the writing tab painted is not one of this tab's.
  delete r.localId;
  live.set(r.id, r);
  seqOf.set(r.id, order++);
}

async function readAll(): Promise<Intent[]> {
  const rows = await transactionOn<Intent[]>(
    INTENTS,
    'readonly',
    (s) => s.getAll() as unknown as IDBRequest<Intent[]>
  );
  return Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === 'string') : [];
}

// This tab took the drain lease: every row on disk is owed by it now.
export async function reload(): Promise<void> {
  for (const r of (await readAll()).sort(byQueueOrder)) absorb(r);
  for (const k of engineKeysWithIntents()) changed(k);
}

function byQueueOrder(a: Intent, b: Intent): number {
  return a.createdAt - b.createdAt || (seqOf.get(a.id) ?? 0) - (seqOf.get(b.id) ?? 0);
}

export function all(): Intent[] {
  return [...live.values()].sort(byQueueOrder);
}

export function get(id: string): Intent | undefined {
  return live.get(id);
}

export function forEngine(engineKey: string): Intent[] {
  return all().filter((i) => i.engineKey === engineKey);
}

// What the drain sees: the queued rows of one engine, oldest first.
export function queuedFor(engineKey: string): Intent[] {
  return forEngine(engineKey).filter((i) => i.state === 'queued');
}

// What the engine is still owed (queued or in flight), for the status word.
export function count(engineKey: string): number {
  let n = 0;
  for (const i of live.values()) if (i.engineKey === engineKey && i.state !== 'failed') n++;
  return n;
}

export function engineKeysWithIntents(): string[] {
  return [...new Set([...live.values()].map((i) => i.engineKey))];
}

export function intentState(localId: string): IntentState | undefined {
  for (const i of live.values()) if (i.localId === localId) return i.state;
  return undefined;
}

export function isStale(i: Intent, now: number = Date.now()): boolean {
  return now - i.createdAt >= INTENT_STALE_MS;
}

type Patched = {patch?: Record<string, unknown>};
type WithBefore = {before?: unknown};

// How a new intent folds into the queued row that shares its coalesceKey.
function merge(kind: IntentKind, old: unknown, next: unknown): unknown {
  switch (kind) {
    case 'heard':
      return (next as HeardPayload).ts > (old as HeardPayload).ts ? next : old;
    case 'progress':
      return next;
    case 'session-settings':
    case 'global-settings':
      return {
        ...(old as object),
        ...(next as object),
        patch: {...(old as Patched).patch, ...(next as Patched).patch}
      };
    default: {
      // Latest value wins; the revert target stays what it was before the
      // first local apply of the chain.
      const before = (old as WithBefore).before;
      return before === undefined ? next : {...(next as object), before};
    }
  }
}

export type NewIntent = Omit<Intent, 'attempts' | 'state' | 'createdAt'> & {createdAt?: number};

// Record an intent. A row with the same coalesceKey that is queued (or failed,
// which a new act supersedes) takes the merged payload and keeps its place;
// a row in flight is left alone and the new act becomes the next row.
export function put(
  n: NewIntent,
  opts: {after?: Promise<unknown>; alongside?: Alongside} = {}
): Intent {
  // A deliberate write of this id clears any settle/reap tombstone: a failed
  // send owed again on the retry tap (same cid) is a real new intent, not the
  // stale disk copy the tombstone guards against.
  reapedIds.delete(n.id);
  let row: Intent | undefined;
  if (n.coalesceKey) {
    for (const i of live.values()) {
      if (
        i.engineKey === n.engineKey &&
        i.coalesceKey === n.coalesceKey &&
        i.state !== 'inflight'
      ) {
        row = i;
        break;
      }
    }
  }
  if (row) {
    row.payload = merge(row.kind, row.payload, n.payload);
    row.state = 'queued';
    delete row.lastError;
    if (n.localId !== undefined) row.localId = n.localId;
  } else {
    row = {...n, createdAt: n.createdAt ?? Date.now(), attempts: 0, wireWrites: 0, state: 'queued'};
    live.set(row.id, row);
    seqOf.set(row.id, order++);
    trim(row.engineKey);
  }
  save(row, opts.after, opts.alongside);
  changed(row.engineKey);
  return row;
}

// The user tapped retry on a send that had aged past INTENT_STALE_MS: they are
// choosing to send it now, so its clock restarts here. Without this the expiry
// guard would refuse the very frame the tap asked for. It also drops any stale
// tombstone so the same cid is owed again.
export function renew(id: string, at: number = Date.now()): Intent | undefined {
  const row = live.get(id);
  if (!row) return undefined;
  reapedIds.delete(id);
  row.createdAt = at;
  seqOf.set(id, order++);
  save(row);
  return row;
}

// Replace a row's payload (a send whose wire was rebuilt from transfer results).
export function update(id: string, payload: unknown): Intent | undefined {
  const row = live.get(id);
  if (!row) return undefined;
  row.payload = payload;
  save(row);
  return row;
}

// The bubble a hydrated send paints is a fresh local row: bind it. The bubble's
// id is its durable row id, derived from the send's own cid, so it is stable
// across a reload; it is kept in memory only, rebound when the intent repaints.
export function setLocalId(id: string, localId: string): void {
  const row = live.get(id);
  if (!row || row.localId === localId) return;
  row.localId = localId;
}

export function setState(id: string, state: IntentState, lastError?: string): Intent | undefined {
  const row = live.get(id);
  if (!row) return undefined;
  row.state = state;
  if (lastError !== undefined) row.lastError = lastError;
  else delete row.lastError;
  save(row);
  changed(row.engineKey);
  return row;
}

// Informational only: how many times the drain has tried this row (every
// pass, waits and transient retries included).
export function noteAttempt(id: string): void {
  const row = live.get(id);
  if (!row) return;
  row.attempts++;
  save(row);
}

// The drain actually wrote this send's frame to the wire. Bumped once per real
// write (not per pass), so the ack escalation counts writes, not waits. Kept
// on disk so a reload resumes at the same 10/20/30 position.
export function noteWireWrite(id: string): void {
  const row = live.get(id);
  if (!row) return;
  row.wireWrites = (row.wireWrites ?? 0) + 1;
  save(row);
}

export function remove(id: string): boolean {
  const row = live.get(id);
  // Tombstone the id before the async erase: a reload or a remote re-announce
  // that reads the store before the delete commits must not resurrect it.
  reapedIds.add(id);
  erase(id, row?.engineKey ?? '');
  if (!row) return false;
  live.delete(id);
  seqOf.delete(id);
  changed(row.engineKey);
  return true;
}

// Per engine, at most INTENTS_MAX_PER_ENGINE rows: the oldest heard and
// progress marks go first, then the oldest of the other non-send kinds. A
// send is never dropped.
function trim(engineKey: string): void {
  const rows = forEngine(engineKey);
  let over = rows.length - INTENTS_MAX_PER_ENGINE;
  if (over <= 0) return;
  const marks = rows.filter((i) => i.kind === 'heard' || i.kind === 'progress');
  const others = rows.filter(
    (i) => !isSendKind(i.kind) && i.kind !== 'heard' && i.kind !== 'progress'
  );
  for (const i of [...marks, ...others]) {
    if (over <= 0) break;
    live.delete(i.id);
    seqOf.delete(i.id);
    erase(i.id, engineKey);
    over--;
    cyclog('intents.trimmed', {
      id: i.id,
      kind: i.kind,
      engine: engineKey,
      why: 'more than INTENTS_MAX_PER_ENGINE rows held for one engine; the oldest mark is dropped'
    });
  }
}

/* A failed send addressed to a session key the engine says does not exist can
 * never be retried into anything, and with no session row under that key it
 * has no bubble, no retry tap, no way for the user to even see it. Two such
 * fossils (old session-uuid keys from before agent-id addressing) rode one
 * laptop for 4 and 8 days (2026-09-06). Old enough that no reconnect is going
 * to resurrect the key, they are reaped at hydrate, loudly. */
export const REAP_AFTER_MS = 48 * 3600_000;
export const definitivelyDead = (i: Intent, now: number): boolean =>
  i.state === 'failed' &&
  typeof i.lastError === 'string' &&
  i.lastError.includes('no such session') &&
  now - i.createdAt > REAP_AFTER_MS;

export async function hydrate(): Promise<Intent[]> {
  if (hydrated) return all();
  const now = Date.now();
  for (const r of (await readAll()).sort(byQueueOrder)) {
    if (definitivelyDead(r, now)) {
      cyclog('intents.reaped', {
        id: r.id,
        kind: r.kind,
        ageMs: now - r.createdAt,
        session: r.sessionId,
        err: r.lastError,
        why:
          'failed against a session key this engine says does not exist, for days: ' +
          'unretryable and unreachable from any UI, so keeping it only wedges the queue'
      });
      reapedIds.add(r.id);
      erase(r.id, r.engineKey);
      continue;
    }
    absorb(r);
  }
  hydrated = true;
  cyclog('intents.hydrated', {
    count: live.size,
    why:
      'every mutation the engine has not taken is restored from disk, queued; ' +
      'the drain sends them on the next settled edge, nothing the user did is lost'
  });
  /* A device carrying the same non-zero count boot after boot is stuck work
   * (fkfm3 carried 2 for hours on 2026-09-06 with nothing naming them). Say
   * WHAT is stuck: kind, state, age and the session, one line per intent,
   * bounded so a pathological backlog cannot flood the log ship. */
  if (live.size > 0) {
    let listed = 0;
    for (const i of live.values()) {
      if (listed++ >= 8) break;
      cyclog('intents.pending', {
        id: i.id,
        kind: i.kind,
        state: i.state,
        attempts: i.attempts,
        ageMs: Date.now() - i.createdAt,
        session: i.sessionId,
        err: i.lastError
      });
    }
  }
  for (const k of engineKeysWithIntents()) changed(k);
  return all();
}

// Test seam.
export function __resetForTest(): void {
  live.clear();
  seqOf.clear();
  writes.clear();
  changeSubs.clear();
  remoteSubs.clear();
  reapedIds.clear();
  hydrated = false;
  order = 0;
}

// Test seam: what another tab's notice does here, without a channel.
export function __noticeForTest(n: {
  t: 'row' | 'gone';
  id: string;
  engineKey: string;
}): Promise<void> {
  return onNotice(n);
}
