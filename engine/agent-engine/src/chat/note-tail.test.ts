/* THE ENGINE FINISHES A VOICE NOTE'S TRANSCRIPTION, IT DOES NOT REDO IT.
 *
 * The instant lone-note send ships a `kind:'voice'` frame with an EMPTY body
 * and the clip's msgId, and the engine reads the clip itself (the rescue
 * decode). Before this file, that read was always the WHOLE clip -- even when
 * the device's streaming decoder had already turned most of the recording into
 * text, which is exactly what streaming transcription exists to avoid: the
 * owner's long note was fully re-decoded server-side before the agent saw a
 * word of it.
 *
 * Now the frame may carry the device's settled words as a partial named by the
 * frame's OWN cid (a voice note has no uploadId to hang one on; the msgId is
 * accepted too). The rescue then asks /stt for ONLY the tail past `upToS` and
 * concatenates settled + tail -- the same contract transcribeUpload has had
 * since #442. This file pins:
 *
 *   1. a partial on the frame -> one /stt call with the offset set, and the
 *      delivered text is settled + tail, in that order;
 *   2. no partial -> the whole clip is read exactly as before (no offset);
 *   3. a partial naming NEITHER the cid nor the msgId is ignored -> whole clip;
 *   4. the tail decode FAILS -> the whole clip is read once as a fallback, and
 *      the settled words are NOT prepended (the whole decode already holds
 *      them).
 *
 * WHAT IS REAL: the delivery path from the client frame down (onUtterance ->
 * the clip guard -> the rescue decode -> injectUserMessage -> the real pane),
 * the clip store, and the chat log. The fake is the decoder (fake-voice), which
 * records the offset and body of every call.
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";

import { cacheAudio } from "./clips.ts";
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
let onLog: ((event: string, fields: Record<string, unknown>) => void) | null = null;

function pointTranscribeAtFake(): void {
  initTranscribe({
    voiceUrl: () => voice.voiceUrl(),
    log: (e, f) => { core.log(e, f); onLog?.(e, f); },
    broadcast: (m) => broadcast(m),
    inOrder: (id, f) => inOrder(id, f),
    deliver: (s, opts) => injectUserMessage(s as Session, opts),
    sessionOf: (id) => sessions.get(id),
    restoredChats: () => restoredChats,
    clock: core.clock,
  });
}

beforeAll(async () => {
  voice = fakeVoice({ transcript: "the decoded tail from the offset" });
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
  onLog = null;
  voice.mode = "NORMAL";
  voice.reset();
  client.clear();
  core.logs.length = 0;
  core.submitted.length = 0;
});

const linesFor = (cid: string) => core.logs.filter((l) => l.fields.cid === cid);
const lineOf = (cid: string, event: string) => linesFor(cid).find((l) => l.event === event);
const rowFor = (cid: string) => sessionByHandle(PANE)?.chat.find((m) => m.cid === cid);
const cidOf = (what: string) => `c-nt-${what}-${Math.random().toString(36).slice(2, 7)}`;

function clipBytes(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

/** The instant lone-note frame: empty body, the clip's msgId, and (new) the
 *  device's settled words as a partial named by the frame's own cid. */
const wordless = (msgId: string, cid: string,
  partials?: { id: string; text: string; upToS: number }[]) =>
  ({ t: "utterance", id: wireId(PANE), text: "", kind: "voice", msgId, durationS: 9, cid,
     ...(partials ? { partials } : {}) });

async function park(seed: number): Promise<{ msgId: string; bytes: Uint8Array }> {
  const bytes = clipBytes(4096, seed);
  const msgId = crypto.randomUUID();
  await cacheAudio(msgId, bytes, "audio/webm");
  return { msgId, bytes };
}

