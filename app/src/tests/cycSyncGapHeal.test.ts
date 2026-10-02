import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// The log lines are part of the contract (gap.detected / gap.filled /
// dup.dropped / page.replaced / page.unreconciled), so they are collected here.
const logged = vi.hoisted(() => [] as {event: string; fields: Record<string, unknown>}[]);
vi.mock('@/shared/logging', async (orig) => ({
  ...(await orig<typeof import('@/shared/logging')>()),
  cyclog: (event: string, fields: Record<string, unknown> = {}) => {
    logged.push({event, fields});
  }
}));

import {wireChat} from '../engine/store/handlers/chat';
import {wireEvents} from '../engine/store/handlers/events';
import type {HandlerCtx} from '../engine/store/handlers/types';
import {conns, sessions, type Conn} from '../engine/store/registry';
import type {CycEngineMessage, CycEngineSession} from '../engine/store/types';
import type {EngineAttachOk, EngineChatMessage, EnginePage} from '../engine/contract';
import * as rowStore from '../engine/store/rows/rowStore';
import {initDoor} from '../engine/store/rows/door';
import {eventRow, messageRow} from '../engine/store/rows/core';
import {attachFrontier, replicatorFor, __resetReplicatorsForTest} from '../engine/store/rows/repl';
import {attach, detachChat, loadOlder} from '../engine/store';
import * as sync from '../engine/sync';
import {memTx} from './rowStoreFake';

// THE SYNC GAP (fix-sync-gap, 2026-10-02). The owner's laptop showed BZ Builder
// jump from 22:39 straight to "Today 10:10": 65 messages the engine held never
// reached it, and nothing on screen said so. Two triggers, both proven in the
// field logs (cyc-builder/scratchpad/msg-audit/00-REPORT.md):
//   A. The frontier was the MAX seq held. A chat the device was not attached to
//      still receives every broadcast chat message (session records go only to
//      attached clients), so a newer message landed alone and the next open
//      stated a frontier past everything missed in between.
//   B. The engine serves at most 20 pages above the frontier; the replicator
//      counted the unserved middle as covered and never pulled it.
// And the self-heal for a device that already holds such a hole: every attach
// fingerprints the shown pages, a page that differs is refetched, and while it
// is missing the list shows a gap row instead of joining across it.
//
// The fake engine below follows chat/attach.ts: (F, T] newest-complete capped at
// 20 pages, deltaBase, tailVersion, and fingerprints for [verifyFrom, lowest
// served page). One row in ten is a chat message, the rest session records,
// like the busy chats in the field.

initDoor();

const KEY = 'ws://syncgap.test:7801/ws';
const PANE = 'ag-bz';
const SID = KEY + '|' + PANE;
const PS = 100;
const T0 = 1_790_000_000_000;

type ERow = {seq: number; msg: boolean; rev?: number; text?: string; ts?: number};

const isMsg = (seq: number) => seq % 10 === 0;
// The engine's fingerprint term, written out (shared/pages.ts printTerm): if the
// store ever computed it differently, every shown page would differ and refetch,
// which the scroll test below (nothing refetched) would catch.
const printTerm = (offset: number, rev: number) => (offset + 1) * 1009 + rev;
const tsOf = (seq: number) => T0 + seq * 1000;

function wireMsg(r: ERow): EngineChatMessage {
  return {
    id: PANE,
    role: 'claude',
    kind: 'text',
    text: r.text ?? 'm' + r.seq,
    ts: r.ts ?? tsOf(r.seq),
    seq: r.seq,
    mid: 'mr-' + r.seq,
    ...(r.rev ? {rev: r.rev} : {})
  } as EngineChatMessage;
}
const wireEv = (r: ERow) => ({
  uuid: 'se-' + r.seq,
  ts: r.ts ?? tsOf(r.seq),
  seq: r.seq,
  kind: 'tool',
  text: 'tool ' + r.seq
});

