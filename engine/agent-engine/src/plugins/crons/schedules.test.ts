/* Scheduled and recurring messages: the cron arithmetic and the store.
 *
 * Two halves, both driven from here without an engine. The arithmetic is pure,
 * so a five-year-out yearly cron and a daylight saving boundary cost
 * microseconds. The store is pure too once you give it the two things it takes
 * from outside: WHERE its files are (`files`) and WHAT TIME IT IS (`now`, and
 * now the whole clock). Neither is an engine. A "restart" here is a second
 * Schedules object over the same file with no memory of the first, which is
 * precisely what a new process is, and it can be done in a millisecond instead
 * of in a boot.
 *
 * The rule every one of these is really about: an occurrence fires ONCE. Not
 * twice on a restart, not twice on a retry, not once per missed morning after
 * an overnight outage.
 *
 * WHAT IS NOT HERE. Exclusion between real OS PROCESSES -- twenty of them
 * contending for one lock file, and a delivery that outlives the lock -- is
 * lock.test.ts, which spawns them for real because that is the only way to make
 * that claim. What is here is the LOSER'S behaviour once it has lost, and the
 * rules that decide who has lost, both of which are decisions this file makes
 * out of what it reads on disk.
 *
 *   bun test agent-engine/src/plugins/crons/schedules.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { realpath, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { manualClock } from "../../runtime/clock.ts";
import { tmpDir } from "../../test-utils/tmp.ts";
import { until } from "../../test-utils/wait.ts";
import { singleFileLayout,
  Schedules, nextCronAt, parseCron, wallAt, instantOf, GRACE_MS, TICK_MS, RETRY_MAX_MS,
  type Schedule, type Deliver,
} from "./schedules.ts";

/* ------------------------------------------------------------------- cron */

const IST = "Asia/Kolkata";
const UTC = "UTC";
const MALTA = "Europe/Malta";

/* WHOSE SCHEDULES THESE ARE. A record keys on the stable agent id, which never
 * moves when a session re-keys from a pane id to a uuid; the pure layout here
 * has no agent directories, so any non-empty string is a conversation. */
const AGENT = "ag-w1p1";
const OTHER = "ag-w2p1";

/** A wall time in a zone, as an instant, so a test can say what it means. */
const at = (tz: string, y: number, mo: number, d: number, h: number, mi = 0) =>
  instantOf({ y, mo, d, h, mi }, tz);

