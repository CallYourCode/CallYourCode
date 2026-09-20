import type {EngineAttachOk, EnginePage} from '../contract';
import {decodeChat, decodePage, parseSessionEvent} from '../decodeChat';
import type {FrameHandler} from './types';

const attachOk: FrameHandler = (ctx, frame) => {
  const rawPages: any[] = Array.isArray(frame.pages) ? frame.pages : [];
  const pages: EnginePage[] = rawPages.map(decodePage);
  const a: EngineAttachOk = {
    id: String(frame.id ?? ''),
    known: frame.known !== false
  };
  if (Number.isFinite(frame.pointer)) a.pointer = Number(frame.pointer);
  if (Number.isFinite(frame.pointerPage)) a.pointerPage = Number(frame.pointerPage);
  if (Number.isFinite(frame.tailPage)) a.tailPage = Number(frame.tailPage);
  if (Number.isFinite(frame.pageSize)) a.pageSize = Number(frame.pageSize);
  if (Number.isFinite(frame.total)) a.total = Number(frame.total);
  if (pages.length) a.pages = pages;
  // the engine's authoritative queued-row list (absent on older engines)
  if (Array.isArray(frame.queued)) a.queued = frame.queued.map(Number).filter(Number.isFinite);
  if (Number.isFinite(frame.deltaBase)) a.deltaBase = Number(frame.deltaBase);
  ctx.emit('attachOk', a);
};

const chat: FrameHandler = (ctx, frame) => {
  const m = decodeChat(frame);
  if (m) ctx.emit('chat', m);
};

// The engine took the utterance (section 2b). The echo may still follow; the
// receipt is what settles the send. An ack with err is the nack: the engine
// refused the send for good.
const ack: FrameHandler = (ctx, frame) => {
  if (typeof frame.cid !== 'string' || !frame.cid) return;
  ctx.emit('ack', {
    id: String(frame.id ?? ''),
    cid: frame.cid,
    dup: frame.dup === true,
    ...(typeof frame.msgId === 'string' && frame.msgId ? {msgId: frame.msgId} : {}),
    ...(typeof frame.err === 'string' && frame.err ? {err: frame.err} : {})
  });
};

// The engine could not deliver the send: an offline session (F1). The frame
// carries the cid, so the row it names is marked failed with the reason and
// kept, owed again on the retry tap.
const sendFailed: FrameHandler = (ctx, frame) => {
  if (typeof frame.cid !== 'string' || !frame.cid) return;
  ctx.emit('sendFailed', {
    id: String(frame.id ?? ''),
    cid: frame.cid,
    reason:
      typeof frame.reason === 'string' && frame.reason
        ? frame.reason
        : 'the session is offline; message not delivered'
  });
};

const dequeued: FrameHandler = (ctx, frame) => {
  ctx.emit('dequeued', String(frame.id), Number(frame.ts) || 0);
};

const sessionEvent: FrameHandler = (ctx, frame) => {
  const ev = parseSessionEvent(frame.ev);
  if (ev) ctx.emit('sessionEvent', String(frame.id), ev);
};

export const chatFrameHandlers: [string, FrameHandler][] = [
  ['attach-ok', attachOk],
  ['chat', chat],
  ['ack', ack],
  ['send-failed', sendFailed],
  ['dequeued', dequeued],
  ['session-event', sessionEvent]
];
