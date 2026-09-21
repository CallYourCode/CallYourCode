import {setAppAuth} from './appFetch';
import {setLogAutoShip} from '../shared/logging';
import {hostnameOf} from './hostNames';
import {
  cachedImageBlob,
  cachedImagesMatching,
  cachedImageUrl,
  putImage
} from '../features/media/imageCache';

export type EngineAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export type EngineSessionTitle = {
  text: string;
  detail: string | null;
};

export type EngineTab = {
  key: string;
  title: EngineSessionTitle;
};

export const WIDGET_KEY_RE = /^[a-z0-9_-]{1,32}$/;

export type ComposerWidgetDecl =
  | {
      type: 'menu';
      icon: string;
      label: string;
      key?: string;
      items: {text: string; insert: string}[];
    }
  | {
      type: 'slider';
      icon: string;
      label: string;
      key: string;
      value?: number;
      steps: {n: number; name: string; hint?: string}[];
    };

export type EnginePluginDecl = {
  id: string;
  name: string;
  version: number;
  card?: {title: string; refreshFloorS: number};

  panel?: {
    icon: string;
    label: string;
    needsSession: boolean;
    ops?: string[];
    dock?: 'full' | 'side' | 'page';
    badge?: string;
    toolbarDefault?: boolean;
  };

  action?: {
    icon: string;
    label: string;
    needsSession: boolean;
    run?: string;
    badge?: string;
    toolbarDefault?: boolean;
    confirm?: {label: string; message: string};
  };
  composer?: ComposerWidgetDecl[];

  tui?: {icon: string; label: string; toolbarDefault?: boolean};
};

export type EngineReadThrough = {mid?: string; ts: number};

export type EngineSessionSettings = {
  muted?: boolean;
  notify?: boolean;
  activity?: boolean;
};

export type EngineSession = {
  id: string;
  name: string;
  cwd: string;
  unread: number;
  muted: boolean;

  settings?: EngineSessionSettings;

  photo?: string | null;
  alive: boolean;
  thinking?: boolean;
  claudeSessionId: string | null;

  contextPct?: number | null;

  status?: EngineAgentStatus;

  title?: EngineSessionTitle;

  tab?: string;

  agent?: string;

  agentId?: string;

  sessionAgentId?: string;
  displayAgent?: string | null;

  model?: string | null;

  turnSince?: number;

  lastActivity?: number;
  replyLevel?: number;
  stateChangeSeq?: number;

  heardTs?: number;
  /* THE READ-THROUGH ROW IDENTITY (fix-unread): the durable key (`mid`) and
   * instant of the newest row the engine has recorded as read. The engine is
   * the ONE authority; the app anchors its divider, landing and speech on THIS
   * row, found by id, never on a timestamp it recomputes. Null when nothing is
   * read yet; absent from an engine older than this field, where `heardTs`
   * above is the only marker. */
  readThrough?: EngineReadThrough | null;
  order?: number;

  ask?: EngineAsk | null;

  askUnknown?: boolean;
};

export type EngineAskChoice = {
  n: number;
  label: string;
  detail?: string;

  freeText?: boolean;
};

export type EngineAsk = {
  question: string;

  context: string[];
  choices: EngineAskChoice[];

  fingerprint: string;
};

/** One session record (a `t:"s"` row of the agent's log): the harness's own
 *  activity (prompt, reply, tool, compact) and the engine's own facts (status,
 *  ask, mux, harness, ...). It rides on the same page as the messages, on the
 *  same seq axis; `uuid` is the record's id (`se-...`). `kind` is open: a kind
 *  this build has no pill for is still held (it counts toward its page) and
 *  simply not painted. */
export type EngineSessionEvent = {
  uuid: string;
  ts: number;
  seq?: number;

  kind: string;
  text: string;
  tool?: string;
  // where an input reached the agent from, and (for `agent`) the sending id
  source?: string;
  sender?: string;
};

export type EngineAgentRun = {
  toolUseId: string;
  agentId: string | null;
  ts: number;
  desc: string;
  endedTs: number | null;
  tokens: string | null;

  source?: 'pi';
  model?: string;
};

