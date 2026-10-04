/* THE RIG, ON TRIAL. Not one feature is under test here.
 *
 * wireCore() is the seam tier's replacement for startEngine(), which means the
 * whole tier stands on the claims in its header: that it boots no engine and
 * opens no port, that the fake panes become real sessions through the real
 * reconcile, that a frame written by the real broadcast reaches a client, that
 * a message goes through the real delivery path and is actually TYPED and
 * SUBMITTED at the pane, that logical time is the manual clock, and that a
 * reset leaves nothing behind. Every one of those is a claim a feature test
 * would silently inherit, so every one of them is asserted here, once, where a
 * failure names the rig instead of naming somebody's feature.
 *
 * The assertions deliberately do not duplicate any feature test. "The message
 * arrived" is proven from `herdr.texts` and the SUBMITTED list -- what the fake
 * pane actually received -- rather than from an engine-side record of its own
 * intentions, because a rig that agrees with the code about what happened is a
 * rig that proves nothing.
 */

import { test, expect, afterEach } from "bun:test";
import { wireCore, wireId, type WireCore } from "./wire-core.ts";
import { PANE, HARNESS_CWD } from "./fake-herdr.ts";
import { until } from "./wait.ts";
import { clients } from "../transport/wire.ts";
import { ASK_POLL_MS, asks } from "../chat/asks.ts";
import { onUtterance } from "../chat/deliver.ts";

/** manualClock()'s own default epoch, spelled once so the clock assertions
 *  read as arithmetic rather than as magic numbers. */
const START_MS = 1_700_000_000_000;

/* One wiring at a time, torn down whatever the test did: two live at once are
 * two engines fighting over one data dir, and a wiring left up leaks its herdr
 * socket and its adapter poll into the next test in this file. */
let core: WireCore | null = null;
afterEach(async () => {
  await core?.stop();
  core = null;
});

test("it boots with no engine process, no Bun.serve and no listening port", async () => {
  /* THE CLAIM THE WHOLE TIER RESTS ON, asserted directly rather than inferred
   * from "the tests are fast". The old suite's answer to every seam question
   * was `bun run server.ts` on a guessed port; if wireCore ever grows one of
   * those back -- a convenience Bun.serve, a herdr subprocess, an announce
   * heartbeat -- it happens here, in a helper nobody reads, and every file in
   * the tier pays for it at once.
   *
   * Counted rather than forbidden, so the failure message says which one. */
  const realServe = Bun.serve;
  const realSpawn = Bun.spawn;
  const realSpawnSync = Bun.spawnSync;
  const served: unknown[] = [];
  const spawned: unknown[] = [];
  (Bun as any).serve = (...a: unknown[]) => { served.push(a[0]); return (realServe as any)(...a); };
  (Bun as any).spawn = (...a: unknown[]) => { spawned.push(a[0]); return (realSpawn as any)(...a); };
  (Bun as any).spawnSync = (...a: unknown[]) => { spawned.push(a[0]); return (realSpawnSync as any)(...a); };
  try {
    core = await wireCore({ with: ["sessions", "delivery", "plugins", "frames"] });
    await until(() => core!.sessions.size === 1, { what: "the reconcile to build a session" });
  } finally {
    (Bun as any).serve = realServe;
    (Bun as any).spawn = realSpawn;
    (Bun as any).spawnSync = realSpawnSync;
  }
  expect(served).toEqual([]);
  expect(spawned).toEqual([]);

  /* And the transport it DOES use is a unix socket inside this test's own tmp
   * dir, which is the other half of "no fixed ports": two files in two parallel
   * workers cannot collide on a path neither of them can guess. */
  expect(core!.dir.startsWith(core!.root)).toBe(true);
  expect(core!.projects.startsWith(core!.root)).toBe(true);
  expect(process.env.CYC_DATA_DIR).toBe(core!.dir);
  // no app server either, until a layer asks for one
  expect(core!.pushSink).toBeNull();

  /* The layers that were asked for really did wire: the plugin registry
   * declared, and the opening burst a fresh client gets carries the same
   * declarations plus this engine's capabilities. */
  expect(core!.pluginDecls.length).toBeGreaterThan(0);
  const c = core!.client();
  core!.hello(c);
  expect(c.last("can")!.list).toEqual(["words", "plugins"]);
  expect(c.last("plugins")!.list).toHaveLength(core!.pluginDecls.length);
  expect(c.last("host")).toMatchObject({ user: "seam-user", host: "seam-host" });
  expect(c.last("sessions")!.list).toHaveLength(1);
});

