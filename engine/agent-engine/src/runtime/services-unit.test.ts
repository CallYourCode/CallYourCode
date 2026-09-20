/* THE VOICE UNIT IS ONE THING, NOT FOUR ROWS THAT HAPPEN TO LINE UP (#330).
 *
 * kokoro, the streaming transcriber, whisper and the voice engine only make
 * sense together: speech with nothing to transcribe, or a transcriber with
 * nothing that speaks, is not half a voice stack, it is a broken one. So the
 * engine drives them all-or-none -- every member up, or none of them -- and
 * says which as ONE fact (Services.units()), because a modifier who runs none
 * at all must get a coherent unit rather than four loose things (#325).
 *
 * whisper is the GATE. It is watch-only: nothing on this host can start it, so
 * when it is down the unit cannot be made whole, and all-or-none then means the
 * members this engine CAN start are taken DOWN rather than left running into a
 * partial unit. Every spec here turns on that.
 *
 * These are the specs that need three or four services in the table, which is
 * three or four `lsof` calls per pass; they lived in services.test.ts until the
 * pair measured 7.8 seconds against an 8 second budget, and the rule in this
 * suite is to split a file rather than sit on its cap. The single-service half
 * (start, adopt, ceiling, lease gate, takeover) is still there, and both halves
 * share fixtures/services-rig.ts.
 *
 * NOTHING HERE TOUCHES HIS SERVICES: toys on ports the OS handed out, lease and
 * log directories made fresh per spec, and no real launchd label ever reaches
 * the OS (see fakeLaunchctl).
 *
 *   bun test agent-engine/src/runtime/services-unit.test.ts
 */

import { test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Subprocess } from "bun";
import { listeningPid, portOpen, type ServiceSpec } from "./services.ts";
import {
  PATIENT, bindToy, leaseHeldByThisProcess, reads, row, services, startsFile, startsIn,
  toyCmd, toyCwd, track, toyPort, unitOf, untilPort, useServicesRig,
} from "../fixtures/services-rig.ts";
import { tmpDir } from "../test-utils/tmp.ts";

/* This file's own cleanup hook: see useServicesRig. */
useServicesRig();

/* THE TEST BUDGET OUTLIVES THE RIG'S OWN BOUNDS: same raise as services.test.ts
 * (bun's 5s default vs untilPort's 10s; a unit here spawns THREE toys, and the
 * launchd spec was measured killed at exactly [5001ms] under a full parallel
 * sweep, never in isolation). */
setDefaultTimeout(30_000);

/* ---------------------------------------------- the members, as toy services
 *
 * The "whisper" member is watch-only, so a toy the SPEC starts stands in for
 * the process the engine only watches -- exactly the shape of whisper.cpp,
 * which no engine on this host starts. The spawn members are toys the engine
 * starts and owns, which is what kokoro and the streaming transcriber are.
 */

/** A spawn member of a named unit: a toy the engine starts and owns. */
function unitSpawn(key: string, port: number, starts: string): ServiceSpec {
  return {
    key, name: `${key} toy`, port, ceilingMb: 6000, unit: "voice",
    revive: { how: "spawn", cwd: toyCwd, cmd: toyCmd(port, starts) },
  };
}

/** The watch-only member (whisper): the engine never starts it, so a toy the
 *  spec starts is the only way it is ever up. */
function unitWatch(port: number): ServiceSpec {
  return { key: "whisper", name: "whisper toy (watch)", port, ceilingMb: 8000,
    unit: "voice", revive: { how: "watch" } };
}

/* WHOLE MEANS HEALTHY. All three members up, and health says the unit is one
 * healthy thing rather than three green rows that happen to line up. */
test("a voice unit with every member up reports healthy", async () => {
  const [pk, ps, pw] = [await toyPort(), await toyPort(), await toyPort()];
  const [fk, fs, fw] = await Promise.all([startsFile(), startsFile(), startsFile()]);

  await bindToy(pw, fw); // the member the engine only watches
  const s = await services([unitSpawn("kokoro", pk, fk), unitSpawn("stt", ps, fs), unitWatch(pw)],
    { footprint: reads(12) });

  await s.check();
  await Promise.all([untilPort(pk, true), untilPort(ps, true)]);
  await s.check();

  expect(row(s, "whisper").running, "the watch member's toy never came up").toBe(true);
  const u = unitOf(s, "voice");
  expect(u.healthy, "every member is up, so the unit is whole").toBe(true);
  expect(u.members.slice().sort(), "the unit does not name its three members")
    .toEqual(["kokoro", "stt", "whisper"]);
  expect(u.note).toContain("whole");
});

