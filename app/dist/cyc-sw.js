// --- Static asset precache (offline design: asset caching only) -----------
// ADDITIVE and self-contained. It NEVER intercepts, caches or inspects API
// routes, websockets, sealed push, uploads, transfers or anything cross-origin:
// only same-origin GETs for the app shell (index.html) and hashed assets/ files
// are served from cache, everything else falls straight through to the network
// exactly as before. This is separate from the app's offline-first DATA model
// (IndexedDB history/intents/keys); it only holds static build output.
//
// The build writes /cyc-precache.json: {version, assets[]} where version is the
// build stamp and assets is the shell + every hashed chunk this build produced.
// On install we open a cache named for that stamp and store them, so the app
// boots offline and a lazy chunk survives a rebuild. On activate we drop caches
// from older builds (keeping the current and the immediately previous, so a page
// caught mid-swap still resolves) and claim clients; the stamp-named cache plus
// this cleanup is what makes a new build win, so bundleReload's reload flow is
// not looped. skipWaiting() is kept so the security-sensitive push worker takes
// over promptly, exactly as before.
// The build stamp for THIS build, baked in by scripts/build-cyc.sh when it
// copies this file into dist (it replaces the placeholder with the same stamp it
// writes to build.txt / cyc-precache.json). This is the whole reason the worker
// updates: the served cyc-sw.js bytes change every build, so a browser's SW
// update check finds the script byte-different, re-installs (new stamp cache) and
// re-activates (drops old caches + clients.claim). In app/public it stays the
// literal placeholder. cyc-precache.json's version drives the cache name, and
// install checks that it is this build's (cycPrecacheInstall).
const CYC_BUILD = '1791077881';

const CYC_CACHE_PREFIX = 'cyc-precache-';
const CYC_MANIFEST_URL = '/cyc-precache.json';

async function cycReadManifest() {
  const res = await fetch(CYC_MANIFEST_URL, {cache: 'no-store'});
  if (!res.ok) throw new Error('cyc-precache: manifest ' + res.status);
  const m = await res.json();
  const version = m && m.version != null ? String(m.version) : '';
  const assets = m && Array.isArray(m.assets) ? m.assets.map(String) : [];
  if (!version || !assets.length) throw new Error('cyc-precache: empty manifest');
  return {version, assets};
}

// Fills THIS build's bucket, or throws. The manifest must name this worker's own
// build: a deploy landing between the worker fetch and the manifest fetch would
// otherwise fill another build's bucket under this worker. (Unbaked, in
// app/public and the unit tests, CYC_BUILD is the placeholder and is not
// checked.) The whole build is fetched before anything is stored, so a failed
// fetch (a dead radio, a 503) leaves no bucket at all, and the shell is stored
// LAST, so a bucket that holds index.html holds every file it names: the
// invariant cycServeShell and the page's readiness gate rely on. A store that
// fails part way (quota) drops the half-filled bucket.
// Every fetch SETTLES before the install fails. Cache.addAll (and Promise.all)
// reject at the first failure with the rest still loading, the failed install
// discards this worker with its own loads in flight, and in WebKit that took
// the network process down (Playwright WebKit, 2026-10-03: 16 crashes in 190
// failing update installs that way, 0 in 90 with every fetch settled first).
// A network process crash costs the page its worker connection and its sockets.
// The fetched shell must be THIS build's too: a deploy landing between the
// manifest fetch and the shell fetch hands back the next build's index.html,
// which names chunks this bucket does not hold, and the next offline launch is
// blank (verifier, 2026-10-04). Its cyc-build stamp must be the manifest's and
// every asset it names must be in the manifest; otherwise the install fails and
// the next update check retries (fetching the newer worker anyway).
function cycShellMismatch(html, version, assets) {
  const stamp = /<meta name="cyc-build" content="([^"]*)"/.exec(html);
  if (!stamp || stamp[1] !== version) return 'stamp ' + (stamp ? stamp[1] : 'none');
  const own = new Set(assets.map((a) => new URL(a, self.location.origin).pathname.slice(1)));
  for (const m of html.matchAll(/(?:src|href)="\.?\/?((?:assets\/[^"]+)|boot-watchdog\.js)"/g))
    if (!own.has(m[1])) return 'names ' + m[1];
  return '';
}

