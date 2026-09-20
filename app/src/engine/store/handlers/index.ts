import type {Conn} from '../registry';
import type {HandlerCtx} from './types';
import {wireSecurity} from './security';
import {wireLiveness} from './liveness';
import {wireSessions} from './sessions';
import {wireChat} from './chat';
import {wireEvents} from './events';
import {wireTerminalFrames} from './terminalFrames';
import {wireSpeech} from './speech';

export type {HandlerCtx} from './types';

export function wireConnHandlers(conn: Conn, ctx: HandlerCtx): void {
  wireSecurity(conn, ctx);
  wireLiveness(conn, ctx);
  wireSessions(conn, ctx);
  wireChat(conn, ctx);
  wireEvents(conn, ctx);
  wireTerminalFrames(conn, ctx);
  wireSpeech(conn, ctx);
}
