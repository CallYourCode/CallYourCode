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
// matches the last machine write loads NOTHING; only an untagged (reader) move
// at the top still loads older. grep token: `pager machine gate`.

const store = vi.hoisted(() => ({
  canOlder: vi.fn(() => true),
  loadOlder: vi.fn(async () => {})
}));
const sel = vi.hoisted(() => ({session: {id: 's1'} as {id: string} | null}));
vi.mock('@/engine/store', () => ({canOlder: store.canOlder, loadOlder: store.loadOlder}));
vi.mock('@/sessionSelectors', () => ({active: () => sel.session}));
vi.mock('@/shared/logging', () => ({cyclog: () => {}}));

import {installHistoryPager} from '@/features/chat/surface/historyPager';

// A container whose scrollTop we drive and whose viewport top is 0, holding a
// first message row that sits AT the container top (so the pager's own
// "first row is well above the fold" cover check does not veto the fetch: the
// only thing standing between an upward move and a load is the machine gate).
function mount() {
  const container = document.createElement('div');
  container.className = 'cyc-message-list-scroll';
  const messages = document.createElement('div');
  const first = document.createElement('div');
  first.className = 'cyc-message';
  messages.append(first);
  container.append(messages);
  document.body.append(container);

  let top = 0;
  Object.defineProperty(container, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    }
  });
  container.getBoundingClientRect = () =>
    ({top: 0, left: 0, right: 390, bottom: 800, width: 390, height: 800, x: 0, y: 0, toJSON() {}}) as DOMRect;
  first.getBoundingClientRect = () =>
    ({top: 0, left: 0, right: 390, bottom: 100, width: 390, height: 100, x: 0, y: 0, toJSON() {}}) as DOMRect;

  const setTop = (v: number) => {
    container.scrollTop = v;
    container.dispatchEvent(new Event('scroll'));
  };
  return {container, messages, setTop};
}

let machine = false;
function pager(container: HTMLElement, messages: HTMLElement) {
  return installHistoryPager({
    container,
    messages,
    render: () => {},
    ownsOpening: () => false,
    isAnchoring: () => false,
    isMachineScroll: () => machine
  });
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

describe('pager machine gate: the older-history pager ignores the app\'s own re-seat', () => {
  test('an upward MACHINE re-seat near the top loads nothing', () => {
    const {container, messages, setTop} = mount();
    pager(container, messages);
    setTop(5000); // a downward settle first, arming lastCoverTop
    machine = true;
    setTop(1000); // the go-to-bottom re-window's upward re-seat
    expect(store.loadOlder).not.toHaveBeenCalled();
  });

  test('an upward READER move near the top still loads older history', () => {
    const {container, messages, setTop} = mount();
    pager(container, messages);
    setTop(5000);
    machine = false;
    setTop(1000); // a genuine reader flick to the top
    expect(store.loadOlder).toHaveBeenCalledTimes(1);
  });

  test('a reader move at the top loads once even right after a machine re-seat', () => {
    const {container, messages, setTop} = mount();
    pager(container, messages);
    setTop(5000);
    machine = true;
    setTop(2000); // app re-seat: ignored
    expect(store.loadOlder).not.toHaveBeenCalled();
    setTop(5000); // re-arm downward
    machine = false;
    setTop(1500); // reader flick: loads
    expect(store.loadOlder).toHaveBeenCalledTimes(1);
  });
});
