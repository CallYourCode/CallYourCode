/* ONE RECORD PER RECORDING: the single answer to "what
 * are the words" for a clip, and the one place the streamed-words floor rule
 * (#550) lives.
 *
 * Six mechanisms used to answer that question -- device partials off the frame,
 * the engine's tail/whole decode, the once-only whole-clip fallback, the inline
 * rescue race, the deferred pending-note completion, and the floor-keep rule --
 * and each kept the words in its own locals and promise closures, with the
 * floor rule copied into two of them. The lineage (task 165, 292, #442, #458,
 * #550) is a rule patched in one copy and missed in the other: two real notes
 * went out as "" when an empty decode overwrote the streamed words.
 *
 * A record holds two facts and nothing else: the device's SETTLED PREFIX (the
 * floor, write-once) and the engine's DECODE RESULT (raw, before the merge).
 * `wordsOf` is THE merge: the decode replaces the prefix only when it holds at
 * least as many trimmed chars, otherwise the prefix stands. Every consumer
 * reads that one function; nobody re-implements the compare.
 *
 * No new persistence: the transcriptPending row remains the durable marker
 * exactly as before, and `release` only drops the in-memory record once the
 * message has delivered or completed.
 *
 *   bun test agent-engine/src/voice/transcript-record.test.ts
 */

/** How far a recording's decode has got. `idle` is a record that only carries a
 *  settled prefix; the terminal states are what the rescue race and the pending
 *  completion read instead of writing words of their own. */
export type DecodeState = "idle" | "decoding" | "decoded" | "timeout" | "failed";

/** Which read produced the decode text: the tail past the settled prefix, the
 *  whole clip, or the whole clip read as a fallback after a tail failed. */
export type DecodeMode = "tail" | "whole" | "whole-fallback";

export type TranscriptRecord = {
  recordingId: string;   // uploadId, or the note's msgId (a cid alias is accepted)
  settledPrefix: { text: string; upToS: number } | null; // device floor, write-once
  decode: {
    state: DecodeState;
    mode?: DecodeMode;
    text?: string;       // raw decode output, BEFORE the floor merge
  };
};

/** The frame's per-recording partial, SettledPartial-shaped. Accepted loosely
 *  because admitPartial is the validator (see below). */
type PartialLike = { text?: unknown; upToS?: unknown } | null | undefined;

/* The one registry, keyed by recordingId. A record is created by whichever call
 * touches it first and dropped by release; there is never more than one per
 * recording in flight. */
const records = new Map<string, TranscriptRecord>();

/* POST-RELEASE RESURRECTION GUARD. A recordingId is unique and used once;
 * once `release` drops its record the recording is done forever. A decode that
 * completes AFTER the WORDS_WAIT_MS deadline (its background Promise is not
 * cancelled) still calls a writer -- noteDecodeResult -- and `ensure` used to
 * recreate a fresh record for the already-released id that nothing ever freed,
 * one orphan per timed-out-then-late recording. Released ids are remembered so
 * `ensure` refuses to resurrect them; writers no-op when it does. */
const released = new Set<string>();

/* WHERE THE WRITE-ONCE VIOLATION IS SAID. The engine's own log when it is
 * wired (initTranscribe sets it); a no-op until then, so a record built before
 * boot -- there is none -- does not throw. */
let logFn: (event: string, fields: Record<string, unknown>) => void = () => {};
export function setTranscriptRecordLog(fn: (event: string, fields: Record<string, unknown>) => void): void {
  logFn = fn;
}

function ensure(id: string): TranscriptRecord | undefined {
  let r = records.get(id);
  if (!r) {
    /* Never rebuild a released record: a late writer must not resurrect it. */
    if (released.has(id)) return undefined;
    r = { recordingId: id, settledPrefix: null, decode: { state: "idle" } };
    records.set(id, r);
  }
  return r;
}

/** The device's streaming decoder already settled these words. Validated as
 *  deliver.ts validates a frame partial today: non-empty trimmed text, a finite
 *  `upToS` past zero. WRITE-ONCE: a second partial for the same recording is
 *  ignored and logged, because the floor is the first thing the device showed
 *  him and a later frame cannot lower it. */
export function admitPartial(id: string, partial: PartialLike): void {
  const text = typeof partial?.text === "string" ? partial.text : "";
  const upToS = Number(partial?.upToS);
  if (!text.trim() || !Number.isFinite(upToS) || upToS <= 0) return;
  const r = ensure(id);
  if (!r) return; // released: a late partial cannot resurrect the record
  if (r.settledPrefix) {
    logFn("transcript.partial-ignored", { id,
      why: "a settled prefix was already admitted for this recording; the record is " +
        "write-once and the second partial is ignored" });
    return;
  }
  r.settledPrefix = { text, upToS };
}

/** The engine has begun a decode, in this mode. Moves the record to `decoding`
 *  and records the mode (the tail attempt, or the whole-clip fallback after it
 *  fails). */
export function noteDecodeStart(id: string, mode: DecodeMode): void {
  const r = ensure(id);
  if (!r) return; // released: a late start cannot resurrect the record
  r.decode.state = "decoding";
  r.decode.mode = mode;
}

/** The decode's terminal result. `decoded` carries the raw text (before the
 *  floor merge); `timeout` and `failed` carry none, so the settled prefix (if
 *  any) stands. */
export function noteDecodeResult(id: string,
  res: { state: "decoded" | "timeout" | "failed"; text?: string }): void {
  const r = ensure(id);
  if (!r) return; // released: a late (post-deadline) decode leaves no orphan
  r.decode.state = res.state;
  if (res.text !== undefined) r.decode.text = res.text;
}

/* THE ONE MERGE. The decode replaces the settled prefix only when it holds at
 * least as many trimmed chars (#550); anything shorter -- the deadline's
 * nothing, a failed decode's "", a garbled short read -- keeps the prefix the
 * device already showed him. No prefix and no decode is "". */
function merge(r: TranscriptRecord | undefined): { text: string; keptPrefix: boolean } {
  const prefix = r?.settledPrefix ? r.settledPrefix.text.trim() : "";
  const decoded = (r?.decode.text ?? "").trim();
  if (decoded.length >= prefix.length) {
    /* The decode wins (this also covers "no prefix": prefix length is 0). With
     * neither a decode nor a prefix the honest answer is "". */
    return { text: r?.decode.text ?? "", keptPrefix: false };
  }
  return { text: prefix, keptPrefix: prefix.length > 0 };
}

/** THE words for this recording, floor applied. */
export function wordsOf(id: string): string {
  return merge(records.get(id)).text;
}

/** Whether the floor kept the settled prefix over a shorter (or absent) decode.
 *  The `keptStreamed` bookkeeping deliver.ts logs is read from here, not
 *  re-derived from a second copy of the compare. */
export function keptPrefix(id: string): boolean {
  return merge(records.get(id)).keptPrefix;
}

/** Read the record (for tests and for a consumer that wants the mode or state).
 *  Undefined when nothing has touched this recording. */
export function transcriptRecord(id: string): TranscriptRecord | undefined {
  return records.get(id);
}

/** The message delivered or completed: drop the in-memory record. No new
 *  persistence -- the transcriptPending row is still the durable marker. */
export function release(id: string): void {
  records.delete(id);
  released.add(id);
}

/** Live record count. Test-only: lets the resurrection guard assert the map is
 *  empty after a released id takes a late write. */
export function recordCount(): number {
  return records.size;
}
