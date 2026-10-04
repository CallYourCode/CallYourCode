import {expect, test, type Locator, type Page} from '@playwright/test';
import {bootEngines} from './rig';
import {startPresentationEngine} from './presentationEngine';

// The presentation-to-TS migration oracle.
//
// A deterministic, offline, real-render screenshot baseline for the surfaces the
// parallel migration lanes touch, captured across day/night and the three
// product widths. Every surface pairs a tracked toHaveScreenshot with behavioural
// assertions so a green run proves the pixels *and* the seams that the earlier
// coverage gap let slip (the plugin-gated Search slot, and genuinely-served,
// not-CSS-hidden, attachment media).
//
// Selectivity: each surface is its own grep token (`oracle <surface>`), so a lane
// verifier owns its surface with `-g "oracle chat"`; a bare run covers the matrix.
// The fixture engine is on an ephemeral port (unique, never the live stack).

test.use({timezoneId: 'UTC', locale: 'en-US'});

type ThemeName = 'day' | 'night';
const THEMES: ThemeName[] = ['day', 'night'];

// phone 390x844, tablet 768x1024, laptop 1280x800.
const WIDTHS = [
  ['phone', 390, 844],
  ['tablet', 768, 1024],
  ['laptop', 1280, 800]
] as const;

// Tight, migration-grade comparison: base and candidate must be all but identical.
const SHOT = {animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.01} as const;

// Applied at every boot, layout-neutral: kill animation/transition time and the
// blinking caret so a shot never depends on when in an animation it landed.
const REDUCE_MOTION = () => {
  const s = document.createElement('style');
  s.textContent =
    '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;' +
    'transition-duration:0s!important;transition-delay:0s!important;' +
    'scroll-behavior:auto!important;caret-color:transparent!important}';
  document.documentElement.appendChild(s);
};

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

async function settle(page: Page) {
  await page.waitForTimeout(350);
}

const RICH_ROW = 'Relay Server';

async function openRichChat(page: Page) {
  await page.locator('.cyc-session-entry', {hasText: RICH_ROW}).first().click();
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
}

async function openProfile(page: Page) {
  await page.locator('#cyc-thread-pane .cyc-mast-person').first().click();
  await page.waitForSelector('#cyc-right-pane .cyc-account-attachments', {timeout: 15_000});
  await page.waitForSelector('#cyc-right-pane .cyc-grid-media', {timeout: 15_000});
  // The grid loads its tiles lazily on intersection; scroll it into the fold so
  // the real tunnel fetch fires (rather than leaving an unloaded <img>).
  await page.locator('#cyc-right-pane .cyc-grid-media').first().scrollIntoViewIfNeeded();
  await expect
    .poll(
      () =>
        page
          .locator('#cyc-right-pane .cyc-grid-media')
          .first()
          .evaluate((img) => (img as HTMLImageElement).naturalWidth || 0),
      {timeout: 15_000}
    )
    .toBeGreaterThan(0);
}

function shotName(surface: string, theme: ThemeName, width: string) {
  return `oracle-${surface}-${theme}-${width}.png`;
}

// A surface is captured across all three widths in one boot; the target locator
// is re-resolved per width so responsive reflow settles before the shot.
async function captureAcrossWidths(
  page: Page,
  surface: string,
  theme: ThemeName,
  target: (page: Page, width: string) => Promise<Locator>
) {
  for (const [width, w, h] of WIDTHS) {
    await page.setViewportSize({width: w, height: h});
    await settle(page);
    const loc = await target(page, width);
    await expect(loc).toHaveScreenshot(shotName(surface, theme, width), SHOT);
  }
}