const shows = (ms: number, tz: string) => {
  const w = wallAt(ms, tz);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.y}-${p(w.mo)}-${p(w.d)} ${p(w.h)}:${p(w.mi)}`;
};

/* THE ON-DISK SHAPE (the design): one flat `schedules` map by schedule id per
 * file, and WHERE the file lives is what says whose it is (the agent's
 * plugins/crons/ dir on a real engine, one scratch file in the pure tests).
 * `asFile` wraps a flat id->record map into that file shape for a test that
 * hand-writes one; `schedulesOnDisk` lifts the schedules back out of a parsed
 * file. */
const asFile = (flat: Record<string, any>): { v: 1; schedules: Record<string, any> } =>
  ({ v: 1, schedules: flat });
const schedulesOnDisk = (parsed: any): Record<string, any> =>
  (parsed?.schedules ?? {}) as Record<string, any>;

test("a cron expression is only accepted when it can actually fire", () => {
  expect(parseCron("0 7 * * *")).not.toBeNull();
  expect(parseCron("*/15 * * * 1-5")).not.toBeNull();
  expect(parseCron("40 15 * * mon-fri")).not.toBeNull();
  expect(parseCron("@daily")).not.toBeNull();
  // the shapes that must not be stored as if they would work
  expect(parseCron("0 7 * *")).toBeNull();        // four fields
  expect(parseCron("0 25 * * *")).toBeNull();     // no 25th hour
  expect(parseCron("0 7 * * 9")).toBeNull();      // no ninth weekday
  expect(parseCron("*/0 * * * *")).toBeNull();    // a step of nothing
  expect(parseCron("")).toBeNull();
  expect(parseCron("every morning")).toBeNull();
});

test("day-of-week 7 is Sunday, and a range that ends on it is not a collapsed one", () => {
  /* The fold onto 0 happens to each EXPANDED value, after the range has been
   * walked. Folding the endpoints first broke every ordinary line ending on a
   * 7: `0-7` collapsed to `0-0` and ran a job the user believed was daily on
   * Sundays only, accepted silently, with the preview agreeing with the wrong
   * answer; `1-7` and `5-7` came out lo > hi and were refused outright. */
  expect(parseCron("0 7 * * 0-7")!.dow.set.size).toBe(7);
  expect(parseCron("0 7 * * 1-7")!.dow.set).toEqual(new Set([1, 2, 3, 4, 5, 6, 0]));
  expect(parseCron("0 7 * * 5-7")!.dow.set).toEqual(new Set([5, 6, 0]));
  expect(parseCron("0 7 * * 7")!.dow.set).toEqual(new Set([0]));
  /* THE NAMED FORM IS NOT THE SAME SENTENCE. `sun` is 0 whichever end of a
   * range it is at, so `mon-sun` reads as 1 to 0 and is refused: the numeric
   * spelling of the same week is `1-7`. That is Vixie's behaviour too, and it
   * is asserted here so nobody "fixes" the wrap by folding the endpoints
   * again, which is the change that broke `0-7`. */
  expect(parseCron("0 7 * * mon-sun")).toBeNull();
  expect(parseCron("0 7 * * mon-fri")!.dow.set).toEqual(new Set([1, 2, 3, 4, 5]));
});

test("the next occurrence is computed in the schedule's zone, not the host's", () => {
  // 7am India, asked from a quarter past midnight UTC on the same day
  const from = at(UTC, 2026, 8, 4, 0, 15);
  const next = nextCronAt("0 7 * * *", from, IST);
  expect(next).not.toBeNull();
  expect(shows(next!, IST)).toBe("2026-08-04 07:00");
  // and the same expression in UTC is a different instant entirely
  expect(shows(nextCronAt("0 7 * * *", from, UTC)!, UTC)).toBe("2026-08-04 07:00");
  expect(nextCronAt("0 7 * * *", from, IST)).not.toBe(nextCronAt("0 7 * * *", from, UTC));
});

test("weekday, monthly and yearly crons land on the right day", () => {
  const from = at(UTC, 2026, 8, 4, 12, 0); // a Tuesday
  // workdays 6pm: today
  expect(shows(nextCronAt("0 18 * * 1-5", from, UTC)!, UTC)).toBe("2026-08-04 18:00");
  // Sundays 11am: the 9th
  expect(shows(nextCronAt("0 11 * * 0", from, UTC)!, UTC)).toBe("2026-08-09 11:00");
  // the 5th of the month: tomorrow
  expect(shows(nextCronAt("0 6 5 * *", from, UTC)!, UTC)).toBe("2026-08-05 06:00");
  // 15 January, which is five months of jumping away and must not walk minutes
  expect(shows(nextCronAt("0 6 15 1 *", from, UTC)!, UTC)).toBe("2027-01-15 06:00");
});

test("a day-of-month AND a day-of-week means either, the way crontab means it", () => {
  const from = at(UTC, 2026, 8, 4, 12, 0);
  // the 1st, and every Monday: the next hit is Monday the 10th, not 1 September
  expect(shows(nextCronAt("0 0 1 * 1", from, UTC)!, UTC)).toBe("2026-08-10 00:00");
  // ...and with either field a star it is AND, which is the ordinary reading
  expect(shows(nextCronAt("0 0 13 * *", from, UTC)!, UTC)).toBe("2026-08-13 00:00");
  expect(shows(nextCronAt("0 0 * * 5", from, UTC)!, UTC)).toBe("2026-08-07 00:00");
});

test("a cron that never comes round says so instead of hanging", () => {
  expect(nextCronAt("0 0 30 2 *", Date.now(), UTC)).toBeNull(); // 30 February
});

/* ------------------------------------------------------- daylight saving
 *
 * Hand-computed instants, not a brute-force scan: a scan over instants cannot
 * see a wall clock that does not exist (the gap) and cannot tell the two passes
 * of a repeated hour apart, which are precisely the two behaviours being
 * checked. The expression-level rules are covered differentially against an
 * independent oracle instead: cron-oracle.test.ts.
 */

test("the hour that happens twice fires ONCE", () => {
  /* New York falls back at 02:00 on 2026-11-01, so 01:00 and 01:30 each happen
   * twice, an hour apart. The minute-walking version of nextCronAt found the
   * same wall clock again at the new offset and delivered the job both times.
   * Two identical morning plans an hour apart is the user-visible shape of the
   * one rule this file exists to keep. */
  const NY = "America/New_York";
  for (const expr of ["0 1 * * *", "30 1 * * *"]) {
    const before = at(NY, 2026, 10, 31, 12, 0);
    const a = nextCronAt(expr, before, NY)!;
    const b = nextCronAt(expr, a, NY)!;
    expect(shows(a, NY).startsWith("2026-11-01")).toBe(true);
    // the NEXT one is the following day, not the same wall clock an hour later
    expect(shows(b, NY).startsWith("2026-11-02")).toBe(true);
    expect(b - a).toBe(25 * 3_600_000); // the day that was 25 hours long
  }
});

test("the same, in the two zones that shift by something other than an hour", () => {
  // Lord Howe moves by 30 minutes; Santiago falls back at midnight
  const LHI = "Australia/Lord_Howe";
  const a = nextCronAt("30 1 * * *", at(LHI, 2026, 4, 4, 12, 0), LHI)!;
  const b = nextCronAt("30 1 * * *", a, LHI)!;
  expect(shows(a, LHI)).toBe("2026-04-05 01:30");
  expect(shows(b, LHI)).toBe("2026-04-06 01:30");
  const SCL = "America/Santiago";
  const c = nextCronAt("0 0 * * *", at(SCL, 2026, 4, 3, 12, 0), SCL)!;
  const d = nextCronAt("0 0 * * *", c, SCL)!;
  expect(shows(c, SCL)).toBe("2026-04-04 00:00");
  expect(shows(d, SCL)).toBe("2026-04-05 00:00");
});

test("the hour that never happens still fires, just past the gap", () => {
  /* THE SILENT ONE. A wall clock inside a spring-forward gap does not exist, so
   * the old scan never saw those minutes: the occurrence never became `nextAt`,
   * the grace and skip machinery never heard of it, and there was no fire, no
   * skipped record and nothing in the chat. Santiago springs forward AT
   * MIDNIGHT, which makes an ordinary `0 0 * * *` the case. */
  const SCL = "America/Santiago";
  const ms = nextCronAt("0 0 * * *", at(SCL, 2026, 9, 5, 12, 0), SCL)!;
  const w = wallAt(ms, SCL);
  expect(`${w.y}-${w.mo}-${w.d}`).toBe("2026-9-6"); // the right DAY, always
  expect(w.h).toBe(1);                              // ...at the first real minute after it
  // and it is one occurrence, not none and not two
  const next = nextCronAt("0 0 * * *", ms, SCL)!;
  expect(shows(next, SCL)).toBe("2026-09-07 00:00");

  // Malta's gap is 02:00-03:00 on the last Sunday of March
  const ms2 = nextCronAt("0 2 * * *", at(MALTA, 2027, 3, 27, 12, 0), MALTA)!;
  const w2 = wallAt(ms2, MALTA);
  expect(`${w2.y}-${w2.mo}-${w2.d}`).toBe("2027-3-28");
  expect(w2.h).toBe(3);
});

test("a daily cron keeps its wall-clock hour across a DST change", () => {
  /* Malta springs forward on the last Sunday of March. A 07:00 job must be
   * 07:00 local on both sides of it, which is what storing the ZONE rather than
   * an offset buys, and the two instants are 23 hours apart, not 24. */
  const before = at(MALTA, 2027, 3, 26, 12, 0);
  const sat = nextCronAt("0 7 * * *", before, MALTA)!;   // still on winter time
  const sun = nextCronAt("0 7 * * *", sat, MALTA)!;      // the clocks moved at 02:00
  const mon = nextCronAt("0 7 * * *", sun, MALTA)!;
  expect(shows(sat, MALTA)).toBe("2027-03-27 07:00");
  expect(shows(sun, MALTA)).toBe("2027-03-28 07:00");
  expect(shows(mon, MALTA)).toBe("2027-03-29 07:00");
  expect(sun - sat).toBe(23 * 3_600_000); // the hour the clocks ate
  expect(mon - sun).toBe(24 * 3_600_000);
});

/* ------------------------------------------------------------------- store
 *
 * A clock the test moves by hand, so an overnight outage is a variable
 * assignment rather than a night. It is the suite's `manualClock`, which means
 * the STORE'S TICKER runs on it too: "fifteen seconds went by" is now something
 * a test can say, where before the interval could only be bypassed by calling
 * tick() directly.
 */

/* Every Schedules instance a test makes, stopped after it: an instance dropped
 * with its lock FileHandle open is closed by GC, which bun 1.4 turned into an
 * unhandled error that poisons NEIGHBOURING tests. */
let stores: Schedules[] = [];
afterEach(async () => {
  for (const st of stores.splice(0)) st.stop();
  /* releaseLock's close-then-unlink is fire-and-forget, and tmpDir removes the
   * directory out from under it at the end of the file. Wait for it rather than
   * sleeping: a handle still open when the tree goes is the GC error above. */
  await until(() => true);
});

type Delivered = { name: string; body: string; note: string; at: number };

async function store(opts: {
  now?: number;
  fail?: (n: number) => { why: string; retriable?: boolean } | null;
} = {}) {
  const dir = await tmpDir("cyc-sched-");
  const file = join(dir, "schedules.json");
  const sent: Delivered[] = [];
  const clock = manualClock(opts.now || Date.UTC(2026, 7, 4, 12, 0));
  let calls = 0;
  const deliver: Deliver = async (sc, fire) => {
    calls++;
    const bad = opts.fail?.(calls);
    if (bad) return { ok: false, why: bad.why, retriable: bad.retriable };
    sent.push({ name: sc.name, body: sc.body, note: String(fire.missed), at: clock.now() });
    return { ok: true };
  };
  /* Counted, because two of the defects here are about VOLUME rather than
   * correctness: a broadcast carries every schedule on the engine with its full
   * body to every device, and a write rewrites the whole file. */
  let changes = 0;
  const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const make = () => {
    const st = new Schedules({
      files: singleFileLayout(file), deliver, clock,
      onChange: () => { changes++; },
      log: (event, fields) => { logged.push({ event, fields }); },
    });
    stores.push(st);
    return st;
  };
  const s = make();
  await s.load();
  return {
    s, sent, file, dir, logged, clock,
    calls: () => calls,
    changes: () => changes,
    now: () => clock.now(),
    /** Move the clock to an instant, the way an outage or a night does. */
    set: (ms: number) => { clock.setNow(ms); },
    /** what a restart is: the same file, a brand new object with no memory */
    async restart() {
      const next = make();
      await next.load();
      return next;
    },
  };
}

test("a one-off fires once at its time and never again", async () => {
  const t = await store();
  const fireAt = t.now() + 60 * 60_000;
  const sc = await t.s.create({ agent: AGENT, name: "call mum", body: "remind me to call mum",
    kind: "once", at: fireAt, tz: UTC });
  expect(sc.nextAt).toBe(fireAt);

  await t.s.tick();
  expect(t.sent.length).toBe(0); // not yet

  t.set(fireAt + 1_000);
  await t.s.tick();
  expect(t.sent.length).toBe(1);
  expect(t.sent[0].body).toBe("remind me to call mum");

  // and every tick after it, for a day, changes nothing
  for (let i = 1; i <= 24; i++) {
    t.set(fireAt + i * 3_600_000);
    await t.s.tick();
  }
  expect(t.sent.length).toBe(1);
  expect(t.s.get(sc.id)!.done).toBe(true);
  expect(t.s.get(sc.id)!.nextAt).toBeNull();
});

test("a one-off in the past is refused rather than fired on save", async () => {
  const t = await store();
  await expect(t.s.create({ agent: AGENT, name: "yesterday", body: "too late",
    kind: "once", at: t.now() - 1000, tz: UTC })).rejects.toThrow("already passed");
  expect(t.s.list(AGENT).length).toBe(0);
});

test("a repeating schedule fires on schedule, once per occurrence", async () => {
  const t = await store({ now: at(UTC, 2026, 8, 4, 6, 0) });
  await t.s.create({ agent: AGENT, name: "morning-plan", body: "do the morning plan",
    kind: "repeat", cron: "0 7 * * *", tz: UTC });

  // walk four days a minute at a time around each 7am, ticking constantly
  for (let day = 4; day <= 7; day++) {
    for (const [h, mi] of [[6, 58], [6, 59], [7, 0], [7, 1], [7, 30], [12, 0], [23, 59]] as const) {
      t.set(at(UTC, 2026, 8, day, h, mi));
      await t.s.tick();
    }
  }
  expect(t.sent.length).toBe(4);
});

test("the store's own ticker is what fires it, not a test calling tick()", async () => {
  /* THE INTERVAL ITSELF, which nothing used to reach. `start()` arms a fifteen
   * second timer and every test here drove `tick()` by hand instead, so an
   * interval that was never armed -- or armed and immediately cleared -- would
   * have looked exactly like this file passing. On the manual clock the timer
   * is real code on a fake instrument: the schedule is due, nobody calls
   * anything, and time moves. */
  const t = await store({ now: at(UTC, 2026, 8, 4, 6, 59) });
  await t.s.create({ agent: AGENT, name: "morning-plan", body: "plan the day",
    kind: "repeat", cron: "0 7 * * *", tz: UTC });
  t.s.start();
  expect(t.sent.length).toBe(0);
  await until(async () => {
    await t.clock.advance(TICK_MS);
    return t.sent.length > 0;
  }, { what: "the ticker to fire the schedule on its own" });
  expect(t.sent[0].body).toBe("plan the day");
  // and stopping it really does stop it: two more hours buy nothing
  t.s.stop();
  const before = t.sent.length;
  await t.clock.advance(2 * 3_600_000);
  expect(t.sent.length).toBe(before);
});

test("both kinds survive an engine restart: the file is the schedule", async () => {
  const t = await store({ now: at(UTC, 2026, 8, 4, 6, 0) });
  const once = await t.s.create({ agent: AGENT, name: "one-off", body: "at nine",
    kind: "once", at: at(UTC, 2026, 8, 4, 9, 0), tz: UTC });
  await t.s.create({ agent: AGENT, name: "daily", body: "at seven",
    kind: "repeat", cron: "0 7 * * *", tz: UTC });

  const after = await t.restart();
  expect(after.list(AGENT).map((x) => x.name).sort()).toEqual(["daily", "one-off"]);
  expect(after.get(once.id)!.nextAt).toBe(at(UTC, 2026, 8, 4, 9, 0));

  // and the restarted store is the one that fires them
  t.set(at(UTC, 2026, 8, 4, 7, 0));
  await after.tick();
  t.set(at(UTC, 2026, 8, 4, 9, 0));
  await after.tick();
  expect(t.sent.map((x) => x.body).sort()).toEqual(["at nine", "at seven"]);
});

test("an engine down over a fire time delivers it late, once, inside the grace", async () => {
  const t = await store({ now: at(UTC, 2026, 8, 4, 6, 0) });
  const sc = await t.s.create({ agent: AGENT, name: "morning-plan", body: "plan the day",
    kind: "repeat", cron: "0 7 * * *", tz: UTC });

  // the engine is away from 6:30 to 8:00, i.e. over the 7am fire
  const back = await t.restart();
  t.set(at(UTC, 2026, 8, 4, 8, 0));
  await back.tick();
  expect(t.sent.length).toBe(1);
  const last = back.get(sc.id)!.last!;
  expect(last.outcome).toBe("delivered");
  expect(last.lateMs).toBe(60 * 60_000);
  // and tomorrow is where the cursor points, not today
  expect(back.get(sc.id)!.nextAt).toBe(at(UTC, 2026, 8, 5, 7, 0));
});

test("a whole week of missed mornings is ONE message that says how many it stands for", async () => {
  const t = await store({ now: at(UTC, 2026, 8, 4, 6, 0) });
  const sc = await t.s.create({ agent: AGENT, name: "morning-plan", body: "plan the day",
    kind: "repeat", cron: "0 7 * * *", tz: UTC });

  // gone for a week, back an hour after the last one was due. Eight mornings
  // came round while it was away: the 4th through the 11th.
  t.set(at(UTC, 2026, 8, 11, 8, 0));
  await t.s.tick();
  expect(t.sent.length).toBe(1);
  expect(t.sent[0].note).toBe("7"); // the seven older mornings, counted not sent
  expect(t.s.get(sc.id)!.last!.due).toBe(at(UTC, 2026, 8, 11, 7, 0));
});

test("past the old grace it still DELIVERS, late, with the lateness on the wire (his ladder)", async () => {
  /* The two-hour skip is gone (2026-08-09): a late run always delivers
   * something, and how it is annotated is the deliver side's business (the
   * fire info carries lateMs; the crons plugin sends a status line past a
   * day). */
  const t = await store({ now: at(UTC, 2026, 8, 4, 6, 0) });
  const sc = await t.s.create({ agent: AGENT, name: "morning-plan", body: "plan the day",
    kind: "repeat", cron: "0 7 * * *", tz: UTC });

  // back at 4pm: nine hours late, and it fires anyway with the lateness visible
  t.set(at(UTC, 2026, 8, 4, 16, 0));
  await t.s.tick();
  expect(t.sent.length).toBe(1);
  expect(t.sent[0].body).toBe("plan the day");
  // tomorrow still happens on time
  expect(t.s.get(sc.id)!.nextAt).toBe(at(UTC, 2026, 8, 5, 7, 0));
  t.set(at(UTC, 2026, 8, 5, 7, 0));
  await t.s.tick();
  expect(t.sent.length).toBe(2);
});

test("a delivery that typed nothing is retried until the session is back", async () => {
  // the first two attempts find no pane; the third lands
  const t = await store({
    now: at(UTC, 2026, 8, 4, 6, 0),
    fail: (n) => (n <= 2 ? { why: "the session is offline", retriable: true } : null),
  });
  const sc = await t.s.create({ agent: AGENT, name: "nudge", body: "stop working",
    kind: "once", at: at(UTC, 2026, 8, 4, 7, 0), tz: UTC });

  t.set(at(UTC, 2026, 8, 4, 7, 0));
  await t.s.tick();
  expect(t.sent.length).toBe(0);
  expect(t.s.get(sc.id)!.last!.outcome).toBe("undelivered");
  expect(t.s.get(sc.id)!.last!.retryUntil).toBe(at(UTC, 2026, 8, 4, 7, 0) + GRACE_MS);

  t.set(at(UTC, 2026, 8, 4, 7, 30));
  await t.s.tick();
  expect(t.sent.length).toBe(0);

  t.set(at(UTC, 2026, 8, 4, 8, 0));
  await t.s.tick();
  expect(t.sent.length).toBe(1);
  expect(t.s.get(sc.id)!.last!.outcome).toBe("delivered");
  expect(t.s.get(sc.id)!.last!.tries).toBe(3);

  // ...and having landed, it does not land again
  t.set(at(UTC, 2026, 8, 4, 9, 0));
  await t.s.tick();
  expect(t.sent.length).toBe(1);
});

test("a retry in flight survives a restart, and is still the same occurrence", async () => {
  /* THE CASE IT EXISTS FOR: the engine going down is WHY the pane was not
   * there. A restart re-reads a record whose retryAt is already in the past and
   * tries at once, which is if anything more prompt -- and it must still be the
   * SAME occurrence, not a second fire. `fires` is the count that would give it
   * away. */
  let reachable = false;
  const t = await store({
    now: at(UTC, 2026, 8, 4, 6, 0),
    fail: () => (reachable ? null : { why: "the session is offline", retriable: true }),
  });
  const sc = await t.s.create({ agent: AGENT, name: "nudge", body: "stop working",
    kind: "once", at: at(UTC, 2026, 8, 4, 7, 0), tz: UTC });
  t.set(at(UTC, 2026, 8, 4, 7, 0));
  await t.s.tick();
  expect(t.s.get(sc.id)!.fires).toBe(1);

  reachable = true;
  const back = await t.restart();
  t.set(at(UTC, 2026, 8, 4, 7, 20));
  await back.tick();
  expect(t.sent.length).toBe(1);
  expect(back.get(sc.id)!.fires).toBe(1);          // one occurrence, several tries
  expect(back.get(sc.id)!.last!.outcome).toBe("delivered");
});

test("a retry gives up at the grace, and says so rather than going quiet", async () => {
  const t = await store({
    now: at(UTC, 2026, 8, 4, 6, 0),
    fail: () => ({ why: "the session is offline", retriable: true }),
  });
  const sc = await t.s.create({ agent: AGENT, name: "nudge", body: "stop working",
    kind: "once", at: at(UTC, 2026, 8, 4, 7, 0), tz: UTC });
  t.set(at(UTC, 2026, 8, 4, 7, 0));
  await t.s.tick();
  t.set(at(UTC, 2026, 8, 4, 10, 0)); // three hours on: past the window
  await t.s.tick();
  const last = t.s.get(sc.id)!.last!;
  expect(last.outcome).toBe("undelivered");
  expect(last.retryUntil).toBeUndefined();
  /* IT SAYS WHAT HAPPENED, NOT WHAT THE WINDOW WAS FOR. The sentence used to
   * read "it stayed that way for the 2 hours it was worth retrying for" no
   * matter what: with the unclamped backoff the last attempt was at 106 minutes,
   * so the claim of two hours was simply untrue -- the app asserting what it
   * does not know, in the one place whose whole job is saying what happened. */
  expect(last.why).toContain("attempts");
  expect(last.why).toMatch(/\d+ minutes after it was due/);
  expect(t.sent.length).toBe(0);
});

/* The seven-times-over walk of the whole retry window is retry-window.test.ts,
 * beside this file: it is the one test here that costs seconds rather than
 * milliseconds, and the budget says split rather than raise the cap. */

test("a failure that may have typed something is NEVER retried", async () => {
  // no `retriable`: herdr refused somewhere inside the text/enter pair
  const t = await store({
    now: at(UTC, 2026, 8, 4, 6, 0),
    fail: (n) => (n === 1 ? { why: "herdr would not take the keystrokes" } : null),
  });
  const sc = await t.s.create({ agent: AGENT, name: "nudge", body: "stop working",
    kind: "once", at: at(UTC, 2026, 8, 4, 7, 0), tz: UTC });
  t.set(at(UTC, 2026, 8, 4, 7, 0));
  await t.s.tick();
  for (let i = 1; i <= 4; i++) {
    t.set(at(UTC, 2026, 8, 4, 7 + i, 0));
    await t.s.tick();
  }
  expect(t.sent.length).toBe(0);
  expect(t.s.get(sc.id)!.last!.retryUntil).toBeUndefined();
  /* AND IT SURVIVES A RESTART AS A FINISHED THING. `coerce` only restores a
   * retryUntil for an "undelivered" record, so a half-delivered one cannot come
   * back from disk wearing a retry it was never given. */
  const back = await t.restart();
  t.set(at(UTC, 2026, 8, 4, 12, 0));
  await back.tick();
  expect(t.sent.length).toBe(0);
});

test("a claim killed mid-delivery is not re-sent on the next boot", async () => {
  /* THE CRASH CASE, and the reason the cursor is written before the keystrokes.
   * The file is left exactly as a process dying inside deliver would leave it:
   * the occurrence claimed, the cursor already advanced, the outcome unknown. */
  const t = await store({ now: at(UTC, 2026, 8, 4, 8, 0) });
  const raw: Record<string, Schedule> = {
    sch_crash: {
      id: "sch_crash", agent: AGENT, name: "morning-plan", body: "plan the day",
      kind: "repeat", cron: "0 7 * * *", tz: UTC, enabled: true,
      createdAt: at(UTC, 2026, 8, 1, 0, 0),
      nextAt: at(UTC, 2026, 8, 5, 7, 0), fires: 1,
      last: { due: at(UTC, 2026, 8, 4, 7, 0), at: at(UTC, 2026, 8, 4, 7, 0), outcome: "unknown" },
    },
  };
  await Bun.write(t.file, JSON.stringify(asFile(raw)));

  const back = await t.restart();
  for (let h = 8; h <= 23; h++) {
    t.set(at(UTC, 2026, 8, 4, h, 0));
    await back.tick();
  }
  expect(t.sent.length).toBe(0);            // this morning is gone, not repeated
  expect(back.get("sch_crash")!.last!.outcome).toBe("unknown"); // and it still says so

  t.set(at(UTC, 2026, 8, 5, 7, 0));
  await back.tick();
  expect(t.sent.length).toBe(1);            // tomorrow is normal
});

test("disabling stops it and re-enabling never fires the time it slept through", async () => {
  const t = await store({ now: at(UTC, 2026, 8, 4, 6, 0) });
  const sc = await t.s.create({ agent: AGENT, name: "daily", body: "at seven",
    kind: "repeat", cron: "0 7 * * *", tz: UTC });
  await t.s.update(sc.id, { enabled: false });
  expect(t.s.get(sc.id)!.nextAt).toBeNull();

  t.set(at(UTC, 2026, 8, 4, 9, 0));
  await t.s.tick();
  expect(t.sent.length).toBe(0);

  await t.s.update(sc.id, { enabled: true });
  expect(t.s.get(sc.id)!.nextAt).toBe(at(UTC, 2026, 8, 5, 7, 0)); // tomorrow, not this morning
  await t.s.tick();
  expect(t.sent.length).toBe(0);
});

test("a spent one-off can become a daily repeat, and back (his call)", async () => {
  const t = await store({ now: at(UTC, 2026, 8, 4, 6, 0) });
  const sc = await t.s.create({ agent: AGENT, name: "morning-report", body: "report",
    kind: "once", at: at(UTC, 2026, 8, 4, 7, 0), tz: UTC });
  t.set(at(UTC, 2026, 8, 4, 7, 0));
  await t.s.tick();
  expect(t.sent.length).toBe(1);
  expect(t.s.get(sc.id)!.nextAt).toBeNull(); // spent

  // the flip that used to be impossible: the record becomes a repeat and lives on
  await t.s.update(sc.id, { kind: "repeat", cron: "0 8 * * *" });
  expect(t.s.get(sc.id)!.kind).toBe("repeat");
  expect(t.s.get(sc.id)!.nextAt).toBe(at(UTC, 2026, 8, 4, 8, 0));
  t.set(at(UTC, 2026, 8, 4, 8, 0));
  await t.s.tick();
  expect(t.sent.length).toBe(2);

  // back to a one-off, with a fresh future time
  await t.s.update(sc.id, { kind: "once", at: at(UTC, 2026, 8, 4, 12, 0) });
  expect(t.s.get(sc.id)!.kind).toBe("once");
  expect(t.s.get(sc.id)!.cron).toBeUndefined();
  t.set(at(UTC, 2026, 8, 4, 12, 0));
  await t.s.tick();
  expect(t.sent.length).toBe(3);

  // a flip without the field the new kind lives by is refused, untouched
  await expect(t.s.update(sc.id, { kind: "repeat" })).rejects.toThrow("needs a cron");
  expect(t.s.get(sc.id)!.kind).toBe("once");
});

test("the wrong-conversation guard can be repaired, and only with a real directory", async () => {
  /* THE DIRECTORY IS EDITABLE, because projects get moved: the same
   * conversation in a new place would otherwise fail silently every day behind
   * a row that looks perfectly healthy, with no way out but deleting the
   * schedule. And it is CHECKED, because the repair is a curl typed by hand and
   * `"  "` stored happily with a 200 puts the schedule straight back into the
   * state the field exists to get it out of. Empty CLEARS the guard; whitespace
   * is a mistake, and those two used to be the same thing. */
  const t = await store();
  const real = await tmpDir("cyc-sched-proj-");
  const sc = await t.s.create({ agent: AGENT, name: "standup", body: "write it",
    kind: "repeat", cron: "0 7 * * *", tz: UTC, cwd: "/nowhere/at/all" });
  await expect(t.s.update(sc.id, { cwd: "  " }))
    .rejects.toThrow("cannot be blank or padded");
  await expect(t.s.update(sc.id, { cwd: "relative/path" }))
    .rejects.toThrow("absolute path");
  await expect(t.s.update(sc.id, { cwd: "/nowhere/at/all/either" }))
    .rejects.toThrow("there is no directory");
  expect(t.s.get(sc.id)!.cwd).toBe("/nowhere/at/all"); // nothing was moved
  // ...and a real directory is stored RESOLVED, because the guard is a string
  // comparison and a symlinked alias is not the spelling a session reports
  const alias = join(t.dir, "alias");
  await symlink(real, alias);
  await t.s.update(sc.id, { cwd: alias });
  expect(t.s.get(sc.id)!.cwd).toBe(await realpath(real));
  // only a genuinely empty string removes the guard
  await t.s.update(sc.id, { cwd: "" });
  expect(t.s.get(sc.id)!.cwd).toBeUndefined();
});

/* ------------------------------------------------------------ the file itself
 *
 * Per-RECORD corruption is handled by dropping that record. These are about the
 * FILE: the cases where there is nothing to read at all, or where somebody else
 * is writing it.
 */

test("a torn file stops the store dead rather than being written over", async () => {
  /* WHAT A KILL DURING A WRITE LEAVES. The old code caught the parse error,
   * printed it to stdout where the structured log could not see it, and then
   * the next save() put an empty map straight over the top: everything he had
   * ever scheduled, gone, with nothing anywhere to find afterwards. */
  const t = await store();
  const torn = '{"sch_abc": {"sessionId": "w1:p1", "name": "morning-pl';
  await Bun.write(t.file, torn);
  const after = await t.restart();

  expect(after.refuse()).toContain("not readable JSON");
  expect(after.list().length).toBe(0);
  // said where a person looking for it would look
  expect(t.logged.some((l) => l.event === "schedule.store-unreadable")).toBe(true);

  // nothing writes over it: not a create, not a tick, not a removal
  await expect(after.create({ agent: AGENT, name: "x", body: "y", kind: "repeat",
    cron: "0 7 * * *", tz: UTC })).rejects.toThrow("not readable JSON");
  await after.tick();
  expect(await Bun.file(t.file).text()).toBe(torn);
});

test("an empty file is torn too, and is not mistaken for having no schedules", async () => {
  const t = await store();
  await Bun.write(t.file, "");
  const after = await t.restart();
  expect(after.refuse()).not.toBeNull();
  expect(await Bun.file(t.file).text()).toBe("");
});

test("a file that parses but is not an object is torn too", async () => {
  /* PARSING IS NOT UNDERSTANDING. `[]` and `"hello"` are both perfectly good
   * JSON and neither is a store, and treating them as an empty one is the same
   * data loss by a shorter road. */
  for (const junk of ["[]", '"hello"', "42"]) {
    const t = await store();
    await Bun.write(t.file, junk);
    const after = await t.restart();
    expect(after.refuse(), `${junk} was accepted`).toContain("not readable JSON");
    expect(await Bun.file(t.file).text()).toBe(junk);
  }
});

test("a write lands whole or not at all: nothing is left half a store", async () => {
  const t = await store();
  await t.s.create({ agent: AGENT, name: "one", body: "a", kind: "repeat", cron: "0 7 * * *", tz: UTC });
  await t.s.create({ agent: AGENT, name: "two", body: "b", kind: "repeat", cron: "0 8 * * *", tz: UTC });
  /* The real name is only ever produced by a rename, which is the one step here
   * that is atomic. A reader therefore sees the old file or the new one. */
  const raw = await Bun.file(t.file).text();
  expect(() => JSON.parse(raw)).not.toThrow();
  expect(Object.keys(schedulesOnDisk(JSON.parse(raw))).length).toBe(2);
  /* EVERY neighbour a write goes through, not only the `.tmp` one. An earlier
   * version filtered on `.tmp` alone and so could not have seen the `.claim`
   * file a lock attempt leaves if it dies between writing it and linking it. */
  const strays = await Array.fromAsync(new Bun.Glob("schedules.json.*").scan({ cwd: t.dir }));
  expect(strays.filter((f) => /\.(tmp|claim|beat)$/.test(f))).toEqual([]);
});

test("a fresh store whose directory does not exist yet seeds two agents without losing a seed", async () => {
  /* THE REPORTED DEFECT. A fresh tree has no store directory; the atomic write
   * (tmp then rename) assumed the directory was there, so two sessions seeding
   * their defaults together lost the loser's seed to
   * `ENOENT ... rename '.../schedules.json.<pid>.tmp'`. The fix makes the
   * directory at each write point (the lock claim and each save) and serializes
   * writes within the process. */
  const base = await tmpDir("cyc-seedrace-");
  const file = join(base, "deep", "schedules.json"); // the directory does NOT exist yet
  const deliver: Deliver = async () => ({ ok: true });
  const s = new Schedules({ files: singleFileLayout(file), deliver,
    now: () => Date.UTC(2026, 7, 4, 12, 0) });
  stores.push(s);
  await s.load();
  expect(s.refuse()).toBeNull(); // it took the lock despite the missing directory

  // exactly what the plugin's seeding does, for two agents, fired together
  const seed = (id: string) => Promise.all([
    s.create({ agent: id, name: "nudge", body: "keep going",
      kind: "repeat", cron: "*/30 * * * *", enabled: false, tz: UTC }),
    s.create({ agent: id, name: "morning-report", body: "report",
      kind: "repeat", cron: "0 8 * * *", enabled: false, tz: UTC }),
    s.create({ agent: id, name: "due-today", body: "due",
      kind: "repeat", cron: "0 8 * * *", enabled: false, tz: UTC }),
  ]);
  await Promise.all([seed(AGENT), seed(OTHER)]);

  // the file is there, parses, and carries every seed for both agents
  const raw = await Bun.file(file).text();
  expect(() => JSON.parse(raw)).not.toThrow();
  for (const id of [AGENT, OTHER]) {
    expect(s.list(id).map((x) => x.name).sort()).toEqual(["due-today", "morning-report", "nudge"]);
  }
  expect(Object.keys(schedulesOnDisk(JSON.parse(raw))).length).toBe(6); // six on disk, none dropped
  // every record still names its agent
  const owners = new Set(Object.values(schedulesOnDisk(JSON.parse(raw))).map((x: any) => x.agent));
  expect([...owners].sort()).toEqual([AGENT, OTHER].sort());
});

test("concurrent writes to distinct schedules all land, none clobbered", async () => {
  /* The store's write path called concurrently. Every save writes the one
   * pid-named `<file>.<pid>.tmp`; fired together and unserialized, the second
   * rename lands on a tmp the first already moved (ENOENT), or a stale snapshot
   * wins last and drops a schedule. Serialized, the last write on disk reflects
   * every mutation made before it. */
  const t = await store();
  const mk = (n: number) => t.s.create({ agent: AGENT, name: `s${n}`, body: `b${n}`,
    kind: "repeat", cron: "0 8 * * *", tz: UTC });
  await Promise.all([mk(1), mk(2), mk(3), mk(4), mk(5)]);

  const onDisk = schedulesOnDisk(JSON.parse(await Bun.file(t.file).text())) as Record<string, { body: string }>;
  expect(Object.keys(onDisk).length).toBe(5);
  expect(t.s.list(AGENT).map((s) => s.name).sort()).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  // the last write reflects all five bodies, not one clobbering the rest
  expect(Object.values(onDisk).map((s) => s.body).sort()).toEqual(["b1", "b2", "b3", "b4", "b5"]);
  // and no tmp is left lying about from a losing racer
  const strays = await Array.fromAsync(new Bun.Glob("schedules.json.*").scan({ cwd: t.dir }));
  expect(strays.filter((f) => /\.(tmp|claim|beat)$/.test(f))).toEqual([]);
});

/* ---------------------------------------------------------------- the lock
 *
 * WHO HOLDS THE FILE, decided from what is on disk. Exclusion between real OS
 * processes is lock.test.ts; these are the rules that read a lock somebody else
 * wrote, and every one of them has been wrong at least once.
 *
 * The holder in these is a pid that is genuinely running and is genuinely not
 * this process: `process.ppid`, the runner that started this worker. A made-up
 * number would be a dead pid and would take the liveness branch instead of the
 * one being tested.
 */

const otherProcess = () => process.ppid;

test("an engine that does not hold the file neither fires nor writes", async () => {
  /* TWO PROCESSES, ONE FILE, ONE OCCURRENCE DELIVERED TWICE. The trigger is
   * ordinary: a restart where the old process outlives the new one's boot, and
   * the deliberately-late first tick sits right inside that window. */
  const t = await store({ now: at(UTC, 2026, 8, 4, 6, 0) });
  await t.s.create({ agent: AGENT, name: "daily", body: "at seven",
    kind: "repeat", cron: "0 7 * * *", tz: UTC });
  const before = await Bun.file(t.file).text();

  // somebody else takes the file
  await Bun.write(`${t.file}.lock`, JSON.stringify({ pid: otherProcess(), at: t.now() }));
  const loser = await t.restart();
  expect(loser.refuse()).toContain("another engine process");

  t.set(at(UTC, 2026, 8, 4, 7, 0));
  /* THE HOLDER IS STILL BEATING. This test's clock jumps an hour between
   * writing the lock and the tick, and a lock that has not been touched for an
   * hour is dead by the staleness rule -- correctly, since that is how a lock
   * left by a killed process is ever recovered. So the stamp moves with the
   * clock, which is what a live owner's heartbeat does. */
  await Bun.write(`${t.file}.lock`, JSON.stringify({ pid: otherProcess(), at: t.now() }));
  await loser.tick();
  expect(t.sent.length).toBe(0);                        // it did not fire
  expect(await Bun.file(t.file).text()).toBe(before);   // and it did not write
  await expect(loser.create({ agent: AGENT, name: "x", body: "y", kind: "repeat",
    cron: "0 9 * * *", tz: UTC })).rejects.toThrow("another engine process");
  // and it said which pid, rather than guessing
  const said = t.logged.find((l) => l.event === "schedule.not-mine");
  expect(said?.fields.pid).toBe(otherProcess());
  expect(said?.fields.lockState).toBe("held");
});

test("a lock nobody has touched since before the stale window is taken", async () => {
  /* HOW A LOCK LEFT BY A KILLED PROCESS IS EVER RECOVERED, and the price of it
   * is written out at the top of schedules.ts: a healthy engine CAN be
   * displaced this way. The stamp is what decides, not the pid -- pids recycle
   * across a reboot, so a lock naming a pid that now belongs to something
   * unrelated would mute schedules for ever with no way back. Here the pid is
   * emphatically alive and the lock is taken anyway, because it has not been
   * beaten. */
  const t = await store({ now: at(UTC, 2026, 8, 4, 6, 0) });
  await t.s.create({ agent: AGENT, name: "daily", body: "at seven",
    kind: "repeat", cron: "0 7 * * *", tz: UTC });
  await Bun.write(`${t.file}.lock`, JSON.stringify({ pid: otherProcess(), at: 0 }));
  const back = await t.restart();
  expect(back.refuse()).toBeNull();
  // ...and it says the holder was running, rather than claiming it was gone
  const said = t.logged.find((l) => l.event === "schedule.lock-stale");
  expect(said?.fields.holderRunning).toBe(true);
  expect(said?.fields.pid).toBe(otherProcess());

  t.set(at(UTC, 2026, 8, 4, 7, 0));
  await back.tick();
  expect(t.sent.length).toBe(1);
});

test("a lock that cannot be read names NOBODY, and goes stale on its own mtime", async () => {
  /* THE THIRD ANSWER, kept apart from the other two because conflating it with
   * "held" made a live owner drop a lock it was holding: an unreadable file
   * used to come back as `pid: -1`, every comparison read that as "somebody
   * else", and the owner went mute for a whole stale window telling the user
   * another engine had it. Minus one is not a process.
   *
   * A recent unreadable lock is honoured (it may belong to a running engine
   * mid-write) and says what it is; an old one is aged out by its mtime, which
   * is what recovers a zero-byte lock left by a SIGKILL. Without that the file
   * would block every engine on the machine for ever. */
  const recent = await store({ now: Date.now() });
  await Bun.write(`${recent.file}.lock`, "not json at all");
  const waiting = await recent.restart();
  expect(waiting.refuse()).toContain("another engine process");
  const said = recent.logged.find((l) => l.event === "schedule.not-mine");
  expect(said?.fields.lockState).toBe("unreadable");
  expect(said?.fields.pid).toBeNull();

  const old = await store({ now: Date.now() });
  await Bun.write(`${old.file}.lock`, "");
  const longAgo = new Date(Date.now() - 60 * 60_000);
  await utimes(`${old.file}.lock`, longAgo, longAgo);
  const back = await old.restart();
  expect(back.refuse()).toBeNull();
});

test("a store that lost the lock finds out on its next tick and stops", async () => {
  /* `owns` IS A BELIEF, and it used to be trusted for ever: a laptop lid
   * closes, the engine is stopped, its heartbeat goes stale, another engine
   * takes the lock, and on resume the first one carries on writing and firing
   * over the live owner's file. The end state was two processes permanently
   * convinced they owned one file, 172 ticks between them, neither ever
   * reporting that it did not, and nothing to heal it because nothing ever
   * asked again. Re-validated against the INODE every tick, that permanent
   * state becomes a transient one. */
  const t = await store({ now: at(UTC, 2026, 8, 4, 6, 0) });
  await t.s.create({ agent: AGENT, name: "daily", body: "at seven",
    kind: "repeat", cron: "0 7 * * *", tz: UTC });
  expect(t.s.refuse()).toBeNull();

  // somebody else replaces the lock: a new file, so a new inode
  await Bun.write(`${t.file}.lock.other`, JSON.stringify({ pid: otherProcess(), at: t.now() }));
  await Bun.write(`${t.file}.lock`, JSON.stringify({ pid: otherProcess(), at: t.now() }));
  const { unlink, link } = await import("node:fs/promises");
  await unlink(`${t.file}.lock`);
  await link(`${t.file}.lock.other`, `${t.file}.lock`);

  t.set(at(UTC, 2026, 8, 4, 7, 0));
  await Bun.write(`${t.file}.lock.other`, JSON.stringify({ pid: otherProcess(), at: t.now() }));
  await t.s.tick();
  expect(t.sent.length).toBe(0);                 // it did not fire the 7am
  expect(t.s.refuse()).toContain("another engine process");
  expect(t.logged.some((l) => l.event === "schedule.lock-lost")).toBe(true);
});

test("a retry probes often but broadcasts only when the answer changes", async () => {
  /* #377. The old design asked "is the pane back yet" only THIRTEEN times over
   * two hours -- with a fifteen minute gap in the middle of the backoff -- so a
   * pane that freed inside that gap waited up to fifteen minutes. It asked
   * rarely because each ask wrote the whole file and broadcast every schedule
   * body to every device: 480 of each was the thing to avoid.
   *
   * Now the ask is frequent and the SPEAKING is rare. A failing retry with
   * nothing new to say writes nothing and broadcasts nothing, so the engine can
   * probe often (catching a freed pane fast) while the device sees only the
   * transitions it cares about: the create, the first failure, and the give-up. */
  const t = await store({
    now: at(UTC, 2026, 8, 4, 6, 0),
    fail: () => ({ why: "the session is offline", retriable: true }),
  });
  await t.s.create({ agent: AGENT, name: "nudge", body: "stop working",
    kind: "once", at: at(UTC, 2026, 8, 4, 7, 0), tz: UTC });

  // every tick of a real engine across the whole two hour window
  const start = at(UTC, 2026, 8, 4, 7, 0);
  for (let ms = start; ms <= start + 2 * 3_600_000 + 60_000; ms += TICK_MS) {
    t.set(ms);
    await t.s.tick();
  }
  // frequent: once the backoff caps at RETRY_MAX_MS it is roughly one probe per
  // cap-length across the two hours, far more than the old thirteen.
  expect(t.calls()).toBeGreaterThan(2 * 3_600_000 / RETRY_MAX_MS - 5);
  // quiet: the four transitions worth a broadcast are the create, the claim,
  // the first failure and the give-up. Every silent probe in between is nothing.
  expect(t.changes()).toBe(4);
  expect(t.s.get(t.s.list()[0].id)?.last?.retryUntil).toBeUndefined(); // gave up, said so
});

test("#377 a once-schedule busy at its time fires within the bounded window once it frees", async () => {
  /* The morning "once" whose target pane was busy fired 37 minutes late while
   * repeat crons were on time. It must instead land within one cap of the pane
   * becoming reachable, not slide to the next coarse backoff slot. */
  let reachable = false;
  const t = await store({
    now: at(UTC, 2026, 8, 4, 6, 0),
    // busy (a chooser on screen, or an unreadable pane) is retriable: nothing typed
    fail: () => (reachable ? null : { why: "the pane is on a chooser", retriable: true }),
  });
  const due = at(UTC, 2026, 8, 4, 7, 0);
  const sc = await t.s.create({ agent: AGENT, name: "morning-report", body: "write the report",
    kind: "once", at: due, tz: UTC });

  // the pane stays busy for twenty minutes past the due time, then frees
  const freeAt = due + 20 * 60_000;
  let delivered = -1;
  for (let ms = due; ms <= due + GRACE_MS; ms += TICK_MS) {
    if (ms >= freeAt) reachable = true;
    t.set(ms);
    await t.s.tick();
    if (t.sent.length && delivered < 0) delivered = ms;
  }
  expect(t.sent.length).toBe(1);
  // it landed within one cap (+ a tick of slack) of the pane freeing, NOT at
  // the old +30.5 minute backoff slot thirty minutes after it was due.
  expect(delivered - freeAt).toBeLessThanOrEqual(RETRY_MAX_MS + TICK_MS);
  expect(t.s.get(sc.id)!.last!.outcome).toBe("delivered");
});

test("#377 the list exposes how overdue a busy fire is, and stops once it lands", async () => {
  let reachable = false;
  const t = await store({
    now: at(UTC, 2026, 8, 4, 6, 0),
    fail: () => (reachable ? null : { why: "the pane is busy", retriable: true }),
  });
  const due = at(UTC, 2026, 8, 4, 7, 0);
  const sc = await t.s.create({ agent: AGENT, name: "morning-report", body: "write the report",
    kind: "once", at: due, tz: UTC });

  // before it is due, nothing is overdue
  expect(t.s.list()[0].overdueMs).toBeUndefined();

  // due, pane busy: the first attempt fails and the row starts showing lateness
  t.set(due);
  await t.s.tick();
  expect(t.sent.length).toBe(0);
  expect(t.s.list()[0].overdueMs).toBe(0);

  // still busy ten minutes on: the same read now says ten minutes late
  t.set(due + 10 * 60_000);
  expect(t.s.list()[0].overdueMs).toBe(10 * 60_000);

  // the pane frees; it lands and the field disappears (absent = not overdue)
  reachable = true;
  await t.s.tick();
  expect(t.sent.length).toBe(1);
  expect(t.s.list()[0].overdueMs).toBeUndefined();
  expect(t.s.get(sc.id)!.last!.outcome).toBe("delivered");
});

test("#377 repeat crons whose pane is reachable are untouched: on time, never overdue", async () => {
  // the same engine, a plain hourly cron, a pane that always takes the message
  const t = await store({ now: at(UTC, 2026, 8, 4, 6, 30) });
  const sc = await t.s.create({ agent: AGENT, name: "hourly", body: "tick",
    kind: "repeat", cron: "0 * * * *", tz: UTC });

  for (let h = 7; h <= 10; h++) {
    t.set(at(UTC, 2026, 8, 4, h, 0));
    await t.s.tick();
    // delivered on the tick of the hour, and never carrying an overdue marker
    expect(t.s.list().find((x) => x.id === sc.id)!.overdueMs).toBeUndefined();
  }
  expect(t.sent.length).toBe(4);
  expect(t.s.get(sc.id)!.last!.outcome).toBe("delivered");
});

test("how late it actually was is measured at the attempt that carried it", async () => {
  /* The pane read "Last sent 08:50" for a message that landed 110 minutes late,
   * because the record copied the CLAIM's lateness, which was zero. The agent's
   * own line said "110 min late" in the same breath: the app was the only
   * surface lying about it. */
  let reachable = false;
  const t = await store({
    now: at(UTC, 2026, 8, 4, 6, 0),
    fail: () => (reachable ? null : { why: "the session is offline", retriable: true }),
  });
  const sc = await t.s.create({ agent: AGENT, name: "nudge", body: "stop working",
    kind: "once", at: at(UTC, 2026, 8, 4, 7, 0), tz: UTC });

  /* The pane comes back at 100 minutes; the next backed-off attempt is what
   * carries the message, somewhere inside the window that is left. */
  const start = at(UTC, 2026, 8, 4, 7, 0);
  for (let ms = start; ms <= start + 119 * 60_000; ms += TICK_MS) {
    if (ms >= start + 100 * 60_000) reachable = true;
    t.set(ms);
    await t.s.tick();
  }
  const last = t.s.get(sc.id)!.last!;
  expect(last.outcome).toBe("delivered");
  const lateMin = Math.round(last.lateMs! / 60_000);
  // late, and it says so: the claim's own lateness was zero
  expect(lateMin).toBeGreaterThanOrEqual(100);
  expect(lateMin).toBeLessThanOrEqual(120);
  expect(last.at - last.due).toBe(last.lateMs!);
});

test("a stored schedule that cannot be believed is dropped, not guessed at", async () => {
  const t = await store();
  await Bun.write(t.file, JSON.stringify(asFile({
    good: { id: "good", agent: AGENT, name: "ok", body: "fine", kind: "repeat",
      cron: "0 7 * * *", tz: UTC, enabled: true, createdAt: 1, nextAt: null, fires: 0 },
    noCron: { id: "noCron", agent: AGENT, name: "bad", body: "x", kind: "repeat",
      cron: "not a cron", tz: UTC, enabled: true, createdAt: 1, nextAt: null, fires: 0 },
    noTime: { id: "noTime", agent: AGENT, name: "bad", body: "x", kind: "once",
      tz: UTC, enabled: true, createdAt: 1, nextAt: null, fires: 0 },
    noBody: { id: "noBody", agent: AGENT, name: "bad", kind: "once", at: 99,
      tz: UTC, enabled: true, createdAt: 1, nextAt: null, fires: 0 },
    noAgent: { id: "noAgent", name: "bad", body: "x", kind: "once", at: 99,
      tz: UTC, enabled: true, createdAt: 1, nextAt: null, fires: 0 },
    noKind: { id: "noKind", agent: AGENT, name: "bad", body: "x",
      tz: UTC, enabled: true, createdAt: 1, nextAt: null, fires: 0 },
  })));
  const s = await t.restart();
  expect(s.list().map((x) => x.id)).toEqual(["good"]);
});

test("a repeat that comes back with no cursor is given one, and a past one is left alone", async () => {
  /* The file can be edited by hand, and a schedule disabled and re-enabled on
   * disk has no cursor at all. A cursor already in the PAST is left exactly
   * where it is on purpose: that is the catch-up path's business, and helpfully
   * moving it forward is how a missed morning becomes a silent one. */
  const t = await store({ now: at(UTC, 2026, 8, 4, 12, 0) });
  await Bun.write(t.file, JSON.stringify(asFile({
    fresh: { id: "fresh", agent: AGENT, name: "a", body: "x", kind: "repeat",
      cron: "0 7 * * *", tz: UTC, enabled: true, createdAt: 1, nextAt: null, fires: 0 },
    behind: { id: "behind", agent: AGENT, name: "b", body: "y", kind: "repeat",
      cron: "0 7 * * *", tz: UTC, enabled: true, createdAt: 1,
      nextAt: at(UTC, 2026, 8, 4, 7, 0), fires: 0 },
  })));
  const s = await t.restart();
  expect(s.get("fresh")!.nextAt).toBe(at(UTC, 2026, 8, 5, 7, 0));
  expect(s.get("behind")!.nextAt).toBe(at(UTC, 2026, 8, 4, 7, 0));
  // and the one that is behind is the one that fires, late, on the next tick
  await s.tick();
  expect(t.sent.map((x) => x.body)).toEqual(["y"]);
});

/* ----------------------------------------------------- #448 crons in the file
 *
 * Crons belong to a conversation: they live in that agent's own file, and there
 * is no orphan any more. Driven with the fake clock, the same way the rest of
 * the store is.
 */

test("#448 (a) a schedule lands in its agent's own entry and survives a restart", async () => {
  const t = await store({ now: at(UTC, 2026, 8, 4, 6, 0) });
  const sc = await t.s.create({ agent: AGENT, name: "standup", body: "write it",
    kind: "repeat", cron: "0 7 * * *", tz: UTC });
  /* On disk it is the one flat shape (the design): a `schedules` map by
   * schedule id, each record naming its agent; WHERE the file lives is what
   * says whose it is. */
  const disk = JSON.parse(await Bun.file(t.file).text());
  expect(Object.keys(disk.schedules)).toEqual([sc.id]);
  expect(disk.schedules[sc.id].name).toBe("standup");
  expect(disk.schedules[sc.id].agent).toBe(AGENT);
  expect(disk.v).toBe(2);
  // and a brand new object with no memory reads it back from the file
  const back = await t.restart();
  expect(back.list(AGENT).map((x) => x.id)).toEqual([sc.id]);
});

test("#448 (b) a v1 record keyed by sessionId is read as that conversation's own", async () => {
  /* The migration, at the store level: a v1 record carries `sessionId` and no
   * `agent`, and in the pure layout (no agent directories to take the id from)
   * it keeps its own key. The engine's layout maps it to the directory's agent
   * instead, which is crons.test.ts's rewrite test. */
  const t = await store({ now: at(UTC, 2026, 8, 4, 6, 0) });
  await Bun.write(t.file, JSON.stringify(asFile({
    sch_old: { id: "sch_old", sessionId: AGENT, name: "standup", body: "write it",
      kind: "repeat", cron: "0 7 * * *", tz: UTC, enabled: true,
      createdAt: 1, nextAt: null, fires: 0 },
  })));
  const back = await t.restart();
  expect(back.list(AGENT).map((x) => x.name)).toEqual(["standup"]);
  // and the migration writes it back as v2, agent-keyed, with nothing lost
  const disk = JSON.parse(await Bun.file(t.file).text());
  expect(disk.v).toBe(2);
  expect(disk.schedules.sch_old.agent).toBe(AGENT);
  expect(disk.schedules.sch_old.sessionId).toBeUndefined();
});
