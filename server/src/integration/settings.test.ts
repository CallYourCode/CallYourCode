/* The GLOBAL defaults on the app server: partial updates, persistence across
 * a restart, and the /push/notify contracts -- `decided`, and the engine-level
 * usage push being forwarded as-is (the account merge is gone).
 *
 * A real server process each time, on its own port with its own .run files,
 * because "a global survives an app server restart" is a claim about the
 * process dying and coming back, not about a variable.
 *
 *   bun test app-server/settings.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrolledBearer } from "../test-support/enrollkit";

type Server = { url: string; stop: () => Promise<void> };
let servers: Server[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const s of servers) await s.stop();
  servers = [];
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});

async function startServer(dir: string): Promise<Server> {
  const port = 8300 + Math.floor(Math.random() * 400);
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../bootstrap/server.ts")], {
    env: {
      ...process.env,
      APP_PORT: String(port),
      APP_HOST: "127.0.0.1",
      DIST_DIR: dir, // nothing is served; static asks 404 harmlessly
      PUSH_FILE: join(dir, "push-subs.json"),
      SETTINGS_FILE: join(dir, "app-settings.json"),
      CYC_LOG_DIR: join(dir, "logs"),
      // a dead voice engine so no test ever puts load on a real kokoro
      VOICE_ENGINES: "http://127.0.0.1:1|http://127.0.0.1:1|none",
      ENGINE_TOKENS_FILE: join(dir, "engine-tokens.json"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${url}/settings`).then((r) => r.ok).catch(() => false)) break;
    await Bun.sleep(100);
    if (i === 79) throw new Error("app server did not start");
  }
  const s = { url, stop: async () => { proc.kill(); await proc.exited; } };
  servers.push(s);
  /* The push routes require an issued engine token now:
   * one scratch enrolled engine per server, borne by postJson automatically
   * (harmless on the device routes, which ignore it in LOCAL). */
  bearers.set(url, (await enrolledBearer(url)).bearer);
  return s;
}

const bearers = new Map<string, { authorization: string }>();
const getJson = async (url: string) => (await fetch(url)).json() as Promise<any>;
const postJson = (url: string, body: unknown) =>
  fetch(url, { method: "POST",
    headers: { "content-type": "application/json", ...(bearers.get(new URL(url).origin) ?? {}) },
    body: JSON.stringify(body) });

test("defaults, partial update, and surviving a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-appsettings-"));
  dirs.push(dir);
  const s1 = await startServer(dir);

  // the shipped defaults, before anybody chose anything
  let j = await getJson(`${s1.url}/settings`);
  expect(j).toMatchObject(
    { speed: 1, notify: true, sound: true, activity: true, seq: 0 });

  // a partial POST changes ONLY what it names
  await postJson(`${s1.url}/settings`, { speed: 1.5, activity: false });
  j = await getJson(`${s1.url}/settings`);
  expect(j).toMatchObject({ speed: 1.5, notify: true, sound: true, activity: false });
  expect(j.seq).toBe(1);

  // junk neither lands nor bumps seq
  await postJson(`${s1.url}/settings`, { speed: 99, notify: "yes", junk: true });
  j = await getJson(`${s1.url}/settings`);
  expect(j).toMatchObject({ speed: 1.5, notify: true, seq: 1 });

  // one boolean goes off, and only it
  await postJson(`${s1.url}/settings`, { sound: false });
  j = await getJson(`${s1.url}/settings`);
  expect(j).toMatchObject({ sound: false, speed: 1.5, activity: false });
  expect(j.seq).toBe(2);
  expect(statSync(join(dir, "app-settings.json")).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "push-subs.json")).mode & 0o777).toBe(0o600);

  // the restart: a new process over the same files
  await s1.stop();
  servers = servers.filter((x) => x !== s1);
  const s2 = await startServer(dir);
  j = await getJson(`${s2.url}/settings`);
  expect(j).toMatchObject(
    { speed: 1.5, notify: true, sound: false, activity: false });
}, 40_000);