class FakeEngine {
  rows: ERow[] = [];
  fetched: number[] = [];
  constructor(T: number) {
    for (let q = 0; q <= T; q++) this.rows.push({seq: q, msg: isMsg(q)});
  }
  get T(): number {
    return this.rows[this.rows.length - 1].seq;
  }
  tailPage(): number {
    return Math.floor(this.T / PS);
  }
  on(n: number): ERow[] {
    return this.rows.filter((r) => Math.floor(r.seq / PS) === n);
  }
  page(n: number): EnginePage {
    const on = this.on(n);
    const last = on[on.length - 1];
    return {
      page: n,
      version: last ? last.seq + 1 : n * PS,
      sealed: n < this.tailPage(),
      messages: on.filter((r) => r.msg).map(wireMsg),
      events: on.filter((r) => !r.msg).map(wireEv)
    } as unknown as EnginePage;
  }
  attachOk(F: number, verifyFrom?: number): EngineAttachOk {
    const T = this.T;
    const pages: EnginePage[] = [];
    let deltaBase: number;
    if (F >= T) deltaBase = T + 1;
    else {
      const lo = Math.max(F + 1, T + 1 - 20 * PS);
      for (let n = Math.floor(T / PS); n >= Math.floor(lo / PS); n--) pages.push(this.page(n));
      deltaBase = lo;
    }
    const a: EngineAttachOk = {
      id: PANE,
      known: true,
      pageSize: PS,
      tailPage: this.tailPage(),
      tailVersion: T + 1,
      total: this.rows.length,
      pages,
      queued: [],
      deltaBase
    };
    if (verifyFrom !== undefined) {
      let top = this.tailPage();
      for (const p of pages) if (p.page - 1 < top) top = p.page - 1;
      const from = Math.max(verifyFrom, top - 99, 0);
      if (top >= from) {
        const fp = {from, n: [] as number[], m: [] as number[], h: [] as number[]};
        for (let p = from; p <= top; p++) {
          const on = this.on(p);
          fp.n.push(on.length);
          fp.m.push(on.filter((r) => r.msg).length);
          fp.h.push(on.reduce((acc, r) => acc + printTerm(r.seq - p * PS, r.rev ?? 0), 0));
        }
        a.fp = fp;
      }
    }
    if (!pages.length) delete a.pages;
    return a;
  }
}

type Attached = {frontier: number; verifyFrom?: number};

function stand(engine: FakeEngine): {
  attaches: Attached[];
  fire: (ev: string, ...a: unknown[]) => void;
} {
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const attaches: Attached[] = [];
  const client = {
    on: (ev: string, fn: (...a: unknown[]) => void) => {
      handlers[ev] = fn;
    },
    fetchPage: async (_pane: string, n: number) => {
      engine.fetched.push(n);
      return n >= 0 && n <= engine.tailPage() ? engine.page(n) : null;
    },
    attach: (_pane: string, frontier: number, verifyFrom?: number) => {
      attaches.push({frontier, verifyFrom});
      const a = engine.attachOk(frontier, verifyFrom);
      queueMicrotask(() => handlers.attachOk?.(a));
    },
    setSessionTail: () => {},
    detach: () => {},
    verifyPipe: () => {}
  };
  const conn = {key: KEY, client, state: 'connected'} as unknown as Conn;
  conns.push(conn);
  const ctx = {
    ensureSession: () => sessions.get(SID)!,
    stripInstruction: (t: string) => t,
    releaseQueuedBefore: vi.fn(() => false),
    endReplayHold: vi.fn(),
    firstPaint: vi.fn()
  } as unknown as HandlerCtx;
  wireChat(conn, ctx);
  wireEvents(conn, ctx);
  return {attaches, fire: (ev, ...a) => handlers[ev](...a)};
}

function plantSession(): CycEngineSession {
  const s = {
    id: SID,
    engineKey: KEY,
    paneId: PANE,
    tabKey: '',
    name: 'BZ Builder',
    cwd: '/x',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [],
    claudeSessionId: null,
    events: [],
    agentRuns: []
  } as unknown as CycEngineSession;
  sessions.set(SID, s);
  return s;
}

