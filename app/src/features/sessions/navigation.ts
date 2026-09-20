export type NavState = {
  host: string | null;
  chat: string | null;
  list: boolean;
  settings: boolean;
  profile: boolean;
  doc: string | null;
};
const KEYS = ['host', 'chat', 'list', 'settings', 'profile', 'doc'] as const;
export function opaqueKey(raw: string): string {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (1048575 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(13, '0');
}
export function looksOpaque(v: string | null): boolean {
  return !!v && /^[0-9a-f]{13}$/.test(v);
}
function parse(search: string): NavState {
  const q = new URLSearchParams(search);
  return {
    host: q.get('host') || null,
    chat: q.get('chat') || null,
    list: q.get('list') === '1',
    settings: q.get('settings') === '1',
    profile: q.get('profile') === '1',
    doc: q.get('doc') || null
  };
}
const BOOT: NavState = parse(location.search);
export function bootNav(): NavState {
  return {...BOOT};
}
export function bootWasOurs(): boolean {
  const b = BOOT;
  return looksOpaque(b.host) || b.list || b.settings || b.profile || !!b.doc || looksOpaque(b.chat);
}
export function writeNav(state: NavState): void {
  const url = new URL(location.href);
  for (const k of KEYS) url.searchParams.delete(k);
  if (state.host) url.searchParams.set('host', state.host);
  if (state.chat) url.searchParams.set('chat', state.chat);
  if (state.list) url.searchParams.set('list', '1');
  if (state.settings) url.searchParams.set('settings', '1');
  if (state.profile) url.searchParams.set('profile', '1');
  if (state.doc) url.searchParams.set('doc', state.doc);
  const next = url.toString();
  if (next === location.href) return;
  try {
    history.replaceState(history.state, '', next);
  } catch {}
}
