// A plugin card iframe reports a measurement heartbeat to its parent:
// {cycCardRender:1, nonEmpty, height, nodes}. The parent accepts a beat as a
// render only when the measurement differs from the last accepted one for that
// frame; an identical beat is a skip (logged as render.skipped surface=card so
// the phone log still shows them). This module is the pure part: normalising
// the raw postMessage payload and comparing two beats.

export type CardBeat = {nonEmpty: boolean; height: number; nodes: number};

type RawBeat = {
  cycCardRender?: unknown;
  nonEmpty?: unknown;
  height?: unknown;
  nodes?: unknown;
};

// Returns the beat carried by a heartbeat message, or null when the message is
// not a card heartbeat. height is rounded up to whole pixels and nodes is an
// integer, both clamped at 0, so two reports of the same paint compare equal.
export function readBeat(data: unknown): CardBeat | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as RawBeat;
  if (raw.cycCardRender !== 1 || typeof raw.nonEmpty !== 'boolean') return null;
  const height =
    typeof raw.height === 'number' && Number.isFinite(raw.height)
      ? Math.max(0, Math.ceil(raw.height))
      : 0;
  const nodes =
    typeof raw.nodes === 'number' && Number.isFinite(raw.nodes) ? Math.max(0, raw.nodes | 0) : 0;
  return {nonEmpty: raw.nonEmpty, height, nodes};
}

// The compare key of a beat: equal keys mean the card painted the same thing.
export function beatKey(b: CardBeat): string {
  return `${b.nonEmpty ? 1 : 0}|${b.height}|${b.nodes}`;
}

// True when `next` re-reports what `prevKey` already described. A beat that
// says the card is empty is never "the same": the parent must react to it.
export function sameBeat(prevKey: string | null, next: CardBeat): boolean {
  return prevKey !== null && next.nonEmpty && beatKey(next) === prevKey;
}

// How often an unchanged beat is written to the log: the first skip on a frame
// and then every SKIP_LOG_EVERY-th, mirroring renderHub's surface skips.
export const SKIP_LOG_EVERY = 64;
export function logSkip(skips: number): boolean {
  return skips === 1 || skips % SKIP_LOG_EVERY === 0;
}
