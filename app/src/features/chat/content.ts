import type {CycMessage} from '../../types';

// A control-answer row: the transcript line the engine records when the owner
// answers a terminal prompt from the app (the session-resume picker, a yes/no
// dialog). The engine writes it as a user message formatted `↩ <label>` at its
// one origin (agent-engine sessions/session-verbs.ts onAnswer, the sentinel
// CONTROL_ANSWER_PREFIX in chat/chatmsg.ts). It is a control INPUT, not a
// message the user typed, so it must not paint a bubble, drive the sidebar
// preview, or set the last-activity clock. The row stays in the store (real
// history); only its shape is recognised here, matching the exact `↩ ` prefix
// on a user row, never a fuzzy search over arbitrary user text.
export function isResumeControlRow(m: {role: string; text?: string} | undefined): boolean {
  return !!m && m.role === 'user' && typeof m.text === 'string' && m.text.startsWith('↩ ');
}

export function awaitingWords(m: CycMessage): boolean {
  return (
    m.role === 'user' &&
    m.kind === 'voice' &&
    m.status !== 'failed' &&
    (m.draftCommitted !== undefined || !m.text.trim())
  );
}
type CycReach = 'app' | 'engine' | 'session' | 'failed';
export function reachOf(
  m: CycMessage & {
    dedupeKey?: string;
  }
): CycReach {
  if (m.dedupeKey || m.status === 'delivered') return 'session';
  if (m.queued) return 'app';
  if (m.status === 'failed') return 'failed';
  if (m.status === 'sending') return 'app';
  return 'engine';
}
export function stillSending(
  m:
    | (CycMessage & {
        dedupeKey?: string;
      })
    | undefined
): boolean {
  if (!m || m.role !== 'user') return false;
  const reach = reachOf(m);
  return reach === 'app' || reach === 'engine';
}
export function clipAwaitingWords(m: CycMessage, u: NonNullable<CycMessage['upload']>): boolean {
  return !!m.wordsPending && !m.wordsFailed && !u.textLen;
}
export function tickGlyph(
  m: CycMessage
): 'deliveryPending' | 'deliveryAccepted' | 'deliveryConfirmed' | 'deliveryFailed' {
  switch (reachOf(m)) {
    case 'failed':
      return 'deliveryFailed';
    case 'app':
      return 'deliveryPending';
    case 'engine':
      return 'deliveryAccepted';
    case 'session':
      return 'deliveryConfirmed';
  }
}
export function hasRecording(m: CycMessage): boolean {
  return !m.clipLost;
}
export function uploadTitle(u: NonNullable<CycMessage['upload']>): string {
  return u.fromPage ? `submit:${u.fromPage.page}` : u.name;
}
export function isAudioUpload(u: NonNullable<CycMessage['upload']>): boolean {
  return /^audio\//.test(u.mime);
}
export function uploadsOf(m: CycMessage): NonNullable<CycMessage['upload']>[] {
  return (
    (m.uploads?.filter(Boolean) as NonNullable<CycMessage['upload']>[] | undefined) ??
    (m.upload ? [m.upload] : [])
  );
}
import type {CycMediaItem, CycSession} from '../../types';
export const uploadKey = (uploadId: string) => 'u:' + uploadId;
export const shownKey = (docId: string) => 'd:' + docId;
export function sessionMedia(
  s: CycSession,
  urlOf: (item: Omit<CycMediaItem, 'url'>) => string
): CycMediaItem[] {
  const items: CycMediaItem[] = [];
  const add = (item: Omit<CycMediaItem, 'url'>) => items.push({...item, url: urlOf(item)});
  for (const m of s.messages) {
    for (const up of uploadsOf(m)) {
      if (isAudioUpload(up)) continue;
      add({
        key: uploadKey(up.uploadId),
        kind: up.image ? 'image' : 'doc',
        from: 'upload',
        refId: up.uploadId,
        name: up.name,
        size: up.size,
        ts: m.ts
      });
    }
    if (m.file && (m.file.fileKind === 'image' || !m.file.inline)) {
      add({
        key: shownKey(m.file.docId),
        kind: m.file.fileKind === 'image' ? 'image' : 'doc',
        from: 'shown',
        refId: m.file.docId,
        name: m.file.name,
        size: m.file.size,
        ts: m.ts
      });
    }
  }
  return items;
}
export const fmtTime = (ts: number) => {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
};
export const mmss = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export function turnAge(since: number, now: number = Date.now()): string {
  const m = Math.floor(Math.max(0, now - since) / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h${m % 60}m`;
}
export function dayLabel(ts: number): string {
  const d = new Date(ts),
    today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, {month: 'long', day: 'numeric'});
}
/** Produce a compact, word-aware preview without preserving a source-specific cutoff gap. */
export function previewText(value: string, maxChars: number): string {
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, Math.max(1, maxChars));
  const boundary = cut.lastIndexOf(' ');
  return (boundary > Math.floor(maxChars * 0.55) ? cut.slice(0, boundary) : cut).trimEnd() + '…';
}
export type Karaoke = {
  el: HTMLElement;
  words: HTMLElement[];
  ends: number[];
  total: number;
  lit: number;
  mark: number;
};
export function karaokeFor(t: HTMLElement | null | undefined): Karaoke | null {
  if (!t) return null;
  if (!t.dataset.karaoke) {
    const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) nodes.push(n as Text);
    for (const node of nodes) {
      const frag = document.createDocumentFragment();
      for (const part of (node.textContent || '').split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) frag.append(part);
        else {
          const sp = document.createElement('span');
          sp.className =
            'cyc-kw [.cyc-karaoke.cyc-hot_&]:opacity-[0.45] ' +
            '[.cyc-karaoke.cyc-hot_&]:[transition:opacity_300ms_linear] ' +
            '[.cyc-karaoke.cyc-hot_&.cyc-spoken]:opacity-[0.999] ' +
            '[.cyc-karaoke.cyc-hot_&.cyc-spoken]:[transition:none]';
          sp.textContent = part;
          frag.append(sp);
        }
      }
      node.replaceWith(frag);
    }
    t.dataset.karaoke = '1';
  }
  const words = [...t.querySelectorAll<HTMLElement>('.cyc-kw')];
  const ends: number[] = [];
  let acc = 0;
  for (const w of words) {
    acc += (w.textContent?.length || 0) + 1;
    ends.push(acc);
  }
  let lit = 0;
  while (lit < words.length && words[lit].classList.contains('cyc-spoken')) lit++;
  return {
    el: t,
    words,
    ends,
    total: t.textContent?.length || 1,
    lit,
    mark: t.dataset.karaokeAt ? Number(t.dataset.karaokeAt) : 0
  };
}
export function karaokeUpdate(k: Karaoke, ratio: number, capRatio?: number) {
  const forward = ratio < k.mark - 0.05 ? ratio : Math.max(ratio, k.mark);
  k.mark = forward;
  const grown = capRatio !== undefined && capRatio >= 0 && capRatio < 1;
  const span = grown ? capRatio * k.total : k.total;
  const budget = forward * span;
  let want = k.lit;
  if (forward >= 1 && !grown) want = k.words.length;
  else {
    while (want < k.ends.length && k.ends[want] <= budget) want++;
    while (want > 0 && k.ends[want - 1] > budget) want--;
  }
  if (want === k.lit) return;
  if (want > k.lit) for (let i = k.lit; i < want; i++) k.words[i].classList.add('cyc-spoken');
  else for (let i = want; i < k.lit; i++) k.words[i].classList.remove('cyc-spoken');
  k.lit = want;
  k.el.dataset.karaokeAt = String(forward);
}
import {h} from '../../components/domHelpers';
import {makeIcon, wrapIcon} from '../../components/iconGlyphs';
import {applyCodeFlow, renderSyntaxBlocks, paintCodeBlocks} from '@/features/code/viewer';
import {findSyntax} from '@/features/code/languages';
import {QUOTE_BAR_CLASS, QUOTE_FRAME_CLASSES, QUOTE_MARK_CLASS} from '@/features/chat/quoteDecor';
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
export function formatInline(text: string): string {
  let html = escapeHtml(text);
  const spans: string[] = [];
  html = html.replace(
    /`([^`\n]+)`/g,
    (_, body: string) =>
      '\x00' +
      (spans.push(`<code class="cyc-inline-code cursor-pointer">${body}</code>`) - 1) +
      '\x00'
  );
  html = html.replace(/\*\*\*([^\n]+?)\*\*\*/g, '<b><i>$1</i></b>');
  html = html.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/\+\+([^\n]+?)\+\+/g, '<u>$1</u>');
  html = html.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');
  html = html.replace(/(^|[^*\w])\*([^\s*][^*\n]*?)\*(?![*\w])/g, '$1<i>$2</i>');
  html = html.replace(
    /(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g,
    '<a class="cyc-link" href="$1" target="_blank" rel="noopener">$1</a>'
  );
  html = html.replace(/\x00(\d+)\x00/g, (_, i: string) => spans[+i]);
  return html;
}
type Block = {
  block?: boolean;
  html: string;
};
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)[ \t]*$/;
// Header icons are the click targets; `pointer-events-auto!` beats the icon reset.
const CODE_HEADER_BTN = 'text-[18px] pointer-events-auto! rounded-full p-1';
// Message-scoped table geometry. `!` beats codeViewer.css where values differ.
const SNIPPET_TABLE_BOX =
  'cyc-snippet-table-box [.cyc-message_&]:my-2! [.cyc-message_&]:max-w-full';
const SNIPPET_TABLE_BAR =
  'cyc-snippet-table-bar [.cyc-message_&]:flex [.cyc-message_&]:justify-end [.cyc-message_&]:mb-[0.1875rem]!';
const SNIPPET_TABLE_WRAP =
  'cyc-snippet-table-wrap cyc-overflower [.cyc-message_&]:max-w-full [.cyc-message_&]:overflow-x-auto [.cyc-message_&]:[overscroll-behavior-inline:contain] [.cyc-message_&]:[touch-action:pan-x]';
const SNIPPET_TABLE =
  'cyc-snippet-table [.cyc-message_&]:w-max [.cyc-message_&]:min-w-full [.cyc-message_&]:border-collapse [.cyc-message_&]:text-[0.875rem]! [.cyc-message_&]:leading-[1.35]';
// The shared cell geometry (max-width, padding, 1px border, top align, anywhere
// break, start align) sits on both th and td; th layers the header tint + weight.
// `max-width` is `.cyc-overflower`-scoped so the un-scrolled wrap state keeps its
// codeViewer.css `max-width:none`; the phone utilities out-specify the base ones.
const SNIPPET_TABLE_CELL =
  '[.cyc-message_.cyc-overflower_&]:max-w-[18rem]! max-[550px]:[.cyc-message_.cyc-overflower_.cyc-snippet-table_&]:max-w-[14rem]! [.cyc-message_&]:px-2.5! [.cyc-message_&]:py-1.5! max-[550px]:[.cyc-message_.cyc-snippet-table_&]:px-2! max-[550px]:[.cyc-message_.cyc-snippet-table_&]:py-1! [.cyc-message_&]:[border:1px_solid_var(--cyc-border-color)] [.cyc-message_&]:align-top [.cyc-message_&]:[overflow-wrap:anywhere] [.cyc-message_&]:text-start';
const SNIPPET_TABLE_TH =
  SNIPPET_TABLE_CELL +
  ' [.cyc-message_&]:bg-[var(--cyc-text-muted-tint)] [.cyc-message_&]:font-medium!';
export function codeBlockElement(body: string, tag: string, wrapped = false): HTMLElement {
  const fence = tag.trim();
  const syntax = fence ? findSyntax(fence) : undefined;
  // A recognised fence shows its catalogue title; an unrecognised one shows the fence
  // verbatim so the author still sees what they typed. The wrap/pan flow lives on
  // data-cyc-code-flow (set below).
  const caption = syntax?.title ?? fence;
  const pre = h('pre', 'cyc-code-frame my-1 text-[14px]');
  // The fence survives on the element so the fullscreen viewer can rebuild an
  // identical block without reverse-engineering it from the caption text.
  if (fence) pre.dataset.cycFence = fence;
  const header = h(
    'div',
    'cyc-src-head flex items-center cursor-pointer leading-none py-[0.0625rem] ps-2.5 ' +
      'pe-[0.0625rem] font-[family-name:Inter,system-ui,-apple-system,BlinkMacSystemFont,Segoe_UI,Roboto,sans-serif] font-medium'
  );
  const name = h(
    'span',
    'cyc-src-head-name flex-auto whitespace-nowrap text-ellipsis overflow-hidden'
  );
  name.textContent = caption;
  const CODE_HEADER_BTN_HOVER =
    'fine:hover:bg-[rgba(var(--cyc-accent-rgb),0.16)] fine:active:bg-[rgba(var(--cyc-accent-rgb),0.16)]';
  header.append(
    name,
    wrapIcon(
      `cyc-code-action cyc-code-toggle-wrap ms-3.5 ${CODE_HEADER_BTN} ${CODE_HEADER_BTN_HOVER}`
    ),
    makeIcon(
      'fullscreen',
      `cyc-code-action cyc-src-head-fullscreen ${CODE_HEADER_BTN} ${CODE_HEADER_BTN_HOVER}`
    ),
    makeIcon('copy', `cyc-code-action cyc-code-copy ${CODE_HEADER_BTN} ${CODE_HEADER_BTN_HOVER}`)
  );
  const content = h('div', 'cyc-src-pane leading-[19px]');
  const code = h(
    'code',
    `cyc-src-body block px-2.5 py-1 text-left [word-spacing:normal] [direction:ltr] ` +
      `[tab-size:4] hyphens-none`
  );
  if (syntax?.prismId) code.dataset.language = syntax.prismId;
  code.textContent = body;
  content.append(code);
  pre.append(header, content);
  applyCodeFlow(pre, wrapped ? 'wrap' : 'pan');
  return pre;
}
function codeBlockHtml(body: string, tag: string): string {
  return codeBlockElement(body, tag).outerHTML;
}
function fenceBlock(
  lines: string[],
  at: number
): {
  seg: Block;
  used: number;
} | null {
  const open = FENCE.exec(lines[at]);
  if (!open) return null;
  const marker = open[1];
  const body: string[] = [];
  let i = at + 1;
  for (; i < lines.length; i++) {
    const close = FENCE.exec(lines[i]);
    if (close && close[1][0] === marker[0] && close[1].length >= marker.length && !close[2]) break;
    body.push(lines[i]);
  }
  const closed = i < lines.length;
  return {
    seg: {block: true, html: codeBlockHtml(body.join('\n'), open[2])},
    used: (closed ? i + 1 : i) - at
  };
}
function quoteBlock(
  lines: string[],
  at: number
): {
  seg: Block;
  used: number;
} | null {
  if (!/^\s{0,3}>/.test(lines[at])) return null;
  const body: string[] = [];
  let i = at;
  for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) {
    body.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
  }
  const cls = `${QUOTE_FRAME_CLASSES.join(' ')} cyc-md-callout`;
  return {
    seg: {
      block: true,
      html: `<div class="${cls}"><span class="${QUOTE_BAR_CLASS}" aria-hidden="true"></span><span class="${QUOTE_MARK_CLASS}" aria-hidden="true"></span>${formatText(body.join('\n'))}</div>`
    },
    used: i - at
  };
}
export function tableFrom(
  lines: string[],
  at: number
): {
  el: HTMLElement;
  used: number;
} | null {
  const isRow = (l: string) => l.includes('|');
  const isDelim = (l: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-');
  if (!isRow(lines[at]) || !lines[at + 1] || !isDelim(lines[at + 1])) return null;
  const cells = (l: string) =>
    l
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  const align = cells(lines[at + 1]).map((d) =>
    d.startsWith(':') && d.endsWith(':')
      ? 'center'
      : d.endsWith(':')
        ? 'right'
        : d.startsWith(':')
          ? 'left'
          : ''
  );
  const table = h('table', SNIPPET_TABLE);
  const thead = h('thead');
  const hr = h('tr');
  cells(lines[at]).forEach((c, i) => {
    const th = h('th', SNIPPET_TABLE_TH);
    if (align[i]) th.style.textAlign = align[i];
    setFormatted(th, c);
    hr.append(th);
  });
  thead.append(hr);
  table.append(thead);
  const tbody = h('tbody');
  let i = at + 2;
  for (; i < lines.length && isRow(lines[i]); i++) {
    const tr = h('tr');
    cells(lines[i]).forEach((c, j) => {
      const td = h('td', SNIPPET_TABLE_CELL);
      if (align[j]) td.style.textAlign = align[j];
      setFormatted(td, c);
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(tbody);
  const wrap = h('div', SNIPPET_TABLE_WRAP);
  wrap.append(table);
  const bar = h('div', SNIPPET_TABLE_BAR);
  bar.append(
    wrapIcon('cyc-snippet-table-toggle-wrap hover:bg-(--cyc-text-muted-tint)'),
    makeIcon('fullscreen', 'cyc-snippet-table-fullscreen hover:bg-(--cyc-text-muted-tint)')
  );
  const box = h('div', SNIPPET_TABLE_BOX);
  box.append(bar, wrap);
  return {el: box, used: i - at};
}
function tableBlock(
  lines: string[],
  at: number
): {
  seg: Block;
  used: number;
} | null {
  const t = tableFrom(lines, at);
  return t && {seg: {block: true, html: t.el.outerHTML}, used: t.used};
}
export function formatText(text: string): string {
  const lines = text.split('\n');
  const segs: Block[] = [];
  let items: string[] | null = null;
  let ordered = false;
  let start = 1;
  const flush = () => {
    if (!items) return;
    // `!` on list style beats the reset.css ul reset.
    const listCls = ordered
      ? 'my-0.5 whitespace-normal ps-7! list-decimal!'
      : 'my-0.5 whitespace-normal ps-5! list-disc!';
    const liCls = ordered ? 'list-decimal!' : 'list-disc!';
    const open = ordered
      ? start !== 1
        ? `<ol start="${start}" class="${listCls}">`
        : `<ol class="${listCls}">`
      : `<ul class="${listCls}">`;
    segs.push({
      block: true,
      html:
        open +
        items.map((i) => `<li class="${liCls}">${i}</li>`).join('') +
        (ordered ? '</ol>' : '</ul>')
    });
    items = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenced = fenceBlock(lines, i);
    if (fenced) {
      flush();
      segs.push(fenced.seg);
      i += fenced.used - 1;
      continue;
    }
    const quoted = quoteBlock(lines, i);
    if (quoted) {
      flush();
      segs.push(quoted.seg);
      i += quoted.used - 1;
      continue;
    }
    const tabled = tableBlock(lines, i);
    if (tabled) {
      flush();
      segs.push(tabled.seg);
      i += tabled.used - 1;
      continue;
    }
    const head = /^ {0,3}(#{1,6})\s+(\S.*)$/.exec(line);
    if (head) {
      flush();
      const closing = /(?:^|\s)#+$/.exec(head[2]);
      const label = closing ? head[2].slice(0, closing.index).trimEnd() : head[2].trimEnd();
      segs.push({
        block: true,
        html: `<div class="cyc-md-h mt-1 mb-[0.0625rem] font-medium whitespace-normal">${formatInline(label || '#')}</div>`
      });
      continue;
    }
    const un = /^ {0,3}[-+*]\s+(\S.*)$/.exec(line);
    const or = un ? null : /^ {0,3}(\d{1,3})[.)]\s+(\S.*)$/.exec(line);
    if (un || or) {
      const isOrdered = !!or;
      if (items && ordered !== isOrdered) flush();
      if (!items) {
        items = [];
        ordered = isOrdered;
        start = or ? parseInt(or[1], 10) : 1;
      }
      items.push(formatInline((un ? un[1] : or![2]).trim()));
      continue;
    }
    flush();
    segs.push({html: formatInline(line)});
  }
  flush();
  let html = '';
  for (let i = 0; i < segs.length; i++) {
    if (i > 0 && !segs[i].block && !segs[i - 1].block) html += '\n';
    html += segs[i].html;
  }
  return html;
}
export function setFormatted(el: HTMLElement, text: string): void {
  el.innerHTML = formatText(text);
  renderSyntaxBlocks(el);
  paintCodeBlocks(el);
}
