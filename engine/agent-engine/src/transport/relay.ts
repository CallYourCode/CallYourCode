/* The engine's ONE outbound socket to the app-server's signaling relay
 * (server/src/bootstrap/server.ts /engine leg).
 *
 * Signaling is same-origin on the app-server now (the relay is folded onto it),
 * so this is the ONE path in every mode: local, tailscale and hosted. The
 * engine dials OUT -- one WebSocket to the app-server's /engine leg, held open
 * with backoff, authenticated by the same issued cyt_ token every announce and
 * push bears (introspected in-process by the app-server) -- so a phone that
 * cannot reach this engine directly (behind a home NAT, on cellular) still
 * hands it an rtc-offer through the app-server. The address is the APP_SERVER_URL
 * the engine already holds (default http://127.0.0.1:10100 -> ws .../engine);
 * RELAY_URL pins the /engine ws url explicitly. Down that socket the app-server
 * forwards each device's rtc-* frames inside its envelope:
 *
 *   in    {t:"r-open",  c, rtc:{iceServers}}   a device leg opened; here are
 *                                              the ICE servers for it
 *   in    {t:"r",       c, f:"<frame string>"} the device's rtc-offer/cand/abort
 *   out   {t:"r",       c, f:"<frame string>"} this engine's rtc-answer/cand/fail
 *   both  {t:"r-close", c, code}               the leg is gone
 *
 * Each conn drives the SAME answering machinery as a local signaling WS
 * (rtc.ts onRtcOffer), with the hosted options: gather with STUN/TURN,
 * advertise every candidate. When the DataChannel opens, onPipe mints the
 * ordinary sealed client (server.ts mintRtcClient), so everything above the
 * pipe is byte-identical to a local connection.
 *
 * THE CLOSE RULE, relay flavor: a conn (or this whole socket) dying BEFORE
 * the DataChannel opened tears the attempt down; AFTER it opened the pipe
 * stands alone. That is what lets a chat survive an app-server restart: the
 * server is a matchmaker, never the transport.
 */

import { addRtcCand, closeRtc, RTC, onRtcOffer, type IceServerInfo, type RtcAttempt } from "./rtc";
import type { Pipe } from "./dcpipe";

export const RELAY_BACKOFF_MIN_MS = 5_000;
export const RELAY_BACKOFF_MAX_MS = 60_000;
/** Random spread added to every backoff wait so a relay coming back up does not
 *  take the whole fleet's redial in one millisecond. */
export const RELAY_JITTER_MS = 1_000;

/** Where this engine's relay leg should dial: the app-server's /engine ws url,
 *  naming this engine's id. Derived from the APP_SERVER_URL the engine already
 *  holds (http(s) -> ws(s), path /engine, ?engine=<engineId>), which is the ONE
 *  address in every mode. An explicit RELAY_URL env pins the /engine ws base
 *  instead (its ?engine= is still stamped here). Null only when neither is set,
 *  which leaves the link idle. */
export function resolveRelayUrl(appServerUrl: string, engineId: string, explicit = ""): string | null {
  const base = explicit || appServerUrl;
  if (!base || !engineId) return null;
  try {
    const u = new URL(base);
    if (u.protocol === "http:") u.protocol = "ws:";
    else if (u.protocol === "https:") u.protocol = "wss:";
    if (!/^wss?:$/.test(u.protocol)) return null;
    if (!explicit) u.pathname = "/engine";
    u.searchParams.set("engine", engineId);
    return u.toString();
  } catch {
    return null;
  }
}

export type RelayConn = {
  id: string;
  attempt: RtcAttempt | null;
  iceServers: IceServerInfo[];
  /** Candidates that raced the offer: an rtc-cand can land while onRtcOffer
   *  is still awaited, when attempt is not yet set. Queued, drained after. */
  candQ: Array<{ candidate: string; sdpMid: string } | null>;
  send(frame: unknown): void;
  close(code?: number, reason?: string): void;
};

