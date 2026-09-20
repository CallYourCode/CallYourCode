import {afterAll, afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

// Browser coverage for terminal viewer presentation and cascade behavior.

vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    element: HTMLElement | null = null;
    constructor(opts: Record<string, unknown>) {
      this.options = opts;
    }
    loadAddon() {}
    onData() {}
    open(parent: HTMLElement) {
      this.element = document.createElement('div');
      this.element.className = 'xterm';
      parent.appendChild(this.element);
    }
    write() {}
    clear() {}
    focus() {}
    dispose() {}
  }
  return {Terminal};
});
vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    fit() {}
  }
  return {FitAddon};
});
vi.mock('../engine/store', () => ({
  watchTerminal: vi.fn(() => () => {}),
  resizeTerminal: vi.fn(),
  scrollTerminal: vi.fn(),
  sendTerminalInput: vi.fn(),
  TERMINAL_PANE_OVERRIDE: null
}));
vi.mock('../components/widgets', () => ({toast: vi.fn()}));
vi.mock('@/shared/logging', () => ({cyclog: vi.fn()}));

import {openTerminalViewer} from '../components/terminalViewer';
import {setPresentationTheme, themePainterCount} from '../components/presentation';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

function open(): HTMLElement {
  openTerminalViewer('ws://fake-terminal.test:7788/ws|p1', 'demo');
  return document.querySelector<HTMLElement>('.cyc-term')!;
}
const keys = (overlay: HTMLElement) => [
  ...overlay.querySelectorAll<HTMLButtonElement>('.cyc-term-key')
];
const keyByLabel = (overlay: HTMLElement, label: string) =>
  keys(overlay).find((b) => b.textContent === label)!;
const press = (b: HTMLElement) => {
  const opts = {clientX: 5, clientY: 5, cancelable: true, bubbles: true};
  b.dispatchEvent(new MouseEvent('pointerdown', opts));
  b.dispatchEvent(new MouseEvent('pointerup', opts));
};
const cls = (el: Element | null) => el?.className ?? '';

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener() {},
    removeEventListener() {}
  }) as unknown as typeof window.matchMedia;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof window.requestAnimationFrame;
  document.body.innerHTML = '';
  setPresentationTheme('day');
});
afterEach(() => {
  document
    .querySelector<HTMLElement>('.cyc-term-back')
    ?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
  document.body.innerHTML = '';
  setPresentationTheme('day');
});

describe('terminal viewer paint (was terminal.css)', () => {
  test('container / screen / bar / status carry their current literal utilities', () => {
    const overlay = open();
    expect(cls(overlay)).toContain('absolute');
    expect(cls(overlay)).toContain('z-[11]');
    expect(cls(overlay)).toContain('bg-black');
    expect(cls(overlay)).toContain('overflow-hidden');

    const screen = overlay.querySelector('.cyc-term-screen')!;
    expect(cls(screen)).toContain('w-full');
    expect(cls(screen)).toContain('[touch-action:none]');

    const bar = overlay.querySelector('.cyc-term-bar')!;
    expect(cls(bar)).toContain('bg-[#101010]');
    expect(cls(bar)).toContain('[border-top:1px_solid_rgba(255,255,255,0.1)]');
    expect(cls(bar)).toContain('gap-1.5');

    const status = overlay.querySelector('.cyc-term-status')!;
    expect(cls(status)).toContain('bg-[rgba(0,0,0,0.7)]');
    expect(cls(status)).toContain('[transform:translate(-50%,-50%)]');
    expect(cls(status)).toContain('pointer-events-none');
  });

  test('the back button keeps its icon-btn skin but overrides it with important markers', () => {
    const back = open().querySelector('.cyc-term-back')!;
    expect(cls(back)).toContain('cyc-icon-btn');
    expect(cls(back)).toContain('absolute!');
    expect(cls(back)).toContain('text-white!');
    expect(cls(back)).toContain('bg-[rgba(0,0,0,0.55)]!');
    expect(cls(back)).toContain('w-9');
    expect(cls(back)).toContain('h-9');
  });

  test('action keys paint the resting surface with the important button-reset markers', () => {
    const key = keyByLabel(open(), '←');
    expect(cls(key)).toContain('bg-[rgba(255,255,255,0.12)]!'); // beats button{background:none}
    expect(cls(key)).toContain('px-2!'); // beats button{padding:0}
    expect(cls(key)).toContain('text-[0.875rem]!'); // beats button{font-size:inherit}
    expect(cls(key)).toContain('[font-family:inherit]!'); // beats tokens button{font-family}
    expect(cls(key)).toContain('text-[#f2f2f2]');
    expect(cls(key)).toContain('font-medium');
    expect(cls(key)).toContain('leading-none');
  });

  test('wide keys widen; standard keys keep the base min-width', () => {
    const overlay = open();
    const enter = keyByLabel(overlay, 'Enter');
    const left = keyByLabel(overlay, '←');
    expect(cls(enter)).toContain('min-w-[2.875rem]');
    expect(cls(enter)).not.toContain('min-w-9');
    expect(cls(left)).toContain('min-w-9');
    expect(cls(left)).not.toContain('min-w-[2.875rem]');
  });

  test('the xterm wrapper geometry is painted onto the generated .xterm', () => {
    const xterm = open().querySelector('.cyc-term-screen .xterm')!;
    expect(cls(xterm)).toContain('h-full');
    expect(cls(xterm)).toContain('p-0');
    expect(cls(xterm)).toContain('[font-variant-emoji:text]');
  });

  test('latching a modifier tints it primary per theme and clears on the next key', () => {
    const overlay = open();
    const ctrl = keyByLabel(overlay, 'Ctrl');

    press(ctrl);
    expect(ctrl.classList.contains('on')).toBe(true);
    expect(cls(ctrl)).toContain('bg-[#96602f]!'); // day primary
    expect(cls(ctrl)).toContain('text-white');
    expect(cls(ctrl)).not.toContain('bg-[rgba(255,255,255,0.12)]!');

    setPresentationTheme('night');
    expect(cls(ctrl)).toContain('bg-[#c98652]!');
    expect(cls(ctrl)).not.toContain('bg-[#96602f]!');

    press(keyByLabel(overlay, '←'));
    expect(ctrl.classList.contains('on')).toBe(false);
    expect(cls(ctrl)).toContain('bg-[rgba(255,255,255,0.12)]!');
    expect(cls(ctrl)).toContain('text-[#f2f2f2]');
    expect(cls(ctrl)).not.toContain('bg-[#c98652]!');
  });

  test('the on-key theme painter is pruned once the overlay detaches', () => {
    const before = themePainterCount();
    open();
    expect(themePainterCount()).toBe(before + 1);
    document.body.innerHTML = '';
    setPresentationTheme('night'); // notify prunes detached painters
    expect(themePainterCount()).toBe(before);
  });
});

