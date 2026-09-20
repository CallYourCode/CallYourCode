/* THE HARNESS TURNS COME OUT AS QUIET SYSTEM LINES, NOT RAW XML (#383).
 *
 * A background agent finishing writes a `<task-notification>` block into the
 * transcript as a user turn, promptId and all, the same shape a `/model` switch
 * or a halt takes. The extractor used to hand it back as `kind:"prompt"` -- the
 * one kind the app keeps at full opacity -- so a paragraph of XML landed as a
 * full-attention bubble in his chat (his screenshot). It has to come out as the
 * SAME quiet system line the other harness turns use, which in this module is
 * `kind:"compact"` (the compaction boundary), reworded to one line with no XML.
 */

import { test, expect } from "bun:test";
import { eventFromRecord, classifyInput, turnEdgeFromLine, queueOpFromLine, deliveredTextFromLine,
  SessionTailParser, TurnStatusParser, findTranscriptBySessionId, sessionFilePath } from "./session-events";
import { mungeCwd } from "../../../shared/claude-projects.ts";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { tmpDir } from "../test-utils/tmp.ts";

const at = () => new Date().toISOString();

/* A jsonl path in this file's own throwaway directory. Never ~/.claude: these
 * tests APPEND to the files they read, and a path that ever resolved into his
 * real projects dir would be writing into a live transcript. */
const jsonlPath = async () => join(await tmpDir("cyc-turn-"), "session.jsonl");

/* A completed background agent, exactly the shape agent-runs.test.ts injects:
 * a user record whose whole content is one `<task-notification>` string. The
 * real harness turn carries a promptId too, so both are covered. */
const taskNotification = (body: string, extra: Record<string, unknown> = {}) => ({
  type: "user",
  uuid: crypto.randomUUID(),
  timestamp: at(),
  message: { content: body },
  ...extra,
});

const COMPLETED =
  "<task-notification>\n<task-id>a1804b787bc2faff7</task-id>\n<status>completed</status>\n" +
  "<usage><subagent_tokens>5000</subagent_tokens></usage>\n</task-notification>";

const STOPPED_WITH_SUMMARY =
  "<task-notification>\n<task-id>aoldagent0000000</task-id>\n<status>stopped</status>\n" +
  "<summary>No completion record was found for 1 background agent from the previous session" +
  "</summary>\n</task-notification>";

test("a task-notification comes out as a quiet system line, not a raw-XML prompt", () => {
  const ev = eventFromRecord(taskNotification(COMPLETED));
  expect(ev).not.toBeNull();
  // the quiet system-line kind this module already emits (the compaction
  // boundary), NOT "prompt" (the full-opacity, human-typed kind)
  expect(ev!.kind).toBe("compact");
  // reworded: no XML tags, no "> " prompt prefix
  expect(ev!.text).not.toContain("<task-notification>");
  expect(ev!.text).not.toContain("<task-id>");
  expect(ev!.text.startsWith(">")).toBe(false);
  expect(ev!.text).toBe("A background agent finished");
});

test("it is reclassified even when the harness gives it a promptId", () => {
  // a halt and a /model switch both carry a promptId like something typed; a
  // task-notification does too, and that must not route it back to "prompt"
  const ev = eventFromRecord(taskNotification(COMPLETED, { promptId: "p_123" }));
  expect(ev!.kind).toBe("compact");
  expect(ev!.text).not.toContain("<task-notification>");
});

test("a stopped notification's own summary is what it says", () => {
  const ev = eventFromRecord(taskNotification(STOPPED_WITH_SUMMARY, { promptId: "p_9" }));
  expect(ev!.kind).toBe("compact");
  expect(ev!.text).toBe(
    "No completion record was found for 1 background agent from the previous session"
  );
  expect(ev!.text).not.toContain("<summary>");
});

test("an ordinary terminal prompt is untouched", () => {
  const ev = eventFromRecord({
    type: "user",
    uuid: crypto.randomUUID(),
    timestamp: at(),
    promptId: "p_1",
    message: { content: "fix the makefile" },
  });
  expect(ev!.kind).toBe("prompt");
  expect(ev!.text).toBe("> fix the makefile");
});

/* A message delivered to a BUSY pane never becomes a `user` record: claude
 * queues it and the transcript gets one `attachment` record (queued_command)
 * carrying the prompt. Measured 2026-08-12 on the builder session: idle
 * deliveries write a user prompt record and no attachment, busy deliveries an
 * attachment and no user record, never both. The overlay must render these or
 * a busy session's cron/script inputs are invisible. */
const queuedCommand = (prompt: string) => ({
  type: "attachment",
  uuid: crypto.randomUUID(),
  timestamp: at(),
  attachment: { type: "queued_command", prompt, commandMode: "prompt", origin: { kind: "human" } },
});

test("a queued mid-turn delivery renders as a prompt strip, sourced cron", () => {
  const ev = eventFromRecord(queuedCommand("SCHEDULED (nudge): continue building"));
  expect(ev!.kind).toBe("prompt");
  expect(ev!.text).toBe("> SCHEDULED (nudge): continue building");
  // the engine's own delivery prefix (crons plugin how:"SCHEDULED") is the source
  expect(ev!.source).toBe("cron");
});

test("a queued app message stays out of the overlay (it is already a bubble)", () => {
  expect(eventFromRecord(queuedCommand("TEXT: did it fire?"))).toBeNull();
  expect(eventFromRecord(queuedCommand("VOICE: status please"))).toBeNull();
});

