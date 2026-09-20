/* THE RESCUE DECODE IS BOUNDED, AND A LONG NOTE IS NOT A FROZEN BUBBLE.
 *
 * WHY THIS FILE EXISTS (F2, #449/#458)
 *
 * transcribeStored POSTs a wordless note's clip to the voice engine's /stt and
 * the delivery awaits it, so the whole note waits on that one fetch. The fetch
 * had NO timeout. When the voice engine dropped the connection mid-decode --
 * exactly what a 30 minute note did before the memory fix, launchd killing the
 * process under it -- or simply stopped answering, the promise never settled and
 * the note hung for ever: no delivery, no chat row, no failure line.
 *
 * Two bounds answer that, and this file is about both:
 *
 *   RESCUE_INLINE_MS  how long DELIVERY waits before it stops holding the note.
 *                     Under it, a short note is delivered whole. Over it, the
 *                     note is SHOWN at once with the audio safe and its
 *                     transcript pending, and delivered to the agent ONCE when
 *                     the decode lands (#458). One note, one turn.
 *   RESCUE_STT_TIMEOUT_MS  the never-hang-for-ever backstop on the fetch itself.
 *                     Past it the request aborts, the rescue is logged as
 *                     failed, and the note is completed with the honest
 *                     placeholder the app can retry.
 *
 * THE SHIPPED NUMBERS ARE THE ONES UNDER TEST. The old version of this file set
 * RESCUE_INLINE_MS=300 and RESCUE_STT_TIMEOUT_MS=2000 in the engine's
 * environment, so it proved the MECHANISM against numbers the product does not
 * ship: an eight second hold and a fifteen minute backstop were never exercised
 * by anything. transcribe.ts now takes its clock in its deps bag, so every
 * deadline below is the constant the engine ships, advanced on a manual clock,
 * with no wall time spent at all.
 *
 * HOW THE DECODE IS HELD: through voiceUrl(), which in production is a health
 * probe across the listed voice engines and really can take time (it is the
 * queue wait tts.ts measures separately for exactly this reason). Holding it
 * there rather than in the fake gives a decode that has not STARTED, which is
 * what makes "the inline deadline fired first" a fact rather than a race with a
 * localhost fetch that answers in a millisecond.
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { join } from "node:path";

import { cacheAudio, clipOnDisk } from "./clips.ts";
import { inOrder, injectUserMessage, onUtterance } from "./deliver.ts";
import { initTranscribe, RESCUE_INLINE_MS, RESCUE_STT_TIMEOUT_MS } from "../voice/transcribe.ts";
import { restoredChats, resolveSession, sessions, type Session } from "../sessions/session-state.ts";
import { broadcast } from "../transport/wire.ts";
import { PANE, defaultSessionIdOf } from "../test-utils/fake-herdr.ts";
/* The harness id the fake herdr reports for PANE: the key a row keeps after
 * its pane is gone (a handle lookup is alive-only). */
const PANE_SID = defaultSessionIdOf(PANE);
import { fakeVoice, type FakeVoice } from "../test-utils/fake-voice.ts";
import { until } from "../test-utils/wait.ts";
import { wireCore, type FakeClient, type WireCore, wireId } from "../test-utils/wire-core.ts";

let core: WireCore;
let voice: FakeVoice;
let client: FakeClient;

/** Opened by the test when it wants the decode to actually start. */
let openVoice: () => void = () => {};
let voiceGate: Promise<void> = Promise.resolve();
const holdVoice = () => { voiceGate = new Promise<void>((r) => { openVoice = r; }); };

function pointTranscribeAtFake(): void {
  initTranscribe({
    voiceUrl: async () => { await voiceGate; return voice.base; },
    log: (e, f) => core.log(e, f),
    broadcast: (m) => broadcast(m),
    inOrder: (id, f) => inOrder(id, f),
    deliver: (s, opts) => injectUserMessage(s as Session, opts),
    sessionOf: (id) => sessions.get(id),
    restoredChats: () => restoredChats,
    clock: core.clock,
  });
}

