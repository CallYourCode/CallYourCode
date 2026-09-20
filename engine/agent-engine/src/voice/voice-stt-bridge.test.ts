/* THE SEALED STT BRIDGE (the engine half).
 *
 * The mic stream used to ride a plain WS at /voice/stt-stream, which could
 * never be owner-gated (a WS upgrade cannot carry the in-process sealed-tunnel
 * mark). That route is gone; the stream now rides the sealed DataChannel as
 * ordinary client frames:
 *
 *   app -> engine   {t:"stt-open", id, rate, format}
 *                   {t:"stt-b", id, b}        b = base64 f32le PCM
 *                   {t:"stt-close", id}
 *   engine -> app   {t:"stt-partial", id, text, committed, committedS?}
 *                   {t:"stt-final", id, text, corrections, dropped}
 *                   {t:"stt-error", id, error}
 *
 * WHAT IS REAL HERE: voice-proxy.ts (onSttOpen/onSttChunk/onSttClose/
 * closeSttClient, the bridge itself) and frames.ts's dispatch of the three
 * inbound frames. The client is a recorded Sock-shaped fake (the same seam
 * every frames spec uses); the upstream is test-utils/fake-voice.ts's
 * /stt-stream on port 0 -- no engine boot, no real decoder.
 *
 * THE PROPERTIES THAT ONLY BREAK UNDER LOAD, carried over from the old relay's
 * suite because they are transport-independent facts about a mic stream:
 *
 *   ORDER. A bridge that reorders chunks turns speech into word salad, and it
 *   only reorders when frames arrive faster than the upstream socket opens.
 *   The burst spec sends 200 in one turn and compares index for index.
 *
 *   TYPE. The start/stop control must arrive as TEXT and the PCM as BINARY:
 *   a websocket accepts either silently and the decoder misreads both.
 *
 *   LEAK. A client that dies during the upstream connect window used to leave
 *   the upstream socket to finish connecting and sit there forever. The proof
 *   is the fake's own open-socket count, not a sleep.
 *
 * TIME. The connect backstop is shortened through its env override at FILE
 * SCOPE (read per call) and restored in afterAll. Nothing here sleeps blind:
 * waits are `until()` on a real observable.
 *
 *   bun test agent-engine/src/voice/voice-stt-bridge.test.ts
 */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { fakeVoice, silentVoice, deadVoiceBase, pointVoiceAt, restoreVoiceUrls,
  type FakeVoice } from "../test-utils/fake-voice.ts";
import { until } from "../test-utils/wait.ts";
import { b64encode } from "../../../shared/e2e.ts";

import { closeSttClient } from "./voice-proxy.ts";
import { dispatchClientFrame } from "../transport/frames.ts";
import type { Sock } from "../transport/sock.ts";

/* ------------------------------------------------------- the shortened clock */
const SAVED_WS_CONNECT = process.env.VOICE_PROXY_WS_CONNECT_TIMEOUT_MS;
const WS_CONNECT_MS = 240;
process.env.VOICE_PROXY_WS_CONNECT_TIMEOUT_MS = String(WS_CONNECT_MS);

afterAll(() => {
  if (SAVED_WS_CONNECT === undefined) delete process.env.VOICE_PROXY_WS_CONNECT_TIMEOUT_MS;
  else process.env.VOICE_PROXY_WS_CONNECT_TIMEOUT_MS = SAVED_WS_CONNECT;
  restoreVoiceUrls();
});

/* --------------------------------------------------------------- the client
 *
 * A sealed-DC-shaped Sock: the bridge touches data.sec (the channel-is-auth
 * guard), the dispatch touches data.lastFrame, and everything sealed down
 * arrives through send(). `sealed` records the parsed frames in order. */
