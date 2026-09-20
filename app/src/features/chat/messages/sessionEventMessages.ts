import type {CycSessionEvent} from '@/types';
import {h} from '@/components/domHelpers';
import {setFormatted} from '@/features/chat/content';
import {paintPresentation, type Presentation} from '@/components/presentation';
import {SERVICE_CONTENT_UTILS, SERVICE_MSG_UTILS, attachMessageHighlight} from './messageContent';
import {paintServiceRowWidth} from './messageFrame';

let expandedSeUuid: string | null = null;

function revealExpanded(messageNode: HTMLElement) {
  requestAnimationFrame(() => {
    const sc = messageNode.closest<HTMLElement>('.cyc-overflow-y');
    if (!sc) return;
    const input = messageNode.closest('.cyc-thread')?.querySelector('.cyc-composer');
    const limit =
      (input ? input.getBoundingClientRect().top : sc.getBoundingClientRect().bottom) - 12;
    const overflow = messageNode.getBoundingClientRect().bottom - limit;
    if (overflow > 0) sc.scrollTop += overflow;
  });
}

type SePillEl = HTMLDivElement & {cycPaint?: (open: boolean) => void};

export const SERVICE_TEXT_UTILS =
  'flex items-center justify-center rounded-lg select-none text-center break-words whitespace-pre-wrap text-white bg-[var(--cyc-bubble-flash)] text-sm leading-5 px-3 py-1.5' +
  ' [&_i]:not-italic [&_a]:text-white! [&_a]:cursor-pointer [&_a]:font-medium' +
  ' [&_.cyc-who]:cursor-pointer [&_.cyc-who]:font-medium [&_b]:text-inherit' +
  ' [.cyc-has-reply_&]:cursor-pointer' +
  ' bg-[var(--cyc-service-bg)]! text-[var(--cyc-service-fg)]!' +
  ' [backdrop-filter:blur(10px)] [-webkit-backdrop-filter:blur(10px)]' +
  ' [.cyc-date-chip_&]:bg-[var(--cyc-surface)]! [.cyc-date-chip_&]:text-[var(--cyc-text)]!' +
  ' [.cyc-date-chip_&]:[border:1px_solid_var(--cyc-border-color)]' +
  ' [.cyc-date-chip_&]:[backdrop-filter:none] [.cyc-date-chip_&]:[-webkit-backdrop-filter:none]';

const SESSION_EVENT_TEXT =
  // Activity rows are secondary metadata between bubbles: tighter block padding
  // and line-height than the standalone service pills (dates, "No messages"),
  // so a run of them reads as a compact strip, not a band of air.
  '[.cyc-session-event_&]:py-1 [.cyc-session-event_&]:leading-4' +
  ' [.cyc-session-event_&]:text-[12px] [.cyc-session-event_&]:opacity-65 [.cyc-session-event_&]:block' +
  ' [.cyc-session-event_&]:text-left [.cyc-session-event_&]:whitespace-nowrap [.cyc-session-event_&]:overflow-hidden' +
  ' [.cyc-session-event_&]:text-ellipsis [.cyc-session-event_&]:cursor-pointer' +
  ' [.cyc-session-event.cyc-se-clamp_&]:whitespace-normal [.cyc-session-event.cyc-se-clamp_&]:[display:-webkit-box]' +
  ' [.cyc-session-event.cyc-se-clamp_&]:[-webkit-box-orient:vertical] [.cyc-session-event.cyc-se-clamp_&]:[-webkit-line-clamp:2]' +
  ' [.cyc-session-event.cyc-se-clamp_&]:pb-0 [.cyc-session-event.cyc-se-clamp_&]:[border-bottom:0.28125rem_solid_transparent]' +
  ' [.cyc-message.cyc-session-event.cyc-se-open_&]:whitespace-pre-line [.cyc-message.cyc-session-event.cyc-se-open_&]:block' +
  ' [.cyc-message.cyc-session-event.cyc-se-open_&]:overflow-visible [.cyc-message.cyc-session-event.cyc-se-open_&]:text-clip' +
  ' [.cyc-message.cyc-session-event.cyc-se-open_&]:[overflow-wrap:anywhere] [.cyc-message.cyc-session-event.cyc-se-open_&]:text-left';

const SE_INT_OVERRIDES =
  'mt-0.5! opacity-50! block! whitespace-nowrap! overflow-visible! [border-bottom:0]!';

// `.cyc-session-event .cyc-service-text` phone clamp width decision, owned here rather
// than a `@media`/`max-tab` rule: paintSessionEventClamp toggles the finite
// `cyc-se-clamp` marker on the pill / run-head node for the phone bucket and clears it
// for every wider bucket, matching the shared action-control size. The `[.cyc-session-event.cyc-se-clamp_&]:`
// clamp literals on the service-text bundle read the marker. The painter repaints while
// the node stays connected and is pruned once it detaches.
export function paintSessionEventClamp(el: HTMLElement): void {
  const run = (p: Presentation) => {
    el.classList.toggle('cyc-se-clamp', p.width === 'phone');
  };
  paintPresentation(el, run);
}

