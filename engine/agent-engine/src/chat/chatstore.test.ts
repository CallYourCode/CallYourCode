/* chatstore.ts: the append-only chat jsonl (the design).
 *
 * The properties the layout stands on: a message is one appended line, a
 * mutation is one appended patch line, replay applies patches by the message's
 * own ts, a torn trailing line loses only itself, and writeNew mints a fresh
 * file without touching an existing one.
 *
 * CYC_DATA_DIR is set ONCE for the whole file, in beforeAll, and restored in
 * afterAll. datadir.ts reads it on every call, so a mid-file mutation would
 * still "work" and that is exactly why it is not done here: two tests then race
 * over which directory the third one meant. Every test mints its own chat id
 * instead, which is the isolation that actually matters.
 *
 *   bun test agent-engine/src/chat/chatstore.test.ts
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { ChatStore, replayChatText, replayLogText, rowsBySeq, applyPatch, newChatId } from "./chatstore.ts";
import { buildPage, tailPage, PAGE_SIZE } from "../runtime/pages.ts";
import type { SessionRec } from "./sessionrec.ts";
import { agentChatFile, agentChatsDir, agentDir } from "../storage/datadir.ts";
import { tmpDir } from "../test-utils/tmp.ts";

const AID = "ag-chatstoretest0000";
let savedEnv: string | undefined;

/* At module scope, not inside beforeAll: tmp.ts registers its cleanup with
 * afterAll on first use, and bun runs a hook registered from inside a running
 * hook the moment that hook returns, which would delete the data dir before the
 * first test writes into it. */
const scratch = tmpDir("cyc-chatstore-");

beforeAll(async () => {
  savedEnv = process.env.CYC_DATA_DIR;
  process.env.CYC_DATA_DIR = await scratch;
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = savedEnv;
});

/** A store and a chat id nothing else in this file writes to. */
const rig = () => ({ store: new ChatStore(), chatId: newChatId() });
const linesOf = (chatId: string, aid = AID) =>
  readFileSync(agentChatFile(aid, chatId), "utf8").split("\n").filter(Boolean);

// ------------------------------------------------------------------ appending

test("append + load round-trips messages in order, one line each", async () => {
  const { store, chatId } = rig();
  store.appendMsg(AID, chatId, { ts: 1, id: "s", role: "user", text: "hi", seq: 0 });
  store.appendMsg(AID, chatId, { ts: 2, id: "s", role: "claude", text: "hello", seq: 1 });
  await store.flush();

  const msgs = await store.load(AID, chatId);
  expect(msgs.map((m) => m.text)).toEqual(["hi", "hello"]);

  // one line per message, and no rewrite of line 1 when line 2 landed
  const raw = linesOf(chatId);
  expect(raw.length).toBe(2);
  expect(JSON.parse(raw[0]).t).toBe("m");
  expect(JSON.parse(raw[0]).seq, "the caller's seq rides on the line").toBe(0);
});

test("line order on disk is CALL order, not completion order", async () => {
  /* Every append goes through one promise chain per file. Without it the first
   * mkdir + append can finish after the tenth, and a log replayed in the wrong
   * order is a conversation whose answers precede their questions. */
  const { store, chatId } = rig();
  for (let i = 0; i < 20; i++) store.appendMsg(AID, chatId, { ts: i + 1, text: `m${i}` });
  await store.flush();
  expect((await store.load(AID, chatId)).map((m) => m.text))
    .toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
});

test("flush waits for appends issued before it, and is safe to call twice", async () => {
  const { store, chatId } = rig();
  store.appendMsg(AID, chatId, { ts: 1, text: "a" });
  await store.flush();
  await store.flush(); // nothing outstanding: resolves rather than hanging
  expect(linesOf(chatId).length).toBe(1);
});

test("two chats of one agent are two files that do not see each other", async () => {
  const { store, chatId } = rig();
  const other = newChatId();
  store.appendMsg(AID, chatId, { ts: 1, text: "mine" });
  store.appendMsg(AID, other, { ts: 1, text: "theirs" });
  await store.flush();
  expect((await store.load(AID, chatId)).map((m) => m.text)).toEqual(["mine"]);
  expect((await store.load(AID, other)).map((m) => m.text)).toEqual(["theirs"]);
});

