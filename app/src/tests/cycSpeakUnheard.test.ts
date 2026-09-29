import {beforeEach, describe, expect, test, vi} from 'vitest';

/* SPEECH AND THE COUNT DERIVE FROM THE SAME MARKER (fix-heard-sync).
 *
 * The unread count and the divider anchor on the read-through ROW IDENTITY
 * (readState.markerIndexIn / readerLanding.firstUnheardId). Speech-on-open
 * (speakUnheard) used to select the to-play set by a TIMESTAMP scan
 * (`message.ts > heard`) instead. The two disagree exactly in the cases the
 * identity marker exists to survive -- a restamp, a mis-sorted legacy page, or a
 * read-through row that aged out of the loaded window while a ts twin sits in it.
 * There, the divider correctly places nothing (or the one true unread row) while
 * the ts scan queued an ALREADY-HEARD clip: the owner's "come back on the phone
 * and it plays some old audio message". These tests drive the real speakUnheard.
 */

vi.mock('../shared/capabilities', () => ({touchCapable: false, prefersMotion: () => false}));

const hooks = vi.hoisted(() => ({
  pendingSet: new Set<string>(),
  stopAll: vi.fn(),
  currentSession: undefined as unknown
}));
vi.mock('../audio/speaker', () => ({
  speaker: {pending: (): Set<string> => hooks.pendingSet, stopAll: hooks.stopAll}
}));
vi.mock('../speechGate', () => ({mayStartSpeech: () => true}));
vi.mock('../engine/store', () => ({
  get: (): unknown => hooks.currentSession
}));

import type {CycMessage, CycSession} from '../types';
const pendingSet = hooks.pendingSet;
const stopAll = hooks.stopAll;
const setSession = (s: (CycSession & {messages: CycMessage[]}) | undefined) => {
  hooks.currentSession = s;
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
// as readState.effectiveMarkerOf does. A test may hand a marker whose row is
// NOT in the window (aged out to an older page) to model the reopen case.
function makeReader(
  session: CycSession & {messages: CycMessage[]},
  marker: ReadMarker | undefined,
  played: {sessionId: string; msgId: string}[]
) {
  const inner = document.createElement('div');
  const scroll = document.createElement('div');
  scroll.append(inner);
  return createReaderLanding({
    deps: {
      heardTsOf: () => marker?.ts ?? 0,
      readMarkerOf: () => marker,
      play: (sessionId, msgId) => played.push({sessionId, msgId}),
      suppressAutoSpeak: () => false,
      isChatViewOpen: () => true
    },
    messages: inner,
    scroll,
    silentScrollTo: () => {},
    openMarker: () => marker,
    setOpenMarker: () => {}
  });
}

beforeEach(() => {
  pendingSet.clear();
  stopAll.mockClear();
  dataState.mode = 'live';
  sessionState.activeId = 's1';
});

describe('speakUnheard plays only the rows after the read-through IDENTITY', () => {
  test('a read-through row that aged out of the window never replays an in-window read clip', () => {
    // The exact owner shape (cycReaderLanding "ts twin" case): the loaded window
    // holds the tail; the read-through row (mid=held, ts=5000) is on an older
    // page, and row 2 happens to share its instant. Engine unread=1 (the tail).
    const messages = [
      claude(1, 1000), // read long ago
      claude(2, 5000), // a mid-history row sharing the held marker instant
      claude(3, 6000), // ALREADY HEARD on the laptop
      claude(4, 9000) // the one genuinely unread reply at the tail
    ];
    const session = {id: 's1', name: 's1', messages, unread: 1} as CycSession &
      {messages: CycMessage[]};
    setSession(session);
    const played: {sessionId: string; msgId: string}[] = [];
    const reader = makeReader(session, {mid: 'held', ts: 5000}, played);

    reader.speakUnheard('s1');

    // The already-heard clip (mr-3, ts 6000) must NEVER autoplay here: its row
    // sits BEFORE the read-through identity. The ts scan queued it; identity
    // does not. An unanchorable marker plays nothing, the same as the divider
    // landing at bottom -- the owner reaches the tail by scrolling / tapping.
    expect(played.map((p) => p.msgId)).not.toContain('mr-3');
    expect(played).toEqual([]);
  });

  test('normal open: speaks only claude rows after the marker identity', () => {
    const messages = [claude(1, 100), claude(2, 200), claude(3, 300)];
    const session = {id: 's1', name: 's1', messages, unread: 1} as CycSession &
      {messages: CycMessage[]};
    setSession(session);
    const played: {sessionId: string; msgId: string}[] = [];
    const reader = makeReader(session, {mid: 'mr-2', ts: 200}, played);

    reader.speakUnheard('s1');

    expect(played.map((p) => p.msgId)).toEqual(['mr-3']);
  });

  test('caught up: the marker on the tail reply speaks nothing', () => {
    const messages = [claude(1, 100), claude(2, 200), claude(3, 300)];
    const session = {id: 's1', name: 's1', messages, unread: 0} as CycSession &
      {messages: CycMessage[]};
    setSession(session);
    const played: {sessionId: string; msgId: string}[] = [];
    const reader = makeReader(session, {mid: 'mr-3', ts: 300}, played);

    reader.speakUnheard('s1');

    expect(played).toEqual([]);
  });

  test('nothing read yet: speaks every claude row from the top', () => {
    const messages = [claude(1, 100), claude(2, 200)];
    const session = {id: 's1', name: 's1', messages, unread: 2} as CycSession &
      {messages: CycMessage[]};
    setSession(session);
    const played: {sessionId: string; msgId: string}[] = [];
    const reader = makeReader(session, undefined, played);

    reader.speakUnheard('s1');

    expect(played.map((p) => p.msgId)).toEqual(['mr-1', 'mr-2']);
  });

  test('a clip already queued is not enqueued again', () => {
    const messages = [claude(1, 100), claude(2, 200), claude(3, 300)];
    const session = {id: 's1', name: 's1', messages, unread: 2} as CycSession &
      {messages: CycMessage[]};
    setSession(session);
    pendingSet.add('mr-2');
    const played: {sessionId: string; msgId: string}[] = [];
    const reader = makeReader(session, {mid: 'mr-1', ts: 100}, played);

    reader.speakUnheard('s1');

    expect(played.map((p) => p.msgId)).toEqual(['mr-3']);
  });
});
