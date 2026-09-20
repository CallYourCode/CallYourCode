// Agent runs are pull-only today: nothing on the wire pushes them (the engine's
// `GET /session-agents/:id` is pull only), so the open chat has to ask. The
// cadence follows the attached session's busy state: quick while it is thinking
// so the agents bar tracks the sub-agent runs the session spawns right when
// they matter, slow while it is idle so an untouched phone stays cool. The
// selection is a pure function of that one bit, so the store can reason about it
// and a unit test can pin it without a live pipe; the store wires it to the live
// thinking state, the thinking edges, and the visibility gate.
export const AGENT_POLL_THINKING_MS = 15_000;
export const AGENT_POLL_IDLE_MS = 5 * 60_000;

export function agentPollDelay(thinking: boolean): number {
  return thinking ? AGENT_POLL_THINKING_MS : AGENT_POLL_IDLE_MS;
}
