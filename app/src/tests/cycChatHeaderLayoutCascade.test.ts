import {afterAll, afterEach, beforeAll, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser, type Page} from 'playwright';

// Real-Chromium chat-header layout coverage across width buckets.

import {createHeader} from '../features/sessions/header/header';
import {captioned, createHeaderActions} from '../features/sessions/header/actions';
import {
  headerHeightValue,
  headerResizePainterCount
} from '../features/sessions/header/headerHeight';
import {
  installPresentationReactivity,
  presentationPainterCount,
  setPresentationTheme
} from '../components/presentation';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const CHAT = resolve(SHELL, '..', 'features', 'chat', 'chat.css');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

type Width = 'phone' | 'tablet' | 'laptop';
const VIEWPORT: Record<Width, {width: number; height: number}> = {
  phone: {width: 400, height: 800},
  tablet: {width: 800, height: 800},
  laptop: {width: 1000, height: 800}
};
const HDR_CLASS: Record<Width, string> = {
  phone: 'cyc-hdr-phone',
  tablet: 'cyc-hdr-tablet',
  laptop: 'cyc-hdr-laptop'
};

const setWidth = (px: number) =>
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: px});
const tokenize = (className: string) => className.trim().split(/\s+/).filter(Boolean);

async function compileTailwind(candidates: string[]): Promise<string> {
  const entry = readFileSync(resolve(SHELL, 'tailwind.css'), 'utf8');
  const compiler = await compile(entry, {
    base: SHELL,
    async loadStylesheet(id: string, base: string) {
      const path =
        id === 'tailwindcss'
          ? resolve(TW_DIR, 'index.css')
          : resolve(base, id.replace(/^tailwindcss\//, `${TW_DIR}/`));
      return {base: dirname(path), content: readFileSync(path, 'utf8'), path};
    },
    async loadModule(id: string) {
      return {path: id, base: SHELL, module: {} as never};
    }
  });
  return compiler.build(candidates);
}

// Stable values for layout variables.
const SENTINEL = `<style>:root{--cyc-surface:rgb(1,2,3);--cyc-chat-width:600px;--cyc-safe-top:0px}</style>`;

(globalThis as {ResizeObserver?: unknown}).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

const SESSION = {
  id: 's1',
  name: 'Peer',
  cwd: '/',
  unread: 0,
  muted: false,
  thinking: false,
  messages: []
} as never;

// Build a header and collect its classes for Tailwind compilation.
function chatHeaderDom(width: Width): {html: string; classes: string[]} {
  setWidth(VIEWPORT[width].width);
  const teardown = installPresentationReactivity();
  const el = createHeader({
    session: SESSION,
    onBack: () => {},
    onToggleConversation: () => {},
    onToggleMute: () => {},
    onOpenProfile: () => {}
  }).el;
  const classes = new Set<string>();
  for (const node of [el, ...Array.from(el.querySelectorAll('*'))]) {
    const cls = node.getAttribute('class');
    if (cls) for (const t of tokenize(cls)) classes.add(t);
  }
  teardown();
  return {html: el.outerHTML, classes: Array.from(classes)};
}

async function buildFullPage(width: Width): Promise<Page> {
  const {html, classes} = chatHeaderDom(width);
  const utilities = await compileTailwind(classes);
  const shell =
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(CHAT, 'utf8');
  const doc =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n` +
    `/* un-layered shell + chat */\n${shell}</style>${SENTINEL}</head><body>` +
    `<div id="cyc-thread-pane"><div class="cyc-thread active" style="--cyc-chat-header-height:88px">` +
    `${html}</div></div></body></html>`;
  const page = await (await getBrowser()).newPage();
  await page.setViewportSize(VIEWPORT[width]);
  await page.setContent(doc, {waitUntil: 'load'});
  return page;
}

// Exercise responsive toolbar fragments under each width class.
function fragmentClasses(): string[] {
  const brk = createHeaderActions({
    el: document.createElement('div'),
    utils: document.createElement('div'),
    sessionId: () => 's'
  }).headerBreak;
  const slot = captioned(document.createElement('button'), 'Context', 'CTX');
  const classes = new Set<string>();
  for (const node of [brk, slot, ...Array.from(slot.querySelectorAll('*'))]) {
    const cls = node.getAttribute('class');
    if (cls) for (const t of tokenize(cls)) classes.add(t);
  }
  return Array.from(classes);
}

async function buildFragmentPage(): Promise<Page> {
  const brk = createHeaderActions({
    el: document.createElement('div'),
    utils: document.createElement('div'),
    sessionId: () => 's'
  }).headerBreak;
  const brkHtml = brk.outerHTML;
  const slotHtml = captioned(document.createElement('button'), 'Context', 'CTX').outerHTML;
  const utilities = await compileTailwind(fragmentClasses());
  const shell =
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(CHAT, 'utf8');
  const wrap = (w: Width) => `<div id="${w}" class="${HDR_CLASS[w]}">${brkHtml}${slotHtml}</div>`;
  const doc =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n` +
    `/* un-layered shell + chat */\n${shell}</style>${SENTINEL}</head><body>` +
    `${wrap('phone')}${wrap('tablet')}${wrap('laptop')}</body></html>`;
  const page = await (await getBrowser()).newPage();
  await page.setViewportSize({width: 800, height: 800});
  await page.setContent(doc, {waitUntil: 'load'});
  return page;
}

const readLayout = (page: Page) =>
  page.evaluate(() => {
    const cs = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const c = getComputedStyle(el);
      return {
        display: c.display,
        zIndex: c.zIndex,
        padLeft: c.paddingLeft,
        padTop: c.paddingTop,
        radius: c.borderTopLeftRadius,
        rowGap: c.rowGap,
        padBottom: c.paddingBottom,
        flexGrow: c.flexGrow,
        flexShrink: c.flexShrink,
        flexBasis: c.flexBasis,
        minWidth: c.minWidth,
        maxWidth: c.maxWidth,
        top: c.top,
        height: c.height,
        fontSize: c.fontSize,
        letterSpacing: c.letterSpacing,
        position: c.position
      };
    };
    const H = '#cyc-thread-pane .cyc-mast';
    return {
      header: cs(H),
      infoBox: cs(`${H} .cyc-mast-info-box`),
      info: cs(`${H} .cyc-mast-info`),
      back: cs(`${H} .cyc-pane-back`),
      slot: cs(`${H} .cyc-mast-slot`),
      speed: cs(`${H} .cyc-speed-btn`)
    };
  });

afterAll(async () => {
  await browser?.close();
});

describe('chat-header layout cascade: final @media forks resolve per width class', () => {
  test('phone (<=550): the cyc-hdr-phone variants win the wrapped title-row layout', async () => {
    const page = await buildFullPage('phone');
    try {
      const s = await readLayout(page);
      // Header box: width painter inline pad 0.75rem (11.25px), phone z variant, radius 0.
      expect(s.header!.padLeft).toBe('12px');
      expect(s.header!.zIndex).toBe('3');
      expect(s.header!.radius).toBe('0px'); // chat.css phone border-radius:0 !important
      // Info-box: phone row-gap 0.1875rem + block padding 0.375rem.
      expect(s.infoBox!.rowGap).toBe('3px');
      expect(s.infoBox!.padTop).toBe('6px');
      // Info flex item: grow 3 / shrink 1 / min-width 0 (the shrinking wrapped leg).
      expect(s.info!.flexGrow).toBe('3');
      expect(s.info!.flexShrink).toBe('1');
      expect(s.info!.minWidth).toBe('0px');
      // Slot: phone padding-bottom 0.25rem + grow 1 / basis 2.75rem.
      expect(s.slot!.padBottom).toBe('4px');
      expect(s.slot!.flexGrow).toBe('1');
      expect(s.slot!.flexBasis).toBe('44px');
      // Back button: lowered top 0.375rem, grown height 2.875rem, still visible + absolute.
      expect(s.back!.display).not.toBe('none');
      expect(s.back!.position).toBe('absolute');
      expect(s.back!.top).toBe('6px');
      expect(s.back!.height).toBe('46px');
      // Speed button: capped to max-width 2.5rem on phone.
      expect(s.speed!.maxWidth).toBe('40px');
    } finally {
      await page.close();
    }
  });

  test('tablet (551..899): the 551+ base wins; the back button stays visible', async () => {
    const page = await buildFullPage('tablet');
    try {
      const s = await readLayout(page);
      expect(s.header!.padLeft).toBe('4px'); // width painter 0.25rem base
      expect(s.header!.zIndex).toBe('2'); // no phone z variant
      expect(s.header!.radius).toBe('6px'); // inlined 6px header radius
      expect(s.infoBox!.rowGap).toBe('4px'); // gap-y-1 = 0.25rem
      expect(s.infoBox!.padTop).toBe('0px'); // no phone block padding
      expect(s.info!.flexGrow).toBe('100'); // flex-[100_0_8rem]
      expect(s.info!.flexShrink).toBe('0');
      expect(s.info!.flexBasis).toBe('128px'); // 8rem
      expect(s.info!.minWidth).toBe('128px'); // min-w-[8rem]
      expect(s.slot!.flexGrow).toBe('0'); // flex-[0_1_3rem]
      expect(s.slot!.flexBasis).toBe('48px'); // 3rem
      expect(s.slot!.padBottom).toBe('8px'); // pb-2 = 0.5rem
      expect(s.back!.display).not.toBe('none');
      expect(s.back!.top).toBe('12px'); // 0.75rem
      expect(s.back!.height).toBe('40px'); // h-10 = 2.5rem
      expect(s.speed!.maxWidth).not.toBe('37.5px');
    } finally {
      await page.close();
    }
  });

  test('laptop (>=900): the back button is removed; box radius is the primitive', async () => {
    const page = await buildFullPage('laptop');
    try {
      const s = await readLayout(page);
      expect(s.header!.padLeft).toBe('4px');
      expect(s.header!.zIndex).toBe('2');
      expect(s.header!.radius).toBe('6px');
      expect(s.back!.display).toBe('none');
      // The 551+ base layout still governs info/slot at laptop.
      expect(s.info!.flexGrow).toBe('100');
      expect(s.slot!.flexBasis).toBe('48px');
    } finally {
      await page.close();
    }
  });
});

describe('chat-header layout cascade: break + caption swap fragments', () => {
  const frag = (page: Page) =>
    page.evaluate(() => {
      const disp = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).display : null;
      };
      const brkCss = (w: string) => {
        const el = document.querySelector(`#${w} .cyc-mast-break`)!;
        const c = getComputedStyle(el);
        return {
          display: c.display,
          flexBasis: c.flexBasis,
          height: c.height,
          marginTop: c.marginTop
        };
      };
      const cap = (w: string) => {
        const el = document.querySelector(`#${w} .cyc-mast-caption`)!;
        const c = getComputedStyle(el);
        return {fontSize: c.fontSize, letterSpacing: c.letterSpacing};
      };
      return {
        phoneBrk: brkCss('phone'),
        tabletBrk: brkCss('tablet'),
        laptopBrk: brkCss('laptop'),
        phoneLong: disp('#phone .cyc-mast-caption-long'),
        phoneShort: disp('#phone .cyc-mast-caption-short'),
        tabletLong: disp('#tablet .cyc-mast-caption-long'),
        tabletShort: disp('#tablet .cyc-mast-caption-short'),
        phoneCap: cap('phone'),
        tabletCap: cap('tablet')
      };
    });

  test('the wrap break is block-full-basis on phone and hidden off phone', async () => {
    const page = await buildFragmentPage();
    try {
      const f = await frag(page);
      expect(f.phoneBrk.display).toBe('block');
      expect(f.phoneBrk.flexBasis).toBe('100%');
      expect(f.phoneBrk.height).toBe('0px');
      expect(f.phoneBrk.marginTop).toBe('0px');
      expect(f.tabletBrk.display).toBe('none');
      expect(f.laptopBrk.display).toBe('none');
    } finally {
      await page.close();
    }
  });

  test('the caption long/short swap flips on phone; the caption shrinks + drops tracking', async () => {
    const page = await buildFragmentPage();
    try {
      const f = await frag(page);
      // Phone: short spelling shows, long hides. Off phone: the reverse.
      expect(f.phoneLong).toBe('none');
      expect(f.phoneShort).toBe('inline');
      expect(f.tabletLong).toBe('inline');
      expect(f.tabletShort).toBe('none');
      // Phone shrinks the caption to 0.5rem (7.5px) and zeroes letter-spacing.
      expect(f.phoneCap.fontSize).toBe('8px');
      expect(f.phoneCap.letterSpacing).toBe('normal');
      expect(f.tabletCap.fontSize).toBe('9px'); // 0.5625rem
      expect(f.tabletCap.letterSpacing).not.toBe('normal');
    } finally {
      await page.close();
    }
  });
});

