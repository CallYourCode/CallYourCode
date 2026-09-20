import {expect, test} from '@playwright/test';
import {bootEngines} from './rig';
import {startPresentationEngine} from './presentationEngine';

// Real-browser click/toggle/computed coverage for the two finite producer-owned

//   * shell/geomOverlay.ts `[&.cyc-geom-min]:opacity-[0.15]` (was
//     `.cyc-geom.cyc-geom-min{opacity:0.15}`), toggled on the box's own click.
//   * features/sessions/panes/listPane.ts `[&.cyc-visible]:[transform:...]` on the
//     new-session FAB (the app-owned FAB_DOCK reveal: at rest the button is pushed
//     its own height + inset below the surface; `cyc-visible` springs it to rest).

// Tailwind self-variant actually wins the cascade, not merely that the class
// string is present.
//
// grep token: `session fab geom`.

test.use({timezoneId: 'UTC', locale: 'en-US'});

const px = (v: string | undefined) => parseFloat(v ?? 'NaN');

test('session fab geom: the debug overlay dims to 0.15 on click and back', async ({page}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    // Seed the geom debug flag so installGeomOverlay mounts the box on boot; the
    // hermetic engine serves no /settings route so the flag stays put.
    await page.addInitScript(() =>
      localStorage.setItem('cyc-global-settings', JSON.stringify({geom: true}))
    );
    await bootEngines(page, [eng.port]);
    const box = page.locator('.cyc-geom');
    await box.waitFor();

    const state = () =>
      page.evaluate(() => {
        const el = document.querySelector('.cyc-geom')!;
        
        // `[&.cyc-geom-min]:opacity-[0.15]` utility name that also carries the
        // substring.
        return {min: el.classList.contains('cyc-geom-min'), opacity: getComputedStyle(el).opacity};
      });

    // Resting: no min state -> full opacity (the base utilities carry none).
    let s = await state();
    expect(s.min).toBe(false);
    expect(px(s.opacity)).toBeCloseTo(1, 2);

    
    // self-variant must beat the base and dim the box. Dispatch the click on the
    // element (its 1s repaint keeps mutating textContent, which trips Playwright's
    // stability wait) so the toggle count is exact.
    await box.dispatchEvent('click');
    s = await state();
    expect(s.min).toBe(true);
    expect(px(s.opacity)).toBeCloseTo(0.15, 2);

    // Toggling off restores full opacity.
    await box.dispatchEvent('click');
    s = await state();
    expect(s.min).toBe(false);
    expect(px(s.opacity)).toBeCloseTo(1, 2);
  } finally {
    await eng.close();
  }
});

test('session fab geom: the new-session FAB reveal springs the dock transform to rest', async ({
  page
}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    // Laptop width keeps the left pane mounted, so updateFabImpl leaves the FAB
    // carrying `cyc-dock-shown`.
    await bootEngines(page, [eng.port], {size: {width: 1024, height: 800}});
    const fab = page.locator('#cyc-left-pane .cyc-new-conversation');
    await fab.waitFor();
    await expect(fab).toHaveClass(/cyc-dock-shown/);

    // Read the reveal transform under both states in one synchronous pass so
    // updateFabImpl (which re-asserts cyc-dock-shown on the next render at this width)
    // cannot interleave and re-reveal the button between reads. Capture the box +
    // inset while revealed (transform is at rest, so the geometry is the natural box).
    const seen = await fab.evaluate((el) => {
      // Y translation (m42) of the computed transform; `none` is rest.
      const ty = () => {
        const t = getComputedStyle(el).transform;
        return t === 'none' ? 0 : new DOMMatrix(t).m42;
      };
      const box = el.getBoundingClientRect();
      const inset = parseFloat(getComputedStyle(el).bottom);
      // The dock transition would otherwise animate the toggle, so a synchronous
      // read catches a mid-flight tween; pin transition off to sample the static
      // target of each state instead.
      const prevTransition = el.style.transition;
      el.style.transition = 'none';
      const revealed = ty();
      el.classList.remove('cyc-dock-shown');
      const hidden = ty();
      el.classList.add('cyc-dock-shown');
      const settled = ty();
      el.style.transition = prevTransition;
      return {revealed, hidden, settled, height: box.height, inset};
    });

    // Revealed: the `[&.cyc-dock-shown]:[transform:translateY(0)]` self-variant
    // wins -> the dock sits at rest (no Y translation).
    expect(Math.abs(seen.revealed)).toBeLessThan(0.5);
    // Hidden: the base FAB_DOCK transform shows through, pushing the button its own
    // height (100%) + the 1.25rem corner inset fully below the surface.
    expect(seen.hidden).toBeGreaterThan(0);
    expect(seen.hidden).toBeCloseTo(seen.height + seen.inset, 0);
    // And it settles back to rest once cyc-dock-shown returns.
    expect(Math.abs(seen.settled)).toBeLessThan(0.5);
  } finally {
    await eng.close();
  }
});
