import './codeViewer.css';
import {h} from '../../components/domHelpers';
import {makeIconButton} from '../../components/iconGlyphs';
import {PANE_BACK_UTILS} from '@/features/sessions/components/paneHeader';
import {codeBlockElement} from '@/features/chat/content';
import {renderSyntaxBlocks, paintCodeBlocks} from '@/features/code/viewer';

let closeCurrent: (() => void) | null = null;

export function openCodeViewer(source: HTMLElement): void {
  closeCurrent?.();

  const isTable = source.classList.contains('cyc-snippet-table-box');

  // Overlay is selectable; chrome uses select-none.
  const overlay = h(
    'div',
    [
      'cyc-code-viewer absolute inset-0 z-[11] flex flex-col box-border select-text',
      'bg-[var(--cyc-background-color)] overscroll-contain',
      'pt-[var(--cyc-safe-top)] pb-[min(var(--cyc-safe-bottom),0.75rem)]'
    ].join(' ')
  );

  const header = h(
    'div',
    [
      'cyc-pane-header cyc-cv-header',
      'flex items-center justify-between px-4 min-h-14 flex-none cursor-default',
      'bg-[var(--cyc-surface)] border-b border-[var(--cyc-border-color)]'
    ].join(' ')
  );
  const back = makeIconButton('left', 'cyc-pane-back select-none ' + PANE_BACK_UTILS);
  const title = h(
    'div',
    [
      'cyc-title-container cyc-cv-title',
      'flex-auto min-w-0 overflow-hidden text-ellipsis whitespace-nowrap',
      'font-medium text-[length:1rem]'
    ].join(' ')
  );
  header.append(back, title);

  const body = h('div', 'cyc-cv-body flex-auto min-h-0 flex flex-col');

  let block: HTMLElement;
  if (isTable) {
    title.textContent = 'Table';

    block = source.cloneNode(true) as HTMLElement;
    block.classList.add('m-0', 'min-h-0', 'flex-auto', 'flex', 'flex-col');
    block
      .querySelector('.cyc-snippet-table-bar')
      ?.classList.add('shrink-0', 'px-2', 'pt-1', 'select-none');
    const wrap = block.querySelector('.cyc-snippet-table-wrap');
    wrap?.classList.add(
      'cyc-overflower',
      'min-h-0',
      'flex-auto',
      'overflow-auto',
      'max-w-none',
      'px-3',
      'pt-2.5',
      'pb-6'
    );
    block.querySelector('.cyc-snippet-table-fullscreen')?.remove();
  } else {
    const code = source.querySelector<HTMLElement>('.cyc-src-body');
    if (!code) return;
    const text = code.textContent || '';
    // The fence is carried on the block itself, so the rebuilt copy highlights the
    // same grammar regardless of what the caption reads.
    const fence = source.dataset.cycFence ?? '';
    const caption = source.querySelector<HTMLElement>('.cyc-src-head-name')?.textContent?.trim();

    title.textContent = caption || 'Code';

    block = codeBlockElement(text, fence);

    // `#cyc-app .cyc-code-viewer .cyc-code-frame/.cyc-src-pane/.cyc-src-body`
    // overrides: the block fills the body column and the code scrolls inside it.
    // `!` beats the wrap toggle so the fullscreen view always scrolls.
    block.classList.add('flex', 'flex-col', 'flex-auto', 'min-h-0', 'm-0!', 'rounded-none!');
    block.querySelector('.cyc-src-pane')?.classList.add('flex', 'flex-auto', 'min-h-0');
    block
      .querySelector('.cyc-src-body')
      ?.classList.add('flex-auto', 'min-h-0', 'overflow-auto!', 'px-3!', 'py-2.5!', 'pb-6!');
    block.querySelector('.cyc-src-head')?.classList.add('select-none');
    block.querySelector('.cyc-src-head-fullscreen')?.remove();
  }
  body.append(block);
  overlay.append(header, body);

  const close = () => {
    if (closeCurrent !== close) return;
    closeCurrent = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', onPop);
    overlay.remove();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const onPop = () => close();

  back.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('popstate', onPop);

  closeCurrent = close;

  (document.getElementById('cyc-stage') ?? document.body).append(overlay);

  renderSyntaxBlocks(body);
  paintCodeBlocks(body);
}
