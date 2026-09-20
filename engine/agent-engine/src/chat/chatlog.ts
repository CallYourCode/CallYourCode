/* THE CHAT LOG (L2 domain): stamping, sequencing, appending, the reply dedupe
 * index and the queued-flag lifecycle.
 *
 * One appended jsonl line is the whole persistence of a message; one appended
 * patch line is the whole persistence of a mutation. The strictly-increasing
 * ts within a session (stampTs) is what unread counting, dedupe and the app's
 * ordering all stand on. Wired at boot (initChatlog) over the session lookup,
 * the persistence and the broadcast; structural session type, so no cycle.
 *
 *   bun test agent-engine/src/chat/chatlog.test.ts
 */

import { mintMsgId, type ChatMsg } from "./chatmsg.ts";
import { realClock, type Clock } from "../runtime/clock.ts";
import { capText, factKey, mintSessionRecId, srcKey, type SessionRec } from "./sessionrec.ts";

export type DedupeEntry = { msgId?: string; seq: number };

export type ChatSession = {
  id: string;
  chat: ChatMsg[];
  /** the session records of the same log, on the same seq axis (sessionrec.ts);
   *  minted on the first logSession for a session that has none */
  log?: SessionRec[];
  recentKeys?: Map<string, DedupeEntry>;
  /** the idempotency keys of the newest transcript-sourced records
   *  (src.h|sid|rid), lazily rebuilt from `log` */
  recentSrc?: Set<string>;
  /** kind|ts|text of the newest engine-authored records */
  recentFacts?: Set<string>;
};

/* HOW MANY INGEST KEYS ONE SESSION REMEMBERS (design A.2): a replay after a
 * restart re-reads from the saved pointer, which trails the last append by
 * one debounced meta save, so the duplicates it can produce are the newest
 * few hundred; 20 000 is far more than any pointer lag. */
export const SRC_KEEP = 20_000;
/* HOW MANY ENGINE-AUTHORED FACTS are held for dedupe: the same edge or ask
 * restamped by a reconcile pass lands within a few records of the first. */
export const FACT_KEEP = 200;

// No cap: history is kept in full. It used to be 50, which quietly ate
// messages in any real conversation. Text is cheap; audio lives on disk with
// its own limit. If a chat ever grows big enough to feel slow, page it
// instead of trimming it.
export const CHAT_KEEP = Infinity;

/* THE QUEUED-DIVIDER WAIT, keyed by the DELIVERY ID (the user send's `cid`, or
 * a synthetic id for an agent/schedule send), NOT the delivered string.
 *
 * The delivered string is more than the user's words: it ends with the reply
 * instruction, built from the session's live reply level. Keying on it meant a
 * message's identity CHANGED when the reply slider moved between a failed send
 * and its retry, so the transcript-echo match missed. The `cid` is durable and
 * survives the injection being re-run, so it is the stable identity here. The
 * `text` is kept on the value because the transcript-echo join still comes in as
 * the delivered string, and awaitingByText below is the reverse index from that
 * string back to the delivery id. */
export const awaitingQueue = new Map<string, { sessionId: string; ts: number; text: string }>();
/* delivered text -> the delivery id waiting on it. Built at arm time alongside
 * awaitingQueue, so a queue-operation/user record in the session log (which
 * carries only the typed text, not the id) maps back to the bubble by an EXACT
 * lookup rather than the substring scan this replaced. */
export const awaitingByText = new Map<string, string>();
export const QUEUE_STUCK_MS = 5 * 60 * 1000; // clear a queued flag nothing ever resolved

/* Arm the queued-divider wait for a delivery: both indexes set together so the
 * text -> id reverse lookup can never point at an id awaitingQueue has dropped. */
export function armAwaiting(cid: string, sessionId: string, ts: number, text: string): void {
  awaitingQueue.set(cid, { sessionId, ts, text });
  awaitingByText.set(text, cid);
}

/* Drop a delivery's wait, from both indexes at once. The delivered `text` is
 * read back off the entry so the reverse index is cleared by the same key it
 * was set under. */
export function clearAwaiting(cid: string): void {
  const entry = awaitingQueue.get(cid);
  awaitingQueue.delete(cid);
  if (entry) awaitingByText.delete(entry.text);
}

