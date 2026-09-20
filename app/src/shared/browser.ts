import {cyclog} from '@/shared/logging';
import {intentFromOutbox} from '@/engine/intents';
type Kind = 'gesture' | 'open' | 'scroll';
const CAP_MS: Record<Kind, number> = {
  gesture: 2500,
  open: 15000,
  scroll: 250
};
type Win = {
  kind: Kind;
  why: string;
  cap: number;
  born: number;
};
let nextToken = 1;
const wins = new Map<number, Win>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let scrollToken = 0;
let settleFns: Array<() => void> = [];
const stamp = () => Date.now();
function fireSettle() {
  if (wins.size) return;
  if (!settleFns.length) return;
  const fns = settleFns;
  settleFns = [];
  for (const fn of fns) fn();
}
function clearTimer(token: number) {
  const t = timers.get(token);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(token);
  }
}
function drop(token: number) {
  clearTimer(token);
  const existed = wins.delete(token);
  if (token === scrollToken) scrollToken = 0;
  if (existed) fireSettle();
}
export function begin(kind: Kind, why: string): number {
  if (kind === 'scroll') {
    if (!scrollToken) {
      scrollToken = nextToken++;
      wins.set(scrollToken, {kind, why, cap: CAP_MS.scroll, born: stamp()});
    }
    const tok = scrollToken;
    clearTimer(tok);
    timers.set(
      tok,
      setTimeout(() => {
        timers.delete(tok);
        drop(tok);
      }, CAP_MS.scroll)
    );
    return tok;
  }
  const token = nextToken++;
  wins.set(token, {kind, why, cap: CAP_MS[kind], born: stamp()});
  timers.set(
    token,
    setTimeout(() => {
      timers.delete(token);
      const w = wins.get(token);
      if (w) cyclog('interaction.leak', {kind: w.kind, why: w.why, ms: stamp() - w.born});
      drop(token);
    }, CAP_MS[kind])
  );
  return token;
}
export function end(token: number): void {
  if (!wins.has(token)) return;
  drop(token);
}
export function active(kind?: Kind): boolean {
  if (!kind) return wins.size > 0;
  for (const w of wins.values()) if (w.kind === kind) return true;
  return false;
}
export function onSettle(fn: () => void): void {
  settleFns.push(fn);
  if (!wins.size) queueMicrotask(fireSettle);
}
export function installAndroidIntentLinks(): void {
  const isAndroidPwa =
    /Android/.test(navigator.userAgent) && window.matchMedia('(display-mode: standalone)').matches;
  if (!isAndroidPwa) return;
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const a = (e.target as HTMLElement)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    let url: URL;
    try {
      url = new URL(a.href, location.href);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.origin === location.origin) return;
    e.preventDefault();
    const rest = url.href.slice(url.protocol.length + 2);
    const fallback = encodeURIComponent(url.href);
    location.href =
      `intent://${rest}#Intent;scheme=${url.protocol.slice(0, -1)};` +
      `action=android.intent.action.VIEW;S.browser_fallback_url=${fallback};end`;
  });
}
const DB_NAME = 'cyc-clips';
// v5: adds TRANSFERS, the resumable-transfer row store (Lane A). A voice note or
// file send parks its bytes in CLIPS and its transfer row here, so an in-flight
// upload resumes from its acked chunks after a reload instead of restarting.
// v6: INTENTS replaces the outbox. Every user mutation (a send, a rename, a
// reorder, a mark-unread, a heard mark, a settings patch) is one durable row
// here until the engine has taken it; the old `outbox` rows become send
// intents, `failed` ones queued again (they were transient failures marked
// definitive), and the outbox store is deleted.
const DB_VERSION = 6;
export const CLIPS = 'clips';
export const COMPOSITIONS = 'compositions';
export const IMAGES = 'images';
export const TRANSFERS = 'transfers';
export const INTENTS = 'intents';
const OUTBOX = 'outbox';
const STORES: {
  name: string;
  keyPath: string;
}[] = [
  {name: CLIPS, keyPath: 'key'},
  {name: COMPOSITIONS, keyPath: 'sessionId'},
  {name: IMAGES, keyPath: 'url'},
  {name: TRANSFERS, keyPath: 'key'}
];

