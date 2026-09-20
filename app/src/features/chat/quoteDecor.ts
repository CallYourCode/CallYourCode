import {h} from '@/components/domHelpers';

// Quote-mark mask must be a literal Tailwind class so JIT and HTML-string consumers both see it.
const QUOTE_MARK_MASK =
  '[mask:url(data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%20fill=%22none%22%20stroke=%22black%22%20stroke-width=%222%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22%3E%3Cpath%20d=%22M10%2011h-4a1%201%200%200%201%20-1%20-1v-3a1%201%200%200%201%201%20-1h3a1%201%200%200%201%201%201v6c0%202.667%20-1.333%204.333%20-4%205%22/%3E%3Cpath%20d=%22M19%2011h-4a1%201%200%200%201%20-1%20-1v-3a1%201%200%200%201%201%20-1h3a1%201%200%200%201%201%201v6c0%202.667%20-1.333%204.333%20-4%205%22/%3E%3C/svg%3E)_center/contain_no-repeat] ' +
  '[-webkit-mask:url(data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%20fill=%22none%22%20stroke=%22black%22%20stroke-width=%222%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22%3E%3Cpath%20d=%22M10%2011h-4a1%201%200%200%201%20-1%20-1v-3a1%201%200%200%201%201%20-1h3a1%201%200%200%201%201%201v6c0%202.667%20-1.333%204.333%20-4%205%22/%3E%3Cpath%20d=%22M19%2011h-4a1%201%200%200%201%20-1%20-1v-3a1%201%200%200%201%201%20-1h3a1%201%200%200%201%201%201v6c0%202.667%20-1.333%204.333%20-4%205%22/%3E%3C/svg%3E)_center/contain_no-repeat]';

export const QUOTE_BAR_CLASS =
  'cyc-callout-bar pointer-events-none absolute inset-y-1 start-1 z-[2] w-0.5 rounded-full bg-[rgb(var(--cyc-sender-rgb))]';

// The quotation-mark glyph seats a touch inside the trailing-top corner of the card,
// tinted from the same sender-identity token as the rail and the frame wash.
export const QUOTE_MARK_CLASS =
  'cyc-callout-mark pointer-events-none absolute top-1 end-1 h-[0.75em] w-[0.75em] bg-[rgb(var(--cyc-sender-rgb))] ' +
  QUOTE_MARK_MASK;

export function quoteBar(): HTMLSpanElement {
  const el = h('span', QUOTE_BAR_CLASS);
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('contenteditable', 'false');
  return el;
}

export function quoteMark(): HTMLSpanElement {
  const el = h('span', QUOTE_MARK_CLASS);
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('contenteditable', 'false');
  return el;
}

// The complete quote-frame class set, spelled out once here and consumed by every
// surface that draws one, so no caller keeps its own copy of the list.
export const QUOTE_FRAME_CLASSES = [
  'cyc-callout',
  'cyc-callout-body',
  'cyc-callout-surface',
  'cyc-callout-rail',
  'cyc-callout-marked'
];

// The rail and the quote glyph are real child nodes rather than pseudo-elements so
// they survive inside a contenteditable, so each surface opts in to the pieces its
// own class set asks for.
export function applyQuoteDecor(el: HTMLElement): void {
  if (el.classList.contains('cyc-callout-rail') && !el.querySelector(':scope > .cyc-callout-bar')) {
    el.prepend(quoteBar());
  }
  if (el.classList.contains('cyc-callout-marked') && !el.querySelector(':scope > .cyc-callout-mark')) {
    el.prepend(quoteMark());
  }
}

export function clearQuoteDecor(el: HTMLElement): void {
  el.querySelectorAll(':scope > .cyc-callout-bar, :scope > .cyc-callout-mark').forEach((n) => n.remove());
}

/** Draw the full frame on `el`: the whole class set plus the matching decor nodes. */
export function dressQuoteFrame(el: HTMLElement): void {
  el.classList.add(...QUOTE_FRAME_CLASSES);
  applyQuoteDecor(el);
}

/** Undo `dressQuoteFrame`, leaving `el` as a plain semantic element. */
export function undressQuoteFrame(el: HTMLElement): void {
  el.classList.remove(...QUOTE_FRAME_CLASSES);
  clearQuoteDecor(el);
}
