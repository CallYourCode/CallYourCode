import {h} from '../../../components/domHelpers';

const SAMPLE_COUNT = 56;

// Each sample's height is a share of the track: silence still shows a small stub,
// a peak nearly fills it. JS only maps a normalized 0..1 peak into this band; the
// track's pixel height is a CSS concern (the meter sets it).
const MIN_SAMPLE_PERCENT = 15;
const SAMPLE_PERCENT_SPAN = 75;

const SAMPLE_CLASS =
  'cyc-signal-sample flex-1 min-w-0 rounded-[1px] bg-[var(--cyc-accent)] ' +
  '[.cyc-signal-track_&]:opacity-40 [.cyc-clip.cyc-voice_.cyc-signal-track_&]:opacity-45 ' +
  'hover:[.cyc-signal-track_&]:fine:opacity-90! active:[.cyc-signal-track_&]:fine:opacity-90!';

export function signalStrip(className: string): HTMLDivElement {
  const div = h('div', className);
  div.append(h('div', 'cyc-signal-samples flex items-end gap-px h-full w-full'));
  return div;
}

let signalObserver: IntersectionObserver | null = null;

function drawSignal(container: HTMLElement): void {
  if (container.dataset.signalDrawn) return;
  container.dataset.signalDrawn = '1';
  container.querySelectorAll<HTMLElement>('.cyc-signal-samples').forEach(fillSignalSamples);
}

export function mountWaveform(container: HTMLElement, eager: boolean): void {
  if (eager) {
    drawSignal(container);
    return;
  }
  if (typeof IntersectionObserver === 'undefined') {
    requestAnimationFrame(() => drawSignal(container));
    return;
  }
  signalObserver ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        signalObserver!.unobserve(e.target);
        drawSignal(e.target as HTMLElement);
      }
    },
    {rootMargin: '100% 0px'}
  );
  signalObserver.observe(container);
}

export const realWaveforms = new Map<string, number[]>();

// Fill one samples track: SAMPLE_COUNT stubs whose heights follow the decoded
// envelope (peak per bucket, already normalized to 0..1 by the hydrator) or a
// deterministic placeholder wave until the audio decodes.
export function fillSignalSamples(strip: HTMLElement): void {
  const msgId = strip.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId;
  const env = msgId ? realWaveforms.get(msgId) : undefined;
  const samples: HTMLElement[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    let peak: number;
    if (env && env.length) {
      const a = Math.floor((i / SAMPLE_COUNT) * env.length);
      const b = Math.max(a + 1, Math.floor(((i + 1) / SAMPLE_COUNT) * env.length));
      peak = Math.max(...env.slice(a, b));
    } else {
      peak = Math.abs(Math.sin(i * 1.7));
    }
    const sample = h('div', SAMPLE_CLASS);
    sample.style.height = `${(MIN_SAMPLE_PERCENT + peak * SAMPLE_PERCENT_SPAN).toFixed(2)}%`;
    samples.push(sample);
  }
  strip.replaceChildren(...samples);
}
