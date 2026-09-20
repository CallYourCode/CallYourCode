import {beforeAll, beforeEach, describe, expect, test, vi} from 'vitest';

/* Shown documents open offline: the receipt hook vaults a shown document the
 * moment its card is admitted while the engine is reachable (Fix 1), and the
 * viewers turn the capFetch offline throw into a humane, URL-free line (Fix 2).
 * A minimal in-memory IndexedDB stands in for the vault store so put/get are
 * proven at the row level, not on a spy. */

// A tiny functional IndexedDB covering exactly what showVault touches: a single
// keyPath:'key' store with put/get/getAll/delete/clear and a transaction that
// completes after the request succeeds (showVault waits on oncomplete for
// writes).
type Row = Record<string, unknown>;
const rows = new Map<string, Row>();
function req(result: unknown, txn?: {oncomplete?: (() => void) | null}) {
  const r: {
    result: unknown;
    transaction?: unknown;
    onsuccess?: (() => void) | null;
    onerror?: (() => void) | null;
  } = {
    result,
    transaction: txn
  };
  queueMicrotask(() => {
    r.onsuccess?.();
    if (txn) queueMicrotask(() => txn.oncomplete?.());
  });
  return r;
}
function objectStore(txn: {oncomplete?: (() => void) | null}) {
  return {
    put: (v: Row) => {
      rows.set(String(v.key), v);
      return req(v.key, txn);
    },
    get: (k: string) => req(rows.get(String(k)), txn),
    getAll: () => req([...rows.values()], txn),
    delete: (k: string) => {
      rows.delete(String(k));
      return req(undefined, txn);
    },
    clear: () => {
      rows.clear();
      return req(undefined, txn);
    }
  };
}
const fakeDb = {
  objectStoreNames: {contains: () => true},
  createObjectStore: () => objectStore({}),
  close: () => {},
  onversionchange: null as unknown,
  transaction: () => {
    const txn: {oncomplete?: (() => void) | null} = {};
    return {objectStore: () => objectStore(txn)};
  }
};
const fakeIndexedDb = {
  open: () => {
    const r: {
      result: unknown;
      onupgradeneeded?: (() => void) | null;
      onsuccess?: (() => void) | null;
      onerror?: (() => void) | null;
      onblocked?: (() => void) | null;
    } = {result: fakeDb};
    queueMicrotask(() => {
      r.onupgradeneeded?.();
      r.onsuccess?.();
    });
    return r;
  }
};
vi.stubGlobal('indexedDB', fakeIndexedDb);

const h = vi.hoisted(() => {
  class EngineOffline extends Error {
    constructor(readonly url: string) {
      super(`engine offline (no sealed transport): ${url}`);
      this.name = 'EngineOffline';
    }
  }
  return {
    EngineOffline,
    capFetch: vi.fn(),
    reachable: {v: true}
  };
});

vi.mock('../engine/contract', () => ({
  engineCapFetch: h.capFetch,
  EngineOffline: h.EngineOffline,
  docUrl: (id: string) => `doc://${id}`
}));

vi.mock('../engine/sync', () => ({
  engineReachable: () => h.reachable.v
}));

vi.mock('../engine/store/registry', () => ({
  connOf: () => ({client: {docUrl: (id: string) => `doc://${id}`}})
}));

import * as showVault from '../engine/showVault';
import {prefetchShownDoc} from '../engine/store/shownPrefetch';
import {openFileViewer} from '../features/media/fileViewer';
import {loadErrorText} from '../features/media/loadError';
import type {CycEngineSession} from '../engine/store/types';
import type {CycFileRef} from '../types';

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

const jsonRes = (body: unknown) => ({ok: true, status: 200, json: async () => body}) as unknown;

const session = (id: string): CycEngineSession =>
  ({id, engineKey: 'engine://1'}) as unknown as CycEngineSession;
const docCard = (docId: string): CycFileRef => ({
  docId,
  name: `${docId}.md`,
  fileKind: 'markdown',
  size: 0
});

beforeEach(() => {
  rows.clear();
  h.capFetch.mockReset();
  h.reachable.v = true;
});

