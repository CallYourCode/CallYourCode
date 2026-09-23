/* The codex activity extraction (readers/codex.ts codexTailEvent): rollout
 * jsonl lines -> the tool/compact rows the app renders. Every fixture line
 * below is the REAL record shape measured on this machine's rollouts
 * (codex-cli 0.148.0, captured 2026-09-05), anonymized: item_completed's typed
 * items, turn_aborted, and the response_item / conversation records that must
 * map to NOTHING (the raw custom_tool_call describes the same run a
 * CommandExecution item does, so mapping both would double every command).
 *
 *   bun test agent-engine/src/readers/codex-events.test.ts
 */

import { describe, expect, test } from "bun:test";
import { codexReader, codexTailEvent } from "./codex.ts";
import { claudeReader } from "./claude.ts";
import { parseSessionRec } from "../chat/sessionrec.ts";
import { tailEventOf, SessionTailParser } from "../sessions/session-events.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { join } from "node:path";
import { writeFileSync, appendFileSync } from "node:fs";

const TS = "2026-09-05T10:00:00.000Z";
const TS_MS = Date.parse(TS);

const line = (payload: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ timestamp: TS, ordinal: 7, type: "event_msg", payload, ...extra });

const itemLine = (item: unknown): string =>
  line({ type: "item_completed", thread_id: "01aa0000-0000-7000-8000-000000000001",
    turn_id: "01aa0000-0000-7000-8000-000000000002", item,
    started_at_ms: TS_MS, completed_at_ms: TS_MS });

describe("item_completed items", () => {
  test("CommandExecution: the argv's command, not the shell wrapper, capped", () => {
    const ev = codexTailEvent(itemLine({ type: "CommandExecution", id: "exec-aaaa1111",
      process_id: "4242", command: ["/usr/bin/zsh", "-c", "pwd && git status --short"],
      cwd: "file:///tmp/proj" }), 96);
    expect(ev).toEqual({ uuid: "exec-aaaa1111", ts: TS_MS, kind: "tool", tool: "exec",
      text: "exec: pwd && git status --short", off: 96 });
  });

  test("a long command is capped at 80 chars with an ellipsis", () => {
    const cmd = "echo " + "x".repeat(200);
    const ev = codexTailEvent(itemLine({ type: "CommandExecution", id: "exec-cap", command: ["bash", "-c", cmd] }), 0);
    expect(ev!.text.length).toBe("exec: ".length + 81); // 80 + the ellipsis
    expect(ev!.text.endsWith("…")).toBe(true);
  });

  test("FileChange: the changed files by basename", () => {
    const ev = codexTailEvent(itemLine({ type: "FileChange", id: "exec-bbbb2222",
      changes: { "/tmp/proj/src/a.ts": { type: "update", unified_diff: "@@ -1 +1 @@" },
        "/tmp/proj/b.md": { type: "add", unified_diff: "@@ -0 +1 @@" } } }), 0);
    expect(ev).toMatchObject({ uuid: "exec-bbbb2222", ts: TS_MS, kind: "tool", tool: "edit",
      text: "edit: a.ts, b.md" });
  });

  test("McpToolCall: server.tool", () => {
    const ev = codexTailEvent(itemLine({ type: "McpToolCall", id: "exec-cccc3333",
      server: "codex", tool: "list_mcp_resources", arguments: {}, status: "completed" }), 0);
    expect(ev).toMatchObject({ uuid: "exec-cccc3333", kind: "tool",
      tool: "codex.list_mcp_resources", text: "codex.list_mcp_resources" });
  });

  test("Extension: the kind and its query", () => {
    const ev = codexTailEvent(itemLine({ type: "Extension", kind: "web.search", id: "exec-dddd4444",
      query: "bun sqlite readonly", action: { type: "search", query: "bun sqlite readonly" } }), 0);
    expect(ev).toMatchObject({ uuid: "exec-dddd4444", kind: "tool", tool: "web.search",
      text: "web.search: bun sqlite readonly" });
  });

  test("CollabAgentToolCall: the collab tool name", () => {
    const ev = codexTailEvent(itemLine({ type: "CollabAgentToolCall", id: "call_eeee5555",
      tool: "wait", status: "completed" }), 0);
    expect(ev).toMatchObject({ uuid: "call_eeee5555", kind: "tool", tool: "wait", text: "wait" });
  });

  test("ContextCompaction: a compact row", () => {
    const ev = codexTailEvent(itemLine({ type: "ContextCompaction", id: "01aa0000-comp" }), 0);
    expect(ev).toMatchObject({ uuid: "01aa0000-comp", kind: "compact", text: "Conversation compacted" });
  });

  test("conversation and noise items map to nothing", () => {
    for (const item of [
      { type: "Reasoning", id: "rs_1", summary_text: [], raw_content: [] },
      { type: "AgentMessage", id: "msg_1", content: [{ type: "Text", text: "hello" }], phase: "commentary" },
      { type: "UserMessage", id: "01aa-um", content: [{ type: "text", text: "hi there" }] },
      { type: "SubAgentActivity", id: "call_sa", kind: "interacted", agent_path: "/root" },
      { type: "SomethingNew", id: "x1" },
      { type: "CommandExecution" }, // no stable id: no dedupe key, no row
    ]) {
      expect(codexTailEvent(itemLine(item), 0)).toBeNull();
    }
  });
});