// Real-Chromium coverage for header and voice state variants.
describe('chat-header self-state drains resolve per state class in a real browser', () => {
  test('voice ink transitions + stays theme-live; header opacities, contents, relative resolve', async () => {
    const page = await buildFullPage('tablet');
    try {
      const r = await page.evaluate(async () => {
        const strip = document.querySelector('.cyc-voice-strip') as HTMLElement;
        const utils = document.querySelector('.cyc-mast-utils') as HTMLElement;
        const header = document.querySelector('#cyc-thread-pane .cyc-mast') as HTMLElement;
        const dummy = document.querySelector('.cyc-mast-dummy') as HTMLElement;
        const slot = document.querySelector('.cyc-mast-slot') as HTMLElement;
        const btn = document.querySelector('.cyc-mast-slot .cyc-icon-btn') as HTMLElement;
        const setTheme = (primary: string, secondary: string) => {
          document.documentElement.style.setProperty('--cyc-accent', primary);
          document.documentElement.style.setProperty('--cyc-text-muted', secondary);
        };
        const setVs = (kind: string) => {
          for (const k of ['listening', 'you-cut-in', 'transcribing', 'speaking'])
            strip.classList.toggle('cyc-vs-' + k, k === kind);
        };
        const ink = () => getComputedStyle(strip).color;
        // Day theme: the two hex arms are theme-fixed, speaking/transcribing read the vars.
        setTheme('rgb(10, 20, 30)', 'rgb(40, 50, 60)');
        setVs('listening');
        const listeningDay = ink();
        setVs('you-cut-in');
        const cutinDay = ink();
        setVs('transcribing');
        const transcribingDay = ink();
        setVs('speaking');
        const speakingDay = ink();
        // Night theme: only the var-driven arms move.
        setTheme('rgb(200, 210, 220)', 'rgb(230, 240, 250)');
        const speakingNight = ink();
        setVs('you-cut-in');
        const cutinNight = ink();
        const dummyOpacity = getComputedStyle(dummy).opacity;
        slot.classList.add('cyc-call-disabled');
        const callDisabledOpacity = getComputedStyle(slot).opacity;
        btn.classList.add('cyc-mast-unavailable');
        await new Promise((resolve) => setTimeout(resolve, 250));
        const unavailableOpacity = getComputedStyle(btn).opacity;
        return {
          listeningDay,
          cutinDay,
          transcribingDay,
          speakingDay,
          speakingNight,
          cutinNight,
          dummyOpacity,
          callDisabledOpacity,
          unavailableOpacity,
          utilsDisplay: getComputedStyle(utils).display,
          headerPosition: getComputedStyle(header).position
        };
      });
      // Finite hex arms: theme-independent, defeating the un-layered base color via `!`.
      expect(r.listeningDay).toBe('rgb(78, 201, 123)'); // #4ec97b
      expect(r.cutinDay).toBe('rgb(224, 160, 60)'); // #e0a03c
      expect(r.cutinNight).toBe('rgb(224, 160, 60)'); // unchanged across the theme swap
      // Var-driven arms track the live theme vars.
      expect(r.speakingDay).toBe('rgb(10, 20, 30)'); // day --cyc-accent
      expect(r.speakingNight).toBe('rgb(200, 210, 220)'); // night --cyc-accent
      expect(r.transcribingDay).toBe('rgb(40, 50, 60)'); // day --cyc-text-muted
      // Container-scoped opacity self-states.
      expect(r.dummyOpacity).toBe('0.45');
      expect(r.callDisabledOpacity).toBe('0.45');
      expect(r.unavailableOpacity).toBe('0.4');
      // display:contents + position:relative drains.
      expect(r.utilsDisplay).toBe('contents');
      expect(r.headerPosition).toBe('relative');
    } finally {
      await page.close();
    }
  });
});

