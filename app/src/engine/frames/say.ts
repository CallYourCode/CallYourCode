import type {FrameHandler} from './types';

const say: FrameHandler = (ctx, frame) => {
  ctx.emit(
    'say',
    String(frame.id),
    String(frame.msgId),
    String(frame.text ?? ''),
    typeof frame.origin === 'string' ? frame.origin : undefined,
    frame.growing === true
  );
};

const sayGrow: FrameHandler = (ctx, frame) => {
  ctx.emit(
    'sayGrow',
    String(frame.id),
    String(frame.msgId),
    Number.isFinite(frame.durS) ? Number(frame.durS) : undefined,
    Number.isFinite(frame.chars) ? Number(frame.chars) : undefined
  );
};

const sayDone: FrameHandler = (ctx, frame) => {
  ctx.emit(
    'sayDone',
    String(frame.id),
    String(frame.msgId),
    Number.isFinite(frame.durationS) ? Number(frame.durationS) : undefined
  );
};

const sayLive: FrameHandler = (ctx, frame) => {
  ctx.emit('sayLive', String(frame.id), String(frame.msgId));
};

const sayLiveFail: FrameHandler = (ctx, frame) => {
  ctx.emit('sayLiveFail', String(frame.id), String(frame.msgId));
};

export const sayFrameHandlers: [string, FrameHandler][] = [
  ['say', say],
  ['say-grow', sayGrow],
  ['say-done', sayDone],
  ['say-live', sayLive],
  ['say-live-fail', sayLiveFail]
];
