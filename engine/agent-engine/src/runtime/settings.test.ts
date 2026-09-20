/* PER-SESSION SETTINGS: mute and the bell, saved with the session, honoured by
 * the notify decision, and still there after the engine restarts.
 *
 * The bug this whole area started from: `muted` was a field on the in-memory
 * Session struct, so every engine restart silently unmuted every chat that had
 * been muted on purpose. Overrides live in the agent's meta.json now, next to
 * the name and the voice.
 *
 * TWO HOMES, ONE RESOLUTION (CONTRACT.md AP2 / AS1). The user's GLOBAL defaults
 * live on the app server; this engine caches them, because the bell has to be
 * answerable at 3am with no page open. A session with no override follows the
 * global; a session with one does not, in EITHER direction. Speed is not one of
 * them: it left this store on 2026-08-04 ("the playback speed should just be
 * global"), and the engines already on disk hold a `speed` for every chat he
 * ever tapped the chip in, so it is not merely ignored -- it is erased.
 *
 * HTTP IN, WIRE OUT. The app writes a setting over HTTP and the engine confirms
 * by broadcasting the updated sessions frame (CONTRACT.md boundary 2). There is
 * no settings frame inbound and no HTTP answer the app renders from, so a write
 * that returned 200 and broadcast nothing would leave his other device showing
 * the old value until something else happened to move the list.
 *
 * NO ENGINE PROCESS: wireCore's in-process boot, the SHIPPED route group over a
 * real Bun.serve on port 0, and a pushSink standing in for the app server.
 *
 *   bun test agent-engine/src/runtime/settings.test.ts
 */

import { test, expect, afterEach } from "bun:test";

import { wireCore, sessionsFrame, type WireCore, wireId } from "../test-utils/wire-core.ts";
import { chatStore } from "../sessions/session-state.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { metaForSession, seedAgent } from "../test-utils/builders.ts";
import { PANE, defaultSessionIdOf } from "../test-utils/fake-herdr.ts";
/* The harness id the fake herdr reports for PANE: what the disk records
 * (meta.json sessionId, the chat log) are keyed by, never the pane id. */
const PANE_SID = defaultSessionIdOf(PANE);
import { until } from "../test-utils/wait.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";
import { dispatchClientFrame } from "../transport/frames.ts";
import { dispatchSessionFrame } from "./mcp.ts";
import { flushBatch, notifyWanted, refreshHostedSettings } from "../chat/notify.ts";
import type { Sock } from "../transport/sock.ts";

let core: WireCore | null = null;
let http: ServedRoutes | null = null;
afterEach(async () => {
  /* Every queued chat append on disk before the tmp tree goes: an append still
   * in flight when the directory is removed prints an ENOENT nobody can act on. */
  await chatStore.flush();
  http?.stop();
  http = null;
  await core?.stop();
  core = null;
});

/** The session's own MCP socket: how an agent reply enters the log. */
function mcpSock(sessionId: string): Sock {
  return {
    data: { role: "session", sessionId, terms: new Map() },
    readyState: 1, remoteAddr: "127.0.0.1",
    send(s: string) { return s.length; }, close() { /* nothing holds it */ },
  } as unknown as Sock;
}

/** A live pane, the notify layer over a push sink, and the shipped routes over
 *  a real Bun.serve on port 0. `seed` writes an agent record BEFORE the wiring
 *  that reads it, which is what a restart onto existing state looks like. */
async function boot(seed?: (root: string) => Promise<void>): Promise<WireCore> {
  core = await wireCore({ with: ["notify", "frames"], start: !seed });
  if (seed) {
    await seed(core.root);
    await core.reset({ start: true });
  }
  await until(() => !!core!.byHandle(PANE), { what: "the pane to reconcile" });
  http = serveRoutes({ groups: [sessionOpsRoutes], ctx: { adapter: core.adapter } });
  return core;
}

const post = (body: unknown) =>
  http!.post(`/session/${encodeURIComponent(wireId(PANE))}/settings`, body);

/** This session's row, exactly as a client is handed it. */
const row = (): any => (sessionsFrame().list as any[]).find((s) => s.id === wireId(PANE));

