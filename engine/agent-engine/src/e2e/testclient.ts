/* Test clients use the real app-server relay and unchanged sealed handshake.
 * Raw loopback register traffic remains native, for MCP/session tests. */
import {wsPipe, type Pipe} from "../../../shared/ws-pipe";
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
const relayByPort = new Map<number, string>();

export function registerEngineE2E(port: number, e2ePath: string, relayUrl: string): void {
  e2eByPort.set(port, e2ePath);
  relayByPort.set(port, relayUrl);
}

export function unregisterEngineE2E(port: number): void {
  e2eByPort.delete(port);
  relayByPort.delete(port);
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

type Listener = (ev: any) => void;

/** Raw authenticated WS for tests inspecting the sealed wire itself. */
export async function openRelayPipe(engineUrl: string): Promise<Pipe> {
  const port = portOfEngineUrl(engineUrl);
  const path = e2eByPort.get(port);
  const base = relayByPort.get(port);
  if (!path || !base) throw new Error("scratch relay not registered");
  const st = await loadOrCreateE2E(path);
  const dev = await device();
  const url = new URL("/device", base.replace(/^http/, "ws"));
  url.searchParams.set("engine", st.engineId);
  const pipe = wsPipe(new NativeWebSocket(url.toString()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { pipe.close(4401, "auth-timeout"); reject(new Error("auth-timeout")); }, 15_000);
    pipe.onclose = (code) => { clearTimeout(timer); reject(new Error("relay closed: " + code)); };
    pipe.onmessage = (raw) => {
      const m = JSON.parse(raw);
      if (m.t === "r-challenge") void signId(dev.keyPair.privateKey,
        te.encode(`${m.nonce}|${st.engineId}|cyc-relay-auth-v1`)).then((sig) => {
          pipe.send(JSON.stringify({t: "r-auth", spki: dev.spki, sig: b64encode(sig)}));
        });
      else if (m.t === "r-ok") { clearTimeout(timer); pipe.onmessage = null; pipe.onclose = null; resolve(); }
    };
  });
  return pipe;
}

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
  private mode: "pending" | "ws" | "sealed" = "pending";
  private buf: string[] = []; // frames sent before the socket / pipe is ready
  private listeners = new Map<string, Set<Listener>>();
  private id = `tc${++CID}`;

  // RTC state
  private pipe: Pipe | null = null;
  private chan: SecureChannel | null = null;
  private secReady = false;
  private sealChain: Promise<unknown> = Promise.resolve();

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
        this.mode = "sealed";
        void this.dial();
        return;
      }
      this.mode = "ws"; // register / anything else: raw passthrough
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
  }

  private async dial(): Promise<void> {
    try {
      const pipe = await openRelayPipe(this.url);
      this.pipe = pipe;
      pipe.onclose = (code, reason) => { this.readyState = 3; this.fire("close", {code, reason}); };
      await this.handshake(pipe);
    } catch (err) {
      this.fire("error", {message: String(err)});
      this.close(4401, "handshake-failed");
    }
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
