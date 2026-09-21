import * as engine from '../../../engine/store';
import {createPluginCard, type PluginCard} from '../../../components/pluginCard';
import {freshnessLabel, takenAtFrom, USAGE_AGING_MS} from '../../../engine/limitsAge';
import {sessionState, dataState} from '../../../sessionState';
import {
  activeEngineKey,
  cardScope,
  hostChipLabel,
  PLUGIN_USAGE_ID
} from '../../../sessionSelectors';

interface PluginCardsDeps {
  mountPoints(): {container: HTMLElement; anchor: Element};
}

export function createPluginCardsPane(deps: PluginCardsDeps) {
  let usageReady = false;

  type UsageAnswer = {
    html: string;
    height: number | null;
    dedupe: string | null;
    takenAt: number | null;
    stale: boolean;
    throttled: boolean;
  } | null;
  type UsageState = {
    answer: UsageAnswer;
    receivedAt: number;
    lastError: string | null;

    inflight: boolean;
    forcedAt: number;
  };
  const pluginCards = new Map<string, PluginCard>();
  const usageByEngine = new Map<string, UsageState>();
  let pluginCardsBusy = false;

  let lastCardTab: string | null = null;

  const clearPluginCards = () => {
    for (const card of pluginCards.values()) {
      card.destroy();
      card.el.remove();
    }
    pluginCards.clear();
  };

  const ensureUsage = (key: string): UsageState => {
    let s = usageByEngine.get(key);
    if (!s) {
      s = {
        answer: null,
        receivedAt: 0,
        lastError: null,
        inflight: false,
        forcedAt: 0
      };
      usageByEngine.set(key, s);
    }
    return s;
  };

  const declaredFloorMs = (key: string): number =>
    (engine.pluginsOf(key).find((p) => p.id === PLUGIN_USAGE_ID)?.card?.refreshFloorS ?? 5) * 1000;

  async function fetchPluginCards(force = false) {
    if (dataState.mode !== 'live') return;
    const engines = engine.cardEngines(PLUGIN_USAGE_ID);
    const active = activeEngineKey();
    pluginCardsBusy = true;
    try {
      await Promise.all(
        engines.map(async ({engineKey}) => {
          const st = ensureUsage(engineKey);
          let doForce = force && engineKey === active;
          if (doForce) {
            if (Date.now() - st.forcedAt < declaredFloorMs(engineKey)) doForce = false;
            else st.forcedAt = Date.now();
          }
          st.inflight = true;
          const ans = await engine.pluginCardOf(engineKey, PLUGIN_USAGE_ID, doForce);
          const now = Date.now();
          st.inflight = false;
          if (ans.ok) {
            st.answer = {
              html: ans.html ?? '',
              height: typeof ans.height === 'number' ? ans.height : null,
              dedupe: ans.dedupe ?? null,
              takenAt: takenAtFrom(ans.ageMs, now),
              stale: ans.stale === true,
              throttled: ans.throttled === true
            };
            st.receivedAt = now;
            st.lastError = null;
          } else {
            st.lastError = ans.error ?? 'engine unreachable';
          }
        })
      );
    } finally {
      pluginCardsBusy = false;
      paintLimits();
    }
  }

  const paintPluginCards = (): void => {
    const liveTabKeys = new Set(engine.tabs().map((t) => t.engineKey));
    for (const k of [...usageByEngine.keys()]) if (!liveTabKeys.has(k)) usageByEngine.delete(k);

    const scope = new Set(cardScope());
    const engines = engine.cardEngines(PLUGIN_USAGE_ID).filter((e) => scope.has(e.engineKey));
    if (!engines.length) {
      clearPluginCards();
      return;
    }

    if (
      !pluginCardsBusy &&
      engines.some((e) => {
        const s = usageByEngine.get(e.engineKey);

        return !s || (!s.answer && !s.lastError && !s.inflight);
      })
    )
      void fetchPluginCards(false);

    const now = Date.now();
    type Group = {
      key: string;
      title: string;
      hosts: string[];
      answer: UsageAnswer;
      everyFailed: boolean;
      loading: boolean;
      neverError: string | null;
    };
    const groups = new Map<string, Group>();
    for (const {engineKey} of engines) {
      const st = usageByEngine.get(engineKey);
      const gkey = st?.answer?.dedupe ?? engineKey;
      let g = groups.get(gkey);
      if (!g) {
        const title =
          engine.pluginsOf(engineKey).find((p) => p.id === PLUGIN_USAGE_ID)?.card?.title ??
          'Plan usage';
        g = {
          key: gkey,
          title,
          hosts: [],
          answer: null,
          everyFailed: true,
          loading: false,
          neverError: null
        };
        groups.set(gkey, g);
      }
      g.hosts.push(hostChipLabel(engineKey));
      const failed = !!st?.lastError;
      if (st?.answer) {
        const a = st.answer;
        if (
          g.answer === null ||
          (a.takenAt != null && (g.answer.takenAt == null || a.takenAt > g.answer.takenAt))
        ) {
          g.answer = a;
        }
      } else if (failed) {
        g.neverError = g.neverError ?? st!.lastError;
      } else {
        g.loading = true;
      }

      g.everyFailed = g.everyFailed && failed;
    }

    const tabChanged = sessionState.activeTabId !== lastCardTab;
    lastCardTab = sessionState.activeTabId;

    const {container, anchor} = deps.mountPoints();
    /* NEVER-ANY-USAGE IS NO CARD. An engine with no active harness answers the
     * usage fetch with exactly this refusal (engine plugins/usage-card
     * foldUsageOverHarnesses), and a box that never produced a report has no
     * usage to show; a permanent error card there is noise (a fresh install
     * with no coding harness). An engine with a report (g.answer, cache
     * included) keeps its card exactly as before. */
    const NO_USAGE = 'no active harness on this engine answers plan usage';
    const wanted = [...groups.values()].filter(
      (g) => g.answer !== null || g.neverError !== NO_USAGE
    );
    const wantedKeys = new Set(wanted.map((g) => g.key));

    const liveKeys = new Set(
      engine
        .cardEngines(PLUGIN_USAGE_ID)
        .map((e) => usageByEngine.get(e.engineKey)?.answer?.dedupe ?? e.engineKey)
    );
    const parkedEls = new Set<Element>();
    for (const [k, card] of [...pluginCards]) {
      if (wantedKeys.has(k)) continue;
      if (liveKeys.has(k)) {
        card.park();
        parkedEls.add(card.el);
      } else {
        card.destroy();
        card.el.remove();
        pluginCards.delete(k);
      }
    }

    let before: Element = anchor;
    for (let i = wanted.length - 1; i >= 0; i--) {
      const g = wanted[i];
      let card = pluginCards.get(g.key);
      const created = !card;
      if (!card) {
        card = createPluginCard(g.title, () => fetchPluginCards(true));
        pluginCards.set(g.key, card);
      }
      const a = g.answer;
      const hosts = g.hosts.length > 1 ? g.hosts : [];
      if (a) {
        const aging = a.stale || (a.takenAt != null && now - a.takenAt >= USAGE_AGING_MS);
        const unreachable = g.everyFailed;
        const age = freshnessLabel({
          takenAt: a.takenAt,
          now,
          loading: false,
          hasNumbers: !!a.html,
          stale: a.stale,
          throttled: a.throttled
        });
        card.update({
          html: a.html,
          hosts,
          ...(a.height != null ? {height: a.height} : {}),
          when: age,
          aging: aging || unreachable,
          errorLine: unreachable ? `engine unreachable, showing ${age || 'old numbers'}` : undefined
        });
      } else {
        const loading = g.loading && !g.neverError;
        card.update({
          html: null,
          hosts,
          loading,
          when: loading ? 'checking…' : '',
          error: g.neverError ?? undefined
        });
      }

      let nextShown = card.el.nextElementSibling;
      while (nextShown && parkedEls.has(nextShown)) nextShown = nextShown.nextElementSibling;
      const moved = card.el.parentElement !== container || nextShown !== before;
      if (moved) container.insertBefore(card.el, before);

      if (!created && moved) card.reveal();
      else if (!created && tabChanged) card.poke();
      before = card.el;
    }
  };

  async function refreshUsage(force = false) {
    if (dataState.mode !== 'live') return;
    if (engine.cardEngines(PLUGIN_USAGE_ID).length) await fetchPluginCards(force);
  }

  const paintLimits = () => {
    if (!usageReady) return;

    paintPluginCards();
  };

  const markUsageReady = () => {
    usageReady = true;
  };

  const retainedAnswer = (engineKey: string): {html: string; height: number | null} | null => {
    const a = usageByEngine.get(engineKey)?.answer ?? null;
    return a ? {html: a.html, height: a.height} : null;
  };

  const flashCards = () => {
    for (const c of pluginCards.values()) c.flash();
  };

  return {paintPluginCards, paintLimits, refreshUsage, markUsageReady, retainedAnswer, flashCards};
}
