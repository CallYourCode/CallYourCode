/* THE ENGINE DECLARES ITS TABS, and the app draws what it is told.
 *
 * Two halves, testing two different fears.
 *
 * The pure half (tabs.ts) is about the arithmetic of a declaration: that every
 * session's tab is in it, that the order reads the same way the list under it
 * reads, and that a setting nobody set means nothing is declared.
 *
 * The wired half is about the WIRE, which is the only thing the app can see. A
 * declaration the engine agrees with internally and does not put in the frame
 * has declared nothing. Both halves of the pair he asked for are here: the host
 * that collapses to one list, and the host whose workspaces are its tabs,
 * differing by one setting and nothing else.
 *
 * NO ENGINE PROCESS for the wired half either: wireCore performs server.ts's
 * ordered boot in-process, `tabs` is the ENGINE_TABS value groupingFrom() reads,
 * and the fake herdr resolves each pane's workspace through the snapshot's own
 * workspaces array, so `w<n>:p<n>` pane names really do produce several
 * workspaces with several labels.
 *
 *   bun test agent-engine/src/sessions/tabs.test.ts
 */

import { test, expect, afterEach } from "bun:test";

import { declareTabs, groupingFrom, tabKeyOf, GROUPINGS } from "./tabs.ts";
import { wireCore, type WireCore, type FakeClient, wireId } from "../test-utils/wire-core.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { until } from "../test-utils/wait.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";

/** Sessions as tabs.ts sees them: nothing but where they sit. */
const rows = (...workspaces: string[]) => workspaces.map((workspace) => ({ workspace }));
const keys = (list: { key: string }[]) => list.map((t) => t.key);
const texts = (list: { title: { text: string } }[]) => list.map((t) => t.title.text);

// ------------------------------------------------------------- the arithmetic

test("an engine nobody configured declares nothing", () => {
  // The whole compatibility rule in one line: unset is what every engine older
  // than this file sends, and it must be indistinguishable from them.
  expect(groupingFrom(undefined)).toBe("off");
  expect(groupingFrom("")).toBe("off");
  expect(declareTabs(rows("alpha", "beta"), "off")).toEqual([]);
});

test("a grouping this engine does not know is refused, not guessed at", () => {
  // ENGINE_TABS=workspaces (the obvious slip) must not look exactly like
  // having asked for nothing with no complaint anywhere.
  expect(groupingFrom("workspaces")).toBe("off");
  expect(GROUPINGS).toContain("workspace");
});

test("the setting is read the way a person types it", () => {
  expect(groupingFrom(" Workspace ")).toBe("workspace");
});

test("one tab per workspace, in the order the sessions are in", () => {
  expect(keys(declareTabs(rows("beta", "alpha", "beta", "gamma"), "workspace")))
    .toEqual(["beta", "alpha", "gamma"]);
});

test("every session's tab is in the declaration", () => {
  // The property this module exists to hold. A row whose tab the strip does not
  // have is a conversation with nowhere to be drawn, which is worse than any
  // grouping being wrong.
  const sessions = rows("alpha", "beta", "alpha", "", "gamma");
  const declared = new Set(keys(declareTabs(sessions, "workspace")));
  for (const s of sessions) {
    expect(declared.has(tabKeyOf(s, "workspace")),
      `a session in workspace ${JSON.stringify(s.workspace)} names a tab that was not declared`)
      .toBe(true);
  }
});

test("a tab is named the same way a row is: text and detail", () => {
  const [tab] = declareTabs(rows("callyourcode"), "workspace");
  expect(tab.title, 'a tab title has to be the SAME shape as a row title ' +
    '(title.ts SessionTitle). Two naming schemes is two answers to one question.')
    .toEqual({ text: "callyourcode", detail: null });
});

test("a group with no name still gets a tab with something on it", () => {
  expect(texts(declareTabs(rows(""), "workspace"))).toEqual(["elsewhere"]);
});

test("with the grouping off, every session's tab is the same empty key", () => {
  // So a client groups by this field and gets ONE group, rather than needing to
  // know that not grouping is a thing that exists.
  expect(rows("alpha", "beta").map((s) => tabKeyOf(s, "off"))).toEqual(["", ""]);
});

// ------------------------------------------------------------------ the wire

let core: WireCore | null = null;
let http: ServedRoutes | null = null;
afterEach(async () => {
  http?.stop();
  http = null;
  await core?.stop();
  core = null;
});

/** Panes across three workspaces; the fake herdr reads the workspace off the id
 *  and labels it through the snapshot's own workspaces array. */
const SPREAD = ["red:p1", "red:p2", "blue:p1", "green:p1"];

async function start(tabs?: string): Promise<WireCore> {
  core = await wireCore({ panes: SPREAD, tabs, with: ["sessions"] });
  await until(() => core!.sessions.size === SPREAD.length, { what: "every pane to reconcile" });
  return core;
}

/** The sessions frame as a fresh page receives it. The wire is the contract. */
function frameFor(c: WireCore): { frame: any; burst: FakeClient } {
  const page = c.client();
  c.hello(page);
  const frame = page.last("sessions")!;
  return { frame, burst: page };
}

test("an engine that declares nothing puts no tabs on the wire at all", async () => {
  const c = await start(undefined);
  const { frame } = frameFor(c);
  expect(frame.tabs,
    'an unconfigured engine has to send the bytes it always sent. The app names ' +
    'a host better than the engine can (it knows when two engines share a ' +
    'machine), so declaring one tab here would be the engine overruling it.')
    .toBeUndefined();
  expect(frame.list.length).toBe(4);
  for (const s of frame.list) expect(s.tab).toBe("");
});

