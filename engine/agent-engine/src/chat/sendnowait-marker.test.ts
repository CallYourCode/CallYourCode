/* WHOSE MARKER IS IT (task 292, the gate).
 *
 * `{{cyc-words:<uploadId>}}` is this engine's own bookkeeping: the composer
 * mints one beside the recording it names, and this engine replaces it with the
 * words. Two failures live on either side of that, and both have happened:
 *
 *   A MARKER HE TYPED HIMSELF IS HIS WORDS. The fill used to run on "is there a
 *   marker in the body" alone, so his own sentence was edited under him.
 *   Measured: zero decoder calls, and the agent read "look at this log line:
 *   -- what does that marker do?" while the bubble on his phone still showed the
 *   marker. He is the person most likely to paste one of these into this app,
 *   because he is the person discussing this feature in it.
 *
 *   AND A REAL ONE STILL CANNOT ESCAPE. The fix is a condition on when the pass
 *   runs, and a condition written slightly wrong lets a real marker through to a
 *   pane -- which hands an agent the engine's bookkeeping as the user's words.
 *
 * The distinction the gate draws: a marker naming a recording that is not
 * attached to THIS message cannot have come from a composer, so it came from a
 * person, and it is text. Both halves appear in one body below, which is the
 * point: the pass has to tell them apart rather than treat all markers alike in
 * either direction.
 *
 * Split out of sendnowait.test.ts because each delivery pays the shipped 250ms
 * keystroke settle; the placement cases are in sendnowait.test.ts and the hold
 * is in sendnowait-hold.test.ts.
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
  voice.reset();
  client.clear();
  core.logs.length = 0;
  core.submitted.length = 0;
});

type Up = { uploadId: string; name: string; mime: string; size: number; path: string;
            image: boolean; durationS?: number; at?: number; textLen?: number };

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

/** A real uuid shape that is deliberately NOT any upload on these messages. */
const OLD = "{{cyc-words:8f14e45f-ceea-467a-9f8b-8b0b7f2c1d33}}";

/** THE INVARIANT EVERY CASE SHARES: no marker of THIS message survives to a
 *  pane, ever. */
function noOwnMarker(where: string): void {
  for (const t of core.submitted) {
    const own = [...t.text.matchAll(/\{\{cyc-words:([0-9a-fA-F-]{8,64})\}\}/g)]
      .map((m) => m[1])
      .filter((id) => id !== "8f14e45f-ceea-467a-9f8b-8b0b7f2c1d33");
    expect(own,
      `${where}: the engine typed its own placeholder at the agent. He is reading ` +
      `"${t.text.slice(0, 160)}" as the message he was sent.`).toEqual([]);
  }
}

test("a marker he typed himself is his words, and reaches the agent whole", async () => {
  /* A real marker never travels alone -- the composer mints it beside the upload
   * it names -- so a body carrying one with nothing attached and nothing asked
   * for is not a composition. */
  const cid = CID();
  const his = "look at this log line: " + OLD + " -- what does that marker do?";
  await onUtterance(client.sock, { t: "utterance", id: wireId(PANE), cid, text: his });

  expect(core.submitted.length, "one typed message, more than one turn").toBe(1);
  expect(core.submitted[0].text,
    "his own words were edited on the way to the agent: the marker he was asking about was " +
    "deleted out of the middle of his sentence, and the bubble on his phone still shows it. " +
    "The app and the agent now disagree about what he said.").toContain(his);
  expect(voice.stt.length,
    "a message with no recording anywhere near it asked the decoder to read something").toBe(0);
  expect(lineOf(cid, "words.typed"),
    "the engine did not record why it left the body alone").toBeTruthy();

  // and the chat log holds the same sentence the agent was given
  expect(rowFor(cid)!.text,
    "the chat log holds a different sentence than the one the agent was given").toBe(his);
});

test("a marker pasted inside a code fence is left alone too", async () => {
  /* Where a pasted log line actually lands. Nothing here parses markdown, so
   * this is one assertion that the gate is about the MESSAGE and not about where
   * in it the marker sits. */
  const cid = CID();
  const fenced = "```\n2026-08-05 words.filled upload=" + OLD + "\n```";
  await onUtterance(client.sock, { t: "utterance", id: wireId(PANE), cid, text: fenced });
  expect(core.submitted[0].text,
    "a marker pasted inside a code fence was deleted from the log line he was quoting")
    .toContain(OLD);
  expect(voice.stt.length).toBe(0);
});

test("answering a message that contains a marker does not hole the quotation", async () => {
  /* THE SAME DEFECT ONE LEVEL DOWN, and it became reachable the moment a typed
   * marker could survive in his history at all.
   *
   * A voice reply carries a recording, so the message IS a composition and the
   * pass runs -- and the pass is total over the whole body, which includes the
   * blockquote of the message being answered (the app prepends it, store.ts
   * sendText). His own words landed correctly one line below while the quotation
   * came out holed: `> what does  do again?`. The bubble still showed it intact,
   * so the phone and the agent disagreed about what he had said. */
  const cid = CID();
  const up = await stage();
  voice.transcript = "yes that is the one";

  await onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), cid, uploads: [up], words: [up.uploadId],
    text: `> what does ${OLD} do again?\n\n${wordsToken(up.uploadId)}`,
  });

  expect(core.submitted.length, "one reply, more than one turn").toBe(1);
  const body = core.submitted[0].text;
  /* HIS QUOTATION IS WHAT HE QUOTED. */
  expect(body, "the quotation he is answering came out with a hole in it: the marker he was " +
    "asking about was deleted while his own transcript went in correctly one line below, and " +
    `the bubble still shows it. ${JSON.stringify(body)}`).toContain(`> what does ${OLD} do again?`);
  /* AND HIS OWN RECORDING STILL BECAME WORDS. */
  expect(body, "the reply's own transcript never went in").toContain("yes that is the one");
  expect(body.includes(wordsToken(up.uploadId)),
    "this message's OWN marker escaped to the agent, so the narrowing was drawn too wide")
    .toBe(false);
  noOwnMarker("quotation with a foreign marker");
  expect(lineOf(cid, "words.filled")!.fields.kept,
    "the engine did not record that it left somebody else's marker alone")
    .toBe("8f14e45f-ceea-467a-9f8b-8b0b7f2c1d33");
});

test("a real marker still cannot escape, with or without a words list", async () => {
  /* THE OTHER HALF OF THE GATE. An ATTACHMENT is enough to say this is a
   * composition; a frame naming nothing in `words` does not make the marker his
   * text, because the fill is TOTAL once it runs. */
  const up = await stage();
  voice.transcript = "the shelf lifts straight off";

  await onUtterance(client.sock, { t: "utterance", id: wireId(PANE), cid: CID(), uploads: [up],
    words: [up.uploadId], text: `have a listen ${wordsToken(up.uploadId)}` });
  noOwnMarker("gated, with an upload");
  expect(core.submitted[0].text, "the words were not filled in at all")
    .toContain("the shelf lifts straight off");

  await onUtterance(client.sock, { t: "utterance", id: wireId(PANE), cid: CID(), uploads: [up],
    text: `and again ${wordsToken(up.uploadId)}` });
  expect(core.submitted.length, "the second composition never arrived").toBe(2);
  noOwnMarker("gated, no words list");
});
