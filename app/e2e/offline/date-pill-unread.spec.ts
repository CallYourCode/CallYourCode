import {expect, test, type Page} from '@playwright/test';
import {evidenceShot} from './rig';
import {runningAgent, startScrollEngine} from './scrollEngine';
import {AGENTS_BAR, bootAndOpen, intersects, SCROLL, VIEWS, type Rect} from './chatGeom';

// THE STICKY DATE PILL NEVER PAINTS OVER THE UNREAD DIVIDER (fix-dnd-bottom,
// item 3). The phone screenshots: opening a chat with unread lines landed the
// "Unread Messages" divider as the first visible row, and the sticky "Today"
// pill painted on top of its text ("Unre[Today]ages"). The contract: the pill
// and the divider never overlap; while the divider is under the pill's line
// the pill hides. Both views, agents bar up (as in the screenshots), at the
// landing and while the divider is scrolled through the pill's line.
// grep token: `date pill unread`.

test.use({timezoneId: 'UTC', locale: 'en-US'});

const SHOTS = 'date-pill-unread';
const DIVIDER = '#cyc-thread-pane .cyc-msg-unread';

type Boxes = {divider: Rect | null; pills: Rect[]; scrollTop: number};

// The divider's box and every date pill that is actually painted (a hidden
// pill is not a pill the user can read through).
async function boxes(page: Page): Promise<Boxes> {
  return page.evaluate(
    ({scrollSel, dividerSel}) => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return {x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom};
      };
      const painted = (el: Element) => {
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
      };
      const scroll = document.querySelector<HTMLElement>(scrollSel)!;
      const divider = document.querySelector(dividerSel);
      const sr = scroll.getBoundingClientRect();
      const pills = Array.from(scroll.querySelectorAll('.cyc-date-chip'))
        .filter((el) => painted(el))
        .map(box)
        .filter((r) => r.bottom > sr.y && r.y < sr.bottom);
      return {divider: divider && painted(divider) ? box(divider) : null, pills, scrollTop: scroll.scrollTop};
    },
    {scrollSel: SCROLL, dividerSel: DIVIDER}
  );
}

// Every painted pill that overlaps the divider, as one line each.
function overlaps(b: Boxes, why: string): string[] {
  return b.pills
    .filter((pill) => b.divider && intersects(pill, b.divider))
    .map(
      (pill) =>
        `${why} (scrollTop ${b.scrollTop}): the date pill ${JSON.stringify(pill)} paints over the unread divider ${JSON.stringify(b.divider)}`
    );
}

function expectApart(b: Boxes, why: string) {
  expect(b.divider, `${why}: no unread divider on screen`).not.toBeNull();
  expect(overlaps(b, why)).toEqual([]);
}

for (const view of VIEWS) {
  test.describe(view.label, () => {
    test.use({
      viewport: view.size,
      deviceScaleFactor: view.scale,
      hasTouch: view.touch,
      isMobile: view.touch
    });

    test(`date pill (${view.label}): never over the unread divider, at the landing and while scrolling through`, async ({
      page
    }) => {
      test.setTimeout(90_000);
      const eng = await startScrollEngine({count: 80});
      try {
        eng.setUnread(12);
        eng.setAgentRuns([runningAgent(1)]);
        await bootAndOpen(page, eng, view);
        await expect(page.locator(AGENTS_BAR)).toBeVisible();
        await expect(page.locator(DIVIDER)).toHaveCount(1);
        await page.waitForTimeout(1200); // past the landing settle
        await evidenceShot(page, SHOTS, `${view.label}-landing`);
        expectApart(await boxes(page), 'at the landing');

        // Sweep the divider through the pill's line, 4px at a time: from 40px
        // under the pill up to 40px above it. The pill's line is where the
        // sticky chip sits at the landing (the pad-top line); the divider
        // rises by exactly what scrollTop grows.
        const landing = await boxes(page);
        const line = landing.pills[0];
        expect(line, 'no sticky date pill painted at the landing').toBeDefined();
        const start = landing.scrollTop;
        const from = Math.round(landing.divider!.y - (line!.bottom + 40));
        const to = Math.round(landing.divider!.y - (line!.y - landing.divider!.height - 40));
        // Overlaps are collected over the whole sweep and asserted after the
        // evidence shot, so a failing run still leaves the picture behind.
        const found: string[] = [];
        let shot = false;
        let seen = 0;
        for (let d = from; d <= to; d += 4) {
          await page.evaluate(({sel, top}) => (document.querySelector<HTMLElement>(sel)!.scrollTop = top), {
            sel: SCROLL,
            top: start + d
          });
          await page.waitForTimeout(40);
          const b = await boxes(page);
          if (!b.divider) continue; // scrolled off screen
          seen += 1;
          // One shot with the divider's text right on the pill's line.
          if (!shot && Math.abs(b.divider.y + b.divider.height / 2 - (line!.y + line!.height / 2)) < 6) {
            await evidenceShot(page, SHOTS, `${view.label}-divider-under-pill`);
            shot = true;
          }
          found.push(...overlaps(b, `sweep ${d}`));
        }
        await evidenceShot(page, SHOTS, `${view.label}-after-sweep`);
        expect(seen, 'the sweep never had the divider on screen').toBeGreaterThan(10);
        expect(shot, 'the sweep never put the divider on the pill line').toBe(true);
        expect(found).toEqual([]);
      } finally {
        await eng.close();
      }
    });
  });
}
