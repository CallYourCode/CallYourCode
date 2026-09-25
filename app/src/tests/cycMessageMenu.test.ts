import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycSession, CycMessage} from '../types';
type Item = {icon: string; text: string; danger?: boolean; onClick: () => void};
const opened: Item[][] = [];
vi.mock('../components/popupMenu', () => ({
  openMenu: (items: Item[]) => {
    opened.push(items);
    return {element: document.createElement('div')};
  }
}));
const toast = vi.fn();
vi.mock('../components/widgets', () => ({toast: (...a: unknown[]) => toast(...a)}));
const copyTextToClipboard = vi.fn<(text: string) => Promise<boolean>>(() => Promise.resolve(true));
vi.mock('../features/media/downloads', () => ({
  copyText: (text: string) => copyTextToClipboard(text)
}));
vi.mock('../features/chat/touchSelection', () => ({installTouchSelect: () => () => {}}));
import {
  installMessageMenu,
  highlightMessage,
  type MessageMenuDeps
} from '../features/chat/surface/messageMenu';
import {flowStamp, textMessage} from '../features/chat/messages/messageContent';
import {audioMessage} from '../features/chat/messages/audioMessages';
function mkSession(): CycSession {
  return {
    id: 's1',
    name: 'p',
    cwd: '/x',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [
      {id: '1', role: 'user', kind: 'text', text: 'mine', ts: 1, status: 'failed'},
      {
        id: '2',
        role: 'claude',
        kind: 'text',
        text: 'reply',
        ts: 2,
        replyTo: {ts: 1, role: 'user', excerpt: 'mine'}
      }
    ]
  } as unknown as CycSession;
}
function mk(over: Partial<MessageMenuDeps> = {}) {
  const session = mkSession();
  const deps: MessageMenuDeps = {
    messageListInner: document.createElement('div'),
    scroller: () => document.createElement('div'),
    active: () => session,
    quoteInto: vi.fn(),
    startReply: vi.fn(),
    jumpToReply: vi.fn(),
    retrySend: vi.fn(),
    cancelSend: vi.fn(),
    removeMessage: vi.fn(),
    isTouch: false,
    onTeardown: () => {},
    ...over
  };
  return {deps, api: installMessageMenu(deps), session};
}
const messageFor = (mid: number) => {
  const b = document.createElement('div');
  b.className = 'cyc-message';
  b.dataset.mid = String(mid);
  return b;
};
const AT = {clientX: 0, clientY: 0, pageX: 0, pageY: 0};

const actMessage = (mid: number, text: string) => {
  const b = messageFor(mid);
  const body = document.createElement('div');
  body.className = 'cyc-message-text';
  body.textContent = text;
  const stamp = document.createElement('span');
  stamp.className = 'cyc-stamp';
  for (const act of ['copy', 'quote']) {
    const btn = document.createElement('button');
    btn.className = 'cyc-stamp-act';
    btn.dataset.act = act;
    stamp.append(btn);
  }
  b.append(body, stamp);
  return b;
};
const clickAct = (messageNode: HTMLElement, act: string) =>
  messageNode
    .querySelector<HTMLElement>(`.cyc-stamp .cyc-stamp-act[data-act=${act}]`)!
    .dispatchEvent(new MouseEvent('click', {bubbles: true}));

const stubSelection = (text: string, within: HTMLElement) => {
  const node = within.querySelector('.cyc-message-text')!.firstChild!;
  const range = {startContainer: node, endContainer: node} as unknown as Range;
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => range
  } as unknown as Selection);
};
beforeEach(() => {
  opened.length = 0;
  toast.mockClear();
  copyTextToClipboard.mockReset();
  copyTextToClipboard.mockResolvedValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});