test("a queued task-notification is a quiet line, same as the user-record path", () => {
  const ev = eventFromRecord(queuedCommand(COMPLETED));
  expect(ev!.kind).toBe("compact");
  expect(ev!.text).toBe("A background agent finished");
});

test("other attachment kinds stay dropped", () => {
  const ev = eventFromRecord({
    type: "attachment",
    uuid: crypto.randomUUID(),
    timestamp: at(),
    attachment: { type: "new_file", path: "/tmp/x" },
  });
  expect(ev).toBeNull();
});

/* #398: the same treatment for the harness's other self-talk. A slash command,
 * its stdout, and a terminal `!` bash line all arrive as user turns full of XML,
 * exactly the way the /model switch in his screenshot did. Each must come out a
 * quiet system line, never a full-opacity prompt. */
const userTurn = (body: string, extra: Record<string, unknown> = {}) => ({
  type: "user",
  uuid: crypto.randomUUID(),
  timestamp: at(),
  promptId: "p_cmd",
  message: { content: body },
  ...extra,
});

test("a /model switch stdout is a quiet line, not a raw-XML prompt", () => {
  // his screenshot: this is the exact turn that rendered its tags full-attention
  const ev = eventFromRecord(userTurn(
    "<local-command-stdout>Set model to claude-opus-4-8[1m]</local-command-stdout>"));
  expect(ev!.kind).toBe("compact");
  expect(ev!.text).toBe("Set model to claude-opus-4-8"); // [1m] ANSI cruft stripped
  expect(ev!.text).not.toContain("<");
  expect(ev!.text.startsWith(">")).toBe(false);
});

test("a slash-command invocation is named plainly, tags gone", () => {
  const ev = eventFromRecord(userTurn(
    "<command-name>/model</command-name>\n            <command-message>model</command-message>\n" +
    "            <command-args>opus[1m]</command-args>"));
  expect(ev!.kind).toBe("compact");
  expect(ev!.text).toBe("Ran /model opus");
  expect(ev!.text).not.toContain("<command-name>");
});

test("an argument-less slash command drops the trailing space", () => {
  const ev = eventFromRecord(userTurn(
    "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n" +
    "            <command-args></command-args>"));
  expect(ev!.kind).toBe("compact");
  expect(ev!.text).toBe("Ran /compact");
});

test("a terminal ! bash line and its stdout are both quiet lines", () => {
  const input = eventFromRecord(userTurn("<bash-input>git status</bash-input>"));
  expect(input!.kind).toBe("compact");
  expect(input!.text).toBe("! git status");
  const output = eventFromRecord(userTurn("<bash-stdout>On branch main</bash-stdout>"));
  expect(output!.kind).toBe("compact");
  expect(output!.text).toBe("On branch main");
});

test("a prompt that merely QUOTES a command tag mid-text stays a prompt", () => {
  // the anchor matters: only a turn the harness authored whole begins with the
  // tag, so a person writing about <command-name> is untouched
  const ev = eventFromRecord(userTurn("what does <command-name> mean in the transcript?"));
  expect(ev!.kind).toBe("prompt");
  expect(ev!.text).toBe("> what does <command-name> mean in the transcript?");
});

test("a compaction boundary is still its own quiet line (the kind we borrow)", () => {
  const ev = eventFromRecord({
    type: "system",
    subtype: "compact_boundary",
    uuid: crypto.randomUUID(),
    timestamp: at(),
    compactMetadata: { preTokens: 120000, postTokens: 30000 },
  });
  expect(ev!.kind).toBe("compact");
  expect(ev!.text).toContain("compacted");
});

/* EVERY INPUT SOURCE IS VISIBLE AND ATTRIBUTED (this lane).
 *
 * The overlay must show inputs that arrived from OTHER places than the cyc app
 * -- a cron firing, one agent messaging another, a line typed straight into
 * the pane -- and label WHERE each came from. Source is read off the engine's
 * own delivery vocabulary (crons how:"SCHEDULED", deliverToAgent `<sender>: `),
 * never a guess about a person's words. The app's own sends stay suppressed:
 * they are already chat bubbles, so surfacing them would double them. */
test("an app-delivered input is not doubled into the overlay (it is a bubble)", () => {
  // both idle (user record) and busy (attachment) app deliveries stay out
  expect(eventFromRecord(userTurn("TEXT: did it fire?"))).toBeNull();
  expect(eventFromRecord(userTurn("VOICE: status please"))).toBeNull();
  expect(eventFromRecord(queuedCommand("TEXT: did it fire?"))).toBeNull();
});

test("a cron input is a prompt sourced cron, idle and busy alike", () => {
  const idle = eventFromRecord(userTurn("SCHEDULED (standup): give the update"));
  expect(idle!.kind).toBe("prompt");
  expect(idle!.source).toBe("cron");
  expect(idle!.sender).toBeUndefined();
  const busy = eventFromRecord(queuedCommand("SCHEDULED: bare form, no note"));
  expect(busy!.source).toBe("cron");
});

test("an agent-to-agent input is sourced agent and carries the sender id", () => {
  const idle = eventFromRecord(userTurn("DemoAgent: please rebase your branch"));
  expect(idle!.kind).toBe("prompt");
  expect(idle!.source).toBe("agent");
  expect(idle!.sender).toBe("DemoAgent");
  // the sender rides through the busy (attachment) path too
  const busy = eventFromRecord(queuedCommand("gov-bot: usage is at 80%"));
  expect(busy!.source).toBe("agent");
  expect(busy!.sender).toBe("gov-bot");
});

