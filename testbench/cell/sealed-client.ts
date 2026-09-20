/* The bench's sealed client: one device dialing the engine like the real app.
 *
 * WHY THIS EXISTS (engine finding, lane 1): the engine's own test-side shim
 * (src/e2e/testclient.ts, installed by testpreload.ts) still builds its
 * PeerConnection with `node-datachannel` (an undeclared dependency) and then
 * wraps it with adaptDc/adaptPc from src/transport/rtc.ts, which since the
 * werift swap expect werift objects (`dc.onMessage.subscribe`). On today's
 * tree that dial throws `dc.onMessage.subscribe is not a function`, so
 * harness.ts openSealedClient cannot open a sealed channel at all. This file
 * mirrors the shim's flow on werift, the engine's declared dependency, and
 * reuses every engine piece that still works as a library: adaptDc, adaptPc,
 * dcPipe, SecureChannel, and the shim's own sealedSecOk (the key-required
 * pair proof from the engine's keys.json, registered by engine-boot).
 *
 * Signaling is the engine's plain WS at ws://127.0.0.1:port/ws (loopback-only
 * by routeRequest). The engine advertises loopback plus the address in the
 * signaling Host header (rtc-glue reachedAddrOf); werift gathers no loopback
 * candidate on either side, so `reached` (the cell's dummy-interface address)
 * goes into that header and is the one candidate pair that connects.
 *   -> {t:"rtc-offer", id, sdp}   -> {t:"rtc-cand", id, cand}
 *   <- {t:"rtc-answer", id, sdp}  <- {t:"rtc-cand", id, cand|null}
 * Then over the DataChannel: hello{sec} -> sec (v2) -> sec-ok -> sec-done,
 * after which every frame is sealed (t:"x") both ways. */

import { join } from "node:path";
import { dcPipe, type Pipe } from "../../engine/agent-engine/src/transport/dcpipe.ts";
import { adaptDc, adaptPc } from "../../engine/agent-engine/src/transport/rtc.ts";
import { sealedSecOk } from "../../engine/agent-engine/src/e2e/testclient.ts";
import { SecureChannel, newIdentity, type EngineIdentity, type SecFrame, type SealedFrame } from "../../engine/shared/e2e.ts";

let werift: any = null;
async function loadWerift(): Promise<any> {
  if (werift) return werift;
  /* resolve from the engine package, wherever this file was staged */
  const parent = join(import.meta.dir, "..", "..", "engine", "agent-engine");
  werift = await import(Bun.resolveSync("werift", parent));
  return werift;
}

/* one device identity per process: repeat connects are one recognised device */
let dev: Promise<EngineIdentity> | null = null;
const device = () => (dev ??= newIdentity(true));

let seq = 0;
/* loopback offers collide when several dial at once in one process */
let lock: Promise<void> = Promise.resolve();

export type SealedClient = {
  id: string;
  /** an opened application frame from the engine */
  onmessage: ((frame: Record<string, any>) => void) | null;
  onclose: ((why: string) => void) | null;
  send(frame: Record<string, any>): void;
  close(): void;
  readonly open: boolean;
};

export type DialOpts = { label?: string; ms?: number; /** ICE address named in the Host header */ reached?: string };

export async function dialSealed(url: string, opts: DialOpts = {}): Promise<SealedClient> {
  const run = lock.then(() => dialOnce(url, opts), () => dialOnce(url, opts));
  lock = run.then(() => {}, () => {});
  return run;
}

