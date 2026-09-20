/* THE REPLY DIALS (#585): the store's arithmetic, and the ops that move it.
 *
 * The dials are engine-global state that changes what every message this engine
 * delivers ASKS FOR: how much to say and how technical to pitch it. It is a soft
 * nudge appended to the message, never enforced. So the store is where a wrong
 * answer is cheapest to have and most expensive to ship, and this file spends
 * most of itself there: defaults, sparse overrides, the per-dial gating, the
 * channel bending, the migration translation, the bits cap and the composer
 * widgets the app draws from.
 *
 * NO ENGINE, ANYWHERE. The store is a class over a directory; the ops are the
 * real replyDialsPlugin over the real /plugin/<id>/rpc/<op> route on a Bun.serve
 * on port 0. What neither tier can reach is the JOIN -- a `set` re-declaring the
 * plugin list and BROADCASTING it over the sealed DataChannel to a device that
 * asked for nothing -- and that is e2e/plugin-rpc.test.ts's whole subject. It is
 * not duplicated here. What IS here is the plugin's half of it: the decl rebuilt
 * after a set carries the moved rung, which is what makes the broadcast worth
 * sending.
 *
 * The delivered LINE (what the appended instruction does to a real message) is
 * strings.test.ts; the ON-DISK behaviour across a restart is dials.test.ts.
 *
 *   bun test agent-engine/src/plugins/reply-dials/reply-dials.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ReplyDialsStore,
  migrateLegacyLevels,
  defaultState,
  stepHint,
  DEFAULT_REPLY_NAMES,
  DEFAULT_REPLY_TEXT,
  DEFAULT_COMPLEXITY_NAMES,
  DEFAULT_COMPLEXITY_TEXT,
  DEFAULT_PROMPT_BITS,
  DEFAULT_REPLY_LEVEL,
  RUNGS,
  replyDialsPlugin,
} from "./index.ts";
import { declarePlugins } from "../registry.ts";
import { MENU_ITEM_TEXT_MAX, MENU_MAX_ITEMS } from "../platform/spec.ts";
import { pluginRoutes } from "../../routes/plugin.ts";
import { serveRoutes, type ServedRoutes } from "../../test-utils/serve-routes.ts";
import { tmpDir } from "../../test-utils/tmp.ts";

/** A store over a directory nothing else in this file can see. */
async function tmpStore(): Promise<{ store: ReplyDialsStore; dir: string }> {
  const dir = await tmpDir("reply-dials-");
  return { store: new ReplyDialsStore(dir + "/"), dir };
}

// ============================== the store ==================================

test("defaults: level 3, complexity 3, verbosity and bits on, complexity off", async () => {
  const { store } = await tmpStore();
  expect(await store.load(), "an empty dir is a fresh engine, not a migration").toBeNull();
  expect(store.level()).toBe(3);
  expect(store.complexity()).toBe(3);
  const s = store.state();
  // SHIP DEFAULT (his call): bits + verbosity on, complexity OFF
  expect([s.verbosityOn, s.complexityOn, s.promptBitsOn]).toEqual([true, false, true]);
  expect(store.verbosityName(3)).toBe("Read out");
  expect(store.verbosityText(3)).toBe(DEFAULT_REPLY_TEXT[3]);
  expect(store.complexityName(1)).toBe("Product Manager");
  expect(store.bits()).toEqual(DEFAULT_PROMPT_BITS);
  expect(store.isMigrated()).toBe(false);
  // and the ship default is the same object defaultState() promises
  expect(s).toEqual(defaultState());
});

test("a rung nobody defined reads as empty, never as undefined on the wire", async () => {
  /* askFor(0) is a real call: a session with no channel at all bends to level 0,
   * and verbosityText(0) is what gets appended. It must be the empty string, or
   * the delivered line ends in "undefined". */
  const { store } = await tmpStore();
  await store.load();
  expect(store.verbosityText(0)).toBe("");
  expect(store.verbosityName(0)).toBe("");
  expect(store.complexityText(9)).toBe("");
});

test("sparse overrides: an edit stores only that rung, a reset removes it", async () => {
  const { store } = await tmpStore();
  await store.load();
  await store.setWording({ reply: { 2: { text: " (my two)" } } });
  expect(store.verbosityText(2)).toBe(" (my two)");
  expect(store.verbosityText(3)).toBe(DEFAULT_REPLY_TEXT[3]); // untouched rung still default
  expect(store.state().overrides.reply).toEqual({ 2: { text: " (my two)" } });
  // null clears the one override back to the default
  await store.setWording({ reply: { 2: { text: null } } });
  expect(store.verbosityText(2)).toBe(DEFAULT_REPLY_TEXT[2]);
  expect(store.state().overrides.reply).toBeUndefined();
});

