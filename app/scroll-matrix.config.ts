import {defineConfig, devices} from '@playwright/test';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

// The scroll-redesign matrix (SCROLL-DESIGN.md Deliverable 2, rig a). A dedicated
// config so the one matrix spec runs in Chromium AND WebKit, at the three
// viewports the spec parametrises. It deliberately does NOT reuse the offline
// guard/reporter (that floors the full offline suite's collected count); this
// config is only ever pointed at scroll-matrix.spec.ts.
//
//   # Chromium only:
//   npx playwright test -c scroll-matrix.config.ts --project=chromium
//   # WebKit only:
//   npx playwright test -c scroll-matrix.config.ts --project=webkit
//   # both, JSON for the baseline table:
//   PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/scroll-matrix.json \
//     npx playwright test -c scroll-matrix.config.ts --reporter=json > /tmp/scroll-matrix.json
//
// It serves the committed app/dist (the main=8d70fb8 build for the baseline, a
// branch build for a later step). The seeded engines never announce to
// 127.0.0.1:10100 and the rig's isolation shim refuses any socket to the live
// stack, so a run touches nothing live.

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
  testMatch: /scroll-matrix\.spec\.ts$/,
  fullyParallel: false,
  workers: Number(process.env.CYC_MATRIX_WORKERS || 2),
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