for (const theme of THEMES) {
  test(`oracle sessions ${theme}: session list + filter`, async ({page}) => {
    test.setTimeout(90_000);
    const eng = await startPresentationEngine();
    try {
      await boot(page, theme, eng.port, WIDTHS[0][1], WIDTHS[0][2]);
      // Behaviour: the list hydrated from the engine and the filter input is real.
      expect(await page.locator('.cyc-session-entry').count()).toBeGreaterThan(0);
      await expect(page.locator('#cyc-left-pane .cyc-search-input').first()).toBeVisible();
      await captureAcrossWidths(page, 'sessions', theme, async () =>
        page.locator('#cyc-left-pane')
      );
    } finally {
      await eng.close();
    }
  });

  test(`oracle toolbar ${theme}: conversation header with Search action`, async ({page}) => {
    test.setTimeout(90_000);
    const eng = await startPresentationEngine();
    try {
      await boot(page, theme, eng.port, WIDTHS[0][1], WIDTHS[0][2]);
      await openRichChat(page);
      await captureAcrossWidths(page, 'toolbar', theme, async () =>
        page.locator('#cyc-thread-pane .cyc-mast').first()
      );

      // Behaviour: the Search slot exists (engine declared the panel), has a real
      // box, and clicking it opens the Search panel via the generic panel path.
      const slot = page.locator('#cyc-thread-pane [data-cyc-action="search"]').first();
      await expect(slot).toBeVisible();
      const box = await slot.boundingBox();
      expect(box, 'the Search slot has no layout box').not.toBeNull();
      expect((box?.width ?? 0) > 0 && (box?.height ?? 0) > 0).toBe(true);

      await slot.locator('.cyc-icon-btn').first().click();
      const panel = page.locator('.cyc-plugin-panel');
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('Search');
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
    } finally {
      await eng.close();
    }
  });

  test(`oracle chat ${theme}: text, available photo and available file`, async ({page}) => {
    test.setTimeout(90_000);
    const eng = await startPresentationEngine();
    try {
      await boot(page, theme, eng.port, WIDTHS[0][1], WIDTHS[0][2]);
      await openRichChat(page);

      // Behaviour: the photo genuinely decoded (nonzero naturalWidth) and no part
      // of the media went to a "gone" card / "gone" text.
      const photo = page.locator('#cyc-thread-pane .cyc-still').first();
      expect(await photo.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(
        0
      );
      expect(await page.locator('#cyc-thread-pane .cyc-media-gone').count()).toBe(0);
      expect(await page.locator('#cyc-thread-pane .cyc-media-gone-label').count()).toBe(0);
      expect(await page.locator('#cyc-thread-pane .cyc-media-gone-line').count()).toBe(0);

      // Behaviour: the file stays available, its chip renders with the name and
      // nothing on it says it is no longer on the engine.
      const doc = page.locator('#cyc-thread-pane .cyc-doc-name', {hasText: 'runbook.txt'}).first();
      await expect(doc).toBeVisible();
      expect(await page.locator('#cyc-thread-pane').innerText()).not.toContain('no longer');

      await captureAcrossWidths(page, 'chat', theme, async () => page.locator('#cyc-thread-pane'));
    } finally {
      await eng.close();
    }
  });

  test(`oracle composer ${theme}: message composer`, async ({page}) => {
    test.setTimeout(90_000);
    const eng = await startPresentationEngine();
    try {
      await boot(page, theme, eng.port, WIDTHS[0][1], WIDTHS[0][2]);
      await openRichChat(page);
      await expect(page.locator('#cyc-thread-pane .cyc-composer').first()).toBeVisible();
      await captureAcrossWidths(page, 'composer', theme, async () =>
        page.locator('#cyc-thread-pane .cyc-composer').first()
      );
    } finally {
      await eng.close();
    }
  });

  test(`oracle settings ${theme}: settings pane`, async ({page}) => {
    test.setTimeout(90_000);
    const eng = await startPresentationEngine();
    try {
      await boot(page, theme, eng.port, WIDTHS[0][1], WIDTHS[0][2]);
      await page.locator('.cyc-pane-menu-btn').first().click();
      await page.waitForSelector('.cyc-settings-open .cyc-left-settings', {timeout: 10_000});
      await settle(page);
      await captureAcrossWidths(page, 'settings', theme, async () =>
        page.locator('.cyc-left-settings').first()
      );
    } finally {
      await eng.close();
    }
  });

  test(`oracle menu ${theme}: composer attach overlay`, async ({page}) => {
    test.setTimeout(90_000);
    const eng = await startPresentationEngine();
    try {
      await boot(page, theme, eng.port, WIDTHS[0][1], WIDTHS[0][2]);
      await openRichChat(page);
      await captureAcrossWidths(page, 'menu', theme, async () => {
        // A resize (the setViewportSize before this ran) closes any prior overlay,
        // so open fresh: the composer attach affordance is a menu (wide) or a
        // sheet (narrow), and each width owns its own baseline.
        const openOverlay = '.cyc-menu[data-cyc-phase="open"], .cyc-sheet[data-cyc-phase="open"]';
        await expect(page.locator(openOverlay)).toHaveCount(0);
        await page.locator('#cyc-thread-pane .cyc-attach-btn').first().click();
        const overlay = page.locator(openOverlay).first();
        await overlay.waitFor({state: 'visible', timeout: 10_000});
        await settle(page);
        return overlay;
      });
    } finally {
      await eng.close();
    }
  });

  test(`oracle media ${theme}: profile media + attachments grid`, async ({page}) => {
    test.setTimeout(90_000);
    const eng = await startPresentationEngine();
    try {
      await boot(page, theme, eng.port, WIDTHS[0][1], WIDTHS[0][2]);
      await openRichChat(page);
      await openProfile(page);

      // Behaviour: the media tile decoded and no tile went to a gone label/text.
      expect(
        await page
          .locator('#cyc-right-pane .cyc-grid-media')
          .first()
          .evaluate((img) => (img as HTMLImageElement).naturalWidth)
      ).toBeGreaterThan(0);
      expect(await page.locator('#cyc-right-pane .cyc-media-gone').count()).toBe(0);
      expect(await page.locator('#cyc-right-pane .cyc-media-gone-label').count()).toBe(0);

      // Behaviour: the shared file remains available in the Files tab, the row is
      // not marked gone and does not read "no longer on the engine".
      await page.locator('#cyc-right-pane .cyc-seg', {hasText: 'Files'}).first().click();
      const row = page.locator('#cyc-right-pane .cyc-account-document', {hasText: 'runbook.txt'});
      await expect(row.first()).toBeVisible();
      expect(await row.first().evaluate((el) => el.classList.contains('cyc-doc-gone'))).toBe(false);
      expect(await row.first().innerText()).not.toContain('no longer');

      // Return to the Media grid for the tracked shot.
      await page.locator('#cyc-right-pane .cyc-seg', {hasText: 'Media'}).first().click();
      await settle(page);
      await captureAcrossWidths(page, 'media', theme, async (p) => {
        await p.locator('#cyc-right-pane .cyc-grid-media').first().scrollIntoViewIfNeeded();
        await settle(p);
        return p.locator('#cyc-right-pane .cyc-account-attachments').first();
      });
    } finally {
      await eng.close();
    }
  });
}
