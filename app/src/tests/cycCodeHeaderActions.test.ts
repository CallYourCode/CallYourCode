// Chromium verifies pointer-event routing for code-header actions.

import {afterAll, beforeEach, afterEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';
import {setFormatted} from '../features/chat/content';
import {setPresentationTheme} from '../components/presentation';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const CHAT = resolve(HERE, '..', 'features', 'chat');
const CODE = resolve(HERE, '..', 'features', 'code');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

beforeEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});
afterEach(() => {
  document.body.innerHTML = '';
});

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

const allClasses = (el: HTMLElement): string[] => {
  const out = new Set<string>();
  const walk = (n: Element) => {
    for (const c of n.classList) out.add(c);
    for (const child of n.children) walk(child);
  };
  walk(el);
  return [...out];
};

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

const CODE_TEXT = 'const a = 1;\nconst b = 2;';

async function buildPage() {
  const body = document.createElement('div');
  body.className = 'cyc-message-text';
  setFormatted(body, '```js\n' + CODE_TEXT + '\n```');
  const wrap = document.createElement('div');
  wrap.className = 'cyc-message cyc-msg-received';
  wrap.append(body);

  const utilities = await compileTailwind(allClasses(wrap));
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(CHAT, 'chat.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(CODE, 'codeViewer.css'), 'utf8');
  const html =
    `<!DOCTYPE html><html style="--cyc-pane-gap:8px;--cyc-chat-width:600px">` +
    `<head><meta charset="utf-8"><style>${utilities}\n${shell}</style></head>` +
    `<body style="margin:0;width:600px"><div id="root">${wrap.outerHTML}</div></body></html>`;
  const page = await (await getBrowser()).newPage({viewport: {width: 800, height: 600}});
  await page.setContent(html, {waitUntil: 'load'});
  await page.evaluate(() => {
    const w = window as unknown as {
      __acts: {wrap: number; full: number; copy: number};
      __clip: string[];
    };
    w.__acts = {wrap: 0, full: 0, copy: 0};
    w.__clip = [];
    const root = document.getElementById('root')!;
    root.addEventListener(
      'click',
      (e) => {
        const t = e.target as Element | null;
        if (!t) return;
        const container = t.closest('.cyc-src-head') && t.closest('.cyc-code-frame');
        if (!container) return;
        const code = t.closest('.cyc-code-frame')!.querySelector('.cyc-src-body') as HTMLElement;
        if (t.closest('.cyc-code-toggle-wrap')) {
          const box = t.closest('.cyc-code-frame') as HTMLElement;
          box.dataset.cycCodeFlow = box.dataset.cycCodeFlow === 'pan' ? 'wrap' : 'pan';
          w.__acts.wrap++;
          return;
        }
        if (t.closest('.cyc-src-head-fullscreen')) {
          w.__acts.full++;
          return;
        }
        w.__clip.push(code.textContent ?? '');
        w.__acts.copy++;
      },
      true
    );
  });
  return page;
}

const clickCenter = async (page: import('playwright').Page, cls: string) => {
  const box = await page.$eval('.' + cls, (el) => {
    const r = el.getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  });
  await page.mouse.click(box.x, box.y);
};

const readState = (page: import('playwright').Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __acts: {wrap: number; full: number; copy: number};
      __clip: string[];
    };
    return {
      acts: w.__acts,
      clip: w.__clip,
      scrollable: (document.querySelector('.cyc-code-frame') as HTMLElement).dataset.cycCodeFlow === 'pan'
    };
  });

describe('code header buttons route to distinct actions on real clicks', () => {
  test('the buttons are pointer-events:auto so clicks hit their own affordance', async () => {
    const page = await buildPage();
    try {
      const pe = await page.evaluate(() =>
        ['cyc-code-toggle-wrap', 'cyc-src-head-fullscreen', 'cyc-code-copy'].map((c) => {
          const btn = document.querySelector('.' + c) as HTMLElement;
          const r = btn.getBoundingClientRect();
          const hit = document.elementFromPoint(
            r.left + r.width / 2,
            r.top + r.height / 2
          ) as Element | null;
          return {
            cls: c,
            pe: getComputedStyle(btn).pointerEvents,
            hits: !!hit?.closest('.' + c)
          };
        })
      );
      for (const p of pe) {
        expect(p.pe, p.cls).toBe('auto');
        expect(p.hits, p.cls).toBe(true);
      }
    } finally {
      await page.close();
    }
  });

  test('Word Wrap toggles wrapping only -- no fullscreen, no clipboard', async () => {
    const page = await buildPage();
    try {
      await clickCenter(page, 'cyc-code-toggle-wrap');
      const s = await readState(page);
      expect(s.acts).toEqual({wrap: 1, full: 0, copy: 0});
      expect(s.clip).toEqual([]);
      expect(s.scrollable).toBe(false);
    } finally {
      await page.close();
    }
  });

  test('Expand opens the fullscreen viewer only -- no wrap, no clipboard', async () => {
    const page = await buildPage();
    try {
      await clickCenter(page, 'cyc-src-head-fullscreen');
      const s = await readState(page);
      expect(s.acts).toEqual({wrap: 0, full: 1, copy: 0});
      expect(s.clip).toEqual([]);
      expect(s.scrollable).toBe(true);
    } finally {
      await page.close();
    }
  });

  test('Copy writes the code text to the clipboard only -- no wrap, no fullscreen', async () => {
    const page = await buildPage();
    try {
      await clickCenter(page, 'cyc-code-copy');
      const s = await readState(page);
      expect(s.acts).toEqual({wrap: 0, full: 0, copy: 1});
      expect(s.clip).toEqual([CODE_TEXT]);
      expect(s.scrollable).toBe(true);
    } finally {
      await page.close();
    }
  });
});
