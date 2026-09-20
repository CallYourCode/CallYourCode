/* 11. attach-slot leak (design 9, scenario 11; TODOS bug #6)
 *
 * given  a bound row with the terminal viewer open on it (the engine has
 *        spawned its bridge onto the pane: `herdr terminal session control
 *        <pane> --takeover` on herdr, a capture loop on tmux)
 * when   the engine is SIGKILLed and rebooted on the same data dir
 * then   no bridge from the dead engine survives (nothing squatting the
 *        pane's attach slot: no orphan `herdr terminal session control`),
 *        and a new viewer opens cleanly: frames flow, no term-closed with a
 *        takeover / already-attached error. Evidence: the cell's process
 *        table, the sealed-wire term-* frames, the engine log. */

import type { Cell } from "../cell/driver.ts";
import { bringUp, stableIdOf, SPEC } from "./_lib.ts";

const BRIDGE = /herdr terminal session control|tmux .*(capture-pane|control-mode|-C\b)/;

export default async function (c: Cell) {
  const W = c.paths.work;
  const { pane, row } = await bringUp(c);
  c.need("a bound row", !!row);
  const X = stableIdOf(row);
  let w = await c.wire();

  /* a viewer opens: the engine's bridge onto the pane appears */
  const open = async (label: string) => {
    const seq = w.frames.length;
    const first = w.waitFrame((f) => (f.t === "term-frame" || f.t === "term-closed" || f.t === "term-size") && f.id === row!.id, { ms: 15_000, label: `${label}: first term frame` });
    w.say({ t: "term-open", id: row!.id, cols: 100, rows: 30, dev: `tb-11-${label}` });
    const f = await first;
    await Bun.sleep(1500);
    const frames = w.frames.slice(seq).filter((x) => String(x.t).startsWith("term-") && x.id === row!.id);
    return { first: f, frames, closed: frames.find((x) => x.t === "term-closed") ?? null, painted: frames.some((x) => x.t === "term-frame") };
  };
  const enginePid = c.engine().pid;
  const v1 = await open("before");
  const bridgesBefore = c.procs().filter((p) => BRIDGE.test(p.args));
  c.expect("the viewer paints (term-frame arrives) before the reboot", v1.painted && !v1.closed, v1.closed ? `term-closed: ${JSON.stringify(v1.closed.why)}` : `${v1.frames.length} term frames`);
  c.log(`bridge processes before kill: ${JSON.stringify(bridgesBefore.map((p) => ({ pid: p.pid, ppid: p.ppid, args: p.args.slice(0, 90) })))} (engine pid ${enginePid})`);
  if (c.muxKind === "herdr") c.expect("the engine spawned the herdr control bridge for the viewer", bridgesBefore.some((p) => /herdr terminal session control/.test(p.args)), `procs: ${c.procs().filter((p) => /herdr/.test(p.args)).map((p) => p.args.slice(0, 80)).join(" | ")}`);
  /* under tmux the engine's viewer is a capture loop inside the engine: no
   * bridge process ever appears (BRIDGE matched nothing with the viewer
   * open), so the process-table checks have nothing to judge and are
   * recorded as skipped, never as `[] === []` passes */
  const noBridge = c.muxKind === "tmux" && bridgesBefore.length === 0;
  const bridgeCheck = (name: string, ok: boolean, detail: string) => noBridge ? c.skip(name, "no bridge process under tmux") : c.expect(name, ok, detail);

  /* when: SIGKILL the engine with the viewer open, reboot on the same data */
  await c.killEngine();
  await Bun.sleep(3000);
  const orphans = c.procs().filter((p) => BRIDGE.test(p.args));
  bridgeCheck("no bridge from the dead engine survives the SIGKILL (the attach slot is free)", orphans.length === 0,
    orphans.length ? `orphans: ${JSON.stringify(orphans.map((p) => ({ pid: p.pid, ppid: p.ppid, args: p.args.slice(0, 100) })))}` : "process table clean");
  await c.startEngine({ keepData: true });
  w = await c.wire();
  const back = await w.waitRow((r) => r.cwd === W && r.alive !== false, { ms: SPEC.bringUpMs + 5000, label: "row after reboot" });
  c.expect("the same row is back after the reboot", !!back && stableIdOf(back) === X && back.id === row!.id, `before id=${row!.id} agent=${X}; after ${back ? `id=${back.id} agent=${stableIdOf(back)}` : "none"}`);

  /* then: a new viewer opens cleanly */
  const v2 = await open("after");
  await c.snap("viewer-after-reboot", pane.id);
  const errs = c.engine().since(Date.now() - 20_000).filter((l) => /takeover|already attached|attach slot|slot|control session.*(exists|busy|rejected)/i.test(l));
  c.expect("a new viewer opens without a takeover / already-attached refusal", v2.painted && !v2.closed,
    v2.closed ? `term-closed: ${JSON.stringify(v2.closed.why)}` : v2.painted ? `${v2.frames.length} term frames` : "nothing painted within 15 s");
  c.expect("the engine log has no takeover / attach-slot error after the reboot", errs.length === 0, errs.slice(0, 3).join(" | "));
  const bridgesAfter = c.procs().filter((p) => BRIDGE.test(p.args));
  bridgeCheck("exactly the new engine's bridge is on the pane (no stale one beside it)", bridgesAfter.length <= 1 && bridgesAfter.every((p) => p.ppid !== enginePid),
    JSON.stringify(bridgesAfter.map((p) => ({ pid: p.pid, ppid: p.ppid, args: p.args.slice(0, 90) }))));
  w.say({ t: "term-close", id: row!.id });
  await Bun.sleep(1000);
  const afterClose = c.procs().filter((p) => BRIDGE.test(p.args));
  bridgeCheck("closing the viewer releases the bridge", afterClose.length === 0, JSON.stringify(afterClose.map((p) => p.args.slice(0, 90))));

  /* the other leak path in the bug report: the viewer's connection drops with
   * no term-close (phone locks, app navigates away); the bridge must not
   * squat the pane's attach slot for the next viewer */
  const v3 = await open("before-drop");
  c.expect("a viewer paints before the unclean drop", v3.painted && !v3.closed, v3.closed ? `term-closed: ${JSON.stringify(v3.closed.why)}` : `${v3.frames.length} term frames`);
  w.close();
  await Bun.sleep(5000);
  const afterDrop = c.procs().filter((p) => BRIDGE.test(p.args));
  bridgeCheck("an unclean viewer drop (no term-close) releases the bridge within 5 s", afterDrop.length === 0, JSON.stringify(afterDrop.map((p) => ({ pid: p.pid, ppid: p.ppid, args: p.args.slice(0, 90) }))));
  await w.reopen();
  const v4 = await open("after-drop");
  c.expect("the next viewer opens after the drop without a takeover / already-attached refusal", v4.painted && !v4.closed, v4.closed ? `term-closed: ${JSON.stringify(v4.closed.why)}` : `${v4.frames.length} term frames`);
  w.say({ t: "term-close", id: row!.id });
}
