/* THE ENGINE OWNS THE SERVICES ON THIS HOST: it starts them, it brings them
 * back, and it says truthfully what it can see.
 *
 * kokoro and scripts/memory-guard.sh used to be processes in a herdr tab. The
 * defect was not that they were badly written, it was that nothing was
 * responsible for them: close the tab and both were gone, with nothing to
 * restart them and nothing anywhere able to say they had been. So these specs
 * are about responsibility, not about speech:
 *
 *   - a service that is not running gets STARTED
 *   - a child that dies comes BACK, proved by killing it by pid
 *   - health says "not running" when it genuinely is not, and does not invent
 *     a pid, a footprint or an "it's fine" for something it has not got
 *   - something already listening is ADOPTED, not duplicated
 *   - a service over its ceiling is restarted, which is the leak this whole
 *     mechanism exists for (kokoro reached 16 GB over four days)
 *   - exactly one engine on a host ACTS, and the others watch and report
 *
 * The voice UNIT's all-or-none rule is the other half of this subject and lives
 * in services-unit.test.ts: the two were one file until it measured 7.8 seconds
 * against an 8 second budget, and the rule here is to split a file rather than
 * to sit on its cap. They share fixtures/services-rig.ts.
 *
 * NOTHING HERE TOUCHES HIS SERVICES. Every spec supervises a toy process on a
 * port it asked the OS for, out of a lease directory and a log directory of its
 * own; nothing ever reads the shipped table except the one spec that asserts
 * what is in it, and that one starts nothing.
 *
 * WHY THIS FILE STILL SPAWNS REAL PROCESSES, and why it no longer boots
 * engines. It is one of the three named exceptions to "no real processes" in
 * this suite, because "the engine started it, it died, and the engine brought
 * the same port back with a different pid" is not a claim you can make about a
 * fake: the subject IS process supervision. What it does NOT need is the whole
 * engine around that. Most specs here used to boot a whole engine through the
 * old harness and read /health over HTTP, which cost a `cp -R` of the source
 * tree and a bun process each and made this a 60 second file; they are
 * `new Services(...)` here, reading `health()` and `units()` directly, which is
 * the same code deciding the same things.
 *
 * AND WHY THE CHECKS ARE DRIVEN BY HAND. `s.check()` is awaited, one pass at a
 * time, instead of `s.start()` running an interval. Every "give it a few more
 * ticks and prove it did NOT act" spec used to be a 2000ms sleep and a hope;
 * now it is two or three explicit passes and no waiting at all. The only real
 * waiting left is for a child to bind or release a port, which is genuine I/O
 * and is polled with `until`.
 *
 *   bun test agent-engine/src/runtime/services.test.ts
 */

