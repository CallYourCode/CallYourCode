import {afterAll, beforeEach, describe, expect, test, vi} from 'vitest';
vi.hoisted(() => {
  (globalThis as any).indexedDB = {open: () => ({})};
});
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

import type {CycMessage} from '../types';
import {audioMessage} from '../features/chat/messages/audioMessages';
import {attachmentMessage} from '../features/chat/messages/attachmentMessages';
import {textMessage} from '../features/chat/messages/messageContent';
import {
  createComposerBlocks,
  type ComposerBlocksDeps
} from '../features/composer/components/composerBlocks';

// Chromium computed-style coverage for the shared audio play-button skin.

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const CHAT_CSS = resolve(HERE, '..', 'features', 'chat', 'chat.css');
const MEDIA_CSS = resolve(HERE, '..', 'features', 'media', 'media.css');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

// The painted `--cyc-fill-color` is set by the theme paints (not a static sheet);

// probes are deterministic. `--cyc-radius` is the real 6px token.
const ENV = `:root{
  --cyc-fill-color:rgb(50,51,52);
  --cyc-radius:6px;
  --cyc-accent:rgb(1,2,3);
  --cyc-text-muted:rgb(4,5,6);
  --cyc-text-muted-tint:rgb(7,8,9);
}`;

class FakeIO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

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

// Collect every utility class in a subtree so the Tailwind candidate set is exact.
function subtreeCandidates(root: HTMLElement): string[] {
  const all = new Set<string>();
  const add = (n: Element) => tokenize(n.getAttribute('class') || '').forEach((c) => all.add(c));
  add(root);
  root.querySelectorAll('*').forEach(add);
  return [...all];
}

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

