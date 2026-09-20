import {expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {SESSION_NAME, type ScrollEngine} from './scrollEngine';

// Shared geometry helpers for the chat-overlay specs (drop overlay, jump-latest
// button, date pill over the unread divider). Both views the phone screenshots
// were taken against: an iPhone-sized phone at the iPhone device scale, and one
// desktop viewport.

export const VIEWS = [
  {label: 'phone', size: {width: 393, height: 852}, scale: 3, touch: true},
  {label: 'desktop', size: {width: 1280, height: 900}, scale: 1, touch: false}
] as const;
export type View = (typeof VIEWS)[number];

export const PANE = '#cyc-thread-pane .cyc-thread';
export const SCROLL = '#cyc-thread-pane .cyc-message-list-scroll';
export const COMPOSER_PILL = '#cyc-thread-pane .cyc-composer-rows';
export const BLOCKS_ROW = '#cyc-thread-pane .cyc-blocks';
export const AGENTS_BAR = '#cyc-thread-pane .cyc-agents-bar';
export const HEADER = '#cyc-thread-pane .cyc-pane-header';

export type Rect = {x: number; y: number; width: number; height: number; right: number; bottom: number};

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
}

// The visible box of the first match, or null when it is absent, display:none,
// visibility:hidden, or fully transparent.
export async function rect(page: Page, sel: string): Promise<Rect | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return {x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom};
  }, sel);
}

export async function mustRect(page: Page, sel: string): Promise<Rect> {
  const r = await rect(page, sel);
  expect(r, `${sel} is not on screen`).not.toBeNull();
  return r!;
}

// The bottom edge of the chrome stacked over the top of the message area: the
// pane header, plus the agents bar when it is up.
export async function chromeBottom(page: Page): Promise<number> {
  const header = await mustRect(page, HEADER);
  const bar = await rect(page, AGENTS_BAR);
  return Math.max(header.bottom, bar?.bottom ?? 0);
}

export async function waitRows(page: Page): Promise<void> {
  await page.waitForFunction(
    (sel) => (document.querySelector(sel)?.querySelectorAll('.cyc-message').length ?? 0) > 0,
    SCROLL,
    {timeout: 15_000}
  );
}

// Boot against the scroll engine and open its long thread.
export async function bootAndOpen(page: Page, eng: ScrollEngine, view: View): Promise<void> {
  await bootPinned(page, eng.port, {size: view.size});
  await page.locator('.cyc-session-entry', {hasText: SESSION_NAME}).first().click();
  await waitRows(page);
  // The landing pin has run by 300 ms (scroll-landing.spec.ts samples there).
  await page.waitForTimeout(400);
}
