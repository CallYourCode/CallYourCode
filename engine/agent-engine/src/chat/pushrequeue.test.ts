/* THE NEVER-DROP RULE: a window that did not land is HELD, never dropped.
 *
 * flushBatch used to re-queue only when the fetch THREW (an unreachable server).
 * Two other losses looked like success and were not:
 *
 *   F2 (#537) a non-2xx RESPONSE -- a 401 from a dead or revoked engine token, a
 *   413 from an oversize batch -- only logged "batch REFUSED" and dropped the
 *   window, while the sessions stayed marked notified. The phone was then
 *   assumed to hold a banner it never got, silently and until the next unrelated
 *   change: an auth misconfig lost every banner for ever.
 *
 *   F3/F4 (#569) a 200 that reports it could NOT keep the whole window. The app
 *   server caps a batch (BATCH_ITEMS_MAX) and rate-limits an engine
 *   (PUSH_RATE_MAX) and says what it dropped as {truncated, dropped}. A 200 was
 *   read as full delivery, so a capped banner was lost exactly like a refused
 *   one.
 *
 * Both are losses exactly like an outage, so both take the outage's path: hold
 * the window and deliver it on the NEXT window, with no new reply to prod it.
 *
 * The old file booted an engine per case and slept out two ten second windows
 * per test to find out. Here the window is `await clock.advance(batchMs())`
 * against a real push sink that can be told to refuse, to cap, or to die.
 *
 *   bun test agent-engine/src/chat/pushrequeue.test.ts
 */

