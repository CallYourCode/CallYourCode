import {dispatchSynthetic, selectionEmpty} from '@/shared/dom';
import {applyTextDirection} from './editor';
import {clearQuoteDecor, dressQuoteFrame, undressQuoteFrame} from '@/features/chat/quoteDecor';


type InlineType = 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code';
type MarkupType = InlineType | 'quote';

const INLINE_TYPES: InlineType[] = ['bold', 'italic', 'underline', 'strikethrough', 'code'];

// The canonical element each inline format writes.
const INLINE_TAG: Record<InlineType, string> = {
  bold: 'STRONG',
  italic: 'EM',
  underline: 'U',
  strikethrough: 'S',
  code: 'CODE'
};

// Selectors that recognise a format already in the tree: the canonical tag we emit plus the
// legacy / paste-sanitiser variants, so a toggle strips whatever produced the run.
const INLINE_MATCH: Record<InlineType, string> = {
  bold: 'strong,b',
  italic: 'em,i',
  underline: 'u,ins',
  strikethrough: 's,strike,del',
  code: 'code,pre,tt,kbd,samp'
};

const INLINE_SELECTOR = INLINE_TYPES.map((type) => INLINE_MATCH[type]).join(',');

const isQuoteContainer = (el: Element): boolean =>
  el.nodeName === 'BLOCKQUOTE' || el.classList.contains('cyc-callout');

const isQuoteDecor = (el: Element): boolean =>
  el.classList.contains('cyc-callout-bar') || el.classList.contains('cyc-callout-mark');

// The formats carried by the ancestor chain of a single point (a range boundary), up to and
// including the editable root.
function formatsAt(node: Node, root: Element): Set<MarkupType> {
  const found = new Set<MarkupType>();
  let el: Element | null =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el) {
    for (const type of INLINE_TYPES) if (el.matches(INLINE_MATCH[type])) found.add(type);
    if (isQuoteContainer(el)) found.add('quote');
    if (el === root) break;
    el = el.parentElement;
  }
  return found;
}

function activeFormats(range: Range, root: Element): Set<MarkupType> {
  const start = formatsAt(range.startContainer, root);
  if (range.collapsed) return start;
  const end = formatsAt(range.endContainer, root);
  return new Set([...start].filter((type) => end.has(type)));
}

