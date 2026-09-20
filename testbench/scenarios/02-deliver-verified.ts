/* 2. inject (design 9, scenario 2)
 *
 * given  a bound row (scenario 1's scene)
 * when   the person sends a message from the app
 * then   the harness transcript grows by a user turn holding it, the fake
 *        model's last user text holds it (the harness sent it to its model),
 *        the row's message reaches state `landed`, and `landed` is never
 *        shown before the transcript grew.
 *
 * The engine deliberately prefixes what it types (`TEXT: body`, plus the
 * reply-level instruction), so "holds the message" is the delivery proof;
 * an exact match would be red for a designed reason, not a bug. */

import type { Cell } from "../cell/driver.ts";
import { bringUp, sendFromApp, SPEC } from "./_lib.ts";

export default async function (c: Cell) {
  const { pane, row } = await bringUp(c);
  c.need("a bound row to deliver to", !!row);
  const text = `app says: ping 02 ${Date.now() % 100000}`;
  const s = await sendFromApp(c, row!, text);

  /* the moment the transcript first held it, by polling the store */
  const t = await c.waitFor(() => s.landedInTranscript(), { ms: 30_000, every: 200, label: "message in transcript" });
  const grewAt = Date.now();
  await c.snap("after-send", pane.id);
  c.expect("the harness transcript grew by a user turn holding the message", !!t,
    t ? `${t.path} (${t.userTexts.length} user turns)` : `no transcript under ${c.paths.work} holds ${JSON.stringify(text)}; screen: ${(await c.snap("no-landing", pane.id)).slice(-600)}`);

  const served = await c.waitFor(() => { const q = s.served(); return q.length ? q : null; }, { ms: 20_000, label: "fake model served the message" });
  const last = served?.[0]?.lastUser ?? "";
  c.expect("the fake model's last user text holds the message (the harness sent it to its model)", !!served && last.includes(text),
    served ? `lastUser=${JSON.stringify(last.slice(0, 200))}` : `fake requests: ${c.fake().requests().length}, none holding the text`);

  /* the row message state, as the app sees it on the wire */
  const landed = await c.waitFor(() => s.chatRows().find((f) => f.state === "landed") ?? null, { ms: SPEC.landedMs, label: "chat row state=landed" });
  const rows = s.chatRows();
  c.expect("the message row reaches state `landed` within 8 s (spec)", !!landed,
    `chat rows for the text: ${rows.map((f) => `{role:${f.role} queued:${f.queued} state:${f.state} delivered:${f.delivered}}`).join(" ") || "none"}`);
  if (landed) {
    c.expect("`landed` was never shown before the transcript grew", landed._ts >= (t ? grewAt - 1500 : Infinity),
      `landed at ${landed._ts}, transcript held it by ${grewAt}`);
  }
  /* what the wire does say today, for the record */
  const userRow = rows.find((f) => f.role === "user");
  c.log(`wire echo: ${JSON.stringify(userRow ? { queued: userRow.queued, state: userRow.state, ts: userRow.ts } : null)}; dequeued frames: ${(await c.wire()).frames.filter((f) => f.t === "dequeued" && f.id === row!.id).length}`);
}
