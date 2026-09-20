/* The transcript flattener, and the defect it exists for.
 *
 *   CYC_WHISPER_URL=http://127.0.0.1:2099 bun test src/stt/transcript.test.ts
 *
 * CYC_WHISPER_URL is REQUIRED for the decoding half and has no default; unset,
 * that half is SKIPPED, and bun counts it as skipped rather than passed.
 *
 * Two halves, like silence.test.ts, and for the same reason.
 *
 * The **unit** half is pure string work: no audio, no decoder, so there is no
 * synthetic-audio question to answer. It pins the seams, which are the only
 * part of this that is easy to get wrong.
 *
 * The **regression** half is the actual defect on the actual recording through
 * the actual whisper server: `.run/audio/2052d3e4-...webm`, the 17 s note whose
 * transcript reached the user (and the session) hard-wrapped, quoted verbatim
 * in `.run/chat.json` under session `w9:p4`. It needs the clip and a
 * whisper-server of your own, so it SKIPS when either is missing rather than
 * failing, and it says so loudly.
 *
 * Shown to fail without the fix. `CYC_NO_FLATTEN=1` returns `text.trim()`, the
 * way the code did before this change, and the regression check then says:
 *
 *     error: expect(received).not.toContain(expected)
 *
 *     Expected to not contain: "\n"
 *     Received: "messages, which are the session messages, should just take\n
 *      the full width on all the devices.\n I mean, the full width of the
 *      messaging bubble with\n appropriate margins, but the width should not
 *      be\n constrained."
 *
 *       at <anonymous> (src/stt/transcript.test.ts:139:23)
 *     (fail) the capture that arrived pre-wrapped (2026-07-30, w9:p4) > a 17 s
 *            note comes back as one line, not five
 *
 * i.e. four breaks, none of them at a sentence end, one of them between "take"
 * and "the full width" -- and that string is character for character the one
 * the user read on his phone, `.run/chat.json`, `w9:p4`, msgId 2052d3e4.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { flattenTranscript } from "./transcript";
import { trimLongSilences } from "../audio/silence";

describe("flattenTranscript", () => {
  test("joins whisper's segment breaks with a single space", () => {
    const raw = " messages, which are the session messages, should just take\n the full width on all the devices.\n";
    const out = flattenTranscript(raw);
    expect(out).not.toContain("\n");
    expect(out).toContain("should just take the full width");
  });

  test("the seams: no double space where a leading-space segment follows a break", () => {
    // whisper's segments each begin with a space, so the boundary is
    // " take" + "\n" + " the" -- a newline BETWEEN two spaces.
    expect(flattenTranscript("one two\n three four")).toBe("one two three four");
    expect(flattenTranscript("a\n\n b")).toBe("a b");
    expect(flattenTranscript("a \n\t b")).toBe("a b");
    expect(flattenTranscript("one two\n three four")).not.toContain("  ");
  });

  test("the head and the tail", () => {
    // head: leading space on the first segment. tail: trailing newline.
    expect(flattenTranscript(" hello there.\n")).toBe("hello there.");
    expect(flattenTranscript("\n\n hello \n\n")).toBe("hello");
  });

  test("empty and whitespace-only stay empty", () => {
    expect(flattenTranscript("")).toBe("");
    expect(flattenTranscript("\n \n")).toBe("");
  });

  test("a transcript with no breaks is unchanged apart from the trim", () => {
    expect(flattenTranscript("nothing to do here")).toBe("nothing to do here");
  });
});

// --------------------------------------------------------------- the real one

const CLIP = "2052d3e4-ff31-4b1d-b81b-285d93a2236d.webm";
const CLIP_PATHS = [
  process.env.CYC_TRANSCRIPT_CLIP,
  new URL(`../../../.run/audio/${CLIP}`, import.meta.url).pathname,
  `${process.env.HOME}/projects/personal/callyourcode/.run/audio/${CLIP}`,
].filter(Boolean) as string[];

const clipPath = CLIP_PATHS.find((p) => existsSync(p));

/* The decoder this posts to. THERE IS NO DEFAULT, and that is the point.
 *
 * This file used to post to `http://127.0.0.1:10103` with no way to override it,
 * which is the whisper-server the user is talking to on his own machine: a bare
 * `bun test voice-engine/src/` sent his decoder a 17 s job and raced him for his own
 * GPU, and the skip line said ":10103" whether or not that was where it went.
 * `silence.test.ts` had the same trap and lost it; this file kept it, which is
 * the whole reason the trap has to be closed per file rather than per fix.
 *
 * `CYC_WHISPER_URL=http://127.0.0.1:2099 bun test src/stt/transcript.test.ts`
 * with a stt/server.py of your own (STT_BATCH_PORT on a scratch port) on that port. */
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
 * Returning early makes bun count the test as PASSED. With nothing set up, this
 * file reported "5 pass / 0 fail" and exit 0 with the decoding half never run,
 * and the only sign was a console line. There is no CI here, so the reader of
 * that summary is a future agent deciding whether the change is covered.
 * skipIf makes the summary say "skip". */
const noDecode = !WHISPER || !clipPath;
if (noDecode) {
  console.log(clipPath ? noWhisper() : `SKIPPED: ${CLIP} is not staged. Looked in:\n  ${CLIP_PATHS.join("\n  ")}`);
}

describe("the capture that arrived pre-wrapped (2026-07-30, w9:p4)", () => {
  test.skipIf(noDecode)(
    "a 17 s note comes back as one line, not five",
    async () => {
      if (!(await whisperUp())) {
        console.log(noWhisper());
        return;
      }

      // Everything below is what transcribe() does, in the same order.
      const ff = Bun.spawn(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", clipPath!, "-ac", "1", "-ar", "16000",
         "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const raw = new Uint8Array(await new Response(ff.stdout).arrayBuffer());
      await ff.exited;
      expect(raw.byteLength).toBeGreaterThan(44);

      const { wav } = trimLongSilences(raw); // this clip has no long pause; passes through
      const res = await fetch(`${WHISPER}/v1/audio/transcriptions`, {
        method: "POST",
        // exactly what server.ts sends: raw 16k mono s16le wav bytes
        headers: { "content-type": "audio/wav" },
        body: wav,
        signal: AbortSignal.timeout(240_000),
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { text?: string };
      const upstream = body.text ?? "";
      console.log(`[whisper raw] ${JSON.stringify(upstream)}`);

      // The upstream body is the thing being defended against: if whisper ever
      // stops breaking lines this test would pass vacuously, so say it out loud.
      expect(upstream).toContain("\n");

      // CYC_NO_FLATTEN=1 returns what transcribe() returned before this fix.
      // That is the mutation: same clip, same server, same request.
      const out = process.env.CYC_NO_FLATTEN === "1" ? upstream.trim() : flattenTranscript(upstream);
      console.log(`[transcribe] ${JSON.stringify(out)}`);

      // The symptom, as an assertion. This is the wire text: what the bubble
      // shows AND what the session is handed.
      expect(out).not.toContain("\n");
      expect(out).not.toContain("\r");
      // ...and the seams held: no run of two spaces anywhere a break was.
      expect(out).not.toContain("  ");
      // Head and tail.
      expect(out).toBe(out.trim());
      // The words are all still there, across the break he quoted.
      expect(out.toLowerCase()).toContain("should just take the full width on all the devices");
      expect(out.toLowerCase()).toContain("constrained");
    },
    300_000,
  );
});
