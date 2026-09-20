/* THE STATUS REDUCER (fix STATUSREDUCER): the one place the session status
 * precedence lives.
 *
 * Two merge points used to each carry a slice of the same rule set: the
 * snapshot rebuild (reconcile.ts) folding the mux hint against the carried
 * transcript verdict, and the live edge between polls (chat/ingest.ts
 * applyJsonlStatus) folding a transcript working/idle edge onto the row. This
 * module is the single rule table both now call; the callers keep their own
 * side effects (logging, turn stamps, broadcast, done-seq) and only ask this
 * for the status decision.
 *
 * TWO OBSERVATION KINDS, one precedence:
 *
 *  - "mux": herdr's native detector (its idle/done distinction) plus the
 *    tmux-parity seam (nativeDone) and rotation. On tmux the screen-parse
 *    refineBlocked (terminal/tmux.ts) has ALREADY folded "blocked" into the
 *    hint before we see it, and tmux otherwise reports only idle/blocked; on
 *    herdr the hint carries the full idle/working/blocked/done set. Either way
 *    it arrives here as one AgentStatus hint: this reducer does NOT restructure
 *    that feeder.
 *
 *  - "transcript": the jsonl tail's working<->idle edge. The pi socket frames
 *    (chat/ingest.ts applyPiFrame) are deliberately funnelled into this SAME
 *    kind, so the socket is not a separate precedence level: this reducer does
 *    NOT restructure that feeder either.
 *
 * PRECEDENCE for the thinking indicator (#490). herdr owns `blocked` and
 * nothing else: a permission dialog never reaches the transcript, so the jsonl
 * can only ever say working or idle. The transcript tail is authoritative for
 * working<->idle, so its verdict is carried on jsonlStatus and re-applied on
 * the next rebuild in BOTH directions: a jsonl working so a poll's rebuild does
 * not stamp herdr's stale idle back over a live turn, and a jsonl idle so
 * herdr's own `working` (a spinner, a background shell, "waiting for background
 * agents", MCP tasks still running) cannot reopen a turn the transcript closed,
 * restart the turn stamp, and leave the next real prompt reading "thinking ·
 * 7m" (2026-09-02, turn-age.test.ts). With no transcript verdict yet, herdr's
 * value stands in either direction. For not-working we defer to herdr's own
 * value, which keeps its richer idle-vs-done distinction (the session-activity
 * dot) untouched. On a rotated session the carry belongs to the old file and
 * is dropped (the same drop `blocked` takes).
 *
 * DONE SYNTHESIS, tmux-only (#doneParity). A mux with no native done
 * (nativeDone false) never lights the finished-while-away activity dot on its
 * own: its hint is only ever idle/blocked. So a CLOSED jsonl turn (the tail's
 * working->idle edge, carried on jsonlStatus) is held as a `done` LEVEL, the
 * way herdr holds its own done: it persists across polls until the seen-
 * downgrade clears it (sessions-frame.ts). On herdr (nativeDone true) this is
 * skipped entirely and herdr's own idle/done value stands. blocked always wins.
 *
 * THE OUTLIVE-THE-POLL rule is the jsonlStatus carry INSIDE this reducer state,
 * not a caller-side patch: a transcript observation records the verdict on
 * jsonlStatus, and the next mux observation reads it back off prev.
 *
 *   bun test agent-engine/src/sessions/status-reducer.test.ts
 */

import type { AgentStatus } from "../terminal/mux.ts";

/** The verdict the transcript tail carries between polls: it is only ever
 *  working/idle (a permission dialog never reaches the jsonl). */
export type JsonlStatus = "working" | "idle" | undefined;

/** One reading of a session's status, from either merge point. */
export type StatusObservation =
  | { source: "mux"; hint: AgentStatus; nativeDone: boolean; rotated: boolean }
  | { source: "transcript"; edge: "working" | "idle" };

/** The slice of session state the reducer folds an observation onto: the last
 *  status shown and the carried transcript verdict (the outlive-the-poll seam). */
export type StatusState = { status: AgentStatus; jsonlStatus: JsonlStatus };

/** What the reducer returns: the new status, the new carry, and whether the
 *  status actually moved (the caller keys its side effects on this). */
export type StatusResult = { status: AgentStatus; jsonlStatus: JsonlStatus; changed: boolean };

/** Fold one observation onto the carried status. Pure: no side effects, no
 *  reads of the wider session. The callers keep their own logging, turn stamps
 *  and broadcast; this only decides status and the carry. */
export function reduceStatus(prev: StatusState, obs: StatusObservation): StatusResult {
  if (obs.source === "mux") {
    // a rolled session's carry belongs to the old file; blocked drops it too
    const jsonlStatus: JsonlStatus = obs.hint === "blocked" || obs.rotated ? undefined : prev.jsonlStatus;
    const synthDone = !obs.nativeDone && jsonlStatus === "idle" && obs.hint !== "blocked";
    const status: AgentStatus = obs.hint === "blocked" ? "blocked"
      : jsonlStatus === "working" ? "working"
      : jsonlStatus === "idle" && obs.hint === "working" ? "idle"
      : synthDone ? "done"
      : obs.hint;
    return { status, jsonlStatus, changed: prev.status !== status };
  }
  // transcript: a working/idle edge from the tail (or a pi socket frame).
  const edge = obs.edge;
  // dedupe: the carry already says this, nothing to do
  if (prev.jsonlStatus === edge) return { status: prev.status, jsonlStatus: prev.jsonlStatus, changed: false };
  // ALWAYS record the verdict (this is the outlive-the-poll carry)...
  // ...but an idle edge while the row is not working keeps the mux's richer
  // idle/done value and moves nothing; it only closes the door on herdr's
  // working.
  if (edge === "idle" && prev.status !== "working") return { status: prev.status, jsonlStatus: edge, changed: false };
  // else the edge takes the row and the carry both
  return { status: edge, jsonlStatus: edge, changed: true };
}

/** The one definition of session busy: a live pane mid-turn or blocked. Dead
 *  panes are never busy. */
export function deriveBusy(status: AgentStatus, alive: boolean): boolean {
  return alive && (status === "working" || status === "blocked");
}
