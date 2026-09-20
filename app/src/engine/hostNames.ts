type HostName = {user: string | null; host: string | null};

const KEY = 'cyc-host-names';

type Stored = Record<string, HostName>;

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === 'object' ? (obj as Stored) : {};
  } catch {
    return {};
  }
}

export function cachedHostName(engineKey: string): HostName | null {
  const e = read()[engineKey];
  return e && typeof e === 'object' ? {user: e.user ?? null, host: e.host ?? null} : null;
}

export function rememberHostName(
  engineKey: string,
  user: string | null,
  host: string | null
): void {
  if (!host) return;
  try {
    const all = read();
    all[engineKey] = {user: user || null, host};
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {}
}

export function hostnameOf(wsUrl: string): string {
  try {
    return new URL(wsUrl).hostname || wsUrl;
  } catch {
    return wsUrl;
  }
}
