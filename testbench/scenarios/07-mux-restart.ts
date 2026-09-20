/* 7. mux restart (design 9, scenario 7)
 *
 * given  a bound row
 * when   the mux server dies (tmux kill-server / herdr server stop) and a
 *        new server comes up on the same socket
 * then   the rows go offline (no rows vanish, no new agent ids), and a
 *        harness relaunched in the new server with --resume is re-adopted
 *        by its old agent. */

import type { Cell } from "../cell/driver.ts";
import { bringUp, resumeIdOf, rowsFor, sendFromApp, sidOf, stableIdOf, waitOffline, SPEC } from "./_lib.ts";

export default async function (c: Cell) {
  const W = c.paths.work;
  const { row, transcript } = await bringUp(c);
  c.need("a bound row", !!row);
  const w = await c.wire();
  const X = stableIdOf(row);
  const A = resumeIdOf(row, transcript);
  const agentsBefore = c.agents().map((a) => a.id).sort();

  /* when: the mux server dies and comes back empty */
  const killedAt = Date.now();
  await c.mux().restart();
  c.log(`mux ${c.muxKind} restarted`);
  const off = await waitOffline(c, W, SPEC.pollMs + 6000);
  c.expect("the row goes offline after the mux server dies", !!off, off ? `no live row ${off.at - killedAt} ms after kill-server` : `still live: ${JSON.stringify(rowsFor(w.sessions(), W).map((r) => ({ id: r.id, alive: r.alive })))}`);
  c.expect("the row is still listed (alive:false, not gone)", !!off && !off.vanished, off?.vanished ? "the row VANISHED from the list" : `${rowsFor(w.sessions(), W).length} rows for ${W}`);
  const agentsMid = c.agents().map((a) => a.id).sort();
  c.expect("no new agent ids from the mux restart", JSON.stringify(agentsMid) === JSON.stringify(agentsBefore), `before=${agentsBefore.join(",")} after=${agentsMid.join(",")}`);
  const errs = c.engine().since(killedAt).filter((l) => /unhandled|uncaught|TypeError|ECONNREFUSED/i.test(l));
  const healthy = await c.engine().get("/health").then((r) => r.ok).catch(() => false);
  c.expect("the engine survived the mux going away (healthy, no unhandled errors)", healthy && errs.length === 0, `health=${healthy} ${errs.slice(0, 3).join(" | ")}`);

  /* relaunch in the new server with --resume */
  const p2 = await c.openPane({ cwd: W });
  await c.launch(p2, { resume: A || undefined });
  const back = await w.waitRow((r) => r.cwd === W && r.alive !== false, { ms: SPEC.bringUpMs + 5000, label: "row live in the new server" });
  await c.snap("relaunched", p2.id);
  c.expect("the relaunched harness is re-adopted by its old agent (same agent id)", !!back && stableIdOf(back) === X, `X=${X} now=${back ? stableIdOf(back) : "none"} sid=${sidOf(back)}; rows=${JSON.stringify(rowsFor(w.sessions(), W).map((r) => ({ id: r.id, alive: r.alive, sid: sidOf(r) })))}`);
  c.expect("still one row for the cwd", rowsFor(w.sessions(), W).length === 1, `${rowsFor(w.sessions(), W).length} rows`);
  const agentsAfter = c.agents().map((a) => a.id).sort();
  c.expect("no new agent ids after the relaunch", JSON.stringify(agentsAfter) === JSON.stringify(agentsBefore), `before=${agentsBefore.join(",")} after=${agentsAfter.join(",")}`);

  /* and delivery works in the new server */
  const s = await sendFromApp(c, back ?? row!, `after mux restart 07 ${Date.now() % 100000}`);
  const landed = await c.waitFor(() => s.landedInTranscript(), { ms: 30_000, label: "delivery after mux restart" });
  c.expect("delivery lands in the relaunched harness", !!landed, landed ? `${landed.path}` : "did not land");
}
