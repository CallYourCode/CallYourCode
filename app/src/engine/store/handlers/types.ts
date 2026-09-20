import type {CycEngineMessage, CycEngineSession} from '../types';

export interface HandlerCtx {
  ensureSession(engineKey: string, paneId: string): CycEngineSession;
  stripInstruction(text: string): string;
  releaseQueued(s: CycEngineSession, m: CycEngineMessage): boolean;
  releaseQueuedBefore(s: CycEngineSession, replyTs: number): boolean;
  endReplayHold(id: string): void;
  firstPaint(id: string, source: 'cache' | 'replay'): void;
  overlayOn(sessionId: string): boolean;
  rekeySession(engineKey: string, from: string, to: string): string | null;
  reclaimDead(sessionId: string): boolean;
  attachedId(): string;

  fireCompactResult(sessionId: string, ok: boolean, tell: string): void;
  fireAnswerResult(sessionId: string, ok: boolean, reason?: string, detail?: string): void;
  fireSay(sessionId: string, msgId: string, text: string, origin?: string, growing?: boolean): void;
  fireSayGrow(sessionId: string, msgId: string, durS?: number, chars?: number): void;
  fireSayDone(sessionId: string, msgId: string, durationS?: number): void;
  fireSayLive(sessionId: string, msgId: string): void;
  fireSayLiveFail(sessionId: string, msgId: string): void;
}
