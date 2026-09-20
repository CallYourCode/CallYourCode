import {h, busyDotsGlyph} from '@/components/domHelpers';

type TypingIndicator = {
  el: HTMLElement;
  setText: (suffix: string) => void;
};

// The shared "busy" status: the animated three-dot glyph (busyDotsGlyph) with
// an optional trailing label kept past the dots ("<dots> 2m"). A plain space
// separates the dots from the label, not a middot: the dots already read as
// a distinct glyph, so a middot between them and the time only added a
// stray, unpaired-looking mark. Both the toolbar (header.ts) and the
// conversation list row (chatRow.ts) render their busy state through this one
// function, so the animation is defined and driven from one place.
export function createTypingIndicator(ariaBase = 'thinking', suffix = ''): TypingIndicator {
  const el = h(
    'span',
    'cyc-typing-status inline-flex items-center min-w-0 max-w-full overflow-hidden ' +
      'whitespace-nowrap text-[color:var(--cyc-accent)]'
  );
  el.append(busyDotsGlyph());
  const suffixEl = h('span', 'cyc-typing-suffix overflow-hidden text-ellipsis');
  el.append(suffixEl);

  const setText = (next: string) => {
    suffixEl.textContent = next ? ` ${next}` : '';
    el.setAttribute('aria-label', next ? `${ariaBase}, ${next}` : ariaBase);
  };
  setText(suffix);

  return {el, setText};
}
