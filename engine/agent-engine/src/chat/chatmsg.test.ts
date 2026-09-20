/* The chat message model (chatmsg.ts): attachment reading and writing, the
 * duration cleaner, the searchable text. Pure vectors, no disk, no engine.
 *
 * The reason attachments get this much attention for a pure module: the rows
 * this reads come off a jsonl written by whatever version of the engine ran
 * last, and one of its readers DELETES. `referencedUploads()` used to spell the
 * read `m.upload?.uploadId`, and the moment a message could carry two
 * attachments that spelling became a way to lose his audio: the file is in the
 * directory, the message points at it, and the sweep does not see the pointer.
 *
 *   bun test agent-engine/src/chat/chatmsg.test.ts
 */

import { describe, expect, test } from "bun:test";
import { cleanDuration, cleanUpload, attachmentsOf, searchableText, uploadIds,
  attachmentFields, type ChatMsg, type UploadRec } from "./chatmsg.ts";

const up = (id: string, extra: Partial<UploadRec> = {}): UploadRec =>
  ({ uploadId: id, name: `${id}.txt`, mime: "text/plain", size: 1, path: `/x/${id}`, image: false, ...extra });

describe("cleanDuration", () => {
  test("keeps sane whole seconds, rounds, drops garbage", () => {
    expect(cleanDuration(12.4)).toBe(12);
    expect(cleanDuration("7")).toBe(7);
    expect(cleanDuration(0)).toBeUndefined();       // 0 = not a recording
    expect(cleanDuration(-3)).toBeUndefined();
    expect(cleanDuration(Number.NaN)).toBeUndefined();
    expect(cleanDuration(Infinity)).toBeUndefined();
    expect(cleanDuration(86_401)).toBeUndefined();  // over a day is an accident
  });

  test("the day cap is inclusive, and half a second rounds up", () => {
    /* The boundary is worth pinning because the cap is a judgement (no voice
     * note reaches a day, every accident exceeds one) and an off-by-one here
     * would refuse a legitimate 24h recording or accept a garbage one. */
    expect(cleanDuration(86_400)).toBe(86_400);
    expect(cleanDuration(86_400.4)).toBe(86_400);
    expect(cleanDuration(86_400.6)).toBeUndefined(); // rounds to 86401, over
    expect(cleanDuration(0.4), "rounds to 0, which means 'not a recording'").toBeUndefined();
    expect(cleanDuration(0.5)).toBe(1);
  });

  test("anything that is not a number at all is absent, never NaN on the wire", () => {
    expect(cleanDuration(undefined)).toBeUndefined();
    expect(cleanDuration(null), "Number(null) is 0, which is not a recording").toBeUndefined();
    expect(cleanDuration("banana")).toBeUndefined();
    expect(cleanDuration({})).toBeUndefined();
    expect(cleanDuration([])).toBeUndefined();      // Number([]) is 0
  });
});

describe("cleanUpload", () => {
  test("returns the SAME object when nothing needs fixing (no spread churn)", () => {
    const u = up("a");
    expect(cleanUpload(u)).toBe(u);
    const ok = up("b", { durationS: 9 });
    expect(cleanUpload(ok), "a duration that is already clean is not a reason to rebuild").toBe(ok);
  });

  test("fixes durationS without dropping unrelated fields", () => {
    const u = up("a", { durationS: -5, fromPage: { label: "l", page: "p" }, at: 3, textLen: 2 });
    const out = cleanUpload(u);
    expect(out.durationS).toBeUndefined();
    expect(out.fromPage).toEqual({ label: "l", page: "p" });
    expect(out.at).toBe(3);
    expect(out.textLen).toBe(2);
  });

  test("a bad duration is DELETED, not left as undefined on the record", () => {
    /* `durationS: undefined` survives JSON.stringify as an absent key, but the
     * in-memory record is what the echo and the broadcast carry, and a key that
     * exists with an undefined value reads differently to `"durationS" in u`. */
    const out = cleanUpload(up("a", { durationS: Number.NaN }));
    expect("durationS" in out).toBe(false);
  });

  test("a rounded duration is written back, and the input is left untouched", () => {
    const u = up("a", { durationS: 3.7 });
    const out = cleanUpload(u);
    expect(out.durationS).toBe(4);
    expect(out).not.toBe(u);
    expect(u.durationS, "the caller's record was mutated under it").toBe(3.7);
  });
});

