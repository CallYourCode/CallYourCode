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
      // All-or-nothing, like the real Cache.addAll: one failed fetch stores none.
      addAll: async (reqs: unknown[]) => {
        const got: [string, unknown][] = [];
        for (const r of reqs)
          got.push([pathOf(r), await (globalThis.fetch as (x: unknown) => Promise<unknown>)(r)]);
        for (const [k, v] of got) c.set(k, v);
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

const SW_CODE = readFileSync(resolve(process.cwd(), 'public/cyc-sw.js'), 'utf8');

// Evaluates the worker against a fresh fake `self`, a fresh CacheStorage and a
// recording fetch, installing those as the bare globals the worker's helpers
// call. `code` is the worker source (unbaked, or with a build stamp baked in the
// way scripts/build-cyc.sh does).
function bootWorker(code: string): {
  sw: SwGlobals;
  handlers: Handlers;
  fetched: string[];
  caches: ReturnType<typeof makeCaches>;
} {
  const handlers: Handlers = {};
  const fetched: string[] = [];
  const caches = makeCaches();
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
  return {sw: fakeSelf as unknown as SwGlobals, handlers, fetched, caches};
}

beforeAll(() => {
  ({sw, handlers, fetched, caches} = bootWorker(SW_CODE));
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
    // The boot watchdog is a non-hashed shell file, cached like an asset.
    expect(sw.cycRouteRequest(req('/boot-watchdog.js'))).toBe('asset');

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

  // The black-screen guard. A new build's bucket name appears the instant
  // install calls caches.open, before addAll stores the shell (or if addAll
  // fails). Serving the network's new index.html from that empty newest bucket
  // would point the page at a hashed entry chunk that is not cached either, and
  // with no network it paints nothing. The shell serve must instead fall back to
  // the newest bucket that REALLY holds a shell (every chunk it names is cached,
  // addAll being all-or-nothing), so the page boots, stale but alive.
  test('an empty newest bucket is skipped for the newest bucket that holds the shell', async () => {
    const prev = await caches.open('cyc-precache-1790000000');
    (prev as unknown as {put: (k: string, v: unknown) => void}).put('/index.html', {
      shell: 'prev-full'
    });
    // The brand-new bucket exists (name only), addAll not done: no /index.html.
    await caches.open('cyc-precache-1790000500');
    fetched.length = 0;
    const {responded, value} = await fireFetch(req('/'));
    expect(responded).toBe(true);
    expect(value, 'served a network shell whose chunks are not cached').toEqual({
      shell: 'prev-full'
    });
    expect(fetched, 'the empty newest bucket sent the navigation to the network').toEqual([]);
  });

  test('only when NO bucket holds the shell does the navigation go to the network', async () => {
    // A fresh store with just an empty bucket name present.
    for (const n of await caches.keys()) await caches.delete(n);
    await caches.open('cyc-precache-1790000900'); // name only, no shell
    fetched.length = 0;
    const {responded, value} = await fireFetch(req('/'));
    expect(responded).toBe(true);
    expect((value as {from: string}).from).toBe('/');
    expect(fetched).toEqual(['/']);
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
      return {ok: true, precached: p};
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
      expect(installed!.get(p), `${a} was not precached`).toEqual({ok: true, precached: p});
    }

    // A cold navigation now resolves the shell from the freshly installed cache
    // (its stamp is the highest present), with nothing hitting the network.
    fetched.length = 0;
    const shell = await sw.cycServeShell(req('/?testmode=1'));
    expect(shell).toEqual({ok: true, precached: '/index.html'});
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

// THE STUCK BUILD (iPhone, 2026-10-03). An update worker whose precache failed
// used to install anyway (the failure was swallowed), take control holding
// nothing of its own build, and leave every launch on the previous build's
// bucket; its bytes never changed again, so no update check re-ran the install.
// An update install must now FAIL when it cannot fill its own build's bucket, so
// the active worker stays and the browser retries the install on the next
// update check. Only the very first install (nothing active to keep) may take
// over without a precache.
describe('service worker install fails an update it cannot precache', () => {
  const STAMP = '1791000000';
  const ASSETS = ['/index.html', '/assets/index-AAAA.js'].map((p) => ORIGIN + p);

  const boot = (o: {
    active: boolean;
    manifestVersion?: string;
    failAsset?: string;
    badAsset?: string;
  }) => {
    const w = bootWorker(SW_CODE.replace('__CYC_BUILD__', STAMP));
    const self = w.sw as unknown as Record<string, unknown>;
    (self.registration as Record<string, unknown>).active = o.active ? {state: 'activated'} : null;
    const manifest = {version: o.manifestVersion ?? STAMP, assets: ASSETS};
    (globalThis as unknown as {fetch: unknown}).fetch = async (input: unknown) => {
      const p = pathOf(input);
      if (p === '/cyc-precache.json') return {ok: true, json: async () => manifest};
      if (p === o.failAsset) throw new TypeError('Load failed');
      if (p === o.badAsset) return {ok: false, status: 503};
      return {ok: true, precached: p};
    };
    const install = async () => {
      const waited: Promise<unknown>[] = [];
      w.handlers.install.forEach((h) => h({waitUntil: (p: Promise<unknown>) => waited.push(p)}));
      await Promise.all(waited);
    };
    return {...w, install};
  };

  test('an update whose asset fetch dies rejects its install and leaves no bucket', async () => {
    const w = boot({active: true, failAsset: '/assets/index-AAAA.js'});
    await expect(w.install(), 'a failed update precache was swallowed').rejects.toThrow();
    expect(await w.caches.keys(), 'the failed install left its empty bucket').toEqual([]);
  });

  test('an update whose precache completes installs and fills its own bucket', async () => {
    const w = boot({active: true});
    await w.install();
    expect(await w.caches.keys()).toEqual(['cyc-precache-' + STAMP]);
    expect(await w.sw.cycServeShell(req('/'))).toEqual({ok: true, precached: '/index.html'});
  });

  test('a worker refuses to precache a manifest of another build', async () => {
    const w = boot({active: true, manifestVersion: '1791000999'});
    await expect(w.install()).rejects.toThrow(/not this worker/);
    expect(await w.caches.keys()).toEqual([]);
  });

  test('the first install (nothing active) still takes over when its precache fails', async () => {
    const w = boot({active: false, failAsset: '/assets/index-AAAA.js'});
    await expect(w.install()).resolves.toBeUndefined();
    expect(await w.caches.keys()).toEqual([]);
  });

  test('a 503 on any file fails the install before a bucket is even opened', async () => {
    const w = boot({active: true, badAsset: '/assets/index-AAAA.js'});
    const opened: string[] = [];
    const open = w.caches.open;
    w.caches.open = async (n: string) => {
      opened.push(n);
      return open(n);
    };
    await expect(w.install()).rejects.toThrow(/503/);
    expect(opened, 'a bucket was opened for a build that never arrived').toEqual([]);
    expect(await w.caches.keys()).toEqual([]);
  });

  // WebKit's network process went down when a failed install discarded the
  // worker with its own precache loads still in flight.
  test('the install fails only once every precache fetch has settled', async () => {
    const w = boot({active: true});
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    let slowDone = false;
    (globalThis as unknown as {fetch: unknown}).fetch = async (input: unknown) => {
      const p = pathOf(input);
      if (p === '/cyc-precache.json')
        return {ok: true, json: async () => ({version: STAMP, assets: ASSETS})};
      if (p === '/index.html') return {ok: false, status: 503};
      await slow;
      slowDone = true;
      return {ok: true, precached: p};
    };
    let failedAt = '';
    const done = w.install().catch(() => {
      failedAt = slowDone ? 'after the slow fetch settled' : 'with a fetch still in flight';
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(failedAt, 'the install failed with a fetch still in flight').toBe('');
    release();
    await done;
    expect(failedAt).toBe('after the slow fetch settled');
  });

  test('the shell is stored last: a bucket holding index.html holds every file', async () => {
    const w = boot({active: true});
    const order: string[] = [];
    const open = w.caches.open;
    w.caches.open = async (n: string) => {
      const c = await open(n);
      return {
        ...c,
        put: (k: unknown, v: unknown) => {
          order.push(pathOf((k as {url: string}).url));
          return c.put(k, v);
        }
      };
    };
    await w.install();
    expect(order).toEqual(['/assets/index-AAAA.js', '/index.html']);
  });

  test('a store that fails part way drops the half-filled bucket', async () => {
    const w = boot({active: true});
    const open = w.caches.open;
    w.caches.open = async (n: string) => {
      const c = await open(n);
      let puts = 0;
      return {
        ...c,
        put: (k: unknown, v: unknown) => {
          if (++puts === 2) throw new DOMException('quota', 'QuotaExceededError');
          return c.put(k, v);
        }
      };
    };
    await expect(w.install()).rejects.toThrow(/quota/);
    expect(await w.caches.keys()).toEqual([]);
  });

  test('a failed fill never deletes a bucket that already holds its shell', async () => {
    const w = boot({active: true, failAsset: '/assets/index-AAAA.js'});
    (await w.caches.open('cyc-precache-' + STAMP)).put('/index.html', {shell: 'kept'});
    await expect(w.install()).rejects.toThrow();
    expect(await w.caches.keys()).toEqual(['cyc-precache-' + STAMP]);
  });
});

// THE PARKED WORKER (Chromium, 2026-10-03). Every same-origin request used to
// dispatch a fetch event to the worker, even the ones it sends straight to the
// network; one landing while the old worker is stopped for a new build's
// activation restarted it and parked the new worker in "waiting". The worker
// now declares its routes to the browser (Static Routing API) so only shell and
// asset requests ever wake it, and a waiting worker takes over when asked.
describe('service worker routes and the take-over ask', () => {
  type Rule = {condition: {urlPattern: {pathname: string; search?: string}}; source: string};
  const routes = () => (sw as unknown as {CYC_ROUTES: Rule[]}).CYC_ROUTES;
  // What Chromium does with the declared rules: the first match wins; a request
  // no rule matches gets the default, the fetch event. (Patterns here are a
  // pathname exact or ending '/*', and a search '*x*'.)
  const sourceFor = (path: string, search = '') =>
    routes().find((r) => {
      const {pathname: p, search: q} = r.condition.urlPattern;
      const pathHit = p.endsWith('/*') ? path.startsWith(p.slice(0, -1)) : path === p;
      return pathHit && (!q || search.includes(q.slice(1, -1)));
    })?.source ?? 'fetch-event';

  // A user action that a parked worker held past its bound navigates to
  // '/?cyc-net=1': it must boot from the network, never reaching the stuck old
  // worker (Chromium), and the handler must agree (WebKit).
  test('the escape hatch: /?cyc-net=1 goes to the network, / still reaches the worker', () => {
    expect(sourceFor('/', '?cyc-net=1')).toBe('network');
    expect(sourceFor('/', '?b=2&cyc-net=1')).toBe('network');
    expect(sw.cycRouteRequest(req('/?b=2&cyc-net=1'))).toBe('network');
    expect(sourceFor('/', '?testhooks=1')).toBe('fetch-event');
    expect(sw.cycRouteRequest(req('/?testhooks=1'))).toBe('shell');
  });

  // fix-download-lane serves /__cyc_dl/<id>/... from the fetch handler. A route
  // list ending in "everything else to the network" sent it to the server in
  // Chromium (verifier, 2026-10-04): only named bypass paths may skip the worker.
  test('a path the table does not name reaches the worker (streamed downloads)', () => {
    for (const path of ['/__cyc_dl/abc123/report.pdf', '/plugins/git-page.html', '/some/new/path'])
      expect(sourceFor(path), path).toBe('fetch-event');
  });

  test('the browser skips the worker only where the handler would go to the network anyway', () => {
    for (const path of [
      '/',
      '/index.html',
      '/boot-watchdog.js',
      '/assets/main-AbCd1234.js',
      '/assets/fonts/inter-latin.woff2',
      '/clientlog',
      '/build.txt',
      '/config',
      '/settings',
      '/report',
      '/push/read',
      '/engines/announce',
      '/cyc-precache.json',
      '/__cyc_dl/abc/x.bin'
    ]) {
      const handler = sw.cycRouteRequest(req(path));
      if (sourceFor(path) === 'network') expect(handler, path).toBe('network');
      if (handler !== 'network') expect(sourceFor(path), path).toBe('fetch-event');
    }
    // The app's constant traffic never wakes the worker.
    for (const path of ['/clientlog', '/build.txt', '/config', '/settings', '/push/read'])
      expect(sourceFor(path), path).toBe('network');
  });

  test('one table drives both: every network row is a declared rule, nothing else is', () => {
    const table = (sw as unknown as {CYC_ROUTE_TABLE: [string, string][]}).CYC_ROUTE_TABLE;
    expect(routes().map((r) => r.condition.urlPattern.pathname)).toEqual(
      table.filter(([, route]) => route === 'network').map(([path]) => path)
    );
    expect(routes()[0].condition.urlPattern.search).toBe('*cyc-net=*');
    expect(routes().every((r) => r.source === 'network')).toBe(true);
  });

  test('install declares the routes when the browser has the API, and installs without it', async () => {
    const w = bootWorker(SW_CODE);
    (globalThis as unknown as {fetch: unknown}).fetch = async () => {
      throw new TypeError('offline');
    };
    const declared: unknown[] = [];
    const run = async (event: Record<string, unknown>) => {
      const waited: Promise<unknown>[] = [];
      event.waitUntil = (p: Promise<unknown>) => waited.push(p);
      w.handlers.install.forEach((h) => h(event));
      await Promise.all(waited);
    };
    await run({
      addRoutes: async (r: unknown) => {
        declared.push(r);
      }
    });
    expect(declared).toEqual([(w.sw as unknown as {CYC_ROUTES: Rule[]}).CYC_ROUTES]);
    // A browser that rejects the rules still installs (first install, no active).
    await expect(
      run({
        addRoutes: async () => {
          throw new TypeError('unsupported condition');
        }
      })
    ).resolves.toBeUndefined();
    await expect(run({})).resolves.toBeUndefined();
  });

  test('a skip-waiting message makes the worker skip waiting again', () => {
    const w = bootWorker(SW_CODE);
    let skips = 0;
    (w.sw as unknown as Record<string, unknown>).skipWaiting = () => {
      skips += 1;
    };
    w.handlers.message.forEach((h) => h({data: {t: 'skip-waiting'}}));
    expect(skips).toBe(1);
    w.handlers.message.forEach((h) => h({data: {t: 'something-else'}}));
    w.handlers.message.forEach((h) => h({data: null}));
    expect(skips).toBe(1);
  });
});
