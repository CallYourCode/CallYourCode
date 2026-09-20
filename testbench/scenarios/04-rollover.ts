/* 4. rollover (design 9, scenario 4)
 *
 * given  a bound row with transcript A
 * when   the person rolls the harness session in place (claude /clear, codex
 *        /new, opencode /new, pi /new) and types again
 * then   the row keeps its agent id, `pastSessions` holds A's id, the chat
 *        shows a system row for the rollover, and a message from the app
 *        lands in the NEW transcript. */

import type { Cell } from "../cell/driver.ts";
import { bringUp, latestTranscript, rowsFor, sendFromApp, sidOf, stableIdOf, SPEC } from "./_lib.ts";

export default async function (c: Cell) {
  const { pane, row, transcript } = await bringUp(c);
  c.need("a bound row", !!row);
  c.need("a transcript before the rollover", !!transcript);
  const w = await c.wire();
  const agentId = stableIdOf(row);
  const oldId = transcript!.id;
  const cmd = c.harness().newSessionCommand;
  c.need(`${c.harnessName} has a new-session command`, !!cmd);

  /* when: roll the session in place, then a prompt so the new session exists on disk */
  const seq = w.frames.length;
  await c.type(pane, cmd!);
  await Bun.sleep(1500);
  await c.waitReady(pane.id, 15_000);
  const after = `after rollover 04 ${Date.now() % 100000}`;
  await c.type(pane, after);
  const fresh = await c.waitFor(async () => (await c.transcript()).find((t) => t.id !== oldId && t.userTexts.some((u) => u.includes(after))) ?? null, { ms: 30_000, label: "a new transcript" });
  await c.snap("rolled", pane.id);
  c.need("the harness wrote a NEW transcript after the command", !!fresh,
    `transcripts: ${(await c.transcript()).map((t) => `${t.id}(${t.userTexts.length})`).join(", ")}; screen: ${(await c.snap("no-new-transcript", pane.id)).slice(-500)}`);
  const newId = fresh!.id;

  /* then: the row follows the new session, keeps its id */
  const bound = await w.waitRow((r) => r.cwd === c.paths.work && r.alive !== false && sidOf(r) === newId, { ms: SPEC.bringUpMs, label: "row on the new session id" });
  const rows = rowsFor(w.sessions(), c.paths.work);
  const live = bound ?? rows[0];
  c.expect("still one row for the cwd", rows.length === 1, `${rows.length} rows: ${rows.map((r) => `${r.id} sid=${sidOf(r)} alive=${r.alive}`).join("; ")}`);
  c.expect("the row's harness session id moved to the new transcript within 10 s", !!bound, `row sid=${sidOf(live)} new=${newId} old=${oldId}`);
  c.expect("the agent id is unchanged across the rollover", !!live && stableIdOf(live) === agentId, `before=${agentId} after=${live ? stableIdOf(live) : "none"}`);
  c.expect("row.pastSessions holds the old session id (spec)", Array.isArray(live?.pastSessions) && live!.pastSessions.includes(oldId),
    `pastSessions=${JSON.stringify(live?.pastSessions ?? null)}`);
  const sys = w.frames.filter((f) => f.t === "chat" && f._seq >= seq && f.id === live?.id && (f.role === "system" || f.kind === "divider" || f.divider));
  c.expect("a system row marks the rollover in the chat", sys.length > 0, `system/divider rows since the command: ${sys.length}`);

  /* a message from the app lands in the NEW transcript */
  const text = `after the roll 04 ${Date.now() % 100000}`;
  const s = await sendFromApp(c, live ?? row!, text);
  const landed = await c.waitFor(() => s.landedInTranscript(), { ms: 30_000, label: "message in a transcript" });
  const newest = await latestTranscript(c);
  c.expect("the message lands in the new transcript", !!landed && landed.id === newId, landed ? `landed in ${landed.id} (new=${newId}, old=${oldId}); newest on disk ${newest?.id}` : "did not land");
}