/* A CROSS-SESSION agent send arrives wrapped by the harness as a user turn,
 * raw XML and all (his 2026-09-08 screenshots). It must render like cron does:
 * an agent-source chip naming the origin (from-name) and only the clean inner
 * body, with the from= socket path and from-mode transport details gone. */
const CROSS_SESSION = '<cross-session-message from="uds:/run/user/1000/cc-socks/7478.sock" ' +
  'from-name="mrinmayai-e0" from-mode="bypass">\n' +
  'Correction from the other session: use the v2 endpoint, not v1.\n' +
  '</cross-session-message>';

test("a cross-session-message user record renders as an agent-source prompt, XML gone", () => {
  const ev = eventFromRecord(userTurn(CROSS_SESSION));
  expect(ev!.kind).toBe("prompt");
  expect(ev!.source).toBe("agent");
  expect(ev!.sender).toBe("mrinmayai-e0");
  expect(ev!.text.startsWith("> Correction from")).toBe(true);
  expect(ev!.text).not.toContain("<cross-session-message");
  expect(ev!.text).not.toContain("uds:");
  expect(ev!.text).not.toContain("from-mode");
});

test("a cross-session-message rides the busy attachment path the same way", () => {
  const ev = eventFromRecord(queuedCommand(CROSS_SESSION));
  expect(ev!.kind).toBe("prompt");
  expect(ev!.source).toBe("agent");
  expect(ev!.sender).toBe("mrinmayai-e0");
  expect(ev!.text.startsWith("> Correction from")).toBe(true);
  expect(ev!.text).not.toContain("<cross-session-message");
  expect(ev!.text).not.toContain("uds:");
  expect(ev!.text).not.toContain("from-mode");
});

test("a cross-session-message with no from-name is agent-sourced with no sender", () => {
  const ev = eventFromRecord(userTurn(
    '<cross-session-message from="uds:/run/user/1000/cc-socks/7478.sock" from-mode="bypass">\n' +
    'ping\n</cross-session-message>'));
  expect(ev!.kind).toBe("prompt");
  expect(ev!.source).toBe("agent");
  expect(ev!.sender).toBeUndefined();
  expect(ev!.text).toBe("> ping");
});

test("a prompt that merely MENTIONS the tag mid-prose is not unwrapped", () => {
  const ev = eventFromRecord(userTurn(
    "why did the <cross-session-message from-name=x> wrapper show raw in the overlay?"));
  expect(ev!.kind).toBe("prompt");
  expect(ev!.source).not.toBe("agent");
  expect(ev!.text).toBe(
    "> why did the <cross-session-message from-name=x> wrapper show raw in the overlay?");
});

test("a manual pane input is a prompt sourced manual, with no sender", () => {
  const ev = eventFromRecord(userTurn("fix the makefile"));
  expect(ev!.kind).toBe("prompt");
  expect(ev!.source).toBe("manual");
  expect(ev!.sender).toBeUndefined();
  // prose with an internal colon after a space is not a sender label
  expect(eventFromRecord(userTurn("I think: yes, do it"))!.source).toBe("manual");
});

test("classifyInput reads the engine's delivery prefixes, not the message body", () => {
  // cron beats the agent shape even though `SCHEDULED (x)` ends in a colon
  expect(classifyInput("SCHEDULED (nudge): go")).toEqual({ source: "cron" });
  expect(classifyInput("DemoAgent: hi")).toEqual({ source: "agent", sender: "DemoAgent" });
  expect(classifyInput("plain instruction with no prefix")).toEqual({ source: "manual" });
  // a url is not a sender: the colon is not followed by whitespace
  expect(classifyInput("see http://example.com now")).toEqual({ source: "manual" });
});

/* #490: the thinking indicator derives working/idle from the transcript,
 * because herdr 0.8.0 never reports `working`. The record shapes below are
 * copied from a real measured turn on the test-sink pane (claude-code 2.1.228):
 * a prompt opens the turn, a turn_duration system record closes it, tool_result
 * `user` records and the final end_turn assistant message sit in between. */

// the human prompt landing: `user` with a promptId, ~0.45s after the send
const promptLine = JSON.stringify({
  type: "user", promptId: "8533238e", uuid: "u1", timestamp: at(),
  message: { role: "user", content: "reply with just ok" },
});
// the app's own delivery is prefixed but must ALSO light the dots
const appPromptLine = JSON.stringify({
  type: "user", promptId: "app1", uuid: "u2", timestamp: at(),
  message: { role: "user", content: "VOICE: what time is it" },
});
// mid-turn assistant tool call: still working
const toolUseLine = JSON.stringify({
  type: "assistant", uuid: "a1", timestamp: at(),
  message: { model: "claude-haiku-4-5-20251001", stop_reason: "tool_use",
    content: [{ type: "tool_use", name: "Bash", input: { command: "echo hi" } }] },
});
// the tool result rides in on a `user` record mid-turn: neither edge
const toolResultLine = JSON.stringify({
  type: "user", promptId: "8533238e", uuid: "u3", timestamp: at(),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: "hi" }] },
});
// the final assistant message ends the turn
const endTurnLine = JSON.stringify({
  type: "assistant", uuid: "a2", timestamp: at(),
  message: { model: "claude-haiku-4-5-20251001", stop_reason: "end_turn",
    content: [{ type: "text", text: "done" }] },
});
// the definitive end marker
const turnDurationLine = JSON.stringify({
  type: "system", subtype: "turn_duration", durationMs: 4926, uuid: "s1", timestamp: at(),
});

