/* THE TEST-SIDE TRANSPORT SEAM (lane #579).
 *
 * The engine test files open a client with `new WebSocket(url)` and expect to
 * speak `hello` on the wire and get the burst back. #579 moved that
 * wire off the WebSocket and onto a WebRTC DataChannel: a plain WS `hello` is
 * now refused with `transport-required` + close 4426. Rather than rewrite every
 * test file, the swap happens HERE: `globalThis.WebSocket` is this class, so
 * every `new WebSocket(url)` in a test goes through it.
 *
 * WHAT IT DOES NOW (no longer a passthrough): the FIRST frame a caller
 * sends decides the mode.
 *   - first frame `hello`  -> RTC. The shim swallows that hello, dials a real
 *     werift DataChannel to the engine over this same socket (signaling; the
 *     same pre-negotiated stream-0 `cyc` channel the browser dialer makes),
 *     runs the CLIENT half of the v2 sec handshake (sec-ok carries
 *     the key-required pair proof from the engine's registered e2e.json), and
 *     from then on seals every `send()` over the pipe and opens every sealed
 *     frame up to `onmessage`. The caller sees the identical WebSocket surface.
 *   - any other first frame (`register` for a session, `rtc-offer` for a
 *     transport test that drives its OWN DataChannel) -> WS passthrough: the
 *     socket is a plain native WebSocket, exactly as before.
 *
 * The engine itself is a separate `bun run server.ts` subprocess
 * (notify-harness.ts), which never loads the `[test]` preload, so server-side
 * sockets are untouched. A test that wants the RAW WS (to prove the 4426
 * refusal, e.g. wsflip.test.ts) uses `TestClient.Native`.
 */

import { dcPipe, type Pipe } from "../transport/dcpipe.ts";
import { loadRtc, adaptDc, adaptPc } from "../transport/rtc.ts";
import { rtpDepacketize, rtpPacketize, newRtpSender, type RtpSender } from "../voice/rtp.ts";
import { OPUS_FRAME_SAMPLES } from "../voice/opus.ts";
import { existsSync } from "node:fs";
import { loadOrCreateE2E, newestGen } from "../security/sec.ts";
import {
  newIdentity,
  SecureChannel,
  signId,
  secTranscript,
  b64encode,
  derivePairKey,
  secPairTag,
  type EngineIdentity,
  type SecFrame,
  type SealedFrame,
} from "../../../shared/e2e.ts";

/** The real WebSocket, captured before the preload installs this shim over
 * `globalThis.WebSocket`. Tests that need the raw wire use `TestClient.Native`. */
const NativeWebSocket = globalThis.WebSocket;

const te = new TextEncoder();
let CID = 0;

/* One device identity per test process, so repeat connects behave like one
 * real device: the engine enrols it once (sec-done.paired true), and every
 * later connect from this same process is a recognised reconnect (paired
 * false, one device row) -- the real app's behaviour. */
let sharedDev: Promise<EngineIdentity> | null = null;
function device(): Promise<EngineIdentity> {
  return (sharedDev ??= newIdentity(true));
}

/* startEngine registers the throwaway .run/e2e.json by listen port so the
 * shim (and any other sealed-client helper) can mint sec-ok.pair from a live
 * content generation. Unknown devices enrol only with that proof. */
const e2eByPort = new Map<number, string>();

export function registerEngineE2E(port: number, e2ePath: string): void {
  e2eByPort.set(port, e2ePath);
}

export function unregisterEngineE2E(port: number): void {
  e2eByPort.delete(port);
}

export function portOfEngineUrl(url: string): number {
  try {
    return Number(new URL(url).port);
  } catch {
    return 0;
  }
}

export async function pairTagForPort(port: number, transcript: string): Promise<string> {
  const path = e2eByPort.get(port);
  if (!path) throw new Error(`no e2e.json registered for engine port ${port}`);
  for (let i = 0; i < 40; i++) {
    if (existsSync(path)) {
      const st = await loadOrCreateE2E(path);
      return secPairTag(await derivePairKey(newestGen(st).key), transcript);
    }
    await Bun.sleep(50);
  }
  throw new Error(`e2e.json not ready at ${path}`);
}

/** The device half of sec-ok: identity sig + key-required pair proof. */
export async function sealedSecOk(
  chan: SecureChannel,
  dev: EngineIdentity,
  label: string,
  port: number,
): Promise<SealedFrame> {
  const t = chan.transcript();
  const transcript = secTranscript("c", t.ce, t.ee, t.cn, t.en, t.id);
  const sig = b64encode(await signId(dev.keyPair.privateKey, te.encode(transcript)));
  const pair = await pairTagForPort(port, transcript);
  return chan.seal({ t: "sec-ok", dev: dev.spki, sig, label, pair });
}

let werift: any = null;
/* Loopback offers collide when many tests dial at once in one process (shim DC
 * never opened). One in-flight dial at a time. */
let dialLock: Promise<void> = Promise.resolve();
function withDialLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = dialLock.then(fn, fn);
  dialLock = run.then(() => {}, () => {});
  return run;
}

