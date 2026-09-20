/* ONE RECORD PER RECORDING, and the ONE merge rule (#550).
 *
 * The record collapses the streamed-words floor into a single function. This
 * file pins that function against the incident it exists for and exercises the
 * record's small state machine directly.
 *
 * THE FAIL-BEFORE (#550, structural). Before #550 the merge was
 * unconditional: whatever the batch decode returned REPLACED the streamed
 * words, so an empty decode blanked a note the device had already shown him
 * (two of his real messages went out as ""). `oldMergeUnconditional` below is
 * that pre-#550 shape, ported as a reference, and the first case shows the two
 * disagree exactly where the incident was: a fifty-char prefix, an empty
 * decode, and the old merge yields "" while wordsOf keeps the prefix. It is
 * non-vacuous by construction -- the reference reproduces the bug the record
 * cannot.
 *
 *   bun test agent-engine/src/voice/transcript-record.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  admitPartial, keptPrefix, noteDecodeResult, noteDecodeStart, recordCount,
  release, setTranscriptRecordLog, transcriptRecord, wordsOf,
} from "./transcript-record.ts";

/* THE PRE-#550 MERGE, ported as a reference. The batch decode result replaces
 * the streamed words unconditionally: no floor, no compare. This is the shape
 * that shipped the incident. */
function oldMergeUnconditional(settledPrefix: string, decoded: string): string {
  return decoded;
}

/* A unique recording id per case, so the module-level registry never carries
 * state between tests; release is exercised on its own below. */
let n = 0;
const rid = () => `rec-${++n}-${Math.random().toString(36).slice(2, 8)}`;

afterEach(() => {
  setTranscriptRecordLog(() => {});
});

describe("#550 the merge rule, against the ported old merge", () => {
  test("an empty decode: the old merge blanks the note, wordsOf keeps the prefix", () => {
    const id = rid();
    const fifty = "fifty chars of speech the device settled on....".padEnd(50, ".");
    expect(fifty.length, "the incident's prefix was fifty chars of speech").toBe(50);
    admitPartial(id, { text: fifty, upToS: 6 });
    noteDecodeResult(id, { state: "failed", text: "" });

    /* The reference reproduces the incident... */
    expect(oldMergeUnconditional(fifty, "")).toBe("");
    /* ...and the record cannot: the floor stands. */
    expect(wordsOf(id)).toBe(fifty);
    expect(keptPrefix(id)).toBe(true);
    release(id);
  });

  test("a decode longer than the prefix: both agree, the successful decode wins", () => {
    const id = rid();
    const prefix = "the opening";
    const decoded = "the opening and the whole decoded tail past it";
    admitPartial(id, { text: prefix, upToS: 5 });
    noteDecodeResult(id, { state: "decoded", text: decoded });

    expect(oldMergeUnconditional(prefix, decoded)).toBe(decoded);
    expect(wordsOf(id)).toBe(decoded);
    expect(keptPrefix(id)).toBe(false);
    release(id);
  });
});

describe("the record's state machine", () => {
  test("admitPartial is write-once: a second partial is ignored and logged", () => {
    const id = rid();
    const logged: { event: string; fields: Record<string, unknown> }[] = [];
    setTranscriptRecordLog((event, fields) => logged.push({ event, fields }));

    admitPartial(id, { text: "the first settled words", upToS: 4 });
    admitPartial(id, { text: "a later, different transcript", upToS: 9 });

    expect(transcriptRecord(id)!.settledPrefix).toEqual({ text: "the first settled words", upToS: 4 });
    expect(logged.some((l) => l.event === "transcript.partial-ignored"),
      "the write-once violation was swallowed silently").toBe(true);
    release(id);
  });

  test("admitPartial validates as the frame does: empty text or a non-positive upToS is no floor", () => {
    const id = rid();
    admitPartial(id, { text: "   ", upToS: 5 });
    admitPartial(id, { text: "real words", upToS: 0 });
    admitPartial(id, { text: "real words", upToS: Number.NaN });
    expect(transcriptRecord(id)?.settledPrefix ?? null,
      "an invalid partial was admitted as a floor").toBeNull();
    /* ...and a valid one after them still takes (write-once counts only real ones). */
    admitPartial(id, { text: "real words", upToS: 3 });
    expect(transcriptRecord(id)!.settledPrefix).toEqual({ text: "real words", upToS: 3 });
    release(id);
  });

  test("a timed-out decode keeps the settled prefix", () => {
    const id = rid();
    admitPartial(id, { text: "keep these streamed words", upToS: 6 });
    noteDecodeStart(id, "tail");
    noteDecodeResult(id, { state: "timeout" });
    expect(wordsOf(id)).toBe("keep these streamed words");
    expect(keptPrefix(id)).toBe(true);
    expect(transcriptRecord(id)!.decode.state).toBe("timeout");
    release(id);
  });

  test("a failed tail then a whole-clip fallback: the mode transitions and the whole read wins", () => {
    const id = rid();
    admitPartial(id, { text: "the settled opening", upToS: 5 });
    noteDecodeStart(id, "tail");
    /* The tail failed (no result recorded for it), and the engine reads the
     * whole clip once as a fallback. */
    noteDecodeStart(id, "whole-fallback");
    const whole = "the entire clip start to finish, longer than the opening";
    noteDecodeResult(id, { state: "decoded", text: whole });

    expect(transcriptRecord(id)!.decode.mode).toBe("whole-fallback");
    expect(transcriptRecord(id)!.decode.state).toBe("decoded");
    expect(wordsOf(id)).toBe(whole);
    expect(keptPrefix(id)).toBe(false);
    release(id);
  });

  test("no prefix and no decode is the honest empty string", () => {
    const id = rid();
    expect(wordsOf(id)).toBe("");
    expect(keptPrefix(id)).toBe(false);
    noteDecodeResult(id, { state: "failed", text: "" });
    expect(wordsOf(id)).toBe("");
    release(id);
  });

  test("a late decode after release leaves no orphan record (D1)", () => {
    /* The WORDS_WAIT_MS deadline path: readWords returns via the timeout race
     * and deliver releases the id; the uncancelled decode later resolves and
     * calls noteDecodeResult. That late writer must not resurrect the record. */
    const id = rid();
    admitPartial(id, { text: "streamed words the device settled", upToS: 6 });
    noteDecodeStart(id, "tail");
    release(id);
    const before = recordCount();

    /* The slow /stt finally comes back, well past the deadline. */
    expect(() => noteDecodeResult(id, { state: "decoded", text: "the whole late decode" }))
      .not.toThrow();

    expect(transcriptRecord(id), "a released id was resurrected by a late decode").toBeUndefined();
    expect(recordCount(), "the late decode orphaned a record in the map").toBe(before);
    expect(recordCount(), "the records map did not return to empty").toBe(0);
    /* And the words never regress: the released recording answers empty. */
    expect(wordsOf(id)).toBe("");
  });

  test("release drops the record; a later read is empty again", () => {
    const id = rid();
    admitPartial(id, { text: "some words", upToS: 3 });
    noteDecodeResult(id, { state: "decoded", text: "some words and more decoded" });
    expect(wordsOf(id)).toBe("some words and more decoded");
    release(id);
    expect(transcriptRecord(id), "the record survived release").toBeUndefined();
    expect(wordsOf(id), "a released recording still answered with words").toBe("");
    /* And release is idempotent: a second release on a gone record is a no-op. */
    release(id);
    expect(wordsOf(id)).toBe("");
  });
});
