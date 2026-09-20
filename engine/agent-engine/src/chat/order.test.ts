/* THE ORDER YOU DRAGGED THE CHAT LIST INTO.
 *
 * Two halves, and they are testing different fears.
 *
 * The pure half (order.ts) is about the arithmetic of a list of ids: a pane
 * herdr made a second ago must not teleport into the middle of an arrangement
 * you are looking at, and closing one row must not shuffle the others. Those are
 * the two ways a reorder feature usually goes wrong.
 *
 * The wired half is about it being ONE order for the host rather than one per
 * device: it has to reach the file, come back after a restart, follow
 * a conversation through a re-key, and go out to every connected client and not
 * just the one that dragged.
 *
 * NO ENGINE PROCESS: wireCore performs server.ts's ordered boot in-process, the
 * drop goes through the SHIPPED route over a real Bun.serve on port 0, and a
 * reset() in the same dirs is the restart -- so "it survives a restart" is the
 * file the previous wiring actually wrote, read by a real boot.
 *
 *   bun test agent-engine/src/chat/order.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";

import { parseOrder, nextOrder, sortSessions, MAX_REMEMBERED } from "./order.ts";
import { wireCore, type WireCore, wireId } from "../test-utils/wire-core.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { until } from "../test-utils/wait.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";

/** Sessions as sortSessions sees them: an id and herdr's number. */
const rows = (...ids: string[]) => ids.map((id, order) => ({ id, order }));
const ids = (list: { id: string }[]) => list.map((s) => s.id);

// ---------------------------------------------------------------- the arithmetic

test("a session you placed sorts where you placed it", () => {
  const list = rows("a", "b", "c");
  expect(ids(sortSessions(list, ["c", "a", "b"]))).toEqual(["c", "a", "b"]);
});

test("with no manual order at all, herdr's order is untouched", () => {
  // the old behaviour, and what every host looks like before the first drag
  expect(ids(sortSessions(rows("a", "b", "c"), []))).toEqual(["a", "b", "c"]);
});

test("a session herdr just created appears at the END, not inside the arrangement", () => {
  // "new" here means "not in the manual list": the engine has never been told
  // where it goes, so the only honest place for it is below what you arranged
  const list = rows("a", "b", "fresh");
  expect(ids(sortSessions(list, ["b", "a"]))).toEqual(["b", "a", "fresh"]);
});

test("several unplaced sessions keep herdr's relative order among themselves", () => {
  const list = [
    { id: "placed", order: 9 },
    { id: "new2", order: 5 },
    { id: "new1", order: 1 },
  ];
  expect(ids(sortSessions(list, ["placed"])),
    'unplaced rows fell back to insertion order instead of herdr\'s. They have ' +
    'no manual position, so herdr\'s number is the only thing left that means ' +
    'anything.').toEqual(["placed", "new1", "new2"]);
});

test("removing a session does not scramble the rest", () => {
  const manual = ["d", "b", "a", "c"];
  const before = ids(sortSessions(rows("a", "b", "c", "d"), manual));
  // "b" closes. Nothing rewrites the stored list -- a closed pane is exactly
  // as likely to come back as not -- so the others must simply close up.
  const after = ids(sortSessions(rows("a", "c", "d"), manual));
  expect(before).toEqual(["d", "b", "a", "c"]);
  expect(after,
    'closing one row moved the others. The stored order is a list of ids for ' +
    'precisely this reason: no row\'s position is expressed in terms of another ' +
    'row existing.').toEqual(["d", "a", "c"]);
});

test("a session that comes back lands where you left it", () => {
  // the other half of the removal rule: we keep the id, so a pane you closed
  // and reopened is not demoted to the bottom for having blinked
  const manual = ["d", "b", "a"];
  expect(ids(sortSessions(rows("a", "b", "d"), manual))).toEqual(["d", "b", "a"]);
});

test("a drop replaces the whole order and keeps ids the app did not mention", () => {
  const kept = nextOrder(["a", "b", "gone"], ["b", "a"]);
  expect(kept.slice(0, 2),
    'the app sends the WHOLE list it is showing, so what it sends wins').toEqual(["b", "a"]);
  expect(kept).toContain("gone");
});

