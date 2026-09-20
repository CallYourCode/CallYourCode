import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

/* The worker's side of the notification-avatar lane: pushes carry no icon
 * (sealed transport), so cyc-sw.js reads the page-written `cyc-avatars` store
 * by sessionId and falls back to the app logo when there is no row. Loaded the
 * same way cycSwSealed.test.ts loads the worker, with a minimal fake indexedDB
 * standing in for the stores the handler touches. */

type Row = Record<string, unknown>;
const dbs = new Map<string, Map<string, Row>>();
const rowsOf = (name: string) => {
  let m = dbs.get(name);
  if (!m) {
    m = new Map();
    dbs.set(name, m);
  }
  return m;
};

function fakeReq<T>(result: T): {result: T; onsuccess?: () => void; onerror?: () => void} {
  const r: {result: T; onsuccess?: () => void; onerror?: () => void} = {result};
  queueMicrotask(() => r.onsuccess?.());
  return r;
}

function fakeDb(name: string) {
  const rows = rowsOf(name);
  return {
    objectStoreNames: {contains: () => true},
    close: () => {},
    transaction: () => ({
      objectStore: () => ({
        get: (k: string) => fakeReq(rows.get(String(k))),
        getAll: () => fakeReq([...rows.values()]),
        put: (v: Row) => {
          rows.set(String(v.sessionId ?? v.tag), v);
          return fakeReq(undefined);
        },
        delete: (k: string) => {
          rows.delete(String(k));
          return fakeReq(undefined);
        }
      })
    })
  };
}

const fakeIndexedDb = {
  open: (name: string) => {
    const r: {
      result: unknown;
      onsuccess?: () => void;
      onerror?: () => void;
      onupgradeneeded?: () => void;
    } = {result: fakeDb(name)};
    queueMicrotask(() => r.onsuccess?.());
    return r;
  }
};

type SwGlobals = {
  cycNotifIcon: (sessionId: string) => Promise<string>;
};
type PushEvent = {data: {json: () => unknown}; waitUntil: (p: Promise<unknown>) => void};

let sw: SwGlobals;
let pushHandler: ((event: PushEvent) => void) | undefined;
const shown: Array<{title: string; opts: {icon?: string; tag?: string}}> = [];

beforeAll(() => {
  vi.stubGlobal('indexedDB', fakeIndexedDb);
  const code = readFileSync(resolve(process.cwd(), 'public/cyc-sw.js'), 'utf8');
  const fakeSelf: Record<string, unknown> = {
    addEventListener: (type: string, fn: (event: PushEvent) => void) => {
      if (type === 'push') pushHandler = fn;
    },
    navigator: {userAgent: 'vitest'},
    registration: {
      showNotification: (title: string, opts: {icon?: string; tag?: string}) => {
        shown.push({title, opts});
      },
      getNotifications: async (): Promise<unknown[]> => []
    },
    clients: {claim: async () => {}, matchAll: async (): Promise<unknown[]> => []},
    skipWaiting: () => {}
  };
  new Function('self', code)(fakeSelf);
  sw = fakeSelf as unknown as SwGlobals;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('service worker notification icons from the cyc-avatars store', () => {
  test('a stored row resolves to its data URI; a missing one to the app logo', async () => {
    rowsOf('cyc-avatars').set('sess-1', {
      sessionId: 'sess-1',
      icon: 'data:image/png;base64,AAA',
      key: 'photo:x',
      at: 1
    });
    await expect(sw.cycNotifIcon('sess-1')).resolves.toBe('data:image/png;base64,AAA');
    await expect(sw.cycNotifIcon('sess-unknown')).resolves.toBe('/pwa/icons/app-192.png');
    await expect(sw.cycNotifIcon('')).resolves.toBe('/pwa/icons/app-192.png');
  });

  test('a push for a session shows its avatar icon, not the generic logo', async () => {
    expect(pushHandler).toBeDefined();
    rowsOf('cyc-avatars').set('sess-2', {
      sessionId: 'sess-2',
      icon: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E',
      key: 'fallback:Relay',
      at: 1
    });
    shown.length = 0;
    let settled: Promise<unknown> = Promise.resolve();
    pushHandler!({
      data: {json: () => ({sessionId: 'sess-2', title: 'Relay', body: 'hi'})},
      waitUntil: (p) => {
        settled = p;
      }
    });
    await settled;
    expect(shown.length).toBe(1);
    expect(shown[0].opts.tag).toBe('sess-2');
    expect(shown[0].opts.icon).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E');
  });

  test('a push for an icon-less session keeps the app logo', async () => {
    shown.length = 0;
    let settled: Promise<unknown> = Promise.resolve();
    pushHandler!({
      data: {json: () => ({sessionId: 'sess-none', title: 'X', body: 'y'})},
      waitUntil: (p) => {
        settled = p;
      }
    });
    await settled;
    expect(shown.length).toBe(1);
    expect(shown[0].opts.icon).toBe('/pwa/icons/app-192.png');
  });
});
