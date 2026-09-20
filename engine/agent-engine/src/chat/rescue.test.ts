/* THE CLIP IS ON DISK. THE MESSAGE IS NOT ALLOWED TO DISAPPEAR.
 *
 * WHY THIS FILE EXISTS
 *
 * "I recorded a message and it got sent. The transcription was not showing for
 * it. Then nothing appeared. I navigated away, came back, and the message was
 * gone."
 *
 * A voice note whose device could not transcribe it is sent with EMPTY text on
 * purpose: the clip is already parked on the engine, and the engine reads it
 * itself (transcribeStored). onUtterance decided whether that was possible by
 * asking `audio.has(msgId)` -- the HOT CACHE. The hot cache is a cache. It is
 * capped at AUDIO_KEEP clips and AUDIO_KEEP_BYTES, a voice note runs to
 * megabytes, and every engine restart empties it, while the recording itself
 * sits on disk the whole time.
 *
 * So a wordless note whose clip had been evicted, or whose engine had restarted
 * since the upload, hit the same early return as "unknown session": discarded,
 * after the upload had succeeded and after the app had drawn the tick that means
 * "your recording cannot be lost". Nothing was written to the chat log, so
 * coming back to the chat showed nothing, which is exactly what he saw.
 *
 * HOW THE FAILURE IS PRODUCED
 *
 * Twice, by the two ways the cache really empties, and neither is simulated:
 *
 *   - EVICTION: the clip is stored through the real cacheAudio and then buried
 *     under AUDIO_KEEP more real clips, so the real eviction loop drops the
 *     oldest entry -- his recording. The cache is then ASKED whether it still
 *     has it, rather than the test assuming it does not.
 *   - A RESTART: the wiring is torn down and performed again over the same data
 *     dir, which is exactly what a restart leaves behind -- an empty hot cache
 *     and a clip on disk.
 *
 * WHAT IS REAL: the delivery path from the client frame down (onUtterance ->
 * the upload binder -> the clip guard -> the rescue decode -> injectUserMessage
 * -> the real pane), the clip store, and the chat log. The only fake is the
 * DECODER, so the test can state what the engine handed it. And it states it
 * by BYTES: the fake records the whole body it received, so the words in the
 * chat log stay traceable to the recording on disk rather than to a stub that
 * would have answered anything.
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AUDIO_KEEP, audio, cacheAudio, clipOnDisk } from "./clips.ts";
import { inOrder, injectUserMessage, onUtterance } from "./deliver.ts";
import { initTranscribe } from "../voice/transcribe.ts";
import { restoredChats, sessionByHandle, sessions, type Session } from "../sessions/session-state.ts";
import { broadcast } from "../transport/wire.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { fakeVoice, type FakeVoice } from "../test-utils/fake-voice.ts";
import { until } from "../test-utils/wait.ts";
import { wireCore, type FakeClient, type WireCore, wireId } from "../test-utils/wire-core.ts";

let core: WireCore;
let voice: FakeVoice;
let client: FakeClient;

/* wireCore points transcribe.ts at a voice engine that REFUSES, so a seam test
 * reaching for speech by accident fails loudly rather than dialling his actual
 * one. This file is about the rescue decode, so it re-wires that one module
 * with the same collaborators the boot gives it and the fake upstream instead.
 * Re-applied after every reset(), because a reset re-performs the boot and the
 * boot's own refusal comes back with it. */
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
  voice = fakeVoice({ transcript: "the words that were on the recording" });
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
});

const stagingAudio = () => join(core.dir, "staging", "audio");
/** The engine's own log lines for one correlation id, in order. */
const linesFor = (cid: string) => core.logs.filter((l) => l.fields.cid === cid);
const rowFor = (cid: string) => sessionByHandle(PANE)?.chat.find((m) => m.cid === cid);
const cidOf = (what: string) => `c-${what}-${Math.random().toString(36).slice(2, 7)}`;

