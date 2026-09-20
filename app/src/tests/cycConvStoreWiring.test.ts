import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {wireChat} from '../engine/store/handlers/chat';
import type {HandlerCtx} from '../engine/store/handlers/types';
import {conns, sessions, type Conn} from '../engine/store/registry';
import type {CycEngineMessage, CycEngineSession} from '../engine/store/types';
import type {EnginePage} from '../engine/contract';
import * as sync from '../engine/sync';
import * as rowStore from '../engine/store/rows/rowStore';
import {messageRow} from '../engine/store/rows/core';
import {rowsFromPage} from '../engine/store/rows/replicator';
import {initDoor, openChatWindow, patchMessage, WINDOW} from '../engine/store/rows/door';
import {attach, detachChat, markVoiceNoteSafe, __setAttachedForTest} from '../engine/store';
import {
  feedAttachOk,
  running,
  stopReplicator,
  __attachOkRunsForTest,
  __resetReplicatorsForTest
} from '../engine/store/rows/repl';
import type {AttachOkLite} from '../engine/store/rows/replicator';
import {memTx, asyncMemTx, abortableMemTx} from './rowStoreFake';

// THE DESIGN'S INVARIANTS, AGAINST THE REAL WIRING. cycConvStoreInvariants and
// cycConvStoreFlood prove them on the store/replicator in isolation; this file
// proves the SAME invariants end to end, driving the real chat handler, which
// feeds the real replicator, which appends to the real store, whose one change
// notification is the only paint. Nothing here reaches into the store by hand on
// the paint path: a frame arrives, and only a window-touching store write paints.

const KEY = 'ws://convstore-wiring.test:7790/ws';
const SID = KEY + '|p1';
const PAGE = 100;
const PAGES = 50;

initDoor();

function page(n: number): EnginePage {
  const base = n * PAGE;
  return {
    page: n,
    version: (n + 1) * PAGE,
    sealed: true,
    messages: Array.from({length: PAGE}, (_, i) => ({
      id: SID,
      role: (i % 2 ? 'user' : 'claude') as 'user' | 'claude',
      kind: 'text' as const,
      text: 'r' + (base + i),
      ts: base + i,
      seq: base + i,
      mid: 'mr-' + (base + i)
    })),
    events: []
  } as unknown as EnginePage;
}

// One page's messages as store rows, ids minted exactly as the replicator mints
// them, for seeding a fully-stored session.
const rowsOfPage = (n: number) => rowsFromPage(SID, page(n));

function mkSession(paneId = 'p1'): CycEngineSession {
  const s = {
    id: KEY + '|' + paneId,
    engineKey: KEY,
    paneId,
    tabKey: '',
    name: paneId,
    cwd: '',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [],
    claudeSessionId: null,
    events: [],
    agentRuns: []
  } as unknown as CycEngineSession;
  sessions.set(s.id, s);
  return s;
}

function wire(
  fetchPage?: (pane: string, n: number) => Promise<EnginePage | null>,
  firstPaint?: (id: string, source: 'cache' | 'replay') => void
): {
  fire: (ev: string, ...a: unknown[]) => void;
} {
  const handlers: Record<string, (...a: never[]) => void> = {};
  const client = {
    on: (ev: string, fn: never) => {
      handlers[ev] = fn as never;
    },
    fetchPage:
      fetchPage ??
      vi.fn(async (_pane: string, n: number) => (n >= 0 && n < PAGES ? page(n) : null)),
    detach: vi.fn(),
    setSessionTail: vi.fn()
  };
  const conn = {key: KEY, client, state: 'connected'} as unknown as Conn;
  conns.push(conn);
  const ctx = {
    ensureSession: (_ek: string, paneId: string) =>
      sessions.get(KEY + '|' + paneId) ?? mkSession(paneId),
    stripInstruction: (t: string) => t,
    releaseQueuedBefore: vi.fn(() => false),
    releaseQueued: vi.fn(() => true),
    endReplayHold: vi.fn(),
    firstPaint: firstPaint ? vi.fn(firstPaint) : vi.fn()
  } as unknown as HandlerCtx;
  wireChat(conn, ctx);
  return {fire: (ev, ...a) => (handlers[ev] as (...x: unknown[]) => void)(...a)};
}

async function micro(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(() => {
  rowStore.__setBackingForTest(memTx().tx);
  sync.__resetLiveForTest(() => 0.5);
  // the replicator only pulls when the engine is reachable
  sync.noteSealed(KEY);
  sync.noteHost(KEY);
  sync.noteSessions(KEY);
});

afterEach(() => {
  rowStore.__setBackingForTest(null);
  __resetReplicatorsForTest();
  sessions.clear();
  const at = conns.findIndex((c) => c.key === KEY);
  if (at >= 0) conns.splice(at, 1);
  sync.__resetLiveForTest();
  vi.useRealTimers();
});

describe('invariant 1 (real wiring): a wire frame to a chat that is not open paints nothing', () => {
  test('a live chat frame for another session never fires the open chat paint', async () => {
    const {fire} = wire();
    mkSession('p1');
    mkSession('p2');
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 300);

    let paints = 0;
    const off = rowStore.onChange((sid) => {
      if (sid === SID) paints++;
    });
    // a live row for the OTHER chat, through the real handler
    fire('chat', {id: 'p2', role: 'claude', text: 'elsewhere', ts: 1, seq: 1, mid: 'mr-p2'});
    await micro();
    expect(paints).toBe(0);
    // control: a live row for the OPEN chat does paint
    fire('chat', {id: 'p1', role: 'claude', text: 'here', ts: 2, seq: 2, mid: 'mr-p1'});
    await micro();
    expect(paints).toBe(1);
    off();
  });
});

describe('invariant 3 (real wiring): one row per mid, whatever seq did', () => {
  test('the same mid re-served under three seqs through the handler is one row', async () => {
    const {fire} = wire();
    mkSession('p1');
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 300);
    fire('chat', {id: 'p1', role: 'claude', text: 'v', ts: 5, seq: 3, mid: 'mr-dup'});
    fire('chat', {id: 'p1', role: 'claude', text: 'v', ts: 5, seq: 9, mid: 'mr-dup'});
    fire('chat', {id: 'p1', role: 'claude', text: 'v', ts: 5, seq: 1, mid: 'mr-dup'});
    await micro();
    const {messages} = rowStore.projection(SID);
    expect(messages).toHaveLength(1);
    expect(messages[0].seq).toBe(1);
  });
});

describe('the flood (real wiring): F=-1 cold attach over 50 pages', () => {
  test('ONE open paint, ZERO backfill paints, the whole history stored', async () => {
    vi.useFakeTimers();
    const {fire} = wire();
    mkSession('p1');
    // cold open onto an empty store: floor 0, nothing local yet
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, PAGE);

    let paints = 0;
    const off = rowStore.onChange((sid) => {
      if (sid === SID) paints++;
    });

    // the engine's cold attach-ok: F=-1, the delta carries ONLY the tail page.
    fire('attachOk', {
      id: 'p1',
      known: true,
      pageSize: PAGE,
      total: PAGES * PAGE,
      tailPage: PAGES - 1,
      pointerPage: PAGES - 1,
      pages: [page(PAGES - 1)]
    });

    // let the attach-ok commit its delta, resnap the window, and start the
    // replicator before we advance the clock.
    await micro();
    // drain the background replicator (2 pages/sec) to completion.
    for (let i = 0; i < PAGES + 5 && running(SID); i++) {
      await vi.advanceTimersByTimeAsync(600);
      await micro();
    }

    // the tail delta painted once; every older backfilled page fell below the
    // resnapped window and painted nothing. The flood is gone on a cold device.
    expect(paints).toBe(1);
    expect(running(SID)).toBe(false); // cursor completed to the floor
    // the open window is still the tail, unchanged by the flood.
    const proj = rowStore.projection(SID);
    expect(proj.messages).toHaveLength(PAGE);
    expect(proj.messages[proj.messages.length - 1].text).toBe('r' + (PAGES * PAGE - 1));
    off();

    // scrolling up reads older rows from the store, no new window paint needed.
    const older = await rowStore.extendWindow(SID, PAGE);
    expect(older.messages[0].text).toBe('r' + (PAGES * PAGE - 2 * PAGE));
    expect(older.messages).toHaveLength(2 * PAGE);
  });
});

describe('the cold open paints the served tail even when the admit beats the open-window floor (real wiring)', () => {
  test('a served inline tail admitted while the chat is OPEN but not yet floored projects within the same attach cycle, never a persistent empty window', async () => {
    vi.useFakeTimers();
    // An async (durable) backing: a fire-and-forget row write is NOT visible to
    // a read issued before it commits, exactly like real IndexedDB. This is what
    // makes the defect BITE. With the synchronous memTx a later window read could
    // reload the served rows straight from the durable side and hide the bug; on
    // the real wire (and here) it cannot, so an admit that never landed in the
    // loaded window projects EMPTY and stays empty.
    rowStore.__setBackingForTest(asyncMemTx().tx);
    const {fire} = wire();
    mkSession('p1');

    // The chat is OPEN the instant it attaches (store.setOpen), but its window
    // FLOOR is not established until the open's deferred openWindow reads the
    // tail. The settled edge asks the engine independently of that read, so the
    // attach-ok's served tail can be admitted in the gap: the window is open but
    // still UNFLOORED. This is the fresh cold open the owner hit on the loopback
    // wire (chat.opened messages=0, engine served the inline tail, then
    // chat.painted source=replay count=0, then nothing forever).
    rowStore.setOpen(SID);
    expect(rowStore.projection(SID).messages).toHaveLength(0);

    // The engine serves the cold inline tail.
    fire('attachOk', coldTail());
    await drain();
    expect(running(SID)).toBe(false);

    // The served tail projects within the attach cycle: the cold open shows the
    // newest engine rows, never the persistent empty window. Before the fix the
    // admit landed in the index but never the loaded window (upsertMirror treats
    // a write to an unfloored window as pre-open), and the later window read
    // raced the not-yet-committed fire-and-forget durable writes and projected
    // EMPTY with nothing to recover it.
    const proj = rowStore.projection(SID).messages;
    expect(proj.length).toBeGreaterThan(0);
    expect(proj[proj.length - 1].text).toBe('r' + (PAGES * PAGE - 1));
    // and the whole served history is stored, reachable by scrolling up.
    const full = await rowStore.openWindow(SID, PAGES * PAGE + PAGE);
    expect(full.messages).toHaveLength(PAGES * PAGE);
    expect(full.messages[0].text).toBe('r0');
  });
});

// A page carrying ONLY chat messages (bubbles), seqs seqBase..seqBase+count-1.
function msgPage(n: number, count: number, seqBase: number): EnginePage {
  return {
    page: n,
    version: seqBase + count,
    sealed: true,
    messages: Array.from({length: count}, (_, i) => ({
      id: SID,
      role: (i % 2 ? 'user' : 'claude') as 'user' | 'claude',
      kind: 'text' as const,
      text: 'm' + (seqBase + i),
      ts: seqBase + i,
      seq: seqBase + i,
      mid: 'mm-' + (seqBase + i)
    })),
    events: []
  } as unknown as EnginePage;
}

// A page carrying ONLY pill-paintable session events (reply/tool/prompt), exactly
// the busy-agent activity tail the live wire stamps ABOVE the newest message.
function eventPage(n: number, kind: string, count: number, seqBase: number): EnginePage {
  return {
    page: n,
    version: seqBase + count,
    sealed: true,
    messages: [],
    events: Array.from({length: count}, (_, i) => ({
      uuid: 'se-' + (seqBase + i),
      ts: seqBase + i,
      seq: seqBase + i,
      kind,
      text: kind + ' ' + (seqBase + i)
    }))
  } as unknown as EnginePage;
}