test("sparse overrides: a NAME and a TEXT on one rung are independent", async () => {
  /* The two halves are separate fields on one rung, and clearing one must not
   * take the other with it: he can rename a rung and keep its wording, or the
   * other way round. */
  const { store } = await tmpStore();
  await store.load();
  await store.setWording({ reply: { 4: { name: "Louder", text: " (say more)" } } });
  expect(store.verbosityName(4)).toBe("Louder");
  expect(store.verbosityText(4)).toBe(" (say more)");
  await store.setWording({ reply: { 4: { text: null } } });
  expect(store.verbosityName(4), "clearing the text took the name with it").toBe("Louder");
  expect(store.verbosityText(4)).toBe(DEFAULT_REPLY_TEXT[4]);
  await store.setWording({ reply: { 4: { name: null } } });
  expect(store.verbosityName(4)).toBe(DEFAULT_REPLY_NAMES[4]);
  expect(store.state().overrides.reply, "the emptied rung left an empty bag behind").toBeUndefined();
});

test("resetWording drops one scale or both, and leaves the other alone", async () => {
  const { store } = await tmpStore();
  await store.load();
  await store.setWording({
    reply: { 1: { text: " (v1)" } },
    complexity: { 1: { text: " (c1)" } },
  });
  await store.resetWording("reply");
  expect(store.verbosityText(1)).toBe(DEFAULT_REPLY_TEXT[1]);
  expect(store.complexityText(1), "resetting verbosity wiped complexity too").toBe(" (c1)");
  await store.resetWording("all");
  expect(store.complexityText(1)).toBe(DEFAULT_COMPLEXITY_TEXT[1]);
  expect(store.state().overrides).toEqual({});
});

test("askFor gating (D4): verbosityOn gates its string; complexityOn gates its string", async () => {
  const { store } = await tmpStore();
  await store.load(); // level 3 (chat+speak wording), complexity 3
  await store.setToggles({ complexityOn: true }); // ships off; on for this gating test
  const both = store.askFor(["chat", "speak"]);
  expect(both.instruction).toBe(DEFAULT_REPLY_TEXT[3] + DEFAULT_COMPLEXITY_TEXT[3]);

  await store.setToggles({ verbosityOn: false });
  const noVerb = store.askFor(["chat", "speak"]);
  expect(noVerb.instruction).toBe(DEFAULT_COMPLEXITY_TEXT[3]); // only complexity half

  await store.setToggles({ verbosityOn: true, complexityOn: false });
  const noComp = store.askFor(["chat", "speak"]);
  expect(noComp.instruction).toBe(DEFAULT_REPLY_TEXT[3]); // only verbosity half

  await store.setToggles({ verbosityOn: false, complexityOn: false });
  const off = store.askFor(["chat", "speak"]);
  expect(off.instruction).toBe(""); // both off: nothing appended
  /* A toggle that is off KEEPS its value, so switching it back on returns
   * the rung he set rather than the ship default. */
  expect(off.level).toBe(3);
  expect(off.complexity).toBe(3);
});

test("askFor channel bending: a speak-only session is asked for 5, chat-only for 2, neither for 0", async () => {
  const { store } = await tmpStore();
  await store.load(); // level 3 wording names both chat and speak
  await store.setToggles({ complexityOn: true }); // on, so the level-0 case shows the complexity half
  expect(store.askFor(["speak"]).level).toBe(5);
  expect(store.askFor(["chat"]).level).toBe(2);
  const none = store.askFor(["read"]);
  expect(none.level).toBe(0);
  expect(none.instruction).toBe(DEFAULT_COMPLEXITY_TEXT[3]); // verbosity 0 empty, complexity still appends
  // an empty channel list never guesses: keeps the level
  expect(store.askFor([]).level).toBe(3);
});

test("askFor bending: a level the session CAN honour is never bent", async () => {
  /* The bend is a fallback, not a policy. A session that can do exactly what the
   * dial asks must be asked for exactly that, or the rung he set is one the
   * engine quietly never uses. */
  const { store } = await tmpStore();
  await store.load();
  for (const [level, channels] of [
    [1, ["chat"]], [2, ["chat"]], [3, ["chat", "speak"]], [4, ["speak"]], [5, ["speak"]],
  ] as const) {
    await store.setLevel(level);
    const ask = store.askFor([...channels]);
    expect(ask.level, `level ${level} with [${channels.join(" ")}] was bent`).toBe(level);
  }
});

