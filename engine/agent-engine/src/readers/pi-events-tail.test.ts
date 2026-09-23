/* The pi transcript activity tail (readers/pi.ts piEventsSince /
 * piRecordEvents): the file-tail that gives a pi pane session rows HOWEVER it
 * was started, closing the gap where only a cyc-spawned pi (extension socket)
 * ever streamed rows. It proves:
 *   - one pi jsonl record maps to its rows: user text -> prompt, assistant
 *     toolCalls -> one tool row each (uuid = toolCallId, the id the socket
 *     frame shares) then the reply text (uuid = record id), toolResult ->
 *     nothing, compaction -> compact;
 *   - the drain consumes whole lines only, advances the byte cursor, and a
 *     torn trailing line waits for the next beat;
 *   - `consumed` carries the RAW user text (uncapped), the exact string the
 *     queued-clear matches on;
 *   - a corrupt line is skipped, never fatal.
 *
 *   bun test agent-engine/src/readers/pi-events-tail.test.ts
 */

import { test, expect } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../test-utils/tmp.ts";
import { piEventsSince, piRecordEvents } from "./pi.ts";

const TS = "2026-09-23T00:00:00.000Z";
const MS = Date.parse(TS);

const line = (o: unknown) => JSON.stringify(o) + "\n";

const userRec = (id: string, text: string) => ({
  type: "message", id, parentId: null, timestamp: TS,
  message: { role: "user", content: [{ type: "text", text }], timestamp: MS },
});
const assistantRec = (id: string, content: unknown[]) => ({
  type: "message", id, parentId: null, timestamp: TS,
  message: { role: "assistant", content, stopReason: "stop", timestamp: MS },
});
const toolResultRec = (id: string) => ({
  type: "message", id, parentId: null, timestamp: TS,
  message: { role: "toolResult", toolCallId: "call-1", toolName: "bash",
    content: [{ type: "text", text: "ok" }], isError: false, timestamp: MS },
});

test("a record maps to its rows: prompt / tool+reply / nothing / compact", () => {
  expect(piRecordEvents(userRec("u1", "hi there"), 10)).toEqual([
    { uuid: "u1", ts: MS, kind: "prompt", text: "hi there", off: 10 },
  ]);

  const mixed = assistantRec("a1", [
    { type: "thinking", thinking: "..." },
    { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls -la" } },
    { type: "toolCall", id: "call-2", name: "read", arguments: { path: "/tmp/x" } },
    { type: "text", text: "Done." },
  ]);
  expect(piRecordEvents(mixed, 20)).toEqual([
    { uuid: "call-1", ts: MS, kind: "tool", tool: "bash", text: "ls -la", off: 20 },
    { uuid: "call-2", ts: MS, kind: "tool", tool: "read", text: "/tmp/x", off: 20 },
    { uuid: "a1", ts: MS, kind: "reply", text: "Done.", off: 20 },
  ]);

  // a pure tool-call turn has no reply row
  const pure = assistantRec("a2", [
    { type: "toolCall", id: "call-3", name: "bash", arguments: { command: "pwd" } },
  ]);
  expect(piRecordEvents(pure, 0).map((e) => e.kind)).toEqual(["tool"]);

  expect(piRecordEvents(toolResultRec("r1"), 0)).toEqual([]);
  expect(piRecordEvents({ type: "session", id: "s", timestamp: TS }, 0)).toEqual([]);
  expect(piRecordEvents({ type: "compaction", id: "c1", timestamp: TS, summary: "..." }, 5))
    .toEqual([{ uuid: "c1", ts: MS, kind: "compact", text: "Context compacted", off: 5 }]);
});

test("the drain: backfill, cursor advance, torn trailing line, consumed", async () => {
  const dir = await tmpDir("pi-tail");
  const path = join(dir, "s.jsonl");
  const sent = "TEXT: what is the plan?  "; // raw, trailing spaces and all
  writeFileSync(path,
    line({ type: "session", version: 3, id: "01aa", timestamp: TS, cwd: "/x" })
    + line(userRec("u1", sent))
    + line(assistantRec("a1", [{ type: "text", text: "The plan." }])));

  const first = await piEventsSince(path, 0);
  expect(first).not.toBeNull();
  // the TEXT:-prefixed record is the app's own message: no prompt row (the
  // chat already shows it as a bubble), but consumed still carries its RAW
  // text for the queued-clear
  expect(first!.events.map((e) => [e.kind, e.uuid])).toEqual([["reply", "a1"]]);
  expect(first!.consumed).toEqual([sent]);
  expect(first!.cursor).toBe(Bun.file(path).size);

  // quiet beat: nothing new, cursor holds
  const quiet = await piEventsSince(path, first!.cursor);
  expect(quiet).toEqual({ events: [], cursor: first!.cursor, consumed: [] });

  // a torn line (no newline yet) is not consumed...
  const torn = line(assistantRec("a2", [{ type: "text", text: "More." }]));
  appendFileSync(path, torn.slice(0, 25));
  const mid = await piEventsSince(path, first!.cursor);
  expect(mid).toEqual({ events: [], cursor: first!.cursor, consumed: [] });

  // ...and lands whole once the write completes
  appendFileSync(path, torn.slice(25));
  const done = await piEventsSince(path, first!.cursor);
  expect(done!.events.map((e) => [e.kind, e.uuid])).toEqual([["reply", "a2"]]);
  expect(done!.cursor).toBe(Bun.file(path).size);
});

test("a corrupt line is skipped; the missing file answers null", async () => {
  const dir = await tmpDir("pi-tail-bad");
  const path = join(dir, "s.jsonl");
  writeFileSync(path, "{not json\n" + line(userRec("u1", "hi")));
  const got = await piEventsSince(path, 0);
  expect(got!.events.map((e) => e.uuid)).toEqual(["u1"]);
  expect(await piEventsSince(join(dir, "absent.jsonl"), 0)).toBeNull();
});

test("pi's tail starts at the end of the file when nothing was read before", async () => {
  // a resumed session binding for the first time must not replay its history
  const { piReader } = await import("./pi.ts");
  const src = piReader.sessionEvents;
  expect(src?.mode).toBe("poll");
  expect(src && src.mode === "poll" && src.startAtEnd).toBe(true);
});

test("a terminal-typed or cron prompt (no app prefix) still gets its row", () => {
  const rec = userRec("u9", "CRON:morning-plan fire");
  expect(piRecordEvents(rec, 0).map((e) => e.kind)).toEqual(["prompt"]);
  const app = userRec("u10", "VOICE: hello there");
  expect(piRecordEvents(app, 0)).toEqual([]);
});
