import {b64decode, importEngineKey} from '@shared/e2e';

export const DB_NAME = 'cyc-keys';
export const STORE = 'keys';
const VERSION = 1;

type KeyRecord = {
  userHost: string;

  gen?: number;

  kid?: string;

  key?: CryptoKey;

  label: string;

  e2e: boolean;

  fp?: string;

  spki?: string;
};

type WireGen = {gen: number; kid: string; key: string};

function retiredKey(userHost: string, kid: string): string {
  return `${userHost}#${kid}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, {keyPath: 'userHost'});
    };
    req.onsuccess = () => {
      const db = req.result;

      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(req.error ?? new Error(`${DB_NAME} open blocked`));
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      })
  );
}

const changeListeners: Array<() => void> = [];

export function onKeyringChange(fn: () => void): () => void {
  changeListeners.push(fn);
  return () => {
    const i = changeListeners.indexOf(fn);
    if (i >= 0) changeListeners.splice(i, 1);
  };
}

function notifyChange() {
  for (const fn of changeListeners) fn();
}

export async function putKey(rec: KeyRecord): Promise<void> {
  await tx('readwrite', (s) => s.put(rec));
  notifyChange();
}

export async function getByUserHost(userHost: string): Promise<KeyRecord | null> {
  const rec = await tx<KeyRecord | undefined>('readonly', (s) => s.get(userHost));
  return rec ?? null;
}

export async function listKeys(): Promise<KeyRecord[]> {
  return (await tx<KeyRecord[]>('readonly', (s) => s.getAll())) || [];
}

export async function pairedUserHosts(): Promise<Set<string>> {
  const all = await listKeys();
  return new Set(
    all
      .filter((r) => r.userHost && !r.userHost.includes('#') && r.gen != null)
      .map((r) => r.userHost)
  );
}

export async function deleteKey(userHost: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(userHost));
  notifyChange();
}

export async function pinEngineIdentity(userHost: string, fp: string, spki: string): Promise<void> {
  const existing = await getByUserHost(userHost);
  if (existing) {
    await putKey({...existing, fp, spki});
  } else {
    await putKey({userHost, fp, spki, label: userHost, e2e: true});
  }
}

export async function storeGenerations(userHost: string, gens: WireGen[]): Promise<void> {
  const imported: {gen: number; kid: string; key: CryptoKey}[] = [];
  for (const g of gens || []) {
    if (!g || typeof g.kid !== 'string' || !g.kid || typeof g.key !== 'string' || !g.key) continue;
    try {
      imported.push({
        gen: Number(g.gen) || 0,
        kid: g.kid,
        key: await importEngineKey(b64decode(g.key))
      });
    } catch {}
  }
  if (!imported.length) return;

  const byKid = new Map<string, {gen: number; kid: string; key: CryptoKey}>();
  for (const g of imported) {
    const have = byKid.get(g.kid);
    if (!have || g.gen >= have.gen) byKid.set(g.kid, g);
  }
  const uniq = [...byKid.values()];
  const newest = uniq.reduce((a, b) => (b.gen >= a.gen ? b : a), uniq[0]);
  const kids = new Set(uniq.map((g) => g.kid));

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    const existingReq = store.get(userHost);
    existingReq.onsuccess = () => {
      const existing = existingReq.result as KeyRecord | undefined;
      const label = existing?.label ?? userHost;
      const e2e = existing?.e2e ?? false;
      for (const g of uniq) {
        const rec: KeyRecord = {
          userHost: g.kid === newest.kid ? userHost : retiredKey(userHost, g.kid),
          gen: g.gen,
          kid: g.kid,
          key: g.key,
          label,
          e2e
        };

        if (existing?.fp) rec.fp = existing.fp;
        if (existing?.spki) rec.spki = existing.spki;
        store.put(rec);
      }

      const keysReq = store.getAllKeys();
      keysReq.onsuccess = () => {
        const prefix = userHost + '#';
        for (const k of keysReq.result as IDBValidKey[]) {
          const ks = String(k);
          if (!ks.startsWith(prefix)) continue;
          const kid = ks.slice(prefix.length);
          if (!kids.has(kid)) store.delete(ks);
        }
      };
    };
    t.oncomplete = () => {
      db.close();
      notifyChange();
      resolve();
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
    t.onabort = () => {
      db.close();
      reject(t.error || new Error('cyc-keys transaction aborted'));
    };
  });
}
