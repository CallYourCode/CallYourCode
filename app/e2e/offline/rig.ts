import {expect, test, type Page} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {copyFileSync, mkdirSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {b64encode} from '../../src/engine/e2e';
import {registeredEngine, type RegisteredEngine} from './engine';

async function waitRegistered(port: number): Promise<RegisteredEngine> {
  for (let i = 0; i < 100; i++) {
    const e = registeredEngine(port);
    if (e) return e;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`bootEngines: no startEngine registered on port ${port}`);
}

export const PAGE =
  process.env.CYC_PAGE?.replace(/\/$/, '') ||
  `http://127.0.0.1:${process.env.CYC_OFFLINE_PORT || 8295}`;

const DEAD_ENGINE = 'ws://127.0.0.1:59997/ws';

const ISO_ENGINE = {url: DEAD_ENGINE, engineId: 'iso-dead', host: 'nowhere', user: 'iso'};
const ISO_UH = `${ISO_ENGINE.user}@${ISO_ENGINE.host}`;
const ISO_KEY_B64 = b64encode(
  crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>
);

export const FIXTURE_NAMES = ['Relay Server', 'Metrics Dashboard', 'Recipe Scraper'];

// Evidence screenshots: the tracked PNGs under e2e/screenshots/ that a spec
// records to show a state it proved (progress on a bubble, the offline banner,
// a marked row). They are records for a human, not compared baselines: the
// auto avatar tint and glyph, the spinner phase and a mid-flight progress bar
// all vary from run to run on identical code, so a pixel compare would flake.
//
// A normal run therefore never writes into the tree. The shot goes to the
// test's own output dir and is attached to the report. The tracked copy is
// refreshed only under `--update-snapshots` (the same flag that re-records the
// toHaveScreenshot baselines), so a green run leaves `git status` clean and a
// changed evidence PNG is always a deliberate act. Narrow the run to the spec
// whose evidence you mean to refresh: `npx playwright test <spec> -u`.
export const SCREENSHOTS_DIR = resolve(__dirname, '..', 'screenshots');

function refreshingEvidence(): boolean {
  const mode = test.info().config.updateSnapshots;
  return mode === 'all' || mode === 'changed';
}

/** `dir` is the subfolder under e2e/screenshots ('' for the folder itself). */
export async function evidenceShot(page: Page, dir: string, name: string): Promise<void> {
  const info = test.info();
  const file = name.endsWith('.png') ? name : `${name}.png`;
  const rel = [dir, file].filter(Boolean).join('/');
  const out = info.outputPath('evidence', rel);
  mkdirSync(dirname(out), {recursive: true});
  await page.screenshot({path: out, fullPage: false});
  await info.attach(`evidence ${rel}`, {path: out, contentType: 'image/png'});
  if (refreshingEvidence()) {
    const tracked = resolve(SCREENSHOTS_DIR, rel);
    mkdirSync(dirname(tracked), {recursive: true});
    copyFileSync(out, tracked);
  }
}

const LOOP_INIT = (o: {logSends: boolean}) => {
  const LIVE = /:(10101|10102)\b/;
  const Real = window.WebSocket;
  const pending: any[] = [];
  const dcByWs = new WeakMap<any, any>();

  type PipeSent = {kind: 'plain' | 'sealed' | 'ctrl' | 'bad'; t?: string};
  const sent: PipeSent[] = [];
  if (o.logSends) (window as any).__cycPipeSent = sent;

  const dec = new TextDecoder();
  let parts: Uint8Array[] = [];
  let size = 0;
  function noteSend(bytes: Uint8Array) {
    if (!o.logSends) return;
    const type = bytes[0];
    if (type === 0x00 || type === 0x01) {
      const payload = bytes.subarray(1);
      parts.push(payload);
      size += payload.length;
      if (type === 0x00) return;
      const whole = new Uint8Array(size);
      let off = 0;
      for (const p of parts) {
        whole.set(p, off);
        off += p.length;
      }
      parts = [];
      size = 0;
      const s = dec.decode(whole);
      let f: any;
      try {
        f = JSON.parse(s);
      } catch {
        sent.push({kind: 'bad'});
        return;
      }
      if (f?.t === 'x') sent.push({kind: 'sealed'});
      else sent.push({kind: 'plain', t: typeof f?.t === 'string' ? f.t : undefined});
      return;
    }
    sent.push({kind: 'ctrl', t: String(type)});
  }

  // The app dials the engine over WebRTC and reaches it only through a relay it
  // signals at <origin>/device?engine=<id>. Offline there is no relay and no real
  // WebRTC: this shim answers the relay+offer handshake locally and backs the
  // faked DataChannel with a plain socket straight to the engine's /ws.
  const engineUrlFor = (engineId: string | null): string | null => {
    if (!engineId) return null;
    try {
      const cfg = JSON.parse(localStorage.getItem('cyc-config') || '{}');
      const list = Array.isArray(cfg.engines) ? cfg.engines : [];
      const e = list.find((x: any) => x && x.engineId === engineId);
      return e && typeof e.url === 'string' ? e.url : null;
    } catch {
      return null;
    }
  };

  // The backing socket closed. Before the channel opened that is a transport
  // that never came up, which real WebRTC reports as ICE `failed` (the dial
  // fails at once instead of sitting out its 10 s timer); after, the channel
  // closes like a lost pipe.
  const onBackingClose = (ws: any) => {
    const d = dcByWs.get(ws);
    if (!d || d.readyState === 'closed') return;
    const pc = d._pc;
    if (d.readyState !== 'open' && pc && pc.iceConnectionState !== 'failed') {
      pc.iceConnectionState = 'failed';
      pc.connectionState = 'failed';
      pc.oniceconnectionstatechange?.();
    }
    d.close();
  };

  const wireEngineWs = (ws: any) => {
    ws.binaryType = 'arraybuffer';
    pending.push(ws);
    ws.addEventListener('close', () => onBackingClose(ws));
    ws.addEventListener('message', (ev: any) => {
      if (typeof ev.data !== 'string') dcByWs.get(ws)?.onmessage?.({data: ev.data});
    });
  };

  // One engine socket per dial: `__cycDials` is the dial count a spec reads
  // (the loopback shim answers the rtc-offer locally, so the rig's `offers`
  // never moves here).
  (window as any).__cycDials = 0;
  const makeLoopSignal = (engineId: string | null): any => {
    const eu = engineUrlFor(engineId);
    if (eu) {
      (window as any).__cycDials++;
      wireEngineWs(new Real(eu));
    }
    const listeners: Record<string, ((ev: any) => void)[]> = {open: [], message: [], close: []};
    let onmessage: ((ev: any) => void) | null = null;
    let onclose: ((ev: any) => void) | null = null;
    let closed = false;
    const deliver = (frame: unknown) => {
      if (closed) return;
      const ev = {data: JSON.stringify(frame)};
      onmessage?.(ev);
      for (const cb of listeners.message.slice()) cb(ev);
    };
    const sig: any = {
      binaryType: '',
      readyState: 1,
      get onmessage() {
        return onmessage;
      },
      set onmessage(fn) {
        onmessage = fn;
      },
      get onclose() {
        return onclose;
      },
      set onclose(fn) {
        onclose = fn;
      },
      addEventListener(t: string, cb: (ev: any) => void) {
        (listeners[t] ||= []).push(cb);
      },
      removeEventListener(t: string, cb: (ev: any) => void) {
        const a = listeners[t];
        if (a) {
          const i = a.indexOf(cb);
          if (i >= 0) a.splice(i, 1);
        }
      },
      send(s: string) {
        let f: any;
        try {
          f = JSON.parse(s);
        } catch {
          return;
        }
        if (f?.t === 'r-auth') deliver({t: 'r-ok'});
        else if (f?.t === 'rtc-offer') deliver({t: 'rtc-answer', id: f.id, sdp: 'loopback-answer'});
      },
      close() {
        if (closed) return;
        closed = true;
        sig.readyState = 3;
        onclose?.({code: 1000});
        for (const cb of listeners.close.slice()) cb({code: 1000});
      }
    };
    setTimeout(() => {
      for (const cb of listeners.open.slice()) cb({});
      deliver({t: 'r-challenge', nonce: 'loop'});
    }, 0);
    return sig;
  };

  const Guarded = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const s = String(url);
    if (LIVE.test(s)) {
      throw new Error(`ISOLATION: refused a socket to the live stack: ${url}`);
    }
    if (/\/device\b/.test(s)) {
      let engineId: string | null = null;
      try {
        engineId = new URL(s).searchParams.get('engine');
      } catch {
        engineId = null;
      }
      return makeLoopSignal(engineId);
    }
    const ws = new Real(url, protocols);
    ws.binaryType = 'arraybuffer';
    if (s.includes('/ws')) pending.push(ws);
    ws.addEventListener('close', () => onBackingClose(ws));
    let userOnMsg: ((ev: any) => void) | null = null;
    Object.defineProperty(ws, 'onmessage', {
      configurable: true,
      enumerable: true,
      get: () => userOnMsg,
      set: (fn) => {
        userOnMsg = fn;
        ws.addEventListener('message', (ev: any) => {
          if (typeof ev.data === 'string') fn?.call(ws, ev);
          else dcByWs.get(ws)?.onmessage?.({data: ev.data});
        });
      }
    });
    return ws;
  } as unknown as typeof WebSocket;
  Guarded.prototype = Real.prototype;
  Object.assign(Guarded, Real);
  window.WebSocket = Guarded;

  (window as any).RTCPeerConnection = function (this: any) {
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.onicecandidate = null;
    this.oniceconnectionstatechange = null;
    this._cbs = {};
    this._dc = null;
    this.addEventListener = (t: string, cb: (ev: any) => void) => {
      (this._cbs[t] ||= []).push(cb);
    };
    this.createDataChannel = () => {
      const bound = pending.shift();
      const d: any = {
        readyState: 'connecting',
        binaryType: '',
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        onopen: null,
        onmessage: null,
        onclose: null,
        _ws: bound,
        _pc: this,
        _cbs: {},
        addEventListener(t: string, cb: (ev: any) => void) {
          (d._cbs[t] ||= []).push(cb);
        },
        send(bytes: Uint8Array) {
          const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
          noteSend(u);
          if (d._ws && d._ws.readyState === 1) d._ws.send(bytes);
        },
        close() {
          d.readyState = 'closed';
          d.onclose?.();
          try {
            d._ws?.close();
          } catch {
            /* the backing socket may already be gone */
          }
        }
      };
      if (bound) dcByWs.set(bound, d);
      this._dc = d;
      return d;
    };
    this.createOffer = () => Promise.resolve({type: 'offer', sdp: 'loopback-offer'});
    this.setLocalDescription = (desc: any) => {
      this.localDescription = desc;
      this.connectionState = 'connecting';
      return Promise.resolve();
    };
    this.setRemoteDescription = () => {
      this.connectionState = 'connected';
      this.iceConnectionState = 'connected';
      const d = this._dc;
      const openDc = () => {
        if (!d || d.readyState === 'closed') return;
        d.readyState = 'open';
        d.onopen?.();
      };
      const ws = d?._ws;
      if (!ws || ws.readyState === 1) setTimeout(openDc, 0);
      else if (ws.readyState >= 2) setTimeout(() => onBackingClose(ws), 0);
      else ws.addEventListener('open', () => setTimeout(openDc, 0), {once: true});
      return Promise.resolve();
    };
    this.addIceCandidate = () => Promise.resolve();
    this.close = () => {
      this.connectionState = 'closed';
      this.iceConnectionState = 'closed';
      this._dc?.close?.();
    };
  };

  const realFetch = window.fetch;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (LIVE.test(String(url))) {
      throw new Error(`ISOLATION: refused a fetch to the live stack: ${url}`);
    }

    return realFetch(input, init);
  };

  (navigator.mediaDevices as unknown as {getUserMedia: () => Promise<MediaStream>}).getUserMedia =
    async () => {
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      const dst = ac.createMediaStreamDestination();
      osc.connect(dst);
      osc.start();
      return dst.stream;
    };
};

