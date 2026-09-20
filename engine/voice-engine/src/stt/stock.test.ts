/* A stock phrase with nothing behind it, and the two ways this can go wrong.
 *
 *   CYC_WHISPER_URL=http://127.0.0.1:2099 \
 *   CYC_STT_URL=ws://127.0.0.1:9099 \
 *   bun test src/stt/stock.test.ts
 *
 * CYC_WHISPER_URL is REQUIRED for the batch decoding half and CYC_STT_URL for
 * the streaming half; neither has a DEFAULT. They must never fall back to :10103
 * and :10105: those are the decoders the user is talking to, and a test that
 * borrows one races him for his own GPU.
 *
 * Two halves, the same two kinds as silence.test.ts.
 *
 * The **unit** half builds wavs whose loud and quiet spans are known by
 * construction. Nothing is decoded there, so the standing rule against
 * synthetic audio in a transcription test is not in play -- the moment a
 * decoder is involved (the second half) every byte is one of his own
 * recordings.
 *
 * The **regression** half is the defect on the recording it was reported from,
 * and its mutation runs on every run: the server's own answer is asserted
 * FIRST, so a fixture that goes stale (whisper stops inventing on this clip, a
 * different model, a different server) fails saying the fixture is stale
 * instead of passing quietly on a defect that is no longer there.
 *
 * The tests that matter most here are the ones that assert this deletes
 * NOTHING. A real one-word "Thanks." was once eaten by a rule of
 * this class, and a filter that loses one real message is worse than the
 * hallucinations it removes.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { normStock, STOCK, unbackedStock, unbackedStockAfter } from "./stock";
import { VoicedMeter, voicedSeconds } from "../audio/silence";

const RATE = 16000;

/** A wav described by [seconds, loud?] pairs, as in silence.test.ts. Loud is a
 * tone well above the -45 dBFS gate; quiet is digital silence, which is what
 * his captures actually contain in a pause. */
function wavOf(spans: Array<[number, boolean]>): Uint8Array {
  const total = spans.reduce((n, [s]) => n + Math.round(s * RATE), 0);
  const pcm = new Int16Array(total);
  let i = 0;
  for (const [secs, loud] of spans) {
    const n = Math.round(secs * RATE);
    for (let k = 0; k < n; k++) pcm[i + k] = loud ? Math.round(8000 * Math.sin((k * 2 * Math.PI * 220) / RATE)) : 0;
    i += n;
  }
  const out = new Uint8Array(44 + pcm.length * 2);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x52494646, false);
  dv.setUint32(4, 36 + pcm.length * 2, true);
  dv.setUint32(8, 0x57415645, false);
  dv.setUint32(12, 0x666d7420, false);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, RATE, true);
  dv.setUint32(28, RATE * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  dv.setUint32(36, 0x64617461, false);
  dv.setUint32(40, pcm.length * 2, true);
  out.set(new Uint8Array(pcm.buffer), 44);
  return out;
}

describe("what it refuses to believe", () => {
  test("a stock phrase over a request with no speech in it", () => {
    expect(unbackedStock(" Thank you.", wavOf([[1.7, false]]))).toBe(true);
    expect(unbackedStock("Thanks for watching!", wavOf([[4, false]]))).toBe(true);
    expect(unbackedStock(" Bye.", wavOf([[2, false]]))).toBe(true);
  });
});

