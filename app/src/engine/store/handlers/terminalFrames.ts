import {sid, type Conn} from '../registry';
import {termWatchers} from '../terminal';
import type {HandlerCtx} from './types';

export function wireTerminalFrames(conn: Conn, _ctx: HandlerCtx): void {
  const client = conn.client;

  client.on('termFrame', (paneId, f) => termWatchers.get(sid(conn.key, paneId))?.onFrame(f));
  client.on('termMode', (paneId, mode) => termWatchers.get(sid(conn.key, paneId))?.onMode?.(mode));
  client.on('termClosed', (paneId, why) => {
    const id = sid(conn.key, paneId);
    const w = termWatchers.get(id);
    if (!w) return;
    termWatchers.delete(id);
    w.onClosed(why);
  });
}