test("askFor: a stored level that is not a rung falls back to the ship default", async () => {
  /* The file is on disk and a hand edit can put anything in it. coerce() drops a
   * bad level at load, and askFor holds the same line for a value that reached
   * the store any other way: never append an instruction derived from junk. */
  const { store, dir } = await tmpStore();
  writeFileSync(join(dir, "reply-dials.json"), JSON.stringify({ v: 1, level: 42, complexity: 99 }));
  await store.load();
  expect(store.level(), "a level that is not a rung was adopted").toBe(DEFAULT_REPLY_LEVEL);
  expect(store.complexity()).toBe(3);
  expect(store.askFor(["chat", "speak"]).level).toBe(DEFAULT_REPLY_LEVEL);
});

test("a persisted state round-trips, and a malformed one degrades field by field", async () => {
  const { store, dir } = await tmpStore();
  await store.load();
  await store.setLevel(5);
  await store.setToggles({ complexityOn: true, promptBitsOn: false });
  await store.setWording({ complexity: { 2: { name: "Two", text: " (two)" } } });
  await store.setBits(["one", "two"]);

  const reloaded = new ReplyDialsStore(dir + "/");
  await reloaded.load();
  expect(reloaded.state()).toEqual(store.state());
  expect(reloaded.complexityName(2)).toBe("Two");
  expect(reloaded.bits()).toEqual(["one", "two"]);

  /* A blob with the wrong TYPES in it keeps the fields it can read and defaults
   * the rest, rather than throwing at boot: a dials file nobody can parse must
   * not be a dead engine. */
  writeFileSync(join(dir, "reply-dials.json"), JSON.stringify({
    v: 1, level: 4, complexity: "three", verbosityOn: "yes", promptBitsOn: false,
    overrides: { reply: { 2: { text: 7 }, 3: { name: "Kept" } }, bits: ["ok", 9] },
  }));
  const degraded = new ReplyDialsStore(dir + "/");
  await degraded.load();
  expect(degraded.level()).toBe(4);
  expect(degraded.complexity(), "a non-numeric complexity was adopted").toBe(3);
  expect(degraded.state().verbosityOn, "a non-boolean toggle was adopted").toBe(true);
  expect(degraded.state().promptBitsOn).toBe(false);
  expect(degraded.verbosityText(2), "a non-string override was adopted").toBe(DEFAULT_REPLY_TEXT[2]);
  expect(degraded.verbosityName(3)).toBe("Kept");
  expect(degraded.bits(), "a non-string bit was adopted").toEqual(["ok"]);
});

test("every mutation commits: it saves, and it calls onChange exactly once", async () => {
  /* onChange is what server.ts hangs the whole repaint on -- redeclare the
   * plugins, rewrite the hook state file, rebroadcast the sessions frame. A
   * mutation that skipped it would move the dial with every device still
   * drawing the old rung and the Stop hook still enforcing the old level. */
  const { store, dir } = await tmpStore();
  await store.load();
  let changes = 0;
  store.onChange = () => { changes++; };

  await store.setLevel(4);
  await store.setComplexity(2);
  await store.setToggles({ complexityOn: true });
  await store.setWording({ reply: { 1: { text: " (one)" } } });
  await store.resetWording("reply");
  await store.setBits(["a"]);
  await store.resetBits();
  await store.importFromApp({ verbosityOn: false });
  expect(changes).toBe(8);

  // ...and each of those really reached the disk, not just the object
  const onDisk = JSON.parse(readFileSync(join(dir, "reply-dials.json"), "utf8")) as any;
  expect(onDisk).toMatchObject({ v: 1, level: 4, complexity: 2, verbosityOn: false, complexityOn: true });
});

test("a REFUSED set moves nothing and tells nobody", async () => {
  /* setLevel/setComplexity answer false for a rung that does not exist. The
   * refusal must be total: no store change, no save, no onChange, so a client
   * that asked for rung 9 leaves the engine exactly as it found it. */
  const { store, dir } = await tmpStore();
  await store.load();
  let changes = 0;
  store.onChange = () => { changes++; };
  expect(await store.setLevel(9)).toBe(false);
  expect(await store.setLevel(0)).toBe(false);
  expect(await store.setComplexity(NaN)).toBe(false);
  expect(store.level()).toBe(3);
  expect(store.complexity()).toBe(3);
  expect(changes, "a refused set called back as though something moved").toBe(0);
  expect(existsSync(join(dir, "reply-dials.json")),
    "a refused set wrote a file a fresh engine would then read").toBe(false);
});

// ------------------------------------------------------- the migration translation

