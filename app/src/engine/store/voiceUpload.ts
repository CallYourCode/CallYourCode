import * as intents from '../intents';
import type {Alongside, Intent, SendPayload} from '../intents';
import * as drain from '../sync/drain';
import type {DrainOutcome} from '../sync/drain';
import * as clipVault from '../../audio/clipVault';
import * as transfers from '../transfers/worker';
import {cyclog} from '@/shared/logging';
import type {CycReplyTo} from '../../types';
import type {CycEngineMessage} from './types';
import type {ParkedClip} from '../../audio/clipVault';
import {findLocal, notifyNow, sessions} from './registry';
import {stampRowId} from './rows/core';
import {discardSend, findByCid, quoteForWire, writeAndArm} from './sends';

// The honest voice-note send, over the resumable transfer queue (Lane A).
//
// A voice note's payload is its recording. Before this it moved as one blob over
// /user-audio, and on a weak link that single upload stalled or restarted from
// byte zero; a 145 s clip on roaming 4G never arrived. Now the recording rides
// the transfer queue: parked on this device first, then moved to the engine
// chunk by chunk, resuming from its acked chunks across flaps and reloads. The
// message bubble is honest the whole way:
//   - a row exists from the first frame, pending (sending);
//   - the recorded bytes are parked in the clipVault and KEPT until the engine
//     has finished the transfer (release only then);
//   - progress is painted on the bubble as the chunks land;
//   - a send made while the engine is not connected simply waits (a pending
//     clock tick), and the worker drives it on the connected edge;
//   - the message wire (naming the clip's msgId) goes out ONLY once the transfer
//     result is in hand, never before: a voice intent never sends empty.
//
// The intent is a `send-voice` row. Its executor (below) is the whole of
// resume: it looks at the transfer row and either writes the wire, waits for
// the bytes, re-queues a lost row from the kept bytes, or fails for good.

// When a transfer finishes, the drain runs again for that engine and the
// waiting send-voice intent picks up the msgId. Registered once, at module load.
transfers.onResult((row) => {
  if (row.kind !== 'user-audio') return;
  drain.kick(intents.engineKeyOfSessionId(row.sessionId));
});

function failClip(payload: SendPayload, key: string, refused?: string): void {
  const m = findByCid(payload.sessionId, key);
  if (m) {
    m.status = 'failed';
    m.clipLost = true;
    if (refused) m.failReason = refused;
    delete m.sendPct;
  }
  notifyNow();
}

drain.registerExecutor('send-voice', async (intent: Intent): Promise<DrainOutcome> => {
  const payload = intent.payload as SendPayload;
  const s = sessions.get(payload.sessionId);
  const key = payload.transferKey ?? payload.clipKey;
  if (!s) return {failed: 'no such session on this engine'};
  if (!key) return {failed: 'a voice note without a recording key'};
  if (payload.msgId) {
    // The clip is on the engine under msgId already: only the wire is owed.
    // The same cid goes with it, so the engine's dedupe answers a repeat with
    // dup:true and this device never shows two bubbles for one note.
    const m = findByCid(payload.sessionId, key);
    if (m) {
      m.msgId = payload.msgId;
      delete m.sendPct;
      notifyNow();
    }
    return writeAndArm(payload);
  }
  const row = transfers.rowOf(key);
  const msgId = (row?.result as {msgId?: string} | undefined)?.msgId;
  if (row?.state === 'done' && msgId) {
    const m = findByCid(payload.sessionId, key);
    if (m) {
      m.msgId = msgId;
      // The progress line leaves with the transfer: the bubble repaints now,
      // the wire's own status edge is not a paint.
      delete m.sendPct;
      notifyNow();
    }
    const named: SendPayload = {...payload, msgId};
    intents.update(intent.id, named);
    cyclog('voiceclip.accepted', {cid: key, session: payload.sessionId, msgId});
    return writeAndArm(named);
  }
  if (row?.state === 'gone') {
    // Refused definitively: the bubble is failed, the copy is released.
    failClip(payload, key, row.refused);
    return {failed: row.refused ?? 'the recording was refused by the engine'};
  }
  if (row || transfers.isEnqueuing(key)) {
    // Queued, in flight, or still being parked by `enqueue` (the send's own
    // kick lands before the row is written): the worker moves it and its
    // result kicks the drain.
    transfers.wake();
    return 'waiting';
  }
  // No transfer row survives, but the recording might: re-queue it.
  const rec = await clipVault.get(key);
  if (!rec) {
    // Nothing to move and nothing to send: the bubble must not sit on
    // "sending" forever. It fails as a lost clip (no retry can bring the
    // bytes back).
    cyclog('voiceclip.resume.no-bytes', {
      cid: key,
      session: payload.sessionId,
      why: 'no transfer row and no kept bytes; the note cannot be resumed'
    });
    failClip(payload, key);
    return {failed: 'the recording is gone from this device'};
  }
  transfers.enqueue(rec.blob, {
    key,
    sessionId: payload.sessionId,
    kind: 'user-audio',
    mime: rec.mime,
    durationS: rec.durationS,
    replyTo: rec.replyTo,
    ts: payload.ts
  });
  return 'waiting';
});

