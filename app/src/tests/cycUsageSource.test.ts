import {afterEach, describe, expect, test, vi} from 'vitest';
import {createPluginCard} from '../components/pluginCard';

describe('usage source strip', () => {
  afterEach(() => document.body.replaceChildren());
  test('active rotates through four sources and every dim logo jumps directly', () => {
    const onSourceChange = vi.fn();
    const card = createPluginCard('Plan usage', () => {});
    document.body.append(card.el);
    for (const [source, next] of [
      ['claude', 'codex'],
      ['codex', 'grok'],
      ['grok', 'deepseek'],
      ['deepseek', 'claude']
    ] as const) {
      card.update({html: '<b>usage</b>', source, onSourceChange});
      const active = card.el.querySelector<HTMLButtonElement>(`[data-source="${source}"]`)!;
      expect(active.getAttribute('aria-pressed')).toBe('true');
      active.click();
      expect(onSourceChange).toHaveBeenLastCalledWith(next);
    }
    card.el.querySelector<HTMLButtonElement>('[data-source="codex"]')!.click();
    expect(onSourceChange).toHaveBeenLastCalledWith('codex');
    card.update({html: '<b>usage</b>', source: 'claude', onSourceChange});
    const deepseek = card.el.querySelector<HTMLButtonElement>('[data-source="deepseek"]')!;
    expect(deepseek.disabled).toBe(false);
    expect(deepseek.hasAttribute('aria-disabled')).toBe(false);
    deepseek.click();
    expect(onSourceChange).toHaveBeenLastCalledWith('deepseek');
    card.destroy();
  });
  test('old engine without source keeps its face and has no switcher', () => {
    const card = createPluginCard('Plan usage', () => {});
    card.update({html: '<b>old engine</b>'});
    expect(card.el.querySelector('[data-source]')).toBeNull();
    expect(card.el.querySelector('iframe')).not.toBeNull();
    card.destroy();
  });
});
