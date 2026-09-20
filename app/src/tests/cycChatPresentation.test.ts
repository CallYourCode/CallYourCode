import {afterAll, beforeEach, afterEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

import type {CycMessage, CycSession, CycSessionEvent} from '../types';
import {setFormatted, tableFrom} from '../features/chat/content';
import {
  textMessage,
  replyPanel,
  MESSAGE_TEXT_UTILS,
  MESSAGE_CONTENT_UTILS,
  SERVICE_MSG_UTILS
} from '../features/chat/messages/messageContent';
import type {CycReplyTo} from '../types';
import {fileMessage, snippetMessage} from '../features/chat/messages/fileMessages';
import {audioMessage} from '../features/chat/messages/audioMessages';
import {sessionEventMessage, dateMessage} from '../features/chat/messages/sessionEventMessages';
import {renderMessages, clearMessages} from '../features/chat/surface/messageList';
import {
  setPresentationTheme,
  installPresentationReactivity,
  currentPresentation
} from '../components/presentation';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const CHAT = resolve(HERE, '..', 'features', 'chat');
const CODE = resolve(HERE, '..', 'features', 'code');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

class FakeIO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  (globalThis as unknown as {IntersectionObserver: unknown}).IntersectionObserver = FakeIO;
  document.body.innerHTML = '';
  setPresentationTheme('day');
});
afterEach(() => {
  document.body.innerHTML = '';
});

const msg = (over: Partial<CycMessage>): CycMessage =>
  ({id: 1, role: 'claude', kind: 'text', text: 'hi', ts: 1700000000000, ...over}) as CycMessage;