describe('the busy-agent event tail (real wiring): messages below a renderable-event tail still open', () => {
  test('a delta whose newest WINDOW rows are all pill-paintable events (reply/tool) still opens on the chat messages below them', async () => {
    vi.useFakeTimers();
    // The fresh cold open on the live loopback wire: the engine serves the inline
    // delta, no backfill page needed.
    const {fire} = wire(async () => null);
    mkSession('p1');
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);

    // 20 chat messages at the bottom of the axis (seq 0..19), then 400
    // pill-paintable session events stamped ABOVE them (seq 20..419): the wire
    // shape a working agent serves, where the newest WINDOW rows BY SEQ are all
    // events and the real messages sit far below the tail. This is what the field
    // profile held (msg rows in the 39k seqs, a reply/tool/prompt tail above them
    // to the engine's 41k tail), and what the bare-record repro missed.
    fire('attachOk', {
      id: 'p1',
      known: true,
      pageSize: PAGE,
      total: 420,
      tailPage: 4,
      pointerPage: 4,
      pages: [msgPage(0, 20, 0), eventPage(1, 'reply', 200, 20), eventPage(2, 'tool', 200, 220)]
    });
    await micro();

    const proj = rowStore.projection(SID);
    // Before the fix the window floored on the newest WINDOW RENDERABLE rows --
    // all events -- and the 20 messages fell below the floor: projection.messages
    // was EMPTY and the chat opened blank (with the overlay off) even though the
    // messages were held. Anchoring the window on messages keeps the bubbles in
    // the open window.
    expect(proj.messages).toHaveLength(20);
    expect(proj.messages[0].text).toBe('m0');
    expect(proj.messages[proj.messages.length - 1].text).toBe('m19');
    // The events are still held in the contiguous span (the overlay paints them).
    expect(proj.events.length).toBeGreaterThan(0);
  });
});

describe('the stale seq axis (real wiring): attach-ok below the held tail heals the device', () => {
  test('the stale rows are dropped, the pending send survives, the real tail projects, the next frontier is at or below the axis', async () => {
    vi.useFakeTimers();
    const {fire} = wire();
    const s = mkSession('p1');

    // Migrated rows from an OLDER, LONGER engine axis: seqs FAR above this
    // engine's tail. The owner's phone held seqs up to ~13360 while the engine
    // axis tops out at 4999; the one-boot migration imported them verbatim.
    const staleBase = 13261;
    const stale = Array.from({length: PAGE}, (_, i) =>
      messageRow(SID, {
        id: 999000 + i,
        role: 'claude',
        kind: 'text',
        text: 'STALE' + i,
        ts: 900000 + i,
        seq: staleBase + i,
        mid: 'stale-' + i
      } as unknown as CycEngineMessage)
    );
    await rowStore.upsert(SID, stale);

    // Open onto the stale axis: exactly what the phone painted, old mid-history
    // sorted above every genuine row.
    await openChatWindow(SID);
    expect(rowStore.highestHeldSeq(SID)).toBe(staleBase + PAGE - 1); // 13360

    // One unsent optimistic send the user typed while stuck ('sending'): a local
    // overlay on s.messages, never a store row.
    const pending = {
      id: 424242,
      role: 'user',
      kind: 'text',
      text: 'my stuck send',
      ts: 950000,
      status: 'sending',
      cid: 'cid-mine'
    } as unknown as CycEngineMessage;
    (s.messages as CycEngineMessage[]).push(pending);

    // The engine (with the axis guard) serves the COLD tail: the newest page and
    // a tail version BELOW what the phone already holds.
    fire('attachOk', {
      id: 'p1',
      known: true,
      pageSize: PAGE,
      total: PAGES * PAGE,
      tailPage: PAGES - 1,
      pointerPage: PAGES - 1,
      pages: [page(PAGES - 1)]
    });
    await micro();
    for (let i = 0; i < PAGES + 5 && running(SID); i++) {
      await vi.advanceTimersByTimeAsync(600);
      await micro();
    }
    expect(running(SID)).toBe(false);

    // The stale axis is gone: no STALE row survives and the held tail is the
    // REAL newest engine seq, not the phantom 13360.
    const full = await rowStore.openWindow(SID, PAGES * PAGE + PAGE);
    expect(full.messages.some((mm) => (mm.text ?? '').startsWith('STALE'))).toBe(false);
    expect(rowStore.highestHeldSeq(SID)).toBe(PAGES * PAGE - 1); // 4999
    // The served tail projects and the window shows the REAL newest rows.
    expect(full.messages[full.messages.length - 1].text).toBe('r' + (PAGES * PAGE - 1));

    // The user's own pending send survived the reset (still the s.messages
    // overlay), so his stuck send is not lost.
    expect((s.messages as CycEngineMessage[]).some((mm) => mm.cid === 'cid-mine')).toBe(true);

    // The next attach sends a frontier at or below the engine tail version, so
    // the device can never wedge itself above the axis again.
    const tailVersion = PAGES * PAGE; // 5000
    expect(rowStore.highestHeldSeq(SID)).toBeLessThanOrEqual(tailVersion);
  });
});

// A message row exactly as the engine's tail page carries it, but as a stale
// LEGACY row missing a field: no mid (id falls back to m@ts|role|text) or no
// seq. rowsFromPage/messageRow build the sound version; these build the stale
// twin the migration used to import.
function legacyMidlessRowOfTailMsg(i: number): ReturnType<typeof messageRow> {
  const base = (PAGES - 1) * PAGE;
  return messageRow(SID, {
    id: 700000 + i,
    role: (i % 2 ? 'user' : 'claude') as 'user' | 'claude',
    kind: 'text',
    text: 'r' + (base + i),
    ts: base + i,
    seq: base + i
    // no mid: the durable id becomes m@ts|role|text, the twin
  } as unknown as CycEngineMessage);
}

const coldTail = () => ({
  id: 'p1',
  known: true,
  pageSize: PAGE,
  total: PAGES * PAGE,
  tailPage: PAGES - 1,
  pointerPage: PAGES - 1,
  pages: [page(PAGES - 1)]
});

// The AttachOkLite the chat handler builds from a cold-tail attach-ok, for the
// concurrency tests that fire feedAttachOk directly (without awaiting) to force
// two runs to overlap.
const attachLite = (): AttachOkLite => ({
  sessionId: SID,
  pageSize: PAGE,
  total: PAGES * PAGE,
  tailPage: PAGES - 1,
  pointerPage: PAGES - 1,
  pages: [page(PAGES - 1)]
});

// Seed a full page of migrated rows on an OLDER, LONGER axis (seqs far above the
// engine's tail) into both the mirror and the durable backing: exactly what a
// phone that cached a longer history holds, and what makes the attach-ok stale.
async function seedStaleAxis(staleBase: number): Promise<void> {
  const stale = Array.from({length: PAGE}, (_, i) =>
    messageRow(SID, {
      id: 999000 + i,
      role: 'claude',
      kind: 'text',
      text: 'STALE' + i,
      ts: 900000 + i,
      seq: staleBase + i,
      mid: 'stale-' + i
    } as unknown as CycEngineMessage)
  );
  await rowStore.upsert(SID, stale);
}

async function drain(): Promise<void> {
  await micro();
  // Advance the 0ms durable commits (an async backing defers a write to a
  // macrotask) so feedAttachOk's awaited purge lands and the replicator starts,
  // without yet firing the replicator's 500ms pacing kick.
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(1);
    await micro();
  }
  for (let i = 0; i < PAGES + 5 && running(SID); i++) {
    await vi.advanceTimersByTimeAsync(600);
    await micro();
  }
}

describe('the stale seq axis heal STICKS on a real async (durable) backing', () => {
  test('the durable BACKING and the mirror are both purged, the served tail projects, a second identical attach-ok does NOT re-fire the heal, and the frontier ends at or below the axis', async () => {
    vi.useFakeTimers();
    // A backing that models real IndexedDB's asynchronous commit, so a
    // fire-and-forget durable delete that the heal does not await can lose the
    // race and the stale axis reloads from a not-yet-deleted index. The
    // synchronous memTx cannot expose this; this is the live rig's purge loop.
    const {db} = ((): {db: Map<string, {key: string}>} => {
      const made = asyncMemTx();
      rowStore.__setBackingForTest(made.tx);
      return {db: made.db};
    })();
    const {fire} = wire();
    mkSession('p1');

    // Seed migrated rows on an OLDER, LONGER axis (seqs far above the engine's
    // tail) into BOTH the mirror and the durable backing.
    const staleBase = 13261;
    const stale = Array.from({length: PAGE}, (_, i) =>
      messageRow(SID, {
        id: 999000 + i,
        role: 'claude',
        kind: 'text',
        text: 'STALE' + i,
        ts: 900000 + i,
        seq: staleBase + i,
        mid: 'stale-' + i
      } as unknown as CycEngineMessage)
    );
    await rowStore.upsert(SID, stale);
    await vi.advanceTimersByTimeAsync(1); // commit the seed durably
    // the durable backing really holds the stale rows now (not just the mirror)
    const staleKeys = () => [...db.keys()].filter((k) => k.includes('|r|m:stale-')).length;
    expect(staleKeys()).toBe(PAGE);

    await openChatWindow(SID);
    expect(rowStore.highestHeldSeq(SID)).toBe(staleBase + PAGE - 1); // 13360

    const purgeSpy = vi.spyOn(rowStore, 'purge');

    // The engine (axis guard) serves the COLD tail with a version BELOW the held
    // tail: the stale-axis heal must fire.
    fire('attachOk', coldTail());
    await drain();
    expect(running(SID)).toBe(false);

    // The heal STUCK: the durable backing holds no stale row, and neither does
    // the mirror. This is the assertion the fire-and-forget purge failed on the
    // rig (heldTail stayed 13360 on the next attach: a purge loop).
    expect(staleKeys()).toBe(0);
    const full = await rowStore.openWindow(SID, PAGES * PAGE + PAGE);
    expect(full.messages.some((mm) => (mm.text ?? '').startsWith('STALE'))).toBe(false);
    // The served tail projects and the held tail is the REAL newest engine seq.
    expect(full.messages[full.messages.length - 1].text).toBe('r' + (PAGES * PAGE - 1));
    expect(rowStore.highestHeldSeq(SID)).toBe(PAGES * PAGE - 1); // 4999

    // A second IDENTICAL attach-ok must NOT re-fire the heal (one purge total).
    fire('attachOk', coldTail());
    await drain();
    expect(purgeSpy).toHaveBeenCalledTimes(1);
    expect(rowStore.highestHeldSeq(SID)).toBe(PAGES * PAGE - 1);

    // The frontier the app reports afterwards is at or below the engine tail
    // version, sourced from the healed store, so the device cannot wedge above
    // the axis again.
    const tailVersion = PAGES * PAGE; // 5000
    expect(rowStore.highestHeldSeq(SID)).toBeLessThanOrEqual(tailVersion);
    purgeSpy.mockRestore();
  });
});

describe('the stale-axis purge that ABORTS does not stick, and the next committed attach redoes the heal (real wiring)', () => {
  test('a heal whose purge transaction aborts after its deletes succeed leaves the stale axis intact and never claims coverage; once transactions commit the next attach completes the heal in one pass', async () => {
    vi.useFakeTimers();
    // A durable backing whose readwrite transactions can be told to ABORT after
    // their requests succeed: the iOS Safari page-freeze the owner hit swiping
    // the app out mid-heal. On 541a8f8 realTx resolves on req.onsuccess, so the
    // purge reported its deletes durable microseconds before the frozen page
    // rolled the transaction back, and the stale axis resurrected on every
    // reopen (heldTail 115390, forever).
    const made = abortableMemTx();
    rowStore.__setBackingForTest(made.tx);
    const {fire} = wire();
    mkSession('p1');

    const staleBase = 13261;
    await seedStaleAxis(staleBase);
    await drain(); // commit the seed durably
    const staleKeys = () => [...made.db.keys()].filter((k) => k.includes('|r|m:stale-')).length;
    expect(staleKeys()).toBe(PAGE);

    await openChatWindow(SID);
    expect(rowStore.highestHeldSeq(SID)).toBe(staleBase + PAGE - 1); // 13360

    const purgeSpy = vi.spyOn(rowStore, 'purge');

    // The page is frozen: every readwrite transaction from here ABORTS after its
    // requests have already succeeded.
    made.setAbort(true);

    // The engine (axis guard) serves the cold tail: the stale-axis heal fires and
    // its purge deletes the stale rows, but the transaction never commits.
    fire('attachOk', coldTail());
    await drain();

    // The purge returned NOT-purged, so the heal kept the rows and never reset
    // coverage: the durable stale axis is intact and the held tail is still the
    // phantom axis. This is the field defect (the purge did not stick). On
    // 541a8f8 purge returns void and resolves on onsuccess, so the heal proceeds
    // as if purged, the served tail is admitted over a rolled-back delete, and
    // the axis resurrects.
    expect(purgeSpy).toHaveBeenCalled();
    expect(await purgeSpy.mock.results[0].value).toBe(false);
    expect(staleKeys()).toBe(PAGE); // NOTHING was durably deleted (tx rolled back)
    expect(rowStore.highestHeldSeq(SID)).toBe(staleBase + PAGE - 1); // still 13360

    // The page thaws (a fresh reopen on a live link): transactions commit again.
    made.setAbort(false);

    // The next attach re-fires the idempotent heal and completes it in ONE pass:
    // the purge commits, the served tail is admitted and projects, and the stale
    // axis is gone from BOTH the durable backing and the mirror.
    fire('attachOk', coldTail());
    await drain();
    expect(running(SID)).toBe(false);
    expect(staleKeys()).toBe(0);
    const full = await rowStore.openWindow(SID, PAGES * PAGE + PAGE);
    expect(full.messages.some((mm) => (mm.text ?? '').startsWith('STALE'))).toBe(false);
    expect(full.messages[full.messages.length - 1].text).toBe('r' + (PAGES * PAGE - 1));
    expect(rowStore.highestHeldSeq(SID)).toBe(PAGES * PAGE - 1); // 4999, the real axis
    purgeSpy.mockRestore();
  });
});

