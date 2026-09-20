import {speaker} from './audio/speaker';
import {karaokeFor, karaokeUpdate} from '@/features/chat/content';
import {toast} from './components/widgets';

interface SpeakerEventsDeps {
  onTeardown(d: () => void): void;

  markHeard(sessionId: string, msgId: string): void;
  messageListInner: HTMLElement;

  transcriptOf(audioEl: HTMLElement): HTMLElement | null;
  updateRowAudio(): void;
  updateMessagePlays(): void;
  updatePlayerBar(): void;
  updateVoiceStrip(): void;
}

export function installSpeakerEvents(deps: SpeakerEventsDeps): void {
  const {
    onTeardown,
    markHeard,
    messageListInner,
    transcriptOf,
    updateRowAudio,
    updateMessagePlays,
    updatePlayerBar,
    updateVoiceStrip
  } = deps;

  onTeardown(
    speaker.onState((ev) => {
      if (ev.state === 'speaking' && ev.sessionId && ev.msgId) markHeard(ev.sessionId, ev.msgId);

      if (ev.state === 'finished' && ev.msgId) {
        const el = messageListInner.querySelector<HTMLElement>(
          `.cyc-clip.cyc-voice[data-msg-id="${ev.msgId}"]`
        );
        if (el) {
          const k = karaokeFor(transcriptOf(el));
          if (k) karaokeUpdate(k, 1);
          const fake = el.querySelector<HTMLElement>('.cyc-signal-progress');
          if (fake) fake.style.clipPath = 'inset(0 100% 0 0)';
        }
      }
      updateRowAudio();
      updateMessagePlays();
      updatePlayerBar();
      updateVoiceStrip();
    })
  );

  onTeardown(
    speaker.onError(() => {
      toast('Audio playback failed');
      updatePlayerBar();
    })
  );
}
