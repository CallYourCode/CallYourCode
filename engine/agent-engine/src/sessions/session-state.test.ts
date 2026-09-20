/* THE ONE PER-SESSION RECORD (session-state.ts, blueprint 4d).
 *
 * Boot used to re-explode meta.json into eight session-keyed maps plus a carry
 * map, and a rekey hand-moved every one of them; forgetting one was a silent
 * wrong answer (a name that survived a roll while its voice did not). Now there
 * is ONE SessionState per AGENT id: load folds every meta field into it,
 * buildAgentMeta is the inverse of that fold, purge is one delete, and the
 * metaSavesReady gate parks saves until the composition root flips it. A
 * harness session id reaches the record only through the session index
 * (agentIdFor), which is the one place a session id is looked up at all.
 *
 * PURE UNIT: a throwaway data dir, no engine, no sockets, no boot. CYC_DATA_DIR
 * is set once at file scope and restored in afterAll; session-state.ts resolves
 * its paths per call, so nothing here fights module-load order. The module is a
 * SINGLETON, so every test starts from resetForTest() plus an empty agents/ dir
 * -- otherwise test two would load test one's metas on top of its own.
 *
 *   bun test agent-engine/src/sessions/session-state.test.ts
 */

import { expect, test, beforeEach, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as S from "./session-state.ts";
import type { AgentMeta } from "../runtime/agentmeta.ts";
import { tmpDataDir } from "../test-utils/tmp.ts";
import { seedAgent as seedAgentMeta, readAgentMetas } from "../test-utils/builders.ts";
import { until } from "../test-utils/wait.ts";

/* FILE-SCOPE ENV, restored in afterAll. `root` is the harness-shaped tmp dir
 * the shared builders speak (data lives at <root>/data), so this file seeds and
 * reads agent metas through the same helpers every other data-dir test uses. */
const REAL_DATA_DIR = process.env.CYC_DATA_DIR;
const { root, data } = await tmpDataDir("cyc-sstate-");
process.env.CYC_DATA_DIR = data;
afterAll(() => {
  if (REAL_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = REAL_DATA_DIR;
});

/* The three things the composition root injects. Counted rather than ignored:
 * a broadcast that stops happening is how two devices drift apart, and it is
 * invisible unless something is watching for it. */
let broadcasts = 0;
let minted: string[] = [];
let lineages: Record<string, string[]> = {};
const deps: S.SessionStateDeps = {
  noteMinted: (u) => { minted.push(u); },
  broadcastSessions: () => { broadcasts++; },
  lineageOf: (id) => lineages[id],
};

beforeEach(async () => {
  S.resetForTest();
  // an empty tree, so one test's metas can never be another's restored state
  await rm(join(data, "agents"), { recursive: true, force: true });
  await rm(join(data, "state"), { recursive: true, force: true });
  await rm(join(data, "settings.json"), { force: true });
  broadcasts = 0;
  minted = [];
  lineages = {};
});

/* Harness-shaped session ids: the index (buildSessionIndex) places nothing
 * else, so a record's ids here look like what claude and codex write. */
const S1 = "1a1a1a1a-0000-4000-8000-000000000001";
const S0 = "1a1a1a1a-0000-4000-8000-000000000000";
const SA = "5a5a5a5a-0000-4000-8000-00000000000a";
const SB = "5a5a5a5a-0000-4000-8000-00000000000b";
const SC = "5a5a5a5a-0000-4000-8000-00000000000c";
const SX = "5a5a5a5a-0000-4000-8000-00000000000e";
const SY = "5a5a5a5a-0000-4000-8000-00000000000f";
const CUR_A = "c0c0c0c0-0000-4000-8000-0000000000a0";
const CUR_B = "c0c0c0c0-0000-4000-8000-0000000000b0";
const PAST_A1 = "c0c0c0c0-0000-4000-8000-0000000000a1";
const PAST_A2 = "c0c0c0c0-0000-4000-8000-0000000000a2";
const LIN_A1 = "c0c0c0c0-0000-4000-8000-0000000000a9";
const GOOD = "600d600d-0000-4000-8000-000000000000";
const NEVER = "0e0e0e0e-0000-4000-8000-0000000000ff";

/** Seed one agent's meta.json under this file's data dir. */
const seed = (sessionId: string, meta: Record<string, unknown> = {}, msgs: Record<string, unknown>[] = []) =>
  seedAgentMeta(root, sessionId, msgs, meta as never);

/** A live Session, only the fields this module reads. */
const live = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, agentId: id, agent: { id: "claude" }, cwd: "", heardTs: 0, doneSeq: 0, seenDoneSeq: 0,
    notified: false, filedTs: 0, chat: [], ...over }) as never;

// ------------------------------------------------------------------ the fold

