import {dataState, sessionState} from '@/sessionState';
import type {CycMessage, CycSession} from '@/types';
import type {CycEngineSession, CycTabInfo} from '@/engine/store';
import {TEST_FIXTURE_NAMES, TEST_HOSTS, type TestSessionFixture} from './testFixtures';
import {rowIdOfMessage} from '@/engine/store/rows/core';

export {TEST_FIXTURE_NAMES, TEST_HOSTS};

export function isTestMode(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has('testmode');
}

function msg(role: CycMessage['role'], text: string, agoMs: number): CycMessage {
  const m: CycMessage = {id: '', role, kind: 'text', text, ts: Date.now() - agoMs, status: 'sent'};
  // Fixtures carry no engine mid, so their one durable id falls to the
  // ts|role|text spelling -- unique here because each fixture row has a distinct
  // instant. Computed by the one id function, like every real row.
  m.id = rowIdOfMessage(m);
  return m;
}

function toSession(hostKey: string, tabKey: string, spec: TestSessionFixture): CycEngineSession {
  const messages: CycMessage[] = [];
  for (const t of spec.turns) {
    messages.push(msg('user', t.user, t.agoMs + 20_000));
    messages.push(msg('claude', t.reply, t.agoMs));
  }
  for (const e of spec.extras ?? []) {
    const m = msg(e.role, e.text ?? '', e.agoMs);
    if (e.voice) {
      m.kind = 'voice';
      m.durationS = e.voice.durationS;
    }
    if (e.file) m.file = {docId: `test-doc-${spec.id}-${m.id}`, ...e.file};
    messages.push(m);
  }
  const last = messages[messages.length - 1]?.ts ?? Date.now();
  return {
    id: spec.id,
    name: spec.name,
    cwd: `/tmp/cyc-test/${spec.id}`,
    unread: spec.unread ?? 0,
    muted: false,
    thinking: spec.thinking === true,
    messages,
    lastActivity: last,
    status: spec.thinking ? 'working' : 'idle',
    engineKey: hostKey,
    paneId: spec.id,
    tabKey,
    alive: true,
    claudeSessionId: null,
    events: [],
    agentRuns: []
  };
}

export function testEngineSessions(): CycSession[] {
  return TEST_HOSTS.flatMap((host) =>
    host.sessions.map((s) => toSession(host.engineKey, host.tabId, s))
  );
}

export function testEngineTabs(): CycTabInfo[] {
  return TEST_HOSTS.map((host) => ({
    id: host.tabId,
    engineKey: host.engineKey,
    tabKey: host.tabId,
    label: host.label,
    detail: host.detail,
    state: 'connected' as const,
    unread: host.sessions.reduce((n, s) => n + (s.unread ?? 0), 0),
    activity: host.sessions.some((s) => s.thinking)
  }));
}

export function applyTestMode(): void {
  dataState.mode = 'test';
  dataState.demoSessions = testEngineSessions();
  dataState.testTabs = testEngineTabs();
  sessionState.activeTabId = dataState.testTabs[0]?.id ?? null;
}
