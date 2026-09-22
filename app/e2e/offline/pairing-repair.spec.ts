import {test, expect} from '@playwright/test';
import {PAGE, installIsolation, seedKeys} from './rig';
import {startEngine, type TestEngine} from './engine';

/* THE REBUILT-ENGINE RE-PAIR (live 2026-09-22, the hosted-test hiccup).
 *
 * A machine is wiped and reinstalled under the SAME name (user@host), so it
 * comes back with a NEW engine id and a NEW pairing key while the app still
 * holds the OLD engine's keyring record for that user@host. Following the
 * fresh pair link then opened the screen with the engine and the key visible
 * but never said "Key received", and Pair sat on "Pairing..." until a reload.
 *
 * The suspect hole (screen.ts runSync): the held link key is only applied to
 * a row that exists, and the row for the NEW engine is never built because
 * rowPaired() reads the STALE keyring record for the shared user@host; the
 * key is then consumed unapplied (markApplied via the engines.some arm).
 *
 * This spec models exactly that state: a dead OLD engine and a live NEW one
 * sharing user@host, a stale keyring record, and a fresh #pair link naming
 * the NEW engine id. A followed pair link is a deliberate (re)pair and must
 * ALWAYS reach the confirm moment. Fails on the pre-fix build (the repro),
 * passes once runSync treats a held link as authoritative. */

test.skip(({browserName}) => browserName !== 'chromium', 'chromium-only');

const USER = 'fixture';
const HOST = 'rebuiltbox';
const UH = `${USER}@${HOST}`;

let rig: TestEngine | null = null;
test.afterEach(async () => {
  await rig?.close();
  rig = null;
});

test('a fresh pair link for a rebuilt engine reaches "Key received" despite the stale keyring', async ({
  page
}) => {
  // the OLD engine: booted only to mint a real key and a port, then closed --
  // the machine it stood for was wiped
  const oldRig = await startEngine({user: USER, host: HOST});
  const oldKeyB64 = oldRig.contentKeyB64;
  const oldPort = oldRig.port;
  await oldRig.close();

  // the LIVE rebuilt engine: same user@host, new key, new engine id
  rig = await startEngine({user: USER, host: HOST});

  await installIsolation(page);

  // the app's stored world from BEFORE the rebuild: the old engine (now dead)
  // and the new one, both under the same user@host; engine ids differ.
  await page.addInitScript(
    (cfg) => {
      localStorage.setItem('cyc-config', JSON.stringify(cfg));
    },
    {
      engines: [
        {url: `ws://127.0.0.1:${oldPort}/ws`, engineId: 'e-old', host: HOST, user: USER},
        {url: `ws://127.0.0.1:${rig.port}/ws`, engineId: 'e-new', host: HOST, user: USER}
      ],
      voice: null
    }
  );

  // the STALE keyring record: the OLD engine's content key under the shared
  // user@host, which is what makes the screen read this name as "paired"
  await seedKeys(page, [{userHost: UH, keyB64: oldKeyB64}]);

  // follow the FRESH pair link: new engine id, new key, first open (no reload)
  const consoleLines: string[] = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  const extra = `&engine=${encodeURIComponent('e-new')}`;
  const hash = `#pair=${encodeURIComponent(rig.contentKeyB64)}`;
  await page.goto(`${PAGE}/?testhooks=1${extra}&v=${Date.now()}${hash}`);

  // THE CONTRACT: a followed link always reaches the confirm moment.
  const row = page.locator('.cyc-pairing-row.is-confirm');
  try {
    await expect(row).toHaveCount(1, {timeout: 20_000});
  } catch (e) {
    const state = await page.evaluate(() => ({
      pairingMounted: !!document.querySelector('.cyc-pairing'),
      pairingRows: document.querySelectorAll('.cyc-pairing-row').length,
      url: location.href,
      cfg: localStorage.getItem('cyc-config')
    }));
    console.log('DEBUG page state:', JSON.stringify(state));
    console.log('DEBUG console tail:', JSON.stringify(consoleLines.slice(-40)));
    throw e;
  }
  await expect(row.locator('.cyc-pairing-row-state')).toHaveText('Key received');
});
