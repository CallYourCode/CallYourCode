/* Web push, so a reply reaches you when the app is closed.
 *
 * No app store, no firebase, no apple developer account: standard Web Push
 * with a VAPID key pair generated here on first run. Safari bridges it to
 * APNs itself, but only for a page added to the home screen; Chrome and
 * Firefox take it from a tab.
 *
 * What the research said to design around (2026-07-26):
 *   - Safari revokes permission if a push arrives and the service worker
 *     shows nothing, so every push MUST produce a visible notification. The
 *     worker never filters.
 *   - Subscriptions die quietly after long inactivity. The app re-subscribes
 *     on every open, which repairs a dead one without the user noticing, and
 *     endpoints that 404/410 are dropped here.
 *   - No silent push: we cannot use this to sync in the background.
 *
 * Subscriptions live in push-subs.json under the per-user state dir
 * (bootstrap/server.ts: ~/.callyourcode/app-server) so a restart does not
 * silence every device.
 *
 * One pair, one place. This used to live in each agent engine, which could
 * not work: a browser holds ONE subscription per service worker, bound to the
 * key that created it, so engines with different pairs got 410 Gone from
 * every device but the one that happened to subscribe to them. It belongs to
 * the app server, which is the origin the browser actually talks to.
 * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY still pin the pair (useful when moving
 * hosts without re-enrolling every device); otherwise one is generated and
 * kept beside the subscriptions.
 */

import webpush from "web-push";
import { writePrivate } from "../../../engine/shared/runfiles.ts";

export type PushEvent = "push.sent" | "push.gone" | "push.fail";
export type PushLogger = (event: PushEvent, fields: Record<string, unknown>) => void;

export type PushSub = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label: string;        // which device this is, for the settings list
  added: number;
  failures: number;     // consecutive send failures; 410/404 drops immediately
  /* Which INSTALL this belongs to, from the browser's own localStorage.
   *
   * Endpoints are not device identity. iOS hands out a fresh endpoint whenever
   * the subscription is recreated, and the old one keeps working for a while,
   * so deduping by endpoint let one phone accumulate thirteen live
   * subscriptions and be pushed thirteen times per message. */
  deviceId?: string;
  lastOk?: number;   // last send this device accepted
  lastFail?: number; // last send it did not
  /* A browser a TEST opened, not a device anybody carries.
   *
   * The e2e suite subscribes for real, against this server, with real keys, so
   * a run put up to five extra subscriptions in the store beside the phone and
   * the tablet. They are indistinguishable from devices once written, they are
   * dead the moment the browser closes, and every later reply pays for a
   * pointless send to each. Marked here so they can be reaped on sight and,
   * more importantly, so a test can never replace a real device. */
  test?: boolean;
};

type Store = {
  publicKey: string;
  privateKey: string;
  subs: PushSub[];
};

// A push is a notification a human reads: the body is trimmed to something
// that fits on a lock screen rather than the whole reply.
const BODY_MAX = 180;

/* A CEILING ON ONE SEND, so a black-holed endpoint cannot strand the fan-out.
 *
 * webpush.sendNotification has no default timeout: an endpoint that completes
 * the TCP handshake and then never answers leaves its send() pending for ever.
 * The fan-out below is `Promise.all` over per-device sends, so ONE such peer
 * would leave the whole send() promise pending, and with it the engine's
 * `POST /push/notify` (and the batch flush's overlapping timers). Other clients
 * and /health are on their own async handlers and are unaffected, but a
 * request that never returns is still a leak. web-push wires this `timeout`
 * (ms) to the socket and destroys the request when it fires, which rejects the
 * send and is caught as a failure like any other. Read per-send (not once at
 * load) so the test that points at a hanging endpoint can set it after import. */
const sendTimeoutMs = () => Number(process.env.PUSH_SEND_TIMEOUT_MS ?? 10_000);

/* Naming a device in the log without printing a secret.
 *
 * An endpoint IS the capability to push to that device, and the keys are worse,
 * so neither may ever reach a log file or a screenshot. But "send failed" with
 * three devices registered, two of them labelled "iPhone Safari", was not an
 * answer to anything. A short non-reversible fingerprint of the endpoint tells
 * two same-named devices apart and stays stable across restarts, which is all
 * the log needs. The service host (apple, google) is public knowledge and says
 * whose fault a failure is. */