test("a partial on the frame: the engine decodes ONLY the tail and prepends the settled words", async () => {
  const { msgId, bytes } = await park(7);
  const cid = cidOf("tail");
  const settled = "the words the device already settled";
  voice.transcript = "and the tail decoded from six seconds in";

  await onUtterance(client.sock, wordless(msgId, cid, [{ id: cid, text: settled, upToS: 6 }]));
  await until(() => core.submitted.length > 0, { what: "the note to reach the pane" });

  /* ONLY the tail was asked for: one /stt call, offset = the handed-over
   * position, and the body is still the stored recording. */
  expect(voice.stt.length, `the engine made ${voice.stt.length} /stt calls, not one`).toBe(1);
  expect(voice.stt[0].offset,
    "the engine did not carry the device's position to /stt, so it re-decoded audio " +
    "the device had already turned into text -- the exact regression").toBe("6");
  expect(voice.stt[0].bytes).toEqual(bytes);

  const body = core.submitted[0].text;
  expect(body, "the settled words the device produced are not in the message").toContain(settled);
  expect(body, "the decoded tail is not in the message").toContain(voice.transcript);
  expect(body.indexOf(settled) < body.indexOf(voice.transcript),
    `settled + tail came out in the wrong order: ${JSON.stringify(body)}`).toBe(true);

  const row = rowFor(cid);
  expect(row?.text).toContain(settled);
  expect(row?.msgId).toBe(msgId);

  const done = lineOf(cid, "rescue.done")!;
  expect(done.fields.mode).toBe("tail");
  expect(done.fields.reusedChars).toBe(settled.length);
});

test("no partial: the whole clip is read exactly as before", async () => {
  const { msgId, bytes } = await park(11);
  const cid = cidOf("whole");
  voice.transcript = "the whole recording decoded";

  await onUtterance(client.sock, wordless(msgId, cid));
  await until(() => core.submitted.length > 0, { what: "the note to reach the pane" });

  expect(voice.stt.length).toBe(1);
  expect(voice.stt[0].offset,
    "the engine asked for a tail when nothing was handed over to resume from").toBeNull();
  expect(voice.stt[0].bytes).toEqual(bytes);
  expect(core.submitted[0].text).toContain("the whole recording decoded");
  expect(lineOf(cid, "rescue.done")!.fields.mode).toBe("whole");
});

test("a partial naming neither the cid nor the msgId is ignored: whole clip", async () => {
  const { msgId } = await park(13);
  const cid = cidOf("stray");
  voice.transcript = "decoded start to finish";

  await onUtterance(client.sock, wordless(msgId, cid,
    [{ id: "someone-elses-id", text: "words that are not this note's", upToS: 4 }]));
  await until(() => core.submitted.length > 0, { what: "the note to reach the pane" });

  expect(voice.stt.length).toBe(1);
  expect(voice.stt[0].offset).toBeNull();
  expect(core.submitted[0].text).toContain("decoded start to finish");
  expect(core.submitted[0].text,
    "a stray partial's words leaked into a note it does not belong to")
    .not.toContain("words that are not this note's");
});

test("a failed tail decode falls back to the whole clip ONCE, without doubling the head", async () => {
  const { msgId } = await park(17);
  const cid = cidOf("fall");
  const settled = "the settled opening words";
  voice.transcript = "the entire clip start to finish";
  voice.mode = "ERRORING";
  onLog = (event) => { if (event === "rescue.tail-failed") voice.mode = "NORMAL"; };

  await onUtterance(client.sock, wordless(msgId, cid, [{ id: cid, text: settled, upToS: 5 }]));
  await until(() => core.submitted.length > 0, { what: "the note to reach the pane" });

  /* The tail WAS attempted at the handed-over position (the refused request
   * never completes on the fake, so it is read off the engine's own line),
   * and the whole-clip retry ran ONCE. */
  const failed = lineOf(cid, "rescue.tail-failed");
  expect(failed, "the tail was never attempted, so the fallback is not a fallback").toBeTruthy();
  expect(failed!.fields.fromS, "the tail attempt did not use the handed-over position").toBe(5);
  expect(lineOf(cid, "rescue.start")!.fields.tailOnly).toBe(true);
  expect(voice.stt.length,
    `the whole-clip fallback ran ${voice.stt.length} times, not once`).toBe(1);
  expect(voice.stt[0].offset, "the fallback did not read the whole clip").toBeNull();

  const body = core.submitted[0].text;
  expect(body).toContain("the entire clip start to finish");
  expect(body, "the settled words were prepended to a WHOLE decode, doubling the opening")
    .not.toContain(settled);
  expect(lineOf(cid, "rescue.done")!.fields.mode).toBe("whole-fallback");
});
