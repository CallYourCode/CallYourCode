import {afterAll, beforeEach, describe, expect, test} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser} from 'playwright';

// Real-Chromium layout coverage for the file explorer.

import {FX_DAY, FX_NIGHT, paintFx} from '../plugins/files/filesPaint';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES_CSS = resolve(HERE, '..', 'plugins', 'files', 'files.css');

const filesCss = () => readFileSync(FILES_CSS, 'utf8').replace(/^@charset[^;]*;\s*/, '');

const rgb = (hex: string): string => {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

const el = (parent: HTMLElement, tag: string, cls: string, text = ''): HTMLElement => {
  const node = document.createElement(tag);
  node.className = cls;
  if (text) node.textContent = text;
  parent.append(node);
  return node;
};

// Build and paint the explorer overlay for a width state.
function paintedOverlay(wide: boolean, theme: 'light' | 'dark'): string {
  document.documentElement.dataset.theme = theme;
  document.body.innerHTML = '';

  const overlay = document.createElement('div');
  overlay.className = `cyc-fx ${wide ? 'cyc-fx-wide' : 'cyc-fx-phone'}`;
  const track = el(overlay, 'div', 'cyc-fx-track');

  const paneA = el(track, 'div', 'cyc-fx-pane cyc-fx-a');
  el(paneA, 'div', 'cyc-fx-head', 'head');
  const treeScroll = el(paneA, 'div', 'cyc-fx-scroll');
  const tree = el(treeScroll, 'div', 'cyc-fx-tree');
  const row = el(tree, 'div', 'cyc-fx-row cyc-fx-sel');
  el(row, 'span', 'cyc-fx-name', 'file.ts');
  el(paneA, 'div', 'cyc-fx-foot', 'foot');

  const rail = el(track, 'div', 'cyc-fx-rail');
  el(rail, 'button', 'cyc-fx-rail-half cyc-fx-rail-a cyc-fx-rail-on', 'a');
  el(rail, 'button', 'cyc-fx-rail-half cyc-fx-rail-b', 'b');
  el(rail, 'div', 'cyc-fx-rail-grip');

  const paneB = el(track, 'div', 'cyc-fx-pane cyc-fx-b');
  el(paneB, 'div', 'cyc-fx-head', 'header');
  const tabs = el(paneB, 'div', 'cyc-fx-tabs');
  el(tabs, 'button', 'cyc-fx-tab cyc-fx-tab-on', 'file.ts');
  el(paneB, 'div', 'cyc-fx-scroll cyc-fx-file-scroll', 'body');
  el(paneB, 'div', 'cyc-fx-foot', 'foot');

  document.body.append(overlay);
  paintFx(overlay);
  const html = overlay.outerHTML;
  document.body.innerHTML = '';
  return html;
}

type Probe = {sel: string; props?: string[]; rect?: boolean};
type Result = {
  found: boolean;
  props: Record<string, string>;
  top: number;
  left: number;
  width: number;
  height: number;
};

// Read computed overlay geometry in Chromium.
async function inspect(
  overlayHtml: string,
  theme: 'light' | 'dark',
  probes: Probe[]
): Promise<Result[]> {
  const page = await (await getBrowser()).newPage();
  await page.setViewportSize({width: 1000, height: 700});
  try {
    const doc =
      `<!DOCTYPE html><html data-theme="${theme}"><head><meta charset="utf-8"><style>` +
      filesCss() +
      `</style></head><body><div id="cyc-app"><div id="cyc-stage">${overlayHtml}</div></div></body></html>`;
    await page.setContent(doc, {waitUntil: 'load'});
    return await page.evaluate((list: Probe[]) => {
      return list.map((t) => {
        const node = document.querySelector(t.sel) as HTMLElement | null;
        if (!node) return {found: false, props: {}, top: 0, left: 0, width: 0, height: 0};
        const cs = getComputedStyle(node);
        const props: Record<string, string> = {};
        for (const p of t.props ?? []) props[p] = cs.getPropertyValue(p);
        const r = node.getBoundingClientRect();
        return {found: true, props, top: r.top, left: r.left, width: r.width, height: r.height};
      });
    }, probes);
  } finally {
    await page.close();
  }
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'light';
  document.body.innerHTML = '';
});
afterAll(async () => {
  await browser?.close();
});

