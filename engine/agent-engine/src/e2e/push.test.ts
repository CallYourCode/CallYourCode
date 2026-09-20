/* THE PUSH WIRE, AND THE PLAINTEXT LEAK IT MUST NEVER CARRY AGAIN.
 *
 * WHAT THE BOOT IS BUYING. sealpush.test.ts proves the crypto (a session key off
 * the newest content generation seals {title, body, count}); notify-unit proves
 * the decision. Neither can reach the thing that actually leaked, because the
 * leak was not in the seal and not in the decision: it was in `pushWire`, the
 * one line that assembles what leaves the process. `pushWire` returned
 * `{...base, kid, enc}`, so the real title and body rode in the CLEAR beside the
 * sealed blob, and every hop between here and the phone -- the app server, the
 * push transport -- could read them. The comment above both call sites already
 * claimed the wire carried a generic fallback. The code did not.
 *
 * The only place that claim can be checked is a captured HTTP body: what a
 * booted engine POSTed to the app server, taken at the sink. Everything else is
 * an assertion about an intermediate value. So this file boots an engine, gets a
 * real batch onto the aligned window, and reads the bytes:
 *
 *   the visible title/body are "CallYourCode" / "New message", the exact strings
 *   the app service worker and the app server already fall back to for a keyless
 *   push, and the reply text is recoverable ONLY by opening `enc` with the
 *   engine's own content key.
 *
 * The batching and the dismissal ride the same boot because they are the same
 * window: one post per aligned window carrying every session that moved, and a
 * read here taking the banner down there.
 *
 * Sources carried across: notify.test.ts ("nobody attached: decided at once,
 * sent on the next aligned window", "one push carries every session that moved
 * in the window", "a chat read here takes its banner down there, and only if one
 * is up", "a sealed push wire body/title are the generic fallback, not the input
 * text", and the bounded-preview-inside-enc half), unread.test.ts (the count on
 * the push is the count on the row), pushrequeue.test.ts (the never-drop rule
 * when the server refuses).
 *
 *   bun test --preload ./e2e/testpreload.ts e2e/push.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { openSealedClient, startEngine, hasE2ETransport, PANE, BATCH_MS as WINDOW, type Engine } from "./harness.ts";
import { loadOrCreateE2E, newestGen } from "../security/sec.ts";
import { deriveSessionKey, openPush } from "../../../shared/e2e.ts";

let engine: Engine | null = null;
afterEach(async () => {
  await engine?.stop();
  engine = null;
});

async function until<T>(f: () => T | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`never happened within ${ms}ms: ${what}`);
    await Bun.sleep(50);
  }
}

const reply = (session: WebSocket, text: string) => {
  const at = Date.now();
  session.send(JSON.stringify({ t: "chat", text, msgId: crypto.randomUUID() }));
  return at;
};
const pushed = (e: Engine, at: number) => e.sink.hits.filter((h) => h.at >= at);
const dismissed = (e: Engine, at: number) => e.sink.dismissals.filter((d) => d.at >= at);

/* Open a captured wire hit's `enc` with the engine's OWN content key, which is
 * the whole point: if the reply is recoverable this way and no other, the wire
 * carried nothing a keyless reader could show. */
async function openSealedHit(e: Engine, hit: { sessionId: string; enc?: string }) {
  const st = await loadOrCreateE2E(join(e.dir, "data", "keys.json"));
  const kS = await deriveSessionKey(newestGen(st).key, hit.sessionId);
  return openPush(kS, hit.enc ?? "") as Promise<{ title: string; body: string; count: number }>;
}

