/* A BUSY VOICE ENGINE MUST NOT FAIL A VOICE NOTE (#stt-busy).
 *
 * WHY THIS FILE EXISTS
 *
 * 2026-09-28: the owner sent two BZ Builder voice notes, seven and ten seconds
 * long, while a 166.6 s upload had the voice engine's three batch slots full.
 * The engine answers 503 the instant its slots are taken (#551), and the rescue
 * treated that 503 as "could not read the clip": one two-second try, then
 * `rescue.failed` and "(voice note: transcription failed)" into the agent, for a
 * note it could have read perfectly a few seconds later once a slot freed. The
 * owner's OWN note nine seconds afterwards, once the engine was free, transcribed
 * fine on the first try -- so nothing was wrong with the clips.
 *
 * THE FIX transcribe.ts's sttFetch waits a busy engine out: a 503 is logged as
 * `stt.queued` / `stt.retry`, backed off on the injected clock, and retried until
 * a slot frees or the decode deadline runs out -- and only then does the
 * placeholder stand. This file drives exactly that: the fake answers the first
 * two POSTs with the real "voice engine busy" 503, and the note still arrives
 * with its words and never a placeholder.
 *
 * THE NUMBERS ARE ADVANCED, NOT WAITED. transcribe.ts takes its clock in its
 * deps bag, so the backoff between retries is `core.clock.advance(...)` and no
 * wall time is spent (the same seam rescue-timeout.test.ts leans on).
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";

import { cacheAudio } from "./clips.ts";
import { inOrder, injectUserMessage, onUtterance } from "./deliver.ts";
import { initTranscribe, STT_BUSY_BACKOFF_MIN_MS } from "../voice/transcribe.ts";
import { restoredChats, sessionByHandle, sessions, type Session } from "../sessions/session-state.ts";
import { broadcast } from "../transport/wire.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { fakeVoice, type FakeVoice } from "../test-utils/fake-voice.ts";
import { until } from "../test-utils/wait.ts";
import { wireCore, type FakeClient, type WireCore, wireId } from "../test-utils/wire-core.ts";

let core: WireCore;
let voice: FakeVoice;
let client: FakeClient;

function pointTranscribeAtFake(): void {
  initTranscribe({
    voiceUrl: () => voice.voiceUrl(),
    log: (e, f) => core.log(e, f),
    broadcast: (m) => broadcast(m),
    inOrder: (id, f) => inOrder(id, f),
    deliver: (s, opts) => injectUserMessage(s as Session, opts),
    sessionOf: (id) => sessions.get(id),
    clock: core.clock,
  });
}

beforeAll(async () => {
  voice = fakeVoice({ transcript: "the note the engine was too busy to read at first" });
  core = await wireCore({ with: ["delivery"] });
  await until(() => core.sessions.size === 1, { what: "the pane to reconcile" });
  pointTranscribeAtFake();
  client = core.client({ attach: PANE });
});

afterAll(async () => {
  await core?.stop();
  voice?.stop();
});

afterEach(() => {
  client.clear();
  voice.reset();
  voice.sttBusy = 0;
  core.logs.length = 0;
  core.submitted.length = 0;
});

const linesFor = (cid: string) => core.logs.filter((l) => l.fields.cid === cid);
const has = (cid: string, event: string) => linesFor(cid).some((l) => l.event === event);
const rowFor = (cid: string) => sessionByHandle(PANE)?.chat.find((m) => m.cid === cid);
const cidOf = (what: string) => `c-${what}-${Math.random().toString(36).slice(2, 7)}`;

/** A stored recording and the frame the app sends for a note it could not read
 *  itself: empty text, the kind, and the msgId /user-audio answered with. */
async function storedNote(): Promise<string> {
  const msgId = crypto.randomUUID();
  const bytes = new Uint8Array(4096).fill(0x33);
  await cacheAudio(msgId, bytes, "audio/webm");
  return msgId;
}
const wordless = (msgId: string, cid: string) =>
  ({ t: "utterance", id: wireId(PANE), text: "", kind: "voice", msgId, durationS: 7, cid });

test("a note the engine was busy for waits its turn and arrives with its words", async () => {
  /* The first two POSTs are refused with the real "voice engine busy" 503; the
   * third, once a slot has freed, decodes. The note must ride that out. */
  voice.sttBusy = 2;
  const cid = cidOf("busy");
  const msgId = await storedNote();

  void onUtterance(client.sock, wordless(msgId, cid));

  // The first 503 is logged as a queue wait, NOT a failure: nothing is delivered
  // and no placeholder is written while the engine is merely busy.
  await until(() => has(cid, "stt.queued"), { what: "the first 503 to be logged as a queue wait" });
  expect(has(cid, "rescue.failed"),
    "a busy engine (503) was treated as a decode failure, the exact bug: a note the engine " +
    "could read a moment later was failed on the first try").toBe(false);
  expect(has(cid, "utterance.rescue-failed"),
    "the placeholder path ran while the engine was only busy, not unable").toBe(false);

  // Back off and retry: still busy, so a second 503 -> stt.retry.
  await core.clock.advance(STT_BUSY_BACKOFF_MIN_MS);
  await until(() => has(cid, "stt.retry"), { what: "the second 503 to be logged as a retry" });

  // The slot frees; the next retry decodes and the note arrives with its words.
  await core.clock.advance(STT_BUSY_BACKOFF_MIN_MS * 2);
  await until(() => core.submitted.length > 0,
    { what: "the note to reach the pane once the engine was free" });
  // submitted flips inside injectUserMessage, before the row is committed; wait
  // on the row being FILLED rather than reading it in the gap between the two.
  await until(() => rowFor(cid)?.text === "the note the engine was too busy to read at first",
    { what: "the note's row to be filled with the decoded words" });

  const row = rowFor(cid);
  expect(row, "the note was lost rather than waiting out the busy engine").toBeTruthy();
  expect(row!.text,
    "the note arrived as the placeholder even though the engine read it on a retry")
    .toBe("the note the engine was too busy to read at first");
  expect(row!.text).not.toBe("(voice note: transcription failed)");
  expect(row!.msgId, "the note kept its audio").toBe(msgId);

  // Exactly the two refusals, then one real decode: no placeholder, no giving up.
  expect(voice.sttBusyServed, "the engine did not refuse the two POSTs the test set up").toBe(2);
  expect(voice.stt.length, "the clip was decoded more or fewer times than the one success").toBe(1);
  expect(has(cid, "rescue.failed"), "the note was failed despite eventually decoding").toBe(false);
  expect(core.submitted[0].text).toContain("the note the engine was too busy to read at first");
});

test("a note delivered whole with no 503 in the way logs no queue wait at all", async () => {
  /* The control: with the engine free, the ordinary path is untouched -- no
   * stt.queued, no stt.retry, the note straight through. A queue wait logged
   * here would mean the retry path fires on every note, not only busy ones. */
  const cid = cidOf("free");
  const msgId = await storedNote();
  await onUtterance(client.sock, wordless(msgId, cid));

  await until(() => core.submitted.length > 0, { what: "the note to reach the pane" });
  expect(has(cid, "stt.queued"), "a free engine still logged a queue wait").toBe(false);
  expect(has(cid, "stt.retry"), "a free engine still logged a retry").toBe(false);
  expect(rowFor(cid)!.text).toBe("the note the engine was too busy to read at first");
});