/* COMPLEXITY DEFAULTS OFF ON A FRESH APP SERVER (#462), verbosity stays on, and
 * an explicit ON round-trips and survives a restart.
 *
 * Proven against the REAL server process, not the routed mock, because the
 * default lives in this file's SETTINGS_DEFAULTS: the app reads whatever a fresh
 * /settings returns, so "off by default" is a claim about the byte this server
 * ships before anybody has chosen. */
test("complexity defaults off, verbosity on, and an explicit ON persists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-appsettings-"));
  dirs.push(dir);
  const s1 = await startServer(dir);

  // the shipped default, before anybody chose: complexity OFF, verbosity ON
  let j = await getJson(`${s1.url}/settings`);
  expect(j.complexityOn, "a fresh app server offered complexity by default").toBe(false);
  expect(j.verbosityOn, "verbosity should stay on by default").toBe(true);

  // an explicit ON is stored and honoured
  await postJson(`${s1.url}/settings`, { complexityOn: true });
  j = await getJson(`${s1.url}/settings`);
  expect(j.complexityOn).toBe(true);
  expect(j.seq).toBe(1);

  // ...and survives the process dying and coming back
  await s1.stop();
  servers = servers.filter((x) => x !== s1);
  const s2 = await startServer(dir);
  j = await getJson(`${s2.url}/settings`);
  expect(j.complexityOn, "an explicit complexity ON was lost across a restart").toBe(true);
}, 40_000);

/* THE PROMPT-BITS SWITCH AND THE WORDING BAG (#463/#464/#465), against the real
 * server. promptBitsOn is a plain synced boolean. `strings` is stored WHOLE and
 * echoed VERBATIM -- the page's holds() check compares the POST body to the GET
 * answer byte for byte, so a rebuilt-and-reordered copy would read as "not saved";
 * this server stores what it was given (a plain, bounded object) and hands it back
 * unchanged. Replaced wholesale like the keymap, junk refused, and it persists. */
test("promptBitsOn round-trips; the wording bag is stored whole and echoed verbatim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-appsettings-"));
  dirs.push(dir);
  const s1 = await startServer(dir);

  let j = await getJson(`${s1.url}/settings`);
  expect(j.promptBitsOn, "the prompt-bits menu is offered by default").toBe(true);
  expect(j.strings, "a fresh server holds no wording edits").toBeUndefined();

  // the switch round-trips
  await postJson(`${s1.url}/settings`, { promptBitsOn: false });
  j = await getJson(`${s1.url}/settings`);
  expect(j.promptBitsOn).toBe(false);

  // a wording bag: verbosity name+text, an editable complexity name (#464), and a
  // plain prompt-bit list (#465). Stored whole and echoed exactly.
  const bag = {
    reply: { 3: { name: "Read out", text: " (edited)" } },
    complexity: { 2: { name: "Tipsy" } },
    bits: ["one", "two", "three"],
  };
  await postJson(`${s1.url}/settings`, { strings: bag });
  j = await getJson(`${s1.url}/settings`);
  expect(j.strings, "the wording bag was not echoed verbatim, so the page's holds() would fail")
    .toEqual(bag);

  // REPLACED WHOLE, like the keymap: a new bag replaces the old rather than merging
  const bag2 = { bits: ["only this"] };
  await postJson(`${s1.url}/settings`, { strings: bag2 });
  j = await getJson(`${s1.url}/settings`);
  expect(j.strings, "the wording bag was merged instead of replaced").toEqual(bag2);

  // junk is refused, not stored: a non-object leaves what is there
  await postJson(`${s1.url}/settings`, { strings: "not an object" });
  j = await getJson(`${s1.url}/settings`);
  expect(j.strings, "a non-object strings value was stored").toEqual(bag2);

  // both survive a restart
  await s1.stop();
  servers = servers.filter((x) => x !== s1);
  const s2 = await startServer(dir);
  j = await getJson(`${s2.url}/settings`);
  expect(j.strings, "the wording bag was lost across a restart").toEqual(bag2);
  expect(j.promptBitsOn, "the prompt-bits switch was lost across a restart").toBe(false);
}, 40_000);

