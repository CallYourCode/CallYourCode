import {touchCapable} from '@/shared/capabilities';
import type {CycMessage, CycReplyTo, CycSession} from '@/types';
import * as engine from '@/engine/store';
import {extendMessageWindow} from './messageList';
import {smoothScrollTo} from '@/shared/smoothScroll';
import {toast} from '@/components/widgets';
import {replyAuthor, replyTargetFor, replySource} from '@/replyModel';
import {active} from '@/sessionSelectors';
import {highlightMessage} from './messageMenu';

export type MessageRef = {ts: number; role: 'user' | 'claude'; seq?: number; id?: string};

// Escape a durable id for use inside a data-mid attribute selector. The modern
// spellings (`m:c:<cid>`, `m:<mid>`) are already selector-safe; only the legacy
// `m@ts|role|text` fallback can carry a quote. CSS.escape does it where present
// (absent in the jsdom test env), with a minimal quote/backslash fallback.
function escapeMid(id: string): string {
  const g = globalThis as unknown as {CSS?: {escape?: (s: string) => string}};
  return g.CSS?.escape ? g.CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
}

export function firstWords(text: string, n: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= n) return text;
  return words.slice(0, n).join(' ') + '…';
}

type TravelComposer = {
  el: HTMLElement;
  addQuote(quote: string, author: string, target: CycReplyTo): void;
  setReplyTo(target: CycReplyTo): void;
  focus(): void;
};

export interface MessageTravelDeps {
  composer: TravelComposer;
  messageListInner: HTMLElement;
  scroller(): HTMLElement;
  chatEl: HTMLElement;
  renderEarlier(): void;
  render(): void;
  openChat(id: string, after?: () => void): void;
  isChatViewOpen(): boolean;
}

export function createMessageTravel(deps: MessageTravelDeps) {
  const {composer, messageListInner} = deps;

  const quoteInto = (s: CycSession, m: CycMessage, quote: string) => {
    const capped = firstWords(quote, 25);
    const target = replyTargetFor(s, m, capped);
    replySource.set(target, m);
    composer.addQuote(capped, replyAuthor(s, m), target);

    if (!touchCapable) composer.focus();
  };

  const startReply = (s: CycSession, m: CycMessage, quote?: string) => {
    const target = replyTargetFor(s, m, quote);
    replySource.set(target, m);

    composer.setReplyTo(target);

    if (!touchCapable) composer.focus();
  };

  const jumpToMessage = (ts: number, role: 'user' | 'claude', wantId?: string): boolean => {
    const s = active();
    if (!s) return false;
    // Resolve by durable IDENTITY when the caller has it (a reply carries the
    // target's one id); fall back to ts+role only for callers that speak in
    // instants (a pill, an audio chip). Never a ts scan when an id is in hand.
    const m = wantId
      ? s.messages.find((x) => x.id === wantId)
      : s.messages.find((x) => x.ts === ts && x.role === role);
    /* Bubbles are keyed by data-mid (messageList sets messageNode.dataset.mid);
     * the old data-cyc-message-key selector matched nothing, so every jump
     * (pill, audio chip, reply) toasted "not loaded" even with the message on
     * screen. Found by driving the live app, 2026-09-06. */
    const sel = (id: string) => `.cyc-message[data-mid="${escapeMid(id)}"]`;
    let el = m && messageListInner.querySelector<HTMLElement>(sel(m.id));

    if (m && !el && extendMessageWindow(messageListInner, Number.MAX_SAFE_INTEGER)) {
      deps.renderEarlier();
      el = messageListInner.querySelector<HTMLElement>(sel(m.id));
    }
    if (!el) return false;
    smoothScrollTo({container: deps.scroller(), element: el, position: 'center'});
    highlightMessage(el);
    return true;
  };

  const openChatAwaited = (id: string) =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        off();
        clearTimeout(timer);
        resolve();
      };
      const off = engine.onReplayed((sid) => {
        if (sid === id) finish();
      });
      const timer = window.setTimeout(finish, 4000);
      deps.openChat(id, () => {
        const s = engine.get(id);
        if (s && s.tailPage !== undefined) finish();
      });
    });

  const goToMessage = async (
    sessionId: string,
    ref: MessageRef,
    msgId?: string
  ): Promise<boolean> => {
    const cur = active();

    const onScreen = !!cur && cur.id === sessionId && deps.isChatViewOpen();
    if (!onScreen) await openChatAwaited(sessionId);
    if (msgId) {
      /* A caller that only knows the engine msgId (the audio player) hands it
       * here; once the chat is open and replayed the message is usually held,
       * so resolve the real ts/role/seq ref from the store before paging. */
      const s = engine.get(sessionId);
      const m = s?.messages.find((x) => (x as {msgId?: string}).msgId === msgId);
      if (m) ref = m as MessageRef;
    }
    const held = await engine.ensureMessageHeld(sessionId, ref);
    if (!held) return false;

    deps.render();
    return jumpToMessage(ref.ts, ref.role, ref.id);
  };

  if (new URLSearchParams(location.search).get('testhooks')) {
    (
      window as never as {__cycGoToMessage: (sid: string, ref: MessageRef) => Promise<boolean>}
    ).__cycGoToMessage = (sid, ref) => goToMessage(sid, ref);
  }

  const jumpToReply = (r: CycReplyTo) => {
    const s = active();
    if (!s) return;
    // The reply carries its target's durable id: jump resolves by identity, and
    // ts/role only page the window toward it.
    void goToMessage(s.id, {ts: r.ts, role: r.role, id: r.id}).then((ok) => {
      if (!ok) toast('That message is not loaded');
    });
  };

  return {quoteInto, startReply, jumpToMessage, goToMessage, jumpToReply};
}
