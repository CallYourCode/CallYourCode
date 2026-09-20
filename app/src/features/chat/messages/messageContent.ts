import type {CycMessage, CycReplyTo} from '@/types';
import {REPLY_EXCERPT_LIMIT} from '@/types';
import {h} from '@/components/domHelpers';
import {makeIcon} from '@/components/iconGlyphs';
import type {CycIconName} from '@/components/iconGlyphs';
import {fmtTime} from '@/features/chat/content';
import {tickGlyph} from '@/features/chat/content';
import {previewText} from '@/features/chat/content';
import {setFormatted, formatInline} from '@/features/chat/content';
import {markMissingOnError, reserveMediaBox, setTunnelSrc} from '@/features/media/mediaBox';
import {applyQuoteDecor} from '@/features/chat/quoteDecor';
import {messageFrameEl, applyMessageState} from './messageFrame';

// Shared content layout for message bubbles.
export const MESSAGE_CONTENT_UTILS =
  'relative z-[1] max-w-full min-w-14 select-none rounded-2xl bg-[var(--cyc-bubble-in-surface)] shadow-sm [.cyc-msg-sent_&]:ml-auto [.cyc-media-tile_&]:w-min [.cyc-message.cyc-msg-media-only_&]:bg-transparent! [.cyc-message.cyc-msg-media-only_&]:shadow-none';

// Shared text-body layout. The trailing `after:` clear keeps the floated stamp
// (flowStamp) inside the body so the bubble's bottom margin sits under it; the
// multipart body is a flex column (composer.css), where the stamp is a flex item
// and a generated ::after would only add a gap, so it is suppressed there.
export const MESSAGE_TEXT_UTILS =
  'relative mx-2.5 my-1.5 max-w-full whitespace-pre-wrap [unicode-bidi:plaintext] [word-break:break-word] leading-[var(--cyc-line-height)] text-[var(--cyc-text)]' +
  " after:content-[''] after:block after:clear-both [.cyc-message.cyc-multipart_&]:after:content-none";

// onto every service row (dates, session events, empty/earlier pills).
export const SERVICE_MSG_UTILS = 'self-center justify-center';

// transparent (important, to beat the base --cyc-bubble-in-surface fill), drops
// its shadow and centers. The corner radius stays governed by the shared shell
// `html body .cyc-message-content{border-radius:6px!}` residual.
export const SERVICE_CONTENT_UTILS =
  MESSAGE_CONTENT_UTILS + ' bg-transparent! shadow-none! mx-auto';

// Compact reply metadata uses the app's normal small-text rhythm rather than the
// message renderer's inherited typography scale.
const REPLY_LINE = 'relative text-sm leading-5 whitespace-nowrap text-ellipsis overflow-hidden';

// Message timestamp parts and placements.
const STAMP_ACT_UTILS =
  // Caption-less media keeps its metadata deliberately quiet.
  'cyc-stamp-act relative inline-flex cursor-pointer items-center border-0 bg-none p-0 me-1 text-[length:inherit] leading-none text-inherit opacity-70 active:opacity-100 [.cyc-message.cyc-msg-media-only_&]:hidden ' +
  "after:content-[''] after:absolute after:-inset-1";

function stampActBtn(name: CycIconName, act: string, label: string): HTMLButtonElement {
  const b = h('button', STAMP_ACT_UTILS, {'data-act': act, title: label, 'aria-label': label});
  b.append(makeIcon(name));
  return b;
}

function buildStampParts(m: CycMessage): (HTMLElement | string)[] {
  const parts: (HTMLElement | string)[] = [];
  if (m.text.trim().length > 0) {
    parts.push(stampActBtn('copy', 'copy', 'Copy'), stampActBtn('quote', 'quote', 'Quote'));
  }
  parts.push(fmtTime(m.ts));
  if (m.role === 'user') {
    const glyph = tickGlyph(m);
    parts.push(
      makeIcon(
        glyph,
        'cyc-stamp-status ms-1 text-sm leading-none text-[var(--cyc-bubble-status)]' +
          (glyph === 'deliveryPending' ? ' cyc-stamp-clock' : '')
      )
    );
  }
  return parts;
}

