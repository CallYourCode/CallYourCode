/* 3. disconnect (design 9, scenario 3)
 *
 * given  a bound row
 * when   the harness process dies (SIGKILL, the pane's shell survives)
 * then   the row shows alive:false within one list-panes poll; a message sent
 *        meanwhile is held (outbox), not dropped; relaunching the harness
 *        with --resume in the SAME pane re-binds, the held message lands,
 *        and the agent id is unchanged. */

import type { Cell } from "../cell/driver.ts";
import { bringUp, resumeIdOf, rowsFor, sendFromApp, sidOf, stableIdOf, waitOffline, SPEC } from "./_lib.ts";

export default async function (c: Cell) {
  const { pane, row, transcript } = await bringUp(c);
  c.need("a bound row", !!row);
  const w = await c.wire();
  const agentId = stableIdOf(row);
  const resumeId = resumeIdOf(row, transcript);

  /* when: the harness dies under the pane's shell */
  const killedAt = Date.now();
  const pids = await c.killHarnessProcess(pane);
  c.need("a harness process was under the pane's shell", pids.length > 0);
  const off = await waitOffline(c, c.paths.work, SPEC.pollMs + 2000);
  await c.snap("after-kill", pane.id);
  c.expect("row shows alive:false within one poll (4 s), still listed", !!off && !off.vanished && off.at - killedAt <= SPEC.pollMs,
    off ? (off.vanished ? `the row VANISHED from the list ${off.at - killedAt} ms after SIGKILL (spec: stays, alive:false)` : `alive:false ${off.at - killedAt} ms after SIGKILL`)
      : `still live after ${SPEC.pollMs + 2000} ms: ${JSON.stringify(rowsFor(w.sessions(), c.paths.work).map((r) => ({ id: r.id, alive: r.alive })))}`);

  /* a message while it is dead: held, not dropped (sent to the row id the app still shows) */
  const text = `while dead 03 ${Date.now() % 100000}`;
  const target = off?.row ?? row!;
  const s = await sendFromApp(c, target, text);
  await Bun.sleep(2500);
  const held = s.chatRows().find((f) => f.role === "user");
  const notice = w.chatRows(target.id, s.seq).find((f) => /not delivered|offline/i.test(String(f.text ?? "")));
  c.expect("the message sent while dead is held in the outbox (a user row on the wire, queued/pending)", !!held && (held.queued === true || held.state === "queued" || held.state === "pending" || held.state === "outbox"),
    held ? `user row: queued=${held.queued} state=${held.state}` : `no user row for the text; engine said: ${JSON.stringify(notice?.text ?? null)}`);

  /* relaunch in the same pane with --resume */
  await c.waitScreen(pane.id, /[#$] ?$/m, 5000).catch(() => null); // the pane's shell prompt is back
  await c.launch(pane, { resume: resumeId || undefined });
  const back = await w.waitRow((r) => r.cwd === c.paths.work && r.alive !== false, { ms: SPEC.bringUpMs + 5000, label: "row alive again" });
  await c.snap("relaunched", pane.id);
  c.expect("the relaunched harness re-binds to the same pane (row alive again)", !!back, `rows: ${JSON.stringify(rowsFor(w.sessions(), c.paths.work).map((r) => ({ id: r.id, alive: r.alive, sid: sidOf(r) })))}`);
  c.expect("the agent id is unchanged across the disconnect", !!back && stableIdOf(back) === agentId, `before=${agentId} after=${back ? stableIdOf(back) : "none"}`);
  c.expect("no second row appeared for the cwd", rowsFor(w.sessions(), c.paths.work).length === 1, `${rowsFor(w.sessions(), c.paths.work).length} rows`);

  /* the held message lands once the harness is back */
  const landed = await c.waitFor(() => s.landedInTranscript(), { ms: 30_000, label: "held message in transcript" });
  c.expect("the held message lands in the resumed transcript", !!landed, landed ? landed.path : `no transcript under ${c.paths.work} holds ${JSON.stringify(text)}`);
  c.expect("it landed in the same harness session (resume worked)", !!landed && (!resumeId || landed.id === resumeId), `landed in ${landed?.id ?? "none"}, resumed ${resumeId || "(no id: fresh)"}`);
}