// The device's store as an earlier attach left it: every row the engine served
// for `seqs`, plus the cursor meta that attach persisted.
async function seedDevice(
  engine: FakeEngine,
  seqs: number[],
  meta: {tailVersion: number; tailPage: number; coveredFrom: number}
): Promise<void> {
  const want = new Set(seqs);
  const rows = engine.rows.filter((r) => want.has(r.seq));
  await rowStore.upsert(
    SID,
    rows.map((r) =>
      r.msg
        ? messageRow(SID, {...wireMsg(r)} as unknown as CycEngineMessage)
        : eventRow(SID, wireEv(r))
    )
  );
  rowStore.writeMeta({
    sessionId: SID,
    cursor: meta.coveredFrom * PS,
    tailVersion: meta.tailVersion,
    tailPage: meta.tailPage,
    coveredFrom: meta.coveredFrom,
    pageSize: PS,
    total: 0,
    syncedAt: 1
  });
  rowStore.close(SID);
}

async function settle(ms = 60): Promise<void> {
  for (let i = 0; i < ms / 5; i++) await new Promise((r) => setTimeout(r, 5));
}

// Drain the replicator by hand (its own timer paces at 2 pages/s).
async function drain(): Promise<void> {
  const r = replicatorFor(SID, KEY, PANE);
  for (let i = 0; i < 80; i++) {
    await r.pump();
    await settle(5);
  }
}

function heldMessageSeqs(): number[] {
  const m = rowStore.__mirror(SID)!;
  return m.idx
    .filter((t) => t.kind === 'msg')
    .map((t) => t.seq)
    .sort((a, b) => a - b);
}

function engineMessageSeqs(engine: FakeEngine): number[] {
  return engine.rows.filter((r) => r.msg).map((r) => r.seq);
}

const events = (name: string) => logged.filter((l) => l.event === name);

// Hold the background backfill still (it pauses while the page is hidden), so a
// test can look at the state between finding a hole and filling it.
function hidePage(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    value: hidden ? 'hidden' : 'visible',
    configurable: true
  });
}

beforeEach(() => {
  logged.length = 0;
  rowStore.__setBackingForTest(memTx().tx);
  sync.__resetLiveForTest(() => 0.5);
  sync.noteSealed(KEY);
  sync.noteHost(KEY);
  sync.noteSessions(KEY);
  plantSession();
});

afterEach(() => {
  hidePage(false);
  detachChat();
  __resetReplicatorsForTest();
  sessions.delete(SID);
  const at = conns.findIndex((c) => c.key === KEY);
  if (at >= 0) conns.splice(at, 1);
  sync.__resetLiveForTest();
  rowStore.__setBackingForTest(null);
  vi.restoreAllMocks();
});

describe('trigger A: a broadcast message for an unattached chat never raises the frontier', () => {
  test('the laptop: caught up at 1234, two messages land while on the list, the open states 1234', async () => {
    // The engine moved on overnight to 2599; the laptop last confirmed 1234.
    const engine = new FakeEngine(2599);
    const held = Array.from({length: 1235}, (_, i) => i);
    await seedDevice(engine, held, {tailVersion: 1235, tailPage: 12, coveredFrom: 0});
    const {attaches, fire} = stand(engine);

    // Connected but attached to nothing: the two newest messages arrive as
    // broadcast chat frames, the records between them do not.
    fire('chat', wireMsg({seq: 2550, msg: true}));
    fire('chat', wireMsg({seq: 2590, msg: true}));
    await settle();

    attach(SID);
    await settle(120);
    expect(attaches.length).toBeGreaterThan(0);
    // main stated 2590 here and the engine served only page 25
    expect(attaches[0].frontier).toBe(1234);

    await drain();
    const want = engineMessageSeqs(engine);
    expect(heldMessageSeqs()).toEqual(want); // every message once, none twice
    const m = rowStore.__mirror(SID)!;
    expect(m.idx.length).toBe(engine.rows.length); // the records came too
    expect(sessions.get(SID)!.gaps).toBeUndefined();
  });

  test('a live row moves the confirmed edge only when it is the very next seq', async () => {
    const engine = new FakeEngine(300);
    await seedDevice(
      engine,
      Array.from({length: 301}, (_, i) => i),
      {
        tailVersion: 301,
        tailPage: 3,
        coveredFrom: 0
      }
    );
    const {attaches, fire} = stand(engine);
    attach(SID);
    await settle(80);
    expect(attaches[0].frontier).toBe(300);

    // attached: the next rows arrive in order, records and messages alike
    engine.rows.push({seq: 301, msg: false}, {seq: 302, msg: false});
    fire('sessionEvent', PANE, wireEv({seq: 301, msg: false}));
    expect(attachFrontier(SID, rowStore.highestHeldSeq(SID))).toBe(301);
    // a jump (seq 302 never arrived) leaves the edge where it was
    engine.rows.push({seq: 303, msg: false}, {seq: 304, msg: false}, {seq: 310, msg: true});
    fire('chat', wireMsg({seq: 310, msg: true}));
    await settle();
    expect(rowStore.highestHeldSeq(SID)).toBe(310);
    expect(attachFrontier(SID, rowStore.highestHeldSeq(SID))).toBe(301);
  });
});

