/* The silence cutter and the splitter, and the two bugs they exist for.
 *
 *   CYC_WHISPER_URL=http://127.0.0.1:2099 bun test src/audio/silence.test.ts
 *
 * CYC_WHISPER_URL is REQUIRED for the decoding half and has no default. It used
 * to fall back to :10103, the whisper-server the user is talking to, so a bare
 * `bun test` posted a 220 s job to his decoder and raced him for the GPU. Start
 * one of your own on a free port and name it; unset, those tests skip and say
 * why.
 *
 * Two kinds of half, and they are deliberately different kinds of test.
 *
 * The **unit** half is synthetic on purpose and it is NOT a transcription test:
 * it asserts where the cutter cuts, given audio whose silent runs are known by
 * construction. Nothing here is decoded, so the standing rule against synthetic
 * audio in a transcription test is not in play -- the moment a decoder is
 * involved (the second half) the audio is one of the user's own captures and
 * nothing else.
 *
 * The **regression** half is the actual defect, on the actual recording, through
 * the actual whisper server. It needs `.run/audio/64d8b05a-...webm` and a
 * whisper-server of your own, so it SKIPS when either is missing rather than
 * failing -- but it prints that it skipped, loudly, because a guard that
 * silently does nothing is not a guard. `.run/` is gitignored and always will
 * be; that is the same constraint stt/test_commit_loop.py lives under.
 *
 * Shown to fail without the fix. `CYC_NO_TRIM=1` sends the untrimmed clip, the
 * way the code did before this change, and the regression check then says:
 *
 *     error: expect(received).toBeLessThan(expected)
 *     Expected: < 3
 *     Received: 85
 *       at silence.test.ts:224
 *
 * 85 consecutive "and"s, against 1 with the trim, and with the trim the
 * sentences after the pause are back. The message the user actually read on his
 * phone had 87 of them (`.run/chat.json`, session `w9:p4`, 2026-07-30); 85 and
 * 87 are the same failure, the count just depends on where whisper's window
 * boundaries land.
 *
 * The LAST section is the second defect, 2026-08-01, and it is the one the
 * cutter could not have caught: a 220 s capture with no long pause in it whose
 * decode repeated one sentence for sixty seconds. Same shape of test, same
 * clip-and-server skip, `CYC_NO_CHUNK=1` for the mutation. It needs
 * `.run/audio/ff655532-...webm`, which lives on linux.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chunkAtQuiet, silentCuts, trimLongSilences } from "./silence";

const RATE = 16000;

/** A wav whose content is described by [seconds, loud?] pairs. Loud is a tone
 * well above the gate; quiet is digital silence, which is what the user's own
 * captures contain in their pauses (measured: -inf dBFS, not room tone). */
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

const seconds = (w: Uint8Array) => (w.byteLength - 44) / 2 / RATE;

