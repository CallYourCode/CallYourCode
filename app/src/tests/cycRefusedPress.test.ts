import {beforeEach, describe, expect, test, vi} from 'vitest';

// A refused press releases every claim it took. The composer claims the
// speaker ('press') before it asks the pipeline to start; when the pipeline
// refuses (the mic is not open, or it was dead and could not be recovered),
// the press is over: pttDown, the capture id, the recording state and the
// speaker claim all go back. Before, the refusal cleared pttDown but not the
// speaker claim, and the release that follows (endPTT) returns early when no
// press is down, so the claim stayed until the mic was disposed: every tap on
// play in between waited behind a recording that did not exist.

vi.mock('../shared/logging', async (orig) => ({
  ...(await orig<typeof import('../shared/logging')>()),
  cyclog: vi.fn(),
  newCid: () => 'c-test'
}));
vi.mock('../engine/store/audioDocs', () => ({openSttStream: vi.fn()}));
// The player and its source, so a reply can be playing when the press lands.
vi.mock('../audio/audioCache', () => ({
  streamAudioUrl: (id: string) => Promise.resolve(`blob:${id}`)
}));
vi.mock('../audio/webAudioClip', async (orig) => ({
  ...(await orig<typeof import('../audio/webAudioClip')>()),
  unlockPlayback: () => Promise.resolve(),
  WebAudioClip: class {
    src = '';
    volume = 1;
    defaultPlaybackRate = 1;
    playbackRate = 1;
    currentTime = 0;
    duration = NaN;
    backend = 'element';
    play = () => Promise.resolve();
    pause() {}
    clear() {
      this.src = '';
    }
    unlock = () => Promise.resolve();
    addEventListener() {}
  }
}));

type Claims = {busyClaims: Set<string>};
type P = Record<string, unknown> & {
  holdForPress(): void;
  startPTT(): void;
  endPTT(): void;
  refusePress(why: string): void;
  cancelCapture(): void;
  readonly pressCaptureId: number;
};

let pipeline: P;
let speaker: typeof import('../audio/speaker').speaker;
let states: string[];

const claims = () => [...(speaker as unknown as Claims).busyClaims];
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.resetModules();
  ({speaker} = await import('../audio/speaker'));
  pipeline = (await import('../audio/pipeline')).pipeline as unknown as P;
  states = [];
  (pipeline as unknown as {on(e: string, f: (s: string) => void): void}).on('recording', (s) =>
    states.push(s)
  );
});

// wiring.onVoiceStart holds the speaker for the press, then starts it once the
// mic is open.
function press(): void {
  pipeline.holdForPress();
  pipeline.startPTT();
}

describe('a refused press releases every claim it took', () => {
  test('dead track that cannot be re-acquired: refused while still held, then released', async () => {
    pipeline.stream = {getAudioTracks: () => [{readyState: 'ended', muted: false}]};
    pipeline.actx = {state: 'running', currentTime: 0};
    // The re-acquire the press earns fails (no permission).
    (pipeline as unknown as {reacquireStream: () => Promise<void>}).reacquireStream = () =>
      Promise.reject(new Error('NotAllowedError'));
    press();
    expect(claims()).toEqual(['press']);
    await settle();
    await settle();
    // Refused while the finger is still down: nothing is recording.
    expect(pipeline.pttDown).toBe(false);
    expect(pipeline.pressCaptureId).toBe(0);
    expect(claims()).toEqual([]);
    expect(states.at(-1)).toBe('idle');
    // The release that follows changes nothing and leaves nothing behind.
    pipeline.endPTT();
    expect(claims()).toEqual([]);
  });

  test('the mic is not open: refused at once', () => {
    pipeline.stream = null;
    pipeline.actx = null;
    press();
    expect(pipeline.pttDown).toBe(false);
    expect(claims()).toEqual([]);
  });

  test('a second press while one is down leaves the first press its claim', () => {
    pipeline.stream = {getAudioTracks: () => [{readyState: 'live', muted: false}]};
    pipeline.actx = {state: 'running', currentTime: 0};
    pipeline.pttDown = true;
    press();
    expect(pipeline.pttDown).toBe(true);
    expect(claims()).toEqual(['press']);
  });

  test('released before the refusal lands: the release frees it, the refusal adds nothing', async () => {
    pipeline.stream = {getAudioTracks: () => [{readyState: 'ended', muted: false}]};
    pipeline.actx = {state: 'running', currentTime: 0};
    let fail!: (e: Error) => void;
    (pipeline as unknown as {reacquireStream: () => Promise<void>}).reacquireStream = () =>
      new Promise((_, rej) => (fail = rej));
    press();
    await settle();
    pipeline.endPTT();
    expect(claims()).toEqual([]);
    fail(new Error('NotAllowedError'));
    await settle();
    await settle();
    expect(claims()).toEqual([]);
    expect(pipeline.pttDown).toBe(false);
  });
});

