import {afterAll, afterEach, beforeEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

import {openMenu, type CycMenuItem} from '../components/popupMenu';
import {
  installPresentationReactivity,
  setPresentationTheme,
  themePainterCount
} from '../components/presentation';

// Popup menu behavior and cascade coverage.

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

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

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

const ITEMS: CycMenuItem[] = [{icon: 'image', text: 'Photo or Video', onClick: () => {}}];
const cls = (el: Element | null | undefined) => el?.className ?? '';
const evt = () => new MouseEvent('click', {clientX: 40, clientY: 40, bubbles: true});

const ORIGINAL_WIDTH = window.innerWidth;
const setWidth = (px: number) =>
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: px});

let teardown: (() => void) | undefined;

beforeEach(() => {
  document.body.innerHTML = '';
  setWidth(1024);
  setPresentationTheme('day');
  teardown?.();
  teardown = installPresentationReactivity();
});

afterEach(() => {
  teardown?.();
  teardown = undefined;
  setWidth(ORIGINAL_WIDTH);
  document.body.innerHTML = '';
  setPresentationTheme('day');
});

describe('menu chrome: literal class contract on the live producer', () => {
  test('container carries MENU_BASE chrome and open-phase gates', () => {
    const {element, close} = openMenu(ITEMS, evt());
    const c = cls(element);
    expect(c).toContain('cyc-menu');
    expect(c).toContain('cyc-menu-context');
    expect(c).toContain('fixed');
    expect(c).toContain('z-20');
    expect(c).toContain('cyc-elevation-low');
    expect(c).toContain('w-max');
    expect(c).toContain('p-2');
    expect(c).toContain('backdrop-blur-md');
    expect(c).toContain('invisible');
    expect(c).toContain('opacity-0');
    expect(c).toContain('translate-y-1');
    expect(c).toContain('[&[data-cyc-phase=open]]:visible');
    expect(c).toContain('[&[data-cyc-phase=open]]:opacity-100');
    expect(c).toContain('[&[data-cyc-phase=open]]:translate-y-0');
    expect(element.getAttribute('data-cyc-phase')).toBe('open');
    close();
  });

  test('item / icon / text carry the final base geometry', () => {
    const {element, close} = openMenu(ITEMS, evt());
    const item = element.querySelector<HTMLElement>('.cyc-menu-item')!;
    const ic = element.querySelector<HTMLElement>('.cyc-menu-item-icon')!;
    const text = element.querySelector<HTMLElement>('.cyc-menu-item-text')!;

    const ci = cls(item);
    expect(ci).toContain('relative');
    expect(ci).toContain('grid');
    expect(ci).toContain('cursor-pointer');
    expect(ci).toContain('text-[var(--cyc-text)]');
    expect(ci).toContain('text-sm');
    expect(ci).toContain('font-semibold');
    expect(ci).toContain('transition-colors');
    expect(ci).toContain('active:opacity-75');

    const cic = cls(ic);
    expect(cic).toContain('flex');
    expect(cic).toContain('size-6');
    expect(cic).toContain('text-current');
    expect(cic).toContain('text-xl');
    expect(cic).toContain('p-0');

    const ct = cls(text);
    expect(ct).toContain('min-w-0');
    expect(ct).toContain('whitespace-nowrap');
    expect(ct).toContain('text-ellipsis');
    expect(ct).toContain('overflow-hidden');
    expect(ct).toContain('pointer-events-none');
    close();
  });
});

describe('menu chrome: live day/night surface paint + painter lifecycle', () => {
  test('opens with the day surface, repaints to night in place, and unregisters on close', () => {
    const before = themePainterCount();
    const {element, close} = openMenu(ITEMS, evt());
    expect(themePainterCount()).toBe(before + 1);
    expect(element.style.backgroundColor).toBe('rgba(255, 255, 255, 0.9)');

    setPresentationTheme('night');
    expect(element.style.backgroundColor).toBe('rgba(23, 23, 26, 0.82)');

    close();
    expect(themePainterCount()).toBe(before);
  });

  test('a menu opened under night paints the dark surface from the start', () => {
    setPresentationTheme('night');
    const {element, close} = openMenu(ITEMS, evt());
    expect(element.style.backgroundColor).toBe('rgba(23, 23, 26, 0.82)');
    close();
  });
});