export type EngineFileRef = {
  docId: string;
  name: string;

  fileKind: 'markdown' | 'diff' | 'text' | 'image' | 'html' | 'binary';
  size: number;

  inline?: boolean;
  content?: string;

  width?: number;
  height?: number;
};

export type CycUpload = {
  uploadId: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  image: boolean;

  fromPage?: {label: string; page: string};

  durationS?: number;

  at?: number;
  textLen?: number;

  width?: number;
  height?: number;
};

export type EngineChatMessage = {
  id: string;
  role: 'user' | 'claude';
  text: string;
  ts: number;
  msgId?: string;
  kind?: 'text' | 'voice';
  durationS?: number;

  growing?: boolean;
  upload?: CycUpload;

  uploads?: CycUpload[];
  queued?: boolean;

  cid?: string;

  wordsFailed?: boolean;

  transcriptPending?: boolean;
  file?: EngineFileRef;

  scheduled?: string;

  seq?: number;
  /** The engine's durable, restart- and renumber-invariant row id (`mr-...`),
   *  minted at write time. The app dedups on it so a row re-served under a
   *  changed seq is not painted twice. Absent on messages from an engine older
   *  than this field; those dedup by ts|role|text instead. */
  mid?: string;
};

/** One page of an agent's log as the wire carries it: the chat messages and
 *  the session records that share its seq range, split by the decoder. */
export type EnginePage = {
  page: number;
  version: number;
  sealed: boolean;
  messages: EngineChatMessage[];
  events: EngineSessionEvent[];
};

export type EngineAttachOk = {
  id: string;
  known: boolean;
  pointer?: number;
  pointerPage?: number;
  tailPage?: number;
  pageSize?: number;
  total?: number;
  pages?: EnginePage[];
  /* The engine's current queued user-row list (ts values), authoritative on
   * every attach: a dequeue is a patch that no seq/version check can see, so
   * a client that missed the live `dequeued` frame reconciles here. Absent on
   * older engines (then the latest-reply heuristic still applies). */
  queued?: number[];
  /* Lowest seq the engine actually covered in this delta. Absent on a
   * legacy have-attach. The app advances frontier to T after painting. */
  deltaBase?: number;
};

// The engine's receipt for an utterance, sent before any delivery work.
// `dup` is true when this cid was already taken (the app re-sent it).
export type EngineAck = {
  id: string;
  cid: string;
  dup: boolean;
  msgId?: string;
  // The definitive nack: the engine did not take the send and never will as
  // it stands ('unknown-session'). The message stays, not delivered; a tap
  // sends it again.
  err?: string;
};

// The engine could not deliver a send and never will as it stands: an offline
// session (a dead pane, or a socket session with no live pipe). Unlike the
// ack-then-drop it replaced, this carries the cid, so the row it names is the
// one marked failed, with `reason` shown on it; a tap sends the same cid again
// once the session is back (offline design v2, F1).
export type EngineSendFailed = {
  id: string;
  cid: string;
  reason: string;
};

export type SttStreamHandlers = {
  onPartial?: (text: string, committed?: number, committedS?: number) => void;
};

export interface SttStream {
  push(pcm: Float32Array): void;
  finish(): Promise<string>;
  abort(): void;
  readonly failed: boolean;
}