const fingerprint = (endpoint: string) => Bun.hash(endpoint).toString(36).slice(0, 4);
const serviceOf = (endpoint: string) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return "?";
  }
};
const deviceTag = (s: { label: string; endpoint: string; test?: boolean }) =>
  `${s.test ? "test:" : ""}${s.label || "a device"}#${fingerprint(s.endpoint)}`;

/* Subscriptions a TEST made, kept apart from devices a person carries.
 *
 * The e2e suite registers real subscriptions against this server, so a run left
 * up to five of them in the store next to the phone and the tablet, all of them
 * dead the moment the browser closed. Two rules follow, and they are the whole
 * feature:
 *
 *   - a test subscription can only ever replace another test subscription. It
 *     must never evict a device, whatever it calls itself.
 *   - it expires. A browser from a test run half an hour ago is not something
 *     to keep paying a send to, and nothing will ever unsubscribe it.
 *
 * A test says so with `test: true`, and a label or install id that starts with
 * playwright / e2e / test is taken at its word too, because the e2e suite lives
 * in the other repo and this side should not need it to change first. */
const TEST_TTL_MS = 30 * 60 * 1000;
const TEST_MAX = 4;
const TEST_NAME = /^(playwright|e2e|test)\b/i;
const looksLikeTest = (label: string, deviceId: string) =>
  TEST_NAME.test(label.trim()) || TEST_NAME.test(deviceId.trim());

/* E2E (task 527): carry the engine's sealed push blob through this server
 * UNCHANGED. Both /push/notify and /push/batch pass their incoming item through
 * here so the pass-through is one place, byte-for-byte, and tested as such. The
 * server relays what it cannot read; the caps are only sanity bounds on a
 * possibly-hostile engine's input, and a real blob stays well under them.
 *
 * ENC_MAX must clear the engine's largest LEGITIMATE seal, or it corrupts the
 * very content it forwards (#537 F1). The engine seals {title, body(<=1200
 * chars), count}: base64(iv[12] + AES-GCM(pt)). A 1200-char body of 3-byte
 * UTF-8 (CJK) is ~3600 bytes, so the base64 runs ~5.2k chars -- over the old
 * 4096 cap. The old cap silently truncated the ciphertext, AES-GCM auth then
 * failed on the device, and in require mode the plaintext is only the generic
 * "New message", so the real preview was LOST. 8192 clears the worst case
 * (~5.7k with a long title) with margin while still bounding a hostile blob. */
const ENC_MAX = 8192;
export function carrySealed(src: any): { kid?: string; enc?: string } {
  const out: { kid?: string; enc?: string } = {};
  if (typeof src?.kid === "string") out.kid = src.kid.slice(0, 128);
  if (typeof src?.enc === "string") out.enc = src.enc.slice(0, ENC_MAX);
  return out;
}

export class Push {
  private file: string;
  private store: Store;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private sent = new Map<string, number>();
  private latestId = "";

  private constructor(file: string, store: Store, private logEvent?: PushLogger) {
    this.file = file;
    this.store = store;
    webpush.setVapidDetails(
      // Apple validates this: a mailto at a made-up domain
      // ("push@callyourcode.local") was rejected with BadJwtToken while
      // Chrome accepted the very same token, so the iPhone got nothing. It
      // must be a real https origin or a reachable mailto.
      process.env.VAPID_SUBJECT ?? "https://callyourcode.com",
      store.publicKey,
      store.privateKey,
    );
  }

  static async open(file: string, logEvent?: PushLogger): Promise<Push> {
    let store: Store | null = null;
    try {
      store = await Bun.file(file).json();
    } catch {
      store = null;
    }
    // env wins, so a fleet can be pinned to one pair without editing files
    const envPub = process.env.VAPID_PUBLIC_KEY?.trim();
    const envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
    if (envPub && envPriv) {
      if (store && (store.publicKey !== envPub || store.privateKey !== envPriv)) {
        // the pair changed under us: every stored subscription was made
        // against the old key and can only fail, so start clean rather than
        // spend eight failures per device discovering that.
        console.log("[push] VAPID pair changed, dropping subscriptions made with the old one");
        store = { publicKey: envPub, privateKey: envPriv, subs: [] };
      } else {
        store = {
          publicKey: envPub, privateKey: envPriv,
          subs: store?.subs ?? [],
        };
      }
      await writePrivate(file, JSON.stringify(store, null, 2));
    } else if (!store?.publicKey || !store?.privateKey) {
      const keys = webpush.generateVAPIDKeys();
      store = { publicKey: keys.publicKey, privateKey: keys.privateKey, subs: [] };
      await writePrivate(file, JSON.stringify(store, null, 2));
      console.log("[push] generated a VAPID key pair. EVERY engine must use this same pair:");
      console.log(`[push]   VAPID_PUBLIC_KEY=${keys.publicKey}`);
      console.log(`[push]   VAPID_PRIVATE_KEY=${keys.privateKey}`);
    }
    store.subs ??= [];
    delete (store as Store & { quiet?: unknown }).quiet;
    return new Push(file, store, logEvent);
  }

