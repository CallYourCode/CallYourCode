/* DEDUPLICATE CONCURRENT IDENTICAL DECODES, and cancel one when nobody is left
 * waiting for it (#stt-busy).
 *
 * WHY THIS EXISTS. A single 166.6 s voice note was decoded THREE times at once
 * on 2026-09-28: the agent engine's deferred-words POST, plus the app's own
 * batch fallback POSTing its local copy to /voice/stt (and retrying it). All
 * three carried the same bytes, all three ran concurrently, and each held one of
 * the engine's three batch slots (#551) for the ~166 s the clip takes to decode
 * -- so the very next voice notes, seven and ten seconds long, found no slot and
 * came back "(voice note: transcription failed)". Two problems, one module:
 *
 *   1. THE SAME CLIP MUST NOT DECODE TWICE AT ONCE. Keyed by the exact bytes
 *      (and the ?offset), the first caller starts the decode and every later
 *      caller for that key JOINS it and shares its single result. Identical
 *      input yields identical output, so joining is free and correct, and it
 *      collapses the three-way pile-up above into one decode holding one slot.
 *
 *   2. A DECODE THE CALLER GAVE UP ON MUST STOP. When the agent engine's
 *      deadline passes it aborts its fetch, which closes the socket and fires
 *      the request's AbortSignal. `work` is handed a signal that fires only when
 *      EVERY current caller has given up, so the ffmpeg/whisper work stops
 *      burning the decoder the moment nobody is waiting -- but never while
 *      another caller (the app's copy, say) still needs the same transcript.
 *
 * The gate slot (server.ts batchGate) is acquired INSIDE `work`, so a joined
 * caller takes no slot of its own: it is sharing the one the first caller holds.
 */

/** The result of one `run`: the shared decode's value, and whether this caller
 *  joined an already-running decode rather than starting it. */
export type DecodeRun<T> = { result: T; joined: boolean };

type Entry = {
  /** Aborts the shared decode when the last waiter gives up. */
  ctrl: AbortController;
  /** Callers waiting on this decode right now. */
  waiters: number;
  /** The single in-flight decode, shared by every joiner. */
  promise: Promise<unknown>;
};

/** An AbortError carrying the reason a caller's signal aborted with, so the
 *  caller sees a normal client-cancel rather than an opaque failure. */
export function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException(typeof reason === "string" ? reason : "aborted", "AbortError");
}

/** True for the DOMException an aborted fetch / an aborted `work` throws. */
export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === "object" &&
    ((e as { name?: unknown }).name === "AbortError" ||
     (e as { name?: unknown }).name === "TimeoutError");
}

export class DecodeHub {
  private readonly inflight = new Map<string, Entry>();

  /** In-flight distinct decodes right now (each may have several joiners). */
  get size(): number {
    return this.inflight.size;
  }

  /** Run `work` for `key`, deduplicating concurrent identical requests.
   *
   *  The first caller for a key starts `work` with a fresh AbortSignal; later
   *  callers for the same key join and await the SAME promise. Each caller's own
   *  `signal` (the request's, which fires on client disconnect) decrements the
   *  waiter count when it aborts, and the shared decode is cancelled only once
   *  every waiter has gone. A caller whose own signal aborts stops awaiting and
   *  rejects promptly, whether or not the shared decode was cancelled. */
  async run<T>(key: string, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<DecodeRun<T>> {
    let entry = this.inflight.get(key);
    const joined = entry !== undefined;
    if (!entry) {
      const ctrl = new AbortController();
      const e: Entry = { ctrl, waiters: 0, promise: undefined as unknown as Promise<unknown> };
      // Drop the entry the instant the decode settles, so the NEXT identical
      // request starts a fresh decode rather than joining a finished one.
      e.promise = Promise.resolve().then(() => work(ctrl.signal)).finally(() => {
        if (this.inflight.get(key) === e) this.inflight.delete(key);
      });
      this.inflight.set(key, e);
      entry = e;
    }
    const here = entry;
    here.waiters++;
    const giveUp = () => {
      here.waiters = Math.max(0, here.waiters - 1);
      if (here.waiters === 0) here.ctrl.abort(abortError(signal.reason));
    };
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", giveUp);
    };
    if (signal.aborted) {
      // Already gone before we joined: count in, then straight back out, which
      // cancels the decode if we were its only hope.
      giveUp();
    } else {
      signal.addEventListener("abort", giveUp, { once: true });
    }
    try {
      // Reject as soon as THIS caller gives up, even if the shared decode runs
      // on for other joiners. The `work` promise still settles the entry.
      const mine = signal.aborted
        ? Promise.reject(abortError(signal.reason))
        : new Promise<never>((_, rej) => {
            signal.addEventListener("abort", () => rej(abortError(signal.reason)), { once: true });
          });
      const result = await Promise.race([here.promise as Promise<T>, mine]);
      return { result, joined };
    } finally {
      release();
    }
  }
}
