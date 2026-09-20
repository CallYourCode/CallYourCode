/* STARTING A SESSION: the answer herdr actually sends back.
 *
 * WHY THIS FILE EXISTS
 *
 * The 2026-08-05 report: starting a new session in the home directory just
 * failed. It had never worked, for any directory, since /new-session shipped on
 * 2026-07-27: 66 engine lifetimes of `.run/engine.log` contain not one
 * `[new-session]` line.
 *
 * newTab read the new pane's id off the TOP of tab.create's result:
 *
 *     const paneId = res?.pane_id ?? res?.panes?.[0]?.pane_id;
 *
 * herdr does not put it there. Its own published schema (`herdr api schema`,
 * server 0.7.3, protocol 16) says tab.create answers
 *
 *     { type: "tab_created", tab: TabInfo, root_pane: PaneInfo }
 *
 * and PaneInfo is where `pane_id` lives. So both guesses were undefined, newTab
 * threw "tab.create returned no pane" on every call, and the route answered 502
 * without writing a word to the log -- because the one log line it had was on the
 * success path, after the throw. This is the same nesting the client already
 * documents for pane.read ("result.read.text, NESTED -- reading result.text gets
 * an empty string").
 *
 * THE SHAPES HERE ARE NOT INVENTED. They are the shapes in the schema his own
 * herdr server serves, so if herdr moves them this fails rather than silently
 * starting nothing again.
 *
 * NO REAL HERDR, AND NO ENGINE. The first three tests talk to a scripted unix
 * socket this file opens in a temp directory it owns; the rest drive the real
 * route table on a port-0 Bun.serve over wireCore's FakeHerdr. Nothing creates a
 * tab or a session anywhere.
 *
 *   bun test agent-engine/src/sessions/newsession.test.ts
 */

import { test, expect, afterEach } from "bun:test";

import { HerdrClient } from "../terminal/herdr.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";
import type { RoutesCtx } from "../routes/ctx.ts";
import { chatRoutes } from "../routes/chat.ts";
import { wireCore, type WireCore } from "../test-utils/wire-core.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { PANE, HARNESS_CWD } from "../test-utils/fake-herdr.ts";
import { tmpDir, sockPath } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";

/* ------------------------------------------------- 1. the shape of the answer
 *
 * A unix socket speaking herdr's line protocol, answering tab.create with
 * whatever the test wants it to answer. Deliberately NOT the shared FakeHerdr:
 * its subject is what the engine does with a herdr that behaves, and the subject
 * HERE is a herdr whose answer is shaped wrong. */
function scriptedHerdr(path: string, reply: (method: string, params: any) => unknown) {
  const seen: { method: string; params: any }[] = [];
  const server = Bun.listen({
    unix: path,
    socket: {
      data(sock, chunk) {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          seen.push({ method: msg.method, params: msg.params });
          sock.write(JSON.stringify({ id: msg.id, ...(reply(msg.method, msg.params) as object) }) + "\n");
        }
      },
    },
  });
  return { path, seen, stop: () => server.stop(true) };
}

/** Exactly what herdr's schema says tab_created is. */
const tabCreated = (paneId: string) => ({
  result: {
    type: "tab_created",
    tab: {
      tab_id: "tab-1", workspace_id: "ws-1", number: 1, label: "1",
      focused: false, pane_count: 1, agent_status: "unknown",
    },
    root_pane: {
      pane_id: paneId, terminal_id: "t-1", workspace_id: "ws-1", tab_id: "tab-1",
      focused: false, agent_status: "unknown", revision: 1, cwd: "/tmp/fixture",
    },
  },
});

let rig: ReturnType<typeof scriptedHerdr> | null = null;
let core: WireCore | null = null;
let http: ServedRoutes | null = null;
afterEach(async () => {
  rig?.stop();
  rig = null;
  http?.stop();
  http = null;
  await core?.stop();
  core = null;
});

/** A scripted herdr on this test's own socket, and a client pointed at it.
 *  Injected through the constructor rather than through HERDR_SOCKET_PATH: two
 *  files in two parallel workers must not fight over one environment variable. */
async function scripted(reply: (method: string, params: any) => unknown) {
  rig = scriptedHerdr(sockPath(await tmpDir("cyc-newsession-")), reply);
  return { rig, client: new HerdrClient(rig.path) };
}

test("the new pane's id is read out of tab_created.root_pane, where herdr puts it", async () => {
  const { rig: r, client } = await scripted((method) =>
    method === "tab.create" ? tabCreated("w9:p7") : { result: { type: "ok" } });

  const paneId = await client.newTab({
    workspaceId: "ws-1", cwd: "/tmp/fixture", label: "fixture", command: "claude",
  });

  expect(paneId).toBe("w9:p7");
  // and the command really was typed into THAT pane, not into a guessed one
  expect(r.seen.map((s) => s.method))
    .toEqual(["tab.create", "pane.send_text", "pane.send_keys"]);
  expect(r.seen[1]!.params.pane_id).toBe("w9:p7");
  expect(r.seen[1]!.params.text).toBe("claude");
  expect(r.seen[2]!.params.pane_id).toBe("w9:p7");
  expect(r.seen[2]!.params.keys).toEqual(["enter"]);
});

