/* The notification-icon store: `cyc-avatars` / `icons`, one row per session,
 * {sessionId, icon, key, at} where `icon` is a self-contained data URI.
 *
 * WHY A DEDICATED DB: pushes are sealed and carry NO icon url (the engine's
 * /session-photo is owner-gated; an OS icon fetch could never answer, see
 * engine chat/notify.ts). So the PAGE prepares each session's icon locally and
 * the service worker (public/cyc-sw.js, cycNotifIcon) reads this store by
 * sessionId at push time. A data URI needs no fetch at all, which is the only
 * icon a sealed push can safely show. The page writes, the worker reads; a
 * separate v1 DB avoids version coupling with either side's other stores. */

const DB_NAME = 'cyc-avatars';
const STORE = 'icons';

export type NotifIconRow = {sessionId: string; icon: string; key: string; at: number};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (e) {
      reject(e as Error);
      return;
    }
    req.onupgradeneeded = () => {
      try {
        if (!req.result.objectStoreNames.contains(STORE))
          req.result.createObjectStore(STORE, {keyPath: 'sessionId'});
      } catch {
        /* a failed upgrade surfaces as onerror */
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error as Error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return null;
  }
  try {
    return await new Promise<T | null>((resolve) => {
      let req: IDBRequest<T>;
      try {
        req = run(db.transaction(STORE, mode).objectStore(STORE));
      } catch {
        resolve(null);
        return;
      }
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

export function putNotifIcon(row: NotifIconRow): Promise<unknown> {
  return withStore('readwrite', (store) => store.put(row));
}

/* Delete every row whose sessionId is not in `keep`, in one readwrite
 * transaction (getAllKeys, then the deletes ride the same transaction).
 * Returns the deleted ids; [] on any failure (the store is best-effort
 * everywhere, a miss only means a stale icon lingers until the next pass). */
export async function pruneNotifIcons(keep: ReadonlySet<string>): Promise<string[]> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return [];
  }
  try {
    return await new Promise<string[]>((resolve) => {
      let store: IDBObjectStore;
      try {
        store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      } catch {
        resolve([]);
        return;
      }
      const req = store.getAllKeys();
      req.onerror = () => resolve([]);
      req.onsuccess = () => {
        const gone = (req.result ?? []).map(String).filter((id) => !keep.has(id));
        for (const id of gone) {
          try {
            store.delete(id);
          } catch {
            /* the row stays; the next prune pass retries */
          }
        }
        resolve(gone);
      };
    });
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

export function getNotifIcon(sessionId: string): Promise<NotifIconRow | null> {
  return withStore<NotifIconRow>('readonly', (store) => store.get(sessionId)).then(
    (row) => row ?? null
  );
}