// Browser probes verify terminal utilities override the shell skin.
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
const tokenize = (className: string) => className.trim().split(/\s+/).filter(Boolean);

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

async function measure(
  bodyHtml: string,
  candidates: string[],
  probes: Record<string, {selector: string; props: string[]}>
): Promise<Record<string, Record<string, string>>> {
  const utilities = await compileTailwind(candidates);
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n/* un-layered shell */\n${shell}</style></head><body>${bodyHtml}</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(
      ({probes}) => {
        const out: Record<string, Record<string, string>> = {};
        for (const [key, {selector, props}] of Object.entries(probes)) {
          const el = document.querySelector(selector);
          if (!el) throw new Error(`probe ${key}: selector ${selector} matched nothing`);
          const s = getComputedStyle(el);
          out[key] = {};
          for (const p of props) out[key][p] = s.getPropertyValue(p);
        }
        return out;
      },
      {probes}
    );
  } finally {
    await page.close();
  }
}

afterAll(async () => {
  await browser?.close();
});

describe('terminal cascade: layered utilities must beat the un-layered shell skin', () => {
  test('resting action key: surface / padding / font win over the button reset', async () => {
    const key = keyByLabel(open(), '←');
    const keyClass = key.className;

    const styles = await measure(
      `<div style="font-size:30px;font-family:'Zapfino'"><button id="k" class="${keyClass}">x</button></div>`,
      tokenize(keyClass),
      {
        k: {
          selector: '#k',
          props: ['background-color', 'padding-left', 'padding-right', 'font-size', 'font-family']
        },
        root: {selector: ':root', props: ['font-size']}
      }
    );
    const k = styles.k;
    const rem = parseFloat(styles.root['font-size']); // app html font-size (15px)
    expect(k['background-color']).toBe('rgba(255, 255, 255, 0.12)'); // not button `none`
    expect(parseFloat(k['padding-left'])).toBeCloseTo(0.5 * rem, 1); // 0.5rem, not 0
    expect(parseFloat(k['padding-right'])).toBeCloseTo(0.5 * rem, 1);
    expect(parseFloat(k['font-size'])).toBeCloseTo(0.875 * rem, 1); // 0.875rem, not 30px
    expect(k['font-family']).toContain('Zapfino'); // inherited, not overridden
  });

  test('latched action key: the themed primary surface wins', async () => {
    const overlay = open();
    const ctrl = keyByLabel(overlay, 'Ctrl');
    press(ctrl); // day -> bg-[#96602f]!
    const onClass = ctrl.className;
    const styles = await measure(
      `<button id="on" class="${onClass}">x</button>`,
      tokenize(onClass),
      {on: {selector: '#on', props: ['background-color']}}
    );
    expect(styles.on['background-color']).toBe('rgb(150, 96, 47)'); // #96602f
  });

  test('back button: position / ink / surface win over the .cyc-icon-btn skin', async () => {
    const back = open().querySelector<HTMLElement>('.cyc-term-back')!;
    const backClass = back.className;
    const styles = await measure(
      `<button id="b" class="${backClass}"></button>`,
      tokenize(backClass),
      {b: {selector: '#b', props: ['position', 'color', 'background-color']}}
    );
    expect(styles.b.position).toBe('absolute'); // not .cyc-icon-btn relative
    expect(styles.b.color).toBe('rgb(255, 255, 255)'); // not var(--cyc-text-muted)
    expect(styles.b['background-color']).toBe('rgba(0, 0, 0, 0.55)'); // not transparent
  });
});