describe("what the cutter may and may not remove", () => {
  test("a clip with no long silence comes back byte-identical", () => {
    // The ordinary voice note. Not "equivalent": the SAME object, so the common
    // path provably takes no risk from this change at all.
    const w = wavOf([
      [2, true],
      [1, false],
      [2, true],
    ]);
    const { wav, cutS } = trimLongSilences(w);
    expect(cutS).toBe(0);
    expect(wav).toBe(w);
  });

  test("a 25 s pause is cut down to one second", () => {
    const { wav, cutS } = trimLongSilences(
      wavOf([
        [5, true],
        [25, false],
        [5, true],
      ]),
    );
    expect(cutS).toBeCloseTo(24, 1);
    expect(seconds(wav)).toBeCloseTo(11, 1);
  });

  test("a pause just under the threshold is left alone", () => {
    // 3 s is the line and a 2.9 s pause is a person thinking, not a gap.
    expect(trimLongSilences(wavOf([[2, true], [2.9, false], [2, true]])).cutS).toBe(0);
  });

  test("a short genuine note is never touched", () => {
    // The trap this fix must not fall into: a previous junk-audio gate made a
    // real one-word note vanish. A note is not silent, so no run inside it can
    // reach 3 s, so there is nothing here to cut however short the note is.
    for (const secs of [0.4, 0.8, 1.5]) {
      const { wav, cutS } = trimLongSilences(wavOf([[secs, true]]));
      expect(cutS).toBe(0);
      expect(seconds(wav)).toBeCloseTo(secs, 2);
    }
  });

  test("an all-silent clip still arrives, one second of it", () => {
    // A mistaken tap or a muted mic. It must not come back empty -- the clip
    // has to reach the decoder for the app's junk-audio handling to see
    // anything at all -- but there is no reason to hand whisper ten seconds of
    // nothing when one second says the same thing and cannot loop.
    const { wav, cutS } = trimLongSilences(wavOf([[10, false]]));
    expect(cutS).toBeCloseTo(9, 1);
    expect(seconds(wav)).toBeCloseTo(1, 1);
  });

  test("both edges of a cut keep half a second of the pause", () => {
    // The seam has to still SOUND like a pause, or the decoder is handed two
    // sentences spliced together and runs them into one.
    const pcm = new Int16Array(20 * RATE);
    for (let k = 0; k < 5 * RATE; k++) pcm[k] = 8000;
    for (let k = 15 * RATE; k < 20 * RATE; k++) pcm[k] = 8000;
    const cuts = silentCuts(pcm);
    expect(cuts.length).toBe(1);
    expect(cuts[0]![0] / RATE).toBeCloseTo(5.5, 1);
    expect(cuts[0]![1] / RATE).toBeCloseTo(14.5, 1);
  });

  test("two separate pauses are both cut", () => {
    const { cutS } = trimLongSilences(
      wavOf([
        [3, true],
        [10, false],
        [3, true],
        [25, false],
        [3, true],
      ]),
    );
    expect(cutS).toBeCloseTo(9 + 24, 1);
  });
});

describe("splitting a long clip into decoder-sized requests", () => {
  const pcmOf = (w: Uint8Array) => new Int16Array(w.buffer.slice(44 + w.byteOffset));

  test("a clip inside one window is one part, the same object", () => {
    // Every ordinary voice note. Not "equivalent", the SAME bytes: the common
    // path makes exactly the request it made before this existed.
    const w = wavOf([[25, true]]);
    const parts = chunkAtQuiet(w);
    expect(parts.length).toBe(1);
    expect(parts[0]).toBe(w);
  });

  test("a long clip becomes parts no longer than whisper's window", () => {
    // Uniformly loud: there is no quiet point to find, every frame ties, and
    // the tie goes to the latest one. So the parts are the full 30 s and the
    // bound holds even when the audio gives the search nothing to work with.
    const parts = chunkAtQuiet(wavOf([[100, true]]));
    expect(parts.length).toBe(4);
    for (const p of parts) expect(seconds(p)).toBeLessThanOrEqual(30);
  });

  test("no sample is lost or repeated across the seams", () => {
    // The property that makes this safe to do at all: the parts ARE the clip.
    // A splitter that dropped a frame at each boundary would lose a word for
    // every thirty seconds spoken, and nothing downstream could tell.
    const w = wavOf([[22, true], [2, false], [22, true], [2, false], [22, true]]);
    const src = pcmOf(w);
    const parts = chunkAtQuiet(w);
    expect(parts.length).toBeGreaterThan(1);
    const joined = new Int16Array(parts.reduce((n, p) => n + pcmOf(p).length, 0));
    let at = 0;
    for (const p of parts) {
      joined.set(pcmOf(p), at);
      at += pcmOf(p).length;
    }
    expect(joined.length).toBe(src.length);
    for (let i = 0; i < src.length; i += 997) expect(joined[i]).toBe(src[i]!);
  });

  test("the cut lands in the pause, not mid-word", () => {
    // 22 s of speech, a 2 s pause, then more. The boundary search runs over
    // 20-30 s, the pause is the quietest thing in it, so that is where it cuts.
    const parts = chunkAtQuiet(wavOf([[22, true], [2, false], [30, true]]));
    expect(seconds(parts[0]!)).toBeGreaterThan(22);
    expect(seconds(parts[0]!)).toBeLessThan(24);
  });
});

