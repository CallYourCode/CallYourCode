/* THE PLUGIN'S BROADCAST DRIVES THE VIEW (#585).
 *
 * The engine owns the dials and redeclares its composer on every change, pushing
 * a `plugins` frame. The app reads the dial straight off that decl (pluginsOf),
 * never a local copy, so a slider moved anywhere lands on this device's composer
 * the moment the frame arrives -- no reload. This pins the seam: the `plugins`
 * frame replaces conn.plugins (what the composer reads) and schedules a repaint.
 */

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
vi.mock('@/shared/logging', () => ({cyclog: vi.fn(), setLogAutoShip: vi.fn()}));

import type {EnginePluginDecl} from '../engine/contract';
import {conns, renderSubs, type Conn} from '../engine/store/registry';
import {pluginsOf} from '../engine/store/plugins';
import {wireLiveness} from '../engine/store/handlers/liveness';
import type {HandlerCtx} from '../engine/store/handlers/types';

const KEY = 'ws://broadcast.test:7799/ws';

function fakeConn(): {conn: Conn; fire: (ev: string, ...a: unknown[]) => void} {
  const handlers: Record<string, (...a: never[]) => void> = {};
  const conn = {
    key: KEY,
    state: 'connected',
    user: 'u',
    host: 'h',
    hostname: 'h',
    tabs: [],
    plugins: [],
    voiceHealthy: true,
    helloSettled: true,
    client: {on: (ev: string, cb: (...a: never[]) => void) => (handlers[ev] = cb)}
  } as unknown as Conn;
  return {conn, fire: (ev, ...a) => handlers[ev]?.(...(a as never[]))};
}

// a reply-dials composer decl with the verbosity slider parked at `value`
function decl(value: number): EnginePluginDecl {
  return {
    id: 'reply-dials',
    name: 'Reply dials',
    version: 1,
    composer: [
      {
        type: 'slider',
        icon: 'equalizer',
        label: 'Verbosity',
        key: 'verbosity',
        value,
        steps: [{n: value, name: 'Chat', hint: 'chat'}]
      }
    ]
  } as unknown as EnginePluginDecl;
}

const sliderValue = (): number | undefined => {
  const w = pluginsOf(KEY)[0]?.composer?.[0] as {value?: number} | undefined;
  return w?.value;
};

let rig: ReturnType<typeof fakeConn>;
beforeEach(() => {
  vi.useFakeTimers();
  rig = fakeConn();
  conns.push(rig.conn);
  wireLiveness(rig.conn, {} as HandlerCtx);
});
afterEach(() => {
  const i = conns.indexOf(rig.conn);
  if (i >= 0) conns.splice(i, 1);
  renderSubs.clear();
  vi.useRealTimers();
});

test('a plugins frame replaces what the composer reads and schedules a repaint', () => {
  const painted = vi.fn();
  renderSubs.add(painted);

  // the view has no dial before any frame
  expect(sliderValue()).toBeUndefined();

  // first broadcast: the composer now reads verbosity 2 off the decl
  rig.fire('plugins', [decl(2)]);
  expect(sliderValue(), 'the view did not adopt the broadcast decl').toBe(2);
  vi.advanceTimersByTime(250);
  expect(painted, 'the broadcast did not schedule a repaint').toHaveBeenCalled();

  // a later broadcast (a slider moved on another device) moves the view again,
  // with nothing pushed or reloaded from this side
  painted.mockClear();
  rig.fire('plugins', [decl(4)]);
  expect(sliderValue(), 'a second broadcast did not update the view').toBe(4);
  vi.advanceTimersByTime(250);
  expect(painted).toHaveBeenCalled();
});
