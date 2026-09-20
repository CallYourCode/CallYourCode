/* NOTIFY (L3 feature): watched-detection with proof-of-life, sealed device
 * push, the 10s wall-aligned batch and the ten-minute ceiling (engine ->
 * app-server). The presence question itself ("is he at the
 * app") and the 30s away/grace clock live in presence.ts; this module asks
 * appConnected/isAway and presence calls back through its onAway seam.
 *
 * The sealed-wire rule: the real title/body/count ride ONLY inside `enc`
 * under the per-session key; the wire always carries the generic fallback
 * text, and a failed seal sends NOTHING, never plaintext (task 527 /
 * push-plaintext round 2).
 *
 *   bun test agent-engine/src/chat/notify-unit.test.ts
 */

import { unreadOf, markRead, filedAndQuiet } from "../sessions/readstate.ts";
import { scheduleHeardSave, settingsOf, type Session } from "../sessions/session-state.ts";
import { send } from "../transport/wire.ts";
import { appConnected, isAway, BEAT_ASSUMED_MS, BEAT_SLACK_MS, graceMs } from "../sessions/presence.ts";
import { realClock, type Clock } from "../runtime/clock.ts";
import type { Sock } from "../transport/sock.ts";

export type NotifyDeps = {
  clients(): Set<Sock>;
  sessions(): Iterable<Session>;
  broadcastSessions(): void;
  engineHost: string;
  appServerUrl: string;
  /** the enrolled engine token (announce.ensureEnrolled): the PUSH paths use
   *  this, since a push without the token would be refused anyway */
  token(): Promise<string>;
  /** the current token or "", with NO enrol side effect (announce.peekToken):
   *  the settings poll uses this, exactly as the old code read the stored
   *  token variable -- a local/tokenless engine polls /settings bare and never
   *  has an enrol attempt forced by a settings read */
  peekToken(): string;
  dropToken(why: string): void;
  /** seal a push preview under the per-session key (sealpush.ts over the E2E state) */
  seal(sessionId: string, title: string, body: string, count: number): Promise<{ kid: string; enc: string } | null>;
  /** seal a SESSION-LESS engine-level preview under the ENGINE notify key
   *  (sealpush.sealEngineItem): a plan-usage alert is about the account, not a
   *  chat. Same null-means-cannot-seal contract as `seal`. */
  sealEngine(title: string, body: string, open?: string): Promise<{ kid: string; enc: string } | null>;
  sessionPushTitle(s: Session): string;
  /* THE ONE TIME SEAM, the same one presence.ts takes. Almost everything this
   * module decides is a clock: a ten second batch window aligned to the wall,
   * a ten minute ceiling swept every fifteen seconds, a thirteen second
   * proof-of-life wait. Production leaves this undefined and gets realClock,
   * which is Date.now and the global timers, so the behaviour is byte-identical
   * to what it was before the seam existed. A test passes manualClock() and the
   * whole ladder costs one advance() with no sleeping: notify.test.ts alone used
   * to spend SEVENTY-TWO SECONDS in Bun.sleep waiting out windows for decisions
   * this module made in the first millisecond. */
  clock?: Clock;
};

let cfg: NotifyDeps | null = null;
/* Read through a module-level binding rather than off cfg on every use: the
 * exported helpers (msToBoundary's caller, startSilence, sweepCeiling) can run
 * with the deps present, and a default that is live means an unwired module
 * still reads the wall clock rather than throwing. */
let clk: Clock = realClock;
export function initNotify(d: NotifyDeps): void {
  cfg = d;
  clk = d.clock ?? realClock;
  void refreshHostedSettings();
}
const C = (): NotifyDeps => {
  if (!cfg) throw new Error("notify not initialised");
  return cfg;
};

/** Wait `ms` of LOGICAL time. Under realClock this is exactly what Bun.sleep(ms)
 *  was (one timer, one resolved promise); under a manual clock it is one
 *  advance() away and nothing sleeps. The proof-of-life wait below is the only
 *  caller, and it is the reason a frozen-page test used to cost 13 real seconds. */
function nap(ms: number): Promise<void> {
  return new Promise<void>((res) => { clk.setTimeout(() => res(), ms); });
}

/** TEST ONLY: cancel the batch and ceiling timers, drop the queued window and
 *  the cached hosted settings, and forget the deps, so a second in-process
 *  wiring does not fire the first one's window at the first one's push sink
 *  (which is by then a stopped server on a port nobody is listening on). No-op
 *  in production, which never re-wires. */
export function resetForTest(): void {
  /* Cancelled through the clock that ARMED them, before the clock goes back to
   * the real one: clearing a manual clock's timer with the global clearTimeout
   * would leave it armed, and the next advance() in that worker would fire the
   * previous wiring's window at a push sink that is by then a stopped server. */
  if (batchTimer) clk.clearTimeout(batchTimer);
  batchTimer = null;
  if (ceilingTimer) clk.clearInterval(ceilingTimer);
  ceilingTimer = null;
  queuedNew.clear();
  queuedDismiss.clear();
  hostedSettings = { notify: true };
  hostedSettingsAt = 0;
  cfg = null;
  clk = realClock;
}