describe('the open-path replay must not paint the mid-heal empty window (real wiring)', () => {
  test('the FIRST replay paint the chat receives is the served tail, never the count=0 window the purge briefly opens', async () => {
    vi.useFakeTimers();
    rowStore.__setBackingForTest(memTx().tx);
    const s = mkSession('p1');

    // The stale axis is warm and OPEN, but the open-path projection has not run
    // for this open yet, so s.messages is empty: exactly the phone's
    // `chat.opened messages=0` moment (a mirror warm from a prior hold whose
    // in-memory projection has not been applied).
    const staleBase = 13261;
    await seedStaleAxis(staleBase);
    rowStore.setOpen(SID);
    expect(rowStore.highestHeldSeq(SID)).toBe(staleBase + PAGE - 1);
    (s.messages as CycEngineMessage[]).length = 0;
    expect((s.messages as CycEngineMessage[]).length).toBe(0);

    // Capture s.messages.length at the instant each replay paint is issued.
    const paintCounts: number[] = [];
    const {fire} = wire(undefined, () =>
      paintCounts.push((s.messages as CycEngineMessage[]).length)
    );

    // The engine serves the cold tail: the stale-axis heal fires (its purge
    // briefly opens an EMPTY window before it admits the served tail). On 541a8f8
    // the replay firstPaint runs synchronously, right then, so the first paint the
    // UI receives is count=0 (the phone's `chat.painted source=replay count=0`).
    fire('attachOk', coldTail());
    await drain();

    // The replay paint the UI received was the SERVED TAIL, never the mid-heal
    // empty window.
    expect(paintCounts.length).toBeGreaterThan(0);
    expect(paintCounts[0]).toBeGreaterThan(0);
    expect(Math.min(...paintCounts)).toBeGreaterThan(0);
    const projected = rowStore.projection(SID).messages;
    expect(projected.some((mm) => (mm.text ?? '').startsWith('STALE'))).toBe(false);
    expect(projected[projected.length - 1].text).toBe('r' + (PAGES * PAGE - 1));
  });
});

describe('the committed path still heals in one pass (real wiring, abort-capable backing left committing)', () => {
  test('with the abort-capable backing committing, one attach-ok purges once, admits the served tail, and projects, and a second identical attach-ok does not re-fire the heal', async () => {
    vi.useFakeTimers();
    const made = abortableMemTx(); // never armed to abort: the well-behaved page
    rowStore.__setBackingForTest(made.tx);
    const {fire} = wire();
    mkSession('p1');

    const staleBase = 13261;
    await seedStaleAxis(staleBase);
    await drain();
    const staleKeys = () => [...made.db.keys()].filter((k) => k.includes('|r|m:stale-')).length;
    expect(staleKeys()).toBe(PAGE);
    await openChatWindow(SID);

    const purgeSpy = vi.spyOn(rowStore, 'purge');
    fire('attachOk', coldTail());
    await drain();
    expect(running(SID)).toBe(false);

    // One pass: purge once (committing true), durable and mirror clean, served
    // tail projects and the held tail is the real engine axis.
    expect(purgeSpy).toHaveBeenCalledTimes(1);
    expect(await purgeSpy.mock.results[0].value).toBe(true);
    expect(staleKeys()).toBe(0);
    const full = await rowStore.openWindow(SID, PAGES * PAGE + PAGE);
    expect(full.messages.some((mm) => (mm.text ?? '').startsWith('STALE'))).toBe(false);
    expect(full.messages[full.messages.length - 1].text).toBe('r' + (PAGES * PAGE - 1));
    expect(rowStore.highestHeldSeq(SID)).toBe(PAGES * PAGE - 1); // 4999

    // A second identical attach-ok sees a sound axis and no-ops (one purge total).
    fire('attachOk', coldTail());
    await drain();
    expect(purgeSpy).toHaveBeenCalledTimes(1);
    expect(rowStore.highestHeldSeq(SID)).toBe(PAGES * PAGE - 1);
    purgeSpy.mockRestore();
  });
});

describe('the stale-axis heal over a DEAD slow link (real wiring): the heal must never blank a chat it cannot refetch', () => {
  test('a stale attach-ok that carries no admittable tail never blanks the chat over a dead link, and a later tail-carrying attach-ok heals it, served tail projecting even though every fetchPage rejects', async () => {
    vi.useFakeTimers();
    // The async (durable) backing models the real IndexedDB commit, and every
    // background page fetch rejects: the dead 4G link (TimeoutError / tunnel:
    // pipe closed) the phone hit. This is the live-rig gap: the rig only tested a
    // cold device (instant localhost refetch), never a device healing live over a
    // lossy link, so it never saw that the heal is net-harmful when the refetch
    // cannot complete.
    rowStore.__setBackingForTest(asyncMemTx().tx);
    const {fire} = wire(() => Promise.reject(new Error('tunnel: pipe closed')));
    const s = mkSession('p1');

    const staleBase = 13261;
    await seedStaleAxis(staleBase);
    await vi.advanceTimersByTimeAsync(1); // commit the seed durably
    await openChatWindow(SID);
    // The cached rows ARE on screen: this is the phone's 'count=16' paint.
    const shownAtOpen = (s.messages as CycEngineMessage[]).length;
    expect(shownAtOpen).toBeGreaterThan(0);

    // The phone's heal-firing attach-ok: the stale-high frontier (highestHeldSeq
    // sits ABOVE the engine tail) told the engine the device was already ahead,
    // so the delta carried deltaBase bookkeeping but NO pages. On f014a29 the
    // heal purges the visible rows and, with the backfill link dead, can never
    // refetch them: the chat goes 16 -> 0 and stays empty ('No messages here
    // yet'). The fix keeps the rows: a stale ordering beats an empty chat.
    fire('attachOk', {
      id: 'p1',
      known: true,
      pageSize: PAGE,
      total: PAGES * PAGE,
      tailPage: PAGES - 1,
      pointerPage: PAGES - 1,
      deltaBase: staleBase - PAGE,
      pages: []
    });
    await drain();
    // NEVER blanked: the pre-existing rows are still on screen despite the dead
    // link (the assertion f014a29 fails: purge left it empty and fetch could not
    // refill it).
    expect((s.messages as CycEngineMessage[]).length).toBe(shownAtOpen);

    // A later attach-ok DOES carry the authoritative tail inline (the engine's
    // axis guard serves the cold tail once it sees the axis mismatch). The heal
    // now admits and projects that served tail IMMEDIATELY, and it stays visible
    // even though the backfill of older pages keeps rejecting: best-effort
    // backfill must never blank the window. Track every paint across the heal:
    // purge -> admit-served-tail -> project is atomic, so no paint on the way
    // ever shows an empty window (the phone's count=0 between purge and admit).
    const paints: number[] = [];
    const off = rowStore.onChange(() => paints.push((s.messages as CycEngineMessage[]).length));
    fire('attachOk', coldTail());
    await drain();
    off();
    expect(paints.length).toBeGreaterThan(0);
    expect(Math.min(...paints)).toBeGreaterThan(0);
    const projected = rowStore.projection(SID).messages;
    expect(projected.length).toBeGreaterThan(0);
    expect(projected.some((mm) => (mm.text ?? '').startsWith('STALE'))).toBe(false);
    expect(projected[projected.length - 1].text).toBe('r' + (PAGES * PAGE - 1));
    expect(rowStore.highestHeldSeq(SID)).toBe(PAGES * PAGE - 1); // 4999, the real axis
  });
});

describe('a stale attach-ok that carries NO served tail (real wiring): keep the rows, do not purge to empty', () => {
  test('a pages-less stale attach-ok leaves the existing rows visible; a later attach-ok WITH the tail heals', async () => {
    vi.useFakeTimers();
    const {fire} = wire();
    const s = mkSession('p1');

    const staleBase = 13261;
    await seedStaleAxis(staleBase);
    await openChatWindow(SID);
    const before = rowStore.projection(SID).messages.length;
    expect(before).toBeGreaterThan(0); // the stale rows ARE on screen

    const purgeSpy = vi.spyOn(rowStore, 'purge');

    // A stale attach-ok that carries NO tail inline (an empty delta): purging now
    // would blank the chat with nothing to replace the rows with. Keep them.
    fire('attachOk', {
      id: 'p1',
      known: true,
      pageSize: PAGE,
      total: PAGES * PAGE,
      tailPage: PAGES - 1,
      pointerPage: PAGES - 1,
      pages: []
    });
    await drain();

    expect(purgeSpy).not.toHaveBeenCalled();
    expect(rowStore.projection(SID).messages.length).toBe(before);
    expect(rowStore.highestHeldSeq(SID)).toBe(staleBase + PAGE - 1); // still 13360
    void s;

    // A later attach-ok that DOES carry the served tail performs the heal.
    fire('attachOk', coldTail());
    await drain();
    expect(purgeSpy).toHaveBeenCalledTimes(1);

    const full = await rowStore.openWindow(SID, PAGES * PAGE + PAGE);
    expect(full.messages.some((mm) => (mm.text ?? '').startsWith('STALE'))).toBe(false);
    expect(full.messages[full.messages.length - 1].text).toBe('r' + (PAGES * PAGE - 1));
    expect(rowStore.highestHeldSeq(SID)).toBe(PAGES * PAGE - 1); // 4999
    purgeSpy.mockRestore();
  });
});

