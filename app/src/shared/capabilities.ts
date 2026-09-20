
/** True when the device exposes touch input (a coarse pointer). */
export const touchCapable =
  (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
  (typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches);

/** False only when the OS asks apps to cut motion; used to short-circuit glides. */
export function prefersMotion(): boolean {
  const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  return !query?.matches;
}
