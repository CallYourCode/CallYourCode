import {connOf, sessions, sid} from './registry';

export type TerminalWatcher = {
  onFrame(f: {full: boolean; seq: number; cols: number; rows: number; bytes: string}): void;
  onClosed(why: string): void;

  onMode?(mode: 'scroll' | 'wheel' | 'none'): void;
};

export const termWatchers = new Map<string, TerminalWatcher>();

export const TERMINAL_PANE_OVERRIDE = '';
const paneFor = (s: {paneId: string}) => TERMINAL_PANE_OVERRIDE || s.paneId;

export function watchTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  w: TerminalWatcher
): () => void {
  const s = sessions.get(sessionId);
  const owner = s && connOf(s.engineKey);
  if (!s || !owner) {
    w.onClosed('not connected to this engine');
    return () => {};
  }

  const keys = [...new Set([sessionId, sid(s.engineKey, paneFor(s))])];
  for (const k of keys) {
    termWatchers.get(k)?.onClosed('replaced');
    termWatchers.set(k, w);
  }
  owner.client.openTerminal(paneFor(s), cols, rows);
  return () => {
    for (const k of keys) if (termWatchers.get(k) === w) termWatchers.delete(k);
    connOf(s.engineKey)?.client.closeTerminal(paneFor(s));
  };
}

export function resizeTerminal(sessionId: string, cols: number, rows: number) {
  const s = sessions.get(sessionId);
  if (!s || !termWatchers.has(sessionId)) return;
  connOf(s.engineKey)?.client.resizeTerminal(paneFor(s), cols, rows);
}

export function sendTerminalInput(sessionId: string, input: {text: string} | {b64: string}) {
  const s = sessions.get(sessionId);
  if (!s || !termWatchers.has(sessionId)) return;
  connOf(s.engineKey)?.client.sendTerminalInput(paneFor(s), input);
}

export function scrollTerminal(sessionId: string, dir: 'up' | 'down', lines: number) {
  const s = sessions.get(sessionId);
  if (!s || !termWatchers.has(sessionId)) return;
  connOf(s.engineKey)?.client.scrollTerminal(paneFor(s), dir, lines);
}
