import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// File and image attachments over the persisted transfer queue (Lane A). The
// worker itself is proven in cycTransferWorker.test.ts; here the SEND path
// around it: one bubble and one durable intent per message, one transfer row
// per file, the wire only once every row is done, a definitive failure when
// any row is refused, and a reload that rebuilds rows and intent.

const shared = vi.hoisted(() => ({
  vault: new Map<string, {blob: Blob; mime: string}>(),
  previews: [] as string[],
  rows: new Map<string, import('../engine/transfers/rows').TransferRow>(),
  resultHandlers: [] as ((row: import('../engine/transfers/rows').TransferRow) => void)[],
  // Keys a test holds in the real worker's enqueue gap: `enqueue` has returned
  // but the row is not written yet.
  enqueuing: new Set<string>()
}));
vi.mock('../audio/clipVault', () => ({
  park: vi.fn(async () => 'k'),
  release: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  get: vi.fn(async (key: string) => shared.vault.get(key)),
  list: vi.fn(async () => []),
  holding: vi.fn(() => () => {})
}));

vi.mock('@/features/composer/localUploadUrls', () => ({
  rememberLocalUpload: (id: string): void => {
    shared.previews.push(id);
  },
  // Mirrors the real alias: the engine uploadId joins the record only when
  // the transfer key's preview is still held (same object URL, no re-mint).
  aliasLocalUpload: (fromId: string, toId: string): boolean => {
    if (!shared.previews.includes(fromId)) return false;
    shared.previews.push(toId);
    return true;
  },
  localUploadUrl: (): undefined => undefined
}));

// An in-memory worker: enqueue writes a queued row; tests flip rows and fire
// the result handlers the way the real worker does.
vi.mock('../engine/transfers/worker', () => ({
  enqueue: vi.fn(
    (
      blob: Blob,
      meta: {
        key: string;
        sessionId: string;
        kind: 'upload' | 'user-audio';
        mime?: string;
        name?: string;
        durationS?: number;
        ownerCid?: string;
      }
    ) => {
      const now = Date.now();
      shared.rows.set(meta.key, {
        key: meta.key,
        sessionId: meta.sessionId,
        kind: meta.kind,
        blobKey: meta.key,
        size: blob.size,
        mime: meta.mime ?? blob.type,
        name: meta.name,
        durationS: meta.durationS,
        ownerCid: meta.ownerCid,
        sha256: 'x',
        chunk: 262144,
        acked: [],
        state: 'queued',
        attempts: 0,
        createdAt: now,
        updatedAt: now
      });
      return meta.key;
    }
  ),
  wake: vi.fn(),
  onResult: vi.fn((fn: (row: import('../engine/transfers/rows').TransferRow) => void) => {
    shared.resultHandlers.push(fn);
    return () => {};
  }),
  rowOf: (key: string) => shared.rows.get(key),
  isEnqueuing: (key: string) => shared.enqueuing.has(key),
  enqueued: async (key: string) => shared.rows.has(key),
  allRows: () => [...shared.rows.values()],
  heldKeys: () => new Set<string>(),
  prune: () => 0,
  cancel: () => 0,
  hydrateTransfers: async () => [...shared.rows.values()]
}));

import * as transfers from '../engine/transfers/worker';
const {vault, previews, rows, resultHandlers, enqueuing} = shared;

import * as intents from '../engine/intents';
import type {SendPayload} from '../engine/intents';
import * as drain from '../engine/sync/drain';
import * as sync from '../engine/sync';
import {conns, renderSubs, sessions, type Conn} from '../engine/store/registry';
import {sendAttachments, wordsMarker, __resetForTest} from '../engine/store/attachSend';
import {
  discardSend,
  hydrateSends,
  retrySend,
  settleSend,
  __resetForTest as resetSends
} from '../engine/store/sends';
import type {CycEngineMessage, CycEngineSession} from '../engine/store';
import type {CycUpload} from '../engine/contract';

const KEY = 'ws://attach-engine.test:7790/ws';
const SID = KEY + '|p1';

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

type Planted = {conn: Conn; sent: unknown[][]};
function plantConn(): Planted {
  const sent: unknown[][] = [];
  const conn = {
    key: KEY,
    state: 'connected',
    failed: false,
    user: 'u',
    host: 'h',
    hostname: 'h',
    tabs: [],
    plugins: [],
    voiceHealthy: true,
    helloSettled: true,
    client: {
      sendText: (...a: unknown[]) => {
        sent.push(a);
        return true;
      }
    }
  } as unknown as Conn;
  conns.push(conn);
  return {conn, sent};
}