/* Is anyone actually LOOKING at this, right now?
 *
 * The old answer was a flag with a timeout: the page said "visible" every ten
 * seconds and a claim younger than 25s counted as somebody watching. That is
 * wrong in exactly the case it has to get right. iOS and Android FREEZE a page
 * when the app is closed, and neither promises the visibilitychange frame
 * escapes first, so the last thing the engine heard was "visible", the
 * timestamp is young, and it went on suppressing notifications for up to 25
 * more seconds. Reported from the Android tablet: send a message, minimise,
 * the reply lands inside 30 seconds, nothing buzzes.
 *
 * Moving the number does not fix it. The flaw is trusting a timestamp that
 * stops being updated at precisely the moment you care about.
 *
 * So attendance is PROVEN at decision time rather than inferred:
 *
 *   1. no client attached to this chat, or one that says it is not visible:
 *      nobody is watching. Notify, immediately, as before.
 *   2. a client that CLAIMS to be watching is asked to prove it. The engine
 *      pokes it (an app-level ping, and a protocol ping) and waits. ANY frame
 *      from that page stamped after the reply proves its javascript is still
 *      running, which is the one thing a frozen page cannot fake.
 *   3. no proof by the deadline: it was frozen. Notify. Late, but it arrives,
 *      and a redundant banner for a chat you are staring at is a far smaller
 *      cost than a message you never hear about. Same principle the app
 *      already applies to speech.
 *
 * The deadline is the page's own heartbeat cadence, MEASURED per socket rather
 * than assumed, plus slack, because a live page cannot stay silent past its own
 * next beat. With today's app that is about 12s worst case. A client that
 * answers the ping settles it in milliseconds, which is why the ping is sent
 * even though no released build answers it yet.
 *
 * (BEAT_ASSUMED_MS/BEAT_SLACK_MS come from presence.ts: one definition of
 * "how long may a live page stay silent", shared with present().)
 */
/* The worst a notification can now be LATE. Note what this constant does and
 * does not risk: getting it wrong costs latency, never silence, which is the
 * opposite way round from the 25s flag it replaces. */
const CONFIRM_CAP_MS = 13_000;
const CONFIRM_STEP_MS = 100;

/* Does a protocol-level pong count as proof?
 *
 * It would be free (browsers answer it with no app code at all) but only if
 * the answer comes from the page. If a browser's NETWORK stack answers the
 * ping, a frozen page pongs happily and the pong is a lie that would rebuild
 * the very bug above. Measured with a frozen Chromium in
 * agent-engine/src/freeze-probe.ts; off unless that measurement says otherwise. */
const PONG_IS_PROOF = false;

/* Every notify decision says what it decided and why, because the alternative
 * was buzzing a real phone to find out. "It was delivered", "the engine
 * suppressed it on purpose" and "the engine never tried" used to be
 * indistinguishable after the fact: notifyDevices logged only on failure and
 * the suppression path, the interesting one, logged nothing at all.
 *
 * Bounded on purpose: at most three lines per reply, and replies are
 * human-paced. Never an endpoint, a key or a token: those are secrets, and
 * this log runs forever on a laptop. */
const short = (id: string) => id.slice(0, 8);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function watchClaimants(sid: string): Sock[] {
  return [...C().clients()].filter((c) => c.data.attached === sid && c.data.visible);
}

export function pokeForProof(ws: Sock) {
  ws.data.probeAt = clk.now();
  // app level: needs the page's javascript to run, which is the whole point
  send(ws, { t: "ping", n: ++ws.data.probeSeq });
  // protocol level: costs nothing, and freeze-probe.ts says whether it means
  // anything on the browsers we actually ship to
  try {
    ws.ping();
  } catch { /* socket already going away */ }
}

/* One reply, one decision, one log line. Both callers (a spoken/written reply
 * and a shown file) went through the same copy-pasted `attended` check before;
 * a file push that went out silently was a separate bug fixed separately. */
