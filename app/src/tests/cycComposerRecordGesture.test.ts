import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

vi.mock('../audio/pipeline', () => ({
  pipeline: {
    on: vi.fn(() => () => {}),
    liveCaptureId: undefined,
    liveCaptionOpen: true
  }
}));
import {
  createComposerRecordGesture,
  type ComposerRecordGestureDeps
} from '../features/composer/components/composerRecordGesture';
import type {ComposerBlock} from '../features/composer/components/composerModel';

function pev(type: string, init: {pointerId?: number; clientX?: number; clientY?: number} = {}) {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0
  });
  (e as any).pointerId = init.pointerId ?? 1;
  return e;
}
type World = ReturnType<typeof makeGesture>;
function makeGesture(over: Partial<ComposerRecordGestureDeps> = {}) {
  const el = document.createElement('div');
  const sendButton = document.createElement('button');
  const lockChip = document.createElement('button');
  const input = document.createElement('div');
  const recPanel = {
    element: document.createElement('div'),
    renderRecorder: vi.fn()
  };
  const blocks: ComposerBlock[] = [];
  const state = {empty: true, text: ''};
  const spies = {
    onSend: vi.fn((): boolean | Promise<boolean> => true),
    onAttach: vi.fn((): void | Promise<void> => undefined),
    onVoiceStart: vi.fn(),
    onVoiceEnd: vi.fn(),
    onVoiceCancel: vi.fn(),
    onLiveSend: vi.fn(),
    renderBlocks: vi.fn(),
    setSendMode: vi.fn(),
    clear: vi.fn(() => [] as ComposerBlock[]),
    setEmpty: vi.fn(),
    setPartial: vi.fn(),
    setCaption: vi.fn()
  };
  const gesture = createComposerRecordGesture({
    el,
    sendButton,
    setSendMode: spies.setSendMode,
    lockChip,
    input,
    recPanel: recPanel as any,
    blocks,
    staged: () => [],
    renderBlocks: spies.renderBlocks,
    clear: spies.clear,
    getText: () => state.text,
    isEmpty: () => state.empty,
    setEmpty: spies.setEmpty,
    setPartial: spies.setPartial,
    setCaption: spies.setCaption,
    cap: {live: false, stream: true, last: {text: ''}},
    liveWords: () => false,
    isDisabled: () => false,
    voiceEnabled: () => true,
    onSend: spies.onSend,
    onAttach: spies.onAttach,
    onVoiceStart: spies.onVoiceStart,
    onVoiceEnd: spies.onVoiceEnd,
    onVoiceCancel: spies.onVoiceCancel,
    onLiveSend: spies.onLiveSend,
    ...over
  });
  return {gesture, el, sendButton, lockChip, input, recPanel, blocks, state, spies};
}
function press(w: World, at = {x: 300, y: 600}, pointerId = 1) {
  w.sendButton.dispatchEvent(pev('pointerdown', {pointerId, clientX: at.x, clientY: at.y}));
}
function release(w: World, at = {x: 300, y: 600}, pointerId = 1) {
  document.dispatchEvent(pev('pointerup', {pointerId, clientX: at.x, clientY: at.y}));
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
describe('press and hold', () => {
  test('the happy path: press, hold past HOLD_MS, release keeps the take', () => {
    const w = makeGesture();
    press(w);

    expect(w.el.classList.contains('cyc-pressing')).toBe(true);
    expect(w.spies.onVoiceStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(w.spies.onVoiceStart).toHaveBeenCalledTimes(1);
    expect(w.el.hasAttribute('data-cyc-recording')).toBe(true);
    expect(w.gesture.recordingOwnsButton()).toBe(true);
    expect(w.recPanel.renderRecorder).toHaveBeenCalledWith(
      expect.objectContaining({phase: 'recording'})
    );
    vi.advanceTimersByTime(400);
    release(w);
    expect(w.spies.onVoiceEnd).toHaveBeenCalledWith('release');
    expect(w.spies.onVoiceCancel).not.toHaveBeenCalled();
    expect(w.el.hasAttribute('data-cyc-recording')).toBe(false);
    expect(w.gesture.recordingOwnsButton()).toBe(false);
  });
  test('slide left past 70px cancels, and only a slide cancels', () => {
    const w = makeGesture();
    press(w, {x: 300, y: 600});
    vi.advanceTimersByTime(400);

    document.dispatchEvent(pev('pointermove', {pointerId: 1, clientX: 240, clientY: 600}));
    expect(w.spies.onVoiceCancel).not.toHaveBeenCalled();
    document.dispatchEvent(pev('pointermove', {pointerId: 1, clientX: 200, clientY: 600}));
    expect(w.spies.onVoiceCancel).toHaveBeenCalledTimes(1);
    expect(w.spies.onVoiceEnd).not.toHaveBeenCalled();
    expect(w.el.hasAttribute('data-cyc-recording')).toBe(false);
  });
  test('the slide is anchored at the take, not where the finger landed', () => {
    const w = makeGesture();
    press(w, {x: 400, y: 600});

    document.dispatchEvent(pev('pointermove', {pointerId: 1, clientX: 280, clientY: 600}));
    vi.advanceTimersByTime(400);
    document.dispatchEvent(pev('pointermove', {pointerId: 1, clientX: 279, clientY: 600}));
    expect(w.spies.onVoiceCancel).not.toHaveBeenCalled();
    expect(w.gesture.recordingOwnsButton()).toBe(true);
  });
  test('sliding up onto the lock chip locks the take hands-free', () => {
    const w = makeGesture();
    w.lockChip.getBoundingClientRect = () =>
      ({
        width: 40,
        height: 40,
        x: 300,
        y: 460,
        left: 300,
        top: 460,
        right: 340,
        bottom: 500
      }) as DOMRect;
    press(w, {x: 320, y: 600});
    vi.advanceTimersByTime(400);
    document.dispatchEvent(pev('pointermove', {pointerId: 1, clientX: 320, clientY: 480}));
    expect(w.el.classList.contains('cyc-rec-locked')).toBe(true);

    release(w, {x: 320, y: 480});
    expect(w.spies.onVoiceEnd).not.toHaveBeenCalled();
    expect(w.gesture.recordingOwnsButton()).toBe(true);
  });
  test('a second finger cannot drive the gesture', () => {
    const w = makeGesture();
    press(w, {x: 300, y: 600}, 1);
    vi.advanceTimersByTime(400);

    document.dispatchEvent(pev('pointermove', {pointerId: 2, clientX: 100, clientY: 600}));
    document.dispatchEvent(pev('pointerup', {pointerId: 2, clientX: 100, clientY: 600}));
    expect(w.spies.onVoiceCancel).not.toHaveBeenCalled();
    expect(w.spies.onVoiceEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    release(w, {x: 300, y: 600}, 1);
    expect(w.spies.onVoiceEnd).toHaveBeenCalledWith('release');
  });
  test('pointercancel keeps the audio as an interruption, never a cancel', () => {
    const w = makeGesture();
    press(w);
    vi.advanceTimersByTime(400);
    document.dispatchEvent(pev('pointercancel', {pointerId: 1}));
    expect(w.spies.onVoiceEnd).toHaveBeenCalledWith('interrupted');
    expect(w.spies.onVoiceCancel).not.toHaveBeenCalled();
  });
  test('disabled or voice-off presses never arm a take', () => {
    const w1 = makeGesture({isDisabled: () => true});
    press(w1);
    vi.advanceTimersByTime(1000);
    expect(w1.spies.onVoiceStart).not.toHaveBeenCalled();
    const w2 = makeGesture({voiceEnabled: () => false});
    press(w2);
    vi.advanceTimersByTime(1000);
    expect(w2.spies.onVoiceStart).not.toHaveBeenCalled();
  });
});
describe('the tap table', () => {
  test('a quick tap with content sends and starts nothing', async () => {
    const w = makeGesture();
    w.state.empty = false;
    w.state.text = 'hi';
    press(w);
    vi.advanceTimersByTime(100);
    release(w);
    expect(w.spies.onSend).toHaveBeenCalledWith('hi', undefined);
    expect(w.spies.onVoiceStart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.spies.clear).toHaveBeenCalled();
  });
  test('a quick tap on an empty box locks audio mode, and the trailing click does not end it', () => {
    const w = makeGesture();
    press(w);
    vi.advanceTimersByTime(100);
    release(w);
    expect(w.spies.onVoiceStart).toHaveBeenCalledTimes(1);
    expect(w.el.classList.contains('cyc-rec-locked')).toBe(true);

    w.sendButton.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(w.spies.onVoiceEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    w.sendButton.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(w.spies.onVoiceEnd).toHaveBeenCalledWith('release');
  });
  test('a slow tap (past HOLD_MS, under TAP_MS) with content releases the take and sends', () => {
    const w = makeGesture();
    w.state.empty = false;
    w.state.text = 'words';
    press(w);
    vi.advanceTimersByTime(500);
    expect(w.spies.onVoiceStart).toHaveBeenCalledTimes(1);
    release(w);

    expect(w.spies.onVoiceEnd).toHaveBeenCalledWith('release');
    expect(w.spies.onVoiceCancel).not.toHaveBeenCalled();
    expect(w.spies.onSend).toHaveBeenCalledWith('words', undefined);
  });
  test('a slow tap on an empty box locks the same take instead of discarding it', () => {
    const w = makeGesture();
    press(w);
    vi.advanceTimersByTime(500);
    release(w);
    expect(w.el.classList.contains('cyc-rec-locked')).toBe(true);
    expect(w.spies.onVoiceEnd).not.toHaveBeenCalled();
    expect(w.spies.onVoiceCancel).not.toHaveBeenCalled();
  });
});
describe('send triggers', () => {
  test('Enter sends; Shift+Enter does not', () => {
    const w = makeGesture();
    w.state.empty = false;
    w.state.text = 'typed';
    w.input.dispatchEvent(
      new KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, bubbles: true})
    );
    expect(w.spies.onSend).not.toHaveBeenCalled();
    w.input.dispatchEvent(
      new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true})
    );
    expect(w.spies.onSend).toHaveBeenCalledWith('typed', undefined);
  });
  test('with voice off the click is a plain send', () => {
    const w = makeGesture({voiceEnabled: () => false});
    w.state.empty = false;
    w.state.text = 'plain';
    w.sendButton.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(w.spies.onSend).toHaveBeenCalledWith('plain', undefined);

    w.spies.onSend.mockClear();
    w.state.empty = true;
    w.state.text = '';
    w.sendButton.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(w.spies.onSend).not.toHaveBeenCalled();
  });
  test('doSend waits its bounded ten seconds for an unstaged clip, then marks it lost and goes', () => {
    const w = makeGesture();
    w.state.empty = false;
    const clip = {durationS: 2, text: 'hello'};
    w.blocks.push({kind: 'voice', clip});
    w.gesture.doSend();

    expect(clip).toMatchObject({waiting: true});
    expect(w.spies.onSend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10200);
    expect(clip).toMatchObject({waiting: false, lost: true});

    expect(w.spies.onSend).toHaveBeenCalledWith('hello', undefined);
    expect(w.spies.renderBlocks).toHaveBeenCalled();
  });
  test('the clip arriving inside the window releases the send at once', () => {
    const w = makeGesture();
    w.state.empty = false;
    const block: ComposerBlock = {kind: 'voice', clip: {durationS: 2, text: 'kept'}};
    w.blocks.push(block);
    w.gesture.doSend();
    vi.advanceTimersByTime(300);
    expect(w.spies.onSend).not.toHaveBeenCalled();

    (block as any).staged = {
      file: new File(['a'], 't.webm'),
      upload: null,
      progress: 0,
      done: true,
      error: null
    };
    vi.advanceTimersByTime(200);

    expect(w.spies.onSend).toHaveBeenCalledWith('kept', undefined);
    expect(clipNotLost(block)).toBe(true);
  });
});
function clipNotLost(b: ComposerBlock): boolean {
  return b.kind === 'voice' && !b.clip.lost;
}
describe('the box clears once the send is durable', () => {
  test('text: the box keeps the words until onSend settles true, and keeps them on false', async () => {
    let settle: (ok: boolean) => void = () => {};
    const onSend = vi.fn(() => new Promise<boolean>((r) => (settle = r)));
    const w = makeGesture({onSend});
    w.state.empty = false;
    w.state.text = 'keep me';
    w.gesture.doSend();
    expect(onSend).toHaveBeenCalledWith('keep me', undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.spies.clear).not.toHaveBeenCalled();
    // A second press while the first is committing is nothing.
    w.gesture.doSend();
    expect(onSend).toHaveBeenCalledTimes(1);
    settle(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.spies.clear).not.toHaveBeenCalled();
    // The box is free again: the next press goes, and a durable send clears.
    w.gesture.doSend();
    expect(onSend).toHaveBeenCalledTimes(2);
    settle(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.spies.clear).toHaveBeenCalledTimes(1);
  });
  test('attachments: the blocks stay in the box until onAttach settles, then those blocks go', async () => {
    let settle: () => void = () => {};
    let refuse: (err: Error) => void = () => {};
    const file = new File(['a'], 'a.txt');
    const st = {file, upload: null as null, progress: 0, done: true, error: null as null};
    const block = {kind: 'attach', staged: st} as unknown as ComposerBlock;
    const onAttach = vi.fn(
      () =>
        new Promise<void>((r, j) => {
          settle = r;
          refuse = j;
        })
    );
    const w = makeGesture({staged: () => [st], onAttach});
    w.blocks.push(block);
    w.state.empty = false;
    w.gesture.doSend();
    expect(onAttach).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.spies.clear).not.toHaveBeenCalled();
    expect(w.blocks).toContain(block);
    w.gesture.doSend();
    expect(onAttach).toHaveBeenCalledTimes(1);
    // Refused: the blocks never left the box, nothing to put back.
    refuse(new Error('no live engine'));
    await vi.advanceTimersByTimeAsync(0);
    expect(w.spies.clear).not.toHaveBeenCalled();
    expect(w.blocks).toContain(block);
    // Durable: exactly the blocks of that send go.
    w.gesture.doSend();
    expect(onAttach).toHaveBeenCalledTimes(2);
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.spies.clear).toHaveBeenCalledWith([block]);
  });
});
// R6: a send that is neither on disk nor taken yet settles {kept}: the box
// keeps the words, but the send is still in flight in memory. If the engine
// takes it later, the box clears (when it still holds that exact send); a
// press of the unchanged box meanwhile is nothing, so one send never goes
// out twice under two cids.
describe('a kept send clears on dispatch and temporarily prevents duplicates', () => {
  type Kept = {kept: Promise<boolean>};
  const keptSend = () => {
    let taken: (ok: boolean) => void = () => {};
    const kept = new Promise<boolean>((r) => (taken = r));
    const onSend = vi.fn((): Promise<boolean | Kept> => Promise.resolve({kept}));
    return {onSend, taken: (ok: boolean) => taken(ok)};
  };
  test('text: a hung durable write clears on dispatch, releases the gate, and prevents duplicates until delivery', async () => {
    const {onSend, taken} = keptSend();
    const w = makeGesture({onSend});
    w.state.empty = false;
    w.state.text = 'keep me';
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(w.spies.clear).toHaveBeenCalledTimes(1);
    // Enter again on the unchanged box: not a second wire send.
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSend).toHaveBeenCalledTimes(1);
    // A different send is never gated by the hanging write.
    w.state.text = 'next one';
    onSend.mockImplementationOnce(() => Promise.resolve(true));
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith('next one', undefined);
    // Disk time does not release the record: the engine may already have the
    // first cid even after the durable write has stalled for a long time.
    w.state.text = 'keep me';
    await vi.advanceTimersByTimeAsync(10_001);
    w.gesture.doSend();
    expect(onSend).toHaveBeenCalledTimes(2);
    taken(true);
    await vi.advanceTimersByTimeAsync(0);
    onSend.mockImplementationOnce(() => Promise.resolve(true));
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSend).toHaveBeenCalledTimes(3);
  });
  test('text: different words while kept are a new send; taken late does not clear the edited box', async () => {
    const {onSend, taken} = keptSend();
    const w = makeGesture({onSend});
    w.state.empty = false;
    w.state.text = 'keep me';
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSend).toHaveBeenCalledTimes(1);
    w.state.text = 'keep me, edited';
    onSend.mockImplementationOnce(() => Promise.resolve(true));
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith('keep me, edited', undefined);
    expect(w.spies.clear).toHaveBeenCalledTimes(2);
    w.spies.clear.mockClear();
    w.state.text = 'third';
    // The first send is taken now, but the box holds other words: not cleared.
    taken(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.spies.clear).not.toHaveBeenCalled();
  });
  test('text: a kept send gone untaken (discarded) frees the box; the same press then sends anew', async () => {
    const {onSend, taken} = keptSend();
    const w = makeGesture({onSend});
    w.state.empty = false;
    w.state.text = 'keep me';
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    taken(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.spies.clear).toHaveBeenCalledTimes(1);
    onSend.mockImplementationOnce(() => Promise.resolve(true));
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(w.spies.clear).toHaveBeenCalledTimes(2);
  });
  test('attachments: kept keeps the blocks, a repeat press is nothing, taken late clears those blocks', async () => {
    let taken: (ok: boolean) => void = () => {};
    const kept = new Promise<boolean>((r) => (taken = r));
    const file = new File(['a'], 'a.txt');
    const st = {file, upload: null as null, progress: 0, done: true, error: null as null};
    const block = {kind: 'attach', staged: st} as unknown as ComposerBlock;
    const onAttach = vi.fn((): Promise<void | Kept> => Promise.resolve({kept}));
    const w = makeGesture({staged: () => [st], onAttach});
    w.blocks.push(block);
    w.state.empty = false;
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(w.spies.clear).toHaveBeenCalledWith([block]);
    expect(w.blocks).toContain(block);
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(onAttach).toHaveBeenCalledTimes(1);
    taken(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.spies.clear).toHaveBeenCalledWith([block]);
  });
});

