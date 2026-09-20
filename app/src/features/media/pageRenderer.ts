import type {MarkdownInline, MarkdownBlock} from '@/features/content/markdown';
import {codeBlockElement} from '@/features/chat/content';
import {h} from '../../components/domHelpers';
import {renderSyntaxBlocks, paintCodeBlocks} from '@/features/code/viewer';
import {MEDIA_PRIMARY_TEXT, MEDIA_PRIMARY_ACCENT, paintOnTheme} from './mediaPaint';

const ALL_MD_PRIMARY_TEXT = Object.values(MEDIA_PRIMARY_TEXT);
const ALL_MD_PRIMARY_ACCENT = Object.values(MEDIA_PRIMARY_ACCENT);

const MD_CODE_UTILS =
  'cyc-md-code font-[family-name:JetBrains_Mono,monospace] text-[0.875em] text-[color:var(--cyc-text)] bg-[var(--cyc-text-muted-tint)] rounded px-[0.3125rem] py-[0.0625rem]';
const MD_HEADING_UTILS = 'font-medium leading-[1.3] mt-[1.375rem] mb-2.5';
const MD_HEADING_SIZE: Record<number, string> = {
  2: 'text-[1.375rem]',
  3: 'text-[1.1875rem]',
  4: 'text-[1.0625rem]',
  5: 'text-[1rem]',
  6: 'text-[1rem]'
};

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
      'cyc-md-h' +
        block.level +
        (MD_HEADING_SIZE[level] ? ` ${MD_HEADING_UTILS} ${MD_HEADING_SIZE[level]}` : '')
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
    pre.classList.add('my-3!');
    pre.querySelector('.cyc-src-body')?.classList.add('[overflow-wrap:normal]!');
    return pre;
  }
  if (block.kind === 'divider')
    return h('hr', 'cyc-md-hr my-5 border-0 border-t border-[color:var(--cyc-border-color)]');
  if (block.kind === 'anchor') return h('span', 'cyc-md-anchor', {'data-anchor': block.name});
  if (block.kind === 'quote') {
    const el = h(
      'blockquote',
      'cyc-md-quote [border-inline-start:3px_solid_var(--cyc-accent)] my-3 py-0.5 pl-3 pr-0 whitespace-pre-wrap'
    );
    renderMarks(block.content, el);
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
    const list = h(
      block.ordered ? 'ol' : 'ul',
      'cyc-md-list my-2.5 ps-6 ' + (block.ordered ? 'list-decimal' : 'list-disc')
    ) as HTMLOListElement;
    for (const item of block.items) {
      const li = h('li', 'my-1 whitespace-pre-wrap');
      if (item.checked !== undefined) {
        li.classList.add('cyc-md-task', 'list-none', 'ms-[-1.25rem]');
        const box = h(
          'input',
          'cyc-md-checkbox me-[0.4375rem] align-[-0.125rem] pointer-events-none',
          {
            type: 'checkbox',
            disabled: ''
          }
        ) as HTMLInputElement;
        paintOnTheme(box, ALL_MD_PRIMARY_ACCENT, (t) => MEDIA_PRIMARY_ACCENT[t]);
        box.checked = item.checked;
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
  const wrap = h('div', 'cyc-md-table-wrap overflow-x-auto my-3');
  const table = h('table', 'cyc-md-table border-collapse text-[0.9375rem]');
  const head = h('thead', '');
  const body = h('tbody', '');
  const CELL_UTILS = 'border border-[color:var(--cyc-border-color)] px-2.5 py-1.5 text-left';
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
    'cyc-md text-[color:var(--cyc-text)] text-[1rem] leading-[1.6] break-words'
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
