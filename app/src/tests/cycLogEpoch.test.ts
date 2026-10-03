import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// The log lines are part of the contract (rowstore.axis-epoch and the fallback
// rowstore.stale-axis), so they are collected here.
const logged = vi.hoisted(() => [] as {event: string; fields: Record<string, unknown>}[]);
vi.mock('@/shared/logging', async (orig) => ({
  ...(await orig<typeof import('@/shared/logging')>()),
  cyclog: (event: string, fields: Record<string, unknown> = {}) => {
    logged.push({event, fields});
  }
}));
// the roster handler's notification-icon store draws on a canvas jsdom lacks
vi.mock('@/features/media/notifAvatars', async (orig) => ({
  ...(await orig<typeof import('@/features/media/notifAvatars')>()),
  syncNotifAvatars: () => {},
  pruneNotifAvatars: async () => {}
}));

import {wireChat} from '../engine/store/handlers/chat';
import {wireEvents} from '../engine/store/handlers/events';
import {wireSessions} from '../engine/store/handlers/sessions';
import type {HandlerCtx} from '../engine/store/handlers/types';
import {conns, sessions, type Conn} from '../engine/store/registry';
import type {CycEngineMessage, CycEngineSession} from '../engine/store/types';
import type {
  EngineAttachOk,
  EngineChatMessage,
  EnginePage,
  EngineSession
} from '../engine/contract';
import * as rowStore from '../engine/store/rows/rowStore';
import {initDoor} from '../engine/store/rows/door';
import {eventRow, messageRow} from '../engine/store/rows/core';
import {replicatorFor, __resetReplicatorsForTest} from '../engine/store/rows/repl';
import {attach, detachChat} from '../engine/store';
import {dispatchFrame} from '../engine/frames';
import type {FrameContext} from '../engine/frames/types';
import * as sync from '../engine/sync';
import {memTx} from './rowStoreFake';

// THE AXIS EPOCH (fix-log-epoch). Hunter, 2026-10-03 10:09: the engine folded a
// provisional agent into Hunter (carry.ts absorb) and re-sequenced the whole
// log under the same session id: old axis seq 0..2645 with unused seqs, new axis
// 0..2493 dense, a new chat file. The phone last synced on Sept 24 and held the
// old axis through seq 2600. At 18:45 it opened Hunter: it painted the cached
// window (newest row Sept 24, a voice message at the bottom), stated frontier
// 2600, and only the held-tail heuristic (2600 above the new tail 2579) caught
// the dead axis, half a second later, by purging and admitting the served tail
// under the reader. Had the new axis grown past 2600 first, nothing would have
// caught it: the engine would have served a delta onto the dead axis.
//
// The engine now names each log's axis (its chat file id) on the roster row, the
// attach-ok and every fetched page; the device stamps its rows with it. Below,
// a fake engine that can re-sequence its log the way carry.ts did.

initDoor();

const KEY = 'ws://epoch.test:7802/ws';
const PANE = 'ag-hunter';
const SID = KEY + '|' + PANE;
const PS = 100;
const T0 = 1_787_650_000_000;
const OLD = 'ad24c6f5-old-axis';
const NEW = '55125645-new-axis';

// One row of the log. `n` is the row's identity across axes (its mid and its
// ts never change); `seq` is its place on the current axis.
type ERow = {n: number; seq: number; msg: boolean};
const tsOf = (n: number) => T0 + n * 60_000;
const isMsg = (n: number) => n % 5 === 0;

function wireMsg(r: ERow): EngineChatMessage {
  return {
    id: PANE,
    role: 'claude',
    kind: 'text',
    text: 'm' + r.n,
    ts: tsOf(r.n),
    seq: r.seq,
    mid: 'mr-' + r.n
  } as EngineChatMessage;
}
const wireEv = (r: ERow) => ({
  uuid: 'se-' + r.n,
  ts: tsOf(r.n),
  seq: r.seq,
  kind: 'tool',
  text: 'tool ' + r.n
});

