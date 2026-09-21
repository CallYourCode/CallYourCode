/* DISCOVERY + ENROLMENT (announce.ts): the heartbeat tick, enrol-once with a
 * backoff, the 401 token drop, and a token that survives a restart.
 *
 * The engine reaches OUT to the app server rather than being polled: it POSTs
 * /engines/announce on boot and every HEARTBEAT_MS, bearing the token it got by
 * signing with its identity key. A 401 is fresh evidence that
 * the token is dead, so it is dropped and the next tick re-enrols; a FAILED
 * attempt backs off instead, because an app server that is down must not be
 * hammered once per heartbeat for ever.
 *
 * No engine boot, no fixed ports: a stub app server on an OS-assigned port, a
 * tmp data dir, and a MANUAL clock, which is what lets the thirty second backoff
 * and the heartbeat interval be asserted at their production values rather than
 * slept through or shrunk.
 *
 *   bun test agent-engine/src/terminal/announce.test.ts
 */

import { expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { join } from "node:path";
import { makeAnnounce, ENROLL_RETRY_MS } from "./announce.ts";
import { clearAppToken, saveAppToken } from "../security/enroll.ts";
import { DEFAULT_APP_URL } from "../security/pairkey.ts";
import { ensureBaseTree, stateFile } from "../storage/datadir.ts";
import { loadOrCreateE2E, type E2EState } from "../security/sec";
import { manualClock, type ManualClock } from "../runtime/clock.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";

/* ONE data dir for the file, set at file scope and put back afterwards, per the
 * env rule: this module resolves stateFile() per call, so a dir chosen here is
 * the dir every instance below writes its token into. The token FILE is cleared
 * between tests instead, which is the only state that carries. */
let base = "";
const priorDataDir = process.env.CYC_DATA_DIR;
beforeAll(async () => {
  base = await tmpDir("cyc-announce-");
  process.env.CYC_DATA_DIR = base;
  await ensureBaseTree();
});
afterAll(() => {
  if (priorDataDir === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = priorDataDir;
});
beforeEach(() => {
  clearAppToken(stateFile("app-token.json"));
});

type Seen = { path: string; auth: string | null; body: any };

/** The app server, as far as announce.ts can tell: it enrols, it accepts an
 *  announce, and each half can be made to fail on demand. */
function stubServer(opts: { enrollStatus?: number; announceStatus?: number } = {}) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      const body = await req.json().catch(() => null);
      seen.push({ path, auth: req.headers.get("authorization"), body });
      if (path === "/engines/enroll") {
        return new Response(JSON.stringify({ ok: true, token: "cye_test_token" }),
          { status: opts.enrollStatus ?? 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/engines/announce") {
        return new Response(JSON.stringify({ ok: true }),
          { status: opts.announceStatus ?? 200, headers: { "content-type": "application/json" } });
      }
      return new Response("nope", { status: 404 });
    },
  });
  return {
    seen,
    url: `http://127.0.0.1:${server.port}`,
    countOf: (path: string) => seen.filter((s) => s.path === path).length,
    stop: () => server.stop(true),
  };
}

let e2e: E2EState | null = null;

/* The port this engine would be SERVING on. It is never bound by anything here:
 * deriveWsUrl only pastes it into the ws url the announce advertises, and the
 * assertions are about the url's SHAPE. Named rather than spelled inline so the
 * no-fixed-ports gate is not reading a listen port that does not exist. */
const ADVERTISED_PORT = 1;

/** One announce instance over the file's data dir. `heartbeatMs` is an hour by
 *  default so nothing ticks on its own except where a test starts it. */
async function mk(url: string, clock: ManualClock, heartbeatMs = 3_600_000) {
  e2e ??= await loadOrCreateE2E(join(base, "keys.json"));
  return makeAnnounce({
    e2e, engineHost: "testhost", engineUser: "tester",
    host: "127.0.0.1", port: ADVERTISED_PORT, enginePublicUrl: "", rev: "abc1234",
    appServerUrl: url, heartbeatMs, clock,
  });
}

/* -------------------------------------------- pair -> Cloud JUST WORKS.
 * The pair saves the token file with the enrolled base inside; the engine's
 * next boot must resolve its app-server from it, with no APP_SERVER_URL env
 * and no unit drop-in. That resolution is what these two pin down. */

async function mkBare() {
  e2e ??= await loadOrCreateE2E(join(base, "keys.json"));
  return makeAnnounce({
    e2e, engineHost: "testhost", engineUser: "tester",
    host: "127.0.0.1", port: ADVERTISED_PORT, enginePublicUrl: "", rev: "abc1234",
    heartbeatMs: 3_600_000, clock: manualClock(),
  });
}