describe('CONCURRENCY (real wiring): two overlapping stale attach-oks do not defeat the heal', () => {
  test('two feedAttachOk fired without awaiting the first (both stale-axis) purge ONCE, drop the stale axis, and project the served tail (not empty)', async () => {
    vi.useFakeTimers();
    // The async (deferred-commit) backing: on the unserialized HEAD the two runs
    // interleave, so run B's openWindow/upsert reloads the warm mirror FROM a
    // durable backing whose delete from run A has not committed yet, resurrecting
    // the stale axis, and the served tail one run admits is clobbered by the
    // other. Net (the live rig): heldTail stays stale and the window projects
    // empty. The sync memTx cannot expose this; serialization is what fixes it.
    const {db} = ((): {db: Map<string, {key: string}>} => {
      const made = asyncMemTx();
      rowStore.__setBackingForTest(made.tx);
      return {db: made.db};
    })();
    wire(); // registers the conn feedAttachOk's replicator fetches through
    mkSession('p1');

    const staleBase = 13261;
    await seedStaleAxis(staleBase);
    await vi.advanceTimersByTimeAsync(1); // commit the seed durably
    const staleKeys = () => [...db.keys()].filter((k) => k.includes('|r|m:stale-')).length;
    expect(staleKeys()).toBe(PAGE);

    await openChatWindow(SID);
    expect(rowStore.highestHeldSeq(SID)).toBe(staleBase + PAGE - 1); // 13360

    const purgeSpy = vi.spyOn(rowStore, 'purge');

    // Fire TWO attach-oks for the SAME session WITHOUT awaiting the first: the
    // catchup-tick flood. On HEAD both runs interleave and the heal is defeated.
    const p1 = feedAttachOk(SID, KEY, 'p1', attachLite());
    const p2 = feedAttachOk(SID, KEY, 'p1', attachLite());
    await drain();
    await Promise.all([p1, p2]);
    await drain();
    expect(running(SID)).toBe(false);

    // Exactly ONE purge: the second run, serialized after the first, sees a sound
    // axis (highestHeldSeq <= tailVersion, no unseqed/mid-less rows) and no-ops.
    expect(purgeSpy).toHaveBeenCalledTimes(1);

    // The stale axis is gone from BOTH the durable backing and the mirror, not
    // resurrected by a racing reload.
    expect(staleKeys()).toBe(0);
    expect(rowStore.staleRowReason(SID)).toBeNull();

    // The served tail projects: the window is NOT empty (the live-rig symptom),
    // and it shows the real engine tail, not the stale axis.
    const full = await rowStore.openWindow(SID, PAGES * PAGE + PAGE);
    expect(full.messages.length).toBeGreaterThan(0);
    expect(full.messages.some((mm) => (mm.text ?? '').startsWith('STALE'))).toBe(false);
    expect(full.messages[full.messages.length - 1].text).toBe('r' + (PAGES * PAGE - 1));

    // highestHeldSeq <= tailVersion: the device can never wedge above the axis.
    const tailVersion = PAGES * PAGE; // 5000
    expect(rowStore.highestHeldSeq(SID)).toBe(PAGES * PAGE - 1); // 4999
    expect(rowStore.highestHeldSeq(SID)).toBeLessThanOrEqual(tailVersion);
    purgeSpy.mockRestore();
  });

  test('N concurrent stale attach-oks run the heal at most twice (once + one coalesced), never N times', async () => {
    vi.useFakeTimers();
    rowStore.__setBackingForTest(asyncMemTx().tx);
    wire();
    mkSession('p1');

    await seedStaleAxis(13261);
    await vi.advanceTimersByTimeAsync(1);
    await openChatWindow(SID);

    const purgeSpy = vi.spyOn(rowStore, 'purge');

    // Fire N (>= 3) attach-oks for the SAME session at once, none awaited: the
    // catchup-tick flood at its worst.
    const N = 5;
    const runs = Array.from({length: N}, () => feedAttachOk(SID, KEY, 'p1', attachLite()));
    await drain();
    await Promise.all(runs);
    await drain();
    expect(running(SID)).toBe(false);

    // The chain is bounded: one run in flight plus at most ONE coalesced run on
    // the newest attach-ok. N concurrent attach-oks therefore run the heal at
    // most twice, never N times (the un-serialized HEAD ran it N times).
    expect(__attachOkRunsForTest()).toBeLessThanOrEqual(2);
    // And the destructive part happened exactly once: the coalesced trailing run
    // sees a sound axis and no-ops.
    expect(purgeSpy).toHaveBeenCalledTimes(1);

    // The heal still stuck: the served tail projects and no stale row survives.
    const full = await rowStore.openWindow(SID, PAGES * PAGE + PAGE);
    expect(full.messages.some((mm) => (mm.text ?? '').startsWith('STALE'))).toBe(false);
    expect(full.messages[full.messages.length - 1].text).toBe('r' + (PAGES * PAGE - 1));
    purgeSpy.mockRestore();
  });
});

describe('the heal covers already-migrated legacy rows: unseqed and mid-less', () => {
  test('unseqed (seq < 0) rows wall the window: they are purged, the tail projects, and the heal fires ONCE', async () => {
    vi.useFakeTimers();
    const {fire} = wire();
    mkSession('p1');

    // Legacy rows the old migration imported with no seq (seq -1): they sort at
    // the tail (Infinity) and wall the newest window, so the chat rendered EMPTY.
    const unseqed = Array.from({length: 20}, (_, i) =>
      messageRow(SID, {
        id: 800000 + i,
        role: 'claude',
        kind: 'text',
        text: 'UNSEQED' + i,
        ts: 500000 + i,
        mid: 'unseqed-' + i // has a mid, but no seq
      } as unknown as CycEngineMessage)
    );
    await rowStore.upsert(SID, unseqed);
    await openChatWindow(SID);
    // no committed seq is held: the axis check alone would miss this
    expect(rowStore.highestHeldSeq(SID)).toBe(-1);

    const purgeSpy = vi.spyOn(rowStore, 'purge');
    fire('attachOk', coldTail());
    await drain();
    expect(running(SID)).toBe(false);

    const full = await rowStore.openWindow(SID, PAGES * PAGE + PAGE);
    expect(full.messages.some((mm) => (mm.text ?? '').startsWith('UNSEQED'))).toBe(false);
    expect(full.messages[full.messages.length - 1].text).toBe('r' + (PAGES * PAGE - 1));
    expect(rowStore.highestHeldSeq(SID)).toBe(PAGES * PAGE - 1);

    // A second identical attach-ok does not re-fire: one heal only.
    fire('attachOk', coldTail());
    await drain();
    expect(purgeSpy).toHaveBeenCalledTimes(1);
    purgeSpy.mockRestore();
  });

  test('a mid-less legacy row TWINS the engine re-serve WITH a mid: after the heal exactly one row projects', async () => {
    vi.useFakeTimers();
    const {fire} = wire();
    mkSession('p1');

    // A legacy row for tail message index 0 (text r4900) with NO mid: its
    // durable id is m@4900|claude|r4900. The engine's tail page carries the same
    // message WITH mid mr-4900, so without the heal the store holds BOTH (a
    // double). The mid-less row's seq (4900) is a real seq, so only the mid-less
    // predicate catches it.
    const twin = legacyMidlessRowOfTailMsg(0);
    await rowStore.upsert(SID, [twin]);
    await openChatWindow(SID);

    fire('attachOk', coldTail());
    await drain();
    expect(running(SID)).toBe(false);

    const full = await rowStore.openWindow(SID, PAGES * PAGE + PAGE);
    const r4900 = full.messages.filter((mm) => mm.text === 'r4900');
    expect(r4900).toHaveLength(1); // exactly one, no twin
    expect(r4900[0].mid).toBe('mr-4900'); // the engine's re-served row won
  });
});

describe('a pending isLocalOnly send survives every heal and settles by cid', () => {
  test('the stuck send is never lost across two heals, the real tail projects, and its echo settles it once', async () => {
    vi.useFakeTimers();
    // The async (durable) backing again: on the unfixed heal the purge does not
    // stick, so the real tail never projects. The pending send must survive that
    // AND the served tail must appear once the heal is fixed.
    rowStore.__setBackingForTest(asyncMemTx().tx);
    const {fire} = wire();
    const s = mkSession('p1');

    const staleBase = 13261;
    const stale = Array.from({length: PAGE}, (_, i) =>
      messageRow(SID, {
        id: 999000 + i,
        role: 'claude',
        kind: 'text',
        text: 'STALE' + i,
        ts: 900000 + i,
        seq: staleBase + i,
        mid: 'stale-' + i
      } as unknown as CycEngineMessage)
    );
    await rowStore.upsert(SID, stale);
    await vi.advanceTimersByTimeAsync(1); // commit the seed durably
    await openChatWindow(SID);

    // The user's own optimistic send, stuck 'sending': a local overlay on
    // s.messages, never a store row.
    const pending = {
      id: 424242,
      role: 'user',
      kind: 'text',
      text: 'my stuck send',
      ts: 950000,
      status: 'sending',
      cid: 'cid-mine'
    } as unknown as CycEngineMessage;
    (s.messages as CycEngineMessage[]).push(pending);

    // First heal.
    fire('attachOk', coldTail());
    await drain();
    expect((s.messages as CycEngineMessage[]).some((mm) => mm.cid === 'cid-mine')).toBe(true);

    // Second heal (identical attach-ok): the send still survives.
    fire('attachOk', coldTail());
    await drain();
    expect((s.messages as CycEngineMessage[]).some((mm) => mm.cid === 'cid-mine')).toBe(true);

    // The heal stuck: the served REAL tail projects (not the stale axis) with
    // the pending send still overlaid at the bottom.
    expect(
      (s.messages as CycEngineMessage[]).some((mm) => mm.text === 'r' + (PAGES * PAGE - 1))
    ).toBe(true);
    expect(
      (s.messages as CycEngineMessage[]).some((mm) => (mm.text ?? '').startsWith('STALE'))
    ).toBe(false);

    // The engine's echo for the send arrives with the same cid: it settles into
    // the store under its mid and the optimistic bubble is dropped, so the send
    // shows exactly once (no twin).
    fire('chat', {
      id: 'p1',
      role: 'user',
      text: 'my stuck send',
      ts: 950000,
      seq: PAGES * PAGE,
      mid: 'mr-mine',
      cid: 'cid-mine'
    });
    await micro();
    const mine = (s.messages as CycEngineMessage[]).filter((mm) => mm.cid === 'cid-mine');
    expect(mine).toHaveLength(1);
    expect(mine[0].status).not.toBe('sending'); // settled, not the stuck bubble
  });
});

describe('repaint on every catchup tick (real wiring): the flash', () => {
  test('two identical consecutive attach-oks produce exactly one window repaint', async () => {
    vi.useFakeTimers();
    const {fire} = wire();
    const s = mkSession('p1');
    // Steady state: the whole history is already stored and the open window holds
    // its full tail (this is the device the catchup ticks flash on).
    for (let n = 0; n < PAGES; n++) await rowStore.upsert(SID, rowsOfPage(n));
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);

    // Count every repaint of the open chat: the door reassigns s.messages ONLY
    // when the projected window changed, and that fresh array is the flash the
    // renderer would paint. The chat handler's own unconditional notify() never
    // reassigns s.messages, so a re-attach that changes nothing is a no-op here.
    let paints = 0;
    let backing = s.messages;
    Object.defineProperty(s, 'messages', {
      configurable: true,
      get: () => backing,
      set: (v) => {
        backing = v;
        paints++;
      }
    });

    const tick = () => ({
      id: 'p1',
      known: true,
      pageSize: PAGE,
      total: PAGES * PAGE,
      tailPage: PAGES - 1,
      pointerPage: PAGES - 1,
      pages: [page(PAGES - 1)]
    });

    // Tick 1: the catchup re-attach re-snaps the window and projects it once.
    // Drain the replicator (it re-commits already-held pages below the window
    // and repaints nothing).
    fire('attachOk', tick());
    await micro();
    for (let i = 0; i < PAGES + 5 && running(SID); i++) {
      await vi.advanceTimersByTimeAsync(600);
      await micro();
    }
    expect(paints).toBe(1); // the window projected once

    // Tick 2: an IDENTICAL periodic catchup re-attach, zero new data. Without
    // the door's unchanged-window guard this re-snapped and repainted, flashing
    // the open chat.
    fire('attachOk', tick());
    await micro();
    await vi.advanceTimersByTimeAsync(600);
    await micro();
    expect(paints).toBe(1); // no flash: the unchanged window did not repaint

    // Control (so the guard cannot pass vacuously): a genuinely new live row in
    // the window DOES repaint.
    fire('chat', {
      id: 'p1',
      role: 'claude',
      text: 'brand new',
      ts: PAGES * PAGE,
      seq: PAGES * PAGE,
      mid: 'mr-new'
    });
    await micro();
    expect(paints).toBe(2);
  });
});

