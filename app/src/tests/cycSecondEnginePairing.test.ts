/* Second-engine pairing entry points: when the app server announces an engine
 * this device holds no E2E key for, the conversation list grows a banner and
 * settings an Engines row, each opening the EXISTING pairing screen for that
 * engine. The key is typed by the user and enrolls through the same
 * keyring.putKey + pairEngine path first-run pairing uses; no HTTP call ever
 * carries it.
 *
 * Hermetic: the keyring is an in-memory fake, the store is reduced to
 * pairEngine, /config comes from the localStorage snapshot contract.ts reads
 * at import. Modules are re-imported per test so the screen's module state
 * (held params, manual-open latch) starts fresh.
 */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

type KeyRec = {userHost: string; gen?: number; e2e?: boolean; [k: string]: unknown};

const fake = vi.hoisted(() => ({
  recs: new Map<string, KeyRec>(),
  listeners: [] as Array<() => void>,
  putKey: vi.fn(),
  pairEngine: vi.fn()
}));

vi.mock('../engine/keyring', () => ({
  onKeyringChange: (fn: () => void) => {
    fake.listeners.push(fn);
    return () => {
      const i = fake.listeners.indexOf(fn);
      if (i >= 0) fake.listeners.splice(i, 1);
    };
  },
  pairedUserHosts: async () =>
    new Set([...fake.recs.values()].filter((r) => r.gen != null).map((r) => r.userHost)),
  putKey: fake.putKey,
  getByUserHost: async (uh: string) => fake.recs.get(uh) ?? null,
  listKeys: async () => [...fake.recs.values()],
  deleteKey: vi.fn(async () => {}),
  pinEngineIdentity: vi.fn(async () => {}),
  storeGenerations: vi.fn(async () => {})
}));

vi.mock('../engine/store', () => ({pairEngine: fake.pairEngine}));

const ENGINE_A = {url: 'wss://alpha.example', engineId: 'eng-a', host: 'alpha', user: 'ua'};
const ENGINE_B = {url: 'wss://beta.example', engineId: 'eng-b', host: 'beta', user: 'ub'};
const UH_A = 'ua@alpha';
const UH_B = 'ub@beta';

const seedConfig = (engines: unknown[]) =>
  localStorage.setItem('cyc-config', JSON.stringify({engines, voice: null}));

const pairInFake = (userHost: string) => {
  fake.recs.set(userHost, {userHost, gen: 1, e2e: true});
};

const fireKeyring = () => fake.listeners.forEach((f) => f());

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

let teardowns: Array<() => void> = [];
const onTeardown = (d: () => void) => teardowns.push(d);

const fetches: string[] = [];

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = '';
  fake.recs.clear();
  fake.listeners.length = 0;
  fake.putKey.mockReset().mockImplementation(async (rec: KeyRec) => {
    fake.recs.set(rec.userHost, rec);
    fireKeyring();
  });
  fake.pairEngine.mockReset().mockResolvedValue(undefined);
  fetches.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: {body?: unknown}) => {
      fetches.push(`${String(input)} ${String(init?.body ?? '')}`);
      throw new Error('offline test');
    })
  );
});

afterEach(() => {
  teardowns.forEach((d) => d());
  teardowns = [];
  vi.unstubAllGlobals();
});

const mountScreen = async () => {
  const {mountPairingScreen} = await import('../features/pairing/screen');
  const root = document.createElement('div');
  document.body.append(root);
  const activeLog: boolean[] = [];
  mountPairingScreen(root, (a) => activeLog.push(a));
  await settle();
  return {root, activeLog};
};

const screenEl = (root: HTMLElement) => root.querySelector<HTMLElement>('.cyc-pairing');
const screenHidden = (root: HTMLElement) => !!screenEl(root)?.classList.contains('hidden!');

describe('discovery split', () => {
  test('unpaired-known engines are exactly the announced-minus-paired set', async () => {
    seedConfig([ENGINE_A, ENGINE_B]);
    pairInFake(UH_B);
    const {knownEngines} = await import('../features/pairing/discovery');
    const known = await knownEngines();
    expect(known.unpaired.map((e) => e.engineId)).toEqual(['eng-a']);
    expect(known.paired.map((e) => e.engineId)).toEqual(['eng-b']);
  });
});

describe('conversation-list banner', () => {
  test('an unpaired known engine surfaces a row; paired ones do not', async () => {
    seedConfig([ENGINE_A, ENGINE_B]);
    pairInFake(UH_B);
    const {createPairBanner} = await import('../features/pairing/pairBanner');
    const banner = createPairBanner({onTeardown});
    document.body.append(banner);
    await settle();
    const rows = banner.querySelectorAll<HTMLElement>('.cyc-pair-banner-row');
    expect(rows.length).toBe(1);
    expect(rows[0].dataset.cycEngine).toBe('eng-a');
    expect(banner.classList.contains('cyc-off')).toBe(false);
    expect(banner.textContent).toContain(UH_A);
    expect(banner.textContent).not.toContain(UH_B);
  });

  test('with every known engine paired the banner is absent', async () => {
    seedConfig([ENGINE_B]);
    pairInFake(UH_B);
    const {createPairBanner} = await import('../features/pairing/pairBanner');
    const banner = createPairBanner({onTeardown});
    await settle();
    expect(banner.classList.contains('cyc-off')).toBe(true);
    expect(banner.querySelectorAll('.cyc-pair-banner-row').length).toBe(0);
  });

  test('the banner clears once the engine pairs (keyring change repaints)', async () => {
    seedConfig([ENGINE_A]);
    pairInFake(UH_B);
    const {createPairBanner} = await import('../features/pairing/pairBanner');
    const banner = createPairBanner({onTeardown});
    await settle();
    expect(banner.querySelectorAll('.cyc-pair-banner-row').length).toBe(1);
    pairInFake(UH_A);
    fireKeyring();
    await settle();
    expect(banner.classList.contains('cyc-off')).toBe(true);
  });

  test('tapping the banner opens the pairing screen targeting that engine', async () => {
    seedConfig([ENGINE_A, ENGINE_B]);
    pairInFake(UH_B);
    const {root} = await mountScreen();
    expect(screenEl(root)).not.toBeNull();
    expect(screenHidden(root)).toBe(true);

    const {createPairBanner} = await import('../features/pairing/pairBanner');
    const banner = createPairBanner({onTeardown});
    document.body.append(banner);
    await settle();
    banner.querySelector<HTMLElement>('.cyc-pair-banner-row')!.click();
    await settle();

    expect(screenHidden(root)).toBe(false);
    const idEl = root.querySelector('.cyc-pairing-row-id');
    expect(idEl?.textContent).toContain('eng-a');
    const input = root.querySelector<HTMLInputElement>('.cyc-pairing-input');
    expect(document.activeElement).toBe(input);
  });
});