const ORIGINAL_WIDTH = window.innerWidth;
let teardown: (() => void) | undefined;
const sync = () => {
  teardown?.();
  teardown = installPresentationReactivity();
};

afterEach(() => {
  teardown?.();
  teardown = undefined;
  document.body.innerHTML = '';
  setWidth(ORIGINAL_WIDTH);
  window.dispatchEvent(new Event('resize'));
  setPresentationTheme('day');
});

function mountHeader() {
  const chat = document.createElement('div');
  chat.className = 'cyc-thread';
  const header = createHeader({
    session: SESSION,
    onBack: () => {},
    onToggleConversation: () => {},
    onToggleMute: () => {},
    onOpenProfile: () => {}
  });
  chat.append(header.el);
  document.body.append(chat);
  Object.defineProperty(header.el, 'offsetWidth', {configurable: true, value: 500});
  const utils = header.el.querySelector<HTMLElement>('.cyc-mast-utils')!;
  return {chat, header, utils};
}

const widthClass = (el: HTMLElement) =>
  ['cyc-hdr-phone', 'cyc-hdr-tablet', 'cyc-hdr-laptop'].filter((c) => el.classList.contains(c));

describe('header width painter: exactly one finite width class, re-toggled on resize', () => {
  test('the class tracks the presentation bucket across live 400/550/551/899/900 crossings', () => {
    setWidth(800);
    sync();
    const {header} = mountHeader();
    expect(widthClass(header.el)).toEqual(['cyc-hdr-tablet']);

    for (const [px, cls] of [
      [400, 'cyc-hdr-phone'],
      [550, 'cyc-hdr-phone'],
      [551, 'cyc-hdr-tablet'],
      [899, 'cyc-hdr-tablet'],
      [900, 'cyc-hdr-laptop']
    ] as const) {
      setWidth(px);
      sync();
      expect(widthClass(header.el)).toEqual([cls]);
    }
  });

  test('the width painter writes the inline padding-inline per bucket', () => {
    setWidth(800);
    sync();
    const {header} = mountHeader();
    expect(header.el.style.paddingInline).toBe('0.25rem');
    setWidth(400);
    sync();
    expect(header.el.style.paddingInline).toBe('0.75rem');
    setWidth(1000);
    sync();
    expect(header.el.style.paddingInline).toBe('0.25rem');
  });
});