// --------------------------------------------------------------- the real one

const CLIP = "64d8b05a-b2ce-47cd-b1f4-86c0af58669d.webm";
const CLIP_PATHS = [
  process.env.CYC_SILENCE_CLIP,
  new URL(`../../../.run/audio/${CLIP}`, import.meta.url).pathname,
  `${process.env.HOME}/projects/personal/callyourcode/.run/audio/${CLIP}`,
].filter(Boolean) as string[];

const clipPath = CLIP_PATHS.find((p) => existsSync(p));

/* The decoder these tests post to. THERE IS NO DEFAULT, and that is the point.
 *
 * It used to default to `http://127.0.0.1:10103`, which is the whisper-server
 * the user is talking to on his own machine: running this file with no
 * environment set sent his decoder a 94 s and a 220 s job and competed with him
 * for the GPU, and the only sign was a skip message that said ":10103" whatever
 * you had pointed it at. A test that silently borrows production is a trap
 * whether or not it happens to be idle, so the address has to be given.
 *
 * `CYC_WHISPER_URL=http://127.0.0.1:2099 bun test src/audio/silence.test.ts`
 * with a stt/server.py of your own (STT_BATCH_PORT on a scratch port) on that port. Unset, the decoding tests
 * skip and say so. */
const WHISPER = (process.env.CYC_WHISPER_URL ?? "").replace(/\/$/, "");

