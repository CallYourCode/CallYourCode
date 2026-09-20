// Chromium cascade coverage for attachment message variants.

import {afterAll, afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

// Stub object URLs while building detached message DOM.
vi.mock('../engine/contract', () => ({
  engineObjectUrl: vi.fn((url: string) => Promise.resolve(url)),
  engineCapFetch: vi.fn(() => new Promise(() => {})),
  whenEngineReady: vi.fn(() => Promise.resolve(true)),
  docUrl: (id: string) => `doc://${id}`
}));

import {
  photoMessage,
  textMessage,
  replyPanel,
  MESSAGE_CONTENT_UTILS
} from '../features/chat/messages/messageContent';
import {setPresentationTheme} from '../components/presentation';
import type {CycMessage, CycReplyTo} from '../types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const SHELL = resolve(SRC, 'shell');
const CHAT = resolve(SRC, 'features', 'chat');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

// Seed bubble background tokens used by the fixture.
const ENV = `
:root{
  --cyc-bubble-in-surface: rgb(200,200,200);
  --cyc-bubble-out-surface: rgb(4,5,6);
}
`;

const tokenize = (c: string) => c.trim().split(/\s+/).filter(Boolean);
const subtreeClasses = (node: Element) =>
  [node, ...node.querySelectorAll('*')].flatMap((e) =>
    (e.getAttribute('class') || '').split(/\s+/)
  );

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

async function render(
  candidates: string[],
  bodyHtml: string,
  theme: 'day' | 'night',
  dir: 'ltr' | 'rtl'
) {
  const utilities = await compileTailwind(candidates);
  const shell =
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(CHAT, 'chat.css'), 'utf8') +
    '\n' +
    ENV;
  const themeAttr = theme === 'night' ? " data-theme='dark'" : '';
  const dirAttr = dir === 'rtl' ? " dir='rtl'" : '';
  const html =
    `<!DOCTYPE html><html${themeAttr}${dirAttr}><head><meta charset="utf-8">` +
    `<style>${utilities}\n/* un-layered shell + chat */\n${shell}</style></head>` +
    `<body style="margin:0"><div style="width:500px">${bodyHtml}</div></body></html>`;
  const page = await (await getBrowser()).newPage();
  await page.setContent(html, {waitUntil: 'load'});
  return page;
}

const reply: CycReplyTo = {ts: 0, role: 'user', title: 'Someone', text: 'the quoted line'};

const jmMsg = (): CycMessage =>
  ({role: 'claude', kind: 'text', text: 'pic', ts: 0}) as unknown as CycMessage;
const capMsg = (): CycMessage =>
  ({role: 'user', kind: 'text', text: 'hello', ts: 0}) as unknown as CycMessage;
const repMsg = (): CycMessage =>
  ({role: 'claude', kind: 'text', text: 'a body', ts: 0, replyTo: reply}) as unknown as CycMessage;

beforeEach(() => setPresentationTheme('day'));
afterEach(() => setPresentationTheme('day'));
afterAll(async () => {
  await browser?.close();
});

describe('attachment slices 1-7 cascade: current variants win over the un-layered chat.css skin', () => {
  for (const [dir, theme] of [
    ['ltr', 'day'],
    ['ltr', 'night'],
    ['rtl', 'day'],
    ['rtl', 'night']
  ] as const) {
    test(`${dir}/${theme}: cyc-msg-media-only collapse, photo width, reply margin all resolve`, async () => {
      setPresentationTheme(theme);
      const jm = photoMessage(jmMsg(), true, true, 'http://x/a.png', 'pic');
      jm.id = 'jm';
      const cap = photoMessage(capMsg(), true, true, 'http://x/b.png', 'pic');
      cap.id = 'cap';
      const rep = textMessage(repMsg(), false, false);
      rep.id = 'rep';
      const composer = replyPanel(reply, true);
      composer.id = 'composer-reply';

      const widthHtml =
        `<div class="cyc-message cyc-media-tile"><div id="pw" class="cyc-message-content ${MESSAGE_CONTENT_UTILS}">` +
        '<div style="width:40px;height:10px"></div><div style="width:120px;height:10px"></div></div></div>' +
        `<div class="cyc-message"><div id="nw" class="cyc-message-content ${MESSAGE_CONTENT_UTILS}">` +
        '<div style="width:40px;height:10px"></div><div style="width:120px;height:10px"></div></div></div>';

      const candidates = [
        ...tokenize(MESSAGE_CONTENT_UTILS),
        'cyc-message',
        'photo',
        ...subtreeClasses(jm),
        ...subtreeClasses(cap),
        ...subtreeClasses(rep),
        ...subtreeClasses(composer)
      ].filter(Boolean);

      const page = await render(
        candidates,
        jm.outerHTML + cap.outerHTML + rep.outerHTML + composer.outerHTML + widthHtml,
        theme,
        dir
      );
      try {
        const r = await page.evaluate(() => {
          const cs = (sel: string, props: string[]) => {
            const el = document.querySelector(sel);
            if (!el) throw new Error(`no match for ${sel}`);
            const s = getComputedStyle(el);
            const o: Record<string, string> = {};
            for (const p of props) o[p] = s.getPropertyValue(p);
            return o;
          };
          return {
            jmContent: cs('#jm .cyc-message-content', ['background-color', 'box-shadow']),
            jmAct: cs('#jm .cyc-stamp-act', ['display']),
            jmTime: cs('#jm .cyc-stamp', ['margin-inline-start']),
            jmPhoto: cs('#jm .cyc-still', ['object-fit']),
            capContent: cs('#cap .cyc-message-content', ['background-color', 'box-shadow']),
            capAct: cs('#cap .cyc-stamp-act', ['display']),
            repReply: cs('#rep .cyc-reply', ['margin-top']),
            composerReply: cs('#composer-reply', ['margin-top']),
            pw: parseFloat(cs('#pw', ['width'])['width']),
            nw: parseFloat(cs('#nw', ['width'])['width'])
          };
        });

        expect(r.jmContent['background-color'], `${dir}/${theme}`).toBe('rgba(0, 0, 0, 0)');
        expect(r.jmContent['box-shadow'], `${dir}/${theme}`).not.toContain('0.12');
        expect(r.jmAct.display, `${dir}/${theme}`).toBe('none');
        expect(r.jmTime['margin-inline-start'], `${dir}/${theme}`).toBe('8px');
        expect(r.jmPhoto['object-fit'], `${dir}/${theme}`).toBe('contain');

        expect(r.capContent['background-color'], `${dir}/${theme}`).toBe('rgb(4, 5, 6)');
        expect(r.capContent['box-shadow'], `${dir}/${theme}`).not.toBe('none');
        expect(r.capAct.display, `${dir}/${theme}`).not.toBe('none');

        expect(r.repReply['margin-top'], `${dir}/${theme}`).toBe('8px');
        expect(r.composerReply['margin-top'], `${dir}/${theme}`).toBe('0px');

        expect(r.pw, `${dir}/${theme}`).toBeLessThan(200);
        expect(r.nw, `${dir}/${theme}`).toBeGreaterThan(300);
      } finally {
        await page.close();
      }
    });
  }
});
