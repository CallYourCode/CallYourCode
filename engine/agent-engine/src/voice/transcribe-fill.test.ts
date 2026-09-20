/* The deferred-words pipeline's pure half (transcribe.ts): the marker regex,
 * fillWords' replace-and-move rule, and the timeout classifier. No engine, no
 * voice engine. */

import { describe, expect, test } from "bun:test";
import { fillWords, wordsToken, isTimeoutAbort, WORDS_TOKEN_RE } from "./transcribe.ts";
import type { UploadRec } from "../chat/chatmsg.ts";

const up = (id: string, extra: Partial<UploadRec> = {}): UploadRec =>
  ({ uploadId: id, name: "n", mime: "audio/webm", size: 1, path: "/x", image: false, ...extra });

const ID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("wordsToken / WORDS_TOKEN_RE", () => {
  test("the mint and the regex agree", () => {
    const tok = wordsToken(ID_A);
    WORDS_TOKEN_RE.lastIndex = 0;
    const m = WORDS_TOKEN_RE.exec(tok);
    expect(m?.[1]).toBe(ID_A);
  });

  test("the regex accepts the id shapes the app actually mints, and nothing looser", () => {
    /* The app builds the same string from the same uploadId, so the charset has
     * to cover a uuid in either case and a short hex id, while refusing anything
     * that could smuggle markup or a path through the body. */
    const ok = [ID_A, ID_A.toUpperCase(), "0123abcd", "a".repeat(64)];
    for (const id of ok) {
      WORDS_TOKEN_RE.lastIndex = 0;
      expect(WORDS_TOKEN_RE.exec(wordsToken(id))?.[1]).toBe(id);
    }
    for (const bad of ["short", "zzzzzzzz", "aaaa aaaa", "a".repeat(65), "../../etc", "<script>"]) {
      WORDS_TOKEN_RE.lastIndex = 0;
      expect(WORDS_TOKEN_RE.test(wordsToken(bad))).toBe(false);
    }
  });

  test("the shared regex is global, so every reader resets lastIndex first", () => {
    /* WORDS_TOKEN_RE is a module-level /g regex: exec() leaves lastIndex behind
     * and the NEXT reader would start mid-string. fillWords goes through
     * String.replace (which resets it), but a direct exec caller must not. */
    const body = `${wordsToken(ID_A)} ${wordsToken(ID_B)}`;
    WORDS_TOKEN_RE.lastIndex = 0;
    expect(WORDS_TOKEN_RE.exec(body)?.[1]).toBe(ID_A);
    expect(WORDS_TOKEN_RE.lastIndex).toBeGreaterThan(0); // it really is stateful
    expect(WORDS_TOKEN_RE.exec(body)?.[1]).toBe(ID_B);
    WORDS_TOKEN_RE.lastIndex = 0;
  });
});

