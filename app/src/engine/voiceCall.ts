import type {AudioChannel} from './rtc';
import type {SttStream, SttStreamHandlers} from './contract';

type FpFrame = {local?: unknown; remote?: unknown};

type FpResult = {ok: boolean; reply: {t: 'fp'; local: string | null; remote: string | null} | null};

export function verifyFp(frame: FpFrame, channel: AudioChannel): FpResult {
  const appLocal = channel.localFp();
  const appRemote = channel.remoteFp();
  const reply = {t: 'fp' as const, local: appLocal, remote: appRemote};
  const engLocal = typeof frame.local === 'string' ? frame.local.toUpperCase() : null;
  const engRemote = typeof frame.remote === 'string' ? frame.remote.toUpperCase() : null;
  const ok =
    appLocal !== null && appRemote !== null && engLocal === appRemote && engRemote === appLocal;
  return {ok, reply};
}

type VoiceCallDeps = {
  seal: (frame: object) => void;
  log: (event: string, fields: Record<string, unknown>) => void;

  closeOnMismatch: (reason: string) => void;

  makeSink?: () => AudioSink;
};

export interface AudioSink {
  play(stream: MediaStream): void;
  stop(): void;
}

function defaultSink(): AudioSink {
  let el: HTMLAudioElement | null = null;
  return {
    play(stream: MediaStream) {
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true;
        (el as HTMLAudioElement & {playsInline?: boolean}).playsInline = true;
      }
      el.srcObject = stream;
      void el.play().catch(() => {});
    },
    stop() {
      if (!el) return;
      try {
        el.pause();
      } catch {}
      el.srcObject = null;
    }
  };
}

export class VoiceCall {
  private gateOpen = false;
  private mic: MediaStreamTrack | null = null;
  private sink: AudioSink | null = null;
  private downlinkStream: MediaStream | null = null;
  private active: MediaTrackSttStream | null = null;

  constructor(
    private channel: AudioChannel,
    private deps: VoiceCallDeps
  ) {
    this.channel.onInboundTrack((track) => {
      this.downlinkStream = new MediaStream([track]);
      if (this.gateOpen) this.playDownlink();
    });
  }

  get ready(): boolean {
    return this.gateOpen;
  }

  get canCarryAudio(): boolean {
    return this.gateOpen && !!this.channel.sender;
  }

  bindFp(frame: FpFrame): void {
    const res = verifyFp(frame, this.channel);
    if (res.reply) this.deps.seal(res.reply);
    if (res.ok) {
      this.openGate();
      this.deps.log('voice.fp-ok', {});
      return;
    }
    this.deps.log('voice.fp-mismatch', {
      engLocal: frame.local,
      engRemote: frame.remote,
      appLocal: this.channel.localFp(),
      appRemote: this.channel.remoteFp()
    });
    this.deps.closeOnMismatch('fp-mismatch');
  }

  private openGate(): void {
    if (this.gateOpen) return;
    this.gateOpen = true;

    if (this.mic) this.attachMic(this.mic);
    if (this.downlinkStream) this.playDownlink();
  }

  setMic(track: MediaStreamTrack | null): void {
    this.mic = track;
    if (this.gateOpen) this.attachMic(track);
  }

  private attachMic(track: MediaStreamTrack | null): void {
    const sender = this.channel.sender;
    if (!sender || typeof sender.replaceTrack !== 'function') return;
    void sender
      .replaceTrack(track)
      .catch((e: unknown) => this.deps.log('voice.mic-attach-failed', {err: String(e)}));
  }

  private playDownlink(): void {
    if (!this.downlinkStream) return;
    if (!this.sink) this.sink = (this.deps.makeSink ?? defaultSink)();
    this.sink.play(this.downlinkStream);
  }

  openCapture(
    session: string,
    handlers: SttStreamHandlers,
    micTrack?: MediaStreamTrack | null
  ): SttStream {
    if (micTrack !== undefined) this.setMic(micTrack);
    const stream = new MediaTrackSttStream(this, handlers, session);
    this.active = stream;
    this.deps.seal({t: 'voice-ctl', op: 'start', session});
    this.deps.log('voice.ctl', {op: 'start', session});
    return stream;
  }

