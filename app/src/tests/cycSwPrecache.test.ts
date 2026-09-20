import {describe, expect, test, beforeAll} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// The service worker's static-asset precache is ADDITIVE: it may only answer
// same-origin GETs for the app shell (index.html) and hashed assets/ files from
// cache. Every other request -- API routes, sealed push, websocket upgrades,
// uploads, transfers, anything cross-origin -- must fall straight through to the
// network with no respondWith(), exactly as before. This exercises the fetch
// handler directly (the offline e2e rig is written against "no SW asset cache",
// so the offline-boot guarantee is proven here instead).

const ORIGIN = 'http://localhost';

type Handlers = Record<string, ((ev: unknown) => void)[]>;

type SwGlobals = {
  cycRouteRequest: (req: unknown) => 'network' | 'shell' | 'asset';
  cycServeShell: (req: unknown) => Promise<unknown>;
  cycServeAsset: (req: unknown) => Promise<unknown>;
  cycPrecacheInstall: () => Promise<void>;
};

const pathOf = (x: unknown): string => {
  const s = typeof x === 'string' ? x : (x as {url: string}).url;
  return s.startsWith('http') ? new URL(s).pathname : s;
};

// A tiny in-memory CacheStorage: name -> (pathname -> response marker).
type FakeCache = {
  match(k: unknown): Promise<unknown>;
  put(k: unknown, v: unknown): void;
  addAll(reqs: unknown[]): Promise<void>;
};
function makeCaches() {
  const store = new Map<string, Map<string, unknown>>();
  const openCache = (name: string): FakeCache => {
    const c = store.get(name) ?? new Map<string, unknown>();
    store.set(name, c);
    return {
      match: async (k: unknown) => c.get(pathOf(k)),
      put: (k: unknown, v: unknown) => c.set(pathOf(k), v),
      addAll: async (reqs: unknown[]) => {
        for (const r of reqs)
          c.set(pathOf(r), await (globalThis.fetch as (x: unknown) => Promise<unknown>)(r));
      }
    };
  };
  return {
    store,
    keys: async () => [...store.keys()],
    open: async (name: string) => openCache(name),
    delete: async (name: string) => store.delete(name),
    match: async (k: unknown) => {
      for (const c of store.values()) {
        const hit = c.get(pathOf(k));
        if (hit) return hit;
      }
      return undefined;
    }
  };
}

let sw: SwGlobals;
let handlers: Handlers;
let fetched: string[];
let caches: ReturnType<typeof makeCaches>;

beforeAll(() => {
  const code = readFileSync(resolve(process.cwd(), 'public/cyc-sw.js'), 'utf8');
  handlers = {};
  fetched = [];
  caches = makeCaches();
  const fakeSelf: Record<string, unknown> = {
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      (handlers[type] ||= []).push(fn);
    },
    navigator: {userAgent: 'vitest'},
    location: {origin: ORIGIN},
    caches,
    fetch: async (req: unknown) => {
      fetched.push(pathOf(req));
      return {network: true, from: pathOf(req)};
    },
    registration: {
      showNotification: () => {},
      getNotifications: async (): Promise<unknown[]> => []
    },
    clients: {claim: async () => {}, matchAll: async (): Promise<unknown[]> => []},
    skipWaiting: () => {}
  };
  // globalThis.caches / fetch for the helpers that call them bare.
  (globalThis as unknown as {caches: unknown}).caches = caches;
  (globalThis as unknown as {fetch: unknown}).fetch = fakeSelf.fetch;

  new Function('self', code)(fakeSelf);
  sw = fakeSelf as unknown as SwGlobals;
});

const req = (url: string, o: {method?: string} = {}) => ({
  url: url.startsWith('http') || url.startsWith('ws') ? url : ORIGIN + url,
  method: o.method ?? 'GET'
});