async function whisperUp(): Promise<boolean> {
  if (!WHISPER) return false;
  try {
    const r = await fetch(`${WHISPER}/`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Why the decoding half is not running, naming the address actually tried. */
function noWhisper(): string {
  return WHISPER
    ? `SKIPPED: no whisper-server answering at ${WHISPER}.`
    : "SKIPPED: set CYC_WHISPER_URL to a stt/server.py of your own (STT_BATCH_PORT on a scratch port) (never :10103, that is his).";
}

/* skipIf, not an early return, and that is not a style preference.
 *
 * Returning early makes bun count the test as PASSED. With nothing set up this
 * file reported "17 pass / 0 fail" and exit 0 with the decoding half never run,
 * and the only sign was three console lines. There is no CI here, so the reader
 * of that summary is a future agent deciding whether the change is covered.
 * skipIf makes the summary say "skip". */
function skipDecode(clip: string | undefined, name: string, paths: string[]): boolean {
  if (WHISPER && clip) return false;
  console.log(clip ? noWhisper() : `SKIPPED: ${name} is not staged. Looked in:\n  ${paths.join("\n  ")}`);
  return true;
}

describe("the capture that lost half a recording (2026-07-30, w9:p4)", () => {
  test.skipIf(skipDecode(clipPath, CLIP, CLIP_PATHS))(
    "94 s with a 25 s pause decodes clean instead of looping",
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
      const raw = new Uint8Array(await new Response(ff.stdout).arrayBuffer());
      await ff.exited;
      expect(raw.byteLength).toBeGreaterThan(44);

      // CYC_NO_TRIM=1 sends what the code sent before this fix. That is the
      // mutation: same clip, same server, same request, silence left in.
      const { wav, cutS } = process.env.CYC_NO_TRIM === "1" ? { wav: raw, cutS: 0 } : trimLongSilences(raw);
      if (process.env.CYC_NO_TRIM !== "1") {
        expect(cutS).toBeGreaterThan(30); // the two pauses are 10 s and 25 s
      }

      const res = await fetch(`${WHISPER}/v1/audio/transcriptions`, {
        method: "POST",
        // exactly what server.ts sends: raw 16k mono s16le wav bytes
        headers: { "content-type": "audio/wav" },
        body: wav,
        signal: AbortSignal.timeout(240_000),
      });
      expect(res.ok).toBe(true);
      const text = ((await res.json()) as { text?: string }).text ?? "";
      console.log(`[${cutS.toFixed(1)}s cut] ${text.replace(/\s+/g, " ").trim()}`);

      const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
      let longestRun = 0;
      for (let i = 0, run = 1; i < words.length; i++, run = words[i] === words[i - 1] ? run + 1 : 1) {
        longestRun = Math.max(longestRun, run);
      }

      // The symptom, as a number, and it has to be the RUN and not the count.
      // Counting "and" would fail on a clean decode of this clip, which
      // legitimately contains four of them ("up and down", "starts and stops",
      // "And I think", "that and then"); the defect is that one word repeats
      // eighty-seven times in a row. 3 leaves room for a real "no no" or "very
      // very", which the standing rule says nothing here may ever eat.
      expect(longestRun).toBeLessThan(3);
      // ...and the point of the whole thing: the words after the pause survive.
      // This is the last sentence he spoke, at 90-93 s, and it is the half of
      // the recording that was destroyed.
      expect(text.toLowerCase()).toContain("let me know");
      // No stock hallucination: whisper's tell on silence is a bare "Thank
      // you."/"Thanks for watching" at the end, and the untrimmed clip produces
      // one as soon as the temperature ladder is allowed to fire.
      expect(text.toLowerCase()).not.toContain("thank you");
    },
    300_000,
  );
});

// ------------------------------------------------- the one the cutter missed

const LONG_CLIP = "ff655532-c7af-41df-8261-eda2ed3a65cf.webm";
const LONG_PATHS = [
  process.env.CYC_LONG_CLIP,
  new URL(`../../../.run/audio/${LONG_CLIP}`, import.meta.url).pathname,
  `${process.env.HOME}/projects/personal/callyourcode/.run/audio/${LONG_CLIP}`,
].filter(Boolean) as string[];

const longPath = LONG_PATHS.find((p) => existsSync(p));

/** How many times the most repeated five-word phrase appears. The metric the
 * word-run count above cannot see: "I don't know what I'm doing" has no two
 * identical words side by side, so a run counter reads this failure as clean. */
function topPhrase(text: string, k = 5): { n: number; phrase: string } {
  const w = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const seen = new Map<string, number>();
  for (let i = 0; i + k <= w.length; i++) {
    const s = w.slice(i, i + k).join(" ");
    seen.set(s, (seen.get(s) ?? 0) + 1);
  }
  let n = 0;
  let phrase = "";
  for (const [s, c] of seen) if (c > n) [n, phrase] = [c, s];
  return { n, phrase };
}

describe("the capture that lost a minute of speech (2026-08-01, c-msa4bt6n-d2a83)", () => {
  test.skipIf(skipDecode(longPath, LONG_CLIP, LONG_PATHS))(
    "220 s decodes complete instead of repeating one sentence",
    async () => {
      if (!(await whisperUp())) {
        console.log(noWhisper());
        return;
      }

      const ff = Bun.spawn(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", longPath!, "-ac", "1", "-ar", "16000",
         "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const raw = new Uint8Array(await new Response(ff.stdout).arrayBuffer());
      await ff.exited;
      expect(raw.byteLength).toBeGreaterThan(44);

      // The trim runs and it is NOT what saves this one: 7.4 s comes off, in
      // three places, and the whole-clip decode still degenerates. That is the
      // measurement this test exists to hold on to.
      const { wav, cutS } = trimLongSilences(raw);
      expect(cutS).toBeGreaterThan(5);
      expect(cutS).toBeLessThan(10);

      // CYC_NO_CHUNK=1 posts the whole thing in one request, the way the code
      // did before this change. That is the mutation: same clip, same server,
      // same trim, one window boundary instead of many.
      const parts = process.env.CYC_NO_CHUNK === "1" ? [wav] : chunkAtQuiet(wav);
      if (process.env.CYC_NO_CHUNK !== "1") expect(parts.length).toBeGreaterThan(6);

      const out: string[] = [];
      for (const part of parts) {
        const res = await fetch(`${WHISPER}/v1/audio/transcriptions`, {
          method: "POST",
          // exactly what server.ts sends: raw 16k mono s16le wav bytes
          headers: { "content-type": "audio/wav" },
          body: part,
          signal: AbortSignal.timeout(240_000),
        });
        expect(res.ok).toBe(true);
        out.push(((await res.json()) as { text?: string }).text ?? "");
      }
      const text = out.join("\n").replace(/\s+/g, " ").trim();
      const { n, phrase } = topPhrase(text);
      console.log(`[${parts.length} part(s), ${text.length} chars, top phrase x${n} "${phrase}"]\n${text}`);

      // The symptom as a number. Measured on this clip: 24 with one request
      // ("i don't know what i'm"), 2 with the split -- and 2 is real, he says
      // "gym I could go to" at the start and again at the end.
      expect(n).toBeLessThan(4);
      // Length is the other half of it. The live caption he watched was 2009
      // characters; the batch decode that replaced it was 3118, longer BECAUSE
      // it was repeating. Split, this comes back at ~1950.
      expect(text.length).toBeLessThan(2400);
      // And the point: the two windows the loops ate are speech again. Both of
      // these sentences are missing entirely from the 3118-character version.
      expect(text.toLowerCase()).toContain("seo");
      expect(text.toLowerCase()).toContain("quiet life");
    },
    600_000,
  );
});

/* THE RUNT TAIL, and why it is a test rather than a comment.
 *
 * chunkAtQuiet had no floor on its LAST part, and ties in the quietest-frame
 * search go to the latest frame, so a clip a hair over a multiple of the bound
 * left a sub-second part which was posted to whisper on its own. Whisper
 * answers a sub-second request with its tell for silence: a bare "Thank you."
 *
 * Measured when it was found: over every recording in .run/audio long enough to
 * split, 331 clips, 12 left a final part under a second, and all twelve decoded
 * to "Thank you." -- a sentence he never said, stapled to the end of an
 * otherwise correct transcript and then sent to the session as his words.
 * app.js's STOCK_SILENCE knows that string but only fires when the WHOLE
 * transcript is it, so a runt tail sails through.
 *
 * This asserts the structural property that makes it impossible, which is
 * cheaper and stricter than asserting what a decoder says about it. */
describe("the runt tail (2026-08-05)", () => {
  const tailS = (part: Uint8Array) => seconds(part);

  test("no part is ever shorter than the tail floor", () => {
    // lengths chosen to land just past a multiple of the window: each one is
    // where the old code produced a fraction-of-a-second final request
    for(const total of [30.3, 60.4, 90.2, 120.6]) {
      const parts = chunkAtQuiet(wavOf([[total, true]]));
      expect(parts.length).toBeGreaterThan(0);
      for(const p of parts) expect(tailS(p)).toBeGreaterThanOrEqual(3);
    }
  });

  /* The floor used to be applied AFTER the cut, by folding a runt tail back
   * into the part before it. That moved the runt from its own request into its
   * own 30 s WINDOW, where whisper does exactly the same thing: `9ac33829` is
   * 31.69 s, folded into one part, and its decode ends "Thank you." timed
   * 30.00-31.00, the window boundary. Cutting so both parts fit a window
   * removes it (that measurement is the regression test at the bottom of this
   * file). So the floor and the window are one property now. */
  test("no part is ever longer than whisper's window either", () => {
    for (const total of [30.3, 31.69, 32.9, 60.4, 90.2]) {
      const parts = chunkAtQuiet(wavOf([[total, true]]));
      for (const p of parts) {
        expect(tailS(p)).toBeGreaterThanOrEqual(3);
        expect(tailS(p)).toBeLessThanOrEqual(30);
      }
    }
  });

  test("cutting for the floor keeps every sample, in order", () => {
    const src = wavOf([[30.3, true]]);
    const parts = chunkAtQuiet(src);
    const joined = parts.reduce((n, p) => n + (p.byteLength - 44), 0);
    expect(joined).toBe(src.byteLength - 44);
  });
});

/* The clip that proves the floor has to be inside the cut search, and it is a
 * different failure from the two above: no long pause, no runaway, just 1.69 s
 * of audio in a window of its own.
 *
 * There is no CYC_NO_* switch here because the mutation runs on EVERY run. The
 * test decodes the clip both ways, one part and two, and asserts the broken
 * shape is still broken before asserting the fixed shape is fixed. A stale
 * fixture -- whisper stopping doing this, a model change, a different server --
 * then fails the first assertion and says the fixture is stale, instead of
 * passing quietly on a defect that is no longer there.
 */
const FLOOR_CLIP = "9ac33829-ee45-4f83-b442-dfad574b650f.webm";
const FLOOR_PATHS = [
  new URL(`../../../.run/audio/${FLOOR_CLIP}`, import.meta.url).pathname,
  `${process.env.HOME}/projects/personal/callyourcode/.run/audio/${FLOOR_CLIP}`,
];
const floorPath = FLOOR_PATHS.find((p) => existsSync(p));

describe("the sentence stapled on at the window boundary (2026-08-05, 9ac33829)", () => {
  test.skipIf(skipDecode(floorPath, FLOOR_CLIP, FLOOR_PATHS))(
    "31.7 s in one part invents a thank you; in two parts it does not",
    async () => {
      if (!(await whisperUp())) {
        console.log(noWhisper());
        return;
      }

      const ff = Bun.spawn(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", floorPath!, "-ac", "1", "-ar", "16000",
         "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const raw = new Uint8Array(await new Response(ff.stdout).arrayBuffer());
      await ff.exited;
      const { wav, cutS } = trimLongSilences(raw);
      // Nothing to trim: this clip has no pause anywhere near 3 s, which is why
      // the cutter could never have caught it.
      expect(cutS).toBe(0);
      expect(seconds(wav)).toBeGreaterThan(30);
      expect(seconds(wav)).toBeLessThan(33);

      const decode = async (part: Uint8Array) => {
        const res = await fetch(`${WHISPER}/v1/audio/transcriptions`, {
          method: "POST",
          // exactly what server.ts sends: raw 16k mono s16le wav bytes
          headers: { "content-type": "audio/wav" },
          body: part,
          signal: AbortSignal.timeout(240_000),
        });
        expect(res.ok).toBe(true);
        return (((await res.json()) as { text?: string }).text ?? "").replace(/\s+/g, " ").trim();
      };

      // THE MUTATION, run first. One 31.69 s part is what the old fold produced:
      // over the window, so whisper decodes a second window holding 1.69 s and
      // answers it with its tell for silence.
      const folded = await decode(wav);
      console.log(`[folded, 1 part] ...${folded.slice(-70)}`);
      expect(folded.toLowerCase()).toContain("thank you");

      // ...and the fix. Both parts inside the window and above the floor.
      const parts = chunkAtQuiet(wav);
      expect(parts.length).toBe(2);
      for (const p of parts) {
        expect(seconds(p)).toBeGreaterThanOrEqual(3);
        expect(seconds(p)).toBeLessThanOrEqual(30);
      }
      const text = (await Promise.all(parts.map(decode))).join(" ").replace(/\s+/g, " ").trim();
      console.log(`[cut, ${parts.length} parts] ${text}`);

      // Both ends of what he said, so this cannot pass by losing the recording.
      const low = text.toLowerCase();
      expect(low).toContain("you have too many agents running");
      expect(low).toContain("declare that they are done");
      expect(low).not.toContain("thank you");
    },
    300_000,
  );
});
