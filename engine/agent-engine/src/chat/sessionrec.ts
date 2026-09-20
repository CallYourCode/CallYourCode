/* THE SESSION RECORD: what the harness did, as one line in the agent's own
 * chat log.
 *
 * A `t:"s"` line sits in agents/<agentId>/chats/<chatId>.jsonl next to the
 * `t:"m"` message lines and shares their seq axis, so one page holds both in
 * one order and an attach paints everything from the two pages it already
 * ships. The record is the engine's OWN copy of a transcript event (prompt,
 * reply, tool, compact) or an engine-authored fact about the session
 * (status edge, ask, delivery, mux/harness lifecycle, fork, note); it never
 * points the app back at the harness file.
 *
 * `seq` is storage order and `ts` is display order: a backfill appends old
 * events after new ones (their seq is high, their ts is old) and the app
 * sorts by ts as it always has for events.
 *
 *   bun test agent-engine/src/chat/chatstore.test.ts
 */

export const SESSION_REC_KINDS = [
  "prompt", "reply", "tool", "compact", "interrupt", "model", "context",
  "status", "ask", "delivered", "delivery.failed", "mux", "harness", "fork",
  "note",
] as const;
export type SessionRecKind = (typeof SESSION_REC_KINDS)[number];

/** Where a transcript-sourced record came from: the idempotency key of the
 *  ingest. `h` is the harness, `sid` its session id, `rid` the record id in
 *  that transcript (claude: the line's uuid), `off` the byte offset of the
 *  line in the file when it was read (informational: a rewritten file moves
 *  it; only the key `h|sid|rid` is trusted). */
export type SessionRecSrc = { h: string; sid: string; rid: string; off: number };

export type SessionRec = {
  /** storage order, shared with the chat messages of the same log */
  seq: number;
  /** display order (the transcript's timestamp, or the engine's clock) */
  ts: number;
  /** `se-` + 16 base64url chars, minted once per record */
  id: string;
  kind: SessionRecKind;
  /** the app's text for this record; already sized per kind by the extractor
   *  (one-liners at TEXT_CAP=200, prompt/reply bodies at BODY_CAP=20000) and
   *  bounded here by REC_TEXT_CAP only as a safety net */
  text: string;
  tool?: { name: string; input?: unknown };
  /** kind:"prompt" only: where the input came from (session-events InputSource) */
  source?: string;
  /** source:"agent" only: the sending agent's id */
  sender?: string;
  status?: string;
  model?: string;
  ctx?: { tokens: number; window: number };
  src?: SessionRecSrc;
  mux?: { m: string; handle: string; ev: string };
};

/* The chat-log safety bound, NOT a second content cap. Per-kind sizing already
 * happened in the extractor (sessions/session-events.ts: one-liner kinds at
 * TEXT_CAP=200, prompt/reply bodies at BODY_CAP=20000); capText only guards
 * against a pathological uncapped caller. Keep this >= BODY_CAP in
 * sessions/session-events.ts (the per-kind body cap) so a legitimate body is
 * never re-truncated here. (Literal, not an import: sessionrec is a zero-import
 * leaf and must not depend on the fs-touching extractor.) */
export const REC_TEXT_CAP = 20000;

const SESSION_REC_KIND_SET: ReadonlySet<string> = new Set(SESSION_REC_KINDS);

export function isSessionRecKind(k: unknown): k is SessionRecKind {
  return typeof k === "string" && SESSION_REC_KIND_SET.has(k);
}

/* `se-` plus 16 base64url chars (12 random bytes): the same shape as the
 * agent id mint, a different prefix so a record id can never be mistaken for
 * an agent or a message. */
export function mintSessionRecId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `se-${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_")}`;
}

/** The idempotency key of a transcript-sourced record, or null for an
 *  engine-authored one (those dedupe on kind+ts+text instead). */
export function srcKey(rec: { src?: SessionRecSrc }): string | null {
  const s = rec.src;
  if (!s) return null;
  return `${s.h}|${s.sid}|${s.rid}`;
}

/** The engine-authored dedupe key: the same fact stamped at the same instant
 *  with the same words is the same record. */
export function factKey(rec: { kind: string; ts: number; text: string }): string {
  return `${rec.kind}|${rec.ts}|${rec.text}`;
}

/** The safety bound on a record's text (see REC_TEXT_CAP): the extractor has
 *  already sized each record per kind, so this only clamps a pathological
 *  uncapped caller, never a legitimate body. */
export function capText(text: string): string {
  return text.length > REC_TEXT_CAP ? text.slice(0, REC_TEXT_CAP - 1) + "…" : text;
}

/** A `t:"s"` line as replayed off disk, or null when it is not one this
 *  build can believe (no seq, no ts, no id, or an unknown kind). Unknown
 *  extra fields ride along: a newer build's record is still a record. */
export function parseSessionRec(raw: Record<string, unknown>): SessionRec | null {
  const seq = raw.seq;
  const ts = raw.ts;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return null;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (!isSessionRecKind(raw.kind)) return null;
  const { t: _t, ...rest } = raw;
  const rec = rest as unknown as SessionRec;
  rec.text = typeof raw.text === "string" ? raw.text : "";
  if (rec.src && (typeof rec.src !== "object" || typeof rec.src.rid !== "string")) delete rec.src;
  return rec;
}
