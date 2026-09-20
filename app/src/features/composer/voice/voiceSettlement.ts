import {pipeline} from '../../../audio/pipeline';
import * as transfers from '../../../engine/transfers/worker';
import {toast} from '../../../components/widgets';
import * as engine from '../../../engine/store';
import {dataState, sessionState, unsentWork, vaultHolds} from '../../../sessionState';
import {cyclog} from '../../../shared/logging';
import type {CaptureState, VoiceCaptureDeps, VoiceDraft} from './captureState';
import {settledPartialOf} from './captureState';
import {createRecordingLedger} from './recordingLedger';

const HANDOFF_MS = 9000;

// The recorded clip of a live capture moves over the resumable transfer queue
// (Lane A), never a one-shot POST. Before this, the settle paths pushed the
// clip over /user-audio directly: on a flaky link the ladder (four tries in
// ~15 s) gave up for good and the note shipped words-only, with the recording
// silently stranded in the vault; the plain-utterance path did not even retry
// once. Now:
//   - the clip is parked and queued the moment it settles (settleClip), and
//     the worker moves it chunk by chunk with backoff, resuming across flaps
//     and reloads;
//   - a commit that runs before the clip has landed writes a send-voice intent
//     (commitVoiceNote transferKey): the wire waits for the transfer's msgId
//     and ships with the words baked in, or the bubble fails with retry;
//   - a commit that runs after it has landed carries the msgId exactly as
//     before (the fast-network path is byte-identical);
//   - a definitive refusal or lost bytes end in a failed bubble whose retry
//     re-queues from the kept bytes (retryVoiceClip), never a silent drop.

// What a queued clip still needs from the settlement once its transfer lands
// BEFORE the commit: the safe tick on the draft bubble and the parked msgId in
// the ledger, so the commit that follows names the msgId directly.
type PendingClip = {
  ledgerKey: string;
  draft: VoiceDraft | null;
  durationS?: number;
  cid?: string;
};

export function installVoiceSettlement({
  cap,
  onTeardown,
  scrollToBottom,
  clipCid
}: Pick<VoiceCaptureDeps, 'cap' | 'onTeardown' | 'scrollToBottom' | 'clipCid'>): void {
  const ledger = createRecordingLedger();
  const pending = new Map<string, PendingClip>();

  // Park + queue the clip under `key`, once: a key already parked, moving or
  // finished is left to the one live transfer (worker.enqueue dedups). The
  // vault write is counted in vaultHolds so a bundle reload waits for it.
  const queueClip = (
    target: string,
    clip: Blob,
    key: string,
    meta: {durationS?: number; replyTo?: VoiceDraft['replyTo']}
  ): void => {
    if (transfers.rowOf(key) || transfers.isEnqueuing(key)) return;
    vaultHolds.writing++;
    cap.uploading++;
    transfers.enqueue(clip, {
      key,
      sessionId: target,
      kind: 'user-audio',
      mime: clip.type || 'audio/webm',
      durationS: meta.durationS,
      replyTo: meta.replyTo,
      ts: Date.now()
    });
    void transfers.enqueued(key).finally(() => {
      vaultHolds.writing--;
      cap.uploading--;
    });
  };

  // A transfer that finishes before the commit: record the msgId in the ledger
  // (the commit that follows names it directly) and draw the safe tick on the
  // draft bubble. After the commit the send-voice executor owns the result and
  // this does nothing.
  onTeardown(
    transfers.onResult((row) => {
      if (row.kind !== 'user-audio') return;
      const entry = pending.get(row.key);
      if (!entry) return;
      pending.delete(row.key);
      const msgId = (row.result as {msgId?: string} | undefined)?.msgId;
      if (!msgId) return;
      const rec = ledger.entry(entry.ledgerKey);
      if (rec.committed) return;
      rec.parkedMsgId = msgId;
      if (entry.draft) {
        engine.markVoiceNoteSafe(
          entry.draft.sessionId,
          entry.draft.localId,
          msgId,
          entry.durationS,
          entry.cid
        );
      }
    })
  );

  onTeardown(
    pipeline.on('clip', (clip, sessionId, durationS, captureId) => {
      settleClip(cap, ledger, pending, clipCid, queueClip, clip, sessionId, durationS, captureId);
    })
  );
  onTeardown(
    pipeline.on('utterance', (text, sessionId, clip, durationS, captureId) => {
      settleUtterance(
        cap,
        ledger,
        queueClip,
        scrollToBottom,
        text,
        sessionId,
        clip,
        durationS,
        captureId
      );
    })
  );
  onTeardown(
    pipeline.on('ignored', (text, reason, clip, captureId, durationS) => {
      settleIgnored(cap, ledger, queueClip, text, reason, clip, captureId, durationS);
    })
  );
}

