import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// The composer clears a sent message only once its rows are on disk (offline
// design v2, section 3): sendCommitted settles when the intent's write (and
// the transfer rows' writes) have completed. Under the test the store is a
// gate: each transaction is a promise the test settles by hand; `store` and
// `op` are the request the transaction resolves on, `ops` every request made
// in it (`store.op:key`).
const gate = vi.hoisted(() => ({
  writes: [] as Array<{store: string; op: string; ops: string[]; resolve: (v: unknown) => void}>,
  transactionOn(
    store: string | string[],
    _mode: string,
    run: (s: unknown, tx: unknown) => unknown
  ): Promise<unknown> {
    const ops: string[] = [];
    let op = '';
    const storeOf = (name: string) =>
      new Proxy(
        {},
        {
          get: (_t, method) => (key?: unknown) => {
            op = String(method);
            ops.push(`${name}.${op}` + (typeof key === 'string' ? `:${key}` : ''));
            return {};
          }
        }
      );
    const first = Array.isArray(store) ? store[0] : store;
    run(storeOf(first), {objectStore: storeOf});
    return new Promise((resolve) => gate.writes.push({store: first, op, ops, resolve}));
  }
}));
vi.mock('@/shared/browser', async (orig) => {
  const real = await orig<typeof import('@/shared/browser')>();
  return {...real, transactionOn: gate.transactionOn};
});
// The transfer worker under the test: enqueued(key) is one promise per key
// (the intent's write and sendCommitted wait on the same one), settled by hand.
const park = vi.hoisted(() => ({
  settle: new Map<string, (ok: boolean) => void>(),
  pending: new Map<string, Promise<boolean>>(),
  enqueued(key: string): Promise<boolean> {
    let p = park.pending.get(key);
    if (!p) {
      p = new Promise<boolean>((resolve) => park.settle.set(key, resolve));
      park.pending.set(key, p);
    }
    return p;
  }
}));
vi.mock('../engine/transfers/worker', () => ({
  enqueue: vi.fn((_blob: Blob, meta: {key: string}) => meta.key),
  enqueued: vi.fn((key: string) => park.enqueued(key)),
  wake: vi.fn(),
  onResult: vi.fn(),
  rowOf: vi.fn(() => undefined),
  isEnqueuing: vi.fn(() => false),
  heldKeys: vi.fn(() => new Set()),
  prune: vi.fn(() => 0),
  cancel: vi.fn(() => 0),
  hydrateTransfers: vi.fn(async () => [])
}));
import * as intents from '../engine/intents';
import * as drain from '../engine/sync/drain';
import * as sync from '../engine/sync';
import {conns, sessions, type Conn} from '../engine/store/registry';
import {
  discardSend,
  failSend,
  retrySend,
  sendCommitted,
  sendSettles,
  sendTaken,
  sendText,
  settleSend,
  withdrawSend,
  __resetForTest as resetSends
} from '../engine/store/sends';
import {sendVoiceClip} from '../engine/store/voiceUpload';
import type {CycEngineMessage, CycEngineSession} from '../engine/store';
import {createComposerVaultBridge} from '../features/composer/persistence/vaultBridge';
import type {ComposerBlock, VoiceClip} from '../features/composer/components/messageComposer';

const KEY = 'ws://fake-engine.test:7788/ws';
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

// A sealed pipe to the engine: the drain writes the wire on it.
function plantConn(): {sent: unknown[][]; conn: Conn} {
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
      heard: () => true,
      sendText: (...a: unknown[]) => {
        sent.push(a);
        return true;
      }
    }
  } as unknown as Conn;
  conns.push(conn);
  return {sent, conn};
}

function settleEngine() {
  sync.noteSealed(KEY);
  sync.noteHost(KEY);
  sync.noteSessions(KEY);
}

const settled = <T>(p: Promise<T>) => {
  let done = false;
  void p.then(() => (done = true));
  return async () => {
    await Promise.resolve();
    await Promise.resolve();
    return done;
  };
};

