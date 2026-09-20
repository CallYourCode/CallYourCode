// What the pinned agents bar shows: which runs are open and what they are
// doing. The parser reads a claude jsonl, so these tests write jsonl.
//
// The case that brought this file into existence: SendMessage resumes an agent
// that already finished, and the bar showed nothing for the whole resumed run.

import { afterEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAgentRuns, registerRunEnricher, type AgentRun } from "./session-events.ts";
import { tmpDir } from "../test-utils/tmp.ts";

// recent, because the parser sweeps runs left open for four hours as phantoms.
// A fixed date would make these tests pass today and fail tomorrow.
let clock = Date.now() - 30 * 60_000;
const at = () => new Date((clock += 60_000)).toISOString();

/* A jsonl in this file's own throwaway directory, one per call. The parser
 * caches by PATH, so two tests sharing a path would have the second continue
 * the first's parse and read runs that belong to another test. */
async function jsonl(records: any[]): Promise<string> {
  const p = join(await tmpDir("cyc-runs-"), "session.jsonl");
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

const launch = (id: string, desc: string) => ({
  type: "assistant", timestamp: at(),
  message: { content: [{ type: "tool_use", id, name: "Agent", input: { description: desc } }] },
});

const launched = (toolUseId: string, agentId: string) => ({
  type: "user", timestamp: at(),
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId,
    content: `Async agent launched successfully.\nagentId: ${agentId}` }] },
});

const resume = (id: string, agentId: string, summary: string) => ({
  type: "assistant", timestamp: at(),
  message: { content: [{ type: "tool_use", id, name: "SendMessage",
    input: { to: agentId, summary, message: "carry on" } }] },
});

const queued = (toolUseId: string) => ({
  type: "user", timestamp: at(),
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId,
    content: '{"success":true,"message":"Message queued for delivery"}' }] },
});

