/* One line per decision, on disk, for all three services.
 *
 * WHY THIS EXISTS
 *
 * "I recorded a message, it seemed to send, and then it was not there." That
 * question was unanswerable. A recording was being deleted outright with no
 * toast, no failed note and no log line at all; two long clips uploaded
 * successfully and then never appeared, and nobody could say where they went.
 * Every service printed a little to its own stdout, the browser printed to a
 * console on a phone nobody can read, and the interesting failures cross all
 * three boundaries.
 *
 * So: one FORMAT, one DIRECTORY, one correlation id.
 *
 *   <iso>  <service>  <event>  k=v k=v ...
 *
 * Space separated because the thing you actually do is grep, and the thing you
 * grep for is a capture id. `cyclog.sh <cid>` over .run/logs answers the whole
 * question in one command.
 *
 * WHAT BOUNDS IT
 *
 * .run/uploads grew to 215 files and .run/audio holds a thousand orphaned webm
 * files, so an unbounded writer is a known way to hurt this system. Two limits,
 * both hard:
 *
 *   - ON DISK: the file rotates at MAX_BYTES and exactly one generation is
 *     kept (<name>.log.1), so a service can never cost more than 2 * MAX_BYTES
 *     however long it runs. Default 100 MB each, so all three together are
 *     capped at 600 MB no matter what happens.
 *   - IN MEMORY: lines queue for the flush timer, and the queue is capped at
 *     QUEUE_MAX. Past that the OLDEST are dropped and the next flush says how
 *     many. A disk that stops answering therefore costs a bounded buffer and
 *     some lost history, never the process.
 *
 * Nothing here awaits, throws, or blocks a request: a logger that can fail a
 * voice note is worse than no logger.
 *
 * Also mirrored to the console, because start-v1.sh already sends each
 * service's stdout somewhere and `tail -f .run/engine.log` is what people
 * actually do while something is going wrong. Those files are truncated on
 * every restart, so the mirror costs nothing durable.
 */

import { rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { appendPrivate, mkdirPrivate } from "./runfiles.ts";
import { logsDir } from "./cycdir.ts";

/** The log writer only needs a timeout seam; keeping it structural means this
 * shared module does not depend on any one service's runtime utilities. */
type LogClock = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

const realClock: LogClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const LOG_DIR = process.env.CYC_LOG_DIR ?? logsDir() + "/";

/* Rotate at this size; one previous generation is kept, so 2x is the ceiling.
 *
 * 100 MB, his call on 2026-08-01, raised from 8. The reason is the use, not the
 * capacity: he is about to spend days using the app and reporting what he
 * notices, and a bug reported on Friday is useless if Monday's log has already
 * scrolled over it. At the rate this system actually writes (the app alone put
 * 8 MB down in one night), 8 MB was about a day and 100 MB is about a week,
 * which is the window his reports will fall inside.
 *
 * The ceiling that matters is still bounded and is now 200 MB per service,
 * 600 MB across the three. That is the trade he accepted: disk is cheap and a
 * pattern you cannot find is expensive. */
const MAX_BYTES = Number(process.env.CYC_LOG_MAX_BYTES ?? 100 * 1024 * 1024);
/** How many lines may wait for the flush timer before the oldest are dropped. */
const QUEUE_MAX = Number(process.env.CYC_LOG_QUEUE_MAX ?? 4000);
/** How long a line may sit in memory before it is on disk. */
const FLUSH_MS = Number(process.env.CYC_LOG_FLUSH_MS ?? 250);
/** A single field value never runs longer than this: a log line is a signpost. */
const VALUE_MAX = 400;

export type Fields = Record<string, unknown>;

/* k=v, with the value made safe to sit on one whitespace-separated line.
 *
 * Undefined and null fields are DROPPED rather than printed as "undefined":
 * most call sites pass a cid that may not exist yet, and `cid=undefined` in a
 * file you grep by cid is worse than silence. */
function fields(f: Fields): string {
  const out: string[] = [];
  for (const [k, raw] of Object.entries(f)) {
    if (raw === undefined || raw === null) continue;
    let v = typeof raw === "string" ? raw : JSON.stringify(raw) ?? String(raw);
    v = v.replace(/[\n\r\t]+/g, " ");
    if (v.length > VALUE_MAX) v = v.slice(0, VALUE_MAX) + "…";
    // quote only when it would otherwise break the one-line-of-pairs shape
    if (v === "" || /\s|"/.test(v)) v = JSON.stringify(v);
    out.push(`${k}=${v}`);
  }
  return out.join(" ");
}

export type Logbook = {
  /** One event. Never throws, never awaits, never blocks the caller. */
  line: (event: string, f?: Fields) => void;
  /* An already-formatted line, written through unchanged.
   *
   * For the browser's lines, which arrive at /clientlog having been stamped in
   * the BROWSER. Re-stamping them here would record when the batch arrived
   * rather than when the event happened, and the gap between those two is
   * exactly what a "did it happen before I navigated away" question turns on.
   * The caller is responsible for the shape and for stripping control
   * characters; nothing else here trusts it. */
  raw: (line: string) => void;
  /** Force the queue to disk. For a test, or a shutdown. */
  flush: () => Promise<void>;
  /** Where the lines land, so a test can read them. */
  path: string;
};

const books = new Map<string, Logbook>();

/* THE SEAM: directory, both caps, and the flush timer, all injectable.
 *
 * Every field defaults to the module constant above, so production is what it
 * always was: openLog("engine") reads its directory and its three limits out of
 * the environment, once, at load. Only a test passes anything.
 *
 * It exists because the alternative was worse. The old logbook.test.ts could
 * only reach a 16 KB cap by setting CYC_LOG_MAX_BYTES on the real process and
 * re-importing this module behind a `?fresh=` query string, once per test,
 * because the caps are read at load. `bun test agent-engine/src/` runs the suite in
 * ONE process and the harness spawned each engine with `{ ...process.env }`, so
 * every engine started after that file wrote its log into an already-deleted
 * temp directory with a sixty second flush interval. The four rescue.test.ts
 * tests, the only ones downstream that read an engine's log off disk, were red
 * in every full run and green alone. A bag of options costs five lines and no
 * test has to touch the process again. */
export type LogOpts = {
  /** Where the .log and its one generation live. Default: CYC_LOG_DIR. */
  dir?: string;
  /** Rotate past this many bytes. Default: CYC_LOG_MAX_BYTES. */
  maxBytes?: number;
  /** Lines that may wait for the timer before the oldest go. Default: CYC_LOG_QUEUE_MAX. */
  queueMax?: number;
  /** How long a line may sit in memory. Default: CYC_LOG_FLUSH_MS. */
  flushMs?: number;
  /** The timer source. Default: real timers. A test passes manualClock(). */
  clock?: LogClock;
};

/** The log for one service. Idempotent: the same name gives the same book. */
export function openLog(service: string, opts: LogOpts = {}): Logbook {
  const existing = books.get(service);
  if (existing) return existing;

  const dir = opts.dir ?? LOG_DIR;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const queueMax = opts.queueMax ?? QUEUE_MAX;
  const flushMs = opts.flushMs ?? FLUSH_MS;
  const clock = opts.clock ?? realClock;

  const path = join(dir, `${service}.log`);
  let queue: string[] = [];
  let dropped = 0;
  let bytes = -1; // unknown until the first flush stats the file
  let flushing: Promise<void> | null = null;
  let timer: unknown = null;

  async function rotate() {
    // exactly one generation: the previous .1 is overwritten, on purpose
    await rename(path, `${path}.1`).catch(() => {});
    bytes = 0;
  }

  /* Append `text`, rotating first if it would not fit.
   *
   * The rotation check is per WRITE rather than per flush, and that is not a
   * detail: a first version checked the size once at the top of the flush and
   * then appended the whole queue in one go, so a burst of two hundred kilobytes
   * went into a file whose cap is eight megabytes... and stayed there until the
   * NEXT flush noticed. With an idle service there is no next flush. Caught by
   * logbook.test.ts writing thirteen times its cap into a file that never
   * rotated at all. */
  async function append(text: string) {
    if (bytes < 0) bytes = await stat(path).then((s) => s.size).catch(() => 0);
    const size = Buffer.byteLength(text);
    if (bytes && bytes + size > maxBytes) await rotate();
    await appendPrivate(path, text);
    bytes += size;
  }

  /* THE IN-FLIGHT MARKER IS CLEARED OFF THE PROMISE, NOT AT THE END OF THE BODY.
   *
   * It used to be the last line inside the async IIFE, and that is only correct
   * when the body awaits something. A flush that finds the queue EMPTY runs to
   * completion synchronously: the body's `flushing = null` executed first and
   * the assignment below then put the settled promise back, so `flushing` stayed
   * truthy for ever and every later flush -- the timer's included -- returned
   * that settled promise without writing a byte. One flush of an empty queue
   * therefore wedged the book for the life of the process: lines still went to
   * the console mirror, queued behind a flush that could never run again, and
   * were dropped at the queue cap. Nothing in the engine hits it today (only the
   * timer calls flush, and it always has a line to write), which is exactly why
   * it went unnoticed: it is the documented "for a test, or a shutdown" call
   * that arms it. `.finally` runs in a microtask, after the assignment. */
  function flush(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      for (;;) {
        if (!queue.length && !dropped) break;
        const batch = queue;
        queue = [];
        if (dropped) {
          batch.unshift(`${new Date().toISOString()} ${service} log.dropped n=${dropped} ` +
            `why=queue-full cap=${queueMax}`);
          dropped = 0;
        }
        try {
          await mkdirPrivate(dir);
          /* Written in slices no larger than the cap, so a single flush can
           * rotate more than once and the file is never left over its limit.
           * One syscall per slice, not per line: a busy second is one write. */
          let chunk = "";
          for (const line of batch) {
            if (Buffer.byteLength(chunk) + Buffer.byteLength(line) + 1 > maxBytes && chunk) {
              await append(chunk);
              chunk = "";
            }
            chunk += line + "\n";
          }
          if (chunk) await append(chunk);
        } catch {
          /* A log that cannot be written must not become a second failure. The
           * lines are gone; the console mirror already had them. */
          bytes = -1; // re-stat next time: the file may have been moved
        }
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  function write(text: string) {
    // stdout first: it is the copy that survives a full disk, and it is what
    // start-v1.sh has already pointed at .run/<service>.log
    console.log(text);
    if (queue.length >= queueMax) {
      queue.shift();
      dropped++;
    }
    queue.push(text);
    if (!timer) {
      timer = clock.setTimeout(() => { timer = null; void flush(); }, flushMs);
      // never hold the process open for a log line
      (timer as { unref?: () => void }).unref?.();
    }
  }

  const book: Logbook = {
    path,
    flush: () => flush(),
    raw: (text) => write(text.replace(/[\n\r]+/g, " ")),
    line(event, f = {}) {
      const rest = fields(f);
      write(`${new Date().toISOString()} ${service} ${event}${rest ? " " + rest : ""}`);
    },
  };
  books.set(service, book);
  return book;
}

/* A correlation id, for anything that starts server-side.
 *
 * The interesting one is minted in the BROWSER when recording starts (see the
 * app's src/cyc/lib/log.ts) and travels in on the query string and the
 * utterance frame. This is the fallback for a hop that arrives without one, so
 * a line is never written with no id at all: an id that only covers one hop
 * still beats grep finding nothing. */
export function newCid(prefix = "s"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/* A cid off the wire, made safe to put in a log line and to grep for.
 *
 * It is attacker-controlled text on its way into a file the operator reads, so
 * it is restricted to the alphabet the minters use and truncated. Anything else
 * becomes "" and the call site falls back to its own id. */
export function safeCid(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  return /^[A-Za-z0-9_.-]{1,64}$/.test(s) ? s : "";
}
