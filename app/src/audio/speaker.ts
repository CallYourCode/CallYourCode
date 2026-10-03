import {streamAudioUrl} from './audioCache';
import {WebAudioClip, unlockPlayback} from './webAudioClip';
import {cyclog} from '@/shared/logging';

const DEBUG = new URLSearchParams(location.search).has('audiodebug');
function dbg(...a: unknown[]) {
  if (DEBUG) console.debug(`[spk ${(performance.now() / 1000).toFixed(2)}]`, ...a);
}

const TTS_VOLUME = 0.8;

function pickDuration(elementDuration: number, durationS?: number): number {
  if (isFinite(elementDuration) && elementDuration > 0) return elementDuration;
  return durationS && isFinite(durationS) && durationS > 0 ? durationS : 0;
}

const ALL_CLAIMS = '*';

type SpeakerItem = {
  msgId: string;
  url: string;
  text: string;
  sessionId: string;

  durationS?: number;

  /** A user command (a tap), not automatic speech: it starts now even while a
   *  capture's transcript is pending (setBusy), it waits only while the mic is
   *  recording (recording), and a kept utterance that began before it does not
   *  cancel it (supersede). */
  manual?: boolean;
  /** WHY this clip is playing (audioPlayback.PlayReason): 'autoplay-open',
   *  'autoplay-arrival' or 'tap'. Kept as a string here so the speaker owns no
   *  app-surface types; it rides onto the clip.play log line for diagnosis. */
  reason?: string;
  /** performance.now() when it was enqueued: orders it against a capture's start
   *  (supersede) and times tap-to-sound on the clip.started line. */
  at?: number;
};

/* 'waiting': a tap made while the mic is recording, shown on its button and
 * started the moment the recording is released. */
type SpeakerStateName =
  | 'idle'
  | 'loading'
  | 'speaking'
  | 'paused'
  | 'finished'
  | 'blocked'
  | 'waiting';

export type SpeakerState = {
  state: SpeakerStateName;
  sessionId?: string;
  msgId?: string;
  text?: string;
};

type StateListener = (s: SpeakerState) => void;
type ErrorListener = (item: SpeakerItem) => void;

type StartGate = (item: SpeakerItem) => boolean;

class Speaker {
  private audio: WebAudioClip;
  private queue: SpeakerItem[] = [];
  private current: SpeakerItem | null = null;
  private playGen = 0;

  private busyClaims = new Set<string>();
  private get busy(): boolean {
    return this.busyClaims.size > 0;
  }
  holds(): string[] {
    return [...this.busyClaims];
  }

  /* THE RULE for a tap: nothing sounds into a live recording. While the mic is
   * recording (a press held or locked, or a hands-free capture: the pipeline's
   * recState, plus the composer's 'press' claim that covers the press before
   * the mic answers), a tap waits, visibly ('waiting'), and starts the moment
   * the recording is released. Once released (only the transcript pending), a
   * tap plays at once. Automatic speech is held for the whole capture either
   * way (setBusy). */
  private micRecording = false;
  recording(): boolean {
    return this.micRecording || this.busyClaims.has('press');
  }
  setRecording(on: boolean): void {
    const was = this.recording();
    this.micRecording = on;
    this.recordingMayHaveEnded(was);
  }
  private recordingMayHaveEnded(was: boolean): void {
    if (!was || this.recording() || this.stateName !== 'waiting') return;
    dbg('recording released: starting the waiting tap');
    if (this.current) this.resume();
    else if (this.queue.length) this.playNext();
  }
  private lastBySession = new Map<string, SpeakerItem>();
  private stateName: SpeakerStateName = 'idle';
  private stateListeners = new Set<StateListener>();
  private errorListeners = new Set<ErrorListener>();
  private startGate: StartGate | null = null;