class FakeEngine {
  rows: ERow[] = [];
  fetched: number[] = [];
  // undefined: an engine older than the epoch, which names none
  axis: string | undefined;
  constructor(axis: string | undefined) {
    this.axis = axis;
    // Hunter's old axis: up to seq 2645, with the seqs old patch lines used
    // left empty (one in seventeen)
    let n = 0;
    for (let q = 0; q <= 2645; q++)
      if (q % 17 !== 5) this.rows.push({n: n++, seq: q, msg: isMsg(n - 1)});
  }
  get T(): number {
    return this.rows[this.rows.length - 1].seq;
  }
  tailPage(): number {
    return Math.floor(this.T / PS);
  }
  // carry.ts absorb on main: every row re-sequenced densely from 0, a new file
  resequence(axis: string | undefined): void {
    this.rows.forEach((r, i) => (r.seq = i));
    this.axis = axis;
  }
  // newer rows appended on the current axis
  grow(to: number): void {
    let n = this.rows[this.rows.length - 1].n;
    while (this.T < to) {
      n++;
      this.rows.push({n, seq: this.T + 1, msg: isMsg(n)});
    }
  }
  on(p: number): ERow[] {
    return this.rows.filter((r) => Math.floor(r.seq / PS) === p);
  }
  page(p: number, inline = false): EnginePage {
    const on = this.on(p);
    const last = on[on.length - 1];
    return {
      page: p,
      version: last ? last.seq + 1 : p * PS,
      sealed: p < this.tailPage(),
      messages: on.filter((r) => r.msg).map(wireMsg),
      events: on.filter((r) => !r.msg).map(wireEv),
      // a fetched page names its axis; the attach-ok's inline pages ride under it
      ...(this.axis && !inline ? {axis: this.axis} : {})
    } as unknown as EnginePage;
  }
  // chat/attach.ts onAttach
  attachOk(F0: number, axis?: string): EngineAttachOk {
    const T = this.T;
    let F = F0;
    if (F > T + 1) F = -1; // the held-tail-above-axis cold attach
    if (this.axis && axis && axis !== this.axis) F = -1; // the epoch
    const pages: EnginePage[] = [];
    let deltaBase: number;
    if (F >= T) deltaBase = T + 1;
    else {
      const lo = Math.max(F + 1, T + 1 - 20 * PS);
      for (let p = Math.floor(T / PS); p >= Math.floor(lo / PS); p--)
        pages.push(this.page(p, true));
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
      deltaBase,
      ...(this.axis ? {axis: this.axis} : {})
    };
    if (!pages.length) delete a.pages;
    return a;
  }
  row(): EngineSession {
    return {
      id: PANE,
      name: 'Hunter',
      cwd: '/h',
      unread: 0,
      muted: false,
      alive: true,
      claudeSessionId: null,
      ...(this.axis ? {axis: this.axis} : {})
    } as unknown as EngineSession;
  }
}

type Attached = {frontier: number; axis?: string; heldAtAttach: number; shownAtAttach: number};

function stand(engine: FakeEngine) {
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
    fetchPrints: async () => null,
    attach: (_pane: string, frontier: number, _verifyFrom?: number, axis?: string) => {
      // what the open had already put on screen when it asked the engine
      attaches.push({
        frontier,
        axis,
        heldAtAttach: rowStore.highestHeldSeq(SID),
        shownAtAttach: sessions.get(SID)!.messages.length
      });
      const a = engine.attachOk(frontier, axis);
      queueMicrotask(() => handlers.attachOk?.(a));
    },
    setSessionTail: () => {},
    detach: () => {},
    verifyPipe: () => {},
    resyncSessions: () => {}
  };
  const conn = {key: KEY, client, state: 'connected', helloSettled: true} as unknown as Conn;
  conns.push(conn);
  const ctx = {
    ensureSession: () => sessions.get(SID)!,
    stripInstruction: (t: string) => t,
    releaseQueuedBefore: vi.fn(() => false),
    endReplayHold: vi.fn(),
    firstPaint: vi.fn(),
    attachedId: () => '',
    overlayOn: () => false,
    reclaimDead: () => false
  } as unknown as HandlerCtx;
  wireChat(conn, ctx);
  wireEvents(conn, ctx);
  wireSessions(conn, ctx);
  return {attaches, fire: (ev: string, ...a: unknown[]) => handlers[ev](...a)};
}