beforeAll(async () => {
  voice = fakeVoice({ transcript: "the long note transcript arrives after a while" });
  core = await wireCore({ with: ["delivery"] });
  await until(() => core.sessions.size === 1, { what: "the pane to reconcile" });
  pointTranscribeAtFake();
  client = core.client({ attach: wireId(PANE) });
});

afterAll(async () => {
  openVoice();
  await core?.stop();
  voice?.stop();
});

afterEach(() => {
  openVoice();
  voiceGate = Promise.resolve();
  voice.mode = "NORMAL";
  voice.reset();
  client.clear();
  core.logs.length = 0;
  core.submitted.length = 0;
});

const linesFor = (cid: string) => core.logs.filter((l) => l.fields.cid === cid);
const has = (cid: string, event: string) => linesFor(cid).some((l) => l.event === event);
// resolveSession by the harness id, not sessionByHandle: the handle lookup is
// alive-only, and one test below turns the row dead on purpose
const rowsFor = (cid: string) => resolveSession(PANE_SID)!.chat.filter((m) => m.cid === cid);
const cidOf = (what: string) => `c-${what}-${Math.random().toString(36).slice(2, 7)}`;

/** A stored recording, and the frame the app sends for one it could not read. */
async function storedNote(): Promise<string> {
  const msgId = crypto.randomUUID();
  const bytes = new Uint8Array(2048).fill(0x42);
  await cacheAudio(msgId, bytes, "audio/webm");
  return msgId;
}
const wordless = (msgId: string, cid: string) =>
  ({ t: "utterance", id: wireId(PANE), text: "", kind: "voice", msgId, durationS: 900, cid });

test("a short note is delivered whole, inline, with no pending bubble at all", async () => {
  /* THE CONTROL, and this file needs one: every case below drives the pending
   * path, so all of them would pass on an engine that showed EVERY note pending
   * and completed it a moment later -- which would put a second, empty bubble
   * in front of him for every voice note he sends. */
  const cid = cidOf("short");
  const msgId = await storedNote();
  await onUtterance(client.sock, wordless(msgId, cid));

  expect(has(cid, "utterance.shown-pending"),
    "a note whose decode came back at once was still shown as pending").toBe(false);
  expect(rowsFor(cid).length, "one note, more than one row").toBe(1);
  expect(rowsFor(cid)[0].text).toBe("the long note transcript arrives after a while");
  expect(rowsFor(cid)[0].transcriptPending).toBeUndefined();
  expect(core.submitted.length, "one note, more than one turn at the agent").toBe(1);
});

