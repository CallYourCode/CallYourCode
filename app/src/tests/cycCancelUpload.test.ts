import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// The user-facing cancel of an in-progress upload (the progress line's tap).
// The worker's own cancel/reclaim mechanics are proven in
// cycTransferWorker.test.ts; here the SEND-path semantics around them:
//   - a voice note's cancel takes the recording BACK (row reclaimed, bytes
//     kept, intent and bubble gone) instead of silently discarding it;
//   - an attachment send's cancel discards the WHOLE pending message (one
//     wire, positional offsets, all-or-nothing delivery) with every row;
//   - a cancel that races a finished transfer is a no-op: the message stands.

const shared = vi.hoisted(() => ({
  vault: new Map<string, {key: string; blob: Blob; mime: string; [k: string]: unknown}>(),
  rows: new Map<string, import('../engine/transfers/rows').TransferRow>(),
  // When true, enqueue models the REAL worker's async park: it returns at once
  // and the row is written only when the test settles the park (finishPark),
  // exactly like parkAndWrite (whole-blob IDB write + sha256) still running.
  // enqueued(key) resolves when that park settles, isEnqueuing(key) is true
  // until it does. Default false: rows are written synchronously.
  deferPark: false,
  parks: new Map<string, {promise: Promise<boolean>; settle: () => void}>()
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
  rememberLocalUpload: vi.fn(),
  aliasLocalUpload: vi.fn(() => true),
  localUploadUrl: (): undefined => undefined
}));

// An in-memory worker with the REAL cancel/reclaim contract: enqueue writes a
// queued row; reclaim removes a live row (refusing a settled one); cancel
// removes every row of the cid, whatever its state.
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
      const writeRow = () => {
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
      };
      if (shared.deferPark) {
        let res!: (v: boolean) => void;
        const promise = new Promise<boolean>((r) => (res = r));
        shared.parks.set(meta.key, {
          promise,
          settle: () => {
            writeRow(); // the row appears only now, after the park finishes
            shared.parks.delete(meta.key);
            res(true);
          }
        });
      } else {
        writeRow();
      }
      return meta.key;
    }
  ),
  wake: vi.fn(),
  onResult: vi.fn(() => () => {}),
  rowOf: (key: string) => shared.rows.get(key),
  isEnqueuing: (key: string) => shared.parks.has(key),
  enqueued: vi.fn(
    (key: string) => shared.parks.get(key)?.promise ?? Promise.resolve(shared.rows.has(key))
  ),
  reclaim: vi.fn((key: string) => {
    const r = shared.rows.get(key);
    if (!r) return true;
    if (r.state === 'done' || r.state === 'gone') return false;
    shared.rows.delete(key);
    return true;
  }),
  cancel: vi.fn((cid: string) => {
    let removed = 0;
    for (const [k, r] of [...shared.rows]) {
      if ((r.ownerCid ?? r.key) !== cid) continue;
      shared.rows.delete(k);
      removed++;
    }
    return removed;
  }),
  allRows: () => [...shared.rows.values()],
  heldKeys: () => new Set<string>(),
  prune: () => 0,
  hydrateTransfers: async () => [...shared.rows.values()]
}));

import * as clipVault from '../audio/clipVault';
import * as transfers from '../engine/transfers/worker';
import * as intents from '../engine/intents';
import type {SendPayload} from '../engine/intents';
import * as drain from '../engine/sync/drain';
import * as sync from '../engine/sync';
import {conns, sessions, type Conn} from '../engine/store/registry';
import {sendVoiceClip, cancelVoiceUpload} from '../engine/store/voiceUpload';
import {
  sendAttachments,
  cancelAttachmentSend,
  __resetForTest as resetAttach
} from '../engine/store/attachSend';
import {__resetForTest as resetSends} from '../engine/store/sends';
import type {CycEngineMessage, CycEngineSession} from '../engine/store';

const {vault, rows} = shared;

const KEY = 'ws://cancel-engine.test:7791/ws';
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
  sync.noteSealed(KEY);
  sync.noteHost(KEY);
  sync.noteSessions(KEY);
  return {conn, sent};
}

const flush = () => vi.advanceTimersByTimeAsync(1);

const clip = (bytes = 128) => new Blob([new Uint8Array(bytes)], {type: 'audio/webm'});

const seedVault = (key: string) => {
  const rec = {
    key,
    cid: key,
    sessionId: SID,
    blob: clip(64),
    mime: 'audio/webm',
    bytes: 64,
    durationS: 3,
    ts: Date.now(),
    tries: 0,
    transfer: true
  };
  vault.set(key, rec as never);
  return rec;
};

