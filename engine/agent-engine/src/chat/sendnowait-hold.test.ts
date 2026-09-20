/* WHAT THE ENGINE OWES A MESSAGE IT IS STILL FINISHING (task 292).
 *
 * A composition whose recording has not been decoded yet goes to the wire at
 * once, carrying `{{cyc-words:<uploadId>}}` where the transcript belongs, and
 * this engine reads the clip and puts the words in. That HOLD is the price of
 * the feature, and this file is the three promises it makes while it holds:
 *
 *   THE MESSAGE STILL GOES. Nobody could read the recording? The recording IS
 *   the message and the agent is handed its path. A hold that outlived every way
 *   out of it would be a message the agent never receives, which is the failure
 *   this whole design is written against.
 *
 *   THE HOLD IS BOUNDED. A decoder that accepts the request and never answers is
 *   the wedged batch service, and only WORDS_WAIT_MS ends that wait. The bound
 *   advanced below is the SHIPPED twenty-five seconds on a manual clock, not an
 *   environment override: the old version of this file set WORDS_WAIT_MS=1500
 *   and so never exercised the number the product ships.
 *
 *   ORDER SURVIVES IT. A message sent while another is held must not overtake
 *   it. "And do that one first" arriving before the thing it is about is not a
 *   late message, it is a different instruction.
 *
 * Split out of sendnowait.test.ts because each delivery pays the shipped 250ms
 * keystroke settle, and one file holding every case of this feature ran past the
 * suite's per-file budget. The placement cases are in sendnowait.test.ts and the
 * marker gate is in sendnowait-marker.test.ts.
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";

import { inOrder, injectUserMessage, onUtterance } from "./deliver.ts";
import { initTranscribe, wordsToken, WORDS_WAIT_MS } from "../voice/transcribe.ts";
import { mediaRoutes } from "../routes/media.ts";
import { restoredChats, sessionByHandle, sessions, type Session } from "../sessions/session-state.ts";
import { broadcast } from "../transport/wire.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { fakeVoice, type FakeVoice } from "../test-utils/fake-voice.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { until } from "../test-utils/wait.ts";
import { wireCore, type FakeClient, type WireCore, wireId } from "../test-utils/wire-core.ts";

let core: WireCore;
let voice: FakeVoice;
let http: ServedRoutes;
let client: FakeClient;

/* wireCore points transcribe.ts at a voice engine that REFUSES, so a seam test
 * reaching for speech by accident fails loudly rather than dialling his actual
 * one. This file is about the decode, so it re-wires that one module with the
 * boot's own collaborators and the fake upstream instead. */
function pointTranscribeAtFake(): void {
  initTranscribe({
    voiceUrl: () => voice.voiceUrl(),
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
  voice = fakeVoice();
  core = await wireCore({ with: ["delivery"] });
  await until(() => core.sessions.size === 1, { what: "the pane to reconcile" });
  pointTranscribeAtFake();
  http = serveRoutes({ groups: [mediaRoutes], ctx: { uploads: core.uploads! } });
  client = core.client({ attach: PANE });
});

afterAll(async () => {
  http?.stop();
  await core?.stop();
  voice?.stop();
});

afterEach(() => {
  voice.mode = "NORMAL";
  voice.reset();
  client.clear();
  core.logs.length = 0;
  core.submitted.length = 0;
});

type Up = { uploadId: string; name: string; mime: string; size: number; path: string;
            image: boolean; durationS?: number; at?: number; textLen?: number };

/** A recording, staged the way the composer stages one: POST /upload, which is
 *  what a voice BLOCK in a composition goes up as. */
async function stage(name = "voice-1.webm", bytes = 4096): Promise<Up> {
  const body = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) body[i] = (i * 17 + 3) & 0xff;
  const res = await http.fetch("/upload", {
    method: "POST",
    headers: { "content-type": "audio/webm", "x-filename": name, "x-duration-s": "7" },
    body: body as unknown as BodyInit,
  });
  if (!res.ok) throw new Error(`POST /upload: HTTP ${res.status}`);
  return (await res.json()) as Up;
}

const CID = () => "c-nw-" + Math.random().toString(36).slice(2, 8);
const lineOf = (cid: string, event: string) =>
  core.logs.find((l) => l.fields.cid === cid && l.event === event);
const rowFor = (cid: string) => sessionByHandle(PANE)!.chat.find((m) => m.cid === cid);
const echoFor = (cid: string) => client.of("chat").find((f) => f.cid === cid);

/** THE INVARIANT EVERY CASE SHARES: no marker survives to a pane, ever. */
function noMarkerAnywhere(where: string): void {
  for (const t of core.submitted) {
    expect(t.text.includes("{{cyc-words:"),
      `${where}: the engine typed its own placeholder at the agent. He is reading ` +
      `"${t.text.slice(0, 160)}" as the message he was sent.`).toBe(false);
  }
}