export async function notifyUnlessWatched(
  s: Session,
  p: { title: string; body: string; msgKey: string; ts: number },
) {
  const at = clk.now();
  const key = `${C().engineHost}:${s.id}`;
  const msg = `msg=${short(p.msgKey)} chars=${p.body.length}`;
  /* Nobody proved they were looking, so the message stays where logChat put it:
   * after the marker, which IS what unread means. There is no counter to bump.
   * The broadcast is still needed -- the row's number changed the moment the
   * message landed, and clients only learn that from a sessions frame. */
  const fire = (why: string, lateMs = 0) => {
    C().broadcastSessions();
    /* THE BELL, RESOLVED HERE. This engine owns the per-session override and
     * caches the user's global default, so this is the one place that can
     * honestly answer "does this chat buzz". Unread still counted above: the
     * bell silences the phone, it does not un-happen the reply. */
    if (!notifyWanted(s.id)) {
      console.log(`[notify] bell-off ${key} ${msg} why=${why} ` +
        `(${settingsOf(s.id).notify === false ? "this chat's bell" : "the global default"} says no)`);
      return;
    }
    /* PRESENCE, and it sits here rather than at the top of this function on
     * purpose. The proof dance above is not only about notifying: proving he is
     * watching this chat is what MOVES THE MARKER, and short-circuiting on
     * "some app is connected" would take that with it. So the wait still runs,
     * and only the push itself is suppressed. It costs nothing in the common
     * case: with no client on this chat, fire() is reached immediately. */
    if (appConnected()) {
      /* AND THE CLOCK STARTS. "A socket is connected" is not "he is looking at
       * it", and this branch may not be allowed to hold a message for ever on
       * the strength of that. startSilence arms the ceiling below, which is the
       * bound on how long this can last. */
      const silent = startSilence(s, at);
      console.log(`[notify] present ${key} ${msg} why=${why} ` +
        `(${C().clients().size} app socket(s) on this engine, so no new-message push; ` +
        `unread ${secs(silent)}, ceiling ${secs(ceilingMs())})`);
      return;
    }
    /* IN THE GRACE WINDOW: he has just put the screen down, or a network blip
     * dropped every socket at once. Hold it. The flush at the end of the wait
     * pushes everything unread, this message included.
     *
     * The test is `awaySince`, NOT `graceTimer`. A timer being armed no longer
     * means a grace is running: onPresenceChange also arms one merely to come
     * back and re-ask once a young page has held long enough. Reading the timer
     * as the window would hold every message for the first ten seconds of any
     * socket's life, including the very first one after an engine start. */
    if (isAway()) {
      const silent = startSilence(s, at);
      console.log(`[notify] holding ${key} ${msg} why=${why} (the ${secs(graceMs())} grace is running; ` +
        `unread ${secs(silent)}, ceiling ${secs(ceilingMs())})`);
      return;
    }
    console.log(`[notify] send ${key} ${msg} why=${why}${lateMs ? ` late=${secs(lateMs)}` : ""}`);
    s.silentSince = undefined; // a banner is going out: nothing is being held back
    s.notified = true; // one is standing on the devices now
    scheduleHeardSave(s.id);
    queueNotify(key, { title: p.title, body: p.body, unread: unreadOf(s) });
  };

  const attached = [...C().clients()].filter((c) => c.data.attached === s.id);
  const claimants = attached.filter((c) => c.data.visible);
  if (!claimants.length) {
    fire(attached.length
      ? `${attached.length} client(s) on this chat, all say backgrounded`
      : `no client attached (clients=${C().clients().size})`);
    return;
  }

  // Somebody claims to be watching. Make them prove it before staying silent.
  const who = claimants.map((c) => `c${c.data.cid}`).join(",");
  const wait = Math.min(
    CONFIRM_CAP_MS,
    Math.max(...claimants.map((c) =>
      c.data.visibleAt + (c.data.beatMs || BEAT_ASSUMED_MS) + BEAT_SLACK_MS - at)),
  );
  const claims = claimants
    .map((c) => `c${c.data.cid} claim=${secs(at - c.data.visibleAt)} beat=${c.data.beatMs ? secs(c.data.beatMs) : "?"}`)
    .join(" ");
  if (wait <= 0) {
    // the claim is already older than that page's own heartbeat: it went quiet
    fire(`stale claim (${claims})`);
    return;
  }
  console.log(`[notify] hold ${key} ${msg} ${who} claim watching, ${claims}, proving up to ${secs(wait)}`);
  for (const c of claimants) pokeForProof(c);

  const deadline = at + wait;
  let proof: { cid: number; kind: string; ms: number } | null = null;
  while (clk.now() < deadline) {
    await nap(CONFIRM_STEP_MS);
    /* Asked again each time, not once at the start. A client that reconnects or
     * opens this chat DURING the wait is watching it now, and notifying it
     * would be a banner for a message on the screen. */
    const live = watchClaimants(s.id);
    for (const c of live) {
      if (c.data.lastFrame > at) {
        proof = { cid: c.data.cid, kind: "frame", ms: c.data.lastFrame - at };
        break;
      }
      if (PONG_IS_PROOF && c.data.pongAt > at) {
        proof = { cid: c.data.cid, kind: "pong", ms: c.data.pongAt - at };
        break;
      }
    }
    if (proof) break;
    if (!live.length) break; // nobody left claiming to watch: stop waiting
  }

  /* Whether a PROTOCOL pong came back, recorded on every decision whether it
   * is trusted or not. This is the field that answers "can a pong be used as
   * proof": a frozen page that pongs anyway is being answered by the browser's
   * network stack, and trusting it would rebuild the bug. */
  const pongMs = Math.max(...claimants.map((c) => c.data.pongAt)) - at;
  const pong = pongMs > 0 ? `pong=${pongMs}ms` : "pong=none";

  if (proof) {
    console.log(
      `[notify] suppress ${key} ${msg} c${proof.cid} is watching ` +
      `(proof=${proof.kind} after ${secs(proof.ms)}, ${pong})`,
    );
    /* A message you were PROVABLY looking at is read, and the marker is the
     * only place that can be said. Without this the suppressed notification and
     * the row disagreed: no banner, but a count of 1 on a chat open in front of
     * you, which is exactly the class of read-marker bug this guards against. */
    if (markRead(s, p.ts)) C().broadcastSessions();
    return;
  }
  const gone = claimants.filter((c) => !C().clients().has(c)).length;
  const left = claimants.filter((c) => C().clients().has(c) && c.data.attached !== s.id).length;
  const said = claimants.filter((c) => C().clients().has(c) && c.data.attached === s.id && !c.data.visible).length;
  fire(
    (gone === claimants.length ? `socket closed (${who})`
      : left ? `left the chat (${who})`
      : said ? `said backgrounded (${who})`
      : `no proof of life from ${who} (frozen page; ${claims})`) + ` ${pong}`,
    clk.now() - at,
  );
}

