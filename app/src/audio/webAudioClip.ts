import {WSOLA_PROCESSOR_NAME, WSOLA_WORKLET_JS, wsolaStretch} from './wsola';
import {engineCapFetch} from '../engine/contract';
import {cyclog} from '@/shared/logging';

const CtxCtor: typeof AudioContext | undefined =
  window.AudioContext ||
  (window as unknown as {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;

// The playback context exists only while a clip sounds through it. It is made
// by the play that needs it and closed once nothing has sounded for
// PLAYBACK_IDLE_MS. WebKit renders a page's AudioContexts of one format through
// one shared output (SharedAudioDestination), and a context that sat idle for
// the page's life held that output through every background: after an iPhone
// came back, every new microphone context joined it and rendered nothing
// (2026-10-03). Closed, not suspended: suspend() keeps the platform output
// open (WebKit GTK: sink READY), close() releases it (sink NULL).
let ctx: AudioContext | null = null;
// Bumped each time a playback context is made, so a clip holding nodes from a
// released context builds fresh ones on the new one.
let ctxGen = 0;
let unbindKick: (() => void) | null = null;
// Clips sounding through the playback context right now; it is never released
// under one of them.
const sounding = new Set<WebAudioClip>();
// Long enough that a reply queue playing clip after clip, or a seek (stop and
// restart), keeps the one context.
const PLAYBACK_IDLE_MS = 1_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

// Decoding needs no output: an offline context decodes without holding one.
let decoder: OfflineAudioContext | null = null;
const decodeContext = (): OfflineAudioContext => (decoder ??= new OfflineAudioContext(1, 1, 48000));

let workletReady = false;
let workletModulePromise: Promise<boolean> | null = null;
function ensureWorkletModule(ac: AudioContext): Promise<boolean> {
  if (workletReady) return Promise.resolve(true);
  if (workletModulePromise) return workletModulePromise;
  if (!ac.audioWorklet) return Promise.resolve(false);

  const t0 = performance.now();

  const pending = ac.audioWorklet
    .addModule(new URL('cyc-wsola.js', document.baseURI).href)
    .catch(() => {
      const url = URL.createObjectURL(new Blob([WSOLA_WORKLET_JS], {type: 'text/javascript'}));
      return ac.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    })
    .then(() => {
      // Loaded into a context released meanwhile: the current one has no module.
      if (workletModulePromise !== pending) return false;
      workletReady = true;
      cyclog('worklet.compile', {ms: Math.round(performance.now() - t0)});
      return true;
    })
    .catch(() => false);
  workletModulePromise = pending;
  return pending;
}

export async function stretchProbe(): Promise<{worklet: boolean; stretched: number}> {
  const worklet = await ensureWorkletModule(playbackContext());
  armIdleRelease();
  const tone = new Float32Array(4800);
  for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 220 * i) / 48000);
  const out = wsolaStretch([tone], 48000, 2);
  return {worklet, stretched: out[0]?.length ?? 0};
}

