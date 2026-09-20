import type {CycAsk} from '../types';
import {h} from '../components/domHelpers';

type AskPanelOpts = {
  onAnswer: (fingerprint: string, choice: number) => void;
};

type AskPanel = {
  el: HTMLElement;

  update: (ask: CycAsk | null | undefined, unknown: boolean, sessionId: string | null) => void;

  result: (ok: boolean, reason?: string, detail?: string) => void;
};

const MAY_HAVE_LANDED = new Set(['unconfirmed', 'unreadable', 'no-word']);

const SENDING_TIMEOUT_MS = 8000;

function t<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: string,
  attrs?: Record<string, string>
): HTMLElementTagNameMap[K] {
  const el = h(tag, className, attrs);
  el.textContent = text;
  return el;
}

const ASK_QUESTION_UTILS = 'cyc-ask-question mb-1.5 font-medium text-[var(--cyc-danger)]';
const ASK_NOTE_UTILS =
  'cyc-ask-note mt-2 text-[var(--cyc-text-muted)] text-[0.8125rem] leading-[1.35]';

export function createAskPanel(opts: AskPanelOpts): AskPanel {
  const el = h(
    'div',
    [
      'cyc-ask cyc-off relative z-[2] py-2.5 px-3 self-stretch w-full max-w-full min-w-0 box-border',
      'border-b border-[var(--cyc-border-color,rgba(127,127,127,0.25))]',
      'max-h-[45vh] overflow-y-auto overscroll-contain'
    ].join(' ')
  );
  let current: CycAsk | null = null;
  let sending = 0;
  let sendingTimer = 0;
  let note = '';

  let noteOwner: {session: string | null; fingerprint: string} | null = null;

  let pendingOwner: {session: string | null; fingerprint: string} | null = null;

  let locked = false;
  let currentSession: string | null = null;

  let unknownNow = false;

  const clearSending = () => {
    sending = 0;
    if (sendingTimer) {
      clearTimeout(sendingTimer);
      sendingTimer = 0;
    }
  };

  function paint(unknown: boolean) {
    unknownNow = unknown;
    el.textContent = '';
    if (!current && !unknown) {
      el.classList.add('cyc-off');
      return;
    }
    el.classList.remove('cyc-off');

    if (!current) {
      el.append(t('div', ASK_QUESTION_UTILS, 'This session is waiting for an answer'));
      el.append(
        t(
          'div',
          ASK_NOTE_UTILS,
          'The terminal is showing something this app could not read, so there is nothing to tap. Open the terminal for this session.'
        )
      );

      if (note)
        el.append(t('div', ASK_NOTE_UTILS + ' cyc-ask-note-bad text-[var(--cyc-danger)]!', note));
      return;
    }

    el.append(t('div', ASK_QUESTION_UTILS, current.question));

    if (current.context.length) {
      const ctx = h(
        'pre',
        [
          'cyc-ask-context mt-0 mx-0 mb-2 px-2 py-1.5 rounded-md box-border',
          'bg-[var(--cyc-text-muted-tint,rgba(127,127,127,0.12))] text-[var(--cyc-text-muted)]',
          'font-[family-name:JetBrains_Mono,monospace] text-[0.8125rem] leading-[1.35]',
          'max-h-48 max-w-full min-w-0 overflow-auto overscroll-contain whitespace-pre!'
        ].join(' ')
      );
      ctx.textContent = current.context.join('\n');
      el.append(ctx);
    }

    const choices = h('div', 'cyc-ask-choices flex flex-col gap-1');
    for (const c of current.choices) {
      const needsTerminal = c.freeText === true;
      const btn = h(
        'button',
        'cyc-ctl cyc-ask-choice flex flex-col items-start w-full min-h-10 px-3! py-2! rounded-lg ' +
          'bg-[var(--cyc-text-muted-tint,rgba(127,127,127,0.12))]! text-[var(--cyc-text)] ' +
          'text-start normal-case font-normal whitespace-normal [overflow-wrap:anywhere] max-w-full min-w-0 box-border' +
          (needsTerminal ? ' cyc-ask-choice-terminal opacity-55' : ''),
        {type: 'button'}
      );
      btn.append(t('span', 'cyc-ask-choice-label leading-[1.3]', c.label));
      if (needsTerminal)
        btn.append(
          t(
            'span',
            'cyc-ask-choice-detail text-[var(--cyc-text-muted)] text-[0.8125rem] leading-[1.3]',
            'needs the terminal'
          )
        );
      else if (c.detail)
        btn.append(
          t(
            'span',
            'cyc-ask-choice-detail text-[var(--cyc-text-muted)] text-[0.8125rem] leading-[1.3]',
            c.detail
          )
        );
      if (sending || needsTerminal || locked) btn.setAttribute('disabled', '');
      if (!needsTerminal && !locked) {
        btn.addEventListener('click', () => {
          if (sending || locked || !current) return;
          send(c.n);
        });
      }
      choices.append(btn);
    }
    el.append(choices);

    if (sending) el.append(t('div', ASK_NOTE_UTILS, 'Sending…'));
    else if (note)
      el.append(t('div', ASK_NOTE_UTILS + ' cyc-ask-note-bad text-[var(--cyc-danger)]!', note));
  }

  function send(choice: number) {
    if (!current || locked) return;
    sending = choice;
    note = '';
    noteOwner = null;

    pendingOwner = {session: currentSession, fingerprint: current.fingerprint};
    if (sendingTimer) clearTimeout(sendingTimer);
    sendingTimer = window.setTimeout(() => {
      clearSending();
      settleNote('No word back from the engine. Nothing may have been pressed.', 'no-word');
      paint(unknownNow);
    }, SENDING_TIMEOUT_MS);
    paint(unknownNow);
    opts.onAnswer(current.fingerprint, choice);
  }

  function settleNote(text: string, reason?: string) {
    note = text;
    noteOwner = pendingOwner ?? {session: currentSession, fingerprint: current?.fingerprint ?? ''};
    locked = !!reason && MAY_HAVE_LANDED.has(reason);
  }

  return {
    el,
    update(ask, unknown, sessionId) {
      const next = ask ?? null;

      const same =
        next && current && next.fingerprint === current.fingerprint && sessionId === currentSession;
      if (!same) clearSending();

      const blocked = !!next || unknown;
      const keepNote =
        !!noteOwner &&
        blocked &&
        noteOwner.session === sessionId &&
        (next ? next.fingerprint === noteOwner.fingerprint : true);
      if (!keepNote) {
        note = '';
        noteOwner = null;
      }

      if (next || !blocked || sessionId !== currentSession) locked = false;

      current = next;
      currentSession = sessionId;
      paint(unknown);
    },
    result(ok, reason, detail) {
      clearSending();

      if (ok) {
        note = '';
        noteOwner = null;
        locked = false;
      } else {
        settleNote(detail || refusal(reason), reason);
      }
      paint(unknownNow);
    }
  };
}

function refusal(reason?: string): string {
  switch (reason) {
    case 'vanished':
      return 'That question is gone; the session has moved on.';
    case 'changed':
      return 'The session is asking something else now.';
    case 'no-effect':
      return 'The session is still asking the same thing.';
    case 'unreadable':
      return "Could not read that session's screen.";

    case 'unconfirmed':
      return "The key was sent, but this session's screen could not be read to check it landed.";
    case 'gone':
      return 'That session is not running any more.';
    case 'needs-terminal':
      return 'That option opens a text field in the terminal, and this app cannot finish one yet.';
    default:
      return 'That answer was not sent.';
  }
}
