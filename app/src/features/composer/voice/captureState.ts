import type {RecordingState} from '../../../audio/pipeline';
import type {ComposerBlock, VoiceClip, VoiceHandle} from '../components/messageComposer';
import type {CycReplyTo} from '../../../types';

export type VoiceDraft = {
  sessionId: string;
  localId: string;
  seconds: number;
  audioSeconds?: number;
  captureId?: number;
  cid?: string;
  replyTo?: CycReplyTo;
};

// A capture whose composer card is GONE while its decoder still runs: either
// its clip already shipped as a sent voice note (the instant lone-note send),
// or the card was evicted from the held set. Its later decoder events must
// NEVER reach the hands-free fallback -- that is the double-send: a second
// upload and a second intent for one recording. With a SentNote the events
// belong to that sent row (partials keep painting the bubble, the settled
// utterance updates it once, the engine echo reconciles the final); a `null`
// entry is a consumed capture with NO row to fill (an evicted card, still in
// the box), whose events stand down silently.
export type SentNote = {sessionId: string; localId: string; cid?: string};

export interface CaptureState {
  voiceDraft: VoiceDraft | null;
  draftsByCapture: Map<number, VoiceDraft>;
  heldClips: Map<number, VoiceHandle>;
  partialByCapture: Map<number, {text: string; committed: number; committedS?: number}>;
  sentByCapture: Map<number, SentNote | null>;
  lastPartial: {text: string; committed: number};
  uploading: number;
  recState: RecordingState;
  draftFor(captureId?: number): VoiceDraft | null;
  heardOn(captureId?: number): {text: string; committed: number; committedS?: number};
  forgetPartial(captureId?: number): void;
}

// The words the streaming decoder has FINALIZED so far, and how far into the
// audio they reach, in the wire's partials shape. `whole` says the decoder has
// finalized everything it heard AND its audio clock reached the clip's end
// (within a second, durationS being rounded up): the settled text IS the
// transcript, so a send can bake it in as the body and the engine decodes
// nothing. Anything short of that carries upToS = committedS, never durationS,
// so the engine's tail decode can only add words, never lose them.
export function settledPartialOf(
  rec: {text: string; committed: number; committedS?: number} | undefined,
  durationS?: number
): {text: string; upToS: number; whole: boolean} | null {
  if (!rec) return null;
  const settled = rec.text.slice(0, rec.committed).trim();
  if (!settled) return null;
  const upToS = rec.committedS ?? 0;
  if (upToS <= 0) return null;
  const whole =
    rec.committed >= rec.text.length && durationS !== undefined && upToS >= durationS - 1;
  return {text: settled, upToS, whole};
}

export interface VoiceCaptureDeps {
  cap: CaptureState;
  onTeardown(d: () => void): void;
  composer: {
    setTranscribing(on: boolean): void;
    setLive(on: boolean): void;
    setLivePartial(text: string, committed?: number): void;
    setLevel(db: number): void;
  };
  releaseMicIfIdle(grace?: boolean): void;
  scrollToBottom(): void;
  updateVoiceStrip(): void;
  putBlocksBack(sessionId: string, add: ComposerBlock[]): void;
  restoreVoiceBlock(sessionId: string, file: File, clip: VoiceClip): void;
  clipCid: WeakMap<File, string>;
  vaultKeyOf: WeakMap<File, string>;
}

export function createCaptureState(): CaptureState {
  const cap: CaptureState = {
    voiceDraft: null,
    draftsByCapture: new Map(),
    heldClips: new Map(),
    partialByCapture: new Map(),
    sentByCapture: new Map(),
    lastPartial: {text: '', committed: 0},
    uploading: 0,
    recState: 'idle',
    draftFor: (captureId) => {
      if (captureId !== undefined) return cap.draftsByCapture.get(captureId) ?? null;
      return cap.voiceDraft;
    },
    heardOn: (captureId) =>
      (captureId !== undefined ? cap.partialByCapture.get(captureId) : undefined) ?? {
        text: '',
        committed: 0
      },
    forgetPartial: (captureId) => {
      if (captureId !== undefined) cap.partialByCapture.delete(captureId);
      if (cap.partialByCapture.size > 8) {
        for (const key of [...cap.partialByCapture.keys()].slice(
          0,
          cap.partialByCapture.size - 8
        )) {
          cap.partialByCapture.delete(key);
        }
      }
    }
  };
  return cap;
}
