/* The backfill (backfill.ts): regenerate an old conversation's session markers
 * from its stored transcript(s). Real transcript FIXTURES on disk (never a
 * host chatlog), read through the same forward reader production uses; the
 * chatlog is wired to a fake that only collects what it persisted, so a test
 * can prove the records without an engine.
 *
 *   HOME=<fake> bun test agent-engine/src/chat/backfill.test.ts
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initChatlog, resetForTest as resetChatlog, type ChatSession } from "./chatlog.ts";
import type { ChatMsg } from "./chatmsg.ts";
import type { SessionRec } from "./sessionrec.ts";
import { streamLinesForward } from "../sessions/session-events.ts";
import {
  backfillConversation, recInputFromLine, resolveBackfillSources, runBackfillSweep,
  type BackfillSource, type MetaLike, type SweepCandidate,
} from "./backfill.ts";

// ---- transcript fixtures (a subset of claude-code's jsonl, enough to derive
// ---- every overlay kind) ---------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString();
let uid = 0;
const nextUuid = () => `uuid-${String(++uid).padStart(4, "0")}`;

const promptLine = (ms: number, text: string, uuid = nextUuid()) =>
  JSON.stringify({ type: "user", uuid, timestamp: iso(ms), promptId: `p-${uuid}`, message: { content: text } });
const replyLine = (ms: number, text: string, uuid = nextUuid()) =>
  JSON.stringify({ type: "assistant", uuid, timestamp: iso(ms), message: { content: [{ type: "text", text }] } });
const toolLine = (ms: number, name: string, input: unknown, uuid = nextUuid()) =>
  JSON.stringify({ type: "assistant", uuid, timestamp: iso(ms), message: { content: [{ type: "tool_use", name, input }] } });
const compactLine = (ms: number, pre: number, post: number, uuid = nextUuid()) =>
  JSON.stringify({ type: "system", subtype: "compact_boundary", uuid, timestamp: iso(ms), compactMetadata: { preTokens: pre, postTokens: post } });
// lines the overlay drops: the app's own utterance, and a thinking block
const appPromptLine = (ms: number, text: string) =>
  JSON.stringify({ type: "user", uuid: nextUuid(), timestamp: iso(ms), promptId: "app", message: { content: `VOICE: ${text}` } });
const thinkingLine = (ms: number) =>
  JSON.stringify({ type: "assistant", uuid: nextUuid(), timestamp: iso(ms), message: { content: [{ type: "thinking", text: "hmm" }] } });

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cyc-backfill-")); uid = 0; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Write one transcript file and return its path. */
function transcript(name: string, lines: string[]): string {
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

// ---- a real forward reader over the fixtures + a chatlog that only collects
// ---- what it was asked to persist ------------------------------------------

async function streamLines(path: string, onLine: (line: string) => void): Promise<void> {
  const f = Bun.file(path);
  if (!(await f.exists())) return;
  await streamLinesForward(f, 0, f.size, (line) => onLine(line));
}

let persisted: { aid: string; chatId: string; rec: SessionRec }[];
let sent: SessionRec[];
function wireChatlog() {
  persisted = [];
  sent = [];
  initChatlog({
    chatOf: () => undefined,
    restoredChats: () => new Map(),
    persistPatch: () => {},
    broadcast: () => {},
    chatRefFor: (id) => ({ aid: id, chatId: "c1" }),
    indexMsgBlobs: () => {},
    appendMsg: () => {},
    appendRec: (aid, chatId, rec) => { persisted.push({ aid, chatId, rec }); },
    sendSessionRec: (_id, rec) => { sent.push(rec); },
  });
}
beforeEach(wireChatlog);
afterEach(() => resetChatlog());

const session = (chat: ChatMsg[] = []): ChatSession => ({ id: "ag-old", chat, log: [] });

// ---------------------------------------------------------------------------

describe("an old transcript with no records", () => {
  test("every overlay kind is derived, in transcript order, and persisted", async () => {
    const t0 = 1_700_000_000_000;
    const path = transcript("s1", [
      promptLine(t0 + 1, "please refactor the parser"),
      replyLine(t0 + 2, "on it"),
      toolLine(t0 + 3, "Bash", { command: "ls -la", description: "list the tree" }),
      compactLine(t0 + 4, 120_000, 30_000),
      replyLine(t0 + 5, "done"),
      appPromptLine(t0 + 6, "say hi"), // the app's own send: suppressed
      thinkingLine(t0 + 7), // thinking: dropped
    ]);
    const s = session();
    const sources: BackfillSource[] = [{ harness: "claude", sid: "s1", path }];

    const { added, skipped } = await backfillConversation(s, sources, { streamLines });

    expect(skipped).toBeUndefined();
    expect(added).toBe(5); // prompt, reply, tool, compact, reply -- not the app send, not thinking
    expect(s.log!.map((r) => r.kind)).toEqual(["prompt", "reply", "tool", "compact", "reply"]);
    expect(s.log![0].text).toBe("> please refactor the parser");
    expect(s.log![2].text).toBe("Bash: list the tree");
    // every record persisted to disk, and pushed live, once each
    expect(persisted.length).toBe(5);
    expect(sent.length).toBe(5);
    // display order is the transcript's ts (old), storage order (seq) is fresh
    expect(s.log!.map((r) => r.ts)).toEqual([t0 + 1, t0 + 2, t0 + 3, t0 + 4, t0 + 5]);
    expect(s.log!.every((r, i) => i === 0 || r.seq > s.log![i - 1].seq)).toBe(true);
    // stable ids, and the src identity key production would have used
    expect(s.log!.every((r) => r.id.startsWith("se-"))).toBe(true);
    expect(s.log![0].src).toEqual({ h: "claude", sid: "s1", rid: "uuid-0001", off: 0 });
  });

  test("a backfilled record's seq continues PAST the last message, never renumbering it", async () => {
    const chat: ChatMsg[] = [
      { id: "ag-old", role: "user", text: "hi", ts: 1, seq: 0 },
      { id: "ag-old", role: "claude", text: "hello", ts: 2, seq: 1 },
    ];
    const path = transcript("s1", [promptLine(10, "hi"), replyLine(11, "hello")]);
    const s = session(chat);

    await backfillConversation(s, [{ harness: "claude", sid: "s1", path }], { streamLines });

    // the two messages keep their seqs; the records take the seqs after them
    expect(chat.map((m) => m.seq)).toEqual([0, 1]);
    expect(s.log!.map((r) => r.seq)).toEqual([2, 3]);
  });
});

describe("idempotency", () => {
  test("run twice: the second run is skipped whole and adds nothing", async () => {
    const path = transcript("s1", [promptLine(10, "first message here"), replyLine(11, "a reply")]);
    const s = session();
    const src: BackfillSource[] = [{ harness: "claude", sid: "s1", path }];

    const one = await backfillConversation(s, src, { streamLines });
    const persistedAfterOne = persisted.length;
    const two = await backfillConversation(s, src, { streamLines });

    expect(one.added).toBe(2);
    expect(two).toEqual({ added: 0, skipped: "has-records" });
    expect(s.log!.length).toBe(2); // not doubled
    expect(persisted.length).toBe(persistedAfterOne); // nothing more written to disk
  });

  test("overlapping sources in one run: a repeat src key is deduped, never twinned", async () => {
    const path = transcript("s1", [promptLine(10, "only message"), replyLine(11, "only reply")]);
    const s = session();
    // the SAME transcript listed twice: the second pass' lines share src keys
    const src: BackfillSource[] = [
      { harness: "claude", sid: "s1", path },
      { harness: "claude", sid: "s1", path },
    ];

    const { added } = await backfillConversation(s, src, { streamLines });

    expect(added).toBe(2); // two records, not four
    expect(s.log!.length).toBe(2);
  });
});

describe("recInputFromLine", () => {
  test("a dropped line yields null; a reply yields a reply record with the right src", () => {
    expect(recInputFromLine("claude", "s1", thinkingLine(1), 0)).toBeNull();
    const rec = recInputFromLine("claude", "s1", replyLine(5, "hi there", "u9"), 42);
    expect(rec).toMatchObject({ kind: "reply", text: "hi there", src: { h: "claude", sid: "s1", rid: "u9" } });
  });
});

describe("resolveBackfillSources", () => {
  const pathFor = (cwd: string, sid: string) => `${cwd}/proj/${sid}.jsonl`;

  test("predecessors first, then the current session; ids deduped; missing skipped", () => {
    const have = new Set(["/w/proj/old.jsonl", "/w/proj/mid.jsonl", "/w/proj/cur.jsonl"]);
    const meta: MetaLike = {
      agentId: "ag", harness: "claude", cwd: "/w",
      pastSessions: ["old", "mid"], lineage: ["mid", "gone"], sessionId: "cur",
    };
    const out = resolveBackfillSources(meta, { pathFor, exists: (p) => have.has(p) });
    expect(out.map((s) => s.sid)).toEqual(["old", "mid", "cur"]); // gone: path missing
    expect(out.every((s) => s.harness === "claude")).toBe(true);
  });

  test("no cwd (an old meta): falls back to a session-id scan", () => {
    const meta: MetaLike = { agentId: "ag", sessionId: "abc", cwd: undefined };
    const found = new Map([["abc", "/home/x/.claude/projects/-p/abc.jsonl"]]);
    const out = resolveBackfillSources(meta, {
      pathFor: () => null,
      findBySid: (sid) => found.get(sid) ?? null,
      exists: (p) => [...found.values()].includes(p),
    });
    expect(out).toEqual([{ harness: "claude", sid: "abc", path: "/home/x/.claude/projects/-p/abc.jsonl" }]);
  });
});

describe("runBackfillSweep", () => {
  test("backfills only conversations with a resolvable transcript, remembers each log, skips the rest", async () => {
    const withT = transcript("has", [promptLine(10, "a real question here"), replyLine(11, "an answer")]);
    const cands: SweepCandidate[] = [
      { id: "ag-has", meta: { agentId: "ag-has", sessionId: "has" }, chat: [] },
      { id: "ag-none", meta: { agentId: "ag-none", sessionId: "missing" }, chat: [] },
    ];
    const remembered: Record<string, number> = {};
    const resolve = (meta: MetaLike): BackfillSource[] =>
      meta.sessionId === "has" ? [{ harness: "claude", sid: "has", path: withT }] : [];

    const res = await runBackfillSweep({
      candidates: () => cands,
      resolve,
      streamLines,
      rememberLog: (id, log) => { remembered[id] = log.length; },
    });

    expect(res).toEqual({ agents: 1, added: 2 });
    expect(remembered).toEqual({ "ag-has": 2 });
  });
});
