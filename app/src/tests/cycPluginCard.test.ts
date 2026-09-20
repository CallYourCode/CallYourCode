import {afterEach, describe, expect, test} from 'vitest';
import {createPluginCard} from '../components/pluginCard';

describe('plugin cards', () => {
  afterEach(() => document.body.replaceChildren());

  test('loads usage content directly into its sandboxed frame', () => {
    const card = createPluginCard('Plan usage', () => {});
    document.body.append(card.el);

    card.update({html: '<div class="uc">61%</div>', height: 76});

    const frame = card.el.querySelector('iframe');
    expect(frame).toBeTruthy();
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('src')).toBe('/cyc-sandbox.html');
    expect(frame?.srcdoc).toBe('');
    card.destroy();
  });
});

describe('plugin card paints its current geometry/state in TS', () => {
  afterEach(() => document.body.replaceChildren());

  test('the card carries the loading-opacity self-state variant and toggles the state', () => {
    const card = createPluginCard('Plan usage', () => {});
    document.body.append(card.el);
    expect(card.el.className).toContain('[&.cyc-plugincard-loading]:opacity-60');
    expect(card.el.classList.contains('cyc-plugincard-loading')).toBe(false);

    card.update({html: null, loading: true});
    expect(card.el.classList.contains('cyc-plugincard-loading')).toBe(true);
    card.destroy();
  });

  test('the refresh button beats the icon-btn skin with literal `!` utilities', () => {
    const card = createPluginCard('Plan usage', () => {});
    const refresh = card.el.querySelector<HTMLElement>('.cyc-plugincard-refresh')!;
    expect(refresh).not.toBeNull();
    for (const cls of [
      '!absolute',
      '!top-1.5',
      '!end-2',
      '!z-[1]',
      '!flex-none',
      '!w-[1.375rem]',
      '!h-[1.375rem]',
      '!text-[0.9375rem]',
      '!text-[var(--cyc-text-muted)]'
    ]) {
      expect(refresh.className).toContain(cls);
    }
    card.destroy();
  });

  test('host chips no longer carry the dead ms-1.5 (the row-tab margin override is gone)', () => {
    const card = createPluginCard('Plan usage', () => {});
    document.body.append(card.el);
    card.update({html: null, hosts: ['engine.example']});
    const chip = card.el.querySelector<HTMLElement>('.cyc-plugincard-hosts .cyc-list-row-tab')!;
    expect(chip).not.toBeNull();
    expect(chip.className).not.toContain('ms-1.5');
    card.destroy();
  });

  test('the staged frame carries the candidate + aging variants', () => {
    const card = createPluginCard('Plan usage', () => {});
    document.body.append(card.el);
    card.update({html: '<div class="uc">61%</div>', height: 76, aging: true});
    const frame = card.el.querySelector<HTMLElement>('iframe.cyc-plugincard-frame')!;
    expect(frame).not.toBeNull();
    expect(frame.className).toContain('[&.cyc-plugincard-frame-candidate]:absolute');
    expect(frame.className).toContain('[&.cyc-plugincard-frame-candidate]:inset-0');
    expect(frame.className).toContain('[&.cyc-plugincard-frame-candidate]:invisible');
    expect(frame.className).toContain('[&.cyc-plugincard-frame-candidate]:pointer-events-none');
    expect(frame.className).toContain('[.cyc-plugincard-aging_&]:opacity-[0.72]');
    expect(card.el.classList.contains('cyc-plugincard-aging')).toBe(true);
    card.destroy();
  });
});