// Shared timestamp layout.
const STAMP_BOX =
  'cyc-stamp z-[1] inline-flex items-center gap-1 cursor-pointer select-none whitespace-nowrap' +
  ' text-[11px] leading-4 text-[var(--cyc-bubble-time)] [pointer-events:all]';

// Timestamp placement for flowing message bodies (text, captions, transcripts).
// The stamp floats at the inline end of its host (the Telegram/WhatsApp shape):
// a short last line wraps around it and it sits on that line at the edge; a long
// last line pushes it onto its own line, still at the inline end. The host's
// trailing clear (MESSAGE_TEXT_UTILS) keeps it inside the bubble. `mt-[3px]`
// rests its 16px box on the bottom of an 18-20px text line. `self-end` is for
// the multipart body, a flex column where floats do not apply.
export function flowStamp(m: CycMessage): HTMLSpanElement {
  const t = h('span', STAMP_BOX + ' cyc-stamp-flow ms-2 float-end self-end mt-[3px]');
  t.append(...buildStampParts(m));
  return t;
}

// Timestamp placement for document cards: the last item of the card's size row
// (docFootRow), pushed to the inline end. The row reserves the stamp's width, so
// it sits beside the size text and never paints over it.
export function footStamp(m: CycMessage): HTMLSpanElement {
  const t = h('span', STAMP_BOX + ' cyc-stamp-foot ms-auto ps-2 shrink-0');
  t.append(...buildStampParts(m));
  return t;
}

// The bottom row of a document card: the size line plus, when the card has no
// caption to carry the stamp, the stamp at the row's inline end.
export function docFootRow(sizeDiv: HTMLElement, stamp: HTMLElement | null): HTMLDivElement {
  const row = h('div', 'cyc-doc-foot flex items-end min-w-0');
  sizeDiv.classList.add('min-w-0');
  row.append(sizeDiv);
  if (stamp) row.append(stamp);
  return row;
}

export function replyPanel(r: CycReplyTo, inComposer = false): HTMLDivElement {
  const container = h(
    'div',
    'cyc-reply cyc-callout-surface cyc-callout-rail cursor-pointer' +
      ' block text-sm min-h-12 whitespace-normal overflow-hidden relative' +
      ' [.cyc-message_&]:m-2' +
      ' fine:hover:bg-[color-mix(in_srgb,rgb(var(--cyc-sender-rgb))_16%,transparent)]!' +
      ' fine:active:bg-[color-mix(in_srgb,rgb(var(--cyc-sender-rgb))_16%,transparent)]!' +
      (r.quote ? ' cyc-callout-marked cyc-multiline' : '')
  );
  // The inner text column: `block`, clipped, non-interactive (the card itself owns the
  // click), inset 0.5rem (ms-2) off the accent rail with `3px 0` block padding and a
  // 0.375rem trailing gutter (py-[3px] ps-0 pe-1.5) so the copy clears the rail and the
  // quote mark.
  const content = h(
    'div',
    'cyc-reply-content block relative overflow-hidden pointer-events-none ms-3 py-1 pe-2'
  );
  // Title: the unconditional sender-colour tint, read from --cyc-sender-rgb directly
  // (so out-of-row titles keep the sender colour too) plus the shared single-line
  // REPLY_LINE clamp; a quote excerpt pads the trailing edge
  // (`[.cyc-callout-marked_&]:pe-3.5`) to clear the quote mark.
  const title = h(
    'div',
    `cyc-reply-title text-[rgb(var(--cyc-sender-rgb))] ${REPLY_LINE}` +
      ' [.cyc-callout-marked_&]:pe-3.5'
  );

  title.textContent = inComposer
    ? r.quote
      ? `Reply to quote by ${r.title}`
      : `Reply to ${r.title}`
    : r.title;
  // Subtitle: the shared REPLY_LINE clamp; on the quote path `cyc-multiline` relaxes it
  // to wrap the excerpt (white-space:unset / word-break:break-word / overflow:unset).
  // These relax legs are arbitrary-property literals because Tailwind's `break-words`
  // is `overflow-wrap`, not `word-break:break-word`.
  const subtitle = h(
    'div',
    `cyc-reply-subtitle ${REPLY_LINE}` +
      ' [.cyc-multiline_&]:[white-space:unset] [.cyc-multiline_&]:[word-break:break-word]' +
      ' [.cyc-multiline_&]:[overflow:unset]'
  );

  subtitle.innerHTML = formatInline(previewText(r.text, REPLY_EXCERPT_LIMIT));
  content.append(title, subtitle);
  container.append(content);
  applyQuoteDecor(container);
  return container;
}