test("load folds every persisted per-session fact into the ONE record", async () => {
  const { agentId } = await seed(S1, {
    agentId: "ag-one11111111111",
    name: "My Chat", voice: "bf_emma",
    photo: { file: "p.jpg", mime: "image/jpeg", ts: 5 },
    settings: { muted: true },
    read: { heardTs: 100, doneSeq: 3, seenDoneSeq: 2, notified: true, filedTs: 90 },
  });
  await S.loadSessionState(deps);
  expect(S.agentIdFor(S1), "the session id reaches the record through the index").toBe(agentId);
  expect(S.nameOverrideOf(agentId)).toBe("My Chat");
  expect(S.voiceOverrideOf(agentId)).toBe("bf_emma");
  expect(S.photoRecOf(agentId)).toEqual({ file: "p.jpg", mime: "image/jpeg", ts: 5 });
  expect(S.settingsOf(agentId)).toEqual({ muted: true });
  expect(S.restoredHeardOf(agentId)).toBe(100);
  expect(S.restoredSeenOf(agentId)).toEqual({ doneSeq: 3, seenDoneSeq: 2 });
  expect(S.restoredNotifiedOf(agentId)).toBe(true);
  expect(S.restoredFiledOf(agentId)).toBe(90);
  expect(S.hasSessionState(S1), "nothing is keyed by the session id itself").toBe(false);
});

test("the fold TYPE-CHECKS every field: a meta written wrong restores nothing wrong", async () => {
  /* meta.json is written by this engine, but it is also a file on disk that an
   * older build, a half-finished write or a person can leave in a shape this
   * build does not expect. Each field is taken only when it is the right type,
   * so a junk photo record cannot become a photo the app then tries to fetch. */
  const { agentId: a } = await seed(S1, {
    agentId: "ag-two22222222222",
    photo: { file: "", mime: "image/jpeg", ts: 5 },     // no filename: not a photo
    settings: { muted: "yes", notify: false },            // muted is not a boolean
    read: { heardTs: "later", doneSeq: 3, seenDoneSeq: 1, notified: "true", filedTs: 0 },
  });
  await S.loadSessionState(deps);
  expect(S.photoRecOf(a)).toBeUndefined();
  expect(S.settingsOf(a), "only the field that type-checked survives").toEqual({ notify: false });
  expect(S.restoredHeardOf(a), "a non-numeric marker is no marker").toBeUndefined();
  expect(S.restoredNotifiedOf(a), "notified is a boolean, and only `true` counts").toBeUndefined();
  expect(S.restoredFiledOf(a), "filedTs 0 is 'never filed', not a filing at the epoch").toBeUndefined();
  expect(S.restoredSeenOf(a), "the seen pair is still readable").toEqual({ doneSeq: 3, seenDoneSeq: 1 });
});

test("a meta that is not a v1 or v2 agent record is skipped, and boot carries on", async () => {
  /* ONE CORRUPT AGENT MUST NOT TAKE THE FLEET DOWN AT BOOT. The bad dirs are
   * reported and skipped; the good one still restores, which is the difference
   * between a broken row and a dead engine. */
  await seed(GOOD, { agentId: "ag-good1111111111", name: "Still here" });
  await mkdir(join(data, "agents", "ag-nometa11111111"), { recursive: true });
  await mkdir(join(data, "agents", "ag-badjson111111"), { recursive: true });
  await writeFile(join(data, "agents", "ag-badjson111111", "meta.json"), "{not json");
  await mkdir(join(data, "agents", "ag-wrongv11111111"), { recursive: true });
  await writeFile(join(data, "agents", "ag-wrongv11111111", "meta.json"),
    JSON.stringify({ v: 3, agentId: "ag-wrongv11111111", sessionId: "x" }));
  // a directory we did not mint is left alone entirely, not reported as bad
  await mkdir(join(data, "agents", "not-ours"), { recursive: true });

  const said: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => { said.push(a.join(" ")); };
  try {
    await S.loadSessionState(deps);
  } finally {
    console.error = err;
  }
  expect(S.nameOverrideOf("ag-good1111111111")).toBe("Still here");
  expect(S.agentMetas.size, "exactly the one readable agent").toBe(1);
  expect(said.filter((l) => l.includes("skipped")).length).toBe(3);
  expect(said.some((l) => l.includes("not-ours")), "a foreign directory is not our business").toBe(false);
});

test("an agent merged into another is not restored as a session of its own", async () => {
  /* An absorb retires an agent record and points it at the survivor. If the
   * retired one were loaded it would appear as a second row for one
   * conversation, and its stale sessionId would claim the key. Its session
   * ids index to the survivor instead (the mergedInto chain is followed). */
  await seed(S1, { agentId: "ag-live111111111", name: "The survivor" });
  await seed(S0, { agentId: "ag-dead111111111", name: "The retired one", mergedInto: "ag-live111111111" });
  await S.loadSessionState(deps);
  expect(S.agentMetas.has("ag-dead111111111")).toBe(false);
  expect(S.agentIdFor(S1)).toBe("ag-live111111111");
  expect(S.agentIdFor(S0), "the retired record's id resolves to the survivor").toBe("ag-live111111111");
  expect(S.nameOverrideOf("ag-live111111111")).toBe("The survivor");
  expect(S.hasSessionState("ag-dead111111111")).toBe(false);
});

test("the session index covers the current id, every past id and the lineage", async () => {
  /* The index is what an announce is looked up in. An id missing from it is a
   * conversation that mints a second agent on `claude --resume`: the row the
   * user named and read for a month goes dead and a nameless twin appears. */
  const { agentId: a } = await seed(CUR_A, { agentId: "ag-idx1111111111",
    pastSessions: [PAST_A1, PAST_A2], lineage: [LIN_A1] });
  const { agentId: b } = await seed(CUR_B, { agentId: "ag-idx2222222222" });
  await S.loadSessionState(deps);
  for (const id of [CUR_A, PAST_A1, PAST_A2, LIN_A1]) expect(S.agentIdFor(id), id).toBe(a);
  expect(S.agentIdFor(CUR_B)).toBe(b);
  expect(S.sessionIndex.size).toBe(5);
  expect(S.agentIdFor(NEVER), "an unknown id is answered as itself, never minted").toBe(NEVER);
  expect(S.agentMetas.size, "a lookup mints nothing").toBe(2);
});