/* HOW MANY RECENT IDEMPOTENCY KEYS ONE SESSION REMEMBERS (#505). A retry
 * lands within seconds of the first attempt, so the match is always among the
 * newest few replies; 256 is far more window than a retry needs. */
export const DEDUPE_KEEP = 256;

export type ChatlogDeps = {
  /** the session's live chat array, or the restored one for an unseen pane */
  chatOf(sessionId: string): ChatMsg[] | undefined;
  restoredChats(): Map<string, ChatMsg[]>;
  /** append one mutation patch line (chatstore) */
  persistPatch(sessionId: string, mts: number, set: Partial<ChatMsg> | undefined, unset: string[]): void;
  broadcast(msg: unknown): void;
  /** where this session's log lives: the owning agent + chat id */
  chatRefFor(sessionId: string): { aid: string; chatId: string };
  indexMsgBlobs(agentId: string, m: ChatMsg): void;
  appendMsg(aid: string, chatId: string, msg: ChatMsg): void;
  /** append one session record line (chatstore appendRec) */
  appendRec(aid: string, chatId: string, rec: SessionRec): void;
  /** the live delta: a record just appended to this session's log goes to
   *  every client attached to it as a `session-event` frame (design A.3) */
  sendSessionRec?(sessionId: string, rec: SessionRec): void;
  /* WHERE THE QUEUE-CLEAR DEADLINE'S TIME COMES FROM. Absent in production,
   * where it is the global timers, so behaviour is byte-identical. A seam test
   * passes a manualClock so a five minute stuck-queue window costs it one
   * advance() rather than five minutes. */
  clock?: Clock;
};

let deps: ChatlogDeps | null = null;
let clk: Clock = realClock;
export function initChatlog(d: ChatlogDeps): void {
  deps = d;
  clk = d.clock ?? realClock;
}

/* The instant to stamp on this session's next message, STRICTLY increasing
 * within a session. Two agent messages in the same millisecond made the
 * second `ts > heardTs` false: never counted, never spoken, silently read.
 * Bumping by a millisecond costs nothing and also absorbs a small backwards
 * clock step. */
export function stampTs(s: ChatSession): number {
  const last = s.chat[s.chat.length - 1]?.ts ?? 0;
  return Math.max(Date.now(), last + 1);
}

/* STAMP EVERY MESSAGE IN A LOG WITH ITS seq, once, in place. A log written by
 * an engine older than the page contract has no seq; order on disk IS the
 * sequence, so seq = position backfills exactly. Monotonic and gap-free from
 * the front: even a partly-seq'd array is renumbered by position so the page
 * arithmetic stays sound. */
/** A chat message that has been through ensureSeqs, so its seq is a number. */
export type SeqdChat = ChatMsg & { seq: number };

/* AN ASSERTION, because that is exactly what this function does. `ChatMsg.seq`
 * is optional (a message is built before it is stamped), so pages.ts -- whose
 * Seqd requires a real `seq` -- would not take a ChatMsg[] however many times
 * ensureSeqs had run over it. Saying so in the signature is what lets the paging
 * calls in attach.ts type-check without a cast, and it is the truth: after this
 * returns, every element has a numeric seq. */