// DEFECT 2: an open chat whose store believed nothing was open. On a fresh
// device the chat opens BEFORE the owner connection is up, so store.ts attach
// returned before it ever marked the store open; a live row that arrived once
// the wire connected then logged open=false touches=false changed=true
// paints=false and NEVER painted. attach now marks the store open (and projects
// any stored rows) the instant it runs, owner or not, and detachChat closes it.
describe('the open chat the store believed was closed (defect 2, real wiring)', () => {
  test('attach with no owner yet marks the store open and projects stored rows; a live row once the wire connects paints', async () => {
    const s = mkSession('p1');
    // rows already on the device (a warm or migrated session)
    await rowStore.upsert(SID, [
      messageRow(SID, {
        id: 1,
        role: 'claude',
        kind: 'text',
        text: 'stored one',
        ts: 1,
        seq: 1,
        mid: 'mr-1'
      } as unknown as CycEngineMessage),
      messageRow(SID, {
        id: 2,
        role: 'claude',
        kind: 'text',
        text: 'stored two',
        ts: 2,
        seq: 2,
        mid: 'mr-2'
      } as unknown as CycEngineMessage)
    ]);

    // the chat opens on a fresh device BEFORE the owner connection exists.
    expect(conns.some((c) => c.key === KEY)).toBe(false);
    attach(SID);
    await micro();

    // the store's open session tracks the UI's open chat even with no owner...
    expect(rowStore.isOpen(SID)).toBe(true);
    // ...and the open projected the already-stored rows immediately.
    expect((s.messages as CycEngineMessage[]).map((m) => m.text)).toEqual([
      'stored one',
      'stored two'
    ]);

    // now the wire connects and delivers a live row through the SAME real chat
    // handler the wire uses. On 5f7a9e2 the store believed nothing was open, so
    // this persisted durably and never painted; here it paints.
    let paints = 0;
    const off = rowStore.onChange((sid) => {
      if (sid === SID) paints++;
    });
    const {fire} = wire();
    fire('chat', {id: 'p1', role: 'claude', text: 'live now', ts: 3, seq: 3, mid: 'mr-3'});
    await micro();
    expect(paints).toBe(1);
    expect((s.messages as CycEngineMessage[]).some((m) => m.text === 'live now')).toBe(true);
    off();

    // closing the chat closes the store's open session too.
    detachChat();
    expect(rowStore.isOpen(SID)).toBe(false);
  });
});

describe('backfilled history renders unique per-message ids (regression: session-id leak)', () => {
  test('after a cold attach + full backfill every projected message render id is unique, none the session id', async () => {
    vi.useFakeTimers();
    const {fire} = wire();
    mkSession('p1');
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, PAGE);

    fire('attachOk', {
      id: 'p1',
      known: true,
      pageSize: PAGE,
      total: PAGES * PAGE,
      tailPage: PAGES - 1,
      pointerPage: PAGES - 1,
      pages: [page(PAGES - 1)]
    });
    await micro();
    for (let i = 0; i < PAGES + 5 && running(SID); i++) {
      await vi.advanceTimersByTimeAsync(600);
      await micro();
    }
    expect(running(SID)).toBe(false);

    // load the WHOLE backfilled history into the window and inspect every
    // rendered id (the id messageList writes as data-mid, keyed on by
    // messageMenu, touchSelection, messageTravel, carryStillImages).
    const proj = await rowStore.openWindow(SID, PAGES * PAGE);
    expect(proj.messages).toHaveLength(PAGES * PAGE);
    const ids = proj.messages.map((mm) => mm.id);
    expect(ids as unknown[]).not.toContain(SID);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// One page carrying exactly the given messages, as store rows minted the way the
// replicator mints a real page admit. The wire `id` is the session id (the
// engine reuses it as the attach key); rowsFromPage mints a fresh render id.
function admitPage(msgs: Array<Record<string, unknown>>): Promise<unknown> {
  const pg = {
    page: 0,
    version: 100,
    sealed: true,
    messages: msgs.map((mm) => ({id: SID, kind: 'text', ...mm})),
    events: []
  } as unknown as EnginePage;
  return rowStore.upsert(SID, rowsFromPage(SID, pg));
}

// THE DOUBLE-MESSAGE DEFECT (the owner's daily "same message twice"), on a CLEAN
// store, NOT the migration case: a message settles or lands under its fallback
// id (its live frame carried no mid yet), then the SAME message is re-served WITH
// its mid and lands under a DIFFERENT durable id, so upsert-by-id twins it. The
// door folds the mid arrival into the incumbent instead. Proven failing on
// 7c79a0a (each is two rows there), passing after.
describe('the double-message defect (real wiring): a mid arrival folds into its mid-less incumbent', () => {
  test('own send: a pending cid settles via an echo WITHOUT mid, then the page admit carries the mid: one row, render id and delivered kept', async () => {
    const {fire} = wire();
    const s = mkSession('p1');
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);

    // The user's optimistic bubble: a local overlay on s.messages, its one
    // durable id keyed by cid (m:c:c-own), status sending.
    const pending = {
      id: 'm:c:c-own',
      role: 'user',
      kind: 'text',
      text: 'own hello',
      ts: 200,
      status: 'sending',
      cid: 'c-own'
    } as unknown as CycEngineMessage;
    (s.messages as CycEngineMessage[]).push(pending);

    // The engine's LIVE echo of the fresh send, arriving BEFORE a mid is minted:
    // it settles the bubble into the store under the fallback id (no mid).
    fire('chat', {id: 'p1', role: 'user', text: 'own hello', ts: 200, seq: 7, cid: 'c-own'});
    await micro();
    const settled = rowStore.projection(SID).messages.filter((m) => m.text === 'own hello');
    expect(settled).toHaveLength(1);
    expect(settled[0].mid).toBeUndefined();
    expect(settled[0].status).toBe('delivered');
    expect(settled[0].id).toBe('m:c:c-own');

    // Seconds later the SAME message is re-served WITH its mid via a page admit,
    // carrying the SAME cid the engine persists on the row: the id stays the ONE
    // cid-keyed name, so it is one row updated in place, never a twin.
    await admitPage([
      {role: 'user', text: 'own hello', ts: 200, seq: 7, mid: 'mr-own', cid: 'c-own'}
    ]);
    await micro();

    const rows = rowStore.projection(SID).messages.filter((m) => m.text === 'own hello');
    expect(rows).toHaveLength(1); // not twinned
    expect(rows[0].mid).toBe('mr-own'); // the engine mid rode in on the re-serve
    expect(rows[0].id).toBe('m:c:c-own'); // the ONE cid-keyed id never changed
    expect(rows[0].status).toBe('delivered'); // the settled delivery mark survived
  });

  test('foreign message: a live frame WITHOUT mid, then the paged copy WITH mid: one row', async () => {
    const {fire} = wire();
    mkSession('p1');
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);

    // Another device's row, live, before a mid: lands under the fallback id.
    fire('chat', {id: 'p1', role: 'claude', text: 'foreign reply', ts: 300, seq: 8});
    await micro();
    expect(
      rowStore.projection(SID).messages.filter((m) => m.text === 'foreign reply')
    ).toHaveLength(1);

    // The paged copy of the same row, now carrying its mid.
    await admitPage([{role: 'claude', text: 'foreign reply', ts: 300, seq: 8, mid: 'mr-foreign'}]);
    await micro();

    const rows = rowStore.projection(SID).messages.filter((m) => m.text === 'foreign reply');
    expect(rows).toHaveLength(1);
    expect(rows[0].mid).toBe('mr-foreign');
  });

  test('two DIFFERENT messages with identical (ts, role, text) but different mids stay two rows (no false merge)', async () => {
    mkSession('p1');
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);

    await admitPage([{role: 'claude', text: 'same words', ts: 400, seq: 10, mid: 'mA'}]);
    await admitPage([{role: 'claude', text: 'same words', ts: 400, seq: 11, mid: 'mB'}]);
    await micro();

    const rows = rowStore.projection(SID).messages.filter((m) => m.text === 'same words');
    expect(rows).toHaveLength(2); // both carry a mid: never merged
    expect(rows.map((r) => r.mid).sort()).toEqual(['mA', 'mB']);
  });

  test('the upload case: an attach send whose echo lacks mid, then the mid copy: one row, upload payload intact', async () => {
    const {fire} = wire();
    const s = mkSession('p1');
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);

    const upload = {
      uploadId: 'u1',
      name: 'photo.jpg',
      mime: 'image/jpeg',
      size: 1234,
      path: '/tmp/photo.jpg',
      image: true
    };
    // The optimistic attach bubble carries the upload payload.
    const pending = {
      id: 'm:c:c-up',
      role: 'user',
      kind: 'text',
      text: 'photo',
      ts: 500,
      status: 'sending',
      cid: 'c-up',
      upload
    } as unknown as CycEngineMessage;
    (s.messages as CycEngineMessage[]).push(pending);

    // The echo settles the bubble WITHOUT a mid; the upload payload stays on it.
    fire('chat', {id: 'p1', role: 'user', text: 'photo', ts: 500, seq: 12, cid: 'c-up'});
    await micro();
    const settled = rowStore.projection(SID).messages.filter((m) => m.text === 'photo');
    expect(settled).toHaveLength(1);
    expect(settled[0].upload?.uploadId).toBe('u1');

    // The page admit re-serves the row WITH its mid but WITHOUT the upload payload
    // (the engine page does not carry the local attach blob).
    await admitPage([{role: 'user', text: 'photo', ts: 500, seq: 12, mid: 'mr-up', cid: 'c-up'}]);
    await micro();

    const rows = rowStore.projection(SID).messages.filter((m) => m.text === 'photo');
    expect(rows).toHaveLength(1); // not twinned
    expect(rows[0].mid).toBe('mr-up');
    expect(rows[0].upload?.uploadId).toBe('u1'); // the upload payload survived the update
    expect(rows[0].id).toBe('m:c:c-up'); // the ONE cid-keyed id never changed
  });
});

// THE REVERSE TWIN (the defect the fold's forward-only shape left on the real
// path): the mid copy of a send lands FIRST (a page re-serve, or a live echo
// that already carried the mid), so its m:pending:cid row is folded/gone, and
// then a mid-LESS arrival for the SAME send follows (settleEcho re-settling on
// the transfer-ack path, or a second echo). On 5f7a9e2 the mid-less arrival is
// inserted beside the mid row (status sent, seq -1) and the DOM paints data-mid
// twice; the reverse fold merges it into the mid row instead. Proven failing on
// 5f7a9e2 (two rows there), passing after.
describe('the reverse twin (real wiring): a mid-less arrival folds into its mid-bearing incumbent', () => {
  test('own send: the first echo folds the pending under the mid, then a second mid-less echo settles again: one row', async () => {
    const {fire} = wire();
    const s = mkSession('p1');
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);

    // The user's optimistic bubble: a local overlay on s.messages, keyed by cid.
    (s.messages as CycEngineMessage[]).push({
      id: 'm:c:c-own',
      role: 'user',
      kind: 'text',
      text: 'own hello',
      ts: 200,
      status: 'sending',
      cid: 'c-own'
    } as CycEngineMessage);

    // The engine's first live echo carries the mid: it folds the pending bubble
    // and settles it into the store under the mid id (one delivered mid row).
    fire('chat', {
      id: 'p1',
      role: 'user',
      text: 'own hello',
      ts: 200,
      seq: 97109,
      mid: 'mr-own',
      cid: 'c-own'
    });
    await micro();
    expect(rowStore.projection(SID).messages.filter((m) => m.text === 'own hello')).toHaveLength(1);

    // A SECOND echo of the same send arrives WITHOUT a mid (the transfer-ack
    // path): the bubble now carries a dedupeKey, so it is not re-matched as the
    // pending send and the handler writes it under the fallback id, whose
    // m:pending:c-own row is already gone. On 5f7a9e2 that is a mid-less twin
    // (seq -1) beside the mid row; the reverse fold merges it into the mid row.
    fire('chat', {id: 'p1', role: 'user', text: 'own hello', ts: 200, cid: 'c-own'});
    await micro();

    const rows = rowStore.projection(SID).messages.filter((m) => m.text === 'own hello');
    expect(rows).toHaveLength(1); // not twinned (was 2 on 5f7a9e2)
    expect(rows[0].mid).toBe('mr-own'); // the mid row survived
    expect(rows[0].cid).toBe('c-own');
  });

  test('two DIFFERENT sends sharing (ts, role, text) but different cids stay two rows (no false merge)', async () => {
    const {fire} = wire();
    mkSession('p1');
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);

    // Message A: a live user row with NO mid and cid cA (lands under the fallback
    // id, dedupeKey ts|role|text).
    fire('chat', {id: 'p1', role: 'user', text: 'same words', ts: 400, seq: 20, cid: 'cA'});
    await micro();
    // Message B: a genuinely DIFFERENT send, the SAME ts/role/text, WITH a mid
    // and a DIFFERENT cid. On 5f7a9e2 the fold's bare (ts,role,text) bridge
    // collapses them into one row (message A discarded); the cid disagreement
    // now disqualifies that bridge.
    await admitPage([{role: 'user', text: 'same words', ts: 400, seq: 21, mid: 'mB', cid: 'cB'}]);
    await micro();

    const rows = rowStore.projection(SID).messages.filter((m) => m.text === 'same words');
    expect(rows).toHaveLength(2); // both survive (was 1 on 5f7a9e2: a silent data loss)
    expect(rows.some((r) => r.mid === 'mB')).toBe(true);
    expect(rows.some((r) => !r.mid && r.cid === 'cA')).toBe(true);
  });
});

