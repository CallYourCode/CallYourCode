/* RENAMING A SESSION, which is the ENGINE-SIDE OVERRIDE for its one title.
 *
 * His call, 2026-08-06: "each session has just the title and that's it. On the
 * agent engine side have it use Claude's session title and allow renaming. The
 * rename then is our agent-engine-side override for that session."
 *
 * The title is resolved override > Claude's own title > pane name (title.ts);
 * the ORDER and the Claude-title extraction are unit-tested in title.test.ts.
 * This file is the other half: the POST /session/:id/rename route sets the
 * override, the override wins ON THE WIRE, clearing it falls back, every device
 * is told, and -- the property that makes a rename worth typing -- it survives a
 * restart, because it is written to the agent's meta.json and restored on boot.
 *
 * THE WIRE IS THE CONTRACT. An override that only lives in a Map inside the
 * engine has renamed nothing, so every assertion here reads a row off a real
 * sessions frame rather than asking the store what it thinks.
 *
 * NO ENGINE PROCESS: wireCore performs server.ts's ordered boot in-process, the
 * route runs over a real Bun.serve on port 0 against the real route group, and a
 * reset() in the same dirs is the restart.
 *
 *   bun test agent-engine/src/sessions/names.test.ts
 */

import { test, expect, afterEach } from "bun:test";

import { wireCore, type WireCore, type FakeClient, wireId } from "../test-utils/wire-core.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { PANE, defaultSessionIdOf } from "../test-utils/fake-herdr.ts";
/* The harness id the fake herdr reports for PANE: what the disk records
 * (meta.json sessionId, the chat log) are keyed by, never the pane id. */
const PANE_SID = defaultSessionIdOf(PANE);
import { until } from "../test-utils/wait.ts";
import { metaForSession } from "../test-utils/builders.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";

let core: WireCore | null = null;
let http: ServedRoutes | null = null;
afterEach(async () => {
  http?.stop();
  http = null;
  await core?.stop();
  core = null;
});

async function start(): Promise<WireCore> {
  core = await wireCore({ with: ["sessions"] });
  await until(() => !!core!.byHandle(PANE), { what: "the pane to become a session" });
  http = serveRoutes({ groups: [sessionOpsRoutes], ctx: { adapter: core.adapter } });
  return core;
}

/** Rename the session hosted on a pane; the route is keyed by the wire id. */
const rename = (handle: string, name: string) =>
  http!.post(`/session/${encodeURIComponent(wireId(handle))}/rename`, { name });

/** One row off a REAL sessions frame, exactly as a fresh device receives it. */
function row(c: WireCore, handle = PANE): any {
  const page = c.client();
  c.hello(page);
  const frame = page.last("sessions")!;
  page.close();
  return (frame.list as any[]).find((s) => s.id === wireId(handle));
}

test("a rename shows on the row and wins over the pane name, as one title with no detail", async () => {
  const c = await start();
  const before = row(c);
  expect(before.name, "the fake pane has a name before any rename").toBeTruthy();

  const res = await rename(PANE, "Renamed by me");
  const body = await res.json() as any;
  expect(body.ok).toBe(true);
  /* The pane label moved too: the rename is one act, and a herdr pane still
   * wearing the old word is the same session called two things. */
  expect(body.inHerdr, "the rename never reached the multiplexer's own pane label").toBe(true);

  const after = row(c);
  expect(after.name,
    "the override is the word you typed; the row's name must be it, not the pane name")
    .toBe("Renamed by me");
  expect(after.title.text,
    "and the one title the app renders is the same string, so the row and the topbar agree")
    .toBe("Renamed by me");
  expect(after.title.detail,
    "his call: 'each session has just the title and that's it' -- there is no second part")
    .toBeNull();
});

