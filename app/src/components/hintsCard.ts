import {h} from '../components/domHelpers';
import {makeIcon, makeIconButton} from '../components/iconGlyphs';

type IconName = Parameters<typeof makeIcon>[0];

const KEY = 'cyc-hints';

export function hintsDismissed(): boolean {
  const v = localStorage.getItem(KEY);
  return v === 'dismissed' || v === 'off';
}

const HINTS: {icon: IconName; text: string}[] = [
  {
    icon: 'add',
    text: 'Click the plus button over the list to start a new session.'
  },
  {
    icon: 'equalizer',
    text:
      'The lever in the message box sets how much you get back: written at ' +
      'one end, spoken at the other.'
  },
  {
    icon: 'phone',
    text: 'The call button turns on conversation mode: talk, and hear it answer.'
  },
  {
    icon: 'hand',
    text: 'The halt button stops a session right now. It is a ctrl+c.'
  },

  {
    icon: 'next',
    text: 'In a chat, swipe the messages left to reach the next agent waiting on you.'
  }
];

export function createHintsCard(options: {
  dismissible: boolean;
  headless?: boolean;
  onDismiss?: () => void;
}): HTMLElement {
  const el = h(
    'div',
    [
      'cyc-hints flex-none mx-2 mt-1.5 mb-4 px-2.5 pt-2 pb-[0.5625rem]',
      'bg-[var(--cyc-text-muted-tint)] text-xs leading-[1.4]'
    ].join(' ')
  );
  if (options.headless) el.classList.add('cyc-hints-headless');
  const head = h(
    'div',
    'cyc-hints-head mb-[0.3125rem] flex items-baseline gap-1.5 font-medium text-[var(--cyc-text-muted)]'
  );
  const title = h('span', 'cyc-hints-title min-w-0 flex-auto');
  title.textContent = 'Things worth knowing';
  head.append(title);

  if (options.dismissible) {
    const close = makeIconButton(
      'close',
      'cyc-hints-close flex-none self-center size-[1.375rem] text-[0.9375rem] text-[var(--cyc-text-muted)]'
    );
    close.title = 'Hide these';
    close.setAttribute('aria-label', 'Hide these hints');
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      localStorage.setItem(KEY, 'dismissed');

      options.onDismiss?.();
    });
    head.append(close);
  }

  if (!options.headless) el.append(head);

  const rows = h('div', 'cyc-hints-rows [display:grid] grid-cols-[auto_1fr] gap-x-2 gap-y-1.5');
  for (const hint of HINTS) {
    const row = h('div', 'cyc-hints-row contents');
    row.append(
      makeIcon(
        hint.icon,
        'cyc-hints-icon mt-[0.0625rem] self-start justify-self-center text-[1.0625rem] text-[var(--cyc-accent)]'
      )
    );
    const text = h('span', 'cyc-hints-text min-w-0 text-[var(--cyc-text)]');
    text.textContent = hint.text;
    row.append(text);
    rows.append(row);
  }
  el.append(rows);

  return el;
}
