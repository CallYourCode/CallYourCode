import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// THE OLDER-HISTORY PAGER MUST NOT LOAD OFF THE APP'S OWN RE-SEAT (the go-to-
// bottom runaway). The field (iPhone, 2026-09-30, dev=726ju) tapped go-to-bottom
// on a long chat and the pager answered with a burst: `pager.cover why=fetch
// top=34078` then `history.older`, over and over, while scrollTop was ~34k px --
// nowhere near the top. The go-to-bottom jump re-windowed the virtual list and
// the app re-seated scrollTop UPWARD to hold its anchor; the pager read that
// machine upward move as a reader flicking toward the top and pulled older
// history, dozens of times, growing the model far past its window.
//
// installHistoryPager was already handed an `isMachineScroll` predicate but never
// consulted it. It now gates the scroll-driven fetch on it: an upward move that
// matches the last machine write loads NOTHING. And it asks the ScrollOwner
// whether the view sits at the top of the LOADED history (the model offset), not
// whether the first mounted row meets the viewport: the BZ Distributor
// down-scroll loop (laptop, 2026-10-03) read the virtual window's own edge as
// the top at scrollTop 56k to 203k, and older history loaded 24 times while the
// reader scrolled DOWN. grep token: `pager machine gate`.

const store = vi.hoisted(() => ({
  canOlder: vi.fn(() => true),
  loadOlder: vi.fn(async () => {})
}));
const sel = vi.hoisted(() => ({session: {id: 's1'} as {id: string} | null}));
vi.mock('@/engine/store', () => ({canOlder: store.canOlder, loadOlder: store.loadOlder}));
vi.mock('@/sessionSelectors', () => ({active: () => sel.session}));
vi.mock('@/shared/logging', () => ({cyclog: () => {}}));

import {installHistoryPager} from '@/features/chat/surface/historyPager';

// A container whose scrollTop we drive. The owner's answers are stubbed: the
// machine tag per test, the top as the owner reads it (model offset <= 100 px,
// no bank here).
function mount() {
  const container = document.createElement('div');
  container.className = 'cyc-message-list-scroll';
  document.body.append(container);

  let top = 0;
  Object.defineProperty(container, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    }
  });

  const setTop = (v: number) => {
    container.scrollTop = v;
    container.dispatchEvent(new Event('scroll'));
  };
  return {container, setTop};
}

let machine = false;
function mountPager() {
  const m = mount();
  installHistoryPager({
    container: m.container,
    render: () => {},
    ownsOpening: () => false,
    isAnchoring: () => false,
    isMachineScroll: () => machine,
    atTop: () => m.container.scrollTop <= 100
  });
  return m;
}

beforeEach(() => {
  document.body.innerHTML = '';
  sel.session = {id: 's1'};
  machine = false;
  store.canOlder.mockReturnValue(true);
  store.loadOlder.mockClear();
  (globalThis as unknown as {IntersectionObserver?: unknown}).IntersectionObserver = undefined;
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('pager machine gate: older history loads only when the reader reaches the top', () => {
  test('an upward MACHINE re-seat at the top loads nothing', () => {
    const {setTop} = mountPager();
    setTop(5000); // a downward settle first, arming the upward check
    machine = true;
    setTop(0); // the go-to-bottom re-window's upward re-seat
    expect(store.loadOlder).not.toHaveBeenCalled();
  });

  test('the reader scrolling up to the top loads older history', () => {
    const {setTop} = mountPager();
    setTop(5000);
    setTop(40);
    expect(store.loadOlder).toHaveBeenCalledTimes(1);
  });

  test('an untagged upward move far from the top loads nothing', () => {
    const {setTop} = mountPager();
    // the field: a browser clamp threw the view ~2.7k px up into the blank top
    // spacer, so no mounted row sat above it, at scrollTop 56k; that is not the
    // top of the history
    setTop(59_079);
    setTop(56_358);
    expect(store.loadOlder).not.toHaveBeenCalled();
  });

  test('a wheel pull toward the top loads only at the top', () => {
    const {container, setTop} = mountPager();
    setTop(3000);
    container.dispatchEvent(new WheelEvent('wheel', {deltaY: -100}));
    expect(store.loadOlder).not.toHaveBeenCalled();
    container.scrollTop = 0;
    container.dispatchEvent(new WheelEvent('wheel', {deltaY: -100}));
    expect(store.loadOlder).toHaveBeenCalledTimes(1);
  });
});