/* WHISPER DOWN MEANS THE UNIT IS DOWN, so the startable members are NEVER
 * started. This is the conservative resolution of the watch-only member: the
 * engine cannot start whisper, so a missing whisper is a unit that cannot be
 * whole, and kokoro and stt do not get to run into a half-unit. */
test("a unit whose watch-only member is absent never starts the other members", async () => {
  const [pk, ps, pw] = [await toyPort(), await toyPort(), await toyPort()];
  const [fk, fs] = await Promise.all([startsFile(), startsFile()]);
  // nothing is ever bound on pw: whisper is absent for the whole spec

  const s = await services([unitSpawn("kokoro", pk, fk), unitSpawn("stt", ps, fs), unitWatch(pw)]);
  // three passes: every chance to start one, if it were allowed
  for (let i = 0; i < 3; i++) await s.check();

  expect(await startsIn(fk), "kokoro was started while whisper was down: a partial unit").toBe(0);
  expect(await startsIn(fs), "stt was started while whisper was down: a partial unit").toBe(0);
  expect(await portOpen(pk), "kokoro is listening in a unit that cannot be whole").toBe(false);
  expect(await portOpen(ps), "stt is listening in a unit that cannot be whole").toBe(false);

  expect(unitOf(s, "voice").healthy, "a unit with a member down reported healthy").toBe(false);
  expect(row(s, "kokoro").note, "/health does not say why kokoro is being held down")
    .toContain("unit");
});

/* THE STOP. The unit is whole, then whisper goes away, and the members this
 * engine started must be TAKEN DOWN -- not left running in a half-unit. This is
 * the load-bearing half of all-or-none: taking the unit down stops every member
 * this engine can stop, proved by their ports going quiet and staying quiet. */
test("when the watch-only member goes away, the running members are stopped", async () => {
  const [pk, ps, pw] = [await toyPort(), await toyPort(), await toyPort()];
  const [fk, fs, fw] = await Promise.all([startsFile(), startsFile(), startsFile()]);

  const whisper = await bindToy(pw, fw);
  const s = await services([unitSpawn("kokoro", pk, fk), unitSpawn("stt", ps, fs), unitWatch(pw)],
    { footprint: reads(12) });

  // the unit comes up whole
  await s.check();
  await Promise.all([untilPort(pk, true), untilPort(ps, true)]);
  await s.check();
  const kUp = row(s, "kokoro").pid;
  const sUp = row(s, "stt").pid;
  expect(unitOf(s, "voice").healthy, "the unit never became whole to begin with").toBe(true);

  // whisper goes away: the unit can no longer be whole
  whisper.kill("SIGKILL");
  await untilPort(pw, false);

  await s.check(); // the engine must take kokoro and stt DOWN
  expect(await portOpen(pk), "kokoro was left running after whisper went away").toBe(false);
  expect(await portOpen(ps), "stt was left running after whisper went away").toBe(false);

  // and they STAY down: more passes, and no respawn into a still-broken unit
  await s.check();
  await s.check();
  expect(await portOpen(pk), "kokoro was restarted into a unit that cannot be whole").toBe(false);
  expect(await portOpen(ps), "stt was restarted into a unit that cannot be whole").toBe(false);
  expect(await startsIn(fk), "kokoro was started more than the once before whisper died").toBe(1);
  expect(await startsIn(fs), "stt was started more than the once before whisper died").toBe(1);

  expect(unitOf(s, "voice").healthy).toBe(false);
  expect(row(s, "kokoro").note, "/health does not say kokoro was stopped for the unit")
    .toContain("unit");
  // the pids really were there, so "gone" is a change rather than a starting state
  expect(kUp, "the spec never saw a running kokoro pid").toBeGreaterThan(0);
  expect(sUp, "the spec never saw a running stt pid").toBeGreaterThan(0);
});

