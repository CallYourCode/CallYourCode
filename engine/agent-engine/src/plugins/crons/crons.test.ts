/* CRONS AS A FULL PLUGIN (blueprint section 2): the plugin owns the store, the
 * ticker, the fire wording and the seeding, over the minimal PluginHost.
 *
 * NOTHING HERE NEEDS AN ENGINE, and that is the point rather than a saving. The
 * crons plugin reaches the engine through exactly three verbs -- an engine-
 * scoped store, an agent-scoped store per agent, and `deliver()` with the
 * guardCwd identity check -- so a REAL host wired to a recording delivery is
 * the whole seam. A fake at that seam proves more than a boot does, because a
 * fake can be made to FAIL: the pane that has become a different conversation,
 * the session the engine has not snapshotted yet. A booted engine can only be
 * asked to succeed.
 *
 * The store's own arithmetic (fire-once, grace, backoff, lock) is
 * schedules.test.ts beside this one. The single wire-level fact -- the same rpc
 * ops travelling over the sealed DataChannel and the one /plugin/crons/rpc
 * route -- is e2e/crons-delivery.test.ts, and only that, because it is the only
 * claim here that cannot exist without the real transport.
 *
 * TIME IS THE MANUAL CLOCK. The plugin's first tick is deliberately ten seconds
 * late (see FIRST_TICK_DELAY_MS) and its ticker runs every fifteen; both go
 * through the injected clock, so a due schedule firing costs this file one
 * `advance()` and no wall time at all. The old version set an env var to cut
 * the first tick to 250ms and then polled with sleeps.
 *
 *   bun test agent-engine/src/plugins/crons/crons.test.ts
 */

import { test, expect, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePluginHost, type HostWiring } from "../platform/host.ts";
import type { PluginSpec, RpcCtx } from "../platform/spec.ts";
import { manualClock, type ManualClock } from "../../runtime/clock.ts";
import { until } from "../../test-utils/wait.ts";
import { TICK_MS } from "./schedules.ts";
import { bodyFor, cronsPlugin, noteFor } from "./index.ts";

/* ONE DATA DIR FOR THE FILE, set before any test runs and restored afterwards.
 *
 * datadir.ts reads CYC_DATA_DIR lazily on every path call, which is what makes
 * this safe to set once, and the convention is that no test mutates the
 * environment mid-file: a value a module has already read cannot be changed
 * underneath it honestly. Isolation between the tests here comes from the AGENT
 * instead, which is the axis the plugin's data actually lives on (the design's
 * two-axis rule): every test gets an agent id nothing else uses, so no two
 * tests can see each other's schedules however the directory is shared. */
const ROOT = mkdtempSync(join(tmpdir(), "cyc-crons-"));
const SAVED_DATA_DIR = process.env.CYC_DATA_DIR;
process.env.CYC_DATA_DIR = ROOT;

/** The engine-scoped lock, host-wide: one per data dir, whoever is firing. */
const LOCK = join(ROOT, "plugins", "crons", "schedules.lock");

