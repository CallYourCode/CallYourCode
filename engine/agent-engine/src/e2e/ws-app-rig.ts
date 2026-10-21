/* Scratch production app-server + real engine, controlled by the browser gate.
 * No transport replacement. Fake herdr and voice are the external service seams. */
import {mkdtemp, mkdir, rm, chmod, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {startEngine, freePort} from './harness';
import {loadOrCreateE2E, newestGen, saveE2E} from '../security/sec';
import {b64urlencode, b64encode} from '../../../shared/e2e';
import {TestClient} from './testclient';
import {until} from '../test-utils/wait';
const dir = await mkdtemp(join(tmpdir(), 'cyc-ws-app-'));
await mkdir(join(dir, 'home'));
const appPort = await freePort();
const origin = `http://localhost:${appPort}`;
const root = resolve(import.meta.dir, '../../../..');
let app: {kill(): void; exited: Promise<number>; readonly exitCode: number | null};
const bootApp = async () => {
  app = Bun.spawn(['bun', 'run', join(root, 'server/src/bootstrap/server.ts')], {
    env: {...process.env, HOME: join(dir, 'home'), APP_PORT: String(appPort), APP_HOST: '127.0.0.1',
      CYC_DATA_DIR: dir, CYC_LOG_DIR: join(dir, 'logs'), DIST_DIR: join(root, 'app/dist'),
      PUSH_FILE: join(dir, 'push.json'), SETTINGS_FILE: join(dir, 'settings.json'),
      ENGINE_TOKENS_FILE: join(dir, 'tokens.json'), ENGINE_LEASES_FILE: join(dir, 'leases.json'),
      REPORTS_DIR: join(dir, 'reports'), VOICE_ENGINES: 'http://127.0.0.1:1|http://127.0.0.1:1|none',
      CLERK_SECRET_KEY: 'sk_test_unused', APP_SERVER_URL: origin},
    stdout: 'ignore', stderr: 'inherit',
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(origin + '/health').then((r) => r.ok).catch(() => false)) return;
    if (app.exitCode !== null) throw new Error('scratch app-server exited');
    await Bun.sleep(50);
  }
  throw new Error('scratch app-server did not start');
};
await bootApp();
const encoder = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
  'sine=frequency=440:duration=0.5', '-f', 'mp3', 'pipe:1'], {stdout: 'pipe', stderr: 'inherit'});