describe('menu contents', () => {
  test('whole message: reply + delete only; delete and reply hit the injected hooks', () => {
    const {api, deps, session} = mk();
    api.openMessageMenu(messageFor(2), AT);
    const texts = opened[0]!.map((i) => i.text);
    expect(texts).toEqual(['Reply', 'Delete']);
    opened[0]!.find((i) => i.text === 'Delete')!.onClick();
    expect(deps.removeMessage).toHaveBeenCalledWith(session, session.messages[1]);
    opened[0]!.find((i) => i.text === 'Reply')!.onClick();
    expect(deps.startReply).toHaveBeenCalledWith(session, session.messages[1]);
  });
  test('a failed send grows a Try again row wired to retrySend with the same ids', () => {
    const {api, deps} = mk();
    api.openMessageMenu(messageFor(1), AT);
    const texts = opened[0]!.map((i) => i.text);
    expect(texts).toEqual(['Try again', 'Reply', 'Delete']);
    opened[0]![0]!.onClick();
    expect(deps.retrySend).toHaveBeenCalledWith('s1', '1');
  });
  test('the not-delivered note under a refused send is a tap that retries the same row', () => {
    const {deps, session} = mk();
    const failed = messageFor(1);
    failed.append(
      textMessage(session.messages[0]!, true, true).querySelector('.cyc-message-text')!
    );
    const fine = messageFor(2);
    deps.messageListInner.append(failed, fine);
    const note = failed.querySelector<HTMLElement>('.cyc-send-failed')!;
    expect(note.textContent).toContain('not delivered');
    note.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(deps.retrySend).toHaveBeenCalledWith('s1', '1');
    expect(opened).toHaveLength(0);
    // A note left on a row the store no longer calls failed is inert.
    session.messages[0]!.status = 'sent';
    note.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(deps.retrySend).toHaveBeenCalledTimes(1);
  });
  test('the voice note kept for retry is a tap that retries the same row; a note without its clip is not', () => {
    const {deps, session} = mk();
    const voice = {
      id: '1',
      role: 'user',
      kind: 'voice',
      text: 'said',
      ts: 1,
      status: 'failed',
      clipKey: 'clip-1'
    } as unknown as CycMessage;
    session.messages[0] = voice;
    const kept = messageFor(1);
    kept.append(audioMessage(voice, true, true, () => {}).querySelector('.cyc-message-content')!);
    deps.messageListInner.append(kept);
    const note = kept.querySelector<HTMLElement>('.cyc-voice-failed')!;
    expect(note.tagName).toBe('BUTTON');
    expect(note.textContent).toContain('tap to try again');
    note.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(deps.retrySend).toHaveBeenCalledWith('s1', '1');
    // Inert once the store no longer calls the row failed.
    voice.status = 'sent';
    note.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(deps.retrySend).toHaveBeenCalledTimes(1);
    // A refusal whose clip is gone has nothing to resend: a plain note, no tap.
    const gone = audioMessage(
      {...voice, status: 'failed', clipLost: true, failReason: 'too large'} as CycMessage,
      true,
      true,
      () => {}
    ).querySelector<HTMLElement>('.cyc-voice-failed')!;
    expect(gone.tagName).toBe('DIV');
    expect(gone.classList.contains('cyc-send-failed')).toBe(false);
  });
  test('the sending progress line is a cancel button with the X; the tap cancels the same row', () => {
    const {deps, session} = mk();
    const sending = {
      id: '1',
      role: 'user',
      kind: 'voice',
      text: 'moving',
      ts: 1,
      status: 'sending',
      clipKey: 'clip-1',
      sendPct: 0.42
    } as unknown as CycMessage;
    session.messages[0] = sending;
    const bubble = messageFor(1);
    bubble.append(
      audioMessage(sending, true, true, () => {}).querySelector('.cyc-message-content')!
    );
    deps.messageListInner.append(bubble);
    const line = bubble.querySelector<HTMLElement>('.cyc-send-cancel')!;
    expect(line.tagName).toBe('BUTTON');
    expect(line.title).toBe('Cancel upload');
    expect(line.classList.contains('cyc-send-progress')).toBe(true);
    expect(line.querySelector('.cyc-send-progress-text')!.textContent).toBe('sending 42%');
    expect(line.querySelector('svg')).not.toBeNull(); // the X beside the text
    line.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(deps.cancelSend).toHaveBeenCalledWith('s1', '1');
    expect(opened).toHaveLength(0);
    // Inert once the store no longer calls the row sending (the race: the
    // transfer finished under the tap).
    sending.status = 'sent';
    line.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(deps.cancelSend).toHaveBeenCalledTimes(1);
  });
  test('service messageNodes (no data-cyc-message-key) and unknown message ids open nothing', () => {
    const {api} = mk();
    api.openMessageMenu(document.createElement('div'), AT);
    api.openMessageMenu(messageFor(99), AT);
    expect(opened).toHaveLength(0);
  });
});
describe('copy/quote timestamp icons', () => {
  test('copy with no selection puts the whole message text on the clipboard', async () => {
    const {deps} = mk();
    const messageNode = actMessage(2, 'reply');
    deps.messageListInner.append(messageNode);
    clickAct(messageNode, 'copy');
    expect(copyTextToClipboard).toHaveBeenCalledWith('reply');
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Copied'));
  });
  test('copy with a selection inside the messageNode copies just the selection', async () => {
    const {deps} = mk();
    const messageNode = actMessage(2, 'reply');
    deps.messageListInner.append(messageNode);
    stubSelection('epl', messageNode);
    clickAct(messageNode, 'copy');
    expect(copyTextToClipboard).toHaveBeenCalledWith('epl');
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Selection copied'));
  });
  test('copy failure shows a failure toast instead of a success toast', async () => {
    copyTextToClipboard.mockResolvedValue(false);
    const {deps} = mk();
    const messageNode = actMessage(2, 'reply');
    deps.messageListInner.append(messageNode);
    clickAct(messageNode, 'copy');
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Copy failed'));
    expect(toast).not.toHaveBeenCalledWith('Copied');
  });
  test('quote with no selection stages the whole message', () => {
    const {deps, session} = mk();
    const messageNode = actMessage(2, 'reply');
    deps.messageListInner.append(messageNode);
    clickAct(messageNode, 'quote');
    expect(deps.quoteInto).toHaveBeenCalledWith(session, session.messages[1], 'reply');
  });
  test('quote with a selection stages that selection', () => {
    const {deps, session} = mk();
    const messageNode = actMessage(2, 'reply');
    deps.messageListInner.append(messageNode);
    stubSelection('epl', messageNode);
    clickAct(messageNode, 'quote');
    expect(deps.quoteInto).toHaveBeenCalledWith(session, session.messages[1], 'epl');
  });
  test('a selection in a DIFFERENT messageNode falls back to the whole message', () => {
    const {deps} = mk();
    const other = actMessage(1, 'mine');
    const messageNode = actMessage(2, 'reply');
    deps.messageListInner.append(other, messageNode);
    stubSelection('ine', other);
    clickAct(messageNode, 'copy');
    expect(copyTextToClipboard).toHaveBeenCalledWith('reply');
  });
  test('an icon click inside a messageNode with no data-cyc-message-key does nothing', () => {
    const {deps} = mk();
    const messageNode = actMessage(2, 'reply');
    delete messageNode.dataset.mid;
    deps.messageListInner.append(messageNode);
    clickAct(messageNode, 'copy');
    expect(copyTextToClipboard).not.toHaveBeenCalled();
    expect(deps.quoteInto).not.toHaveBeenCalled();
  });
});
describe('flowStamp copy/quote buttons', () => {
  const msg = (text: string): CycMessage =>
    ({id: '3', role: 'user', kind: 'text', text, ts: 1, status: 'sent'}) as unknown as CycMessage;
  test('a text message renders exactly one visible copy/quote pair (no double render)', () => {
    const span = flowStamp(msg('hello'));
    const acts = [...span.querySelectorAll('.cyc-stamp-act')].map(
      (b) => (b as HTMLElement).dataset.act
    );
    expect(acts).toEqual(['copy', 'quote']);
    expect(span.querySelectorAll('button[aria-hidden="true"]').length).toBe(0);
  });
  test('a whitespace-only message renders no buttons', () => {
    const span = flowStamp(msg('   '));
    expect(span.querySelectorAll('.cyc-stamp-act').length).toBe(0);
  });
});
describe('reply header travel', () => {
  test('a click on the quote frame jumps to the quoted message', () => {
    const {deps, session} = mk();
    const messageNode = document.createElement('div');
    messageNode.className = 'cyc-message cyc-has-reply';
    messageNode.dataset.mid = '2';
    const frame = document.createElement('div');
    frame.className = 'cyc-reply cyc-callout-surface';
    messageNode.append(frame);
    deps.messageListInner.append(messageNode);
    frame.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(deps.jumpToReply).toHaveBeenCalledWith(
      (session.messages[1] as {replyTo?: unknown}).replyTo
    );
  });
});
describe('highlightMessage', () => {
  type FakeAnim = {cancel: ReturnType<typeof vi.fn>; finish?: () => void};

  test('flashes the row overlay via WAAPI and restarts cleanly on re-highlight', () => {
    const anims: FakeAnim[] = [];
    const animate = vi.fn(() => {
      const a: FakeAnim & {addEventListener: (t: string, cb: () => void) => void} = {
        cancel: vi.fn(),
        addEventListener: (t, cb) => {
          if (t === 'finish') a.finish = cb;
        }
      };
      anims.push(a);
      return a as unknown as Animation;
    });
    (HTMLElement.prototype as unknown as {animate: unknown}).animate = animate;
    try {
      const el = document.createElement('div');
      el.className = 'cyc-message';

      highlightMessage(el);
      expect(el.querySelector(':scope > .cyc-msg-highlight')).not.toBeNull();
      expect(animate).toHaveBeenCalledTimes(1);
      const [frames, timing] = animate.mock.calls[0]! as unknown as [
        Keyframe[],
        {duration: number}
      ];
      expect(timing.duration).toBe(2000);
      expect(frames.length).toBeGreaterThan(0);

      highlightMessage(el);
      expect(anims[0]!.cancel).toHaveBeenCalledTimes(1);
      expect(animate).toHaveBeenCalledTimes(2);

      expect(() => anims[1]!.finish?.()).not.toThrow();
    } finally {
      delete (HTMLElement.prototype as {animate?: unknown}).animate;
    }
  });

  test('is a no-op when the row carries no highlight overlay', () => {
    const el = document.createElement('div');
    el.className = 'cyc-message cyc-date-chip';
    expect(() => highlightMessage(el)).not.toThrow();
    expect(el.querySelector(':scope > .cyc-msg-highlight')).toBeNull();
  });
});

