import type {Conn} from '../registry';
import type {HandlerCtx} from './types';
import {writeEvent} from '../rows/door';
import {noteLive} from '../rows/repl';

/* The live delta: one session record the engine's log just appended for the
 * attached agent. The history of records arrives on the pages (the replicator's
 * backfill), never through a frame of its own; the live record enters the one
 * store door, and the store repaints the open chat only if it touched the
 * visible window. */
export function wireEvents(conn: Conn, ctx: HandlerCtx): void {
  const client = conn.client;

  client.on('sessionEvent', (paneId, ev) => {
    const s = ctx.ensureSession(conn.key, paneId);
    writeEvent(s.id, ev);
    noteLive(s.id, ev.seq);
  });
}