type Listener = (ev: any) => void;

/* A real WebRTC audio peer on the test client's own PeerConnection (the voice
 * crux e2e). The offer carries an m=audio sendrecv transceiver
 * beside the cyc DataChannel; this drives that track with real Opus/RTP over
 * real DTLS-SRTP on loopback. The Opus codec itself lives in the test so it can
 * assert on the payloads it sends and receives. */
export type VoicePeer = {
  /** packetize one Opus frame into RTP and put it on the track (uplink). */
  sendOpus(payload: Uint8Array): void;
  /** every uplink-mirrored / downlink Opus payload the track delivers,
   *  depacketized (the RTP header stripped). */
  onOpus(cb: (payload: Uint8Array) => void): void;
  /** the peer's own DTLS fp (from its offer SDP), colon-hex upper. */
  localFp(): string | null;
  /** the engine's DTLS fp as this peer saw it over DTLS. */
  remoteFp(): string | null;
  trackOpen(): boolean;
};

type VoiceState = {
  track: any;
  pc: any;
  sender: RtpSender;
  onOpus: ((p: Uint8Array) => void) | null;
};

export class TestClient {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  /** the real WebSocket, for a test that must speak the raw wire */
  static Native = NativeWebSocket;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  url: string;
  readyState = 0;
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onclose: Listener | null = null;
  onerror: Listener | null = null;

  private sig: WebSocket; // native signaling (RTC) / data (passthrough) socket
  private mode: "pending" | "ws" | "rtc" = "pending";
  private buf: string[] = []; // frames sent before the socket / pipe is ready
  private listeners = new Map<string, Set<Listener>>();
  private id = `tc${++CID}`;

  // RTC state
  private pc: any = null;
  private pipe: Pipe | null = null;
  private chan: SecureChannel | null = null;
  private secReady = false;
  private sealChain: Promise<unknown> = Promise.resolve();

  // Voice state: opt-in, wired before the hello triggers the dial.
  private voiceEnabled = false;
  private voice: VoiceState | null = null;

