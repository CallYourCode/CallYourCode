/* Cut long silent runs out of a clip before it reaches the decoder.
 *
 * Whisper loops on silence. Not "sometimes", and not only at low confidence:
 * measured 2026-07-30 on the user's own 94.2 s capture
 * (`64d8b05a-b2ce-47cd-b1f4-86c0af58669d`), which has a 10 s pause at 43.5 s and
 * a 25 s pause at 60 s. Posted to whisper-server exactly the way `transcribe()`
 * posts it, the decode is correct up to "...when the call is in conversation
 * mode." and then emits the word "and" EIGHTY-SEVEN times and stops. Everything
 * the user said after the pause is gone. That transcript is in `.run/chat.json`
 * for `w9:p4`; it is what he read on his phone, twice in one day.
 *
 * Two things it is worth being exact about, because both were measured and both
 * are easy to get wrong:
 *
 *   * **The temperature ladder is a mitigator, not the cause.** Dropping
 *     `temperature_inc=0` from the request (so whisper's own repetition-loop
 *     fallback fires) turns 87 "and"s into three "Then, I think..."s plus a
 *     hallucinated "Thank you." at the end. Better and still wrong, and
 *     `temperature_inc=0` is there to stop the ten-minute decode measured under
 *     greedy decoding, so taking it out trades one failure for another.
 *   * **Removing the silence fixes it outright**, with `temperature_inc=0` left
 *     exactly as it is: the same clip, silences cut, decodes clean and complete
 *     to the last word. So the fix is to stop handing the model silence, which
 *     is the whole of this file.
 *
 * What it may and may not remove. It only ever deletes audio that is below
 * -45 dBFS for at least 3 UNBROKEN seconds, and it leaves a second of that run
 * behind as breathing room, so the seam is still a pause and not a splice. Three
 * seconds under -45 dBFS cannot contain a spoken word, which is the property
 * that makes this safe: it cannot eat a short note, however short, because a
 * short note is not silent. A clip with no such run is returned BYTE-IDENTICAL,
 * so the ordinary voice note takes exactly the path it takes today.
 *
 * Cutting audio out of the middle would be a problem if anything downstream
 * cared about time. Nothing does: `transcribe()` reads `body.text` and throws
 * the rest away, and the segment timestamps whisper returns are never looked
 * at. The STREAMING path is where timestamps matter, and that path is not this
 * one -- it does its own windowing over `outerWindowCut` below (server.ts,
 * /stt-stream).
 */

const RATE = 16000;
const FRAME = 320; // 20 ms at 16 kHz
/** dBFS at or under which a frame counts as silence. ONE definition of "quiet"
 * for every transcription path: both the batch and the streaming decoders read
 * it through this file, so they cannot disagree about the same clip. (The
 * retired python streamer carried its own copy; that other half is gone.) */
const SILENCE_DBFS = -45;
/** Shortest silent run worth cutting, seconds. Long enough that no pause
 * inside a sentence reaches it. */
const GAP_S = 3;
/** How much of a cut run stays, seconds, split evenly across the seam. The
 * decoder still hears a pause where the user paused, so the sentence boundary
 * survives; it just does not hear twenty-five of them. */
const KEEP_S = 1;
/** Longest audio handed to whisper in ONE request, seconds. 30 because that is
 * whisper's own window: a request this long is decoded as a single window, so
 * there is no second window for a first one to poison. See `chunkAtQuiet`. */
const CHUNK_MAX_S = 30;
/** Earliest a chunk may end, seconds. The boundary is the quietest 20 ms frame
 * anywhere in [CHUNK_MIN_S, CHUNK_MAX_S], so this is how much room the search
 * has to find a real pause: 10 s of it. */
const CHUNK_MIN_S = 20;
/** Shortest a FINAL part may be, seconds. Below this whisper stops hearing a
 * request and starts hearing silence, and answers it with "Thank you." It is
 * enforced by the cut search rather than after the fact, because a part that is
 * over the window has a runt WINDOW inside it and that fails the same way; see
 * chunkAtQuiet. */
