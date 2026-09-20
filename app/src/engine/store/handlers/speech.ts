import {endGrowing} from '../../../audio/audioCache';
import {engineThinking, notify, sessions, sid, type Conn} from '../registry';
import {patchMessage} from '../rows/door';
import type {CycEngineMessage} from '../types';
import type {HandlerCtx} from './types';

export function wireSpeech(conn: Conn, ctx: HandlerCtx): void {
  const client = conn.client;

  client.on('say', (paneId, msgId, text, origin, growing) => {
    const id = sid(conn.key, paneId);
    const s = sessions.get(id);
    if (s) {
      if (!engineThinking.has(id)) s.thinking = false;

      notify();
    }
    ctx.fireSay(id, msgId, text, origin, growing);
  });

  client.on('sayGrow', (paneId, msgId, durS, chars) => {
    const id = sid(conn.key, paneId);
    ctx.fireSayGrow(id, msgId, durS, chars);
  });

  client.on('sayDone', (paneId, msgId, durationS) => {
    const id = sid(conn.key, paneId);
    const s = sessions.get(id);
    if (s) {
      const msg = s.messages.find((m) => (m as CycEngineMessage).msgId === msgId) as
        CycEngineMessage | undefined;
      if (msg) {
        delete msg.growing;
        if (durationS !== undefined && durationS > 0) msg.durationS = durationS;
        patchMessage(s, msg);
      }
      endGrowing(msgId);
      notify();
    }
    ctx.fireSayDone(id, msgId, durationS);
  });

  client.on('sayLive', (paneId, msgId) => {
    ctx.fireSayLive(sid(conn.key, paneId), msgId);
  });

  client.on('sayLiveFail', (paneId, msgId) => {
    ctx.fireSayLiveFail(sid(conn.key, paneId), msgId);
  });
}