test("the session index places harness-shaped ids only: a pane id in a record is not a key (defect B)", async () => {
  /* buildSessionIndex is pure, so the shapes are handed to it straight: a
   * record that still carries a pane id (the v1 leak) in any of the three id
   * fields must not make that pane resolve to the old agent, whatever else
   * the record says. Whole-meta shapes, including the tmux and prefixed
   * spellings and an opencode id that must pass. */
  const OC = "ses_7f3a2b1c9d8e0f4a5b6c7d";
  const all = new Map<string, AgentMeta>([
    ["ag-idx1111111111", { v: 2, agentId: "ag-idx1111111111", sessionId: "w3:p1",
      pastSessions: ["%3", "%3~4711~1700000000", PAST_A1], lineage: ["herdr:w3:p1", "tmux:%3", LIN_A1] }],
    ["ag-idx2222222222", { v: 2, agentId: "ag-idx2222222222", sessionId: OC, pastSessions: ["red:p1", "blue:p1"] }],
  ]);
  const idx = S.buildSessionIndex(all);
  expect([...idx.keys()].sort()).toEqual([PAST_A1, LIN_A1, OC].sort());
  expect(idx.get(PAST_A1)).toBe("ag-idx1111111111");
  expect(idx.get(LIN_A1)).toBe("ag-idx1111111111");
  expect(idx.get(OC)).toBe("ag-idx2222222222");
  for (const pane of ["w3:p1", "%3", "%3~4711~1700000000", "herdr:w3:p1", "tmux:%3", "red:p1", "blue:p1"]) {
    expect(idx.has(pane), pane).toBe(false);
  }
});

test("a mergedInto chain is followed to the last survivor, and a cycle does not hang boot", async () => {
  await seed(SA, { agentId: "ag-chainA11111111", mergedInto: "ag-chainB11111111" });
  await seed(SB, { agentId: "ag-chainB11111111", mergedInto: "ag-chainC11111111" });
  await seed(SC, { agentId: "ag-chainC11111111" });
  await seed(SX, { agentId: "ag-cycleX11111111", mergedInto: "ag-cycleY11111111" });
  await seed(SY, { agentId: "ag-cycleY11111111", mergedInto: "ag-cycleX11111111" });
  const err = console.error;
  console.error = () => {};
  try {
    await S.loadSessionState(deps);
  } finally {
    console.error = err;
  }
  for (const id of [SA, SB, SC]) expect(S.agentIdFor(id), id).toBe("ag-chainC11111111");
  expect([...S.agentMetas.keys()], "only the survivor is a row; the cycle is nobody's").toEqual(["ag-chainC11111111"]);
  expect(S.agentIdFor(SX), "a cycle indexes to nothing").toBe(SX);
});

test("load replays the chat logs and rebuilds the blob index off them", async () => {
  /* The blob index is a LOCATION index: it is what turns a docId or an uploadId
   * in an old message into the agent directory holding the bytes. It is rebuilt
   * from the logs at boot, so a restart must not lose the ability to serve an
   * attachment sent last week. */
  await seed(S1, { agentId: "ag-blob1111111111" }, [
    { id: "m1", role: "user", text: "here", ts: 10, msgId: "msg-1",
      upload: { uploadId: "up-1", name: "a.png", mime: "image/png" } },
    { id: "m2", role: "claude", text: "got it", ts: 20, file: { docId: "doc-1", name: "d.md" } },
  ]);
  await S.loadSessionState(deps);
  expect(S.restoredChats.get("ag-blob1111111111")?.length, "the log is restored under the agent id").toBe(2);
  expect(S.restoredChats.has(S1)).toBe(false);
  expect(S.blobOwner.get("msg-1")).toBe("ag-blob1111111111");
  expect(S.blobOwner.get("up-1")).toBe("ag-blob1111111111");
  expect(S.blobOwner.get("doc-1")).toBe("ag-blob1111111111");
  expect(minted, "an adopted upload is still one this engine minted").toContain("up-1");
  expect(S.docDirsOf("doc-1")?.docDir).toContain("ag-blob1111111111");
  expect(S.docDirsOf("doc-never-seen"), "an unknown id is a plain not-found").toBeNull();
});

test("load restores the engine-level settings: the host voice and the manual order", async () => {
  await writeFile(join(data, "settings.json"),
    JSON.stringify({ v: 2, defaultVoice: "am_onyx", order: ["b", "a"], somethingNewer: 7 }));
  await S.loadSessionState(deps);
  expect(S.globalVoice()).toBe("am_onyx");
  expect(S.getManualOrder()).toEqual(["b", "a"]);
});