// Uses openSealedClient (below), so it needs the e2e transport preload
// (`bun run test:e2e`); under a bare `bun test` it skips. See hasE2ETransport.
test.skipIf(!hasE2ETransport)("no app attached: one batched push on the aligned window, its title and body the generic fallback and the reply only inside enc, and a read takes the banner down", async () => {
  engine = await startEngine();
  const e = engine;
  const session = await e.session();

  /* SENT AT MID-WINDOW ON PURPOSE, which is what makes the alignment assertion
   * mean anything. A timer started by the message fires half a window PAST the
   * next boundary; an aligned one fires ON it. Sent at an arbitrary moment the
   * two are only sometimes distinguishable, and this test used to pass by luck
   * whenever the reply happened to land near a boundary itself. */
  await Bun.sleep((WINDOW * 1.5 - (Date.now() % WINDOW)) % WINDOW);

  /* A random secret, so "the text is not on the wire" is a claim about THIS
   * reply and cannot be satisfied by an engine that happens to send some other
   * string. Two replies in the one window, because the batch is one buzz for the
   * window and the count on it has to be both. */
  const secret = `leak-check-${crypto.randomUUID()}`;
  const newest = `${secret} again`;
  const at = reply(session, secret);
  reply(session, newest);

  const hit = await until(() => pushed(e, at)[0], WINDOW + 8_000,
    "the batch to reach the sink");

  /* ------------------------------------------- decided at once, sent on the window */

  expect(e.since(at).some((l) => l.includes("[notify] send")),
    "the decision is immediate; only the SENDING waits for the window").toBe(true);
  const why = e.since(at).find((l) => l.includes("[notify] send") || l.includes("[notify] suppress")) ?? "";
  expect(why).toContain("no client attached");
  // ...and the window is the WALL CLOCK'S, not one started by this message
  expect(hit.at % WINDOW,
    `the push landed ${hit.at % WINDOW}ms into a ${WINDOW}ms window. The reply went out at ` +
    `${at % WINDOW}ms, so a timer started by the message would land about there and an ` +
    "aligned window lands on the boundary. Half a window apart is the whole difference.")
    .toBeLessThan(WINDOW / 4);

  // one buzz for the window, whatever moved in it: two replies, one chat, one entry
  const mine = e.sink.batches.filter((b) => b.at >= at);
  expect(mine.length, "two replies in one window must be ONE post, not two buzzes").toBe(1);
  expect(mine[0].sessions).toBe(1);
  expect(hit.unread, "the count on the push is the engine's own read-marker count").toBe(2);

  /* ---------------------------------- THE LEAK: what a keyless hop can read */

  expect(hit.body, "the reply text rode the wire in plaintext").toBe("New message");
  expect(hit.title, "the session title rode the wire in plaintext").toBe("CallYourCode");
  expect(hit.body).not.toContain(secret);
  expect(hit.body).not.toContain("leak-check");
  expect(hit.title).not.toContain("leak-check");
  // ...and nothing else in the whole window carries it either
  for (const h of e.sink.hits) {
    expect(h.body, "the reply text appears on some other item in the window").not.toContain(secret);
    expect(h.title ?? "", "the reply text appears in some other item's title").not.toContain(secret);
  }
  // the clear fields that are cleartext BY DESIGN still ride, so the app server
  // can route and count without the key
  /* NAMESPACED host:pane, not the bare pane. Pane ids repeat across machines
   * (every herdr has a w9:p4) and the app knows this chat by an id of its own,
   * so both sides agree on host:pane as the notification's identity. Without it
   * opening the chat looked for a tag that did not exist and the banner stayed
   * up. `probe` is the ENGINE_HOST the harness boots with. The pane's half is
   * the AGENT id the wire lists the chat under, never the pane handle. */
  const agentId = await e.wireIdOf(PANE);
  expect(hit.sessionId).toBe(`probe:${agentId}`);
  expect(hit.kid, "without a kid no device can pick the generation to decrypt with").toBeTruthy();
  expect(hit.enc).toBeTruthy();

  /* ...AND THE REAL PREVIEW IS IN THERE, which is the other half. A wire that
   * carried the fallback and nothing else would pass every assertion above and
   * deliver a phone that can never show what was said. */
  const opened = await openSealedHit(e, hit);
  /* THE NEWEST of the window, not the first: one item per session collapses to
   * the latest message with the count beside it, which is what a banner reading
   * "2 messages" and showing the last one means. */
  expect(opened.body, "the sealed preview is not the newest reply of the window").toBe(newest);
  expect(opened.count, "the count inside the seal must agree with the count outside it")
    .toBe(hit.unread!); // asserted to be 2 above, so never undefined here
  expect(opened.title, "the real session title rides inside the seal").toBeTruthy();

  /* ------------------------------- a read here takes the banner down there */

  /* Opening no longer marks read on its own (pointer-pages, DECISIONS.md #3):
   * the marker advances when the app REPORTS progress, and reaching zero unread
   * with a banner up is what takes it down. */
  const reader = Date.now();
  const { ws } = await openSealedClient(e);
  ws.send(JSON.stringify({ t: "attach", id: agentId, since: 0 }));
  await Bun.sleep(200);
  ws.send(JSON.stringify({ t: "progress", id: agentId, seq: 1e9 }));
  const gone = await until(() => dismissed(e, reader)[0], WINDOW + 8_000,
    "the dismissal to ride the next window out to the sink");
  /* THE SAME IDENTITY THE BANNER WAS TAGGED WITH. A dismissal under any other
   * spelling is a phone hunting for a tag that does not exist, and the banner
   * stays up. */
  expect(gone.sessionId, "the dismissal does not name the id the push was tagged with")
    .toBe(hit.sessionId);

  /* AND ONLY IF ONE IS UP. Reading it again has nothing standing on the phone to
   * remove, and proving that negative means sitting through a whole window
   * rather than returning early. */
  const again = Date.now();
  ws.send(JSON.stringify({ t: "progress", id: agentId, seq: 1e9 }));
  await Bun.sleep(WINDOW + 1_000);
  expect(dismissed(e, again).length,
    "a second read sent a dismissal for a banner that was already down").toBe(0);
  ws.close();
}, 90_000);

