import {defineConfig, devices} from '@playwright/test';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

// The play-tap proof (e2e/offline/play-tap.spec.ts): Chromium desktop and
// WebKit with the iPhone profile, against the offline sealed rig with a slowed
// tunnel. A dedicated config, like scroll-matrix.config.ts: it needs real reply
// clips (PLAYTAP_AUDIO_DIR) so it stays out of the default offline suite and
// its guard floor.
//
//   CYC_OFFLINE_PORT=8317 PLAYTAP_AUDIO_DIR=/tmp/playtap-data/audio PLAYTAP_OUT=/tmp/out \
//     npx playwright test -c play-tap.config.ts
//
// It serves the committed app/dist, so a "before" pass is a dist built from
// main with PLAYTAP_TAG=before.

const port = Number(process.env.CYC_OFFLINE_PORT || 8295);
const origin = process.env.CYC_PAGE?.replace(/\/$/, '') || `http://127.0.0.1:${port}`;
const ownServer = !process.env.CYC_PAGE;
const dist = resolve(__dirname, process.env.PLAYTAP_DIST || 'dist');

if (ownServer && !existsSync(resolve(dist, 'index.html'))) {
  throw new Error(`THE BUNDLE IS NOT BUILT. ${dist}/index.html does not exist.`);
}

const chromiumLaunch = {args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required']};

export default defineConfig({
  testDir: './e2e/offline',
  testMatch: /play-tap\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  retries: 0,
  reporter: [['list']],
  use: {headless: true},
  projects: [
    {name: 'chromium', use: {...devices['Desktop Chrome'], launchOptions: chromiumLaunch}},
    {name: 'webkit', use: {...devices['iPhone 13']}}
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
