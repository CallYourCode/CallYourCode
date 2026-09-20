/* A stock phrase has to prove itself before it is accepted.
 *
 * Whisper answers audio it cannot hear with a small, stable set of phrases:
 * "Thank you.", "Thanks for watching.", "Bye." That is a decode with nothing
 * behind it, and today it is delivered as the user's own words. His report,
 * 2026-08-01: a real message came back as "Thank you."
 *
 * The proof is the audio. Confidence cannot do it -- measuring
 * mean token probability on 168 real clips, the right and wrong outputs
 * overlap almost entirely, and `9ac33829`'s invented sentence comes back with
 * `no_speech_prob` 0.0000, the same as every real segment beside it. But there
 * is one question the audio answers with no ambiguity at all: was anything
 * said. A request with no speech in it cannot have produced a real word,
 * whatever words came back.
 *
 * ## What this deliberately does NOT do, and why
 *
 * It does not look at individual sentences inside a transcript, and the first
 * version of this file did. That version asked whisper for per-segment timings
 * (`response_format=verbose_json`) and checked the audio under each sentence's
 * own span, so it could strip a "Thank you." stapled to the end of an otherwise
 * correct 31 s recording.
 *
 * **Those timings are not good enough to carry a deletion.** Reported by this
 * lane's verifier on the 168-clip corpus (which carries the
 * same caveat and says why): 14 of 286 segments, and 12 of 168 FINAL segments,
 * claim a span containing no voiced audio whatsoever, and the Gemini reference
 * confirms every one of them is a real word he said -- "great.", "viewing.",
 * "see them here", "fixed", all with 0.000 s of audio under the span whisper
 * gave them. On 39 longer recordings, 8 of 442.
 *
 * **Those counts are CITED, not measured here.** The re-run was started twice
 * and abandoned: the GPU is shared with the decoder he is actually using and a
 * 168-clip pass did not finish in over an hour. What was reproduced directly is
 * the mechanism, on two of his recordings: `9ac33829`'s invented "Thank you." is
 * timed 30.00-31.00 and `976c25f9`'s is timed 30.00-59.98 on a clip 30.72 s
 * long, both with no audio under them. Nothing unsafe rests on the counts -- if
 * they were wrong, this rule is narrower than it needed to be, never wider.
 *
 * Either way a rule reading those spans deletes his words, in the region where
 * the hallucination also lives.
 *
 * So the question is only ever asked about a WHOLE decoder request: the audio
 * is exactly the bytes that were sent, and no timestamp is involved. The
 * stapled-sentence case is not this file's to fix and it does not need to be --
 * it is a window-boundary artifact, and the fix is in the chunker
 * (`chunkAtQuiet`, branch fix/voice-chunker-5), where every part is kept inside
 * whisper's 30 s window so there is no runt window for it to happen in.
 *
 * ## BOTH paths, which the first version of this file was not
 *
 * It shipped wired into `POST /stt` alone, and `POST /stt` is the one the app
 * reaches LAST. The app takes the streaming decoder's answer whenever there is
 * one and decodes the clip only when the stream had nothing to say (its
 * pipeline.ts: "batch now only speaks when the stream had nothing to say"), so
 * the guard sat on the fallback while the primary path ran unguarded.
 *
 * There is no model-family excuse for that either, and this was the assumption
 * worth checking rather than believing: the retired python stt server's
 * docstring named parakeet, but whisper was the hardcoded engine, and its live
 * streaming server answered `GET :10105/health` with `"engine": "whisper.cpp",
 * "model": "ggml-large-v3-turbo.bin"` after 18603 passes. The primary path is
 * the same whisper, inventing the same sentences.
 *
 * `unbackedStockAfter` is the same rule for that path. It differs only in how
 * the audio arrives -- counted frame by frame as it is relayed (`VoicedMeter`),
 * because the relay never holds the recording -- and the question, the list and
 * the threshold are one copy, asked of the whole stream from start to stop.
 *
 * ## The population, re-measured on everything he owns
 *
 * The table below was fitted on 200 discarded captures. It has since been
 * checked against ALL of them: 6923 real recordings, `.run/audio` (6572) and
 * `.run/uploads` (351), every one of them something a device actually recorded,
 * measured with `voicedSeconds` itself. The result is a cliff, not a slope:
 *
 *   | speech in the whole clip | clips |
 *   |---|---|
 *   | exactly 0.000 s | 7 |
 *   | 0.001 s to 0.119 s | **0** |
 *   | 0.120 s and up | 6916 |
 *
 * So the set this rule can fire on is 7 recordings in 6923 (0.10%), the nearest
 * real clip is at 0.120 s, and MIN_VOICED_S at 0.06 sits in the middle of an
 * empty gap rather than near anything. `0ffbb5ef` is one of the seven.
 *
 * ## The threshold, against the population it is applied to
 *
 * This is the other thing the first version got wrong: the number was derived
 * from whole-clip messages and then applied to segment spans, which is a
 * different population with a different distribution. Both sides are now
 * whole-request, and the second side is measured rather than assumed. 200 real
 * captures that the app recorded and discarded (echo, mistaken taps, false
 * triggers -- `.run/audio`, none of them a message, none of them synthetic):
 *
 *   | whole clips | speech in them |
 *   |---|---|
 *   | 168 real voice messages under 10 s | 0.120 s and up |
 *   | 194 discarded captures that decode to real words | 0.280 s and up |
 *   | 6 discarded captures that decode to a bare "Thanks." | 0.020, 0.420, 0.420, 0.460, 0.500, 0.940 |
 *   | `0ffbb5ef`, the delivered message that was only "Thank you." | 0.000 |
 *
 * ## So it fires rarely, and that is the honest headline
 *
 * Five of those six "Thanks." have most of a second of voice behind them. They
 * may be him and they may be whisper; nothing here can tell, so nothing here
 * touches them. Only the two with essentially nothing under them are decidable,
 * which puts the rate at about 1 capture in 200 and 1 delivered message in 871.
 *
 * It is not the general "Thank you." filter the idea asked for, and the reason
 * it is not is above: the general version needs per-sentence timings and those
 * delete his words. This is the part of the idea the evidence supports.
 *
 * ## What it can and cannot do
 *
 * It can only delete a phrase on the list, and only when the whole request said
 * nothing else, and only when there is no speech in that request. It cannot
 * invent a word, change one, shorten a real transcript, or touch a part that
 * has any speech in it. A real "Thanks." with a voice behind it is a real
 * message and this must never be the thing that loses it -- one has already
 * been eaten by a rule of this class.
 */

