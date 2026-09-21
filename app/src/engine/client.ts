import type {
  EngineAgentRun,
  EngineClient,
  EngineEvents,
  EnginePage,
  SttStream,
  SttStreamHandlers
} from './contract';
import {
  clearEngineTunnel,
  clientId,
  EngineOffline,
  engineCapFetch,
  type EngineFetchInit,
  httpBaseOf,
  relaySignalUrlFor,
  RESEAL_GRACE_MS,
  rtcIceServers,
  setEngineTunnel
} from './contract';
import {TunnelClient} from './tunnelClient';
import {decodePage} from './decodeChat';
import {DcSttStream} from './sttStream';
import {dispatchFrame} from './frames';
import type {FrameContext} from './frames/types';
import {cyclog} from '@/shared/logging';
import {deleteKey, getByUserHost, pinEngineIdentity, storeGenerations} from './keyring';
import {
  b64encode,
  fpOfSpki,
  secTranscript,
  signId,
  SecureChannel,
  derivePairKey,
  secPairTag,
  type SecFrame,
  type SecOffer
} from '@shared/e2e';
import {wsSignal, RtcDial, type Signal, type RelayAuth} from './rtc';
import {VoiceCall} from './voiceCall';
import type {Pipe} from '@shared/dcpipe';
import {
  getDeviceIdentity,
  getEnginePin,
  setEnginePin,
  clearEnginePin,
  type DeviceIdentity
} from './identity';

// When the next dial goes is not this file's call: the sync manager owns the
// backoff, and asks for the dial through redialNow(caller).
export interface ReconnectPolicy {
  schedule(): void;
}

const LIVENESS_CHECK_MS = 5_000;
const LIVENESS_QUIET_MS = 20_000;
const LIVENESS_GRACE_MS = 10_000;

function deviceLabel(): string {
  let label = '';
  try {
    label = localStorage.getItem('cyc-device-label') ?? '';
  } catch {}
  if (label) return label;
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : 'browser';
  label = `${kind} ${/CriOS|Chrome/.test(ua) ? 'Chrome' : /Firefox/.test(ua) ? 'Firefox' : 'Safari'}`;
  try {
    localStorage.setItem('cyc-device-label', label);
  } catch {}
  return label;
}

type Listeners = {[K in keyof EngineEvents]: EngineEvents[K][]};

type SecState = {
  chan: SecureChannel;
  ready: boolean;
  writeChain: Promise<void>;
  userHost: string;
  pastedUh: string | null;
};
type HandshakeState = {
  pipe: Pipe;
  offer: SecOffer;
  device: DeviceIdentity;
  resolveSec: (f: SecFrame) => void;
  rejectSec: (e: Error) => void;
  resolveDone: (() => void) | null;
  rejectDone: ((e: Error) => void) | null;
  chan: SecureChannel | null;
  doneSeen: boolean;
};

// An HTTP failure that carries its status, so a caller (the transfer worker)
// can tell a definitive 4xx from a retryable one.
function httpErr(what: string, status: number): Error & {status: number} {
  const e = new Error(`${what} failed: HTTP ${status}`) as Error & {status: number};
  e.status = status;
  return e;
}

// The one knob a transfer call takes: the worker's deadline signal.
export type TransferOpts = {signal?: AbortSignal};

export class WsEngineClient implements EngineClient {
  private pipe: Pipe | null = null;
  private signal: Signal | null = null;
  private rtc: RtcDial | null = null;
  private listeners: Listeners = {
    status: [],
    pairNeeded: [],
    downgraded: [],
    identityChanged: [],
    host: [],
    voiceHealth: [],
    sessions: [],
    plugins: [],
    chat: [],
    attachOk: [],
    say: [],
    sayGrow: [],
    sayDone: [],
    sayLive: [],
    sayLiveFail: [],
    sessionEvent: [],
    dequeued: [],
    termFrame: [],
    termClosed: [],
    termMode: [],
    answerResult: [],
    compactResult: [],
    sessionIdChanged: [],
    ack: [],
    sendFailed: []
  };
  private closed = true;
  private attachedId: string;
  private probeN = 0;
  private tailedId: string | null = null;

  private terms = new Map<string, {cols: number; rows: number}>();
  private pending: string[] = [];
  private lastInboundAt = 0;
  private awaitingInboundBy: number | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | undefined;
  private visible = true;
  private readonly url: string;
  private readonly httpBase: string;

  private sec: SecState | null = null;

  private hs: HandshakeState | null = null;

  private held: 'identity' | 'pairing' | null = null;

  /* A paired()/trustEngine() that landed while a dial attempt was already in
   * flight. dial()'s in-flight guard silently swallows the redial kick, and
   * when that attempt then failed (unknown-device), the client parked on
   * `held` with nobody left to wake it: PAIR tapped during the slow first
   * hosted dial sat on "Pairing..." until a reload. The kick is remembered
   * here, and the handshake-failure path retries instead of parking. */
  private rekeyKick = false;

  private voiceCall: VoiceCall | null = null;

  private readonly tunnel = new TunnelClient({
    ready: () => this.sealReady(),

    send: (frame: object) => this.writeRaw(JSON.stringify(frame)),

    drain: () => this.pipe?.drain() ?? Promise.resolve()
  });

  constructor(
    url: string,
    private readonly reconnect: ReconnectPolicy
  ) {
    this.url = url;
    this.httpBase = httpBaseOf(url);
    setEngineTunnel(this.httpBase, this.tunnel);
  }

  public connect() {
    this.closed = false;
    if (this.livenessTimer === undefined) {
      this.livenessTimer = setInterval(() => this.checkLiveness(), LIVENESS_CHECK_MS);
    }

    if (!this.pipe) void this.dial();
  }

