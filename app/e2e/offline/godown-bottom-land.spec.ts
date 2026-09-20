import {expect, test, type Page} from '@playwright/test';
import {evidenceShot} from './rig';
import {startScrollEngine} from './scrollEngine';
import {bootAndOpen, PANE, SCROLL, VIEWS} from './chatGeom';

// THE GO-TO-BOTTOM ARROW LANDS ON THE TRUE BOTTOM AND MOVES NOTHING ELSE
// (owner report, laptop screenshot, 2026-09-05: "when u hit the go to bottom
// arrow it adds some padding at the bottom of the input box").
//
// Confirmed cause, measured live in this suite before the fix: the handler
// scrolled via scrollIntoView, which scrolls EVERY scrollable ancestor box.
// #cyc-columns is overflow:hidden -- still a programmatic scroll container --
// and at phone widths its content overflows by the message list's pane-gap
// bleed (12px in this rig), so the click also scrolled the columns box by 12px.
// No scrollbar exists there, nothing resets its scrollTop, so the whole layout
// sat shifted up with a stuck 12px band of background under the composer.
//
// The contract: after the click, the message scroller sits on the exact end of
// its content (clearance margin included, so the keyboard-open landing is also
// the true bottom), every ancestor's scrollTop is untouched, and the composer's
// box has not moved a pixel. Both views.
// grep token: `go down bottom land`.

test.use({timezoneId: 'UTC', locale: 'en-US'});

const SHOTS = 'godown-bottom-land';
const BUTTON = '#cyc-thread-pane .cyc-jump-latest';
const COMPOSER = '#cyc-thread-pane .cyc-composer-main';
const SPACER = '#cyc-thread-pane .cyc-message-list-pad-bottom';

type Placement = {
  ancestors: {name: string; scrollTop: number}[];
  composer: {top: number; bottom: number};
  distToEnd: number;
  spacerMargin: string;
};

async function placement(page: Page): Promise<Placement> {
  return page.evaluate(
    ({scrollSel, composerSel, spacerSel}) => {
      const s = document.querySelector<HTMLElement>(scrollSel)!;
      const ancestors: {name: string; scrollTop: number}[] = [];
      for (let el = s.parentElement; el; el = el.parentElement) {
        ancestors.push({
          name: el.id || el.tagName + '.' + String(el.className).split(' ')[0],
          scrollTop: (el as HTMLElement).scrollTop
        });
      }
      const cr = document.querySelector<HTMLElement>(composerSel)!.getBoundingClientRect();
      return {
        ancestors,
        composer: {top: cr.top, bottom: cr.bottom},
        distToEnd: s.scrollHeight - s.scrollTop - s.clientHeight,
        spacerMargin: document.querySelector<HTMLElement>(spacerSel)!.style.marginBottom || '(none)'
      };
    },
    {scrollSel: SCROLL, composerSel: COMPOSER, spacerSel: SPACER}
  );
}

async function scrollUp(page: Page) {
  await page.evaluate((sel) => {
    const s = document.querySelector<HTMLElement>(sel)!;
    s.scrollTop = Math.max(0, s.scrollTop - 2000);
  }, SCROLL);
  await expect(page.locator(PANE)).toHaveAttribute('data-cyc-godown', '');
  await page.waitForTimeout(300); // the reveal fade
}

// Click the arrow and wait for the smooth scroll to land (scrollTop stops
// moving); the assertions then read a settled layout.
async function clickAndLand(page: Page) {
  await page.locator(BUTTON).click();
  await page.waitForFunction(
    (sel) => {
      const s = document.querySelector<HTMLElement>(sel)!;
      const w = window as unknown as {__lastTop?: number; __stableFor?: number};
      if (w.__lastTop === s.scrollTop) w.__stableFor = (w.__stableFor ?? 0) + 1;
      else w.__stableFor = 0;
      w.__lastTop = s.scrollTop;
      return (w.__stableFor ?? 0) > 5;
    },
    SCROLL,
    {timeout: 10_000, polling: 50}
  );
}

function expectLanded(before: Placement, after: Placement, why: string) {
  // The layout did not shift: no ancestor took any scroll...
  for (const anc of after.ancestors) {
    expect(anc.scrollTop, `${why}: the click scrolled ancestor ${anc.name}`).toBe(0);
  }
  // ...and the composer's box is exactly where it was.
  expect(after.composer.top, `${why}: the composer moved`).toBe(before.composer.top);
  expect(after.composer.bottom, `${why}: the composer moved`).toBe(before.composer.bottom);
  // The scroller sits on the exact end of its content.
  expect(after.distToEnd, `${why}: the landing is not the true bottom`).toBe(0);
}

for (const view of VIEWS) {
  test.describe(view.label, () => {
    test.use({
      viewport: view.size,
      deviceScaleFactor: view.scale,
      hasTouch: view.touch,
      isMobile: view.touch
    });

    test(`go down bottom land (${view.label}): true bottom, nothing else moves`, async ({page}) => {
      test.setTimeout(90_000);
      const eng = await startScrollEngine({count: 60});
      try {
        await bootAndOpen(page, eng, view);
        const atBottom = await placement(page);
        for (const anc of atBottom.ancestors) {
          expect(anc.scrollTop, `pre-existing scroll on ancestor ${anc.name}`).toBe(0);
        }
        await scrollUp(page);
        const before = await placement(page);
        await clickAndLand(page);
        const after = await placement(page);
        await evidenceShot(page, SHOTS, `${view.label}-landed`);
        expectLanded(before, after, 'plain click');
        expect(after.spacerMargin, 'a clearance margin appeared from nowhere').toBe(
          atBottom.spacerMargin
        );
      } finally {
        await eng.close();
      }
    });
  });
}

// The keyboard-open shape: with a clearance claim held on the pad-bottom spacer
// (the engine's cyc:kbinset consumer applies it as margin-bottom), the landing
// must include the margin -- the true bottom, not the spacer's border box.
test.describe('phone with a keyboard claim', () => {
  const view = VIEWS[0];
  test.use({
    viewport: view.size,
    deviceScaleFactor: view.scale,
    hasTouch: view.touch,
    isMobile: view.touch
  });

  test('go down bottom land (keyboard claim): the margin is part of the bottom', async ({page}) => {
    test.setTimeout(90_000);
    const eng = await startScrollEngine({count: 60});
    try {
      await bootAndOpen(page, eng, view);
      // The keyboard claim lands while the reader is at the bottom.
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('cyc:kbinset', {detail: 300}));
      });
      await expect(page.locator(SPACER)).toHaveCSS('margin-bottom', '300px');
      await scrollUp(page);
      const before = await placement(page);
      await clickAndLand(page);
      const after = await placement(page);
      await evidenceShot(page, SHOTS, 'phone-kb-claim-landed');
      expectLanded(before, after, 'keyboard claim');
      expect(after.spacerMargin, 'the claim must survive the click').toBe('300px');
    } finally {
      await eng.close();
    }
  });
});
