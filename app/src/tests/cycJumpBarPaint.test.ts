import {describe, expect, test} from 'vitest';

// Jump-bar empty-state rendering.

import {createJumpBar} from '../features/chat/navigation/jumpBar';

const btnOf = (bar: {el: HTMLElement}) =>
  bar.el.querySelector('.cyc-jump-btn') as HTMLButtonElement;

describe('jump-bar empty-state utilities current from sessions.css', () => {
  test('the button carries the empty self-variant dim tokens', () => {
    const cls = btnOf(createJumpBar(() => {})).className;
    expect(cls).toContain('[&.cyc-jump-empty]:text-[var(--cyc-text-muted)]');
    expect(cls).toContain('[&.cyc-jump-empty]:opacity-40');
    expect(cls).toContain('[&.cyc-jump-empty]:cursor-default');
  });

  test('no target arms `.cyc-jump-empty` (and disables); a target clears it', () => {
    const bar = createJumpBar(() => {});
    const btn = btnOf(bar);

    bar.update([{id: 'a', name: 'Alpha'}], 'a');
    expect(bar.el.classList.contains('cyc-off')).toBe(true);

    bar.update(
      [
        {id: 'a', name: 'Alpha'},
        {id: 'b', name: 'Beta'}
      ],
      null
    );
    expect(btn.classList.contains('cyc-jump-empty')).toBe(false);
    expect(btn.disabled).toBe(false);
  });
});
