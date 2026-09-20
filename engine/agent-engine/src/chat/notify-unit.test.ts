/* The notify module's pure pieces: the wall-aligned boundary math, the
 * sealed-wire rule (generic fallback only, real text in enc), the bell
 * resolution and presence stability. Fake deps; no engine, no push server.
 *
 * The pushWire assertions below are the LOAD-BEARING ones. A real regression
 * shipped a build where the preview rode the wire in cleartext, so these do not
 * just check two fields: they scan the whole serialized item for every secret
 * string that went in.
 *
 *   bun test agent-engine/src/chat/notify-unit.test.ts
 */

import { expect, test, beforeEach, afterAll } from "bun:test";
import { initNotify, msToBoundary, pushWire, notifyWanted, notifyEngineDevices, resetForTest as resetNotify } from "./notify.ts";
import { initPresence, present, appConnected, resetForTest as resetPresence } from "../sessions/presence.ts";
import type { Sock } from "../transport/sock.ts";

const mkClients = new Set<Sock>();
beforeEach(() => {
  /* Both singletons are reset before each wiring: initNotify kicks a hosted
   * settings refresh and arms the ceiling interval, and a second wiring on top
   * of a live one would fire the first's timers into the second's deps. */
  resetNotify();
  resetPresence();
  mkClients.clear();
  initPresence({ clients: () => mkClients, onAway: () => {} });
  initNotify({
    clients: () => mkClients,
    sessions: () => [],
    broadcastSessions: () => {},
    engineHost: "testhost",
    appServerUrl: "", // no app server: the batch never leaves
    token: async () => "",
    peekToken: () => "",
    dropToken: () => {},
    seal: async () => ({ kid: "k1", enc: "sealed" }),
    sealEngine: async () => ({ kid: "k1", enc: "engine-sealed" }),
    sessionPushTitle: () => "T",
  });
});
afterAll(() => {
  resetNotify();
  resetPresence();
});

test("msToBoundary lands on the next wall boundary, never 0", () => {
  for (const period of [2000, 10_000]) {
    const ms = msToBoundary(period);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(period);
    const lands = Date.now() + ms;
    expect(Math.abs(lands % period)).toBeLessThanOrEqual(50); // aligned (jitter slack)
  }
});

test("msToBoundary is strictly positive even standing exactly on a boundary", () => {
  /* The batch timer is re-armed from inside its own callback. A 0 here would
   * arm a timer that fires in the same tick and spin the loop, which is the
   * reason the maths is `floor(...) + period` rather than a ceil. */
  for (const period of [1, 2, 1000, 10_000]) {
    expect(msToBoundary(period)).toBeGreaterThan(0);
  }
});

test("msToBoundary respects the phase offset, so two engines do not fire together", () => {
  // the offset is how each engine takes its own slice of the cycle; a boundary
  // computed without it puts every engine on the same wall second
  const period = 10_000;
  for (const offset of [0, 1234, 9999]) {
    const ms = msToBoundary(period, offset);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(period);
    const lands = Date.now() + ms;
    expect(Math.abs((lands - offset) % period)).toBeLessThanOrEqual(50);
  }
});

test("pushWire NEVER carries the real preview: generic fallback + enc only", () => {
  const wire = pushWire(
    { sessionId: "s1", unread: 3, title: "Secret Chat", body: "the real reply text" },
    { kid: "k9", enc: "AAAA" },
  );
  expect(wire.title).toBe("CallYourCode");
  expect(wire.body).toBe("New message");
  expect(wire.kid).toBe("k9");
  expect(wire.enc).toBe("AAAA");
  expect(wire.sessionId).toBe("s1"); // documented metadata stays cleartext
  expect(wire.unread).toBe(3);
});

test("no field of the wire item carries the preview, whatever the base held", () => {
  /* THE REGRESSION THIS PINS: a build shipped where the real title and body
   * reached the app server in cleartext. Two field assertions were not enough,
   * because the leak can ride ANY key, so this serializes the whole item and
   * looks for the secrets in it. */
  const wire = pushWire(
    {
      sessionId: "s1", unread: 3,
      title: "Secret Chat", body: "the real reply text",
      tag: "chat:s1", decided: true,
    },
    { kid: "k9", enc: "c2VhbGVk" },
  );
  const serialized = JSON.stringify(wire);
  for (const secret of ["Secret Chat", "the real reply text"]) {
    expect(serialized).not.toContain(secret);
  }
  // and the metadata the app server genuinely needs is still there
  expect(wire.tag).toBe("chat:s1");
  expect(wire.decided).toBe(true);
});

