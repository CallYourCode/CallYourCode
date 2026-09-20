/* TTS half of the voice-engine self-check.
 *
 * The STT probe already exits the process when the batch path wedges; that does
 * not help when the TTS worker is the thing that died. This tracks a separate
 * fail counter and, at the same limit, best-effort restarts the in-process TTS
 * worker (server.ts injects backend.restartTts). The restart is injectable so
 * tests never respawn a worker.
 */

/** Hard floor. A configured 1ms cooldown would otherwise hammer the worker. */
export const MIN_TTS_RESTART_COOLDOWN_MS = 60_000;

/** Always a finite number >= MIN_TTS_RESTART_COOLDOWN_MS. Empty, bogus, NaN,
 *  negative, and Infinity configs all fall back to the floor. */
export function resolveTtsRestartCooldownMs(raw: string | number | undefined): number {
  const n = typeof raw === "number" ? raw : Number(raw ?? MIN_TTS_RESTART_COOLDOWN_MS);
  return Math.max(MIN_TTS_RESTART_COOLDOWN_MS, Number.isFinite(n) ? n : MIN_TTS_RESTART_COOLDOWN_MS);
}

export type TtsSelfCheck = {
  ok: boolean;
  consecutiveFail: number;
  lastError: string | null;
  lastRestartAt: number;
};

export function defaultTtsSelfCheck(): TtsSelfCheck {
  return { ok: true, consecutiveFail: 0, lastError: null, lastRestartAt: 0 };
}

export type TtsSelfCheckDeps = {
  probe: () => Promise<void>;
  restart: () => void;
  failLimit: number;
  cooldownMs: number;
  watchdogOn: boolean;
  now?: () => number;
  log?: (msg: string) => void;
};

/** One TTS probe. Success clears the fail counter. A sustained wedge restarts
 *  the TTS worker (not this process), then resets the counter. A cooldown
 *  stops a restart loop if the interval is shorter than the settle time. */
export async function runTtsSelfCheck(state: TtsSelfCheck, deps: TtsSelfCheckDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m) => console.error(m));
  const cooldownMs = resolveTtsRestartCooldownMs(deps.cooldownMs);
  try {
    await deps.probe();
    state.ok = true;
    state.consecutiveFail = 0;
    state.lastError = null;
  } catch (e) {
    state.ok = false;
    state.consecutiveFail++;
    state.lastError = String(e);
    log(`[selfcheck] tts degraded (${state.consecutiveFail}/${deps.failLimit}): ${state.lastError}`);
    if (!deps.watchdogOn || state.consecutiveFail < deps.failLimit) return;
    if (state.lastRestartAt > 0 && now() - state.lastRestartAt < cooldownMs) {
      log(`[selfcheck] tts wedged; worker restart skipped (cooldown ${cooldownMs}ms)`);
      return;
    }
    log(`[selfcheck] tts wedged across ${state.consecutiveFail} checks; restarting the tts worker`);
    try {
      deps.restart();
    } catch (err) {
      log(`[selfcheck] tts worker restart failed: ${err}`);
    } finally {
      // Record the attempt even if spawn throws, or the next check restarts immediately.
      state.lastRestartAt = now();
      state.consecutiveFail = 0;
    }
  }
}
