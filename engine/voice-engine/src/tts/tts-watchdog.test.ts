/* TTS self-check: fail counter, worker restart, cooldown.
 *
 *   bun test src/tts/tts-watchdog.test.ts
 *
 * The probe and the restart are injected. Nothing talks to a live TTS worker;
 * VOICE_URL is unused here on purpose.
 */
import { expect, test } from "bun:test";
import {
  defaultTtsSelfCheck,
  MIN_TTS_RESTART_COOLDOWN_MS,
  resolveTtsRestartCooldownMs,
  runTtsSelfCheck,
} from "./tts-watchdog";

function failing(msg = "tts worker hung") {
  return async () => {
    throw new Error(msg);
  };
}

test("a failing TTS probe increments ttsConsecutiveFail and restarts the worker at the limit", async () => {
  const state = defaultTtsSelfCheck();
  const restarts: number[] = [];
  const deps = {
    probe: failing(),
    restart: () => { restarts.push(1); },
    failLimit: 3,
    cooldownMs: 60_000,
    watchdogOn: true,
    now: () => 1_000,
    log: () => {},
  };

  await runTtsSelfCheck(state, deps);
  expect(state.ok).toBe(false);
  expect(state.consecutiveFail).toBe(1);
  expect(restarts).toEqual([]);

  await runTtsSelfCheck(state, deps);
  expect(state.consecutiveFail).toBe(2);
  expect(restarts).toEqual([]);

  await runTtsSelfCheck(state, deps);
  expect(restarts).toEqual([1]);
  expect(state.consecutiveFail).toBe(0); // reset after the restart fires
  expect(state.ok).toBe(false);
  expect(state.lastRestartAt).toBe(1_000);
});

test("a second restart inside the cooldown is skipped, then fires once the window passes", async () => {
  const state = defaultTtsSelfCheck();
  const restarts: number[] = [];
  let now = 10_000;
  const deps = {
    probe: failing(),
    restart: () => { restarts.push(now); },
    failLimit: 2,
    cooldownMs: 60_000,
    watchdogOn: true,
    now: () => now,
    log: () => {},
  };

  await runTtsSelfCheck(state, deps);
  await runTtsSelfCheck(state, deps);
  expect(restarts).toEqual([10_000]);
  expect(state.consecutiveFail).toBe(0);

  now = 10_000 + 5_000; // still inside 60s
  await runTtsSelfCheck(state, deps);
  await runTtsSelfCheck(state, deps);
  expect(restarts).toEqual([10_000]); // cooldown held
  expect(state.consecutiveFail).toBe(2);

  now = 10_000 + 60_000;
  await runTtsSelfCheck(state, deps);
  expect(restarts).toEqual([10_000, 70_000]);
  expect(state.consecutiveFail).toBe(0);
});

test("VOICE_TTS_WATCHDOG=0 still counts failures and never restarts", async () => {
  const state = defaultTtsSelfCheck();
  let n = 0;
  for (let i = 0; i < 5; i++) {
    await runTtsSelfCheck(state, {
      probe: failing(),
      restart: () => { n++; },
      failLimit: 2,
      cooldownMs: 1,
      watchdogOn: false,
      log: () => {},
    });
  }
  expect(n).toBe(0);
  expect(state.consecutiveFail).toBe(5);
  expect(state.ok).toBe(false);
});

test("a successful probe clears the fail counter and does not restart", async () => {
  const state = defaultTtsSelfCheck();
  let n = 0;
  await runTtsSelfCheck(state, {
    probe: failing(),
    restart: () => { n++; },
    failLimit: 3,
    cooldownMs: 60_000,
    watchdogOn: true,
    log: () => {},
  });
  await runTtsSelfCheck(state, {
    probe: async () => {},
    restart: () => { n++; },
    failLimit: 3,
    cooldownMs: 60_000,
    watchdogOn: true,
    log: () => {},
  });
  expect(state.ok).toBe(true);
  expect(state.consecutiveFail).toBe(0);
  expect(state.lastError).toBeNull();
  expect(n).toBe(0);
});

test("a sub-60s configured cooldown is clamped so a second restart does not fire within 60s", async () => {
  const state = defaultTtsSelfCheck();
  const restarts: number[] = [];
  let now = 10_000;
  const deps = {
    probe: failing(),
    restart: () => { restarts.push(now); },
    failLimit: 1,
    cooldownMs: 1,
    watchdogOn: true,
    now: () => now,
    log: () => {},
  };

  await runTtsSelfCheck(state, deps);
  expect(restarts).toEqual([10_000]);
  expect(state.lastRestartAt).toBe(10_000);

  now = 10_000 + 2; // 1ms config would have expired; 60s floor has not
  await runTtsSelfCheck(state, deps);
  expect(restarts).toEqual([10_000]);
  expect(state.consecutiveFail).toBe(1);

  now = 10_000 + 60_000;
  await runTtsSelfCheck(state, deps);
  expect(restarts).toEqual([10_000, 70_000]);
  expect(state.consecutiveFail).toBe(0);
});

test("a malformed/NaN cooldown config resolves to >= 60s and does not restart twice within 60s", async () => {
  expect(resolveTtsRestartCooldownMs("bogus")).toBeGreaterThanOrEqual(MIN_TTS_RESTART_COOLDOWN_MS);
  expect(resolveTtsRestartCooldownMs(Number.NaN)).toBeGreaterThanOrEqual(MIN_TTS_RESTART_COOLDOWN_MS);
  expect(Number.isFinite(resolveTtsRestartCooldownMs("bogus"))).toBe(true);

  const state = defaultTtsSelfCheck();
  const restarts: number[] = [];
  let now = 10_000;
  const deps = {
    probe: failing(),
    restart: () => { restarts.push(now); },
    failLimit: 1,
    cooldownMs: Number.NaN,
    watchdogOn: true,
    now: () => now,
    log: () => {},
  };

  await runTtsSelfCheck(state, deps);
  expect(restarts).toEqual([10_000]);

  now = 10_000 + 1; // NaN cooldown would have compared false and restarted again
  await runTtsSelfCheck(state, deps);
  expect(restarts).toEqual([10_000]);
  expect(state.consecutiveFail).toBe(1);

  now = 10_000 + MIN_TTS_RESTART_COOLDOWN_MS;
  await runTtsSelfCheck(state, deps);
  expect(restarts).toEqual([10_000, 70_000]);
});

test("a throwing restart still records the attempt and honors the cooldown", async () => {
  const state = defaultTtsSelfCheck();
  let attempts = 0;
  let now = 5_000;
  const deps = {
    probe: failing(),
    restart: () => {
      attempts++;
      throw new Error("worker respawn failed");
    },
    failLimit: 1,
    cooldownMs: 60_000,
    watchdogOn: true,
    now: () => now,
    log: () => {},
  };

  await runTtsSelfCheck(state, deps);
  expect(attempts).toBe(1);
  expect(state.lastRestartAt).toBe(5_000);
  expect(state.consecutiveFail).toBe(0);

  now = 5_000 + 1;
  await runTtsSelfCheck(state, deps);
  expect(attempts).toBe(1); // no immediate re-restart
  expect(state.consecutiveFail).toBe(1);
});