test("pushWire scrubs title and body and nothing else, which is the caller's contract", () => {
  /* The scrub is a WHITELIST of two fields, so the safety of the whole path
   * rests on no caller ever hanging the preview off a third key. This pins the
   * boundary: a base field that is not title/body rides through untouched. If
   * a future payload grows a `preview`, this test is where it has to be
   * noticed, because pushWire will happily forward it. */
  const base = { sessionId: "s1", title: "T", body: "B", note: "kept" };
  const wire = pushWire(base, { kid: "k", enc: "e" });
  expect(Object.keys(wire).sort()).toEqual(["body", "enc", "kid", "note", "sessionId", "title"]);
  expect(wire.note).toBe("kept");
  // exactly two of the base's own keys were rewritten
  const changed = Object.keys(base).filter((k) => (base as Record<string, unknown>)[k] !== (wire as Record<string, unknown>)[k]);
  expect(changed.sort()).toEqual(["body", "title"]);
});

test("the fallback OVERRIDES the base, it does not merge under it", () => {
  /* The whole safety of pushWire is the spread order: `...base` first, the
   * generic fallback second. Flip those two lines and every push leaks. */
  const wire = pushWire({ title: "leak", body: "leak", kid: "attacker", enc: "attacker" },
    { kid: "k1", enc: "real" });
  expect(wire.title).toBe("CallYourCode");
  expect(wire.body).toBe("New message");
  expect(wire.kid).toBe("k1");
  expect(wire.enc).toBe("real");
});

test("the generic fallback is the SAME wording an unpaired device already shows", () => {
  // an old or unpaired device cannot decrypt `enc` and falls back to these
  // fields; they have to read like the neutral push it has always shown
  const wire = pushWire({}, { kid: "k", enc: "e" });
  expect(wire).toEqual({ title: "CallYourCode", body: "New message", kid: "k", enc: "e" });
});

test("pushWire is pure: the caller's base object is not mutated", () => {
  const base = { sessionId: "s1", title: "Secret Chat", body: "real" };
  pushWire(base, { kid: "k", enc: "e" });
  expect(base.title).toBe("Secret Chat"); // the caller still has its own copy
  expect(base).not.toHaveProperty("enc");
});

/* ---- the engine-level, session-less push (a plan-usage threshold alert) ---- */

/* Re-wire notify with a chosen sealEngine and a capturing fetch. Returns the
 * array the POSTs land in; a stubbed fetch means nothing leaves the process. */
function wireEngineNotify(sealEngine: () => Promise<{ kid: string; enc: string } | null>): {
  posts: { url: string; body: any }[]; restore: () => void;
} {
  resetNotify();
  const posts: { url: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: any) => {
    // initNotify also polls /settings; only the push POSTs are the assertion here
    if (String(url).includes("/push/notify")) {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    }
    return { ok: true, status: 200, json: async () => ({ devices: 1, count: 0 }) } as any;
  }) as any;
  initNotify({
    clients: () => mkClients, sessions: () => [], broadcastSessions: () => {},
    engineHost: "testhost", appServerUrl: "https://app.example",
    token: async () => "tok", peekToken: () => "tok", dropToken: () => {},
    seal: async () => ({ kid: "k1", enc: "sealed" }),
    sealEngine,
    sessionPushTitle: () => "T",
  });
  return { posts, restore: () => { globalThis.fetch = realFetch; } };
}

