import type {CycMessage, CycReplyTo, CycSession} from '@/types';
import {openMenu} from '@/components/popupMenu';
import {toast} from '@/components/widgets';
import {installTouchSelect} from '@/features/chat/touchSelection';
import {
  attachMessageHighlight,
  CANCEL_SEND_CLASS,
  SEND_FAILED_CLASS
} from '@/features/chat/messages/messageContent';
import {copyText} from '@/features/media/downloads';

const FLASH_FRAMES: Keyframe[] = [
  {opacity: '0', offset: 0},
  {opacity: '1', offset: 0.18},
  {opacity: '1', offset: 0.42},
  {opacity: '0', offset: 1}
];
const FLASH_TIMING: KeyframeAnimationOptions = {duration: 2000, easing: 'linear'};

const liveFlash = new WeakMap<HTMLElement, Animation>();

export const highlightMessage = (element: HTMLElement) => {
  attachMessageHighlight(element);
  const overlay = element.querySelector<HTMLElement>(':scope > .cyc-msg-highlight');
  if (!overlay) return;

  liveFlash.get(element)?.cancel();
  liveFlash.delete(element);

  overlay.style.setProperty('background-color', 'var(--cyc-bubble-flash)');
  if (typeof overlay.animate !== 'function') return;

  const flash = overlay.animate(FLASH_FRAMES, FLASH_TIMING);
  liveFlash.set(element, flash);
  flash.addEventListener('finish', () => {
    if (liveFlash.get(element) === flash) liveFlash.delete(element);
    overlay.style.removeProperty('background-color');
  });
};

// Resolve the message a rendered bubble stands for from the bubble's own
// data-mid: its one durable string id (fix-oneid). The id is unique within a
// session by construction (derived from the row's cid/mid, never a per-load
// number), so a single find by id names the exact bubble that was tapped. There
// is no (id, ts) disambiguator any more: the twin it existed to break cannot
// form once two bubbles can never share an id. data-ts stays on the node for
// display, never for resolution.
export const messageOfNode = (
  s: CycSession,
  node: HTMLElement | null | undefined
): CycMessage | undefined => {
  const id = node?.dataset.mid;
  if (!id) return undefined;
  return s.messages.find((m) => m.id === id);
};

export const selectionInMessage = (messageNode: HTMLElement): string | undefined => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return undefined;
  const text = sel.toString().trim();
  if (!text) return undefined;
  const range = sel.getRangeAt(0);
  const message = messageNode.querySelector('.cyc-message-text');
  if (!message) return undefined;
  const startIn = message.contains(range.startContainer);
  const endIn = message.contains(range.endContainer);
  if (!startIn || !endIn) return undefined;
  return text;
};

export type MessageMenuDeps = {
  messageListInner: HTMLElement;
  scroller: () => HTMLElement;
  active: () => CycSession | null | undefined;
  quoteInto: (s: CycSession, m: CycMessage, quote: string) => void;
  startReply: (s: CycSession, m: CycMessage) => void;
  jumpToReply: (r: CycReplyTo) => void;
  retrySend: (sessionId: string, msgId: string) => void;
  // Cancel of a pending upload (the progress line's own tap): abort the
  // transfer and settle the message per its kind (main.ts routes a voice
  // note's recording back to the composer, an attachment send is discarded).
  cancelSend: (sessionId: string, msgId: string) => void;

  removeMessage: (s: CycSession, m: CycMessage) => void;
  isTouch: boolean;
  onTeardown: (d: () => void) => void;
};