const mp3 = new Uint8Array(await new Response(encoder.stdout).arrayBuffer());
if (await encoder.exited !== 0) throw new Error('scratch MP3 generation failed');
const voice = Bun.serve({port: 0, hostname: '127.0.0.1',
  async fetch(req, srv) {
    if (new URL(req.url).pathname === '/tts') {
      await Bun.sleep(250);
      return new Response(mp3, {headers: {'content-type': 'audio/mpeg'}});
    }
    if (new URL(req.url).pathname === '/stt-stream') return srv.upgrade(req) ? undefined : new Response('upgrade', {status: 426});
    if (new URL(req.url).pathname === '/stt') return Response.json({text: 'scratch final transcript'});
    return Response.json({ok: true, healthy: true});
  },
  websocket: {
    open() {sttOpened++;},
    close() {sttClosed++;},
    message(ws, raw) {
      if (typeof raw !== 'string') { ws.send(JSON.stringify({t: 'partial', text: 'scratch live partial', committed: 7})); return; }
      const m = JSON.parse(raw);
      if (m.t === 'stop') ws.send(JSON.stringify({t: 'final', text: 'scratch final transcript', corrections: [], dropped: []}));
    },
  },
});
// External terminal seam only. Never invoke the installed herdr binary.
const bin = join(dir, 'bin');
await mkdir(bin);
await Bun.write(join(bin, 'herdr'), `#!/usr/bin/env bun
if (process.argv[2] !== 'terminal') { console.log('{}'); process.exit(0); }
console.log(JSON.stringify({type: 'terminal.frame', full: true, seq: 1, width: 80, height: 24, bytes: 'scratch terminal'}));
let stopped = false;
const stop = () => { if (!stopped) { stopped = true; process.exit(0); } };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
for await (const chunk of Bun.stdin.stream()) { /* hold the attach until release or engine death */ }
stop();
`);
await chmod(join(bin, 'herdr'), 0o700);
let sttOpened = 0;
let sttClosed = 0;
const engine = await startEngine({env: {APP_SERVER_URL: origin, VOICE_URL: `http://127.0.0.1:${voice.port}`, PATH: bin + ':' + process.env.PATH},
  seed: async (engineDir) => { await Bun.write(join(engineDir, 'services.json'), JSON.stringify([
    {key: 'voice-engine', name: 'scratch voice', port: voice.port, ceilingMb: 6000, unit: 'voice', revive: {how: 'watch'}},
  ])); },
});
let session = await engine.session();
const keys = await loadOrCreateE2E(join(engine.dir, 'data/keys.json'));
let held: TestClient | null = null;
let heldCloseEvents = 0;
let heldClientId = '';
let terminalPid = 0;
const resources = async () => ({
  sttOpened, sttClosed, heldCloseEvents,
  spools: await readdir(join(engine.dir, 'data/tmp/tunnel')).catch(() => [] as string[]),
  terminalPid,
  terminalAlive: terminalPid > 0 && (() => {try {process.kill(terminalPid, 0); return true;} catch {return false;}})(),
  terminalReleases: engine.lines.filter((l) => l.includes('[terminal] - ') && l.includes(`pid=${terminalPid}`)).length,
  clientCloses: engine.lines.filter((l) => l.includes('engine client.close ') && l.includes(`client=${heldClientId} `)).length,
});
let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  held?.close();
  session.close();
  await engine.stop();
  app.kill(); await app.exited;
  voice.stop(true); control.stop(true);
  await rm(dir, {recursive: true, force: true});
};
const control = Bun.serve({port: 0, hostname: '127.0.0.1', async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/devices') {
    const state = await loadOrCreateE2E(join(engine.dir, 'data/keys.json'));
    return Response.json({devices: state.devices.map((d) => ({fp: d.fp, revoked: d.revokedAt !== null}))});
  }
  if (path === '/resources') return Response.json(await resources());
  if (path === '/hold-resources') {
    held?.close();
    heldCloseEvents = 0;
    held = new TestClient(engine.url);
    const frames: Record<string, any>[] = [];
    held.onopen = () => held!.send(JSON.stringify({t: 'hello'}));
    held.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
    held.onclose = () => {heldCloseEvents++;};
    await until(() => frames.some((f) => f.t === 'sessions'), {timeoutMs: 15_000, what: 'resource client sealed'});
    heldClientId = engine.lines.filter((l) => l.includes('engine client.open ')).at(-1)!.match(/client=(c\d+)/)![1];
    const row = frames.find((f) => f.t === 'sessions')!.list[0];
    for (const frame of [
      {t: 'term-open', id: row.id, cols: 80, rows: 24},
      {t: 'stt-open', id: 'restart-stt', rate: 16000, format: 'f32'},
      {t: 'stt-b', id: 'restart-stt', b: b64encode(new Uint8Array(16000))},
      {t: 'req', id: 'restart-upload', m: 'POST', p: '/upload', b: b64encode(new Uint8Array(65536)), more: true},
    ]) held.send(JSON.stringify(frame));
    await until(async () => frames.some((f) => f.t === 'term-frame') && sttOpened > sttClosed &&
      (await resources()).spools.length === 1, {timeoutMs: 10_000, what: 'terminal, STT and spool all active'});
    terminalPid = Number(engine.lines.filter((l) => l.includes('[terminal] + ')).at(-1)!.match(/pid=(\d+)/)![1]);
    return Response.json(await resources());
  }
  if (path === '/info') return Response.json({origin, engineUrl: engine.url, engineId: keys.engineId,
    key: b64urlencode(newestGen(keys).keyBytes), submitted: engine.submitted(), lines: engine.lines.slice(-100),
    appLog: (await Bun.file(join(dir, "logs/app.log")).text().catch(() => "")).split("\n").slice(-100)});
  if (path === '/reply') {
    const body = await req.json() as {text: string; speak?: boolean};
    session.send(JSON.stringify({t: body.speak ? 'speak' : 'chat', text: body.text, msgId: crypto.randomUUID()}));
  } else if (path === '/revoke-device') {
    const state = await loadOrCreateE2E(join(engine.dir, 'data/keys.json'));
    for (const d of state.devices) d.revokedAt = Date.now();
    await saveE2E(state);
    await engine.reboot(); session = await engine.session();
  } else if (path === '/restart-engine') {
    await engine.reboot(); session = await engine.session();
  } else if (path === '/restart-app') {
    app.kill(); await app.exited; await bootApp();
  } else if (path === '/stop') { setTimeout(() => { void stop().then(() => process.exit(0)); }, 10); }
  return Response.json({ok: true});
}});
console.log('WS_RIG ' + JSON.stringify({control: `http://127.0.0.1:${control.port}`}));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void stop().then(() => process.exit(0)); });
