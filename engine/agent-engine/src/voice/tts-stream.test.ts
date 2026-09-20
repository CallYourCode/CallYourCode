/* The sentence splitter and chunker for streaming TTS (#525).
 *
 * Pure functions, no engine: text in, chunks out. The job is to not butcher
 * ordinary prose, so the cases here are the ways a naive split-on-dot goes
 * wrong (abbreviations, initials, decimals, urls) plus the batching that keeps
 * the first chunk small and later chunks from firing one synth per short line.
 *
 *   bun test agent-engine/src/voice/tts-stream.test.ts
 */

import { test, expect } from "bun:test";
import { splitSentences, chunkText } from "./tts-stream.ts";

test("plain prose splits on . ! ?", () => {
  expect(splitSentences("One. Two! Three? Four.")).toEqual([
    "One.", "Two!", "Three?", "Four.",
  ]);
});

test("a reply with no terminator is one sentence", () => {
  expect(splitSentences("just a fragment with no full stop")).toEqual([
    "just a fragment with no full stop",
  ]);
});

test("empty or whitespace text yields no sentences", () => {
  expect(splitSentences("")).toEqual([]);
  expect(splitSentences("   \n  ")).toEqual([]);
});

test("common abbreviations do not end a sentence", () => {
  expect(splitSentences("Dr. Smith called. He was late.")).toEqual([
    "Dr. Smith called.", "He was late.",
  ]);
  expect(splitSentences("Meet Mr. and Mrs. Lee at the St. Paul stop.")).toEqual([
    "Meet Mr. and Mrs. Lee at the St. Paul stop.",
  ]);
});

test("bare initials do not end a sentence", () => {
  expect(splitSentences("J. R. R. Tolkien wrote it. I read it.")).toEqual([
    "J. R. R. Tolkien wrote it.", "I read it.",
  ]);
});

test("a decimal is not a boundary (no space after the dot)", () => {
  expect(splitSentences("It costs 3.14 dollars. That is cheap.")).toEqual([
    "It costs 3.14 dollars.", "That is cheap.",
  ]);
});

test("a dotted url does not split mid-domain", () => {
  expect(splitSentences("Go to example.com now. Then stop.")).toEqual([
    "Go to example.com now.", "Then stop.",
  ]);
});

test("runs of terminators break once, not per mark", () => {
  expect(splitSentences("Really?! Yes... I think so.")).toEqual([
    "Really?!", "Yes...", "I think so.",
  ]);
});

test("whitespace and newlines are collapsed", () => {
  expect(splitSentences("One.\n\nTwo.   Three.")).toEqual([
    "One.", "Two.", "Three.",
  ]);
});

test("the first chunk is a single ordinary sentence (fast first audio)", () => {
  const chunks = chunkText(
    "This first sentence is long enough to stand on its own here. Then a second one follows.",
  );
  expect(chunks[0]).toBe("This first sentence is long enough to stand on its own here.");
  expect(chunks.length).toBe(2);
});

test("very short leading sentences batch into the first chunk", () => {
  // none of these reaches firstTarget alone, so they ride together
  const chunks = chunkText("Hi. Ok. Sure.");
  expect(chunks).toEqual(["Hi. Ok. Sure."]);
});

test("later sentences batch toward the target rather than one synth each", () => {
  const many = Array.from({ length: 8 }, (_, i) => `Sentence number ${i} here.`).join(" ");
  const chunks = chunkText(many, { firstTarget: 20, target: 80 });
  // 8 short sentences must not become 8 chunks
  expect(chunks.length).toBeLessThan(8);
  // and joining the chunks back must reproduce the whole reply, in order
  expect(chunks.join(" ")).toBe(many);
});

test("a single sentence longer than target is still one chunk (never split mid-sentence)", () => {
  const long = "This one sentence runs well past the target length without any terminator inside it at all.";
  const chunks = chunkText(long, { firstTarget: 20, target: 40 });
  expect(chunks).toEqual([long]);
});

test("empty text yields no chunks", () => {
  expect(chunkText("")).toEqual([]);
  expect(chunkText("   ")).toEqual([]);
});

test("chunks always reconstruct the reply in order", () => {
  const text = "First sentence here. Second one. A third, slightly longer sentence to vary things. Done.";
  const chunks = chunkText(text);
  expect(chunks.join(" ")).toBe(text.replace(/\s+/g, " ").trim());
});

test("an abbreviation at the very end of the text is still not a boundary", () => {
  // the terminator run ends the string, so `next` is undefined; the abbreviation
  // check has to run on that path too or "etc." becomes a lone empty tail
  expect(splitSentences("Ends with an abbreviation etc.")).toEqual(["Ends with an abbreviation etc."]);
  expect(splitSentences("See fig. 4.")).toEqual(["See fig. 4."]);
  expect(splitSentences("Call approx. 5 people. Done.")).toEqual(["Call approx. 5 people.", "Done."]);
});

