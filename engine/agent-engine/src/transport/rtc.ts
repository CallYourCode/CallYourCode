/* Engine-side WebRTC transport (#579): werift (pure-TypeScript WebRTC)
 * adapted onto the shared dcpipe framing. The signaling WS carries only
 * rtc-offer/answer/cand; the DataChannel `cyc` carries the sealed client wire.
 *
 * WHY werift (2026-08-24, the stuck-at-pairing root cause): node-datachannel
 * bundles libdatachannel v0.24.3, whose OpenSSL DTLS input path writes incoming
 * packets to the SSL BIO without holding the SSL mutex (fixed upstream in
 * PR #1584, in no released binding). The race intermittently corrupts DTLS
 * input state right after the handshake: ICE + STUN keep answering while
 * application records (the app's one-shot hello) are silently eaten. That was
 * the third cross-thread NAPI bug this engine hit in that stack (see the
 * negotiated-id:0 note below for the second). werift is single-threaded pure
 * TS -- no NAPI, no native threads, auditable end to end -- so this bug class
 * is gone by construction.
 *
 * ICE candidates (his cross-machine acceptance constraint, 2026-08-16): the
 * engine gathers everywhere but ADVERTISES only 127.0.0.1 and the address the
 * page reached the engine on (or everything on the relay path / the tailscale
 * address when one exists -- see relay.ts). Third-party interfaces (docker
 * bridges, other LANs) are never offered.
 */

import { dcPipe, type DcLike, type PcLike, type Pipe } from "./dcpipe";

export const RTC: { available: boolean; lib: string; version: string } = {
  available: false,
  lib: "werift",
  version: "",
};

// The werift module, imported at boot; `any` keeps the surface narrow and probed.
let werift: any = null;

/** Import werift once at boot. On failure the engine still runs (MCP,
 * schedules, herdr) but no client can connect and the log says so, loudly. */
export async function loadRtc(): Promise<void> {
  try {
    werift = await import("werift");
    RTC.available = !!werift.RTCPeerConnection;
  } catch {
    RTC.available = false;
  }
}

const LOOPBACK = "127.0.0.1";
export const RTC_OPEN_MS = 10_000;

function candAddress(cand: string): string {
  // "candidate:... <component> <transport> <priority> <ADDRESS> <port> typ ..."
  return cand.split(" ")[4] ?? "";
}

/* Adapt a werift RTCDataChannel to the browser-shaped DcLike dcpipe drives.
 * werift is Event-based (onMessage/stateChanged/bufferedAmountLow); dcpipe
 * wants onmessage / send / readyState / bufferedAmount. Binary both ways.
 *
 * FIRST-MESSAGE ORDER: subscribe onMessage at ADAPT time and QUEUE anything
 * that lands before dcpipe attaches its handler, flushing in order on a
 * microtask. werift is single-threaded so the old NAPI reorder cannot happen,
 * but the queue keeps the contract airtight for free. */
export function adaptDc(dc: any): DcLike {
  let onmsg: ((ev: { data: Uint8Array }) => void) | null = null;
  let preQ: Array<{ data: Uint8Array }> | null = [];
  const flushQ = () => {
    queueMicrotask(() => {
      while (onmsg && preQ && preQ.length) onmsg(preQ.shift()!);
      if (onmsg && preQ && !preQ.length) preQ = null; // drained: direct delivery
    });
  };
  const a: any = {
    binaryType: "arraybuffer",
    onopen: null,
    onclose: null,
    get readyState() {
      return dc.readyState;
    },
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
    get bufferedAmountLowThreshold() {
      return dc.bufferedAmountLowThreshold;
    },
    set bufferedAmountLowThreshold(n: number) {
      dc.bufferedAmountLowThreshold = n;
    },
    send(u: Uint8Array) {
      dc.send(Buffer.from(u.buffer, u.byteOffset, u.byteLength));
    },
    close() {
      try {
        dc.close();
      } catch {
        // already gone
      }
    },
    addEventListener(type: string, cb: (ev: unknown) => void) {
      if (type === "bufferedamountlow") dc.bufferedAmountLow.subscribe(() => cb({}));
    },
  };
  Object.defineProperty(a, "onmessage", {
    get() { return onmsg; },
    set(cb: typeof onmsg) { onmsg = cb; if (cb && preQ) flushQ(); },
  });
  dc.onMessage.subscribe((msg: string | Uint8Array) => {
    const data = typeof msg === "string" ? new TextEncoder().encode(msg) : (msg as Uint8Array);
    const ev = { data };
    if (preQ) {
      preQ.push(ev);
      if (onmsg) flushQ();
      return;
    }
    onmsg?.(ev);
  });
  dc.stateChanged.subscribe((s: string) => {
    if (s === "open") a.onopen?.();
    else if (s === "closed") a.onclose?.();
  });
  return a as DcLike;
}