export type Isolation = {
  logSends?: boolean;
};

export async function installIsolation(page: Page, o: Isolation = {}): Promise<void> {
  await page.addInitScript(LOOP_INIT, {logSends: !!o.logSends});
}

const SEED_KEYS = async (keys: {userHost: string; keyB64: string}[]) => {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const b64decode = (s: string) => {
    const str = s.replace(/=+$/, '');
    const out = new Uint8Array(Math.floor((str.length * 6) / 8));
    let bits = 0,
      val = 0,
      o = 0;
    for (let i = 0; i < str.length; i++) {
      const idx = B64.indexOf(str[i]);
      if (idx < 0) continue;
      val = (val << 6) | idx;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = (val >> bits) & 0xff;
      }
    }
    return out.subarray(0, o);
  };
  const b64urlencode = (bytes: Uint8Array) => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i];
      const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += B64[a >> 2];
      out += B64[((a & 3) << 4) | (b >> 4)];
      out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
      out += i + 2 < bytes.length ? B64[c & 63] : '=';
    }
    return out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  for (const k of keys) {
    const bytes = b64decode(k.keyB64);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
    const kid = b64urlencode(digest.subarray(0, 8));
    const key = await crypto.subtle.importKey('raw', bytes as BufferSource, 'HKDF', false, [
      'deriveBits',
      'deriveKey'
    ]);
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('cyc-keys', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('keys'))
          db.createObjectStore('keys', {keyPath: 'userHost'});
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('keys', 'readwrite');
        const store = tx.objectStore('keys');
        const get = store.get(k.userHost);
        get.onsuccess = () => {
          const prev = get.result;
          if (prev && prev.key) return;
          store.put({
            userHost: k.userHost,
            gen: 1,
            kid,
            key,
            label: k.userHost,
            e2e: true,
            ...(prev?.fp ? {fp: prev.fp, spki: prev.spki} : {})
          });
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }
};