// The kept record belongs to the chat the press was made in (the box's
// owner): the same words in another chat are a new message, a late take
// clears only its own chat's box, and the record outlives a switch away and
// back.
describe("a kept send is the chat's own", () => {
  type Kept = {kept: Promise<boolean>};
  const keptSend = () => {
    let taken: (ok: boolean) => void = () => {};
    const kept = new Promise<boolean>((r) => (taken = r));
    const onSend = vi.fn((): Promise<boolean | Kept> => Promise.resolve({kept}));
    return {onSend, taken: (ok: boolean) => taken(ok)};
  };
  const owned = (over: Partial<ComposerRecordGestureDeps>) => {
    const box = {owner: 'A' as string | null};
    const w = makeGesture({boxOwner: () => box.owner, ...over});
    return {w, box};
  };
  test('the same words pressed in another chat send normally, under a new send', async () => {
    const {onSend} = keptSend();
    const {w, box} = owned({onSend});
    w.state.empty = false;
    w.state.text = 'same words';
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSend).toHaveBeenCalledTimes(1);
    // Chat B, the same words in its box: not A's kept send.
    box.owner = 'B';
    onSend.mockImplementationOnce(() => Promise.resolve(true));
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(w.spies.clear).toHaveBeenCalledTimes(2);
  });
  test("a late take clears only its own chat's box; another chat showing the same words is untouched", async () => {
    const {onSend, taken} = keptSend();
    const {w, box} = owned({onSend});
    w.state.empty = false;
    w.state.text = 'same words';
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    // Chat B is in the box when A's durable write lands.
    box.owner = 'B';
    taken(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.spies.clear).toHaveBeenCalledTimes(1);
    // A's record is settled: back in A, the same words are a new send.
    box.owner = 'A';
    onSend.mockImplementationOnce(() => Promise.resolve(true));
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSend).toHaveBeenCalledTimes(2);
  });
  test('the record survives a switch away and back: Enter in the reopened chat is still the kept press', async () => {
    const {onSend, taken} = keptSend();
    const {w, box} = owned({onSend});
    w.state.empty = false;
    w.state.text = 'keep me';
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    box.owner = 'B';
    w.state.text = '';
    w.state.empty = true;
    box.owner = 'A';
    w.state.text = 'keep me';
    w.state.empty = false;
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSend).toHaveBeenCalledTimes(1);
    // Taken while A is back in the box: cleared.
    taken(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.spies.clear).toHaveBeenCalledTimes(1);
  });
  test('two chats each keep their own send; each late take clears its own box only', async () => {
    const a = keptSend();
    const b = keptSend();
    const onSend = vi.fn((): Promise<boolean | Kept> => a.onSend());
    const {w, box} = owned({onSend});
    w.state.empty = false;
    w.state.text = 'for a';
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    box.owner = 'B';
    w.state.text = 'for b';
    onSend.mockImplementationOnce(() => b.onSend());
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSend).toHaveBeenCalledTimes(2);
    // Both visible sends clear when dispatched; their late settles do not alter the box.
    a.taken(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.spies.clear).toHaveBeenCalledTimes(2);
    b.taken(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.spies.clear).toHaveBeenCalledTimes(2);
  });
  test("a durable send that settles after the box changed chats does not clear the other chat's box", async () => {
    let settle: (ok: boolean) => void = () => {};
    const onSend = vi.fn((): Promise<boolean> => new Promise((r) => (settle = r)));
    const {w, box} = owned({onSend});
    w.state.empty = false;
    w.state.text = 'slow write';
    w.gesture.doSend();
    await vi.advanceTimersByTimeAsync(0);
    box.owner = 'B';
    w.state.text = 'b draft';
    settle(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.spies.clear).not.toHaveBeenCalled();
  });
});