test("#490 turn edges: prompt opens working, turn_duration closes idle", () => {
  expect(turnEdgeFromLine(promptLine)).toBe("working");
  expect(turnEdgeFromLine(appPromptLine)).toBe("working"); // app delivery counts
  expect(turnEdgeFromLine(toolUseLine)).toBe("working");   // mid-turn tool call
  expect(turnEdgeFromLine(endTurnLine)).toBe("idle");
  expect(turnEdgeFromLine(turnDurationLine)).toBe("idle");
});

test("#521 a Ctrl-C interrupt is a turn END, not a new prompt", () => {
  // the harness writes this promptId'd user record on interrupt; no
  // turn_duration follows, so if it read as "working" the dots spin forever
  const interruptLine = JSON.stringify({
    type: "user", promptId: "p_int", uuid: "i1", timestamp: at(),
    message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
  });
  expect(turnEdgeFromLine(interruptLine)).toBe("idle");
  // string-content form of the same record
  const interruptStr = JSON.stringify({
    type: "user", promptId: "p_int2", uuid: "i2", timestamp: at(),
    message: { role: "user", content: "[Request interrupted by user]" },
  });
  expect(turnEdgeFromLine(interruptStr)).toBe("idle");
});

test("#490 non-edges: tool_result, meta resume, and synthetic records are null", () => {
  expect(turnEdgeFromLine(toolResultLine)).toBeNull(); // mid-turn, not a new turn
  // the resume's synthetic "Continue from where you left off" (isMeta)
  expect(turnEdgeFromLine(JSON.stringify({
    type: "user", promptId: "x", isMeta: true, uuid: "m1", timestamp: at(),
    message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] },
  }))).toBeNull();
  // the resume's synthetic assistant "No response requested"
  expect(turnEdgeFromLine(JSON.stringify({
    type: "assistant", uuid: "syn", timestamp: at(),
    message: { model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "No response requested." }] },
  }))).toBeNull();
  expect(turnEdgeFromLine("not json")).toBeNull();
  expect(turnEdgeFromLine(JSON.stringify({ type: "file-history-snapshot" }))).toBeNull();
});

test("#490 TurnStatusParser: a full turn drains to the last edge, idle", async () => {
  const path = await jsonlPath();
  const p = new TurnStatusParser(path);

  // an empty/absent file is quiet
  expect(await p.drain()).toBeNull();

  // prompt lands in its own append: the working edge
  await Bun.write(path, promptLine + "\n");
  expect(await p.drain()).toBe("working");

  // the model works (tool call, tool result) but the turn is not done
  await appendLines(path, [toolUseLine, toolResultLine]);
  expect(await p.drain()).toBe("working");

  // the reply and the end marker land together: the batch collapses to idle
  await appendLines(path, [endTurnLine, turnDurationLine]);
  expect(await p.drain()).toBe("idle");

  // no new bytes: no edge
  expect(await p.drain()).toBeNull();
});

test("#490 TurnStatusParser: prompt and turn_duration in ONE drain is idle", async () => {
  const path = await jsonlPath();
  const p = new TurnStatusParser(path);
  await Bun.write(path, [promptLine, endTurnLine, turnDurationLine].join("\n") + "\n");
  // the whole turn arrived between two drains: the newest edge wins
  expect(await p.drain()).toBe("idle");
});

// the shape of a real voice-terminated turn (claude 2.1.233):
// mcp__voice__chat, its tool_result, speak, its tool_result, ScheduleWakeup,
// its tool_result, then turn_duration. No end_turn assistant. Last edge idle.
const voiceChatLine = JSON.stringify({
  type: "assistant", uuid: "v1", timestamp: at(),
  message: { model: "claude-fable-5", stop_reason: "tool_use",
    content: [{ type: "tool_use", name: "mcp__voice__chat", input: { text: "standup done" } }] },
});
const voiceChatResultLine = JSON.stringify({
  type: "user", promptId: "voice1", uuid: "vr1", timestamp: at(),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "v1", content: "ok" }] },
});
const voiceSpeakLine = JSON.stringify({
  type: "assistant", uuid: "v2", timestamp: at(),
  message: { model: "claude-fable-5", stop_reason: "tool_use",
    content: [{ type: "tool_use", name: "mcp__voice__speak", input: { text: "standup done" } }] },
});
const voiceSpeakResultLine = JSON.stringify({
  type: "user", promptId: "voice1", uuid: "vr2", timestamp: at(),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "v2", content: "ok" }] },
});

test("#490 specimen shape: a voice-chat-terminated turn still closes idle", () => {
  const seq = [promptLine, voiceChatLine, voiceChatResultLine, voiceSpeakLine, voiceSpeakResultLine, turnDurationLine];
  let last: ReturnType<typeof turnEdgeFromLine> = null;
  for (const line of seq) {
    const e = turnEdgeFromLine(line);
    if (e) last = e;
  }
  expect(turnEdgeFromLine(voiceChatLine)).toBe("working");
  expect(turnEdgeFromLine(voiceChatResultLine)).toBeNull();
  expect(last).toBe("idle");
});

