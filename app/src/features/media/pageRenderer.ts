import type {MarkdownInline, MarkdownBlock} from '@/features/content/markdown';

type MarkdownImage = Extract<MarkdownInline, {kind: 'image'}>;
import {codeBlockElement} from '@/features/chat/content';
import {h} from '../../components/domHelpers';
import {renderSyntaxBlocks, paintCodeBlocks} from '@/features/code/viewer';
import {MEDIA_PRIMARY_TEXT, paintOnTheme} from './mediaPaint';
import type {PresentationTheme} from '../../components/presentation';

const ALL_MD_PRIMARY_TEXT = Object.values(MEDIA_PRIMARY_TEXT);

// Whether `![alt](https://...)` loads the remote image. Off, it renders as a link
// labelled with the alt text and nothing is fetched until the reader taps it.
export const REMOTE_IMAGES = false;

// The read-only task box is drawn, not a native checkbox: index.html declares
// `color-scheme: dark`, so a native box paints dark on the day page (a solid grey
// square in Chromium, a borderless white one in WebKit). A done box fills with
// the primary copper and its tick takes the surface ink.
const MD_TASK_BOX =
  'cyc-md-checkbox inline-grid place-items-center size-[1.0625rem] me-[0.4375rem] align-[-0.1875rem] rounded-[0.25rem] border-[1.5px] border-solid';
const MD_TASK_OPEN: Record<PresentationTheme, string[]> = {
  day: ['border-[#6b6b70]', 'bg-[#ffffff]'],
  night: ['border-[#a0a0a6]', 'bg-[#17171a]']
};
const MD_TASK_DONE: Record<PresentationTheme, string[]> = {
  day: ['border-[#96602f]', 'bg-[#96602f]', 'text-[#ffffff]'],
  night: ['border-[#c98652]', 'bg-[#c98652]', 'text-[#17171a]']
};
const MD_TASK_TICK =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ALL_MD_TASK = [...Object.values(MD_TASK_OPEN), ...Object.values(MD_TASK_DONE)].flat();

const MD_CODE_UTILS =
  'cyc-md-code font-[family-name:JetBrains_Mono,monospace] text-[0.875em] text-[color:var(--cyc-text)] bg-[var(--cyc-text-muted-tint)] rounded px-[0.3125rem] py-[0.0625rem]';
// `!` beats the un-layered chrome.css heading rules (h4 there is 1.5rem).
const MD_HEADING_UTILS = 'leading-[1.3]! mt-[1.375rem]! mb-2.5!';
const MD_HEADING_SIZE: Record<number, string> = {
  1: 'text-[1.75rem]!',
  2: 'text-[1.375rem]!',
  3: 'text-[1.1875rem]!',
  4: 'text-[1.0625rem]!',
  5: 'text-[1rem]!',
  6: 'text-[0.875rem]! text-[color:var(--cyc-text-muted)]'
};
// Rules and cell borders use the muted ink: --cyc-border-color all but vanishes
// on the viewer background (#e6e6e8 on #ece9e3 by day, #000 on #0d0d0e by night).
const MD_RULE_BORDER = 'border-[color:color-mix(in_srgb,var(--cyc-text-muted)_45%,transparent)]';
// Pan-flow code hides its scrollbar in chat; the page shows a thin one so a mouse
// user can see the block scrolls. `!` beats the un-layered chat.css hide rules.
const MD_CODE_SCROLLBAR =
  '[scrollbar-width:thin]! [&::-webkit-scrollbar]:block! [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-[var(--cyc-text-muted)]';

function imageLink(image: MarkdownImage): HTMLAnchorElement {
  const link = h('a', 'cyc-md-link cyc-md-image-link no-underline hover:underline!', {
    href: image.src,
    target: '_blank',
    rel: 'noopener'
  });
  paintOnTheme(link, ALL_MD_PRIMARY_TEXT, (t) => MEDIA_PRIMARY_TEXT[t]);
  link.textContent = image.alt || image.src;
  return link;
}

