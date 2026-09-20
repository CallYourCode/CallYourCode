/* A PUSH NAMES THE SESSION, NOT THE APP (the notif-avatar lane).
 *
 * His report: every banner showed the generic phone logo and the title
 * "CallYourCode" / the pane's directory name, whatever the chat was called in the
 * list. A chat renamed "Shalu AI" must buzz as "Shalu AI" with her picture, not
 * as the cwd it happens to run in.
 *
 * Two facts make that possible and each is asserted here:
 *
 *   - the title is the ONE resolved display title (title.ts): your rename, then
 *     Claude Code's own session title, then the pane name. The push path used to
 *     read the raw pane name and ignored the rename entirely.
 *   - NO icon rides the wire any more. Sealed-transport enforcement made
 *     /session-photo owner-gated, so the OS could never fetch an engine photo
 *     URL; pushes stopped referencing them (notify carries no icon field) and
 *     the service worker keeps the app logo. A photo set on a session must NOT
 *     leak an icon onto the push wire.
 *
 * WHERE THE TITLE LIVES NOW, and it is the one thing that has changed since this
 * file was written: push-plaintext round 2 moved the real title and body INSIDE
 * `enc`, so the visible wire title of every push is the generic fallback. The
 * resolved name is asserted where it actually rides -- inside the seal.
 *
 *   bun test agent-engine/src/chat/notif-avatar.test.ts
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { wireCore, type WireCore, type WireCoreOpts, wireId } from "../test-utils/wire-core.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { onChat } from "./reply.ts";
import { batchMs } from "./notify.ts";
import { setNameOverride, setPhotoRec } from "../sessions/session-state.ts";
import { deriveSessionKey, openPush } from "../../../shared/e2e";
import { newestGen } from "../security/sec";
import type { Sock } from "../transport/sock.ts";

const priorEnv = { NOTIFY_BATCH_MS: process.env.NOTIFY_BATCH_MS };
delete process.env.NOTIFY_BATCH_MS;

let core: WireCore;
const HOUR = 60 * 60_000;
const BASE: WireCoreOpts = { with: ["notify", "frames"], askPollMs: HOUR, contextPollMs: HOUR };

beforeEach(async () => {
  core = await wireCore({ ...BASE });
  await until(() => core.sessions.size === 1, { what: "the pane to reconcile" });
});
afterEach(async () => {
  await core.stop();
  if (priorEnv.NOTIFY_BATCH_MS === undefined) delete process.env.NOTIFY_BATCH_MS;
  else process.env.NOTIFY_BATCH_MS = priorEnv.NOTIFY_BATCH_MS;
});

const sink = () => core.pushSink!;

function sessionSock(): Sock {
  return {
    data: {
      role: "session", sessionId: PANE, attached: null, visible: false, visibleAt: 0,
      beatMs: 0, gaps: [], lastFrame: 0, pongAt: 0, probeAt: 0, probeSeq: 0, cid: 0,
      openedAt: 0, tailing: null, terms: new Map(), remoteAddr: "127.0.0.1",
    },
    readyState: 1,
    send() {}, close() {}, remoteAddr: "127.0.0.1",
  } as unknown as Sock;
}

/** Nobody is attached, so this reply is announced. Returns the one wire item. */
async function pushOf(text = "the run finished") {
  await onChat(sessionSock(), { text, msgId: crypto.randomUUID() });
  const before = sink().batches.length;
  await core.clock.advance(batchMs());
  await until(() => sink().batches.length > before, { what: "the window to reach the sink" });
  return sink().hits.at(-1)!;
}

/** What the DEVICE will show once it opens the seal with its session key. */
async function opened(hit: { sessionId: string; enc?: string }) {
  const kS = await deriveSessionKey(newestGen(core.e2e!).key, hit.sessionId);
  return openPush(kS, hit.enc ?? "") as Promise<{ title: string; body: string; count: number }>;
}

// A real 1x1 PNG's stored record: the photo route whitelists image/png and keeps
// the bytes; the push only ever needs to be able to NAME the file.
const PHOTO = { file: "photo.png", mime: "image/png", ts: 1_754_000_000_000 };

test("a renamed session pushes its NAME, not the pane or the cwd it runs in", async () => {
  setNameOverride(wireId(PANE), "Shalu AI");
  const hit = await pushOf();

  // the wire is the generic fallback, always (push-plaintext round 2)
  expect(hit.title).toBe("CallYourCode");
  // ...and the device, once it opens the seal, is told the chat's own name
  expect((await opened(hit)).title).toBe("Shalu AI");
  // never the raw pane id, and never the cwd it happens to run in
  expect((await opened(hit)).title).not.toBe(PANE);
  expect((await opened(hit)).title).not.toBe("notify-harness");
});

test("with no rename the title falls through to the pane name, never the app name", async () => {
  const hit = await pushOf("no name here");
  expect((await opened(hit)).title).toBe("notify-harness");
});

test("clearing the rename puts the pane name back on the very next push", async () => {
  /* The resolved title is computed at push time from the ONE resolver, not
   * captured when the rename happened, so undoing a rename needs nothing else
   * to be told about it. */
  setNameOverride(wireId(PANE), "Shalu AI");
  expect((await opened(await pushOf("first"))).title).toBe("Shalu AI");

  setNameOverride(wireId(PANE), null);
  expect((await opened(await pushOf("second"))).title).toBe("notify-harness");
});

test("a session WITH a photo still rides NO icon: the engine-URL icon is deleted", async () => {
  /* Sealed-transport enforcement: /session-photo is owner-gated, so the OS
   * could never fetch an engine photo URL. Pushes stopped referencing them, so
   * even a session with a stored face puts no icon on the wire; the service
   * worker keeps the app logo and the in-app avatar rides the sealed tunnel. */
  setNameOverride(wireId(PANE), "Shalu AI");
  setPhotoRec(wireId(PANE), PHOTO);
  const hit = await pushOf();

  expect(hit.icon).toBeUndefined();
  // the NAME still rides, inside the seal, exactly as before
  expect((await opened(hit)).title).toBe("Shalu AI");
});

test("no photo means NO icon field either: the worker keeps the app logo", async () => {
  const hit = await pushOf("no face here");
  expect(hit.icon).toBeUndefined();
});

test("the name never leaks onto the cleartext wire, with or without a photo", async () => {
  /* The push-plaintext round 2 split: sessionId and unread stay readable because
   * the app server needs them before any key exists; the title and body are the
   * CONTENT and exist only inside `enc`. No icon rides at all now, so the only
   * cleartext left to guard is that the resolved name is not beside it. */
  setNameOverride(wireId(PANE), "Shalu AI");
  setPhotoRec(wireId(PANE), PHOTO);
  const secret = `avatar-leak-${crypto.randomUUID()}`;
  const hit = await pushOf(secret);

  const serialized = JSON.stringify(hit);
  expect(serialized).not.toContain("Shalu AI");
  expect(serialized).not.toContain(secret);
  expect(hit.icon).toBeUndefined();
  expect(hit.unread).toBe(1);
});