/** The reply path, and what the app server was asked to push for it. */
async function reply(c: WireCore, text: string): Promise<void> {
  await dispatchSessionFrame(mcpSock(PANE), { t: "chat", text, msgId: crypto.randomUUID() });
  await flushBatch(); // the 10s wall-aligned window, closed on demand
}

/** Every console line written while `fn` ran. The notify decision log is the
 *  only account of a suppression, so "it decided not to buzz" is a claim only
 *  this can check; the alternative was buzzing a real phone to find out. */
async function saying(fn: () => Promise<void>): Promise<string[]> {
  const said: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
  try { await fn(); } finally { console.log = real; }
  return said;
}

test("overrides round-trip the wire and survive a restart", async () => {
  const c = await boot();
  const client = c.client();

  // no override: the wire says so with an EMPTY object, and never with a
  // top-level `muted` field the app might read instead
  expect(row().settings).toEqual({});
  expect(row().muted).toBeUndefined();

  /* `activity` was a per-session override until task 350 removed it (it is one
   * app-level switch now, like speed); the endpoint accepts only muted/notify.
   * Sending it alongside them is harmless -- it is simply not stored. */
  client.clear();
  const res = await post({ muted: true, notify: false, activity: true });
  expect(res.status).toBe(200);
  expect((await res.json() as any).settings).toEqual({ muted: true, notify: false });

  expect(row().settings).toEqual({ muted: true, notify: false });
  expect(row().muted).toBeUndefined();
  /* HTTP IN, WIRE OUT: the write is confirmed by a broadcast, or his other
   * device shows the old value until something unrelated moves the list. */
  const pushed = client.last("sessions");
  expect(pushed, "the settings write broadcast no sessions frame").toBeTruthy();
  expect((pushed!.list as any[]).find((s) => s.id === wireId(PANE)).settings)
    .toEqual({ muted: true, notify: false });

  /* THE RESTART. A fresh wiring over the SAME data dir, which is exactly what a
   * restart is: same disk, new memory. The override has to come back from
   * meta.json, because it lives nowhere else. */
  await until(async () => (await metaForSession(c.root, PANE_SID))?.settings?.muted === true,
    { what: "the override to reach the agent record on disk" });
  await c.reset();
  await until(() => !!c.byHandle(PANE), { what: "the pane after the restart" });
  expect(row().settings,
    "the override did not survive the restart: every chat he muted on purpose is " +
    "unmuted again, which is the bug this whole store exists for")
    .toEqual({ muted: true, notify: false });
});

test("a stored speed override is dropped, not just ignored", async () => {
  /* An ignored key is a second answer waiting to be read again. It is erased at
   * LOAD, so it never reaches the wire, and the next meta save takes it off
   * disk too. */
  const c = await boot(async (root) => {
    await seedAgent(root, PANE_SID, [], {
      settings: { muted: true, speed: 2 } as unknown as { muted?: boolean },
    });
  });

  expect(row().settings, "the wire carried a retired setting").toEqual({ muted: true });

  await post({ notify: false }); // any settings write triggers the meta save
  const meta = await until(async () =>
    (await metaForSession(c.root, PANE_SID))?.settings?.notify === false,
    { what: "the meta save" }).then(() => metaForSession(c.root, PANE_SID));
  expect(meta!.settings!.muted).toBe(true);
  expect((meta!.settings as Record<string, unknown>).speed,
    "the retired speed override is still on disk, waiting to be read as a second answer")
    .toBeUndefined();
});

test("POST speed alone is refused, and writes no override", async () => {
  /* A stale page still sending {speed} must not get a 200 over a store that
   * kept nothing: that is the app being told a setting was saved when it was
   * not. Same for a body with nothing the endpoint accepts at all. */
  await boot();
  expect((await post({ speed: 1.5 })).status).toBe(400);
  expect((await post({ activity: false })).status).toBe(400);
  expect((await post({})).status).toBe(400);
  expect(row().settings).toEqual({});
});

test("only booleans and null are taken; a stringly-typed value writes nothing", async () => {
  /* The store holds booleans. "true" and 1 are what a hand-rolled caller sends,
   * and storing either would make settingsOf().muted truthy in a way that never
   * clears and never round-trips. */
  await boot();
  expect((await post({ muted: "true" })).status).toBe(400);
  expect((await post({ muted: 1 })).status).toBe(400);
  expect(row().settings).toEqual({});
  expect((await post({ muted: false })).status).toBe(200);
  expect(row().settings, "an override set to FALSE is still an override").toEqual({ muted: false });
});

