import {speaker} from './speaker';
import {playbackContextOpen, releasePlaybackContext, setCallPlayback} from './webAudioClip';
import {releaseToneContext, toneContextOpen} from './turnTones';
import {Pcm16kChunker, PCM_TAP_PROCESSOR_NAME, PCM_TAP_WORKLET_JS, STT_RATE} from './pcm';
import {openSttStream} from '../engine/store/audioDocs';
import {transcriptAtRelease} from './releaseDecode';
import type {SttStream, SttStreamHandlers} from '../engine/contract';
import {cyclog, newCid} from '@/shared/logging';
import {
  applyMicFix,
  canRecord,
  decideMicFix,
  isMicLive,
  readContextState,
  readTrackReadyState,
  type GraphFlow,
  type MicSnapshot
} from './micLive';
import {arbitrate, normText, ECHO_DENSITY_DB, type Verdict} from './arbiter';
import {RecorderRing, type Slot} from './recorderRing';

export {arbitrate} from './arbiter';
export type {Verdict} from './arbiter';

export const RMS_THRESHOLD = -42;
export const SUSTAIN_MS = 250;
export const SILENCE_MS = 2000;

const POLL_MS = 25;

const TAIL_LINGER_MS = 600;

const STREAM_TAIL_MS = 350;
const MIN_BLOB_SIZE = 1200;

const VERDICT_DEADLINE_MS = 75_000;

const BLOB_DEADLINE_MS = 15_000;

const BATCH_GRACE_MS = 6_000;
const PRE_ROLL_SAMPLES = STT_RATE;

// How long a press waits for the graph to deliver before judging it stalled.
// The tap posts every ~21ms, so a running graph answers well inside this.
const FLOW_BOUND_MS = 500;
// A frame this recent proves the graph delivers without waiting for another.
const FLOW_FRESH_MS = 250;
// Closing a context whose render is dead may never answer; a rebuild waits for
// the old contexts to close no longer than this.
const CLOSE_WAIT_MS = 500;

export type RecordingState = 'idle' | 'recording' | 'transcribing';

type PipelineEvents = {
  level: (db: number) => void;

  recording: (s: RecordingState) => void;

  partial: (
    text: string,
    sessionId?: string,
    committed?: number,
    captureId?: number,
    committedS?: number
  ) => void;

  utterance: (
    text: string,
    sessionId?: string,
    clip?: Blob | null,
    durationS?: number,
    captureId?: number
  ) => void;

  clip: (clip: Blob, sessionId?: string, durationS?: number, captureId?: number) => void;

  ignored: (
    text: string,
    reason?: 'error',
    clip?: Blob,
    captureId?: number,
    durationS?: number
  ) => void;
};

type Capture = {
  id: number;

  cid: string;
  forSession: string | undefined;
  startedAt: number;

  audioFrom: number;
  dbs: number[];
  wasPlaying: boolean;

  fromPress: boolean;
  slot: Slot | null;
  stream: SttStream | null;
  streamOpen: boolean;
  arbitrating: boolean;

  settled: boolean;

  // The longest gap between waveform paints seen during this take (ms). It is
  // logged on capture.clip so a slow phone's frozen strip is visible in the log.
  maxPaintGapMs: number;
};

type ReleasedCapture = {
  id: number;
  forCapture: string | undefined;
  durationS: number;
  stream: SttStream | null;
  blobPromise: Promise<Blob | null>;
};

type HeardTranscript = {
  text: string;
  streamed: boolean;
  failed: boolean;
  decoded: boolean;
  blob: Blob | null;
};

type PipelineInitOptions = {
  transcribe: (audio: Blob, sessionId?: string) => Promise<string>;

  transcribeStream?: ((handlers: SttStreamHandlers, sessionId?: string) => SttStream) | null;
};

class Pipeline {
  private stream: MediaStream | null = null;
  private actx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buf: Float32Array<ArrayBuffer> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private transcribeCb: ((audio: Blob, sessionId?: string) => Promise<string>) | null = null;

  private streamFactory: ((handlers: SttStreamHandlers, sessionId?: string) => SttStream) | null =
    null;
  private tapNode: AudioNode | null = null;
  private tapSink: GainNode | null = null;
  private chunker: Pcm16kChunker | null = null;
  private preRoll: Float32Array[] = [];
  private preRollSamples = 0;

  // The latest loudness from the worklet's level meter (dB), and whether the
  // worklet is feeding it. The waveform paints from this value, so the strip's
  // loudness comes off the audio thread rather than a main-thread read.
  private workletLevelDb = -120;
  private workletLevelActive = false;
  private lastPaintAt = 0;

  private active: Capture | null = null;
  private inFlight = new Map<number, Capture>();

  private cids = new Map<number, string>();

  private tailFor: Capture | null = null;

  private above = 0;
  private lastVoiceAt = 0;
  private pttDown = false;
  private handsFreeId: string | null = null;

  private captureSeq = 0;

  get pressCaptureId(): number {
    return this.pttCaptureId;
  }

  get liveCaptureId(): number {
    return this.active?.id ?? 0;
  }

  get liveCaptionOpen(): boolean {
    return !!this.active?.streamOpen;
  }

  get capturesInFlight(): number[] {
    return [...this.inFlight.keys()];
  }

  private ring = new RecorderRing();
  private pttCaptureId = 0;

  private listeners: {[K in keyof PipelineEvents]: Set<PipelineEvents[K]>} = {
    level: new Set(),
    recording: new Set(),
    partial: new Set(),
    utterance: new Set(),
    clip: new Set(),
    ignored: new Set()
  };

  on<K extends keyof PipelineEvents>(ev: K, fn: PipelineEvents[K]): () => void {
    this.listeners[ev].add(fn);
    return () => this.listeners[ev].delete(fn);
  }