test("clearing the rename falls back to the pane name", async () => {
  const c = await start();
  const original = row(c).name;

  await rename(PANE, "temporary name");
  expect(row(c).name).toBe("temporary name");

  const res = await rename(PANE, "");
  expect((await res.json() as any).ok).toBe(true);
  expect(row(c).name,
    "an empty name clears the override, so the row falls back to what the provider calls the pane")
    .toBe(original);
  // ...and the cleared override leaves nothing behind on disk to be restored
  await until(async () => (await metaForSession(c.root, PANE_SID))?.name === undefined,
    { what: "the cleared override to leave the agent record" });
});

test("a rename reaches every connected device, not just the one that asked", async () => {
  /* The reason the override lives on the engine at all: there is ONE
   * piece of state and every device is a view of it. broadcastSessions is what
   * makes the tablet follow the phone, and it is the same call the order route
   * makes. A rename that only answered the caller would leave two devices
   * disagreeing about what a conversation is called until the next reconnect. */
  const c = await start();
  const watcher = c.client();
  c.hello(watcher);
  watcher.clear();

  await rename(PANE, "seen from the other device");

  const pushed = watcher.last("sessions");
  expect(pushed, "the device that did nothing was told nothing").toBeDefined();
  expect((pushed!.list as any[]).find((s) => s.id === wireId(PANE)).name).toBe("seen from the other device");
});

test("the rename survives a restart, because it is written to the agent meta and restored on boot",
  async () => {
    const c = await start();
    await rename(PANE, "still my name");
    expect(row(c).name).toBe("still my name");

    /* ON DISK, in the agent's own record. A rename that only lived in memory
     * would be gone on restart, which is exactly what makes typing one feel
     * pointless. */
    await until(async () => (await metaForSession(c.root, PANE_SID))?.name === "still my name",
      { what: "the override to reach the agent record" });

    /* THE RESTART: every module reset, the same data dir, a fresh fake herdr
     * reporting the same pane. That is what boot sees, and the pane it
     * re-snapshots must wear the name again. */
    await c.reset();
    await until(() => !!c.byHandle(PANE), { what: "the restarted engine's session" });
    expect(row(c).name,
      "the restarted engine forgot the rename, so the override is not restored on boot")
      .toBe("still my name");
  });

test("a rename is trimmed and capped, and an unknown session is refused", async () => {
  /* The route's own edges. The cap matters because the name is drawn in a fixed
   * row; the 404 matters because a rename that answered ok for a session that
   * does not exist would leave an override keyed to nothing, restored forever. */
  const c = await start();

  const padded = await rename(PANE, "   padded name   ").then((r) => r.json() as Promise<any>);
  expect(padded.name, "the name was stored with the whitespace he did not type").toBe("padded name");
  expect(row(c).name).toBe("padded name");

  const long = "x".repeat(200);
  const capped = await rename(PANE, long).then((r) => r.json() as Promise<any>);
  expect(capped.name.length, "an unbounded name reached the row").toBe(80);
  expect(row(c).name.length).toBe(80);

  const missing = await rename("no-such-session", "whatever");
  expect(missing.status, "a rename for a session that does not exist was accepted").toBe(404);
  expect((await missing.json() as any).ok).toBe(false);
});

test("a rename belongs to ONE conversation: its neighbour is untouched", async () => {
  /* The override is keyed per session, and the sessions frame resolves each row's
   * title independently. Two panes in one workspace is the cheapest way for a
   * store keyed a little too loosely to show itself. */
  core = await wireCore({ panes: ["w1:p1", "w1:p2"], with: ["sessions"] });
  const c = core;
  await until(() => c.sessions.size === 2, { what: "both panes" });
  http = serveRoutes({ groups: [sessionOpsRoutes], ctx: { adapter: c.adapter } });
  const neighbour = row(c, "w1:p2").name;

  await rename("w1:p1", "only this one");

  expect(row(c, "w1:p1").name).toBe("only this one");
  expect(row(c, "w1:p2").name, "renaming one conversation renamed its neighbour").toBe(neighbour);
});
