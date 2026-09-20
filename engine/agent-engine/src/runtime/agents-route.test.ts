/* GET /agents: the one row-per-session read the `cyc` CLI's table and its
 * agent-id resolution are built on (cyc-cli plan section 2, section 8).
 *
 * Driven through the serve-routes rig on real loopback, so the requireLocal
 * gate runs for real: a plain fetch is the engine host and passes; a fetch
 * carrying x-forwarded-for is a proxied peer and is refused, the same
 * distinction httpx.isTrustedLocal draws for every local-only route.
 *
 *   bun test agent-engine/src/runtime/agents-route.test.ts
 */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";
import { sessions, setNameOverride, resetForTest as resetSessionState,
  type Session } from "../sessions/session-state.ts";

function seed(id: string, over: Partial<Session> = {}): Session {
  const s = {
    id, agentId: `ag-${id.replace(/[^A-Za-z0-9_-]/g, "x")}00000000`.slice(0, 19),
    muxHandle: id, name: "pane name", cwd: "/home/tester/projects/foo",
    ws: null, alive: true, busy: false, viaMux: true,
    agent: { id: "claude", name: "Claude" }, hasTranscript: false, agentSession: null,
    harnessSessionId: null, status: "idle", workspace: "w1", tab: null,
    displayAgent: null, stateChangeSeq: 0, turnSince: 0, channels: [],
    doneSeq: 0, seenDoneSeq: 0, heardTs: 0, notified: false, filedTs: 0,
    order: 0, chat: [], ...over,
  } as unknown as Session;
  sessions.set(id, s);
  return s;
}

let srv: ServedRoutes;
const OLD_MUX = process.env.CYC_MUX;

beforeAll(() => {
  srv = serveRoutes({ groups: [sessionOpsRoutes], ctx: {} });
});
afterAll(() => {
  srv?.stop();
  resetSessionState();
  if (OLD_MUX === undefined) delete process.env.CYC_MUX;
  else process.env.CYC_MUX = OLD_MUX;
});
afterEach(() => {
  sessions.clear();
  if (OLD_MUX === undefined) delete process.env.CYC_MUX;
  else process.env.CYC_MUX = OLD_MUX;
});

test("a loopback GET returns one row per session with the CLI's fields", async () => {
  const a = seed("w1:p1", { agentId: "ag-3fK9x2mPq81LbR0w", cwd: "/home/tester/a",
    status: "working", muxHandle: "w1:p1" });
  seed("uuid-2", { agentId: "ag-8Qw1nT5cZk2vXo9d", cwd: "/home/tester/b",
    status: "idle", muxHandle: "w2:p3", agent: { id: "codex", name: "Codex" } as any,
    harnessSessionId: "uuid-2" });
  // a rename override wins for the name column
  setNameOverride(a.id, "deploy watcher");

  const res = await srv.get("/agents");
  expect(res.status).toBe(200);
  const body = await res.json() as { ok: boolean; mux: string; agents: any[] };
  expect(body.ok).toBe(true);
  expect(body.mux).toBe("tmux"); // the default when CYC_MUX is unset

  const byId = Object.fromEntries(body.agents.map((r) => [r.agentId, r]));
  expect(byId["ag-3fK9x2mPq81LbR0w"]).toEqual({
    agentId: "ag-3fK9x2mPq81LbR0w",
    name: "deploy watcher",
    cwd: "/home/tester/a",
    pane: "w1:p1",
    harness: "claude",
    status: "working",
    alive: true,
    sessionId: "w1:p1",
  });
  expect(byId["ag-8Qw1nT5cZk2vXo9d"]).toEqual({
    agentId: "ag-8Qw1nT5cZk2vXo9d",
    name: "pane name",
    cwd: "/home/tester/b",
    pane: "w2:p3",
    harness: "codex",
    status: "idle",
    alive: true,
    sessionId: "uuid-2",
  });

  setNameOverride(a.id, null);
});

test("mux reflects CYC_MUX", async () => {
  process.env.CYC_MUX = "tmux";
  const body = await (await srv.get("/agents")).json() as { mux: string };
  expect(body.mux).toBe("tmux");
  process.env.CYC_MUX = "HERDR";
  expect((await (await srv.get("/agents")).json() as { mux: string }).mux).toBe("herdr");
});

test("an empty engine answers ok with no agents, never a 404", async () => {
  const body = await (await srv.get("/agents")).json() as { ok: boolean; agents: any[] };
  expect(body.ok).toBe(true);
  expect(body.agents).toEqual([]);
});

test("a proxied peer (x-forwarded-for present) is refused: the route is local-only", async () => {
  seed("w1:p1");
  for (const xff of ["100.64.0.55", "", "127.0.0.1", "127.0.0.1, 100.64.0.55"]) {
    const res = await srv.get("/agents", { headers: { "x-forwarded-for": xff } });
    expect(res.status, `x-forwarded-for ${JSON.stringify(xff)} reached the route`).toBe(403);
    expect((await res.json()).error).toMatch(/local-only/);
  }
});

test("the gate runs BEFORE the row build, so a refused peer learns nothing", async () => {
  // no sessions seeded: a refused peer must still get 403, not an empty 200 it
  // could tell apart from a populated one
  const res = await srv.get("/agents", { headers: { "x-forwarded-for": "100.64.0.55" } });
  expect(res.status).toBe(403);
});
