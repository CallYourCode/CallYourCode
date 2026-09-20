/* How full a session's context is, and where the number is allowed to come from.
 *
 * The one rule this file exists to keep: THE NUMBER IS NOT SCRAPED OFF THE PANE
 * ("no dont depend on the pane thats not a good solution"). It is the
 * transcript's own `message.usage` accounting against the model's context
 * window, so the tests here are about that record and nothing else.
 *
 * The second rule is the reading. USED, not left. 95% used is nearly out of
 * room and 95% left is nearly empty, so a test that only checks "some number
 * came back" would pass with the field inverted.
 *
 *   bun test agent-engine/src/sessions/context.test.ts
 */

import { test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMPACTED, DEFAULT_CONTEXT_WINDOW, contextPct, contextWindowFor, modelAcronym, modelAcronymOf, modelDisplayName, modelIdOf, modelName, readContextUsage, usageFromLine } from "./session-events.ts";
import { friendlyModelName } from "../plugins/model-indicator/index.ts";
import { tmpDir } from "../test-utils/tmp.ts";

/* EVERY CLAUDE ID THIS BOX HAS WRITTEN, surveyed over ~/.claude/projects on
 * 2026-09-02, with the name and acronym each must derive to. The two that broke
 * the hand list are here: `claude-fable-5-1` (12,135 records) and
 * `claude-opus-4-6` (1,996). */
const REAL_IDS: Array<[id: string, name: string, acronym: string]> = [
  ["claude-opus-4-8", "Opus 4.8", "O4.8"],
  ["claude-fable-5", "Fable 5", "F5"],
  ["claude-opus-5", "Opus 5", "O5"],
  ["claude-sonnet-5", "Sonnet 5", "S5"],
  ["claude-opus-4-7", "Opus 4.7", "O4.7"],
  ["claude-fable-5-1", "Fable 5.1", "F5.1"],
  ["claude-fable-5[1m]", "Fable 5", "F5"],
  ["claude-haiku-4-5-20251001", "Haiku 4.5", "H4.5"],
  ["claude-opus-4-6", "Opus 4.6", "O4.6"],
  ["claude-sonnet-4-6", "Sonnet 4.6", "S4.6"],
  ["claude-opus-4-8[1m]", "Opus 4.8", "O4.8"],
  ["claude-opus-5[1m]", "Opus 5", "O5"],
];

function assistant(opts: {
  model?: string;
  input?: number;
  cacheRead?: number;
  cacheCreate?: number;
  output?: number;
  sidechain?: boolean;
}): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `u${Math.random()}`,
    timestamp: new Date().toISOString(),
    isSidechain: opts.sidechain ?? false,
    message: {
      model: opts.model ?? "claude-opus-5",
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: opts.input ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
        output_tokens: opts.output ?? 0,
      },
    },
  });
}

/* A COMPACTION, in the shape Claude Code actually writes it.
 *
 * Copied field-for-field off a real one (claude 2.1.195).
 * `content`, `compactMetadata` and the summary
 * record that follows are all reproduced because the point of the fixture is
 * that NONE of them carries a `usage` block -- which is why a backwards scan
 * used to read straight through a compaction and answer with the turn behind
 * it. A fixture that were merely `{type:"system",subtype:"compact_boundary"}`
 * would pass against a matcher written for a shape nobody has seen. */
function compaction(opts: { trigger?: "manual" | "auto"; pre?: number; post?: number } = {}): string[] {
  const boundaryUuid = `b${Math.random()}`;
  return [
    JSON.stringify({
      parentUuid: null, logicalParentUuid: `p${Math.random()}`, isSidechain: false,
      type: "system", subtype: "compact_boundary",
      content: "Conversation compacted", isMeta: false,
      timestamp: new Date().toISOString(), uuid: boundaryUuid, level: "info",
      compactMetadata: {
        trigger: opts.trigger ?? "manual",
        preTokens: opts.pre ?? 233_094,
        durationMs: 283_461,
        preCompactDiscoveredTools: ["WebFetch", "WebSearch"],
        postTokens: opts.post ?? 12_709,
      },
      userType: "external", cwd: "/tmp", sessionId: "s", version: "2.1.195",
    }),
    JSON.stringify({
      parentUuid: boundaryUuid, isSidechain: false, promptId: `q${Math.random()}`,
      type: "user",
      message: { role: "user", content: "This session is being continued from a previous conversation…" },
      isVisibleInTranscriptOnly: true, isCompactSummary: true,
      uuid: `u${Math.random()}`, timestamp: new Date().toISOString(),
      userType: "external", cwd: "/tmp", sessionId: "s", version: "2.1.195",
    }),
  ];
}

// --------------------------------------------------------------- one record

test("the three input fields are what is in context, and output_tokens is not", () => {
  const u = usageFromLine(assistant({ input: 2, cacheRead: 818_811, cacheCreate: 1814, output: 9_000 }));
  expect(u,
    "input + cache_read + cache_creation is what the model READ for this request. " +
    "output_tokens is what it wrote; that becomes context on the NEXT request and " +
    "is counted there, so adding it here double-counts every turn.")
    .toEqual({ tokens: 820_627, model: "claude-opus-5" });
});

