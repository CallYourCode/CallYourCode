/* migrate-from-rows.ts: the one-shot boot cleanup of the reverted
 * agent-message-rows feature's role:user+from receipt rows.
 *
 * What must hold: exactly the role:user rows carrying a non-empty `from` are
 * removed and NOTHING else (user rows without it, claude rows, session
 * records, every other field of the survivors); the rewrite is the store's
 * sanctioned whole-file path (a NEW chat file, the old one untouched on disk,
 * the meta pointer flipped and the new id appended to meta.chats); a clean
 * log is a no-op that returns the same array and writes no file; and the
 * whole thing is idempotent, because a migrated log is a clean log.
 *
 *   bun test agent-engine/src/chat/migrate-from-rows.test.ts
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { ChatStore, newChatId, type StoredMsg } from "./chatstore.ts";
import type { SessionRec } from "./sessionrec.ts";
import type { AgentMeta } from "../runtime/agentmeta.ts";
import { dropDeliveredReceiptRows, isDeliveredReceiptRow } from "./migrate-from-rows.ts";
import { agentChatFile, agentChatsDir, agentDir } from "../storage/datadir.ts";
import { join } from "node:path";
import { tmpDir } from "../test-utils/tmp.ts";

const AID = "ag-migratefromtest00";
let savedEnv: string | undefined;

// module scope, not beforeAll: see chatstore.test.ts for why
const scratch = tmpDir("cyc-migrate-from-");

beforeAll(async () => {
  savedEnv = process.env.CYC_DATA_DIR;
  process.env.CYC_DATA_DIR = await scratch;
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = savedEnv;
});

const metaFor = (chat: string): AgentMeta =>
  ({ v: 2, agentId: AID, sessionId: null, chat, chats: [{ id: chat, createdAt: 1 }] });

/* A log shaped like the live one the feature wrote into: his own sends (with
 * and without cid/uploads), agent replies, an engine divider, session records
 * interleaved on the shared seq axis, and the feature's receipt rows. */
const OWN: StoredMsg = { ts: 1000, id: AID, role: "user", text: "hello", cid: "m-1",
  seq: 0, mid: "mr-own0000000000000a" } as unknown as StoredMsg;
const REPLY: StoredMsg = { ts: 2000, id: AID, role: "claude", text: "hi", seq: 1,
  mid: "mr-rep0000000000000a" } as unknown as StoredMsg;
const FAKE1: StoredMsg = { ts: 3000, id: AID, role: "user", seq: 3,
  text: "pipeline-health tick", from: "ag-x (BZ Builder)",
  mid: "mr-fake000000000000a" } as unknown as StoredMsg;
const OWN2: StoredMsg = { ts: 4000, id: AID, role: "user", text: "status?", cid: "m-2",
  seq: 4, mid: "mr-own0000000000000b" } as unknown as StoredMsg;
const DIVIDER: StoredMsg = { ts: 4500, id: AID, role: "claude", kind: "system",
  text: "new session (clear)", seq: 5, mid: "mr-div0000000000000a" } as unknown as StoredMsg;
const FAKE2: StoredMsg = { ts: 5000, id: AID, role: "user", seq: 6,
  text: "SCHEDULED tick body", from: "SCHEDULED (visibility-test)",
  mid: "mr-fake000000000000b" } as unknown as StoredMsg;
const REC: SessionRec = { seq: 2, ts: 2500, id: "se-rec0000000000000a", kind: "prompt",
  text: "> ag-x (BZ Builder): pipeline-health tick", source: "manual" };

async function seed(): Promise<{ store: ChatStore; chatId: string }> {
  const store = new ChatStore();
  const chatId = newChatId();
  for (const m of [OWN, REPLY, FAKE1, OWN2, DIVIDER, FAKE2]) store.appendMsg(AID, chatId, m);
  store.appendRec(AID, chatId, REC);
  await store.flush();
  return { store, chatId };
}

