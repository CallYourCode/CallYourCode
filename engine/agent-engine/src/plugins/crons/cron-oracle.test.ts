/* A SECOND OPINION about what a cron expression means, written to disagree.
 *
 * WHY THIS FILE IS SEPARATE FROM schedules.test.ts. That file asserts what I
 * believed the answers were, and a parser tested against its own author's
 * expectations agrees with itself: `0 0 * * 0-7` shipped meaning "Sundays
 * only", accepted silently, with the preview cheerfully repeating the wrong
 * answer. Nothing there caught it because nothing there disagreed with it.
 *
 * So the oracle below is written from the crontab(5) rules and Vixie's source
 * behaviour, NOT from schedules.ts, and deliberately in a different shape:
 *
 *   - it decides membership with a bitmap built one value at a time, where
 *     schedules.ts walks ranges with a step;
 *   - it finds the next occurrence by stepping a MINUTE at a time from the
 *     start, where schedules.ts enumerates the calendar and resolves each
 *     candidate wall clock on its own;
 *   - it is run in UTC only, on purpose. Every rule under test here (the 7,
 *     the star, the day rule, ranges, steps, lists, names) is about the
 *     EXPRESSION and has nothing to do with zones, and in UTC a wall clock and
 *     an instant are the same thing, so a minute-stepping oracle is exactly
 *     right and has no daylight saving opinions to be wrong about. The two
 *     daylight saving behaviours are measured against hand-computed instants
 *     in schedules.test.ts instead, because there a brute-force scan would be
 *     asserting the same assumption it is meant to check.
 *
 *   bun test agent-engine/src/plugins/crons/cron-oracle.test.ts
 */

import { test, expect } from "bun:test";
import { nextCronAt, parseCron } from "./schedules.ts";

/* -------------------------------------------------------------- the oracle */

type OracleField = { star: boolean; hit: boolean[] };
type Oracle = { mi: OracleField; h: OracleField; dom: OracleField; mo: OracleField; dow: OracleField };

const NAMED_MONTH = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
const NAMED_DAY = "sun mon tue wed thu fri sat".split(" ");

/** One field, as a bitmap. Returns null for anything crontab(5) would reject. */
function oracleField(src: string, lo: number, hi: number, names: string[] | null,
  sundayIsAlsoSeven = false): OracleField | null {
  const top = sundayIsAlsoSeven ? 7 : hi;
  const hit: boolean[] = new Array(hi + 1).fill(false);
  let star = false;
  let any = false;
  const value = (t: string): number | null => {
    const s = t.trim().toLowerCase();
    if (names) {
      const i = names.indexOf(s.slice(0, 3));
      if (i >= 0 && s.length === 3) return names === NAMED_MONTH ? i + 1 : i;
    }
    if (!/^\d+$/.test(s)) return null;
    return Number(s);
  };
  const mark = (v: number) => {
    // seven o'clock does not exist in a week: it is Sunday, said the other way
    hit[sundayIsAlsoSeven && v === 7 ? 0 : v] = true;
    any = true;
  };
  for (const item of src.split(",")) {
    const t = item.trim();
    if (t === "") return null;
    const bits = t.split("/");
    if (bits.length > 2) return null;
    let step = 1;
    if (bits.length === 2) {
      if (!/^\d+$/.test(bits[1])) return null;
      step = Number(bits[1]);
      if (step < 1) return null;
    }
    const spec = bits[0];
    let a: number, b: number;
    if (spec === "*") {
      star = true;
      a = lo; b = top;
    } else if (spec.includes("-")) {
      const ends = spec.split("-");
      if (ends.length !== 2) return null;
      const l = value(ends[0]), r = value(ends[1]);
      if (l === null || r === null) return null;
      a = l; b = r;
    } else {
      const v = value(spec);
      if (v === null) return null;
      a = v;
      b = bits.length === 2 ? top : v; // `5/2` runs from 5 to the top of the field
    }
    if (a < lo || b > top || a > b) return null;
    for (let v = a; v <= b; v++) if ((v - a) % step === 0) mark(v);
  }
  return any ? { star, hit } : null;
}

