/* The opencode activity poll (readers/opencode.ts opencodeEventsSince): the
 * session's part rows newer than a cursor -> the tool rows the app renders.
 * The part shapes are the REAL ones captured 2026-09-05 from a live opencode
 * 1.18.19 run against a throwaway XDG_DATA_HOME (a completed bash tool part,
 * its error twin, and the text/reasoning/step parts that must map to nothing),
 * anonymized; the db is a real bun:sqlite file with opencode's part table
 * columns, so the sqlite branch is the one under test, not a stub of it.
 *
 *   bun test agent-engine/src/readers/opencode-events.test.ts
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { opencodeReader, opencodeEventsSince } from "./opencode.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const SID = "ses_aaaa0000bbbbCCCCddddEEEE01";
const OTHER = "ses_ffff9999otherSessionId002";

/* The captured 1.18.19 shapes, anonymized. */
const completedTool = {
  type: "tool", tool: "bash", callID: "bash_1",
  state: { status: "completed", input: { command: "cat note.txt", timeout: 10000 },
    output: "hello world\n", metadata: { output: "hello world\n", exit: 0, truncated: false },
    title: "cat note.txt", time: { start: 1788602919561, end: 1788602919564 } },
};
const erroredTool = {
  type: "tool", tool: "bash", callID: "bash_0",
  state: { status: "error", input: { command: "cat note.txt" },
    error: "BLOCKED: this command has no timeout", time: { start: 1788602917446, end: 1788602917449 } },
};
const runningTool = {
  type: "tool", tool: "bash", callID: "bash_2",
  state: { status: "running", input: { command: "sleep 5" } },
};

type Row = [id: string, sid: string, t: number, tu: number, data: unknown];

function mkDb(path: string, rows: Row[]): void {
  const db = new Database(path);
  db.run(`CREATE TABLE part (
    id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`);
  const ins = db.prepare("insert into part values (?, 'msg_1', ?, ?, ?, ?)");
  for (const [id, sid, t, tu, data] of rows) ins.run(id, sid, t, tu, JSON.stringify(data));
  db.close();
}

const baseRows: Row[] = [
  ["prt_01text", SID, 1000, 1000, { type: "text", text: "run cat for me" }],
  ["prt_02start", SID, 1010, 1010, { type: "step-start" }],
  ["prt_03reason", SID, 1020, 1020, { type: "reasoning", text: "thinking…" }],
  ["prt_04err", SID, 1030, 1031, erroredTool],
  ["prt_05finish", SID, 1040, 1040, { type: "step-finish", reason: "tool-calls", tokens: {} }],
  ["prt_06ok", SID, 1050, 1052, completedTool],
  ["prt_07other", OTHER, 1060, 1060, completedTool], // another session's row: filtered out
];

describe("the sqlite poll", () => {
  test("cursor 0 answers the session's terminal tool rows, in order, cursor at the newest row", async () => {
    const dir = await tmpDir("oc-events");
    const db = join(dir, "opencode.db");
    mkDb(db, baseRows);
    const got = await opencodeEventsSince(`${db}#${SID}`, 0);
    expect(got).not.toBeNull();
    expect(got!.events).toEqual([
      { uuid: "prt_04err", ts: 1030, kind: "tool", tool: "bash", text: "bash: cat note.txt (failed)" },
      { uuid: "prt_06ok", ts: 1050, kind: "tool", tool: "bash", text: "bash: cat note.txt" },
    ]);
    expect(got!.cursor).toBe(1052); // max time_updated over EVERY row seen, mapped or not
  });

  test("re-polling from the answered cursor is empty and idempotent", async () => {
    const dir = await tmpDir("oc-events");
    const db = join(dir, "opencode.db");
    mkDb(db, baseRows);
    const first = await opencodeEventsSince(`${db}#${SID}`, 0);
    const again = await opencodeEventsSince(`${db}#${SID}`, first!.cursor);
    expect(again).toEqual({ events: [], cursor: first!.cursor, consumed: [] });
    // and the same question twice gives the same answer (pure read)
    expect(await opencodeEventsSince(`${db}#${SID}`, 0)).toEqual(first);
  });

  test("a running tool part is skipped but advances the cursor; its completion is re-seen when time_updated bumps", async () => {
    const dir = await tmpDir("oc-events");
    const db = join(dir, "opencode.db");
    mkDb(db, [["prt_run", SID, 2000, 2001, runningTool]]);
    const first = await opencodeEventsSince(`${db}#${SID}`, 0);
    expect(first).toEqual({ events: [], cursor: 2001, consumed: [] });
    // the harness finishes the call: same row id, bumped time_updated
    const d = new Database(db);
    d.run("update part set time_updated = 2050, data = ? where id = 'prt_run'",
      [JSON.stringify(completedTool)]);
    d.close();
    const second = await opencodeEventsSince(`${db}#${SID}`, first!.cursor);
    expect(second!.events).toEqual([
      { uuid: "prt_run", ts: 2000, kind: "tool", tool: "bash", text: "bash: cat note.txt" },
    ]);
    expect(second!.cursor).toBe(2050);
  });

  test("no session id in the path, or a missing store, answers null (the poll retries)", async () => {
    const dir = await tmpDir("oc-events");
    const db = join(dir, "opencode.db");
    mkDb(db, []);
    expect(await opencodeEventsSince(db, 0)).toBeNull();
    expect(await opencodeEventsSince(`${join(dir, "gone.db")}#${SID}`, 0)).toBeNull();
  });
});

