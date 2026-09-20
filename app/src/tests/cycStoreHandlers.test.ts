import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
vi.mock('@/shared/logging', () => ({cyclog: vi.fn()}));
import {cyclog} from '@/shared/logging';
import {PAGE_SIZE} from '@shared/pages';
import {
  conns,
  engineThinking,
  sessions,
  seen,
  lastSettledTabs,
  type Conn
} from '../engine/store/registry';
import {termWatchers} from '../engine/store/terminal';
import {wireSessions} from '../engine/store/handlers/sessions';
import {effectiveMarkerOf, reportSighting} from '../engine/store/readState';
import {wireLiveness} from '../engine/store/handlers/liveness';
import {wireChat} from '../engine/store/handlers/chat';
import {wireEvents} from '../engine/store/handlers/events';
import {wireSpeech} from '../engine/store/handlers/speech';
import {wireTerminalFrames} from '../engine/store/handlers/terminalFrames';
import type {HandlerCtx} from '../engine/store/handlers/types';
import * as sync from '../engine/sync';
import * as intents from '../engine/intents';
import * as drain from '../engine/sync/drain';
import {reachOf, tickGlyph} from '../features/chat/content';
import type {CycEngineMessage, CycEngineSession} from '../engine/store';
import * as rowStore from '../engine/store/rows/rowStore';
import {initDoor} from '../engine/store/rows/door';
import {__resetReplicatorsForTest} from '../engine/store/rows/repl';
import {memTx} from './rowStoreFake';

