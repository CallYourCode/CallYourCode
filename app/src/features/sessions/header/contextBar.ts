import type {CycSession} from '../../../types';
import {h} from '../../../components/domHelpers';
import {makeIconButton, ICON_RESET_UTILS} from '../../../components/iconGlyphs';
import {DEFAULT_AGENT_NAME} from '@/features/chat/navigation/chatRow';
import {TABLER} from '@/features/media/icons';
import {confirmPopup, toast} from '../../../components/widgets';
import {captioned} from './actions';

export const CONTEXT_WARN_PCT = 80;
export const CONTEXT_HOT_PCT = 90;

const BAR_TOP = 4.6;
const BAR_BOTTOM = 19.4;
const BAR_TRAVEL = BAR_BOTTOM - BAR_TOP;

export function contextBarIcon(pct: number): HTMLSpanElement {
  const span = h(
    'span',
    `cyc-icon cyc-svgico cyc-ctx-bar inline-flex items-center justify-center align-middle leading-none ${ICON_RESET_UTILS}`
  );
  const height = Math.max(0, Math.min(BAR_TRAVEL, (BAR_TRAVEL * pct) / 100));
  span.innerHTML =
    '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    TABLER.contextbar +
    (height > 0
      ? `<rect class="cyc-ctx-fill" x="10" y="${(BAR_BOTTOM - height).toFixed(2)}" ` +
        `width="4" height="${height.toFixed(2)}" rx="1.2" fill="currentColor" stroke="none"/>`
      : '') +
    '</svg>';
  return span;
}

export type HeaderContextControl = {
  button: HTMLElement;
  slot: HTMLElement;
  update: (session: CycSession) => void;
};

export function createHeaderContextControl(opts: {
  session: () => CycSession;
  // Compacting runs on the engine: the button is grey while it cannot be reached.
  engineReachable?: (s: CycSession) => boolean;
  onCompact?: () => void;
}): HeaderContextControl {
  const button = makeIconButton('contextbar', 'cyc-ctx-btn cyc-force-show');
  const slot = captioned(button, 'Context', 'CTX');
  const longCaption = slot.querySelector('.cyc-mast-caption-long') as HTMLElement | null;
  const shortCaption = slot.querySelector('.cyc-mast-caption-short') as HTMLElement | null;

  button.addEventListener('click', () => {
    const session = opts.session();
    const pct = session.contextPct;
    if (pct === undefined) {
      toast(`Context is n/a for the ${session.agentName ?? DEFAULT_AGENT_NAME} harness`);
      return;
    }
    confirmPopup({
      title: 'Compact this context?',
      description:
        `${pct >= CONTEXT_WARN_PCT ? 'Context warning. ' : ''}${Math.round(pct)}% used. ` +
        'Compacting replaces the conversation with a summary of it, and that cannot be undone.',
      className: 'cyc-confirm-compact',
      buttons: [
        {text: 'Cancel'},
        {
          text: 'Compact',
          danger: true,
          ...(opts.engineReachable && !opts.engineReachable(session)
            ? {disabled: true, title: 'needs the engine'}
            : {}),
          callback: () => opts.onCompact?.()
        }
      ]
    });
  });

  function update(session: CycSession) {
    const pct = session.contextPct;
    const readable = pct !== undefined;
    button.querySelector('.cyc-icon')?.replaceWith(contextBarIcon(pct ?? 0));
    button.classList.toggle(
      'cyc-ctx-warn',
      pct !== undefined && pct >= CONTEXT_WARN_PCT && pct < CONTEXT_HOT_PCT
    );
    button.classList.toggle('cyc-ctx-hot', pct !== undefined && pct >= CONTEXT_HOT_PCT);
    button.classList.toggle('cyc-mast-unavailable', !readable);

    const label = readable ? `Ctx ${Math.round(pct)}%` : 'Ctx n/a';
    if (longCaption) longCaption.textContent = label;
    if (shortCaption) shortCaption.textContent = label;
    const detail =
      pct === undefined
        ? `Context n/a for the ${session.agentName ?? DEFAULT_AGENT_NAME} harness`
        : pct >= CONTEXT_WARN_PCT
          ? `Context warning: ${Math.round(pct)}% of the context is used`
          : `${Math.round(pct)}% of the context is used`;
    button.title = detail;
    button.setAttribute('aria-label', detail);
  }

  return {button, slot, update};
}