export function messageClasses(out: boolean, last: boolean): string {
  return (
    'cyc-message relative z-[1] mx-auto flex flex-wrap select-none' +
    // Group-last rows carry the larger group-ending gap.
    (last ? ' mb-2' : ' mb-1') +
    (out
      ? ' cyc-msg-sent flex-row-reverse' +
        ' [&_.cyc-code-frame]:[--cyc-accent:var(--cyc-bubble-out-code-ink)]' +
        ' [&_.cyc-code-frame]:[--cyc-accent-rgb:var(--cyc-bubble-out-code-ink-rgb)]'
      : ' cyc-msg-received')
  );
}

export function messageHighlightEl(): HTMLDivElement {
  return h(
    'div',
    [
      'cyc-msg-highlight pointer-events-none absolute left-1/2 z-[-1] block w-screen opacity-0',
      '-translate-x-1/2 top-[-0.125rem] bottom-[-0.125rem]',
      '[[data-cyc-last]_&]:bottom-[-0.25rem]',
      '[[data-cyc-first]_&]:top-[-0.25rem]',
      '[[data-cyc-unread]_&]:top-[calc(0.125rem+32px)]'
    ].join(' ')
  );
}

export function attachMessageHighlight(node: HTMLElement): void {
  if (node.classList.contains('cyc-date-chip')) return;
  if (node.querySelector(':scope > .cyc-msg-highlight')) return;
  node.prepend(messageHighlightEl());
}

export function unreadBannerEl(): HTMLDivElement {
  const el = h(
    'div',
    [
      'cyc-msg-unread relative z-[2] mb-[0.25rem] h-[32px] w-[200vw] -mx-[50%]',
      'desk:w-[300vw] desk:-mx-[100vw]',
      'text-center text-[15px] leading-[2] font-medium text-(--cyc-accent) bg-(--cyc-surface)'
    ].join(' ')
  );
  el.textContent = 'Unread Messages';
  return el;
}

export function queuedBannerEl(label: string): HTMLDivElement {
  const el = h(
    'div',
    [
      'cyc-msg-queued relative z-[2] mb-2 h-[26px] w-[200vw] -mx-[50%]',
      'desk:w-[300vw] desk:-mx-[100vw]',
      'text-center text-[13px] leading-[2.1] font-medium text-(--cyc-text-muted) bg-(--cyc-surface)'
    ].join(' ')
  );
  el.textContent = label;
  return el;
}

// Bubble ink remaps. Frame max-width is inherited from the list.
export function applyMessageRootVars(node: HTMLElement): void {
  const s = node.style;
  s.setProperty('--cyc-line-height', '1.3');
  s.setProperty('--cyc-accent', 'var(--cyc-bubble-ink)');
  s.setProperty('--cyc-accent-rgb', 'var(--cyc-bubble-ink-rgb)');
  s.setProperty('--cyc-text-muted', 'var(--cyc-bubble-status)');
  s.setProperty('--cyc-sender-rgb', 'var(--cyc-bubble-ink-rgb)');
}