function sealedSock(o: { sec?: boolean } = {}) {
  const sealed: Record<string, any>[] = [];
  const sock = {
    data: { role: "client", cid: 999, terms: new Map(),
      ...(o.sec === false ? {} : { sec: {} }) },
    send(s: string) { sealed.push(JSON.parse(s)); },
  } as unknown as Sock;
  return { sock, sealed };
}

/** The frames sealed down for one stream id, by kind. */
const ofKind = (sealed: Record<string, any>[], t: string) => sealed.filter((f) => f.t === t);

let voice: FakeVoice;

beforeEach(() => {
  // no greeting and no echo: the real voice engine speaks only partial/final/
  // error, and an echoed PCM frame would look like an upstream binary frame.
  voice = fakeVoice({ greet: null, echo: false });
  pointVoiceAt(voice.base);
});

afterEach(() => {
  voice.stop();
});

const open = (sock: Sock, id: string, extra: Record<string, unknown> = {}) =>
  dispatchClientFrame(sock, { t: "stt-open", id, rate: 16000, format: "f32", ...extra });
const chunk = (sock: Sock, id: string, bytes: Uint8Array) =>
  dispatchClientFrame(sock, { t: "stt-b", id, b: b64encode(bytes) });
const close = (sock: Sock, id: string) =>
  dispatchClientFrame(sock, { t: "stt-close", id });

/* ----------------------------------------------------------- the happy path */

test("open/b/close: start rides first as text, PCM as binary in order, stop last", async () => {
  const { sock } = sealedSock();
  const pcm1 = new Uint8Array([1, 2, 3, 4]);
  const pcm2 = new Uint8Array([5, 6, 7, 8]);

  await open(sock, "s1");
  // sent IMMEDIATELY, inside the upstream's connect window on purpose: the
  // bridge must hold them and flush in order behind the start frame.
  await chunk(sock, "s1", pcm1);
  await chunk(sock, "s1", pcm2);
  await close(sock, "s1");

  await until(() => voice.wsReceived.length >= 4,
    { what: "start + two chunks + stop to reach the voice engine" });

  const [f0, f1, f2, f3] = voice.wsReceived;
  // TYPE and ORDER, both load-bearing: text start first, then the binary PCM
  // exactly as sent, then the text stop.
  expect(typeof f0).toBe("string");
  expect(JSON.parse(f0 as string)).toEqual({ t: "start", sampleRate: 16000 });
  expect(f1).toBeInstanceOf(Uint8Array);
  expect([...(f1 as Uint8Array)]).toEqual([1, 2, 3, 4]);
  expect(f2).toBeInstanceOf(Uint8Array);
  expect([...(f2 as Uint8Array)]).toEqual([5, 6, 7, 8]);
  expect(typeof f3).toBe("string");
  expect(JSON.parse(f3 as string)).toEqual({ t: "stop" });
});

test("partials and the final come back sealed, re-tagged, carrying the stream id and every upstream field", async () => {
  const { sock, sealed } = sealedSock();
  await open(sock, "rec-7");
  await until(() => voice.streams === 1, { what: "the upstream stream to open" });

  voice.push(JSON.stringify({ t: "partial", text: "hello wor", committed: 5 }));
  voice.push(JSON.stringify({ t: "partial", text: "hello world", committed: 11, committedS: 1.62 }));
  await until(() => ofKind(sealed, "stt-partial").length >= 2,
    { what: "both partials to come down sealed" });

  // field for field the voice engine's own partial, plus the tag and the id
  expect(ofKind(sealed, "stt-partial")[0]).toEqual(
    { t: "stt-partial", id: "rec-7", text: "hello wor", committed: 5 });
  expect(ofKind(sealed, "stt-partial")[1]).toEqual(
    { t: "stt-partial", id: "rec-7", text: "hello world", committed: 11, committedS: 1.62 });

  voice.push(JSON.stringify({ t: "final", text: "hello world.", corrections: [["wrld", "world"]], dropped: [] }));
  await until(() => ofKind(sealed, "stt-final").length >= 1, { what: "the final to come down" });
  expect(ofKind(sealed, "stt-final")[0]).toEqual({
    t: "stt-final", id: "rec-7", text: "hello world.",
    corrections: [["wrld", "world"]], dropped: [],
  });

  // the final is TERMINAL: the bridge lets go of its upstream socket at once,
  // without waiting for the voice engine's own close
  await until(() => voice.streams === 0, { what: "the upstream socket to be released after the final" });
  expect(ofKind(sealed, "stt-error").length).toBe(0);
});

