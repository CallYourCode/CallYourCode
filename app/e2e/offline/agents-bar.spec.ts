import {expect, test, type Page} from '@playwright/test';
import {bootEngines} from './rig';
import {startPresentationEngine} from './presentationEngine';

// The top agent-bar / next-agent-pill docking oracle.
//
// Guards the regression the clean-room CSS reauthoring let slip: the strip lost
// its stable min dimensions and its reservation, so it floated over the first
// message bubbles instead of sitting docked under the header. This spec drives
// the bar into its populated (running-agents) and hidden states across day/night
// and the three product widths and, at every one, proves mechanically that:
//   * the bar's bounding box sits in the header/dock region (its top pins to the
//     header bottom, its box stays inside the reserved `--cyc-overlay-stack-height`);
//   * the bar keeps a stable min height (the 44px wrapper floor and the full
//     3.25rem reserved slot) rather than collapsing;
//   * the bar never intersects a rendered message bubble (`.cyc-message-content`);
//   * showing/hiding the bar toggles `--cyc-overlay-stack-height` 3.25rem <-> 0px.
// A bar-visible and a bar-hidden screenshot per layout back the geometry.

test.use({timezoneId: 'UTC', locale: 'en-US'});

type ThemeName = 'day' | 'night';
const THEMES: ThemeName[] = ['day', 'night'];

// phone 390x844, tablet 768x1024, laptop 1280x800.
const WIDTHS = [
  ['phone', 390, 844],
  ['tablet', 768, 1024],
  ['laptop', 1280, 800]
] as const;

const SHOT = {animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.01} as const;

const REDUCE_MOTION = () => {
  const s = document.createElement('style');
  s.textContent =
    '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;' +
    'transition-duration:0s!important;transition-delay:0s!important;' +
    'scroll-behavior:auto!important;caret-color:transparent!important}';
  document.documentElement.appendChild(s);
};

// One running pi agent: drives the populated strip (title + rail + subtitle).
const RUNNING_AGENT = () => [
  {
    toolUseId: 'agentsbar-a',
    agentId: 'agentsbar-a1',
    ts: Date.now(),
    desc: 'building the corpus',
    endedTs: null,
    tokens: null,
    source: 'pi',
    model: 'opus'
  }
];

async function boot(page: Page, theme: ThemeName, port: number, w: number, h: number) {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('cyc-skin', t as string);
    } catch {
      /* private mode; the app falls back to its default theme */
    }
  }, theme);
  await page.addInitScript(REDUCE_MOTION);
  await bootEngines(page, [port], {size: {width: w, height: h}});
  await page.waitForSelector('#cyc-left-pane');
}

const RICH_ROW = 'Relay Server';

async function openRichChat(page: Page) {
  await page.locator('#cyc-left-pane .cyc-session-entry', {hasText: RICH_ROW}).first().click();
  await page.waitForSelector('#cyc-thread-pane .cyc-message-list-scroll', {timeout: 15_000});
  await page.waitForSelector('#cyc-thread-pane .cyc-still', {timeout: 15_000});
  await expect
    .poll(
      () =>
        page
          .locator('#cyc-thread-pane .cyc-still')
          .first()
          .evaluate((img) => (img as HTMLImageElement).naturalWidth || 0),
      {timeout: 15_000}
    )
    .toBeGreaterThan(0);
  await page.waitForFunction(() => !!(window as {__cycAgentsBar?: unknown}).__cycAgentsBar, null, {
    timeout: 15_000
  });
}

// Open the two sibling chats that carry unread so the next-agent jump pill has no
// targets. Without this the jump pill keeps the strip visible, and the fully
// hidden state (bar display:none, reservation 0px) is unreachable at every width.
async function drainSiblingUnread(page: Page) {
  for (const name of ['Metrics Dashboard', 'Auth Gateway']) {
    await page.locator('#cyc-left-pane .cyc-session-entry', {hasText: name}).first().click();
    await page.waitForTimeout(500);
  }
}

// Read the current bar geometry, the header dock bottom, the reserved slot height
// and every rendered bubble box, resolved to viewport pixels.
async function readState(page: Page) {
  return page.evaluate(() => {
    const chat = document.querySelector('#cyc-thread-pane .cyc-thread.active') as HTMLElement | null;
    const bar = document.querySelector('#cyc-thread-pane .cyc-agents-bar') as HTMLElement | null;
    const mast = document.querySelector('#cyc-thread-pane .cyc-mast') as HTMLElement | null;
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const raw = chat?.style.getPropertyValue('--cyc-overlay-stack-height').trim() || '0px';
    const reservationPx = raw.endsWith('rem')
      ? parseFloat(raw) * rootPx
      : parseFloat(raw) || 0;
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right};
    };
    const bubbles = Array.from(
      document.querySelectorAll('#cyc-thread-pane .cyc-message-list-scroll .cyc-message-content')
    )
      .map((el) => rect(el)!)
      .filter((r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight);
    return {
      off: !bar || bar.classList.contains('cyc-off'),
      reservationRaw: raw,
      reservationPx,
      headerBottom: mast?.getBoundingClientRect().bottom ?? 0,
      bar: rect(bar),
      bubbles
    };
  });
}

