import {test, expect} from '@playwright/test';
import {bootIsolated} from './rig';
for (const [label, w, h] of [
  ['phone', 390, 844],
  ['tablet', 768, 1024],
  ['laptop', 1280, 900]
] as const) {
  test(`boot gate ${label}: the app boots, the list + toolbar + composer render, nothing throws`, async ({
    page
  }) => {
    test.setTimeout(60_000);

    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${e.stack ?? ''}`));
    await bootIsolated(page, w, h);
    const shape = await page.evaluate(() => ({
      rows: document.querySelectorAll('.cyc-session-entry').length,

      toolbar: !!document.querySelector('.cyc-toolbar, [class*="cyc-toolbar"], [class*="toolbar"]'),
      composer: !!document.querySelector('.cyc-composer, [class*="composer"]')
    }));
    expect(
      pageErrors,
      `uncaught exception(s) during boot at ${label}:\n${pageErrors.join('\n---\n')}`
    ).toEqual([]);
    expect(shape.rows, 'the fixture chat list never rendered').toBeGreaterThan(0);
    expect(shape.toolbar, 'the toolbar never wired (a partial boot)').toBe(true);
    expect(shape.composer, 'the composer never wired (a partial boot)').toBe(true);
  });
}
