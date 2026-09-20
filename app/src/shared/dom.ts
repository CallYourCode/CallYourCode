const win = typeof window === 'undefined' ? undefined : window;

export function dispatchSynthetic(target: EventTarget, name: string) {
  target.dispatchEvent(new Event(name, {bubbles: true, cancelable: true}));
}

function activeWindow() {
  return win!;
}

export function selectionEmpty(selection = activeWindow().getSelection()) {
  return !selection?.rangeCount || selection.getRangeAt(0).collapsed;
}

// Scroll panes fill the local positioned region. Individual callers may override the
// block size (for example a chat list with top and bottom padding), but preserving the
// inset contract is essential for the message viewport to have a finite height.
export function scrollSurface(): HTMLElement {
  const el = document.createElement('div');
  el.className =
    'cyc-overflow-pane absolute inset-0 min-h-0 min-w-0 w-full max-h-full overflow-x-hidden overflow-y-auto overscroll-contain';
  return el;
}