describe("what it must never delete, which is the point", () => {
  test("a stock phrase with a voice behind it stays", () => {
    // The hazard that decides whether this may ship at all: he does say thanks,
    // and measuring the audio rather than the words is the whole reason this
    // can tell the two apart.
    expect(unbackedStock(" Thank you.", wavOf([[1.2, true]]))).toBe(false);
    expect(unbackedStock(" Thanks.", wavOf([[0.4, false], [0.4, true], [0.4, false]]))).toBe(false);
  });

  test("his quietest real voice message is well clear of the line", () => {
    /* Not a round number: 0.120 s is the least speech in any of the 168 real
     * messages under ten seconds in the corpus. The threshold is 0.06 s,
     * so the quietest real thing he has ever sent has twice the evidence it
     * needs. */
    expect(unbackedStock(" Thanks.", wavOf([[0.4, false], [0.12, true], [1.88, false]]))).toBe(false);
  });

  test("a real sentence over silence stays: only the list is deletable", () => {
    // This must never become a general "whisper looked wrong" gate. If the
    // words are not one of whisper's tells, the audio is not consulted at all.
    expect(unbackedStock(" Deploy the engine now.", wavOf([[2, false]]))).toBe(false);
    expect(unbackedStock(" Thank you for the review, that helped.", wavOf([[2, false]]))).toBe(false);
  });

  test("okay and ok are NOT on the list, because they are his words", () => {
    /* The app's BACKCHANNEL ignores "ok"/"okay" only while a reply is playing,
     * because "yes" said into quiet answers a question. An earlier version of
     * this file put them on the stock list, which overrides that decision
     * unconditionally and one layer upstream where the app cannot see it. */
    expect(unbackedStock(" Okay.", wavOf([[2, false]]))).toBe(false);
    expect(unbackedStock(" OK", wavOf([[2, false]]))).toBe(false);
    expect(unbackedStock(" Goodbye.", wavOf([[2, false]]))).toBe(false);
  });

  test("a part of a longer transcript is never examined", () => {
    /* The rule reads the WHOLE request or nothing. Per-sentence checking needs
     * whisper's segment timings, and 12 of 168 final segments in the corpus
     * claim a span with no voiced audio in it while being real words he said.
     * That count is cited, not measured here: see stock.ts for whose it is and
     * why the re-run was abandoned. Nothing unsafe rests on it -- if it were
     * wrong the rule would be narrower than it needed to be, never wider. */
    expect(unbackedStock(" I fixed it. Thank you.", wavOf([[6, false]]))).toBe(false);
  });

  test("normalising is what makes one list cover the punctuation", () => {
    expect(normStock(" Thank you. ")).toBe("thank you");
    expect(normStock("Thanks for watching!")).toBe("thanks for watching");
    expect(normStock("Deploy it.")).toBe("deploy it");
  });
});

// ------------------------------------------------------- the real recording

const WHISPER = (process.env.CYC_WHISPER_URL ?? "").replace(/\/$/, "");

