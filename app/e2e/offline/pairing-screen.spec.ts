import {test, expect, type Page} from '@playwright/test';
import {bootPinned} from './rig';
import {startEngine, type TestEngine} from './engine';
test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');
const SESSION = 'fixture-pairing-screen';
const USER = 'fixture';
const HOST = 'fixturebox';
const UH = `${USER}@${HOST}`;
const PAIR_COMMAND = 'cyc pair';
function makeEngine(): Promise<TestEngine> {
  return startEngine({
    user: USER,
    host: HOST,
    onConnect: (ws) => {
      ws.send(JSON.stringify({t: 'host', user: USER, host: HOST}));
      ws.send(JSON.stringify({t: 'can', list: []}));
      ws.send(JSON.stringify({t: 'voice', url: 'http://127.0.0.1:1'}));
      ws.send(
        JSON.stringify({
          t: 'sessions',
          list: [
            {
              id: SESSION,
              name: SESSION,
              cwd: '/tmp/' + SESSION,
              unread: 0,
              muted: false,
              alive: true,
              status: 'idle',
              title: {text: SESSION, detail: null}
            }
          ]
        })
      );
    }
  });
}

function pairArrival(
  keyB64: string,
  engineId: string,
  extraQuery = ''
): {extra: string; hash: string} {
  return {
    extra: `&engine=${encodeURIComponent(engineId)}${extraQuery}`,
    hash: `#pair=${encodeURIComponent(keyB64)}`
  };
}
// The computed colour a CSS variable resolves to, as an rgb() string, so a

// settings.css `.cyc-pairing*` rules read.
async function resolvedVar(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const probe = document.createElement('div');
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return rgb;
  }, name);
}

async function computedColor(page: Page, selector: string, prop: string): Promise<string> {
  return page.evaluate(
    ([sel, p]) => getComputedStyle(document.querySelector(sel)!)[p as never] as unknown as string,
    [selector, prop] as const
  );
}

