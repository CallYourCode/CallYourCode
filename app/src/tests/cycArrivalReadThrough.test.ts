import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

vi.mock('../audio/speaker', () => ({
  speaker: {pending: (): Set<string> => new Set(), stopAll() {}}
}));
vi.mock('../speechGate', () => ({mayStartSpeech: () => true}));

import {sessions} from '../engine/store/registry';
import {
  applyBroadcastReadThrough,
  mayAutoplayArrival,
  noteReadStateFresh,
  __resetReadStateFreshForTest
} from '../engine/store/readState';
import type {CycEngineMessage, CycEngineSession} from '../engine/store';

/* THE OLD-CLIP ARRIVAL DEFECT (field, 2026-09-29/30), reproduced through the
 * real read-state path. PROVEN in the logs (app.log, iPhone dev=726ju): opening
 * a chat autoplayed a clip whose row sits ~200-275 read rows behind this
 * device's read-through -- the owner's "I opened BZ Builder and it played a very
 * old audio". speakUnheard was already gated on the engine read state
 * (fix-heard-sync); the say-frame arrival path (storeBindings.handleSay) was not,
 * so any say the app received while the chat was open autoplayed regardless of
 * where the row sat. mayAutoplayArrival is the gate both paths now share: a clip
 * autoplays only when its row is AT OR AFTER the read-through and the read state
 * is fresh on this connection.
 *
 * Each field case below is a real msgId from the logs, planted ~N read rows
 * behind the read-through exactly as it was on disk. Before this gate handleSay
 * played every one; each now returns false (never autoplays), while the live
 * tail reply -- the row at the read-through -- still returns true. */

const KEY = 'ws://arrival.test:7788/ws';
const SID = KEY + '|p1';

function claude(n: number, ts: number, msgId: string): CycEngineMessage {
  return {
    id: `m:${msgId}`,
    role: 'claude',
    kind: 'text',
    text: `reply ${n}`,
    ts,
    mid: msgId,
    msgId
  } as unknown as CycEngineMessage;
}

function plant(messages: CycEngineMessage[]): CycEngineSession {
  const s = {
    id: SID,
    engineKey: KEY,
    paneId: 'p1',
    name: 'p1',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages,
    events: [],
    agentRuns: []
  } as unknown as CycEngineSession;
  sessions.set(s.id, s);
  return s;
}

beforeEach(() => {
  sessions.clear();
  __resetReadStateFreshForTest();
});
afterEach(() => {
  sessions.clear();
  __resetReadStateFreshForTest();
});

// The four field msgIds, each with how many CLAUDE rows the log had after it.
const FIELD_CASES = [
  {msgId: '96708b12-e17d-454a-923c-ab15e45a668c', after: 20, who: 'BZ Builder 23:49:19'},
  {msgId: 'cfbde770-274f-4949-82b3-b168f643407c', after: 18, who: 'BZ Builder 23:49:33'},
  {msgId: '042dd2f7-c517-4123-961d-5c629d481678', after: 24, who: 'BZ Builder 18:29:07'},
  {msgId: 'af715a44-d03a-4e20-a857-e8bfba4abda3', after: 3, who: 'Shalu AI 08:24:36'}
];

