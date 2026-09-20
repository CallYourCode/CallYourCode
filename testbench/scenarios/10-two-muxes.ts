/* 10. two muxes (design 9, scenario 10)
 *
 * given  one engine with tmux AND herdr both running in the cell, a harness
 *        pane in each (different cwds, so each is its own conversation)
 * when   both harnesses take a first prompt
 * then   the list shows a row for each pane; the declared tabs are
 *        {tmux} together with the herdr workspaces; a message from the app to
 *        each row lands in that pane's own transcript (evidence: the two
 *        transcripts, the fake model's requests).
 *
 * Today's engine drives ONE mux (CYC_MUX); the cell boots it with tmux as the
 * primary and the herdr socket in its env (HERDR_SOCKET_PATH) plus
 * ENGINE_TABS=workspace, so a herdr-aware engine has everything it needs. The
 * herdr pane not being listed is the expected red. */

import type { Cell } from "../cell/driver.ts";
import { workDirs } from "../cell/harness.ts";
import { rowsFor, sendFromApp, sidOf, SPEC } from "./_lib.ts";

export default async function (c: Cell) {
  c.need(`the cell has both muxes (CELL_MUX=both, got ${c.muxSpec})`, c.muxSpec === "both");
  const [W1, W2] = workDirs(c.paths);
  const tmux = c.mux();
  const herdr = await c.startMux("herdr");
  c.need("herdr server is up beside tmux", await herdr.alive());
  await c.startEngine({ env: { ENGINE_TABS: "workspace" } });
  const w = await c.wire();

  /* a harness in a tmux pane and one in a herdr pane */
  const p1 = await c.openPane({ cwd: W1, mux: tmux });
  const p2 = await c.openPane({ cwd: W2, mux: herdr });
  await c.launch(p1);
  await c.launch(p2);
  const hello1 = `hello tmux 10`, hello2 = `hello herdr 10`;
  await c.type(p1, hello1);
  await c.type(p2, hello2);
  const t1 = await c.waitFor(async () => (await c.transcript(W1)).find((t) => t.userTexts.some((u) => u.includes(hello1))) ?? null, { ms: 30_000, label: "tmux pane transcript" });
  const t2 = await c.waitFor(async () => (await c.transcript(W2)).find((t) => t.userTexts.some((u) => u.includes(hello2))) ?? null, { ms: 30_000, label: "herdr pane transcript" });
  c.need("the tmux pane's harness wrote a transcript", !!t1, `screen: ${(await c.snap("tmux-pane", p1.id)).slice(-600)}`);
  c.need("the herdr pane's harness wrote a transcript", !!t2, `screen: ${(await c.snap("herdr-pane", p2.id)).slice(-600)}`);

  /* then: a row for each */
  const r1 = await w.waitRow((r) => r.cwd === W1 && r.alive !== false, { ms: SPEC.bringUpMs + 5000, label: "row for the tmux pane" });
  const r2 = await w.waitRow((r) => r.cwd === W2 && r.alive !== false, { ms: SPEC.bringUpMs, label: "row for the herdr pane" });
  await c.snap("both-bound");
  const rows = w.sessions();
  const shape = (r: any) => (r ? { id: r.id, sid: sidOf(r), tab: r.tab, agent: r.sessionAgentId } : null);
  c.expect("the tmux pane has a row", !!r1, JSON.stringify(shape(r1)));
  c.expect("the herdr pane has a row (one engine, two muxes)", !!r2, r2 ? JSON.stringify(shape(r2)) : `no row for ${W2}; rows: ${JSON.stringify(rows.map(shape))}`);
  c.expect("exactly two live rows, one per pane", rows.filter((r) => r.alive !== false).length === 2, `${rows.filter((r) => r.alive !== false).length} live rows: ${JSON.stringify(rows.map(shape))}`);

  /* the tabs: {tmux} together with herdr's workspaces */
  const frame = [...w.frames].reverse().find((f) => f.t === "sessions");
  const tabs: { key: string; title: string }[] = Array.isArray(frame?.tabs) ? frame!.tabs : [];
  const keys = tabs.map((t) => String(t.key));
  const herdrWs = (await herdr.panes()).length; // one workspace per herdr pane the cell opened
  const hasTmuxTab = keys.some((k) => /tmux/i.test(k)) || (!!r1 && keys.includes(String(r1.tab ?? "")) && String(r1.tab ?? "") !== "");
  const hasHerdrTab = !!r2 && String(r2.tab ?? "") !== "" && keys.includes(String(r2.tab ?? ""));
  c.expect("the engine declares tabs: one for tmux and one per herdr workspace", tabs.length >= 1 + herdrWs && hasTmuxTab && hasHerdrTab,
    `tabs=${JSON.stringify(tabs)} herdr workspaces=${herdrWs} row tabs: tmux=${JSON.stringify(r1?.tab ?? null)} herdr=${JSON.stringify(r2?.tab ?? null)}`);
  c.expect("the two rows sit under different tabs", !!r1 && !!r2 && String(r1.tab ?? "") !== String(r2.tab ?? ""), `tmux row tab=${JSON.stringify(r1?.tab ?? null)} herdr row tab=${JSON.stringify(r2?.tab ?? null)}`);

  /* delivery to each lands in its own transcript */
  const m1 = `to the tmux pane 10 ${Date.now() % 100000}`;
  const m2 = `to the herdr pane 10 ${Date.now() % 100000}`;
  const s1 = r1 ? await sendFromApp(c, r1, m1) : null;
  const s2 = r2 ? await sendFromApp(c, r2, m2) : null;
  const l1 = s1 ? await c.waitFor(() => s1.landedInTranscript(), { ms: 30_000, label: "tmux delivery" }) : null;
  const l2 = s2 ? await c.waitFor(() => s2.landedInTranscript(), { ms: 30_000, label: "herdr delivery" }) : null;
  await c.snap("delivered");
  c.expect("a message to the tmux row lands in the tmux pane's transcript", !!l1 && l1.path.startsWith(t1!.path.slice(0, t1!.path.lastIndexOf("/"))), l1 ? l1.path : "did not land");
  c.expect("a message to the herdr row lands in the herdr pane's transcript", !!l2, l2 ? l2.path : r2 ? "did not land" : "no herdr row to send to");
  const cross1 = (await c.transcript(W2)).some((t) => t.userTexts.some((u) => u.includes(m1)));
  const cross2 = (await c.transcript(W1)).some((t) => t.userTexts.some((u) => u.includes(m2)));
  c.expect("neither message crossed into the other pane's transcript", !cross1 && !cross2, `tmux text in herdr transcript=${cross1} herdr text in tmux transcript=${cross2}`);
  const served1 = s1 ? (await s1.servedWithin()).length : 0;
  const served2 = s2 ? (await s2.servedWithin()).length : 0;
  c.expect("the fake model saw each message from its own pane's conversation", served1 >= 1 && served2 >= (r2 ? 1 : 0), `requests carrying the text: tmux=${served1} herdr=${served2}`);
  c.log(`rows on the wire: ${JSON.stringify(rowsFor(rows, W1).concat(rowsFor(rows, W2)).map(shape))}`);
}
