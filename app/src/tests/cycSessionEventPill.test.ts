// Session-event pill state and cascade coverage.

import {afterAll, afterEach, beforeEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

import {
  sessionEventMessage,
  sessionEventRunMessages,
  sessionEventFoldMessages,
  dateMessage,
  paintSessionEventClamp
} from '../features/chat/messages/sessionEventMessages';
import {
  installPresentationReactivity,
  currentPresentation,
  setPresentationTheme
} from '../components/presentation';
import type {CycSessionEvent} from '../types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const SHELL = resolve(SRC, 'shell');
const CHAT = resolve(SRC, 'features', 'chat');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

// Theme-token fixture.
const ENV = `
:root{
  --cyc-surface:rgb(30,31,32);
  --cyc-text:rgb(20,21,22);
  --cyc-border-color:rgb(70,71,72);
  --cyc-bubble-flash:rgb(50,50,50);
  --cyc-message-service-size:14px;
  --cyc-chat-width:40rem;
  --cyc-service-bg:rgb(11,12,13);
  --cyc-service-fg:rgb(14,15,16);
}
html[data-theme='dark']{
  --cyc-service-bg:rgb(111,112,113);
  --cyc-service-fg:rgb(114,115,116);
}
`;

const ev = (uuid: string, text = 'ran a tool'): CycSessionEvent => ({
  uuid,
  ts: 0,
  kind: 'tool',
  text,
  tool: 'bash'
});

// Run a callback at a fixed viewport width.
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

const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', {bubbles: true}));

beforeEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});
afterEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});

/* OUT-OF-BAND INPUTS ARE VISIBLE AND ATTRIBUTED IN THE OVERLAY (this lane).
 *
 * A prompt event the engine tagged with a `source` renders a small chip saying
 * where it came from: a line typed straight into the pane (`manual`), one agent
 * messaging this one (`from <id>`), a fired schedule (`cron`). The message body
 * still shows. Events with no source (a tool run) carry no chip. */
const promptEv = (
  uuid: string,
  text: string,
  source?: string,
  sender?: string
): CycSessionEvent => ({
  uuid,
  ts: 0,
  kind: 'prompt',
  text,
  ...(source ? {source} : {}),
  ...(sender ? {sender} : {})
});

describe('input source chip: an out-of-band input shows in the overlay, labelled', () => {
  test('a manual pane input renders NO chip, only its text', () => {
    const node = sessionEventMessage(promptEv('m', '> fix the makefile', 'manual'));
    expect(node.querySelector<HTMLElement>('.cyc-se-source')).toBeNull();
    expect(node.querySelector<HTMLElement>('.cyc-se-body')!.textContent).toBe('> fix the makefile');
  });

  test('an agent-to-agent input renders a "from <sender>" chip', () => {
    const node = sessionEventMessage(promptEv('a', '> DemoAgent: rebase please', 'agent', 'DemoAgent'));
    const chip = node.querySelector<HTMLElement>('.cyc-se-source')!;
    expect(chip.textContent).toBe('from DemoAgent');
    // the message body is still present and readable
    expect(node.querySelector<HTMLElement>('.cyc-se-body')!.textContent).toContain('rebase please');
  });

  test('a cron input renders a "cron" chip; a source-less tool run has none', () => {
    const cron = sessionEventMessage(promptEv('c', '> SCHEDULED (standup): update', 'cron'));
    expect(cron.querySelector<HTMLElement>('.cyc-se-source')!.textContent).toBe('cron');
    const tool = sessionEventMessage(ev('t'));
    expect(tool.querySelector('.cyc-se-source')).toBeNull();
  });

  test('the chip survives the open/close repaint (it is not the text node)', () => {
    const node = sessionEventMessage(promptEv('r', '> DemoAgent: hi', 'agent', 'DemoAgent'));
    document.body.append(node);
    click(node);
    expect(node.classList.contains('cyc-se-open')).toBe(true);
    expect(node.querySelector<HTMLElement>('.cyc-se-source')!.textContent).toBe('from DemoAgent');
    click(node);
    expect(node.querySelector<HTMLElement>('.cyc-se-source')!.textContent).toBe('from DemoAgent');
  });
});