function plantSession(axis?: string): CycEngineSession {
  const s = {
    id: SID,
    engineKey: KEY,
    paneId: PANE,
    tabKey: '',
    name: 'Hunter',
    cwd: '/h',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [],
    claudeSessionId: null,
    events: [],
    agentRuns: [],
    ...(axis ? {axis} : {})
  } as unknown as CycEngineSession;
  sessions.set(SID, s);
  return s;
}

// The phone on Sept 24: the old axis held whole through seq `through`, the
// cursor complete, stamped with the epoch it was served under (or unstamped:
// rows stored before this device met an epoch).
async function seedDevice(engine: FakeEngine, through: number, axis?: string): Promise<void> {
  const rows = engine.rows.filter((r) => r.seq <= through);
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
    cursor: 0,
    tailVersion: through + 1,
    tailPage: Math.floor(through / PS),
    coveredFrom: 0,
    pageSize: PS,
    total: rows.length,
    syncedAt: 1,
    ...(axis ? {axis} : {})
  });
  rowStore.close(SID);
}

async function settle(ms = 60): Promise<void> {
  for (let i = 0; i < ms / 5; i++) await new Promise((r) => setTimeout(r, 5));
}

async function drain(): Promise<void> {
  const r = replicatorFor(SID, KEY, PANE);
  for (let i = 0; i < 60; i++) {
    await r.pump();
    await settle(5);
  }
}

// Every row the device holds, as (seq, ts): on the engine's current axis each
// row's pair is unique, so a row left over from the dead axis shows up as a
// pair the engine does not have.
function heldPairs(): string[] {
  const m = rowStore.__mirror(SID);
  return (m?.idx ?? []).map((t) => `${t.seq}@${t.ts}`).sort();
}
function enginePairs(engine: FakeEngine, from = 0): string[] {
  return engine.rows
    .filter((r) => r.seq >= from)
    .map((r) => `${r.seq}@${tsOf(r.n)}`)
    .sort();
}

const events = (name: string) => logged.filter((l) => l.event === name);

beforeEach(() => {
  logged.length = 0;
  rowStore.__setBackingForTest(memTx().tx);
  sync.__resetLiveForTest(() => 0.5);
  sync.noteSealed(KEY);
  sync.noteHost(KEY);
  sync.noteSessions(KEY);
});

afterEach(() => {
  detachChat();
  __resetReplicatorsForTest();
  sessions.delete(SID);
  const at = conns.findIndex((c) => c.key === KEY);
  if (at >= 0) conns.splice(at, 1);
  sync.__resetLiveForTest();
  rowStore.__setBackingForTest(null);
  vi.restoreAllMocks();
});

describe('the field case: Hunter re-sequenced while the phone held the old axis', () => {
  test('the roster already named the new epoch: the open paints nothing of the dead axis', async () => {
    const engine = new FakeEngine(OLD);
    await seedDevice(engine, 2600, OLD);
    engine.resequence(NEW);
    engine.grow(2578); // 18:45: the new tail is 2578, the held one 2600
    // the roster frame the phone got on connect (persisted for a cold boot)
    plantSession(NEW);
    const {attaches} = stand(engine);

    attach(SID);
    await settle(150);

    // main painted 300 rows of the Sept 24 window, then asked with 2600
    expect(attaches[0].shownAtAttach, 'rows painted before the engine answered').toBe(0);
    expect(attaches[0].heldAtAttach, 'rows held when the open asked the engine').toBe(-1);
    expect(attaches[0].frontier).toBe(-1);
    expect(attaches[0].axis).toBe(NEW);
    expect(events('rowstore.axis-epoch')[0]?.fields).toMatchObject({
      held: OLD,
      axis: NEW,
      trigger: 'open'
    });

    await drain();
    expect(heldPairs()).toEqual(enginePairs(engine));
    expect(rowStore.metaSnapshot(SID)?.axis).toBe(NEW);
    expect(events('rowstore.stale-axis')).toEqual([]);
  });

  test('the new axis grew past the held tail and the roster has not said: the attach-ok replaces the rows', async () => {
    const engine = new FakeEngine(OLD);
    await seedDevice(engine, 2600, OLD);
    engine.resequence(NEW);
    engine.grow(2700); // the case the held-tail heuristic cannot see
    plantSession(OLD); // the persisted roster still names the old epoch
    const {attaches} = stand(engine);

    attach(SID);
    await settle(200);
    await drain();
    // main: the engine served a delta above 2600 onto the dead axis and the old
    // rows stayed under their old seqs
    expect(heldPairs()).toEqual(enginePairs(engine));
    expect(attaches[0].frontier).toBe(2600);
    expect(attaches[0].axis, 'the open names the epoch its rows were served under').toBe(OLD);
    expect(rowStore.metaSnapshot(SID)?.axis).toBe(NEW);
    expect(events('rowstore.axis-epoch')[0]?.fields).toMatchObject({
      held: OLD,
      axis: NEW,
      trigger: 'attach'
    });
  });
});