const attachOpts = (names: string[]) => ({
  text: 'see attached',
  wireText: 'see attached',
  files: names.map((name, i) => ({
    key: `tk-${i + 1}`,
    file: new File([new Uint8Array(32)], name, {type: 'image/png'}),
    name,
    mime: 'image/png',
    at: 0,
    wireAt: 0
  })),
  words: [] as string[]
});

describe('cancel of an in-progress upload', () => {
  let planted: Planted;
  let s: CycEngineSession;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vault.clear();
    rows.clear();
    shared.deferPark = false;
    shared.parks.clear();
    intents.__resetForTest();
    sync.__resetLiveForTest();
    drain.__resetForTest(() => 0.5);
    resetSends();
    resetAttach();
    sessions.clear();
    s = plantSession();
    planted = plantConn();
  });
  afterEach(() => {
    drain.__resetForTest();
    vi.useRealTimers();
    conns.splice(conns.indexOf(planted.conn), 1);
    sessions.clear();
  });

  describe('a voice note', () => {
    test('cancel mid-transfer takes the recording back: row reclaimed, bytes kept, bubble and intent gone', async () => {
      const id = sendVoiceClip(s.id, clip(), {durationS: 3, text: 'hello'});
      const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
      const cid = m.cid!;
      await flush();
      expect(rows.get(cid)?.state).toBe('queued');
      const parked = seedVault(cid);

      const rec = await cancelVoiceUpload(s.id, id);

      // The recording comes back, marked the composer's (transfer cleared).
      expect(rec).not.toBeNull();
      expect(rec!.blob).toBe(parked.blob);
      expect(rec!.transfer).toBe(false);
      expect(vi.mocked(clipVault.update)).toHaveBeenCalledWith(cid, {transfer: false});
      // Reclaim-style: the row went WITHOUT releasing the bytes.
      expect(vi.mocked(transfers.reclaim)).toHaveBeenCalledWith(cid);
      expect(rows.has(cid)).toBe(false);
      expect(vi.mocked(clipVault.release)).not.toHaveBeenCalled();
      // The pending bubble and its intent are gone; nothing ever hit the wire.
      expect(s.messages.find((x) => x.id === id)).toBeUndefined();
      expect(intents.get(cid)).toBeUndefined();
      await flush();
      expect(planted.sent).toHaveLength(0);
    });

    test('cancel after the wire phase is reached (msgId in hand) is a no-op: the message stands', async () => {
      const id = sendVoiceClip(s.id, clip(), {durationS: 2, text: 'note'});
      const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
      const cid = m.cid!;
      await flush();
      // The transfer finished and the executor picked up the msgId.
      intents.update(cid, {
        ...(intents.get(cid)!.payload as SendPayload),
        msgId: 'srv-1'
      });
      m.msgId = 'srv-1';

      expect(await cancelVoiceUpload(s.id, id)).toBeNull();
      expect(s.messages.find((x) => x.id === id)).toBe(m);
      expect(intents.get(cid)).toBeDefined();
      expect(vi.mocked(transfers.reclaim)).not.toHaveBeenCalled();
    });

    test('cancel racing a transfer that settled under the tap (row done) is a no-op', async () => {
      const id = sendVoiceClip(s.id, clip(), {durationS: 2});
      const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
      const cid = m.cid!;
      await flush();
      rows.get(cid)!.state = 'done';
      rows.get(cid)!.result = {msgId: 'srv-2'};

      expect(await cancelVoiceUpload(s.id, id)).toBeNull();
      // Nothing was torn down: the executor sends the wire from the result.
      expect(s.messages.find((x) => x.id === id)).toBe(m);
      expect(intents.get(cid)).toBeDefined();
      expect(rows.get(cid)?.state).toBe('done');
    });

    test('cancel with the bytes already gone from the vault still discards the pending bubble', async () => {
      const id = sendVoiceClip(s.id, clip(), {durationS: 2});
      const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
      const cid = m.cid!;
      await flush();
      // vault deliberately NOT seeded: nothing to restore.
      expect(await cancelVoiceUpload(s.id, id)).toBeNull();
      expect(s.messages.find((x) => x.id === id)).toBeUndefined();
      expect(intents.get(cid)).toBeUndefined();
      expect(rows.has(cid)).toBe(false);
    });

    test('cancel of a message that is not a pending upload is refused', async () => {
      const id = sendVoiceClip(s.id, clip(), {durationS: 2});
      const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
      m.status = 'failed';
      expect(await cancelVoiceUpload(s.id, id)).toBeNull();
      expect(s.messages.find((x) => x.id === id)).toBe(m);
    });
  });

  describe('an attachment send', () => {
    test('cancel mid-transfer discards the WHOLE pending message and every row of it', async () => {
      const id = sendAttachments(s.id, attachOpts(['a.png', 'b.png']));
      const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
      const cid = m.cid!;
      await flush();
      expect(rows.size).toBe(2);
      expect(m.uploads?.length).toBe(2);

      expect(cancelAttachmentSend(s.id, id)).toBe(true);

      // All-or-nothing, matching delivery: the message goes whole, never one
      // file out of a composed text with positional offsets.
      expect(s.messages.find((x) => x.id === id)).toBeUndefined();
      expect(intents.get(cid)).toBeUndefined();
      expect(vi.mocked(transfers.cancel)).toHaveBeenCalledWith(cid);
      expect(rows.size).toBe(0);
      await flush();
      expect(planted.sent).toHaveLength(0);
    });

    test('cancel after every row finished and the wire was built is a no-op: the message stands', async () => {
      const id = sendAttachments(s.id, attachOpts(['a.png']));
      const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
      const cid = m.cid!;
      await flush();
      // Simulate wireFromRows: the payload became an ordinary wire send.
      const named = {...(intents.get(cid)!.payload as SendPayload)};
      delete named.transferKeys;
      delete named.attachMeta;
      intents.update(cid, named);

      expect(cancelAttachmentSend(s.id, id)).toBe(false);
      expect(s.messages.find((x) => x.id === id)).toBe(m);
      expect(intents.get(cid)).toBeDefined();
      expect(vi.mocked(transfers.cancel)).not.toHaveBeenCalled();
    });

    test('cancel of a settled message (no intent) or a non-pending one is refused', async () => {
      const id = sendAttachments(s.id, attachOpts(['a.png']));
      const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
      const cid = m.cid!;
      await flush();
      intents.remove(cid);
      expect(cancelAttachmentSend(s.id, id)).toBe(false);
      expect(s.messages.find((x) => x.id === id)).toBe(m);

      m.status = 'failed';
      expect(cancelAttachmentSend(s.id, id)).toBe(false);
    });

    // The parking-window defect (verifier attack 3): the cancel X is tappable
    // from frame one (sendPct 0) while each file's park (whole-blob IDB write +
    // sha256, 0.5-2s for a big file) is still running and NO row exists yet. A
    // tap in that window must still tear down every file that finishes parking
    // AFTER the cancel; without the trailing sweep the late rows survive and
    // upload in full in the background, resuming across reloads and leaking
    // never-pruned rows. Here enqueue defers the row write until finishPark, so
    // the row appears strictly after the cancel tap.
    test('cancel DURING parking still tears down files that finish parking after the tap', async () => {
      shared.deferPark = true;
      const id = sendAttachments(s.id, attachOpts(['big-a.png', 'big-b.png']));
      const m = s.messages.find((x) => x.id === id) as CycEngineMessage;
      const cid = m.cid!;
      const keys = ['tk-1', 'tk-2'];
      // The parks are still in flight: enqueue returned, no rows exist yet, but
      // the bubble is already up with sendPct 0 (the cancel X is live).
      expect(rows.size).toBe(0);
      expect(keys.every((k) => shared.parks.has(k))).toBe(true);
      expect(m.sendPct).toBe(0);

      // The user taps cancel NOW, mid-park.
      expect(cancelAttachmentSend(s.id, id)).toBe(true);
      // The synchronous teardown ran: bubble and intent gone, nothing to cancel
      // yet (no rows). The first cancel found zero rows.
      expect(s.messages.find((x) => x.id === id)).toBeUndefined();
      expect(intents.get(cid)).toBeUndefined();
      expect(rows.size).toBe(0);

      // The parks finish AFTER the cancel: their queued rows are written now,
      // exactly the window the real worker has and the synchronous cancel
      // missed.
      for (const k of keys) shared.parks.get(k)!.settle();
      expect(rows.size).toBe(2); // the late rows exist for an instant...

      // ...and the trailing sweep (Promise.all(enqueued).then(cancel)) catches
      // them: no surviving transfer row, so nothing uploads in the background.
      await flush();
      const survivors = [...rows.values()].filter((r) => (r.ownerCid ?? r.key) === cid);
      expect(survivors).toEqual([]);
      expect(rows.size).toBe(0);
      // The late cancel is the trailing sweep's, by the same cid.
      expect(vi.mocked(transfers.cancel)).toHaveBeenCalledWith(cid);
      expect(planted.sent).toHaveLength(0);
    });
  });
});