// A press gives back exactly what IT paused, and only that, whenever it ends
// without a recording; a capture's dropped take likewise. A reply the user had
// paused by hand, or paused or resumed during the press, is never resumed by
// the machine.
describe('a press that records nothing gives back exactly the reply it paused', () => {
  type Pending = {fail: (e: Error) => void};
  const playReply = async () => {
    speaker.enqueue({
      msgId: 'reply',
      url: '/audio/reply.mp3',
      text: 'reply',
      sessionId: 's1',
      manual: true
    });
    await settle();
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'reply'});
  };
  const micClosed = () => {
    pipeline.stream = null;
    pipeline.actx = null;
  };
  const micLive = () => {
    pipeline.stream = {getAudioTracks: () => [{readyState: 'live', muted: false}]};
    pipeline.actx = {state: 'running', currentTime: 0};
  };
  // A dead track whose re-acquire either fails at once or waits for the test.
  const micDead = (pending?: Pending) => {
    pipeline.stream = {getAudioTracks: () => [{readyState: 'ended', muted: false}]};
    pipeline.actx = {state: 'running', currentTime: 0};
    (pipeline as unknown as {reacquireStream: () => Promise<void>}).reacquireStream = () =>
      pending
        ? new Promise((_, rej) => (pending.fail = rej))
        : Promise.reject(new Error('NotAllowedError'));
  };
  const state = () => speaker.state.state;
  type Fire = {fire(): void; abandonCapture(cap: unknown, s: number, b: null, w: string): void};
  // A take that ends in a drop (the verdict's own release path).
  const dropTake = () => {
    const p = pipeline as unknown as Fire & {active: unknown};
    const cap = p.active;
    p.active = null;
    p.abandonCapture(cap, 1, null, 'test: dropped');
  };

  test('refused, the mic not open: the reply plays again', async () => {
    await playReply();
    micClosed();
    press();
    expect(claims()).toEqual([]);
    await settle();
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'reply'});
  });

  test('refused, the mic dead and not recoverable: the reply plays again', async () => {
    await playReply();
    micDead();
    press();
    expect(state()).toBe('paused');
    await settle();
    await settle();
    expect(pipeline.pttDown).toBe(false);
    expect(state()).toBe('speaking');
  });

  test('the mic failed to open (the composer refuses the press): the reply plays again', async () => {
    await playReply();
    pipeline.holdForPress();
    expect(state()).toBe('paused');
    pipeline.refusePress('the microphone could not be opened (getUserMedia failed)');
    expect(claims()).toEqual([]);
    await settle();
    expect(state()).toBe('speaking');
  });

  test('released before getUserMedia answered: the reply plays again', async () => {
    await playReply();
    pipeline.holdForPress();
    expect(state()).toBe('paused');
    pipeline.endPTT();
    expect(claims()).toEqual([]);
    await settle();
    expect(state()).toBe('speaking');
  });

  test('released before the recovery answered: the reply plays again, once', async () => {
    const pending = {} as Pending;
    await playReply();
    micDead(pending);
    press();
    await settle();
    expect(state()).toBe('paused');
    pipeline.endPTT();
    await settle();
    expect(state()).toBe('speaking');
    pending.fail(new Error('NotAllowedError'));
    await settle();
    await settle();
    expect(state()).toBe('speaking');
    expect(claims()).toEqual([]);
  });

  test('cancelled before a capture began: the press is over and the reply plays again', async () => {
    const pending = {} as Pending;
    await playReply();
    micDead(pending);
    press();
    await settle();
    pipeline.cancelCapture();
    expect(pipeline.pttDown).toBe(false);
    expect(claims()).toEqual([]);
    await settle();
    expect(state()).toBe('speaking');
    pending.fail(new Error('NotAllowedError'));
    await settle();
    await settle();
    expect(pipeline.pressCaptureId).toBe(0);
  });

  test('a reply the user paused by hand before the press is never resumed', async () => {
    await playReply();
    speaker.pause();
    micClosed();
    press();
    await settle();
    expect(state()).toBe('paused');
    pipeline.holdForPress();
    pipeline.endPTT();
    await settle();
    expect(state()).toBe('paused');
    pipeline.holdForPress();
    pipeline.refusePress('the microphone could not be opened (getUserMedia failed)');
    await settle();
    expect(state()).toBe('paused');
    expect(claims()).toEqual([]);
  });

  test('paused or resumed by the user during the press: the press does not touch it', async () => {
    const pending = {} as Pending;
    await playReply();
    micDead(pending);
    press();
    await settle();
    speaker.resume();
    speaker.pause();
    pipeline.endPTT();
    await settle();
    expect(state()).toBe('paused');
  });

  test('a dropped take gives back the reply it paused', async () => {
    micLive();
    await playReply();
    (pipeline as unknown as Fire).fire();
    expect(state()).toBe('paused');
    dropTake();
    await settle();
    expect(state()).toBe('speaking');
  });

  test("a dropped take started by a press gives back the press's pause", async () => {
    micLive();
    await playReply();
    pipeline.holdForPress();
    (pipeline as unknown as {beginPress(): void}).beginPress();
    expect(pipeline.pressCaptureId).not.toBe(0);
    // The release (endPTT): the press's claim goes, the take is judged.
    speaker.setBusy(false, 'press');
    pipeline.pttDown = false;
    dropTake();
    await settle();
    expect(state()).toBe('speaking');
  });

  test('a dropped take over a reply the user had paused leaves it paused', async () => {
    micLive();
    await playReply();
    speaker.pause();
    (pipeline as unknown as Fire).fire();
    dropTake();
    await settle();
    expect(state()).toBe('paused');
  });
});