test("a mute frame does not persist an override", async () => {
  /* Mute is a per-session SETTING, written over HTTP. There is no inbound mute
   * frame any more -- the client dispatcher does not know the word -- and this
   * is the guard against one growing back: a frame that quietly muted a chat
   * would be an override with no home on disk, gone at the next restart, and a
   * second way to say a thing that already has one. */
  const c = await boot();
  const client = c.client();
  client.clear();
  await dispatchClientFrame(client.sock, { t: "mute", id: wireId(PANE), muted: true });

  expect(row().settings.muted, "a mute frame set an override").toBeUndefined();
  expect(client.frames, "a mute frame produced an answer, so something handles it")
    .toEqual([]);
  expect((await metaForSession(c.root, PANE_SID))?.settings?.muted).toBeUndefined();
});

test("null clears one override back to follow-the-global", async () => {
  const c = await boot();
  await post({ muted: true, notify: false });
  expect(row().settings).toEqual({ muted: true, notify: false });

  await post({ notify: null });
  expect(row().settings, "null did not clear the key back to 'follow the global'")
    .toEqual({ muted: true });

  // clearing the LAST one leaves an empty object, never a stale record on disk
  await post({ muted: null });
  expect(row().settings).toEqual({});
  await until(async () => (await metaForSession(c.root, PANE_SID))?.settings === undefined,
    { what: "the emptied override to leave the agent record" });
});

test("bell override OFF: the reply arrives, the unread counts, nothing is pushed", async () => {
  const c = await boot();
  await post({ notify: false });

  const said = await saying(() => reply(c, "nobody should be buzzed"));
  expect(c.pushSink!.hits, "the bell was off and a push went out anyway").toEqual([]);
  expect(c.pushSink!.batches, "an empty window still POSTed to the app server").toEqual([]);
  expect(said.some((l) => l.includes("[notify] bell-off") && l.includes("this chat's bell")),
    `the decision log does not say the chat's own bell silenced it: ${JSON.stringify(said)}`)
    .toBe(true);

  // the bell silences the PHONE, not the chat: the message is still unread
  expect(row().unread, "the silenced reply was also swallowed by the chat").toBe(1);
  expect(c.byHandle(PANE)!.chat.at(-1)!.text).toBe("nobody should be buzzed");
});

test("global notify OFF is followed by a session with no override, and beaten by one with",
  async () => {
    const c = await boot();
    /* The user's global default says do not buzz. The engine caches it, so the
     * change is made at the app server and then re-read, which is the same
     * path the TTL takes. */
    c.pushSink!.settings.notify = false;
    await refreshHostedSettings();
    expect(notifyWanted(wireId(PANE)), "a session with no override must follow the global").toBe(false);

    const said = await saying(() => reply(c, "global says quiet"));
    expect(c.pushSink!.hits).toEqual([]);
    expect(said.some((l) => l.includes("[notify] bell-off") && l.includes("the global default")),
      `the log does not say the GLOBAL silenced it: ${JSON.stringify(said)}`).toBe(true);

    // the override wins over the global, in the direction the global forbids
    await post({ notify: true });
    expect(notifyWanted(wireId(PANE))).toBe(true);
    await reply(c, "this chat's own bell says buzz");
    expect(c.pushSink!.hits.length, "the session override did not beat the global").toBe(1);
    const hit = c.pushSink!.hits[0];
    expect(hit.sessionId).toBe(`${"seam-host"}:${wireId(PANE)}`);
    // and the engine tells the app server the decision is already made
    expect(hit.decided).toBe(true);
    expect(hit.unread, "the push carries the engine's own count, from its read marker").toBe(2);

    /* AND THE OTHER DIRECTION, which is the half a "global off" test cannot
     * reach: with the global back ON, a session that says OFF still says off. */
    c.pushSink!.settings.notify = true;
    await refreshHostedSettings();
    await post({ notify: false });
    expect(notifyWanted(wireId(PANE)), "the override lost to a global that agreed with it before")
      .toBe(false);
    await reply(c, "still quiet in here");
    expect(c.pushSink!.hits.length, "a muted chat buzzed once the global came back on").toBe(1);
  });