describe("the captured-dump branch (the transcript reads' .json shape)", () => {
  test("a dump's parts answer the same way", async () => {
    const dir = await tmpDir("oc-events");
    const dump = join(dir, "capture.json");
    writeFileSync(dump, JSON.stringify({
      session: { id: SID },
      messages: [],
      parts: baseRows.map(([id, sid, t, tu, data]) =>
        ({ id, message_id: "msg_1", session_id: sid, time_created: t, time_updated: tu, data })),
    }));
    const got = await opencodeEventsSince(`${dump}#${SID}`, 0);
    expect(got!.events.map((e) => e.uuid)).toEqual(["prt_04err", "prt_06ok"]);
    expect(got!.cursor).toBe(1052);
  });
});

describe("the declared slot", () => {
  test("opencode declares the poll source with this read", () => {
    expect(opencodeReader.sessionEvents).toEqual({ mode: "poll", since: opencodeEventsSince });
  });
});

describe("the queued-clear consumed texts off the db", () => {
  test("a text part under a USER message answers its raw text; assistant text and tool parts do not", async () => {
    const dir = await tmpDir("oc-consumed");
    const db = join(dir, "opencode.db");
    const sq = new Database(db);
    sq.run("create table part (id text, message_id text, session_id text, time_created integer, time_updated integer, data text)");
    sq.run("create table message (id text, session_id text, time_created integer, time_updated integer, data text)");
    const sid = "ses_consumedtest000000000001";
    sq.run("insert into message values ('m-user', ?, 1, 1, ?)", [sid, JSON.stringify({ role: "user", time: { created: 1 } })]);
    sq.run("insert into message values ('m-asst', ?, 2, 2, ?)", [sid, JSON.stringify({ role: "assistant" })]);
    const sent = "TEXT: status please  ";
    sq.run("insert into part values ('p1','m-user',?,10,10,?)", [sid, JSON.stringify({ type: "text", text: sent })]);
    sq.run("insert into part values ('p2','m-asst',?,11,11,?)", [sid, JSON.stringify({ type: "text", text: "the answer" })]);
    sq.run("insert into part values ('p3','m-asst',?,12,12,?)", [sid, JSON.stringify({ type: "tool", tool: "bash",
      callID: "b1", state: { status: "completed", input: { command: "ls" }, title: "ls" } })]);
    sq.close();

    const got = await opencodeEventsSince(`${db}#${sid}`, 0);
    expect(got).not.toBeNull();
    expect(got!.consumed, "the user's raw text, exactly as stored").toEqual([sent]);
    expect(got!.events.map((e) => e.kind), "rows are unchanged by the consumed read").toEqual(["tool"]);

    // past the cursor: nothing more to consume
    const again = await opencodeEventsSince(`${db}#${sid}`, got!.cursor);
    expect(again!.consumed).toEqual([]);
  });
});
