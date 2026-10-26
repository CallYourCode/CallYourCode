import {test, expect, chromium, webkit} from '@playwright/test';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// Run against an isolated production app server and engine with a shown tables.md.
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
      await page.locator('.cyc-md-table').nth(2).waitFor({timeout: 15_000});
      await page.evaluate(() => document.fonts.ready);
      for (const width of [390, 1280, 1920]) {
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.setViewportSize({width, height: 900});
          await page.emulateMedia({colorScheme});
          await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
          const id = `${name}-${width}-${colorScheme}`;
          const g = await page.evaluate(() => {
            const rect = (el: Element) => {
              const r = el.getBoundingClientRect();
              return {left: r.left, right: r.right, width: r.width};
            };
            const article = document.querySelector('.cyc-fv-body > .cyc-md')!;
            const scroll = document.querySelector('.cyc-fv-scroll')!;
            return {
              theme: document.documentElement.dataset.theme,
              documentWidth: document.scrollingElement!.scrollWidth,
              clientWidth: document.scrollingElement!.clientWidth,
              viewer: rect(scroll),
              prose: [...article.children]
                .filter((el) => !el.matches('.cyc-md-table-wrap, .cyc-md-anchor'))
                .map(rect),
              tables: [...article.querySelectorAll<HTMLElement>('.cyc-md-table-wrap')].map(
                (wrap) => ({
                  ...rect(wrap),
                  clientWidth: wrap.clientWidth,
                  scrollWidth: wrap.scrollWidth,
                  table: rect(wrap.querySelector('table')!)
                })
              )
            };
          });
          const shots = [];
          for (const [i, label] of ['narrow', 'seven', 'twenty'].entries()) {
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
            'prose width changed'
          );
          check(
            g.tables.every((r) => r.left >= g.viewer.left + 15 && r.right <= g.viewer.right - 15),
            'table escapes viewer padding'
          );
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
