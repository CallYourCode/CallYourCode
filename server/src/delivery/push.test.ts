/* Push fan-out, against a real (local) push service.
 *
 * The part that matters is not "did we call a library": it is that EVERY
 * registered device is attempted, that one dead phone cannot stop the laptop
 * being told, and that a device the service says is gone is forgotten rather
 * than retried forever. So this runs the actual encryption and the actual
 * HTTP POST against a server that answers like Google's does, including a
 * 410 Gone.
 *
 * The subscriptions carry genuine P-256 keys, because web-push encrypts
 * before it posts: fake keys would fail earlier than the behaviour under test.
 *
 *   bun test agent-engine/src/push.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { Push, carrySealed } from "./push";

// self-signed, generated at load: web-push refuses plain http, and a real
// certificate is not the thing under test
const { cert: TEST_CERT, key: TEST_KEY } = await (async () => {
  const dir = `/tmp/cyc-push-cert-${process.pid}`;
  await Bun.$`mkdir -p ${dir}`.quiet();
  await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days 1 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1`.quiet();
  return { cert: await Bun.file(`${dir}/c.pem`).text(), key: await Bun.file(`${dir}/k.pem`).text() };
})();

// our own CA is not in the trust store, and this is a loopback server we
// created ourselves in this process
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const tmpFiles: string[] = [];
const tmpFile = () => {
  const f = `/tmp/cyc-push-test-${crypto.randomUUID()}.json`;
  tmpFiles.push(f);
  return f;
};
afterEach(async () => {
  await Promise.all(tmpFiles.splice(0).map((f) => rm(f, { force: true })));
});

// a subscription the way a browser makes one: an uncompressed P-256 public
// key and a 16-byte auth secret, both base64url
async function realSubscription(endpoint: string) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const b64url = (b: Uint8Array) =>
    btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { endpoint, keys: { p256dh: b64url(raw), auth: b64url(auth) } };
}

// answers like a push service: /ok accepts, /gone says the device is history.
// TLS, because that is what web-push talks to in production and what its HTTP
// client is happy with; the cert is self-signed and trusted for this test only.
function fakePushService() {
  const hits: string[] = [];
  const payloads: any[] = [];
  const server = Bun.serve({
    port: 0,
    tls: {cert: TEST_CERT, key: TEST_KEY},
    async fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push(path);
      // a real service requires a body and the VAPID authorization header
      const body = await req.arrayBuffer();
      if (!body.byteLength) return new Response("no payload", { status: 400 });
      try { payloads.push(JSON.parse(new TextDecoder().decode(body))); } catch { /* encrypted transport is not JSON */ }
      if (!req.headers.get("authorization")) return new Response("no vapid", { status: 401 });
      if (path.startsWith("/gone")) return new Response("gone", { status: 410 });
      return new Response("", { status: 201 });
    },
  });
  return { hits, payloads, url: `https://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

test("carrySealed relays kid/enc byte-for-byte and drops everything else", () => {
  // a realistic sealed blob: base64 of iv||gcm, hundreds of chars
  const enc = "AAAA" + "abcDEF012+/".repeat(60) + "==";
  const item = { sessionId: "probe:w1:p1", title: "CallYourCode", body: "New message",
    unread: 3, kid: "qJOXzkjTDEo", enc, junk: "should not survive" };
  const carried = carrySealed(item);
  // the blob comes through unchanged
  expect(carried.enc).toBe(enc);
  expect(carried.kid).toBe("qJOXzkjTDEo");
  // and nothing else the engine sent rides along through this helper
  expect(Object.keys(carried).sort()).toEqual(["enc", "kid"]);
});

test("carrySealed omits the fields when absent and caps a hostile blob", () => {
  expect(carrySealed({ sessionId: "s" })).toEqual({});
  expect(carrySealed({ kid: 42, enc: {} })).toEqual({}); // non-strings ignored
  const huge = "x".repeat(20_000);
  expect(carrySealed({ enc: huge }).enc!.length).toBe(8192);
  expect(carrySealed({ kid: "k".repeat(500) }).kid!.length).toBe(128);
});

test("carrySealed relays a worst-case real seal whole (the #537 F1 cap)", () => {
  /* The engine seals {title, body(<=1200 chars), count}: base64(iv||gcm). A
   * 1200-char CJK body is ~3600 bytes, so the base64 runs ~5.2k chars. The old
   * 4096 cap truncated exactly that -- a real, decryptable preview -- so the
   * device's AES-GCM auth failed and (in require mode) it showed only the
   * generic fallback. A legitimate blob at that size must now pass untouched. */
  const realWorstCase = "Q".repeat(5200); // stands in for the base64 of a full CJK preview
  expect(realWorstCase.length).toBeGreaterThan(4096); // would have been cut before
  expect(carrySealed({ enc: realWorstCase }).enc).toBe(realWorstCase);
});

test("a payload carrying enc still fans out to devices", async () => {
  const svc = fakePushService();
  try {
    const push = await Push.open(tmpFile());
    push.subscribe(await realSubscription(`${svc.url}/ok/phone`), "phone");
    // enc rides on the payload; push.send spreads it into the encrypted data
    const ok = await push.send({ title: "CallYourCode", body: "New message",
      sessionId: "probe:w1:p1", count: 2, ...carrySealed({ kid: "abc", enc: "sealedblob" }) });
    expect(ok).toBe(true);
    expect(svc.hits.some((h) => h.startsWith("/ok"))).toBe(true);
  } finally {
    svc.stop();
  }
});

test("every registered device is attempted, and a dead one is forgotten", async () => {
  const svc = fakePushService();
  try {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const push = await Push.open(tmpFile(), (event, fields) => events.push({ event, fields }));
    const good = await realSubscription(`${svc.url}/ok/phone`);
    const dead = await realSubscription(`${svc.url}/gone/old-tablet`);
    expect(push.subscribe(good, "phone")).toBe(true);
    expect(push.subscribe(dead, "old tablet")).toBe(true);
    expect(push.count).toBe(2);

    await push.send({ title: "vector", body: "the run finished", sessionId: "ws|w9:p9" });

    // both were tried: a dead device does not shadow a live one
    expect(svc.hits.some((h) => h.startsWith("/ok"))).toBe(true);
    expect(svc.hits.some((h) => h.startsWith("/gone"))).toBe(true);
    // and only the dead one is gone
    expect(push.count).toBe(1);
    expect(push.list()[0].label).toBe("phone");
    const sent = events.find((e) => e.event === "push.sent")!;
    expect(typeof sent.fields.id).toBe("string");
    expect(push.sentAt(String(sent.fields.id))).toBe(Number(sent.fields.sendAt));
    const gone = events.find((e) => e.event === "push.gone")!;
    expect(gone.fields.id).toBe(sent.fields.id);
    expect(gone.fields.reason).toBe("http 410");
  } finally {
    svc.stop();
  }
});

test("a device that merely errors is kept, not dropped", async () => {
  // 500 is the push service having a bad minute; forgetting the device would
  // silently stop notifying it forever
  const server = Bun.serve({
    port: 0,
    tls: { cert: TEST_CERT, key: TEST_KEY },
    fetch: () => new Response("nope", { status: 500 }),
  });
  try {
    const push = await Push.open(tmpFile());
    push.subscribe(await realSubscription(`https://127.0.0.1:${server.port}/x`), "phone");
    await push.send({ title: "t", body: "b", sessionId: "s" });
    expect(push.count).toBe(1);
  } finally {
    server.stop(true);
  }
});