describe('session-event state machine: click / single-open / run expand / interrupt', () => {
  test('a pill toggles cyc-se-open on click and repaints plain <-> formatted', () => {
    const node = sessionEventMessage(ev('m1'));
    document.body.append(node);
    const text = node.querySelector<HTMLElement>('.cyc-service-text')!;
    expect(node.classList.contains('cyc-se-open')).toBe(false);
    expect(text.textContent).toBe('ran a tool');

    click(node);
    expect(node.classList.contains('cyc-se-open')).toBe(true);

    click(node);
    expect(node.classList.contains('cyc-se-open')).toBe(false);
    expect(text.textContent).toBe('ran a tool');
  });

  test('opening a second pill collapses the first (single-open invariant)', () => {
    const a = sessionEventMessage(ev('a'));
    const b = sessionEventMessage(ev('b'));
    document.body.append(a, b);
    click(a);
    expect(a.classList.contains('cyc-se-open')).toBe(true);
    click(b);
    expect(a.classList.contains('cyc-se-open')).toBe(false);
    expect(b.classList.contains('cyc-se-open')).toBe(true);
  });

  test('a click on an anchor inside the pill does not toggle', () => {
    const node = sessionEventMessage(ev('lnk'));
    document.body.append(node);
    const a = document.createElement('a');
    node.querySelector('.cyc-service-text')!.append(a);
    click(a);
    expect(node.classList.contains('cyc-se-open')).toBe(false);
  });

  test('run head toggles cyc-se-expanded and the items reveal literal is present', () => {
    const wrap = sessionEventRunMessages([ev('r1'), ev('r2', 'second')]);
    document.body.append(wrap);
    const head = wrap.querySelector<HTMLElement>('.cyc-se-run-head')!;
    const items = wrap.querySelector<HTMLElement>('.cyc-se-run-items')!;
    expect(items.className).toContain('hidden');
    expect(items.className).toContain('[.cyc-se-expanded_&]:block');
    expect(wrap.classList.contains('cyc-se-expanded')).toBe(false);
    click(head);
    expect(wrap.classList.contains('cyc-se-expanded')).toBe(true);
    click(head);
    expect(wrap.classList.contains('cyc-se-expanded')).toBe(false);
  });

  test('an interrupt renders a dim cyc-se-int sub-line carrying the interrupt text', () => {
    const node = sessionEventMessage(ev('i1'), ev('int', 'interrupted here'));
    const line = node.querySelector<HTMLElement>('.cyc-se-int')!;
    expect(line).toBeTruthy();
    expect(line.textContent).toBe('interrupted here');
    expect(node.classList.contains('cyc-se-interrupted')).toBe(true);
  });

  test('a mixed-kind fold head reads "N background updates" and hides N pills that reveal on click', () => {
    const events: CycSessionEvent[] = [
      promptEv('f1', '> cron fired', 'cron'),
      ev('f2', 'ran bash'),
      {uuid: 'f3', ts: 0, kind: 'reply', text: 'here is the answer'},
      {uuid: 'f4', ts: 0, kind: 'compact', text: 'compacted'},
      ev('f5', 'ran grep'),
      {uuid: 'f6', ts: 0, kind: 'interrupt', text: 'stopped'}
    ];
    const wrap = sessionEventFoldMessages(events);
    document.body.append(wrap);
    const head = wrap.querySelector<HTMLElement>('.cyc-se-run-head')!;
    const items = wrap.querySelector<HTMLElement>('.cyc-se-run-items')!;
    // Non-vacuity: the head count matches the run length, and the hidden set
    // holds exactly that many pills.
    expect(head.textContent).toBe(`${events.length} background updates`);
    expect(items.querySelectorAll('.cyc-session-event').length).toBe(events.length);
    expect(items.className).toContain('hidden');
    expect(items.className).toContain('[.cyc-se-expanded_&]:block');
    // Not the pure-tool label.
    expect(head.textContent).not.toContain('tool calls');
    expect(wrap.classList.contains('cyc-se-expanded')).toBe(false);
    click(head);
    expect(wrap.classList.contains('cyc-se-expanded')).toBe(true);
    click(head);
    expect(wrap.classList.contains('cyc-se-expanded')).toBe(false);
  });

  test('the fold does not carry a run-level interrupt partner; the interrupt is a plain member', () => {
    const events: CycSessionEvent[] = [
      ev('g1'),
      ev('g2'),
      {uuid: 'g3', ts: 0, kind: 'interrupt', text: 'stopped here'}
    ];
    const wrap = sessionEventFoldMessages(events);
    // The tool-run path adds cyc-se-interrupted on the wrap; the fold never does.
    expect(wrap.classList.contains('cyc-se-interrupted')).toBe(false);
    const items = wrap.querySelector<HTMLElement>('.cyc-se-run-items')!;
    const interruptPill = items.querySelector<HTMLElement>('.cyc-se-interrupt')!;
    expect(interruptPill.querySelector('.cyc-se-body')!.textContent).toBe('stopped here');
  });

  test('dateMessage never receives the session-event variants', () => {
    const node = dateMessage('Today');
    const text = node.querySelector<HTMLElement>('.cyc-service-text')!;
    expect(node.classList.contains('cyc-session-event')).toBe(false);
    expect(text.className).not.toContain('cyc-session-event');
  });
});