// The whole of onupgradeneeded for cyc-clips, pure over the calls it makes so
// it is unit-tested without a browser: create every store that is missing
// (additive and idempotent, whatever version the db was), then, when the v6
// intents store is new and an outbox exists, walk the outbox and write one
// intent per row before deleting it. The walk is asynchronous inside the
// upgrade transaction (a cursor), which is what `tx` is for.
type UpgradeDb = Pick<IDBDatabase, 'objectStoreNames' | 'deleteObjectStore' | 'createObjectStore'>;
type UpgradeTx = {
  objectStore(name: string): {
    openCursor(): IDBRequest<IDBCursorWithValue | null>;
    put(value: unknown): IDBRequest<IDBValidKey>;
  };
} | null;
export function upgradeClipsDb(d: UpgradeDb, tx: UpgradeTx): void {
  for (const s of STORES) {
    if (!d.objectStoreNames.contains(s.name)) d.createObjectStore(s.name, {keyPath: s.keyPath});
  }
  const hadIntents = d.objectStoreNames.contains(INTENTS);
  if (!hadIntents) {
    const store = d.createObjectStore(INTENTS, {keyPath: 'id'});
    store.createIndex('bySession', 'sessionId');
    store.createIndex('byEngine', 'engineKey');
  }
  if (!d.objectStoreNames.contains(OUTBOX)) return;
  if (hadIntents || !tx) {
    d.deleteObjectStore(OUTBOX);
    return;
  }
  const outbox = tx.objectStore(OUTBOX);
  const intents = tx.objectStore(INTENTS);
  const walk = outbox.openCursor();
  walk.onsuccess = () => {
    const cur = walk.result;
    if (!cur) {
      d.deleteObjectStore(OUTBOX);
      return;
    }
    const row = intentFromOutbox(cur.value);
    if (row) intents.put(row);
    cur.continue();
  };
  walk.onerror = () => {
    d.deleteObjectStore(OUTBOX);
  };
}
let db: IDBDatabase | null = null;
let opening: Promise<IDBDatabase | null> | null = null;
let blockedReq: IDBOpenDBRequest | null = null;
function openDatabase(): Promise<IDBDatabase | null> {
  if (db) return Promise.resolve(db);
  if (opening) return opening;
  if (blockedReq) return Promise.resolve(null);
  opening = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      upgradeClipsDb(req.result, req.transaction);
    };
    req.onsuccess = () => {
      blockedReq = null;
      db = req.result;
      db.onversionchange = () => {
        db?.close();
        db = null;
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      blockedReq = null;
      resolve(null);
    };
    req.onblocked = () => {
      blockedReq = req;
      opening = null;
      resolve(null);
    };
  });
  return opening;
}
// One transaction over `store` (or over several stores, the first of which is
// handed to `run`; the rest are reached through the transaction). Resolves the
// request's result once the transaction has completed, null when it did not.
export function transactionOn<T>(
  store: string | string[],
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, tx: IDBTransaction) => IDBRequest<T>
): Promise<T | null> {
  return openDatabase().then((d) => {
    if (!d) return null;
    return new Promise<T | null>((resolve) => {
      let req: IDBRequest<T>;
      try {
        const tx = d.transaction(store, mode);
        req = run(tx.objectStore(Array.isArray(store) ? store[0] : store), tx);
      } catch {
        resolve(null);
        return;
      }
      req.onsuccess = () => {
        if (mode === 'readonly') {
          resolve(req.result);
          return;
        }
        const t = req.transaction;
        if (!t) {
          resolve(req.result);
          return;
        }
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => resolve(null);
        t.onabort = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  });
}
export function requestPersistence(): void {
  const s = navigator.storage;
  if (!s || !s.persist || !s.persisted) {
    cyclog('storage.persist', {
      outcome: 'unsupported',
      why:
        'this browser has no navigator.storage.persist, so the clip vault and ' +
        'the composition store stay evictable under space pressure'
    });
    return;
  }
  s.persisted()
    .then((already) => {
      if (already) {
        cyclog('storage.persist', {
          outcome: 'already',
          why: 'this origin is already persistent; not asking again'
        });
        return undefined;
      }
      return s.persist().then((granted) => {
        cyclog('storage.persist', {
          outcome: granted ? 'granted' : 'denied',
          why: granted
            ? 'the browser marked this origin persistent: unsent recordings and ' +
              'compositions are no longer evictable under space pressure'
            : 'the browser refused to mark this origin persistent, so unsent work is ' +
              'still evictable and the app must not claim otherwise'
        });
      });
    })
    .catch((err) => {
      cyclog('storage.persist', {
        outcome: 'error',
        err,
        why:
          'asking the browser for persistent storage threw; unsent work remains ' +
          'evictable and the app must not claim otherwise'
      });
    });
}
