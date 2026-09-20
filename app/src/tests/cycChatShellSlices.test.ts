
import {afterAll, beforeEach, afterEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

import {
  installPresentationReactivity,
  presentationPainterCount,
  currentPresentation
} from '../components/presentation';
import {paintAppBackgroundWidth} from '../features/chat/wallpaper';
import {installComposerDropZone} from '../features/composer/fileCollection';
import {dateMessage} from '../features/chat/messages/sessionEventMessages';
import {unreadBannerEl} from '../features/chat/messages/messageContent';
import {attachStickyDates, DATE_CHIP_VEILED} from '../features/chat/surface/messageList';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const CHAT = resolve(HERE, '..', 'features', 'chat');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

// Drive the presentation snapshot at a fixed viewport width, then restore. Mirrors
// the withWidth helper in cycChatRoot.test.ts: installPresentationReactivity adopts
// the new geometry immediately so painters registered inside see the right bucket.
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

const allClasses = (el: HTMLElement): string[] => {
  const out = new Set<string>();
  const walk = (n: Element) => {
    for (const c of n.classList) out.add(c);
    for (const child of n.children) walk(child);
  };
  walk(el);
  return [...out];
};

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});



describe('app-background width painter forks display by the phone bucket', () => {
  const mk = () => {
    const el = document.createElement('div');
    el.className = 'cyc-thread-background cyc-app-background z-0';
    document.body.append(el);
    return el;
  };

  test('549/550 hide (phone); 550.5/551 show (tablet)', () => {
    for (const px of [549, 550]) {
      withWidth(px, () => {
        expect(currentPresentation().width).toBe('phone');
        const el = mk();
        paintAppBackgroundWidth(el);
        expect(el.classList.contains('hidden')).toBe(true);
      });
    }
    for (const px of [550.5, 551]) {
      withWidth(px, () => {
        expect(currentPresentation().width).toBe('tablet');
        const el = mk();
        paintAppBackgroundWidth(el);
        expect(el.classList.contains('hidden')).toBe(false);
      });
    }
  });

  test('a mounted background repaints live across the boundary', () => {
    const el = mk();
    withWidth(800, () => paintAppBackgroundWidth(el));
    // Registered once; now flip the geometry under it and re-adopt.
    withWidth(390, () => expect(el.classList.contains('hidden')).toBe(true));
    withWidth(1200, () => expect(el.classList.contains('hidden')).toBe(false));
  });
});

describe('drop-layer top painter forks --cyc-drop-pad by the phone bucket', () => {
  const install = () => {
    const pane = document.createElement('div');
    document.body.append(pane);
    const teardown = installComposerDropZone({pane, onFiles: () => {}, canDrop: () => true});
    const layer = pane.querySelector<HTMLElement>('.cyc-drop-layer')!;
    return {layer, teardown};
  };

  test('549/550 -> 10px; 550.5/551 -> 20px; the layer spans the pad-top to pad-bottom lines', () => {
    for (const px of [549, 550]) {
      withWidth(px, () => {
        const {layer, teardown} = install();
        expect(layer.style.getPropertyValue('--cyc-drop-pad')).toBe('10px');
        teardown();
      });
    }
    for (const px of [550.5, 551]) {
      withWidth(px, () => {
        const {layer, teardown} = install();
        expect(layer.style.getPropertyValue('--cyc-drop-pad')).toBe('20px');
        teardown();
      });
    }
    withWidth(800, () => {
      const {layer, teardown} = install();
      expect(layer.classList.contains('top-[var(--cyc-chat-pad-top)]')).toBe(true);
      expect(
        layer.classList.contains('bottom-[calc(var(--cyc-chat-pad-bottom)+var(--cyc-composer-overshoot,0px))]')
      ).toBe(true);
      expect(layer.classList.contains('p-[var(--cyc-drop-pad,20px)]')).toBe(true);
      teardown();
    });
  });

  test('the painter unregisters on teardown (no leak past the layer lifetime)', () => {
    withWidth(800, () => {
      const before = presentationPainterCount();
      const {layer, teardown} = install();
      expect(presentationPainterCount()).toBe(before + 1);
      teardown();
      expect(layer.isConnected).toBe(false);
      expect(presentationPainterCount()).toBe(before);
    });
  });
});

describe('dateMessage', () => {
  test('renders one sticky date chip that goes invisible under the veil', () => {
    const chip = dateMessage('Today');
    expect(chip.classList.contains('cyc-date-chip')).toBe(true);
    expect(chip.classList.contains('sticky')).toBe(true);
    expect(chip.classList.contains('[&.cyc-date-veiled]:invisible')).toBe(true);
    expect(chip.textContent).toBe('Today');
    expect(chip.querySelectorAll('.cyc-message').length).toBe(0);
  });
});

