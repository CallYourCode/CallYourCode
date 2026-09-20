import {cyclog} from '@/shared/logging';
import type {CycEngineMessage, CycEngineSession} from './store/types';
import type {EngineChatMessage, EngineSessionEvent, EngineTab} from './contract';
import type {CycSessionEvent} from '../types';

const DB_NAME = 'cyc-history';

// History pages are bounded so the cache cannot grow without limit. A page holds
// up to `pageSize` (100) messages, so MAX_PAGE_RECORDS pages is a generous roof,
// more than anyone scrolls back through, and TTL sweeps chats untouched for a
// month. `|meta` records are NEVER evicted: they re-attach the thread at a cold,
// offline open. The roster and the scroll anchors live in stores of their own
// and are never swept. The session records ride on the pages, not a store of
// their own.
export const PAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_PAGE_RECORDS = 400;

// A page record's key ends in `|p<n>`; anything else in `pages` is protected.
const isPageKey = (key: string): boolean => /\|p\d+$/.test(key);

// v4: four stores. `pages` (pages + meta, keyed `<sid>|p<n>` / `<sid>|meta`),
// `roster` (one row per engine), `events` (one row per session), `anchors`
// (one row per session). Every row written before v4 is stale: v3 re-keyed
// the rows from harness session ids to engine agent ids, and the roster rows
// used to live inside `pages` with nine fields. The upgrade clears `pages`
// once; the engine re-serves every page and roster on the next attach.
const DB_VERSION = 4;
const PAGES = 'pages';
const ROSTER = 'roster';
const ANCHORS = 'anchors';
type StoreName = typeof PAGES | typeof ROSTER | typeof ANCHORS;

// The one-time upgrade, pure over the IDBDatabase/IDBTransaction surface it
// touches so a unit test can drive it without an IndexedDB. Called from
// onupgradeneeded with the version the browser held before.
export function upgradeHistoryDb(
  d: Pick<IDBDatabase, 'objectStoreNames' | 'deleteObjectStore' | 'createObjectStore'>,
  oldVersion: number,
  tx: {objectStore: (name: string) => Pick<IDBObjectStore, 'clear'>} | null
): void {
  if (d.objectStoreNames.contains('sessions')) d.deleteObjectStore('sessions');
  const hadPages = d.objectStoreNames.contains(PAGES);
  if (!hadPages) d.createObjectStore(PAGES, {keyPath: 'key'});
  // every page, meta and in-`pages` roster row from before v4 is stale
  if (hadPages && oldVersion > 0 && oldVersion < 4 && tx) tx.objectStore(PAGES).clear();
  if (!d.objectStoreNames.contains(ROSTER)) d.createObjectStore(ROSTER, {keyPath: 'engineKey'});
  if (!d.objectStoreNames.contains(ANCHORS)) d.createObjectStore(ANCHORS, {keyPath: 'sessionId'});
}

export type StoredPage = {
  key: string;
  sessionId: string;
  page: number;
  version: number;
  sealed: boolean;
  messages: CycEngineMessage[];
  /** the session records of the same page (absent on a page written before
   *  the log carried them; read as none) */
  events?: CycSessionEvent[];
  savedAt: number;
};

export type PageMeta = {
  key: string;
  sessionId: string;
  pointer: number;
  pointerPage: number;
  tailPage: number;
  total: number;
  pageSize: number;
  savedAt: number;
  // last attach-ok or page fetch that came from the engine
  syncedAt: number;
  /* Highest seq the engine has confirmed this device holds contiguously.
   * -1 when it has never held anything contiguous. Absent on rows written
   * before frontier sync; readers treat missing as -1 and never recompute
   * it from counts. */
  frontier?: number;
};

// Every list-visible field of a session (roster.ts owns the list), plus the
// app-side deliberate mark-unread, so a cold open paints the list exactly as
// it was.
export type StoredSession = Pick<
  CycEngineSession,
  | 'id'
  | 'paneId'
  | 'tabKey'
  | 'name'
  | 'cwd'
  | 'unread'
  | 'order'
  | 'alive'
  | 'lastActivity'
  | 'heardTs'
  | 'title'
  | 'avatarUrl'
  | 'status'
  | 'thinking'
  | 'contextPct'
  | 'agentName'
  | 'agentId'
  | 'sessionAgentId'
  | 'agentLabel'
  | 'model'
  | 'turnSince'
  | 'replyLevel'
  | 'claudeSessionId'
  | 'settings'
  | 'muted'
  | 'ask'
  | 'askUnknown'
