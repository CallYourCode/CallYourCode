export function capDedupe(keys: Set<string>, max: number, trimTo: number): number {
  if (keys.size <= max) return 0;
  let dropped = 0;
  while (keys.size > trimTo) {
    const oldest = keys.values().next().value as string | undefined;
    if (oldest === undefined) break;
    keys.delete(oldest);
    dropped++;
  }
  return dropped;
}
