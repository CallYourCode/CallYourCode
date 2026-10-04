/* Read state (readstate.ts): the one marker, forward-only, the mark-unread
 * exception, filedAndQuiet, and the first-sight seeding rules. Pure. */

import { describe, expect, test, beforeEach } from "bun:test";
import { initReadState, unreadOf, markRead, markReadRow, readThroughOf, markAllRead, markUnread,
  markReadOnUtterance, filedAndQuiet, doneSeqFor, seenDoneSeqFor,
  type ReadStateSession } from "./readstate.ts";

let saved: string[] = [];
let dismissed: string[] = [];
let broadcasts = 0;
beforeEach(() => {
  saved = [];
  dismissed = [];
  broadcasts = 0;
  initReadState({
    scheduleHeardSave: (id) => saved.push(id),
    sendDismissal: (s) => dismissed.push(s.id),
    broadcastSessions: () => broadcasts++,
  });
});

const mk = (over: Partial<ReadStateSession> = {}): ReadStateSession => ({
  id: "s1",
  chat: [
    { role: "user", ts: 100 },
    { role: "claude", ts: 200 },
    { role: "claude", ts: 300 },
  ],
  heardTs: 0,
  doneSeq: 0,
  seenDoneSeq: 0,
  status: "idle",
  ...over,
});

describe("unreadOf / markRead", () => {
  test("only the agent's messages past the marker count", () => {
    const s = mk();
    expect(unreadOf(s)).toBe(2);
    expect(markRead(s, 200)).toBe(true);
    expect(unreadOf(s)).toBe(1);
  });
  test("FORWARD ONLY: a stale ack cannot un-read", () => {
    const s = mk({ heardTs: 250 });
    expect(markRead(s, 200)).toBe(false);
    expect(s.heardTs).toBe(250);
    expect(saved).toEqual([]);
  });
  test("reading clears the ceiling clock and the filed mark, and persists", () => {
    const s = mk({ silentSince: 5, filedTs: 300 });
    markRead(s, 300);
    expect(s.silentSince).toBeUndefined();
    expect(s.filedTs).toBe(0);
    expect(saved).toEqual(["s1"]);
  });
  test("the dismissal fires only when unread reaches ZERO on a notified chat", () => {
    const s = mk({ notified: true });
    markRead(s, 200); // one reply still waiting
    expect(dismissed).toEqual([]);
    markRead(s, 300);
    expect(dismissed).toEqual(["s1"]);
  });
  test("markAllRead reads to the newest line; empty chat is a no-op", () => {
    const s = mk();
    expect(markAllRead(s)).toBe(true);
    expect(s.heardTs).toBe(300);
    expect(markAllRead(mk({ chat: [] }))).toBe(false);
  });
  test("your own messages are never unread, at either end of the marker", () => {
    /* unreadOf counts only the agent's lines. Counting a user line would make
     * the badge climb as HE typed, which is the count telling him he has not
     * read his own words. */
    const s = mk({ chat: [
      { role: "user", ts: 100 },
      { role: "claude", ts: 200 },
      { role: "user", ts: 400 }, // newer than everything, and still not unread
    ] });
    expect(unreadOf(s)).toBe(1);
    markRead(s, 200);
    expect(unreadOf(s), "the user line above the marker must not count").toBe(0);
  });
  test("the marker is EXCLUSIVE: a line stamped exactly at it is read", () => {
    // `ts > heardTs`, not >=. Reading to 200 means 200 has been read, so the
    // count that follows an ack must not still include the line acked.
    const s = mk({ heardTs: 200 });
    expect(unreadOf(s), "the 200 line is at the marker and is read; only 300 waits").toBe(1);
    expect(markRead(s, 300)).toBe(true);
    expect(unreadOf(s)).toBe(0);
  });
  test("an ack at exactly the marker is not forward, so nothing is persisted", () => {
    // two devices acking the same line: the second must be a no-op end to end,
    // or every duplicate ack costs a meta write and a broadcast
    const s = mk({ heardTs: 300 });
    expect(markRead(s, 300)).toBe(false);
    expect(saved).toEqual([]);
    expect(dismissed).toEqual([]);
  });
  test("reading an un-notified chat to zero sends no dismissal", () => {
    /* The banner is a SECOND fact. There is nothing standing on his
     * devices for a chat that never notified, and sending a dismissal for one
     * would be the engine talking about a notification it never sent. */
    const s = mk();
    markRead(s, 300);
    expect(unreadOf(s)).toBe(0);
    expect(dismissed).toEqual([]);
    expect(saved, "it is still persisted: reading survives a restart").toEqual(["s1"]);
  });
  test("a NEW reply after the dismissal is unread again, and reading it dismisses again", () => {
    const s = mk({ notified: true });
    markAllRead(s);
    expect(dismissed).toEqual(["s1"]);
    s.chat.push({ role: "claude", ts: 400 });
    expect(unreadOf(s), "the marker did not move, so the new line is news").toBe(1);
    markAllRead(s);
    expect(dismissed, "the standing banner has to come down a second time").toEqual(["s1", "s1"]);
  });
  test("markAllRead over a chat whose newest line is the user's still reads everything", () => {
    // the last LINE, not the last agent line: opening the chat reads all of it
    const s = mk({ chat: [
      { role: "claude", ts: 200 },
      { role: "user", ts: 500 },
    ] });
    expect(markAllRead(s)).toBe(true);
    expect(s.heardTs).toBe(500);
    expect(unreadOf(s)).toBe(0);
  });
});