  /** The app server joins a device's shown receipt to this in-memory send row. */
  sentAt(id: string): number | undefined {
    return this.sent.get(id);
  }

  get lastSentId(): string {
    return this.latestId;
  }

  get publicKey() {
    return this.store.publicKey;
  }

  get count() {
    return this.store.subs.length;
  }

  /* What the settings list shows, and what a push question is answered with.
   *
   * `id` is the same short fingerprint the log prints, so a line about
   * "iPhone Safari#a3k1" can be tied to a row here without ever printing the
   * endpoint. lastOk / lastFail are what distinguish a live device from a
   * leftover of a reinstall that will fail silently for ever. */
  list() {
    return this.store.subs.map((s) => ({
      endpoint: s.endpoint,
      id: fingerprint(s.endpoint),
      label: s.label,
      added: s.added,
      service: serviceOf(s.endpoint),
      failures: s.failures,
      ...(s.lastOk ? { lastOk: s.lastOk } : {}),
      ...(s.lastFail ? { lastFail: s.lastFail } : {}),
      ...(s.test ? { test: true } : {}),
    }));
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void writePrivate(this.file, JSON.stringify(this.store, null, 2));
    }, 200);
  }

  // Idempotent: the app re-subscribes on every open (that is how a dead
  // subscription silently repairs), so the same endpoint must not pile up.
  subscribe(
    sub: { endpoint: string; keys?: { p256dh?: string; auth?: string } },
    label: string,
    deviceId = "",
    isTest = false,
  ): boolean {
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return false;
    const test = isTest || looksLikeTest(label, deviceId);

    this.reapTests("a new subscription arrived");

    /* One subscription per install. A device that re-subscribes REPLACES what
     * it had, rather than adding to it. Measured before this: 13 live
     * subscriptions for one iPhone, so every reply was pushed to it 13 times.
     *
     * Legacy rows carry no deviceId. A device claiming an id also claims the
     * idless rows that share its label, which is how the pile clears itself
     * the first time each device opens the app. Two phones with the same label
     * would briefly cost the second one its subscription; it re-subscribes on
     * open, so it repairs itself.
     *
     * Eviction never crosses the test line, in either direction. A test browser
     * that happened to call itself what a real device calls itself could
     * otherwise take that device's notifications away, and the only symptom
     * would be a phone that went quiet during a test run. */
    if (deviceId) {
      const before = this.store.subs.length;
      this.store.subs = this.store.subs.filter((s) =>
        s.endpoint === sub.endpoint ||
        Boolean(s.test) !== test ||
        (s.deviceId ? s.deviceId !== deviceId : s.label !== label));
      const dropped = before - this.store.subs.length;
      if (dropped) console.log(`[push] ${label}: replaced ${dropped} older subscription(s)`);
    }

    const existing = this.store.subs.find((s) => s.endpoint === sub.endpoint);
    if (existing) {
      existing.keys = { p256dh: sub.keys.p256dh, auth: sub.keys.auth };
      existing.label = label || existing.label;
      existing.failures = 0;
      if (deviceId) existing.deviceId = deviceId;
      if (test) existing.test = true;
      else delete existing.test;
    } else {
      this.store.subs.push({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        label: label || "a device",
        added: Date.now(),
        failures: 0,
        ...(deviceId ? { deviceId } : {}),
        ...(test ? { test: true } : {}),
      });
      console.log(`[push] + ${deviceTag({ label, endpoint: sub.endpoint, test })}` +
        ` (${serviceOf(sub.endpoint)}, ${this.store.subs.length} total` +
        `${test ? `, ${this.store.subs.filter((s) => s.test).length} of them tests` : ""})`);
    }
    // A test run should not be able to grow the store without limit even
    // inside its own half: keep the newest few and forget the rest.
    const tests = this.store.subs.filter((s) => s.test);
    if (tests.length > TEST_MAX) {
      const doomed = new Set(tests.sort((a, b) => b.added - a.added).slice(TEST_MAX));
      this.store.subs = this.store.subs.filter((s) => !doomed.has(s));
      console.log(`[push] reaped ${doomed.size} test subscription(s) over the cap of ${TEST_MAX}`);
    }
    this.save();
    return true;
  }

  /* Forget test subscriptions. Called before every send and on every subscribe,
   * and exposed as POST /push/reap-tests so a suite can clean up after itself.
   * Returns how many went. */
  reapTests(why: string, all = false): number {
    const now = Date.now();
    const stale = this.store.subs.filter((s) =>
      s.test && (all || now - s.added > TEST_TTL_MS));
    if (!stale.length) return 0;
    const doomed = new Set(stale);
    this.store.subs = this.store.subs.filter((s) => !doomed.has(s));
    console.log(`[push] reaped ${doomed.size} test subscription(s) (${why}): ` +
      stale.map((s) => deviceTag(s)).join(", "));
    this.save();
    return doomed.size;
  }

  unsubscribe(endpoint: string): boolean {
    const before = this.store.subs.length;
    const gone = this.store.subs.find((s) => s.endpoint === endpoint);
    this.store.subs = this.store.subs.filter((s) => s.endpoint !== endpoint);
    if (this.store.subs.length === before) return false;
    console.log(`[push] - ${gone ? deviceTag(gone) : "a device"} (${this.store.subs.length} total)`);
    this.save();
    return true;
  }

  private drop(endpoint: string, why: string) {
    /* Say WHICH device, and where its endpoint lived.
     *
     * "dropped a dead subscription (http 410)" was true and useless: with an
     * iPhone, an iPad and an Android tablet registered, it did not say which
     * one had stopped working, and an Android tablet quietly losing its
     * notifications looked identical in the log to normal housekeeping. */
    const gone = this.store.subs.find((s) => s.endpoint === endpoint);
    this.store.subs = this.store.subs.filter((s) => s.endpoint !== endpoint);
    console.log(`[push] dropped ${gone ? deviceTag(gone) : "a device"} (${why}, ${serviceOf(endpoint)}` +
      `${gone?.lastOk ? `, last ok ${new Date(gone.lastOk).toISOString()}` : ", never worked"})`);
    this.save();
  }

  /* Fan out to every device. Failures are per-endpoint: one dead phone must
   * not stop the laptop being told.
   *
   * Every send says what happened to EACH device, in one line. Before this the
   * app server logged subscribes and unsubscribes and never a send, so the only
   * way to find out whether a device had stopped receiving was to buzz a real
   * phone and watch it. A device that is quietly failing is now visible without
   * reading Google's or Apple's response by hand. */
  async send(payload: {
    title: string;
    body: string;
    sessionId: string;
    /* An engine-level push's raising PLUGIN id (what sessionId is to a session
     * push): opaque routing/dedup metadata relayed to the device untouched. */
    plugin?: string;
    tag?: string;
    count?: number;   // messages waiting in that chat, for the merged banner
    dismiss?: boolean; // close it everywhere: you read it somewhere else
    badge?: number;    // chats waiting, for the home screen icon
    /* The session's avatar, when the engine can name a URL the OS can fetch
     * (iOS web push fetches the icon itself). Absent/null = the worker keeps
     * the app logo. */
    icon?: string | null;
    /* ONE PUSH, EVERY SESSION. The worker applies the
     * dismissals first and then shows what is new, and it can only get that
     * order right if both arrive together. Riding on the same fan-out as every
     * other push: there is one way out of this server to a device. */
    t?: "batch" | "notify" | "dismiss";
    sessions?: Array<{ sessionId: string; title: string; body: string; count: number;
      icon?: string | null;
      kid?: string; enc?: string }>;
    dismissed?: string[];
    /* E2E (task 527): an opaque, sealed {title,body,count} the worker decrypts
     * with the key for `kid`. This server relays it and cannot read it; the
     * plaintext title/body above are the generic fallback for an old worker or
     * an unpaired device. */
    kid?: string;
    enc?: string;
  }, kind = payload.t === "batch" ? "batch" : payload.dismiss ? "dismiss" : "notify"): Promise<boolean> {
    const what = `${kind} ${payload.sessionId || "(no chat)"}`;
    // A browser from a test run an hour ago is not a device; paying a send to
    // it (and a line in the log about its failure) helps nobody.
    this.reapTests("expired before a send");
    if (!this.store.subs.length) {
      // The answer to "why did nothing arrive" is sometimes just this.
      console.log(`[push] ${what} -> NO DEVICES registered`);
      return false;
    }
    // One id describes one fan-out, so every device receives a payload the
    // service worker can report back to the same send row.
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const sendAt = Date.now();
    this.sent.set(id, sendAt);
    this.latestId = id;
    // Retain enough recent rows to cover an offline phone waking later without
    // turning telemetry into an unbounded in-memory history.
    const oldest = sendAt - 24 * 60 * 60 * 1000;
    for (const [oldId, oldAt] of this.sent) if (oldAt < oldest || this.sent.size > 10_000) this.sent.delete(oldId);
    const data = JSON.stringify({
      ...payload,
      id,
      t: kind === "batch" ? "batch" : kind === "dismiss" ? "dismiss" : "notify",
      sendAt,
      body: payload.body.length > BODY_MAX ? payload.body.slice(0, BODY_MAX - 1) + "…" : payload.body,
    });
    this.logEvent?.("push.sent", { id, kind, session: payload.sessionId, sendAt, devices: this.store.subs.length });
    const at = sendAt;
    const outcomes: string[] = [];
    let ok = 0;
    await Promise.all(
      this.store.subs.slice().map(async (s) => {
        // Dismissals used to skip Apple, on the reasoning that a push showing
        // nothing costs you the permission. That was true of the first
        // version of the worker; it no longer is. The worker now answers a
        // dismissal on iOS by showing "Read on another device" instead of
        // showing nothing, so the rule is satisfied and the stale banner
        // actually goes.
        //
        // The cost of the old behaviour was that the iPhone was the one device
        // whose banners never cleared: you would read a chat on the tablet and
        // the phone would still be claiming it was unread. Reported as exactly
        // that.
        const one = Date.now();
        try {
          /* The `timeout` option asks web-push to destroy the socket on Node,
           * but under Bun's node:https shim the socket 'timeout' event it hangs
           * that on does not fire, so a black-holed endpoint would stay pending
           * for ever and strand this whole `Promise.all`. The race is the
           * runtime-independent backstop: whichever settles first wins, and the
           * deadline REJECTS so it is caught below as a failure like any other.
           * (The socket may linger on Bun; the fan-out does not.) */
          const ms = sendTimeoutMs();
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              webpush.sendNotification(
                { endpoint: s.endpoint, keys: s.keys },
                data,
                // urgency high: a person waiting on a reply, not a digest
                { TTL: 3600, urgency: "high", timeout: ms },
              ),
              new Promise((_, reject) => {
                deadline = setTimeout(() => reject(new Error(`send timed out after ${ms}ms`)), ms);
              }),
            ]);
          } finally {
            if (deadline) clearTimeout(deadline);
          }
          s.failures = 0;
          /* When this device was last KNOWN good. Two subscriptions labelled
           * the same (one of them left over from a reinstall) are otherwise
           * impossible to tell apart, and the stale one fails silently for
           * ever. This is the evidence for reaping the right one. */
          s.lastOk = Date.now();
          ok += 1;
          outcomes.push(`${deviceTag(s)} ok ${Date.now() - one}ms`);
        } catch (e: any) {
          const code = e?.statusCode;
          s.lastFail = Date.now();
          // 404/410 = the push service says this endpoint is gone for good
          if (code === 404 || code === 410) {
            const reason = `http ${code}`;
            this.logEvent?.("push.gone", { id, kind, reason, device: deviceTag(s) });
            outcomes.push(`${deviceTag(s)} http ${code} DROPPED`);
            return this.drop(s.endpoint, reason);
          }
          const reason = String(code ?? e?.message ?? "send failed").slice(0, 200);
          this.logEvent?.("push.fail", { id, kind, reason, device: deviceTag(s) });
          s.failures += 1;
          outcomes.push(
            `${deviceTag(s)} FAILED ${code ?? e?.message} (${s.failures} in a row, ${serviceOf(s.endpoint)})`,
          );
          // a subscription that has failed repeatedly is dead in practice
          if (s.failures >= 8) this.drop(s.endpoint, "8 consecutive failures");
          this.save();
        }
      }),
    );
    const total = outcomes.length;
    console.log(
      `[push] ${what} -> ${outcomes.join(", ")} ` +
      `(${ok}/${total} ok, ${payload.body.length} chars` +
      `${payload.count ? `, waiting=${payload.count}` : ""}` +
      `${payload.badge !== undefined ? `, badge=${payload.badge}` : ""}, ${Date.now() - at}ms)`,
    );
    this.save(); // lastOk / lastFail are the evidence for reaping a stale device
    return true;
  }
}
