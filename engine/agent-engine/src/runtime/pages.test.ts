/* The page arithmetic, on its own (pages.ts). No engine, no sockets: every
 * function here is pure over a list of messages that carry a seq, so the
 * boundaries and the sealing are provable without a replay.
 *
 * THE RULE BEING PROVED: a page below the tail is sealed and immutable forever,
 * page N holds seq [N*100, N*100+99], and neither of those may move when the
 * front of the log is trimmed. A version that drifts on a sealed page makes the
 * app refetch history it already has; a page number that shifts under a trim
 * makes it show the wrong hundred messages and never notice.
 *
 *   bun test agent-engine/src/runtime/pages.test.ts
 */

import { test, expect } from "bun:test";
import { PAGE_SIZE, pageOf, tailPage, buildPage, pointerSeq, tsForSeq, type Seqd } from "./pages";

/* A synthetic log of `n` messages, seq = index, alternating user/claude, ts a
 * strictly increasing minute so a marker can land between any two. */
function log(n: number): (Seqd & { ts: number })[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: i,
    role: i % 2 === 0 ? "claude" : "user" as "user" | "claude",
    ts: (i + 1) * 60_000,
  }));
}

test("PAGE_SIZE is 100 and pageOf splits on the 100 boundary", () => {
  expect(PAGE_SIZE).toBe(100);
  expect(pageOf(0)).toBe(0);
  expect(pageOf(99)).toBe(0);
  expect(pageOf(100)).toBe(1);
  expect(pageOf(199)).toBe(1);
  expect(pageOf(250)).toBe(2);
});

test("page N holds exactly seq [N*100, N*100+99]", () => {
  const chat = log(250);
  const p0 = buildPage(chat, 0);
  expect(p0.messages.length).toBe(100);
  expect(p0.messages[0].seq).toBe(0);
  expect(p0.messages[99].seq).toBe(99);

  const p1 = buildPage(chat, 1);
  expect(p1.messages[0].seq).toBe(100);
  expect(p1.messages[99].seq).toBe(199);

  const p2 = buildPage(chat, 2);
  expect(p2.messages.length).toBe(50); // 200..249
  expect(p2.messages[0].seq).toBe(200);
  expect(p2.messages[49].seq).toBe(249);
});

test("the boundary seqs land on the page pageOf names, and on no other", () => {
  /* An off-by-one here shows one message twice or loses one entirely at every
   * hundred, which is invisible until somebody counts. */
  const chat = log(201);
  for (const seq of [0, 99, 100, 199, 200]) {
    const n = pageOf(seq);
    expect(buildPage(chat, n).messages.some((m) => m.seq === seq)).toBe(true);
    for (const other of [0, 1, 2].filter((p) => p !== n)) {
      expect(buildPage(chat, other).messages.some((m) => m.seq === seq),
        `seq ${seq} appears on page ${other} as well as ${n}`).toBe(false);
    }
  }
});

test("a page carries the whole message, not a projection of it", () => {
  /* buildPage is generic over the message: everything a ChatMsg holds -- the
   * attachments, the file card, the queued flag -- rides along untouched, and
   * a rebuild-shaped implementation here would quietly eat all of it. */
  const chat = [{ seq: 0, role: "user" as const, ts: 1, text: "hi", queued: true, extra: { a: 1 } }];
  const p = buildPage(chat, 0);
  expect(p.messages[0]).toBe(chat[0]);
  expect(p.messages[0].extra).toEqual({ a: 1 });
});

test("a page below the tail is sealed; the tail page is not", () => {
  const chat = log(250); // pages 0,1 full; page 2 is the tail (partial)
  expect(tailPage(chat)).toBe(2);
  expect(buildPage(chat, 0).sealed).toBe(true);
  expect(buildPage(chat, 1).sealed).toBe(true);
  expect(buildPage(chat, 2).sealed).toBe(false);
});

test("a full tail page seals the instant the next page gets a message", () => {
  const chat = log(200); // pages 0,1 both full; page 1 is the tail
  expect(tailPage(chat)).toBe(1);
  expect(buildPage(chat, 1).sealed).toBe(false); // tail, even though full
  expect(buildPage(chat, 0).sealed).toBe(true);

  chat.push({ seq: 200, role: "claude", ts: 201 * 60_000 }); // opens page 2
  expect(tailPage(chat)).toBe(2);
  expect(buildPage(chat, 1).sealed).toBe(true); // now sealed, forever
});

