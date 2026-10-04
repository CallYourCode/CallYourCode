import {describe, expect, test, vi} from 'vitest';

// release-1 B1 follow-up: a throwing heard-to-end listener must not stall the
// speaker's queue. The 'ended' handler runs the listeners before it plays the
// next clip, so an exception there used to leave the next clip never started.
const fake = vi.hoisted(() => ({
  clip: null as null | {fire(ev: string): void; src: string}
}));
vi.mock('../audio/webAudioClip', () => {
  class FakeClip {
    volume = 1;
    src = '';
    currentTime = 0;
    duration = 1;
    paused = true;
    private handlers = new Map<string, Array<() => void>>();
    constructor() {
      fake.clip = this as unknown as {fire(ev: string): void; src: string};
    }
    addEventListener(ev: string, fn: () => void) {
      this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
    }
    removeEventListener() {}
    fire(ev: string) {
      for (const fn of this.handlers.get(ev) ?? []) fn();
    }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    clear() {}
    unlock() {
      return Promise.resolve();
    }
  }
  return {WebAudioClip: FakeClip, unlockPlayback: async () => {}};
});
vi.mock('../audio/audioCache', () => ({
  resolveAudioUrl: async (_id: string, url: string) => url,
  streamAudioUrl: async (_id: string, url: string) => url
}));
vi.mock('@/shared/logging', () => ({cyclog: vi.fn()}));

import {speaker} from '../audio/speaker';

const item = (msgId: string) => ({msgId, url: `/a/${msgId}`, text: msgId, sessionId: 's1'});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the heard-to-end listeners', () => {
  test('a throwing listener does not stop the next clip from playing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const heard: string[] = [];
    const offBad = speaker.onEnded(() => {
      throw new Error('listener bug');
    });
    const offGood = speaker.onEnded((i) => heard.push(i.msgId));
    speaker.enqueue(item('a'));
    speaker.enqueue(item('b'));
    await flush();
    expect(speaker.state.msgId).toBe('a');

    fake.clip!.fire('ended'); // a played to its end
    await flush();

    expect(heard).toEqual(['a']); // the listener after the throwing one still ran
    expect(speaker.state.msgId).toBe('b'); // and the queue moved on
    offBad();
    offGood();
    speaker.stopAll();
    warn.mockRestore();
  });
});