test("a corrupt or half-written file degrades to herdr's order, not to a crash", () => {
  expect(parseOrder(null)).toEqual([]);
  expect(parseOrder({ a: 1 })).toEqual([]);
  expect(parseOrder("a,b")).toEqual([]);
  expect(parseOrder(["a", 7, "", null, "b", "a"]),
    'junk entries and duplicates have to be dropped: a duplicated id would ' +
    'give one session two positions').toEqual(["a", "b"]);
});

test("the remembered list is capped", () => {
  const many = Array.from({ length: MAX_REMEMBERED + 50 }, (_, i) => `p${i}`);
  expect(parseOrder(many).length).toBe(MAX_REMEMBERED);
  expect(nextOrder(many, ["x"]).length).toBe(MAX_REMEMBERED);
  // and the ids the app just dropped are the ones that survive the cap
  expect(nextOrder(many, ["x"])[0]).toBe("x");
});

// ---------------------------------------------------------------- the wire

let core: WireCore | null = null;
let http: ServedRoutes | null = null;
afterEach(async () => {
  http?.stop();
  http = null;
  await core?.stop();
  core = null;
});

const PANES = ["w1:p1", "w1:p2", "w1:p3"];

async function start(opts: Parameters<typeof wireCore>[0] = {}): Promise<WireCore> {
  core = await wireCore({ panes: PANES, with: ["sessions"], ...opts });
  await until(() => core!.sessions.size === (opts.panes ?? PANES).length,
    { what: "every pane to reconcile" });
  http = serveRoutes({ groups: [sessionOpsRoutes], ctx: { adapter: core.adapter } });
  return core;
}

/** The sessions list as a page receives it, in the order it receives it. The
 *  wire is the contract: an order the engine agrees with internally but ships
 *  scrambled has not reordered anything. */
function listedOrder(c: WireCore): string[] {
  const page = c.client();
  c.hello(page);
  const frame = page.last("sessions")!;
  page.close();
  return (frame.list as any[]).map((s) => s.id);
}

/** The wire ids of the sessions on these panes, in this order. The order is a
 *  list of AGENT ids (the wire id), never of pane handles. */
const wireIds = (...handles: string[]): string[] => handles.map(wireId);

/** Drop the panes into this order; the route speaks wire ids. */
const setOrder = (handles: string[]) =>
  http!.post("/sessions/order", { order: wireIds(...handles) }).then((r) => r.json() as Promise<any>);

const orderOnDisk = async (c: WireCore): Promise<unknown> =>
  JSON.parse(await Bun.file(join(c.dir, "settings.json")).text()).order;

test("a drop reorders the list and reaches the file", async () => {
  const c = await start();
  expect(listedOrder(c)).toEqual(wireIds(...PANES)); // herdr's order, to begin with

  const res = await setOrder(["w1:p3", "w1:p1", "w1:p2"]);
  expect(res.ok).toBe(true);
  // the route answers with the list it just produced, so a caller needs no frame
  expect(res.order).toEqual(wireIds("w1:p3", "w1:p1", "w1:p2"));
  expect(listedOrder(c)).toEqual(wireIds("w1:p3", "w1:p1", "w1:p2"));

  await until(async () => Array.isArray(await orderOnDisk(c).catch(() => null)),
    { what: "the order to reach settings.json" });
  expect(await orderOnDisk(c),
    'the order has to be on disk, not just in memory: it is one order for the ' +
    'host and the next boot is the same host').toEqual(wireIds("w1:p3", "w1:p1", "w1:p2"));
});

test("the order survives a restart", async () => {
  /* A restart done honestly: the drop writes the file, every module is reset,
   * and a real boot reads it back. Nothing is put on disk by the test. */
  const c = await start();
  await setOrder(["w1:p2", "w1:p3", "w1:p1"]);
  await until(async () => Array.isArray(await orderOnDisk(c).catch(() => null)),
    { what: "the order to reach settings.json" });

  await c.reset();
  await until(() => c.sessions.size === PANES.length, { what: "the restarted engine's panes" });
  expect(listedOrder(c), "the restarted engine forgot the arrangement")
    .toEqual(wireIds("w1:p2", "w1:p3", "w1:p1"));
});