test("an append that cannot land is reported, and never rejects the chain", async () => {
  /* The chain is shared by every later append to the same file, so one failure
   * that rejects it would silently swallow every message after it. It calls the
   * error hook the boot installed instead and carries on. */
  const badAid = "ag-chatstorebroken00";
  const errors: string[] = [];
  const store = new ChatStore((_e, path) => errors.push(path));
  // a FILE where the agent's directory should be: mkdir -p under it is ENOTDIR
  mkdirSync(join(process.env.CYC_DATA_DIR!, "agents"), { recursive: true });
  writeFileSync(agentDir(badAid), "not a directory");
  const chatId = newChatId();
  store.appendMsg(badAid, chatId, { ts: 1, text: "doomed" });
  store.appendMsg(badAid, chatId, { ts: 2, text: "also doomed" });
  await store.flush(); // resolves; a rejected chain would throw here
  expect(errors.length, "the failed appends were swallowed instead of reported").toBe(2);
  expect(errors[0]).toContain(chatId);
});

// -------------------------------------------------------------------- patches

test("a patch line edits exactly the message its mts names", async () => {
  const { store, chatId } = rig();
  store.appendMsg(AID, chatId, { ts: 10, role: "user", text: "a", queued: true });
  store.appendMsg(AID, chatId, { ts: 11, role: "user", text: "b", queued: true });
  store.appendPatch(AID, chatId, { mts: 10, del: ["queued"] });
  store.appendPatch(AID, chatId, { mts: 11, set: { text: "b2" } });
  await store.flush();

  const msgs = await store.load(AID, chatId);
  expect(msgs[0].queued).toBeUndefined();
  expect(msgs[0].text).toBe("a");
  expect(msgs[1].queued).toBe(true);
  expect(msgs[1].text).toBe("b2");
});

test("a patch is APPENDED: no earlier line is rewritten", async () => {
  const { store, chatId } = rig();
  store.appendMsg(AID, chatId, { ts: 10, text: "a", queued: true });
  await store.flush();
  const before = linesOf(chatId)[0];
  store.appendPatch(AID, chatId, { mts: 10, del: ["queued"] });
  await store.flush();
  const after = linesOf(chatId);
  expect(after.length).toBe(2);
  expect(after[0], "the message line was rewritten in place").toBe(before);
  expect(JSON.parse(after[1])).toEqual({ t: "e", ev: "patch", mts: 10, del: ["queued"] });
});

test("an empty set or del is left off the line rather than written as noise", async () => {
  const { store, chatId } = rig();
  store.appendPatch(AID, chatId, { mts: 1, set: {}, del: [] });
  await store.flush();
  expect(JSON.parse(linesOf(chatId)[0])).toEqual({ t: "e", ev: "patch", mts: 1 });
});

test("one patch can set and delete in the same line", async () => {
  /* Typed loosely on purpose: applyPatch SETS keys the row did not have, which
   * is half of what this test is about, and an inferred literal type makes
   * every one of them an excess property. */
  const msgs: Array<Record<string, unknown> & { ts: number }> =
    [{ ts: 5, text: "x", queued: true }];
  applyPatch(msgs, { mts: 5, set: { text: "y", growing: true }, del: ["queued"] });
  expect(msgs[0]).toEqual({ ts: 5, text: "y", growing: true });
});

test("a patch for a ts that is not there is a no-op, never a crash", () => {
  const msgs = [{ ts: 5, text: "x" }];
  applyPatch(msgs, { mts: 99, set: { text: "y" } });
  expect(msgs[0].text).toBe("x");
});

test("a patch addresses the FIRST message with that ts and only that one", () => {
  /* ts is strictly increasing per chat (stampTs), so a duplicate can only come
   * from a merged or hand-edited log. Editing both would corrupt a message the
   * patch was never about. */
  const msgs = [{ ts: 5, text: "first" }, { ts: 5, text: "second" }];
  applyPatch(msgs, { mts: 5, set: { text: "edited" } });
  expect(msgs.map((m) => m.text)).toEqual(["edited", "second"]);
});

// --------------------------------------------------------------------- replay

test("a torn trailing line loses only itself", async () => {
  const { store, chatId } = rig();
  store.appendMsg(AID, chatId, { ts: 1, text: "kept" });
  await store.flush();
  appendFileSync(agentChatFile(AID, chatId), '{"t":"m","ts":2,"tex'); // the crash

  const msgs = await store.load(AID, chatId);
  expect(msgs.length).toBe(1);
  expect(msgs[0].text).toBe("kept");
});

