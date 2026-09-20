// Close-on-outside-pointer for the side panels (settings, profile). One
// document-level pointerdown listener in the capture phase, so it sees the
// gesture before any pane handler and before the click it becomes; closing on
// pointerdown cannot race the click that OPENED the panel, because that
// pointerdown ran while the panel was still closed (isOpen() was false).
//
// "Outside" is deliberately narrow: only a pointerdown whose target sits
// inside within() counts. Menus, confirm popups, toasts and viewers mount on
// document.body or #cyc-stage, outside the columns element, so interacting
// with an overlay the panel itself spawned never dismisses the panel under it.
export interface OutsideCloseOptions {
  isOpen(): boolean;
  // The region whose pointerdowns count at all (the columns element).
  within(): HTMLElement;
  // True when the target belongs to the panel, or to the control that toggles
  // it (so the toggle keeps working as a toggle instead of close-then-reopen).
  inside(target: Element): boolean;
  close(): void;
}

export function installOutsideClose(options: OutsideCloseOptions): () => void {
  const onPointerDown = (e: Event) => {
    if (!options.isOpen()) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || !options.within().contains(target)) return;
    if (options.inside(target)) return;
    options.close();
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  return () => document.removeEventListener('pointerdown', onPointerDown, true);
}