test("migration (a) new shape: level/complexity read as-is, append -> both toggles, sparse text overrides", () => {
  const { state, report } = migrateLegacyLevels({
    level: 5, complexity: 2, append: false,
    strings: { reply: { 4: " (edited four)", 5: DEFAULT_REPLY_TEXT[5] }, complexity: { 1: " (edited one)" } },
  });
  expect(state.level).toBe(5);
  expect(state.complexity).toBe(2);
  expect(state.verbosityOn).toBe(false);
  expect(state.complexityOn).toBe(false);
  expect(report.migrated).toBe(false);
  // only the rungs that DIFFER from the default become overrides (rung 5 matched)
  expect(state.overrides?.reply).toEqual({ 4: { text: " (edited four)" } });
  expect(state.overrides?.complexity).toEqual({ 1: { text: " (edited one)" } });
  expect(report.textOverrides).toEqual({ reply: 1, complexity: 1 });
  expect(report.from).toBe("reply-levels.json");
});

test("migration (a) new shape: an ABSENT append switch means the old file appended", () => {
  // the old file only grew `append` late; a file without one was appending, so
  // reading absent as off would silently mute a migrated engine
  const { state } = migrateLegacyLevels({ level: 2 });
  expect([state.verbosityOn, state.complexityOn]).toEqual([true, true]);
  expect(state.promptBitsOn, "the old file never carried a bits switch; it defaults on").toBe(true);
});

test("migration (b) old pane-map: majority vote, ties to the higher rung, marked migrated", () => {
  const { state, report } = migrateLegacyLevels({ p1: 4, p2: 4, p3: 4, p4: 5, p5: 5, p6: 5 });
  expect(state.level).toBe(5); // tie 3-3 goes to the higher rung
  expect(report.migrated).toBe(true);
  expect(state.verbosityOn).toBe(true);
  expect(state.complexityOn).toBe(true);
  // a clear majority wins outright
  expect(migrateLegacyLevels({ a: 1, b: 1, c: 5 }).state.level).toBe(1);
  // rungs that are not rungs are not votes
  expect(migrateLegacyLevels({ a: 9, b: 9, c: 2 }).state.level).toBe(2);
});

test("migration: nothing recognisable is the default, never a throw", () => {
  for (const junk of [null, undefined, 7, "levels", [], {}, { a: "b" }]) {
    const { state, report } = migrateLegacyLevels(junk);
    expect(report.level, `${JSON.stringify(junk)} produced a level`).toBe(DEFAULT_REPLY_LEVEL);
    expect(report.migrated, `${JSON.stringify(junk)} claimed a migration`).toBe(false);
    expect(state.promptBitsOn).toBe(true);
  }
});

test("the store IGNORES a legacy reply-levels.json: no in-engine migration, file untouched", async () => {
  const { store, dir } = await tmpStore();
  const legacy = { level: 4, complexity: 2, append: true, strings: { reply: { 1: " (edited one)" } } };
  const legacyRaw = JSON.stringify(legacy);
  writeFileSync(join(dir, "reply-levels.json"), legacyRaw);

  /* The engine carries no migration code (the design): a legacy file present is
   * simply not read. migrateLegacyLevels stays exported as the pure translation
   * a hand migration can use (covered by the tests above). */
  expect(await store.load()).toBeNull();
  expect(store.level()).toBe(3); // the ship default, not the legacy 4
  expect(store.verbosityText(1), "the legacy wording leaked into the store").toBe(DEFAULT_REPLY_TEXT[1]);

  // no new file was written, the old one is UNTOUCHED
  expect(existsSync(join(dir, "reply-dials.json"))).toBe(false);
  expect(readFileSync(join(dir, "reply-levels.json"), "utf8")).toBe(legacyRaw);

  // a state SAVED by this store round-trips on the next load, and STILL does not
  // read the legacy file sitting beside it
  await store.save();
  const store2 = new ReplyDialsStore(dir + "/");
  expect(await store2.load()).toBeNull();
  expect(store2.level()).toBe(3);
  expect(readFileSync(join(dir, "reply-levels.json"), "utf8")).toBe(legacyRaw);
});

// ------------------------------------------------------------------ the bits

