/* HOW OFTEN THE ACCOUNT IS ASKED, proved by counting the requests.
 *
 * The defect this covers (task 155) had nothing to fail. Every test was green,
 * the card said "retrying", and the only way anybody was ever going to notice
 * was to count what left the machine. So that is what these do: a FAKE UPSTREAM
 * that tallies every hit, the REAL limits.ts pointed at it, and assertions about
 * the tally.
 *
 * IT MUST BE A FAKE. Testing this against api.anthropic.com would be committing
 * the defect -- a burst of requests at the endpoint that was already refusing us
 * -- so every reading below goes through an override that names a port-0 server
 * in this process. Nothing here can reach his keychain either: HOME is moved to
 * a scratch directory for the whole file (below), and every engine is handed a
 * made-up credentials file. "Nothing reached the wire" and "the process was not
 * holding his token" are two claims, and for a while only the first was true.
 * The guard functions that enforce both on the boot harness are unit tested in
 * test-utils/guardrails.test.ts.
 *
 * WHAT AN "ENGINE" IS HERE, and why this no longer spawns anything. Two engines
 * on one Mac are two unix users with two checkouts, one shared directory and one
 * account. What actually separates them is: their own last-reading file, their
 * own login, and no shared module state. `boot()` gives exactly that --
 * `resetForTest` empties limits.ts's cache and points it at that engine's files,
 * which is byte for byte what starting the process again does. A `bun` process
 * per reading bought nothing over that and cost thirty seconds of timeout
 * budget per test; the one thing it did buy, true OS parallelism on the lease,
 * is kept as a real race below (and its multi-process form is named in the
 * report).
 *
 *   bun test agent-engine/src/storage/limits.test.ts
 */

import { test, expect, afterAll, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { manualClock, type ManualClock } from "../runtime/clock.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import {
  LIMITS_POLL_MS, LIMITS_POLL_SPREAD_MS, limitsNow, nextPollAt, pollPhaseMs,
  resetForTest as resetLimits, type LimitsReport,
} from "./limits.ts";
import { releaseLease, takeLease, resetForTest as resetShare } from "./limits-share.ts";
import { renderUsageCard } from "../plugins/usage-card/index.ts";

const ACCOUNT = "someone@example.com";
const MIN = 60_000;

/* A path no engine can ever make a directory at, because /dev/null is not one.
 *
 * This is the DEGRADED path: a directory that cannot be created, cannot be
 * written, or belongs to another user in a mode we cannot use. On a linux
 * deployment where one engine is the whole machine, there is nobody to share a
 * cache WITH. The tests below still want this
 * path, because with nothing on disk the in-process and restart caches are the
 * only ones left and are the only way to see them working. */
const NO_SHARE = "/dev/null/cyc-cannot-exist";

/* HOME IS MOVED FOR THE WHOLE FILE, at file scope, before a single test runs.
 *
 * readToken's second branch is `$HOME/.claude/.credentials.json`, which on this
 * box is his real login. Nothing below means to read it, and a test that means
 * no harm is not the same as a test that can do none: one bad default, one
 * forgotten override, and the process is holding his OAuth token. So the home
 * this file has is an empty scratch one, and the branch that reads it is
 * exercised against that (see "the login on this machine is read from HOME").
 * The three CYC_LIMITS_* overrides are cleared for the same reason: every test
 * says where it is pointing, and nothing inherits an answer from the shell.
 * Restored in afterAll; no test mutates the environment. */
const SAVED_ENV = {
  HOME: process.env.HOME,
  CYC_LIMITS_CREDENTIALS: process.env.CYC_LIMITS_CREDENTIALS,
  CYC_LIMITS_SEEN: process.env.CYC_LIMITS_SEEN,
  CYC_LIMITS_SHARE_DIR: process.env.CYC_LIMITS_SHARE_DIR,
};
const FAKE_HOME = mkdtempSync(join(tmpdir(), "cyc-limits-home-"));
process.env.HOME = FAKE_HOME;
delete process.env.CYC_LIMITS_CREDENTIALS;
delete process.env.CYC_LIMITS_SEEN;
delete process.env.CYC_LIMITS_SHARE_DIR;

afterAll(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

/* Every module this file re-points is put back to its shipped defaults after
 * each test, so a file that runs after this one in the same worker cannot
 * inherit a fake upstream. */
const stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  resetLimits();
  resetShare();
});

/* ------------------------------------------------------- the interval */

test("the account is asked four times an hour, not thirty", () => {
  expect(LIMITS_POLL_MS).toBe(15 * MIN);
  const phase = 90_000;
  let at = nextPollAt(0, phase);
  let inAnHour = 0;
  while (at < 60 * MIN) { inAnHour++; at = nextPollAt(at, phase); }
  expect(inAnHour).toBe(4);
});

test("the poll is on a grid, so restarting does not buy another request", () => {
  const phase = 90_000;
  const first = nextPollAt(0, phase);
  expect(first).toBe(phase);
  /* Whenever inside the cycle the process comes back -- a second in, three
   * minutes in, fourteen -- the next poll is the same instant. An interval
   * measured from boot would give a fresh fifteen minutes each time, which
   * means a crash loop asks as fast as it can restart. */
  for (const t of [1, 3 * MIN, 14 * MIN]) {
    expect(nextPollAt(first + t, phase)).toBe(first + LIMITS_POLL_MS);
  }
  // and the slot is left the instant it is reached, never returned twice
  expect(nextPollAt(first + LIMITS_POLL_MS, phase)).toBe(first + 2 * LIMITS_POLL_MS);
});

/* --------------------------------------------------------- the jitter */

test("two engines on one Mac get different phases", () => {
  /* The two engines on his Mac, by the key they are known by. The host half is
   * deliberately identical, so only the unix user and the port can separate
   * them; the port numbers themselves are written as `p1`/`p2` because a test
   * file that spells one of his real ports is one copy-paste away from talking
   * to a real engine, and gates.test.ts refuses them outright. */
  const air = "macbook-air:example:p1";
  const work = "macbook-air:work:p2";
  expect(pollPhaseMs(air)).not.toBe(pollPhaseMs(work));
  expect(pollPhaseMs(air)).toBeGreaterThanOrEqual(0);
  expect(pollPhaseMs(air)).toBeLessThan(LIMITS_POLL_SPREAD_MS);
  expect(pollPhaseMs(work)).toBeLessThan(LIMITS_POLL_SPREAD_MS);
});

