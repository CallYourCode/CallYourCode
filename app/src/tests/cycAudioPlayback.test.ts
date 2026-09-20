import {beforeEach, describe, expect, test, vi} from 'vitest';

if (typeof globalThis.CSS === 'undefined') (globalThis as {CSS?: unknown}).CSS = {};
if (!globalThis.CSS.escape)
  globalThis.CSS.escape = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
vi.mock('../components/widgets', () => ({toast: vi.fn()}));
import {
  createAudioPlayback,
  type AudioPlaybackDeps,
  type SpeakerLike
} from '../features/chat/surface/audioPlayback';
import {toast} from '../components/widgets';
import type {CycSession} from '../types';

beforeEach(() => {
  vi.clearAllMocks();
});
function fakeSpeaker(state: Partial<SpeakerLike['state']> = {}): SpeakerLike {
  return {
    state: {state: 'idle', ...state},
    enqueue: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stopAll: vi.fn(),
    seek: vi.fn(),
    times: () => ({t: 3, dur: 10}),
    progress: () => ({ratio: 0.3, msgId: state.msgId ?? null})
  };
}
function mkSession(over: Partial<CycSession> = {}): CycSession {
  return {
    id: 's1',
    name: 'pane one',
    cwd: '/x',
    unread: 0,
    muted: false,
    thinking: false,
    alive: true,
    messages: [],
    ...over
  } as unknown as CycSession;
}
function mk(over: Partial<AudioPlaybackDeps> = {}) {
  const el = () => document.createElement('div');
  const session = (over as {__session?: CycSession}).__session ?? mkSession();
  const speaker = over.speaker ?? fakeSpeaker();
  const deps: AudioPlaybackDeps = {
    messageListInner: el(),
    chatEl: el(),
    audioJumpChip: el(),
    leftContent: el(),
    scrollContainer: el,
    sessionList: {setRowAudioState: vi.fn()},
    header: {setVoiceState: vi.fn()},
    playerBar: {show: vi.fn(), progress: vi.fn()},
    speaker,
    store: {
      get: (id) => (id === session.id ? session : undefined),
      audioUrl: (sid, mid) => `http://a/${sid}/${mid}`
    },
    isLive: () => true,
    isChatViewOpen: () => true,
    appConversationMode: () => true,
    chatConversationModeHas: () => false,
    active: () => session,
    allSessions: () => [session],
    heardTsOf: () => 0,
    decodedDurations: new Map(),
    growingOf: () => undefined,
    capRecState: () => 'idle',
    goToMessage: vi.fn(async () => true),
    onTeardown: () => {},
    ...over
  };
  return {deps, api: createAudioPlayback(deps), session, speaker};
}
describe('play() duration resolution', () => {
  test('message durationS wins, then decodedDurations, then the growing clip', () => {
    const decoded = new Map([['m2', 7]]);
    const {api, session, speaker} = mk({
      decodedDurations: decoded,
      growingOf: (id) => (id === 'm3' ? {text: 'x', durS: 2.5} : undefined)
    });
    session.messages.push(
      {id: 1, role: 'claude', kind: 'voice', text: 'a', ts: 1, msgId: 'm1', durationS: 9} as never,
      {id: 2, role: 'claude', kind: 'voice', text: 'b', ts: 2, msgId: 'm2'} as never
    );
    api.play('s1', 'm1', 'a');
    api.play('s1', 'm2', 'b');
    api.play('s1', 'm3', 'c', true);
    const calls = (speaker.enqueue as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toMatchObject({
      msgId: 'm1',
      durationS: 9,
      manual: false,
      url: 'http://a/s1/m1'
    });
    expect(calls[1][0]).toMatchObject({msgId: 'm2', durationS: 7});
    expect(calls[2][0]).toMatchObject({msgId: 'm3', durationS: 2.5, manual: true});
  });
});
describe('row audio control', () => {
  test('state: none off-mode, speakable when unheard, finished when heard, speaking/paused when current', () => {
    const {api, session, speaker} = mk({heardTsOf: () => 5});
    expect(api.rowAudioState('s1')).toBe('none');
    session.messages.push({id: 1, role: 'claude', text: 'a', ts: 9, msgId: 'm1'} as never);
    expect(api.rowAudioState('s1')).toBe('speakable');
    session.messages[0]!.ts = 3;
    expect(api.rowAudioState('s1')).toBe('finished');
    speaker.state.sessionId = 's1';
    speaker.state.state = 'speaking';
    expect(api.rowAudioState('s1')).toBe('speaking');
    speaker.state.state = 'paused';
    expect(api.rowAudioState('s1')).toBe('paused');
    const off = mk({appConversationMode: () => false});
    expect(off.api.rowAudioState('s1')).toBe('none');
  });
  test('click: pause when speaking, resume when paused, replay latest otherwise', () => {
    const {api, session, speaker} = mk();
    session.messages.push({id: 1, role: 'claude', text: 'a', ts: 1, msgId: 'm1'} as never);
    speaker.state.sessionId = 's1';
    speaker.state.state = 'speaking';
    api.rowAudioClick('s1');
    expect(speaker.pause).toHaveBeenCalledTimes(1);
    speaker.state.state = 'paused';
    api.rowAudioClick('s1');
    expect(speaker.resume).toHaveBeenCalledTimes(1);
    speaker.state.state = 'finished';
    api.rowAudioClick('s1');
    expect(speaker.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({msgId: 'm1', manual: true})
    );
  });
  test('updateRowAudio paints every listed session through sessionList', () => {
    const {api, deps} = mk();
    api.updateRowAudio();
    expect(deps.sessionList.setRowAudioState).toHaveBeenCalledWith('s1', 'none');
  });
});
describe('messageNode play', () => {
  test('a tap on a new clip stops the current one, plays it, then queues the claude replies after it', () => {
    const {api, session, speaker} = mk();
    session.messages.push(
      {id: 1, role: 'claude', text: 'a', ts: 1, msgId: 'm1'} as never,
      {id: 2, role: 'user', text: 'mine', ts: 2, msgId: 'u1'} as never,
      {id: 3, role: 'claude', text: 'b', ts: 3, msgId: 'm2'} as never
    );
    api.onMessagePlay(session.messages[0]!, document.createElement('div'));
    expect(speaker.stopAll).toHaveBeenCalledTimes(1);
    const ids = (speaker.enqueue as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].msgId);
    expect(ids).toEqual(['m1', 'm2']);
  });
  test('the same clip toggles pause/resume; a messageNode with no engine is a no-op', () => {
    const {api, session, speaker} = mk();
    session.messages.push({id: 1, role: 'claude', text: 'a', ts: 1, msgId: 'm1'} as never);
    speaker.state.msgId = 'm1';
    speaker.state.state = 'speaking';
    api.onMessagePlay(session.messages[0]!, document.createElement('div'));
    expect(speaker.pause).toHaveBeenCalledTimes(1);

    const noEngine = mk();
    noEngine.api.onMessagePlay(
      {id: 1, role: 'claude', kind: 'text', text: 'x', ts: 1} as never,
      document.createElement('div')
    );
    expect(noEngine.speaker.enqueue).not.toHaveBeenCalled();
    expect(noEngine.speaker.pause).not.toHaveBeenCalled();
  });
  test('seek on the current clip seeks (and resumes a paused one); on another clip it switches', () => {
    const {api, session, speaker} = mk();
    session.messages.push(
      {id: 1, role: 'claude', text: 'a', ts: 1, msgId: 'm1'} as never,
      {id: 2, role: 'claude', text: 'b', ts: 2, msgId: 'm2'} as never
    );
    speaker.state.msgId = 'm1';
    speaker.state.state = 'paused';
    api.onMessageSeek(session.messages[0]!, 0.5);
    expect(speaker.seek).toHaveBeenCalledWith(0.5);
    expect(speaker.resume).toHaveBeenCalledTimes(1);
    api.onMessageSeek(session.messages[1]!, 0.25);
    expect(speaker.stopAll).toHaveBeenCalledTimes(1);
    expect(speaker.enqueue).toHaveBeenCalledWith(expect.objectContaining({msgId: 'm2'}));
  });
});
describe('player bar', () => {
  test('shows the chat name and progress while a clip is held; hides otherwise', () => {
    const speaker = fakeSpeaker({state: 'speaking', sessionId: 's1', msgId: 'm1', text: ' words '});
    const {api, deps} = mk({speaker});
    api.updatePlayerBar();
    expect(deps.playerBar.show).toHaveBeenCalledWith({
      chat: 'pane one',
      text: 'words',
      playing: true,
      loading: false
    });
    expect(deps.leftContent.classList.contains('cyc-has-player')).toBe(true);
    expect(deps.playerBar.progress).toHaveBeenCalledWith(3, 10, 0.3);
    speaker.state.state = 'idle';
    api.updatePlayerBar();
    expect(deps.playerBar.show).toHaveBeenLastCalledWith(null);
    expect(deps.leftContent.classList.contains('cyc-has-player')).toBe(false);
  });
  test('openPlayingMessage travels via goToMessage to the held message', async () => {
    const speaker = fakeSpeaker({state: 'paused', sessionId: 's1', msgId: 'm1'});
    const {api, deps, session} = mk({speaker});
    session.messages.push({id: 1, role: 'claude', text: 'a', ts: 42, msgId: 'm1'} as never);
    api.openPlayingMessage();
    expect(deps.goToMessage).toHaveBeenCalledWith('s1', session.messages[0], 'm1');
  });
  test('a playing subject windowed out of session.messages still travels via goToMessage, not a toast', async () => {
    const speaker = fakeSpeaker({state: 'speaking', sessionId: 's1', msgId: 'mGone'});
    const goToMessage = vi.fn(async () => true);
    const {api} = mk({speaker, goToMessage});
    // session.messages is empty: the playing message is not in the loaded window.
    api.openPlayingMessage();
    expect(goToMessage).toHaveBeenCalledTimes(1);
    expect(goToMessage).toHaveBeenCalledWith('s1', expect.objectContaining({role: 'claude'}), 'mGone');
    await Promise.resolve();
    expect(toast).not.toHaveBeenCalled();
  });
  test('no player subject is a silent no-op: no goToMessage, no toast', () => {
    const speaker = fakeSpeaker({state: 'idle'});
    const goToMessage = vi.fn(async () => true);
    const {api} = mk({speaker, goToMessage});
    api.openPlayingMessage();
    expect(goToMessage).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
  test('the toast is the last resort: it only fires when the message truly cannot be held', async () => {
    const speaker = fakeSpeaker({state: 'speaking', sessionId: 's1', msgId: 'mGone'});
    const goToMessage = vi.fn(async () => false);
    const {api} = mk({speaker, goToMessage});
    api.openPlayingMessage();
    await Promise.resolve();
    await Promise.resolve();
    expect(goToMessage).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('That message is not loaded');
  });
});
describe('voice strip', () => {
  test('conversation-mode chat reports recording > transcribing > speaking > listening', () => {
    const speaker = fakeSpeaker();
    let rec = 'recording';
    const {api, deps} = mk({speaker, chatConversationModeHas: () => true, capRecState: () => rec});
    api.updateVoiceStrip();
    expect(deps.header.setVoiceState).toHaveBeenLastCalledWith('you-cut-in');
    rec = 'transcribing';
    api.updateVoiceStrip();
    expect(deps.header.setVoiceState).toHaveBeenLastCalledWith('transcribing');
    rec = 'idle';
    speaker.state.sessionId = 's1';
    speaker.state.state = 'speaking';
    api.updateVoiceStrip();
    expect(deps.header.setVoiceState).toHaveBeenLastCalledWith('speaking');
    speaker.state.state = 'idle';
    api.updateVoiceStrip();
    expect(deps.header.setVoiceState).toHaveBeenLastCalledWith('listening');
    const off = mk({chatConversationModeHas: () => false});
    off.api.updateVoiceStrip();
    expect(off.deps.header.setVoiceState).toHaveBeenLastCalledWith(null);
  });
});
describe('messageNode paint + jump chip', () => {
  test('updateMessagePlays clears the previous clip fill and paints the current one', () => {
    const speaker = fakeSpeaker({state: 'paused', sessionId: 's1', msgId: 'm2'});
    const {api, deps} = mk({speaker});
    const messageNode = (msgId: string) => {
      const audio = document.createElement('div');
      audio.className = 'cyc-clip cyc-voice';
      audio.dataset.msgId = msgId;
      const toggle = document.createElement('div');
      toggle.className = 'cyc-clip-toggle playing';
      const fill = document.createElement('div');
      fill.className = 'cyc-signal-progress';
      fill.style.clipPath = 'inset(0 60% 0 0)';
      audio.append(toggle, fill);
      deps.messageListInner.append(audio);
      return {toggle, fill};
    };
    const b1 = messageNode('m1');
    const b2 = messageNode('m2');

    speaker.state.msgId = 'm1';
    speaker.state.state = 'speaking';
    api.updateMessagePlays();
    expect(b1.toggle.classList.contains('playing')).toBe(true);
    speaker.state.msgId = 'm2';
    speaker.state.state = 'paused';
    api.updateMessagePlays();
    expect(b1.toggle.classList.contains('playing')).toBe(false);
    // The previous clip is fully re-clipped; the current one is left untouched.
    expect(b1.fill.style.clipPath).toBe('inset(0 100% 0 0)');
    expect(b2.fill.style.clipPath).toBe('inset(0 60% 0 0)');

    expect(deps.chatEl.hasAttribute('data-cyc-audiojump')).toBe(false);
  });
  test('the jump chip points up when the speaking messageNode is above the view or windowed out', () => {
    const speaker = fakeSpeaker({state: 'speaking', sessionId: 's1', msgId: 'mX'});
    const {api, deps} = mk({speaker});
    api.updateAudioJumpChip();
    expect(deps.chatEl.hasAttribute('data-cyc-audiojump')).toBe(true);
    expect(deps.audioJumpChip.classList.contains('is-up')).toBe(true);
    const away = mk({speaker, isChatViewOpen: () => false});
    away.api.updateAudioJumpChip();
    expect(away.deps.chatEl.hasAttribute('data-cyc-audiojump')).toBe(false);
  });
});
