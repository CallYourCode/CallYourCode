/* ONE PROCESS FIRES, proved with real processes rather than with objects.
 *
 * WHY THIS IS ITS OWN FILE, and why it is one of the three named exceptions to
 * "no real processes anywhere in this suite". The lock is a claim about what
 * happens when two OPERATING SYSTEM PROCESSES reach the same file at the same
 * moment, and a test that builds two Schedules objects in one process cannot
 * make that claim: they share a pid, so every liveness check is trivially true
 * and every race is scheduled by one event loop. The first version of the lock
 * passed that kind of test and then let ten of twenty engines own the file at
 * once.
 *
 * So each "engine" here is a real `bun` process (fixtures/lock-runner.ts and
 * fixtures/lock-live-runner.ts), they are started together, and what is asserted
 * is what they wrote down.
 *
 * WHAT CHANGED WHEN THIS FILE WAS SLIMMED, and why none of it weakened a spec.
 * It used to cost 52 seconds, of which 16 were ONE test sitting through a
 * deliberately slow delivery. Three things paid for that and all three were
 * waiting rather than proving:
 *
 *   1. THE STALE WINDOW IS NOW SET, not endured. `CYC_LOCK_STALE_MS` and
 *      `CYC_LOCK_BEAT_MS` exist for exactly this (schedules.ts says so), and the
 *      mechanism is identical at 400ms and at five minutes: what matters is the
 *      ratio, that a holder gets several heartbeats inside one window.
 *   2. THE TWENTY-ENGINE HOLD IS A BARRIER, not a sleep. It was a fixed 1500ms,
 *      which only proves simultaneity while it outlasts however long the OS
 *      takes to get twenty bun processes started -- a bound nobody measured.
 *      Each process now says READY and waits to be released, so overlap is
 *      guaranteed and a round costs process startup (~45ms, measured).
 *   3. THE LIVE ENGINES ARE WATCHED, not waited for. They write a status file
 *      per tick, so a spec ends the moment its assertion can be made instead of
 *      when the longest fixed sleep in it runs out.
 *
 * There is no `Bun.sleep` in this file: the runners sleep (they are real
 * engines, and fixtures are not test files), and the spec polls with `until`.
 *
 *   bun test agent-engine/src/storage/lock.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { tmpDir } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";

const HERE = import.meta.dir;
const RUNNER = join(HERE, "..", "fixtures", "lock-runner.ts");
const LIVE = join(HERE, "..", "fixtures", "lock-live-runner.ts");

/* THE SHORTENED WINDOW, and the ratio that makes it the same mechanism.
 *
 * A live engine stamps the lock every BEAT and a lock untouched for STALE is
 * dead whatever its pid says. Shipped, that is 60s inside 5 minutes; here it is
 * 60ms inside 400ms. The number that matters is 400/60: a healthy holder gets
 * six heartbeats inside one stale window, so a stale lock means the holder
 * genuinely stopped beating, never that the spec was unlucky. */
const SHORT_LOCK = { CYC_LOCK_BEAT_MS: "60", CYC_LOCK_STALE_MS: "400" };
const STALE_MS = 400;

/* Every child this file started, gone before the next spec runs. A live runner
 * that outlived its spec would go on taking the lock in a directory the next
 * spec is about to reuse, and there is no output anywhere that would say so. */
let kids: Subprocess[] = [];
afterEach(async () => {
  for (const p of kids) { try { p.kill("SIGKILL"); } catch { /* already gone */ } }
  await Promise.all(kids.map((p) => p.exited.catch(() => null)));
  kids = [];
});