test("the discriminator is role:user plus a non-empty from, nothing wider", () => {
  expect(isDeliveredReceiptRow(FAKE1)).toBe(true);
  expect(isDeliveredReceiptRow(FAKE2)).toBe(true);
  expect(isDeliveredReceiptRow(OWN)).toBe(false); // his own send
  expect(isDeliveredReceiptRow(REPLY)).toBe(false); // an agent reply
  // a claude row with a stray from is not the feature's shape and is kept
  expect(isDeliveredReceiptRow({ role: "claude", from: "x" })).toBe(false);
  // an empty from was never written and does not match
  expect(isDeliveredReceiptRow({ role: "user", from: "" })).toBe(false);
  expect(isDeliveredReceiptRow({ role: "user", text: "hi" })).toBe(false);
});

test("removes exactly the from-rows, rewrites to a NEW file, flips the meta, keeps the old file", async () => {
  const { store, chatId } = seedResult ?? (seedResult = await seed());
  const loaded = await store.loadLog(AID, chatId);
  const meta = metaFor(chatId);
  const logs: string[] = [];
  const kept = await dropDeliveredReceiptRows(store, meta, loaded.msgs, loaded.recs,
    (l) => logs.push(l));

  // exactly the two receipt rows are gone; everything else survives, in order,
  // seqs untouched (the interleave with the records is the truth on disk)
  expect(kept.map((m) => m.mid)).toEqual([OWN.mid, REPLY.mid, OWN2.mid, DIVIDER.mid]);
  expect(kept.map((m) => m.seq)).toEqual([0, 1, 4, 5]);
  expect(kept[0]).toMatchObject({ text: "hello", cid: "m-1" });

  // the meta pointer flipped to a new chat id, appended to chats
  expect(meta.chat).not.toBe(chatId);
  expect(meta.chats!.map((c) => c.id)).toEqual([chatId, meta.chat!]);

  // the new file holds the survivors AND the session record; the old file is
  // still on disk, byte-for-byte a history of what was written
  const rewritten = await store.loadLog(AID, meta.chat!);
  expect(rewritten.msgs.map((m) => m.mid)).toEqual(kept.map((m) => m.mid));
  expect(rewritten.msgs.some((m) => "from" in m)).toBe(false);
  expect(rewritten.recs).toEqual([REC]);
  expect(existsSync(agentChatFile(AID, chatId))).toBe(true);
  expect(readFileSync(agentChatFile(AID, chatId), "utf8")).toContain("BZ Builder");

  // the migration said what it did
  expect(logs.join("\n")).toContain("dropped 2");

  // and the meta landed on disk (saveAgentMeta wrote agents/<aid>/meta.json)
  const onDisk = JSON.parse(readFileSync(join(agentDir(AID), "meta.json"), "utf8")) as AgentMeta;
  expect(onDisk.chat).toBe(meta.chat!);
  migrated = meta.chat!;
});
let seedResult: { store: ChatStore; chatId: string } | null = null;
let migrated: string | null = null;

test("idempotent: a migrated (clean) log is a no-op that writes nothing", async () => {
  const { store } = seedResult!;
  const loaded = await store.loadLog(AID, migrated!);
  const meta = metaFor(migrated!);
  const filesBefore = readdirSync(agentChatsDir(AID)).length;
  const out = await dropDeliveredReceiptRows(store, meta, loaded.msgs, loaded.recs,
    () => { throw new Error("a clean log must log nothing"); });
  // the SAME array back (no copy, no rewrite), no new file, meta untouched
  expect(out).toBe(loaded.msgs);
  expect(meta.chat).toBe(migrated!);
  expect(readdirSync(agentChatsDir(AID)).length).toBe(filesBefore);
});

test("NON-VACUITY: the migration is what removes the rows; without it they replay as user rows", async () => {
  const { store, chatId } = seedResult!;
  const raw = await store.loadLog(AID, chatId);
  const fakes = raw.msgs.filter(isDeliveredReceiptRow);
  expect(fakes.length).toBe(2);
  for (const f of fakes) expect(f.role).toBe("user"); // the spoofing shape, still on disk
});
