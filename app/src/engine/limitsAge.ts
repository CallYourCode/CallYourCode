export function takenAtFrom(ageMs: unknown, receivedAt: number): number | null {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return null;
  return receivedAt - ageMs;
}

export const USAGE_AGING_MS = 20 * 60_000;

export function ago(takenAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - takenAt) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

type Freshness = {
  takenAt: number | null;
  now: number;

  loading: boolean;

  hasNumbers: boolean;

  stale: boolean;

  throttled: boolean;
};

export function freshnessLabel(f: Freshness): string {
  if (f.takenAt === null) {
    if (f.loading) return 'checking…';

    return f.hasNumbers ? 'age unknown' : '';
  }
  const age = ago(f.takenAt, f.now);
  if (!f.stale || f.loading) return age;

  return f.throttled ? `${age} (check throttled)` : `${age} (retrying)`;
}
