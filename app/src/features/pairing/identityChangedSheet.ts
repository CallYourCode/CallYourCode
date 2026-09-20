import {h} from '@/components/domHelpers';
import {currentPresentationTheme, type PresentationTheme} from '@/components/presentation';

type IdentityChangedOpts = {user: string; host: string; onTrust: () => void};

const DIALOG_TEXT: Record<PresentationTheme, string> = {
  day: 'text-[#1c1c1e]',
  night: 'text-[#ededee]'
};
const DIALOG_BG: Record<PresentationTheme, string> = {
  day: 'bg-[#ece9e3]',
  night: 'bg-[#0d0d0e]'
};
const DIALOG_BOX_TRANSITION = 'transform 0.15s cubic-bezier(0.4, 0, 0.2, 1)';
const DIALOG_SHOW =
  'opacity 0.15s cubic-bezier(0.4, 0, 0.2, 1) 0s, visibility 0s cubic-bezier(0.4, 0, 0.2, 1) 0s';
const DIALOG_HIDE =
  'opacity 0.15s cubic-bezier(0.4, 0, 0.2, 1) 0s, visibility 0s cubic-bezier(0.4, 0, 0.2, 1) 0.15s';

export function openIdentityChangedSheet(opts: IdentityChangedOpts): HTMLDivElement {
  const userHost = `${opts.user}@${opts.host}`;
  const theme = currentPresentationTheme();
  const element = h(
    'div',
    'cyc-modal cyc-modal-dialog cyc-identity-sheet fixed inset-0 z-[15] m-0 flex overflow-auto bg-[rgba(0,0,0,0.3)] p-[1.875rem] text-[1rem] ' +
      DIALOG_TEXT[theme]
  );
  const container = h(
    'div',
    'cyc-modal-box cyc-elevation-low px-2 py-3 relative flex flex-col overflow-hidden [backface-visibility:hidden] m-auto w-[min-content] min-w-[min(100%,20rem)] max-w-[min(100%,24rem)] ' +
      DIALOG_BG[theme]
  );

  const header = h(
    'div',
    'cyc-modal-header relative m-0 flex h-10 w-max max-w-full flex-none items-center px-4'
  );
  const title = h(
    'div',
    [
      'cyc-modal-title m-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap pe-4',
      'text-[1.25rem] leading-[26px] font-medium'
    ].join(' ')
  );
  title.textContent = 'Engine identity changed';
  header.append(title);
  container.append(header);

  const desc = h(
    'p',
    [
      'cyc-modal-text my-0 min-w-[min(100%,15rem)] max-w-fit flex-none overflow-hidden',
      'text-ellipsis whitespace-pre-wrap px-4 pt-2.5 pb-2 leading-[var(--cyc-line-height)]',
      '[word-break:break-word]'
    ].join(' ')
  );
  desc.textContent =
    `${userHost} no longer matches the identity this app ` +
    'pinned: it was reinstalled, or someone is impersonating it.';
  container.append(desc);

  let closed = false;
  const hide = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    element.classList.add('hiding');
    element.classList.remove('active');
    element.style.opacity = '0';
    element.style.visibility = 'hidden';
    element.style.transition = DIALOG_HIDE;
    setTimeout(() => element.remove(), 250);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    hide();
  };

  const buttonsEl = h(
    'div',
    'cyc-modal-btns flex h-12 flex-none flex-row-reverse items-center justify-start px-2'
  );
  const cancel = h(
    'button',
    'cyc-sheet-btn cyc-ctl relative h-10 max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-2xl px-4! font-medium uppercase fine:hover:bg-(--cyc-text-muted-tint)! fine:active:bg-(--cyc-text-muted-tint)!'
  );
  cancel.append('Cancel');
  cancel.addEventListener('click', () => hide());

  const trust = h(
    'button',
    'cyc-sheet-btn cyc-ctl relative h-10 max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-2xl px-4! me-[0.625rem] font-medium uppercase primary fine:hover:bg-(--cyc-accent-tint)! fine:active:bg-(--cyc-accent-tint)!'
  );
  trust.append('Trust this engine');
  trust.addEventListener('click', () => {
    const onTrust = opts.onTrust;
    hide();
    onTrust();
  });
  buttonsEl.append(cancel, trust);

  container.append(buttonsEl);
  element.append(container);
  element.addEventListener('click', (e) => e.target === element && hide());

  element.style.opacity = '0';
  element.style.visibility = 'hidden';
  element.style.transition = DIALOG_HIDE;
  container.style.transform = 'translate3d(0, 3rem, 0)';
  container.style.transition = DIALOG_BOX_TRANSITION;

  document.body.append(element);
  document.addEventListener('keydown', onKeyDown, true);
  void element.offsetWidth;
  element.classList.add('active');
  element.style.opacity = '1';
  element.style.visibility = 'visible';
  element.style.transition = DIALOG_SHOW;
  container.style.transform = 'translate3d(0, 0, 0)';
  return element;
}
