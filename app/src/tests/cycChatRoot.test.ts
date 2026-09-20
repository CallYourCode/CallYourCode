// Chat-root painter and cascade coverage.

import {afterAll, beforeEach, afterEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

import {paintChatRoot, CHAT_ROOT_THEME_VARS} from '../features/chat/surface/chatRootPaint';
import {dateMessage} from '../features/chat/messages/sessionEventMessages';
import {paintMessageFrameWidth} from '../features/chat/messages/messageFrame';
import {createMessageNode, applyMessageRootVars} from '../features/chat/messages/messageContent';
import {
  setPresentationTheme,
  installPresentationReactivity,
  currentPresentation
} from '../components/presentation';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const CHAT = resolve(HERE, '..', 'features', 'chat');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

const mkChat = () => {
  const el = document.createElement('div');
  el.className = 'cyc-thread';
  return el;
};

beforeEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});
afterEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});

describe('paintChatRoot drains the .cyc-thread block onto the root', () => {
  test('non-forking legs are inline final values; header-height stays var-owned', () => {
    const el = mkChat();
    paintChatRoot(el);
    expect(el.style.getPropertyValue('--cyc-overlay-stack-height')).toBe('0px');
    expect(el.style.getPropertyValue('--cyc-composer-surface')).toBe('var(--cyc-surface)');
    expect(el.style.getPropertyValue('--cyc-bubble-ink')).toBe('var(--cyc-accent)');
    expect(el.style.getPropertyValue('--cyc-bubble-flash')).toContain(
      'var(--cyc-bubble-flash-color,'
    );
    expect(el.style.getPropertyValue('--cyc-chat-pad-top')).toBe(
      'calc(var(--cyc-chat-header-height) + var(--cyc-pane-gap) + var(--cyc-overlay-stack-height))'
    );
    expect(el.style.getPropertyValue('--cyc-chat-header-height')).toBe('');
    expect(el.style.getPropertyValue('--cyc-chat-pad-bottom')).toBe(
      'calc(var(--cyc-composer-height) + var(--cyc-pane-gap) + max(var(--cyc-composer-floor, 0px), var(--cyc-safe-bottom)))'
    );
    expect(el.style.getPropertyValue('--cyc-composer-height-surplus')).toBe('');
  });

  test('the seven message vars fork finite day/night literals via the theme painter', () => {
    const day = mkChat();
    paintChatRoot(day);
    for (const [name, fork] of Object.entries(CHAT_ROOT_THEME_VARS))
      expect(day.style.getPropertyValue(name)).toBe(fork.day);

    setPresentationTheme('night');
    const night = mkChat();
    paintChatRoot(night);
    for (const [name, fork] of Object.entries(CHAT_ROOT_THEME_VARS))
      expect(night.style.getPropertyValue(name)).toBe(fork.night);
    expect(night.style.getPropertyValue('--cyc-bubble-error')).toBe('#f4efe9');
  });

  test('a mounted root repaints live on a day/night flip', () => {
    const el = mkChat();
    document.body.append(el);
    paintChatRoot(el);
    expect(el.style.getPropertyValue('--cyc-bubble-out-link')).toBe('var(--cyc-link-color)');
    setPresentationTheme('night');
    expect(el.style.getPropertyValue('--cyc-bubble-out-link')).toBe('#f4efe9');
    setPresentationTheme('day');
    expect(el.style.getPropertyValue('--cyc-bubble-out-link')).toBe('var(--cyc-link-color)');
  });
});

describe('paintMessageFrameWidth owns the frame --cyc-msg-frame-max by width bucket', () => {
  const withWidth = (px: number, fn: () => void) => {
    const desc = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', {value: px, configurable: true});
    const teardown = installPresentationReactivity(); // adopts the new geometry now
    try {
      fn();
    } finally {
      teardown();
      if (desc) Object.defineProperty(window, 'innerWidth', desc);
      const reset = installPresentationReactivity();
      reset();
    }
  };

  test('laptop/tablet resolve to 30rem and phone to the handheld inset', () => {
    withWidth(1200, () => {
      expect(currentPresentation().width).toBe('laptop');
      const inner = document.createElement('div');
      paintMessageFrameWidth(inner);
      expect(inner.style.getPropertyValue('--cyc-msg-frame-max')).toBe('30rem');
    });
    withWidth(800, () => {
      expect(currentPresentation().width).toBe('tablet');
      const inner = document.createElement('div');
      paintMessageFrameWidth(inner);
      expect(inner.style.getPropertyValue('--cyc-msg-frame-max')).toBe('30rem');
    });
    withWidth(390, () => {
      expect(currentPresentation().width).toBe('phone');
      const inner = document.createElement('div');
      paintMessageFrameWidth(inner);
      expect(inner.style.getPropertyValue('--cyc-msg-frame-max')).toBe('calc(100% - 2.75rem)');
    });
  });
});

