import * as engine from './engine/store';
import {selectSttStream} from './engine/voiceCall';
import {pipeline} from './audio/pipeline';
import {speaker} from './audio/speaker';
import {sessionState} from './sessionState';

export const TOUCH_DEVICE = matchMedia('(pointer: coarse)').matches;

export const hiddenSilences = () => document.hidden && TOUCH_DEVICE;

export const mayStartSpeech = (sessionId: string, manual = false): boolean =>
  (manual || !engine.isMuted(sessionId)) &&
  (!hiddenSilences() || pipeline.handsFreeSessionId === sessionId);

export function installSpeechGate(): void {
  speaker.setStartGate((item) => mayStartSpeech(item.sessionId, item.manual));
}

export const mic = {ready: null as Promise<void> | null};

export function ensureMic(): Promise<void> {
  if (!mic.ready) {
    const voiceSession = (sessionId?: string) => sessionId ?? sessionState.activeId ?? undefined;
    mic.ready = pipeline
      .init({
        transcribe: (audio, sessionId) => engine.transcribe(voiceSession(sessionId), audio),

        transcribeStream: (handlers, sessionId) =>
          selectSttStream(
            {
              callSessionId: pipeline.handsFreeSessionId,
              micTrack: pipeline.callMicTrack(),
              hasVoiceMedia: (s) => engine.hasVoiceMedia(s),
              openMedia: (s, h, mic) => engine.openMediaSttStream(s, h, mic),
              openDc: (s, h) => engine.openSttStream(s, h)
            },
            handlers,
            voiceSession(sessionId)
          )
      })
      .catch((err) => {
        mic.ready = null;
        throw err;
      });
  }
  return mic.ready;
}
