/* A bounded-concurrency gate for the batch /stt path.
 *
 * WHY THIS EXISTS (#551). The batch decode path had no concurrency bound at all:
 * every POST /stt spawned an ffmpeg decode and an upstream whisper fetch with
 * nothing capping how many ran at once. A request that hung -- an ffmpeg that
 * never exited, an upstream socket that died -- held its ffmpeg child, its file
 * descriptors and its PCM buffers for ever, and with no bound the hung ones
 * accumulated until the process ran out of a shared resource (fds, the 2 GB
 * launchd memory ceiling) and EVERY later request wedged. The engine still
 * answered /health, because /health did no real work. Bounding concurrency is
 * half the fix (the other half is a hard timeout that KILLS a hung ffmpeg): a
 * pathological request can no longer consume an unbounded share, and a flood of
 * them fails the extra requests loudly (a 503) instead of queueing for ever.
 *
 * The slot is CONSERVED on release: it is handed straight to the oldest waiter
 * rather than freed and re-raced, so `inFlight` is a true count and a waiter
 * cannot lose its turn to a request that arrived after it. A waiter that reaches
 * its bounded wait resolves `false` and removes itself; it never holds a slot,
 * so there is nothing to release for it. */

type Waiter = { resolve: (v: boolean) => void; timer: ReturnType<typeof setTimeout>; settled: boolean };

export class BatchGate {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error(`BatchGate max must be >= 1 (got ${max})`);
  }

  /** Slots held right now. Never exceeds `max`. */
  get inFlight(): number {
    return this.active;
  }

  /** Requests parked waiting for a slot right now. */
  get queued(): number {
    return this.waiters.length;
  }

  /** Take a slot, waiting up to `waitMs` for one. Resolves `true` with a slot
   *  HELD (the caller must `release()` exactly once, on every exit path), or
   *  `false` if the wait elapsed first -- in which case no slot is held and
   *  there is nothing to release. A non-positive `waitMs` fails immediately when
   *  the gate is full. */
  acquire(waitMs: number): Promise<boolean> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(true);
    }
    if (waitMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const w: Waiter = { resolve, settled: false, timer: undefined as unknown as ReturnType<typeof setTimeout> };
      w.timer = setTimeout(() => {
        if (w.settled) return;
        w.settled = true;
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(false);
      }, waitMs);
      this.waiters.push(w);
    });
  }

  /** Give back a slot taken by a resolved `acquire(...) === true`. Hands it to
   *  the oldest still-waiting acquirer if there is one; otherwise the slot goes
   *  idle. Idempotent against over-release: `active` never goes below zero. */
  release(): void {
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      if (w.settled) continue; // timed out already; skip and keep the slot
      w.settled = true;
      clearTimeout(w.timer);
      w.resolve(true); // slot transfers to the waiter; active unchanged
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}