/* Seal a push payload under the per-session key (task 527). The app
 * server relays {kid, enc} it cannot read; the real title/body/count live only
 * inside `enc`. Returns null when there is no content generation (E2E not
 * set up), where the plaintext fields stand. body is capped at 1200 chars so
 * the sealed base64 stays under the app server's `enc` cap (push.ts ENC_MAX,
 * 8192) for EVERY encoding: a 1200-char body of 3-byte UTF-8 (CJK) is the
 * worst case at ~5.2k base64 chars, so the cap must clear that. It once read
 * "2000-char body bound", which was neither the real cap (4096, then 8192)
 * nor safe for multibyte (#537 F1).
 *
 * v2 (#579): the key is the newest content generation's per-session
 * key (deriveSessionKey(newestGen(...).key, sessionId)), NOT kEngine; the wire
 * still always carries the generic fallback text too (no unsealed mode). */
export async function sealPushItem(
  sessionId: string,
  title: string,
  body: string,
  count: number,
): Promise<{ kid: string; enc: string } | null> {
  return C().seal(sessionId, title, body, count);
}

/* THE GENERIC FALLBACK the wire shows when the preview is sealed (task 527,
 * #579): the exact wording the app and its service worker already use
 * for a keyless push, so an unpaired or old device sees the same neutral text
 * it always has. The real title/body/count ride ONLY inside `enc`. */
const GENERIC_PUSH_TITLE = "CallYourCode";
const GENERIC_PUSH_BODY = "New message";

/* Build the wire push item (task 527 R2 safety requirement): the plaintext
 * title/body become the generic fallback above, so the app server (and an
 * unpaired/old device) see only "New message" under "CallYourCode". The real
 * content lives ONLY in `enc`, decryptable by a paired device whose service
 * worker prefers `enc` over these visible fields.
 *
 * `base` keeps every other field (sessionId, unread, tag, decided). */
export function pushWire<T extends Record<string, unknown>>(
  base: T,
  sealed: { kid: string; enc: string },
): T & { kid: string; enc: string; title: string; body: string } {
  return {
    ...base,
    title: GENERIC_PUSH_TITLE,
    body: GENERIC_PUSH_BODY,
    kid: sealed.kid,
    enc: sealed.enc,
  };
}

export async function notifyDevices(
  /* decided: this engine already applied the bell (override ?? global), so
   * the app server must not run its legacy quiet-list check on top. */
  /* unread: THIS SESSION'S COUNT, from the marker, so the app server never has
   * to count for itself. Its own tally was a per-chat +1 that only ever cleared
   * on an explicit /push/read, and the icon badge was the SIZE of that map --
   * how many chats had ever buzzed, not how many messages are waiting. A chat
   * read on a device that never posted the read left its entry behind for good,
   * which is a badge that can only go up. */
  payload: { title: string; body: string; sessionId: string; tag?: string; decided?: boolean;
    unread?: number },
  key = payload.sessionId,
) {
  /* The wiring this push belongs to, for the reason flushBatch captures one:
   * every line below runs after an await, and in process the wiring can be gone
   * by then. One wiring per process in production, so this is a no-op there. */
  const mine = C();
  const at = clk.now();
  // Seal the real title/body/count under kS unconditionally. Every engine
  // mints content generation 1 at first boot, so a key always exists; a failed
  // or empty seal means the engine cannot seal, and the only safe answer is to
  // send NOTHING, never plaintext. The wire carries the generic fallback plus
  // {kid, enc}.
  let sealed: { kid: string; enc: string } | null;
  try {
    sealed = await sealPushItem(payload.sessionId, payload.title, payload.body, payload.unread ?? 0);
  } catch (e) {
    console.error(`[notify] push ${key} NOT SENT, seal failed: ${(e as Error)?.message}`);
    return;
  }
  if (!sealed) {
    console.error(`[notify] push ${key} NOT SENT, seal returned null`);
    return;
  }
  const wire = pushWire(payload, sealed);
  try {
    const tok = await mine.token();
    const res = await fetch(`${mine.appServerUrl}/push/notify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      },
      body: JSON.stringify(wire),
      signal: AbortSignal.timeout(8000),
    });
    // Say what the app server DID with it. Silence here was half the reason
    // "did that notification go out" needed a live phone to answer.
    const body = (await res.json().catch(() => null)) as any;
    if (res.status === 401) mine.dropToken("notify 401");
    if (!res.ok) console.warn(`[notify] push ${key} REFUSED http ${res.status} in ${clk.now() - at}ms`);
    else console.log(`[notify] push ${key} accepted: ${body?.devices ?? "?"} device(s), ` +
      `waiting=${body?.count ?? "?"} in ${clk.now() - at}ms`);
  } catch (e) {
    // the app server being down must never break a reply
    console.warn(`[notify] push ${key} FAILED, app server unreachable: ${(e as Error)?.message}`);
  }
}

/* AN ENGINE-LEVEL, SESSION-LESS PUSH (e.g. the usage-card plugin's plan-usage
 * threshold alert).
 *
 * Unlike notifyDevices, this banner belongs to a PLUGIN, not a chat: its
 * identifier is the plugin id (symmetric to sessionId for a session push), it
 * carries an empty sessionId, and its preview is sealed under the ENGINE notify
 * key (deriveEngineNotifyKey), which no per-session key can open and which the
 * device derives precisely because the item has no sessionId. The device dedup
 * tag is built HERE from the plugin id plus an optional non-sensitive sub-key
 * (a window label like "5 hours"), so no account or other secret ever rides in
 * a cleartext field. The app server does no content logic on it (forward,
 * that's it). The push-plaintext round-2 rule is unchanged: a throwing/null
 * seal sends NOTHING, never plaintext. */
export type EngineNotifyPayload = {
  /** the raising plugin's registered id: THE identifier of an engine-level
   *  notification (what sessionId is to a session push); routing/dedup
   *  metadata, safe in cleartext */
  plugin: string;
  title: string;
  body: string;
  /** optional NON-sensitive dedup sub-key (e.g. the window label "5 hours");
   *  never an account or any other secret */
  subTag?: string;
  /** the tap target, sealed inside `enc` (e.g. "usage:<host>"); never on the wire */
  open?: string;
};

/** The device dedup tag for an engine-level push: plugin id (+ sub-key), so a
 *  later alert from the same plugin/window replaces the earlier banner. Carries
 *  the plugin id and the sub-key ONLY, by construction never an account. */
export function engineNotifyTag(p: Pick<EngineNotifyPayload, "plugin" | "subTag">): string {
  return p.subTag ? `plugin:${p.plugin}:${p.subTag}` : `plugin:${p.plugin}`;
}

export async function notifyEngineDevices(p: EngineNotifyPayload) {
  const mine = C();
  const at = clk.now();
  const tag = engineNotifyTag(p);
  const key = `engine:${tag}`;
  // Seal the real title/body/open under the engine notify key unconditionally.
  // A failed or empty seal means the engine cannot seal, and the only safe answer
  // is to send NOTHING, never plaintext (the round-2 rule). The wire carries the
  // generic fallback plus {kid, enc} and nothing else content-shaped.
  let sealed: { kid: string; enc: string } | null;
  try {
    sealed = await mine.sealEngine(p.title, p.body, p.open);
  } catch (e) {
    console.error(`[notify] engine push ${key} NOT SENT, seal failed: ${(e as Error)?.message}`);
    return;
  }
  if (!sealed) {
    console.error(`[notify] engine push ${key} NOT SENT, seal returned null`);
    return;
  }
  const wire = {
    title: GENERIC_PUSH_TITLE,
    body: GENERIC_PUSH_BODY,
    sessionId: "",
    plugin: p.plugin,
    tag,
    kid: sealed.kid,
    enc: sealed.enc,
  };
  try {
    const tok = await mine.token();
    const res = await fetch(`${mine.appServerUrl}/push/notify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      },
      body: JSON.stringify(wire),
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json().catch(() => null)) as any;
    if (res.status === 401) mine.dropToken("notify 401");
    if (!res.ok) console.warn(`[notify] engine push ${key} REFUSED http ${res.status} in ${clk.now() - at}ms`);
    else console.log(`[notify] engine push ${key} accepted: ${body?.devices ?? "?"} device(s), ` +
      `waiting=${body?.count ?? "?"} in ${clk.now() - at}ms`);
  } catch (e) {
    // the app server being down must never break the engine
    console.warn(`[notify] engine push ${key} FAILED, app server unreachable: ${(e as Error)?.message}`);
  }
}