export type EngineEvents = {
  status(s: 'connecting' | 'connected' | 'disconnected'): void;

  pairNeeded(user: string, host: string): void;

  downgraded(user: string, host: string): void;

  identityChanged(user: string, host: string): void;

  host(user: string, host: string): void;

  voiceHealth(healthy: boolean): void;

  sessions(list: EngineSession[], tabs: EngineTab[]): void;

  plugins(list: EnginePluginDecl[]): void;

  chat(m: EngineChatMessage): void;

  attachOk(a: EngineAttachOk): void;

  ack(a: EngineAck): void;

  sendFailed(f: EngineSendFailed): void;

  say(sessionId: string, msgId: string, text: string, origin?: string, growing?: boolean): void;

  sayGrow(sessionId: string, msgId: string, durS?: number, chars?: number): void;

  sayDone(sessionId: string, msgId: string, durationS?: number): void;

  sayLive(sessionId: string, msgId: string): void;

  sayLiveFail(sessionId: string, msgId: string): void;

  dequeued(sessionId: string, ts: number): void;

  sessionEvent(sessionId: string, ev: EngineSessionEvent): void;

  termFrame(
    sessionId: string,
    f: {full: boolean; seq: number; cols: number; rows: number; bytes: string}
  ): void;

  termClosed(sessionId: string, why: string): void;

  termMode(sessionId: string, mode: 'scroll' | 'wheel' | 'none'): void;

  answerResult(sessionId: string, ok: boolean, reason?: string, detail?: string): void;

  compactResult(sessionId: string, ok: boolean, tell: string): void;

  sessionIdChanged(from: string, to: string): void;
};

export interface EngineClient {
  connect(): void;
  close(): void;
  on<K extends keyof EngineEvents>(ev: K, fn: EngineEvents[K]): void;

  attach(sessionId: string, frontier?: number): void;

  fetchPage(sessionId: string, n: number): Promise<EnginePage | null>;

  // True when the frame was written to a sealed pipe.
  progress(sessionId: string, seq: number, explicit?: boolean): boolean;
  heard(sessionId: string, row: {mid?: string; msgId?: string; ts?: number}): boolean;
  detach(): void;

  sendText(
    sessionId: string,
    text: string,
    extra?: {
      kind?: 'voice';
      msgId?: string;
      durationS?: number;
      upload?: CycUpload;
      uploads?: CycUpload[];
      cid?: string;
      words?: string[];
      partials?: {id: string; text: string; upToS: number}[];
    }
  ): boolean;

  can(feature: string): boolean;

  voiceHealthy(): boolean;
  interrupt(sessionId: string): void;

  compact(sessionId: string): void;

  answer(sessionId: string, fingerprint: string, choice: number): void;

  setSessionTail(sessionId: string, on: boolean): void;

  fetchSessionAgents(sessionId: string): Promise<EngineAgentRun[] | null>;

  openTerminal(sessionId: string, cols: number, rows: number): void;
  resizeTerminal(sessionId: string, cols: number, rows: number): void;
  sendTerminalInput(sessionId: string, input: {text: string} | {b64: string}): void;
  scrollTerminal(sessionId: string, dir: 'up' | 'down', lines: number): void;
  closeTerminal(sessionId: string): void;

  transcribe(audio: Blob): Promise<string>;
  transcribeStream(handlers?: SttStreamHandlers): SttStream;

  hasVoiceMedia(): boolean;
  openMediaSttStream(
    session: string,
    handlers: SttStreamHandlers,
    micTrack?: MediaStreamTrack | null
  ): SttStream;
  uploadFile(file: File): Promise<CycUpload>;
  uploadUrl(uploadId: string): string;
  audioUrl(msgId: string): string;
  docUrl(docId: string): string;
}

const PIN_KEY = 'cyc-engine';

const PIN_CLEARED_V = '1';
try {
  if (localStorage.getItem(PIN_KEY + '-cleared') !== PIN_CLEARED_V) {
    const leftover = localStorage.getItem(PIN_KEY);
    localStorage.removeItem(PIN_KEY);
    localStorage.setItem(PIN_KEY + '-cleared', PIN_CLEARED_V);
    if (leftover) {
      console.warn(
        `[cyc] cleared a stored engine pin (${leftover}) left in ` +
          'localStorage by an older build. It replaced the configured fleet on every ' +
          'load, which hid every other host, and an installed app has no way to pass ' +
          '?engine= to undo it. Pins are per-tab from now on.'
      );
    }
  }
} catch {}

export function isWsEnginePin(value: string): boolean {
  return /^wss?:\/\//i.test(value);
}