export function ensureSeqs(chat: ChatMsg[], log?: readonly SessionRec[]): asserts chat is SeqdChat[] {
  if (log && log.length) {
    /* A LOG WITH SESSION RECORDS was written by this build or a newer one,
     * which stamps every row; the messages' seqs are then gaps in a shared
     * axis (records sit between them), so "gap-free from 0" is the wrong
     * test. The check is the one the pages need: every message carries a
     * number and the messages are strictly increasing. */
    let ok = true;
    let numbered = false;
    let prev = -1;
    for (const c of chat) {
      const q = c.seq;
      if (typeof q === "number" && Number.isFinite(q)) numbered = true;
      if (!ok) continue;
      if (typeof q !== "number" || !(q > prev)) { ok = false; continue; }
      prev = q;
    }
    if (ok) return;
    /* A PRE-SEQ LOG (no message numbered at all) has no interleave to keep:
     * renumber it whole, past the records so nothing collides (the dup-rows
     * serve-2 shape, pinned in chatlog.test.ts). */
    if (!numbered) {
      let next = log[log.length - 1].seq + 1;
      for (const c of chat) c.seq = next++;
      return;
    }
    /* A PARTLY BROKEN RUN IS REPAIRED IN PLACE, never renumbered whole. This
     * used to shove EVERY message past the last record, which put all session
     * records below all messages on the shared axis: the attach's pointer and
     * tail pages then held messages only, and the chat showed NO session
     * activity at all (the BZ Builder bug, 2026-09-05; the on-disk cause was
     * a handful of foreign-axis rows with seq 1,2,3 sitting mid-run). Only a
     * row that breaks the run is renumbered, to the smallest seq that keeps
     * it after its predecessor; every in-order row keeps the seq that encodes
     * its true interleave with the records. Deterministic from the file
     * alone, so a restart re-repairs identically instead of inflating the
     * axis by one message-count per boot (measured: seven such jumps in one
     * live log). A repaired seq can land on a record's seq; rowsBySeq orders
     * the message first on a tie and the page arithmetic is range-based, so
     * a duplicate is served, not lost. */
    prev = -1;
    for (const c of chat) {
      const q = c.seq;
      if (typeof q !== "number" || !(q > prev)) c.seq = prev + 1;
      prev = c.seq as number;
    }
    return;
  }
  let need = chat.length !== 0 && chat[0].seq !== 0;
  if (!need) for (let i = 0; i < chat.length; i++) if (chat[i].seq !== i) { need = true; break; }
  if (need) for (let i = 0; i < chat.length; i++) chat[i].seq = i;
}

/** The seq the next row of this log gets: one past the newest message or
 *  record, whichever is later in storage order. prev.seq is present for any
 *  log that went through ensureSeqs (every served one); the fallback guards
 *  a brand-new session whose array has not been paged yet. */
export function nextSeq(s: ChatSession): number {
  const m = s.chat[s.chat.length - 1];
  const mseq = m ? (m.seq ?? s.chat.length - 1) : -1;
  const r = s.log?.[s.log.length - 1];
  const rseq = r ? r.seq : -1;
  return Math.max(mseq, rseq) + 1;
}

/* The session's key -> record index, lazy-built from the persisted chat tail.
 * Building from s.chat is what makes the dedupe survive an engine restart for
 * free: the key rides on each ChatMsg. */
export function dedupeIndex(s: ChatSession): Map<string, DedupeEntry> {
  if (s.recentKeys) return s.recentKeys;
  const map = new Map<string, DedupeEntry>();
  for (let i = Math.max(0, s.chat.length - DEDUPE_KEEP); i < s.chat.length; i++) {
    const c = s.chat[i];
    if (c.role === "claude" && c.key) map.set(c.key, { msgId: c.msgId, seq: c.seq! });
  }
  s.recentKeys = map;
  return map;
}

/* Record that this key was just delivered, evicting the oldest so the index
 * stays inside DEDUPE_KEEP. Insertion order is delivery order. */
export function rememberKey(s: ChatSession, key: string, msgId: string | undefined, seq: number): void {
  const map = dedupeIndex(s);
  map.set(key, { msgId, seq });
  while (map.size > DEDUPE_KEEP) map.delete(map.keys().next().value as string);
}

/** Appends `msg` and returns the seq it was stamped with. Callers that need the
 *  number take it from here: `ChatMsg.seq` is optional on the type (an unstamped
 *  message is a legal thing to build), so reading `msg.seq` back after this call
 *  is `number | undefined` however certain the stamping is. */