const CHUNK_TAIL_MIN_S = 3;

export type Trimmed = {
  /** The wav to send. Identical to the input when nothing was cut. */
  wav: Uint8Array;
  /** Audio seconds removed. 0 means the input was passed straight through. */
  cutS: number;
};

type Pcm = { samples: Int16Array; headerEnd: number; rate: number; channels: number };

/** Locate the `data` chunk of a 16-bit PCM wav. Returns null for anything this
 * cutter should not touch (compressed, stereo, wrong rate, truncated), which
 * is the signal to pass the bytes through untouched rather than guess.
 *
 * Exported so the batch loop (src/server.ts transcribe) can read the
 * sample count of a decoded window without a second parser: one place decides
 * what a wav this engine made looks like. */
export function parseWav(buf: Uint8Array): Pcm | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 44) return null;
  if (dv.getUint32(0, false) !== 0x52494646) return null; // "RIFF"
  if (dv.getUint32(8, false) !== 0x57415645) return null; // "WAVE"
  let p = 12;
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  while (p + 8 <= buf.byteLength) {
    const id = dv.getUint32(p, false);
    const size = dv.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 0x666d7420 && body + 16 <= buf.byteLength) {
      // "fmt "
      format = dv.getUint16(body, true);
      channels = dv.getUint16(body + 2, true);
      rate = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
    } else if (id === 0x64617461) {
      // "data". ffmpeg writing to a pipe cannot backfill the size, so a bogus
      // or oversized value means "to the end of the file", not "corrupt".
      const avail = buf.byteLength - body;
      const n = size === 0 || size > avail ? avail : size;
      if (format !== 1 || bits !== 16 || channels !== 1 || rate !== RATE) return null;
      if (n < 2) return null;
      const even = n - (n % 2);
      return {
        samples: new Int16Array(buf.buffer.slice(buf.byteOffset + body, buf.byteOffset + body + even)),
        headerEnd: body,
        rate,
        channels,
      };
    }
    p = body + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

/** Per-frame loudness, one rms per 20 ms, in int16 units. */
function frameRms(s: Int16Array): Float64Array {
  const n = Math.floor(s.length / FRAME);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const base = i * FRAME;
    for (let j = 0; j < FRAME; j++) {
      const v = s[base + j]!;
      acc += v * v;
    }
    out[i] = Math.sqrt(acc / FRAME);
  }
  return out;
}

/** Per-frame "is this 20 ms quiet", as a plain boolean array. */
function quietFrames(s: Int16Array): boolean[] {
  const floor = Math.pow(10, SILENCE_DBFS / 20) * 32768; // dBFS -> rms in int16
  const rms = frameRms(s);
  const out: boolean[] = new Array(rms.length);
  for (let i = 0; i < rms.length; i++) out[i] = rms[i]! < floor;
  return out;
}

/** Every silent run of at least GAP_S, as [firstSample, lastSample) pairs to
 * delete, already shrunk by KEEP_S/2 at each end. Exported for the test, which
 * has to be able to say WHERE it cut and not only how much. */