export type RelayLinkOpts = {
  /** The relay's /engine URL for THIS attempt, or null: idle, retry later.
   *  Resolved per dial (resolveRelayUrl) so a hosted /config gaining a relay
   *  reaches a long-running engine without a restart. */
  url: () => Promise<string | null>;
  /** The issued cyt_ bearer, or "" when not (yet) enrolled: the dial waits. */
  token: () => Promise<string>;
  /** The relay refused the token (close 4401): drop it so the announce tick
   *  re-enrolls; the next dial picks the fresh one up. */
  onAuthReject: (why: string) => void;
  /** Verify one device-key dial proof, attached to
   *  r-open by the blind relay. True accepts the leg (r-accept), false refuses
   *  it (r-reject, the relay closes the device 4401). When omitted the leg is
   *  opened without a verdict (transport-only tests); production always wires
   *  this to sec.verifyRelayAuth against the enrolled device list. */
  onRelayAuth?: (auth: unknown) => Promise<boolean>;
  /** The cyc DataChannel opened for one conn: mint the sealed client. */
  onPipe: (pipe: Pipe, conn: RelayConn) => void;
  log: (event: string, fields?: Record<string, unknown>) => void;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** The jitter spread (RELAY_JITTER_MS). Injectable ONLY so a test can pin it
   *  to 0 and get a redial it can time; production never passes it. */
  jitterMs?: number;
  /** The WebSocket constructor to dial with. Injectable because the e2e preload
   *  (e2e/testpreload.ts) swaps globalThis.WebSocket for the app-client
   *  TestClient shim; this link is a SERVER-side outbound socket and must ride
   *  the real wire. Default: whatever is global at dial. */
  wsCtor?: typeof WebSocket;
};

