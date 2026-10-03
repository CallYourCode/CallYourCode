import {cyclog} from '@/shared/logging';
import {expBackoff} from '@/shared/backoff';
import {engineCapFetch, EngineOffline, whenEngineReady} from '../contract';

// The download lane (download-lane, 2026-10-03): the mirror of the upload
// worker for bytes coming FROM the engine. A shown file is pulled as a run of
// `Range: bytes=a-b` parts, one tunnel CHUNK each, written to a sink in order.
// The engine answers each part on its sealed writer's bulk lane, which yields to
// every chat frame and upload ack, so a download never holds the chat behind its
// bytes. Each part has its own deadline; a part that fails (deadline, dropped
// pipe, 5xx) is retried from the last byte the sink took, after the engine is
// back. A download that makes no progress for STALL_FAIL_MS fails, visibly; it
// never hangs. It used to be one 13 MB answer with nothing to measure it by: a
// stuck "Downloading..." toast for three minutes, and an engine starved by it.

// One part, the engine's chunk size (routes/transfer.ts, tunnel.ts CHUNK).
export const PART_BYTES = 262144;
// A part request gets this long, wall clock, before it is cut and retried.
export const PART_DEADLINE_MS = 20_000;
// No progress at all for this long: the download fails (the card says so).
export const STALL_FAIL_MS = 60_000;
// Parts in flight at once: enough to keep the pipe busy, small enough that a
// cancel or a drop wastes little.
const PARALLEL = 2;
const BACKOFF = {baseMs: 1_000, capMs: 8_000, expOffset: -1, jitter: 'plusBase'} as const;

export type DownloadPhase = 'active' | 'waiting' | 'done' | 'failed' | 'cancelled';

export type DownloadProgress = {
  phase: DownloadPhase;
  received: number;
  total: number;
  // the engine's content-type for the file, once a part has said it
  type?: string;
  // why the download is waiting or failed, in the card's words
  reason?: string;
};

// Where the bytes go. write() takes the next part IN ORDER and resolves when
// the sink can take more (its backpressure); a write that throws fails the
// download (the browser stopped taking the file, the user cancelled it there).
export type DownloadSink = {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason: string): void;
};

export type DownloadHandle = {
  cancel(): void;
  done: Promise<DownloadProgress>;
};

class PartError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

function stallFailMs(): number {
  const t = Number((window as unknown as {__cycDownloadStallMs?: number}).__cycDownloadStallMs);
  return t > 0 ? t : STALL_FAIL_MS;
}

function partDeadlineMs(): number {
  const t = Number((window as unknown as {__cycDownloadPartMs?: number}).__cycDownloadPartMs);
  return t > 0 ? t : PART_DEADLINE_MS;
}

// `bytes a-b/total` -> {start, total}; null when the header is absent or odd.
function contentRange(v: string | null): {start: number; total: number} | null {
  const m = v ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(v.trim()) : null;
  return m ? {start: Number(m[1]), total: Number(m[3])} : null;
}

// A part's answer: the 206 body read whole, or a 200 (no Range support) left
// for the caller to stream.
type Part = {res: Response; bytes: Uint8Array | null};

/** Pull `url` into `sink`, part by part. `size` is what the card says (0 when
 *  unknown: the first part's content-range tells). An engine that ignores
 *  Range (200) is read as one stream instead, still with the stall bound. */
