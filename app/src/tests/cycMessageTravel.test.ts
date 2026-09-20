import {beforeEach, describe, expect, test, vi} from 'vitest';
import type {CycMessage, CycSession} from '../types';
const fake = {
  active: null as CycSession | null,
  plugins: [] as Array<{id: string; panel?: unknown}>,
  held: true,
  session: null as {tailPage?: number} | null
};
const scrolls: unknown[] = [];
vi.mock('../engine/store', () => ({
  pluginsOf: () => fake.plugins,
  ensureMessageHeld: vi.fn(async () => fake.held),
  onReplayed: () => () => {},
  get: () => fake.session,
  retrySend: vi.fn()
}));
vi.mock('../sessionSelectors', () => ({active: () => fake.active}));
vi.mock('../features/chat/surface/messageList', () => ({
  extendMessageWindow: vi.fn(() => false)
}));
vi.mock('../features/chat/content', () => ({
  previewText: (s: string) => s
}));
vi.mock('../shared/smoothScroll', () => ({smoothScrollTo: (o: unknown) => scrolls.push(o)}));
vi.mock('../components/widgets', () => ({toast: vi.fn()}));
import {
  createMessageTravel,
  firstWords,
  type MessageTravelDeps
} from '../features/chat/surface/messageTravel';
import {extendMessageWindow} from '../features/chat/surface/messageList';
import {toast} from '../components/widgets';
import {replySource} from '../replyModel';
function mkSession(): CycSession {
  return {
    id: 's1',
    name: 'p',
    cwd: '/x',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [{id: '7', role: 'claude', kind: 'text', text: 'hello there', ts: 500}]
  } as unknown as CycSession;
}
function mk(over: Partial<MessageTravelDeps> = {}) {
  const composer = {
    el: document.createElement('div'),
    addQuote: vi.fn(),
    setReplyTo: vi.fn(),
    focus: vi.fn()
  };
  const deps: MessageTravelDeps = {
    composer,
    messageListInner: document.createElement('div'),
    scroller: () => document.createElement('div'),
    chatEl: document.createElement('div'),
    renderEarlier: vi.fn(),
    render: vi.fn(),
    openChat: vi.fn((id, after) => after?.()),
    isChatViewOpen: () => true,
    ...over
  };
  return {deps, composer, api: createMessageTravel(deps)};
}
beforeEach(() => {
  fake.active = mkSession();
  fake.plugins = [];
  fake.held = true;
  fake.session = {tailPage: 0};
  scrolls.length = 0;
  vi.clearAllMocks();
});
describe('reply and quote staging', () => {
  test('quoteInto adds a quote block remembering its source message', () => {
    const {api, composer} = mk();
    const m = fake.active!.messages[0]!;
    api.quoteInto(fake.active!, m, 'hello');
    expect(composer.addQuote).toHaveBeenCalled();
    const target = (composer.addQuote as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(replySource.get(target)).toBe(m);
  });
  test('quoteInto caps the staged quote at 25 words with an ellipsis', () => {
    const {api, composer} = mk();
    const m = fake.active!.messages[0]!;
    const long = Array.from({length: 40}, (_, i) => `w${i + 1}`).join(' ');
    api.quoteInto(fake.active!, m, long);
    const staged = (composer.addQuote as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(staged).toBe(Array.from({length: 25}, (_, i) => `w${i + 1}`).join(' ') + '…');

    const target = (composer.addQuote as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect((target as {text: string}).text).toBe(staged);
  });
  test('quoteInto leaves a short quote unchanged', () => {
    const {api, composer} = mk();
    const m = fake.active!.messages[0]!;
    api.quoteInto(fake.active!, m, 'just a few words');
    expect((composer.addQuote as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      'just a few words'
    );
  });
  test('firstWords truncates only past the limit', () => {
    expect(firstWords('a b c', 25)).toBe('a b c');
    expect(firstWords('a b c d', 3)).toBe('a b c…');
    expect(firstWords('a b c', 3)).toBe('a b c');
    expect(firstWords('  spaced   out  words ', 2)).toBe('spaced out…');
  });
  test('startReply stages the reply target for this chat', () => {
    const {api, composer} = mk();
    const m = fake.active!.messages[0]!;
    api.startReply(fake.active!, m);
    expect(composer.setReplyTo).toHaveBeenCalled();
    const target = (composer.setReplyTo as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(replySource.get(target)).toBe(m);
  });
});
describe('jumpToMessage', () => {
  test('seats and highlights a drawn messageNode by ts+role', () => {
    const {api, deps} = mk();
    const el = document.createElement('div');
    el.className = 'cyc-message';
    el.dataset.mid = '7';
    deps.messageListInner.append(el);
    expect(api.jumpToMessage(500, 'claude')).toBe(true);
    expect(scrolls).toHaveLength(1);
    // The jump flash mounts the row's highlight overlay to paint into.
    expect(el.querySelector(':scope > .cyc-msg-highlight')).not.toBeNull();
  });
  test('a held-but-windowed-out message widens the window and looks again', () => {
    const {api, deps} = mk();
    (extendMessageWindow as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    expect(api.jumpToMessage(500, 'claude')).toBe(false);
    expect(deps.renderEarlier).toHaveBeenCalledTimes(1);
    expect(api.jumpToMessage(999, 'claude')).toBe(false);
  });
});
describe('goToMessage', () => {
  test('on-screen chat skips the open; the seat gets a flushed render first', async () => {
    const {api, deps} = mk();
    const el = document.createElement('div');
    el.className = 'cyc-message';
    el.dataset.mid = '7';
    deps.messageListInner.append(el);
    await expect(api.goToMessage('s1', {ts: 500, role: 'claude'})).resolves.toBe(true);
    expect(deps.openChat).not.toHaveBeenCalled();
    expect(deps.render).toHaveBeenCalled();
  });
  test('a chat behind the list view is opened first; an unheld target answers false', async () => {
    const {api, deps} = mk({isChatViewOpen: () => false});
    fake.held = false;
    await expect(api.goToMessage('s1', {ts: 500, role: 'claude'})).resolves.toBe(false);
    expect(deps.openChat).toHaveBeenCalled();
    expect(deps.render).not.toHaveBeenCalled();
  });
  test('a msgId re-resolves the real ref from the store before paging', async () => {
    const {api, deps} = mk();
    fake.session = {
      tailPage: 0,
      messages: [{id: '7', role: 'claude', ts: 500, msgId: 'mX'}]
    } as never;
    const el = document.createElement('div');
    el.className = 'cyc-message';
    el.dataset.mid = '7';
    deps.messageListInner.append(el);
    const engine = await import('../engine/store');
    await expect(
      api.goToMessage('s1', {ts: Number.MAX_SAFE_INTEGER, role: 'claude'}, 'mX')
    ).resolves.toBe(true);
    expect(engine.ensureMessageHeld).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ts: 500, msgId: 'mX'})
    );
  });
  test('jumpToReply apologises when the traveller fails', async () => {
    const {api} = mk();
    fake.held = false;
    api.jumpToReply({ts: 1, role: 'user'} as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(toast).toHaveBeenCalledWith('That message is not loaded');
  });
});
