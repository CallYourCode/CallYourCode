/* 6. engine restart mid-flight (design 9, scenario 6)
 *
 * leg A: identity, history, exactly-once across the kill
 * given  a bound row whose harness is busy on a slow turn, and a message
 *        from the app sent during the busy turn
 * when   the engine is SIGKILLed and rebooted on the same data dir
 * then   the same agent id and chat come back, the sequence continues, and
 *        the message is delivered exactly once: one user turn in the
 *        transcript, one user row in the chat log.
 *
 * leg B: a message that arrives right after the reboot, into a busy pane
 * given  the harness is busy on a slow turn that outlives the reboot
 * when   the engine is SIGKILLed, comes back, and a message arrives on the
 *        wire within a few hundred ms, before the pane is idle
 * then   the engine holds it until the turn edge (design 5: no typing into
 *        a busy pane), and the transcript gets it exactly once, after the
 *        turn edge. The engine's own `utterance.delivered` line is its typing
 *        claim: one stamped before the stream ended is the red. */

import type { Cell } from "../cell/driver.ts";
import { bringUp, rowsFor, sendFromApp, sidOf, stableIdOf, userTurnsWith, SPEC } from "./_lib.ts";

/* leg B's slow turn: 25 chunks x 800 ms, 20 s of streaming, so the pane is
 * still busy however long the reboot takes; the tail marks the turn edge */
const REBOOT_TURN = {
  match: "REBOOT-TURN",
  reply: "streaming under a reboot: REBOOT-TURN going chunk by chunk while the engine dies and comes back, until the reboot stream ends.",
  slowMs: 800,
  chunks: 25,
};
const TAIL = "until the reboot stream ends.";
const epochOf = (line: string) => Number(line.slice(0, line.indexOf(" ")));

