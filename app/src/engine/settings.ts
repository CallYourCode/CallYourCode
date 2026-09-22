import type {EngineSessionSettings} from './contract';
import {parseReplyStrings, type ReplyStringOverrides} from '../config/replyStrings';
import {appFetch} from './appFetch';
import * as intents from './intents';
import {APP_ENGINE_KEY, type GlobalSettingsPayload, type Intent} from './intents';
import * as drain from './sync/drain';
import type {DrainOutcome} from './sync/drain';
import * as sync from './sync/connection';

export type GlobalSettings = {
  speed: number;
  notify: boolean;
  sound: boolean;
  activity: boolean;

  replyLevel: number;
  complexity: number;

  verbosityOn: boolean;
  complexityOn: boolean;

  promptBitsOn: boolean;

  geom: boolean;

  keymap: Record<string, string>;

  strings: ReplyStringOverrides;

  mergedOrder: string[];
};

const DEFAULTS: GlobalSettings = {
  speed: 1,
  notify: true,
  sound: true,
  activity: true,

  /* Chat, not Read out: on a fresh install the voice engine is still
   * downloading its models, so a speech default would answer into silence. */
  replyLevel: 2,
  complexity: 3,

  verbosityOn: true,
  complexityOn: false,

  promptBitsOn: true,

  geom: false,

  keymap: {},

  strings: {},

  mergedOrder: []
};
const CACHE_KEY = 'cyc-global-settings';

const MERGED_ORDER_KEY = 'cyc-merged-order';

function readMergedOrderMirror(): string[] | null {
  try {
    const raw = localStorage.getItem(MERGED_ORDER_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

function writeMergedOrderMirror(ids: string[]): void {
  try {
    localStorage.setItem(MERGED_ORDER_KEY, JSON.stringify(ids));
  } catch {}
}

function seed(): GlobalSettings {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const c = JSON.parse(cached) as Partial<GlobalSettings>;
      const merged = {
        ...DEFAULTS,
        ...c,
        verbosityOn: typeof c.verbosityOn === 'boolean' ? c.verbosityOn : DEFAULTS.verbosityOn,
        complexityOn: typeof c.complexityOn === 'boolean' ? c.complexityOn : DEFAULTS.complexityOn,
        keymap: chords(c.keymap) ?? {},
        strings: parseReplyStrings((c as {strings?: unknown}).strings)
      };

      const mirror = readMergedOrderMirror();
      if (mirror) merged.mergedOrder = mirror;
      return merged;
    }
    const s: GlobalSettings = {...DEFAULTS};
    const rate = Number(localStorage.getItem('cyc-tts-rate'));
    if (rate >= 0.5 && rate <= 4) s.speed = rate;
    if (localStorage.getItem('cyc-session-activity') === '0') s.activity = false;
    s.keymap = {};

    s.mergedOrder = readMergedOrderMirror() ?? DEFAULTS.mergedOrder;
    return s;
  } catch {
    return {...DEFAULTS};
  }
}

function chords(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

let current: GlobalSettings = seed();

let confirmed: GlobalSettings = current;
let seq = -1;

type Listener = () => void;
const listeners = new Set<Listener>();

export function onGlobalSettings(fn: Listener): void {
  listeners.add(fn);
}

function apply(next: GlobalSettings, nextSeq: number, announce: boolean, heard = false) {
  const changed = heard || JSON.stringify(next) !== JSON.stringify(current);
  current = next;
  seq = nextSeq;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(current));
  } catch {}

  writeMergedOrderMirror(current.mergedOrder);
  if (changed && announce) for (const fn of listeners) fn();
}

function applyServer(j: unknown): void {
  const heard = noteServerDials(j);
  confirmed = parse(j);
  apply(confirmed, Number((j as {seq?: number} | null)?.seq) || 0, true, heard);
}

export function globalSettings(): GlobalSettings {
  return current;
}

function parse(j: unknown): GlobalSettings {
  const o = (j ?? {}) as Record<string, unknown>;
  return {
    speed: typeof o.speed === 'number' && o.speed >= 0.5 && o.speed <= 4 ? o.speed : DEFAULTS.speed,
    notify: typeof o.notify === 'boolean' ? o.notify : DEFAULTS.notify,
    sound: typeof o.sound === 'boolean' ? o.sound : DEFAULTS.sound,
    activity: typeof o.activity === 'boolean' ? o.activity : DEFAULTS.activity,
    replyLevel: rung(o.replyLevel, DEFAULTS.replyLevel),
    complexity: rung(o.complexity, DEFAULTS.complexity),
    verbosityOn: typeof o.verbosityOn === 'boolean' ? o.verbosityOn : DEFAULTS.verbosityOn,
    complexityOn: typeof o.complexityOn === 'boolean' ? o.complexityOn : DEFAULTS.complexityOn,
    promptBitsOn: typeof o.promptBitsOn === 'boolean' ? o.promptBitsOn : DEFAULTS.promptBitsOn,
    geom: typeof o.geom === 'boolean' ? o.geom : DEFAULTS.geom,

    keymap: chords(o.keymap) ?? confirmed.keymap,

    strings: o.strings === undefined ? confirmed.strings : parseReplyStrings(o.strings),

    mergedOrder: o.mergedOrder === undefined ? confirmed.mergedOrder : sidList(o.mergedOrder)
  };
}