test("a half-written order file degrades to herdr's order at boot rather than crashing", async () => {
  /* parseOrder's refusal, reached through a real boot. A settings.json caught
   * mid-write is the shape this actually happens in, and a boot that threw here
   * would take the whole engine down over a list of strings. */
  core = await wireCore({ panes: PANES, with: [], start: false });
  await Bun.write(join(core.dir, "settings.json"),
    JSON.stringify({ v: 1, order: { "w1:p1": 0 } }));
  await core.reset({ with: ["sessions"], start: true });
  await until(() => core!.sessions.size === PANES.length, { what: "every pane to reconcile" });

  expect(listedOrder(core), "a corrupt order file did not degrade to herdr's order").toEqual(wireIds(...PANES));
});

test("a drop on one device rearranges the others", async () => {
  // The whole reason the order lives here. Two clients, one drags, and the one
  // that did nothing must be told without asking.
  const c = await start();
  const watcher = c.client();
  c.hello(watcher);
  watcher.clear();

  await setOrder(["w1:p3", "w1:p2", "w1:p1"]);

  const pushed = watcher.last("sessions");
  expect(pushed, "no sessions frame reached the device that did not drag").toBeDefined();
  expect((pushed!.list as any[]).map((s) => s.id)).toEqual(wireIds("w1:p3", "w1:p2", "w1:p1"));
});

test("a pane herdr adds after you arranged the list goes to the bottom", async () => {
  // Placed two of the three, so the third has never been positioned.
  const c = await start();
  await setOrder(["w1:p3", "w1:p1"]);
  expect(listedOrder(c),
    'a session nobody has placed jumped into the arrangement. New panes belong ' +
    'below what you arranged, or the list moves while you are reading it.')
    .toEqual(wireIds("w1:p3", "w1:p1", "w1:p2"));
});

test("an order that is not a list of ids is refused, and changes nothing", async () => {
  /* The route's own gate. A body the engine cannot read must not be allowed to
   * half-apply: an order silently replaced with junk would rearrange his list on
   * every device at once and there is no undo for that. */
  const c = await start();
  await setOrder(["w1:p2", "w1:p1", "w1:p3"]);
  const before = listedOrder(c);

  const res = await http!.post("/sessions/order", { order: "w1:p1,w1:p2" });
  expect(res.status).toBe(400);
  expect((await res.json() as any).ok).toBe(false);
  expect(listedOrder(c), "a refused drop still moved the list").toEqual(before);
});

test("a conversation whose session id rolls keeps its place in the arrangement", async () => {
  /* What used to be the re-key branch (#405, #571). The stored order is a list
   * of AGENT ids, and an agent's id never changes: when claude mints its uuid
   * on a pane that had none, the row keeps the wire id it had, so the place he
   * dragged it to holds with no rewrite of the order at all. */
  const U = "5e1f2c33-4444-4bbb-8ccc-000000000004";
  const c = await start({ panes: ["w1:p1", "w1:p2"], noSession: ["w1:p1"] });
  const first = wireId("w1:p1");
  await setOrder(["w1:p1", "w1:p2"]);
  expect(listedOrder(c)).toEqual([first, wireId("w1:p2")]);
  await until(async () => Array.isArray(await orderOnDisk(c).catch(() => null)),
    { what: "the order to reach settings.json" });

  await c.herdr.mintSession("w1:p1", U);
  await until(() => !!c.sessionOf(U), { what: "the session to be adopted" });

  expect(c.sessionOf(U)!.id, "the row changed its wire id when its session id was minted").toBe(first);
  expect(listedOrder(c), "the conversation lost the place he dragged it to")
    .toEqual([first, wireId("w1:p2")]);
  expect(await orderOnDisk(c), "nothing in the order needed rewriting").toEqual([first, wireId("w1:p2")]);
});
