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
// `onScreen` is the surface's answer to "what is on screen now" (row ids in the
// viewport); by default the whole log is in view. `older`: history exists below
// the loaded window.
function makeWorld(
  over: {messages?: Msg[]; broadcast?: ReadMarker; onScreen?: string[] | null; older?: boolean} = {}
) {
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
    // `back`: the marker was moved back (mark unread): the overlay is dropped
    effectiveMarkerOf: () => {
      if ((session as unknown as {back?: boolean}).back) overlay = undefined;
      return overlay ?? over.broadcast;
    }
  };
  const heardMarked: [string, ReadMarker][] = [];
  const hp = createHeardProgress({
    store,
    isLive: () => true,
    activeId: () => 's1',
    isChatViewOpen: () => true,
    onScreenRows: () =>
      over.onScreen === null ? undefined : (over.onScreen ?? session.messages.map((m) => m.id)),
    historyBelowWindow: () => over.older ?? false,
    onHeardMarked: (sid, marker) => heardMarked.push([sid, marker])
  });
  const view = (ids: string[] | null) => {
    over.onScreen = ids;
  };
  return {session, hp, sightings, heardMarked, view};
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
        msg({
          id: 3,
          ts: 201,
          kind: 'status',
          text: 'status: done',
          mid: undefined,
          role: undefined as never
        })
      ]
    });
    hp.markSeen('s1');
    expect(sightings).toEqual([{mid: 'mr-2', msgId: undefined, ts: 200}]);
  });
  test('a log of records only has nothing to sight', () => {
    const {hp, sightings} = makeWorld({
      messages: [
        msg({
          id: 1,
          ts: 10,
          kind: 'status',
          text: 'status: idle',
          mid: undefined,
          role: undefined as never
        })
      ]
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

describe('the one rule: read only what has been on screen (owner, 2026-10-03)', () => {
  const log = () => [
    msg({id: 1, ts: 100, mid: 'mr-1'}),
    msg({id: 2, ts: 200, mid: 'mr-2'}),
    msg({id: 3, ts: 300, mid: 'mr-3'})
  ];
  test('a reader scrolled up sights only the rows in view, not the reply below', () => {
    // The verifier's B1: the arrival raised "1 new below" AND marked the chat
    // read on every device, because the sighting named the newest row.
    const {hp, sightings} = makeWorld({messages: log(), onScreen: ['1', '2']});
    hp.reportViewedThrough('s1');
    expect(sightings).toEqual([{mid: 'mr-2', msgId: undefined, ts: 200}]);
  });
  test('leaving the chat sights what is on screen as it goes, no further', () => {
    const {hp, sightings} = makeWorld({messages: log(), onScreen: ['1']});
    hp.markSeen('s1');
    expect(sightings).toEqual([{mid: 'mr-1', msgId: undefined, ts: 100}]);
  });
  test('nothing on screen (another chat painted, the page hidden): nothing is read', () => {
    const {hp, sightings} = makeWorld({messages: log(), onScreen: null});
    hp.reportViewedThrough('s1');
    hp.markSeen('s1');
    expect(sightings).toEqual([]);
  });
  test('a pending own bubble on screen: the newest agent row with an identity is sighted', () => {
    const {hp, sightings} = makeWorld({
      messages: [...log(), msg({id: 4, ts: 400, mid: undefined, role: 'user'})]
    });
    hp.reportViewedThrough('s1');
    expect(sightings).toEqual([{mid: 'mr-3', msgId: undefined, ts: 300}]);
  });
});

describe('B2: the marker only moves through a contiguous run of rows that were on screen', () => {
  const log = () => [1, 2, 3, 4, 5].map((n) => msg({id: n, ts: n * 100, mid: `mr-${n}`}));
  test('a view the app jumped to the bottom reads none of the rows it skipped', () => {
    // The landing/re-open/deep landing ends at the bottom: rows 4-5 on screen,
    // 2-3 never were. The old rule read through 5 (and so 2-3 with it).
    const {hp, sightings} = makeWorld({
      messages: log(),
      broadcast: {mid: 'mr-1', ts: 100},
      onScreen: ['4', '5']
    });
    hp.reportViewedThrough('s1');
    expect(sightings).toEqual([]);
  });
  test('scrolling up through the skipped rows then completes the run', () => {
    const {hp, sightings, view} = makeWorld({
      messages: log(),
      broadcast: {mid: 'mr-1', ts: 100},
      onScreen: ['4', '5']
    });
    hp.reportViewedThrough('s1'); // the landing: nothing
    view(['3']);
    hp.noteOnScreen('s1'); // the reader drags up through 3...
    view(['2']);
    hp.reportViewedThrough('s1'); // ...and pauses on 2: 2-5 all seen
    expect(sightings).toEqual([{mid: 'mr-5', msgId: undefined, ts: 500}]);
  });
  test('a gap stops the run at the last row before it', () => {
    const {hp, sightings, view} = makeWorld({
      messages: log(),
      broadcast: {mid: 'mr-1', ts: 100},
      onScreen: ['2']
    });
    hp.noteOnScreen('s1');
    view(['4', '5']);
    hp.reportViewedThrough('s1');
    expect(sightings).toEqual([{mid: 'mr-2', msgId: undefined, ts: 200}]);
  });
  test('his own rows and the activity records do not have to be seen', () => {
    const {hp, sightings} = makeWorld({
      messages: [
        msg({id: 1, ts: 100, mid: 'mr-1'}),
        msg({id: 2, ts: 200, mid: 'mr-2', role: 'user'}),
        msg({
          id: 3,
          ts: 250,
          kind: 'status' as never,
          text: 'status: done',
          mid: undefined,
          role: undefined as never
        }),
        msg({id: 4, ts: 300, mid: 'mr-4'})
      ],
      broadcast: {mid: 'mr-1', ts: 100},
      onScreen: ['4']
    });
    hp.reportViewedThrough('s1');
    expect(sightings).toEqual([{mid: 'mr-4', msgId: undefined, ts: 300}]);
  });
  test('a marker below the loaded window, with older history unloaded, cannot be jumped', () => {
    const {hp, sightings} = makeWorld({
      messages: log(),
      broadcast: {mid: 'mr-0', ts: 50},
      older: true
    });
    hp.reportViewedThrough('s1');
    expect(sightings).toEqual([]);
  });
  test('the whole history loaded and all of it seen: read from the start', () => {
    const {hp, sightings} = makeWorld({messages: log(), broadcast: {mid: 'mr-0', ts: 50}});
    hp.reportViewedThrough('s1');
    expect(sightings).toEqual([{mid: 'mr-5', msgId: undefined, ts: 500}]);
  });
  test('a marker moved back (marked unread) needs the rows seen again', () => {
    const {hp, sightings, view, session} = makeWorld({
      messages: log(),
      broadcast: {mid: 'mr-1', ts: 100},
      onScreen: ['2', '3']
    });
    hp.reportViewedThrough('s1');
    expect(sightings.at(-1)).toEqual({mid: 'mr-3', msgId: undefined, ts: 300});
    view(['4']);
    hp.noteOnScreen('s1'); // 4 seen, not yet reported
    // marked unread elsewhere: the effective marker goes back to row 1
    (session as unknown as {back: boolean}).back = true;
    sightings.length = 0;
    view(['5']);
    hp.reportViewedThrough('s1');
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
      onScreenRows: () => ['1'],
      historyBelowWindow: () => false,
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
      onScreenRows: () => ['1'],
      historyBelowWindow: () => false,
      onHeardMarked: () => {}
    });
    hp.reportViewedThrough('s1');
    expect(sightings).toEqual([{mid: 'mr-5', msgId: undefined, ts: 5}]);
  });
});
