import {describe, expect, test, vi} from 'vitest';

// M1 (verifier round 2): "heard = seen" fired when a clip STARTED playing, so an
// auto-played reply below the viewport was read on every device the instant it
// began, even if he stopped it after a second. Heard is played to the end.
const fake = vi.hoisted(() => ({
  state: [] as Array<(s: Record<string, unknown>) => void>,
  ended: [] as Array<(i: Record<string, unknown>) => void>
}));
vi.mock('../audio/speaker', () => ({
  speaker: {
    onState: (fn: (s: Record<string, unknown>) => void) => {
      fake.state.push(fn);
      return () => {};
    },
    onEnded: (fn: (i: Record<string, unknown>) => void) => {
      fake.ended.push(fn);
      return () => {};
    },
    onError: () => () => {}
  }
}));
vi.mock('@/features/chat/content', () => ({karaokeFor: (): null => null, karaokeUpdate: vi.fn()}));
vi.mock('../components/widgets', () => ({toast: vi.fn()}));

import {installSpeakerEvents} from '../speakerEvents';

describe('a clip counts as heard only when it plays to the end', () => {
  test('starting a clip marks nothing; its end marks it heard', () => {
    const markHeard = vi.fn();
    installSpeakerEvents({
      onTeardown: () => {},
      markHeard,
      messageListInner: document.createElement('div'),
      transcriptOf: () => null,
      updateRowAudio: vi.fn(),
      updateMessagePlays: vi.fn(),
      updatePlayerBar: vi.fn(),
      updateVoiceStrip: vi.fn()
    });
    for (const fn of fake.state) fn({state: 'speaking', sessionId: 's1', msgId: 'a'});
    expect(markHeard).not.toHaveBeenCalled();
    for (const fn of fake.state) fn({state: 'idle'}); // stopped part way: still nothing
    expect(markHeard).not.toHaveBeenCalled();
    for (const fn of fake.ended) fn({sessionId: 's1', msgId: 'a'});
    expect(markHeard).toHaveBeenCalledWith('s1', 'a');
  });
});
