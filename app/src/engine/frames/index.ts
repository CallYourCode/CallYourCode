import {chatFrameHandlers} from './chat';
import {engineFrameHandlers} from './engine';
import {sayFrameHandlers} from './say';
import {sessionFrameHandlers} from './sessions';
import {terminalFrameHandlers} from './terminal';
import type {FrameContext, FrameHandler} from './types';

const registry = new Map<string, FrameHandler>([
  ...sessionFrameHandlers,
  ...chatFrameHandlers,
  ...sayFrameHandlers,
  ...terminalFrameHandlers,
  ...engineFrameHandlers
]);

export function dispatchFrame(ctx: FrameContext, frame: any): void {
  const handler = typeof frame?.t === 'string' ? registry.get(frame.t) : undefined;
  if (handler) handler(ctx, frame);
}