test("load restores the v2 pane bindings, alive flag and all, and drops the v1 shape", async () => {
  /* The binding is how an unannounced pane keeps its agent across an engine
   * restart within one mux epoch, and `alive:false` is the discriminator that
   * stops a stranger inheriting a pane's history. Restoring it as true would
   * hand the next session on that pane somebody else's chat. A v1 entry
   * ({uuid}) named a session id, which is not an agent: it is dropped, not
   * guessed at. */
  await mkdir(join(data, "state"), { recursive: true });
  await writeFile(join(data, "state", "pane-bindings.json"), JSON.stringify({
    "w1:p1": { agentId: "ag-live111111111", sessionId: "uuid-live", cwd: "/w", alive: true, ts: 111 },
    "w1:p2": { agentId: "ag-gone111111111", sessionId: null, cwd: "", alive: false, ts: 222 },
    "w1:p3": { nonsense: true },
    "w1:p4": { uuid: "uuid-v1", alive: true, ts: 333 },
  }));
  await S.loadSessionState(deps);
  expect(S.paneBindings.get("w1:p1")).toEqual({ agentId: "ag-live111111111", sessionId: "uuid-live", cwd: "/w", alive: true, ts: 111 });
  expect(S.paneBindings.get("w1:p2")?.alive).toBe(false);
  expect(S.paneBindings.has("w1:p3"), "a binding with no agent is not a binding").toBe(false);
  expect(S.paneBindings.has("w1:p4"), "a v1 {uuid} binding is dropped").toBe(false);
});

test("a corrupt pane-bindings file with no backup is loud, not silent, and boots empty", async () => {
  /* A truncated write here re-keys every idle unannounced pane as a blank
   * twin (2026-09-06). The saver is atomic now, so this should never happen;
   * if it somehow does, the journal must say so instead of shrugging. */
  await mkdir(join(data, "state"), { recursive: true });
  await writeFile(join(data, "state", "pane-bindings.json"), '{"w1:p1":{"agentId":"ag-tru');
  const errs: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a); };
  try {
    await S.loadSessionState(deps);
  } finally {
    console.error = orig;
  }
  expect(S.paneBindings.size).toBe(0);
  expect(errs.some((a) => String(a[0]).includes("pane-bindings.json unreadable"))).toBe(true);
  expect(errs.some((a) => String(a[0]).includes("no backup"))).toBe(true);
});

test("a corrupt pane-bindings file salvages the last good boot's backup", async () => {
  await mkdir(join(data, "state"), { recursive: true });
  await writeFile(join(data, "state", "pane-bindings.json"), '{"w1:p1":{"agentId":"ag-tru');
  await writeFile(join(data, "state", "pane-bindings.json.bak"), JSON.stringify({
    "w1:p1": { agentId: "ag-good11111111", sessionId: null, cwd: "/w", alive: true, ts: 5 },
  }));
  const orig = console.error;
  console.error = () => {};
  try {
    await S.loadSessionState(deps);
  } finally {
    console.error = orig;
  }
  expect(S.paneBindings.get("w1:p1")?.agentId).toBe("ag-good11111111");
});

test("a clean load refreshes the backup with the same snapshot", async () => {
  await mkdir(join(data, "state"), { recursive: true });
  const snapshot = JSON.stringify({
    "w2:p1": { agentId: "ag-snap11111111", sessionId: null, cwd: "/s", alive: true, ts: 9 },
  });
  await writeFile(join(data, "state", "pane-bindings.json"), snapshot);
  await S.loadSessionState(deps);
  await new Promise((r) => setTimeout(r, 30));
  const bak = await Bun.file(join(data, "state", "pane-bindings.json.bak")).text();
  expect(JSON.parse(bak)["w2:p1"].agentId).toBe("ag-snap11111111");
});

test("savePaneBindings survives a burst: the file on disk always parses to the latest state", async () => {
  await S.loadSessionState(deps);
  for (let i = 0; i < 5; i++) {
    S.paneBindings.set("w9:p1", { agentId: `ag-burst${i}1111111`, sessionId: null, cwd: "/b", alive: true, ts: i });
    S.savePaneBindings();
  }
  // the busy/again pair coalesces the burst into a trailing atomic write
  await new Promise((r) => setTimeout(r, 50));
  const onDisk = JSON.parse(await Bun.file(join(data, "state", "pane-bindings.json")).text());
  expect(onDisk["w9:p1"].agentId).toBe("ag-burst41111111");
});

test("load with no data dir contents at all is a clean first boot", async () => {
  await S.loadSessionState(deps);
  expect(S.agentMetas.size).toBe(0);
  expect(S.restoredChats.size).toBe(0);
  expect(S.paneBindings.size).toBe(0);
  expect(S.globalVoice()).toBe("");
  expect(S.getManualOrder()).toEqual([]);
});

// ---------------------------------------------------------- the inverse fold

const A = "ag-one11111111111";

test("buildAgentMeta is the inverse of the fold (no live session)", async () => {
  await seed(S1, { agentId: A });
  await S.loadSessionState(deps);
  S.setNameOverride(A, "Named");
  S.setVoiceOverride(A, "am_onyx");
  S.applySessionSettings(A, { notify: false });
  const meta = S.metaFor(A);
  S.buildAgentMeta(meta);
  expect(meta.name).toBe("Named");
  expect(meta.voice).toBe("am_onyx");
  expect(meta.settings).toEqual({ notify: false });
  expect(meta.sessionId, "the fold never touches the identity fields").toBe(S1);
  // clearing removes the key rather than writing a husk
  S.setNameOverride(A, null);
  S.applySessionSettings(A, { notify: null });
  S.buildAgentMeta(meta);
  expect(meta.name).toBeUndefined();
  expect(meta.settings).toBeUndefined();
});