test("an empty log has a tail page of 0, so there is always a page to ask for", () => {
  expect(tailPage([])).toBe(0);
  const p = buildPage([], 0);
  expect(p).toEqual({ page: 0, version: 0, sealed: false, messages: [] });
});

test("version is the seq past the last message: frozen when sealed, bumps as the tail grows", () => {
  const chat = log(150); // page 0 full (0..99), page 1 tail (100..149)
  expect(buildPage(chat, 0).version).toBe(100); // last seq 99 + 1, never moves
  expect(buildPage(chat, 1).version).toBe(150); // last seq 149 + 1

  chat.push({ seq: 150, role: "claude", ts: 151 * 60_000 });
  expect(buildPage(chat, 1).version).toBe(151); // tail grew, version bumped
  expect(buildPage(chat, 0).version).toBe(100); // sealed page untouched
});

test("an empty page (beyond the log) is a well-defined answer, not a throw", () => {
  const chat = log(50);
  const p1 = buildPage(chat, 1);
  expect(p1.messages).toEqual([]);
  expect(p1.version).toBe(100); // its own base seq
  expect(p1.sealed).toBe(false); // page 1 is not below the tail (page 0)
});

test("a front trim keeps sealed pages at the same page number and version", () => {
  const chat = log(250);
  const p0before = buildPage(chat, 0);
  // drop the first 40 messages, as trim-log does; seqs stay put
  chat.splice(0, 40);
  const p0after = buildPage(chat, 0);
  expect(p0after.page).toBe(0);
  expect(p0after.version).toBe(p0before.version); // last seq of page 0 unchanged
  expect(p0after.messages[0].seq).toBe(40); // fewer messages, same numbers
  expect(p0after.sealed).toBe(true);
});

test("a page trimmed away entirely is still sealed, and still page 0", () => {
  /* The other half of the trim rule. Once every message of page 0 is gone the
   * page reports its own base seq and no messages; if it reported page 1's
   * content, or unsealed itself, the app's cache of the pages it already holds
   * would be wrong about every one of them. */
  const chat = log(250);
  chat.splice(0, 100); // the whole of page 0
  const p0 = buildPage(chat, 0);
  expect(p0.messages).toEqual([]);
  expect(p0.version).toBe(0);
  expect(p0.sealed, "a page below the tail stays sealed even when it is empty").toBe(true);
  // and page 1 is untouched by the trim
  expect(buildPage(chat, 1).messages.length).toBe(100);
  expect(buildPage(chat, 1).version).toBe(200);
});

test("pages are addressed by seq, not by position in the array", () => {
  /* The whole reason seq is stored. A log missing its middle (a merge, a trim,
   * a partial restore) must not slide later messages onto earlier pages. */
  const chat = [
    { seq: 0, role: "claude" as const, ts: 1 },
    { seq: 130, role: "user" as const, ts: 2 },
    { seq: 131, role: "claude" as const, ts: 3 },
  ];
  expect(buildPage(chat, 0).messages.map((m) => m.seq)).toEqual([0]);
  expect(buildPage(chat, 1).messages.map((m) => m.seq)).toEqual([130, 131]);
  expect(tailPage(chat)).toBe(1);
  expect(buildPage(chat, 0).sealed).toBe(true);
});

test("pointer is the first agent message past the marker; the divider's seat", () => {
  const chat = log(10); // claude at seq 0,2,4,6,8 with ts 60k,180k,300k,420k,540k
  // marker before everything: pointer at the first claude message
  expect(pointerSeq(chat, 0)).toBe(0);
  // marker on the claude message at seq 2 (ts 180k): next unread claude is seq 4
  expect(pointerSeq(chat, 180_000)).toBe(4);
  // marker at/after the last claude (seq 8, ts 540k): nothing unread -> end
  expect(pointerSeq(chat, 540_000)).toBe(10); // one past the last seq (9) + 1
});

test("only the agent's messages are ever unread", () => {
  /* His own messages are read by definition. A pointer that stopped
   * on one would draw the unread divider above something he just typed. */
  const chat = [
    { seq: 0, role: "claude" as const, ts: 10 },
    { seq: 1, role: "user" as const, ts: 20 },   // newer than the marker, still not unread
    { seq: 2, role: "user" as const, ts: 30 },
  ];
  expect(pointerSeq(chat, 15)).toBe(3); // nothing unread -> one past the last seq
});

