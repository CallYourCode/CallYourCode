import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {installStaleTabReload} from '../bundleReload';
import {cyclog} from '../shared/logging';
import {toast} from '../components/widgets';

const state = vi.hoisted(() => ({unsent: false, recording: false}));
vi.mock('../engine/store', () => ({syncStatus: () => 'offline', onSyncStatus: vi.fn()}));
vi.mock('../audio/pipeline', () => ({
  pipeline: {
    get captureBusy() {
      return state.recording;
    }
  }
}));
vi.mock('../components/widgets', () => ({toast: vi.fn()}));
vi.mock('../shared/logging', () => ({cyclog: vi.fn()}));
vi.mock('../sessionState', () => ({
  unsentWork: {busy: () => state.unsent},
  vaultHolds: {writing: 0}
}));

let foreground: () => void;
let served = '100';
const replace = vi.fn();
const fetchStamp = vi.fn(async () => ({ok: true, text: async () => `Build stamp: ${served}`}));
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  state.unsent = false;
  state.recording = false;
  served = '100';
  vi.stubGlobal('fetch', fetchStamp);
  vi.stubGlobal('location', {href: 'http://localhost/', replace});
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, handler) => {
    if (type === 'visibilitychange') foreground = handler as () => void;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('engine unreachable at boot still reads the HTTP stamp', async () => {
  installStaleTabReload();
  await flush();
  expect(fetchStamp).toHaveBeenCalledWith('./build.txt', {cache: 'no-store'});
  expect(toast).not.toHaveBeenCalled();
});

test('every return to foreground checks with engine down, but hidden edges do not', async () => {
  installStaleTabReload();
  await flush();
  fetchStamp.mockClear();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  foreground();
  await flush();
  expect(fetchStamp).not.toHaveBeenCalled();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  foreground();
  await flush();
  foreground();
  await flush();
  expect(fetchStamp).toHaveBeenCalledTimes(2);
});

for (const hold of ['recording', 'unsent'] as const) {
  test(`${hold} prevents a stale-build reload even past five minutes with engine down`, async () => {
    installStaleTabReload();
    await flush();
    state[hold] = true;
    served = '200';
    foreground();
    await flush();
    expect(toast).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(cyclog).not.toHaveBeenCalledWith('reload.go', expect.anything());
    expect(replace).not.toHaveBeenCalled();
    state[hold] = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(cyclog).toHaveBeenCalledWith('reload.go', expect.objectContaining({to: '200'}));
    expect(replace).toHaveBeenCalledOnce();
  });
}

test('an older served stamp never schedules a reload with engine down', async () => {
  installStaleTabReload();
  await flush();
  served = '99';
  foreground();
  await flush();
  expect(toast).not.toHaveBeenCalled();
});