describe('header width painter couples to the TS header-height re-measurement', () => {
  // Stub slot geometry that only wraps (three top clusters -> extra=2) while the header
  // carries cyc-hdr-phone. Crossing the 550 boundary must re-measure *after* toggling the
  // class -- so the height reflects the new bucket's extra=2, not a stale extra=0 from
  // before the wrap. The header element width is held constant so the toolbar's
  // ResizeObserver is not what drives this: only the painter's `actions.remeasure()` does.
  const wireSlots = (header: {el: HTMLElement}, utils: HTMLElement) => {
    utils.replaceChildren();
    const tops = [0, 0, 20, 20, 40];
    for (const base of tops) {
      const s = document.createElement('div');
      s.className = 'cyc-mast-slot';
      Object.defineProperty(s, 'offsetWidth', {configurable: true, value: 40});
      s.getBoundingClientRect = () => {
        const top = header.el.classList.contains('cyc-hdr-phone') ? base : 0;
        return {
          top,
          bottom: top + 18,
          left: 0,
          right: 40,
          width: 40,
          height: 18,
          x: 0,
          y: top
        } as DOMRect;
      };
      utils.append(s);
    }
  };

  test('crossing 551<->550 re-selects --cyc-chat-header-height for the freshly measured wrap', () => {
    setWidth(800);
    sync();
    const {chat, header, utils} = mountHeader();
    wireSlots(header, utils);

    setWidth(550);
    sync();
    expect(chat.style.getPropertyValue('--cyc-chat-header-height')).toBe(
      headerHeightValue('phone', 2)
    );

    // Cross back to 551 (tablet/wide): the wrap collapses and the re-measure yields extra=0.
    setWidth(551);
    sync();
    expect(chat.style.getPropertyValue('--cyc-chat-header-height')).toBe(
      headerHeightValue('wide', 0)
    );
  });
});

describe('header painters prune when the header detaches; teardown stops repaints', () => {
  test('createHeader registers snapshot painters + one raw height hook, all pruned on detach', () => {
    setWidth(800);
    sync();
    const before = presentationPainterCount();
    const beforeRaw = headerResizePainterCount();
    const {chat} = mountHeader();
    // paintInfoPad + paintHeaderWidth + paintHeaderHeight all register snapshot painters.
    expect(presentationPainterCount() - before).toBeGreaterThanOrEqual(3);
    expect(headerResizePainterCount()).toBe(beforeRaw + 1);

    chat.remove();
    setPresentationTheme('night'); // repaints snapshot painters -> prunes the detached ones
    window.dispatchEvent(new Event('resize')); // prunes the detached raw height hook
    expect(presentationPainterCount()).toBe(before);
    expect(headerResizePainterCount()).toBe(beforeRaw);
  });

  test('after teardown a resize no longer re-toggles the width class', async () => {
    setWidth(800);
    sync();
    const {header} = mountHeader();
    expect(widthClass(header.el)).toEqual(['cyc-hdr-tablet']);
    teardown?.();
    teardown = undefined;
    setWidth(400);
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    expect(widthClass(header.el)).toEqual(['cyc-hdr-tablet']);
  });
});
