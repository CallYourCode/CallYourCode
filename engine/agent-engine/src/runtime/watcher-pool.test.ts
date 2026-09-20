/* THE SESSION-TAIL WATCHER POOL STAYS BOUNDED (#535 / #589).
 *
 * The pool used to keep one fs.watch per file path FOREVER (Bun's macOS re-arm
 * bug), so the open-handle count grew with every distinct session ever tailed.
 * It now closes a watcher once no pump has referenced its path past an idle
 * threshold. These probes drive the pool with a fake `watch` (counts opens and
 * closes) and a fake clock, and assert:
 *   1. tailing 200 distinct sessions then dropping + idling them out leaves ZERO
 *      live watchers (every open is matched by a close);
 *   2. an actively-referenced path is never swept;
 *   3. re-arming an idle path before the sweep keeps it (emptySince reset);
 *   4. two pumps on one path share ONE watcher (the pool's whole point).
 */
import { test, expect } from "bun:test";
import { WatcherPool, WATCHER_IDLE_MS, type WatchFn } from "./watcher-pool";

/* The pool's two seams are both injected: `watch` and `now`. Nothing here opens
 * a real file handle or waits for a real five minutes, so the reclaim rule is
 * provable in microseconds and the counts are exact rather than sampled. */
function rig(opts: { failOn?: (path: string) => boolean; closeThrows?: boolean } = {}) {
  let clock = 0;
  let opens = 0;
  let closes = 0;
  const fired = new Map<string, () => void>(); // path -> the pool's own fan-out cb
  const watchFn: WatchFn = (path, cb) => {
    if (opts.failOn?.(path)) throw new Error("ENOENT");
    opens++;
    fired.set(path, cb);
    return {
      close: () => {
        closes++;
        if (opts.closeThrows) throw new Error("already gone");
      },
    } as unknown as ReturnType<WatchFn>;
  };
  const idleMs = 5 * 60_000;
  const pool = new WatcherPool(watchFn, () => clock, idleMs);
  return {
    pool,
    idleMs,
    advance: (ms: number) => { clock += ms; },
    /** pretend the file changed, the way fs.watch would */
    change: (path: string) => fired.get(path)?.(),
    get opens() { return opens; },
    get closes() { return closes; },
  };
}

test("200 distinct sessions: every watcher is reclaimed once dead + quiet", () => {
  const r = rig();
  const paths = Array.from({ length: 200 }, (_, i) => `/sessions/s${i}.jsonl`);

  // attach a pump to each, then detach it (session dies)
  for (const p of paths) {
    const pump = () => {};
    expect(r.pool.add(p, pump)).toBe(true);
    r.pool.remove(p, pump);
  }
  expect(r.opens).toBe(200); // one open per distinct path
  expect(r.pool.size).toBe(200); // still armed: idle threshold not yet crossed

  r.pool.sweep(); // no time has passed
  expect(r.pool.size).toBe(200);

  r.advance(r.idleMs + 1);
  r.pool.sweep();
  expect(r.pool.size).toBe(0); // all reclaimed
  expect(r.closes).toBe(200); // every open matched by a close -> no handle leak
});

test("a live session's watcher is never swept", () => {
  const r = rig();
  const pump = () => {};
  r.pool.add("/sessions/live.jsonl", pump);
  r.advance(r.idleMs * 10);
  r.pool.sweep();
  expect(r.pool.size).toBe(1); // still referenced -> kept
  expect(r.closes).toBe(0);
});

test("re-arming before the sweep keeps the watcher (emptySince resets)", () => {
  const r = rig();
  const path = "/sessions/flap.jsonl";
  const a = () => {};
  r.pool.add(path, a);
  r.pool.remove(path, a); // now empty, emptySince = 0
  r.advance(r.idleMs - 1); // not yet stale
  const b = () => {};
  r.pool.add(path, b); // referenced again -> emptySince cleared, no new open
  expect(r.opens).toBe(1); // reused the pooled watcher
  r.advance(r.idleMs + 1);
  r.pool.sweep();
  expect(r.pool.size).toBe(1); // b still holds it
  expect(r.closes).toBe(0);
});

test("two pumps on one path share a single watcher", () => {
  const r = rig();
  const path = "/sessions/shared.jsonl";
  const overlay = () => {};
  const status = () => {};
  r.pool.add(path, overlay);
  r.pool.add(path, status);
  expect(r.opens).toBe(1); // pooled, not one-per-pump
  r.pool.remove(path, overlay); // one pump left -> not empty, not sweepable
  r.advance(r.idleMs + 1);
  r.pool.sweep();
  expect(r.pool.size).toBe(1);
  r.pool.remove(path, status); // last pump gone
  r.advance(r.idleMs + 1);
  r.pool.sweep();
  expect(r.pool.size).toBe(0);
  expect(r.closes).toBe(1);
});

test("bounded live size under churn: peak tracks concurrency, not lifetime total", () => {
  const r = rig();
  let peak = 0;
  // 200 sessions cycle through, at most 8 alive at once; sweep each round
  const alive: Array<{ path: string; pump: () => void }> = [];
  for (let i = 0; i < 200; i++) {
    const path = `/sessions/c${i}.jsonl`;
    const pump = () => {};
    r.pool.add(path, pump);
    alive.push({ path, pump });
    if (alive.length > 8) {
      const dead = alive.shift()!;
      r.pool.remove(dead.path, dead.pump);
    }
    r.advance(r.idleMs + 1); // each round, prior dead sessions age out
    r.pool.sweep();
    peak = Math.max(peak, r.pool.size);
  }
  // 8 concurrent live + the one just-removed (removed at THIS round's clock,
  // so not yet past idle when this round's sweep runs) -> a tight bound, never 200.
  expect(peak).toBeLessThanOrEqual(10);
  expect(r.opens).toBe(200); // every session really was watched
});

