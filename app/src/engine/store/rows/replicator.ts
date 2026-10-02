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
import type {EnginePage, EnginePagePrints} from '../../contract';
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
  // The one door: append rows to the store. Resolves once committed. `pg` is the
  // engine page the rows came from, so the registry can replace a page whose
  // fingerprint differed instead of only adding to it.
  upsert: (rows: StoreRow[], pg: EnginePage) => Promise<{loSeq: number; hiSeq: number}>;
  // A page committed; `wasHole` when it filled a known hole (the registry logs
  // the fill and re-checks a page it was verifying).
  pageCommitted?: (page: number, pg: EnginePage, wasHole: boolean) => void;
  // Persist the cursor after a committed advance.
  persistCursor: (st: CursorState) => void;
  // The rate limiter's clock and scheduler, injectable so tests drive the pump
  // deterministically. Defaults wrap window timers.
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
  reachable?: () => boolean;
  // The backfill halts entirely while this returns true (the page is hidden):
  // no page is fetched and no timer is armed, so a backgrounded tab spends zero
  // CPU and wire on history it cannot show. The registry flips it on
  // visibilitychange and calls wake() to resume. Defaults to never paused.
  paused?: () => boolean;
  // The minimum gap between page fetches, read fresh on every step so the rate
  // can differ by state: the OPEN chat backfills at the full DEFAULT_PAGES_PER_SEC,
  // every other session at a slow background trickle (still filling the owner's
  // whole offline history, just cheaply). Defaults to the full rate.
  gapMs?: () => number;
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
  // Re-arm the pump after a pause lifted (the page became visible again). A
  // no-op on a stopped replicator or when there is nothing left to fetch.
  wake: () => void;
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
  // The engine's tail VERSION (the seq just past the newest row), carried on
  // every attach-ok. It is the one value the renumber check may compare: unlike
  // `total` (a row COUNT) it is a real point on the seq axis, so on an axis with
  // gaps it sits ABOVE `total`. Absent on engines older than this field.
  tailVersion?: number;
  pointerPage?: number;
  pages: EnginePage[];
  deltaBase?: number;
  // the shown pages' fingerprints (repl.ts verifyPages reads them)
  fp?: EnginePagePrints;
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

// The engine's tail version we watch for a renumber. It is a VERSION (a point on
// the seq axis), never a row COUNT. Preference order:
//   1. the wire `tailVersion` the engine states on every attach-ok, authoritative
//      even on a page-less delta (a device already current);
//   2. else the newest SERVED page's version -- the tail page is always among the
//      pages when the delta carries any (engine builds them down from pageOf(T)),
//      so its version equals the real tail version.
// It NEVER falls back to `total`. `total` is the row count, which on a gappy seq
// axis sits BELOW the true tail version; treating it as a version made a
// page-less up-to-date attach look like a regression and triggered a false
// renumber that re-downloaded the whole history (the CPU/network/storage flood).
// Returns 0 when NO version is known (an old engine's page-less attach); the
// renumber check reads 0 as "unknown" and declares no renumber, so an unknown
// tail can never be mistaken for a regressed one.
export function tailVersionOf(a: AttachOkLite): number {
  if (typeof a.tailVersion === 'number' && Number.isFinite(a.tailVersion) && a.tailVersion > 0) {
    return a.tailVersion;
  }
  let v = 0;
  for (const p of a.pages) if (p.version > v) v = p.version;
  return v;
}