test("#490 a text turn is working then idle", () => {
  expect(turnEdgeFromLine(promptLine)).toBe("working");
  expect(turnEdgeFromLine(endTurnLine)).toBe("idle");
  expect(turnEdgeFromLine(turnDurationLine)).toBe("idle");
});

test("#490 a tool turn stays working until the closer", () => {
  expect(turnEdgeFromLine(promptLine)).toBe("working");
  expect(turnEdgeFromLine(toolUseLine)).toBe("working");
  expect(turnEdgeFromLine(toolResultLine)).toBeNull();
  expect(turnEdgeFromLine(endTurnLine)).toBe("idle");
});

test("#490 a live tool_use with no tool_result yet stays working", () => {
  expect(turnEdgeFromLine(toolUseLine)).toBe("working");
  expect(turnEdgeFromLine(voiceChatLine)).toBe("working");
});

test("#490 TurnStatusParser two-step: working then a later turn_duration is idle", async () => {
  const path = await jsonlPath();
  const p = new TurnStatusParser(path);
  await Bun.write(path, promptLine + "\n");
  expect(await p.drain()).toBe("working");
  await appendLines(path, [turnDurationLine]);
  expect(await p.drain()).toBe("idle");
});

// real harness user turns, copied from the same session file at 37814-37815:
// /exit then its stdout. promptId present, no turn_duration, no end_turn.
const exitCommandLine = JSON.stringify({
  type: "user", promptId: "dbd08938-50de-4e2a-af98-2cd1e5bbf7b8", uuid: "x1", timestamp: at(),
  message: { role: "user", content: "<command-name>/exit</command-name>\n            <command-message>exit</command-message>\n            <command-args></command-args>" },
});
const exitStdoutLine = JSON.stringify({
  type: "user", promptId: "dbd08938-50de-4e2a-af98-2cd1e5bbf7b8", uuid: "x2", timestamp: at(),
  message: { role: "user", content: "<local-command-stdout>(no content)</local-command-stdout>" },
});
const taskNotificationLine = JSON.stringify({
  type: "user", promptId: "tn1", uuid: "tn1", timestamp: at(),
  message: { role: "user", content: COMPLETED },
});

test("#521 a /exit harness turn is a turn END, not a new prompt", () => {
  expect(turnEdgeFromLine(exitCommandLine)).toBe("idle");
  expect(turnEdgeFromLine(exitStdoutLine)).toBe("idle");
});

test("#383 a task-notification does not light the dots", () => {
  expect(turnEdgeFromLine(taskNotificationLine)).toBeNull();
});

test("#490 a finished turn then /exit drains idle, not working", async () => {
  const path = await jsonlPath();
  const p = new TurnStatusParser(path);
  await Bun.write(path, [promptLine, endTurnLine, turnDurationLine, exitCommandLine].join("\n") + "\n");
  expect(await p.drain()).toBe("idle");
});

async function appendLines(path: string, lines: string[]) {
  const existing = await Bun.file(path).text().catch(() => "");
  await Bun.write(path, existing + lines.join("\n") + "\n");
}

test("#490 TurnStatusParser: a partial trailing line is left for the next drain", async () => {
  /* A poll landing mid-write sees half a record. The offset only ever advances
   * past COMPLETE lines, so the half record is re-read whole next time. Without
   * that the edge it carried would be lost for good and the dots would be stuck
   * on whatever the previous complete line said. */
  const path = await jsonlPath();
  await Bun.write(path, promptLine + "\n" + turnDurationLine.slice(0, 30));
  const p = new TurnStatusParser(path);
  expect(await p.drain()).toBe("working");
  // the rest of the record lands: the idle edge is found now, not dropped
  await Bun.write(path, promptLine + "\n" + turnDurationLine + "\n");
  expect(await p.drain()).toBe("idle");
});

test("#490 TurnStatusParser: a rotated (shorter) file restarts from the top", async () => {
  /* A claude session that rolls its uuid leaves a file whose name is reused by
   * a smaller one. Continuing from the old offset would slice past the end of
   * the new file and report nothing for ever. */
  const path = await jsonlPath();
  await Bun.write(path, [promptLine, toolUseLine, endTurnLine, turnDurationLine].join("\n") + "\n");
  const p = new TurnStatusParser(path);
  expect(await p.drain()).toBe("idle");
  expect(p.offset).toBeGreaterThan(0);
  await Bun.write(path, promptLine + "\n"); // shorter: a different conversation
  expect(await p.drain(), "the new file's own first edge").toBe("working");
});

test("#490 TurnStatusParser: a file that is not there yet is quiet, not an error", () => {
  // the watcher arms before claude has written the transcript; a missing file
  // is "no edge", the same answer as no new bytes
  return (async () => {
    const p = new TurnStatusParser(join(await tmpDir("cyc-turn-"), "never-written.jsonl"));
    expect(await p.drain()).toBeNull();
    expect(p.offset).toBe(0);
  })();
});

// ------------------------------------------------------------ queue operations
//
// Claude Code logs its own input queue. A message delivered to a BUSY pane is
// enqueued and later removed into context; one delivered to an IDLE pane logs
// only its own `user` record. Both facts are read here, and they are what tells
// the app which of his messages Claude has actually taken in.

const queueOp = (operation: string, content: string) => JSON.stringify({
  type: "queue-operation", operation, content, timestamp: at(),
});