const MACRO: Record<string, string> = {
  "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function oracleParse(expr: string): Oracle | null {
  if (typeof expr !== "string") return null;
  const text = (MACRO[expr.trim().toLowerCase()] ?? expr).trim();
  if (text === "") return null;
  const f = text.split(/\s+/);
  if (f.length !== 5) return null;
  const mi = oracleField(f[0], 0, 59, null);
  const h = oracleField(f[1], 0, 23, null);
  const dom = oracleField(f[2], 1, 31, null);
  const mo = oracleField(f[3], 1, 12, NAMED_MONTH);
  const dow = oracleField(f[4], 0, 6, NAMED_DAY, true);
  if (!mi || !h || !dom || !mo || !dow) return null;
  return { mi, h, dom, mo, dow };
}

/** Does this DAY run the job at all? Vixie: a star on EITHER day field means the
 *  two are ANDed; with neither a star they are ORed. */
function oracleDayMatches(o: Oracle, t: Date): boolean {
  if (!o.mo.hit[t.getUTCMonth() + 1]) return false;
  const dom = o.dom.hit[t.getUTCDate()];
  const dow = o.dow.hit[t.getUTCDay()];
  return o.dom.star || o.dow.star ? dom && dow : dom || dow;
}

/** Does this minute run the job? */
function oracleMatches(o: Oracle, t: Date): boolean {
  if (!o.mi.hit[t.getUTCMinutes()]) return false;
  if (!o.h.hit[t.getUTCHours()]) return false;
  return oracleDayMatches(o, t);
}

/** The next run, found by asking every single minute. UTC only (see the top).
 *
 * `at: null` with a `scanned` horizon is "not in the stretch I looked at", NOT
 * "never": asking every minute of five years costs millions of iterations, so
 * the oracle looks at a bounded stretch and SAYS where it stopped. The caller
 * turns that into the real check -- schedules.ts must not claim an occurrence
 * inside a window the oracle swept and found empty. Collapsing the two into a
 * bare null is how the leap-day line `0 0 29 2 *` came out as a failure on its
 * SECOND occurrence (2028 to 2032 is four years, past an 800 day horizon)
 * when both sides were in fact right. */
function oracleNext(expr: string, afterMs: number, withinDays = 800):
  { at: number | null; scanned: number } {
  const o = oracleParse(expr);
  const stop = afterMs + withinDays * 86_400_000;
  if (!o) return { at: null, scanned: stop };
  let ms = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  while (ms <= stop) {
    const t = new Date(ms);
    /* STILL ONE MINUTE AT A TIME, just not one ITERATION per minute. A day whose
     * date fields do not match cannot contain a matching minute, and neither can
     * an hour the hour field excludes, so those are stepped over whole. This is
     * arithmetic on the calendar, not a second opinion about the expression:
     * oracleDayMatches and the two bitmaps below are the same judges the
     * minute-by-minute walk used, and nothing about which minutes match has
     * changed. Without it a leap-day line costs ~1.1 million Date constructions
     * per start and the whole file runs for eight seconds. */
    if (!oracleDayMatches(o, t)) {
      ms = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1);
      continue;
    }
    if (!o.h.hit[t.getUTCHours()]) {
      ms = Math.floor(ms / 3_600_000) * 3_600_000 + 3_600_000;
      continue;
    }
    if (o.mi.hit[t.getUTCMinutes()]) return { at: ms, scanned: stop };
    ms += 60_000;
  }
  return { at: null, scanned: stop };
}

/* The skipping walk above must answer exactly what the naive one did, so the
 * naive one is kept and the two are compared on the corpus below. */
function oracleNextNaive(expr: string, afterMs: number, withinMinutes: number): number | null {
  const o = oracleParse(expr);
  if (!o) return null;
  const stop = afterMs + withinMinutes * 60_000;
  for (let ms = Math.floor(afterMs / 60_000) * 60_000 + 60_000; ms <= stop; ms += 60_000) {
    if (oracleMatches(o, new Date(ms))) return ms;
  }
  return null;
}

/* ------------------------------------------------------------- the corpus */