test("bits: the cap is refused by name, not truncated", async () => {
  const { store } = await tmpStore();
  await store.load();
  expect(store.setBitsValidate(Array.from({ length: MENU_MAX_ITEMS + 1 }, (_, i) => `b${i}`)))
    .toMatch(/too many bits: 25 > 24/);
  expect(store.setBitsValidate(["ok", "x".repeat(MENU_ITEM_TEXT_MAX + 1)])).toMatch(/too long: 201 > 200/);
  expect(store.setBitsValidate(["ok", ""])).toMatch(/empty/);
  expect(store.setBitsValidate("not a list")).toMatch(/list of strings/);
  expect(store.setBitsValidate(["ok", "fine"])).toBeNull();
  // exactly at each cap is accepted
  expect(store.setBitsValidate(Array.from({ length: MENU_MAX_ITEMS }, (_, i) => `b${i}`))).toBeNull();
  expect(store.setBitsValidate(["x".repeat(MENU_ITEM_TEXT_MAX)])).toBeNull();
  await store.setBits(["one", "two"]);
  expect(store.bits()).toEqual(["one", "two"]);
  await store.resetBits();
  expect(store.bits()).toEqual(DEFAULT_PROMPT_BITS);
});

test("bits: the validator's cap IS the composer menu's cap", async () => {
  /* The two numbers must be the same one, or the store accepts a list that
   * composerDecl then drops -- and the prompt-bits menu vanishes from his
   * composer with nothing anywhere saying why. */
  const { store } = await tmpStore();
  await store.load();
  await store.setBits(Array.from({ length: MENU_MAX_ITEMS }, (_, i) => `bit ${i}`));
  const menu = store.composerWidgets().find((w) => (w as any).key === "bits")!;
  const decl = declarePlugins([replyDialsPlugin({ store })])[0];
  expect((menu as any).items.length).toBe(MENU_MAX_ITEMS);
  expect(decl.composer!.some((w) => (w as any).key === "bits"),
    "a bit list the store accepted was dropped by the decl validator").toBe(true);
});

// ------------------------------------------------------- the composer widgets

test("composerWidgets: ship default is two widgets; enabling complexity adds the third", async () => {
  const { store } = await tmpStore();
  await store.load();
  // SHIP DEFAULT: bits + verbosity, complexity OFF. DISTINCT GLYPHS (#595/#598):
  // the bits menu is `edit` (the pencil, #598), the two dials must not read as one
  // control, so verbosity keeps `equalizer` and complexity is `statistics`.
  expect(store.composerWidgets().map((x) => [x.type, (x as any).key, (x as any).icon])).toEqual([
    ["menu", "bits", "edit"],
    ["slider", "verbosity", "equalizer"],
  ]);
  // enabling complexity adds its slider, in pill order (after verbosity)
  await store.setToggles({ complexityOn: true });
  const w = store.composerWidgets();
  expect(w.map((x) => [x.type, (x as any).key, (x as any).icon])).toEqual([
    ["menu", "bits", "edit"],
    ["slider", "verbosity", "equalizer"],
    ["slider", "complexity", "statistics"],
  ]);
  // sliders carry their current value; the verbosity steps carry the names
  const verb = w.find((x) => (x as any).key === "verbosity") as any;
  expect(verb.value).toBe(3);
  expect(verb.steps.map((s: any) => s.name)).toEqual(["Terminal", "Chat", "Read out", "Spoken", "Voice only"]);

  /* EVERY STEP CARRIES ITS DESCRIPTION (#595): the app draws the current rung's
   * hint under the rail, so a rung is never just a name. The hint is the rung's
   * appended text with the wire's leading space and wrapping parens stripped for
   * display -- his reviewed wording, not a separate invented line. */
  const cplx = w.find((x) => (x as any).key === "complexity") as any;
  for (const s of [...verb.steps, ...cplx.steps]) {
    expect(typeof s.hint, `step ${s.n} carries no description`).toBe("string");
    expect(s.hint.length, `step ${s.n} description is empty`).toBeGreaterThan(0);
    expect(s.hint.startsWith("("), `step ${s.n} description kept its wrapping paren`).toBe(false);
    expect(s.hint.startsWith(" "), `step ${s.n} description kept its wire leading space`).toBe(false);
  }
  /* #598 GATE: EVERY step hint IS the bracket-stripped appended string for that
   * rung, computed from the SAME source (stepHint over verbosityText/complexityText,
   * the exact strings askFor appends) -- never a literal copy that could drift. If
   * the appended wording changes, this assertion moves with it automatically. */
  for (const n of RUNGS) {
    expect(verb.steps[n - 1].hint, `verbosity rung ${n} hint != bracket-stripped appended text`)
      .toBe(stepHint(store.verbosityText(n)));
    expect(cplx.steps[n - 1].hint, `complexity rung ${n} hint != bracket-stripped appended text`)
      .toBe(stepHint(store.complexityText(n)));
  }

  await store.setToggles({ complexityOn: false, promptBitsOn: false });
  const w2 = store.composerWidgets();
  expect(w2.map((x) => (x as any).key)).toEqual(["verbosity"]); // only verbosity left
});