describe('message body geometry is painted on the producer', () => {
  test('text body carries the shared util + its own 14px, other bodies 14px', () => {
    const text = textMessage(msg({role: 'claude', text: 'hello'}), true, true).querySelector(
      '.cyc-message-text'
    )!;
    for (const token of MESSAGE_TEXT_UTILS.split(/\s+/)) {
      expect(text.classList.contains(token)).toBe(true);
    }
    expect(text.classList.contains('text-[14px]')).toBe(true);
    expect(text.classList.contains('text-[length:14px]')).toBe(false);

    const file = fileMessage(
      msg({
        file: {docId: 'd', name: 'runbook.txt', size: 12, fileKind: 'text'}
      } as Partial<CycMessage>),
      true,
      true
    ).querySelector('.cyc-message-text')!;
    expect(file.classList.contains('text-[length:14px]')).toBe(true);
    expect(file.classList.contains('text-[14px]')).toBe(false);

    const snip = snippetMessage(
      msg({
        text: '',
        file: {docId: 'd', name: 's.md', size: 1, fileKind: 'markdown', inline: true, content: 'x'}
      } as Partial<CycMessage>),
      true,
      true
    ).querySelector('.cyc-message-text')!;
    expect(snip.classList.contains('pb-1')).toBe(true);

    const audio = audioMessage(
      msg({kind: 'voice', text: 'said'}),
      true,
      true,
      () => {}
    ).querySelector('.cyc-message-text')!;
    expect(audio.classList.contains('text-[length:14px]')).toBe(true);
  });

  test('the group-last row gets the wider bottom gap, others the base gap', () => {
    expect(textMessage(msg({}), true, true).classList.contains('mb-2')).toBe(true);
    expect(textMessage(msg({}), true, true).classList.contains('mb-1')).toBe(false);
    expect(textMessage(msg({}), true, false).classList.contains('mb-1')).toBe(true);
    expect(textMessage(msg({}), true, false).classList.contains('mb-2')).toBe(false);
  });

  // 2026-09-02: the stamp floats at the inline end of the body (it was an inline
  // baseline span, which trailed the text wherever the last line ended and could
  // wrap to the left edge). The body clears it with a generated ::after, not a
  // `.cyc-clear` node.
  test('the flowing stamp floats to the inline end of the last line', () => {
    const stamp = textMessage(msg({}), true, true).querySelector('.cyc-stamp-flow')!;
    expect(stamp.classList.contains('float-end')).toBe(true);
    expect(stamp.classList.contains('align-baseline')).toBe(false);
    expect(textMessage(msg({}), true, true).querySelector('.cyc-clear')).toBeNull();
  });

  test('inline monospace carries the current pointer cursor', () => {
    const box = document.createElement('div');
    setFormatted(box, 'run `npm test` now');
    const code = box.querySelector('code.cyc-inline-code')!;
    expect(code.classList.contains('cursor-pointer')).toBe(true);
  });

  test('a refused send paints the engine reason in red under the text, as a retry tap', () => {
    const node = textMessage(
      msg({
        role: 'user',
        text: 'hello',
        status: 'failed',
        failReason: 'the engine has no such session'
      }),
      true,
      true
    );
    const note = node.querySelector<HTMLButtonElement>('button.cyc-send-failed')!;
    expect(note).not.toBeNull();
    expect(note.textContent).toBe(
      'not delivered: the engine has no such session. Tap to try again'
    );
    expect(note.classList.contains('text-[color:var(--cyc-danger)]')).toBe(true);
    expect(note.querySelector('.cyc-icon svg')).not.toBeNull();
    // The note sits with the text, before the flowing stamp.
    const text = node.querySelector('.cyc-message-text')!;
    expect(text.contains(note)).toBe(true);
    expect(
      note.compareDocumentPosition(text.querySelector('.cyc-stamp-flow')!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  test('a refused send without a reason still says not delivered; other rows carry no note', () => {
    const bare = textMessage(msg({role: 'user', text: 'hello', status: 'failed'}), true, true);
    expect(bare.querySelector('.cyc-send-failed')!.textContent).toBe(
      'not delivered. Tap to try again'
    );
    expect(
      textMessage(msg({role: 'user', text: 'hello', status: 'sending'}), true, true).querySelector(
        '.cyc-send-failed'
      )
    ).toBeNull();
    expect(
      textMessage(msg({role: 'user', text: 'hello', status: 'sent'}), true, true).querySelector(
        '.cyc-send-failed'
      )
    ).toBeNull();
    expect(
      textMessage(msg({role: 'claude', text: 'hello', status: 'failed'}), true, true).querySelector(
        '.cyc-send-failed'
      )
    ).toBeNull();
  });
});

describe('service and session-event chrome is painted on the producer', () => {
  test('date and session-event rows center; content drops fill/shadow', () => {
    const date = dateMessage('Today');
    for (const token of SERVICE_MSG_UTILS.split(/\s+/)) {
      expect(date.classList.contains(token)).toBe(true);
    }
    expect(date.classList.contains('max-w-[var(--cyc-chat-width)]')).toBe(true);
    const dateContent = date.querySelector('.cyc-message-content')!;
    expect(dateContent.classList.contains('bg-transparent!')).toBe(true);
    expect(dateContent.classList.contains('shadow-none!')).toBe(true);
    expect(dateContent.classList.contains('mx-auto')).toBe(true);

    const ev: CycSessionEvent = {uuid: 'u1', ts: 1, kind: 'reply', text: 'thinking'};
    const se = sessionEventMessage(ev);
    expect(se.style.maxWidth).toBe('calc(100% - 4rem)');
    for (const token of SERVICE_MSG_UTILS.split(/\s+/)) {
      expect(se.classList.contains(token)).toBe(true);
    }
  });

  test('the empty-chat pill is a centered service row', () => {
    const inner = document.createElement('div');
    const session = {id: 's', name: 'x', messages: [], unread: 0} as unknown as CycSession;
    renderMessages(inner, session, () => {});
    const pill = inner.querySelector('.cyc-vacant-chat .cyc-message.cyc-msg-system')!;
    expect(pill.classList.contains('self-center')).toBe(true);
    expect(pill.classList.contains('max-w-[var(--cyc-chat-width)]')).toBe(true);
    const content = pill.querySelector('.cyc-message-content')!;
    expect(content.classList.contains('bg-transparent!')).toBe(true);
    clearMessages(inner);
  });
});

describe('reply-panel geometry is painted on the producer', () => {
  const reply: CycReplyTo = {ts: 1, role: 'claude', title: 'Ada', text: 'earlier line'};

  test('the reply container carries the message-scoped geometry + cursor', () => {
    const panel = textMessage(
      msg({role: 'claude', text: 'hi', replyTo: reply}),
      true,
      true
    ).querySelector('.cyc-reply')!;
    for (const t of ['cursor-pointer', '[.cyc-message_&]:m-2']) {
      expect(panel.classList.contains(t)).toBe(true);
    }
    expect(panel.classList.contains('cyc-quote-hoverable')).toBe(false);
    expect(panel.classList.contains('[.cyc-message_&]:[--font-size:14px]')).toBe(false);
    const title = panel.querySelector('.cyc-reply-title')!;
    expect(title.classList.contains('text-[rgb(var(--cyc-sender-rgb))]')).toBe(true);
    expect(title.classList.contains('text-[var(--cyc-accent)]')).toBe(false);
    expect(title.classList.contains('[.cyc-msg-received_&]:text-[var(--cyc-accent)]')).toBe(false);
  });

  test('the quote excerpt path keeps the retained multiline/icon state and padding', () => {
    const panel = textMessage(
      msg({role: 'claude', text: 'hi', replyTo: {...reply, quote: true}}),
      true,
      true
    ).querySelector('.cyc-reply')!;
    expect(panel.classList.contains('cyc-callout-marked')).toBe(true);
    expect(panel.classList.contains('cyc-multiline')).toBe(true);
    const content = panel.querySelector('.cyc-reply-content')!;
    for (const t of ['ms-3', 'py-1', 'pe-2']) expect(content.classList.contains(t)).toBe(true);
    const subtitle = panel.querySelector('.cyc-reply-subtitle')!;
    expect(subtitle.classList.contains('[.cyc-multiline_&]:[white-space:unset]')).toBe(true);
  });

  test('the composer preview reuses the same producer classes', () => {
    const panel = replyPanel(reply, true);
    expect(panel.classList.contains('cursor-pointer')).toBe(true);
    expect(panel.classList.contains('[.cyc-message_&]:m-2')).toBe(true);
  });
});

describe('date chips stick without a sentinel clone', () => {
  test('dateMessage is CSS-sticky on the real node', () => {
    const node = dateMessage('Today');
    expect(node.classList.contains('cyc-date-chip')).toBe(true);
    expect(node.classList.contains('sticky')).toBe(true);
    expect(node.querySelector('.cyc-sticky-sentinel-top')).toBeNull();
  });
});

describe('markdown table geometry is painted on the producer', () => {
  const src = ['Name | Value', '--- | ---', 'Ada | x'];
  const CELL_TOKENS = [
    '[.cyc-message_.cyc-overflower_&]:max-w-[18rem]!',
    'max-[550px]:[.cyc-message_.cyc-overflower_.cyc-snippet-table_&]:max-w-[14rem]!',
    '[.cyc-message_&]:px-2.5!',
    '[.cyc-message_&]:py-1.5!',
    'max-[550px]:[.cyc-message_.cyc-snippet-table_&]:px-2!',
    'max-[550px]:[.cyc-message_.cyc-snippet-table_&]:py-1!',
    '[.cyc-message_&]:[border:1px_solid_var(--cyc-border-color)]',
    '[.cyc-message_&]:align-top',
    '[.cyc-message_&]:[overflow-wrap:anywhere]',
    '[.cyc-message_&]:text-start'
  ];

  test('box/bar/wrap/table carry the message-scoped snippet-table utilities', () => {
    const box = tableFrom(src, 0)!.el;
    expect(box.classList.contains('cyc-snippet-table-box')).toBe(true);
    for (const t of ['[.cyc-message_&]:my-2!', '[.cyc-message_&]:max-w-full'])
      expect(box.classList.contains(t)).toBe(true);

    const bar = box.querySelector('.cyc-snippet-table-bar')!;
    for (const t of [
      '[.cyc-message_&]:flex',
      '[.cyc-message_&]:justify-end',
      '[.cyc-message_&]:mb-[0.1875rem]!'
    ])
      expect(bar.classList.contains(t)).toBe(true);

    const wrap = box.querySelector('.cyc-snippet-table-wrap')!;
    expect(wrap.classList.contains('cyc-overflower')).toBe(true);
    for (const t of [
      '[.cyc-message_&]:max-w-full',
      '[.cyc-message_&]:overflow-x-auto',
      '[.cyc-message_&]:[overscroll-behavior-inline:contain]'
    ])
      expect(wrap.classList.contains(t)).toBe(true);

    const table = box.querySelector('.cyc-snippet-table')!;
    for (const t of [
      '[.cyc-message_&]:w-max',
      '[.cyc-message_&]:min-w-full',
      '[.cyc-message_&]:border-collapse',
      '[.cyc-message_&]:text-[0.875rem]!',
      '[.cyc-message_&]:leading-[1.35]'
    ])
      expect(table.classList.contains(t)).toBe(true);
  });

  test('both cells share the geometry; only the header layers the tint + weight', () => {
    const table = tableFrom(src, 0)!.el.querySelector('.cyc-snippet-table')!;
    const th = table.querySelector('th')!;
    const td = table.querySelector('td')!;
    for (const t of CELL_TOKENS) {
      expect(th.classList.contains(t)).toBe(true);
      expect(td.classList.contains(t)).toBe(true);
    }
    expect(th.classList.contains('[.cyc-message_&]:bg-[var(--cyc-text-muted-tint)]')).toBe(true);
    expect(th.classList.contains('[.cyc-message_&]:font-medium!')).toBe(true);
    expect(td.classList.contains('[.cyc-message_&]:bg-[var(--cyc-text-muted-tint)]')).toBe(false);
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

const allClasses = (el: HTMLElement): string[] => {
  const out = new Set<string>();
  const walk = (n: Element) => {
    for (const c of n.classList) out.add(c);
    for (const child of n.children) walk(child);
  };
  walk(el);
  return [...out];
};

const ROOT_VARS =
  '--cyc-pane-gap:8px;--cyc-chat-width:600px;' +
  '--cyc-text:rgb(17,18,19);--cyc-bubble-in-surface:rgb(200,210,220);' +
  '--cyc-rail-width:400px';

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

async function measure(
  bodyHtml: string,
  candidates: string[],
  probes: Record<string, {selector: string; props: string[]; pseudo?: string}>,
  viewport?: {width: number; height: number}
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
    readFileSync(resolve(CODE, 'codeViewer.css'), 'utf8');
  const html =
    `<!DOCTYPE html><html style="${ROOT_VARS}"><head><meta charset="utf-8">` +
    `<style>${utilities}\n/* un-layered shell */\n${shell}</style></head>` +
    `<body style="margin:0">${bodyHtml}</body></html>`;
  const page = await (await getBrowser()).newPage(viewport ? {viewport} : undefined);
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(
      ({probes}) => {
        const out: Record<string, Record<string, string>> = {};
        for (const [key, {selector, props, pseudo}] of Object.entries(probes)) {
          const el = document.querySelector(selector);
          if (!el) throw new Error(`probe ${key}: ${selector} matched nothing`);
          const s = getComputedStyle(el, pseudo);
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

const idAll = (el: HTMLElement, id: string): HTMLElement => {
  el.id = id;
  return el;
};

afterAll(async () => {
  await browser?.close();
});

describe('cascade: current chat utilities win the un-layered shell', () => {
  test('text body -> 14px, 6/10 margins, seeded ink, pre-wrap break-word', async () => {
    const node = textMessage(msg({text: 'x'}), true, true);
    const body = idAll(node.querySelector<HTMLElement>('.cyc-message-text')!, 'b');
    const s = await measure(node.outerHTML, allClasses(node), {
      b: {
        selector: '#b',
        props: [
          'font-size',
          'margin-top',
          'margin-right',
          'margin-bottom',
          'margin-left',
          'color',
          'white-space',
          'word-break'
        ]
      }
    });
    expect(s.b['font-size']).toBe('14px');
    expect(s.b['margin-top']).toBe('6px');
    expect(s.b['margin-right']).toBe('10px');
    expect(s.b['margin-bottom']).toBe('6px');
    expect(s.b['margin-left']).toBe('10px');
    expect(s.b.color).toBe('rgb(17, 18, 19)');
    expect(s.b['white-space']).toBe('pre-wrap');
    expect(s.b['word-break']).toBe('break-word');
    void body;
  });

  test('file body inherits the inlined 14px message text size', async () => {
    const node = fileMessage(
      msg({
        file: {docId: 'd', name: 'runbook.txt', size: 4, fileKind: 'text'}
      } as Partial<CycMessage>),
      true,
      true
    );
    idAll(node.querySelector<HTMLElement>('.cyc-message-text')!, 'b');
    const s = await measure(node.outerHTML, allClasses(node), {
      b: {selector: '#b', props: ['font-size']}
    });
    expect(s.b['font-size']).toBe('14px');
  });

  test('group-last gets a 0.5rem bottom gap; a middle row keeps 0.25rem', async () => {
    const last = idAll(textMessage(msg({}), true, true), 'n');
    const mid = idAll(textMessage(msg({}), true, false), 'n');
    const a = await measure(last.outerHTML, allClasses(last), {
      n: {selector: '#n', props: ['margin-bottom']}
    });
    const b = await measure(mid.outerHTML, allClasses(mid), {
      n: {selector: '#n', props: ['margin-bottom']}
    });
    expect(a.n['margin-bottom']).toBe('8px'); // 0.5rem @ 16px root
    expect(b.n['margin-bottom']).toBe('4px'); // 0.25rem @ 16px root
  });

  test('service row centers; its bubble goes transparent over the base fill', async () => {
    const node = idAll(dateMessage('Today'), 'n');
    const content = idAll(node.querySelector<HTMLElement>('.cyc-message-content')!, 'c');
    const s = await measure(node.outerHTML, allClasses(node), {
      n: {selector: '#n', props: ['align-self', 'justify-content', 'max-width']},
      c: {selector: '#c', props: ['background-color', 'box-shadow']}
    });
    expect(s.n['align-self']).toBe('center');
    expect(s.n['justify-content']).toBe('center');
    expect(s.n['max-width']).toBe('600px');
    expect(s.c['background-color']).toBe('rgba(0, 0, 0, 0)');
    expect(s.c['box-shadow']).not.toContain('0.12');
    void content;
  });

  test('session-event width paints 4rem inset wide, 2.25rem on phone, per JS bucket', () => {
    const ev: CycSessionEvent = {uuid: 'u', ts: 1, kind: 'reply', text: 'y'};
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
    for (const [px, bucket, value] of [
      [1200, 'laptop', 'calc(100% - 4rem)'],
      [800, 'tablet', 'calc(100% - 4rem)'],
      [551, 'tablet', 'calc(100% - 4rem)'],
      [550, 'phone', 'calc(100% - 2.25rem)'],
      [390, 'phone', 'calc(100% - 2.25rem)']
    ] as const) {
      withWidth(px, () => {
        expect(currentPresentation().width).toBe(bucket);
        expect(sessionEventMessage(ev).style.maxWidth).toBe(value);
      });
    }
  });

  test('laptop chat-pane offset is logical: margin-inline-start flips under RTL', async () => {
    const cls = 'desk:ms-[calc(-1*var(--cyc-pane-gap))]';
    const box = (dir?: string) =>
      `<div${dir ? ` dir="${dir}"` : ''}><div id="p" class="${cls}" ` +
      `style="--cyc-pane-gap:16px;width:100px;height:10px"></div></div>`;
    const props = {p: {selector: '#p', props: ['margin-left', 'margin-right']}};
    const ltr = await measure(box(), [cls], props);
    expect(ltr.p['margin-left']).toBe('-16px');
    expect(ltr.p['margin-right']).toBe('0px');
    const rtl = await measure(box('rtl'), [cls], props);
    expect(rtl.p['margin-right']).toBe('-16px');
    expect(rtl.p['margin-left']).toBe('0px');
  });

  test('sticky sentinel: 3px tall, pinned to the group top', async () => {
    const html =
      '<section class="cyc-date-group">' +
      '<div id="s" class="cyc-sticky-sentinel cyc-sticky-sentinel-top h-[0.1875rem] top-0"></div>' +
      '</section>';
    const s = await measure(
      html,
      [
        'cyc-date-group',
        'cyc-sticky-sentinel',
        'cyc-sticky-sentinel-top',
        'h-[0.1875rem]',
        'top-0'
      ],
      {s: {selector: '#s', props: ['height', 'top', 'position']}}
    );
    expect(s.s.height).toBe('3px'); // 0.1875rem @ 16px root
    expect(s.s.top).toBe('0px');
    expect(s.s.position).toBe('absolute');
  });

  // 2026-09-02: the stamp is a float again (inline-end), contained by the body's
  // own ::after clear rather than a table clearfix node.
  test('the flowing stamp floats inline-end; the body clears it with ::after', async () => {
    const node = textMessage(msg({}), true, true);
    expect(node.querySelector('.cyc-clear')).toBeNull();
    idAll(node.querySelector<HTMLElement>('.cyc-stamp-flow')!, 'c');
    idAll(node.querySelector<HTMLElement>('.cyc-message-text')!, 'b');
    const s = await measure(node.outerHTML, allClasses(node), {
      c: {selector: '#c', props: ['float', 'margin-top', 'margin-left']},
      b: {selector: '#b', pseudo: '::after', props: ['display', 'clear', 'content']}
    });
    expect(s.c.float).toBe('inline-end');
    expect(s.c['margin-top']).toBe('3px');
    expect(s.c['margin-left']).toBe('8px');
    expect(s.b.display).toBe('block');
    expect(s.b.clear).toBe('both');
    expect(s.b.content).toBe('""');
  });

  test('the multipart body suppresses the ::after clear (it is a flex column)', async () => {
    const node = textMessage(msg({}), true, true);
    node.classList.add('cyc-multipart');
    idAll(node.querySelector<HTMLElement>('.cyc-message-text')!, 'b');
    const s = await measure(node.outerHTML, allClasses(node), {
      b: {selector: '#b', pseudo: '::after', props: ['content']}
    });
    expect(s.b.content).toBe('none');
  });

  test('the message list keeps its negative gutter inset and translate layer', async () => {
    const html =
      '<div class="cyc-thread" style="position:relative;width:400px;height:300px">' +
      '<div id="l" class="cyc-message-list ' +
      '[inset-block:calc(var(--cyc-pane-gap)*-1)] ' +
      '[inset-inline:calc(var(--cyc-pane-gap)*-1)] absolute z-[1] flex-auto"></div></div>';
    const s = await measure(
      html,
      [
        'cyc-thread',
        'cyc-message-list',
        '[inset-block:calc(var(--cyc-pane-gap)*-1)]',
        '[inset-inline:calc(var(--cyc-pane-gap)*-1)]',
        'absolute',
        'z-[1]',
        'flex-auto'
      ],
      {l: {selector: '#l', props: ['top', 'bottom', 'left', 'right', 'position', 'transform']}}
    );
    expect(s.l.position).toBe('absolute');
    expect(s.l.top).toBe('-8px');
    expect(s.l.bottom).toBe('-8px');
    expect(s.l.left).toBe('-8px');
    expect(s.l.right).toBe('-8px');
    expect(s.l.transform).toBe('none');
  });

  test('outgoing time keeps a compact trailing gutter', async () => {
    const node = textMessage(msg({role: 'user', text: 'x'}), true, true);
    idAll(node.querySelector<HTMLElement>('.cyc-stamp') as HTMLElement, 'ti');
    const s = await measure(node.outerHTML, allClasses(node), {
      ti: {selector: '#ti', props: ['margin-left']}
    });
    expect(s.ti['margin-left']).toBe('8px');
  });

  test('outgoing bubble absorbs the free inline-start space (ml-auto)', async () => {
    const utils = MESSAGE_CONTENT_UTILS.split(/\s+/);
    const html =
      '<div class="cyc-msg-sent" style="width:300px;display:flex;flex-direction:column">' +
      `<div id="c" class="cyc-message-content ${MESSAGE_CONTENT_UTILS}" style="width:100px;height:10px"></div>` +
      '</div>';
    const s = await measure(html, [...utils, 'cyc-msg-sent', 'cyc-message-content'], {
      c: {selector: '#c', props: ['margin-left']}
    });
    expect(s.c['margin-left']).toBe('200px');
  });

  test('reply panel in a row: final box, line clamp, 8px sides, pointer, sender tint', async () => {
    const reply: CycReplyTo = {ts: 1, role: 'claude', title: 'Ada', text: 'earlier line'};
    const node = textMessage(msg({role: 'claude', text: 'x', replyTo: reply}), true, true);
    node.style.setProperty('--cyc-sender-rgb', '5, 6, 7');
    idAll(node.querySelector<HTMLElement>('.cyc-reply')!, 'rp');
    idAll(node.querySelector<HTMLElement>('.cyc-reply-content')!, 'rc');
    idAll(node.querySelector<HTMLElement>('.cyc-reply-title')!, 'rt');
    idAll(node.querySelector<HTMLElement>('.cyc-reply-subtitle')!, 'rs');
    const s = await measure(node.outerHTML, allClasses(node), {
      rp: {
        selector: '#rp',
        props: [
          'margin-left',
          'margin-right',
          'margin-bottom',
          'margin-top',
          'cursor',
          'display',
          'min-height',
          'white-space'
        ]
      },
      rc: {
        selector: '#rc',
        props: [
          'display',
          'pointer-events',
          'margin-inline-start',
          'padding-top',
          'padding-bottom',
          'padding-inline-start',
          'padding-inline-end'
        ]
      },
      rt: {
        selector: '#rt',
        props: ['color', 'font-size', 'line-height', 'white-space', 'text-overflow']
      },
      rs: {selector: '#rs', props: ['font-size', 'line-height', 'white-space', 'text-overflow']}
    });
    expect(s.rp['margin-left']).toBe('8px');
    expect(s.rp['margin-right']).toBe('8px');
    expect(s.rp['margin-bottom']).toBe('8px'); // 0.5rem @ 16px root
    expect(s.rp['margin-top']).toBe('8px');
    expect(s.rp.cursor).toBe('pointer');
    expect(s.rp.display).toBe('block');
    expect(s.rp['min-height']).toBe('48px');
    expect(s.rp['white-space']).toBe('normal');
    expect(s.rc.display).toBe('block');
    expect(s.rc['pointer-events']).toBe('none');
    expect(s.rc['margin-inline-start']).toBe('12px');
    expect(s.rc['padding-top']).toBe('4px');
    expect(s.rc['padding-bottom']).toBe('4px');
    expect(s.rc['padding-inline-end']).toBe('8px');
    expect(s.rt.color).toBe('rgb(5, 6, 7)');
    expect(s.rt['font-size']).toBe('14px');
    expect(s.rt['line-height']).toBe('20px');
    expect(s.rt['white-space']).toBe('nowrap');
    expect(s.rt['text-overflow']).toBe('ellipsis');
    expect(s.rs['font-size']).toBe('14px');
    expect(s.rs['line-height']).toBe('20px');
    expect(s.rs['white-space']).toBe('nowrap');
    expect(s.rs['text-overflow']).toBe('ellipsis');
  });

  test('reply title off a row keeps the unconditional sender tint', async () => {
    const reply: CycReplyTo = {ts: 1, role: 'user', title: 'Ada', text: 'earlier line'};
    const node = textMessage(msg({role: 'user', text: 'x', replyTo: reply}), true, true);
    node.style.setProperty('--cyc-sender-rgb', '9, 8, 7');
    idAll(node.querySelector<HTMLElement>('.cyc-reply-title')!, 'rt');
    const s = await measure(node.outerHTML, allClasses(node), {
      rt: {selector: '#rt', props: ['color']}
    });
    expect(s.rt.color).toBe('rgb(9, 8, 7)');
  });

  test('reply quote path: multiline unclamps the subtitle and pads the title for the icon', async () => {
    const reply: CycReplyTo = {
      ts: 1,
      role: 'claude',
      title: 'Ada',
      text: 'earlier line',
      quote: true
    };
    const node = textMessage(msg({role: 'claude', text: 'x', replyTo: reply}), true, true);
    node.style.setProperty('--cyc-sender-rgb', '5, 6, 7');
    idAll(node.querySelector<HTMLElement>('.cyc-reply-title')!, 'rt');
    idAll(node.querySelector<HTMLElement>('.cyc-reply-subtitle')!, 'rs');
    const s = await measure(node.outerHTML, allClasses(node), {
      rt: {selector: '#rt', props: ['padding-inline-end']},
      rs: {selector: '#rs', props: ['white-space', 'word-break', 'overflow']}
    });
    expect(s.rt['padding-inline-end']).toBe('14px'); // 0.875rem @ 16px root
    expect(s.rs['white-space']).toBe('normal'); // white-space:unset
    expect(s.rs['word-break']).toBe('break-word');
    expect(s.rs.overflow).toBe('visible'); // overflow:unset
  });

  test('reply subtitle emphasis stays italic', async () => {
    const reply: CycReplyTo = {ts: 1, role: 'claude', title: 'Ada', text: '*stress*'};
    const node = textMessage(msg({role: 'claude', text: 'x', replyTo: reply}), true, true);
    idAll(node.querySelector<HTMLElement>('.cyc-reply-subtitle i')!, 'ri');
    const s = await measure(node.outerHTML, allClasses(node), {
      ri: {selector: '#ri', props: ['font-style']}
    });
    expect(s.ri['font-style']).toBe('italic');
  });

  test('reply panel off a row (composer preview) keeps the scoped geometry inert', async () => {
    const reply: CycReplyTo = {ts: 1, role: 'claude', title: 'Ada', text: 'earlier line'};
    const panel = idAll(replyPanel(reply, true), 'rp');
    const s = await measure(panel.outerHTML, allClasses(panel), {
      rp: {selector: '#rp', props: ['margin-left', 'margin-top', 'cursor']}
    });
    expect(s.rp['margin-left']).toBe('0px');
    expect(s.rp['margin-top']).toBe('0px');
    expect(s.rp.cursor).toBe('pointer');
  });

  test('markdown bullet list: disc markers, 1.25rem inset, tight gap, normal wrap', async () => {
    const body = document.createElement('div');
    body.className = 'cyc-message-text ' + MESSAGE_TEXT_UTILS;
    setFormatted(body, '- alpha\n- beta');
    const wrap = document.createElement('div');
    wrap.className = 'cyc-message';
    wrap.append(body);
    idAll(body.querySelector<HTMLElement>('ul') as HTMLElement, 'ul');
    idAll(body.querySelector<HTMLElement>('li') as HTMLElement, 'li');
    const s = await measure(wrap.outerHTML, allClasses(wrap), {
      ul: {
        selector: '#ul',
        props: ['list-style-type', 'padding-inline-start', 'margin-top', 'white-space']
      },
      li: {selector: '#li', props: ['list-style-type']}
    });
    expect(s.ul['list-style-type']).toBe('disc');
    expect(s.ul['padding-inline-start']).toBe('20px'); // 1.25rem @ 16px root
    expect(s.ul['margin-top']).toBe('2px'); // 0.125rem @ 16px root
    expect(s.ul['white-space']).toBe('normal');
    expect(s.li['list-style-type']).toBe('disc');
  });

  test('markdown ordered list: decimal markers at the 1.75rem inset', async () => {
    const body = document.createElement('div');
    body.className = 'cyc-message-text ' + MESSAGE_TEXT_UTILS;
    setFormatted(body, '1. one\n2. two');
    const wrap = document.createElement('div');
    wrap.className = 'cyc-message';
    wrap.append(body);
    idAll(body.querySelector<HTMLElement>('ol') as HTMLElement, 'ol');
    idAll(body.querySelector<HTMLElement>('li') as HTMLElement, 'li');
    const s = await measure(wrap.outerHTML, allClasses(wrap), {
      ol: {selector: '#ol', props: ['list-style-type', 'padding-inline-start']},
      li: {selector: '#li', props: ['list-style-type']}
    });
    expect(s.ol['list-style-type']).toBe('decimal');
    expect(s.ol['padding-inline-start']).toBe('28px'); // 1.75rem @ 16px root
    expect(s.li['list-style-type']).toBe('decimal');
  });

  const TABLE_SRC = ['Name | Value', '--- | ---', 'Ada | x'];
  const seededMessage = (box: HTMLElement) =>
    '<div class="cyc-message" style="--cyc-border-color:rgb(10,20,30);' +
    '--cyc-text-muted-tint:rgb(40,50,60)">' +
    box.outerHTML +
    '</div>';

  test('markdown table inside a row: collapse, cell borders/padding, header tint', async () => {
    const box = tableFrom(TABLE_SRC, 0)!.el;
    idAll(box, 'box');
    idAll(box.querySelector<HTMLElement>('.cyc-snippet-table-bar')!, 'bar');
    idAll(box.querySelector<HTMLElement>('.cyc-snippet-table')!, 'tbl');
    idAll(box.querySelector<HTMLElement>('th')!, 'th');
    idAll(box.querySelector<HTMLElement>('td')!, 'td');
    const s = await measure(seededMessage(box), allClasses(box), {
      box: {selector: '#box', props: ['margin-top', 'margin-bottom']},
      bar: {selector: '#bar', props: ['display', 'justify-content', 'margin-bottom']},
      tbl: {selector: '#tbl', props: ['border-collapse', 'font-size']},
      th: {
        selector: '#th',
        props: [
          'border-top-width',
          'border-top-color',
          'padding-top',
          'padding-left',
          'max-width',
          'vertical-align',
          'background-color',
          'font-weight'
        ]
      },
      td: {
        selector: '#td',
        props: ['border-top-width', 'padding-top', 'max-width', 'text-align', 'background-color']
      }
    });
    expect(s.box['margin-top']).toBe('8px'); // 0.5rem @ 16px root
    expect(s.box['margin-bottom']).toBe('8px');
    expect(s.bar.display).toBe('flex');
    expect(s.bar['justify-content']).toBe('flex-end');
    expect(s.bar['margin-bottom']).toBe('3px'); // 0.1875rem
    expect(s.tbl['border-collapse']).toBe('collapse');
    expect(s.tbl['font-size']).toBe('14px'); // 0.875rem @ 16px root
    expect(s.th['border-top-width']).toBe('1px');
    expect(s.th['border-top-color']).toBe('rgb(10, 20, 30)');
    expect(s.th['padding-top']).toBe('6px'); // 0.375rem
    expect(s.th['padding-left']).toBe('10px'); // 0.625rem
    expect(s.th['max-width']).toBe('288px'); // 18rem
    expect(s.th['vertical-align']).toBe('top');
    expect(s.th['background-color']).toBe('rgb(40, 50, 60)');
    expect(s.th['font-weight']).toBe('500');
    expect(s.td['border-top-width']).toBe('1px');
    expect(s.td['padding-top']).toBe('6px');
    expect(s.td['max-width']).toBe('288px');
    expect(s.td['text-align']).toBe('start');
    expect(s.td['background-color']).toBe('rgba(0, 0, 0, 0)');
  });

  test('markdown table: the phone shrink utilities out-specify the base cell ones', async () => {
    const box = tableFrom(TABLE_SRC, 0)!.el;
    idAll(box.querySelector<HTMLElement>('th')!, 'th');
    idAll(box.querySelector<HTMLElement>('td')!, 'td');
    const s = await measure(
      seededMessage(box),
      allClasses(box),
      {
        th: {
          selector: '#th',
          props: ['max-width', 'padding-top', 'padding-left', 'border-top-width']
        },
        td: {selector: '#td', props: ['max-width', 'padding-top', 'padding-left']}
      },
      {width: 390, height: 800}
    );
    expect(s.th['max-width']).toBe('224px'); // 14rem @ 16px root
    expect(s.th['padding-top']).toBe('4px');
    expect(s.th['padding-left']).toBe('8px');
    expect(s.th['border-top-width']).toBe('1px');
    expect(s.td['max-width']).toBe('224px');
    expect(s.td['padding-top']).toBe('4px');
  });

  test('markdown table outside a row keeps codeViewer.css geometry (fullscreen clone)', async () => {
    const box = tableFrom(TABLE_SRC, 0)!.el;
    idAll(box, 'box');
    idAll(box.querySelector<HTMLElement>('.cyc-snippet-table-bar')!, 'bar');
    idAll(box.querySelector<HTMLElement>('.cyc-snippet-table')!, 'tbl');
    idAll(box.querySelector<HTMLElement>('th')!, 'th');
    idAll(box.querySelector<HTMLElement>('td')!, 'td');
    const s = await measure(
      '<div class="cyc-cv-body" style="--cyc-border-color:rgb(10,20,30);' +
        '--cyc-text-muted-tint:rgb(40,50,60)">' +
        box.outerHTML +
        '</div>',
      allClasses(box),
      {
        box: {selector: '#box', props: ['margin-top']},
        bar: {selector: '#bar', props: ['margin-bottom']},
        tbl: {selector: '#tbl', props: ['font-size']},
        th: {
          selector: '#th',
          props: [
            'padding-top',
            'padding-left',
            'max-width',
            'font-weight',
            'background-color',
            'border-top-width'
          ]
        },
        td: {selector: '#td', props: ['padding-top', 'max-width', 'background-color']}
      }
    );
    expect(s.box['margin-top']).toBe('4px'); // 0.25rem, not the conversation 0.5rem
    expect(s.bar['margin-bottom']).toBe('2px'); // 0.125rem, not 0.1875rem
    expect(s.tbl['font-size']).toBe('13px'); // 0.8125rem, not 0.875rem
    expect(s.th['padding-top']).toBe('3px'); // 0.1875rem, not 0.375rem
    expect(s.th['padding-left']).toBe('8px'); // 0.5rem, not 0.625rem
    expect(s.th['max-width']).toBe('320px'); // 20rem, not 18rem
    expect(s.th['font-weight']).toBe('600'); // codeViewer weight, not 700
    expect(s.th['background-color']).toBe('rgb(40, 50, 60)');
    expect(s.th['border-top-width']).toBe('1px');
    expect(s.td['padding-top']).toBe('3px');
    expect(s.td['max-width']).toBe('320px');
    expect(s.td['background-color']).toBe('rgba(0, 0, 0, 0)');
  });
});