export function installMessageMenu(deps: MessageMenuDeps) {
  const {messageListInner, active, onTeardown} = deps;

  const openMessageMenu = (
    target: HTMLElement,

    at: {clientX: number; clientY: number; pageX: number; pageY: number}
  ) => {
    const s = active();
    if (!target.dataset.mid || !s) return;
    const m = messageOfNode(s, target);
    if (!m) return;
    openMenu(
      [
        ...(m.role === 'user' && m.status === 'failed'
          ? [
              {
                icon: 'refresh' as const,
                text: 'Try again',
                onClick: () => deps.retrySend(s.id, m.id)
              }
            ]
          : []),
        {icon: 'reply', text: 'Reply', onClick: () => deps.startReply(s, m)},
        {
          icon: 'delete' as const,
          text: 'Delete',
          danger: true,
          onClick: () => deps.removeMessage(s, m)
        }
      ],
      at as Touch,
      {triggerElement: target}
    );
  };

  if (!deps.isTouch) {
    const onContextMenu = (e: MouseEvent) => {
      const target = ((e.target as HTMLElement).closest?.('.cyc-message') ??
        null) as HTMLElement | null;
      if (!target) return;
      openMessageMenu(target, e);
    };
    messageListInner.addEventListener('contextmenu', onContextMenu);
    onTeardown(() => messageListInner.removeEventListener('contextmenu', onContextMenu));
  }

  if (deps.isTouch) {
    onTeardown(
      installTouchSelect({
        element: deps.scroller(),

        messageNodeOf: (t) => {
          const el = t as HTMLElement | null;
          if (!el?.closest?.('.cyc-message-content')) return null;
          const b = el.closest('.cyc-message') as HTMLElement | null;
          return b?.dataset.mid ? b : null;
        },

        isInteractive: (t) =>
          !!(t as HTMLElement)?.closest?.(
            'a, button, input, [contenteditable], .cyc-reply.cyc-callout-surface, ' +
              '.cyc-media-box, .cyc-doc, .cyc-clip-toggle, .cyc-signal-meter, ' +
              '.cyc-src-head'
          ),

        onMenu: (messageNode, at, selection) => {
          if (selection) return;
          openMessageMenu(messageNode, at);
        }
      })
    );

    const noNativeMenu = (e: Event) => {
      if ((e.target as HTMLElement)?.closest?.('.cyc-message')) e.preventDefault();
    };
    messageListInner.addEventListener('contextmenu', noNativeMenu);
    onTeardown(() => messageListInner.removeEventListener('contextmenu', noNativeMenu));
  }

  const holdSel = (e: Event) => {
    if ((e.target as HTMLElement)?.closest?.('.cyc-stamp-act')) e.preventDefault();
  };
  messageListInner.addEventListener('mousedown', holdSel);
  messageListInner.addEventListener('pointerdown', holdSel);
  onTeardown(() => {
    messageListInner.removeEventListener('mousedown', holdSel);
    messageListInner.removeEventListener('pointerdown', holdSel);
  });

  const onActClick = async (e: Event) => {
    const btn = (e.target as HTMLElement).closest?.('.cyc-stamp-act') as HTMLElement | null;
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();
    const messageNode = btn.closest('.cyc-message') as HTMLElement | null;
    const s = active();
    if (!messageNode?.dataset.mid || !s) return;
    const m = messageOfNode(s, messageNode);
    if (!m) return;
    const selected = selectionInMessage(messageNode);
    const text = selected ?? m.text;
    if (btn.dataset.act === 'copy') {
      if (await copyText(text)) toast(selected ? 'Selection copied' : 'Copied');
      else toast('Copy failed');
    } else {
      deps.quoteInto(s, m, text);
    }
  };
  messageListInner.addEventListener('click', onActClick);
  onTeardown(() => messageListInner.removeEventListener('click', onActClick));

  // The "not delivered" note under a refused send: the tap owes it again.
  const onRetryTap = (e: Event) => {
    const note = (e.target as HTMLElement).closest?.(`.${SEND_FAILED_CLASS}`);
    if (!note) return;
    e.preventDefault();
    e.stopPropagation();
    const messageNode = note.closest('.cyc-message') as HTMLElement | null;
    const s = active();
    if (!messageNode?.dataset.mid || !s) return;
    const m = messageOfNode(s, messageNode);
    if (!m || m.status !== 'failed') return;
    deps.retrySend(s.id, m.id);
  };
  messageListInner.addEventListener('click', onRetryTap);
  onTeardown(() => messageListInner.removeEventListener('click', onRetryTap));

  // The "sending NN%" line under a pending upload doubles as the cancel: the
  // tap cuts the transfer and settles the message (voice notes go back to the
  // composer; an attachment send is discarded whole).
  const onCancelTap = (e: Event) => {
    const line = (e.target as HTMLElement).closest?.(`.${CANCEL_SEND_CLASS}`);
    if (!line) return;
    e.preventDefault();
    e.stopPropagation();
    const messageNode = line.closest('.cyc-message') as HTMLElement | null;
    const s = active();
    if (!messageNode?.dataset.mid || !s) return;
    const m = messageOfNode(s, messageNode);
    if (!m || m.status !== 'sending') return;
    deps.cancelSend(s.id, m.id);
  };
  messageListInner.addEventListener('click', onCancelTap);
  onTeardown(() => messageListInner.removeEventListener('click', onCancelTap));

  messageListInner.addEventListener('click', (e) => {
    const panel = (e.target as HTMLElement).closest?.('.cyc-reply.cyc-callout-surface');
    if (!panel) return;
    const messageNode = panel.closest('.cyc-message.cyc-has-reply') as HTMLElement | null;
    const s = active();
    if (!messageNode?.dataset.mid || !s) return;
    const m = messageOfNode(s, messageNode);
    if (!m?.replyTo) return;
    deps.jumpToReply(m.replyTo);
  });

  return {openMessageMenu};
}