test("a long note is shown at once, then completes THAT message in ONE delivery", async () => {
  const cid = cidOf("pending");
  const msgId = await storedNote();
  holdVoice();

  /* Not awaited: this delivery is about to be held for eight logical seconds,
   * and the assertions below are about what he can see WHILE it is held. */
  const delivery = onUtterance(client.sock, wordless(msgId, cid));
  await until(() => has(cid, "rescue.start"), { what: "the rescue decode to be started" });

  /* THE SHIPPED EIGHT SECONDS, to the millisecond. One before the deadline the
   * note is still being held; on the deadline it is shown. A test that only
   * advanced "past" the number would pass on any smaller one. */
  await core.clock.advance(RESCUE_INLINE_MS - 1);
  expect(has(cid, "utterance.shown-pending"),
    `the note was shown ${RESCUE_INLINE_MS - 1}ms in, before the inline deadline`).toBe(false);
  await core.clock.advance(1);
  await until(() => has(cid, "utterance.shown-pending"),
    { what: "the long note to be shown with its transcript pending" });

  /* SHOWN, WITH THE AUDIO SAFE AND NO WORDS YET, and nothing delivered to the
   * agent: he sees the bubble, the agent sees nothing until it is whole. */
  const shown = rowsFor(cid);
  expect(shown.length, "the note was shown as more than one bubble").toBe(1);
  expect(shown[0].msgId, "the shown note lost its audio").toBe(msgId);
  expect(shown[0].text, "the shown note already had words; it should be pending").toBe("");
  expect(shown[0].transcriptPending, "the shown note was not marked transcript-pending").toBe(true);
  expect(core.submitted.length, "a placeholder turn was delivered to the agent").toBe(0);
  expect(client.of("chat").some((f) => f.cid === cid && f.transcriptPending === true),
    "the pending bubble was never broadcast, so his phone shows nothing at all").toBe(true);

  // ...and now the decode lands and COMPLETES that same row
  openVoice();
  await delivery;
  await until(() => core.submitted.length === 1, { what: "the completed note to reach the agent" });
  // rescue.completed is logged only AFTER completePendingVoiceNote's fire-and-
  // forget delivery has fully returned; submitted flips mid-delivery, so wait
  // on the terminal signal too or the note's own async tail outlives the test.
  await until(() => has(cid, "rescue.completed"), { what: "the completion to settle" });

  const done = rowsFor(cid);
  expect(done.length, "the completion appended a second bubble instead of filling the note")
    .toBe(1);
  expect(done[0].text).toBe("the long note transcript arrives after a while");
  expect(done[0].transcriptPending, "the pending flag was left set after completion")
    .toBeUndefined();
  expect(done[0].msgId, "the completion dropped the audio").toBe(msgId);

  /* EXACTLY ONE DELIVERY for one note: the completion, not a
   * placeholder turn and then a real one. The agent must read a voice note
   * once, whole, and never have to un-remember an empty one. */
  const delivered = linesFor(cid).filter((l) => l.event === "utterance.delivered");
  expect(delivered.length, "the agent got more than one turn for one voice note").toBe(1);
  expect(delivered[0].fields.completing, "the delivery was not the completion of the shown row")
    .toBe(true);
  expect(core.submitted[0].text).toContain("the long note transcript arrives after a while");
  expect(has(cid, "rescue.completed")).toBe(true);
});

test("a hanging voice engine is bounded, and the note arrives with the placeholder", async () => {
  /* A LIVE, REACHABLE ENGINE THAT HAS WEDGED: the request is accepted, the body
   * is read, and no answer ever comes. Nothing fails fast; only the bound ends
   * the wait, which is the whole reason it exists. */
  voice.mode = "HANGING";
  const cid = cidOf("timeout");
  const msgId = await storedNote();
  const t0 = Date.now();

  void onUtterance(client.sock, wordless(msgId, cid));
  await until(() => has(cid, "rescue.start"), { what: "the rescue decode to start" });

  // the inline deadline passes first: the note is shown rather than held
  await core.clock.advance(RESCUE_INLINE_MS);
  await until(() => has(cid, "utterance.shown-pending"),
    { what: "the wedged note to be shown pending" });

  /* THE FIFTEEN MINUTE BACKSTOP, on the shipped constant. One millisecond
   * short of it the fetch is still in flight; on it, it aborts. */
  await core.clock.advance(RESCUE_STT_TIMEOUT_MS - RESCUE_INLINE_MS - 1);
  expect(has(cid, "rescue.failed"),
    "the fetch aborted before the bound; a decode that is merely slow would be killed")
    .toBe(false);
  await core.clock.advance(1);
  await until(() => has(cid, "rescue.failed"),
    { what: "the bounded fetch to abort", timeoutMs: 5000 });

  // and the note still ARRIVES, as the honest placeholder the app can retry.
  // The keystrokes reach the pane first (submitted); the row is committed only
  // after deliverToPane's post-enter consumption check, so wait for the row to
  // be FILLED rather than reading it in the gap between the two.
  await until(() => core.submitted.length === 1, { what: "the bounded note to reach the agent" });
  await until(() => rowsFor(cid)[0]?.text === "(voice note: transcription failed)",
    { what: "the pending note to be filled with the placeholder" });
  const row = rowsFor(cid);
  expect(row.length).toBe(1);
  expect(row[0].text,
    "the note did not arrive with the retry placeholder after the rescue timed out")
    .toBe("(voice note: transcription failed)");
  expect(row[0].msgId,
    "the note lost its audio; the clip is on disk and the msgId is valid").toBe(msgId);
  expect(row[0].transcriptPending, "the bubble was left pending for ever").toBeUndefined();
  expect(has(cid, "rescue.failed-late"),
    "nothing said the pending note completed on a failed decode").toBe(true);

  /* NO WALL TIME WAS SPENT. Fifteen minutes of logical time passed; if any of
   * it had been real this line could not run. */
  expect(Date.now() - t0,
    "the bound was waited out on the wall clock rather than advanced").toBeLessThan(10_000);
});

