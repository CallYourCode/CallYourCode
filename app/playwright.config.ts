import {defineConfig, devices} from '@playwright/test';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {refuseReporterOverride} from './e2e/guard-common';

const suite = process.env.CYC_PLAYWRIGHT_SUITE || 'offline';

if (suite !== 'offline' && suite !== 'gate') {
  throw new Error(`CYC_PLAYWRIGHT_SUITE must be "offline" or "gate", got ${JSON.stringify(suite)}`);
}

const launchOptions = {args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required']};

const config = suite === 'gate' ? gateConfig() : offlineConfig();

export default config;

function gateConfig() {
  if (!process.env.CYC_PAGE) {
    throw new Error('happy gate: set CYC_PAGE to the scratch app server');
  }

  return defineConfig({
    testDir: './e2e/gate',
    fullyParallel: false,
    workers: 1,
    timeout: 45_000,
    retries: 0,
    reporter: [['list']],
    use: {...devices['Desktop Chrome'], launchOptions}
  });
}

function offlineConfig() {
  refuseReporterOverride('./e2e/offline/guard.ts');

  const port = Number(process.env.CYC_OFFLINE_PORT || 8295);
  const ownServer = !process.env.CYC_PAGE;
  const origin = process.env.CYC_PAGE?.replace(/\/$/, '') || `http://127.0.0.1:${port}`;
  const dist = resolve(__dirname, 'dist');

  if (ownServer && !existsSync(resolve(dist, 'index.html'))) {
    throw new Error(
      `THE BUNDLE IS NOT BUILT. ${dist}/index.html does not exist. Run bash scripts/build-cyc.sh`
    );
  }

  if (ownServer) {
    const help = spawnSync('python3', ['-m', 'http.server', '--help'], {
      encoding: 'utf8',
      timeout: 10_000
    });
    const found = `${help.stdout ?? ''}${help.stderr ?? ''}`;
    if (help.error || help.status !== 0 || !found.includes('--protocol')) {
      throw new Error(
        'Offline Playwright requires Python 3.11+ with http.server --protocol support.'
      );
    }
  }

  return defineConfig({
    testDir: './e2e/offline',
    fullyParallel: false,
    workers: 4,
    timeout: 90_000,
    // The offline specs boot the full app, seal a tunnel, and reload -- under
    // `workers: 4` a heavy spec (e.g. contract-render's 1000-message cached
    // reload) can occasionally starve past its timeout on a busy machine. A
    // couple of retries heals that environmental flake; a genuinely broken test
    // still fails every attempt. Retries do not change the collected count the
    // guard floors on.
    retries: 2,
    reporter: [['list'], ['./e2e/offline/guard.ts']],
    use: {headless: true},
    projects: [{name: 'chromium', use: {...devices['Desktop Chrome'], launchOptions}}],
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
}