describe("turn_aborted", () => {
  test("an interrupt is an interrupt row keyed by its turn id (the app folds it onto the preceding tool run)", () => {
    const ev = codexTailEvent(line({ type: "turn_aborted", turn_id: "01aa0000-turn",
      reason: "interrupted", duration_ms: 14995 }), 32);
    expect(ev).toEqual({ uuid: "aborted:01aa0000-turn", ts: TS_MS, kind: "interrupt",
      text: "Turn interrupted", off: 32 });
  });

  test("another reason names itself; no turn id means no row", () => {
    expect(codexTailEvent(line({ type: "turn_aborted", turn_id: "t2", reason: "replaced" }), 0))
      .toMatchObject({ kind: "interrupt", text: "Turn aborted (replaced)" });
    expect(codexTailEvent(line({ type: "turn_aborted", reason: "interrupted" }), 0)).toBeNull();
  });

  test("an interrupt rec SURVIVES the log replay (SESSION_REC_KINDS widened: parseSessionRec drops unknown kinds)", () => {
    const raw = { t: "s", seq: 5, ts: TS_MS, id: "se-abcdefghijklmnop", kind: "interrupt",
      text: "Turn interrupted", src: { h: "codex", sid: "01aa", rid: "aborted:t1", off: 0 } };
    const rec = parseSessionRec(raw as unknown as Record<string, unknown>);
    expect(rec).not.toBeNull();
    expect(rec!.kind).toBe("interrupt");
  });
});

describe("everything else maps to nothing", () => {
  test("response_item records (the double-report of the same runs), meta records, junk", () => {
    const rows = [
      { timestamp: TS, ordinal: 1, type: "response_item", payload: { type: "custom_tool_call",
        id: "ctc_1", call_id: "call_1", name: "exec", input: "await tools.exec_command({cmd:'ls'})" } },
      { timestamp: TS, ordinal: 2, type: "response_item", payload: { type: "function_call",
        id: "fc_1", name: "send_message", arguments: "{}" } },
      { timestamp: TS, ordinal: 3, type: "response_item", payload: { type: "message",
        role: "assistant", id: "msg_2", content: [{ type: "output_text", text: "done" }] } },
      { timestamp: TS, ordinal: 0, type: "session_meta", payload: { session_id: "01aa", cwd: "/tmp" } },
      { timestamp: TS, ordinal: 4, type: "turn_context", payload: { model: "gpt-5.2-codex" } },
      { timestamp: TS, ordinal: 5, type: "compacted", payload: { message: "", replacement_history: [] } },
      { timestamp: TS, ordinal: 6, type: "event_msg", payload: { type: "token_count", info: {} } },
      { timestamp: TS, ordinal: 8, type: "event_msg", payload: { type: "task_started" } },
    ];
    for (const r of rows) expect(codexTailEvent(JSON.stringify(r), 0)).toBeNull();
    expect(codexTailEvent("", 0)).toBeNull();
    expect(codexTailEvent('{"type":"event_msg","payload":{"type":"item_comp', 0)).toBeNull(); // torn line
    expect(codexTailEvent(itemLine({ type: "CommandExecution", id: "x" }).replace(TS, "not-a-date"), 0)).toBeNull();
  });
});