/* Ordinary lines, his own crontab's lines, and every shape the two of them
 * disagreed about. The 7s are here because that is where the accepted-and-
 * wrong answers were; the stepped stars are here because that is where the
 * day rule was wrong. */
const EXPRESSIONS = [
  // from a real crontab (crontab.proposed.txt)
  "0 7 * * *", "0 18 * * 1-5", "0 22 * * *", "0 9 * * *", "0 5 * * *",
  "0 11 * * 0", "0 11 1 * *", "0 11 15 3,6,9,12 *", "0 11 1 1,7 *", "0 11 2 1 *",
  "0 6 * * 4", "0 6 * * 1,4", "0 6 7,24 * *", "0 6 5 * *", "0 6 1 * *",
  "0 6 15 1 *", "0 6 20 1 *", "0 6 10 3 *", "0 6 1 4 *", "0 6 1 7 *",
  "0 6 15 7 *", "0 6 1 12 *", "0 8 * * *", "40 15 * * 1-5",
  // the seven, in every position it can take
  "0 0 * * 7", "0 0 * * 0-7", "0 0 * * 1-7", "0 0 * * 5-7", "0 0 * * 6-7",
  "0 0 * * 3-7", "0 0 * * 0-6", "0 0 * * 7-7", "0 0 * * 1-7/2", "0 0 * * 0,7",
  "0 0 * * fri-sun", "0 0 * * mon-sun", "0 0 * * sun-sat", "0 0 * * mon,thu",
  // the day rule, with and without a leading star
  "0 0 13 * 5", "0 0 1 * 1", "0 0 13 * *", "0 0 * * 5", "0 0 */2 * 5",
  "0 0 */3 * 1", "0 0 1-7 * 6", "0 0 15 * 0", "0 0 */2 * *", "0 0 1,15 * 3",
  // steps and lists everywhere
  "*/15 * * * *", "*/7 */3 * * *", "5/10 * * * *", "0 */6 * * *", "30 8-18/2 * * 1-5",
  "0,30 9,17 * * *", "*/1 0 1 1 *", "59 23 31 12 *", "0 0 29 2 *", "0 0 30 2 *",
  "15 14 1 * *", "0 22 * * 1-5", "23 0-23/2 * * *", "5 4 * * sun", "0 0 1 jan *",
  "0 0 * jan-mar *", "0 0 * jan,jul *", "@daily", "@weekly", "@monthly", "@hourly",
  "@yearly", "@midnight",
  // things that must be refused, by both
  "0 7 * *", "0 7 * * * *", "", "   ", "every morning", "0 25 * * *", "0 0 32 * *",
  "0 0 0 * *", "0 0 * 13 *", "0 0 * * 8", "*/0 * * * *", "0 0 * * 7-0", "5-1 * * * *",
  "0 0 * * mon-", "0 0 * * -mon", "0 0 * * 1//2", "a * * * *", "0 0 * * xyz",
  "0 0 1-32 * *", "60 * * * *", "0 24 * * *", "0 0 * 0 *", "0 0 1 * 0-8",
  // names in every shape a field allows them, and the case they arrive in
  "0 0 * * SUN", "0 0 * * Mon", "0 0 * JAN *", "0 0 * feb-apr *", "0 0 * jan-dec/3 *",
  "0 0 * * mon-fri", "0 0 * * tue-thu", "0 0 * * wed", "0 0 * dec *",
  // leading zeros and spacing, which a hand-typed crontab really contains
  "00 07 * * *", "0 0 01 01 *", "  0 7 * * *  ", "0\t7\t*\t*\t*",
  // steps whose start is not the bottom of the field, and lists of ranges
  "7/13 * * * *", "0 3/5 * * *", "0 0 5/7 * *", "0 0 * 2/4 *", "0 0 * * 2/2",
  "0 0 1-5,20-25 * *", "0 0 * * 1-2,5-6", "1,2,3,58,59 * * * *",
  // both day fields non-star, so they are ORed, from both sides of the OR
  "0 0 31 * 1", "0 0 1 * 6", "0 0 29 2 1",
  // more refusals: a step with no number, a range with a step of zero, junk
  "*/ * * * *", "0 0 * * 1-3/0", "0 0 * * */0", "0 0 -1 * *", "0 0 * * 1,",
  ",0 0 * * *", "0 0 * * 1-2-3", "0 0 * * *,", "0 0 ** * *",
];