  private emit<K extends keyof PipelineEvents>(
    ev: K,
    ...args: Parameters<PipelineEvents[K]>
  ): void {
    for (const fn of this.listeners[ev])
      (fn as (...a: Parameters<PipelineEvents[K]>) => void)(...args);
  }

  get initialized(): boolean {
    return !!this.stream;
  }

  get captureBusy(): boolean {
    return this.pttDown || this.inFlight.size > 0 || this.ring.draining > 0;
  }

  private recState: RecordingState = 'idle';
  private syncRecordingState(): void {
    const next: RecordingState =
      this.active || this.pttDown ? 'recording' : this.inFlight.size ? 'transcribing' : 'idle';
    if (next === this.recState) return;
    this.recState = next;
    speaker.setRecording(next === 'recording');
    this.emit('recording', next);
  }

  private abandonCapture(cap: Capture, durationS: number, blob: Blob | null, why: string): void {
    if (cap.settled) return;
    cap.settled = true;
    cyclog('capture.abandoned', {
      cid: cap.cid,
      capture: cap.id,
      durationS,
      bytes: blob?.size ?? 0,
      heldMs: Math.round(performance.now() - cap.startedAt),
      why
    });
    if (cap.stream) {
      try {
        cap.stream.abort();
      } catch {}
      cap.stream = null;
    }
    cap.streamOpen = false;
    this.emit('ignored', '', 'error', blob ?? undefined, cap.id, durationS);
    this.release(cap);
  }

  // The speaker gives back what the takes and the press paused once the last
  // of them lets go (speaker.giveBack).
  private release(cap: Capture): void {
    this.inFlight.delete(cap.id);
    cap.arbitrating = false;
    cap.streamOpen = false;
    cap.wasPlaying = false;
    if (this.tailFor === cap) this.tailFor = null;
    speaker.setBusy(false, `capture:${cap.id}`);
    this.syncRecordingState();
  }

  private workletReady = false;
  private srcNode: MediaStreamAudioSourceNode | null = null;
  private unbindTracks: (() => void) | null = null;
  private unbindContext: (() => void) | null = null;
  private lifeBound = false;
  private recoverWait: Promise<MicSnapshot | null> | null = null;
  // The mic session (bumped by dispose): a recovery belongs to the one that started it.
  private micGen = 0;
  private lastReacquireAt = 0;

  // Proof that audio flows through the graph: the tap's deliveries (or, with no
  // tap, ticks on which the render clock advanced), counted per graph.
  private flowFrames = 0;
  private lastFlowAt = 0;
  private firstFlowAt = 0;
  private graphBuiltAt = 0;
  // Hands-free has no press to check the graph: a stall the voice detector
  // sees gets one recovery, and the next frame (or a new turn edge: hands-free
  // switched on, the app back in front) re-arms it.
  private stallHandled = false;
  // The app came back to the front at foregroundAt, and the first time the mic
  // is read after that (a press, or hands-free listening) is logged once as
  // mic.foreground: whether it delivered on its own or what healed it.
  private wasHidden = false;
  private foregroundAt = 0;
  private foregroundJudged = true;
  private lastClock = -1;
  private flowWaiters = new Set<() => void>();

