/* 5. close and reopen (design 9, scenario 5; open question Q1, final)
 *
 * given  a bound row (agent X, session A, cwd W) with history, then the
 *        harness quit
 * when   a new pane runs `<harness> --resume A`
 * then   the same agent id, the full chat history, delivery works.
 *
 * variant: a fresh session in a new pane with no --resume (same cwd, any cwd)
 *        is a NEW agent; the old row X stays listed offline with its full
 *        history and its session id (resumable from its row). Matching is on
 *        the session itself (ids, links, content), never on the folder
 *        (owner decision 2026-09-02). */

import type { Cell } from "../cell/driver.ts";
import { bringUp, resumeIdOf, rowsFor, sendFromApp, sidOf, stableIdOf, waitOffline, SPEC } from "./_lib.ts";

export default async function (c: Cell) {
  const W = c.paths.work;
  const { pane, row, transcript } = await bringUp(c);
  c.need("a bound row", !!row);
  const w = await c.wire();
  const X = stableIdOf(row);
  const A = resumeIdOf(row, transcript);
  c.need("a session id to resume", !!A);
  /* some history the reopen must carry: one delivered message */
  const before = await sendFromApp(c, row!, `history 05 ${Date.now() % 100000}`);
  await c.waitFor(() => before.landedInTranscript(), { ms: 30_000, label: "history message landed" });
  const historyRows = c.chatLog(X).length;

  /* the person closes the harness */
  await c.quitHarness(pane.id);
  await waitOffline(c, W, SPEC.pollMs + 4000);
  await c.snap("quit", pane.id);

  /* when: a new pane resumes A */
  const p2 = await c.openPane({ cwd: W });
  await c.launch(p2, { resume: A });
  const back = await w.waitRow((r) => r.cwd === W && r.alive !== false, { ms: SPEC.bringUpMs + 5000, label: "row live in the new pane" });
  await c.snap("resumed", p2.id);
  c.expect("resume in a new pane: same agent id", !!back && stableIdOf(back) === X, `X=${X} now=${back ? stableIdOf(back) : "none"}; rows=${JSON.stringify(rowsFor(w.sessions(), W).map((r) => ({ id: r.id, alive: r.alive, sid: sidOf(r) })))}`);
  c.expect("resume in a new pane: full chat history kept", c.chatLog(X).length >= historyRows && historyRows > 0, `chat rows before=${historyRows} after=${c.chatLog(X).length}`);
  const s = await sendFromApp(c, back ?? row!, `after reopen 05 ${Date.now() % 100000}`);
  const landed = await c.waitFor(() => s.landedInTranscript(), { ms: 30_000, label: "delivery after reopen" });
  c.expect("resume in a new pane: delivery lands in session A", !!landed && landed.id === A, landed ? `landed in ${landed.id} (A=${A})` : "did not land");
  const historyAfterResume = c.chatLog(X).length;
  const oldRowId = (back ?? row!).id;

  /* variant: a fresh session, same cwd, no --resume: a new agent, X stays */
  await c.quitHarness(p2.id);
  await waitOffline(c, W, SPEC.pollMs + 4000);
  const agentsBefore = c.agents().map((a) => a.id);
  const p3 = await c.openPane({ cwd: W });
  await c.launch(p3);
  const promptF = `fresh session 05 ${Date.now() % 100000}`;
  await c.type(p3, promptF);
  const tF = await c.waitFor(async () => (await c.transcript(W)).find((t) => t.id !== A && t.userTexts.some((u) => u.includes(promptF))) ?? null, { ms: 30_000, label: "fresh transcript" });
  c.need("the fresh session has its own new transcript", !!tF, `transcripts: ${(await c.transcript(W)).map((t) => t.id).join(",")}`);
  const rowF = await w.waitRow((r) => r.cwd === W && r.alive !== false, { ms: SPEC.bringUpMs + 5000, label: "fresh session: live row" });
  await Bun.sleep(SPEC.pollMs + 1000); // one more sessions frame after the new row appears
  await c.snap("fresh-session", p3.id);
  const rowsW = rowsFor(w.sessions(), W);
  const live = rowsW.filter((r) => r.alive !== false);
  const minted = c.agents().map((a) => a.id).filter((id) => !agentsBefore.includes(id));
  const fresh = rowF ? stableIdOf(rowF) : "";
  c.expect("fresh id in a new pane, no --resume: a NEW agent (not X)", !!rowF && !!fresh && fresh !== X,
    `X=${X} fresh row agent=${fresh || "none"} newly minted agents=${minted.join(",") || "none"}`);
  c.expect("the fresh session is one live row, its own agent", live.length === 1 && stableIdOf(live[0]) === fresh, `live rows for ${W}: ${JSON.stringify(live.map((r) => ({ id: r.id, agent: stableIdOf(r), sid: sidOf(r) })))}`);
  const oldRow = rowsW.find((r) => stableIdOf(r) === X || r.id === oldRowId) ?? null;
  c.expect("the old row X stays listed, offline", !!oldRow && oldRow.alive === false,
    oldRow ? `old row id=${oldRow.id} alive=${oldRow.alive}` : `no row for agent ${X} in the list: ${JSON.stringify(rowsW.map((r) => ({ id: r.id, agent: stableIdOf(r), alive: r.alive })))}`);
  c.expect("the old row still carries its session id (resumable from its row)", !!oldRow && sidOf(oldRow) === A, oldRow ? `sid=${sidOf(oldRow)} A=${A}` : "no old row");
  c.expect("the old agent's history is intact on disk", c.chatLog(X).length === historyAfterResume && historyAfterResume > 0, `chat rows for X: ${c.chatLog(X).length} (was ${historyAfterResume})`);
  if (oldRow) {
    const attach = await w.attach(oldRow.id);
    const pages = Array.isArray(attach?.pages) ? attach.pages : [];
    const msgs = pages.flatMap((p: any) => Array.isArray(p?.messages) ? p.messages : []);
    c.expect("attaching the old row shows its full history", msgs.length >= historyAfterResume, `attach-ok messages=${msgs.length} history rows=${historyAfterResume}`);
  }
  c.expect("the fresh agent's history starts empty (nothing of X attributed by folder)", !!fresh && c.chatLog(fresh).every((m) => !String(m.text ?? "").includes("history 05") && !String(m.text ?? "").includes("after reopen 05")),
    fresh ? `chat rows for ${fresh}: ${c.chatLog(fresh).length}` : "no fresh agent");
}