export type VoiceClipOpts = {
  durationS?: number;
  text?: string;
  cid?: string;
  replyTo?: CycReplyTo;
  // Deletes that go in the intent row's own transaction (what this send
  // supersedes on disk).
  alongside?: Alongside;
  // What the on-device streaming decoder already settled, for an empty-body
  // note the engine will transcribe: rides the wire as partials[{id: cid}] so
  // the engine decodes only the tail past upToS and prepends this text.
  partial?: {text: string; upToS: number};
  // The bubble's copy of the still-settling transcript (full heard text with
  // its committed cut), painted on the sent row at once and grown by the
  // capture's later partial events; the wire body stays `text`.
  display?: {text: string; committed: number};
};

// Send a recorded voice note. Returns the local message id (or '' if there is no
// such session to hang a row on).
export function sendVoiceClip(sessionId: string, blob: Blob, opts: VoiceClipOpts = {}): string {
  const cid =
    opts.cid ??
    crypto.randomUUID?.() ??
    Date.now().toString(36) + Math.random().toString(36).slice(2);
  const s = sessions.get(sessionId);
  if (!s) {
    cyclog('voiceclip.dropped', {
      cid,
      session: sessionId,
      why: 'no such session in the store, so there is no row to make the send honest on'
    });
    return '';
  }

  const clean = (opts.text ?? '').trim();
  const excerpt = (opts.replyTo?.text ?? '').trim();
  const wire = clean && excerpt ? quoteForWire(excerpt) + '\n\n' + clean : clean;

  const msg: CycEngineMessage = stampRowId({
    id: '',
    role: 'user',
    kind: 'voice',
    text: clean,
    ts: Date.now(),
    status: 'sending',
    cid,
    clipKey: cid
  });
  if (opts.durationS !== undefined) msg.durationS = opts.durationS;
  if (opts.replyTo) msg.replyTo = opts.replyTo;
  if (wire !== clean) msg.wireText = wire;
  // An empty-body note the engine will fill: the bubble shows the device's own
  // still-settling transcript NOW and keeps growing (draftCommitted keeps the
  // row open to updateVoiceNote), instead of sitting blank until the engine's
  // words come back. The wire body stays empty; only the display diverges.
  if (!clean && opts.display) {
    msg.text = opts.display.text;
    msg.draftCommitted = Math.max(0, Math.min(opts.display.committed, opts.display.text.length));
  }
  s.messages.push(msg);
  s.thinking = true;
  notifyNow();

  // Park the bytes and queue the transfer. enqueue returns at once; the worker
  // moves the bytes when the engine is connected.
  transfers.enqueue(blob, {
    key: cid,
    sessionId,
    kind: 'user-audio',
    mime: blob.type || 'audio/webm',
    durationS: opts.durationS,
    replyTo: opts.replyTo,
    ts: msg.ts
  });

  // The intent: a durable record of the message this note will send once its
  // transfer finishes. It references the transfer by clipKey (== cid) and is NOT
  // sent on the wire yet: the worker drives the bytes, the result sends this.
  // Its row reaches disk after the bytes and the transfer row have: a tab
  // killed in between leaves no intent that names bytes it does not have.
  intents.put(
    {
      id: cid,
      engineKey: s.engineKey,
      sessionId,
      kind: 'send-voice',
      localId: msg.id,
      payload: {
        cid,
        sessionId,
        ts: msg.ts,
        text: clean,
        kind: 'voice',
        durationS: opts.durationS,
        replyTo: opts.replyTo,
        wire,
        clipKey: cid,
        transferKey: cid,
        // The device's settled streaming words, named by the frame's cid (a
        // voice note has no uploadId to hang them on): the engine reads only
        // the clip's tail past upToS and prepends these.
        ...(opts.partial ? {partials: [{id: cid, ...opts.partial}]} : {})
      } satisfies SendPayload
    },
    {after: transfers.enqueued(cid), alongside: opts.alongside}
  );
  drain.kick(s.engineKey);

  return msg.id;
}

