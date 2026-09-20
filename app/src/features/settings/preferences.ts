import {paintAllChatWallpapers} from '@/features/chat/wallpaper';
import {setPresentationTheme} from '@/components/presentation';
import {closeForClear} from '@/engine/store/rows/rowStore';

export type CycThemeName = 'day' | 'night';
type Rgb = [number, number, number];
const hexToRgb = (hex: string): Rgb => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbSpaced = (hex: string) => hexToRgb(hex).join(', ');
const rgbTriple = (hex: string) => hexToRgb(hex).join(',');

// 10% wash of a semantic colour for hover/fill affordances.
const TINT_ALPHA = 0.1;
const tint = (hex: string) => `rgba(${rgbSpaced(hex)}, ${TINT_ALPHA})`;

// Explicit day/night product palette.
type CycPalette = {
  accent: string;
  accentPressed: string;
  msgSentPrimary: string;
  msgReceivedBackground: string;
  msgSentBackground: string;
  surface: string;
  danger: string;
  text: string;
  textMuted: string;
  green: string;
  background: string;
  border: string;
  fill: string;
  highlight: string;
  // Native scrollbar thumb tints, TS-owned per theme. The `::-webkit-scrollbar*`
  // pseudos and the `:where(...)` scrollbar-color skin in utilities.css still read
  // these vars; only the day/night value source moved off the un-layered sheet.
  scroll: string;
  scrollActive: string;
};
const PALETTE: Record<CycThemeName, CycPalette> = {
  day: {
    accent: '#96602f',
    accentPressed: '#784d26',
    msgSentPrimary: '#1b1b1d',
    msgReceivedBackground: '#ffffff',
    msgSentBackground: '#ead9c6',
    surface: '#ffffff',
    danger: '#cc2f2f',
    text: '#1c1c1e',
    textMuted: '#6b6b70',
    green: '#4f9e57',
    background: '#ece9e3',
    border: '#e6e6e8',
    fill: '#96602f',
    highlight: 'rgba(150, 96, 47, .88)',
    scroll: 'rgba(100, 100, 100, 0.4)',
    scrollActive: 'rgba(0, 0, 0, 0.6)'
  },
  night: {
    accent: '#c98652',
    accentPressed: '#a16b42',
    msgSentPrimary: '#fbfbfc',
    msgReceivedBackground: '#1e1e22',
    msgSentBackground: '#4a3527',
    surface: '#17171a',
    danger: '#e8484a',
    text: '#ededee',
    textMuted: '#a0a0a6',
    green: '#46b56e',
    background: '#0d0d0e',
    border: '#000000',
    fill: '#a86c38',
    highlight: 'rgba(168, 108, 56, .88)',
    scroll: 'rgba(121, 121, 121, 0.4)',
    scrollActive: 'rgba(191, 191, 191, 0.4)'
  }
};

function compatVars(name: CycThemeName): {[k: string]: string} {
  const p = PALETTE[name];
  return {
    '--cyc-accent': p.accent,
    '--cyc-accent-rgb': rgbTriple(p.accent),
    '--cyc-accent-tint': tint(p.accent),
    '--cyc-accent-pressed': p.accentPressed,
    '--cyc-bubble-out-ink': p.msgSentPrimary,
    '--cyc-bubble-out-ink-rgb': rgbTriple(p.msgSentPrimary),
    '--cyc-surface': p.surface,
    '--cyc-surface-rgb': rgbTriple(p.surface),
    '--cyc-danger': p.danger,
    '--cyc-danger-tint': tint(p.danger),
    '--cyc-text': p.text,
    '--cyc-text-muted': p.textMuted,
    '--cyc-text-muted-tint': tint(p.textMuted),
    '--cyc-bubble-in-surface': p.msgReceivedBackground,
    '--cyc-bubble-out-surface': p.msgSentBackground,
    '--cyc-bubble-out-surface-rgb': rgbTriple(p.msgSentBackground),
    '--cyc-ok': p.green,
    '--cyc-background-color': p.background,
    '--cyc-border-color': p.border
  };
}
function extraVars(name: CycThemeName): {
  [k: string]: string;
} {
  const p = PALETTE[name];
  const accentRgb = rgbSpaced(p.accent);
  return {
    '--cyc-sender-rgb': accentRgb,
    '--cyc-session-list-status-color': p.accent,
    '--cyc-fill-color': p.fill,
    '--cyc-overflow': p.scroll,
    '--cyc-overflow-hover': 'rgba(100, 100, 100, 0.7)',
    '--cyc-overflow-active': p.scrollActive
  };
}
export function applyCycTheme(name: CycThemeName, element: HTMLElement = document.documentElement) {
  const vars = {...compatVars(name), ...extraVars(name)};
  for (const k in vars) element.style.setProperty(k, vars[k]);
  const {highlight} = PALETTE[name];
  element.style.setProperty('--cyc-bubble-flash', highlight);
  element.style.setProperty('--cyc-bubble-flash-color', highlight);
  const dark = name === 'night';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.cycTheme = dark ? 'dark' : 'light';
  setPresentationTheme(name);
  paintAllChatWallpapers(dark);
  try {
    localStorage.setItem('cyc-skin', name);
  } catch {}
}
export const currentCycTheme = (): CycThemeName =>
  document.documentElement.dataset.theme === 'dark' ? 'night' : 'day';
