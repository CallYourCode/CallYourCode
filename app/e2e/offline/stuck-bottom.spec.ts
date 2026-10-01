import {test, expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {SESSION_NAME, startScrollEngine, type ScrollEngine} from './scrollEngine';

// STUCK AT THE BOTTOM (owner, Android tablet, Chrome, 1069px, touch, 2026-10-01:
// "In BZ Distributor I tried to scroll up and it just wouldn't. It seemed
// stuck."). The app.log (dev=tqljx) showed an upward touch drag that repeatedly
// started from the SAME bottom offset and only gained a few px: something kept
// putting the view back at the end as the reader dragged.
//
// PROVEN cause (measured in _explore + code): on a touch build Chrome fires
// `pointercancel` the instant it claims a vertical pan as a native scroll, which
// cleared the surface's `pointerHeld` flag WHILE the finger was still dragging.
// Two writers re-pin to the bottom and were gated on that stale flag (or not
// gated at all):
//   - chatSurface onListResize (the ResizeObserver): re-pins while `pinnedToBottom`
//     and a finger is down (content still settling: image bytes, card re-measure).
//   - storeBindings' rAF: on a new row/event it scrollToBottom()s whenever the
//     reader WAS near the bottom (clientHeight/3), with no finger gate at all.
// So a reader dragging up near the bottom while replies stream (or images settle)
// is slammed straight back to the end, every frame.
//
// This spec drives a real TOUCH drag (CDP Input.dispatchTouchEvent sequences)
// upward on a bottom-pinned chat while the agent streams replies, at the owner's
// tablet width and a phone width. It counts, per animation frame, the times the
// scroller moved TOWARD the bottom while a finger was down (a snap-back the
// reader did not cause) and the app's own bottom-pin log writes that landed
// during an active touch. Before the fix both are large; after, zero. grep
// token: `stuck bottom`.

test.use({hasTouch: true, isMobile: true, timezoneId: 'UTC', locale: 'en-US'});

const INPUT = '#cyc-thread-pane .cyc-composer-input';
const SCROLL = '#cyc-thread-pane .cyc-message-list-scroll';

const VIEWPORTS = {
  tablet: {width: 1069, height: 1200},
  phone: {width: 390, height: 844}
} as const;

type DragProbe = {
  slamBacks: number;
  pinDuringTouch: number;
  towardWrites: number;
  reachedDist: number;
};

async function instrument(page: Page) {
  await page.evaluate((sel) => {
    const box = document.querySelector(sel) as HTMLElement;
    const w = window as unknown as Record<string, unknown>;
    w.__touchActive = false;
    box.addEventListener('touchstart', () => (w.__touchActive = true), {passive: true});
    window.addEventListener(
      'touchend',
      (e: TouchEvent) => {
        if (!e.touches || e.touches.length === 0) w.__touchActive = false;
      },
      {passive: true}
    );
    window.addEventListener('touchcancel', () => (w.__touchActive = false), {passive: true});

    w.__pinDuringTouch = 0;
    w.__towardWrites = 0;
    (w as {__cycLogTap?: unknown}).__cycLogTap = (event: string, fields: Record<string, unknown>) => {
      if (event !== 'scroll.write' && event !== 'scroll.pin') return;
      const tag = String(fields.tag ?? '');
      if (tag !== 'toBottom' && tag !== 'rewindow.bottom') return;
      w.__towardWrites = (w.__towardWrites as number) + 1;
      if (w.__touchActive) w.__pinDuringTouch = (w.__pinDuringTouch as number) + 1;
    };

    w.__frames = [];
    w.__sampling = true;
    const tick = () => {
      if (!w.__sampling) return;
      (w.__frames as unknown[]).push({
        top: Math.round(box.scrollTop),
        dist: Math.round(box.scrollHeight - box.scrollTop - box.clientHeight),
        touch: w.__touchActive
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, SCROLL);
}

// A sustained upward touch drag: the finger moves DOWN the screen (revealing
// older messages, scrollTop drops); the agent streams a reply on every step so
// content keeps arriving at the bottom while the finger is down.
async function dragUpWhileReplying(
  page: Page,
  eng: ScrollEngine,
  width: number,
  steps: number
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const x = Math.round(width / 2);
  let y = 300;
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
  for (let i = 0; i < steps; i++) {
    y += 10;
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x, y}]});
    eng.say(`streamed reply line ${i} that wraps across the width of the bubble on a wide tablet`);
    await page.waitForTimeout(70);
    if (y > 900) {
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
      y = 300;
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
    }
  }
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
}

async function readProbe(page: Page): Promise<DragProbe> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__sampling = false;
    const f = w.__frames as {top: number; dist: number; touch: boolean}[];
    // A slam-back: while a finger is down, the view returned to the END (dist near
    // zero) AFTER the reader had already dragged it well clear of the bottom. This
    // reads distToEnd, so the benign rewindow.anchor compensation (which shifts
    // scrollTop to HOLD a row steady, leaving distToEnd all but unchanged) is not
    // counted; only a real yank to the end is.
    let slamBacks = 0;
    let clearedBy = 0;
    for (const fr of f) {
      if (fr.dist > 500) clearedBy++;
      if (fr.touch && clearedBy > 0 && fr.dist <= 40) {
        slamBacks++;
        clearedBy = 0;
      }
    }
    return {
      slamBacks,
      pinDuringTouch: w.__pinDuringTouch as number,
      towardWrites: w.__towardWrites as number,
      reachedDist: Math.max(...f.map((x) => x.dist))
    };
  });
}

async function openPinned(page: Page, eng: ScrollEngine, size: {width: number; height: number}) {
  await bootPinned(page, eng.port, {size});
  await page.locator('.cyc-session-entry', {hasText: SESSION_NAME}).first().click();
  await page.waitForSelector(INPUT);
  // Let the open land at the bottom and settle before the drag.
  await page.waitForTimeout(800);
}

for (const which of ['tablet', 'phone'] as const) {
  test(`stuck bottom (${which}): an upward touch drag is not snapped back while replies stream`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const size = VIEWPORTS[which];
    const eng = await startScrollEngine({count: 160, imageEvery: 5, imageDelayMs: 300});
    try {
      await openPinned(page, eng, size);
      const atOpen = await page.evaluate((sel) => {
        const b = document.querySelector(sel) as HTMLElement;
        return Math.round(b.scrollHeight - b.scrollTop - b.clientHeight);
      }, SCROLL);
      expect(atOpen, 'the open did not land at the bottom').toBeLessThanOrEqual(2);

      await instrument(page);
      await dragUpWhileReplying(page, eng, size.width, 60);
      const probe = await readProbe(page);
      test.info().annotations.push({type: 'stuck-bottom', description: JSON.stringify(probe)});

      // The reader actually left the bottom (the drag did scroll).
      expect(probe.reachedDist, 'the drag never moved the view off the bottom').toBeGreaterThan(
        size.height
      );
      // No pin write landed while a finger was down, and the view was never
      // yanked back to the end after the reader had cleared the bottom.
      expect(probe.pinDuringTouch, 'a bottom pin wrote during an active touch drag').toBe(0);
      expect(probe.slamBacks, 'the view was slammed back to the bottom mid-drag').toBe(0);
    } finally {
      await eng.close();
    }
  });
}
