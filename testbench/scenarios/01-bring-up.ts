/* 1. bring-up (design 9, scenario 1)
 *
 * given  a pane running the harness with the integration installed
 * when   the engine boots
 * then   one row with `harness`, `cwd`, `harnessSessionId` equal to the
 *        transcript's id within 10 s, source `announce`, and no minted ids
 *        without a transcript.
 *
 * The engine boots AFTER the harness has a transcript, so the row must come
 * from the announce (UserPromptSubmit on the next prompt) or the guess path,
 * never from a blind mint. */

import type { Cell } from "../cell/driver.ts";
import { bringUp, mintedAgents, sidOf, SPEC } from "./_lib.ts";

export default async function (c: Cell) {
  const { pane, row, transcript, firstPrompt } = await bringUp(c, { engineFirst: false });
  const w = await c.wire();
  const bootAt = c.engine().lines.length ? Number(c.engine().lines[0].split(" ")[0]) : Date.now();

  /* a second prompt after boot: the UserPromptSubmit announce the engine can bind on */
  await c.type(pane, `${firstPrompt} again`);
  const bound = await w.waitRow((r) => r.cwd === c.paths.work && sidOf(r) !== "", { ms: SPEC.bringUpMs, label: "row with a harness session id" });
  const rows = w.sessions().filter((r) => r.cwd === c.paths.work);
  await c.snap("after-boot", pane.id);

  c.expect("one row for the pane's cwd within 10 s of boot", !!(bound ?? row) && rows.length === 1,
    `rows for ${c.paths.work}: ${rows.length} (${rows.map((r) => `${r.id} alive=${r.alive} sid=${sidOf(r)}`).join("; ") || "none"})`);
  const r = bound ?? row;
  if (r) {
    const sid = sidOf(r);
    const tid = transcript?.id ?? "";
    c.expect("row.harness names the harness (spec field)", r.harness === c.harnessName,
      `row.harness=${JSON.stringify(r.harness)} agent=${JSON.stringify(r.agent)} agentId=${JSON.stringify(r.agentId)}`);
    c.expect("row.cwd is the pane's cwd", r.cwd === c.paths.work, `row.cwd=${r.cwd}`);
    c.expect("row.harnessSessionId equals the transcript's id", !!sid && sid === tid,
      `harnessSessionId=${JSON.stringify(r.harnessSessionId)} claudeSessionId=${JSON.stringify(r.claudeSessionId)} transcript=${tid} (${transcript?.path})`);
    c.expect("row id is the stable agent id (design 1: id = agentId)", !!r.sessionAgentId && r.id === r.sessionAgentId,
      `id=${r.id} sessionAgentId=${r.sessionAgentId}`);
    const boundAt = w.frames.find((f) => f.t === "sessions" && (f.list ?? []).some((x: any) => x.cwd === c.paths.work && sidOf(x) === tid))?._ts;
    c.expect("bound within 10 s of boot", boundAt !== undefined && boundAt - bootAt <= SPEC.bringUpMs,
      boundAt ? `bound ${boundAt - bootAt} ms after boot` : "no sessions frame ever carried the transcript id");
  }
  /* source: the harness announce (UserPromptSubmit / notify / plugin) reached
   * the engine for this pane, logged as `[announce] ...` (terminal/hook-announce),
   * not only a folder guess (`tmux:<harness>` link) or a blind mint. The
   * `[discovery] announce` lines are the app-server discovery, not this. */
  const isAnnounce = (l: string) => /\[announce\]/.test(l) && !/rejected|ignored|nested/.test(l);
  await c.waitFor(() => c.engine().lines.find(isAnnounce) ?? null, { ms: SPEC.bringUpMs, label: "[announce] in engine log" });
  const binds = c.state("hook-binds") ?? c.state("pane-bindings") ?? {};
  const announced = c.engine().lines.some(isAnnounce);
  c.expect("row source is announce (hook reached the engine)", announced && Object.keys(binds).length > 0,
    `[announce] lines=${c.engine().lines.filter((l) => /\[announce\]/.test(l)).length} link lines=${c.engine().lines.filter((l) => /linked/.test(l)).map((l) => l.slice(l.indexOf("linked"))).join("; ") || "none"} binds=${JSON.stringify(binds).slice(0, 300)}`);
  /* no minted ids without a transcript */
  const ids = (await c.transcript()).map((t) => t.id);
  const minted = mintedAgents(c);
  const blind = minted.filter((a) => !ids.includes(String(a.meta.sessionId)));
  c.expect("no agent minted without a transcript", minted.length >= 1 && blind.length === 0,
    `agents=${minted.map((a) => `${a.id}:${a.meta.sessionId}`).join(", ") || "none"}; transcripts=${ids.join(", ")}`);
}