// THE ROOT OF THE DOUBLE MESSAGE (the owner's daily "same message twice"), proven
// on a live two-client rig with per-write logging: the user's own optimistic send
// was persisted to the durable store as a mid-LESS, dedupeKey-LESS, status-'sent'
// row under the VOLATILE fallback id m@<clientTs>|user|<text>. Later the engine
// re-served the SAME message as the authoritative copy carrying a mid, a dedupeKey
// and a SERVER ts (different from the client ts). The twin fold could not bridge
// the two (the re-serve carries no client-only cid, the persisted optimistic row
// carries no dedupeKey, and the client vs server ts make the fallback ids differ),
// so BOTH rendered. cacheTail (and every other in-place patch: an ack promoting
// the bubble to sent, a queued-flag release) leaked the optimistic bubble into the
// store; the door now refuses it. An optimistic send settles into the store the
// one right way, keyed by the engine's durable id via adoptEngineRow + settleEcho.
// Proven failing on c1b223e (two rows / an orphan stored), passing after.
describe('the double-message ROOT (real wiring): an optimistic send never reaches the durable store', () => {
  test('cacheTail does NOT persist an unsettled optimistic send under a fallback id', async () => {
    mkSession('p1');
    const s = sessions.get(SID)!;
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);

    // An engine-confirmed voice row, already a durable store row and in the
    // projection: its later settle is cacheTail's real job (see the next test).
    const voice = {
      id: 42,
      role: 'user',
      kind: 'voice',
      text: 'note',
      ts: 50,
      status: 'delivered',
      mid: 'mr-v',
      dedupeKey: 'mid:mr-v',
      durationS: 2
    } as unknown as CycEngineMessage;
    await rowStore.upsert(SID, [messageRow(SID, voice)]);
    (s.messages as CycEngineMessage[]).push(voice);

    // The user's own optimistic text send: an s.messages overlay only, no mid and
    // no dedupeKey (the engine has not confirmed it), keyed by cid.
    (s.messages as CycEngineMessage[]).push({
      id: 99,
      role: 'user',
      kind: 'text',
      text: 'stuck send',
      ts: 100,
      status: 'sending',
      cid: 'c-opt'
    } as unknown as CycEngineMessage);

    // A voice note settles: markVoiceNoteSafe runs the REAL wired cacheTail over
    // every s.messages entry (this is store.ts:cacheTail, the proven writer).
    markVoiceNoteSafe(SID, 'no-such-row', 'msg-42', 3);
    await micro();

    // The optimistic send is NOT a durable row under the fallback id (nor any).
    const stored = rowStore.projection(SID).messages;
    expect(stored.some((m) => m.text === 'stuck send')).toBe(false);
    expect(rowStore.__mirror(SID)!.idx.some((t) => t.id === 'm@100|user|stuck send')).toBe(false);
  });

  test("a genuine voice-note-settle mutation still persists (cacheTail's real job)", async () => {
    mkSession('p1');
    const s = sessions.get(SID)!;
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);

    // An engine-confirmed voice row (a mid, a dedupeKey): a real durable row.
    const voice = {
      id: 'm:mr-v',
      role: 'user',
      kind: 'voice',
      text: 'note',
      ts: 50,
      status: 'delivered',
      mid: 'mr-v',
      dedupeKey: 'mid:mr-v',
      durationS: 2
    } as unknown as CycEngineMessage;
    await rowStore.upsert(SID, [messageRow(SID, voice)]);
    (s.messages as CycEngineMessage[]).push(voice);

    // The clip is safe on the engine: the settle stamps the msgId. cacheTail
    // persists that mutation on the already-durable row (its real job).
    markVoiceNoteSafe(SID, 'm:mr-v', 'msg-42', 3);
    await micro();

    const row = rowStore.projection(SID).messages.find((m) => m.mid === 'mr-v');
    expect(row?.msgId).toBe('msg-42');
  });

  test('full send lifecycle: optimistic, ack, echo without mid, then re-serve with mid at a server ts: ONE cid-keyed id, delivered kept', async () => {
    const {fire} = wire();
    const s = mkSession('p1');
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);

    // The optimistic bubble: an s.messages overlay, its one durable id keyed by
    // cid (m:c:c-own), status sending, at the CLIENT ts (100).
    (s.messages as CycEngineMessage[]).push({
      id: 'm:c:c-own',
      role: 'user',
      kind: 'text',
      text: 'own hello',
      ts: 100,
      status: 'sending',
      cid: 'c-own'
    } as unknown as CycEngineMessage);

    // The engine acks it (delivery-blind): on c1b223e the ack's own patchMessage
    // wrote the optimistic bubble to the store under m@100|user|own hello; the
    // door now refuses that write, so the send stays overlay-only.
    fire('ack', {id: 'p1', cid: 'c-own'});
    expect(rowStore.projection(SID).messages.some((m) => m.text === 'own hello')).toBe(false);

    // The engine's LIVE echo of the send, WITHOUT a mid yet, carrying the cid, at
    // the engine's SERVER ts (200, not the client's 100): it settles the bubble
    // into the store under the fallback id (mid-less) and stamps its dedupeKey.
    fire('chat', {id: 'p1', role: 'user', text: 'own hello', ts: 200, seq: 7, cid: 'c-own'});
    await micro();
    const settled = rowStore.projection(SID).messages.filter((m) => m.text === 'own hello');
    expect(settled).toHaveLength(1);
    expect(settled[0].mid).toBeUndefined();
    expect(settled[0].status).toBe('delivered');
    expect(settled[0].id).toBe('m:c:c-own');
    expect(settled[0].dedupeKey).toBeTruthy();

    // Later the SAME message is re-served WITH its mid, at the server ts, carrying
    // the SAME cid the engine persists on every user row. The id is the one
    // cid-keyed name throughout, so the re-serve updates that one row in place
    // (the engine mid rides in) instead of twinning it.
    await admitPage([
      {role: 'user', text: 'own hello', ts: 200, seq: 8, mid: 'mr-own', cid: 'c-own'}
    ]);
    await micro();

    const rows = rowStore.projection(SID).messages.filter((m) => m.text === 'own hello');
    expect(rows).toHaveLength(1);
    expect(rows[0].mid).toBe('mr-own'); // the engine mid rode in on the re-serve
    expect(rows[0].id).toBe('m:c:c-own'); // the ONE cid-keyed id never changed
    expect(rows[0].status).toBe('delivered'); // the settled delivery mark survived
  });

  test('VERIFY4 still holds: two DIFFERENT sends sharing (ts, role, text) with different cids stay two rows', async () => {
    const {fire} = wire();
    mkSession('p1');
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);

    // Send A: a live user row with NO mid and cid cA (fallback id, dedupeKey
    // ts|role|text).
    fire('chat', {id: 'p1', role: 'user', text: 'same words', ts: 400, seq: 20, cid: 'cA'});
    await micro();
    // Send B: a genuinely DIFFERENT send, the SAME ts/role/text, WITH a mid and a
    // DIFFERENT cid. The cid disagreement disqualifies the ts|role|text bridge, so
    // the two stay two rows (no silent data loss).
    await admitPage([{role: 'user', text: 'same words', ts: 400, seq: 21, mid: 'mB', cid: 'cB'}]);
    await micro();

    const rows = rowStore.projection(SID).messages.filter((m) => m.text === 'same words');
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.mid === 'mB')).toBe(true);
    expect(rows.some((r) => !r.mid && r.cid === 'cA')).toBe(true);
  });
});

// An owner conn whose client records every attach() the wire-facing replay makes,
// so a test can prove that step is (or is not) reached. Unlike wire() this carries
// the attach spy askEngine calls; no wire frames are fired through it.
function ownerConn(): {attach: ReturnType<typeof vi.fn>} {
  const attachSpy = vi.fn();
  const client = {
    on: vi.fn(),
    fetchPage: vi.fn(async () => null),
    fetchSessionAgents: vi.fn(async () => []),
    attach: attachSpy,
    detach: vi.fn(),
    setSessionTail: vi.fn()
  };
  conns.push({key: KEY, client, state: 'connected'} as unknown as Conn);
  return {attach: attachSpy};
}

// THE FRESH OPEN SUPERSEDED BY THE RE-ATTACH FLOOD (defect, real wiring): the
// deferred open awaits migrationDone; while it is pending the client re-attaches
// many times a second (the catchup flood), each re-attach bumping the attach
// epoch. On c0274f0 the open gated its LOCAL projection on openSeq === attachSeq,
// so the flood superseded it before it ever called openChatWindow: the window was
// never opened and the fresh chat rendered EMPTY even as rows arrived (setOpen
// alone does not project). The local open is offline-first (one indexed read, no
// network) and must not be cancellable by the flood; only the wire-facing replay
// stays gated.
describe('the fresh open superseded by the re-attach flood (defect, real wiring)', () => {
  test('a burst of attach-epoch bumps while the deferred open is pending still opens the window; a later live row PAINTS', async () => {
    const s = mkSession('p1');
    // A fresh device, empty store, the chat visibly open (composer mounted): open
    // it onto the store.
    attach(SID);
    // The catchup flood lands while the deferred open still awaits migrationDone:
    // each re-attach bumps the epoch, keeping the SAME chat open.
    for (let i = 0; i < 8; i++) __setAttachedForTest(SID);
    await micro();

    // The window opened despite the flood (fail-before on c0274f0: superseded).
    expect(rowStore.isOpen(SID)).toBe(true);
    expect(rowStore.isWarm(SID)).toBe(true);

    // A live row delivered to the open fresh chat through the real handler PAINTS
    // (its window was opened, so the row is in-window). On c0274f0 no window was
    // ever opened, so the mirror's floor stayed Infinity and this painted nothing.
    let paints = 0;
    const off = rowStore.onChange((sid) => {
      if (sid === SID) paints++;
    });
    const {fire} = wire();
    fire('chat', {id: 'p1', role: 'claude', text: 'live now', ts: 3, seq: 3, mid: 'mr-3'});
    await micro();
    expect(paints).toBe(1);
    expect((s.messages as CycEngineMessage[]).some((m) => m.text === 'live now')).toBe(true);
    off();
    detachChat();
  });

  test('a live row delivered to the open fresh chat appears in s.messages', async () => {
    const s = mkSession('p1');
    attach(SID);
    await micro();
    expect(rowStore.isOpen(SID)).toBe(true);

    const {fire} = wire();
    fire('chat', {id: 'p1', role: 'claude', text: 'hello there', ts: 5, seq: 5, mid: 'mr-5'});
    await micro();
    expect((s.messages as CycEngineMessage[]).map((m) => m.text)).toContain('hello there');
    detachChat();
  });
});