test("composerWidgets: a slider's value follows the dial, and an emptied bit list hides the menu", async () => {
  const { store } = await tmpStore();
  await store.load();
  await store.setLevel(5);
  expect((store.composerWidgets().find((w) => (w as any).key === "verbosity") as any).value).toBe(5);
  /* An empty bit list draws no menu rather than an empty one: composerDecl would
   * drop a zero-item menu anyway, and declaring one the validator eats is how a
   * surface disappears with no line saying why. */
  await store.setBits([]);
  expect(store.composerWidgets().some((w) => (w as any).key === "bits")).toBe(false);
});

test("stepHint strips the wire's packaging and nothing else", () => {
  expect(stepHint(" (a wrapped line.)")).toBe("a wrapped line.");
  expect(stepHint("bare line")).toBe("bare line");
  expect(stepHint("")).toBe("");
  // an unbalanced paren is left alone: it is his text, not a format to repair
  expect(stepHint(" (half open")).toBe("(half open");
});

test("hint follows the strings live (#598): a wording edit flows straight into the decl", async () => {
  // #598 root cause: a hint copied into a static decl drifts from the appended
  // string. The decl is built LIVE from verbosityText/complexityText, so editing
  // the wording (setWording, the same path an app edit lands on) must move the
  // hint on the very next composerWidgets() -- no separate table to update.
  const { store } = await tmpStore();
  await store.load();
  await store.setToggles({ complexityOn: true });
  await store.setWording({
    reply: { 3: { text: " (bespoke verbosity three)" } },
    complexity: { 2: { text: " (bespoke complexity two)" } },
  });
  const w = store.composerWidgets();
  const verb = w.find((x) => (x as any).key === "verbosity") as any;
  const cplx = w.find((x) => (x as any).key === "complexity") as any;
  // the edited hint is exactly the edited appended text, bracket-stripped
  expect(verb.steps[2].hint).toBe("bespoke verbosity three");
  expect(cplx.steps[1].hint).toBe("bespoke complexity two");
  // and still identical to the live source function, not a snapshot
  expect(verb.steps[2].hint).toBe(stepHint(store.verbosityText(3)));
  expect(cplx.steps[1].hint).toBe(stepHint(store.complexityText(2)));
  // untouched rungs stay on the default appended wording
  expect(verb.steps[0].hint).toBe(stepHint(DEFAULT_REPLY_TEXT[1]));
  expect(cplx.steps[4].hint).toBe(stepHint(DEFAULT_COMPLEXITY_TEXT[5]));
});

test("importFromApp: counts edits vs defaults, drops over-cap bits, copies toggles", async () => {
  const { store } = await tmpStore();
  await store.load();
  const res = await store.importFromApp({
    strings: {
      reply: { 1: { name: "Term", text: DEFAULT_REPLY_TEXT[1] }, 2: { text: " (edited two)" } },
      complexity: { 3: { name: "SnS" } },
      bits: [...Array.from({ length: MENU_MAX_ITEMS }, (_, i) => `b${i}`), "overflow", ""],
    },
    verbosityOn: false,
    promptBitsOn: true,
  });
  // rung1 name differs (counted), rung1 text matched default (not), rung2 text differs
  expect(res.imported.names).toBe(2); // verbosity rung1 name + complexity rung3 name
  expect(res.imported.texts).toBe(1);
  expect(res.imported.bits).toBe(MENU_MAX_ITEMS); // capped at 24
  expect(res.dropped.bits).toBe(2); // "overflow" over cap + "" empty
  expect(res.imported.toggles).toBe(2);
  expect(store.state().verbosityOn).toBe(false);
  expect(store.verbosityName(1)).toBe("Term");
  expect(store.complexityName(3)).toBe("SnS");
});

test("importFromApp is idempotent: running it twice imports the same and changes nothing more", async () => {
  /* It is the one-shot the app runs on connect (2.5b), and a connect happens
   * whenever a device wakes. Two imports must leave one state. */
  const { store } = await tmpStore();
  await store.load();
  const bag = { strings: { reply: { 2: { text: " (edited two)" } } }, complexityOn: true };
  const a = await store.importFromApp(bag);
  const first = JSON.parse(JSON.stringify(store.state()));
  const b = await store.importFromApp(bag);
  expect(b).toEqual(a);
  expect(store.state()).toEqual(first);
});

test("importFromApp: an empty bag imports nothing and counts nothing", async () => {
  const { store } = await tmpStore();
  await store.load();
  const res = await store.importFromApp({});
  expect(res).toEqual({ imported: { names: 0, texts: 0, bits: 0, toggles: 0 }, dropped: { bits: 0 } });
  expect(store.state()).toEqual(defaultState());
});