// A tiny outlined chip on an input pill saying WHERE the input came from, so an
// out-of-band input (a cron firing, one agent messaging this one) is not just
// visible but attributed. Only the engine-known sources get labelled: `cron`
// and `agent` (as "from <sender>"). Everything else, including a manually
// typed pane line, renders as a plain input with no chip.
const SOURCE_CHIP_UTILS =
  'cyc-se-source mr-1.5 inline-flex items-center rounded px-1 text-[10px] font-medium uppercase' +
  ' tracking-wide [border:1px_solid_currentColor] opacity-80 shrink-0 align-middle';

export function sourceChipLabel(source: string, sender?: string): string {
  if (source === 'agent') return sender ? `from ${sender}` : 'agent';
  if (source === 'cron') return 'cron';
  return source;
}

function sourceChip(ev: CycSessionEvent): HTMLElement | null {
  if (ev.kind !== 'prompt' || !ev.source) return null;
  if (ev.source !== 'cron' && ev.source !== 'agent') return null;
  const chip = h('span', SOURCE_CHIP_UTILS);
  chip.textContent = sourceChipLabel(ev.source, ev.sender);
  return chip;
}

function interruptLine(text: string): HTMLDivElement {
  const line = h(
    'div',
    'cyc-service-text cyc-se-int ' +
      SERVICE_TEXT_UTILS +
      ' ' +
      SESSION_EVENT_TEXT +
      ' ' +
      SE_INT_OVERRIDES
  );
  line.textContent = text;
  return line;
}

export function sessionEventMessage(
  ev: CycSessionEvent,
  interrupt?: CycSessionEvent
): HTMLDivElement {
  const messageNode: SePillEl = h(
    'div',
    `cyc-message cyc-msg-system cyc-session-event relative z-[1] mx-auto mb-0.5 [&.cyc-se-open]:mb-3 flex flex-wrap ${SERVICE_MSG_UTILS} cyc-se-${ev.kind}`
  );
  paintSessionEventClamp(messageNode);
  paintServiceRowWidth(messageNode);
  if (interrupt) messageNode.classList.add('cyc-se-interrupted');
  const content = h('div', 'cyc-message-content ' + SERVICE_CONTENT_UTILS);
  const msg = h('div', 'cyc-service-text ' + SERVICE_TEXT_UTILS + ' ' + SESSION_EVENT_TEXT);

  // the source chip is a stable sibling of the repainting text node, so the
  // open/close repaint below never wipes it
  const chip = sourceChip(ev);
  if (chip) msg.append(chip);
  const body = h('span', 'cyc-se-body');
  msg.append(body);

  const paint = (open: boolean) => {
    if (open) setFormatted(body, ev.text);
    else body.textContent = ev.text;
  };
  messageNode.cycPaint = paint;
  paint(ev.uuid === expandedSeUuid);
  content.append(msg);
  if (interrupt) content.append(interruptLine(interrupt.text));
  messageNode.append(content);
  attachMessageHighlight(messageNode);
  if (ev.uuid === expandedSeUuid) messageNode.classList.add('cyc-se-open');
  messageNode.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) return;
    const wasOpen = messageNode.classList.contains('cyc-se-open');

    document.querySelectorAll<SePillEl>('.cyc-session-event.cyc-se-open').forEach((el) => {
      el.classList.remove('cyc-se-open');
      el.cycPaint?.(false);
    });
    expandedSeUuid = wasOpen ? null : ev.uuid;
    if (!wasOpen) {
      messageNode.classList.add('cyc-se-open');
      paint(true);
      revealExpanded(messageNode);
    }
  });
  return messageNode;
}

