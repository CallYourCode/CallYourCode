import {test, expect, type Page} from '@playwright/test';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {bootIsolated, openFixtureChat} from './rig';

// THE BUBBLE COLUMN SHARES THE COMPOSER'S EDGES.
//
// Owner's screenshot (2026-09-02): "the conversation looks a tiny bit shifted
// to the left and not aligned with the composer". Both bubble edges sat the
// same few px inside the composer's edges: the message list's scroller gives
// its vertical scrollbar layout space at the inline end, and the list column
// centres itself in what is left, so it lands half a scrollbar toward the
// inline start of the composer (which is outside the scroller and centres in
// the full width). The contract: the inline edges of the message column (an
// own bubble's inline-end edge, another party's bubble's inline-start edge)
// sit on the composer box's inline edges, within 1px, at phone and wide
// widths, ltr and rtl, with no scrollbar and with a scrollbar that takes space.
//
// Headless Chromium hides scrollbars by default (`--hide-scrollbars`), which
// makes every scrollbar 0px wide and the defect invisible, so this file
// launches its browser without that flag and asserts that the forced case
// really reserved a gutter. Everything is rendered by the real renderMessages
// (testhooks) into the real chat pane and measured with getBoundingClientRect.
// grep token: `column align`.

test.use({
  launchOptions: {
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    ignoreDefaultArgs: ['--hide-scrollbars']
  }
});

const T = 1_700_000_000_000;
const LONG =
  'A long enough line that the bubble reaches its maximum width and its outer edge is the edge of the column, not the end of a short sentence. '.repeat(
    3
  );

const PHONE = {w: 390, h: 844};
const WIDE = {w: 1280, h: 800};
const OUT = process.env.CYC_COLUMN_ALIGN_OUT;

type Scrollbar = 'none' | 'forced';
type Edges = {left: number; right: number};
type Geom = {
  dir: 'ltr' | 'rtl';
  scrollbar: Scrollbar;
  viewport: string;
  // Layout space the list's scroller gives to its scrollbar and gutter.
  scrollbarWidth: number;
  scrollHeight: number;
  clientHeight: number;
  composerBox: Edges;
  composerPill: Edges;
  composerInput: Edges;
  listScroll: Edges;
  listInner: Edges;
  ownBubble: Edges;
  otherBubble: Edges;
  // Signed deltas, bubble edge minus composer box edge, along the inline axis:
  // positive means the bubble edge is further toward the inline end.
  ownEndDelta: number;
  otherStartDelta: number;
};

async function measure(
  page: Page,
  dir: 'ltr' | 'rtl',
  scrollbar: Scrollbar,
  viewport: string
): Promise<Geom> {
  // `none`: two short lines and the scroller told to show no scrollbar (an
  // `auto` scroller still shows one here: the list overflows its box by 1px
  // even when nearly empty, a separate matter). `forced`: always show one.
  const text = scrollbar === 'none' ? 'ok' : LONG;
  const messages = [
    {id: 1, ts: T, status: 'delivered', role: 'claude', kind: 'text', text},
    {id: 2, ts: T + 1000, status: 'delivered', role: 'user', kind: 'text', text}
  ];
  return page.evaluate(
    async ({messages, dir, scrollbar, viewport}) => {
      document.documentElement.dir = dir;
      const pane = document.querySelector<HTMLElement>('#cyc-thread-pane')!;
      const scroll = pane.querySelector<HTMLElement>('.cyc-message-list-scroll')!;
      const inner = pane.querySelector<HTMLElement>('.cyc-message-list-inner')!;
      scroll.style.overflowY = scrollbar === 'forced' ? 'scroll' : 'hidden';
      const render = (window as any).__cycRenderMessages as (
        inner: HTMLElement,
        messages: unknown[],
        firstUnreadId?: number,
        events?: unknown[],
        uploadUrl?: (id: string) => string,
        onOpenFile?: () => void
      ) => void;
      render(inner, messages, undefined, undefined, () => '', () => {});
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const edges = (el: Element): {left: number; right: number} => {
        const r = el.getBoundingClientRect();
        return {left: Math.round(r.left * 100) / 100, right: Math.round(r.right * 100) / 100};
      };
      const q = (sel: string) => {
        const el = pane.querySelector<HTMLElement>(sel);
        if (!el) throw new Error(`column align: no ${sel}`);
        return el;
      };
      const own = q('[data-mid="2"] .cyc-message-content');
      const other = q('[data-mid="1"] .cyc-message-content');
      const composerBox = edges(q('.cyc-composer-box'));
      const ownBubble = edges(own);
      const otherBubble = edges(other);
      const rtl = dir === 'rtl';
      return {
        dir,
        scrollbar,
        viewport,
        scrollbarWidth: scroll.offsetWidth - scroll.clientWidth,
        scrollHeight: scroll.scrollHeight,
        clientHeight: scroll.clientHeight,
        composerBox,
        composerPill: edges(q('.cyc-composer-rows')),
        composerInput: edges(q('.cyc-composer-input')),
        listScroll: edges(scroll),
        listInner: edges(inner),
        ownBubble,
        otherBubble,
        ownEndDelta: rtl ? composerBox.left - ownBubble.left : ownBubble.right - composerBox.right,
        otherStartDelta: rtl
          ? composerBox.right - otherBubble.right
          : otherBubble.left - composerBox.left
      };
    },
    {messages, dir, scrollbar, viewport}
  );
}

function record(name: string, g: Geom) {
  if (!OUT) return;
  mkdirSync(OUT, {recursive: true});
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(g, null, 2));
}

function expectAligned(g: Geom) {
  const tag = `${g.viewport} ${g.dir} scrollbar=${g.scrollbar} (${g.scrollbarWidth}px of layout)`;
  if (g.scrollbar === 'forced') {
    expect(
      g.scrollbarWidth,
      `${tag}: the forced scrollbar took no layout space, so this case proves nothing ` +
        '(is the browser still launched with --hide-scrollbars?)'
    ).toBeGreaterThanOrEqual(1);
  } else {
    expect(g.scrollbarWidth, `${tag}: a scrollbar took layout space in the no-scrollbar case`).toBe(
      0
    );
  }
  expect(
    Math.abs(g.ownEndDelta),
    `${tag}: own bubble inline-end edge is ${g.ownEndDelta}px off the composer box ` +
      `(bubble ${JSON.stringify(g.ownBubble)}, composer ${JSON.stringify(g.composerBox)})`
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(g.otherStartDelta),
    `${tag}: other bubble inline-start edge is ${g.otherStartDelta}px off the composer box ` +
      `(bubble ${JSON.stringify(g.otherBubble)}, composer ${JSON.stringify(g.composerBox)})`
  ).toBeLessThanOrEqual(1);
}

for (const {name, w, h} of [
  {name: 'phone', ...PHONE},
  {name: 'wide', ...WIDE}
]) {
  for (const scrollbar of ['none', 'forced'] as Scrollbar[]) {
    test(`column align: ${name} ${w}x${h}, ltr and rtl, scrollbar ${scrollbar}`, async ({page}) => {
      await bootIsolated(page, w, h);
      await openFixtureChat(page);
      // Measure and record both directions first, so a failing ltr still
      // leaves the rtl numbers on disk.
      const geoms: Geom[] = [];
      for (const dir of ['ltr', 'rtl'] as const) {
        const g = await measure(page, dir, scrollbar, `${name}-${w}x${h}`);
        record(`${name}-${dir}-${scrollbar}`, g);
        geoms.push(g);
      }
      for (const g of geoms) expectAligned(g);
    });
  }
}
