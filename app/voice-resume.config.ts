import {defineConfig, devices} from '@playwright/test';
import {existsSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';

// The microphone-after-background spec (e2e/voice), in Chromium AND WebKit, each
// with a fake microphone: Chromium plays a generated tone file, WebKit uses its
// mock capture device. Its own config because the offline suite is
// Chromium-only and floors its collected count.
//
//   npx playwright test -c voice-resume.config.ts
//
// It serves the committed app/dist, like the offline suite, on its own port
// (the rig reads CYC_OFFLINE_PORT) so it can run beside an offline run.

process.env.CYC_OFFLINE_PORT ||= '8296';
const port = Number(process.env.CYC_OFFLINE_PORT);
const origin = process.env.CYC_PAGE?.replace(/\/$/, '') || `http://127.0.0.1:${port}`;
const ownServer = !process.env.CYC_PAGE;
const dist = resolve(__dirname, 'dist');

// A 440 Hz tone whose loudness swells and falls three times a second, so the
// recording strip has a shape to draw. 16 kHz mono 16-bit PCM; Chromium loops it.
function toneWav(): string {
  const rate = 16000;
  const n = rate * 4;
  const out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + n * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = 0.08 + 0.32 * Math.abs(Math.sin(Math.PI * 1.5 * t));
    out.writeInt16LE(Math.round(32767 * env * Math.sin(2 * Math.PI * 440 * t)), 44 + i * 2);
  }
  const path = resolve(tmpdir(), 'cyc-voice-resume-tone.wav');
  writeFileSync(path, out);
  return path;
}
const tone = toneWav();

if (ownServer && !existsSync(resolve(dist, 'index.html'))) {
  throw new Error(`THE BUNDLE IS NOT BUILT. ${dist}/index.html does not exist.`);
}

export default defineConfig({
  testDir: './e2e/voice',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  retries: 0,
  reporter: [['list']],
  use: {headless: true, permissions: ['microphone']},
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--mute-audio',
            '--autoplay-policy=no-user-gesture-required',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-audio-capture=${tone}`
          ]
        }
      }
    },
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