export const storedCycTheme = (): CycThemeName | null => {
  try {
    const v = localStorage.getItem('cyc-skin');
    return v === 'day' || v === 'night' ? v : null;
  } catch {
    return null;
  }
};
import {globalSettings, keymapKnown, refreshGlobalSettings} from '../../engine/settings';
export type KeymapAction =
  'listPrev' | 'listNext' | 'tabPrev' | 'tabNext' | 'nextWaiting' | 'newline';
type KeymapEntry = {
  action: KeymapAction;
  title: string;
  subtitle: string;
  fallback: string;
};
export const KEYMAP: KeymapEntry[] = [
  {action: 'listPrev', title: 'Previous conversation', subtitle: '', fallback: 'Meta+ArrowUp'},
  {action: 'listNext', title: 'Next conversation', subtitle: '', fallback: 'Meta+ArrowDown'},
  {action: 'tabPrev', title: 'Previous tab', subtitle: 'the tab to the left', fallback: ''},
  {action: 'tabNext', title: 'Next tab', subtitle: 'the tab to the right', fallback: ''},
  {
    action: 'nextWaiting',
    title: 'Next agent waiting',
    subtitle: 'a session with unread activity',
    fallback: ''
  },
  {action: 'newline', title: 'New line', subtitle: 'Shift+Enter works too', fallback: 'Ctrl+J'}
];
const ACTIONS = new Set<string>(KEYMAP.map((k) => k.action));
const STORE_KEY = 'cyc-keymap';
function raw(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}
function writeLocal(map: Record<string, string>): boolean {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}
function stored(): Partial<Record<KeymapAction, string>> {
  const out: Partial<Record<KeymapAction, string>> = {};
  for (const [k, v] of Object.entries(raw())) {
    if (ACTIONS.has(k)) out[k as KeymapAction] = v;
  }
  return out;
}
export function binding(action: KeymapAction): string {
  const over = stored()[action];
  if (over !== undefined) return over;
  return KEYMAP.find((k) => k.action === action)?.fallback ?? '';
}
export function isDefault(action: KeymapAction): boolean {
  return stored()[action] === undefined;
}
export function setBindings(patch: Partial<Record<KeymapAction, string | null>>): Promise<boolean> {
  const map = {...raw()};
  for (const [action, chord] of Object.entries(patch)) {
    if (chord === null) delete map[action];
    else map[action] = chord as string;
  }
  return Promise.resolve(writeLocal(map));
}
export function setBinding(action: KeymapAction, chord: string | null): Promise<boolean> {
  return setBindings({[action]: chord});
}
export function resetKeymap(): Promise<boolean> {
  return Promise.resolve(writeLocal({}));
}
export async function seedKeymapFromServer(): Promise<void> {
  if (localStorage.getItem(STORE_KEY) !== null) return;
  await refreshGlobalSettings();
  if (keymapKnown() === null) return;
  writeLocal({...globalSettings().keymap});
}
export function actionFor(e: KeyboardEvent, among?: readonly KeymapAction[]): KeymapAction | null {
  const chord = chordOf(e);
  if (!chord) return null;
  for (const entry of KEYMAP) {
    if (among && !among.includes(entry.action)) continue;
    if (binding(entry.action) === chord) return entry.action;
  }
  return null;
}
export function isAction(e: KeyboardEvent, action: KeymapAction): boolean {
  const want = binding(action);
  return !!want && chordOf(e) === want;
}
const BARE_MODIFIERS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'AltGraph',
  'CapsLock',
  'Dead',
  'Unidentified'
]);
export const isBareModifier = (e: KeyboardEvent) => BARE_MODIFIERS.has(e.key);
export function chordOf(e: KeyboardEvent): string {
  if (isBareModifier(e)) return '';
  let key = e.key;
  if (!key) return '';
  if (key.length === 1 && /[a-z]/i.test(key)) key = key.toUpperCase();
  if (key === ' ') key = 'Space';
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(key);
  return parts.join('+');
}
export const hasModifier = (chord: string) => /^(Ctrl|Alt|Shift|Meta)\+/.test(chord);
const MAC = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const GLYPH: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: 'Enter',
  Escape: 'Esc',
  Space: 'Space',
  Backspace: '⌫',
  Tab: 'Tab'
};
const MOD_LABEL: Record<string, [mac: string, other: string]> = {
  Ctrl: ['⌃', 'Ctrl'],
  Alt: ['⌥', 'Alt'],
  Shift: ['⇧', 'Shift'],
  Meta: ['⌘', 'Win']
};
export function chordLabel(chord: string): string {
  if (!chord) return 'None';
  const mac = MAC();
  const out: string[] = [];
  let key = chord;
  for (;;) {
    const m = /^(Ctrl|Alt|Shift|Meta)\+/.exec(key);
    if (!m) break;
    out.push(MOD_LABEL[m[1]][mac ? 0 : 1]);
    key = key.slice(m[0].length);
  }
  out.push(GLYPH[key] ?? key);
  return out.join(mac ? '' : '+');
}
export const hasHardwareKeys = () => {
  try {
    return window.matchMedia('(any-hover: hover)').matches;
  } catch {
    return true;
  }
};
const SORT_KEY = 'cyc-sort-by-latest';
const MERGE_KEY = 'cyc-merge-tabs';
function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === '0') return false;
    if (v === '1') return true;
    return fallback;
  } catch {
    return fallback;
  }
}
function writeOn(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {}
}
export function sortByLatest(): boolean {
  return readPref(SORT_KEY, true);
}
export function setSortByLatest(on: boolean): void {
  writeOn(SORT_KEY, on);
}
export function mergeTabs(): boolean {
  return readPref(MERGE_KEY, false);
}
export function setMergeTabs(on: boolean): void {
  writeOn(MERGE_KEY, on);
}
// List-row chip visibility: one global '0'/'1' bit per chip, the same
// storage shape as the toolbar bits below (cyc-toolbar-<id>), shared by
// every agent on every engine. Default ON for both: a chip with no data
// (an older engine, or a model not yet known) never paints anyway, so the
// default only shows chips that carry a real fact.
export type CycRowChipId = 'harness' | 'model';
const CHIP_KEY = (id: CycRowChipId) => `cyc-chip-${id}`;
export function rowChipShown(id: CycRowChipId): boolean {
  return readPref(CHIP_KEY(id), true);
}
export function setRowChipShown(id: CycRowChipId, on: boolean): void {
  writeOn(CHIP_KEY(id), on);
}
import type {CycIconName} from '../../components/iconGlyphs';
export type CycToolbarActionId = string;
export const CORE_TOOLBAR_ACTION_IDS = [
  'speed',
  'sound',
  'activity',
  'call',
  'notify',
  'ctx',
  'model-indicator',
  'terminal',
  'git',
  'files',
  'persona',
  'search',
  'crons',
  'stop'
] as const;
type CycToolbarActionConfirm = {
  label: string;
  message: string;
};
function sanitizeActionConfirm(raw: unknown): CycToolbarActionConfirm | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const label = typeof c.label === 'string' ? c.label.trim() : '';
  const message = typeof c.message === 'string' ? c.message.trim() : '';
  if (!label || !message) return undefined;
  return {label, message};
}
export type CycToolbarAction = {
  id: CycToolbarActionId;
  icon: CycIconName | string;
  label: string;
  needsEngine?: boolean;
  plugin?: string;
  run?: string;
  confirm?: CycToolbarActionConfirm;
};
export const TOOLBAR_ACTIONS: readonly CycToolbarAction[] = [
  {id: 'speed', icon: 'equalizer', label: 'Speed'},
  {id: 'sound', icon: 'speaker', label: 'Autoplay'},
  {id: 'activity', icon: 'tools', label: 'Activity'},
  {id: 'crons', icon: 'replace', label: 'Crons', needsEngine: true, plugin: 'crons'},
  {id: 'call', icon: 'phone', label: 'Call', needsEngine: true},
  {id: 'notify', icon: 'unmute', label: 'Notify'},
  {id: 'ctx', icon: 'contextbar', label: 'Context', needsEngine: true},
  {
    id: 'model-indicator',
    icon: 'robot',
    label: 'Model',
    needsEngine: true,
    plugin: 'model-indicator'
  },
  {id: 'terminal', icon: 'terminal', label: 'TUI', needsEngine: true},
  {id: 'git', icon: 'gitbranch', label: 'Git', needsEngine: true, plugin: 'git'},
  {id: 'files', icon: 'folder', label: 'Files', needsEngine: true, plugin: 'files'},
  {id: 'persona', icon: 'user', label: 'Persona', needsEngine: true, plugin: 'persona'},
  {id: 'search', icon: 'search', label: 'Search', needsEngine: true, plugin: 'search'},
  {id: 'stop', icon: 'hand', label: 'Stop', needsEngine: true}
];
const CORE_ID_SET = new Set<string>(TOOLBAR_ACTIONS.map((a) => a.id));
let extraByEngine = new Map<string, readonly CycToolbarAction[]>();
export function pluginToolbarAction(
  pluginId: string,
  action: {
    icon?: unknown;
    label?: unknown;
    run?: unknown;
    confirm?: unknown;
  }
): CycToolbarAction | null {
  const id = pluginId;
  if (CORE_ID_SET.has(id)) return null;
  const icon = typeof action.icon === 'string' ? action.icon : '';
  const label = typeof action.label === 'string' ? action.label : '';
  if (!icon || !label) return null;
  const run = typeof action.run === 'string' && action.run ? action.run : undefined;
  const confirm = sanitizeActionConfirm(action.confirm);
  return {
    id,
    icon,
    label,
    needsEngine: true,
    plugin: pluginId,
    ...(run ? {run} : {}),
    ...(confirm ? {confirm} : {})
  };
}
export function setDeclaredPluginActions(byEngine: Map<string, readonly CycToolbarAction[]>): void {
  extraByEngine = byEngine;
}
function catalog(engineKey: string | null): readonly CycToolbarAction[] {
  const extras = engineKey ? (extraByEngine.get(engineKey) ?? []) : [];
  if (!extras.length) return TOOLBAR_ACTIONS;
  const add: CycToolbarAction[] = [];
  for (const a of extras) {
    if (!a.id || CORE_ID_SET.has(a.id)) continue;
    add.push(a);
  }
  return add.length ? [...TOOLBAR_ACTIONS, ...add] : TOOLBAR_ACTIONS;
}
// One global visibility bit per action, shared by every agent and session.
const KEY = (id: CycToolbarActionId) => `cyc-toolbar-${id}`;
const DEFAULT_VISIBLE: ReadonlySet<CycToolbarActionId> = new Set([
  'speed',
  'ctx',
  'search',
  'stop'
]);
let declaredDefaults = new Map<string, Partial<Record<CycToolbarActionId, boolean>>>();
export function setDeclaredToolbarDefaults(
  byEngine: Map<string, Partial<Record<CycToolbarActionId, boolean>>>
): void {
  declaredDefaults = byEngine;
}
function defaultShown(engineKey: string | null, id: CycToolbarActionId): boolean {
  const declared = engineKey ? declaredDefaults.get(engineKey)?.[id] : undefined;
  if (typeof declared === 'boolean') return declared;
  return DEFAULT_VISIBLE.has(id);
}
export function toolbarActionShown(engineKey: string | null, id: CycToolbarActionId): boolean {
  try {
    const v = localStorage.getItem(KEY(id));
    if (v === '0') return false;
    if (v === '1') return true;
  } catch {}
  return defaultShown(engineKey, id);
}
export function setToolbarActionShown(id: CycToolbarActionId, shown: boolean): void {
  try {
    localStorage.setItem(KEY(id), shown ? '1' : '0');
  } catch {}
}
const LEGACY_ORDER_KEY = 'cyc-toolbar-order';
const ORDER_KEY = (engineKey: string | null) =>
  engineKey ? `cyc-mast-order::${engineKey}` : LEGACY_ORDER_KEY;
