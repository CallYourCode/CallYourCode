/* THE DIALS AS A THING ON DISK (#585, the data-model move).
 *
 * reply-dials.test.ts asks what the store computes. This file asks the other
 * question, the one that only a RESTART can answer: what is in the file, and
 * what does a fresh boot make of it?
 *
 * Three properties, each of them a bug he actually lived with:
 *
 *   1. THE LEGACY FILE IS NOT TOUCHED. The engine carries no migration code
 *      (the design); an old reply-levels.json is simply not read, and it is
 *      still there, byte for byte, after a boot. Migrating it is done by hand.
 *   2. A MIGRATION SURVIVES UNTIL SOMEBODY STATES A LEVEL. A hand-migrated
 *      state is marked unadopted; a complexity-only drag must not clear that
 *      mark (the app would show the fallback forever), and stating a LEVEL must
 *      clear it for good, across a restart.
 *   3. A REJECTED SET CHANGES NOTHING. Not the answer, and not the file: a
 *      refusal that half-applied would survive as a dial nobody set.
 *
 * NO ENGINE. wireCore performs server.ts's ordered boot in-process and reset()
 * is the restart -- every module reset, the SAME data dir, a fresh fake herdr,
 * a store that re-reads rather than remembers. The ops ride the real
 * /plugin/reply-dials/rpc route on a Bun.serve on port 0. The one fact that
 * needs the real transport, the retired per-session /session/<id>/reply-level
 * shim answering 404, is asserted in e2e/plugin-rpc.test.ts.
 *
 *   bun test agent-engine/src/plugins/dials.test.ts
 */

