/* The signaling relay CORE: rtc-* frames between an owner's device and an
 * owner's engine, forwarded BLINDLY.
 * This file is the socket-agnostic state machine. It used to live in a
 * standalone relay service; the app-server now folds it in-process
 * (bootstrap/server.ts owns the port, the /engine and /device upgrades and
 * the websocket handlers, all delegating here).
 *
 * Two WebSocket legs meet here:
 *
 *   /engine   ONE outbound socket per engine, authenticated at upgrade by
 *             its issued cyt_ token (introspected against the app-server's
 *             enroll store). It speaks the r envelope below.
 *   /device   one socket per connection attempt, opened UNAUTHED (no Clerk,
 *             no bearer in any URL). The relay is blind and holds no device
 *             list, so it CANNOT verify identity: it issues a nonce challenge,
 *             forwards the device's one signed {t:"r-auth"} proof to the engine
 *             inside r-open, and opens or closes the leg on the engine's
 *             verdict. It speaks BARE frames after that; this file wraps and
 *             unwraps the envelope.
 *
 * Device-key auth, device leg only:
 *   server -> device   {t:"r-challenge", nonce}   issued at open, unauthed
 *   device -> server   {t:"r-auth", spki, sig}    the ONE pre-auth frame
 *   server -> device   {t:"r-ok"}                 the engine accepted; signal now
 * The proof rides r-open to the engine; the relay never verifies it.
 *
 * Envelope, engine leg only:
 *   server -> engine   {t:"r-open",  c, rtc:{iceServers:[...]}, auth:{nonce,spki,sig}}
 *   engine -> server   {t:"r-accept",c} | {t:"r-reject", c}   the auth verdict
 *   both               {t:"r",       c, f:"<frame string>"}
 *   both               {t:"r-close", c, code}
 *
 * BLIND BY CONSTRUCTION: `f` is an opaque string. This file parses its OWN
 * envelope on the engine leg and nothing else; after auth a device frame is
 * length- and budget-checked and forwarded verbatim. The one device frame it
 * reads is the r-auth proof, and only to hand it to the engine unchanged (a
 * public key and a signature, never content). Logs carry ids, codes and counts,
 * never frame contents. The E2E design needs nothing from this file because
 * nothing readable ever reaches it: SDP and ICE candidates are the only
 * payloads, and the sealed client wire rides the DataChannel these frames
 * negotiate, not this relay.
 *
 * WHAT KILLS WHAT: a device leg closing tells the engine (r-close). An engine
 * leg closing kills every device leg on it (4404). None of that touches a
 * DataChannel that already opened; the engine detaches an opened pipe from
 * its signaling conn (agent-engine/src/transport/relay.ts), which is what lets a chat
 * survive a relay restart.
 */

/* Caps (section 1 of the design): a real negotiation is a handful of frames
 * of a few KiB inside a few seconds. Everything past these is a broken or
 * hostile client, refused with a code rather than carried. */
export const RELAY_FRAME_MAX = 64 * 1024;
export const RELAY_CONN_FRAMES_MAX = 300;
export const RELAY_CONNS_PER_ENGINE_MAX = 32;
export const RELAY_CONN_TTL_MS = 120_000;
export const RELAY_OPENS_PER_ENGINE_MAX = 30;  // per rolling minute, keyed per engine
const OPEN_WINDOW_MS = 60_000;

/* The close codes this file speaks. 4401/4403/4404 mirror their HTTP cousins;
 * 4409 is "a newer socket for the same engine took over". */
export const RELAY_CLOSE = {
  unauthorized: 4401,
  forbidden: 4403,
  engineOffline: 4404,
  superseded: 4409,
} as const;

type WsLike = {
  send(s: string): unknown;
  close(code?: number, reason?: string): void;
  data: RelayWsData;
};

export type RelayWsData =
  | { relay: "engine"; engineId: string; owner: string }
  | { relay: "device"; engineId: string; connId: string };

type Conn = {
  id: string;
  device: WsLike;
  frames: number;
  ttl: ReturnType<typeof setTimeout>;
  /* r-close already crossed (either direction): the other side must not be
   * told twice, and a late frame is dropped rather than forwarded. */
  closed: boolean;
  /* Device-key auth: the nonce this leg was challenged with, and
   * whether the engine has accepted the device's proof yet. Before `authed`
   * the ONLY device frame allowed is the one r-auth carrying the proof; after
   * it, signaling forwards verbatim. */
  nonce: string;
  authed: boolean;
  proofSent: boolean;
};

type EngineLink = {
  ws: WsLike;
  owner: string;
  conns: Map<string, Conn>;
};

let connSeq = 0;
export const mintConnId = () => `rc${++connSeq}-${Math.random().toString(36).slice(2, 8)}`;

/** A fresh 16-byte base64url challenge nonce. Opaque to this file: it rides the
 *  r-challenge to the device and back to the engine in r-open, and only the
 *  engine (which holds the device list) ever binds it into a verified message. */