/* present() and appConnected() moved to presence.ts:
 * "is an app connected to THIS engine" is presence's question; the poke above
 * and the marker move stay here because they are about THIS chat. */

/* The dismissal, and it is the SAME channel the app has always used: the app
 * server's /push/read, which deletes the pending entry and pushes dismiss:true
 * to every device. The engine is a second caller of it, not a second system.
 *
 * This goes out even while an app is connected, because a notification
 * he read on the laptop must not sit on his phone forever. The guard is
 * at the call site: no flag, nothing on the phone, nothing to send. */
export function sendDismissal(s: Session) {
  const key = `${C().engineHost}:${s.id}`;
  s.notified = false;
  scheduleHeardSave(s.id);
  console.log(`[notify] dismiss ${key} (read here, taking the banner down)`);
  queuedNew.delete(key); // a chat read inside the window never buzzes at all
  queuedDismiss.add(key);
  scheduleBatch();
}

/* THE 10 SECOND WINDOW, ALIGNED TO THE WALL CLOCK.
 *
 * :00, :10, :20, and NOT a timer started by the first message. Two reasons, and
 * the first is the one that matters: the app server batches on the same
 * boundary, so an aligned engine lands INSIDE the app server's window instead
 * of starting its wait after it. Stacked waits would cost 20 seconds; aligned
 * ones cost about 10. The second is free: an engine that restarts mid-window
 * simply joins the next one, with no state to carry.
 *
 * One push carries every session that changed in the window -- new messages and
 * dismissals together -- because the device has to apply them in one order
 * (dismiss, then show, then the floor) and it can only do that if it sees them
 * at once. */
/* Ten seconds is the product decision and the app server's
 * window is the same ten, so the default here is not a knob anyone should turn
 * in production. The OVERRIDE is what was missing: NOTIFY_GRACE_MS,
 * NOTIFY_STABLE_MS, NOTIFY_CEILING_MS and NOTIFY_CEILING_TICK_MS all have one
 * and this was the only notify timing without, so every spec that asks "was it
 * pushed" had to wait ten real seconds for an answer the engine already knew.
 * That single missing line was 72 seconds of sleeping in notify.test.ts alone.
 *
 * READ PER CALL, not captured at import, exactly as presence.ts reads its grace
 * and stability knobs. The value never changes in a running engine, so this is
 * byte-identical in production; what it buys is that a test file no longer
 * depends on which module was imported first, and a seam test driving the
 * MANUAL clock can delete the override at file scope and prove the real ten
 * seconds rather than a shrunken stand-in. */