test("a torn line in the MIDDLE loses only itself, never the rest of the log", async () => {
  /* Only the last line can be torn by a crashed append, but a log that has been
   * concatenated or hand-edited can hold one anywhere, and a skipped message
   * beats a lost conversation. */
  const msgs = replayChatText(
    '{"t":"m","ts":1,"text":"a"}\n{"t":"m","ts":2,"tex\n{"t":"m","ts":3,"text":"c"}\n');
  expect(msgs.map((m) => m.text)).toEqual(["a", "c"]);
});

test("replayChatText ignores line shapes it does not know", () => {
  const msgs = replayChatText(
    '{"t":"m","ts":1,"text":"a"}\n{"t":"future-thing","ts":9}\n{"t":"m","ts":2,"text":"b"}\n');
  expect(msgs.map((m) => m.text)).toEqual(["a", "b"]);
});

test("blank lines, whitespace and a non-object line are all skipped", () => {
  const msgs = replayChatText('\n  \n{"t":"m","ts":1,"text":"a"}\n\n42\nnull\n"just a string"\n');
  expect(msgs.map((m) => m.text)).toEqual(["a"]);
});

test("a message with no usable ts is kept, and no patch can reach it", () => {
  /* The old whole-file restore kept it, so this one does too: it is still a
   * line of his conversation. It is merely unaddressable, which is a property
   * worth stating rather than a bug to fix by dropping the message. */
  const msgs = replayChatText(
    '{"t":"m","text":"no ts"}\n{"t":"e","ev":"patch","mts":null,"set":{"text":"clobbered"}}\n');
  expect(msgs.length).toBe(1);
  expect(msgs[0].text, "a patch with no mts edited a message with no ts").toBe("no ts");
});

test("a patch line with a junk set or del is dropped rather than believed", () => {
  const msgs = replayChatText([
    '{"t":"m","ts":1,"text":"a","queued":true}',
    '{"t":"e","ev":"patch","mts":1,"set":"not an object"}',
    '{"t":"e","ev":"patch","mts":1,"del":"queued"}',        // a string, not an array
    '{"t":"e","ev":"patch","mts":1,"del":[7,"queued"]}',    // the number is filtered out
    '{"t":"e","ev":"whatever","mts":1,"set":{"text":"no"}}',// not a patch event
  ].join("\n") + "\n");
  expect(msgs[0].text).toBe("a");
  expect(msgs[0].queued, "the one well-formed del should still have applied").toBeUndefined();
});

test("the t field never survives onto the message it labelled", () => {
  const msgs = replayChatText('{"t":"m","ts":1,"text":"a"}\n');
  expect("t" in msgs[0]).toBe(false);
});

test("an empty file replays to an empty log", () => {
  expect(replayChatText("")).toEqual([]);
  expect(replayChatText("\n\n")).toEqual([]);
});

// -------------------------------------------------------------------- writeNew

test("writeNew mints a fresh file and leaves the old one alone", async () => {
  const { store, chatId } = rig();
  store.appendMsg(AID, chatId, { ts: 1, text: "old" });
  await store.flush();

  const trimmed = await store.writeNew(AID, [{ ts: 2, text: "kept tail" }]);
  expect(trimmed).not.toBe(chatId);
  expect((await store.load(AID, chatId)).map((m) => m.text)).toEqual(["old"]);
  expect((await store.load(AID, trimmed)).map((m) => m.text)).toEqual(["kept tail"]);
  expect((await store.listChats(AID)).sort()).toContain(trimmed);
  expect((await store.listChats(AID))).toContain(chatId);
});

test("writeNew writes the whole body as one line each, in the order given", async () => {
  const { store } = rig();
  const id = await store.writeNew(AID, [{ ts: 3, text: "c" }, { ts: 1, text: "a" }]);
  const raw = linesOf(id);
  expect(raw.length).toBe(2);
  expect(raw.map((l) => JSON.parse(l).text), "writeNew must not sort his log").toEqual(["c", "a"]);
  expect(raw.every((l) => JSON.parse(l).t === "m")).toBe(true);
});

test("writeNew of an empty log is a real, empty file", async () => {
  /* A merge or trim that leaves nothing has to leave a FILE, or the meta
   * pointer flips to a chat id that loads as "not written yet" and the next
   * append re-creates it with no history at all. */
  const { store } = rig();
  const id = await store.writeNew(AID, []);
  expect(await Bun.file(agentChatFile(AID, id)).exists()).toBe(true);
  expect(await store.load(AID, id)).toEqual([]);
  expect(await store.listChats(AID)).toContain(id);
});