test("a tab.create that names no pane fails by saying so", async () => {
  const { client } = await scripted((method) =>
    method === "tab.create" ? { result: { type: "tab_created", tab: {} } } : { result: { type: "ok" } });
  await expect(client.newTab({ cwd: "/tmp/fixture", command: "claude" }))
    .rejects.toThrow(/no pane/);
});

test("herdr's own refusal is the error, not a shape complaint", async () => {
  const { client } = await scripted((method) =>
    method === "tab.create"
      ? { error: { code: -32602, message: "no such workspace" } }
      : { result: { type: "ok" } });
  await expect(client.newTab({ cwd: "/tmp/fixture", command: "claude" }))
    .rejects.toThrow(/no such workspace/);
});

/* ------------------------------------------------- 2. what the route types
 *
 * A different question from where it reads the pane id, and the one he hit the
 * moment the button first worked.
 *
 * The 2026-08-05 report: the new session started without bypass
 * permissions. The route typed a bare `claude`, so the first thing the new
 * session did was stop and ask whether to trust /Users/example -- from a phone,
 * where a terminal chooser is not a thing anyone can answer. Measured in
 * `.run/engine.log` the same evening: `[new-session] w6:p1X in /Users/example` at
 * 17:59:45, `answer.send ... label="Yes, I trust this folder"` at 17:59:56.
 *
 * Asserted through the ROUTE and against the real command string rather than
 * against a constant, because "it passes the flag it passes" is not the claim.
 * The claim is that a session started from the app is started the way he starts
 * one by hand, and the way he starts one by hand is a literal. */

/** The routes, over a wiring whose one pane gives the guard a known cwd. */
async function routed(): Promise<{ c: WireCore; http: ServedRoutes }> {
  core = await wireCore({ with: ["delivery"] });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  http = serveRoutes({
    groups: [sessionOpsRoutes, chatRoutes],
    ctx: {
      adapter: core.adapter,
      // the one place this engine spells how to start claude (the reader's own
      // launch capability), read the way server.ts reads it
      claudeCommand: core.adapter.launchCommand("claude")!,
      engineHome: "/tmp/does-not-exist-home",
      engineRepo: "/tmp/engine-checkout",
    },
  });
  return { c: core, http };
}

test("a session started from the app skips the permission prompt", async () => {
  const { c, http: h } = await routed();
  // the wiring's one agent runs here, so this is a directory the guard allows
  const res = await h.post("/new-session", { cwd: HARNESS_CWD, near: PANE });
  const body = await res.json() as { ok: boolean; paneId?: string; agentId?: string };
  expect(body.ok, `the route refused: ${JSON.stringify(body)}`).toBe(true);
  expect(body.paneId).toBe("w9:p1");
  /* The response also carries the pre-minted STABLE id, the one the app matches
   * the new session by (it survives the pane->uuid re-key the handle does not),
   * and it is the same id injected into the child's env below. */
  expect(body.agentId).toMatch(/^ag-[A-Za-z0-9_-]{16}$/);

  // into the NEW pane, not the one that was already there
  const typed = c.herdr.texts.filter((t) => t.paneId === body.paneId);
  expect(typed).toHaveLength(1);
  /* The pre-minted stable id is injected as a portable `env` prefix, then the
   * same launch command a restart types (agent-env.ts, cyc-cli plan section 3). */
  expect(typed[0].text).toMatch(/^env CYC_AGENT_ID=ag-[A-Za-z0-9_-]{16} claude --dangerously-skip-permissions$/);
  // the id the app was handed is exactly the one bound to the child's env
  expect(typed[0].text).toContain(`CYC_AGENT_ID=${body.agentId}`);
  // and submitted, or it is a command sitting in a box
  expect(c.herdr.keys.filter((k) => k.paneId === body.paneId).map((k) => k.keys))
    .toEqual([["enter"]]);
  expect(c.submitted.map((s) => s.text)).toEqual([typed[0].text]);
});

test("it is the same command a restart types: one way to start claude", async () => {
  const { c, http: h } = await routed();
  const { paneId } = await (await h.post("/new-session", { cwd: HARNESS_CWD })).json() as
    { paneId: string };
  const started = c.herdr.texts.find((t) => t.paneId === paneId)?.text ?? "";
  /* restart.test.ts asserts the restart command carries the same launch suffix.
   * If the two ever drift, one of the two files goes red rather than his phone.
   * Both now ride behind the CYC_AGENT_ID env prefix (cyc-cli plan section 3). */
  expect(started).toMatch(/^env CYC_AGENT_ID=ag-[A-Za-z0-9_-]{16} claude --dangerously-skip-permissions$/);
  expect(started.endsWith(c.adapter.launchCommand("claude")!)).toBe(true);
});