export async function seedKeys(
  page: Page,
  keys: {userHost: string; keyB64: string}[],
  origin = PAGE
): Promise<void> {
  const here = page.url();
  if (!here || here === 'about:blank' || !here.startsWith(origin)) {
    await page.goto(`${origin}/`, {waitUntil: 'domcontentloaded'});
  }
  await page.evaluate(SEED_KEYS, keys);
}

export type PinnedBoot = {
  size?: {width: number; height: number};

  extra?: string;

  hash?: string;

  skipKey?: boolean;

  wait?: 'rows' | 'none';

  voice?: string | null;
  voiceLabel?: string;

  voiceBases?: string[];

  logSends?: boolean;
};

export async function bootEngines(page: Page, ports: number[], o: PinnedBoot = {}): Promise<void> {
  if (o.size) await page.setViewportSize(o.size);
  await installIsolation(page, {logSends: !!o.logSends});
  const engines = [];
  for (const port of ports) {
    const e = await waitRegistered(port);
    engines.push({port, ...e});
  }
  await page.addInitScript(
    (cfg) => {
      localStorage.setItem('cyc-config', JSON.stringify(cfg));
    },
    {
      engines: engines.map((e, i) => ({
        url: `ws://127.0.0.1:${e.port}/ws`,
        engineId: `e${i + 1}`,
        host: e.host,
        user: e.user
      })),
      voice: o.voice ?? null,
      ...(o.voiceLabel ? {voiceLabel: o.voiceLabel} : {}),
      ...(o.voiceBases ? {voiceBases: o.voiceBases} : {})
    } as unknown as {engines: unknown[]; voice: string | null}
  );
  if (!o.skipKey) {
    await page.addInitScript(
      SEED_KEYS,
      engines.map((e) => ({userHost: e.userHost, keyB64: e.contentKeyB64}))
    );
  }
  await page.goto(`${PAGE}/?testhooks=1${o.extra ?? ''}&v=${Date.now()}${o.hash ?? ''}`);
  if (o.wait !== 'none') await waitForSessionRows(page);
}

