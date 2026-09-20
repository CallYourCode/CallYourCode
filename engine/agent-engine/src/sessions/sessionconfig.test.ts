/* THE SETTINGS WRITE, AND A SESSION'S OWN CRONS, over the HTTP surface the
 * callyourcode MCP points the agent at.
 *
 * THE MERGED-VIEW GET IS GONE. `GET /session/<id>/settings` (the read that once
 * brought name/photo/cwd/settings/title back together for task 357) was removed:
 * the engine exposes no remote HTTP read for a session, the app receives settings
 * in the ws sessions frame, and local inspection is `cyc`'s job. What stays here
 * is the settings WRITE -- which two keys it owns, that null clears one, and that
 * an unknown session is a 404 rather than a silent create -- with its persisted
 * effect read straight from the in-process store, not back over a route.
 *
 * AND THE CRONS ARE NOT IN IT ANY MORE. The schedules/tz embed is gone; the
 * crons plugin's own rpc is the one surface for them. So the second half of this
 * file follows a cron created through the DOCUMENTED endpoint all the way to the
 * agent's own schedules.json, and then asks the code that will FIRE it when it
 * fires -- the preview -- which is how "it goes off hourly" is asserted without
 * waiting an hour.
 *
 * NO ENGINE: wireCore performs server.ts's ordered boot in-process, the routes
 * run over a real Bun.serve on port 0 against the real route groups, and the
 * crons plugin runs on the manual clock so its deliberately-late first tick
 * never arms a real timer.
 *
 *   bun test agent-engine/src/sessions/sessionconfig.test.ts
 */

import { test, expect, afterAll, beforeAll } from "bun:test";
import { join } from "node:path";

import { cronsPlugin } from "../plugins/crons/index.ts";
import { makePluginHost } from "../plugins/platform/host.ts";
import type { PluginSpec } from "../plugins/platform/spec.ts";
import { mediaRoutes } from "../routes/media.ts";
import { pluginRoutes } from "../routes/plugin.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { wireCore, wireId, type WireCore } from "../test-utils/wire-core.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { settingsOf } from "./session-state.ts";

let core: WireCore;
let http: ServedRoutes;
let crons: PluginSpec;

beforeAll(async () => {
  core = await wireCore({ with: ["sessions"] });
  await until(() => !!core.byHandle(PANE), { what: "the pane to become a session" });

  /* THE CRONS PLUGIN OVER THE REAL MINIMAL HOST. The plugin reaches this engine
   * through exactly three verbs (an engine store, an agent store, deliver with
   * the guardCwd check), so a host wired to the live session map is the whole
   * seam. Its clock is the wiring's manual one: the plugin's first tick is ten
   * seconds late on purpose and its ticker runs every fifteen, and neither is
   * something this file should spend wall time on. */
  const host = makePluginHost("crons", {
    sessionFor: (agentId) => {
      for (const s of core.sessions.values()) if (s.agentId === agentId) return { cwd: s.cwd };
      return null;
    },
    deliverText: async () => ({ ok: true }),
  });
  crons = cronsPlugin(host, { log: () => {}, clock: core.clock });

  http = serveRoutes({
    groups: [sessionOpsRoutes, mediaRoutes, pluginRoutes],
    ctx: {
      adapter: core.adapter,
      plugins: () => [crons],
      pluginById: (id) => (id === crons.id ? crons : undefined),
    },
  });
});

afterAll(async () => {
  crons?.dispose?.();
  http?.stop();
  await core?.stop();
});

const post = (path: string, body: unknown) => http.post(path, body);
/** The ONE route every schedule mutation rides now. */
const cron = async (op: string, args: unknown) =>
  await (await http.post(`/plugin/crons/rpc/${op}`, { session: PANE, args })).json() as any;

/* THE MERGED-VIEW GET IS GONE. `GET /session/<id>/settings` (the read that
 * brought name/photo/cwd/settings/title back together) was removed: the engine
 * exposes no remote HTTP read for a session, the app receives settings in the
 * ws sessions frame, and local inspection is `cyc`'s job. Only the settings
 * WRITE below stays, and its persisted effect is read straight from the
 * in-process store (settingsOf) rather than over a route. */

test("a session this engine does not have is not writable: a 404, not a silent create", async () => {
  expect((await post(`/session/w9:p99/settings`, { muted: true })).status).toBe(404);
});

