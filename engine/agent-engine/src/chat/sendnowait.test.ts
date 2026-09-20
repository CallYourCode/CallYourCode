/* THE SEND STOPPED WAITING FOR THE TRANSCRIPT. THE ENGINE OWNS THE TAIL.
 *
 * WHY THIS FILE EXISTS
 *
 * Task 292, in his words: "the send should just pass the word to the agent
 * engine to continue the streaming transcription. after all the voice engine is
 * run within the agent engine (conceptually)."
 *
 * So a composition whose recording has not been decoded yet goes to the wire at
 * once, carrying `{{cyc-words:<uploadId>}}` where that recording's transcript
 * belongs, and this engine -- which has been holding the clip since before the
 * press -- reads it and puts the words in. One body, written once, delivered
 * once, with the words in the place they were composed.
 *
 * WHAT THIS FILE IS GUARDING, and every one of them is a way it has already
 * gone wrong or could:
 *
 *   THE WORDS LAND WHERE HE PUT THEM. The first attempt at this passed a
 *   character offset measured in the browser and spliced there. It was wrong
 *   three ways in one recording -- the app recomposes, a reply prepends a
 *   blockquote, a second recording moves everything after the first -- so the
 *   marker cases below are exactly those three, asserted on what the AGENT
 *   receives rather than on what was stored.
 *
 *   NO MARKER EVER REACHES A PANE. A `{{cyc-words:...}}` typed at an agent is
 *   this engine handing over its own bookkeeping as the user's words. Asserted
 *   on every case, including the ones where the decoder fails.
 *
 *   THE AGENT GETS ONE TURN. Not a wordless turn and a correction: one
 *   composition is one delivery.
 *
 *   AND THE OFFSETS FOLLOW THE EDIT. The composer measured `at`/`textLen`
 *   against a body with markers in it; the body that ships has words there
 *   instead. If they are not moved, every bubble drawing the sent message pairs
 *   the wrong words with the wrong clip.
 *
 * WHAT IS REAL: onUtterance and everything under it -- the upload binder and
 * its adoption, the marker gate, the fill, the per-session order chain, the
 * dials instruction, and the REAL pane the message is typed and submitted at.
 * The only fakes are the decoder and the clock.
 *
 * THE OTHER TWO THIRDS OF THIS FEATURE ARE THEIR OWN FILES, because every
 * delivery here pays the shipped 250ms keystroke settle and one file holding
 * all of it ran past the suite's per-file budget: sendnowait-hold.test.ts is
 * what the engine owes a message it is still finishing (the unreadable
 * recording, the deadline, the order), and sendnowait-marker.test.ts is whose
 * marker it is (his own text, a quotation, and the gate that still lets none of
 * this engine's own escape).
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";

import { inOrder, injectUserMessage, onUtterance } from "./deliver.ts";
import { initTranscribe, wordsToken } from "../voice/transcribe.ts";
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
  core = await wireCore({ with: ["delivery", "plugins"] });
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

test("the transcript lands where he composed it, not at the end", async () => {
  const cid = CID();
  const up = await stage();
  voice.transcript = "the second shelf lifts straight off";

  /* One composition: a typed line, a recording nobody has decoded yet, and
   * another typed line. This is the shape the whole feature is about, and the
   * shape "append the words at the end" passes nothing of. */
  const before = "before the clip";
  const after = "after the clip";
  await onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), cid, uploads: [up], words: [up.uploadId],
    text: `${before}\n\n${wordsToken(up.uploadId)}\n\n${after}`,
  });

  expect(core.submitted.length,
    `one composition reached the agent as ${core.submitted.length} turns`).toBe(1);
  noMarkerAnywhere("in place");

  const body = core.submitted[0].text;
  const iWords = body.indexOf(voice.transcript);
  expect(iWords, "the transcript the engine read never reached the agent at all")
    .toBeGreaterThan(-1);
  expect(iWords > body.indexOf(before) && iWords < body.indexOf(after),
    "the transcript is not between the two lines it was composed between. The agent is " +
    `reading his message in an order he did not say it in: ${JSON.stringify(body)}`).toBe(true);

  /* AND THE RECORDING TRAVELLED WITH IT. The words are what was missing; the
   * clip has been on this disk since before the send, and the path handed over
   * is the ADOPTED one this engine wrote, never the one the frame claimed. */
  const adopted = rowFor(cid)!.uploads?.[0]?.path ?? rowFor(cid)!.upload!.path;
  expect(body, "the agent was given the transcript and no path to the audio it came from")
    .toContain(adopted);
  expect(adopted).not.toBe(up.path);
});

