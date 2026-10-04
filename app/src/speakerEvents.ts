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

  /* HEARD = PLAYED TO THE END, not started (owner, 2026-10-03): an auto-played
   * reply he stops after a second is not heard, and a heard row counts as seen
   * only through the same contiguous-run rule as a row on screen (heardProgress). */
  onTeardown(
    speaker.onEnded((item) => {
      if (item.sessionId && item.msgId) markHeard(item.sessionId, item.msgId);
    })
  );

  onTeardown(
    speaker.onState((ev) => {
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
