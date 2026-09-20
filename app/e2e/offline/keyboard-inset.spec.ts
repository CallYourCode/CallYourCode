import {expect, test} from '@playwright/test';
import {bootIsolated, openFixtureChat} from './rig';

// The mechanical proof for `fix-keyboard-inset`: with the composer focused and the
// visual viewport shrunk (as the on-screen keyboard would), the composer's
// bounding box stays fully inside the visual viewport in every configured layout.
//
// The engine is never needed -- this boots the hermetic fixture chat and drives a
// controllable `window.visualViewport` stub (no real keyboard exists in headless
// Chromium). `window.__setVV(h)` shrinks the reported viewport height and fires the
// `resize` the shell listens on; before that the stub tracks `innerHeight`, so the
// keyboard-closed layout is byte-identical to production.
//
// grep token: `keyboard inset`.

test.use({timezoneId: 'UTC', locale: 'en-US'});

// Installs the visual-viewport stub and pins animation/caret so the closed-keyboard
// baseline never depends on when in a transition it landed. Runs at document-start.
const INIT = () => {
  let overridden = false;
  let forced = 0;
  const listeners: Record<string, ((ev: Event) => void)[]> = {resize: [], scroll: []};
  const vv = {
    get height() {
      return overridden ? forced : window.innerHeight;
    },
    get width() {
      return window.innerWidth;
    },
    get offsetTop() {
      return 0;
    },
    get offsetLeft() {
      return 0;
    },
    get pageTop() {
      return 0;
    },
    get pageLeft() {
      return 0;
    },
    get scale() {
      return 1;
    },
    addEventListener(t: string, cb: (ev: Event) => void) {
      (listeners[t] ||= []).push(cb);
    },
    removeEventListener(t: string, cb: (ev: Event) => void) {
      const a = listeners[t];
      if (a) {
        const i = a.indexOf(cb);
        if (i >= 0) a.splice(i, 1);
      }
    },
    dispatchEvent(ev: Event) {
      for (const cb of (listeners[ev.type] || []).slice()) cb(ev);
      return true;
    }
  };
  Object.defineProperty(window, 'visualViewport', {configurable: true, get: () => vv});
  (window as unknown as {__setVV: (h: number) => void}).__setVV = (h: number) => {
    overridden = true;
    forced = h;
    vv.dispatchEvent(new Event('resize'));
  };

  const s = document.createElement('style');
  s.textContent =
    '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;' +
    'transition-duration:0s!important;transition-delay:0s!important;' +
    'scroll-behavior:auto!important;caret-color:transparent!important}';
  document.addEventListener('DOMContentLoaded', () => document.documentElement.appendChild(s));
};

const SHOT = {animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.01} as const;

const LAYOUTS = [
  {name: 'phone', w: 390, h: 844},
  {name: 'desktop', w: 1280, h: 800}
] as const;

const KEYBOARD_PX = 300;

for (const layout of LAYOUTS) {
  test(`keyboard inset: composer stays above the shrunk viewport (${layout.name})`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    await page.addInitScript(INIT);
    await bootIsolated(page, layout.w, layout.h);
    await openFixtureChat(page);

    const composer = page.locator('.cyc-composer-main').first();
    await composer.waitFor();

    // Keyboard-closed baseline: the layout must be unchanged from production, where
    // `--cyc-kb-inset` is 0 and the composer sits flush at the layout bottom.
    await expect(composer).toHaveScreenshot(`composer-kb-closed-${layout.name}.png`, SHOT);

    // Focus the composer editable, then shrink the visual viewport as the keyboard
    // would. Only a focused composer lifts, so the click is the gate.
    await page.locator('.cyc-composer-input').first().click();
    const vvHeight = await page.evaluate((kb) => {
      (window as unknown as {__setVV: (h: number) => void}).__setVV(window.innerHeight - kb);
      return window.visualViewport!.height;
    }, KEYBOARD_PX);

    // The shell writes the inset on the next rAF; wait for it to land.
    await page.waitForFunction(() => {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue('--cyc-kb-inset')
        .trim();
      return parseFloat(v) > 8;
    });

    // Evidence of the open-keyboard state (per-layout screenshot, DoD "screenshot each").
    await page.screenshot({path: test.info().outputPath(`composer-kb-open-${layout.name}.png`)});

    const box = await composer.boundingBox();
    expect(box, 'the composer must be laid out').not.toBeNull();
    // The composer's bottom edge must sit inside the (shrunk) visual viewport, and
    // its top must not be pushed off-screen.
    expect(box!.y + box!.height).toBeLessThanOrEqual(vvHeight + 1);
    expect(box!.y).toBeGreaterThanOrEqual(0);
  });
}
