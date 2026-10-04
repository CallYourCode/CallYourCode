/* THE ENGINE FINISHES A PARTIAL TRANSCRIPTION, IT DOES NOT REDO IT (#442).
 *
 * A deferred-words send used to POST the WHOLE clip to the voice engine's /stt
 * and use its text wholesale, so a 9.5 minute note whose last seconds were
 * still pending got fully re-decoded, slowing every held message by the cost of
 * the words the device had already produced.
 *
 * Now the frame carries, per recording, the words the streaming decoder already
 * settled and how far into the audio they reach (`partials[].upToS`, source
 * seconds). The engine asks /stt for ONLY the tail past that point (an
 * `?offset=` on the same request) and concatenates settled + tail. This file
 * pins the ways it can go:
 *
 *   1. a partial is handed over -> /stt is asked for the tail only (offset set)
 *      and the delivered text is settled + tail;
 *   2. no partial (an old app, or a clip that never streamed) -> the whole clip
 *      is read exactly as before (no offset);
 *   3. the tail decode FAILS -> the whole clip is read once as a fallback, and
 *      the settled words are NOT prepended (the whole decode already holds them);
 *   4. the tail decode never lands (#550) -> the deadline fires and the STREAMED
 *      words stand; a wedged decoder never blanks a note.
 *
 * The offset is what is asserted, not the bytes: with the position carried as a
 * query param the body posted is the whole container either way, and the tail
 * slice happens inside the voice engine (ffmpeg -ss), which is not under test
 * here.
 *
 * WHAT IS REAL: the whole delivery path from the client frame down, the upload
 * store and its adoption, the marker fill, and the pane the words are typed at.
 * The fakes are the decoder (fake-voice, which records the offset of every call)
 * and TIME: WORDS_WAIT_MS is twenty-five seconds and this file advances past the
 * SHIPPED number rather than shortening it from the environment, which is what
 * the old version had to do.
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";

import { inOrder, injectUserMessage, onUtterance } from "./deliver.ts";
import { initTranscribe, wordsToken, WORDS_WAIT_MS } from "../voice/transcribe.ts";
import { mediaRoutes } from "../routes/media.ts";
import { restoredChats, sessions, type Session } from "../sessions/session-state.ts";
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

/* A hook on the engine's own log, which is the only place some of these
 * questions can be answered at the moment they are decided. The fallback test
 * uses it to bring the upstream back exactly between the tail attempt and the
 * whole-clip retry, which is the shape a half-broken decoder really has. */
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
  onLog = null;
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
  for (let i = 0; i < bytes; i++) body[i] = (i * 13 + 5) & 0xff;
  const res = await http.fetch("/upload", {
    method: "POST",
    headers: { "content-type": "audio/webm", "x-filename": name, "x-duration-s": "9" },
    body: body as unknown as BodyInit,
  });
  if (!res.ok) throw new Error(`POST /upload: HTTP ${res.status}`);
  return (await res.json()) as Up;
}

const linesFor = (cid: string) => core.logs.filter((l) => l.fields.cid === cid);
const lineOf = (cid: string, event: string) => linesFor(cid).find((l) => l.event === event);
const CID = () => "c-wt-" + Math.random().toString(36).slice(2, 8);

/** THE INVARIANT EVERY CASE SHARES: no marker survives to a pane, ever. A
 *  `{{cyc-words:...}}` typed at an agent is this engine handing over its own
 *  bookkeeping as the user's words. */
function noMarkerAnywhere(where: string): void {
  for (const t of core.submitted) {
    expect(t.text.includes("{{cyc-words:"),
      `${where}: the engine typed its own placeholder at the agent: "${t.text.slice(0, 160)}"`)
      .toBe(false);
  }
}

test("a handed-over partial makes the engine read only the tail, and it concatenates", async () => {
  const cid = CID();
  const up = await stage();
  const settled = "this is the first recording remember the word";
  voice.transcript = "and here is the tail decoded from six seconds in";

  await onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), cid, uploads: [up], words: [up.uploadId],
    partials: [{ id: up.uploadId, text: settled, upToS: 6 }],
    text: wordsToken(up.uploadId),
  });

  expect(core.submitted.length, "one composition reached the agent as more than one turn").toBe(1);
  noMarkerAnywhere("tail-only");

  /* ONLY THE TAIL WAS ASKED FOR: one /stt call, and its offset is the upToS the
   * app handed over. */
  expect(voice.stt.length, `the engine made ${voice.stt.length} /stt calls, not one`).toBe(1);
  expect(voice.stt[0].offset,
    "the engine did not carry the handed-over position to /stt, so it read the whole clip")
    .toBe("6");

  const body = core.submitted[0].text;
  expect(body, "the settled words the device already produced are not in the message")
    .toContain(settled);
  expect(body, "the tail the engine decoded from the offset is not in the message")
    .toContain(voice.transcript);
  expect(body.indexOf(settled) < body.indexOf(voice.transcript),
    `settled + tail came out in the wrong order: ${JSON.stringify(body)}`).toBe(true);

  // and the engine says which mode it used, with the arithmetic behind it
  const done = lineOf(cid, "words.done")!;
  expect(done.fields.mode).toBe("tail");
  expect(done.fields.reusedChars).toBe(settled.length);
});

