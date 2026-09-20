import type {EnginePluginDecl} from '../../contract';
import {rememberHostName} from '../../hostNames';
import {notify, type Conn} from '../registry';
import * as sync from '../../sync';
import type {HandlerCtx} from './types';

export function wireLiveness(conn: Conn, _ctx: HandlerCtx): void {
  const client = conn.client;

  client.on('status', (st) => {
    const was = conn.state;
    conn.state = st;

    if (st !== 'connected') conn.helloSettled = false;

    // The client's edges go into the sync manager only (R6); everything that
    // moves bytes subscribes there, and the UI reads its one status word. The
    // wake-up work (the dials resync) runs on the settled edge in store.ts.
    if (st !== was) {
      if (st === 'connecting') sync.noteDialing(conn.key);
      else if (st === 'connected') sync.noteSealed(conn.key);
      else sync.noteDown(conn.key);
    }
    notify();
  });

  client.on('host', (user, host) => {
    if (host) {
      conn.user = user || null;
      conn.host = host;
      rememberHostName(conn.key, conn.user, conn.host);
    }

    conn.helloSettled = true;
    sync.noteHost(conn.key);
    notify();
  });

  client.on('voiceHealth', (healthy) => {
    conn.voiceHealthy = healthy;
    notify();
  });

  client.on('plugins', (list: EnginePluginDecl[]) => {
    conn.plugins = list;
    notify();
  });
}