test("a subagent's turn is not this session's context", () => {
  expect(usageFromLine(assistant({ input: 500_000, sidechain: true })),
    "isSidechain records are a SUBAGENT's turns written into the same file. It has " +
    "its own context, so counting one reports the agent's fullness as whatever its " +
    "helper happened to be holding.")
    .toBeNull();
});

test("a user record with the word usage in it is not a usage record", () => {
  const line = JSON.stringify({
    type: "user", uuid: "u1", promptId: "p1", timestamp: new Date().toISOString(),
    message: { content: "what is our token usage" },
  });
  expect(usageFromLine(line)).toBeNull();
});

test("a half-written line is skipped rather than thrown", () => {
  expect(usageFromLine(assistant({ input: 10 }).slice(0, 60))).toBeNull();
  expect(usageFromLine("")).toBeNull();
  expect(usageFromLine("{}")).toBeNull();
});

test("a usage block that adds up to nothing is not a reading", () => {
  /* Zero read tokens is not "an empty context", it is a record that measured
   * nothing -- and reporting 0% for it would flash the bar to empty mid-session.
   * The same for a record with no model on it: without a model there is no
   * window, so there is no percentage to compute either. */
  expect(usageFromLine(assistant({}))).toBeNull();
  expect(usageFromLine(assistant({ output: 9_000 })),
    "output alone is not context: it becomes context on the NEXT request").toBeNull();
  expect(usageFromLine(JSON.stringify({
    type: "assistant", uuid: "u", timestamp: new Date().toISOString(),
    message: { content: [], usage: { input_tokens: 500 } },
  })), "no model means no window means no answer").toBeNull();
});

test("nonsense numbers in the usage block are ignored, not added", () => {
  /* Each field is taken only when it is a finite positive number. A negative or
   * a string would otherwise poison the sum, and the failure would be silent:
   * the bar would just read a bit wrong for the rest of the session. */
  const line = JSON.stringify({
    type: "assistant", uuid: "u", timestamp: new Date().toISOString(),
    message: {
      model: "claude-opus-5", content: [],
      usage: { input_tokens: 100, cache_read_input_tokens: -50,
        cache_creation_input_tokens: "900", output_tokens: 7 },
    },
  });
  expect(usageFromLine(line)).toEqual({ tokens: 100, model: "claude-opus-5" });
});

test("a record with a usage block that is not an object is not a reading", () => {
  expect(usageFromLine(JSON.stringify({
    type: "assistant", uuid: "u", timestamp: new Date().toISOString(),
    message: { model: "claude-opus-5", content: [], usage: "none" },
  }))).toBeNull();
});

// ------------------------------------------------------------- the window

/* FAIL OPEN (2026-09-02, owner's call): "1m context window is pretty much
 * standard now", "it should just work with all harnesses and models". The old
 * list answered null for anything it had not seen, and the app drew NO context
 * button for null; the day Claude Code started writing `claude-fable-5-1`, the
 * button vanished on the model he was using. A wrong-but-present bar beats a
 * missing one, so every model is 1M unless the override table knows better. */
test("every model is 1M unless the override table says otherwise, never null", () => {
  expect(DEFAULT_CONTEXT_WINDOW).toBe(1_000_000);
  expect(contextWindowFor("claude-opus-5")).toBe(1_000_000);
  expect(contextWindowFor("claude-fable-5")).toBe(1_000_000);
  expect(contextWindowFor("claude-sonnet-5")).toBe(1_000_000);
  expect(contextWindowFor("claude-opus-4-8")).toBe(1_000_000);
  expect(contextWindowFor("claude-fable-5-1"),
    "the id that broke the hand list: 12,135 records on this box and no window").toBe(1_000_000);
  expect(contextWindowFor("claude-opus-4-6")).toBe(1_000_000);
  expect(contextWindowFor("claude-neptune-9"),
    "a family nobody has seen fails OPEN to the 1M default").toBe(DEFAULT_CONTEXT_WINDOW);
  expect(contextWindowFor("<synthetic>")).toBe(DEFAULT_CONTEXT_WINDOW);
  expect(contextWindowFor("gpt-5.5"), "a non-claude id takes the default too").toBe(DEFAULT_CONTEXT_WINDOW);
  expect(contextWindowFor("")).toBe(DEFAULT_CONTEXT_WINDOW);
  expect(contextWindowFor("claude-haiku-4-5"),
    "the one measured exception: Haiku's window is 200k, and the override keeps its bar right")
    .toBe(200_000);
});

// ------------------------------------------------------------ the percentage

test("the percentage agrees with the pane, measured twice on a live session", () => {
  /* Both readings were taken off a throwaway `claude` pane on 2026-08-04 with
   * the pane's own status line captured at the same moment. This is the only
   * check that the DENOMINATOR is right; everything else here would pass with
   * the window off by a factor. */
  expect(contextPct({ tokens: 33_121, model: "claude-opus-5" }),
    "the pane read `ctx 3%` at 33,121 tokens").toBe(3);
  expect(contextPct({ tokens: 171_947, model: "claude-opus-5" }),
    "the pane read `ctx 17%` at 171,947 tokens").toBe(17);
});