describe('takeover rule', () => {
  test('first run (nothing paired) keeps the full-screen takeover, no dismiss', async () => {
    seedConfig([ENGINE_A]);
    const {root} = await mountScreen();
    expect(screenHidden(root)).toBe(false);
    const dismiss = root.querySelector<HTMLElement>('.cyc-pairing-close');
    expect(dismiss?.classList.contains('hidden!')).toBe(true);
  });

  test('with an engine paired the screen stays hidden until opened, then closes', async () => {
    seedConfig([ENGINE_A, ENGINE_B]);
    pairInFake(UH_B);
    const {root} = await mountScreen();
    expect(screenHidden(root)).toBe(true);

    const {openPairingScreen} = await import('../features/pairing/screen');
    openPairingScreen('eng-a');
    await settle();
    expect(screenHidden(root)).toBe(false);
    const dismiss = root.querySelector<HTMLElement>('.cyc-pairing-close')!;
    expect(dismiss.classList.contains('hidden!')).toBe(false);
    dismiss.click();
    expect(screenHidden(root)).toBe(true);
  });
});

describe('enroll path reuse and key custody', () => {
  test('a typed key enrolls through keyring.putKey + pairEngine; no HTTP call carries it', async () => {
    seedConfig([ENGINE_A, ENGINE_B]);
    pairInFake(UH_B);
    const {root} = await mountScreen();
    const {openPairingScreen} = await import('../features/pairing/screen');
    openPairingScreen('eng-a');
    await settle();

    const {b64urlencode} = await import('@shared/e2e');
    const keyBytes = new Uint8Array(32).fill(7);
    const keyText = b64urlencode(keyBytes);

    const input = root.querySelector<HTMLInputElement>('.cyc-pairing-input')!;
    input.value = keyText;
    root.querySelector<HTMLElement>('.cyc-pairing-pair')!.click();
    await settle(10);

    expect(fake.putKey).toHaveBeenCalledTimes(1);
    expect(fake.putKey.mock.calls[0][0]).toMatchObject({userHost: UH_A, e2e: true});
    expect(fake.pairEngine).toHaveBeenCalledWith(ENGINE_A.url, UH_A);
    // Mechanical custody check: nothing on the network saw the key.
    expect(fetches.filter((f) => f.includes(keyText))).toEqual([]);
  });

  test('a malformed key is refused without touching the keyring', async () => {
    seedConfig([ENGINE_A]);
    pairInFake(UH_B);
    const {root} = await mountScreen();
    const {openPairingScreen} = await import('../features/pairing/screen');
    openPairingScreen('eng-a');
    await settle();

    const input = root.querySelector<HTMLInputElement>('.cyc-pairing-input')!;
    input.value = 'not-a-key';
    root.querySelector<HTMLElement>('.cyc-pairing-pair')!.click();
    await settle(10);

    expect(fake.putKey).not.toHaveBeenCalled();
    expect(fake.pairEngine).not.toHaveBeenCalled();
  });
});

describe('settings Engines section', () => {
  test('lists paired and known-unpaired engines; Pair opens the screen', async () => {
    seedConfig([ENGINE_A, ENGINE_B]);
    pairInFake(UH_B);
    const {root} = await mountScreen();
    const {createEnginesSection} = await import('../features/pairing/enginesSettings');
    const card = createEnginesSection({onTeardown});
    document.body.append(card);
    await settle();

    const rows = [...card.querySelectorAll<HTMLElement>('[data-cyc-pair-state]')];
    const states = rows.map((r) => [r.dataset.cycEngine, r.dataset.cycPairState]);
    expect(states).toContainEqual(['eng-b', 'paired']);
    expect(states).toContainEqual(['eng-a', 'unpaired']);

    const unpaired = rows.find((r) => r.dataset.cycPairState === 'unpaired')!;
    expect(unpaired.textContent).toContain('Pair');
    expect(screenHidden(root)).toBe(true);
    unpaired.click();
    await settle();
    expect(screenHidden(root)).toBe(false);
  });

  test('a freshly paired engine moves to the paired list', async () => {
    seedConfig([ENGINE_A]);
    const {createEnginesSection} = await import('../features/pairing/enginesSettings');
    const card = createEnginesSection({onTeardown});
    await settle();
    expect(card.querySelector<HTMLElement>('[data-cyc-engine="eng-a"]')?.dataset.cycPairState).toBe(
      'unpaired'
    );
    pairInFake(UH_A);
    fireKeyring();
    await settle();
    expect(card.querySelector<HTMLElement>('[data-cyc-engine="eng-a"]')?.dataset.cycPairState).toBe(
      'paired'
    );
  });
});
