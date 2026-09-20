import {realWaveforms, fillSignalSamples} from './waveform';
import {resolveAudioUrl} from '../../../audio/audioCache';
import {engineCapFetch} from '../../../engine/contract';
import {mmss} from '@/features/chat/content';

interface WaveformHydratorDeps {
  messageListInner: HTMLElement;
  isLive(): boolean;
  activeId(): string | null;
  audioUrl(sessionId: string, msgId: string): string;
}

export function createWaveformHydrator(deps: WaveformHydratorDeps) {
  const {messageListInner} = deps;
  let decodeCtx: AudioContext | null = null;
  const hydrating = new Set<string>();

  const decodedDurations = new Map<string, number>();
  const HYDRATE_AT_ONCE = 2;
  const hydrateQueue: string[] = [];
  let hydrateRunning = 0;
  let wfObserver: IntersectionObserver | null = null;

  const wfSeen = new WeakSet<HTMLElement>();

  function pumpHydrate() {
    while (hydrateRunning < HYDRATE_AT_ONCE && hydrateQueue.length) {
      const msgId = hydrateQueue.shift()!;
      hydrateRunning++;
      void hydrateOne(msgId).finally(() => {
        hydrateRunning--;
        pumpHydrate();
      });
    }
  }

  function wantWaveform(msgId: string) {
    if (realWaveforms.has(msgId) || hydrating.has(msgId)) return;
    if (hydrateQueue.includes(msgId)) return;
    hydrateQueue.push(msgId);
    pumpHydrate();
  }

  function hydrateWaveforms() {
    if (!deps.isLive()) return;

    wfObserver ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const id = (e.target as HTMLElement).dataset.msgId;
          if (id) wantWaveform(id);
        }
      },
      {root: messageListInner.closest('.cyc-message-list-scroll') ?? null, rootMargin: '100% 0px'}
    );

    const toFill: {audioEl: HTMLElement; strip: HTMLElement}[] = [];
    messageListInner
      .querySelectorAll<HTMLElement>('.cyc-clip.cyc-voice[data-msg-id]')
      .forEach((audioEl) => {
        if (audioEl.classList.contains('is-growing')) return;
        if (wfSeen.has(audioEl)) return;
        wfSeen.add(audioEl);
        const msgId = audioEl.dataset.msgId!;
        if (realWaveforms.has(msgId)) {
          if (audioEl.dataset.wf !== '1') {
            audioEl.querySelectorAll<HTMLElement>('.cyc-signal-meter').forEach((c) => {
              if (!c.dataset.signalDrawn) return;
              c.querySelectorAll<HTMLElement>('.cyc-signal-samples').forEach((strip) => {
                toFill.push({audioEl, strip});
              });
            });
          }
          return;
        }

        wfObserver!.observe(audioEl);
      });
    for (const {audioEl, strip} of toFill) {
      audioEl.dataset.wf = '1';
      fillSignalSamples(strip);
    }
  }

  async function hydrateOne(msgId: string): Promise<void> {
    if (realWaveforms.has(msgId) || hydrating.has(msgId)) return;
    {
      hydrating.add(msgId);
      const audioSessionId = deps.activeId();
      {
        try {
          const rowSrc = messageListInner.querySelector<HTMLElement>(
            `.cyc-clip.cyc-voice[data-msg-id="${CSS.escape(msgId)}"]`
          )?.dataset.audioSrc;
          if (!rowSrc && !audioSessionId) throw new Error('no active chat');
          const src =
            rowSrc ?? (await resolveAudioUrl(msgId, deps.audioUrl(audioSessionId!, msgId)));

          const buf = /^https?:/i.test(src)
            ? await (await engineCapFetch(src)).arrayBuffer()
            : await (await fetch(src)).arrayBuffer();
          decodeCtx ??= new AudioContext();
          const audio = await decodeCtx.decodeAudioData(buf);
          const ch = audio.getChannelData(0);
          const buckets = 120;
          const env: number[] = [];
          const step = Math.max(1, Math.floor(ch.length / buckets));
          let peak = 0;
          for (let b = 0; b < buckets; b++) {
            let mx = 0;
            const off = b * step;
            for (let i = off; i < Math.min(off + step, ch.length); i += 16) {
              const v = Math.abs(ch[i]);
              if (v > mx) mx = v;
            }
            env.push(mx);
            if (mx > peak) peak = mx;
          }
          realWaveforms.set(
            msgId,
            env.map((v) => (peak > 0 ? v / peak : 0))
          );

          if (audio.duration > 0) decodedDurations.set(msgId, audio.duration);

          const el = messageListInner.querySelector<HTMLElement>(
            `.cyc-clip.cyc-voice[data-msg-id="${msgId}"]`
          );
          if (el) {
            el.dataset.wf = '1';

            el.querySelectorAll<HTMLElement>('.cyc-signal-samples').forEach((strip) => {
              if (strip.closest<HTMLElement>('.cyc-signal-meter')?.dataset.signalDrawn)
                fillSignalSamples(strip);
            });
            const clock = el.querySelector<HTMLElement>('.cyc-clip-time');
            if (clock && !clock.dataset.known) {
              const d = Math.round(audio.duration);

              clock.textContent = mmss(d);
              clock.dataset.known = '1';
            }
          }
        } catch {
          hydrating.delete(msgId);
        }
      }
    }
  }

  return {hydrateWaveforms, decodedDurations};
}
