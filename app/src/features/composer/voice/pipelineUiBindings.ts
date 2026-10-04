import {pipeline} from '../../../audio/pipeline';
import {turnClosed, turnOpened} from '../../../audio/turnTones';
import {cyclog} from '../../../shared/logging';
import * as engine from '../../../engine/store';
import {sessionState} from '../../../sessionState';
import {mayStartSpeech} from '../../../speechGate';
import {toast} from '../../../components/widgets';
import type {CaptureState, VoiceCaptureDeps} from './captureState';

export function installPipelineUiBindings({
  cap,
  onTeardown,
  composer,
  releaseMicIfIdle,
  updateVoiceStrip
}: Pick<
  VoiceCaptureDeps,
  'cap' | 'onTeardown' | 'composer' | 'releaseMicIfIdle' | 'updateVoiceStrip'
>): void {
  onTeardown(
    pipeline.on('recording', (state) => {
      const wasRecording = cap.recState === 'recording';
      cap.recState = state;
      const call = pipeline.handsFreeSessionId;
      if (call && mayStartSpeech(call)) {
        if (state === 'recording' && !wasRecording) turnOpened();
        else if (wasRecording && state !== 'recording') turnClosed();
      }
      composer.setTranscribing(state === 'transcribing');
      composer.setLive(
        state !== 'idle' &&
          !!pipeline.handsFreeSessionId &&
          pipeline.handsFreeSessionId === sessionState.activeId
      );
      updateVoiceStrip();
      if (state === 'idle' && cap.voiceDraft) scheduleIdleDraftSweep(cap);
      // A recording just ended: keep the granted stream for the grace window so
      // a follow-up recording reuses it (no per-recording getUserMedia prompt).
      if (state === 'idle') releaseMicIfIdle(true);
    })
  );
  onTeardown(
    pipeline.on('partial', (text, sessionId, committed, captureId, committedS) => {
      const current = captureId === undefined || captureId === pipeline.liveCaptureId;
      if (current) cap.lastPartial = {text, committed: committed ?? text.length};
      if (captureId !== undefined && text.trim()) {
        cap.partialByCapture.set(captureId, {
          text,
          committed: committed ?? text.length,
          committedS
        });
      }
      if (current && (!sessionId || sessionId === sessionState.activeId)) {
        composer.setLivePartial(text, committed);
      }
      const held = captureId === undefined ? undefined : cap.heldClips.get(captureId);
      if (held) {
        held.update({text, committed: committed ?? text.length});
        return;
      }
      // A consumed capture (its clip already went out as a sent voice note,
      // or its card was evicted): the decoder's later words stream INTO the
      // sent bubble, so it grows live instead of sitting on dots until the
      // engine round-trips; with no row to fill they stand down.
      if (captureId !== undefined && cap.sentByCapture.has(captureId)) {
        const sent = cap.sentByCapture.get(captureId);
        if (sent) engine.updateVoiceNote(sent.sessionId, sent.localId, text, committed, sent.cid);
        return;
      }
      const draft = cap.draftFor(captureId);
      if (draft) engine.updateVoiceNote(draft.sessionId, draft.localId, text, committed, draft.cid);
    })
  );
  onTeardown(pipeline.on('level', (db) => composer.setLevel(db)));
}

function scheduleIdleDraftSweep(cap: CaptureState): void {
  const draft = cap.voiceDraft!;
  const tap = draft.seconds < 1;
  cyclog('sweep.armed', {
    cid: draft.cid,
    session: draft.sessionId,
    localId: draft.localId,
    heldS: draft.seconds,
    tap,
    inMs: tap ? 0 : 4000,
    why: 'the capture went idle with nothing having claimed its messageNode'
  });
  setTimeout(
    () => {
      if (cap.voiceDraft !== draft) {
        cyclog('sweep.stood-down', {
          cid: draft.cid,
          localId: draft.localId,
          why: 'something claimed the messageNode before the sweep ran'
        });
        return;
      }
      cap.voiceDraft = null;
      if (tap) {
        engine.discardVoiceNote(
          draft.sessionId,
          draft.localId,
          draft.cid,
          'the press was under a second and nothing claimed it: read as a stray tap'
        );
        return;
      }
      engine.failVoiceNote(draft.sessionId, draft.localId, draft.cid);
      toast('Could not transcribe that one');
    },
    tap ? 0 : 4000
  );
}