  sendStop(stream: MediaTrackSttStream): void {
    if (this.active !== stream) return;
    this.deps.seal({t: 'voice-ctl', op: 'stop'});
    this.deps.log('voice.ctl', {op: 'stop'});
  }

  onSttFrame(frame: {t?: string; text?: unknown; committed?: unknown; committedS?: unknown}): void {
    const stream = this.active;
    if (!stream) return;
    const text = typeof frame.text === 'string' ? frame.text : '';
    if (frame.t === 'partial') {
      stream.onPartial(
        text,
        Number.isFinite(frame.committed) ? Number(frame.committed) : undefined,
        Number.isFinite(frame.committedS) ? Number(frame.committedS) : undefined
      );
    } else if (frame.t === 'final') {
      stream.onFinal(text);
      if (this.active === stream) this.active = null;
    }
  }

  close(): void {
    this.attachMic(null);
    this.sink?.stop();
    this.sink = null;
    this.downlinkStream = null;
    this.active?.onClosed();
    this.active = null;
  }
}

export type SttSelectDeps = {
  callSessionId: string | null;

  micTrack: MediaStreamTrack | null;

  hasVoiceMedia: (sess: string) => boolean;
  openMedia: (sess: string, handlers: SttStreamHandlers, mic: MediaStreamTrack) => SttStream;
  openDc: (sess: string | undefined, handlers: SttStreamHandlers) => SttStream;
};

// DORMANT MEDIA-TRACK LANE (decision 2026-09-05, keep-not-delete): the openMedia
// branch is the WebRTC media-track voice path from the original architecture. It
// is not wired live today: the engine (transport/rtc.ts, werift) never reciprocates
// an inbound audio track and the app dials withAudio=false, so hasVoiceMedia() is
// always false and this branch is unreachable. Voice runs entirely over the sealed
// DataChannel (openDc: stt-* frames + tunneled /voice/*). The media lane is kept
// intentionally as the seam for a future real-time-audio-quality upgrade; it is a
// clean rebuild from the boundary contract, not dead code to delete. Do NOT remove
// without an explicit decision to abandon media-track voice.
export function selectSttStream(
  deps: SttSelectDeps,
  handlers: SttStreamHandlers,
  sess: string | undefined
): SttStream {
  if (sess && deps.callSessionId === sess && deps.micTrack && deps.hasVoiceMedia(sess)) {
    return deps.openMedia(sess, handlers, deps.micTrack);
  }
  return deps.openDc(sess, handlers);
}

export class MediaTrackSttStream implements SttStream {
  public failed = false;
  private stopped = false;
  private settled = false;
  private resolveFinal!: (text: string) => void;
  private rejectFinal!: (err: Error) => void;
  private readonly finalPromise: Promise<string>;
  private finalTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly FINAL_TIMEOUT_MS = 15_000;

  constructor(
    private call: VoiceCall,
    private handlers: SttStreamHandlers,
    _session: string
  ) {
    this.finalPromise = new Promise<string>((res, rej) => {
      this.resolveFinal = res;
      this.rejectFinal = rej;
    });
    this.finalPromise.catch(() => {});
  }

  push(_pcm: Float32Array): void {}

  finish(): Promise<string> {
    if (!this.stopped && !this.settled) {
      this.stopped = true;
      this.call.sendStop(this);
      this.finalTimer = setTimeout(
        () => this.fail(new Error('voice-ctl: no final within timeout')),
        MediaTrackSttStream.FINAL_TIMEOUT_MS
      );
    }
    return this.finalPromise;
  }

  abort(): void {
    this.call.sendStop(this);
    this.fail(new Error('voice-ctl: aborted'));
  }

  onPartial(text: string, committed?: number, committedS?: number): void {
    if (!this.settled) this.handlers.onPartial?.(text, committed, committedS);
  }
  onFinal(text: string): void {
    this.settle(text);
  }
  onClosed(): void {
    this.fail(new Error('voice-ctl: connection closed before final'));
  }

  private settle(text: string): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimer();
    this.resolveFinal(text);
  }
  private fail(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.failed = true;
    this.clearTimer();
    this.rejectFinal(err);
  }
  private clearTimer(): void {
    if (this.finalTimer !== null) {
      clearTimeout(this.finalTimer);
      this.finalTimer = null;
    }
  }
}