/* AND A WATCHER TEARS NOTHING DOWN EITHER. All-or-none is still gated on the
 * lease: an engine that does not supervise kokoro must report the unit is not
 * whole and leave kokoro exactly where it is, or the `work` engine would take
 * his speech away every time whisper blinked. */
test("an engine that does not hold the lease never stops a member for the unit", async () => {
  const [pk, pw] = [await toyPort(), await toyPort()];
  const fk = await startsFile();
  const mine = await bindToy(pk, fk); // kokoro is up, started by the spec
  // whisper (pw) is never started, so the unit can never be whole

  const s = await services([unitSpawn("kokoro", pk, fk), unitWatch(pw)],
    { ...PATIENT, leaseDir: await leaseHeldByThisProcess("kokoro"), footprint: reads(12) });
  await s.check();
  await s.check();

  expect(await listeningPid(pk),
    "a watcher took down a member of a unit it does not supervise").toBe(mine.pid);
  const r = row(s, "kokoro");
  expect(r.running).toBe(true);
  expect(r.owned).toBe(false);
  expect(unitOf(s, "voice").healthy, "the unit is not whole and must say so").toBe(false);
  expect(r.note, "/health does not say the unit is not whole").toContain("not whole");
  expect(r.note, "/health does not say who is expected to deal with it")
    .toContain(`pid ${process.pid}`);
});

/* THE VOICE ENGINE IS A UNIT MEMBER TOO, AND IT IS LAUNCHD (#330).
 *
 * kokoro and stt are spawn children, stopped by killing a pid. The voice engine
 * is a launchd KeepAlive job: kill its pid and launchd starts it straight back,
 * so all-or-none needs a different stop for it -- `launchctl bootout` removes
 * the job from the domain, and the ordinary launchd revive (`bootstrap`) brings
 * it back when the unit can be whole. Bootout with no way back would leave it
 * dead for ever, which is not a stop, it is a kill; the point of these specs is
 * that the engine can take it DOWN and put it UP again.
 *
 * WHAT IS REAL AND WHAT IS FAKED. A test must never touch a real
 * com.callyourcode.* label or the running user's launchd domain, so the
 * launchctl BINARY is injected as a fake -- and that fake is not a rubber stamp:
 * it drives a real toy process on a real port, so `bootout` kills the toy (the
 * port really goes quiet) and `bootstrap` starts it (the port really comes
 * back). The DECISION (which member is stopped, that a watcher stops nothing,
 * that a stop is followed by a start) is exercised end to end; only the words
 * `launchctl bootout` reaching the OS are stubbed. That is the honest limit:
 * the bootout/bootstrap call ITSELF is asserted, not executed. */

/** A launchctl that never runs the real binary. It stands in for a launchd job
 *  by driving a toy on `port`: `bootout` kills it, `bootstrap`/`kickstart`
 *  (re)start it, `print` reports loaded iff the toy is up. Every call is
 *  recorded, so a spec can assert the engine issued the bootout/bootstrap. */
function fakeLaunchctl(port: number, starts: string) {
  const calls: string[][] = [];
  let toy: Subprocess | null = null;
  const startToy = () => {
    toy = track(Bun.spawn(toyCmd(port, starts),
      { cwd: toyCwd, stdout: "ignore", stderr: "ignore" }));
  };
  const killToy = () => { if (toy) { try { toy.kill("SIGKILL"); } catch { /* gone */ } toy = null; } };
  const loaded = () => toy !== null && toy.exitCode === null;
  const fn = async (_ms: number, args: string[]) => {
    calls.push(args);
    const cmd = args[0];
    if (cmd === "bootout") { killToy(); return { code: 0, out: "", timedOut: false }; }
    if (cmd === "bootstrap" || cmd === "kickstart") {
      killToy(); startToy(); return { code: 0, out: "", timedOut: false };
    }
    if (cmd === "print") {
      return loaded()
        ? { code: 0, out: "state = running\nlast exit code = 0", timedOut: false }
        : { code: 1, out: "", timedOut: false };
    }
    return { code: 0, out: "", timedOut: false };
  };
  return { fn, calls, startToy, killToy };
}