async function dialOnce(url: string, opts: DialOpts): Promise<SealedClient> {
  const W = await loadWerift();
  const port = Number(new URL(url).port);
  const id = `tb${++seq}`;
  const ms = opts.ms ?? 15_000;
  let closed = false;
  let pipe: Pipe | null = null;
  let chan: SecureChannel | null = null;
  let secReady = false;
  const pending: Record<string, any>[] = [];
  let sealChain: Promise<unknown> = Promise.resolve();
  /* frames opened before the caller sets onmessage (the hello burst can land
   * right behind sec-done) wait here, in order */
  const inbox: Record<string, any>[] = [];
  let onmessage: SealedClient["onmessage"] = null;
  const deliver = (f: Record<string, any>) => { if (onmessage) onmessage(f); else inbox.push(f); };
  const client: SealedClient = {
    id, onclose: null,
    get onmessage() { return onmessage; },
    set onmessage(cb) { onmessage = cb; if (cb) for (const f of inbox.splice(0)) cb(f); },
    get open() { return secReady && !closed; },
    send(frame) {
      if (!secReady) { pending.push(frame); return; }
      sealChain = sealChain.then(async () => {
        if (!chan || !pipe || closed) return;
        pipe.send(JSON.stringify(await chan.seal(frame)));
      });
    },
    close() { shutdown("closed by test"); },
  };
  const host = opts.reached && opts.reached !== "127.0.0.1" ? `${opts.reached}:${port}` : null;
  /* Bun's WebSocket takes request headers; the engine reads Host for reachedAddr */
  const sig = host ? new WebSocket(url, { headers: { host } } as any) : new WebSocket(url);
  const pc = new W.RTCPeerConnection({ iceServers: [] });
  const shutdown = (why: string) => {
    if (closed) return;
    closed = true;
    try { pipe?.close(); } catch { /* gone */ }
    try { void pc.close(); } catch { /* gone */ }
    try { sig.close(); } catch { /* gone */ }
    client.onclose?.(why);
  };
  const sigSend = (o: unknown) => {
    const s = JSON.stringify(o);
    if (sig.readyState === 1) sig.send(s);
    else sig.addEventListener("open", () => { try { sig.send(s); } catch { /* closing */ } }, { once: true });
  };
  await new Promise<void>((res, rej) => {
    sig.onopen = () => res();
    sig.onerror = () => rej(new Error(`signaling socket failed: ${url}`));
  });
  sig.onmessage = (ev) => {
    let m: any;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.t === "rtc-answer" && m.id === id) void pc.setRemoteDescription({ type: "answer", sdp: m.sdp }).catch(() => {});
    else if (m.t === "rtc-cand" && m.id === id && m.cand)
      void pc.addIceCandidate({ candidate: m.cand.candidate, sdpMid: m.cand.sdpMid ?? "0", sdpMLineIndex: m.cand.sdpMLineIndex ?? 0 }).catch(() => {});
    else if (m.t === "rtc-fail" && m.id === id) shutdown(`rtc-fail ${m.reason}`);
  };
  sig.onclose = () => shutdown("signaling socket closed");
  pc.onIceCandidate.subscribe((cand: any) => {
    if (cand) sigSend({ t: "rtc-cand", id, cand: { candidate: String(cand.candidate ?? ""), sdpMid: cand.sdpMid ?? "0", sdpMLineIndex: 0 } });
  });
  /* the pre-negotiated stream-0 channel, the shape the browser creates */
  const dc = pc.createDataChannel("cyc", { ordered: true, negotiated: true, id: 0 });
  pipe = dcPipe(adaptDc(dc), adaptPc(pc));
  await pc.setLocalDescription(await pc.createOffer());
  sigSend({ t: "rtc-offer", id, sdp: pc.localDescription.sdp });

  await Promise.race([
    new Promise<void>((r) => (pipe!.open ? r() : (pipe!.onopen = () => r()))),
    new Promise<void>((_, rej) => setTimeout(() => rej(new Error(`DataChannel never opened in ${ms}ms`)), ms)),
  ]);

  /* the client half of the sec handshake, exactly as the shim runs it */
  const me = await device();
  const offer = await SecureChannel.offer();
  const done = new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`sec handshake did not finish in ${ms}ms`)), ms);
    pipe!.onmessage = async (raw: string) => {
      let m: any;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.v === 2 && m.ee) {
        chan = await SecureChannel.accept(offer, m as SecFrame, null);
        pipe!.send(JSON.stringify(await sealedSecOk(chan, me, opts.label ?? "testbench", port)));
        return;
      }
      if (m.t === "x" && chan) {
        const inner = await chan.open(m as SealedFrame);
        if (!inner) return;
        if (inner.t === "sec-done") {
          secReady = true;
          clearTimeout(t);
          for (const f of pending.splice(0)) client.send(f);
          res();
          return;
        }
        deliver(inner as Record<string, any>);
      }
    };
    pipe!.onclose = (code, reason) => shutdown(`pipe closed ${code} ${reason}`);
  });
  pipe.send(JSON.stringify({ t: "hello", sec: offer.hello }));
  await done;
  return client;
}