type QueueClip = (
  target: string,
  clip: Blob,
  key: string,
  meta: {durationS?: number; replyTo?: VoiceDraft['replyTo']}
) => void;

function freshKey(): string {
  return crypto.randomUUID?.() ?? `k${Date.now()}-${Math.random()}`;
}

// The transfer row's finished msgId, when the clip already landed under `key`.
function landedMsgId(key: string): string | undefined {
  const row = transfers.rowOf(key);
  if (row?.state !== 'done') return undefined;
  return (row.result as {msgId?: string} | undefined)?.msgId;
}

// The clip under `key` is on its way (queued, moving, or still being parked):
// the wire must wait on it rather than ship clipless.
function clipMoving(key: string): boolean {
  if (transfers.isEnqueuing(key)) return true;
  const row = transfers.rowOf(key);
  return row !== undefined && (row.state === 'queued' || row.state === 'active');
}

function settleClip(
  cap: CaptureState,
  ledger: ReturnType<typeof createRecordingLedger>,
  pending: Map<string, PendingClip>,
  clipCid: WeakMap<File, string>,
  queueClip: QueueClip,
  clip: Blob,
  sessionId: string | undefined,
  durationS: number | undefined,
  captureId: number | undefined
): void {
  const cid = cap.draftFor(captureId)?.cid ?? pipeline.cidOf(captureId);
  if (dataState.mode !== 'live') return;
  const held = captureId === undefined ? undefined : cap.heldClips.get(captureId);
  if (held) {
    if (!clip.size) return;
    const file = new File([clip], `voice-${captureId}.webm`, {type: clip.type || 'audio/webm'});
    if (cid) clipCid.set(file, cid);
    held.update({blob: clip, ...(durationS ? {durationS} : {})});
    held.attach(file);
    return;
  }
  // A consumed capture: the recording already rides the sent note's own
  // transfer (or the evicted card still holds it in the box). Queuing it
  // again here would upload the same bytes a second time under a second key.
  if (captureId !== undefined && cap.sentByCapture.has(captureId)) return;
  const draft = cap.draftFor(captureId);
  const key = ledger.for(captureId, draft?.localId);
  const target = draft?.sessionId ?? sessionId ?? sessionState.activeId;
  if (!target || !clip.size) return;
  if (draft && durationS) draft.audioSeconds = durationS;
  const vaultKey = cid ?? freshKey();
  if (key) {
    ledger.entry(key).vaultKey = vaultKey;
    pending.set(vaultKey, {ledgerKey: key, draft, durationS, cid});
  }
  queueClip(target, clip, vaultKey, {durationS, replyTo: draft?.replyTo});
  if (!draft) return;
  // The words may never settle (the decoder wedged, the tab about to close):
  // after the handoff the note ships anyway, empty-bodied. With the clip
  // already landed the commit names its msgId (the engine transcribes it
  // server-side where it can); still moving, the commit hands the wire to the
  // send-voice intent and it ships the moment the transfer finishes.
  const draftKey = ledger.key(captureId, draft.localId);
  ledger.cancelHandoff(draftKey);
  ledger.scheduleHandoff(
    draftKey,
    () => {
      if (!ledger.claim(draftKey)) return;
      const msgId = ledger.get(draftKey)?.parkedMsgId ?? landedMsgId(vaultKey);
      // The decoder never settled inside the handoff window, but its
      // STREAMED words are real: a fully-finalized transcript ships as the
      // body (no engine decode at all), a settled prefix rides as the
      // partial so the engine reads only the tail, and only a note with no
      // streamed words at all makes the engine read the whole clip.
      const p = settledPartialOf(
        captureId !== undefined ? cap.partialByCapture.get(captureId) : undefined,
        durationS
      );
      engine.commitVoiceNote(draft.sessionId, draft.localId, p?.whole ? p.text : '', {
        msgId,
        durationS,
        cid: msgId ? draft.cid : vaultKey,
        replyTo: draft.replyTo,
        ...(msgId ? {} : {transferKey: vaultKey}),
        ...(p && !p.whole ? {partial: {text: p.text, upToS: p.upToS}} : {})
      });
      unsentWork.hold(5000);
    },
    HANDOFF_MS
  );
}

