import '@xterm/xterm/css/xterm.css';

import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {h, swapClasses} from '../components/domHelpers';
import {makeIconButton} from '../components/iconGlyphs';
import {
  currentPresentationTheme,
  registerThemePainter,
  type PresentationTheme
} from '../components/presentation';
import {
  resizeTerminal,
  scrollTerminal,
  sendTerminalInput,
  watchTerminal,
  TERMINAL_PANE_OVERRIDE
} from '../engine/store';
import {toast} from './widgets';
import {cyclog} from '@/shared/logging';

const FONT_SIZES = [15, 14, 13, 12, 11];
const MIN_COLS = 60;

const TERM_FONT =
  'SFMono-Regular, Menlo, Consolas, "Liberation Mono", ' +
  '"CYC Term Symbols", ' +
  '"Apple Symbols", "Segoe UI Symbol", "Noto Sans Symbols 2", monospace';

const BAR_KEYS_H = 44;

const KEY_OFF = ['bg-[rgba(255,255,255,0.12)]!', 'text-[#f2f2f2]'];
const KEY_ON_BG: Record<PresentationTheme, string> = {
  day: 'bg-[#96602f]!',
  night: 'bg-[#c98652]!'
};
const KEY_ON_BG_ALL = Object.values(KEY_ON_BG);

const BAR_FLOOR_PHONE = 24;
const BAR_FLOOR_DESK = 6;

function barFloor(): number {
  const cs = getComputedStyle(document.documentElement);
  const inset = parseFloat(cs.getPropertyValue('--cyc-safe-bottom')) || 0;
  const phone = matchMedia('(max-width: 550px)').matches;
  return Math.max(inset, phone ? BAR_FLOOR_PHONE : BAR_FLOOR_DESK);
}

export function unb64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

function keyB64(seq: string): string {
  let bin = '';
  for (let i = 0; i < seq.length; i++) bin += String.fromCharCode(seq.charCodeAt(i) & 0xff);
  return btoa(bin);
}

async function pasteFromClipboard(sessionId: string): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    toast('Clipboard unavailable');
    return;
  }
  if (text) sendTerminalInput(sessionId, {text});
}

let openViewer: (() => void) | null = null;

const themeMeta = () => document.querySelector('meta[name="theme-color"]');

function paintChromeBlack(): () => void {
  const meta = themeMeta();
  const was = meta?.getAttribute('content') ?? null;
  const root = document.documentElement;
  const body = document.body;
  const wasHtml = root.style.backgroundColor;
  const wasBody = body.style.backgroundColor;
  meta?.setAttribute('content', '#000000');
  root.style.backgroundColor = '#000';
  body.style.backgroundColor = '#000';
  return () => {
    root.style.backgroundColor = wasHtml;
    body.style.backgroundColor = wasBody;
    if (!meta) return;
    if (was === null) meta.removeAttribute('content');
    else meta.setAttribute('content', was);
  };
}

