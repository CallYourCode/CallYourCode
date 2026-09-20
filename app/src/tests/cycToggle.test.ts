import {beforeEach, afterEach, describe, expect, test} from 'vitest';
import {toggle} from '../components/widgets';
import {
  setPresentationTheme,
  currentPresentationTheme,
  themePainterCount
} from '../components/presentation';

const classesOf = (el: HTMLElement) => el.className;
const trackOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.cyc-toggle-track')!;
const knobOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.cyc-toggle-knob')!;
const inputOf = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input')!;

beforeEach(() => {
  document.documentElement.dir = '';
  setPresentationTheme('day');
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});

describe('toggle presentation is chosen by TS', () => {
  test('initial day unchecked paint uses literal copper day colours', () => {
    const {el} = toggle();
    expect(currentPresentationTheme()).toBe('day');
    expect(classesOf(trackOf(el))).toContain('bg-[#6b6b70]');
    const knob = classesOf(knobOf(el));
    expect(knob).toContain('border-[#6b6b70]');
    expect(knob).toContain('bg-[#ffffff]');
    expect(knob).toContain('translate-x-0');
    expect(knob).not.toContain('text-[#96602f]');
  });

  test('initial night unchecked paint uses literal copper night colours', () => {
    setPresentationTheme('night');
    const {el} = toggle();
    expect(classesOf(trackOf(el))).toContain('bg-[#a0a0a6]');
    const knob = classesOf(knobOf(el));
    expect(knob).toContain('border-[#a0a0a6]');
    expect(knob).toContain('bg-[#17171a]');
  });

  test('checked day paint switches to primary track/knob and knob travel', () => {
    const {el} = toggle({checked: true});
    expect(classesOf(trackOf(el))).toContain('bg-[#96602f]');
    const knob = classesOf(knobOf(el));
    expect(knob).toContain('border-[#96602f]');
    expect(knob).toContain('text-[#96602f]');
    expect(knob).toContain('translate-x-4');
  });

  test('checked night paint uses night primary', () => {
    setPresentationTheme('night');
    const {el} = toggle({checked: true});
    expect(classesOf(trackOf(el))).toContain('bg-[#c98652]');
    expect(classesOf(knobOf(el))).toContain('border-[#c98652]');
  });

  test('a user change repaints before onChange runs', () => {
    let paintedWhenNotified = '';
    const {el} = toggle({
      onChange: (checked) => {
        paintedWhenNotified = checked ? classesOf(trackOf(el)) : '';
      }
    });
    document.body.append(el);
    const input = inputOf(el);
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    expect(paintedWhenNotified).toContain('bg-[#96602f]');
    expect(classesOf(trackOf(el))).toContain('bg-[#96602f]');
  });

  test('explicit set() repaints without invoking onChange', () => {
    let calls = 0;
    const t = toggle({onChange: () => calls++});
    t.set(true);
    expect(t.input.checked).toBe(true);
    expect(classesOf(trackOf(t.el))).toContain('bg-[#96602f]');
    expect(calls).toBe(0);
    t.set(false);
    expect(classesOf(trackOf(t.el))).toContain('bg-[#6b6b70]');
  });

  test('disabled toggle keeps native semantics and paints disabled', () => {
    const {el, input} = toggle({disabled: true});
    expect(input.disabled).toBe(true);
    expect(input.type).toBe('checkbox');
    expect(classesOf(el)).toContain('opacity-[0.3]');
    expect(classesOf(el)).toContain('pointer-events-none!');
  });

  test('a mounted toggle repaints when the theme changes', () => {
    const {el} = toggle();
    document.body.append(el);
    expect(classesOf(trackOf(el))).toContain('bg-[#6b6b70]');
    setPresentationTheme('night');
    expect(classesOf(trackOf(el))).toContain('bg-[#a0a0a6]');
    expect(classesOf(trackOf(el))).not.toContain('bg-[#6b6b70]');
  });

  test('detached toggles are pruned and not repainted', () => {
    const before = themePainterCount();
    const {el} = toggle();
    document.body.append(el);
    expect(themePainterCount()).toBe(before + 1);
    const painted = classesOf(trackOf(el));
    el.remove();
    setPresentationTheme('night');
    expect(themePainterCount()).toBe(before);
    expect(classesOf(trackOf(el))).toBe(painted);
  });

  test('respects RTL text direction for knob travel', () => {
    document.documentElement.dir = 'rtl';
    const off = toggle();
    expect(classesOf(knobOf(off.el))).toContain('translate-x-0');
    const on = toggle({checked: true});
    expect(classesOf(knobOf(on.el))).toContain('-translate-x-4');
  });

  test('toggle class strings carry no CSS-variable or relationship-selector styling', () => {
    const {el} = toggle({checked: true});
    for (const s of [classesOf(el), classesOf(trackOf(el)), classesOf(knobOf(el))]) {
      expect(s).not.toContain('var(--');
      expect(s).not.toContain(':checked');
      expect(s).not.toContain('--cyc-accent');
      expect(s).not.toContain('--cyc-secondary-color');
      expect(s).not.toContain('--cyc-surface');
      expect(s).not.toContain('+&');
      expect(s).not.toContain('_&]');
    }
  });
});