export const batchMs = (): number => Number(process.env.NOTIFY_BATCH_MS) || 10_000;
/* A notification body is a PREVIEW, not the whole reply. The app only ever shows
 * slice(0, 2000) and the lock screen far less, so putting a full assistant
 * message on the wire (a file dump can be tens of KB) is bytes nobody reads and,
 * batched, would cross the app server's POST cap and lose the window. Bounded
 * here so reply length is never a wire-size wall. */
const NOTIFY_BODY_MAX = 2000;
/* No icon field: pushes stopped referencing engine photo URLs (sealed-transport
 * enforcement -- /session-photo is owner-gated, so an OS icon fetch could never
 * answer). The service worker keeps the app logo. */
type Queued = { title: string; body: string; unread: number };
const queuedNew = new Map<string, Queued>();
const queuedDismiss = new Set<string>();
let batchTimer: unknown = null;

/** ms until the next wall-clock boundary, offset ms past it. Never 0: a flush
 * landing exactly on one must wait for the NEXT, not fire twice in a tick.
 *
 * `now` is a parameter so the ALIGNMENT is a property of the caller's clock
 * rather than of the wall: the whole point of the window is that it lands on
 * :00/:10/:20 and not half a window after whichever message opened it, and that
 * is the one thing about it a test has to be able to state as arithmetic. */
export function msToBoundary(period: number, offset = 0, now = Date.now()): number {
  const next = Math.floor((now - offset) / period) * period + period + offset;
  return next - now;
}

export function scheduleBatch() {
  if (batchTimer) return;
  batchTimer = clk.setTimeout(() => {
    batchTimer = null;
    void flushBatch();
  }, msToBoundary(batchMs(), 0, clk.now()));
}