function settleUtterance(
  cap: CaptureState,
  ledger: ReturnType<typeof createRecordingLedger>,
  queueClip: QueueClip,
  scrollToBottom: () => void,
  text: string,
  sessionId: string | undefined,
  clip: Blob | undefined,
  durationS: number | undefined,
  captureId: number | undefined
): void {
  const cid = cap.draftFor(captureId)?.cid ?? pipeline.cidOf(captureId);
  if (dataState.mode !== 'live') return;
  const held = captureId === undefined ? undefined : cap.heldClips.get(captureId);
  if (held) {
    cap.heldClips.delete(captureId!);
    cap.forgetPartial(captureId);
    held.update({text, committed: undefined, ...(durationS ? {durationS} : {})});
    return;
  }
  // A consumed capture: its clip already went out as a sent voice note (the
  // instant lone-note send), or its card was evicted. The settled words are a
  // display update to the sent bubble (the engine's own delivery reconciles
  // the final text), or nothing at all for an evicted card. WITHOUT this
  // branch the fallback below queues the clip a SECOND time and sends a twin
  // message -- the confirmed double-voice-note incident.
  if (captureId !== undefined && cap.sentByCapture.has(captureId)) {
    const sentNote = cap.sentByCapture.get(captureId);
    cap.sentByCapture.delete(captureId);
    cap.forgetPartial(captureId);
    if (sentNote) {
      engine.updateVoiceNote(sentNote.sessionId, sentNote.localId, text, text.length, sentNote.cid);
    }
    return;
  }
  const draft = cap.draftFor(captureId);
  if (captureId !== undefined) cap.draftsByCapture.delete(captureId);
  cap.forgetPartial(captureId);
  if (draft === cap.voiceDraft) cap.voiceDraft = null;
  const target = draft?.sessionId ?? sessionId ?? sessionState.activeId;
  if (!target) return;
  const seconds =
    durationS ??
    draft?.audioSeconds ??
    draft?.seconds ??
    Math.max(1, Math.round(text.split(/\s+/).length / 2.5));
  const key = ledger.for(captureId, draft?.localId);
  if (key && !ledger.claim(key)) return;
  ledger.cancelHandoff(key);
  const vaultKey =
    (key ? ledger.get(key)?.vaultKey : undefined) ?? cid ?? (clip?.size ? freshKey() : undefined);
  let msgId = key ? ledger.get(key)?.parkedMsgId : undefined;
  if (!msgId && vaultKey) msgId = landedMsgId(vaultKey);
  // The clip is not on the engine yet: make sure it is moving (a clip that
  // reached settleClip already is; one that only arrived here is queued now),
  // then let the wire wait on the transfer instead of shipping clipless.
  let moving = false;
  if (!msgId && vaultKey) {
    if (!clipMoving(vaultKey) && clip?.size) {
      queueClip(target, clip, vaultKey, {durationS: seconds, replyTo: draft?.replyTo});
    }
    moving = clipMoving(vaultKey);
  }
  if (draft) {
    engine.commitVoiceNote(draft.sessionId, draft.localId, text, {
      msgId,
      durationS: seconds,
      cid: moving ? vaultKey : cid,
      replyTo: draft.replyTo,
      ...(moving && vaultKey ? {transferKey: vaultKey} : {})
    });
  } else if (moving && vaultKey && clip) {
    // No bubble exists yet (a hands-free capture): the honest clip send makes
    // one, and its intent waits on the same queued transfer (enqueue dedups).
    engine.sendVoiceClip(target, clip, {text, cid: vaultKey, durationS: seconds});
  } else {
    engine.sendText(target, text, {kind: 'voice', durationS: seconds, msgId, cid});
  }
  unsentWork.hold(5000);
  if (target === sessionState.activeId) scrollToBottom();
}

