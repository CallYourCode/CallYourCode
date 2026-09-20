/* WHAT CODE AN ENGINE SAYS IT IS RUNNING, on /health.
 *
 * The deploy report (scripts/deploy-engines.sh, task 255) is the only reason
 * this field exists. That script writes .deployed-rev and then restarts a host,
 * and the failure it has to catch is a restart that did not take: the file says
 * the new rev, the process is still the old one, and reading the file back
 * would report a deploy that did not happen. Only the running process can
 * settle that, so it has to be asked -- and it has to answer HONESTLY, because
 * a fabricated rev is the report's own failure mode moved one process to the
 * left.
 *
 * Two halves, both here:
 *
 *   THE PARSE (unit): revFromStamp turns a stamp file into a rev. Both shapes
 *   deploy-engines.sh has ever written are on real hosts right now ("<sha>
 *   <iso>" and a bare "<sha>"), and an absent file must yield "" rather than a
 *   guess. It used to live inside server.ts's boot IIFE, where the only way to
 *   reach it was to boot an engine; it is now exported from routes/health.ts
 *   beside the route that serves it, and server.ts calls it.
 *
 *   THE ROUTE (seam): /health carries ctx.rev through untouched, plus the rest
 *   of what the deploy report and the app read off it -- the voice probe, the
 *   supervised services, the session count. The rev is INJECTED through the
 *   RoutesCtx here, which is what boot does too: it is read once at start-up,
 *   never per request, so an engine that never restarted keeps answering with
 *   whatever it read whenever it did start.
 *
 *   bun test agent-engine/src/runtime/health-rev.test.ts
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { pointVoiceAt, restoreVoiceUrls } from "../test-utils/fake-voice.ts";
import { initSessionsFrame, resetForTest as resetSessionsFrame } from "../sessions/sessions-frame.ts";
import { sessions, type Session } from "../sessions/session-state.ts";
import type { Services } from "./services.ts";

/* THE VOICE PROBE IS A REAL HTTP CALL, and voice-proxy.ts freezes VOICE_URL at
 * module load. So the stub engine is up and the env points at it BEFORE
 * routes/health.ts is pulled in; a static import would be hoisted above both,
 * VOICE_URL would still hold its default, and /health would probe his real
 * voice host. Port 0, so two workers running this file cannot collide. */
let voiceOk = true;
const voice = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname !== "/health") return new Response("no", { status: 404 });
    return voiceOk ? new Response("ok") : new Response("down", { status: 503 });
  },
});
const OLD_VOICE_URL = process.env.VOICE_URL;
process.env.VOICE_URL = `http://127.0.0.1:${voice.port}`;
/* Setting the env only wins the race when THIS file is the first to import
 * voice-proxy.ts (which freezes VOICE_URLS at load). In the full suite a sibling
 * has usually loaded it already, so we also point the module's live list at the
 * stub through the same seam voiceUrl() reads. One entry, so voiceUrl()
 * short-circuits with no health pre-probe. Restored in afterAll. */
pointVoiceAt(`http://127.0.0.1:${voice.port}`);
const { healthRoutes, revFromStamp } = await import("../routes/health.ts");

/* ======================================================================= UNIT
 * revFromStamp: exactly what deploy-engines.sh leaves behind, and nothing else.
 */

test("the rev is the first field of the stamp deploy-engines.sh writes", () => {
  expect(revFromStamp("abc1234 2026-08-05T00:00:00Z\n")).toBe("abc1234");
});

test("a rev with no stamp after it is still a rev", () => {
  // older runs of the script wrote the sha alone; those hosts are still out there
  expect(revFromStamp("def5678")).toBe("def5678");
  expect(revFromStamp("def5678\n")).toBe("def5678");
  expect(revFromStamp("  def5678  \n")).toBe("def5678");
});

test("nothing to read from is an EMPTY rev, never a guess", () => {
  /* A hand-started engine (this machine's checkout) has no .deployed-rev at
   * all, and Bun.file().text() answers "" for a missing file. The deploy report
   * turns "" into a printed "rev unknown" row; anything invented here would be
   * a claim, and a claim is the thing the whole field exists to replace. */
  for (const nothing of ["", "\n", "   ", "\t\n  \n"]) {
    expect(revFromStamp(nothing), `${JSON.stringify(nothing)} produced a rev`).toBe("");
  }
});

test("a stamp with several fields still yields exactly the sha", () => {
  // the file is written by a shell script; a future field must not become the rev
  expect(revFromStamp("abc1234 2026-08-05T00:00:00Z laptop example\n")).toBe("abc1234");
  expect(revFromStamp("abc1234\t2026-08-05T00:00:00Z\n")).toBe("abc1234");
});

/* ======================================================================= SEAM
 * The real healthRoutes group over a real Bun.serve on port 0. No engine.     */

const OLD_DATA_DIR = process.env.CYC_DATA_DIR;
let srv: ServedRoutes;

/** The two Services readings /health reports. A real Services would supervise
 *  child processes; the route only ever copies these two lists through. */
const fakeServices = {
  health: () => [{ key: "kokoro", state: "running", pid: 4242 }],
  units: () => [{ unit: "voice", healthy: true }],
} as unknown as Services;