/* Starts spread across the year so a monthly or yearly line is asked from both
 * sides of itself, plus a leap year and the end of a month. */
const STARTS = [
  Date.UTC(2026, 0, 1, 0, 0), Date.UTC(2026, 0, 31, 23, 59), Date.UTC(2026, 1, 28, 12, 0),
  Date.UTC(2026, 7, 4, 12, 0), Date.UTC(2026, 7, 4, 6, 59), Date.UTC(2026, 10, 30, 18, 30),
  Date.UTC(2026, 11, 31, 23, 58), Date.UTC(2028, 1, 28, 23, 59), Date.UTC(2028, 1, 29, 0, 1),
  Date.UTC(2027, 2, 31, 21, 15), Date.UTC(2026, 5, 15, 0, 0),
];

test("the oracle's day/hour skipping answers exactly what asking every minute does", () => {
  /* The oracle is only worth anything if it is a SECOND opinion, so the one
   * optimisation in it is itself checked against the walk it replaced, over a
   * 90 day stretch that is cheap enough to sweep minute by minute. */
  const WITHIN_MINUTES = 90 * 24 * 60;
  const disagreements: string[] = [];
  for (const expr of EXPRESSIONS) {
    if (!oracleParse(expr)) continue;
    for (const start of STARTS) {
      const skipping = oracleNext(expr, start, 90).at;
      const naive = oracleNextNaive(expr, start, WITHIN_MINUTES);
      const bounded = skipping !== null && skipping <= start + WITHIN_MINUTES * 60_000 ? skipping : null;
      if (bounded !== naive) {
        disagreements.push(`${JSON.stringify(expr)} from ${new Date(start).toISOString()}: ` +
          `skipping ${bounded}, minute-by-minute ${naive}`);
      }
    }
  }
  expect(disagreements).toEqual([]);
});

test("every expression is accepted by both, or refused by both", () => {
  const disagreements: string[] = [];
  for (const expr of EXPRESSIONS) {
    const mine = parseCron(expr) !== null;
    const theirs = oracleParse(expr) !== null;
    if (mine !== theirs) {
      disagreements.push(`${JSON.stringify(expr)}: schedules.ts ${mine ? "accepts" : "refuses"}, ` +
        `the oracle ${theirs ? "accepts" : "refuses"}`);
    }
  }
  expect(disagreements).toEqual([]);
});

test("every accepted expression fires at the same minute, from every start", () => {
  const disagreements: string[] = [];
  let compared = 0;
  for (const expr of EXPRESSIONS) {
    if (!oracleParse(expr)) continue;
    for (const start of STARTS) {
      /* Three in a row, not one: an off-by-one that only shows on the SECOND
       * occurrence (a step that restarts from the wrong place, a day rule that
       * is right today) hides behind a single sample. */
      let mineAt = start, oracleAt = start;
      for (let i = 0; i < 3; i++) {
        const mine = nextCronAt(expr, mineAt, "UTC");
        const theirs = oracleNext(expr, oracleAt);
        compared++;
        const where = `${JSON.stringify(expr)} from ${new Date(start).toISOString()} (#${i + 1})`;
        const say = (v: number | null) => (v === null ? "never" : new Date(v).toISOString());
        if (theirs.at === null) {
          /* The oracle swept to `scanned` and found nothing there, so the only
           * claim it can check is a negative one: schedules.ts may say "never",
           * or may name a time BEYOND the sweep, but it may not put an
           * occurrence inside a stretch that was looked at minute by minute. */
          if (mine !== null && mine <= theirs.scanned) {
            disagreements.push(`${where}: schedules.ts ${say(mine)}, oracle found nothing ` +
              `up to ${new Date(theirs.scanned).toISOString()}`);
          }
          break;
        }
        if (mine !== theirs.at) {
          disagreements.push(`${where}: schedules.ts ${say(mine)}, oracle ${say(theirs.at)}`);
          break;
        }
        mineAt = mine!;
        oracleAt = theirs.at;
      }
    }
  }
  expect(disagreements).toEqual([]);
  expect(compared).toBeGreaterThan(2000); // a run that compared nothing proves nothing
}, 20_000);

