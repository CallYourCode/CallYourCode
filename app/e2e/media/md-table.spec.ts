import {test, expect, chromium, webkit} from '@playwright/test';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// Show fixtures/md-table.md through an isolated production app server and engine.
// It includes narrow, seven- and twenty-column tables at top level, in mixed
// lists/quotes/details, narrow-only and intrinsic-width units, and combined ancestors.
// The rig exposes /info: {origin, engineId, key, file: {docId, name, fileKind, size}}.
const control = process.env.CYC_MD_TABLE_RIG;
const evidence = process.env.CYC_MD_TABLE_EVIDENCE;
const phase = process.env.CYC_MD_TABLE_PHASE ?? 'after';

test('markdown tables break out of the reading column without page overflow', async () => {
  test.setTimeout(300_000);
  if (!control || !evidence) throw new Error('Set CYC_MD_TABLE_RIG and CYC_MD_TABLE_EVIDENCE');
  const rig = await (await fetch(control + '/info')).json();
  const config = await (await fetch(rig.origin + '/config')).json();
  const engineUrl = config.engines.find((e: {engineId: string}) => e.engineId === rig.engineId).url;
  const docUrl = engineUrl.replace(/^ws/, 'http').replace(/\/ws$/, '') + '/doc/' + rig.file.docId;
  for (const url of [control, rig.origin]) {
    const u = new URL(url);
    if (!['localhost', '127.0.0.1'].includes(u.hostname) || /^(1010[0-2]|2010[0-2])$/.test(u.port))
      throw new Error('Only isolated loopback scratch servers are allowed');
  }
  await mkdir(join(evidence, phase), {recursive: true});
  const measurements: unknown[] = [];
  const failures: string[] = [];
  for (const [name, browserType] of Object.entries({chromium, webkit})) {
    const browser = await browserType.launch({args: []});
    try {
      const context = await browser.newContext({
        viewport: {width: 390, height: 900},
        colorScheme: 'light'
      });
      const page = await context.newPage();
      // Fail closed: never let an accidental default reach a live service.
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return url.origin === rig.origin || ['data:', 'blob:'].includes(url.protocol)
          ? route.continue()
          : route.abort();
      });
      await page.goto(`${rig.origin}/?engine=${rig.engineId}&testhooks=1#pair=${rig.key}`);
      await page
        .locator('.cyc-pairing-row.is-confirm')
        .getByRole('button', {name: 'Pair', exact: true})
        .click();
      await page.locator('.cyc-session-entry').first().click();
      // No injected load function: the viewer fetches the shown .md over the real sealed tunnel.
      await page.evaluate(({file, url}) => (window as any).__cycOpenFileViewer(file, url), {
        file: rig.file,
        url: docUrl
      });
      await expect(page.locator('.cyc-md-table')).toHaveCount(20, {timeout: 15_000});
      await page.evaluate(() => document.fonts.ready);
      for (const width of [390, 1280, 1920]) {
        for (const colorScheme of ['light', 'dark'] as const) {
          await page
            .locator('.cyc-md-details')
            .evaluateAll((els) => els.forEach((el) => ((el as HTMLDetailsElement).open = false)));
          await page.setViewportSize({width, height: 900});
          await page.emulateMedia({colorScheme});
          await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
          for (const summary of await page.locator('.cyc-md-details > summary').all())
            await summary.click();
          // Allow layout/paint after resize and details opening.
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          );
          const id = `${name}-${width}-${colorScheme}`;
          const g = await page.evaluate(() => {
            const rect = (el: Element) => {
              const r = el.getBoundingClientRect();
              return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width};
            };
            const article = document.querySelector('.cyc-fv-body > .cyc-md')!;
            const scroll = document.querySelector('.cyc-fv-scroll')!;
            return {
              theme: document.documentElement.dataset.theme,
              documentWidth: document.scrollingElement!.scrollWidth,
              clientWidth: document.scrollingElement!.clientWidth,
              viewer: rect(scroll),
              prose: [...article.children]
                .filter(
                  (el) =>
                    !el.matches('.cyc-md-table-wrap, .cyc-md-anchor') &&
                    !el.querySelector('.cyc-md-table-wrap')
                )
                .map(rect),
              tables: [...article.querySelectorAll<HTMLElement>('.cyc-md-table-wrap')].map(
                (wrap) => ({
                  ...rect(wrap),
                  unit: (() => {
                    let el: Element = wrap;
                    while (el.parentElement !== article) el = el.parentElement!;
                    return rect(el);
                  })(),
                  clientWidth: wrap.clientWidth,
                  scrollWidth: wrap.scrollWidth,
                  table: rect(wrap.querySelector('table')!),
                  containers: (() => {
                    const boxes = [];
                    for (let el = wrap.parentElement; el && el !== article; el = el.parentElement) {
                      if (!el.matches('blockquote, details, li, ul, ol')) continue;
                      const r = el.getBoundingClientRect();
                      const s = getComputedStyle(el);
                      boxes.push({
                        tag: el.tagName,
                        left: r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft),
                        right:
                          r.right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight),
                        top: r.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop),
                        bottom:
                          r.bottom - parseFloat(s.borderBottomWidth) - parseFloat(s.paddingBottom)
                      });
                    }
                    return boxes;
                  })(),
                  parentContentLeft:
                    wrap.parentElement!.getBoundingClientRect().left +
                    parseFloat(getComputedStyle(wrap.parentElement!).paddingLeft) +
                    parseFloat(getComputedStyle(wrap.parentElement!).borderLeftWidth)
                })
              )
            };
          });
          const shots = [];
          const labels = ['', 'list-', 'quote-', 'details-'].flatMap((prefix) =>
            ['narrow', 'seven', 'twenty'].map((label) => prefix + label)
          );
          const extraLabels = [
            'list-only-narrow',
            'quote-only-narrow',
            'details-only-narrow',
            'intrinsic',
            'list-intrinsic',
            'quote-intrinsic',
            'details-intrinsic',
            'combined-twenty'
          ];
          for (const [i, label] of labels.entries()) {
            await page
              .locator('.cyc-md-table-wrap')
              .nth(i)
              .evaluate((el) => el.scrollIntoView({block: 'center'}));
            const documentSize = await page.evaluate(() => ({
              scrollWidth: document.scrollingElement!.scrollWidth,
              clientWidth: document.scrollingElement!.clientWidth
            }));
            shots.push({label, ...documentSize});
            await page.screenshot({
              path: join(evidence, phase, `${id}-${label}.png`),
              animations: 'disabled'
            });
          }
          const mixedList = page.locator('.cyc-md-list:has(.cyc-md-table-wrap)').first();
          const mixedHeight = (await mixedList.boundingBox())!.height;
          // A tall viewport shows the marker, prose and all three tables together,
          // without an element screenshot being clipped by the viewer scroll box.
          await page.setViewportSize({width, height: Math.ceil(mixedHeight) + 100});
          await mixedList.evaluate((el) => el.scrollIntoView({block: 'start'}));
          await page.screenshot({
            path: join(evidence, phase, `${id}-mixed-list.png`),
            animations: 'disabled'
          });
          await page.setViewportSize({width, height: 900});
          measurements.push({id, ...g, shots});
          const check = (ok: boolean, message: string) => {
            if (!ok) failures.push(`${id}: ${message}`);
          };
          const reading = Math.min(width - 32, 736);
          check(
            shots.every((s) => s.scrollWidth <= s.clientWidth),
            'document has horizontal overflow'
          );
          check(g.theme === colorScheme, 'theme did not apply');
          check(
            g.prose.every((r) => Math.abs(r.width - reading) <= 1),
            'top-level prose width changed'
          );
          check(
            g.tables.every((r) => r.left >= g.viewer.left + 15 && r.right <= g.viewer.right - 15),
            'table escapes viewer padding'
          );
          // Check every ancestor, not merely the table's immediate parent. A
          // locally scrolling table's box must stay inside the quote bar,
          // details border and every level of list indentation.
          for (const [i, table] of g.tables.entries()) {
            for (const container of table.containers) {
              check(
                table.left >= container.left - 1 &&
                  table.right <= container.right + 1 &&
                  table.top >= container.top - 1 &&
                  table.bottom <= container.bottom + 1,
                `${[...labels, ...extraLabels][i]} overlaps ${container.tag} content box`
              );
            }
          }
          for (const offset of [3, 6, 9]) {
            const [narrow, seven, twenty] = g.tables.slice(offset, offset + 3);
            check(
              Math.abs(narrow.table.left - narrow.parentContentLeft) <= 1 &&
                Math.abs(narrow.table.width - g.tables[0].table.width) <= 1,
              `${labels[offset]} moved or stretched`
            );
            if (width > 768) {
              check(
                seven.scrollWidth <= seven.clientWidth + 1 && seven.width > reading + 100,
                `${labels[offset + 1]} still scrolls inside the reading column`
              );
            }
            check(
              Math.abs(twenty.right - (width - 16 - (offset === 9 ? 13 : 0))) <= 1 &&
                Math.abs(twenty.left - (16 + (offset === 3 ? 48 : offset === 6 ? 17 : 13))) <= 1 &&
                twenty.scrollWidth > twenty.clientWidth,
              `${labels[offset + 2]} does not use full viewer width with local scroll`
            );
          }
          for (const [index, inset] of [
            [12, 48],
            [13, 17],
            [14, 13]
          ]) {
            const narrow = g.tables[index];
            check(
              Math.abs(narrow.unit.width - reading) <= 1 &&
                Math.abs(narrow.table.left - ((width - reading) / 2 + inset)) <= 1 &&
                Math.abs(narrow.table.width - g.tables[0].table.width) <= 1,
              `${extraLabels[index - 12]} changed base geometry`
            );
          }
          if (width > 768) {
            for (const index of [15, 16, 17, 18]) {
              check(
                g.tables[index].unit.width > reading && g.tables[index].unit.width < width - 100,
                `${extraLabels[index - 12]} unit widened beyond intrinsic need`
              );
            }
          }
          check(
            Math.abs(g.tables[0].table.left - (width - reading) / 2) <= 1,
            'narrow table moved from prose edge'
          );
          check(g.tables[0].table.width < reading, 'narrow table was stretched');
          if (width > 768) {
            check(
              g.tables[1].width > reading + 100,
              'seven-column table still constrained to prose'
            );
            check(
              g.tables[1].scrollWidth <= g.tables[1].clientWidth + 1,
              'seven-column table still scrolls on laptop'
            );
          }
          check(
            Math.abs(g.tables[2].width - (width - 32)) <= 1,
            'very wide table does not use full viewer width'
          );
          check(
            g.tables[2].scrollWidth > g.tables[2].clientWidth,
            'very wide table lost its local scroll'
          );
        }
      }
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(
    join(evidence, phase, 'measurements.json'),
    JSON.stringify({measurements, failures}, null, 2)
  );
  expect(failures).toEqual([]);
});
