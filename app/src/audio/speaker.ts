import {resolveAudioUrl} from './audioCache';
import {WebAudioClip, unlockPlayback} from './webAudioClip';

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

  manual?: boolean;
};

type SpeakerStateName = 'idle' | 'loading' | 'speaking' | 'paused' | 'finished' | 'blocked';

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
      const bad = this.current;
      this.current = null;
      for (const fn of this.errorListeners) fn(bad);
      this.playNext();
    });
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
    const about = this.current || undefined;
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

  enqueue(item: SpeakerItem): void {
    if (this.current && this.current.sessionId !== item.sessionId) this.stopAll();

    if (this.current?.msgId === item.msgId || this.queue.some((q) => q.msgId === item.msgId)) {
      dbg('enqueue duplicate dropped', item.msgId);
      return;
    }
    this.queue.push(item);

    if (!this.current && !this.busy) this.playNext();
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
    if (!this.current) return;

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
    if (busy) this.busyClaims.add(claim);
    else if (claim === ALL_CLAIMS) this.busyClaims.clear();
    else this.busyClaims.delete(claim);
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
        onPlaying();
      })
      .catch((e) => {
        dbg('playEl rejected', String(e).slice(0, 60), gen === this.playGen ? 'current' : 'stale');
        if (gen !== this.playGen) return;

        if ((e as DOMException)?.name === 'NotAllowedError' && this.current) {
          this.queue.unshift(this.current);
          this.current = null;
          this.armGesture();
          return;
        }
        this.current = null;
        this.playNext();
      });
  }

  private gestureArmed = false;
  private busyGuard = 0;

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

    void resolveAudioUrl(item.msgId, new URL(item.url, location.href).href)
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
        this.playEl(() => this.emit('speaking', item));
      })
      .catch((e) => {
        if (this.current !== item) return;
        console.warn('[speaker] clip unavailable', item.msgId, e);
        this.current = null;
        this.emit('idle');
      });
  }
}

export const speaker = new Speaker();