test("it reports USED, so a nearly-full context is a high number", () => {
  expect(contextPct({ tokens: 950_000, model: "claude-opus-5" }),
    "950k of a 1M window is nearly out of room. If this answered 5 the field is " +
    "reporting what is LEFT, and orange-at-80 would then fire on an empty session.")
    .toBe(95);
  expect(contextPct({ tokens: 20_000, model: "claude-opus-5" })).toBe(2);
});

test("a real reading always has a percentage; only no reading at all is null", () => {
  expect(contextPct({ tokens: 100_000, model: "claude-haiku-4-5" }),
    "haiku against its 200k override: 100k is half").toBe(50);
  expect(contextPct({ tokens: 250_000, model: "claude-fable-5-1" }),
    "fable 5.1 against the 1M default").toBe(25);
  expect(contextPct({ tokens: 250_000, model: "claude-neptune-9" }),
    "an unknown family fails open to 1M rather than to no button").toBe(25);
  expect(contextPct({ tokens: 250_000, model: "claude-opus-5[1m]" }), "[1m] is still 1M").toBe(25);
  expect(contextPct({ tokens: 100_000, model: "claude-haiku-4-5-20251001" }), "haiku still 200k").toBe(50);
  expect(contextPct(null), "no reading is still no percentage").toBeNull();
});

test("a freshly compacted session reads 0, not 'no reading'", () => {
  expect(contextPct(COMPACTED),
    "His call, 2026-08-05: 'Don't complicate the compaction button, just show 0% and " +
    "not grey out.' The button is drawn normally and reads empty, and it fills in for " +
    "real on the session's next turn. What still matters is that the compaction " +
    "TERMINATES the scan, which is what stopped it reporting the pre-compaction figure.")
    .toBe(0);
  expect(contextPct(null),
    "and a session whose usage genuinely cannot be read is still a different answer")
    .toBeNull();
});

test("more tokens than the window still reads as full, not as 340%", () => {
  expect(contextPct({ tokens: 3_400_000, model: "claude-opus-5" })).toBe(100);
});

test("the reading FLOORS, so 99.9% is 99 and never a premature 100", () => {
  /* Floored to agree with the pane digit for digit (measured twice on a live
   * session above). It also matters at the top: the bar reads 100 only when the
   * window is genuinely spent, not when it is nearly spent. */
  expect(contextPct({ tokens: 999_999, model: "claude-opus-5" })).toBe(99);
  expect(contextPct({ tokens: 1_000_000, model: "claude-opus-5" })).toBe(100);
  expect(contextPct({ tokens: 9_999, model: "claude-opus-5" }),
    "just under one percent shows as zero, the same as the pane does").toBe(0);
  expect(contextPct({ tokens: 800_000, model: "claude-opus-5" }),
    "the orange-at-80 threshold is a real edge and has to land on the digit").toBe(80);
});

// --------------------------------------------------------------- the file

async function transcript(lines: string[]): Promise<string> {
  const dir = await tmpDir("ctxprobe-");
  const path = join(dir, "session.jsonl");
  await writeFile(path, lines.join("\n") + "\n");
  return path;
}

test("the NEWEST assistant turn wins, because that is the current context", async () => {
  const path = await transcript([
    assistant({ input: 10_000 }),
    assistant({ input: 40_000 }),
    assistant({ input: 90_000 }),
  ]);
  expect(await readContextUsage(path)).toEqual({ tokens: 90_000, model: "claude-opus-5" });
});

test("a compaction that shrinks the context shrinks the number", async () => {
  /* The whole point of the button: after /compact the next turn reads small,
   * and the reader must follow it DOWN rather than remembering the peak. */
  const path = await transcript([
    assistant({ input: 900_000 }),
    ...compaction({ pre: 900_000 }),
    assistant({ input: 60_000 }),
  ]);
  expect(contextPct(await readContextUsage(path))).toBe(6);
});

test("a session compacted and not spoken since does NOT report the old number", async () => {
  /* HIS BUG, 2026-08-04: "i compacted the vector change and its at 0% now but
   * the ui still shows the old precompaction number". A compaction writes no
   * usage record, so the newest one in the file is still the fat turn the
   * compact just discarded -- and the scan read straight past the boundary to
   * find it. The boundary terminates the scan now. */
  const path = await transcript([
    assistant({ input: 900_000 }),
    ...compaction({ pre: 900_000 }),
  ]);
  const reading = await readContextUsage(path);
  expect(reading,
    "the 900k turn is behind the compaction. Answering with it reports a conversation " +
    "that no longer exists, at the one moment he is certain to be looking: he just " +
    "compacted.")
    .toBe(COMPACTED);
  expect(contextPct(reading),
    "and it reads 0 rather than 90: his call, 2026-08-05, that the button should just " +
    "show 0% and not grey out")
    .toBe(0);
});

