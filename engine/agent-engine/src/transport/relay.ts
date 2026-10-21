/* Long-lived sealed clients multiplexed over the outbound app-server socket. */
import { byteLength, MSG_MAX, ENVELOPE_MAX, QUEUE_MAX, LOW, type Pipe } from "../../../shared/ws-pipe";

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

export type RelayConn = { id: string; close(code?: number, reason?: string): void };

export type RelayLinkOpts = {
  /** The relay's /engine URL for THIS attempt, or null: idle, retry later.
   *  Resolved per dial (resolveRelayUrl) so a configured relay
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
  /** A verified relay leg: mint the sealed client. */
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
    if (this.stopped) return;
    if (!url || !token) {
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
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") { ws.close(1003, "text-only"); return; }
      this.onFrame(ev.data);
    };
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

  private teardownConns(): void {
    for (const conn of [...this.conns.values()]) conn.close(4404, "relay-down");
    this.conns.clear();
  }

  private send(frame: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    const raw = JSON.stringify(frame);
    if (byteLength(raw) > ENVELOPE_MAX || ws.bufferedAmount + byteLength(raw) > QUEUE_MAX) {
      ws.close(1009, "queue-limit");
      this.teardownConns();
      return false;
    }
    try { ws.send(raw); return true; }
    catch { ws.close(); this.teardownConns(); return false; }
  }

  private pipes = new Map<string, Pipe>();
  private onFrame(raw: string): void {
    if (byteLength(raw) > ENVELOPE_MAX) { this.ws?.close(1009, "oversize"); return; }
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    const c = String(m?.c ?? "");
    if (!c) return;
    if (m.t === "r-open") {
      if (this.conns.has(c) || this.conns.size >= 32) { this.send({t: "r-reject", c}); return; }
      let open = true;
      let active = false;
      let waiting: Promise<void> | null = null;
      let resolveDrain: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const poll = () => {
        timer = null;
        if (!open || !this.ws || this.ws.bufferedAmount <= LOW) {
          resolveDrain?.();
          resolveDrain = null;
          waiting = null;
        } else timer = setTimeout(poll, 10);
      };
      const conn: RelayConn = { id: c, close: (code = 1000, reason = "") => {
        if (!open) return;
        open = false;
        this.conns.delete(c);
        this.pipes.delete(c);
        if (timer) clearTimeout(timer);
        resolveDrain?.();
        resolveDrain = null;
        waiting = null;
        this.send({t: "r-close", c, code});
        pipe.onclose?.(code, reason);
      }};
      const pipe: Pipe = {
        kind: "ws", get open() { return open && active; },
        onopen: null, onmessage: null, onclose: null,
        send: (s) => {
          if (!pipe.open) return false;
          if (byteLength(s) > MSG_MAX) { conn.close(1009, "oversize"); return false; }
          return this.send({t: "r", c, f: s});
        },
        close: conn.close,
        drain: () => {
          if (!open || !this.ws || this.ws.bufferedAmount <= LOW) return Promise.resolve();
          if (!waiting) waiting = new Promise<void>((resolve) => {
            resolveDrain = resolve;
            timer = setTimeout(poll, 10);
          });
          return waiting;
        },
      };
      this.conns.set(c, conn);
      this.pipes.set(c, pipe);
      void (this.opts.onRelayAuth?.(m.auth) ?? Promise.resolve(true)).catch(() => false).then((ok) => {
        if (!open) return;
        if (!ok) { this.send({t: "r-reject", c}); conn.close(4401, "rejected"); return; }
        active = true;
        try {
          this.opts.onPipe(pipe, conn);
          this.send({t: "r-accept", c});
        } catch (error) {
          this.opts.log("relay.client.failed", {c, error: String(error)});
          conn.close(1011, "client-failed");
        }
      });
      return;
    }
    const conn = this.conns.get(c);
    if (m.t === "r-close") { conn?.close(Number(m.code) || 1000, "device-closed"); return; }
    const pipe = this.pipes.get(c);
    if (m.t === "r" && pipe?.open && typeof m.f === "string") {
      if (byteLength(m.f) > MSG_MAX) conn?.close(1009, "oversize");
      else pipe.onmessage?.(m.f);
    }
  }
}
