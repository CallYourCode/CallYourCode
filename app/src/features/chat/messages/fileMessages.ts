import type {CycMessage} from '@/types';
import {h} from '@/components/domHelpers';
import {makeIconButton} from '@/components/iconGlyphs';
import {setFormatted, tableFrom} from '@/features/chat/content';
import {
  flowStamp,
  footStamp,
  docFootRow,
  createMessageNode,
  MESSAGE_CONTENT_UTILS,
  MESSAGE_TEXT_UTILS
} from './messageContent';
import {messageFrameEl, docFrameEl} from './messageFrame';
import {MEDIA_SECONDARY_TEXT, paintOnTheme} from '@/features/media/mediaPaint';
import {paintPresentation, type Presentation} from '@/components/presentation';
import {
  formatBytes,
  paintDocIcon,
  DOC_CHAT_UTILS,
  DOC_ICO_UTILS,
  DOC_NAME_UTILS,
  DOC_SIZE_UTILS
} from '@/features/media/mediaBox';

const SNIPPET_TASK_STATES = new Map([
  [' ', false],
  ['x', true]
]);

const SNIPPET_CODE_UTILS =
  'cyc-snippet-code my-1 mx-0 px-2 py-1.5 rounded-lg bg-[var(--cyc-text-muted-tint)] font-[family-name:JetBrains_Mono,monospace] text-[0.8125rem] leading-[1.3] whitespace-pre! overflow-x-auto [touch-action:pan-x]' +
  ' [&.cyc-snippet-mobile]:leading-[1.25] [&.cyc-snippet-mobile]:text-[0.75rem]';

// Toggle the phone-bucket marker and clear it for every wider bucket,
// mirroring paintSessionEventClamp. The `[&.cyc-snippet-mobile]:` literals above read
// it. The painter repaints while the pre stays connected and is pruned once it detaches.
function paintSnippetCodeMobile(el: HTMLElement): void {
  const run = (p: Presentation) => {
    el.classList.toggle('cyc-snippet-mobile', p.width === 'phone');
  };
  paintPresentation(el, run);
}

function snippetCodePre(extra = ''): HTMLElement {
  const pre = h('pre', SNIPPET_CODE_UTILS + extra);
  paintSnippetCodeMobile(pre);
  return pre;
}

function renderSnippetMarkdown(content: string): HTMLElement {
  const box = h('div', 'cyc-snippet-md text-[0.9375rem] leading-[1.35]');
  let code: HTMLElement | null = null;
  const lines = content.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    if (raw.trimStart().startsWith('```')) {
      code = code ? null : (box.appendChild(snippetCodePre()), box.lastElementChild as HTMLElement);
      continue;
    }
    if (code) {
      code.append(document.createTextNode(raw + '\n'));
      continue;
    }
    const line = raw.trim();
    if (!line) {
      box.append(h('div', 'cyc-snippet-gap h-1.5'));
      continue;
    }
    const table = tableFrom(lines, li);
    if (table) {
      box.append(table.el);
      li += table.used - 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(\S.*)$/);
    if (heading) {
      const el = h('div', 'cyc-snippet-h font-medium mt-1 mb-0.5');
      setFormatted(el, heading[2]);
      box.append(el);
      continue;
    }
    const task = line.match(/^[-+*]\s+\[(.)\]\s+(.*)$/);
    const done = task ? SNIPPET_TASK_STATES.get(task[1].toLowerCase()) : undefined;
    if (task && done !== undefined) {
      const el = h(
        'div',
        'cyc-snippet-task flex gap-1.5 items-baseline' +
          (done ? ' is-done text-[color:var(--cyc-text-muted)]' : '')
      );
      const mark = h('span', 'cyc-snippet-mark flex-none opacity-80');
      mark.textContent = done ? '\u2611' : '\u2610';
      const text = h('span', '');
      setFormatted(text, task[2]);
      el.append(mark, text);
      box.append(el);
      continue;
    }

    if (line.startsWith('>')) {
      const quoted: string[] = [];
      while (li < lines.length && lines[li].trim().startsWith('>')) {
        quoted.push(lines[li].trim().replace(/^>\s?/, ''));
        li++;
      }
      li--;
      const el = h(
        'div',
        'cyc-snippet-quote border-s-2 border-[var(--cyc-accent)] ps-2 my-0.5 text-[var(--cyc-text-muted)]'
      );
      setFormatted(el, quoted.join('\n'));
      box.append(el);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      const el = h('div', 'cyc-snippet-li flex gap-1.5 items-baseline');
      const mark = h('span', 'cyc-snippet-mark flex-none opacity-80');
      mark.textContent = '\u2022';
      const text = h('span', '');
      setFormatted(text, bullet[1]);
      el.append(mark, text);
      box.append(el);
      continue;
    }
    const el = h('div', 'cyc-snippet-p');
    setFormatted(el, line);
    box.append(el);
  }
  return box;
}