test("an auto-compact terminates the scan the same as a manual one", async () => {
  /* Both triggers appear in the real transcripts on this machine (116 manual,
   * 55 auto). Neither writes usage, so neither may be read past. */
  const path = await transcript([assistant({ input: 800_000 }), ...compaction({ trigger: "auto" })]);
  expect(await readContextUsage(path)).toBe(COMPACTED);
});

test("the boundary is a terminator, not a permanent one: the next turn answers again", async () => {
  /* The compacted state has to END. It lasts exactly until the agent speaks,
   * which is the first record after the compaction that carries usage. */
  const path = await transcript([
    assistant({ input: 900_000 }),
    ...compaction(),
    assistant({ input: 30_000 }),
  ]);
  expect(await readContextUsage(path)).toEqual({ tokens: 30_000, model: "claude-opus-5" });
  expect(contextPct(await readContextUsage(path))).toBe(3);
});

/* THE TWO RECORDS A /model SWITCH WRITES, in the shape the harness writes them:
 * a `type:"user"` record whose message.content is the raw command XML, no
 * assistant usage between them. `modelArgs` is the invocation (VALUE = an exact
 * id, an alias, or empty when the picker opened); `modelStdout` is the resolved
 * confirmation (NAME backticked), written AFTER the args record so the
 * newest-first walk meets it first. */
function modelArgs(value: string): string {
  return JSON.stringify({
    type: "user", uuid: `u${Math.random()}`, timestamp: new Date().toISOString(),
    promptId: `p${Math.random()}`,
    message: { role: "user",
      content: `<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>${value}</command-args>` },
  });
}
function modelStdout(name: string): string {
  return JSON.stringify({
    type: "user", uuid: `u${Math.random()}`, timestamp: new Date().toISOString(),
    promptId: `p${Math.random()}`,
    message: { role: "user",
      content: `<local-command-stdout>Set model to \`${name}\` (was Opus 4.8)</local-command-stdout>` },
  });
}

test("an idle /model switch overrides the stale model of the newest usage (#model-chip)", async () => {
  /* His screenshot: five sessions switched to Fable 5.1 kept reading Opus 4.8,
   * because a switch writes no assistant usage and the walk answered the newest
   * usage record's own (old) model. The two-fixture proof: the usage record
   * ALONE still reads Opus 4.8 (the old behavior), and the same usage record
   * followed by the two /model records now reads Fable 5.1 / F5.1. */
  const usageOnly = await transcript([assistant({ model: "claude-opus-4-8", input: 90_000 })]);
  expect(modelName(await readContextUsage(usageOnly)),
    "usage-only: the old, byte-identical behavior").toBe("Opus 4.8");

  const switched = await transcript([
    assistant({ model: "claude-opus-4-8", input: 90_000 }),
    modelArgs("claude-fable-5-1"),
    modelStdout("Fable 5.1"),
  ]);
  const reading = await readContextUsage(switched);
  expect(modelName(reading), "the switch names the CURRENT model").toBe("Fable 5.1");
  expect(modelAcronymOf(reading), "acronym spelled from the display name").toBe("F5.1");
  expect(contextPct(reading), "tokens/pct still come from the usage record")
    .toBe(contextPct({ tokens: 90_000, model: "claude-opus-4-8" }));
});

test("an alias args switch with no stdout answers the raw alias name", async () => {
  const path = await transcript([
    assistant({ model: "claude-opus-4-8", input: 90_000 }),
    modelArgs("opus"),
  ]);
  const reading = await readContextUsage(path);
  expect(modelName(reading), "an alias with no stdout is the best name, never null").toBe("opus");
  expect(modelAcronymOf(reading)).toBe("opus");
});

test("an alias args WITH a stdout name uses the resolved display name", async () => {
  const path = await transcript([
    assistant({ model: "claude-opus-4-8", input: 90_000 }),
    modelArgs("fable"),
    modelStdout("Fable 5.1"),
  ]);
  const reading = await readContextUsage(path);
  expect(modelName(reading)).toBe("Fable 5.1");
  expect(modelAcronymOf(reading)).toBe("F5.1");
});

test("a switch OLDER than a newer usage record loses: the turn that ran wins", async () => {
  /* A turn ran AFTER the switch, so the walk meets a usage record before the
   * switch and the reading is byte-identical to today. */
  const path = await transcript([
    modelArgs("claude-fable-5-1"),
    modelStdout("Fable 5.1"),
    assistant({ model: "claude-opus-5", input: 50_000 }),
  ]);
  const reading = await readContextUsage(path);
  expect(modelName(reading)).toBe("Opus 5");
  expect(modelIdOf(reading)).toBe("claude-opus-5");
});

test("an empty /model args (picker opened, nothing chosen) is not a switch", async () => {
  const path = await transcript([
    assistant({ model: "claude-opus-4-8", input: 90_000 }),
    modelArgs(""),
  ]);
  expect(modelName(await readContextUsage(path)),
    "the picker opening must not repaint the chip").toBe("Opus 4.8");
});