// THE STALE-NETWORK-REPLAY GUARD (non-regression): the openSeq guard was moved
// OFF the local projection, but it must stay ON the wire-facing replay, or an
// older attach's askEngine, landing after a newer open, would replay a stale tail
// over it. Proven by driving the real attach() with an owner present: askEngine
// calls owner.client.attach, so the spy is the wire-facing step. A non-stale open
// reaches it; a flood-superseded open does not, yet its LOCAL open still ran.
describe('the stale-network-replay guard stays on the wire-facing replay (real wiring)', () => {
  test('an empty reachable open does not hold its first landing for replay', async () => {
    const s = mkSession('p1');
    ownerConn();
    attach(SID);

    // The view commits before the deferred local-window read. With no local
    // rows, it must be free to land at bottom rather than wait for the replay
    // watchdog.
    expect(s.historyPending).toBe(false);
    await micro();
    expect(s.historyPending).toBe(false);
    detachChat();
  });

  test('a non-stale open reaches the wire-facing replay (askEngine attaches the engine)', async () => {
    mkSession('p1');
    const {attach: engineAttach} = ownerConn();
    attach(SID);
    await micro();
    expect(engineAttach).toHaveBeenCalledTimes(1);
    detachChat();
  });

  test('a flood-superseded open does NOT replay over the newer open, yet its local open still projects', async () => {
    mkSession('p1');
    const {attach: engineAttach} = ownerConn();
    attach(SID);
    // The flood bumps the epoch past this open's openSeq before its deferred body
    // resumes.
    for (let i = 0; i < 6; i++) __setAttachedForTest(SID);
    await micro();
    // The wire-facing replay was superseded: the stale attach never re-attached
    // the engine, so a stale replay cannot paint over the newer open.
    expect(engineAttach).not.toHaveBeenCalled();
    // ...but the LOCAL, offline-first open still ran (the fix): the window opened.
    expect(rowStore.isWarm(SID)).toBe(true);
    detachChat();
  });
});

// A legacy Aug row that never carried a seq (seq < 0): it sorts at the tail
// (Infinity) and WALLS the newest window. A migrated device holds these.
function unseqedAugRow(i: number): ReturnType<typeof messageRow> {
  return messageRow(SID, {
    id: 810000 + i,
    role: 'claude',
    kind: 'text',
    text: 'AUG-unseq' + i,
    ts: 1786648000000 + i,
    mid: 'aug-unseq-' + i // has a mid, but no seq
  } as unknown as CycEngineMessage);
}

// A mid-less message row on a valid, ON-AXIS seq (0 <= seq <= the engine tail):
// exactly what the engine's own pre-mid chat files re-serve (real history whose
// lines predate mid minting). This is LEGITIMATE engine history, not poison: the
// heal must keep it, never purge it, never sanitise it away.
function onAxisMidlessRow(i: number): ReturnType<typeof messageRow> {
  return messageRow(SID, {
    id: 820000 + i,
    role: 'claude',
    kind: 'text',
    text: 'ONAXIS-midless' + i,
    // ts tracks the on-axis seq (the page fixture stamps ts = seq): a row that is
    // BELOW the engine tail by seq is also below it in time, so the ts-ordered
    // index (cmpTuple) keeps the engine tail newest, exactly as its seq says.
    ts: 4000 + i,
    seq: 4000 + i // a real, on-axis seq (below the 5000 engine tail), just no mid
    // no mid
  } as unknown as CycEngineMessage);
}

// The field mix: the engine's genuine tail page (mids, real seqs), PLUS unseqed
// Aug rows that wall the tail (the OFF-AXIS poison a read sanitises away), PLUS
// mid-less rows on real on-axis seqs (genuine pre-mid engine history that must
// SURVIVE). Only the unseqed rows are poison; the on-axis mid-less rows are real.
async function seedFieldPoison(): Promise<void> {
  const rows = [
    ...rowsOfPage(PAGES - 1),
    ...Array.from({length: 5}, (_, i) => unseqedAugRow(i)),
    ...Array.from({length: 5}, (_, i) => onAxisMidlessRow(i))
  ];
  await rowStore.upsert(SID, rows);
}

const engineTailText = 'r' + (PAGES * PAGE - 1);

describe('the stale-axis resurrect LOOP (real wiring): a second page must not write the poison back', () => {
  // The field defect: the owner opens a chat, sends, swipes out and back in, and
  // the stale-axis heal REFIRES on every attach, painting Aug rows 0.9s after the
  // purge. The single-context heal converges (the existing tests prove it); the
  // loop is a SECOND page on the same profile whose never-purged warm mirror
  // writes the poisoned idx straight back over the healed one, so this page reads
  // it back on the next open. The OFF-AXIS poison (unseqed wallers) is dropped on
  // read so the heal never refires; the on-axis mid-less engine rows are real
  // history and simply persist and paint. This is the exact resurrect path.
  test('a second page writing the poisoned idx back does NOT refire the heal: two attach-oks purge at most once and the engine tail projects', async () => {
    vi.useFakeTimers();
    const made = asyncMemTx();
    const db = made.db;
    rowStore.__setBackingForTest(made.tx);
    const {fire} = wire();
    mkSession('p1');

    await seedFieldPoison();
    await vi.advanceTimersByTimeAsync(1); // commit the poison durably

    // A second tab loaded this poisoned idx and holds it warm: capture the exact
    // durable records it would fire-and-forget write back on its next upsert.
    const idxRec = SID + '|idx';
    const pageBIdx = JSON.parse(JSON.stringify(db.get(idxRec)));
    const pageBRows = [...db.entries()]
      .filter(([k]) => k.startsWith(SID + '|r|'))
      .map(([k, v]) => [k, JSON.parse(JSON.stringify(v))] as const);
    const writeBackFromPageB = () => {
      db.set(idxRec, JSON.parse(JSON.stringify(pageBIdx)));
      for (const [k, v] of pageBRows) db.set(k, JSON.parse(JSON.stringify(v)));
    };

    // Item 4: the FIRST paint after open shows the engine-axis tail, never the
    // walled Aug tail (the unseqed rows sort at Infinity and would otherwise
    // wall the window). The on-axis mid-less engine rows are real history and are
    // kept: only the unseqed wallers are dropped.
    await openChatWindow(SID);
    const firstPaint = rowStore.projection(SID).messages;
    expect(firstPaint[firstPaint.length - 1].text).toBe(engineTailText);
    expect(firstPaint.some((mm) => (mm.text ?? '').startsWith('AUG-unseq'))).toBe(false);
    expect(firstPaint.some((mm) => (mm.text ?? '').startsWith('ONAXIS-midless'))).toBe(true);

    const purgeSpy = vi.spyOn(rowStore, 'purge');

    // Attach-ok #1 heals (or the open sanitise already cleaned the axis).
    fire('attachOk', coldTail());
    await drain();

    // The second page persists: its warm poison clobbers the durable idx and
    // re-puts the poison payloads.
    writeBackFromPageB();

    // The owner swipes out and back in: the mirror is evicted and re-read from
    // the durable backing the second page just poisoned.
    rowStore.setOpen(null);
    rowStore.close(SID);
    await openChatWindow(SID);

    // Attach-ok #2: on c1b14cb this refires the heal (a second purge, the loop);
    // the fix drops the write-back on read, so the axis is sound and no second
    // heal is needed.
    fire('attachOk', coldTail());
    await drain();

    expect(purgeSpy.mock.calls.length).toBeLessThanOrEqual(1);
    expect(rowStore.staleRowReason(SID)).toBeNull();
    const paint = rowStore.projection(SID).messages;
    expect(paint[paint.length - 1].text).toBe(engineTailText);
    expect(paint.some((mm) => (mm.text ?? '').startsWith('AUG-unseq'))).toBe(false);
    expect(paint.some((mm) => (mm.text ?? '').startsWith('ONAXIS-midless'))).toBe(true);
    purgeSpy.mockRestore();
  });

  // Item 3, the idempotence gate at the store level: once the axis is sound
  // staleRowReason returns null, so a second attach-ok cannot re-fire the heal.
  test('after the axis is sound staleRowReason is null and a re-read stays sound', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    mkSession('p1');
    await seedFieldPoison();
    // The open sanitises the poison the moment engine-axis rows are present.
    await openChatWindow(SID);
    expect(rowStore.staleRowReason(SID)).toBeNull();
    const tail = rowStore.projection(SID).messages;
    expect(tail[tail.length - 1].text).toBe(engineTailText);
    // A re-open (a fresh swipe) stays sound: the durable idx was rewritten clean.
    rowStore.setOpen(null);
    rowStore.close(SID);
    await openChatWindow(SID);
    expect(rowStore.staleRowReason(SID)).toBeNull();
  });
});

describe('the one door refuses a poisoned row once the session holds engine-axis rows', () => {
  test('a mid-less claude row from an overlay writer never persists and never poisons the axis', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    const s = mkSession('p1');
    // A sound engine-axis tail is already stored and open.
    await rowStore.upsert(SID, rowsOfPage(PAGES - 1));
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);
    expect(rowStore.staleRowReason(SID)).toBeNull();
    const before = rowStore.projection(SID).messages.length;

    // An overlay writer (a voice-note cacheTail, a queued-flag patch) tries to
    // persist a claude row with no mid: its durable id would fall back to
    // m@ts|role|text, the exact poison the heal loops on. patchMessage lets a
    // non-user row through (isUnsettledOwnSend is user-only), so the store's own
    // door is the last line: it refuses the row.
    const midless = {
      id: 909090,
      role: 'claude',
      kind: 'text',
      text: 'a mid-less reply that must not persist',
      ts: 1786649500000
    } as unknown as CycEngineMessage;
    patchMessage(s, midless);

    // The row never entered the axis: no poison, the projection is unchanged, and
    // the durable id was never written.
    expect(rowStore.staleRowReason(SID)).toBeNull();
    expect(rowStore.projection(SID).messages.length).toBe(before);
    expect(
      rowStore.projection(SID).messages.some((mm) => (mm.text ?? '').includes('must not'))
    ).toBe(false);
  });
});

// An engine page whose messages carry valid, on-axis seqs but NO mid: exactly
// what the engine's own pre-mid chat files re-serve (real history whose lines
// predate mid minting). The durable id falls back to m@ts|role|text, but the seq
// is real and on the axis, so this is legitimate engine history, not poison.
function midlessPage(n: number): EnginePage {
  const base = n * PAGE;
  return {
    page: n,
    version: (n + 1) * PAGE,
    sealed: true,
    messages: Array.from({length: PAGE}, (_, i) => ({
      id: SID,
      role: (i % 2 ? 'user' : 'claude') as 'user' | 'claude',
      kind: 'text' as const,
      text: 'mless' + (base + i),
      ts: base + i,
      seq: base + i
      // no mid: the durable id falls back to m@ts|role|text
    })),
    events: []
  } as unknown as EnginePage;
}

// The cold-tail attach-ok whose inline tail page is mid-less on real seqs.
const midlessColdTail = () => ({
  id: 'p1',
  known: true,
  pageSize: PAGE,
  total: PAGES * PAGE,
  tailPage: PAGES - 1,
  pointerPage: PAGES - 1,
  pages: [midlessPage(PAGES - 1)]
});

const midlessTailText = 'mless' + (PAGES * PAGE - 1);

// Count cyclog emits of an event name, filtered from a spy on the shared logger.
function emitsOf(spy: ReturnType<typeof vi.spyOn>, event: string): number {
  return (spy.mock.calls as unknown[][]).filter((c) => c[0] === event).length;
}