describe('paintSessionEventClamp toggles cyc-se-clamp at the 550px phone edge', () => {
  for (const [px, clamped, bucket] of [
    [549, true, 'phone'],
    [550, true, 'phone'],
    [551, false, 'tablet']
  ] as const) {
    test(`${px}px -> clamp ${clamped} on a bare node and the real producers`, () => {
      withWidth(px, () => {
        expect(currentPresentation().width).toBe(bucket);
        const bare = document.createElement('div');
        paintSessionEventClamp(bare);
        expect(bare.classList.contains('cyc-se-clamp')).toBe(clamped);
        const pill = sessionEventMessage(ev('c1'));
        const run = sessionEventRunMessages([ev('c2')]);
        const head = run.querySelector<HTMLElement>('.cyc-se-run-head')!;
        expect(pill.classList.contains('cyc-se-clamp')).toBe(clamped);
        expect(head.classList.contains('cyc-se-clamp')).toBe(clamped);
      });
    });
  }

  test('lifecycle: a mounted node repaints across the edge, a detached one is pruned', () => {
    const node = document.createElement('div');
    document.body.append(node);
    withWidth(551, () => {
      paintSessionEventClamp(node);
      expect(node.classList.contains('cyc-se-clamp')).toBe(false);
    });
    withWidth(549, () => {
      expect(node.classList.contains('cyc-se-clamp')).toBe(true);
    });
    node.remove();
    withWidth(551, () => {
      expect(node.classList.contains('cyc-se-clamp')).toBe(true);
    });
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

const allClasses = (root: HTMLElement): string[] => {
  const out = new Set<string>();
  for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    for (const c of el.className.trim().split(/\s+/).filter(Boolean)) out.add(c);
  }
  return [...out];
};

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());
afterAll(async () => {
  await browser?.close();
});

// Read a computed style from the production stylesheet stack.
async function measure(
  node: HTMLElement,
  selector: string,
  theme: 'day' | 'night',
  dir: 'ltr' | 'rtl'
): Promise<Record<string, string>> {
  const utilities = await compileTailwind(allClasses(node));
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
    `<style>${utilities}\n/* un-layered shell + sessions + chat */\n${shell}</style></head>` +
    `<body style="margin:0">${node.outerHTML}</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.$eval(selector, (el) => {
      const cs = getComputedStyle(el);
      return {
        whiteSpace: cs.whiteSpace,
        display: cs.display,
        overflow: cs.overflowY,
        textOverflow: cs.textOverflow,
        lineClamp: cs.getPropertyValue('-webkit-line-clamp'),
        opacity: cs.opacity,
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        paddingTop: cs.paddingTop,
        paddingBottom: cs.paddingBottom,
        borderBottomWidth: cs.borderBottomWidth,
        marginTop: cs.marginTop
      };
    });
  } finally {
    await page.close();
  }
}

const PILL = '.cyc-session-event .cyc-service-text:not(.cyc-se-int)';

for (const [dir, theme] of [
  ['ltr', 'day'],
  ['rtl', 'night']
] as const) {
  describe(`session-event pill cascade (${dir}/${theme})`, () => {
    test('collapsed at 551 (tablet): one-line ellipsis skin, no clamp', async () => {
      let node!: HTMLElement;
      withWidth(551, () => (node = sessionEventMessage(ev('t1'))));
      const r = await measure(node, PILL, theme, dir);
      expect(r.whiteSpace).toBe('nowrap');
      expect(r.display).toBe('block');
      expect(r.overflow).toBe('hidden');
      expect(r.textOverflow).toBe('ellipsis');
      expect(r.lineClamp).toBe('none');
      expect(r.opacity).toBe('0.65');
      expect(r.fontSize).toBe('12px');
      // Compact activity-row rhythm: py-1 + leading-4 beat the service pill's
      // py-1.5 + leading-5, so a run of these rows reads tight between bubbles.
      expect(r.lineHeight).toBe('16px');
      expect(r.paddingTop).toBe('4px');
      expect(r.paddingBottom).toBe('4px');
      expect(r.borderBottomWidth).toBe('0px');
    });

    test('the date pill keeps the roomier standalone service padding (non-vacuity)', async () => {
      const node = dateMessage('Today');
      const r = await measure(node, '.cyc-service-text', theme, dir);
      expect(r.paddingTop).toBe('6px');
      expect(r.paddingBottom).toBe('6px');
      expect(r.lineHeight).toBe('20px');
    });

    for (const px of [549, 550] as const) {
      test(`collapsed at ${px} (phone): the painter's clamp beats the collapsed skin`, async () => {
        let node!: HTMLElement;
        withWidth(px, () => (node = sessionEventMessage(ev(`p${px}`))));
        const r = await measure(node, PILL, theme, dir);
        expect(r.whiteSpace).toBe('normal');
        expect(r.display).toBe('flow-root');
        expect(r.lineClamp).toBe('2');
        expect(r.paddingBottom).toBe('0px');
        expect(r.borderBottomWidth).toBe('4px');
        expect(r.opacity).toBe('0.65');
      });
    }

    test('open at 551: the expanded skin beats collapsed (pre-line / visible / clip)', async () => {
      let node!: HTMLElement;
      withWidth(551, () => (node = sessionEventMessage(ev('o1'))));
      document.body.append(node);
      click(node);
      const r = await measure(node, PILL, theme, dir);
      expect(r.whiteSpace).toBe('pre-line');
      expect(r.display).toBe('block');
      expect(r.overflow).toBe('visible');
      expect(r.textOverflow).toBe('clip');
      expect(r.lineClamp).toBe('none');
    });

    test('open at 549: open wins white-space/display, clamp pb/border still carry', async () => {
      let node!: HTMLElement;
      withWidth(549, () => (node = sessionEventMessage(ev('o2'))));
      document.body.append(node);
      click(node);
      const r = await measure(node, PILL, theme, dir);
      expect(r.whiteSpace).toBe('pre-line');
      expect(r.display).toBe('block');
      expect(r.overflow).toBe('visible');
      expect(r.paddingBottom).toBe('0px');
      expect(r.borderBottomWidth).toBe('4px');
    });

    test('interrupt sub-line: se-int dims and out-ranks the collapsed/clamp skin', async () => {
      let node!: HTMLElement;
      withWidth(549, () => (node = sessionEventMessage(ev('n1'), ev('int', 'stopped'))));
      const r = await measure(node, '.cyc-se-int', theme, dir);
      expect(r.opacity).toBe('0.5');
      expect(r.display).toBe('block');
      expect(r.whiteSpace).toBe('nowrap');
      expect(r.overflow).toBe('visible');
      expect(r.borderBottomWidth).toBe('0px');
      expect(r.marginTop).toBe('2px'); // 0.125rem at the 16px root
      expect(r.fontSize).toBe('12px');
    });
  });
}