import { test, expect, afterAll, afterEach, beforeAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { onUtterance } from "../../chat/deliver.ts";
import { replyDialsPlugin, replyDialsStore, type ReplyDialsStore } from "./index.ts";
import { pluginRoutes } from "../../routes/plugin.ts";
import { serveRoutes, type ServedRoutes } from "../../test-utils/serve-routes.ts";
import { wireCore, type FakeClient, type WireCore, wireId } from "../../test-utils/wire-core.ts";
import { PANE } from "../../test-utils/fake-herdr.ts";
import { until } from "../../test-utils/wait.ts";

/* HIS FILE, verbatim from the old reply-levels.json: proof material that the
 * ENGINE no longer touches it. */
const HIS_MAP = {
  "w6:p1": 4, "w9:p4": 3, "w9:p13": 4, "w9:p14": 3,
  "wE:p4": 4, "w9:p1G": 5, "w9:p1H": 5, "w9:p1K": 5,
};

/* The settle between a text and its enter, shortened through the adapter's own
 * knob: the fake pane has nothing to draw, so waiting 250ms for it to is time
 * spent proving nothing. */
const SAVED_SETTLE = process.env.DELIVER_SETTLE_MS;
process.env.DELIVER_SETTLE_MS = "5";

let core: WireCore;
let http: ServedRoutes | null = null;
let client: FakeClient | null = null;

beforeAll(async () => {
  core = await wireCore({ with: ["delivery"] });
});
afterAll(async () => {
  http?.stop();
  await core?.stop();
  if (SAVED_SETTLE === undefined) delete process.env.DELIVER_SETTLE_MS;
  else process.env.DELIVER_SETTLE_MS = SAVED_SETTLE;
});
afterEach(() => { http?.stop(); http = null; client = null; });

const dialsDir = () => join(core.dir, "plugins", "reply-dials");
const dialsFile = () => join(dialsDir(), "reply-dials.json");
const legacyFile = () => join(dialsDir(), "reply-levels.json");
const readDials = async () => await Bun.file(dialsFile()).json() as Record<string, unknown>;

/** Put `state` on disk as this engine's reply-dials.json (or take the file away
 *  when null) and BOOT ONTO IT: every module reset, the same data dir, a fresh
 *  fake herdr. A restart is a fresh process reading the same disk. */
async function bootHolding(state: unknown | null): Promise<ReplyDialsStore> {
  await mkdir(dialsDir(), { recursive: true });
  if (state === null) await rm(dialsFile(), { force: true });
  else await writeFile(dialsFile(), JSON.stringify(state));
  await core.reset();
  await until(() => !!core.byHandle(PANE), { what: "the pane to become a session" });
  client = core.client();
  const store = await replyDialsStore();
  /* WIRE THE APPEND THE WAY THE PLUGIN DOES. This delivery test does not load the
   * plugins layer that registers the reply-dials input transform in a real
   * engine, so it registers the same postfix hook itself, over the store, into
   * this wiring's live registry. A restart (core.reset above) built a fresh
   * registry, so this runs on every bootHolding. */
  core.registerInputTransform("reply-dials",
    (input) => ({ postfix: store.askFor(input.channels).instruction }));
  /* The ops run against the store this WIRING built, not a second one: the
   * dials are engine-global and two stores over one file is exactly the drift
   * a rebooted engine must not have. */
  const spec = replyDialsPlugin({ store });
  http = serveRoutes({ groups: [pluginRoutes],
    ctx: { plugins: () => [spec], pluginById: (id) => (id === spec.id ? spec : undefined) } });
  return store;
}

const rpc = (op: string, args: unknown = {}) => http!.post(`/plugin/reply-dials/rpc/${op}`, { args });
const getDials = async () => ((await (await rpc("get")).json()) as any).result as Record<string, unknown>;

/** Deliver one message and hand back the line the pane got. The Stop hook is
 *  verbosity-unaware now, so the delivery it records carries no `needs`: the
 *  appended instruction is a soft nudge, checked here on the delivered line. */
async function deliverAndRead(body: string): Promise<{ line: string }> {
  const before = core.submitted.length;
  await onUtterance(client!.sock, { id: wireId(PANE), text: body });
  await until(() => core.submitted.length > before, { what: `the pane to submit ${body}` });
  return { line: core.submitted.at(-1)!.text };
}

// ---------------------------------------------------- the store on disk

test("a legacy reply-levels.json is IGNORED and untouched: no in-engine migration", async () => {
  const raw = JSON.stringify(HIS_MAP);
  await mkdir(dialsDir(), { recursive: true });
  await writeFile(legacyFile(), raw);
  await bootHolding(null); // his old file present, no reply-dials.json beside it

  // defaults stand, nothing claims a migration, and the legacy bytes are intact
  expect(await getDials()).toMatchObject({ level: 3, complexity: 3, migrated: false });
  expect(await Bun.file(dialsFile()).exists(),
    "the boot wrote a dials file nobody asked it to").toBe(false);
  expect(await Bun.file(legacyFile()).text(),
    "the engine rewrote his legacy file").toBe(raw);

  /* And it stays untouched through a WRITE: a set persists the new store's own
   * file and still leaves the old one alone, so a hand migration can be done
   * afterwards from bytes that are still his. */
  expect((await rpc("set", { key: "verbosity", n: 4 })).status).toBe(200);
  expect(await readDials()).toMatchObject({ level: 4 });
  expect(await Bun.file(legacyFile()).text()).toBe(raw);
  await rm(legacyFile(), { force: true });
});

test("nothing on disk: the ship defaults, and no migration is claimed", async () => {
  await bootHolding(null);
  expect(await getDials()).toMatchObject({
    level: 3, complexity: 3, migrated: false,
    verbosityOn: true, complexityOn: false, promptBitsOn: true,
  });
  // a read is not a write: an engine nobody has touched leaves no file behind
  expect(await Bun.file(dialsFile()).exists()).toBe(false);
});

/* The migrated flag still round-trips: a state a hand migration wrote as
 * unadopted must survive restarts and a complexity-only push, or the app shows
 * the fallback forever while the agent answers at the migrated level. */
test("a complexity-only push keeps a migrated state adoptable across a restart", async () => {
  await bootHolding({ v: 1, level: 5, complexity: 3, migrated: true });
  expect(await getDials()).toMatchObject({ level: 5, migrated: true });

  // one drag of the complexity dial: a partial push that says nothing about level
  expect((await rpc("set", { key: "complexity", n: 5 })).status).toBe(200);
  expect(await getDials()).toMatchObject({ level: 5, complexity: 5, migrated: true });

  const onDisk = await readDials();
  expect(onDisk.level, "his migrated level is not in the file").toBe(5);
  expect(onDisk.complexity, "the complexity he chose is not in the file").toBe(5);
  expect(onDisk.migrated,
    "the file does not record that this level is an unadopted migration").toBe(true);

  await bootHolding(onDisk);
  expect(await getDials(),
    "the migration died at the restart: the app would show the fallback forever")
    .toMatchObject({ level: 5, complexity: 5, migrated: true });
});

test("stating a LEVEL ends the migration, on disk and across a restart", async () => {
  await bootHolding({ v: 1, level: 5, complexity: 3, migrated: true });
  expect((await rpc("set", { key: "verbosity", n: 2 })).status).toBe(200);
  expect(await readDials()).toMatchObject({ level: 2, migrated: false });

  await bootHolding(await readDials());
  expect(await getDials(),
    "the engine still offers a migration after somebody chose a level")
    .toMatchObject({ level: 2, migrated: false });
});

// ---------------------------------------------------- the per-dial toggles

test("both dials off appends nothing; verbosity back on restores its instruction", async () => {
  /* The append is a soft nudge, so the teeth are gone: what is left to prove is
   * that the gating is honoured on the delivered line. Both dials off means the
   * line is the bare message; verbosity back on appends the rung's instruction
   * again. */
  await bootHolding(null);
  expect((await rpc("toggle", { verbosityOn: false, complexityOn: false })).status).toBe(200);
  expect(await getDials()).toMatchObject({ verbosityOn: false, complexityOn: false });

  const off = await deliverAndRead("switch is off here");
  expect(off.line, "an instruction was appended even though both dials are off")
    .toBe("TEXT: switch is off here");

  expect((await rpc("toggle", { verbosityOn: true })).status).toBe(200);
  expect(await getDials(), "turning verbosity back on turned complexity on too")
    .toMatchObject({ verbosityOn: true, complexityOn: false });

  const on = await deliverAndRead("switch is on again");
  expect(on.line.endsWith("switch is on again"),
    "nothing was appended after verbosity was restored").toBe(false);
});

// ---------------------------------------------------- the refusals

test("a rejected plugin set changes NOTHING AT ALL: not the answer, not the file", async () => {
  /* Latent, not user-reachable: the app clamps both dials to 1..5 before
   * sending. The plugin still must reject a malformed set without changing its
   * store, because the store is what a fresh boot reads -- a rejection that had
   * half-applied would come back as a dial nobody set. */
  await bootHolding({ v: 1, level: 5, complexity: 3, migrated: true });
  const before = await Bun.file(dialsFile()).text();

  for (const args of [{ key: "complexity", n: "x" }, { key: "verbosity", n: 9 },
    { key: "verbosity", n: 0 }, { key: "nope", n: 3 }, {}]) {
    const r = await rpc("set", args);
    expect(r.status, `${JSON.stringify(args)} should be a 400, not a 500`).toBe(400);
    expect((await r.json() as any).ok).toBe(false);
  }

  expect(await getDials(), "a rejected set moved a dial")
    .toMatchObject({ level: 5, complexity: 3, migrated: true });
  expect(await Bun.file(dialsFile()).text(),
    "a rejected write touched the store, byte for byte").toBe(before);

  // and the refusals left a working engine: the next good set still lands
  expect((await rpc("set", { key: "complexity", n: 2 })).status).toBe(200);
  expect(await readDials()).toMatchObject({ level: 5, complexity: 2 });
});

test("a rejected BITS list is refused by name and the old list survives a restart", async () => {
  /* The same rule on the other op: the bit menu is a list he curated, and a
   * refusal that had written half of it would be a menu he did not choose,
   * restored on every boot from then on. */
  await bootHolding(null);
  expect((await rpc("bits", { bits: ["keep", "these"] })).status).toBe(200);
  const saved = await Bun.file(dialsFile()).text();

  const tooLong = await rpc("bits", { bits: ["ok", "x".repeat(201)] });
  expect(tooLong.status).toBe(400);
  expect((await tooLong.json() as any).error).toMatch(/too long: 201 > 200/);
  expect(await Bun.file(dialsFile()).text(), "the refused list reached the disk").toBe(saved);

  await bootHolding(await readDials());
  expect((await getDials()).bits).toEqual(["keep", "these"]);
});