// One standing machine pause: whatever press or take paused the reply, it is
// given back when the last of them lets go, so a press that ends empty while
// an earlier take is still being judged gets its reply back at that verdict.
describe('an empty press while an earlier take is still being judged', () => {
  type Cap = {id: number};
  type Takes = {
    fire(): void;
    active: Cap | null;
    syncRecordingState(): void;
    abandonCapture(cap: Cap, s: number, b: null, w: string): void;
    commitUtterance(cap: Cap, released: unknown, heard: unknown, blob: unknown): Promise<void>;
  };
  const takes = () => pipeline as unknown as Takes;
  const state = () => speaker.state.state;
  // A take released by the finger, its verdict pending; nothing was playing.
  const takeInFlight = () => {
    pipeline.stream = {getAudioTracks: () => [{readyState: 'live', muted: false}]};
    pipeline.actx = {state: 'running', currentTime: 0};
    takes().fire();
    const cap = takes().active!;
    takes().active = null;
    takes().syncRecordingState();
    return cap;
  };
  // The reply tapped while that take's transcript is pending: it plays at once.
  const tapReply = async () => {
    speaker.enqueue({
      msgId: 'reply',
      url: '/audio/reply.mp3',
      text: 'reply',
      sessionId: 's1',
      manual: true
    });
    await settle();
    expect(state()).toBe('speaking');
  };
  const drop = (cap: Cap) => takes().abandonCapture(cap, 1, null, 'test: dropped');
  const keep = (cap: Cap) =>
    takes().commitUtterance(
      cap,
      {id: cap.id, forCapture: undefined, durationS: 3},
      {text: 'a note', streamed: true, failed: false, decoded: true, blob: new Blob(['x'])},
      async (): Promise<Blob | null> => null
    );

  test('the mic failed to open: the reply comes back at the dropped verdict', async () => {
    const take = takeInFlight();
    await tapReply();
    pipeline.holdForPress();
    pipeline.refusePress('the microphone could not be opened (getUserMedia failed)');
    pipeline.endPTT();
    await settle();
    expect(state()).toBe('paused');
    drop(take);
    await settle();
    expect(state()).toBe('speaking');
  });

  test('released before getUserMedia answered: the reply comes back at the dropped verdict', async () => {
    const take = takeInFlight();
    await tapReply();
    pipeline.holdForPress();
    pipeline.endPTT();
    await settle();
    drop(take);
    await settle();
    expect(state()).toBe('speaking');
  });

  test('a kept verdict keeps a reply asked for after its take began, and gives it back', async () => {
    const take = takeInFlight();
    await new Promise((r) => setTimeout(r, 2));
    await tapReply();
    pipeline.holdForPress();
    pipeline.endPTT();
    await keep(take);
    await settle();
    expect(speaker.state).toMatchObject({state: 'speaking', msgId: 'reply'});
  });
});

