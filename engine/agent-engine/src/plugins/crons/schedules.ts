/* Scheduled and recurring messages, owned by the engine.
 *
 * A schedule is a message that arrives in a session at a time, without anyone
 * being there to send it. It lives HERE rather than in the app because that is
 * the whole point: it has to fire with every phone asleep, and it has to still
 * be there after this process restarts. An app-side timer is neither.
 *
 * THE SHAPE, taken from an assistant's cron notes (a CRONS.md): the
 * schedule carries a short NAME, and the substance is a BODY that can be a page
 * long and is edited on its own. `CRON:morning-plan` on the wire, a document
 * behind it. The two kinds -- a one-off at an instant, a cron that repeats --
 * differ only in whether there is a next time. Delivery is identical, and it is
 * the same delivery a typed message gets: see injectUserMessage in server.ts.
 * There is exactly one way into a pane.
 *
 * WHAT THIS FILE OWNS: the store on disk, the cron arithmetic, and the decision
 * of what is due. It does not know how to type into a pane; the caller passes a
 * `deliver` that does. That split is why the whole of it is testable without a
 * terminal (schedules.test.ts).
 *
 * THE RULE ABOVE ALL OTHERS: never fire the same occurrence twice. The cursor
 * is advanced and WRITTEN TO DISK before delivery is attempted, never after. A
 * process killed in the middle of a delivery therefore loses that message; it
 * does not send it again on the next boot. The record it leaves says
 * outcome:"unknown", because that is what we know. The opposite ordering
 * (deliver, then advance) trades a lost message for a duplicated one on every
 * crash, and a duplicate here means the agent runs the job twice.
 */

