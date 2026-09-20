import type {FrameHandler} from './types';

const termFrame: FrameHandler = (ctx, frame) => {
  if (typeof frame.bytes !== 'string') return;
  ctx.emit('termFrame', String(frame.id), {
    full: frame.full === true,
    seq: Number(frame.seq) || 0,
    cols: Number(frame.cols) || 0,
    rows: Number(frame.rows) || 0,
    bytes: frame.bytes
  });
};

const termMode: FrameHandler = (ctx, frame) => {
  const mode = frame.mode;
  if (mode === 'scroll' || mode === 'wheel' || mode === 'none') {
    ctx.emit('termMode', String(frame.id ?? ''), mode);
  }
};

const termClosed: FrameHandler = (ctx, frame) => {
  const id = String(frame.id ?? '');

  ctx.terms.delete(id);
  ctx.emit('termClosed', id, String(frame.why ?? 'closed'));
};

export const terminalFrameHandlers: [string, FrameHandler][] = [
  ['term-frame', termFrame],
  ['term-mode', termMode],
  ['term-closed', termClosed]
];