// `remote` is REMOTE_IMAGES; the tests pass it to cover both settings.
export function markdownImage(image: MarkdownImage, remote = REMOTE_IMAGES): HTMLElement {
  if (!remote) return imageLink(image);
  const img = h('img', 'cyc-md-image inline-block max-w-full h-auto rounded-lg align-top', {
    src: image.src,
    alt: image.alt,
    loading: 'lazy',
    referrerpolicy: 'no-referrer'
  });
  // An image that cannot load becomes a link to it, never a broken-image icon.
  img.addEventListener('error', () => img.replaceWith(imageLink(image)), {once: true});
  return img;
}

function renderMarks(marks: MarkdownInline[], parent: Node) {
  for (const node of marks) {
    if (node.kind === 'text') {
      parent.appendChild(document.createTextNode(node.value));
      continue;
    }
    if (node.kind === 'math') {
      const code = h('code', MD_CODE_UTILS);
      code.textContent = node.source;
      parent.appendChild(code);
      continue;
    }
    if (node.kind === 'link') {
      const link = h('a', 'cyc-md-link no-underline hover:underline!', {href: node.href});
      paintOnTheme(link, ALL_MD_PRIMARY_TEXT, (t) => MEDIA_PRIMARY_TEXT[t]);
      if (!node.href.startsWith('#')) {
        link.target = '_blank';
        link.rel = 'noopener';
      }
      renderMarks(node.marks, link);
      parent.appendChild(link);
      continue;
    }
    if (node.kind === 'image') {
      parent.appendChild(markdownImage(node));
      continue;
    }
    if (node.kind === 'anchor') {
      const el = h('span', 'cyc-md-anchor', {'data-anchor': node.name});
      renderMarks(node.marks, el);
      parent.appendChild(el);
      continue;
    }
    const tag =
      node.kind === 'strong'
        ? 'b'
        : node.kind === 'emphasis'
          ? 'i'
          : node.kind === 'underline'
            ? 'u'
            : node.kind === 'strike'
              ? 'del'
              : node.kind === 'highlight'
                ? 'mark'
                : node.kind === 'subscript'
                  ? 'sub'
                  : node.kind === 'superscript'
                    ? 'sup'
                    : 'code';
    const el = h(
      tag as 'b',
      node.kind === 'code'
        ? MD_CODE_UTILS
        : node.kind === 'highlight'
          ? 'bg-[var(--cyc-bubble-flash)] text-[color:var(--cyc-text)] rounded-[0.125rem] px-0.5'
          : ''
    );
    renderMarks(node.marks, el);
    parent.appendChild(el);
  }
}

