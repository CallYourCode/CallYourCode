/* THE CRON LADDER MUST NOT DOUBLE A STRANDED SCHEDULED MESSAGE.
 *
 * This is the mirror, on the cron/agent path, of delivery-guard.test.ts's double-type guard for
 * the user path: a stranded body typed on the first attempt must be submitted by
 * its retry, not typed a second time. It exists because the delivery id keying
 * has a hole the user-path tests cannot reach.
 *
 * THE HOLE. The stranded-body note in the pane is keyed by a delivery id, and
 * the enter-only dedupe believes a note only for the SAME id. A user send
 * carries a durable cid the app resends unchanged, so its retry keys on the same
 * id and dedupes. A cron send has no cid: it flows through deliverToAgent, which
 * used to mint a FRESH synthetic id on every call. The schedules ladder retries
 * a stranded occurrence at +30s (nextTryAt), well inside the 60s stranded TTL,
 * so that retry hit a note it had itself stranded seconds earlier -- but under a
 * different id, so the note was disbelieved, the body was TYPED AGAIN onto the
 * stranded one, and the agent read the scheduled message doubled.
 *
 * THE FIX, proven here end to end through the REAL schedules store and the REAL
 * delivery seam (fake herdr): the occurrence mints ONE delivery id when it fires
 * and the ladder threads it through every retry; deliverToAgent honours the id it
 * is handed and mints only when there is none. So the +30s retry keys on the
 * same id as the strand, believes the note, and presses enter only.
 *
 * FAIL-BEFORE (executed): revert deliverToAgent to per-call minting
 * (`const deliveryId = newCid("agent")`) and the retry types the body a second
 * time -- `herdr.texts.length` is 2, not 1. Restored.
 *
 *   bun test agent-engine/src/chat/cron-ladder.test.ts
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { join } from "node:path";

import { deliverToAgent } from "./deliver.ts";
import { unsubmitted } from "./pane-deliver.ts";
import { wireCore, type WireCore } from "../test-utils/wire-core.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";
import { manualClock } from "../runtime/clock.ts";
import { Schedules, singleFileLayout, type Deliver } from "../plugins/crons/schedules.ts";

/* The delivery timings, shortened at file scope (wall-clock by nature; the
 * adapter reads them on every use). The TTL is generous: the two schedule ticks
 * below each drive a full deliver with its settles, and the whole ladder must
 * run inside one TTL so the +30s retry still finds the strand believable. */
const ENV: Record<string, string> = {
  DELIVER_SETTLE_MS: "5",
  CONFIRM_SETTLE_MS: "5",
  RESTRAND_SETTLE_MS: "20",
  STRANDED_TTL_MS: "10000",
};
const priorEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) { priorEnv[k] = process.env[k]; process.env[k] = v; }
});
afterAll(() => {
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

let core: WireCore | null = null;
let stores: Schedules[] = [];
afterEach(async () => {
  for (const st of stores.splice(0)) st.stop();
  await until(() => true); // let the fire-and-forget lock release land
  await core?.stop();
  core = null;
});

/* A claude input box that still holds the body: the screen pane.read answers
 * after a stranded enter, and the pre-read the retry then believes as content. */
const STRANDED_BOX = ["(transcript)", "", "─".repeat(60),
  "❯ the stranded scheduled body is still sitting right here in the box",
  "─".repeat(60), "  model · ctx 1%"].join("\n");

test("the schedules ladder retries a stranded occurrence enter-only, not doubled", async () => {
  core = await wireCore({ with: ["delivery"] });
  const c = core;
  await until(() => c.sessions.size === 1, { what: "the pane to reconcile" });
  const sess = [...c.sessions.values()][0];
  expect(sess, "the wiring reconciled no session to deliver a cron into").toBeDefined();

  /* THE OCCURRENCE'S FIRST ENTER STRANDS. One-shot: the enter succeeds but does
   * not submit, the body stays in the box, and pane.read answers a box that
   * still holds it. The +30s retry below then presses enter only. */
  c.hooks.strandNextEnter!(sess.muxHandle, STRANDED_BOX);

  /* The ladder, over the REAL store: its `deliver` is the same shape the crons
   * plugin wires (host.deliver -> deliverText -> deliverToAgent), threading the
   * occurrence's stable delivery id straight into deliverToAgent. */
  const sawIds: string[] = [];
  const deliver: Deliver = async (sc, fire) => {
    sawIds.push(fire.deliveryId);
    const res = await deliverToAgent(sess, {
      how: "SCHEDULED", note: sc.name, text: sc.body, deliveryId: fire.deliveryId,
    });
    return { ok: res.ok, why: res.why, retriable: res.retriable };
  };

  const start = 1_700_000_000_000;
  const clock = manualClock(start);
  const dir = await tmpDir("cyc-cron-ladder-");
  const store = new Schedules({ files: singleFileLayout(join(dir, "schedules.json")), deliver, clock });
  stores.push(store);
  await store.load();

  const due = start + 60_000; // create refuses a time already past, so due is ahead
  await store.create({ agent: sess.agent.id, name: "standup", body: "write the standup",
    kind: "once", at: due, tz: "UTC" });

  // T0: the occurrence fires and strands. The deliver comes back retriable, so
  // the ladder arms a retry at +30s (nextTryAt).
  clock.setNow(due);
  await store.tick();
  expect(c.herdr.texts.length, "the first attempt never typed the body into the pane").toBe(1);
  expect(c.submitted.length, "the stranded enter submitted the body when it should not have").toBe(0);
  // the note is kept, keyed on the occurrence's delivery id (what the retry believes)
  expect(unsubmitted.get(sess.muxHandle)?.deliveryId,
    "the stranded note was not kept under the occurrence's delivery id").toBe(sawIds[0]);

  // +30s: the SAME occurrence retries. The strand hook is spent, so this enter
  // submits -- and because it keys on the SAME delivery id, the note is believed
  // and the body is submitted enter-only, never typed a second time.
  clock.setNow(due + 30_000);
  await store.tick();

  expect(sawIds.length, "the occurrence was not retried at +30s").toBe(2);
  expect(sawIds[0], "the ladder minted a fresh id for the retry instead of carrying the occurrence's")
    .toBe(sawIds[1]);
  expect(c.herdr.texts.length,
    "the retry typed the scheduled body a SECOND time onto the stranded one; the agent reads it " +
    "doubled. The +30s retry must key on the occurrence's delivery id and press enter only.")
    .toBe(1);
  /* AND THE AGENT ACTUALLY GOT IT, exactly once. Counting what was typed cannot
   * tell a delivery from an enter at an empty box; only this can. */
  expect(c.submitted.length, `the agent received ${c.submitted.length} scheduled messages, not one`)
    .toBe(1);
  expect(c.submitted[0].text).toContain("write the standup");
}, 30_000);
