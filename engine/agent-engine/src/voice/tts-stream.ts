/* Sentence-splitting and chunking for streaming TTS (#525).
 *
 * The engine used to hand a whole spoken reply to the voice engine in one POST
 * and wait ~25s for the mp3. Now the reply is split into sentences, each is
 * synthesised on its own, and the chunks are appended to one clip on disk so the
 * app can start playing at the first chunk (~1-2s) and follow the file as it
 * grows. This module is the pure half of that: text in, chunks of text out. The
 * synthesis, the file append and the wire frames live in server.ts.
 *
 * A PRAGMATIC SPLITTER, NOT NLP. The job is to not butcher ordinary prose, not
 * to be right about every sentence in every language. It splits on . ! ? that
 * end a word and are followed by whitespace or the end of the text, and it
 * declines to split after a short list of abbreviations, after a bare initial
 * (the J in "J. R. R."), and inside a decimal (which has no space after the dot,
 * so the whitespace rule already covers it). Everything else is a boundary. */

// Words that take a trailing dot and are almost never a sentence end. Lowercased
// and compared without the dot. Deliberately short: a splitter that knows too
// many abbreviations starts refusing real boundaries ("I saw no. It was gone.").
const ABBREV = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "sr", "jr", "vs", "etc", "eg", "ie",
  "al", "fig", "gen", "col", "gov", "lt", "sgt", "capt", "cmdr", "corp", "inc",
  "ltd", "co", "dept", "univ", "approx", "apt", "est", "min", "max", "vol",
  "no", "nos", "pp", "ph", "e.g", "i.e",
]);

/** Split a run of text into sentences. Whitespace is collapsed first, so the
 *  chunks that come back are clean to feed to TTS and to join. */
export function splitSentences(text: string): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    // Consume a run of terminators so "?!" and "..." break once, not per mark.
    let j = i;
    while (j + 1 < t.length && (t[j + 1] === "." || t[j + 1] === "!" || t[j + 1] === "?")) j++;
    const next = t[j + 1];
    // A boundary is a terminator at end-of-text or before a space. Anything
    // else (a dot glued to the next character, as in a URL or a decimal) is not.
    if (next !== undefined && next !== " ") { i = j; continue; }
    // A single trailing dot may be an abbreviation or a bare initial rather than
    // a full stop. "!" and "?" and doubled dots ("...") are always boundaries.
    if (ch === "." && j === i) {
      const word = t.slice(start, i).split(/[\s("']/).pop()!.toLowerCase();
      if (ABBREV.has(word)) { i = j; continue; }
      if (/^[a-z]$/i.test(word)) { i = j; continue; } // bare initial: J. R. R.
    }
    const sentence = t.slice(start, j + 1).trim();
    if (sentence) out.push(sentence);
    start = j + 1;
    i = j;
  }
  const tail = t.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

export type ChunkOpts = {
  /* The first chunk is kept small so the first audio lands fast: as soon as the
   * accumulated first chunk reaches this many characters it is flushed, which
   * for ordinary prose means the very first sentence goes on its own. A run of
   * tiny leading sentences ("Hi. Ok. Sure.") batches up to this size instead of
   * firing three separate synths. ~15 chars is a second of speech. */
  firstTarget?: number;
  /* Every later chunk batches sentences until it reaches this size, so a long
   * reply is a handful of ~1-3s synths rather than one per sentence. A single
   * sentence longer than this is still its own chunk (never split mid-sentence). */
  target?: number;
};

/** Break text into the chunks the engine synthesises in order. The first is
 *  small (fast first audio); the rest batch short sentences toward `target`. A
 *  reply with no sentence terminator comes back as one chunk. */
export function chunkText(text: string, opts?: ChunkOpts): string[] {
  const firstTarget = opts?.firstTarget ?? 60;
  const target = opts?.target ?? 200;
  const sentences = splitSentences(text);
  if (sentences.length === 0) {
    const t = text.replace(/\s+/g, " ").trim();
    return t ? [t] : [];
  }
  const chunks: string[] = [];
  let cur = "";
  for (const sent of sentences) {
    cur = cur ? `${cur} ${sent}` : sent;
    const limit = chunks.length === 0 ? firstTarget : target;
    if (cur.length >= limit) { chunks.push(cur); cur = ""; }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
