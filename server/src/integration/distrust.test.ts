/* THE APP SERVER DOES NOT BLINDLY TRUST AN ENGINE (#325, item 9).
 *
 * The agent engine is public by design: it runs on someone's own laptop and is
 * infinitely modifiable, so a modified or buggy one must not be able to harm
 * this server, the app, or another user through what it POSTs. The two endpoints
 * an engine calls are /push/notify and /push/batch, and everything an engine
 * feeds either of them is bounded the way the page's own /report already is.
 *
 * Each test FEEDS the server the hostile shape and proves it is bounded AND that
 * a legitimate engine's ordinary traffic is untouched (no false positives). The
 * observable is the app-server log: the brief's rule, and this codebase's, is
 * that a refusal must SAY so rather than pass a silent 200. The caps a real
 * fleet would never reach are dialled down by env so a test can cross them
 * without five thousand requests, the way CYC_LOG_* do for logbook.test.ts.
 *
 *   bun test app-server/distrust.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrolledBearer } from "../test-support/enrollkit";

type Server = { url: string; dir: string; stop: () => Promise<void> };
let servers: Server[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const s of servers) await s.stop();
  servers = [];
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});

async function startServer(extra: Record<string, string> = {}): Promise<Server> {
  const dir = await mkdtemp(join(tmpdir(), "cyc-distrust-"));
  dirs.push(dir);
  const port = 9100 + Math.floor(Math.random() * 300);
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../bootstrap/server.ts")], {
    env: {
      ...process.env,
      APP_PORT: String(port),
      APP_HOST: "127.0.0.1",
      DIST_DIR: dir,
      PUSH_FILE: join(dir, "push-subs.json"),
      SETTINGS_FILE: join(dir, "app-settings.json"),
      REPORTS_DIR: join(dir, "reports"),
      // a dead voice engine so no test ever puts load on a real kokoro
      VOICE_ENGINES: "http://127.0.0.1:1|http://127.0.0.1:1|none",
      ENGINE_TOKENS_FILE: join(dir, "engine-tokens.json"),
      // the log this test reads its evidence from lives in the temp dir; nothing
      // here can reach .run/logs
      CYC_LOG_DIR: join(dir, "logs"),
      ...extra,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${url}/settings`).then((r) => r.ok).catch(() => false)) break;
    await Bun.sleep(100);
    if (i === 79) throw new Error("app server did not start");
  }
  const s = { url, dir, stop: async () => { proc.kill(); await proc.exited; } };
  servers.push(s);
  /* The push routes require an ISSUED engine token now, so
   * each spawned server gets one scratch enrolled engine, and post() below
   * bears its token automatically. The distrust claims are all about what an
   * AUTHENTICATED but modified/hostile engine can do to this server. */
  bearers.set(url, (await enrolledBearer(url)).bearer);
  return s;
}

const bearers = new Map<string, { authorization: string }>();
const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST",
    headers: { "content-type": "application/json", ...(bearers.get(new URL(url).origin) ?? {}) },
    body: JSON.stringify(body) });

/* The log is flushed on a 250ms timer, so a read waits for the line to land
 * rather than racing it. Returns the whole file, or "" if nothing is there yet. */
async function readLog(s: Server): Promise<string> {
  return readFile(join(s.dir, "logs", "app-server.log"), "utf8").catch(() => "");
}
async function waitForLog(s: Server, needle: string, ms = 3000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const log = await readLog(s);
    if (log.includes(needle) || Date.now() > deadline) return log;
    await Bun.sleep(50);
  }
}

/* ------------------------------------------------------------------ the body
 *
 * The POST cap is a MEMORY BACKSTOP against a modified engine, not a content
 * limit: the real engine already sends a preview body, so legitimate traffic
 * sits far under 4 MB, and only a body no honest engine produces is refused.
 * Getting this wrong the other way -- a cap just above one reply -- 413s a real
 * long message and, on the batch path, loses the whole window. So the two things
 * proved here are that realistic traffic passes UNTOUCHED and that a genuinely
 * hostile body is still refused and logged. */
