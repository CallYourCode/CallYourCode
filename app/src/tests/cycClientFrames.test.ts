import {describe, expect, test} from 'vitest';
import {dispatchFrame} from '../engine/frames';
import type {FrameContext, TermSize} from '../engine/frames/types';
type Emitted = [string, unknown[]];
function fakeCtx() {
  const emitted: Emitted[] = [];
  const remembered: string[] = [];
  const ctx: FrameContext = {
    url: 'ws://engine-a.test:7788/ws',
    emit: (ev, ...args) => {
      emitted.push([ev, args]);
    },
    engineObjectUrl: (path: string) => 'http://engine-a.test:7788' + path,
    rememberUserHost: (uh: string) => {
      remembered.push(uh);
    },
    canDo: new Set<string>(),
    voiceHealthyState: true,
    attachedId: undefined as unknown as string,
    tailedId: null,
    terms: new Map<string, TermSize>()
  };
  return {ctx, emitted, remembered};
}
describe('dispatchFrame: the registry', () => {
  test('an unknown frame type is ignored', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {t: 'registered'});
    dispatchFrame(ctx, {t: 'future-frame', id: 'x'});
    dispatchFrame(ctx, null);
    dispatchFrame(ctx, {});
    expect(emitted).toEqual([]);
  });
  test('a frame named after an Object.prototype member misses cleanly', () => {
    const {ctx, emitted} = fakeCtx();

    for (const t of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      dispatchFrame(ctx, {t});
    }
    expect(emitted).toEqual([]);
  });
  test('ping is NOT in the registry: the liveness reply lives in client.ts', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {t: 'ping', n: 3});
    expect(emitted).toEqual([]);
  });
});
describe('chat family', () => {
  test('a user chat frame emits the decoded message (no separate echo owner)', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {t: 'chat', id: 's1', role: 'user', text: 'hi', ts: 5, cid: 'c9'});
    expect(emitted.length).toBe(1);
    const [ev, args] = emitted[0];
    expect(ev).toBe('chat');
    expect(args[0]).toMatchObject({id: 's1', role: 'user', text: 'hi', ts: 5, cid: 'c9'});
  });
  test('a claude chat frame emits like any other', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {t: 'chat', id: 's1', role: 'claude', text: 'hello', ts: 5});
    expect(emitted.length).toBe(1);
    const [ev, args] = emitted[0];
    expect(ev).toBe('chat');
    expect(args[0]).toMatchObject({id: 's1', role: 'claude', text: 'hello', ts: 5});
  });
  test('attach-ok: pages decode like live chat frames, flags rebuilt', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {
      t: 'attach-ok',
      id: 's1',
      known: true,
      pointer: 4,
      pointerPage: 0,
      tailPage: 1,
      pageSize: 50,
      total: 51,
      pages: [
        {
          page: 1,
          version: 2,
          sealed: false,
          messages: [{id: 's1', role: 'claude', text: 'a', ts: 1, seq: 50}, 'garbage']
        }
      ]
    });
    const [ev, args] = emitted[0];
    expect(ev).toBe('attachOk');
    const a = args[0] as any;
    expect(a).toMatchObject({id: 's1', known: true, pointer: 4, tailPage: 1, total: 51});
    expect(a.pages[0].messages.length).toBe(1);
    expect(a.pages[0].messages[0].seq).toBe(50);
  });
  test('attach-ok: known:false survives, absent pages stay absent', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {t: 'attach-ok', id: 'gone', known: false});
    const a = emitted[0][1][0] as any;
    expect(a.known).toBe(false);
    expect(a.pages).toBeUndefined();
  });
  test('attach-ok: a page carries messages and t:s records together, split by the decoder', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {
      t: 'attach-ok',
      id: 's1',
      known: true,
      pointer: 0,
      pointerPage: 0,
      tailPage: 0,
      pageSize: 100,
      total: 5,
      pages: [
        {
          page: 0,
          version: 5,
          sealed: false,
          messages: [
            {id: 's1', role: 'user', text: 'fix it', ts: 10, seq: 0},
            {
              t: 's',
              seq: 1,
              ts: 11,
              id: 'se-aaaaaaaaaaaaaaaa',
              kind: 'tool',
              text: 'Read a.ts',
              tool: {name: 'Read'}
            },
            {
              t: 's',
              seq: 2,
              ts: 12,
              id: 'se-bbbbbbbbbbbbbbbb',
              kind: 'status',
              text: 'status: working',
              status: 'working'
            },
            {
              t: 's',
              seq: 3,
              ts: 13,
              id: 'se-cccccccccccccccc',
              kind: 'prompt',
              text: '[Request interrupted by user]'
            },
            {id: 's1', role: 'claude', text: 'done', ts: 14, seq: 4}
          ]
        }
      ]
    });
    const a = emitted[0][1][0] as any;
    expect(a.pages[0].messages.map((m: any) => m.seq)).toEqual([0, 4]);
    expect(a.pages[0].events).toEqual([
      {uuid: 'se-aaaaaaaaaaaaaaaa', ts: 11, seq: 1, kind: 'tool', text: 'Read a.ts', tool: 'Read'},
      {uuid: 'se-bbbbbbbbbbbbbbbb', ts: 12, seq: 2, kind: 'status', text: 'status: working'},
      {uuid: 'se-cccccccccccccccc', ts: 13, seq: 3, kind: 'interrupt', text: 'interrupted by user'}
    ]);
    expect(emitted.length, 'ONE frame: no session-events follows the open').toBe(1);
  });
  test('session-event: the live delta is one record in the same shape as a page row', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {
      t: 'session-event',
      id: 's1',
      ev: {
        seq: 7,
        ts: 20,
        id: 'se-dddddddddddddddd',
        kind: 'reply',
        text: 'on it',
        src: {h: 'claude', sid: 'x', rid: 'u1', off: 0}
      }
    });
    expect(emitted[0]).toEqual([
      'sessionEvent',
      ['s1', {uuid: 'se-dddddddddddddddd', ts: 20, seq: 7, kind: 'reply', text: 'on it'}]
    ]);
    dispatchFrame(ctx, {t: 'session-event', id: 's1', ev: {ts: 1, kind: 'reply'}});
    expect(emitted.length, 'a record with no id is dropped').toBe(1);
  });
  test('send-failed: the offline reason rides the cid (F1)', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {
      t: 'send-failed',
      id: 's1',
      cid: 'c7',
      reason: 'the session is offline; message not delivered'
    });
    expect(emitted[0]).toEqual([
      'sendFailed',
      [{id: 's1', cid: 'c7', reason: 'the session is offline; message not delivered'}]
    ]);
  });
  test('send-failed: no cid is ignored; a missing reason gets a default', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {t: 'send-failed', id: 's1'});
    expect(emitted).toEqual([]);
    dispatchFrame(ctx, {t: 'send-failed', id: 's1', cid: 'c8'});
    expect(emitted[0]).toEqual([
      'sendFailed',
      [{id: 's1', cid: 'c8', reason: 'the session is offline; message not delivered'}]
    ]);
  });
  test('dequeued sanitises id and ts', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {t: 'dequeued', id: 's1', ts: 'later'});
    expect(emitted[0]).toEqual(['dequeued', ['s1', 0]]);
  });
});
describe('sessions family', () => {
  test('sessions: rows rebuilt with defaults, photo joined to THIS engine', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {
      t: 'sessions',
      list: [
        {
          id: 'p1',
          name: 'herdr',
          cwd: '/w',
          unread: 2,
          photo: '/photo/p1.jpg',
          model: '  Opus 4.8  ',
          replyLevel: 4,
          sessionAgentId: 'ag-AAAAAAAAAAAAAAAA',
          settings: {muted: true, speed: 2}
        },
        {id: 'p2', alive: false, model: null, sessionAgentId: 42}
      ]
    });
    const [ev, args] = emitted[0];
    expect(ev).toBe('sessions');
    const [list, tabs] = args as [any[], any[]];
    expect(list[0]).toMatchObject({
      id: 'p1',
      name: 'herdr',
      unread: 2,
      alive: true,
      photo: 'http://engine-a.test:7788/photo/p1.jpg',
      model: 'Opus 4.8',
      replyLevel: 4,
      sessionAgentId: 'ag-AAAAAAAAAAAAAAAA'
    });
    expect(list[0].settings).toEqual({muted: true});
    expect(list[1]).toMatchObject({id: 'p2', name: 'p2', alive: false, photo: null, model: null});
    expect(list[1].sessionAgentId).toBeUndefined();
    expect(tabs).toEqual([]);
  });
  test('sessions: a malformed ask drops WHOLE and surfaces as askUnknown when blocked', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {
      t: 'sessions',
      list: [
        {
          id: 'p1',
          status: 'blocked',
          ask: {
            question: 'Allow?',
            fingerprint: 'fp',
            choices: [
              {n: 1, label: 'Yes'},
              {n: 2, label: ''}
            ]
          }
        }
      ]
    });
    const row = (emitted[0][1][0] as any[])[0];
    expect(row.ask).toBeUndefined();
    expect(row.askUnknown).toBe(true);
  });
  test('sessions: a well-formed ask passes with its choices', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {
      t: 'sessions',
      list: [
        {
          id: 'p1',
          ask: {
            question: 'Allow?',
            fingerprint: 'fp',
            context: ['line', 7],
            choices: [
              {n: 1, label: 'Yes', detail: 'runs it'},
              {n: 2, label: 'No', freeText: true}
            ]
          }
        }
      ]
    });
    const row = (emitted[0][1][0] as any[])[0];
    expect(row.ask).toEqual({
      question: 'Allow?',
      fingerprint: 'fp',
      context: ['line'],
      choices: [
        {n: 1, label: 'Yes', detail: 'runs it'},
        {n: 2, label: 'No', freeText: true}
      ]
    });
    expect(row.askUnknown).toBeUndefined();
  });
  test('sessions: malformed tabs drop whole, good ones survive', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {
      t: 'sessions',
      list: [],
      tabs: [
        {key: 'work', title: {text: 'Work', detail: 'laptop'}},
        {key: 'broken'},
        {title: {text: 'NoKey'}}
      ]
    });
    const tabs = emitted[0][1][1] as any[];
    expect(tabs).toEqual([{key: 'work', title: {text: 'Work', detail: 'laptop'}}]);
  });
  test('session-id-changed migrates attach state BEFORE emitting', () => {
    const {ctx, emitted} = fakeCtx();
    ctx.attachedId = 'old';
    ctx.tailedId = 'old';
    ctx.terms.set('old', {cols: 80, rows: 24});
    let atEmit: [string, string | null, TermSize | undefined] | null = null;
    const emit = ctx.emit;
    ctx.emit = ((ev: string, ...args: unknown[]) => {
      atEmit = [ctx.attachedId, ctx.tailedId, ctx.terms.get('new')];
      (emit as (...a: unknown[]) => void)(ev, ...args);
    }) as FrameContext['emit'];
    dispatchFrame(ctx, {t: 'session-id-changed', from: 'old', to: 'new'});
    expect(atEmit).toEqual(['new', 'new', {cols: 80, rows: 24}]);
    expect(ctx.terms.has('old')).toBe(false);
    expect(emitted[0]).toEqual(['sessionIdChanged', ['old', 'new']]);
  });
  test('session-id-changed: same or missing ids do nothing', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {t: 'session-id-changed', from: 'a', to: 'a'});
    dispatchFrame(ctx, {t: 'session-id-changed', from: '', to: 'b'});
    expect(emitted).toEqual([]);
  });
  test('compact-result and answer-result sanitise their fields', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {t: 'compact-result', id: 's1', ok: true, tell: 'compacted'});
    dispatchFrame(ctx, {t: 'answer-result', id: 's1', ok: false, reason: 'stale', detail: 7});
    expect(emitted[0]).toEqual(['compactResult', ['s1', true, 'compacted']]);
    expect(emitted[1]).toEqual(['answerResult', ['s1', false, 'stale', undefined]]);
  });
});
describe('terminal family', () => {
  test('term-frame requires string bytes and rebuilds the shape', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {
      t: 'term-frame',
      id: 's1',
      full: true,
      seq: 3,
      cols: 80,
      rows: 24,
      bytes: 'AAAA'
    });
    dispatchFrame(ctx, {t: 'term-frame', id: 's1', bytes: 42});
    expect(emitted).toEqual([
      ['termFrame', ['s1', {full: true, seq: 3, cols: 80, rows: 24, bytes: 'AAAA'}]]
    ]);
  });
  test('term-mode passes only the three known modes', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {t: 'term-mode', id: 's1', mode: 'wheel'});
    dispatchFrame(ctx, {t: 'term-mode', id: 's1', mode: 'hover'});
    expect(emitted).toEqual([['termMode', ['s1', 'wheel']]]);
  });
  test('term-closed forgets the pane BEFORE telling anyone', () => {
    const {ctx, emitted} = fakeCtx();
    ctx.terms.set('s1', {cols: 80, rows: 24});
    let openAtEmit: boolean | null = null;
    const emit = ctx.emit;
    ctx.emit = ((ev: string, ...args: unknown[]) => {
      openAtEmit = ctx.terms.has('s1');
      (emit as (...a: unknown[]) => void)(ev, ...args);
    }) as FrameContext['emit'];
    dispatchFrame(ctx, {t: 'term-closed', id: 's1', why: 'exited'});
    expect(openAtEmit).toBe(false);
    expect(emitted[0]).toEqual(['termClosed', ['s1', 'exited']]);
  });
});
describe('engine family', () => {
  test('can: replaced whole, strings only, no event', () => {
    const {ctx, emitted} = fakeCtx();
    ctx.canDo = new Set(['old-power']);
    dispatchFrame(ctx, {t: 'can', list: ['words', 42, 'pi-agent']});
    expect([...ctx.canDo]).toEqual(['words', 'pi-agent']);
    expect(emitted).toEqual([]);
  });
  test('voice: the url routes nothing any more, health emits only on change', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {t: 'voice', url: 'http://voice.test:7789/'});
    expect(emitted).toEqual([]);
    dispatchFrame(ctx, {t: 'voice', url: 'http://voice.test:7789', healthy: false});
    expect(ctx.voiceHealthyState).toBe(false);
    expect(emitted).toEqual([['voiceHealth', [false]]]);
    dispatchFrame(ctx, {t: 'voice', url: 'http://voice.test:7789', healthy: false});
    expect(emitted.length).toBe(1);
  });
  test('host: remembers user@host for pairing, then emits', () => {
    const {ctx, emitted, remembered} = fakeCtx();
    dispatchFrame(ctx, {t: 'host', user: 'ada', host: 'boxer'});
    expect(remembered).toEqual(['ada@boxer']);
    expect(emitted[0]).toEqual(['host', ['ada', 'boxer']]);
  });
  test('schedules: an unknown frame is dropped whole', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {t: 'schedules', list: [{id: 'sch1'}]});
    expect(emitted).toEqual([]);
  });
});
describe('say family', () => {
  test('say carries text, origin and the growing flag', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {
      t: 'say',
      id: 's1',
      msgId: 'm1',
      text: 'hi',
      origin: 'dev1',
      growing: true
    });
    dispatchFrame(ctx, {t: 'say-grow', id: 's1', msgId: 'm1', durS: 2.5, chars: 40});
    dispatchFrame(ctx, {t: 'say-done', id: 's1', msgId: 'm1', durationS: 'soon'});
    expect(emitted).toEqual([
      ['say', ['s1', 'm1', 'hi', 'dev1', true]],
      ['sayGrow', ['s1', 'm1', 2.5, 40]],
      ['sayDone', ['s1', 'm1', undefined]]
    ]);
  });
  test('say-live and say-live-fail carry the pane and the msgId', () => {
    const {ctx, emitted} = fakeCtx();
    dispatchFrame(ctx, {t: 'say-live', id: 's1', msgId: 'm1'});
    dispatchFrame(ctx, {t: 'say-live-fail', id: 's1', msgId: 'm1'});
    expect(emitted).toEqual([
      ['sayLive', ['s1', 'm1']],
      ['sayLiveFail', ['s1', 'm1']]
    ]);
  });
});
