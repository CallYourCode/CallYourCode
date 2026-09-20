// The one boot conversion. The old cache stored whole history PAGES (up to 100
// rows each) keyed `<sid>|p<n>` in the cyc-history database; the rebuild stores
// ROWS keyed by durable id in cyc-rows. This reads every legacy page once, folds
// its rows into the row store by mid (idempotent, so a re-run or a crash mid
// conversion is harmless), and then the caller clears the old pages. The roster,
// events, and anchor stores are untouched: they are read the same as before.

import {cyclog} from '@/shared/logging';
import type {CycSessionEvent} from '../../../types';
import type {CycEngineMessage} from '../types';
import {eventRow, messageRow, type StoreRow} from './core';

// A legacy page record as history.writePage persisted it. Only the fields the
// conversion reads are named; the rest ride along untyped.
export type LegacyPage = {
  key: string;
  sessionId: string;
  messages: CycEngineMessage[];
  events?: CycSessionEvent[];
};

const isPageRecord = (r: {key?: unknown; sessionId?: unknown; messages?: unknown}): boolean =>
  typeof r.key === 'string' &&
  /\|p\d+$/.test(r.key) &&
  typeof r.sessionId === 'string' &&
  Array.isArray(r.messages);

// A legacy message is importable only if it carries a real seq AND a mid. A row
// with no seq (or seq < 0) sorts at the tail axis and walls the newest window
// (the chat renders empty); a row with no mid takes the `m@ts|role|text`
// fallback id and TWINS the same message the engine later re-serves WITH a mid
// (doubles). We refuse both here so a fresh conversion never seeds a stale axis;
// already-migrated devices are healed at attach (repl.resetIfStaleAxis).
function importableMessage(m: {seq?: number; mid?: string}): boolean {
  return typeof m.seq === 'number' && m.seq >= 0 && !!m.mid;
}

// A legacy event is importable only with a real seq (events are keyed by their
// uuid, so a mid does not apply); an unseqed event walls the window the same way.
function importableEvent(ev: {seq?: number}): boolean {
  return typeof ev.seq === 'number' && ev.seq >= 0;
}

// Pure: group every legacy page's importable rows by session into the store rows
// that will be upserted. Both kinds ride the one seq axis, exactly as they did
// on the page. Rows that would seed a stale axis (no seq, or a message with no
// mid) are refused, so the conversion never twins a row the engine re-serves nor
// leaves an unseqed row walling the window.
export function rowsFromLegacyPages(records: LegacyPage[]): Map<string, StoreRow[]> {
  const bySession = new Map<string, StoreRow[]>();
  for (const rec of records) {
    if (!isPageRecord(rec)) continue;
    let list = bySession.get(rec.sessionId);
    if (!list) bySession.set(rec.sessionId, (list = []));
    for (const m of rec.messages) if (importableMessage(m)) list.push(messageRow(rec.sessionId, m));
    for (const ev of rec.events ?? [])
      if (importableEvent(ev)) list.push(eventRow(rec.sessionId, ev));
  }
  return bySession;
}

const MIGRATED_FLAG = 'cyc-rows-migrated-v1';

export function alreadyMigrated(): boolean {
  try {
    return localStorage.getItem(MIGRATED_FLAG) === '1';
  } catch {
    return false;
  }
}

function markMigrated(): void {
  try {
    localStorage.setItem(MIGRATED_FLAG, '1');
  } catch {}
}

// The one-time durable rekey flag (fix-oneid, the deploy crossing). Distinct from
// MIGRATED_FLAG: a device that already migrated under master has the migrated
// flag set but its cyc-rows records are keyed the OLD way (`m:<mid>` for an own
// send), so the rekey is gated on its OWN versioned flag and runs once whether or
// not the page migration ran. Bumping this string (v2 -> v3) is how a future id
// spelling change re-runs the pass.
const REKEYED_FLAG = 'cyc-rows-rekeyed-v2';

export function alreadyRekeyed(): boolean {
  try {
    return localStorage.getItem(REKEYED_FLAG) === '1';
  } catch {
    return false;
  }
}

function markRekeyed(): void {
  try {
    localStorage.setItem(REKEYED_FLAG, '1');
  } catch {}
}

// Run the durable rekey once, behind REKEYED_FLAG. The flag is set only AFTER the
// pass resolves, so a crash mid-pass re-runs on the next boot (the pass is
// idempotent) and the runtime fold catches anything a partial pass had not
// reached. Kept beside migrateLegacyHistory so the boot chains the two.
export async function rekeyRowsToOneId(deps: {
  rekeyDurable: () => Promise<{sessions: number; rekeyed: number}>;
}): Promise<{sessions: number; rekeyed: number; skipped: boolean}> {
  if (alreadyRekeyed()) return {sessions: 0, rekeyed: 0, skipped: true};
  const res = await deps.rekeyDurable();
  markRekeyed();
  cyclog('rowstore.rekey.done', res);
  return {...res, skipped: false};
}

export type MigrateDeps = {
  readLegacyPages: () => Promise<LegacyPage[]>;
  importRows: (sessionId: string, rows: StoreRow[]) => Promise<void>;
  dropLegacyPages: () => Promise<void>;
};

// Run the conversion once. Ships behind the migrated flag so a warm device never
// re-reads its pages. Returns the counts for a boot log line.
export async function migrateLegacyHistory(
  deps: MigrateDeps
): Promise<{sessions: number; rows: number; skipped: boolean}> {
  if (alreadyMigrated()) return {sessions: 0, rows: 0, skipped: true};
  const records = await deps.readLegacyPages();
  const bySession = rowsFromLegacyPages(records);
  let rows = 0;
  for (const [sessionId, list] of bySession) {
    await deps.importRows(sessionId, list);
    rows += list.length;
  }
  await deps.dropLegacyPages();
  markMigrated();
  cyclog('rowstore.migrate.done', {sessions: bySession.size, rows});
  return {sessions: bySession.size, rows, skipped: false};
}