// -------------------------------------------------------------- the fan-out

test("one file change reaches every pump on that path, and nobody else's", () => {
  /* The whole reason for pooling: a session that is both open (overlay) and
   * status-tailed costs one watcher and both pumps still run. A fan-out that
   * kept only the newest pump would leave the thinking indicator frozen. */
  const r = rig();
  const hits: string[] = [];
  r.pool.add("/sessions/a.jsonl", () => hits.push("overlay"));
  r.pool.add("/sessions/a.jsonl", () => hits.push("status"));
  r.pool.add("/sessions/b.jsonl", () => hits.push("other"));
  r.change("/sessions/a.jsonl");
  expect(hits).toEqual(["overlay", "status"]);
  r.change("/sessions/b.jsonl");
  expect(hits).toEqual(["overlay", "status", "other"]);
});

test("a detached pump stops being called, without disturbing the ones left", () => {
  const r = rig();
  const hits: string[] = [];
  const overlay = () => hits.push("overlay");
  r.pool.add("/sessions/a.jsonl", overlay);
  r.pool.add("/sessions/a.jsonl", () => hits.push("status"));
  r.pool.remove("/sessions/a.jsonl", overlay);
  r.change("/sessions/a.jsonl");
  expect(hits).toEqual(["status"]);
});

// ------------------------------------------------------------- the refusals

test("a file that is not there yet returns false and pools nothing", () => {
  /* syncStatusTails calls add() for every alive session on every herdr
   * snapshot, and a session's transcript does not exist until its first turn.
   * A pooled entry with a dead watcher in it would then never be retried. */
  const r = rig({ failOn: (p) => p.includes("missing") });
  expect(r.pool.add("/sessions/missing.jsonl", () => {})).toBe(false);
  expect(r.pool.size).toBe(0);
  expect(r.opens).toBe(0);
  // and the same path armed later (the file arrived) works
  const r2 = rig();
  expect(r2.pool.add("/sessions/missing.jsonl", () => {})).toBe(true);
  expect(r2.pool.size).toBe(1);
});

test("removing a path that was never armed is a no-op, not a throw", () => {
  const r = rig();
  r.pool.remove("/sessions/never.jsonl", () => {});
  expect(r.pool.size).toBe(0);
  r.pool.sweep();
  expect(r.closes).toBe(0);
});

test("a close that throws does not take the sweep down with it", () => {
  /* A watcher whose file has been unlinked can throw on close. Half a sweep
   * would leave the rest of the map armed forever, which is the leak this
   * module exists to stop. */
  const r = rig({ closeThrows: true });
  for (let i = 0; i < 3; i++) {
    const pump = () => {};
    r.pool.add(`/sessions/x${i}.jsonl`, pump);
    r.pool.remove(`/sessions/x${i}.jsonl`, pump);
  }
  r.advance(r.idleMs + 1);
  r.pool.sweep();
  expect(r.pool.size).toBe(0);
  expect(r.closes).toBe(3);
});

// ------------------------------------------------------------- the boundary

test("the idle threshold is inclusive: exactly idleMs of quiet is reclaimed", () => {
  /* `emptySince <= now - idleMs`. Getting this backwards costs nothing on a
   * real clock and everything in a reasoned argument about the bound, so it is
   * pinned rather than left to the 200-session test's `+1`. */
  const r = rig();
  const pump = () => {};
  r.pool.add("/sessions/edge.jsonl", pump);
  r.pool.remove("/sessions/edge.jsonl", pump); // emptySince = 0
  r.advance(r.idleMs - 1);
  r.pool.sweep();
  expect(r.pool.size, "swept a millisecond early").toBe(1);
  r.advance(1); // now exactly idleMs of quiet
  r.pool.sweep();
  expect(r.pool.size).toBe(0);
  expect(r.closes).toBe(1);
});

test("a path armed again after its watcher was reclaimed opens a fresh one", () => {
  /* The reclaim is a real close, so the entry is gone rather than parked. On
   * Linux (the front) re-watching the same path is fine; on macOS a new session
   * mints a new transcript path, which is why the reclaim is safe at all. */
  const r = rig();
  const path = "/sessions/again.jsonl";
  const a = () => {};
  r.pool.add(path, a);
  r.pool.remove(path, a);
  r.advance(r.idleMs + 1);
  r.pool.sweep();
  expect(r.pool.size).toBe(0);

  const hits: number[] = [];
  expect(r.pool.add(path, () => hits.push(1))).toBe(true);
  expect(r.opens, "the reclaimed entry was reused instead of re-opened").toBe(2);
  r.change(path);
  expect(hits.length, "the fresh watcher's events do not reach the new pump").toBe(1);
});

test("the shipped idle threshold is five minutes", () => {
  /* The default the engine constructs the pool with. Written down because it is
   * the number that decides how long a dead session's handle survives, and the
   * tests above all inject their own. */
  expect(WATCHER_IDLE_MS).toBe(5 * 60_000);
  expect(new WatcherPool(() => ({ close() {} }) as never).size).toBe(0);
});