describe('a re-sequence announced on the roster', () => {
  test('a closed chat drops its dead rows in the background, and opens onto the new tail', async () => {
    const engine = new FakeEngine(OLD);
    await seedDevice(engine, 2600, OLD);
    plantSession(OLD);
    const {fire, attaches} = stand(engine);

    engine.resequence(NEW);
    fire('session', engine.row());
    await settle(60);
    expect(rowStore.highestHeldSeq(SID)).toBe(-1);
    expect(rowStore.metaSnapshot(SID)?.axis).toBe(NEW);
    expect(events('rowstore.axis-epoch')[0]?.fields).toMatchObject({trigger: 'roster'});
    expect(attaches).toEqual([]); // nothing asked of the engine for a closed chat

    attach(SID);
    await settle(150);
    expect(attaches[0]).toMatchObject({frontier: -1, axis: NEW, shownAtAttach: 0});
    await drain();
    expect(heldPairs()).toEqual(enginePairs(engine));
  });

  test('the open chat keeps its rows on screen and re-attaches; the served tail replaces them', async () => {
    const engine = new FakeEngine(OLD);
    await seedDevice(engine, 2645, OLD);
    plantSession(OLD);
    const {fire, attaches} = stand(engine);
    attach(SID);
    await settle(150);
    const shown = sessions.get(SID)!.messages.length;
    expect(shown).toBeGreaterThan(0);

    engine.resequence(NEW);
    fire('session', engine.row());
    // the purge waits for the tail: the rows are still there the moment the
    // roster says the axis is dead
    expect(sessions.get(SID)!.messages.length).toBe(shown);
    await settle(150);
    expect(sessions.get(SID)!.messages.length).toBeGreaterThan(0);
    await drain();
    // main: nothing told the open chat; it held the dead axis
    expect(heldPairs()).toEqual(enginePairs(engine));
    expect(attaches[0]).toMatchObject({frontier: 2645, axis: OLD});
    expect(attaches.length).toBe(2);
    expect(attaches[1]).toMatchObject({frontier: -1, axis: OLD});
    expect(events('rowstore.axis-epoch.resync').length).toBe(1);
    expect(rowStore.metaSnapshot(SID)?.axis).toBe(NEW);
  });

  test('a fetched page of another epoch is never filed among the rows', async () => {
    const engine = new FakeEngine(OLD);
    await seedDevice(engine, 2645, OLD);
    // the replicator still owes page 3 on the old axis
    rowStore.writeMeta({...rowStore.metaSnapshot(SID)!, coveredFrom: 4, cursor: 400});
    plantSession(OLD);
    stand(engine);
    attach(SID);
    await settle(150);
    detachChat();
    rowStore.setOpen(null);
    const before = heldPairs();

    engine.resequence(NEW); // and the roster frame is lost
    const r = replicatorFor(SID, KEY, PANE);
    await r.pump();
    await settle(60);
    expect(engine.fetched).toContain(3);
    const after = heldPairs();
    // nothing of the new axis landed among the old rows: they were dropped whole
    expect(after.filter((p) => !before.includes(p))).toEqual([]);
    expect(rowStore.highestHeldSeq(SID)).toBe(-1);
    expect(rowStore.metaSnapshot(SID)?.axis).toBe(NEW);
    expect(events('rowstore.axis-epoch')[0]?.fields).toMatchObject({trigger: 'page'});
  });
});