test("enqueue and remove are the two ends of one delivery", () => {
  const inq = queueOpFromLine(queueOp("enqueue", "TEXT: did it fire?"))!;
  expect(inq.op).toBe("enqueue");
  expect(inq.content).toBe("TEXT: did it fire?");
  expect(inq.ts).toBeGreaterThan(0);
  expect(queueOpFromLine(queueOp("remove", "TEXT: did it fire?"))!.op).toBe("consumed");
  /* `dequeue` is the spelling claude uses for input typed AT THE TERMINAL. It
   * means the same thing, and folding it here is what stops a terminal-typed
   * message sitting in the queue view for ever. */
  expect(queueOpFromLine(queueOp("dequeue", "typed at the pane"))!.op).toBe("consumed");
});

test("an operation we do not know, or an empty body, is not a queue op", () => {
  // an unknown operation must not be guessed into one of the two: a wrong guess
  // marks a message as read into context when it never was
  expect(queueOpFromLine(queueOp("peek", "x"))).toBeNull();
  expect(queueOpFromLine(queueOp("enqueue", ""))).toBeNull();
  expect(queueOpFromLine(JSON.stringify({ type: "user", operation: "enqueue", content: "x" }))).toBeNull();
  expect(queueOpFromLine("not json")).toBeNull();
  expect(queueOpFromLine("")).toBeNull();
});

test("the authoritative 'claude read it' signal is the message's own user record", () => {
  /* Measured: a message sent to a BUSY pane logs enqueue, remove, then the user
   * record; one sent to an IDLE pane logs only the user record. Keying on the
   * queue records alone left the marker stuck for ever on every idle delivery,
   * which is the whole reason this second reader exists. */
  const delivered = (content: unknown) => JSON.stringify({
    type: "user", promptId: "p1", uuid: "u1", timestamp: at(),
    message: { role: "user", content },
  });
  expect(deliveredTextFromLine(delivered("TEXT: did it fire?"))).toBe("TEXT: did it fire?");
  expect(deliveredTextFromLine(delivered("VOICE: status please"))).toBe("VOICE: status please");
  // the array-block form of the same record
  expect(deliveredTextFromLine(delivered([{ type: "text", text: "TEXT: hello" }]))).toBe("TEXT: hello");
  // something HE typed at the terminal is not one of ours
  expect(deliveredTextFromLine(delivered("fix the makefile"))).toBeNull();
  // a record that merely QUOTES the prefix mid-sentence is not a delivery
  expect(deliveredTextFromLine(delivered('what does the "VOICE: " prefix mean?'))).toBeNull();
  // and a record with no promptId never entered context as a prompt
  expect(deliveredTextFromLine(JSON.stringify({
    type: "user", uuid: "u2", timestamp: at(), message: { content: "TEXT: x" },
  }))).toBeNull();
});

test("SessionTailParser reports the events, the queue ops and the consumed texts of ONE drain", async () => {
  /* The three outputs are per-drain, not cumulative: the engine reads them
   * immediately after each drain, and a list that kept growing would re-apply
   * yesterday's deliveries on every poll. */
  const path = await jsonlPath();
  const p = new SessionTailParser(path);
  expect(await p.drain(), "no file yet").toEqual([]);

  await Bun.write(path, [
    queueOp("enqueue", "TEXT: did it fire?"),
    JSON.stringify({ type: "user", promptId: "p1", uuid: "u1", timestamp: at(),
      message: { role: "user", content: "fix the makefile" } }),
  ].join("\n") + "\n");

  const first = await p.drain();
  expect(first.map((e) => e.kind)).toEqual(["prompt"]);
  expect(first[0]!.text).toBe("> fix the makefile");
  expect(p.queueOps.map((q) => q.op)).toEqual(["enqueue"]);
  expect(p.consumed, "the app's own delivery has not landed yet").toEqual([]);

  await appendLines(path, [
    queueOp("remove", "TEXT: did it fire?"),
    JSON.stringify({ type: "user", promptId: "p2", uuid: "u2", timestamp: at(),
      message: { role: "user", content: "TEXT: did it fire?" } }),
  ]);
  const second = await p.drain();
  expect(second, "the app's own message is already a bubble; it is not an overlay event")
    .toEqual([]);
  expect(p.queueOps.map((q) => q.op)).toEqual(["consumed"]);
  expect(p.consumed).toEqual(["TEXT: did it fire?"]);

  /* A DRAIN THAT FINDS NO NEW BYTES RETURNS EARLY, before the two side lists
   * are cleared, so they still hold the PREVIOUS drain's contents. Pinned
   * because it is a sharp edge rather than an obviously-right answer: the
   * caller must read queueOps/consumed off the drain that produced them and
   * never treat a later poll's copy as fresh, or one delivery would be marked
   * consumed on every quiet poll for as long as the file sat still. */
  expect(await p.drain()).toEqual([]);
  expect(p.queueOps.map((q) => q.op)).toEqual(["consumed"]);
  expect(p.consumed).toEqual(["TEXT: did it fire?"]);

  // a drain that DOES find new bytes clears them and reports only its own
  await appendLines(path, [queueOp("enqueue", "TEXT: and again?")]);
  await p.drain();
  expect(p.queueOps.map((q) => q.content)).toEqual(["TEXT: and again?"]);
  expect(p.consumed, "the earlier delivery is not re-reported").toEqual([]);
});

