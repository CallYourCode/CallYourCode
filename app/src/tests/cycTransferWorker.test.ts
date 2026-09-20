import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// The rows store is an in-memory stand-in here (no IndexedDB in jsdom); every
// worker step reads and writes through it, so the test inspects final state.
const store = new Map<string, import('../engine/transfers/rows').TransferRow>();
let hydrateRows: import('../engine/transfers/rows').TransferRow[] = [];
vi.mock('../engine/transfers/rows', () => ({
  all: () => [...store.values()].sort((a, b) => a.createdAt - b.createdAt),
  get: (k: string) => store.get(k),
  put: (r: import('../engine/transfers/rows').TransferRow) => {
    r.updatedAt = Date.now();
    store.set(r.key, r);
  },
  remove: (k: string) => store.delete(k),
  hydrate: async () => {
    for (const r of hydrateRows) store.set(r.key, r);
    return [...store.values()];
  },
  heldKeys: () => new Set<string>()
}));

vi.mock('../audio/clipVault', () => ({
  park: vi.fn(async () => 'k'),
  get: vi.fn(async () => undefined),
  release: vi.fn(async () => {})
}));

// The image cache write is observed, not performed (no IndexedDB in jsdom).
vi.mock('../features/media/imageCache', () => ({
  putImage: vi.fn(),
  cachedImageUrl: vi.fn(async () => null)
}));

// The intent drain is proven on its own; here only that a definitive refusal
// of a row fails the owning intent (drain.fail) is recorded.
const outboxFailed: string[] = [];
vi.mock('../engine/sync/drain', () => ({
  fail: (id: string): void => {
    outboxFailed.push(id);
  },
  kick: (): void => {}
}));

import * as clipVault from '../audio/clipVault';
import {putImage} from '../features/media/imageCache';
import * as rows from '../engine/transfers/rows';
import type {TransferRow} from '../engine/transfers/rows';
import {conns, sessions, type Conn} from '../engine/store/registry';
import {
  wake,
  enqueue,
  enqueued,
  hydrateTransfers,
  prune,
  cancel,
  reclaim,
  __resetForTest,
  CHUNK,
  MAX_OUTSTANDING,
  STEP_DEADLINE_MS
} from '../engine/transfers/worker';
import type {CycEngineMessage, CycEngineSession} from '../engine/store';
import * as sync from '../engine/sync';

const KEY = 'ws://xfer-engine.test:9000/ws';
const SID = KEY + '|p1';

type FakeClient = {
  transferBegin: ReturnType<typeof vi.fn>;
  transferPut: ReturnType<typeof vi.fn>;
  transferGet: ReturnType<typeof vi.fn>;
  transferFinish: ReturnType<typeof vi.fn>;
  transferDelete?: ReturnType<typeof vi.fn>;
  tunnelDrain: ReturnType<typeof vi.fn>;
  uploadUrl: ReturnType<typeof vi.fn>;
};

function plantSession(): CycEngineSession {
  const s = {
    id: SID,
    engineKey: KEY,
    paneId: 'p1',
    tabKey: '',
    name: 'p1',
    cwd: '',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [] as CycEngineMessage[],
    claudeSessionId: null,
    events: [],
    agentRuns: []
  } as unknown as CycEngineSession;
  sessions.set(s.id, s);
  return s;
}

function plantConn(state: Conn['state'], client: FakeClient): Conn {
  const conn = {
    key: KEY,
    state,
    failed: false,
    user: 'u',
    host: 'h',
    hostname: 'h',
    tabs: [],
    plugins: [],
    voiceHealthy: true,
    helloSettled: true,
    client
  } as unknown as Conn;
  conns.push(conn);
  // A planted 'connected' conn is a settled engine in the sync manager's eyes.
  if (state === 'connected') {
    sync.noteSealed(KEY);
    sync.noteHost(KEY);
    sync.noteSessions(KEY);
  }
  return conn;
}

function fakeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    transferBegin: vi.fn(async () => ({id: 'xid', chunk: CHUNK, have: [] as number[]})),
    transferPut: vi.fn(async () => ({have: [] as number[]})),
    transferGet: vi.fn(async () => ({have: [] as number[], size: 0, chunk: CHUNK, done: false})),
    transferFinish: vi.fn(async () => ({ok: true, status: 200, body: {msgId: 'srv-1'}})),
    // A real drain gate on every client: with no throttle it resolves at once,
    // so the pipelined loop's backpressure await is exercised in every test, not
    // left as an undefined no-op. The throttled-channel suite plants one that
    // gates.
    tunnelDrain: vi.fn(async () => {}),
    uploadUrl: vi.fn(
      (id: string) => 'http://xfer-engine.test:9000/upload/' + encodeURIComponent(id)
    ),
    ...over
  };
}

// Two chunks: a blob just over one CHUNK. jsdom Blob has no arrayBuffer(), which
// the worker's sha256 needs, so we attach one (a real browser Blob has it).
const twoChunkBlob = (type = 'audio/webm') => {
  const arr = new Uint8Array(CHUNK + 100);
  const b = new Blob([arr], {type});
  (b as unknown as {arrayBuffer: () => Promise<ArrayBuffer>}).arrayBuffer = async () =>
    arr.buffer as ArrayBuffer;
  return b;
};

// A blob of exactly n chunks (the last one short), for the pipelining proofs.
const nChunkBlob = (n: number, type = 'audio/webm') => {
  const size = Math.max(0, n - 1) * CHUNK + 100;
  const arr = new Uint8Array(size);
  const b = new Blob([arr], {type});
  (b as unknown as {arrayBuffer: () => Promise<ArrayBuffer>}).arrayBuffer = async () =>
    arr.buffer as ArrayBuffer;
  return b;
};
const nChunkSize = (n: number) => Math.max(0, n - 1) * CHUNK + 100;

function row(over: Partial<TransferRow> = {}): TransferRow {
  const now = Date.now();
  return {
    key: 'c1',
    sessionId: SID,
    kind: 'user-audio',
    blobKey: 'c1',
    size: CHUNK + 100,
    mime: 'audio/webm',
    sha256: 'ab',
    chunk: CHUNK,
    acked: [],
    state: 'queued',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    ...over
  };
}

// let the microtasks the worker chains settle (advanceTimers also drains the
// promise queue, so a crypto/FileReader resolve that is not a bare microtask
// still lands)
const flush = async () => {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
};

// Seed a queued row straight into the store (skipping enqueue's async sha, whose
// real path is covered end to end by the playwright spec) and wake the worker.
function seed(r: TransferRow): void {
  store.set(r.key, r);
  wake();
}

