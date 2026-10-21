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

export function uploadFile(
  sessionId: string,
  file: File,
  onProgress?: (ratio: number) => void
): Promise<CycUpload> {
  return ownerOf(sessionId).client.uploadFile(file, onProgress);
}