export class RelayLink {
  private ws: WebSocket | null = null;
  private conns = new Map<string, RelayConn>();
  private stopped = false;
  private backoffMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: RelayLinkOpts) {
    this.backoffMs = opts.backoffMinMs ?? RELAY_BACKOFF_MIN_MS;
  }

  start(): void {
    void this.dial();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    try { this.ws?.close(1000, "stopped"); } catch { /* already gone */ }
    this.teardownConns();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private schedule(): void {
    if (this.stopped) return;
    const max = this.opts.backoffMaxMs ?? RELAY_BACKOFF_MAX_MS;
    const jitter = this.opts.jitterMs ?? RELAY_JITTER_MS;
    const wait = Math.min(this.backoffMs, max) + (jitter > 0 ? Math.floor(Math.random() * jitter) : 0);
    this.backoffMs = Math.min(this.backoffMs * 2, max);
    this.timer = setTimeout(() => void this.dial(), wait);
  }

  private async dial(): Promise<void> {
    if (this.stopped) return;
    const url = await this.opts.url().catch(() => null);
    const token = url ? await this.opts.token().catch(() => "") : "";
    if (!url || !token) {
      /* No relay configured anywhere (every local install), or not enrolled
       * yet (fresh HOSTED install still waiting on the pair command's cloud
       * grant, or the app server is down). The announce tick owns enrollment;
       * this just comes back later and stays quiet meanwhile. */
      this.schedule();
      return;
    }
    let ws: WebSocket;
    try {
      const Ctor = this.opts.wsCtor ?? WebSocket;
      ws = new Ctor(url, { headers: { authorization: `Bearer ${token}` } } as any);
    } catch (e) {
      this.opts.log("relay.dial.failed", { url, err: String(e) });
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoffMs = this.opts.backoffMinMs ?? RELAY_BACKOFF_MIN_MS;
      this.opts.log("relay.up", { url });
    };
    ws.onmessage = (ev) => this.onFrame(String(ev.data));
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.teardownConns();
      if (ev.code === 4401) this.opts.onAuthReject("relay 4401");
      if (ev.code === 4409) {
        /* A newer socket from THIS engine superseded us: only one process may
         * hold the leg, and the newer one is the right one. Do not redial and
         * knock it off in turn. */
        this.opts.log("relay.superseded", {});
        return;
      }
      if (!this.stopped) this.opts.log("relay.down", { code: ev.code, reason: ev.reason });
      this.schedule();
    };
    ws.onerror = () => { /* onclose follows and owns the redial */ };
  }

  /* A pending (never-opened) attempt dies with its conn; an OPENED pipe is
   * detached and lives on (the design's survive-a-server-restart property). */
  private teardownConns(): void {
    for (const conn of this.conns.values()) {
      if (conn.attempt && !conn.attempt.pipe) closeRtc(conn.attempt);
      conn.attempt = null;
    }
    this.conns.clear();
  }

  private onFrame(raw: string): void {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    const c = String(m?.c ?? "");
    if (!c) return;
    if (m.t === "r-open") {
      const ice = Array.isArray(m?.rtc?.iceServers) ? (m.rtc.iceServers as IceServerInfo[]) : [];
      const link = this;
      const conn: RelayConn = {
        id: c, attempt: null, iceServers: ice, candQ: [],
        send(frame) {
          try { link.ws?.send(JSON.stringify({ t: "r", c, f: JSON.stringify(frame) })); } catch { /* leg gone */ }
        },
        close(code) {
          if (link.conns.get(c) === conn) {
            link.conns.delete(c);
            try { link.ws?.send(JSON.stringify({ t: "r-close", c, code: code ?? 1000 })); } catch { /* leg gone */ }
          }
          if (conn.attempt) { closeRtc(conn.attempt); conn.attempt = null; }
        },
      };
      this.conns.set(c, conn);
      /* Device-key auth: the relay is blind and attached the device's
       * signed proof here. Verify it against the enrolled device list and
       * answer the verdict; the relay opens the leg (r-ok to the device) on
       * r-accept, or closes it 4401 on r-reject. No signaling reaches an
       * unaccepted conn. Absent verifier (transport-only tests): no verdict,
       * the leg is used as-is. */
      const verify = this.opts.onRelayAuth;
      if (verify) {
        void verify(m.auth).then((ok) => {
          if (this.conns.get(c) !== conn) return; // conn already gone
          if (ok) {
            try { link.ws?.send(JSON.stringify({ t: "r-accept", c })); } catch { /* leg gone */ }
            this.opts.log("relay.auth.accept", { c });
          } else {
            this.conns.delete(c);
            if (conn.attempt) { closeRtc(conn.attempt); conn.attempt = null; }
            try { link.ws?.send(JSON.stringify({ t: "r-reject", c })); } catch { /* leg gone */ }
            this.opts.log("relay.auth.reject", { c });
          }
        }).catch(() => {
          if (this.conns.get(c) !== conn) return;
          this.conns.delete(c);
          if (conn.attempt) { closeRtc(conn.attempt); conn.attempt = null; }
          try { link.ws?.send(JSON.stringify({ t: "r-reject", c })); } catch { /* leg gone */ }
          this.opts.log("relay.auth.reject", { c, err: "verify-threw" });
        });
      }
      return;
    }
    const conn = this.conns.get(c);
    if (m.t === "r-close") {
      if (conn) {
        this.conns.delete(c);
        if (conn.attempt && !conn.attempt.pipe) closeRtc(conn.attempt);
        conn.attempt = null; // an opened pipe detaches; dcpipe owns it now
      }
      return;
    }
    if (m.t !== "r" || typeof m.f !== "string" || !conn) return;
    let f: any;
    try { f = JSON.parse(m.f); } catch { return; }
    void this.onSignalFrame(conn, f);
  }

  private async onSignalFrame(conn: RelayConn, f: any): Promise<void> {
    if (f?.t === "rtc-offer" && typeof f.id === "string" && typeof f.sdp === "string") {
      if (!RTC.available) {
        conn.send({ t: "rtc-fail", id: f.id, reason: "unavailable" });
        return;
      }
      if (conn.attempt) closeRtc(conn.attempt); // one attempt per conn; a re-offer supersedes
      this.opts.log("relay.offer", { c: conn.id });
      const attempt = await onRtcOffer(
        { id: f.id, sdp: f.sdp },
        { reachedAddr: null, iceServers: conn.iceServers, advertiseAll: true },
        (frame) => conn.send(frame),
        (pipe) => this.opts.onPipe(pipe, conn),
      );
      conn.attempt = attempt;
      for (const cand of conn.candQ.splice(0)) addRtcCand(attempt, cand);
      return;
    }
    if (f?.t === "rtc-cand") {
      if (conn.attempt) addRtcCand(conn.attempt, f.cand ?? null);
      else conn.candQ.push(f.cand ?? null);
      return;
    }
    if (f?.t === "rtc-abort") {
      if (conn.attempt) { closeRtc(conn.attempt); conn.attempt = null; }
    }
  }
}