test("a completion the session will not take leaves the pending bubble standing", async () => {
  /* The other end of #458: the note was SHOWN, so the audio and the bubble are
   * already his; if the pane has gone by the time the decode lands, the words
   * cannot be delivered and nothing may be silently marked done. The row stays
   * pending on purpose, because a restart re-drives exactly those rows. */
  const cid = cidOf("undelivered");
  const msgId = await storedNote();
  holdVoice();
  void onUtterance(client.sock, wordless(msgId, cid));
  await until(() => has(cid, "rescue.start"), { what: "the rescue decode to start" });
  await core.clock.advance(RESCUE_INLINE_MS);
  await until(() => has(cid, "utterance.shown-pending"), { what: "the note to be shown" });

  // the pane goes while the decode is still running
  resolveSession(PANE_SID)!.alive = false;
  openVoice();
  await until(() => has(cid, "rescue.complete-undelivered"),
    { what: "the completion to report that it could not be delivered" });

  expect(core.submitted.length, "words were typed into a pane that is gone").toBe(0);
  const row = rowsFor(cid)[0];
  expect(row.transcriptPending,
    "the row was marked done for a completion nobody received, so the restart sweep will " +
    "never re-drive it and the words are gone").toBe(true);
  expect(row.msgId, "the shown note lost the audio it was shown with").toBe(msgId);
  resolveSession(PANE_SID)!.alive = true;
});

test("the clip a pending note was shown with is still on disk when the words arrive", async () => {
  /* The promise the pending bubble makes: the AUDIO is safe from the moment the
   * note is shown, whatever happens to the transcript. It is the one copy of
   * that recording anywhere. */
  const cid = cidOf("audio-safe");
  const msgId = await storedNote();
  holdVoice();
  const delivery = onUtterance(client.sock, wordless(msgId, cid));
  await until(() => has(cid, "rescue.start"), { what: "the rescue decode to start" });
  await core.clock.advance(RESCUE_INLINE_MS);
  await until(() => has(cid, "utterance.shown-pending"), { what: "the note to be shown" });

  /* And it has already been ADOPTED into its agent's own directory: the message
   * committed to this session before the row was written, so the clip is filed
   * under the agent from the moment the bubble exists rather than left in the
   * staging area a sweep looks at. */
  const path = await clipOnDisk(msgId);
  expect(path, "the note was shown with a msgId whose clip is not on disk anywhere").toBeTruthy();
  expect(path!.startsWith(join(core.dir, "agents")),
    `the shown note's clip is still at ${path}, outside its agent's own audio dir`).toBe(true);

  openVoice();
  await delivery;
  await until(() => core.submitted.length === 1, { what: "the completion" });
  // submitted flips inside injectUserMessage, before it returns; wait on the
  // terminal rescue.completed so the note's fire-and-forget completion is fully
  // settled before teardown (else its trailing D().log lands on a torn-down
  // deliver as "deliver not initialised").
  await until(() => has(cid, "rescue.completed"), { what: "the completion to settle" });
  expect(await Bun.file(path!).exists(), "completing the note took its audio away").toBe(true);
});
