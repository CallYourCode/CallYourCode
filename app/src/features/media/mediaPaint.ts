// Media paint literals. Audio-toggle fill matches copper primary.

import {swapClasses} from '../../components/domHelpers';
import {
  currentPresentationTheme,
  paintTheme,
  type PresentationTheme
} from '../../components/presentation';

export const MEDIA_PRIMARY_BG: Record<PresentationTheme, string> = {
  day: 'bg-[#96602f]',
  night: 'bg-[#c98652]'
};
export const MEDIA_PRIMARY_TEXT: Record<PresentationTheme, string> = {
  day: 'text-[#96602f]',
  night: 'text-[#c98652]'
};
export const MEDIA_PRIMARY_ACCENT: Record<PresentationTheme, string> = {
  day: 'accent-[#96602f]',
  night: 'accent-[#c98652]'
};
// The surface hex and its utility, kept as literals side by side (Tailwind
// scans for the literal class name).
export const MEDIA_SURFACE_HEX: Record<PresentationTheme, string> = {
  day: '#ffffff',
  night: '#17171a'
};
export const MEDIA_SURFACE_BG: Record<PresentationTheme, string> = {
  day: 'bg-[#ffffff]',
  night: 'bg-[#17171a]'
};
export const MEDIA_SECONDARY_TEXT: Record<PresentationTheme, string> = {
  day: 'text-[#6b6b70]',
  night: 'text-[#a0a0a6]'
};

// Register a theme painter that keeps `el`'s class list carrying exactly one of
// `pick(theme)` (the themed value) with every value in `all` cleared first, on
// live day/night flips while `el` stays connected. Runs once immediately.
export function paintOnTheme(
  el: HTMLElement,
  all: readonly string[],
  pick: (theme: PresentationTheme) => string | string[]
): void {
  const run = () => {
    const next = pick(currentPresentationTheme());
    swapClasses(el, all, Array.isArray(next) ? next : [next]);
  };
  paintTheme(el, run);
}
