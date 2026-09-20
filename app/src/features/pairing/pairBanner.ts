/* The conversation-list pairing affordance: when the app server announces an
 * engine this device holds no E2E key for, a card appears at the top of the
 * session list. Tapping it opens the existing pairing screen targeted at that
 * engine; the user types (or scans) the out-of-band key there. No pairing
 * logic lives here, only the doorway.
 */

import {h} from '@/components/domHelpers';
import {makeIcon} from '@/components/iconGlyphs';
import {avatarView} from '@/components/avatarView';
import type {AppEngineInfo} from '@/engine/contract';
import {openPairingScreen} from './screen';
import {
  knownEngines,
  onKnownEnginesChange,
  startEngineDiscoveryRefresh,
  type KnownEngines
} from './discovery';

export function createPairBanner(opts: {onTeardown(d: () => void): void}): HTMLElement {
  startEngineDiscoveryRefresh();

  const el = h('div', 'cyc-pair-banner cyc-off flex-none flex flex-col gap-2 mx-2 mt-1.5 mb-2');

  let alive = true;
  opts.onTeardown(() => {
    alive = false;
  });

  const rowFor = (info: AppEngineInfo): HTMLElement => {
    const row = h(
      'button',
      [
        'cyc-pair-banner-row cyc-ctl flex w-full items-center gap-3 text-start',
        'px-3! py-2.5! rounded-xl! bg-[var(--cyc-accent-tint)]',
        'border! border-solid! border-[var(--cyc-border-color)]!',
        'fine:hover:bg-(--cyc-text-muted-tint)! fine:active:bg-(--cyc-text-muted-tint)!'
      ].join(' ')
    );
    row.append(
      avatarView(info.host, 38, 'cyc-pair-banner-avatar flex-none', undefined, info.engineId)
    );
    const meta = h('div', 'cyc-pair-banner-meta flex-auto min-w-0');
    const title = h(
      'div',
      'cyc-pair-banner-title overflow-hidden text-ellipsis whitespace-nowrap ' +
        'text-[0.9375rem] font-medium text-[var(--cyc-text)]'
    );
    title.textContent = `New engine: ${info.userHost}`;
    const sub = h(
      'div',
      'cyc-pair-banner-sub mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap ' +
        'text-[0.8125rem] text-[var(--cyc-text-muted)]'
    );
    sub.textContent = 'Not paired with this device yet. Tap to enter its key.';
    meta.append(title, sub);
    const act = h(
      'div',
      'cyc-pair-banner-act flex-none flex items-center gap-1 ' +
        'text-[0.875rem] font-medium text-[var(--cyc-accent)]'
    );
    act.append(
      makeIcon('qr', 'cyc-pair-banner-ico text-[1.25rem] leading-none flex'),
      document.createTextNode('Pair')
    );
    row.append(meta, act);
    row.dataset.cycEngine = info.engineId;
    row.addEventListener('click', () => openPairingScreen(info.engineId));
    return row;
  };

  const paint = async () => {
    const known = await knownEngines().catch((): KnownEngines | null => null);
    if (!alive || !known) return;
    el.replaceChildren(...known.unpaired.map(rowFor));
    el.classList.toggle('cyc-off', known.unpaired.length === 0);
  };

  opts.onTeardown(
    onKnownEnginesChange(() => {
      void paint();
    })
  );
  void paint();
  return el;
}
