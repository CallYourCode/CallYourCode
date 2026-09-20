/* The chat log (chatlog.ts): monotonic stamping, seq backfill, the dedupe
 * index window, append + notice, and the queued-flag lifecycle. Fake deps, no
 * engine, no disk.
 *
 * Everything here is a rule the app's ordering stands on. A ts that is not
 * strictly increasing makes an agent message that arrived in the same
 * millisecond as the last one silently read; a seq that is not gap-free by
 * position re-numbers a sealed page under the app; a queued flag that is
 * cleared by the wrong rule either shows a "waiting" strip above the reply that
 * answered it, or takes the strip away from a message that really is waiting.
 *
 *   bun test agent-engine/src/chat/chatlog.test.ts
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { initChatlog, stampTs, ensureSeqs, dedupeIndex, rememberKey, logChat, noticeChat,
  clearQueued, clearQueuedByReply, sweepRestoredQueued, armQueueClear, resetForTest,
  awaitingQueue, armAwaiting, QUEUE_STUCK_MS, DEDUPE_KEEP, CHAT_KEEP, logSession, nextSeq,
  FACT_KEEP, type ChatSession } from "./chatlog.ts";
import type { ChatMsg } from "./chatmsg.ts";
import type { SessionRec } from "./sessionrec.ts";
import { rowsBySeq } from "./chatstore.ts";
import { tailPage, buildPage } from "../runtime/pages.ts";
import { until, settle } from "../test-utils/wait.ts";

let sessions: Map<string, ChatSession>;
let restored: Map<string, ChatMsg[]>;
let patches: { id: string; mts: number; unset: string[] }[];
let broadcasts: any[];
let appended: { aid: string; chatId: string; msg: ChatMsg }[];
let appendedRecs: { aid: string; chatId: string; rec: SessionRec }[];
let sentRecs: { id: string; rec: SessionRec }[];
let indexed: { aid: string; msg: ChatMsg }[];

beforeEach(() => {
  sessions = new Map();
  restored = new Map();
  patches = [];
  broadcasts = [];
  appended = [];
  appendedRecs = [];
  sentRecs = [];
  indexed = [];
  /* Cancels any deadline a previous test armed, so a five minute timer cannot
   * outlive the module state it closed over. */
  resetForTest();
  initChatlog({
    chatOf: (id) => sessions.get(id)?.chat ?? restored.get(id),
    restoredChats: () => restored,
    persistPatch: (id, mts, _set, unset) => patches.push({ id, mts, unset }),
    broadcast: (m) => broadcasts.push(m),
    chatRefFor: (id) => ({ aid: `ag-${id}`, chatId: "c1" }),
    indexMsgBlobs: (aid, msg) => indexed.push({ aid, msg }),
    appendMsg: (aid, chatId, msg) => appended.push({ aid, chatId, msg }),
    appendRec: (aid, chatId, rec) => appendedRecs.push({ aid, chatId, rec }),
    sendSessionRec: (id, rec) => sentRecs.push({ id, rec }),
  });
});
afterEach(() => resetForTest());

const mk = (chat: ChatMsg[] = []): ChatSession => {
  const s = { id: "s1", chat };
  sessions.set("s1", s);
  return s;
};
const m = (over: Partial<ChatMsg>): ChatMsg => ({ id: "s1", role: "claude", text: "t", ts: 1, ...over });

describe("stampTs", () => {
  test("strictly increasing even inside one millisecond", () => {
    const s = mk([m({ ts: Date.now() + 50 })]); // a message stamped 'ahead'
    const t1 = stampTs(s);
    expect(t1).toBeGreaterThan(s.chat[0].ts);
    s.chat.push(m({ ts: t1 }));
    expect(stampTs(s)).toBe(t1 + 1);
  });

  test("an empty log stamps now, and only the LAST message is consulted", () => {
    const before = Date.now();
    expect(stampTs(mk([]))).toBeGreaterThanOrEqual(before);
    /* A huge stamp buried mid-log (a hand edit, another version's write) must
     * not push every later message decades into the future: the rule is
     * last + 1, so the run recovers as soon as the outlier is behind. */
    const s = mk([m({ ts: 4_102_444_800_000 }), m({ ts: 5 })]);
    expect(stampTs(s)).toBeGreaterThanOrEqual(before);
    expect(stampTs(s)).toBeLessThan(4_102_444_800_000);
  });
});