/* THE KEYMAP, and the two things about it that are not like the other globals.
 *
 * It is REPLACED WHOLE, because an action back on its default is the key being
 * absent and a key-by-key merge could not say that; and ABSENT IS NOT `{}`,
 * because absent means this account has never had a keymap (the one moment a
 * device may hand over the per-device map it kept before the move) while `{}`
 * means he cleared his last binding. Collapsing those two brings the old
 * laptop store back over the clearing on the next boot, forever.
 */
test("the keymap: absent, replaced whole, empty is a real answer, and it persists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-appsettings-"));
  dirs.push(dir);
  const s1 = await startServer(dir);

  // ABSENT before anybody has one. Not `{}`.
  let j = await getJson(`${s1.url}/settings`);
  expect(j.keymap, "a fresh app server claimed to hold an empty keymap")
    .toBeUndefined();

  // his four, as the laptop hands them over
  const HIS = {
    listPrev: "Meta+Shift+A", listNext: "Meta+Shift+S",
    tabPrev: "Meta+Shift+ArrowUp", tabNext: "Meta+Shift+ArrowDown",
  };
  await postJson(`${s1.url}/settings`, { keymap: HIS });
  j = await getJson(`${s1.url}/settings`);
  expect(j.keymap).toEqual(HIS);
  expect(j.seq).toBe(1);
  // and only the keymap moved
  expect(j).toMatchObject({ speed: 1, notify: true, sound: true, activity: true });

  // WHOLE, not merged: a map without tabNext means tabNext is back on its
  // default, and a merge would leave the old chord bound behind his back
  await postJson(`${s1.url}/settings`, { keymap: { listNext: "Ctrl+J" } });
  j = await getJson(`${s1.url}/settings`);
  expect(j.keymap, "the keymap was merged instead of replaced, so an unbind is impossible")
    .toEqual({ listNext: "Ctrl+J" });

  // a map with a non-string value is refused ENTIRELY rather than half-taken
  await postJson(`${s1.url}/settings`, { keymap: { listNext: "Ctrl+K", tabNext: 7 } });
  j = await getJson(`${s1.url}/settings`);
  expect(j.keymap, "half a keymap was stored").toEqual({ listNext: "Ctrl+J" });
  expect(j.seq).toBe(2);

  // `{}` IS a keymap: he cleared his last binding, and that must be told apart
  // from never having had one -- including across a restart
  await postJson(`${s1.url}/settings`, { keymap: {} });
  j = await getJson(`${s1.url}/settings`);
  expect(j.keymap).toEqual({});
  expect(j.seq, "clearing the last binding did not bump seq, so no other device " +
    "will come and look").toBe(3);

  await s1.stop();
  servers = servers.filter((x) => x !== s1);
  const s2 = await startServer(dir);
  j = await getJson(`${s2.url}/settings`);
  expect(j.keymap, "a cleared keymap read as 'never had one' after a restart, which is " +
    "what brings the old per-device map back over it").toEqual({});
}, 40_000);

/* THE DISMISSED DORMANT CHATS (#501), the coverage mergedOrder never got, which
 * is how #444 shipped broken: the whitelist dropped the key while a rig mock
 * accepted it. Same contract as mergedOrder (sidList): all strings, replaced
 * whole, a list over 500 refused entire, and it survives a restart. Proven
 * against the REAL server process, since the whole point is that this server,
 * not a mock, actually stores it. */
