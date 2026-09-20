import * as intents from '../intents';
import type {SendPayload} from '../intents';
import * as drain from '../sync/drain';
import * as transfers from '../transfers/worker';
import {cyclog} from '@/shared/logging';
import type {CycReplyTo} from '../../types';
import type {CycEngineMessage, CycEngineSession} from './types';
import {connOf, findLocal, notifyNow, sessions} from './registry';
import {stampRowId} from './rows/core';
import {clearAck, discardSend, quoteForWire, sendText} from './sends';

type VoiceNoteDeps = {
  cacheTail(s: CycEngineSession): void;
};
let vnDeps: VoiceNoteDeps = {cacheTail: () => {}};
export function wireVoiceNotes(d: VoiceNoteDeps): void {
  vnDeps = d;
}

export function beginVoiceNote(
  sessionId: string,
  opts: {text: string; committed: number; durationS: number; cid?: string; replyTo?: CycReplyTo}
): string {
  const s = sessions.get(sessionId);
  if (!s) {
    cyclog('draft.refused', {
      cid: opts.cid,
      session: sessionId,
      why: 'no such session in the store, so the release made no messageNode at all'
    });
    return '';
  }
  // The draft carries its recording cid from birth when it has one, so its one
  // durable name is `m:c:<cid>` -- the same name its send will keep through
  // commit, echo and reload -- and the localId a settlement holds never dangles.
  const msg: CycEngineMessage = stampRowId({
    id: '',
    role: 'user',
    kind: 'voice',
    text: opts.text,
    ts: Date.now(),
    status: 'sending',
    durationS: opts.durationS,
    ...(opts.cid ? {cid: opts.cid} : {}),
    draftCommitted: Math.max(0, Math.min(opts.committed, opts.text.length))
  });

  if (opts.replyTo) msg.replyTo = opts.replyTo;
  s.messages.push(msg);
  notifyNow();
  cyclog('draft.created', {
    cid: opts.cid,
    session: sessionId,
    localId: msg.id,
    durationS: opts.durationS,
    chars: opts.text.length
  });
  return msg.id;
}

export function noteClip(m: CycEngineMessage) {
  if (m.role !== 'user' || m.kind !== 'voice') return;
  if (m.msgId) delete m.clipLost;
  else m.clipLost = true;
}

export function updateVoiceNote(
  sessionId: string,
  localId: string,
  text: string,
  committed?: number,
  cid?: string
) {
  const m = findLocal(sessionId, localId);
  if (!m || m.draftCommitted === undefined) {
    cyclog('partial.dropped', {
      cid,
      session: sessionId,
      localId,
      chars: text.length,
      why: !m
        ? 'the messageNode is gone from the store'
        : 'the transcript has already settled on this messageNode'
    });
    return;
  }
  m.text = text;
  m.draftCommitted = Math.max(0, Math.min(committed ?? text.length, text.length));
  notifyNow();
}