// The user-facing cancel of a voice note still moving its bytes (the progress
// line's tap). A canceled recording is never silently discarded: the transfer
// row is reclaimed (bytes KEPT in the vault, the engine-side partial DELETEd
// best-effort; a DELETE that never lands is the engine's 7-day sweeper's), the
// intent and the pending bubble go, and the recording is handed back for the
// composer to hold (the caller routes it through restoreVoiceBlock, exactly
// like the E1 recovery path). Returns the recording taken back, or null when
// the cancel was a no-op: the wire phase was already reached (msgId in hand),
// the transfer settled under the tap (done or gone), or the note is not a
// pending upload at all. A null with the message kept means nothing changed.
export async function cancelVoiceUpload(
  sessionId: string,
  localId: string
): Promise<ParkedClip | null> {
  const m = findLocal(sessionId, localId);
  if (!m || m.kind !== 'voice' || m.status !== 'sending' || !m.clipKey || m.msgId) return null;
  const key = m.clipKey;
  const cid = m.cid ?? key;
  // The clip already finished and the wire is leaving (or left): too late.
  if ((intents.get(cid)?.payload as SendPayload | undefined)?.msgId) return null;
  // Let a mid-park enqueue write its row first, or the reclaim below would
  // miss it and the parked row would move the bytes for a discarded message.
  await transfers.enqueued(key);
  const cur = findLocal(sessionId, localId);
  if (!cur || cur.status !== 'sending' || cur.msgId) return null; // finished under the await
  if (!transfers.reclaim(key)) return null; // done or gone under the tap: nothing to cancel
  // Drop the intent NOW, before the vault awaits below: the row is gone but the
  // intent still names the key, so a drain pass kicked in the await window
  // would re-enqueue the bytes from the vault (the executor's no-row path) and,
  // if that re-written row's park is still in flight when the trailing cancel
  // runs, a zombie row survives and could release the composer's bytes. With
  // the intent gone first, no drain can resurrect the transfer. The row is
  // already gone so discardSend releases nothing; it clears the ack deadline.
  discardSend(cid);
  const rec = await clipVault.get(key);
  // The bytes are the composer's now, not the transfer's: the recovery sweep
  // after a reload treats them as an ordinary recording.
  if (rec) await clipVault.update(key, {transfer: false});
  const s = sessions.get(sessionId);
  const i = s ? s.messages.findIndex((x) => x.id === localId) : -1;
  if (s && i >= 0) {
    s.messages.splice(i, 1);
    notifyNow();
  }
  cyclog('voiceclip.cancelled', {
    cid,
    session: sessionId,
    localId,
    kept: !!rec,
    why:
      'user cancelled the upload from the bubble; the transfer and intent go, ' +
      'the recording goes back to the composer'
  });
  return rec ? {...rec, transfer: false} : null;
}

