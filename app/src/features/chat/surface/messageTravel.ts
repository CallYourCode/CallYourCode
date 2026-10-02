import {touchCapable} from '@/shared/capabilities';
import type {CycMessage, CycReplyTo, CycSession} from '@/types';
import * as engine from '@/engine/store';
import {scrollMessageIntoView} from './messageList';
import {markMachineTop, logScrollWrite} from './machineScroll';
import {seatScrollTop, smoothScrollTo} from '@/shared/smoothScroll';
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
  // Drop the surface's "pinned to bottom" state as the jump leaves the bottom,
  // so the resize observer does not re-pin and yank the target off-screen.
  releaseBottomPin?(): void;
  // The ScrollOwner's deliberate move (owner.jump): the travel runs inside it
  // for its whole duration, so its scrolls never read as a reader driving, and
  // it stops writing the moment the reader's finger lands (readerTook).
  jump?<T>(kind: string, run: (readerTook: () => boolean) => T): T;
}

// A single animation-frame tick, for the jump settle loop below.
function nextFrame(): Promise<void> {
  return new Promise((resolve) =>
    typeof requestAnimationFrame !== 'undefined'
      ? requestAnimationFrame(() => resolve())
      : setTimeout(resolve, 16)
  );
}

export function createMessageTravel(deps: MessageTravelDeps) {
  const {composer, messageListInner} = deps;

  const midSel = (id: string) => `.cyc-message[data-mid="${escapeMid(id)}"]`;

  // Hold the jump target centred until it settles. The offset a jump seats on
  // is first computed from row estimates; as the rows above the target mount
  // and measure away from those estimates the window slides and the target can
  // drift out of view (or the one-shot centre lands off, and on tablet/laptop
  // the row was gone 2s later). Re-centre it every frame -- re-mounting it if
  // the window slid past it -- until its centred offset holds, bounded so this
  // always terminates. Runs after the smooth first leg the reader sees. Stops
  // the moment the reader takes the offset back.
  const settleToMessage = async (id: string, readerTook: () => boolean): Promise<void> => {
    const container = deps.scroller();
    const first = messageListInner.querySelector<HTMLElement>(midSel(id));
    if (first) await smoothScrollTo({container, element: first, position: 'center'});
    const MAX_FRAMES = 60; // ~1s ceiling, under the 2s a caller waits to read it
    let stable = 0;
    for (let i = 0; i < MAX_FRAMES; i++) {
      if (readerTook()) return;
      const el = messageListInner.querySelector<HTMLElement>(midSel(id));
      if (!el) {
        // The window slid off the target (estimate drift remounted a different
        // slice); re-window to bring it back, then re-check next frame.
        if (!scrollMessageIntoView(messageListInner, id, 'center')) return;
        await nextFrame();
        continue;
      }
      const top = seatScrollTop({container, element: el, position: 'center'});
      if (Math.abs(top - container.scrollTop) <= 2) {
        if (++stable >= 3) {
          highlightMessage(el);
          return;
        }
      } else {
        stable = 0;
        const from = container.scrollTop;
        container.scrollTop = top;
        logScrollWrite(container, 'travel.settle', from, container.scrollTop);
        markMachineTop(container);
      }
      await nextFrame();
    }
    const el = messageListInner.querySelector<HTMLElement>(midSel(id));
    if (el && !readerTook()) {
      const from = container.scrollTop;
      container.scrollTop = seatScrollTop({container, element: el, position: 'center'});
      logScrollWrite(container, 'travel.final', from, container.scrollTop);
      markMachineTop(container);
      highlightMessage(el);
    }
  };

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

  // A travel write is the owner's deliberate move (see MessageTravelDeps.jump).
  const travel = <T>(run: (readerTook: () => boolean) => T): T =>
    deps.jump ? deps.jump('to-message', run) : run(() => false);

  const jumpToMessage = (ts: number, role: 'user' | 'claude', wantId?: string): boolean => {
    const s = active();
    if (!s) return false;
    // Resolve by durable IDENTITY when the caller has it (a reply carries the
    // target's one id); fall back to ts+role only for callers that speak in
    // instants (a pill, an audio chip). Never a ts scan when an id is in hand.
    const m = wantId
      ? s.messages.find((x) => x.id === wantId)
      : s.messages.find((x) => x.ts === ts && x.role === role);
    // The jump is an intentional move away from the bottom: drop the pin BEFORE
    // the scroll below re-windows (which resizes the list and would otherwise
    // trip the resize observer into re-pinning to the bottom, unmounting the
    // target). A jump that ends up at the bottom is re-pinned by the scroll
    // listener. Only once we have a target to travel to.
    if (m) deps.releaseBottomPin?.();
    /* Bubbles are keyed by data-mid (messageList sets messageNode.dataset.mid);
     * the old data-cyc-message-key selector matched nothing, so every jump
     * (pill, audio chip, reply) toasted "not loaded" even with the message on
     * screen. Found by driving the live app, 2026-09-06. */
    const sel = midSel;
    let el = m && messageListInner.querySelector<HTMLElement>(sel(m.id));

    // The target row may sit outside the virtual window (never mounted). Scroll
    // the box to its computed offset, which re-windows and mounts it, then
    // re-query and centre it with the settle below.
    if (m && !el && travel(() => scrollMessageIntoView(messageListInner, m.id, 'center'))) {
      el = messageListInner.querySelector<HTMLElement>(sel(m.id));
    }
    if (!m || !el) return false;
    highlightMessage(el);
    // Centre and hold it against the measure-vs-estimate drift; the target is
    // resolved and mounted now, so the jump has succeeded and we return true
    // while the centring settles.
    const id = m.id;
    void travel((readerTook) => settleToMessage(id, readerTook));
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