describe("markReadRow / readThroughOf (identity, fix-unread)", () => {
  const withMids = (over: Partial<ReadStateSession> = {}) => mk({ chat: [
    { role: "user", ts: 100, mid: "mr-u" },
    { role: "claude", ts: 200, mid: "mr-a" },
    { role: "claude", ts: 300, mid: "mr-b" },
  ], ...over });

  test("a sighting marks read to the NAMED row, forward only", () => {
    const s = withMids();
    expect(markReadRow(s, { mid: "mr-a", ts: 200 })).toBe(true);
    expect(unreadOf(s)).toBe(1);
    expect(s.heardTs).toBe(200);
    // the same row again is not forward: a no-op
    expect(markReadRow(s, { mid: "mr-a", ts: 200 })).toBe(false);
    expect(markReadRow(s, { mid: "mr-b", ts: 300 })).toBe(true);
    expect(unreadOf(s)).toBe(0);
  });

  test("two devices reporting OUT OF ORDER settle forward-only", () => {
    const s = withMids();
    // device 2 reports the newest first
    expect(markReadRow(s, { mid: "mr-b", ts: 300 })).toBe(true);
    expect(unreadOf(s)).toBe(0);
    // device 1's older report lands late: it must not rewind the marker
    expect(markReadRow(s, { mid: "mr-a", ts: 200 })).toBe(false);
    expect(unreadOf(s)).toBe(0);
    expect(readThroughOf(s)).toEqual({ mid: "mr-b", ts: 300 });
  });

  test("an UNKNOWN-row sighting is ignored, moving nothing", () => {
    const s = withMids();
    markReadRow(s, { mid: "mr-a", ts: 200 });
    const before = s.heardTs;
    expect(markReadRow(s, { mid: "mr-ghost" })).toBe(false);
    expect(s.heardTs).toBe(before);
    expect(saved).toEqual(["s1"]); // only the first (real) mark persisted
  });

  test("the marker is decided by POSITION, never the device's clock", () => {
    // A stale sighting names an EARLIER row by a HIGHER ts than the marker sits
    // on (a restamp, a skewed clock). Resolving by identity pins it to the row
    // it names, which sits BEFORE the marker, so it moves nothing.
    const s = withMids();
    markReadRow(s, { mid: "mr-b", ts: 300 });
    expect(markReadRow(s, { mid: "mr-a", ts: 999 })).toBe(false);
    expect(readThroughOf(s)).toEqual({ mid: "mr-b", ts: 300 });
  });

  test("readThroughOf reports the marker row identity, undefined when unread", () => {
    const s = withMids();
    expect(readThroughOf(s)).toBeUndefined();
    markReadRow(s, { mid: "mr-a", ts: 200 });
    expect(readThroughOf(s)).toEqual({ mid: "mr-a", ts: 200 });
  });

  test("readThroughOf SEEDS from a legacy heardTs (persistence compat)", () => {
    // On load only heardTs survives; the identity is the newest row at or before
    // it, so an old persisted marker still resolves to a row the app can anchor.
    const s = withMids({ heardTs: 250 });
    expect(readThroughOf(s)).toEqual({ mid: "mr-a", ts: 200 });
  });
});

