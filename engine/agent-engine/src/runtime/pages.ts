/* The conversation, served in fixed-size pages by message sequence (docs: the
 * pointer-pages brief). This module is the whole of the page arithmetic, kept
 * apart from server.ts so it can be reasoned about and unit-tested without an
 * engine: every function here is pure over a list of messages that carry a
 * `seq`.
 *
 * THE ONE RULE: a page below the tail is SEALED and immutable forever. Page N
 * holds the messages whose seq is in [N*PAGE_SIZE, N*PAGE_SIZE + PAGE_SIZE - 1].
 * The tail page is the only one that grows; every page before it is full and
 * final, so the app may trust a sealed page for the life of the process and only
 * ever refetch the tail.
 *
 * WHY seq AND NOT THE ARRAY INDEX. The index shifts the instant anything is
 * removed from the front of the log (trim-log), which would silently change what
 * "page N" means and break the immutability the app relies on. A stored seq
 * pins each message to one page for its whole life; a front-trim leaves a sealed
 * page holding fewer messages but the SAME ones, at the SAME page number.
 *
 * The size itself lives in ../../../shared/pages.ts so the app shares the one
 * literal; the arithmetic below is the engine's alone.
 */

import { PAGE_SIZE } from "../../../shared/pages.ts";
export { PAGE_SIZE };

/** A row as this module needs to see it: something with a monotonic seq.
 *  role/ts are here because the pointer arithmetic reads them; everything else a
 *  ChatMsg carries rides along untouched in `messages`. A session record
 *  (chat/sessionrec.ts) is a row too: it has no role, and the pointer
 *  arithmetic skips it (only the agent's messages are ever unread). */
export type Seqd = { seq: number; role?: "user" | "claude"; ts: number };

/** Which page a seq lives on. */
export function pageOf(seq: number): number {
  return Math.floor(seq / PAGE_SIZE);
}

/** The tail (last, growing) page number for a log. The tail is the page of the
 *  newest message's seq; an empty log has a tail page of 0 so the app always has
 *  a page to ask for. */
export function tailPage(chat: readonly Seqd[]): number {
  const last = chat[chat.length - 1];
  return last ? pageOf(last.seq) : 0;
}

export type Page<M extends Seqd> = {
  page: number;
  version: number;
  sealed: boolean;
  messages: M[];
};

/* Build one page.
 *
 * `sealed` is "a later page exists", i.e. this is not the tail. `version` is the
 * seq just past the last message on the page: it never moves for a sealed page
 * (its last message is fixed) and it bumps by one every time a message is
 * appended to the tail page, which is exactly what the app needs to know the
 * tail grew without diffing the messages. An empty page (asked for beyond the
 * log, or wholly trimmed away) reports version = its own base seq and no
 * messages, which is a well-defined answer rather than silence. */
export function buildPage<M extends Seqd>(chat: readonly M[], n: number): Page<M> {
  const lo = n * PAGE_SIZE;
  const hi = lo + PAGE_SIZE; // exclusive
  const messages: M[] = [];
  for (const c of chat) if (c.seq >= lo && c.seq < hi) messages.push(c);
  const last = messages[messages.length - 1];
  const version = last ? last.seq + 1 : lo;
  return { page: n, version, sealed: n < tailPage(chat), messages };
}

/* The pointer, as a seq: where the unread divider is drawn and where autoplay
 * begins. It is the first AGENT message the marker has not passed
 * (`ts > heardTs`), because only the agent's messages are ever unread.
 * When nothing is unread the pointer sits one past the newest message's seq
 * (the end), so the divider does not draw and autoplay has nothing before it.
 *
 * The timestamp `heardTs` remains the pointer of record on the engine; this is
 * its projection onto the seq axis the pages live on. */
export function pointerSeq(chat: readonly Seqd[], heardTs: number): number {
  for (const c of chat) if (c.role === "claude" && c.ts > heardTs) return c.seq;
  const last = chat[chat.length - 1];
  return last ? last.seq + 1 : 0;
}

/* The ts a "done through seq X" progress report maps to: the ts of the newest
 * message whose seq is <= X. That is the instant the marker should sit on, so
 * `markRead` (forward-only) or an explicit backward write can move it there.
 * Returns 0 when no message is at or before X (nothing to have read). */
export function tsForSeq(chat: readonly Seqd[], seq: number): number {
  let ts = 0;
  for (const c of chat) {
    if (c.seq > seq) break; // chat is seq-ordered
    ts = c.ts;
  }
  return ts;
}