export function silentCuts(samples: Int16Array): Array<[number, number]> {
  const quiet = quietFrames(samples);
  const need = Math.ceil((GAP_S * RATE) / FRAME);
  const pad = Math.round((KEEP_S / 2) * RATE);
  const cuts: Array<[number, number]> = [];
  let i = 0;
  while (i < quiet.length) {
    if (!quiet[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < quiet.length && quiet[j]) j++;
    if (j - i >= need) {
      const a = i * FRAME + pad;
      const b = j * FRAME - pad;
      if (b > a) cuts.push([a, b]);
    }
    i = j;
  }
  return cuts;
}

/** How many seconds of this wav are above the speech floor.
 *
 * The audio half of "a stock phrase has to prove itself" (stock.ts). It lives
 * here because the floor and the frame size have to be the ones the cutter
 * above uses: one definition of quiet for the whole batch path, so the thing
 * that removes silence and the thing that disbelieves words over silence
 * cannot disagree about the same twenty milliseconds.
 *
 * WHOLE WAV, no time range, and that is the correction rather than a
 * simplification. The first version took a span, so that a single sentence
 * inside a long transcript could be checked against the audio under it using
 * whisper's own segment timings. Those timings are not good enough to carry a
 * deletion: 12 of 168 FINAL segments in the corpus claim a span with no voiced
 * audio in it at all and every one of them is a real word he said. (That count
 * is CITED from this lane's verifier, not measured here; stock.ts carries the
 * caveat and what was reproduced directly instead.) So the question
 * is only ever asked about a whole decoder request, where the audio is exactly
 * what was sent and no timestamp is involved. */
export function voicedSeconds(wav: Uint8Array): number {
  const pcm = parseWav(wav);
  // Not a wav this understands, so it has no opinion, and "no opinion" has to
  // mean "there was speech" rather than "there was none": that is the same
  // pass-through rule trimLongSilences takes above, and it keeps the two from
  // disagreeing about an input neither of them can read.
  if (!pcm) return Infinity;
  const m = new VoicedMeter();
  m.addInt16(pcm.samples);
  return m.seconds;
}

/** The same question, asked of audio that arrives a frame at a time.
 *
 * `voicedSeconds` above needs the whole wav in hand, and the STREAMING path
 * never has it: the relay forwards float32 PCM frames to the decoder and keeps
 * none of them, deliberately -- a ten minute recording held in memory to
 * answer one boolean is a leak, not a measurement. So the count is kept
 * instead of the audio: one integer, advanced as the bytes go past.
 *
 * IT IS THE SAME COUNT, not a second opinion. `voicedSeconds` is now written in
 * terms of this class, so the batch path and the streaming path cannot come to
 * different conclusions about the same twenty milliseconds -- which is the
 * property that let the two paths disagree in the first place, and the whole
 * reason this exists rather than a parallel implementation.
 *
 * Frames are 20 ms and the wire does not respect that boundary, so a partial
 * frame is carried to the next chunk rather than counted or dropped. The tail
 * left over at the end (under 20 ms) is not counted, exactly as
 * `frameRms` ignores the same tail of a wav. */
export class VoicedMeter {
  /** dBFS floor as an rms in int16 units, computed once. */
  private static readonly FLOOR = Math.pow(10, SILENCE_DBFS / 20) * 32768;
  private loud = 0;
  /** how much of the current 20 ms frame has arrived, and its running sum of
   * squares. The SAMPLES are not kept: rms needs only these two numbers, so a
   * frame that spans two wire chunks costs nothing to finish. */
  private restN = 0;
  private acc = 0;

  /** Seconds of audio seen so far that were at or above the speech floor. */
  get seconds(): number {
    return (this.loud * FRAME) / RATE;
  }

  /** float32 samples in [-1, 1], the shape the browser puts on the wire. */
  addFloat32(s: Float32Array): void {
    for (let i = 0; i < s.length; i++) this.push(s[i]! * 32768);
  }

  addInt16(s: Int16Array): void {
    for (let i = 0; i < s.length; i++) this.push(s[i]!);
  }

  /** Raw wire bytes: little-endian float32, any length. A byte count that is
   * not a multiple of 4 is a frame this cannot read, so the trailing bytes are
   * ignored rather than reinterpreted. */
  addFloat32Bytes(bytes: Uint8Array): void {
    const whole = bytes.byteLength - (bytes.byteLength % 4);
    if (whole <= 0) return;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, whole);
    for (let o = 0; o < whole; o += 4) this.push(dv.getFloat32(o, true) * 32768);
  }

  private push(v: number): void {
    this.acc += v * v;
    if (++this.restN < FRAME) return;
    if (Math.sqrt(this.acc / FRAME) >= VoicedMeter.FLOOR) this.loud++;
    this.restN = 0;
    this.acc = 0;
  }
}

