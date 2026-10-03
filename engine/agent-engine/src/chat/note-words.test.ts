/* A VOICE NOTE WITH A REPLY QUOTE OR A CAPTION IS FILLED BY THE ENGINE ("note-words").
 *
 * Before this, only an EMPTY-bodied voice note could be sent at once and read
 * here: a note that answered a quote, or had typed words beside it, had to
 * carry its body on the wire, so the composer waited for the device's own
 * decoder before it sent (field log 2026-10-03 dev=726ju: send pressed four
 * times, three ignored, the note went 3.7 s later with "> Done. Only worldwide
 * remote roles..." baked in). Now that note ships at once with its body
 * written around ONE marker naming the frame's own cid, and the engine puts
 * the note's words there from its own copy of the clip. This file pins:
 *
 *   1. quote + marker, with the device's settled words: ONE /stt call for the
 *      tail only, and the agent reads "> quote\n\n<settled tail>" -- the exact
 *      shape the waiting send produced;
 *   2. marker + caption, no partial: the whole clip is read, words then caption;
 *   3. the decode fails: the placeholder goes where the words would be, the
 *      quote stays, and no marker ever reaches the pane;
 *   4. a long note: shown at once, completed ONCE with quote + words, and the
 *      body it fills is cleared from the row with the pending flag;
 *   5. after a restart the re-drive completes the same note with its quote;
 *   6. a marker naming the cid on a TEXT frame is his typing, left alone.
 *
 * WHAT IS REAL: the delivery path from the client frame down (onUtterance ->
 * the clip guard -> the rescue decode -> injectUserMessage -> the real pane),
 * the clip store, and the chat log. The fake is the decoder (fake-voice).
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";

import { cacheAudio } from "./clips.ts";
import { logChat, stampTs } from "./chatlog.ts";
import { inOrder, injectUserMessage, onUtterance } from "./deliver.ts";
import { initTranscribe, sweepPendingTranscripts, RESCUE_INLINE_MS, NOTE_UNREAD,
  wordsToken } from "../voice/transcribe.ts";
import { restoredChats, resolveSession, sessions, type Session } from "../sessions/session-state.ts";
import { broadcast } from "../transport/wire.ts";
import { PANE, defaultSessionIdOf } from "../test-utils/fake-herdr.ts";
import { fakeVoice, type FakeVoice } from "../test-utils/fake-voice.ts";
import { until } from "../test-utils/wait.ts";
import { wireCore, type FakeClient, type WireCore, wireId } from "../test-utils/wire-core.ts";

const PANE_SID = defaultSessionIdOf(PANE);

let core: WireCore;
let voice: FakeVoice;
let client: FakeClient;

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
  voice = fakeVoice({ transcript: "the words the engine read" });
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
const rowsFor = (cid: string) => resolveSession(PANE_SID)!.chat.filter((m) => m.cid === cid);

const QUOTE = "> Done. Only worldwide remote roles count now.";

async function park(seed: number): Promise<string> {
  const bytes = new Uint8Array(4096);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed) & 0xff;
  const msgId = crypto.randomUUID();
  await cacheAudio(msgId, bytes, "audio/webm");
  return msgId;
}

/** The frame the composer sends for a quoted or captioned note on an engine
 *  that can "note-words": its body around one marker naming its own cid. */
const noted = (msgId: string, cid: string, body: string,
  partials?: { id: string; text: string; upToS: number }[]) =>
  ({ t: "utterance", id: wireId(PANE), text: body, kind: "voice", msgId, durationS: 12, cid,
     words: [cid], ...(partials ? { partials } : {}) });

test("a quoted note: the words go under the quote, and only the tail is decoded", async () => {
  const msgId = await park(1);
  const cid = crypto.randomUUID();
  const settled = "This is not what I requested.";
  voice.transcript = "You did not have to narrow down anywhere.";

  await onUtterance(client.sock, noted(msgId, cid, `${QUOTE}\n\n${wordsToken(cid)}`,
    [{ id: cid, text: settled, upToS: 6 }]));
  await until(() => core.submitted.length > 0, { what: "the note to reach the pane" });

  expect(voice.stt.length, `the engine made ${voice.stt.length} /stt calls, not one`).toBe(1);
  expect(voice.stt[0].offset,
    "the engine re-read audio the device had already turned into words").toBe("6");

  const want = `${QUOTE}\n\n${settled} ${voice.transcript}`;
  const row = rowsFor(cid);
  expect(row.length, "one note, more than one row").toBe(1);
  expect(row[0].text,
    "the agent-visible text is not the quote then the words, the shape a waiting send produced")
    .toBe(want);
  expect(row[0].msgId, "the note lost its audio").toBe(msgId);
  expect(row[0].kind).toBe("voice");
  expect(core.submitted[0].text).toContain(want);
  expect(core.submitted[0].text, "a words marker reached the pane").not.toContain("{{cyc-words:");
  expect(core.submitted.length, "one note, more than one turn at the agent").toBe(1);
  expect(has(cid, "words.note-filled")).toBe(true);
});

