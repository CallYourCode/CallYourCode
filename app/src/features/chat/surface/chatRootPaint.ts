// Chat bubble colour graph.

import {paintTheme, type PresentationTheme} from '@/components/presentation';

// Chat root vars. Header height is painted separately; pad-top/bottom read it.
const CHAT_ROOT_BASE_VARS: Record<string, string> = {
  '--cyc-overlay-stack-height': '0px',
  '--cyc-composer-height': '3rem',
  '--cyc-chat-pad-top':
    'calc(var(--cyc-chat-header-height) + var(--cyc-pane-gap) + var(--cyc-overlay-stack-height))',
  '--cyc-chat-pad-bottom':
    'calc(var(--cyc-composer-height) + var(--cyc-pane-gap) + max(var(--cyc-composer-floor, 0px), var(--cyc-safe-bottom)))',
  '--cyc-composer-surface': 'var(--cyc-surface)',
  '--cyc-bubble-flash': 'var(--cyc-bubble-flash-color, rgba(150, 96, 47, 0.4))',
  // Base (received/default) bubble inks: the accent-tinted body ink and its rgb triple,
  // the muted timestamp ink, and the on-bubble control-chip fill (white by default;
  // the outgoing group forks it below).
  '--cyc-bubble-time': 'var(--cyc-text-muted)',
  '--cyc-bubble-ink': 'var(--cyc-accent)',
  '--cyc-bubble-ink-rgb': 'var(--cyc-accent-rgb)',
  '--cyc-bubble-glyph': '#fff'
};

// Night outgoing chip/scrim sit on the copper bubble, not page white.
const NIGHT_SENT_INK = '#f4efe9';
const NIGHT_SENT_CHIP = '#4a3527';
const NIGHT_SENT_CHIP_RGB = '74, 53, 39';
const NIGHT_SENT_SCRIM = 'rgba(23, 23, 26, 0.5)';
export const CHAT_ROOT_THEME_VARS: Record<string, Record<PresentationTheme, string>> = {
  '--cyc-bubble-status': {day: 'var(--cyc-text-muted)', night: 'var(--cyc-text-muted)'},
  '--cyc-bubble-error': {day: 'var(--cyc-danger)', night: NIGHT_SENT_INK},
  '--cyc-bubble-out-link': {day: 'var(--cyc-link-color)', night: NIGHT_SENT_INK},
  '--cyc-bubble-out-status': {day: 'var(--cyc-bubble-out-ink)', night: NIGHT_SENT_INK},
  '--cyc-bubble-out-time': {
    day: 'var(--cyc-bubble-out-status)',
    night: 'rgba(244, 239, 233, 0.66)'
  },
  '--cyc-bubble-out-glyph': {day: '#fff', night: NIGHT_SENT_CHIP},
  '--cyc-bubble-out-selection': {
    day: 'rgba(var(--cyc-accent-rgb), 0.4)',
    night: NIGHT_SENT_SCRIM
  },
  '--cyc-bubble-out-code-ink': {day: 'var(--cyc-bubble-out-ink)', night: NIGHT_SENT_INK},
  '--cyc-bubble-out-code-ink-rgb': {
    day: 'var(--cyc-bubble-out-ink-rgb)',
    night: NIGHT_SENT_CHIP_RGB
  }
};

export function paintChatRoot(chatEl: HTMLElement): void {
  for (const [name, value] of Object.entries(CHAT_ROOT_BASE_VARS))
    chatEl.style.setProperty(name, value);
  const run = (theme: PresentationTheme) => {
    for (const [name, fork] of Object.entries(CHAT_ROOT_THEME_VARS))
      chatEl.style.setProperty(name, fork[theme]);
  };
  paintTheme(chatEl, run);
}
