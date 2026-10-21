import {test, expect} from '@playwright/test';
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
type Rig = {origin: string; engineId: string; key: string; engineUrl: string; submitted: string[]};
let proc: ChildProcess;
let control = '';
let home = '';
async function info(): Promise<Rig> {return (await fetch(control + '/info')).json();}
async function action(path: string, body: unknown = {}) {
  const r = await fetch(control + path, {method: 'POST', body: JSON.stringify(body)});
  expect(r.ok).toBe(true);
}
test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cyc-ws-browser-'));
  proc = spawn('env', ['-u', 'HERDR_PANE_ID', '-u', 'TMUX_PANE', '-u', 'CYC_AGENT_ID', '-u', 'HERDR_ENV',
    '-u', 'HERDR_WORKSPACE_ID', '-u', 'HERDR_TAB_ID', 'AGENT_PORT=1', 'CYC_ENGINE_URL=http://127.0.0.1:1',
    'bun', 'run', resolve(__dirname, '../../../engine/agent-engine/src/e2e/ws-app-rig.ts')],
    {env: {...process.env, HOME: home, CYC_DATA_DIR: home, CYC_LOG_DIR: join(home, 'logs')}, stdio: ['ignore', 'pipe', 'pipe']});
  control = await new Promise<string>((yes, no) => {
    let output = '';
    const timer = setTimeout(() => no(new Error('rig timeout: ' + output)), 30_000);
    proc.stdout!.on('data', (bytes) => {
      output += bytes.toString();
      const match = output.match(/WS_RIG (\{[^\n]+\})/);
      if (match) {clearTimeout(timer); yes(JSON.parse(match[1]).control);}
    });
    proc.stderr!.on('data', (bytes) => {output += bytes.toString();});
    proc.on('exit', (code) => {clearTimeout(timer); no(new Error('rig exited ' + code + ': ' + output));});
  });
});
test.afterEach(async ({page}, testInfo) => {
  if (control) {
    const state = {...await info().catch(() => null), browser: await page.evaluate(() => ({hidden: document.hidden, online: navigator.onLine, secure: isSecureContext, mediaRecorder: typeof MediaRecorder, mic: (window as any).__gateMic && {error: (window as any).__gateMic.error, installed: (window as any).__gateMic.installed, constraints: (window as any).__gateMic.constraints, ready: (window as any).__cycPipeline?.initialized}})).catch(() => null)};
    await testInfo.attach('scratch-engine-state', {body: JSON.stringify(state), contentType: 'application/json'});
    if (testInfo.status !== testInfo.expectedStatus) console.log('SCRATCH DIAGNOSTICS', JSON.stringify({browser: state.browser, engine: state.lines?.slice(-12), app: state.appLog?.slice(-12)}));
  }
  if (control) await action('/stop').catch(() => {});
  if (proc && proc.exitCode === null) {
    await Promise.race([new Promise<void>((r) => proc.once('exit', () => r())), new Promise<void>((r) => setTimeout(r, 5000))]);
    if (proc.exitCode === null) proc.kill('SIGTERM');
  }
  if (home) await rm(home, {recursive: true, force: true});
  control = '';
});