test("a long reply is bounded inside enc, and a window the app server refuses is held rather than dropped", async () => {
  engine = await startEngine();
  const e = engine;
  const session = await e.session();

  /* THE NEVER-DROP RULE (F2, #537). flushBatch used to re-queue only when the
   * fetch THREW. A non-2xx response -- a 401 from a revoked engine token, a 413
   * from an oversize batch -- only logged "batch REFUSED" and dropped the
   * window, while the sessions stayed marked notified: the phone was then
   * assumed to be holding a banner it never got. A refusal is only a refusal
   * once a real server has answered one, which is why this needs the sink and
   * the boot rather than a stub around flushBatch. */
  /* THE OTHER HALF OF A 401, AND IT IS A DIFFERENT SENTENCE. The never-drop rule
   * is about the WINDOW; this is about the TOKEN. A 401 is the app server saying
   * the engine's token is dead or revoked, so the engine must throw it away and
   * enrol again -- and then the retry has to go out under the NEW one, or the
   * held window is retried for ever against a credential the server has already
   * rejected once. enroll.test.ts covers the signature, the token file and
   * enrollOnce against a stub; none of that can see a live engine reacting to a
   * refusal, which is why the whole flow lives here beside the boot. */
  const original = e.sink.enrolls[0];
  expect(original, "the engine never enrolled at all, so there is no token to revoke")
    .toBeTruthy();

  e.sink.refuse(401);

  // far longer than a preview, so the bound is exercised in the same reply
  const long = "L".repeat(5_000);
  const at = reply(session, long);

  await until(
    () => e.since(at).some((l) => l.includes("[notify] batch REFUSED") && l.includes("re-queued")),
    WINDOW + 8_000, "the refused window to be logged as re-queued rather than dropped");
  expect(e.sink.batches.filter((b) => b.at >= at).length,
    "a batch was recorded while the server was refusing every post").toBe(0);

  /* DROPPED AND RE-ENROLLED, on the engine's own initiative. The sink issues a
   * fresh token per enrolment, so a second entry here IS the re-enrolment: an
   * engine that kept the rejected token would never post to /engines/enroll
   * again and this list would stay one long. */
  await until(() => e.sink.enrolls.length > 1, WINDOW + 8_000,
    "the refused engine to drop its token and enrol again");
  expect(e.since(at).some((l) => l.includes("[enroll] token rejected")),
    "the engine did not say out loud that it had thrown the rejected token away").toBe(true);
  expect(e.sink.enrolls.at(-1), "the app server handed back the same token it had just refused")
    .not.toBe(original);

  // the token is fixed: the held banner must go out on its own, with no new
  // reply to prod it, because it was never dropped
  e.sink.accept();
  const hit = await until(() => pushed(e, at)[0], WINDOW + 8_000,
    "the held banner to arrive after the server recovered");
  expect(hit.unread, "the delivered banner carries the unread it was queued with").toBe(1);

  /* AND THE HELD WINDOW WENT OUT UNDER A TOKEN THIS SERVER ISSUED, never the
   * revoked one. This is the assertion the whole re-enrolment is for: a retry
   * that still bears the rejected credential is a banner that can never land,
   * however patiently it is re-queued.
   *
   * MEMBERSHIP RATHER THAN THE LAST ISSUED ONE, and the difference is a real
   * behaviour rather than looseness: every refused window 401s, and every 401
   * drops the token again, so a refusal lasting several windows mints several
   * tokens and which of them the landing batch carries depends on where the
   * boundary fell. What must be true of all of them is that the sink issued it
   * and that it is not the one the sink refused. */
  const landed = e.sink.batches.filter((b) => b.at >= at);
  expect(landed.length, "the held window never reached the sink at all").toBeGreaterThan(0);
  expect(landed[0].auth, "the retried push still bore the token the server had refused")
    .not.toBe(original);
  expect(e.sink.enrolls, "the retried push bore a token this app server never issued")
    .toContain(landed[0].auth);

  /* THE BOUND APPLIES INSIDE THE SEAL, and only there. The wire body is the
   * generic fallback whatever the reply's length, so the 2000-char head the app
   * shows is a fact about the sealed payload now. */
  expect(hit.body, "a 5000-char reply put its head on the wire in plaintext").toBe("New message");
  expect(hit.title).toBe("CallYourCode");
  const opened = await openSealedHit(e, hit);
  expect(opened.body, "the sealed preview was not the bounded head of the reply")
    .toBe(long.slice(0, 2_000));

  /* A 200 THAT KEPT ONLY PART OF THE WINDOW (F3/F4, #569). The app server bounds
   * a batch (BATCH_ITEMS_MAX) and rate-limits an engine (PUSH_RATE_MAX), and
   * reports what it did not keep as {truncated, dropped}. A 200 used to be read
   * as full delivery and the window dropped, so a capped banner was silently
   * lost while the session stayed marked notified. It has to take the same
   * never-drop path as a refusal, and only a real POST/response pair can say
   * which path it took. */
  e.sink.cap({ dropped: 1 });
  const at2 = reply(session, "held while the window was over the cap");
  await until(
    () => e.since(at2).some((l) => l.includes("[notify] batch partly capped") && l.includes("re-queued")),
    WINDOW + 8_000, "the capped 200 to be logged as re-queued rather than assumed delivered");

  const before = e.sink.batches.filter((b) => b.at >= at2).length;
  e.sink.uncap();
  await until(() => e.sink.batches.filter((b) => b.at >= at2).length > before, WINDOW + 8_000,
    "the capped banner to be re-posted once the cap cleared");
  expect(e.sink.hits.some((h) => h.sessionId && h.at >= at2),
    "the re-queued banner never arrived: a capped 200 was treated as delivered").toBe(true);
}, 90_000);