test("a ROLLED session tracks the newest entry, not the compaction head (#571)", async () => {
  /* A claude session that rolls its uuid (auto-compaction mints a fresh
   * transcript) opens the NEW jsonl with the compaction boundary and its summary
   * at the HEAD, then grows as the conversation continues. The estimate must be
   * the newest assistant turn of this current file, not the small first turn
   * after the compaction and not COMPACTED (there IS a turn since the boundary).
   *
   * This is the ctx half of the rollover: the live session showed ctx 4% in the
   * app when the pane was much fuller, because the derivation must read the
   * newest usage of the CURRENT jsonl. Backward-scanning to the newest turn is
   * exactly that, and the head compaction never terminates the scan because a
   * larger, newer usage sits ahead of it. */
  const path = await transcript([
    ...compaction({ trigger: "auto", pre: 900_000, post: 12_000 }), // the rolled file's head
    assistant({ input: 30_000 }),   // first post-compaction turn: small
    assistant({ input: 420_000 }),  // it grows
    assistant({ input: 880_000 }),  // NEWEST: 88% of the 1M window
  ]);
  expect(await readContextUsage(path),
    "the newest assistant turn of the current jsonl, not the compaction head or the " +
    "small first turn after it")
    .toEqual({ tokens: 880_000, model: "claude-opus-5" });
  expect(contextPct(await readContextUsage(path))).toBe(88);
});

test("a session that was compacted long ago is an ordinary session", async () => {
  /* The boundary only wins when it is the NEWER of the two. Three compactions
   * deep in a session that has been talking ever since must read as the number
   * its last turn measured, or every long session goes unreadable. */
  const path = await transcript([
    assistant({ input: 700_000 }), ...compaction(), assistant({ input: 40_000 }),
    assistant({ input: 810_000 }), ...compaction(), assistant({ input: 55_000 }),
    assistant({ input: 900_000 }), ...compaction(), assistant({ input: 120_000 }),
    assistant({ input: 171_947 }),
  ]);
  expect(contextPct(await readContextUsage(path))).toBe(17);
});

test("a compaction found only after the window grows still terminates the scan", async () => {
  /* The 256 KB first window is not the boundary's guarantee. A compact followed
   * by a long silent stretch of tool results and user records pushes it out of
   * the first slice, and the grown window must find the compaction before it
   * finds the pre-compaction turn sitting just behind it. */
  const filler = JSON.stringify({
    type: "user", uuid: "f", promptId: "p", timestamp: new Date().toISOString(),
    message: { content: "x".repeat(4000) },
  });
  const path = await transcript([
    assistant({ input: 950_000 }),
    ...compaction({ pre: 950_000 }),
    ...Array(400).fill(filler),
  ]);
  expect(await readContextUsage(path)).toBe(COMPACTED);
});

test("the window grows past a long tail of records that carry no usage", async () => {
  const filler = JSON.stringify({
    type: "user", uuid: "f", promptId: "p", timestamp: new Date().toISOString(),
    message: { content: "x".repeat(4000) },
  });
  const path = await transcript([assistant({ input: 250_000 }), ...Array(400).fill(filler)]);
  expect(await readContextUsage(path),
    "the assistant turn is ~1.6 MB from the end, well past the first 256 KB window")
    .toEqual({ tokens: 250_000, model: "claude-opus-5" });
});

test("a session with no assistant turn yet, and a file that is not there", async () => {
  const path = await transcript([JSON.stringify({ type: "mode", mode: "normal" })]);
  expect(await readContextUsage(path)).toBeNull();
  expect(await readContextUsage(join(await tmpDir("ctxprobe-"), "no-such-session.jsonl"))).toBeNull();
});

test("a SUBAGENT's fat turn does not become this session's reading, in the file", async () => {
  /* The line-level rule above, proven where it actually bites: the sidechain
   * record is the NEWEST one in the file, so a backward scan meets it first. If
   * it were counted, a session sitting at 9% would report whatever its helper
   * happened to be holding, and it would report it at the exact moment the
   * helper was busiest. */
  const path = await transcript([
    assistant({ input: 90_000 }),
    assistant({ input: 940_000, sidechain: true }),
  ]);
  expect(await readContextUsage(path)).toEqual({ tokens: 90_000, model: "claude-opus-5" });
  expect(contextPct(await readContextUsage(path))).toBe(9);
});

test("a compaction WORD inside somebody's prompt is not a compaction boundary", async () => {
  /* The `"compact_boundary"` substring is a cheap filter, not the decision: the
   * record has to be a system record of that subtype. A prompt that quotes the
   * string would otherwise terminate the scan and report COMPACTED on a session
   * that had merely been talked to about compaction. */
  const path = await transcript([
    assistant({ input: 120_000 }),
    JSON.stringify({
      type: "user", uuid: "u", promptId: "p", timestamp: new Date().toISOString(),
      message: { content: 'what does type "compact_boundary" mean in the jsonl?' },
    }),
  ]);
  expect(await readContextUsage(path)).toEqual({ tokens: 120_000, model: "claude-opus-5" });
});