test("writeNew's file is appendable afterwards, with no torn join", async () => {
  const { store } = rig();
  const id = await store.writeNew(AID, [{ ts: 1, text: "kept tail" }]);
  store.appendMsg(AID, id, { ts: 2, text: "next" });
  await store.flush();
  expect((await store.load(AID, id)).map((m) => m.text)).toEqual(["kept tail", "next"]);
});

// -------------------------------------------------------------------- reading

test("loading a chat that has no file yet is an empty log", async () => {
  const { store } = rig();
  expect(await store.load(AID, newChatId())).toEqual([]);
});

test("listChats is empty for an agent with no chats dir, and ignores stray files", async () => {
  const store = new ChatStore();
  expect(await store.listChats("ag-chatstorenothing0")).toEqual([]);

  const { chatId } = rig();
  store.appendMsg(AID, chatId, { ts: 1, text: "a" });
  await store.flush();
  writeFileSync(join(agentChatsDir(AID), "notes.txt"), "not a chat");
  const ids = await store.listChats(AID);
  expect(ids).toContain(chatId);
  expect(ids.some((n) => n.includes("notes")), "a stray file was read as a chat id").toBe(false);
});

test("a chat id that is not one is refused before any path is built", () => {
  /* The id lands in a filename, so a traversal in it would be a write outside
   * the agent's directory. datadir.ts refuses it; this is the assertion that
   * the store cannot get there another way. */
  const store = new ChatStore();
  expect(() => store.appendMsg(AID, "../../escape", { ts: 1 })).toThrow(/not a chat id/);
  expect(() => agentChatFile(AID, "a/b")).toThrow(/not a chat id/);
});

// ------------------------------------------------ session records (t:"s")

const rec = (seq: number, over: Partial<SessionRec> = {}): SessionRec =>
  ({ seq, ts: 100 + seq, id: `se-${String(seq).padStart(16, "0")}`, kind: "tool", text: "Read a.ts",
    tool: { name: "Read" }, src: { h: "claude", sid: "u1", rid: `r${seq}`, off: seq * 10 }, ...over });
/** A stored message as the page arithmetic sees it. */
type SeqMsg = { ts: number; seq?: number };

test("appendRec writes one t:s line on the same file, in call order with the messages", async () => {
  const { store, chatId } = rig();
  store.appendMsg(AID, chatId, { ts: 1, id: "s", role: "user", text: "hi", seq: 0 });
  store.appendRec(AID, chatId, rec(1));
  store.appendMsg(AID, chatId, { ts: 3, id: "s", role: "claude", text: "hello", seq: 2 });
  store.appendRec(AID, chatId, rec(3, { kind: "status", text: "status: idle", status: "idle", src: undefined }));
  await store.flush();

  const raw = linesOf(chatId).map((l) => JSON.parse(l));
  expect(raw.map((j) => j.t)).toEqual(["m", "s", "m", "s"]);
  expect(raw[1]).toMatchObject({ t: "s", seq: 1, kind: "tool", src: { rid: "r1" } });

  const loaded = await store.loadLog(AID, chatId);
  expect(loaded.torn).toBe(false);
  expect(loaded.msgs.map((m) => m.text)).toEqual(["hi", "hello"]);
  expect(loaded.recs.map((r) => r.seq)).toEqual([1, 3]);
  expect(loaded.recs[0], "the t label never survives onto the record").not.toHaveProperty("t");
  expect(loaded.recs[1].src).toBeUndefined();
  // the message-only view still drops the records
  expect((await store.load(AID, chatId)).map((m) => m.text)).toEqual(["hi", "hello"]);
});

test("a torn trailing line is reported, and the rows before it are whole", async () => {
  const { store, chatId } = rig();
  store.appendMsg(AID, chatId, { ts: 1, text: "kept", seq: 0 });
  store.appendRec(AID, chatId, rec(1));
  await store.flush();
  appendFileSync(agentChatFile(AID, chatId), '{"t":"s","seq":2,"ts":102,"id":"se-x","kind":"to'); // the crash

  const loaded = await store.loadLog(AID, chatId);
  expect(loaded.torn).toBe(true);
  expect(loaded.msgs.length).toBe(1);
  expect(loaded.recs.map((r) => r.seq)).toEqual([1]);
});