async function cycPrecacheInstall() {
  const {version, assets} = await cycReadManifest();
  if (/^\d+$/.test(CYC_BUILD) && version !== CYC_BUILD)
    throw new Error('cyc-precache: manifest ' + version + ' is not this worker ' + CYC_BUILD);
  const settled = await Promise.allSettled(
    assets.map(async (a) => {
      const req = new Request(a, {cache: 'reload'});
      const res = await fetch(req);
      if (!res || !res.ok) throw new Error('cyc-precache: ' + a + ' ' + (res && res.status));
      return {req, res};
    })
  );
  const failed = settled.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  const got = settled.map((r) => r.value);
  const isShell = (req) => {
    const p = new URL(req.url, self.location.origin).pathname;
    return p === '/' || p === '/index.html';
  };
  if (/^\d+$/.test(CYC_BUILD))
    for (const {req, res} of got) {
      if (!isShell(req)) continue;
      const why = cycShellMismatch(await res.clone().text(), version, assets);
      if (why) throw new Error('cyc-precache: the fetched shell is another build (' + why + ')');
    }
  const name = CYC_CACHE_PREFIX + version;
  const cache = await caches.open(name);
  try {
    for (const {req, res} of got) if (!isShell(req)) await cache.put(req, res);
    for (const {req, res} of got) if (isShell(req)) await cache.put(req, res);
  } catch (e) {
    await caches.delete(name);
    throw e;
  }
}

// The precache cache names, sorted. Build stamps are 10-digit epoch seconds, so
// lexical order is numeric order: the last name is the current build.
async function cycCacheNames() {
  return (await caches.keys()).filter((n) => n.startsWith(CYC_CACHE_PREFIX)).sort();
}

async function cycPrecacheActivate() {
  const names = await cycCacheNames();
  const keep = new Set(names.slice(-2)); // current + immediately previous
  await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
}

// THE routing table, one copy driving both the fetch handler (cycRouteRequest)
// and the browser's Static Routing rules (CYC_ROUTES, Chromium). Rows are
// [pathname, route, query]: pathname exact or a prefix ending '/*'; query, when
// given, must appear in the search; the first match wins.
//  - 'shell' / 'asset': answered from the precache. The boot watchdog is a
//    non-hashed shell file precached next to index.html (scripts/build-cyc.sh);
//    the shell is stored last, so any bucket holding the shell holds it too.
//  - 'network': straight to the network without waking this worker. In
//    Chromium a request reaching the old worker while it is stopped for a new
//    build's activation restarts it and parks the new build in "waiting", and a
//    navigation into a parked activation hangs blank (2026-10-03,
//    sw-activation-race.spec.ts). So: the app's own API, log and stamp traffic
//    (sent all the time), and the escape hatch: any URL carrying cyc-net=1,
//    where a self-navigation goes when a new worker is still waiting a few
//    seconds after being asked to take over (shared/selfReload.ts): it loads
//    from the network, never touching the stuck old worker.
// Anything NOT named here still reaches the fetch handler (so a path the handler
// learns to serve later works without touching this table), as does every
// cross-origin request (a urlPattern dict cannot name "another origin"); the
// handler sends what it does not serve to the network untouched.
const CYC_ROUTE_TABLE = [
  ['/*', 'network', 'cyc-net='],
  ['/', 'shell'],
  ['/index.html', 'shell'],
  ['/assets/*', 'asset'],
  ['/boot-watchdog.js', 'asset'],
  ['/build.txt', 'network'],
  ['/cyc-precache.json', 'network'],
  ['/clientlog', 'network'],
  ['/config', 'network'],
  ['/settings', 'network'],
  ['/report', 'network'],
  ['/push/*', 'network']
];