test("SessionTailParser leaves a partial trailing line for the next drain", async () => {
  const path = await jsonlPath();
  const line = JSON.stringify({ type: "user", promptId: "p1", uuid: "u1", timestamp: at(),
    message: { role: "user", content: "a whole prompt" } });
  const p = new SessionTailParser(path);
  await Bun.write(path, line.slice(0, 40));
  expect(await p.drain(), "half a record is not an event").toEqual([]);
  expect(p.offset).toBe(0);
  await Bun.write(path, line + "\n");
  expect((await p.drain()).map((e) => e.text)).toEqual(["> a whole prompt"]);
});

test("SessionTailParser starts over when the file shrinks", async () => {
  const path = await jsonlPath();
  const mk = (text: string) => JSON.stringify({ type: "user", promptId: "p", uuid: crypto.randomUUID(),
    timestamp: at(), message: { role: "user", content: text } });
  const p = new SessionTailParser(path);
  await Bun.write(path, [mk("one"), mk("two"), mk("three")].join("\n") + "\n");
  expect(await p.drain()).toHaveLength(3);
  await Bun.write(path, mk("fresh") + "\n"); // rotated: shorter file, new content
  expect((await p.drain()).map((e) => e.text)).toEqual(["> fresh"]);
});

// ------------------------------------------------- the rest of the record map

test("an assistant text block is a reply; a thinking block is nothing", () => {
  const reply = eventFromRecord({
    type: "assistant", uuid: "a1", timestamp: at(),
    message: { content: [{ type: "text", text: "here is what I found" }] },
  })!;
  expect(reply.kind).toBe("reply");
  expect(reply.text, "no '> ' prefix: that marks a PROMPT").toBe("here is what I found");
  expect(eventFromRecord({
    type: "assistant", uuid: "a2", timestamp: at(),
    message: { content: [{ type: "thinking", thinking: "hmm" }] },
  }), "thinking is not shown in the overlay").toBeNull();
  expect(eventFromRecord({
    type: "assistant", uuid: "a3", timestamp: at(),
    message: { content: [{ type: "text", text: "   " }] },
  }), "an empty reply is not an event").toBeNull();
});

test("a tool call is labelled by what it is doing, not by its raw input", () => {
  const tool = (name: string, input: unknown) => eventFromRecord({
    type: "assistant", uuid: crypto.randomUUID(), timestamp: at(),
    message: { content: [{ type: "tool_use", name, input }] },
  })!;
  // Bash prefers the description it was given; the command is the fallback
  expect(tool("Bash", { description: "Run the tests", command: "bun test" }).text)
    .toBe("Bash: Run the tests");
  expect(tool("Bash", { command: "git   status  -sb" }).text,
    "whitespace squeezed so a wrapped command is one line").toBe("Bash: git status -sb");
  // the file tools carry the BASENAME: a phone has no room for an absolute path
  expect(tool("Read", { file_path: "/home/x/projects/deep/nested/server.ts" }).text)
    .toBe("Read: server.ts");
  expect(tool("Write", { file_path: "/tmp/note.txt" }).text).toBe("Write: note.txt");
  expect(tool("Edit", {}).text, "no path at all: the tool name alone").toBe("Edit");
  expect(tool("Agent", { description: "Sweep for stale code" }).text)
    .toBe("Agent: Sweep for stale code");
  expect(tool("Grep", { pattern: "x" }).text, "an unknown tool is named, not described").toBe("Grep");
  // and the chip carries the raw tool name for the app to render
  expect(tool("Bash", { command: "ls" }).tool).toBe("Bash");
});

test("the app's OWN output tools never echo back into the overlay", () => {
  /* speak and show ARE the claude bubbles and the file cards. Echoing them would
   * replay the whole chat into the overlay beside itself. Both server keys are
   * dropped: the MCP server was renamed voice -> callyourcode (task 593), and a
   * live session keeps the old names until it reconnects. */
  for (const name of ["mcp__voice__speak", "mcp__voice__show",
    "mcp__callyourcode__speak", "mcp__callyourcode__show"]) {
    expect(eventFromRecord({
      type: "assistant", uuid: crypto.randomUUID(), timestamp: at(),
      message: { content: [{ type: "tool_use", name, input: { text: "hi" } }] },
    }), `${name} leaked into the overlay`).toBeNull();
  }
  // a DIFFERENT mcp tool on the same server is ordinary and does show
  expect(eventFromRecord({
    type: "assistant", uuid: "a9", timestamp: at(),
    message: { content: [{ type: "tool_use", name: "mcp__voice__chat", input: {} }] },
  })!.kind).toBe("tool");
});

test("the app's own prompts stay out, and a tool_result is not a prompt", () => {
  const user = (content: unknown, extra: Record<string, unknown> = {}) => eventFromRecord({
    type: "user", uuid: crypto.randomUUID(), timestamp: at(), promptId: "p", message: { content }, ...extra,
  });
  expect(user("VOICE: what time is it"), "already a user bubble").toBeNull();
  expect(user("TEXT: did it fire?")).toBeNull();
  expect(user([{ type: "tool_result", tool_use_id: "a1", content: "ok" }])).toBeNull();
  expect(user("something", { isMeta: true }), "the resume's synthetic turn").toBeNull();
  expect(user("summary", { isCompactSummary: true })).toBeNull();
  expect(user("   "), "an empty prompt is not an event").toBeNull();
  // an image block renders as a placeholder rather than as nothing
  expect(user([{ type: "image", source: {} }, { type: "text", text: "look" }])!.text)
    .toBe("> [image]\nlook");
});

