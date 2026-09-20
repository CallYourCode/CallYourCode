import {afterAll, beforeEach, describe, expect, test, vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

// Chromium verifies that rendered Markdown stays below the toolbar and leaves Back clickable.

vi.mock('../engine/contract', () => ({
  engineCapFetch: vi.fn(() => new Promise(() => {})),
  engineObjectUrl: vi.fn((url: string) => Promise.resolve(url)),
  docUrl: (id: string) => `doc://${id}`
}));

import {openFileViewer} from '../features/media/fileViewer';
import type {CycFileRef} from '../types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const SRC = resolve(HERE, '..');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

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

const MD = '# Title\n\nSome **bold** intro paragraph.\n\n- one\n- two\n\nMore text below.\n';

async function openMarkdownViewer(): Promise<HTMLElement> {
  document.body.innerHTML = '';
  const page = document.createElement('div');
  page.id = 'cyc-stage';
  document.body.append(page);
  const file: CycFileRef = {
    docId: 'doc1',
    name: 'notes.md',
    fileKind: 'markdown',
    size: 0
  } as CycFileRef;
  openFileViewer(file, undefined, '', undefined, async () => ({
    name: 'notes.md',
    fileKind: 'markdown',
    content: MD
  }));
  await flush();
  return document.querySelector('.cyc-file-viewer') as HTMLElement;
}

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

async function geometry(overlayHtml: string, candidates: string[]) {
  const utilities = await compileTailwind(candidates);
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SRC, 'features/media/media.css'), 'utf8');
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n/* un-layered shell */\n${shell}</style></head>` +
    `<body><div id="cyc-stage" style="position:relative;width:420px;height:720px">${overlayHtml}</div></body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setViewportSize({width: 420, height: 720});
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(() => {
      const header = document.querySelector('.cyc-fv-header') as HTMLElement;
      const scroll = document.querySelector('.cyc-fv-scroll') as HTMLElement;
      const back = document.querySelector('.cyc-pane-back') as HTMLElement;
      const hr = header.getBoundingClientRect();
      const sr = scroll.getBoundingClientRect();
      const br = back.getBoundingClientRect();
      const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
      return {
        scrollPosition: getComputedStyle(scroll).position,
        headerBottom: hr.bottom,
        headerHeight: hr.height,
        scrollTop: sr.top,
        backHit: hit ? (hit === back || back.contains(hit) ? 'back' : hit.className) : 'none'
      };
    });
  } finally {
    await page.close();
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterAll(async () => {
  await browser?.close();
});

describe('rendered-markdown file viewer layout', () => {
  test('the scroll body stays below the toolbar and never overlaps it', async () => {
    const overlay = await openMarkdownViewer();
    expect(overlay.querySelector('.cyc-md')).not.toBeNull(); // markdown really rendered
    const tokens = overlay.outerHTML.match(/class="([^"]*)"/g)?.join(' ') ?? '';
    const candidates = tokens
      .replace(/class="|"/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    const g = await geometry(overlay.outerHTML, candidates);
    expect(g.scrollPosition).toBe('relative');
    expect(g.headerHeight).toBeGreaterThanOrEqual(56); // min-h-14 (3.5rem @16px root)
    expect(g.scrollTop).toBeGreaterThanOrEqual(g.headerBottom - 0.5);
    expect(g.backHit).toBe('back');
  });

  test('clicking Back closes the viewer', async () => {
    const overlay = await openMarkdownViewer();
    expect(document.querySelector('.cyc-file-viewer')).not.toBeNull();
    const back = overlay.querySelector('.cyc-pane-back') as HTMLElement;
    back.click();
    expect(document.querySelector('.cyc-file-viewer')).toBeNull();
  });
});