function seedSession(id: string): Session {
  const s = {
    id, agentId: "ag-healthrev", muxHandle: id, name: id, cwd: "/tmp",
    ws: null, alive: true, busy: false, viaMux: false,
    agent: { id: "claude", name: "Claude" }, hasTranscript: false, agentSession: null,
    harnessSessionId: null, status: "idle", workspace: "w1", tab: null,
    displayAgent: null, stateChangeSeq: 0, turnSince: 0, channels: [],
    doneSeq: 0, seenDoneSeq: 0, heardTs: 0, notified: false, filedTs: 0,
    order: 0, chat: [],
  } as unknown as Session;
  sessions.set(id, s);
  return s;
}

beforeAll(() => {
  process.env.CYC_DATA_DIR = "/nonexistent-health-rev";  // nothing here writes; fail loud if it tries
  initSessionsFrame({
    engineCan: [], pluginDecls: () => [], voiceHealthy: () => true,
    voicePublicUrl: "", engineUser: "tester", engineHost: "probe",
    tabs: "off", replyLevel: () => 1, hasSessionEvents: (k) => k === "claude",
  });
  srv = serveRoutes({ groups: [healthRoutes], ctx: { rev: "abc1234", services: fakeServices } });
});

afterAll(() => {
  srv?.stop();
  voice.stop(true);
  restoreVoiceUrls();
  sessions.clear();
  resetSessionsFrame();
  if (OLD_VOICE_URL === undefined) delete process.env.VOICE_URL;
  else process.env.VOICE_URL = OLD_VOICE_URL;
  if (OLD_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = OLD_DATA_DIR;
});

const health = async () => (await srv.get("/health")).json() as Promise<Record<string, any>>;

test("/health reports the rev this process was started with", async () => {
  const h = await health();
  expect(h.ok, "the engine did not answer /health at all").toBe(true);
  expect(h.rev,
    "the deploy report reads this field to tell a restart that took from one that did not, " +
    "so an engine that cannot say which code it is running makes the whole report a guess",
  ).toBe("abc1234");
});

test("an engine with nothing to read from reports no rev rather than a wrong one", async () => {
  /* The composition root hands boot's REV straight through, so "" here is what
   * a checkout with no .deployed-rev and no git above it answers. `rev` must
   * still be PRESENT and empty: an absent key reads to the report as an engine
   * too old to have the field, which is a different fact. */
  const blank = serveRoutes({ groups: [healthRoutes], ctx: { rev: "", services: fakeServices } });
  try {
    const h = await (await blank.get("/health")).json() as Record<string, any>;
    expect(h.ok).toBe(true);
    expect("rev" in h, "the rev field vanished instead of being empty").toBe(true);
    expect(h.rev, "the engine invented a rev it had no way of knowing").toBe("");
  } finally {
    blank.stop();
  }
});

test("the rev is fixed at wiring time: it does not re-read per request", async () => {
  /* THE ORDER IS THE POINT. A rev re-read on every request would report the
   * file the deploy script just wrote, which says what was ASKED FOR and not
   * what happened -- and "merged on the machine I was sitting at" going
   * unnoticed for three days is why that script exists at all. Two calls
   * against one wiring must agree, and both must be the value the wiring
   * carried. */
  expect((await health()).rev).toBe("abc1234");
  expect((await health()).rev).toBe("abc1234");
});

test("/health is TRIMMED to {ok, rev}: no host telemetry rides it any more", async () => {
  /* Sealed-transport enforcement. /health once carried the voice probe + voice
   * URL, the supervised-service table, the unit list and the session count --
   * host telemetry a bare tailnet peer could read off an ungated route. Those
   * readings ride the sealed channel now (the {t:"voice"} frame, the sessions
   * frame), and the deploy report only ever needed ok + rev, so the rest is
   * dropped rather than owner-gated. The body must be exactly those two keys. */
  seedSession("w1:p1");
  seedSession("w1:p2");
  const h = await health();
  expect(Object.keys(h).sort()).toEqual(["ok", "rev"]);
  // and none of the fields the leak-audit named survive, whatever the state is
  for (const gone of ["voice", "voiceUrl", "sessions", "services", "units", "voiceReady"]) {
    expect(gone in h, `/health still leaks '${gone}'`).toBe(false);
  }
  sessions.clear();
});

test("/health is a GET anybody may ask: no owner gate, no cap", async () => {
  /* Deliberate, and the asymmetry is the design: a tailnet peer may READ
   * /health (the deploy report runs from another host) and may not bounce a
   * service. If this ever starts refusing an un-capped caller, every deploy
   * report goes blank at once. */
  const res = await srv.get("/health");
  expect(res.status).toBe(200);
  const forged = await srv.get("/health", { headers: { "x-forwarded-for": "100.64.0.55" } });
  expect(forged.status, "/health started refusing a proxied reader").toBe(200);
});

test("an unclaimed path falls through this group rather than being swallowed", async () => {
  // healthRoutes must answer null for what is not its own, or every group after
  // it in server.ts's table becomes unreachable
  expect((await srv.get("/health/extra")).status).toBe(404);
  expect((await srv.get("/debug/session-companions")).status).toBe(404); // notifyDebug is off
});