test("no partial on the wire: the whole clip is read, exactly as before", async () => {
  const cid = CID();
  const up = await stage();
  voice.transcript = "the whole recording decoded";

  // words asked for, but no partials: an old app, or a clip that never streamed
  await onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), cid, uploads: [up], words: [up.uploadId],
    text: wordsToken(up.uploadId),
  });

  expect(core.submitted.length).toBe(1);
  noMarkerAnywhere("whole");
  expect(voice.stt.length, "the engine made more than one /stt call for one whole clip").toBe(1);
  expect(voice.stt[0].offset,
    "the engine asked for a tail when nothing was handed over to resume from").toBeNull();
  expect(core.submitted[0].text, "the whole-clip transcript did not reach the agent")
    .toContain("the whole recording decoded");
  expect(lineOf(cid, "words.done")!.fields.mode).toBe("whole");
});

test("a failed tail decode falls back to the whole clip ONCE, without doubling the head", async () => {
  /* The tail request 500s; the retry carries no offset and answers the whole
   * clip. The settled words must NOT be prepended to a whole decode -- that
   * decode already holds them, and a join would say the opening twice.
   *
   * The upstream comes back the instant the engine logs that the tail failed,
   * which is between the two calls: a decoder that refuses one request and
   * serves the next is exactly the half-broken shape the fallback is for. */
  const cid = CID();
  const up = await stage();
  const settled = "the settled opening words";
  voice.transcript = "the entire clip start to finish";
  voice.mode = "ERRORING";
  onLog = (event) => { if (event === "words.tail-failed") voice.mode = "NORMAL"; };

  await onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), cid, uploads: [up], words: [up.uploadId],
    partials: [{ id: up.uploadId, text: settled, upToS: 4 }],
    text: wordsToken(up.uploadId),
  });

  expect(core.submitted.length).toBe(1);
  noMarkerAnywhere("tail-failed");

  /* TWO REQUESTS: the tail attempt, then the whole-clip retry. The refused one
   * leaves no completed record on the fake (it never gets as far as the /stt
   * handler, which is what a 500 upstream looks like), so it is read off the
   * engine's own line -- which is where an operator would read it too, and
   * which carries the offset the attempt actually used. */
  const failed = lineOf(cid, "words.tail-failed");
  expect(failed, "the tail was never attempted, so the fallback is not a fallback").toBeTruthy();
  expect(failed!.fields.fromS, "the tail attempt did not use the handed-over position").toBe(4);
  expect(lineOf(cid, "words.start")!.fields.tailOnly).toBe(true);

  // ...and the retry happened ONCE, whole. Two would be a loop; none would be a
  // message delivered with a hole where the recording was.
  expect(voice.stt.length,
    `the whole-clip fallback ran ${voice.stt.length} times, not once`).toBe(1);
  expect(voice.stt[0].offset, "the fallback did not read the whole clip").toBeNull();

  const body = core.submitted[0].text;
  expect(body, "the whole-clip fallback transcript is not in the message")
    .toContain("the entire clip start to finish");
  expect(body.includes(settled),
    "the settled words were prepended to a whole-clip decode, doubling the opening: " +
    JSON.stringify(body)).toBe(false);
  expect(lineOf(cid, "words.done")!.fields.mode).toBe("whole-fallback");
});

/* ------------------------------------------------------------------------
 * #550: THE STREAMED WORDS ARE A FLOOR THE BATCH DECODE MUST BEAT, NOT REPLACE.
 *
 * From the live logs of 2026-08-15: a note arrived, the device had already
 * settled words for it, the engine started a batch decode, the batch service
 * was wedged, the readWords deadline fired, and the message went out EMPTY --
 * the failed decode's nothing overwrote the streamed transcript the device had
 * already shown him. Two of his real messages were delivered as "". The rule:
 * the batch result may replace streamed words only when it actually produced at
 * least as many usable chars; otherwise the streamed words are kept.
 * ---------------------------------------------------------------------- */

