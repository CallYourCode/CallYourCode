import {beforeEach, describe, expect, test, vi} from 'vitest';
import {createHeardProgress, type HeardStore} from '../heardProgress';
import type {ReadMarker} from '../engine/store/readState';
import type {CycMessage, CycSession} from '../types';

type Msg = CycMessage & {msgId?: string; mid?: string; seq?: number};
function msg(over: Omit<Partial<Msg>, 'id'> & {id?: number}): Msg {
  return {
    role: 'claude',
    kind: 'text',
    text: 't',
    ts: 0,
    ...over,
    id: String(over.id ?? 1)
  } as Msg;
}

// The engine is the authority; this suite proves the device only REPORTS
// SIGHTINGS and RENDERS the marker. The store is faked: `broadcast` stands in
// for the engine's readThrough, `sightings` records what this device reported,
// and effectiveMarkerOf overlays the newest sighting on the broadcast.
function makeWorld(over: {messages?: Msg[]; broadcast?: ReadMarker} = {}) {
  const session = {
    id: 's1',
    name: 's1',
    unread: 0,
    muted: false,
    thinking: false,
    messages: over.messages ?? []
  } as unknown as CycSession & {messages: CycMessage[]};
  const sightings: {mid?: string; msgId?: string; ts: number}[] = [];
  let overlay: ReadMarker | undefined;
  const store: HeardStore = {
    get: (id) => (id === 's1' ? session : undefined),
    reportSighting: (_sid, row) => {
      sightings.push(row);
      overlay = row.mid ? {mid: row.mid, ts: row.ts} : {ts: row.ts};
    },
    effectiveMarkerOf: () => overlay ?? over.broadcast
  };
  const heardMarked: [string, ReadMarker][] = [];
  const hp = createHeardProgress({
    store,
    isLive: () => true,
    activeId: () => 's1',
    isChatViewOpen: () => true,
    onHeardMarked: (sid, marker) => heardMarked.push([sid, marker])
  });
  return {session, hp, sightings, heardMarked};
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('heardTsOf / readMarkerOf', () => {
  test('the displayed marker is the engine broadcast, overlaid with sightings', () => {
    const {hp, session} = makeWorld({broadcast: {mid: 'mr-a', ts: 500}});
    expect(hp.heardTsOf(session)).toBe(500);
    expect(hp.readMarkerOf(session)?.mid).toBe('mr-a');
  });
  test('nothing read anywhere: zero', () => {
    const {hp, session} = makeWorld();
    expect(hp.heardTsOf(session)).toBe(0);
    expect(hp.readMarkerOf(session)).toBeUndefined();
  });
});

describe('markSeen', () => {
  test('sights the newest rendered row by its durable identity', () => {
    const {hp, sightings} = makeWorld({
      messages: [msg({id: 1, ts: 150, mid: 'mr-1'}), msg({id: 2, ts: 200, mid: 'mr-2'})]
    });
    hp.markSeen('s1');
    expect(sightings).toEqual([{mid: 'mr-2', msgId: undefined, ts: 200}]);
  });
  test('a trailing session record is skipped: the newest MESSAGE is sighted', () => {
    /* The rendered log interleaves session records (faint activity rows) with
     * messages, and a turn ends with `status: done` AFTER its last reply. A
     * record has no mid and is not in the engine's message log, so sighting
     * one is ignored and the chat stays unread forever (live 2026-09-23). */
    const {hp, sightings} = makeWorld({
      messages: [
        msg({id: 1, ts: 150, mid: 'mr-1'}),
        msg({id: 2, ts: 200, mid: 'mr-2'}),
        msg({id: 3, ts: 201, kind: 'status', text: 'status: done', mid: undefined, role: undefined as never})
      ]
    });
    hp.markSeen('s1');
    expect(sightings).toEqual([{mid: 'mr-2', msgId: undefined, ts: 200}]);
  });
  test('a log of records only has nothing to sight', () => {
    const {hp, sightings} = makeWorld({
      messages: [msg({id: 1, ts: 10, kind: 'status', text: 'status: idle', mid: undefined, role: undefined as never})]
    });
    hp.markSeen('s1');
    expect(sightings).toEqual([]);
  });
  test('an empty log has nothing to sight', () => {
    const {hp, sightings} = makeWorld({messages: []});
    hp.markSeen('s1');
    expect(sightings).toEqual([]);
  });
});

describe('markHeard', () => {
  test('sights the played row and pins it in the open chat', () => {
    const {hp, sightings, heardMarked} = makeWorld({
      messages: [msg({id: 1, ts: 100, mid: 'mr-a', msgId: 'a', seq: 7})]
    });
    hp.markHeard('s1', 'a');
    expect(sightings).toEqual([{mid: 'mr-a', msgId: 'a', ts: 100}]);
    expect(heardMarked).toEqual([['s1', {mid: 'mr-a', ts: 100}]]);
  });
  test('a clip the session does not hold is a no-op (engine restarted)', () => {
    const {hp, sightings} = makeWorld({messages: []});
    hp.markHeard('s1', 'ghost');
    expect(sightings).toEqual([]);
  });
  test('a legacy row with no mid still sights by its instant', () => {
    const {hp, sightings, heardMarked} = makeWorld({
      messages: [msg({id: 1, ts: 100, msgId: 'a'})]
    });
    hp.markHeard('s1', 'a');
    expect(sightings).toEqual([{mid: undefined, msgId: 'a', ts: 100}]);
    expect(heardMarked).toEqual([['s1', {ts: 100}]]);
  });
});

describe('reportViewedThrough', () => {
  test('sights the newest fully-rendered row', () => {
    const {hp, sightings} = makeWorld({
      messages: [msg({id: 1, ts: 1, mid: 'mr-1', seq: 3}), msg({id: 2, ts: 2, mid: 'mr-2', seq: 9})]
    });
    hp.reportViewedThrough('s1');
    expect(sightings).toEqual([{mid: 'mr-2', msgId: undefined, ts: 2}]);
  });
  test('only the open, active chat reports', () => {
    const sightings: unknown[] = [];
    const store: HeardStore = {
      get: () => ({id: 's1', messages: [msg({id: 1, ts: 1, mid: 'mr-1'})]}) as never,
      reportSighting: (_sid, row) => sightings.push(row),
      effectiveMarkerOf: () => undefined
    };
    const hp = createHeardProgress({
      store,
      isLive: () => true,
      activeId: () => 'other',
      isChatViewOpen: () => true,
      onHeardMarked: () => {}
    });
    hp.reportViewedThrough('s1');
    expect(sightings).toEqual([]);
  });
  test('a reconnecting pipe still reports: sightings queue a durable intent', () => {
    const sightings: unknown[] = [];
    const store: HeardStore = {
      get: () => ({id: 's1', messages: [msg({id: 1, ts: 5, mid: 'mr-5'})]}) as never,
      reportSighting: (_sid, row) => sightings.push(row),
      effectiveMarkerOf: () => undefined
    };
    const hp = createHeardProgress({
      store,
      isLive: () => false,
      activeId: () => 's1',
      isChatViewOpen: () => true,
      onHeardMarked: () => {}
    });
    hp.reportViewedThrough('s1');
    expect(sightings).toEqual([{mid: 'mr-5', msgId: undefined, ts: 5}]);
  });
});