test("a reply's quotation is not cut open by the words going in", async () => {
  /* THE ONE-RECORDING REPRO of the defect that killed the first attempt.
   *
   * The app's store prepends a markdown blockquote of what is being answered to
   * the body it sends (store.ts sendText), so the offsets the composer measured
   * are already wrong by the length of the quotation before the frame leaves the
   * device. Splicing at one put the transcript INSIDE the quotation. A marker
   * cannot be got wrong this way: prepending text in front of text moves it. */
  const cid = CID();
  const up = await stage();
  voice.transcript = "yes, both of them";
  const quote = "> did you want the second one as well\n> or only the first";

  await onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), cid, uploads: [up], words: [up.uploadId],
    text: `${quote}\n\n${wordsToken(up.uploadId)}`,
  });

  expect(core.submitted.length, "one reply reached the agent as more than one turn").toBe(1);
  noMarkerAnywhere("reply");
  const body = core.submitted[0].text;
  expect(body, "the quotation was cut open: the message the agent reads no longer says what " +
    "it is answering").toContain("> did you want the second one as well");
  expect(body, "the second quoted line is gone or broken").toContain("> or only the first");
  expect(body.indexOf("yes, both of them"),
    "the transcript went in BEFORE the end of the quotation, which is the exact defect this " +
    `case exists for: ${JSON.stringify(body)}`).toBeGreaterThan(body.indexOf("> or only the first"));
});

test("two recordings arrive in the order he spoke them", async () => {
  /* The other half of the same defect. One anchor per recording measured against
   * one body means the second clip's words move the first clip's slot, and the
   * pair came out backwards.
   *
   * The two clips are told apart by the words the DEVICE settled for each, which
   * the engine joins in front of that clip's own tail: the two decodes overlap,
   * so a fake that answered a different sentence per call could not promise
   * which call got which. */
  const cid = CID();
  const first = await stage("voice-1.webm", 4096);
  const second = await stage("voice-2.webm", 2048);
  voice.transcript = "and the rest of it";

  await onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), cid, uploads: [first, second],
    words: [first.uploadId, second.uploadId],
    partials: [
      { id: first.uploadId, text: "the first thing he said", upToS: 3 },
      { id: second.uploadId, text: "and then the second thing", upToS: 4 },
    ],
    text: `${wordsToken(first.uploadId)}\n\n${wordsToken(second.uploadId)}`,
  });

  expect(core.submitted.length, "one composition, more than one turn").toBe(1);
  noMarkerAnywhere("two clips");
  const body = core.submitted[0].text;
  const iFirst = body.indexOf("the first thing he said");
  const iSecond = body.indexOf("and then the second thing");
  expect(iFirst, "the first recording's words are not in the message").toBeGreaterThan(-1);
  expect(iSecond, "the second recording's words are not in the message").toBeGreaterThan(-1);
  expect(iFirst < iSecond,
    "the two recordings came out backwards. He said one thing and then another and the agent " +
    `is reading them the other way round: ${JSON.stringify(body)}`).toBe(true);
  // both were read as tails, from their own handed-over positions
  expect(voice.stt.map((h) => h.offset).sort()).toEqual(["3", "4"]);
});

