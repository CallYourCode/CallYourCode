import {beforeEach, describe, expect, test, vi} from 'vitest';

/* SPEECH-ON-OPEN WAITS FOR THE ENGINE'S TRUTH, THEN DERIVES FROM THE COUNT
 * (fix-heard-sync).
 *
 * The reported bug: read the messages on the laptop, come back on the phone,
 * and it "plays some old audio message"; the unread counter and the unspoken
 * audio are out of sync. PROVEN in the field (app.log 2026-09-29T00:17:31-38):
 * a cold boot from a notification tap paints the cached window (unread 0, no
 * marker -- readThrough is not persisted), autoplays clips, and only THEN does
 * the engine's current read state (sync.catchup) arrive ~1s later.
 *
 * Two things were wrong. speakUnheard decided what to speak from the STALE
 * cached read state, before the engine refreshed it on this connection; and its
 * selection did not derive from the unread COUNT the divider uses (it replayed
 * the whole window when the marker was unknown, and went silent when a
 * read-through row aged out of the window even though a genuine reply was
 * unheard). These tests drive the real speakUnheard.
 */

vi.mock('../shared/capabilities', () => ({touchCapable: false, prefersMotion: () => false}));

const hooks = vi.hoisted(() => ({
  pendingSet: new Set<string>(),
  stopAll: vi.fn(),
  currentSession: undefined as unknown,
  // The engine has refreshed this session's read state on the current
  // connection (readState.readStateFreshOnConn). Default true: the steady-state
  // open. The cold-boot / reconnect tests flip it to model the catchup arriving.
  fresh: true,
  // The read-through marker effectiveMarkerOf resolves; a getter so a single
  // test can model the stale (undefined) state before the catchup and the
  // engine's identity after it.
  marker: undefined as unknown
}));
vi.mock('../audio/speaker', () => ({
  speaker: {pending: (): Set<string> => hooks.pendingSet, stopAll: hooks.stopAll}
}));
vi.mock('../speechGate', () => ({mayStartSpeech: () => true}));
vi.mock('../engine/store', () => ({
  get: (): unknown => hooks.currentSession,
  readStateFreshOnConn: (): boolean => hooks.fresh,
  onReadStateFresh: () => () => {}
}));

import type {CycMessage, CycSession} from '../types';
const pendingSet = hooks.pendingSet;
const stopAll = hooks.stopAll;
type EngineSession = CycSession & {messages: CycMessage[]; engineUnread?: number};
const setSession = (s: EngineSession | undefined) => {
  hooks.currentSession = s;
};
const setFresh = (f: boolean) => {
  hooks.fresh = f;
};
const setMarker = (m: ReadMarker | undefined) => {
  hooks.marker = m;
};
import {dataState, sessionState} from '../sessionState';
import {createReaderLanding} from '../features/chat/surface/readerLanding';
import type {ReadMarker} from '../engine/store/readState';

function claude(n: number, ts: number): CycMessage {
  return {
    id: `m:mr-${n}`,
    role: 'claude',
    kind: 'text',
    text: `reply ${n}`,
    ts,
    mid: `mr-${n}`,
    msgId: `mr-${n}`
  } as CycMessage;
}

// The marker resolves by IDENTITY (its mid) against the loaded window, exactly
// as readState.effectiveMarkerOf does; hooks.marker is read live so a test can
// model the marker arriving with the catchup. A marker whose mid is NOT in the
// window models the aged-out (older-page) reopen case.
function makeReader(played: {sessionId: string; msgId: string}[]) {
  const inner = document.createElement('div');
  const scroll = document.createElement('div');
  scroll.append(inner);
  return createReaderLanding({
    deps: {
      heardTsOf: () => (hooks.marker as ReadMarker | undefined)?.ts ?? 0,
      readMarkerOf: () => hooks.marker as ReadMarker | undefined,
      play: (sessionId, msgId) => played.push({sessionId, msgId}),
      suppressAutoSpeak: () => false,
      isChatViewOpen: () => true
    },
    messages: inner,
    scroll,
    silentScrollTo: () => {},
    openMarker: () => hooks.marker as ReadMarker | undefined,
    setOpenMarker: () => {}
  });
}

beforeEach(() => {
  pendingSet.clear();
  stopAll.mockClear();
  dataState.mode = 'live';
  sessionState.activeId = 's1';
  hooks.fresh = true;
  hooks.marker = undefined;
});

