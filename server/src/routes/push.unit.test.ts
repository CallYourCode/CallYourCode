/* routes/push.ts as a unit: both sides of the surface against a real
 * OwnerStore on scratch files whose push.send is captured, and fake owner
 * resolution. No server process, no subscriptions, no network. */

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePushRoutes } from "./push";
import { OwnerStore } from "../access/owner-store";
import { BATCH_ITEMS_MAX, PUSH_BODY_MAX_BYTES, PUSH_RATE_MAX } from "../platform/caps";
import type { EngineTokenRec } from "../access/enroll";

let dirs: string[] = [];
let stores: OwnerStore[] = [];
afterEach(async () => {
  /* the batch window plants a real ~12s timer; stop it so the suite never
   * waits on a window nobody is watching */
  for (const s of stores) {
    const t = (s as any).outTimer;
    if (t) { clearTimeout(t); (s as any).outTimer = null; }
  }
  stores = [];
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});
const silent = () => {};

async function rig(opts: { device?: boolean; engine?: boolean } = {}) {
  const d = await mkdtemp(join(tmpdir(), "cyc-pushroutes-unit-"));
  dirs.push(d);
  const store = await OwnerStore.open(join(d, "push.json"), join(d, "settings.json"),
    join(d, "reports"), silent);
  stores.push(store);
  const sent: any[] = [];
  (store.push as any).send = async (p: any) => { sent.push(p); };
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const eng: EngineTokenRec = { engineId: `e-${crypto.randomUUID().slice(0, 8)}`,
    owner: "local" } as any;
  const routes = makePushRoutes({
    owners: {
      deviceOwner: async () => (opts.device === false ? null : store),
      engineAuth: () => (opts.engine === false ? null : eng),
      engineStore: () => store,
      vapidPublicKey: () => "the-key",
    },
    log: (event, fields) => { logs.push({ event, fields }); },
  });
  return { store, sent, eng, routes, logs };
}

