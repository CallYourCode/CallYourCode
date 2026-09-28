/* THE ONE-ROW SESSIONS FRAME (Lane D, SYNC-CONTRACT V2a).
 *
 * broadcastSessions used to ship the WHOLE roster (~42 KB) on any change, so one
 * agent's status edge re-sent every row. The rule the owner asked for is boring:
 * when ONLY existing rows' fields change -- the same sessions, in the same order,
 * under the same tabs -- the engine sends ONE additive {t:"session", ...row} per
 * changed row instead of the whole list. A STRUCTURAL change (a row added or
 * removed, the order dragged, the tabs redeclared) still ships the full
 * {t:"sessions"} frame, because the app cannot re-key its list off a one-row
 * patch. Hello always sends the full frame.
 *
 * The wire is the contract, so every assertion here reads the FRAMES a recorded
 * device received, not what the engine thinks it sent. Time is the manual clock,
 * so nothing broadcasts unless this test makes it: every frame counted is one a
 * line below caused.
 *
 *   bun test agent-engine/src/sessions/session-patch.test.ts
 */

import { test, expect, afterEach } from "bun:test";

import { wireCore, broadcastSessions, type WireCore, type FakeClient, wireId } from "../test-utils/wire-core.ts";
import { until } from "../test-utils/wait.ts";
import { setNameOverride, setManualOrder } from "./session-state.ts";

const P1 = "w1:p1";
const P2 = "w1:p2";

let core: WireCore | null = null;
afterEach(async () => {
  await core?.stop();
  core = null;
});

/** Two panes reconciled into two rows, with a watcher already holding the full
 *  roster (its hello burst) and cleared, so the next frame it records is the
 *  first one the change below causes. */
async function twoPaneWatcher(): Promise<{ c: WireCore; watcher: FakeClient }> {
  core = await wireCore({ panes: [P1, P2], with: ["sessions"] });
  await until(() => core!.sessions.size === 2, { what: "both panes to reconcile" });
  const watcher = core.client();
  core.hello(watcher);
  // The hello burst carried the full roster; from here we count only what the
  // change causes.
  expect(watcher.last("sessions"), "the hello burst carried the full roster").toBeDefined();
  watcher.clear();
  return { c: core, watcher };
}

test("a one-field change on one session emits exactly one {t:session} frame and no full frame", async () => {
  const { watcher } = await twoPaneWatcher();

  setNameOverride(wireId(P1), "renamed on the phone");
  broadcastSessions();

  expect(watcher.of("session"),
    "a fields-only change shipped something other than one one-row frame").toHaveLength(1);
  expect(watcher.of("sessions"),
    "a fields-only change still shipped the whole ~42 KB list").toHaveLength(0);

  const one = watcher.of("session")[0]!;
  expect(one.id, "the one-row frame named the wrong session").toBe(wireId(P1));
  expect(one.name, "the one-row frame is the FULL row, so it carries the new name").toBe("renamed on the phone");
});

test("the one-row frame carries only the row that changed, never the untouched one", async () => {
  const { watcher } = await twoPaneWatcher();

  // Only p1 moves. p2 changed nothing, so nothing about p2 goes on the wire.
  setNameOverride(wireId(P1), "only me moved");
  broadcastSessions();

  const rows = watcher.of("session");
  expect(rows.map((r) => r.id),
    "a change to one session put another session's row on the wire").toEqual([wireId(P1)]);
  expect(rows[0]!.name, "the one-row frame carried the change it was sent for").toBe("only me moved");
});

test("two rows changing at once emit one {t:session} each, still no full frame", async () => {
  const { watcher } = await twoPaneWatcher();

  setNameOverride(wireId(P1), "first");
  setNameOverride(wireId(P2), "second");
  broadcastSessions();

  const rows = watcher.of("session");
  expect(rows.map((r) => r.id).sort(),
    "two fields-only changes should be two one-row frames, one per changed row")
    .toEqual([wireId(P1), wireId(P2)].sort());
  expect(watcher.of("sessions"),
    "two one-row changes must not fall back to the whole list").toHaveLength(0);
  expect(rows.find((r) => r.id === wireId(P1))!.name).toBe("first");
  expect(rows.find((r) => r.id === wireId(P2))!.name).toBe("second");
});

test("a reorder is structural: it ships the full {t:sessions} frame, not one-row frames", async () => {
  const { watcher } = await twoPaneWatcher();

  setManualOrder([wireId(P2), wireId(P1)]);
  broadcastSessions();

  expect(watcher.of("sessions"),
    "a reorder must reach the app as the full list, so it can re-key the rows").toHaveLength(1);
  expect(watcher.of("session"),
    "a reorder is not a fields-only change: no one-row frame may carry it").toHaveLength(0);
  expect((watcher.last("sessions")!.list as any[]).map((s) => s.id),
    "the full frame carried the new order").toEqual([wireId(P2), wireId(P1)]);
});

test("an unchanged broadcast is still deduped to nothing, one-row path or not", async () => {
  const { watcher } = await twoPaneWatcher();

  // Nothing moved between the hello burst and here.
  broadcastSessions();

  expect(watcher.frames,
    "a broadcast that changed nothing sent a frame anyway").toHaveLength(0);
});

test("the one-row frame is a small fraction of the full roster on the wire (the point)", async () => {
  // A roster of eight panes, the kind of fleet that made a status edge ship the
  // whole ~42 KB list. One field changes on one of them.
  const panes = Array.from({ length: 8 }, (_, i) => `w1:p${i + 1}`);
  core = await wireCore({ panes, with: ["sessions"] });
  await until(() => core!.sessions.size === panes.length, { what: "all panes to reconcile" });
  const watcher = core.client();
  core.hello(watcher);
  const fullBytes = JSON.stringify(watcher.last("sessions")!).length;
  watcher.clear();

  setNameOverride(wireId(panes[0]!), "one changed");
  broadcastSessions();
  const oneRowBytes = JSON.stringify(watcher.of("session")[0]!).length;

  // The status-change budget (SYNC-CONTRACT V2a): one changed row, well under a
  // kilobyte, versus the whole list it used to ship.
  expect(watcher.of("session"), "the change did not ship as one one-row frame").toHaveLength(1);
  expect(oneRowBytes, `one changed row was ${oneRowBytes} bytes, over the 1 KB budget`).toBeLessThan(1024);
  expect(oneRowBytes * 4, `one row (${oneRowBytes}B) was not a fraction of the full roster (${fullBytes}B)`)
    .toBeLessThan(fullBytes);
});

test("a reconnect full frame reconciles a single frame the device missed", async () => {
  const { c, watcher } = await twoPaneWatcher();

  // The change goes out as one one-row frame while the watcher is listening.
  setNameOverride(wireId(P1), "changed while you blinked");
  broadcastSessions();
  expect(watcher.of("session"), "the watcher heard the one-row frame").toHaveLength(1);

  /* A DIFFERENT device that was NOT connected when that one-row frame went out --
   * it missed it entirely. When it (re)connects, its hello burst carries the
   * full CURRENT roster, so the change it never saw as a patch is simply there.
   * That is the reconcile: a one-row frame can be dropped and the next full
   * frame heals it, because the full frame is always the whole truth. */
  const reconnected = c.client();
  c.hello(reconnected);

  const healed = (reconnected.last("sessions")!.list as any[]).find((s) => s.id === wireId(P1));
  expect(healed, "the reconnecting device got no row for the changed session").toBeDefined();
  expect(healed.name,
    "the reconnect full frame did not carry the change the device missed as a one-row frame")
    .toBe("changed while you blinked");
});