/* NETGATE sweep #536: an endpoint that ACCEPTS the connection and then never
 * answers must not strand the fan-out. Without the per-send `timeout` the
 * webpush send() to /hang stays pending for ever, so `Promise.all` never
 * settles and the caller's `POST /push/notify` hangs. With it, the hung send
 * fails fast, the live device is still notified, and send() returns. */
test("a hanging endpoint fails fast and never stalls the fan-out", async () => {
  // /ok answers 201; /hang accepts the request and never responds.
  const server = Bun.serve({
    port: 0,
    tls: { cert: TEST_CERT, key: TEST_KEY },
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = await req.arrayBuffer();
      if (!body.byteLength) return new Response("no payload", { status: 400 });
      if (path.startsWith("/hang")) return new Promise<Response>(() => {}); // never resolves
      return new Response("", { status: 201 });
    },
  });
  const prev = process.env.PUSH_SEND_TIMEOUT_MS;
  process.env.PUSH_SEND_TIMEOUT_MS = "600";
  try {
    const push = await Push.open(tmpFile());
    const live = await realSubscription(`https://127.0.0.1:${server.port}/ok/phone`);
    const wedged = await realSubscription(`https://127.0.0.1:${server.port}/hang/tablet`);
    expect(push.subscribe(live, "phone")).toBe(true);
    expect(push.subscribe(wedged, "wedged tablet")).toBe(true);

    const t0 = Date.now();
    const ok = await push.send({ title: "t", body: "b", sessionId: "s" });
    const took = Date.now() - t0;

    // the fan-out returned instead of hanging, and well within a hung window
    expect(took).toBeLessThan(4000);
    // the live device was notified: one wedged peer did not shadow it
    expect(ok).toBe(true);
    // a timeout is an error, not a 410, so the wedged device is KEPT (like a 500)
    expect(push.count).toBe(2);
  } finally {
    if (prev === undefined) delete process.env.PUSH_SEND_TIMEOUT_MS;
    else process.env.PUSH_SEND_TIMEOUT_MS = prev;
    server.stop(true);
  }
});