test("an engine's phase is a fact about its name, so a restart lands on it again", () => {
  /* THE POINT IS THAT IT IS NOT A COIN. Math.random() would pass "the same
   * twice in one process" perfectly well and still give a crash-looping engine
   * a fresh phase per boot, which is the one road left back to the old rate.
   *
   * So the phase is asserted against the hash it is DEFINED to be, computed
   * here from the name and nothing else. A process that has never run before
   * gets that number because there is nothing else it could get; the old
   * version of this spawned a second `bun` to watch that happen, which proves
   * strictly less than naming the value does. */
  const key = "macbook-air:example:p1";
  const want = createHash("sha256").update(key).digest().readUInt32BE(0) % LIMITS_POLL_SPREAD_MS;
  expect(pollPhaseMs(key)).toBe(want);
  expect(pollPhaseMs(key)).toBe(pollPhaseMs(key));
  // and the spread is a parameter, not a constant baked into the hash
  expect(pollPhaseMs(key, 1000)).toBe(
    createHash("sha256").update(key).digest().readUInt32BE(0) % 1000);
});

/* ------------------------------------------------- a counted upstream */

type UpstreamOpts = {
  pct?: number;
  /** the usage endpoint's status; 200 unless a test wants a refusal */
  status?: number;
  /** the profile endpoint's status, which fails on its own often enough to matter */
  profileStatus?: number;
};

type Upstream = {
  url: string;
  /** how many times anybody has asked for the usage numbers */
  usage(): number;
  /** every hit, usage and profile both: one reading is a PAIR of requests */
  hits(): number;
  /** flip what it answers, mid-test: a re-login's first ask being refused */
  set(o: UpstreamOpts): void;
};

