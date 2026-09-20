/* THE PLUGIN WIRE, OVER A REAL ENGINE AND A REAL SEALED PIPE.
 *
 * WHAT THE BOOT IS BUYING. The decl shaping (what pluginDecl keeps and what it
 * strips) is pure and belongs at the unit tier; the store's arithmetic belongs
 * at the unit tier too. What neither tier can reach is the JOIN, and the join is
 * the whole feature:
 *
 *   - the /plugin/<id>/rpc/<op> and /plugin/<id>/card ROUTES only exist inside a
 *     listening engine. A seam test can call the hook; only a boot proves the
 *     route reaches it, shapes {ok, result}, and serves a rendered card body.
 *   - a `set` that moves a dial must RE-DECLARE the plugin list and BROADCAST
 *     it. That crosses three seams in one motion: an HTTP route mutates plugin
 *     state, the registry rebuilds the decl from that state, and the frame
 *     leaves over the sealed DataChannel to a socket that asked for nothing.
 *     Every device's composer redraws off that frame; if it does not arrive, the
 *     slider on the phone still says 3 while the engine has 5, and nothing in
 *     process would notice.
 *
 * Sources carried across: reply-dials.test.ts ("rpc get: returns the dials..."
 * and "rpc set: moves the dial and broadcasts a plugins frame whose slider value
 * moved", plus its 400-not-500 rejection test), dials.test.ts (the per-session
 * reply-level compatibility route, whose 404 for a stale id is the same wire
 * question), plugins.test.ts (the card route's rendered body, ageMs, dedupe, and
 * the unknown-id 404).
 *
 *   bun test --preload ./e2e/testpreload.ts e2e/plugin-rpc.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { openSealedClient, startEngine, hasE2ETransport, PANE, type Engine } from "./harness.ts";
import { defaultSessionIdOf } from "../test-utils/fake-herdr.ts";
import { DEFAULT_PROMPT_BITS } from "../plugins/reply-dials/index.ts";

let engine: Engine | null = null;
afterEach(async () => {
  await engine?.stop();
  engine = null;
});

async function until<T>(f: () => T | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`never happened within ${ms}ms: ${what}`);
    await Bun.sleep(50);
  }
}

const rpc = (e: Engine, id: string, op: string, args: unknown) =>
  fetch(`${e.http}/plugin/${id}/rpc/${op}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ args }),
  });

/** The verbosity slider as the app receives it, out of a plugins frame. */
const sliderIn = (frame: any) =>
  frame?.list?.find((p: any) => p.id === "reply-dials")
    ?.composer?.find((w: any) => w.key === "verbosity");

