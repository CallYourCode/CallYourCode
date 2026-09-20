// Chromium cascade coverage for chat message paint.

import {afterAll, beforeEach, afterEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

import {paintChatRoot} from '../features/chat/surface/chatRootPaint';
import {createMessageNode} from '../features/chat/messages/messageContent';
import {sessionEventMessage, dateMessage} from '../features/chat/messages/sessionEventMessages';
import {setPresentationTheme} from '../components/presentation';
import type {CycSessionEvent} from '../types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const SHELL = resolve(SRC, 'shell');
const CHAT = resolve(SRC, 'features', 'chat');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

const ENV = `
:root{
  --cyc-surface:rgb(30,31,32);
  --cyc-surface-rgb:30,31,32;
  --cyc-text:rgb(20,21,22);
  --cyc-border-color:rgb(70,71,72);
  --cyc-text-muted:rgb(5,6,7);
  --cyc-link-color:rgb(90,90,90);
  --cyc-danger:rgb(200,10,10);
  --cyc-bubble-out-ink:rgb(1,2,3);
  --cyc-bubble-out-ink-rgb:1,2,3;
  --cyc-bubble-out-surface:rgb(4,5,6);
  --cyc-bubble-out-surface-rgb:40,50,60;
  --cyc-service-bg:rgb(11,12,13);
  --cyc-service-fg:rgb(14,15,16);
}
html[data-theme='dark']{
  --cyc-surface:rgb(130,131,132);
  --cyc-text:rgb(120,121,122);
  --cyc-service-bg:rgb(111,112,113);
  --cyc-service-fg:rgb(114,115,116);
}
`;

const tokenize = (c: string) => c.trim().split(/\s+/).filter(Boolean);

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
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SRC, 'features/sessions/sessions.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(CHAT, 'chat.css'), 'utf8') +
    '\n' +
    ENV;
  const themeAttr = theme === 'night' ? " data-theme='dark'" : '';
  const dirAttr = dir === 'rtl' ? " dir='rtl'" : '';
  const html =
    `<!DOCTYPE html><html${themeAttr}${dirAttr}><head><meta charset="utf-8">` +
    `<style>${utilities}\n/* un-layered shell + chat */\n${shell}</style></head>` +
    `<body style="margin:0">${bodyHtml}</body></html>`;
  const page = await (await getBrowser()).newPage();
  await page.setContent(html, {waitUntil: 'load'});
  return page;
}

const mkChat = (theme: 'day' | 'night') => {
  setPresentationTheme(theme);
  const chat = document.createElement('div');
  chat.className = 'cyc-thread';
  paintChatRoot(chat);
  return chat;
};

const ev: CycSessionEvent = {uuid: 'e1', ts: 0, kind: 'tool', text: 'ran a tool', tool: 'bash'};

beforeEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});
afterEach(() => setPresentationTheme('day'));
afterAll(async () => {
  await browser?.close();
});

describe('slice-2 cascade: the cyc-msg-sent custom-property remap resolves per painter/token', () => {
  for (const [dir, theme] of [
    ['ltr', 'day'],
    ['rtl', 'night']
  ] as const) {
    test(`${dir}/${theme}: bubble bg, link + status inks follow the out remap`, async () => {
      const chat = mkChat(theme);
      const out = createMessageNode(true, true, true);
      out.innerHTML =
        '<span id="bg" style="background-color:var(--cyc-bubble-in-surface)"></span>' +
        '<span id="link" style="color:var(--cyc-link-color)"></span>' +
        '<span id="status" style="color:var(--cyc-bubble-status)"></span>' +
        '<span id="icon" style="color:var(--cyc-bubble-glyph)"></span>';
      chat.append(out);
      const page = await render(
        ['cyc-thread', ...tokenize(out.className)],
        chat.outerHTML,
        theme,
        dir
      );
      try {
        const r = await page.evaluate(() => {
          const cs = (id: string, p: string) =>
            getComputedStyle(document.getElementById(id)!).getPropertyValue(p);
          return {
            bg: cs('bg', 'background-color'),
            link: cs('link', 'color'),
            status: cs('status', 'color'),
            icon: cs('icon', 'color')
          };
        });
        expect(r.bg).toBe('rgb(4, 5, 6)');
        expect(r.link).toBe('rgb(1, 2, 3)');
        expect(r.status).toBe(theme === 'night' ? 'rgb(244, 239, 233)' : 'rgb(1, 2, 3)');
        expect(r.icon).toBe(theme === 'night' ? 'rgb(74, 53, 39)' : 'rgb(255, 255, 255)');
      } finally {
        await page.close();
      }
    });
  }
});

