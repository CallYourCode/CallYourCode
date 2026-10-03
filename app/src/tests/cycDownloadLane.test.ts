import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// THE DOWNLOAD LANE (download-lane, 2026-10-03). A shown file used to be one
// 13 MB tunnel answer: nothing measured it, nothing bounded it, the toast sat on
// "Downloading..." for minutes and a reload was the only way out. The lane pulls
// it as ranged parts with a deadline each, resumes from the last byte the sink
// took after a dropped pipe, and fails, visibly, when nothing moves.

const {EngineOffline, engineCapFetch, whenEngineReady} = vi.hoisted(() => ({
  EngineOffline: class EngineOffline extends Error {},
  engineCapFetch: vi.fn(),
  whenEngineReady: vi.fn(async () => true)
}));
vi.mock('../engine/contract', () => ({
  EngineOffline,
  engineCapFetch: (...a: unknown[]) => engineCapFetch(...a),
  whenEngineReady: (...a: unknown[]) => whenEngineReady(...(a as []))
}));

import {PART_BYTES, startDownload, type DownloadProgress} from '../engine/transfers/download';

const SIZE = PART_BYTES * 3 + 1234;
const BODY = new Uint8Array(SIZE).map((_, i) => (i * 13 + 5) % 251);

type Win = {__cycDownloadStallMs?: number; __cycDownloadPartMs?: number};

const rangeOf = (init: unknown) =>
  (init as {headers?: Record<string, string>} | undefined)?.headers?.range ?? '';

// The engine's 206 for one Range of BODY, as /doc/<id>/raw answers it.
function part(range: string) {
  const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]), SIZE - 1);
  const bytes = BODY.slice(start, end + 1);
  const headers: Record<string, string> = {
    'content-range': `bytes ${start}-${end}/${SIZE}`,
    'content-type': 'application/zip'
  };
  return {
    ok: true,
    status: 206,
    headers: {get: (k: string) => headers[k.toLowerCase()] ?? null},
    arrayBuffer: async () => bytes.slice().buffer
  };
}

// A sink that records every write in order (and copies: the real browser sink
// transfers the buffer away).
function sink() {
  const writes: Uint8Array[] = [];
  const s = {
    writes,
    closed: false,
    aborted: '' as string,
    write: vi.fn(async (b: Uint8Array) => {
      writes.push(b.slice());
    }),
    close: vi.fn(async () => {
      s.closed = true;
    }),
    abort: vi.fn((why: string) => {
      s.aborted = why;
    })
  };
  return s;
}
const joined = (w: Uint8Array[]) => {
  const out = new Uint8Array(w.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of w) {
    out.set(b, o);
    o += b.length;
  }
  return out;
};

beforeEach(() => {
  engineCapFetch.mockReset();
  whenEngineReady.mockReset();
  whenEngineReady.mockImplementation(async () => true);
});
afterEach(() => {
  delete (window as Win).__cycDownloadStallMs;
  delete (window as Win).__cycDownloadPartMs;
});

describe('download lane: ranged parts, in order, into the sink', () => {
  test('the whole file arrives in tunnel-chunk parts, written in order, exactly', async () => {
    engineCapFetch.mockImplementation(async (_u: string, init: unknown) => part(rangeOf(init)));
    const s = sink();
    const seen: DownloadProgress[] = [];
    const end = await startDownload({
      name: 'a.zip',
      url: 'doc://d/raw',
      size: SIZE,
      sink: s,
      onProgress: (p) => seen.push(p)
    }).done;
    expect(end.phase).toBe('done');
    expect(end.type).toBe('application/zip');
    expect(engineCapFetch.mock.calls.map((c) => rangeOf(c[1]))).toEqual([
      `bytes=0-${PART_BYTES - 1}`,
      `bytes=${PART_BYTES}-${2 * PART_BYTES - 1}`,
      `bytes=${2 * PART_BYTES}-${3 * PART_BYTES - 1}`,
      `bytes=${3 * PART_BYTES}-${SIZE - 1}`
    ]);
    expect(s.writes.map((w) => w.length)).toEqual([PART_BYTES, PART_BYTES, PART_BYTES, 1234]);
    expect(joined(s.writes)).toEqual(BODY);
    expect(s.closed).toBe(true);
    expect(seen.at(-1)).toMatchObject({phase: 'done', received: SIZE, total: SIZE});
  });

  test('a sink that transfers (detaches) each part still counts every byte', async () => {
    engineCapFetch.mockImplementation(async (_u: string, init: unknown) => part(rangeOf(init)));
    const s = sink();
    // what the browser sink does: postMessage with the buffer transferred away
    s.write.mockImplementation(async (b: Uint8Array) => {
      s.writes.push(b.slice());
      structuredClone(b.buffer, {transfer: [b.buffer]});
    });
    const end = await startDownload({name: 'a.zip', url: 'doc://d/raw', size: SIZE, sink: s}).done;
    expect(end).toMatchObject({phase: 'done', received: SIZE});
    expect(engineCapFetch).toHaveBeenCalledTimes(4);
  });
});