import { test, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { wireCore, type WireCore, type WireCoreOpts, wireId } from "../test-utils/wire-core.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until, settle } from "../test-utils/wait.ts";
import { onChat } from "./reply.ts";
import { batchMs, sendDismissal } from "./notify.ts";
import type { Sock } from "../transport/sock.ts";

const priorEnv = { NOTIFY_BATCH_MS: process.env.NOTIFY_BATCH_MS };
delete process.env.NOTIFY_BATCH_MS;

/* The engine says which loss path it took, in one greppable line, and that
 * sentence is half of what is under test: "dropped" and "held" are otherwise
 * indistinguishable from outside until the next window either does or does not
 * carry the banner. Swallowed unless SHOW_NOTIFY=1. */
const lines: string[] = [];
const real = { log: console.log, warn: console.warn, error: console.error };
const grab = (through: (...a: unknown[]) => void) => (...a: unknown[]) => {
  lines.push(a.map((x) => String(x)).join(" "));
  if (process.env.SHOW_NOTIFY) through(...a);
};
const saidSomething = (needle: string) => lines.some((l) => l.includes(needle));

let core: WireCore;
const HOUR = 60 * 60_000;
const BASE: WireCoreOpts = { with: ["notify", "frames"], askPollMs: HOUR, contextPollMs: HOUR };

beforeAll(() => {
  console.log = grab(real.log);
  console.warn = grab(real.warn);
  console.error = grab(real.error);
});
afterAll(() => {
  console.log = real.log;
  console.warn = real.warn;
  console.error = real.error;
  if (priorEnv.NOTIFY_BATCH_MS === undefined) delete process.env.NOTIFY_BATCH_MS;
  else process.env.NOTIFY_BATCH_MS = priorEnv.NOTIFY_BATCH_MS;
});
beforeEach(async () => {
  core = await wireCore(BASE);
  await until(() => core.sessions.size === 1, { what: "the pane to reconcile" });
  lines.length = 0;
});
afterEach(async () => { await core.stop(); });

const sink = () => core.pushSink!;
const session = () => core.byHandle(PANE)!;

function sessionSock(): Sock {
  return {
    data: {
      role: "session", sessionId: PANE, attached: null, visible: false, visibleAt: 0,
      beatMs: 0, gaps: [], lastFrame: 0, pongAt: 0, probeAt: 0, probeSeq: 0, cid: 0,
      openedAt: 0, tailing: null, terms: new Map(), remoteAddr: "127.0.0.1",
    },
    readyState: 1,
    send() {}, close() {}, remoteAddr: "127.0.0.1",
  } as unknown as Sock;
}

/** No client is connected, so an agent reply is unread with nobody watching:
 *  the engine queues a banner for the next window. */
async function say(text: string): Promise<void> {
  await onChat(sessionSock(), { text, msgId: crypto.randomUUID() });
}

/** One window. Returns how many POSTs the sink saw during it. A window the
 *  server refuses still counts as a POST attempt on the ENGINE's side but is
 *  never recorded by the sink, which is why both are asked separately. */
async function window(): Promise<void> {
  await core.clock.advance(batchMs());
  await settle();
}

/** One window that is expected to LAND: advance, then wait on the real POST. */
async function windowThatLands(): Promise<void> {
  const before = sink().batches.length;
  await core.clock.advance(batchMs());
  await until(() => sink().batches.length > before, { what: "the window to reach the sink" });
}

test("a batch the app server REFUSES (non-2xx) is re-queued and delivered next window", async () => {
  // the app server is up but refusing, as a dead or revoked engine token makes it
  sink().refuse(401);
  await say("held while the token was dead");

  await window();
  await until(() => saidSomething("[notify] batch REFUSED"),
    { what: "the engine to report the refusal" });
  expect(saidSomething("re-queued"),
    "a refused batch did not log a re-queue; the window was dropped on a non-2xx").toBe(true);
  expect(sink().batches,
    "a batch was recorded while the server was refusing every post").toHaveLength(0);
  // and the session is still marked notified, which is precisely why losing the
  // window would leave the phone assumed to hold a banner it never got
  expect(session().notified).toBe(true);

  /* The token is fixed. The banner the engine held must now go out ON ITS OWN,
   * with no new reply to prod it: it was never dropped. */
  sink().accept();
  await windowThatLands();
  expect(sink().hits, "exactly the held session should be delivered").toHaveLength(1);
  expect(sink().hits[0].unread,
    "the delivered banner carries the unread it was queued with").toBe(1);
});

test("a 401 on the batch drops the token, so the retry re-enrols", async () => {
  /* The other half of a 401: it is fresh evidence that this engine's token is
   * dead, so the next window must present a NEW one rather than the same
   * rejected string for ever. The sink issues a fresh scratch token per
   * enrolment, which is what makes the re-enrolment observable. */
  sink().refuse(401);
  await say("with a dead token");
  await window();
  await until(() => saidSomething("[notify] batch REFUSED"), { what: "the refusal" });
  /* The drop is a wiring seam rather than a log line: notify tells its host to
   * forget the token, and the host is what knows where the token lives. */
  expect(core.logs.some((l) => l.event === "app-token.dropped" && l.fields.why === "batch 401"))
    .toBe(true);

  sink().accept();
  await windowThatLands();
  expect(sink().enrolls.length).toBe(2);
  expect(sink().batches.at(-1)!.auth).toBe(sink().enrolls[1]);
});

test("a batch the app server 200s but reports it CAPPED is re-queued and delivered next window", async () => {
  // the server accepts (200) but says it kept nothing this window (rate-capped)
  sink().cap({ dropped: 1 });
  await say("held while the window was over the cap");

  await windowThatLands(); // the POST happens; it is the ANSWER that is partial
  await until(() => saidSomething("[notify] batch partly capped"),
    { what: "the engine to notice the cap" });
  expect(saidSomething("re-queued"),
    "a capped 200 did not log a re-queue; the window was assumed delivered").toBe(true);

  // the server now keeps the whole window; the held banner goes out on its own
  const before = sink().batches.length;
  sink().uncap();
  await core.clock.advance(batchMs());
  await until(() => sink().batches.length > before,
    { what: "the capped banner to be re-posted" });
  expect(sink().hits.some((h) => h.unread === 1),
    "the re-queued banner carries the unread it was queued with").toBe(true);
});

test("a truncated 200 is the same loss as a dropped one", async () => {
  /* Two different caps on the app server (per-batch size, per-engine rate) with
   * one rule between them: anything it did not KEEP is a loss. They are reported
   * as separate numbers and summed here, so a window that is half kept is still
   * retried whole rather than silently halved. */
  sink().cap({ truncated: 1 });
  await say("over the per-batch cap");
  await windowThatLands();
  await until(() => saidSomething("truncated=1"), { what: "the truncation report" });
  expect(saidSomething("re-queued")).toBe(true);

  const before = sink().batches.length;
  sink().uncap();
  await core.clock.advance(batchMs());
  await until(() => sink().batches.length > before, { what: "the retry" });
  expect(sink().hits.some((h) => h.unread === 1)).toBe(true);
});

test("an UNREACHABLE app server loses nothing either", async () => {
  /* The path that always worked, asserted beside the two that did not, because
   * one helper serves all three and a change to it must be caught here rather
   * than in production. The app server being down must never break a reply and
   * must never lose the flag. */
  await say("while the app server was down");
  sink().stop(); // the port goes away under the engine's feet

  await window();
  await until(() => saidSomething("[notify] batch FAILED, app server unreachable"),
    { what: "the engine to report the outage" });
  // the window is still held: the queue re-armed itself for the next boundary
  expect(core.clock.pending).toBeGreaterThan(0);
});

test("a dismissal in a refused window is held too, not just the banner", async () => {
  /* The window carries BOTH halves -- new messages and dismissals -- because the
   * device has to apply them in one order (dismiss, then show, then the floor).
   * A requeue that kept only the new items would leave a banner standing on his
   * phone for a chat he read, with nothing left to take it down. */
  await say("read me");
  await windowThatLands();
  expect(sink().hits).toHaveLength(1);

  sink().refuse(500);
  sendDismissal(session());
  await window();
  await until(() => saidSomething("[notify] batch REFUSED"), { what: "the refusal" });
  expect(sink().dismissals).toHaveLength(0);

  sink().accept();
  await windowThatLands();
  expect(sink().dismissals.map((d) => d.sessionId)).toEqual([`seam-host:${wireId(PANE)}`]);
});

test("a window refused twice is still held: retrying is not a one-shot", async () => {
  sink().refuse(503);
  await say("the app server is having a bad day");
  await window();
  await until(() => saidSomething("[notify] batch REFUSED"), { what: "the first refusal" });
  lines.length = 0;
  await window();
  await until(() => saidSomething("[notify] batch REFUSED"), { what: "the second refusal" });
  expect(sink().batches).toHaveLength(0);

  sink().accept();
  await windowThatLands();
  expect(sink().hits).toHaveLength(1);
  expect(sink().hits[0].unread).toBe(1);
});

test("a re-queued window merges with what arrived while it was held", async () => {
  /* The requeue writes back into the SAME map the live path queues into, keyed
   * per session, so a reply that landed during the outage does not become a
   * second entry and a second buzz. One chat, one item, and the count is the
   * freshest one. */
  sink().refuse(401);
  await say("the first");
  await window();
  await until(() => saidSomething("[notify] batch REFUSED"), { what: "the refusal" });

  await say("and one that landed while the server was down");
  sink().accept();
  await windowThatLands();
  expect(sink().batches).toHaveLength(1);
  expect(sink().batches[0].sessions).toBe(1);
  expect(sink().hits).toHaveLength(1);
  expect(sink().hits[0].unread).toBe(2);
});
