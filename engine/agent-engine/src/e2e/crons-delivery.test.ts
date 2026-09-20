/* THE SCHEDULES VERTICAL, THROUGH A REAL ENGINE, END TO END.
 *
 * WHAT THE BOOT IS BUYING. crons.test.ts drives the plugin's rpc surface against
 * an in-process PluginHost with a fake deliverText, and that is the right place
 * for the store's arithmetic, the seeding and the lateness wording. It cannot
 * reach the two things below, and they are the two that broke in production:
 *
 *   - THE FIRE GOES ALL THE WAY INTO A PANE. The plugin calls host.deliver, the
 *     host resolves the agent to a live session and checks guardCwd, server.ts
 *     hands it to deliverToAgent, and deliverToAgent types it into herdr and
 *     presses enter. A fake deliverText records that the plugin ASKED. Only the
 *     fake herdr over its real socket can say what the agent RECEIVED -- and
 *     `submitted` is the only thing that can, because an enter into an emptied
 *     box types nothing and submits nothing.
 *   - THE AGENT ID IS DERIVED AT RUNTIME. A schedule is keyed on the stable
 *     agent id the rpc ctx carries, and that id only exists once the engine has
 *     snapshotted herdr. A seam test hands itself a made-up "ag-testagent1"; a
 *     boot has to resolve the session -> agent -> its own crons directory, and
 *     the record has to land in THAT directory before the rpc answers.
 *
 * The lateness ladder's later rungs (past five minutes, missed runs, retries)
 * cannot be produced through a real boot inside a test budget: `create` refuses
 * a time that has already passed, on purpose, and the tick interval is 15s. Its
 * FIRST rung can be, and is asserted here on the wire: an on-time fire says the
 * name and nothing else, and the body rides verbatim. The rest of the ladder
 * stays in the unit test that drives noteFor/bodyFor directly.
 *
 * Sources carried across: crons.test.ts's "the wire: the whole vertical through
 * a real engine's one rpc route" (ported whole, its text kept), its "a due
 * schedule fires through host.deliver as SCHEDULED, guardCwd riding along", its
 * "a fire against a pane that is a different conversation now is refused, not
 * typed", and the on-time rung of "the lateness ladder".
 *
 *   bun test --preload ./e2e/testpreload.ts e2e/crons-delivery.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { startEngine, PANE, HARNESS_CWD, defaultSessionIdOf, metaForSession, type Engine } from "./harness.ts";

let engine: Engine | null = null;
afterEach(async () => {
  await engine?.stop();
  engine = null;
});

async function until<T>(f: () => T | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`never happened within ${ms}ms: ${what}`);
    await Bun.sleep(50);
  }
}

const cron = (e: Engine, op: string, args: unknown = null) =>
  fetch(`${e.http}/plugin/crons/rpc/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: PANE, args }),
  }).then((r) => r.json() as Promise<any>);

test("the wire: the whole vertical through a real engine's one rpc route", async () => {
  engine = await startEngine();
  const e = engine;
  await e.session();

  // first list seeds the disabled examples
  const first = await cron(e, "list");
  expect(first.ok).toBe(true);
  expect(first.result.schedules.map((s: any) => s.name).sort())
    .toEqual(["due-today", "morning-report", "nudge"]);

  // create, and it is on disk agent-keyed before the reply
  const made = await cron(e, "create", { name: "standup", body: "write it", kind: "repeat", cron: "0 7 * * *" });
  expect(made.ok).toBe(true);
  // the record is keyed by the harness id the pane reports, never the pane
  const meta = await metaForSession(e.dir, defaultSessionIdOf(PANE));
  const file = `${e.dir}/data/agents/${meta!.agentId}/plugins/crons/schedules.json`;
  const disk = JSON.parse(await Bun.file(file).text());
  expect(disk.v).toBe(2);
  const rec = Object.values(disk.schedules).find((r: any) => r.name === "standup") as any;
  expect(rec.agent).toBe(meta!.agentId);

  // the old routes are GONE: the sideband answers 404 for them
  expect((await fetch(`${e.http}/session/${PANE}/schedules`)).status).toBe(404);
  expect((await fetch(`${e.http}/schedules/preview?cron=${encodeURIComponent("0 7 * * *")}&tz=UTC`)).status).toBe(404);

  // preview rides the same rpc route
  const pv = await cron(e, "preview", { cron: "0 7 * * *", tz: "UTC" });
  expect(pv.ok).toBe(true);
  expect(pv.result.next.length).toBe(5);
}, 60_000);

test("a due schedule fires through host.deliver into the pane as SCHEDULED, guardCwd riding along", async () => {
  /* THE FIRST TICK IS LATE ON PURPOSE (the plugin's own comment): anything due
   * while the engine was down is due the instant it boots, before herdr has
   * answered, so the loop waits. Eight seconds is comfortably past the boot and
   * past the two rpc calls below, and it is the only window in which a schedule
   * created after the engine is listening can still catch the FIRST tick -- the
   * one after it is fifteen wall seconds away. */
  engine = await startEngine({ env: { CYC_CRONS_FIRST_TICK_MS: "8000" } });
  const e = engine;
  await e.session();
  await cron(e, "list"); // seeds, and resolves the agent, before anything is due

  /* THE GUARD RIDES ON THE RECORD, not on the pane id. A pane id is the
   * engine's handle and not a promise about identity: if one can ever come back
   * on a different pane, a schedule keyed only on it types this conversation's
   * standup into somebody else's. `cwd` is what the fire checks, on both sides
   * resolved, and the fake pane reports HARNESS_CWD. */
  const good = await cron(e, "create", {
    name: "soon", body: "do the thing", kind: "once",
    at: Date.now() + 1_000, cwd: HARNESS_CWD,
  });
  expect(good.ok, `the due schedule was refused: ${JSON.stringify(good)}`).toBe(true);

  /* ...AND THE SAME SCHEDULE POINTED SOMEWHERE ELSE MUST TYPE NOTHING. Without
   * this the guard could be a field nobody reads: a fire that lands either way
   * proves only that a fire lands. */
  const wrong = await cron(e, "create", {
    name: "elsewhere", body: "secret standup", kind: "once",
    at: Date.now() + 1_000, cwd: "/definitely/not/this/conversation",
  });
  expect(wrong.ok).toBe(true);

  /* WHAT THE AGENT ACTUALLY RECEIVED. Not `typed`, which is what the engine
   * asked herdr for: a real enter is what puts a line into claude, and only
   * `submitted` records one. */
  const line = await until(
    () => e.submitted().find((t) => t.includes("do the thing")), 25_000,
    "the due schedule to be typed and submitted into the pane");

  /* THE ON-TIME RUNG OF THE LADDER (his ladder, 2026-08-09): the name, always,
   * because that is the identifier a job is known by -- and then nothing else,
   * because a run inside five minutes of its slot has nothing unusual to say.
   * The body rides verbatim. This is the delivered line byte for byte, so a
   * lateness clause creeping onto an on-time fire fails here. */
  expect(line, "the delivered line is not the on-time SCHEDULED shape")
    .toBe("SCHEDULED (soon): do the thing");

  /* THE GUARDED ONE HAS TO HAVE HAD ITS TURN before the silence below means
   * anything. The tick works through the due list serially, so finding "soon"
   * submitted says nothing about whether "elsewhere" has been reached yet, and
   * asserting "nothing was typed" at that moment would pass against an engine
   * with no guard at all.
   *
   * The refusal is FATAL, not retriable: the once spends its slot at the claim,
   * so `done` going true IS the record of it having been tried and refused. */
  let row: any;
  const end = Date.now() + 25_000;
  for (;;) {
    const listed = await cron(e, "list");
    row = listed.result.schedules.find((s: any) => s.name === "elsewhere");
    if (row?.done) break;
    if (Date.now() > end) throw new Error("the guarded once never claimed its slot");
    await Bun.sleep(100);
  }
  expect(row.done, "the guarded once must spend its slot on the refusal, not retry for ever").toBe(true);

  // ...and the pane never saw the other conversation's message, and never will
  expect(e.submitted().some((t) => t.includes("secret standup")),
    "the cwd guard let a schedule for another conversation into this pane").toBe(false);
  expect(e.typed().some((t) => t.includes("secret standup")),
    "the guarded fire typed the body and then failed to press enter, which strands it in the box")
    .toBe(false);
}, 60_000);
