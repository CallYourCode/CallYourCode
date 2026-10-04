// @vitest-environment node
import {beforeAll, describe, expect, test, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// THE STREAMED BROWSER DOWNLOAD, worker half (download-lane, 2026-10-03). The
// page opens a download with a MessagePort and points a hidden frame at
// /__cyc_dl/<id>/<name>; the worker answers that request with an attachment
// whose body the page feeds through the port, pull by pull. This drives the
// real cyc-sw.js message + fetch handlers with a real MessageChannel and a real
// ReadableStream: the bytes the browser reads are exactly the bytes the page
// fed, a cancel in the browser reaches the page, and nothing else under the
// prefix ever reaches the network (the app server would answer with the shell).

const ORIGIN = 'http://localhost';
type Handlers = Record<string, ((ev: unknown) => void)[]>;
let handlers: Handlers;
let fetched: string[];

beforeAll(() => {
  const code = readFileSync(resolve(process.cwd(), 'public/cyc-sw.js'), 'utf8');
  handlers = {};
  fetched = [];
  const fakeSelf: Record<string, unknown> = {
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      (handlers[type] ||= []).push(fn);
    },
    navigator: {userAgent: 'vitest'},
    location: {origin: ORIGIN},
    caches: {
      keys: async (): Promise<string[]> => [],
      open: async () => ({}),
      match: async (): Promise<undefined> => undefined
    },
    fetch: async (req: {url: string}) => {
      fetched.push(req.url);
      return new Response('network');
    },
    registration: {
      showNotification: () => {},
      getNotifications: async (): Promise<unknown[]> => []
    },
    clients: {claim: async () => {}, matchAll: async (): Promise<unknown[]> => []},
    skipWaiting: () => {}
  };
  new Function('self', code)(fakeSelf);
});

// Open a download the way the page does; resolve with the page's end of the port.
function open(id: string, name: string, size: number) {
  const ch = new MessageChannel();
  const got: Array<{t: string}> = [];
  ch.port1.onmessage = (ev) => got.push(ev.data);
  for (const h of handlers.message)
    h({data: {t: 'cyc-dl-open', id, name, size}, ports: [ch.port2]});
  return {port: ch.port1, got};
}

async function fire(url: string): Promise<Response | null> {
  let out: Promise<Response> | null = null;
  const event = {
    request: {url: ORIGIN + url, method: 'GET'},
    respondWith: (p: Promise<Response> | Response) => {
      out = Promise.resolve(p);
    }
  };
  for (const h of handlers.fetch) h(event);
  return out ? await out : null;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('service worker: a streamed browser download', () => {
  test('the attachment streams exactly the bytes the page feeds, as the browser pulls', async () => {
    const {port, got} = open('dl1', 'Boat licence pack.zip', 6);
    await tick();
    expect(got[0]?.t).toBe('ready');
    const res = (await fire('/__cyc_dl/dl1/Boat%20licence%20pack.zip'))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="Boat licence pack.zip"; filename*=UTF-8''Boat%20licence%20pack.zip`
    );
    expect(res.headers.get('content-length')).toBe('6');
    await tick();
    // the browser fetched it, and the stream asked the page for its first part
    expect(got.map((m) => m.t)).toContain('started');
    expect(got.filter((m) => m.t === 'pull').length).toBeGreaterThan(0);
    port.postMessage({t: 'chunk', bytes: new Uint8Array([1, 2, 3]).buffer});
    port.postMessage({t: 'chunk', bytes: new Uint8Array([4, 5, 6]).buffer});
    port.postMessage({t: 'end'});
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(fetched).toEqual([]);
    port.close();
  });

  test('a download is answered once; an unknown id is a 404, never the network', async () => {
    const {port} = open('dl2', 'a.bin', 0);
    await tick();
    expect((await fire('/__cyc_dl/dl2/a.bin'))!.status).toBe(200);
    expect((await fire('/__cyc_dl/dl2/a.bin'))!.status).toBe(404);
    expect((await fire('/__cyc_dl/never-opened/x.zip'))!.status).toBe(404);
    expect(fetched).toEqual([]);
    port.postMessage({t: 'abort'});
    port.close();
  });

  test('a cancel in the browser reaches the page; an abort from the page fails the body', async () => {
    const a = open('dl3', 'c.zip', 10);
    await tick();
    const res = (await fire('/__cyc_dl/dl3/c.zip'))!;
    await res.body!.cancel();
    await tick();
    expect(a.got.map((m) => m.t)).toContain('cancel');
    a.port.close();

    const b = open('dl4', 'd.zip', 10);
    await tick();
    const res2 = (await fire('/__cyc_dl/dl4/d.zip'))!;
    b.port.postMessage({t: 'abort', reason: 'no progress for 60 s'});
    await expect(res2.arrayBuffer()).rejects.toThrow(/no progress/);
    b.port.close();
  });

  test('a stream whose page went quiet (closed, crashed) fails instead of hanging in the download list', async () => {
    vi.useFakeTimers({toFake: ['setInterval', 'clearInterval', 'Date']});
    try {
      const {port} = open('dl5', 'e.zip', 10);
      const res = (await fire('/__cyc_dl/dl5/e.zip'))!;
      const body = res.arrayBuffer();
      let failed = false;
      body.catch(() => {
        failed = true;
      });
      port.postMessage({t: 'chunk', bytes: new Uint8Array([1, 2]).buffer});
      await tick();
      vi.advanceTimersByTime(30_000);
      // still alive: a keepalive within the window keeps it
      port.postMessage({t: 'alive'});
      await tick();
      vi.advanceTimersByTime(30_000);
      await tick();
      expect(failed, 'a page that keeps talking must not lose its download').toBe(false);
      // then nothing at all for 45 s: the page is gone
      vi.advanceTimersByTime(50_000);
      await expect(body).rejects.toThrow(/went away/);
      port.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