export function engineOverride(): string | null {
  const qs = new URLSearchParams(location.search).get('engine');
  try {
    if (qs !== null) {
      if (qs && isWsEnginePin(qs)) sessionStorage.setItem(PIN_KEY, qs);
      else if (!qs) sessionStorage.removeItem(PIN_KEY);
    }
    return sessionStorage.getItem(PIN_KEY) || null;
  } catch {
    return qs && isWsEnginePin(qs) ? qs : null;
  }
}

export function enginePin(): string | null {
  try {
    return sessionStorage.getItem(PIN_KEY) || null;
  } catch {
    return null;
  }
}

export function clearEnginePinAndReload(): void {
  try {
    sessionStorage.removeItem(PIN_KEY);
  } catch {}
  try {
    delete document.documentElement.dataset.cycPin;
  } catch {}
  const url = new URL(location.href);
  url.searchParams.delete('engine');
  location.replace(url.toString());
}

export function engineUrl(): string {
  const override = engineOverride();
  if (override) return override;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

const CONFIG_KEY = 'cyc-config';

export type AppEngine =
  string | {url: string; engineId: string; host: string; user?: string | null};

export type RtcIceServer = {urls: string[] | string; username?: string; credential?: string};
type RtcConfig = {iceServers?: RtcIceServer[]};
type AppConfig = {
  engines: AppEngine[];
  voice: string | null;
  voiceLabel?: string | null;
  auth?: 'clerk' | 'none';
  clerkPublishableKey?: string;
  rtc?: RtcConfig;
};
let appConfig: AppConfig | null = (() => {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? (JSON.parse(raw) as AppConfig) : null;
  } catch {
    return null;
  }
})();

setAppAuth(appConfig?.auth, appConfig?.clerkPublishableKey);
/* Auto-shipping the diagnostic log is a LOCAL-only behavior (hosted is
 * report-only: shared/logging.ts). Enabled ONLY when a config is actually
 * known and does not name clerk: an unknown mode stays fail-private. */
setLogAutoShip(!!appConfig && appConfig.auth !== 'clerk');

export function hasCachedConfig(): boolean {
  return !!appConfig;
}

const configuredListeners: Array<() => void> = [];

export function onConfiguredEngines(fn: () => void): () => void {
  configuredListeners.push(fn);
  return () => {
    const i = configuredListeners.indexOf(fn);
    if (i >= 0) configuredListeners.splice(i, 1);
  };
}

export async function loadAppConfig(): Promise<void> {
  try {
    const res = await fetch('/config', {
      cache: 'no-store',
      signal: AbortSignal.timeout(appConfig ? 3000 : 8000)
    });
    if (!res.ok) return;
    const cfg = (await res.json()) as AppConfig;
    // Auth is independent of the engine list: a logged-out HOSTED user gets
    // engines:[] (engines are owner-scoped, so nothing is announced until a
    // session exists), but must still get the Clerk sign-in gate. Apply auth
    // BEFORE the empty-engines guard below, which only protects the cached engine
    // list from a transient empty announce. Without this, hosted login never
    // mounts and the user can never sign in.
    setAppAuth(cfg.auth, cfg.clerkPublishableKey);
    setLogAutoShip(cfg.auth !== 'clerk');
    if (!Array.isArray(cfg?.engines) || !cfg.engines.length) return;
    appConfig = cfg;
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    for (const fn of configuredListeners) fn();
  } catch {}
}

let pinAnnounced = false;
function announcePin(pin: string, hidden: string[]): void {
  if (pinAnnounced) return;
  pinAnnounced = true;
  console.warn(
    `[cyc] ENGINE PIN ACTIVE: ${pin}. The configured fleet is HIDDEN` +
      (hidden.length ? `: ${hidden.join(', ')}` : '') +
      '. Only this one host has tabs, ' +
      'sessions or chats. Two ways out, both without a query parameter: close and ' +
      'reopen the app (the pin dies with the tab), or load ?engine= with an empty value.'
  );
  try {
    document.documentElement.dataset.cycPin = pin;
  } catch {}
}

export type AppEngineInfo = {
  url: string;
  engineId: string;
  host: string;
  user: string | null;
  userHost: string;
};