function renderSnippetDiff(content: string): HTMLElement {
  const pre = snippetCodePre(' cyc-snippet-diff');
  for (const line of content.split('\n')) {
    const cls =
      line.startsWith('+') && !line.startsWith('+++')
        ? 'cyc-diff-add text-[#3a9c56]'
        : line.startsWith('-') && !line.startsWith('---')
          ? 'cyc-diff-del text-[#cf3c3c]'
          : line.startsWith('@@')
            ? 'cyc-diff-hunk text-[var(--cyc-text-muted)]'
            : '';
    const el = h('span', cls);
    el.textContent = line + '\n';
    pre.append(el);
  }
  return pre;
}

export function snippetMessage(
  m: CycMessage,
  first: boolean,
  last: boolean,
  onOpenFile?: (m: CycMessage) => void
): HTMLDivElement {
  const f = m.file!;
  const out = m.role === 'user';
  const messageNode = createMessageNode(out, first, last, ' cyc-snippet-message');
  const wrapper = messageFrameEl();
  const content = h('div', 'cyc-message-content ' + MESSAGE_CONTENT_UTILS);

  const message = h('div', 'cyc-message-text ' + MESSAGE_TEXT_UTILS + ' text-[length:14px] pb-1');

  const caption = m.text.trim();
  if (caption) {
    const cap = h('div', 'cyc-snippet-caption mb-1');
    setFormatted(cap, caption);
    message.append(cap);
  }

  const body = f.content ?? '';
  message.append(
    f.fileKind === 'diff'
      ? renderSnippetDiff(body)
      : f.fileKind === 'markdown'
        ? renderSnippetMarkdown(body)
        : (() => {
            const pre = snippetCodePre();
            pre.textContent = body;
            return pre;
          })()
  );

  const footer = h('div', 'cyc-snippet-foot mt-0.5');
  const nameBtn = h(
    'button',
    'cyc-snippet-open text-[var(--cyc-accent)] text-[0.8125rem]! cursor-pointer'
  );
  nameBtn.textContent = f.name;
  nameBtn.addEventListener('click', () => onOpenFile?.(m));
  footer.append(nameBtn);
  message.append(footer);

  message.append(flowStamp(m));
  content.append(message);
  wrapper.append(content);
  messageNode.append(wrapper);
  return messageNode;
}

export function fileMessage(
  m: CycMessage,
  first: boolean,
  last: boolean,
  onOpenFile?: (m: CycMessage) => void
): HTMLDivElement {
  const f = m.file!;
  const out = m.role === 'user';
  const messageNode = createMessageNode(out, first, last, ' cyc-doc-message cyc-one-document');
  const wrapper = docFrameEl();
  const content = h('div', 'cyc-message-content ' + MESSAGE_CONTENT_UTILS);
  const message = h('div', 'cyc-message-text ' + MESSAGE_TEXT_UTILS + ' text-[length:14px]');

  const container = h('div', 'cyc-doc-box');
  const docWrapper = h('div', 'cyc-doc-wrap');

  const dot = f.name.lastIndexOf('.');
  const ext = (dot > 0 ? f.name.slice(dot + 1) : f.fileKind).toLowerCase().slice(0, 4) || 'file';

  const doc = h('div', `cyc-doc cyc-ext-${ext} my-2 ${DOC_CHAT_UTILS}`);
  const ico = h('div', 'cyc-doc-ico ' + DOC_ICO_UTILS);
  paintDocIcon(ico, ext, false);
  const icoText = h('span', 'cyc-doc-ico-text');
  icoText.textContent = ext;
  ico.append(icoText);
  const nameDiv = h('div', 'cyc-doc-name ' + DOC_NAME_UTILS);
  nameDiv.textContent = f.name;
  const sizeDiv = h('div', 'cyc-doc-size ' + DOC_SIZE_UTILS);
  sizeDiv.textContent = formatBytes(f.size);
  doc.append(ico, nameDiv);
  docWrapper.append(doc);

  const captionText = m.text.trim() !== f.name ? m.text.trim() : '';
  if (captionText) {
    // The stamp rides the caption's last line (or its own line under a long one).
    const caption = h('div', 'cyc-doc-message mt-[-0.125rem]');
    const captionInner = h('div', '');
    setFormatted(captionInner, captionText);
    captionInner.append(flowStamp(m));
    caption.append(captionInner);
    docWrapper.append(caption);
  }
  // A lone card carries the stamp at the inline end of its size row.
  doc.append(docFootRow(sizeDiv, captionText ? null : footStamp(m)));
  container.append(docWrapper);
  message.append(container);

  if (onOpenFile) doc.addEventListener('click', () => onOpenFile(m));

  content.append(message);
  wrapper.append(content);
  messageNode.append(wrapper);
  return messageNode;
}

