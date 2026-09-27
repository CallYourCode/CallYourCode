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

/* THE REPLY DIALS ARE PLUGIN-OWNED NOW (#585). Their DEFAULTS still ship from
 * this file's SETTINGS_DEFAULTS (complexity off, verbosity on, prompt-bits off),
 * because the app draws a first-paint fallback off /settings; but the app server
 * is no longer a WRITER of them -- the engine's reply-dials plugin owns the live
 * value, and a POST of any dial key is dropped rather than stored. Proven against
 * the REAL server process, since the whole point is what this server does with
 * the bytes.
 *
 * complexity: dial VALUE / on-switch, replyLevel/verbosity likewise, plus the
 * wording `strings` bag: all six move to the plugin. */
test("the reply dials ship their defaults but the app server refuses to write them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-appsettings-"));
  dirs.push(dir);
  const s1 = await startServer(dir);

  // the shipped defaults, before anybody chose: complexity OFF, verbosity ON,
  // prompt-bits OFF (#585 follow-up), and no stated level on a fresh account
  let j = await getJson(`${s1.url}/settings`);
  expect(j.complexityOn, "a fresh app server offered complexity by default").toBe(false);
  expect(j.verbosityOn, "verbosity should stay on by default").toBe(true);
  expect(j.promptBitsOn, "prompt-bits should ship off").toBe(false);
  expect(j.replyLevel, "a fresh server states no reply level").toBeUndefined();
  expect(j.complexity, "a fresh server states no complexity level").toBeUndefined();

  // a POST of the plugin-owned dials is DROPPED whole: nothing lands, seq is flat
  await postJson(`${s1.url}/settings`, {
    complexityOn: true, verbosityOn: false, promptBitsOn: true,
    replyLevel: 5, complexity: 2, strings: { reply: { 3: { text: " (x)" } } },
  });
  j = await getJson(`${s1.url}/settings`);
  expect(j.complexityOn, "the app server stored a plugin-owned dial").toBe(false);
  expect(j.verbosityOn).toBe(true);
  expect(j.promptBitsOn).toBe(false);
  expect(j.replyLevel, "the app server stored a plugin-owned level").toBeUndefined();
  expect(j.strings, "the app server stored a plugin-owned wording bag").toBeUndefined();
  expect(j.seq, "a dropped dial write bumped seq").toBe(0);

  // a real device-owned key still writes right beside them
  await postJson(`${s1.url}/settings`, { speed: 1.5 });
  j = await getJson(`${s1.url}/settings`);
  expect(j.speed).toBe(1.5);
  expect(j.seq).toBe(1);
}, 40_000);

/* READING IS TOLERANT OF OLD FILES (#585). The reply dials moved to the plugin,
 * but an app-settings.json written before the move still holds them, and the app
 * needs to READ those values once to migrate them into the plugin. So the server
 * keeps loading them at boot and echoing them on GET -- it just never writes them
 * again. Proven by seeding the settings file this server boots onto. */
test("old reply-dial values on disk are read and echoed for the one-time migration, never rewritten", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-appsettings-"));
  dirs.push(dir);

  // an app-settings.json from before the move: the owner's live dials, including
  // the rung-2 wording that is now the shipped default anyway
  const RUNG2 = " (Reply with the chat tool, the way you would message someone. 1-2 lines" +
    " answer. No blobs of text. A list of short and simple line items where it helps.)";
  await Bun.write(join(dir, "app-settings.json"), JSON.stringify({
    speed: 1, replyLevel: 2, complexity: 3,
    verbosityOn: true, complexityOn: false, promptBitsOn: false,
    strings: { reply: { 2: { text: RUNG2 } } },
  }));

  const s1 = await startServer(dir);

  // read back verbatim so the app can hand them to the plugin's import op
  let j = await getJson(`${s1.url}/settings`);
  expect(j.replyLevel, "the old stated level was not read from disk").toBe(2);
  expect(j.complexity).toBe(3);
  expect(j.verbosityOn).toBe(true);
  expect(j.complexityOn).toBe(false);
  expect(j.promptBitsOn).toBe(false);
  expect(j.strings, "the old wording bag was not echoed for migration")
    .toEqual({ reply: { 2: { text: RUNG2 } } });

  // ...and still not writable: a POST that would move one is dropped
  await postJson(`${s1.url}/settings`, { replyLevel: 5, strings: { reply: { 1: { text: " (z)" } } } });
  j = await getJson(`${s1.url}/settings`);
  expect(j.replyLevel, "a plugin-owned level was overwritten via the app server").toBe(2);
  expect(j.strings, "a plugin-owned wording bag was overwritten via the app server")
    .toEqual({ reply: { 2: { text: RUNG2 } } });

  // the old values survive a restart (they are read, just never rewritten)
  await s1.stop();
  servers = servers.filter((x) => x !== s1);
  const s2 = await startServer(dir);
  j = await getJson(`${s2.url}/settings`);
  expect(j.replyLevel, "the old level was lost across a restart").toBe(2);
  expect(j.strings).toEqual({ reply: { 2: { text: RUNG2 } } });
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