export function openTerminalViewer(sessionId: string, title: string) {
  openViewer?.();

  const overlay = h('div', 'cyc-term absolute top-0 left-0 z-[11] bg-black overflow-hidden');

  const slider = h('div', 'cyc-term-slider absolute top-0 left-0 right-0 will-change-transform');
  const screen = h('div', 'cyc-term-screen w-full [touch-action:none]');
  const bar = h(
    'div',
    'cyc-term-bar absolute left-0 right-0 bottom-0 z-[3] flex items-stretch gap-1.5 pt-1 ' +
      'bg-[#101010] [border-top:1px_solid_rgba(255,255,255,0.1)]'
  );

  const keys = h(
    'div',
    'cyc-term-keys flex-[1_1_auto] min-w-0 flex items-stretch gap-1.5 overflow-x-auto ' +
      'overflow-y-hidden [scrollbar-width:none] [-webkit-overflow-scrolling:touch] ' +
      '[padding-inline:max(1rem,env(safe-area-inset-left,0px))_max(1rem,env(safe-area-inset-right,0px))] ' +
      '[&::-webkit-scrollbar]:hidden'
  );
  const back = makeIconButton(
    'left',
    'cyc-term-back z-[3] absolute! top-[6px] left-[6px] w-9 h-9 text-white! ' +
      'bg-[rgba(0,0,0,0.55)]! [backdrop-filter:blur(6px)]'
  );
  back.title = 'Back';
  back.setAttribute('aria-label', 'Back');
  const status = h(
    'div',
    'cyc-term-status absolute left-1/2 top-1/2 [transform:translate(-50%,-50%)] z-[2] ' +
      'max-w-[80%] py-2 px-3.5 rounded-xl text-center text-[0.875rem] text-white ' +
      'bg-[rgba(0,0,0,0.7)] pointer-events-none'
  );

  status.textContent = TERMINAL_PANE_OVERRIDE
    ? `Scroll test: pane ${TERMINAL_PANE_OVERRIDE}, not ${title}`
    : `Opening ${title}…`;
  const unpaintChrome = paintChromeBlack();
  bar.append(keys);
  slider.append(screen, bar, back, status);
  overlay.append(slider);

  const term = new Terminal({
    fontSize: FONT_SIZES[0],
    fontFamily: TERM_FONT,

    theme: {background: '#000000', foreground: '#e6e6e6'},

    cursorBlink: false,
    disableStdin: false,
    scrollback: 0,
    convertEol: false
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const mount = document.getElementById('cyc-stage') ?? document.body;
  let boxH = 0;
  let boxW = 0;
  let barH = BAR_KEYS_H;

  const skirt = () => Math.round(boxH * 0.25);

  const applyBox = () => {
    boxH = mount.clientHeight;
    boxW = mount.clientWidth;
    barH = BAR_KEYS_H + barFloor();
    overlay.style.height = `${boxH + skirt()}px`;
    overlay.style.width = `${boxW}px`;

    slider.style.height = `${boxH}px`;
    bar.style.height = `${barH}px`;

    bar.style.paddingBottom = `${barFloor()}px`;

    screen.style.height = `${Math.max(0, boxH - barH)}px`;
  };

  const wantCols = () => {
    const w = boxW || mount.clientWidth;

    return Math.max(MIN_COLS, Math.min(110, Math.floor(w / 7.2)));
  };

  const measure = (): {cols: number; rows: number} => {
    const want = wantCols();
    for (const size of FONT_SIZES) {
      term.options.fontSize = size;
      term.options.lineHeight = 1.1;
      fit.fit();
      if (term.cols >= want || size === FONT_SIZES[FONT_SIZES.length - 1]) break;
    }
    return {cols: term.cols, rows: term.rows};
  };

  const estimateSize = (): {cols: number; rows: number} => {
    const w = boxW || mount.clientWidth;
    const h = Math.max(0, (boxH || mount.clientHeight) - barH);
    const cols = Math.max(MIN_COLS, Math.min(110, Math.floor(w / 7.2)));
    const rows = Math.max(1, Math.floor(h / (12 * 1.1)));
    return {cols, rows};
  };

  const afterLayout = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));

  let sent = {cols: 0, rows: 0};
  let stop: (() => void) | null = null;
  let closed = false;

  let ready = false;
  let lastFull: Uint8Array | null = null;
  const pending: Array<{full: boolean; bytes: Uint8Array}> = [];

  const applyFrame = (full: boolean, bytes: Uint8Array) => {
    if (full) {
      term.clear();
      lastFull = bytes;
    }
    status.style.display = 'none';
    term.write(bytes);
  };

  const flushPending = () => {
    ready = true;
    for (const f of pending.splice(0)) applyFrame(f.full, f.bytes);
  };

  const replayLastFull = () => {
    if (!lastFull) return;
    term.clear();
    term.write(lastFull);
  };

  const latch = {ctrl: false, alt: false};

  const ctrlByte = (c: string): string => {
    const up = c.toUpperCase().charCodeAt(0);
    if (up >= 0x40 && up <= 0x5f) return String.fromCharCode(up & 0x1f);
    if (c === '?') return '\x7f';
    return c;
  };

  const withMods = (seq: string): string => {
    const {ctrl, alt} = latch;
    if (!ctrl && !alt) return seq;
    const m = 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0);
    const arrow = /^\x1b\[([A-D])$/.exec(seq);
    if (arrow) return `\x1b[1;${m}${arrow[1]}`;
    const tilde = /^\x1b\[(\d+)~$/.exec(seq);
    if (tilde) return `\x1b[${tilde[1]};${m}~`;
    if (seq.length === 1) {
      let c = ctrl ? (seq === '\r' ? '\n' : ctrlByte(seq)) : seq;
      if (alt) c = `\x1b${c}`;
      return c;
    }
    return alt ? `\x1b${seq}` : seq;
  };

  // Toggle a modifier key's latched paint: swap the resting surface for the
  // themed primary (and back), keeping the `.on` marker the resting `:not(.on)`
  // active-press variant reads.
  const setKeyOn = (b: HTMLElement, on: boolean) => {
    b.classList.toggle('on', on);
    b.classList.remove(...KEY_OFF, ...KEY_ON_BG_ALL, 'text-white');
    if (on) b.classList.add(KEY_ON_BG[currentPresentationTheme()], 'text-white');
    else b.classList.add(...KEY_OFF);
  };

  const clearLatch = () => {
    if (!latch.ctrl && !latch.alt) return;
    latch.ctrl = false;
    latch.alt = false;
    for (const el of bar.querySelectorAll<HTMLButtonElement>('.cyc-term-key.on'))
      setKeyOn(el, false);
  };

  const sendKey = (seq: string) => {
    if (closed || !seq) return;
    const out = withMods(seq);
    clearLatch();
    sendTerminalInput(sessionId, {b64: keyB64(out)});
  };

  term.onData((data) => {
    if (closed || !data) return;
    if ((latch.ctrl || latch.alt) && data.length === 1) {
      sendKey(data);
      return;
    }
    sendTerminalInput(sessionId, {text: data});
  });

  screen.addEventListener(
    'paste',
    (e) => {
      if (closed) return;
      const text = e.clipboardData?.getData('text');
      e.preventDefault();
      e.stopPropagation();
      if (text) sendTerminalInput(sessionId, {text});
    },
    {capture: true}
  );

  type BarKey = {
    label: string;
    title: string;
    seq?: string;
    mod?: 'ctrl' | 'alt';
    action?: () => void;
    wide?: boolean;
  };

  const KEYS: BarKey[] = [
    {label: '←', title: 'Left', seq: '\x1b[D'},
    {label: '↓', title: 'Down', seq: '\x1b[B'},
    {label: '↑', title: 'Up', seq: '\x1b[A'},
    {label: '→', title: 'Right', seq: '\x1b[C'},
    {label: 'Enter', title: 'Enter', seq: '\r', wide: true},
    {label: 'Esc', title: 'Escape', seq: '\x1b', wide: true},
    {label: 'Ctrl', title: 'Ctrl (applies to the next key)', mod: 'ctrl', wide: true},
    {label: 'Alt', title: 'Alt / Option (applies to the next key)', mod: 'alt', wide: true},
    {label: '^C', title: 'Ctrl-C: interrupt', seq: '\x03'},
    {label: '^T', title: 'Ctrl-T', seq: '\x14'},
    {label: '⌫', title: 'Backspace', seq: '\x7f'},
    {label: 'Del', title: 'Delete', seq: '\x1b[3~'},

    {
      label: 'Paste',
      title: 'Paste from clipboard',
      wide: true,
      action: () => {
        if (!closed) void pasteFromClipboard(sessionId);
      }
    }
  ];

  const addKey = (k: BarKey, into: HTMLElement) => {
    const b = h(
      'button',
      'cyc-term-key flex-[0_0_auto] h-9 flex items-center justify-center rounded-lg ' +
        'font-medium leading-none select-none px-2! text-[0.875rem]! [font-family:inherit]! ' +
        'bg-[rgba(255,255,255,0.12)]! text-[#f2f2f2] ' +
        '[transition:background-color_0.08s_ease,transform_0.08s_ease] ' +
        '[&:active:not(.on)]:bg-[rgba(255,255,255,0.28)]! active:[transform:scale(0.94)] ' +
        (k.wide ? 'min-w-[2.875rem]' : 'min-w-9')
    );
    b.textContent = k.label;
    b.title = k.title;
    b.setAttribute('aria-label', k.title);

    let downX = 0;
    let downY = 0;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      downX = e.clientX;
      downY = e.clientY;
    });
    b.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 10) return;
      e.preventDefault();
      if (k.mod) {
        const on = !latch[k.mod];

        latch[k.mod] = on;
        setKeyOn(b, on);
        return;
      }
      if (k.action) {
        k.action();
        return;
      }
      if (k.seq) sendKey(k.seq);
    });
    into.append(b);
  };

  for (const k of KEYS) addKey(k, keys);

  // The latched-key tint is a per-theme literal, so repaint any on-key on live
  // day/night flips while the bar stays connected (pruned on overlay teardown).
  registerThemePainter(bar, () => {
    const bg = KEY_ON_BG[currentPresentationTheme()];
    for (const el of bar.querySelectorAll<HTMLButtonElement>('.cyc-term-key.on')) {
      swapClasses(el, KEY_ON_BG_ALL, [bg]);
    }
  });

  const rowPx = () => {
    const r = term.rows || 1;
    return Math.max(4, (boxH - barH) / r);
  };

  const MAX_PER_CMD = 200;

  let scrollRowsSent = 0;
  let scrollCmds = 0;

  let scrollMode: 'scroll' | 'wheel' | 'none' | 'unknown' = 'unknown';

  const sendScroll = (rows: number) => {
    if (closed || !rows) return;
    const n = Math.min(MAX_PER_CMD, Math.abs(rows));
    scrollRowsSent += rows < 0 ? -n : n;
    scrollCmds++;
    scrollTerminal(sessionId, rows < 0 ? 'up' : 'down', n);
  };

  overlay.addEventListener(
    'wheel',
    (e) => {
      if (closed || !e.deltaY) return;
      if ((e.target as HTMLElement)?.closest?.('.cyc-term-bar')) return;
      e.preventDefault();

      const perRow = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 1 / (term.rows || 1) : rowPx();
      const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / perRow));
      sendScroll(e.deltaY < 0 ? -lines : lines);
    },
    {passive: false, capture: true}
  );

  let touchY: number | null = null;
  let touchAcc = 0;

  overlay.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) {
        touchY = null;
        return;
      }

      if ((e.target as HTMLElement)?.closest?.('.cyc-term-bar')) {
        touchY = null;
        return;
      }
      touchY = e.touches[0].clientY;
      touchAcc = 0;
    },
    {passive: true, capture: true}
  );
  overlay.addEventListener(
    'touchmove',
    (e) => {
      if (closed || touchY === null || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      touchAcc += touchY - y;
      touchY = y;
      e.preventDefault();
      const row = rowPx();
      const n = Math.trunc(touchAcc / row);
      if (!n) return;
      touchAcc -= n * row;
      sendScroll(n);
    },
    {passive: false, capture: true}
  );

  const endTouch = () => {
    touchY = null;
    touchAcc = 0;
  };
  overlay.addEventListener('touchend', endTouch, {passive: true, capture: true});
  overlay.addEventListener('touchcancel', endTouch, {passive: true, capture: true});

  const close = () => {
    if (openViewer !== close) return;
    openViewer = null;
    closed = true;
    window.removeEventListener('keydown', onKeyDown, {capture: true});
    window.removeEventListener('resize', onGeometry);
    window.visualViewport?.removeEventListener('resize', onViewport);
    window.visualViewport?.removeEventListener('scroll', onViewport);
    unpaintChrome();

    stop?.();
    stop = null;
    term.dispose();
    overlay.remove();
  };
  openViewer = close;

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (term.element?.contains(document.activeElement)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }
  window.addEventListener('keydown', onKeyDown, {capture: true});
  back.addEventListener('click', close);

  const onViewport = () => {
    const vv = window.visualViewport;
    if (!vv || closed) return;
    const boxBottom = mount.getBoundingClientRect().top + boxH;
    const shift = Math.max(0, Math.round(boxBottom - (vv.offsetTop + vv.height)));
    slider.style.transform = shift > 0 ? `translateY(${-shift}px)` : '';

    const up = shift > 0;
    bar.style.paddingBottom = up ? '0px' : `${barFloor()}px`;
    bar.style.height = `${up ? BAR_KEYS_H : barH}px`;
  };

  const isTouch = matchMedia('(pointer: coarse)').matches;
  const onGeometry = () => {
    if (closed) return;
    const widthMoved = mount.clientWidth !== boxW;
    if (isTouch && !widthMoved) return;
    if (!widthMoved && mount.clientHeight === boxH) return;
    slider.style.transform = '';
    applyBox();
    const {cols, rows} = measure();
    if (cols === sent.cols && rows === sent.rows) return;
    sent = {cols, rows};
    resizeTerminal(sessionId, cols, rows);

    replayLastFull();
  };
  window.addEventListener('resize', onGeometry);
  window.visualViewport?.addEventListener('resize', onViewport);
  window.visualViewport?.addEventListener('scroll', onViewport);

  mount.append(overlay);

  const start = (cols: number, rows: number) => {
    stop = watchTerminal(sessionId, cols, rows, {
      onFrame(f) {
        if (closed) return;
        const bytes = unb64(f.bytes);

        if (!ready) {
          pending.push({full: f.full, bytes});
          if (f.full) lastFull = bytes;
          return;
        }
        applyFrame(f.full, bytes);
      },

      onMode(mode) {
        if (closed) return;
        scrollMode = mode;
        cyclog('term.mode', {mode});
        if (mode === 'none') {
          status.style.display = '';
          status.textContent = 'Nothing to scroll here yet';
        } else if (status.textContent === 'Nothing to scroll here yet') {
          status.style.display = 'none';
        }
      },
      onClosed(why) {
        if (closed) return;

        status.style.display = '';
        status.textContent = `Terminal closed: ${why}`;
      }
    });
  };

  applyBox();

  document.fonts?.load('15px "CYC Term Symbols"', '⏺').catch(() => {});
  term.open(screen);

  term.element?.classList.add('h-full', 'p-0', '[font-variant-emoji:text]');

  const estimate = estimateSize();
  sent = estimate;
  start(estimate.cols, estimate.rows);

  afterLayout(() => {
    if (closed) return;
    const first = measure();

    (window as any).__cycTerm = {
      sent: first,
      cols: term.cols,
      rows: term.rows,
      fontSize: term.options.fontSize,
      box: {w: boxW, h: boxH},

      key: (seq: string) => sendKey(seq),
      type: (text: string) => sendTerminalInput(sessionId, {text}),
      paste: () => pasteFromClipboard(sessionId),
      latch,
      scroll: (dir: 'up' | 'down', lines: number) => scrollTerminal(sessionId, dir, lines),

      write: (s: string) => term.write(s),
      focus: () => term.focus(),

      now: () => ({
        cols: term.cols,
        rows: term.rows,
        sent: {...sent},
        transform: slider.style.transform,
        barH,

        srows: scrollRowsSent,
        scmds: scrollCmds,
        mode: scrollMode,
        rowPx: Math.round(rowPx() * 10) / 10
      })
    };

    if (first.cols !== sent.cols || first.rows !== sent.rows) {
      sent = first;
      resizeTerminal(sessionId, first.cols, first.rows);
    }

    flushPending();

    if (!isTouch) term.focus();
  });
}