describe('trigger B: a capped delta leaves the unserved middle as holes, and they are pulled', () => {
  test('the tablet: confirmed at 2703, engine at 5836, the 20-page cap skips 27..37', async () => {
    const engine = new FakeEngine(5836);
    await seedDevice(
      engine,
      Array.from({length: 2704}, (_, i) => i),
      {
        tailVersion: 2704,
        tailPage: 27,
        coveredFrom: 0
      }
    );
    const {attaches} = stand(engine);
    attach(SID);
    await settle(150);
    expect(attaches[0].frontier).toBe(2703);

    await drain();
    // main never fetched a page here: the cursor called 0..58 covered
    expect(heldMessageSeqs()).toEqual(engineMessageSeqs(engine));
    // the session records of the skipped range came with their pages
    expect(rowStore.__mirror(SID)!.idx.length).toBe(engine.rows.length);
    for (let p = 27; p <= 37; p++) expect(engine.fetched).toContain(p);
    const detected = events('gap.detected').find((l) => String(l.fields.why).includes('capped'));
    expect(detected?.fields.pages).toBe('27-37');
    expect(events('gap.filled').length).toBeGreaterThanOrEqual(11);
    expect(attachFrontier(SID, rowStore.highestHeldSeq(SID))).toBe(5836);
  });
});

