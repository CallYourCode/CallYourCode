// Chromium computed-style coverage for chat document, snippet, and multipart-cap rows.

import {afterAll, afterEach, beforeEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

import type {CycMessage} from '../types';
import {fileMessage, snippetMessage} from '../features/chat/messages/fileMessages';
import {uploadMessage, attachmentMessage} from '../features/chat/messages/attachmentMessages';
import {audioMessage} from '../features/chat/messages/audioMessages';
import {textMessage} from '../features/chat/messages/messageContent';
import {DOC_SIZE_UTILS} from '../features/media/mediaBox';
import {installPresentationReactivity, currentPresentation} from '../components/presentation';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const SHELL = resolve(SRC, 'shell');
const CHAT = resolve(SRC, 'features', 'chat');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

class FakeIO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const msg = (over: Partial<CycMessage>): CycMessage =>
  ({id: 1, role: 'claude', kind: 'text', text: 'hi', ts: 1700000000000, ...over}) as CycMessage;

const fileMsg = (over: Partial<CycMessage['file']> = {}, text = 'here is the file') =>
  msg({
    text,
    file: {docId: 'd', name: 'runbook.txt', size: 4096, fileKind: 'text', ...over}
  } as Partial<CycMessage>);

const uploadMsg = () =>
  msg({
    role: 'user',
    text: 'a caption',
    upload: {
      uploadId: 'u1',
      name: 'notes.pdf',
      mime: 'application/pdf',
      size: 4096,
      path: 'u1',
      image: false
    }
  } as Partial<CycMessage>);

// A multipart voice message with an anchored transcript so the `.cyc-multipart-cap`
// producer emits (slot text != '' -> the voice card + caption paragraph are built).
const voiceMultipart = () =>
  ({
    id: 1,
    role: 'user',
    kind: 'text',
    text: 'hello there',
    ts: 1,
    uploads: [
      {
        uploadId: 'a1',
        name: 'clip.m4a',
        mime: 'audio/mp4',
        size: 10,
        path: 'a1',
        image: false,
        durationS: 3,
        at: 0,
        textLen: 11
      }
    ]
  }) as unknown as CycMessage;

// Run `fn` with window.innerWidth pinned and the presentation snapshot adopted to that
// geometry (installPresentationReactivity refreshes the buckets on install).
const withWidth = (px: number, fn: () => void) => {
  const desc = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  Object.defineProperty(window, 'innerWidth', {value: px, configurable: true});
  const teardown = installPresentationReactivity();
  try {
    fn();
  } finally {
    teardown();
    if (desc) Object.defineProperty(window, 'innerWidth', desc);
  }
};

beforeEach(() => {
  (globalThis as unknown as {IntersectionObserver: unknown}).IntersectionObserver = FakeIO;
  (URL as unknown as {createObjectURL: () => string}).createObjectURL = () => 'blob:test';
  (URL as unknown as {revokeObjectURL: () => void}).revokeObjectURL = () => {};
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

// paintSnippetCodeMobile owns the 550px phone edge.

describe('paintSnippetCodeMobile toggles cyc-snippet-mobile at the exact 550px edge', () => {
  for (const [px, mobile, bucket] of [
    [549, true, 'phone'],
    [550, true, 'phone'],
    [550.5, false, 'tablet'],
    [551, false, 'tablet']
  ] as const) {
    test(`${px}px -> mobile ${mobile} on every snippet-code producer`, () => {
      withWidth(px, () => {
        expect(currentPresentation().width).toBe(bucket);
        const plain = snippetMessage(
          msg({
            text: '',
            file: {docId: 'd', name: 's.txt', size: 1, fileKind: 'text', content: 'x'}
          } as Partial<CycMessage>),
          true,
          true
        );
        const md = snippetMessage(
          msg({
            text: '',
            file: {docId: 'd', name: 's.md', size: 1, fileKind: 'markdown', content: '```\nx\n```'}
          } as Partial<CycMessage>),
          true,
          true
        );
        const diff = snippetMessage(
          msg({
            text: '',
            file: {docId: 'd', name: 's.diff', size: 1, fileKind: 'diff', content: '+a\n-b'}
          } as Partial<CycMessage>),
          true,
          true
        );
        for (const node of [plain, md, diff]) {
          const pre = node.querySelector<HTMLElement>('.cyc-snippet-code')!;
          expect(pre.classList.contains('cyc-snippet-mobile')).toBe(mobile);
        }
      });
    });
  }

  test('lifecycle: a mounted pre repaints across the edge, a detached one is pruned', () => {
    const el = document.createElement('pre');
    document.body.append(el);
    // Register through a real producer whose pre we then track directly.
    const node = snippetMessage(
      msg({
        text: '',
        file: {docId: 'd', name: 's.txt', size: 1, fileKind: 'text', content: 'x'}
      } as Partial<CycMessage>),
      true,
      true
    );
    const pre = node.querySelector<HTMLElement>('.cyc-snippet-code')!;
    document.body.append(pre);
    withWidth(551, () => {
      expect(pre.classList.contains('cyc-snippet-mobile')).toBe(false);
    });
    // Connected: crossing into the phone bucket repaints live.
    withWidth(549, () => {
      expect(pre.classList.contains('cyc-snippet-mobile')).toBe(true);
    });
    // Detached: the painter is pruned on the next notify and the marker goes stale.
    pre.remove();
    withWidth(551, () => {
      expect(pre.classList.contains('cyc-snippet-mobile')).toBe(true);
    });
    el.remove();
  });
});



const ENV = `
:root{
  --cyc-text-muted:rgb(90,91,92);
  --cyc-bubble-status:rgb(70,71,72);
  --cyc-text-muted-tint:rgb(230,231,232);
  --cyc-accent:rgb(10,120,200);
  --cyc-msg-frame-max:600px;
}
`;

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

const allClasses = (root: HTMLElement): string[] => {
  const out = new Set<string>();
  // classList (not className) so SVG / custom-element nodes in the doc/tail subtree
  // don't blow up on their non-string className.
  for (const el of [root, ...root.querySelectorAll<Element>('*')]) {
    for (const c of el.classList) out.add(c);
  }
  return [...out];
};

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

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
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(CHAT, 'chat.css'), 'utf8') +
    '\n' +
    ENV;
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<style>${utilities}\n/* un-layered shell + chat */\n${shell}</style></head>` +
    `<body style="margin:0">${bodyHtml}</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(
      ({probes}) => {
        const out: Record<string, Record<string, string>> = {};
        for (const [key, {selector, props}] of Object.entries(probes)) {
          const el = document.querySelector(selector);
          if (!el) throw new Error(`probe ${key}: ${selector} matched nothing`);
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

describe('chat-doc geometry resolves on the real producers in Chromium', () => {
  test('fileMessage doc: 3rem row / 0.75rem icon-margin / my 0.5rem; name + caption top', async () => {
    const node = fileMessage(fileMsg(), true, true, () => {});
    node.id = 'root';
    const doc = node.querySelector<HTMLElement>('.cyc-doc')!;
    doc.id = 'doc';
    node.querySelector<HTMLElement>('.cyc-message-frame')!.id = 'frame';
    node.querySelector<HTMLElement>('.cyc-doc-name')!.id = 'name';
    node.querySelector<HTMLElement>('.cyc-doc-size')!.id = 'size';
    node.querySelector<HTMLElement>('.cyc-doc-wrap .cyc-doc-message')!.id = 'cap';
    const s = await measure(node.outerHTML, allClasses(node), {
      frame: {selector: '#frame', props: ['max-width']},
      doc: {
        selector: '#doc',
        props: ['height', 'padding-inline-start', 'margin-top', 'margin-bottom']
      },
      name: {selector: '#name', props: ['font-size', 'line-height', 'margin-top']},
      size: {selector: '#size', props: ['font-size']},
      cap: {selector: '#cap', props: ['margin-top']}
    });
    expect(s.frame['max-width']).toBe('600px');
    expect(s.doc.height).toBe('48px');
    expect(s.doc['padding-inline-start']).toBe('60px');
    expect(s.doc['margin-top']).toBe('8px');
    expect(s.doc['margin-bottom']).toBe('8px');
    expect(s.name['font-size']).toBe('14px');
    expect(s.name['line-height']).toBe('19.6px');
    expect(s.name['margin-top']).toBe('1px');
    expect(s.size['font-size']).toBe('14px');
    expect(s.cap['margin-top']).toBe('-2px');
  });

  test('uploadMessage + downloadMessage-shaped rows carry the same final doc geometry', async () => {
    const node = uploadMessage(uploadMsg(), true, true, 'blob:x', () => {});
    node.id = 'root';
    node.querySelector<HTMLElement>('.cyc-doc')!.id = 'doc';
    node.querySelector<HTMLElement>('.cyc-message-frame')!.id = 'frame';
    node.querySelector<HTMLElement>('.cyc-doc-wrap .cyc-doc-message')!.id = 'cap';
    const s = await measure(node.outerHTML, allClasses(node), {
      frame: {selector: '#frame', props: ['max-width']},
      doc: {selector: '#doc', props: ['height', 'padding-inline-start', 'margin-top']},
      cap: {selector: '#cap', props: ['margin-top']}
    });
    expect(s.frame['max-width']).toBe('600px');
    expect(s.doc.height).toBe('48px');
    expect(s.doc['padding-inline-start']).toBe('60px');
    expect(s.doc['margin-top']).toBe('8px');
    expect(s.cap['margin-top']).toBe('-2px');
  });
});

describe('doc-size forks by ancestry -- chat 14px, profile keeps the base size', () => {
  test('the shared DOC_SIZE_UTILS resolves 14px inside .cyc-message, base outside it', async () => {
    // Chat context (inside .cyc-message): the `.cyc-message`-scoped variant wins.
    const chat = `<div class="cyc-message"><div id="chat" class="cyc-doc-size ${DOC_SIZE_UTILS}">1 KB</div></div>`;
    // Profile context (outside .cyc-message, as profile rows live): base survives.
    const profile = `<div id="prof" class="cyc-doc-size ${DOC_SIZE_UTILS}">1 KB</div>`;
    const candidates = allClasses(
      Object.assign(document.createElement('div'), {innerHTML: chat + profile})
    );
    const s = await measure(chat + profile, candidates, {
      chat: {selector: '#chat', props: ['font-size']},
      prof: {selector: '#prof', props: ['font-size']}
    });
    expect(s.chat['font-size']).toBe('14px'); // cyc-message-minor-size
    expect(s.prof['font-size']).toBe('14px'); // 0.875rem @ 16px root
  });
});

describe('snippet ink and mobile shrink resolve per state in Chromium', () => {
  test('a done snippet task paints the secondary-text ink', async () => {
    const node = snippetMessage(
      msg({
        text: '',
        file: {docId: 'd', name: 's.md', size: 1, fileKind: 'markdown', content: '- [x] shipped'}
      } as Partial<CycMessage>),
      true,
      true
    );
    const task = node.querySelector<HTMLElement>('.cyc-snippet-task.is-done')!;
    task.id = 'task';
    const s = await measure(node.outerHTML, allClasses(node), {
      task: {selector: '#task', props: ['color']}
    });
    // Inside .cyc-message, applyMessageRootVars remaps --cyc-text-muted to
    // --cyc-bubble-status, which resolves to the same colour.
    expect(s.task.color).toBe('rgb(70, 71, 72)');
  });

  for (const [px, size, height] of [
    [549, '12px', '15px'], // phone: 0.75rem / 1.25
    [551, '13px', '16.9px'] // tablet: 0.8125rem / 1.3
  ] as const) {
    test(`snippet-code at ${px}px -> ${size} / ${height} line-height`, async () => {
      let node!: HTMLDivElement;
      withWidth(px, () => {
        node = snippetMessage(
          msg({
            text: '',
            file: {docId: 'd', name: 's.txt', size: 1, fileKind: 'text', content: 'const x = 1;'}
          } as Partial<CycMessage>),
          true,
          true
        );
      });
      const pre = node.querySelector<HTMLElement>('.cyc-snippet-code')!;
      pre.id = 'pre';
      const s = await measure(node.outerHTML, allClasses(node), {
        pre: {selector: '#pre', props: ['font-size', 'line-height']}
      });
      expect(s.pre['font-size']).toBe(size);
      expect(s.pre['line-height']).toBe(height);
    });
  }
});

describe('the multipart cap is producer-owned while the transcript rule stays authored', () => {
  test('the voice caption carries the current font/line-height/opacity/top', async () => {
    const node = attachmentMessage(voiceMultipart(), true, true, () => 'blob:a1');
    const cap = node.querySelector<HTMLElement>('.cyc-multipart-cap')!;
    cap.id = 'cap';
    const s = await measure(node.outerHTML, allClasses(node), {
      cap: {
        selector: '#cap',
        props: ['font-size', 'line-height', 'opacity', 'margin-top', 'white-space']
      }
    });
    expect(s.cap['font-size']).toBe('15px'); // 0.9375rem @ 16px root
    expect(s.cap['line-height']).toBe('19.5px'); // 1.3 * 14.0625 (Chromium 4dp)
    expect(s.cap.opacity).toBe('0.9');
    expect(s.cap['margin-top']).toBe('6px'); // 0.375rem @ 16px root
    expect(s.cap['white-space']).toBe('pre-wrap');
  });

  test('a retained .cyc-transcript element still gets the un-layered chat.css skin', async () => {
    const html = `<div id="t" class="cyc-transcript">said</div>`;
    const s = await measure(html, [], {
      t: {selector: '#t', props: ['font-size', 'line-height', 'opacity', 'margin-top']}
    });
    expect(s.t['font-size']).toBe('15px'); // 0.9375rem @ 16px root
    expect(s.t.opacity).toBe('0.9');
    expect(s.t['margin-top']).toBe('6px');
  });
});

describe('a voice-clip frame fills the reading column while short text shrink-wraps', () => {
  test('sent + received voice frames pin width to --cyc-msg-frame-max; short text does not', async () => {
    // Sent (user) and received (claude) short-text voice clips: the `:has()` rule
    // must fill both, without changing the shared 600px cap.
    const sent = audioMessage(
      msg({role: 'user', kind: 'voice', durationS: 7, text: 'Hi'}),
      true,
      true,
      () => {}
    );
    sent.querySelector<HTMLElement>('.cyc-message-frame')!.id = 'vsent';
    sent.querySelector<HTMLElement>('.cyc-message-content')!.id = 'vsentbubble';
    const recv = audioMessage(
      msg({role: 'claude', kind: 'voice', durationS: 7, text: 'Hi'}),
      true,
      true,
      () => {}
    );
    recv.querySelector<HTMLElement>('.cyc-message-frame')!.id = 'vrecv';
    recv.querySelector<HTMLElement>('.cyc-message-content')!.id = 'vrecvbubble';
    // A plain short text message keeps shrink-wrapping: only the cap is 600px.
    const text = textMessage(msg({text: 'Hi'}), true, true);
    text.querySelector<HTMLElement>('.cyc-message-frame')!.id = 'tframe';
    text.querySelector<HTMLElement>('.cyc-message-content')!.id = 'tbubble';

    const wrap = document.createElement('div');
    wrap.append(sent, recv, text);
    const s = await measure(wrap.innerHTML, allClasses(wrap), {
      vsent: {selector: '#vsent', props: ['width', 'max-width']},
      vrecv: {selector: '#vrecv', props: ['width', 'max-width']},
      vsentbubble: {selector: '#vsentbubble', props: ['width']},
      vrecvbubble: {selector: '#vrecvbubble', props: ['width']},
      tframe: {selector: '#tframe', props: ['width', 'max-width']},
      tbubble: {selector: '#tbubble', props: ['width']}
    });
    expect(s.vsent.width).toBe('600px');
    expect(s.vsent['max-width']).toBe('600px');
    expect(s.vrecv.width).toBe('600px');
    expect(s.vrecv['max-width']).toBe('600px');
    // Both bubbles fill the frame so the waveform spans the reading column -- the
    // outgoing (ml-auto) bubble too, which the frame rule alone leaves shrink-wrapped.
    expect(s.vsentbubble.width).toBe('600px');
    expect(s.vrecvbubble.width).toBe('600px');
    // The difference is `width`, not the cap: the text frame shares the 600px
    // max-width but shrink-wraps -- frame and bubble both stay well under it.
    expect(s.tframe['max-width']).toBe('600px');
    expect(parseFloat(s.tframe.width)).toBeLessThan(600);
    expect(parseFloat(s.tbubble.width)).toBeLessThan(600);
  });
});