test("buildAgentMeta anchors harness and cwd from the live row once, and never rewrites them", async () => {
  await seed(S1, { agentId: A });
  await S.loadSessionState(deps);
  S.sessions.set(A, live(A, { agent: { id: "codex" }, cwd: "/first" }));
  const meta = S.metaFor(A);
  S.buildAgentMeta(meta);
  expect(meta.harness).toBe("codex");
  expect(meta.cwd).toBe("/first");
  S.sessions.set(A, live(A, { agent: { id: "codex" }, cwd: "/moved" }));
  S.buildAgentMeta(meta);
  expect(meta.cwd, "the birth cwd is a fact about the agent, not about today's pane").toBe("/first");
});

test("buildAgentMeta prefers the LIVE session's read state and writes its zeros", async () => {
  await seed(S1, { agentId: A, read: { heardTs: 5, doneSeq: 1, seenDoneSeq: 1 } });
  await S.loadSessionState(deps);
  S.sessions.set(A, live(A, { heardTs: 200, doneSeq: 7, seenDoneSeq: 6, notified: true, filedTs: 150 }));
  const meta = S.metaFor(A);
  S.buildAgentMeta(meta);
  expect(meta.read).toEqual({ heardTs: 200, doneSeq: 7, seenDoneSeq: 6, notified: true, filedTs: 150 });
});

test("a live session's FALSE notified and ZERO filedTs are absences, not fields", async () => {
  /* The two flags are written only when they are true, so a chat that has been
   * read and un-filed does not carry a `notified:false` husk forward. What
   * matters on the read side is that a restart sees no notification standing
   * and nothing filed, which is what those absences mean. */
  await seed(S1, { agentId: A });
  await S.loadSessionState(deps);
  S.sessions.set(A, live(A, { heardTs: 0, doneSeq: 0, seenDoneSeq: 0 }));
  const meta = S.metaFor(A);
  S.buildAgentMeta(meta);
  expect(meta.read).toEqual({ heardTs: 0, doneSeq: 0, seenDoneSeq: 0 });
});

test("with NO live session and nothing remembered, `read` is dropped rather than zeroed", async () => {
  /* Writing {heardTs:0,...} for a session nobody has ever read would be a
   * marker at the epoch, and the next boot would take it as a real one: the
   * first-sight seeding branch would be skipped and a waiting backlog would
   * quietly read as unread for ever. */
  await seed(S1, { agentId: A, read: { heardTs: 42, doneSeq: 0, seenDoneSeq: 0 } });
  await S.loadSessionState(deps);
  const meta = S.metaFor(A);
  S.buildAgentMeta(meta);
  expect(meta.read, "the remembered marker is written back").toEqual({ heardTs: 42, doneSeq: 0, seenDoneSeq: 0 });

  S.purgeSessionState(A);
  S.buildAgentMeta(meta);
  expect(meta.read, "nothing known: the key goes, it is not written as zero").toBeUndefined();
});

test("buildAgentMeta carries the lineage from the injected reader, and drops an empty one", async () => {
  /* lineage lives in L3 and is injected so this module stays inward-facing. An
   * empty list is written as no key, so an agent that never rolled does not
   * carry an empty array in its record for ever. */
  await seed(S1, { agentId: A });
  await S.loadSessionState(deps);
  lineages[A] = ["uuid-a", "uuid-b"];
  const meta = S.metaFor(A);
  S.buildAgentMeta(meta);
  expect(meta.lineage).toEqual(["uuid-a", "uuid-b"]);
  lineages[A] = [];
  S.buildAgentMeta(meta);
  expect(meta.lineage).toBeUndefined();
});

// -------------------------------------------------------- display choices

test("the settings patch MERGES, and null means 'follow the global' again", async () => {
  await S.loadSessionState(deps);
  S.applySessionSettings(S1, { muted: true });
  expect(S.settingsOf(S1)).toEqual({ muted: true });
  S.applySessionSettings(S1, { notify: false });
  expect(S.settingsOf(S1), "the second patch must not replace the first").toEqual({ muted: true, notify: false });
  S.applySessionSettings(S1, { muted: null });
  expect(S.settingsOf(S1)).toEqual({ notify: false });
  // the last key clearing removes the record's settings entirely
  S.applySessionSettings(S1, { notify: null });
  expect(S.settingsOf(S1)).toEqual({});
  expect(S.sessionStateProbe(S1).sessionSettings).toBe(false);
  expect(broadcasts, "every change moves the other devices in the same breath").toBe(4);
});

test("a session with no settings answers an empty object, never undefined", async () => {
  await S.loadSessionState(deps);
  expect(S.settingsOf("never-seen")).toEqual({});
});

test("the voice override beats the host default", async () => {
  /* The host default is an ENGINE setting (#584) and the per-session choice is
   * agent data. Empty string at both levels means "let the voice engine pick",
   * which has to come out as undefined rather than as "". */
  await S.loadSessionState(deps);
  expect(S.voiceFor(S1)).toBeUndefined();
  S.setDefaultVoice("am_host");
  expect(S.voiceFor(S1)).toBe("am_host");
  S.setVoiceOverride(S1, "bf_emma");
  expect(S.voiceFor(S1)).toBe("bf_emma");
  S.setVoiceOverride(S1, "");
  expect(S.voiceOverrideOf(S1), "clearing removes the key rather than storing ''").toBeUndefined();
  expect(S.voiceFor(S1)).toBe("am_host");
});

