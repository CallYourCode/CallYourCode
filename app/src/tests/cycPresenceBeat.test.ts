import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// The owner, 2026-10-03: the engine decided "all say backgrounded" while the
// owner says they were on the chat, and neither side logged which page event sent the
// hidden claim. Every presence transition is now logged with its trigger, and
// the trigger rides the frame so the engine's presence line names it too.
const fake = vi.hoisted(() => ({
  status: 'live' as string,
  sent: [] as Array<[boolean, string | undefined]>,
  logged: [] as Array<{event: string; fields: Record<string, unknown>}>
}));
vi.mock('../engine/store', () => ({
  syncStatus: () => fake.status,
  setVisible: (on: boolean, why?: string) => fake.sent.push([on, why]),
  onSyncStatus: () => () => {}
}));
vi.mock('../audio/speaker', () => ({
  speaker: {gateChanged: vi.fn(), pause: vi.fn(), isPlaying: () => false, onState: () => () => {}}
}));
vi.mock('../audio/pipeline', () => ({pipeline: {handsFreeSessionId: null}}));
vi.mock('../speechGate', () => ({TOUCH_DEVICE: true}));
vi.mock('@/shared/logging', () => ({
  cyclog: (event: string, fields: Record<string, unknown> = {}) => fake.logged.push({event, fields})
}));

import {installPresenceBeat} from '../presenceBeat';
import {dataState} from '../sessionState';

let teardowns: Array<() => void> = [];
beforeEach(() => {
  fake.status = 'live';
  fake.sent = [];
  fake.logged = [];
  dataState.mode = 'live';
  installPresenceBeat({onTeardown: (d) => teardowns.push(d), speakUnheard: vi.fn()});
});
afterEach(() => {
  for (const d of teardowns) d();
  teardowns = [];
});

const reports = () => fake.logged.filter((l) => l.event === 'presence.report').map((l) => l.fields);

describe('presence transitions name their trigger', () => {
  test('a blur sends the hidden claim with why=blur, and the log says so', () => {
    expect(fake.sent.at(-1)).toEqual([true, 'install']);
    window.dispatchEvent(new Event('blur'));
    expect(fake.sent.at(-1)).toEqual([false, 'blur']);
    expect(reports().at(-1)).toMatchObject({on: false, why: 'blur', sent: true});
    expect(reports().at(-1)).toHaveProperty('vis');
    expect(reports().at(-1)).toHaveProperty('focus');

    window.dispatchEvent(new Event('focus'));
    expect(fake.sent.at(-1)).toEqual([true, 'focus']);
    expect(reports().at(-1)).toMatchObject({on: true, why: 'focus'});
  });

  test('a beat restating the same claim is sent but not logged again', () => {
    const before = reports().length;
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    expect(fake.sent.filter(([on]) => on)).toHaveLength(3); // install + two focus
    expect(reports()).toHaveLength(before);
  });

  test('a claim the sync could not send is logged as not sent', () => {
    fake.status = 'draining';
    window.dispatchEvent(new Event('pagehide'));
    expect(reports().at(-1)).toMatchObject({on: false, why: 'pagehide', sent: false});
    expect(fake.sent.at(-1)).toEqual([true, 'install']); // nothing left the page
  });
});