test("pointer on an empty log is 0", () => {
  expect(pointerSeq([], 0)).toBe(0);
});

test("pointer at exactly the marker's ts is read, one millisecond later is not", () => {
  /* `ts > heardTs`, strictly. An inclusive comparison here re-reads the message
   * the marker is parked on every time the app reconnects. */
  const chat = [{ seq: 0, role: "claude" as const, ts: 1_000 }, { seq: 1, role: "claude" as const, ts: 1_001 }];
  expect(pointerSeq(chat, 1_000)).toBe(1);
  expect(pointerSeq(chat, 999)).toBe(0);
  expect(pointerSeq(chat, 1_001)).toBe(2);
});

test("tsForSeq maps 'done through seq X' to the ts to park the marker on", () => {
  const chat = log(10);
  expect(tsForSeq(chat, 0)).toBe(60_000); // ts of seq 0
  expect(tsForSeq(chat, 3)).toBe(4 * 60_000); // newest seq <= 3 is seq 3
  expect(tsForSeq(chat, 999)).toBe(10 * 60_000); // clamps to the last message
  expect(tsForSeq(chat, -1)).toBe(0); // nothing at or before -> 0
});

test("tsForSeq on a trimmed log answers with what is left, not with nothing", () => {
  /* A progress report can name a seq whose message the trim already dropped.
   * The honest answer is the newest surviving message at or before it. */
  const chat = log(250);
  chat.splice(0, 100);
  expect(tsForSeq(chat, 50), "nothing at or before seq 50 survives").toBe(0);
  expect(tsForSeq(chat, 120)).toBe(121 * 60_000);
});

test("tsForSeq on an empty log is 0", () => {
  expect(tsForSeq([], 5)).toBe(0);
});

/* ------------------------------------------------ session records on the axis
 *
 * A page holds BOTH kinds of row (design A.3): the chat messages and the
 * session records (`t: "s"`), on the one seq axis. A record has no role, so the
 * pointer arithmetic walks past it: only the agent's messages are ever unread. */

type Row = Seqd & { t?: "s"; text: string };

/** `n` rows: every third row a record, the rest alternating user/claude. */
function mixed(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => i % 3 === 2
    ? { seq: i, t: "s" as const, ts: (i + 1) * 60_000, text: `rec ${i}` }
    : { seq: i, role: (i % 3 === 0 ? "claude" : "user") as "user" | "claude", ts: (i + 1) * 60_000, text: `msg ${i}` });
}

test("a page holds messages and records together, each on the page its seq names", () => {
  const rows = mixed(250);
  const p0 = buildPage(rows, 0);
  expect(p0.messages.length).toBe(PAGE_SIZE);
  expect(p0.messages.filter((r) => r.t === "s").length).toBe(33);
  expect(p0.messages[2]).toMatchObject({ t: "s", seq: 2, text: "rec 2" });
  expect(p0.sealed).toBe(true);
  expect(p0.version).toBe(100);
  const p2 = buildPage(rows, 2);
  expect(p2.messages.map((r) => r.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 200 + i));
  expect(p2.sealed).toBe(false);
  expect(tailPage(rows)).toBe(2);
});

test("a record at the tail is the tail: tailPage and version count it like any row", () => {
  const rows = [...mixed(99), { seq: 99, t: "s" as const, ts: 100 * 60_000, text: "rec 99" }];
  expect(tailPage(rows)).toBe(0);
  expect(buildPage(rows, 0).version).toBe(100);
  rows.push({ seq: 100, t: "s", ts: 101 * 60_000, text: "rec 100" });
  expect(tailPage(rows)).toBe(1);
  expect(buildPage(rows, 0).sealed).toBe(true);
});

test("the pointer skips records: the divider sits on the first unread AGENT message", () => {
  const rows = mixed(12); // claude at 0,3,6,9; user at 1,4,7,10; records at 2,5,8,11
  // heard through row 4 (ts 5 minutes): record 5 is next, but a record is never unread
  expect(pointerSeq(rows, 5 * 60_000)).toBe(6);
  // heard through the last agent message (row 9, ts 10 minutes): the end, past the trailing record
  expect(pointerSeq(rows, 10 * 60_000)).toBe(12);
  // a progress report that lands on a record parks the marker on that record's instant
  expect(tsForSeq(rows, 8)).toBe(9 * 60_000);
});