  constructor() {
    this.audio = new WebAudioClip();
    this.audio.volume = TTS_VOLUME;

    this.audio.addEventListener('ended', () => {
      const done = this.current;
      this.current = null;
      if (this.queue.length) this.playNext();
      else {
        this.emit('finished', done || undefined);

        this.releaseMedia();
      }
    });

    this.audio.addEventListener('error', () => {
      if (!this.current) return;
      this.failed(this.current, 'media', 'the player could not decode or load the clip');
    });
  }

  /* Every way a clip can fail to sound ends here, so none is silent: a log line,
   * the error listeners (a toast), and the queue moves on. */
  private failed(item: SpeakerItem, stage: string, err: unknown): void {
    cyclog('clip.fail', {
      session: item.sessionId,
      msg: item.msgId,
      reason: item.reason ?? 'tap',
      stage,
      err,
      ms: item.at === undefined ? undefined : Math.round(performance.now() - item.at)
    });
    if (this.current === item) this.current = null;
    for (const fn of this.errorListeners) fn(item);
    // Never left in 'loading' (a spinner with nothing behind it), busy or not.
    if (this.queue.length) this.playNext();
    else this.emit('idle');
  }

  private releaseMedia(): void {
    if (this.current || this.queue.length) return;
    try {
      this.audio.clear();
    } catch {}
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = 'none';
      } catch {}
    }
    dbg('released the player');
  }

  private suppressMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.metadata = null;
    } catch {}
    const actions: MediaSessionAction[] = [
      'play',
      'pause',
      'stop',
      'seekbackward',
      'seekforward',
      'seekto',
      'previoustrack',
      'nexttrack'
    ];
    for (const a of actions) {
      try {
        ms.setActionHandler(a, null);
      } catch {}
    }
  }

  onState(fn: StateListener): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  onError(fn: ErrorListener): () => void {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }

  setStartGate(fn: StartGate): void {
    this.startGate = fn;
  }

  private mayStart(item: SpeakerItem | null | undefined): boolean {
    if (!item) return false;
    if (!this.startGate) return true;
    return this.startGate(item);
  }

  gateChanged(): void {
    if (this.current || this.busy || !this.queue.length) return;
    dbg('gateChanged: releasing held queue', this.queue.length);
    this.playNext();
  }

  get state(): SpeakerState {
    // A waiting tap that has not started is the queue head.
    const about = this.current || (this.stateName === 'waiting' ? this.queue[0] : undefined);
    return {
      state: this.stateName,
      sessionId: about?.sessionId,
      msgId: about?.msgId,
      text: about?.text
    };
  }

  setRate(rate: number): void {
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
  }

  private rateResolver: (() => number) | null = null;
  setRateResolver(fn: () => number): void {
    this.rateResolver = fn;
  }

  private clipDuration(): number {
    return pickDuration(this.audio.duration, this.current?.durationS);
  }

  noteGrowth(msgId: string, durationS: number): void {
    if (!(durationS > 0)) return;
    if (this.current?.msgId === msgId) this.current.durationS = durationS;
    for (const it of this.queue) if (it.msgId === msgId) it.durationS = durationS;
  }

  seek(ratio: number): void {
    const dur = this.current ? this.clipDuration() : 0;
    if (!dur) return;
    try {
      this.audio.currentTime = Math.min(0.999, Math.max(0, ratio)) * dur;
    } catch {}
  }

  times(): {t: number; dur: number} {
    const dur = this.current ? this.clipDuration() : 0;
    if (!dur) return {t: 0, dur: 0};
    return {t: this.audio.currentTime, dur};
  }

  progress(): {msgId?: string; ratio: number} {
    const dur = this.current ? this.clipDuration() : 0;
    if (!dur) return {msgId: this.current?.msgId, ratio: 0};

    return {msgId: this.current!.msgId, ratio: Math.min(1, this.audio.currentTime / dur)};
  }

  isPlaying(): boolean {
    return !!this.current;
  }

  lastFor(sessionId: string): SpeakerItem | undefined {
    return this.lastBySession.get(sessionId);
  }

  pending(): Set<string> {
    const out = new Set<string>();
    if (this.current) out.add(this.current.msgId);
    for (const item of this.queue) out.add(item.msgId);
    return out;
  }

  async unlock(): Promise<void> {
    dbg('unlock start', !!this.current, this.queue.length);
    if (this.current || this.queue.length) return;
    await Promise.all([unlockPlayback(), this.audio.unlock()]);
    dbg('unlock done');
  }

  /* The busy hold (setBusy: a capture recording or awaiting its verdict) delays
   * AUTOMATIC speech only. A manual item is a tap, the user's latest command, and
   * starts now: holding it left the button idle with no trace while a long
   * transcription ran (play-tap, 2026-10-03). */
  enqueue(item: SpeakerItem): void {
    if (this.current && this.current.sessionId !== item.sessionId) this.stopAll();

    if (this.current?.msgId === item.msgId || this.queue.some((q) => q.msgId === item.msgId)) {
      dbg('enqueue duplicate dropped', item.msgId);
      return;
    }
    item.at = performance.now();
    this.started.delete(item);
    this.queue.push(item);

    if (!this.current && (!this.busy || item.manual)) this.playNext();
  }

  /* The user just said something (pipeline: a capture that began at `since` was
   * kept): what the speaker was saying or holding from before is stale and goes.
   * A tap made after `since` is newer than the utterance and stays. */
  supersede(since: number): void {
    const fresh = (it: SpeakerItem) => !!it.manual && (it.at ?? -Infinity) >= since;
    const keep = this.queue.filter(fresh);
    if (this.current && fresh(this.current)) {
      this.queue = keep;
      return;
    }
    this.stopAll();
    if (!keep.length) return;
    this.queue = keep;
    this.playNext();
  }

  pause(): void {
    dbg('pause', this.current?.msgId);
    if (!this.current) return;
    ++this.playGen;
    try {
      this.audio.pause();
    } catch {}
    this.emit('paused', this.current);
  }

  resume(): void {
    dbg('resume', this.current?.msgId);
    if (!this.current) {
      // Blocked by the autoplay policy: the clip went back to the head of the
      // queue, and a press on play is the gesture that starts it.
      if (this.stateName === 'blocked' && this.queue.length) this.playNext();
      return;
    }
    // Still fetching: playing now would run the player with no source and drop
    // the clip. The load in flight starts it.
    if (this.stateName === 'loading') return;
    // Not into a live recording: it resumes when the recording is released.
    if (this.recording()) {
      this.emit('waiting', this.current);
      return;
    }

    if (!this.mayStart(this.current)) {
      dbg('resume refused by the gate');
      return;
    }
    this.playEl(() => this.emit('speaking', this.current || undefined));
  }

  stopAll(): void {
    dbg('stopAll');
    this.queue = [];
    this.current = null;
    ++this.playGen;
    try {
      this.audio.pause();
    } catch {}
    this.emit('idle');
  }

  replay(sessionId: string): void {
    const item = this.lastBySession.get(sessionId);
    if (!item) return;
    this.stopAll();
    this.enqueue(item);
  }

  setBusy(busy: boolean, claim = ALL_CLAIMS): void {
    const was = this.busy;
    const wasRecording = this.recording();
    if (busy) this.busyClaims.add(claim);
    else if (claim === ALL_CLAIMS) this.busyClaims.clear();
    else this.busyClaims.delete(claim);
    this.recordingMayHaveEnded(wasRecording);
    if (this.busyGuard) {
      clearTimeout(this.busyGuard);
      this.busyGuard = 0;
    }
    if (this.busy) {
      this.busyGuard = window.setTimeout(() => {
        this.busyGuard = 0;
        if (!this.busy) return;
        console.warn('[speaker] busy was never released; clearing it', [...this.busyClaims]);

        this.setBusy(false);
      }, 120_000);
      return;
    }

    if (was && !this.current && this.queue.length) this.playNext();
  }

  private emit(state: SpeakerStateName, about?: SpeakerItem): void {
    this.stateName = state;
    const ev: SpeakerState = {state, sessionId: about?.sessionId, msgId: about?.msgId};
    for (const fn of this.stateListeners) fn(ev);
  }

  private playEl(onPlaying: () => void): void {
    const gen = ++this.playGen;
    this.audio
      .play()
      .then(() => {
        if (gen !== this.playGen) {
          dbg('playEl resolved STALE -> pause');
          try {
            this.audio.pause();
          } catch {}
          return;
        }
        dbg('playEl playing');

        this.suppressMediaSession();
        const item = this.current;
        // Timed once, from the enqueue; a resume is not a start.
        if (item && item.at !== undefined && !this.started.has(item)) {
          this.started.add(item);
          cyclog('clip.started', {
            msg: item.msgId,
            reason: item.reason ?? 'tap',
            backend: this.audio.backend,
            ms: Math.round(performance.now() - item.at)
          });
        }
        onPlaying();
      })
      .catch((e) => {
        dbg('playEl rejected', String(e).slice(0, 60), gen === this.playGen ? 'current' : 'stale');
        if (gen !== this.playGen) return;
        const item = this.current;
        if (!item) return;

        if ((e as DOMException)?.name === 'NotAllowedError') {
          cyclog('clip.blocked', {
            session: item.sessionId,
            msg: item.msgId,
            reason: item.reason ?? 'tap',
            why: 'the browser refused play() without a user gesture; the next press starts it'
          });
          this.queue.unshift(item);
          this.current = null;
          this.armGesture();
          return;
        }
        this.failed(item, 'play', e);
      });
  }

  private gestureArmed = false;
  private busyGuard = 0;
  private started = new WeakSet<SpeakerItem>();

  private armGesture(): void {
    if (this.gestureArmed) return;
    this.gestureArmed = true;
    this.emit('blocked');
    const go = () => {
      document.removeEventListener('pointerdown', go, true);
      document.removeEventListener('keydown', go, true);
      this.gestureArmed = false;
      if (this.queue.length && !this.current) this.playNext();
    };
    document.addEventListener('pointerdown', go, true);
    document.addEventListener('keydown', go, true);
  }

  private playNext(): void {
    if (this.queue[0]?.manual && this.recording()) {
      dbg('playNext: the mic is recording; the tap waits', this.queue[0].msgId);
      this.current = null;
      this.emit('waiting', this.queue[0]);
      return;
    }
    if (this.queue.length && !this.mayStart(this.queue[0])) {
      dbg('playNext refused by the gate', this.queue[0].msgId, this.queue.length);
      this.current = null;
      if (!this.busy) this.emit('idle');
      return;
    }
    const item = this.queue.shift();
    if (!item) {
      this.current = null;
      if (!this.busy) this.emit('idle');
      return;
    }
    this.current = item;
    dbg('playNext', item.msgId);
    this.lastBySession.set(item.sessionId, item);
    this.audio.volume = TTS_VOLUME;

    if (this.rateResolver) this.setRate(this.rateResolver());
    this.emit('loading', item);

    void streamAudioUrl(item.msgId, new URL(item.url, location.href).href)
      .then((src) => {
        if (this.current !== item) {
          dbg('cache resolve dropped', item.msgId);
          return;
        }
        dbg('cache resolved', item.msgId, src.slice(0, 12));

        if (this.audio.src === src) {
          try {
            this.audio.currentTime = 0;
          } catch {}
        } else this.audio.src = src;
        if (this.stateName === 'paused') return;
        cyclog('clip.play', {
          session: item.sessionId,
          msg: item.msgId,
          reason: item.reason ?? 'tap'
        });
        this.playEl(() => this.emit('speaking', item));
      })
      .catch((e) => {
        if (this.current !== item) return;
        this.failed(item, 'fetch', e);
      });
  }
}

export const speaker = new Speaker();
