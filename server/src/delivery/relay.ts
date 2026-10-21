/* Blind, authenticated, long-lived sealed data relay. No payload parsing after auth. */
import { byteLength, MSG_MAX, ENVELOPE_MAX, QUEUE_MAX } from "../../../engine/shared/ws-pipe";
export const RELAY_FRAME_MAX = MSG_MAX;
export const RELAY_CONNS_PER_ENGINE_MAX = 32;
export const RELAY_AUTH_TIMEOUT_MS = 15_000;
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
  getBufferedAmount?(): number;
  bufferedAmount?: number;
  close(code?: number, reason?: string): void;
  data: RelayWsData;
};

export type RelayWsData =
  | { relay: "engine"; engineId: string }
  | { relay: "device"; engineId: string; connId: string };

type Conn = {
  id: string;
  device: WsLike;
  frames: number;
  ttl: ReturnType<typeof setTimeout>;
  /* r-close already crossed (either direction): the other side must not be
   * told twice, and a late frame is dropped rather than forwarded. */
  closed: boolean;

  nonce: string;
  authed: boolean;
  proofSent: boolean;
};

type EngineLink = {
  ws: WsLike;
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

  constructor(private log: (event: string, fields: Record<string, unknown>) => void) {}

  private send(ws: WsLike, raw: string): boolean {
    const queued = ws.getBufferedAmount?.() ?? ws.bufferedAmount ?? 0;
    if (queued + byteLength(raw) > QUEUE_MAX) {
      this.fail(ws, 1009, "queue-limit");
      return false;
    }
    try {
      // Bun: -1 means queued, 0 means dropped. Never retry a queued frame.
      if (ws.send(raw) === 0) { this.fail(ws, 1013, "write-dropped"); return false; }
      return true;
    } catch { this.fail(ws, 1011, "write-failed"); return false; }
  }

  private fail(ws: WsLike, code: number, reason: string): void {
    const d = ws.data;
    if (d.relay === "device") {
      const conn = this.engines.get(d.engineId)?.conns.get(d.connId);
      if (conn?.device === ws) { this.dropConn(d.engineId, conn, code, reason); return; }
    } else this.close(ws);
    ws.close(code, reason);
  }

  /* ---------------------------------------------------------- socket events
   * Websocket handlers delegate here with the data stamped
   * at upgrade (it did the authentication; this file does the matching). */

  open(ws: WsLike): void {
    const d = ws.data;
    if (d.relay === "engine") return this.openEngine(ws, d.engineId);
    this.openDevice(ws, d.engineId, d.connId);
  }

  message(ws: WsLike, raw: string | Uint8Array): void {
    if (typeof raw !== "string") {

      this.fail(ws, 1003, "text-only");
      return;
    }
    if (byteLength(raw) > (ws.data.relay === "engine" ? ENVELOPE_MAX : MSG_MAX)) {
      this.log("relay.oversize", { relay: ws.data.relay, bytes: raw.length, cap: RELAY_FRAME_MAX });
      this.fail(ws, 1009, "oversize");
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

  private openEngine(ws: WsLike, engineId: string): void {
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
    this.engines.set(engineId, { ws, conns: new Map() });
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

      if (!conn.authed) {
        conn.authed = true;
        clearTimeout(conn.ttl);
        try { this.send(conn.device, JSON.stringify({ t: "r-ok" })); } catch { /* leg racing away */ }
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
      if (!conn.authed) return; // no data reaches an unproven device leg
      if (byteLength(m.f) > MSG_MAX) { this.dropConn(d.engineId, conn, 1009, "oversize"); return; }
      // VERBATIM: the device gets the bare frame string
      try { this.send(conn.device, m.f); } catch { /* leg racing away */ }
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
        const c = this.engines.get(engineId)?.conns.get(connId);
        if (c && !c.closed) this.dropConn(engineId, c, 1000, "ttl");
      }, RELAY_AUTH_TIMEOUT_MS),
    };
    link.conns.set(connId, conn);
    /* No r-open yet: challenge the device first. r-open (carrying the proof)
     * only goes to the engine once the device answers r-auth. */
    try { this.send(ws, JSON.stringify({ t: "r-challenge", nonce: conn.nonce })); } catch { /* leg racing away */ }
    this.log("relay.conn.open", { engineId, c: connId, conns: link.conns.size });
  }

  private fromDevice(ws: WsLike, raw: string): void {
    const d = ws.data as Extract<RelayWsData, { relay: "device" }>;
    const link = this.engines.get(d.engineId);
    const conn = link?.conns.get(d.connId);
    if (!link || !conn || conn.closed || conn.device !== ws) return;
    conn.frames++;
    if (!conn.authed) {
      if (byteLength(raw) > 16 * 1024) { this.dropConn(d.engineId, conn, 1009, "auth-oversize"); return; }
      /* Pre-auth: the ONLY frame this leg may send is the r-auth proof, which
       * the relay parses just enough to lift {spki, sig} out and hand to the
       * engine inside r-open. Anything else closes the leg 4401. */
      if (conn.proofSent) { this.dropConn(d.engineId, conn, 4401, "duplicate-proof"); return; } // // proof already forwarded; waiting on the verdict
      let m: any;
      try { m = JSON.parse(raw); } catch { m = null; }
      if (!m || m.t !== "r-auth" || typeof m.spki !== "string" || typeof m.sig !== "string") {
        this.dropConn(d.engineId, conn, RELAY_CLOSE.unauthorized, "want-r-auth");
        return;
      }
      conn.proofSent = true;
      this.send(link.ws, JSON.stringify({
        t: "r-open", c: d.connId,
        auth: { nonce: conn.nonce, spki: m.spki, sig: m.sig },
      }));
      return;
    }
    /* VERBATIM AND UNREAD: raw is a string this file never parses. */
    this.send(link.ws, JSON.stringify({ t: "r", c: d.connId, f: raw }));
  }

  /* One conn torn down, both sides told exactly once. */
  private dropConn(engineId: string, conn: Conn, code: number, why: string): void {
    if (conn.closed) return;
    conn.closed = true;
    clearTimeout(conn.ttl);
    const link = this.engines.get(engineId);
    if (link) {
      link.conns.delete(conn.id);
      try { this.send(link.ws, JSON.stringify({ t: "r-close", c: conn.id, code })); } catch { /* leg racing away */ }
    }
    try { conn.device.close(code, why); } catch { /* already gone */ }
    this.log("relay.conn.close", { engineId, c: conn.id, code, why, frames: conn.frames });
  }
}