test("a torn line in the middle is skipped but not reported as torn", () => {
  const r = replayLogText('{"t":"s","seq":0,"ts":1,"id":"a","kind":"note","text":"x"}\n{"t":"s","seq":1,"ts\n{"t":"m","ts":3,"text":"c","seq":2}\n');
  expect(r.torn).toBe(false);
  expect(r.recs.length).toBe(1);
  expect(r.msgs.length).toBe(1);
});

test("a t:s line this build cannot read (unknown kind, no seq) is skipped, never believed", () => {
  const r = replayLogText([
    '{"t":"s","seq":0,"ts":1,"id":"a","kind":"note","text":"ok"}',
    '{"t":"s","seq":1,"ts":2,"id":"b","kind":"from-the-future","text":"?"}',
    '{"t":"s","ts":3,"id":"c","kind":"note","text":"no seq"}',
    '{"t":"s","seq":3,"ts":4,"id":"d","kind":"note","text":"bad src","src":{"h":"claude"}}',
  ].join("\n"));
  expect(r.recs.map((x) => x.text)).toEqual(["ok", "bad src"]);
  expect(r.recs[1].src, "a malformed src is dropped, the record kept").toBeUndefined();
});

test("rowsBySeq merges the two kinds by seq; a pre-seq message sorts by its position", () => {
  const msgs = [{ ts: 1, seq: 0, text: "m0" }, { ts: 2, seq: 2, text: "m2" }, { ts: 3, seq: 5, text: "m5" }];
  const recs = [rec(1), rec(3), rec(4)];
  expect(rowsBySeq(msgs, recs).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  // a pre-seq message sorts by its index among the messages; a tie goes to the message
  const unstamped: { ts: number; seq?: number; text: string }[] = [{ ts: 1, text: "a" }, { ts: 2, text: "b" }];
  expect(rowsBySeq(unstamped, [rec(1)]).map((r) => r.text)).toEqual(["a", "b", "Read a.ts"]);
  expect(rowsBySeq(unstamped, [rec(0)]).map((r) => r.text)).toEqual(["a", "Read a.ts", "b"]);
  expect(rowsBySeq([], recs).length).toBe(3);
  expect(rowsBySeq(msgs, []).length).toBe(3);
});

test("writeNew interleaves records with messages by seq and labels each row", async () => {
  const { store } = rig();
  const id = await store.writeNew(AID,
    [{ ts: 1, text: "a", seq: 0 }, { ts: 3, text: "c", seq: 2 }], [rec(1)]);
  const raw = linesOf(id).map((l) => JSON.parse(l));
  expect(raw.map((j) => [j.t, j.seq])).toEqual([["m", 0], ["s", 1], ["m", 2]]);
  const loaded = await store.loadLog(AID, id);
  expect(loaded.msgs.map((m) => m.text)).toEqual(["a", "c"]);
  expect(loaded.recs.map((r) => r.seq)).toEqual([1]);
});

test("a chat file from before the session log (no t:s lines) still reads and pages", async () => {
  /* A COPY of a fixture shaped like an old engine's chat file, never a host
   * file: messages and one patch line, no records. */
  const { store, chatId } = rig();
  mkdirSync(agentChatsDir(AID), { recursive: true });
  copyFileSync(join(import.meta.dir, "../fixtures/chat-pre-log.jsonl"), agentChatFile(AID, chatId));

  const loaded = await store.loadLog(AID, chatId);
  expect(loaded.torn).toBe(false);
  expect(loaded.recs).toEqual([]);
  expect(loaded.msgs.map((m) => m.text)).toEqual(["hello there", "Hi. What are we building?", "a per-agent log", "On it.", "thanks"]);
  expect(loaded.msgs[2].queued, "the patch line still applies").toBeUndefined();

  const rows = rowsBySeq(loaded.msgs as SeqMsg[], loaded.recs);
  expect(tailPage(rows as { seq: number; ts: number }[])).toBe(0);
  const page = buildPage(rows as { seq: number; ts: number }[], 0);
  expect(page.messages.length).toBe(5);
  expect(page.version).toBe(5);
  expect(page.sealed).toBe(false);
  expect(PAGE_SIZE).toBe(100);
  // and appending a record afterwards continues the same axis on the same file
  store.appendRec(AID, chatId, rec(5));
  await store.flush();
  const again = await store.loadLog(AID, chatId);
  expect(again.recs.map((r) => r.seq)).toEqual([5]);
  const rows2 = rowsBySeq(again.msgs as SeqMsg[], again.recs) as { seq: number; ts: number }[];
  expect(buildPage(rows2, 0).messages.length).toBe(6);
});