test("notifyEngineDevices: the wire is the generic fallback + kid/enc + plugin id, and NO account anywhere in cleartext", async () => {
  const { posts, restore } = wireEngineNotify(async () => ({ kid: "kENG", enc: "c2VhbGVk" }));
  try {
    await notifyEngineDevices({
      plugin: "usage-card",
      title: "93% of the 5-hour limit",
      body: "sam@example.com · resets soon",
      subTag: "5 hours",
      open: "usage:linux",
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://app.example/push/notify");
    const w = posts[0].body;
    // the visible fields are the neutral fallback, never the real alert text
    expect(w.title).toBe("CallYourCode");
    expect(w.body).toBe("New message");
    expect(w.sessionId).toBe("");           // session-LESS
    expect(w.plugin).toBe("usage-card");    // THE identifier: the raising plugin
    expect(w.kid).toBe("kENG");
    expect(w.enc).toBe("c2VhbGVk");
    // the dedup tag is plugin id + window sub-key, built here, account-free
    expect(w.tag).toBe("plugin:usage-card:5 hours");
    /* the cleartext `usage` block is GONE: it existed only to feed the app
     * server's account merge, and the merge is gone (forward, that's it) */
    expect(w.usage).toBeUndefined();
    expect(Object.keys(w).sort()).toEqual(["body", "enc", "kid", "plugin", "sessionId", "tag", "title"]);
    // the real title/body/open and the ACCOUNT never ride the wire in the clear
    const serialized = JSON.stringify(w);
    for (const secret of ["93%", "resets soon", "usage:linux", "sam@example.com"]) {
      expect(serialized).not.toContain(secret);
    }
  } finally { restore(); }
});

test("notifyEngineDevices: with no sub-key the tag is just the plugin id", async () => {
  const { posts, restore } = wireEngineNotify(async () => ({ kid: "kENG", enc: "c2VhbGVk" }));
  try {
    await notifyEngineDevices({ plugin: "some-plugin", title: "t", body: "b" });
    expect(posts).toHaveLength(1);
    expect(posts[0].body.tag).toBe("plugin:some-plugin");
    expect(posts[0].body.plugin).toBe("some-plugin");
  } finally { restore(); }
});

test("notifyEngineDevices sends NOTHING when the seal returns null (the round-2 rule)", async () => {
  const { posts, restore } = wireEngineNotify(async () => null);
  try {
    await notifyEngineDevices({ plugin: "usage-card", title: "t", body: "b", open: "usage:h" });
    expect(posts).toHaveLength(0);
  } finally { restore(); }
});

test("notifyEngineDevices sends NOTHING when the seal throws", async () => {
  const { posts, restore } = wireEngineNotify(async () => { throw new Error("no key"); });
  try {
    await notifyEngineDevices({ plugin: "usage-card", title: "t", body: "b" });
    expect(posts).toHaveLength(0);
  } finally { restore(); }
});

test("notifyWanted: the session override wins over the global default", async () => {
  const S = await import("../sessions/session-state.ts");
  // no override: the cached global default (starts true)
  expect(notifyWanted("nobody")).toBe(true);
  S.applySessionSettings("bell-off", { notify: false });
  expect(notifyWanted("bell-off")).toBe(false);
  S.applySessionSettings("bell-off", { notify: null });
  expect(notifyWanted("bell-off")).toBe(true);
});

test("notifyWanted is per session: silencing one chat does not silence the rest", async () => {
  const S = await import("../sessions/session-state.ts");
  S.applySessionSettings("quiet-one", { notify: false });
  expect(notifyWanted("quiet-one")).toBe(false);
  expect(notifyWanted("noisy-one")).toBe(true);
  // an explicit true is an override too, not just an absence
  S.applySessionSettings("loud-one", { notify: true });
  expect(notifyWanted("loud-one")).toBe(true);
});

const sock = (over: Record<string, unknown> = {}): Sock =>
  ({ data: { visible: true, visibleAt: Date.now(), beatMs: 0, gaps: [], probeAt: 0,
    lastFrame: Date.now(), pongAt: 0, openedAt: Date.now() - 60_000, cid: 1,
    role: "client", ...over } } as unknown as Sock);

test("present: a live recent frame is presence; a long-quiet page is not", () => {
  expect(present(sock())).toBe(true);
  expect(present(sock({ lastFrame: Date.now() - 60_000, visibleAt: Date.now() - 60_000 }))).toBe(false);
});

test("present: a poked page that has not answered is frozen, not present", () => {
  // a frozen page keeps its socket open; the poke with no frame after it is
  // what tells them apart, and getting this wrong means silence for ever
  expect(present(sock({ probeAt: Date.now() + 10 }))).toBe(false);
});

test("appConnected needs a visible, stable, present client", () => {
  expect(appConnected()).toBe(false);
  mkClients.add(sock({ visible: false }));
  expect(appConnected()).toBe(false); // backgrounded does not count
  mkClients.add(sock({ openedAt: Date.now() - 1000 }));
  expect(appConnected()).toBe(false); // too young to be a person
  mkClients.add(sock());
  expect(appConnected()).toBe(true);
});

test("appConnected fails closed on a client the engine is unsure about", () => {
  /* Being absent only ever costs a notification he might not have needed;
   * being wrongly present is the bug that makes the app go silent. */
  mkClients.add(sock({ lastFrame: Date.now() - 60_000 }));      // silent past its beat
  mkClients.add(sock({ probeAt: Date.now() + 1 }));             // poked, no answer
  mkClients.add(sock({ visible: false, openedAt: Date.now() - 60_000 })); // backgrounded
  expect(appConnected()).toBe(false);
});