export function commitVoiceNote(
  sessionId: string,
  localId: string,
  text: string,
  opts: {
    msgId?: string;
    durationS?: number;
    cid?: string;
    replyTo?: CycReplyTo;
    // The clip is not on the engine yet: it rides the resumable transfer queue
    // under this key (== the transfer row's key == the clipVault key). The
    // commit then writes a send-voice intent instead of a plain wire, and the
    // wire ships only once the transfer finishes with the clip's msgId; a
    // failed transfer fails the bubble with retry, never silently. The key
    // becomes the message's cid so the executor, the progress paint and the
    // retry path all find the same row.
    transferKey?: string;
    // What the on-device streaming decoder already settled, for an empty-body
    // commit the engine will transcribe: rides the wire as partials[{id: cid}]
    // so the engine decodes only the tail past upToS and prepends this text.
    partial?: {text: string; upToS: number};
  } = {}
) {
  const clean = text.trim();
  // A msgId in hand means the clip already landed: the transfer has done its
  // job and the plain wire (naming the msgId) is all that is owed.
  const moving = opts.transferKey !== undefined && !opts.msgId;
  const m = findLocal(sessionId, localId);
  cyclog('commit.start', {
    cid: opts.cid,
    session: sessionId,
    localId,
    msgId: opts.msgId,
    transferKey: moving ? opts.transferKey : undefined,
    chars: clean.length,
    durationS: opts.durationS,
    messageNode: !!m
  });
  if (!m && !moving) {
    cyclog('commit.no-messageNode', {
      cid: opts.cid,
      session: sessionId,
      localId,
      why: 'the optimistic messageNode is gone; sending as a plain message instead'
    });
    sendText(sessionId, clean, {
      kind: 'voice',
      msgId: opts.msgId,
      durationS: opts.durationS,
      cid: opts.cid,
      replyTo: opts.replyTo
    });
    return;
  }

  if (!clean && !opts.msgId && !moving) {
    discardVoiceNote(
      sessionId,
      localId,
      opts.cid,
      'no words and no clip: there is genuinely nothing to send'
    );
    return;
  }
  const s = sessions.get(sessionId);
  const owner = s && connOf(s.engineKey);

  if (!s || !owner) {
    cyclog('commit.dropped', {
      cid: opts.cid,
      session: sessionId,
      localId,
      msgId: opts.msgId,
      chars: clean.length,
      why: !s
        ? 'no session, for a messageNode findLocal just found inside one'
        : "the session's engine is not in the connection list built at load"
    });
    return;
  }
  // A clip still moving pins the cid to its transfer key: the send-voice
  // executor finds the bubble by cid == key, the worker paints progress on it,
  // and a retry tap reaches the kept bytes through m.clipKey.
  const cid =
    (moving ? opts.transferKey : undefined) ??
    opts.cid ??
    crypto.randomUUID?.() ??
    Date.now().toString(36) + Math.random().toString(36).slice(2);
  const reply = opts.replyTo ?? m?.replyTo;
  const excerpt = (reply?.text ?? '').trim();
  const wire = clean && excerpt ? quoteForWire(excerpt) + '\n\n' + clean : clean;
  if (m) {
    // An empty-body commit (the engine fills the words) on a still-streaming
    // row keeps the streamed display and its draftCommitted, so the device's
    // words keep painting the bubble while the engine reads the clip; the
    // engine's delivery reconciles the final text. A bodied commit is the
    // transcript itself and settles the row as before.
    if (clean || m.draftCommitted === undefined) {
      m.text = clean;
      delete m.draftCommitted;
    }
    if (opts.msgId) m.msgId = opts.msgId;
    if (opts.durationS !== undefined) m.durationS = opts.durationS;
    if (opts.replyTo && !m.replyTo) m.replyTo = opts.replyTo;
    if (wire !== clean) m.wireText = wire;
    m.cid = cid;
    if (moving) m.clipKey = opts.transferKey;
  }
  const durationS = opts.durationS ?? m?.durationS;
  s.thinking = true;
  notifyNow();
  // With a msgId the clip is on the engine already: the intent is the wire that
  // names it, an ordinary send the drain writes in order. With a transferKey
  // the clip is still moving: the send-voice executor holds the wire until the
  // transfer's result names the msgId (or fails the bubble with retry). Its row
  // reaches disk only after the transfer's bytes are parked, so a row on disk
  // never names bytes it does not have.
  intents.put(
    {
      id: cid,
      engineKey: s.engineKey,
      sessionId,
      kind: moving ? 'send-voice' : 'send-text',
      localId,
      payload: {
        cid,
        sessionId,
        ts: m?.ts ?? Date.now(),
        text: clean,
        kind: 'voice',
        durationS,
        msgId: opts.msgId,
        replyTo: reply,
        wire,
        ...(moving ? {clipKey: opts.transferKey, transferKey: opts.transferKey} : {}),
        // The device's settled streaming words, named by the frame's cid: the
        // engine reads only the clip's tail past upToS and prepends these.
        ...(opts.partial ? {partials: [{id: cid, ...opts.partial}]} : {})
      } satisfies SendPayload
    },
    moving ? {after: transfers.enqueued(opts.transferKey!)} : {}
  );
  drain.kick(s.engineKey);
}

export function markVoiceNoteSafe(
  sessionId: string,
  localId: string,
  msgId: string,
  durationS?: number,
  cid?: string
) {
  const m = findLocal(sessionId, localId);
  if (!m) {
    cyclog('safe.no-messageNode', {
      cid,
      session: sessionId,
      localId,
      msgId,
      why: 'the clip is on the engine but its messageNode is gone, so no tick is drawn'
    });
    return;
  }
  cyclog('note.safe', {cid, session: sessionId, localId, msgId, durationS});
  m.msgId = msgId;
  if (durationS !== undefined && m.durationS === undefined) m.durationS = durationS;
  m.status = 'sent';
  noteClip(m);
  vnDeps.cacheTail(sessions.get(sessionId)!);
  notifyNow();
}

export function failVoiceNote(sessionId: string, localId: string, cid?: string) {
  const m = findLocal(sessionId, localId);
  if (!m || m.status !== 'sending') {
    cyclog('fail.noop', {
      cid,
      session: sessionId,
      localId,
      status: m?.status,
      why: !m
        ? 'the messageNode is already gone'
        : 'the note is no longer in flight, so there is nothing to mark failed'
    });
    return;
  }
  cyclog('note.failed', {
    cid,
    session: sessionId,
    localId,
    chars: m.text.length,
    why: 'nothing got through: no words, and no clip on the engine either'
  });
  m.status = 'failed';
  delete m.draftCommitted;
  noteClip(m);

  if (m.cid) {
    clearAck(m.cid);
    drain.fail(m.cid, 'nothing got through: no words, and no clip on the engine either');
  }
  notifyNow();
}

export function discardVoiceNote(
  sessionId: string,
  localId: string,
  cid?: string,
  why = 'unstated'
) {
  const s = sessions.get(sessionId);
  if (!s) {
    cyclog('discard.miss', {
      cid,
      session: sessionId,
      localId,
      why,
      detail: 'no such session; nothing to remove'
    });
    return;
  }
  const i = s.messages.findIndex((m) => m.id === localId);
  if (i < 0) {
    cyclog('discard.miss', {
      cid,
      session: sessionId,
      localId,
      why,
      detail: 'no such messageNode; it was already gone'
    });
    return;
  }
  const gone = s.messages[i] as CycEngineMessage;
  cyclog('note.discarded', {
    cid,
    session: sessionId,
    localId,
    why,
    chars: gone.text.length,
    durationS: gone.durationS,
    msgId: gone.msgId,
    text: gone.text.slice(0, 80)
  });

  // Discarded: its intent goes, and every transfer row it owned goes with it,
  // queued and active ones too (a settle prunes only finished rows; a discard
  // must not leave a queued upload to run once the engine is back).
  if (gone.cid) discardSend(gone.cid);
  s.messages.splice(i, 1);
  notifyNow();
}
