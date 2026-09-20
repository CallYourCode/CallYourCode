import {h} from '@/components/domHelpers';
import {BTN_HOVER_UTILS, BTN_ICON_BASE, makeIcon} from '@/components/iconGlyphs';

type PlayerBarNow = {
  chat: string;

  text: string;

  playing: boolean;

  loading: boolean;
};

type AudioPlayerBar = {
  el: HTMLElement;

  show: (now: PlayerBarNow | null) => void;

  progress: (t: number, dur: number, ratio: number) => void;
  isShown: () => boolean;
};

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function createAudioPlayerBar(opts: {
  onToggle: () => void;

  onOpen: () => void;

  onClose: () => void;
}): AudioPlayerBar {
  // Player bar container.
  const el = h(
    'div',
    'cyc-bar cyc-player-bar cyc-off flex justify-between items-center p-1 ' +
      'absolute z-[2] left-[1rem] max-tab:left-[1.5rem] ' +
      'right-[calc(1rem+env(safe-area-inset-right,0px)+3.5rem+0.625rem)] max-tab:right-[calc(1.5rem+env(safe-area-inset-right,0px)+3.5rem+0.625rem)] ' +
      'bottom-[calc(1rem+var(--cyc-safe-bottom))] max-tab:bottom-[calc(1.5rem+var(--cyc-safe-bottom))] ' +
      'h-[3rem] rounded-[0.875rem] bg-[var(--cyc-surface)] ' +
      'shadow-[0_1px_8px_rgba(0,0,0,0.18)] overflow-hidden'
  );
  const wrapper = h(
    'div',
    'cyc-bar-wrap cyc-player-wrapper flex flex-auto items-center max-w-full ' +
      'cursor-default pl-2 pr-1 h-full'
  );

  const toggle = h(
    'button',
    'cyc-icon-btn active cyc-player-ico flex-none flex items-center justify-center text-center leading-none relative ' +
      'text-[1.5rem]! p-2! text-(--cyc-accent) [transition:color_0.15s_ease-in-out,opacity_0.15s_ease-in-out] ' +
      '[.cyc-player-loading_&]:opacity-50 fine:hover:bg-(--cyc-accent-tint)! fine:active:bg-(--cyc-accent-tint)!'
  );
  toggle.title = 'pause';
  toggle.append(makeIcon('pause'));
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onToggle();
  });

  const content = h(
    'div',
    `cyc-bar-content cyc-player-content cyc-lit flex-auto overflow-hidden relative ` +
      `me-2 ms-1 py-1 ps-2 pe-1 rounded-lg cursor-pointer [pointer-events:all] ${BTN_HOVER_UTILS}`
  );
  const title = h(
    'div',
    'cyc-bar-title cyc-player-title [font-size:0.875rem] ' +
      '[line-height:18px] w-full max-w-full whitespace-nowrap ' +
      'text-ellipsis overflow-hidden font-medium'
  );
  const subtitle = h(
    'div',
    'cyc-bar-subtitle cyc-player-subtitle [font-size:0.875rem] ' +
      '[line-height:18px] w-full max-w-full whitespace-nowrap ' +
      'text-ellipsis overflow-hidden text-[var(--cyc-text-muted)]'
  );
  const time = h('span', 'cyc-player-time');
  const said = h('span', 'cyc-player-said opacity-80');
  subtitle.append(time, document.createTextNode(' · '), said);
  content.append(title, subtitle);
  content.addEventListener('click', () => opts.onOpen());

  const utils = h(
    'div',
    'cyc-bar-wrap-utils cyc-player-wrapper-utils flex flex-none items-center relative'
  );
  // `flex-none` migrates the base `.cyc-bar .cyc-icon-btn { flex:0 0 auto }` for the
  // in-flow close button.
  const close = h(
    'button',
    
    `cyc-icon-btn cyc-bar-close cyc-player-close flex-none ${BTN_ICON_BASE} ${BTN_HOVER_UTILS}`
  );
  close.title = 'stop';
  close.append(makeIcon('close'));
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onClose();
  });
  utils.append(close);

  wrapper.append(toggle, content, utils);

  // Playback progress overlay.
  const progressWrap = h(
    'div',
    'cyc-player-progress-wrapper absolute inset-0 rounded-[inherit] overflow-hidden pointer-events-none'
  );
  // Display-only progress line; width is set in JS.
  const progressLine = h(
    'div',
    'cyc-player-progress absolute inset-x-0 bottom-0 ' +
      'h-[0.25rem] bg-[var(--cyc-text-muted-tint)] overflow-hidden'
  );
  const filled = h('div', 'cyc-player-progress-filled h-full w-0 bg-[var(--cyc-accent)]');
  progressLine.append(filled);
  progressWrap.append(progressLine);

  el.append(wrapper, progressWrap);

  let shown = false;

  let lastClock = '';
  let lastPct = -1;

  function show(now: PlayerBarNow | null) {
    if (!now) {
      if (!shown) return;
      shown = false;
      el.classList.add('cyc-off');

      lastClock = '';
      lastPct = -1;
      filled.style.width = '0%';
      return;
    }
    shown = true;
    el.classList.remove('cyc-off');
    if (title.textContent !== now.chat) title.textContent = now.chat;
    if (said.textContent !== now.text) said.textContent = now.text;
    el.classList.toggle('cyc-player-loading', now.loading);
    toggle.title = now.playing ? 'pause' : 'play';
    toggle.replaceChildren(makeIcon(now.playing ? 'pause' : 'play'));
  }

  function progress(t: number, dur: number, ratio: number) {
    const clock = dur > 0 ? `${mmss(t)} / ${mmss(dur)}` : mmss(t);
    if (clock !== lastClock) {
      time.textContent = clock;
      lastClock = clock;
    }
    const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
    if (pct !== lastPct) {
      filled.style.width = `${pct}%`;
      lastPct = pct;
    }
  }

  return {el, show, progress, isShown: () => shown};
}