function settleIgnored(
  cap: CaptureState,
  ledger: ReturnType<typeof createRecordingLedger>,
  queueClip: QueueClip,
  text: string,
  reason: string | undefined,
  clip: Blob | undefined,
  captureId: number | undefined,
  durationS: number | undefined
): void {
  const held = captureId === undefined ? undefined : cap.heldClips.get(captureId);
  if (held) {
    cap.heldClips.delete(captureId!);
    const heard = cap.heardOn(captureId).text;
    cap.forgetPartial(captureId);
    held.update({
      text: text || heard,
      committed: undefined,
      unsure: !text,
      ...(durationS ? {durationS} : {})
    });
    return;
  }
  // A consumed capture (shipped as a sent voice note, or an evicted card):
  // the device decode ending in a drop changes nothing about the send (the
  // engine reads the clip itself), so update the sent bubble with the best
  // heard words if any and stop tracking. Never fall through: the paths below
  // belong to dictation drafts, not to a consumed capture.
  if (captureId !== undefined && cap.sentByCapture.has(captureId)) {
    const sentNote = cap.sentByCapture.get(captureId);
    cap.sentByCapture.delete(captureId);
    const heard = text || cap.heardOn(captureId).text;
    cap.forgetPartial(captureId);
    if (sentNote && heard.trim()) {
      engine.updateVoiceNote(
        sentNote.sessionId,
        sentNote.localId,
        heard,
        heard.length,
        sentNote.cid
      );
    }
    return;
  }
  const draft = cap.draftFor(captureId);
  const cid = draft?.cid ?? pipeline.cidOf(captureId);
  const seconds = durationS ?? draft?.audioSeconds ?? draft?.seconds;
  const heard = cap.heardOn(captureId).text;
  if (captureId !== undefined) cap.draftsByCapture.delete(captureId);
  cap.forgetPartial(captureId);
  if (draft === cap.voiceDraft) cap.voiceDraft = null;
  if (!draft || reason !== 'error') {
    if (draft) engine.failVoiceNote(draft.sessionId, draft.localId, cid);
    return;
  }
  const key = ledger.key(captureId, draft.localId);
  if (!ledger.claim(key)) return;
  ledger.cancelHandoff(key);
  const vaultKey = ledger.get(key)?.vaultKey ?? cid ?? (clip?.size ? freshKey() : undefined);
  let msgId = ledger.get(key)?.parkedMsgId;
  if (!msgId && vaultKey) msgId = landedMsgId(vaultKey);
  // Transcription failed here, so the recording IS the message: queue it if it
  // is not moving already, and only fail the note when there is genuinely
  // nothing (no words heard, no clip anywhere).
  let moving = false;
  if (!msgId && vaultKey) {
    if (!clipMoving(vaultKey) && clip?.size) {
      queueClip(draft.sessionId, clip, vaultKey, {durationS: seconds, replyTo: draft.replyTo});
    }
    moving = clipMoving(vaultKey);
  }
  if (!heard.trim() && !msgId && !moving) {
    cyclog('ignored.nothing-to-send', {
      cid,
      localId: draft.localId,
      why: 'transcription failed and there is no clip to fall back on; the note fails visibly'
    });
    engine.failVoiceNote(draft.sessionId, draft.localId, cid);
    return;
  }
  unsentWork.hold(5000);
  engine.commitVoiceNote(draft.sessionId, draft.localId, heard.trim(), {
    msgId,
    durationS: seconds,
    cid: moving ? vaultKey : cid,
    replyTo: draft.replyTo,
    ...(moving && vaultKey ? {transferKey: vaultKey} : {})
  });
  toast(
    heard.trim()
      ? 'Transcription failed, sent what was heard'
      : 'Transcription failed here, sending the recording to be read there'
  );
}
