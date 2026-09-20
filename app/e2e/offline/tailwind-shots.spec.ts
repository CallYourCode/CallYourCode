import {test} from '@playwright/test';
import {bootIsolated, evidenceShot, installIsolation, PAGE} from './rig';

const SCREEN = process.env.CYC_TW_SCREEN || 'shell';
const PHASE = process.env.CYC_TW_PHASE || 'before';
// Evidence folder under e2e/screenshots: tailwind/<screen>/<phase>-<size>.png.
// A normal run only attaches the shots; `-u` refreshes the tracked copies.
const OUT = `tailwind/${SCREEN}`;

const SIZES = [
  ['phone', 390, 844],
  ['tablet-portrait', 768, 1024],
  ['tablet-landscape', 1024, 768],
  ['laptop', 1280, 800]
] as const;

/** Screens that open one named chat on the lab tab (rich-message fixtures). */
const LAB_CHATS: Record<string, string> = {
  markdown: 'Formatting Sampler',
  attachments: 'Attachment Sampler',
  voice: 'Voice Sampler'
};

/** Invented engine so the pairing screen has a row. Never a real host, never paired. */
const PAIR_ENGINE = {
  url: 'ws://127.0.0.1:9',
  engineId: 'cyc-test-engine',
  host: 'testbox',
  user: 'fixture'
};

test.describe.configure({mode: 'serial'});

for (const [label, w, h] of SIZES) {
  test(`shot ${SCREEN} ${PHASE} ${label}`, async ({page}) => {
    test.setTimeout(60_000);

    if (SCREEN === 'pairing') {
      // No testmode param: main.ts only mounts the pairing screen outside test mode.
      // Seed an invented config and block /config so the live server's real
      // engine list can never reach the shot.
      await page.setViewportSize({width: w, height: h});
      await installIsolation(page);
      await page.route('**/config', (route) => route.abort());
      await page.addInitScript(
        (cfg) => {
          localStorage.setItem('cyc-config', JSON.stringify(cfg));
        },
        {engines: [PAIR_ENGINE], voice: null}
      );
      await page.goto(`${PAGE}/?testhooks=1&v=${Date.now()}`);
      await page.waitForSelector('.cyc-pairing-row');
      await page.waitForTimeout(500);
      await evidenceShot(page, OUT, `${PHASE}-${label}`);
      return;
    }

    const extra = SCREEN === 'settings' || SCREEN === 'modal' ? '&settings=1' : '';
    try {
      await bootIsolated(page, w, h, undefined, extra);
    } catch {
      await page.waitForSelector('#cyc-left-pane', {timeout: 5_000});
    }
    await page.waitForSelector('#cyc-left-pane');
    if (SCREEN === 'lab' || SCREEN === 'sessions' || LAB_CHATS[SCREEN]) {
      const lab = page.locator('.cyc-seg', {hasText: 'lab'});
      if (await lab.count()) await lab.click();
    }
    if (LAB_CHATS[SCREEN]) {
      await page.locator('.cyc-session-entry', {hasText: LAB_CHATS[SCREEN]}).first().click();
      await page.waitForTimeout(400);
    }
    if (SCREEN === 'chat' || SCREEN === 'composer' || SCREEN === 'media') {
      await page.locator('.cyc-session-entry').first().click();
      await page.waitForTimeout(400);
    }
    if (SCREEN === 'modal') {
      await page.locator('.cyc-list-row', {hasText: 'Report a bug'}).first().click();
      await page.waitForSelector('.cyc-modal.active');
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(300);
    await evidenceShot(page, OUT, `${PHASE}-${label}`);
  });
}
