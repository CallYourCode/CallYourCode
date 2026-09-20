import type {CycUpload, SttStream, SttStreamHandlers} from '../contract';
import type {WsEngineClient} from '../client';
import {ownerOf} from './registry';

function voiceClientFor(sessionId: string | undefined): WsEngineClient {
  return ownerOf(sessionId).client;
}

export function transcribe(sessionId: string | undefined, audio: Blob): Promise<string> {
  return voiceClientFor(sessionId).transcribe(audio);
}

export function openSttStream(
  sessionId: string | undefined,
  handlers?: SttStreamHandlers
): SttStream {
  return voiceClientFor(sessionId).transcribeStream(handlers);
}

export function hasVoiceMedia(sessionId: string | undefined): boolean {
  return voiceClientFor(sessionId).hasVoiceMedia();
}

export function openMediaSttStream(
  sessionId: string | undefined,
  handlers: SttStreamHandlers,
  micTrack?: MediaStreamTrack | null
): SttStream {
  return voiceClientFor(sessionId).openMediaSttStream(sessionId ?? '', handlers, micTrack);
}

export function uploadFile(
  sessionId: string,
  file: File,
  onProgress?: (ratio: number) => void
): Promise<CycUpload> {
  return ownerOf(sessionId).client.uploadFile(file, onProgress);
}
