import {EngineOffline} from '../../engine/contract';

// Shown offline: the engine is unreachable and this device does not hold the
// document yet. No URL, no transport words; capFetch's own message embeds the
// internal doc URL, which must never reach the viewer.
const OFFLINE_MESSAGE =
  "You're offline and this document isn't saved on this device yet. " +
  'It will open once the engine is reachable.';

export function isEngineOffline(err: unknown): boolean {
  return err instanceof EngineOffline || (err instanceof Error && err.name === 'EngineOffline');
}

// The viewer's one-line error for a failed load: the humane offline sentence
// when the engine is unreachable, else a concise reason with no raw URL (the
// other throws are `HTTP <status>` shapes, already URL-free).
export function loadErrorText(name: string, err: unknown): string {
  if (isEngineOffline(err)) return OFFLINE_MESSAGE;
  const reason = err instanceof Error ? err.message : 'error';
  return `Could not load ${name} (${reason})`;
}
