/** Confine `value` to the inclusive `[low, high]` range. */
export function clampNumber(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