test("nobody could read the recording, and the message still goes and says so", async () => {
  const cid = CID();
  const up = await stage();
  voice.mode = "ERRORING"; // the voice engine is up and cannot read the file

  await onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), cid, uploads: [up], words: [up.uploadId],
    text: `have a listen to this ${wordsToken(up.uploadId)}`,
  });

  expect(core.submitted.length, "the message was never delivered, though the recording is " +
    "sitting on this disk and the agent could have opened it").toBe(1);
  expect(core.submitted[0].text,
    "the words he typed around the clip were lost with its transcript")
    .toContain("have a listen to this");
  noMarkerAnywhere("unreadable");
  expect(lineOf(cid, "words.failed"),
    "the engine never asked its own decoder, so nothing was offloaded to it at all")
    .toBeTruthy();

  /* AND IT SAYS SO. An empty transcript under a waveform reads as a recording of
   * silence, which is the app asserting the one thing nobody knows. */
  expect(echoFor(cid)?.wordsFailed,
    "the transcript could not be read by the device or by this engine, and nothing said so. " +
    "Every device draws an empty line under a waveform, which claims the recording was silent.")
    .toBe(true);
  const row = rowFor(cid)!;
  expect(row.wordsFailed,
    "the failure was broadcast and not persisted, so a reload shows an empty transcript with " +
    "no explanation").toBe(true);
  const ups = row.uploads ?? (row.upload ? [row.upload] : []);
  expect(ups.map((u) => u.uploadId),
    "the recording came off the message when its transcript failed. The words are what is " +
    "missing; the audio was safe on this engine the whole time.").toEqual([up.uploadId]);
});

test("a decoder that never answers does not strand the message", async () => {
  /* THE DEADLINE, on the shipped twenty-five seconds. A decoder that accepts the
   * request and never answers is the wedged batch service; nothing fails fast,
   * so the only thing that ends the wait is the bound. */
  const cid = CID();
  const up = await stage();
  voice.mode = "HANGING";

  const delivery = onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), cid, uploads: [up], words: [up.uploadId],
    text: `${wordsToken(up.uploadId)}\n\nwhen you get a moment`,
  });
  await until(() => !!lineOf(cid, "words.start"), { what: "the decode to be started" });

  await core.clock.advance(WORDS_WAIT_MS - 1);
  expect(core.submitted.length,
    "the message went before the deadline it was supposed to be held for").toBe(0);
  await core.clock.advance(1);
  await delivery;

  expect(core.submitted.length,
    "the message was never delivered. The recording is on this engine, the app has drawn the " +
    "bubble, and no pane was ever typed at: the agent simply never received it.").toBe(1);
  expect(core.submitted[0].text,
    "the words he typed around the clip went missing with the transcript")
    .toContain("when you get a moment");
  noMarkerAnywhere("deadline");
  expect(lineOf(cid, "words.deadline"),
    "the delivery did not come from the deadline, so this case is passing for some other " +
    "reason than the one it names").toBeTruthy();
});

test("a message sent during a hold does not overtake the held one", async () => {
  /* ORDER, which the hold is what makes reachable at all. The first message is
   * waiting on a decoder; the second has nothing to wait for. Delivered by
   * whoever is ready first, the agent reads them in the wrong order -- and the
   * order of a conversation is not a detail, it is what the second message
   * MEANS. */
  const held = CID();
  const typed = CID();
  const up = await stage();
  voice.mode = "HANGING";

  const first = onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), cid: held, uploads: [up], words: [up.uploadId],
    text: `look at ${wordsToken(up.uploadId)}`,
  });
  /* Sent straight after, the way a second thought is: nothing about it needs
   * waiting for, so nothing but the queue can hold it back. */
  const second = onUtterance(client.sock,
    { t: "utterance", id: wireId(PANE), cid: typed, text: "and do that one first" });

  await until(() => !!lineOf(held, "words.start"), { what: "the first message to be held" });
  expect(core.submitted.length,
    "the second message was delivered while the first was still being held for its recording")
    .toBe(0);

  await core.clock.advance(WORDS_WAIT_MS);
  await Promise.all([first, second]);

  expect(core.submitted.length, "both messages did not reach the agent").toBe(2);
  expect(core.submitted[0].text,
    "the second message overtook the first. The agent read \"and do that one first\" before " +
    "the message it is about, which is not a late message, it is a different instruction.")
    .toContain("look at");
  expect(core.submitted[1].text, "the typed message is not second")
    .toContain("and do that one first");
});
