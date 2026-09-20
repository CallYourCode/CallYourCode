import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import * as intents from '../engine/intents';
import {APP_ENGINE_KEY} from '../engine/intents';
import * as drain from '../engine/sync/drain';
import * as sync from '../engine/sync/connection';
import {globalSettings, setGlobalSettings, startSettingsSync} from '../engine/settings';

// Global settings under offline design v2: settings are read on edges, never on
// an idle timer -- once when the sync first goes live and again on every return
// to live (a foreground return refreshes too, through visibilitychange). A
// change is shown at once and queued as a global-settings intent under the app
// server's key, and it drains on the next settled edge of any engine. A refresh
// keeps the pending patch on top of the server's copy until the server has it.

const K = 'ws://settings.test/ws';
const calls: {method: string; body?: unknown}[] = [];
let server: Record<string, unknown> = {speed: 1, seq: 1};

vi.mock('../engine/appFetch', () => ({
  appFetch: async (_path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({method, body});
    if (method === 'POST') server = {...server, ...body, seq: Number(server.seq) + 1};
    return new Response(JSON.stringify(server), {status: 200});
  }
}));

function settle() {
  sync.noteSealed(K);
  sync.noteHost(K);
  sync.noteSessions(K);
}
const tick = () => vi.advanceTimersByTimeAsync(1);

describe('settings sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
    intents.__resetForTest();
    sync.__resetForTest();
    drain.__resetForTest(() => 0.5);
  });
  afterEach(() => {
    drain.__resetForTest();
    vi.useRealTimers();
  });

  test('reads on the live edge, never on a timer; a change offline is shown, queued, and sent on the edge', async () => {
    startSettingsSync();
    await tick();
    expect(calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    // Live: one refresh now. Settings starts no timer of its own; time passing
    // adds no further read (any timer left is the drain's, not a settings poll).
    settle();
    await tick();
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    // Time passing changes nothing: there is no poll.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.map((c) => c.method)).toEqual(['GET']);

    // Down: still nothing ticks.
    sync.noteDown(K);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);

    // A change offline: shown at once, queued under the app key, no POST.
    const done = setGlobalSettings({speed: 2});
    await tick();
    expect(globalSettings().speed).toBe(2);
    expect(intents.forEngine(APP_ENGINE_KEY)).toMatchObject([
      {kind: 'global-settings', coalesceKey: 'gset:app', state: 'queued', payload: {patch: {speed: 2}}}
    ]);
    expect(calls).toHaveLength(1);
    // A second change folds into the same row.
    void setGlobalSettings({sound: false});
    expect(intents.forEngine(APP_ENGINE_KEY)).toHaveLength(1);
    expect(intents.forEngine(APP_ENGINE_KEY)[0].payload).toEqual({patch: {speed: 2, sound: false}});

    // The edge: the refresh keeps the pending patch on top, the POST goes.
    settle();
    await tick();
    expect(await done).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.slice(1).map((c) => c.method).sort()).toEqual(['GET', 'POST']);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({speed: 2, sound: false});
    expect(intents.forEngine(APP_ENGINE_KEY)).toEqual([]);
    expect(globalSettings().speed).toBe(2);
    expect(globalSettings().sound).toBe(false);
  });
});