test("the photo's wire path is null when there is none, and versioned when there is", async () => {
  /* null rather than absent, so a REMOVED photo can arrive on the wire and the
   * app can take the old face down. The ?v= is the record's ts: a replaced
   * photo has a new url, so no device serves the previous one from cache. */
  await S.loadSessionState(deps);
  expect(S.photoOf(S1)).toBeNull();
  S.setPhotoRec(S1, { file: "p.jpg", mime: "image/jpeg", ts: 77 });
  expect(S.photoOf(S1)).toBe(`/session-photo/${S1}?v=77`);
  S.setPhotoRec(S1, null);
  expect(S.photoOf(S1)).toBeNull();
  // a session id with url characters in it is encoded, not concatenated
  S.setPhotoRec("w1:p1", { file: "p.jpg", mime: "image/jpeg", ts: 1 });
  expect(S.photoOf("w1:p1")).toBe("/session-photo/w1%3Ap1?v=1");
});

test("the photo and doc directories hang off the session's own agent", async () => {
  const { agentId: aid } = await seed(S1, { agentId: A });
  await S.loadSessionState(deps);
  expect(S.photoDirFor(S1), "a session id reaches the agent's dir through the index").toContain(`/agents/${aid}/photos`);
  expect(S.thumbDirFor(S1)).toContain(`/agents/${aid}/photos/thumbs`);
  expect(S.photoDirFor(aid)).toBe(S.photoDirFor(S1));
  expect(S.docDirFor(aid), "the trailing slash is how docstate.ts concatenates").toEndWith("/");
  expect(S.docStateDirFor(aid)).toEndWith("/");
  expect(S.docStateDirFor(aid), "his work is deliberately NOT in the docs dir")
    .not.toBe(S.docDirFor(aid));
});

// ------------------------------------------------------------------- purge

const B1 = { agentId: A, sessionId: S1, cwd: "/w" };

test("purgeSessionState: one delete clears the record, the chats and the binding", async () => {
  await S.loadSessionState(deps);
  S.setNameOverride(A, "X");
  S.restoredChats.set(A, []);
  S.recordBinding("w1:p1", B1);
  S.purgeSessionState(A, "w1:p1");
  expect(S.hasSessionState(A)).toBe(false);
  expect(S.restoredChats.has(A)).toBe(false);
  expect(S.paneBindings.has("w1:p1")).toBe(false);
});

test("purge without a pane id leaves other panes' bindings alone", async () => {
  await S.loadSessionState(deps);
  S.recordBinding("w1:p1", B1);
  S.recordBinding("w1:p2", { agentId: "ag-two22222222222", sessionId: "s2", cwd: "/w" });
  S.purgeSessionState(A);
  expect(S.paneBindings.size, "a purge is about a session, not about every pane").toBe(2);
});

test("sessionStateProbe answers for every key the record can hold", async () => {
  const { agentId: a } = await seedRead(S1, { heardTs: 5, seen: { doneSeq: 1, seenDoneSeq: 1 }, notified: true, filedTs: 9 });
  await S.loadSessionState(deps);
  const empty = S.sessionStateProbe("nothing");
  expect(Object.values(empty).every((v) => v === false), "an unknown id is all false").toBe(true);
  S.setNameOverride(a, "n");
  S.setVoiceOverride(a, "v");
  S.setPhotoRec(a, { file: "p.jpg", mime: "image/jpeg", ts: 1 });
  S.applySessionSettings(a, { muted: true });
  expect(S.sessionStateProbe(a)).toEqual({
    restoredHeardTs: true, restoredSeen: true, restoredNotified: true, restoredFiledTs: true,
    sessionSettings: true, nameOverrides: true, voiceOverrides: true, sessionPhotos: true,
  });
});

// ------------------------------------------------------------ pane bindings

test("recordBinding writes only when something CHANGED, and death is recorded", async () => {
  /* Every write is a file rewrite, and the reconcile loop calls this on every
   * poll for every pane. An unconditional write would be a disk write per pane
   * per second for a fact that has not moved. */
  await S.loadSessionState(deps);
  S.recordBinding("w1:p1", B1);
  const first = S.paneBindings.get("w1:p1")!;
  expect(first).toEqual({ ...B1, alive: true, ts: expect.any(Number) });
  S.recordBinding("w1:p1", { ...B1 });
  expect(S.paneBindings.get("w1:p1"), "the same live binding again is the same object").toBe(first);
  S.markBindingDead("w1:p1");
  expect(S.paneBindings.get("w1:p1")!.alive).toBe(false);
  // a rolled session id on the same agent is a change worth writing
  S.recordBinding("w1:p1", { ...B1, sessionId: "s2" });
  expect(S.paneBindings.get("w1:p1")).toMatchObject({ agentId: A, sessionId: "s2", alive: true });
  // and re-binding a pane whose agent died marks it live again
  S.markBindingDead("w1:p1");
  S.markBindingDead("w1:p1"); // a second death is not a second write
  S.recordBinding("w1:p1", { ...B1, sessionId: "s2" });
  expect(S.paneBindings.get("w1:p1")!.alive).toBe(true);
});