async function storedUserHost(page: Page, uh: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const rec = await (
      window as never as {
        __cycKeyring: {
          getByUserHost(id: string): Promise<{key?: unknown; userHost: string} | null>;
        };
      }
    ).__cycKeyring.getByUserHost(id);
    return rec?.key ? rec.userHost : null;
  }, uh);
}
let rig: TestEngine | null = null;
test.afterEach(async () => {
  await rig?.close();
  rig = null;
});
test('cold open explains itself: key, command, copy, ssh hint, scan button', async ({
  page,
  context
}) => {
  rig = await makeEngine();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await bootPinned(page, rig.port, {skipKey: true, wait: 'none'});
  await page.waitForSelector('.cyc-pairing', {timeout: 20_000});

  await expect(page.locator('.cyc-pairing-logo')).toBeVisible();
  await expect(page.locator('.cyc-pairing-title')).toHaveText('Enter the pairing key');

  const intro = page.locator('.cyc-pairing-intro');
  await expect(intro).toContainText('end-to-end key');
  await expect(intro).toContainText('Only your devices hold it');
  await expect(intro).toContainText('Run this on the machine where your agents live:');
  await expect(page.locator('.cyc-pairing-cmd')).toHaveText(PAIR_COMMAND);
  await expect(intro).toContainText('ssh there first');
  await expect(intro).toContainText('scan the code');
  await expect(page.locator('.cyc-pairing-scan')).toContainText('Scan QR code');

  const row = page.locator('.cyc-pairing-row');
  await expect(row).toHaveCount(1, {timeout: 10_000});
  await expect(row.locator('.cyc-face')).toBeVisible();
  await expect(row.locator('.cyc-pairing-row-name')).toHaveText(HOST);
  await expect(row.locator('.cyc-pairing-row-id')).toHaveText('id: e1');
  await expect(row.locator('.cyc-pairing-input')).toBeVisible();
  await expect(row.locator('.cyc-pairing-pair')).toHaveText('Pair');

  await expect(page.locator('.cyc-pairing-cmd')).toHaveCount(1);
  await expect(row.locator('pre')).toHaveCount(0);

  await page.locator('.cyc-pairing-copy').click();
  await expect(page.locator('.cyc-pairing-copy-label')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PAIR_COMMAND);
  await expect(page.locator('.cyc-pairing-copy-label')).toHaveText('Copy', {timeout: 5_000});
});
test('#pair arrival: prefilled confirm moment, OK pairs, success beat, row leaves', async ({
  page
}) => {
  rig = await makeEngine();

  const arrival = pairArrival(rig.contentKeyB64, 'e1');
  await bootPinned(page, rig.port, {
    skipKey: true,
    wait: 'none',
    extra: arrival.extra,
    hash: arrival.hash
  });
  const row = page.locator('.cyc-pairing-row.is-confirm');
  await expect(row).toHaveCount(1, {timeout: 20_000});
  await expect(row.locator('.cyc-pairing-row-state')).toHaveText('Key received');
  await expect(row.locator('.cyc-pairing-row-name')).toHaveText(HOST);

  
  // `.is-confirm { border-color: var(--cyc-accent) }` rule did.
  await expect
    .poll(() => computedColor(page, '.cyc-pairing-row.is-confirm', 'borderTopColor'))
    .toBe(await resolvedVar(page, '--cyc-accent'));

  await page.waitForFunction(() => !!(window as never as {__cycKeyring?: unknown}).__cycKeyring, {
    timeout: 20_000
  });
  expect(await row.locator('.cyc-pairing-input').inputValue()).toBe(rig.contentKeyB64);
  expect(await row.locator('.cyc-pairing-input').getAttribute('type')).toBe('text');
  expect(await storedUserHost(page, UH)).toBeNull();

  await row.locator('.cyc-pairing-pair').click();

  const done = page.locator('.cyc-pairing-row.is-paired');
  await expect(done).toHaveCount(1, {timeout: 15_000});
  await expect(done.locator('.cyc-pairing-row-state')).toContainText('Paired');

  
  // border/state-colour rules did, and the actions row is hidden.
  const green = await resolvedVar(page, '--cyc-ok');
  await expect
    .poll(() => computedColor(page, '.cyc-pairing-row.is-paired', 'borderTopColor'))
    .toBe(green);
  expect(
    await computedColor(page, '.cyc-pairing-row.is-paired .cyc-pairing-row-state', 'color')
  ).toBe(green);
  expect(
    await computedColor(page, '.cyc-pairing-row.is-paired .cyc-pairing-row-actions', 'display')
  ).toBe('none');
  await expect
    .poll(() => storedUserHost(page, UH), {
      timeout: 10_000,
      message: 'the OK did not store the key under user@host'
    })
    .toBe(UH);

  await expect(page.locator('.cyc-pairing')).toHaveCount(0, {timeout: 15_000});
  const q = await page.evaluate(() => {
    const p = new URLSearchParams(location.search);
    return {pair: p.get('pair'), engine: p.get('engine'), hash: location.hash};
  });
  expect(q.pair, 'the pairing key is still in the address bar').toBeNull();
  expect(q.hash.includes('pair='), 'the pairing key is still in the fragment').toBe(false);
  expect(q.engine, 'the pairing engineId is still in the address bar').toBeNull();
  await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
});
test('a fake scan result feeds the URL parser: same path, same pairing', async ({page}) => {
  rig = await makeEngine();
  await bootPinned(page, rig.port, {skipKey: true, wait: 'none'});
  await page.waitForSelector('.cyc-pairing', {timeout: 20_000});
  await page.waitForFunction(() => !!(window as never as {__cycPairScan?: unknown}).__cycPairScan, {
    timeout: 20_000
  });
  const scan = (text: string) =>
    page.evaluate(
      (t) => (window as never as {__cycPairScan: (t: string) => boolean}).__cycPairScan(t),
      text
    );

  expect(await scan('EHLO not a url')).toBe(false);
  expect(await scan('https://example.com/index.html')).toBe(false);
  await expect(page.locator('.cyc-pairing-row.is-confirm')).toHaveCount(0);

  expect(
    await scan(
      'https://example.com/index.html?pair=' +
        encodeURIComponent(rig.contentKeyB64) +
        '&engine=' +
        encodeURIComponent('ws://127.0.0.1:59997/ws')
    )
  ).toBe(true);
  await expect(page.locator('.cyc-pairing-row.is-confirm')).toHaveCount(0);
  expect(
    await page.evaluate(() => sessionStorage.getItem('cyc-engine')),
    'a scanned link wrote a fleet pin'
  ).toBeNull();

  expect(
    await scan(
      'https://callyourcode.com/index.html' +
        `?engine=e1#pair=${encodeURIComponent(rig.contentKeyB64)}`
    )
  ).toBe(true);
  await expect(page.locator('.cyc-pairing-row.is-confirm')).toHaveCount(1, {timeout: 10_000});

  expect(await page.locator('.cyc-pairing-row.is-confirm .cyc-pairing-input').inputValue()).toBe(
    rig.contentKeyB64
  );
  expect(await storedUserHost(page, UH), 'a scanned link paired before the click').toBeNull();
  await page.locator('.cyc-pairing-row.is-confirm .cyc-pairing-pair').click();
  await expect
    .poll(() => storedUserHost(page, UH), {
      timeout: 15_000,
      message: 'the scanned link did not store the key under user@host'
    })
    .toBe(UH);
  await expect(page.locator('.cyc-pairing')).toHaveCount(0, {timeout: 15_000});
  expect(
    await page.evaluate(() => sessionStorage.getItem('cyc-engine')),
    'a scanned pairing link wrote a fleet pin'
  ).toBeNull();
  await page.waitForSelector('.cyc-session-entry', {timeout: 20_000});
});