async function whisperUp(): Promise<boolean> {
  if (!WHISPER) return false;
  try {
    return (await fetch(`${WHISPER}/`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

function noWhisper(): string {
  return WHISPER
    ? `SKIPPED: no whisper-server answering at ${WHISPER}.`
    : "SKIPPED: set CYC_WHISPER_URL to a stt/server.py of your own (STT_BATCH_PORT on a scratch port) (never :10103, that is his).";
}

const CLIP = "0ffbb5ef-4407-4c89-900f-8ca0f30dd3c2.webm";
const CLIP_PATHS = [
  new URL(`../../../.run/audio/${CLIP}`, import.meta.url).pathname,
  `${process.env.HOME}/projects/personal/callyourcode/.run/audio/${CLIP}`,
];
const clipPath = CLIP_PATHS.find((p) => existsSync(p));

/* skipIf, not an early return, and that is not a style preference. Returning
 * early makes bun count the test as PASSED, so with nothing set up this file
 * reported "8 pass / 0 fail" and exit 0 with the decoding half never run. There
 * is no CI here, so the reader of that summary is a future agent deciding
 * whether the change is covered. skipIf makes the summary say "skip". */
const noDecode = !WHISPER || !clipPath;
if (noDecode) {
  console.log(clipPath ? noWhisper() : `SKIPPED: ${CLIP} is not staged. Looked in:\n  ${CLIP_PATHS.join("\n  ")}`);
}

describe("the message that was only a hallucination (0ffbb5ef)", () => {
  test.skipIf(noDecode)(
    "1.7 s with no speech in it: whisper still says thank you, and we do not pass it on",
    async () => {
      if (!(await whisperUp())) {
        console.log(noWhisper());
        return;
      }

      const ff = Bun.spawn(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", clipPath!, "-ac", "1", "-ar", "16000",
         "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const wav = new Uint8Array(await new Response(ff.stdout).arrayBuffer());
      await ff.exited;
      expect(wav.byteLength).toBeGreaterThan(44);

      const res = await fetch(`${WHISPER}/v1/audio/transcriptions`, {
        method: "POST",
        // exactly what server.ts sends: raw 16k mono s16le wav bytes
        headers: { "content-type": "audio/wav" },
        body: wav,
        signal: AbortSignal.timeout(240_000),
      });
      expect(res.ok).toBe(true);
      const text = ((await res.json()) as { text?: string }).text ?? "";
      console.log(`[0ffbb5ef] whisper says ${JSON.stringify(text.trim())}`);

      // THE MUTATION, asserted first: the defect is live. This is the string
      // that reached a session as his words on 2026-08-01.
      expect(normStock(text)).toBe("thank you");
      // ...and the fix.
      expect(unbackedStock(text, wav)).toBe(true);
    },
    300_000,
  );
});

/* The wire contract the app depends on, end to end through a real /stt.
 *
 * `dropped` is the whole reason this deletion is allowed to be invisible in
 * `text`: without it, an engine that correctly refuses a hallucination is
 * indistinguishable from one that heard nothing, and the app's hint says
 * "nothing there" -- which is WORSE than the "ignored: Thank you." it said
 * before this filter existed. app.js reads the field; this asserts the field is
 * really there and really populated, because a route that quietly stopped
 * sending it would break the hint with every test above still green.
 *
 * The mutation is the second clip: same route, same request, a recording with a
 * voice in it, which must come back with words and an EMPTY dropped. Without
 * that, an implementation that always reported a drop would pass.
 */
const VOICE_CLIP = "aaef6cb1-75bb-4cc9-a62a-083b9ac5cd88.webm";
const voiceClipPath = [
  new URL(`../../../.run/audio/${VOICE_CLIP}`, import.meta.url).pathname,
  `${process.env.HOME}/projects/personal/callyourcode/.run/audio/${VOICE_CLIP}`,
].find((p) => existsSync(p));

describe("POST /stt reports what it refused", () => {
  test.skipIf(noDecode || !voiceClipPath)(
    "the hallucination comes back in dropped, and a real note does not",
    async () => {
      if (!(await whisperUp())) {
        console.log(noWhisper());
        return;
      }

      // A voice engine of our own, on a port nothing else uses, pointed at the
      // whisper-server of our own. Never :10102 and never :10103.
      const port = 7900 + Math.floor(Math.random() * 90);
      const proc = Bun.spawn(["bun", new URL("../server.ts", import.meta.url).pathname], {
        env: {
          ...process.env,
          VOICE_PORT: String(port),
          VOICE_HOST: "127.0.0.1",
          WHISPER_URL: WHISPER,
          VOICE_SELFCHECK: "0", // default is ON now; keep the self-check off this decode test
          // deliberately dead: this test decodes, it does not synthesise
          KOKORO_URL: "http://127.0.0.1:18880",
          STT_STREAM_URL: "ws://127.0.0.1:19090",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const base = `http://127.0.0.1:${port}`;
        let up = false;
        for (let i = 0; i < 60 && !up; i++) {
          up = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })
            .then((r) => r.ok)
            .catch(() => false);
          if (!up) await Bun.sleep(250);
        }
        expect(up).toBe(true);

        const post = async (path: string) => {
          const res = await fetch(`${base}/stt`, {
            method: "POST",
            headers: { "Content-Type": "audio/webm" },
            body: await Bun.file(path).arrayBuffer(),
            signal: AbortSignal.timeout(240_000),
          });
          expect(res.ok).toBe(true);
          return (await res.json()) as { text?: string; dropped?: string[] };
        };

        const bad = await post(clipPath!);
        console.log(`[/stt 0ffbb5ef] ${JSON.stringify(bad)}`);
        expect(bad.text).toBe("");
        expect(bad.dropped).toEqual(["Thank you."]);

        // THE MUTATION: a recording with a voice in it. Words come back and
        // nothing is refused, so "always report a drop" cannot pass this.
        const good = await post(voiceClipPath!);
        console.log(`[/stt ${VOICE_CLIP.slice(0, 8)}] ${JSON.stringify(good)}`);
        expect((good.text ?? "").length).toBeGreaterThan(10);
        expect(good.dropped).toEqual([]);
      } finally {
        proc.kill();
        await proc.exited;
      }
    },
    300_000,
  );
});

// ----------------------------------------------------- the streaming path
/* The path this rule was NOT on, which is the path his words actually take.
 *
 * `POST /stt` is the fallback: the app takes the streaming decoder's answer
 * whenever there is one and decodes the clip only when the stream had nothing
 * to say. And the streaming decoder is not some other family of model that
 * would make the omission safe -- his live one answers GET :10105/health with
 * `"engine": "whisper.cpp", "model": "ggml-large-v3-turbo.bin"`, because
 * stt/server.py hardcodes the whisper engine whatever its docstring
 * says. So the primary path ran the same inventor with nothing in front of it.
 *
 * THE CLIPS BELOW ARE HIS, and they were chosen by measuring rather than
 * picked. Every recording in `.run/audio` and `.run/uploads` (6923 of them) was
 * run through `voicedSeconds`, and the population turns out to be a cliff:
 *
 *   | speech in the whole clip | clips |
 *   |---|---|
 *   | exactly 0.000 s | 7 |
 *   | 0.001 s to 0.119 s | 0 |
 *   | 0.120 s and up | 6916 |
 *
 * All seven of the first row were then decoded through a real streaming
 * whisper, and five come back as a bare "Thanks." and two as nothing at all.
 * So the set this rule can fire on contains no real words anywhere in his
 * corpus, and the tests are the two ends of that measurement:
 *
 *   6cc79b10  0.96 s, 0.000 s of speech  -> refused, reported in `dropped`
 *   93bb7cda  2.40 s, 0.120 s of speech  -> KEPT. The least real voice he owns,
 *                                           twice the threshold, and the first
 *                                           thing a creeping one would eat.
 *   f7ce30b6  3.36 s, 2.340 s of speech  -> KEPT, with its sentence intact.
 *
 * If either of the last two ever goes red, the rule is eating his words and
 * must come out; that is worth more than everything the first one buys.
 *
 * (`0ffbb5ef`, the message that was actually delivered, is the batch half
 * above. It is one of the two clips the streaming decoder says nothing at all
 * for -- which is exactly why it reached whisper by the batch route in the
 * first place, and why the refusal here is tested on one of the five that does
 * come back with a phrase.)
 */

const STT_WS = (process.env.CYC_STT_URL ?? "").replace(/\/$/, "");

const inRun = (f: string) =>
  [
    new URL(`../../../.run/audio/${f}`, import.meta.url).pathname,
    `${process.env.HOME}/projects/personal/callyourcode/.run/audio/${f}`,
  ].find((p) => existsSync(p));

/** 0.96 s of his own recorded silence, which the streaming decoder answers
 * with "Thanks." One of the seven clips in the top row of the table above. */
const SILENT_CLIP = "6cc79b10-91ee-4e8a-8e07-b8a0915c455d.webm";
const silentPath = inRun(SILENT_CLIP);

/** The quietest recording he owns that still has a voice in it: 0.120 s of
 * speech, twice MIN_VOICED_S. Nothing available can say whether that is him or
 * a room, and the rule therefore may not touch it. (0.120 s is also the
 * floor for a real voice message; the same number, from the same corpus.) */
const NEAR_CLIP = "93bb7cda-8a6c-4764-8fa2-b81536834143.webm";
const nearPath = inRun(NEAR_CLIP);

/** An ordinary recording with a sentence in it, so "always report a drop"
 * cannot pass this file. */
const SPOKEN_CLIP = "f7ce30b6-2c9d-41a6-95e2-339ae23560cd.webm";
const spokenPath = inRun(SPOKEN_CLIP);

const noStream = !STT_WS || !silentPath || !spokenPath || !nearPath;
if (noStream) {
  console.log(
    STT_WS
      ? "SKIPPED (streaming): one of his recordings is not staged."
      : "SKIPPED (streaming): set CYC_STT_URL to an stt server of your own (never :10105, that is his).",
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** His recording as 16 kHz mono samples, through ffmpeg, exactly as the batch
 * half above reads it. Returns the wav too, so the same bytes can be measured
 * by the BATCH meter and streamed through the STREAMING one.
 *
 * THE CHUNKS ARE WALKED, not assumed. The first version took the samples from
 * byte 44, which is where they are in a minimal wav and NOT where they are in
 * anything ffmpeg writes -- it puts a LIST chunk in front of `data`, so 44 lands
 * in the middle of a text blob. That blob then read as one loud 20 ms frame and
 * the meter test below caught it: 0.02 s of "speech" in a clip with none.
 * (stt-final.test.ts's header records the same trap from the other end.) */
async function pcmOf(path: string): Promise<{ wav: Uint8Array; pcm: Int16Array }> {
  const ff = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", "16000",
     "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const wav = new Uint8Array(await new Response(ff.stdout).arrayBuffer());
  await ff.exited;
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let off = 12; // past "RIFF" size "WAVE"
  while (off + 8 <= wav.byteLength) {
    const id = String.fromCharCode(wav[off]!, wav[off + 1]!, wav[off + 2]!, wav[off + 3]!);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "data") {
      // ffmpeg writing to a pipe cannot backfill the size, so a bogus one means
      // "to the end", the same rule parseWav takes in silence.ts.
      const avail = wav.byteLength - body;
      const n = size === 0 || size > avail ? avail : size;
      const even = n - (n % 2);
      return { wav, pcm: new Int16Array(wav.buffer.slice(wav.byteOffset + body, wav.byteOffset + body + even)) };
    }
    off = body + size + (size % 2);
  }
  throw new Error(`no data chunk in the wav for ${path}`);
}

/** One release, the way the app does it: start, real-time float32 frames,
 * stop, read the engine's final. */
async function streamRelease(port: number, pcm: Int16Array):
  Promise<{ text: string; dropped: string[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/stt-stream`);
  ws.binaryType = "arraybuffer";
  const got = Promise.withResolvers<{ text: string; dropped: string[] }>();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.t === "final") got.resolve({ text: String(m.text ?? ""), dropped: m.dropped ?? [] });
    if (m.t === "error") got.reject(new Error(m.message));
  };
  await new Promise<void>((r) => (ws.onopen = () => r()));
  ws.send(JSON.stringify({ t: "start", sampleRate: 16000 }));
  const CHUNK = 2048;
  for (let i = 0; i < pcm.length; i += CHUNK) {
    const f = new Float32Array(Math.min(CHUNK, pcm.length - i));
    for (let k = 0; k < f.length; k++) f[k] = pcm[i + k]! / 32768;
    ws.send(f.buffer);
    await sleep((CHUNK / 16000) * 1000); // real time: the decoder's passes are real
  }
  await sleep(350);
  ws.send(JSON.stringify({ t: "stop" }));
  const out = await got.promise;
  try {
    ws.close();
  } catch {}
  return out;
}

async function startStreamEngine(): Promise<{ proc: import("bun").Subprocess<"ignore", "pipe", "pipe">; port: number }> {
  // Never :10102, never :10105, never :10104. Ports of our own.
  const port = 7940 + Math.floor(Math.random() * 50);
  const proc = Bun.spawn(["bun", new URL("../server.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      VOICE_PORT: String(port),
      VOICE_HOST: "127.0.0.1",
      STT_STREAM_URL: STT_WS,
      WHISPER_URL: "http://127.0.0.1:12022", // deliberately dead: this half streams
      VOICE_SELFCHECK: "0", // default is ON now; a dead whisper would trip the self-check off-topic
      KOKORO_URL: "http://127.0.0.1:18880",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
      .then((r) => r.ok)
      .catch(() => false);
    if (up) return { proc, port };
    await sleep(150);
  }
  proc.kill();
  throw new Error("voice engine did not come up");
}

describe("the streaming final has to prove itself too", () => {
  test.skipIf(noStream)(
    "6cc79b10 streamed: the decoder invents thanks and the relay refuses it",
    async () => {
      const { wav, pcm } = await pcmOf(silentPath!);
      // The audio, stated before anything is decoded: this clip has no speech
      // in it at all. If that ever stops being true the test below proves
      // nothing, so it fails here instead.
      expect(voicedSeconds(wav)).toBe(0);

      const eng = await startStreamEngine();
      try {
        const out = await streamRelease(eng.port, pcm);
        console.log(`[stream 6cc79b10] ${JSON.stringify(out)}`);
        // THE MUTATION, asserted first: the STREAMING decoder really does
        // invent this. A whisper that stopped hallucinating on this clip, or a
        // parakeet on the other end, fails HERE saying the fixture is stale
        // rather than passing quietly on a defect that is no longer there.
        expect(out.dropped.length).toBe(1);
        expect(STOCK.has(normStock(out.dropped[0]!))).toBe(true);
        // ...and the fix: it does not reach the caller as his words.
        expect(out.text).toBe("");
      } finally {
        eng.proc.kill();
        await eng.proc.exited;
      }
    },
    300_000,
  );

  test.skipIf(noStream)(
    "93bb7cda streamed: the least real voice he owns is KEPT",
    async () => {
      const { wav, pcm } = await pcmOf(nearPath!);
      /* 0.120 s, twice the threshold and the smallest real signal in 6923
       * recordings. Stated before the decode, because if this clip ever gets
       * quieter the test stops being about the line. */
      const voiced = voicedSeconds(wav);
      expect(voiced).toBeGreaterThan(0.06);
      expect(voiced).toBeLessThan(0.2);

      const eng = await startStreamEngine();
      try {
        const out = await streamRelease(eng.port, pcm);
        console.log(`[stream 93bb7cda] voiced=${voiced.toFixed(3)}s ${JSON.stringify(out)}`);
        /* Whatever this one-word clip decodes to -- it has come back as "Bye."
         * and as "Hi." on the same audio -- the relay hands it over. That is the
         * assertion that decides whether any of this may ship: a
         * real one-word "Thanks." was eaten by a rule of this class, and the
         * clip nearest the line is where that starts. */
        expect(out.dropped).toEqual([]);
        expect(out.text.length).toBeGreaterThan(0);
      } finally {
        eng.proc.kill();
        await eng.proc.exited;
      }
    },
    300_000,
  );

  test.skipIf(noStream)(
    "f7ce30b6 streamed: an ordinary recording comes through untouched",
    async () => {
      const { wav, pcm } = await pcmOf(spokenPath!);
      expect(voicedSeconds(wav)).toBeGreaterThan(1);

      const eng = await startStreamEngine();
      try {
        const out = await streamRelease(eng.port, pcm);
        console.log(`[stream f7ce30b6] ${JSON.stringify(out)}`);
        // Words, and nothing refused: an implementation that always reported a
        // drop, or one that emptied every final, cannot reach here.
        expect(out.text.split(/\s+/).filter(Boolean).length).toBeGreaterThan(3);
        expect(out.dropped).toEqual([]);
      } finally {
        eng.proc.kill();
        await eng.proc.exited;
      }
    },
    300_000,
  );
});

describe("the two paths measure the same audio the same way", () => {
  /* The streaming meter counts frames off the wire and the batch one parses a
   * wav, so they are two pieces of code answering the question this whole file
   * turns on. On his own recordings they have to agree, or the same clip is
   * refused down one path and delivered down the other.
   *
   * Real audio, no decoder: nothing here transcribes anything, so this half
   * runs with no server of any kind set up. */
  /* Both spellings of the audio directory, as everywhere else in this file: a
   * worktree has no `.run` of its own, and a test that silently found none of
   * his recordings would skip rather than fail. */
  const clips = [CLIP, SILENT_CLIP, NEAR_CLIP, SPOKEN_CLIP, VOICE_CLIP]
    .map((f) => [f, inRun(f)] as const)
    .filter((c): c is readonly [string, string] => !!c[1]);

  test.skipIf(clips.length < 2)("frame by frame is the same count as whole-wav", async () => {
    for (const [name, path] of clips) {
      const { wav, pcm } = await pcmOf(path);
      // fed in ragged chunks, because the wire does not respect a 20 ms frame
      const m = new VoicedMeter();
      for (let i = 0, k = 0; i < pcm.length; k++) {
        const n = Math.min([1, 700, 2048, 33][k % 4]!, pcm.length - i);
        const f = new Float32Array(n);
        for (let j = 0; j < n; j++) f[j] = pcm[i + j]! / 32768;
        m.addFloat32(f);
        i += n;
      }
      expect(`${name} ${m.seconds.toFixed(2)}`).toBe(`${name} ${voicedSeconds(wav).toFixed(2)}`);
    }
  }, 60_000);
});

describe("the same words, his two real recordings, opposite answers", () => {
  /* The rule in one assertion, on real audio, with the WORDS HELD FIXED.
   *
   * Everything else in this file varies two things at once: a different clip
   * decodes to a different phrase, so a green run could always be the word list
   * doing the work rather than the audio. Here the phrase is the same string in
   * both calls -- one whisper really produced, on the first clip -- and the only
   * difference between the two lines is which of his recordings was measured.
   *
   * 6cc79b10 is 0.96 s of his recorded silence, 0.000 s voiced, and the
   * streaming decoder answers it "Thanks."
   * 93bb7cda is 2.40 s with 0.120 s of voice in it, the least he owns.
   *
   * No decoder runs here, so this half needs nothing set up. */
  const pair = [SILENT_CLIP, NEAR_CLIP].map(inRun);

  test.skipIf(pair.some((p) => !p))("a stock phrase is refused over one and kept over the other", async () => {
    const [silent, near] = await Promise.all(pair.map((p) => pcmOf(p!)));

    expect(voicedSeconds(silent!.wav)).toBe(0);
    expect(unbackedStock(" Thanks.", silent!.wav)).toBe(true);

    expect(voicedSeconds(near!.wav)).toBeGreaterThan(0.06);
    expect(unbackedStock(" Thanks.", near!.wav)).toBe(false);

    // ...and the streaming half of the rule agrees with the batch half about
    // both of them, since it is the same function with the audio pre-counted.
    for (const c of [silent!, near!]) {
      const m = new VoicedMeter();
      m.addInt16(c.pcm);
      expect(unbackedStockAfter(" Thanks.", m.seconds)).toBe(unbackedStock(" Thanks.", c.wav));
    }
  }, 60_000);
});
