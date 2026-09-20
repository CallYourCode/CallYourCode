import {beforeEach, describe, expect, test, vi} from 'vitest';

const fake = vi.hoisted(() => ({
  response: {
    ok: true,
    html: '<div class="uc">can\'t check right now</div>',
    ageMs: null as number | null,
    height: 48
  },
  cards: [] as Array<{title: string; update: ReturnType<typeof vi.fn>}>
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
    const el = document.createElement('div');
    fake.cards.push({title, update});
    return {
      el,
      update,
      park: vi.fn(),
      reveal: vi.fn(),
      poke: vi.fn(),
      flash: vi.fn(),
      destroy: vi.fn()
    };
  }
}));

import {createPluginCardsPane} from '../features/sessions/panes/pluginCardsPane';
import {dataState, sessionState} from '../sessionState';

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
});