afterAll(() => {
  if (SAVED_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = SAVED_DATA_DIR;
  rmSync(ROOT, { recursive: true, force: true });
});

let agentSeq = 0;
/** An agent id nothing else in this file uses. Must match datadir's AGENT_ID_RE. */
const freshAgent = () => `ag-t${++agentSeq}`;

const C = (agent: string | null, session: string | null = agent && "w1:p1"): RpcCtx =>
  ({ session, agent });

let specs: PluginSpec[] = [];

/* DISPOSAL IS AWAITED, because the lock is a file and `stop()` releases it
 * fire-and-forget. Two stores in one process are fine (the second recognises
 * its own pid on the lock and adopts it), but a release that lands AFTER the
 * next store claimed would unlink a lock somebody is holding, and the symptom
 * would be a later test refusing to write with no explanation. Waiting for the
 * file to go is one bounded poll and removes the whole class. */
async function disposeAll() {
  for (const sp of specs.splice(0)) sp.dispose?.();
  await until(async () => !(await Bun.file(LOCK).exists()),
    { what: "the schedule lock to be released" });
}

afterEach(disposeAll);

type Rig = {
  agent: string;
  clock: ManualClock;
  host: ReturnType<typeof makePluginHost>;
  spec: PluginSpec;
  rpc: NonNullable<PluginSpec["rpc"]>;
  /** every message that reached the engine's delivery primitive */
  delivered: Array<{ agent: string; msg: { how: string; note?: string; text: string } }>;
  logged: Array<{ event: string; fields: Record<string, unknown> }>;
  /** the plugin's own boot timer, then whatever the ticker does */
  firstTick(): Promise<void>;
  fileFor(agent: string): string;
};

async function plugin(wire: Partial<HostWiring> = {}): Promise<Rig> {
  await disposeAll();
  const agent = freshAgent();
  const clock = manualClock(Date.now());
  const delivered: Rig["delivered"] = [];
  const host = makePluginHost("crons", {
    sessionFor: wire.sessionFor ?? (() => ({ cwd: "/proj" })),
    deliverText: wire.deliverText ?? (async (a, m) => {
      delivered.push({ agent: a, msg: m });
      return { ok: true };
    }),
    /* The guard resolves both sides with realpath. Injected as identity so the
     * refusal is about the DIRECTORIES the test named and not about which of
     * them happens to exist on this box. */
    realPathOf: wire.realPathOf ?? (async (p: string) => p),
  });
  const logged: Rig["logged"] = [];
  const spec = cronsPlugin(host, { log: (event, fields) => logged.push({ event, fields }), clock });
  specs.push(spec);
  /* THE STORE IS LOADED BEFORE THE RIG IS HANDED OVER, and this line is not
   * tidiness. `cronsPlugin` starts load() and returns; load() takes the lock,
   * which means opening a file handle on it. A dispose that lands while that is
   * still in flight finds `owns` false, releases nothing, and leaves the handle
   * to be closed by the garbage collector -- which bun 1.4 raises as an
   * unhandled error that fails whichever test happens to be running at the
   * time. Every op awaits `ready` anyway; `count` is the one that does it
   * without seeding or writing. */
  await spec.rpc!.count(C(agent), undefined);
  return {
    agent, clock, host, spec, rpc: spec.rpc!, delivered, logged,
    /* The deliberately-late first tick, reached in logical time. Ten seconds is
     * the shipped delay: anything due while the engine was down is due the
     * instant it boots, and at that instant the mux has not answered yet. */
    async firstTick() { await clock.advance(10_000); },
    fileFor: (a: string) => join(ROOT, "agents", a, "plugins", "crons", "schedules.json"),
  };
}

/* ------------------------------------------------------------ rpc surface */

test("create then list: the schedule lands agent-keyed on disk and comes back shaped", async () => {
  const r = await plugin();
  const made = (await r.rpc.create(C(r.agent), {
    name: "morning", body: "the report", kind: "repeat", cron: "0 9 * * *",
  })) as any;
  expect(made.schedule.name).toBe("morning");
  expect(made.schedule.cron).toBe("0 9 * * *");
  const listed = (await r.rpc.list(C(r.agent), undefined)) as any;
  const own = listed.schedules.filter((s: any) => s.name === "morning");
  expect(own.length).toBe(1);
  expect(typeof listed.tz).toBe("string");
  expect(typeof listed.graceMs).toBe("number");
  expect(listed.readOnly).toBeNull();
  // agent-keyed on disk, in the agent's own crons dir, as a v2 file
  const disk = JSON.parse(await Bun.file(r.fileFor(r.agent)).text());
  expect(disk.v).toBe(2);
  const rec = Object.values(disk.schedules).find((x: any) => x.name === "morning") as any;
  expect(rec.agent).toBe(r.agent);
  expect(rec.sessionId).toBeUndefined();
});

test("one agent's schedules are invisible to another, however the store is shared", async () => {
  /* The store loads EVERY agent's file on this engine into one map, so "whose
   * is this" is a filter rather than a separate store, and a filter is a line
   * somebody can drop. A page that could see another conversation's schedules
   * could also see the bodies of them, which are the instructions he writes. */
  const r = await plugin();
  const mine = r.agent;
  const theirs = freshAgent();
  await r.rpc.create(C(mine), { name: "mine", body: "a", kind: "repeat", cron: "0 9 * * *" });
  await r.rpc.create(C(theirs), { name: "theirs", body: "b", kind: "repeat", cron: "0 9 * * *" });
  expect(((await r.rpc.list(C(mine), undefined)) as any).schedules.map((s: any) => s.name)).toEqual(["mine"]);
  expect(((await r.rpc.list(C(theirs), undefined)) as any).schedules.map((s: any) => s.name)).toEqual(["theirs"]);
  // and they are two files, not one with a discriminator in it
  expect(await Bun.file(r.fileFor(mine)).exists()).toBe(true);
  expect(await Bun.file(r.fileFor(theirs)).exists()).toBe(true);
});

test("update pauses and resumes; remove deletes; both only on the owning agent", async () => {
  const r = await plugin();
  const other = freshAgent();
  const id = ((await r.rpc.create(C(r.agent),
    { name: "x", body: "y", kind: "repeat", cron: "0 9 * * *" })) as any).schedule.id;
  await r.rpc.update(C(r.agent), { id, enabled: false });
  let listed = (await r.rpc.list(C(r.agent), undefined)) as any;
  expect(listed.schedules.find((s: any) => s.id === id).enabled).toBe(false);
  // another agent can neither edit nor remove it by guessing the id
  await expect(r.rpc.update(C(other), { id, enabled: true })).rejects.toThrow(/no such schedule/);
  await expect(r.rpc.remove(C(other), { id })).rejects.toThrow(/no such schedule/);
  expect((await r.rpc.remove(C(r.agent), { id })) as any).toEqual({ ok: true });
  listed = (await r.rpc.list(C(r.agent), undefined)) as any;
  expect(listed.schedules.find((s: any) => s.id === id)).toBeUndefined();
});

test("no session, or one the engine cannot resolve to an agent, is refused", async () => {
  const r = await plugin();
  await expect(r.rpc.list({ session: null, agent: null }, undefined)).rejects.toThrow(/needs a session/);
  await expect(r.rpc.list({ session: "w9:p9", agent: null }, undefined)).rejects.toThrow(/no such session/);
  // and so is every op that writes, not only the read
  await expect(r.rpc.create({ session: "w9:p9", agent: null },
    { name: "x", body: "y", kind: "repeat", cron: "0 9 * * *" })).rejects.toThrow(/no such session/);
  await expect(r.rpc.remove({ session: null, agent: null }, { id: "sch_anything" }))
    .rejects.toThrow(/needs a session/);
});

test("the store's own validation surfaces as a thrown rpc (empty name, bad cron)", async () => {
  const r = await plugin();
  await expect(r.rpc.create(C(r.agent), { name: "", body: "y", kind: "repeat", cron: "0 9 * * *" }))
    .rejects.toThrow(/needs a name/);
  await expect(r.rpc.create(C(r.agent), { name: "x", body: "", kind: "repeat", cron: "0 9 * * *" }))
    .rejects.toThrow(/needs a message/);
  await expect(r.rpc.create(C(r.agent), { name: "x", body: "y", kind: "repeat", cron: "not a cron" }))
    .rejects.toThrow(/not a cron/);
  // a one-off whose time has gone is refused rather than fired on save
  await expect(r.rpc.create(C(r.agent),
    { name: "x", body: "y", kind: "once", at: r.clock.now() - 1000 }))
    .rejects.toThrow(/already passed/);
  // and nothing that was refused is on disk
  expect(((await r.rpc.list(C(r.agent), undefined)) as any).schedules
    .filter((s: any) => s.name === "x")).toEqual([]);
});

test("preview answers with the same code that will fire it, and 400-shapes junk", async () => {
  const r = await plugin();
  const ok = (await r.rpc.preview(C(null, null), { cron: "0 7 * * *", tz: "UTC" })) as any;
  expect(ok.next.length).toBe(5);
  for (let i = 1; i < ok.next.length; i++) expect(ok.next[i]).toBeGreaterThan(ok.next[i - 1]);
  for (const t of ok.next) expect(new Date(t).getUTCHours()).toBe(7);
  await expect(r.rpc.preview(C(null, null), { cron: "nonsense" })).rejects.toThrow(/not a cron/);
  await expect(r.rpc.preview(C(null, null), { cron: "0 7 * * *", tz: "Not/AZone" }))
    .rejects.toThrow(/no such timezone/);
});

test("preview and the cursor agree: the first previewed time is the one that fires", async () => {
  /* PARITY, as an equality rather than as a shape. The panel draws the preview
   * and the store decides the fire, and if those are two opinions about what a
   * cron means then a person schedules one thing and gets another. They are the
   * same function, and this is the assertion that keeps them so. */
  const r = await plugin();
  const pv = (await r.rpc.preview(C(r.agent), { cron: "0 7 * * *", tz: "UTC" })) as any;
  const made = (await r.rpc.create(C(r.agent), {
    name: "standup", body: "write it", kind: "repeat", cron: "0 7 * * *", tz: "UTC",
  })) as any;
  expect(made.schedule.nextAt).toBe(pv.next[0]);
});

test("the badge op counts only enabled schedules, zero without an agent", async () => {
  const r = await plugin();
  expect((await r.rpc.count({ session: null, agent: null }, undefined)) as any).toEqual({ count: 0 });
  const id = ((await r.rpc.create(C(r.agent),
    { name: "a", body: "b", kind: "repeat", cron: "0 9 * * *" })) as any).schedule.id;
  await r.rpc.create(C(r.agent), { name: "c", body: "d", kind: "repeat", cron: "0 10 * * *" });
  expect((await r.rpc.count(C(r.agent), undefined)) as any).toEqual({ count: 2 });
  await r.rpc.update(C(r.agent), { id, enabled: false });
  expect((await r.rpc.count(C(r.agent), undefined)) as any).toEqual({ count: 1 });
  // and the badge is about THIS conversation, not the engine
  expect((await r.rpc.count(C(freshAgent()), undefined)) as any).toEqual({ count: 0 });
});

/* ----------------------------------------------------------------- seeding */

test("first list seeds the three DISABLED examples, exactly once, marker survives", async () => {
  const r = await plugin();
  const first = (await r.rpc.list(C(r.agent), undefined)) as any;
  expect(first.schedules.map((s: any) => s.name).sort())
    .toEqual(["due-today", "morning-report", "nudge"]);
  /* DISABLED, which is his call and not a detail: examples to see and switch
   * on, never schedules that start driving a session nobody asked to be
   * driven. */
  for (const s of first.schedules) expect(s.enabled).toBe(false);
  expect(await r.host.agentStore(r.agent).get("seeded")).toBe(true);
  // a second list does not seed again
  const again = (await r.rpc.list(C(r.agent), undefined)) as any;
  expect(again.schedules.length).toBe(3);
  // ...and deleting them all is respected forever after
  for (const s of again.schedules) await r.rpc.remove(C(r.agent), { id: s.id });
  expect(((await r.rpc.list(C(r.agent), undefined)) as any).schedules).toEqual([]);
});

test("the seeded examples survive a restart without being seeded twice", async () => {
  /* A RESTART IS A NEW PLUGIN OVER THE SAME DIRECTORY, which is exactly what a
   * fresh engine process is. The marker lives in the agent's own crons store,
   * so it comes back with the file; without it every boot would hand him three
   * more copies of the same three examples. */
  const r = await plugin();
  const agent = r.agent;
  await r.rpc.list(C(agent), undefined);
  const back = await plugin();
  const listed = (await back.rpc.list(C(agent), undefined)) as any;
  expect(listed.schedules.map((s: any) => s.name).sort())
    .toEqual(["due-today", "morning-report", "nudge"]);
});

test("an agent that already has schedules on disk is marked seeded without being touched", async () => {
  const r = await plugin();
  await r.rpc.create(C(r.agent),
    { name: "mine", body: "hand-made", kind: "repeat", cron: "0 9 * * *" });
  const listed = (await r.rpc.list(C(r.agent), undefined)) as any;
  expect(listed.schedules.map((s: any) => s.name)).toEqual(["mine"]);
  expect(await r.host.agentStore(r.agent).get("seeded")).toBe(true);
});

test("an agent that never lists is never seeded (the TEST-SINK case by construction)", async () => {
  const r = await plugin();
  const other = freshAgent();
  await r.rpc.list(C(r.agent), undefined); // only this agent ever opens the panel
  expect(await Bun.file(r.fileFor(other)).exists()).toBe(false);
  expect(await r.host.agentStore(other).get("seeded")).toBeNull();
});

/* --------------------------------------------------------------- migration */

test("a v1 sessionId-keyed file is rewritten v2 agent-keyed on load, idempotently", async () => {
  const agent = freshAgent();
  const file = join(ROOT, "agents", agent, "plugins", "crons", "schedules.json");
  await mkdir(join(ROOT, "agents", agent, "plugins", "crons"), { recursive: true });
  await Bun.write(file, JSON.stringify({
    v: 1,
    schedules: {
      sch_old1: { id: "sch_old1", sessionId: "w1:p1", name: "standup", body: "write it",
        kind: "repeat", cron: "0 7 * * *", tz: "UTC", enabled: true,
        createdAt: 1, nextAt: null, fires: 0, cwd: "/proj" },
    },
  }));
  // a fresh plugin instance over the same dir loads and migrates
  const back = await plugin();
  const listed = (await back.rpc.list(C(agent), undefined)) as any;
  expect(listed.schedules.map((s: any) => s.name)).toEqual(["standup"]);
  const disk = JSON.parse(await Bun.file(file).text());
  expect(disk.v).toBe(2);
  expect(disk.schedules.sch_old1.agent).toBe(agent);
  expect(disk.schedules.sch_old1.sessionId).toBeUndefined();
  expect(disk.schedules.sch_old1.cwd).toBe("/proj"); // the guard survives the rewrite
  // idempotent: a third instance reads the v2 file and changes nothing
  const third = await plugin();
  const again = (await third.rpc.list(C(agent), undefined)) as any;
  expect(again.schedules.map((s: any) => s.name)).toEqual(["standup"]);
  expect(JSON.parse(await Bun.file(file).text()).schedules.sch_old1.agent).toBe(agent);
});

/* ------------------------------------------------- the fire, through deliver */

test("a due schedule fires through host.deliver as SCHEDULED, guardCwd riding along", async () => {
  const r = await plugin();
  // a once already due when the plugin's own deliberately-late first tick runs
  await r.rpc.create(C(r.agent), {
    name: "soon", body: "do the thing", kind: "once", at: r.clock.now() + 100, cwd: "/proj",
  });
  await r.firstTick();
  await until(() => r.delivered.length > 0, { what: "the schedule to fire" });
  expect(r.delivered[0].agent).toBe(r.agent);
  expect(r.delivered[0].msg.how).toBe("SCHEDULED");
  expect(r.delivered[0].msg.text).toBe("do the thing");
  expect(r.delivered[0].msg.note).toContain("soon");
  // the cwd matched, so the guard passed rather than being absent
  const row = ((await r.rpc.list(C(r.agent), undefined)) as any).schedules[0];
  expect(row.done).toBe(true);
});

test("a fire against a pane that is a different conversation now is refused, not typed", async () => {
  /* THE GUARD, and it is the whole reason a schedule carries a directory. A
   * pane id is the engine's handle for a session, not a promise about identity:
   * if one ever comes back on a different pane, a schedule keyed only on it
   * types "write the standup" into somebody else's conversation. */
  const typed: string[] = [];
  const r = await plugin({
    sessionFor: () => ({ cwd: "/somewhere/else" }),
    deliverText: async (_a, m) => { typed.push(m.text); return { ok: true }; },
  });
  await r.rpc.create(C(r.agent), {
    name: "guarded", body: "secret standup", kind: "once", at: r.clock.now() + 100, cwd: "/proj",
  });
  await r.firstTick();
  /* The guard is fatal (not retriable): the once spends its slot on the
   * refusal (done at the claim) and NOTHING is ever typed into the pane. */
  await until(async () => {
    const row = ((await r.rpc.list(C(r.agent), undefined)) as any)
      .schedules.find((s: any) => s.name === "guarded");
    return !!row?.done;
  }, { what: "the once to claim its slot" });
  expect(typed).toEqual([]);
  // ...and it is not retried either: the pane will not turn back into that chat
  await r.clock.advance(4 * TICK_MS);
  expect(typed).toEqual([]);
});

test("a fire with no live session is retriable, and lands when the session is back", async () => {
  /* THE OTHER REFUSAL, and it is deliberately a different one. An agent this
   * engine has no session for may simply not have been snapshotted yet -- a
   * fire in the first seconds after a restart looks exactly like this -- so it
   * is retriable, and the ladder in schedules.ts absorbs it. Answering the same
   * way as the wrong-conversation guard would either lose the message or type
   * it into the wrong chat, depending on which way it was wrong. */
  const typed: string[] = [];
  let live = false;
  const r = await plugin({
    sessionFor: () => (live ? { cwd: "/proj" } : null),
    deliverText: async (_a, m) => { typed.push(m.text); return { ok: true }; },
  });
  await r.rpc.create(C(r.agent), {
    name: "waiting", body: "the morning plan", kind: "once", at: r.clock.now() + 100,
  });
  await r.firstTick();
  await until(async () => {
    const row = ((await r.rpc.list(C(r.agent), undefined)) as any)
      .schedules.find((s: any) => s.name === "waiting");
    return row?.overdueMs !== undefined && row.overdueMs !== null;
  }, { what: "the fire to be recorded as still trying" });
  expect(typed).toEqual([]);

  /* The session comes back, and the message lands. Every poll of `until` moves
   * logical time on by one tick and then gives the real file I/O inside that
   * tick a turn to finish, which is the only thing here that takes actual
   * milliseconds. */
  live = true;
  await until(async () => {
    await r.clock.advance(TICK_MS);
    return typed.length > 0;
  }, { what: "the message to land once the pane is back" });
  expect(typed).toEqual(["the morning plan"]);
});

/* ------------------------------------------------------------ fire wording */

test("the lateness ladder: on time says nothing, late says how late, a day is a status line", async () => {
  const sc: any = { name: "standup", body: "write it", tz: "UTC", kind: "repeat", cron: "0 7 * * *" };
  const fire = (lateMs: number, missed = 0, tryN = 1) =>
    ({ due: Date.UTC(2026, 7, 4, 7, 0), at: 0, lateMs, missed, try: tryN });
  // on time (under five minutes): the name alone, the body verbatim
  expect(noteFor(sc, fire(0))).toBe("standup");
  expect(bodyFor(sc, fire(0))).toBe("write it");
  expect(noteFor(sc, fire(4 * 60_000))).toBe("standup"); // still inside "on time"
  // late past five minutes: says how late
  expect(noteFor(sc, fire(10 * 60_000))).toContain("delivered 10 min late");
  expect(noteFor(sc, fire(10 * 60_000))).toContain("2026-08-04 07:00 UTC");
  // missed runs merge with a count, and one of them is a "run" and not "runs"
  expect(noteFor(sc, fire(10 * 60_000, 3))).toContain("3 earlier runs were missed");
  expect(noteFor(sc, fire(10 * 60_000, 1))).toContain("1 earlier run ");
  // a retry names its attempt
  expect(noteFor(sc, fire(0, 0, 2))).toContain("attempt 2");
  // a day stale: the body is replaced by a status line naming the schedule
  const stale = fire(25 * 3_600_000);
  expect(bodyFor(sc, stale)).toContain("more than a day ago");
  expect(bodyFor(sc, stale)).toContain("0 7 * * *");
  expect(noteFor(sc, stale)).toBe("standup"); // no lateness line on top of a status body
  // ...and a one-off past a day says it was a one-off rather than promising more
  const once: any = { name: "call mum", body: "call her", tz: "UTC", kind: "once" };
  expect(bodyFor(once, stale)).toContain("It was a one-off.");
});