describe('speech-on-open waits for the engine, then derives from the unread count', () => {
  test('cold boot from a notification tap: nothing until the catchup, then only the new reply', () => {
    // The real occurrence. The cache paints the loaded window -- five
    // already-heard replies and one genuinely unheard reply at the tail. The
    // attached chat's badge is zeroed by the store; the engine count rides
    // alongside it (engineUnread). Persisted read state is stale: unread 0, no
    // marker (readThrough is not persisted).
    const heard = [1, 2, 3, 4, 5].map((n) => claude(n, n * 1000));
    const newReply = claude(6, 6000);
    const session: EngineSession = {
      id: 's1',
      name: 's1',
      messages: [...heard, newReply],
      unread: 0,
      engineUnread: 0
    } as EngineSession;
    setSession(session);
    const played: {sessionId: string; msgId: string}[] = [];
    const reader = makeReader(played);

    // BEFORE the catchup: read state not refreshed on this connection, marker
    // undefined. The OLD code swept the whole loaded window from the top here
    // (`ts > heard=0`, or `!marker -> start=0`). The fix speaks nothing.
    setFresh(false);
    setMarker(undefined);
    reader.speakUnheard('s1');
    expect(played).toEqual([]);

    // The catchup (sync.catchup) lands: readThrough on the last already-heard
    // row (mr-5, in the window) and engine unread 1. Speech runs now and speaks
    // ONLY the new reply -- in sync with the count.
    setFresh(true);
    setMarker({mid: 'mr-5', ts: 5000});
    session.engineUnread = 1;
    reader.speakUnheard('s1');
    expect(played.map((p) => p.msgId)).toEqual(['mr-6']);
  });

  test('defers even a genuinely unheard reply until the read state is refreshed on this connection', () => {
    // Isolates the GATE from the count: there IS a real unheard reply (marker in
    // window, engine unread 1), but the read state has not been refreshed on this
    // connection yet, so speech waits rather than acting on possibly-stale truth.
    const session: EngineSession = {
      id: 's1',
      name: 's1',
      messages: [claude(1, 100), claude(2, 200)],
      unread: 0,
      engineUnread: 1
    } as EngineSession;
    setSession(session);
    setMarker({mid: 'mr-1', ts: 100});
    const played: {sessionId: string; msgId: string}[] = [];
    const reader = makeReader(played);

    setFresh(false);
    reader.speakUnheard('s1');
    expect(played).toEqual([]);

    setFresh(true);
    reader.speakUnheard('s1');
    expect(played.map((p) => p.msgId)).toEqual(['mr-2']);
  });

  test('caught up (engine unread 0): speaks nothing', () => {
    const session: EngineSession = {
      id: 's1',
      name: 's1',
      messages: [claude(1, 100), claude(2, 200), claude(3, 300)],
      unread: 0,
      engineUnread: 0
    } as EngineSession;
    setSession(session);
    setMarker({mid: 'mr-3', ts: 300});
    const played: {sessionId: string; msgId: string}[] = [];
    const reader = makeReader(played);

    reader.speakUnheard('s1');

    expect(played).toEqual([]);
  });

  test('normal open with one new reply: speaks it', () => {
    const session: EngineSession = {
      id: 's1',
      name: 's1',
      messages: [claude(1, 100), claude(2, 200), claude(3, 300)],
      unread: 0,
      engineUnread: 1
    } as EngineSession;
    setSession(session);
    setMarker({mid: 'mr-2', ts: 200});
    const played: {sessionId: string; msgId: string}[] = [];
    const reader = makeReader(played);

    reader.speakUnheard('s1');

    expect(played.map((p) => p.msgId)).toEqual(['mr-3']);
  });

  test('nothing read yet (marker undefined): speaks the newest N the engine counts', () => {
    const session: EngineSession = {
      id: 's1',
      name: 's1',
      messages: [claude(1, 100), claude(2, 200)],
      unread: 0,
      engineUnread: 2
    } as EngineSession;
    setSession(session);
    setMarker(undefined);
    const played: {sessionId: string; msgId: string}[] = [];
    const reader = makeReader(played);

    reader.speakUnheard('s1');

    expect(played.map((p) => p.msgId)).toEqual(['mr-1', 'mr-2']);
  });

  test('a clip already queued is not enqueued again', () => {
    const session: EngineSession = {
      id: 's1',
      name: 's1',
      messages: [claude(1, 100), claude(2, 200), claude(3, 300)],
      unread: 0,
      engineUnread: 2
    } as EngineSession;
    setSession(session);
    setMarker({mid: 'mr-1', ts: 100});
    pendingSet.add('mr-2');
    const played: {sessionId: string; msgId: string}[] = [];
    const reader = makeReader(played);

    reader.speakUnheard('s1');

    expect(played.map((p) => p.msgId)).toEqual(['mr-3']);
  });
});

describe('an aged-out read-through row speaks the newest N, never silence and never the window', () => {
  test('engine unread 1 with a genuine new reply: speaks exactly that reply', () => {
    // The verifier-flagged regression: the loaded window holds the tail; the
    // read-through row (mid=held, ts=5000) is on an OLDER page, and mr-2 happens
    // to share its instant. mr-3 was already heard on the laptop; only mr-4 is
    // genuinely unheard (engine unread 1). The prior branch returned silently on
    // this shape and dropped mr-4. The fix speaks the newest 1 = mr-4.
    const session: EngineSession = {
      id: 's1',
      name: 's1',
      messages: [claude(1, 1000), claude(2, 5000), claude(3, 6000), claude(4, 9000)],
      unread: 0,
      engineUnread: 1
    } as EngineSession;
    setSession(session);
    setMarker({mid: 'held', ts: 5000});
    const played: {sessionId: string; msgId: string}[] = [];
    const reader = makeReader(played);

    reader.speakUnheard('s1');

    // The already-heard clip (mr-3) is NOT replayed; the ts scan would have swept
    // it in. Identity + count speak only the newest unread reply.
    expect(played.map((p) => p.msgId)).not.toContain('mr-3');
    expect(played.map((p) => p.msgId)).toEqual(['mr-4']);
  });

  test('engine unread N: speaks exactly the newest N claude rows', () => {
    const session: EngineSession = {
      id: 's1',
      name: 's1',
      messages: [claude(1, 1000), claude(2, 5000), claude(3, 6000), claude(4, 9000)],
      unread: 0,
      engineUnread: 2
    } as EngineSession;
    setSession(session);
    setMarker({mid: 'held', ts: 5000});
    const played: {sessionId: string; msgId: string}[] = [];
    const reader = makeReader(played);

    reader.speakUnheard('s1');

    expect(played.map((p) => p.msgId)).toEqual(['mr-3', 'mr-4']);
  });
});