describe('attachStickyDates veils the chip that overlaps the unread divider', () => {
  const box = (el: HTMLElement, top: number, height: number, left = 0, width = 400) => {
    el.getBoundingClientRect = () =>
      ({top, bottom: top + height, left, right: left + width, x: left, y: top, width, height}) as DOMRect;
  };
  const mount = () => {
    const scroll = document.createElement('div');
    const list = document.createElement('div');
    const chip = dateMessage('Today');
    const divider = unreadBannerEl();
    list.append(chip, divider);
    scroll.append(list);
    document.body.append(scroll);
    return {scroll, list, chip, divider};
  };

  test('overlap veils, parting unveils, refresh and scroll both drive it', async () => {
    const {scroll, list, chip, divider} = mount();
    box(chip, 100, 38);
    box(divider, 200, 32);
    const sticky = attachStickyDates(list, scroll);
    sticky.refresh();
    expect(chip.classList.contains(DATE_CHIP_VEILED)).toBe(false);

    box(divider, 120, 32); // the divider's text under the chip
    sticky.refresh();
    expect(chip.classList.contains(DATE_CHIP_VEILED)).toBe(true);

    box(divider, 40, 32); // scrolled past: touching edges do not count
    scroll.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(chip.classList.contains(DATE_CHIP_VEILED)).toBe(false);

    box(divider, 130, 32);
    sticky.refresh();
    expect(chip.classList.contains(DATE_CHIP_VEILED)).toBe(true);
    sticky.destroy();
    expect(chip.classList.contains(DATE_CHIP_VEILED)).toBe(false);
    scroll.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(chip.classList.contains(DATE_CHIP_VEILED)).toBe(false);
  });

  test('no divider in the list: nothing is veiled, a stale veil is lifted', () => {
    const {scroll, list, chip, divider} = mount();
    box(chip, 100, 38);
    box(divider, 110, 32);
    const sticky = attachStickyDates(list, scroll);
    sticky.refresh();
    expect(chip.classList.contains(DATE_CHIP_VEILED)).toBe(true);
    divider.remove();
    sticky.refresh();
    expect(chip.classList.contains(DATE_CHIP_VEILED)).toBe(false);
    sticky.destroy();
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

async function measure(
  bodyHtml: string,
  candidates: string[],
  probes: Record<string, {selector: string; props: string[]}>,
  rootStyle = ''
): Promise<Record<string, Record<string, string>>> {
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

describe('cascade: the app-background width fork flips display at the 550 boundary', () => {
  const mk = () => {
    const el = document.createElement('div');
    el.className = 'cyc-thread-background cyc-app-background z-0';
    document.body.append(el);
    return el;
  };

  test('549/550 hide (display:none, z:0); 550.5/551 show (display:block)', async () => {
    for (const px of [549, 550]) {
      let el!: HTMLElement;
      withWidth(px, () => {
        el = mk();
        paintAppBackgroundWidth(el);
      });
      const s = await measure(el.outerHTML, allClasses(el), {
        a: {selector: '.cyc-app-background', props: ['display', 'z-index']}
      });
      expect(s.a.display, `${px}`).toBe('none');
      expect(s.a['z-index'], `${px}`).toBe('0');
      document.body.innerHTML = '';
    }
    for (const px of [550.5, 551]) {
      let el!: HTMLElement;
      withWidth(px, () => {
        el = mk();
        paintAppBackgroundWidth(el);
      });
      const s = await measure(el.outerHTML, allClasses(el), {
        a: {selector: '.cyc-app-background', props: ['display', 'z-index']}
      });
      expect(s.a.display, `${px}`).toBe('block');
      expect(s.a['z-index'], `${px}`).toBe('0');
      document.body.innerHTML = '';
    }
  });
});

describe('cascade: the drop layer spans the message area, the target fills it inside the pad fork', () => {
  const install = () => {
    const pane = document.createElement('div');
    document.body.append(pane);
    const teardown = installComposerDropZone({pane, onFiles: () => {}, canDrop: () => true});
    const layer = pane.querySelector<HTMLElement>('.cyc-drop-layer')!;
    layer.classList.add('cyc-drop-mounted');
    return {layer, teardown};
  };

  // The pane paints pad-top (header + gap + agents bar) and pad-bottom
  // (composer + gap + floor); a chip row grows the composer by the overshoot.
  const PAD_TOP = 60;
  const PAD_BOTTOM = 72;
  const OVERSHOOT = 30;

  test('549/550 -> 10px inset; 550.5/551 -> 20px inset; top = pad-top, bottom = pad-bottom + overshoot', async () => {
    for (const [px, pad] of [
      [549, 10],
      [550, 10],
      [550.5, 20],
      [551, 20]
    ] as const) {
      let outer = '';
      let cands: string[] = [];
      withWidth(px, () => {
        const {layer, teardown} = install();
        outer =
          `<div style="position:relative;width:400px;height:400px;` +
          `--cyc-chat-pad-top:${PAD_TOP}px;--cyc-chat-pad-bottom:${PAD_BOTTOM}px">${layer.outerHTML}</div>`;
        cands = allClasses(layer);
        teardown();
      });
      const s = await measure(
        outer,
        cands,
        {d: {selector: '.cyc-drop-layer', props: ['top', 'bottom', 'padding-top', 'position', 'height']}},
        `--cyc-composer-overshoot:${OVERSHOOT}px`
      );
      expect(s.d.position, `${px}`).toBe('absolute');
      expect(s.d.top, `${px}`).toBe(`${PAD_TOP}px`);
      expect(s.d.bottom, `${px}`).toBe(`${PAD_BOTTOM + OVERSHOOT}px`);
      expect(s.d['padding-top'], `${px}`).toBe(`${pad}px`);
      expect(s.d.height, `${px}`).toBe(`${400 - PAD_TOP - PAD_BOTTOM - OVERSHOOT}px`);
      document.body.innerHTML = '';
    }
  });
});

describe('cascade: the date chip is CSS-sticky and fully opaque', () => {
  test('position sticky, opacity 1, one node', async () => {
    const real = dateMessage('Today');
    real.id = 'real';
    const html =
      `<div class="cyc-message-list"><div class="cyc-message-list-inner">` +
      `<section class="cyc-date-group">${real.outerHTML}</section></div></div>`;
    const s = await measure(
      html,
      [...real.classList, 'cyc-message-list', 'cyc-message-list-inner', 'cyc-date-group'],
      {d: {selector: '#real', props: ['position', 'opacity']}},
      '--cyc-chat-pad-top:80px;--cyc-chat-width:600px'
    );
    expect(s.d.position).toBe('sticky');
    expect(s.d.opacity).toBe('1');
  });
});
