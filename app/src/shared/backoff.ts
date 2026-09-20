/* One exponential backoff, two jitter policies.
 *
 * Three call sites grew the same min(cap, base * 2^n) curve by hand and then
 * jittered it two different ways. The curve lives here now; each caller keeps
 * its own name, constants, attempt counter, and timer map and passes its policy
 * in.
 *
 * "scale"    multiplies the grown value by 0.75..1.25 (a symmetric jitter the
 *            sync dials use): min(cap, base * 2^(attempt + expOffset)) rounded.
 * "plusBase" adds one full base step of additive jitter to the grown value and
 *            clamps the exponent at zero (the transfer worker's policy today):
 *            min(max(base, cap), base * 2^max(0, attempt + expOffset)) plus
 *            floor(rnd * base). expOffset is -1 there, so attempt 0 grows by
 *            2^0 and attempt 1 by 2^0 as well. */
export type BackoffPolicy = {
  baseMs: number;
  capMs: number;
  expOffset?: number;
  jitter: 'scale' | 'plusBase';
};

export function expBackoff(
  policy: BackoffPolicy,
  attempt: number,
  rnd: number = Math.random()
): number {
  const {baseMs, capMs, jitter} = policy;
  const expOffset = policy.expOffset ?? 0;
  if (jitter === 'scale') {
    const grown = Math.min(capMs, baseMs * 2 ** (attempt + expOffset));
    return Math.round(grown * (0.75 + rnd * 0.5));
  }
  // plusBase: base can exceed cap (a testhook shrinks base), so the cap is at
  // least one base step; the exponent never goes below zero.
  const cap = Math.max(baseMs, capMs);
  const grown = Math.min(cap, baseMs * 2 ** Math.max(0, attempt + expOffset));
  return grown + Math.floor(rnd * baseMs);
}