describe('pane-B viewer order (was the .cyc-fx-b / .cyc-fx-phone order rules)', () => {
  test('wide: header, then the tab strip, then the file, then the footer', async () => {
    const [head, tabs, scroll, foot] = await inspect(paintedOverlay(true, 'light'), 'light', [
      {sel: '.cyc-fx-b > .cyc-fx-head', rect: true},
      {sel: '.cyc-fx-b > .cyc-fx-tabs', rect: true},
      {sel: '.cyc-fx-b > .cyc-fx-scroll', rect: true},
      {sel: '.cyc-fx-b > .cyc-fx-foot', rect: true}
    ]);
    expect(head.top).toBeLessThan(tabs.top);
    expect(tabs.top).toBeLessThan(scroll.top);
    expect(scroll.top).toBeLessThan(foot.top);
  });

  test('phone: the file rises above the tab strip, which drops to just over the footer', async () => {
    const [head, tabs, scroll, foot] = await inspect(paintedOverlay(false, 'light'), 'light', [
      {sel: '.cyc-fx-b > .cyc-fx-head', rect: true},
      {sel: '.cyc-fx-b > .cyc-fx-tabs', rect: true},
      {sel: '.cyc-fx-b > .cyc-fx-scroll', rect: true},
      {sel: '.cyc-fx-b > .cyc-fx-foot', rect: true}
    ]);
    expect(head.top).toBeLessThan(scroll.top);
    expect(scroll.top).toBeLessThan(tabs.top);
    expect(tabs.top).toBeLessThan(foot.top);
  });
});

describe('the split rail (was the .cyc-fx-wide .cyc-fx-rail* rules)', () => {
  test('wide: a col-resize splitter, halves collapsed, grip overhanging both edges', async () => {
    const html = paintedOverlay(true, 'light');
    const [rail, halfA, grip] = await inspect(html, 'light', [
      {sel: '.cyc-fx-rail', props: ['cursor', 'border-left-width', 'border-right-width']},
      {sel: '.cyc-fx-rail-a', props: ['display']},
      {sel: '.cyc-fx-rail-grip', props: ['display', 'position', 'left', 'right', 'cursor']}
    ]);
    expect(rail.props.cursor).toBe('col-resize');
    expect(rail.props['border-left-width']).toBe('0px');
    expect(rail.props['border-right-width']).toBe('0px');
    expect(halfA.props.display).toBe('none');
    expect(grip.props.display).toBe('block');
    expect(grip.props.position).toBe('absolute');
    expect(grip.props.left).toBe('-4px');
    expect(grip.props.right).toBe('-4px');
    expect(grip.props.cursor).toBe('col-resize');
  });

  test('phone: the two nav halves are shown, the grip is gone, the side borders are back', async () => {
    const html = paintedOverlay(false, 'light');
    const [rail, halfA, grip] = await inspect(html, 'light', [
      {sel: '.cyc-fx-rail', props: ['cursor', 'border-left-width', 'border-right-width']},
      {sel: '.cyc-fx-rail-a', props: ['display']},
      {sel: '.cyc-fx-rail-grip', props: ['display']}
    ]);
    expect(rail.props.cursor).not.toBe('col-resize');
    expect(rail.props['border-left-width']).toBe('1px');
    expect(rail.props['border-right-width']).toBe('1px');
    expect(halfA.props.display).toBe('flex');
    expect(grip.props.display).toBe('none');
  });
});

