import {defineConfig, devices} from '@playwright/test';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

// The ScrollOwner release spec (scroll-owner-release.spec.ts) in Chromium AND
// WebKit. The default offline config runs it in Chromium only; this one adds
// the WebKit run (its CDP-touch case skips there). Like scroll-matrix.config it
// skips the offline guard (that floors the full suite's collected count).
//
//   npx playwright test -c scroll-owner.config.ts

const port = Number(process.env.CYC_OFFLINE_PORT || 8295);
const origin = process.env.CYC_PAGE?.replace(/\/$/, '') || `http://127.0.0.1:${port}`;
const ownServer = !process.env.CYC_PAGE;
const dist = resolve(__dirname, 'dist');

if (ownServer && !existsSync(resolve(dist, 'index.html'))) {
  throw new Error(`THE BUNDLE IS NOT BUILT. ${dist}/index.html does not exist.`);
}

const chromiumLaunch = {args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required']};

export default defineConfig({
  testDir: './e2e/offline',
  testMatch: /scroll-owner-release\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 150_000,
  retries: 0,
  reporter: [['list']],
  use: {headless: true},
  projects: [
    {name: 'chromium', use: {...devices['Desktop Chrome'], launchOptions: chromiumLaunch}},
    {name: 'webkit', use: {...devices['Desktop Safari']}}
  ],
  ...(ownServer
    ? {
        webServer: {
          command: `python3 -m http.server ${port} --protocol HTTP/1.1 --directory ${JSON.stringify(dist)} --bind 127.0.0.1`,
          url: `${origin}/`,
          reuseExistingServer: false,
          timeout: 30_000,
          stdout: 'ignore',
          stderr: 'ignore'
        }
      }
    : {})
});