describe("markReadOnUtterance", () => {
  test("HIS OWN MESSAGE READS EVERYTHING ABOVE IT, and tells the other devices", () => {
    const s = mk();
    markReadOnUtterance(s, 350);
    expect(s.heardTs).toBe(350);
    expect(unreadOf(s)).toBe(0);
    expect(broadcasts).toBe(1);
    expect(saved).toEqual(["s1"]);
  });
  test("an utterance that moves nothing broadcasts nothing", () => {
    // the broadcast is guarded on the marker actually moving; a replayed or
    // out-of-order utterance must not cost every device a snapshot
    const s = mk({ heardTs: 400 });
    markReadOnUtterance(s, 350);
    expect(s.heardTs).toBe(400);
    expect(broadcasts).toBe(0);
  });
});

describe("markUnread", () => {
  test("parks the marker just before the last AGENT message and files it", () => {
    const s = mk({ heardTs: 300 });
    expect(markUnread(s)).toBe(true);
    expect(s.heardTs).toBe(299);
    expect(s.filedTs).toBe(300);
    expect(unreadOf(s)).toBe(1);
  });
  test("no agent lines, or already unread, is a no-op", () => {
    expect(markUnread(mk({ chat: [{ role: "user", ts: 1 }] }))).toBe(false);
    const s = mk({ heardTs: 250 }); // last claude line already unread
    expect(markUnread(s)).toBe(false);
  });
  test("an empty chat has nothing to file", () => {
    const s = mk({ chat: [], heardTs: 500 });
    expect(markUnread(s)).toBe(false);
    expect(s.heardTs, "and it must not move the marker on the way out").toBe(500);
    expect(saved).toEqual([]);
  });
  test("filing parks BEHIND the last agent line even when the user typed after it", () => {
    /* The last AGENT line is the target, not the last line: filing is "come
     * back to what it said", and his own message afterwards is not what he is
     * coming back to. The marker lands at 300-1 so exactly that one reply is
     * unread again, not his own line as well. */
    const s = mk({ chat: [
      { role: "claude", ts: 300 },
      { role: "user", ts: 800 },
    ], heardTs: 800 });
    expect(markUnread(s)).toBe(true);
    expect(s.heardTs).toBe(299);
    expect(s.filedTs).toBe(300);
    expect(unreadOf(s)).toBe(1);
  });
  test("filing persists, exactly as reading does", () => {
    // a restart that forgot a filed chat would show it read again, which is the
    // whole point of the gesture undone silently
    const s = mk({ heardTs: 300 });
    markUnread(s);
    expect(saved).toEqual(["s1"]);
  });
  test("read then file then read again: the marker survives the round trip", () => {
    /* markRead is forward-only and markUnread is the ONE exception, so the two
     * have to compose without the marker getting stuck: filing must leave a
     * position that a later read can still move past. */
    const s = mk();
    expect(markAllRead(s)).toBe(true);
    expect(s.heardTs).toBe(300);
    expect(markUnread(s)).toBe(true);
    expect(s.heardTs).toBe(299);
    expect(markRead(s, 300), "reading supersedes filing").toBe(true);
    expect(s.filedTs).toBe(0);
    expect(unreadOf(s)).toBe(0);
  });
});

describe("filedAndQuiet", () => {
  test("true while the newest agent line is one he filed; false after a new reply", () => {
    const s = mk({ heardTs: 299, filedTs: 300 });
    expect(filedAndQuiet(s)).toBe(true);
    s.chat.push({ role: "claude", ts: 400 });
    expect(filedAndQuiet(s)).toBe(false); // news again, by arithmetic
    expect(filedAndQuiet(mk())).toBe(false); // never filed
  });
  test("a USER line after the filed reply does not make it news", () => {
    /* The scan walks back to the newest AGENT line and stops. His own message
     * is not a reason to buzz him about a message he already filed. */
    const s = mk({ chat: [
      { role: "claude", ts: 300 },
      { role: "user", ts: 900 },
    ], heardTs: 299, filedTs: 300 });
    expect(filedAndQuiet(s)).toBe(true);
  });
  test("a chat with nothing of the agent's in it is not quiet-because-filed", () => {
    // there is no filed reply to be quiet about; false is the answer that lets
    // the disconnect flush behave as it would for any other chat
    expect(filedAndQuiet(mk({ chat: [{ role: "user", ts: 1 }], filedTs: 500 }))).toBe(false);
    expect(filedAndQuiet(mk({ chat: [], filedTs: 500 }))).toBe(false);
  });
  test("filedTs 0 is 'never filed', not 'filed at the epoch'", () => {
    // markRead clears filedTs to 0 rather than deleting it, so 0 has to read as
    // absent or every read chat would look permanently filed
    expect(filedAndQuiet(mk({ filedTs: 0 }))).toBe(false);
  });
  test("the newest agent line exactly AT filedTs still counts as filed", () => {
    // `ts <= filedTs`: the line he filed is the line he filed, not one past it
    expect(filedAndQuiet(mk({ heardTs: 299, filedTs: 300 }))).toBe(true);
  });
});