type Box = {top: number; bottom: number; left: number; right: number};

// Standard AABB overlap with an epsilon so shared/adjacent edges do not count.
function intersects(a: Box, b: Box, eps = 1): boolean {
  return a.left < b.right - eps && a.right > b.left + eps && a.top < b.bottom - eps && a.bottom > b.top + eps;
}

for (const theme of THEMES) {
  test(`agents-bar dock ${theme}: docked, min-height, no bubble overlap, reservation toggles`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const eng = await startPresentationEngine();
    try {
      // Boot wide so the persistent left pane can drain the sibling unread once;
      // the read state then survives every later viewport change.
      await boot(page, theme, eng.port, WIDTHS[2][1], WIDTHS[2][2]);
      await drainSiblingUnread(page);
      await openRichChat(page);

      for (const [width, w, h] of WIDTHS) {
        await page.setViewportSize({width: w, height: h});
        await page.waitForTimeout(350);

        // Populated: one running agent. Drive through the same testhook the app's
        // own paths call, so the strip + reservation land exactly as in production.
        await page.evaluate((runs) => {
          (window as {__cycAgentsBar: {update: (r: unknown[]) => void}}).__cycAgentsBar.update(runs);
        }, RUNNING_AGENT());
        await page.waitForTimeout(150);

        const shown = await readState(page);
        expect(shown.off, `${width}/${theme}: bar hidden while populated`).toBe(false);
        expect(shown.bar, `${width}/${theme}: populated bar has no box`).not.toBeNull();
        const bar = shown.bar!;

        // Reservation is the full strip height while shown.
        expect(shown.reservationRaw).toBe('3.25rem');
        expect(shown.reservationPx).toBeGreaterThan(0);

        // Docked: the bar top pins to the header bottom (a small +0.25rem inset on
        // the wide layouts), and the whole box stays inside the reserved slot.
        expect(bar.top, `${width}/${theme}: bar sits above the header dock`).toBeGreaterThanOrEqual(
          shown.headerBottom - 2
        );
        expect(
          bar.bottom,
          `${width}/${theme}: bar overflows the reserved dock slot`
        ).toBeLessThanOrEqual(shown.headerBottom + shown.reservationPx + 8);

        // Min height: the 44px wrapper floor and the full reserved 3.25rem slot,
        // so neither a collapsed strip nor a short jump-pill state slips through.
        expect(bar.height, `${width}/${theme}: bar shorter than the 44px floor`).toBeGreaterThanOrEqual(44);
        expect(
          bar.height,
          `${width}/${theme}: bar does not fill its reserved slot`
        ).toBeGreaterThanOrEqual(shown.reservationPx - 2);

        // No overlap: not one rendered bubble intersects the docked bar.
        for (const b of shown.bubbles) {
          expect(
            intersects(bar, b),
            `${width}/${theme}: bar intersects a message bubble ` +
              `(bar ${JSON.stringify(bar)} vs bubble ${JSON.stringify(b)})`
          ).toBe(false);
        }

        await expect(page.locator('#cyc-thread-pane')).toHaveScreenshot(
          `agentsbar-visible-${theme}-${width}.png`,
          SHOT
        );

        // Hidden: no agents and (siblings drained) no jump target -> the strip goes
        // display:none and the reservation collapses back to 0px, so bubbles reclaim
        // the space under the header.
        await page.evaluate(() => {
          (window as {__cycAgentsBar: {update: (r: unknown[]) => void}}).__cycAgentsBar.update([]);
        });
        await page.waitForTimeout(150);

        const hidden = await readState(page);
        expect(hidden.off, `${width}/${theme}: bar still shown after clear`).toBe(true);
        expect(hidden.reservationRaw).toBe('0px');
        // display:none collapses the box to zero -- the strip reserves nothing.
        expect(hidden.bar?.height ?? 0, `${width}/${theme}: hidden bar keeps height`).toBe(0);

        await expect(page.locator('#cyc-thread-pane')).toHaveScreenshot(
          `agentsbar-hidden-${theme}-${width}.png`,
          SHOT
        );
      }
    } finally {
      await eng.close();
    }
  });
}