const png = (n: number) => new File([new Uint8Array(n)], 'shot.png', {type: 'image/png'});
const m4a = (n: number) => new File([new Uint8Array(n)], 'take.m4a', {type: 'audio/mp4'});

function finish(key: string, uploadId: string): void {
  const r = rows.get(key)!;
  r.state = 'done';
  r.result = {
    uploadId,
    name: r.name ?? 'f',
    mime: r.mime,
    size: r.size,
    path: `/uploads/${uploadId}`,
    image: r.mime.startsWith('image/')
  } as CycUpload;
  for (const fn of resultHandlers) fn(r);
}

// The drain is async (one await per executor step): let it run.
const flush = () => vi.advanceTimersByTimeAsync(1);

function settle() {
  sync.noteSealed(KEY);
  sync.noteHost(KEY);
  sync.noteSessions(KEY);
}

const payloadOf = (cid: string) => intents.get(cid)?.payload as SendPayload | undefined;

describe('attachments over the transfer queue', () => {
  let s: CycEngineSession;
  let planted: Planted;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    rows.clear();
    vault.clear();
    enqueuing.clear();
    previews.length = 0;
    __resetForTest();
    intents.__resetForTest();
    sync.__resetLiveForTest();
    drain.__resetForTest(() => 0.5);
    resetSends();
    sessions.clear();
    s = plantSession();
    planted = plantConn();
    settle();
  });
  afterEach(() => {
    drain.__resetForTest();
    vi.useRealTimers();
    conns.length = 0;
    sessions.clear();
  });

  function sendTwo() {
    const a = png(300);
    const b = m4a(200);
    const id = sendAttachments(s.id, {
      text: 'two things',
      wireText: 'two things ' + wordsMarker('k-b'),
      files: [
        {
          key: 'k-a',
          file: a,
          name: a.name,
          mime: a.type,
          width: 40,
          height: 30,
          at: 10,
          wireAt: 10
        },
        {
          key: 'k-b',
          file: b,
          name: b.name,
          mime: b.type,
          durationS: 7,
          at: 10,
          wireAt: 10 + wordsMarker('k-b').length + 1
        }
      ],
      words: ['k-b'],
      partials: [{id: 'k-b', text: 'hello', upToS: 3}]
    });
    return {id, a, b};
  }

  test('the press makes one bubble, one intent and N transfer rows, and sends no wire', async () => {
    const {id} = sendTwo();
    await flush();
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    expect(m.status).toBe('sending');
    expect(m.sendPct).toBe(0);
    expect(m.wordsPending).toBe(true);
    // Placeholders: the transfer key stands in for the uploadId until finish.
    expect(m.uploads?.map((u) => u.uploadId)).toEqual(['k-a', 'k-b']);
    expect(m.upload?.image).toBe(true);
    expect(m.uploads?.[1]).toMatchObject({durationS: 7, name: 'take.m4a'});
    expect(previews).toEqual(['k-a']);

    const entry = payloadOf(m.cid!)!;
    expect(intents.get(m.cid!)).toMatchObject({kind: 'send-files', state: 'queued', localId: id});
    expect(entry.transferKeys).toEqual(['k-a', 'k-b']);
    expect(entry.attachMeta?.['k-b']).toMatchObject({name: 'take.m4a', durationS: 7, image: false});
    expect(entry.words).toEqual(['k-b']);

    expect(transfers.enqueue).toHaveBeenCalledTimes(2);
    expect(vi.mocked(transfers.enqueue).mock.calls[1][1]).toMatchObject({
      key: 'k-b',
      kind: 'upload',
      name: 'take.m4a',
      durationS: 7,
      ownerCid: m.cid
    });
    expect(planted.sent).toHaveLength(0);
  });

  test('all rows done: exactly one wire with N uploadIds, markers and words by id', async () => {
    const {id} = sendTwo();
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    await flush();

    finish('k-a', 'up-A');
    await flush();
    // One of two done: still no wire.
    expect(planted.sent).toHaveLength(0);
    expect(m.status).toBe('sending');

    // The last result must repaint the bubble with the progress line gone:
    // the wire's own edge changes no status, so nothing else paints.
    const paints: (number | undefined)[] = [];
    const sub = () => paints.push(m.sendPct);
    renderSubs.add(sub);
    finish('k-b', 'up-B');
    await flush();
    renderSubs.delete(sub);
    expect(paints).toContain(undefined);
    expect(planted.sent).toHaveLength(1);
    const [pane, wire, opts] = planted.sent[0] as [string, string, Record<string, unknown>];
    expect(pane).toBe('p1');
    expect(wire).toBe('two things ' + wordsMarker('up-B'));
    expect((opts.uploads as CycUpload[]).map((u) => u.uploadId)).toEqual(['up-A', 'up-B']);
    expect((opts.uploads as CycUpload[])[1]).toMatchObject({
      durationS: 7,
      at: 10 + wordsMarker('k-b').length + 1
    });
    expect((opts.uploads as CycUpload[])[0]).toMatchObject({width: 40, height: 30});
    expect(opts.words).toEqual(['up-B']);
    expect(opts.partials).toEqual([{id: 'up-B', text: 'hello', upToS: 3}]);
    expect(opts.cid).toBe(m.cid);

    // The bubble and the intent now carry the real ids; the intent is an
    // ordinary wire send from here (no transfer keys left to wait on), in
    // flight until the ack.
    expect(m.uploads?.map((u) => u.uploadId)).toEqual(['up-A', 'up-B']);
    expect(m.sendPct).toBeUndefined();
    expect(m.status).toBe('sending');
    expect(intents.get(m.cid!)?.state).toBe('inflight');
    const entry = payloadOf(m.cid!)!;
    expect(entry.transferKeys).toBeUndefined();
    expect(entry.attachMeta).toBeUndefined();
    expect(entry.wire).toBe(wire);
    expect(entry.wireUploads?.map((u) => u.uploadId)).toEqual(['up-A', 'up-B']);
    // The image preview follows the real id.
    expect(previews).toEqual(['k-a', 'up-A']);
    // A second result for an in-flight intent sends nothing more.
    finish('k-b', 'up-B');
    await flush();
    expect(planted.sent).toHaveLength(1);
    // The ack settles it.
    settleSend(m.cid);
    expect(intents.get(m.cid!)).toBeUndefined();
  });

  test("the send's own kick before the rows are written waits; it never fails the message", async () => {
    // The real `enqueue` returns at once and writes the row later: the drain
    // step the send kicks finds no row and no kept bytes for a key still being
    // enqueued. That is a row on its way, not a lost attachment.
    const held = (_blob: Blob, meta: {key: string}) => {
      enqueuing.add(meta.key);
      return meta.key;
    };
    vi.mocked(transfers.enqueue).mockImplementationOnce(held).mockImplementationOnce(held);
    const {id} = sendTwo();
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    await flush();
    expect(m.status).toBe('sending');
    expect(intents.get(m.cid!)?.state).toBe('queued');
    expect(vi.mocked(transfers.wake)).toHaveBeenCalled();
    expect(planted.sent).toHaveLength(0);
    expect(rows.size).toBe(0);
  });

  test('one row gone: no wire, the bubble is definitively failed, retry fails again at once', async () => {
    const {id} = sendTwo();
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    await flush();
    rows.get('k-b')!.state = 'gone';
    finish('k-a', 'up-A');
    await flush();
    expect(planted.sent).toHaveLength(0);
    expect(m.status).toBe('failed');
    expect(m.failReason).toContain('k-b');
    expect(m.sendPct).toBeUndefined();
    expect(intents.get(m.cid!)?.state).toBe('failed');

    retrySend(s.id, id);
    await flush();
    expect(planted.sent).toHaveLength(0);
    expect(m.status).toBe('failed');
    expect(intents.get(m.cid!)?.state).toBe('failed');
  });

  // A reload: the intents come back from disk (here: planted in the live map
  // before hydrateSends paints them) with their rows.
  function plantIntent(payload: SendPayload) {
    intents.put({
      id: payload.cid,
      engineKey: KEY,
      sessionId: SID,
      kind: 'send-files',
      payload,
      // A fresh reload: the intent was made recently (its message ts is a tiny
      // fixture placeholder, not its creation time). A createdAt in 1970 would
      // trip the over-a-day expiry guard, which is a separate behaviour.
      createdAt: Date.now()
    });
  }

  test('reload: the intent rebuilds the bubble, re-queues a row whose bytes survive, then sends', async () => {
    const cid = 'cid-reload';
    const entry: SendPayload = {
      cid,
      sessionId: SID,
      ts: 1000,
      text: 'after reload',
      kind: 'text',
      wire: 'after reload ' + wordsMarker('k-b'),
      words: ['k-b'],
      transferKeys: ['k-a', 'k-b'],
      attachMeta: {
        'k-a': {
          name: 'shot.png',
          mime: 'image/png',
          size: 300,
          image: true,
          width: 40,
          height: 30,
          at: 12,
          wireAt: 12
        },
        'k-b': {
          name: 'take.m4a',
          mime: 'audio/mp4',
          size: 200,
          image: false,
          durationS: 7,
          at: 12,
          wireAt: 12
        }
      }
    };
    plantIntent(entry);
    // Row a survived the reload mid-flight; row b's row is missing but its
    // bytes are still parked.
    rows.set('k-a', {
      key: 'k-a',
      id: 'xa',
      sessionId: SID,
      kind: 'upload',
      blobKey: 'k-a',
      size: 300,
      mime: 'image/png',
      name: 'shot.png',
      ownerCid: cid,
      sha256: 'x',
      chunk: 262144,
      acked: [0],
      state: 'queued',
      attempts: 0,
      createdAt: 1000,
      updatedAt: 1000
    });
    vault.set('k-a', {blob: png(300), mime: 'image/png'});
    vault.set('k-b', {blob: m4a(200), mime: 'audio/mp4'});

    await hydrateSends();
    await flush();

    const m = s.messages.find((x) => (x as CycEngineMessage).cid === cid) as CycEngineMessage;
    expect(m).toBeDefined();
    expect(intents.get(cid)?.localId).toBe(m.id);
    expect(m.status).toBe('sending');
    expect(m.sendPct).toBe(0);
    expect(m.uploads?.map((u) => u.uploadId)).toEqual(['k-a', 'k-b']);
    expect(m.uploads?.[0]).toMatchObject({image: true, width: 40, height: 30});
    // Row b was re-queued from its bytes under the same key and owner.
    expect(transfers.enqueue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transfers.enqueue).mock.calls[0][1]).toMatchObject({
      key: 'k-b',
      ownerCid: cid,
      kind: 'upload',
      durationS: 7
    });
    expect(rows.get('k-b')?.state).toBe('queued');
    // The image preview came back from the vault.
    expect(previews).toContain('k-a');
    expect(planted.sent).toHaveLength(0);

    finish('k-a', 'up-A');
    finish('k-b', 'up-B');
    await flush();
    expect(planted.sent).toHaveLength(1);
    const [, wire, opts] = planted.sent[0] as [string, string, Record<string, unknown>];
    expect(wire).toBe('after reload ' + wordsMarker('up-B'));
    expect((opts.uploads as CycUpload[]).map((u) => u.uploadId)).toEqual(['up-A', 'up-B']);
    expect(opts.words).toEqual(['up-B']);
  });

  test('reload with a row gone before it: failed, nothing re-queued, no wire', async () => {
    const cid = 'cid-gone';
    plantIntent({
      cid,
      sessionId: SID,
      ts: 1000,
      text: 'x',
      kind: 'text',
      wire: 'x',
      transferKeys: ['k-a'],
      attachMeta: {
        'k-a': {name: 'shot.png', mime: 'image/png', size: 300, image: true, at: 1, wireAt: 1}
      }
    });
    rows.set('k-a', {
      key: 'k-a',
      sessionId: SID,
      kind: 'upload',
      blobKey: 'k-a',
      size: 300,
      mime: 'image/png',
      ownerCid: cid,
      sha256: 'x',
      chunk: 262144,
      acked: [],
      state: 'gone',
      attempts: 0,
      createdAt: 1000,
      updatedAt: 1000
    });
    await hydrateSends();
    await flush();
    const m = s.messages.find((x) => (x as CycEngineMessage).cid === cid) as CycEngineMessage;
    expect(m.status).toBe('failed');
    expect(intents.get(cid)?.state).toBe('failed');
    expect(transfers.enqueue).not.toHaveBeenCalled();
    expect(planted.sent).toHaveLength(0);
  });

  describe('the intent settles while the executor is reading the vault (defect #7)', () => {
    const racy = (cid: string): SendPayload => ({
      cid,
      sessionId: SID,
      ts: 1000,
      text: 'racy',
      kind: 'text',
      wire: 'racy',
      transferKeys: ['k-a'],
      attachMeta: {
        'k-a': {name: 'shot.png', mime: 'image/png', size: 300, image: true, at: 1, wireAt: 1}
      }
    });

    test('the ack lands under the await: nothing is re-queued and no second wire goes', async () => {
      const cid = 'cid-race-done';
      plantIntent(racy(cid));
      vault.set('k-a', {blob: png(300), mime: 'image/png'});
      const clipVault = await import('../audio/clipVault');
      vi.mocked(clipVault.get).mockImplementationOnce(async (key: string) => {
        // the engine acked the message while the vault read was in flight
        const m = s.messages.find((x) => (x as CycEngineMessage).cid === cid) as CycEngineMessage;
        m.status = 'sent';
        settleSend(cid);
        return shared.vault.get(key) as never;
      });

      await hydrateSends();
      await flush();

      const m = s.messages.find((x) => (x as CycEngineMessage).cid === cid) as CycEngineMessage;
      expect(m.status).toBe('sent');
      expect(intents.get(cid)).toBeUndefined();
      expect(transfers.enqueue).not.toHaveBeenCalled();
      expect(planted.sent).toHaveLength(0);
    });

    test('the message is discarded under the await: no failure is painted, nothing moves', async () => {
      const cid = 'cid-race-gone';
      plantIntent(racy(cid));
      // no row and no bytes: on its own this would fail the intent...
      const clipVault = await import('../audio/clipVault');
      vi.mocked(clipVault.get).mockImplementationOnce(async () => {
        // ...but the user discarded it while the vault was read
        discardSend(cid);
        s.messages = s.messages.filter((x) => (x as CycEngineMessage).cid !== cid);
        return undefined as never;
      });

      await hydrateSends();
      await flush();

      expect(s.messages.find((x) => (x as CycEngineMessage).cid === cid)).toBeUndefined();
      expect(intents.get(cid)).toBeUndefined();
      expect(transfers.enqueue).not.toHaveBeenCalled();
      expect(planted.sent).toHaveLength(0);
    });
  });
});

