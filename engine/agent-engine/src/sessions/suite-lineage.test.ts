/* LANE A, CONTRACT 5: content lineage.
 *
 * A conversation outlives the harness session that served it, and the harness
 * records no link between the two transcripts. cyc proves the link FROM CONTENT
 * (lineage.ts): the chat log holds the exact words of the gap, and the
 * predecessor transcript contains those same words. The proven predecessor id
 * is cached in the agent's meta and fed into the session index, so a pane that
 * later reports that predecessor id resolves to its agent -- even though the
 * session id changed.
 *
 * Two halves:
 *   A. the PROOF mechanism (lineage.ts:predecessorsOf): a distinctive-probe
 *      match names the right sibling transcript and NOT a stranger's. Proven
 *      once -- the probe match is text-in-jsonl and harness-agnostic -- driven
 *      through the injected streamLines seam with real sibling files.
 *   B. the RESOLUTION (buildSessionIndex + reconcile rule 2): an agent whose
 *      meta names a predecessor resolves a pane reporting that predecessor id
 *      to itself, carrying the conversation. Proven for every mux x harness,
 *      the id shape each cell's own.
 *
 *   bun test agent-engine/src/sessions/suite-lineage.test.ts
 */

import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MATRIX, sid, muxGuessRef, announcedRef, paneFor, CWD, mountReconcile } from "../test-utils/suite-matrix.ts";
import {
  initLineage, predecessorsOf, addLineage, lineageOf, resetForTest as resetLineage,
} from "./lineage.ts";
import { seedAgent } from "../test-utils/builders.ts";

const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const REAL_GRACE = process.env.CYC_ANNOUNCE_GRACE_MS;
const rig = await mountReconcile("cyc-suite-lineage-");
afterAll(() => {
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
  if (REAL_GRACE === undefined) delete process.env.CYC_ANNOUNCE_GRACE_MS;
  else process.env.CYC_ANNOUNCE_GRACE_MS = REAL_GRACE;
});
beforeEach(async () => { await rig.resetPerTest(); resetLineage(); });

/* ------------------------------------------------- A. the proof mechanism */

/** streamLines that reads a real file line by line, the shape lineage.ts's
 *  sibling walk drives its jsonl reading through (the adapter owns the read). */
const streamLines = async (path: string, onLine: (line: string) => void) => {
  const f = Bun.file(path);
  if (!(await f.exists())) return;
  for (const line of (await f.text()).split("\n")) if (line) onLine(line);
};

test("CONTRACT 5 proof: a distinctive-probe match names the predecessor, never a stranger", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-suite-lineage-proof-"));
  const PRED = "a1111111-1111-4111-8111-000000000001"; // the predecessor transcript
  const CUR = "a2222222-2222-4222-8222-000000000002";  // this agent's current one
  const STRANGER = "a3333333-3333-4333-8333-000000000003"; // an unrelated sibling

  // the gap conversation: messages distinctive enough (>45 chars) that finding
  // them in a transcript proves that transcript served this chat
  const gap = [
    "The rendering pipeline drops the alpha channel on the second compositing pass",
    "We measured a thirty percent regression on the cold-start path after the merge",
    "The retry window has to be aligned to the wall clock or two engines double-send",
    "Session identity is proven from content, never guessed from a folder timestamp",
    "The delivery guard refuses a truncated screen because half a chooser still parses",
    "A nested claude announce inherits the parent pane witnesses and must be stripped",
  ];
  const chat = gap.map((text, i) => ({ id: "x", role: i % 2 ? "claude" : "user", text, ts: 1000 + i } as any));

  // the predecessor transcript holds those exact words; the stranger does not
  await writeFile(join(dir, `${PRED}.jsonl`), gap.map((t) => JSON.stringify({ text: t })).join("\n") + "\n");
  await writeFile(join(dir, `${STRANGER}.jsonl`),
    ["nothing here matches", "an entirely different conversation about lunch"].map((t) => JSON.stringify({ text: t })).join("\n") + "\n");
  await writeFile(join(dir, `${CUR}.jsonl`), "{}\n"); // own file, skipped by name

  const log: Array<{ event: string; fields: Record<string, unknown> }> = [];
  initLineage({ scheduleAgentSave: () => {}, log: (event, fields) => log.push({ event, fields }), streamLines }, []);

  const found = await predecessorsOf(
    { id: "ag-lineageproof00001", harnessSessionId: CUR, chat },
    join(dir, `${CUR}.jsonl`), 5000);

  expect(found, "the predecessor is proven, the stranger is not").toEqual([PRED]);
  expect(lineageOf("ag-lineageproof00001")).toEqual([PRED]);
});

test("CONTRACT 5 proof: an explicit harness-named predecessor is recorded without a content proof", async () => {
  // a claude fork's parent, codex forked_from_id, pi previousSessionFile: the
  // harness SAID so, so lineage is recorded directly (addLineage), idempotent.
  initLineage({ scheduleAgentSave: () => {}, log: () => {}, streamLines }, []);
  const A = "ag-lineagenamed000001";
  const PRED = "b1111111-1111-4111-8111-000000000001";
  addLineage(A, PRED);
  addLineage(A, PRED); // idempotent
  expect(lineageOf(A)).toEqual([PRED]);
});

/* --------------------------------------- B. the predecessor id resolves */

for (const cell of MATRIX) {
  const tag = `${cell.mux} x ${cell.harness}`;
  const reportRef = (id: string) => muxGuessRef(cell, id) ?? announcedRef(id);

  test(`[${tag}] CONTRACT 5: a pane reporting a proven predecessor id resolves to its agent`, async () => {
    const CUR = sid(cell.harness, 2);
    const PRED = sid(cell.harness, 1);
    // an agent that CONTINUED from PRED into CUR, with the gap conversation on
    // disk and PRED named in its lineage (as the proof in half A would leave it)
    const { agentId } = await seedAgent(rig.seedRoot(), CUR,
      [{ id: "r", role: "user", text: "the words that carried across the roll", ts: 1 }],
      { cwd: CWD, lineage: [PRED], harness: cell.harness });
    await rig.boot();
    // buildSessionIndex placed PRED -> agent at boot from the lineage
    expect(rig.S.agentIdFor(PRED), "the predecessor id names the agent in the index").toBe(agentId);

    // a pane now reports the PREDECESSOR id (a renamed/forked transcript whose
    // id changed): it resolves to the SAME agent, conversation intact
    rig.reconcile([paneFor(cell, "w1:p1", reportRef(PRED))]);
    const row = rig.rowOn("w1:p1");
    expect(row.agentId, "content lineage resolves the predecessor to its agent").toBe(agentId);
    // the conversation came back (a rollover divider may join it: the agent
    // went back to its predecessor session, which is a roll it announces)
    expect(row.chat.filter((m) => m.kind !== "system").map((m) => m.text))
      .toEqual(["the words that carried across the roll"]);
    expect(rig.S.sessions.size, "one row, never a stray second agent").toBe(1);
  });
}