const post = (path: string, body: unknown) =>
  new Request(`http://x${path}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("/push/key answers the injected VAPID key with no owner in hand", async () => {
  const { routes } = await rig({ device: false });
  const r = (await routes(new Request("http://x/push/key"), "/push/key"))!;
  expect(await r.json()).toEqual({ key: "the-key" });
});

test("paths outside the family fall through as null", async () => {
  const { routes } = await rig();
  expect(await routes(new Request("http://x/config"), "/config")).toBeNull();
});

test("/push/notify: no engine token is a 401 before the body is trusted", async () => {
  const { routes, sent } = await rig({ engine: false });
  const r = (await routes(post("/push/notify", { body: "hi" }), "/push/notify"))!;
  expect(r.status).toBe(401);
  expect(sent.length).toBe(0);
});

test("/push/notify: empty body text refused, nothing tracked", async () => {
  const { routes, store } = await rig();
  const r = (await routes(post("/push/notify", { sessionId: "s1" }), "/push/notify"))!;
  expect(r.status).toBe(400);
  expect(store.pending.size).toBe(0);
});

test("/push/notify: a body past the cap is a 413, refused rather than buffered", async () => {
  const { routes, sent, logs } = await rig();
  // a real oversized body (its Content-Length already tells the truth)
  const big = post("/push/notify",
    { sessionId: "s1", body: "x".repeat(PUSH_BODY_MAX_BYTES + 1) });
  const r = (await routes(big, "/push/notify"))!;
  expect(r.status).toBe(413);
  expect((await r.json()).error).toBe("too large");
  // a stream with no Content-Length is stopped the moment it would pass the cap
  const chunk = new Uint8Array(1024 * 1024).fill(120);
  let pushed = 0;
  const drip = new ReadableStream({
    pull(c) {
      if (pushed++ * chunk.byteLength > PUSH_BODY_MAX_BYTES) c.close();
      else c.enqueue(chunk);
    },
  });
  const sneaky = (await routes(new Request("http://x/push/notify",
    { method: "POST", body: drip }), "/push/notify"))!;
  expect(sneaky.status).toBe(413);
  expect(sent.length).toBe(0);
  expect(logs.filter((l) => l.event === "push.refused").length).toBe(2);
});

test("/push/notify: the ENGINE'S unread is the badge; no field leaves it alone", async () => {
  const { routes, store, sent } = await rig();
  // engine says 3 unread
  let r = (await routes(post("/push/notify",
    { sessionId: "s1", body: "m", unread: 3 }), "/push/notify"))!;
  expect((await r.json()).count).toBe(3);
  expect(store.pending.get("s1")).toBe(3);
  expect(sent[0].badge).toBe(3);
  expect(sent[0].count).toBe(3);
  // no field: banner count falls back to 1 but the badge stays where it was
  r = (await routes(post("/push/notify",
    { sessionId: "s1", body: "m2" }), "/push/notify"))!;
  expect((await r.json()).count).toBe(1);
  expect(store.pending.get("s1")).toBe(3);
  expect(sent[1].badge).toBe(3);
  // unread 0 clears the chat
  await routes(post("/push/notify",
    { sessionId: "s1", body: "m3", unread: 0 }), "/push/notify");
  expect(store.pending.has("s1")).toBe(false);
});

test("/push/notify: the sealed blob rides through untouched", async () => {
  const { routes, sent } = await rig();
  await routes(post("/push/notify",
    { sessionId: "s1", body: "fallback", kid: "k1", enc: "cipher" }), "/push/notify");
  expect(sent[0].kid).toBe("k1");
  expect(sent[0].enc).toBe("cipher");
});

test("/push/notify: an engine-level push forwards plugin id and tag as opaque routing metadata", async () => {
  const { routes, sent } = await rig();
  await routes(post("/push/notify",
    { sessionId: "", body: "New message", plugin: "usage-card",
      tag: "plugin:usage-card:5 hours", kid: "k1", enc: "cipher" }), "/push/notify");
  expect(sent).toHaveLength(1);
  // forwarded as-is, like sessionId: no content logic, no rewrite
  expect(sent[0].plugin).toBe("usage-card");
  expect(sent[0].tag).toBe("plugin:usage-card:5 hours");
  expect(sent[0].sessionId).toBe("");
  expect(sent[0].kid).toBe("k1");
  expect(sent[0].enc).toBe("cipher");
});

test("/push/notify: engine-level pushes count against the same per-engine rate cap", async () => {
  const { routes, sent } = await rig();
  for (let i = 0; i < PUSH_RATE_MAX; i++) {
    await routes(post("/push/notify",
      { sessionId: "", body: "New message", plugin: "usage-card",
        tag: "plugin:usage-card:5 hours", kid: "k1", enc: "c" }), "/push/notify");
  }
  const over = (await routes(post("/push/notify",
    { sessionId: "", body: "New message", plugin: "usage-card",
      tag: "plugin:usage-card:5 hours", kid: "k1", enc: "c" }), "/push/notify"))!;
  expect((await over.json()).dropped).toBe(true);
  expect(sent.length).toBe(PUSH_RATE_MAX);
});

test("/push/notify log never contains title/body content, only lengths + sealedness", async () => {
  const { routes, logs } = await rig();
  const T = "MARKER-TITLE-9f3", B = "MARKER-BODY-9f3";
  await routes(post("/push/notify",
    { sessionId: "s1", title: T, body: B, kid: "k1", enc: "cipher" }), "/push/notify");
  const blob = JSON.stringify(logs);
  expect(blob).not.toContain("MARKER-TITLE-9f3");
  expect(blob).not.toContain("MARKER-BODY-9f3");
  const ev = logs.find((l) => l.event === "push.notify")!;
  expect(ev.fields).toMatchObject({ sealed: true, titleLen: T.length, bodyLen: B.length });
});

test("/push/notify: a sealed push forwards generic visible fields, sealed blob untouched", async () => {
  const { routes, sent } = await rig();
  await routes(post("/push/notify",
    { sessionId: "s1", title: "MARKER-TITLE-9f3", body: "MARKER-BODY-9f3", kid: "k1", enc: "cipher" }),
    "/push/notify");
  expect(sent[0].title).toBe("CallYourCode");
  expect(sent[0].body).toBe("New message");
  expect(sent[0].kid).toBe("k1");
  expect(sent[0].enc).toBe("cipher");
});

test("/push/notify: a keyless push still passes plaintext to devices but never to the log", async () => {
  const { routes, sent, logs } = await rig();
  await routes(post("/push/notify",
    { sessionId: "s1", title: "MARKER-TITLE-9f3", body: "MARKER-BODY-9f3" }), "/push/notify");
  // no enc: the plaintext reaches the device unchanged (legacy keyless engine)
  expect(sent[0].title).toBe("MARKER-TITLE-9f3");
  expect(sent[0].body).toBe("MARKER-BODY-9f3");
  expect(sent[0].enc).toBeUndefined();
  // but it is still never written to the log
  const ev = logs.find((l) => l.event === "push.notify")!;
  expect(ev.fields).toMatchObject({ sealed: false });
  expect(JSON.stringify(logs)).not.toContain("MARKER-");
});

test("/push/batch: items with enc are stored generic; the log holds no content", async () => {
  const { routes, store, logs } = await rig();
  await routes(post("/push/batch", { host: "h1", new: [
    { sessionId: "s1", title: "MARKER-TITLE-9f3", body: "MARKER-BODY-9f3", kid: "k", enc: "c", unread: 2 },
  ] }), "/push/batch");
  const item = store.outNew.get("s1")!;
  expect(item.title).toBe("CallYourCode");
  expect(item.body).toBe("New message");
  expect(item).toMatchObject({ kid: "k", enc: "c", count: 2 });
  expect(JSON.stringify(logs)).not.toContain("MARKER-");
});

test("/push/notify: past the per-minute cap the message drops with a plain ok", async () => {
  const { routes, sent } = await rig();
  for (let i = 0; i < PUSH_RATE_MAX; i++) {
    await routes(post("/push/notify", { sessionId: "s", body: "m" }), "/push/notify");
  }
  expect(sent.length).toBe(PUSH_RATE_MAX);
  const over = (await routes(post("/push/notify",
    { sessionId: "s", body: "m" }), "/push/notify"))!;
  expect(over.status).toBe(200);                  // never a 4xx an engine would retry into
  expect((await over.json()).dropped).toBe(true);
  expect(sent.length).toBe(PUSH_RATE_MAX);        // nothing left the building
});

test("/push/batch: items queue into the window; truncated and dropped are told apart", async () => {
  const { routes, store } = await rig();
  const fresh = Array.from({ length: BATCH_ITEMS_MAX + 50 }, (_, i) =>
    ({ sessionId: `s${i}`, title: `T${i}`, body: `B${i}`, unread: 1 }));
  const r = (await routes(post("/push/batch", { host: "h1", new: fresh }), "/push/batch"))!;
  const j = await r.json();
  // 50 cut by the per-batch cap; the rate window then keeps PUSH_RATE_MAX
  expect(j.truncated).toBe(50);
  expect(j.dropped).toBe(BATCH_ITEMS_MAX - PUSH_RATE_MAX);
  expect(j.queued).toBe(PUSH_RATE_MAX);
  expect(store.outNew.size).toBe(PUSH_RATE_MAX);
});

test("/push/batch: a dismissal removes the queued banner and joins the window", async () => {
  const { routes, store } = await rig();
  await routes(post("/push/batch",
    { host: "h1", new: [{ sessionId: "s1", title: "T", body: "B", unread: 2 }] }), "/push/batch");
  expect(store.outNew.has("s1")).toBe(true);
  expect(store.pending.get("s1")).toBe(2);
  await routes(post("/push/batch", { host: "h1", dismiss: ["s1"] }), "/push/batch");
  expect(store.outNew.has("s1")).toBe(false);
  expect(store.pending.has("s1")).toBe(false);
  expect(store.outDismiss.has("s1")).toBe(true);
});

test("/push/batch carries the sealed blob into the rebuilt OutItem", async () => {
  const { routes, store } = await rig();
  await routes(post("/push/batch", { host: "h1",
    new: [{ sessionId: "s1", title: "T", body: "B", kid: "k", enc: "c" }] }), "/push/batch");
  expect(store.outNew.get("s1")).toMatchObject({ kid: "k", enc: "c" });
});

test("/push/read: clears the count and queues the dismissal for other devices", async () => {
  const { routes, store } = await rig();
  store.pending.set("s1", 4);
  store.outNew.set("s1", { sessionId: "s1", title: "T", body: "B", count: 4 });
  const r = (await routes(post("/push/read", { sessionId: "s1" }), "/push/read"))!;
  expect((await r.json()).cleared).toBe(true);
  expect(store.pending.has("s1")).toBe(false);
  expect(store.outNew.has("s1")).toBe(false);   // read inside the window: never buzzes
  expect(store.outDismiss.has("s1")).toBe(true);
  // a chat with nothing pending answers cleared:false and queues nothing new
  const again = (await routes(post("/push/read", { sessionId: "s2" }), "/push/read"))!;
  expect((await again.json()).cleared).toBe(false);
  expect(store.outDismiss.has("s2")).toBe(false);
});

test("device routes without an owner answer 401", async () => {
  const { routes } = await rig({ device: false });
  for (const [path, method] of [["/push/subscribe", "POST"], ["/push/devices", "GET"],
    ["/push/read", "POST"], ["/push/test", "POST"]] as const) {
    const req = method === "POST" ? post(path, {}) : new Request(`http://x${path}`);
    expect((await routes(req, path))!.status).toBe(401);
  }
});