function cycTableRoute(pathname, search) {
  for (const [path, route, query] of CYC_ROUTE_TABLE) {
    const hit = path.endsWith('/*') ? pathname.startsWith(path.slice(0, -1)) : pathname === path;
    if (hit && (!query || String(search || '').includes(query))) return route;
  }
  return '';
}

// Only the network rows: everything else falls to the browser's default, the
// fetch event.
const CYC_ROUTES = CYC_ROUTE_TABLE.filter(([, route]) => route === 'network').map(
  ([path, , query]) => ({
    condition: {urlPattern: query ? {pathname: path, search: '*' + query + '*'} : {pathname: path}},
    source: 'network'
  })
);

// What the fetch handler does with a request. Only a same-origin GET for a
// shell or asset row is answered from the precache; everything else (API,
// websockets, sealed push, uploads, transfers, cross-origin) is 'network':
// no respondWith, straight through. When in doubt, 'network'.
function cycRouteRequest(req) {
  if (!req || req.method !== 'GET') return 'network';
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return 'network';
  }
  if (url.origin !== self.location.origin) return 'network';
  const route = cycTableRoute(url.pathname, url.search);
  return route === 'shell' || route === 'asset' ? route : 'network';
}

async function cycServeShell(req) {
  // Newest bucket FIRST, but only a bucket that actually HOLDS the shell. A
  // bucket name appears when install starts storing, before the shell is in it
  // (and a worker from before 2026-10-03 left empty ones behind when its
  // precache failed); serving the network's new index.html past such a bucket
  // points the page at a hashed entry chunk that is not cached either, and with
  // no network it paints nothing (the black screen). The shell is stored last,
  // so a bucket that has index.html has every chunk that shell names. Falling back to the newest FULLY-cached shell
  // keeps the page booting (stale but alive) until the new bucket really fills;
  // the reload flow re-fires once it does. Only when no bucket holds the shell
  // do we go to the network.
  const names = await cycCacheNames();
  for (let i = names.length - 1; i >= 0; i--) {
    const cache = await caches.open(names[i]);
    const hit = (await cache.match('/index.html')) || (await cache.match('/'));
    if (hit) return hit;
  }
  return fetch(req);
}

async function cycServeAsset(req) {
  const hit = await caches.match(req, {ignoreSearch: true});
  return hit || fetch(req);
}

// An UPDATE whose precache fails must fail its install. The active worker then
// stays, serving its own complete build, and because the registered script is
// still byte-different from it, the browser re-runs this install on the next
// update check (every navigation, and the page's registration.update() on each
// foreground while build.txt says it is behind). Swallowing the failure instead
// let a worker take control holding nothing of its own build: the shell serve
// kept answering from the previous build's bucket, and with this worker's bytes
// never changing again no update check ever re-ran the install, so the client
// stayed on the old build until the next deploy (iPhone, 2026-10-03).
// The FIRST install (no active worker) still takes over without a precache: it
// displaces nothing, the shell then comes from the network, and the push worker
// must not wait on a flaky radio.
self.addEventListener('install', (event) => {
  // Best effort: a browser without the API (WebKit) or a rule it rejects
  // leaves every request to the fetch handler, which routes it the same way
  // (both read CYC_ROUTE_TABLE).
  if (typeof event.addRoutes === 'function')
    event.waitUntil(Promise.resolve(event.addRoutes(CYC_ROUTES)).catch(() => {}));
  event.waitUntil(
    cycPrecacheInstall().catch((e) => {
      if (self.registration.active) throw e;
    })
  );
  self.skipWaiting();
});