// ================================ the ops ==================================

/* The REAL plugin over the REAL /plugin/reply-dials/rpc/<op> route, on a
 * Bun.serve on port 0. No engine: the route group is a pure function of the ctx,
 * and the only thing these ops touch is a store in a tmp dir.
 *
 * The one fact this cannot reach is the BROADCAST -- a set re-declaring the
 * plugin list and pushing it to a device that asked for nothing -- because that
 * needs the real transport. It is e2e/plugin-rpc.test.ts, and it is not
 * duplicated here. What is here instead is the plugin's own half of that
 * motion: the decl REBUILT from the mutated store carries the moved rung. */

let http: ServedRoutes | null = null;
afterEach(() => { http?.stop(); http = null; });

async function dialsRig(): Promise<{ store: ReplyDialsStore; dir: string; changes: () => number;
  rpc: (op: string, args?: unknown) => Promise<Response>; slider: (key: string) => any }> {
  const { store, dir } = await tmpStore();
  await store.load();
  let changes = 0;
  store.onChange = () => { changes++; };
  const spec = replyDialsPlugin({ store });
  http = serveRoutes({ groups: [pluginRoutes], ctx: { plugins: () => [spec], pluginById: (id) => (id === spec.id ? spec : undefined) } });
  const rpc = (op: string, args: unknown = {}) => http!.post(`/plugin/reply-dials/rpc/${op}`, { args });
  /* The composer widget as a DEVICE would receive it: through declarePlugins,
   * so what is asserted is the decl the frame carries and not the store's own
   * intermediate object. */
  const slider = (key: string) =>
    (declarePlugins([spec])[0].composer ?? []).find((w: any) => w.key === key) as any;
  return { store, dir, changes: () => changes, rpc, slider };
}

test("rpc get: the dials, the effective wording with edited flags, the bits and the defaults", async () => {
  const { rpc } = await dialsRig();
  const j = await (await rpc("get")).json() as any;
  expect(j.ok).toBe(true);
  expect(j.result.level).toBe(3);
  expect(j.result.complexity).toBe(3);
  expect(j.result.migrated).toBe(false);
  expect([j.result.verbosityOn, j.result.complexityOn, j.result.promptBitsOn]).toEqual([true, false, true]);
  expect(j.result.verbosity[3].name).toBe("Read out");
  expect(j.result.verbosity[3].text).toBe(DEFAULT_REPLY_TEXT[3]);
  expect(j.result.verbosity[3].edited).toEqual({ name: false, text: false });
  expect(j.result.complexity_rungs[1].name).toBe("Product Manager");
  expect(j.result.bits).toEqual(DEFAULT_PROMPT_BITS);
  // the defaults ride along so the editor can offer "put it back" without
  // holding a second copy of his wording
  expect(j.result.defaults.names[1]).toBe("Terminal");
  expect(j.result.defaults.texts[3]).toBe(DEFAULT_REPLY_TEXT[3]);
  expect(j.result.defaults.bits).toEqual(DEFAULT_PROMPT_BITS);
});

test("rpc get: an edited rung says WHICH half he edited", async () => {
  const { store, rpc } = await dialsRig();
  await store.setWording({ reply: { 2: { name: "My Two" } }, complexity: { 5: { text: " (deep)" } } });
  const r = (await (await rpc("get")).json() as any).result;
  expect(r.verbosity[2]).toMatchObject({ name: "My Two", edited: { name: true, text: false } });
  expect(r.complexity_rungs[5]).toMatchObject({ text: " (deep)", edited: { name: false, text: true } });
  expect(r.verbosity[1].edited).toEqual({ name: false, text: false });
});

test("rpc set: moves the dial, and the REDECLARED slider value moves with it", async () => {
  const { rpc, slider, changes } = await dialsRig();
  expect(slider("verbosity").value, "the declared slider does not start at the stored rung").toBe(3);

  const r = await (await rpc("set", { key: "verbosity", n: 5 })).json() as any;
  expect(r.result, "a set answers with BOTH dials, not just the one that moved")
    .toEqual({ level: 5, complexity: 3 });
  expect(slider("verbosity").value, "the re-declared slider value did not move").toBe(5);
  expect(changes(), "the set did not ask for a redeclare").toBe(1);

  await rpc("set", { key: "complexity", n: 2 });
  expect((await (await rpc("get")).json() as any).result).toMatchObject({ level: 5, complexity: 2 });
});