const done = (agentId: string, tokens = 5000) => ({
  type: "user", timestamp: at(),
  message: { content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<usage><subagent_tokens>${tokens}</subagent_tokens></usage>\n</task-notification>` },
});

test("a resumed agent is a running agent again", async () => {
  const runs = await readAgentRuns(await jsonl([
    launch("toolu_1", "Design the schematics"),
    launched("toolu_1", "a1804b787bc2faff7"),
    done("a1804b787bc2faff7"),
    resume("toolu_2", "a1804b787bc2faff7", "Fix broken labels"),
    queued("toolu_2"),
  ]));

  expect(runs.length).toBe(1);
  expect(runs[0].endedTs).toBeNull();
  // the summary is what it is doing now; the launch description is history
  expect(runs[0].desc).toBe("Fix broken labels");
  // the "queued for delivery" result is not a completion
  expect(runs[0].tokens).toBeNull();
});

test("a resumed agent closes again on its next notification", async () => {
  const runs = await readAgentRuns(await jsonl([
    launch("toolu_1", "Design the schematics"),
    launched("toolu_1", "a1804b787bc2faff7"),
    done("a1804b787bc2faff7", 1000),
    resume("toolu_2", "a1804b787bc2faff7", "Fix broken labels"),
    queued("toolu_2"),
    done("a1804b787bc2faff7", 513_000),
  ]));

  expect(runs.length).toBe(1);
  expect(runs[0].endedTs).not.toBeNull();
  expect(runs[0].tokens).toBe("513k"); // this run's cost, not the first run's
});

test("a resume whose launch is off the top of the window still shows", async () => {
  const runs = await readAgentRuns(await jsonl([
    resume("toolu_9", "aoldagent0000000", "Price the QFN route"),
    queued("toolu_9"),
  ]));

  expect(runs.length).toBe(1);
  expect(runs[0].agentId).toBe("aoldagent0000000");
  expect(runs[0].endedTs).toBeNull();
  expect(runs[0].desc).toBe("Price the QFN route");
});

test("the resumed run's clock restarts, so the phantom guard measures it", async () => {
  const records = [
    launch("toolu_1", "Design the schematics"),
    launched("toolu_1", "a1804b787bc2faff7"),
    done("a1804b787bc2faff7"),
    resume("toolu_2", "a1804b787bc2faff7", "Fix broken labels"),
    // the reopen now waits for the harness to accept the resume, so the answer
    // has to be here. The clock still reads the REQUEST, not this.
    queued("toolu_2"),
  ];
  const runs = await readAgentRuns(await jsonl(records));

  // the run is stamped at the resume, not at the launch four minutes earlier
  expect(runs[0].ts).toBe(Date.parse(records[3].timestamp));
  expect(runs[0].ts).toBeGreaterThan(Date.parse(records[0].timestamp));
});

/* THE BYTE WINDOW, and why these two exist.
 *
 * 2026-08-03: the terminal said one agent was running, the app said none.
 * Measured then -- session jsonl 77.1 MB, the launch record 11.3 MB from the
 * end, the parser's window a fixed 8 MB. The launch was outside it, so the app
 * could not see the agent had ever started. The bug: only the last 8 bytes
 * were ever read.
 *
 * Nothing in this file would have caught it: every test above writes a few
 * hundred bytes, which is inside any window. So the first test below is
 * deliberately fat -- it is the only one whose FILE SIZE is the point. */

/** filler that is transcript-shaped and irrelevant: not a launch, not a
 *  notification, just bulk between the launch and the end of the file. */
const filler = (kb: number) => ({
  type: "assistant", timestamp: at(),
  message: { content: [{ type: "text", text: "x".repeat(kb * 1024) }] },
});

test("a launch far above the old window is still a running agent", async () => {
  // 12 MB of transcript after the launch: comfortably past the 8 MB this used
  // to read, and the shape of a long agent in a busy conversation.
  const runs = await readAgentRuns(await jsonl([
    launch("toolu_far", "Build the git pane"),
    launched("toolu_far", "a07df9228c27e5186"),
    ...Array.from({ length: 12 }, () => filler(1024)),
  ]));
  const mine = runs.find((r) => r.agentId === "a07df9228c27e5186");
  expect(mine).toBeDefined();
  expect(mine!.endedTs).toBeNull();      // running, which is the whole point
  expect(mine!.desc).toBe("Build the git pane");
}, 30_000);

test("a poll after the file grows sees the completion, without re-reading it all", async () => {
  /* The warm path. The first read parses, the second must CONTINUE rather than
   * start again -- if it started again it would still be correct here, so the
   * assertion that matters is the run closing, plus the timing: a re-parse of
   * 12 MB cannot happen in the budget below. */
  const p = join(await tmpDir("cyc-runs-"), "session.jsonl");
  const line = (r: any) => JSON.stringify(r) + "\n";
  writeFileSync(p, [
    launch("toolu_g", "Sweep for stale code"),
    launched("toolu_g", "a33a2f3c38ce915d4"),
    ...Array.from({ length: 12 }, () => filler(1024)),
  ].map(line).join(""));

  const first = await readAgentRuns(p);
  expect(first.find((r) => r.agentId === "a33a2f3c38ce915d4")!.endedTs).toBeNull();

  appendFileSync(p, line(done("a33a2f3c38ce915d4", 342336)));
  const t = Bun.nanoseconds();
  const second = await readAgentRuns(p);
  const ms = (Bun.nanoseconds() - t) / 1e6;

  const mine = second.find((r) => r.agentId === "a33a2f3c38ce915d4")!;
  expect(mine.endedTs).not.toBeNull();
  expect(mine.tokens).toBe("342k");
  // one appended line, not twelve megabytes: a full re-parse measures ~100ms+
  expect(ms).toBeLessThan(25);
}, 30_000);

/* A REFUSED RESUME IS NOT A RUN.
 *
 * His report: "the agents list now shows 'Keep line numbers when wrapped' as
 * running but I know it isn't, it had landed." Traced in his transcript: the
 * agent launched, finished, and was correctly closed. Then a SendMessage to it
 * was refused -- "No transcript found for agent ID" -- and the reopen fired on
 * the REQUEST, so a run that never restarted sat open until the phantom guard.
 */
const refused = (toolUseId: string, agentId: string) => ({
  type: "user", timestamp: at(),
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId,
    content: `{"success":false,"message":"Agent \"${agentId}\" could not be resumed: No transcript found for agent ID: ${agentId}"}` }] },
});

test("a resume the harness refuses leaves a finished agent finished", async () => {
  const runs = await readAgentRuns(await jsonl([
    launch("toolu_1", "Keep line numbers when wrapped; style the scrollbars"),
    launched("toolu_1", "aa0530e8939646b54"),
    done("aa0530e8939646b54"),
    resume("toolu_2", "aa0530e8939646b54", "Have another go"),
    refused("toolu_2", "aa0530e8939646b54"),
  ]));

  expect(runs.length).toBe(1);
  expect(runs[0].endedTs).not.toBeNull(); // still finished, which is the point
});

test("a refused resume for an agent we never saw invents nothing", async () => {
  const runs = await readAgentRuns(await jsonl([
    resume("toolu_9", "agone000000000000", "Pick it back up"),
    refused("toolu_9", "agone000000000000"),
  ]));
  expect(runs.length).toBe(0);
});

/* A CROSS-SESSION SEND, and why it must record NO run.
 *
 * His 09-12 screenshot: "1 agent running / Can CYC run for a second isolated box
 * user? / 2m" while idle. A SendMessage to another Claude session (a peer named
 * by the send-tool, or a `uds:` socket) always succeeds and is never one of THIS
 * session's agents, so the run created for it could never be closed -- the peer
 * replies as a <cross-session-message>, which the tracker ignores -- and it sat
 * running until the 4h phantom guard. The two success shapes below are the ones
 * the send tool writes for a cross-session peer. */
const crossSessionOk = (toolUseId: string, to: string) => ({
  type: "user", timestamp: at(),
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId,
    content: `{"success":true,"message":"Delivered to ${to} (another Claude session on this machine; it is also connected via Remote Control)"}` }] },
});
const udsOk = (toolUseId: string) => ({
  type: "user", timestamp: at(),
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId,
    content: '{"success":true,"message":"Delivered"}' }] },
});
const inProcessResumeOk = (toolUseId: string, agentId: string) => ({
  type: "user", timestamp: at(),
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId,
    content: `{"success":true,"message":"Resuming agent ${agentId}","resumedAgentId":"${agentId}"}` }] },
});

test("a cross-session send (another Claude session) records NO open run", async () => {
  const runs = await readAgentRuns(await jsonl([
    resume("toolu_x", "satyajeetai-c9", "Can CYC run for a second box user?"),
    crossSessionOk("toolu_x", "satyajeetai-c9"),
  ]));
  expect(runs.length, "nothing this transcript can ever close, so it opens nothing").toBe(0);
});

test("a cross-session send to a uds: socket records NO open run", async () => {
  const runs = await readAgentRuns(await jsonl([
    resume("toolu_u", "uds:/run/user/1000/cc-socks/1986005.sock", "ping"),
    udsOk("toolu_u"),
  ]));
  expect(runs.length).toBe(0);
});

test("an in-process resume of an unseen agent still opens its run (unchanged)", async () => {
  const runs = await readAgentRuns(await jsonl([
    resume("toolu_p", "aee81b7000000000", "carry on"),
    inProcessResumeOk("toolu_p", "aee81b7000000000"),
  ]));
  expect(runs.length, "a real in-process agent DOES get task-notifications, so it opens").toBe(1);
  expect(runs[0].agentId).toBe("aee81b7000000000");
  expect(runs[0].endedTs).toBeNull();
});

/* ONE NOTIFICATION, TWO AGENTS.
 *
 * His screen on 2026-08-05: "1 agent running -- The profile pane, 2h 36m",
 * nothing running, the timer climbing. The sweep for background agents a
 * restarted session can no longer account for writes ONE notification listing
 * all of them, and the parser read the ids with a non-global `.match`: the first
 * agent closed, the second stayed open until the four-hour phantom guard.
 *
 * The record below is his, copied out of the transcript that produced that
 * banner -- two <task-id> lines, status stopped, no token usage.
 */
const swept = (...agentIds: string[]) => ({
  type: "user", timestamp: at(),
  message: { content: `<task-notification>\n${agentIds.map((a) => `<task-id>${a}</task-id>`).join("\n")}\n<status>stopped</status>\n<summary>No completion record was found for ${agentIds.length} background agents from the previous session</summary>\n</task-notification>` },
});

test("one notification naming two agents closes BOTH runs", async () => {
  const runs = await readAgentRuns(await jsonl([
    launch("toolu_1", "The profile pane"),
    launched("toolu_1", "a81544f5025291cc9"),
    launch("toolu_2", "Wrap the git pane"),
    launched("toolu_2", "a7a5f93844dd51b33"),
    swept("a81544f5025291cc9", "a7a5f93844dd51b33"),
  ]));

  expect(runs.length).toBe(2);
  const open = runs.filter((r) => r.endedTs === null).map((r) => r.desc);
  expect(open, `${open.join(", ")} was named in the stop notification and is still ` +
    "shown as running. The bar ticks now - run.ts while endedTs is null, so this is " +
    'the "1 agent running, 2h 36m" banner with nothing running.').toEqual([]);
});

test("a completion's tokens go to the run that earned them, not to its neighbour", async () => {
  // the ids are read globally now; the token count still belongs to the block
  // that carried it, and a sweep carries none
  const runs = await readAgentRuns(await jsonl([
    launch("toolu_1", "Design the schematics"),
    launched("toolu_1", "a1804b787bc2faff7"),
    launch("toolu_2", "Price the QFN route"),
    launched("toolu_2", "a7a5f93844dd51b33"),
    done("a1804b787bc2faff7", 217_000),
    swept("a7a5f93844dd51b33"),
  ]));

  const byDesc = new Map(runs.map((r) => [r.desc, r]));
  expect(byDesc.get("Design the schematics")!.tokens).toBe("217k");
  expect(byDesc.get("Price the QFN route")!.tokens).toBeNull();
  expect(byDesc.get("Price the QFN route")!.endedTs).not.toBeNull();
});

/* AND THE BACKSTOP, which is the only thing that closed the run above before
 * this fix, four hours late. It still has to work: a launch whose agent died
 * without ever writing a completion is the case it exists for, and a bar that
 * ticks forever is the symptom either way. */
/* THE 2.1.228 BACKGROUND WORKFLOW, and why the bar showed none of them.
 *
 * A background Workflow does not announce itself the way a background Agent
 * does. An Agent's launch result opens "Async agent launched successfully" and
 * carries "agentId: <id>"; a Workflow's opens "Workflow launched in background.
 * Task ID: <id>". The parser recognised neither phrase, so `launched` read
 * false and the run was stamped ended at its own launch -- a workflow that ran
 * for an hour showed as finished the instant it started. That is his report:
 * a work session running many workflows, the pinned bar empty. The id was
 * missed too, so its <task-notification> (keyed off byAgentId by <task-id>)
 * could not have closed it either.
 *
 * The fixture is a synthetic minimum of the real 2.1.228 shape, retimed to now
 * because the phantom guard drops launches older than four hours. Its
 * completion rides in a `queue-operation` record, a carrier the old
 * plain-user-string test did not cover; the raw-line notification scan closes
 * it regardless of carrier, once byAgentId knows the Task ID. */
async function fromFixture(name: string, count?: number): Promise<string> {
  const raw = readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8")
    .split("\n").filter((l) => l.trim() && !l.includes('"note"'));
  const records = (count === undefined ? raw : raw.slice(0, count))
    .map((l) => l.replace(/"@T(\d+)"/g, (_m, n) => `"${at()}"`));
  const p = join(await tmpDir("cyc-fixt-"), "session.jsonl");
  writeFileSync(p, records.join("\n") + "\n");
  return p;
}

test("2.1.228: a launched background workflow shows RUNNING, not finished-at-launch", async () => {
  // records 0..2: the Workflow launch, its 'launched in background' result, filler
  const runs = await readAgentRuns(await fromFixture("agent-runs-workflow-2.1.228.jsonl", 3));
  expect(runs.length).toBe(1);
  expect(runs[0].endedTs,
    "a launched background workflow with no completion yet is a RUNNING agent; the " +
    "old parser stamped it ended at launch and the bar showed nothing").toBeNull();
  expect(runs[0].agentId).toBe("wq7ftz3k2"); // captured from 'Task ID:', so the notification can find it
});

test("2.1.228: the workflow's completion notification closes it with its tokens", async () => {
  const runs = await readAgentRuns(await fromFixture("agent-runs-workflow-2.1.228.jsonl")); // all records
  expect(runs.length).toBe(1);
  expect(runs[0].endedTs).not.toBeNull();  // closed by the notification, not left open
  expect(runs[0].tokens).toBe("128k");     // the completion's tokens land on the run
});

test("a run left open for longer than the phantom cutoff is not still running", async () => {
  const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const runs = await readAgentRuns(await jsonl([
    { type: "assistant", timestamp: old,
      message: { content: [{ type: "tool_use", id: "toolu_dead", name: "Agent",
        input: { description: "Sweep for stale code" } }] } },
    { type: "user", timestamp: old,
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_dead",
        content: "Async agent launched successfully.\nagentId: adead00000000000" }] } },
  ]));

  expect(runs.length).toBe(1);
  expect(runs[0].endedTs,
    "a five-hour-old run with no completion is still open, so the bar shows it running " +
    "and counts up from a launch time five hours ago").not.toBeNull();
});

/* ---------------------------------------------- the rest of the launch shapes */

test("a transcript that is not there yet has no runs", async () => {
  // the bar polls before claude has written the session file; the honest answer
  // is an empty list, not a throw that takes the whole agents poll down
  expect(await readAgentRuns(join(await tmpDir("cyc-runs-"), "never-written.jsonl"))).toEqual([]);
});

test("a SYNCHRONOUS agent's result IS its completion", async () => {
  /* A foreground Agent/Task returns its answer in the tool_result rather than
   * announcing a background launch. There is no notification coming, so a run
   * left open here would tick for four hours before the phantom guard closed
   * it -- which is the "count is higher than the number running" complaint. */
  const runs = await readAgentRuns(await jsonl([
    launch("toolu_s", "Summarise the diff"),
    { type: "user", timestamp: at(),
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_s",
        content: "Here is the summary of the diff: ..." }] } },
  ]));
  expect(runs.length).toBe(1);
  expect(runs[0].endedTs, "the result is the end of a synchronous run").not.toBeNull();
  expect(runs[0].agentId, "a synchronous run announces no background id").toBeNull();
});

test("a launch with no description falls back to what it can name", async () => {
  /* The bar has to say SOMETHING per row. A Workflow with no description is
   * "workflow"; an Agent falls back to its subagent_type, and then to the tool
   * name, rather than drawing an empty row. */
  const tool = (id: string, name: string, input: Record<string, unknown>) => ({
    type: "assistant", timestamp: at(),
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const runs = await readAgentRuns(await jsonl([
    tool("t1", "Workflow", {}),
    tool("t2", "Agent", { subagent_type: "Explore" }),
    tool("t3", "Task", {}),
    tool("t4", "Agent", { description: "   " }),
  ]));
  const descs = runs.map((r) => r.desc);
  expect(descs).toContain("workflow");
  expect(descs).toContain("Explore");
  expect(descs).toContain("Task");
  expect(descs, "a whitespace description is no description").toContain("Agent");
  expect(descs.every((d) => d.trim().length > 0), "no row may be blank").toBe(true);
});

test("a tool_use that is not an agent launch is not a run", async () => {
  // the bar counts agents. A Bash or a Read in the same turn must not appear,
  // or the count says four when one agent is running.
  const runs = await readAgentRuns(await jsonl([
    { type: "assistant", timestamp: at(),
      message: { content: [
        { type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } },
        { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/tmp/x" } },
      ] } },
  ]));
  expect(runs).toEqual([]);
});

test("small token counts are printed as themselves, not rounded to 0k", async () => {
  const runs = await readAgentRuns(await jsonl([
    launch("toolu_1", "A tiny errand"),
    launched("toolu_1", "atiny00000000000"),
    done("atiny00000000000", 42),
  ]));
  expect(runs[0].tokens).toBe("42");
});

test("a shrunken file is a DIFFERENT session, so its old runs do not carry", async () => {
  /* The parser caches per path and continues a parse when the file only GREW. A
   * shrink means the name was reused (a rotation, a session replaced). Carrying
   * the old maps would show agents from a conversation that no longer exists. */
  const p = join(await tmpDir("cyc-runs-"), "session.jsonl");
  const line = (r: any) => JSON.stringify(r) + "\n";
  writeFileSync(p, [
    launch("toolu_old", "The old conversation's agent"),
    launched("toolu_old", "aoldone000000000"),
    ...Array.from({ length: 40 }, () => filler(1)),
  ].map(line).join(""));
  expect((await readAgentRuns(p)).map((r) => r.desc)).toEqual(["The old conversation's agent"]);

  writeFileSync(p, [
    launch("toolu_new", "The new conversation's agent"),
    launched("toolu_new", "anewone000000000"),
  ].map(line).join(""));
  const after = await readAgentRuns(p);
  expect(after.map((r) => r.desc), "the retired session's agent came back")
    .toEqual(["The new conversation's agent"]);
});

test("a re-poll with no growth answers from the cache, phantom guard still applied", async () => {
  /* Size is the cache key: a poll that finds no new bytes must cost nothing and
   * must still answer the SAME runs. The guard is re-applied on the way out, so
   * a cached open run does not escape ageing out. */
  const p = await jsonl([
    launch("toolu_c", "Cache me"),
    launched("toolu_c", "acache0000000000"),
  ]);
  const first = await readAgentRuns(p);
  const second = await readAgentRuns(p);
  expect(second.map((r) => r.desc)).toEqual(first.map((r) => r.desc));
  expect(second[0].endedTs).toBeNull();
});

/* --------------------------------------------- the enricher seam (gated) ---- */

/* An OUT-OF-TREE personal adapter (piagent) may recognize its own background
 * launches as runs. Core must not import it, so the composition root registers
 * an enricher behind CYC_PIAGENT_ADAPTER. Registered and cleared here, never
 * read from the env: the seam is a function, and the flag belongs to the root.
 * Cleared in afterEach so a leaked enricher cannot change the vanilla tests. */
afterEach(() => registerRunEnricher(null));

test("with no enricher registered, a Bash background launch is nothing (the vanilla default)", async () => {
  const runs = await readAgentRuns(await jsonl([
    { type: "assistant", timestamp: at(),
      message: { content: [{ type: "tool_use", id: "bash1", name: "Bash",
        input: { command: "pi-run 'do the thing' &", run_in_background: true } }] } },
  ]));
  expect(runs, "vanilla core must never turn a Bash call into an agent row").toEqual([]);
});

test("a registered enricher can claim a tool_use, and is asked to enrich the result", async () => {
  const seen: string[] = [];
  let enrichedWith: AgentRun[] | null = null;
  registerRunEnricher({
    fromToolUse(b: any, ts: number): AgentRun | null {
      seen.push(String(b?.name ?? ""));
      if (b?.name !== "Bash") return null;
      return { toolUseId: String(b.id), agentId: null, ts, desc: "pi lane",
        endedTs: null, tokens: null, source: "pi", command: String(b.input?.command ?? "") };
    },
    async enrichRuns(runs: AgentRun[]) {
      enrichedWith = runs;
      for (const r of runs) if (r.source === "pi") r.model = "grok-4.6";
    },
  });
  const runs = await readAgentRuns(await jsonl([
    { type: "assistant", timestamp: at(),
      message: { content: [{ type: "tool_use", id: "bash1", name: "Bash",
        input: { command: "pi-run 'do the thing'" } }] } },
    launch("toolu_1", "An ordinary subagent"),
    launched("toolu_1", "aplain0000000000"),
  ]));
  expect(seen, "every tool_use is offered to the adapter first").toContain("Bash");
  const pi = runs.find((r) => r.source === "pi")!;
  expect(pi.desc).toBe("pi lane");
  expect(pi.command, "the stop route finds the live process by this text").toContain("pi-run");
  expect(pi.model, "enrichRuns ran over the finished list").toBe("grok-4.6");
  expect(enrichedWith!.length).toBe(runs.length);
  expect(enrichedWith![0], "the enricher is handed the run OBJECTS, so its edits are the ones returned")
    .toBe(runs[0]);
  // the ordinary subagent is untouched beside it
  const plain = runs.find((r) => r.desc === "An ordinary subagent")!;
  expect(plain.source).toBeUndefined();
});

test("an enricher that claims nothing leaves the parse exactly as it was", async () => {
  registerRunEnricher({
    fromToolUse: () => null,
    async enrichRuns() { /* silent, best-effort */ },
  });
  const runs = await readAgentRuns(await jsonl([
    launch("toolu_1", "Design the schematics"),
    launched("toolu_1", "a1804b787bc2faff7"),
  ]));
  expect(runs.map((r) => r.desc)).toEqual(["Design the schematics"]);
  expect(runs[0].source).toBeUndefined();
});
