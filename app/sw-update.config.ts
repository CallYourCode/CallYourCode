import {defineConfig, devices} from '@playwright/test';

// The deploy-update proofs (a new build reaching an installed client: the
// stuck build, the parked worker and hung reload, the draft-held reload) in
// Chromium AND WebKit. WebKit is the closest this machine gets to the iPhone
// standalone app, where the stuck build was seen. The specs run their own
// swappable hosts (a build has to change under an open client), so this config
// needs no shared web server and no offline-suite guard floor.
//
//   npx playwright test -c sw-update.config.ts
//   npx playwright test -c sw-update.config.ts --project=webkit

const chromiumLaunch = {args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required']};

export default defineConfig({
  testDir: './e2e/offline',
  testMatch: /sw-(stuck-build|deploy-lands|activation-race|chunk-reload)\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  retries: 0,
  reporter: [['list']],
  use: {headless: true},
  projects: [
    {name: 'chromium', use: {...devices['Desktop Chrome'], launchOptions: chromiumLaunch}},
    {name: 'webkit', use: {...devices['Desktop Safari']}}
  ]
});