describe('the tab strip divider (was the .cyc-fx-phone .cyc-fx-b .cyc-fx-tabs rule)', () => {
  test('wide: the 1px divider sits on the bottom edge', async () => {
    const [tabs] = await inspect(paintedOverlay(true, 'light'), 'light', [
      {sel: '.cyc-fx-tabs', props: ['border-top-width', 'border-bottom-width']}
    ]);
    expect(tabs.props['border-top-width']).toBe('0px');
    expect(tabs.props['border-bottom-width']).toBe('1px');
  });

  test('phone: the divider moves to the top edge', async () => {
    const [tabs] = await inspect(paintedOverlay(false, 'light'), 'light', [
      {sel: '.cyc-fx-tabs', props: ['border-top-width', 'border-bottom-width', 'padding-left']}
    ]);
    expect(tabs.props['border-top-width']).toBe('1px');
    expect(tabs.props['border-bottom-width']).toBe('0px');
    // The phone override also opens the safe-area gutter from 0.5rem to 1rem.
    expect(tabs.props['padding-left']).toBe('16px');
  });
});

describe('the themed edges survive the migration', () => {
  test('day: the phone rail carries the day divider ink, the tab strip its inactive fill', async () => {
    const [rail, tabs] = await inspect(paintedOverlay(false, 'light'), 'light', [
      {sel: '.cyc-fx-rail', props: ['border-left-color']},
      {sel: '.cyc-fx-tabs', props: ['background-color']}
    ]);
    expect(rail.props['border-left-color']).toBe(rgb(FX_DAY.tabBorder));
    expect(tabs.props['background-color']).toBe(rgb(FX_DAY.tabInactiveBg));
  });

  test('night: the same edges take the night literals', async () => {
    const [rail, tabs] = await inspect(paintedOverlay(false, 'dark'), 'dark', [
      {sel: '.cyc-fx-rail', props: ['border-left-color']},
      {sel: '.cyc-fx-tabs', props: ['background-color']}
    ]);
    expect(rail.props['border-left-color']).toBe(rgb(FX_NIGHT.tabBorder));
    expect(tabs.props['background-color']).toBe(rgb(FX_NIGHT.tabInactiveBg));
  });
});

// Full explorer skeleton for constant geometry checks.
function paintedChrome(theme: 'light' | 'dark'): string {
  document.documentElement.dataset.theme = theme;
  document.body.innerHTML = '';

  const overlay = document.createElement('div');
  overlay.className = 'cyc-fx cyc-fx-wide';
  const track = el(overlay, 'div', 'cyc-fx-track');

  const paneA = el(track, 'div', 'cyc-fx-pane cyc-fx-a');
  const headA = el(paneA, 'div', 'cyc-fx-head');
  el(headA, 'button', 'cyc-fx-back', '<');
  const titles = el(headA, 'div', 'cyc-fx-head-titles');
  const titleRow = el(titles, 'div', 'cyc-fx-title-row');
  el(titleRow, 'div', 'cyc-fx-title', 'proj');
  el(titleRow, 'span', 'cyc-fx-lang', 'TS');
  const scroll = el(paneA, 'div', 'cyc-fx-scroll');
  const tree = el(scroll, 'div', 'cyc-fx-tree');
  const row = el(tree, 'div', 'cyc-fx-row');
  el(row, 'span', 'cyc-fx-indent');
  el(row, 'span', 'cyc-fx-twist');
  el(row, 'span', 'cyc-fx-icon');
  el(row, 'span', 'cyc-fx-name', 'file.ts');
  const foot = el(paneA, 'div', 'cyc-fx-foot');
  el(foot, 'div', 'cyc-fx-foot-left', 'left');
  el(foot, 'div', 'cyc-fx-foot-right', 'right');

  const paneB = el(track, 'div', 'cyc-fx-pane cyc-fx-b');
  const headB = el(paneB, 'div', 'cyc-fx-head');
  const view = el(headB, 'div', 'cyc-fx-view');
  el(view, 'button', 'cyc-fx-vbtn', 'A+');
  const tabs = el(paneB, 'div', 'cyc-fx-tabs');
  const tab = el(tabs, 'button', 'cyc-fx-tab', 'file.ts');
  el(tab, 'span', 'cyc-fx-tab-x', '\u00d7');

  const rail = el(track, 'div', 'cyc-fx-rail');
  el(rail, 'button', 'cyc-fx-rail-half cyc-fx-rail-a', 'a');

  document.body.append(overlay);
  paintFx(overlay);
  const html = overlay.outerHTML;
  document.body.innerHTML = '';
  return html;
}