describe('sendCommitted', () => {
  beforeEach(() => {
    gate.writes = [];
    park.settle.clear();
    park.pending.clear();
    sessions.clear();
    intents.__resetForTest();
    sync.__resetForTest();
    drain.__resetForTest(() => 0.5);
    resetSends();
  });
  afterEach(() => {
    sessions.clear();
  });

  test('a text send settles true once its intent row is written, not before', async () => {
    plantSession();
    const id = sendText(SID, 'hello');
    expect(id).toBeTruthy();
    const p = sendCommitted(SID, id);
    const isDone = settled(p);
    expect(await isDone()).toBe(false);
    const write = gate.writes.find((w) => w.store === 'intents');
    expect(write).toBeDefined();
    write!.resolve('the key');
    await expect(p).resolves.toBe(true);
  });

  test('a write that fails settles false; a message that is not a send settles false', async () => {
    plantSession();
    const id = sendText(SID, 'lost');
    const p = sendCommitted(SID, id);
    gate.writes.find((w) => w.store === 'intents')!.resolve(null);
    await expect(p).resolves.toBe(false);
    await expect(sendCommitted(SID, 'nope')).resolves.toBe(false);
    await expect(intents.committed('no-such-row')).resolves.toBe(false);
  });

  // A row on disk that names bytes not on disk is a failed send after a
  // reload: the intent's row goes to disk only after the transfer's has.
  test('a voice send writes its intent row only once the transfer rows are on disk', async () => {
    plantSession();
    const id = sendVoiceClip(SID, new Blob([new Uint8Array(16)], {type: 'audio/webm'}), {
      durationS: 1,
      text: 'note'
    });
    expect(id).toBeTruthy();
    const cid = intents.all()[0]!.id;
    const p = sendCommitted(SID, id);
    const isDone = settled(p);
    await isDone();
    expect(gate.writes.filter((w) => w.store === 'intents')).toHaveLength(0);
    expect(park.settle.has(cid)).toBe(true);
    park.settle.get(cid)!(true);
    await isDone();
    const write = gate.writes.find((w) => w.store === 'intents' && w.op === 'put');
    expect(write).toBeDefined();
    expect(await isDone()).toBe(false);
    write!.resolve('the key');
    await expect(p).resolves.toBe(true);
  });

  // A tab killed after the intent's write and before the box's copies went
  // would show the note twice (a bubble and the box again): the composition
  // row and the composer's parked recordings go in the intent's own write.
  test("a send from the box deletes its composition and clip copies in the intent's write", async () => {
    plantSession();
    const file = new File([new Uint8Array(8)], 'v.webm', {type: 'audio/webm'});
    const blocks: ComposerBlock[] = [
      {
        kind: 'voice',
        clip: {durationS: 1, text: 'note', blob: null} as VoiceClip,
        staged: {file, upload: null, progress: 0, done: false, error: null, durationS: 1}
      } as ComposerBlock,
      {kind: 'prompt', text: 'p'} as ComposerBlock
    ];
    const bridge = createComposerVaultBridge({
      box: () => ({getBlocks: () => blocks, setBlocks() {}, getDraft: () => '', setDraft() {}})
    });
    bridge.loadDraft(SID);
    bridge.vaultKeyOf.set(file, 'k1');
    const id = sendText(SID, 'hello', {alongside: bridge.sentAlongside(SID)});
    const p = sendCommitted(SID, id);
    const write = gate.writes.find((w) => w.store === 'intents' && w.op === 'put');
    expect(write).toBeDefined();
    expect(write!.ops).toEqual([`compositions.delete:${SID}`, 'clips.delete:k1', 'intents.put']);
    write!.resolve('the key');
    await expect(p).resolves.toBe(true);
  });

  test('a send removed while its bytes were still parking is never written', async () => {
    plantSession();
    const id = sendVoiceClip(SID, new Blob([new Uint8Array(16)]), {text: 'gone'});
    const cid = intents.all()[0]!.id;
    const p = intents.committed(cid);
    intents.remove(cid);
    park.settle.get(cid)!(true);
    await expect(p).resolves.toBe(false);
    expect(gate.writes.filter((w) => w.store === 'intents').map((w) => w.op)).toEqual(['delete']);
    void id;
  });
});