export function writeWav(samples: Int16Array): Uint8Array {
  const bytes = samples.length * 2;
  const out = new Uint8Array(44 + bytes);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x52494646, false); // RIFF
  dv.setUint32(4, 36 + bytes, true);
  dv.setUint32(8, 0x57415645, false); // WAVE
  dv.setUint32(12, 0x666d7420, false); // "fmt "
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, RATE, true);
  dv.setUint32(28, RATE * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits
  dv.setUint32(36, 0x64617461, false); // "data"
  dv.setUint32(40, bytes, true);
  out.set(new Uint8Array(samples.buffer, samples.byteOffset, bytes), 44);
  return out;
}

/** Remove silent runs of GAP_S or longer from a 16 kHz mono 16-bit wav.
 *
 * Returns the input unchanged (the same object) when there is nothing to cut or
 * when the wav is not the shape this understands. It never returns nothing: each
 * cut leaves KEEP_S behind, and two silent runs cannot be adjacent (something
 * loud separates them), so whatever comes out is at least KEEP_S long. An
 * entirely silent clip -- a mistaken tap, a muted mic -- therefore comes back as
 * one second of silence rather than sixty, which is the right answer: the clip
 * still reaches the decoder and still reaches the app's existing junk-audio
 * handling, it just no longer gives whisper sixty seconds of nothing to
 * hallucinate over. Nothing here can discard a note, only shorten a pause. */
export function trimLongSilences(wav: Uint8Array): Trimmed {
  const pcm = parseWav(wav);
  if (!pcm) return { wav, cutS: 0 };
  const cuts = silentCuts(pcm.samples);
  if (cuts.length === 0) return { wav, cutS: 0 };

  let removed = 0;
  for (const [a, b] of cuts) removed += b - a;
  const kept = pcm.samples.length - removed;

  const out = new Int16Array(kept);
  let w = 0;
  let read = 0;
  for (const [a, b] of cuts) {
    out.set(pcm.samples.subarray(read, a), w);
    w += a - read;
    read = b;
  }
  out.set(pcm.samples.subarray(read), w);
  return { wav: writeWav(out), cutS: removed / RATE };
}

/** Split a long clip into decoder-sized pieces, each cut at the quietest point
 * available, so no single request is longer than whisper's own window.
 *
 * This is the OTHER half of "never hand the decoder something it loops on", and
 * it is here because the cutter above is not enough on its own. Measured
 * 2026-08-02 on the user's 220 s capture `ff655532-c7af-41df-8261-eda2ed3a65cf`
 * (`c-msa4bt6n-d2a83`, 2026-08-01), the one whose live caption read correctly at
 * 2009 characters and whose batch decode came back at 3118 saying "I don't know
 * what I'm doing" over and over:
 *
 *   * The cutter DID fire on it -- 7.4 s removed at 78 s, 95 s and 104 s -- and
 *     the decode still degenerated. The clip has no long mid-recording pause at
 *     all: its longest silent run is 3.9 s.
 *   * Both loops ran for exactly 30 s of output, whisper's window length, one at
 *     144 s and one from 198 s to the end.
 *   * **Those same two windows, cut out and posted on their own, decode
 *     perfectly**: "...email outbound that needs cracking and inbound marketing
 *     which is SEO stuff...", "Or I could head to the gym, I could go to the
 *     beach. It's a quiet life." So the audio was never the problem, and neither
 *     was silence in it. Sixty seconds of speech was destroyed by the decode
 *     being ONE 212 s request, in which whisper carries each window's tokens
 *     into the next as context and `temperature_inc=0` has
 *     taken away its own repetition fallback.
 *
 * So the batch path gets what the streaming path has always had: a bounded
 * window. The streaming decoder (once the python streamer, now server.ts's
 * /stt-stream) never hands the model more than the uncommitted tail, which is
 * why a bad pass there cannot own thirty seconds of transcript or poison the
 * pass after it. Here the same bound is CHUNK_MAX_S per request.
 *
 * Where it cuts matters as much as that it cuts. The boundary is the QUIETEST
 * 20 ms frame in the ten seconds before the limit, the same idea as
 * `_quiet_point` in the retired python streamer: on that capture every one of the nine cuts
 * landed on a frame at -120 dBFS, digital silence, so no word was split. It is
 * a minimum, not a threshold -- some frame is always the quietest -- because a
 * threshold that fails to match has to cut anyway, and the quietest point is
 * the best answer available whatever its level.
 *
 * A clip of CHUNK_MAX_S or less comes back as `[wav]`, the SAME object: the
 * ordinary voice note is still one request with byte-identical bytes. */