// The unbypassable HEIC guard at the upload chokepoint. The composer's
// stage-time conversion is only a fast preview; a staging path that skips it
// (the composer vault restore rebuilding attach blocks on reload, the evidenced
// bypass) reaches sendAttachments carrying a raw HEIC File. These prove the
// chokepoint normalizes it to JPEG before the bytes are parked and the intent
// names them, and fails the send loudly on a decode failure instead of
// shipping raw HEIC.
describe('HEIC normalized at the upload chokepoint', () => {
  let s: CycEngineSession;
  let planted: Planted;
  const heicWin = window as Window & {__cycHeicDecoder?: (b: Blob) => Promise<Blob>};

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    rows.clear();
    vault.clear();
    enqueuing.clear();
    previews.length = 0;
    __resetForTest();
    intents.__resetForTest();
    sync.__resetLiveForTest();
    drain.__resetForTest(() => 0.5);
    resetSends();
    sessions.clear();
    s = plantSession();
    planted = plantConn();
    settle();
    delete heicWin.__cycHeicDecoder;
  });
  afterEach(() => {
    drain.__resetForTest();
    vi.useRealTimers();
    conns.length = 0;
    sessions.clear();
    delete heicWin.__cycHeicDecoder;
  });

  const heic = (name = 'Screenshot 2026-01-02 at 10.30.15.heic') =>
    new File([new Uint8Array(120)], name, {type: 'image/heic'});

  // The exact AttachFile shape the composer builds from a staged attach block:
  // the mime and name come straight off the File, so a vault-restored HEIC
  // (never touched by the stage-time conversion) arrives here as image/heic.
  const sendOne = (file: File, key = 'k-h') =>
    sendAttachments(s.id, {
      text: 'look',
      wireText: 'look',
      files: [
        {
          key,
          file,
          name: file.name,
          mime: file.type || 'application/octet-stream',
          at: 5,
          wireAt: 5
        }
      ],
      words: []
    });

  const enqueuedCall = () => vi.mocked(transfers.enqueue).mock.calls[0];

  test('a HEIC sent through the send path is enqueued as JPEG with a .jpg name and the decoder bytes', async () => {
    const jpegOut = new Blob(['jpeg-out'], {type: 'image/jpeg'});
    heicWin.__cycHeicDecoder = vi.fn(async () => jpegOut);
    const src = heic();
    const id = sendOne(src);
    // The decode is async: no bytes are parked and no intent is written until
    // it lands (on master, with no chokepoint, this would enqueue image/heic).
    expect(transfers.enqueue).not.toHaveBeenCalled();
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    expect(intents.get(m.cid!)).toBeUndefined();
    await flush();

    expect(transfers.enqueue).toHaveBeenCalledTimes(1);
    const [blob, meta] = enqueuedCall();
    expect(meta).toMatchObject({
      key: 'k-h',
      kind: 'upload',
      mime: 'image/jpeg',
      name: 'Screenshot 2026-01-02 at 10.30.15.jpg'
    });
    expect((blob as File).type).toBe('image/jpeg');
    // The bytes are the decoder output, not the raw HEIC that came in.
    expect((blob as File).size).toBe(jpegOut.size);
    expect((blob as File).size).not.toBe(src.size);
    const entry = payloadOf(m.cid!)!;
    expect(entry.attachMeta?.['k-h']).toMatchObject({
      mime: 'image/jpeg',
      name: 'Screenshot 2026-01-02 at 10.30.15.jpg',
      image: true
    });
    expect(m.status).toBe('sending');
  });

  test('a vault-restored attach block carrying a HEIC converts before it is enqueued', async () => {
    const jpegOut = new Blob(['restored-jpeg'], {type: 'image/jpeg'});
    heicWin.__cycHeicDecoder = vi.fn(async () => jpegOut);
    // Exactly what vaultRecovery rebuilds: `new File([record.blob], name,
    // {type})` for a persisted attach block, straight into the send with no
    // stage-time conversion in between.
    const restored = new File([new Uint8Array(90)], 'IMG_4321.HEIC', {type: 'image/heic'});
    const id = sendOne(restored);
    await flush();

    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    const [blob, meta] = enqueuedCall();
    expect(meta).toMatchObject({mime: 'image/jpeg', name: 'IMG_4321.jpg'});
    expect((blob as File).type).toBe('image/jpeg');
    expect((blob as File).size).toBe(jpegOut.size);
    expect(m.status).toBe('sending');
  });

  test('a non-HEIC image passes through the chokepoint untouched and synchronously', async () => {
    heicWin.__cycHeicDecoder = vi.fn(async () => new Blob(['nope']));
    const shot = png(300);
    const id = sendOne(shot, 'k-p');
    // No HEIC: enqueue happens at once, no decoder is consulted.
    expect(transfers.enqueue).toHaveBeenCalledTimes(1);
    const [blob, meta] = enqueuedCall();
    expect(blob).toBe(shot);
    expect(meta).toMatchObject({key: 'k-p', mime: 'image/png', name: 'shot.png'});
    expect(heicWin.__cycHeicDecoder).not.toHaveBeenCalled();
    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    expect(intents.get(m.cid!)?.kind).toBe('send-files');
  });

  test('a decode failure fails the send loudly, parks no raw HEIC, and its retry re-converts', async () => {
    heicWin.__cycHeicDecoder = vi.fn(async () => {
      throw new Error('libheif unavailable');
    });
    const id = sendOne(heic());
    await flush();

    const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
    expect(m.status).toBe('failed');
    expect(m.failReason).toContain('libheif');
    expect(m.sendPct).toBeUndefined();
    // No bytes parked and no intent naming absent bytes: nothing shipped raw.
    expect(transfers.enqueue).not.toHaveBeenCalled();
    expect(intents.get(m.cid!)).toBeUndefined();
    expect(planted.sent).toHaveLength(0);

    // Tapping the failed bubble re-runs the conversion; a working decoder now
    // converts and finally enqueues the JPEG.
    const jpegOut = new Blob(['retried'], {type: 'image/jpeg'});
    heicWin.__cycHeicDecoder = vi.fn(async () => jpegOut);
    retrySend(s.id, id);
    expect(m.status).toBe('sending');
    await flush();

    expect(transfers.enqueue).toHaveBeenCalledTimes(1);
    const [blob, meta] = enqueuedCall();
    expect(meta).toMatchObject({mime: 'image/jpeg', name: 'Screenshot 2026-01-02 at 10.30.15.jpg'});
    expect((blob as File).type).toBe('image/jpeg');
    expect((blob as File).size).toBe(jpegOut.size);
    expect(intents.get(m.cid!)?.kind).toBe('send-files');
  });
});