/** The two endpoints, counted, with the windows the test wants. */
function upstream(opts: UpstreamOpts = {}): Upstream {
  let usage = 0, hits = 0;
  let o = { ...opts };
  const server = Bun.serve({
    port: 0,
    // the engine dials 127.0.0.1, so listen there and nowhere else
    hostname: "127.0.0.1",
    fetch(req) {
      hits++;
      const p = new URL(req.url).pathname;
      if (p.endsWith("/usage")) {
        usage++;
        if (o.status && o.status !== 200) return new Response("no", { status: o.status });
        return Response.json({ limits: [
          { kind: "session", percent: o.pct ?? 13, resets_at: null, severity: "normal" },
        ] });
      }
      if (p.endsWith("/profile")) {
        /* THE PROFILE CALL CAN FAIL ON ITS OWN. It is throttled out of the same
         * bucket as the usage call, and an engine that never gets an answer
         * here never learns whose account it is -- which is what takes the
         * shared cache and the lease out of the picture entirely. */
        if (o.profileStatus && o.profileStatus !== 200) {
          return new Response("no", { status: o.profileStatus });
        }
        return Response.json({ account: { email: ACCOUNT, has_claude_max: true } });
      }
      return new Response("no", { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return {
    url: `http://127.0.0.1:${server.port}`,
    usage: () => usage,
    hits: () => hits,
    set: (next) => { o = { ...o, ...next }; },
  };
}

/* One engine: its own login (as on the real Mac, where the two engines are two
 * unix users) and its own last-reading file. */
type Engine = { name: string; creds: string; seen: string; token: string };

/* One machine: the fake upstream, the directory the engines on it share, and
 * one clock they all read. `boot(e)` makes this process BE engine `e`. */
type Machine = {
  up: Upstream;
  share: string;
  clock: ManualClock;
  engine(name: string, token?: string): Promise<Engine>;
  /** An engine with a `.claude` directory and no credentials file in it. */
  signedOut(name: string): Promise<Engine>;
  boot(e: Engine, o?: { share?: string; leaseWaitMs?: number }): void;
};

async function machine(opts: UpstreamOpts = {}): Promise<Machine> {
  const up = upstream(opts);
  const share = await tmpDir("cyc-limits-share-");
  /* STARTED A MINUTE BEHIND THE WALL CLOCK, and only ever moved FORWARD from
   * there (except where a test is deliberately about a clock that stepped
   * back).
   *
   * The two timelines have to coexist: a lease's staleness is a claim about a
   * process that may be alive RIGHT NOW, so it is deliberately the one thing
   * here that no test may fast-forward past, and it is stamped in real time.
   * Everything limits.ts writes is stamped on this clock. Starting them level
   * made "was this entry published before or after that lease was taken" a
   * question about which side of one millisecond two statements landed on, and
   * it flaked about once in six parallel runs. A minute of daylight between
   * them settles it, and costs nothing: every interval in this file is
   * measured, never absolute. */
  const clock = manualClock(Date.now() - 60_000);
  return {
    up, share, clock,
    async engine(name, token = `token-for-${name}`) {
      const dir = await tmpDir(`cyc-limits-${name}-`);
      const creds = join(dir, "credentials.json");
      await writeFile(creds, JSON.stringify({ claudeAiOauth: { accessToken: token } }));
      return { name, creds, seen: join(dir, "limits-seen.json"), token };
    },
    async signedOut(name) {
      const dir = await tmpDir(`cyc-limits-${name}-`);
      // the path exists as a name and there is no file at it: signed out here
      return { name, creds: join(dir, "credentials.json"),
        seen: join(dir, "limits-seen.json"), token: "" };
    },
    boot(e, o = {}) {
      resetLimits({
        apiBase: up.url, credentialsFile: e.creds, seenFile: e.seen,
        leaseWaitMs: o.leaseWaitMs, now: () => clock.now(),
      });
      resetShare({ dir: o.share ?? share });
    },
  };
}

/** Pretend this engine has asked before, long enough ago to be due again. */
async function hasAskedBefore(m: Machine, e: Engine, agoMs = 60 * MIN) {
  const at = m.clock.now() - agoMs;
  await writeFile(e.seen, JSON.stringify({
    account: ACCOUNT,
    marks: {},
    askedAt: at,
    report: { ok: true, email: ACCOUNT, plan: "Max", fetchedAt: at,
      windows: [{ label: "5 hours", pct: 1, resetsAt: null, severity: "normal" }] },
  }));
}

/* An engine that got a 429 `agoMs` ago and has NEVER learned whose account it
 * is, which is the state the whole defect lives in.
 *
 * NO EMAIL ANYWHERE IN HERE, and the first version of this fixture had one. The
 * report carried `email` "because a report has one", loadSeen falls back to
 * `report.email` when there is no `account` field, and so the fixture quietly
 * described an engine that knew perfectly well whose account it was: it took
 * the lease, read the machine's shared answer, and the test passed with one
 * request whether the fix was there or not. Mutating the fix killed nothing,
 * and that is how it was found. An engine whose profile call has never once
 * been answered has no email to remember. */
async function wasRefused(m: Machine, e: Engine, agoMs: number) {
  await writeFile(e.seen, JSON.stringify({
    marks: {},
    askedAt: m.clock.now() - agoMs,
    askError: "rate limited",
    // the last good numbers, from long before the refusal: what the card shows
    report: { ok: true, plan: "Max", fetchedAt: m.clock.now() - 6 * 60 * MIN,
      windows: [{ label: "5 hours", pct: 77, resetsAt: null, severity: "normal" }] },
  }));
}

/** Read a reading `times` times over, the way a card being looked at does. */
async function reads(times: number, force = false): Promise<LimitsReport[]> {
  const out: LimitsReport[] = [];
  for (let i = 0; i < times; i++) out.push(await limitsNow(force));
  return out;
}

/** The one shared entry this machine has for the account. */
async function sharedFile(share: string): Promise<string> {
  const f = (await readdir(share)).find((n) => n.startsWith("acct-") && n.endsWith(".json"));
  if (!f) throw new Error(`nothing was published into ${share}`);
  return join(share, f);
}

/* ------------------------------------------------------------ the cache */

test("three reads inside the interval are one request", async () => {
  const m = await machine();
  const air = await m.engine("air");
  m.boot(air);
  const rs = await reads(3);
  expect(rs.every((r) => r.ok)).toBe(true);
  expect(m.up.usage()).toBe(1);
  expect(m.up.hits()).toBe(2); // usage and profile: a reading is a PAIR of requests
});

test("a restart inside the interval asks for nothing", async () => {
  const m = await machine();
  const air = await m.engine("air");
  m.boot(air);
  await limitsNow();
  expect(m.up.usage()).toBe(1);
  // the same engine again: its memory is gone and the disk is not
  m.boot(air);
  const [r] = await reads(1);
  expect(r.ok).toBe(true);
  expect(r.windows![0].pct).toBe(13);
  expect(m.up.usage()).toBe(1);
});

/* THE NEXT TWO ARE THE SAME CLAIMS WITH THE SHARED FILE TAKEN AWAY, and they
 * exist because without that the claims are not tested at all.
 *
 * Both were measured: breaking the in-process TTL, and breaking the seed from
 * disk, killed nothing. The machine's shared answer covered for each of them --
 * the engine went and found the same numbers one directory away and every count
 * came out right. That is fine behaviour and a useless test. On a single-engine
 * linux deployment, these two are the only caches there are. */

test("three reads with no shared file are still one request", async () => {
  const m = await machine();
  const air = await m.engine("air");
  m.boot(air, { share: NO_SHARE });
  const rs = await reads(3);
  expect(rs.every((r) => r.ok)).toBe(true);
  expect(m.up.usage()).toBe(1);
});

test("a restart with no shared file is still no request", async () => {
  const m = await machine();
  const air = await m.engine("air");
  m.boot(air, { share: NO_SHARE });
  await limitsNow();
  expect(m.up.usage()).toBe(1);
  // a KeepAlive plist and a crash loop is this, over and over
  for (let i = 0; i < 3; i++) {
    m.boot(air, { share: NO_SHARE });
    const [r] = await reads(1);
    expect(r.ok).toBe(true);
    expect(r.windows![0].pct).toBe(13);
  }
  expect(m.up.usage()).toBe(1);
});

test("a reading older than the interval is asked for again", async () => {
  const m = await machine();
  const air = await m.engine("air");
  m.boot(air);
  await limitsNow();
  expect(m.up.usage()).toBe(1);
  await m.clock.advance(60 * MIN);
  await limitsNow();
  expect(m.up.usage()).toBe(2);
});

test("the TTL is shorter than the interval, so a poll never skips its own turn", async () => {
  /* A TTL exactly equal to the interval reads well and is wrong: a poll landing
   * fifteen minutes after its own last reading would find that reading, by a
   * fraction of a second, still fresh, skip its turn, and silently double the
   * real interval with nothing in the logs to say so. */
  const m = await machine();
  const air = await m.engine("air");
  m.boot(air);
  await limitsNow();
  expect(m.up.usage()).toBe(1);
  // one whole interval later to the millisecond: it must be its turn
  await m.clock.advance(LIMITS_POLL_MS);
  await limitsNow();
  expect(m.up.usage()).toBe(2);
});

test("refresh=1 asks even when the cache is warm", async () => {
  const m = await machine();
  const air = await m.engine("air");
  m.boot(air);
  await limitsNow();
  expect(m.up.usage()).toBe(1);
  /* THE ON-DEMAND PATH. /limits?refresh=1 is the arrow on the card, and the
   * point of a longer interval is not to make that slower to tell the truth. */
  await limitsNow(true);
  expect(m.up.usage()).toBe(2);
});

/* -------------------- being refused must not make it ask harder */

test("a refused engine that does not know its account still asks only once", async () => {
  /* THE LOOP THIS WHOLE BRANCH EXISTS TO REMOVE, reached by a road nobody had
   * walked. The profile call is throttled out of the same bucket as the usage
   * call, so an engine with a fresh `.run/` that boots while the account is
   * being refused never learns whose account it is: no lease, no shared answer,
   * nothing published. And a 429 leaves the last good reading's timestamp
   * exactly where it was, so an interval measured from THAT never bit again.
   * Five card reads were five asks and ten requests, into an endpoint that had
   * just refused one. Measured, and this is the measurement. */
  const m = await machine({ status: 429 });
  const air = await m.engine("air");
  await wasRefused(m, air, 60 * MIN); // due, and with no account on file
  m.boot(air);
  const rs = await reads(5);
  expect(m.up.usage()).toBe(1);
  // and it is still showing his numbers, aged, with the reason
  expect(rs[4].stale).toBe(true);
  expect(rs[4].error).toBe("rate limited");
  expect(rs[4].reason).toBe("throttled");
  expect(rs[4].windows![0].pct).toBe(77);
});

test("a refusal survives a restart, so restarting does not buy another ask", async () => {
  const m = await machine({ status: 429 });
  const air = await m.engine("air");
  await wasRefused(m, air, 60 * MIN);
  m.boot(air);
  await limitsNow();
  expect(m.up.usage()).toBe(1);
  // four restarts inside the interval. Without askedAt on disk this is four
  // more asks, and a KeepAlive plist restarts far more often than that.
  for (let i = 0; i < 4; i++) {
    m.boot(air);
    const [r] = await reads(1);
    expect(r.stale).toBe(true);
    expect(r.error).toBe("rate limited");
    expect(r.reason).toBe("throttled");
  }
  expect(m.up.usage()).toBe(1);
});

test("an engine whose profile call keeps failing never shares, and says so by asking", async () => {
  /* THE RESIDUAL, stated as a test rather than as a paragraph. Usage answers,
   * profile does not, so the numbers are real and the account is unknown for as
   * long as that lasts: no lease, no shared entry, nothing published. Two
   * engines in that state each ask for themselves. What is bounded is the RATE
   * -- once per interval each -- and that is the whole of the claim. */
  const m = await machine({ profileStatus: 429 });
  const air = await m.engine("air");
  const work = await m.engine("work");
  m.boot(air);
  const a = await reads(3);
  m.boot(work);
  const b = await reads(3);
  // six reads between them, one ask each: not shared, but not a loop either
  expect(m.up.usage()).toBe(2);
  expect(a[0].ok).toBe(true);
  expect(a[0].email).toBeUndefined();
  expect(b[2].windows![0].pct).toBe(13);
  // nothing was published, because neither of them knows what to key it under
  expect(await readdir(m.share)).toEqual([]);
});

test("a signed-out engine asks on the interval, not on every card read", async () => {
  /* Same shape, different refusal: a 401 is a request that went out and came
   * back, so it restarts the clock like any other. */
  const m = await machine({ status: 401 });
  const air = await m.engine("air");
  m.boot(air);
  const rs = await reads(4);
  expect(m.up.usage()).toBe(1);
  expect(rs[3].ok).toBe(false);
  expect(rs[3].error).toContain("sign in again");
  expect(rs[3].reason).toBe("signed-out");
  /* AND IT IS NOT PUBLISHED. An expired token is a fact about ONE unix user's
   * login, not about the account or this machine's network, so the other engine
   * signed into the same account must not inherit it. */
  expect(await readdir(m.share)).toEqual([]);
});

/* ----------------------------- a clock that stepped backwards */

test("a reading stamped in the future does not freeze the poll", async () => {
  /* `now - at < ttl` is satisfied for ever by anything in the future, so one
   * timestamp ahead of this machine's clock is a latch, not a cache: measured
   * at zero requests with a seen file six hours ahead, serving numbers out of
   * that file with nothing to say they were old. A clock stepping back puts
   * every timestamp this engine ever wrote into the future at once, which a
   * laptop waking up or an NTP correction can do. */
  const m = await machine({ pct: 42 });
  const air = await m.engine("air");
  await hasAskedBefore(m, air, 0); // asked just now, so nothing is due
  // ...and then the machine's clock steps back six hours
  m.clock.setNow(m.clock.now() - 6 * 60 * MIN);
  m.boot(air);
  const [r] = await reads(1);
  expect(m.up.usage()).toBe(1);      // it asked, rather than latching
  expect(r.windows![0].pct).toBe(42);
});

test("a shared entry stamped in the future is not adopted as fresh", async () => {
  const m = await machine({ pct: 42 });
  const air = await m.engine("air");
  const work = await m.engine("work");
  await hasAskedBefore(m, air);
  m.boot(air);
  await limitsNow();                 // publishes a real entry
  expect(m.up.usage()).toBe(1);

  m.clock.setNow(m.clock.now() - 6 * 60 * MIN);
  await hasAskedBefore(m, work);
  m.boot(work);
  const [r] = await reads(1);
  expect(m.up.usage()).toBe(2);      // it asked rather than trusting the future
  expect(r.ok).toBe(true);
});

test("a reading from the future is not drawn as brand new", async () => {
  /* THE OTHER HALF OF A CLOCK THAT STEPPED BACK, and it is on the card rather
   * than in the cache. The two tests above stop a future timestamp latching the
   * poll off; neither of them can make the NUMBER young, and the card's age
   * comes from the reading's own fetchedAt.
   *
   * That was `Math.max(0, now - fetchedAt)`, so a reading stamped six hours
   * ahead came out as 0 and the card said "just now" about numbers of unknown
   * age. A clamp is a claim. We do not know how old that reading is, so the age
   * is null and the card draws no age at all -- which the contract has always
   * allowed by the contract. */
  const now = Date.now();
  const ahead: LimitsReport = {
    ok: true, email: ACCOUNT, plan: "Max", fetchedAt: now + 6 * 60 * MIN,
    windows: [{ label: "5 hours", pct: 99, resetsAt: null, severity: "normal" }],
  };
  const drawn = renderUsageCard(ahead, now);
  expect(drawn.html).toContain("99%");   // the numbers are still shown...
  expect(drawn.ageMs).toBeNull();        // ...with no claim at all about their age
  // and an ordinary reading still dates itself
  expect(renderUsageCard({ ...ahead, fetchedAt: now - 5 * MIN }, now).ageMs).toBe(5 * MIN);
});

/* -------------------------------- two engines, one machine, one ask */

test("two engines that know their account ask once between them", async () => {
  const m = await machine();
  const air = await m.engine("air");
  const work = await m.engine("work");
  await hasAskedBefore(m, air);
  await hasAskedBefore(m, work);

  m.boot(air);
  const [a] = await reads(1);
  m.boot(work);
  const [b] = await reads(1);
  expect(m.up.usage()).toBe(1);
  // and the one that did not ask is not showing a blank or an old card
  for (const r of [a, b]) {
    expect(r.ok).toBe(true);
    expect(r.stale).toBeUndefined();
    expect(r.windows![0].pct).toBe(13);
  }
});

test("the second engine takes the winner's answer rather than asking as well", async () => {
  /* THE LEASE, from the loser's side. The winner is mid-fetch: it holds the
   * lease and has just published. Without the lease this is two requests --
   * both engines look at a shared file and both conclude they must ask -- and
   * with it the loser waits, finds the answer, and sends nothing.
   *
   * The winner is a lease file and an entry rather than a second process,
   * because what the loser can see of the winner IS a lease file and an entry.
   * Both are stamped on this machine's clock, which is what `awaitShared` is
   * comparing against when it decides whether the answer it found is the one it
   * is waiting for. */
  const m = await machine();
  const air = await m.engine("air");
  const work = await m.engine("work");
  await hasAskedBefore(m, air);
  await hasAskedBefore(m, work);
  m.boot(air);
  await limitsNow();                       // the winner's reading, published
  expect(m.up.usage()).toBe(1);
  await m.clock.advance(60 * MIN);         // ...an interval on, so work is due

  const acct = await sharedFile(m.share);
  const at = m.clock.now();
  await writeFile(acct, JSON.stringify({
    at, report: { ok: true, email: ACCOUNT, plan: "Max", fetchedAt: at,
      windows: [{ label: "5 hours", pct: 55, resetsAt: null, severity: "normal" }] },
  }));
  /* ...and the winner is still holding the lease while work arrives.
   *
   * THE LEASE IS STAMPED ON THE WALL CLOCK, not on the test's, and that is not
   * an inconsistency to tidy away. A lease is a claim about a process that may
   * be running right now, so its staleness is deliberately the only thing here
   * that a test cannot fast-forward past: a stamp an hour in the "future" is
   * exactly the abandoned-lease case (proved below), not a live holder. */
  await writeFile(`${acct}.lease`, JSON.stringify({ pid: 999999, at: Date.now() }));

  m.boot(work);
  const [b] = await reads(1);
  expect(m.up.usage()).toBe(1);            // nothing left the machine
  expect(b.ok).toBe(true);
  expect(b.stale).toBeUndefined();         // it WAITED for the answer, it did not give up
  expect(b.windows![0].pct).toBe(55);
  /* AND IT WAITED RATHER THAN TAKING IT, which the numbers alone cannot tell
   * apart: an engine that stole the lease would have read the very same entry.
   * A lease this engine never held is a lease still sitting there afterwards. */
  expect(await Bun.file(`${acct}.lease`).exists()).toBe(true);
});

test("an engine that has been down takes the other one's numbers, not upstream's", async () => {
  /* The steady state, and the one the machine spends every quarter hour in.
   * One engine's phase comes first, so it is the one that asks; the other
   * arrives minutes later with its own reading long expired and finds the
   * machine's answer waiting for it. */
  const m = await machine();
  const air = await m.engine("air");
  const work = await m.engine("work");
  await hasAskedBefore(m, work, 60 * MIN); // down for an hour, or later in the cycle
  m.boot(air);
  await limitsNow();
  expect(m.up.usage()).toBe(1);

  m.boot(work);
  const [b] = await reads(1);
  expect(m.up.usage()).toBe(1);
  expect(b.ok).toBe(true);
  expect(b.stale).toBeUndefined();
  expect(b.windows![0].pct).toBe(13);
});

test("an engine that adopted a reading knows when the machine asked for it", async () => {
  /* Holding somebody else's numbers is holding WHEN THEY WERE TAKEN. Without
   * that the adopting engine's own gate never closes: its ask time is from an
   * interval ago, so every card read walks past it and goes back to the shared
   * file for an answer already in memory.
   *
   * Made visible by taking the shared file away afterwards. An engine that
   * recorded when the machine asked answers from what it holds; one that did
   * not goes upstream for numbers it already has. */
  const m = await machine();
  const air = await m.engine("air");
  const work = await m.engine("work");
  await hasAskedBefore(m, air);
  await hasAskedBefore(m, work);
  m.boot(air);
  await limitsNow();
  m.boot(work);
  const [b] = await reads(1);              // work adopts
  expect(m.up.usage()).toBe(1);
  expect(b.windows![0].pct).toBe(13);

  m.boot(work, { share: NO_SHARE });       // and now there is nothing to adopt from
  const [again] = await reads(1);
  expect(m.up.usage()).toBe(1);
  expect(again.windows![0].pct).toBe(13);
});

test("the refresh arrow never waits for a lease", async () => {
  /* THE BUTTON HE COMPLAINED ABOUT. A lease left by a process that died
   * mid-fetch is held until it goes stale, and a forced read used to sit in the
   * wait for it: eleven seconds against the card's twelve second allowance, and
   * then OLD numbers labelled "another engine on this machine is fetching". A
   * person pressing refresh gets a request, not a spinner. */
  const m = await machine();
  const air = await m.engine("air");
  await hasAskedBefore(m, air);
  m.boot(air, { leaseWaitMs: 5_000 });
  await limitsNow();                       // one reading, to name the file
  expect(m.up.usage()).toBe(1);

  const acct = await sharedFile(m.share);
  // fresh, so it will not be stolen: a holder that is one second into its fetch
  await writeFile(`${acct}.lease`, JSON.stringify({ pid: 999999, at: Date.now() }));

  const began = Date.now();
  const [r] = await reads(1, true);
  const took = Date.now() - began;
  expect(m.up.usage()).toBe(2);            // it asked
  expect(r.ok).toBe(true);                 // with real numbers, not a stale card
  expect(r.stale).toBeUndefined();
  expect(took).toBeLessThan(1_000);        // and did not sit in the wait
});

test("a winner that dies holding the lease does not get a second request sent", async () => {
  /* The bounded wait, reached on purpose: a lease taken a moment ago by a
   * process that will never publish. Waiting for ever would hang the card;
   * asking anyway would be the second request the lease exists to prevent. So
   * it shows what this engine already had, and says why it is old. */
  const m = await machine();
  const air = await m.engine("air");
  await hasAskedBefore(m, air);
  // the real wait is eleven seconds; nothing about this changes at forty ms
  m.boot(air, { leaseWaitMs: 40 });
  await limitsNow();                       // one real reading, to name the file
  expect(m.up.usage()).toBe(1);
  await m.clock.advance(60 * MIN);

  const acct = await sharedFile(m.share);
  await writeFile(`${acct}.lease`, JSON.stringify({ pid: 999999, at: Date.now() }));
  const [r] = await reads(1);
  expect(m.up.usage()).toBe(1);
  expect(r.stale).toBe(true);
  expect(r.error).toBe("another engine on this machine is fetching");
  expect(r.reason).toBe("network");        // never "signed out": we know nothing
});

test("a lease left behind by a dead engine is taken, not waited on", async () => {
  const m = await machine();
  const air = await m.engine("air");
  await hasAskedBefore(m, air);
  m.boot(air);
  await limitsNow();                       // makes the entry, so we know its name
  expect(m.up.usage()).toBe(1);
  await m.clock.advance(60 * MIN);

  // a lease nobody will ever release, older than any fetch could take
  const acct = await sharedFile(m.share);
  await writeFile(`${acct}.lease`,
    JSON.stringify({ pid: 999999, at: Date.now() - 10 * MIN }));
  const [r] = await reads(1);
  expect(m.up.usage()).toBe(2);
  expect(r.ok).toBe(true);
});

test("a lease stamped in the FUTURE is taken too, not honoured for ever", async () => {
  /* A lease from the future can never age out, so honouring it means every
   * engine on this machine waits for it for ever. Taking it costs one duplicate
   * request in the case where the holder really is alive with a fast clock. The
   * comment above this branch used to say the opposite of what the code did. */
  const m = await machine();
  const air = await m.engine("air");
  await hasAskedBefore(m, air);
  m.boot(air);
  await limitsNow();
  await m.clock.advance(60 * MIN);

  const acct = await sharedFile(m.share);
  await writeFile(`${acct}.lease`,
    JSON.stringify({ pid: 999999, at: Date.now() + 6 * 60 * MIN }));
  const [r] = await reads(1);
  expect(m.up.usage()).toBe(2);
  expect(r.ok).toBe(true);
});

test("what a crashed publisher left behind is swept, and what is being written is not", async () => {
  /* Every write here is to a temp name and then renamed, every lease claim is
   * to a temp name and then linked, and both are removed on the way out. A
   * process killed between the two steps leaves its temp file behind for ever:
   * one more file in a directory two unix accounts share, per crash, no upper
   * bound, in /Users/Shared where nothing else will ever tidy it.
   *
   * And the sweep has to be able to tell that from a file somebody is writing
   * RIGHT NOW, which is what the age is for. */
  const m = await machine();
  const air = await m.engine("air");

  const dead = join(m.share, "acct-dead.json.99999.tmp");
  const deadClaim = join(m.share, "acct-dead.json.lease.99999.claim");
  const inFlight = join(m.share, "acct-live.json.99998.tmp");
  for (const f of [dead, deadClaim, inFlight]) await writeFile(f, "x");
  const longAgo = new Date(Date.now() - 60 * MIN);
  await utimes(dead, longAgo, longAgo);
  await utimes(deadClaim, longAgo, longAgo);

  m.boot(air);
  await limitsNow();
  const left = await readdir(m.share);
  expect(left).not.toContain(basename(dead));
  expect(left).not.toContain(basename(deadClaim));
  expect(left).toContain(basename(inFlight));
});

test("a shared entry that is not a report is ignored, not reported as a refusal", async () => {
  /* Parsing is not understanding. `{at, report:{}}` used to come back as a
   * legitimate entry whose `ok` was falsy, and the reader turned that into
   * "rate limited" -- the card telling him he was being throttled on the
   * strength of a file that said no such thing. */
  const m = await machine();
  const air = await m.engine("air");
  const work = await m.engine("work");
  await hasAskedBefore(m, air);
  m.boot(air);
  await limitsNow();
  expect(m.up.usage()).toBe(1);

  const acct = await sharedFile(m.share);
  await writeFile(acct, JSON.stringify({ at: m.clock.now(), report: { hello: 1 } }));

  await hasAskedBefore(m, work);
  m.boot(work);
  const [b] = await reads(1);
  expect(m.up.usage()).toBe(2);            // nonsense means ask, not believe
  expect(b.ok).toBe(true);
  expect(b.error).toBeUndefined();
});

test("a 429 is published too, so the other engine does not repeat it", async () => {
  const m = await machine({ status: 429 });
  const air = await m.engine("air");
  const work = await m.engine("work");
  await hasAskedBefore(m, air);
  await hasAskedBefore(m, work);

  m.boot(air);
  await limitsNow();
  expect(m.up.usage()).toBe(1);
  m.boot(work);
  const [b] = await reads(1);
  expect(m.up.usage()).toBe(1);
  // it shows ITS OWN last-good numbers, not the other engine's, and says why
  expect(b.stale).toBe(true);
  expect(b.error).toBe("rate limited");
  expect(b.reason).toBe("throttled");
  expect(b.windows![0].pct).toBe(1);
});

test("a published failure with no reason on it is 'unknown', never 'signed out'", async () => {
  /* An entry written by an older build, or half understood. This used to fall
   * back to "rate limited", which is a specific and checkable claim about the
   * endpoint, so a file that said nothing made the card tell him he was being
   * throttled. What we actually know is that the machine's last attempt did not
   * work -- and the one thing we must never claim from a failure we did not
   * classify is that the account is logged out. */
  const m = await machine();
  const air = await m.engine("air");
  const work = await m.engine("work");
  await hasAskedBefore(m, air);
  m.boot(air);
  await limitsNow();                       // names the file

  const acct = await sharedFile(m.share);
  await writeFile(acct, JSON.stringify({
    at: m.clock.now(),
    report: { ok: false, fetchedAt: m.clock.now(), error: "something went wrong" },
  }));
  await hasAskedBefore(m, work);
  m.boot(work);
  const [b] = await reads(1);
  expect(m.up.usage()).toBe(1);            // it did not repeat the machine's failure
  expect(b.reason).toBe("unknown");
  expect(b.error).toBe("something went wrong");
  expect(b.stale).toBe(true);
  expect(b.windows![0].pct).toBe(1);       // its OWN last-good numbers
});

test("an hour of this Mac polling is eight requests, where it was two hundred and forty", async () => {
  /* THE NUMBER IN THE COMMIT MESSAGE, counted rather than reasoned about.
   *
   * An hour is four cycles (the grid test above), both engines take their turn
   * in every one, and the clock is moved by hand rather than by waiting an
   * hour. What it was: 30 polls an hour each, forced past every cache, two
   * requests a poll, two engines. 240. */
  const m = await machine();
  const air = await m.engine("air");
  const work = await m.engine("work");
  await hasAskedBefore(m, air);
  await hasAskedBefore(m, work);

  for (let cycle = 0; cycle < 4; cycle++) {
    m.boot(air);
    await limitsNow();
    m.boot(work);
    await limitsNow();
    await m.clock.advance(LIMITS_POLL_MS);
  }
  expect(m.up.usage()).toBe(4);  // four readings for the machine, one per cycle
  expect(m.up.hits()).toBe(8);   // and a reading is usage plus profile
});

test("an engine that has never learned its account asks for itself", async () => {
  /* THE BOOTSTRAP, and it is a cost rather than a bug. The shared entry is
   * keyed by account; an engine that has never had a profile call answered
   * cannot tell whether an entry it finds is even about the same plan, so it
   * asks once, learns, and joins. Two fresh engines therefore cost two
   * requests, once, ever. */
  const m = await machine();
  const air = await m.engine("air");
  const work = await m.engine("work");
  m.boot(air);
  await limitsNow();
  m.boot(work);
  await limitsNow();
  expect(m.up.usage()).toBe(2);

  // ...and from here they are one machine
  await m.clock.advance(60 * MIN);
  m.boot(air);
  await limitsNow();
  m.boot(work);
  await limitsNow();
  expect(m.up.usage()).toBe(3);
});

test("no shared directory means each engine asks, and nothing breaks", async () => {
  /* Sharing is an optimisation, never a dependency. Pointed at a path it cannot
   * create, an engine must still answer with real numbers. */
  const m = await machine();
  const air = await m.engine("air");
  const work = await m.engine("work");
  await hasAskedBefore(m, air);
  await hasAskedBefore(m, work);
  m.boot(air, { share: NO_SHARE });
  const [a] = await reads(1);
  m.boot(work, { share: NO_SHARE });
  const [b] = await reads(1);
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  expect(m.up.usage()).toBe(2);
});

test("no two engines ever hold the lease at once", async () => {
  /* THE LEASE ITSELF, RACED.
   *
   * `open(path,"wx")` followed by a write leaves the name existing and EMPTY
   * for the length of that write, and a reader landing in that window parses
   * nothing, concludes the holder is dead, unlinks a live claim and takes it.
   * What is needed to find it is ENOUGH ATTEMPTS: the old multi-process version
   * of this measured sixty-eight overlapping holds out of a few hundred claims
   * on code with no `link()` in it anywhere.
   *
   * WHAT IS ASSERTED IS OVERLAP, and here it is asserted EXACTLY rather than by
   * comparing millisecond timestamps. One event loop means one `holder`
   * variable, so a second claimant arriving while the first still holds it is
   * seen the instant it happens; there is nothing to infer and no clock
   * resolution to lose. Each holder yields several times while holding, which
   * is where a contender gets its chance.
   *
   * WHAT THIS CANNOT SEE, said plainly: real OS parallelism. Every contender
   * here shares one pid, so they share the `.claim` temp name too, and two
   * kernel threads never sit inside one syscall together. The multi-process
   * form of this test belongs in the process annex beside lock.test.ts, which
   * makes the same argument about the schedule lock. */
  const share = await tmpDir("cyc-limits-race-");
  resetShare({ dir: share });

  let holder: number | null = null;
  const overlaps: string[] = [];
  let holds = 0;

  const engine = async (who: number, rounds: number) => {
    for (let round = 0; round < rounds; round++) {
      let res: Awaited<ReturnType<typeof takeLease>> | null = null;
      /* A CONTENDED ROUND IS RETRIED, NOT SKIPPED. Giving up on `busy` means
       * the losers simply run out of rounds while the winner works, and the
       * sample is far too small to catch a race that needs a reader to land
       * inside a writer. Everybody keeps trying until they have had their turn. */
      for (let tries = 0; tries < 2000; tries++) {
        res = await takeLease(ACCOUNT);
        if (res.kind === "taken") break;
        await new Promise((r) => setTimeout(r, 0));
      }
      if (res?.kind !== "taken") continue;
      if (holder !== null) overlaps.push(`${who} took it while ${holder} held it`);
      holder = who;
      holds++;
      // somewhere for a contender to slip in, if one can
      for (let i = 0; i < 4; i++) await Promise.resolve();
      holder = null;
      await releaseLease(res.lease);
    }
  };

  await Promise.all(Array.from({ length: 8 }, (_, i) => engine(i, 20)));
  expect(overlaps).toEqual([]);
  expect(holds).toBe(8 * 20);  // it has to have actually raced
});

/* ---------------------------------------- the TYPED reason is honest (#602)
 *
 * The card branches on report.reason, not on the error STRING. limits.ts must
 * therefore MINT that reason at every origin, and it must never be "signed-out"
 * for a network failure -- the bug this fixes was a timeout to Anthropic
 * rendering as "not signed in". These drive REAL limitsNow against a fake
 * upstream (never the real usage endpoint) and assert both the reason on the
 * wire and the FACE renderUsageCard draws from it. Finding: the old
 * usage-card.test fed error:"engine unreachable", a string limits.ts never
 * produces, so the honesty bug lived under a green harness. */

test("a 5xx from the usage endpoint is reason:network and renders 'can't check', not 'not signed in'", async () => {
  const m = await machine({ status: 503 });
  const air = await m.engine("air");
  m.boot(air);
  const [r] = await reads(1, true);
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("network");                 // NOT signed-out
  const { html } = renderUsageCard(r, Date.now());
  expect(html).toContain("check right now");
  expect(html).not.toContain("not signed in");
});

test("a dead upstream (fetch fails / times out) is reason:network, never signed-out", async () => {
  const m = await machine();
  const air = await m.engine("air");
  m.boot(air);                       // for this machine's share dir and clock
  /* ...and then pointed at a port with nothing on it, so the fetch REJECTS
   * rather than answering. This is the shape a timeout to Anthropic has, and
   * it is the exact failure that used to render as "not signed in": an
   * assertion about his account made out of a dropped connection. */
  resetLimits({ apiBase: "http://127.0.0.1:1", credentialsFile: air.creds,
    seenFile: air.seen, now: () => m.clock.now() });
  const [r] = await reads(1, true);
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("network");
  const { html } = renderUsageCard(r, Date.now());
  expect(html).not.toContain("not signed in");
});

test("no token on this machine IS reason:signed-out and renders 'not signed in'", async () => {
  const m = await machine();
  const nobody = await m.signedOut("nologin");
  m.boot(nobody);
  const [r] = await reads(1, true);
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("signed-out");
  expect(m.up.usage()).toBe(0);                     // nothing was even attempted
  const { html } = renderUsageCard(r, Date.now());
  expect(html).toContain("not signed in");
});

test("the login on this machine is read from HOME when nothing overrides it", async () => {
  /* THE SHIPPED BRANCH on Linux, and the one the override exists to keep away
   * from. With no CYC_LIMITS_CREDENTIALS the token comes from
   * $HOME/.claude/.credentials.json -- which is why this file moves HOME before
   * any test runs, and why the harness refuses to start an engine whose
   * credentials file is not inside its own throwaway directory. */
  const m = await machine();
  const dir = join(FAKE_HOME, ".claude");
  await Bun.write(join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "home-token" } }));
  const seen = join(await tmpDir("cyc-limits-homeseen-"), "limits-seen.json");
  resetLimits({ apiBase: m.up.url, seenFile: seen, now: () => m.clock.now() });
  resetShare({ dir: m.share });
  const [r] = await reads(1);
  expect(r.ok).toBe(true);
  expect(r.windows![0].pct).toBe(13);
  const written = JSON.parse(await readFile(seen, "utf8"));
  expect(written.tokenHash)
    .toBe(createHash("sha256").update("home-token").digest("hex").slice(0, 16));
});

/* ------------------------------------------------- the token is the identity
 *
 * `state.account` is never cleared, which is right for a throttle and wrong
 * across a re-login: after a new sign-in the first failed ask would serve the
 * OLD account's numbers and email. The token arrives before the answer, so a
 * changed access token discards the previous reading before asking. (#577
 * section 1) */

test("a changed token discards the previous account before asking", async () => {
  const m = await machine();
  const air = await m.engine("air");
  m.boot(air);
  const [first] = await reads(1, true);
  expect(first.ok).toBe(true);
  expect(first.email).toBe(ACCOUNT);
  expect(m.up.usage()).toBe(1);

  // a re-login on this machine, and the new sign-in's first ask is refused
  await writeFile(air.creds,
    JSON.stringify({ claudeAiOauth: { accessToken: "a-different-token" } }));
  m.up.set({ status: 429 });
  const [second] = await reads(1, true);
  expect(m.up.usage()).toBe(2);
  /* The old account is gone: the refused ask does NOT serve the previous
   * account's numbers or email out of staleFrom. */
  expect(second.ok).toBe(false);
  expect(second.email).toBeUndefined();
  expect(second.windows).toBeUndefined();
});

test("the same token keeps the reading across a 429", async () => {
  const m = await machine();
  const air = await m.engine("air");
  m.boot(air);
  const [first] = await reads(1, true);
  expect(first.ok).toBe(true);
  expect(m.up.usage()).toBe(1);

  // same login, upstream now refuses: the last good reading stands, flagged
  m.up.set({ status: 429 });
  const [second] = await reads(1, true);
  expect(m.up.usage()).toBe(2);
  expect(second.ok).toBe(true);
  expect(second.stale).toBe(true);
  expect(second.email).toBe(ACCOUNT);
  expect(second.windows![0].pct).toBe(13);
});

test("the token hash survives a restart", async () => {
  const m = await machine();
  const air = await m.engine("air");
  m.boot(air);
  await limitsNow(true);
  const seen = JSON.parse(await readFile(air.seen, "utf8"));
  const want = createHash("sha256").update("token-for-air").digest("hex").slice(0, 16);
  expect(seen.tokenHash).toBe(want);

  // and the restarted engine reads it back rather than treating itself as new
  m.boot(air);
  m.up.set({ status: 429 });
  const [r] = await reads(1, true);
  expect(r.stale).toBe(true);              // the same token, so the reading stands
  expect(r.email).toBe(ACCOUNT);
});