test("adoptAgentId binds a pre-minted id to a pane, and never steals a live pane", async () => {
  await S.loadSessionState(deps);
  const fresh = S.freshAgentId();
  S.adoptAgentId("w1:p1", fresh);
  expect(S.bindingOf("w1:p1")).toMatchObject({ agentId: fresh, sessionId: null, alive: true });
  expect(S.agentMetas.get(fresh), "the mint is a record now, not yet on disk").toEqual({ v: 2, agentId: fresh, sessionId: null });
  S.adoptAgentId("w1:p1", "ag-other111111111");
  expect(S.bindingOf("w1:p1")!.agentId, "a live pane keeps its agent").toBe(fresh);
  S.markBindingDead("w1:p1");
  S.adoptAgentId("w1:p1", "ag-other111111111");
  expect(S.bindingOf("w1:p1")!.agentId, "a dead one can be re-bound").toBe("ag-other111111111");
});

// ------------------------------------------------------------- agent records

test("agentIdFor never mints: an unknown key is answered as itself", async () => {
  /* Minting on lookup was how a nameless agent record appeared for every
   * pane id, uuid and typo that anything ever looked up. reconcile is the one
   * minter (freshAgentId), and only for a pane it has resolved to nobody. */
  await S.loadSessionState(deps);
  expect(S.agentIdFor(NEVER)).toBe(NEVER);
  expect(S.agentMetas.size).toBe(0);
  const { agentId } = await seed(S1, { agentId: A });
  await S.loadSessionState(deps);
  expect(S.agentIdFor(S1)).toBe(agentId);
  expect(S.agentIdFor(agentId), "an agent id is its own answer").toBe(agentId);
});

test("freshAgentId never hands out an id a record or a row already holds", async () => {
  /* The agent id is the identity that outlives the pane id and the harness
   * uuid. Two conversations on one id would merge their chat logs, photos and
   * read markers into one directory, and nothing downstream could unpick it. */
  await S.loadSessionState(deps);
  const ids = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const id = S.freshAgentId();
    expect(id).toMatch(/^ag-[A-Za-z0-9_-]{16}$/);
    expect(S.agentMetas.has(id), "a mint is not a record until reconcile makes it one").toBe(false);
    S.metaFor(id);
    ids.add(id);
  }
  expect(ids.size).toBe(50);
  expect(S.agentMetas.size).toBe(50);
});

test("metaFor mints an in-memory record with no session id for an agent nobody has seen", async () => {
  await S.loadSessionState(deps);
  const meta = S.metaFor(A);
  expect(meta).toEqual({ v: 2, agentId: A, sessionId: null });
  expect(S.metaFor(A), "the same record, not a second one").toBe(meta);
  expect(S.sessionIndex.size, "a record with no session id indexes nothing").toBe(0);
});

test("chatRefFor mints the chat file id once and records it in the meta", async () => {
  /* The chat id is minted on the FIRST line. Minting a second one would split
   * one conversation across two files, and the second boot would replay only
   * whichever the meta happened to point at. */
  await S.loadSessionState(deps);
  const first = S.chatRefFor(A);
  expect(first.aid).toBe(A);
  expect(first.chatId.length).toBeGreaterThan(0);
  expect(S.chatRefFor(A)).toEqual(first);
  const meta = S.metaFor(A);
  expect(meta.chat).toBe(first.chatId);
  expect(meta.chats).toEqual([{ id: first.chatId, createdAt: expect.any(Number) }]);
});

// ------------------------------------------------------------- the boot gate

test("the meta-save gate parks saves until the root flips it, then flushes once", async () => {
  const { agentId } = await seed(S1, { agentId: A });
  await S.loadSessionState(deps);
  S.setNameOverride(agentId, "Early"); // parked: gate not flipped yet
  const metaPath = join(data, "agents", agentId, "meta.json");
  const before = JSON.parse(await Bun.file(metaPath).text());
  expect(before.name).toBeUndefined();
  S.sessionStateReady();
  // the debounce is a real 150ms timer in this module, so this waits on real
  // I/O rather than on logical time: poll the file the save lands in
  await until(async () => JSON.parse(await Bun.file(metaPath).text()).name === "Early",
    { what: "the parked save to reach meta.json" });
  const after = JSON.parse(await Bun.file(metaPath).text());
  expect(after.name).toBe("Early");
});

test("a burst of changes is ONE write, and the whole record lands", async () => {
  /* The debounce exists because a rename plus a voice pick plus a settings
   * toggle arrive within the same second. What must not happen is the burst
   * landing as three writes, or the last one winning and the first two being
   * lost because each save copies the record whole. */
  const { agentId } = await seed(S1, { agentId: "ag-burst11111111" });
  await S.loadSessionState(deps);
  S.sessionStateReady();
  S.setNameOverride(agentId, "One");
  S.setVoiceOverride(agentId, "bf_emma");
  S.applySessionSettings(agentId, { muted: true });
  S.setNameOverride(agentId, "Two");
  const metaPath = join(data, "agents", agentId, "meta.json");
  await until(async () => JSON.parse(await Bun.file(metaPath).text()).name === "Two",
    { what: "the debounced save" });
  const meta = JSON.parse(await Bun.file(metaPath).text());
  expect(meta.name).toBe("Two");
  expect(meta.voice, "an earlier change in the burst must not be lost").toBe("bf_emma");
  expect(meta.settings).toEqual({ muted: true });
});

