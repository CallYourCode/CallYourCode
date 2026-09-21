import {beforeEach, describe, expect, test, vi} from 'vitest';

const fake = vi.hoisted(() => ({
  response: {
    ok: true,
    html: '<div class="uc">can\'t check right now</div>',
    ageMs: null as number | null,
    height: 48
  },
  cards: [] as Array<{
    title: string;
    update: ReturnType<typeof vi.fn>;
    park: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>
}));

vi.mock('../engine/store', () => ({
  tabs: () => [{engineKey: 'https://engine.example'}],
  cardEngines: () => [{engineKey: 'https://engine.example'}],
  pluginsOf: () => [{id: 'usage-card', card: {title: 'Plan usage', refreshFloorS: 5}}],
  pluginCardOf: vi.fn(async () => fake.response)
}));

vi.mock('../sessionSelectors', () => ({
  activeEngineKey: () => 'https://engine.example',
  cardScope: () => ['https://engine.example'],
  hostChipLabel: () => 'engine.example',
  PLUGIN_USAGE_ID: 'usage-card'
}));

vi.mock('../components/pluginCard', () => ({
  createPluginCard: (title: string) => {
    const update = vi.fn();
    const park = vi.fn();
    const destroy = vi.fn();
    const el = document.createElement('div');
    fake.cards.push({title, update, park, destroy});
    return {
      el,
      update,
      park,
      reveal: vi.fn(),
      poke: vi.fn(),
      flash: vi.fn(),
      destroy
    };
  }
}));

import {createPluginCardsPane} from '../features/sessions/panes/pluginCardsPane';
import {dataState, sessionState} from '../sessionState';
import * as store from '../engine/store';

beforeEach(() => {
  fake.cards = [];
  dataState.mode = 'live';
  sessionState.activeTabId = 'https://engine.example#default';
  vi.clearAllMocks();
});

describe('usage-card transport', () => {
  test('renders a valid cold engine card even when its route has no age or account dedupe', async () => {
    const container = document.createElement('div');
    const anchor = document.createElement('div');
    container.append(anchor);
    const pane = createPluginCardsPane({mountPoints: () => ({container, anchor})});

    pane.markUsageReady();
    pane.paintLimits();
    await vi.waitFor(() => expect(fake.cards).toHaveLength(1));
    await vi.waitFor(() =>
      expect(fake.cards[0]!.update).toHaveBeenCalledWith(
        expect.objectContaining({
          html: fake.response.html,
          height: 48
        })
      )
    );
  });

  test('an engine that never had usage (no active harness) paints no card at all', async () => {
    // A fresh box with no coding harness answers the usage fetch with exactly
    // this refusal; there is no usage to show, so no card must appear (a
    // permanent error card there is noise). An engine with a report keeps its
    // card: the test above stays untouched.
    const orig = {...fake.response};
    (fake as {response: unknown}).response = {
      ok: false,
      error: 'no active harness on this engine answers plan usage'
    };
    try {
      const container = document.createElement('div');
      const anchor = document.createElement('div');
      container.append(anchor);
      const pane = createPluginCardsPane({mountPoints: () => ({container, anchor})});

      pane.markUsageReady();
      pane.paintLimits();
      await vi.waitFor(() => expect(store.pluginCardOf).toHaveBeenCalled());
      // A transient "checking…" card may exist until the refusal lands; the
      // settled state is no visible card: never created, or parked/destroyed
      // by the repaint and never wanted again.
      await vi.waitFor(() => {
        pane.paintLimits();
        const c = fake.cards[0];
        const gone = !c || c.park.mock.calls.length > 0 || c.destroy.mock.calls.length > 0;
        expect(gone).toBe(true);
      });
    } finally {
      (fake as {response: unknown}).response = orig;
    }
  });
});