export default async function (c: Cell) {
  const W = c.paths.work;
  const { pane, row } = await bringUp(c);
  c.need("a bound row", !!row);
  const X = stableIdOf(row);
  let w = await c.wire();

  /* ---------- leg A ---------- */
  /* the harness gets busy: a slow-streamed turn (fake-model scripts/default.json SLOW-TURN) */
  c.need("fake model switched to slow streaming", await c.fake().setSlow(true));
  await c.type(pane, `SLOW-TURN please 06`);
  const busy = await w.waitRow((r) => r.cwd === W && r.thinking === true, { ms: 15_000, label: "row thinking" });
  c.expect("the row shows thinking while the slow turn streams", !!busy, `rows=${JSON.stringify(rowsFor(w.sessions(), W).map((r) => ({ id: r.id, thinking: r.thinking, alive: r.alive })))}`);

  /* a message from the app during the busy turn */
  const text = `during the slow turn 06 ${Date.now() % 100000}`;
  const s = await sendFromApp(c, busy ?? row!, text);
  await Bun.sleep(1500);
  const echo = s.chatRows().find((f) => f.role === "user");
  const lastTsBefore = Math.max(0, ...w.chatRows((busy ?? row!).id).map((f) => Number(f.ts) || 0));
  c.log(`echo before kill: ${JSON.stringify(echo ? { queued: echo.queued, state: echo.state, ts: echo.ts } : null)}`);
  await c.snap("before-kill", pane.id);

  /* when: SIGKILL the engine, reboot on the same data dir */
  await c.killEngine();
  await c.startEngine({ keepData: true });
  w = await c.wire();
  const back = await w.waitRow((r) => r.cwd === W && r.alive !== false, { ms: SPEC.bringUpMs + 5000, label: "row after reboot" });
  c.expect("the same agent id comes back after the reboot", !!back && stableIdOf(back) === X, `X=${X} now=${back ? stableIdOf(back) : "none"} sid=${sidOf(back)}`);
  c.expect("still one row for the cwd after the reboot", rowsFor(w.sessions(), W).length === 1, `${rowsFor(w.sessions(), W).length} rows`);
  const agents = c.agents().filter((a) => a.meta && !a.meta.mergedInto);
  c.expect("no new agent minted by the reboot", agents.length === 1 && agents[0].id === X, `agents=${agents.map((a) => a.id).join(",")}`);

  /* the chat came back with the message row (attach-ok carries the pages) */
  if (back) await w.attach(back.id, 0);
  const history = w.history(back?.id ?? "");
  c.expect("the chat history (with the in-flight message) is back on the wire", history.some((m) => m.role === "user" && String(m.text ?? "").includes(text)),
    `attach-ok carried ${history.length} message(s): ${history.map((m) => `${m.role}:${String(m.text ?? "").slice(0, 30)}`).join(" | ")}`);

  /* let the slow turn finish, then the queued message must be delivered exactly once */
  await c.fake().setSlow(false);
  const landed = await c.waitFor(() => s.landedInTranscript(), { ms: 60_000, label: "message in transcript after reboot" });
  await Bun.sleep(3000);
  await c.snap("after-reboot", pane.id);
  const turns = await userTurnsWith(c, text);
  c.expect("the message is delivered after the reboot", !!landed, landed ? landed.path : "never reached the transcript");
  c.expect("exactly one user turn in the transcript holds it (no double delivery)", turns === 1, `${turns} user turns hold the text`);
  const logRows = c.chatLog(X).filter((m) => m.role === "user" && String(m.text ?? "").includes(text));
  c.expect("exactly one user row in the chat log holds it", logRows.length === 1, `${logRows.length} chat-log rows`);
  /* the sequence continues: a fresh message after the reboot stamps later
   * than everything before the kill, and the log holds both in order */
  const s2 = await sendFromApp(c, back ?? row!, `after the reboot 06 ${Date.now() % 100000}`);
  await c.waitFor(() => s2.landedInTranscript(), { ms: 30_000, label: "post-reboot message landed" });
  const log = c.chatLog(X).filter((m) => m.role === "user");
  const i1 = log.findIndex((m) => String(m.text ?? "").includes(text));
  const i2 = log.findIndex((m) => String(m.text ?? "").includes("after the reboot 06"));
  c.expect("the chat sequence continues (post-reboot rows stamp later, in order, in the same log)", i1 >= 0 && i2 > i1 && Number(log[i2].ts) > lastTsBefore,
    `user rows: ${log.map((m) => `${m.ts}:${String(m.text ?? "").slice(0, 25)}`).join(" | ")}; last ts before kill ${lastTsBefore}`);
  const served = await s.servedWithin();
  c.expect("the fake model saw the message (the harness took it)", served.length >= 1, `${served.length} request(s) hold it`);

  /* ---------- leg B ---------- */
  const rowB = back ?? row!;
  c.need("fake model scripted with the reboot turn", await c.fake().setScript({ default: "ok.", rules: [REBOOT_TURN] }));
  await c.type(pane, "REBOOT-TURN please 06");
  const slowReq = await c.fake().waitRequest((q) => q.lastUser.includes("REBOOT-TURN"), 20_000);
  c.need("the fake model is streaming the reboot turn", !!slowReq);
  const streamEnd = slowReq!.ts + REBOOT_TURN.slowMs * REBOOT_TURN.chunks; // the fake's last chunk, by its own record
  const busyB = await w.waitRow((r) => r.cwd === W && r.thinking === true, { ms: 8000, label: "row thinking on the reboot turn" });
  c.expect("the row shows thinking on the turn that outlives the reboot", !!busyB, busyB ? "thinking=true" : "row never showed thinking");
  await c.snap("before-kill-b", pane.id);

  /* when: kill, come back, and a message arrives at once */
  await c.killEngine();
  await c.startEngine({ keepData: true });
  const bootedAt = Date.now(); // /health answered
  w = await c.wire();
  const textB = `right after the reboot 06 ${Date.now() % 100000}`;
  const sB = await sendFromApp(c, rowB, textB, { attach: false });
  const sentAfterBootMs = sB.at - bootedAt;
  c.fact("sentAfterBootMs", sentAfterBootMs);
  const tailAtSend = (await c.transcript(W)).some((t) => t.assistantTexts.some((a) => a.includes(TAIL)));
  c.need("the prior turn is still streaming at the send (the pane is busy across the reboot)", !tailAtSend && sB.at < streamEnd,
    `sent ${sentAfterBootMs} ms after the engine answered /health, ${streamEnd - sB.at} ms before the fake's last chunk; tail already in transcript: ${tailAtSend}`);
  c.log(`leg B: sent ${sentAfterBootMs} ms after boot (${sentAfterBootMs <= 300 ? "within" : "outside"} the 300 ms window), ${streamEnd - sB.at} ms of stream left`);

  /* watch the transcript for the turn edge (the tail lands) and the landing */
  let edgeSeen = 0, landedAt = 0;
  await c.waitFor(async () => {
    const ts = await c.transcript(W);
    const now = Date.now();
    if (!edgeSeen && ts.some((t) => t.assistantTexts.some((a) => a.includes(TAIL)))) edgeSeen = now;
    if (!landedAt && ts.some((t) => t.userTexts.some((u) => u.includes(textB)))) landedAt = now;
    return edgeSeen && landedAt ? true : null;
  }, { ms: streamEnd - Date.now() + 40_000, every: 250, label: "turn edge and landing" });
  await Bun.sleep(3000);
  await c.snap("after-reboot-b", pane.id);

  /* then: the engine's typing claim vs the turn edge */
  const engineB = c.engine();
  const deliveredLine = engineB.since(bootedAt).find((l) => /utterance\.delivered/.test(l) && l.includes(sB.cid)) ?? null;
  const deliveredAt = deliveredLine ? epochOf(deliveredLine) : 0;
  const heldPastEdge = !!deliveredLine && deliveredAt >= streamEnd;
  c.expect("the engine holds the message until the turn edge (no typing into the busy pane)", heldPastEdge,
    deliveredLine
      ? (heldPastEdge
        ? `delivered ${deliveredAt - streamEnd} ms after the fake's last chunk (edge seen in transcript at +${edgeSeen ? edgeSeen - streamEnd : "?"} ms)`
        : `engine typed into the busy pane ${deliveredAt - bootedAt} ms after the reboot, ${streamEnd - deliveredAt} ms before the stream ended: ${deliveredLine.slice(deliveredLine.indexOf("utterance."), deliveredLine.indexOf("utterance.") + 120)}`)
      : `no utterance.delivered line for cid ${sB.cid} after the reboot; landed in transcript: ${!!landedAt}`);

  /* then: the transcript holds it once, after the edge */
  const tB = await sB.landedInTranscript();
  const turnsB = await userTurnsWith(c, textB);
  const order = tB?.turns ?? [];
  const iTail = order.findIndex((t) => t.role === "assistant" && t.text.includes(TAIL));
  const iUser = order.findIndex((t) => t.role === "user" && t.text.includes(textB));
  /* after the edge in the transcript's own order AND in time: opencode
   * stores a queued user row at submit, so its order alone can read "after"
   * while the row was written mid-stream */
  const afterEdge = iTail >= 0 && iUser > iTail && !!landedAt && !!edgeSeen && landedAt >= edgeSeen;
  c.expect("the transcript gets it exactly once, after the turn edge", turnsB === 1 && afterEdge,
    `${turnsB} user turn(s) hold it; transcript order: reboot turn's tail at #${iTail}, the message at #${iUser}`
    + (landedAt && edgeSeen ? `; landed ${landedAt - edgeSeen} ms after the edge was seen${landedAt < edgeSeen ? " (written mid-stream)" : ""}` : landedAt ? "; landed, edge never seen" : "; never landed"));
  const logRowsB = c.chatLog(X).filter((m) => m.role === "user" && String(m.text ?? "").includes(textB));
  c.expect("exactly one user row in the chat log holds the post-reboot message", logRowsB.length === 1, `${logRowsB.length} chat-log rows`);
  const servedB = await sB.servedWithin();
  c.expect("the fake model saw the post-reboot message once", servedB.length >= 1, `${servedB.length} request(s) hold it`);
}
