const SEEN = new Set(['waiting', 'ready']);

export type RestartClaim = {
  confirmed: boolean;

  say: string;
};

export function restartClaim(body: unknown): RestartClaim {
  const b = (body ?? {}) as {verdict?: unknown; tell?: unknown; error?: unknown};
  const said = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    confirmed: typeof b.verdict === 'string' && SEEN.has(b.verdict),

    say:
      said(b.tell) ??
      said(b.error) ??
      'That host did not say what the terminal is showing. Open it to see.'
  };
}