test("a realistic long reply and a busy batch window pass; a hostile body is refused", async () => {
  const s = await startServer();

  /* A ~65 KB single reply: a file dump or a long doc. Under the old 64 KB cap
   * this 413'd and the notification was dropped. It must go through now. */
  const long = await post(`${s.url}/push/notify`, { sessionId: "example:w1:p1", body: "x".repeat(65_000) });
  expect(long.status, "a 65 KB reply was refused").toBe(200);
  expect((await long.json() as any).ok).toBe(true);

  /* A busy 10s window: a dozen sessions each carrying several KB. This crossed
   * the old 64 KB cap and 413'd the ENTIRE batch, losing every session in it. */
  const busy = Array.from({ length: 12 }, (_, i) => ({ sessionId: `w:p${i}`, body: "y".repeat(5_000), unread: 1 }));
  const batch = await post(`${s.url}/push/batch`, { host: "macbook-air", new: busy });
  expect(batch.status, "a busy but legitimate batch window was refused").toBe(200);

  const clean = await readLog(s);
  expect(clean, "legitimate traffic tripped the refusal log").not.toContain("push.refused");

  /* THE BACKSTOP still bites a body no real engine produces: over 4 MB. */
  const hostile = await post(`${s.url}/push/notify`, { sessionId: "s", body: "z".repeat(4 * 1024 * 1024 + 1_000) });
  expect(hostile.status, "a > 4 MB body was not refused").toBe(413);
  expect((await hostile.json() as any).error).toBe("too large");

  const log = await waitForLog(s, "push.refused");
  expect(log, "a hostile oversize body was dropped without a word in the log").toContain("push.refused");
}, 30_000);

/* ------------------------------------------------------------ the session id
 *
 * The session id keys three in-memory maps and is forwarded to devices. A real
 * one is host:pane; a modified engine could send megabytes. It is bounded to the
 * same 200 chars the page's own /push/session uses. */
test("an over-long session id is bounded before it is stored or logged", async () => {
  const s = await startServer();

  const huge = "s".repeat(300); // logbook would keep up to 400, so 300 tells sliced from not
  await post(`${s.url}/push/notify`, { sessionId: huge, body: "b", unread: 1 });

  const log = await waitForLog(s, "push.notify");
  const m = log.match(/push\.notify\b.*?\bsession=([A-Za-z0-9]+)/);
  expect(m, "no push.notify line carried a session field").not.toBeNull();
  expect(m![1].length, "the session id reached the log un-bounded").toBeLessThanOrEqual(200);

  /* NO FALSE POSITIVE: a real host:pane id is kept whole. */
  await post(`${s.url}/push/notify`, { sessionId: "example:w9:p4", body: "b", unread: 1 });
  const log2 = await waitForLog(s, "example:w9:p4");
  expect(log2).toContain("session=example:w9:p4");
}, 30_000);

/* ------------------------------------------------- the badge bookkeeping maps
 *
 * pending / outNew / outDismiss are keyed by an engine-supplied session id, so
 * an engine naming a fresh chat every message would grow them without bound.
 * Past the cap a new chat is not tracked, and the log says which map filled. */
test("an engine cannot grow the badge maps without bound (notify), and says when it stops", async () => {
  const s = await startServer({ CYC_TRACKED_CHATS_MAX: "3" });

  // three distinct chats fit
  for (const id of ["a1", "a2", "a3"]) {
    await post(`${s.url}/push/notify`, { sessionId: id, body: "b", unread: 1 });
  }
  // updating one already tracked is always allowed, never a refusal
  await post(`${s.url}/push/notify`, { sessionId: "a2", body: "b", unread: 5 });
  let log = await readLog(s);
  expect(log, "a chat within the cap, or an update to a tracked one, was refused")
    .not.toContain("push.tracking.full");

  // the fourth distinct chat is over the cap: not tracked, and the log says so
  await post(`${s.url}/push/notify`, { sessionId: "a4", body: "b", unread: 1 });
  log = await waitForLog(s, "push.tracking.full");
  expect(log, "a fresh chat past the cap was tracked anyway").toContain("push.tracking.full");
  expect(log).toContain("map=pending");
}, 30_000);

/* --------------------------------------------------------------- the batch
 *
 * One window from one host carries a handful of chats. A modified engine POSTing
 * a giant `new` array must not make this server loop over all of it: it is cut
 * to the cap, and the cut is logged with how many were kept. */
test("a giant batch array is cut to the cap, and the cut is stated", async () => {
  const s = await startServer({ CYC_BATCH_ITEMS_MAX: "2" });

  const many = Array.from({ length: 5 }, (_, i) => ({ sessionId: `b${i}`, body: "hi", unread: 1 }));
  const res = await post(`${s.url}/push/batch`, { host: "macbook-air", new: many });
  expect(res.status).toBe(200);

  const log = await waitForLog(s, "push.batch.truncated");
  expect(log, "an oversize batch was processed whole").toContain("push.batch.truncated");
  expect(log, "the batch was logged as truncated but not actually cut").toContain("keptNew=2");
  expect(log).toContain("sentNew=5");

  /* NO FALSE POSITIVE: a batch at or under the cap is never called truncated. */
  const s2 = await startServer({ CYC_BATCH_ITEMS_MAX: "2" });
  await post(`${s2.url}/push/batch`, {
    host: "work",
    new: [{ sessionId: "w1", body: "hi", unread: 1 }, { sessionId: "w2", body: "hi", unread: 1 }],
  });
  const log2 = await waitForLog(s2, "push.batch", 1500);
  expect(log2).toContain("push.batch");
  expect(log2, "a two-item batch under a cap of two was called truncated")
    .not.toContain("push.batch.truncated");
}, 30_000);

