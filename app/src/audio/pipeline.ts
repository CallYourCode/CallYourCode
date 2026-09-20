import {speaker} from './speaker';
import {setCallPlayback} from './webAudioClip';
import {Pcm16kChunker, PCM_TAP_PROCESSOR_NAME, PCM_TAP_WORKLET_JS, STT_RATE} from './pcm';
import {openSttStream} from '../engine/store/audioDocs';
import {transcriptAtRelease} from './releaseDecode';
import type {SttStream, SttStreamHandlers} from '../engine/contract';
import {cyclog, newCid} from '@/shared/logging';
import {
  applyMicFix,
  decideMicFix,
  isMicLive,
  readContextState,
  readTrackReadyState,
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
    this.release(cap, cap.wasPlaying);
  }

  private release(cap: Capture, resume: boolean): void {
    this.inFlight.delete(cap.id);
    cap.arbitrating = false;
    cap.streamOpen = false;
    cap.wasPlaying = false;
    if (this.tailFor === cap) this.tailFor = null;
    speaker.setBusy(false, `capture:${cap.id}`);
    if (resume && !this.pttDown && !this.active && !this.inFlight.size) speaker.resume();
    this.syncRecordingState();
  }

  private workletReady = false;
  private srcNode: MediaStreamAudioSourceNode | null = null;
  private unbindTracks: (() => void) | null = null;
  private unbindContext: (() => void) | null = null;
  private lifeBound = false;
  private recoverWait: Promise<boolean> | null = null;
  private lastReacquireAt = 0;

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

    this.actx = new AudioContext();
    if (this.actx.state === 'suspended') await this.actx.resume();
    this.analyser = this.actx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buf = new Float32Array(this.analyser.fftSize);

    const source = this.actx.createMediaStreamSource(this.stream!);
    source.connect(this.analyser);
    this.srcNode = source;

    if (this.streamFactory) {
      try {
        await this.initPcmTap(source);
      } catch {
        this.streamFactory = null;
      }
    }

    this.ring.start(this.stream!);
    this.pollTimer = setInterval(() => this.tick(), POLL_MS);
    this.bindLifecycle();
    this.bindContextWatch();
    this.watchTracks();
  }

  ensureLive(engaging = false): Promise<boolean> {
    if (!this.stream && !this.actx) return Promise.resolve(false);
    if (this.recoverWait) return this.recoverWait;
    this.recoverWait = this.runRecover(engaging).finally(() => {
      this.recoverWait = null;
    });
    return this.recoverWait;
  }

  private readSnapshot(engaging: boolean): MicSnapshot {
    const track = this.stream?.getAudioTracks()[0];
    return {
      contextState: readContextState(this.actx?.state),
      trackReadyState: readTrackReadyState(track?.readyState),
      trackMuted: !!track?.muted,
      visible: typeof document !== 'undefined' && document.visibilityState === 'visible',
      engaging
    };
  }

  private async runRecover(engaging: boolean): Promise<boolean> {
    const snap = this.readSnapshot(engaging);
    if (isMicLive(snap)) return true;
    const fix = decideMicFix(snap);
    if (fix === 'none') return false;
    if (
      fix === 'reacquire' &&
      !engaging &&
      this.lastReacquireAt &&
      performance.now() - this.lastReacquireAt < 1000
    ) {
      return isMicLive(this.readSnapshot(engaging));
    }
    try {
      const ok = await applyMicFix(snap, {
        resume: () => this.resumeContext(),
        reacquire: () => this.reacquireStream(),
        inspect: () => this.readSnapshot(engaging)
      });
      cyclog(ok ? 'mic.recovered' : 'mic.recover.still-dead', {
        fix,
        engaging,
        visible: snap.visible,
        from: {
          contextState: snap.contextState,
          track: snap.trackReadyState,
          muted: snap.trackMuted
        },
        to: this.readSnapshot(engaging)
      });
      return ok;
    } catch (err) {
      cyclog('mic.recover.failed', {err, fix, engaging});
      return isMicLive(this.readSnapshot(engaging));
    }
  }

  private async resumeContext(): Promise<void> {
    if (!this.actx || this.actx.state === 'closed') return;
    if (this.actx.state === 'running') return;
    cyclog('mic.resume', {from: this.actx.state});
    await this.actx.resume();
  }

  private async reacquireStream(): Promise<void> {
    cyclog('mic.reacquire', {
      contextState: this.actx?.state ?? null,
      tracks: (this.stream?.getAudioTracks() ?? []).map((t) => ({
        readyState: t.readyState,
        muted: t.muted
      }))
    });
    this.lastReacquireAt = performance.now();
    const next = await navigator.mediaDevices.getUserMedia({
      audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}
    });
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
      this.stopPcmTap();
      this.unbindContext?.();
      this.workletReady = false;
      this.actx = new AudioContext();
      if (this.actx.state === 'suspended') await this.actx.resume();
      this.analyser = this.actx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.buf = new Float32Array(this.analyser.fftSize);
      this.bindContextWatch();
    } else if (this.actx.state !== 'running') {
      await this.actx.resume();
    }

    const source = this.actx.createMediaStreamSource(this.stream);
    source.connect(this.analyser!);
    this.srcNode = source;
    if (this.streamFactory) {
      try {
        this.stopPcmTap();
        await this.initPcmTap(source);
      } catch {
        this.streamFactory = null;
      }
    }
    this.ring.start(this.stream!);
    if (!this.pollTimer) this.pollTimer = setInterval(() => this.tick(), POLL_MS);
    this.watchTracks();
  }

  private bindLifecycle(): void {
    if (this.lifeBound) return;
    this.lifeBound = true;
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private onVisibility = (): void => {
    if (document.visibilityState !== 'visible') return;
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
        if (e.data instanceof Float32Array) this.chunker?.push(e.data);
      };
      source.connect(node);
      this.tapNode = node;
      return;
    }

    const sp = actx.createScriptProcessor(2048, 1, 1);
    sp.onaudioprocess = (e) => {
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
    for (const other of this.inFlight.values()) {
      if (other !== cap && other.streamOpen) {
        cyclog('capture.stream.busy', {
          cid: cap.cid,
          capture: cap.id,
          heldBy: other.cid,
          why: 'the one live stt stream belongs to an earlier take; batch only'
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
    this.unbindContext?.();
    this.stopPcmTap();
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

    if (this.srcNode) {
      try {
        this.srcNode.disconnect();
      } catch {}
      this.srcNode = null;
    }
    if (this.actx) {
      try {
        this.actx.close();
      } catch {}
      this.actx = null;
    }
    this.workletReady = false;
    this.analyser = null;
    this.buf = null;

    this.syncRecordingState();
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
      cyclog('ptt.start.refused', {
        why: 'the microphone is not open yet (getUserMedia has not answered)',
        micOpen: !!this.stream,
        pttDown: this.pttDown
      });
      return;
    }
    this.pttDown = true;
    if (isMicLive(this.readSnapshot(true))) {
      this.beginPress();
      return;
    }

    this.lastVoiceAt = performance.now();
    this.syncRecordingState();
    void this.ensureLive(true).then((ok) => {
      if (!this.pttDown) return;
      if (!ok || !this.stream) {
        cyclog('ptt.start.refused', {
          why: !this.stream
            ? 'the microphone is not open yet (getUserMedia has not answered)'
            : 'the microphone was dead and could not be recovered',
          micOpen: !!this.stream,
          pttDown: this.pttDown
        });
        this.pttDown = false;
        this.pttCaptureId = 0;
        this.syncRecordingState();
        return;
      }
      this.beginPress();
    });
  }

  private beginPress(): void {
    if (!this.active) this.fire();

    if (this.active) this.active.fromPress = true;
    this.pttCaptureId = this.active?.id ?? 0;
    this.lastVoiceAt = performance.now();
    this.syncRecordingState();
  }

  endPTT(): void {
    if (!this.pttDown) return;
    this.pttDown = false;
    this.pttCaptureId = 0;

    speaker.setBusy(false, 'press');
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
    if (!cap) return;

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
    this.release(cap, cap.wasPlaying);
  }

  enableHandsFree(sessionId: string): void {
    this.handsFreeId = sessionId;

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
    const db = this.rmsDb();
    this.emit('level', db);

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

      fromPress: false
    };
    if (cap.wasPlaying) speaker.pause();
    speaker.setBusy(true, `capture:${cap.id}`);

    this.active = cap;
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
          cyclog('capture.clip', {cid: cap.cid, capture: id, bytes: b.size, durationS});
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
    const resume = cap.wasPlaying;
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

    this.release(cap, resume);
  }

  private async commitUtterance(
    cap: Capture,
    released: ReleasedCapture,
    heard: HeardTranscript,
    blobWithin: () => Promise<Blob | null>
  ): Promise<void> {
    const {id, forCapture, durationS} = released;
    const text = heard.text;

    speaker.stopAll();

    const blob = heard.blob ?? (await blobWithin());

    if (text) this.emit('partial', text, forCapture, text.length, id);

    this.release(cap, false);
    if (text) this.emit('utterance', text, forCapture, blob ?? null, durationS, id);
  }
}

export const pipeline = new Pipeline();
