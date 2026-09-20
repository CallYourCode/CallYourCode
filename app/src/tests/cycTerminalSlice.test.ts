import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {conns, sessions, type Conn} from '../engine/store/registry';
import {
  watchTerminal,
  resizeTerminal,
  sendTerminalInput,
  scrollTerminal,
  termWatchers,
  type TerminalWatcher
} from '../engine/store/terminal';
import type {CycEngineSession} from '../engine/store';
const KEY = 'ws://fake-terminal.test:7788/ws';
const SID = KEY + '|p9';
function plant() {
  const calls: Record<string, unknown[][]> = {
    open: [],
    close: [],
    resize: [],
    input: [],
    scroll: []
  };
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
      openTerminal: (...a: unknown[]) => calls.open.push(a),
      closeTerminal: (...a: unknown[]) => calls.close.push(a),
      resizeTerminal: (...a: unknown[]) => calls.resize.push(a),
      sendTerminalInput: (...a: unknown[]) => calls.input.push(a),
      scrollTerminal: (...a: unknown[]) => calls.scroll.push(a)
    }
  } as unknown as Conn;
  conns.push(conn);
  sessions.set(SID, {
    id: SID,
    engineKey: KEY,
    paneId: 'p9',
    tabKey: '',
    name: 'p9',
    cwd: '',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [],
    claudeSessionId: null,
    events: [],
    agentRuns: []
  } as unknown as CycEngineSession);
  return {conn, calls};
}
function watcher(): TerminalWatcher & {closed: string[]} {
  const closed: string[] = [];
  return {onFrame: vi.fn(), onClosed: (why) => closed.push(why), closed};
}
describe('terminal slice', () => {
  let world: ReturnType<typeof plant>;
  beforeEach(() => {
    world = plant();
  });
  afterEach(() => {
    conns.splice(conns.indexOf(world.conn), 1);
    sessions.clear();
    termWatchers.clear();
  });
  test('watch opens the session pane at the measured size', () => {
    const w = watcher();
    watchTerminal(SID, 80, 24, w);
    expect(world.calls.open).toEqual([['p9', 80, 24]]);
    expect(termWatchers.get(SID)).toBe(w);
  });
  test('a second watcher replaces the first, which is told so', () => {
    const w1 = watcher();
    watchTerminal(SID, 80, 24, w1);
    const w2 = watcher();
    watchTerminal(SID, 60, 20, w2);
    expect(w1.closed).toEqual(['replaced']);
    expect(termWatchers.get(SID)).toBe(w2);
  });
  test('stop releases the engine bridge and only its own registration', () => {
    const w1 = watcher();
    const stop1 = watchTerminal(SID, 80, 24, w1);
    const w2 = watcher();
    watchTerminal(SID, 60, 20, w2);
    stop1();
    expect(termWatchers.get(SID)).toBe(w2);
    expect(world.calls.close.length).toBe(1);
  });
  test('a session with no engine is answered, not left silent', () => {
    const w = watcher();
    const stop = watchTerminal('nope|x', 80, 24, w);
    expect(w.closed).toEqual(['not connected to this engine']);
    stop();
  });
  test('input/resize/scroll are guarded on a live watcher', () => {
    sendTerminalInput(SID, {text: 'ls'});
    resizeTerminal(SID, 100, 30);
    scrollTerminal(SID, 'up', 3);
    expect(world.calls.input).toHaveLength(0);
    expect(world.calls.resize).toHaveLength(0);
    expect(world.calls.scroll).toHaveLength(0);
    watchTerminal(SID, 80, 24, watcher());
    sendTerminalInput(SID, {text: 'ls'});
    resizeTerminal(SID, 100, 30);
    scrollTerminal(SID, 'down', 5);
    expect(world.calls.input).toEqual([['p9', {text: 'ls'}]]);
    expect(world.calls.resize).toEqual([['p9', 100, 30]]);
    expect(world.calls.scroll).toEqual([['p9', 'down', 5]]);
  });
});