test("dismissed: round-trips, replaced whole, junk refused, and it persists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-appsettings-"));
  dirs.push(dir);
  const s1 = await startServer(dir);

  // ABSENT before anybody dismissed anything. Not `[]`.
  let j = await getJson(`${s1.url}/settings`);
  expect(j.dismissed, "a fresh app server claimed to hold a dismissed list")
    .toBeUndefined();

  // two namespaced ids get dismissed
  const first = ["ws://h:10101/ws|w1:p1", "ws://h:10101/ws|w2:p3"];
  await postJson(`${s1.url}/settings`, { dismissed: first });
  j = await getJson(`${s1.url}/settings`);
  expect(j.dismissed).toEqual(first);
  expect(j.seq).toBe(1);
  // and only dismissed moved
  expect(j).toMatchObject({ speed: 1, notify: true, sound: true, activity: true });

  // a partial POST of another key leaves dismissed untouched
  await postJson(`${s1.url}/settings`, { speed: 1.5 });
  j = await getJson(`${s1.url}/settings`);
  expect(j.dismissed, "a partial POST clobbered dismissed").toEqual(first);

  // REPLACED WHOLE: a shorter list replaces, not merges (a restore is an id leaving)
  await postJson(`${s1.url}/settings`, { dismissed: ["ws://h:10101/ws|w1:p1"] });
  j = await getJson(`${s1.url}/settings`);
  expect(j.dismissed, "dismissed was merged instead of replaced")
    .toEqual(["ws://h:10101/ws|w1:p1"]);

  // `[]` is a real answer (everything restored), and it bumps seq
  await postJson(`${s1.url}/settings`, { dismissed: [] });
  j = await getJson(`${s1.url}/settings`);
  expect(j.dismissed).toEqual([]);
  expect(j.seq, "resetting dismissed to [] did not bump seq").toBe(4);

  // a non-string entry is refused ENTIRELY, previous value stands, seq unchanged
  await postJson(`${s1.url}/settings`, { dismissed: ["ok", 7] });
  j = await getJson(`${s1.url}/settings`);
  expect(j.dismissed, "half a dismissed list was stored").toEqual([]);
  expect(j.seq).toBe(4);

  // a 501-item list is refused WHOLE, previous value stands
  const tooMany = Array.from({ length: 501 }, (_, i) => `id${i}`);
  await postJson(`${s1.url}/settings`, { dismissed: tooMany });
  j = await getJson(`${s1.url}/settings`);
  expect(j.dismissed, "an over-cap dismissed list was stored").toEqual([]);

  // survives the process dying and coming back
  await postJson(`${s1.url}/settings`, { dismissed: first });
  await s1.stop();
  servers = servers.filter((x) => x !== s1);
  const s2 = await startServer(dir);
  j = await getJson(`${s2.url}/settings`);
  expect(j.dismissed, "the dismissed list was lost across a restart").toEqual(first);
}, 40_000);

test("/push/session is gone and notify is not suppressed by a quiet list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-appsettings-"));
  dirs.push(dir);
  const s = await startServer(dir);

  expect((await postJson(`${s.url}/push/session`, { sessionId: "host:w1:p1", notify: false })).status).toBe(404);
  expect((await fetch(`${s.url}/push/sessions`)).status).toBe(404);

  const r = await (await postJson(`${s.url}/push/notify`,
    { title: "t", body: "b", sessionId: "host:w1:p1" })).json() as any;
  expect(r.suppressed).toBe(false);
}, 30_000);

/* PLAIN FORWARDING THROUGH THE ROUTE. The account merge that used to live here
 * is gone (the owner's call: an engine-level push is sealed by the engine key,
 * so this server does no content or account logic on it; forward, that's it).
 * Three engines crossing a threshold on one account are three sends, one per
 * machine, and none of them is held back or answered with a merge verdict. */
const usagePost = (url: string, over: Record<string, unknown>) =>
  postJson(`${url}/push/notify`, {
    title: "CallYourCode",
    body: "New message",
    sessionId: "",
    plugin: "usage-card",
    tag: "plugin:usage-card:week (all models)",
    decided: true,
    kid: "k1", enc: "c2VhbGVk",
    ...over,
  }).then((r) => r.json() as Promise<any>);

test("/push/notify: an engine-level usage push is forwarded per machine, never merged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-appsettings-"));
  dirs.push(dir);
  const s = await startServer(dir);

  // three engines report the same account crossing; every one is forwarded
  for (const _host of ["macbook-air", "work", "linux"]) {
    const r = await usagePost(s.url, {});
    expect(r.ok).toBe(true);
    expect(r.merged, "the merge is gone: no post is held back or answered with a verdict")
      .toBeUndefined();
    expect(r.suppressed).toBe(false);
  }
}, 30_000);
