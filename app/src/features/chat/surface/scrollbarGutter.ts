// THE BUBBLE COLUMN SHARES THE COMPOSER'S EDGES. grep token: `column align`.
//
// The list column (`.cyc-message-list-inner`, mx-auto) centres itself in the
// scroller's client box. A classic (non-overlay) vertical scrollbar takes its
// layout width at the inline end only, so the column landed half a scrollbar
// toward the inline start of the composer, which sits outside the scroller
// and centres in the full pane width (owner's screenshot, 2026-09-02: both
// bubble edges a few px left of the composer on a laptop).
//
// This mirrors the scrollbar's layout width as padding on the scroller's
// inline-start edge, so the client box is symmetric again and the column
// centres exactly where the composer does. The list already extends
// `--cyc-pane-gap` beyond the pane on both sides, so the mirrored gutter costs
// the column no width. Overlay scrollbars (phones) take no layout width and
// get no padding; when a classic scrollbar appears or goes, the scroller's
// content box changes size and the observer re-measures.
//
// Why not CSS `scrollbar-gutter: stable both-edges`: measured in Chromium
// (e2e/offline/column-align.spec.ts), it fixes ltr and phone rtl, but in rtl
// with a scroller that also clips horizontal overflow (the full-bleed
// highlight and banner boxes are wider than the column) Chromium places the
// scroll origin off by one gutter (scrollLeft reads -10 and cannot be reset),
// leaving the wide rtl column a whole scrollbar off. Measuring the real
// scrollbar sidesteps the feature and holds in every engine that gives a
// scrollbar layout space.
export function mirrorScrollbarGutter(scroll: HTMLElement): () => void {
  const apply = () => {
    // The scroller has no border, so this is the scrollbar's layout width
    // (0 for overlay scrollbars). Not clientLeft: in rtl that is the scrollbar.
    const width = scroll.offsetWidth - scroll.clientWidth;
    const want = width > 0 ? `${width}px` : '';
    if (scroll.style.paddingInlineStart !== want) scroll.style.paddingInlineStart = want;
  };
  apply();
  if (typeof ResizeObserver === 'undefined') return () => {};
  const observer = new ResizeObserver(apply);
  observer.observe(scroll);
  return () => observer.disconnect();
}