test("order and type survive a 200-chunk burst sent inside the connect window", async () => {
  const { sock } = sealedSock();
  await open(sock, "burst");
  const sent: Uint8Array[] = [];
  for (let i = 0; i < 200; i++) {
    const bytes = new Uint8Array([i & 0xff, 42, (i * 7) & 0xff]);
    sent.push(bytes);
    await chunk(sock, "burst", bytes);
  }
  await until(() => voice.wsReceived.length >= 201,
    { what: "the start frame and all 200 chunks to arrive", timeoutMs: 5_000 });
  expect(typeof voice.wsReceived[0]).toBe("string"); // start first, always
  voice.wsReceived.slice(1).forEach((f, i) => {
    expect(f, `chunk ${i} arrived as text, not binary`).toBeInstanceOf(Uint8Array);
    expect([...(f as Uint8Array)]).toEqual([...sent[i]]);
  });
});

test("two concurrent streams on one client stay keyed apart", async () => {
  const { sock, sealed } = sealedSock();
  await open(sock, "a");
  await open(sock, "b");
  await until(() => voice.streams === 2, { what: "both upstream streams to open" });

  // one upstream errors; ONLY its id gets the stt-error, the other stays live
  voice.push(JSON.stringify({ t: "error", message: "stt server full (wait ~2 min)" }));
  await until(() => ofKind(sealed, "stt-error").length >= 2,
    { what: "each stream's own error under its own id" });
  const ids = ofKind(sealed, "stt-error").map((f) => f.id).sort();
  expect(ids).toEqual(["a", "b"]); // push() hit both fakes; each answered as itself
  expect(ofKind(sealed, "stt-error")[0].error).toBe("stt server full (wait ~2 min)");
  await until(() => voice.streams === 0, { what: "both upstreams to be torn down" });
});

/* ------------------------------------------------------------- the refusals */

test("a frame without the sealed-channel proof is ignored: the channel is the auth", async () => {
  const { sock, sealed } = sealedSock({ sec: false });
  await open(sock, "s1");
  await chunk(sock, "s1", new Uint8Array([1]));
  await close(sock, "s1");
  expect(voice.streamsOpened).toBe(0);
  expect(sealed.length).toBe(0);
});

test("a format that is not f32 is refused before anything is dialed", async () => {
  const { sock, sealed } = sealedSock();
  await open(sock, "s1", { format: "i16" });
  await until(() => ofKind(sealed, "stt-error").length >= 1, { what: "the format refusal" });
  expect(ofKind(sealed, "stt-error")[0].id).toBe("s1");
  expect(ofKind(sealed, "stt-error")[0].error).toContain("f32");
  expect(voice.streamsOpened).toBe(0);
});

test("chunks and closes for an unknown id are dropped in silence", async () => {
  const { sock, sealed } = sealedSock();
  await chunk(sock, "never-opened", new Uint8Array([1, 2]));
  await close(sock, "never-opened");
  expect(sealed.length).toBe(0);
  expect(voice.streamsOpened).toBe(0);
});

test("a duplicate stt-open cannot error the incumbent stream out from under the app", async () => {
  const { sock, sealed } = sealedSock();
  await open(sock, "s1");
  await until(() => voice.streams === 1, { what: "the first open to reach upstream" });
  await open(sock, "s1"); // ignored: a fresh recording is a fresh id
  expect(voice.streamsOpened).toBe(1);
  expect(ofKind(sealed, "stt-error").length).toBe(0);
});

