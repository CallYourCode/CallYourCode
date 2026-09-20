/* meta.json v2 and the one-time v1 migration (agentmeta.ts).
 *
 * The v1 fixtures below are anonymised copies of the SHAPES found in a real
 * pre-v2 data dir (110 metas, 2026-09-02): a uuid current id with pane ids
 * leaked into pastSessions by the old boot carry, a pane-shaped current id
 * ("w9:p1G", "wD:p1"), a merged record, a record with lineage (one real one,
 * ag-coHgn7cXRB2lw8_u, keeps "w3:p1" in its lineage: defect C), and 43 with
 * no chat at all. The id grammars themselves are ids.test.ts. Nothing here reads a real data dir; the proof against the
 * read-only copy of a live one is a separate manual run, recorded in the
 * lane report.
 *
 *   bun test src/runtime/agentmeta.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpDataDir } from "../test-utils/tmp.ts";
import { migrateAgentMeta, parseAgentMeta, loadAgentMetas, saveAgentMeta,
  mintAgentId, type AgentMeta } from "./agentmeta.ts";

const U1 = "6f1c2b3a-9d8e-4f70-a1b2-c3d4e5f60718";
const U2 = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b"; // codex-style UUIDv7
const U3 = "b7e9f0a1-2c3d-4e5f-9a8b-7c6d5e4f3a2b";
const OC = "ses_7f3a2b1c9d8e0f4a5b6c7d";

describe("migrateAgentMeta", () => {
  const aid = "ag-AAAAAAAAAAAAAAAA";

  test("a v2 record passes through untouched with no changes", () => {
    const meta: AgentMeta = { v: 2, agentId: aid, sessionId: U1, pastSessions: [U2], harness: "claude", cwd: "/w" };
    const mig = migrateAgentMeta(meta)!;
    expect(mig.changes).toEqual([]);
    expect(mig.meta).toEqual(meta);
  });

  test("v1 with a uuid current id keeps it and strips pane ids from pastSessions", () => {
    const v1 = { v: 1, agentId: aid, sessionId: U1, pastSessions: ["w7:p1", U2, "w7:p1", U3, "%3~4711~99"],
      name: "planner", chats: [{ id: "c1", createdAt: 1 }], chat: "c1", read: { heardTs: 1, doneSeq: 2, seenDoneSeq: 2 } };
    const mig = migrateAgentMeta(v1)!;
    expect(mig.meta).toEqual({ v: 2, agentId: aid, sessionId: U1, pastSessions: [U2, U3],
      name: "planner", chats: [{ id: "c1", createdAt: 1 }], chat: "c1", read: { heardTs: 1, doneSeq: 2, seenDoneSeq: 2 } });
    expect(mig.changes).toContain("v: 1 -> 2");
    expect(mig.changes.some((c) => c.startsWith("pastSessions: dropped") && c.includes("w7:p1"))).toBe(true);
  });

  test("v1 with a pane-shaped current id gets sessionId null; past uuids survive", () => {
    for (const pane of ["w9:p1G", "wD:p1", "%5"]) {
      const mig = migrateAgentMeta({ v: 1, agentId: aid, sessionId: pane, pastSessions: [U1] })!;
      expect(mig.meta.sessionId).toBeNull();
      expect(mig.meta.pastSessions).toEqual([U1]);
      expect(mig.changes.some((c) => c.startsWith("sessionId:"))).toBe(true);
    }
  });

  test("pastSessions that end up empty is removed rather than left as []", () => {
    const mig = migrateAgentMeta({ v: 1, agentId: aid, sessionId: U1, pastSessions: ["w1:p1"] })!;
    expect("pastSessions" in mig.meta).toBe(false);
  });

  test("a past id equal to the current id collapses into the current one", () => {
    const mig = migrateAgentMeta({ v: 1, agentId: aid, sessionId: U1, pastSessions: [U1, U2] })!;
    expect(mig.meta.pastSessions).toEqual([U2]);
  });

  test("mergedInto and lineage ride through; the reserved keys field is dropped", () => {
    const mig = migrateAgentMeta({ v: 1, agentId: aid, sessionId: U1, mergedInto: "ag-BBBBBBBBBBBBBBBB",
      lineage: [U2], keys: { x: 1 } })!;
    expect(mig.meta.mergedInto).toBe("ag-BBBBBBBBBBBBBBBB");
    expect(mig.meta.lineage).toEqual([U2]);
    expect("keys" in mig.meta).toBe(false);
    expect(mig.changes).toContain("keys: dropped");
  });

  test("a pane id in the lineage is stripped too, the rest of the chain kept in order (defect C)", () => {
    // the real record ag-coHgn7cXRB2lw8_u: lineage ["w3:p1", <uuid>]
    const mig = migrateAgentMeta({ v: 1, agentId: aid, sessionId: U1, lineage: ["w3:p1", U2] })!;
    expect(mig.meta.lineage).toEqual([U2]);
    expect(mig.changes).toContain("lineage: dropped w3:p1");
    // a lineage that is nothing but pane ids goes away rather than staying []
    const only = migrateAgentMeta({ v: 1, agentId: aid, sessionId: U1, lineage: ["w3:p1", "%3"] })!;
    expect("lineage" in only.meta).toBe(false);
    // and a lineage's order is its meaning: a repeated uuid is not collapsed
    const dup = migrateAgentMeta({ v: 1, agentId: aid, sessionId: U1, lineage: [U2, U3, U2] })!;
    expect(dup.meta.lineage).toEqual([U2, U3, U2]);
  });

  test("a v2 record with a pane id left in any id field is cleaned and reported, not passed through", () => {
    const mig = migrateAgentMeta({ v: 2, agentId: aid, sessionId: "w3:p1", pastSessions: [U2, "wD:p1"],
      lineage: ["w3:p1", U3], harness: "claude" })!;
    expect(mig.meta).toEqual({ v: 2, agentId: aid, sessionId: null, pastSessions: [U2], lineage: [U3], harness: "claude" });
    expect(mig.changes).toEqual([
      'sessionId: "w3:p1" -> null (not a harness id)', "pastSessions: dropped wD:p1", "lineage: dropped w3:p1"]);
    expect(parseAgentMeta(mig.meta), "what comes out parses strictly").not.toBeNull();
  });

  test("a v1 record with no chat (43 of 110 in the live copy) still migrates", () => {
    const mig = migrateAgentMeta({ v: 1, agentId: aid, sessionId: "w3:p2" })!;
    expect(mig.meta).toEqual({ v: 2, agentId: aid, sessionId: null });
  });

  test("neither v1 nor v2, or a bad identity, is refused", () => {
    expect(migrateAgentMeta({ v: 3, agentId: aid, sessionId: U1 })).toBeNull();
    expect(migrateAgentMeta({ v: 1, agentId: "nope", sessionId: U1 })).toBeNull();
    expect(migrateAgentMeta({ v: 1, agentId: aid, sessionId: "" })).toBeNull();
    expect(migrateAgentMeta(null)).toBeNull();
    expect(migrateAgentMeta("x")).toBeNull();
  });
});

describe("parseAgentMeta (v2)", () => {
  const aid = "ag-AAAAAAAAAAAAAAAA";
  test("accepts a null sessionId and refuses an empty, missing or non-string one", () => {
    expect(parseAgentMeta({ v: 2, agentId: aid, sessionId: null })).not.toBeNull();
    expect(parseAgentMeta({ v: 2, agentId: aid, sessionId: "" })).toBeNull();
    expect(parseAgentMeta({ v: 2, agentId: aid })).toBeNull();
    expect(parseAgentMeta({ v: 2, agentId: aid, sessionId: 7 })).toBeNull();
    expect(parseAgentMeta({ v: 2, agentId: aid, sessionId: U1, pastSessions: "x" })).toBeNull();
    expect(parseAgentMeta({ v: 2, agentId: aid, sessionId: U1, lineage: "x" })).toBeNull();
  });
  test("refuses a pane-shaped (or any non-harness) id in sessionId, pastSessions or lineage (defect B)", () => {
    const ok = { v: 2, agentId: aid, sessionId: U1, pastSessions: [U2, OC], lineage: [U3] };
    expect(parseAgentMeta(ok)).not.toBeNull();
    for (const pane of ["w3:p1", "w9:p1G", "%3", "%3~4711~1700000000", "herdr:w3:p1", "tmux:%3", "red:p1"]) {
      expect(parseAgentMeta({ ...ok, sessionId: pane }), `sessionId ${pane}`).toBeNull();
      expect(parseAgentMeta({ ...ok, pastSessions: [U2, pane] }), `pastSessions ${pane}`).toBeNull();
      expect(parseAgentMeta({ ...ok, lineage: [pane, U3] }), `lineage ${pane}`).toBeNull();
    }
  });
  test("refuses v1", () => {
    expect(parseAgentMeta({ v: 1, agentId: aid, sessionId: U1 })).toBeNull();
  });
});

describe("loadAgentMetas migrates v1 on disk exactly once", () => {
  let prev: string | undefined;
  let data = "";
  beforeEach(async () => {
    prev = process.env.CYC_DATA_DIR;
    ({ data } = await tmpDataDir("cyc-meta-"));
    process.env.CYC_DATA_DIR = data;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CYC_DATA_DIR;
    else process.env.CYC_DATA_DIR = prev;
  });

  async function put(agentId: string, body: unknown): Promise<void> {
    await mkdir(join(data, "agents", agentId), { recursive: true });
    await writeFile(join(data, "agents", agentId, "meta.json"), JSON.stringify(body, null, 2) + "\n");
  }

  test("v1 records are rewritten as v2, reported once, and read back silently after", async () => {
    const a = mintAgentId(), b = mintAgentId(), c = mintAgentId(), d = mintAgentId();
    await put(a, { v: 1, agentId: a, sessionId: U1, pastSessions: ["w7:p1", U2], name: "a" });
    await put(b, { v: 1, agentId: b, sessionId: "w9:p1G", pastSessions: [U3, "wD:p1"] });
    await put(c, { v: 2, agentId: c, sessionId: OC, harness: "opencode" });
    await put(d, { v: 1, agentId: d, sessionId: U3, mergedInto: b });
    // the real ag-coHgn7cXRB2lw8_u shape (defect C): a lineage pane id, on a v1 and on a v2 record
    const e = mintAgentId(), f = mintAgentId();
    await put(e, { v: 1, agentId: e, sessionId: U1, lineage: ["w3:p1", U2] });
    await put(f, { v: 2, agentId: f, sessionId: U2, lineage: ["w3:p1", U3], harness: "claude" });
    await mkdir(join(data, "agents", mintAgentId()), { recursive: true }); // no meta.json: skipped
    await mkdir(join(data, "agents", "not-ours"), { recursive: true }); // not an agent id: ignored

    const bad: string[] = [];
    const migrated: Record<string, string[]> = {};
    const first = await loadAgentMetas((id, why) => bad.push(`${id}:${why}`), (id, ch) => { migrated[id] = ch; });
    expect(first.size).toBe(6);
    expect(Object.keys(migrated).sort()).toEqual([a, b, d, e, f].sort());
    expect(bad.length).toBe(1);
    expect(bad[0]).toEndWith(":no meta.json");
    expect(first.get(a)).toEqual({ v: 2, agentId: a, sessionId: U1, pastSessions: [U2], name: "a" });
    expect(first.get(b)).toEqual({ v: 2, agentId: b, sessionId: null, pastSessions: [U3] });
    expect(first.get(c)).toEqual({ v: 2, agentId: c, sessionId: OC, harness: "opencode" });
    expect(first.get(d)).toEqual({ v: 2, agentId: d, sessionId: U3, mergedInto: b });
    expect(first.get(e)).toEqual({ v: 2, agentId: e, sessionId: U1, lineage: [U2] });
    expect(first.get(f)).toEqual({ v: 2, agentId: f, sessionId: U2, lineage: [U3], harness: "claude" });
    expect(migrated[f]).toEqual(["lineage: dropped w3:p1"]);

    // on disk now: v2 and strict, so the second load migrates nothing
    for (const id of [a, b, d, e, f]) {
      const onDisk = await Bun.file(join(data, "agents", id, "meta.json")).json();
      expect(onDisk.v).toBe(2);
      expect(onDisk).toEqual(first.get(id));
    }
    const again: string[] = [];
    const second = await loadAgentMetas(() => {}, (id) => again.push(id));
    expect(again).toEqual([]);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  test("a record naming another agent, or of an unknown version, is reported and skipped", async () => {
    const a = mintAgentId(), b = mintAgentId();
    await put(a, { v: 1, agentId: b, sessionId: U1 });
    await put(b, { v: 9, agentId: b, sessionId: U1 });
    const bad: string[] = [];
    const out = await loadAgentMetas((id, why) => bad.push(`${id}:${why}`));
    expect(out.size).toBe(0);
    expect(bad).toContain(`${a}:meta names ${b}`);
    expect(bad).toContain(`${b}:meta.json is not a v1 or v2 agent record`);
  });

  test("saveAgentMeta writes the v2 record that parses back identically", async () => {
    const a = mintAgentId();
    const meta: AgentMeta = { v: 2, agentId: a, harness: "codex", cwd: "/w", sessionId: U2, pastSessions: [U1] };
    await saveAgentMeta(meta);
    const out = await loadAgentMetas();
    expect(out.get(a)).toEqual(meta);
  });

  test("a CYC_DATA_DIR swap mid-write cannot move a record: every path is resolved before the first await (defect A)", async () => {
    /* The seam rig swaps the env at stop() while a debounced save may still
     * be in flight; with the dir resolved before the await and the file after
     * it, meta.json landed under the NEW root (the user's real
     * ~/.callyourcode, 2026-09-02). saveAgentMeta and the migration
     * write-back in loadAgentMetas both resolve their paths up front. */
    const { data: other } = await tmpDataDir("cyc-meta-other-");
    const a = mintAgentId();
    const meta: AgentMeta = { v: 2, agentId: a, sessionId: U1 };
    const inFlight = saveAgentMeta(meta); // resolves its paths synchronously, before its first await
    process.env.CYC_DATA_DIR = other;
    await inFlight;
    expect(await Bun.file(join(data, "agents", a, "meta.json")).exists(), "the record is under the root of the call").toBe(true);
    expect(await Bun.file(join(other, "agents", a, "meta.json")).exists(), "and not under the root the env named later").toBe(false);

    // the migration write-back, same shape: a v1 record read under one root is written back under that root
    process.env.CYC_DATA_DIR = data;
    const b = mintAgentId();
    await put(b, { v: 1, agentId: b, sessionId: U2, pastSessions: ["w7:p1"] });
    const loading = loadAgentMetas();
    process.env.CYC_DATA_DIR = other;
    const out = await loading;
    expect(out.get(b)?.v).toBe(2);
    expect((await Bun.file(join(data, "agents", b, "meta.json")).json()).v).toBe(2);
    expect(await Bun.file(join(other, "agents", b, "meta.json")).exists()).toBe(false);
  });
});
