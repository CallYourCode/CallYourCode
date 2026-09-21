/* THE PLUS BUTTON'S HARNESS PICK AND RECENT FOLDERS, on the real routes.
 *
 * The "+" button now offers a harness (claude / codex / opencode / pi, each
 * gated by a real PATH probe on the engine host) and a Recent-folders group
 * (folders any agent ran in before, from the durable pane-binding history).
 * POST /new-session takes an optional `harness` and the cwd allow-list is
 * widened by exactly that history.
 *
 * SAME RIG AS newsession.test.ts: wireCore's FakeHerdr (which owns CYC_DATA_DIR
 * in a temp dir, so recordBinding's savePaneBindings is safe) behind a port-0
 * Bun.serve over the real sessionOpsRoutes. Nothing creates a real tab or
 * session. binaryOnPath is injected per test so the PATH probe is deterministic
 * and hermetic.
 *
 * Test 4 in the plan ("default unchanged") is NOT re-asserted here: it is the
 * existing newsession.test.ts:178-214 pair, which stays green unmodified. Test 6
 * (recents derivation) and test 9 (probe unit) live in their own files
 * (recents.test.ts, ../runtime/which.test.ts).
 *
 *   bun test agent-engine/src/sessions/plus-harness.test.ts
 */

import { test, expect, afterEach } from "bun:test";

import { sessionOpsRoutes } from "../routes/session-ops.ts";
import { chatRoutes } from "../routes/chat.ts";
import { wireCore, type WireCore } from "../test-utils/wire-core.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { PANE, HARNESS_CWD } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { recordBinding, markBindingDead } from "./session-state.ts";

let core: WireCore | null = null;
let http: ServedRoutes | null = null;
afterEach(async () => {
  http?.stop();
  http = null;
  await core?.stop();
  core = null;
});

/** The real routes over a wiring whose one pane gives the guard a known cwd,
 *  with an injectable PATH probe (default: everything installed). */
async function routed(binaryOnPath: (p: string) => boolean = () => true):
  Promise<{ c: WireCore; http: ServedRoutes }> {
  core = await wireCore({ with: ["delivery"] });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  http = serveRoutes({
    groups: [sessionOpsRoutes, chatRoutes],
    ctx: {
      adapter: core.adapter,
      claudeCommand: core.adapter.launchCommand("claude")!,
      binaryOnPath,
      engineHome: "/tmp/does-not-exist-home",
      engineRepo: "/tmp/engine-checkout",
    },
  });
  return { c: core, http };
}

const tabCreates = (c: WireCore) => c.herdr.rpcs.filter((r) => r.method === "tab.create");

/* ------------------------------------------------------ 1. harness spawns its
 * own command (not always claude). */

test("harness codex spawns the codex launch command, id-prefixed", async () => {
  const { c, http: h } = await routed(() => true);
  const res = await h.post("/new-session", { cwd: HARNESS_CWD, near: PANE, harness: "codex" });
  const body = await res.json() as { ok: boolean; paneId?: string };
  expect(body.ok, `the route refused: ${JSON.stringify(body)}`).toBe(true);

  const typed = c.herdr.texts.filter((t) => t.paneId === body.paneId);
  expect(typed).toHaveLength(1);
  expect(typed[0]!.text).toMatch(
    /^env CYC_AGENT_ID=ag-[A-Za-z0-9_-]{16} codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false$/);
  // and it is literally the reader's own launch command, not a copy
  expect(typed[0]!.text.endsWith(c.adapter.launchCommand("codex")!)).toBe(true);
});

test("harness pi spawns the shipped `pi` binary (through the pi socket augmentation)", async () => {
  const { c, http: h } = await routed(() => true);
  const res = await h.post("/new-session", { cwd: HARNESS_CWD, near: PANE, harness: "pi" });
  const body = await res.json() as { ok: boolean; paneId?: string };
  expect(body.ok, `the route refused: ${JSON.stringify(body)}`).toBe(true);
  const typed = c.herdr.texts.filter((t) => t.paneId === body.paneId);
  expect(typed).toHaveLength(1);
  /* pi is the harness spawned, not claude, and the program is the shipped `pi`
   * binary end users have (no personal wrapper). NOT asserted as endsWith("pi"):
   * the adapter augments a pi launch at spawn (CYC_PI_EVENT_SOCK + a trailing
   * `-e <ext>`, mux-adapter.ts spawn / adapters/pi-launch.ts, Risk 4), so the
   * literal command carries the socket wiring around the `pi` token. The
   * invariant is that `pi` is the program and it is id-prefixed, whether or
   * not the socket bind succeeded (a bind failure falls back to plain `pi`).
   * The personal `pi-run` wrapper must never appear in a product launch. */
  expect(typed[0]!.text).toMatch(/(?:^| )pi(?: |$)/);
  expect(typed[0]!.text).not.toMatch(/pi-run/);
  expect(typed[0]!.text).toMatch(/CYC_AGENT_ID=ag-[A-Za-z0-9_-]{16}/);
  expect(typed[0]!.text).not.toMatch(/claude|codex|--dangerously/);
});

/* ------------------------------------------------------ 2. unknown harness. */

test("an unknown harness is refused 400 and starts nothing", async () => {
  const { c, http: h } = await routed(() => true);
  const res = await h.post("/new-session", { cwd: HARNESS_CWD, near: PANE, harness: "zork" });
  expect(res.status).toBe(400);
  expect(String((await res.json()).error)).toMatch(/unknown harness/);
  expect(tabCreates(c), "a tab was created for an unknown harness").toHaveLength(0);
});

/* ------------------------------------------------------ 3. unavailable harness
 * is per-kind: one missing binary does not block the others. */