function normalizeEngine(e: AppEngine): AppEngineInfo {
  if (typeof e === 'string') {
    const host = hostnameOf(e);
    return {url: e, engineId: e, host, user: null, userHost: host};
  }
  const host = (e.host && e.host.trim()) || hostnameOf(e.url);
  const user = e.user && e.user.trim() ? e.user.trim() : null;
  const url = e.url || '';
  return {
    url,
    engineId: (e.engineId && e.engineId.trim()) || url,
    host,
    user,
    userHost: user ? `${user}@${host}` : host
  };
}

export function configuredEngines(): AppEngineInfo[] {
  const list = appConfig?.engines;
  const raw: AppEngine[] = Array.isArray(list) && list.length ? list : [];
  const seen = new Set<string>();
  const out: AppEngineInfo[] = [];
  for (const e of raw) {
    const info = normalizeEngine(e);
    if (!info.url || seen.has(info.url)) continue;
    seen.add(info.url);
    out.push(info);
  }
  return out;
}

export function rtcIceServers(): RTCIceServer[] {
  const list = appConfig?.rtc?.iceServers;
  if (!Array.isArray(list)) return [];
  const out: RTCIceServer[] = [];
  for (const s of list.slice(0, 8)) {
    const urls = typeof s?.urls === 'string' ? [s.urls] : Array.isArray(s?.urls) ? s.urls : [];
    const clean = urls
      .filter((u) => typeof u === 'string' && /^(stun|turns?):/.test(u))
      .slice(0, 4);
    if (!clean.length) continue;
    if (typeof s.username === 'string' && typeof s.credential === 'string' && s.username) {
      out.push({urls: clean, username: s.username, credential: s.credential});
    } else {
      out.push({urls: clean});
    }
  }
  return out;
}

export function relaySignalUrlFor(engineWsUrl: string): string | null {
  const info = configuredEngines().find((e) => e.url === engineWsUrl);
  if (!info || !info.engineId || info.engineId === info.url) return null;
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const u = new URL(`${proto}//${location.host}/device`);
    u.searchParams.set('engine', info.engineId);
    return u.toString();
  } catch {
    return null;
  }
}

export function engineUrls(): string[] {
  const fromServer = appConfig?.engines?.map((e) => (typeof e === 'string' ? e : e.url)) ?? null;
  const override = engineOverride();
  if (override) {
    announcePin(
      override,
      (fromServer ?? []).filter((u) => u !== override)
    );
    return [override];
  }
  return [...new Set(fromServer ?? [])];
}

export function httpBaseOf(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
}

export function engineHttpBase(): string {
  return httpBaseOf(engineUrl());
}

// A fetch init the transfer segment PUT extends with `drainEachFrame` so the
// tunnel drains per fragment inside the send (see TunnelClient.fetch).
export type EngineFetchInit = RequestInit & {drainEachFrame?: boolean};

export interface EngineTunnel {
  ready(): boolean;
  fetch(url: string, init?: EngineFetchInit): Promise<Response>;

  whenReady(graceMs: number, signal?: AbortSignal): Promise<boolean>;
}

export class EngineOffline extends Error {
  constructor(readonly url: string) {
    super(`engine offline (no sealed transport): ${url}`);
    this.name = 'EngineOffline';
  }
}

export const RESEAL_GRACE_MS = 4000;

const engineTunnels = new Map<string, EngineTunnel>();
// Woken on every registration, so a gate that started before the client for
// its URL existed (a reload paints history before the pipe dials) sees it.
const tunnelWaiters = new Set<() => void>();

export function setEngineTunnel(httpBase: string, tunnel: EngineTunnel): void {
  engineTunnels.set(httpBase, tunnel);
  for (const wake of [...tunnelWaiters]) wake();
}

export function clearEngineTunnel(httpBase: string): void {
  engineTunnels.delete(httpBase);
}

function tunnelFor(url: string): EngineTunnel | null {
  for (const [base, tunnel] of engineTunnels) {
    if (url === base || url.startsWith(base + '/')) return tunnel;
  }
  return null;
}

