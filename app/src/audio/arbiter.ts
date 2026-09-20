export const STOCK_SILENCE = new Set([
  '',
  'thank you',
  'thanks',
  'thanks for watching',
  'you',
  'bye'
]);

export const BACKCHANNEL = new Set([
  'oh',
  'ah',
  'uh',
  'um',
  'hmm',
  'mm',
  'mhm',
  'huh',
  'wow',
  'nice',
  'cool',
  'yeah',
  'yep',
  'ya',
  'ok',
  'okay',
  'right',
  'sure',
  'i see',
  'got it',
  'uh huh',
  'oh yeah',
  'oh okay',
  'oh no',
  'oh wow',
  'well',
  'so',
  'hm'
]);

export const ECHO_DENSITY_DB = -50;

export type Verdict =
  | ''
  | 'no-words'
  | 'stock-silence'
  | 'backchannel-over-playback'
  | 'echo-density'
  | 'echo-of-playback';

export function arbitrate(o: {
  text: string;
  wasPlaying: boolean;
  fromPress: boolean;
  medianDb: number;
  playingText: string;

  bargeStopped?: boolean;
}): Verdict {
  const norm = normText(o.text);

  if (!norm) return 'no-words';
  if (o.fromPress) return '';

  if (STOCK_SILENCE.has(norm) && o.medianDb < ECHO_DENSITY_DB) return 'stock-silence';
  if (!o.wasPlaying) return '';
  if (BACKCHANNEL.has(norm)) return 'backchannel-over-playback';

  if (o.medianDb < ECHO_DENSITY_DB && !o.bargeStopped) return 'echo-density';
  if (isEchoOfPlayback(o.text, o.playingText)) return 'echo-of-playback';
  return '';
}

export function isEchoOfPlayback(text: string, playingText: string): boolean {
  const words = normText(text).split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  const spoken = new Set(normText(playingText).split(' ').filter(Boolean));
  if (spoken.size === 0) return false;
  return words.every((w) => spoken.has(w));
}

export function normText(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
