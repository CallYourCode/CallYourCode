/* ROSTER_FIELDS diff test.
 *
 * The roster row persists EVERY list-visible field of a session, so the list
 * paints on a cold open exactly as it was. This test pins that in two ways:
 *   1. at the type level: every key of CycEngineSession is either a roster
 *      field or named here as runtime-only (a new field on the session type
 *      breaks tsc until it is sorted into one of the two lists);
 *   2. at run time: ROSTER_FIELDS equals the spec's list, and a fully
 *      populated session round-trips through toStoredSession /
 *      applyStoredSession with every field and markedUnread intact.
 *
 *   bun run test --run src/tests/cycRosterFields.test.ts
 */
import {afterEach, describe, expect, test} from 'vitest';
import {
  ROSTER_FIELDS,
  applyStoredSession,
  toStoredSession,
  type RosterField
} from '../engine/store/roster';
import {markedUnread} from '../engine/store/registry';
import type {CycEngineSession} from '../engine/store/types';

// Fields that live only in memory: chat window, event log, paging state,
// attach bookkeeping. None of them paints the list.
const RUNTIME_ONLY = [
  'engineKey',
  'messages',
  'confirmedSettings',
  'events',
  'agentRuns',
  'replayed',
  'historyAdded',
  'historyPending',
  'awaitingChatStart',
  'historyAskedAt',
  'churnGrey',
  'notOnEngine',
  'engineTotal',
  'loadingOlder',
  'paintSource',
  'pointer',
  'pointerPage',
  'tailPage',
  'pageSize'
] as const satisfies readonly (keyof CycEngineSession)[];

type RuntimeOnly = (typeof RUNTIME_ONLY)[number];
type Unsorted = Exclude<keyof CycEngineSession, RosterField | RuntimeOnly>;
type Overlap = RosterField & RuntimeOnly;
// Both resolve to `never` when every key is sorted exactly once.
const unsorted: Unsorted[] = [];
const overlap: Overlap[] = [];

// The spec's list (offline design v2, section 1): every field the list row,
// the host chip and the badge read.
const SPEC_LIST_VISIBLE = [
  'id',
  'paneId',
  'tabKey',
  'name',
  'cwd',
  'unread',
  'order',
  'alive',
  'lastActivity',
  'heardTs',
  'title',
  'avatarUrl',
  'status',
  'thinking',
  'contextPct',
  'agentName',
  'agentId',
  'sessionAgentId',
  'agentLabel',
  'model',
  'turnSince',
  'replyLevel',
  'claudeSessionId',
  'settings',
  'muted',
  'ask',
  'askUnknown'
];

function fullSession(): CycEngineSession {
  return {
    id: 'ws://e|p1',
    engineKey: 'ws://e',
    paneId: 'p1',
    tabKey: 'work',
    name: 'api',
    cwd: '/home/me/api',
    unread: 3,
    order: 2,
    alive: true,
    lastActivity: 1700000000000,
    heardTs: 1700000000500,
    title: {text: 'Fix the tests', detail: null},
    avatarUrl: 'data:image/png;base64,x',
    status: 'working' as CycEngineSession['status'],
    thinking: true,
    contextPct: 42,
    agentName: 'claude',
    agentId: 'claude-code',
    sessionAgentId: 'agent-1',
    agentLabel: 'Claude Code',
    model: 'opus',
    turnSince: 1700000000200,
    replyLevel: 2,
    claudeSessionId: 'c-1',
    settings: {} as CycEngineSession['settings'],
    muted: true,
    ask: {question: 'Continue?', context: [], choices: [], fingerprint: 'f'},
    askUnknown: false,
    // runtime-only, must not travel
    messages: [{} as CycEngineSession['messages'][number]],
    confirmedSettings: {} as CycEngineSession['confirmedSettings'],
    events: [],
    agentRuns: [],
    replayed: true,
    pointer: 5,
    tailPage: 1
  };
}

afterEach(() => {
  markedUnread.clear();
  void unsorted;
  void overlap;
});

describe('ROSTER_FIELDS', () => {
  test('is exactly the list-visible field set from the spec, no more, no less', () => {
    expect([...ROSTER_FIELDS].sort()).toEqual([...SPEC_LIST_VISIBLE].sort());
    expect(new Set(ROSTER_FIELDS).size).toBe(ROSTER_FIELDS.length);
  });

  test('a session round-trips with every list-visible field and markedUnread', () => {
    const src = fullSession();
    markedUnread.add(src.id);
    const stored = toStoredSession(src);

    for (const f of ROSTER_FIELDS) expect(stored[f], f).toEqual(src[f]);
    expect(stored.markedUnread).toBe(true);
    for (const f of RUNTIME_ONLY) expect(f in stored, f).toBe(false);
    expect(Object.keys(stored).length).toBe(ROSTER_FIELDS.length + 1);

    markedUnread.clear();
    const dst: CycEngineSession = {
      id: src.id,
      engineKey: src.engineKey,
      paneId: src.paneId,
      tabKey: '',
      name: 'p1',
      cwd: '',
      unread: 0,
      muted: false,
      thinking: false,
      alive: false,
      messages: [],
      claudeSessionId: null,
      events: [],
      agentRuns: []
    };
    applyStoredSession(dst, stored);
    for (const f of ROSTER_FIELDS) expect(dst[f], f).toEqual(src[f]);
    expect(markedUnread.has(dst.id)).toBe(true);
    // Runtime-only state stays as the live session had it.
    expect(dst.messages).toEqual([]);
    expect(dst.replayed).toBeUndefined();
  });

  test('a stored row without markedUnread clears a stale local mark', () => {
    const src = fullSession();
    const stored = toStoredSession(src);
    expect(stored.markedUnread).toBe(false);
    markedUnread.add(src.id);
    applyStoredSession(src, stored);
    expect(markedUnread.has(src.id)).toBe(false);
  });

  test('undefined optional fields are not written into the row', () => {
    const s = fullSession();
    delete s.avatarUrl;
    delete s.order;
    const stored = toStoredSession(s);
    expect('avatarUrl' in stored).toBe(false);
    expect('order' in stored).toBe(false);
  });
});