test("a truncated last line does not hide the turn behind it", async () => {
  /* A poll landing mid-write sees half a record. It parses as nothing, and the
   * scan has to carry on past it rather than answering null: otherwise the
   * context bar would blank out at random on any busy session. */
  const dir = await tmpDir("ctxprobe-");
  const path = join(dir, "session.jsonl");
  await writeFile(path, assistant({ input: 77_000 }) + "\n" + assistant({ input: 5 }).slice(0, 40));
  expect(await readContextUsage(path)).toEqual({ tokens: 77_000, model: "claude-opus-5" });
});

// ----------------------------------------------------------- model (#497)
//
// The model row under the session name reads a display name the ENGINE composed.
// Two facts guard it: a claude id DERIVES its name (fail open, 2026-09-02: a
// non-derivable id is the friendly table's row or the raw id, null only when
// empty), and the name is the CURRENT model -- the newest assistant record's,
// the same one contextPct reads.

/* THE FIXTURE IDS ARE REAL, not invented (round-1 defect: a fabricated bare
 * "claude-haiku-4-5" that this box never writes hid that the map missed the id
 * it does write). Every id below was surveyed over ~/.claude/projects, and the
 * count is why it is here. */
test("a model id the engine knows becomes its display name", () => {
  // the bare 5-family / Opus 4.8 forms this box writes plain (105k, 147k, 51k…)
  expect(modelDisplayName("claude-opus-4-8")).toBe("Opus 4.8");
  expect(modelDisplayName("claude-sonnet-5")).toBe("Sonnet 5");
  expect(modelDisplayName("claude-opus-5")).toBe("Opus 5");
  expect(modelDisplayName("claude-fable-5")).toBe("Fable 5");
  // older families still present in the transcripts (opus-4-7: 7391, sonnet-4-6: 871)
  expect(modelDisplayName("claude-opus-4-7")).toBe("Opus 4.7");
  expect(modelDisplayName("claude-sonnet-4-6")).toBe("Sonnet 4.6");
});

/* THE DATED HAIKU ID THIS MACHINE ACTUALLY RUNS. 2150 records carry
 * `claude-haiku-4-5-20251001`; ZERO carry the bare `claude-haiku-4-5`. The
 * derivation strips the -YYYYMMDD pin and names the family, and the window
 * override matches the same bare family, so the dated id gets haiku's 200k. */