  /** Turn this client into a voice peer: its offer will carry an m=audio track.
   *  Must be called BEFORE the first `hello` send (which triggers the dial).
   *  Returns the handle a test drives the track with. */
  enableVoice(): VoicePeer {
    this.voiceEnabled = true;
    const self = this;
    return {
      sendOpus(payload: Uint8Array) {
        const v = self.voice;
        if (!v) return;
        const pkt = rtpPacketize(v.sender, payload, OPUS_FRAME_SAMPLES);
        try { v.track.writeRtp(Buffer.from(pkt.buffer, pkt.byteOffset, pkt.byteLength)); } catch {}
      },
      onOpus(cb) { if (self.voice) self.voice.onOpus = cb; else self.pendingOnOpus = cb; },
      localFp() { return self.voiceLocalFp(); },
      remoteFp() {
        try {
          const sdp = self.voice?.pc.remoteDescription?.sdp ?? "";
          const m = /a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)/.exec(sdp);
          return m ? m[1].toUpperCase() : null;
        } catch { return null; }
      },
      trackOpen() { return !!self.voice; },
    };
  }
  private pendingOnOpus: ((p: Uint8Array) => void) | null = null;

  private voiceLocalFp(): string | null {
    try {
      const sdp = this.voice?.pc.localDescription?.sdp ?? "";
      const m = /a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)/.exec(sdp);
      return m ? m[1].toUpperCase() : null;
    } catch { return null; }
  }

  constructor(url: string | URL) {
    this.url = String(url);
    this.sig = new NativeWebSocket(url);
    this.sig.onopen = () => {
      this.readyState = 1;
      this.fire("open", {});
      if (this.mode === "ws") this.drainWs();
    };
    this.sig.onerror = (ev: any) => this.fire("error", ev);
    this.sig.onclose = (ev: any) => {
      // in RTC mode the signaling socket closing (4426 never happens here, since
      // the shim never sends a plain hello) is the engine tearing us down.
      this.readyState = 3;
      this.fire("close", ev);
    };
    this.sig.onmessage = (ev: any) => this.onSig(ev);
  }

  // ---- the WebSocket surface tests use --------------------------------------

  send(data: any): void {
    const s = typeof data === "string" ? data : String(data);
    if (this.mode === "pending") {
      let f: any = null;
      try { f = JSON.parse(s); } catch {}
      if (f && f.t === "hello") {
        // swallow the caller's hello; the shim runs the real hello{sec} itself.
        this.mode = "rtc";
        void this.dial();
        return;
      }
      this.mode = "ws"; // register / rtc-offer / anything else: raw passthrough
    }
    if (this.mode === "ws") {
      if (this.sig.readyState === 1) this.sig.send(s);
      else this.buf.push(s);
      return;
    }
    // rtc: seal and send over the pipe once sec is up, else buffer in order
    if (this.secReady) this.seal(s);
    else this.buf.push(s);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    try { this.pipe?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    try { this.sig.close(code, reason); } catch {}
  }

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  private fire(type: string, ev: any): void {
    const on = (this as any)[`on${type}`] as Listener | null;
    try { on?.(ev); } catch {}
    const set = this.listeners.get(type);
    if (set) for (const fn of set) { try { fn(ev); } catch {} }
  }

  // ---- WS passthrough -------------------------------------------------------

  private drainWs(): void {
    for (const s of this.buf) this.sig.send(s);
    this.buf = [];
  }

  private onSig(ev: any): void {
    if (this.mode === "ws") {
      // deliver raw data frames to the caller verbatim
      this.fire("message", ev);
      return;
    }
    // rtc mode: this socket is signaling only -> rtc-answer / rtc-cand
    let m: any;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.t === "rtc-answer") {
      void this.pc?.setRemoteDescription({ type: "answer", sdp: m.sdp }).catch(() => {});
    } else if (m.t === "rtc-cand" && m.cand) {
      void this.pc?.addIceCandidate({ candidate: m.cand.candidate, sdpMid: m.cand.sdpMid ?? "0",
        sdpMLineIndex: m.cand.sdpMLineIndex ?? 0 }).catch(() => {});
    }
  }

  // ---- RTC dial + client-side sec handshake ---------------------------------

  private async dial(): Promise<void> {
    try {
      await withDialLock(() => this.dialLocked());
    } catch (err) {
      console.error("[testclient] dial/handshake failed", String(err));
      this.fire("error", { message: String(err) });
    }
  }

  private async dialLocked(): Promise<void> {
    if (!werift) werift = await import("werift");
    await loadRtc();
    /* Voice used to ride a node-datachannel m=audio track. The engine's werift
     * media path is the owner-deferred upgrade (rtc.ts: track stays null), so
     * a voice peer cannot be dialled here yet; say so instead of hanging. */
    if (this.voiceEnabled) {
      throw new Error("TestClient.enableVoice: no werift media track yet (engine rtc.ts: owner-deferred)");
    }
    const pc = new werift.RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    /* Candidates gathered before the offer is on the wire are queued: the
     * engine drops an rtc-cand for an id it has no attempt for. */
    let offerSent = false;
    const pending: any[] = [];
    pc.onIceCandidate.subscribe((cand: any) => {
      if (!cand) return;
      const f = { t: "rtc-cand", id: this.id, cand: { candidate: String(cand.candidate ?? ""),
        sdpMid: cand.sdpMid ?? "0", sdpMLineIndex: 0 } };
      if (offerSent) this.sigSend(f); else pending.push(f);
    });
    // The pre-negotiated stream-0 channel, the shape the browser dialer creates
    // and the engine mints its pipe on (rtc.ts onRtcOffer).
    const dc = pc.createDataChannel("cyc", { ordered: true, negotiated: true, id: 0 });
    const pipe = dcPipe(adaptDc(dc), adaptPc(pc));
    this.pipe = pipe;
    // createDataChannel first, then the offer, so the m=application section is in it.
    await pc.setLocalDescription(await pc.createOffer());
    this.sigSend({ t: "rtc-offer", id: this.id, sdp: pc.localDescription.sdp });
    offerSent = true;
    for (const f of pending.splice(0)) this.sigSend(f);
    await Promise.race([
      new Promise<void>((r) => (pipe.open ? r() : (pipe.onopen = () => r()))),
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error("shim DC never opened")), 12_000)),
    ]);
    await this.handshake(pipe);
  }

  /** send a signaling frame; the signaling socket may not be open yet */
  private sigSend(o: any): void {
    const s = JSON.stringify(o);
    if (this.sig.readyState === 1) this.sig.send(s);
    else this.sig.addEventListener("open", () => { try { this.sig.send(s); } catch {} }, { once: true } as any);
  }

  /** the CLIENT half of the sealed handshake, over the opened pipe */
  private async handshake(pipe: Pipe): Promise<void> {
    const dev = await device();
    const offer = await SecureChannel.offer();
    pipe.onmessage = async (raw) => {
      let m: any;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.v === 2 && m.ee) {
        this.chan = await SecureChannel.accept(offer, m as SecFrame, null);
        pipe.send(JSON.stringify(await sealedSecOk(this.chan, dev, "test-client", portOfEngineUrl(this.url))));
        return;
      }
      if (m.t === "x" && this.chan) {
        const inner = await this.chan.open(m as SealedFrame);
        if (!inner) return;
        if (inner.t === "sec-done") {
          this.secReady = true;
          // flush any frames the caller sent before sec was ready, in order
          const pending = this.buf;
          this.buf = [];
          for (const s of pending) this.seal(s);
          return;
        }
        // an opened application frame -> up to the caller as a normal message
        this.fire("message", { data: JSON.stringify(inner) });
      }
    };
    pipe.send(JSON.stringify({ t: "hello", sec: offer.hello }));
  }

  /** seal one caller frame and send it, preserving counter == wire order */
  private seal(s: string): void {
    this.sealChain = this.sealChain.then(async () => {
      if (!this.chan || !this.pipe) return;
      let frame: any;
      try { frame = JSON.parse(s); } catch { return; }
      this.pipe.send(JSON.stringify(await this.chan.seal(frame)));
    });
  }
}