// Uses openSealedClient (below), so it needs the e2e transport preload
// (`bun run test:e2e`); under a bare `bun test` it skips. See hasE2ETransport.
test.skipIf(!hasE2ETransport)("a dial moved over the rpc route re-declares the plugins frame on every sealed socket, and a card renders over HTTP", async () => {
  /* The fixture plugin is additive: this engine still carries every compiled-in
   * built-in (reply-dials among them) and gains the one plugin whose hooks are
   * real enough to serve a card body worth asserting on. One boot answers both
   * halves. */
  engine = await startEngine({ env: { CYC_PLUGINS_TEST: "1" } });
  const e = engine;

  /* ------------------------------------------------------- the dials as read */

  const got = await (await rpc(e, "reply-dials", "get", {})).json();
  expect(got.ok).toBe(true);
  expect(got.result.level, "a fresh engine ships at rung 3").toBe(3);
  expect(got.result.migrated, "nothing legacy was on disk, so nothing was migrated").toBe(false);
  expect(got.result.verbosity[3].name).toBe("Read out");
  expect(got.result.verbosity[3].edited,
    "an unedited rung must say so per field, so the app can show what he changed")
    .toEqual({ name: false, text: false });
  expect(got.result.bits, "the prompt bits are the checked-in defaults").toEqual(DEFAULT_PROMPT_BITS);
  expect(got.result.defaults.names[1]).toBe("Terminal");

  /* -------------------------- a socket that asked for nothing but the burst */

  /* THE LISTENER IS THE ASSERTION. This socket never touches the rpc route: it
   * says hello and keeps whatever the engine broadcasts at it, which is what
   * his tablet in his pocket is. A `set` that only answered the caller would
   * leave every other device drawing a slider at the old rung until its next
   * reconnect. */
  const { ws, frames } = await openSealedClient(e);
  /* The engine answers /health before it has snapshotted herdr, so a route that
   * needs a live session can 404 for the first few hundred ms of a boot. The
   * sessions frame IS that snapshot arriving, so waiting for the pane to appear
   * on it is waiting for exactly the right thing rather than for a duration. */
  await until(() => frames.filter((f) => f.t === "sessions").at(-1)
    ?.list?.some((s: any) => s.harnessSessionId === defaultSessionIdOf(PANE)), 10_000, "the pane to be listed as a session");
  const before = await until(() => sliderIn(frames.filter((f) => f.t === "plugins").at(-1)),
    5_000, "the hello burst's plugins frame to carry the verbosity slider");
  expect(before.value, "the declared slider does not start at the stored rung").toBe(3);

  /* ------------------------------------------------------- move it, and watch */

  const set = await (await rpc(e, "reply-dials", "set", { key: "verbosity", n: 5 })).json();
  expect(set.result, "the set answers with both dials, not just the one that moved")
    .toEqual({ level: 5, complexity: 3 });

  const after = await until(() => {
    const w = sliderIn(frames.filter((f) => f.t === "plugins").at(-1));
    return w && w.value === 5 ? w : undefined;
  }, 5_000, "the re-declared plugins frame to reach a socket that asked for nothing");
  expect(after.value, "the re-declared slider value did not move").toBe(5);

  /* A REJECTION IS A 400, and it changes nothing. A 500 here would read to the
   * app as "the engine is broken" rather than "that rung does not exist", and a
   * rejected set that had already half-applied would leave the frame and the
   * store disagreeing. */
  expect((await rpc(e, "reply-dials", "set", { key: "verbosity", n: 9 })).status).toBe(400);
  expect((await rpc(e, "reply-dials", "set", { key: "nope", n: 3 })).status).toBe(400);
  expect((await rpc(e, "reply-dials", "set", { key: "complexity", n: "x" })).status,
    "a malformed rung must be refused by name, not 500").toBe(400);

  /* A REJECTED SET CHANGES NOTHING AT ALL, in the answer AND on disk. The store
   * is the engine's own plugin data dir, and a fresh boot reads THAT file, so a
   * rejection that had half-applied would survive a restart as a dial nobody
   * set. */
  const held = await (await rpc(e, "reply-dials", "get", {})).json();
  expect(held.result, "a rejected set moved a dial").toMatchObject({ level: 5, complexity: 3 });
  const onDisk = JSON.parse(
    await Bun.file(join(e.dir, "data", "plugins", "reply-dials", "reply-dials.json")).text());
  expect(onDisk, "a rejected write reached the store").toMatchObject({ level: 5, complexity: 3 });

  expect((await rpc(e, "reply-dials", "set", { key: "complexity", n: 2 })).status,
    "a good set must still work after the rejections").toBe(200);
  ws.close();

  /* ------------------------------------------------- one card, rendered, over HTTP */

  /* The card route runs the plugin's own render hook inside the engine and hands
   * back the body plus the two facts the app frames it with: how old the reading
   * is, and the dedupe key that decides whether this is the same card it is
   * already showing. */
  const card = await fetch(`${e.http}/plugin/fixture/card`);
  expect(card.status).toBe(200);
  const cj = await card.json();
  expect(cj.ok).toBe(true);
  expect(cj.html, "the route did not serve the plugin's rendered body").toContain("fixture card");
  expect(cj.ageMs, "the render's own age must reach the app unchanged").toBe(1234);
  expect(cj.dedupe, "the dedupe key must ride the answer or the app re-draws every poll")
    .toBe("fixture-key");

  // an unknown id is a 404, not a 500: the /plugin prefix is not a free route
  const miss = await fetch(`${e.http}/plugin/nope/card`);
  expect(miss.status).toBe(404);
  expect((await miss.json()).ok).toBe(false);

  /* THE OLD SIDEBAND IS GONE (blueprint section 3): the per-session
   * /session/<id>/reply-level shim dials.test.ts drove was retired when the
   * dials became a plugin, so global reads and writes go through the ONE rpc
   * route and nowhere else. A 404 here is the assertion that there is no second
   * way in that could hold a second opinion about the level. */
  const shim = await fetch(`${e.http}/session/${PANE}/reply-level`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ level: 4 }),
  });
  expect(shim.status, "the retired per-session reply-level shim answered something").toBe(404);
}, 60_000);
