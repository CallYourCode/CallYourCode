import {test, expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {SESSION_NAME, startScrollEngine, type ScrollEngine} from './scrollEngine';

// THE OPEN-BOUNCE JITTER (fix-open-bounce). The owner opened a long chat at the
// bottom with unread and the last message "jittered": scrollTop oscillated a few
// tens of px, self-sustaining, with nobody touching the scroll -- the app logged
// `scroll.up.user` for a move it did not write, then re-pinned, over and over.
//
// Proven cause: while pinned at the bottom, a PURE re-window re-derived the top
// overscan boundary from the live scrollTop. The bottom pin writes scrollTop to
// the end every re-window, carrying its own sub-pixel jitter; when that offset
// wobbled across a row's measured extent the boundary flipped that row in and
// out of the mounted set, and because the row's cached measurement differed from
// its rendered height the top spacer (so scrollHeight) turned bistable. The pin
// chased the taller state, the browser clamped the shorter, the clamp re-entered
// the re-window, and it looped every frame. computeWindow now holds the boundary
// while pinned at the bottom on a pure re-window, so the window cannot flip.
//
// The rig opens the seeded long thread pinned at the bottom, drives the same
// store repaints the field saw (overlay tool events landing above the newest
// bubble), and records scrollTop every animation frame plus the app's own
// scroll diagnostics. Before the fix this counts many `scroll.up.user` emits and
// a bouncing scrollTop; after, zero. grep token: `open bounce`.

test.use({timezoneId: 'UTC', locale: 'en-US'});

const INPUT = '#cyc-thread-pane .cyc-composer-input';
const SCROLL = '#cyc-thread-pane .cyc-message-list-scroll';

const VIEWPORTS = {
  laptop: {width: 1440, height: 900},
  phone: {width: 390, height: 844}
} as const;

const RECORD_MS = 20_000;

type Probe = {
  distToEndAtOpen: number;
  jitterFrames: number;
  bandPx: number;
  scrollUpUser: number;
  pagerCover: number;
};

// Count every cyclog emit so the rate-limited scroll diagnostics still surface:
// a non-zero scroll.up.user means the app saw an upward scroll it did not write.
async function installLogTap(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __cycLogTap?: (e: string, f: Record<string, unknown>) => void;
      __cycLogCounts?: Record<string, number>;
    };
    const counts: Record<string, number> = {};
    w.__cycLogCounts = counts;
    w.__cycLogTap = (event) => {
      counts[event] = (counts[event] ?? 0) + 1;
    };
  });
}

async function recordWhilePinned(page: Page, eng: ScrollEngine, ms: number): Promise<Probe> {
  const distToEndAtOpen = await page.evaluate((sel) => {
    const b = document.querySelector(sel) as HTMLElement;
    return Math.round(b.scrollHeight - b.scrollTop - b.clientHeight);
  }, SCROLL);

  // Drive the store repaint the field saw: an overlay tool event with an earlier
  // ts lands above the newest bubble and repaints the pinned window.
  const drive = setInterval(() => {
    eng.event('tool', 'ran a check', {ts: eng.lastTs() - 5_000, tool: 'Bash'});
  }, 2_000);

  const frames = await page.evaluate(
    ({sel, ms}) =>
      new Promise<{jitterFrames: number; bandPx: number}>((done) => {
        const box = document.querySelector(sel) as HTMLElement;
        const tops: number[] = [];
        const t0 = performance.now();
        const tick = () => {
          tops.push(Math.round(box.scrollTop));
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else {
            let jitterFrames = 0;
            for (let i = 1; i < tops.length; i++)
              if (Math.abs(tops[i] - tops[i - 1]) >= 3) jitterFrames++;
            const uniq = Array.from(new Set(tops)).sort((a, b) => a - b);
            done({jitterFrames, bandPx: (uniq[uniq.length - 1] ?? 0) - (uniq[0] ?? 0)});
          }
        };
        requestAnimationFrame(tick);
      }),
    {sel: SCROLL, ms}
  );

  clearInterval(drive);
  const counts = await page.evaluate(
    () => (window as unknown as {__cycLogCounts?: Record<string, number>}).__cycLogCounts ?? {}
  );
  return {
    distToEndAtOpen,
    jitterFrames: frames.jitterFrames,
    bandPx: frames.bandPx,
    scrollUpUser: counts['scroll.up.user'] ?? 0,
    pagerCover: counts['pager.cover'] ?? 0
  };
}

async function openPinnedUnread(page: Page, eng: ScrollEngine, size: {width: number; height: number}) {
  await bootPinned(page, eng.port, {size});
  await page.locator('.cyc-session-entry', {hasText: SESSION_NAME}).first().click();
  await page.waitForSelector(INPUT);
  // Let the open settle (landing + the settle grace) before measuring.
  await page.waitForTimeout(1500);
}

for (const which of ['laptop', 'phone'] as const) {
  test(`open bounce (${which}): a pinned-bottom open does not oscillate under repaints`, async ({
    page
  }) => {
    test.setTimeout(RECORD_MS + 60_000);
    const eng = await startScrollEngine({count: 400, unread: 5, eventsEvery: 9});
    try {
      await openPinnedUnread(page, eng, VIEWPORTS[which]);
      await installLogTap(page);
      const probe = await recordWhilePinned(page, eng, RECORD_MS);
      test.info().annotations.push({type: 'open-bounce', description: JSON.stringify(probe)});

      // The open landed at the bottom.
      expect(probe.distToEndAtOpen, 'the open did not land at the bottom').toBeLessThanOrEqual(2);
      // The view does not move: no upward scroll the app did not write, and the
      // per-frame scrollTop never jumps. Before the fix this ran ~5-6 Hz for the
      // whole window (scroll.up.user in the tens, a bouncing band); after, zero.
      expect(probe.scrollUpUser, 'the app saw an upward scroll it did not write').toBe(0);
      expect(probe.jitterFrames, 'scrollTop jittered frame-to-frame').toBe(0);
      expect(probe.bandPx, 'scrollTop wandered across frames').toBeLessThanOrEqual(2);
    } finally {
      await eng.close();
    }
  });
}