test("the corpus really holds both kinds, so neither half can quietly empty", () => {
  /* A typo that made every line unparseable would leave the differential test
   * above comparing nothing and still passing the `compared` floor by looping
   * over the starts. This is the other guard: the corpus has a healthy mix. */
  const accepted = EXPRESSIONS.filter((e) => oracleParse(e) !== null);
  const refused = EXPRESSIONS.filter((e) => oracleParse(e) === null);
  expect(accepted.length).toBeGreaterThan(80);
  expect(refused.length).toBeGreaterThan(25);
  // and schedules.ts agrees on the split, which is the first test restated as
  // counts so a wholesale acceptance regression is loud
  expect(EXPRESSIONS.filter((e) => parseCron(e) !== null).length).toBe(accepted.length);
});

/* The two lines the differential run found, kept by name so a regression says
 * what it broke rather than "a disagreement at index 41". */
test("0-7 in day-of-week is EVERY day, not Sundays", () => {
  const from = Date.UTC(2026, 7, 4, 12, 0); // a Tuesday
  // seven days running, one at a time
  let at = from;
  const days: number[] = [];
  for (let i = 0; i < 7; i++) {
    at = nextCronAt("0 0 * * 0-7", at, "UTC")!;
    days.push(new Date(at).getUTCDay());
  }
  expect(days.sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
});

test("an ordinary range that ends on a 7 is not refused", () => {
  for (const expr of ["0 0 * * 1-7", "0 0 * * 5-7", "0 0 * * 6-7", "0 0 * * 3-7",
    "0 0 * * 0-7", "0 0 * * 7-7", "0 0 * * 1-7/2"]) {
    expect(parseCron(expr), `${expr} should be a cron expression`).not.toBeNull();
  }
});

/* A NAMED range that runs backwards is refused. THE TWO CRONS DISAGREE ABOUT
 * THIS, and we are picking a side rather than implementing the standard.
 *
 * Classic Vixie rejects it: entry.c's get_range does `if (ch == EOF || num1 >
 * num2) return (EOF)`, names go through the same get_number as numbers, and
 * LAST_DOW is 7 precisely so that Friday-to-Sunday is written `5-7`.
 *
 * cronie -- the maintained fork, and what Fedora, RHEL and openSUSE actually
 * run -- wraps instead: `if (low_ > high_ && high_ == 0) high_ = 7;`. There
 * `fri-sun` is Friday, Saturday, Sunday and `mon-sun` is every day, and its
 * crontab(5) says ranges of names are allowed where Vixie's said they are not.
 * croniter agrees with cronie.
 *
 * So this is a live disagreement, not a settled rule, and refusing is a choice.
 * It is the choice made here because the failure is visible: the endpoint
 * answers 400, the field says so under the box, and he writes `5-7`. Guessing
 * which of the two he meant would give him a schedule that runs on days he did
 * not ask for and never says a word about it, and that is the failure this
 * whole lane keeps being sent back for. If it ever needs to change, cronie's
 * one-line wrap is the shape to copy. */
test("a named day range that runs backwards is refused (a choice, see above)", () => {
  for (const expr of ["0 0 * * fri-sun", "0 0 * * mon-sun", "0 0 * * sat-mon"]) {
    expect(parseCron(expr), `${expr} is not a range`).toBeNull();
    expect(oracleParse(expr), `${expr} is not a range`).toBeNull();
  }
});

test("a stepped star in day-of-month is still a star, so the day fields are ANDed", () => {
  // odd days that are also Fridays, not "odd days or Fridays"
  let at = Date.UTC(2026, 7, 1, 0, 0);
  for (let i = 0; i < 6; i++) {
    at = nextCronAt("0 0 */2 * 5", at, "UTC")!;
    const d = new Date(at);
    expect(d.getUTCDay()).toBe(5);
    expect(d.getUTCDate() % 2).toBe(1);
  }
});