export function downloadMessage(
  m: CycMessage,
  first: boolean,
  last: boolean,
  onOpenFile?: (m: CycMessage) => void
): HTMLDivElement {
  const f = m.file!;
  const out = m.role === 'user';
  const messageNode = createMessageNode(out, first, last, ' cyc-doc-message cyc-one-document');
  const wrapper = docFrameEl();
  const content = h('div', 'cyc-message-content ' + MESSAGE_CONTENT_UTILS);
  const message = h('div', 'cyc-message-text ' + MESSAGE_TEXT_UTILS + ' text-[length:14px]');

  const container = h('div', 'cyc-doc-box');
  const docWrapper = h('div', 'cyc-doc-wrap');

  const dot = f.name.lastIndexOf('.');
  const ext = (dot > 0 ? f.name.slice(dot + 1) : 'file').toLowerCase().slice(0, 4) || 'file';

  const doc = h(
    'div',
    `cyc-doc cyc-ext-${ext} cyc-download-card my-2 ${DOC_CHAT_UTILS} relative box-border rounded-md pe-11 bg-[var(--cyc-surface)] border border-[color:var(--cyc-border-color,rgba(127,127,127,0.22))]`
  );
  const ico = h('div', 'cyc-doc-ico ' + DOC_ICO_UTILS);
  paintDocIcon(ico, ext, false);
  const icoText = h('span', 'cyc-doc-ico-text');
  icoText.textContent = ext;
  ico.append(icoText);
  const nameDiv = h('div', 'cyc-doc-name ' + DOC_NAME_UTILS);
  nameDiv.textContent = f.name;
  const sizeDiv = h('div', 'cyc-doc-size ' + DOC_SIZE_UTILS);
  sizeDiv.textContent = formatBytes(f.size);

  const dl = makeIconButton(
    'download',
    'cyc-download-btn absolute! end-1.5 top-1/2 -translate-y-1/2 w-8 h-8'
  );
  paintOnTheme(dl, Object.values(MEDIA_SECONDARY_TEXT), (t) => MEDIA_SECONDARY_TEXT[t]);
  dl.title = 'Download';
  dl.setAttribute('aria-label', 'Download');
  doc.append(ico, nameDiv);
  docWrapper.append(doc);

  const captionText = m.text.trim() !== f.name ? m.text.trim() : '';
  if (captionText) {
    // The stamp rides the caption's last line (or its own line under a long one).
    const caption = h('div', 'cyc-doc-message mt-[-0.125rem]');
    const captionInner = h('div', '');
    setFormatted(captionInner, captionText);
    captionInner.append(flowStamp(m));
    caption.append(captionInner);
    docWrapper.append(caption);
  }
  // A lone card carries the stamp at the inline end of its size row (inside the
  // card's `pe-11`, clear of the download button).
  doc.append(docFootRow(sizeDiv, captionText ? null : footStamp(m)), dl);
  container.append(docWrapper);
  message.append(container);

  if (onOpenFile) {
    doc.addEventListener('click', () => onOpenFile(m));

    dl.addEventListener('click', (e) => {
      e.stopPropagation();
      onOpenFile(m);
    });
  }

  content.append(message);
  wrapper.append(content);
  messageNode.append(wrapper);
  return messageNode;
}