test("a directory nothing runs in is refused, and no tab is made", async () => {
  /* This endpoint must not become a way to start a shell anywhere on the
   * machine: only somewhere an agent already runs, plus this user's own home. */
  const { c, http: h } = await routed();
  const res = await h.post("/new-session", { cwd: "/etc" });
  expect(res.status).toBe(400);
  expect(String((await res.json()).error)).toMatch(/unknown directory/);
  expect(c.herdr.rpcs.some((r) => r.method === "tab.create"),
    "a tab was created in a directory the guard refused").toBe(false);
});

test("a request with no cwd at all is refused before anything is started", async () => {
  const { c, http: h } = await routed();
  const res = await h.post("/new-session", {});
  expect(res.status).toBe(400);
  expect(String((await res.json()).error)).toMatch(/cwd required/);
  expect(c.herdr.rpcs.some((r) => r.method === "tab.create")).toBe(false);
});

/* ----------------------------------------- where the plus menu points first
 *
 * The engine's own checkout is the preferred default place for a new session
 * (`def` in /new-session/places): on macOS every fresh directory an agent
 * works in costs a TCC permission prompt, and the checkout the engine runs
 * from is the one directory already blessed. With a known checkout, home is
 * excluded from places (decided 2026-08-23); the `home` field itself stays
 * for identity and older apps. With no known checkout, def is home and the
 * answer is exactly what this route said yesterday. */

test("places names the engine checkout as def, first in the list, home excluded", async () => {
  const { http: h } = await routed();
  const body = await (await h.get("/new-session/places")).json() as
    { places: string[]; home: string; def: string };
  expect(body.def).toBe("/tmp/engine-checkout");
  expect(body.home).toBe("/tmp/does-not-exist-home");
  expect(body.places[0]).toBe("/tmp/engine-checkout");
  expect(body.places).toContain(HARNESS_CWD);
  expect(body.places).not.toContain(body.home);
});

test("with no checkout known, def is home and the places are the adapter's alone", async () => {
  http = serveRoutes({
    groups: [sessionOpsRoutes],
    ctx: {
      // launchableKinds is here because /new-session/places now reads it (the
      // plus menu's harness list); it stays [] so this test's subject (def and
      // places) is unchanged.
      adapter: { knownCwds: () => ["/w/one"], launchableKinds: () => [] } as unknown as RoutesCtx["adapter"],
      engineHome: "/tmp/h",
      engineRepo: null,
    },
  });
  const body = await (await http.get("/new-session/places")).json() as
    { places: string[]; home: string; def: string };
  expect(body.def).toBe("/tmp/h");
  expect(body.home).toBe("/tmp/h");
  expect(body.places).toEqual(["/w/one"]);
});

test("a session may start in the engine checkout, even with nothing running there", async () => {
  /* The default the route just offered must also pass the /new-session guard,
   * or the plus button's first row refuses its own suggestion. */
  const { c, http: h } = await routed();
  const res = await h.post("/new-session", { cwd: "/tmp/engine-checkout", near: PANE });
  const body = await res.json() as { ok: boolean; paneId?: string };
  expect(body.ok, `the route refused: ${JSON.stringify(body)}`).toBe(true);
  expect(c.herdr.rpcs.some((r) => r.method === "tab.create")).toBe(true);
});

/* ------------------------------------------- 3. the first minute of a session
 *
 * THE FIRST MINUTE OF A SESSION IS NOT A FAULT, AND IT IS NOT A ROUTE.
 *
 * Measured on the first session the plus button ever started: `[new-session]
 * w6:p1X in /Users/example` at 17:59:45Z, first `[session-tail]` at 18:01:09Z,
 * and that file's own birth time is the same second. Eighty-four seconds with
 * no transcript, and not one of them was a problem. The engine used to answer
 * those seconds with a 404 on GET /session-events, which the app then had to
 * know not to draw as "session log unavailable".
 *
 * Now the activity is rows of the session's OWN log (chat/ingest.ts): a session
 * that has written no transcript simply has no `t:"s"` rows yet, and the page
 * it serves is an ordinary, empty, unsealed page 0. There is nothing to 404. */
test("a live session with no transcript pages an empty page, and no error", async () => {
  const { c, http: h } = await routed();
  const s = [...c.sessions.values()][0]!;
  const res = await h.get(`/session/${encodeURIComponent(s.id)}/page/0`);
  expect(res.status).toBe(200);
  const page = await res.json() as { page: number; sealed: boolean; messages: unknown[]; version: number };
  expect(page).toEqual({ page: 0, version: 0, sealed: false, messages: [] });
});

test("there is no session-events route: the activity has no read path apart from the pages", async () => {
  const { http: h } = await routed();
  const res = await h.get("/session-events/w9%3Ap404");
  expect(res.status).toBe(404);
  // the router's own "not found", not an engine answer about a session log
  expect(await res.text()).toBe("not found");
});