import { link, open, readFile, realpath, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { mkdirPrivate, writePrivate } from "../../../../shared/runfiles.ts";
import { newCid } from "../../../../shared/logbook.ts";
import { readFileSync, unlinkSync } from "node:fs";
import { realClock, type Clock } from "../../runtime/clock.ts";

/* How often the lock's owner stamps it to say it is still there, and how long
 * since that stamp makes it dead whatever its pid says. Pids recycle across a
 * reboot, so the time is the part that can be trusted.
 *
 * Both are overridable ONLY so a test can watch a lock go stale in seconds
 * instead of minutes. Nothing in the app or the engine sets them; the ratio is
 * what matters (a holder gets several heartbeats inside one stale window) and
 * the defaults are the shipped answer. */
const LOCK_BEAT_MS = Number(process.env.CYC_LOCK_BEAT_MS) || 60_000;
const LOCK_STALE_MS = Number(process.env.CYC_LOCK_STALE_MS) || 5 * 60_000;

/* WHAT TREATING AN OLD LOCK AS DEAD COSTS, said plainly, because it is a real
 * trade and not a free one. A lock that only a running pid could release would
 * survive its owner being killed and stop every engine on the machine for ever;
 * ageing it out is the price of never being in that state. The price has two
 * parts and neither used to be written down anywhere:
 *
 *   1. A MESSAGE CAN GO OUT TWICE with no engine misbehaving at all. If a
 *      suspension lands inside a delivery -- a lid closing, of any length --
 *      the lock ages out while the delivery is in flight, another engine takes
 *      it and may fire the same occurrence. The sleeping laptop does not only
 *      hand the schedule over; it may also send it itself when it wakes. What
 *      the code guarantees is that the second copy cannot come from a stale
 *      snapshot being written back (see `save`), and that when it does happen
 *      there is a `schedule.delivered-without-lock` line saying so.
 *
 *   2. A HEALTHY ENGINE CAN BE DISPLACED BY A WELL-BEHAVED ONE. The stamp is a
 *      wall clock, so an owner whose clock steps BACKWARDS makes its own lock
 *      look arbitrarily old to everybody else. Nothing is wrong with either
 *      process. The displaced one finds out on its next tick and says so
 *      rather than carrying on, which is the most that can be done from here.
 */

/** Is there a process with this pid? Signal 0 asks without sending anything. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists and belongs to someone else, which still counts
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/* ------------------------------------------------------------------ types */

export type ScheduleKind = "once" | "repeat";

/** How one occurrence ended.
 *
 * "unknown" is not a placeholder -- it is the honest answer after a process
 * died between the claim and the delivery, and it stays on the record. */
export type FireOutcome = "delivered" | "undelivered" | "skipped" | "unknown";

export type FireRecord = {
  /** the occurrence this record is about, as an instant */
  due: number;
  /** when the engine actually got to it */
  at: number;
  outcome: FireOutcome;
  /** why, whenever the outcome is not a plain delivery */
  why?: string;
  /** ms between `due` and `at`, when it was not on time */
  lateMs?: number;
  /** occurrences that fell in the same outage and were collapsed into this one */
  missed?: number;
  /* Still being tried, until this instant.
   *
   * ONLY set when the delivery attempt provably typed nothing (see `retriable`
   * on the Deliver result). A pane that was closed at 7am and reopened at 7:40
   * gets its morning message at 7:40, which is the behaviour a person expects
   * and is much better than a row that says "not delivered" about a session
   * that has been up for an hour. It is not a second fire: the occurrence is
   * the same one, the cursor never moved twice, and the moment anything reaches
   * the keyboard the retrying stops. */
  retryUntil?: number;
  /** the earliest the next attempt may happen. See nextTryAt. */
  retryAt?: number;
  /** how many attempts this occurrence has had, when it took more than one */
  tries?: number;
  /* THE OCCURRENCE'S DELIVERY ID, minted once when it fires and carried across
   * every retry of the SAME occurrence. It keys the stranded-body note in the
   * pane (deliverToPane's `unsubmitted`), and the enter-only dedupe believes a
   * note only for the SAME delivery id. The first retry is +30s (nextTryAt),
   * inside the 60s stranded TTL, so a fresh id per attempt would miss the note
   * and retype the body onto the stranded one -- the agent would read the
   * scheduled message doubled. One id per occurrence is what keeps the retry
   * enter-only. It survives a restart (coerce) so a retry in flight across a
   * process death keeps the same id. */
  deliveryId?: string;
};

/* THE LONGEST TWO ATTEMPTS ARE EVER APART, and the whole point of #377.
 *
 * A due message whose pane is briefly unreachable -- busy on a permission
 * chooser, a screen that could not be read, a session herdr has not snapshotted
 * yet -- has to land the moment that pane is free again, not minutes later. The
 * old cap was FIFTEEN MINUTES: the attempt offsets ran 0, 0.5, 1.5, 3.5, 7.5,
 * 15.5, 30.5, 45.5... minutes, so between +15.5 and +30.5 there was a fifteen
 * minute stretch with no attempt at all. A morning "once" whose target pane was
 * busy until ~minute 20 sat undelivered until minute 30.5 and arrived 37 minutes
 * late, while repeat crons on the same engine -- whose panes were reachable, so
 * they never took this path -- were on time all night. */
export const RETRY_MAX_MS = Number(process.env.CYC_RETRY_MAX_MS) || 60_000;

/* HOW LONG TO WAIT BEFORE TRYING AGAIN, doubling from half a minute but capped
 * at RETRY_MAX_MS so no two attempts are ever more than that apart. Once a
 * schedule is overdue the drift after its pane frees can never exceed that cap
 * plus one tick.
 *
 * Asking this often used to be the expensive thing: a save and a broadcast of
 * every schedule body to every device on each attempt is what once forced the
 * cadence to be coarse (480 of each over the two hour window). It no longer is
 * -- a failing retry with nothing new to say now writes and broadcasts nothing
 * (see the `quiet` path in `attempt`), so the engine can probe often and speak
 * only when the answer changes.
 *
 * The offsets after the occurrence, in minutes, at the shipped 60s cap:
 *
 *   0, 0.5, 1.5, 2.5, 3.5, ... then one per minute to the deadline
 *
 * The last attempt is the clamp in `attempt`, which pins the final try to the
 * edge of the window; without it the doubling would overshoot the deadline and
 * leave the tail of the window dead while the record claimed otherwise. */
export function nextTryAt(at: number, tries: number): number {
  return at + Math.min(30_000 * 2 ** Math.max(0, tries - 1), RETRY_MAX_MS);
}

export type Schedule = {
  id: string;
  /** WHICH CONVERSATION, by its stable agent id (design identity rule).
   *  Records used to carry a `sessionId` (a pane id or harness uuid, which
   *  moved under the conversation on every re-key and needed rekey() to chase
   *  it); v2 keys on the agent id, which never moves, so rekey is gone. A v1
   *  record is migrated on first load: its key becomes the agent id of the
   *  directory the file sits in. */
  agent: string;
  /** the conversation's working directory when the schedule was made, checked
   *  before delivery so a reused pane id can never land in the wrong chat */
  cwd?: string;
  /** short, an identifier: what the agent is being asked to do */
  name: string;
  /** the message itself, delivered verbatim. May be long. */
  body: string;
  kind: ScheduleKind;
  /** IANA zone the schedule is READ in. See the note on zones below. */
  tz: string;
  /** once: the instant, absolute. Set at creation from a wall time in `tz`. */
  at?: number;
  /** repeat: a 5-field cron expression, evaluated in `tz` */
  cron?: string;
  enabled: boolean;
  createdAt: number;
  /** the next occurrence, or null when there will never be another */
  nextAt: number | null;
  /** once: its one slot is used up, whatever came of it */
  done?: boolean;
  /** how many occurrences have been claimed */
  fires: number;
  last?: FireRecord;
  /* HOW LATE A FIRE IS RIGHT NOW, in ms, present ONLY while an occurrence has
   * been claimed and is still waiting to land (its pane was busy, the screen
   * unreadable, the session not up yet). It is DERIVED at `list` time from the
   * current clock, never stored -- a stored lateness would be stale the moment
   * it was written -- so every read of the list carries the truth as of that
   * read. Absent means not overdue, which keeps the wire backward-compatible:
   * a reader that has never heard of the field sees exactly what it saw before.
   * The panel shows "late by Nm" from it instead of a row that slid silently. */
  overdueMs?: number;
};

/** What the caller has to be able to do: put this message into that session.
 *  `ok:false` must say why in words a person can read.
 *
 *  `retriable` is a promise about the failure, not a wish about the outcome: it
 *  means NOTHING was typed, so trying again cannot produce a second copy. A
 *  half-delivered message (text in, enter refused) must never claim it. */
export type Deliver = (
  sc: Schedule,
  fire: { due: number; at: number; lateMs: number; missed: number; try: number;
    /* The occurrence's stable delivery id (FireRecord.deliveryId), the same on
     * the first attempt and on every retry of this occurrence. A deliver that
     * types into a pane threads it into deliverToAgent so a retry inside the
     * stranded TTL presses enter only rather than typing the body again. */
    deliveryId: string },
) => Promise<{ ok: boolean; why?: string; retriable?: boolean }>;

/* ------------------------------------------------------------------- zones
 *
 * WHICH CLOCK A SCHEDULE IS IN. He travels, so "7am" is a question, not an
 * answer.
 *
 * Every schedule stores an explicit IANA zone and is read in it. The default at
 * creation is the ENGINE HOST's zone, not the browser's: the engine is the
 * thing that fires it, its clock is the one that does not move when he gets on
 * a plane, and it is the same rule his own crontab already follows (VM
 * timezone, with an explicit CRON_TZ on the one job that must track a market
 * close). A 7am job set in Malta is still 7am Malta from Bangalore, until he
 * says otherwise.
 *
 * A one-off is stored as an absolute INSTANT, so it cannot drift at all; its
 * zone only says which wall clock it was written in, for display and editing.
 */

export function hostZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function validZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type Wall = { y: number; mo: number; d: number; h: number; mi: number; dow: number };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall clock in `tz` at an instant. */
export function wallAt(ms: number, tz: string): Wall {
  const p: Record<string, string> = {};
  for (const part of fmtFor(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    y: Number(p.year), mo: Number(p.month), d: Number(p.day),
    h: Number(p.hour), mi: Number(p.minute), dow: DOW[p.weekday] ?? 0,
  };
}

/** A wall clock as one comparable number, so "is this clock before that one"
 *  is a subtraction rather than five comparisons. */
function wallNum(w: { y: number; mo: number; d: number; h: number; mi: number }): number {
  return ((((w.y * 100 + w.mo) * 100 + w.d) * 100 + w.h) * 100 + w.mi);
}

/** How far ahead of UTC `tz` is at this instant, in ms. */
function offsetAt(ms: number, tz: string): number {
  const w = wallAt(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(ms / 60_000) * 60_000;
}

/** THE EARLIEST INSTANT AT WHICH `tz`'s WALL CLOCK READS THIS OR LATER.
 *
 * One sentence, and it is deliberately that sentence rather than "the instant
 * for this wall clock", because it answers all three cases a zone can present
 * and answers them the way cron needs:
 *
 *   - the ordinary case: exactly that instant.
 *   - THE HOUR THAT HAPPENS TWICE: the FIRST pass, because that is the earliest
 *     instant reading 01:30. The second pass is then an instant we have already
 *     gone past, so nextCronAt skips it and the job runs once.
 *   - THE HOUR THAT NEVER HAPPENS: no instant reads 02:30 at all, so the answer
 *     is the first instant past the gap. The job runs once, at the new offset,
 *     which is what cron has always done, and -- the point -- it becomes a real
 *     `nextAt` that goes through the same late/skip accounting as everything
 *     else instead of disappearing.
 *
 * This replaced a two-pass offset correction. The two passes were right for the
 * ordinary case and quietly wrong for both of the others: `America/Santiago`
 * springs forward AT MIDNIGHT, so an ordinary `0 0 * * *` there resolved to an
 * instant on the PREVIOUS DAY.
 *
 * HOW, and the shape is forced by the fall-back. A wall clock is not monotonic
 * in the instant across one -- 01:00, 01:30, then 01:00, 01:30 again -- so a
 * plain binary search over "does this instant read late enough" has two answers
 * and no way to prefer the earlier: it returned the SECOND pass for `30 1` in
 * New York while returning the first for `0 1`, which is the fall-back bug
 * wearing a different hat. Instead: a zone uses at most two offsets in a
 * two-day window, so take a candidate per offset, KEEP THE ONES THAT ACTUALLY
 * READ BACK as the wall clock asked for, and answer with the earliest. Six
 * `wallAt` calls in the ordinary case.
 *
 * When none of them reads back, the wall clock does not exist and this is a
 * gap. Only then is a search needed, and inside a gap the wall clock IS
 * monotonic, so the same search that was wrong above is right here.
 */
export function instantOf(w: Omit<Wall, "dow">, tz: string): number {
  const naive = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  const want = wallNum(w);
  const DAY = 26 * 3_600_000;
  // every offset in force anywhere near this wall clock: a zone changes at most
  // once in a two-day window, so three probes cannot miss one
  const offsets = [...new Set([offsetAt(naive - DAY, tz), offsetAt(naive, tz), offsetAt(naive + DAY, tz)])];
  let best: number | null = null;
  for (const o of offsets) {
    const c = naive - o;
    // ...and it only counts if the clock really does read that at that instant
    if (wallNum(wallAt(c, tz)) === want && (best === null || c < best)) best = c;
  }
  if (best !== null) return best;

  // a gap. The answer is the transition itself: the first instant reading later
  // than a wall clock that never happened.
  const MIN = 60_000;
  let lo = Math.min(...offsets.map((o) => naive - o)) - 3_600_000;
  let hi = Math.max(...offsets.map((o) => naive - o)) + 3_600_000;
  while (hi - lo > MIN) {
    const mid = Math.floor((lo + hi) / 2 / MIN) * MIN;
    if (mid <= lo || mid >= hi) break;
    if (wallNum(wallAt(mid, tz)) >= want) hi = mid;
    else lo = mid;
  }
  return hi;
}

/* --------------------------------------------------------------------- cron
 *
 * Five fields, Vixie semantics, no seconds. Written here rather than pulled in
 * because the engine has one dependency today and this is sixty lines.
 */

/* `star` is "this field was written starting with a `*`", which is a different
 * question from "does it match everything": a stepped star ("star slash two") is a star WITH a step, it
 * matches half the values, and Vixie keys the day rule below on the star and
 * not on the set. Kept as its own flag for exactly that reason. */
type Field = { star: boolean; set: Set<number> };
export type CronSpec = { mi: Field; h: Field; dom: Field; mo: Field; dow: Field };

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *", "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/* `wrap` is day-of-week's 7, and WHERE it is applied is the whole point.
 *
 * 7 and 0 are both Sunday, so the field's real range is 0..7 and the fold onto
 * 0 happens to each EXPANDED value, after the range has been walked. Folding
 * the endpoints first (which is what this did) breaks every ordinary line that
 * ends on a 7: `0-7` collapsed to `0-0` and ran a job the user believed was
 * daily on Sundays only -- accepted silently, with the preview agreeing with
 * the wrong answer -- and `1-7`, `5-7`, `mon-sun` came out `lo > hi` and were
 * refused as "not a cron expression". */
function parseField(src: string, min: number, max: number,
  names?: Record<string, number>, wrap = 0): Field | null {
  const set = new Set<number>();
  const top = max + wrap; // dow accepts 7 on the way in, never on the way out
  let star = false;
  for (const part of src.split(",")) {
    const piece = part.trim();
    if (!piece) return null;
    const slash = piece.split("/");
    if (slash.length > 2) return null;
    const [range, stepSrc] = slash;
    let step = 1;
    if (stepSrc !== undefined) {
      step = Number(stepSrc);
      if (!Number.isInteger(step) || step < 1) return null;
    }
    let lo: number, hi: number;
    if (range === "*") {
      /* A STAR, step or no step. Vixie's own flag is set on seeing the leading
       * `*` and is not cleared by a step, and the day rule below reads it. */
      star = true;
      lo = min; hi = top;
    } else {
      const ends = range.split("-");
      if (ends.length > 2) return null;
      const num = (s: string): number | null => {
        const t = s.trim().toLowerCase();
        if (names && t in names) return names[t];
        const n = Number(t);
        return t !== "" && Number.isInteger(n) ? n : null;
      };
      const a = num(ends[0]);
      if (a === null) return null;
      lo = a;
      if (ends.length === 2) {
        const b = num(ends[1]);
        if (b === null) return null;
        hi = b;
      } else {
        hi = stepSrc !== undefined ? top : a;
      }
    }
    if (lo < min || hi > top || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) set.add(wrap && v > max ? v - (max + 1) : v);
  }
  if (!set.size) return null;
  return { star, set };
}

/** null when the expression is not one we will act on. */
export function parseCron(expr: string): CronSpec | null {
  if (typeof expr !== "string") return null;
  const src = (MACROS[expr.trim().toLowerCase()] ?? expr).trim();
  if (!src) return null;
  const f = src.split(/\s+/);
  if (f.length !== 5) return null;
  const mi = parseField(f[0], 0, 59);
  const h = parseField(f[1], 0, 23);
  const dom = parseField(f[2], 1, 31);
  const mo = parseField(f[3], 1, 12, MONTHS);
  const dow = parseField(f[4], 0, 6, DAYS, 1); // ...and 7, which is Sunday again
  if (!mi || !h || !dom || !mo || !dow) return null;
  return { mi, h, dom, mo, dow };
}

/* The day rule, and it is the one everybody gets wrong, including the first
 * version of this file.
 *
 * Vixie decides between AND and OR on whether either day field was WRITTEN with
 * a leading star, not on what the field ended up matching:
 *
 *   `0 0 13 * 5`    neither is a star -> OR:  the 13th, and every Friday
 *   `0 0 13 * *`    dow is a star     -> AND: the 13th
 *   `0 0 * * 5`     dom is a star     -> AND: Fridays
 *   `0 0 * /2 * 5`  dom starts `*`    -> AND: odd days that are Fridays
 *
 * The last one is why the flag is "star" and not "matches everything": a
 * stepped star still restricts the set, and its bits still have to be tested.
 */
function dayMatches(spec: CronSpec, dom: number, dow: number): boolean {
  const domOk = spec.dom.set.has(dom);
  const dowOk = spec.dow.set.has(dow);
  return spec.dom.star || spec.dow.star ? domOk && dowOk : domOk || dowOk;
}

const DAY_MS = 86_400_000;

/** The first occurrence strictly after `afterMs`, or null if there is none
 *  inside the search horizon (an expression like `0 0 30 2 *`).
 *
 * WALKS THE CALENDAR, NOT THE CLOCK, and that is what makes the two daylight
 * saving cases right rather than accidental.
 *
 * Days are enumerated in the schedule's zone and each candidate wall time is
 * turned into an instant on its own, so:
 *
 *   - THE HOUR THAT HAPPENS TWICE fires ONCE. `instantOf` always answers with
 *     the FIRST instant carrying a wall clock, so the second pass through
 *     01:30 resolves to an instant we have already gone past and is skipped.
 *     The old minute-walk found the same wall clock again at the new offset and
 *     delivered `0 1 * * *` twice, an hour apart, in New York, Lord Howe and
 *     Santiago. Two identical morning plans is the user-visible shape of the
 *     one rule this file exists to keep. (A stepped-star minute job also runs once
 *     through the repeated hour here, where Vixie would run it twice. That is
 *     the deliberate direction to be wrong in.)
 *
 *   - THE HOUR THAT NEVER HAPPENS still fires. A wall clock inside a spring
 *     forward gap does not exist, so `instantOf` lands just past the gap and
 *     that instant is taken. The old scan simply never saw those minutes and
 *     dropped the occurrence with no record at all -- no fire, no skip, no row
 *     -- which was the one silent failure left in the file. `America/Santiago`
 *     springs forward AT MIDNIGHT, so this was an ordinary `0 0 * * *`.
 */
export function nextCronAt(expr: string, afterMs: number, tz: string): number | null {
  const spec = parseCron(expr);
  if (!spec) return null;
  const hours = [...spec.h.set].sort((a, b) => a - b);
  const mins = [...spec.mi.set].sort((a, b) => a - b);
  const from = Math.floor(afterMs / 60_000) * 60_000 + 60_000; // strictly after
  const w0 = wallAt(from, tz);
  /* A CALENDAR cursor, held as a UTC midnight purely as a way to count days:
   * nothing about it is an instant in `tz`, and the weekday it yields is the
   * calendar's, which is the same in every zone. */
  let day = Date.UTC(w0.y, w0.mo - 1, w0.d);
  const horizon = Date.UTC(w0.y + 5, w0.mo - 1, w0.d);
  for (; day <= horizon; day += DAY_MS) {
    const d = new Date(day);
    const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1;
    const dom = d.getUTCDate(), dow = d.getUTCDay();
    if (!spec.mo.set.has(mo)) continue;
    if (!dayMatches(spec, dom, dow)) continue;
    /* Ascending in wall time, and the first candidate that resolves to an
     * instant at or after `from` is the answer: a later wall time can never
     * resolve to an earlier instant, in any zone rule. */
    const first = day === Date.UTC(w0.y, w0.mo - 1, w0.d);
    for (const h of hours) {
      // on the day the search starts, an earlier wall hour can only resolve to
      // an earlier instant, so there is nothing to ask about it
      if (first && h < w0.h) continue;
      for (const mi of mins) {
        if (first && h === w0.h && mi < w0.mi) continue;
        const ms = instantOf({ y, mo, d: dom, h, mi }, tz);
        if (ms >= from) return ms;
      }
    }
  }
  return null;
}

/* -------------------------------------------------------------------- store */

/** How late an occurrence may be and still be worth delivering.
 *
 * FIRE LATE OR SKIP, after the engine was down over a fire time. Both are
 * defensible and the answer is: late inside two hours, skipped beyond it, and
 * never silently either way.
 *
 * Two hours because of what these messages are. A nudge at 7am is still the
 * morning's nudge at 8:30; it is not the morning's nudge at 4pm, and a
 * "6pm, stop working" that lands at midnight is noise that teaches him to
 * ignore the channel. The failure this feature exists for -- a reminder that
 * never got set during the API outage -- is a case where late beats nothing, so
 * the window is real rather than zero.
 *
 * A skip is always recorded on the schedule and always said in the chat, so the
 * question "did my 7am run?" has an answer on screen either way.
 */
export const GRACE_MS = 2 * 60 * 60 * 1000;

/** How often due-ness is checked. Cron resolution is a minute; this is well
 *  inside it, and cheap: it is a walk over a handful of objects. */
export const TICK_MS = 15_000;

/* WHERE THE STORE'S FILES LIVE (the design). Schedules are AGENT-SCOPED data:
 * each agent's records sit in its own agents/<agentId>/plugins/schedules/
 * schedules.json, while ONE host-wide lock keeps the fire-exactly-once rule
 * engine-wide (two processes on one host must still never both fire). The
 * store is handed this layout rather than a path so the pure tests can point
 * it at a scratch file (singleFileLayout) without the engine ever having a
 * second storage model: the ENGINE always wires the agent layout. */
export type ScheduleFiles = {
  /** the one lock that guards reading, firing and writing, host-wide */
  lockFile: string;
  /** the file this agent's schedules belong in */
  fileFor(agent: string): string;
  /** every existing schedules file (for the load pass), each with the agent id
   *  whose directory it sits in. The agent is what a v1 record's key is
   *  migrated TO, so the layout is the authority on it; the pure single-file
   *  layout has no agent dirs and says "" (records keep their own key). */
  list(): Promise<{ path: string; agent: string }[]>;
};

/** One file for everything: the pure tests' layout. */
export function singleFileLayout(file: string): ScheduleFiles {
  return {
    lockFile: `${file}.lock`,
    fileFor: () => file,
    list: async () => ((await Bun.file(file).exists()) ? [{ path: file, agent: "" }] : []),
  };
}

/** The one on-disk shape, whatever the layout: a flat map by schedule id.
 *  v1 records carry `sessionId`; v2 records carry `agent`. Written as v2
 *  always; read as either (the v1 read is the migration). */
export type ScheduleFileShape = { v: 1 | 2; schedules: Record<string, unknown> };

export type StoreOpts = {
  files: ScheduleFiles;
  deliver: Deliver;
  /** the engine's log, so a fire is greppable next to the message it produced */
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** told after anything changes, so the wire can be brought up to date */
  onChange?: () => void;
  now?: () => number;
  /* THE TICKER'S TIMER, and the reason it is here as well as `now`.
   *
   * `now` alone lets a test say what time it is; it does not let a test say
   * that fifteen seconds went by, so anything driven by the interval had to be
   * driven by calling tick() directly and the interval itself was never
   * exercised. With the clock the same manual instrument does both, and
   * production is byte-identical: realClock is setInterval and Date.now. */
  clock?: Clock;
  /* NO isOpen ANY MORE. Task 448's pause-when-exited gate is carried by the
   * delivery result instead: a closed session's attempt answers
   * { ok:false, retriable:true } from the host and the GRACE_MS/nextTryAt
   * ladder absorbs it. Same observable behaviour, one fewer seam. */
};

export class Schedules {
  private map = new Map<string, Schedule>();
  private timer: unknown = null;
  private firing = false;
  private opts: StoreOpts;
  private clock: Clock;
  private now: () => number;
  /* Set when the file on disk could not be read AS A FILE (truncated, empty,
   * not JSON). While it is set nothing writes and nothing fires: see refuse(). */
  private poisoned: string | null = null;
  /** whether this process currently holds the right to fire and to write */
  private owns = false;
  private lockSaidAt = 0;
  private beatAt = 0;
  /* The lock's identity: the inode we linked into place, and a handle held open
   * on it. Both are how "is it still ours" is answered without trusting either
   * this process's memory or bytes another process could have written. */
  private lockIno: number | null = null;
  private lockFd: FileHandle | null = null;
  /* Ownership was just taken, so what is in memory predates it and cannot be
   * trusted. Cleared by the re-read in tick. */
  private justClaimed = false;
  /* Every write goes on the end of this chain, so two saves fired together (two
   * sessions seeding at once) run one after the other rather than snapshotting a
   * half-mutated map, racing on the one pid-named tmp file, or renaming over
   * each other. See save(). */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: StoreOpts) {
    this.opts = opts;
    this.clock = opts.clock ?? realClock;
    // `now` on its own still works (the pure store tests pass a bare function);
    // with a clock and no `now`, the clock is the clock for both.
    this.now = opts.now ?? (() => this.clock.now());
  }

  private get lockFile() { return this.opts.files.lockFile; }
  /** every schedules file this store has read or written, so a save can empty
   *  a file whose last schedule moved or was removed */
  private knownFiles = new Set<string>();

  /* A file's directory, made if it is not there. A fresh engine can have no
   * data tree for an agent at boot and gain one later, so this is asked at
   * each write point (the lock claim, and each save) rather than once in the
   * constructor. mkdir recursive is idempotent and a few microseconds, so it
   * is cheap to be sure every time. */
  private async ensureDirOf(path: string): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) await mkdirPrivate(dir);
  }

  /** Why this store will not act, or null when it will. The endpoints turn it
   *  into a 503 rather than pretending a write happened. */
  refuse(): string | null {
    if (this.poisoned) return this.poisoned;
    if (!this.owns) {
      return "another engine process on this machine is holding the schedule file";
    }
    return null;
  }

  /* ONE PROCESS FIRES. Two of them on one file deliver the same occurrence
   * twice, which is the rule this whole file is built around, and the trigger is
   * ordinary rather than exotic: a restart where the old process outlives the
   * new one's boot, which the deliberately-late first tick sits right inside.
   *
   * TAKEN BY LINKING, NOT BY CREATING, and that is the whole correctness
   * argument. The first version did `open(lock, "wx")` and then awaited a write
   * of the pid into it, which leaves the file EXISTING AND EMPTY for as long as
   * that await takes. A second process reading in that window sees "", cannot
   * parse a pid out of it, concludes the holder is dead and unlinks a live
   * winner's lock. Measured with real engines: twenty started together produced
   * ten owners in one round, and one occurrence was delivered by four processes.
   *
   * Worse, it did not need a race to happen twice. Nothing here fsyncs, so a
   * SIGKILL could leave a zero-byte lock on disk permanently, and from then on
   * EVERY process stole it, deterministically, for ever.
   *
   * `link()` is atomic and fails if the name exists, and the file it points at
   * already has the pid in it, so the lock is never observable without its
   * owner. There is no window to lose.
   *
   * WHO IS DEAD, which a pid alone cannot answer. Pids recycle across a reboot,
   * so a lock naming a pid that now belongs to something unrelated would mute
   * schedules for ever with no way back. The owner therefore stamps the lock
   * with the time on every heartbeat, and a lock that has not been touched for
   * LOCK_STALE_MS is dead whatever its pid says. That is also what recovers a
   * lock left behind by an older build, or one whose contents are unreadable:
   * it goes stale and the engine takes it back by itself. */
  private async claimLock(): Promise<boolean> {
    /* OWNERSHIP IS RE-VALIDATED, NEVER ASSUMED, and this line used to be
     * `if (this.owns) return true`.
     *
     * `owns` is a belief, and a belief formed minutes ago about a file other
     * processes can reach. Two ways it goes wrong, both measured, and both
     * ending in the same place: a laptop lid closes, the engine is SIGSTOPped,
     * its heartbeat goes stale, another engine takes the lock, and on resume
     * the first one carries on believing it is the owner -- writing, firing,
     * and beating its pid back over the live owner's lock. Or an engine boots
     * with its clock a few minutes ahead (an NTP correction, a wake-from-sleep
     * step) and reads a perfectly fresh lock as stale.
     *
     * The duplicate delivery was not the worst of it. The end state was two
     * live processes permanently convinced they owned one file, 172 ticks
     * between them, neither ever reporting that it did not. Nothing healed it,
     * because nothing ever asked again.
     *
     * Asking again costs one small read per tick and turns that permanent state
     * into a transient one: the process that lost finds out on its next tick,
     * drops to loser, and -- because taking the lock again sets `justClaimed` --
     * re-reads the file rather than acting on what it remembered. */
    if (this.owns) {
      if (await this.stillOurs()) return true;
      await this.lost("this process believed it held the schedule file and does not: " +
        "something took it while this one was stopped, slow, or reading a clock that had " +
        "moved. It will not fire or write until it has the lock again");
      // ...and fall through, because it may well be free again by now
    }
    // the lock is a file too, so it needs the directory as much as the store does
    await this.ensureDirOf(this.lockFile).catch(() => {});
    for (let attempt = 0; attempt < 2; attempt++) {
      const tmp = `${this.lockFile}.${process.pid}.claim`;
      try {
        await writePrivate(tmp, JSON.stringify({ pid: process.pid, at: this.now() }));
        // atomic, and the pid is already inside the file it publishes
        await link(tmp, this.lockFile);
        /* The inode behind the name IS the claim from here on: opened once and
         * held, so the heartbeat writes to the thing we created rather than to
         * whatever the name happens to point at later. */
        this.lockFd = await open(this.lockFile, "r+");
        this.lockIno = (await this.lockFd.stat()).ino;
        this.owns = true;
        this.justClaimed = true;
        this.beatAt = this.now();
        return true;
      } catch {
        // somebody holds it
      } finally {
        await unlink(tmp).catch(() => {});
      }

      const held = await this.readLock();
      if (held?.kind === "held" && held.pid === process.pid) {
        // ours already, from an earlier instance inside this same process
        this.lockFd = await open(this.lockFile, "r+").catch(() => null);
        this.lockIno = this.lockFd ? (await this.lockFd.stat()).ino : null;
        if (this.lockIno === null) continue;
        this.owns = true;
        this.justClaimed = true; // whatever is in memory predates holding it
        this.beatAt = this.now();
        return true;
      }
      const age = held ? this.now() - held.at : Number.POSITIVE_INFINITY;
      const dead = !held || held.kind === "unreadable"
        ? !held || age > LOCK_STALE_MS
        : !isRunning(held.pid) || age > LOCK_STALE_MS;
      if (!dead) {
        /* `held` cannot be null here -- a missing lock leaves `age` at Infinity,
         * which makes `dead` true -- but that runs through `dead`, so the
         * checker cannot see it. Stating it in the condition costs nothing and
         * lets the discriminant alias below narrow `held.pid` honestly. */
        if (held && this.now() - this.lockSaidAt > 60_000) {
          this.lockSaidAt = this.now();
          /* WHAT IT IS, and an unreadable lock is not another engine.
           *
           * This said "another engine process holds the schedule file" whatever
           * was in the file, and `refuse()` shows that sentence to the user. A
           * lock nobody can read names nobody, and a NEGATIVE `heldForMs` --
           * which a backward clock step in the holder produces -- is not a
           * duration. Both are said as what they are. */
          const readable = held.kind === "held";
          this.opts.log?.("schedule.not-mine", {
            lock: this.lockFile,
            pid: readable ? held.pid : null,
            lockState: held.kind,
            heldForMs: age >= 0 ? age : null,
            clockWentBackwards: age < 0 || undefined,
            why: readable
              ? "another engine process holds the schedule file; this one will not fire " +
                "or write until that process exits"
              : "the schedule file's lock is there but cannot be read, and it is recent " +
                "enough that it may still belong to a running engine; this one will not " +
                "fire or write until it goes stale or is removed",
          });
        }
        return false;
      }
      /* WHAT WE ACTUALLY KNOW, which is less than the old line claimed.
       *
       * It said "the process that held this is gone". Sometimes that is true.
       * Sometimes the pid answers perfectly well and the lock is merely old --
       * a suspended engine, a slow one, a clock that stepped -- and saying it
       * is gone is a false statement in the one place a person would go to work
       * out what happened. Two branches, each saying only its own fact. */
      const readable = held?.kind === "held";
      const running = readable && isRunning(held.pid);
      this.opts.log?.("schedule.lock-stale", { lock: this.lockFile,
        pid: readable ? held.pid : null, ageMs: held ? age : null,
        lockState: held?.kind ?? "gone", holderRunning: running || undefined,
        why: !held ? "there is no lock file"
          : !readable ? "the lock cannot be read and has not been touched since before the " +
              "stale window"
            : running ? `pid ${held.pid} is still running, but has not touched this lock for ` +
                `${Math.round(age / 1000)}s, which is past the stale window: it is treated as ` +
                "unable to deliver, and it will find out it lost the lock on its next tick"
              : `pid ${held.pid} is not running`,
      });
      await unlink(this.lockFile).catch(() => {}); // and round again to take it
    }
    return false;
  }

  /* WHAT THE LOCK SAYS. Three answers, and they are kept apart because
   * conflating two of them made a live owner drop a lock it was holding.
   *
   *   "held"       a readable pid and a stamp
   *   "unreadable" the file is there and says nothing usable. It is aged by its
   *                own mtime so it can still go stale, but it names NOBODY --
   *                it used to come back as `pid: -1`, which every comparison
   *                then read as "somebody else", so an owner whose lock had
   *                become briefly unreadable concluded it had lost it AND that
   *                another engine held it, and went mute for a whole stale
   *                window telling the user so. Minus one is not a process.
   *   null         there is no lock there at all
   */
  private async readLock(): Promise<
    { kind: "held"; pid: number; at: number } | { kind: "unreadable"; at: number } | null
  > {
    try {
      const raw = await readFile(this.lockFile, "utf8");
      const o = JSON.parse(raw) as { pid?: unknown; at?: unknown };
      const pid = Number(o.pid);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("no pid");
      return { kind: "held", pid, at: Number.isFinite(o.at) ? Number(o.at) : 0 };
    } catch {
      try {
        return { kind: "unreadable", at: (await stat(this.lockFile)).mtimeMs };
      } catch {
        return null;
      }
    }
  }

  /* IS THE LOCK STILL OURS? Asked of the INODE, not of the contents.
   *
   * The lock is claimed by linking a file we made, so the inode behind that
   * name is a thing this process created and nobody else can recreate: if the
   * name still points at it, the lock is ours, whatever the bytes inside say
   * and whoever else is running. That is what makes the answer immune to a
   * momentarily unreadable file, and it is one `stat` rather than a read.
   *
   * NOT throttled and NOT cached. Every caller that is about to act on
   * ownership asks fresh, because the entire class of defect here is a belief
   * about this file outliving the fact. */
  private async stillOurs(): Promise<boolean> {
    if (this.lockIno === null) return false;
    try {
      return (await stat(this.lockFile)).ino === this.lockIno;
    } catch {
      return false; // it is gone, so it is not ours
    }
  }

  /** Ownership dropped, with one line saying so. Safe to call repeatedly. */
  private async lost(why: string): Promise<void> {
    if (!this.owns) return;
    this.owns = false;
    const held = await this.readLock();
    this.opts.log?.("schedule.lock-lost", {
      lock: this.lockFile,
      tookIt: held?.kind === "held" ? held.pid : null,
      lockState: held?.kind ?? "gone",
      why,
    });
    await this.lockFd?.close().catch(() => {});
    this.lockFd = null;
    this.lockIno = null;
  }

  /* Say we are still here, WRITTEN THROUGH THE FILE HANDLE WE OPENED WHEN WE
   * TOOK IT, which is what closes the last window in this file.
   *
   * The heartbeat used to check the lock and then rename a new file over it,
   * and between those two steps -- measured at 0.124ms, and demonstrated -- the
   * lock could change hands, so the rename landed on a live owner's lock. A
   * rename does not care what it lands on.
   *
   * A write through our own descriptor cannot land on anyone else's lock at
   * all: the descriptor is bound to the inode we created. If somebody has since
   * replaced the name, this writes into an inode no longer reachable by it,
   * which is invisible and harmless, and the `stillOurs` check above notices on
   * the same pass. There is no check-then-act to lose. */
  private async beat(force = false): Promise<void> {
    if (!this.owns) return;
    if (!force && this.now() - this.beatAt < LOCK_BEAT_MS) return;
    if (!(await this.stillOurs())) {
      await this.lost("the lock stopped pointing at the file this process created");
      return;
    }
    this.beatAt = this.now();
    try {
      const body = JSON.stringify({ pid: process.pid, at: this.now() });
      await this.lockFd!.truncate(0);
      await this.lockFd!.write(body, 0);
      await this.lockFd!.sync().catch(() => {});
    } catch { /* the inode is orphaned; stillOurs will say so next time */ }
  }

  private async releaseLock(): Promise<void> {
    if (!this.owns) return;
    // by inode, so a lock that has changed hands is never removed by the loser
    const ours = await this.stillOurs();
    this.owns = false;
    await this.lockFd?.close().catch(() => {});
    this.lockFd = null;
    this.lockIno = null;
    if (ours) await unlink(this.lockFile).catch(() => {});
  }

  /** Take the lock, THEN read what is on disk. Anything unreadable AS A RECORD
   *  is dropped; anything unreadable AS A FILE stops this store dead.
   *
   * THE ORDER IS THE POINT, and getting it the other way round delivered a
   * message twice with the lock working perfectly. Two engines both read the
   * file while it said an occurrence was due; one took the lock, fired, wrote
   * "done" and exited; the second then took the freed lock and fired the same
   * occurrence from the copy it had read before any of that happened. The lock
   * has to guard the READ as well as the write, so whoever holds it is holding
   * what the file actually says. `claimLock` sets `justClaimed` on every
   * transition into ownership and `tick` re-reads on it, which covers the other
   * shape of the same thing: taking over from a process that exited later. */
  async load(): Promise<void> {
    await this.claimLock();
    this.justClaimed = false; // this IS the read
    await this.readFromDisk();
    await this.sweepStrays();
    /* Finish the v1 -> v2 migration: write every file back agent-keyed. Only
     * with the lock (a loser must not write), only when a v1 file was actually
     * met, and idempotent per file: a v2 file re-saves as itself. */
    if (this.sawV1 && !this.poisoned && this.owns) {
      await this.save().catch((e) => {
        this.opts.log?.("schedule.migrate-failed", { err: String(e) });
      });
      this.sawV1 = false;
    }
  }

  /* The neighbours a write goes through, left behind by a process that died
   * between making one and putting it in place. Each is named with the pid that
   * made it, so one whose pid is gone is certainly finished with; anything
   * belonging to a live process is left alone. Swept beside the lock and beside
   * every schedules file this store knows. */
  private async sweepStrays(): Promise<void> {
    const targets = new Set<string>([this.lockFile, ...this.knownFiles]);
    for (const t of targets) {
      const dir = t.slice(0, t.lastIndexOf("/")) || ".";
      const base = t.slice(t.lastIndexOf("/") + 1);
      try {
        for await (const name of new Bun.Glob(`${base}*.{tmp,claim,beat}`).scan({ cwd: dir })) {
          const pid = Number(name.split(".").at(-2));
          if (!Number.isInteger(pid) || pid === process.pid || isRunning(pid)) continue;
          await unlink(`${dir}/${name}`).catch(() => {});
        }
      } catch { /* nothing to sweep */ }
    }
  }

  /* Whether the last read met a v1 file (sessionId-keyed records). The load
   * pass finishes the migration by writing everything back as v2 -- once,
   * idempotently, only while this process owns the lock. */
  private sawV1 = false;

  private async readFromDisk(): Promise<void> {
    this.map.clear();
    this.knownFiles.clear();
    this.sawV1 = false;
    let entries: { path: string; agent: string }[];
    try {
      entries = await this.opts.files.list();
    } catch (e) {
      this.poison(`the schedule files could not be listed: ${String(e)}`);
      return;
    }
    for (const { path, agent: dirAgent } of entries) {
      let raw: string;
      try {
        const f = Bun.file(path);
        if (!(await f.exists())) continue;
        raw = await f.text();
      } catch (e) {
        this.poison(`the schedule file could not be read: ${String(e)}`);
        return;
      }
      let j: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        j = parsed as Record<string, unknown>;
      } catch (e) {
        /* THE TORN FILE, and the reason this is not a shrug.
         *
         * A kill during a write, an empty file, anything that is not JSON: an
         * older store caught this, printed to stdout only, and then the next
         * save() wrote an empty map straight over it. Everything he had ever
         * scheduled, gone, with nothing in the log to find afterwards. So it is
         * loud, it is in the structured log where cyclog.sh can see it, and the
         * file is left exactly as found for someone to look at. One torn file
         * poisons the WHOLE store: acting on half the fleet's schedules while
         * refusing to write is a worse state than saying so and stopping. */
        this.poison(`the schedule file ${path} is not readable JSON (${String(e)}); it has been ` +
          "left untouched and nothing will be written over it. Repair or move the file, then " +
          "restart the engine: this process will not look at it again");
        return;
      }
      this.knownFiles.add(path);
      /* ONE SHAPE, whatever the layout: a flat `schedules` map by schedule id.
       * A v1 record names a sessionId; the file already sits in the owning
       * agent's directory, so the migration map is free: the dir's agent id
       * becomes the record's `agent`. The single-file test layout has no agent
       * dirs (dirAgent ""), so there a v1 record keeps its own key. */
      if (j.v === 1 || j.v === undefined) this.sawV1 = true;
      const sched = j.schedules;
      if (!sched || typeof sched !== "object") continue;
      for (const [schedId, v] of Object.entries(sched as Record<string, unknown>)) {
        const sc = coerce(schedId, v, dirAgent);
        if (sc) this.map.set(sc.id, sc);
      }
    }
    /* A repeat whose cursor is missing gets one now. It cannot only be
     * computed at write time: the file may have been edited by hand, and a
     * schedule that was disabled and re-enabled on disk has no cursor at
     * all. A cursor already in the PAST is left alone deliberately -- the
     * catch-up path below is what looks at it. */
    for (const sc of this.map.values()) {
      if (sc.kind === "repeat" && sc.enabled && sc.nextAt === null && sc.cron) {
        sc.nextAt = nextCronAt(sc.cron, this.now(), sc.tz);
      }
    }
  }

  private poison(why: string) {
    this.poisoned = why;
    this.opts.log?.("schedule.store-unreadable", { lock: this.opts.files.lockFile, why });
    console.error(`[schedules] ${why}`);
  }

  /** On disk before this resolves. Every caller that is about to TELL someone a
   *  schedule is set awaits it first; that is the difference between a saved
   *  schedule and a claim that one was saved.
   *
   * Written to a neighbour and RENAMED over the real name, because rename is
   * the only step here that is atomic: a process killed mid-write leaves a
   * complete old file and a stray temp one, never half a schedule store. */
  async save(): Promise<void> {
    const why = this.refuse();
    if (why) throw new Error(why);
    /* ONE WRITE AT A TIME, THIS PROCESS. Two saves fired together -- two
     * sessions seeding their defaults at once was the reported case -- each
     * snapshot the map and each write `<file>.<pid>.tmp`, one pid-named name
     * shared by both. The loser's Bun.write and rename then race the winner's:
     * the tmp is overwritten mid-flight, or renamed away before the second
     * rename runs (ENOENT), or a stale snapshot lands last and drops the other's
     * mutation. Chaining every write behind the previous makes the snapshot and
     * the tmp exclusive to one save, so the last write on disk reflects every
     * mutation made before it and no tmp can collide. The chain itself never
     * rejects; the error is re-thrown to THIS caller only, so one failed write
     * does not wedge the next. */
    const run = this.writeChain.then(() => this.writeOnce(), () => this.writeOnce());
    this.writeChain = run.then(() => {}, () => {});
    return run;
  }

  /* The body of one write, run only from the writeChain in save(). */
  private async writeOnce(): Promise<void> {
    // state can have changed while this write waited its turn in the chain, so
    // ask again rather than trusting the check the caller made before enqueuing
    const why = this.refuse();
    if (why) throw new Error(why);
    /* THE LOCK IS RE-CHECKED AGAINST THE DISK HERE, not against what this
     * process believes, and that is the difference between one delivery and two.
     *
     * `refuse()` above reads the in-memory `owns`, which is a belief formed
     * before the last `await`. A single delivery can outlive the stale window --
     * a lid closing mid-delivery does it at any length, and `deliverToPane`
     * chains with no timeout -- and in that gap another engine takes the lock
     * and fires. The losing process then came back and wrote its WHOLE
     * pre-loss snapshot over the winner's file: occurrences already delivered
     * were restored to due-and-not-done, the winner's record was erased, and
     * the next holder read the file and fired them again. Measured four times
     * out of four, and the file afterwards said `fires: 1`, so nothing recorded
     * that anything had gone out twice.
     *
     * One `stat` immediately before the write. It does not make the write
     * atomic with the check -- nothing here can -- but it closes the window
     * from minutes to microseconds, and every path that acts on the result of a
     * delivery now asks as well. */
    if (!(await this.stillOurs())) {
      await this.lost("the lock changed hands while this process was working, so what it " +
        "was about to write is out of date and was not written");
      throw new Error(this.refuse() ?? "the lock changed hands");
    }
    /* GROUP BY FILE: each schedule belongs where its session's agent lives
     * (files.fileFor). A file this store has read or written before that now
     * holds nothing is rewritten EMPTY rather than skipped, so a schedule that
     * moved agents or was removed does not resurrect from its old file on the
     * next boot. */
    const byFile = new Map<string, Record<string, Schedule>>();
    for (const [id, sc] of this.map) {
      const path = this.opts.files.fileFor(sc.agent);
      let rec = byFile.get(path);
      if (!rec) byFile.set(path, (rec = {}));
      rec[id] = sc;
    }
    const targets = new Set<string>([...byFile.keys(), ...this.knownFiles]);
    for (const path of targets) {
      const out: ScheduleFileShape = { v: 2, schedules: byFile.get(path) ?? {} };
      /* THE DIRECTORY IS MADE EACH WRITE, not once in the constructor. The tmp
       * write and the rename both need the directory to be there at THIS
       * instant; without it a seed into a missing tree died with
       * `ENOENT ... rename '...tmp'`. */
      await this.ensureDirOf(path);
      const tmp = `${path}.${process.pid}.tmp`;
      try {
        await writePrivate(tmp, JSON.stringify(out, null, 2));
        await rename(tmp, path);
      } catch (e) {
        // a failed write must not leave its half-written neighbour lying about
        await unlink(tmp).catch(() => {});
        throw e;
      }
      this.knownFiles.add(path);
    }
  }

  list(agent?: string): Schedule[] {
    const now = this.now();
    const all = [...this.map.values()];
    const mine = agent ? all.filter((s) => s.agent === agent) : all;
    return mine
      /* A claimed occurrence still in the air carries a `retryUntil` (coerce
       * only keeps it for an undelivered record), so that is exactly "overdue
       * and being retried". Attach how late it is as of THIS read, and only
       * then -- a delivered, skipped or given-up row has no live lateness and
       * gets no field, so absent keeps its old meaning. The stored object is
       * never touched; a shallow copy carries the derived number. */
      .map((s) => s.last?.retryUntil === undefined
        ? s
        : { ...s, overdueMs: Math.max(0, now - s.last!.due) })
      .sort((a, b) =>
        (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) || a.createdAt - b.createdAt);
  }

  get(id: string): Schedule | undefined {
    return this.map.get(id);
  }

  /** Take an already-valid schedule straight into memory (task 448 migration),
   *  the way `readFromDisk` does: no create-time validation, because these came
   *  out of a store that already validated them, and no write, because the
   *  migration saves the whole batch once at the end. A repeat that arrives
   *  enabled with no cursor gets one, the same rule the on-disk read applies. */
  adopt(sc: Schedule): void {
    if (sc.kind === "repeat" && sc.enabled && sc.nextAt === null && sc.cron) {
      sc.nextAt = nextCronAt(sc.cron, this.now(), sc.tz);
    }
    this.map.set(sc.id, sc);
  }

  /** Coerce a raw record the way the on-disk read does and adopt it if it can be
   *  believed, returning it, or null if it cannot. The migration of the old
   *  global store (task 448) reaches `coerce` through here so it stays private. */
  adoptRaw(id: string, raw: unknown): Schedule | null {
    const sc = coerce(id, raw);
    if (!sc) return null;
    this.adopt(sc);
    return sc;
  }

  /* NO rekey() ANY MORE. Records key on the stable agent id, which never
   * moves when a session re-keys pane id -> uuid (design identity rule),
   * so there is nothing to chase. */

  /** Create one. Throws with a readable message rather than storing something
   *  that cannot fire; the endpoint turns that into a 400. */
  async create(input: {
    agent: string; name: string; body: string; kind: ScheduleKind;
    tz?: string; at?: number; cron?: string; enabled?: boolean; cwd?: string;
  }): Promise<Schedule> {
    // a store that cannot write must not answer "saved"
    const blocked = this.refuse();
    if (blocked) throw new Error(blocked);
    /* A zone he ASKED for and we cannot read is an error, not a fallback.
     * Quietly writing the host's zone instead would set a schedule for a
     * different hour than the one on screen. Absent is different: that is "you
     * choose", and the host's zone is the answer. */
    if (input.tz !== undefined && !validZone(input.tz)) throw new Error("no such timezone");
    const tz = input.tz || hostZone();
    const name = String(input.name ?? "").trim().slice(0, 60);
    const body = String(input.body ?? "").trim();
    if (!name) throw new Error("a schedule needs a name");
    if (!body) throw new Error("a schedule needs a message");
    const sc: Schedule = {
      id: `sch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      agent: input.agent, name, body, kind: input.kind, tz,
      enabled: input.enabled !== false,
      createdAt: this.now(), nextAt: null, fires: 0,
      /* WHICH CONVERSATION, said in something more durable than a pane id.
       *
       * A pane id is the engine's handle for a session and it is not a promise
       * about identity: it is monotonic inside one herdr server, and what
       * happens to it across a herdr RESTART has not been measured. If an id can
       * ever come back on a different pane, a schedule keyed only on it types
       * "write the standup" into somebody else's conversation. The cwd is
       * checked at fire time and a mismatch refuses to deliver. */
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
    if (input.kind === "once") {
      if (!Number.isFinite(input.at)) throw new Error("a one-off needs a time");
      /* A time already gone is refused at creation rather than fired the moment
       * it is saved. The app can only produce one by being wrong about the
       * clock, and "I set it for 9am" quietly meaning "it went off as you
       * pressed save" is the app asserting what it does not know. */
      if (input.at! <= this.now()) throw new Error("that time has already passed");
      sc.at = Math.round(input.at!);
      sc.nextAt = sc.enabled ? sc.at : null;
    } else {
      if (!input.cron || !parseCron(input.cron)) throw new Error("that is not a cron expression");
      sc.cron = input.cron.trim();
      sc.nextAt = sc.enabled ? nextCronAt(sc.cron, this.now(), tz) : null;
      if (sc.enabled && sc.nextAt === null) throw new Error("that cron never comes round");
    }
    this.map.set(sc.id, sc);
    try {
      await this.save();
    } catch (e) {
      // it is not scheduled if it is not on disk, so it is not in memory either
      this.map.delete(sc.id);
      throw e;
    }
    this.opts.onChange?.();
    return sc;
  }

  /** Change one. Anything that moves WHEN it fires recomputes the cursor, so an
   *  edit can never leave a schedule pointing at the old time. */
  async update(id: string, patch: {
    name?: string; body?: string; tz?: string; at?: number; cron?: string; enabled?: boolean;
    cwd?: string; kind?: ScheduleKind;
  }): Promise<Schedule> {
    const blocked = this.refuse();
    if (blocked) throw new Error(blocked);
    const sc = this.map.get(id);
    if (!sc) throw new Error("no such schedule");
    /* A ONE-OFF CAN BECOME A REPEAT AND BACK (his call, 2026-08-09): the
     * once<->repeat wall only meant a spent morning-report could never be made
     * daily without deleting it. The flip just requires the field the new kind
     * lives by, which the branches below then validate like any other edit. */
    if ((patch.kind === "once" || patch.kind === "repeat") && patch.kind !== sc.kind) {
      // fully validated BEFORE anything mutates, so a refused flip leaves the
      // record exactly as it was
      if (patch.kind === "once" && (!Number.isFinite(patch.at) || patch.at! <= this.now())) {
        throw new Error("a one-off needs a time that has not passed");
      }
      if (patch.kind === "repeat" && (!patch.cron || !parseCron(patch.cron))) {
        throw new Error("a repeating schedule needs a cron");
      }
      sc.kind = patch.kind;
      if (patch.kind === "once") sc.cron = undefined;
      else { sc.at = undefined; sc.done = false; }
    }
    if (patch.name !== undefined) {
      const n = String(patch.name).trim().slice(0, 60);
      if (!n) throw new Error("a schedule needs a name");
      sc.name = n;
    }
    if (patch.body !== undefined) {
      const b = String(patch.body).trim();
      if (!b) throw new Error("a schedule needs a message");
      sc.body = b;
    }
    if (patch.tz !== undefined) {
      if (!validZone(patch.tz)) throw new Error("no such timezone");
      sc.tz = patch.tz;
    }
    if (patch.at !== undefined) {
      if (sc.kind !== "once") throw new Error("only a one-off has a single time");
      if (!Number.isFinite(patch.at)) throw new Error("a one-off needs a time");
      if (patch.at <= this.now()) throw new Error("that time has already passed");
      sc.at = Math.round(patch.at);
      sc.done = false; // moved to a new time: it has a slot again
    }
    if (patch.cron !== undefined) {
      if (sc.kind !== "repeat") throw new Error("only a repeating schedule has a cron");
      if (!parseCron(patch.cron)) throw new Error("that is not a cron expression");
      sc.cron = patch.cron.trim();
    }
    /* THE DIRECTORY IS EDITABLE, because projects get moved.
     *
     * The cwd guard refuses to deliver into a pane whose directory no longer
     * matches, which is right for a reused pane id and WRONG for a project that
     * was renamed: the same conversation, in a new place, failing silently every
     * day for ever with a row that looks perfectly healthy. Without this the
     * only way out was to delete the schedule and write it again. */
    /* CHECKED, because an unchecked one repairs nothing.
     *
     * There is no control for this in the app: the repair is a curl, typed by
     * hand, and `"  "` or `"not/a/real/path"` stored happily with a 200. That
     * puts the schedule straight back into the state this field exists to get it
     * out of -- failing every day against a directory that can never match,
     * behind a row that looks perfectly healthy. Absolute, and it has to be a
     * directory that is really there. */
    if (patch.cwd !== undefined) {
      /* EMPTY CLEARS IT. WHITESPACE IS A MISTAKE.
       *
       * These were the same thing, because the value was trimmed first: `"   "`
       * became empty, skipped the checks, cleared the field and answered 200.
       * Clearing the field REMOVES the wrong-conversation guard entirely, so a
       * stray space in a hand-typed curl silently switched off the protection
       * and reported success. Only a genuinely empty string may clear it. */
      if (patch.cwd === "") sc.cwd = undefined;
      else {
        const want = patch.cwd;
        if (want.trim() !== want || !want.trim()) {
          throw new Error("a directory cannot be blank or padded with spaces");
        }
        if (!want.startsWith("/")) throw new Error("a directory has to be an absolute path");
        /* RESOLVED, because the guard is a string comparison and "exists" is
         * not the same question as "can ever match". A trailing slash, a
         * doubled slash, a symlinked alias, and `/tmp` on macOS (which sessions
         * see as `/private/tmp`) all exist and none of them equals what the
         * session reports -- so the repair was accepted with a 200 and then
         * failed silently every day, which is the state this field exists to
         * get out of. Both sides are resolved: here, and at the fire. */
        let real: string;
        try {
          real = await realpath(want);
        } catch {
          throw new Error(`there is no directory at ${want}`);
        }
        if (!(await stat(real)).isDirectory()) throw new Error(`${want} is not a directory`);
        sc.cwd = real;
      }
    }
    if (patch.enabled !== undefined) sc.enabled = patch.enabled;
    this.recompute(sc);
    await this.save();
    this.opts.onChange?.();
    return sc;
  }

  async remove(id: string): Promise<boolean> {
    const blocked = this.refuse();
    if (blocked) throw new Error(blocked);
    const had = this.map.get(id);
    if (!had) return false;
    this.map.delete(id);
    try {
      await this.save();
    } catch (e) {
      this.map.set(id, had); // still on disk, so still here
      throw e;
    }
    this.opts.onChange?.();
    return true;
  }

  /* There is deliberately no "remove everything for this session". A dead pane
   * keeps its schedules: pane ids come back, the chat log already survives the
   * process, and a schedule quietly deleted because a tab was closed is a
   * setting that disappeared without anyone asking for it. They are removed one
   * at a time, by hand, from the pane that lists them. */

  private recompute(sc: Schedule) {
    if (!sc.enabled) { sc.nextAt = null; return; }
    if (sc.kind === "once") {
      sc.nextAt = sc.done ? null : (sc.at ?? null);
    } else if (sc.cron) {
      sc.nextAt = nextCronAt(sc.cron, this.now(), sc.tz);
    }
  }

  start() {
    if (this.timer) return;
    this.timer = this.clock.setInterval(() => { void this.tick(); }, TICK_MS);
    /* Hand the lock back on the way out, so an ordinary restart takes over at
     * once instead of waiting for the new process to notice the old pid is
     * gone. The pid-liveness check is what covers a hard kill; this is the
     * normal path, and it also keeps a recycled pid from ever looking like a
     * live holder. */
    process.once("exit", () => {
      if (!this.owns) return;
      /* THE PID CHECK, which releaseLock has and this did not.
       *
       * `owns` is this process's belief, and a belief can be stale: if anything
       * ever took the lock from under us, unlinking on the way out would free a
       * live owner's lock for a third process. Cheap insurance, and an exit
       * handler cannot await, so it reads synchronously. */
      try {
        const held = JSON.parse(readFileSync(this.lockFile, "utf8")) as { pid?: number };
        if (Number(held.pid) === process.pid) unlinkSync(this.lockFile);
      } catch { /* not there, or not ours */ }
    });
  }

  stop() {
    if (this.timer) this.clock.clearInterval(this.timer);
    this.timer = null;
    void this.releaseLock();
  }

  /** One pass over everything due. Exposed so a test can drive time rather than
   *  wait for it. Serial on purpose: two schedules due in the same minute are
   *  two messages typed one after the other, never interleaved. */
  async tick(): Promise<void> {
    if (this.firing) return; // a slow delivery must not have a second tick behind it
    if (this.poisoned) return; // nothing is trustworthy and nothing may be written
    /* Asked EVERY tick, not once at boot. The loser of the lock is usually the
     * new process during a restart, and it has to become the winner by itself
     * the moment the old one exits rather than sitting mute until somebody
     * notices. Nothing fires while it is not ours. */
    if (!(await this.claimLock())) return;
    /* JUST TOOK IT, so re-read: whatever is in memory is from before we had any
     * right to act on it, and the process that did have that right may have
     * fired something and written it down since. This is the second half of the
     * double delivery -- two engines both read a due occurrence, one fired and
     * exited, and the other inherited the lock still believing it was due. */
    if (this.justClaimed) {
      this.justClaimed = false;
      await this.readFromDisk();
      if (this.poisoned) return;
    }
    await this.beat(); // still here, so the lock does not look abandoned
    this.firing = true;
    try {
      const now = this.now();
      for (const sc of [...this.map.values()]) {
        /* A LONG PASS MUST NOT STALE ITS OWN LOCK. One tick works through every
         * due schedule serially, and a catch-up where each delivery waits on an
         * unresponsive pane can run for minutes: without a heartbeat inside the
         * loop, the lock would age past the stale window while this process was
         * busy holding it, and another engine would rightly conclude it was
         * dead. `beat` throttles itself, so this costs nothing on a normal pass.
         *
         * It also stops: if the heartbeat finds the lock is no longer ours, we
         * have no business delivering anything else this round. */
        await this.beat();
        if (!this.owns) break;
        /* NO open-session gate here any more (task 448's pause): a closed
         * session's attempt comes back { ok:false, retriable:true } from the
         * host's deliver, and the GRACE_MS/nextTryAt ladder absorbs it. One
         * seam fewer; same observable pause. */
        /* The retry pass comes FIRST, so a session that came back at 7:40 gets
         * this morning's message before anything due at 7:45. Only an
         * occurrence that typed nothing is ever in here (FireRecord.retryUntil). */
        /* One branch, not two, and `attempt` decides whether there is another
         * one after it. The previous shape had the tick choose between trying
         * and giving up, and the two disagreed about where the window ended:
         * the backoff put the last attempt at +106 minutes and then the give-up
         * branch fired at +120, so a pane that came back between 106 and 119
         * minutes got nothing at all -- while the record it left said the
         * message "stayed that way for the 2 hours it was worth retrying for".
         * It had stopped asking after 106. `retryAt` is clamped to the deadline
         * now, so the last attempt lands ON it. */
        /* ONE SCHEDULE'S TROUBLE IS NOT THE TICK'S, and it is not stderr's
         * either.
         *
         * `save` throws when the lock has changed hands under it, which is
         * exactly right and is how the stale snapshot is refused -- but nothing
         * caught it, and the tick is driven by `void this.tick()`, so it left a
         * stack trace on stderr and turned the process's eventual exit code
         * into a 1. With the shipped constants that window is microseconds and
         * it was never once observed, but "never seen" is not "cannot happen",
         * and a stack trace is not how a lock handover should report itself.
         * It is one line, in the same log as everything else. */
        try {
          const last = sc.last;
          if (last && last.outcome === "undelivered" && last.retryUntil &&
              (last.retryAt ?? 0) <= now) {
            await this.attempt(sc, last, now);
            if (!this.owns) break; // the attempt found the lock gone
          }
          if (!sc.enabled || sc.nextAt === null || sc.nextAt > now) continue;
          await this.fire(sc, now);
        } catch (e) {
          this.opts.log?.("schedule.tick-failed", {
            schedule: sc.id, name: sc.name, agent: sc.agent,
            err: (e as Error)?.message ?? String(e), owns: this.owns,
            why: "this schedule was left where it was for this pass. If the lock changed " +
              "hands, nothing was written on purpose and the next holder works from the " +
              "file rather than from anything this process remembered",
          });
        }
        /* STOP, and this is the line that turns the blocker into one message
         * rather than a cascade. A delivery that outlived the lock leaves this
         * process holding a map from before it lost it, in which everything the
         * new owner has since fired still looks due. Carrying on down the list
         * would send each of those again from memory. */
        if (!this.owns) break;
      }
    } finally {
      this.firing = false;
    }
  }

  private async fire(sc: Schedule, now: number) {
    /* WHICH OCCURRENCE, when several went by while nobody was running.
     *
     * The one we honour is the LATEST that has already come round, and the
     * earlier ones are counted, not sent. Coming back from an overnight restart
     * to seven identical "morning plan" messages is not the feature working, it
     * is the channel becoming unreadable. One message, and it says how many it
     * stands for. */
    let due = sc.nextAt!;
    let missed = 0;
    if (sc.kind === "repeat" && sc.cron) {
      for (;;) {
        const n = nextCronAt(sc.cron, due, sc.tz);
        if (n === null || n > now) { sc.nextAt = n; break; }
        missed++;
        due = n;
      }
    } else {
      sc.nextAt = null;
      sc.done = true;
    }
    sc.fires++;
    const lateMs = now - due;

    /* NO SKIP STATE ANY MORE (his ladder, 2026-08-09): a late run always
     * DELIVERS SOMETHING. Under five minutes it delivers silently; later than
     * that the deliver side notes the lateness; several missed runs still
     * merge into the latest with a count; and past a day the deliver side
     * sends a status line instead of the body (when it last fired, and the
     * schedule) -- see the deliver callback in server.ts. The old behaviour
     * skipped anything more than two hours stale, which read as the channel
     * silently eating a cron. */

    /* THE CLAIM. The cursor has already moved past this occurrence and the next
     * line puts that on disk. Everything after it is best-effort: a crash from
     * here on costs this one message and can never repeat it. */
    sc.last = {
      due, at: now, outcome: "unknown", tries: 1,
      /* MINT THE OCCURRENCE'S DELIVERY ID HERE, once, at the claim. Every retry
       * of this occurrence carries it (attempt copies it off the claim below),
       * so a stranded body typed on the first attempt is recognised by its
       * retry and the enter-only dedupe holds inside the stranded TTL. */
      deliveryId: newCid("sched"),
      ...(lateMs > 60_000 ? { lateMs } : {}), ...(missed ? { missed } : {}),
    };
    await this.save();
    this.opts.log?.("schedule.firing", {
      schedule: sc.id, name: sc.name, agent: sc.agent, kind: sc.kind,
      due: new Date(due).toISOString(), lateMs, missed,
      nextAt: sc.nextAt ? new Date(sc.nextAt).toISOString() : null,
    });
    this.opts.onChange?.();

    await this.attempt(sc, sc.last, now);
  }

  /** One delivery attempt for an occurrence already claimed. Called for the
   *  first try and for every retry, so there is one place that decides what a
   *  result means. */
  private async attempt(sc: Schedule, claim: FireRecord, now: number) {
    const tries = (claim.tries ?? 1) + (claim.outcome === "unknown" ? 0 : 1);
    let res: { ok: boolean; why?: string; retriable?: boolean };
    try {
      res = await this.opts.deliver(sc, {
        due: claim.due, at: now, lateMs: now - claim.due, missed: claim.missed ?? 0, try: tries,
        /* The occurrence's id, stable across retries. A record migrated from
         * before this field (or a fake deliver in a test) may not carry one;
         * mint a fallback so the type holds, but a genuine occurrence always
         * has the id fire() minted. */
        deliveryId: claim.deliveryId ?? (claim.deliveryId = newCid("sched")),
      });
    } catch (e) {
      res = { ok: false, why: (e as Error)?.message ?? "delivery threw" };
    }
    /* DID WE STILL HOLD THE LOCK WHILE THAT WAS HAPPENING?
     *
     * A delivery is the one thing here that can take minutes, and if the lock
     * changed hands during it then everything below -- the record, the save --
     * is built on a snapshot from before. `save` would refuse it now, but
     * refusing silently is not enough: if the message DID go out, it went out
     * from a process that no longer had the right to send it, and another
     * engine has probably sent it too. That is the one case where this file
     * cannot keep its promise, and the only honest thing left is to say so
     * loudly, in the log, naming the occurrence -- because the file belongs to
     * somebody else now and cannot be told.
     *
     * AND THE LIMIT OF THAT CLAIM, so nobody reads more into it than it says.
     * This line is the only record of a message that went out AFTER THE LOCK
     * CHANGED HANDS. It is not a guarantee that every delivery leaves a record.
     * If the save below fails for any other reason -- a full disk, a store
     * directory that has become unwritable -- the message has still gone out
     * and there is nothing anywhere: no line here, and on disk the claim's
     * `unknown`, which is at least not a lie but is not a record of a delivery
     * either. That gap predates this code and is not fixed here; it is written
     * down because "the only record there will ever be" is true of the lock
     * case and would be a false comfort if read as covering all of them. */
    if (!(await this.stillOurs())) {
      await this.lost("the lock changed hands while a delivery was in flight");
      this.opts.log?.(res.ok ? "schedule.delivered-without-lock" : "schedule.abandoned", {
        schedule: sc.id, name: sc.name, agent: sc.agent, tries,
        due: new Date(claim.due).toISOString(),
        why: res.ok
          ? "this message was delivered by a process that had lost the schedule lock while " +
            "it was in flight. Nothing was written, because the file belongs to another " +
            "engine now -- so this line is the only record that it went out, and another " +
            "engine may have sent it as well"
          : "the lock changed hands during this attempt; nothing was written and no retry " +
            "is scheduled from here",
      });
      return;
    }
    /* The retry window is measured from the occurrence, not from the attempt,
     * so a session that stays down does not get retried for ever: it is the
     * same two hours after which a fire is no longer worth having.
     *
     * The NEXT attempt is the backoff, CLAMPED to that deadline, so the last
     * one lands on the edge of the window rather than short of it. Unclamped,
     * the doubling would overshoot the deadline and leave the tail of the
     * window dead: a pane that came back inside the window would get nothing,
     * while the record still claimed the full two hours of trying. */
    const deadline = claim.due + GRACE_MS;
    const keepTrying = !res.ok && res.retriable === true && now < deadline;
    const retryAt = keepTrying ? Math.min(nextTryAt(now, tries), deadline) : undefined;
    /* HOW LATE THE MESSAGE ACTUALLY WAS, measured at the attempt that carried
     * it and not copied off the claim. Copying it meant a message that landed
     * on the fourth retry, 110 minutes after it was due, wrote the claim's
     * lateMs of zero and the pane read "Last sent 08:50" exactly like an on-time
     * one. The agent's own line said "110 min late" in the same breath: the app
     * was the only surface lying about it. */
    const lateMs = now - claim.due;
    /* WHAT THE ROW SAYS WHEN THE TRYING IS OVER, and it says what happened
     * rather than what the window was for. The old sentence claimed two hours
     * of trying whatever the truth; this one is built from the attempts that
     * were actually made and when the last of them was. */
    const gaveUp = !res.ok && !keepTrying && claim.retryUntil !== undefined;
    const why = res.ok ? undefined
      : gaveUp
        ? `${res.why ?? "it could not be delivered"}, and it was still that way on the ` +
          `last of ${tries} attempts, ${Math.round(lateMs / 60_000)} minutes after it was due`
        : (res.why ?? "it could not be delivered");
    sc.last = {
      due: claim.due, at: now, outcome: res.ok ? "delivered" : "undelivered", tries,
      // carry the occurrence's id forward so the NEXT retry keys on the same one
      ...(claim.deliveryId ? { deliveryId: claim.deliveryId } : {}),
      ...(lateMs > 60_000 ? { lateMs } : {}),
      ...(claim.missed ? { missed: claim.missed } : {}),
      ...(why ? { why } : {}),
      ...(keepTrying ? { retryUntil: deadline, retryAt } : {}),
    };
    /* A FAILING RETRY WITH NOTHING NEW TO SAY IS SILENT, and that is what lets
     * the cadence above be as frequent as it is. This occurrence was already
     * claimed and already broadcast as undelivered on its first failure; a
     * probe that finds the pane still unreachable moves only the clock. Writing
     * the whole file and broadcasting every schedule body to every device on
     * each such probe is the exact cost that once forced the retry to be coarse.
     *
     * Nothing about "fire exactly once" rests on this write: the cursor moved at
     * the claim, not here, and the in-memory `retryAt` is enough to pace the
     * next probe. A restart that loses it re-reads a record whose `retryAt` is
     * already in the past and retries at once, which is if anything more prompt.
     * We speak only when the answer changes -- the first failure (claim ->
     * undelivered, which sets retryUntil on disk), a delivery, or giving up. */
    const quiet = keepTrying && claim.outcome === "undelivered";
    if (quiet) return;
    await this.save();
    this.opts.log?.(res.ok ? "schedule.delivered"
      : gaveUp ? "schedule.gave-up" : "schedule.undelivered", {
      schedule: sc.id, name: sc.name, agent: sc.agent, tries,
      due: new Date(claim.due).toISOString(), why,
      retryAt: retryAt ? new Date(retryAt).toISOString() : undefined,
    });
    this.opts.onChange?.();
  }
}

/* What a stored object has to look like to be believed. A field that is the
 * wrong shape drops the whole schedule rather than being defaulted: half of a
 * time is not a time. */
function coerce(id: string, v: unknown, agentHint = ""): Schedule | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const kind = o.kind === "once" || o.kind === "repeat" ? o.kind : null;
  if (!kind) return null;
  /* v2 records carry `agent`; a v1 record carries `sessionId`, and the
   * migration maps it to the agent whose directory the file sits in
   * (agentHint). The single-file test layout has no agent dirs, so there a v1
   * record keeps its own sessionId as its agent key. */
  const agent = str("agent") || agentHint || str("sessionId");
  const name = str("name");
  const body = str("body");
  if (!agent || !name || !body) return null;
  const tz = validZone(str("tz")) ? str("tz") : hostZone();
  const sc: Schedule = {
    id: typeof o.id === "string" && o.id ? (o.id as string) : id,
    agent, name, body, kind, tz,
    ...(str("cwd") ? { cwd: str("cwd") } : {}),
    enabled: o.enabled !== false,
    createdAt: Number.isFinite(o.createdAt) ? Number(o.createdAt) : Date.now(),
    nextAt: Number.isFinite(o.nextAt) ? Number(o.nextAt) : null,
    fires: Number.isFinite(o.fires) ? Number(o.fires) : 0,
  };
  if (kind === "once") {
    if (!Number.isFinite(o.at)) return null;
    sc.at = Number(o.at);
    if (o.done === true) sc.done = true;
  } else {
    const cron = str("cron");
    if (!parseCron(cron)) return null;
    sc.cron = cron;
  }
  const last = o.last as Record<string, unknown> | undefined;
  if (last && typeof last === "object" && Number.isFinite(last.due)) {
    sc.last = {
      due: Number(last.due),
      at: Number.isFinite(last.at) ? Number(last.at) : Number(last.due),
      outcome: (["delivered", "undelivered", "skipped", "unknown"] as const)
        .includes(last.outcome as FireOutcome) ? (last.outcome as FireOutcome) : "unknown",
      ...(typeof last.why === "string" ? { why: last.why } : {}),
      ...(Number.isFinite(last.lateMs) ? { lateMs: Number(last.lateMs) } : {}),
      ...(Number.isFinite(last.missed) ? { missed: Number(last.missed) } : {}),
      /* A retry in flight survives the restart, which is the case it exists
       * for: the engine going down IS why the pane was not there. An "unknown"
       * outcome never carries one, so a process that died mid-delivery comes
       * back and leaves that message alone. */
      ...(Number.isFinite(last.retryUntil) && last.outcome === "undelivered"
        ? { retryUntil: Number(last.retryUntil) } : {}),
      ...(Number.isFinite(last.retryAt) ? { retryAt: Number(last.retryAt) } : {}),
      ...(Number.isFinite(last.tries) ? { tries: Number(last.tries) } : {}),
      /* The occurrence's delivery id survives the restart alongside its retry
       * state, so a retry that resumes after a process death keeps keying the
       * stranded note on the same id. */
      ...(typeof last.deliveryId === "string" ? { deliveryId: last.deliveryId } : {}),
    };
  }
  return sc;
}