test('production sealed WS: pairing, chat, large hashed transfer, STT, restarts and long-lived traffic', async ({page, browser}, testInfo) => {
  test.setTimeout(300_000);
  const rig = await info();
  for (const key of ['', 'A'.repeat(43)]) {
    const isolated = await browser.newContext();
    try {
      const unpaired = await isolated.newPage();
      await unpaired.goto(`${rig.origin}/?engine=${rig.engineId}&testhooks=1${key ? '#pair=' + key : '#app'}`);
      await expect(unpaired.getByRole('button', {name: 'Pair', exact: true}).last()).toBeVisible({timeout: 20_000});
      if (key) {
        await unpaired.locator('.cyc-pairing-row.is-confirm').getByRole('button', {name: 'Pair', exact: true}).click();
        await unpaired.waitForTimeout(1500);
      }
      expect(await unpaired.locator('.cyc-session-entry').count()).toBe(0);
      expect((await (await fetch(control + '/devices')).json()).devices).toHaveLength(0);
    } finally {await isolated.close();}
  }
  const sockets: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  await page.bringToFront();
  await page.goto(`${rig.origin}/?engine=${rig.engineId}&testhooks=1#pair=${rig.key}`);
  await page.locator('.cyc-pairing-row.is-confirm').getByRole('button', {name: 'Pair', exact: true}).click();
  const row = page.locator('.cyc-session-entry').first();
  await expect(row).toBeVisible({timeout: 30_000});
  await row.click();
  await expect(page.locator('.cyc-composer-input').first()).toBeVisible();
  const sent = 'real WS browser gate ' + testInfo.project.name;
  await page.locator('.cyc-composer-input').first().fill(sent);
  await page.locator('.cyc-composer-input').first().press('Enter');
  await expect.poll(async () => (await info()).submitted.some((s) => s.includes(sent))).toBe(true);
  await action('/reply', {text: 'production relay reply'});
  await expect(page.locator('.cyc-message', {hasText: 'production relay reply'})).toHaveCount(1);
  expect(sockets.some((s) => s.startsWith(rig.origin.replace('http', 'ws') + '/device?engine='))).toBe(true);

  // Existing app test hooks call the real tunnel. ASCII bytes let the hook's
  // text response be hashed without introducing a test-only binary transport.
  const transfer = await page.evaluate(async ({engineUrl}) => {
    const w = window as any;
    const base = engineUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
    const payload = '0123456789abcdef'.repeat(512 * 1024);
    const hex = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
      .map((x) => x.toString(16).padStart(2, '0')).join('');
    const hash = await hex(payload);
    const ask = async (path: string, init?: RequestInit) => w.__cycEngineFetch(base + path, init);
    const begin = await ask('/transfer/begin', {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({kind: 'upload', sessionId: 'browser-gate', size: payload.length, mime: 'application/octet-stream', name: 'large.txt', sha256: hash})});
    if (!begin.ok) throw new Error('begin ' + begin.body);
    const meta = JSON.parse(begin.body);
    let segments = 0;
    for (let at = 0; at < payload.length; at += meta.chunk) {
      const r = await ask(`/transfer/${meta.id}/${segments}`, {method: 'PUT', body: payload.slice(at, at + meta.chunk)});
      if (!r.ok) throw new Error('put ' + r.body);
      segments++;
    }
    const finish = await ask(`/transfer/${meta.id}/finish`, {method: 'POST'});
    if (!finish.ok) throw new Error('finish ' + finish.body);
    const {uploadId} = JSON.parse(finish.body);
    const download = await ask('/upload/' + uploadId);
    return {hash, got: await hex(download.body), segments, bytes: download.body.length};
  }, rig);
  expect(transfer.segments).toBeGreaterThan(1);
  expect(transfer.bytes).toBe(8 * 1024 * 1024);
  expect(transfer.got).toBe(transfer.hash);

  const stt = await page.evaluate(async () => {
    const partials: string[] = [];
    const stream = (window as any).__cycStore.openSttStream(undefined, {onPartial: (s: string) => partials.push(s)});
    stream.push(new Float32Array(4000));
    await new Promise((r) => setTimeout(r, 300));
    return {partials, final: await stream.finish()};
  });
  expect(stt.partials.length).toBeGreaterThan(0);
  expect(JSON.stringify(stt.final)).toContain('scratch final transcript');

  for (const restart of ['/restart-engine', '/restart-app']) {
    await action(restart);
    await expect.poll(async () => page.evaluate(() => (window as any).__cycStore.tabs().some((t: any) => t.state === 'connected')),
      {timeout: 75_000}).toBe(true);
    const reply = 'after ' + restart;
    await action('/reply', {text: reply});
    await expect(page.locator('.cyc-message', {hasText: reply})).toHaveCount(1, {timeout: 30_000});
  }
  const start = Date.now();
  await page.evaluate(async () => {
    for (let n = 0; n < 350; n++) (window as any).__cycWire.heard('unknown', 'gate-' + n);
  });
  await page.waitForTimeout(121_000);
  await action('/reply', {text: 'still alive after 120 seconds and 350 frames'});
  await expect(page.locator('.cyc-message', {hasText: 'still alive after 120 seconds and 350 frames'})).toHaveCount(1);
  const enrolled = (await (await fetch(control + '/devices')).json()).devices;
  expect(enrolled).toHaveLength(1);
  await action('/revoke-device');
  await page.reload();
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => (window as any).__cycStore.tabs().some((t: any) => t.state === 'connected'))).toBe(false);
  expect((await (await fetch(control + '/devices')).json()).devices).toEqual(enrolled.map((d: any) => ({...d, revoked: true})));
  await testInfo.attach('transport-evidence' , {body: JSON.stringify({sockets, transfer, stt, aliveMs: Date.now() - start}), contentType: 'application/json'});
});