/** A recording, however many bytes, distinguishable from every other one here. */
function clipBytes(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

/** The frame the app sends for a note its own decoder could not read: empty
 *  text, the kind, and the msgId /user-audio answered with. */
const wordless = (msgId: string, cid: string) =>
  ({ t: "utterance", id: wireId(PANE), text: "", kind: "voice", msgId, durationS: 317, cid });

test("a wordless note whose clip the hot cache has evicted still arrives", async () => {
  const bytes = clipBytes(4096, 7);
  const msgId = crypto.randomUUID();
  const cid = cidOf("evict");
  await cacheAudio(msgId, bytes, "audio/webm");

  /* Now bury it. Nothing is reached into: the cache is the real cache and these
   * are real clips going through the real cacheAudio, so crossing AUDIO_KEEP
   * evicts the oldest entry, which is his recording. */
  for (let i = 0; i < AUDIO_KEEP; i++) {
    await cacheAudio(crypto.randomUUID(), clipBytes(64, i), "audio/webm");
  }

  /* And the eviction is ASKED FOR rather than assumed: if the clip were still
   * cached, everything below would pass against the old code too and this test
   * would be about nothing. The disk copy is untouched, which is the whole
   * point -- it has been there since /user-audio answered. */
  expect(audio.has(msgId),
    `after ${AUDIO_KEEP + 1} clips the hot cache still holds the first one, so nothing was ` +
    "evicted and this test is not exercising the case it claims to").toBe(false);
  expect(await clipOnDisk(msgId), "the recording left the disk as well").toBeTruthy();

  await onUtterance(client.sock, wordless(msgId, cid));
  await until(() => core.submitted.length > 0, { what: "the note to reach the pane" });

  expect(linesFor(cid).some((l) => l.event === "utterance.delivered"),
    "the recording was thrown away. It uploaded fine, the app drew the tick that promises it " +
    "cannot be lost, and the file is on disk this whole time -- but the engine asked its hot " +
    "cache whether it had the clip, the cache had evicted it, and the message hit the same " +
    "early return as an unknown session. Nothing reaches the chat log, so coming back to the " +
    "chat shows nothing.").toBe(true);

  /* THE WORDS ARE TRACEABLE TO THE BYTES. The fake records the whole body it
   * was given, so "the engine read THIS recording" is a byte comparison rather
   * than a stub's opinion: a decode of an empty body would answer the same
   * sentence and prove nothing. */
  expect(voice.stt.length, "the engine did not decode anything at all").toBe(1);
  expect(voice.stt[0].bytes, "the engine posted something other than the stored recording")
    .toEqual(bytes);
  expect(voice.stt[0].contentType).toBe("audio/webm");

  const row = rowFor(cid);
  expect(row, "nothing was persisted, so a reload still loses it").toBeTruthy();
  expect(row!.text,
    "the note was delivered without the words on the clip, so the engine let it through the " +
    "guard and then still could not read the recording it had just decided it had.")
    .toBe("the words that were on the recording");
  expect(row!.msgId,
    "the message survived but its audio did not: the bubble loses its play button and every " +
    "history replay after this one is text only. The clip is on disk; the msgId is valid.")
    .toBe(msgId);
  expect(core.submitted[0].text).toContain("the words that were on the recording");
});

test("a wordless note survives the engine restarting between the upload and the send", async () => {
  /* The other way the hot cache empties, and the faster one: the process dies.
   *
   * A clip on disk with nothing in memory IS the post-restart state, so that is
   * how it is set up -- the file is written, then the whole wiring is torn down
   * and performed again over the same data dir. The app's own frames survive a
   * restart (client.ts queues utterances while disconnected and flushes them on
   * reconnect), so this is not a hypothetical ordering: a note released just
   * before a restart is delivered just after one. */
  const bytes = clipBytes(2048, 19);
  const msgId = crypto.randomUUID();
  await mkdir(stagingAudio(), { recursive: true });
  await writeFile(join(stagingAudio(), `${msgId}.webm`), bytes);

  await core.reset();
  await until(() => core.sessions.size === 1, { what: "the re-booted pane to reconcile" });
  pointTranscribeAtFake();
  client = core.client({ attach: PANE });

  expect(audio.has(msgId), "the restart did not empty the hot cache, so this proves nothing")
    .toBe(false);

  const cid = cidOf("restart");
  await onUtterance(client.sock, wordless(msgId, cid));
  await until(() => core.submitted.length > 0, { what: "the note to reach the pane" });

  expect(linesFor(cid).some((l) => l.event === "utterance.delivered"),
    "a recording that outlived the engine was thrown away by it. The hot cache is empty after " +
    "every restart and the clip is on disk after every upload, so this is the state the engine " +
    "is in for the whole of its first minute -- and any wordless note sent in that window " +
    "disappeared.").toBe(true);
  expect(voice.stt[0]?.bytes,
    "the note arrived without the words on the clip the engine had on disk all along")
    .toEqual(bytes);
  expect(rowFor(cid)?.text).toBe("the words that were on the recording");
});

test("a wordless note whose clip is nowhere is still dropped, and still says so", async () => {
  /* THE GUARD IS MEANT TO BE NARROWER, NOT GONE.
   *
   * A msgId with no clip in the cache AND no clip on disk is a message with no
   * content at all: no words, no attachment, nothing to read. It is still
   * dropped, and the line still names the reason, because that line is the only
   * thing that made this bug findable in the first place. */
  const cid = cidOf("nowhere");
  await onUtterance(client.sock, wordless(crypto.randomUUID(), cid));

  const dropped = linesFor(cid).find((l) => l.event === "utterance.dropped");
  expect(dropped,
    "a voice note with no clip anywhere was neither delivered nor logged as dropped, so the " +
    "silent drop is back").toBeTruthy();
  expect(String(dropped!.fields.why),
    "the drop names no reason, and the reason is the whole difference between 'the session is " +
    "gone' and 'the recording is gone': different bugs, different fixes.")
    .toContain("neither the hot cache nor the audio");
  expect(dropped!.fields.onDisk,
    "the drop does not say whether the recording is on disk. That field is what turns 'a " +
    "message vanished' into 'the message is recoverable and here is the file'.").toBe(false);
  expect(dropped!.fields.msgId, "the drop does not name the clip it could not find").toBeTruthy();

  // nothing was typed at the agent and nothing was written
  expect(rowFor(cid), "a message with nothing in it was written to the chat log").toBeUndefined();
  expect(voice.stt.length, "the engine posted a clip it had already decided it did not have")
    .toBe(0);
});

test("a msgId that climbs out of the audio directory finds nothing", async () => {
  /* clipOnDisk pastes the msgId straight into a path, and the msgId is a raw
   * wire string. `m.cid` is filtered by safeCid eleven lines above the place
   * this is asked; `m.msgId` was not filtered anywhere.
   *
   * The answer GATES BEHAVIOUR rather than only reading a file. haveClip is
   * what sets `rescuable`, which is what keeps a wordless voice note instead of
   * dropping it, which puts the msgId on the message, which sends those bytes
   * to /stt -- and the transcript of them becomes the text of a chat message.
   * So a traversal msgId that lands on any audio file the host happens to have
   * is a path from the wire to chat content.
   *
   * The file is parked one directory above the staging audio dir, inside this
   * test's own throwaway tree, so `../outside` resolves to something that
   * really is there. Nothing outside that tree is touched. */
  const bytes = clipBytes(1024, 3);
  await mkdir(join(core.dir, "staging"), { recursive: true });
  await writeFile(join(core.dir, "staging", "outside.webm"), bytes);

  const cid = cidOf("traverse");
  await onUtterance(client.sock, { ...wordless("../outside", cid), durationS: 12 });

  const dropped = linesFor(cid).find((l) => l.event === "utterance.dropped");
  expect(dropped,
    "a msgId of '../outside' was accepted as a clip this engine holds. clipOnDisk pasted it " +
    "into the audio dir and found the file one directory up, so haveClip said yes, " +
    "`rescuable` kept a wordless note alive, and the engine posted bytes it was never given " +
    "to the transcriber.").toBeTruthy();
  expect(dropped!.fields.onDisk,
    "the drop happened but the engine still reports the traversal path as being on disk, so " +
    "clipOnDisk resolved it and only some later check saved this").toBe(false);
  expect(voice.stt.some((h) => h.bytes.byteLength === bytes.byteLength),
    `the transcriber was handed ${bytes.byteLength} bytes, which is exactly the file sitting ` +
    "one directory above the audio dir, for a msgId that points outside it. Whatever it " +
    "answered would have become the text of a message in the chat.").toBe(false);
  expect(rowFor(cid),
    "a message built from a traversal msgId was written to the chat log").toBeUndefined();
});

test("a note that HAS words keeps them when its clip is forgotten, and says the audio went", async () => {
  /* THE THIRD BRANCH, and the one the narrowing above must not swallow. A note
   * whose words the device DID produce is a message on its own terms: a msgId
   * this engine cannot find costs it the play button and nothing else. Dropping
   * it would lose text nobody else has, and keeping the msgId would draw a play
   * button over a 404 on every replay for ever. */
  const cid = cidOf("forgotten");
  const msgId = crypto.randomUUID();
  await onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), text: "the device read this one itself", kind: "voice",
    msgId, durationS: 4, cid,
  });
  await until(() => core.submitted.length > 0, { what: "the note to reach the pane" });

  const gone = linesFor(cid).find((l) => l.event === "utterance.clip-forgotten");
  expect(gone, "the engine lost a clip and said nothing about it").toBeTruthy();
  expect(String(gone!.fields.why)).toContain("delivered without it");

  const row = rowFor(cid)!;
  expect(row.text, "the words the device produced were dropped with the audio")
    .toBe("the device read this one itself");
  expect(row.msgId,
    "the row kept a msgId for a clip that is nowhere, so every replay draws a play button " +
    "over a 404").toBeUndefined();
  expect(voice.stt.length, "the engine decoded a clip it does not have").toBe(0);
});
