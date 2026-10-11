import {expect, test, type Page} from '@playwright/test';
import {bootEngines} from './rig';
import {startPresentationEngine} from './presentationEngine';

// Match device theme: with the row on, the app follows prefers-color-scheme live
// (an OS switch repaints without a reload) and the choice survives a reload.
// Phone size; the scheme is driven by page.emulateMedia({colorScheme}).

const PHONE = {width: 390, height: 844};

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const surface = (page: Page) =>
  page.evaluate(() => document.documentElement.style.getPropertyValue('--cyc-surface'));
const skin = (page: Page) => page.evaluate(() => localStorage.getItem('cyc-skin'));

async function follows(page: Page, scheme: 'dark' | 'light') {
  await page.emulateMedia({colorScheme: scheme});
  await expect.poll(() => theme(page)).toBe(scheme);
  expect(await surface(page)).toBe(scheme === 'dark' ? '#17171a' : '#ffffff');
}

async function openSettings(page: Page) {
  await page.locator('.cyc-pane-menu-btn').first().click();
  await page.waitForSelector('.cyc-settings-open .cyc-left-settings', {timeout: 10_000});
}

test('theme auto: Match device theme follows the device live and survives a reload', async ({
  page
}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    // An existing user who chose day: the stored choice wins over a dark device.
    await page.addInitScript(() => {
      if (!localStorage.getItem('cyc-skin')) localStorage.setItem('cyc-skin', 'day');
    });
    await page.emulateMedia({colorScheme: 'dark'});
    await bootEngines(page, [eng.port], {size: PHONE});
    await page.waitForSelector('#cyc-left-pane');
    expect(await theme(page)).toBe('light');

    await openSettings(page);
    const device = page.getByRole('checkbox', {name: 'Match device theme', exact: true});
    const night = page.getByRole('checkbox', {name: 'Theme', exact: true});
    await expect(device).not.toBeChecked();
    await expect(night).toBeEnabled();

    await page.locator('.cyc-list-row', {has: device}).click();
    await expect(device).toBeChecked();
    expect(await skin(page)).toBe('auto');
    await expect.poll(() => theme(page)).toBe('dark');
    await expect(night).toBeChecked();
    await expect(night).toBeDisabled();

    await follows(page, 'light');
    await expect(night).not.toBeChecked();
    await page
      .locator('.cyc-left-settings')
      .first()
      .screenshot({path: test.info().outputPath('settings-light.png')});
    await follows(page, 'dark');
    await expect(night).toBeChecked();
    await page
      .locator('.cyc-left-settings')
      .first()
      .screenshot({path: test.info().outputPath('settings-dark.png')});

    await page.reload();
    await page.waitForSelector('#cyc-left-pane');
    expect(await skin(page)).toBe('auto');
    expect(await theme(page)).toBe('dark');
    await follows(page, 'light');
    await follows(page, 'dark');
  } finally {
    await eng.close();
  }
});

test('theme auto: a device with nothing stored starts on Match device theme', async ({page}) => {
  test.setTimeout(90_000);
  const eng = await startPresentationEngine();
  try {
    await page.emulateMedia({colorScheme: 'dark'});
    await bootEngines(page, [eng.port], {size: PHONE});
    await page.waitForSelector('#cyc-left-pane');
    expect(await skin(page)).toBe('auto');
    expect(await theme(page)).toBe('dark');

    await openSettings(page);
    await expect(
      page.getByRole('checkbox', {name: 'Match device theme', exact: true})
    ).toBeChecked();
    await follows(page, 'light');
  } finally {
    await eng.close();
  }
});
