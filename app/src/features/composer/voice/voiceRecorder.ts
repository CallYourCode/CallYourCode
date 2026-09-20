import {h} from '../../../components/domHelpers';
import {BTN_HOVER_UTILS, makeIcon} from '../../../components/iconGlyphs';
import {COMPOSER_ICON_TRANSITION} from '../components/composerModel';

// Recording pill + level strip. Loudness is a rolling percentile, not a lifetime peak.

const SLOT_COUNT = 56;
// Rolling window feeding the adaptive gain reference (a recent slice of the level buffer).
const GAIN_WINDOW = 40;
// The gain reference is a high percentile of that window: the loud edge of recent speech.
const GAIN_PERCENTILE = 0.82;
// A silence floor so a near-silent window cannot blow the gain up to infinity.
const GAIN_FLOOR = 0.06;
// Shortest painted bar, so quiet-but-present speech still reads as a mark on the strip.
const LEVEL_MIN = 0.14;
// Keyboard scrub increment on the seek slider.
const SEEK_STEP = 0.05;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

// Format elapsed capture time as a compact M:SS readout (zero-padded seconds). A
// voice memo reads its length in whole seconds; sub-second precision is noise on a
// live counter, so the recorder owns the format and ticks once per second.
const formatElapsed = (ms: number): string => {
  const total = Math.floor(Math.max(ms, 0) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
};

export const RECORDER_EVENTS = {
  cancel: 'cyc-rec:cancel',
  pause: 'cyc-rec:pause',
  play: 'cyc-rec:play',
  seek: 'cyc-rec:seek'
} as const;

export interface RecorderState {
  // 'recording' shows the live capture pulse; 'review' flips to the paused/playback pill.
  phase?: 'recording' | 'review';
  // Reset the level strip and playhead (a fresh take).
  reset?: boolean;
  // Elapsed capture time in milliseconds; the recorder formats it (M:SS) for the
  // readout. Undefined leaves the current readout in place.
  elapsedMs?: number;
  // Append one live amplitude sample (0..1) to the strip.
  peak?: number;
  // Playback affordances during review.
  playing?: boolean;
  seekable?: boolean;
  // Playhead position (0..1) over the strip; null clears it (fully-lit recording strip).
  playhead?: number | null;
}

export interface Recorder {
  element: HTMLDivElement;
  renderRecorder(state: RecorderState): void;
}

export interface RecorderOptions {
  showPauseToggle?: boolean;
}

// The reduced render state. `renderRecorder` folds each incoming patch onto this object and
// then `paint()` reflects the whole of it onto the DOM, so rendering is idempotent.
interface RecorderView {
  mode: 'capture' | 'review';
  playing: boolean;
  scrubbable: boolean;
  progress: number | null;
}

// The gain reference: the GAIN_PERCENTILE tap of the most recent GAIN_WINDOW samples,
// floored so silence cannot amplify to nothing.
function gainReference(buffer: number[]): number {
  if (buffer.length === 0) return GAIN_FLOOR;
  const from = buffer.length > GAIN_WINDOW ? buffer.length - GAIN_WINDOW : 0;
  const recent = buffer.slice(from).sort((a, b) => a - b);
  const tap = Math.floor((recent.length - 1) * GAIN_PERCENTILE);
  return Math.max(recent[tap], GAIN_FLOOR);
}

export function createRecorder(opts: RecorderOptions = {}): Recorder {
  const element = h(
    'div',
    'cyc-rec-panel absolute top-0 bottom-0 start-0 [inset-inline-end:calc(3rem+0.5rem)] ' +
      'flex items-center gap-1 py-0 pe-0 [padding-inline-start:inherit] opacity-0 invisible pointer-events-none ' +
      '[transition:opacity_0.15s_ease,visibility_0s_linear_0.15s] bg-[var(--cyc-surface)] rounded-[inherit] z-[2] ' +
      '[.cyc-composer[data-cyc-recording]_&]:opacity-100 [.cyc-composer[data-cyc-recording]_&]:visible ' +
      '[.cyc-composer[data-cyc-recording]_&]:pointer-events-auto ' +
      '[.cyc-composer[data-cyc-recording]_&]:[transition:opacity_0.15s_ease,visibility_0s_linear_0s]'
  );

  const emit = (name: string, detail?: number) =>
    element.dispatchEvent(new CustomEvent(name, {detail}));

  const wire = (btn: HTMLButtonElement, name: string) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      emit(name);
    });
  };

  const view: RecorderView = {mode: 'capture', playing: false, scrubbable: false, progress: null};

  // --- level strip ----------------------------------------------------------
  // A fixed row of SLOT_COUNT bars built once. `samples` is the rolling amplitude buffer
  // (newest last, capped at SLOT_COUNT); paint maps it right-aligned onto the slots so the
  // strip fills from the trailing edge and scrolls as it saturates.
  const strip = h(
    'div',
    'cyc-rec-strip flex h-7 min-w-0 flex-auto items-center justify-end gap-[2px] overflow-hidden outline-none',
    {
      role: 'slider',
      'aria-label': 'Recording position',
      'aria-valuemin': '0',
      'aria-valuemax': '100'
    }
  );
  const slots: HTMLDivElement[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const bar = h('div', 'cyc-rec-level flex-1 self-center rounded-full bg-[var(--cyc-accent)]', {
      'aria-hidden': 'true'
    });
    bar.style.height = '0%';
    slots.push(bar);
  }
  strip.append(...slots);

  const samples: number[] = [];

  const paintStrip = () => {
    const reference = gainReference(samples);
    const offset = SLOT_COUNT - samples.length;
    const played =
      view.progress == null ? SLOT_COUNT : Math.round(clamp01(view.progress) * SLOT_COUNT);
    for (let i = 0; i < SLOT_COUNT; i++) {
      const bar = slots[i];
      const s = i - offset;
      if (s < 0) {
        bar.style.height = '0%';
        bar.classList.remove('is-ahead');
        continue;
      }
      const level = LEVEL_MIN + (1 - LEVEL_MIN) * clamp01(samples[s] / reference);
      bar.style.height = `${Math.round(level * 100)}%`;
      bar.classList.toggle('is-ahead', view.progress != null && i >= played);
    }
  };

  const seekFromClientX = (clientX: number) => {
    const rect = strip.getBoundingClientRect();
    if (rect.width <= 0) return;
    emit(RECORDER_EVENTS.seek, clamp01((clientX - rect.left) / rect.width));
  };

  strip.addEventListener('click', (e) => {
    if (view.scrubbable) seekFromClientX(e.clientX);
  });

  strip.addEventListener('keydown', (e) => {
    if (!view.scrubbable) return;
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    emit(RECORDER_EVENTS.seek, clamp01((view.progress ?? 0) + dir * SEEK_STEP));
  });

  const discardBtn = h(
    'button',
    'cyc-icon-btn cyc-rec-cancel text-(--cyc-danger)! flex items-center justify-center flex-none p-0! text-[1.5rem]! ' +
      'w-10 h-10 ' +
      `${COMPOSER_ICON_TRANSITION} ` +
      'fine:hover:bg-(--cyc-danger-tint)! fine:active:bg-(--cyc-danger-tint)! ' +
      '[.cyc-composer[data-cyc-recording]_&]:opacity-100! [.cyc-composer[data-cyc-recording]_&]:pointer-events-auto ' +
      '[.cyc-composer[data-cyc-recording]:not(.cyc-rec-locked)_&]:hidden',
    {'aria-label': 'Discard recording'}
  );
  discardBtn.append(makeIcon('delete', 'cyc-rec-cancel-icon'));

  const dot = h(
    'div',
    'cyc-rec-dot h-2.5 w-2.5 rounded-full bg-[var(--cyc-danger)] ' +
      '[animation:cyc-rec-dot-ring_1.4s_ease-in-out_infinite] ' +
      '[.cyc-rec-panel[data-cyc-rec=review]_&]:hidden'
  );
  const playbackBtn = h(
    'button',
    'cyc-icon-btn cyc-rec-play hidden! flex-none items-center justify-center text-[1rem]! p-0! ' +
      `${COMPOSER_ICON_TRANSITION} ` +
      'w-10! h-10! rounded-[10px]! bg-[var(--cyc-fill-color)]! text-white! ' +
      '[.cyc-rec-panel[data-cyc-rec=review]_&]:flex! ' +
      'fine:hover:bg-(--cyc-accent-pressed)! fine:active:bg-(--cyc-accent-pressed)! ' +
      '[.cyc-composer[data-cyc-recording]_&]:opacity-100! [.cyc-composer[data-cyc-recording]_&]:pointer-events-auto',
    {'aria-label': 'Play recording'}
  );
  playbackBtn.append(
    makeIcon(
      'play',
      'cyc-rec-play-icon is-rec-play leading-none [.cyc-rec-panel[data-cyc-playing]_&]:hidden!'
    ),
    makeIcon(
      'pause',
      'cyc-rec-play-icon is-rec-playpause leading-none hidden! ' +
        '[.cyc-rec-panel[data-cyc-playing]_&]:inline-flex!'
    )
  );
  const control = h(
    'div',
    'cyc-rec-control relative flex flex-none w-10 items-center justify-center'
  );
  control.append(playbackBtn, dot);

  const timerEl = h(
    'span',
    'cyc-rec-timer min-w-12 flex-none select-none text-end text-sm leading-none tabular-nums text-[var(--cyc-text)]'
  );

  const pill = h(
    'div',
    'cyc-rec-body flex min-w-0 flex-auto items-center gap-2.5 rounded-3xl bg-[var(--cyc-accent-tint)] py-1.5 ps-2 pe-3'
  );
  pill.append(control, strip, timerEl);

  const pauseBtn = h(
    'button',
    'cyc-icon-btn cyc-rec-pause-toggle flex items-center justify-center flex-none p-0! text-[1.5rem]! ' +
      'text-(--cyc-text-muted) w-10 h-10 ' +
      `${COMPOSER_ICON_TRANSITION} ` +
      `[.cyc-composer[data-cyc-recording]_&]:opacity-100! [.cyc-composer[data-cyc-recording]_&]:pointer-events-auto ${BTN_HOVER_UTILS}`,
    {'aria-label': 'Pause recording'}
  );
  pauseBtn.append(
    makeIcon(
      'pause',
      'cyc-rec-pause-icon is-rec-pause leading-none [.cyc-rec-panel[data-cyc-rec=review]_&]:hidden!'
    ),
    makeIcon(
      'microphone',
      'cyc-rec-pause-icon is-rec-mic leading-none hidden! ' +
        '[.cyc-rec-panel[data-cyc-rec=review]_&]:inline-flex!'
    )
  );
  if (opts.showPauseToggle === false) pauseBtn.classList.add('cyc-off');

  // Visible order: discard | pill | pause toggle. The composer inserts its slide-to-cancel
  // hint between the discard button and the pill, so that ordering is a shared contract.
  element.append(discardBtn, pill, pauseBtn);

  wire(discardBtn, RECORDER_EVENTS.cancel);
  wire(pauseBtn, RECORDER_EVENTS.pause);
  wire(playbackBtn, RECORDER_EVENTS.play);

  const setTimer = (text: string) => {
    if (timerEl.textContent !== text) timerEl.textContent = text;
  };

  const paint = () => {
    element.dataset.cycRec = view.mode === 'review' ? 'review' : 'recording';
    element.toggleAttribute('data-cyc-playing', view.playing);
    strip.classList.toggle('is-scrubbable', view.scrubbable);
    strip.tabIndex = view.scrubbable ? 0 : -1;
    strip.setAttribute('aria-valuenow', String(Math.round(clamp01(view.progress ?? 0) * 100)));
    paintStrip();
  };

  const renderRecorder = (state: RecorderState) => {
    if (state.reset) {
      samples.length = 0;
      view.progress = null;
    }
    if (state.phase === 'recording') {
      view.mode = 'capture';
      view.playing = false;
      view.progress = null;
    } else if (state.phase === 'review') {
      view.mode = 'review';
    }
    if (state.playing !== undefined) view.playing = state.playing;
    if (state.seekable !== undefined) view.scrubbable = state.seekable;
    if ('playhead' in state) view.progress = state.playhead ?? null;
    if (state.peak !== undefined) {
      samples.push(clamp01(state.peak));
      if (samples.length > SLOT_COUNT) samples.shift();
    }
    if (state.elapsedMs !== undefined) setTimer(formatElapsed(state.elapsedMs));
    paint();
  };

  // The recorder opens in capture mode with an empty readout; the composer feeds the
  // elapsed time in once capture begins.
  renderRecorder({phase: 'recording', playing: false});

  return {element, renderRecorder};
}
