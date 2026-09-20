/* THE DATACHANNEL PIPE FRAMING (#579 / #561). This is the SINGLE shared module:
 * both the engine and the app bundle import it directly, so
 * there is no twin to keep in sync. The WIRE is the contract and is pinned by
 * fixtures/dcpipe-vectors.json, exercised from both bundles.
 *
 * A DataChannel message has a real size limit (RFC 8841's 64 KiB default,
 * Chromium closes above 256 KiB, werift throws above 64 KiB) and our frames do
 * not (attach-ok carries two 100-message pages; a tunnel chunk is 256 KB of
 * base64). So the pipe fragments. It also carries its own liveness, because
 * there is no WebSocket ping under it.
 *
 * Every DataChannel message is BINARY: one header byte, then payload.
 *
 *   0x00 FRAG   up to FRAG_MAX bytes of UTF-8 of the frame string; more follow
 *   0x01 LAST   the final (or only) fragment; the receiver delivers ONE string
 *   0x02 PING   no payload
 *   0x03 PONG   no payload
 *   0x04 CLOSE  UTF-8 JSON {code, reason}; the sender then closes the channel
 *
 * The channel is ordered + reliable, so there are no sequence numbers: a
 * fragment belongs to the message the previous LAST ended. Nothing here knows
 * what a frame means; delivery upward is strings only, one onmessage(s) per
 * logical message, exactly what the WebSocket handed the layers above today.
 */

export const FRAG = 0x00;
export const LAST = 0x01;
export const PING = 0x02;
export const PONG = 0x03;
export const CLOSE = 0x04;

/** 16 KiB minus the header byte: the size every browser and both bun stacks
 * accept unconditionally; SCTP fragments below that on its own. */
export const FRAG_MAX = 16 * 1024 - 1;
/** Reassembly cap. Bun's WebSocket inbound default, so a frame that fits
 * today's WS fits the DataChannel. */
export const MSG_MAX = 16 * 1024 * 1024;

export const PING_MS = 30_000;
export const DEAD_MS = 90_000;
const LOW = 256 * 1024;
/** pc.connectionState stuck non-live this long closes the pipe; browsers
 * recover short `disconnected` blips on their own, hence 5 s and not 0. */
const ICE_DEAD_MS = 5_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Split one frame string into ordered [FRAG…][LAST] fragment buffers. Pure, so
 * the vectors pin it. An empty string is one LAST with an empty payload. */
export function fragment(s: string): Uint8Array[] {
  const bytes = enc.encode(s);
  const out: Uint8Array[] = [];
  let off = 0;
  do {
    const end = Math.min(off + FRAG_MAX, bytes.length);
    const isLast = end >= bytes.length;
    const chunk = bytes.subarray(off, end);
    const buf = new Uint8Array(1 + chunk.length);
    buf[0] = isLast ? LAST : FRAG;
    buf.set(chunk, 1);
    out.push(buf);
    off = end;
  } while (off < bytes.length);
  return out;
}

/** Accumulates FRAG payloads and yields one string per LAST. Rejects a message
 * over MSG_MAX and a PING/PONG arriving mid-message. Pure, so the vectors pin
 * reassembly independent of any socket. */
export class Reassembler {
  private parts: Uint8Array[] = [];
  private size = 0;

  /** Feed one whole DataChannel message (header byte + payload). Returns the
   * delivered string on a LAST, null on a FRAG. Throws {code} on a protocol or
   * oversize violation; the caller closes with that code. */
  push(msg: Uint8Array): string | null {
    const type = msg[0];
    const payload = msg.subarray(1);
    if (type === FRAG || type === LAST) {
      this.size += payload.length;
      if (this.size > MSG_MAX) throw new PipeError(1009, "oversize");
      this.parts.push(payload);
      if (type === FRAG) return null;
      const whole =
        this.parts.length === 1 ? this.parts[0] : concat(this.parts, this.size);
      this.parts = [];
      this.size = 0;
      return dec.decode(whole);
    }
    // A PING/PONG/CLOSE mid-message is a protocol error (they only ride between
    // whole messages); an in-progress reassembly cannot absorb them.
    if (this.parts.length) throw new PipeError(1002, "protocol");
    return null;
  }
}

