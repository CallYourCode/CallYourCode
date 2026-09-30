import {test, expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {SESSION_NAME, startScrollEngine, type ScrollEngine} from './scrollEngine';

// GO-TO-BOTTOM FROM FAR ABOVE THE BOTTOM MUST NOT SET OFF AN OLDER-HISTORY BURST,
// AND REACHING THE TOP BY HAND MUST STILL LOAD OLDER (owner report, iPhone,
// 2026-09-30: "when I hit the go-to-bottom button it goes completely crazy" --
// older history poured in and the conversation jittered).
//
// Proven cause (app.log, dev=726ju, 2026-09-30T08:24:56): the reader sat far
// above the bottom of a long chat, tapped go-to-bottom, and the app's own
// re-window re-seated scrollTop UPWARD ~8k px to hold its anchor; the history
// pager read that machine re-seat as a reader flick to the top and answered with
// a loadEarlier burst (history.older dozens of times, the model grown far past
// its window). The pager was handed an isMachineScroll predicate but never used
// it; it now ignores machine re-seats (see cycHistoryPagerMachine.test.ts for the
// unit proof of the gate).
//
// The offline harness runs headless Chromium (Blink), whose layout is stable and
// synchronous, so it does not exhibit the iPhone-Safari measurement instability
// that drove the field burst -- go-to-bottom already lands clean here. This spec
// therefore guards the CONTRACT end to end through the real store + pager: a
// far go-to-bottom lands on the true bottom with no older-history for the tap,
// and a genuine hand-scroll to the top still loads older. grep token:
// `bottom runaway`.

test.use({hasTouch: true, timezoneId: 'UTC', locale: 'en-US'});

const PHONE = {width: 390, height: 844};
const SCROLL = '#cyc-thread-pane .cyc-message-list-scroll';
const BUTTON = '#cyc-thread-pane .cyc-jump-latest';
const INPUT = '#cyc-thread-pane .cyc-composer-input';

// A long conversation with a deep older-history tail below the open window, so
// canOlder() is true and a stray pager fetch would actually pull rows.
const COUNT = 800;

async function installLogTap(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __cycLogTap?: (e: string, f: Record<string, unknown>) => void;
      __cycLogCounts?: Record<string, number>;
      __cycMaxRows?: number;
    };
    const counts: Record<string, number> = {};
    w.__cycLogCounts = counts;
    w.__cycMaxRows = 0;
    w.__cycLogTap = (event, fields) => {
      counts[event] = (counts[event] ?? 0) + 1;
      if (event === 'chat.repaint' && typeof fields.rows === 'number')
        w.__cycMaxRows = Math.max(w.__cycMaxRows ?? 0, fields.rows as number);
    };
  });
}

const dist = (page: Page) =>
  page.evaluate((sel) => {
    const b = document.querySelector(sel) as HTMLElement;
    return Math.round(b.scrollHeight - b.scrollTop - b.clientHeight);
  }, SCROLL);

async function openChat(page: Page, eng: ScrollEngine) {
  await bootPinned(page, eng.port, {size: PHONE});
  await page.locator('.cyc-session-entry', {hasText: SESSION_NAME}).first().click();
  await page.waitForSelector(INPUT);
  await page.waitForTimeout(1600);
}

// Hand-scroll upward in real native-scroll steps until the reader sits well above
// the bottom, so the older history the reader reveals is loaded before the tap.
async function handScrollUp(page: Page, target: number) {
  for (let i = 0; i < 60; i++) {
    const d = await page.evaluate(
      (sel) => {
        const b = document.querySelector(sel) as HTMLElement;
        b.scrollTop = Math.max(0, b.scrollTop - 1200);
        b.dispatchEvent(new Event('scroll'));
        return b.scrollHeight - b.scrollTop - b.clientHeight;
      },
      SCROLL
    );
    await page.waitForTimeout(70);
    if (d >= target) break;
  }
  await page.waitForTimeout(800);
}

test('bottom runaway: go-to-bottom from far above the bottom lands clean, no older-history burst', async ({
  page
}) => {
  test.setTimeout(120_000);
  const eng = await startScrollEngine({count: COUNT});
  try {
    await openChat(page, eng);
    await handScrollUp(page, 8000);
    // Reset the counters so only the go-to-bottom tap is measured (the hand-scroll
    // above legitimately loaded older history on its way up).
    await installLogTap(page);

    const distAtOpen = await dist(page);
    expect(distAtOpen, 'the reader is not far above the bottom').toBeGreaterThan(4000);

    await page.locator(BUTTON).click();
    const band = await page.evaluate(
      (sel) =>
        new Promise<{band: number; big: number}>((done) => {
          const b = document.querySelector(sel) as HTMLElement;
          const tops: number[] = [];
          const t0 = performance.now();
          const tick = () => {
            tops.push(Math.round(b.scrollTop));
            if (performance.now() - t0 < 3500) requestAnimationFrame(tick);
            else {
              let big = 0;
              for (let i = 1; i < tops.length; i++) if (Math.abs(tops[i] - tops[i - 1]) >= 500) big++;
              done({band: Math.max(...tops) - Math.min(...tops), big});
            }
          };
          requestAnimationFrame(tick);
        }),
      SCROLL
    );
    await page.waitForTimeout(800);

    const after = await page.evaluate(() => {
      const w = window as unknown as {__cycLogCounts?: Record<string, number>; __cycMaxRows?: number};
      return {
        historyOlder: w.__cycLogCounts?.['history.older'] ?? 0,
        maxRows: w.__cycMaxRows ?? 0
      };
    });
    const distAfter = await dist(page);
    test.info().annotations.push({
      type: 'bottom-runaway',
      description: JSON.stringify({distAtOpen, distAfter, band, ...after})
    });

    expect(distAfter, 'go-to-bottom did not land at the true bottom').toBeLessThanOrEqual(2);
    expect(after.historyOlder, 'go-to-bottom set off an older-history burst').toBe(0);
    expect(after.maxRows, 'the model grew past its open window during go-to-bottom').toBeLessThanOrEqual(
      320
    );
    expect(band.big, 'scrollTop jumped by 500+ px repeatedly (a runaway)').toBe(0);
  } finally {
    await eng.close();
  }
});

test('bottom runaway: reaching the top by hand still loads older history', async ({page}) => {
  test.setTimeout(120_000);
  const eng = await startScrollEngine({count: COUNT});
  try {
    await openChat(page, eng);
    await installLogTap(page);
    for (let i = 0; i < 60; i++) {
      const atTop = await page.evaluate((sel) => {
        const b = document.querySelector(sel) as HTMLElement;
        b.scrollTop = Math.max(0, b.scrollTop - 1500);
        b.dispatchEvent(new Event('scroll'));
        return b.scrollTop <= 0;
      }, SCROLL);
      await page.waitForTimeout(60);
      if (atTop) break;
    }
    await page.waitForTimeout(600);
    const older = await page.evaluate(
      () =>
        (window as unknown as {__cycLogCounts?: Record<string, number>}).__cycLogCounts?.[
          'history.older'
        ] ?? 0
    );
    test.info().annotations.push({type: 'bottom-runaway-top', description: JSON.stringify({older})});
    expect(older, 'reaching the top by hand no longer loads older history').toBeGreaterThan(0);
  } finally {
    await eng.close();
  }
});