function sidList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function rung(v: unknown, fallback: number): number {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5 ? (v as number) : fallback;
}

export function mergedListOrder(): string[] {
  return current.mergedOrder;
}

export async function setMergedListOrder(ids: string[]): Promise<boolean> {
  return setGlobalSettings({mergedOrder: ids});
}

type StatedDials = {replyLevel: boolean; complexity: boolean};
let serverDials: StatedDials | null = null;

let serverKeymap: boolean | null = null;

function holds(j: unknown, patch: Partial<GlobalSettings>): boolean {
  const o = (j ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(patch)) {
    if (JSON.stringify(o[k]) !== JSON.stringify(patch[k as keyof GlobalSettings])) return false;
  }
  return true;
}

export function serverHasReplyDials(): StatedDials | null {
  return serverDials;
}

export function keymapKnown(): boolean | null {
  return serverKeymap;
}

function noteServerDials(j: unknown): boolean {
  const o = (j ?? {}) as Record<string, unknown>;
  const wasDials = JSON.stringify(serverDials);
  const wasKeymap = serverKeymap;
  serverDials = {
    replyLevel: Number.isInteger(o.replyLevel),
    complexity: Number.isInteger(o.complexity)
  };
  serverKeymap = chords(o.keymap) !== null;
  return JSON.stringify(serverDials) !== wasDials || serverKeymap !== wasKeymap;
}

// The patch this device has shown but the app server has not confirmed yet:
// the payload of the one queued global-settings intent (patches coalesce).
function pendingPatch(): Partial<GlobalSettings> {
  const row = intents
    .forEngine(APP_ENGINE_KEY)
    .find((i) => i.kind === 'global-settings' && i.state !== 'failed');
  return ((row?.payload as GlobalSettingsPayload | undefined)?.patch ??
    {}) as Partial<GlobalSettings>;
}

export async function refreshGlobalSettings(): Promise<void> {
  try {
    const res = await appFetch('/settings', {signal: AbortSignal.timeout(8000)});
    if (!res.ok) return;
    const j = (await res.json()) as unknown;
    const heard = noteServerDials(j);
    confirmed = parse(j);
    // A change still waiting to go out stays shown over the server's copy.
    apply(
      {...confirmed, ...pendingPatch()},
      Number((j as {seq?: number} | null)?.seq) || 0,
      true,
      heard
    );
  } catch {}
}

// Global settings are an intent (offline design v2, section 3): shown at once,
// queued under the app server's key, written on the next settled edge. A
// definitive refusal reverts to the confirmed copy and marks the row.
export async function setGlobalSettings(patch: Partial<GlobalSettings>): Promise<boolean> {
  apply({...current, ...patch}, seq, true);
  const id = `gset:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  const row = intents.put({
    id,
    engineKey: APP_ENGINE_KEY,
    kind: 'global-settings',
    coalesceKey: 'gset:app',
    payload: {patch} satisfies GlobalSettingsPayload
  });
  drain.kick(APP_ENGINE_KEY);
  return drain.whenSettled(row.id);
}

drain.registerExecutor('global-settings', async (intent: Intent): Promise<DrainOutcome> => {
  const {patch} = intent.payload as GlobalSettingsPayload;
  let res: Response;
  try {
    res = await appFetch('/settings', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    return 'transient';
  }
  if (!res.ok) {
    if (drain.isTransientStatus(res.status)) return 'transient';
    apply(confirmed, seq, true);
    return {failed: `the app server refused it (HTTP ${res.status})`};
  }
  const j = (await res.json().catch((): null => null)) as unknown;
  if (!holds(j, patch as Partial<GlobalSettings>)) {
    apply(confirmed, seq, true);
    return {failed: 'the app server did not keep the change'};
  }
  applyServer(j);
  return 'done';
});

// Settings are read on edges, never on an idle timer (offline design v2,
// section 1): once when the sync first goes live, again every time it comes
// back live, and again when the tab is brought to the foreground. Nothing polls
// while the app sits open and untouched.
let syncStarted = false;

export function startSettingsSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  const live = () => sync.status() === 'live';
  if (live()) void refreshGlobalSettings();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && live()) void refreshGlobalSettings();
  });
  sync.onStatus((st) => {
    if (st === 'live') void refreshGlobalSettings();
  });
}

type HasSettings = {settings?: EngineSessionSettings};

export function effectiveSpeed(): number {
  return current.speed;
}

export function effectiveMuted(s?: HasSettings | null): boolean {
  return s?.settings?.muted ?? !current.sound;
}

export function effectiveNotify(s?: HasSettings | null): boolean {
  return s?.settings?.notify ?? current.notify;
}

export function effectiveActivity(): boolean {
  try {
    return localStorage.getItem('cyc-session-activity') !== '0';
  } catch {
    return true;
  }
}