describe('self-heal: the shown pages are fingerprinted on every attach', () => {
  test("the laptop's cache as it was after the 09:13 open heals with no manual clear", async () => {
    // Held: 0..1234 and page 25 whole; the cursor claims 0..25 covered (what
    // main's replicator persisted after serving page 25 alone).
    const engine = new FakeEngine(2599);
    const held = [
      ...Array.from({length: 1235}, (_, i) => i),
      ...Array.from({length: 100}, (_, i) => 2500 + i)
    ];
    await seedDevice(engine, held, {tailVersion: 2600, tailPage: 25, coveredFrom: 0});
    const {attaches} = stand(engine);
    hidePage(true);
    attach(SID);
    await settle(150);
    expect(attaches[0].frontier).toBe(2599);
    expect(attaches[0].verifyFrom).toBe(0);

    const detected = events('gap.detected').find((l) => l.fields.pages === '12-24');
    expect(detected, JSON.stringify(events('gap.detected'))).toBeTruthy();
    expect(detected!.fields.missingMsgs).toBe(126);

    // the gap row stands where the messages are missing: after the last row
    // held below the hole (seq 1234), before page 25
    const s = sessions.get(SID)!;
    expect(s.gaps?.length).toBe(1);
    expect(s.gaps![0].text).toBe('Loading 126 missing messages...');
    expect(s.gaps![0].ts).toBe(tsOf(1234));
    expect(engine.fetched).toEqual([]);

    hidePage(false);
    await drain();
    for (let p = 12; p <= 24; p++) expect(engine.fetched).toContain(p);
    expect(heldMessageSeqs()).toEqual(engineMessageSeqs(engine));
    expect(rowStore.__mirror(SID)!.idx.length).toBe(engine.rows.length);
    expect(sessions.get(SID)!.gaps).toBeUndefined();
    // the painted window reads oldest to newest
    const ts = sessions.get(SID)!.messages.map((m) => m.ts);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(events('gap.filled').map((l) => l.fields.page)).toEqual(
      expect.arrayContaining([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24])
    );
  });

  test('a page holding a second copy of a message under another id is replaced: dup.dropped', async () => {
    const engine = new FakeEngine(399);
    await seedDevice(
      engine,
      Array.from({length: 400}, (_, i) => i),
      {
        tailVersion: 400,
        tailPage: 3,
        coveredFrom: 0
      }
    );
    // a twin of seq 110 under a legacy fallback id (no mid), same ts
    const twin = {...wireMsg({seq: 110, msg: true})} as unknown as CycEngineMessage;
    delete (twin as {mid?: string}).mid;
    twin.text = 'm110 (old copy)';
    await rowStore.upsert(SID, [messageRow(SID, twin)]);
    rowStore.close(SID);
    stand(engine);
    attach(SID);
    await settle(120);
    await drain();
    expect(engine.fetched).toContain(1);
    expect(events('dup.dropped').length).toBe(1);
    expect(heldMessageSeqs()).toEqual(engineMessageSeqs(engine));
  });

  test('a row the engine no longer holds on a sealed page is dropped: page.replaced', async () => {
    const engine = new FakeEngine(399);
    await seedDevice(
      engine,
      Array.from({length: 400}, (_, i) => i),
      {
        tailVersion: 400,
        tailPage: 3,
        coveredFrom: 0
      }
    );
    engine.rows = engine.rows.filter((r) => r.seq !== 150); // gone on the engine
    stand(engine);
    attach(SID);
    await settle(120);
    await drain();
    expect(engine.fetched).toContain(1);
    expect(events('page.replaced').length).toBe(1);
    expect(heldMessageSeqs()).toEqual(engineMessageSeqs(engine));
  });

  test('a stale edit (the device missed the patch frame) is refetched by its rev', async () => {
    const engine = new FakeEngine(399);
    await seedDevice(
      engine,
      Array.from({length: 400}, (_, i) => i),
      {
        tailVersion: 400,
        tailPage: 3,
        coveredFrom: 0
      }
    );
    const row = engine.rows.find((r) => r.seq === 220)!;
    row.rev = 1;
    row.text = 'm220, transcript filled';
    stand(engine);
    attach(SID);
    await settle(120);
    await drain();
    expect(engine.fetched).toEqual([2]);
    const m = rowStore.__mirror(SID)!;
    expect(m.byId.get('m:mr-220')?.rv).toBe(1);
  });

  test('a page the store cannot hold the same way is refetched once, then left alone', async () => {
    const engine = new FakeEngine(399);
    await seedDevice(
      engine,
      Array.from({length: 400}, (_, i) => i),
      {
        tailVersion: 400,
        tailPage: 3,
        coveredFrom: 0
      }
    );
    // the engine holds one message twice under the same mid (its own dup):
    // the store keeps one row, so page 1 can never match
    engine.rows.splice(
      engine.rows.findIndex((r) => r.seq === 131),
      0,
      {seq: 130, msg: true}
    );
    const {attaches} = stand(engine);
    attach(SID);
    await settle(120);
    await drain();
    expect(engine.fetched.filter((p) => p === 1).length).toBe(1);
    expect(events('page.unreconciled').length).toBe(1);
    expect(sessions.get(SID)!.gaps).toBeUndefined();
    // the next attach carries the same print: no second fetch, no gap row
    const conn = conns.find((c) => c.key === KEY)!;
    (conn.client as unknown as {attach: (p: string, f: number, v?: number) => void}).attach(
      PANE,
      attachFrontier(SID, rowStore.highestHeldSeq(SID)),
      0
    );
    await settle(80);
    await drain();
    expect(attaches.length).toBeGreaterThan(1);
    expect(engine.fetched.filter((p) => p === 1).length).toBe(1);
  });

  test('scrolling below the fingerprinted pages asks the engine again from the new floor', async () => {
    // 1000 messages: the 300-message window shows pages 70..99 at first
    const engine = new FakeEngine(9999);
    await seedDevice(
      engine,
      Array.from({length: 10000}, (_, i) => i),
      {
        tailVersion: 10000,
        tailPage: 99,
        coveredFrom: 0
      }
    );
    const {attaches} = stand(engine);
    attach(SID);
    await settle(150);
    const first = attaches[0].verifyFrom!;
    expect(first).toBeGreaterThan(0);
    await loadOlder(SID);
    await settle(80);
    const again = attaches[attaches.length - 1];
    expect(attaches.length).toBeGreaterThan(1);
    expect(again.verifyFrom!).toBeLessThan(first);
    expect(engine.fetched).toEqual([]); // everything matched: nothing refetched
  });
});