export class PipeError extends Error {
  constructor(readonly code: number, reason: string) {
    super(reason);
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/* -------- the live pipe over a real DataChannel ---------------------------- */

/** The minimal DataChannel surface dcPipe drives. The browser RTCDataChannel
 * satisfies it; the engine's node-datachannel adapter (rtc.ts) is
 * shaped to it too, so this file is byte-identical in both repos. */
export interface DcLike {
  readyState: string; // "open" when usable
  binaryType: string;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: Uint8Array): void;
  close(): void;
  onmessage: ((ev: { data: ArrayBuffer | Uint8Array }) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  addEventListener(type: string, cb: (ev: unknown) => void): void;
}

export interface PcLike {
  connectionState: string;
  addEventListener(type: string, cb: (ev: unknown) => void): void;
}

export interface Pipe {
  readonly open: boolean;
  readonly kind: "dc";
  send(s: string): boolean;
  drain(): Promise<void>;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((s: string) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  onpong: (() => void) | null;
}

/** Wrap an open-or-opening DataChannel as a Pipe: fragmentation out, reassembly
 * in, PING/DEAD liveness, backpressure drain, and peer-connection-death close.
 * Nothing above sees a fragment or a ping. */
export function dcPipe(dc: DcLike, pc: PcLike): Pipe {
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = LOW;

  const rx = new Reassembler();
  let closed = false;
  let lastInbound = now();
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let iceBad: ReturnType<typeof setTimeout> | null = null;
  const drainWaiters: Array<() => void> = [];

  const pipe: Pipe = {
    get open() {
      return !closed && dc.readyState === "open";
    },
    kind: "dc",
    onopen: null,
    onmessage: null,
    onclose: null,
    onpong: null,
    send(s: string): boolean {
      if (!this.open) return false;
      // Every fragment of one message is written back to back in this one
      // synchronous loop, so two concurrent sends never interleave fragments.
      for (const f of fragment(s)) dc.send(f);
      return true;
    },
    drain(): Promise<void> {
      if (dc.bufferedAmount < LOW || !this.open) return Promise.resolve();
      return new Promise((resolve) => drainWaiters.push(resolve));
    },
    close(code = 1000, reason = ""): void {
      if (closed) return;
      // Best-effort CLOSE frame so the peer learns why, then drop the channel.
      try {
        if (dc.readyState === "open") {
          const body = enc.encode(JSON.stringify({ code, reason }));
          const buf = new Uint8Array(1 + body.length);
          buf[0] = CLOSE;
          buf.set(body, 1);
          dc.send(buf);
        }
      } catch {
        // channel already gone
      }
      teardown(code, reason);
    },
  };

  function teardown(code: number, reason: string) {
    if (closed) return;
    closed = true;
    if (pingTimer) clearInterval(pingTimer);
    if (iceBad) clearTimeout(iceBad);
    for (const w of drainWaiters.splice(0)) w();
    try {
      dc.close();
    } catch {
      // already gone
    }
    pipe.onclose?.(code, reason);
  }

  dc.onopen = () => {
    lastInbound = now();
    pipe.onopen?.();
  };
  dc.onclose = () => teardown(1006, "dc-closed");

  dc.onmessage = (ev) => {
    lastInbound = now();
    const msg = ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data);
    const type = msg[0];
    if (type === PING) {
      trySend1(PONG);
      return;
    }
    if (type === PONG) {
      pipe.onpong?.();
      return;
    }
    if (type === CLOSE) {
      let code = 1000;
      let reason = "";
      try {
        const j = JSON.parse(dec.decode(msg.subarray(1)));
        code = Number(j.code) || 1000;
        reason = String(j.reason ?? "");
      } catch {
        // malformed CLOSE: treat as a bare close
      }
      teardown(code, reason);
      return;
    }
    let out: string | null;
    try {
      out = rx.push(msg);
    } catch (e) {
      const pe = e as PipeError;
      pipe.close(pe.code ?? 1002, pe.message ?? "protocol");
      return;
    }
    if (out !== null) pipe.onmessage?.(out);
  };

  dc.addEventListener("bufferedamountlow", () => {
    if (dc.bufferedAmount < LOW) for (const w of drainWaiters.splice(0)) w();
  });

  // Liveness: PING after PING_MS of quiet inbound, close after DEAD_MS.
  pingTimer = setInterval(() => {
    if (closed) return;
    const quiet = now() - lastInbound;
    if (quiet >= DEAD_MS) {
      pipe.close(4008, "quiet");
      return;
    }
    if (quiet >= PING_MS) trySend1(PING);
  }, PING_MS);

  // Peer-connection death (a longer-lived signal than the DataChannel's own).
  pc.addEventListener("connectionstatechange", () => {
    const st = pc.connectionState;
    if (st === "failed" || st === "closed") {
      pipe.close(4009, "ice");
    } else if (st === "disconnected") {
      if (!iceBad) iceBad = setTimeout(() => pipe.close(4009, "ice"), ICE_DEAD_MS);
    } else if (iceBad) {
      clearTimeout(iceBad);
      iceBad = null;
    }
  });

  function trySend1(header: number) {
    try {
      if (dc.readyState === "open") dc.send(new Uint8Array([header]));
    } catch {
      // channel gone; the timers/handlers will tear down
    }
  }

  return pipe;
}

function now(): number {
  return Date.now();
}
