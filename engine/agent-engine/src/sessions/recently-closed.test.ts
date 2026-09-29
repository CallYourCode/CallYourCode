/* THE + MENU'S "RECENTLY CLOSED" LIST, and reopening one of its rows.
 *
 * Closing a chat closes the pane but the agent's meta.json survives on disk, so
 * an agent this engine owns can be reopened under its OLD identity (name, photo,
 * chat history), optionally resuming its conversation. Two seams here:
 *
 *   GET  /agents/recently-closed  -> the newest few dead agents, live excluded
 *   POST /new-session {agentId,resume} -> the launch command for a reopen
 *
 * Driven against the REAL route table over wireCore's FakeHerdr, the same rig
 * newsession.test.ts uses. Nothing creates a real tab or session.
 *
 *   bun test agent-engine/src/sessions/recently-closed.test.ts
 */

import { test, expect, afterEach, spyOn } from "bun:test";
import { utimes } from "node:fs/promises";

import { sessionOpsRoutes, isMuxUnreachableError } from "../routes/session-ops.ts";
import { wireCore, type WireCore } from "../test-utils/wire-core.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { HARNESS_CWD } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { agentMetas, sessions } from "./session-state.ts";
import { saveAgentMeta, type AgentMeta } from "../runtime/agentmeta.ts";
import { agentMetaFile } from "../storage/datadir.ts";

let core: WireCore | null = null;
let http: ServedRoutes | null = null;
const myIds = new Set<string>(); // fixtures this test added, to sweep on teardown
const myLive = new Set<string>();

afterEach(async () => {
  http?.stop();
  http = null;
  await core?.stop();
  core = null;
  for (const id of myIds) agentMetas.delete(id);
  for (const id of myLive) sessions.delete(id);
  myIds.clear();
  myLive.clear();
});

async function routed(): Promise<{ c: WireCore; http: ServedRoutes }> {
  core = await wireCore({ with: ["delivery"] });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  http = serveRoutes({
    groups: [sessionOpsRoutes],
    ctx: {
      adapter: core.adapter,
      claudeCommand: core.adapter.launchCommand("claude")!,
      engineHome: "/tmp/does-not-exist-home",
      engineRepo: "/tmp/engine-checkout",
      // the reopen path always probes the resolved program on PATH; every
      // harness this test names is treated as installed.
      binaryOnPath: () => true,
    },
  });
  return { c: core, http };
}

/* Seed one dead agent: both the in-memory map the route reads and the meta.json
 * on disk the route stats for its mtime. `mtimeMs` pins the sort order. */
async function seedDead(meta: Omit<AgentMeta, "v">, mtimeMs: number): Promise<void> {
  const full: AgentMeta = { v: 2, ...meta };
  agentMetas.set(full.agentId, full);
  myIds.add(full.agentId);
  await saveAgentMeta(full);
  const secs = mtimeMs / 1000;
  await utimes(agentMetaFile(full.agentId), secs, secs);
}

const AG = (n: number) => `ag-recentclosed${String(n).padStart(4, "0")}`.slice(0, 19);
const UUID = "11111111-1111-1111-1111-111111111111";

test("recently-closed returns the newest five dead agents, live excluded, by mtime", async () => {
  const { http: h } = await routed();
  const base = Date.now();
  // six dead, ascending mtime, so the NEWEST five are 5,4,3,2,1 (0 falls off)
  for (let i = 0; i <= 5; i++) {
    await seedDead(
      { agentId: AG(i), name: `Agent ${i}`, harness: "claude", cwd: `/w/proj-${i}`, sessionId: UUID },
      base + i * 1000
    );
  }
  // one MORE dead-by-mtime agent that is actually LIVE: it must be excluded even
  // though its mtime is the newest of all.
  const liveId = AG(9);
  await seedDead(
    { agentId: liveId, name: "Live", harness: "claude", cwd: "/w/live", sessionId: UUID },
    base + 99_000
  );
  sessions.set(liveId, { alive: true } as never);
  myLive.add(liveId);

  const res = await h.get("/agents/recently-closed");
  expect(res.status).toBe(200);
  const rows = (await res.json()) as Array<{
    agentId: string; name: string; harness: string; cwd: string; canResume: boolean;
  }>;
  const mine = rows.filter((r) => myIds.has(r.agentId));
  // newest first, five at most, the live one nowhere in it
  expect(mine.map((r) => r.agentId)).toEqual([AG(5), AG(4), AG(3), AG(2), AG(1)]);
  expect(rows.some((r) => r.agentId === liveId), "a live agent is not 'closed'").toBe(false);
  // the shape each row carries
  expect(mine[0]).toEqual({
    agentId: AG(5), name: "Agent 5", harness: "claude", cwd: "/w/proj-5", canResume: true,
  });
  // five at most overall
  expect(rows.length).toBeLessThanOrEqual(5);
});

