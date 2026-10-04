import type {CycMessage, CycSession, CycSessionEvent} from './types';
import {avatarView} from './components/avatarView';
import {renderMessages} from '@/features/chat/surface/messageList';
import {realWaveforms, fillSignalSamples} from './features/composer/voice/waveform';
import {clipPlaybackState} from '@/features/chat/messages/attachmentMessages';
import * as clipVault from './audio/clipVault';
import * as composerVault from './features/composer/persistence/vault';
import * as showVault from './engine/showVault';
import * as keyring from './engine/keyring';
import {
  b64decode,
  b64encode,
  deriveSessionKey,
  importEngineKey,
  keyId,
  randomBytes,
  sealPush
} from '@shared/e2e';
import {stats as historyStats} from './engine/history';
import * as engine from './engine/store';
import {engineCapFetch, engineObjectUrl} from './engine/contract';
import {Pcm16kChunker} from './audio/pcm';
import {pipeline, arbitrate} from './audio/pipeline';
import {speaker} from './audio/speaker';
import {isCallPlayback, stretchProbe} from './audio/webAudioClip';
import {openImageViewer} from './features/media/imageViewer';
import {openFileViewer} from './features/media/fileViewer';
import {openHtmlViewer} from './features/media/htmlViewer';
import {openCodeViewer} from './features/code/codeViewer';
import {
  sendPlan,
  type ComposerBlock,
  type MessagePart,
  type VoiceClip,
  type VoiceHandle
} from './features/composer/components/messageComposer';
import {sessionState} from './sessionState';