describe('the arrival path only autoplays a genuinely-unheard row', () => {
  for (const c of FIELD_CASES) {
    test(`${c.who}: the old clip behind the read-through never autoplays`, () => {
      // The old row, then `after` claude rows read past it; the read-through is
      // the newest (the tail is what this device has read through).
      const old = claude(0, 1000, c.msgId);
      const rest: CycEngineMessage[] = [];
      for (let i = 1; i <= c.after; i++) rest.push(claude(i, 1000 + i * 1000, `mr-tail-${i}`));
      const tail = rest[rest.length - 1];
      const s = plant([old, ...rest]);
      applyBroadcastReadThrough(s, {mid: tail.mid, ts: tail.ts});
      noteReadStateFresh(SID);

      // The bug: this returned autoplay for the old row. It now never does.
      expect(mayAutoplayArrival(SID, c.msgId)).toBe(false);
      // A genuine live reply -- the tail row at the read-through -- still speaks.
      expect(mayAutoplayArrival(SID, tail.msgId!)).toBe(true);
    });
  }

  test('a live reply just past the read-through autoplays (arrival still speaks)', () => {
    const read = claude(1, 1000, 'mr-read');
    const fresh = claude(2, 2000, 'mr-new');
    const s = plant([read, fresh]);
    applyBroadcastReadThrough(s, {mid: read.mid, ts: read.ts});
    noteReadStateFresh(SID);
    expect(mayAutoplayArrival(SID, 'mr-new')).toBe(true);
  });

  test('a chat the engine reports nothing read in speaks its loaded reply', () => {
    const only = claude(1, 1000, 'mr-only');
    plant([only]);
    // No readThrough applied: the engine reports nothing read here.
    noteReadStateFresh(SID);
    expect(mayAutoplayArrival(SID, 'mr-only')).toBe(true);
  });

  test('a cold open before the engine refreshes the read state autoplays nothing', () => {
    const old = claude(1, 1000, 'mr-old');
    const tail = claude(2, 2000, 'mr-tail');
    const s = plant([old, tail]);
    applyBroadcastReadThrough(s, {mid: tail.mid, ts: tail.ts});
    // readStateFreshOnConn is NOT set: the marker is the stale cached roster
    // value, so no autoplay decision is made yet -- exactly as speakUnheard defers.
    expect(mayAutoplayArrival(SID, 'mr-tail')).toBe(false);
    expect(mayAutoplayArrival(SID, 'mr-old')).toBe(false);
  });

  test('a say for a row not in the loaded window never autoplays', () => {
    const tail = claude(1, 1000, 'mr-tail');
    const s = plant([tail]);
    applyBroadcastReadThrough(s, {mid: tail.mid, ts: tail.ts});
    noteReadStateFresh(SID);
    // A live arrival's row is written by the `chat` frame before its `say`, so it
    // is always loaded; an unloaded msgId is an old backfilled row, never played.
    expect(mayAutoplayArrival(SID, 'mr-not-loaded')).toBe(false);
  });

  /* THE STALE-CACHE FIELD DEFECT (fix-old-clip-attach), the exact shape proven in
   * app.log (dev=ynmi0/726ju, four replays of msg ba4e8abb, a 2-day-old FINALISED
   * speak clip -- not a stranded growing one): a device that slept while the owner
   * read on the laptop opens onto a cached window whose NEWEST loaded row is BEHIND
   * the engine's read-through. The read-through row is on a NEWER, unloaded page,
   * so its marker does not resolve in the window. The old guard returned true for
   * every loaded row then ("marker on an older page"), so the newest OLD spoken
   * clip in the stale window autoplayed as a fresh arrival. */
  test('the stale cache (read-through newer than the loaded window) never autoplays an old clip', () => {
    // The loaded window: an old spoken clip and a few later ones, every loaded row
    // BEHIND the read-through. ba4e8abb-shaped: `old` is the newest spoken clip here.
    const old = claude(0, 1000, 'mr-old-speak');
    const mid = claude(1, 2000, 'mr-mid-speak');
    const newestLoaded = claude(2, 3000, 'mr-newest-loaded');
    const s = plant([old, mid, newestLoaded]);
    // The engine's read-through names a row NEWER than anything loaded (the owner
    // read past the whole cached window elsewhere) and absent from the window.
    applyBroadcastReadThrough(s, {mid: 'mr-readthrough-unloaded', ts: 9000});
    noteReadStateFresh(SID);
    // Before the fix each of these returned true (markerIdx < 0 -> true). Nothing
    // in a window that sits entirely behind the read-through is unheard.
    expect(mayAutoplayArrival(SID, 'mr-old-speak')).toBe(false);
    expect(mayAutoplayArrival(SID, 'mr-mid-speak')).toBe(false);
    expect(mayAutoplayArrival(SID, 'mr-newest-loaded')).toBe(false);
  });

  test('the read-through aged out to an OLDER page: a genuinely newer loaded reply still speaks', () => {
    // The marker is older than every loaded row and not in the window (it scrolled
    // off the top). A live arrival past it must still autoplay -- the inclusive,
    // at-or-after-the-marker-instant branch, extended to an unloaded older marker.
    const read = claude(1, 5000, 'mr-read');
    const arrival = claude(2, 8000, 'mr-arrival');
    const s = plant([read, arrival]);
    applyBroadcastReadThrough(s, {mid: 'mr-older-unloaded', ts: 1000});
    noteReadStateFresh(SID);
    expect(mayAutoplayArrival(SID, 'mr-arrival')).toBe(true);
  });
});