export function chunkAtQuiet(wav: Uint8Array): Uint8Array[] {
  const pcm = parseWav(wav);
  if (!pcm || pcm.samples.length <= CHUNK_MAX_S * RATE) return [wav];
  const rms = frameRms(pcm.samples);
  const out: Uint8Array[] = [];
  let start = 0;
  while (pcm.samples.length - start > CHUNK_MAX_S * RATE) {
    const from = Math.floor((start + CHUNK_MIN_S * RATE) / FRAME);
    /* THE TAIL NEEDS A FLOOR, and this is not tidiness. Without one, a clip a
     * hair over a multiple of the bound leaves a sub-second part, and whisper
     * answers a sub-second request with its tell for silence: a bare
     * "Thank you." Measured over every recording in .run/audio long enough to
     * split -- 331 clips, 12 of them left a final part under a second, and all
     * twelve decoded to "Thank you." So the transcript reads correct and
     * complete and then has a sentence he never said stapled to the end of it,
     * which then goes to the session as his words.
     *
     * app.js's STOCK_SILENCE already knows that string, but it only fires when
     * the WHOLE transcript is it, so a runt tail sails straight through.
     *
     * THE FLOOR HAS TO BE IN THE SEARCH, and the first version of it was not:
     * it cut wherever it liked and then folded a runt tail back into the part
     * before it, on the reasoning that a single part of 30.3 s is "a request
     * whisper handles in a single window". It is not. Whisper's window is
     * exactly 30 s, so a 31.7 s part is two windows, the second one holding
     * 1.7 s of audio -- the runt, moved from its own request into its own
     * WINDOW, where the same thing happens for the same reason and nothing
     * downstream can see the boundary any more.
     *
     * Measured on `9ac33829`, 31.69 s, his own recording, 2026-08-05: folded
     * into one part it decodes correctly and then says "Thank you." at
     * 30.00-31.00, whisper's window boundary to the centisecond. Cut instead
     * at the quietest frame in [20 s, 28.69 s], so both parts fit a window,
     * the same clip and the same server return every real word and no
     * "Thank you." at all.
     *
     * So the upper bound of the search is whichever comes first: the window,
     * or the last point that still leaves a floor's worth behind. The range
     * cannot be empty -- the loop only runs while more than CHUNK_MAX_S is
     * left, and CHUNK_MAX_S minus CHUNK_TAIL_MIN_S is still past
     * CHUNK_MIN_S -- so there is no folding case left to handle. */
    const limit = Math.min(
      start + CHUNK_MAX_S * RATE,
      pcm.samples.length - CHUNK_TAIL_MIN_S * RATE,
    );
    const to = Math.min(rms.length, Math.floor(limit / FRAME));
    // <=, so a tie goes to the LATEST quietest frame. Ties are the normal case
    // rather than a curiosity: the pauses in these captures are digital silence,
    // dozens of frames at rms 0 exactly, and taking the last one makes the parts
    // as long as the bound allows instead of as short as it allows.
    let best = from;
    for (let i = from; i < to; i++) if (rms[i]! <= rms[best]!) best = i;
    const cut = best * FRAME + FRAME / 2; // mid-frame: the quiet is on both sides
    out.push(writeWav(pcm.samples.subarray(start, cut)));
    start = cut;
  }
  out.push(writeWav(pcm.samples.subarray(start)));
  return out;
}