describe('links in a bubble', () => {
  beforeEach(() => {
    opened.length = 0;
    copyTextToClipboard.mockClear();
    toast.mockClear();
  });

  test('right-clicking a link leads with Open link and Copy link, then the usual items', async () => {
    const {deps} = mk();
    const bubble = messageFor(2);
    const a = document.createElement('a');
    a.href = 'https://play.google.com/store/apps/details?id=ai.coachchat.app';
    a.textContent = 'store link';
    bubble.append(a);
    deps.messageListInner.append(bubble);
    a.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 5, clientY: 5}));
    const items = opened.at(-1)!;
    expect(items.map((i) => i.text)).toEqual(['Open link', 'Copy link', 'Reply', 'Delete']);
    items[1].onClick();
    await Promise.resolve();
    expect(copyTextToClipboard).toHaveBeenCalledWith('https://play.google.com/store/apps/details?id=ai.coachchat.app');
  });

  test('right-clicking plain text keeps the menu as it was', () => {
    const {deps} = mk();
    const bubble = messageFor(2);
    bubble.textContent = 'no link here';
    deps.messageListInner.append(bubble);
    bubble.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true}));
    expect(opened.at(-1)!.map((i) => i.text)).toEqual(['Reply', 'Delete']);
  });

  test('on touch, a long-press on a link keeps the phone own menu', () => {
    const {deps} = mk({isTouch: true});
    const bubble = messageFor(2);
    const a = document.createElement('a');
    a.href = 'https://example.com/x';
    bubble.append(a);
    deps.messageListInner.append(bubble);
    const onLink = new MouseEvent('contextmenu', {bubbles: true, cancelable: true});
    a.dispatchEvent(onLink);
    expect(onLink.defaultPrevented).toBe(false);
    const onText = new MouseEvent('contextmenu', {bubbles: true, cancelable: true});
    bubble.dispatchEvent(onText);
    expect(onText.defaultPrevented).toBe(true);
  });
});
