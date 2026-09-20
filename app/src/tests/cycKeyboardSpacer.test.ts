import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// The scroll clearance engine (features/chat/scrolling.ts) applies the sum of all
// clearance claims as an inline margin-bottom on the `.cyc-message-list-pad-bottom`
// spacer and compensates scrollTop. The keyboard claim is the several-hundred-px
// band that showed as an empty patterned strip above the composer once the
// keyboard closed. These tests lock: a SHRINK of the total (keyboard closing)
// clears the margin even when the reader is scrolled up or a pointer is down,
// while a GROWTH while scrolled up is still deferred (protect-the-reader), and
// teardown never orphans a margin.

function buildThread() {
  document.body.innerHTML = '';
  const thread = document.createElement('div');
  thread.className = 'cyc-thread';
  const scroll = document.createElement('div');
  scroll.className = 'cyc-message-list-scroll';
  const pad = document.createElement('div');
  pad.className = 'cyc-message-list-pad-bottom';
  const composer = document.createElement('div');
  composer.className = 'cyc-composer cyc-composer-main';
  const bar = document.createElement('div');
  composer.append(bar);
  scroll.append(pad);
  thread.append(scroll, composer);
  document.body.append(thread);
  return {scroll, pad, bar};
}

// jsdom reports 0 for scrollHeight/clientHeight; set them so distanceToEnd (=
// scrollHeight - scrollTop - clientHeight, recomputed on each scroll event) can be
// driven to a "scrolled up into history" value.
function setGeometry(scroll: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(scroll, 'scrollHeight', {value: scrollHeight, configurable: true});
  Object.defineProperty(scroll, 'clientHeight', {value: clientHeight, configurable: true});
}

function kbinset(px: number) {
  window.dispatchEvent(new CustomEvent('cyc:kbinset', {detail: px}));
}

async function loadEngine() {
  vi.resetModules();
  return await import('../features/chat/scrolling');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('keyboard clearance spacer', () => {
  test('a claim shrinking from K to 0 clears the margin even while scrolled up', async () => {
    const {trackKeyboardInset} = await loadEngine();
    const {scroll, pad, bar} = buildThread();
    const teardown = trackKeyboardInset(bar);

    // Keyboard opens while near the bottom: the spacer takes the full inset.
    kbinset(300);
    expect(pad.style.marginBottom).toBe('300px');

    // Reader scrolls up into history (distanceToEnd large). The growth stays put.
    setGeometry(scroll, 2000, 500);
    scroll.scrollTop = 500; // distanceToEnd = 2000 - 500 - 500 = 1000 (scrolled up)
    scroll.dispatchEvent(new Event('scroll'));
    expect(pad.style.marginBottom).toBe('300px');

    // Keyboard closes. Even though the reader is still scrolled up, the SHRINK
    // toward zero must land (this is the empty-band fix), with a compensating
    // scrollTop write so content stays anchored.
    const before = scroll.scrollTop;
    kbinset(0);
    expect(pad.style.marginBottom).toBe('');
    expect(scroll.scrollTop).toBe(before - 300);

    teardown();
  });

  test('a shrink lands even with a pointer down', async () => {
    const {trackKeyboardInset} = await loadEngine();
    const {scroll, pad, bar} = buildThread();
    const teardown = trackKeyboardInset(bar);

    kbinset(300);
    expect(pad.style.marginBottom).toBe('300px');

    document.dispatchEvent(new Event('pointerdown', {bubbles: true}));
    setGeometry(scroll, 2000, 500);
    scroll.scrollTop = 500;
    scroll.dispatchEvent(new Event('scroll'));

    kbinset(0);
    expect(pad.style.marginBottom).toBe('');

    teardown();
  });

  test('a GROWTH while scrolled up is still deferred, then resolves near the bottom', async () => {
    const {trackKeyboardInset} = await loadEngine();
    const {scroll, pad, bar} = buildThread();
    const teardown = trackKeyboardInset(bar);

    // Scroll up into history first.
    setGeometry(scroll, 2000, 500);
    scroll.scrollTop = 500;
    scroll.dispatchEvent(new Event('scroll'));

    // Keyboard opens while scrolled up: growth is deferred to protect the reader.
    kbinset(300);
    expect(pad.style.marginBottom).toBe('');

    // The reader scrolls back to the bottom: the deferred growth now applies.
    setGeometry(scroll, 2000, 500);
    scroll.scrollTop = 1500;
    scroll.dispatchEvent(new Event('scroll'));
    expect(pad.style.marginBottom).toBe('300px');

    teardown();
  });

  test('a keyboard-dismissal rAF re-run reaches zero applied', async () => {
    const {trackKeyboardInset} = await loadEngine();
    const {pad, bar} = buildThread();
    const teardown = trackKeyboardInset(bar);

    kbinset(300);
    expect(pad.style.marginBottom).toBe('300px');

    kbinset(0);
    // The synchronous settle already cleared it; the scheduled rAF re-run is a
    // belt-and-suspenders pass and must leave the margin at the base.
    vi.runOnlyPendingTimers();
    expect(pad.style.marginBottom).toBe('');

    teardown();
  });

  // grep token: `machine tag`. The compensating scrollTop write is the one that,
  // mid keyboard dismissal, lands inside another chat's open-landing window; it
  // MUST register on the shared machine-scroll tag so the surface's scroll
  // listener reads it as an app write, not a reader taking the landing.
  test('the settle compensation write registers as a machine scroll (shared tag)', async () => {
    const {trackKeyboardInset} = await loadEngine();
    // Import AFTER loadEngine's resetModules so this is the SAME module instance
    // scrolling.ts writes into (a fresh registry gives a fresh WeakMap owner).
    const {isMachineTop} = await import('../features/chat/surface/machineScroll');
    const {scroll, bar} = buildThread();
    const teardown = trackKeyboardInset(bar);

    // Opening the keyboard near the bottom applies the growth with a compensating
    // write; that write is tagged.
    kbinset(300);
    expect(scroll.scrollTop).toBe(300);
    expect(isMachineTop(scroll, scroll.scrollTop)).toBe(true);

    // The dismissal shrink write is tagged the same way.
    const before = scroll.scrollTop;
    kbinset(0);
    expect(scroll.scrollTop).toBe(before - 300);
    expect(isMachineTop(scroll, scroll.scrollTop)).toBe(true);

    // A top the machine never wrote does not read as machine.
    expect(isMachineTop(scroll, scroll.scrollTop + 50)).toBe(false);

    teardown();
  });

  test('teardown clears a stranded margin (release does not orphan)', async () => {
    const {trackKeyboardInset} = await loadEngine();
    const {pad, bar} = buildThread();
    const teardown = trackKeyboardInset(bar);

    // Simulate an orphaned margin with no live claim (desired() === 0).
    pad.style.marginBottom = '300px';

    teardown();
    expect(pad.style.marginBottom).toBe('');
  });
});