describe('service worker precache routing', () => {
  test('only same-origin GET shell + hashed assets are cacheable; everything else is network', () => {
    // Cacheable:
    expect(sw.cycRouteRequest(req('/'))).toBe('shell');
    expect(sw.cycRouteRequest(req('/index.html'))).toBe('shell');
    expect(sw.cycRouteRequest(req('/?testhooks=1&v=123'))).toBe('shell');
    expect(sw.cycRouteRequest(req('/assets/index-OkBO3Qu1.js'))).toBe('asset');
    expect(sw.cycRouteRequest(req('/assets/fonts/inter-latin.woff2'))).toBe('asset');

    // Straight through to the network (never touched):
    expect(sw.cycRouteRequest(req('/push/key'))).toBe('network'); // API
    expect(sw.cycRouteRequest(req('/push/subscribe', {method: 'POST'}))).toBe('network');
    expect(sw.cycRouteRequest(req('/push/read', {method: 'POST'}))).toBe('network'); // sealed read
    expect(sw.cycRouteRequest(req('/build.txt'))).toBe('network'); // stamp: must hit network
    expect(sw.cycRouteRequest(req('/ws'))).toBe('network'); // websocket path
    expect(sw.cycRouteRequest(req('/upload/abc', {method: 'PUT'}))).toBe('network'); // upload
    expect(sw.cycRouteRequest(req('/transfer/xyz', {method: 'POST'}))).toBe('network'); // transfer
    expect(sw.cycRouteRequest(req('/cyc-precache.json'))).toBe('network');
    expect(sw.cycRouteRequest(req('/plugins/git-page.html'))).toBe('network'); // plugin nav
    expect(sw.cycRouteRequest(req('/index.html', {method: 'POST'}))).toBe('network'); // non-GET
    expect(sw.cycRouteRequest(req('https://cross.example.com/assets/x.js'))).toBe('network');
    expect(sw.cycRouteRequest({url: 'not a url', method: 'GET'})).toBe('network');
    expect(sw.cycRouteRequest(null)).toBe('network');
  });
});

describe('service worker fetch handler', () => {
  const fireFetch = async (request: unknown): Promise<{responded: boolean; value: unknown}> => {
    let responded = false;
    let value: unknown = undefined;
    const event = {
      request,
      respondWith: (p: unknown) => {
        responded = true;
        value = p;
      }
    };
    handlers.fetch.forEach((h) => h(event));
    if (responded) value = await value;
    return {responded, value};
  };

  test('API / sealed / upload / cross-origin requests are not intercepted', async () => {
    for (const r of [
      req('/push/key'),
      req('/push/read', {method: 'POST'}),
      req('/upload/abc', {method: 'PUT'}),
      req('/build.txt'),
      req('/ws'),
      req('https://cross.example.com/assets/x.js')
    ]) {
      const {responded} = await fireFetch(r);
      expect(responded, `${(r as {url: string}).url} was intercepted`).toBe(false);
    }
  });

  test('a hashed asset is served from cache, not the network', async () => {
    const cache = await caches.open('cyc-precache-1788378296');
    (cache as unknown as {put: (k: string, v: unknown) => void}).put('/assets/index-OkBO3Qu1.js', {
      cached: 'chunk'
    });
    fetched.length = 0;
    const {responded, value} = await fireFetch(req('/assets/index-OkBO3Qu1.js'));
    expect(responded).toBe(true);
    expect(value).toEqual({cached: 'chunk'});
    expect(fetched, 'the cached asset still hit the network').toEqual([]);
  });

  test('an asset absent from cache falls back to the network', async () => {
    fetched.length = 0;
    const {responded, value} = await fireFetch(req('/assets/never-built-Zzzz.js'));
    expect(responded).toBe(true);
    expect((value as {from: string}).from).toBe('/assets/never-built-Zzzz.js');
    expect(fetched).toEqual(['/assets/never-built-Zzzz.js']);
  });

  test('a navigation is served the cached shell from the current build cache', async () => {
    // Two build caches present: the current (highest stamp) shell must win.
    const older = await caches.open('cyc-precache-1700000000');
    (older as unknown as {put: (k: string, v: unknown) => void}).put('/index.html', {
      shell: 'old'
    });
    const current = await caches.open('cyc-precache-1788378296');
    (current as unknown as {put: (k: string, v: unknown) => void}).put('/index.html', {
      shell: 'current'
    });
    fetched.length = 0;
    const {responded, value} = await fireFetch(req('/?testhooks=1'));
    expect(responded).toBe(true);
    expect(value).toEqual({shell: 'current'});
    expect(fetched).toEqual([]);
  });
});

