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
