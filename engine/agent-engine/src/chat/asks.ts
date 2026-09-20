/* WHAT A BLOCKED SESSION IS WAITING FOR (L3 feature): the ask poll machine.
 *
 * The question has to be read off the screen, so it is kept HERE rather than
 * on the Session struct: it is an observation with an age, not a fact the
 * session owns. THREE STATES, and the app is told which: a question we read
 * and parsed; a pane blocked on something we could not read or could not
 * parse; and not blocked at all. Reads are numbered so a slow one cannot land
 * on top of a fast one; the answer path always gets its OWN read back. The
 * parse itself stays in blocked.ts; the screen read is the
 * adapter's conversation verb.
 *
 *   bun test agent-engine/src/asks.test.ts
 */

import type { Ask } from "../terminal/blocked.ts";
import { realClock, type Clock } from "../runtime/clock.ts";

export type AskState = {
  ask: Ask | null; // the parsed question; null = we looked and found no dialog
  at: number;      // when we last looked
  ok: boolean;     // whether that look succeeded at all
};

/* A blocked pane is re-read on this cadence. The mux's own resnapshot poll is
 * 15s, and a dialog can be replaced by the NEXT dialog without the status
 * ever leaving `blocked`. Cheap: one pane read per blocked pane. */
export const ASK_POLL_MS = 3000;

/** WHY WE CANNOT SHOW THE QUESTION, when we cannot: `unread` (never got the
 *  screen), `unrecognised` (got it, could not parse it), `unsupported` (an
 *  agent whose dialogs this engine does not parse at all). */
export type AskUnknownWhy = "unread" | "unrecognised" | "unsupported";

/** The slice of a Session askOf reads (structural; no cycle). */
export type AskSession = { alive: boolean; status: string; muxHandle: string };

export type AsksDeps = {
  /** the adapter's screen read: the pane's parsed blocked state */
  /* THE SHAPE THE ADAPTER ACTUALLY ANSWERS (AgentConversation["blocked"]).
   * This used to say `{ ask: Ask; why?: undefined } | { why: "unread" } | null`,
   * which admits neither of the other two whys the adapter returns
   * ("unrecognised" and "unsupported", both with a null ask) even though
   * readAskNow below reads exactly those and AskUnknownWhy names all three. */
  readBlocked(paneId: string): Promise<{ ask: Ask | null; why?: AskUnknownWhy } | null>;
  canParseScreen(paneId: string): boolean;
  sessions(): Iterable<AskSession>;
  broadcastSessions(): void;
  /** the session log: a newly seen question is an `ask` record (design A.1),
   *  keyed by the live pane the screen was read from */
  logAsk?(paneId: string, ask: Ask, ts: number): void;
  /* THE TIME SEAM. Absent in production, which is Date.now() and the global
   * setInterval, byte for byte what this module did before the field existed.
   * A seam test passes a manualClock() and then NOTHING here reads the wall
   * clock: the three-second re-read cadence costs the test one advance() and
   * no sleeping at all.
   *
   * SCOPE: this is asks.ts's own now and asks.ts's own timer. reconcile.ts
   * still stamps its staleness check (`Date.now() - held.at > ASK_POLL_MS`)
   * off the wall clock, so under a manual clock that comparison reads "stale"
   * and re-reads a blocked pane's screen once more than it would in
   * production. It costs one extra pane read and never a wrong answer. */
  clock?: Clock;
};

/* Exported for the reconcile pass (freshness check + drop on unblock), the
 * companions purge and the state debug route; every WRITE stays in here. */
export const asks = new Map<string, AskState>();
const askReading = new Set<string>();
let askSeq = 0;
export const askCommitted = new Map<string, number>();
let deps: AsksDeps | null = null;
let poll: unknown = null;
/* The clock every timer and every stamp in this module goes through. realClock
 * until a deps bag says otherwise, so production is unchanged. */
let clock: Clock = realClock;

export function initAsks(d: AsksDeps, pollMs = ASK_POLL_MS): void {
  deps = d;
  if (poll) clock.clearInterval(poll);
  clock = d.clock ?? realClock;
  poll = clock.setInterval(() => {
    for (const s of d.sessions()) {
      // Only read the screen for an agent whose dialogs this engine parses.
      if (s.alive && s.status === "blocked" && d.canParseScreen(s.muxHandle)) void refreshAsk(s.muxHandle);
    }
  }, pollMs);
  (poll as { unref?: () => void }).unref?.();
}
export function stopAsks(): void {
  if (poll) clock.clearInterval(poll);
  poll = null;
  asks.clear();
  askCommitted.clear();
}

