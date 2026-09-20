import type {CycMessage, CycSession} from '@/types';
import type {CycEngineMessage} from '@/engine/store';
import type {CycRowAudioState} from '@/features/sessions/components/sessionList';
import type {CycVoiceState} from '@/features/sessions/header/voiceStrip';
import {makeIcon} from '@/components/iconGlyphs';
import {karaokeFor, karaokeUpdate, type Karaoke} from '@/features/chat/content';
import {toast} from '@/components/widgets';

export type MessageRef = {ts: number; role: 'user' | 'claude'; seq?: number};

export type SpeakerLike = {
  state: {state: string; msgId?: string | null; sessionId?: string | null; text?: string | null};
  enqueue(item: {
    msgId: string;
    url: string;
    text: string;
    sessionId: string;
    durationS?: number;
    manual?: boolean;
  }): void;
  pause(): void;
  resume(): void;
  stopAll(): void;
  seek(ratio: number): void;
  times(): {t: number; dur: number};
  progress(): {ratio: number; msgId?: string | null};
};

export type AudioPlaybackDeps = {
  messageListInner: HTMLElement;
  chatEl: HTMLElement;
  audioJumpChip: HTMLElement;
  leftContent: HTMLElement;
  scrollContainer: () => HTMLElement;

  sessionList: {setRowAudioState: (sessionId: string, state: CycRowAudioState) => void};
  header: {setVoiceState: (state: CycVoiceState | null) => void};
  playerBar: {
    show: (now: {chat: string; text: string; playing: boolean; loading: boolean} | null) => void;
    progress: (t: number, dur: number, ratio: number) => void;
  };
  speaker: SpeakerLike;

  store: {
    get: (id: string) => CycSession | undefined;
    audioUrl: (sessionId: string, msgId: string) => string;
  };

  isLive: () => boolean;
  isChatViewOpen: () => boolean;
  appConversationMode: () => boolean;
  chatConversationModeHas: (sessionId: string) => boolean;
  active: () => CycSession | null | undefined;
  allSessions: () => CycSession[];
  heardTsOf: (s: CycSession) => number;

  decodedDurations: Map<string, number>;
  growingOf: (msgId: string) => {text: string; durS?: number; chars?: number} | undefined;
  capRecState: () => string;
  goToMessage: (sessionId: string, ref: MessageRef, msgId?: string) => Promise<boolean>;
  onTeardown: (d: () => void) => void;
};

export const transcriptOf = (audioEl: HTMLElement) =>
  audioEl.parentElement?.querySelector<HTMLElement>('.cyc-karaoke') ?? null;