test("the settings write takes only the two keys it owns, and null clears one", async () => {
  /* `speed` and `activity` are one app-level switch now, so a client that sends
   * only those gets a 400 rather than a silent 200 over a store that kept
   * nothing -- the failure mode where a preference looks saved and is not. */
  const bad = await post(`/session/${wireId(PANE)}/settings`, { speed: 2, activity: true });
  expect(bad.status).toBe(400);
  expect((await bad.json() as any).error).toMatch(/nothing to set/);

  await post(`/session/${wireId(PANE)}/settings`, { muted: true, notify: false });
  const cleared = await (await post(`/session/${wireId(PANE)}/settings`, { muted: null })).json() as any;
  expect(cleared.ok).toBe(true);
  expect(cleared.settings, "null must clear the override back to the global default")
    .toEqual({ notify: false });
  // the persisted override, read straight from the store the write lands in
  expect(settingsOf(wireId(PANE))).toEqual({ notify: false });
});

test("a cron set up through the documented endpoint lands in the AGENT's own store and previews hourly", async () => {
  // exactly the shape the crons panel sends for "every hour"
  const made = await cron("create",
    { kind: "repeat", name: "hourly", body: "the hourly check", cron: "0 * * * *", tz: "UTC" });
  expect(made.ok).toBe(true);
  expect(made.result.schedule.cron).toBe("0 * * * *");
  expect(made.result.schedule.enabled).toBe(true);
  expect(made.result.schedule.nextAt).not.toBeNull();
  // the next fire is on the top of some hour
  expect(new Date(made.result.schedule.nextAt).getUTCMinutes()).toBe(0);

  /* IT IS ON DISK BEFORE THE ANSWER CAME BACK -- read straight off, no waiting
   * -- in the AGENT's crons store (agent-scoped plugin data, the design), v2. The
   * agent axis is what makes a schedule survive a re-key: keyed to the pane it
   * would be lost the moment claude minted a new session id. */
  const aid = core.byHandle(PANE)!.agentId;
  const disk = await Bun.file(
    join(core.dir, "agents", aid, "plugins", "crons", "schedules.json")).json() as any;
  expect(disk.v).toBe(2);
  expect(disk.schedules[made.result.schedule.id].cron).toBe("0 * * * *");
  expect(disk.schedules[made.result.schedule.id].agent).toBe(aid);

  /* THE SAME CODE THAT WILL FIRE IT UNDERSTANDS IT: the preview walks the cron
   * with the store's own arithmetic, which is how a test asserts "it fires
   * hourly through the scheduler" without waiting an hour. */
  const preview = await cron("preview", { cron: "0 * * * *", tz: "UTC" });
  expect(preview.ok).toBe(true);
  expect(preview.result.next.length).toBe(5);
  expect(preview.result.next[1] - preview.result.next[0]).toBe(3_600_000); // one hour apart
  expect(preview.result.tz).toBe("UTC");

  // the schedule the session created is listed back to it, on the one op
  const listed = await cron("list", {});
  expect(listed.ok).toBe(true);
  expect(listed.result.schedules.some((s: any) => s.id === made.result.schedule.id)).toBe(true);

  // and the documented pause op stops it
  const paused = await cron("update", { id: made.result.schedule.id, enabled: false });
  expect(paused.ok).toBe(true);
  expect(paused.result.schedule.enabled).toBe(false);
  expect(paused.result.schedule.nextAt).toBeNull(); // a paused cron has no next fire
});

test("the preview refuses a cron it cannot parse, by name and with a 400", async () => {
  /* The preview is the app's live feedback while he types a custom cron, so its
   * refusal has to be a sentence and a status the editor can show, not a 500. */
  const bad = await http.post(`/plugin/crons/rpc/preview`, { session: PANE, args: { cron: "not a cron" } });
  expect(bad.status).toBe(400);
  expect((await bad.json() as any).error).toMatch(/not a cron expression/);
  const zone = await http.post(`/plugin/crons/rpc/preview`,
    { session: PANE, args: { cron: "0 * * * *", tz: "Mars/Olympus" } });
  expect(zone.status).toBe(400);
  expect((await zone.json() as any).error).toMatch(/no such timezone/);
});

test("a crons op with no session is refused: a schedule belongs to a conversation", async () => {
  /* Every record keys on the stable agent id the rpc ctx carries. Without a
   * session there is no agent, and a schedule filed under nothing would fire
   * into nothing forever. */
  const r = await http.post(`/plugin/crons/rpc/list`, { args: {} });
  expect(r.status).toBe(500);
  expect((await r.json() as any).error).toMatch(/needs a session/);
});
