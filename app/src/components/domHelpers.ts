export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  attrs?: Record<string, string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

// Three real dot spans that blink in and out on the shared cyc-dot-wave, phased in
// even thirds so the ellipsis reads as a travelling wave. Used by the transcript /
// partial-caption producers as the moving overlay above their static baseline dots.
export function transcriptDotWave(): HTMLSpanElement {
  const wave = h('span', 'cyc-transcript-wave absolute inset-x-0');
  for (const delay of ['0s', '-0.5s', '-1s']) {
    // The delay is an inline style, not a Tailwind class, for the same reason
    // as BUSY_DOT_DELAYS below: the scanner cannot see utilities built from a
    // runtime template literal, so per-dot [animation-delay:${delay}] classes
    // were silently dropped from the build and the wave never phased.
    const dot = h('span', '[animation:cyc-dot-wave_1.5s_linear_infinite]');
    dot.style.animationDelay = delay;
    dot.textContent = '.';
    wave.append(dot);
  }
  return wave;
}

// The dot-flashing delays, in seconds. Set as an inline style (not a Tailwind
// class) so the stagger always applies: Tailwind's static scanner cannot see
// class names built from a runtime template literal, which is why the prior
// per-dot [animation-delay:${delay}] utilities were silently dropped from the
// build and the dots never staggered.
const BUSY_DOT_DELAYS = ['0s', '0.2s', '0.4s'];

// The single "busy" glyph: three real dot spans on the plain-CSS
// cyc-busy-dot-flash keyframe (chat.css), nzbin three-dots "dot-flashing"
// style. This is the one place the "busy" animation is built; the toolbar
// status and the conversation list row both render through it (see
// createTypingIndicator in features/chat/navigation/typing.ts).
export function busyDotsGlyph(): HTMLSpanElement {
  const glyph = h('span', 'cyc-busy-dots inline-flex items-center');
  for (const delay of BUSY_DOT_DELAYS) {
    const dot = h('span', 'cyc-busy-dot');
    dot.style.animationDelay = delay;
    glyph.append(dot);
  }
  return glyph;
}

export function swapClasses(
  el: HTMLElement,
  remove: readonly string[],
  add: readonly string[]
): void {
  el.classList.remove(...remove);
  el.classList.add(...add);
}

// Run `fn` over every `HTMLElement` matching `sel` under `root`.
export function queryEach(root: ParentNode, sel: string, fn: (el: HTMLElement) => void): void {
  root.querySelectorAll<HTMLElement>(sel).forEach(fn);
}
