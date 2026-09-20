/* DISCOVERY + ENROLMENT (L3 feature): the engine reaches OUT to the app
 * server, instead of the app server polling it.
 *
 * On boot and every HEARTBEAT_DEFAULT_MS it POSTs /engines/announce; the app server
 * stores {engineId, owner, user, url, lastSeen} and drops the entry once the
 * engine has been quiet past the lease. The app decides liveness by
 * connecting; nothing here says "up". With no app server configured the
 * announce is a no-op: the engine must boot and serve regardless.
 *
 * THE ENGINE'S OWN TOKEN: the engine enrolls by signing
 * with its identity key (enroll.ts) and bears the issued token on every
 * announce and push. A 401 drops the stored token so the next tick re-enrolls;
 * failed attempts back off.
 *
 *   bun test agent-engine/src/terminal/announce.test.ts
 */

import { announceBody, announceOnce, deriveWsUrl, HEARTBEAT_DEFAULT_MS } from "./discovery.ts";
import { clearAppToken, enrollOnce, loadAppToken, saveAppToken } from "../security/enroll.ts";
import { stateFile } from "../storage/datadir.ts";
import { writePrivate } from "../../../shared/runfiles.ts";
import { realClock, type Clock } from "../runtime/clock.ts";
import type { E2EState } from "../security/sec";

export const ENROLL_RETRY_MS = 30_000;

export type AnnounceDeps = {
  e2e: E2EState;
  engineHost: string;
  engineUser: string;
  host: string;
  port: number;
  enginePublicUrl: string;
  rev: string;
  /** override for tests; default reads APP_SERVER_URL env / HEARTBEAT_DEFAULT_MS */
  appServerUrl?: string;
  heartbeatMs?: number;
  /* THE TIME SEAM, the same one presence.ts and notify.ts take. Two clocks
   * here: the heartbeat interval, and the thirty second enrolment backoff that
   * stops a down app server being hammered. Absent in production, which is
   * Date.now and the global timers, so the behaviour is byte-identical to what
   * it was before the seam existed; a test passes manualClock() and the backoff
   * ladder becomes arithmetic rather than thirty seconds of sleeping. */
  clock?: Clock;
};

export type Announce = {
  readonly appServerUrl: string;
  readonly engineWsUrl: string;
  announcePayload(): Record<string, unknown>;
  /** the enrolled engine token, enrolling (with backoff) when there is none */
  ensureEnrolled(): Promise<string>;
  /** the current token or "", WITHOUT triggering an enrol attempt: for readers
   *  (the settings poll) that must not force enrolment on a local engine */
  peekToken(): string;
  /** an explicit 401 is fresh evidence: drop the token, re-enroll next tick */
  dropAppToken(why: string): void;
  /** one announce now (awaited by tests; fire-and-forget in the loop) */
  tick(): Promise<void>;
  /** write state/app-server-url so pairkey.ts finds the address (F3) */
  writeAppServerUrl(): Promise<void>;
  start(): void;
  stop(): void;
};

export function makeAnnounce(deps: AnnounceDeps): Announce {
  const clk: Clock = deps.clock ?? realClock;
  const appServerUrl = (deps.appServerUrl ?? process.env.APP_SERVER_URL ?? "http://127.0.0.1:10100")
    .replace(/\/$/, "");
  const engineWsUrl = (process.env.ENGINE_WS_URL ??
    deriveWsUrl(deps.host, deps.port, deps.enginePublicUrl)).replace(/\/$/, "");
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_DEFAULT_MS;
  // The stable per-install id rides in keys.json (sec.ts), same 0600 file as
  // the identity it names.
  const engineId = deps.e2e.engineId;
  const tokenFile = stateFile("app-token.json");

  let appToken: string | null = loadAppToken(tokenFile, appServerUrl);
  let lastEnrollTry = 0;
  let timer: unknown = null;

  const announcePayload = () =>
    announceBody(engineId, deps.engineHost, deps.engineUser, engineWsUrl, deps.rev);

  async function ensureEnrolled(): Promise<string> {
    if (appToken || !appServerUrl) return appToken ?? "";
    if (clk.now() - lastEnrollTry < ENROLL_RETRY_MS) return "";
    lastEnrollTry = clk.now();
    const tok = await enrollOnce(appServerUrl, deps.e2e);
    if (tok) {
      appToken = tok;
      saveAppToken(tokenFile, appServerUrl, tok);
    }
    return appToken ?? "";
  }

  function dropAppToken(why: string): void {
    if (!appToken) return;
    appToken = null;
    clearAppToken(tokenFile);
    lastEnrollTry = 0; // an explicit 401 is fresh evidence, not a failed attempt
    console.warn(`[enroll] token rejected (${why}); will re-enroll`);
  }

  async function tick(): Promise<void> {
    const tok = await ensureEnrolled();
    const r = await announceOnce(appServerUrl, announcePayload(), tok);
    if (r.status === 401) dropAppToken("announce 401");
  }

  return {
    appServerUrl,
    engineWsUrl,
    announcePayload,
    ensureEnrolled,
    peekToken: () => appToken ?? "",
    dropAppToken,
    tick,
    async writeAppServerUrl() {
      /* pairkey.ts reads this file so an ssh shell that did not inherit
       * APP_SERVER_URL still prints a phone-reachable url (F3). Written at
       * every boot, before the first announce. */
      await writePrivate(stateFile("app-server-url"), appServerUrl);
    },
    start() {
      if (timer) return;
      void tick();
      timer = clk.setInterval(() => void tick(), heartbeatMs);
    },
    stop() {
      if (timer) clk.clearInterval(timer);
      timer = null;
    },
  };
}
