import {describe, expect, test} from 'vitest';
import {
  agentPollDelay,
  AGENT_POLL_IDLE_MS,
  AGENT_POLL_THINKING_MS
} from '../engine/agentPollCadence';

// The agents poll cadence follows the attached session's busy state: nothing on
// the wire pushes agent runs, so the open chat polls, quick while the session is
// thinking and slow while it is idle. The selection is a pure function of that
// one bit; the store wires it to the live thinking state and the visibility gate.
describe('agentPollDelay', () => {
  test('thinking selects the quick 15 s cadence', () => {
    expect(agentPollDelay(true)).toBe(AGENT_POLL_THINKING_MS);
    expect(agentPollDelay(true)).toBe(15_000);
  });

  test('idle selects the slow 5 min cadence', () => {
    expect(agentPollDelay(false)).toBe(AGENT_POLL_IDLE_MS);
    expect(agentPollDelay(false)).toBe(5 * 60_000);
  });

  test('the quick cadence is strictly faster than the idle one', () => {
    expect(agentPollDelay(true)).toBeLessThan(agentPollDelay(false));
  });

  test('it is pure: the same bit always yields the same delay', () => {
    expect(agentPollDelay(true)).toBe(agentPollDelay(true));
    expect(agentPollDelay(false)).toBe(agentPollDelay(false));
  });
});