test("an abbreviation inside brackets or quotes is still found", () => {
  // the word before the dot is taken back to the last space, quote or open
  // paren, so "(e.g." reads as the abbreviation and not as "(e.g"
  expect(splitSentences("(e.g. this one) works. Yes.")).toEqual(["(e.g. this one) works.", "Yes."]);
});

test('a quoted full stop keeps the closing quote with its sentence', () => {
  /* `."` is a dot glued to a non-space, so the splitter reads straight past it.
   * The result is one longer chunk rather than a sentence that ends on a naked
   * quote mark, which is the right way to be wrong for TTS: prosody survives. */
  expect(splitSentences('He said "Stop." Then he left.')).toEqual(['He said "Stop." Then he left.']);
});

test("a dotted version number does not split at every dot", () => {
  expect(splitSentences("Version 1.2.3 shipped. Good.")).toEqual(["Version 1.2.3 shipped.", "Good."]);
});

test("a terminator glued to the next word is not a boundary", () => {
  // a typo, a file name, an ellipsis with no space: none of them is a sentence
  // end, and splitting there would cut a word in half mid-synth
  expect(splitSentences("Wait.Then go.")).toEqual(["Wait.Then go."]);
});

test("long runs of one terminator break exactly once each", () => {
  expect(splitSentences("Hi!!! Wow??? Ok.")).toEqual(["Hi!!!", "Wow???", "Ok."]);
  expect(splitSentences("Really?!")).toEqual(["Really?!"]);
});

test("a leading run of dots starts the first sentence rather than an empty one", () => {
  // an empty chunk would be a zero-length synth request; the splitter drops it
  expect(splitSentences("...odd start. Then more.")).toEqual(["...odd start.", "Then more."]);
  expect(splitSentences(".")).toEqual(["."]);
  expect(splitSentences(". . .")).toEqual([".", ".", "."]); // spaced dots ARE boundaries
});

test("the known tradeoff: 'no.' and a run of initials stay glued", () => {
  /* ABBREV is deliberately short, and "no" is in it, so "I saw no. It was gone."
   * does not split. Likewise a whole line of bare initials. Both cost one longer
   * synth; the alternative (a longer table) costs REAL boundaries, which is the
   * worse failure for speech. Documented here so a future edit to ABBREV knows
   * what it is trading. */
  expect(splitSentences("I saw no. It was gone.")).toEqual(["I saw no. It was gone."]);
  expect(splitSentences("a. b. c. Done.")).toEqual(["a. b. c. Done."]);
});

test("the terminator stays on its sentence, so the chunk still reads as speech", () => {
  // TTS prosody comes off the punctuation; a splitter that ate the mark would
  // flatten every question into a statement
  for (const s of splitSentences("Who? Me! Yes.")) expect(s).toMatch(/[.!?]$/);
});

test("the first chunk flushes at the target, not before it", () => {
  // the boundary is >=, so a first sentence exactly at firstTarget goes alone
  expect(chunkText("abcdefghij. klm.", { firstTarget: 11, target: 100 })).toEqual(["abcdefghij.", "klm."]);
  expect(chunkText("abcdefghij. klm.", { firstTarget: 12, target: 100 })).toEqual(["abcdefghij. klm."]);
});

test("a long sentence after short ones rides in the first chunk, not on its own", () => {
  /* The batcher only checks the size AFTER appending, so "Hi. Ok. Sure." plus a
   * long sentence is one chunk of ~97 chars rather than a fast 13-char first
   * one. It costs a slightly later first audio and saves a synth round trip;
   * this pins which side of that trade the code is on. */
  const chunks = chunkText("Hi. Ok. Sure. And then a much longer sentence that easily passes the sixty character first target.");
  expect(chunks).toHaveLength(1);
  expect(chunks[0].startsWith("Hi. Ok. Sure. And then")).toBe(true);
});

test("a fragment with no terminator is collapsed before it becomes the one chunk", () => {
  // the no-sentence path has its own collapse; a chunk full of newlines would
  // otherwise reach the voice engine as it was typed
  expect(chunkText("  spaced   out \n fragment  ")).toEqual(["spaced out fragment"]);
});

test("a zero target still emits one chunk per sentence, never an empty one", () => {
  expect(chunkText("One. Two.", { firstTarget: 0, target: 0 })).toEqual(["One.", "Two."]);
});

test("no chunk is ever empty or untrimmed, whatever the input", () => {
  const inputs = [
    "One. Two! Three?",
    "...",
    "  \n\t ",
    "Dr. Smith called. He was late.",
    "a".repeat(500),
    "Hi. ".repeat(50),
  ];
  for (const text of inputs) {
    for (const c of chunkText(text)) {
      expect(c.length).toBeGreaterThan(0);
      expect(c).toBe(c.trim());
    }
  }
});