function canonOf(engineKey: string | null): readonly CycToolbarActionId[] {
  return catalog(engineKey).map((a) => a.id);
}
function storedOrder(engineKey: string | null): unknown {
  try {
    if (engineKey) {
      const v = localStorage.getItem(ORDER_KEY(engineKey));
      if (v) return JSON.parse(v);
      const oldKey = `cyc-tb-order::${engineKey}`;
      const old = localStorage.getItem(oldKey);
      if (old) {
        localStorage.setItem(ORDER_KEY(engineKey), old);
        localStorage.removeItem(oldKey);
        return JSON.parse(old);
      }
    }
    const lv = localStorage.getItem(LEGACY_ORDER_KEY);
    if (lv) return JSON.parse(lv);
  } catch {}
  return [];
}
function toolbarActionOrder(engineKey: string | null): CycToolbarActionId[] {
  const stored = storedOrder(engineKey);
  const canon = canonOf(engineKey);
  const known = new Set<string>(canon);
  const seen = new Set<CycToolbarActionId>();
  const out: CycToolbarActionId[] = [];
  if (Array.isArray(stored)) {
    for (const id of stored) {
      if (typeof id === 'string' && known.has(id) && !seen.has(id)) {
        out.push(id);
        seen.add(id);
      }
    }
  }
  for (const id of canon) if (!seen.has(id)) out.push(id);
  return out;
}
export function setToolbarActionOrder(engineKey: string | null, ids: CycToolbarActionId[]): void {
  try {
    localStorage.setItem(ORDER_KEY(engineKey), JSON.stringify(ids));
  } catch {}
}
export function orderedToolbarActions(engineKey: string | null): CycToolbarAction[] {
  const byId = new Map(catalog(engineKey).map((a) => [a.id, a] as const));
  return toolbarActionOrder(engineKey)
    .map((id) => byId.get(id))
    .filter((a): a is CycToolbarAction => !!a);
}
export function engineToolbarActions(
  engineKey: string | null,
  declaredPlugins: ReadonlySet<string>
): CycToolbarAction[] {
  return orderedToolbarActions(engineKey).filter((a) => !a.plugin || declaredPlugins.has(a.plugin));
}
export function toolbarActionById(
  engineKey: string | null,
  id: CycToolbarActionId,
  declaredPlugins?: ReadonlySet<string>
): CycToolbarAction | undefined {
  const list = declaredPlugins
    ? engineToolbarActions(engineKey, declaredPlugins)
    : orderedToolbarActions(engineKey);
  return list.find((a) => a.id === id);
}
const ACTION_ID_RENAMES: Readonly<Record<string, CycToolbarActionId>> = {
  model: 'model-indicator',
  context: 'ctx',
  voice: 'persona'
};
const ID_MIGRATED_FLAG = 'cyc-mast-migrated::1';
export function migrateToolbarActionIds(): void {
  try {
    if (localStorage.getItem(ID_MIGRATED_FLAG)) return;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    const moveKey = (k: string, oldPrefix: string, newPrefix: string) => {
      const nk = newPrefix + k.slice(oldPrefix.length);
      const v = localStorage.getItem(k);
      if (v !== null && localStorage.getItem(nk) === null) localStorage.setItem(nk, v);
      localStorage.removeItem(k);
    };
    for (const k of keys) {
      if (k.startsWith('cyc-tb-order::')) moveKey(k, 'cyc-tb-order::', 'cyc-mast-order::');
      else if (k.startsWith('cyc-tb-sess::')) moveKey(k, 'cyc-tb-sess::', 'cyc-mast-session::');
      else if (k.startsWith('cyc-tb::')) moveKey(k, 'cyc-tb::', 'cyc-mast::');
      else if (k.startsWith('cyc-tb-migrated::'))
        moveKey(k, 'cyc-tb-migrated::', 'cyc-mast-keys-migrated::');
    }
    const currentKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) currentKeys.push(k);
    }
    const renameTail = (k: string, prefix: string) => {
      const newId = ACTION_ID_RENAMES[k.slice(prefix.length)];
      if (!newId) return;
      const v = localStorage.getItem(k);
      if (v === null) return;
      const nk = prefix + newId;
      if (localStorage.getItem(nk) === null) localStorage.setItem(nk, v);
      localStorage.removeItem(k);
    };
    const renameSegment = (k: string) => {
      const parts = k.split('::');
      const newId = ACTION_ID_RENAMES[parts[parts.length - 1]];
      if (!newId) return;
      const v = localStorage.getItem(k);
      if (v === null) return;
      parts[parts.length - 1] = newId;
      const nk = parts.join('::');
      if (localStorage.getItem(nk) === null) localStorage.setItem(nk, v);
      localStorage.removeItem(k);
    };
    const rewriteOrder = (k: string) => {
      const raw = localStorage.getItem(k);
      if (!raw) return;
      let arr: unknown;
      try {
        arr = JSON.parse(raw);
      } catch {
        return;
      }
      if (!Array.isArray(arr)) return;
      let changed = false;
      const out = arr.map((id) => {
        const n = typeof id === 'string' ? ACTION_ID_RENAMES[id] : undefined;
        if (n) {
          changed = true;
          return n;
        }
        return id;
      });
      if (changed) localStorage.setItem(k, JSON.stringify(out));
    };
    for (const k of currentKeys) {
      if (k === LEGACY_ORDER_KEY || k.startsWith('cyc-mast-order::')) rewriteOrder(k);
      else if (k.startsWith('cyc-mast::') || k.startsWith('cyc-mast-session::')) renameSegment(k);
      else if (k.startsWith('cyc-toolbar-')) renameTail(k, 'cyc-toolbar-');
    }
    localStorage.setItem(ID_MIGRATED_FLAG, '1');
  } catch {}
}
// Visibility went global (one set for every agent): collapse the old
// per-engine bits into the global keys and drop the per-session overrides.
const GLOBAL_MIGRATED_FLAG = 'cyc-toolbar-global::1';
export function migrateToolbarKeys(): void {
  try {
    migrateToolbarActionIds();
    if (localStorage.getItem(GLOBAL_MIGRATED_FLAG)) return;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    keys.sort();
    for (const k of keys) {
      if (k.startsWith('cyc-mast::')) {
        const id = k.slice(k.lastIndexOf('::') + 2);
        const v = localStorage.getItem(k);
        if (id && (v === '0' || v === '1') && localStorage.getItem(KEY(id)) === null) {
          localStorage.setItem(KEY(id), v);
        }
        localStorage.removeItem(k);
      } else if (k.startsWith('cyc-mast-session::') || k.startsWith('cyc-mast-keys-migrated::')) {
        localStorage.removeItem(k);
      }
    }
    localStorage.setItem(GLOBAL_MIGRATED_FLAG, '1');
  } catch {}
}
const CLEARED_IDB = ['cyc-history', 'cyc-clips', 'cyc-shown', 'cyc-rows'] as const;
const CLEARED_LOCAL = ['cyc-engaged', 'cyc-heard-ts', 'cyc-seen', 'cyc-hot-seen'] as const;
function deleteDatabase(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
export async function clearCachedData(): Promise<void> {
  for (const key of CLEARED_LOCAL) {
    try {
      localStorage.removeItem(key);
    } catch {}
  }
  // The conversation store keeps a persistent connection to cyc-rows and warm
  // in-memory mirrors of the open chat. deleteDatabase resolves on onblocked, so
  // deleting cyc-rows silently no-ops while that connection is open, and the open
  // chat would keep painting from the mirror. Close the connection and drop the
  // mirrors first; the store reopens lazily after the reload.
  closeForClear();
  await Promise.all(CLEARED_IDB.map(deleteDatabase));
}