export function createReplicator(sessionId: string, deps: ReplicatorDeps): Replicator {
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  const reachable = deps.reachable ?? (() => true);
  const paused = deps.paused ?? (() => false);
  const gapMs = deps.gapMs ?? (() => 1000 / DEFAULT_PAGES_PER_SEC);

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
    await deps.upsert(rows, pg);
    // The write committed: only now does the cursor move over this page.
    const wasHole = cursor.holes.has(page);
    notePageCommitted(cursor, page);
    persist();
    deps.pageCommitted?.(page, pg, wasHole);
  }

  const attachOk = async (a: AttachOkLite): Promise<void> => {
    cursor.pageSize = a.pageSize || cursor.pageSize || 100;
    const tailPage = a.tailPage ?? a.pointerPage ?? -1;
    const version = tailVersionOf(a);
    const renumbered = renumberDirty(cursor, version);
    if (renumbered) {
      cyclog('replicator.renumber', {
        session: sessionId,
        was: cursor.tailVersion,
        now: version,
        why: 'engine tail version regressed; the seq axis was renumbered, re-pull by mid'
      });
      resetCoverage(cursor, tailPage, version);
    } else {
      if (tailPage > cursor.tailPage) cursor.tailPage = tailPage;
    }
    if (!renumbered && cursor.tailVersion > 0 && a.pages.length) {
      // THE CAPPED DELTA (fix-sync-gap, the tablet's and iPhone's holes). The
      // engine serves at most 20 pages above the frontier; a device further
      // behind gets the newest 20 and nothing between its confirmed edge and the
      // lowest served page. Those pages were never sent, so they are holes the
      // replicator fetches first, never "covered" because the tail moved past
      // them.
      const ps = cursor.pageSize;
      let lowest = Infinity;
      for (const p of a.pages) if (p.page < lowest) lowest = p.page;
      const from = Math.floor(cursor.tailVersion / ps);
      const added: number[] = [];
      for (let p = from; p < lowest; p++) {
        if (!cursor.holes.has(p)) added.push(p);
        cursor.holes.add(p);
      }
      if (added.length) {
        cyclog('gap.detected', {
          session: sessionId,
          pages: `${added[0]}-${added[added.length - 1]}`,
          seqs: `${cursor.tailVersion}-${lowest * ps - 1}`,
          deltaBase: a.deltaBase ?? -1,
          why: 'the engine capped the delta: the pages between the confirmed edge and the lowest served page were never sent'
        });
      }
    }
    // write and cover the pages the attach already carried
    for (const p of a.pages) {
      await commitPage(p.page, p);
    }
    // Only once the served pages committed does the confirmed edge move to the
    // engine's tail: everything at or below it is now held, or is a known hole.
    if (!renumbered) cursor.tailVersion = Math.max(cursor.tailVersion, version);
    persist();
    if (!stopped) kick();
  };

  // A live row moves the confirmed edge ONLY when it is the very next seq
  // (fix-sync-gap). An attached chat receives every row in order (messages and
  // session records), so its edge keeps up and the catch-up tick stays empty. A
  // chat this device is NOT attached to receives the broadcast messages but not
  // the records between them, so the next one is never edge + 1 and the edge
  // stays where the engine last confirmed it: the next attach asks from there.
  // That broadcast row raising the frontier was the laptop's whole hole.
  const noteLive = (seq: number | undefined): void => {
    if (seq === undefined || !Number.isFinite(seq) || cursor.pageSize <= 0) return;
    if (cursor.tailVersion <= 0 || seq !== cursor.tailVersion) return;
    cursor.tailVersion = seq + 1;
    const page = Math.floor(seq / cursor.pageSize);
    if (page > cursor.tailPage) cursor.tailPage = page;
    persist();
  };

  const demand = (seq: number): void => {
    if (!Number.isFinite(seq) || cursor.pageSize <= 0) return;
    addDemand(cursor, Math.floor(seq / cursor.pageSize));
    if (!stopped) kick();
  };

  const pump = async (): Promise<void> => {
    if (inFlight) return;
    if (paused()) return;
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
    if (stopped || timer || paused()) return;
    if (nextPage(cursor) === null) return;
    const wait = Math.max(0, gapMs() - (now() - lastFetchAt));
    timer = true;
    schedule(() => {
      timer = false;
      // The page may have gone hidden while we waited: stop here and leave the
      // cursor where it is until wake() re-arms the pump on the next visible.
      if (paused()) return;
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
    wake() {
      kick();
    },
    running() {
      return !stopped && !isComplete(cursor);
    }
  };
}

export {cursorSeq};