describe('session-event margins + run-items reveal resolve in Chromium', () => {
  test('collapsed pill mb-0.5, open pill mb-3, expanded run wrap mb-3', async () => {
    const collapsed = sessionEventMessage(ev('mc'));
    const open = sessionEventMessage(ev('mo'));
    document.body.append(open);
    click(open);
    const cm = await measure(collapsed, '.cyc-session-event', 'day', 'ltr');
    const om = await measure(open, '.cyc-session-event', 'day', 'ltr');
    const mb = async (n: HTMLElement) => {
      const utilities = await compileTailwind(allClasses(n));
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
        `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n${shell}</style>` +
        `</head><body style="margin:0">${n.outerHTML}</body></html>`;
      const page = await (await getBrowser()).newPage();
      try {
        await page.setContent(html, {waitUntil: 'load'});
        return await page.$eval(
          '.cyc-session-event, .cyc-se-run',
          (el) => getComputedStyle(el).marginBottom
        );
      } finally {
        await page.close();
      }
    };
    expect(await mb(collapsed)).toBe('2px'); // mb-0.5 = 0.125rem at 16px root
    expect(await mb(open)).toBe('12px'); // [&.cyc-se-open]:mb-3 = 0.75rem
    expect(cm.display).toBe('flex');
    expect(om.display).toBe('flex');

    const run = sessionEventRunMessages([ev('mr')]);
    document.body.append(run);
    click(run.querySelector<HTMLElement>('.cyc-se-run-head')!);
    expect(await mb(run)).toBe('12px'); // [&.cyc-se-expanded]:mb-3 = 0.75rem
  });
});