// A re-acquire that answers after the mic was released must not leave a live
// track behind: nobody wants the mic any more.
describe('a re-acquire that answers after the mic was disposed', () => {
  test('stops the new tracks and installs nothing', async () => {
    const track = {readyState: 'live', muted: false, stop: vi.fn(), addEventListener() {}};
    const next = {getTracks: () => [track], getAudioTracks: () => [track]};
    let answer!: () => void;
    const gum = vi.fn(() => new Promise((r) => (answer = () => r(next))));
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {getUserMedia: gum},
      configurable: true
    });
    const dead = {readyState: 'ended', muted: false, stop: vi.fn()};
    pipeline.stream = {getTracks: () => [dead], getAudioTracks: () => [dead]};
    pipeline.actx = null;
    const reacquire = (pipeline as unknown as {reacquireStream(): Promise<void>}).reacquireStream();
    expect(gum).toHaveBeenCalledTimes(1);
    (pipeline as unknown as {dispose(): void}).dispose();
    answer();
    await reacquire.catch(() => {});
    expect(track.stop).toHaveBeenCalled();
    expect(pipeline.stream).toBeNull();
  });
});

// A recovery belongs to the mic session that started it. Press 1 finds a dead
// track and re-acquires it slowly; the finger lifts and the mic is released;
// press 2 opens a fresh mic at once. Press 2 must record from its first moment
// (not wait for press 1's stale re-acquire), and the stale stream, when it
// answers, is stopped rather than installed over press 2's.
describe("a new press does not wait on an older mic session's recovery", () => {
  test('press 2 records at once and keeps its own stream; the stale one is stopped', async () => {
    const track = (readyState: string) => ({
      readyState,
      muted: false,
      stop: vi.fn(),
      addEventListener() {}
    });
    const stream = (t: ReturnType<typeof track>) => ({
      getTracks: () => [t],
      getAudioTracks: () => [t]
    });
    const ctx = () => ({state: 'running', currentTime: 0, close: () => Promise.resolve()});
    let answer!: (s: unknown) => void;
    const gum = vi.fn(() => new Promise((r) => (answer = r)));
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {getUserMedia: gum},
      configurable: true
    });

    // Press 1: the track is dead, the press re-acquires it (slowly).
    pipeline.stream = stream(track('ended'));
    pipeline.actx = ctx();
    pipeline.holdForPress();
    pipeline.startPTT();
    await settle();
    await settle();
    expect(gum).toHaveBeenCalledTimes(1);
    // Released: the press ends and the composer releases the mic.
    pipeline.endPTT();
    (pipeline as unknown as {dispose(): void}).dispose();

    // Press 2 on a freshly opened mic.
    const fresh = track('live');
    pipeline.stream = stream(fresh);
    pipeline.actx = ctx();
    pipeline.holdForPress();
    pipeline.startPTT();
    await settle();
    await settle();
    const take = pipeline.pressCaptureId;
    expect(take).not.toBe(0);

    // Press 1's re-acquire answers late.
    const stale = track('live');
    answer(stream(stale));
    await settle();
    await settle();
    expect(stale.stop).toHaveBeenCalled();
    expect(fresh.stop).not.toHaveBeenCalled();
    expect((pipeline.stream as {getAudioTracks(): unknown[]}).getAudioTracks()[0]).toBe(fresh);
    expect(pipeline.pttDown).toBe(true);
    expect(pipeline.pressCaptureId).toBe(take);
  });
});