describe("first-sight seeding", () => {
  test("doneSeq adopts restored state without inventing an edge", () => {
    expect(doneSeqFor(undefined, { handle: "h", statusHint: "done" }, { doneSeq: 4, seenDoneSeq: 4 })).toBe(4);
    expect(doneSeqFor(undefined, { handle: "h", statusHint: "done" })).toBe(0);
  });
  test("doneSeq bumps only on the working->done edge of a KNOWN session", () => {
    const prev = { doneSeq: 4, status: "working" };
    expect(doneSeqFor(prev, { handle: "h", statusHint: "done" })).toBe(5);
    expect(doneSeqFor({ doneSeq: 4, status: "done" }, { handle: "h", statusHint: "done" })).toBe(4);
  });
  test("seenDoneSeq starts level on first sight (no inherited unread)", () => {
    expect(seenDoneSeqFor(undefined, { handle: "h", statusHint: "done" }, { doneSeq: 3, seenDoneSeq: 1 })).toBe(1);
    expect(seenDoneSeqFor(undefined, { handle: "h", statusHint: "done" })).toBe(0);
    expect(seenDoneSeqFor({ doneSeq: 9, seenDoneSeq: 7, status: "done" }, { handle: "h", statusHint: "done" })).toBe(7);
  });
  test("the edge is working->done ONLY: no other transition bumps the counter", () => {
    /* doneSeq is how many times this session FINISHED work. A bump on any other
     * edge is a badge that climbs for nothing, which is the failure mode that
     * makes the number stop meaning anything. */
    const from = (status: string, hint: string) =>
      doneSeqFor({ doneSeq: 4, status }, { handle: "h", statusHint: hint });
    expect(from("working", "done")).toBe(5);   // the one edge
    expect(from("blocked", "done")).toBe(5);   // also arriving at done from not-done
    expect(from("idle", "done")).toBe(5);
    expect(from("done", "done")).toBe(4);      // already there: no second bump
    expect(from("working", "idle")).toBe(4);   // finishing is not going quiet
    expect(from("done", "working")).toBe(4);   // starting again is not finishing
    expect(from("idle", "blocked")).toBe(4);
  });
  test("a restored session adopts BOTH counters without inventing an edge", () => {
    /* First sight after a restart: the pane may well be sitting at done, and
     * treating that as a fresh working->done edge would invent a completion
     * that already happened before the process started. */
    const restored = { doneSeq: 4, seenDoneSeq: 4 };
    const a = { handle: "h", statusHint: "done" };
    expect(doneSeqFor(undefined, a, restored)).toBe(4);
    expect(seenDoneSeqFor(undefined, a, restored)).toBe(4);
    // and a session restored WITH unread on it keeps that gap rather than
    // levelling it: he has not seen those completions yet
    const behind = { doneSeq: 9, seenDoneSeq: 5 };
    expect(doneSeqFor(undefined, a, behind)).toBe(9);
    expect(seenDoneSeqFor(undefined, a, behind)).toBe(5);
  });
  test("a live observation beats the restored record, so the disk copy cannot rewind it", () => {
    /* prev is this process's own newer knowledge. If the stale on-disk record
     * won here, every poll would drag the counters back to boot values and the
     * badge would flicker between two answers. */
    const prev = { doneSeq: 12, seenDoneSeq: 12, status: "done" };
    const restored = { doneSeq: 4, seenDoneSeq: 4 };
    expect(doneSeqFor(prev, { handle: "h", statusHint: "done" }, restored)).toBe(12);
    expect(seenDoneSeqFor(prev, { handle: "h", statusHint: "done" }, restored)).toBe(12);
  });
  test("with nothing remembered at all, both counters start at zero and level", () => {
    // a genuinely new pane: no completions, nothing unseen. Any other pair
    // would put a badge on a session that has never done anything.
    const a = { handle: "h", statusHint: "working" };
    expect(doneSeqFor(undefined, a)).toBe(0);
    expect(seenDoneSeqFor(undefined, a)).toBe(0);
  });
});
