/* THE AGENT->YOU STREAMING SPEECH SEAM (lane/voice-streaming).
 *
 * The you->agent direction has streamed from the start (mic Opus -> /stt-stream);
 * the agent->you direction had encoder, RTP packetizer and pacing on the engine
 * and a gated <audio> sink on the app, but NO SENDER: op "speak" is a client
 * frame the app never sends, so an agent's spoken reply reached the phone only
 * as the batch say clip. speakToCalls is that missing sender: a spoken reply
 * streams down the media track of every fp-gated call client attached to its
 * session, chunk by chunk as the TTS PCM is synthesised, and the say clip
 * stays as history and as the FALLBACK.
 *
 * WHAT IS REAL HERE: voicectl.ts (speakToCalls, the target choice, the
 * say-live/say-live-fail control), tts.ts (speakClip handing the same chunks
 * to the stream), voice-media.ts (ttsPcmFromVoiceEngine and its old-engine
 * guard) and wire.ts (the client set). The call clients are recorded fakes in
 * wire.ts's own `clients`; the TTS-PCM source is the injectable seam; no
 * engine, no WebRTC, no voice engine but a port-0 stub where the HTTP shape
 * itself is the fact under test.
 *
 *   bun test agent-engine/src/voice/voice-downlink.test.ts
 */

import { afterEach, expect, test } from "bun:test";

import { initVoiceCtl, speakToCalls } from "./voicectl.ts";
import { ttsPcmFromVoiceEngine } from "./voice-media.ts";
import { initTts, speakClip, resetForTest as resetTts } from "./tts.ts";
import { clients, resetForTest as resetWire } from "../transport/wire.ts";
import type { Sock } from "../transport/sock.ts";
import type { ChatMsg } from "../chat/chatmsg.ts";

/* A recorded call-mode client: a Sock-shaped fake whose bridge notes every
 * speakPcm and whose send() notes every sealed frame, merged into one `seq` so
 * ORDER between control frames and audio is assertable. */
function callSock(o: { attached?: string | null; muted?: boolean; track?: boolean } = {}) {
  const frames: Record<string, unknown>[] = [];
  const spoken: { pcm: Int16Array; rate: number }[] = [];
  const seq: string[] = [];
  const audio = o.track === false ? null : {
    muted: o.muted ?? false,
    speakPcm(pcm: Int16Array, rate: number) { spoken.push({ pcm, rate }); seq.push(`pcm:${pcm[0]}`); },
  };
  const sock = {
    data: { role: "client", attached: o.attached ?? "s1", audio },
    send(s: string) { const f = JSON.parse(s); frames.push(f); seq.push(`frame:${f.t}`); },
  } as unknown as Sock;
  clients.add(sock);
  return { sock, frames, spoken, seq };
}

afterEach(() => {
  resetWire();
  resetTts();
  initVoiceCtl({ log: () => {} });
});

// ------------------------------------------------------------- speakToCalls

test("a spoken reply streams chunk by chunk, in order, and say-live precedes the audio", async () => {
  const call = callSock();
  const asked: string[] = [];
  initVoiceCtl({
    log: () => {},
    ttsPcm: async (text, voice) => {
      asked.push(`${text}|${voice}`);
      return { pcm: new Int16Array([text.length]), rate: 24000 };
    },
  });

  await speakToCalls("s1", "m1", ["One.", "Two two."], "af_heart");

  // every chunk was synthesised, in order, in the session's voice
  expect(asked).toEqual(["One.|af_heart", "Two two.|af_heart"]);
  // and reached the bridge in the same order, rate intact
  expect(call.spoken.map((s) => s.pcm[0])).toEqual([4, 8]);
  expect(call.spoken[0].rate).toBe(24000);
  /* say-live BEFORE any audio: it is the app's cue to hold the say clip back,
   * and it rides the same ordered channel as the say broadcast it suppresses. */
  expect(call.seq).toEqual(["frame:say-live", "pcm:4", "pcm:8"]);
  expect(call.frames).toEqual([{ t: "say-live", id: "s1", msgId: "m1" }]);
});

test("no gated call on the session means no synthesis at all: the clip is the whole delivery", async () => {
  const muted = callSock({ muted: true });          // track up, fp gate never opened
  const other = callSock({ attached: "s2" });       // a call on a different session
  const noTrack = callSock({ track: false });       // an ordinary DC-only client
  let asked = 0;
  initVoiceCtl({
    log: () => {},
    ttsPcm: async () => { asked++; return { pcm: new Int16Array(1), rate: 24000 }; },
  });

  await speakToCalls("s1", "m1", ["Hi."]);

  // the fallback DECISION: with nobody to stream to, the voice engine is never
  // asked twice for the same words and no client is told to suppress its clip
  expect(asked).toBe(0);
  for (const c of [muted, other, noTrack]) {
    expect(c.frames).toEqual([]);
    expect(c.spoken).toEqual([]);
  }
});

