import {expect, test, type Page} from '@playwright/test';
import {evidenceShot} from './rig';
import {startScrollEngine} from './scrollEngine';
import {dropFiles} from './dropKit';
import {BLOCKS_ROW, bootAndOpen, COMPOSER_PILL, mustRect, PANE, SCROLL, VIEWS} from './chatGeom';

// THE SCROLL-TO-BOTTOM BUTTON FLOATS ABOVE THE COMPOSER (fix-dnd-bottom, item
// 2). The phone screenshots: a white square with hard corners jammed against
// the composer and clipped by it, the arrow at its very bottom edge; with an
// attachment chip staged, the chip row pushed the composer up and the button
// stayed behind it. The contract: a squarish floating button (the fixed 14px
// corner radius a7637c9 gave both corner buttons via the un-layered
// `.cyc-corner-btn` rule, deliberately not a circle), with the app's shadow,
// fully on screen, a clear gap above the composer pill (chip row included),
// never clipped. Both views.
// grep token: `jump latest button`.

test.use({timezoneId: 'UTC', locale: 'en-US'});

const SHOTS = 'jump-latest-button';
const BUTTON = '#cyc-thread-pane .cyc-jump-latest';
const GAP = 8;

async function scrollUp(page: Page) {
  await page.evaluate((sel) => {
    const s = document.querySelector<HTMLElement>(sel)!;
    s.scrollTop = Math.max(0, s.scrollTop - 2000);
  }, SCROLL);
  await expect(page.locator(PANE)).toHaveAttribute('data-cyc-godown', '');
  await page.waitForTimeout(300); // the reveal fade
}

async function expectFloating(page: Page, view: (typeof VIEWS)[number], why: string) {
  const btn = await mustRect(page, BUTTON);
  const pill = await mustRect(page, COMPOSER_PILL);
  const style = await page.locator(BUTTON).evaluate((el) => {
    const cs = getComputedStyle(el);
    return {radius: cs.borderTopLeftRadius, shadow: cs.boxShadow, overflowClip: cs.overflow};
  });

  // Fully inside the viewport.
  expect(btn.x, `${why}: off the left edge`).toBeGreaterThanOrEqual(0);
  expect(btn.y, `${why}: off the top edge`).toBeGreaterThanOrEqual(0);
  expect(btn.right, `${why}: off the right edge`).toBeLessThanOrEqual(view.size.width);
  expect(btn.bottom, `${why}: off the bottom edge`).toBeLessThanOrEqual(view.size.height);

  // A clear gap above the composer pill, so nothing can clip it.
  expect(btn.bottom, `${why}: the button sits on or under the composer pill`).toBeLessThanOrEqual(
    pill.y - GAP
  );

  // Squarish: the fixed 14px corner radius (`.cyc-corner-btn`), NOT a circle;
  // anything at or past half the box would be the old round style.
  const radius = parseFloat(style.radius);
  expect(radius, `${why}: radius ${style.radius} is not the squarish 14px`).toBeCloseTo(14, 1);
  expect(radius, `${why}: radius ${style.radius} on a ${btn.width}px box is a circle`).toBeLessThan(
    btn.width / 2 - 0.5
  );
  // The app's shadow, not none.
  expect(style.shadow, `${why}: no shadow`).not.toBe('none');

  // The whole button, arrow included, is painted: it is the topmost element
  // at its own centre and at its bottom edge (the part the pill was covering).
  const hits = await page.evaluate(
    ({sel, pts}) => {
      const btn = document.querySelector(sel)!;
      return pts.map(([x, y]) => {
        const at = document.elementFromPoint(x, y);
        return !!at && (at === btn || btn.contains(at));
      });
    },
    {
      sel: BUTTON,
      pts: [
        [btn.x + btn.width / 2, btn.y + btn.height / 2],
        [btn.x + btn.width / 2, btn.bottom - 2]
      ]
    }
  );
  expect(hits[0], `${why}: something covers the button's centre`).toBe(true);
  expect(hits[1], `${why}: something covers the button's bottom edge`).toBe(true);
}

for (const view of VIEWS) {
  test.describe(view.label, () => {
    test.use({
      viewport: view.size,
      deviceScaleFactor: view.scale,
      hasTouch: view.touch,
      isMobile: view.touch
    });

    test(`jump latest button (${view.label}): squarish, shadowed, floating clear of the composer and the chip row`, async ({
      page
    }) => {
      test.setTimeout(90_000);
      const eng = await startScrollEngine({count: 60});
      try {
        await bootAndOpen(page, eng, view);
        await scrollUp(page);
        await evidenceShot(page, SHOTS, `${view.label}-plain`);
        await expectFloating(page, view, 'plain composer');

        // Stage an attachment: the chip row grows the composer upward and the
        // button must rise with it.
        await dropFiles(page, PANE, 'screenshot.txt');
        await expect(page.locator(BLOCKS_ROW)).toBeVisible();
        await page.waitForTimeout(300);
        await expect(page.locator(PANE)).toHaveAttribute('data-cyc-godown', '');
        await evidenceShot(page, SHOTS, `${view.label}-chip-row`);
        const chips = await mustRect(page, BLOCKS_ROW);
        const btn = await mustRect(page, BUTTON);
        expect(btn.bottom, 'the button sits behind the chip row').toBeLessThanOrEqual(
          chips.y - GAP
        );
        await expectFloating(page, view, 'composer with a chip row');
      } finally {
        await eng.close();
      }
    });
  });
}