export const mintNonce = (): string => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** A close code an untrusted peer named, made safe to pass to ws.close. */
const safeCode = (v: unknown): number => {
  const n = Number(v);
  return Number.isInteger(n) && ((n >= 4000 && n <= 4999) || n === 1000) ? n : 1000;
};

export class Relay {
  private engines = new Map<string, EngineLink>();
  private opens = new Map<string, { start: number; count: number }>();

  constructor(
    private log: (event: string, fields: Record<string, unknown>) => void,
    /* The ICE servers one r-open hands the engine: the STUN list plus, when
     * TURN is configured, creds freshly minted for this attempt. Server data,
     * never device data. */
    private rtcFor: (label: string) => unknown,
  ) {}

  /* ---------------------------------------------------------- socket events
   * Websocket handlers delegate here with the data stamped
   * at upgrade (it did the authentication; this file does the matching). */

  open(ws: WsLike): void {
    const d = ws.data;
    if (d.relay === "engine") return this.openEngine(ws, d.engineId, d.owner);
    this.openDevice(ws, d.engineId, d.connId);
  }

  message(ws: WsLike, raw: string | Uint8Array): void {
    if (typeof raw !== "string") {
      /* Signaling is JSON text on both legs; a binary frame is nothing we
       * relay. 1003: unsupported data. */
      ws.close(1003, "text-only");
      return;
    }
    if (raw.length > RELAY_FRAME_MAX) {
      this.log("relay.oversize", { relay: ws.data.relay, bytes: raw.length, cap: RELAY_FRAME_MAX });
      ws.close(1009, "oversize");
      return;
    }
    if (ws.data.relay === "engine") this.fromEngine(ws, raw);
    else this.fromDevice(ws, raw);
  }

  close(ws: WsLike): void {
    const d = ws.data;
    if (d.relay === "engine") {
      const link = this.engines.get(d.engineId);
      if (!link || link.ws !== ws) return; // a superseded socket: nothing left to do
      this.engines.delete(d.engineId);
      for (const conn of link.conns.values()) {
        clearTimeout(conn.ttl);
        if (!conn.closed) conn.device.close(RELAY_CLOSE.engineOffline, "engine-offline");
      }
      this.log("relay.engine.close", { engineId: d.engineId, conns: link.conns.size });
      return;
    }
    const conn = this.engines.get(d.engineId)?.conns.get(d.connId);
    if (conn && conn.device === ws) this.dropConn(d.engineId, conn, 1000, "device-closed");
  }

  /* ------------------------------------------------------------ engine leg */

  private openEngine(ws: WsLike, engineId: string, owner: string): void {
    const prev = this.engines.get(engineId);
    if (prev) {
      /* The engine redialed (its old socket half-dead behind a NAT timeout).
       * The NEW socket is the live one; the old one's conns cannot continue
       * (their state is on a socket the engine has abandoned). */
      for (const conn of prev.conns.values()) {
        clearTimeout(conn.ttl);
        if (!conn.closed) conn.device.close(RELAY_CLOSE.engineOffline, "engine-superseded");
      }
      prev.ws.close(RELAY_CLOSE.superseded, "superseded");
    }
    this.engines.set(engineId, { ws, owner, conns: new Map() });
    this.log("relay.engine.open", { engineId, superseded: !!prev });
  }

  private fromEngine(ws: WsLike, raw: string): void {
    const d = ws.data as Extract<RelayWsData, { relay: "engine" }>;
    const link = this.engines.get(d.engineId);
    if (!link || link.ws !== ws) return; // superseded: drop
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    const conn = link.conns.get(String(m?.c ?? ""));
    if (!conn || conn.closed) return; // late frame for a gone conn: dropped
    if (m.t === "r-accept") {
      /* The engine verified the device-key proof: open the leg. Only
       * now does the device's held rtc-offer get invited (r-ok); signaling
       * forwards verbatim from here. */
      if (!conn.authed) {
        conn.authed = true;
        try { conn.device.send(JSON.stringify({ t: "r-ok" })); } catch { /* leg racing away */ }
        this.log("relay.conn.authed", { engineId: d.engineId, c: conn.id });
      }
      return;
    }
    if (m.t === "r-reject") {
      /* The engine refused the proof: close the leg 4401. The relay stays
       * blind; the verdict is entirely the engine's (its device list). */
      this.dropConn(d.engineId, conn, RELAY_CLOSE.unauthorized, "engine-rejected");
      return;
    }
    if (m.t === "r" && typeof m.f === "string") {
      if (!conn.authed) return; // no signaling reaches an unproven device leg
      // VERBATIM: the device gets the bare frame string
      try { conn.device.send(m.f); } catch { /* leg racing away */ }
      return;
    }
    if (m.t === "r-close") {
      this.dropConn(d.engineId, conn, safeCode(m.code), "engine-said");
      return;
    }
    this.log("relay.engine.badframe", { engineId: d.engineId, t: String(m?.t) });
  }