export function startDownload(opts: {
  name: string;
  url: string;
  size: number;
  sink: DownloadSink;
  onProgress?: (p: DownloadProgress) => void;
}): DownloadHandle {
  const {name, url, sink} = opts;
  let total = opts.size > 0 ? opts.size : 0;
  let received = 0;
  let type = '';
  // the engine answered a part in range (206): parts may be pipelined
  let ranged = false;
  let phase: DownloadPhase = 'active';
  let reason: string | undefined;
  let lastProgressAt = Date.now();
  let attempts = 0;
  const started = Date.now();
  const cancelCtl = new AbortController();
  const inflight = new Set<AbortController>();

  const snapshot = (): DownloadProgress => ({
    phase,
    received,
    total,
    ...(type ? {type} : {}),
    ...(reason ? {reason} : {})
  });
  const report = () => opts.onProgress?.(snapshot());

  const setPhase = (next: DownloadPhase, why?: string) => {
    if (phase === next && reason === why) return;
    phase = next;
    reason = why;
    report();
  };

  const cutAll = (why: unknown) => {
    for (const c of [...inflight]) c.abort(why);
  };

  // One part request with its own deadline; the cancel cuts it too. The body
  // is read under the same deadline: a part whose bytes stop is cut.
  async function fetchPart(start: number, end: number): Promise<Part> {
    const ctl = new AbortController();
    inflight.add(ctl);
    const timer = setTimeout(
      () => ctl.abort(new PartError('the part had no answer within its deadline')),
      partDeadlineMs()
    );
    const onCancel = () => ctl.abort(new PartError('cancelled'));
    cancelCtl.signal.addEventListener('abort', onCancel, {once: true});
    // The cut wins even over a transport that does not honour its signal.
    const cut = new Promise<never>((_, reject) => {
      ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason), {once: true});
    });
    cut.catch(() => {});
    try {
      const res = await Promise.race([
        engineCapFetch(url, {headers: {range: `bytes=${start}-${end}`}, signal: ctl.signal}),
        cut
      ]);
      if (res.status !== 206 && res.status !== 200) {
        throw new PartError(`HTTP ${res.status}`, res.status);
      }
      if (!type) type = res.headers.get('content-type') || '';
      const bytes =
        res.status === 206 ? new Uint8Array(await Promise.race([res.arrayBuffer(), cut])) : null;
      return {res, bytes};
    } catch (err) {
      const why = (ctl.signal as {reason?: unknown}).reason;
      throw why instanceof Error ? why : err;
    } finally {
      clearTimeout(timer);
      cancelCtl.signal.removeEventListener('abort', onCancel);
      inflight.delete(ctl);
    }
  }

  // The engine answered 200 to a Range: an older engine. Stream the one body,
  // cutting it when no byte lands for a part deadline.
  async function readWhole(res: Response): Promise<void> {
    const len = Number(res.headers.get('content-length')) || 0;
    if (!total && len) total = len;
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
      const bytes = new Uint8Array(await res.arrayBuffer());
      received = bytes.byteLength;
      await sink.write(bytes);
      if (!total) total = received;
      report();
      return;
    }
    const reader = body.getReader();
    const cancelled = new Promise<never>((_, reject) => {
      const stop = () => reject(new PartError('cancelled'));
      if (cancelCtl.signal.aborted) stop();
      else cancelCtl.signal.addEventListener('abort', stop, {once: true});
    });
    cancelled.catch(() => {});
    for (;;) {
      let idle: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        idle = setTimeout(
          () => reject(new PartError('no bytes arrived within the part deadline')),
          partDeadlineMs()
        );
      });
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await Promise.race([reader.read(), stalled, cancelled]);
      } catch (err) {
        void reader.cancel().catch(() => {});
        throw err;
      } finally {
        clearTimeout(idle);
      }
      if (step.done) break;
      const n = step.value?.byteLength ?? 0;
      if (!n) continue;
      await sink.write(step.value);
      received += n;
      lastProgressAt = Date.now();
      report();
    }
    if (!total) total = received;
  }

  // One pass from `received` to the end. Throws on the first failed part; the
  // parts that landed before it are already in the sink.
  async function pass(): Promise<void> {
    const ahead = new Map<number, Promise<Part>>();
    const want = (start: number) => {
      if (ahead.has(start) || (total && start >= total)) return;
      const end = start + PART_BYTES - 1;
      const p = fetchPart(start, total ? Math.min(end, total - 1) : end);
      p.catch(() => {}); // awaited below in order; never an unhandled rejection
      ahead.set(start, p);
    };
    try {
      for (;;) {
        if (total && received >= total) return;
        // Pipeline only once the engine has answered a part (206): an older
        // engine answers every Range with the whole file, once is enough.
        for (let i = 0; i < (ranged ? PARALLEL : 1); i++) want(received + i * PART_BYTES);
        const {res, bytes} = await ahead.get(received)!;
        ahead.delete(received);
        if (!bytes) {
          // no Range support (an older engine): this one body is the whole file
          cutAll(new PartError('superseded'));
          ahead.clear();
          if (received > 0) throw new PartError('the engine stopped answering in parts');
          await readWhole(res);
          return;
        }
        const cr = contentRange(res.headers.get('content-range'));
        if (!cr || cr.start !== received) throw new PartError('a part came back misplaced');
        if (total && cr.total !== total) {
          throw new PartError(`the file is ${cr.total} bytes, the card said ${total}`, 409);
        }
        total = cr.total;
        ranged = true;
        // Read the length first: a sink that transfers the buffer detaches it.
        const n = bytes.byteLength;
        if (!n) throw new PartError('an empty part');
        await sink.write(bytes);
        received += n;
        lastProgressAt = Date.now();
        attempts = 0;
        if (phase !== 'active') setPhase('active');
        else report();
      }
    } finally {
      cutAll(new PartError('the pass ended'));
    }
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      cancelCtl.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        {once: true}
      );
    });

  async function run(): Promise<DownloadProgress> {
    report();
    for (;;) {
      try {
        if (cancelCtl.signal.aborted) throw new PartError('cancelled');
        await pass();
        if (cancelCtl.signal.aborted) throw new PartError('cancelled');
        await sink.close();
        setPhase('done');
        cyclog('download.done', {
          name,
          bytes: received,
          ms: Date.now() - started,
          why: 'every part landed in order; the sink has the whole file'
        });
        return snapshot();
      } catch (err) {
        if (cancelCtl.signal.aborted) {
          sink.abort('cancelled');
          setPhase('cancelled');
          cyclog('download.cancelled', {name, received, total});
          return snapshot();
        }
        const status = (err as PartError)?.status;
        const msg = String((err as Error)?.message ?? err);
        // Definitive: the engine says the file is not there, or not this size.
        if (status === 404 || status === 409 || status === 416) {
          return fail(`the engine refused the download (${msg})`);
        }
        const stalledFor = Date.now() - lastProgressAt;
        if (stalledFor >= stallFailMs()) {
          return fail(`no progress for ${Math.round(stalledFor / 1000)} s`);
        }
        attempts++;
        const offline = err instanceof EngineOffline || /pipe|offline|tunnel/i.test(msg);
        setPhase('waiting', offline ? 'reconnecting' : 'retrying');
        cyclog('download.stalled', {
          name,
          received,
          total,
          attempts,
          err: msg,
          why: 'a part failed; the download resumes from the bytes already saved once the engine answers'
        });
        // Wait for the engine (never past the stall bound), then back off a little.
        const left = stallFailMs() - (Date.now() - lastProgressAt);
        const back = await whenEngineReady(url, Math.max(0, left), cancelCtl.signal);
        if (cancelCtl.signal.aborted) continue;
        if (!back) {
          return fail(`the engine did not come back within ${Math.round(stallFailMs() / 1000)} s`);
        }
        await sleep(offline ? 0 : expBackoff(BACKOFF, attempts));
        cyclog('download.resumed', {name, received, total, attempts});
      }
    }
  }

  function fail(why: string): DownloadProgress {
    sink.abort(why);
    setPhase('failed', why);
    cyclog('download.failed', {name, received, total, ms: Date.now() - started, why});
    return snapshot();
  }

  const done = run();
  return {
    cancel: () => {
      if (phase === 'done' || phase === 'failed' || phase === 'cancelled') return;
      cancelCtl.abort();
      cutAll(new PartError('cancelled'));
    },
    done
  };
}