test("rpc set: an unknown key or an out-of-range rung is a 400, not a 500", async () => {
  const { rpc, store, changes } = await dialsRig();
  for (const args of [{ key: "verbosity", n: 9 }, { key: "verbosity", n: 0 },
    { key: "complexity", n: "x" }, { key: "nope", n: 3 }, {}]) {
    const r = await rpc("set", args);
    expect(r.status, `${JSON.stringify(args)} should be refused by name`).toBe(400);
    expect((await r.json() as any).ok).toBe(false);
  }
  // nothing moved, and nothing was redeclared
  expect(store.state()).toEqual(defaultState());
  expect(changes()).toBe(0);
  // a good set still works after the rejections
  expect((await rpc("set", { key: "complexity", n: 2 })).status).toBe(200);
});

test("rpc toggle: flips one switch, keeps the rest, answers the three", async () => {
  const { rpc, slider } = await dialsRig();
  const a = (await (await rpc("toggle", { complexityOn: true })).json() as any).result;
  expect(a).toEqual({ verbosityOn: true, complexityOn: true, promptBitsOn: true });
  expect(slider("complexity"), "enabling complexity did not add its slider to the decl").toBeTruthy();

  const b = (await (await rpc("toggle", { promptBitsOn: false })).json() as any).result;
  expect(b, "an unrelated toggle moved").toEqual({ verbosityOn: true, complexityOn: true, promptBitsOn: false });
  // a junk value is ignored rather than coerced: the switch keeps its position
  const c = (await (await rpc("toggle", { verbosityOn: "off" })).json() as any).result;
  expect(c.verbosityOn).toBe(true);
});

test("rpc wording: sets, clears with null, and resets a whole scale", async () => {
  const { rpc, store, slider } = await dialsRig();
  const set = (await (await rpc("wording", { reply: { 3: { text: " (bespoke three)" } } })).json() as any).result;
  expect(set.verbosity[3].text).toBe(" (bespoke three)");
  expect(set.verbosity[3].edited.text).toBe(true);
  expect(store.verbosityText(3)).toBe(" (bespoke three)");
  // and the app's slider hint follows the edit on the next decl (#598)
  expect(slider("verbosity").steps[2].hint).toBe("bespoke three");

  await rpc("wording", { reply: { 3: { text: null } } });
  expect(store.verbosityText(3)).toBe(DEFAULT_REPLY_TEXT[3]);

  await rpc("wording", { complexity: { 1: { name: "PM" } } });
  const reset = (await (await rpc("wording", { reset: "all" })).json() as any).result;
  expect(reset.complexity_rungs[1].name).toBe(DEFAULT_COMPLEXITY_NAMES[1]);
  expect(store.state().overrides).toEqual({});
});

test("rpc bits: replaces the list, refuses an over-cap one by name, and resets", async () => {
  const { rpc, store } = await dialsRig();
  const set = await (await rpc("bits", { bits: ["one", "two"] })).json() as any;
  expect(set.result.bits).toEqual(["one", "two"]);

  const tooMany = await rpc("bits", { bits: Array.from({ length: MENU_MAX_ITEMS + 1 }, (_, i) => `b${i}`) });
  expect(tooMany.status, "an over-cap list must be refused by name, not silently truncated").toBe(400);
  expect((await tooMany.json() as any).error).toMatch(/too many bits/);
  expect(store.bits(), "the refused list reached the store anyway").toEqual(["one", "two"]);

  const reset = await (await rpc("bits", { reset: true })).json() as any;
  expect(reset.result.bits).toEqual(DEFAULT_PROMPT_BITS);
});

test("rpc import: the app's one-shot lands through the route and answers its counts", async () => {
  const { rpc, store } = await dialsRig();
  const j = await (await rpc("import", {
    strings: { reply: { 1: { name: "Term" } }, bits: ["only this"] },
    complexityOn: true,
  })).json() as any;
  expect(j.ok).toBe(true);
  expect(j.result.imported).toMatchObject({ names: 1, bits: 1, toggles: 1 });
  expect(store.verbosityName(1)).toBe("Term");
  expect(store.bits()).toEqual(["only this"]);
});

test("the reply-dials decl carries widgets and NOT ONE function", async () => {
  /* The dials' composer is a live function over the store, which makes this the
   * plugin most likely to hand the app something it cannot serialise. */
  const { store } = await tmpStore();
  await store.load();
  const spec = replyDialsPlugin({ store });
  const decl = declarePlugins([spec])[0];
  expect(decl).toMatchObject({ id: "reply-dials", name: "Reply dials", version: 1 });
  expect(decl.composer!.map((w) => (w as any).key)).toEqual(["bits", "verbosity"]);
  expect("rpc" in decl).toBe(false);
  expect(JSON.parse(JSON.stringify(decl)), "the decl did not survive a round trip through JSON")
    .toEqual(decl);
});