function spawn(cmd: string[], env?: Record<string, string>): Subprocess {
  const p = Bun.spawn(cmd, {
    stdout: "pipe", stderr: "pipe",
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  kids.push(p);
  return p;
}

/* Seed the store file in the ONE on-disk shape it has (schedules.ts,
 * ScheduleFileShape): a flat `schedules` map keyed by schedule id, under a
 * version. `v: 1` so the records may name a `sessionId`, which is what a store
 * written before task 448 looks like -- the single-file layout has no agent
 * directories, so a v1 record keeps its own key and the migration is a no-op. */
async function seed(dir: string, schedules: Record<string, unknown>) {
  await writeFile(join(dir, "schedules.json"), JSON.stringify({ v: 1, schedules }));
}

/** A once-schedule due `inMs` from now. */
function once(id: string, sessionId: string, inMs: number) {
  const now = Date.now();
  return {
    id, sessionId, name: id, body: `the body of ${id}`,
    kind: "once", at: now + inMs, tz: "UTC", enabled: true,
    createdAt: now, nextAt: now + inMs, fires: 0,
  };
}

const lockPath = (dir: string) => join(dir, "schedules.json.lock");

/** Whose pid the lock names right now, or null when it names nobody. */
async function lockPid(dir: string): Promise<number | null> {
  try {
    const o = JSON.parse(await readFile(lockPath(dir), "utf8")) as { pid?: number };
    return Number.isInteger(o.pid) ? o.pid! : null;
  } catch {
    return null;
  }
}

type Run = { pid: number; owner: boolean; delivered: string[] };

/** Start `n` one-shot engines against one file, hold them all at a barrier so
 *  their claims genuinely overlap, then release them together and collect what
 *  each of them said.
 *
 *  `hold` is what makes this a test of exclusion rather than of queueing: with
 *  every process releasing the moment it was done, twenty of them passed the
 *  lock along in an orderly queue and seven "owned" it, one after another,
 *  entirely correctly. Some specs deliberately pass hold=false, because racing
 *  the READ of the file (rather than the write) is the shape that found the
 *  double delivery. */
async function race(dir: string, n: number, hold = true): Promise<Run[]> {
  const file = join(dir, "schedules.json");
  const release = join(dir, "release");
  const procs = Array.from({ length: n }, (_, i) =>
    spawn(["bun", "run", RUNNER, file, hold ? "10000" : "0",
      hold ? join(dir, `ready.${i}`) : "", hold ? release : ""]));
  const outs = procs.map((p) => new Response(p.stdout as ReadableStream).text());
  if (hold) {
    await until(
      () => readdirSync(dir).filter((f) => f.startsWith("ready.")).length >= n,
      { timeoutMs: 15_000, what: `all ${n} engines to reach the barrier` });
    await writeFile(release, "");
  }
  const texts = await Promise.all(outs);
  const runs: Run[] = [];
  for (let i = 0; i < procs.length; i++) {
    await procs[i].exited;
    runs.push({
      pid: procs[i].pid,
      owner: texts[i].includes(`OWNER ${procs[i].pid}`),
      delivered: texts[i].split("\n").filter((l) => l.startsWith("DELIVERED ")),
    });
  }
  return runs;
}

test("twenty engines start together and exactly one owns the file", async () => {
  /* THE MEASUREMENT THAT CONDEMNED THE FIRST LOCK: twenty at once, five rounds,
   * and three of the rounds had more than one owner -- one of them had ten.
   * The hole was an `await` between creating the lock file and writing the pid
   * into it, which left it existing and EMPTY, and an empty lock reads as a
   * dead one. It is taken by linking a file that already has the pid in it now,
   * so there is no such window. Five rounds, because three of five is how often
   * it showed. */
  for (let round = 0; round < 5; round++) {
    const dir = await tmpDir("cyc-lock-");
    const runs = await race(dir, 20);
    const owners = runs.filter((r) => r.owner);
    expect(owners.length, `round ${round}: ${owners.length} engines owned the file at once`).toBe(1);
  }
}, 40_000);

test("six engines and one due occurrence: it is delivered once, by one of them", async () => {
  /* THE OTHER HALF OF THE DOUBLE DELIVERY, and the lock alone did not stop it.
   *
   * With every engine releasing the moment it was done, this still fired twice:
   * two of them READ the file while the occurrence was due, one took the lock,
   * fired, wrote "done" and exited, and the next inherited a free lock while
   * holding a copy of the file from before any of that. The lock now guards the
   * read as well -- claimed before the file is opened, and re-read on every
   * transition into ownership -- so whoever holds it is holding what the file
   * actually says. Deliberately run with NO barrier, because racing the read is
   * the shape that found it. */
  for (let round = 0; round < 3; round++) {
    const dir = await tmpDir("cyc-lock-");
    await seed(dir, { sch_due: once("sch_due", "w1:p1", -60_000) });
    const runs = await race(dir, 6, false);
    const deliveries = runs.flatMap((r) => r.delivered);
    expect(deliveries.length, `round ${round}: delivered ${deliveries.length} times`).toBe(1);
  }
}, 30_000);

test("a zero-byte lock is not a free-for-all", async () => {
  /* THE DURABLE FORM OF THE SAME BUG, and it needed no race at all: nothing
   * fsyncs, so an unclean kill could leave an empty `.lock` on disk, and from
   * then on EVERY process read it as dead and took it. That is the state this
   * starts from. Six engines, one due occurrence.
   *
   * An unreadable lock is now aged by the file's own mtime rather than being
   * assumed dead, so a fresh one is respected. The next spec is the other half:
   * it still goes stale by itself, so it cannot mute schedules for ever. */
  const dir = await tmpDir("cyc-lock-");
  await writeFile(lockPath(dir), "");
  await seed(dir, { sch_due: once("sch_due", "w1:p1", -60_000) });
  const runs = await race(dir, 6, false);
  const deliveries = runs.flatMap((r) => r.delivered);
  expect(deliveries.length, `delivered ${deliveries.length} times`).toBeLessThanOrEqual(1);
  expect(runs.filter((r) => r.owner).length).toBeLessThanOrEqual(1);
}, 30_000);

test("a torn lock is respected while it is fresh, not stolen", async () => {
  const dir = await tmpDir("cyc-lock-");
  await writeFile(lockPath(dir), '{"pid":1234');
  const runs = await race(dir, 4, false);
  expect(runs.filter((r) => r.owner).length).toBeLessThanOrEqual(1);
}, 30_000);

/* THE OTHER SIDE OF "UNREADABLE IS NOT DEAD", which the two specs above cannot
 * reach on their own: if an unreadable lock were respected FOR EVER, a single
 * SIGKILL in the wrong microsecond would mute every schedule on the machine
 * until somebody found the file and deleted it by hand. That is a worse
 * outcome than the double delivery this whole file exists to prevent, so it is
 * asserted rather than assumed. Both shapes, because they take different
 * branches in readLock(): the empty file and the half-written one.
 *
 * mtime is what ages an unreadable lock (there is no stamp inside it to read),
 * so the age is set with utimes rather than waited out. */
test.each([
  ["a zero-byte lock", ""],
  ["a torn lock", '{"pid":1234'],
])("%s past the stale window stops muting schedules", async (_what, body) => {
  const dir = await tmpDir("cyc-lock-");
  await writeFile(lockPath(dir), body);
  const old = new Date(Date.now() - STALE_MS * 10);
  await utimes(lockPath(dir), old, old);
  await seed(dir, { sch_due: once("sch_due", "w1:p1", -60_000) });

  const file = join(dir, "schedules.json");
  const p = spawn(["bun", "run", RUNNER, file, "0"], SHORT_LOCK);
  const out = await new Response(p.stdout as ReadableStream).text();
  await p.exited;

  expect(out, `a lock nobody can read held the file for ever:\n${out}`)
    .toContain(`OWNER ${p.pid}`);
  expect(out.split("\n").filter((l) => l.startsWith("DELIVERED ")).length,
    "the occurrence behind an aged-out lock was never delivered").toBe(1);
}, 30_000);

/* A LOCK NAMING A PROCESS THAT IS GONE, with a perfectly fresh stamp. This is
 * what a SIGKILLed engine leaves behind -- the exit handler that would have
 * unlinked it never ran -- and it is the common case, because he restarts
 * engines constantly. Waiting out a stale window on every crash would leave the
 * machine with no schedules for minutes at a time for no reason, so the pid is
 * asked directly and a dead one is taken at once. The stale window here is the
 * shipped five minutes, so nothing but "that pid is gone" can explain it. */
test("a lock whose pid is gone is taken at once, however fresh its stamp", async () => {
  const dir = await tmpDir("cyc-lock-");
  const dead = spawn(["true"]);
  await dead.exited;
  await writeFile(lockPath(dir), JSON.stringify({ pid: dead.pid, at: Date.now() }));
  await seed(dir, { sch_due: once("sch_due", "w1:p1", -60_000) });

  const runs = await race(dir, 1, false);
  expect(runs[0].owner, "a crashed engine's lock outlived it, so nothing fires here again")
    .toBe(true);
  expect(runs[0].delivered.length, "the occurrence the crashed engine never sent stayed unsent")
    .toBe(1);
}, 30_000);

test("the lock a living engine holds is not taken by the ones that follow it", async () => {
  /* The restart window: the old process is still up when the new one boots,
   * which is exactly when the deliberately-late first tick happens. The holder
   * is parked at its barrier, so it is genuinely still there for the whole of
   * the rivals' attempt rather than for a length of time the spec guessed. */
  const dir = await tmpDir("cyc-lock-");
  const file = join(dir, "schedules.json");
  const ready = join(dir, "holder.ready");
  const holder = spawn(["bun", "run", RUNNER, file, "15000", ready, join(dir, "holder.release")]);
  const holderOut = new Response(holder.stdout as ReadableStream).text();
  await until(() => existsSync(ready), { what: "the holder to take the lock" });

  const during = await race(dir, 3, false);
  expect(during.filter((r) => r.owner).length, "somebody took a live engine's lock").toBe(0);
  expect(await lockPid(dir), "the lock stopped naming the engine that is holding it")
    .toBe(holder.pid);

  await writeFile(join(dir, "holder.release"), "");
  await holder.exited;
  expect(await holderOut).toContain(`OWNER ${holder.pid}`);
}, 30_000);

test("...and the moment it exits, the next engine takes it", async () => {
  const dir = await tmpDir("cyc-lock-");
  await race(dir, 1, false); // held and released
  const after = await race(dir, 1, false);
  expect(after[0].owner).toBe(true);
}, 30_000);

/* --------------------------------------------------- losing it without dying
 *
 * The two ways a process stops being the owner while still running, and the
 * state that follows. Both were measured ending in TWO live processes
 * permanently convinced they owned one file, both writing it, both firing, and
 * nothing that would ever heal it.
 */

type Live = { proc: Subprocess; out: Promise<string>; status: string };
type Status = { pid: number; ticks: number; notMine: number; delivering: string | null };

/** Run a live engine in the background and hand back a handle to it. */
function live(dir: string, name: string,
  opts: { runMs?: number; skewMs?: number; slowMs?: number; slowFor?: string } = {}): Live {
  const status = join(dir, `status.${name}.json`);
  const proc = spawn(["bun", "run", LIVE, join(dir, "schedules.json"),
    String(opts.runMs ?? 8_000), String(opts.skewMs ?? 0), "40",
    String(opts.slowMs ?? 0), opts.slowFor ?? "", status, join(dir, "stop")], SHORT_LOCK);
  return { proc, out: new Response(proc.stdout as ReadableStream).text(), status };
}

/** What that engine last wrote down about itself, or null before its first
 *  write. Polled rather than parsed out of stdout, which only arrives at EOF. */
function statusOf(l: Live): Status | null {
  try {
    return JSON.parse(readFileSync(l.status, "utf8")) as Status;
  } catch {
    return null;
  }
}

/** End the run and collect both engines' output. The stop file is how a spec
 *  finishes the instant its assertion can be made, instead of sitting out
 *  whatever run length was guessed at. */
async function stopAll(dir: string, ...ls: Live[]): Promise<string> {
  await writeFile(join(dir, "stop"), "");
  const texts = await Promise.all(ls.map((l) => l.out));
  for (const l of ls) await l.proc.exited;
  return texts.join("\n");
}

const deliveriesOf = (all: string, id?: string) =>
  all.split("\n").filter((l) => l.startsWith("DELIVERED ") && (!id || l.endsWith(` ${id}`)));

/** Has the store recorded that occurrence as spent? The one thing a spec can
 *  see WHILE the engines are running: their stdout only arrives when they exit,
 *  so waiting on a delivery any other way means waiting on the whole run.
 *  Without this the specs below stopped the engines the instant the lock had
 *  changed hands and then asserted about a delivery that had not been due yet. */
async function storeDone(dir: string, id: string): Promise<boolean> {
  try {
    const j = JSON.parse(await readFile(join(dir, "schedules.json"), "utf8")) as
      { schedules?: Record<string, { last?: { outcome?: string } }> };
    return j.schedules?.[id]?.last?.outcome === "delivered";
  } catch {
    return false;
  }
}

test("an engine suspended past the stale window loses the lock and knows it", async () => {
  /* THE LID-CLOSE CASE, with real signals. The holder is SIGSTOPped, its
   * heartbeat goes stale, a second engine takes the lock, and then the first is
   * SIGCONTed. Before the re-validation it carried on as owner: it beat its own
   * pid back over the live owner's lock and fired the same occurrence, and both
   * processes ran to the end without either ever reporting `owns=false`. */
  const dir = await tmpDir("cyc-lock-");
  await seed(dir, { sch_due: once("sch_due", "w1:p1", STALE_MS * 2) });

  const holder = live(dir, "holder");
  await until(async () => (await lockPid(dir)) === holder.proc.pid,
    { what: "the first engine to take the lock" });

  /* SIGCONT IN A FINALLY. A stopped process that is never continued does not
   * fail this test, it HANGS it: the reads of its output never resolve and the
   * suite sits there until something kills it. An assertion between the stop
   * and the resume is exactly how that happens, so the resume cannot be a line
   * that an assertion can jump over. */
  let taker: Live;
  try {
    process.kill(holder.proc.pid, "SIGSTOP");
    taker = live(dir, "taker");
    await until(async () => (await lockPid(dir)) === taker.proc.pid,
      { timeoutMs: 5_000, what: "the second engine to take the suspended one's lock" });
  } finally {
    try { process.kill(holder.proc.pid, "SIGCONT"); } catch { /* already gone */ }
  }

  // the resumed one finds out on its next tick, rather than carrying on as an
  // owner for ever: that is the whole of what the re-validation bought
  await until(() => (statusOf(holder)?.notMine ?? 0) > 0,
    { timeoutMs: 5_000, what: "the resumed engine to notice it had lost the lock" });

  // and the occurrence goes out ONCE, from whichever engine holds the file when
  // it comes due -- the suspended one is awake again by now and would send its
  // own copy if it still believed it owned anything
  await until(() => storeDone(dir, "sch_due"),
    { timeoutMs: 5_000, what: "the occurrence to be delivered by whoever holds the lock" });

  const all = await stopAll(dir, holder, taker!);
  expect(deliveriesOf(all).length, `delivered ${deliveriesOf(all).length} times:\n${all}`).toBe(1);
  // ...and it did not stamp itself back over the live owner
  expect(await lockPid(dir),
    "the resumed engine beat its own pid back over the live owner's lock")
    .not.toBe(holder.proc.pid);
}, 30_000);

test("an engine whose clock steps ahead does not take a live owner's lock and keep it", async () => {
  /* NO SUSPENSION AT ALL, and the same end state. An engine boots with its
   * clock ahead -- an NTP correction, a wake-from-sleep step -- and reads a
   * perfectly fresh lock as being older than the stale window. It takes it.
   * Before the re-validation, the engine that really held it never found out,
   * and both ran on as owners. */
  const dir = await tmpDir("cyc-lock-");
  await seed(dir, { sch_due: once("sch_due", "w1:p1", STALE_MS * 2) });

  const holder = live(dir, "holder");
  await until(async () => (await lockPid(dir)) === holder.proc.pid,
    { what: "the first engine to take the lock" });

  // ...and one that believes it is well past the stale window from everyone else
  const skewed = live(dir, "skewed", { skewMs: STALE_MS * 5 });

  /* One of the two has to spend time as a loser. Which one is not the point and
   * is not deterministic -- the skewed clock may take the lock, in which case
   * the original loses it and says so. What must never happen is both of them
   * running to the end believing they own it. */
  await until(
    () => (statusOf(holder)?.notMine ?? 0) > 0 || (statusOf(skewed)?.notMine ?? 0) > 0,
    { timeoutMs: 5_000, what: "one of the two engines to report it does not own the file" });
  await until(() => storeDone(dir, "sch_due"),
    { timeoutMs: 5_000, what: "the occurrence to be delivered by whoever holds the lock" });

  const all = await stopAll(dir, holder, skewed);
  expect(deliveriesOf(all).length, `delivered ${deliveriesOf(all).length} times:\n${all}`).toBe(1);

  const notMine = [holder, skewed].map((l) => statusOf(l)?.notMine ?? -1);
  expect(notMine.every((n) => n >= 0), `an engine wrote no status:\n${all}`).toBe(true);
  expect(notMine.some((n) => n > 0),
    `both engines believed they owned the lock the whole time:\n${all}`).toBe(true);
}, 30_000);

/* ------------------------------------------ a delivery that outlives the lock
 *
 * THE ONE SHAPE NONE OF THE TESTS ABOVE CAN REACH, because every `deliver` in
 * them returns instantly. A delivery is the only step here that can take
 * minutes -- `deliverToPane` chains onto a global queue with no timeout -- and
 * everything that goes wrong, goes wrong in the process that comes back from
 * one to find the world has moved on.
 */

test("a process whose delivery outlived the lock does not write its stale snapshot", async () => {
  /* WHAT USED TO HAPPEN, four runs out of four. A is mid-delivery and slow. Its
   * heartbeat cannot save it, because a heartbeat BETWEEN schedules is no use
   * inside one. The lock goes stale, B takes it and fires the other schedule. A
   * returns, and `save()` -- gated only on what A remembered about ownership --
   * writes A's whole pre-delivery snapshot over B's file: the schedule B had
   * just delivered is restored to due-and-not-done, B's record of it is erased,
   * and it goes out a second time. The file afterwards said `fires: 1`, so
   * nothing recorded that anything had been sent twice.
   *
   * Two schedules, because the duplicate lands on the OTHER one: the one the
   * slow process is not holding.
   *
   * THE SIZES, and every one of them is a multiple of the stale window rather
   * than a number that happened to work. The slow delivery is 3x the window, so
   * A is certainly stale while it is inside it; `later` comes due comfortably
   * after B could have taken the lock and comfortably before A comes back, so
   * "A restored a schedule B had already spent" is the only thing that can
   * explain a second delivery. This used to be 8s inside a 2s window with a 16s
   * run; it is the same arithmetic at a twentieth of the cost. */
  const dir = await tmpDir("cyc-lock-");
  await seed(dir, {
    slow1: once("slow1", "w1:p1", Math.round(STALE_MS * 0.4)),
    later: once("later", "w1:p2", Math.round(STALE_MS * 2.2)),
  });

  // A takes the lock and then sits in one delivery for three stale windows
  const a = live(dir, "a", { slowMs: STALE_MS * 3, slowFor: "slow1" });
  await until(() => statusOf(a)?.delivering === "slow1",
    { timeoutMs: 5_000, what: "the first engine to get stuck inside a delivery" });

  // B arrives while A is stuck, finds the lock stale, and takes it
  const b = live(dir, "b");
  await until(async () => (await lockPid(dir)) === b.proc.pid,
    { timeoutMs: 5_000, what: "the second engine to take the stuck one's lock" });

  // A comes back from the delivery, tries to write, and is refused
  await until(() => (statusOf(a)?.notMine ?? 0) > 0,
    { timeoutMs: 5_000, what: "the stuck engine to notice it had lost the lock" });

  const all = await stopAll(dir, a, b);
  expect(deliveriesOf(all, "slow1").length,
    `slow1 went out ${deliveriesOf(all, "slow1").length} times:\n${all}`).toBe(1);
  expect(deliveriesOf(all, "later").length,
    `later went out ${deliveriesOf(all, "later").length} times:\n${all}`).toBe(1);

  /* ...and the file on disk is the WINNER's. `later` has to be spent there:
   * A restoring it to due is exactly the write this test exists to prevent.
   * The on-disk shape is a flat `schedules` map keyed by schedule id
   * (ScheduleFileShape) -- an earlier version of this assertion read it as
   * session-keyed, found undefined, and reported the very restore it was
   * looking for. Undefined is not evidence of anything; the shape is asserted
   * as well now, so a wrong path fails as a wrong path. */
  const onDisk = JSON.parse(await readFile(join(dir, "schedules.json"), "utf8")) as {
    v: number;
    schedules: Record<string, { done?: boolean; nextAt: number | null; last?: { outcome: string } }>;
  };
  expect(Object.keys(onDisk.schedules).sort(),
    `the store file is not the flat schedules map:\n${JSON.stringify(onDisk)}`)
    .toEqual(["later", "slow1"]);
  const later = onDisk.schedules.later;
  expect(later.done, `later was restored to not-done:\n${JSON.stringify(later)}`).toBe(true);
  expect(later.nextAt).toBeNull();
  expect(later.last?.outcome).toBe("delivered");
}, 30_000);