// Wait for the chat list to hydrate, but do not sit on the full timeout once the
// engine has settled offline: a contract that can never land should surface as
// the header status word "offline", fast.
async function waitForSessionRows(page: Page, timeout = 20_000): Promise<void> {
  const graceMs = 6_000;
  const start = Date.now();
  let sawOffline = false;
  for (;;) {
    const st = await page.evaluate(() => ({
      rows: document.querySelectorAll('.cyc-session-entry').length,
      status: document.querySelector('.cyc-sync-status')?.textContent ?? ''
    }));
    if (st.rows > 0) return;
    if (st.status === 'offline') sawOffline = true;
    const waited = Date.now() - start;
    if (sawOffline && waited > graceMs) {
      throw new Error(
        `boot: no chat rows after ${(waited / 1000).toFixed(1)}s and the engine has ` +
          `settled offline (status: ${JSON.stringify(st.status)}). The loopback pipe ` +
          'never carried the contract, so this is not waited out to the full ' +
          `${(timeout / 1000).toFixed(0)}s.`
      );
    }
    if (waited > timeout) {
      throw new Error(
        `boot: chat rows never rendered within ${timeout}ms ` +
          `(status: ${JSON.stringify(st.status)}).`
      );
    }
    await page.waitForTimeout(200);
  }
}