> & {markedUnread: boolean};

export type RosterRow = {
  engineKey: string;
  savedAt: number;
  syncedAt: number;
  hostname?: string;
  tabs: EngineTab[];
  sessions: StoredSession[];
};

export type ScrollAnchor = {
  sessionId: string;
  seq: number;
  offsetPx: number;
  atBottom: boolean;
  savedAt: number;
};

const pageKey = (sessionId: string, page: number) => `${sessionId}|p${page}`;
const metaKey = (sessionId: string) => `${sessionId}|meta`;

let db: IDBDatabase | null = null;
let opening: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (db) return Promise.resolve(db);
  if (opening) return opening;
  opening = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = (ev) => {
      upgradeHistoryDb(req.result, ev.oldVersion, req.transaction);
    };
    req.onsuccess = () => {
      db = req.result;

      db.onversionchange = () => {
        db?.close();
        db = null;
      };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return opening;
}

function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return openDb().then((d) => {
    if (!d) return null;
    return new Promise<T | null>((resolve) => {
      let req: IDBRequest<T>;
      try {
        req = run(d.transaction(store, mode).objectStore(store));
      } catch {
        resolve(null);
        return;
      }
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  });
}

// Pure: given every row, the clock, and the caps, decide which PAGE keys to drop.
// Never returns a `|meta` key (or any other non-page key). Oldest-`savedAt`-first
// past the cap. Pointer/tail pages survive an oldest-first sweep because every
// attach and every frame re-stamps their `savedAt`, so they are always among
// the freshest rows.
export function planHistoryEvictions(
  records: {key: string; savedAt: number}[],
  now: number,
  caps: {ttlMs: number; maxPages: number}
): string[] {
  const pages = records.filter((r) => isPageKey(r.key));
  const doomed = new Set<string>();
  for (const r of pages) {
    if (now - (r.savedAt ?? 0) > caps.ttlMs) doomed.add(r.key);
  }
  const surviving = pages
    .filter((r) => !doomed.has(r.key))
    .sort((a, b) => (a.savedAt ?? 0) - (b.savedAt ?? 0));
  let over = surviving.length - caps.maxPages;
  for (let i = 0; i < surviving.length && over > 0; i++, over--) {
    doomed.add(surviving[i].key);
  }
  return [...doomed];
}

let historyWrites: Promise<unknown> = Promise.resolve();
const settled = (): undefined => undefined;
function serialized<T>(run: () => Promise<T>): Promise<T> {
  const next = historyWrites.then(run, run);
  historyWrites = next.then(settled, settled);
  return next;
}

async function enforceCaps(): Promise<void> {
  try {
    const all = await tx<StoredPage[]>(
      PAGES,
      'readonly',
      (s) => s.getAll() as IDBRequest<StoredPage[]>
    );
    if (!Array.isArray(all) || !all.length) return;
    const now = Date.now();
    const doomed = planHistoryEvictions(all, now, {
      ttlMs: PAGE_TTL_MS,
      maxPages: MAX_PAGE_RECORDS
    });
    if (!doomed.length) return;
    for (const key of doomed) {
      const hit = all.find((r) => r.key === key);
      try {
        await tx(PAGES, 'readwrite', (s) => s.delete(key));
      } catch {
        continue;
      }
      cyclog('history.page.evicted', {
        key,
        session: hit?.sessionId,
        ageMs: hit ? now - (hit.savedAt ?? 0) : undefined,
        cap:
          hit && now - (hit.savedAt ?? 0) > PAGE_TTL_MS
            ? `age > ${PAGE_TTL_MS}ms`
            : `pages > ${MAX_PAGE_RECORDS}`,
        why:
          'the history cache is over a cap; the oldest pages go first (never the ' +
          'meta rows), so scrolling that far back becomes a fetch from its ' +
          'engine again; if this line is common, raise MAX_PAGE_RECORDS'
      });
    }
  } catch {
    // rugged: a failed sweep must never break the read/write path
  }
}

let sinceSweep = 0;
const SWEEP_EVERY = 25;

export async function loadIndex(): Promise<void> {
  await openDb();
  void serialized(enforceCaps);
}

export const stats = {served: 0, missed: 0, written: 0};

export async function readPage(sessionId: string, page: number): Promise<StoredPage | null> {
  const rec = await tx<StoredPage>(
    PAGES,
    'readonly',
    (s) => s.get(pageKey(sessionId, page)) as IDBRequest<StoredPage>
  );
  if (!rec || !Array.isArray(rec.messages)) {
    stats.missed++;
    return null;
  }
  stats.served++;
  return rec;
}

export async function readMeta(sessionId: string): Promise<PageMeta | null> {
  const rec = await tx<PageMeta>(
    PAGES,
    'readonly',
    (s) => s.get(metaKey(sessionId)) as IDBRequest<PageMeta>
  );
  return rec && typeof rec.pointer === 'number' ? rec : null;
}

// The page numbers this session has in the PAGES store, newest first. The
// `|meta` row is never a page key, so it never appears. Used by the offline
// attach fallback: when the meta-named pages are gone, paint the newest cached
// page(s) so a cold, offline open still shows something.
export async function listPages(sessionId: string): Promise<number[]> {
  const keys = await tx<IDBValidKey[]>(
    PAGES,
    'readonly',
    (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>
  );
  if (!Array.isArray(keys)) return [];
  const prefix = pageKey(sessionId, 0).replace(/0$/, '');
  const pages: number[] = [];
  for (const k of keys) {
    if (typeof k !== 'string' || !isPageKey(k) || !k.startsWith(prefix)) continue;
    const n = Number(k.slice(prefix.length));
    if (Number.isInteger(n)) pages.push(n);
  }
  return pages.sort((a, b) => b - a);
}

// The one-boot row-store migration reads every legacy page record here (the
// `<sid>|p<n>` rows, the whole cached history), so migrate.ts can fold their
// rows into cyc-rows by mid. The `|meta`/roster/anchor rows are not pages and
// never appear.
export async function readLegacyPages(): Promise<StoredPage[]> {
  const recs = await tx<StoredPage[]>(
    PAGES,
    'readonly',
    (s) => s.getAll() as IDBRequest<StoredPage[]>
  );
  if (!Array.isArray(recs)) return [];
  return recs.filter(
    (r) => r && typeof r.key === 'string' && isPageKey(r.key) && Array.isArray(r.messages)
  );
}

// After the migration folded the pages into cyc-rows, drop every page record so
// the old cache cannot be read again. The `|meta`/roster/anchor rows stay.
export async function dropLegacyPages(): Promise<void> {
  const keys = await tx<IDBValidKey[]>(
    PAGES,
    'readonly',
    (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>
  );
  if (!Array.isArray(keys)) return;
  for (const k of keys) {
    if (typeof k === 'string' && isPageKey(k)) void tx(PAGES, 'readwrite', (s) => s.delete(k));
  }
}

export function writePage(
  sessionId: string,
  p: {
    page: number;
    version: number;
    sealed: boolean;
    messages: (CycEngineMessage | EngineChatMessage)[];
    events?: (CycSessionEvent | EngineSessionEvent)[];
  }
): void {
  const messages = p.messages

    .filter((m) => !isLocalOnly(m as CycEngineMessage))

    .map((m) => {
      const held = m as CycEngineMessage;
      return held.dedupeKey
        ? held
        : held.seq !== undefined
          ? {...held, dedupeKey: `seq:${held.seq}`}
          : null;
    })
    .filter((m): m is CycEngineMessage => !!m)
    .map(strip);
  const events = (p.events ?? []).map(stripEvent);
  const rec: StoredPage = {
    key: pageKey(sessionId, p.page),
    sessionId,
    page: p.page,
    version: p.version,
    sealed: p.sealed,
    messages,
    events,
    savedAt: Date.now()
  };
  stats.written++;
  void tx(PAGES, 'readwrite', (s) => s.put(rec));
  if (++sinceSweep >= SWEEP_EVERY) {
    sinceSweep = 0;
    void serialized(enforceCaps);
  }
}

export function clearQueued(
  sessionId: string,
  page: number | undefined,
  ts: number,
  seq?: number
): void {
  void openDb().then((d) => {
    if (!d) return;
    let transaction: IDBTransaction;
    try {
      transaction = d.transaction(PAGES, 'readwrite');
    } catch {
      return;
    }
    const store = transaction.objectStore(PAGES);
    const patch = (rec: StoredPage | undefined, save: () => void): boolean => {
      if (!rec?.messages || rec.sessionId !== sessionId) return false;
      const m = rec.messages.find(
        (x) => x.role === 'user' && (seq === undefined ? x.ts === ts : x.seq === seq)
      );
      if (!m?.queued) return false;
      delete m.queued;
      rec.savedAt = Date.now();
      stats.written++;
      save();
      return true;
    };
    if (page !== undefined) {
      const get = store.get(pageKey(sessionId, page)) as IDBRequest<StoredPage>;
      get.onsuccess = () => {
        patch(get.result, () => {
          store.put(get.result);
        });
      };
      return;
    }

    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (!at) return;
      if (
        patch(at.value as StoredPage, () => {
          at.update(at.value);
        })
      )
        return;
      at.continue();
    };
  });
}

// Written on every attach-ok: the engine just served this thread, so it is
// synced now.
export function writeMeta(
  sessionId: string,
  meta: {
    pointer: number;
    pointerPage: number;
    tailPage: number;
    total: number;
    pageSize: number;
    frontier: number;
  }
): void {
  const now = Date.now();
  const rec: PageMeta = {
    key: metaKey(sessionId),
    sessionId,
    ...meta,
    savedAt: now,
    syncedAt: now
  };
  void tx(PAGES, 'readwrite', (s) => s.put(rec));
}

// A page fetched from the engine (older, or a gap) re-stamps `syncedAt` on the
// meta row without touching the pointer bookkeeping.
export function markSynced(sessionId: string, at: number): void {
  void openDb().then((d) => {
    if (!d) return;
    let store: IDBObjectStore;
    try {
      store = d.transaction(PAGES, 'readwrite').objectStore(PAGES);
    } catch {
      return;
    }
    const get = store.get(metaKey(sessionId)) as IDBRequest<PageMeta | undefined>;
    get.onsuccess = () => {
      const rec = get.result;
      if (!rec || typeof rec.pointer !== 'number') return;
      rec.syncedAt = at;
      store.put(rec);
    };
  });
}

export function writeRoster(row: Omit<RosterRow, 'savedAt'>): void {
  const rec: RosterRow = {...row, savedAt: Date.now()};
  void tx(ROSTER, 'readwrite', (s) => s.put(rec));
}

export async function readRoster(engineKey: string): Promise<RosterRow | null> {
  const rec = await tx<RosterRow>(
    ROSTER,
    'readonly',
    (s) => s.get(engineKey) as IDBRequest<RosterRow>
  );
  return rec && Array.isArray(rec.sessions) ? rec : null;
}

const isLocalOnly = (m: CycEngineMessage) => m.status === 'sending' || m.status === 'failed';

function stripEvent(ev: CycSessionEvent | EngineSessionEvent): CycSessionEvent {
  const out: CycSessionEvent = {uuid: ev.uuid, ts: ev.ts, kind: ev.kind, text: ev.text};
  if (ev.seq !== undefined) out.seq = ev.seq;
  if (ev.tool) out.tool = ev.tool;
  if (ev.source) out.source = ev.source;
  if (ev.sender) out.sender = ev.sender;
  return out;
}

function strip(m: CycEngineMessage): CycEngineMessage {
  const out: CycEngineMessage = {
    id: m.id,
    role: m.role,
    kind: m.kind,
    text: m.text,
    ts: m.ts,
    dedupeKey: m.dedupeKey
  };
  if (m.seq !== undefined) out.seq = m.seq;
  // The durable row id has to survive the cache round-trip: on a cold reload the
  // cache paints first, and if it lost `mid` the engine's backfill of the same
  // row would key on mid while the cached copy keyed on ts|role|text, and the
  // two would not dedup -- a twin. Kept here so both admits agree.
  if (m.mid) out.mid = m.mid;
  if (m.msgId) out.msgId = m.msgId;
  // The cid names the send this row came from: a cache paint keeps it so a
  // pending bubble of that send finds the row instead of twinning it.
  if (m.cid) out.cid = m.cid;
  if (m.durationS !== undefined) out.durationS = m.durationS;

  if (m.clipLost) out.clipLost = true;

  if (m.wordsFailed) out.wordsFailed = true;

  if (m.transcriptPending) out.transcriptPending = true;
  if (m.file) out.file = m.file;
  if (m.upload) out.upload = m.upload;
  if (m.uploads?.length) out.uploads = m.uploads;

  if (m.replyTo) out.replyTo = m.replyTo;
  if (m.queued) out.queued = true;
  if (m.scheduled) out.scheduled = m.scheduled;
  if (m.role === 'user') out.status = 'sent';
  return out;
}