/** A launchd unit member: same shape as the shipped voice engine, but a
 *  throwaway label and a plist file the spec made itself (which must EXIST, or
 *  cannotStart would say the engine cannot supervise it and it would hold no
 *  lease). The fake launchctl never uses either, so the label reaches nothing. */
async function unitLaunchd(port: number): Promise<ServiceSpec> {
  const plist = join(await tmpDir("cyc-plist-"), "voice-engine.plist");
  await writeFile(plist, "<plist/>");
  return { key: "voice-engine", name: "voice engine toy (launchd)", port, ceilingMb: 2000,
    unit: "voice", revive: { how: "launchd", label: "com.harness.voice-engine", plist } };
}

/* THE STOP. The unit is whole, whisper goes away, and the launchd member is
 * taken down by BOOTOUT -- not by killing its pid, which KeepAlive would undo.
 * The fake records the call and the port really goes quiet. */
test("a launchd unit member is bootout'd when the unit cannot be whole", async () => {
  const [pv, pw] = [await toyPort(), await toyPort()];
  const [fv, fw] = await Promise.all([startsFile(), startsFile()]);
  const voice = await unitLaunchd(pv);
  const fake = fakeLaunchctl(pv, fv);

  fake.startToy();                       // the launchd job is up, as KeepAlive keeps it
  const whisper = await bindToy(pw, fw); // whisper up: the unit can be whole
  await untilPort(pv, true);

  const s = await services([voice, unitWatch(pw)],
    { launchctl: fake.fn, graceTicks: 0, footprint: reads(12) });

  await s.check();
  expect(unitOf(s, "voice").healthy, "the unit never became whole with every member up").toBe(true);
  expect(fake.calls.some((c) => c[0] === "bootout"),
    "the engine bootout'd a healthy launchd member").toBe(false);

  // whisper goes away: the unit can no longer be whole
  whisper.kill("SIGKILL");
  await untilPort(pw, false);

  await s.check();
  expect(fake.calls.some((c) => c[0] === "bootout"),
    "the launchd member was not bootout'd when the unit broke -- a pid kill would flap " +
    "under KeepAlive").toBe(true);
  expect(await portOpen(pv), "the launchd member is still listening after its bootout")
    .toBe(false);
  expect(unitOf(s, "voice").healthy, "a unit with a member down still reports healthy").toBe(false);
  expect(row(s, "voice-engine").note, "/health does not say the member was bootout'd")
    .toContain("bootout");
});

/* THE START. A bootout that could not be undone would be a kill, not a stop.
 * When whisper comes back, the launchd member is BOOTSTRAPPED back and the unit
 * is whole again. */
test("a bootout'd launchd member is bootstrapped back when the unit can be whole", async () => {
  const [pv, pw] = [await toyPort(), await toyPort()];
  const [fv, fw] = await Promise.all([startsFile(), startsFile()]);
  const voice = await unitLaunchd(pv);
  const fake = fakeLaunchctl(pv, fv);

  fake.startToy();
  const whisper = await bindToy(pw, fw);
  await untilPort(pv, true);
  const s = await services([voice, unitWatch(pw)],
    { launchctl: fake.fn, graceTicks: 0, footprint: reads(12) });
  await s.check(); // whole

  // tear the unit down
  whisper.kill("SIGKILL");
  await untilPort(pw, false);
  await s.check();
  await untilPort(pv, false); // the launchd member is bootout'd and down

  // whisper comes back: the unit can be whole again
  await bindToy(pw, fw);
  await s.check(); // sees whisper up, revives the launchd member via bootstrap

  expect(fake.calls.some((c) => c[0] === "bootstrap"),
    "the bootout'd member was never bootstrapped back -- bootout with no way back is a kill, " +
    "not a stop").toBe(true);
  await untilPort(pv, true);
  await s.check(); // sees it up again
  expect(unitOf(s, "voice").healthy,
    "the unit did not come back whole after every member could be up").toBe(true);
  expect(row(s, "voice-engine").running, "the launchd member never came back up").toBe(true);
});