export function sessionEventRunMessages(
  events: CycSessionEvent[],
  interrupt?: CycSessionEvent
): HTMLDivElement {
  const counts = new Map<string, number>();
  for (const ev of events) {
    const label = ev.tool ?? 'tool';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} x${n}`);
  const wrap = h('div', 'cyc-se-run [&.cyc-se-expanded]:mb-3');
  if (interrupt) wrap.classList.add('cyc-se-interrupted');
  const head = h(
    'div',
    'cyc-message cyc-msg-system cyc-session-event cyc-se-run-head relative z-[1] mx-auto mb-0.5 flex flex-wrap ' +
      SERVICE_MSG_UTILS
  );
  paintSessionEventClamp(head);
  paintServiceRowWidth(head);
  const headContent = h('div', 'cyc-message-content ' + SERVICE_CONTENT_UTILS);
  const headMsg = h(
    'div',
    'cyc-service-text cursor-pointer ' + SERVICE_TEXT_UTILS + ' ' + SESSION_EVENT_TEXT
  );
  headMsg.textContent = `${events.length} tool calls (${parts.join(', ')})`;
  headContent.append(headMsg);

  if (interrupt) headContent.append(interruptLine(interrupt.text));
  head.append(headContent);
  attachMessageHighlight(head);
  head.addEventListener('click', () => {
    const open = wrap.classList.toggle('cyc-se-expanded');
    if (open) revealExpanded(wrap);
  });
  const items = h('div', 'cyc-se-run-items hidden [.cyc-se-expanded_&]:block');
  items.append(
    ...events.map((ev, i) =>
      sessionEventMessage(ev, interrupt && i === events.length - 1 ? interrupt : undefined)
    )
  );
  wrap.append(head, items);
  return wrap;
}

// A maximal run of consecutive session events, of any mix of VISIBLE_EVENT
// kinds (prompt, reply, tool, compact, interrupt), folded into ONE expandable
// head. Modeled on sessionEventRunMessages (the pure-tool case) and reusing the
// same head/items/expand mechanism verbatim; only the head label differs and
// there is no trailing interrupt partner (an interrupt event is just a normal
// member of the folded run). Expanding reveals the same pills, same order, same
// content the surface would render individually.
export function sessionEventFoldMessages(events: CycSessionEvent[]): HTMLDivElement {
  const wrap = h('div', 'cyc-se-run [&.cyc-se-expanded]:mb-3');
  const head = h(
    'div',
    'cyc-message cyc-msg-system cyc-session-event cyc-se-run-head relative z-[1] mx-auto mb-0.5 flex flex-wrap ' +
      SERVICE_MSG_UTILS
  );
  paintSessionEventClamp(head);
  paintServiceRowWidth(head);
  const headContent = h('div', 'cyc-message-content ' + SERVICE_CONTENT_UTILS);
  const headMsg = h(
    'div',
    'cyc-service-text cursor-pointer ' + SERVICE_TEXT_UTILS + ' ' + SESSION_EVENT_TEXT
  );
  headMsg.textContent = `${events.length} background updates`;
  headContent.append(headMsg);
  head.append(headContent);
  attachMessageHighlight(head);
  head.addEventListener('click', () => {
    const open = wrap.classList.toggle('cyc-se-expanded');
    if (open) revealExpanded(wrap);
  });
  const items = h('div', 'cyc-se-run-items hidden [.cyc-se-expanded_&]:block');
  items.append(...events.map((ev) => sessionEventMessage(ev)));
  wrap.append(head, items);
  return wrap;
}

// Grow an existing fold in place: append the newly arrived same-day events to
// the fold's hidden items and re-title its head to the new run length. This is
// the incremental counterpart of sessionEventFoldMessages, used by the message
// list when a tail fold's run extends: without it the head's count froze while
// the new events accreted as loose pills below the stale fold (the tail-fold
// reuse stall), and those extra nodes leaked through their presentation
// painters. Returns false when `wrap` is not a fold node so the caller can fall
// back to a rebuild.
export function extendFold(wrap: HTMLElement, add: CycSessionEvent[]): boolean {
  const head = wrap.querySelector<HTMLElement>('.cyc-se-run-head .cyc-service-text');
  const items = wrap.querySelector<HTMLElement>('.cyc-se-run-items');
  if (!head || !items) return false;
  const total = items.childElementCount + add.length;
  items.append(...add.map((ev) => sessionEventMessage(ev)));
  head.textContent = `${total} background updates`;
  return true;
}

// `.cyc-date-veiled` is set by attachStickyDates (messageList.ts) while the
// chip's box overlaps the unread divider: the chip keeps its layout and
// stops painting, so the divider's text stays readable.
const DATE_MESSAGE_STICKY =
  'cyc-date-chip sticky top-[calc(var(--cyc-chat-pad-top)+0.25rem)] z-[2] pb-1 ' +
  'pointer-events-none font-medium [transform:translateZ(0)] [&.cyc-date-veiled]:invisible';

export function dateMessage(label: string): HTMLDivElement {
  const messageNode = h(
    'div',
    'cyc-message cyc-msg-system ' +
      DATE_MESSAGE_STICKY +
      ' mx-auto mb-0.5 flex flex-wrap ' +
      SERVICE_MSG_UTILS +
      ' max-w-[var(--cyc-chat-width)]'
  );
  const content = h('div', 'cyc-message-content ' + SERVICE_CONTENT_UTILS);
  const msg = h('div', 'cyc-service-text ' + SERVICE_TEXT_UTILS);
  msg.textContent = label;
  content.append(msg);
  messageNode.append(content);
  return messageNode;
}