describe('slice-2 cascade: dark cyc-msg-sent .cyc-code-frame ink override', () => {
  for (const [dir, theme] of [
    ['ltr', 'day'],
    ['rtl', 'night']
  ] as const) {
    test(`${dir}/${theme}: .cyc-code-frame --cyc-accent/-rgb take the finite fork`, async () => {
      const chat = mkChat(theme);
      const out = createMessageNode(true, true, true);
      const pre = document.createElement('pre');
      pre.className = 'cyc-code-frame';
      pre.innerHTML =
        '<span id="ink" style="color:var(--cyc-accent)"></span>' +
        '<span id="inkrgb" style="color:rgb(var(--cyc-accent-rgb))"></span>';
      out.append(pre);
      chat.append(out);
      const page = await render(
        ['cyc-thread', ...tokenize(out.className)],
        chat.outerHTML,
        theme,
        dir
      );
      try {
        const r = await page.evaluate(() => ({
          ink: getComputedStyle(document.getElementById('ink')!).color,
          inkrgb: getComputedStyle(document.getElementById('inkrgb')!).color
        }));
        expect(r.ink).toBe(theme === 'night' ? 'rgb(244, 239, 233)' : 'rgb(1, 2, 3)');
        expect(r.inkrgb).toBe(theme === 'night' ? 'rgb(74, 53, 39)' : 'rgb(1, 2, 3)');
      } finally {
        await page.close();
      }
    });
  }
});

describe('slice-2 cascade: service-message rich-text + important bg/fg/blur', () => {
  for (const [dir, theme] of [
    ['ltr', 'day'],
    ['rtl', 'night']
  ] as const) {
    test(`${dir}/${theme}: service-text takes --cyc-service bg/fg + 10px blur`, async () => {
      const node = sessionEventMessage(ev);
      const text = node.querySelector<HTMLElement>('.cyc-service-text')!;
      text.innerHTML = '<a id="a">link</a><i id="i">em</i><b id="b">bold</b>';
      const page = await render(
        ['cyc-thread', ...tokenize(text.className)],
        node.outerHTML,
        theme,
        dir
      );
      try {
        const r = await page.evaluate(() => {
          const st = getComputedStyle(document.querySelector('.cyc-service-text')!);
          const a = getComputedStyle(document.getElementById('a')!);
          const i = getComputedStyle(document.getElementById('i')!);
          return {
            bg: st.backgroundColor,
            fg: st.color,
            blur: st.backdropFilter,
            aColor: a.color,
            aCursor: a.cursor,
            aWeight: a.fontWeight,
            iStyle: i.fontStyle
          };
        });
        expect(r.bg).toBe(theme === 'night' ? 'rgb(111, 112, 113)' : 'rgb(11, 12, 13)');
        expect(r.fg).toBe(theme === 'night' ? 'rgb(114, 115, 116)' : 'rgb(14, 15, 16)');
        expect(r.blur).toBe('blur(10px)');
        expect(r.aColor).toBe('rgb(255, 255, 255)');
        expect(r.aCursor).toBe('pointer');
        expect(r.aWeight).toBe('500');
        expect(r.iStyle).toBe('normal');
      } finally {
        await page.close();
      }
    });
  }
});

describe('slice-2 cascade: the date override out-specifies the general service pair', () => {
  for (const [dir, theme] of [
    ['ltr', 'day'],
    ['rtl', 'night']
  ] as const) {
    test(`${dir}/${theme}: date service-text takes surface/primary-text/border and drops blur`, async () => {
      const node = dateMessage('Today');
      const text = node.querySelector<HTMLElement>('.cyc-service-text')!;
      const page = await render(
        ['cyc-thread', ...tokenize(text.className)],
        node.outerHTML,
        theme,
        dir
      );
      try {
        const r = await page.evaluate(() => {
          const st = getComputedStyle(document.querySelector('.cyc-date-chip .cyc-service-text')!);
          return {
            bg: st.backgroundColor,
            fg: st.color,
            blur: st.backdropFilter,
            bw: st.borderTopWidth,
            bs: st.borderTopStyle,
            bc: st.borderTopColor
          };
        });
        expect(r.bg).toBe(theme === 'night' ? 'rgb(130, 131, 132)' : 'rgb(30, 31, 32)');
        expect(r.fg).toBe(theme === 'night' ? 'rgb(120, 121, 122)' : 'rgb(20, 21, 22)');
        expect(r.blur).toBe('none');
        expect(r.bw).toBe('1px');
        expect(r.bs).toBe('solid');
        expect(r.bc).toBe('rgb(70, 71, 72)');
      } finally {
        await page.close();
      }
    });
  }
});