test("a captioned note: the whole clip is read and the caption follows the words", async () => {
  const msgId = await park(2);
  const cid = crypto.randomUUID();
  voice.transcript = "the recording itself";

  await onUtterance(client.sock, noted(msgId, cid, `${wordsToken(cid)}\n\nand the typed part`));
  await until(() => core.submitted.length > 0, { what: "the note to reach the pane" });

  expect(voice.stt.length).toBe(1);
  expect(voice.stt[0].offset, "no partial was handed over, so the whole clip is read")
    .toBeNull();
  expect(rowsFor(cid)[0].text).toBe("the recording itself\n\nand the typed part");
});

test("an unreadable clip: the placeholder goes where the words were, the quote stays", async () => {
  const msgId = await park(3);
  const cid = crypto.randomUUID();
  voice.mode = "ERRORING";

  await onUtterance(client.sock, noted(msgId, cid, `${QUOTE}\n\n${wordsToken(cid)}`));
  await until(() => core.submitted.length > 0, { what: "the note to reach the pane" });

  expect(rowsFor(cid)[0].text).toBe(`${QUOTE}\n\n${NOTE_UNREAD}`);
  expect(core.submitted[0].text).not.toContain("{{cyc-words:");
});

test("a long quoted note is shown at once and completed ONCE with quote and words", async () => {
  const msgId = await park(4);
  const cid = crypto.randomUUID();
  voice.transcript = "a long answer that took a while to read";
  holdVoice();

  const delivery = onUtterance(client.sock, noted(msgId, cid, `${QUOTE}\n\n${wordsToken(cid)}`));
  await until(() => has(cid, "rescue.start"), { what: "the rescue decode to start" });
  await core.clock.advance(RESCUE_INLINE_MS);
  await until(() => has(cid, "utterance.shown-pending"), { what: "the note to be shown pending" });

  const shown = rowsFor(cid);
  expect(shown.length).toBe(1);
  expect(shown[0].transcriptPending).toBe(true);
  expect(shown[0].text, "the pending row shows words nobody has read yet").toBe("");
  expect(shown[0].wordsInto, "the body the words fill was not kept on the row")
    .toBe(`${QUOTE}\n\n${wordsToken(cid)}`);
  expect(core.submitted.length, "something reached the agent before the words did").toBe(0);

  openVoice();
  await delivery;
  await until(() => has(cid, "rescue.completed"), { what: "the completion to settle" });

  const done = rowsFor(cid);
  expect(done.length, "the completion appended a second bubble").toBe(1);
  expect(done[0].text).toBe(`${QUOTE}\n\n${voice.transcript}`);
  expect(done[0].transcriptPending).toBeUndefined();
  expect(done[0].wordsInto, "the filled body was left on the completed row").toBeUndefined();
  expect(core.submitted.length, "the agent got more than one turn for one note").toBe(1);
  expect(core.submitted[0].text).toContain(`${QUOTE}\n\n${voice.transcript}`);
});

test("after a restart the re-drive completes a pending quoted note with its quote", async () => {
  const msgId = await park(5);
  const cid = crypto.randomUUID();
  voice.transcript = "words read after the restart";
  const s = resolveSession(PANE_SID)!;
  /* The row a restart finds: shown pending with its body kept, the decode that
   * was in flight gone with the old process. */
  const row = { id: s.id, role: "user" as const, text: "", ts: stampTs(s), cid,
    kind: "voice" as const, msgId, durationS: 12, transcriptPending: true,
    wordsInto: `${QUOTE}\n\n${wordsToken(cid)}` };
  logChat(s, row);
  const was = restoredChats.get(s.id);
  restoredChats.set(s.id, [row]);
  try {
    await sweepPendingTranscripts();
    await until(() => has(cid, "rescue.completed"), { what: "the re-driven note to complete" });
  } finally {
    if (was) restoredChats.set(s.id, was);
    else restoredChats.delete(s.id);
  }
  expect(rowsFor(cid).length).toBe(1);
  expect(rowsFor(cid)[0].text).toBe(`${QUOTE}\n\n${voice.transcript}`);
  expect(core.submitted[0].text).toContain(`${QUOTE}\n\n${voice.transcript}`);
});

test("a marker naming the cid on a TEXT frame is his own typing and goes through untouched", async () => {
  const cid = crypto.randomUUID();
  const typed = `what does ${wordsToken(cid)} do?`;
  await onUtterance(client.sock,
    { t: "utterance", id: wireId(PANE), text: typed, cid });
  await until(() => core.submitted.length > 0, { what: "the message to reach the pane" });
  expect(voice.stt.length, "a typed marker made the engine decode something").toBe(0);
  expect(rowsFor(cid)[0].text).toBe(typed);
});