describe("fillWords", () => {
  test("fills a marker with its words and reports it filled", () => {
    const u = up(ID_A, { at: 0 });
    const r = fillWords(`${wordsToken(ID_A)} and more`, [u], new Map([[ID_A, "hello world"]]));
    expect(r.text).toBe("hello world and more");
    expect(r.filled).toEqual([ID_A]);
    expect(r.unread).toEqual([]);
    expect(u.textLen).toBe("hello world".length);
  });

  test("an unreadable clip becomes an empty fill, reported unread", () => {
    const u = up(ID_A, { at: 0 });
    const r = fillWords(wordsToken(ID_A), [u], new Map());
    expect(r.text).toBe("");
    expect(r.unread).toEqual([ID_A]);
    expect(u.textLen).toBeUndefined();
  });

  test("a QUOTED marker naming a recording not on this message is left alone", () => {
    const quoted = `> what does ${wordsToken(ID_B)} do again?\n${wordsToken(ID_A)}`;
    const u = up(ID_A, { at: quoted.indexOf(wordsToken(ID_A)) });
    const r = fillWords(quoted, [u], new Map([[ID_A, "my answer"]]));
    expect(r.text).toContain(wordsToken(ID_B)); // his text, untouched
    expect(r.text).toContain("my answer");
    expect(r.kept).toEqual([ID_B]);
  });

  test("offsets after a marker move by exactly what the edit changed", () => {
    const tok = wordsToken(ID_A);
    const text = `${tok} then a doc`;
    const a = up(ID_A, { at: 0 });
    const b = up(ID_B, { at: text.indexOf("then") }); // measured against the SENT body
    fillWords(text, [a, b], new Map([[ID_A, "hi"]]));
    // the marker shrank from tok.length to 2 chars; b's offset moves back with it
    expect(b.at).toBe(text.indexOf("then") - (tok.length - 2));
  });

  test("an offset BEFORE a marker does not move at all", () => {
    const tok = wordsToken(ID_A);
    const text = `see this ${tok}`;
    const before = up(ID_B, { at: 4 });          // a doc attached at "this"
    const own = up(ID_A, { at: text.indexOf(tok) });
    fillWords(text, [before, own], new Map([[ID_A, "the words"]]));
    expect(before.at).toBe(4);
    // and the marker's own offset is where the words now start
    expect(own.at).toBe(text.indexOf(tok));
  });

  test("two markers move a later offset by the SUM of both edits", () => {
    /* The bug this rules out: applying only the nearest marker's delta. With two
     * fills before it, a trailing attachment has to move by both. */
    const a = wordsToken(ID_A);
    const b = wordsToken(ID_B);
    const ID_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const text = `${a} ${b} tail`;
    const ua = up(ID_A, { at: 0 });
    const ub = up(ID_B, { at: text.indexOf(b) });
    const uc = up(ID_C, { at: text.indexOf("tail") });
    const r = fillWords(text, [ua, ub, uc], new Map([[ID_A, "one"], [ID_B, "two"]]));
    expect(r.text).toBe("one two tail");
    expect(r.filled).toEqual([ID_A, ID_B]);
    expect(uc.at).toBe(r.text.indexOf("tail"));
    expect(ua.at).toBe(0);
    expect(ub.at).toBe(r.text.indexOf("two"));
  });

  test("an attachment with no offset is left without one", () => {
    // `at` is optional; inventing a 0 would drop a doc chip to the top of the
    // message it was attached at the end of
    const u = up(ID_A, { at: 0 });
    const noAt = up(ID_B);
    fillWords(wordsToken(ID_A), [u, noAt], new Map([[ID_A, "hi"]]));
    expect(noAt.at).toBeUndefined();
  });

  test("a body with no markers comes back untouched, offsets included", () => {
    const u = up(ID_A, { at: 7, textLen: 3 });
    const r = fillWords("no markers here at all", [u], new Map([[ID_A, "words"]]));
    expect(r).toEqual({ text: "no markers here at all", filled: [], unread: [], kept: [] });
    expect(u.at).toBe(7);
    expect(u.textLen).toBe(3); // the early return must not clear it either
  });

  test("a refill that reads nothing clears a textLen an earlier fill set", () => {
    /* textLen is what the app highlights as "these words came from that clip".
     * A stale length after a failed re-read would underline the wrong text. */
    const u = up(ID_A, { at: 0, textLen: 11 });
    const r = fillWords(wordsToken(ID_A), [u], new Map());
    expect(r.unread).toEqual([ID_A]);
    expect(u.textLen).toBeUndefined();
  });

  test("whitespace-only words count as unread, not as a filled empty transcript", () => {
    // the decoder answering " \n " is silence; reporting it filled would hide a
    // clip nobody could read
    const u = up(ID_A, { at: 0 });
    const r = fillWords(`${wordsToken(ID_A)} tail`, [u], new Map([[ID_A, "  \n "]]));
    expect(r.filled).toEqual([]);
    expect(r.unread).toEqual([ID_A]);
    expect(r.text).toBe(" tail");
  });

  test("words are trimmed before they go in, so no double space appears", () => {
    const u = up(ID_A, { at: 0 });
    const r = fillWords(`${wordsToken(ID_A)} tail`, [u], new Map([[ID_A, "  hello  "]]));
    expect(r.text).toBe("hello tail");
    expect(u.textLen).toBe(5);
  });

  test("filled, unread and kept partition the markers with no overlap", () => {
    const ID_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const text = `${wordsToken(ID_A)} ${wordsToken(ID_B)} ${wordsToken(ID_C)}`;
    const ua = up(ID_A, { at: 0 });
    const ub = up(ID_B, { at: text.indexOf(wordsToken(ID_B)) });
    const r = fillWords(text, [ua, ub], new Map([[ID_A, "yes"]]));
    expect(r.filled).toEqual([ID_A]);   // decoded
    expect(r.unread).toEqual([ID_B]);   // ours, but nobody could read it
    expect(r.kept).toEqual([ID_C]);     // his text, never ours to fill
    expect(r.text).toContain(wordsToken(ID_C));
  });

  test("the same marker twice in one body is filled at both sites", () => {
    // a quoted-then-answered pattern where he pasted the marker again; the
    // replace pass is over the WHOLE body, so both go
    const tok = wordsToken(ID_A);
    const u = up(ID_A, { at: 0 });
    const r = fillWords(`${tok} and ${tok}`, [u], new Map([[ID_A, "hi"]]));
    expect(r.text).toBe("hi and hi");
    expect(r.filled).toEqual([ID_A, ID_A]);
  });

  test("calling fillWords twice in a row is not affected by the global regex's state", () => {
    // String.replace resets lastIndex, but a regression that switched to exec()
    // would make the SECOND call start mid-body and silently miss a marker
    const u1 = up(ID_A, { at: 0 });
    const first = fillWords(wordsToken(ID_A), [u1], new Map([[ID_A, "one"]]));
    const u2 = up(ID_A, { at: 0 });
    const second = fillWords(wordsToken(ID_A), [u2], new Map([[ID_A, "two"]]));
    expect(first.text).toBe("one");
    expect(second.text).toBe("two");
  });
});

describe("isTimeoutAbort", () => {
  test("recognises the TimeoutError shape and nothing else", () => {
    expect(isTimeoutAbort({ name: "TimeoutError" })).toBe(true);
    expect(isTimeoutAbort(new Error("HTTP 500"))).toBe(false);
    expect(isTimeoutAbort(null)).toBe(false);
  });

  test("a real AbortSignal.timeout rejection is recognised", () => {
    // the shape the runtime actually throws, not just the duck type above
    const e = new DOMException("The operation timed out.", "TimeoutError");
    expect(isTimeoutAbort(e)).toBe(true);
  });

  test("a user abort is NOT a timeout", () => {
    /* The whole point of the classifier: a deadline must not trip the once-only
     * whole-clip fallback that a genuine decode FAILURE trips. An AbortError
     * (the pane closed, the send was cancelled) is neither. */
    expect(isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isTimeoutAbort({ name: "AbortError" })).toBe(false);
  });

  test("non-objects and near misses answer false rather than throwing", () => {
    for (const v of [undefined, 0, "", "TimeoutError", [], { name: "timeouterror" }, { name: 1 }]) {
      expect(isTimeoutAbort(v)).toBe(false);
    }
  });
});