  /* ------------------------------------------------------------ device leg */

  private openDevice(ws: WsLike, engineId: string, connId: string): void {
    const link = this.engines.get(engineId);
    if (!link) {
      ws.close(RELAY_CLOSE.engineOffline, "engine-offline");
      return;
    }
    /* NO OWNER MATCH any more: the relay is blind and holds no device
     * list, so the cross-account wall moved to the engine, which verifies the
     * device-key proof below against its enrolled devices. This leg opens
     * unauthed and is gated by the engine's r-accept/r-reject verdict. */
    if (link.conns.size >= RELAY_CONNS_PER_ENGINE_MAX) {
      ws.close(1013, "engine-busy");
      return;
    }
    /* Rate-limited per ENGINE (no owner exists to key by): the same cap that
     * also bounds the pairing lane, so an unproven device cannot flood opens. */
    const now = Date.now();
    let b = this.opens.get(engineId);
    if (!b || now - b.start >= OPEN_WINDOW_MS) {
      b = { start: now, count: 0 };
      this.opens.set(engineId, b);
      if (this.opens.size > 10_000) {
        for (const [k, v] of this.opens) if (now - v.start >= OPEN_WINDOW_MS) this.opens.delete(k);
      }
    }
    if (++b.count > RELAY_OPENS_PER_ENGINE_MAX) {
      this.log("relay.device.ratelimited", { engineId });
      ws.close(1013, "rate-limited");
      return;
    }
    const conn: Conn = {
      id: connId, device: ws, frames: 0, closed: false,
      nonce: mintNonce(), authed: false, proofSent: false,
      ttl: setTimeout(() => {
        /* Signaling finishes in seconds. A leg still open at the TTL has done
         * its job (the app closes its leg once the DataChannel opens) or
         * never will; either way it goes. An opened DataChannel is elsewhere
         * and unaffected. */
        const c = this.engines.get(engineId)?.conns.get(connId);
        if (c && !c.closed) this.dropConn(engineId, c, 1000, "ttl");
      }, RELAY_CONN_TTL_MS),
    };
    link.conns.set(connId, conn);
    /* No r-open yet: challenge the device first. r-open (carrying the proof)
     * only goes to the engine once the device answers r-auth. */
    try { ws.send(JSON.stringify({ t: "r-challenge", nonce: conn.nonce })); } catch { /* leg racing away */ }
    this.log("relay.conn.open", { engineId, c: connId, conns: link.conns.size });
  }

  private fromDevice(ws: WsLike, raw: string): void {
    const d = ws.data as Extract<RelayWsData, { relay: "device" }>;
    const link = this.engines.get(d.engineId);
    const conn = link?.conns.get(d.connId);
    if (!link || !conn || conn.closed || conn.device !== ws) return;
    if (++conn.frames > RELAY_CONN_FRAMES_MAX) {
      this.log("relay.conn.flood", { engineId: d.engineId, c: d.connId, cap: RELAY_CONN_FRAMES_MAX });
      this.dropConn(d.engineId, conn, 1008, "frame-budget");
      return;
    }
    if (!conn.authed) {
      /* Pre-auth: the ONLY frame this leg may send is the r-auth proof, which
       * the relay parses just enough to lift {spki, sig} out and hand to the
       * engine inside r-open. Anything else closes the leg 4401. */
      if (conn.proofSent) return; // proof already forwarded; waiting on the verdict
      let m: any;
      try { m = JSON.parse(raw); } catch { m = null; }
      if (!m || m.t !== "r-auth" || typeof m.spki !== "string" || typeof m.sig !== "string") {
        this.dropConn(d.engineId, conn, RELAY_CLOSE.unauthorized, "want-r-auth");
        return;
      }
      conn.proofSent = true;
      link.ws.send(JSON.stringify({
        t: "r-open", c: d.connId, rtc: this.rtcFor(d.engineId),
        auth: { nonce: conn.nonce, spki: m.spki, sig: m.sig },
      }));
      return;
    }
    /* VERBATIM AND UNREAD: raw is a string this file never parses. */
    link.ws.send(JSON.stringify({ t: "r", c: d.connId, f: raw }));
  }

  /* One conn torn down, both sides told exactly once. */
  private dropConn(engineId: string, conn: Conn, code: number, why: string): void {
    if (conn.closed) return;
    conn.closed = true;
    clearTimeout(conn.ttl);
    const link = this.engines.get(engineId);
    if (link) {
      link.conns.delete(conn.id);
      try { link.ws.send(JSON.stringify({ t: "r-close", c: conn.id, code })); } catch { /* leg racing away */ }
    }
    try { conn.device.close(code, why); } catch { /* already gone */ }
    this.log("relay.conn.close", { engineId, c: conn.id, code, why, frames: conn.frames });
  }
}
