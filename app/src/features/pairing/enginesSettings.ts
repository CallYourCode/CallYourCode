/* The settings Engines section: every engine the app server announces, split
 * into paired (this device holds its E2E key) and not-yet-paired (a Pair row
 * that opens the existing pairing screen for that engine). List and pair
 * only; rename/remove management is deliberately out of scope here (removing
 * a key is a security action with live-connection consequences and gets its
 * own decided flow, not a side door).
 */

import {h} from '@/components/domHelpers';
import {settingsCard, row} from '@/components/widgets';
import type {AppEngineInfo} from '@/engine/contract';
import {openPairingScreen} from './screen';
import {knownEngines, onKnownEnginesChange, type KnownEngines} from './discovery';

export function createEnginesSection(opts: {onTeardown(d: () => void): void}): HTMLElement {
  const listEl = h('div', 'cyc-engines-list');
  const card = settingsCard(
    {
      heading: 'Engines',
      footer:
        'Machines announcing to this app server. Pairing takes the key that ' +
        '`cyc pair` prints on that machine; only your devices ever hold it.'
    },
    listEl
  );
  card.classList.add('cyc-engines-section');

  let alive = true;
  opts.onTeardown(() => {
    alive = false;
  });

  const pairedRow = (e: AppEngineInfo): HTMLElement => {
    const r = row({icon: 'lock', title: e.userHost, subtitle: 'paired end-to-end'});
    r.dataset.cycEngine = e.engineId;
    r.dataset.cycPairState = 'paired';
    return r;
  };

  const unpairedRow = (e: AppEngineInfo): HTMLElement => {
    const r = row({
      icon: 'qr',
      title: e.userHost,
      subtitle: 'announced, not paired with this device',
      rightContent: 'Pair',
      clickable: () => openPairingScreen(e.engineId)
    });
    r.querySelector('.cyc-list-row-right-muted')?.classList.add(
      'text-[var(--cyc-accent)]!',
      'font-medium'
    );
    r.dataset.cycEngine = e.engineId;
    r.dataset.cycPairState = 'unpaired';
    return r;
  };

  const paint = async () => {
    const known = await knownEngines().catch((): KnownEngines | null => null);
    if (!alive || !known) return;
    const rows = [...known.paired.map(pairedRow), ...known.unpaired.map(unpairedRow)];
    if (!rows.length) {
      rows.push(
        row({
          icon: 'info',
          title: 'No engines announced',
          subtitle: 'run cyc on a machine that can reach this app server'
        })
      );
    }
    listEl.replaceChildren(...rows);
  };

  opts.onTeardown(
    onKnownEnginesChange(() => {
      void paint();
    })
  );
  void paint();
  return card;
}
