import {exportSpki, fpOf, generateIdentity} from '@shared/e2e';

const DB = 'cyc-identity';
const DEVICE_STORE = 'device';
const ENGINE_STORE = 'engines';
const VERSION = 1;

export type DeviceIdentity = {keyPair: CryptoKeyPair; spki: string; fp: string};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DEVICE_STORE)) {
        db.createObjectStore(DEVICE_STORE, {keyPath: 'id'});
      }
      if (!db.objectStoreNames.contains(ENGINE_STORE)) {
        db.createObjectStore(ENGINE_STORE, {keyPath: 'url'});
      }
    };
    req.onsuccess = () => {
      const db = req.result;

      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(req.error ?? new Error(`${DB} open blocked`));
  });
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      })
  );
}

export async function getDeviceIdentity(): Promise<DeviceIdentity> {
  const existing = await tx<DeviceIdentity | undefined>('device', 'readonly', (s) => s.get('me'));
  if (existing?.keyPair && existing?.spki) return existing;
  const keyPair = await generateIdentity(false);
  const spki = await exportSpki(keyPair.publicKey);
  const rec: DeviceIdentity = {keyPair, spki, fp: await fpOf(keyPair.publicKey)};
  await tx('device', 'readwrite', (s) => s.put({id: 'me', ...rec}));
  return rec;
}

export async function getEnginePin(url: string): Promise<string | null> {
  const rec = await tx<{fp?: string} | undefined>(ENGINE_STORE, 'readonly', (s) => s.get(url));
  return typeof rec?.fp === 'string' && rec.fp ? rec.fp : null;
}

export async function setEnginePin(url: string, pin: {fp: string; spki: string}): Promise<void> {
  await tx(ENGINE_STORE, 'readwrite', (s) => s.put({url, ...pin, pinnedAt: Date.now()}));
}

export async function clearEnginePin(url: string): Promise<void> {
  await tx(ENGINE_STORE, 'readwrite', (s) => s.delete(url));
}
