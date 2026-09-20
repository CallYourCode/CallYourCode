/* BACKGROUND MODEL WARM-UP: the ~2 GB of voice models (whisper's ggml file,
 * kokoro's weights) downloaded WHILE the engine serves, never before.
 *
 * The engine must come alive instantly on a fresh install: nothing at boot may
 * wait on a download that takes minutes. So start() only LOOKS at the disk and
 * kicks an unawaited loop per model kind whose files are missing; the loop
 * reuses voicemodels.ts download() (temp `.part` file, size check, atomic
 * rename -- a destination path existing always means a whole file) and retries
 * with backoff forever, because the only useful end state is "the model is
 * here". Every later boot finds the files present and start() does nothing.
 *
 * While a model is missing its service is held down by the presence gate
 * (services.ts needsModel) and voice readiness reports the capability as
 * warming up (server.ts voiceReady); when the last file of a kind lands,
 * onSettled tells the supervisor to look again NOW, so the service starts
 * within seconds of the download finishing rather than at the next tick.
 *
 * Hermetic by construction: the fetch is injectable and the file lists are
 * whatever the caller passes, so no test ever reaches the network or his
 * model directories. Which kinds a real engine warms is decided at boot
 * (server.ts): only models belonging to services in this engine's own table,
 * and only when the service's install directory exists at all.
 *
 *   bun test agent-engine/src/runtime/modelwarmup.test.ts
 */

import { fetchModelFile, filePresent, type ModelFile } from "../voice/voicemodels.ts";

export type WarmupKind = "whisper" | "kokoro";

/** What one warm-up entry is: voicemodels' own file shape (a plain file, or
 *  an archive that unpacks and is then judged by its extracted `present`
 *  paths), so the warm-up and the CLI can never disagree about "installed". */
export type WarmupFile = ModelFile;

export type WarmupStatus = {
  /** Every file of this kind is on disk, whole. A `.part` temp file never
   *  counts: download() renames into place only once complete. */
  present: boolean;
  /** A background download loop is running for this kind right now. */
  downloading: boolean;
  /** Percent of the file currently downloading (0-100), or null when the
   *  source declared no length or nothing is downloading. A hint, not a
   *  promise. */
  pct: number | null;
  /** Download attempts so far, failures included. */
  attempts: number;
};

export type WarmupOpts = {
  fetchImpl?: typeof fetch;
  /** Routine progress lines (what download() prints). */
  log?: (line: string) => void;
  /** Failures and completions: the record that has to survive. */
  incident?: (line: string) => void;
  /** First retry wait after a failed attempt, doubling to maxMs. */
  baseMs?: number;
  maxMs?: number;
  /** Every file of this kind just landed: the moment readiness can flip. */
  onSettled?: (kind: WarmupKind) => void;
};

type Track = {
  kind: WarmupKind;
  files: WarmupFile[];
  downloading: boolean;
  pct: number | null;
  attempts: number;
};

const INERT: WarmupStatus = { present: false, downloading: false, pct: null, attempts: 0 };

export class ModelWarmup {
  private readonly tracks: Track[];
  private readonly fetchImpl?: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly incident: (line: string) => void;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly onSettled: (kind: WarmupKind) => void;
  private stopped = false;
  private pending = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: (v: boolean) => void }>();

  constructor(kinds: { kind: WarmupKind; files: WarmupFile[] }[], opts: WarmupOpts = {}) {
    this.tracks = kinds.map(({ kind, files }) =>
      ({ kind, files, downloading: false, pct: null, attempts: 0 }));
    this.fetchImpl = opts.fetchImpl;
    this.log = opts.log ?? (() => {});
    this.incident = opts.incident ?? this.log;
    this.baseMs = opts.baseMs ?? 10_000;
    this.maxMs = opts.maxMs ?? 900_000;
    this.onSettled = opts.onSettled ?? (() => {});
  }

  /** Kick a background loop for every kind with a file missing, and return AT
   *  ONCE: nothing here is awaited, so the caller's boot never waits on a
   *  download. Idempotent per kind: a kind already downloading is left to its
   *  loop, and a kind whose files are all present starts nothing. */
  start(): void {
    for (const t of this.tracks) {
      if (t.downloading || this.missing(t) === null) continue;
      t.downloading = true;
      void this.run(t);
    }
  }

  /** Stop retrying. An attempt already streaming is not aborted (the atomic
   *  rename makes finishing it harmless); only the waits between attempts are
   *  cancelled. */
  stop(): void {
    this.stopped = true;
    /* A loop parked in a between-attempts wait is WOKEN and told to stand
     *  down (resolve false), not left hanging on a cleared timer for ever. */
    for (const wait of this.pending) { clearTimeout(wait.timer); wait.resolve(false); }
    this.pending.clear();
  }

  /** Every file of this kind is on disk, whole. False for a kind this engine
   *  is not warming at all: absence of knowledge is not presence of a model. */
  present(kind: WarmupKind): boolean {
    const t = this.tracks.find((x) => x.kind === kind);
    return t !== undefined && this.missing(t) === null;
  }

  status(kind: WarmupKind): WarmupStatus {
    const t = this.tracks.find((x) => x.kind === kind);
    if (!t) return { ...INERT };
    return { present: this.missing(t) === null, downloading: t.downloading,
      pct: t.pct, attempts: t.attempts };
  }

  private missing(t: Track): WarmupFile | null {
    return t.files.find((f) => !filePresent(f)) ?? null;
  }

  /** The whole life of one kind's warm-up: download every missing file, retry
   *  a failure with backoff, and settle when the last file lands. */
  private async run(t: Track): Promise<void> {
    for (;;) {
      if (this.stopped) { t.downloading = false; return; }
      const file = this.missing(t);
      if (file === null) break;
      t.attempts += 1;
      t.pct = null;
      try {
        await fetchModelFile(file, {
          fetchImpl: this.fetchImpl,
          print: (line) => this.log(`${t.kind}: ${line}`),
          onProgress: (got, total) => {
            t.pct = total !== null && total > 0 ? Math.floor((got / total) * 100) : null;
          },
        });
      } catch (e) {
        const wait = this.backoff(t.attempts);
        this.incident(`${t.kind}: ${String((e as Error).message ?? e)}; ` +
          `retrying in ${Math.round(wait / 1000)}s (attempt ${t.attempts})`);
        const waited = await this.sleep(wait);
        if (!waited) { t.downloading = false; return; }
      }
    }
    t.downloading = false;
    t.pct = null;
    this.incident(`${t.kind}: every model file is on disk; ready to serve`);
    this.onSettled(t.kind);
  }

  private backoff(attempts: number): number {
    let wait = this.baseMs;
    for (let i = 1; i < attempts && wait < this.maxMs; i++) wait *= 2;
    return Math.min(wait, this.maxMs);
  }

  /** A cancellable wait: resolves true after ms, or false when stop() cleared
   *  it (the loop then stands down instead of firing one more attempt). */
  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.stopped) { resolve(false); return; }
      const wait = { timer: setTimeout(() => { this.pending.delete(wait); resolve(true); }, ms),
        resolve };
      this.pending.add(wait);
    });
  }
}