test("canResume is false for a meta with no session id", async () => {
  const { http: h } = await routed();
  await seedDead(
    { agentId: AG(1), name: "NoSid", harness: "claude", cwd: "/w/nosid", sessionId: null },
    Date.now() + 5_000
  );
  const rows = (await h.get("/agents/recently-closed").then((r) => r.json())) as Array<{
    agentId: string; canResume: boolean;
  }>;
  expect(rows.find((r) => r.agentId === AG(1))?.canResume).toBe(false);
});

/* ------------------------------------------------- reopen: the launch command */

async function reopen(h: ServedRoutes, agentId: string, resume: boolean): Promise<Response> {
  return h.post("/new-session", { agentId, resume });
}

test("reopen with resume replays the harness --resume verb AND the CYC_AGENT_ID", async () => {
  const { c, http: h } = await routed();
  await seedDead(
    { agentId: AG(1), name: "Ada", harness: "claude", cwd: HARNESS_CWD, sessionId: UUID },
    Date.now()
  );
  const res = await reopen(h, AG(1), true);
  const body = (await res.json()) as { ok: boolean; paneId?: string; agentId?: string };
  expect(body.ok, JSON.stringify(body)).toBe(true);
  expect(body.agentId, "reopened UNDER THE OLD id, so name/photo/chat survive").toBe(AG(1));
  const typed = c.herdr.texts.find((t) => t.paneId === body.paneId)?.text ?? "";
  expect(typed).toContain(`CYC_AGENT_ID=${AG(1)}`);
  expect(typed, "the claude --resume verb onto the stored session id").toContain(`--resume ${UUID}`);
});

test("reopen per harness carries the resume verb (codex, opencode)", async () => {
  for (const [harness, needle] of [["codex", "resume"], ["opencode", "--session"]] as const) {
    const { c, http: h } = await routed();
    await seedDead(
      { agentId: AG(1), name: harness, harness, cwd: HARNESS_CWD, sessionId: UUID },
      Date.now()
    );
    const body = (await reopen(h, AG(1), true).then((r) => r.json())) as { ok: boolean; paneId?: string };
    expect(body.ok).toBe(true);
    const typed = c.herdr.texts.find((t) => t.paneId === body.paneId)?.text ?? "";
    expect(typed).toContain(`CYC_AGENT_ID=${AG(1)}`);
    expect(typed, `${harness} resume verb`).toContain(needle);
    expect(typed).toContain(UUID);
    http?.stop(); http = null;
    await core?.stop(); core = null;
    agentMetas.delete(AG(1)); myIds.delete(AG(1));
  }
});

test("reopen falls back to a FRESH launch when the meta has no session id", async () => {
  const { c, http: h } = await routed();
  await seedDead(
    { agentId: AG(1), name: "Fresh", harness: "claude", cwd: HARNESS_CWD, sessionId: null },
    Date.now()
  );
  const body = (await reopen(h, AG(1), true).then((r) => r.json())) as { ok: boolean; paneId?: string };
  expect(body.ok).toBe(true);
  const typed = c.herdr.texts.find((t) => t.paneId === body.paneId)?.text ?? "";
  expect(typed).toContain(`CYC_AGENT_ID=${AG(1)}`);
  expect(typed, "no session id, so no --resume: the fresh launch").not.toContain("--resume");
  expect(typed).toContain("claude --dangerously-skip-permissions");
});

test("reopen refuses a live agent with 409", async () => {
  const { http: h } = await routed();
  await seedDead(
    { agentId: AG(1), name: "Busy", harness: "claude", cwd: HARNESS_CWD, sessionId: UUID },
    Date.now()
  );
  sessions.set(AG(1), { alive: true } as never);
  myLive.add(AG(1));
  const res = await reopen(h, AG(1), true);
  expect(res.status).toBe(409);
  expect((await res.json()).ok).toBe(false);
});

test("reopen refuses a malformed agent id with 400", async () => {
  const { http: h } = await routed();
  const res = await reopen(h, "not-an-agent-id", true);
  expect(res.status).toBe(400);
});

test("reopen refuses an agent this engine does not own", async () => {
  const { http: h } = await routed();
  const res = await reopen(h, "ag-neverseenthisid0", true);
  expect(res.status).toBe(400);
});

/* ---------------------------------------------- observability after a reboot */

/* THE k8plus POWER-CUT (2026-09-29): the owner opened the app and tapped a
 * recently-closed agent to reopen it, and it "did not work". engine.log held
 * NOTHING about the reopen, so we could not even tell the request had reached
 * the engine. The route now writes an arrival line the instant the body is
 * parsed, BEFORE the spawn that used to be the first thing logged. */
test("a reopen logs its arrival before the outcome, naming the agent and resume", async () => {
  const { http: h } = await routed();
  await seedDead(
    { agentId: AG(1), name: "Ada", harness: "claude", cwd: HARNESS_CWD, sessionId: UUID },
    Date.now()
  );
  const logSpy = spyOn(console, "log");
  try {
    const res = await reopen(h, AG(1), true);
    expect((await res.json()).ok).toBe(true);
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    // the arrival line: written before the [new-session] <pane> success line
    const arrival = lines.findIndex((l) => l === `[new-session] request reopen ${AG(1)} (resume=true)`);
    const outcome = lines.findIndex((l) => l.startsWith("[new-session] ") && l.includes(`(${AG(1)},`));
    expect(arrival, "the arrival line is present").toBeGreaterThanOrEqual(0);
    expect(outcome, "the outcome line is present").toBeGreaterThanOrEqual(0);
    expect(arrival, "arrival is logged before the outcome").toBeLessThan(outcome);
  } finally {
    logSpy.mockRestore();
  }
});