describe('menu chrome: real Chromium effective cascade', () => {
  test('final utilities resolve to the exact menu chrome and open/close states', async () => {
    // Capture the real producer output (day + night) for the compile candidates.
    setPresentationTheme('day');
    const day = openMenu(ITEMS, evt());
    const containerCls = day.element.className;
    const itemCls = day.element.querySelector<HTMLElement>('.cyc-menu-item')!.className;
    const iconCls = day.element.querySelector<HTMLElement>('.cyc-menu-item-icon')!.className;
    const textCls = day.element.querySelector<HTMLElement>('.cyc-menu-item-text')!.className;
    day.close();

    const dayBg = day.element.style.backgroundColor;

    setPresentationTheme('night');
    const night = openMenu(ITEMS, evt());
    const nightBg = night.element.style.backgroundColor;
    night.close();
    setPresentationTheme('day');

    // The surface is an inline `background-color`, not a compiled class, so the bg
    // is not a compile candidate; it is injected inline on the probes below.
    const candidates = `${containerCls} ${itemCls} ${iconCls} ${textCls}`
      .split(/\s+/)
      .filter(Boolean);
    const utilities = await compileTailwind(candidates);
    const shell =
      readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
      '\n' +
      readFileSync(resolve(SHELL, 'utilities.css'), 'utf8');

    // The container in its closed/hidden base, plus a copy stamped with the
    // open data-state (`data-cyc-phase="open"`). Inline left/top mimic
    // placeMenu so `fixed` is observable. The lifecycle marker is an attribute now,
    // not a class token, so the base className is used as captured.
    const base = containerCls.trim();
    // Inject the surface as an inline `background-color` (the shipped paint path) so
    // #closed/#open read the day surface and #night reads the dark one.
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n` +
      `/* un-layered shell */\n${shell}</style></head><body>` +
      `<div id="closed" class="${base}" style="left:40px;top:40px;background-color:${dayBg}"></div>` +
      `<div id="open" class="${base}" data-cyc-phase="open" style="left:40px;top:40px;background-color:${dayBg}">` +
      `<div id="item" class="${itemCls}"><span id="icon" class="${iconCls}"></span>` +
      `<span id="text" class="${textCls}">Hi</span></div></div>` +
      `<div id="night" class="${base}" style="left:40px;top:40px;background-color:${nightBg}"></div>` +
      `</body></html>`;

    const page = await (await getBrowser()).newPage();
    try {
      await page.setContent(html, {waitUntil: 'load'});
      const read = (sel: string) =>
        page.$eval(sel, (el) => {
          const c = getComputedStyle(el);
          return {
            position: c.position,
            backdrop:
              c.backdropFilter ||
              (c as unknown as {webkitBackdropFilter: string}).webkitBackdropFilter,
            background: c.backgroundColor,
            opacity: c.opacity,
            visibility: c.visibility,
            transform: c.transform,
            width: c.width,
            transitionProperty: c.transitionProperty,
            zIndex: c.zIndex
          };
        });

      const closed = await read('#closed');
      expect(closed.position).toBe('fixed');
      expect(closed.backdrop).toContain('blur(12px)');
      expect(closed.zIndex).toBe('20');
      expect(closed.background).toBe('rgba(255, 255, 255, 0.9)');
      expect(closed.opacity).toBe('0');
      expect(closed.visibility).toBe('hidden');
      expect(closed.transitionProperty).toContain('opacity');
      expect(closed.transitionProperty).toContain('visibility');

      const open = await read('#open');
      expect(open.opacity).toBe('1');
      expect(open.visibility).toBe('visible');

      const nightRead = await read('#night');
      expect(nightRead.background).toBe('rgba(23, 23, 26, 0.82)');

      
      const item = await page.$eval('#item', (el) => {
        const c = getComputedStyle(el);
        return {display: c.display, cursor: c.cursor, pointerEvents: c.pointerEvents};
      });
      expect(item.display).toBe('grid');
      expect(item.cursor).toBe('pointer');
      expect(item.pointerEvents).toBe('auto');

      const text = await page.$eval('#text', (el) => {
        const c = getComputedStyle(el);
        return {
          whiteSpace: c.whiteSpace,
          pointerEvents: c.pointerEvents,
          textOverflow: c.textOverflow
        };
      });
      expect(text.whiteSpace).toBe('nowrap');
      expect(text.pointerEvents).toBe('none');
      expect(text.textOverflow).toBe('ellipsis');
    } finally {
      await page.close();
    }
  });
});