/* ---------------------------------------------------------------- rate limit
 *
 * An engine that pushes without pause would reach the phone at whatever rate it
 * decided, which is exactly what the app's batching exists to prevent. The
 * per-engine cap (PUSH_RATE_MAX = 100 messages/minute, a constant in server.ts,
 * so this test hardcodes it) bounds that: over the cap the surplus is dropped,
 * with ONE log line for the whole window rather than one per dropped message,
 * and the server never crashes -- every POST still answers 200. */
test("a flood past the per-minute cap is dropped, forwarding at most the cap, with one log line", async () => {
  const s = await startServer();
  const CAP = 100; // PUSH_RATE_MAX in server.ts

  // One engine (one origin, 127.0.0.1) fires far more than a minute's worth in
  // a single burst. Every request must be answered, never dropped on the floor.
  const FLOOD = CAP + 40;
  let statuses = new Set<number>();
  for (let i = 0; i < FLOOD; i++) {
    const r = await post(`${s.url}/push/notify`, { sessionId: `flood:${i}`, body: "b", unread: 1 });
    statuses.add(r.status);
  }
  expect([...statuses], "a flooded server answered something other than 200 to every POST")
    .toEqual([200]);

  const log = await waitForLog(s, "push.rate.limited");

  // Exactly the cap is forwarded: one push.notify line per message that got through.
  const forwarded = (log.match(/push\.notify\b/g) ?? []).length;
  expect(forwarded, `the cap is ${CAP} but ${forwarded} messages were forwarded`).toBe(CAP);

  // And the drop is ONE line for the window, not one per dropped message.
  const dropLines = (log.match(/push\.rate\.limited\b/g) ?? []).length;
  expect(dropLines, "a flood of dropped messages should log once per window, not per message")
    .toBe(1);
}, 30_000);

/* ------------------------------------------------------- the 200 is honest
 *
 * A capped batch still answers 200, but the engine used to read that as "all
 * delivered" and drop the surplus from its own window -- a banner silently lost
 * (#569). The response now states what this window did NOT keep: `truncated`
 * (over the per-batch cap) and `dropped` (over the per-minute rate cap), so the
 * engine can requeue exactly that surplus. Disjoint, and both zero on a clean
 * window so an honest engine is never told to resend. */
test("the 200 reports what the batch cap truncated, so nothing is assumed delivered", async () => {
  const s = await startServer({ CYC_BATCH_ITEMS_MAX: "2" });
  const many = Array.from({ length: 5 }, (_, i) => ({ sessionId: `b${i}`, body: "hi", unread: 1 }));
  const res = await post(`${s.url}/push/batch`, { host: "macbook-air", new: many });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.truncated, "three of five items were over the cap of two").toBe(3);
  expect(body.dropped, "the rate cap was nowhere near, so nothing is rate-dropped").toBe(0);

  // a window inside the cap is told it lost nothing
  const clean = await post(`${s.url}/push/batch`, {
    host: "macbook-air",
    new: [{ sessionId: "c1", body: "hi", unread: 1 }, { sessionId: "c2", body: "hi", unread: 1 }],
  });
  const cleanBody = await clean.json() as any;
  expect(cleanBody.truncated).toBe(0);
  expect(cleanBody.dropped).toBe(0);
}, 30_000);

test("the 200 reports what the per-minute rate cap dropped", async () => {
  const s = await startServer();
  const CAP = 100; // PUSH_RATE_MAX in server.ts
  const OVER = 40;
  // one batch, one origin (127.0.0.1), more messages than a minute allows and
  // still under the per-batch cap (200), so the loss is the rate cap alone
  const many = Array.from({ length: CAP + OVER }, (_, i) => ({ sessionId: `r${i}`, body: "hi", unread: 1 }));
  const res = await post(`${s.url}/push/batch`, { host: "work", new: many });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.truncated, "the batch was under the per-batch cap of 200").toBe(0);
  expect(body.dropped, `${CAP + OVER} in one window over a cap of ${CAP} drops ${OVER}`).toBe(OVER);
}, 30_000);