function renderNode(block: MarkdownBlock): HTMLElement | null {
  if (block.kind === 'heading') {
    const level = Math.min(6, Math.max(1, block.level));
    const el = h(
      ('h' + level) as 'h1',
      `cyc-md-h${level} ${MD_HEADING_UTILS} ${MD_HEADING_SIZE[level]}`
    );
    renderMarks(block.content, el);
    return el;
  }
  if (block.kind === 'paragraph') {
    const el = h('p', 'my-2.5 whitespace-pre-wrap');
    renderMarks(block.content, el);
    return el;
  }
  if (block.kind === 'code' || block.kind === 'mathBlock') {
    // Markdown code spacing; `!` beats the shared code-block defaults.
    const pre = codeBlockElement(block.value, block.kind === 'mathBlock' ? 'math' : block.language);
    // The day surface lifts the block off the page; night paint's `!` keeps its own.
    pre.classList.add(
      'my-3!',
      'bg-[var(--cyc-surface)]',
      'border-[color:color-mix(in_srgb,var(--cyc-text-muted)_45%,transparent)]!'
    );
    pre
      .querySelector('.cyc-src-body')
      ?.classList.add('[overflow-wrap:normal]!', ...MD_CODE_SCROLLBAR.split(' '));
    return pre;
  }
  if (block.kind === 'divider')
    return h('hr', `cyc-md-hr my-6 border-0 border-t ${MD_RULE_BORDER}`);
  if (block.kind === 'anchor') return h('span', 'cyc-md-anchor', {'data-anchor': block.name});
  if (block.kind === 'quote') {
    const el = h(
      'blockquote',
      'cyc-md-quote [border-inline-start:3px_solid_var(--cyc-accent)] my-3 py-0.5 ps-3.5 pe-0 text-[color:var(--cyc-text-muted)] [&>:first-child]:mt-0! [&>:last-child]:mb-0!'
    );
    for (const child of block.nodes) {
      const rendered = renderNode(child);
      if (rendered) el.append(rendered);
    }
    return el;
  }
  if (block.kind === 'details') {
    const el = h(
      'details',
      'cyc-md-details my-3 rounded-lg border border-[color:var(--cyc-border-color)] px-3 py-2'
    ) as HTMLDetailsElement;
    el.open = block.open;
    const summary = h('summary', 'cursor-pointer font-medium');
    renderMarks(block.title, summary);
    el.append(summary);
    for (const child of block.nodes) {
      const rendered = renderNode(child);
      if (rendered) el.append(rendered);
    }
    return el;
  }
  if (block.kind === 'list') {
    // `!` beats the un-layered reset.css `:where(ul)` list-style/padding reset.
    const list = h(
      block.ordered ? 'ol' : 'ul',
      'cyc-md-list my-2.5 ps-6! [li>&]:my-1! ' +
        (block.ordered ? 'list-decimal!' : 'list-disc! [li>&]:list-[circle]!')
    ) as HTMLOListElement;
    for (const item of block.items) {
      const li = h('li', 'my-1 whitespace-pre-wrap');
      if (item.checked !== undefined) {
        li.classList.add('cyc-md-task', 'list-none', 'ms-[-1.25rem]');
        const done = item.checked;
        const box = h('span', MD_TASK_BOX, {
          role: 'checkbox',
          'aria-checked': String(done),
          'aria-readonly': 'true'
        });
        paintOnTheme(box, ALL_MD_TASK, (t) => (done ? MD_TASK_DONE : MD_TASK_OPEN)[t]);
        if (done) box.innerHTML = MD_TASK_TICK;
        li.append(box);
      }
      if (block.ordered && item.number) li.value = item.number;
      renderMarks(item.content, li);
      for (const child of item.nodes || []) {
        const rendered = renderNode(child);
        if (rendered) li.append(rendered);
      }
      list.append(li);
    }
    return list;
  }
  // The table sizes to its content and wraps cells to fit the column; it only
  // scrolls in its own container when the cells' minimum widths cannot fit (a
  // phone, or very many columns). The minimum, wider on a phone, keeps a narrow
  // column from squeezing its text to one word per line.
  const wrap = h('div', 'cyc-md-table-wrap overflow-x-auto my-3');
  const table = h('table', 'cyc-md-table border-collapse text-[0.9375rem]');
  const head = h('thead', '');
  const body = h('tbody', '');
  const CELL_UTILS = `min-w-[5.5rem] max-[550px]:min-w-[7.5rem] border ${MD_RULE_BORDER} px-2.5 py-1.5 text-left align-top`;
  for (const [rowIndex, row] of block.rows.entries()) {
    const tr = h('tr', '');
    for (const cell of row) {
      const el = h(
        cell.header ? 'th' : 'td',
        cell.header ? CELL_UTILS + ' bg-[var(--cyc-surface)] font-medium' : CELL_UTILS
      ) as HTMLTableCellElement;
      el.style.textAlign = cell.align;
      renderMarks(cell.content, el);
      tr.append(el);
    }
    (rowIndex === 0 ? head : body).append(tr);
  }
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

export function renderMarkdown(nodes: MarkdownBlock[]): HTMLElement {
  const article = h(
    'article',
    'cyc-md text-[color:var(--cyc-text)] text-[1rem] leading-[1.6] break-words [&>h1:first-child]:mt-0!'
  );
  for (const node of nodes) {
    const rendered = renderNode(node);
    if (rendered) article.append(rendered);
  }
  renderSyntaxBlocks(article);
  paintCodeBlocks(article);
  article.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement).closest?.('a[href^="#"]');
    if (!link || !article.contains(link)) return;
    event.preventDefault();
    const name = decodeURIComponent(link.getAttribute('href')!.slice(1));
    article
      .querySelector<HTMLElement>(`[data-anchor="${CSS.escape(name)}"]`)
      ?.scrollIntoView({behavior: 'smooth', block: 'start'});
  });
  return article;
}