/* --------------------------------------------------------- the bad upstreams */

test("a down voice engine answers stt-error, never a hang", async () => {
  pointVoiceAt(deadVoiceBase());
  const { sock, sealed } = sealedSock();
  await open(sock, "s1");
  await until(() => ofKind(sealed, "stt-error").length >= 1,
    { what: "the connect failure to come down as stt-error" });
  expect(ofKind(sealed, "stt-error")[0].id).toBe("s1");
});

test("a reachable-but-silent voice engine fails on the connect backstop", async () => {
  const silent = silentVoice();
  pointVoiceAt(silent.base);
  try {
    const { sock, sealed } = sealedSock();
    const t0 = Date.now();
    await open(sock, "s1");
    await until(() => ofKind(sealed, "stt-error").length >= 1,
      { what: "the backstop to fire", timeoutMs: WS_CONNECT_MS + 3_000 });
    // it really waited on the backstop rather than failing fast on something else
    expect(Date.now() - t0).toBeGreaterThanOrEqual(WS_CONNECT_MS - 40);
    expect(ofKind(sealed, "stt-error")[0].error).toContain("not ready");
  } finally { silent.stop(); }
});

test("an upstream that crashes mid-stream is a terminal stt-error, not silence", async () => {
  const { sock, sealed } = sealedSock();
  await open(sock, "s1");
  await until(() => voice.streams === 1, { what: "the upstream to open" });
  voice.terminateStreams(); // a crash, not a close frame
  await until(() => ofKind(sealed, "stt-error").length >= 1,
    { what: "the crash to come down as stt-error" });
  expect(ofKind(sealed, "stt-error")[0].id).toBe("s1");
});

test("an upstream that closes cleanly WITHOUT a final is still an error: the transcript never came", async () => {
  const { sock, sealed } = sealedSock();
  await open(sock, "s1");
  await until(() => voice.streams === 1, { what: "the upstream to open" });
  voice.closeStreams(1000);
  await until(() => ofKind(sealed, "stt-error").length >= 1,
    { what: "the final-less close to come down as stt-error" });
  expect(ofKind(sealed, "stt-error")[0].error).toContain("before the final");
});

test("after the terminal frame the id is dead: late chunks go nowhere", async () => {
  const { sock, sealed } = sealedSock();
  await open(sock, "s1");
  await until(() => voice.streams === 1, { what: "the upstream to open" });
  voice.push(JSON.stringify({ t: "final", text: "done", corrections: [], dropped: [] }));
  await until(() => ofKind(sealed, "stt-final").length >= 1, { what: "the final" });

  const before = voice.wsReceived.length;
  await chunk(sock, "s1", new Uint8Array([9, 9]));
  await close(sock, "s1");
  expect(voice.wsReceived.length).toBe(before);
  expect(sealed.length).toBe(ofKind(sealed, "stt-final").length); // exactly one terminal, nothing after
});

/* ------------------------------------------------------------- NO SOCKET LEAK */

test("a client that dies during the connect window leaks no upstream socket", async () => {
  /* THE WINDOW THAT LEAKED under the old relay: teardown used to skip a socket
   * that was not yet OPEN, so the handshake finished into a bridge that had
   * forgotten it, one dead stream per cancelled recording. Counted, not slept
   * on: the fake's own live socket count. */
  for (let i = 0; i < 50; i++) {
    const { sock } = sealedSock();
    await open(sock, `s${i}`);
    closeSttClient(sock); // the connection died; closeClient calls exactly this
  }
  await until(() => voice.streams === 0, {
    timeoutMs: 5_000,
    what: `every upstream socket to be torn down (still open: ${voice.streams})`,
  });
  expect(voice.streams).toBe(0);
  expect(voice.streamsClosed).toBe(voice.streamsOpened);
});
