/* The BOOT GATE for the marker backfill (server.ts). The sweep rewrites live
 * chat logs, so it must stay OFF unless the operator opts in with the exact
 * string CYC_BACKFILL_MARKERS="1". This proves the gate the wiring uses: with
 * the flag unset (or anything but "1") the real runBackfillSweep is never
 * invoked -- nothing is read, nothing is remembered; with "1" it runs and the
 * records land. Fixtures on disk, never a host chatlog.
 *
 *   HOME=<fake> bun test agent-engine/src/runtime/backfill-gate.test.ts
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { streamLinesForward } from "../sessions/session-events.ts";
import { initChatlog, resetForTest as resetChatlog } from "../chat/chatlog.ts";
import {
  runBackfillSweep, type BackfillSource, type MetaLike, type SweepCandidate,
} from "../chat/backfill.ts";

// The exact predicate server.ts gates the sweep on. Kept here as the one thing
// under test so the assertion is the wiring's own condition, not a paraphrase.
const backfillEnabled = (env: NodeJS.ProcessEnv) => env.CYC_BACKFILL_MARKERS === "1";

// A fixture transcript + a real forward reader (the one production uses).
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cyc-gate-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// A chatlog wired to a fixture sink -- logSession runs during a backfill and
// must never touch a host log. Only what it persisted is collected.
beforeEach(() => {
  initChatlog({
    chatOf: () => undefined,
    restoredChats: () => new Map(),
    persistPatch: () => {},
    broadcast: () => {},
    chatRefFor: (id) => ({ aid: id, chatId: "c1" }),
    indexMsgBlobs: () => {},
    appendMsg: () => {},
    appendRec: () => {},
    sendSessionRec: () => {},
  });
});
afterEach(() => resetChatlog());

function transcript(name: string, lines: string[]): string {
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}
const iso = (ms: number) => new Date(ms).toISOString();
const promptLine = (ms: number, text: string) =>
  JSON.stringify({ type: "user", uuid: `u-${ms}`, timestamp: iso(ms), promptId: `p-${ms}`, message: { content: text } });
const replyLine = (ms: number, text: string) =>
  JSON.stringify({ type: "assistant", uuid: `a-${ms}`, timestamp: iso(ms), message: { content: [{ type: "text", text }] } });

async function streamLines(path: string, onLine: (line: string) => void): Promise<void> {
  const f = Bun.file(path);
  if (!(await f.exists())) return;
  await streamLinesForward(f, 0, f.size, (line) => onLine(line));
}

/* Model server.ts' wiring exactly: only when the flag gates open do we build a
 * candidate and invoke the REAL sweep. Returns what was written to the (fixture)
 * log sink, plus whether the sweep ran at all. A spy on `candidates` proves the
 * gate short-circuits before any disk read when the flag is off. */
async function bootBackfill(env: NodeJS.ProcessEnv, path: string) {
  const remembered: Record<string, number> = {};
  let sweepInvoked = false;
  let candidatesRead = false;

  if (backfillEnabled(env)) {
    await runBackfillSweep({
      candidates: () => {
        candidatesRead = true;
        sweepInvoked = true;
        const cands: SweepCandidate[] = [
          { id: "ag-old", meta: { agentId: "ag-old", sessionId: "s1" }, chat: [] },
        ];
        return cands;
      },
      resolve: (meta: MetaLike): BackfillSource[] =>
        meta.sessionId === "s1" ? [{ harness: "claude", sid: "s1", path }] : [],
      streamLines,
      rememberLog: (id, log) => { remembered[id] = log.length; },
    });
  }
  return { remembered, sweepInvoked, candidatesRead };
}

describe("the boot gate for the marker backfill", () => {
  let path: string;
  beforeEach(() => {
    path = transcript("s1", [promptLine(10, "an old question here"), replyLine(11, "an old answer")]);
  });

  test("flag unset: the sweep is never invoked and nothing is written", async () => {
    const r = await bootBackfill({}, path);
    expect(r.sweepInvoked).toBe(false);
    expect(r.candidatesRead).toBe(false); // short-circuits before any disk read
    expect(r.remembered).toEqual({});
  });

  test('flag "1": the sweep runs and the records land', async () => {
    const r = await bootBackfill({ CYC_BACKFILL_MARKERS: "1" }, path);
    expect(r.sweepInvoked).toBe(true);
    expect(r.remembered).toEqual({ "ag-old": 2 }); // prompt + reply
  });

  test('flag "0": treated as off, no sweep', async () => {
    const r = await bootBackfill({ CYC_BACKFILL_MARKERS: "0" }, path);
    expect(r.sweepInvoked).toBe(false);
    expect(r.remembered).toEqual({});
  });

  test('flag "true": only the exact string "1" opts in, so no sweep', async () => {
    const r = await bootBackfill({ CYC_BACKFILL_MARKERS: "true" }, path);
    expect(r.sweepInvoked).toBe(false);
    expect(r.remembered).toEqual({});
  });

  test('flag empty string: off, no sweep', async () => {
    const r = await bootBackfill({ CYC_BACKFILL_MARKERS: "" }, path);
    expect(r.sweepInvoked).toBe(false);
    expect(r.remembered).toEqual({});
  });
});