describe('download lane: a dropped pipe resumes from the bytes already saved', () => {
  test('the parts after the drop are asked again from the first missing byte, never twice written', async () => {
    let dropped = false;
    engineCapFetch.mockImplementation(async (_u: string, init: unknown) => {
      const r = rangeOf(init);
      if (!dropped && r.startsWith(`bytes=${2 * PART_BYTES}-`)) {
        dropped = true;
        throw new Error('tunnel: pipe closed (pipe closed)');
      }
      return part(r);
    });
    const s = sink();
    const phases: string[] = [];
    const end = await startDownload({
      name: 'a.zip',
      url: 'doc://d/raw',
      size: SIZE,
      sink: s,
      onProgress: (p) => {
        if (phases.at(-1) !== p.phase) phases.push(p.phase);
      }
    }).done;
    expect(end.phase).toBe('done');
    expect(phases).toEqual(['active', 'waiting', 'active', 'done']);
    expect(whenEngineReady).toHaveBeenCalled();
    // resumed exactly at the third part
    const asked = engineCapFetch.mock.calls.map((c) => rangeOf(c[1]));
    expect(asked.filter((r) => r.startsWith(`bytes=${2 * PART_BYTES}-`)).length).toBe(2);
    expect(asked.filter((r) => r.startsWith('bytes=0-')).length).toBe(1);
    expect(joined(s.writes)).toEqual(BODY);
  });
});

describe('download lane: never hangs', () => {
  test('an engine that never answers fails within the stall bound, and the sink is told', async () => {
    (window as Win).__cycDownloadPartMs = 30;
    (window as Win).__cycDownloadStallMs = 120;
    engineCapFetch.mockReturnValue(new Promise(() => {}));
    const s = sink();
    const t = Date.now();
    const end = await startDownload({name: 'a.zip', url: 'doc://d/raw', size: SIZE, sink: s}).done;
    expect(end.phase).toBe('failed');
    expect(end.reason).toMatch(/no progress/);
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(s.aborted).toMatch(/no progress/);
    expect(s.closed).toBe(false);
  });

  test('an engine that stays away fails once the stall bound is spent waiting for it', async () => {
    (window as Win).__cycDownloadStallMs = 100;
    engineCapFetch.mockRejectedValue(new EngineOffline('doc://d/raw'));
    whenEngineReady.mockImplementation(async () => false);
    const end = await startDownload({
      name: 'a.zip',
      url: 'doc://d/raw',
      size: SIZE,
      sink: sink()
    }).done;
    expect(end.phase).toBe('failed');
    expect(end.reason).toMatch(/did not come back/);
  });

  test('a file the engine does not have (404) fails at once, no retry', async () => {
    engineCapFetch.mockResolvedValue({ok: false, status: 404, headers: {get: (): null => null}});
    const end = await startDownload({name: 'a.zip', url: 'doc://d/raw', size: SIZE, sink: sink()})
      .done;
    expect(end.phase).toBe('failed');
    expect(whenEngineReady).not.toHaveBeenCalled();
  });

  test('a size that disagrees with the card is refused, not saved short', async () => {
    engineCapFetch.mockImplementation(async (_u: string, init: unknown) => part(rangeOf(init)));
    const s = sink();
    const end = await startDownload({name: 'a.zip', url: 'doc://d/raw', size: SIZE + 1, sink: s})
      .done;
    expect(end.phase).toBe('failed');
    expect(s.writes.length).toBe(0);
  });

  test('cancel cuts the parts in flight and tells the sink', async () => {
    engineCapFetch.mockReturnValue(new Promise(() => {}));
    const s = sink();
    const dl = startDownload({name: 'a.zip', url: 'doc://d/raw', size: SIZE, sink: s});
    await new Promise((r) => setTimeout(r, 0));
    const signals = engineCapFetch.mock.calls.map((c) => (c[1] as {signal: AbortSignal}).signal);
    dl.cancel();
    const end = await dl.done;
    expect(end.phase).toBe('cancelled');
    expect(s.aborted).toBe('cancelled');
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((sg) => sg.aborted)).toBe(true);
  });
});
