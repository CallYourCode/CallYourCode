/* CONTRACT FIXTURE (engine <-> app): the running-subagents count on the wire.
 *
 * The live engine runs main's code and does not yet send `subagentsRunning`, so
 * the browser check injects this exact frame through the app's test hooks. This
 * test drives the SAME frame through the SHIPPED sessions-frame handler and
 * pins the contract the app relies on: a positive count parses onto the
 * EngineSession, and an absent one (a chat with no subagents) leaves the field
 * off so the row draws no chip.
 *
 *   npx vitest run src/tests/cycSubagentsFrame.test.ts
 */
import {describe, expect, test} from 'vitest';

import {dispatchFrame} from '../engine/frames';
import type {FrameContext} from '../engine/frames/types';
import type {EngineSession} from '../engine/contract';
import fixture from '../testing/fixtures/subagentsFrame.json';

function capture(): {ctx: FrameContext; sessions: () => EngineSession[]} {
  let list: EngineSession[] = [];
  const ctx = {
    url: 'ws://engine',
    emit: (ev: string, ...args: unknown[]) => {
      if (ev === 'sessions') list = args[0] as EngineSession[];
    },
    engineObjectUrl: (p: string) => p,
    rememberUserHost: () => {},
    canDo: new Set<string>(),
    voiceHealthyState: false,
    attachedId: '',
    tailedId: null,
    terms: new Map()
  } as unknown as FrameContext;
  return {ctx, sessions: () => list};
}

describe('subagentsRunning on the sessions frame', () => {
  test('a positive count parses onto the row; an absent one stays off', () => {
    const {ctx, sessions} = capture();
    dispatchFrame(ctx, fixture);
    const list = sessions();
    const busy = list.find((s) => s.id === 'ws://engine|p1')!;
    const quiet = list.find((s) => s.id === 'ws://engine|p2')!;
    expect(busy.subagentsRunning).toBe(5);
    expect('subagentsRunning' in quiet).toBe(false);
  });

  test('a non-positive or non-integer count is not carried', () => {
    const {ctx, sessions} = capture();
    dispatchFrame(ctx, {
      t: 'sessions',
      list: [
        {id: 'a', name: 'a', cwd: '', alive: true, subagentsRunning: 0},
        {id: 'b', name: 'b', cwd: '', alive: true, subagentsRunning: -3},
        {id: 'c', name: 'c', cwd: '', alive: true, subagentsRunning: 'x'},
        {id: 'd', name: 'd', cwd: '', alive: true, subagentsRunning: 2.9}
      ]
    });
    const [a, b, c, d] = sessions();
    expect('subagentsRunning' in a).toBe(false);
    expect('subagentsRunning' in b).toBe(false);
    expect('subagentsRunning' in c).toBe(false);
    // a fractional count is floored to a whole number of agents
    expect(d.subagentsRunning).toBe(2);
  });
});