describe('transfer worker', () => {
  let conn: Conn;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    store.clear();
    hydrateRows = [];
    outboxFailed.length = 0;
    sessions.clear();
    conns.length = 0;
    __resetForTest();
    sync.__resetLiveForTest();
    (window as unknown as {__cycTransferBackoffMs?: number}).__cycTransferBackoffMs = 5;
    plantSession();
  });
  afterEach(() => {
    vi.useRealTimers();
    conns.length = 0;
    sessions.clear();
    delete (window as unknown as {__cycTransferBackoffMs?: number}).__cycTransferBackoffMs;
  });

  test('resumes from acked after hydrate: GET resyncs, only the missing chunk is PUT', async () => {
    // A row left mid-flight before a reload: id known, chunk 0 already acked.
    const client = fakeClient({
      transferGet: vi.fn(async () => ({have: [0], size: CHUNK + 100, chunk: CHUNK, done: false})),
      transferPut: vi.fn(async () => ({have: [0, 1]}))
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);
    hydrateRows = [row({id: 'xid', acked: [0]})];

    await hydrateTransfers();
    await flush();

    // begin is NOT called (id already known); GET resyncs have first...
    expect(client.transferBegin).not.toHaveBeenCalled();
    expect(client.transferGet).toHaveBeenCalledWith('xid', expect.anything());
    // ...then only the missing chunk (1) is PUT, never chunk 0 again.
    expect(client.transferPut).toHaveBeenCalledTimes(1);
    expect(client.transferPut.mock.calls[0][1]).toBe(1);
    expect(client.transferFinish).toHaveBeenCalledTimes(1);
    expect(store.get('c1')!.state).toBe('done');
  });

  test('re-begin after a lost reply reads the engine have and PUTs only the missing chunks', async () => {
    // The first begin's reply was lost on a flap: the row has no id, but the
    // engine holds chunk 0 already. The re-begin is idempotent on the content
    // id and reports have=[0]; only chunk 1 moves, chunk 0 never goes again.
    const client = fakeClient({
      transferBegin: vi.fn(async () => ({id: 'xid', chunk: CHUNK, have: [0]})),
      transferPut: vi.fn(async () => ({have: [0, 1]}))
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);
    seed(row());
    await flush();
    expect(client.transferBegin).toHaveBeenCalledTimes(1);
    expect(client.transferPut).toHaveBeenCalledTimes(1);
    expect(client.transferPut.mock.calls[0][1]).toBe(1);
    expect(client.transferFinish).toHaveBeenCalledTimes(1);
    expect(store.get('c1')!.state).toBe('done');

    // And a fresh transfer (the engine has nothing) still sends every chunk.
    store.clear();
    conns.length = 0;
    const client2 = fakeClient({
      transferBegin: vi.fn(async () => ({id: 'xid2', chunk: CHUNK, have: []})),
      transferPut: vi.fn(async (_id: string, n: number) => ({have: n === 0 ? [0] : [0, 1]}))
    });
    conn = plantConn('connected', client2);
    seed(row({key: 'c2', blobKey: 'c2'}));
    await flush();
    expect(client2.transferPut.mock.calls.map((c) => c[1])).toEqual([0, 1]);
    expect(store.get('c2')!.state).toBe('done');
  });

  test('the connected edge outruns the backoff: a queued row retries at once and its attempts reset', async () => {
    // A long backoff, so only the edge (never the timer) can drive a retry
    // inside this test.
    (window as unknown as {__cycTransferBackoffMs?: number}).__cycTransferBackoffMs = 10_000;
    let begins = 0;
    const client = fakeClient({
      transferBegin: vi.fn(async () => {
        begins++;
        if (begins <= 2) throw new Error('pipe died under the begin');
        return {id: 'xid', chunk: CHUNK, have: []};
      }),
      transferPut: vi.fn(async (_id: string, n: number) => ({have: n === 0 ? [0] : [0, 1]}))
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);

    seed(row());
    await flush();
    // First attempt failed: queued behind a 10 s backoff.
    expect(client.transferBegin).toHaveBeenCalledTimes(1);
    expect(store.get('c1')!.state).toBe('queued');
    expect(store.get('c1')!.attempts).toBe(1);

    // The pipe flaps: down, then settled again. No timer time passes, yet the
    // edge clears the backoff and retries now.
    sync.noteDown(KEY);
    sync.noteSealed(KEY);
    sync.noteHost(KEY);
    sync.noteSessions(KEY);
    await flush();
    expect(client.transferBegin).toHaveBeenCalledTimes(2);
    // The edge reset attempts to 0 before the retry; its own failure set 1
    // again (without the reset it would read 2).
    expect(store.get('c1')!.attempts).toBe(1);

    // A second edge retries again, and this one lands.
    sync.noteDown(KEY);
    sync.noteSealed(KEY);
    sync.noteHost(KEY);
    sync.noteSessions(KEY);
    await flush();
    expect(client.transferBegin).toHaveBeenCalledTimes(3);
    expect(store.get('c1')!.state).toBe('done');
  });

  test('the disconnected edge cuts the step in flight; the reconnect resumes from the engine acked chunks', async () => {
    const puts: number[] = [];
    let hang = true;
    const client = fakeClient({
      transferBegin: vi.fn(async () => ({id: 'xid', chunk: CHUNK, have: []})),
      transferPut: vi.fn((_id: string, n: number) => {
        puts.push(n);
        if (hang && n === 1) return new Promise<{have: number[]}>(() => {}); // dies on the wire
        return Promise.resolve({have: n === 0 ? [0] : [0, 1]});
      }),
      transferGet: vi.fn(async () => ({have: [0], size: CHUNK + 100, chunk: CHUNK, done: false}))
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);

    seed(row());
    await flush();
    // Chunk 0 acked, chunk 1 in flight and hanging on a dead pipe.
    expect(store.get('c1')!.state).toBe('active');
    expect(store.get('c1')!.acked).toEqual([0]);

    // The pipe is known dead: the edge cuts the step at once, no 30 s wait,
    // and the row parks queued with its id and acked kept.
    hang = false;
    sync.noteDown(KEY);
    await flush();
    expect(store.get('c1')!.state).toBe('queued');
    expect(store.get('c1')!.id).toBe('xid');
    expect(store.get('c1')!.acked).toEqual([0]);

    // Reconnect: the GET resyncs have from the engine and only the missing
    // chunk goes again; chunk 0 is never re-PUT.
    sync.noteSealed(KEY);
    sync.noteHost(KEY);
    sync.noteSessions(KEY);
    await flush();
    expect(client.transferGet).toHaveBeenCalledTimes(1);
    expect(puts).toEqual([0, 1, 1]);
    expect(store.get('c1')!.state).toBe('done');
  });

  test('no polling while offline; the connected-edge wake drives it', async () => {
    const client = fakeClient();
    conn = plantConn('disconnected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);

    seed(row());
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    // Offline: nothing was attempted and no timer polls for a reconnect.
    expect(client.transferBegin).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    // The connected edge comes from the sync module (sealed AND host AND
    // sessions landed), which the worker subscribes to; nothing else wakes it.
    conn.state = 'connected';
    conn.helloSettled = false;
    sync.noteSealed(conn.key);
    sync.noteHost(conn.key);
    await flush();
    expect(client.transferBegin).not.toHaveBeenCalled(); // not settled yet
    conn.helloSettled = true;
    sync.noteSessions(conn.key);
    await flush();
    await flush();
    expect(client.transferBegin).toHaveBeenCalledTimes(1);
    expect(client.transferFinish).toHaveBeenCalledTimes(1);
  });

  test('vault bytes are released only after finish succeeds', async () => {
    let resolveFinish!: (v: {ok: boolean; status: number; body: unknown}) => void;
    const client = fakeClient({
      transferBegin: vi.fn(async () => ({id: 'xid', chunk: CHUNK, have: []})),
      transferPut: vi.fn(async (_id: string, n: number) => ({have: [n]})),
      transferFinish: vi.fn(
        () => new Promise<{ok: boolean; status: number; body: unknown}>((r) => (resolveFinish = r))
      )
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);

    seed(row());
    await flush();
    // Chunks moved, finish pending: the recording is NOT released yet.
    expect(client.transferFinish).toHaveBeenCalled();
    expect(vi.mocked(clipVault.release)).not.toHaveBeenCalled();

    resolveFinish({ok: true, status: 200, body: {msgId: 'srv-1'}});
    await flush();
    // ...and it is the worker's own release (byTransfer), the one the vault
    // accepts for a key a transfer holds.
    expect(vi.mocked(clipVault.release)).toHaveBeenCalledWith(
      'c1',
      expect.any(String),
      expect.any(Object),
      {byTransfer: true}
    );
    expect(store.get('c1')!.result).toMatchObject({msgId: 'srv-1'});
  });

  // Own image bytes go into the image cache at finish, keyed by the engine
  // URL the echoed message resolves to (client.uploadUrl), BEFORE the vault
  // releases them: a reload paints the bubble from the cache, no fetch.
  test('a finished image upload is written to the image cache under its engine URL before the vault release', async () => {
    const order: string[] = [];
    vi.mocked(putImage).mockImplementationOnce(() => {
      order.push('cache');
    });
    vi.mocked(clipVault.release).mockImplementationOnce(async () => {
      order.push('release');
      return true;
    });
    const client = fakeClient({
      transferFinish: vi.fn(async () => ({
        ok: true,
        status: 200,
        body: {uploadId: 'srv-up-7', name: 'shot.png', mime: 'image/png', size: CHUNK + 100}
      }))
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob('image/png')} as never);

    seed(row({kind: 'upload', mime: 'image/png', name: 'shot.png'}));
    await flush();

    expect(store.get('c1')!.state).toBe('done');
    expect(putImage).toHaveBeenCalledTimes(1);
    const [url, blob] = vi.mocked(putImage).mock.calls[0];
    expect(url).toBe('http://xfer-engine.test:9000/upload/srv-up-7');
    expect(client.uploadUrl).toHaveBeenCalledWith('srv-up-7');
    expect(blob.size).toBe(CHUNK + 100);
    expect(blob.type).toBe('image/png');
    expect(order).toEqual(['cache', 'release']);
  });

  test('no image cache write for a voice note or a non-image upload', async () => {
    conn = plantConn('connected', fakeClient());
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);
    seed(row());
    await flush();
    expect(store.get('c1')!.state).toBe('done');
    expect(putImage).not.toHaveBeenCalled();

    const client = fakeClient({
      transferFinish: vi.fn(async () => ({
        ok: true,
        status: 200,
        body: {uploadId: 'srv-up-8', name: 'notes.pdf', mime: 'application/pdf', size: CHUNK + 100}
      }))
    });
    conns.length = 0;
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob('application/pdf')} as never);
    seed(
      row({key: 'c2', blobKey: 'c2', kind: 'upload', mime: 'application/pdf', name: 'notes.pdf'})
    );
    await flush();
    expect(store.get('c2')!.state).toBe('done');
    expect(putImage).not.toHaveBeenCalled();
  });

  test('gone only on a definitive 4xx (size cap), and it releases the bytes', async () => {
    const err = Object.assign(new Error('too large'), {status: 413});
    const client = fakeClient({transferBegin: vi.fn(async () => Promise.reject(err))});
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);

    seed(row());
    await flush();
    const r = store.get('c1')!;
    expect(r.state).toBe('gone');
    expect(vi.mocked(clipVault.release)).toHaveBeenCalled();
    // The owning intent is failed with it (definitive on disk).
    expect(outboxFailed).toEqual(['c1']);
  });

  for (const status of [400, 422]) {
    test(`a ${status} from the transfer routes is gone too`, async () => {
      const err = Object.assign(new Error('refused'), {status});
      const client = fakeClient({
        transferPut: vi.fn(async () => Promise.reject(err))
      });
      conn = plantConn('connected', client);
      vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);
      seed(row());
      await flush();
      expect(store.get('c1')!.state).toBe('gone');
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  test("the fronted route's own 4xx at finish (x-cyc-fronted) is gone; 409 is a resync", async () => {
    // 415 is /upload's own refusal, handed back through finish verbatim and
    // marked fronted by the engine's x-cyc-fronted: 1 header.
    const client = fakeClient({
      transferPut: vi.fn(async (_id: string, n: number) => ({have: [n]})),
      transferFinish: vi.fn(async () => ({
        ok: false,
        status: 415,
        body: {error: 'bad type'},
        fronted: true
      }))
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);
    seed(row({kind: 'upload'}));
    await flush();
    expect(store.get('c1')!.state).toBe('gone');
    expect(outboxFailed).toEqual(['c1']);

    // 409 (engine says incomplete): never gone; backs off, GET resyncs, done.
    store.clear();
    outboxFailed.length = 0;
    let fin = 0;
    const client2 = fakeClient({
      transferPut: vi.fn(async (_id: string, n: number) => ({have: [n]})),
      transferGet: vi.fn(async () => ({have: [0], size: CHUNK + 100, chunk: CHUNK, done: false})),
      transferFinish: vi.fn(async () => {
        fin++;
        return fin === 1
          ? {ok: false, status: 409, body: null}
          : {ok: true, status: 200, body: {msgId: 'm'}};
      })
    });
    conns.length = 0;
    conn = plantConn('connected', client2);
    seed(row({key: 'c2', blobKey: 'c2'}));
    await flush();
    expect(store.get('c2')!.state).toBe('queued');
    await vi.advanceTimersByTimeAsync(50);
    await flush();
    expect(client2.transferGet).toHaveBeenCalledTimes(1);
    expect(store.get('c2')!.state).toBe('done');
    expect(outboxFailed).toEqual([]);
  });

  for (const status of [401, 403, 429]) {
    test(`a ${status} at finish WITHOUT x-cyc-fronted is the transfer route's own: retried, never gone`, async () => {
      let fin = 0;
      const client = fakeClient({
        transferPut: vi.fn(async (_id: string, n: number) => ({have: [n]})),
        transferFinish: vi.fn(async () => {
          fin++;
          return fin === 1
            ? {ok: false, status, body: {error: 'not now'}, fronted: false}
            : {ok: true, status: 200, body: {msgId: 'srv-3'}, fronted: true};
        })
      });
      conn = plantConn('connected', client);
      vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);
      seed(row());
      await flush();
      expect(store.get('c1')!.state).toBe('queued');
      expect(outboxFailed).toEqual([]);
      expect(vi.mocked(clipVault.release)).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50);
      await flush();
      expect(store.get('c1')!.state).toBe('done');
      expect(client.transferFinish).toHaveBeenCalledTimes(2);
    });
  }

  test('a 422 at finish is gone even without the fronted mark; a fronted 4xx of any code is gone', async () => {
    const client = fakeClient({
      transferPut: vi.fn(async (_id: string, n: number) => ({have: [n]})),
      transferFinish: vi.fn(async () => ({
        ok: false,
        status: 422,
        body: {error: 'hash mismatch'},
        fronted: false
      }))
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);
    seed(row());
    await flush();
    expect(store.get('c1')!.state).toBe('gone');
    expect(outboxFailed).toEqual(['c1']);

    store.clear();
    outboxFailed.length = 0;
    conns.length = 0;
    const client2 = fakeClient({
      transferPut: vi.fn(async (_id: string, n: number) => ({have: [n]})),
      transferFinish: vi.fn(async () => ({
        ok: false,
        status: 429,
        body: {error: 'slow down'},
        fronted: true
      }))
    });
    conn = plantConn('connected', client2);
    seed(row({key: 'c2', blobKey: 'c2'}));
    await flush();
    expect(store.get('c2')!.state).toBe('gone');
    expect(outboxFailed).toEqual(['c2']);
  });

  test('prune removes done and gone rows of the settled message only, never live ones', async () => {
    const now = Date.now();
    store.set('v1', row({key: 'v1', blobKey: 'v1', state: 'done', createdAt: now}));
    store.set(
      'a1',
      row({
        key: 'a1',
        blobKey: 'a1',
        kind: 'upload',
        ownerCid: 'm1',
        state: 'done',
        createdAt: now + 1
      })
    );
    store.set(
      'a2',
      row({
        key: 'a2',
        blobKey: 'a2',
        kind: 'upload',
        ownerCid: 'm1',
        state: 'gone',
        createdAt: now + 2
      })
    );
    store.set(
      'a3',
      row({
        key: 'a3',
        blobKey: 'a3',
        kind: 'upload',
        ownerCid: 'm1',
        state: 'queued',
        createdAt: now + 3
      })
    );
    store.set(
      'o1',
      row({
        key: 'o1',
        blobKey: 'o1',
        kind: 'upload',
        ownerCid: 'm2',
        state: 'done',
        createdAt: now + 4
      })
    );

    // the voice note's own key is its cid
    expect(prune('v1')).toBe(1);
    expect(store.has('v1')).toBe(false);
    // the attachment message: its done + gone rows go, the queued one stays
    expect(prune('m1')).toBe(2);
    expect([...store.keys()].sort()).toEqual(['a3', 'o1']);
    // another message's rows are untouched, and a second prune is a no-op
    expect(prune('m1')).toBe(0);
    expect(store.has('o1')).toBe(true);
  });

  test('cancel removes queued AND active rows of the discarded message, releases their bytes, DELETEs a begun id', async () => {
    const client = fakeClient({transferDelete: vi.fn(async () => {})});
    conn = plantConn('connected', client);
    const now = Date.now();
    // A voice note still queued (engine was offline when it was discarded).
    store.set('v1', row({key: 'v1', blobKey: 'v1', state: 'queued', createdAt: now}));
    // An attachment message: one row active with an engine id, one queued, one done.
    store.set(
      'a1',
      row({
        key: 'a1',
        blobKey: 'a1',
        kind: 'upload',
        ownerCid: 'm1',
        state: 'active',
        id: 'xa1',
        createdAt: now + 1
      })
    );
    store.set(
      'a2',
      row({
        key: 'a2',
        blobKey: 'a2',
        kind: 'upload',
        ownerCid: 'm1',
        state: 'queued',
        createdAt: now + 2
      })
    );
    store.set(
      'a3',
      row({
        key: 'a3',
        blobKey: 'a3',
        kind: 'upload',
        ownerCid: 'm1',
        state: 'done',
        createdAt: now + 3
      })
    );
    // Another message's queued row must be untouched.
    store.set(
      'o1',
      row({
        key: 'o1',
        blobKey: 'o1',
        kind: 'upload',
        ownerCid: 'm2',
        state: 'queued',
        createdAt: now + 4
      })
    );

    expect(cancel('v1')).toBe(1);
    expect(store.has('v1')).toBe(false);
    expect(vi.mocked(clipVault.release)).toHaveBeenCalledWith(
      'v1',
      expect.any(String),
      expect.any(Object),
      {byTransfer: true}
    );

    expect(cancel('m1')).toBe(3);
    expect([...store.keys()].sort()).toEqual(['o1']);
    // The live rows' bytes are released by the worker's own release; the done
    // row released its bytes at finish already, so it is not released again.
    const released = vi
      .mocked(clipVault.release)
      .mock.calls.map((c) => c[0])
      .sort();
    expect(released).toEqual(['a1', 'a2', 'v1']);
    // Only the row the engine had begun gets a DELETE, once.
    expect(client.transferDelete).toHaveBeenCalledTimes(1);
    expect(client.transferDelete).toHaveBeenCalledWith('xa1');
    // A second cancel is a no-op; the other message's row is untouched.
    expect(cancel('m1')).toBe(0);
    expect(store.get('o1')!.state).toBe('queued');
  });

  test('cancel under an in-flight chunk: the worker stops, PUTs no more chunks, never finishes', async () => {
    // Chunk 0 is held in the air; the pipelined chunk 1 resolves at once. The
    // worker keeps both segments outstanding, so a cancel must stop it and the
    // late resolve of the held chunk must never drive a finish.
    let resolvePut!: (v: {have: number[]}) => void;
    let held = false;
    const client = fakeClient({
      transferPut: vi.fn(
        (_id: string, n: number) =>
          new Promise<{have: number[]}>((r) => {
            if (n === 0 && !held) {
              held = true;
              resolvePut = r;
            } else r({have: [n]});
          })
      ),
      transferDelete: vi.fn(async () => {})
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);
    seed(row());
    await flush();
    // Both segments were fired (pipelined); chunk 0 is still in the air.
    expect(client.transferPut).toHaveBeenCalledTimes(2);
    expect(store.get('c1')!.state).toBe('active');
    expect(store.get('c1')!.id).toBe('xid');

    // The note is discarded while chunk 0 is still in the air.
    expect(cancel('c1')).toBe(1);
    expect(store.has('c1')).toBe(false);
    expect(client.transferDelete).toHaveBeenCalledWith('xid');

    // The held chunk lands late: the worker notices the row is gone and stops.
    resolvePut({have: [0]});
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(client.transferPut).toHaveBeenCalledTimes(2); // no more segments went
    expect(client.transferFinish).not.toHaveBeenCalled();
    // ...and the row is not written back (a put would resurrect it).
    expect(store.has('c1')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // The worker's slot is free again: a fresh row moves as normal.
    seed(row({key: 'c2', blobKey: 'c2'}));
    await flush();
    expect(store.get('c2')!.state).toBe('done');
  });

  test('cancel ABORTS the step in flight at once (the chunk PUT is cut, not waited out)', async () => {
    // Every PUT observes its AbortSignal, as a real fetch does: it settles only
    // by abort. All the pipelined segments are outstanding at once, so a cancel
    // must cut ALL their signals now, not just one, and not wait out any
    // deadline.
    const putSignals: AbortSignal[] = [];
    const client = fakeClient({
      transferPut: vi.fn(
        (_id: string, _n: number, _b: Blob, opts?: {signal?: AbortSignal}) =>
          new Promise<{have: number[]}>((_r, reject) => {
            if (opts?.signal) putSignals.push(opts.signal);
            opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true
            });
          })
      ),
      transferDelete: vi.fn(async () => {})
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);
    seed(row());
    await flush();
    // Both segments are in the air; neither signal is cut yet.
    expect(client.transferPut).toHaveBeenCalledTimes(2);
    expect(putSignals).toHaveLength(2);
    expect(putSignals.every((s) => !s.aborted)).toBe(true);

    expect(cancel('c1')).toBe(1);
    // EVERY in-flight request's signal is cut NOW, not at any step deadline.
    expect(putSignals.every((s) => s.aborted)).toBe(true);
    await flush();
    // Nothing more moved, nothing written back, no timer left running.
    expect(client.transferPut).toHaveBeenCalledTimes(2);
    expect(client.transferFinish).not.toHaveBeenCalled();
    expect(store.has('c1')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('reclaim ABORTS the step in flight too', async () => {
    let putSignal: AbortSignal | undefined;
    const client = fakeClient({
      transferPut: vi.fn(
        (_id: string, _n: number, _b: Blob, opts?: {signal?: AbortSignal}) =>
          new Promise<{have: number[]}>((_r, reject) => {
            putSignal = opts?.signal;
            opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true
            });
          })
      ),
      transferDelete: vi.fn(async () => {})
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);
    seed(row());
    await flush();
    expect(putSignal?.aborted).toBe(false);
    expect(reclaim('c1')).toBe(true);
    expect(putSignal?.aborted).toBe(true);
    await flush();
    expect(store.has('c1')).toBe(false);
    // The bytes stay parked: they are the recording the composer takes back.
    expect(vi.mocked(clipVault.release)).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a later identical re-send after cancel is ONE fresh transfer under the same key', async () => {
    // Offline conn so the worker parks the bytes but moves nothing.
    conn = plantConn('disconnected', fakeClient());
    store.set('c1', row({state: 'queued'}));
    expect(cancel('c1')).toBe(1);
    expect(store.has('c1')).toBe(false);

    // The identical re-send (same content, same key): exactly one new row.
    enqueue(twoChunkBlob(), {key: 'c1', sessionId: SID, kind: 'user-audio'});
    await enqueued('c1');
    await flush();
    const fresh = store.get('c1');
    expect(fresh).toBeDefined();
    expect(fresh!.state).toBe('queued');
    expect(vi.mocked(clipVault.park)).toHaveBeenCalledTimes(1);

    // A racing second enqueue still ends in the one live row.
    enqueue(twoChunkBlob(), {key: 'c1', sessionId: SID, kind: 'user-audio'});
    await enqueued('c1');
    await flush();
    expect(store.get('c1')).toBe(fresh);
    expect(vi.mocked(clipVault.park)).toHaveBeenCalledTimes(1);
  });

  test('a 413 at begin names the cap on the row and the bubble: the engine max, else the known kind cap', async () => {
    const s = sessions.get(SID)!;
    const msg = {
      id: 'm1',
      role: 'user',
      kind: 'voice',
      text: '',
      ts: 1,
      status: 'sending',
      cid: 'c1'
    } as CycEngineMessage;
    s.messages.push(msg);
    const err = Object.assign(new Error('too large'), {status: 413, max: 256 * 1024});
    const client = fakeClient({transferBegin: vi.fn(async () => Promise.reject(err))});
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);
    seed(row());
    await flush();
    expect(store.get('c1')!.state).toBe('gone');
    expect(store.get('c1')!.refused).toBe('too large (over 256 KB)');
    expect(msg.status).toBe('failed');
    expect(msg.failReason).toBe('too large (over 256 KB)');

    // No max in the 413: the kind's known cap (300 MB user-audio, 50 MB upload).
    store.clear();
    conns.length = 0;
    const bare = Object.assign(new Error('too large'), {status: 413});
    const client2 = fakeClient({transferBegin: vi.fn(async () => Promise.reject(bare))});
    conn = plantConn('connected', client2);
    seed(row({key: 'c2', blobKey: 'c2'}));
    seed(row({key: 'c3', blobKey: 'c3', kind: 'upload', ownerCid: 'm3'}));
    await flush();
    expect(store.get('c2')!.refused).toBe('too large (over 300 MB)');
    expect(store.get('c3')!.refused).toBe('too large (over 50 MB)');

    // Any other definitive refusal carries no reason: the generic copy stands.
    store.clear();
    conns.length = 0;
    const bad = Object.assign(new Error('bad'), {status: 400});
    conn = plantConn(
      'connected',
      fakeClient({transferBegin: vi.fn(async () => Promise.reject(bad))})
    );
    seed(row({key: 'c4', blobKey: 'c4'}));
    await flush();
    expect(store.get('c4')!.state).toBe('gone');
    expect(store.get('c4')!.refused).toBeUndefined();
  });

  test('404 on PUT is NOT gone: the app forgets the id and begins again from zero', async () => {
    // First begin hands out id A, chunk 0 lands, then the engine has lost the
    // dir (404 on chunk 1). The app re-begins at once (id B), and PUTs every
    // chunk again from zero.
    let begins = 0;
    let lost = true;
    const client = fakeClient({
      transferBegin: vi.fn(async () => {
        begins++;
        return {id: begins === 1 ? 'A' : 'B', chunk: CHUNK, have: []};
      }),
      transferPut: vi.fn(async (id: string, n: number) => {
        if (id === 'A' && n === 1 && lost) {
          lost = false;
          throw Object.assign(new Error('gone'), {status: 404});
        }
        return {have: n === 0 ? [0] : [0, 1]};
      })
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);
    seed(row());
    await flush();
    await flush();
    const r = store.get('c1')!;
    expect(r.state).toBe('done');
    expect(r.id).toBe('B');
    expect(client.transferBegin).toHaveBeenCalledTimes(2);
    // PUT log: A/0, A/1 (404), B/0, B/1: chunk 0 went again, from zero.
    const log = client.transferPut.mock.calls.map((c) => `${c[0]}/${c[1]}`);
    expect(log).toEqual(['A/0', 'A/1', 'B/0', 'B/1']);
    expect(vi.mocked(clipVault.release)).toHaveBeenCalledTimes(1);
    expect(outboxFailed).toEqual([]);
  });

  test('404 on the GET resync after a reload and on finish both re-begin, never gone', async () => {
    // GET: the row remembers id A and acked [0]; the engine no longer knows A.
    const client = fakeClient({
      transferGet: vi.fn(async () =>
        Promise.reject(Object.assign(new Error('nope'), {status: 404}))
      ),
      transferBegin: vi.fn(async () => ({id: 'B', chunk: CHUNK, have: []})),
      transferPut: vi.fn(async (_id: string, n: number) => ({have: n === 0 ? [0] : [0, 1]}))
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);
    hydrateRows = [row({id: 'A', acked: [0]})];
    await hydrateTransfers();
    await flush();
    await flush();
    expect(store.get('c1')!.state).toBe('done');
    expect(store.get('c1')!.id).toBe('B');
    expect(client.transferPut.mock.calls.map((c) => c[1])).toEqual([0, 1]);

    // finish: every chunk acked, then the dir vanished before finish.
    store.clear();
    conns.length = 0;
    let fin = 0;
    const client2 = fakeClient({
      transferBegin: vi.fn(async () => ({id: fin === 0 ? 'A' : 'B', chunk: CHUNK, have: []})),
      transferPut: vi.fn(async (_id: string, n: number) => ({have: n === 0 ? [0] : [0, 1]})),
      transferFinish: vi.fn(async () => {
        fin++;
        return fin === 1
          ? {ok: false, status: 404, body: null}
          : {ok: true, status: 200, body: {msgId: 'm'}};
      })
    });
    conn = plantConn('connected', client2);
    seed(row({key: 'c2', blobKey: 'c2'}));
    await flush();
    await flush();
    expect(store.get('c2')!.state).toBe('done');
    expect(client2.transferBegin).toHaveBeenCalledTimes(2);
    expect(client2.transferPut).toHaveBeenCalledTimes(4);
    expect(outboxFailed).toEqual([]);
  });

  test('one 30 s deadline per step, owned by the worker: a stalled PUT is aborted and retried', async () => {
    let seen: AbortSignal | undefined;
    let stalls = 0;
    const client = fakeClient({
      transferPut: vi.fn((_id: string, n: number, _b: Blob, opts?: {signal?: AbortSignal}) => {
        if (stalls++ === 0) {
          seen = opts?.signal;
          return new Promise(() => {}); // never answers
        }
        return Promise.resolve({have: n === 0 ? [0] : [0, 1]});
      })
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);
    seed(row());
    await flush();
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(false);
    expect(store.get('c1')!.state).toBe('active');

    // Just under the deadline: still waiting, not aborted.
    await vi.advanceTimersByTimeAsync(STEP_DEADLINE_MS - 1);
    expect(seen!.aborted).toBe(false);
    expect(store.get('c1')!.state).toBe('active');
    // The deadline: the request is aborted and the transfer backs off (not gone).
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(seen!.aborted).toBe(true);
    expect(store.get('c1')!.state).toBe('queued');
    expect(store.get('c1')!.attempts).toBe(1);
    // ...then the retry lands.
    await vi.advanceTimersByTimeAsync(50);
    await flush();
    expect(store.get('c1')!.state).toBe('done');
    // Every step got a signal from the same deadline (begin, GET, PUT, finish).
    expect(client.transferBegin.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(client.transferFinish.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test('begin carries durationS and the owning cid for an attachment row', async () => {
    const client = fakeClient({
      transferPut: vi.fn(async (_id: string, n: number) => ({have: n === 0 ? [0] : [0, 1]}))
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);
    seed(row({kind: 'upload', name: 'take.m4a', durationS: 42, ownerCid: 'msg-1'}));
    await flush();
    expect(client.transferBegin.mock.calls[0][0]).toMatchObject({
      kind: 'upload',
      name: 'take.m4a',
      durationS: 42,
      cid: 'msg-1'
    });
  });

  test('a network error is NOT gone: it backs off and retries (never on 5xx either)', async () => {
    let attempts = 0;
    const client = fakeClient({
      transferBegin: vi.fn(async () => {
        attempts++;
        if (attempts === 1) throw new Error('socket hiccup'); // transient, no status
        return {id: 'xid', chunk: CHUNK, have: []};
      }),
      transferPut: vi.fn(async (_id: string, n: number) => ({have: [n]}))
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);

    seed(row());
    await flush();
    // First attempt failed: still not gone, a backoff timer is armed.
    expect(store.get('c1')!.state).not.toBe('gone');
    expect(store.get('c1')!.attempts).toBeGreaterThanOrEqual(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Let the backoff elapse: the retry begins, PUTs, finishes.
    await vi.advanceTimersByTimeAsync(50);
    await flush();
    expect(client.transferBegin).toHaveBeenCalledTimes(2);
    expect(store.get('c1')!.state).toBe('done');
  });

  test('a 5xx at finish is transient too: retried, not gone', async () => {
    let fin = 0;
    const client = fakeClient({
      transferPut: vi.fn(async (_id: string, n: number) => ({have: [n]})),
      transferFinish: vi.fn(async () => {
        fin++;
        return fin === 1
          ? {ok: false, status: 503, body: null}
          : {ok: true, status: 200, body: {msgId: 'srv-2'}};
      })
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: twoChunkBlob()} as never);

    seed(row());
    await flush();
    expect(store.get('c1')!.state).not.toBe('gone');
    await vi.advanceTimersByTimeAsync(50);
    await flush();
    expect(store.get('c1')!.state).toBe('done');
    expect(client.transferFinish).toHaveBeenCalledTimes(2);
  });

  test('enqueue is idempotent per live key: a second enqueue stands down; only a gone row is re-queued', async () => {
    // Offline conn so the worker parks the bytes but moves nothing.
    conn = plantConn('disconnected', fakeClient());
    enqueue(twoChunkBlob(), {key: 'dup', sessionId: SID, kind: 'user-audio'});
    await enqueued('dup');
    await flush();
    const first = store.get('dup');
    expect(first).toBeDefined();
    expect(first!.state).toBe('queued');
    expect(vi.mocked(clipVault.park)).toHaveBeenCalledTimes(1);

    // Two paths racing to move the same recording end in ONE transfer: the
    // second enqueue neither re-parks nor replaces the live row.
    enqueue(twoChunkBlob(), {key: 'dup', sessionId: SID, kind: 'user-audio'});
    await enqueued('dup');
    await flush();
    expect(store.get('dup')).toBe(first);
    expect(vi.mocked(clipVault.park)).toHaveBeenCalledTimes(1);

    // A gone row is the retry of a refused send: that one IS re-queued.
    first!.state = 'gone';
    enqueue(twoChunkBlob(), {key: 'dup', sessionId: SID, kind: 'user-audio'});
    await enqueued('dup');
    await flush();
    expect(vi.mocked(clipVault.park)).toHaveBeenCalledTimes(2);
    expect(store.get('dup')!.state).toBe('queued');
  });

  test('reclaim: a live row goes WITHOUT releasing the bytes; a settled row is refused', async () => {
    const client = fakeClient({transferDelete: vi.fn(async () => {})});
    conn = plantConn('connected', client);
    const now = Date.now();
    store.set('e1', row({key: 'e1', blobKey: 'e1', state: 'queued', id: 'xe1', createdAt: now}));
    store.set('d1', row({key: 'd1', blobKey: 'd1', state: 'done', createdAt: now + 1}));

    // The uncommitted recording's row goes; its bytes are NOT released (they
    // are the recording the composer takes back), and the partial the engine
    // had begun is DELETEd best-effort.
    expect(reclaim('e1')).toBe(true);
    expect(store.has('e1')).toBe(false);
    expect(vi.mocked(clipVault.release)).not.toHaveBeenCalled();
    expect(client.transferDelete).toHaveBeenCalledTimes(1);
    expect(client.transferDelete).toHaveBeenCalledWith('xe1');

    // A done row settled its bytes already: not the composer's to take back.
    expect(reclaim('d1')).toBe(false);
    expect(store.has('d1')).toBe(true);

    // A key with no row at all is already free.
    expect(reclaim('nope')).toBe(true);
  });

  test('send after reclaim is ONE fresh transfer: the freed key enqueues again, dedup guards a second', async () => {
    // Offline conn so the worker parks the bytes but moves nothing.
    conn = plantConn('disconnected', fakeClient());
    store.set('e1', row({key: 'e1', blobKey: 'e1', state: 'queued'}));
    expect(reclaim('e1')).toBe(true);
    expect(store.has('e1')).toBe(false);

    enqueue(twoChunkBlob(), {key: 'e1', sessionId: SID, kind: 'user-audio'});
    await enqueued('e1');
    await flush();
    const fresh = store.get('e1');
    expect(fresh).toBeDefined();
    expect(fresh!.state).toBe('queued');
    expect(vi.mocked(clipVault.park)).toHaveBeenCalledTimes(1);

    // The restored clip sent twice by racing paths still moves once.
    enqueue(twoChunkBlob(), {key: 'e1', sessionId: SID, kind: 'user-audio'});
    await enqueued('e1');
    await flush();
    expect(store.get('e1')).toBe(fresh);
    expect(vi.mocked(clipVault.park)).toHaveBeenCalledTimes(1);
  });

  // ---- pipelined-streaming proofs (this build) ----------------------------

  test('fail-before serialization proof: the serial reference stays at 1 in-flight; the pipelined worker overlaps and drains in one round trip', async () => {
    const N = 8;
    const delay = 1000;

    // A PUT that resolves only after `delay`, tracking concurrent in-flight so
    // the proof is non-vacuous in BOTH directions: max === 1 is real (serial),
    // max > 1 is real (pipelined).
    function trackingPut() {
      let inFlight = 0;
      let maxInFlight = 0;
      const fn = vi.fn((_id: string, n: number, ..._rest: unknown[]) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<{have: number[]}>((resolve) =>
          setTimeout(() => {
            inFlight--;
            resolve({have: [n]});
          }, delay)
        );
      });
      return {fn, max: () => maxInFlight};
    }

    // Reference: the OLD serial loop, ported verbatim (await each PUT before the
    // next). It cannot overlap; its max in-flight stays 1 and it needs one delay
    // window PER segment.
    const serial = trackingPut();
    const serialBytes = nChunkBlob(N);
    async function serialMoveBytes(): Promise<void> {
      for (let n = 0; n < N; n++) {
        await serial.fn(
          'sid',
          n,
          serialBytes.slice(n * CHUNK, Math.min((n + 1) * CHUNK, serialBytes.size))
        );
      }
    }
    const serialDone = serialMoveBytes();
    // After ONE window the serial loop has resolved segment 0 and issued (only)
    // segment 1: it is blocked awaiting it, never overlapping.
    await vi.advanceTimersByTimeAsync(delay);
    expect(serial.fn).toHaveBeenCalledTimes(2);
    expect(serial.max()).toBe(1);
    // It takes N windows in total to finish.
    for (let i = 0; i < N; i++) await vi.advanceTimersByTimeAsync(delay);
    await serialDone;
    expect(serial.fn).toHaveBeenCalledTimes(N);
    expect(serial.max()).toBe(1);

    // The real pipelined worker, same delayed mock: it fires every segment back
    // to back and holds them all in the air at once.
    const pipe = trackingPut();
    const client = fakeClient({transferPut: pipe.fn});
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: nChunkBlob(N)} as never);
    seed(row({size: nChunkSize(N)}));
    await flush();
    expect(pipe.fn).toHaveBeenCalledTimes(N);
    expect(pipe.max()).toBe(N);
    expect(pipe.max()).toBeGreaterThan(1);
    // And ONE delay window drains them all (not N sequential ones): the whole
    // file finishes in ~one round trip.
    await vi.advanceTimersByTimeAsync(delay);
    await flush();
    expect(store.get('c1')!.state).toBe('done');
  });

  test('union: an out-of-order resolve never regresses acked (a stale smaller have cannot shrink it)', async () => {
    const N = 3;
    const resolvers: Array<(v: {have: number[]}) => void> = [];
    const client = fakeClient({
      transferPut: vi.fn(() => new Promise<{have: number[]}>((r) => resolvers.push(r)))
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: nChunkBlob(N)} as never);
    seed(row({size: nChunkSize(N)}));
    await flush();
    expect(resolvers).toHaveLength(N);

    // The LAST segment resolves first with the full cumulative have.
    resolvers[2]({have: [0, 1, 2]});
    await flush();
    expect(store.get('c1')!.acked).toEqual([0, 1, 2]);

    // A later, stale, SMALLER have from an earlier segment must not regress it.
    resolvers[0]({have: [0]});
    await flush();
    expect(store.get('c1')!.acked).toEqual([0, 1, 2]);

    resolvers[1]({have: [1]});
    await flush();
    expect(store.get('c1')!.acked).toEqual([0, 1, 2]);
    expect(store.get('c1')!.state).toBe('done');
  });

  test('MAX_OUTSTANDING cap: pending responses never exceed 32, and the worker refills up to it', async () => {
    const N = 40; // well over the cap of 32
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];
    const client = fakeClient({
      transferPut: vi.fn((_id: string, n: number) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<{have: number[]}>((resolve) => {
          resolvers.push(() => {
            inFlight--;
            resolve({have: [n]});
          });
        });
      })
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: nChunkBlob(N)} as never);
    seed(row({size: nChunkSize(N)}));
    await flush();
    // Fired up to the cap and then blocked: exactly 32 in the air, no more.
    expect(inFlight).toBe(MAX_OUTSTANDING);
    expect(client.transferPut).toHaveBeenCalledTimes(MAX_OUTSTANDING);

    // Drain one at a time; the worker refills but never exceeds the cap.
    let drained = 0;
    while (resolvers.length > 0 && drained < N) {
      resolvers.shift()!();
      drained++;
      await flush();
      expect(inFlight).toBeLessThanOrEqual(MAX_OUTSTANDING);
    }
    expect(maxInFlight).toBe(MAX_OUTSTANDING);
    expect(client.transferPut).toHaveBeenCalledTimes(N);
    expect(store.get('c1')!.state).toBe('done');
  });

  test('disconnect mid-stream: outstanding rejections park the row, acked keeps every engine-confirmed segment, resume PUTs only the missing', async () => {
    const N = 4;
    const resolvers = new Map<number, (v: {have: number[]}) => void>();
    const client = fakeClient({
      transferBegin: vi.fn(async () => ({id: 'xid', chunk: CHUNK, have: [] as number[]})),
      transferPut: vi.fn(
        (_id: string, n: number) =>
          new Promise<{have: number[]}>((resolve) => resolvers.set(n, resolve))
      ),
      transferGet: vi.fn(async () => ({
        have: [0, 1],
        size: nChunkSize(N),
        chunk: CHUNK,
        done: false
      }))
    });
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: nChunkBlob(N)} as never);
    seed(row({size: nChunkSize(N)}));
    await flush();
    // All four segments fired and outstanding.
    expect(client.transferPut).toHaveBeenCalledTimes(4);

    // Two confirm out of order; two (2, 3) are still in the air.
    resolvers.get(1)!({have: [0, 1]});
    resolvers.get(0)!({have: [0]});
    await flush();
    expect(store.get('c1')!.acked).toEqual([0, 1]);

    // The pipe drops: the disconnected edge cuts the outstanding PUTs, they
    // reject, and the row parks queued with its id and its confirmed acked kept.
    sync.noteDown(KEY);
    await flush();
    expect(store.get('c1')!.state).toBe('queued');
    expect(store.get('c1')!.id).toBe('xid');
    expect(store.get('c1')!.acked).toEqual([0, 1]);

    // Reconnect: the GET resyncs have=[0,1] and only the missing 2, 3 go again.
    client.transferPut.mockReset();
    client.transferPut.mockImplementation(async (_id: string, n: number) => ({have: [0, 1, n]}));
    sync.noteSealed(KEY);
    sync.noteHost(KEY);
    sync.noteSessions(KEY);
    await flush();
    expect(client.transferGet).toHaveBeenCalledTimes(1);
    expect(client.transferPut.mock.calls.map((c) => c[1]).sort((a, b) => a - b)).toEqual([2, 3]);
    expect(store.get('c1')!.state).toBe('done');
  });

  // A fake sealed channel with a simulated send buffer and a low-water mark:
  // `transferPut` adds a segment to the buffer, `tunnelDrain` resolves only
  // while the buffer is under the mark (parking a waiter otherwise), and the
  // buffer falls back under the mark as the test drains/acks segments. This is
  // the THROTTLED fake the drain gate was missing: it proves the pipeline is
  // paced by the drain, not just by MAX_OUTSTANDING, and that each segment's
  // deadline anchors at its own post-drain send.
  function throttledChannel(lowSegs: number) {
    let buffered = 0;
    const drainWaiters: Array<() => void> = [];
    const responders: Array<(v: {have: number[]}) => void> = [];
    const signals: Array<AbortSignal | undefined> = [];
    let acked = 0;
    const wake = () => {
      if (buffered < lowSegs) for (const w of drainWaiters.splice(0)) w();
    };
    const transferPut = vi.fn(
      (_id: string, _n: number, _b: Blob, opts?: {signal?: AbortSignal}) => {
        buffered++;
        signals.push(opts?.signal);
        return new Promise<{have: number[]}>((resolve) => responders.push(resolve));
      }
    );
    const tunnelDrain = vi.fn(() =>
      buffered < lowSegs ? Promise.resolve() : new Promise<void>((r) => drainWaiters.push(r))
    );
    // The wire moved a segment's bytes out of the buffer (no ack yet).
    const drainOne = () => {
      if (buffered > 0) buffered--;
      wake();
    };
    // The engine acked the oldest still-pending segment (cumulative have).
    const respondOne = () => {
      const cum = Array.from({length: ++acked}, (_v, i) => i);
      responders.shift()?.({have: cum});
    };
    const flushOne = () => {
      drainOne();
      respondOne();
    };
    return {
      transferPut,
      tunnelDrain,
      drainOne,
      respondOne,
      flushOne,
      signals,
      buffered: () => buffered,
      pending: () => responders.length
    };
  }

  test('the drain serializes dispatch, not MAX_OUTSTANDING: a throttled channel gates the pipeline below the cap', async () => {
    const N = 6; // well under the cap of 32, so the cap can never be the limiter
    const chan = throttledChannel(2); // low-water mark of two buffered segments
    const client = fakeClient({transferPut: chan.transferPut, tunnelDrain: chan.tunnelDrain});
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: nChunkBlob(N)} as never);
    seed(row({size: nChunkSize(N)}));
    await flush();
    // The drain blocked at the low-water mark: dispatch is parked at 2 in the
    // buffer, though both the cap (32) and the file (6) are far larger. What
    // gates the pipeline is the drain, not MAX_OUTSTANDING.
    expect(chan.transferPut).toHaveBeenCalledTimes(2);
    expect(MAX_OUTSTANDING).toBeGreaterThan(N);
    expect(chan.tunnelDrain).toHaveBeenCalled();
    // Draining/acking one segment at a time refills dispatch one at a time: the
    // number of PUTs fired tracks the drain, and the whole file completes.
    for (let guard = 0; guard < 100 && store.get('c1')!.state !== 'done'; guard++) {
      chan.flushOne();
      await flush();
      expect(chan.buffered()).toBeLessThanOrEqual(2);
    }
    expect(chan.transferPut).toHaveBeenCalledTimes(N);
    expect(store.get('c1')!.state).toBe('done');
  });

  test('per-segment deadlines do not co-anchor: a later-dispatched segment times out on its own clock, not the first segment start', async () => {
    const chan = throttledChannel(2); // segment 0 sends, segment 1 waits on the drain
    // The PUTs never answer: the test watches only when each segment's own 30 s
    // deadline fires (i.e. when its abort signal trips).
    const client = fakeClient({transferPut: chan.transferPut, tunnelDrain: chan.tunnelDrain});
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: nChunkBlob(2)} as never);
    seed(row({size: nChunkSize(2)}));
    await flush();
    // Both fired, but segment 1's frames are still behind the drain: its 30 s
    // deadline is NOT armed at dispatch (that would co-anchor it with 0).
    expect(chan.signals).toHaveLength(2);
    expect(chan.signals[0]!.aborted).toBe(false);
    expect(chan.signals[1]!.aborted).toBe(false);

    // Ten seconds in, let the channel drain one segment: NOW segment 1's frames
    // are handed off and its deadline anchors, at t=10 s, not at t=0.
    await vi.advanceTimersByTimeAsync(10_000);
    chan.drainOne();
    await flush();

    // At t=30 s segment 0's deadline (armed at 0) fires; segment 1's (armed at
    // 10 s) has NOT: had they co-anchored, both would trip here.
    await vi.advanceTimersByTimeAsync(STEP_DEADLINE_MS - 10_000);
    await flush();
    expect(chan.signals[0]!.aborted).toBe(true);
    expect(chan.signals[1]!.aborted).toBe(false);

    // Segment 1 trips only at t=40 s: its own send + 30 s, exactly the anchor
    // the fix requires.
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(chan.signals[1]!.aborted).toBe(true);
  });

  test('MAX_OUTSTANDING still caps the pipeline when the drain would allow more', async () => {
    const N = 40; // over the cap
    // Low-water mark far above the cap: the drain never blocks first, so the
    // safety cap (32) is the binding limit even with the gate present.
    const chan = throttledChannel(1000);
    const client = fakeClient({transferPut: chan.transferPut, tunnelDrain: chan.tunnelDrain});
    conn = plantConn('connected', client);
    vi.mocked(clipVault.get).mockResolvedValue({blob: nChunkBlob(N)} as never);
    seed(row({size: nChunkSize(N)}));
    await flush();
    expect(chan.transferPut).toHaveBeenCalledTimes(MAX_OUTSTANDING);
    expect(chan.buffered()).toBe(MAX_OUTSTANDING);
    // Draining/acking refills up to the cap, never beyond it, and completes.
    for (let guard = 0; guard < 300 && store.get('c1')!.state !== 'done'; guard++) {
      chan.flushOne();
      await flush();
      expect(chan.buffered()).toBeLessThanOrEqual(MAX_OUTSTANDING);
    }
    expect(chan.transferPut).toHaveBeenCalledTimes(N);
    expect(store.get('c1')!.state).toBe('done');
  });
});