  async init(opts: PipelineInitOptions): Promise<void> {
    if (this.stream) {
      this.transcribeCb = opts.transcribe;

      await this.ensureLive(true);
      return;
    }
    this.transcribeCb = opts.transcribe;
    this.streamFactory =
      opts.transcribeStream === undefined
        ? (handlers, sessionId) => openSttStream(sessionId, handlers)
        : opts.transcribeStream;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}
    });

    try {
      await this.finishInit();
    } catch (err) {
      this.dispose();
      throw err;
    }
  }

  private async finishInit(): Promise<void> {
    await speaker.unlock();
    await this.buildGraph();

    this.ring.start(this.stream!);
    this.pollTimer = setInterval(() => this.tick(), POLL_MS);
    this.bindLifecycle();
    this.watchTracks();
  }

  // A fresh context with the analyser and the PCM tap on the current track.
  private async buildGraph(): Promise<void> {
    const actx = new AudioContext();
    this.actx = actx;
    if (actx.state === 'suspended') await actx.resume();
    this.analyser = actx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buf = new Float32Array(this.analyser.fftSize);

    const source = actx.createMediaStreamSource(this.stream!);
    source.connect(this.analyser);
    this.srcNode = source;
    this.graphBuilt();

    if (this.streamFactory) {
      try {
        await this.initPcmTap(source);
      } catch {
        this.streamFactory = null;
      }
    }
    this.bindContextWatch();
  }

  // Take the capture graph down, leaving the track and the recorder running.
  // Resolves when its context has closed.
  private teardownGraph(): Promise<void> {
    this.stopPcmTap();
    if (this.srcNode) {
      try {
        this.srcNode.disconnect();
      } catch {}
      this.srcNode = null;
    }
    this.unbindContext?.();
    const actx = this.actx;
    this.actx = null;
    this.analyser = null;
    this.buf = null;
    this.workletReady = false;
    return actx ? actx.close().catch(() => {}) : Promise.resolve();
  }

  private graphBuilt(): void {
    this.graphBuiltAt = performance.now();
    this.lastFlowAt = 0;
    this.firstFlowAt = 0;
    this.flowFrames = 0;
    this.lastClock = -1;
  }

  private markFlow(): void {
    this.flowFrames++;
    this.lastFlowAt = performance.now();
    if (!this.firstFlowAt) this.firstFlowAt = this.lastFlowAt;
    this.stallHandled = false;
    if (this.flowWaiters.size) for (const w of [...this.flowWaiters]) w();
  }

  // What the graph has proven without waiting: a recent frame, or nothing yet.
  private flowNow(): GraphFlow {
    if (!this.srcNode) return 'unknown';
    return this.lastFlowAt && performance.now() - this.lastFlowAt <= FLOW_FRESH_MS
      ? 'flowing'
      : 'unknown';
  }

  // The graph's next frame, or FLOW_BOUND_MS of nothing.
  private awaitFlow(): Promise<GraphFlow> {
    const now = this.flowNow();
    if (now === 'flowing' || !this.srcNode) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = (flow: GraphFlow) => {
        clearTimeout(timer);
        this.flowWaiters.delete(onFrame);
        resolve(flow);
      };
      const onFrame = () => done('flowing');
      const timer = setTimeout(() => done('stalled'), FLOW_BOUND_MS);
      this.flowWaiters.add(onFrame);
    });
  }

  ensureLive(engaging = false, listening = false): Promise<MicSnapshot | null> {
    if (!this.stream && !this.actx) return Promise.resolve(null);
    if (this.recoverWait) return this.recoverWait;
    const wait = this.runRecover(engaging, listening).finally(() => {
      if (this.recoverWait === wait) this.recoverWait = null;
    });
    return (this.recoverWait = wait);
  }

  private readSnapshot(engaging: boolean, listening = false): MicSnapshot {
    const track = this.stream?.getAudioTracks()[0];
    return {
      contextState: readContextState(this.actx?.state),
      trackReadyState: readTrackReadyState(track?.readyState),
      trackMuted: !!track?.muted,
      flow: this.flowNow(),
      visible: typeof document !== 'undefined' && document.visibilityState === 'visible',
      engaging,
      listening
    };
  }

  // The snapshot a decision is made on. A reader of the graph (a press, or
  // hands-free listening) waits for its own output when the reported states
  // are healthy: they cannot show a graph that renders nothing, only its
  // frames can.
  private async inspect(engaging: boolean, listening = false): Promise<MicSnapshot> {
    const s = this.readSnapshot(engaging, listening);
    const reading = engaging || listening;
    if (!reading || s.flow === 'flowing' || s.contextState !== 'running' || !canRecord(s)) {
      return s;
    }
    const flow = await this.awaitFlow();
    return {...this.readSnapshot(engaging, listening), flow};
  }

  // The first read of the mic after the app came back to the front, once:
  // 'clean' when the graph delivered with no fix (no idle context was left to
  // hold a dead output), 'healed' with the fixes that revived it, 'still-dead'
  // when none did. This is the line that says on a real phone which path ran.
  private judgeForeground(path: 'clean' | 'healed' | 'still-dead', by: string, steps = ''): void {
    if (this.foregroundJudged) return;
    this.foregroundJudged = true;
    const now = performance.now();
    cyclog('mic.foreground', {
      path,
      by,
      fix: steps || undefined,
      sinceVisibleMs: Math.round(now - this.foregroundAt),
      graphNew: this.graphBuiltAt > this.foregroundAt,
      firstFrameMs: this.firstFlowAt ? Math.round(this.firstFlowAt - this.graphBuiltAt) : null,
      playbackOpen: playbackContextOpen(),
      toneOpen: toneContextOpen()
    });
  }

  private async runRecover(engaging: boolean, listening = false): Promise<MicSnapshot> {
    const by = engaging ? 'press' : listening ? 'hands-free' : '';
    const snap = await this.inspect(engaging, listening);
    if (isMicLive(snap)) {
      if (by) this.judgeForeground('clean', by);
      return snap;
    }
    const fix = decideMicFix(snap);
    if (fix === 'none') {
      if (by) this.judgeForeground('still-dead', by);
      return snap;
    }
    if (
      fix === 'reacquire' &&
      !engaging &&
      this.lastReacquireAt &&
      performance.now() - this.lastReacquireAt < 1000
    ) {
      return this.readSnapshot(engaging);
    }
    try {
      const r = await applyMicFix(snap, {
        resume: () => this.resumeContext(),
        rebuild: () => this.rebuildGraph(),
        reacquire: () => this.reacquireStream(),
        inspect: () => this.inspect(engaging, listening)
      });
      const recorderOnly = !r.live && canRecord(r.after);
      cyclog(r.live ? 'mic.recovered' : 'mic.recover.still-dead', {
        fix: r.steps.join('>'),
        engaging,
        listening: listening || undefined,
        visible: snap.visible,
        from: {
          contextState: snap.contextState,
          track: snap.trackReadyState,
          muted: snap.trackMuted,
          flow: snap.flow
        },
        to: {
          contextState: r.after.contextState,
          track: r.after.trackReadyState,
          muted: r.after.trackMuted,
          flow: r.after.flow
        },
        why: recorderOnly
          ? 'the track is live but the graph still delivers no audio; a take records ' +
            'on the recorder alone, with no waveform or live words, and its words come ' +
            'from the clip'
          : undefined
      });
      if (by) this.judgeForeground(r.live ? 'healed' : 'still-dead', by, r.steps.join('>'));
      return r.after;
    } catch (err) {
      cyclog('mic.recover.failed', {err, fix, engaging, listening: listening || undefined});
      return this.readSnapshot(engaging);
    }
  }

  // The context reports running on a live, unmuted track and the graph
  // delivers nothing: rebuild it on the same track (no getUserMedia, so no
  // prompt). WebKit renders every AudioContext of a page with the same output
  // format through one shared output, and a fresh context joins whatever output
  // the page's other contexts hold: a fresh capture context per take stayed
  // dead for the rest of the page's life (2026-10-03, every take after the
  // first background). So the page's idle playback and tone contexts are
  // closed with the old graph and the new graph starts on an output of its own.
  private async rebuildGraph(): Promise<void> {
    if (!this.stream) return;
    const actx = this.actx;
    const now = performance.now();
    cyclog('mic.rebuild', {
      contextState: actx?.state ?? null,
      clockS: actx ? Math.round(actx.currentTime * 1000) / 1000 : null,
      graphAgeMs: Math.round(now - this.graphBuiltAt),
      frames: this.flowFrames,
      lastFrameAgoMs: this.lastFlowAt ? Math.round(now - this.lastFlowAt) : null,
      why:
        `the context reports ${actx?.state ?? 'nothing'} on a live, unmuted track and ` +
        `the graph delivered no audio within ${FLOW_BOUND_MS}ms; it is rebuilt on the same ` +
        'track, and the idle audio contexts that share its output are closed with it'
    });
    const playback = releasePlaybackContext();
    const closing = Promise.all([this.teardownGraph(), playback, releaseToneContext()]);
    const closed = await Promise.race([
      closing.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), CLOSE_WAIT_MS))
    ]);
    if (!closed || !playback) {
      cyclog('mic.rebuild.release', {
        closed,
        playbackKept: !playback,
        why: !playback
          ? 'a clip is sounding through the playback context, so it was kept; the new ' +
            'graph may share its output'
          : `the old contexts did not finish closing within ${CLOSE_WAIT_MS}ms`
      });
    }
    await this.buildGraph();
  }

  private async resumeContext(): Promise<void> {
    if (!this.actx || this.actx.state === 'closed') return;
    if (this.actx.state === 'running') return;
    cyclog('mic.resume', {from: this.actx.state});
    await this.actx.resume();
  }

  private async reacquireStream(): Promise<void> {
    // Disposed while a recovery was waiting on the graph: nobody wants the mic.
    if (!this.stream) return;
    cyclog('mic.reacquire', {
      contextState: this.actx?.state ?? null,
      tracks: (this.stream?.getAudioTracks() ?? []).map((t) => ({
        readyState: t.readyState,
        muted: t.muted
      }))
    });
    this.lastReacquireAt = performance.now();
    const gen = this.micGen;
    const next = await navigator.mediaDevices.getUserMedia({
      audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}
    });
    // Disposed while getUserMedia was answering (the press ended, the mic was
    // released, maybe reopened): the new tracks would hold the mic for nobody.
    if (gen !== this.micGen) {
      next.getTracks().forEach((t) => t.stop());
      return;
    }
    this.unbindTracks?.();
    this.ring.stop();
    if (this.srcNode) {
      try {
        this.srcNode.disconnect();
      } catch {}
      this.srcNode = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
    }
    this.stream = next;

    if (!this.actx || this.actx.state === 'closed') {
      void this.teardownGraph();
      await this.buildGraph();
    } else {
      if (this.actx.state !== 'running') await this.actx.resume();
      const source = this.actx.createMediaStreamSource(this.stream);
      source.connect(this.analyser!);
      this.srcNode = source;
      this.graphBuilt();
      if (this.streamFactory) {
        try {
          this.stopPcmTap();
          await this.initPcmTap(source);
        } catch {
          this.streamFactory = null;
        }
      }
    }
    this.ring.start(this.stream!);
    if (!this.pollTimer) this.pollTimer = setInterval(() => this.tick(), POLL_MS);
    this.watchTracks();
  }

  constructor() {
    // Bound for the page's life, mic open or not: a background with the mic
    // released still has to be judged on the next press.
    if (typeof document !== 'undefined') this.bindLifecycle();
  }

  private bindLifecycle(): void {
    if (this.lifeBound) return;
    this.lifeBound = true;
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private onVisibility = (): void => {
    if (document.visibilityState !== 'visible') {
      this.wasHidden = true;
      return;
    }
    if (this.wasHidden) {
      this.wasHidden = false;
      this.foregroundAt = performance.now();
      this.foregroundJudged = false;
      this.stallHandled = false;
    }
    if (!this.stream && !this.actx) return;
    void this.ensureLive(this.pttDown);
  };

  private bindContextWatch(): void {
    this.unbindContext?.();
    const actx = this.actx;
    if (!actx) return;
    const onState = () => {
      if (document.visibilityState !== 'visible') return;
      if (actx.state === 'running') return;
      void this.ensureLive(this.pttDown);
    };
    actx.addEventListener('statechange', onState);
    this.unbindContext = () => {
      try {
        actx.removeEventListener('statechange', onState);
      } catch {}
      this.unbindContext = null;
    };
  }

  private watchTracks(): void {
    this.unbindTracks?.();
    const stream = this.stream;
    if (!stream) return;
    const cleanups: Array<() => void> = [];
    for (const t of stream.getAudioTracks()) {
      const onDead = () => {
        void this.ensureLive(this.pttDown);
      };
      t.addEventListener('ended', onDead);
      t.addEventListener('mute', onDead);
      cleanups.push(() => {
        t.removeEventListener('ended', onDead);
        t.removeEventListener('mute', onDead);
      });
    }
    this.unbindTracks = () => {
      for (const c of cleanups) c();
      this.unbindTracks = null;
    };
  }

  private async initPcmTap(source: MediaStreamAudioSourceNode): Promise<void> {
    const actx = this.actx!;
    this.chunker = new Pcm16kChunker(actx.sampleRate, (chunk) => this.onPcmChunk(chunk));

    if (actx.audioWorklet) {
      if (!this.workletReady) {
        const url = URL.createObjectURL(new Blob([PCM_TAP_WORKLET_JS], {type: 'text/javascript'}));
        try {
          await actx.audioWorklet.addModule(url);
          this.workletReady = true;
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      const node = new AudioWorkletNode(actx, PCM_TAP_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit'
      });
      node.port.onmessage = (e) => {
        this.markFlow();
        if (typeof e.data === 'number') {
          this.workletLevelDb = 20 * Math.log10(e.data + 1e-10);
          this.workletLevelActive = true;
        } else if (e.data instanceof Float32Array) {
          this.chunker?.push(e.data);
        }
      };
      source.connect(node);
      this.tapNode = node;
      return;
    }

    const sp = actx.createScriptProcessor(2048, 1, 1);
    sp.onaudioprocess = (e) => {
      this.markFlow();
      this.chunker?.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    const sink = actx.createGain();
    sink.gain.value = 0;
    source.connect(sp);
    sp.connect(sink);
    sink.connect(actx.destination);
    this.tapNode = sp;
    this.tapSink = sink;
  }

  private stopPcmTap(): void {
    if (this.tapNode) {
      if (this.tapNode instanceof AudioWorkletNode) this.tapNode.port.onmessage = null;
      else (this.tapNode as ScriptProcessorNode).onaudioprocess = null;
      try {
        this.tapNode.disconnect();
      } catch {}
      this.tapNode = null;
    }
    if (this.tapSink) {
      try {
        this.tapSink.disconnect();
      } catch {}
      this.tapSink = null;
    }
    this.chunker = null;
    this.preRoll = [];
    this.preRollSamples = 0;
    this.workletLevelActive = false;
  }

  // Paint one waveform level. The value comes from the worklet's meter (the
  // audio thread), never from a per-frame main-thread read or the network, so
  // the strip shows the current loudness even when the main thread is busy.
  // The gap since the last paint is folded onto the take so a frozen strip
  // shows up on capture.clip.
  private emitLevel(fallbackDb: number): void {
    const now = performance.now();
    const cap = this.active;
    if (cap && this.lastPaintAt) {
      const gap = now - this.lastPaintAt;
      if (gap > cap.maxPaintGapMs) cap.maxPaintGapMs = gap;
    }
    this.lastPaintAt = now;
    this.emit('level', this.workletLevelActive ? this.workletLevelDb : fallbackDb);
  }

  private onPcmChunk(chunk: Float32Array): void {
    if (this.active) {
      this.active.stream?.push(chunk);
      return;
    }

    if (this.tailFor?.stream) {
      this.tailFor.stream.push(chunk);
      return;
    }

    this.preRoll.push(chunk);
    this.preRollSamples += chunk.length;
    while (
      this.preRoll.length > 1 &&
      this.preRollSamples - this.preRoll[0].length >= PRE_ROLL_SAMPLES
    ) {
      this.preRollSamples -= this.preRoll.shift()!.length;
    }
  }

  private startSttStream(cap: Capture): void {
    if (!this.streamFactory || !this.tapNode) {
      cyclog('capture.stream.off', {
        cid: cap.cid,
        capture: cap.id,
        why: !this.streamFactory
          ? 'streaming decoding is disabled for this page'
          : 'there is no PCM tap, so nothing could be streamed'
      });
      return;
    }
    // A take that has been released (arbitrating) has stopped producing audio
    // and is only waiting for its own stream.finish() to answer; it no longer
    // holds the live-stream slot, so a take that starts right after gets its own
    // stream at once instead of falling back to batch and showing no live words.
    // The engine keys every stream by a fresh id and opens a separate upstream
    // per id (agent-engine voice-proxy, voice-engine /stt-stream), so the two
    // briefly-overlapping streams stay apart: the earlier take's final lands on
    // the earlier take, the new take's partials on the new take. Only a take
    // that is still recording blocks a second live stream.
    for (const other of this.inFlight.values()) {
      if (other !== cap && other.streamOpen && !other.arbitrating) {
        cyclog('capture.stream.busy', {
          cid: cap.cid,
          capture: cap.id,
          heldBy: other.cid,
          why: 'an earlier take is still recording on the live stt stream; batch only'
        });
        return;
      }
    }
    let stream: SttStream;
    try {
      stream = this.streamFactory(
        {
          onPartial: (text, committed, committedS) => {
            if (cap.streamOpen)
              this.emit('partial', text, cap.forSession, committed, cap.id, committedS);
          }
        },
        cap.forSession
      );
    } catch (e) {
      cyclog('capture.stream.threw', {
        cid: cap.cid,
        capture: cap.id,
        err: e,
        why: 'the socket could not be opened; batch only'
      });
      return;
    }
    for (const chunk of this.preRoll) stream.push(chunk);
    this.preRoll = [];
    this.preRollSamples = 0;
    cap.stream = stream;
    cap.streamOpen = true;
  }

  dispose(): void {
    this.micGen++;
    this.recoverWait = null;
    this.pttDown = false;
    this.pttCaptureId = 0;
    this.handsFreeId = null;
    setCallPlayback(false);
    speaker.setBusy(false, 'press');

    const orphan = this.active;
    this.active = null;
    if (orphan) {
      orphan.slot = null;
      this.abandonCapture(
        orphan,
        Math.max(1, Math.round((performance.now() - orphan.audioFrom) / 1000)),
        null,
        'the microphone was disposed while this take was recording, so there is ' +
          'no clip to keep; the capture is closed rather than left in flight'
      );
    }
    cyclog('mic.disposed', {stillDecoding: [...this.inFlight.values()].map((c) => c.cid)});
    this.tailFor = null;
    this.unbindTracks?.();
    void this.teardownGraph();
    this.ring.stop();
    this.ring.stopLingering();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }

    this.syncRecordingState();
  }

  // The composer's press takes the speaker before it asks for the mic: it
  // pauses the reply and claims the speaker until the press ends.
  holdForPress(): void {
    speaker.interrupt();
    speaker.setBusy(true, 'press');
  }

  startPTT(): void {
    if (this.pttDown) {
      cyclog('ptt.start.refused', {
        why: 'a press is already down',
        micOpen: !!this.stream,
        pttDown: this.pttDown
      });
      return;
    }
    if (!this.stream && !this.actx) {
      this.refusePress('the microphone is not open yet (getUserMedia has not answered)');
      return;
    }
    this.pttDown = true;
    if (isMicLive(this.readSnapshot(true))) {
      this.judgeForeground('clean', 'press');
      this.beginPress();
      return;
    }

    this.lastVoiceAt = performance.now();
    this.syncRecordingState();
    // A live track records even when the graph could not be revived (see
    // mic.recover.still-dead): the take is kept, without waveform or live words.
    const gen = this.micGen;
    void this.ensureLive(true).then((after) => {
      if (!this.pttDown || gen !== this.micGen) return;
      if (!after || !this.stream || !canRecord(after)) {
        this.refusePress(
          !this.stream
            ? 'the microphone is not open yet (getUserMedia has not answered)'
            : 'the microphone was dead and could not be recovered'
        );
        return;
      }
      this.beginPress();
    });
  }

  // The press is refused (here, or by the composer when the mic cannot open).
  // The release that follows finds no press down and does nothing.
  refusePress(why: string): void {
    cyclog('ptt.start.refused', {why, micOpen: !!this.stream, pttDown: this.pttDown});
    this.endEmptyPress();
  }

  // A press that ends with no recording (refused, or cancelled before the mic
  // or its recovery answered) gives back everything it took: the press itself,
  // its capture id, the recording state and the 'press' claim, so nothing
  // waits behind a recording that never started.
  private endEmptyPress(): void {
    this.pttDown = false;
    this.pttCaptureId = 0;
    speaker.setBusy(false, 'press');
    this.syncRecordingState();
  }

  private beginPress(): void {
    if (!this.active) this.fire();

    if (this.active) this.active.fromPress = true;
    this.pttCaptureId = this.active?.id ?? 0;
    this.lastVoiceAt = performance.now();
    this.syncRecordingState();
  }

  endPTT(): void {
    // The press is over, whatever became of it (a refused start already cleared
    // pttDown): its claim on the speaker goes with it, or every later tap would
    // wait for a recording that is not happening.
    speaker.setBusy(false, 'press');
    if (!this.pttDown) return;
    this.pttDown = false;
    this.pttCaptureId = 0;

    if (this.active) {
      void this.endCapture();
      return;
    }

    cyclog('ptt.end.nothing', {
      why:
        'the press ended with no capture running, so nothing was recorded ' +
        'and no event will follow'
    });
    this.syncRecordingState();
  }

  forceEnd(): void {
    if (this.active && !this.pttDown) void this.endCapture();
  }

  cancelCapture(): void {
    const cap = this.active;
    // Cancelled before a capture began (the mic or its recovery had not answered).
    if (!cap) return this.endEmptyPress();

    cyclog('capture.cancelled', {
      cid: cap.cid,
      capture: cap.id,
      heldMs: Math.round(performance.now() - cap.startedAt),
      why: 'the trash button; no clip, no upload, no event'
    });
    this.active = null;
    this.pttDown = false;
    this.pttCaptureId = 0;
    if (cap.stream) {
      cap.stream.abort();
      cap.stream = null;
    }
    cap.slot = null;
    if (this.stream) this.ring.start(this.stream);
    speaker.setBusy(false, 'press');
    this.release(cap);
  }

  enableHandsFree(sessionId: string): void {
    this.handsFreeId = sessionId;
    this.stallHandled = false;

    setCallPlayback(true);
  }

  disableHandsFree(): void {
    this.handsFreeId = null;
    this.above = 0;
    setCallPlayback(false);
  }

  get handsFreeSessionId(): string | null {
    return this.handsFreeId;
  }

  callMicTrack(): MediaStreamTrack | null {
    return this.stream?.getAudioTracks()[0] ?? null;
  }

  private rmsDb(): number {
    this.analyser!.getFloatTimeDomainData(this.buf!);
    const buf = this.buf!;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-10);
  }

  private tick(): void {
    if (!this.analyser) return;
    // With no tap, the render clock moving is the graph's proof of life.
    if (!this.tapNode && this.actx) {
      const clock = this.actx.currentTime;
      if (this.lastClock >= 0 && clock > this.lastClock) this.markFlow();
      this.lastClock = clock;
    }
    if (this.handsFreeId) this.listenForFlow();
    const db = this.rmsDb();
    this.emitLevel(db);

    const cap = this.active;
    if (cap) {
      cap.dbs.push(db);
      if (db > RMS_THRESHOLD) this.lastVoiceAt = performance.now();

      if (!this.pttDown && performance.now() - this.lastVoiceAt > SILENCE_MS)
        void this.endCapture();
      return;
    }

    if (this.pttDown || this.inFlight.size) {
      this.above = 0;
      return;
    }
    if (!this.handsFreeId) {
      this.above = 0;
      return;
    }

    if (db > RMS_THRESHOLD) {
      this.above += POLL_MS;
      if (this.above >= SUSTAIN_MS) {
        this.above = 0;
        this.fire();
      }
    } else {
      this.above = 0;
    }
  }

  // Hands-free listening, every poll: the voice detector reads the analyser,
  // and on a graph that renders nothing it reads zeros and never opens a turn.
  // A graph at least FLOW_BOUND_MS old with no frame for FLOW_BOUND_MS goes
  // through the same recovery as a press (rebuild on the same track), once per
  // stall. Hidden pages are left alone, as for every other fix.
  private listenForFlow(): void {
    if (!this.srcNode || this.recoverWait) return;
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    const now = performance.now();
    if (!this.foregroundJudged && this.lastFlowAt > this.foregroundAt) {
      this.judgeForeground('clean', 'hands-free');
    }
    if (this.stallHandled) return;
    if (now - Math.max(this.graphBuiltAt, this.lastFlowAt) <= FLOW_BOUND_MS) return;
    this.stallHandled = true;
    void this.ensureLive(false, true);
  }

  private fire(): void {
    if (this.active) {
      cyclog('capture.refire.ignored', {
        live: this.active.cid,
        why: 'something is already recording'
      });
      return;
    }
    const now = performance.now();
    const cap: Capture = {
      id: ++this.captureSeq,
      cid: newCid(),
      forSession: this.handsFreeId || undefined,
      startedAt: now,
      audioFrom: now,
      dbs: [],
      wasPlaying: speaker.isPlaying(),
      slot: null,
      stream: null,
      streamOpen: false,
      arbitrating: false,
      settled: false,
      maxPaintGapMs: 0,

      fromPress: false
    };
    speaker.interrupt();
    speaker.setBusy(true, `capture:${cap.id}`);

    this.active = cap;
    this.lastPaintAt = 0;
    this.inFlight.set(cap.id, cap);
    this.cids.set(cap.id, cap.cid);
    if (this.cids.size > 32) {
      for (const k of [...this.cids.keys()].slice(0, this.cids.size - 32)) this.cids.delete(k);
    }
    this.lastVoiceAt = now;
    cap.slot = this.ring.freeze();

    if (cap.slot) cap.audioFrom = cap.slot.t0;
    this.startSttStream(cap);

    cyclog('capture.start', {
      cid: cap.cid,
      capture: cap.id,
      session: cap.forSession ?? '(press)',
      handsFree: !!cap.forSession,
      preRollMs: cap.slot ? Math.round(now - cap.slot.t0) : 0,
      liveCaption: cap.streamOpen,
      inFlight: this.inFlight.size
    });
    this.syncRecordingState();
  }

  cidOf(captureId: number | undefined): string | undefined {
    return captureId === undefined ? undefined : this.cids.get(captureId);
  }

  private async endCapture(): Promise<void> {
    const cap = this.active;
    if (!cap) return;
    this.active = null;

    const released = this.releaseAndMeasure(cap);
    const {watchdog, blobWithin} = this.armVerdictWatchdog(cap, released);
    await this.awaitStreamTail(cap);
    this.publishClipWhenReady(cap, released);
    const heard = await this.runDecoders(cap, released, blobWithin);

    cap.streamOpen = false;
    clearTimeout(watchdog);

    if (cap.settled) {
      cyclog('capture.verdict.late', {
        cid: cap.cid,
        capture: released.id,
        chars: heard.text.length,
        heard: heard.text.slice(0, 120),
        why:
          'a verdict was already published for this capture (see capture.abandoned); ' +
          'this decode arrived too late to be used'
      });
      return;
    }
    cap.settled = true;

    const verdict = this.decideVerdict(cap, released, heard);
    if (verdict) return this.publishDrop(cap, released, heard, blobWithin);
    return this.commitUtterance(cap, released, heard, blobWithin);
  }

  private releaseAndMeasure(cap: Capture): ReleasedCapture {
    cap.arbitrating = true;
    cyclog('capture.released', {
      cid: cap.cid,
      capture: cap.id,
      heldMs: Math.round(performance.now() - cap.startedAt),
      wasPlaying: cap.wasPlaying,
      liveCaption: cap.streamOpen
    });

    if (cap.stream) this.tailFor = cap;
    this.syncRecordingState();

    const id = cap.id;
    const forCapture = cap.forSession;

    this.chunker?.flush();
    const stream = cap.stream;

    const releasedAt = performance.now();
    const capturedMs = cap.startedAt ? releasedAt - cap.startedAt : 0;

    const audioMs = Math.max(capturedMs, releasedAt - cap.audioFrom + TAIL_LINGER_MS);
    const durationS = Math.max(1, Math.round(audioMs / 1000));
    const slot = cap.slot;
    cap.slot = null;
    const blobPromise = this.ring.finish(slot, TAIL_LINGER_MS);
    if (this.stream) this.ring.start(this.stream);

    return {id, forCapture, durationS, stream, blobPromise};
  }

  private armVerdictWatchdog(
    cap: Capture,
    released: ReleasedCapture
  ): {
    watchdog: ReturnType<typeof setTimeout>;
    blobWithin: () => Promise<Blob | null>;
  } {
    let lastBlob: Blob | null = null;
    void released.blobPromise
      .then((b) => {
        lastBlob = b;
      })
      .catch(() => {});
    const watchdog = setTimeout(() => {
      this.abandonCapture(
        cap,
        released.durationS,
        lastBlob,
        'no verdict was reached within the deadline: a decoder or the recorder ' +
          'never answered, and a capture that is never closed holds the microphone, ' +
          'the speaker and every later send'
      );
    }, VERDICT_DEADLINE_MS);

    const blobWithin = () =>
      Promise.race([
        released.blobPromise,
        new Promise<Blob | null>((r) => setTimeout(() => r(lastBlob), BLOB_DEADLINE_MS))
      ]);
    return {watchdog, blobWithin};
  }

  private async awaitStreamTail(cap: Capture): Promise<void> {
    await new Promise((r) => setTimeout(r, STREAM_TAIL_MS));
    this.chunker?.flush();
    if (this.tailFor === cap) this.tailFor = null;
  }

  private publishClipWhenReady(cap: Capture, released: ReleasedCapture): void {
    const {id, forCapture, durationS} = released;
    void released.blobPromise
      .then((b) => {
        if (b && b.size > MIN_BLOB_SIZE) {
          // How much live-stream audio actually reached the engine vs. what the
          // 30s queue bound had to drop, so the owner's own recordings show the
          // real live-stt delivery rate (fix-stt-drop). Absent when streaming was
          // off for this take (no stream).
          const stt = cap.stream as unknown as {
            sentChunks?: number;
            sentSamples?: number;
            droppedChunks?: number;
            droppedSamples?: number;
          } | null;
          const sttS = (n: number | undefined) => Math.round(((n ?? 0) / 16000) * 10) / 10;
          cyclog('capture.clip', {
            cid: cap.cid,
            capture: id,
            bytes: b.size,
            durationS,
            maxPaintGapMs: Math.round(cap.maxPaintGapMs),
            sttSent: stt?.sentChunks ?? 0,
            sttSentS: sttS(stt?.sentSamples),
            sttDropped: stt?.droppedChunks ?? 0,
            sttDroppedS: sttS(stt?.droppedSamples)
          });
          this.emit('clip', b, forCapture ?? undefined, durationS, id);
        } else {
          cyclog('capture.clip.none', {
            cid: cap.cid,
            capture: id,
            bytes: b?.size ?? 0,
            floor: MIN_BLOB_SIZE,
            why: b
              ? 'the recorder produced fewer bytes than a clip can be'
              : 'the recorder produced no blob at all'
          });
        }
      })
      .catch((e) => {
        cyclog('capture.clip.threw', {cid: cap.cid, capture: id, err: e});
      });
  }

  private async runDecoders(
    cap: Capture,
    released: ReleasedCapture,
    blobWithin: () => Promise<Blob | null>
  ): Promise<HeardTranscript> {
    const {id, forCapture, stream} = released;
    let text = '';
    let streamed = false;
    let failed = false;
    let usedBlob: Blob | null = null;

    const decodeClip = async (): Promise<{text: string; blob: Blob} | null> => {
      if (!this.transcribeCb) return null;
      const b = await blobWithin();
      if (!b || b.size <= MIN_BLOB_SIZE) return null;
      try {
        const t = ((await this.transcribeCb(b, forCapture)) || '').trim();
        return t ? {text: t, blob: b} : null;
      } catch {
        return null;
      }
    };

    const streamRun: Promise<string | null> = stream
      ? stream
          .finish()
          .then((t): string => (t || '').trim())
          .catch((): null => null)
      : Promise.resolve(null);

    const {fromStream, batch, decoded} = await transcriptAtRelease({
      streamRun,
      decodeClip,
      graceMs: BATCH_GRACE_MS,
      onGraceExpired: () =>
        cyclog('stt.batch.armed', {
          cid: cap.cid,
          capture: id,
          afterMs: BATCH_GRACE_MS,
          why:
            'the streaming decoder has not produced a final in the time a healthy one ' +
            'takes, so the clip is decoded in parallel as the fallback'
        })
    });
    if (fromStream) {
      text = fromStream;
      streamed = true;
    } else if (batch) {
      text = batch.text;
      usedBlob = batch.blob;
      streamed = true;
    } else if (fromStream === null) {
      failed = true;
    } else {
      streamed = true;
    }

    let blob: Blob | null = usedBlob;
    if (!streamed) {
      blob = await blobWithin();
      if (blob && blob.size > MIN_BLOB_SIZE && this.transcribeCb) {
        try {
          text = ((await this.transcribeCb(blob, forCapture)) || '').trim();
          failed = false;
        } catch {}
      }
    }
    return {text, streamed, failed, decoded, blob};
  }

  private decideVerdict(cap: Capture, released: ReleasedCapture, heard: HeardTranscript): Verdict {
    const dbs = cap.dbs.slice().sort((a, b) => a - b);
    const medianDb = dbs.length ? dbs[Math.floor(dbs.length / 2)] : -120;

    const speakerState = speaker.state.state;
    const bargeStopped =
      cap.wasPlaying && speakerState !== 'speaking' && speakerState !== 'loading';
    const verdict = arbitrate({
      text: heard.text,
      wasPlaying: cap.wasPlaying,
      fromPress: cap.fromPress,
      medianDb,
      playingText: speaker.state.text,
      bargeStopped
    });

    const speechMs = cap.dbs.filter((d) => d > RMS_THRESHOLD).length * POLL_MS;
    cyclog('capture.verdict', {
      cid: cap.cid,
      capture: released.id,
      durationS: released.durationS,
      kept: !verdict,
      drop: verdict || undefined,
      heard: heard.text.slice(0, 120),
      chars: heard.text.length,

      streamed: heard.streamed,
      failed: heard.failed,
      decoded: heard.decoded,
      wasPlaying: cap.wasPlaying,

      bargeStopped,
      fromPress: cap.fromPress,
      medianDb: Math.round(medianDb),
      echoFloorDb: ECHO_DENSITY_DB,
      speechMs,
      polls: cap.dbs.length
    });
    return verdict;
  }

  private async publishDrop(
    cap: Capture,
    released: ReleasedCapture,
    heard: HeardTranscript,
    blobWithin: () => Promise<Blob | null>
  ): Promise<void> {
    const {id, durationS} = released;
    if (normText(heard.text)) {
      this.emit('ignored', heard.text, undefined, undefined, id, durationS);
    } else {
      const blob = heard.blob ?? (await blobWithin());
      this.emit(
        'ignored',
        '',
        heard.failed || blob ? 'error' : undefined,
        blob ?? undefined,
        id,
        durationS
      );
    }

    this.release(cap);
  }

  private async commitUtterance(
    cap: Capture,
    released: ReleasedCapture,
    heard: HeardTranscript,
    blobWithin: () => Promise<Blob | null>
  ): Promise<void> {
    const {id, forCapture, durationS} = released;
    const text = heard.text;

    speaker.supersede(cap.startedAt);

    const blob = heard.blob ?? (await blobWithin());

    if (text) this.emit('partial', text, forCapture, text.length, id);

    this.release(cap);
    if (text) this.emit('utterance', text, forCapture, blob ?? null, durationS, id);
  }
}

export const pipeline = new Pipeline();