export async function bootPinned(page: Page, port: number, o: PinnedBoot = {}): Promise<void> {
  await bootEngines(page, [port], o);
}

export async function expectOwnRows(page: Page, ...names: string[]): Promise<void> {
  const rows = await page.$$eval('.cyc-session-entry', (els) =>
    els.map((e) => e.textContent ?? '')
  );
  expect(rows.length, 'the chat list never loaded').toBeGreaterThan(0);
  for (const row of rows) {
    expect(
      names.some((n) => row.includes(n)),
      'ISOLATION: a chat row is not one this spec invented ' +
        `(${names.join(', ')}): ${JSON.stringify(row)}`
    ).toBe(true);
  }
}

export async function expectOwnChat(page: Page, ...names: string[]): Promise<string> {
  const title = await page.$eval(
    '.cyc-mast-info .cyc-who, .cyc-mast-person .cyc-who',
    (e) => e.textContent ?? ''
  );
  expect(
    names.some((n) => title.includes(n)),
    'ISOLATION: the open chat is not one this spec invented ' +
      `(${names.join(', ')}): ${JSON.stringify(title)}`
  ).toBe(true);
  return title;
}

export const ENGINE_ROOT = (() => {
  if (process.env.CYC_ENGINE_ROOT) return process.env.CYC_ENGINE_ROOT;
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: __dirname,
      encoding: 'utf8'
    }).trim();
    return resolve(dirname(resolve(__dirname, common)), '..', 'callyourcode');
  } catch {
    return resolve(__dirname, '..', '..', '..', 'callyourcode');
  }
})();

export const AUDIO_DIR = resolve(ENGINE_ROOT, '.run', 'audio');

export function realCaptures(n = 1, o: {longest?: boolean} = {}): {name: string; bytes: Buffer}[] {
  let names: string[];
  try {
    names = readdirSync(AUDIO_DIR).filter((x) => x.endsWith('.webm'));
  } catch (e) {
    throw new Error(
      `THIS SPEC NEEDS REAL RECORDINGS AND FOUND NO ${AUDIO_DIR}.\n` +
        'It refuses to generate audio: the thing under test is a webm a real ' +
        'MediaRecorder produced, and a synthesised tone would be a test of a ' +
        `Blob.\n  export CYC_ENGINE_ROOT=/path/to/callyourcode   (${e})`
    );
  }
  const sized = names
    .map((name) => ({name, size: statSync(resolve(AUDIO_DIR, name)).size}))
    .filter((f) => f.size > 4_000 && f.size < 400_000)
    .sort((a, b) => (o.longest ? b.size - a.size : a.size - b.size))
    .slice(0, n);
  expect(
    sized.length,
    `fewer than ${n} captures in ${AUDIO_DIR} are between 4KB and 400KB, so ` +
      'there is nothing to drive this with'
  ).toBeGreaterThanOrEqual(n);
  return sized.map((f) => ({name: f.name, bytes: readFileSync(resolve(AUDIO_DIR, f.name))}));
}