import { voicedSeconds } from "../audio/silence";

/* Whisper's stock outputs on audio it cannot hear, normalised: lowercase, no
 * punctuation.
 *
 * THIS IS THE APP'S OWN LIST, and it is not allowed to quietly grow past it.
 * `STOCK_SILENCE` in agent-engine/src/public/app.js is '', thank you, thanks,
 * thanks for watching, you, bye. An earlier version of this file added okay,
 * ok, goodbye and bye bye on the reasoning that whisper emits those too. It
 * does, and so does he: `ok` and `okay` are in the app's BACKCHANNEL, which is
 * deliberately ignored ONLY while a reply is playing, because "yes" said into
 * quiet is a real answer to a question. Adding them here overrides that
 * decision unconditionally and one layer upstream, where the app cannot see it
 * happen or tell him it did.
 *
 * The one addition is "thank you for watching", which is the same YouTube tell
 * as the entry the app already has and is not a sentence he has ever said.
 * ("thanks for watching!" is not a separate entry: normStock strips the "!".) */
/* Exported for the tests, which have to be able to assert that a phrase they
 * kept IS on this list -- a clip that survived by not being recognised would
 * prove nothing about the rule. Read-only by convention; nothing adds to it. */
export const STOCK = new Set([
  "thank you", "thanks", "thanks for watching", "thank you for watching",
  "you", "bye",
]);

/** Speech, in seconds, a whole request needs before anything it says is
 * believed. 0.06 s is three 20 ms frames: no spoken word is that short, let
 * alone a sentence. It sits three times above the loudest thing it fires on
 * (0.020 s) and twice below the quietest real voice message in the corpus
 * (0.120 s), with both sides measured on whole clips, which is the population
 * the rule is applied to. See the table above. */
const MIN_VOICED_S = 0.06;

/** lowercase, drop apostrophes and punctuation, collapse spaces. */
export function normStock(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Is this decode of this audio a claim with nothing behind it: the whole
 * transcript is one of whisper's tells and the request had no speech in it. */
export function unbackedStock(text: string, wav: Uint8Array): boolean {
  return unbackedStockAfter(text, voicedSeconds(wav));
}

/** The same rule for a caller that measured the audio itself.
 *
 * The STREAMING path cannot pass a wav: the relay forwards float32 frames to
 * the decoder and keeps none of them, so it counts voiced frames as they go
 * past (`VoicedMeter`) and arrives here with a number instead of bytes. Both
 * paths therefore ask ONE function about one threshold -- the alternative was a
 * second copy of `STOCK.has(...) && ... < 0.06`, which is two answers to one
 * question and drifts.
 *
 * `seconds` is still the whole request either way: for `/stt` it is the bytes
 * of one decoder request, for a stream it is every sample the browser sent
 * between start and stop. No timestamp is involved on either side, which is the
 * constraint the header of this file exists to defend. */
export function unbackedStockAfter(text: string, voicedS: number): boolean {
  return STOCK.has(normStock(text)) && voicedS < MIN_VOICED_S;
}