export async function flushBatch() {
  if (!queuedNew.size && !queuedDismiss.size) return;
  /* THE WIRING THIS WINDOW BELONGS TO, captured before the first await.
   *
   * Everything below happens after a network round trip, and the requeue path
   * writes back into module state. In production there is exactly one wiring for
   * the life of the process, so this is the same object every time and the guard
   * below never fires. In process (the seam tier, resetForTest) a POST can
   * outlive the wiring that made it, and then the never-drop rule would put a
   * dead wiring's window into the LIVE one's queue and arm its batch timer on
   * the previous clock -- which silences the next wiring's window entirely,
   * because scheduleBatch sees a timer already armed. A window is only ever
   * requeued into the wiring that queued it. */
  const mine = C();
  const fresh = [...queuedNew.entries()].map(([sessionId, q]) => ({ sessionId, ...q }));
  const gone = [...queuedDismiss];
  queuedNew.clear();
  queuedDismiss.clear();
  const at = clk.now();
  console.log(`[notify] batch ${mine.engineHost} new=${fresh.length} dismiss=${gone.length} ` +
    `(window ${new Date(at).toISOString().slice(14, 19)})`);
  // Seal each session's real preview under its kS unconditionally. A failed or
  // empty seal drops that item with a loud log and sends NOTHING for it, never
  // a plaintext item. The wire item carries only the generic fallback plus
  // {kid, enc}. `unread` and `sessionId` stay cleartext: the app server needs
  // them for its badge/dismiss bookkeeping, a deliberate, documented
  // metadata leak.
  const items = (
    await Promise.all(
      fresh.map(async (f) => {
        let sealed: { kid: string; enc: string } | null;
        try {
          sealed = await sealPushItem(f.sessionId, f.title, f.body, f.unread);
        } catch (e) {
          console.error(`[notify] batch item ${f.sessionId} NOT SENT, seal failed: ${(e as Error)?.message}`);
          return null;
        }
        if (!sealed) {
          console.error(`[notify] batch item ${f.sessionId} NOT SENT, seal returned null`);
          return null;
        }
        return pushWire({ sessionId: f.sessionId, unread: f.unread, title: f.title, body: f.body }, sealed);
      }),
    )
  ).filter((w) => w !== null);
  /* Put the whole window back and try again next boundary. These sessions are
   * still marked notified, so a dropped window would leave the phone assumed to
   * hold a banner it never got: the never-drop rule. One helper for
   * both loss paths -- an unreachable server AND a reachable one that refuses --
   * so they cannot drift. */
  const requeue = () => {
    if (cfg !== mine) return; // this window's wiring is gone; so is its queue
    for (const f of fresh) if (!queuedDismiss.has(f.sessionId)) queuedNew.set(f.sessionId, f);
    for (const g of gone) queuedDismiss.add(g);
    scheduleBatch();
  };
  try {
    const tok = await mine.token();
    const res = await fetch(`${mine.appServerUrl}/push/batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      },
      body: JSON.stringify({ host: mine.engineHost, new: items, dismiss: gone }),
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      /* Reachable but refusing: a 401 (a dead or revoked engine token -- drop
       * it so the next window re-enrolls), 413 (batch too big), or 400
       * (malformed). A non-2xx used to only log and drop the window, so an
       * auth misconfig silently and permanently lost every banner while the
       * sessions stayed marked notified. It is a loss exactly like an outage,
       * so it takes the outage's path: requeue and retry next window. */
      if (res.status === 401) mine.dropToken("batch 401");
      requeue();
      console.warn(`[notify] batch REFUSED http ${res.status}, re-queued in ${clk.now() - at}ms`);
    } else {
      /* A 200 is not proof of full delivery (#569): the app server caps a batch
       * (BATCH_ITEMS_MAX) and rate-limits an engine (PUSH_RATE_MAX), and it now
       * reports what it did not keep as {truncated, dropped}. Anything not kept
       * takes the same never-drop path as an outage -- requeue the window and
       * retry next boundary -- so a capped item is never assumed delivered. */
      const truncated = Number(body?.truncated) || 0;
      const dropped = Number(body?.dropped) || 0;
      if (truncated + dropped > 0) {
        requeue();
        console.warn(`[notify] batch partly capped (truncated=${truncated} dropped=${dropped}), ` +
          `re-queued in ${clk.now() - at}ms`);
      } else {
        console.log(`[notify] batch accepted: ${body?.devices ?? "?"} device(s) in ${clk.now() - at}ms`);
      }
    }
  } catch (e) {
    // The app server being down must never break a reply and must never lose
    // the flag either. Put them back and let the next window try again.
    requeue();
    console.warn(`[notify] batch FAILED, app server unreachable: ${(e as Error)?.message}`);
  }
}

/** A session's next message joins the window. Later text wins; the count is
 *  always the freshest, because it is the one the banner shows. */
export function queueNotify(key: string, q: Queued) {
  queuedDismiss.delete(key); // it is unread again: a dismissal would be a lie
  // the preview, not the whole reply (NOTIFY_BODY_MAX): the one choke point every
  // queueNotify caller passes through, so the wire size is bounded here
  queuedNew.set(key, { ...q, body: q.body.slice(0, NOTIFY_BODY_MAX) });
  scheduleBatch();
}

/* THE 30 SECOND GRACE and the away clock live in presence.ts:
 * when it expires, presence calls back through onAway -> flushUnread below. */

/* THE CEILING. The property, stated as a number rather than as a hope: a
 * message is announced within this long of arriving, or it was read before then.
 *
 * The grace above fixes the mechanism, and the mechanism can still be wrong for
 * a reason nobody has thought of yet -- every one of the 222 messages the log
 * shows suppressed by "an app socket is connected" had a socket that was UP, so
 * no amount of fixing the disconnect path reaches them. This is what reaches
 * them. It fires on the ONE fact that is not a guess: the chat has been unread,
 * with no banner standing on any device, for longer than anybody could be said
 * to be reading it.
 *
 * Ten minutes, chosen from the same log rather than from taste. Replaying the
 * window at each value, counting banners this rule adds and how many of those
 * chats he then read within five minutes anyway (a banner he did not need):
 *
 *     2min  36 banners, 10 unneeded      10min  18 banners,  1 unneeded
 *     5min  28 banners,  8 unneeded      15min  16 banners,  3 unneeded
 *
 * Ten is the knee: it announces 125 of the 236 messages that went silent, keeps
 * the other 111 silent because he genuinely read them, and costs 18 extra
 * banners in 32 hours of which one was arguably unwanted.
 *
 * It can never buzz for a message he is looking at, and that is structural, not
 * lucky: a chat he provably watches is markRead'd by notifyUnlessWatched, and a
 * chat with no unread is not a chat this sweep can fire for. */
/* Read per call, for the reason batchMs() is: the value never changes in a
 * running engine, so production is unchanged, and a seam test on the manual
 * clock can prove the real ten minutes instead of a four second stand-in. */
export const ceilingMs = (): number => Number(process.env.NOTIFY_CEILING_MS) || 10 * 60_000;
/* Coarse on purpose. The ceiling is minutes; a quarter minute of slop on it
 * costs nothing and one timer for every session costs a timer for every
 * session. */
export const ceilingTickMs = (): number => Number(process.env.NOTIFY_CEILING_TICK_MS) || 15_000;

let ceilingTimer: unknown = null;

/** A message is being held back. Start this chat's ceiling clock if it is not
 *  already running, and return how long it has been running. */
export function startSilence(s: Session, at: number): number {
  s.silentSince ??= at;
  if (!ceilingTimer) ceilingTimer = clk.setInterval(sweepCeiling, ceilingTickMs());
  return clk.now() - s.silentSince;
}

/* Anything held back past the ceiling gets announced. The sweep stops itself
 * when there is nothing left waiting, so an idle engine keeps no timer. */
export function sweepCeiling() {
  const now = clk.now();
  let waiting = 0;
  for (const s of C().sessions()) {
    if (s.silentSince === undefined) continue;
    /* SKIPPED, NOT SETTLED, and the difference is the whole of a bug. This used
     * to clear the clock as it skipped, which DESTROYS the held message's
     * ceiling: the reason to skip can go away -- he reads the chat, so the
     * banner is dismissed -- and by then the clock the message was waiting on is
     * gone and it can never be announced at all. A skip means "not now",
     * so the clock stays and this sweep keeps looking (`waiting` below).
     *
     * A banner already stands: the device is showing this chat, and a second
     * one for it would be the stacked second banner the one-banner-per-chat rule forbids. */
    if (s.notified) { waiting += 1; continue; }
    /* AND NO GUARD HERE FOR A CHAT HE FILED, because this sweep cannot reach
     * one. It only ever looks at a session with a clock running, the clock is
     * only ever armed by a message being held back (startSilence, and it has one
     * caller pair), and marking unread neither arms it nor is possible on a chat
     * that has one: filing requires the chat to be read, and every route to read
     * goes through markRead, which clears it three lines up from here.
     *
     * So a filed chat arrives here only after a NEW reply has been held for it
     * -- and that reply is past the mark, which is exactly when the ceiling
     * should fire. The flush needs the guard because it has no such requirement;
     * this would be a branch nothing can execute. */
    const n = unreadOf(s);
    if (!n) { s.silentSince = undefined; continue; }
    const silent = now - s.silentSince;
    if (silent < ceilingMs()) { waiting += 1; continue; }
    const key = `${C().engineHost}:${s.id}`;
    s.silentSince = undefined;
    if (!notifyWanted(s.id)) {
      console.log(`[notify] bell-off ${key} ceiling unread=${n} silent=${secs(silent)}`);
      continue;
    }
    // the newest agent line is what the banner shows, as everywhere else
    let body = "";
    for (let i = s.chat.length - 1; i >= 0; i--) {
      if (s.chat[i].role === "claude") { body = s.chat[i].text ?? ""; break; }
    }
    console.log(`[notify] ceiling ${key} unread=${n} silent=${secs(silent)} ` +
      `(past the ${secs(ceilingMs())} ceiling, notifying whatever presence says)`);
    s.notified = true;
    scheduleHeardSave(s.id);
    queueNotify(key, { title: C().sessionPushTitle(s), body: body || "New message", unread: n });
  }
  if (!waiting && ceilingTimer) { clk.clearInterval(ceilingTimer); ceilingTimer = null; }
}

/* The grace expired and he really is away: push everything unread that has no
 * notification standing already. The flag is what stops this from re-buzzing a
 * chat the phone is already showing.
 *
 * It no longer bails on appConnected(). That guard read the very signal this
 * whole path stopped trusting: with a page reconnecting every few seconds, a
 * socket is nearly always up at the instant the grace expires, so the flush
 * turned itself off exactly when it was needed. onPresenceChange has already
 * decided, on thirty seconds of evidence, that nobody is there. */
export function flushUnread() {
  for (const s of C().sessions()) {
    if (s.notified) continue;
    /* Everything unread here is something he filed himself,
     * so there is nothing to announce. THIS is the path that buzzed him about a
     * message he had just marked unread: it asks only whether the chat has a
     * count, and a filed chat has one by design.
     *
     * Note where it sits: BEFORE the clock is cleared below, because a skip must
     * not settle anything. And note what it is not: a suppression of the chat.
     * One reply past the mark and this is false, and the flush announces it
     * exactly as it would for a chat he had never touched. */
    if (filedAndQuiet(s)) continue;
    const n = unreadOf(s);
    if (!n) continue;
    const key = `${C().engineHost}:${s.id}`;
    s.silentSince = undefined; // settled here, one way or the other
    if (!notifyWanted(s.id)) {
      console.log(`[notify] bell-off ${key} flush unread=${n}`);
      continue;
    }
    // the newest agent line is what the banner shows, the same text the live
    // path would have sent had he been away when it landed
    let body = "";
    for (let i = s.chat.length - 1; i >= 0; i--) {
      if (s.chat[i].role === "claude") { body = s.chat[i].text ?? ""; break; }
    }
    console.log(`[notify] flush ${key} unread=${n} (grace expired, nobody proved they were here)`);
    s.notified = true;
    scheduleHeardSave(s.id);
    queueNotify(key, { title: C().sessionPushTitle(s), body: body || "New message", unread: n });
  }
}
/* THE LIMITS POLL LIVES IN THE USAGE-CARD PLUGIN NOW (blueprint section 3):
 * the plugin owns the fetch cadence, the threshold wording and its cache; the
 * one seam it keeps is the device push (notifyDevices), wired where the
 * plugins are built. */

/* What `show` accepts, how big it may be, and whether it may render inside a
 * bubble: agent-engine/src/chat/show.ts, which is testable without booting this. */


/* The user's GLOBAL defaults, from the app server, cached the way the hosted
 * voice is and for the same reason: the notify decision below runs while no
 * page is open, so this engine has to know the default itself, and it must
 * not pay a network hop per reply. App server down = last answer stands, and
 * before any answer the shipped defaults do. */
let hostedSettings = { notify: true };
let hostedSettingsAt = 0;
const HOSTED_SETTINGS_TTL_MS = 60_000;

export async function refreshHostedSettings() {
  hostedSettingsAt = clk.now();
  try {
    /* Bear the engine token when there is one: in HOSTED /settings is
     * owner-scoped, and the token names whose globals this engine reads. */
    const tok = C().peekToken();
    const res = await fetch(`${C().appServerUrl}/settings`, {
      headers: tok ? { authorization: `Bearer ${tok}` } : {},
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return;
    const j = (await res.json()) as any;
    if (typeof j?.notify === "boolean") hostedSettings.notify = j.notify;
  } catch { /* app server down: keep the last answer */ }
}


export function globalNotify(): boolean {
  if (clk.now() - hostedSettingsAt > HOSTED_SETTINGS_TTL_MS) void refreshHostedSettings();
  return hostedSettings.notify;
}

/* The bell, resolved: this session's override, else the user's default. */
export function notifyWanted(sessionId: string): boolean {
  return settingsOf(sessionId).notify ?? globalNotify();
}