export function createAudioPlayback(deps: AudioPlaybackDeps) {
  const {
    messageListInner,
    chatEl,
    audioJumpChip,
    leftContent,
    sessionList,
    header,
    playerBar,
    speaker,
    store,
    decodedDurations
  } = deps;

  function play(sessionId: string, msgId: string, text: string, manual = false) {
    speaker.enqueue({
      msgId,
      url: store.audioUrl(sessionId, msgId),
      text,
      sessionId,
      durationS: knownDuration(sessionId, msgId) ?? deps.growingOf(msgId)?.durS,
      manual
    });
  }

  function knownDuration(sessionId: string, msgId: string): number | undefined {
    const m = store.get(sessionId)?.messages.find((x) => (x as CycEngineMessage).msgId === msgId);
    return m?.durationS ?? decodedDurations.get(msgId);
  }

  function latestSpeakable(id: string): {msgId: string; text: string; ts: number} | undefined {
    const s = store.get(id);
    if (!s) return undefined;
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const m = s.messages[i] as CycEngineMessage;

      if (m.role === 'claude' && m.msgId) return {msgId: m.msgId, text: m.text, ts: m.ts};
    }
    return undefined;
  }

  function rowAudioState(id: string): CycRowAudioState {
    if (!deps.appConversationMode() || !deps.isLive()) return 'none';
    const st = speaker.state;
    if (st.sessionId === id) {
      if (st.state === 'speaking') return 'speaking';
      if (st.state === 'paused') return 'paused';
    }
    const latest = latestSpeakable(id);
    if (!latest) return 'none';
    const s = store.get(id);
    return s && latest.ts <= deps.heardTsOf(s) ? 'finished' : 'speakable';
  }

  function updateRowAudio() {
    for (const s of deps.allSessions()) sessionList.setRowAudioState(s.id, rowAudioState(s.id));
  }

  function rowAudioClick(id: string) {
    const st = speaker.state;
    if (st.sessionId === id) {
      if (st.state === 'speaking') {
        speaker.pause();
        return;
      }
      if (st.state === 'paused') {
        speaker.resume();
        return;
      }
    }
    const latest = latestSpeakable(id);
    if (!latest) {
      toast('Nothing to play yet');
      return;
    }

    play(id, latest.msgId, latest.text, true);
  }

  function onMessagePlay(m: CycMessage, el: HTMLElement) {
    const em = m as CycEngineMessage;
    const s = deps.active();

    if (!deps.isLive() || !em.msgId || !s) return;
    const st = speaker.state;
    if (st.msgId === em.msgId) {
      if (st.state === 'speaking') {
        speaker.pause();
        return;
      }
      if (st.state === 'paused') {
        speaker.resume();
        return;
      }
    }

    speaker.stopAll();
    play(s.id, em.msgId, m.text, true);

    for (const next of s.messages.slice(s.messages.findIndex((x) => x.id === m.id) + 1)) {
      const nm = next as CycEngineMessage;
      if (next.role !== 'claude' || !nm.msgId) continue;
      play(s.id, nm.msgId, next.text, true);
    }
  }

  let pendingSeek: {msgId: string; ratio: number} | null = null;
  function onMessageSeek(m: CycMessage, ratio: number) {
    const em = m as CycEngineMessage;
    const s = deps.active();
    if (!deps.isLive() || !em.msgId || !s) return;
    const st = speaker.state;
    if (st.msgId === em.msgId && (st.state === 'speaking' || st.state === 'paused')) {
      speaker.seek(ratio);
      if (st.state === 'paused') speaker.resume();
      return;
    }
    pendingSeek = {msgId: em.msgId, ratio};
    speaker.stopAll();
    play(s.id, em.msgId, m.text, true);
  }

  let tickMsgId = '';
  let tickAudioEl: HTMLElement | null = null;
  let tickFake: HTMLElement | null = null;
  let tickClock: HTMLElement | null = null;
  let tickFillStep = -1;
  let karaoke: Karaoke | null = null;

  let lastClock = '';

  function forgetTickTargets() {
    tickMsgId = '';
    tickAudioEl = tickFake = tickClock = null;
    tickFillStep = -1;
    lastClock = '';
    karaoke = null;
  }

  let paintedPlayId = '';
  function paintPlayState(msgId: string, playing: boolean, loading: boolean, clearFill: boolean) {
    if (!msgId) return;
    const sel = (what: string) => `${what}[data-msg-id="${CSS.escape(msgId)}"]`;
    messageListInner.querySelectorAll<HTMLElement>(sel('.cyc-msg-play')).forEach((btn) => {
      btn.classList.toggle('cyc-audible', playing);

      btn.classList.toggle('cyc-pending', loading);
      btn.replaceChildren(makeIcon(playing ? 'pause' : 'play'));
    });

    messageListInner.querySelectorAll<HTMLElement>(sel('.cyc-clip.cyc-voice')).forEach((audioEl) => {
      audioEl.querySelector('.cyc-clip-toggle')?.classList.toggle('playing', playing);
      audioEl.querySelector('.cyc-clip-toggle')?.classList.toggle('cyc-pending', loading);

      if (clearFill) {
        const wf = audioEl.querySelector<HTMLElement>('.cyc-signal-progress');
        if (wf) wf.style.clipPath = 'inset(0 100% 0 0)';
      }
    });
  }

  function updateMessagePlays() {
    const st = speaker.state;
    const now = st.msgId ?? '';
    if (paintedPlayId && paintedPlayId !== now) paintPlayState(paintedPlayId, false, false, true);
    paintPlayState(now, st.state === 'speaking', st.state === 'loading', false);
    paintedPlayId = now;
    if (st.state === 'speaking') startProgressTicker();

    updateAudioJumpChip();
  }

  function updateAudioJumpChip() {
    const st = speaker.state;
    const cur = deps.active();
    const mine =
      st.state === 'speaking' &&
      !!st.msgId &&
      !!st.sessionId &&
      !!cur &&
      cur.id === st.sessionId &&
      deps.isChatViewOpen();
    let dir: 'up' | 'down' | null = null;
    if (mine) {
      const el = messageListInner.querySelector<HTMLElement>(
        `.cyc-clip.cyc-voice[data-msg-id="${CSS.escape(st.msgId!)}"]`
      );
      if (!el) {
        dir = 'up';
      } else {
        const view = deps.scrollContainer().getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (r.bottom <= view.top) dir = 'up';
        else if (r.top >= view.bottom) dir = 'down';
      }
    }
    chatEl.toggleAttribute('data-cyc-audiojump', dir !== null);
    audioJumpChip.classList.toggle('is-up', dir === 'up');
    audioJumpChip.classList.toggle('is-down', dir === 'down');
  }

  const playerStates = new Set(['loading', 'speaking', 'paused', 'blocked']);

  function playerSubject(): {session: CycSession; msgId: string} | null {
    const st = speaker.state;

    if (!playerStates.has(st.state) || !st.sessionId || !st.msgId) return null;
    const session = deps.allSessions().find((x) => x.id === st.sessionId);
    return session ? {session, msgId: st.msgId} : null;
  }

  function updatePlayerBar() {
    const st = speaker.state;
    const subject = playerSubject();
    if (!subject) {
      playerBar.show(null);
      leftContent.classList.remove('cyc-has-player');
      return;
    }
    playerBar.show({
      chat: subject.session.title?.text ?? subject.session.name,
      text: (st.text ?? '').trim(),
      playing: st.state === 'speaking',
      loading: st.state === 'loading'
    });
    leftContent.classList.add('cyc-has-player');

    const times = speaker.times();
    playerBar.progress(times.t, times.dur, speaker.progress().ratio);
  }

  function openPlayingMessage() {
    const subject = playerSubject();
    if (!subject) return;
    /* A real playing subject always travels through goToMessage, the same path
     * reply-jump uses: it awaits ensureMessageHeld to page the message into the
     * window, then scrolls. When the message is still held we hand over its own
     * ref (ts/role/seq) so the paging is exact; otherwise we hand a spoken-role
     * ref and let ensureMessageHeld be the arbiter. The toast is the last resort,
     * fired only when the message genuinely cannot be held. */
    const held = subject.session.messages.find(
      (x) => (x as CycEngineMessage).msgId === subject.msgId
    );
    const ref: MessageRef = held
      ? (held as MessageRef)
      : {ts: Number.MAX_SAFE_INTEGER, role: 'claude'};
    void deps.goToMessage(subject.session.id, ref, subject.msgId).then((ok) => {
      if (!ok) toast('That message is not loaded');
    });
  }

  let progressTimer = 0;
  function startProgressTicker() {
    if (progressTimer) return;
    const tick = () => {
      const st = speaker.state;
      if (st.state !== 'speaking') {
        progressTimer = 0;
        forgetTickTargets();
        updateAudioJumpChip();
        return;
      }
      progressTimer = requestAnimationFrame(tick);
      const p = speaker.progress();
      const times = speaker.times();

      playerBar.progress(times.t, times.dur, p.ratio);

      updateAudioJumpChip();
      if (!p.msgId) return;
      if (pendingSeek && pendingSeek.msgId === p.msgId) {
        speaker.seek(pendingSeek.ratio);
        pendingSeek = null;
      }

      if (p.msgId !== tickMsgId || !tickAudioEl || !tickAudioEl.isConnected) {
        tickMsgId = p.msgId;
        tickAudioEl = messageListInner.querySelector<HTMLElement>(
          `.cyc-clip.cyc-voice[data-msg-id="${p.msgId}"]`
        );
        tickFake = tickAudioEl?.querySelector<HTMLElement>('.cyc-signal-progress') ?? null;
        tickClock = tickAudioEl?.querySelector<HTMLElement>('.cyc-clip-time') ?? null;
        karaoke = tickAudioEl ? karaokeFor(transcriptOf(tickAudioEl)) : null;

        karaoke?.el.classList.add('cyc-hot');

        tickFillStep = -1;
        lastClock = '';
      }
      if (!tickAudioEl) return;

      if (tickFake) {
        const step = Math.round(p.ratio * 1000);
        if (step !== tickFillStep) {
          tickFillStep = step;
          tickFake.style.clipPath = `inset(0 ${(100 - step / 10).toFixed(1)}% 0 0)`;
        }
      }
      if (tickClock && times.dur > 0) {
        const f = (x: number) =>
          `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
        const text = `${f(times.t)} / ${f(times.dur)}`;

        if (text !== lastClock) {
          lastClock = text;
          tickClock.textContent = text;
        }
      }
      if (karaoke) {
        const g = deps.growingOf(p.msgId);
        const capRatio =
          g && g.chars !== undefined && g.text.length > 0 ? g.chars / g.text.length : undefined;
        karaokeUpdate(karaoke, p.ratio, capRatio);
      }
    };
    progressTimer = requestAnimationFrame(tick);
  }
  deps.onTeardown(() => {
    if (progressTimer) cancelAnimationFrame(progressTimer);
  });

  function updateVoiceStrip() {
    const s = deps.active();
    if (!deps.isLive() || !s || !deps.chatConversationModeHas(s.id)) {
      header.setVoiceState(null);
      return;
    }
    let v: CycVoiceState = 'listening';
    if (deps.capRecState() === 'recording') v = 'you-cut-in';
    else if (deps.capRecState() === 'transcribing') v = 'transcribing';
    else if (speaker.state.sessionId === s.id && speaker.state.state === 'speaking') v = 'speaking';
    header.setVoiceState(v);
  }

  return {
    play,
    knownDuration,
    latestSpeakable,
    rowAudioState,
    updateRowAudio,
    rowAudioClick,
    onMessagePlay,
    onMessageSeek,
    updateMessagePlays,
    updateAudioJumpChip,
    updatePlayerBar,
    openPlayingMessage,
    startProgressTicker,
    updateVoiceStrip
  };
}