test("re-subscribing the same endpoint updates it instead of duplicating", async () => {
  // the app re-posts its subscription on every open: that is the repair path
  const push = await Push.open(tmpFile());
  const sub = await realSubscription("https://push.example.invalid/same");
  push.subscribe(sub, "phone");
  push.subscribe(sub, "phone renamed");
  expect(push.count).toBe(1);
  expect(push.list()[0].label).toBe("phone renamed");
});

test("a subscription without keys is refused", async () => {
  const push = await Push.open(tmpFile());
  expect(push.subscribe({ endpoint: "https://push.example.invalid/x" } as any, "bad")).toBe(false);
  expect(push.count).toBe(0);
});

/* Playwright registers REAL subscriptions against this server, so a test run
 * and a phone were competing for the same store. These three are the rules that
 * keep a test out of a device's way. */
test("a test subscription can never replace a device, even with the same name", async () => {
  const push = await Push.open(tmpFile());
  const phone = await realSubscription("https://push.example.invalid/real-phone");
  push.subscribe(phone, "Chrome", "install-phone");
  // a headless browser calling itself exactly what the real device calls itself
  push.subscribe(await realSubscription("https://push.example.invalid/ci-1"), "Chrome", "playwright-run-1");
  expect(push.count).toBe(2);
  expect(push.list().some((d) => d.label === "Chrome" && !d.test)).toBe(true);
  // and it does not accumulate either: the next run replaces the last one
  push.subscribe(await realSubscription("https://push.example.invalid/ci-2"), "Chrome", "playwright-run-1");
  expect(push.list().filter((d) => d.test).length).toBe(1);
  expect(push.list().filter((d) => !d.test).length).toBe(1);
});

test("test subscriptions are reapable, and reaping never takes a device", async () => {
  const push = await Push.open(tmpFile());
  push.subscribe(await realSubscription("https://push.example.invalid/phone"), "iPhone Safari", "install-phone");
  push.subscribe(await realSubscription("https://push.example.invalid/t1"), "e2e chromium", "e2e-1");
  push.subscribe(await realSubscription("https://push.example.invalid/t2"), "anything", "", true);
  expect(push.count).toBe(3);
  expect(push.reapTests("test", true)).toBe(2);
  expect(push.count).toBe(1);
  expect(push.list()[0].label).toBe("iPhone Safari");
});

test("a run cannot fill the store with test subscriptions", async () => {
  const push = await Push.open(tmpFile());
  push.subscribe(await realSubscription("https://push.example.invalid/phone"), "iPad", "install-ipad");
  for (let i = 0; i < 9; i++) {
    // a fresh install id each time: five browser contexts in one run looked
    // exactly like this
    push.subscribe(await realSubscription(`https://push.example.invalid/ci-${i}`), "playwright", `run-${i}`);
  }
  expect(push.list().filter((d) => d.test).length).toBeLessThanOrEqual(4);
  expect(push.list().filter((d) => !d.test).length).toBe(1);
});

test("devices survive a restart", async () => {
  const file = tmpFile();
  const first = await Push.open(file);
  first.subscribe(await realSubscription("https://push.example.invalid/keepme"), "laptop");
  await Bun.sleep(300); // the save is debounced
  const second = await Push.open(file);
  expect(second.count).toBe(1);
  expect(second.publicKey).toBe(first.publicKey); // and so does the key pair
});

test("every engine can be pinned to one key pair, and changing it clears stale devices", async () => {
  // A browser holds ONE subscription, bound to the key that created it, so
  // engines that sign with different pairs cannot both reach the same device.
  const file = tmpFile();
  const a = await Push.open(file);
  const shared = a.publicKey;

  process.env.VAPID_PUBLIC_KEY = shared;
  process.env.VAPID_PRIVATE_KEY = JSON.parse(await Bun.file(file).text()).privateKey;
  try {
    const b = await Push.open(tmpFile()); // a second "engine"
    expect(b.publicKey).toBe(shared);     // same key: one subscription reaches both

    // now the pair changes under an engine that still holds old subscriptions
    a.subscribe(await realSubscription("https://push.example.invalid/old"), "phone");
    await Bun.sleep(300);
    // generate the new pair with the env UNSET, or it just inherits the pinned
    // one and the rotation never happens
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    const otherFile = tmpFile();
    const fresh = (await Push.open(otherFile)).publicKey;
    process.env.VAPID_PUBLIC_KEY = fresh;
    process.env.VAPID_PRIVATE_KEY = JSON.parse(await Bun.file(otherFile).text()).privateKey;
    const rotated = await Push.open(file);
    expect(rotated.publicKey).toBe(fresh);
    expect(rotated.count).toBe(0); // those subscriptions could only have failed
  } finally {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  }
});