test("no env: the enrolled base in the token file IS the engine's app-server", async () => {
  saveAppToken(stateFile("app-token.json"), "https://app.example.test", "cyt_enrolled");
  const prior = process.env.APP_SERVER_URL;
  delete process.env.APP_SERVER_URL;
  try {
    const a = await mkBare();
    expect(a.appServerUrl).toBe("https://app.example.test");
    // and the saved token loads against that resolved base, ready to announce
    expect(a.peekToken()).toBe("cyt_enrolled");
  } finally {
    if (prior === undefined) delete process.env.APP_SERVER_URL;
    else process.env.APP_SERVER_URL = prior;
  }
});

test("no env, no enrollment: loopback stays the default", async () => {
  const prior = process.env.APP_SERVER_URL;
  delete process.env.APP_SERVER_URL;
  try {
    const a = await mkBare();
    expect(a.appServerUrl).toBe(DEFAULT_APP_URL);
  } finally {
    if (prior === undefined) delete process.env.APP_SERVER_URL;
    else process.env.APP_SERVER_URL = prior;
  }
});

test("a tick enrols once and announces bearing the issued token", async () => {
  const stub = stubServer();
  try {
    const a = await mk(stub.url, manualClock());
    await a.tick();
    expect(stub.seen.map((s) => s.path)).toContain("/engines/enroll");

    const ann = stub.seen.find((s) => s.path === "/engines/announce")!;
    expect(ann.auth).toBe("Bearer cye_test_token");
    expect(ann.body.host).toBe("testhost");
    expect(ann.body.user).toBe("tester");
    expect(ann.body.rev).toBe("abc1234");
    // the engine names itself by its stable per-install id, from keys.json
    expect(ann.body.engineId).toBe(e2e!.engineId);

    // a second tick REUSES the token: no second enrolment
    await a.tick();
    expect(stub.countOf("/engines/enroll")).toBe(1);
    expect(stub.countOf("/engines/announce")).toBe(2);
  } finally {
    stub.stop();
  }
});

test("peekToken never forces an enrolment; ensureEnrolled does", async () => {
  /* The two readers are deliberately different calls. The settings poll peeks,
   * because a local or tokenless engine polling /settings must not be dragged
   * into enrolling by a read; the push and announce paths ensure, because a call
   * without the token would be refused anyway. */
  const stub = stubServer();
  try {
    const a = await mk(stub.url, manualClock());
    expect(a.peekToken()).toBe("");
    expect(stub.countOf("/engines/enroll")).toBe(0);

    expect(await a.ensureEnrolled()).toBe("cye_test_token");
    expect(stub.countOf("/engines/enroll")).toBe(1);
    expect(a.peekToken()).toBe("cye_test_token");
  } finally {
    stub.stop();
  }
});

test("a failed enrolment backs off instead of hammering", async () => {
  const stub = stubServer({ enrollStatus: 503 });
  try {
    const a = await mk(stub.url, manualClock());
    await a.tick();
    await a.tick();
    await a.tick();
    // one attempt inside the backoff window, however many ticks
    expect(stub.countOf("/engines/enroll")).toBe(1);
    // and it still announced, bare: an engine with no token must keep saying
    // where it is, or it disappears from the app's list entirely
    expect(stub.countOf("/engines/announce")).toBe(3);
    expect(stub.seen.filter((s) => s.path === "/engines/announce").every((s) => s.auth === null))
      .toBe(true);
  } finally {
    stub.stop();
  }
});

test("the backoff EXPIRES: the engine tries again, it does not give up", async () => {
  /* The half the old spec never asserted, and the more dangerous half. A backoff
   * that never expires is indistinguishable from one that works until the app
   * server comes back -- and then the engine is invisible for ever. THIRTY
   * SECONDS, the production value, costs one advance(). */
  const clock = manualClock();
  const stub = stubServer({ enrollStatus: 503 });
  try {
    const a = await mk(stub.url, clock);
    await a.tick();
    expect(stub.countOf("/engines/enroll")).toBe(1);

    await clock.advance(ENROLL_RETRY_MS - 1);
    await a.tick();
    expect(stub.countOf("/engines/enroll"), "it retried inside its own backoff").toBe(1);

    await clock.advance(2);
    await a.tick();
    expect(stub.countOf("/engines/enroll"), "the backoff never expired").toBe(2);
  } finally {
    stub.stop();
  }
});