/* PANE IDS CHANGE AFTER A REBOOT: the owner guessed the stale pane ids were the
 * problem. They are not -- a reopen NEVER reuses the old pane. It mints a fresh
 * pane (the mux picks the id) and adopts the OLD agent id onto it, so the pane
 * the agent lived on before the reboot is irrelevant. */
test("a reopen opens on a FRESH pane, never the agent's pre-reboot pane", async () => {
  const { c, http: h } = await routed();
  await seedDead(
    // the agent lived on w1:p6 before the reboot; that pane is gone now
    { agentId: AG(1), name: "Ada", harness: "claude", cwd: HARNESS_CWD, sessionId: UUID },
    Date.now()
  );
  const body = (await reopen(h, AG(1), true).then((r) => r.json())) as { ok: boolean; paneId?: string };
  expect(body.ok).toBe(true);
  expect(body.paneId, "a fresh pane the mux minted, not the stale w1:p6").not.toBe("w1:p6");
  // and the resume verb still rode onto the fresh pane
  const typed = c.herdr.texts.find((t) => t.paneId === body.paneId)?.text ?? "";
  expect(typed).toContain(`--resume ${UUID}`);
});

/* HERDR NOT RUNNING YET (the owner's other guess): a reopen that REACHES the
 * spawn but cannot talk to the mux fails 502 AND logs it. So a reopen that
 * reached the engine is always visible in the log -- which is why the incident's
 * empty log proves the request never arrived, not that the engine ate it. */
test("a reopen with the mux down answers 502 and logs the failure", async () => {
  const { c, http: h } = await routed();
  await seedDead(
    { agentId: AG(1), name: "Ada", harness: "claude", cwd: HARNESS_CWD, sessionId: UUID },
    Date.now()
  );
  c.herdr.stop(true); // herdr is gone: tab.create cannot connect
  const errSpy = spyOn(console, "error");
  try {
    const res = await reopen(h, AG(1), true);
    expect(res.status).toBe(502);
    expect((await res.json()).ok).toBe(false);
    const failed = errSpy.mock.calls
      .map((c2) => String(c2[0]))
      .some((l) => l.startsWith(`[new-session] failed in ${HARNESS_CWD}`));
    expect(failed, "the 502 is logged, so a reached reopen is never silent").toBe(true);
  } finally {
    errSpy.mockRestore();
  }
});

/* THE MUX-DOWN 502 CARRIES A DISTINCT CODE (fail-before / pass-after): the app
 * must be able to tell "the multiplexer is not running" (start herdr) apart from
 * a genuine spawn failure, without parsing the bare "Failed to connect" string.
 * The body names the code AND the mux, and the same failure lands in the
 * structured engine.log (mirrored to console.log), not only the journal. */
test("a reopen with the mux down answers code:mux-unreachable, in the body AND engine.log", async () => {
  const { c, http: h } = await routed();
  await seedDead(
    { agentId: AG(1), name: "Ada", harness: "claude", cwd: HARNESS_CWD, sessionId: UUID },
    Date.now()
  );
  c.herdr.stop(true); // herdr is gone: tab.create cannot connect
  const logSpy = spyOn(console, "log");
  try {
    const res = await reopen(h, AG(1), true);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; code?: string; mux?: string };
    expect(body.ok).toBe(false);
    expect(body.code, "the app keys off this to say 'start the mux'").toBe("mux-unreachable");
    expect(typeof body.mux, "the mux name so the sentence is host-specific").toBe("string");
    // the structured logbook line (mirrored to console.log) is what the app and
    // diagnostics read out of ~/.callyourcode/logs/engine.log
    const inEngineLog = logSpy.mock.calls
      .map((c2) => String(c2[0]))
      .some((l) => l.includes("new-session.failed") && l.includes("muxUnreachable=true"));
    expect(inEngineLog, "the mux-down failure is in engine.log, not only the journal").toBe(true);
  } finally {
    logSpy.mockRestore();
  }
});

/* The classifier is pure and narrow: only connect-establishment failures are
 * "the mux is not there". A herdr that answered and refused (a real error string)
 * is a genuine 502, not a "start the mux" case. */
test("isMuxUnreachableError: connect failures yes, a mid-op herdr error no", () => {
  expect(isMuxUnreachableError(new Error("Failed to connect"))).toBe(true);
  expect(isMuxUnreachableError(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe(true);
  expect(isMuxUnreachableError(new Error("herdr rpc tab.create: connection closed"))).toBe(true);
  expect(isMuxUnreachableError(new Error("tab.create returned no pane"))).toBe(false);
  expect(isMuxUnreachableError(new Error("herdr tab.create: EINVAL: bad workspace"))).toBe(false);
  expect(isMuxUnreachableError(null)).toBe(false);
});