function editableRoot(range: Range, fallback: HTMLElement): HTMLElement {
  const node = range.commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const root = el?.closest('[contenteditable="true"]') as HTMLElement | null;
  return root ?? fallback;
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function unwrapMatching(root: ParentNode, selector: string): void {
  root.querySelectorAll(selector).forEach((el) => unwrap(el));
}

function selectNodes(sel: Selection, nodes: Node[]): void {
  const kept = nodes.filter((n) => n.parentNode);
  if (!kept.length) return;
  const range = kept[0].ownerDocument!.createRange();
  range.setStartBefore(kept[0]);
  range.setEndAfter(kept[kept.length - 1]);
  sel.removeAllRanges();
  sel.addRange(range);
}

function applyInline(range: Range, type: InlineType, sel: Selection): void {
  const doc = range.startContainer.ownerDocument!;
  const frag = range.extractContents();
  // Collapse any same-type runs the selection already held so the result is one clean tag.
  unwrapMatching(frag, INLINE_MATCH[type]);
  const tag = doc.createElement(INLINE_TAG[type]);
  tag.appendChild(frag);
  range.insertNode(tag);
  const restored = doc.createRange();
  restored.selectNodeContents(tag);
  sel.removeAllRanges();
  sel.addRange(restored);
}

// The first ancestor of the range boundary that carries `selector`, bounded by `root`.
function matchingAncestor(range: Range, selector: string, root: Element): Element | null {
  let el: Element | null =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  while (el) {
    if (el.matches(selector)) return el;
    if (el === root) break;
    el = el.parentElement;
  }
  return null;
}

// Split `el` at the collapsed `range` point: content before the point stays in `el`, content
// at/after it moves into a shallow clone placed right after `el`, and `range` is repositioned
// between the two halves in `el`'s parent -- so a later insert lands outside `el`.
function splitAtRange(range: Range, el: Element): void {
  const doc = el.ownerDocument!;
  const tail = doc.createRange();
  tail.setStart(range.startContainer, range.startOffset);
  tail.setEnd(el, el.childNodes.length);
  const clone = el.cloneNode(false) as Element;
  clone.appendChild(tail.extractContents());
  el.after(clone);
  range.setStartAfter(el);
  range.collapse(true);
}

function removeInline(range: Range, type: InlineType, root: Element, sel: Selection): void {
  const selector = INLINE_MATCH[type];
  // Pull the selection out and strip the format from every fully-selected descendant.
  const frag = range.extractContents();
  unwrapMatching(frag, selector);
  const nodes = Array.from(frag.childNodes);
  // The range is now collapsed at the insertion point; split any matching ancestors so the
  // stripped content lands outside them, then drop it in between.
  for (
    let a = matchingAncestor(range, selector, root);
    a;
    a = matchingAncestor(range, selector, root)
  ) {
    splitAtRange(range, a);
  }
  range.insertNode(frag);
  selectNodes(sel, nodes);
}

function applyQuote(range: Range, sel: Selection): void {
  const doc = range.startContainer.ownerDocument!;
  const frag = range.extractContents();
  const container = doc.createElement('blockquote');
  container.appendChild(frag);
  range.insertNode(container);
  const restored = doc.createRange();
  restored.selectNodeContents(container);
  sel.removeAllRanges();
  sel.addRange(restored);
}

function removeQuote(range: Range, root: Element): void {
  const containers = new Set<Element>();
  for (const boundary of [range.startContainer, range.endContainer]) {
    let el: Element | null =
      boundary.nodeType === Node.ELEMENT_NODE ? (boundary as Element) : boundary.parentElement;
    while (el) {
      if (isQuoteContainer(el)) containers.add(el);
      if (el === root) break;
      el = el.parentElement;
    }
  }
  for (const el of containers) {
    clearQuoteDecor(el as HTMLElement);
    unwrap(el);
  }
}

function toggleFormat(input: HTMLElement, type: MarkupType): boolean {
  const sel = window.getSelection();
  if (selectionEmpty(sel)) return false;

  const range = sel!.getRangeAt(0);
  const root = editableRoot(range, input);
  if (!root.contains(range.commonAncestorContainer)) return false;

  const active = activeFormats(range, root).has(type);
  if (type === 'quote') {
    if (active) removeQuote(range, root);
    else applyQuote(range, sel!);
  } else if (active) {
    removeInline(range, type, root, sel!);
  } else {
    applyInline(range, type, sel!);
  }

  reconcileFormatting(input);
  dispatchSynthetic(input, 'input');
  return true;
}

const SHORTCUTS: {code: string; shift?: boolean; type: MarkupType}[] = [
  {code: 'KeyB', type: 'bold'},
  {code: 'KeyI', type: 'italic'},
  {code: 'KeyU', type: 'underline'},
  {code: 'KeyS', type: 'strikethrough'},
  {code: 'KeyM', shift: true, type: 'code'},
  {code: 'KeyQ', shift: true, type: 'quote'}
];

export function onMarkdownShortcut(input: HTMLElement, e: KeyboardEvent): void {
  const chord = SHORTCUTS.find(
    (s) => s.code === e.code && (s.shift === undefined || s.shift === e.shiftKey)
  );
  if (!chord) return;
  if (toggleFormat(input, chord.type)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

// Drop the empty format shells a browser edit (or an extract/insert toggle) can leave behind.
function removeEmptyInlines(input: HTMLElement): void {
  input.querySelectorAll(INLINE_SELECTOR).forEach((el) => {
    if (!el.textContent && !el.querySelector('br,img')) el.remove();
  });
}

// Normalize every quote onto the container contract: a top-level quote gets the frame
// and a resolved text direction; a quote nested inside another sheds the frame, so only
// the outermost one is drawn.
function normalizeQuoteContainers(input: HTMLElement): void {
  for (const el of Array.from(input.querySelectorAll<HTMLElement>('*'))) {
    if (!isQuoteContainer(el)) continue;
    let nested = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (isQuoteContainer(p)) {
        nested = true;
        break;
      }
    }
    if (nested) {
      undressQuoteFrame(el);
    } else {
      dressQuoteFrame(el);
      applyTextDirection(el);
    }
  }
}

export function reconcileFormatting(input: HTMLElement): void {
  removeEmptyInlines(input);
  normalizeQuoteContainers(input);
}

const INLINE_MARKER: Record<Exclude<InlineType, 'code'>, string> = {
  bold: '**',
  italic: '*',
  underline: '++',
  strikethrough: '~~'
};

const INLINE_ORDER: Exclude<InlineType, 'code'>[] = [
  'italic',
  'bold',
  'underline',
  'strikethrough'
];

function wrapInlineMarkup(text: string, marker: string): string {
  return text
    .split('\n')
    .map((line) => {
      const [, before, body, after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(line)!;
      return body ? before + marker + body + marker + after : line;
    })
    .join('\n');
}

function inlineTypesOf(el: Element): InlineType[] {
  return INLINE_TYPES.filter((type) => el.matches(INLINE_MATCH[type]));
}

export function markupToText(node: Node): string {
  let out = '';
  for (const n of Array.from(node.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.textContent ?? '';
      continue;
    }
    if (n.nodeName === 'BR') {
      out += '\n';
      continue;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;

    const el = n as HTMLElement;
    if (isQuoteDecor(el)) continue;

    if (isQuoteContainer(el)) {
      const quoted = markupToText(el)
        .split('\n')
        .map((line) => '> ' + line)
        .join('\n');
      out += (out && !out.endsWith('\n') ? '\n' : '') + quoted + '\n';
      continue;
    }

    let inner = markupToText(el);
    const types = inlineTypesOf(el);

    if (types.includes('code')) {
      inner = '`' + inner + '`';
    } else {
      for (const type of INLINE_ORDER) {
        if (types.includes(type)) inner = wrapInlineMarkup(inner, INLINE_MARKER[type]);
      }
    }

    out += (el.nodeName === 'DIV' || el.nodeName === 'P' ? '\n' : '') + inner;
  }

  return out;
}