test("the notify layer wires presence and a push sink, and nothing else does", async () => {
  /* The one layer that opens a real port, so it is opt-in and asserted on its
   * own. The sink IS the app server as far as notify is concerned: its url is
   * what the engine posts to, and its enrolment is where the bearer token
   * comes from, so a notify seam test needs nothing else to exist. */
  core = await wireCore({ with: ["notify"] });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  expect(core.pushSink).not.toBeNull();
  expect(core.pushSink!.url.startsWith("http://127.0.0.1:")).toBe(true);
  // the sealed-preview identity notify needs (sealpush over the E2E state)
  expect(core.e2e!.identity.fp).toBeTruthy();
  // notify implies sessions, and nothing implies notify
  expect(core.layers.sort()).toEqual(["notify", "sessions"]);
});

test("the fake herdr's panes become real sessions: the reconcile really ran", async () => {
  core = await wireCore({ panes: ["w1:p1", "w2:p7"], with: ["sessions"] });
  await until(() => core!.sessions.size === 2, { what: "both panes to reconcile" });

  /* Keyed by the STABLE agent id; the pane is an attribute of the row.
   * Everything on the row came out of the snapshot and through makeReconcile:
   * the cwd, the aliveness, the workspace, the minted agent id. A rig that
   * built these rows itself could get every one of them right and still not
   * prove the reconcile is wired. */
  expect([...core.sessions.values()].map((s) => s.muxHandle).sort()).toEqual(["w1:p1", "w2:p7"]);
  for (const [k, s] of core.sessions) expect(k).toBe(s.agentId);
  const s = core.byHandle("w1:p1")!;
  expect(s.cwd).toBe(HARNESS_CWD);
  expect(s.alive).toBe(true);
  expect(s.viaMux).toBe(true);
  expect(s.agent.id).toBe("claude");
  /* The workspace is herdr's LABEL for it, resolved through the snapshot's
   * workspaces array rather than sliced off the pane id, which is why the two
   * panes report different words for their two different workspaces. */
  expect(s.workspace).toBe("probe");
  expect(core.byHandle("w2:p7")!.workspace).toBe("w2");
  // the stable agent id is minted through session-state, not invented by herdr
  expect(s.agentId).toMatch(/^ag-/);
  expect(s.id, "the wire id IS the agent id").toBe(s.agentId);
});

test("a sessions frame reaches a fake client and carries the panes", async () => {
  /* The client is registered BEFORE the adapter starts, so the frame it
   * receives is the one the reconcile's own broadcastSessions() produced --
   * through wire.ts's real client set, through sessions-frame.ts's real
   * projection and its dedupe. Nothing here calls sessionsFrame() by hand. */
  core = await wireCore({ panes: ["w1:p1", "w1:p2"], with: ["sessions"], start: false });
  const c = core.client();
  expect(c.frames).toEqual([]);

  core.adapter.start();
  await until(() => c.of("sessions").length > 0, { what: "a sessions frame on the client" });

  const frame = c.last("sessions")!;
  const list = frame.list as Array<Record<string, any>>;
  // the wire id is the agent id; the pane never rides the row as its key
  expect(list.map((r) => r.id).sort()).toEqual([wireId("w1:p1"), wireId("w1:p2")].sort());
  // the projection's own fields, not the snapshot's: a title, a read marker,
  // an order that is the position in THIS list
  expect(list[0].name).toBeTruthy();
  expect(list.map((r) => r.order)).toEqual([0, 1]);
  expect(list[0].alive).toBe(true);
});

test("a message goes through the real delivery path and is typed AND submitted", async () => {
  core = await wireCore({ with: ["delivery"] });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  const c = core.client();

  /* THE REAL ENTRY POINT: the frame a client sends. onUtterance -> the
   * per-session order chain -> handleUtterance -> the upload binder -> the
   * dials instruction -> the delivery guard's screen read -> herdr send_text ->
   * herdr enter. Every one of those is the shipped module. */
  await onUtterance(c.sock, { id: core.byHandle(PANE)!.id, text: "wire-core says hello" });

  /* WHAT THE PANE RECEIVED, which is the only place this can honestly be
   * asked: the real herdr types into a terminal and nothing else on the engine
   * side sees it. `texts` is what was typed; `submitted` is what the enter
   * actually sent, and they are different questions -- a typed body with no
   * enter behind it is the stranded-delivery failure the guard exists for. */
  await until(() => core!.submitted.length === 1, { what: "the pane to submit the message" });
  expect(core.herdr.texts.length).toBe(1);
  expect(core.herdr.texts[0].paneId).toBe(PANE);
  expect(core.herdr.texts[0].text).toContain("wire-core says hello");
  // the delivered line is tagged with how it arrived, per injectUserMessage
  expect(core.herdr.texts[0].text.startsWith("TEXT: ")).toBe(true);
  expect(core.submitted[0].pane).toBe(PANE);
  expect(core.submitted[0].text).toBe(core.herdr.texts[0].text);
  // ...and it went in as ONE delivery, not two
  expect(core.herdr.keys.filter((k) => k.keys.includes("enter")).length).toBe(1);

  // and the same delivery wrote the chat row and told the client about it
  const chat = core.byHandle(PANE)!.chat;
  expect(chat.at(-1)!.role).toBe("user");
  expect(chat.at(-1)!.text).toBe("wire-core says hello");
  expect(c.last("chat")!.text).toBe("wire-core says hello");
});