describe('constant chrome geometry survives the migration (was the #cyc-app .cyc-fx* rules)', () => {
  test('panes stack their columns; heads/foot pin, the scroll fills', async () => {
    const [pane, head, scroll, foot] = await inspect(paintedChrome('light'), 'light', [
      {sel: '.cyc-fx-a', props: ['display', 'flex-direction']},
      {
        sel: '.cyc-fx-a > .cyc-fx-head',
        props: ['display', 'flex-grow', 'min-height', 'padding-top']
      },
      {sel: '.cyc-fx-a > .cyc-fx-scroll', props: ['flex-grow', 'overflow-y']},
      {sel: '.cyc-fx-a > .cyc-fx-foot', props: ['border-top-width', 'min-height', 'align-items']}
    ]);
    expect(pane.props.display).toBe('flex');
    expect(pane.props['flex-direction']).toBe('column');
    expect(head.props.display).toBe('flex');
    expect(head.props['flex-grow']).toBe('0');
    expect(head.props['min-height']).toBe('48px'); // 3rem
    expect(head.props['padding-top']).toBe('8px'); // 0.5rem
    expect(scroll.props['flex-grow']).toBe('1');
    expect(scroll.props['overflow-y']).toBe('auto');
    expect(foot.props['border-top-width']).toBe('1px');
    expect(foot.props['min-height']).toBe('28px'); // 1.75rem
    expect(foot.props['align-items']).toBe('center');
  });

  test('the toolbars, buttons and tree row take their box literals', async () => {
    const [back, view, row, twist, icon, tab] = await inspect(paintedChrome('light'), 'light', [
      {sel: '.cyc-fx-back', props: ['border-radius', 'justify-content', 'width', 'height']},
      {sel: '.cyc-fx-view', props: ['display', 'column-gap']},
      {sel: '.cyc-fx-row', props: ['display', 'align-items', 'white-space']},
      {sel: '.cyc-fx-twist', props: ['width', 'justify-content']},
      {sel: '.cyc-fx-icon', props: ['width', 'margin-right']},
      {sel: '.cyc-fx-tab', props: ['max-width', 'border-right-width', 'display']}
    ]);
    expect(back.props['border-radius']).toBe('3px'); // 0.1875rem
    expect(back.props['justify-content']).toBe('center');
    expect(back.props.width).toBe('28px'); // fine-pointer 1.75rem base
    expect(back.props.height).toBe('28px');
    expect(view.props.display).toBe('flex');
    expect(view.props['column-gap']).toBe('1px'); // 0.0625rem
    expect(row.props.display).toBe('flex');
    expect(row.props['align-items']).toBe('center');
    expect(row.props['white-space']).toBe('nowrap');
    expect(twist.props.width).toBe('18px'); // 1.125rem
    expect(twist.props['justify-content']).toBe('center');
    expect(icon.props.width).toBe('20px'); // 1.25rem
    expect(icon.props['margin-right']).toBe('5px'); // 0.3125rem
    expect(tab.props['max-width']).toBe('176px'); // 11rem
    expect(tab.props['border-right-width']).toBe('1px');
    expect(tab.props.display).toBe('flex');
  });

  test('the wide rail lays its half out as a centred column', async () => {
    const [half] = await inspect(paintedChrome('light'), 'light', [
      {sel: '.cyc-fx-rail-half', props: ['flex-direction', 'align-items', 'justify-content']}
    ]);
    expect(half.props['flex-direction']).toBe('column');
    expect(half.props['align-items']).toBe('center');
    expect(half.props['justify-content']).toBe('center');
  });
});

describe('selection focus ring rides on the same paint', () => {
  test('a selected tree row takes the selection fill and the focus-outline ring', async () => {
    const [row] = await inspect(paintedOverlay(true, 'light'), 'light', [
      {sel: '.cyc-fx-row.cyc-fx-sel', props: ['background-color', 'box-shadow']}
    ]);
    expect(row.props['background-color']).toBe(rgb(FX_DAY.selBg));
    expect(row.props['box-shadow']).toContain(rgb(FX_DAY.focusOutline));
  });
});