export function haveCaptures(min = 1): boolean {
  try {
    const n = readdirSync(AUDIO_DIR)
      .filter((x) => x.endsWith('.webm'))
      .map((name) => statSync(resolve(AUDIO_DIR, name)).size)
      .filter((s) => s > 4_000 && s < 400_000).length;
    return n >= min;
  } catch {
    return false;
  }
}

export function haveMp3(min = 1): boolean {
  try {
    const n = readdirSync(AUDIO_DIR)
      .filter((x) => x.endsWith('.mp3'))
      .map((name) => statSync(resolve(AUDIO_DIR, name)).size)
      .filter((s) => s > 8_000 && s < 30_000).length;
    return n >= min;
  } catch {
    return false;
  }
}

async function waitForFixtures(page: Page) {
  await page
    .waitForFunction(
      (names: string[]) => {
        const rows = Array.from(document.querySelectorAll('.cyc-session-entry'));
        return (
          rows.length > 0 && rows.every((r) => names.some((n) => (r.textContent ?? '').includes(n)))
        );
      },
      FIXTURE_NAMES as unknown as string[],
      {timeout: 20_000}
    )
    .catch(async () => {
      const rows = await page.$$eval('.cyc-session-entry', (els) => els.map((e) => e.textContent));
      throw new Error(
        'the fixture chat list never arrived. On screen: ' +
          JSON.stringify(rows) +
          `\nExpected every row to be one of ${JSON.stringify(FIXTURE_NAMES)} ` +
          '(src/data/sample.ts), which is what the app falls back to about 2.5s ' +
          'after boot once no engine has connected.'
      );
    });
  await page.waitForTimeout(400);
}

export async function bootIsolated(page: Page, w: number, h: number, origin = PAGE, extra = '') {
  await page.setViewportSize({width: w, height: h});
  await installIsolation(page);
  await page.addInitScript(
    (cfg) => {
      localStorage.setItem('cyc-config', JSON.stringify(cfg));
    },
    {engines: [ISO_ENGINE], voice: null} as unknown as {engines: unknown[]; voice: null}
  );
  await page.addInitScript(SEED_KEYS, [{userHost: ISO_UH, keyB64: ISO_KEY_B64}]);
  await page.goto(`${origin}/?testmode=1&testhooks=1${extra}&v=${Date.now()}`);

  await waitForFixtures(page);
}

export async function reloadIsolated(page: Page) {
  await page.reload();
  await waitForFixtures(page);
}

export async function openFixtureChat(page: Page): Promise<string> {
  const rows = await page.$$eval('.cyc-session-entry', (els) =>
    els.map((e) => e.textContent ?? '')
  );
  expect(rows.length, 'the fixture chat list never loaded').toBeGreaterThan(0);
  for (const row of rows) {
    expect(
      FIXTURE_NAMES.some((n) => row.includes(n)),
      `ISOLATION: a chat row is not a committed fixture: ${JSON.stringify(row)}`
    ).toBe(true);
  }
  await page.locator('.cyc-session-entry').first().click();
  await page.waitForTimeout(900);
  const title = await page.$eval(
    '.cyc-mast-info .cyc-who, .cyc-mast-person .cyc-who',
    (e) => e.textContent ?? ''
  );
  expect(
    FIXTURE_NAMES.some((n) => title.includes(n)),
    `ISOLATION: the open chat is not a committed fixture: ${JSON.stringify(title)}`
  ).toBe(true);
  return title;
}