// A page that finds this worker installed but still WAITING asks it to take
// over again. Chromium can park a skip-waiting worker: the old worker is
// stopped to make way, a request then restarts it, and the activation is not
// retried until the old worker idles (30 s with no events, 5 min at most). A
// second skipWaiting() retries it. The page also holds its own navigations a
// few seconds while a worker waits (shared/selfReload.ts navigateSelf): a
// navigation that triggers the parked activation is dispatched to the old
// worker as it is stopped, and never completes (the hung reload).
self.addEventListener('message', (event) => {
  // On a worker that is already active this is a no-op.
  if (event.data && event.data.t === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(cycPrecacheActivate().then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const route = cycRouteRequest(event.request);
  if (route === 'network') return; // untouched: no respondWith, straight to network
  if (route === 'shell') return event.respondWith(cycServeShell(event.request));
  event.respondWith(cycServeAsset(event.request));
});

const CAN_BE_SILENT =
  !/iPhone|iPad|iPod/.test(self.navigator.userAgent) &&
  !(
    /Safari/.test(self.navigator.userAgent) &&
    !/Chrome|CriOS|Firefox/.test(self.navigator.userAgent)
  );

const SILENT_SUPPORTED = (() => {
  try {
    return typeof Notification !== 'undefined' && 'silent' in Notification.prototype;
  } catch {
    return false;
  }
})();

const READ_TAG = 'cyc-read';

const BANNER_DB = 'cyc-sw';
const BANNER_STORE = 'banners';

function cycOpenBannerDb() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(BANNER_DB, 1);
    } catch (e) {
      return reject(e);
    }
    req.onupgradeneeded = () => {
      try {
        if (!req.result.objectStoreNames.contains(BANNER_STORE))
          req.result.createObjectStore(BANNER_STORE, {keyPath: 'tag'});
      } catch {}
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function bannerPut(rec) {
  if (!rec || rec.tag == null || String(rec.tag) === READ_TAG) return;
  let db;
  try {
    db = await cycOpenBannerDb();
  } catch {
    return;
  }
  try {
    await new Promise((resolve) => {
      let store;
      try {
        store = db.transaction(BANNER_STORE, 'readwrite').objectStore(BANNER_STORE);
      } catch {
        return resolve();
      }
      const req = store.put({
        tag: String(rec.tag),
        title: rec.title == null ? '' : String(rec.title),
        body: rec.body == null ? '' : String(rec.body),
        count: Number(rec.count) || 1,
        data: rec.data || {},
        icon: rec.icon || '',
        timestamp: Number(rec.timestamp) || 0
      });
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } finally {
    try {
      db.close();
    } catch {}
  }
}

async function bannerDelete(tag) {
  if (tag == null) return;
  let db;
  try {
    db = await cycOpenBannerDb();
  } catch {
    return;
  }
  try {
    await new Promise((resolve) => {
      let store;
      try {
        store = db.transaction(BANNER_STORE, 'readwrite').objectStore(BANNER_STORE);
      } catch {
        return resolve();
      }
      const req = store.delete(String(tag));
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } finally {
    try {
      db.close();
    } catch {}
  }
}

async function bannerAll() {
  let db;
  try {
    db = await cycOpenBannerDb();
  } catch {
    return [];
  }
  try {
    return await new Promise((resolve) => {
      let store;
      try {
        store = db.transaction(BANNER_STORE, 'readonly').objectStore(BANNER_STORE);
      } catch {
        return resolve([]);
      }
      const req = store.getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });
  } finally {
    try {
      db.close();
    } catch {}
  }
}

function mergeStanding(live, persisted) {
  const byTag = new Map();
  for (const p of persisted || []) {
    if (!p || String(p.tag) === READ_TAG) continue;
    byTag.set(String(p.tag), {
      tag: String(p.tag),
      title: p.title,
      body: p.body,
      data: p.data,
      icon: p.icon,
      timestamp: Number(p.timestamp) || 0
    });
  }
  for (const n of live || []) {
    if (!n || String(n.tag) === READ_TAG) continue;
    byTag.set(String(n.tag), {
      tag: String(n.tag),
      title: n.title,
      body: n.body,
      data: n.data,
      icon: n.icon,
      timestamp: Number(n.timestamp) || 0
    });
  }
  return [...byTag.values()];
}

async function closeTag(tag) {
  for (const n of await self.registration.getNotifications({tag})) n.close();

  await bannerDelete(tag);
}

function decideDismiss(dismissedTag, notifications) {
  const t = String(dismissedTag || 'cyc');
  const survivors = (notifications || []).filter(
    (n) => String(n.tag) !== t && String(n.tag) !== READ_TAG
  );
  if (survivors.length) {
    const newest = survivors.reduce((a, b) =>
      (Number(b.timestamp) || 0) >= (Number(a.timestamp) || 0) ? b : a
    );
    return {close: [t, String(newest.tag)], reshow: newest, filler: false};
  }
  return {close: [t, READ_TAG], reshow: null, filler: true};
}

// --- Notification icons (the cyc-avatars store) ----------------------------
// Pushes carry NO icon url (sealed transport: the engine's /session-photo is
// owner-gated, an OS icon fetch could never answer). The page keeps a local
// per-session icon -- the profile photo thumbnail, or the name-derived robot
// SVG -- as a data URI in indexedDB `cyc-avatars`/`icons`; the worker reads it
// here by sessionId. A data URI needs no fetch, so the sealed model holds.
// iOS ignores the icon member entirely and shows the app icon; that is a
// platform limit, not a miss here.
const DEFAULT_ICON = '/pwa/icons/app-192.png';

function cycOpenAvatarDb() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open('cyc-avatars', 1);
    } catch (e) {
      return reject(e);
    }
    req.onupgradeneeded = () => {
      try {
        if (!req.result.objectStoreNames.contains('icons'))
          req.result.createObjectStore('icons', {keyPath: 'sessionId'});
      } catch {}
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cycNotifIcon(sessionId) {
  if (!sessionId) return DEFAULT_ICON;
  let db;
  try {
    db = await cycOpenAvatarDb();
  } catch {
    return DEFAULT_ICON;
  }
  try {
    const rec = await new Promise((resolve) => {
      let store;
      try {
        store = db.transaction('icons', 'readonly').objectStore('icons');
      } catch {
        return resolve(null);
      }
      const req = store.get(String(sessionId));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    return rec && typeof rec.icon === 'string' && rec.icon ? rec.icon : DEFAULT_ICON;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

function cycSealedContent(item, decrypted) {
  const it = item || {};
  const d = decrypted && typeof decrypted === 'object' ? decrypted : null;
  const body = d && d.body != null ? String(d.body) : it.body != null ? String(it.body) : '';
  const title = d && d.title != null ? String(d.title) : it.title != null ? String(it.title) : '';
  const count = Number(d && d.count != null ? d.count : it.count) || 1;

  const open = d && d.open != null ? String(d.open) : '';
  return {title: title || 'CallYourCode', body: body || 'New message', count, open};
}

function cycB64ToBytes(b64) {
  const bin = atob(String(b64));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function cycOpenKeyDb() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open('cyc-keys', 1);
    } catch (e) {
      return reject(e);
    }

    req.onupgradeneeded = () => {
      try {
        if (!req.result.objectStoreNames.contains('keys'))
          req.result.createObjectStore('keys', {keyPath: 'userHost'});
      } catch {}
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cycKeyForKid(kid) {
  let db;
  try {
    db = await cycOpenKeyDb();
  } catch {
    return null;
  }
  try {
    const rec = await new Promise((resolve) => {
      let store;
      try {
        store = db.transaction('keys', 'readonly').objectStore('keys');
      } catch {
        return resolve(null);
      }
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result || []).find((r) => r && r.kid === kid) || null);
      req.onerror = () => resolve(null);
    });
    return rec && rec.key ? rec.key : null;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

async function cycDeriveSessionKey(kEngine, sessionId) {
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('session:' + sessionId)
    },
    kEngine,
    {name: 'AES-GCM', length: 256},
    false,
    ['decrypt']
  );
}

async function cycDeriveEngineNotifyKey(kEngine) {
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('notify')
    },
    kEngine,
    {name: 'AES-GCM', length: 256},
    false,
    ['decrypt']
  );
}

async function cycOpenPush(kS, blob) {
  const raw = cycB64ToBytes(blob);
  const pt = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: raw.slice(0, 12)},
    kS,
    raw.slice(12)
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

async function resolveSealed(item) {
  if (!item || typeof item.enc !== 'string' || typeof item.kid !== 'string')
    return cycSealedContent(item, null);
  try {
    const kEngine = await cycKeyForKid(item.kid);
    if (!kEngine) return cycSealedContent(item, null);

    const sessionId = String(item.sessionId || '');
    const k = sessionId
      ? await cycDeriveSessionKey(kEngine, sessionId)
      : await cycDeriveEngineNotifyKey(kEngine);
    return cycSealedContent(item, await cycOpenPush(k, item.enc));
  } catch {
    return cycSealedContent(item, null);
  }
}

// --- Push-poke to open window clients (bg-refresh, the worker's half) ------
// A push while the app is OPEN also pokes every matched window client, so the
// page runs its existing catch-up (engine/store.ts onPushPoke): the push got
// through, yet the page's sealed pipe may be silently dead. The poke is
// content-free -- {t: 'sync-poke'} plus at most the sessionId the push
// envelope already carried in the clear (it is the notification tag) -- so
// the sealed model holds: nothing readable is forwarded, the page re-syncs
// over its own sealed pipe. A batch push naming exactly one session targets
// it; anything else pokes untargeted ("sync now").
function cycPokeSessionId(data) {
  if (!data) return '';
  if (data.t === 'batch') {
    const list = Array.isArray(data.sessions) ? data.sessions : [];
    return list.length === 1 ? String(list[0].sessionId || '') : '';
  }
  return data.sessionId ? String(data.sessionId) : '';
}

// Never throws: a failed matchAll or postMessage only costs the poke, never
// the notification work it rides behind.
async function cycPokeClients(sessionId) {
  let all = [];
  try {
    all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
  } catch {
    return;
  }
  for (const c of all) {
    try {
      c.postMessage(sessionId ? {t: 'sync-poke', sessionId} : {t: 'sync-poke'});
    } catch {}
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {body: event.data ? event.data.text() : ''};
  }
  const handled = (async () => {
    const tag = data.tag || data.sessionId || 'cyc';

    if (data.t === 'batch') {
      const dismissed = Array.isArray(data.dismissed) ? data.dismissed : [];
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];

      for (const sessionId of dismissed) await closeTag(String(sessionId || 'cyc'));

      if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
        try {
          if (data.badge > 0) await self.navigator.setAppBadge(data.badge);
          else await self.navigator.clearAppBadge?.();
        } catch {}
      }

      let shown = 0;
      for (const s of sessions) {
        const t = String(s.sessionId || 'cyc');

        const real = await resolveSealed(s);
        const count = real.count;
        const body =
          count > 1
            ? `${count} new messages · ${real.body || ''}`.trim()
            : real.body || 'New message';

        await closeTag(t);
        const bData = {sessionId: s.sessionId || '', url: '/#app'};
        const bIcon = await cycNotifIcon(s.sessionId);
        await self.registration.showNotification(real.title || 'CallYourCode', {
          body,
          tag: t,
          renotify: true,
          data: bData,
          icon: bIcon,
          badge: '/pwa/icons/notification-badge.png'
        });

        await bannerPut({
          tag: t,
          title: real.title || 'CallYourCode',
          body,
          count,
          data: bData,
          icon: bIcon,
          timestamp: Date.now()
        });
        shown++;
      }

      if (shown) return closeTag(READ_TAG);
      if (CAN_BE_SILENT) return;
      await closeTag(READ_TAG);
      return self.registration.showNotification('CallYourCode', {
        body: dismissed.length ? 'Messages read on other device' : 'No new messages',
        tag: READ_TAG,
        silent: true,
        data: {sessionId: dismissed[0] || ''},
        icon: '/pwa/icons/app-192.png',
        badge: '/pwa/icons/notification-badge.png'
      });
    }

    if (data.dismiss) {
      await closeTag(tag);
      if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
        try {
          if (data.badge > 0) await self.navigator.setAppBadge(data.badge);
          else await self.navigator.clearAppBadge?.();
        } catch {}
      }
      if (CAN_BE_SILENT) return;

      const standing = mergeStanding(await self.registration.getNotifications(), await bannerAll());
      const decision = decideDismiss(tag, standing);
      for (const ct of decision.close) await closeTag(ct);
      if (decision.reshow) {
        const n = decision.reshow;

        await self.registration.showNotification(n.title || 'CallYourCode', {
          body: n.body,
          tag: n.tag,
          renotify: true,
          data: n.data,
          icon: n.icon || '/pwa/icons/app-192.png',
          badge: '/pwa/icons/notification-badge.png',

          ...(SILENT_SUPPORTED ? {silent: true} : {})
        });

        await bannerPut({
          tag: n.tag,
          title: n.title,
          body: n.body,
          data: n.data,
          icon: n.icon || '/pwa/icons/app-192.png',
          timestamp: n.timestamp
        });
        return;
      }

      return self.registration.showNotification('CallYourCode', {
        body: 'Read on another device',
        tag: READ_TAG,
        silent: true,
        data: {sessionId: data.sessionId || ''},
        icon: '/pwa/icons/app-192.png',
        badge: '/pwa/icons/notification-badge.png'
      });
    }

    if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
      try {
        if (data.badge > 0) await self.navigator.setAppBadge(data.badge);
        else await self.navigator.clearAppBadge?.();
      } catch {}
    }

    const real = await resolveSealed(data);
    const count = real.count;
    const body =
      count > 1 ? `${count} new messages · ${real.body || ''}`.trim() : real.body || 'New message';

    await closeTag(tag);
    await closeTag(READ_TAG);

    const nData = {sessionId: data.sessionId || real.open || '', url: data.url || '/#app'};
    const nIcon = await cycNotifIcon(data.sessionId);
    await self.registration.showNotification(real.title || 'CallYourCode', {
      body,
      tag,
      renotify: true,
      data: nData,

      icon: nIcon,
      badge: '/pwa/icons/notification-badge.png'
    });

    await bannerPut({
      tag,
      title: real.title || 'CallYourCode',
      body,
      count,
      data: nData,
      icon: nIcon,
      timestamp: Date.now()
    });
  })();
  // After the notification work, whatever branch it took (batch, dismiss,
  // single): poke matched open clients so the page catches itself up.
  event.waitUntil(handled.finally(() => cycPokeClients(cycPokeSessionId(data))));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;

  const closedTag = event.notification.tag || sessionId;
  const target = '/' + (sessionId ? '?chat=' + encodeURIComponent(sessionId) : '') + '#app';
  event.waitUntil(
    (async () => {
      await bannerDelete(closedTag);
      const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});

      for (const c of all) {
        if (new URL(c.url).pathname === '/') {
          await c.focus();
          c.postMessage({t: 'open-chat', sessionId});
          return;
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});

self.decideDismiss = decideDismiss;

self.cycSealedContent = cycSealedContent;
self.resolveSealed = resolveSealed;
self.cycOpenPush = cycOpenPush;
self.cycDeriveSessionKey = cycDeriveSessionKey;
self.cycDeriveEngineNotifyKey = cycDeriveEngineNotifyKey;

self.cycNotifIcon = cycNotifIcon;
self.cycPokeSessionId = cycPokeSessionId;
self.cycPokeClients = cycPokeClients;
self.mergeStanding = mergeStanding;
self.bannerPut = bannerPut;
self.bannerDelete = bannerDelete;
self.bannerAll = bannerAll;

self.CYC_BUILD = CYC_BUILD;
self.cycRouteRequest = cycRouteRequest;
self.cycReadManifest = cycReadManifest;
self.cycPrecacheInstall = cycPrecacheInstall;
self.cycShellMismatch = cycShellMismatch;
self.cycPrecacheActivate = cycPrecacheActivate;
self.cycServeShell = cycServeShell;
self.cycServeAsset = cycServeAsset;
self.CYC_ROUTES = CYC_ROUTES;
self.CYC_ROUTE_TABLE = CYC_ROUTE_TABLE;