import { test, expect, afterAll, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { open, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  cannotStart, defaultServices, listeningPid, loadServices, portOpen,
} from "./services.ts";
import {
  PATIENT, TOY, bindToy, deadPid, freePort, leaseHeldByThisProcess, ownLeaseDir, planted,
  reads, restartedPid, row, services, startsFile, startsIn, toyCmd, toyCwd, toySpec, toyPort,
  untilPort, useServicesRig,
} from "../fixtures/services-rig.ts";
import { whyNotFakeServices } from "../test-utils/guardrails.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";

/* This file's own cleanup hook: see useServicesRig. */
useServicesRig();

/* THE TEST BUDGET OUTLIVES THE RIG'S OWN BOUNDS. bun's default is 5s per test;
 * untilPort alone is allowed 10s, and under `bun test --parallel` a toy's cold
 * `bun` spawn plus its bind can outlive the 5s cap (measured: killed at exactly
 * [5001ms] under a full sweep, never in isolation). Same generous-raise pattern
 * as answer.test.ts's LOADED_MS. */
setDefaultTimeout(30_000);

/* CYC_SERVICES_FILE, set ONCE at file scope and restored when the file is done.
 * Only loadServices() reads it, and it reads it at call time; every other spec
 * here hands Services its table directly. File scope is the one place this
 * suite allows env to move -- a worker runs one file at a time, so nothing can
 * interleave with it -- and it is set here rather than in a hook so the tmp dir
 * registers its own cleanup during collection. */
const tableFile = join(await tmpDir("cyc-table-"), "services.json");
const hadTable = process.env.CYC_SERVICES_FILE;
process.env.CYC_SERVICES_FILE = tableFile;
afterAll(() => {
  if (hadTable === undefined) delete process.env.CYC_SERVICES_FILE;
  else process.env.CYC_SERVICES_FILE = hadTable;
});

/* ------------------------------------------------------- starting and seeing */

test("the engine starts a service that is not running", async () => {
  const port = await toyPort();
  const s = await services([toySpec(port, await startsFile())], { footprint: reads(12) });

  await s.check();
  await untilPort(port, true);
  await s.check();

  const r = row(s, "toy");
  expect(r.running, "the port is answering and the engine said it was not").toBe(true);
  expect(r.pid, "a running service with no pid is the engine reporting a state it cannot see")
    .toBeGreaterThan(0);
  expect(r.owned, "the engine started this process, so it must say it owns it").toBe(true);
  expect(await listeningPid(port), "nothing was actually listening on the port").toBe(r.pid);
  expect(r.footprintMb, "the ceiling cannot be enforced without a reading").toBe(12);
  expect(r.note).toContain("of the 6000MB ceiling");
});

/* THE ONE THE HERDR TAB COULD NOT DO. A pane's process dies and stays dead. */
test("a child killed by pid comes back, and health shows the new one", async () => {
  const port = await toyPort();
  const s = await services([toySpec(port, await startsFile())], { footprint: reads(12) });

  await s.check();
  await untilPort(port, true);
  await s.check();
  const first = row(s, "toy").pid!;

  process.kill(first, "SIGKILL");
  /* Restarted from the child's EXIT, not from the next tick: a supervisor that
   * watched its child die and then waited out a whole interval is a supervisor
   * that chose to leave the service down. */
  await restartedPid(port, first);
  await s.check();

  const back = row(s, "toy");
  expect(back.pid, "the service came back as the same pid, so nothing was actually killed")
    .not.toBe(first);
  expect(back.owned).toBe(true);
  expect(back.restarts, "the engine did not count the restart it performed").toBeGreaterThan(1);
  expect(back.lastExit, "an engine that restarted a child but cannot say it ever exited " +
    "is guessing about its own children").not.toBeNull();
  expect(back.lastExit!.signal ?? String(back.lastExit!.code),
    "the exit record says nothing about how the child went").toBeTruthy();
  expect(await listeningPid(port)).toBe(back.pid);
});

/* THE DEFINING DEFECT CLASS IN THIS PROJECT: the app asserting what it does not
 * know. A service nothing on this engine can start must read as absent, with no
 * pid and no footprint invented to fill the row in. */
test("health says not running, with nothing invented, when it genuinely is not", async () => {
  const port = await toyPort();
  const s = await services([{
    key: "gone", name: "a service nobody started", port, ceilingMb: 8000,
    revive: { how: "watch" },
  }]);

  await s.check();
  const r = row(s, "gone");
  expect(r.running, "nothing is on that port, and the engine said there was").toBe(false);
  expect(r.pid, "a pid for a process that does not exist").toBeNull();
  expect(r.footprintMb, "a footprint for a process that does not exist").toBeNull();
  expect(r.checkedAt, "the engine answered about a service it had not looked at")
    .toBeGreaterThan(0);
  expect(r.note).toContain("nothing is listening");
});

/* A READING IT COULD NOT TAKE IS NOT A READING OF ZERO, and the row has to say
 * which. This is the branch every non-Mac engine is permanently in: linux has
 * no proc_pid_rusage, systemd's MemoryMax caps the services there instead, and
 * an engine that reported "0MB of the 6000MB ceiling" would be claiming to
 * enforce something it cannot even measure. */
test("a footprint that cannot be read says so, and does not read as zero", async () => {
  const port = await toyPort();
  const s = await services([toySpec(port, await startsFile())], { footprint: reads(null) });

  await s.check();
  await untilPort(port, true);
  await s.check();

  const r = row(s, "toy");
  expect(r.running).toBe(true);
  expect(r.footprintMb, "an unmeasurable footprint was reported as a measurement").toBeNull();
  expect(r.note, "/health does not say the ceiling is not being enforced")
    .toContain("could not be measured");
});

/* THE CROSS-USER PRIMITIVE. lsof under a non-root user lists only that user's
 * own sockets, so a voice stack another account on the same Mac serves reads as
 * absent to listeningPid though it answers on loopback. portOpen asks the port
 * itself by connecting, which crosses users, and is what lets the work engine
 * see example's shared kokoro/stt/whisper instead of hiding the mic. */
test("portOpen sees a bound port and not a closed one", async () => {
  const port = await freePort();
  expect(await portOpen(port), "nothing is bound yet, so the connect must fail").toBe(false);

  const server = Bun.listen({
    hostname: "127.0.0.1", port,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  try {
    expect(await portOpen(port), "something is listening, so the connect must succeed").toBe(true);
  } finally {
    server.stop(true);
  }
  expect(await portOpen(port), "the listener is gone, so the connect must fail again").toBe(false);
});

/* A service the engine CANNOT start says so, rather than reporting an endless
 * series of attempts it never made. This is the work account and linux, where
 * there is no kokoro checkout to spawn. */
test("a service whose command is not installed says exactly that", async () => {
  const port = await toyPort();
  const starts = await startsFile();
  const absent = join(toyCwd, "there-is-no-such-file");
  const s = await services([toySpec(port, starts, {
    revive: { how: "spawn", cwd: toyCwd, needs: [absent], cmd: toyCmd(port, starts) },
  })]);

  await s.check();
  await s.check();
  await s.check();

  const r = row(s, "toy");
  expect(r.running).toBe(false);
  expect(r.note, "the engine has to name what is missing, or a new machine is a mystery")
    .toContain("does not exist");
  expect(r.restarts, "it tried to start something it had already decided it could not").toBe(0);
  expect(await startsIn(starts), "it started a service it does not have").toBe(0);
  expect(await portOpen(port), "something was started on the port after all").toBe(false);
});

/* cannotStart IS THE QUALIFICATION TO HOLD A LEASE, so its three answers are
 * worth having on their own rather than only through a supervisor's behaviour.
 * It is asked of the filesystem on EVERY check on purpose: `homedir()` is the
 * running account's, so the same shipped table answers differently in his engine
 * and in `work`'s, and a checkout that goes away must cost the lease rather than
 * leave a supervisor that cannot supervise. */
test("cannotStart names the reason, per revive kind", async () => {
  const port = await toyPort();
  const here = toyCwd;
  const absent = join(here, "there-is-no-such-file");

  expect(cannotStart({ key: "w", name: "w", port, ceilingMb: 1, revive: { how: "watch" } }),
    "a watch-only service read as startable, so an engine would take its lease")
    .toContain("nothing on this engine starts it");

  expect(cannotStart({ key: "s", name: "s", port, ceilingMb: 1,
    revive: { how: "spawn", cwd: here, cmd: ["true"] } }),
    "a spawn service with nothing to check was refused").toBeNull();
  expect(cannotStart({ key: "s", name: "s", port, ceilingMb: 1,
    revive: { how: "spawn", cwd: here, cmd: ["true"], needs: [here, absent] } }),
    "a missing prerequisite was not named").toContain(absent);

  expect(cannotStart({ key: "l", name: "l", port, ceilingMb: 1,
    revive: { how: "launchd", label: "com.harness.nope", plist: absent } }),
    "an account with no LaunchAgent claimed it could bootstrap the job").toContain(absent);
  expect(cannotStart({ key: "l", name: "l", port, ceilingMb: 1,
    revive: { how: "launchd", label: "com.harness.nope", plist: TOY } }),
    "a launchd service whose plist is there was refused").toBeNull();
});

/* HIS KOKORO, ON THE DAY THIS SHIPS. It is already up, started by hand months
 * ago; the engine that now owns it must adopt it rather than race it for the
 * port, and must say which of the two it is. */
test("a service already listening is adopted, not duplicated", async () => {
  const port = await toyPort();
  const starts = await startsFile();
  const already = await bindToy(port, starts);

  const s = await services([toySpec(port, starts)], { footprint: reads(12) });
  await s.check();
  await s.check();

  const r = row(s, "toy");
  expect(r.pid, "the engine started a second copy instead of adopting the one that was there")
    .toBe(already.pid);
  expect(r.owned, "the engine claimed to own a process it did not start").toBe(false);
  expect(r.restarts, "an adopted service was restarted for no reason").toBe(0);
  expect(await startsIn(starts), "more than one toy service was started for one port").toBe(1);
});

/* ------------------------------------------------------------- the ceiling */

/* THE LEAK THIS WHOLE MECHANISM EXISTS FOR. kokoro reached 16 GB over four days
 * and nobody noticed; the ceiling is what turns the next one into a blip. The
 * reading comes from the spec, so a leak is simulated in a line rather than by
 * allocating gigabytes -- and so this reaches the ceiling branch at all on a
 * machine whose kernel has no proc_pid_rusage. */
test("a service over its memory ceiling is restarted", async () => {
  const port = await toyPort();
  const starts = await startsFile();
  const lines: string[] = [];
  const s = await services([toySpec(port, starts, { ceilingMb: 1 })],
    { footprint: reads(4_096), incident: (l) => lines.push(l) });

  await s.check();
  await untilPort(port, true);
  const first = await listeningPid(port);

  await s.check(); // sees 4096MB against a 1MB ceiling
  const back = await restartedPid(port, first!);
  expect(back, "the process over the ceiling was never taken down").not.toBe(first);
  expect(await startsIn(starts), "the ceiling restart did not start a replacement").toBe(2);
  expect(lines.some((l) => l.includes("over the 1MB ceiling")),
    "nothing in the log says why the service was restarted, which is how a service that " +
    "keeps tripping stays invisible").toBe(true);
});

/* NOTHING IS KILLED THAT CANNOT BE BROUGHT BACK. whisper is voicemode's and
 * this process has no supported way to start it, so its footprint is REPORTED
 * and never acted on. That is the one deliberate difference from
 * memory-guard.sh, which killed it and hoped voicemode noticed. */
test("a watch-only service over its ceiling is reported, never killed", async () => {
  const port = await toyPort();
  const starts = await startsFile();
  const mine = await bindToy(port, starts);
  const lines: string[] = [];
  const s = await services([{ key: "whisper", name: "whisper toy (watch)", port, ceilingMb: 1,
    revive: { how: "watch" } }], { footprint: reads(4_096), incident: (l) => lines.push(l) });

  await s.check();
  await s.check();
  await s.check();

  expect(await listeningPid(port),
    "the engine killed a service it has no way of starting again").toBe(mine.pid);
  const r = row(s, "whisper");
  expect(r.note).toContain("OVER the 1MB ceiling");
  expect(r.note, "/health does not say why it was left alone")
    .toContain("nothing on this engine can start it again");
  expect(lines.some((l) => l.includes("left alone")),
    "nothing on the record says a service is sitting over its ceiling").toBe(true);
});

/* ------------------------------------------------------- the lease gate */

/* THE WATCHER STARTS NOTHING. The first half of what a non-holding engine must
 * not do: seeing an empty port is not permission to fill it. Two engines both
 * spawning kokoro is the tidier half of the problem, but it is still an engine
 * running a process nobody asked it for. */
test("an engine that does not hold the lease never starts the service", async () => {
  const port = await toyPort();
  const starts = await startsFile();
  const s = await services([toySpec(port, starts)],
    { ...PATIENT, leaseDir: await leaseHeldByThisProcess() });

  // three passes: every chance to start one, if it were allowed to
  for (let i = 0; i < 3; i++) await s.check();

  expect(await startsIn(starts),
    "an engine that does not supervise this host started the service anyway").toBe(0);
  expect(await portOpen(port), "something was started on the port").toBe(false);

  const r = row(s, "toy");
  expect(r.supervisor.holder, "the engine took a lease this process is holding").toBe(false);
  expect(r.supervisor.pid, "the watcher cannot say who holds the lease it lost")
    .toBe(process.pid);
  expect(r.running, "nothing is listening, and it must say so").toBe(false);
  expect(r.note, "/health leaves the reader wondering whether anything is going to happen")
    .toContain(`pid ${process.pid}`);
});

/* THE WATCHER KILLS NOTHING, which is the half that would have done real
 * damage. The `work` account's engine sees kokoro on his voice port because
 * ports are host-wide, not because it has anything to do with it, and its
 * ceiling check restarting that process means his voice stops mid-sentence for
 * a reading taken by an engine he was not talking to.
 *
 * The ceiling is 1MB and the reading is 4GB, so the toy is over it on every
 * pass: any pass where the watcher is willing to act at all is a pass where it
 * acts. And the service is started by the SPEC, so a restart cannot hide as a
 * start -- the pid on the port must be the same one at the end. */
test("an engine that does not hold the lease never kills a service over its ceiling", async () => {
  const port = await toyPort();
  const starts = await startsFile();
  const mine = await bindToy(port, starts);
  const s = await services([toySpec(port, starts, { ceilingMb: 1 })],
    { ...PATIENT, leaseDir: await leaseHeldByThisProcess(), footprint: reads(4_096) });

  // three passes: a supervisor would have restarted it three times by now
  for (let i = 0; i < 3; i++) await s.check();

  expect(await listeningPid(port),
    "an engine that does not supervise this host killed a process it did not start")
    .toBe(mine.pid);
  expect(await startsIn(starts), "the service was restarted by an engine that only watches")
    .toBe(1);

  const r = row(s, "toy");
  expect(r.footprintMb, "a 1MB ceiling that nothing exceeds is not a ceiling").toBeGreaterThan(1);
  expect(r.owned, "an engine that did not start the process claimed to own it").toBe(false);
  expect(r.restarts, "the watcher restarted it and counted it").toBe(0);
  expect(r.note, "/health does not say the ceiling was exceeded").toContain("OVER");
  expect(r.note, "/health says it is over the ceiling and not who is meant to deal with that")
    .toContain(`pid ${process.pid}`);
});

/* AND A WATCHER REFUSES A RESTART ASKED FOR BY NAME. `restart(key)` is what the
 * voice-model commands call when a chosen model changes, and it goes through
 * the same lease gate as everything else: an engine that does not supervise
 * this service must not bounce it because somebody asked politely. */
test("restart() refuses what this engine has no business restarting", async () => {
  const port = await toyPort();
  const starts = await startsFile();
  const mine = await bindToy(port, starts);
  const s = await services(
    [toySpec(port, starts), { key: "whisper", name: "whisper toy (watch)",
      port: await toyPort(), ceilingMb: 8000, revive: { how: "watch" } }],
    { ...PATIENT, leaseDir: await leaseHeldByThisProcess() });

  const unknown = await s.restart("no-such-service");
  expect(unknown.ok).toBe(false);
  expect(unknown.message, "a restart of a service not in the table was not named as such")
    .toContain("no service named");

  const watchOnly = await s.restart("whisper");
  expect(watchOnly.ok, "the engine agreed to restart something it cannot start").toBe(false);
  expect(watchOnly.message).toContain("cannot start");

  const notMine = await s.restart("toy");
  expect(notMine.ok, "a watcher restarted a service another engine supervises").toBe(false);
  expect(notMine.message).toContain("does not supervise");
  expect(await listeningPid(port), "a refused restart took the service down anyway")
    .toBe(mine.pid);
  expect(await startsIn(starts), "a refused restart started a second copy").toBe(1);
});

/* THE ENGINE THAT CANNOT START IT MUST NOT HOLD IT. This is the defect the
 * per-host lease had, and it would have been silent and total.
 *
 * Capability is per unix ACCOUNT: kokoro lives in `~/.voicemode`, the
 * transcriber in the checkout's own venv. `/Users/work/.voicemode` does not
 * exist, and scripts/deploy-engines.sh restarts work FIRST, so with one lease
 * for the machine the incapable engine claimed it on every deploy and renewed
 * it for ever. The capable engine stood down. Nobody started kokoro, nobody
 * capped it, and /health reported a healthy supervisor throughout -- while this
 * same branch deleted memory-guard.sh, the only other thing that would have.
 *
 * Here the FIRST engine is given a spec it cannot start (`needs` names a path
 * that does not exist) and the second the real one. The second has to win, and
 * the first has to say plainly that it is not the one. */
test("an engine that cannot start a service does not hold its supervision", async () => {
  const port = await toyPort();
  const starts = await startsFile();
  const leaseDir = await ownLeaseDir();
  const absent = join(await tmpDir("cyc-absent-"), "no-such-checkout");

  // the `work` engine: same table, same port, no checkout to start it from
  const cannot = await services([toySpec(port, starts, {
    revive: { how: "spawn", cwd: toyCwd, needs: [absent], cmd: toyCmd(port, starts) },
  })], { leaseDir });
  await cannot.check();
  await cannot.check();

  const first = row(cannot, "toy");
  expect(first.supervisor.holder,
    "an engine that cannot start the service took its supervision lease").toBe(false);
  expect(first.note, "/health does not say why nothing is happening").toContain(absent);
  expect(await startsIn(starts), "it started a service it does not have").toBe(0);

  // his engine, which does have the checkout
  const can = await services([toySpec(port, starts)], { leaseDir });
  await can.check();
  await untilPort(port, true);
  await can.check();

  const up = row(can, "toy");
  expect(up.supervisor.holder,
    "the engine that can start it never got the lease, so nothing supervises it").toBe(true);
  expect(up.running).toBe(true);
  expect(up.owned).toBe(true);
  expect(await startsIn(starts), "the capable engine did not start it").toBe(1);

  // and the incapable one still says it is not the one, now that it can see who is
  await cannot.check();
  expect(row(cannot, "toy").supervisor.holder).toBe(false);
});

/* TWO ENGINES, ONE HOST, ONE SUPERVISOR.
 *
 * His Mac runs two agent engines as two unix users, and ports are host-wide, so
 * both of them see kokoro on the same one. Without a lease both would spawn it
 * when it is down, and -- the part that would have done real damage -- either
 * could restart it on the ceiling check, including the `work` engine killing the
 * kokoro that is speaking to him.
 *
 * The count that settles it is the toy service's own starts file, written by
 * the toy itself: each engine's `restarts` only counts what that engine did, so
 * two engines each doing one would look right from either side.
 *
 * THE SERVICE TAKES A MOMENT TO BIND, and both engines look while the port is
 * still empty, and both of those are the test rather than decoration. A first
 * version had them look one after another at an instant service: the first
 * engine's toy was listening before the second ever looked, so the second
 * adopted it and the spec passed with the whole lease removed. Nothing was being
 * proved. A service that is down for a moment, seen by both engines at once, is
 * the situation kokoro is actually in every time it restarts. */
test("two engines share a host and exactly one of them acts", async () => {
  const port = await toyPort();
  const starts = await startsFile();
  const leaseDir = await ownLeaseDir();
  const spec = [toySpec(port, starts, {}, 200)]; // 200ms of "loading its models"

  const a = await services(spec, { leaseDir, footprint: reads(12) });
  const b = await services(spec, { leaseDir, footprint: reads(12) });

  await Promise.all([a.check(), b.check()]);
  // the port is still empty here: both engines have now seen it empty, which is
  // the moment a second supervisor would start one of its own
  await Promise.all([a.check(), b.check()]);
  await untilPort(port, true);
  await Promise.all([a.check(), b.check()]);

  expect(await startsIn(starts),
    "the toy service was started more than once, so both engines are supervising").toBe(1);

  const holders = [a, b].filter((s) => row(s, "toy").supervisor.holder);
  expect(holders.length, "not exactly one engine holds the supervision lease").toBe(1);

  const holder = holders[0];
  const watcher = holder === a ? b : a;
  expect(row(watcher, "toy").supervisor.pid,
    "the watcher cannot say which engine is supervising, so /health leaves the reader guessing")
    .toBe(row(holder, "toy").supervisor.pid);
  expect(row(watcher, "toy").running,
    "a non-holder still watches and reports: that is the point of it").toBe(true);
  expect(row(watcher, "toy").owned,
    "an engine that did not start the process claimed to own it").toBe(false);

  /* And one kill produces exactly one restart, not one per engine. The watcher
   * gets three passes over a port that is down, which is every chance to decide
   * the thing is missing, if it were allowed to decide anything. */
  const first = row(holder, "toy").pid!;
  process.kill(first, "SIGKILL");
  await watcher.check();
  await watcher.check();
  await restartedPid(port, first);
  await Promise.all([a.check(), b.check()]);

  expect(await startsIn(starts),
    "one death produced more than one start, which is two supervisors racing").toBe(2);
});

/* A LEASE MUST NOT BE A PROMISE THAT OUTLIVES ITS HOLDER.
 *
 * The previous holder was killed outright -- no release, no shutdown hook,
 * which is what a crash and what `launchctl kickstart -k` both look like from
 * the other engine's side. The survivor has to notice and take over, and then
 * actually supervise.
 *
 * THE STALE WINDOW IS A MINUTE HERE, and that is the point of the spec rather
 * than a detail of it. With a short window the takeover would happen on the
 * timeout alone, and the spec would pass with the pid check deleted -- proving
 * nothing about the mechanism that actually matters in production, where the
 * stale window is three MINUTES. A minute means nothing but "that pid is gone"
 * can explain this takeover. */
test("when the supervising engine is gone, the next one takes over and the service comes back",
  async () => {
    const port = await toyPort();
    const starts = await startsFile();
    const leaseDir = await ownLeaseDir();
    await planted(leaseDir, "toy", await deadPid());

    const s = await services([toySpec(port, starts)], { ...PATIENT, leaseDir });
    await s.check();

    expect(row(s, "toy").supervisor.holder,
      "a dead engine's lease outlived it, so nothing supervises this service").toBe(true);
    await untilPort(port, true);
    await s.check();
    expect(row(s, "toy").owned, "the survivor reports a process it started as somebody else's")
      .toBe(true);
    expect(await startsIn(starts), "the survivor never started it").toBe(1);

    // and it really is supervising now: kill the service and watch it come back
    const pid = row(s, "toy").pid!;
    process.kill(pid, "SIGKILL");
    await restartedPid(port, pid);
    expect(await startsIn(starts), "the survivor did not start it, or started it twice").toBe(2);
  });

/* AND THE ORDINARY RESTART COSTS NOTHING. A stopping engine gives the lease
 * back, so the one that replaces it claims on its FIRST check rather than
 * waiting out a pid check or a stale window. He restarts engines constantly;
 * without this every deploy would leave the host unsupervised for a tick. */
test("an engine that stops hands the lease straight to the next one", async () => {
  const port = await toyPort();
  const starts = await startsFile();
  const leaseDir = await ownLeaseDir();

  const leaving = await services([toySpec(port, starts)], { ...PATIENT, leaseDir });
  const arriving = await services([toySpec(port, starts)], { ...PATIENT, leaseDir });
  await leaving.check();
  await arriving.check();
  expect(row(leaving, "toy").supervisor.holder).toBe(true);
  expect(row(arriving, "toy").supervisor.holder,
    "two engines held one service's lease at the same time").toBe(false);

  leaving.stop();
  await until(() => !existsSync(`${leaseDir}/supervisor.toy.lease`),
    { what: "the stopping engine to give its lease back" });

  await arriving.check();
  expect(row(arriving, "toy").supervisor.holder,
    "the lease outlived the engine that gave it back").toBe(true);
});

/* TWO PASSES OVER THE SAME TABLE, which a 60s interval does not prevent.
 *
 * A real pass is not instant and is not bounded by the interval: `launchctl
 * print` is allowed 10s and a kickstart 30s, with four services' worth of lsof
 * behind them. A tick landing on a pass still running gives two walks over the
 * same runtime, and two of them deciding a service is missing is two starts of
 * it. */
test("a check that comes round while the last one is still running is skipped", async () => {
  const port = await toyPort();
  const lines: string[] = [];
  const s = await services(
    [{ key: "toy", name: "toy service", port, ceilingMb: 6000, revive: { how: "watch" } }],
    { log: (l) => lines.push(l) });

  await Promise.all([s.check(), s.check()]);
  expect(lines.some((l) => l.includes("skipping this tick")),
    "two passes ran over the same table at once, and each can start what the other started")
    .toBe(true);
});

/* A CHILD'S LOG IS NOT ALLOWED TO GROW FOR EVER. kokoro writes a line per
 * request into `.run/services/kokoro.log`, opened "a" and never touched again,
 * so the only thing bounding it was how long the machine stayed up. Rolled at
 * spawn: the one moment the file is not already open. */
test("a child's log is rolled when it has got too big, and never more than once back", async () => {
  const port = await toyPort();
  const logDir = await tmpDir("cyc-logs-");
  // one byte over the 64MB roll, without writing 64MB: a sparse file
  const fh = await open(join(logDir, "toy.log"), "w");
  await fh.truncate(64 * 1_048_576 + 1);
  await fh.close();

  const s = await services([toySpec(port, await startsFile())], { logDir });
  await s.check();
  await untilPort(port, true);

  expect(existsSync(join(logDir, "toy.log.1")),
    "the log was not rolled, so it grows until the disk does").toBe(true);
  expect((await stat(join(logDir, "toy.log"))).size,
    "the rolled-aside log is still the one being written to").toBeLessThan(64 * 1_048_576);
});

/* ------------------------------------------------------------- the table */

/* THE CHOSEN MODEL IS RE-CHECKED ON EVERY WRITE, and a missing one is LOUD.
 * The voice-model commands promise that an explicit choice is never silently
 * swapped for another model, and `set()` is the one place every branch of every
 * check funnels through -- so the warning cannot depend on which early return
 * wrote the note. */
test("a service whose chosen model file is missing says so in every note", async () => {
  const port = await toyPort();
  const gone = join(await tmpDir("cyc-model-"), "not-downloaded.bin");
  const s = await services([{
    key: "whisper", name: "whisper toy (watch)", port, ceilingMb: 8000,
    model: { name: "large-v3", path: gone },
    revive: { how: "watch" },
  }]);

  await s.check();
  const r = row(s, "whisper");
  expect(r.model, "a service with a chosen model did not report one").not.toBeUndefined();
  expect(r.model!.present, "a model file that is not there was reported present").toBe(false);
  expect(r.note, "/health does not say the chosen model is missing").toContain("MISSING");
  expect(r.note, "/health does not promise it will not switch models silently")
    .toContain("will NOT silently switch");
});

/* THE REAL TABLE, read rather than started. Since the sherpa migration this is
 * ONE row: the voice engine, whose in-process sherpa-onnx backend serves both
 * TTS and STT. The separate kokoro/stt/whisper python rows are gone (the python
 * stack was removed from install and supervision). The table carries the
 * ceiling memory-guard.sh had and the launchd net under the voice engine. */
test("the shipped table is the single sherpa voice engine, with its ceiling and launchd net",
  () => {
    const specs = defaultServices();
    const voice = specs.find((s) => s.key === "voice-engine")!;
    // The python rows are gone: one sherpa-backed voice service serves everything.
    expect(specs.map((s) => s.key)).toEqual(["voice-engine"]);
    expect(specs.find((s) => s.key === "kokoro")).toBeUndefined();
    expect(specs.find((s) => s.key === "stt")).toBeUndefined();
    expect(specs.find((s) => s.key === "whisper")).toBeUndefined();

    /* THE PORT IS PINNED THROUGH THE GUARDRAIL rather than by writing the number
     * here: the suite's gate 3 forbids his fleet's real ports in a test file at
     * all, so asking the guardrail proves the shipped port is one the boot
     * harness REFUSES to let a test engine near. */
    const guarded = (port: number) => whyNotFakeServices("/tmp/eng-1/services.json", "/tmp/eng-1",
      JSON.stringify([{ name: "x", port }]), "/tmp/eng-1/lease");
    expect(guarded(voice.port)).toContain("voice engine");

    expect(voice.ceilingMb, "the ceiling the 16 GB TTS leak earned").toBe(6000);
    expect(voice.revive.how, "the voice engine has a LaunchAgent; this is the net under it")
      .toBe("launchd");

    /* THE MODEL PRESENCE GATE is stamped on the voice-engine row: needsModel
     * names both models (sherpa's whisper + kokoro) so /health stays honest and
     * a restart is refused until the files land. The backend itself boots
     * without them (it polls and flips ready), so the gate is honesty + restart
     * refusal, not holding the process down. */
    expect(voice.needsModel?.name, "the voice row does not name its whisper model")
      .toContain("whisper-turbo");
    expect(voice.needsModel?.name, "the voice row does not name its kokoro model")
      .toContain("kokoro");
    expect((voice.needsModel?.paths.length ?? 0),
      "with no paths to check, a machine without the models would be told to start it forever")
      .toBeGreaterThan(0);

    /* THE VOICE UNIT (#330): the voice engine is a launchd job, and its teardown
     * is a `launchctl bootout` (stopLaunchd). */
    expect(voice.unit,
      "the voice engine is not in the unit, so a broken unit could leave it running alone")
      .toBe("voice");
  });

/* CYC_SERVICES_FILE IS HOW A TEST SAYS "THESE, AND NOTHING OF HIS", and how
 * linux says "none of these at all". Without it every engine in this repo would
 * adopt the real kokoro, measure it, and be one ceiling reading away from
 * restarting the machine's live speech. So what it does with a table it cannot
 * read matters as much as what it does with a good one: an unreadable table has
 * to mean NO services, never a silent fall back to the real ones. */
test("the table comes from CYC_SERVICES_FILE, and an unreadable one means no services",
  async () => {
    const port = await toyPort();
    await writeFile(tableFile, JSON.stringify([
      { key: "toy", name: "toy service", port, ceilingMb: 6000, revive: { how: "watch" } },
    ]));
    const loaded = await loadServices();
    expect(loaded.map((s) => s.key), "the engine did not use the table it was pointed at")
      .toEqual(["toy"]);
    expect(loaded[0].port).toBe(port);

    await writeFile(tableFile, "{ not a list");
    expect(await loadServices(),
      "a torn table fell back to the real services, on a host that asked for none").toEqual([]);

    await writeFile(tableFile, JSON.stringify({ key: "toy" }));
    expect(await loadServices(),
      "a table that is not a list was read as one service anyway").toEqual([]);
  });