// Resolves true once the sealed wire that serves `url` is up (its tunnel is
// registered AND ready), false when `maxMs` passes or `signal` aborts first.
// A media fetch after a reload waits here before it spends any retry, so the
// retry window never burns on a wire that is still dialing.
export function whenEngineReady(
  url: string,
  maxMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abortSub: AbortController | null = null;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      tunnelWaiters.delete(wake);
      if (timer) clearTimeout(timer);
      abortSub?.abort();
      resolve(ok);
    };
    const wake = () => {
      if (done) return;
      const tunnel = tunnelFor(url);
      if (!tunnel) return;
      if (tunnel.ready()) {
        finish(true);
        return;
      }
      // The tunnel's own waiter; a re-registration (a new client for the same
      // base) wakes us again and we ask the new one.
      abortSub?.abort();
      abortSub = new AbortController();
      const left = deadline - Date.now();
      if (left <= 0) {
        finish(false);
        return;
      }
      const mine = abortSub;
      void tunnel.whenReady(left, mine.signal).then((ok) => {
        if (done || mine.signal.aborted) return;
        if (ok) finish(true);
        else if (Date.now() >= deadline) finish(false);
      });
    };
    if (signal?.aborted) {
      finish(false);
      return;
    }
    signal?.addEventListener('abort', () => finish(false), {once: true});
    timer = setTimeout(() => finish(false), maxMs);
    tunnelWaiters.add(wake);
    wake();
  });
}

export async function engineCapFetch(url: string, init?: EngineFetchInit): Promise<Response> {
  const tunnel = tunnelFor(url);

  if (!tunnel) throw new EngineOffline(url);
  if (tunnel.ready()) return tunnel.fetch(url, init);

  const back = await tunnel.whenReady(RESEAL_GRACE_MS, init?.signal ?? undefined);
  if (back) return tunnel.fetch(url, init);
  throw new EngineOffline(url);
}

// `cache: true` reads the image cache before the wire and fills it after;
// `cache: 'fill'` only fills it (the caller already looked, or wants the wire's
// bytes to replace what the cache holds).
export async function engineObjectUrl(
  url: string,
  opts?: {cache?: boolean | 'fill'}
): Promise<string> {
  if (!/^https?:/i.test(url)) return url;
  if (opts?.cache === true) {
    const hit = await cachedImageUrl(url);
    if (hit) return hit;
  }
  const res = await engineCapFetch(url);
  if (!res.ok) {
    const err = new Error(`engine object ${res.status} for ${url}`) as Error & {status?: number};
    err.status = res.status;
    throw err;
  }
  const blob = await res.blob();
  if (opts?.cache) putImage(url, blob);
  return URL.createObjectURL(blob);
}

/** Fresh cached images whose url contains `substring`, lifted to object URLs.
 *  Used by the boot-time avatar warm so cached profile photos paint
 *  synchronously on the first render after an app open. */
export async function cachedImageObjectUrls(substring: string): Promise<Map<string, string>> {
  const blobs = await cachedImagesMatching(substring);
  const out = new Map<string, string>();
  for (const [url, blob] of blobs) {
    try {
      out.set(url, URL.createObjectURL(blob));
    } catch {
      /* an unusable row is just a miss */
    }
  }
  return out;
}

/** The image BYTES for an engine url: durable cache first, then the sealed
 *  wire (filling the cache). The notification-icon store needs bytes, not an
 *  object URL (a service worker cannot resolve a page's blob: url). */
export async function engineImageBlob(url: string): Promise<Blob> {
  const hit = await cachedImageBlob(url);
  if (hit) return hit;
  const res = await engineCapFetch(url);
  if (!res.ok) {
    const err = new Error(`engine object ${res.status} for ${url}`) as Error & {status?: number};
    err.status = res.status;
    throw err;
  }
  const blob = await res.blob();
  putImage(url, blob);
  return blob;
}

export function docUrl(docId: string, base?: string): string {
  return (base ?? engineHttpBase()) + '/doc/' + encodeURIComponent(docId);
}

export function clientId(): string {
  let id = localStorage.getItem('cyc-client-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('cyc-client-id', id);
  }
  return id;
}
