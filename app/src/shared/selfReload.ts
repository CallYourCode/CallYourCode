// A reload the app does to itself (a new build, a missing chunk, an engine
// switch) keeps the open chat; any other launch (the user reopening the app,
// including after a force close) starts on the chats list. sessionStorage
// lives exactly as long as the page's browsing context, so the mark survives
// our own reload and is gone after the app is closed.

const KEY = 'cyc-self-reload';
// Our reloads land within seconds; an older mark is not about this boot.
const FRESH_MS = 60_000;

export function markSelfReload(): void {
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {}
}

/** True when this boot is the app's own reload; the mark is spent either way. */
export function consumeSelfReload(now: number = Date.now()): boolean {
  try {
    const at = Number(sessionStorage.getItem(KEY) ?? '');
    sessionStorage.removeItem(KEY);
    return Number.isFinite(at) && at > 0 && now - at < FRESH_MS;
  } catch {
    return false;
  }
}

// The update-reload departure breadcrumb, in localStorage (NOT sessionStorage):
// a black-screen reload that the owner force-closes out of ends the browsing
// context, so sessionStorage is gone on the next launch; localStorage is not.
// Stamped just before the reload navigation and read once at the next boot,
// it lets that boot log how long the gap was and which builds it crossed, so a
// stuck reload names itself instead of being a silent hole in app.log.
const DEPART_KEY = 'cyc-reload-depart';

// `hidden`: the reload left from the background (a draft held it until then),
// so its gap includes the time the app spent there and is not a stuck reload.
export type ReloadDeparture = {at: number; from: string; to: string; hidden: boolean};

export function markReloadDeparture(from: string, to: string, hidden = false): void {
  try {
    localStorage.setItem(DEPART_KEY, JSON.stringify({at: Date.now(), from, to, hidden}));
  } catch {}
}

/** The pending departure, if any; spent on read so each reload lands once. */
export function readReloadDeparture(): ReloadDeparture | null {
  try {
    const raw = localStorage.getItem(DEPART_KEY);
    localStorage.removeItem(DEPART_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<ReloadDeparture>;
    if (typeof p?.at !== 'number' || !Number.isFinite(p.at)) return null;
    return {
      at: p.at,
      from: String(p.from ?? ''),
      to: String(p.to ?? ''),
      hidden: p.hidden === true
    };
  } catch {
    return null;
  }
}