describe("attachmentsOf", () => {
  const msg = (m: Partial<ChatMsg>): ChatMsg => ({ id: "s", role: "user", text: "", ts: 1, ...m });

  test("uploads, when present, IS the list; upload is only its first copy", () => {
    const m = msg({ uploads: [up("a"), up("b")], upload: up("z") });
    expect(attachmentsOf(m).map((u) => u.uploadId)).toEqual(["a", "b"]);
  });

  test("old rows with upload alone still read", () => {
    expect(attachmentsOf(msg({ upload: up("only") })).map((u) => u.uploadId)).toEqual(["only"]);
  });

  test("a message with nothing attached is an empty list, not a throw", () => {
    expect(attachmentsOf(msg({}))).toEqual([]);
    expect(attachmentsOf(msg({ uploads: [] })), "an empty plural field is still the list")
      .toEqual([]);
  });

  test("junk entries off disk are ignored, not believed", () => {
    const m = msg({ uploads: [up("a"), null as any, "junk" as any] });
    expect(attachmentsOf(m).map((u) => u.uploadId)).toEqual(["a"]);
    expect(attachmentsOf(msg({ uploads: "not an array" as any }))).toEqual([]);
    expect(attachmentsOf(msg({ uploads: 7 as any }))).toEqual([]);
  });

  test("a uploads array that survives nothing falls back to the singular field", () => {
    /* The old shape wearing a broken new one. Reading zero attachments here
     * would hide a file the message really carries from the uploads sweep. */
    const m = msg({ uploads: [null as any], upload: up("survivor") });
    expect(attachmentsOf(m).map((u) => u.uploadId)).toEqual(["survivor"]);
  });

  test("a singular field that is not an object is not an attachment", () => {
    expect(attachmentsOf(msg({ upload: "a-string" as any }))).toEqual([]);
    expect(attachmentsOf(msg({ upload: null as any }))).toEqual([]);
  });

  test("every entry is cleaned on the way out, not only the first", () => {
    const m = msg({ uploads: [up("a", { durationS: -1 }), up("b", { durationS: 2.6 })] });
    const got = attachmentsOf(m);
    expect(got[0].durationS).toBeUndefined();
    expect(got[1].durationS).toBe(3);
    expect(attachmentsOf(msg({ upload: up("z", { durationS: 0 }) }))[0].durationS).toBeUndefined();
  });
});

describe("attachmentFields / uploadIds", () => {
  test("writes the pair (uploads in order + upload as first), nothing when empty", () => {
    const ups = [up("a"), up("b")];
    expect(attachmentFields(ups)).toEqual({ upload: ups[0], uploads: ups });
    expect(attachmentFields([])).toEqual({});
  });

  test("the pair round-trips through the reader, in order", () => {
    /* The one rule the two halves share: what attachmentFields writes is what
     * attachmentsOf reads back, same list, same order. */
    const ups = [up("a"), up("b"), up("c")];
    const written = attachmentFields(ups);
    const msg: ChatMsg = { id: "s", role: "user", text: "", ts: 1, ...written };
    expect(attachmentsOf(msg).map((u) => u.uploadId)).toEqual(["a", "b", "c"]);
    expect(written.upload, "the singular copy must be the FIRST, not any of them").toBe(ups[0]);
  });

  test("a single attachment still writes both fields, so an old bundle draws it", () => {
    const one = [up("solo")];
    expect(attachmentFields(one)).toEqual({ upload: one[0], uploads: one });
  });

  test("uploadIds joins for the log, undefined when none", () => {
    expect(uploadIds([up("a"), up("b")])).toBe("a,b");
    expect(uploadIds([up("a")])).toBe("a");
    expect(uploadIds([]), "the log field disappears rather than reading `upload=`")
      .toBeUndefined();
  });
});

describe("searchableText", () => {
  const msg = (m: Partial<ChatMsg>): ChatMsg => ({ id: "s", role: "user", text: "", ts: 1, ...m });

  test("text wins; then the shown file's name; then every attached name", () => {
    expect(searchableText(msg({ text: "hello" }))).toBe("hello");
    expect(searchableText(msg({ file: { docId: "d", name: "plan.md", fileKind: "markdown", size: 1 } }))).toBe("plan.md");
    expect(searchableText(msg({ uploads: [up("a"), up("b")] }))).toBe("a.txt b.txt");
    expect(searchableText(msg({}))).toBe("");
  });

  test("the order is a preference, not a concatenation", () => {
    /* A caption beats the file name it was sent with; a shown document's name
     * beats an attachment's. Searching for the second of four attachments still
     * has to find the message, which is why the attachment case joins them. */
    const all = msg({
      text: "the caption",
      file: { docId: "d", name: "plan.md", fileKind: "markdown", size: 1 },
      uploads: [up("a"), up("b")],
    });
    expect(searchableText(all)).toBe("the caption");
    expect(searchableText({ ...all, text: "" })).toBe("plan.md");
  });

  test("an uncaptioned voice note is findable by the name it was stored under", () => {
    const note = msg({ kind: "voice", upload: up("clip", { name: "note-3.webm" }) });
    expect(searchableText(note)).toBe("note-3.webm");
  });
});
