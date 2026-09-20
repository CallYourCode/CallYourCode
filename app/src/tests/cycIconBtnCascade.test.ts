import {afterAll, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

import {makeIconButton, BTN_ICON_BASE} from '../components/iconGlyphs';

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

const tokenize = (className: string) => className.trim().split(/\s+/).filter(Boolean);

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

describe('cyc-icon-btn skin: makeIconButton() stamps the final base literal', () => {
  test('makeIconButton carries every base token plus the class hook and hover opt-in', () => {
    const btn = makeIconButton('left');
    const cls = btn.className;
    expect(btn.classList.contains('cyc-icon-btn')).toBe(true);
    for (const token of tokenize(BTN_ICON_BASE)) {
      expect(cls.split(/\s+/), `makeIconButton carries ${token}`).toContain(token);
    }
    expect(cls).toContain('text-[1.5rem]!');
    expect(cls).toContain('p-2!');
    expect(cls).toContain('flex');
    expect(cls).toContain('items-center');
    expect(cls).toContain('justify-center');
    expect(cls).toContain('relative');
    expect(cls).toContain('text-(--cyc-text-muted)');
    expect(cls).toContain('[transition:0.2s_color,0.2s_opacity]');
    expect(cls).toContain('disabled:pointer-events-none!');
    expect(cls).toContain('disabled:opacity-[0.3]');
    expect(cls).not.toContain('rounded');
    expect(cls).toContain('fine:hover:bg-(--cyc-text-muted-tint)!');
  });

  test('hoverBg=false drops the hover tint but keeps the base skin', () => {
    const cls = makeIconButton('left', '', false).className;
    expect(cls).not.toContain('fine:hover:bg-(--cyc-text-muted-tint)!');
    expect(cls).toContain('text-[1.5rem]!');
    expect(cls).toContain('p-2!');
  });
});

describe('cyc-icon-btn skin: the layered literals reproduce the computed cascade in Chromium', () => {
  test('default / disabled / override icon buttons compute exactly as the skin did', async () => {
    const base = makeIconButton('left');
    base.id = 'base';
    const disabled = makeIconButton('left');
    disabled.id = 'disabled';
    disabled.disabled = true;
    const override = makeIconButton('left', 'absolute! text-white! bg-black!');
    override.id = 'override';

    const candidates = [...tokenize(base.className), ...tokenize(override.className)];
    const utilities = await compileTailwind(candidates);
    const shell =
      readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
      '\n' +
      readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
      '\n' +
      readFileSync(resolve(SHELL, 'utilities.css'), 'utf8');
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n` +
      `/* un-layered shell */\n${shell}</style></head><body>` +
      `${base.outerHTML}${disabled.outerHTML}${override.outerHTML}` +
      `</body></html>`;

    const page = await (await getBrowser()).newPage();
    try {
      await page.setContent(html, {waitUntil: 'load'});
      const read = (sel: string) =>
        page.$eval(sel, (el) => {
          const c = getComputedStyle(el);
          return {
            fontSize: c.fontSize,
            display: c.display,
            justifyContent: c.justifyContent,
            alignItems: c.alignItems,
            paddingTop: c.paddingTop,
            paddingLeft: c.paddingLeft,
            color: c.color,
            position: c.position,
            borderTopLeftRadius: c.borderTopLeftRadius,
            opacity: c.opacity,
            pointerEvents: c.pointerEvents,
            backgroundColor: c.backgroundColor,
            transitionProperty: c.transitionProperty
          };
        });

      const b = await read('#base');
      expect(b.fontSize).toBe('24px');
      expect(b.paddingTop).toBe('8px');
      expect(b.paddingLeft).toBe('8px');
      expect(b.display).toBe('flex');
      expect(b.justifyContent).toBe('center');
      expect(b.alignItems).toBe('center');
      expect(b.position).toBe('relative');
      expect(b.borderTopLeftRadius).toBe('6px');
      expect(b.transitionProperty).toContain('color');
      expect(b.transitionProperty).toContain('opacity');

      const d = await read('#disabled');
      expect(d.opacity).toBe('0.3');
      expect(d.pointerEvents).toBe('none');

      const o = await read('#override');
      expect(o.position).toBe('absolute');
      expect(o.color).toBe('rgb(255, 255, 255)');
      expect(o.backgroundColor).toBe('rgb(0, 0, 0)');
      expect(o.fontSize).toBe('24px');
      expect(o.paddingLeft).toBe('8px');
    } finally {
      await page.close();
    }
  });
});