test("a harness whose binary is not on PATH is refused, but another still starts", async () => {
  // codex is the one binary missing; everything else resolves.
  const { c, http: h } = await routed((p) => p !== "codex");

  const bad = await h.post("/new-session", { cwd: HARNESS_CWD, near: PANE, harness: "codex" });
  expect(bad.status).toBe(400);
  expect(String((await bad.json()).error)).toMatch(/not installed/);
  expect(tabCreates(c), "a tab was created for a not-installed harness").toHaveLength(0);

  // same wiring, a harness that IS installed still succeeds (per-kind gate).
  const ok = await h.post("/new-session", { cwd: HARNESS_CWD, near: PANE, harness: "claude" });
  const body = await ok.json() as { ok: boolean };
  expect(body.ok, `claude was refused too: ${JSON.stringify(body)}`).toBe(true);
  expect(tabCreates(c)).toHaveLength(1);
});

/* ------------------------------------------------------ 3b. the DEFAULT start
 * (no `harness` field: the app's ordinary "+") is gated too. A missing claude
 * used to skip the PATH probe on this path and spawn a dead shell, and the app
 * hung on "started, but it has not appeared here yet"; now it refuses 400. */

test("a default new-session is refused when claude is not installed, and starts nothing", async () => {
  // claude is the one missing binary; the request names no harness, so it defaults to claude.
  const { c, http: h } = await routed((p) => p !== "claude");
  const res = await h.post("/new-session", { cwd: HARNESS_CWD, near: PANE });
  expect(res.status).toBe(400);
  expect(String((await res.json()).error)).toMatch(/claude is not installed/);
  expect(tabCreates(c), "a tab was created for a default start with no claude").toHaveLength(0);
});

/* ------------------------------------------------------ 5. the places harness
 * list: launchableKinds order, per-kind availability, pi present. The list
 * LENGTH is not asserted (opencode's presence flips when resume-by-id lands). */

test("places lists harnesses in adapter order with per-kind availability", async () => {
  const { c, http: h } = await routed((p) => p !== "codex");
  const body = await (await h.get("/new-session/places")).json() as
    { harnesses: Array<{ kind: string; available: boolean }> };

  // exactly the adapter's launchableKinds order, so claude leads.
  expect(body.harnesses.map((x) => x.kind))
    .toEqual(c.adapter.launchableKinds().map((k) => k.kind));
  expect(body.harnesses[0]!.kind).toBe("claude");
  expect(body.harnesses[0]!.available).toBe(true);

  const codex = body.harnesses.find((x) => x.kind === "codex");
  expect(codex, "codex missing from the harness list").toBeDefined();
  expect(codex!.available).toBe(false);

  // pi is present (the harnessKinds-omits-pi bug cannot recur here).
  const pi = body.harnesses.find((x) => x.kind === "pi");
  expect(pi, "pi missing from the harness list").toBeDefined();
  expect(pi!.available).toBe(true);
});

test("the availability probe token for pi is the shipped `pi` binary, never `pi-run`", async () => {
  // The PATH probe resolves the program token of each reader's launch command
  // (routes/session-ops.ts programToken). pi must probe for `pi`, the binary
  // end users actually have, not the personal `pi-run` wrapper.
  const probed: string[] = [];
  const { http: h } = await routed((p) => { probed.push(p); return true; });
  await (await h.get("/new-session/places")).json();
  expect(probed, "pi probed the shipped binary").toContain("pi");
  expect(probed, "pi must not probe the personal wrapper").not.toContain("pi-run");
});

/* ------------------------------------------------------ 7. the places Recent
 * group: a remembered (dead) folder shows, a live one does not (it is already
 * offered in the live places list). */

test("places puts a remembered folder in recent, and never the live one", async () => {
  const { c, http: h } = await routed(() => true);
  // a folder an agent ran in once and left (dead binding, its own handle).
  recordBinding("hist-old", { agentId: "ag-histoldxxxxxxxxxx", sessionId: null, cwd: "/old/proj" });
  markBindingDead("hist-old");

  const body = await (await h.get("/new-session/places")).json() as
    { places: string[]; recent: string[] };

  expect(body.recent).toContain("/old/proj");
  // HARNESS_CWD is live (in places), so it must not be duplicated into recent.
  expect(body.places).toContain(HARNESS_CWD);
  expect(body.recent).not.toContain(HARNESS_CWD);
});

/* ------------------------------------------------------ 8. the widened gate
 * accepts a history cwd, still refuses an arbitrary path and the empty one. */

test("a history folder starts, /etc is refused, empty cwd is refused", async () => {
  const { c, http: h } = await routed(() => true);
  recordBinding("hist-proj", { agentId: "ag-histprojxxxxxxxxx", sessionId: null, cwd: "/old/proj" });
  markBindingDead("hist-proj");

  // in the pane-binding history -> accepted, and a tab is made.
  const good = await h.post("/new-session", { cwd: "/old/proj", near: PANE });
  const body = await good.json() as { ok: boolean };
  expect(body.ok, `a history folder was refused: ${JSON.stringify(body)}`).toBe(true);
  const afterGood = tabCreates(c).length;
  expect(afterGood).toBeGreaterThan(0);

  // an arbitrary path never recorded -> refused, no new tab.
  const etc = await h.post("/new-session", { cwd: "/etc" });
  expect(etc.status).toBe(400);
  expect(String((await etc.json()).error)).toMatch(/unknown directory/);
  expect(tabCreates(c)).toHaveLength(afterGood);

  // the empty-string stub value is unusable: 400 before the gate.
  const empty = await h.post("/new-session", { cwd: "" });
  expect(empty.status).toBe(400);
  expect(String((await empty.json()).error)).toMatch(/cwd required/);
  expect(tabCreates(c)).toHaveLength(afterGood);
});
