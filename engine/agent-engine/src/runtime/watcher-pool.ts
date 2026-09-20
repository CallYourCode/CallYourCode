import { watch, type FSWatcher } from "node:fs";

export type WatchFn = (path: string, cb: () => void) => FSWatcher;

type Entry = { watcher: FSWatcher; pumps: Set<() => void>; emptySince: number | null };

/* Per-path fs.watch pool for the session tails (overlay events + thinking
 * indicator). A single watcher per file fans out to every pump that wants it,
 * so a session that is both open and status-tailed costs one watcher, not two.
 *
 * WHY POOL AT ALL: Bun's fs.watch on macOS never fires again for a path once a
 * watcher on it has been closed, so a naive close-on-detach loses events for a
 * re-attached session. Watchers are therefore pooled and only closed when NO
 * pump references the path -- which, because syncStatusTails keeps a pump on
 * every alive session, means no live session tails it -- AND it has stayed that
 * way past `idleMs`. That is a long-dead, un-tailed transcript; a new session
 * mints a fresh session id (fresh path), so this exact path is not
 * re-watched in practice, and on Linux (the front) there is no re-arm bug at
 * all. Bounds the live handle count to recently-active sessions instead of
 * every session ever tailed in this process's lifetime (#535 / #589).
 */
export const WATCHER_IDLE_MS = 5 * 60_000;

export class WatcherPool {
  private map = new Map<string, Entry>();

  constructor(
    private watchFn: WatchFn = watch,
    private now: () => number = Date.now,
    private idleMs: number = WATCHER_IDLE_MS,
  ) {}

  /* Arm (or reuse) a watcher for `path`, routing its change events to `pump`.
   * Returns false if the file is missing so the caller retries on the next
   * herdr snapshot. */
  add(path: string, pump: () => void): boolean {
    let e = this.map.get(path);
    if (!e) {
      const pumps = new Set<() => void>();
      let watcher: FSWatcher;
      try {
        watcher = this.watchFn(path, () => {
          for (const p of pumps) p();
        });
      } catch {
        return false; // file missing; caller retries on the next herdr snapshot
      }
      e = { watcher, pumps, emptySince: null };
      this.map.set(path, e);
    }
    e.pumps.add(pump);
    e.emptySince = null; // referenced again: no longer idle-eligible
    return true;
  }

  /* Detach one pump. The watcher stays armed (macOS re-arm bug) until a sweep
   * finds it has had no pump past the idle threshold. */
  remove(path: string, pump: () => void): void {
    const e = this.map.get(path);
    if (!e) return;
    e.pumps.delete(pump);
    if (e.pumps.size === 0 && e.emptySince === null) e.emptySince = this.now();
  }

  /* Close + drop every watcher that has had no pump since past `idleMs`. Called
   * from the herdr-snapshot reconcile, so it runs on the same cadence the tails
   * are kept in step with the live session set. */
  sweep(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [path, e] of this.map) {
      if (e.pumps.size === 0 && e.emptySince !== null && e.emptySince <= cutoff) {
        try {
          e.watcher.close();
        } catch {}
        this.map.delete(path);
      }
    }
  }

  get size(): number {
    return this.map.size;
  }
}