test("no PCM for the FIRST chunk fails the stream over to the clip: say-live-fail, no audio", async () => {
  const call = callSock();
  initVoiceCtl({ log: () => {}, ttsPcm: async () => null });

  await speakToCalls("s1", "m1", ["One.", "Two."]);

  // suppression was announced, then explicitly withdrawn: the app auto-plays
  // the say clip exactly as it always did
  expect(call.frames.map((f) => f.t)).toEqual(["say-live", "say-live-fail"]);
  expect(call.spoken).toEqual([]);
});

test("a MID-stream failure stops the stream but never announces the fallback", async () => {
  const call = callSock();
  let n = 0;
  initVoiceCtl({
    log: () => {},
    ttsPcm: async () => (++n === 1 ? { pcm: new Int16Array([7]), rate: 24000 } : null),
  });

  await speakToCalls("s1", "m1", ["One.", "Two.", "Three."]);

  /* The start of the reply was already heard live; re-playing the whole clip
   * would repeat it. The bubble's clip stays for a manual replay instead. */
  expect(call.spoken.length).toBe(1);
  expect(call.frames.map((f) => f.t)).toEqual(["say-live"]);
  expect(n).toBe(2); // it stopped asking after the failure
});

test("a client that hangs up mid-reply stops receiving; the survivors keep their stream", async () => {
  const stays = callSock();
  const leaves = callSock();
  let n = 0;
  initVoiceCtl({
    log: () => {},
    ttsPcm: async () => {
      // the second client hangs up between chunk one and chunk two
      if (++n === 2) clients.delete(leaves.sock);
      return { pcm: new Int16Array([n]), rate: 24000 };
    },
  });

  await speakToCalls("s1", "m1", ["One.", "Two."]);

  expect(stays.spoken.map((s) => s.pcm[0])).toEqual([1, 2]);
  expect(leaves.spoken.map((s) => s.pcm[0])).toEqual([1]);
});

// ------------------------------------------------- speakClip hands the stream over

test("speakClip hands the reply to the live-call stream even when the clip synthesis fails", async () => {
  const handed: { msgId: string; chunks: string[] }[] = [];
  const broadcasts: Record<string, unknown>[] = [];
  initTts({
    voiceUrl: async () => "http://127.0.0.1:9", // refuses: the CLIP path fails
    voiceFor: () => undefined,
    persistPatch: () => {},
    broadcast: (m) => broadcasts.push(m as Record<string, unknown>),
    restoredChats: () => new Map(),
    streamSay: (_s, msgId, chunks) => handed.push({ msgId, chunks }),
  });
  const msg: ChatMsg = { id: "s1", role: "claude", text: "One. Two.", ts: 1, msgId: "m1" };

  await speakClip({ id: "s1" }, msg, ["One.", "Two."], "m1");

  // the SAME chunks the clip renders from, handed over before any synthesis:
  // the stream is independent of the clip's fate
  expect(handed).toEqual([{ msgId: "m1", chunks: ["One.", "Two."] }]);
  // and the failed clip still degraded to the written words, stream or no stream
  expect(broadcasts.some((b) => b.t === "chat")).toBe(true);
});

// --------------------------------------------------- ttsPcmFromVoiceEngine

test("ttsPcmFromVoiceEngine parses Int16 PCM at the advertised rate", async () => {
  const tone = new Int16Array([1, -2, 3]);
  const srv = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: async (req) => {
      // the request shape the voice engine keys the PCM branch on
      expect((await req.json()).pcm).toBe(true);
      return new Response(new Uint8Array(tone.buffer.slice(0)), {
        headers: { "content-type": "application/octet-stream", "x-pcm-rate": "24000" },
      });
    },
  });
  try {
    const got = await ttsPcmFromVoiceEngine("hi", { base: async () => `http://127.0.0.1:${srv.port}` });
    expect(got).not.toBeNull();
    expect([...got!.pcm]).toEqual([1, -2, 3]);
    expect(got!.rate).toBe(24000);
  } finally { srv.stop(true); }
});

test("a voice engine without the PCM option (mp3, no x-pcm-rate) yields null, never noise", async () => {
  const srv = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: () => new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x64]), {
      headers: { "content-type": "audio/mpeg" },
    }),
  });
  try {
    /* An old voice engine answers the mp3 it always answered. Viewing those
     * bytes as Int16 samples would put noise on the track; null means "no
     * downlink audio", and speakToCalls falls the call back to the clip. */
    expect(await ttsPcmFromVoiceEngine("hi", { base: async () => `http://127.0.0.1:${srv.port}` })).toBeNull();
  } finally { srv.stop(true); }
});