export function installTestHooks(): void {
  if (!new URLSearchParams(location.search).get('testhooks')) return;

  (window as never as {__cycClipVault: typeof clipVault}).__cycClipVault = clipVault;

  (window as never as {__cycComposerVault: typeof composerVault}).__cycComposerVault =
    composerVault;

  (window as never as {__cycShowVault: typeof showVault}).__cycShowVault = showVault;

  (window as never as {__cycAvatar: typeof avatarView}).__cycAvatar = avatarView;

  (window as never as {__cycKeyring: typeof keyring}).__cycKeyring = keyring;
  (
    window as never as {
      __cycE2e: {
        b64decode: typeof b64decode;
        b64encode: typeof b64encode;
        deriveSessionKey: typeof deriveSessionKey;
        importEngineKey: typeof importEngineKey;
        keyId: typeof keyId;
        randomBytes: typeof randomBytes;
        sealPush: typeof sealPush;
      };
    }
  ).__cycE2e = {
    b64decode,
    b64encode,
    deriveSessionKey,
    importEngineKey,
    keyId,
    randomBytes,
    sealPush
  };

  (window as any).__cycRenderMessages = (
    inner: HTMLElement,
    messages: CycMessage[],
    firstUnreadId?: string,
    events?: CycSessionEvent[],
    uploadUrl?: (uploadId: string) => string,
    onOpenFile?: (m: CycMessage) => void
  ) =>
    renderMessages(
      inner,
      {id: 'testhooks', name: 'testhooks', messages} as unknown as CycSession,
      () => {},
      firstUnreadId,
      undefined,
      onOpenFile,
      events,
      undefined,
      undefined,
      undefined,
      undefined,
      (_m, u) => uploadUrl?.(u.uploadId) ?? ''
    );

  (window as any).__cycHistoryStats = () => ({...historyStats});

  (window as any).__cycOpenImageViewer = openImageViewer;

  (window as any).__cycOpenFileViewer = openFileViewer;

  (window as any).__cycOpenHtmlViewer = openHtmlViewer;

  (window as any).__cycOpenCodeViewer = openCodeViewer;

  (window as any).__cycMessages = (sessionId: string) =>
    (engine.get(sessionId)?.messages ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      kind: m.kind,
      text: m.text,
      ts: m.ts,
      status: m.status,
      failReason: (m as CycMessage & {failReason?: string}).failReason,
      durationS: m.durationS,
      draftCommitted: m.draftCommitted,
      msgId: (m as CycMessage & {msgId?: string}).msgId,
      cid: (m as CycMessage & {cid?: string}).cid,
      seq: (m as CycMessage & {seq?: number}).seq,

      replyTo: m.replyTo,
      wireText: (m as CycMessage & {wireText?: string}).wireText,

      upload: m.upload,
      uploads: m.uploads
    }));

  (window as any).__cycArbitrate = arbitrate;

  (window as any).__cycClipPlayback = clipPlaybackState;

  (window as any).__cycSeedWaveform = (msgId: string, env: number[]) => {
    realWaveforms.set(msgId, env);
    document
      .querySelectorAll<HTMLElement>(
        `.cyc-clip.cyc-voice[data-msg-id="${CSS.escape(msgId)}"] .cyc-signal-meter`
      )
      .forEach((c) =>
        c.querySelectorAll<HTMLElement>('.cyc-signal-samples').forEach(fillSignalSamples)
      );
  };

  (window as any).__cycHistoryProbe = async (sessionId: string) => {
    const eng = engine as unknown as {
      get(id: string): {messages: {ts: number; role: string; text: string}[]} | undefined;
      attach(id: string): void;
      detachChat(): void;
    };
    eng.detachChat();
    await new Promise((r) => setTimeout(r, 300));

    for (const other of engine
      .list()
      .filter((x) => x.id !== sessionId)
      .slice(0, 3)) {
      eng.attach(other.id);
      await new Promise((r) => setTimeout(r, 250));
    }
    eng.attach(sessionId);
    await new Promise((r) => setTimeout(r, 2500));
    return {after: eng.get(sessionId)?.messages.length ?? 0};
  };

  (window as any).__cycTestStream = async (url: string, opts: {pace?: boolean} = {}) => {
    const pace = opts.pace !== false;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();

    const decoded = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.slice(0));
    const pcm = decoded.getChannelData(0);

    const t0 = performance.now();
    const partials: {ms: number; text: string; committed?: number}[] = [];

    const stream = engine.openSttStream(sessionState.activeId ?? undefined, {
      onPartial: (text, committed) =>
        partials.push({ms: Math.round(performance.now() - t0), text, committed})
    });
    const chunker = new Pcm16kChunker(decoded.sampleRate, (chunk) => stream.push(chunk));
    const step = Math.round(decoded.sampleRate / 4);
    for (let i = 0; i < pcm.length; i += step) {
      chunker.push(pcm.subarray(i, Math.min(i + step, pcm.length)));
      if (pace) await new Promise((r) => setTimeout(r, 250));
    }
    chunker.flush();
    const stopMs = Math.round(performance.now() - t0);

    const batchRun = engine
      .transcribe(sessionState.activeId ?? undefined, new Blob([bytes], {type: 'audio/wav'}))
      .then((t): string => (t || '').trim())
      .catch((): null => null);
    const streamRun = stream
      .finish()
      .then((t): string => (t || '').trim())
      .catch((): null => null);

    const fromBatch = await batchRun;
    const fromStream = await streamRun;
    const streamed = fromStream !== null;
    const final = fromBatch || fromStream || '';
    const finalMs = Math.round(performance.now() - t0);
    return {
      streamed,
      partials,
      final,
      audioMs: Math.round((pcm.length / decoded.sampleRate) * 1000),
      stopMs,
      finalMs,
      stopToFinalMs: finalMs - stopMs,
      fromBatch,
      fromStream,
      firstPartialMs: partials.length ? partials[0].ms : null
    };
  };

  (window as any).__cycPipeline = pipeline;
  (window as any).__cycStore = engine;

  (window as any).__cycSay = (sessionId: string, msgId: string, text: string) =>
    engine.injectFrame(sessionId, {t: 'say', msgId, text});

  (window as any).__cycSpeakerState = () => ({
    ...speaker.state,
    isPlaying: speaker.isPlaying(),
    busy: (speaker as unknown as {busy: boolean}).busy,

    t: speaker.times().t,
    playerPaused: (speaker as unknown as {audio: {paused: boolean}}).audio.paused,

    callPlayback: isCallPlayback(),

    playerBackend: (speaker as unknown as {audio: {backend: string}}).audio.backend
  });
  (window as any).__cycVoiceWire = async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const decoded = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.slice(0));
    const pcm = decoded.getChannelData(0);
    const emit = (text: string, committed?: number) =>
      (pipeline as any).emit('partial', text, undefined, committed);
    const partials: {text: string; committed?: number}[] = [];
    const stream = engine.openSttStream(sessionState.activeId ?? undefined, {
      onPartial: (text, committed) => {
        partials.push({text, committed});
        emit(text, committed);
      }
    });
    const chunker = new Pcm16kChunker(decoded.sampleRate, (chunk) => stream.push(chunk));
    const step = Math.round(decoded.sampleRate / 4);
    for (let i = 0; i < pcm.length; i += step) {
      chunker.push(pcm.subarray(i, Math.min(i + step, pcm.length)));
      await new Promise((r) => setTimeout(r, 250));
    }
    chunker.flush();
    const durationS = Math.max(1, Math.round(pcm.length / decoded.sampleRate));
    (window as any).__cycVoiceFinish = async () => {
      const final = (await stream.finish()).trim();
      emit(final, final.length);
      (pipeline as any).emit(
        'utterance',
        final,
        undefined,
        new Blob([bytes], {type: 'audio/wav'}),
        durationS
      );
      return {final, partials};
    };
    return {partials, durationS};
  };

  (window as any).__cycEngineFetch = async (url: string, init?: RequestInit) => {
    const res = await engineCapFetch(url, init);
    return {status: res.status, ok: res.ok, body: await res.text()};
  };

  (window as any).__cycEngineObjectUrl = (url: string) => engineObjectUrl(url);

  (window as any).__cycWsolaProbe = () => stretchProbe();
}

export function installComposerTestHooks(composer: {
  getDraft(): string;
  getBlocks(): ComposerBlock[];
  addVoice(clip: VoiceClip): VoiceHandle;
  attach?(file: File): void;
}): void {
  if (!new URLSearchParams(location.search).get('testhooks')) return;

  (window as never as {__cycComposerText: () => string}).__cycComposerText = () =>
    composer.getDraft();

  (window as never as {__cycComposerParts: () => MessagePart[]}).__cycComposerParts = () =>
    sendPlan(composer.getBlocks(), composer.getDraft()).parts;

  (
    window as never as {__cycComposerAddVoice: (c: VoiceClip, b?: ArrayBuffer, t?: string) => void}
  ).__cycComposerAddVoice = (clip: VoiceClip, bytes?: ArrayBuffer, mime?: string) => {
    const handle = composer.addVoice(clip);
    if (!bytes) return;
    const type = mime || 'audio/webm';
    const blob = new Blob([bytes], {type});
    handle.update({blob});
    handle.attach(new File([blob], `voice-${Date.now()}.webm`, {type}));
  };
}