// The cold-boot guarantee end to end at the handler level: install reads the
// manifest, precaches the shell + every hashed chunk, and a later navigation is
// then served that shell from cache with no network -- exactly what the browser
// does on an offline reload (proven in the rig by e2e/offline/offline-boot.spec).
describe('service worker install precaches the whole build', () => {
  test('install stores every manifest asset, and a cold shell fetch is served from it', async () => {
    // Absolute URLs so `new Request(a)` inside install is valid under node's
    // undici (the browser resolves relative asset paths against the SW scope).
    const manifest = {
      version: '1788400000',
      assets: [
        `${ORIGIN}/index.html`,
        `${ORIGIN}/assets/index-AAAA.js`,
        `${ORIGIN}/assets/vendor-BBBB.js`
      ]
    };
    const realFetch = globalThis.fetch;
    (globalThis as unknown as {fetch: unknown}).fetch = async (input: unknown) => {
      const p = pathOf(input);
      if (p === '/cyc-precache.json') return {ok: true, json: async () => manifest};
      return {precached: p};
    };
    try {
      await sw.cycPrecacheInstall();
    } finally {
      (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
    }

    // Install opened the stamp-named cache and stored every asset (keyed by
    // pathname); assert against that cache directly, since earlier tests seeded
    // their own precache caches into this shared store.
    const installed = caches.store.get('cyc-precache-' + manifest.version);
    expect(installed, 'install did not open the stamp-named cache').toBeTruthy();
    for (const a of manifest.assets) {
      const p = new URL(a).pathname;
      expect(installed!.get(p), `${a} was not precached`).toEqual({precached: p});
    }

    // A cold navigation now resolves the shell from the freshly installed cache
    // (its stamp is the highest present), with nothing hitting the network.
    fetched.length = 0;
    const shell = await sw.cycServeShell(req('/?testmode=1'));
    expect(shell).toEqual({precached: '/index.html'});
    expect(fetched).toEqual([]);
  });
});

// The update path the single-reload flow (src/staleReload.ts) depends on:
// install must call skipWaiting (no waiting worker, ever, even when the
// precache itself fails: the push worker must still take over), and activate
// must claim clients and drop old build caches while KEEPING the current and
// the immediately previous bucket, so a page caught mid-swap still resolves
// its lazy chunks from the prior build.
describe('service worker update handlers', () => {
  const fire = async (type: string, event: Record<string, unknown>) => {
    const waited: unknown[] = [];
    event.waitUntil = (p: unknown) => waited.push(p);
    handlers[type].forEach((h) => h(event));
    for (const p of waited) await p;
  };
  const swSelf = () => sw as unknown as Record<string, unknown>;

  test('install calls skipWaiting even when the precache install fails', async () => {
    let skips = 0;
    swSelf().skipWaiting = () => {
      skips += 1;
    };
    const realFetch = globalThis.fetch;
    (globalThis as unknown as {fetch: unknown}).fetch = async () => {
      throw new Error('offline');
    };
    try {
      await fire('install', {});
    } finally {
      (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
    }
    expect(skips, 'install did not call skipWaiting').toBe(1);
  });

  test('activate claims clients and keeps exactly the current + previous precache buckets', async () => {
    // Seed extra generations beyond whatever earlier tests left in the store.
    await caches.open('cyc-precache-1600000000');
    await caches.open('cyc-precache-1650000000');
    await caches.open('cyc-audio-not-a-precache'); // must survive cleanup

    const before = (await caches.keys()).filter((n) => n.startsWith('cyc-precache-')).sort();
    expect(before.length, 'need 3+ buckets to prove the cleanup').toBeGreaterThanOrEqual(3);
    const expectKept = before.slice(-2);

    let claims = 0;
    (swSelf().clients as Record<string, unknown>).claim = async () => {
      claims += 1;
    };
    await fire('activate', {});

    const after = (await caches.keys()).filter((n) => n.startsWith('cyc-precache-')).sort();
    expect(after, 'cleanup must keep current + immediately previous only').toEqual(expectKept);
    expect(await caches.keys()).toContain('cyc-audio-not-a-precache');
    expect(claims, 'activate did not claim clients').toBe(1);
  });
});