  public close() {
    cyclog('socket.closing', {
      engine: this.url,
      stillQueued: this.pending.length,
      why: 'the app asked for this socket to be shut down'
    });
    this.closed = true;
    if (this.livenessTimer !== undefined) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = undefined;
    }
    this.awaitingInboundBy = null;
    const pipe = this.pipe;
    this.pipe = null;
    this.sec = null;
    this.hs = null;

    clearEngineTunnel(this.httpBase);
    this.tunnel.reset('client closed');
    this.voiceCall?.close();
    this.voiceCall = null;
    this.failSttStreams();
    pipe?.close(1000, 'app-closed');
    this.rtc?.close('app-closed');
  }

  public on<K extends keyof EngineEvents>(ev: K, fn: EngineEvents[K]) {
    this.listeners[ev].push(fn as never);
  }

  // Visible again runs the liveness check at once (R4): a pipe that died while
  // the phone was in a pocket is found now, not on the next 5 s tick.
  public setVisible(on: boolean) {
    this.visible = on;
    // The beat rides the pipe sealed, so the idle probe cannot read it off the
    // wire; count it here the instant it actually leaves (a no-op unless the
    // probe is installed, i.e. under ?testhooks=1).
    if (this.send({t: 'visible', on})) {
      (
        window as unknown as {__cycIdle?: {notePresenceFrame?(): void}}
      ).__cycIdle?.notePresenceFrame?.();
    }
    if (on) this.checkLiveness();
  }

  // Foreground return (bg-refresh): demand proof of life from a sealed pipe
  // now, whatever the quiet clock says. One ping; the standing liveness tick
  // enforces the grace window, so a silently dead pipe (a half-open socket
  // after a pocket nap) is presumed dead within LIVENESS_GRACE_MS and the
  // manager redials it. Not sealed means nothing to verify (the manager's
  // poke already dials), and an armed deadline is already a demand.
  public verifyPipe() {
    if (!this.sealReady() || this.awaitingInboundBy !== null) return;
    const n = ++this.probeN;
    cyclog('socket.probe', {
      engine: this.url,
      n,
      why: 'foreground return; asking for the pong that proves the pipe is alive'
    });
    this.sendNow({t: 'ping', n});
    this.awaitingInboundBy = Date.now() + LIVENESS_GRACE_MS;
  }

  // True when the frame was written to a sealed pipe (the drain's 'done').
  public heard(sessionId: string, row: {mid?: string; msgId?: string; ts?: number}): boolean {
    const m: Record<string, unknown> = {t: 'heard', id: sessionId};
    if (row.mid) m.mid = row.mid;
    if (row.msgId) m.msgId = row.msgId;
    if (typeof row.ts === 'number' && Number.isFinite(row.ts)) m.ts = row.ts;
    return this.send(m as never);
  }

  // `frontier` is the highest seq the engine has confirmed this device holds.
  // -1 when it has never held anything contiguous. Unsealed, the frame waits
  // in the queue (latest attach wins) and flushes first on the next pipe; the
  // store re-attaches again on the settled edge with the same frontier.
  public attach(sessionId: string, frontier = -1) {
    this.attachedId = sessionId;
    this.send({t: 'attach', id: sessionId, frontier});

    if (this.sealReady() && this.awaitingInboundBy === null) {
      this.awaitingInboundBy = Date.now() + LIVENESS_GRACE_MS;
    }
  }

  public async fetchPage(sessionId: string, n: number): Promise<EnginePage | null> {
    const res = await this.engineFetch('/session/' + encodeURIComponent(sessionId) + '/page/' + n, {
      signal: AbortSignal.timeout(15_000)
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`page failed: HTTP ${res.status}`);
    const json = await res.json();
    if (!json || typeof json.page !== 'number' || !Array.isArray(json.messages)) return null;
    return decodePage(json);
  }

  public progress(sessionId: string, seq: number, explicit = false): boolean {
    if (!Number.isFinite(seq)) return false;
    return this.send({t: 'progress', id: sessionId, seq, ...(explicit ? {explicit: true} : {})});
  }

  public detach() {
    if (this.attachedId === undefined) return;
    this.attachedId = undefined;
    this.sendNow({t: 'attach', id: ''});
  }

  private canDo = new Set<string>();
  public can(feature: string): boolean {
    return this.canDo.has(feature);
  }

  private voiceHealthyState = true;
  public voiceHealthy(): boolean {
    return this.voiceHealthyState;
  }

  private buildVoiceCall(): void {
    const channel = this.rtc?.audio ?? null;
    if (!channel) {
      this.voiceCall = null;
      return;
    }
    this.voiceCall = new VoiceCall(channel, {
      seal: (frame) => this.sendNow(frame),
      log: (event, fields) => cyclog(event, {engine: this.url, ...fields}),
      closeOnMismatch: (reason) => {
        cyclog('voice.fp-close', {
          engine: this.url,
          reason,
          why:
            'the media DTLS fingerprint did not match the sealed channel; ' +
            'a relay re-terminated DTLS, so the pipe is torn down'
        });
        this.pipe?.close(4462, reason);
        this.rtc?.close(reason);
      }
    });
  }

  public hasVoiceMedia(): boolean {
    return !!this.voiceCall?.canCarryAudio;
  }

  public openMediaSttStream(
    session: string,
    handlers: SttStreamHandlers,
    micTrack?: MediaStreamTrack | null
  ): SttStream {
    if (!this.voiceCall) throw new Error('no voice-media channel on this pipe');
    return this.voiceCall.openCapture(session, handlers, micTrack);
  }

  private forgetCapabilities(why: string) {
    if (!this.canDo.size) return;
    cyclog('engine.can-forgotten', {engine: this.url, was: [...this.canDo].join(','), why});
    this.canDo.clear();
  }

  public sendText(
    sessionId: string,
    text: string,
    extra: {
      kind?: 'voice';
      msgId?: string;
      durationS?: number;
      upload?: unknown;
      uploads?: unknown[];
      cid?: string;
      words?: string[];
      partials?: {id: string; text: string; upToS: number}[];
    } = {}
  ): boolean {
    cyclog('send.utterance', {
      cid: extra.cid,
      session: sessionId,
      kind: extra.kind ?? 'text',
      chars: text.length,
      msgId: extra.msgId,
      durationS: extra.durationS,
      socket: this.sealReady() ? 'open' : 'not connected',
      queuedBehind: this.pending.length
    });
    return this.send({t: 'utterance', id: sessionId, text, origin: clientId(), ...extra});
  }

  public setSessionTail(sessionId: string, on: boolean) {
    if (on) this.tailedId = sessionId;
    else if (this.tailedId === sessionId) this.tailedId = null;
    this.send({t: 'session-tail', id: sessionId, on});
  }

  public openTerminal(sessionId: string, cols: number, rows: number) {
    this.terms.set(sessionId, {cols, rows});
    this.sendNow({t: 'term-open', id: sessionId, dev: clientId(), cols, rows});
  }

  public resizeTerminal(sessionId: string, cols: number, rows: number) {
    if (!this.terms.has(sessionId)) return;
    this.terms.set(sessionId, {cols, rows});
    this.sendNow({t: 'term-resize', id: sessionId, cols, rows});
  }

  public sendTerminalInput(sessionId: string, input: {text: string} | {b64: string}) {
    if (!this.terms.has(sessionId)) return;
    this.sendNow({t: 'term-input', id: sessionId, ...input});
  }

  public scrollTerminal(sessionId: string, dir: 'up' | 'down', lines: number) {
    if (!this.terms.has(sessionId)) return;
    this.sendNow({t: 'term-scroll', id: sessionId, dir, lines});
  }

  public closeTerminal(sessionId: string) {
    if (!this.terms.delete(sessionId)) return;
    this.sendNow({t: 'term-close', id: sessionId});
  }

  public async fetchSessionAgents(sessionId: string): Promise<EngineAgentRun[] | null> {
    const res = await this.engineFetch('/session-agents/' + encodeURIComponent(sessionId), {
      signal: AbortSignal.timeout(10_000)
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`session-agents failed: HTTP ${res.status}`);
    const json = await res.json();
    const raw: any[] = Array.isArray(json?.runs) ? json.runs : [];
    const runs: EngineAgentRun[] = [];
    for (const r of raw) {
      if (!r || typeof r.toolUseId !== 'string' || !Number.isFinite(r.ts)) continue;
      runs.push({
        toolUseId: r.toolUseId,
        agentId: typeof r.agentId === 'string' ? r.agentId : null,
        ts: Number(r.ts),
        desc: String(r.desc ?? ''),
        endedTs: Number.isFinite(r.endedTs) ? Number(r.endedTs) : null,
        tokens: typeof r.tokens === 'string' && r.tokens ? r.tokens : null,
        ...(r.source === 'pi' ? {source: 'pi' as const} : {}),
        ...(typeof r.model === 'string' && r.model ? {model: r.model} : {})
      });
    }
    return runs;
  }

  public async stopSessionAgent(
    sessionId: string,
    agentId: string
  ): Promise<{ok: boolean; error?: string}> {
    const res = await this.engineFetch(
      '/session-agents/' + encodeURIComponent(sessionId) + '/stop',
      {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({agentId}),
        signal: AbortSignal.timeout(10_000)
      }
    );
    if (!res.ok) return {ok: false, error: `HTTP ${res.status}`};
    const json = await res.json().catch(() => ({}) as {ok?: boolean; error?: string});
    return {
      ok: json?.ok !== false,
      error: typeof json?.error === 'string' ? json.error : undefined
    };
  }

  public async pluginPanelHtml(id: string): Promise<string> {
    const res = await this.engineFetch('/plugin/' + encodeURIComponent(id) + '/panel', {
      signal: AbortSignal.timeout(12_000)
    });
    if (!res.ok) throw new Error(`plugin panel HTTP ${res.status}`);
    return res.text();
  }

  public async pluginRpc(
    id: string,
    op: string,
    session: string | null,
    args: unknown
  ): Promise<{ok: boolean; result?: unknown; message?: string}> {
    const path = '/plugin/' + encodeURIComponent(id) + '/rpc/' + encodeURIComponent(op);
    const headers: Record<string, string> = {'content-type': 'application/json'};
    try {
      const res = await this.engineFetch(path, {
        method: 'POST',
        headers,

        body: JSON.stringify({...(session ? {session} : {}), args}),
        signal: AbortSignal.timeout(30_000)
      });
      const body = (await res.json().catch((): null => null)) as {
        ok?: boolean;
        result?: unknown;
        error?: string;
      } | null;
      if (res.ok && body?.ok) return {ok: true, result: body.result};
      return {ok: false, message: body?.error ?? `HTTP ${res.status}`};
    } catch (e) {
      return {
        ok: false,
        message: (e as Error)?.name === 'TimeoutError' ? 'timed out' : 'engine unreachable'
      };
    }
  }

  private pluginStatePath(id: string, session: string | null): string {
    return (
      '/plugin/' +
      encodeURIComponent(id) +
      '/state' +
      (session ? '?session=' + encodeURIComponent(session) : '')
    );
  }
  public async pluginStateLoad(
    id: string,
    session: string | null
  ): Promise<{ok: boolean; saved: boolean; data: unknown; message: string}> {
    try {
      const res = await this.engineFetch(this.pluginStatePath(id, session), {
        signal: AbortSignal.timeout(4000)
      });
      const body = (await res.json().catch((): null => null)) as {
        ok?: boolean;
        saved?: boolean;
        data?: unknown;
        error?: string;
      } | null;
      if (res.ok && body?.ok)
        return {
          ok: true,
          saved: !!body.saved,
          data: body.data ?? null,
          message: body.saved ? 'loaded' : 'nothing saved yet'
        };
      return {
        ok: false,
        saved: false,
        data: null,
        message:
          (body?.error ?? `HTTP ${res.status}`) + '. Nothing was loaded; do not save over it.'
      };
    } catch (e) {
      return {
        ok: false,
        saved: false,
        data: null,
        message:
          `the engine could not be reached (${e instanceof Error ? e.message : 'error'}). ` +
          'Nothing was loaded; do not save over it.'
      };
    }
  }
  public async pluginStateSave(
    id: string,
    session: string | null,
    body: string
  ): Promise<{ok: boolean; message: string}> {
    const headers: Record<string, string> = {'content-type': 'application/json'};
    try {
      const res = await this.engineFetch(this.pluginStatePath(id, session), {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(4000)
      });
      const answer = (await res.json().catch((): null => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (res.ok && answer?.ok) return {ok: true, message: 'saved'};
      return {
        ok: false,
        message: answer?.error ?? `the engine refused the save (HTTP ${res.status})`
      };
    } catch (e) {
      return {
        ok: false,
        message:
          'the engine could not be reached ' +
          `(${e instanceof Error ? e.message : 'error'}), so nothing was saved.`
      };
    }
  }

  public interrupt(sessionId: string) {
    this.sendNow({t: 'interrupt', id: sessionId});
  }

  public compact(sessionId: string) {
    cyclog('send.compact', {
      session: sessionId,
      socket: this.sealReady() ? 'open' : 'not connected'
    });
    this.sendNow({t: 'compact', id: sessionId});
  }

  public answer(sessionId: string, fingerprint: string, choice: number) {
    cyclog('send.answer', {
      session: sessionId,
      choice,
      socket: this.sealReady() ? 'open' : 'not connected'
    });
    this.sendNow({t: 'answer', id: sessionId, fingerprint, choice});
  }

  public async transcribe(audio: Blob): Promise<string> {
    const headers: Record<string, string> = {};
    if (audio.type) headers['Content-Type'] = audio.type;
    const at = Date.now();

    const path = '/voice/stt';
    cyclog('stt.batch.start', {
      bytes: audio.size,
      mime: audio.type || '(none)',
      voice: this.httpBase + path
    });
    let res: Response;
    try {
      res = await this.engineFetch(path, {
        method: 'POST',
        headers,
        body: audio,
        signal: AbortSignal.timeout(60_000)
      });
    } catch (e) {
      cyclog('stt.batch.unreachable', {
        bytes: audio.size,
        ms: Date.now() - at,
        voice: this.httpBase + path,
        err: e,
        why:
          'the engine could not be reached or took longer than the deadline; ' +
          'this capture gets no transcript from this device'
      });
      throw e;
    }
    if (!res.ok) {
      cyclog('stt.batch.rejected', {
        bytes: audio.size,
        status: res.status,
        ms: Date.now() - at,
        voice: this.httpBase + path
      });
      throw new Error(`stt failed: HTTP ${res.status}`);
    }
    const json = await res.json();
    const text = typeof json?.text === 'string' ? json.text : '';
    cyclog('stt.batch.done', {bytes: audio.size, chars: text.length, ms: Date.now() - at});
    return text;
  }

  private readonly sttStreams = new Map<string, DcSttStream>();

  public transcribeStream(handlers: SttStreamHandlers = {}): SttStream {
    const stream = new DcSttStream(
      {
        send: (frame) => this.writeRaw(JSON.stringify(frame)),
        drain: () => this.pipe?.drain() ?? Promise.resolve(),
        detach: (id) => this.sttStreams.delete(id)
      },
      handlers
    );

    if (!stream.failed) this.sttStreams.set(stream.id, stream);
    return stream;
  }

  private failSttStreams(): void {
    for (const stream of [...this.sttStreams.values()]) stream.onClosed();
    this.sttStreams.clear();
  }

  // The one-shot POST /user-audio is gone from the app: every recording rides
  // the resumable transfer queue (transfers/worker.ts) whose finish fronts the
  // same engine route, so a flaky link resumes instead of losing the clip.

  public async uploadFile(file: File, onProgress?: (ratio: number) => void): Promise<any> {
    const headers: Record<string, string> = {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name || 'upload')
    };

    const STALL_MS = 20_000;
    const ac = new AbortController();
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => ac.abort(new Error('upload stalled: no progress for 20s')),
        STALL_MS
      );
    };
    let res: Response;
    try {
      if (!this.tunnel.ready()) {
        arm();
        const back = await this.tunnel.whenReady(RESEAL_GRACE_MS, ac.signal);
        if (!back) throw new EngineOffline(this.httpBase);
      }
      arm();
      res = await this.tunnel.sendStream(
        this.engineObjectUrl('/upload'),
        {method: 'POST', headers, signal: ac.signal},
        file,
        (sent, total) => {
          arm();
          if (onProgress && total > 0) onProgress(sent / total);
        }
      );
    } finally {
      clearTimeout(stallTimer);
    }
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new Error('upload failed: bad JSON');
    }
  }

  // ---- resumable transfers (Lane A) ---------------------------------------
  // These front the /transfer/* routes over the same sealed tunnel every other
  // call uses. A begin/put/get error carries the engine's HTTP status so the
  // worker can tell a definitive 4xx (size cap, bad hash) from a retryable one;
  // finish returns the status and body without throwing so a 4xx there is the
  // definitive "could not send" the bubble draws. There is no timeout here on
  // purpose: the worker owns the one per-step deadline and passes its signal.

  public async transferBegin(
    body: {
      kind: 'upload' | 'user-audio';
      sessionId: string;
      size: number;
      mime: string;
      name?: string;
      sha256: string;
      cid?: string;
      durationS?: number;
    },
    opts: TransferOpts = {}
  ): Promise<{id: string; chunk: number; have: number[]}> {
    const res = await this.engineFetch('/transfer/begin', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      signal: opts.signal
    });
    if (!res.ok) {
      const err = httpErr('transfer begin', res.status) as Error & {status: number; max?: number};
      // A 413 names the cap it was over ({error: 'too large', max}); the worker
      // paints it on the failed bubble. Best effort: a body that is not that
      // shape leaves `max` unset and the worker falls back to the known cap.
      if (res.status === 413) {
        try {
          const body = (await res.json()) as {max?: unknown};
          if (typeof body?.max === 'number') err.max = body.max;
        } catch {
          // not JSON, or already consumed: the status alone is the verdict
        }
      }
      throw err;
    }
    return res.json();
  }

  public async transferPut(
    id: string,
    n: number,
    bytes: Blob,
    opts: TransferOpts = {}
  ): Promise<{have: number[]}> {
    const res = await this.engineFetch(`/transfer/${id}/${n}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/octet-stream'},
      body: bytes,
      signal: opts.signal,
      // Drain per fragment inside the send: the segment's bytes are gated on the
      // pipe's low-water mark AS they are buffered, so the pipelined burst cannot
      // dump a file's worth of chunks past the backpressure gate.
      drainEachFrame: true
    });
    if (!res.ok) throw httpErr('transfer put', res.status);
    return res.json();
  }

  public async transferGet(
    id: string,
    opts: TransferOpts = {}
  ): Promise<{have: number[]; size: number; chunk: number; done: boolean}> {
    const res = await this.engineFetch(`/transfer/${id}`, {signal: opts.signal});
    if (!res.ok) throw httpErr('transfer get', res.status);
    return res.json();
  }

  // `fronted`: the engine stamps x-cyc-fronted: 1 on a reply it got from the
  // route the transfer fronts (/upload, /user-audio), so the worker can tell
  // that route's definitive refusal from a transfer-route status that only
  // means "try again" (401/403/429 from the tunnel or owner check).
  public async transferFinish(
    id: string,
    opts: TransferOpts = {}
  ): Promise<{ok: boolean; status: number; body: unknown; fronted: boolean}> {
    const res = await this.engineFetch(`/transfer/${id}/finish`, {
      method: 'POST',
      signal: opts.signal
    });
    let bodyJson: unknown = null;
    try {
      bodyJson = await res.json();
    } catch {
      bodyJson = null;
    }
    return {
      ok: res.ok,
      status: res.status,
      body: bodyJson,
      fronted: res.headers.get('x-cyc-fronted') === '1'
    };
  }

  public async transferDelete(id: string): Promise<void> {
    try {
      await this.engineFetch(`/transfer/${id}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(15_000)
      });
    } catch {
      // best effort: the sweeper removes an abandoned dir after 7 days anyway
    }
  }

  // The transfer worker's backpressure gate: it fires pipelined segment PUTs
  // and awaits this between them, so it never outruns the sealed tunnel's send
  // buffer. Delegates to the tunnel, which resolves at the pipe's low-water mark.
  public tunnelDrain(): Promise<void> {
    return this.tunnel.tunnelDrain();
  }

  public uploadUrl(uploadId: string): string {
    return this.engineObjectUrl('/upload/' + encodeURIComponent(uploadId));
  }

  public audioUrl(msgId: string): string {
    return this.engineObjectUrl('/audio/' + msgId + '.mp3');
  }

  public docUrl(docId: string): string {
    return this.engineObjectUrl('/doc/' + encodeURIComponent(docId));
  }

  private emit<K extends keyof EngineEvents>(ev: K, ...args: Parameters<EngineEvents[K]>) {
    for (const fn of this.listeners[ev]) (fn as (...a: unknown[]) => void)(...args);
  }

  private async dialVia(
    sigUrl: string,
    iceServers: RTCIceServer[],
    how: string,
    auth?: RelayAuth
  ): Promise<Pipe | null> {
    const sig = wsSignal(sigUrl, auth);
    this.signal = sig;

    const rtc = new RtcDial(sig, iceServers, false);
    this.rtc = rtc;
    try {
      return await rtc.start();
    } catch (e) {
      cyclog('rtc.failed', {
        engine: this.url,
        how,
        err: String((e as Error)?.message ?? e),
        why: 'the DataChannel dial failed; there is no WS-data fallback, so this is a disconnect'
      });
      rtc.close('dial-failed');
      this.rtc = null;
      this.signal = null;
      return null;
    }
  }

  private async relayAuthFor(relayUrl: string): Promise<RelayAuth | undefined> {
    let engineId = '';
    try {
      engineId = new URL(relayUrl).searchParams.get('engine') ?? '';
    } catch {
      engineId = '';
    }
    if (!engineId) return undefined;
    const device = await getDeviceIdentity();
    return {
      spki: device.spki,
      sign: async (nonce: string) =>
        b64encode(
          await signId(
            device.keyPair.privateKey,
            new TextEncoder().encode(
              `${nonce}|${engineId}|cyc-relay-auth-v1`
            ) as Uint8Array<ArrayBuffer>
          )
        )
    };
  }

  private dialing = false;

  private async dial() {
    if (this.closed || this.held || this.dialing) return;
    this.dialing = true;
    try {
      await this.dialOnce();
    } finally {
      this.dialing = false;
    }
  }

  private async dialOnce() {
    this.emit('status', 'connecting');

    const sigUrl = relaySignalUrlFor(this.url);
    if (!sigUrl) {
      cyclog('signal.none', {
        engine: this.url,
        why: 'no announced engineId to signal for; waiting for a lease'
      });
      this.emit('status', 'disconnected');
      this.scheduleReconnect();
      return;
    }
    const pipe = await this.dialVia(
      sigUrl,
      rtcIceServers(),
      'relay',
      await this.relayAuthFor(sigUrl)
    );
    if (!pipe) {
      this.emit('status', 'disconnected');
      this.scheduleReconnect();
      return;
    }

    this.pipe = pipe;
    cyclog('pipe.open', {engine: this.url, queued: this.pending.length, reattach: this.attachedId});
    this.lastInboundAt = Date.now();
    this.awaitingInboundBy = null;
    this.sec = null;
    this.hs = null;

    this.buildVoiceCall();

    this.forgetCapabilities(
      'a new pipe: what the last one could do says ' + 'nothing about what this one can'
    );

    pipe.onmessage = (s) => this.onPipeMessage(pipe, s);
    pipe.onclose = (code, reason) => this.onPipeClose(pipe, code, reason);

    try {
      await this.handshake(pipe);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const uh = String((e as {userHost?: string})?.userHost ?? '');
      if (/identity changed/.test(msg)) {
        this.held = 'identity';
        cyclog('e2e.identity-changed', {engine: this.url, err: msg});
      } else if (/sec-fail: unknown-device/.test(msg)) {
        this.held = 'pairing';
        cyclog('e2e.unknown-device', {engine: this.url, err: msg});
      } else {
        cyclog('e2e.failed', {
          engine: this.url,
          err: msg,
          why: 'the sealed handshake failed; the client does not proceed in plaintext'
        });
      }

      this.pipe = null;
      this.sec = null;
      this.hs = null;
      pipe.close(4400, 'handshake-failed');
      this.rtc?.close('handshake-failed');
      this.rtc = null;
      this.signal = null;
      this.emit('status', 'disconnected');
      if (this.held === 'identity') {
        // trustEngine() landed during THIS attempt: retry with the trust
        // applied instead of parking and re-asking.
        if (this.retryAfterRekey()) return;
        const at = uh.indexOf('@');
        this.emit(
          'identityChanged',
          at >= 0 ? uh.slice(0, at) : '',
          at >= 0 ? uh.slice(at + 1) : ''
        );
        return;
      }
      if (this.held === 'pairing') {
        // paired() landed during THIS attempt (its dial() was swallowed by
        // the in-flight guard): the key is in the keyring now, so retry
        // instead of parking forever.
        this.retryAfterRekey();
        return;
      }
      this.scheduleReconnect();
      return;
    }
    this.rekeyKick = false;

    this.signal?.close(1000, 'upgraded');
    this.signal = null;

    this.sendPostHello();
  }

  private onPipeMessage(pipe: Pipe, s: string) {
    if (pipe !== this.pipe) return;

    this.lastInboundAt = Date.now();
    this.awaitingInboundBy = null;
    const hs = this.hs;
    if (hs && hs.pipe === pipe) {
      this.onHandshakeFrame(hs, s);
      return;
    }
    let frame: any;
    try {
      frame = JSON.parse(s);
    } catch {
      return;
    }
    const sec = this.sec;
    if (sec && sec.ready) {
      if (frame?.t !== 'x') return;
      void sec.chan
        .open(frame)
        .then((inner) => this.handle(inner))
        .catch(() => {});
      return;
    }
  }

  private onHandshakeFrame(hs: HandshakeState, s: string) {
    let frame: any;
    try {
      frame = JSON.parse(s);
    } catch {
      hs.rejectSec(new Error('sec: protocol'));
      return;
    }
    if (frame?.t === 'sec' && !hs.chan) {
      hs.resolveSec(frame as SecFrame);
      return;
    }
    if (frame?.t === 'x' && hs.chan) {
      void hs.chan
        .open(frame)
        .then((inner) => {
          if (!hs.doneSeen && inner?.t === 'sec-done') {
            hs.doneSeen = true;
            this.onSecDone(inner);
            hs.resolveDone?.();
          } else if (!hs.doneSeen && inner?.t === 'sec-fail') {
            hs.rejectDone?.(new Error('sec-fail: ' + String(inner.reason ?? 'unknown')));
          } else if (hs.doneSeen) {
            this.handle(inner);
          } else {
            hs.rejectDone?.(new Error('sec: protocol: expected sec-done'));
          }
        })
        .catch((e) => hs.rejectDone?.(e as Error));
      return;
    }
    hs.rejectSec(new Error('sec: protocol: unexpected frame ' + String(frame?.t)));
  }

  private onPipeClose(pipe: Pipe, code: number, reason: string) {
    if (pipe !== this.pipe) return;

    cyclog('pipe.close', {
      engine: this.url,
      code,
      reason: reason || undefined,
      stillQueued: this.pending.length
    });
    this.pipe = null;
    this.sec = null;
    this.hs = null;
    this.awaitingInboundBy = null;

    this.tunnel.reset('pipe closed');
    this.forgetCapabilities(
      'the pipe closed; a send composed while ' + 'disconnected must promise nothing'
    );
    this.voiceCall?.close();
    this.voiceCall = null;
    this.failSttStreams();
    this.rtc?.close('pipe-closed');
    this.rtc = null;
    this.signal = null;
    this.emit('status', 'disconnected');
    this.scheduleReconnect();
  }

  // The next dial is the manager's to time (R1): it calls redialNow when the
  // backoff says so, or at once on a poke.
  private scheduleReconnect() {
    if (this.closed || this.held) return;
    this.reconnect.schedule();
  }

  // True when a dial went out; false when this client will not dial (closed,
  // held for pairing or identity, or already on an open pipe).
  public redialNow(caller: string): boolean {
    if (this.closed || this.held) return false;
    if (this.pipe || this.dialing) return false;
    cyclog('socket.redial', {engine: this.url, caller});
    void this.dial();
    return true;
  }

  private handle(frame: any) {
    if (frame?.t === 'ping') {
      this.sendNow({t: 'pong', n: frame.n});
      return;
    }
    // The answer to our own probe; onPipeMessage already cleared the deadline.
    if (frame?.t === 'pong') return;

    if (frame?.t === 'res') {
      this.tunnel.onRes(frame);
      return;
    }

    if (frame?.t === 'fp') {
      this.voiceCall?.bindFp(frame);
      return;
    }
    if (frame?.t === 'partial' || frame?.t === 'final') {
      this.voiceCall?.onSttFrame(frame);
      return;
    }

    if (frame?.t === 'stt-partial' || frame?.t === 'stt-final' || frame?.t === 'stt-error') {
      this.sttStreams.get(String(frame.id))?.onFrame(frame);
      return;
    }

    dispatchFrame(this as unknown as FrameContext, frame);
  }

  private checkLiveness() {
    if (!this.sealReady()) {
      this.awaitingInboundBy = null;
      return;
    }
    const now = Date.now();
    if (this.awaitingInboundBy !== null) {
      if (now > this.awaitingInboundBy) this.presumeDead();
      return;
    }

    if (!this.visible || this.attachedId === undefined) return;
    const quiet = now - this.lastInboundAt;
    if (quiet < LIVENESS_QUIET_MS) return;

    // A ping, never an attach: an attach replays pages and the whole event log
    // (log-audit), a pong is one frame.
    const n = ++this.probeN;
    cyclog('socket.probe', {
      engine: this.url,
      quietMs: quiet,
      n,
      why: 'nothing inbound for too long; pinging for the pong the engine always answers'
    });
    this.sendNow({t: 'ping', n});
    this.awaitingInboundBy = now + LIVENESS_GRACE_MS;
  }

  private presumeDead() {
    const pipe = this.pipe;
    if (!pipe) return;
    cyclog('pipe.presumed-dead', {
      engine: this.url,
      quietMs: Date.now() - this.lastInboundAt,
      stillQueued: this.pending.length,
      why: 'open pipe, but the engine answered nothing it owed an answer; treating it as dead'
    });
    this.pipe = null;
    this.sec = null;
    this.hs = null;
    this.awaitingInboundBy = null;

    this.forgetCapabilities('the pipe was presumed dead');
    try {
      pipe.close(4008, 'presumed-dead');
    } catch {}
    this.voiceCall?.close();
    this.voiceCall = null;
    this.failSttStreams();
    this.rtc?.close('presumed-dead');
    this.rtc = null;
    this.signal = null;
    this.emit('status', 'disconnected');
    this.scheduleReconnect();
  }

  private sealReady(): boolean {
    return !!(this.pipe?.open && this.sec?.ready);
  }

  private writeRaw(raw: string): boolean {
    const pipe = this.pipe;
    const sec = this.sec;
    if (!pipe?.open || !sec?.ready) return false;
    const chan = sec.chan;
    sec.writeChain = sec.writeChain.then(async () => {
      let inner: unknown;
      try {
        inner = JSON.parse(raw);
      } catch {
        return;
      }
      let sealed;
      try {
        sealed = await chan.seal(inner);
      } catch {
        return;
      }
      try {
        pipe.send(JSON.stringify(sealed));
      } catch {}
    });
    return true;
  }

  // The active chat is re-attached by the store on the settled edge, with the
  // current frontier; the tail and the terminals are this pipe's to re-arm.
  private sendPostHello() {
    if (this.tailedId !== null) this.sendNow({t: 'session-tail', id: this.tailedId, on: true});
    for (const [id, size] of this.terms) {
      this.sendNow({t: 'term-open', id, dev: clientId(), cols: size.cols, rows: size.rows});
    }

    for (const raw of this.pending.splice(0)) this.writeRaw(raw);
    this.emit('status', 'connected');
  }

  private storedUserHost(): string | null {
    try {
      return localStorage.getItem('cyc:e2e:uh:' + this.url);
    } catch {
      return null;
    }
  }
  private rememberUserHost(uh: string) {
    if (!uh || uh === '@') return;
    try {
      localStorage.setItem('cyc:e2e:uh:' + this.url, uh);
    } catch {}
  }

  private engineFetch(path: string, init?: EngineFetchInit): Promise<Response> {
    return engineCapFetch(this.httpBase + path, init);
  }

  private engineObjectUrl(path: string): string {
    return this.httpBase + path;
  }

  /** True when a rekey (paired / trustEngine) landed while the just-failed
   *  attempt was in flight: skip the park, schedule the reconnect that the
   *  swallowed kick meant to cause. */
  private retryAfterRekey(): boolean {
    if (!this.rekeyKick) return false;
    this.rekeyKick = false;
    this.held = null;
    this.scheduleReconnect();
    return true;
  }

  public async paired(userHost: string): Promise<void> {
    this.rememberUserHost(userHost);
    this.held = null;
    this.rekeyKick = true;
    if (this.pipe) {
      try {
        this.pipe.close(1000, 're-paired');
      } catch {}
    } else if (!this.closed) {
      void this.dial();
    }
  }

  private forgetUserHost() {
    try {
      localStorage.removeItem('cyc:e2e:uh:' + this.url);
    } catch {}
  }

  public async trustEngine(): Promise<void> {
    try {
      await clearEnginePin(this.url);
    } catch {}
    const uh = this.storedUserHost();
    if (uh) {
      try {
        await deleteKey(uh);
      } catch {}
    }
    this.forgetUserHost();
    this.held = null;
    this.rekeyKick = true;
    if (!this.closed) void this.dial();
  }

  private async handshake(pipe: Pipe): Promise<void> {
    const device = await getDeviceIdentity();
    const offer = await SecureChannel.offer();

    const secFrame = await new Promise<SecFrame>((resolve, reject) => {
      this.hs = {
        pipe,
        offer,
        device,
        resolveSec: resolve,
        rejectSec: reject,
        resolveDone: null,
        rejectDone: null,
        chan: null,
        doneSeen: false
      };
      cyclog('hs.hello', {engine: this.url});
      pipe.send(JSON.stringify({t: 'hello', sec: offer.hello}));
    });
    cyclog('hs.sec', {engine: this.url, uh: `${secFrame.user}@${secFrame.host}`});

    const uh = `${secFrame.user}@${secFrame.host}`;
    let expectFp = await getEnginePin(this.url);
    if (!expectFp) {
      const stored = this.storedUserHost();
      if (stored) expectFp = (await getByUserHost(stored))?.fp ?? null;
    }
    let chan: SecureChannel;
    try {
      chan = await SecureChannel.accept(offer, secFrame, expectFp);
    } catch (e) {
      if (/identity changed/.test(String((e as Error)?.message ?? e))) {
        const err = new Error('sec: engine identity changed') as Error & {userHost?: string};
        err.userHost = uh;
        throw err;
      }
      throw e;
    }

    const fp = await fpOfSpki(secFrame.id);
    await setEnginePin(this.url, {fp, spki: secFrame.id});
    await pinEngineIdentity(uh, fp, secFrame.id).catch(() => {});

    const pastedUh = this.storedUserHost();
    this.rememberUserHost(uh);

    const transcript = secTranscript(
      'c',
      offer.hello.ce,
      secFrame.ee,
      offer.hello.cn,
      secFrame.en,
      secFrame.id
    );
    const sig = b64encode(
      await signId(
        device.keyPair.privateKey,
        new TextEncoder().encode(transcript) as Uint8Array<ArrayBuffer>
      )
    );

    const secOkInner: {t: 'sec-ok'; dev: string; sig: string; label: string; pair?: string} = {
      t: 'sec-ok',
      dev: device.spki,
      sig,
      label: deviceLabel()
    };
    try {
      let rec = await getByUserHost(uh);
      if (!rec?.key && pastedUh && pastedUh !== uh) rec = await getByUserHost(pastedUh);
      if (rec?.key) secOkInner.pair = await secPairTag(await derivePairKey(rec.key), transcript);
    } catch {}

    const done = new Promise<void>((resolve, reject) => {
      this.hs!.chan = chan;
      this.hs!.resolveDone = resolve;
      this.hs!.rejectDone = reject;
    });

    this.sec = {chan, ready: false, writeChain: Promise.resolve(), userHost: uh, pastedUh};

    const secOk = await chan.seal(secOkInner);
    pipe.send(JSON.stringify(secOk));
    cyclog('hs.secok', {engine: this.url, hasPair: !!secOkInner.pair});

    try {
      await done;
    } catch (e) {
      const err = new Error(String((e as Error)?.message ?? e)) as Error & {userHost?: string};
      err.userHost = uh;
      throw err;
    }
    cyclog('hs.sealed', {engine: this.url});
    if (this.sec) this.sec.ready = true;
    this.hs = null;

    this.tunnel.signalReady();
  }

  private onSecDone(frame: any) {
    const uh = this.sec?.userHost || this.storedUserHost();
    const pastedUh = this.sec?.pastedUh ?? null;
    const content = Array.isArray(frame.content) ? frame.content : [];
    if (uh && content.length) {
      void storeGenerations(
        uh,
        content.map((c: any) => ({
          gen: Number(c?.gen) || 0,
          kid: String(c?.kid ?? ''),
          key: String(c?.key ?? '')
        }))
      )
        .then(() => {
          if (pastedUh && pastedUh !== uh) return deleteKey(pastedUh);
        })
        .catch(() => {});
    }
  }

  // True when the frame was written to a sealed pipe (R8); false when it waits
  // for the next connect. `session-tail` is not queued: the next pipe re-arms
  // it from tailedId (sendPostHello), and a stale copy behind it would flip the
  // tail twice.
  private send(frame: object): boolean {
    const raw = JSON.stringify(frame);
    if (this.sealReady()) {
      this.writeRaw(raw);
      return true;
    }
    const t = (frame as {t?: string}).t;
    if (t === 'session-tail') return false;
    // Latest wins for a position, a visibility fact, or the attached chat: an
    // older copy behind it in the queue says nothing true any more.
    if (t === 'progress' || t === 'visible' || t === 'attach') {
      const id = (frame as {id?: string}).id;
      this.pending = this.pending.filter((p) => {
        try {
          const f = JSON.parse(p);
          return !(f?.t === t && (t === 'attach' || f?.id === id));
        } catch {
          return true;
        }
      });
    }

    this.pending.push(raw);
    cyclog('send.queued', {
      t,
      session: (frame as {id?: string}).id,
      cid: (frame as {cid?: string}).cid,
      msgId: (frame as {msgId?: string}).msgId,
      depth: this.pending.length,
      why: 'the engine pipe is not sealed; this frame waits for the next connect'
    });
    return false;
  }

  private sendNow(frame: object) {
    this.writeRaw(JSON.stringify(frame));
  }
}