test("flushAgentSave writes NOW, which is what an adopt needs", async () => {
  /* A restart right after a roll must find the NEW session id on disk. Waiting
   * out a debounce is exactly the window in which the process can go away, so
   * adoptSession flushes rather than schedules, and the flush cancels the armed
   * timer so the same record is not written twice. */
  const { agentId } = await seed(S1, { agentId: "ag-flush11111111" });
  await S.loadSessionState(deps);
  S.sessionStateReady();
  S.setNameOverride(agentId, "Renamed"); // arms the debounce
  S.flushAgentSave(agentId);
  await until(async () => JSON.parse(await Bun.file(join(data, "agents", agentId, "meta.json")).text()).name === "Renamed",
    { what: "the immediate flush" });
  const metas = await readAgentMetas(root);
  expect(metas.get(agentId)?.name).toBe("Renamed");
});

test("a save requested before the gate flips is remembered, not dropped", async () => {
  /* Boot reads a chat log, seeds a read marker and names an agent, all before
   * the composition root is finished. Dropping those saves would lose the
   * change itself. */
  const { agentId: aid } = await seed(S1, { agentId: A });
  await S.loadSessionState(deps);
  await rm(join(data, "agents", aid, "meta.json"));
  S.setNameOverride(aid, "Parked"); // while the gate is shut
  expect(await Bun.file(join(data, "agents", aid, "meta.json")).exists(),
    "nothing may reach disk before the root says so").toBe(false);
  S.sessionStateReady();
  await until(() => Bun.file(join(data, "agents", aid, "meta.json")).exists(),
    { what: "the parked save to be persisted" });
  const metas = await readAgentMetas(root);
  expect(metas.get(aid)?.sessionId).toBe(S1);
  expect(metas.get(aid)?.name).toBe("Parked");
});

test("a record with no session id and no chat is never written: no nameless agent dirs", async () => {
  /* The 43-of-110 empty records in the live v1 copy were exactly this: an
   * in-memory mint that reached disk before anything was said or announced.
   * A save for such a record is a no-op until it has a session id or a chat. */
  await S.loadSessionState(deps);
  S.sessionStateReady();
  const fresh = S.freshAgentId();
  S.metaFor(fresh);
  S.setNameOverride(fresh, "Named too early");
  S.flushAgentSave(fresh);
  await new Promise((r) => setTimeout(r, 200));
  expect(await Bun.file(join(data, "agents", fresh, "meta.json")).exists()).toBe(false);
  // the first chat line makes it persistable
  S.chatRefFor(fresh);
  S.flushAgentSave(fresh);
  await until(() => Bun.file(join(data, "agents", fresh, "meta.json")).exists(), { what: "the record with a chat" });
});

// ------------------------------------------------------------ the read seed

test("heardTsFor seeds the marker from the restored tail exactly once", async () => {
  await S.loadSessionState(deps);
  S.restoredChats.set("p1", [{ id: "p1", role: "claude", text: "x", ts: 777 } as never]);
  expect(S.heardTsFor(undefined, "p1")).toBe(777); // first sight: backlog is read
  expect(S.restoredHeardOf("p1")).toBe(777);       // and remembered in the record
  expect(S.heardTsFor(undefined, "p1")).toBe(777); // second ask: the remembered value
  expect(S.heardTsFor(live("p1", { heardTs: 900 }), "p1")).toBe(900); // live wins
});

test("the seed is remembered even when it is ZERO, so a backlog is not re-read", async () => {
  /* A session with no restored chat seeds 0. If 0 were treated as "no answer"
   * the first-sight branch would run again on the NEXT boot, and by then the
   * session would have messages -- so a waiting backlog would be marked read by
   * the seeding rule rather than by him. Deciding and remembering are one step. */
  await S.loadSessionState(deps);
  expect(S.heardTsFor(undefined, "p1")).toBe(0);
  expect(S.restoredHeardOf("p1"), "0 is a remembered answer, not an absent one").toBe(0);
  expect(S.sessionStateProbe("p1").restoredHeardTs).toBe(true);
  // a chat arriving afterwards must NOT re-seed the marker to its tail
  S.restoredChats.set("p1", [{ id: "m", role: "claude", text: "x", ts: 500 } as never]);
  expect(S.heardTsFor(undefined, "p1")).toBe(0);
});

test("a marker restored from disk beats the tail seed", async () => {
  // reading survives a restart: the persisted marker is the answer, and the
  // backlog above it stays unread exactly as he left it
  const { agentId: a } = await seed(S1, { agentId: "ag-seed11111111", read: { heardTs: 200, doneSeq: 0, seenDoneSeq: 0 } });
  await S.loadSessionState(deps);
  S.restoredChats.set(a, [{ id: "m", role: "claude", text: "x", ts: 900 } as never]);
  expect(S.heardTsFor(undefined, a)).toBe(200);
});

/* Seed a restored READ record for `id`. There is no public setter for that half
 * of the record (it is written by the boot fold and by heardTsFor), so it is
 * seeded the way production produces it: a meta.json on disk, then one load. */
let seedNo = 0;
const seedRead = (id: string, read: {
  heardTs?: number; seen?: { doneSeq: number; seenDoneSeq: number }; notified?: boolean; filedTs?: number;
}) => seed(id, {
  agentId: `ag-read${String(++seedNo).padStart(10, "0")}`,
  read: {
    heardTs: read.heardTs ?? 0,
    doneSeq: read.seen?.doneSeq ?? 0,
    seenDoneSeq: read.seen?.seenDoneSeq ?? 0,
    ...(read.notified ? { notified: true } : {}),
    ...(read.filedTs ? { filedTs: read.filedTs } : {}),
  },
});