describe('the heuristics are the fallback, not the rule', () => {
  test('an engine that names no epoch (older than it): the held-tail heuristic heals the field case as before', async () => {
    const engine = new FakeEngine(undefined);
    await seedDevice(engine, 2600);
    engine.resequence(undefined);
    engine.grow(2578);
    plantSession();
    const {attaches} = stand(engine);
    attach(SID);
    await settle(200);
    expect(attaches[0].axis).toBeUndefined();
    expect(events('rowstore.stale-axis')[0]?.fields).toMatchObject({
      heldTail: 2600,
      engineTailVersion: 2579,
      reason: 'held-tail-above-engine-axis'
    });
    expect(events('rowstore.axis-epoch')).toEqual([]);
    await drain();
    expect(heldPairs()).toEqual(enginePairs(engine));
  });

  test('rows stored before the device met an epoch are checked once by the heuristics, then stamped', async () => {
    const engine = new FakeEngine(OLD);
    await seedDevice(engine, 2645); // unstamped, and sound
    plantSession(OLD);
    const {attaches} = stand(engine);
    attach(SID);
    await settle(150);
    expect(attaches[0]).toMatchObject({frontier: 2645, axis: undefined});
    expect(rowStore.metaSnapshot(SID)?.axis).toBe(OLD);
    expect(events('rowstore.stale-axis')).toEqual([]);
    expect(events('rowstore.axis-epoch')).toEqual([]);
    expect(heldPairs()).toEqual(enginePairs(engine));
  });

  test('the same epoch: the rows are on this axis and no heuristic second-guesses them', async () => {
    const engine = new FakeEngine(OLD);
    await seedDevice(engine, 2645, OLD);
    plantSession(OLD);
    const {attaches} = stand(engine);
    attach(SID);
    await settle(150);
    expect(attaches[0]).toMatchObject({frontier: 2645, axis: OLD});
    expect(events('rowstore.stale-axis')).toEqual([]);
    expect(events('rowstore.axis-epoch')).toEqual([]);
    expect(heldPairs()).toEqual(enginePairs(engine));
  });
});

describe('the wire', () => {
  // The roster row, the attach-ok and a fetched page each carry the epoch, and
  // each decoder keeps it (a whitelisting decoder that drops it silently turns
  // the whole roster path off: the rig caught exactly that).
  test('the sessions, session and attach-ok frames carry the epoch through their decoders', () => {
    const got: Record<string, unknown[]> = {};
    const ctx = {
      url: 'ws://engine',
      emit: (ev: string, ...args: unknown[]) => {
        got[ev] = args;
      },
      engineObjectUrl: (p: string) => p,
      rememberUserHost: () => {},
      canDo: new Set<string>(),
      voiceHealthyState: false,
      attachedId: '',
      tailedId: null,
      terms: new Map()
    } as unknown as FrameContext;
    dispatchFrame(ctx, {
      t: 'sessions',
      list: [{id: PANE, name: 'Hunter', cwd: '', alive: true, axis: NEW}]
    });
    expect((got.sessions[0] as EngineSession[])[0].axis).toBe(NEW);
    dispatchFrame(ctx, {t: 'session', id: PANE, name: 'Hunter', cwd: '', alive: true, axis: OLD});
    expect((got.session[0] as EngineSession).axis).toBe(OLD);
    dispatchFrame(ctx, {t: 'sessions', list: [{id: PANE, name: 'Hunter', cwd: '', alive: true}]});
    expect('axis' in (got.sessions[0] as EngineSession[])[0]).toBe(false);
    dispatchFrame(ctx, {t: 'attach-ok', id: PANE, known: true, tailPage: 0, pages: [], axis: NEW});
    expect((got.attachOk[0] as EngineAttachOk).axis).toBe(NEW);
  });
});