describe("ensureSeqs", () => {
  test("backfills by position, once; no-op on a correct log", () => {
    const chat = [m({ ts: 1 }), m({ ts: 2 }), m({ ts: 3 })];
    ensureSeqs(chat);
    expect(chat.map((c) => c.seq)).toEqual([0, 1, 2]);
    chat[1].seq = 9; // disk is disk
    ensureSeqs(chat);
    expect(chat.map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  test("a log that does not start at 0 is renumbered from the front", () => {
    /* A front trim on an OLD engine dropped messages and left the survivors
     * carrying their old numbers. Page arithmetic wants seq gap-free from 0 for
     * a log it is renumbering at all, so the first message decides. */
    const chat = [m({ ts: 1, seq: 40 }), m({ ts: 2, seq: 41 }), m({ ts: 3, seq: 42 })];
    ensureSeqs(chat);
    expect(chat.map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  test("an empty log is left alone rather than crashing on chat[0]", () => {
    const chat: ChatMsg[] = [];
    ensureSeqs(chat);
    expect(chat).toEqual([]);
  });

  test("one message with no seq at the tail renumbers the whole array", () => {
    const chat = [m({ ts: 1, seq: 0 }), m({ ts: 2, seq: 1 }), m({ ts: 3 })];
    ensureSeqs(chat);
    expect(chat.map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  test("a SessionRec on the shared axis RENUMBERS message seqs (the dup-rows cause)", () => {
    /* This is the exact mechanism behind the duplicate-row bug. The FIRST
     * serve of an old log (no records yet) numbers the messages by position;
     * a restart then writes a session/resume record onto the SAME axis, and
     * the SECOND serve renumbers the very same messages PAST that record. The
     * messages' seqs changed between the two serves, so an app that dedups on
     * seq admits every row a second time -- a verbatim twin of both roles. */
    const rec = (seq: number): SessionRec =>
      ({ seq, ts: 1, id: `se-${seq}`, kind: "status", text: "resumed" });

    // Serve 1: no records on the axis yet -> seq by position.
    const serve1 = [m({ ts: 10 }), m({ ts: 20 }), m({ ts: 30 })];
    ensureSeqs(serve1, []);
    expect(serve1.map((c) => c.seq)).toEqual([0, 1, 2]);

    // Serve 2: the SAME messages, now with a record inserted at seq 4 (written
    // when the messages carried 0..2). ensureSeqs pushes them past the record.
    const serve2 = [m({ ts: 10 }), m({ ts: 20 }), m({ ts: 30 })];
    ensureSeqs(serve2, [rec(4)]);
    expect(serve2.map((c) => c.seq)).toEqual([5, 6, 7]);

    // The seqs are DIFFERENT across the two serves for the same rows: proof
    // that seq cannot be a stable per-row identity once a record is inserted.
    expect(serve2.map((c) => c.seq)).not.toEqual(serve1.map((c) => c.seq));
    // ts, by contrast, is untouched by the renumber -- the fix's fallback key.
    expect(serve2.map((c) => c.ts)).toEqual(serve1.map((c) => c.ts));
  });

  const rec = (seq: number, ts = 1): SessionRec =>
    ({ seq, ts, id: `se-${seq}`, kind: "status", text: "working" });

  test("a rogue mid-run seq is repaired in place; in-order messages keep their seqs", () => {
    /* THE BZ BUILDER SHAPE (2026-09-05): a live log whose message run carried
     * a few foreign-axis rows (seq 1, 2, 3) sitting mid-run in the holes of
     * the real axis, with tens of thousands of session records beside them.
     * The old branch renumbered EVERY message past the last record, which put
     * all records below all messages: the attach's pointer and tail pages
     * then held messages only, and the chat showed no session activity at
     * all. The repair renumbers only the row that breaks the run, to the
     * smallest seq after its predecessor, so every in-order message keeps
     * the seq that encodes its interleave with the records. */
    const chat = [
      m({ ts: 10, seq: 3 }), m({ ts: 20, seq: 4 }),
      m({ ts: 30, seq: 1 }), // the rogue row, written under a foreign axis
      m({ ts: 40, seq: 6 }),
    ];
    const log = [rec(0), rec(2), rec(5), rec(8)];
    ensureSeqs(chat, log);
    expect(chat.map((c) => c.seq)).toEqual([3, 4, 5, 6]);
    // and the repair is idempotent: a second serve changes nothing
    ensureSeqs(chat, log);
    expect(chat.map((c) => c.seq)).toEqual([3, 4, 5, 6]);
  });

  test("the newest records stay on the tail page after a repair (the no-activity bug)", () => {
    /* The user-visible half of the same divergence, pinned at the page level:
     * the newest rows of the log are RECORDS (live session activity), and a
     * broken message run further back must not evict them from the tail page.
     * Under the old whole-renumber the messages moved past seq 199 onto a
     * page of their own above every record, and the attach (pointer page +
     * tail page) served zero records. */
    const chat = [
      m({ ts: 10, seq: 100 }), m({ ts: 20, seq: 101 }),
      m({ ts: 30, seq: 2 }), // the rogue row
      m({ ts: 40, seq: 103 }),
    ];
    const log = [rec(95), rec(96), rec(198, 50), rec(199, 60)];
    ensureSeqs(chat, log);
    const rows = rowsBySeq(chat, log);
    const tail = buildPage(rows, tailPage(rows));
    const ids = tail.messages.map((r) => (r as SessionRec).id);
    expect(ids).toContain("se-198");
    expect(ids).toContain("se-199");
    // the messages kept their own page, below the newest records
    expect(chat.map((c) => c.seq)).toEqual([100, 101, 102, 103]);
  });

  test("a wholly unnumbered log with records is still renumbered past them", () => {
    /* The pre-seq shape (serve 2 above) keeps its pinned behaviour: no
     * message carries a number, so there is no interleave to preserve, and
     * renumbering past the records is what avoids colliding with them. */
    const chat = [m({ ts: 10 }), m({ ts: 20 })];
    ensureSeqs(chat, [rec(4)]);
    expect(chat.map((c) => c.seq)).toEqual([5, 6]);
  });
});

describe("dedupe index", () => {
  test("builds lazily from the persisted tail and caches on the session", () => {
    const s = mk([m({ key: "k1", msgId: "a", seq: 0 }), m({ role: "user", ts: 2, seq: 1 }), m({ key: "k2", ts: 3, seq: 2 })]);
    const idx = dedupeIndex(s);
    expect(idx.get("k1")).toEqual({ msgId: "a", seq: 0 });
    expect(idx.has("k2")).toBe(true);
    expect(dedupeIndex(s)).toBe(idx); // cached
  });

  test("only the AGENT's keyed replies are indexed", () => {
    /* The key is an at-least-once delivery key for a REPLY (#505). A user
     * message that happens to carry one is not a reply, and indexing it would
     * let an unrelated echo re-ack somebody else's utterance. */
    const s = mk([
      m({ role: "user", key: "k-user", ts: 1, seq: 0 }),
      m({ role: "claude", ts: 2, seq: 1 }),          // a reply with no key at all
      m({ role: "claude", key: "k-reply", ts: 3, seq: 2 }),
    ]);
    const idx = dedupeIndex(s);
    expect(idx.has("k-user")).toBe(false);
    expect([...idx.keys()]).toEqual(["k-reply"]);
  });

  test("a long log is indexed from its newest DEDUPE_KEEP messages only", () => {
    const chat: ChatMsg[] = [];
    for (let i = 0; i < DEDUPE_KEEP + 5; i++) chat.push(m({ key: `k${i}`, ts: i + 1, seq: i }));
    const idx = dedupeIndex(mk(chat));
    expect(idx.size).toBe(DEDUPE_KEEP);
    expect(idx.has("k0"), "an ancient key was rebuilt into the window").toBe(false);
    expect(idx.has("k4")).toBe(false);
    expect(idx.get(`k${DEDUPE_KEEP + 4}`)).toEqual({ msgId: undefined, seq: DEDUPE_KEEP + 4 });
  });

  test("rememberKey evicts the oldest past DEDUPE_KEEP", () => {
    const s = mk([]);
    for (let i = 0; i < DEDUPE_KEEP + 3; i++) rememberKey(s, `k${i}`, undefined, i);
    const idx = dedupeIndex(s);
    expect(idx.size).toBe(DEDUPE_KEEP);
    expect(idx.has("k0")).toBe(false);
    expect(idx.has(`k${DEDUPE_KEEP + 2}`)).toBe(true);
  });

  test("re-remembering a key updates it in place without growing the window", () => {
    const s = mk([]);
    rememberKey(s, "k", "first", 1);
    rememberKey(s, "k", "second", 7);
    expect(dedupeIndex(s).get("k")).toEqual({ msgId: "second", seq: 7 });
    expect(dedupeIndex(s).size).toBe(1);
  });
});

describe("logChat / noticeChat", () => {
  test("appends with the next seq and persists one line", () => {
    const s = mk([m({ ts: 1, seq: 4 })]);
    logChat(s, m({ ts: 2 }));
    expect(s.chat[1].seq).toBe(5);
    expect(appended.length).toBe(1);
    expect(appended[0].aid).toBe("ag-s1");
    expect(appended[0].chatId).toBe("c1");
  });

  test("the first message of a brand-new session is seq 0", () => {
    const s = mk([]);
    logChat(s, m({ ts: 1 }));
    expect(s.chat[0].seq, "a log that starts at 1 shifts every page by one").toBe(0);
  });

  test("mints a durable mid on append, kept if one is already set (dup-rows)", () => {
    const s = mk([]);
    const msg = m({ ts: 1 });
    logChat(s, msg);
    expect(msg.mid, "every appended row gets a durable id the app can dedup on").toBeDefined();
    const mid = msg.mid ?? "";
    expect(mid).toMatch(/^mr-[A-Za-z0-9_-]{16}$/);
    // Persisted in the same line, so it survives a restart.
    expect(appended[0].msg.mid).toBe(mid);
    // A re-broadcast of an existing row keeps its id rather than re-minting.
    const already = m({ ts: 2, mid: "mr-keepthisoneexact0" });
    logChat(s, already);
    expect(already.mid).toBe("mr-keepthisoneexact0");
  });

  test("the blob index learns the message in the same breath as the disk", () => {
    /* Both, or an attachment is on disk with nothing pointing at it and the
     * uploads sweep deletes his audio. */
    const s = mk([]);
    const msg = m({ ts: 1, msgId: "clip-1" });
    logChat(s, msg);
    expect(indexed).toEqual([{ aid: "ag-s1", msg }]);
    expect(appended[0].msg).toBe(msg);
  });

  test("history is kept in full: CHAT_KEEP does not trim the front", () => {
    /* It used to be 50, which quietly ate messages in any real conversation.
     * A trim here would also renumber nothing (seq is stored) but would lose
     * the log, so the assertion is about the array itself. */
    expect(CHAT_KEEP).toBe(Infinity);
    const s = mk([]);
    for (let i = 0; i < 300; i++) logChat(s, m({ ts: i + 1 }));
    expect(s.chat.length).toBe(300);
    expect(s.chat[0].seq).toBe(0);
    expect(s.chat[299].seq).toBe(299);
  });

  test("noticeChat logs AND broadcasts the same line (E7)", () => {
    const s = mk([]);
    const out = noticeChat(s, "restarted");
    expect(s.chat[0]).toBe(out);
    expect(appended.length).toBe(1);
    expect(broadcasts[0].t).toBe("chat");
    expect(broadcasts[0].text).toBe("restarted");
  });

  test("a notice stamps itself past the newest message and is the agent's", () => {
    const s = mk([m({ ts: Date.now() + 5_000 })]);
    const out = noticeChat(s, "restarted");
    expect(out.ts).toBeGreaterThan(s.chat[0].ts);
    expect(out.role).toBe("claude");
    expect(out.id).toBe("s1");
    // and the broadcast frame carries the same ts/seq the log line got
    expect(broadcasts[0].ts).toBe(out.ts);
    expect(broadcasts[0].seq).toBe(out.seq);
  });
});

describe("queued lifecycle", () => {
  test("clearQueued clears the flag, patches and broadcasts a dequeued", () => {
    const s = mk([m({ role: "user", ts: 10, queued: true })]);
    expect(clearQueued("s1", 10)).toBe(true);
    expect(s.chat[0].queued).toBeUndefined();
    expect(patches).toEqual([{ id: "s1", mts: 10, unset: ["queued"] }]);
    expect(broadcasts).toEqual([{ t: "dequeued", id: "s1", ts: 10 }]);
    expect(clearQueued("s1", 10)).toBe(false); // already clear
  });

  test("nothing is patched for a session, a ts or a role that does not match", () => {
    /* Each of these used to be a way to write a patch line for a message that
     * is not there, which replay then applies to whatever else shares the ts. */
    const s = mk([m({ role: "user", ts: 10, queued: true }), m({ role: "claude", ts: 11, queued: true })]);
    expect(clearQueued("nosuch", 10), "an unknown session").toBe(false);
    expect(clearQueued("s1", 999), "a ts nothing carries").toBe(false);
    expect(clearQueued("s1", 11), "an agent message is never queued input").toBe(false);
    expect(patches).toEqual([]);
    expect(broadcasts).toEqual([]);
    expect(s.chat[1].queued).toBe(true);
  });

  test("a consumption landing mid-delivery is remembered by the pre-armed entry's absence", async () => {
    /* deliver.ts pre-arms awaitingQueue (ts 0) BEFORE the keystrokes go out:
     * the current claude journals the user record ~0.45s after typing, often
     * while the echo gate is still settling. The consumption then deletes the
     * entry; commitDelivery reads that absence as consumedEarly and never
     * marks the row queued (the strip that stood until the next reply,
     * 2026-09-06). */
    const { markInContext } = await import("./ingest.ts");
    mk([]);
    // Armed by the delivery id (cid); the transcript echo comes in as the
    // delivered text and resolves back to it through awaitingByText.
    armAwaiting("c-hi-1", "s1", 0, "TEXT: hi (reply how)");
    markInContext("TEXT: hi (reply how)");
    expect(awaitingQueue.has("c-hi-1")).toBe(false);
    expect(patches, "no row exists yet; the placeholder clear patches nothing").toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  test("a keyed clear only fires while its map entry still owns the message", () => {
    mk([m({ role: "user", ts: 10, queued: true })]);
    // The key is the delivery id (cid); the delivered text rides on the value.
    awaitingQueue.set("c-body", { sessionId: "s1", ts: 99, text: "body" }); // superseded
    expect(clearQueued("s1", 10, "c-body")).toBe(false);
    expect(awaitingQueue.get("c-body"), "the newer send's entry was eaten by the older timer")
      .toEqual({ sessionId: "s1", ts: 99, text: "body" });
  });

  test("a keyed clear that still owns the message fires and gives the key back", () => {
    const s = mk([m({ role: "user", ts: 10, queued: true })]);
    awaitingQueue.set("c-body", { sessionId: "s1", ts: 10, text: "body" });
    expect(clearQueued("s1", 10, "c-body")).toBe(true);
    expect(awaitingQueue.has("c-body"), "the entry outlived the message it guarded").toBe(false);
    expect(s.chat[0].queued).toBeUndefined();
  });

  test("a pane nobody has opened is cleared through the restored log", () => {
    /* The flag lives on disk, and the session may never have been attached in
     * this process. chatOf falls through to restoredChats for exactly that. */
    restored.set("cold", [m({ role: "user", ts: 10, queued: true })]);
    expect(clearQueued("cold", 10)).toBe(true);
    expect(restored.get("cold")![0].queued).toBeUndefined();
    expect(patches).toEqual([{ id: "cold", mts: 10, unset: ["queued"] }]);
  });

  test("a reply drains every EARLIER queued flag, oldest first", () => {
    const s = mk([
      m({ role: "user", ts: 10, queued: true }),
      m({ role: "user", ts: 20, queued: true }),
      m({ role: "user", ts: 99, queued: true }), // after the reply: stays
    ]);
    clearQueuedByReply(s, 50);
    expect(s.chat.map((c) => !!c.queued)).toEqual([false, false, true]);
    expect(patches.map((p) => p.mts)).toEqual([10, 20]);
  });

  test("a reply does not drain the message stamped at the same instant", () => {
    /* Strictly earlier. stampTs makes a tie impossible within a session, so a
     * message sharing the reply's ts came from somewhere else and claude cannot
     * be shown to have read it. */
    const s = mk([m({ role: "user", ts: 50, queued: true })]);
    clearQueuedByReply(s, 50);
    expect(s.chat[0].queued).toBe(true);
    expect(patches).toEqual([]);
  });

  test("a reply into a log with nothing queued patches nothing", () => {
    const s = mk([m({ role: "user", ts: 10 }), m({ role: "claude", ts: 20 })]);
    clearQueuedByReply(s, 30);
    expect(patches).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  test("the boot sweep clears only flags past the deadline", () => {
    const now = Date.now();
    restored.set("old", [m({ role: "user", ts: now - QUEUE_STUCK_MS - 5000, queued: true })]);
    restored.set("fresh", [m({ role: "user", ts: now - 1000, queued: true })]);
    sweepRestoredQueued();
    expect(restored.get("old")![0].queued).toBeUndefined();
    expect(restored.get("fresh")![0].queued).toBe(true); // genuinely waiting
    expect(patches.map((p) => p.id)).toEqual(["old"]);
  });

  test("the sweep leaves agent lines and unflagged messages entirely alone", () => {
    const old = Date.now() - QUEUE_STUCK_MS - 5000;
    restored.set("mixed", [
      m({ role: "claude", ts: old, queued: true }), // not queued input, whatever the flag says
      m({ role: "user", ts: old }),                 // no flag to clear
    ]);
    sweepRestoredQueued();
    expect(restored.get("mixed")![0].queued, "an agent line was dequeued").toBe(true);
    expect(patches).toEqual([]);
  });

  test("a queued message with no usable ts is kept, never cleared on a NaN", () => {
    /* now - undefined is NaN and every comparison against it is false, so the
     * message falls into the KEEP branch. That is the direction that does not
     * lose data: the strip stays until something resolves it. */
    restored.set("weird", [{ id: "weird", role: "user", text: "x", queued: true } as unknown as ChatMsg]);
    sweepRestoredQueued();
    expect(restored.get("weird")![0].queued).toBe(true);
    expect(patches).toEqual([]);
  });

  test("an armed deadline clears the flag when it comes due", async () => {
    const s = mk([m({ role: "user", ts: 10, queued: true })]);
    armQueueClear("s1", 10, -5_000); // already past: clamped to 0, never to a negative delay
    await until(() => !s.chat[0].queued, { what: "the armed queue deadline to fire" });
    expect(broadcasts).toEqual([{ t: "dequeued", id: "s1", ts: 10 }]);
  });

  test("a deadline that cannot be computed is a whole window, not an instant clear", async () => {
    const s = mk([m({ role: "user", ts: 20, queued: true })]);
    armQueueClear("s1", 20, Number.NaN);
    await settle();
    expect(s.chat[0].queued,
      "a message whose deadline was NaN was dequeued at once, which is the data-losing direction")
      .toBe(true);
  });
});

describe("logSession (the session records, design A.1/A.2)", () => {
  const src = (rid: string, over: Partial<SessionRec> = {}): Parameters<typeof logSession>[1] =>
    ({ ts: 10, kind: "tool", text: "Read x", tool: { name: "Read" }, src: { h: "claude", sid: "u1", rid, off: 0 }, ...over });

  test("stamps the next seq on the axis the messages share, mints an id, persists one line, sends it live", () => {
    const s = mk([m({ ts: 1, seq: 0 }), m({ ts: 2, seq: 1 })]);
    const rec = logSession(s, src("r1"))!;
    expect(rec.seq).toBe(2);
    expect(rec.id).toMatch(/^se-[A-Za-z0-9_-]{16}$/);
    expect(s.log).toEqual([rec]);
    expect(appendedRecs).toEqual([{ aid: "ag-s1", chatId: "c1", rec }]);
    expect(sentRecs).toEqual([{ id: "s1", rec }]);
    // the next message continues past the record: ONE axis
    expect(logChat(s, m({ ts: 3 }))).toBe(3);
    expect(nextSeq(s)).toBe(4);
    expect(logSession(s, src("r2"))!.seq).toBe(4);
  });

  test("a transcript record is idempotent on its source key: a replay past the pointer writes nothing", () => {
    const s = mk([]);
    expect(logSession(s, src("r1"))).not.toBeNull();
    expect(logSession(s, src("r1", { text: "different text, same record" }))).toBeNull();
    expect(s.log!.length).toBe(1);
    expect(appendedRecs.length).toBe(1);
    // another transcript (sid) with the same rid is a different record
    expect(logSession(s, src("r1", { src: { h: "claude", sid: "u2", rid: "r1", off: 0 } }))).not.toBeNull();
  });

  test("the source keys are rebuilt from the restored log, so the dedupe survives a restart", () => {
    const s = mk([]);
    s.log = [{ seq: 0, ts: 10, id: "se-x", kind: "tool", text: "Read", src: { h: "claude", sid: "u1", rid: "r1", off: 0 } }];
    expect(logSession(s, src("r1"))).toBeNull();
    expect(logSession(s, src("r2"))!.seq).toBe(1);
  });

  test("an engine-authored record is idempotent on kind+ts+text", () => {
    const s = mk([]);
    expect(logSession(s, { ts: 5, kind: "status", text: "status: working", status: "working" })).not.toBeNull();
    expect(logSession(s, { ts: 5, kind: "status", text: "status: working", status: "working" })).toBeNull();
    expect(logSession(s, { ts: 6, kind: "status", text: "status: working", status: "working" })).not.toBeNull();
    expect(s.log!.length).toBe(2);
  });

  test("the fact window forgets the oldest past FACT_KEEP", () => {
    const s = mk([]);
    for (let i = 0; i < FACT_KEEP + 1; i++) logSession(s, { ts: i, kind: "note", text: "n" });
    expect(logSession(s, { ts: 0, kind: "note", text: "n" }), "evicted: logs again").not.toBeNull();
    expect(logSession(s, { ts: FACT_KEEP, kind: "note", text: "n" }), "still in the window").toBeNull();
  });

  test("a legitimate body (6000 chars) survives logSession un-truncated", () => {
    const s = mk([]);
    const rec = logSession(s, { ts: 1, kind: "prompt", text: "x".repeat(6000) })!;
    expect(rec.text.length).toBe(6000);
    expect(rec.text.includes("…"), "no ellipsis: not re-truncated").toBe(false);
    expect(appendedRecs[0].rec.text.length).toBe(6000);
  });

  test("REC_TEXT_CAP is the safety bound: a pathological >20000 record is capped", () => {
    const s = mk([]);
    const rec = logSession(s, { ts: 2, kind: "reply", text: "x".repeat(25000) })!;
    expect(rec.text.length).toBe(20000);
    expect(rec.text.endsWith("…"), "capped with an ellipsis").toBe(true);
    expect(appendedRecs[0].rec.text.length).toBe(20000);
  });

  test("a 200-cap one-liner (sized upstream) is unaffected by the safety bound", () => {
    const s = mk([]);
    const line = "y".repeat(200);
    const rec = logSession(s, { ts: 3, kind: "tool", text: line })!;
    expect(rec.text.length).toBe(200);
    expect(rec.text.includes("…")).toBe(false);
  });
});

describe("ensureSeqs with session records on the axis", () => {
  const rec = (seq: number): SessionRec => ({ seq, ts: seq, id: `se-${seq}`, kind: "note", text: "n" });

  test("messages with gaps (records between them) are a correct axis: nothing is renumbered", () => {
    const chat = [m({ seq: 0 }), m({ seq: 3 }), m({ seq: 7 })];
    ensureSeqs(chat, [rec(1), rec(2), rec(4), rec(5), rec(6)]);
    expect(chat.map((c) => c.seq)).toEqual([0, 3, 7]);
  });

  test("a broken run in a partly numbered chat is repaired in place, not shoved past the records", () => {
    /* This pinned the OLD rule (renumber the whole chat past the last record,
     * [6, 7, 8] here), which is the no-session-activity bug: one bad row put
     * every message above every record and the tail pages served no records
     * at all. The rule now: only the row that breaks the run is renumbered,
     * to the smallest seq after its predecessor. That seq can land on a
     * record's (1 here): rowsBySeq orders the message first on the tie and
     * the page arithmetic is range-based, so the duplicate is served, never
     * lost -- while every in-order message keeps its interleave. */
    const chat = [m({ seq: 0 }), m({}), m({ seq: 2 })];
    ensureSeqs(chat, [rec(1), rec(5)]);
    expect(chat.map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  test("with no records the old rule holds: gap-free by position from 0", () => {
    const chat = [m({ seq: 0 }), m({ seq: 3 })];
    ensureSeqs(chat, []);
    expect(chat.map((c) => c.seq)).toEqual([0, 1]);
  });
});