export function logChat(s: ChatSession, msg: ChatMsg): number {
  if (!deps) throw new Error("chatlog not initialised");
  // Continue the monotonic run, shared with the session records.
  const seq = nextSeq(s);
  msg.seq = seq;
  /* A DURABLE per-row id the app dedups on, minted once and persisted in this
   * same line (dup-rows). seq cannot be the identity: it is renumbered onto a
   * shifted axis when a session record is inserted across a restart, which
   * re-served a row under a new seq and twinned it. `mid` never changes, so a
   * re-serve after any renumber or restart is recognised as the same row. Kept
   * if a caller already set one (a re-broadcast of an existing message). */
  if (!msg.mid) msg.mid = mintMsgId();
  s.chat.push(msg);
  if (s.chat.length > CHAT_KEEP) s.chat.splice(0, s.chat.length - CHAT_KEEP);
  /* ONE APPENDED LINE is the whole persistence of this message (the design),
   * and the blob index learns every id it carries in the same breath. */
  const { aid, chatId } = deps.chatRefFor(s.id);
  deps.indexMsgBlobs(aid, msg);
  deps.appendMsg(aid, chatId, msg);
  return seq;
}

/** What a caller hands logSession: everything but the storage stamps. */
export type SessionRecInput = Omit<SessionRec, "seq" | "id"> & { id?: string };

/* The session's ingest keys and engine-fact keys, lazily rebuilt from the
 * persisted records so idempotency survives a restart: the keys ride on
 * each record (src, or kind+ts+text). Insertion order is storage order, so
 * evicting the oldest keeps the newest SRC_KEEP / FACT_KEEP. */
function recKeys(s: ChatSession): { src: Set<string>; facts: Set<string> } {
  if (s.recentSrc && s.recentFacts) return { src: s.recentSrc, facts: s.recentFacts };
  const src = new Set<string>();
  const facts = new Set<string>();
  const log = s.log ?? [];
  for (let i = Math.max(0, log.length - SRC_KEEP); i < log.length; i++) {
    const k = srcKey(log[i]);
    if (k) src.add(k);
  }
  for (let i = Math.max(0, log.length - FACT_KEEP); i < log.length; i++) {
    if (!log[i].src) facts.add(factKey(log[i]));
  }
  s.recentSrc = src;
  s.recentFacts = facts;
  return { src, facts };
}

function remember(set: Set<string>, key: string, keep: number): void {
  set.add(key);
  while (set.size > keep) set.delete(set.keys().next().value as string);
}

/** Append one session record to this session's log: stamped with the next
 *  shared seq and a fresh id, pushed, persisted as one `t:"s"` line, and
 *  sent live to the attached clients. IDEMPOTENT (design A.2): a
 *  transcript-sourced record whose src key was already logged, or an
 *  engine-authored one whose kind+ts+text was, returns null and writes
 *  nothing. The text is capped here so no caller can write an uncapped line. */
export function logSession(s: ChatSession, input: SessionRecInput): SessionRec | null {
  if (!deps) throw new Error("chatlog not initialised");
  const keys = recKeys(s);
  const sk = srcKey(input);
  const text = capText(input.text ?? "");
  if (sk) {
    if (keys.src.has(sk)) return null;
  } else {
    const fk = factKey({ kind: input.kind, ts: input.ts, text });
    if (keys.facts.has(fk)) return null;
    remember(keys.facts, fk, FACT_KEEP);
  }
  const rec: SessionRec = { ...input, text, seq: nextSeq(s), id: input.id ?? mintSessionRecId() };
  if (sk) remember(keys.src, sk, SRC_KEEP);
  (s.log ??= []).push(rec);
  const { aid, chatId } = deps.chatRefFor(s.id);
  deps.appendRec(aid, chatId, rec);
  deps.sendSessionRec?.(s.id, rec);
  return rec;
}

/* An engine-authored line INTO the conversation: stamped by stampTs, logged,
 * broadcast to every client. E7 every-line-is-logged: a {t:'chat'} frame the
 * engine emits IS a line in its log, or it does not go out at all. */
export function noticeChat(s: ChatSession, text: string, kind?: "system"): ChatMsg {
  if (!deps) throw new Error("chatlog not initialised");
  const msg: ChatMsg = { id: s.id, role: "claude", text, ts: stampTs(s), ...(kind ? { kind } : {}) };
  logChat(s, msg);
  deps.broadcast({ t: "chat", ...msg });
  return msg;
}

/* Clear a queued flag from outside the process that set it. Keyed by
 * (session id, ts) rather than by the awaitingQueue entry: that map is
 * in-process and the flag it guards is on disk. `key` is the DELIVERY ID and is
 * passed only by the live send path (the stuck-queue deadline), where the map
 * entry is the proof that this timer still owns this message. */