// Re-send a voice note from the bytes kept in the clipVault. Returns true if it
// took ownership of the retry (a resendable clip note), false otherwise so the
// caller can fall back to the generic wire resend. A definitively-failed note
// (too large, bad hash) has had its bytes released, so there is nothing to
// resend and this is a no-op.
export function retryVoiceClip(sessionId: string, localId: string): boolean {
  const m = findLocal(sessionId, localId);
  if (!m || m.kind !== 'voice' || !m.clipKey) return false;
  const key = m.clipKey;
  // A retry is of a failed note. The note flips to sending here, before the
  // vault is read: a second tap in the same tick finds it owed again already
  // and does nothing, instead of requeuing the row a second time under the
  // first retry's drain. The reason stays on the row until the vault answers:
  // a note with nothing to resend goes back to failed with it.
  if (m.status !== 'failed') {
    cyclog('voiceclip.retry.noop', {
      cid: key,
      session: sessionId,
      localId,
      status: m.status,
      why: 'the note is not failed: it is owed again already (a second tap), or still moving'
    });
    return true;
  }
  m.status = 'sending';
  notifyNow();
  void clipVault.get(key).then((rec) => {
    const cur = findLocal(sessionId, localId);
    if (!cur) return;
    const intent = intents.get(key);
    const payload = intent?.payload as SendPayload | undefined;
    if (!rec) {
      // The bytes are gone from the vault for one of two reasons. A finished
      // transfer released them: the clip is on the engine under the intent's
      // msgId and only the wire's ack went missing, so the retry is the wire
      // again, same cid, same msgId. A definitive refusal released them: there
      // is no msgId and nothing to resend.
      if (payload?.msgId) {
        cyclog('voiceclip.retry.wire', {
          cid: key,
          session: sessionId,
          localId,
          msgId: payload.msgId,
          why: 'the clip is on the engine already; the wire that names it is owed again'
        });
        delete cur.failReason;
        notifyNow();
        drain.requeue(key);
        return;
      }
      cyclog('voiceclip.retry.no-bytes', {
        cid: key,
        session: sessionId,
        localId,
        why: 'the recorded bytes are gone from the vault (a definitive failure released them)'
      });
      cur.status = 'failed';
      notifyNow();
      return;
    }
    cyclog('voiceclip.retry', {
      cid: key,
      session: sessionId,
      localId,
      bytes: rec.blob.size,
      why: 'user tapped a voice note: re-queuing the kept recording as a fresh transfer'
    });
    delete cur.msgId;
    delete cur.clipLost;
    delete cur.failReason;
    delete cur.sendPct;
    // The wire is the intent's, not the bubble's: an empty-body note the
    // engine fills shows the device's partial in cur.text, and baking that
    // display into the resend would ship the partial AS the transcript and
    // lose the tail. The kept payload's text/wire/partials are authoritative;
    // cur.text is only the fallback for a note whose intent row is gone.
    const fresh: SendPayload = {
      cid: key,
      sessionId,
      ts: cur.ts,
      text: payload?.text ?? cur.text,
      kind: 'voice',
      durationS: cur.durationS,
      replyTo: cur.replyTo,
      wire: payload?.wire ?? cur.wireText ?? cur.text,
      ...(payload?.partials?.length ? {partials: payload.partials} : {}),
      clipKey: key,
      transferKey: key
    };
    const s = sessions.get(sessionId);
    if (intent) intents.update(key, fresh);
    else if (s) {
      intents.put({
        id: key,
        engineKey: s.engineKey,
        sessionId,
        kind: 'send-voice',
        localId,
        payload: fresh
      });
    }
    transfers.enqueue(rec.blob, {
      key,
      sessionId,
      kind: 'user-audio',
      mime: rec.mime,
      durationS: rec.durationS,
      replyTo: rec.replyTo,
      ts: cur.ts
    });
    notifyNow();
    drain.requeue(key);
  });
  return true;
}