describe("the declared slot", () => {
  test("codex declares the lines source with this extraction; claude's slot IS the tailEventOf the parser always used (byte-identical move)", () => {
    expect(codexReader.sessionEvents!.mode).toBe("lines");
    expect((codexReader.sessionEvents as { eventOf: unknown }).eventOf).toBe(codexTailEvent);
    expect(claudeReader.sessionEvents!.mode).toBe("lines");
    expect((claudeReader.sessionEvents as { eventOf: unknown }).eventOf).toBe(tailEventOf);
  });

  test("re-parsing the same lines yields the same rows and the same rids (idempotent re-read)", () => {
    const lines = [
      itemLine({ type: "CommandExecution", id: "exec-r1", command: ["bash", "-c", "ls"] }),
      itemLine({ type: "ContextCompaction", id: "comp-r1" }),
    ];
    const first = lines.map((l) => codexTailEvent(l, 0));
    const second = lines.map((l) => codexTailEvent(l, 0));
    expect(second).toEqual(first);
    expect(first.map((e) => e!.uuid)).toEqual(["exec-r1", "comp-r1"]);
  });
});

describe("through the SessionTailParser (the tail the adapter runs)", () => {
  test("a codex rollout drains codex rows incrementally, offsets advancing", async () => {
    const dir = await tmpDir("codex-tail");
    const path = join(dir, "rollout-2026-09-05T10-00-00-01aa.jsonl");
    const l1 = itemLine({ type: "CommandExecution", id: "exec-t1", command: ["bash", "-c", "pwd"] });
    writeFileSync(path, l1 + "\n");
    const parser = new SessionTailParser(path, codexTailEvent);
    const first = await parser.drain();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ uuid: "exec-t1", kind: "tool", tool: "exec", off: 0 });
    // append: only the new line drains, with the right byte offset
    const l2 = itemLine({ type: "ContextCompaction", id: "comp-t1" });
    appendFileSync(path, l2 + "\n");
    const second = await parser.drain();
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ uuid: "comp-t1", kind: "compact", off: l1.length + 1 });
    expect(await parser.drain()).toEqual([]); // level: nothing re-drains
  });
});

describe("codexConsumedOf: the queued-clear raw text off a rollout user record", () => {
  const userLine = (text: string): string =>
    JSON.stringify({ timestamp: TS, type: "response_item", payload: {
      type: "message", id: "msg_x", role: "user",
      content: [{ type: "input_text", text }] } });

  test("a delivered user record answers its raw text; everything else null", async () => {
    const { codexConsumedOf } = await import("./codex.ts");
    const sent = "TEXT: try again  "; // raw, whitespace kept
    expect(codexConsumedOf(userLine(sent))).toBe(sent);
    // an assistant record, an event_msg, and junk all answer null
    expect(codexConsumedOf(JSON.stringify({ timestamp: TS, type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] } }))).toBeNull();
    expect(codexConsumedOf(itemLine({ id: "item_1", item_type: "AgentMessage", text: "x" }))).toBeNull();
    expect(codexConsumedOf("{not json")).toBeNull();
  });

  test("the tail parser collects it into `consumed` beside the claude side parse", async () => {
    const { codexConsumedOf } = await import("./codex.ts");
    const dir = await tmpDir("codex-consumed");
    const path = join(dir, "rollout.jsonl");
    writeFileSync(path, userLine("TEXT: what now?") + "\n");
    const parser = new SessionTailParser(path, codexTailEvent, codexConsumedOf);
    await parser.drain();
    expect(parser.consumed).toEqual(["TEXT: what now?"]);
  });
});