// Sent-row bubble tokens point at the outgoing palette.
export function applyOutMessageVars(node: HTMLElement): void {
  const s = node.style;
  s.setProperty('--cyc-bubble-in-surface', 'var(--cyc-bubble-out-surface)');
  s.setProperty('--cyc-bubble-glyph', 'var(--cyc-bubble-out-glyph)');
  s.setProperty('--cyc-bubble-ink', 'var(--cyc-bubble-out-ink)');
  s.setProperty('--cyc-bubble-ink-rgb', 'var(--cyc-bubble-out-ink-rgb)');
  s.setProperty('--cyc-bubble-time', 'var(--cyc-bubble-out-time)');
  s.setProperty('--cyc-bubble-status', 'var(--cyc-bubble-out-status)');
  s.setProperty('--cyc-link-color', 'var(--cyc-bubble-ink)');
}

export function createMessageNode(
  out: boolean,
  first: boolean,
  last: boolean,
  extra = ''
): HTMLDivElement {
  const node = h('div', messageClasses(out, last) + extra);
  applyMessageState(node, first, last);
  applyMessageRootVars(node);
  if (out) applyOutMessageVars(node);
  attachMessageHighlight(node);
  return node;
}

export function setMessageReply(
  messageNode: HTMLElement,
  content: HTMLElement,
  m: CycMessage
): void {
  if (!m.replyTo) return;
  messageNode.classList.add('cyc-has-reply');
  content.prepend(replyPanel(m.replyTo));
}

export function textMessage(
  m: CycMessage,
  first: boolean,
  last: boolean,
  onPlay?: (m: CycMessage, el: HTMLElement) => void
): HTMLDivElement {
  const out = m.role === 'user';
  const messageNode = createMessageNode(out, first, last, ' cyc-text-message');
  const wrapper = messageFrameEl();
  const content = h('div', 'cyc-message-content ' + MESSAGE_CONTENT_UTILS);

  // the trailing text-[14px]; every other body inherits the 16px base.
  const message = h('div', 'cyc-message-text ' + MESSAGE_TEXT_UTILS + ' text-[14px]');
  setFormatted(message, m.text);

  if (m.scheduled) {
    const from = h('div', 'cyc-msg-scheduled mb-0.5 flex items-center gap-1 text-xs opacity-75');
    from.append(makeIcon('deliveryPending'), document.createTextNode(`Scheduled: ${m.scheduled}`));
    message.prepend(from);
  }

  const msgId = (m as CycMessage & {msgId?: string}).msgId;
  if (onPlay && m.role === 'claude' && msgId) {
    const play = h(
      'button',
      [
        'cyc-msg-play float-start w-9 h-9 me-[0.5625rem] my-0.5 rounded-full cursor-pointer',
        'flex items-center justify-center bg-[var(--cyc-accent)]! text-white text-[1.125rem]!',
        'active:opacity-85',
        '[&.cyc-pending]:relative [&.cyc-pending]:text-transparent!',
        "[&.cyc-pending]:after:content-[''] [&.cyc-pending]:after:absolute [&.cyc-pending]:after:inset-[10%]",
        '[&.cyc-pending]:after:rounded-full [&.cyc-pending]:after:border-[2.5px] [&.cyc-pending]:after:border-solid',
        '[&.cyc-pending]:after:border-[rgba(var(--cyc-accent-rgb,51,144,236),0.3)] [&.cyc-pending]:after:border-t-(--cyc-accent)',
        '[&.cyc-pending]:after:[animation:cyc-spin_0.8s_linear_infinite]'
      ].join(' '),
      {'data-msg-id': msgId, title: 'Play'}
    );
    play.append(makeIcon('play'));
    play.addEventListener('click', () => onPlay(m, play));
    message.prepend(play);
  }
  if (out && m.status === 'failed') message.append(sendFailedNote(m));
  message.append(flowStamp(m));
  content.append(message);
  setMessageReply(messageNode, content, m);
  wrapper.append(content);
  messageNode.append(wrapper);
  return messageNode;
}