describe('a mid-less engine axis CONVERGES: real pre-mid history never trips the heal', () => {
  test('a store synced from an engine whose pages are mid-less on real seqs: no heal fires across two attach-oks, the rows persist and paint', async () => {
    vi.useFakeTimers();
    rowStore.__setBackingForTest(memTx().tx);
    const {fire} = wire(async (_pane, n) => (n >= 0 && n < PAGES ? midlessPage(n) : null));
    mkSession('p1');

    await openChatWindow(SID);
    const purgeSpy = vi.spyOn(rowStore, 'purge');

    // First attach-ok carries the mid-less tail. On the old code staleRowReason
    // returns 'midless-legacy-row' and the heal purges the real history and
    // re-syncs it, refiring forever. The fix leaves the on-axis mid-less rows
    // alone: no heal, ever.
    fire('attachOk', midlessColdTail());
    await drain();
    expect(rowStore.staleRowReason(SID)).toBeNull();
    expect(rowStore.staleRowReason(SID, PAGES * PAGE)).toBeNull();

    // A second attach-ok (the catchup re-attach) stays quiet: still no heal.
    fire('attachOk', midlessColdTail());
    await drain();
    expect(purgeSpy.mock.calls.length).toBe(0);

    // The mid-less rows persisted and paint: the tail projects.
    const paint = rowStore.projection(SID).messages;
    expect(paint[paint.length - 1].text).toBe(midlessTailText);
    expect(paint.some((mm) => (mm.text ?? '').startsWith('mless'))).toBe(true);
    purgeSpy.mockRestore();
  });

  test('post-purge backfill that re-admits mid-less on-axis rows does not re-trigger: heal once, then quiet (no second stale-axis, no kept line)', async () => {
    vi.useFakeTimers();
    const logging = await import('@/shared/logging');
    const logSpy = vi.spyOn(logging, 'cyclog');
    rowStore.__setBackingForTest(memTx().tx);
    // The engine serves mid-less pages; a background backfill re-admits them page
    // by page after the heal.
    const {fire} = wire(async (_pane, n) => (n >= 0 && n < PAGES ? midlessPage(n) : null));
    mkSession('p1');

    // A genuinely stale axis: a held tail far ABOVE the engine tail (mids, so the
    // door lets them seed the axis). The first attach heals it (held-tail-above).
    await seedStaleAxis(13261);
    await openChatWindow(SID);
    expect(rowStore.highestHeldSeq(SID)).toBe(13360);

    fire('attachOk', midlessColdTail());
    await drain();

    // Exactly one heal fired: the off-axis stale rows are gone, the served
    // mid-less tail projects.
    expect(emitsOf(logSpy, 'rowstore.stale-axis')).toBe(1);
    expect(rowStore.staleRowReason(SID)).toBeNull();
    expect(
      rowStore.projection(SID).messages.some((mm) => (mm.text ?? '').startsWith('STALE'))
    ).toBe(false);

    // From here the axis is all mid-less on-axis rows the backfill keeps
    // re-admitting. A fresh attach-ok must be QUIET: no stale-axis, no kept line.
    logSpy.mockClear();
    fire('attachOk', midlessColdTail());
    await drain();
    expect(emitsOf(logSpy, 'rowstore.stale-axis')).toBe(0);
    expect(emitsOf(logSpy, 'rowstore.stale-axis.kept')).toBe(0);
    expect(rowStore.staleRowReason(SID)).toBeNull();
    expect(rowStore.projection(SID).messages.slice(-1)[0].text).toBe(midlessTailText);
    logSpy.mockRestore();
  });
});

describe('OFF-AXIS poison still dies (real wiring): the heal and the read sanitise still bite', () => {
  test('a held tail with seqs ABOVE the attach tailVersion triggers exactly one heal, then converges', async () => {
    vi.useFakeTimers();
    rowStore.__setBackingForTest(memTx().tx);
    const {fire} = wire();
    mkSession('p1');

    // A cached older/longer axis (seqs far above the engine tail): the classic
    // off-axis poison that outranks and hides the real tail.
    await seedStaleAxis(13261);
    await openChatWindow(SID);
    expect(rowStore.highestHeldSeq(SID)).toBe(13360);
    const purgeSpy = vi.spyOn(rowStore, 'purge');

    fire('attachOk', coldTail());
    await drain();
    expect(purgeSpy.mock.calls.length).toBe(1); // exactly one heal
    expect(rowStore.staleRowReason(SID)).toBeNull();
    expect(rowStore.highestHeldSeq(SID)).toBeLessThanOrEqual(PAGES * PAGE);
    const paint = rowStore.projection(SID).messages;
    expect(paint[paint.length - 1].text).toBe(engineTailText);
    expect(paint.some((mm) => (mm.text ?? '').startsWith('STALE'))).toBe(false);

    // A second attach-ok no-ops: the axis is sound, no second heal.
    fire('attachOk', coldTail());
    await drain();
    expect(purgeSpy.mock.calls.length).toBe(1);
    purgeSpy.mockRestore();
  });

  test('a row with seq < 0 (an unseqed waller) is sanitised away on read, leaving the engine tail sound', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    mkSession('p1');
    // A sound engine tail (mids: hasEngineAxis true) next to unseqed wallers.
    await rowStore.upsert(SID, [
      ...rowsOfPage(PAGES - 1),
      ...Array.from({length: 5}, (_, i) => unseqedAugRow(i))
    ]);
    // The open reads the durable idx and sanitises the seq < 0 rows the moment
    // engine-axis rows are present.
    await openChatWindow(SID);
    expect(rowStore.staleRowReason(SID)).toBeNull();
    const paint = rowStore.projection(SID).messages;
    expect(paint.some((mm) => (mm.text ?? '').startsWith('AUG-unseq'))).toBe(false);
    expect(paint[paint.length - 1].text).toBe(engineTailText);
  });
});

describe('the client-ts optimistic shape stays refused at the door (real wiring)', () => {
  test('a mid-less, seq-less user row (the optimistic bubble) never enters the axis once the session holds engine-axis rows', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    mkSession('p1');
    // A sound engine-axis tail is already stored and open.
    await rowStore.upsert(SID, rowsOfPage(PAGES - 1));
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW);
    expect(rowStore.staleRowReason(SID)).toBeNull();
    const before = rowStore.projection(SID).messages.length;

    // The exact client-ts optimistic shape: a user send with NO mid and NO seq,
    // whose durable id falls back to m@<clientTs>|user|<text> and whose seq is -1
    // (sorts at the tail, walls the window). The door refuses it.
    const optimistic = {
      id: 717171,
      role: 'user',
      kind: 'text',
      text: 'own optimistic send',
      ts: 1786650000000
      // no mid, no seq
    } as unknown as CycEngineMessage;
    const res = await rowStore.upsert(SID, [messageRow(SID, optimistic)], 'wire');
    expect(res.changed).toBe(false); // nothing entered

    expect(rowStore.staleRowReason(SID)).toBeNull();
    expect(rowStore.projection(SID).messages.length).toBe(before);
    expect(
      rowStore.projection(SID).messages.some((mm) => (mm.text ?? '').includes('optimistic'))
    ).toBe(false);
    expect(rowStore.__mirror(SID)!.idx.some((t) => t.id.startsWith('m@'))).toBe(false);
  });
});

// THE BLANK-CHAT-ON-OPEN DEFECT, real wiring. A WORKING agent stamps a session
// RECORD on the seq axis every few seconds (a transcript-ingest row the chat has
// no pill for), so the newest rows BY SEQ are records and the real chat MESSAGES
// sit thousands of versions below the tail. The engine's cold delta serves those
// newest versions inline (records on top, messages below). The old by-seq window
// anchoring floored on the record tail and projected a desert: chat.painted
// count=0, then silence, though thousands of messages were held. The fix anchors
// the open window on the newest RENDERABLE rows, so the floor drops below the
// record tail and the messages paint.
const R_PAGE = 100;
const R_MSG_PAGES = 8; // seq 0..799 are messages
const R_PAGES = 20; // seq 800..1999 are records
const R_TOTAL = R_PAGES * R_PAGE; // 2000
const R_TAILPAGE = R_PAGES - 1;

// A live-shaped served page: the lower pages carry chat messages, the newest
// pages carry only session records (the transcript ingest), exactly the tail a
// busy agent presents.
function recPage(n: number): EnginePage {
  const base = n * R_PAGE;
  if (n < R_MSG_PAGES) {
    return {
      page: n,
      version: (n + 1) * R_PAGE,
      sealed: true,
      messages: Array.from({length: R_PAGE}, (_, i) => ({
        id: SID,
        role: (i % 2 ? 'user' : 'claude') as 'user' | 'claude',
        kind: 'text' as const,
        text: 'r' + (base + i),
        ts: base + i,
        seq: base + i,
        mid: 'mr-' + (base + i)
      })),
      events: []
    } as unknown as EnginePage;
  }
  return {
    page: n,
    version: (n + 1) * R_PAGE,
    sealed: true,
    messages: [],
    events: Array.from({length: R_PAGE}, (_, i) => ({
      uuid: 'rec-' + (base + i),
      ts: base + i,
      seq: base + i,
      kind: 'record',
      text: 'ingest ' + (base + i)
    }))
  } as unknown as EnginePage;
}

const allRecPages = (): EnginePage[] => Array.from({length: R_PAGES}, (_, n) => recPage(n));

const recTailAttach = () => ({
  id: 'p1',
  known: true,
  pageSize: R_PAGE,
  total: R_TOTAL,
  tailPage: R_TAILPAGE,
  pointerPage: R_TAILPAGE,
  pages: allRecPages()
});

// The same record-dense tail as an AttachOkLite, for the heal path that is
// awaited directly (feedAttachOk) instead of driven through the fake-timer
// backfill drain.
const recAttachLite = (): AttachOkLite => ({
  sessionId: SID,
  pageSize: R_PAGE,
  total: R_TOTAL,
  tailPage: R_TAILPAGE,
  pointerPage: R_TAILPAGE,
  pages: allRecPages()
});

describe('test 2 (real wiring): the live-shaped cold attach paints message bubbles, not a record desert', () => {
  test('a cold delta whose newest pages are session records still projects the newest messages on the first paint', async () => {
    vi.useFakeTimers();
    // A real durable backing (async commit), so a served row that never lands in
    // the loaded window cannot be recovered by a later racing read: the desert
    // BITES exactly as it did on the live rig.
    rowStore.__setBackingForTest(asyncMemTx().tx);
    const {fire} = wire();
    mkSession('p1');
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, WINDOW); // cold open onto an empty store

    // The engine serves the newest 2000 versions inline: 1200 records on top,
    // 800 messages below (all within the delta, as deltaBase carried them).
    fire('attachOk', recTailAttach());
    await drain();

    const proj = rowStore.projection(SID);
    // Control: the newest WINDOW rows BY SEQ are all records, so the old by-seq
    // anchoring projected zero messages here.
    const m = rowStore.__mirror(SID)!;
    const newestRaw = m.idx.slice(Math.max(0, m.idx.length - WINDOW));
    expect(newestRaw.every((t) => t.kind === 'event')).toBe(true);

    // The fix: the newest real messages paint (was count=0 on the by-seq floor).
    expect(proj.messages.length).toBe(WINDOW);
    expect(proj.messages[proj.messages.length - 1].text).toBe('r' + (R_MSG_PAGES * R_PAGE - 1));
    // and the whole served history is stored, reachable by scrolling up.
    const full = await rowStore.openWindow(SID, R_TOTAL + R_PAGE);
    expect(full.messages).toHaveLength(R_MSG_PAGES * R_PAGE);
    expect(full.messages[0].text).toBe('r0');
  });
});

describe('test 5 (real wiring): the stale-axis heal on a record-dense tail projects messages, not a desert', () => {
  test('a stale axis healed at a record-dense served tail re-opens onto the newest messages', async () => {
    // Real timers and the awaited heal path (feedAttachOk resolves after
    // purge -> re-open -> admit -> resnap), so the assertion runs on the healed
    // window without draining the whole background backfill.
    rowStore.__setBackingForTest(asyncMemTx().tx);
    wire();
    mkSession('p1');

    // A migrated older/longer axis: seqs far above this engine's tail, so the
    // attach-ok is stale and the heal must purge and re-admit the served tail.
    await seedStaleAxis(13261);
    await openChatWindow(SID);
    expect(rowStore.highestHeldSeq(SID)).toBe(13261 + PAGE - 1);

    // The engine serves the COLD tail: record-dense, tail version below the held
    // axis (2000 < 13360), so the heal fires. The heal's re-open and resnap must
    // use the SAME renderable anchoring, or the healed chat re-opens on the
    // record desert.
    await feedAttachOk(SID, KEY, 'p1', recAttachLite());
    stopReplicator(SID);

    // The stale axis is gone and the healed window shows the newest REAL
    // messages, not the record desert and not the phantom STALE rows.
    const proj = rowStore.projection(SID);
    expect(proj.messages.some((mm) => (mm.text ?? '').startsWith('STALE'))).toBe(false);
    expect(proj.messages.length).toBe(WINDOW);
    expect(proj.messages[proj.messages.length - 1].text).toBe('r' + (R_MSG_PAGES * R_PAGE - 1));
    expect(rowStore.highestHeldSeq(SID)).toBe(R_TOTAL - 1); // the real tail seq (records included)
  });
});
