const SELECT_ARM_MS = 500;
const MENU_MS = 1000;
const TAP_SLOP = 10;
const DRAG_SLOP = 8;
const MULTI_TAP_MS = 400;
const MULTI_TAP_SLOP = 28;
type TouchSelectOptions = {
  element: HTMLElement;
  messageNodeOf: (target: EventTarget | null) => HTMLElement | null;
  isInteractive: (target: EventTarget | null) => boolean;
  onMenu: (messageNode: HTMLElement, at: MenuPoint, selection: string | undefined) => void;
};
export type MenuPoint = {
  clientX: number;
  clientY: number;
  pageX: number;
  pageY: number;
};
const menuPoint = (clientX: number, clientY: number): MenuPoint => ({
  clientX,
  clientY,
  pageX: clientX + window.scrollX,
  pageY: clientY + window.scrollY
});
const MENU_GAP = 10;
const MENU_H = 116;
const EDGE = 8;
function menuFloor(): number {
  const composer = document.querySelector('.cyc-composer-main') as HTMLElement | null;
  const top = composer?.getBoundingClientRect().top ?? 0;
  return top > 0 && top <= window.innerHeight ? top : window.innerHeight;
}
export function menuPointForSelection(fallback: MenuPoint): MenuPoint {
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return fallback;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  if (!r.width && !r.height) return fallback;
  const floor = menuFloor();
  const below = r.bottom + MENU_GAP;
  const fitsBelow = below + MENU_H <= floor - MENU_GAP;
  const y = fitsBelow ? below : Math.max(EDGE, floor - MENU_GAP - MENU_H);
  const x = window.innerWidth > 550 ? r.left : r.right;
  return menuPoint(x, y);
}
function boundsOf(message: HTMLElement) {
  const r = document.createRange();
  r.selectNodeContents(message);
  return r;
}
type Point = {
  node: Node;
  offset: number;
};
function caretAt(x: number, y: number): Point | null {
  const doc = document as Document & {
    caretRangeFromPoint?(x: number, y: number): Range | null;
    caretPositionFromPoint?(
      x: number,
      y: number
    ): {
      offsetNode: Node;
      offset: number;
    } | null;
  };
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range) return {node: range.startContainer, offset: range.startOffset};
  const pos = doc.caretPositionFromPoint?.(x, y);
  return pos ? {node: pos.offsetNode, offset: pos.offset} : null;
}
function clampTo(message: HTMLElement, p: Point | null): Point | null {
  if (!p) return null;
  if (message.contains(p.node)) return p;
  const b = boundsOf(message);
  const precedes =
    (message.compareDocumentPosition(p.node) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
  if (precedes) return {node: b.startContainer, offset: b.startOffset};
  return {node: b.endContainer, offset: b.endOffset};
}
function put(anchor: Point, focus: Point) {
  const sel = window.getSelection();
  if (!sel) return;
  try {
    sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  } catch {}
}
function swallowNextClick() {
  const opts: AddEventListenerOptions = {capture: true};
  const eat = (e: Event) => {
    if ((e.target as HTMLElement)?.closest?.('.cyc-menu')) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    document.removeEventListener('click', eat, opts);
  };
  document.addEventListener('click', eat, opts);
  setTimeout(() => document.removeEventListener('click', eat, opts), 500);
}
const ARMED_CLASS = 'cyc-press-armed';
const POP_CLASS = 'cyc-press-pop';
export function installTouchSelect(o: TouchSelectOptions): () => void {
  let messageNode: HTMLElement | null = null;
  let message: HTMLElement | null = null;
  let anchor: Point | null = null;
  let start = {x: 0, y: 0};
  let selecting = false;
  let moved = false;
  let armed = false;
  let menuUp = false;
  let lift: MenuPoint = menuPoint(0, 0);
  let armTimer = 0;
  let menuTimer = 0;
  let mid = '';
  let tapCount = 0;
  let lastTapAt = 0;
  let lastTap = {x: 0, y: 0};
  let tapMenuTimer = 0;
  const unlight = () => {
    o.element
      .querySelectorAll(`.${ARMED_CLASS}, .${POP_CLASS}`)
      .forEach((el) => el.classList.remove(ARMED_CLASS, POP_CLASS));
  };
  const forget = () => {
    clearTimeout(armTimer);
    clearTimeout(menuTimer);
    armTimer = menuTimer = 0;
    unwatch();
    unlight();
    messageNode = message = null;
    anchor = null;
    selecting = false;
    moved = false;
    armed = false;
    menuUp = false;
    mid = '';
  };
  const liveMessage = (): HTMLElement | null => {
    if (message?.isConnected) return message;
    if (!mid) return null;
    // bubbles are keyed by data-mid (a durable string id): escape it so the m@
    // fallback spelling's ts|role|text can never break the attribute selector
    const g = globalThis as unknown as {CSS?: {escape?: (s: string) => string}};
    const safe = g.CSS?.escape ? g.CSS.escape(mid) : mid.replace(/["\\]/g, '\\$&');
    const b = o.element.querySelector(`.cyc-message[data-mid="${safe}"]`) as HTMLElement | null;
    const m = b?.querySelector('.cyc-message-text') as HTMLElement | null;
    if (!m) return null;
    messageNode = b;
    message = m;
    return m;
  };
  const selectedInMessage = (): string | undefined => {
    const sel = window.getSelection();
    const m = liveMessage();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !m) return undefined;
    const r = sel.getRangeAt(0);
    if (!m.contains(r.startContainer) || !m.contains(r.endContainer)) return undefined;
    return sel.toString().trim() || undefined;
  };
  let watching: MutationObserver | null = null;
  let selA = 0;
  let selF = 0;
  const charOffset = (root: HTMLElement, p: Point): number => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    let acc = 0;
    while ((n = walker.nextNode())) {
      if (n === p.node) return acc + Math.min(p.offset, (n.textContent ?? '').length);
      acc += (n.textContent ?? '').length;
    }
    if (p.node === root) return p.offset === 0 ? 0 : acc;
    return 0;
  };
  const pointAtChar = (root: HTMLElement, off: number): Point | null => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    let acc = 0;
    let last: Node | null = null;
    while ((n = walker.nextNode())) {
      const len = (n.textContent ?? '').length;
      if (off < acc + len) return {node: n, offset: off - acc};
      acc += len;
      last = n;
    }
    return last ? {node: last, offset: (last.textContent ?? '').length} : null;
  };
  const textLength = (root: HTMLElement): number => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    let acc = 0;
    while ((n = walker.nextNode())) acc += (n.textContent ?? '').length;
    return acc;
  };
  const charAt = (root: HTMLElement, i: number): string => {
    const p = pointAtChar(root, i);
    if (!p) return '';
    return (p.node.textContent ?? '').charAt(p.offset);
  };
  const isBreak = (c: string) => c === '' || /\s/.test(c);
  const wordAt = (root: HTMLElement, i: number): [number, number] | null => {
    const total = textLength(root);
    if (!total) return null;
    let s = Math.min(i, total - 1);
    if (isBreak(charAt(root, s)) && s > 0) s -= 1;
    if (isBreak(charAt(root, s))) return null;
    let a = s;
    let f = s + 1;
    while (a > 0 && !isBreak(charAt(root, a - 1))) a--;
    while (f < total && !isBreak(charAt(root, f))) f++;
    return [a, f];
  };
  const BLOCK_TAGS = new Set([
    'P',
    'LI',
    'PRE',
    'BLOCKQUOTE',
    'DIV',
    'TD',
    'TH',
    'FIGCAPTION',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6'
  ]);
  const blockOf = (root: HTMLElement, node: Node): HTMLElement => {
    let el: HTMLElement | null =
      node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
    while (el && el !== root && root.contains(el)) {
      if (BLOCK_TAGS.has(el.tagName)) return el;
      el = el.parentElement;
    }
    return root;
  };
  const breaksIn = (root: HTMLElement): number[] => {
    const at: number[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n: Node | null;
    let acc = 0;
    while ((n = walker.nextNode())) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        if ((n as HTMLElement).tagName === 'BR') at.push(acc);
        continue;
      }
      const s = n.textContent ?? '';
      for (let k = 0; k < s.length; k++) if (s[k] === '\n') at.push(acc + k);
      acc += s.length;
    }
    return at;
  };
  const paragraphAt = (root: HTMLElement, i: number): [number, number] | null => {
    const total = textLength(root);
    if (!total) return null;
    const p = pointAtChar(root, Math.min(i, total - 1));
    if (!p) return null;
    const block = blockOf(root, p.node);
    if (block === root) {
      const at = breaksIn(root);
      let a = 0;
      let f = total;
      for (const b of at) {
        if (b <= i) a = Math.max(a, b);
        else {
          f = Math.min(f, b);
          break;
        }
      }
      while (f > a && isBreak(charAt(root, f - 1))) f--;
      while (a < f && isBreak(charAt(root, a))) a++;
      return a < f ? [a, f] : null;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    let acc = 0;
    let a = -1;
    let f = -1;
    while ((n = walker.nextNode())) {
      const len = (n.textContent ?? '').length;
      if (block.contains(n)) {
        if (a < 0) a = acc;
        f = acc + len;
      }
      acc += len;
    }
    if (a < 0 || f <= a) return null;
    while (f > a && isBreak(charAt(root, f - 1))) f--;
    while (a < f && isBreak(charAt(root, a))) a++;
    return a < f ? [a, f] : null;
  };
  const SETTLE_MS = 150;
  const SETTLE_CAP = 600;
  let settleQuiet = 0;
  let settleCap = 0;
  let settleOff: (() => void) | null = null;
  const cancelSettle = () => {
    clearTimeout(settleQuiet);
    clearTimeout(settleCap);
    settleQuiet = settleCap = 0;
    settleOff?.();
    settleOff = null;
  };
  const whenSettled = (open: () => void) => {
    cancelSettle();
    const done = () => {
      cancelSettle();
      open();
    };
    const bump = () => {
      clearTimeout(settleQuiet);
      settleQuiet = window.setTimeout(done, SETTLE_MS);
    };
    document.addEventListener('selectionchange', bump);
    settleOff = () => document.removeEventListener('selectionchange', bump);
    settleCap = window.setTimeout(done, SETTLE_CAP);
    bump();
  };
  const selectRun = (root: HTMLElement, run: [number, number] | null, at: MenuPoint): boolean => {
    if (!run) return false;
    const a = pointAtChar(root, run[0]);
    const f = pointAtChar(root, run[1]);
    if (!a || !f) return false;
    put(a, f);
    const text = selectedInMessage();
    if (!text) return false;
    at = menuPointForSelection(at);
    const b = messageNode;
    clearTimeout(tapMenuTimer);
    tapMenuTimer = window.setTimeout(() => {
      tapMenuTimer = 0;
      if (!b?.isConnected) return;
      whenSettled(() => {
        const live = b.isConnected
          ? b
          : b.dataset.mid
            ? (o.element.querySelector(
                `.cyc-message[data-mid="${CSS.escape(b.dataset.mid)}"]`
              ) as HTMLElement | null)
            : null;
        if (!live) return;
        const now = (window.getSelection()?.toString() ?? '').trim() || text;
        o.onMenu(live, menuPointForSelection(at), now);
      });
    }, MULTI_TAP_MS);
    return true;
  };
  const reclamp = () => {
    if (!selecting || menuUp) return;
    const m = liveMessage();
    if (!m) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (m.contains(r.startContainer) && m.contains(r.endContainer)) return;
    }
    if (selA === selF) return;
    const a = pointAtChar(m, selA);
    const f = pointAtChar(m, selF);
    if (!a || !f) return;
    anchor = a;
    put(a, f);
  };
  const watch = () => {
    if (watching) return;
    watching = new MutationObserver(reclamp);
    watching.observe(o.element, {childList: true, subtree: true});
  };
  const unwatch = () => {
    watching?.disconnect();
    watching = null;
    selA = selF = 0;
  };
  const raiseMenu = (text: string | undefined, at: MenuPoint) => {
    const b = liveMessage() && messageNode;
    if (!b) return;
    menuUp = true;
    o.onMenu(b, at, text);
  };
  const onTouchStart = (e: TouchEvent) => {
    forget();
    if (e.touches.length > 1) return;
    const target = e.target;
    if (o.isInteractive(target)) return;
    const b = o.messageNodeOf(target);
    const m = b?.querySelector('.cyc-message-text') as HTMLElement | null;
    if (!b || !m) return;
    messageNode = b;
    message = m;
    mid = b.dataset.mid ?? '';
    const t = e.touches[0];
    start = {x: t.clientX, y: t.clientY};
    lift = menuPoint(t.clientX, t.clientY);
    clearTimeout(tapMenuTimer);
    tapMenuTimer = 0;
    cancelSettle();
    const now = Date.now();
    const near =
      Math.abs(t.clientX - lastTap.x) <= MULTI_TAP_SLOP &&
      Math.abs(t.clientY - lastTap.y) <= MULTI_TAP_SLOP;
    tapCount = now - lastTapAt <= MULTI_TAP_MS && near ? tapCount + 1 : 1;
    lastTapAt = now;
    lastTap = {x: t.clientX, y: t.clientY};
    armTimer = window.setTimeout(() => {
      armTimer = 0;
      const held = liveMessage() && messageNode;
      if (moved || !held) return;
      armed = true;
    }, SELECT_ARM_MS);
    menuTimer = window.setTimeout(() => {
      menuTimer = 0;
      const held = liveMessage() && messageNode;
      if (moved || selecting || !held) return;
      raiseMenu(undefined, menuPoint(start.x, start.y));
    }, MENU_MS);
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!messageNode || !message) return;
    const msg = liveMessage();
    if (!msg) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (!armed) {
      if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) {
        moved = true;
        forget();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (menuUp) return;
    if (!selecting) {
      if (Math.abs(dx) <= DRAG_SLOP && Math.abs(dy) <= DRAG_SLOP) return;
      const a = clampTo(msg, caretAt(start.x, start.y));
      if (!a) {
        forget();
        return;
      }
      anchor = a;
      selecting = true;
      moved = true;
      watch();
      clearTimeout(menuTimer);
      menuTimer = 0;
    }
    if (anchor && !anchor.node.isConnected) {
      anchor = clampTo(msg, caretAt(start.x, start.y));
    }
    if (!anchor) return;
    const f = clampTo(msg, caretAt(t.clientX, t.clientY));
    if (f) {
      put(anchor, f);
      selA = charOffset(msg, anchor);
      selF = charOffset(msg, f);
    }
    lift = menuPoint(t.clientX, t.clientY);
  };
  const onTouchEnd = () => {
    clearTimeout(armTimer);
    clearTimeout(menuTimer);
    armTimer = menuTimer = 0;
    const hadMenu = menuUp;
    const finalText = selecting && !menuUp ? selectedInMessage() : undefined;
    if (finalText) raiseMenu(finalText, menuPointForSelection(lift));
    if (!selecting && !menuUp && !moved && tapCount >= 2) {
      const msg = liveMessage();
      const p = msg && clampTo(msg, caretAt(start.x, start.y));
      if (msg && p) {
        const i = charOffset(msg, p);
        const run = tapCount === 2 ? wordAt(msg, i) : paragraphAt(msg, i);
        selectRun(msg, run, menuPoint(start.x, start.y));
      }
      if (tapCount >= 3) tapCount = 0;
    } else if (selecting || hadMenu || moved) {
      tapCount = 0;
    }
    const raised = hadMenu || menuUp;
    forget();
    if (raised) swallowNextClick();
  };
  const opts: AddEventListenerOptions = {passive: false};
  o.element.addEventListener('touchstart', onTouchStart, opts);
  o.element.addEventListener('touchmove', onTouchMove, opts);
  o.element.addEventListener('touchend', onTouchEnd, opts);
  o.element.addEventListener('touchcancel', forget, opts);
  return () => {
    forget();
    clearTimeout(tapMenuTimer);
    tapMenuTimer = 0;
    cancelSettle();
    o.element.removeEventListener('touchstart', onTouchStart, opts);
    o.element.removeEventListener('touchmove', onTouchMove, opts);
    o.element.removeEventListener('touchend', onTouchEnd, opts);
    o.element.removeEventListener('touchcancel', forget, opts);
  };
}
