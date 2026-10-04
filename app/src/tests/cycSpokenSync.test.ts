import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('../audio/speaker', () => ({
  speaker: {pending: (): Set<string> => new Set(), stopAll() {}}
}));
vi.mock('../speechGate', () => ({mayStartSpeech: () => false}));

import * as intents from '../engine/intents';
import * as drain from '../engine/sync/drain';
import * as sync from '../engine/sync';
import {conns, sessions, type Conn} from '../engine/store/registry';
import {
  effectiveMarkerOf,
  forgetSighting,
  reportSighting,
  reportSpoken,
  spokenTsOf
} from '../engine/store/readState';
import type {CycEngineMessage, CycEngineSession} from '../engine/store';

// release-1 re-gate B2: how far speech has got is a SECOND engine-held fact
// beside the read marker. These pin the app's half: it rides the durable heard
// intent flagged `spoken`, never acts as a read sighting, and survives in the
// queue until the engine reflects it back.

const KEY = 'ws://spoken.test:7788/ws';
const SID = KEY + '|p1';

function plant(): CycEngineSession {
  const s = {
    id: SID,
    engineKey: KEY,
    paneId: 'p1',
    tabKey: '',
    name: 'p1',
    cwd: '',
    unread: 3,
    muted: false,
    thinking: false,
    alive: true,
    messages: [100, 200, 300].map(
      (ts) =>
        ({
          id: `m:mr-${ts}`,
          mid: `mr-${ts}`,
          role: 'claude',
          kind: 'text',
          text: 't',
          ts
        }) as CycEngineMessage
    ),
    readThrough: {mid: 'mr-100', ts: 100},
    claudeSessionId: null,
    events: [],
    agentRuns: []
  } as unknown as CycEngineSession;
  sessions.set(s.id, s);
  return s;
}

function plantConn(): unknown[][] {
  const sent: unknown[][] = [];
  conns.push({
    key: KEY,
    state: 'connected',
    failed: false,
    user: 'u',
    host: 'h',
    hostname: 'h',
    tabs: [],
    plugins: [],
    voiceHealthy: true,
    helloSettled: true,
    client: {
      heard: (...a: unknown[]) => {
        sent.push(a);
        return true;
      }
    }
  } as unknown as Conn);
  return sent;
}

beforeEach(() => {
  vi.useFakeTimers();
  sessions.clear();
  intents.__resetForTest();
  sync.__resetLiveForTest();
  drain.__resetForTest(() => 0.5);
  localStorage.clear();
});
afterEach(() => {
  drain.__resetForTest();
  vi.useRealTimers();
  conns.length = 0;
  sessions.clear();
});

describe('spoken is not read', () => {
  test('a queued spoken report is never a read overlay, and speech sees it at once', () => {
    const s = plant();
    reportSpoken(s.id, {mid: 'mr-300', ts: 300});
    expect(effectiveMarkerOf(s)?.mid).toBe('mr-100'); // the marker did not move
    expect(spokenTsOf(s)).toBe(300); // queued: holds across a reload with the intent
    // a read sighting coalesces apart from it
    reportSighting(s.id, {mid: 'mr-200', ts: 200});
    expect(effectiveMarkerOf(s)?.mid).toBe('mr-200');
    expect(spokenTsOf(s)).toBe(300);
  });
  test('the broadcast spoken mark is honoured with nothing queued (another device)', () => {
    const s = plant();
    s.spokenTs = 200;
    expect(spokenTsOf(s)).toBe(200);
    reportSpoken(s.id, {mid: 'mr-200', ts: 200}); // nothing new: not queued
    expect(intents.all()).toHaveLength(0);
  });
  test('the drain sends it as a heard frame flagged spoken', async () => {
    const sent = plantConn();
    sync.noteSealed(KEY);
    sync.noteHost(KEY);
    sync.noteSessions(KEY);
    const s = plant();
    reportSpoken(s.id, {mid: 'mr-300', ts: 300});
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([['p1', {mid: 'mr-300', msgId: undefined, ts: 300}, true]]);
  });
  test('mark unread drops a queued spoken report with the sighting', () => {
    const s = plant();
    reportSpoken(s.id, {mid: 'mr-300', ts: 300});
    reportSighting(s.id, {mid: 'mr-200', ts: 200});
    forgetSighting(s.id);
    expect(intents.all()).toHaveLength(0);
  });
});