test("#550 the deadline with streamed text keeps it: a wedged decoder never blanks a note", async () => {
  const cid = CID();
  const up = await stage();
  const settled = "keep these streamed words even when the decoder wedges";
  /* A LIVE, WEDGED DECODER: it accepts the request, reads the whole body, and
   * never answers. Nothing fails fast, so only the deadline ends the wait --
   * which is the #550 path exactly. */
  voice.mode = "HANGING";

  const delivery = onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), cid, uploads: [up], words: [up.uploadId],
    partials: [{ id: up.uploadId, text: settled, upToS: 6 }],
    text: wordsToken(up.uploadId),
  });
  await until(() => !!lineOf(cid, "words.start"), { what: "the tail decode to be started" });

  /* THE SHIPPED TWENTY-FIVE SECONDS. One millisecond short of it the message is
   * still being held; on it, it goes with what there is. */
  await core.clock.advance(WORDS_WAIT_MS - 1);
  expect(lineOf(cid, "words.deadline"), "the message gave up before the deadline").toBeUndefined();
  await core.clock.advance(1);
  await delivery;

  expect(lineOf(cid, "words.deadline"),
    "the delivery did not come from the deadline, so this case is passing for some other " +
    "reason than the one it names").toBeTruthy();
  expect(lineOf(cid, "words.start")!.fields.tailOnly, "the engine never tried the tail decode")
    .toBe(true);
  expect(core.submitted.length, "one composition reached the agent as more than one turn").toBe(1);
  noMarkerAnywhere("deadline-keeps-streamed");
  expect(core.submitted[0].text,
    "the deadline blanked the note instead of keeping the words the device had settled: " +
    JSON.stringify(core.submitted[0].text)).toContain(settled);
  expect(lineOf(cid, "words.filled")!.fields.keptStreamed,
    "the streamed words were kept without the engine saying so").toBe(up.uploadId);
});

test("#550 the deadline with no streamed text behaves as today: the recording reads empty", async () => {
  /* Nothing was handed over, so there is nothing to keep. A wedged decode past
   * the deadline leaves the marker resolving to nothing, exactly as before: the
   * streamed-words floor does not invent text where the device produced none.
   * His own leading text is delivered untouched, with no placeholder. */
  const cid = CID();
  const up = await stage();
  const lead = "look at this one:";
  voice.mode = "HANGING";

  const delivery = onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), cid, uploads: [up], words: [up.uploadId],
    text: `${lead} ${wordsToken(up.uploadId)}`,
  });
  await until(() => !!lineOf(cid, "words.start"), { what: "the decode to be started" });
  await core.clock.advance(WORDS_WAIT_MS);
  await delivery;

  expect(core.submitted.length).toBe(1);
  noMarkerAnywhere("deadline-no-streamed");
  const body = core.submitted[0].text;
  expect(body, "with nothing streamed, his leading text should still reach the agent")
    .toContain(lead);
  /* The recording resolved to NOTHING: no invented placeholder after his text.
   * The reply-dials instruction may still follow (it is not a transcript). */
  const after = body.slice(body.indexOf(lead) + lead.length);
  expect(/^\s*(\((?=Reply)|$)/.test(after),
    "an empty recording left a phantom transcript after his text: " + JSON.stringify(body))
    .toBe(true);
  expect(lineOf(cid, "words.filled")!.fields.unread,
    "the engine did not record that nobody could read the recording").toBe(up.uploadId);
  // ...and the bubble says so, rather than drawing an empty line under a waveform
  expect(client.of("chat").find((f) => f.cid === cid)!.wordsFailed).toBe(true);
});

test("#550 a successful decode still wins over streamed words", async () => {
  /* The batch decode lands and is longer than what the device settled, so it
   * must extend the streamed words. Keeping streamed would throw away the tail
   * the engine was asked to finish, which is the whole point of the handshake:
   * the floor rule must not defeat it. */
  const cid = CID();
  const up = await stage();
  const settled = "the opening";
  voice.transcript = "and here is the decoded tail past five seconds";

  await onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), cid, uploads: [up], words: [up.uploadId],
    partials: [{ id: up.uploadId, text: settled, upToS: 5 }],
    text: wordsToken(up.uploadId),
  });

  const body = core.submitted[0].text;
  expect(body, "the settled opening is missing").toContain(settled);
  expect(body, "the decoded tail did not win over the streamed words")
    .toContain("decoded tail past five seconds");
  expect(lineOf(cid, "words.filled")!.fields.keptStreamed,
    "a decode that did produce more words was thrown away for the streamed floor")
    .toBeUndefined();
});

test("a partial for a recording nobody asked about is ignored", async () => {
  /* The frame may carry a partial for an id that is not being decoded (an app
   * that hands over everything it has). It must not become a decode of its own,
   * and it must not float into the body of a message that never named it. */
  const cid = CID();
  const up = await stage();
  const other = await stage("voice-2.webm", 512);
  voice.transcript = "the recording that was actually asked for";

  await onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), cid, uploads: [up, other], words: [up.uploadId],
    partials: [{ id: other.uploadId, text: "words about the other clip", upToS: 3 }],
    text: wordsToken(up.uploadId),
  });

  expect(voice.stt.length, "the engine decoded a recording nothing asked it to read").toBe(1);
  expect(voice.stt[0].offset,
    "a partial for another recording was used as this one's resume point").toBeNull();
  expect(core.submitted[0].text, "another recording's settled words leaked into the message")
    .not.toContain("words about the other clip");
});