export function clearQueued(sessionId: string, ts: number, key?: string): boolean {
  if (!deps) throw new Error("chatlog not initialised");
  if (key !== undefined) {
    if (awaitingQueue.get(key)?.ts !== ts) return false;
    clearAwaiting(key);
  }
  const chat = deps.chatOf(sessionId);
  const msg = chat?.find((m) => m.ts === ts && m.role === "user");
  if (!msg?.queued) return false;
  delete msg.queued;
  deps.persistPatch(sessionId, ts, undefined, ["queued"]);
  deps.broadcast({ t: "dequeued", id: sessionId, ts });
  return true;
}

/* A real agent reply is proof the pane took its queued input: claude cannot
 * answer a message it has not read. Clear each earlier queued flag, oldest
 * first, one dequeued per message (#456: a stuck strip above a reply is the
 * worse outcome; the boot sweep keeps the conservative rule for a flag whose
 * reply never came). */
export function clearQueuedByReply(s: ChatSession, replyTs: number) {
  const stale = s.chat
    .filter((m) => m.role === "user" && m.queued && m.ts < replyTs)
    .sort((a, b) => a.ts - b.ts);
  for (const m of stale) clearQueued(s.id, m.ts);
}

/* Every deadline armQueueClear still has outstanding. One entry per queued
 * message nothing has resolved yet, deleted as each fires, so in production
 * this is a handful of handles and nothing ever reads it. It exists so a test
 * can cancel what it armed instead of leaving a five minute timer behind in a
 * module the next test in the file inherits. */
const armed = new Set<unknown>();

/* The stuck-queue safety net, as a deadline rather than a closure over the
 * send that armed it, so boot can re-arm what is left of one. Clamped into
 * [0, QUEUE_STUCK_MS]: NaN and future stamps both fall back to a whole
 * window, never to firing at once (the data-losing direction). */
export function armQueueClear(sessionId: string, ts: number, ms: number, key?: string) {
  const delay = Number.isFinite(ms) ? Math.min(QUEUE_STUCK_MS, Math.max(0, ms)) : QUEUE_STUCK_MS;
  const t = clk.setTimeout(() => {
    armed.delete(t);
    clearQueued(sessionId, ts, key);
  }, delay);
  (t as { unref?: () => void }).unref?.();
  armed.add(t);
}

/** TEST ONLY: cancel every armed queue-clear deadline and forget every send
 *  still waiting on one. Nothing in production calls it, so it is a no-op
 *  there; a test file calls it between tests to get a clean module. */
export function resetForTest(): void {
  for (const t of armed) clk.clearTimeout(t);
  armed.clear();
  awaitingQueue.clear();
  awaitingByText.clear();
  clk = realClock;
}

/* Boot sweep: no queued flag may survive a restart on a timer's word. The
 * only thing that outlives the process is the message's own ts, so the
 * deadline the dead timer was holding is the whole rule: already past means
 * clear now, still to run means re-arm the remainder, anything else is LEFT
 * ALONE (a message queued moments before the restart is genuinely waiting). */
export function sweepRestoredQueued() {
  if (!deps) throw new Error("chatlog not initialised");
  const t0 = performance.now();
  const now = Date.now();
  let scanned = 0, aged = 0, kept = 0;
  for (const [id, msgs] of deps.restoredChats()) {
    scanned += msgs.length;
    for (const m of msgs) {
      if (m.role !== "user" || !m.queued) continue;
      // A missing ts makes this NaN, which fails the comparison and is kept,
      // and armQueueClear then gives it a whole window rather than firing at
      // once. So the count below is the truth about what happened to it.
      if (now - m.ts >= QUEUE_STUCK_MS) {
        delete m.queued;
        deps.persistPatch(id, m.ts, undefined, ["queued"]);
        aged++;
      } else {
        kept++;
        armQueueClear(id, m.ts, QUEUE_STUCK_MS - (now - m.ts));
      }
    }
  }
  const ms = performance.now() - t0;
  console.log(`[chat] queue sweep: ${scanned} messages in ${ms.toFixed(1)}ms, ` +
    `cleared ${aged} past the deadline, kept ${kept} still waiting`);
}
