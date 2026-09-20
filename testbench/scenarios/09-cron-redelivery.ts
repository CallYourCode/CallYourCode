/* 9. cron redelivery (design 9, scenario 9)
 *
 * given  a bound row with a one-off schedule due in 20 s, and the harness
 *        busy on a long turn across the due moment
 * when   the schedule fires
 * then   exactly one delivery, after the turn edge: one user turn in the
 *        transcript holds the body, the fake model served it once, the
 *        engine logged one schedule.delivered.
 *
 * variant: the harness is dead when the schedule fires; once relaunched the
 *        body is delivered exactly once (retry, not duplicate, not lost). */

import type { Cell } from "../cell/driver.ts";
import { bringUp, resumeIdOf, userTurnsWith, waitOffline, waitServed, SPEC } from "./_lib.ts";

const WINDOW_MS = 120_000; // firing (due 20 s, tick 15 s) + a 45 s busy turn + slack

export default async function (c: Cell) {
  const W = c.paths.work;
  const { pane, row, transcript } = await bringUp(c);
  c.need("a bound row", !!row);
  const w = await c.wire();
  await w.attach(row!.id); // the app is open on the row: chat rows flow on the wire
  const engine = c.engine();

  const create = async (name: string, body: string, inMs: number) => {
    const r = await w.req("POST", "/plugin/crons/rpc/create", { session: row!.id, args: { name, body, kind: "once", at: Date.now() + inMs, enabled: true } });
    const schedule = r.body?.result?.schedule ?? r.body?.schedule;
    c.need(`schedule ${name} created over the wire (status ${r.status})`, r.status === 200 && !!schedule?.id, JSON.stringify(r.body).slice(0, 300));
    return schedule;
  };
  /* the engine's cron lines name the schedule by id, never by body */
  const evidence = async (body: string, since: number, scheduleId: string) => {
    const lines = engine.since(since);
    const forIt = (l: string) => l.includes(`"schedule":"${scheduleId}"`) || l.includes(scheduleId);
    const disk = c.chatLog(String(row!.sessionAgentId ?? "")).filter((m) => m.role === "user" && String(m.text ?? "").includes(body));
    const wireRows = w.chatRows(row!.id).filter((f) => f.role === "user" && String(f.text ?? "").includes(body));
    return {
      turns: await userTurnsWith(c, body),
      served: c.fake().requestsWith(body),
      firing: lines.filter((l) => l.includes("schedule.firing") && forIt(l)).length,
      delivered: lines.filter((l) => /schedule\.delivered/.test(l) && forIt(l)).length,
      undelivered: lines.filter((l) => /schedule\.undelivered|schedule\.abandoned|schedule\.retry|schedule\.failed/.test(l) && forIt(l)).length,
      rows: disk.length ? disk : wireRows,
      rowSource: disk.length ? "chat log on disk" : wireRows.length ? "wire (no chat file on disk)" : "none",
    };
  };

  /* part 1: due while busy */
  const body1 = `cron body busy 09 ${Date.now() % 100000}`;
  const t0 = Date.now();
  const s1 = await create("tb-09-busy", body1, 20_000);
  await c.type(pane, "LONG-TURN please 09");
  const busy = await w.waitRow((r) => r.cwd === W && r.thinking === true, { ms: 15_000, label: "row thinking on the long turn" });
  c.expect("the harness is busy (thinking) when the schedule comes due", !!busy, busy ? "row thinking=true on the long turn" : "row never showed thinking");
  const longReq = await c.fake().waitRequest((q) => q.lastUser.includes("LONG-TURN"), 20_000);
  const turnEnd = (longReq?.ts ?? Date.now()) + 30 * 1500;
  const fired = await c.waitFor(() => engine.since(t0).find((l) => l.includes("schedule.firing")) ?? null, { ms: 60_000, label: "schedule.firing" });
  c.expect("the schedule fired while the turn was still streaming", !!fired && Number(fired.split(" ")[0]) < turnEnd, fired ? `fired at ${fired.split(" ")[0]}, turn ends ~${turnEnd}` : "never fired");
  const landed1 = await c.waitFor(async () => ((await userTurnsWith(c, body1)) > 0 ? true : null), { ms: WINDOW_MS, label: "cron body in transcript" });
  if (landed1) await waitServed(c, body1);
  await Bun.sleep(4000);
  await c.snap("after-busy-cron", pane.id);
  const e1 = await evidence(body1, t0, String(s1.id));
  const landedReq = e1.served[0];
  c.expect("the body reached the transcript", !!landed1, `turns=${e1.turns}`);
  c.expect("delivered after the turn edge (the model saw it only once the long turn had ended)", !!landedReq && landedReq.ts >= turnEnd - 2000,
    landedReq ? `served at ${landedReq.ts}, long turn ended ~${turnEnd} (${landedReq.ts - turnEnd} ms after)` : "never served");
  c.expect("exactly one user turn in the transcript holds the body", e1.turns === 1, `${e1.turns} turns; engine firing=${e1.firing} delivered=${e1.delivered} undelivered/retry=${e1.undelivered}`);
  c.expect("the engine logged exactly one schedule.delivered for it", e1.delivered === 1, `delivered lines=${e1.delivered} firing=${e1.firing}`);
  c.expect("the chat log holds exactly one scheduled user row for it", e1.rows.length === 1 && !!e1.rows[0].scheduled, `rows=${e1.rows.length} (${e1.rowSource}) scheduled=${JSON.stringify(e1.rows[0]?.scheduled ?? null)}`);

  /* part 2: due while the harness is dead, delivered once on relaunch */
  const body2 = `cron body dead 09 ${Date.now() % 100000}`;
  const t1 = Date.now();
  const s2 = await create("tb-09-dead", body2, 20_000);
  await c.killHarnessProcess(pane);
  await waitOffline(c, W, SPEC.pollMs + 4000);
  const fired2 = await c.waitFor(() => engine.since(t1).find((l) => l.includes("schedule.firing") && l.includes(String(s2.id))) ?? null, { ms: 60_000, label: "second schedule.firing" });
  c.expect("the second schedule fired while the harness was dead", !!fired2, "never fired");
  await Bun.sleep(1500);
  const turnsWhileDead = await userTurnsWith(c, body2);
  c.expect("nothing landed while dead", turnsWhileDead === 0, `${turnsWhileDead} turns`);
  await c.waitScreen(pane.id, /[#$] ?$/m, 5000).catch(() => null); // the pane's shell prompt is back
  await c.launch(pane, { resume: resumeIdOf(row, transcript) || undefined });
  await w.waitRow((r) => r.cwd === W && r.alive !== false, { ms: SPEC.bringUpMs + 5000, label: "row live again" });
  const landed2 = await c.waitFor(async () => ((await userTurnsWith(c, body2)) > 0 ? true : null), { ms: 120_000, label: "dead-time cron body in transcript after relaunch" });
  if (landed2) await waitServed(c, body2);
  await Bun.sleep(4000);
  await c.snap("after-dead-cron", pane.id);
  const e2 = await evidence(body2, t1, String(s2.id));
  c.expect("the dead-time schedule is delivered once the harness is back (retry within 2 h grace)", !!landed2, `turns=${e2.turns} firing=${e2.firing} delivered=${e2.delivered} undelivered/retry=${e2.undelivered}`);
  c.expect("exactly one user turn holds the dead-time body", e2.turns === 1, `${e2.turns} turns`);
  c.expect("exactly one schedule.delivered for the dead-time body", e2.delivered === 1, `delivered=${e2.delivered}`);
}