test("the workspace grouping declares one tab per workspace, and every row names one", async () => {
  const c = await start("workspace");
  const { frame } = frameFor(c);
  expect(frame.tabs.map((t: any) => t.key)).toEqual(["red", "blue", "green"]);
  expect(frame.tabs.map((t: any) => t.title.text)).toEqual(["red", "blue", "green"]);
  const declared = new Set(frame.tabs.map((t: any) => t.key));
  for (const s of frame.list) {
    expect(declared.has(s.tab),
      `session ${s.id} named tab ${JSON.stringify(s.tab)}, which is not in the declaration`)
      .toBe(true);
  }
  expect(frame.list.filter((s: any) => s.tab === "red").length).toBe(2);
});

test("the tabs travel in the SAME frame as the sessions that name them", async () => {
  /* Not tidiness. Sent as two frames there is an instant on every connect, and
   * again on every rename, where the app holds rows naming a tab it has not been
   * told about -- and its only two answers there are to invent the tab or to
   * drop the row, which are the two failures this whole change exists to make
   * impossible. */
  const c = await start("workspace");
  const page = c.client();
  c.hello(page);

  expect(page.of("tabs"),
    'a separate tabs frame is exactly the ordering hazard this avoids').toEqual([]);
  const sessions = page.of("sessions");
  expect(sessions.length).toBeGreaterThan(0);
  for (const f of sessions) expect(Array.isArray(f.tabs)).toBe(true);
});

test("the declaration is not a boot-time constant: dragging a row moves its tab", async () => {
  /* The strip has to read left to right in the order the rows under it read, and
   * the rows are the order he dragged them into (order.ts). Both come out of ONE
   * sort in sessionsFrame for exactly this reason: computed twice they are two
   * answers to one question and they drift.
   *
   * This is also the only change-while-connected this engine can be asked for
   * without a person at a terminal, and it proves the declaration is derived on
   * every frame rather than decided once at boot. */
  const c = await start("workspace");
  http = serveRoutes({ groups: [sessionOpsRoutes], ctx: { adapter: c.adapter } });
  expect(frameFor(c).frame.tabs.map((t: any) => t.key)).toEqual(["red", "blue", "green"]);

  const res = await http.post("/sessions/order",
    { order: ["green:p1", "blue:p1", "red:p1", "red:p2"].map(wireId) }).then((r) => r.json() as Promise<any>);
  expect(res.ok).toBe(true);

  expect(frameFor(c).frame.tabs.map((t: any) => t.key),
    'the rows moved and the strip above them did not. A tab strip in a ' +
    'different order from the list it heads is two orders for one thing.')
    .toEqual(["green", "blue", "red"]);
});

test("the re-declaration reaches the devices that did not drag, in one frame", async () => {
  /* The live half of the same fact. A watcher holding rows whose tab moved must
   * be sent the new strip WITH them, or it spends the gap grouping rows under a
   * tab that is no longer where it thinks. */
  const c = await start("workspace");
  http = serveRoutes({ groups: [sessionOpsRoutes], ctx: { adapter: c.adapter } });
  const watcher = c.client();
  c.hello(watcher);
  watcher.clear();

  await http.post("/sessions/order", { order: ["blue:p1", "green:p1", "red:p1", "red:p2"].map(wireId) });

  const pushed = watcher.last("sessions");
  expect(pushed, "the device that did not drag was told nothing").toBeDefined();
  expect(pushed!.tabs.map((t: any) => t.key)).toEqual(["blue", "green", "red"]);
  expect((pushed!.list as any[]).map((s) => s.id))
    .toEqual(["blue:p1", "green:p1", "red:p1", "red:p2"].map(wireId));
  // and the row/strip agreement holds on the pushed frame too
  const declared = new Set(pushed!.tabs.map((t: any) => t.key));
  for (const s of pushed!.list as any[]) expect(declared.has(s.tab)).toBe(true);
});

test("a workspace whose last pane goes away stops being declared", async () => {
  /* The declaration is derived from the SESSIONS, not from herdr's workspace
   * list, so a workspace with no conversation in it is not a tab. The other way
   * round -- deriving from herdr -- would leave an empty tab on the strip that
   * nothing can ever be drawn under. */
  const c = await start("workspace");
  await c.herdr.setAgentGone("green:p1", true);
  await until(() => !c.byHandle("green:p1"),
    { what: "the empty pane to be swept (it said nothing)" });

  expect(frameFor(c).frame.tabs.map((t: any) => t.key),
    "a workspace with no conversation left in it stayed on the strip").toEqual(["red", "blue"]);
});

test("every live pane is listed whatever agent it runs, and each lands in its own workspace",
  async () => {
    /* The L1 invariant meeting the grouping: a mixed fleet is still one row per
     * pane, and the tab is a fact about where the pane sits, never about what it
     * runs. A grouping that keyed on the agent would look identical on a
     * single-agent host, which is every host until it is not. */
    core = await wireCore({
      panes: ["red:p1", "blue:p1"],
      agents: { "red:p1": "codex", "blue:p1": "herdr:OpenCode" },
      tabs: "workspace",
      with: ["sessions"],
    });
    const c = core;
    await until(() => c.sessions.size === 2, { what: "the mixed fleet to reconcile" });
    const { frame } = frameFor(c);

    expect(frame.list.map((s: any) => s.agentId).sort()).toEqual(["codex", "opencode"]);
    expect(frame.tabs.map((t: any) => t.key)).toEqual(["red", "blue"]);
    expect(frame.list.map((s: any) => s.tab)).toEqual(["red", "blue"]);
  });