test("the offsets move with the words, so the bubble pairs them right", async () => {
  /* ITEM 36 ON THE OTHER SIDE OF THE EDIT. The composer measured `at`/`textLen`
   * against a body with MARKERS in it. The body that ships has the transcripts
   * there instead, and they are a different length, so every offset after the
   * first marker is wrong unless the engine moves it -- and a wrong offset draws
   * one clip's transcript against another clip, which is the defect item 36
   * removed.
   *
   * TWO RECORDINGS, because one proves nothing: the first marker's own offset
   * does not move (nothing before it changed), so a single-clip case passes just
   * as well against an engine that moves nothing at all. Measured: it did. It is
   * the SECOND one that has to be carried by the first one's edit.
   *
   * Asserted by slicing the delivered body with the numbers the engine echoed:
   * they either name that clip's own words or they do not. */
  const cid = CID();
  const one = await stage("voice-1.webm", 4096);
  const two = await stage("voice-2.webm", 900);
  voice.transcript = "and bring the rag";
  const wordsOne = "bring the small clamp as well";
  const wordsTwo = "and a";

  const head = "here is the plan";
  const tail = "and that is everything";
  const body = `${head}\n\n${wordsToken(one.uploadId)}\n\n${wordsToken(two.uploadId)}\n\n${tail}`;
  // the composer's own arithmetic over the body it is sending, markers and all
  const anchor = (u: Up) => ({ ...u, at: body.indexOf(wordsToken(u.uploadId)),
    textLen: wordsToken(u.uploadId).length });
  await onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), cid, uploads: [anchor(one), anchor(two)],
    words: [one.uploadId, two.uploadId],
    partials: [
      { id: one.uploadId, text: wordsOne, upToS: 3 },
      { id: two.uploadId, text: wordsTwo, upToS: 4 },
    ],
    text: body,
  });

  const echo = echoFor(cid);
  expect(echo, "no chat frame for the message").toBeTruthy();
  const ups = (echo!.uploads ?? (echo!.upload ? [echo!.upload] : [])) as Up[];
  expect(ups.length, "the echoed message lost an attachment").toBe(2);
  const slice = (u: Up) => (echo!.text as string).slice(u.at, (u.at ?? 0) + (u.textLen ?? 0));
  expect(typeof ups[0].at, "the engine dropped the first attachment's offset").toBe("number");
  expect(slice(ups[0]),
    "the first recording's offsets do not name its own transcript: " + JSON.stringify(echo!.text))
    .toBe(`${wordsOne} ${voice.transcript}`);
  expect(slice(ups[1]),
    "the SECOND recording's offsets were not carried by the first one's edit, so the bubble " +
    "draws this clip's transcript somewhere it does not belong -- against the other clip, or " +
    `across the words either side of it: ${JSON.stringify(echo!.text)}`)
    .toBe(`${wordsTwo} ${voice.transcript}`);
  // and the composition really did come out in the order it was assembled
  expect(echo!.text, "the composition came out in the wrong order").toBe(
    `${head}\n\n${wordsOne} ${voice.transcript}\n\n${wordsTwo} ${voice.transcript}\n\n${tail}`);
});

test("the engine says it can do this, at hello, before it is asked", async () => {
  /* THE ENGINE HALF. The app must not send a marker to an engine that would
   * type it at an agent, so it asks first -- and there is nothing to ask unless
   * this frame exists and arrives before any send can be made. */
  const fresh = core.client();
  core.hello(fresh);
  const can = fresh.last("can");
  expect(can, "the engine never said what it can do, so an app has no way to tell it apart " +
    "from one that would deliver the marker verbatim").toBeTruthy();
  expect(can!.list, "the capability list does not name `words`, so an app talking to this " +
    "engine falls back to waiting for its own decoder").toContain("words");
  // and it is the FIRST thing said, before any message could have been sent
  expect(fresh.frames[0].t).toBe("can");
});

test("an ordinary send is not held, and asks no decoder", async () => {
  /* THE CONTROL, and this file needs one. Every case above drives the new path,
   * so all of them would pass just as well if the engine held EVERY message and
   * read a clip for each -- which would move the delay rather than remove it. */
  const cid = CID();
  const said = "nothing here was recorded";
  await onUtterance(client.sock, { t: "utterance", id: wireId(PANE), cid, text: said });

  expect(core.submitted.length, "a plain typed message was delivered more than once").toBe(1);
  expect(core.submitted[0].text, "a plain typed message did not reach the pane intact")
    .toContain(said);
  expect(voice.stt.length, "a message with no recording on it asked the decoder something")
    .toBe(0);
  const row = rowFor(cid)!;
  expect(row.text, "the stored message is not what was sent").toBe(said);
  expect(row.wordsFailed,
    "a message with no recording was marked as having lost its transcript").toBeUndefined();
});
