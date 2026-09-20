// One background replicator per session. It is the ONLY thing that consumes the
// wire: it reads the engine's attach-ok pages, its page fetches, and (through
// the store door) its live frames, and it appends the rows to the store. It
// owns one durable cursor (the floor of the contiguous covered run, newest-first
// from the tail), advances it only after a batch's write commits, and pulls
// missing ranges in bounded batches so a cold device syncing a huge history does
// it in a quiet background trickle instead of flooding the screen. Writes are
// idempotent upserts by mid, so a re-sync after a seq renumber or a crash always
// converges.
//
// It NEVER paints. rowStore decides whether a committed write touched the open
// window; the replicator only feeds the door.

import {cyclog} from '@/shared/logging';
import type {EnginePage} from '../../contract';
import {eventRow, messageRow, type StoreRow} from './core';
import {
  addDemand,
  cursorSeq,
  emptyCursor,
  isComplete,
  nextPage,
  notePageCommitted,
  renumberDirty,
  resetCoverage,
  type CursorState
} from './cursor';
import type {CycEngineMessage} from '../types';

export type ReplicatorDeps = {
  // Fetch one page from the engine. null when the page cannot be confirmed
  // (offline, 404): the cursor stays at the edge and resumes later.
  fetchPage: (page: number) => Promise<EnginePage | null>;
  // The one door: append rows to the store. Resolves once committed.
  upsert: (rows: StoreRow[]) => Promise<{loSeq: number; hiSeq: number}>;
  // Persist the cursor after a committed advance.
  persistCursor: (st: CursorState) => void;
  // The rate limiter's clock and scheduler, injectable so tests drive the pump
  // deterministically. Defaults wrap window timers.
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
  reachable?: () => boolean;
};

// Default: two pages per second. A cold device with 79k rows (~800 pages) takes
// a quiet ~7 minutes in the background rather than flooding on attach.
export const DEFAULT_PAGES_PER_SEC = 2;

export type Replicator = {
  cursor: CursorState;
  // Feed an attach-ok: its tail bookkeeping seeds the cursor, its pages are
  // written, a renumber is detected and re-pulled. Returns the seq the pages
  // covered up to (for the caller's logging), never a paint.
  attachOk: (a: AttachOkLite) => Promise<void>;
  // A live tail row landed through the store door: advance the tail/cursor if it
  // extended the covered run by one.
  noteLive: (seq: number | undefined) => void;
  // The UI scrolled to a range the store lacked: prioritize it. Kicks the pump.
  demand: (seq: number) => void;
  // Run one drained step of the backfill (test seam and the timer body).
  pump: () => Promise<void>;
  // Begin/stop the background trickle.
  start: () => void;
  stop: () => void;
  running: () => boolean;
};

// The fields of an attach-ok the replicator reads. The wire fields stay exactly
// as the engine serves them; the replicator uses total/tail/deltaBase as its
// cursor exchange, not as a paint trigger.
export type AttachOkLite = {
  sessionId: string;
  pageSize: number;
  total?: number;
  tailPage?: number;
  pointerPage?: number;
  pages: EnginePage[];
  deltaBase?: number;
};

export function rowsFromPage(sessionId: string, page: EnginePage): StoreRow[] {
  const rows: StoreRow[] = [];
  for (const m of page.messages) {
    // A page message's wire `id` field IS the session id, not a row id (the
    // engine reuses it as the attach key: handlers/chat.ts ensureSession), so it
    // is dropped here and the row is stamped with its one durable name from its
    // own durable facts (cid/mid/ts) via messageRow. That name is identical on
    // every re-serve of the same row, so a renumber, a re-serve or a reload finds
    // and repaints the one node instead of twinning it.
    const msg = {...(m as unknown as CycEngineMessage)};
    rows.push(messageRow(sessionId, msg));
  }
  for (const ev of page.events ?? []) rows.push(eventRow(sessionId, ev));
  return rows;
}

// The engine's tail version we watch for a renumber: the newest page's version,
// falling back to the total. A restart that renumbers the seq axis moves this.
export function tailVersionOf(a: AttachOkLite): number {
  let v = 0;
  for (const p of a.pages) if (p.version > v) v = p.version;
  return v || a.total || 0;
}

export function createReplicator(sessionId: string, deps: ReplicatorDeps): Replicator {
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  const reachable = deps.reachable ?? (() => true);
  const minGapMs = 1000 / DEFAULT_PAGES_PER_SEC;

  const cursor = emptyCursor(100);
  let lastFetchAt = 0;
  let inFlight = false;
  let timer = false;
  let stopped = true;

  function persist(): void {
    deps.persistCursor(cursor);
  }

  async function commitPage(page: number, pg: EnginePage): Promise<void> {
    const rows = rowsFromPage(sessionId, pg);
    await deps.upsert(rows);
    // The write committed: only now does the cursor move over this page.
    notePageCommitted(cursor, page);
    persist();
  }

  const attachOk = async (a: AttachOkLite): Promise<void> => {
    cursor.pageSize = a.pageSize || cursor.pageSize || 100;
    const tailPage = a.tailPage ?? a.pointerPage ?? -1;
    const version = tailVersionOf(a);
    if (renumberDirty(cursor, version)) {
      cyclog('replicator.renumber', {
        session: sessionId,
        was: cursor.tailVersion,
        now: version,
        why: 'engine tail version regressed; the seq axis was renumbered, re-pull by mid'
      });
      resetCoverage(cursor, tailPage, version);
    } else {
      if (tailPage > cursor.tailPage) cursor.tailPage = tailPage;
      cursor.tailVersion = Math.max(cursor.tailVersion, version);
    }
    // write and cover the pages the attach already carried
    for (const p of a.pages) {
      await commitPage(p.page, p);
    }
    persist();
    if (!stopped) kick();
  };

  const noteLive = (seq: number | undefined): void => {
    if (seq === undefined || !Number.isFinite(seq) || cursor.pageSize <= 0) return;
    const page = Math.floor(seq / cursor.pageSize);
    if (page > cursor.tailPage) cursor.tailPage = page;
    // a live tail row that sits exactly on the covered edge extends coverage
    notePageCommitted(cursor, page);
    persist();
  };

  const demand = (seq: number): void => {
    if (!Number.isFinite(seq) || cursor.pageSize <= 0) return;
    addDemand(cursor, Math.floor(seq / cursor.pageSize));
    if (!stopped) kick();
  };

  const pump = async (): Promise<void> => {
    if (inFlight) return;
    if (!reachable()) return;
    const page = nextPage(cursor);
    if (page === null) return;
    inFlight = true;
    try {
      const pg = await deps.fetchPage(page);
      lastFetchAt = now();
      if (!pg) return; // cannot confirm; cursor stays, resume later
      await commitPage(page, pg);
    } catch (e) {
      cyclog('replicator.fetch.failed', {session: sessionId, page, err: String(e)});
    } finally {
      inFlight = false;
    }
  };

  function kick(): void {
    if (stopped || timer) return;
    if (nextPage(cursor) === null) return;
    const wait = Math.max(0, minGapMs - (now() - lastFetchAt));
    timer = true;
    schedule(() => {
      timer = false;
      void pump().then(() => {
        if (!stopped && nextPage(cursor) !== null) kick();
      });
    }, wait);
  }

  return {
    cursor,
    attachOk,
    noteLive,
    demand,
    pump,
    start() {
      stopped = false;
      kick();
    },
    stop() {
      stopped = true;
    },
    running() {
      return !stopped && !isComplete(cursor);
    }
  };
}

export {cursorSeq};