/* werift state names line up with the browser's connectionState enough for
 * dcpipe's failed/closed/disconnected checks. */
export function adaptPc(pc: any): PcLike {
  const a: any = {
    get connectionState() {
      return pc.connectionState;
    },
    addEventListener(type: string, cb: (ev: unknown) => void) {
      if (type === "connectionstatechange") pc.connectionStateChange.subscribe(() => cb({}));
    },
  };
  return a as PcLike;
}

export type Signal = (frame: unknown) => void;

/* Browser-shaped ICE server entry, as /config and the relay's r-open carry it.
 * werift takes the browser shape directly; this normalises urls to a flat
 * {urls, username?, credential?} list. */
export type IceServerInfo = { urls?: string[] | string; username?: string; credential?: string };

function weriftIceServers(servers: IceServerInfo[] | null | undefined): Array<{ urls: string; username?: string; credential?: string }> {
  const out: Array<{ urls: string; username?: string; credential?: string }> = [];
  for (const s of servers ?? []) {
    const urls = typeof s?.urls === "string" ? [s.urls] : Array.isArray(s?.urls) ? s.urls : [];
    for (const u of urls) {
      if (!/^(stun|turn|turns):/.test(String(u).trim())) continue;
      out.push({ urls: String(u).trim(), ...(s.username ? { username: s.username } : {}), ...(s.credential ? { credential: s.credential } : {}) });
    }
  }
  return out;
}

/* How one offer should gather and advertise.
 * advertiseAll: everything flows (srflx/relay included); otherwise only
 * loopback + reachedAddr are offered. */
export type RtcOfferOpts = {
  reachedAddr: string | null;
  iceServers: IceServerInfo[];
  advertiseAll: boolean;
};

/* One offer's negotiation. Owns the PeerConnection; yields a Pipe once the
 * DataChannel opens, or rtc-fails on the 10 s timer. */
export type RtcAttempt = {
  id: string;
  pc: any;
  pipe: Pipe | null;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  /* Call-mode voice: the reciprocated Opus audio track. NOT wired on werift yet:
   * the m=audio media path is the owner-deferred upgrade (call mode rides the
   * sealed DC stt stream), so track stays null until that lane lands. */
  track: any | null;
  onAudioTrack: ((track: any) => void) | null;
};

/* The DTLS sha-256 fingerprint from an SDP's a=fingerprint line, upper-hex with
 * colons. The fp gate compares the two ends' views. null when the SDP has no
 * such line. */
export function fingerprintOfSdp(sdp: string): string | null {
  const m = /a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)/.exec(sdp);
  return m ? m[1].toUpperCase() : null;
}

/** The engine's own DTLS fp (from its local answer SDP) and the peer's fp
 *  (from the remote offer SDP, which DTLS verifies against the wire). Both
 *  null before the answer exists. */
export function fingerprintsOf(attempt: RtcAttempt): { local: string | null; remote: string | null } {
  let local: string | null = null;
  let remote: string | null = null;
  try { local = fingerprintOfSdp(attempt.pc.localDescription?.sdp ?? ""); } catch {}
  try { remote = fingerprintOfSdp(attempt.pc.remoteDescription?.sdp ?? ""); } catch {}
  return { local, remote };
}

/* Answer an rtc-offer. `send` writes signaling frames back on the WS; `onPipe`
 * is called with the live Pipe when `cyc` opens (the caller mints the RtcSock
 * and runs the sec handshake over it). */
