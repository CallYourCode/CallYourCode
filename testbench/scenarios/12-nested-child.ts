/* 12. nested child (design 9, scenario 12)
 *
 * given  a bound row; the fake model scripted so the next prompt's turn calls
 *        the shell tool with a headless run of the SAME harness (`claude -p`,
 *        `codex exec`, `opencode run`, `pi -p`): a child agent inside the
 *        parent's pane, inheriting the pane's witnesses (TMUX_PANE /
 *        HERDR_PANE_ID) and the integration hooks
 * when   the parent runs the tool call
 * then   the child runs as its own session (own transcript), its announce
 *        never re-keys the pane (today's tree has two guards: the hook stays
 *        silent when a second claude sits in its ancestry, and the engine
 *        strips the pane witnesses off a nested announce; either one holding
 *        is the pass, the verdict records which), the parent's binding is
 *        unchanged (same row id, same harness session id, same agent id, one
 *        row, no new agent), the child's output comes back to the model as
 *        the tool result, and the parent's turn ends with the scripted reply
 *        in the parent's own transcript. */

import type { Cell } from "../cell/driver.ts";
import { bringUp, mintedAgents, rowsFor, sidOf, stableIdOf } from "./_lib.ts";

export default async function (c: Cell) {
  const W = c.paths.work;
  const { pane, row, transcript } = await bringUp(c);
  c.need("a bound row", !!row);
  const w = await c.wire();
  const X = stableIdOf(row);
  const sid = sidOf(row);
  const rowId = row!.id;
  const agentsBefore = mintedAgents(c).map((a) => a.id).sort();
  const transcriptsBefore = (await c.transcript(W)).map((t) => t.id);

  /* the script: NESTED-CHILD -> shell tool call running a headless child */
  const marker = `child-said-${Date.now() % 100000}`;
  const childPrompt = `NESTED-CHILD-INNER ${marker}`;
  const command = `${c.harness().headless(childPrompt)} 2>&1; echo ${marker}-done`;
  const reply = `parent back after the child: ${marker}`;
  c.need("fake model script swapped for the nested-child turn", await c.fake().setScript({
    default: "ok.",
    rules: [
      { match: "NESTED-CHILD-INNER", reply: `inner reply ${marker}` },
      { match: "NESTED-CHILD", tool: { command }, reply },
    ],
  }));
  c.log(`tool command: ${command}`);

  /* when: the parent takes the prompt and runs the tool call */
  const t0 = Date.now();
  await c.type(pane, `NESTED-CHILD please 12`);
  const call = await c.fake().waitRequest((q) => !!q.toolCall, 30_000);
  c.expect("the fake model issued the tool call to the parent (the parent declared a shell tool)", !!call, call ? `tool ${call.toolCall!.name}` : `declared tools on the last request: ${JSON.stringify(c.fake().requests().slice(-1)[0]?.tools ?? [])}`);
  /* the child's own conversation: it carries the inner prompt and none of the
   * parent's turns (opencode's title request adds a second user message, so
   * the count is not the test) */
  const inner = await c.fake().waitRequest((q) => q.lastUser.includes("NESTED-CHILD-INNER") && !q.userTexts.some((u) => u.includes("NESTED-CHILD please")), 90_000);
  c.expect("the child ran and reached the model (a request from the child, its own conversation)", !!inner, inner ? `child request seq ${inner.seq}, ${inner.messageCount} user message(s), none of them the parent's` : "no request from the child within 90 s");
  const result = await c.fake().waitRequest((q) => typeof q.toolResult === "string" && q.lastUser.includes("NESTED-CHILD please"), 60_000);
  c.expect("the child's output came back to the model as the tool result", !!result && result.toolResult!.includes(`${marker}-done`),
    result ? `tool result: ${JSON.stringify(result.toolResult!.slice(0, 300))}` : "no tool result request");
  const landed = await c.waitFor(async () => (await c.transcript(W)).find((t) => t.assistantTexts.some((a) => a.includes(reply))) ?? null, { ms: 60_000, label: "parent reply in transcript" });
  await Bun.sleep(3000);
  await c.snap("after-child", pane.id);
  c.expect("the parent's turn ended with the scripted reply in the parent's own transcript", !!landed && landed.id === (transcript?.id ?? landed.id), landed ? landed.path : "reply never reached a transcript");

  /* the child ran as its own session, and its announce never re-keyed the pane */
  const lines = c.engine().since(t0);
  const announces = lines.filter((l) => /\[announce\] session /.test(l));
  const nested = lines.filter((l) => /\[announce\] nested agent announce/.test(l));
  const childSids = [...new Set(announces.map((l) => l.match(/session ([0-9a-f-]{8,})/)?.[1] ?? "").filter((s) => s && s !== sid))];
  const transcriptsAfter = (await c.transcript(W)).map((t) => t.id);
  const childTranscripts = transcriptsAfter.filter((id) => !transcriptsBefore.includes(id));
  c.expect("the child ran as its own session (a transcript of its own beside the parent's)", childTranscripts.length >= 1 || (!!inner && inner.messageCount === 1),
    `child transcripts: ${childTranscripts.join(",") || "none under the parent's store"}; child request: ${inner ? `seq ${inner.seq}` : "none"}`);
  const guard = childSids.length === 0 ? "hook-silent" : nested.length >= 1 ? "engine-stripped" : "none";
  c.fact("childGuard", guard);
  c.expect("the child's announce never re-keyed the pane: the hook stayed silent, or the engine stripped the witnesses off a nested announce", guard !== "none",
    guard === "hook-silent" ? `no announce carried a session other than the parent's (${announces.length} announces, all ${sid.slice(0, 8)})` : guard === "engine-stripped" ? nested[0]!.slice(0, 160) : `announce(s) for ${childSids.join(",")} with no nested line: ${announces.map((l) => l.slice(0, 120)).join(" | ")}`);

  /* the parent's binding is unchanged */
  const rows = rowsFor(w.sessions(), W);
  const live = rows.filter((r) => r.alive !== false);
  c.expect("one live row for the pane, unchanged id", live.length === 1 && live[0].id === rowId, `rows: ${JSON.stringify(rows.map((r) => ({ id: r.id, sid: sidOf(r), alive: r.alive })))}`);
  c.expect("the row still names the parent's harness session, not the child's", live.length === 1 && sidOf(live[0]) === sid, `before=${sid} now=${live[0] ? sidOf(live[0]) : "none"} child=${childSids.join(",")}`);
  c.expect("the agent id is unchanged", live.length === 1 && stableIdOf(live[0]) === X, `X=${X} now=${live[0] ? stableIdOf(live[0]) : "none"}`);
  /* the parent's own agent may reach disk after bring-up (pi, opencode): the
   * row's agent id counts as known; anything else new is a child's */
  const agentsAfter = mintedAgents(c).map((a) => a.id).sort();
  const newAgents = agentsAfter.filter((id) => !agentsBefore.includes(id) && id !== X);
  c.expect("no agent was minted for the child", newAgents.length === 0, `before=${agentsBefore.join(",") || "(none on disk yet)"} row=${X} after=${agentsAfter.join(",")}`);
  const bindings = c.state("pane-bindings");
  const boundTo = JSON.stringify(bindings ?? {});
  c.expect("the pane binding on disk still points at the parent's session", !childSids.some((s) => boundTo.includes(s)), `pane-bindings: ${boundTo.slice(0, 300)}`);

  /* and the parent still takes delivery after the child */
  const text = `after the child 12 ${Date.now() % 100000}`;
  await w.attach(rowId);
  w.utter(rowId, text);
  const after = await c.waitFor(async () => (await c.transcript(W)).find((t) => t.userTexts.some((u) => u.includes(text))) ?? null, { ms: 30_000, label: "delivery after the child" });
  c.expect("delivery to the row lands in the parent's transcript after the child", !!after && after.id === (transcript?.id ?? after.id), after ? after.path : "did not land");
}
