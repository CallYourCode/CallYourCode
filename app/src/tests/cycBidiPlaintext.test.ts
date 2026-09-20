import {afterAll, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser, type Page} from 'playwright';

// Chromium coverage that composer and message bodies use per-paragraph `unicode-bidi: plaintext`.

(globalThis as {ResizeObserver?: unknown}).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import {createComposer} from '../features/composer/components/messageComposer';
import {textMessage} from '../features/chat/messages/messageContent';
import type {CycMessage} from '../types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const CHAT = resolve(HERE, '..', 'features', 'chat', 'chat.css');
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

function collectClasses(roots: Element[]): string[] {
  const classes = new Set<string>();
  for (const root of roots) {
    for (const node of [root, ...Array.from(root.querySelectorAll('*'))]) {
      const cls = node.getAttribute('class');
      if (cls) for (const t of tokenize(cls)) classes.add(t);
    }
  }
  return Array.from(classes);
}

// The exact composer field the app ships: the real createComposer builds the
// `[contenteditable='true'] dir='auto'` `.cyc-composer-input` node (autosize wires its
// scroll/position classes on too). Stub callbacks; nothing here fires them.
function composerInputDom(): {html: string; classes: string[]} {
  const composer = createComposer({
    onSend: () => {},
    onJumpToReply: () => {},
    onAttach: () => {},
    onStage: () => {},
    onVoiceStart: () => {},
    onVoiceEnd: () => {},
    onLiveSend: () => {},
    onVoiceCancel: () => {}
  } as never);
  return {html: composer.el.outerHTML, classes: collectClasses([composer.el])};
}

// The exact rendered body the app ships: the real textMessage producer runs the markdown
// formatter over multi-paragraph mixed LTR/RTL copy plus a blockquote, so the live nodes
// carry `.cyc-message-text` and `.cyc-callout` exactly as a real message would.
const MIXED_TEXT =
  'English lead paragraph\n' +
  'اگر آپ یہ پڑھ سکتے ہیں تو شیکھر کا آپ کو سلام\n' +
  '> quoted اگر آپ یہ پڑھ سکتے ہیں تو شیکھر کا آپ کو سلام';

function messageBodyDom(): {html: string; classes: string[]} {
  const m = {
    id: 1,
    role: 'claude',
    text: MIXED_TEXT,
    status: 'sent'
  } as unknown as CycMessage;
  const node = textMessage(m, true, true);
  return {html: node.outerHTML, classes: collectClasses([node])};
}

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

async function buildPage(bodyHtml: string, candidates: string[]): Promise<Page> {
  const utilities = await compileTailwind(candidates);
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(CHAT, 'utf8');
  const doc =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n` +
    `/* un-layered shell + chat */\n${shell}</style></head><body>${bodyHtml}</body></html>`;
  const page = await (await getBrowser()).newPage();
  await page.setContent(doc, {waitUntil: 'load'});
  return page;
}

const bidiOf = (page: Page, selector: string) =>
  page.$eval(selector, (el) => getComputedStyle(el).unicodeBidi);

describe('bidi plaintext: the composer + rendered roots compute per-paragraph plaintext', () => {
  test('the live composer field, message body and quote card all compute unicode-bidi: plaintext', async () => {
    const composer = composerInputDom();
    const body = messageBodyDom();
    const page = await buildPage(
      `<div id="control" dir="auto">mixed اگر آپ یہ پڑھ سکتے ہیں تو شیکھر کا آپ کو سلام</div>` +
        `<div id="composer-host">${composer.html}</div>` +
        `<div id="body-host">${body.html}</div>`,
      [...composer.classes, ...body.classes]
    );
    try {
      // The composer field really is a dir=auto contenteditable (the failure mode's first
      // consumer) and now computes plaintext, not the UA isolate.
      expect(await bidiOf(page, '#composer-host .cyc-composer-input')).toBe('plaintext');
      expect(
        await page.$eval('#composer-host .cyc-composer-input', (el) => el.getAttribute('dir'))
      ).toBe('auto');

      // The rendered message body and every quote card it contains compute plaintext too.
      expect(await bidiOf(page, '#body-host .cyc-message-text')).toBe('plaintext');
      expect(await bidiOf(page, '#body-host .cyc-callout')).toBe('plaintext');

      expect(await bidiOf(page, '#control')).toBe('isolate');
    } finally {
      await page.close();
    }
  });

  test('plaintext gives each paragraph its own content-derived base direction', async () => {
    // Mixed multi-paragraph content under `unicode-bidi: plaintext` and `direction: ltr`.
    // Paragraph 1 is RTL-first (Urdu), paragraph 2 is LTR-first. Each paragraph resolves
    // its own base direction from its own content, so paragraph 1's leading Urdu glyph
    // hugs the RIGHT edge while paragraph 2's leading Latin glyph stays at the LEFT.
    // `white-space: pre-wrap` (composer field / message body) makes each `\n` a bidi
    // paragraph break; the wide box makes the side unambiguous.
    const inner =
      `<span class="mk" id="rtlLead">ا</span>گر آپ یہ پڑھ سکتے ہیں تو شیکھر کا آپ کو سلام\n` +
      `<span class="mk" id="ltrLead">A</span>bc اگر آپ یہ پڑھ سکتے ہیں تو شیکھر کا آپ کو سلام`;
    const boxCss = 'white-space:pre-wrap; direction:ltr; width:400px; font-size:20px;';
    const page = await buildPage(
      `<div id="plain" style="${boxCss} unicode-bidi:plaintext;">${inner}</div>`,
      []
    );
    try {
      const sides = await page.evaluate(() => {
        const read = (markId: string) => {
          const boxEl = document.getElementById('plain')!;
          const markEl = boxEl.querySelector('#' + markId)!;
          const box = boxEl.getBoundingClientRect();
          const mark = markEl.getBoundingClientRect();
          const markCenter = mark.left + mark.width / 2;
          const boxCenter = box.left + box.width / 2;
          return markCenter > boxCenter ? 'right' : 'left';
        };
        return {plainRtlPara: read('rtlLead'), plainLtrPara: read('ltrLead')};
      });
      expect(sides.plainRtlPara).toBe('right');
      expect(sides.plainLtrPara).toBe('left');
    } finally {
      await page.close();
    }
  });
});