// The progress line under a pending upload (a voice note or an attachment
// send moving its bytes over the transfer queue). It doubles as the cancel:
// the whole line is a button, "sending NN%" with an X beside it, and the tap
// is delegated (messageMenu.ts) the same way the failed note's retry is. The
// percentage repaints in place through the inner text span (messageList
// patches `.cyc-send-progress-text`), so the X survives every chunk tick.
export const CANCEL_SEND_CLASS = 'cyc-send-cancel';
export function sendProgressText(pct: number): string {
  return `sending ${Math.round(pct * 100)}%`;
}
export function sendProgressNode(pct: number): HTMLButtonElement {
  const prog = h(
    'button',
    `cyc-send-progress ${CANCEL_SEND_CLASS}` +
      ' flex items-center gap-1.5 mt-1.5 border-0 bg-none p-0 text-start' +
      ' text-[0.8125rem] opacity-70 cursor-pointer',
    {type: 'button', title: 'Cancel upload'}
  );
  const label = h('span', 'cyc-send-progress-text');
  label.textContent = sendProgressText(pct);
  prog.append(label, makeIcon('close'));
  return prog;
}

// The red line under a send the engine refused (a nack, an unknown session):
// the reason the engine gave, and the tap that owes the send again. The tap
// is delegated (messageMenu.ts): the note names the row, the list retries it.
export const SEND_FAILED_CLASS = 'cyc-send-failed';
export function sendFailedCopy(m: CycMessage): string {
  return m.failReason
    ? `not delivered: ${m.failReason}. Tap to try again`
    : 'not delivered. Tap to try again';
}
function sendFailedNote(m: CycMessage): HTMLButtonElement {
  const note = h(
    'button',
    SEND_FAILED_CLASS +
      ' flex items-center gap-1.5 mt-1.5 border-0 bg-none p-0 text-start text-[0.8125rem] text-[color:var(--cyc-danger)] cursor-pointer',
    {type: 'button', title: 'Try again'}
  );
  note.append(makeIcon('deliveryFailed'), sendFailedCopy(m));
  return note;
}

export function photoMessage(
  m: CycMessage,
  first: boolean,
  last: boolean,
  src: string,
  alt: string,
  onOpen?: (m: CycMessage) => void,
  dims?: {width?: number; height?: number}
): HTMLDivElement {
  const out = m.role === 'user';
  const caption = m.text.trim() === alt ? '' : m.text.trim();
  const messageNode = createMessageNode(
    out,
    first,
    last,
    ' cyc-media-tile' + (caption ? '' : ' cyc-msg-media-only')
  );
  const wrapper = messageFrameEl();
  const content = h('div', 'cyc-message-content ' + MESSAGE_CONTENT_UTILS);
  const message = h('div', 'cyc-message-text ' + MESSAGE_TEXT_UTILS + ' text-[length:14px]');
  const media = h(
    'div',
    'cyc-annex cyc-media-box block! relative w-[min(20rem,62vw)]! overflow-hidden [font-size:0] max-h-[min(400px,100%)]! bg-[#000]! cursor-pointer border border-[color:var(--cyc-bubble-in-surface)]'
  );
  reserveMediaBox(media, dims?.width, dims?.height);
  const img = markMissingOnError(
    h(
      'img',
      'cyc-still static! block w-full h-auto object-contain! cursor-pointer [image-orientation:from-image] [.cyc-message.cyc-msg-media-only_&]:object-contain'
    ) as HTMLImageElement
  );

  setTunnelSrc(img, src);
  img.alt = alt;
  img.loading = 'lazy';
  media.append(img);
  media.addEventListener('click', () => onOpen?.(m));
  message.append(media);
  if (caption) {
    // The stamp rides the caption's last line (or its own line under a long one).
    const cap = h('div', 'caption max-w-[min(20rem,62vw)] mt-1');
    setFormatted(cap, caption);
    cap.append(flowStamp(m));
    message.append(cap);
  } else {
    message.append(flowStamp(m));
  }
  content.append(message);
  wrapper.append(content);
  messageNode.append(wrapper);
  return messageNode;
}
