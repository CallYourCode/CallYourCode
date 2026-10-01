
/** True when the device exposes touch input (a coarse pointer). */
export const touchCapable =
  (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
  (typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches);

/* True only for a laptop/desktop: a fine (mouse) pointer AND not a mobile OS.
 * The engine's recent-use push hold reads this off the visible frame (owner
 * decision 2026-10-01): only a laptop counts as "recently used", so locking a
 * phone or tablet buzzes right away as before. An iPad's primary pointer is
 * coarse, so the pointer test alone already keeps it off; the UA check is the
 * belt-and-braces for a touch device that still claims a fine pointer. Fails to
 * NOT desktop when either global or matchMedia is unavailable, so an unknown
 * client never delays a push. */
export const desktopDevice =
  typeof navigator !== 'undefined' &&
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(pointer: fine)').matches &&
  !/iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');

/** False only when the OS asks apps to cut motion; used to short-circuit glides. */
export function prefersMotion(): boolean {
  const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  return !query?.matches;
}