test("a record with no usable timestamp or uuid is dropped, whatever else it says", () => {
  /* The uuid IS the event id the app dedupes on, and the ts is what orders the
   * overlay. A record missing either cannot be placed, so it is not shown at
   * all rather than shown at the epoch under a duplicate key. */
  expect(eventFromRecord(null)).toBeNull();
  expect(eventFromRecord("a string")).toBeNull();
  expect(eventFromRecord({ type: "user", uuid: "u", message: { content: "x" } })).toBeNull();
  expect(eventFromRecord({ type: "user", uuid: "u", timestamp: "not a date",
    promptId: "p", message: { content: "x" } })).toBeNull();
  expect(eventFromRecord({ type: "user", timestamp: at(), promptId: "p",
    message: { content: "x" } }), "no uuid: no stable event id").toBeNull();
  expect(eventFromRecord({ type: "file-history-snapshot", uuid: "u", timestamp: at() })).toBeNull();
});

test("a compaction boundary names the sizes it collapsed", () => {
  const ev = eventFromRecord({
    type: "system", subtype: "compact_boundary", uuid: "s1", timestamp: at(),
    compactMetadata: { preTokens: 233_094, postTokens: 12_709 },
  })!;
  expect(ev.kind).toBe("compact");
  expect(ev.text).toBe("Conversation compacted (233k -> 13k tokens)");
  // a boundary with no metadata still renders rather than throwing
  expect(eventFromRecord({ type: "system", subtype: "compact_boundary", uuid: "s2", timestamp: at() })!.text)
    .toBe("Conversation compacted (? -> ? tokens)");
});

test("a very long prompt is capped with an ellipsis rather than sent whole", () => {
  /* 20000 chars for a prompt or reply (the app's tap-to-expand shows the body),
   * 200 for the one-liners. An uncapped body is how a 743 KB pasted image
   * caption would ride to a phone. */
  const long = eventFromRecord({
    type: "user", uuid: "u", timestamp: at(), promptId: "p",
    message: { content: "x".repeat(25000) },
  })!;
  expect(long.text.endsWith("…")).toBe(true);
  expect(long.text.length).toBe(2 + 20000 + 1); // "> " + cap + the ellipsis
  const tool = eventFromRecord({
    type: "assistant", uuid: "a", timestamp: at(),
    message: { content: [{ type: "tool_use", name: "Bash", input: { description: "y".repeat(500) } }] },
  })!;
  expect(tool.text.endsWith("…")).toBe(true);
  expect(tool.text.length).toBeLessThan(220);
});

test("mungeCwd replaces '_' with '-' the way Claude Code does (underscore repro)", () => {
  // Live repro: /home/user/acme_outreach showed Ctx n/a and no
  // model chip because the old munge kept the underscore and so pointed at a
  // folder Claude Code never writes. Claude Code (verified against the CLI,
  // v2.1.271) replaces EVERY non-alphanumeric char with '-'.
  const cwd = "/home/user/acme_outreach";
  const oldMunge = (s: string) => s.replace(/[/.]/g, "-"); // the buggy one-liner
  expect(mungeCwd(cwd)).toBe("-home-user-acme-outreach");
  // the old munge kept the underscore -> the WRONG folder
  expect(oldMunge(cwd)).toBe("-home-user-acme_outreach");
  expect(mungeCwd(cwd)).not.toBe(oldMunge(cwd));
});

test("sessionFilePath munges a cwd with '_' to the dash folder", () => {
  const prev = process.env.CYC_PROJECTS_DIR;
  process.env.CYC_PROJECTS_DIR = "/tmp/cyc-proj-root";
  try {
    const sid = "3e87629b-1658-45eb-b97d-08ba695a2cf5";
    const cwd = "/home/user/acme_outreach";
    expect(sessionFilePath(cwd, sid)).toBe(
      `/tmp/cyc-proj-root/${mungeCwd(cwd)}/${sid}.jsonl`
    );
    // and that folder is the dash form, never the underscore one
    expect(sessionFilePath(cwd, sid)).toContain("acme-outreach");
    expect(sessionFilePath(cwd, sid)).not.toContain("acme_outreach");
  } finally {
    if (prev === undefined) delete process.env.CYC_PROJECTS_DIR;
    else process.env.CYC_PROJECTS_DIR = prev;
  }
});

test("findTranscriptBySessionId locates a transcript by id alone, cwd unknown", async () => {
  const root = await tmpDir("cyc-projects-");
  const prev = process.env.CYC_PROJECTS_DIR;
  process.env.CYC_PROJECTS_DIR = root;
  try {
    const sid = "3e87629b-1658-45eb-b97d-08ba695a2cf5";
    const proj = join(root, "-home-example-vanditai");
    await mkdir(proj, { recursive: true });
    await Bun.write(join(proj, `${sid}.jsonl`), "{}\n");
    expect(findTranscriptBySessionId(sid)).toBe(join(proj, `${sid}.jsonl`));
    // an id with no file anywhere, and a path-traversal attempt, both refuse
    expect(findTranscriptBySessionId("00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(findTranscriptBySessionId("../etc/passwd")).toBeNull();
  } finally {
    if (prev === undefined) delete process.env.CYC_PROJECTS_DIR;
    else process.env.CYC_PROJECTS_DIR = prev;
  }
});
