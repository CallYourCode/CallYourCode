// Session-list theme literals.

import {type PresentationTheme} from '@/components/presentation';

type ThemeMap = Record<PresentationTheme, string>;

export const SESSION_PRIMARY: ThemeMap = {day: '#96602f', night: '#c98652'};
export const SESSION_PRIMARY_TEXT: ThemeMap = {day: '#1c1c1e', night: '#ededee'};
export const SESSION_SECONDARY_COLOR: ThemeMap = {day: '#6b6b70', night: '#a0a0a6'};
// --cyc-session-list-status-color resolves to the theme primary.
export const SESSION_STATUS: ThemeMap = SESSION_PRIMARY;
export const SESSION_FILL: ThemeMap = {day: '#96602f', night: '#a86c38'};
export const SESSION_SELECTED_ROW: ThemeMap = {
  day: 'rgba(0, 0, 0, 0.055)',
  night: 'rgba(255, 255, 255, 0.07)'
};
export const SESSION_STATE_BADGE_BG: ThemeMap = {day: '#b4b4b8', night: '#5c5c62'};
// The list star (agent-marks mockup, "Star (on/off)"): the glyph's ink, and the
// selected starred row, which keeps its gold under the selection instead of
// the grey above. Night washes with a warmer amber, a little stronger: the
// mockup's gold over the near-black surface reads olive-brown, and its star a
// shade brighter. The resting and hover washes are chatRow's STAR_ROW_STATE
// (utilities, so the hover can be a :hover).
export const SESSION_STAR_INK: ThemeMap = {day: '#e0a526', night: '#f5b42a'};
export const SESSION_STAR_SELECTED_ROW: ThemeMap = {
  day: 'color-mix(in srgb, #e0a526 18%, var(--cyc-surface))',
  night: 'color-mix(in srgb, #ffae1a 19%, var(--cyc-surface))'
};