/* A WATCHER NEVER BOOTOUTS. The lease discipline that governs kokoro and stt
 * governs the launchd member too: an engine that does not hold this member's
 * lease reports the unit is not whole and issues NO launchctl call. Without it,
 * the `work` engine could bootout the voice engine his engine supervises. */
test("an engine that does not hold the lease never bootouts the launchd member", async () => {
  const [pv, pw] = [await toyPort(), await toyPort()];
  const fv = await startsFile();
  const voice = await unitLaunchd(pv);
  const fake = fakeLaunchctl(pv, fv);

  fake.startToy();                   // the launchd job is up
  await untilPort(pv, true);         // whisper (pw) is never started: the unit is blocked

  const s = await services([voice, unitWatch(pw)], {
    launchctl: fake.fn, graceTicks: 0, footprint: reads(12),
    ...PATIENT, leaseDir: await leaseHeldByThisProcess("voice-engine"),
  });
  await s.check();
  await s.check(); // every chance to act, if it were allowed to

  expect(fake.calls.some((c) => c[0] === "bootout"),
    "an engine that does not supervise the member bootout'd it anyway").toBe(false);
  expect(await portOpen(pv), "a watcher took the launchd member down").toBe(true);
  const r = row(s, "voice-engine");
  expect(r.supervisor.holder, "the watcher took a lease this process holds").toBe(false);
  expect(unitOf(s, "voice").healthy, "the unit is not whole and must say so").toBe(false);
  expect(r.note, "/health does not say the unit is not whole").toContain("not whole");
});

/* THE FLIP IS TOLD, AND ONLY THE FLIP. A unit's all-or-none health is what the
 * app's item-8 half reads on the {t:"voice"} frame, and a connect-time value
 * goes stale the moment a member dies mid-session (the app would keep showing a
 * mic that records into nothing) or the warm-up flips a fresh false to true. So
 * Services fires onUnitHealth when a unit's health CHANGES -- and never on a
 * tick that changed nothing, or the app would take a voice frame every check.
 *
 * Two watch-only members stand in for a unit whose membership this test can flip
 * at will: a spawn member would be revived underneath the flip the instant it
 * was killed, which is a different thing to prove. The health computation and
 * the flip callback are identical whatever kind the members are. */
test("onUnitHealth fires on a voice-unit health flip, in both directions, and never on an unchanged tick",
  async () => {
    const [pa, pb] = [await toyPort(), await toyPort()];
    const [fa, fb] = await Promise.all([startsFile(), startsFile()]);
    const member = (key: string, port: number): ServiceSpec =>
      ({ key, name: `${key} toy (watch)`, port, ceilingMb: 8000, unit: "voice",
         revive: { how: "watch" } });

    const flips: { name: string; healthy: boolean }[] = [];
    const s = await services([member("a", pa), member("b", pb)],
      { onUnitHealth: (name, healthy) => flips.push({ name, healthy }), footprint: reads(12) });

    await bindToy(pa, fa);
    let tb = await bindToy(pb, fb);

    await s.check(); // first look: both up, unit whole. The baseline is SEEDED, not fired.
    expect(unitOf(s, "voice").healthy, "both members are up, so the unit is whole").toBe(true);
    expect(flips, "the first look at a unit fired instead of only seeding the baseline")
      .toEqual([]);

    await s.check(); // an unchanged tick: still whole
    expect(flips, "a tick that changed nothing fired a voice frame anyway").toEqual([]);

    // a member dies: the unit flips whole -> not whole
    tb.kill("SIGKILL");
    await untilPort(pb, false);
    await s.check();
    expect(unitOf(s, "voice").healthy, "a member is down, so the unit is not whole").toBe(false);
    expect(flips, "the flip to unhealthy did not fire exactly once for the voice unit")
      .toEqual([{ name: "voice", healthy: false }]);

    await s.check(); // still down: no repeat
    expect(flips.length, "an unchanged tick after the flip fired the same frame again").toBe(1);

    // the member returns: the unit flips not whole -> whole
    tb = await bindToy(pb, fb);
    await s.check();
    expect(unitOf(s, "voice").healthy, "every member is up again, so the unit is whole").toBe(true);
    expect(flips, "the flip back to healthy did not fire")
      .toEqual([{ name: "voice", healthy: false }, { name: "voice", healthy: true }]);
  });