function playbackContext(): AudioContext {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (ctx) return ctx;
  const ac = new CtxCtor!();
  ctx = ac;
  ctxGen++;

  const kick = () => {
    if (ac.state !== 'running' && document.visibilityState === 'visible') {
      void ac.resume().catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', kick);
  ac.addEventListener('statechange', kick);
  unbindKick = () => {
    document.removeEventListener('visibilitychange', kick);
    ac.removeEventListener('statechange', kick);
  };
  return ac;
}

function startSounding(clip: WebAudioClip): void {
  sounding.add(clip);
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function stopSounding(clip: WebAudioClip): void {
  if (sounding.delete(clip)) armIdleRelease();
}

function armIdleRelease(): void {
  if (!ctx || sounding.size) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void releasePlaybackContext();
  }, PLAYBACK_IDLE_MS);
}

export function playbackContextOpen(): boolean {
  return !!ctx;
}

// Close the playback context now if nothing sounds through it; the next play
// makes a fresh one. The idle timer does this on its own; the microphone calls
// it too when its graph has stopped delivering audio, so a rebuilt graph never
// joins an output this context holds. Resolves once the context is closed;
// null when a clip is sounding and the context was kept.
export function releasePlaybackContext(): Promise<void> | null {
  if (!ctx) return Promise.resolve();
  if (sounding.size) return null;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const ac = ctx;
  ctx = null;
  unbindKick?.();
  unbindKick = null;
  // The stretch module is loaded per context.
  workletReady = false;
  workletModulePromise = null;
  return ac.close().catch(() => {});
}

// A user gesture: resume the playback context if one is open. None is made
// here; a context made now would sit idle until the next clip.
export async function unlockPlayback(): Promise<void> {
  const ac = ctx;
  if (!ac) return;
  try {
    await Promise.race([ac.resume(), new Promise((resolve) => setTimeout(resolve, 1000))]);
  } catch {}
}

let callPlayback = false;
export function setCallPlayback(on: boolean): void {
  callPlayback = on;
}

export function isCallPlayback(): boolean {
  return callPlayback;
}

const ELEMENT_REPLIES = true;

const SILENT_WAV =
  'data:audio/wav;base64,UklGRmQGAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

type ClipEvent = 'ended' | 'error' | 'timeupdate';

export class WebAudioClip {
  private _src = '';
  private buffer: AudioBuffer | null = null;
  private decodeP: Promise<AudioBuffer> | null = null;
  private decodeGen = 0;
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;

  private worklet: AudioWorkletNode | null = null;
  private workletBuf: AudioBuffer | null = null;
  private workletChannels = 0;
  // The playback context generation `gain` and `worklet` belong to.
  private nodesGen = 0;

  private playingNode: 'buffer' | 'worklet' | null = null;

  private nodeGen = 0;
  private _volume = 1;
  private _rate = 1;
  defaultPlaybackRate = 1;
  private _paused = true;
  private _ended = false;

  private offset = 0;

  private startedAt = 0;

  private audioStarted = false;

  private playIntentAt = 0;
  private _firstAudioMs = -1;

  get firstAudioMs(): number {
    return this._firstAudioMs;
  }
  private playToken = 0;
  private ticker = 0;
  private listeners: Record<ClipEvent, Set<() => void>> = {
    ended: new Set(),
    error: new Set(),
    timeupdate: new Set()
  };
  onended: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;

  private el: HTMLAudioElement | null = null;
  private elMode = false;

  private _backend: '' | 'webaudio' | 'element' = '';
  get backend(): '' | 'webaudio' | 'element' {
    return this._backend;
  }

  private ensureEl(): HTMLAudioElement {
    if (this.el) return this.el;
    const el = document.createElement('audio');

    el.preservesPitch = true;
    (el as HTMLAudioElement & {webkitPreservesPitch?: boolean}).webkitPreservesPitch = true;
    // ManagedMediaSource (how an iPhone streams a reply, audioCache) plays only
    // on an element that opts out of AirPlay.
    el.disableRemotePlayback = true;
    el.addEventListener('ended', () => {
      if (this.elMode && el.src !== SILENT_WAV) this.fire('ended');
    });
    el.addEventListener('error', () => {
      if (this.elMode && el.src !== SILENT_WAV) this.fire('error');
    });
    el.addEventListener('timeupdate', () => {
      if (this.elMode) this.fire('timeupdate');
    });
    this.el = el;
    return el;
  }

  private emptyEl(): void {
    if (!this.el) return;
    try {
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
    } catch {}
  }

  get src(): string {
    return this._src;
  }

  set src(url: string) {
    this.stopSource();
    ++this.playToken;
    this._src = url;
    this._paused = true;
    this._ended = false;
    this.offset = 0;
    this._rate = this.defaultPlaybackRate;
    this.buffer = null;
    const gen = ++this.decodeGen;
    this.decodeP = null;

    const wasEl = this.elMode;
    this.elMode = !!url && (callPlayback || ELEMENT_REPLIES);
    if (wasEl && !this.elMode) this.emptyEl();
    if (!url) return;
    if (this.elMode) {
      const el = this.ensureEl();
      el.defaultPlaybackRate = this.defaultPlaybackRate;
      el.playbackRate = this._rate;
      el.volume = this._volume;
      el.src = url;
      return;
    }

    const p = this.fetchDecode(url, gen);
    p.catch(() => {});
    this.decodeP = p;
  }

  private async fetchDecode(url: string, gen: number): Promise<AudioBuffer> {
    try {
      const res = /^https?:/i.test(url)
        ? await engineCapFetch(url, {signal: AbortSignal.timeout(20_000)})
        : await fetch(url, {signal: AbortSignal.timeout(20_000)});
      if (!res.ok) throw new Error(`audio ${res.status}`);
      const bytes = await res.arrayBuffer();
      const buf = await decodeContext().decodeAudioData(bytes);
      if (gen === this.decodeGen) {
        this.buffer = buf;

        this.prewarmWorklet();
      }
      return buf;
    } catch (err) {
      if (gen === this.decodeGen)
        queueMicrotask(() => {
          if (gen === this.decodeGen) this.fire('error');
        });
      throw err;
    }
  }

  get duration(): number {
    if (this.elMode) return this.el!.duration;
    return this.buffer ? this.buffer.duration : NaN;
  }

  get waitingFirstAudio(): boolean {
    return (
      !this.elMode &&
      !this._paused &&
      !this._ended &&
      !this.audioStarted &&
      this.playingNode !== 'buffer'
    );
  }
  get paused(): boolean {
    return this.elMode ? this.el!.paused : this._paused;
  }
  get ended(): boolean {
    return this.elMode ? this.el!.ended : this._ended;
  }

  get volume(): number {
    return this._volume;
  }
  set volume(v: number) {
    this._volume = v;
    if (this.gain) this.gain.gain.value = v;
    if (this.el) this.el.volume = v;
  }

  get currentTime(): number {
    if (this.elMode) return this.el!.currentTime;

    if (!this.playingNode || this._paused || !this.audioStarted) return this.offset;

    const t = this.offset + ((ctx?.currentTime ?? this.startedAt) - this.startedAt) * this._rate;
    return this.buffer ? Math.min(t, this.buffer.duration) : t;
  }
  set currentTime(t: number) {
    if (this.elMode) {
      try {
        this.el!.currentTime = Math.max(0, t);
      } catch {}
      return;
    }
    const to = Math.max(0, t);
    this._ended = false;
    if (this.playingNode && !this._paused && this.buffer) this.startAt(to);
    else this.offset = this.buffer ? Math.min(to, this.buffer.duration) : to;
  }

  get playbackRate(): number {
    return this.elMode ? this.el!.playbackRate : this._rate;
  }
  set playbackRate(rate: number) {
    if (!rate || !isFinite(rate)) return;
    if (this.elMode) {
      this._rate = rate;
      try {
        this.el!.playbackRate = rate;
      } catch {}
      return;
    }
    const playing = this.playingNode && !this._paused;

    const at = playing ? this.currentTime : this.offset;
    this._rate = rate;

    if (playing && this.buffer) {
      this.offset = at;
      this.startAt(at);
    } else if (rate !== 1 && this.buffer && ctx) {
      void ensureWorkletModule(ctx).then((ok) => {
        if (ok && this._rate === rate && !(this.playingNode && !this._paused))
          this.prewarmWorklet();
      });
    }
  }

  async play(): Promise<void> {
    if (this.elMode) {
      this._backend = 'element';
      cyclog('clip.audio', {
        backend: 'element',
        rate: this._rate,
        from: Math.round((this.el?.currentTime || 0) * 10) / 10
      });
      return this.el!.play();
    }
    this._backend = 'webaudio';

    this.playIntentAt = performance.now();
    this._firstAudioMs = -1;
    cyclog('clip.audio', {
      backend: 'webaudio',
      rate: this._rate,
      bytes: this.buffer ? this.buffer.length * this.buffer.numberOfChannels * 4 : null,

      from: Math.round(this.offset * 10) / 10
    });
    const token = ++this.playToken;

    this._paused = false;
    this._ended = false;

    this.audioStarted = false;
    try {
      const ac = playbackContext();
      if (ac.state !== 'running') {
        try {
          await Promise.race([ac.resume(), new Promise((_, reject) => setTimeout(reject, 250))]);
        } catch {}

        const state = ac.state as AudioContextState;
        if (state !== 'running') {
          throw new DOMException('play() requires a user gesture first', 'NotAllowedError');
        }
      }
      if (!this.buffer) {
        if (!this.decodeP) throw new DOMException('no source', 'NotSupportedError');
        await this.decodeP;
      }

      if (this._rate !== 1) await ensureWorkletModule(ac);
      if (token !== this.playToken || !this.buffer) {
        throw new DOMException('play() was superseded', 'AbortError');
      }
      if (this.offset >= this.buffer.duration) this.offset = 0;
      this.startAt(this.offset);
    } catch (err) {
      if (token === this.playToken) this._paused = true;
      // The context this play made has nothing sounding through it.
      armIdleRelease();
      throw err;
    }
  }

  pause(): void {
    ++this.playToken;
    if (this.elMode) {
      try {
        this.el!.pause();
      } catch {}
      return;
    }
    if (this.playingNode && !this._paused) this.offset = this.currentTime;
    this.stopSource();
    this._paused = true;
  }

  clear(): void {
    ++this.playToken;
    ++this.decodeGen;
    this.stopSource();
    this.workletBuf = null;
    this.emptyEl();
    this.elMode = false;
    this._src = '';
    this.buffer = null;
    this.decodeP = null;
    this.offset = 0;
    this._paused = true;
    this._ended = false;
    this._rate = this.defaultPlaybackRate;
  }

  async unlock(): Promise<void> {
    if (this._src) return;
    const el = this.ensureEl();
    el.volume = this._volume;
    el.src = SILENT_WAV;
    try {
      await el.play();
    } catch {}
    if (el.src === SILENT_WAV && !this._src) this.emptyEl();
  }

  addEventListener(ev: ClipEvent, fn: () => void): void {
    this.listeners[ev].add(fn);
  }
  removeEventListener(ev: ClipEvent, fn: () => void): void {
    this.listeners[ev].delete(fn);
  }

  private fire(ev: ClipEvent): void {
    for (const fn of this.listeners[ev]) fn();
    if (ev === 'ended') this.onended?.();
    else if (ev === 'timeupdate') this.ontimeupdate?.();
  }

  // Nodes made on a released context cannot connect to the current one.
  private nodesFor(ac: AudioContext): AudioContext {
    if (this.nodesGen !== ctxGen) {
      this.gain = null;
      if (this.worklet) this.worklet.port.onmessage = null;
      this.worklet = null;
      this.workletBuf = null;
      this.nodesGen = ctxGen;
    }
    return ac;
  }

  private startAt(offset: number): void {
    const ac = this.nodesFor(playbackContext());
    this.stopSource();
    const buf = this.buffer!;
    const at = Math.min(Math.max(0, offset), Math.max(0, buf.duration - 0.001));
    if (!this.gain) {
      this.gain = ac.createGain();
      this.gain.connect(ac.destination);
    }
    this.gain.gain.value = this._volume;

    if (this._rate !== 1 && workletReady) {
      this.startWorklet(ac, buf, at);
      return;
    }
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = this._rate;
    src.connect(this.gain);
    src.onended = () => {
      if (this.source !== src) return;
      try {
        src.disconnect();
      } catch {}
      this.endReached();
    };
    src.start(0, at);
    this.source = src;
    this.playingNode = 'buffer';
    startSounding(this);
    this.offset = at;
    this.startedAt = ac.currentTime;

    this.audioStarted = true;
    if (this.playIntentAt) {
      this._firstAudioMs = Math.round(performance.now() - this.playIntentAt);
      cyclog('clip.first-audio', {ms: this._firstAudioMs, rate: this._rate});
      this.playIntentAt = 0;
    }
    this._paused = false;
    this._ended = false;
    this.startTicker();
  }

  private prewarmWorklet(): void {
    // Only onto an open context: one made here would sit idle until a play.
    if (this.elMode || this._rate === 1 || !this.buffer || !workletReady || !ctx) return;
    const ac = this.nodesFor(ctx);
    const node = this.ensureWorkletNode(ac, this.buffer);
    node.port.postMessage({type: 'prewarm', tempo: this._rate});
  }

  private startWorklet(ac: AudioContext, buf: AudioBuffer, at: number): void {
    const node = this.ensureWorkletNode(ac, buf);
    const gen = ++this.nodeGen;
    try {
      node.disconnect();
    } catch {}
    node.connect(this.gain!);
    node.port.postMessage({type: 'start', offset: at, tempo: this._rate, gen});
    this.playingNode = 'worklet';
    startSounding(this);
    this.offset = at;

    this.audioStarted = false;
    this.startedAt = ac.currentTime;
    this._paused = false;
    this._ended = false;
    this.startTicker();
  }

  private ensureWorkletNode(ac: AudioContext, buf: AudioBuffer): AudioWorkletNode {
    if (this.worklet && this.workletChannels !== buf.numberOfChannels) {
      try {
        this.worklet.disconnect();
      } catch {}
      this.worklet.port.onmessage = null;
      this.worklet = null;
      this.workletBuf = null;
    }
    if (!this.worklet) {
      this.worklet = new AudioWorkletNode(ac, WSOLA_PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [buf.numberOfChannels]
      });
      this.workletChannels = buf.numberOfChannels;
      this.worklet.port.onmessage = (e) => {
        const m = e.data as {type?: string; gen?: number};
        if (!m || m.gen !== this.nodeGen || this.playingNode !== 'worklet') return;
        if (m.type === 'started') {
          this.startedAt = ctx?.currentTime ?? 0;
          this.audioStarted = true;
          if (this.playIntentAt) {
            this._firstAudioMs = Math.round(performance.now() - this.playIntentAt);
            cyclog('clip.first-audio', {ms: this._firstAudioMs, rate: this._rate});
            this.playIntentAt = 0;
          }
        } else if (m.type === 'ended') {
          this.endReached();
        }
      };
    }
    if (this.workletBuf !== buf) {
      const channels: Float32Array[] = [];
      for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c).slice());
      this.worklet.port.postMessage({type: 'load', channels, sampleRate: buf.sampleRate});
      this.workletBuf = buf;
    }
    return this.worklet;
  }

  private endReached(): void {
    this.playingNode = null;
    this.source = null;
    stopSounding(this);
    this.offset = this.buffer ? this.buffer.duration : this.offset;
    this._paused = true;
    this._ended = true;
    this.stopTicker();
    this.fire('timeupdate');
    this.fire('ended');
  }

  private stopSource(): void {
    this.stopTicker();
    if (this.playingNode === 'worklet' && this.worklet) {
      ++this.nodeGen;
      try {
        this.worklet.port.postMessage({type: 'stop'});
      } catch {}
      try {
        this.worklet.disconnect();
      } catch {}
    }
    const src = this.source;
    this.source = null;
    this.playingNode = null;
    stopSounding(this);
    if (src) {
      try {
        src.stop();
      } catch {}
      try {
        src.disconnect();
      } catch {}
    }
  }

  private startTicker(): void {
    this.stopTicker();
    this.ticker = window.setInterval(() => this.fire('timeupdate'), 250);
  }
  private stopTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = 0;
    }
  }
}