/** The OUTER bound, seconds: how much of a long clip the batch decoder holds in
 * memory at once. `chunkAtQuiet` above bounds a single decoder REQUEST to
 * whisper's 30 s window; this bounds how much PCM the engine materializes before
 * it releases it. They are different jobs.
 *
 * WHY A SECOND, LARGER BOUND EXISTS. `transcribe()` used to decode the whole
 * clip to one PCM wav, full-copy trim it, and split it into every 30 s part at
 * once, holding all of it. On a 30 minute note (measured #449) that drove the
 * voice engine's RSS to ~1.86 GB against its 2 GB launchd ceiling, and launchd
 * killed it mid-request: the transcription never returned and the note shipped
 * as "(voice note: transcription failed)". So the clip is now decoded and
 * transcribed one WINDOW_S window at a time, each released before the next, and
 * peak memory is one window's worth of PCM (~19 MB at 10 min) rather than the
 * clip's.
 *
 * WHY 10 MINUTES. The transcript-quality bound is the 30 s whisper window, and
 * `chunkAtQuiet` already enforces it INSIDE every window regardless of how big
 * the window is, so this number changes memory and nothing else. 10 minutes
 * keeps a window's PCM near 19 MB (a copy for the trim and a copy for the parts
 * put the peak near ~80 MB, an order under the 700 MB the test asserts and two
 * under the old blowup), while making the fewest window seams: three on a 30
 * minute clip, versus six at 5 minutes. Fewer seams is fewer re-seeks and fewer
 * places a word could land on a boundary. */
export const WINDOW_S = Number(process.env.VOICE_WINDOW_S ?? 600);
/** How far past WINDOW_S the seam may travel to find a pause, seconds. The
 * window boundary is cut at the quietest 20 ms frame in [WINDOW_S, WINDOW_S +
 * WINDOW_SEARCH_S] -- the same idea as `chunkAtQuiet`'s inner cut, one scale up
 * -- so a window ends on a pause and no word is split across two windows. */
export const WINDOW_SEARCH_S = 10;

/** The sample to cut a full window at, so the next window starts on a pause.
 *
 * Only called when the window is FULL (there is more audio past it): a short
 * final window is transcribed whole and never reaches here, so the search range
 * [WINDOW_S, WINDOW_S + WINDOW_SEARCH_S] is always inside the samples given.
 * Sums of squares are compared directly (sqrt is monotonic, so the quietest
 * frame is the same either way) and only the search range is scanned, so this
 * costs a tenth of a second of arithmetic and allocates nothing. `<=` breaks
 * ties toward the LATEST quietest frame, the same choice `chunkAtQuiet` makes,
 * so the window is as long as the bound allows. */
export function outerWindowCut(samples: Int16Array): number {
  const from = Math.floor((WINDOW_S * RATE) / FRAME);
  const to = Math.min(
    Math.floor(samples.length / FRAME),
    Math.floor(((WINDOW_S + WINDOW_SEARCH_S) * RATE) / FRAME),
  );
  // The search range is above the samples given (a window ffmpeg returned a hair
  // short of a full one): there is no seam to find, so keep the whole window.
  if (to <= from) return samples.length;
  let best = from;
  let bestSs = Infinity;
  for (let i = from; i < to; i++) {
    let acc = 0;
    const base = i * FRAME;
    for (let j = 0; j < FRAME; j++) {
      const v = samples[base + j]!;
      acc += v * v;
    }
    if (acc <= bestSs) {
      bestSs = acc;
      best = i;
    }
  }
  return best * FRAME + FRAME / 2; // mid-frame: the quiet is on both sides
}
