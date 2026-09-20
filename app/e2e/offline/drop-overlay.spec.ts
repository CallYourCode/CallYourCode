import {expect, test} from '@playwright/test';
import {evidenceShot} from './rig';
import {runningAgent, startScrollEngine} from './scrollEngine';
import {dragFilesOver, dragFilesOut} from './dropKit';
import {
  AGENTS_BAR,
  bootAndOpen,
  chromeBottom,
  COMPOSER_PILL,
  intersects,
  mustRect,
  PANE,
  rect,
  VIEWS
} from './chatGeom';

// THE DROP OVERLAY COVERS THE MESSAGE AREA (fix-dnd-bottom, item 1). The phone
// screenshot: dragging a file over the chat painted the dashed drop zone as a
// band in the middle of the list, not over the message area, with the glyph
// and the label crowding each other. The contract: while a file drag hovers
// the chat, one drop zone fills the message area between the chrome at the
// top (header, agents bar) and the composer, the glyph sits above the label,
// and the two never overlap. Both views, agents bar up (as in the screenshot).
// grep token: `drop overlay`.

test.use({timezoneId: 'UTC', locale: 'en-US'});

const SHOTS = 'drop-overlay';
const LAYER = '#cyc-thread-pane .cyc-drop-layer';
const ZONE = '#cyc-thread-pane .cyc-file-drop';
const GLYPH = '#cyc-thread-pane .cyc-file-drop-icon';
const LABEL = '#cyc-thread-pane .cyc-file-drop-title';

for (const view of VIEWS) {
  test.describe(view.label, () => {
    test.use({
      viewport: view.size,
      deviceScaleFactor: view.scale,
      hasTouch: view.touch,
      isMobile: view.touch
    });

    test(`drop overlay (${view.label}): one zone over the whole message area, glyph above the label`, async ({
      page
    }) => {
      test.setTimeout(90_000);
      const eng = await startScrollEngine({count: 60});
      try {
        eng.setAgentRuns([runningAgent(1)]);
        await bootAndOpen(page, eng, view);
        await expect(page.locator(AGENTS_BAR)).toBeVisible();
        await evidenceShot(page, SHOTS, `${view.label}-before-drag`);

        await dragFilesOver(page, PANE);
        await expect(page.locator(LAYER)).toHaveClass(/cyc-drop-shown/);
        await page.waitForTimeout(300); // the reveal fade
        await evidenceShot(page, SHOTS, `${view.label}-dragging`);

        const top = await chromeBottom(page);
        const pill = await mustRect(page, COMPOSER_PILL);
        const pane = await mustRect(page, PANE);
        const zone = await mustRect(page, ZONE);
        const glyph = await mustRect(page, GLYPH);
        const label = await mustRect(page, LABEL);
        const area = pill.y - top;
        // The layer's inset from the chrome and the composer: the pane gap
        // (up to 8px) plus the drop pad (10px phone, 20px otherwise).
        const pad = 32;

        // One zone over the whole message area: hugging the chrome above and
        // the composer below, spanning the pane's width, within a small inset.
        expect(zone.y, 'zone top is not just under the chrome').toBeGreaterThanOrEqual(top);
        expect(zone.y, 'zone top is not just under the chrome').toBeLessThanOrEqual(top + pad);
        expect(zone.bottom, 'zone bottom is not just above the composer').toBeLessThanOrEqual(pill.y);
        expect(zone.bottom, 'zone bottom is not just above the composer').toBeGreaterThanOrEqual(pill.y - pad);
        expect(zone.x, 'zone start edge').toBeGreaterThanOrEqual(pane.x);
        expect(zone.x, 'zone start edge').toBeLessThanOrEqual(pane.x + pad);
        expect(zone.right, 'zone end edge').toBeLessThanOrEqual(pane.right);
        expect(zone.right, 'zone end edge').toBeGreaterThanOrEqual(pane.right - pad);
        expect(zone.height, `zone covers ${Math.round(zone.height)} of a ${Math.round(area)}px area`).toBeGreaterThanOrEqual(
          area - 2 * pad
        );

        // Glyph above the label, both inside the zone, no overlap.
        expect(intersects(glyph, label), 'the label runs through the glyph').toBe(false);
        expect(glyph.bottom, 'the glyph is not above the label').toBeLessThanOrEqual(label.y);
        for (const [name, r] of [
          ['glyph', glyph],
          ['label', label]
        ] as const) {
          expect(r.y, `${name} is outside the zone`).toBeGreaterThanOrEqual(zone.y);
          expect(r.bottom, `${name} is outside the zone`).toBeLessThanOrEqual(zone.bottom);
          expect(r.x, `${name} is outside the zone`).toBeGreaterThanOrEqual(zone.x);
          expect(r.right, `${name} is outside the zone`).toBeLessThanOrEqual(zone.right);
        }
        // Centred in the zone.
        const mid = zone.x + zone.width / 2;
        expect(Math.abs(glyph.x + glyph.width / 2 - mid), 'glyph is off centre').toBeLessThanOrEqual(2);
        expect(Math.abs(label.x + label.width / 2 - mid), 'label is off centre').toBeLessThanOrEqual(2);

        // Leaving the pane takes the overlay down again.
        await dragFilesOut(page, PANE);
        await expect.poll(() => rect(page, LAYER), {timeout: 5_000}).toBeNull();
      } finally {
        await eng.close();
      }
    });
  });
}