async function measure(
  bodyHtml: string,
  candidates: string[],
  probes: Record<string, {selector: string; props: string[]}>,
  sheets = ''
): Promise<Record<string, Record<string, string>>> {
  const utilities = await compileTailwind(candidates);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n${sheets}\n/* pinned vars */\n${ENV}</style></head><body>${bodyHtml}</body></html>`;
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

const msg = (over: Partial<CycMessage> & {msgId?: string}): CycMessage =>
  ({id: 1, role: 'claude', kind: 'voice', text: 'said', ts: 1700000000000, ...over}) as CycMessage;

function makeBlocks(over: Partial<ComposerBlocksDeps> = {}) {
  const composerRows = document.createElement('div');
  const api = createComposerBlocks({
    input: document.createElement('div'),
    composerRows,
    btnAttach: document.createElement('button'),
    isDisabled: () => false,
    setEmpty: vi.fn(),
    applyPlaceholder: vi.fn(),
    ...over
  });
  composerRows.append(api.blocksRow, api.blocksThumb);
  return api;
}

// Drive each of the three lanes and pull its emitted cyc-voice-card subtree.
function chatLane(): HTMLElement {
  return audioMessage(msg({durationS: 3, msgId: 'm1'}), true, true, () => {}).querySelector(
    'cyc-voice-card'
  )!;
}
function attachmentLane(): HTMLElement {
  const m = {
    role: 'user',
    kind: 'text',
    text: '',
    ts: 0,
    uploads: [
      {uploadId: 'a1', name: 'clip.m4a', mime: 'audio/mp4', size: 10, path: 'a1', durationS: 3}
    ]
  } as unknown as CycMessage;
  return attachmentMessage(m, true, true, () => 'http://x/a1').querySelector('cyc-voice-card')!;
}
function composerLane(): HTMLElement {
  const api = makeBlocks();
  api.addVoice({durationS: 3, text: 'hi'});
  return api.blocksRow.querySelector('cyc-voice-card')!;
}

beforeEach(() => {
  (globalThis as unknown as {IntersectionObserver: unknown}).IntersectionObserver = FakeIO;
  (URL as any).createObjectURL = vi.fn(() => 'blob:test');
  (URL as any).revokeObjectURL = vi.fn();
  document.body.innerHTML = '';
});
afterAll(async () => {
  await browser?.close();
});

describe('audio skin single-producer parity: every lane funnels through audioElement()', () => {
  test('chat voice, attachment audio clip and composer held voice emit an identical toggle + wave-box', () => {
    const chat = chatLane();
    const attach = attachmentLane();
    const composer = composerLane();
    const toggle = (el: HTMLElement) => el.querySelector('.cyc-clip-toggle')!.className;
    const wave = (el: HTMLElement) => el.querySelector('.cyc-signal-meter')!.className;
    const parts = (el: HTMLElement) =>
      [...el.querySelectorAll('.cyc-clip-play-part')].map((p) => (p as HTMLElement).className);
    expect(toggle(attach)).toBe(toggle(chat));
    expect(toggle(composer)).toBe(toggle(chat));
    
    // the wave-box. (The wave-box also carries a per-lane seek affordance, which is
    
    for (const el of [chat, attach, composer]) {
      
      // block margin) and the toggle font-size:0 also ride the shared producer, so
      // every lane carries them byte-identically.
      expect(el.className).toContain('whitespace-normal');
      expect(el.className).toContain('[.cyc-one-document_&]:my-2');
      expect(toggle(el)).toContain('text-[0px]');
      // The incoming audio-time !important color variant is on the shared time row.
      expect((el.querySelector('.cyc-clip-time') as HTMLElement).className).toContain(
        '[.cyc-msg-received_&]:text-[color:var(--cyc-text-muted)]!'
      );
      expect(toggle(el)).toContain('bg-[var(--cyc-fill-color)]!');
      expect(toggle(el)).toContain('rounded-[6px]!');
      expect(toggle(el)).toContain('w-10!');
      expect(toggle(el)).toContain('h-10!');
      expect(toggle(el)).toContain('text-white!');
      for (const p of parts(el)) expect(p).toContain('bg-white!');
      const w = wave(el);
      expect(w).toContain('ms-[-0.25rem]!');
      expect(w).toContain('[.is-growing_&]:opacity-[0.55]');
      expect(w).toContain('[.is-growing_&]:cursor-default');
    }
  });
});

describe('audio element does not host the message timestamp', () => {
  test('no .cyc-stamp descendant exists under the cyc-voice-card in any of the three lanes', () => {
    for (const el of [chatLane(), attachmentLane(), composerLane()]) {
      expect(el.matches('.cyc-clip')).toBe(true);
      expect(el.querySelector('.cyc-stamp')).toBeNull();
    }
  });
});

describe('audio skin cascade', () => {
  test('cyc-voice-card root: white-space resets to normal under a pre-wrap ancestor', async () => {
    const el = chatLane();
    const styles = await measure(
      `<div style="white-space:pre-wrap"><cyc-voice-card id="a" class="${el.className}"></cyc-voice-card></div>`,
      tokenize(el.className),
      {a: {selector: '#a', props: ['white-space']}}
    );
    expect(styles.a['white-space']).toBe('normal');
  });

  test('cyc-voice-card root: an .cyc-one-document ancestor applies my-2 (0.5rem) block margins', async () => {
    const el = chatLane();
    const styles = await measure(
      `<div class="cyc-one-document"><cyc-voice-card id="a" class="${el.className}"></cyc-voice-card></div>`,
      tokenize(el.className),
      {
        a: {selector: '#a', props: ['margin-top', 'margin-bottom']},
        root: {selector: ':root', props: ['font-size']}
      }
    );
    const rem = parseFloat(styles.root['font-size']);
    expect(parseFloat(styles.a['margin-top'])).toBeCloseTo(0.5 * rem, 1);
    expect(parseFloat(styles.a['margin-bottom'])).toBeCloseTo(0.5 * rem, 1);
  });

  test('toggle: font-size collapses to 0px from text-[0px]', async () => {
    const el = chatLane();
    const toggle = el.querySelector<HTMLElement>('.cyc-clip-toggle')!;
    const styles = await measure(
      `<div id="t" class="${toggle.className}"></div>`,
      tokenize(toggle.className),
      {t: {selector: '#t', props: ['font-size']}}
    );
    expect(styles.t['font-size']).toBe('0px');
  });

  test('audio-time: the cyc-msg-received incoming variant paints --cyc-text-muted and its !important beats a competitor', async () => {
    const el = chatLane();
    const time = el.querySelector<HTMLElement>('.cyc-clip-time')!;
    const styles = await measure(
      `<div class="cyc-msg-received"><div id="t" class="${time.className}"></div></div>`,
      tokenize(time.className),
      {t: {selector: '#t', props: ['color']}},
      // Higher-specificity non-important competitor: the important variant wins.
      `#t{color:rgb(200,200,200)}`
    );
    expect(styles.t.color).toBe('rgb(4, 5, 6)');
  });

  test('toggle pill: 2.5rem square, 6px radius, fill background, white ink', async () => {
    const el = chatLane();
    const toggle = el.querySelector<HTMLElement>('.cyc-clip-toggle')!;
    const candidates = tokenize(toggle.className);
    const styles = await measure(
      `<div class="cyc-clip cyc-voice"><div id="t" class="${toggle.className}"></div></div>`,
      candidates,
      {
        t: {
          selector: '#t',
          props: ['width', 'height', 'border-top-left-radius', 'background-color', 'color']
        },
        root: {selector: ':root', props: ['font-size']}
      }
    );
    const rem = parseFloat(styles.root['font-size']);
    expect(parseFloat(styles.t.width)).toBeCloseTo(2.5 * rem, 1);
    expect(parseFloat(styles.t.height)).toBeCloseTo(2.5 * rem, 1);
    expect(styles.t['border-top-left-radius']).toBe('6px');
    expect(styles.t['background-color']).toBe('rgb(50, 51, 52)');
    expect(styles.t.color).toBe('rgb(255, 255, 255)');
  });

  test('wave-box inset: margin-inline-start -0.25rem', async () => {
    const el = chatLane();
    const wave = el.querySelector<HTMLElement>('.cyc-signal-meter')!;
    const styles = await measure(
      `<div id="w" class="${wave.className}"></div>`,
      tokenize(wave.className),
      {
        w: {selector: '#w', props: ['margin-inline-start']},
        root: {selector: ':root', props: ['font-size']}
      }
    );
    const rem = parseFloat(styles.root['font-size']);
    expect(parseFloat(styles.w['margin-inline-start'])).toBeCloseTo(-0.25 * rem, 1);
  });

  test('loading state: the play glyph fades to opacity 0 under .cyc-pending, else 1', async () => {
    const el = chatLane();
    const toggle = el.querySelector<HTMLElement>('.cyc-clip-toggle')!;
    const play = el.querySelector<HTMLElement>('.cyc-clip-play')!;
    const candidates = [...tokenize(toggle.className), ...tokenize(play.className)];
    const styles = await measure(
      `<div id="on" class="${toggle.className} cyc-pending"><div id="playon" class="${play.className}"></div></div>` +
        `<div id="off" class="${toggle.className}"><div id="playoff" class="${play.className}"></div></div>`,
      candidates,
      {
        on: {selector: '#playon', props: ['opacity']},
        off: {selector: '#playoff', props: ['opacity']}
      }
    );
    expect(styles.on.opacity).toBe('0');
    expect(styles.off.opacity).toBe('1');
  });

  test('wait state: .cyc-clip-wait drives the cyc-clip-wait animation', async () => {
    const el = chatLane();
    const toggle = el.querySelector<HTMLElement>('.cyc-clip-toggle')!;
    const styles = await measure(
      `<div id="t" class="${toggle.className} cyc-clip-wait"></div>`,
      tokenize(toggle.className),
      {t: {selector: '#t', props: ['animation-name', 'animation-duration']}}
    );
    expect(styles.t['animation-name']).toBe('cyc-clip-wait');
    expect(styles.t['animation-duration']).toBe('0.9s');
  });

  test('growing state: .cyc-clip.is-growing pulses the toggle and dims the wave-box, both default-cursor', async () => {
    const el = chatLane();
    const toggle = el.querySelector<HTMLElement>('.cyc-clip-toggle')!;
    const wave = el.querySelector<HTMLElement>('.cyc-signal-meter')!;
    const candidates = [...tokenize(toggle.className), ...tokenize(wave.className)];
    const styles = await measure(
      `<div class="cyc-clip cyc-voice is-growing">` +
        `<div id="t" class="${toggle.className}"></div>` +
        `<div id="w" class="${wave.className}"></div></div>`,
      candidates,
      {
        t: {selector: '#t', props: ['animation-name', 'animation-duration', 'cursor']},
        w: {selector: '#w', props: ['opacity', 'cursor']}
      }
    );
    expect(styles.t['animation-name']).toBe('cyc-grow-pulse');
    expect(styles.t['animation-duration']).toBe('1.4s');
    expect(styles.t.cursor).toBe('default');
    expect(styles.w.opacity).toBe('0.55');
    expect(styles.w.cursor).toBe('default');
  });

  // The real un-layered chat.css + media.css, in main.ts import order (chat before
  // media). chat.css:207 `.cyc-message .cyc-clip .cyc-clip-toggle .cyc-clip-play-
  // part {background-color:var(--cyc-bubble-glyph)}` (0,4,0) beats media.css's
  // `.cyc-clip-toggle .cyc-clip-play-part {background-color:white}` (0,2,0). Only
  
  const FULL_SHEETS = `/* chat.css */\n${readFileSync(CHAT_CSS, 'utf8')}\n/* media.css */\n${readFileSync(MEDIA_CSS, 'utf8')}`;

  // Emit the real shared producer, mutate its live subtree, wrap it in the night-
  // mode outgoing `.cyc-message.cyc-msg-sent` context (--cyc-bubble-glyph pinned to
  // the out-bubble background rgb(9,9,9), as chatRootPaint resolves it in night out),
  // then probe both glyph parts' fill over the full sheet stack.
  async function playPartFill(opts: {playing: boolean; whiteInk: boolean}) {
    const el = chatLane();
    if (opts.playing) el.querySelector('.cyc-clip-toggle')!.classList.add('playing');
    if (!opts.whiteInk)
      el.querySelectorAll('.cyc-clip-play-part').forEach((p) => p.classList.remove('bg-white!'));
    const candidates = subtreeCandidates(el);
    const html = `<div class="cyc-message cyc-msg-sent" style="--cyc-bubble-glyph:rgb(9,9,9)">${el.outerHTML}</div>`;
    return measure(
      html,
      candidates,
      {
        one: {selector: '.cyc-clip-play-part.is-one', props: ['background-color']},
        two: {selector: '.cyc-clip-play-part.is-two', props: ['background-color']}
      },
      FULL_SHEETS
    );
  }

  test('play-part fill, night outgoing over full chat.css+media.css: #fff before (play) and after (pause playing)', async () => {
    // AFTER the drain fix: the producer bg-white! (important) beats chat.css:207, so
    // both the play-triangle and the pause-bars glyph stay white in night-mode out --
    // proven for the play state and the .playing (pause) state.
    const play = await playPartFill({playing: false, whiteInk: true});
    expect(play.one['background-color']).toBe('rgb(255, 255, 255)');
    expect(play.two['background-color']).toBe('rgb(255, 255, 255)');
    const pause = await playPartFill({playing: true, whiteInk: true});
    expect(pause.one['background-color']).toBe('rgb(255, 255, 255)');
    expect(pause.two['background-color']).toBe('rgb(255, 255, 255)');
  });

  test('play-part fill regression guard: without the producer bg-white!, chat.css:207 wins night out (out-bg, not white)', async () => {
    const stripped = await playPartFill({playing: false, whiteInk: false});
    expect(stripped.one['background-color']).toBe('rgb(9, 9, 9)');
    expect(stripped.two['background-color']).toBe('rgb(9, 9, 9)');
  });

  test('cyc-msg-play loading: transparent ink and relative under .cyc-pending', async () => {
    const play = textMessage(
      msg({role: 'claude', kind: 'text', text: 'hi', msgId: 'm2'}),
      true,
      true,
      () => {}
    ).querySelector<HTMLButtonElement>('.cyc-msg-play')!;
    const styles = await measure(
      `<button id="p" class="${play.className} cyc-pending"></button>`,
      tokenize(play.className),
      {p: {selector: '#p', props: ['color', 'position']}}
    );
    expect(styles.p.color).toBe('rgba(0, 0, 0, 0)');
    expect(styles.p.position).toBe('relative');
  });
});