test("clock.advance moves a real module's timer, and nothing sleeps", async () => {
  /* asks.ts's poll is the timer: a blocked pane is re-read every ASK_POLL_MS,
   * and with the manual clock threaded through its deps bag that cadence is
   * arithmetic rather than three seconds of wall time.
   *
   * The observable is the ask's OWN `at` stamp, which readAskNow writes from
   * the same clock. It moving is proof the pane was read again and not
   * answered from the cache -- readAskNow always reads -- and its value is
   * proof of exactly which logical instant did the reading. */
  core = await wireCore({ agentStatus: "blocked", with: ["sessions"] });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  // reconcile reads a pane the moment it turns up blocked, rather than making
  // him wait a poll for the question
  await until(() => asks.get(PANE) !== undefined, { what: "the arrival read of a blocked pane" });
  expect(asks.get(PANE)!.at).toBe(START_MS);

  const t0 = Date.now();
  await core.clock.advance(ASK_POLL_MS);
  await until(() => asks.get(PANE)!.at > START_MS, { what: "the ask poll's next read" });
  const elapsed = Date.now() - t0;

  expect(asks.get(PANE)!.at).toBe(START_MS + ASK_POLL_MS);
  /* Far under the interval it just bought: if the poll were still on the real
   * clock this line could not pass, and if advance() had fired nothing the
   * until() above would have timed out instead. */
  expect(elapsed).toBeLessThan(ASK_POLL_MS);
  expect(core.clock.now()).toBe(START_MS + ASK_POLL_MS);
});

test("reset leaves no armed timers and no leftover clients", async () => {
  core = await wireCore({ with: ["sessions", "delivery"] });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  core.client();
  core.client();
  expect(clients.size).toBe(2);
  // the session graph really did arm module timers on the manual clock
  expect(core.clock.pending).toBeGreaterThan(0);

  /* Re-wired with NO layers, which is the honest leak check: the base wiring
   * arms no module timers at all, so anything still pending afterwards is a
   * timer the previous wiring left behind -- an ask poll, a context poll, a
   * grace clock. Zero is the whole assertion. */
  await core.reset({ with: [] });
  expect(core.clock.pending).toBe(0);
  expect(clients.size).toBe(0);
  expect(core.clients).toEqual([]);
  // and the module state went with them
  expect(core.sessions.size).toBe(0);

  // the re-wire is a working wiring, not a corpse: bring the graph back up
  await core.reset({ with: ["sessions"] });
  await until(() => core!.sessions.size === 1, { what: "the re-wired reconcile" });
  const c = core.client();
  await until(() => c.of("sessions").length > 0 || core!.sessions.size === 1);
});

test("two wireCores in one file do not see each other's state", async () => {
  const a = await wireCore({ panes: ["w1:p1"], with: ["sessions"] });
  await until(() => a.sessions.size === 1, { what: "A's pane to reconcile" });
  const ca = a.client();
  await until(() => ca.of("sessions").length > 0 || a.sessions.size === 1);
  const aDir = a.dir;
  const aRows = a.sessions.size;
  ca.clear();
  await a.stop();

  core = await wireCore({ panes: ["w8:p3", "w8:p4"], with: ["sessions"] });
  await until(() => core!.sessions.size === 2, { what: "B's panes to reconcile" });

  // B's rows are B's alone: A's pane is not in the map, and A's dir is not B's
  expect([...core.sessions.values()].map((s) => s.muxHandle).sort()).toEqual(["w8:p3", "w8:p4"]);
  expect(!!core.byHandle("w1:p1")).toBe(false);
  expect(core.dir).not.toBe(aDir);
  expect(aRows).toBe(1);
  // and A's client, dropped by A's stop(), hears nothing B says
  expect(ca.frames).toEqual([]);
  expect(clients.size).toBe(core.clients.length);
});
