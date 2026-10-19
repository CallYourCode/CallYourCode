import {beforeEach, expect, test, vi} from 'vitest';
const fake = vi.hoisted(() => ({
  replies: {} as Record<
    string,
    {ok: boolean; html: string; height: number; ageMs: number; dedupe?: string; source?: string}
  >,
  rpc: vi.fn(),
  fetch: vi.fn()
}));
vi.mock('../engine/store', () => ({
  tabs: () => [{engineKey: 'a'}, {engineKey: 'b'}],
  cardEngines: () => [{engineKey: 'a'}, {engineKey: 'b'}],
  pluginsOf: () => [{id: 'usage-card', card: {title: 'Plan usage', refreshFloorS: 5}}],
  pluginCardOf: (...args: unknown[]) => fake.fetch(...args),
  pluginRpc: (...args: unknown[]) => fake.rpc(...args)
}));
vi.mock('../sessionSelectors', () => ({
  activeEngineKey: () => 'a',
  cardScope: () => ['a', 'b'],
  hostChipLabel: (key: string) => key,
  PLUGIN_USAGE_ID: 'usage-card'
}));
import {createPluginCardsPane} from '../features/sessions/panes/pluginCardsPane';
import {dataState} from '../sessionState';
beforeEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
  dataState.mode = 'live';
  fake.replies = {
    a: {
      ok: true,
      html: '<b>old host</b>',
      height: 40,
      ageMs: 120000,
      dedupe: 'shared',
      source: 'claude'
    },
    b: {
      ok: true,
      html: '<b>fresh host</b>',
      height: 40,
      ageMs: 1000,
      dedupe: 'shared',
      source: 'codex'
    }
  };
  fake.fetch.mockImplementation(async (key: string) => fake.replies[key]);
});
const mount = async () => {
  const container = document.createElement('div'),
    anchor = document.createElement('div');
  container.append(anchor);
  document.body.append(container);
  const pane = createPluginCardsPane({mountPoints: () => ({container, anchor})});
  pane.markUsageReady();
  await pane.refreshUsage();
  return {pane, container};
};
test('grouped card switches its answer engine, paints optimistically, then settles to engine answer', async () => {
  let release!: (answer: {ok: boolean}) => void;
  fake.rpc.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const {container} = await mount();
  expect(container.querySelectorAll('.cyc-plugincard')).toHaveLength(1);
  const chips = container.querySelector('.cyc-plugincard-hosts')!;
  expect(chips.previousElementSibling?.classList.contains('cyc-plugincard-body')).toBe(true);
  expect(container.querySelector('[data-source="codex"]')?.getAttribute('aria-pressed')).toBe(
    'true'
  );
  container.querySelector<HTMLButtonElement>('[data-source="codex"]')!.click();
  expect(container.querySelector('[data-source="grok"]')?.getAttribute('aria-pressed')).toBe(
    'true'
  );
  await vi.waitFor(() =>
    expect(fake.rpc).toHaveBeenCalledWith('b', 'usage-card', 'set-source', null, {source: 'grok'})
  );
  // Another device can win. Settle to the answer, not the intent or RPC echo.
  fake.replies.b.source = 'claude';
  release({ok: true});
  await vi.waitFor(() =>
    expect(container.querySelector('[data-source="claude"]')?.getAttribute('aria-pressed')).toBe(
      'true'
    )
  );
  expect(fake.fetch).toHaveBeenLastCalledWith('b', 'usage-card', true);
  container.querySelector<HTMLButtonElement>('[data-source="codex"]')!.click();
  await vi.waitFor(() =>
    expect(fake.rpc).toHaveBeenLastCalledWith('b', 'usage-card', 'set-source', null, {
      source: 'codex'
    })
  );
  release({ok: false});
  await vi.waitFor(() =>
    expect(container.querySelector('[data-source="claude"]')?.getAttribute('aria-pressed')).toBe(
      'true'
    )
  );
});
test('disabled DeepSeek sends no RPC and old answers render without any strip', async () => {
  const {pane, container} = await mount();
  container.querySelector<HTMLButtonElement>('[data-source="deepseek"]')!.click();
  expect(fake.rpc).not.toHaveBeenCalled();
  delete fake.replies.a.source;
  delete fake.replies.b.source;
  await pane.refreshUsage();
  expect(container.querySelector('[data-source]')).toBeNull();
  expect(container.querySelector('iframe')).not.toBeNull();
});

test('a poll started during the RPC cannot overwrite the forced answer after settling', async () => {
  const {pane, container} = await mount();
  let releaseRpc!: (answer: {ok: boolean}) => void;
  fake.rpc.mockImplementation(
    () =>
      new Promise((resolve) => {
        releaseRpc = resolve;
      })
  );
  container.querySelector<HTMLButtonElement>('[data-source="codex"]')!.click();
  await vi.waitFor(() => expect(fake.rpc).toHaveBeenCalled());
  let releaseOld!: (answer: typeof fake.replies.b) => void;
  fake.fetch.mockImplementation(async (key: string, _id: string, forced: boolean) => {
    if (key === 'b' && !forced)
      return new Promise((resolve) => {
        releaseOld = resolve;
      });
    return fake.replies[key];
  });
  const oldAnswer = {...fake.replies.b};
  const poll = pane.refreshUsage();
  fake.replies.b = {...fake.replies.b, source: 'grok'};
  releaseRpc({ok: true});
  await vi.waitFor(() => expect(fake.fetch).toHaveBeenLastCalledWith('b', 'usage-card', true));
  await vi.waitFor(() =>
    expect(container.querySelector('[data-source="grok"]')?.getAttribute('aria-pressed')).toBe(
      'true'
    )
  );
  releaseOld(oldAnswer);
  await poll;
  expect(container.querySelector('[data-source="grok"]')?.getAttribute('aria-pressed')).toBe(
    'true'
  );
});

test('quick taps serialize durable writes and preserve the latest optimistic intent', async () => {
  const {container} = await mount();
  const releases: Array<(answer: {ok: boolean}) => void> = [];
  fake.rpc.mockImplementation(
    () =>
      new Promise((resolve) => {
        releases.push(resolve);
      })
  );
  container.querySelector<HTMLButtonElement>('[data-source="codex"]')!.click();
  container.querySelector<HTMLButtonElement>('[data-source="claude"]')!.click();
  expect(container.querySelector('[data-source="claude"]')?.getAttribute('aria-pressed')).toBe(
    'true'
  );
  await vi.waitFor(() => expect(fake.rpc).toHaveBeenCalledTimes(1));
  releases[0]({ok: true});
  await vi.waitFor(() => expect(fake.rpc).toHaveBeenCalledTimes(2));
  expect(fake.rpc).toHaveBeenLastCalledWith('b', 'usage-card', 'set-source', null, {
    source: 'claude'
  });
  fake.replies.b.source = 'claude';
  releases[1]({ok: true});
  await vi.waitFor(() => expect(fake.fetch).toHaveBeenLastCalledWith('b', 'usage-card', true));
  expect(container.querySelector('[data-source="claude"]')?.getAttribute('aria-pressed')).toBe(
    'true'
  );
});