export async function onRtcOffer(
  offer: { id: string; sdp: string },
  opts: RtcOfferOpts,
  send: Signal,
  onPipe: (pipe: Pipe) => void,
): Promise<RtcAttempt> {
  const { reachedAddr, advertiseAll } = opts;
  // werift gathers host candidates only on real interfaces, never loopback, so a
  // same-machine browser (page + engine on one box) had no 127.0.0.1 candidate to
  // use and had to reach the engine on its LAN IP. On macOS that path is gated by
  // the Local Network permission, so a browser without it could not connect and
  // pairing silently never happened. Advertising loopback gives same-machine
  // pairing a stable, permission-free candidate; the advertise allowlist below
  // already permits LOOPBACK, and cross-machine still uses reachedAddr/relay.
  const pc = new werift.RTCPeerConnection({
    iceServers: weriftIceServers(opts.iceServers),
    iceAdditionalHostAddresses: [LOOPBACK],
  });
  const attempt: RtcAttempt = { id: offer.id, pc, pipe: null, timer: null, closed: false, track: null, onAudioTrack: null };

  /* Mint the pipe for an OPEN channel, exactly once. The attempt.pipe guard
   * makes a second arrival a no-op. Takes the ALREADY-ADAPTED channel so the
   * negotiated path hooks `onopen` on the same adapter dcPipe consumes. */
  const mint = (adapted: DcLike) => {
    if (attempt.closed || attempt.pipe) return;
    if (attempt.timer) clearTimeout(attempt.timer);
    const pipe = dcPipe(adapted, adaptPc(pc));
    attempt.pipe = pipe;
    onPipe(pipe);
  };

  pc.connectionStateChange.subscribe((state: string) => {
    console.log(`[rtc] pc-state=${state} id=${offer.id}`);
  });
  pc.iceConnectionStateChange.subscribe((state: string) => {
    console.log(`[rtc] ice-state=${state} id=${offer.id}`);
  });

  const advertise = new Set<string>([LOOPBACK]);
  if (reachedAddr && reachedAddr !== LOOPBACK) advertise.add(reachedAddr);

  // Candidates trickle to the browser; the answer is sent below BEFORE any
  // candidate (Chromium rejects addIceCandidate before setRemoteDescription).
  pc.onIceCandidate.subscribe((cand: any) => {
    if (attempt.closed) return;
    if (!cand) {
      send({ t: "rtc-cand", id: offer.id, cand: null }); // end-of-candidates
      return;
    }
    const line = String(cand.candidate ?? "");
    if (advertiseAll || advertise.has(candAddress(line))) {
      send({ t: "rtc-cand", id: offer.id, cand: { candidate: line, sdpMid: cand.sdpMid ?? "0", sdpMLineIndex: cand.sdpMLineIndex ?? 0 } });
    }
  });

  /* COMPAT path: an in-band (DCEP) channel from an older dialer. The shipped
   * path is the pre-negotiated stream-0 channel below (kept during the werift
   * swap so the browser side is untouched; the original reason -- macOS NAPI
   * dropping cross-thread onDataChannel -- is gone with werift, so collapsing
   * to one path is a follow-up cleanup). */
  pc.onDataChannel.subscribe((dc: any) => {
    if (attempt.closed) return;
    if (dc?.label !== "cyc") return;
    const adapted = adaptDc(dc);
    if (dc.readyState === "open") mint(adapted);
    else dc.stateChanged.subscribe((s: string) => { if (s === "open") mint(adapted); });
  });

  try {
    await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    console.log(`[rtc] remote-set id=${offer.id}`);
  } catch (e) {
    console.error(`[rtc] setRemoteDescription threw id=${offer.id} err=${(e as Error)?.stack ?? String(e)}`);
    send({ t: "rtc-fail", id: offer.id, reason: "bad-offer" });
    closeRtc(attempt);
    return attempt;
  }

  // The pre-negotiated stream-0 channel, same shape the browser creates.
  try {
    const dc = pc.createDataChannel("cyc", { negotiated: true, id: 0, ordered: true });
    const adapted = adaptDc(dc);
    if (dc.readyState === "open") mint(adapted);
    else dc.stateChanged.subscribe((s: string) => { if (s === "open") mint(adapted); });
  } catch (e) {
    console.error(`[rtc] createDataChannel(negotiated) threw id=${offer.id} err=${(e as Error)?.stack ?? String(e)}`);
  }

  try {
    await pc.setLocalDescription(await pc.createAnswer());
    if (!attempt.closed) send({ t: "rtc-answer", id: offer.id, sdp: pc.localDescription!.sdp });
  } catch (e) {
    console.error(`[rtc] answer threw id=${offer.id} err=${(e as Error)?.stack ?? String(e)}`);
    send({ t: "rtc-fail", id: offer.id, reason: "answer-failed" });
    closeRtc(attempt);
    return attempt;
  }

  attempt.timer = setTimeout(() => {
    if (!attempt.pipe && !attempt.closed) {
      send({ t: "rtc-fail", id: offer.id, reason: "timeout" });
      closeRtc(attempt);
    }
  }, RTC_OPEN_MS);
  return attempt;
}

export function addRtcCand(attempt: RtcAttempt, cand: { candidate: string; sdpMid: string; sdpMLineIndex?: number } | null): void {
  if (!cand || attempt.closed) return;
  try {
    void attempt.pc.addIceCandidate({
      candidate: cand.candidate,
      sdpMid: cand.sdpMid ?? "0",
      sdpMLineIndex: cand.sdpMLineIndex ?? 0,
    }).catch(() => { /* late or malformed candidate */ });
  } catch {
    // a candidate arriving after close, or a malformed one
  }
}

export function closeRtc(attempt: RtcAttempt): void {
  if (attempt.closed) return;
  attempt.closed = true;
  if (attempt.timer) clearTimeout(attempt.timer);
  try {
    attempt.pipe?.close();
  } catch {}
  try {
    void attempt.pc.close();
  } catch {}
}