test("a 401 announce drops the token and the next tick re-enrols AT ONCE", async () => {
  /* An explicit 401 is fresh evidence rather than a failed attempt, so it resets
   * the backoff instead of starting one: the engine is not made to sit out
   * thirty seconds for a token it now knows is dead. Asserted with the clock
   * standing still, which is what makes "at once" mean anything. */
  const clock = manualClock();
  const stub = stubServer({ announceStatus: 401 });
  try {
    const a = await mk(stub.url, clock);
    await a.tick(); // enrol ok, announce 401 -> token dropped, backoff reset
    expect(a.peekToken()).toBe("");
    await a.tick(); // no time has passed at all
    expect(stub.countOf("/engines/enroll")).toBe(2);
  } finally {
    stub.stop();
  }
});

test("dropping a token that is not there changes nothing", async () => {
  // dropAppToken is called from two places on evidence that may arrive twice;
  // the second one must not reset a backoff the first one already set
  const stub = stubServer({ enrollStatus: 503 });
  try {
    const a = await mk(stub.url, manualClock());
    await a.tick();
    expect(stub.countOf("/engines/enroll")).toBe(1);
    a.dropAppToken("nothing to drop");
    await a.tick();
    expect(stub.countOf("/engines/enroll")).toBe(1);
  } finally {
    stub.stop();
  }
});

test("the token survives a process restart via state/app-token.json", async () => {
  const stub = stubServer();
  try {
    const a1 = await mk(stub.url, manualClock());
    await a1.tick();
    const a2 = await mk(stub.url, manualClock()); // a new instance, same data dir
    await a2.tick();
    // still exactly one enrolment across both lifetimes
    expect(stub.countOf("/engines/enroll")).toBe(1);
    expect(a2.peekToken()).toBe("cye_test_token");
  } finally {
    stub.stop();
  }
});

test("a token stored for a DIFFERENT app server is not reused", async () => {
  /* The file records which app server issued the token. Pointing the engine at
   * another one (the hosted/local switch) must re-enrol rather than present a
   * bearer that server has never heard of. */
  const first = stubServer();
  const second = stubServer();
  try {
    await (await mk(first.url, manualClock())).tick();
    expect(first.countOf("/engines/enroll")).toBe(1);

    await (await mk(second.url, manualClock())).tick();
    expect(second.countOf("/engines/enroll"),
      "the other server's token was presented instead of enrolling").toBe(1);
  } finally {
    first.stop();
    second.stop();
  }
});

test("start() announces immediately and then on the heartbeat; stop() ends it", async () => {
  /* The loop itself, which nothing used to cover: an engine that only announced
   * on its interval would be missing from the app's list for a whole heartbeat
   * after every restart, and one that never cancelled its interval would keep a
   * dead engine's entry alive. */
  const clock = manualClock();
  const stub = stubServer();
  try {
    const a = await mk(stub.url, clock, 60_000);
    a.start();
    await until(() => stub.countOf("/engines/announce") === 1, { what: "the boot announce" });
    expect(clock.pending).toBe(1);

    await clock.advance(60_000);
    await until(() => stub.countOf("/engines/announce") === 2, { what: "the first heartbeat" });
    await clock.advance(60_000);
    await until(() => stub.countOf("/engines/announce") === 3, { what: "the second heartbeat" });

    a.stop();
    expect(clock.pending).toBe(0);
    await clock.advance(60_000 * 5);
    expect(stub.countOf("/engines/announce")).toBe(3);
  } finally {
    stub.stop();
  }
});

test("start() twice keeps ONE interval, not two", async () => {
  const clock = manualClock();
  const stub = stubServer();
  try {
    const a = await mk(stub.url, clock, 60_000);
    a.start();
    a.start();
    await until(() => stub.countOf("/engines/announce") >= 1, { what: "the boot announce" });
    expect(clock.pending).toBe(1);
    a.stop();
  } finally {
    stub.stop();
  }
});

test("an unreachable app server never throws: the engine boots and serves regardless", async () => {
  const stub = stubServer();
  const url = stub.url;
  stub.stop(); // the port goes away before the first tick
  const a = await mk(url, manualClock());
  await a.tick(); // must resolve, not reject
  expect(a.peekToken()).toBe("");
});

test("writeAppServerUrl leaves the address where pairkey can read it (F3)", async () => {
  /* pairkey.ts reads this file so an ssh shell that did not inherit
   * APP_SERVER_URL still prints a phone-reachable url. Written at every boot,
   * before the first announce, and 0600 like everything else under state/. */
  const stub = stubServer();
  try {
    const a = await mk(stub.url, manualClock());
    await a.writeAppServerUrl();
    const path = stateFile("app-server-url");
    expect(await Bun.file(path).text()).toBe(stub.url);
    const { statSync } = await import("node:fs");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    stub.stop();
  }
});