/* The quiet list is gone. Notify decisions live on the engine. These tests
 * assert that leftover quiet[] on disk is not honoured, and that dismiss
 * still leaves. */
async function seedQuiet(file: string, ids: string[]) {
  const j = JSON.parse(await Bun.file(file).text()) as { quiet?: string[] };
  j.quiet = ids;
  await Bun.write(file, JSON.stringify(j, null, 2));
}

test("a leftover quiet list does not suppress a notify", async () => {
  const svc = fakePushService();
  try {
    const file = tmpFile();
    const first = await Push.open(file);
    first.subscribe(await realSubscription(`${svc.url}/ok/phone`), "phone");
    await Bun.sleep(300);
    await seedQuiet(file, ["ws|w9:p14"]);

    const push = await Push.open(file);
    expect((push as { quiet?: unknown }).quiet).toBeUndefined();
    expect((push as { notifyOff?: unknown }).notifyOff).toBeUndefined();
    expect((push as { setSessionNotify?: unknown }).setSessionNotify).toBeUndefined();

    const sent = await push.send({ title: "busy", body: "still going", sessionId: "ws|w9:p14" });
    expect(sent, "leftover quiet still silenced a notify").toBe(true);
    expect(svc.hits.length).toBe(1);
  } finally {
    svc.stop();
  }
});

test("a leftover quiet list is not honoured after a restart", async () => {
  const file = tmpFile();
  await Push.open(file);
  await Bun.sleep(300);
  await seedQuiet(file, ["ws|w9:p14"]);

  const after = await Push.open(file);
  expect((after as { quiet?: unknown }).quiet).toBeUndefined();
  expect((after as { notifyOff?: unknown }).notifyOff).toBeUndefined();
});

test("a dismissal still goes out", async () => {
  const svc = fakePushService();
  try {
    const file = tmpFile();
    const first = await Push.open(file);
    first.subscribe(await realSubscription(`${svc.url}/ok/phone`), "phone");
    await Bun.sleep(300);
    await seedQuiet(file, ["ws|w9:p14"]);
    const push = await Push.open(file);
    const ok = await push.send(
      { title: "", body: "", sessionId: "ws|w9:p14", dismiss: true },
    );
    expect(ok, "a dismissal could not clear a stale banner").toBe(true);
    expect(svc.hits.length).toBe(1);
  } finally {
    svc.stop();
  }
});

test("one batch is ONE send to each device, carrying every session", async () => {
  /* Three chats across two engines moved in the same
   * ten seconds; the phone must buzz once, not three times, and the payload has
   * to carry the dismissals alongside the new messages so the worker can apply
   * them in order. */
  const svc = fakePushService();
  try {
    const push = await Push.open(tmpFile());
    push.subscribe(await realSubscription(`${svc.url}/ok/phone`), "phone");
    push.subscribe(await realSubscription(`${svc.url}/ok/tablet`), "tablet");
    const ok = await push.send({
      t: "batch",
      title: "example", body: "the run finished", sessionId: "example:w1:p1", tag: "example:w1:p1",
      sessions: [
        { sessionId: "example:w1:p1", title: "example", body: "the run finished", count: 2 },
        { sessionId: "work:w3:p2", title: "work", body: "deployed", count: 1 },
      ],
      dismissed: ["linux:w2:p9"],
      badge: 3,
    });
    expect(ok).toBe(true);
    // two devices, one push each: the batching is what stops three buzzes
    expect(svc.hits.length).toBe(2);
  } finally {
    svc.stop();
  }
});

test("a leftover quiet list does not silence a batch", async () => {
  const svc = fakePushService();
  try {
    const file = tmpFile();
    const first = await Push.open(file);
    first.subscribe(await realSubscription(`${svc.url}/ok/phone`), "phone");
    await Bun.sleep(300);
    await seedQuiet(file, ["example:w1:p1"]);
    const push = await Push.open(file);
    const ok = await push.send({
      t: "batch",
      title: "example", body: "quiet chat", sessionId: "example:w1:p1",
      sessions: [{ sessionId: "work:w3:p2", title: "work", body: "deployed", count: 1 }],
      dismissed: [],
    });
    expect(ok, "leftover quiet silenced a batch").toBe(true);
    expect(svc.hits.length).toBe(1);
  } finally {
    svc.stop();
  }
});