test('real call UI captures synthetic microphone PCM and plays a growing spoken reply', async ({page}, testInfo) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    localStorage.setItem('cyc-toolbar-call', '1');
    const state = {installed: false, error: '', constraints: null as MediaStreamConstraints | null, gain: null as GainNode | null, tracks: [] as MediaStreamTrack[]};
    (window as any).__gateMic = state;
    // WebKit's headless build may omit native device enumeration. The only
    // injected seam is the synthetic microphone; its MediaStream is real.
    const capture = async (constraints: MediaStreamConstraints) => {
      state.constraints = constraints;
      try {
      const context = new AudioContext();
      void context.resume();
      const source = context.createOscillator(); source.frequency.value = 190;
      const gain = context.createGain(); gain.gain.value = 0;
      const destination = context.createMediaStreamDestination();
      source.connect(gain); gain.connect(destination); source.start();
      state.gain = gain; state.tracks = destination.stream.getTracks();
      return destination.stream;
      } catch (error) { state.error = String(error); throw error; }
    };
    try {
      Object.defineProperty(navigator, 'mediaDevices', {value: {getUserMedia: capture}, configurable: true});
      state.installed = navigator.mediaDevices.getUserMedia === capture;
    } catch (error) {state.error = 'install: ' + String(error);}
  });
  const rig = await info();
  await page.bringToFront();
  await page.goto(`${rig.origin}/?engine=${rig.engineId}&testhooks=1#pair=${rig.key}`);
  await page.locator('.cyc-pairing-row.is-confirm').getByRole('button', {name: 'Pair', exact: true}).click();
  await page.locator('.cyc-session-entry').first().click();
  await expect(page.locator('.cyc-composer-input').first()).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.__gateVoice = {partials: [] as string[], grows: 0, done: 0};
    w.__cycPipeline.on('partial', (text: string) => w.__gateVoice.partials.push(text));
    w.__cycStore.onSayGrow(() => w.__gateVoice.grows++);
    w.__cycStore.onSayDone(() => w.__gateVoice.done++);
  });
  expect(await page.evaluate(() => typeof MediaRecorder), 'native MediaRecorder is required; do not replace it with a fake recorder to pass the voice gate').toBe('function');
  expect(await page.evaluate(() => (window as any).__gateMic.installed)).toBe(true);
  await page.locator('.cyc-conv-toggle:visible').first().click({timeout: 10_000});
  await expect.poll(() => page.evaluate(() => !!(window as any).__cycPipeline.handsFreeSessionId)).toBe(true);
  await page.evaluate(() => {(window as any).__gateMic.gain.gain.value = 0.15;});
  await page.waitForTimeout(1600);
  await page.evaluate(() => {(window as any).__gateMic.gain.gain.value = 0;});
  await expect.poll(() => page.evaluate(() => (window as any).__gateVoice.partials.length), {timeout: 15_000}).toBeGreaterThan(0);
  await expect.poll(async () => (await info()).submitted.some((s) => s.includes('scratch final transcript')), {timeout: 20_000}).toBe(true);
  await action('/reply', {speak: true, text: 'This is a growing spoken reply from the scratch agent. '.repeat(12)});
  await expect.poll(() => page.evaluate(() => (window as any).__gateVoice.grows), {timeout: 20_000}).toBeGreaterThan(1);
  await expect.poll(() => page.evaluate(() => (window as any).__gateVoice.done), {timeout: 20_000}).toBe(1);
  const evidence = await page.evaluate(() => {
    const w = window as any;
    return {voice: w.__gateVoice, constraints: w.__gateMic.constraints, speaker: w.__cycSpeakerState()};
  });
  expect(evidence.speaker.callPlayback).toBe(true);
  expect(evidence.speaker.state).not.toBe('blocked');
  expect(evidence.constraints.audio).toMatchObject({echoCancellation: true, noiseSuppression: true, autoGainControl: true});
  await page.locator('.cyc-conv-toggle:visible').first().click();
  await expect.poll(() => page.evaluate(() => (window as any).__cycPipeline.handsFreeSessionId)).toBeNull();
  await expect.poll(() => page.evaluate(() => (window as any).__gateMic.tracks.every((t: MediaStreamTrack) => t.readyState === 'ended')), {timeout: 10_000}).toBe(true);
  await testInfo.attach('synthetic-call-evidence', {body: JSON.stringify(evidence), contentType: 'application/json'});
});
