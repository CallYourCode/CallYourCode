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
// literal placeholder; nothing at runtime reads CYC_BUILD, it exists only to make
// the bytes unique. cyc-precache.json's version still drives the cache name.
const CYC_BUILD = '1790210454';

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

async function cycPrecacheInstall() {
  const {version, assets} = await cycReadManifest();
  const cache = await caches.open(CYC_CACHE_PREFIX + version);
  await cache.addAll(assets.map((a) => new Request(a, {cache: 'reload'})));
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

// Which requests this worker may answer from the precache. Pulled out so it can
// be unit-tested without a Cache. Anything that is not a same-origin GET for the
// app shell or a hashed assets/ file is 'network': API routes, websockets,
// sealed push, uploads, transfers and every cross-origin request fall straight
// through untouched. When in doubt, 'network'.
function cycRouteRequest(req) {
  if (!req || req.method !== 'GET') return 'network';
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return 'network';
  }
  if (url.origin !== self.location.origin) return 'network';
  const p = url.pathname;
  if (p === '/' || p === '/index.html') return 'shell';
  if (p.startsWith('/assets/')) return 'asset';
  return 'network';
}

async function cycServeShell(req) {
  const names = await cycCacheNames();
  const current = names[names.length - 1];
  if (current) {
    const cache = await caches.open(current);
    const hit = (await cache.match('/index.html')) || (await cache.match('/'));
    if (hit) return hit;
  }
  return fetch(req);
}

async function cycServeAsset(req) {
  const hit = await caches.match(req, {ignoreSearch: true});
  return hit || fetch(req);
}

self.addEventListener('install', (event) => {
  // A precache miss must never keep the push worker from taking over.
  event.waitUntil(cycPrecacheInstall().catch(() => {}));
  self.skipWaiting();
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
self.cycPrecacheActivate = cycPrecacheActivate;
self.cycServeShell = cycServeShell;
self.cycServeAsset = cycServeAsset;