// The box's late edge for a send whose row never reached disk (R6): the send
// is in memory and drains; the box clears once the engine takes it.
describe('sendTaken and sendSettles', () => {
  let planted: ReturnType<typeof plantConn>;
  beforeEach(() => {
    vi.useFakeTimers();
    gate.writes = [];
    park.settle.clear();
    park.pending.clear();
    sessions.clear();
    intents.__resetForTest();
    sync.__resetForTest();
    drain.__resetForTest(() => 0.5);
    resetSends();
    plantSession();
    planted = plantConn();
  });
  afterEach(() => {
    conns.splice(conns.indexOf(planted.conn), 1);
    sessions.clear();
    vi.useRealTimers();
  });

  const cidOf = (localId: string) =>
    (sessions.get(SID)!.messages.find((m) => m.id === localId) as CycEngineMessage).cid!;

  test('the engine acks the send within the deadline: taken', async () => {
    settleEngine();
    const id = sendText(SID, 'hello');
    await vi.advanceTimersByTimeAsync(1);
    expect(planted.sent).toHaveLength(1);
    const p = sendTaken(SID, id);
    const isDone = settled(p);
    expect(await isDone()).toBe(false);
    settleSend(cidOf(id));
    await expect(p).resolves.toBe(true);
    // And once the row is gone the answer is the bubble's own status.
    await expect(sendSettles(SID, id)).resolves.toBe(true);
    await expect(sendTaken(SID, id)).resolves.toBe(true);
  });

  test('the engine is not reachable: not taken, at once; the send is still owed', async () => {
    const id = sendText(SID, 'away');
    await expect(sendTaken(SID, id)).resolves.toBe(false);
    expect(planted.sent).toHaveLength(0);
    expect(intents.get(cidOf(id))?.state).toBe('queued');
    // The unbounded wait outlives the edge: the ack after it settles the send.
    const late = sendSettles(SID, id);
    settleEngine();
    await vi.advanceTimersByTimeAsync(1);
    expect(planted.sent).toHaveLength(1);
    settleSend(cidOf(id));
    await expect(late).resolves.toBe(true);
  });

  test('the pipe goes down while it waits: not taken; the ack on the next pipe settles it', async () => {
    settleEngine();
    const id = sendText(SID, 'flap');
    await vi.advanceTimersByTimeAsync(1);
    const bounded = sendTaken(SID, id);
    const late = sendSettles(SID, id);
    sync.noteDown(KEY);
    await expect(bounded).resolves.toBe(false);
    expect(await settled(late)()).toBe(false);
    settleEngine();
    await vi.advanceTimersByTimeAsync(1);
    expect(planted.sent).toHaveLength(2);
    settleSend(cidOf(id));
    await expect(late).resolves.toBe(true);
  });

  test('no ack by the deadline: not taken; the late ack still settles it', async () => {
    settleEngine();
    const id = sendText(SID, 'slow');
    await vi.advanceTimersByTimeAsync(1);
    const bounded = sendTaken(SID, id);
    const late = sendSettles(SID, id);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(bounded).resolves.toBe(false);
    expect(await settled(late)()).toBe(false);
    settleSend(cidOf(id));
    await expect(late).resolves.toBe(true);
  });

  test('the engine refuses the send: not taken, at once; the wait follows the retry tap and its ack settles it', async () => {
    settleEngine();
    const id = sendText(SID, 'no');
    await vi.advanceTimersByTimeAsync(1);
    const bounded = sendTaken(SID, id);
    const late = sendSettles(SID, id);
    failSend(cidOf(id), 'the engine has no such session');
    await expect(bounded).resolves.toBe(false);
    // The row is still owed (the bubble offers the retry tap): the unbounded
    // wait is not over, and a fresh bounded wait says refused at once.
    expect(await settled(late)()).toBe(false);
    expect(intents.get(cidOf(id))?.state).toBe('failed');
    await expect(sendTaken(SID, id)).resolves.toBe(false);
    // The retry tap: the same cid goes again, and its ack settles the wait.
    const cid = cidOf(id);
    retrySend(SID, id);
    await vi.advanceTimersByTimeAsync(1);
    expect(planted.sent).toHaveLength(2);
    expect(cidOf(id)).toBe(cid);
    settleSend(cid);
    await expect(late).resolves.toBe(true);
    // A message that is not a send, or is gone, settles false.
    await expect(sendSettles(SID, 'nope')).resolves.toBe(false);
    await expect(sendTaken(SID, 'nope')).resolves.toBe(false);
  });

  test('a refused send the user discards: the wait ends untaken', async () => {
    settleEngine();
    const id = sendText(SID, 'gone');
    await vi.advanceTimersByTimeAsync(1);
    const late = sendSettles(SID, id);
    failSend(cidOf(id), 'the engine has no such session');
    expect(await settled(late)()).toBe(false);
    discardSend(cidOf(id));
    await expect(late).resolves.toBe(false);
    expect(intents.get(cidOf(id))).toBeUndefined();
  });

  // A send whose durable row never reached disk is kept in the box (the retry
  // surface). Its optimistic thread bubble is withdrawn so the same message is
  // not shown twice: only the local row goes, the in-memory intent still drains
  // and the box's wait (read from the cid before the row went) settles on the
  // ack the engine sends when it takes it.
  test('a kept send withdraws its thread bubble; the intent still drains and settles by its cid', async () => {
    // Offline when the write failed: the bubble is painted, nothing is sent yet.
    const id = sendText(SID, 'offline');
    const msgs = sessions.get(SID)!.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].status).toBe('sending');
    const cid = cidOf(id);
    expect(planted.sent).toHaveLength(0);

    // Mirror the composer's followUnsaved: read the settle wait (captures the
    // cid) BEFORE withdrawing the row, then withdraw the optimistic bubble.
    const settling = sendSettles(SID, id);
    expect(withdrawSend(SID, id)).toBe(true);
    // The bubble is gone from the thread, but the intent is still owed.
    expect(sessions.get(SID)!.messages).toHaveLength(0);
    expect(intents.get(cid)?.state).toBe('queued');

    // The engine comes back: the in-memory intent drains and the ack settles
    // the box's wait, so the box can clear even with no bubble on screen.
    settleEngine();
    await vi.advanceTimersByTimeAsync(1);
    expect(planted.sent).toHaveLength(1);
    settleSend(cid);
    await expect(settling).resolves.toBe(true);
  });

  test('withdrawSend is a no-op for an unknown row and for a delivered one', async () => {
    const id = sendText(SID, 'keep me');
    expect(withdrawSend(SID, 'nope')).toBe(false);
    const m = sessions.get(SID)!.messages.find((x) => x.id === id) as CycEngineMessage;
    // A delivered/settled row is not a local pending bubble: it is never withdrawn.
    m.status = 'delivered';
    expect(withdrawSend(SID, id)).toBe(false);
    expect(sessions.get(SID)!.messages).toHaveLength(1);
  });

  // A normal send paints its optimistic bubble at once and settles on the ack;
  // nothing withdraws it. (The kept path above is the only one that does.)
  test('a normal send paints its optimistic bubble and settles it, not withdrawn', async () => {
    settleEngine();
    const id = sendText(SID, 'normal');
    await vi.advanceTimersByTimeAsync(1);
    const m = sessions.get(SID)!.messages.find((x) => x.id === id) as CycEngineMessage;
    expect(m).toBeDefined();
    expect(m.status).toBe('sending');
    expect(planted.sent).toHaveLength(1);
    settleSend(cidOf(id));
    // The bubble is still in the thread (the engine's echo settles its status).
    expect(sessions.get(SID)!.messages.find((x) => x.id === id)).toBeDefined();
  });

  test('a refused send that is retried and refused again is still followed; the third try lands', async () => {
    settleEngine();
    const id = sendText(SID, 'again');
    await vi.advanceTimersByTimeAsync(1);
    const late = sendSettles(SID, id);
    const cid = cidOf(id);
    failSend(cid, 'busy');
    retrySend(SID, id);
    await vi.advanceTimersByTimeAsync(1);
    failSend(cid, 'busy');
    expect(await settled(late)()).toBe(false);
    retrySend(SID, id);
    await vi.advanceTimersByTimeAsync(1);
    expect(planted.sent).toHaveLength(3);
    settleSend(cid);
    await expect(late).resolves.toBe(true);
  });
});
