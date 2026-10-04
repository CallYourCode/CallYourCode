/* A QUOTED OR CAPTIONED VOICE NOTE GOES AT ONCE, AND THE AGENT READS WHAT IT
 * ALWAYS READ.
 *
 * The app used to hold a voice note with a reply quote or a typed caption on
 * the device decoder for up to 10 s (the owner's 2026-10-04 note: 22 presses,
 * `send.words-unsettled waitedMs=10000`), because the quote and caption had
 * to ride the body and this engine only fills an EMPTY body. Now the frame
 * carries them as `around: {before, after}` beside the empty body, and the
 * engine puts the words it reads between them. This file pins that the agent
 * and the chat row get byte-for-byte the text the bodied frame produced: the
 * quote, the words, the caption, each separated by one blank line, both when
 * the decode lands inline and when a long note completes later.
 *
 * WHAT IS REAL: the delivery path from the client frame down, the clip store
 * and the chat log. The fake is the decoder (fake-voice), held at voiceUrl()
 * for the long-note case as rescue-timeout.test.ts does.
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";

import { cacheAudio } from "./clips.ts";
import { inOrder, injectUserMessage, onUtterance } from "./deliver.ts";
import { initTranscribe, RESCUE_INLINE_MS } from "../voice/transcribe.ts";
import { restoredChats, sessionByHandle, sessions, type Session } from "../sessions/session-state.ts";
import { broadcast } from "../transport/wire.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { fakeVoice, type FakeVoice } from "../test-utils/fake-voice.ts";
import { until } from "../test-utils/wait.ts";
import { wireCore, type FakeClient, type WireCore, wireId } from "../test-utils/wire-core.ts";

let core: WireCore;
let voice: FakeVoice;
let client: FakeClient;

let openVoice: () => void = () => {};
let voiceGate: Promise<void> = Promise.resolve();
const holdVoice = () => { voiceGate = new Promise<void>((r) => { openVoice = r; }); };

beforeAll(async () => {
  voice = fakeVoice({ transcript: "the words he spoke" });
  core = await wireCore({ with: ["delivery"] });
  await until(() => core.sessions.size === 1, { what: "the pane to reconcile" });
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
  client = core.client({ attach: PANE });
});

afterAll(async () => {
  openVoice();
  await core?.stop();
  voice?.stop();
});

afterEach(() => {
  openVoice();
  voiceGate = Promise.resolve();
  voice.reset();
  client.clear();
  core.logs.length = 0;
  core.submitted.length = 0;
});

const has = (cid: string, event: string) =>
  core.logs.some((l) => l.fields.cid === cid && l.event === event);
const rowFor = (cid: string) => sessionByHandle(PANE)?.chat.find((m) => m.cid === cid);
const cidOf = (what: string) => `c-na-${what}-${Math.random().toString(36).slice(2, 7)}`;

async function park(seed: number): Promise<string> {
  const msgId = crypto.randomUUID();
  await cacheAudio(msgId, new Uint8Array(2048).fill(seed), "audio/webm");
  return msgId;
}
const frame = (msgId: string, cid: string, text: string,
  around?: { before: string; after: string }) =>
  ({ t: "utterance", id: wireId(PANE), text, kind: "voice", msgId, durationS: 9, cid,
     ...(around ? { around } : {}) });

const QUOTE = "> the quoted line\n> and its second line";
const BODIED = `${QUOTE}\n\nthe words he spoke\n\nand a caption`;

test("the words go between the quote and the caption: the same text the bodied note delivered", async () => {
  /* Today's shape, the reference: the device baked the words in. */
  const was = cidOf("bodied");
  await onUtterance(client.sock, frame(await park(1), was, BODIED));
  await until(() => core.submitted.length === 1, { what: "the bodied note to reach the pane" });
  const reference = core.submitted[0].text;

  const cid = cidOf("around");
  await onUtterance(client.sock, frame(await park(2), cid, "",
    { before: QUOTE, after: "and a caption" }));
  await until(() => core.submitted.length === 2, { what: "the quoted note to reach the pane" });

  expect(core.submitted[1].text, "the agent did not read what the bodied note gave it")
    .toBe(reference);
  expect(rowFor(cid)?.text).toBe(BODIED);
  expect(rowFor(cid)?.text).toBe(rowFor(was)!.text);
});

test("a quote with no caption, and a caption with no quote", async () => {
  const quoted = cidOf("quote");
  await onUtterance(client.sock, frame(await park(3), quoted, "", { before: QUOTE, after: "" }));
  await until(() => core.submitted.length === 1, { what: "the quoted note" });
  expect(rowFor(quoted)?.text).toBe(`${QUOTE}\n\nthe words he spoke`);

  const captioned = cidOf("caption");
  await onUtterance(client.sock, frame(await park(4), captioned, "",
    { before: "", after: "and a caption" }));
  await until(() => core.submitted.length === 2, { what: "the captioned note" });
  expect(rowFor(captioned)?.text).toBe("the words he spoke\n\nand a caption");
});

test("a long quoted note completes with the quote and caption around its words", async () => {
  const cid = cidOf("long");
  holdVoice();
  const delivery = onUtterance(client.sock, frame(await park(5), cid, "",
    { before: QUOTE, after: "and a caption" }));
  await until(() => has(cid, "rescue.start"), { what: "the rescue decode to start" });
  await core.clock.advance(RESCUE_INLINE_MS);
  await until(() => has(cid, "utterance.shown-pending"), { what: "the note shown pending" });
  expect(core.submitted.length).toBe(0);

  openVoice();
  await delivery;
  await until(() => has(cid, "rescue.completed"), { what: "the completion" });
  expect(core.submitted.length).toBe(1);
  expect(rowFor(cid)?.text).toBe(BODIED);
  expect(core.submitted[0].text).toContain(BODIED);
});