describe('createMessageNode applies the .cyc-message root vars', () => {
  test('every frame-bearing row carries the final var remaps, but not --max-width', () => {
    const node = createMessageNode(false, true, true);
    expect(node.style.getPropertyValue('--cyc-line-height')).toBe('1.3');
    expect(node.style.getPropertyValue('--cyc-accent')).toBe('var(--cyc-bubble-ink)');
    expect(node.style.getPropertyValue('--cyc-text-muted')).toBe('var(--cyc-bubble-status)');
    expect(node.style.getPropertyValue('--cyc-sender-rgb')).toBe('var(--cyc-bubble-ink-rgb)');
    expect(node.style.getPropertyValue('--cyc-sender-bar')).toBe('');
    expect(node.style.getPropertyValue('--cyc-msg-frame-max')).toBe('');
  });

  test('applyMessageRootVars is idempotent and standalone', () => {
    const el = document.createElement('div');
    applyMessageRootVars(el);
    expect(el.style.getPropertyValue('--cyc-accent-rgb')).toBe('var(--cyc-bubble-ink-rgb)');
  });
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

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

async function render(
  candidates: string[],
  bodyHtml: string,
  rootStyle = '',
  viewport?: {width: number; height: number}
) {
  const utilities = await compileTailwind(candidates);
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(CHAT, 'chat.css'), 'utf8');
  const html =
    `<!DOCTYPE html><html style="${rootStyle}"><head><meta charset="utf-8">` +
    `<style>${utilities}\n/* un-layered shell + chat */\n${shell}</style></head>` +
    `<body style="margin:0">${bodyHtml}</body></html>`;
  const page = await (await getBrowser()).newPage(viewport ? {viewport} : undefined);
  await page.setContent(html, {waitUntil: 'load'});
  return page;
}

const SLIDE = [
  '[&:not(.active)]:opacity-0',
  '[&:not(.active)]:translate-x-8',
  '[&:not(.active):last-child]:-translate-x-8'
];
const NOCHAT = [
  '[#cyc-stage.cyc-no-thread_&]:[&>:not(.cyc-vacant)]:invisible',
  '[#cyc-stage.cyc-no-thread_&]:[&>:not(.cyc-vacant)_*]:invisible!'
];

describe('cascade: the chat root theme fork resolves per painter selection', () => {
  test('--cyc-bubble-status resolves to the muted text ink in both day and night', async () => {
    const seed = '--cyc-text-muted:rgb(10,20,30)';
    const probe = '<div id="c" style="color:var(--cyc-bubble-status)">x</div>';

    for (const [theme, expected] of [
      ['day', 'rgb(10, 20, 30)'],
      ['night', 'rgb(10, 20, 30)']
    ] as const) {
      setPresentationTheme(theme);
      const chat = mkChat();
      paintChatRoot(chat);
      chat.innerHTML = probe;
      const page = await render(['cyc-thread'], chat.outerHTML, seed);
      try {
        const color = await page.$eval('#c', (el) => getComputedStyle(el).color);
        expect(color, theme).toBe(expected);
      } finally {
        await page.close();
      }
    }
    setPresentationTheme('day');
  });
});

describe('cascade: --cyc-msg-frame-max resolves to the bucket value on the frame', () => {
  const frame = (id: string) =>
    `<div id="${id}" style="width:1000px;max-width:var(--cyc-msg-frame-max);height:4px"></div>`;

  test('laptop clamps the frame to 30rem', async () => {
    const laptop = document.createElement('div');
    paintMessageFrameWidth(laptop);
    laptop.innerHTML = frame('f');
    const page = await render(
      ['cyc-message-list-inner'],
      `<div style="width:600px">${laptop.outerHTML}</div>`
    );
    try {
      const r = await page.$eval('#f', (el) => {
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
        return {w: el.getBoundingClientRect().width, rem};
      });
      expect(r.w).toBeCloseTo(30 * r.rem, 1);
      expect(r.w).toBeLessThan(600);
    } finally {
      await page.close();
    }
  });
});

describe('cascade: message-list pad heights read the padding vars', () => {
  test('pad-top -> chat-padding-top, pad-bottom -> chat-padding-bottom', async () => {
    const chat = mkChat();
    chat.style.setProperty('--cyc-chat-header-height', '88px');
    paintChatRoot(chat);
    chat.innerHTML =
      '<div id="pt" class="cyc-message-list-pad-top h-[var(--cyc-chat-pad-top)]"></div>' +
      '<div id="pb" class="cyc-message-list-pad-bottom h-[var(--cyc-chat-pad-bottom)]"></div>';
    const page = await render(
      ['cyc-thread', 'h-[var(--cyc-chat-pad-top)]', 'h-[var(--cyc-chat-pad-bottom)]'],
      chat.outerHTML,
      // Seed the variables used by the inline calculation.
      '--cyc-pane-gap:8px;--cyc-composer-floor:0px;--cyc-safe-bottom:0px'
    );
    try {
      const h = await page.evaluate(() => ({
        pt: getComputedStyle(document.getElementById('pt')!).height,
        pb: getComputedStyle(document.getElementById('pb')!).height
      }));
      expect(h.pt).toBe('96px'); // 88 + 8 + 0
      expect(h.pb).toBe('56px'); // 3rem(45) + 8 + 0
    } finally {
      await page.close();
    }
  });
});

describe('cascade: the no-chat gate hides the chat behind the empty pill', () => {
  test('direct children and descendants go hidden; the empty pill stays visible', async () => {
    const body =
      '<div id="cyc-stage" class="cyc-no-thread">' +
      `<div class="cyc-thread ${NOCHAT.join(' ')}">` +
      '<div id="row">a<span id="desc">b</span></div>' +
      '<div id="empty" class="cyc-vacant">e</div>' +
      '</div></div>';
    const page = await render([...NOCHAT, 'cyc-thread', 'cyc-no-thread', 'cyc-vacant'], body);
    try {
      const v = await page.evaluate(() => ({
        row: getComputedStyle(document.getElementById('row')!).visibility,
        desc: getComputedStyle(document.getElementById('desc')!).visibility,
        empty: getComputedStyle(document.getElementById('empty')!).visibility
      }));
      expect(v.row).toBe('hidden');
      expect(v.desc).toBe('hidden');
      expect(v.empty).toBe('visible');
    } finally {
      await page.close();
    }
  });
});

describe('cascade: the inactive-chat slide and the scrolling sticky pin', () => {
  test('an inactive chat is transparent and translated; active is neither', async () => {
    const body =
      `<div id="inactive" class="cyc-thread ${SLIDE.join(' ')}"></div>` +
      `<div id="active" class="cyc-thread active ${SLIDE.join(' ')}"></div>`;
    const page = await render([...SLIDE, 'cyc-thread', 'active'], body);
    try {
      const s = await page.evaluate(() => {
        const inactive = getComputedStyle(document.getElementById('inactive')!);
        return {
          io: inactive.opacity,
          it: inactive.translate || inactive.transform,
          ao: getComputedStyle(document.getElementById('active')!).opacity
        };
      });
      expect(s.io).toBe('0');
      expect(s.it).not.toBe('none');
      expect(s.it).not.toBe('');
      expect(s.ao).toBe('1');
    } finally {
      await page.close();
    }
  });

  test('a date chip uses CSS sticky without an opacity pin', async () => {
    const chip = dateMessage('Today');
    chip.id = 'd';
    const page = await render(
      [...chip.classList],
      `<div style="--cyc-chat-pad-top:0px;height:200px;overflow:auto">${chip.outerHTML}</div>`
    );
    try {
      const s = await page.evaluate(() => {
        const el = document.getElementById('d')!;
        const cs = getComputedStyle(el);
        return {pos: cs.position, opacity: cs.opacity};
      });
      expect(s.pos).toBe('sticky');
      expect(s.opacity).toBe('1');
    } finally {
      await page.close();
    }
  });
});
