import type {Tx} from '../engine/store/rows/rowStore';

function makeStore(db: Map<string, {key: string}>): IDBObjectStore {
  return {
    get: (k: string) => ({result: db.get(k)}) as unknown as IDBRequest,
    getAll: () => ({result: [...db.values()]}) as unknown as IDBRequest,
    getAllKeys: () => ({result: [...db.keys()]}) as unknown as IDBRequest,
    put: (v: {key: string}) => {
      db.set(v.key, v);
      return {result: v.key} as unknown as IDBRequest;
    },
    delete: (k: string) => {
      db.delete(k);
      return {result: undefined} as unknown as IDBRequest;
    },
    clear: () => {
      db.clear();
      return {result: undefined} as unknown as IDBRequest;
    }
  } as unknown as IDBObjectStore;
}

// An in-memory stand-in for the cyc-rows transaction runner, on the exact
// surface rowStore uses (get/getAll/put/delete/getAllKeys). The same discipline
// cycBlobStore.test.ts keeps: prove the rules without a browser database. Writes
// apply synchronously, so this fake cannot expose a fire-and-forget durability
// race; asyncMemTx does.
export function memTx(): {db: Map<string, {key: string}>; tx: Tx} {
  const db = new Map<string, {key: string}>();
  const tx: Tx = <T>(
    _mode: IDBTransactionMode,
    run: (s: IDBObjectStore) => IDBRequest<T>
  ): Promise<T | null> => {
    return Promise.resolve((run(makeStore(db)) as unknown as {result: T}).result ?? null);
  };
  return {db, tx};
}

// A durable in-memory backing that models REAL IndexedDB's asynchronous commit,
// so a fire-and-forget write (a `void backing(...)` the code never awaits) is
// NOT visible to a read issued before its commit fires. A readonly transaction
// resolves on a microtask reflecting only COMMITTED state; a readwrite
// transaction applies its mutation on a macrotask (setTimeout 0), exactly like a
// real transaction that commits after the current job. Code that awaits its
// write sees it durable afterwards; code that does not await it can lose the
// race. This is what the synchronous memTx hides, and what the stale-axis heal
// must survive: the durable rows must be gone before the fresh tail is admitted,
// or the stale axis reloads from a not-yet-deleted index (the purge loop the
// live rig hit). Drive it with awaitMacro() to flush pending commits.
export function asyncMemTx(): {db: Map<string, {key: string}>; tx: Tx} {
  const db = new Map<string, {key: string}>();
  const tx: Tx = <T>(
    mode: IDBTransactionMode,
    run: (s: IDBObjectStore) => IDBRequest<T>
  ): Promise<T | null> => {
    if (mode === 'readonly') {
      return Promise.resolve().then(
        () => (run(makeStore(db)) as unknown as {result: T}).result ?? null
      );
    }
    return new Promise<T | null>((resolve) => {
      setTimeout(() => resolve((run(makeStore(db)) as unknown as {result: T}).result ?? null), 0);
    });
  };
  return {db, tx};
}

// Flush pending macrotask commits (and the microtasks between them) so an
// asyncMemTx-backed test can await the durable state settling.
export async function awaitMacro(times = 60): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

type Op = {key: string; val?: {key: string}; del?: boolean};

// A recording object store: reads see the committed db plus this transaction's
// own not-yet-committed ops (put/delete), so a readwrite transaction is
// self-consistent while it runs. The ops are replayed onto the durable db only
// when the transaction COMMITS, and only the keys this transaction touched, so
// two overlapping commits never clobber each other's unrelated keys.
function makeRecordingStore(base: Map<string, {key: string}>, ops: Op[]): IDBObjectStore {
  const view = (): Map<string, {key: string}> => {
    const m = new Map(base);
    for (const op of ops) {
      if (op.del) m.delete(op.key);
      else if (op.val) m.set(op.key, op.val);
    }
    return m;
  };
  return {
    get: (k: string) => ({result: view().get(k)}) as unknown as IDBRequest,
    getAll: () => ({result: [...view().values()]}) as unknown as IDBRequest,
    getAllKeys: () => ({result: [...view().keys()]}) as unknown as IDBRequest,
    put: (v: {key: string}) => {
      ops.push({key: v.key, val: v});
      return {result: v.key} as unknown as IDBRequest;
    },
    delete: (k: string) => {
      ops.push({key: k, del: true});
      return {result: undefined} as unknown as IDBRequest;
    },
    clear: () => {
      for (const k of base.keys()) ops.push({key: k, del: true});
      return {result: undefined} as unknown as IDBRequest;
    }
  } as unknown as IDBObjectStore;
}

// A durable in-memory backing whose readwrite transactions can be told to ABORT
// after their requests have already succeeded, emulating the iOS Safari page
// freeze: the app swipes out, the requests reported success, but the
// transaction never commits and every write in it rolls back. A readonly read
// resolves on a microtask against committed state; a readwrite transaction
// applies on a macrotask and, when abort is armed, discards its ops and REJECTS
// (mirroring realTx, which resolves on transaction.oncomplete and rejects on
// onabort). This is what proves the stale-axis purge must resolve on commit, not
// on request success: a purge whose delete tx aborts must leave the store
// poisoned and let the next committed attach redo the heal.
export function abortableMemTx(): {
  db: Map<string, {key: string}>;
  tx: Tx;
  setAbort: (on: boolean) => void;
} {
  const db = new Map<string, {key: string}>();
  let abortNext = false;
  const tx: Tx = <T>(
    mode: IDBTransactionMode,
    run: (s: IDBObjectStore) => IDBRequest<T>
  ): Promise<T | null> => {
    if (mode === 'readonly') {
      return Promise.resolve().then(
        () => (run(makeStore(db)) as unknown as {result: T}).result ?? null
      );
    }
    const ops: Op[] = [];
    const result = (run(makeRecordingStore(db, ops)) as unknown as {result: T}).result ?? null;
    return new Promise<T | null>((resolve, reject) => {
      setTimeout(() => {
        if (abortNext) {
          reject(new Error('tx-abort'));
          return;
        }
        for (const op of ops) {
          if (op.del) db.delete(op.key);
          else if (op.val) db.set(op.key, op.val);
        }
        resolve(result);
      }, 0);
    });
  };
  return {db, tx, setAbort: (on: boolean) => (abortNext = on)};
}