test("the dated haiku id this box writes resolves its name and its 200k window", () => {
  expect(modelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(contextWindowFor("claude-haiku-4-5-20251001")).toBe(200_000);
});

/* THE TWO IDS THE HAND LIST MISSED (surveyed 2026-09-02): `claude-fable-5-1`
 * (12,135 records) and `claude-opus-4-6` (1,996). Neither matched a row, so a
 * session on either showed no model name and no context button. Derived now:
 * family capitalised, version dashes turned into dots. */
test("fable 5.1 and opus 4.6 derive their names, acronyms and windows", () => {
  expect(modelDisplayName("claude-fable-5-1")).toBe("Fable 5.1");
  expect(modelAcronym("claude-fable-5-1")).toBe("F5.1");
  expect(contextPct({ tokens: 500_000, model: "claude-fable-5-1" })).toBe(50);
  expect(modelDisplayName("claude-opus-4-6")).toBe("Opus 4.6");
  expect(modelAcronym("claude-opus-4-6")).toBe("O4.6");
});

test("every claude id this box has written derives its name and acronym", () => {
  for (const [id, name, acronym] of REAL_IDS) {
    expect(modelDisplayName(id), `${id} name`).toBe(name);
    expect(modelAcronym(id), `${id} acronym`).toBe(acronym);
    expect(friendlyModelName(id), `${id} through the model-indicator plugin`).toBe(name);
    expect(contextWindowFor(id), `${id} window`).toBe(id.startsWith("claude-haiku") ? 200_000 : 1_000_000);
  }
});

/* THE 1M-CONTEXT MARKER, also real on this box: `claude-opus-4-8[1m]` (361) and
 * `claude-opus-5[1m]` (276). Same model with the 1M window on -- the NAME does
 * not change, so the bracket is stripped before the lookup. */
test("a 1m-context-marker id keeps the family's name", () => {
  expect(modelDisplayName("claude-opus-4-8[1m]")).toBe("Opus 4.8");
  expect(modelDisplayName("claude-opus-5[1m]")).toBe("Opus 5");
});

/* AND IT KEEPS THE FAMILY'S WINDOW, which is the half that was missing. The
 * name and the acronym stripped the bracket; contextWindowFor matched the raw
 * id, so every `[1m]` session on this box -- the marker's whole point being that
 * the 1M window is ON -- answered null and drew NO context bar. The one reading
 * where the window is least in doubt was the one reading that had none.
 *
 * The three lookups now share bareModelId, so they cannot drift apart again. */
test("a 1m-context-marker id keeps the family's window too", () => {
  expect(contextWindowFor("claude-opus-5[1m]")).toBe(1_000_000);
  expect(contextWindowFor("claude-opus-4-8[1m]")).toBe(1_000_000);
  expect(contextWindowFor("claude-fable-5[1m]")).toBe(1_000_000);
  expect(contextWindowFor("claude-sonnet-5[1m]")).toBe(1_000_000);
  // the acronym agrees with both, on the same id
  expect(modelAcronym("claude-opus-5[1m]")).toBe("O5");
});

/* THE MARKER WINS. `[1m]` says the 1M window is on, whatever the family, so it
 * is read before the override table: a haiku pane switched to 1M is 1M. An
 * unknown family is 1M with or without the marker (the default), and a dated
 * pin on a known family does not change its window. */
test("the [1m] marker means 1M for every family, the override included", () => {
  expect(contextWindowFor("claude-haiku-4-5[1m]")).toBe(1_000_000);
  expect(contextWindowFor("claude-neptune-9[1m]")).toBe(1_000_000);
  expect(contextWindowFor("claude-opus-5-20260101")).toBe(1_000_000);
  expect(contextWindowFor("claude-opus-5-20251001[1m]")).toBe(1_000_000);
});

test("a model whose family is unknown is still named, never null", () => {
  /* Fail open (2026-09-02): a claude id of the derivable shape gets its derived
   * name; anything else gets the friendly table's row or the raw id. Only an
   * empty id answers null. A raw id under the session name is something a
   * person can read and report; a blank is not. */
  expect(modelDisplayName("claude-neptune-9")).toBe("Neptune 9");
  expect(modelAcronym("claude-neptune-9")).toBe("N9");
  expect(modelDisplayName("gpt-5"), "a non-claude id with no table row is itself").toBe("gpt-5");
  expect(modelAcronym("gpt-5"), "and it is its own acronym").toBe("gpt-5");
  expect(modelDisplayName("gpt-5.5"), "a non-claude id with a table row").toBe("GPT-5.5");
  expect(modelAcronym("gpt-5.5")).toBe("gpt-5.5");
  expect(modelDisplayName("kimi-k3")).toBe("Kimi K3");
  expect(modelDisplayName("<synthetic>")).toBe("<synthetic>");
  expect(modelDisplayName("")).toBeNull();
  expect(modelAcronym("")).toBeNull();
});

test("non-claude ids from codex, opencode and pi are never null", () => {
  for (const id of ["gpt-5.5", "gpt-5.6-sol", "kimi-k3", "grok-4.6", "deepseek-v4-pro", "mystery-12",
    "openai/gpt-5.6-terra", "some-vendor/mystery-12"]) {
    expect(modelDisplayName(id), `${id} name`).not.toBeNull();
    expect(modelAcronym(id), `${id} acronym`).toBe(id);
    expect(friendlyModelName(id), `${id} through the plugin`).toBe(modelDisplayName(id)!);
  }
});

test("modelName over a reading: COMPACTED and null carry no model", () => {
  expect(modelName(null)).toBeNull();
  expect(modelName(COMPACTED)).toBeNull();
  expect(modelName({ tokens: 90_000, model: "claude-opus-4-8" })).toBe("Opus 4.8");
  expect(modelName({ tokens: 90_000, model: "claude-haiku-4-5-20251001" })).toBe("Haiku 4.5");
});

/* THE SHORT ACRONYM, derived beside the long name (#581): F5, O4.8, S5, H4.5,
 * exactly what the Claude status line prints under the input box. The family's
 * first letter and the version with its dashes turned into dots, off the same
 * bare-family parse as the long name, so the badge in the top bar and the model
 * row it opens onto read one fact two ways. A mutation that spelled any acronym
 * wrong turns this test RED, which is the whole point of pinning the mapping. */
test("a known model id becomes its status-line acronym", () => {
  expect(modelAcronym("claude-fable-5")).toBe("F5");
  expect(modelAcronym("claude-opus-4-8")).toBe("O4.8");
  expect(modelAcronym("claude-opus-5")).toBe("O5");
  expect(modelAcronym("claude-sonnet-5")).toBe("S5");
  expect(modelAcronym("claude-opus-4-7")).toBe("O4.7");
  expect(modelAcronym("claude-sonnet-4-6")).toBe("S4.6");
});

/* THE SAME TWO REAL SUFFIXES the long name strips -- a -YYYYMMDD pin and a
 * `[1m]` marker -- neither of which changes which model it is, so the acronym is
 * the family's whatever the suffix. The dated haiku id this box actually writes
 * is the one that matters (zero bare haiku ids exist here). */
test("the acronym strips the dated pin and the 1m marker, like the name does", () => {
  expect(modelAcronym("claude-haiku-4-5-20251001")).toBe("H4.5");
  expect(modelAcronym("claude-opus-4-8[1m]")).toBe("O4.8");
  expect(modelAcronym("claude-opus-5[1m]")).toBe("O5");
});

/* AN UNKNOWN FAMILY STILL HAS AN ACRONYM (fail open, 2026-09-02). A claude id of
 * the derivable shape gets the derived one ("claude-neptune-9" -> "N9": the same
 * spelling the status line would print for it); anything else is its own raw
 * id. Null only for an empty id, exactly where the display name is. */
test("an unknown family still has an acronym, never null", () => {
  expect(modelAcronym("claude-neptune-9")).toBe("N9");
  expect(modelAcronym("gpt-5")).toBe("gpt-5");
  expect(modelAcronym("<synthetic>")).toBe("<synthetic>");
  expect(modelAcronym("")).toBeNull();
});

/* modelIdOf is the ONE raw id both spellings derive from: COMPACTED and null
 * carry none, a reading carries its model verbatim (server maps it to the long
 * name and the acronym without re-reading the transcript). */
test("modelIdOf carries the raw id, and null for COMPACTED/none", () => {
  expect(modelIdOf(null)).toBeNull();
  expect(modelIdOf(COMPACTED)).toBeNull();
  expect(modelIdOf({ tokens: 90_000, model: "claude-opus-4-8" })).toBe("claude-opus-4-8");
});

test("the model is the NEWEST assistant turn's, read from the jsonl", async () => {
  /* Same rule as the fullness above: whichever assistant record was written last
   * is the current model. A /model switch mid-session is a newer record on a
   * different model, and the row must follow it. */
  const path = await transcript([
    assistant({ input: 10_000, model: "claude-opus-5" }),
    assistant({ input: 40_000, model: "claude-sonnet-5" }),
    assistant({ input: 90_000, model: "claude-opus-4-8" }),
  ]);
  expect(modelName(await readContextUsage(path))).toBe("Opus 4.8");
});

test("the long name, the short acronym and the plugin's name never disagree", () => {
  /* The three are spellings of ONE fact off one parse (model-names.ts). A
   * family named by one and not another is the drift this pins: the model row
   * would read "Opus 4.9" over a badge that had gone blank, or the other way
   * round. Under fail-open the only null is the empty id, from all three. */
  const ids = [
    ...REAL_IDS.map(([id]) => id),
    "claude-neptune-9", "gpt-5", "gpt-5.5", "<synthetic>", "", "claude-haiku", "claude-opus-5-turbo",
  ];
  for (const id of ids) {
    expect(modelAcronym(id) === null, `${id}: one spelling names it and the other does not`)
      .toBe(modelDisplayName(id) === null);
    expect(modelDisplayName(id) === null, `${id}: null only for an empty id`).toBe(id === "");
    if (id) expect(friendlyModelName(id), `${id}: the plugin's name is the engine's`).toBe(modelDisplayName(id)!);
  }
});

test("the two real suffixes strip together, in either combination", () => {
  /* `[1m]` is stripped first and the -YYYYMMDD pin second, so an id carrying
   * both still resolves. Neither suffix changes which model it is, which is the
   * whole reason the lookup is on the bare family. */
  expect(modelDisplayName("claude-opus-5-20251001[1m]")).toBe("Opus 5");
  expect(modelAcronym("claude-opus-5-20251001[1m]")).toBe("O5");
  expect(modelDisplayName("claude-haiku-4-5-20251001[1m]")).toBe("Haiku 4.5");
});

test("a partial family name is not a family: the derivation is anchored", () => {
  /* The parse is an anchored `claude-<family>-<numbers>`, not a prefix scan.
   * Without the anchors "claude-opus-5-turbo" would render as "Opus 5", naming
   * a model this engine has never seen after one it has, which is worse than
   * the raw id because it looks right. So these fall to the raw-id path. */
  expect(modelDisplayName("claude-opus-5-turbo")).toBe("claude-opus-5-turbo");
  expect(modelDisplayName("my-claude-opus-5")).toBe("my-claude-opus-5");
  expect(modelDisplayName("claude-opus")).toBe("claude-opus");
  expect(modelAcronym("claude-opus-5-turbo")).toBe("claude-opus-5-turbo");
  expect(modelDisplayName("")).toBeNull();
});

test("modelName and modelIdOf read the SAME reading, so they cannot disagree", () => {
  /* The server stores one raw id per session and derives both spellings from
   * it. This pins the pair on one reading: an id that carries a name must carry
   * itself, and COMPACTED/null must answer null from both. */
  const u = { tokens: 90_000, model: "claude-haiku-4-5-20251001" };
  expect(modelIdOf(u)).toBe("claude-haiku-4-5-20251001");
  expect(modelName(u)).toBe("Haiku 4.5");
  expect(modelAcronym(modelIdOf(u)!)).toBe("H4.5");
  for (const r of [null, COMPACTED] as const) {
    expect(modelIdOf(r)).toBeNull();
    expect(modelName(r)).toBeNull();
  }
});

test("a session compacted and silent since has no current model", async () => {
  /* The newest usage is behind the boundary, so there is no current model to
   * name -- the reader stops at the compaction. Harness alone until the next
   * turn, the same shape the context bar takes there. */
  const path = await transcript([
    assistant({ input: 900_000, model: "claude-opus-4-8" }),
    ...compaction({ pre: 900_000 }),
  ]);
  expect(modelName(await readContextUsage(path))).toBeNull();
});