initDoor();
// Warm the row store for a session so the door writes land synchronously and can
// be read back through the projection (the open chat renders from the store).
async function warmStore(sid = SID): Promise<void> {
  rowStore.setOpen(sid);
  await rowStore.openWindow(sid, 300);
}
const held = (sid = SID) => rowStore.projection(sid).messages as CycEngineMessage[];
const heldEvents = (sid = SID) => rowStore.projection(sid).events;
// Let the attach-ok's async replicator feed settle (it awaits the store door).
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
const KEY = 'ws://fake-handlers.test:7788/ws';
const SID = KEY + '|p1';
type Fired = Record<string, (...a: never[]) => void>;
function fakeConn(): {conn: Conn; fire: (ev: string, ...a: unknown[]) => void} {
  const handlers: Fired = {};
  const conn = {
    key: KEY,
    state: 'connected',
    user: 'u',
    host: 'h',
    hostname: 'h',
    tabs: [],
    plugins: [],
    voiceHealthy: true,
    helloSettled: true,
    client: {
      on: (ev: string, fn: (...a: never[]) => void) => {
        handlers[ev] = fn;
      },
      setSessionTail: vi.fn()
    }
  } as unknown as Conn;
  conns.push(conn);
  const fire = (ev: string, ...a: unknown[]) => {
    if (!handlers[ev]) throw new Error('no handler for ' + ev);
    (handlers[ev] as (...x: unknown[]) => void)(...a);
  };
  return {conn, fire};
}
function mkSession(paneId = 'p1'): CycEngineSession {
  const s = {
    id: KEY + '|' + paneId,
    engineKey: KEY,
    paneId,
    tabKey: '',
    name: paneId,
    cwd: '/x',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [],
    claudeSessionId: null,
    events: [],
    agentRuns: []
  } as unknown as CycEngineSession;
  sessions.set(s.id, s);
  return s;
}
function spyCtx(over: Partial<HandlerCtx> = {}): HandlerCtx {
  const base: HandlerCtx = {
    ensureSession: (ek, paneId) => sessions.get(ek + '|' + paneId) ?? mkSession(paneId),
    stripInstruction: (t) => t,
    releaseQueued: vi.fn((s, m) => {
      if (!m.queued) return false;
      delete m.queued;
      return true;
    }),
    releaseQueuedBefore: vi.fn(() => false),
    endReplayHold: vi.fn(),
    firstPaint: vi.fn(),
    overlayOn: () => false,
    rekeySession: vi.fn(() => null),
    reclaimDead: vi.fn(() => true),
    attachedId: () => '',
    fireCompactResult: vi.fn(),
    fireAnswerResult: vi.fn(),
    fireSay: vi.fn(),
    fireSayGrow: vi.fn(),
    fireSayDone: vi.fn(),
    fireSayLive: vi.fn(),
    fireSayLiveFail: vi.fn()
  };
  return {...base, ...over};
}
afterEach(() => {
  const c = conns.find((x) => x.key === KEY);
  if (c) conns.splice(conns.indexOf(c), 1);
  sessions.clear();
  seen.clear();
  engineThinking.clear();
  lastSettledTabs.delete(KEY);
  termWatchers.clear();
  rowStore.__setBackingForTest(null);
  __resetReplicatorsForTest();
});
beforeEach(() => {
  localStorage.clear();
  rowStore.__setBackingForTest(memTx().tx);
});
const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'p1',
  cwd: '/x',
  settings: {},
  alive: true,
  unread: 2,
  claudeSessionId: null as string | null,
  ...over
});
describe('sessions family', () => {
  test('a listed session takes the frame fields; unconditional vs sticky rules hold', () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireSessions(conn, ctx);
    const s = mkSession();
    s.title = 'old title' as unknown as typeof s.title;
    s.contextPct = 40;
    fire(
      'sessions',
      [row({tab: 't1', contextPct: undefined, model: null, ask: null})],
      [{key: 't1', label: 'T'}]
    );
    expect(s.tabKey).toBe('t1');
    expect(s.unread).toBe(2);
    expect(s.title).toBe('old title');
    expect(s.contextPct).toBeUndefined();
    expect(s.model).toBeUndefined();
    expect(conn.tabs).toEqual([{key: 't1', label: 'T'}]);
    expect(lastSettledTabs.get(KEY)).toEqual([{key: 't1', label: 'T'}]);
  });
  test('this device sighting overlays a stale broadcast: the marker holds', () => {
    // The engine is the authority and there is no client pointer to reconcile,
    // but this device overlays its OWN not-yet-acknowledged sighting so a frame
    // that has not caught up cannot flip a row he just read back to unread.
    const {conn, fire} = fakeConn();
    wireSessions(conn, spyCtx());
    const s = mkSession();
    s.messages.push({
      id: 'm:mr-a',
      role: 'claude',
      kind: 'text',
      text: 'seen',
      ts: 20,
      seq: 7,
      mid: 'mr-a'
    } as CycEngineMessage);

    reportSighting(s.id, {mid: 'mr-a', ts: 20});
    fire('sessions', [row({heardTs: 10})], []);

    // The raw broadcast is adopted verbatim (no client max), but the displayed
    // marker is the further-forward of the two: this device's sighting.
    expect(effectiveMarkerOf(s)?.ts).toBe(20);
    expect(effectiveMarkerOf(s)?.mid).toBe('mr-a');
  });

  test('the engine broadcast is adopted verbatim: no client-side reconcile', () => {
    // The old app kept its own persisted read pointer and max()-ed it against
    // every frame; that second authority is gone. The app renders exactly what
    // the engine broadcasts (the engine owns forward-only), with no local floor.
    const {conn, fire} = fakeConn();
    wireSessions(conn, spyCtx());
    const s = mkSession();

    fire('sessions', [row({heardTs: 30})], []);
    expect(s.readThrough?.ts).toBe(30);

    fire('sessions', [row({heardTs: 10})], []);
    expect(s.readThrough?.ts).toBe(10);
    expect(localStorage.getItem('cyc-heard-ts')).toBeNull();
  });

  test('a settled frame prunes unlisted sessions and reclaims their bookkeeping', () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireSessions(conn, ctx);
    mkSession('p1');
    mkSession('gone');
    fire('sessions', [row()], []);
    expect(sessions.has(KEY + '|gone')).toBe(false);
    expect(ctx.reclaimDead).toHaveBeenCalledWith(KEY + '|gone');
  });
  test('an unsettled frame greys instead of deleting', () => {
    const {conn, fire} = fakeConn();
    conn.helloSettled = false;
    const ctx = spyCtx();
    wireSessions(conn, ctx);
    const dead = mkSession('gone');
    dead.thinking = true;
    dead.ask = {q: 'x'} as never;
    fire('sessions', [row()], []);
    expect(sessions.has(KEY + '|gone')).toBe(true);
    expect(dead.alive).toBe(false);
    expect(dead.churnGrey).toBe(true);
    expect(dead.thinking).toBe(false);
    expect(dead.ask).toBeNull();
  });
  test('the attached open chat is greyed, never deleted, even settled', () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx({attachedId: () => KEY + '|gone'});
    wireSessions(conn, ctx);
    const dead = mkSession('gone');
    fire('sessions', [row()], []);
    expect(sessions.has(KEY + '|gone')).toBe(true);
    expect(dead.alive).toBe(false);
    expect(dead.churnGrey).toBe(false);
  });
  test('sessionIdChanged rekeys through the ctx; result fan-outs map paneId to sid', () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireSessions(conn, ctx);
    fire('sessionIdChanged', 'old-pane', 'new-uuid');
    expect(ctx.rekeySession).toHaveBeenCalledWith(KEY, 'old-pane', 'new-uuid');
    mkSession('p1');
    fire('compactResult', 'p1', true, 'done');
    expect(ctx.fireCompactResult).toHaveBeenCalledWith(SID, true, 'done');
    fire('answerResult', 'nope', false, 'r', 'd');
    expect(ctx.fireAnswerResult).toHaveBeenCalledWith('nope', false, 'r', 'd');
  });
});
describe('liveness family', () => {
  test('status transitions re-arm hello and feed the sync manager', () => {
    sync.__resetForTest();
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireLiveness(conn, ctx);
    fire('status', 'disconnected');
    expect(conn.state).toBe('disconnected');
    expect(conn.helloSettled).toBe(false);
    expect(sync.engineState(KEY)).toBe('down');
    fire('status', 'disconnected');
    fire('status', 'connecting');
    expect(sync.engineState(KEY)).toBe('dialing');
    fire('status', 'connected');
    expect(sync.engineState(KEY)).toBe('sealed');
    fire('host', 'me', 'box');
    expect(sync.engineState(KEY)).toBe('sealed');
    sync.noteSessions(KEY);
    expect(sync.engineState(KEY)).toBe('live');
  });
  test('an empty host frame keeps the name but still settles the hello', () => {
    const {conn, fire} = fakeConn();
    conn.helloSettled = false;
    wireLiveness(conn, spyCtx());
    fire('host', '', '');
    expect(conn.host).toBe('h');
    expect(conn.helloSettled).toBe(true);
    fire('host', 'me', 'box');
    expect(conn.user).toBe('me');
    expect(conn.host).toBe('box');
  });
  test('voiceHealth and plugins replace the conn facts whole', () => {
    const {conn, fire} = fakeConn();
    wireLiveness(conn, spyCtx());
    fire('voiceHealth', false);
    expect(conn.voiceHealthy).toBe(false);
    fire('plugins', [{id: 'crons'}]);
    expect(conn.plugins).toEqual([{id: 'crons'}]);
    fire('plugins', []);
    expect(conn.plugins).toEqual([]);
  });
});
describe('chat family', () => {
  test('the echo settles the local messageNode by cid: status, ts adoption, store tail', async () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireChat(conn, ctx);
    const s = mkSession();
    await warmStore();
    const local = {
      id: 1,
      role: 'user',
      kind: 'text',
      text: 'hi',
      ts: 100,
      status: 'sending',
      cid: 'c1'
    } as unknown as CycEngineMessage;
    s.messages.push(local);
    fire('chat', {id: 'p1', role: 'user', text: 'hi', ts: 145, cid: 'c1', seq: 7});
    expect(local.status).toBe('delivered');
    expect(local.ts).toBe(145);
    expect(local.seq).toBe(7);
    // The dedup key is the durable identity, never seq: this legacy row (no
    // mid) keys on ts|role|text, which survives a seq renumber.
    expect(local.dedupeKey).toBe('145|user|hi');
    // The delivered row settled into the store (the one door), not a twin: the
    // open chat projects exactly it.
    expect(held()).toHaveLength(1);
    expect(held()[0].status).toBe('delivered');
    expect(held()[0].seq).toBe(7);
  });
  test('an ack settles the send: bubble sent, intent gone', () => {
    const {conn, fire} = fakeConn();
    wireChat(conn, spyCtx());
    const s = mkSession();
    intents.__resetForTest();
    const local = {
      id: 1,
      role: 'user',
      kind: 'text',
      text: 'hi',
      ts: 100,
      status: 'sending',
      cid: 'c-ok'
    } as unknown as CycEngineMessage;
    s.messages.push(local);
    intents.put({
      id: 'c-ok',
      engineKey: KEY,
      sessionId: SID,
      kind: 'send-text',
      payload: {cid: 'c-ok'}
    });
    fire('ack', {id: 'p1', cid: 'c-ok', dup: false});
    expect(local.status).toBe('sent');
    expect(intents.get('c-ok')).toBeUndefined();
  });
  test('a nack (ack with err) leaves the send not delivered: bubble failed, intent kept for the retry tap', () => {
    const {conn, fire} = fakeConn();
    wireChat(conn, spyCtx());
    const s = mkSession();
    intents.__resetForTest();
    const local = {
      id: 1,
      role: 'user',
      kind: 'text',
      text: 'hi',
      ts: 100,
      status: 'sending',
      cid: 'c-void'
    } as unknown as CycEngineMessage;
    s.messages.push(local);
    intents.put({
      id: 'c-void',
      engineKey: KEY,
      sessionId: SID,
      kind: 'send-text',
      payload: {cid: 'c-void'}
    });
    fire('ack', {id: 'p1', cid: 'c-void', dup: false, err: 'unknown-session'});
    expect(local.status).toBe('failed');
    expect(local.failReason).toBe('the engine has no such session');
    expect(intents.get('c-void')).toMatchObject({
      state: 'failed',
      lastError: 'the engine has no such session'
    });
    expect(s.messages).toHaveLength(1);
    // The tap: the same intent is owed again.
    drain.requeue('c-void');
    expect(intents.get('c-void')?.state).toBe('queued');
  });
  test('A1 ack then send-failed on the same cid: sending -> sent -> failed with the reason, glyph deliveryFailed', () => {
    const {conn, fire} = fakeConn();
    wireChat(conn, spyCtx());
    const s = mkSession();
    intents.__resetForTest();
    const local = {
      id: 1,
      role: 'user',
      kind: 'text',
      text: 'into the modal',
      ts: 100,
      status: 'sending',
      cid: 'c-swallow'
    } as unknown as CycEngineMessage;
    s.messages.push(local);
    intents.put({
      id: 'c-swallow',
      engineKey: KEY,
      sessionId: SID,
      kind: 'send-text',
      payload: {cid: 'c-swallow'}
    });
    // The ack (delivery-blind) promotes the row to the single tick and drops
    // the intent.
    fire('ack', {id: 'p1', cid: 'c-swallow', dup: false});
    expect(local.status).toBe('sent');
    expect(intents.get('c-swallow')).toBeUndefined();
    // Delivery then fails on the same cid: the row is demoted to failed with
    // the reason, no longer stuck at the tick forever.
    fire('sendFailed', {
      id: 'p1',
      cid: 'c-swallow',
      reason: 'that session did not take the text; it looks like it is waiting on a prompt or menu'
    });
    expect(local.status).toBe('failed');
    expect(local.failReason).toBe(
      'that session did not take the text; it looks like it is waiting on a prompt or menu'
    );
    expect(reachOf(local)).toBe('failed');
    expect(tickGlyph(local)).toBe('deliveryFailed');
  });
  test('A3 delivered path unchanged: a chat echo with the cid adopts the local row to delivered', () => {
    const {conn, fire} = fakeConn();
    wireChat(conn, spyCtx());
    const s = mkSession();
    const local = {
      id: 1,
      role: 'user',
      kind: 'text',
      text: 'hi',
      ts: 100,
      status: 'sending',
      cid: 'c-live'
    } as unknown as CycEngineMessage;
    s.messages.push(local);
    fire('chat', {id: 'p1', role: 'user', text: 'hi', ts: 145, cid: 'c-live', seq: 7});
    expect(local.status).toBe('delivered');
    expect(reachOf(local)).toBe('session');
    expect(tickGlyph(local)).toBe('deliveryConfirmed');
  });
  test('a re-broadcast of a held row (same mid) folds in the store, not re-inserted', async () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireChat(conn, ctx);
    mkSession();
    await warmStore();
    // A transcript fill re-broadcasts the SAME row with a changed text and a
    // possibly renumbered seq; the durable mid is what the store dedupes on, so
    // it rewrites the one row in place rather than twinning.
    fire('chat', {id: 'p1', role: 'claude', text: 'a', ts: 10, seq: 3, mid: 'mr-resettle00000000'});
    expect(held()).toHaveLength(1);
    const firstLocalId = held()[0].id;
    fire('chat', {
      id: 'p1',
      role: 'claude',
      text: 'a filled',
      ts: 10,
      seq: 9,
      mid: 'mr-resettle00000000'
    });
    expect(held()).toHaveLength(1);
    // The renumbered seq and the filled text were folded into the held row
    // without a twin, and the painted node's local id was preserved.
    expect(held()[0].seq).toBe(9);
    expect(held()[0].text).toBe('a filled');
    expect(held()[0].id).toBe(firstLocalId);
  });
  test('a live frame moves lastActivity monotonically and clears local thinking', () => {
    const {conn, fire} = fakeConn();
    wireChat(conn, spyCtx());
    const s = mkSession();
    s.thinking = true;
    fire('chat', {id: 'p1', role: 'claude', text: 'a', ts: 500, seq: 1});
    expect(s.lastActivity).toBe(500);
    expect(s.thinking).toBe(false);
    fire('chat', {id: 'p1', role: 'claude', text: 'b', ts: 400, seq: 2});
    expect(s.lastActivity).toBe(500);
  });
  test('engine-claimed thinking survives the echo', () => {
    const {conn, fire} = fakeConn();
    wireChat(conn, spyCtx());
    const s = mkSession();
    s.thinking = true;
    engineThinking.add(s.id);
    fire('chat', {id: 'p1', role: 'claude', text: 'a', ts: 1, seq: 1});
    expect(s.thinking).toBe(true);
  });
  test('attachOk with known:false keeps held history and stops waiting', () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireChat(conn, ctx);
    const s = mkSession();
    s.historyPending = true;
    s.messages.push({id: 9, role: 'claude', kind: 'text', text: 'kept', ts: 1} as never);
    fire('attachOk', {id: 'p1', known: false});
    expect(s.notOnEngine).toBe(true);
    expect(s.historyPending).toBe(false);
    expect(s.messages).toHaveLength(1);
    expect(ctx.firstPaint).toHaveBeenCalledWith(SID, 'replay');
  });
  test('attachOk queued list is authoritative: stale flags clear, missed ones set', async () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireChat(conn, ctx);
    const s = mkSession();
    s.messages.push(
      {
        id: 'm1',
        role: 'user',
        kind: 'text',
        text: 'delivered long ago',
        ts: 100,
        queued: true
      } as never,
      {id: 'm2', role: 'user', kind: 'text', text: 'actually still waiting', ts: 200} as never,
      {id: 'm3', role: 'claude', kind: 'text', text: 'r', ts: 150, queued: true} as never
    );
    fire('attachOk', {id: 'p1', known: true, queued: [200]});
    await flush();
    const byId = (n: number) => s.messages.find((m) => m.id === 'm' + n) as {queued?: boolean};
    expect(byId(1).queued).toBeUndefined();
    expect(byId(2).queued).toBe(true);
    // non-user rows are never touched
    expect(byId(3).queued).toBe(true);
    // the heuristic is not consulted when the engine spoke
    expect(ctx.releaseQueuedBefore).not.toHaveBeenCalled();
  });
  test('attachOk without a queued list keeps the latest-reply heuristic', async () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireChat(conn, ctx);
    const s = mkSession();
    s.messages.push(
      {id: 1, role: 'user', kind: 'text', text: 'q', ts: 100, queued: true} as never,
      {id: 2, role: 'claude', kind: 'text', text: 'r', ts: 150} as never
    );
    fire('attachOk', {id: 'p1', known: true});
    await flush();
    expect(ctx.releaseQueuedBefore).toHaveBeenCalledWith(s, 150);
  });
  test('attachOk without a pageSize is logged loud and falls back to the shared size', () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireChat(conn, ctx);
    const s = mkSession();
    (cyclog as unknown as ReturnType<typeof vi.fn>).mockClear();
    fire('attachOk', {id: 'p1', known: true});
    expect(cyclog).toHaveBeenCalledWith('history.pagesize-missing', {session: 'p1'});
    expect(s.pageSize).toBe(PAGE_SIZE);
  });
  test('attachOk seeds its pages into the store, projected as the open window', async () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireChat(conn, ctx);
    mkSession();
    await warmStore();
    fire('attachOk', {
      id: 'p1',
      known: true,
      pageSize: 50,
      total: 2,
      pointer: 0,
      pointerPage: 0,
      tailPage: 0,
      pages: [
        {
          page: 0,
          version: 1,
          sealed: false,
          messages: [
            {role: 'claude', text: 'x', ts: 1, seq: 1},
            {role: 'user', text: 'y', ts: 2, seq: 2}
          ],
          events: [{uuid: 'se-1', ts: 3, seq: 3, kind: 'tool', text: 'Bash ls', tool: 'Bash'}]
        }
      ]
    });
    await flush();
    // The page's rows entered the one door (the replicator), so the open window
    // projects them: two messages and the interleaved record, no separate path.
    expect(held().map((m) => m.text)).toEqual(['x', 'y']);
    expect(heldEvents().map((e) => e.uuid)).toEqual(['se-1']);
    const s = sessions.get(SID)!;
    expect(s.historyPending).toBe(false);
    expect(ctx.endReplayHold).toHaveBeenCalledWith(SID);
  });
  test('one attach frame carries interleaved messages AND events into the one door', async () => {
    // The owner's model: activity is just another message type on the same
    // channel. A page holds both rows on one seq axis, so the ONE attach frame
    // that brings the messages brings their interleaved events too, into the
    // same store door, with no second frame and no follow-up fetch.
    const {conn, fire} = fakeConn();
    wireChat(conn, spyCtx());
    mkSession();
    await warmStore();
    fire('attachOk', {
      id: 'p1',
      known: true,
      pageSize: 50,
      total: 4,
      pointer: 0,
      pointerPage: 0,
      tailPage: 0,
      pages: [
        {
          page: 0,
          version: 5,
          sealed: false,
          // interleaved on the one axis: message, event, message, event
          messages: [
            {role: 'user', text: 'run it', ts: 1, seq: 1},
            {role: 'claude', text: 'done', ts: 3, seq: 3}
          ],
          events: [
            {uuid: 'se-a', ts: 2, seq: 2, kind: 'tool', text: 'Bash ls'},
            {uuid: 'se-b', ts: 4, seq: 4, kind: 'compact', text: 'compacted'}
          ]
        }
      ]
    });
    await flush();
    // both kinds came off the SAME frame into the SAME store: the projection
    // holds the interleaved seqs 1..4, proving neither kind was dropped.
    expect(held().map((m) => m.seq)).toEqual([1, 3]);
    expect(heldEvents().map((e) => e.seq)).toEqual([2, 4]);
    // no separate events frame or per-event fetch: the client was never asked
    // for anything beyond the attach it already answered.
    expect(
      (conn.client as unknown as {setSessionTail: ReturnType<typeof vi.fn>}).setSessionTail
    ).not.toHaveBeenCalled();
  });
  test('dequeued releases only through the ctx guard', () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireChat(conn, ctx);
    const s = mkSession();
    const m = {
      id: 1,
      role: 'user',
      kind: 'text',
      text: 'q',
      ts: 42,
      queued: true
    } as unknown as CycEngineMessage;
    s.messages.push(m);
    fire('dequeued', 'p1', 42);
    expect(ctx.releaseQueued).toHaveBeenCalledWith(s, m);
  });
});
describe('events family', () => {
  test('a live record enters the store door and projects into the open chat', async () => {
    const {conn, fire} = fakeConn();
    wireEvents(conn, spyCtx());
    mkSession();
    await warmStore();
    fire('sessionEvent', 'p1', {uuid: 'se-1', ts: 1, seq: 9, kind: 'tool', text: 'Read'});
    expect(heldEvents()).toEqual([{uuid: 'se-1', ts: 1, seq: 9, kind: 'tool', text: 'Read'}]);
  });
  test('a live record rides the SAME door a live message does: stored, projected, no round-trip', async () => {
    // Parity with the chat handler's live path: a session-event enters the one
    // store door (durable, so an offline reopen has it) and projects into the
    // open window. It asks the engine for nothing (no attach, no page fetch, no
    // session-tail toggle): the record already arrived on the same pipe.
    const {conn, fire} = fakeConn();
    wireEvents(conn, spyCtx());
    mkSession();
    await warmStore();
    fire('sessionEvent', 'p1', {uuid: 'se-2', ts: 5, seq: 11, kind: 'interrupt', text: 'stop'});
    expect(heldEvents().map((e) => e.uuid)).toEqual(['se-2']);
    expect(
      (conn.client as unknown as {setSessionTail: ReturnType<typeof vi.fn>}).setSessionTail
    ).not.toHaveBeenCalled();
  });
});
describe('speech family', () => {
  test('say clears local thinking and fans out; engine-claimed thinking stays', () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireSpeech(conn, ctx);
    const s = mkSession();
    s.thinking = true;
    fire('say', 'p1', 'm1', 'hello', undefined, false);
    expect(s.thinking).toBe(false);
    expect(ctx.fireSay).toHaveBeenCalledWith(SID, 'm1', 'hello', undefined, false);
  });
  test('sayDone finalizes the growing messageNode: marker off, duration on, tail recached', () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireSpeech(conn, ctx);
    const s = mkSession();
    const m = {
      id: 1,
      role: 'claude',
      kind: 'voice',
      text: 't',
      ts: 1,
      msgId: 'clip1',
      growing: true
    } as unknown as CycEngineMessage;
    s.messages.push(m);
    fire('sayDone', 'p1', 'clip1', 6.5);
    expect(m.growing).toBeUndefined();
    expect(m.durationS).toBe(6.5);
    expect(ctx.fireSayDone).toHaveBeenCalledWith(SID, 'clip1', 6.5);
  });
  test('sayGrow forwards without touching held state', () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireSpeech(conn, ctx);
    fire('sayGrow', 'p1', 'clip1', 3.2, 40);
    expect(ctx.fireSayGrow).toHaveBeenCalledWith(SID, 'clip1', 3.2, 40);
  });
  test('sayLive and sayLiveFail fan out namespaced without touching held state', () => {
    const {conn, fire} = fakeConn();
    const ctx = spyCtx();
    wireSpeech(conn, ctx);
    fire('sayLive', 'p1', 'clip1');
    fire('sayLiveFail', 'p1', 'clip1');
    expect(ctx.fireSayLive).toHaveBeenCalledWith(SID, 'clip1');
    expect(ctx.fireSayLiveFail).toHaveBeenCalledWith(SID, 'clip1');
  });
});
describe('terminal frames family', () => {
  test('frames go straight to the watcher; close evicts it once', () => {
    const {conn, fire} = fakeConn();
    wireTerminalFrames(conn, spyCtx());
    const frames: unknown[] = [];
    const closed: string[] = [];
    termWatchers.set(SID, {
      onFrame: (f: unknown) => frames.push(f),
      onClosed: (w: string) => closed.push(w)
    } as never);
    fire('termFrame', 'p1', 'bytes');
    expect(frames).toEqual(['bytes']);
    fire('termFrame', 'other', 'lost');
    fire('termClosed', 'p1', 'gone');
    expect(closed).toEqual(['gone']);
    expect(termWatchers.has(SID)).toBe(false);
    fire('termClosed', 'p1', 'again');
    expect(closed).toEqual(['gone']);
  });
});