describe('Fix 1: vault a shown document on receipt', () => {
  test('reachable receipt puts the doc, so a later vault get hits', async () => {
    h.capFetch.mockResolvedValue(
      jsonRes({name: 'audit.md', fileKind: 'markdown', content: '# hi'})
    );

    prefetchShownDoc(session('s1'), docCard('recv-hit'));
    await flush();

    expect(h.capFetch).toHaveBeenCalledTimes(1);
    const hit = await showVault.get('recv-hit');
    expect(hit?.content).toBe('# hi');
    expect(hit?.fileKind).toBe('markdown');
  });

  test('unreachable receipt neither fetches nor throws, leaving a vault miss', async () => {
    h.reachable.v = false;

    expect(() => prefetchShownDoc(session('s1'), docCard('recv-off'))).not.toThrow();
    await flush();

    expect(h.capFetch).not.toHaveBeenCalled();
    expect(await showVault.get('recv-off')).toBeNull();
  });

  test('an image card is left to its own blob path, not vaulted as a document', async () => {
    h.capFetch.mockResolvedValue(jsonRes({content: 'x'}));

    prefetchShownDoc(session('s1'), {docId: 'pic', name: 'p.png', fileKind: 'image', size: 1});
    await flush();

    expect(h.capFetch).not.toHaveBeenCalled();
    expect(await showVault.get('pic')).toBeNull();
  });

  test('a doc already in the vault is not fetched again on receipt', async () => {
    await showVault.put({
      key: 'have',
      sessionId: 's1',
      name: 'h.md',
      fileKind: 'markdown',
      content: 'held'
    });
    await flush();

    prefetchShownDoc(session('s1'), docCard('have'));
    await flush();

    expect(h.capFetch).not.toHaveBeenCalled();
  });

  test('a card-heavy attach never runs more than 3 tunneled fetches at once', async () => {
    // Instrument the mock fetch with a live concurrency counter: each call
    // holds the tunnel open until we release it, so the peak is real and not a
    // scheduling artifact.
    let live = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    h.capFetch.mockImplementation((url: string) => {
      live++;
      peak = Math.max(peak, live);
      const id = String(url).replace('doc://', '');
      return new Promise((resolve) => {
        gates.push(() => {
          live--;
          resolve(jsonRes({name: `${id}.md`, fileKind: 'markdown', content: id}));
        });
      });
    });

    const ids = Array.from({length: 10}, (_, i) => `burst-${i}`);
    for (const id of ids) prefetchShownDoc(session('s1'), docCard(id));

    // Drain the queue: flush so parked/queued fetches settle, then release the
    // oldest so the pool admits the next. The live counter must never top 3.
    // (flush first, because each task awaits get() before it reaches the fetch.)
    for (let guard = 0; guard < 100; guard++) {
      await flush();
      expect(peak).toBeLessThanOrEqual(3);
      if (!gates.length && !live) break;
      const next = gates.shift();
      if (next) next();
    }
    await flush();

    expect(peak).toBeLessThanOrEqual(3);
    expect(h.capFetch).toHaveBeenCalledTimes(10);
    for (const id of ids) {
      const hit = await showVault.get(id);
      expect(hit?.content).toBe(id);
    }
  });

  test('the same doc prefetched twice concurrently shares exactly one fetch', async () => {
    h.capFetch.mockResolvedValue(jsonRes({name: 'dupe.md', fileKind: 'markdown', content: 'once'}));

    prefetchShownDoc(session('s1'), docCard('dupe'));
    prefetchShownDoc(session('s2'), docCard('dupe'));
    await flush();

    expect(h.capFetch).toHaveBeenCalledTimes(1);
    const hit = await showVault.get('dupe');
    expect(hit?.content).toBe('once');
  });
});

async function openDocViewer(file: CycFileRef): Promise<HTMLElement> {
  document.body.innerHTML = '';
  const stage = document.createElement('div');
  stage.id = 'cyc-stage';
  document.body.append(stage);
  openFileViewer(file, undefined, 's1');
  await flush();
  return stage;
}

describe('Fix 2: humane offline error in the viewer', () => {
  test('offline open of an unvaulted doc shows the friendly line with no URL', async () => {
    h.capFetch.mockRejectedValue(new h.EngineOffline('http://127.0.0.1:10101/doc/gone'));

    const stage = await openDocViewer(docCard('gone'));
    const err = stage.querySelector('.cyc-fv-error') as HTMLElement;
    expect(err).toBeTruthy();
    expect(err.textContent).toContain("You're offline");
    expect(err.textContent?.toLowerCase()).not.toContain('http');
    expect(err.textContent).not.toContain('127.0.0.1');
  });

  test('offline open of a vaulted doc still renders its content', async () => {
    await showVault.put({
      key: 'saved',
      sessionId: 's1',
      name: 'saved.md',
      fileKind: 'text',
      content: 'from the device vault'
    });
    await flush();
    h.capFetch.mockRejectedValue(new h.EngineOffline('http://127.0.0.1:10101/doc/saved'));

    const stage = await openDocViewer({
      docId: 'saved',
      name: 'saved.md',
      fileKind: 'text',
      size: 0
    });
    expect(stage.querySelector('.cyc-fv-error')).toBeNull();
    expect(h.capFetch).not.toHaveBeenCalled();
    const pre = stage.querySelector('.cyc-fv-text') as HTMLElement;
    expect(pre?.textContent).toBe('from the device vault');
  });

  test('a non-offline failure keeps a concise reason without a raw URL', () => {
    const text = loadErrorText('report.md', new Error('HTTP 500'));
    expect(text).toBe('Could not load report.md (HTTP 500)');
    expect(text.toLowerCase()).not.toContain('http://');
  });
});