/** TEST ONLY: stop the poll, empty the cache and forget the deps AND the
 *  clock, so a second in-process wiring cannot inherit the first one's manual
 *  clock. stopAsks() is the production-shaped half; this is that plus the
 *  wiring. No-op in an engine, which never re-wires. */
export function resetForTest(): void {
  stopAsks();
  askReading.clear();
  askSeq = 0;
  deps = null;
  clock = realClock;
}

/* LOOK AT THE PANE NOW. Always reads; never answers from the cache. The
 * answer path calls this, and "never press on a screen nobody just looked at"
 * has to mean it. */
export async function readAskNow(paneId: string): Promise<AskState> {
  if (!deps) throw new Error("asks not initialised");
  const seq = ++askSeq;
  let state: AskState;
  try {
    const blocked = await deps.readBlocked(paneId);
    state = !blocked
      ? { ask: null, at: clock.now(), ok: true }
      : blocked.why === "unread"
        ? { ask: null, at: clock.now(), ok: false }
        : { ask: blocked.ask, at: clock.now(), ok: true };
  } catch (e) {
    /* Could not read the pane. NOT the same as "there is no question": the
     * old answer is dropped rather than kept, because a question we can no
     * longer confirm is exactly the thing we must not draw buttons for. */
    state = { ask: null, at: clock.now(), ok: false };
    console.error(`[ask] read ${paneId}:`, e);
  }
  commitAsk(paneId, seq, state);
  return state;
}

/** Put an observation in the shared cache and tell the clients, unless a
 *  newer observation already landed. */
export function commitAsk(paneId: string, seq: number, state: AskState): void {
  /* A read that STARTED before one which has already landed says nothing
   * about the screen as it is now, so it keeps its answer to itself. */
  if ((askCommitted.get(paneId) ?? 0) > seq) {
    console.error(`[ask] read ${paneId}: finished behind a newer read; not published`);
    return;
  }
  askCommitted.set(paneId, seq);
  const before = asks.get(paneId);
  asks.set(paneId, state);
  /* Tell the clients when ANY of what the app DRAWS changed, never a
   * fingerprint this engine computes about itself. */
  const changed = JSON.stringify(before?.ask ?? null) !== JSON.stringify(state.ask ?? null);
  if (changed && state.ask) deps?.logAsk?.(paneId, state.ask, state.at);
  if (changed || (before?.ok ?? null) !== state.ok) {
    deps?.broadcastSessions();
  }
}

/* THE DELIVERY GUARD READ THE SAME SCREEN, so what it found is not thrown
 * away. ONLY A POSITIVE FINDING IS PUBLISHED: the two reads ask for different
 * amounts of screen, so "the shorter read found no dialog" is not evidence
 * that there is none. */
export function publishAsk(paneId: string, ask: Ask): void {
  commitAsk(paneId, ++askSeq, { ask, at: clock.now(), ok: true });
}

/** The POLL's wrapper: skips when a read is already in flight, so a burst of
 *  mux events cannot pile up RPCs. Only the cadence uses this. */
export async function refreshAsk(paneId: string): Promise<void> {
  if (askReading.has(paneId)) return;
  askReading.add(paneId);
  try {
    await readAskNow(paneId);
  } finally {
    askReading.delete(paneId);
  }
}

/** The wire shape for one session's question, generic on purpose:
 *  the app is never told this is Claude, only that something is waiting and
 *  what it offers, and WHICH KIND OF NOTHING when there is nothing to show. */
export function askOf(s: AskSession): { ask: Ask | null; askUnknown: boolean; askWhy?: AskUnknownWhy } {
  if (!deps) return { ask: null, askUnknown: false };
  if (!s.alive || s.status !== "blocked") return { ask: null, askUnknown: false };
  if (!deps.canParseScreen(s.muxHandle)) return { ask: null, askUnknown: true, askWhy: "unsupported" };
  // asks is keyed by the LIVE pane: the read that fills it and the keypress
  // that answers it both go to the mux by pane id, never by the session id.
  const state = asks.get(s.muxHandle);
  if (!state || !state.ok) return { ask: null, askUnknown: true, askWhy: "unread" };
  if (!state.ask) return { ask: null, askUnknown: true, askWhy: "unrecognised" };
  return { ask: state.ask, askUnknown: false };
}
