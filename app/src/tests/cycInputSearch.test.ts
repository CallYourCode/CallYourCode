import {beforeEach, afterEach, describe, expect, test} from 'vitest';
import {inputSearch} from '../components/widgets';
import {
  currentPresentation,
  installPresentationReactivity,
  presentationPainterCount,
  setPresentationTheme
} from '../components/presentation';

const inputOf = (el: HTMLElement) => el.querySelector<HTMLInputElement>('.cyc-search-input')!;
const overlayOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.cyc-search-border')!;
const iconOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.cyc-search-icon')!;
const clearOf = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.cyc-search-clear')!;
const phOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.cyc-search-placeholder')!;
const cls = (el: HTMLElement) => el.className;

const ORIGINAL_WIDTH = window.innerWidth;
const setWidth = (px: number) =>
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: px});

let teardown: (() => void) | undefined;
// Reinstall with the current viewport and pointer state.
const sync = () => {
  teardown?.();
  teardown = installPresentationReactivity();
};

const coarsePointer = () => {
  (window as unknown as {matchMedia: (q: string) => MediaQueryList}).matchMedia = (q: string) =>
    ({
      matches: q.includes('coarse'),
      media: q,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false
    }) as unknown as MediaQueryList;
};
const finePointer = () => {
  delete (window as unknown as {matchMedia?: unknown}).matchMedia;
};

beforeEach(() => {
  document.documentElement.dir = '';
  document.body.innerHTML = '';
  finePointer();
  setWidth(1024);
  setPresentationTheme('day');
  sync();
});

afterEach(() => {
  teardown?.();
  teardown = undefined;
  finePointer();
  setWidth(ORIGINAL_WIDTH);
  document.body.innerHTML = '';
  setPresentationTheme('day');
});

describe('inputSearch presentation is chosen by TS', () => {
  test('plain day base paints the literal old-input fill with a transparent border', () => {
    const el = inputSearch('Search', undefined, {plain: true});
    const input = inputOf(el);
    expect(cls(input)).toContain('bg-[#ece9e3]!');
    expect(cls(input)).toContain('border-transparent');
    expect(cls(input)).toContain('text-[#1c1c1e]');
    expect(cls(input)).toContain('caret-[#96602f]');
    expect(cls(iconOf(el))).toContain('text-[#6b6b70]');
  });

  test('plain night base paints the literal dark fill', () => {
    setPresentationTheme('night');
    const el = inputSearch('Search', undefined, {plain: true});
    expect(cls(inputOf(el))).toContain('bg-[#0d0d0e]!');
    expect(cls(inputOf(el))).toContain('text-[#ededee]');
    expect(cls(iconOf(el))).toContain('text-[#a0a0a6]');
  });

  test('default (non-plain) mode paints the filled fill and border', () => {
    const day = inputSearch('Search');
    expect(cls(inputOf(day))).toContain('bg-[#f2f2f3]!');
    expect(cls(inputOf(day))).toContain('border-[#e6e6e8]');
    setPresentationTheme('night');
    const night = inputSearch('Search');
    expect(cls(inputOf(night))).toContain('bg-[#17171a]!');
    expect(cls(inputOf(night))).toContain('border-[#000000]');
  });

  test('focus paints transparent fill, primary border, ring, and primary parts', () => {
    const el = inputSearch('Search', undefined, {plain: true});
    const input = inputOf(el);
    input.dispatchEvent(new Event('focus'));
    expect(cls(input)).toContain('bg-transparent');
    expect(cls(input)).toContain('border-[#96602f]');
    expect(cls(overlayOf(el))).toContain('border-[#96602f]');
    expect(cls(overlayOf(el))).toContain('opacity-100');
    expect(cls(iconOf(el))).toContain('text-[#96602f]');
    expect(cls(iconOf(el))).toContain('opacity-100');
    input.dispatchEvent(new Event('blur'));
    expect(cls(input)).toContain('bg-[#ece9e3]');
    expect(cls(input)).toContain('border-transparent');
    expect(cls(overlayOf(el))).toContain('opacity-0');
    expect(cls(iconOf(el))).toContain('text-[#6b6b70]');
  });

  test('blurred fills win the unlayered reset via important, focus stays transparent', () => {
    const el = inputSearch('Search', undefined, {plain: true});
    const input = inputOf(el);
    expect(cls(input)).toContain('bg-[#ece9e3]!');
    expect(cls(input)).not.toContain('bg-transparent');
    input.dispatchEvent(new Event('focus'));
    expect(cls(input)).toContain('bg-transparent');
    expect(cls(input)).not.toContain('bg-[#ece9e3]!');
  });

  test('clear button keeps the base 6px radius and an important hover tint', () => {
    const el = inputSearch('Search', undefined, {plain: true});
    const input = inputOf(el);
    const clear = clearOf(el);
    expect(cls(clear)).toContain('rounded-[6px]');
    expect(cls(clear)).not.toContain('rounded-full');
    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('focus'));
    clear.dispatchEvent(new Event('mouseenter'));
    expect(cls(clear)).toContain('bg-[rgba(150,96,47,0.1)]!');
  });

  test('clear button pins base padding and icon size with important literals', () => {
    const clear = clearOf(inputSearch('Search', undefined, {plain: true}));
    expect(cls(clear)).toContain('p-1.5!');
    expect(cls(clear)).toContain('text-[length:1.5rem]!');
    expect(cls(clear)).not.toMatch(/(^|\s)p-1\.5(\s|$)/);
    expect(cls(clear)).not.toMatch(/(^|\s)p-0(\s|$)/);
  });

  test('clear button never leans on the dropped .cyc-icon-btn skin for sizing', () => {
    expect(cls(clearOf(inputSearch('Search', undefined, {plain: true})))).not.toContain(
      'cyc-icon-btn'
    );
  });

  test('focus night uses the night primary literal', () => {
    setPresentationTheme('night');
    const el = inputSearch('Search', undefined, {plain: true});
    inputOf(el).dispatchEvent(new Event('focus'));
    expect(cls(inputOf(el))).toContain('border-[#c98652]');
    expect(cls(overlayOf(el))).toContain('border-[#c98652]');
    expect(cls(iconOf(el))).toContain('text-[#c98652]');
  });

  test('empty vs value toggles clear button and placeholder visibility', () => {
    let seen = '';
    const el = inputSearch('Search', (v) => (seen = v), {plain: true});
    expect(clearOf(el).hidden).toBe(true);
    expect(phOf(el).hidden).toBe(false);
    const input = inputOf(el);
    input.value = 'ab';
    input.dispatchEvent(new Event('input'));
    expect(seen).toBe('ab');
    expect(clearOf(el).hidden).toBe(false);
    expect(phOf(el).hidden).toBe(true);
  });

  test('clear button empties the value, restores placeholder, and reports change', () => {
    const seen: string[] = [];
    const el = inputSearch('Search', (v) => seen.push(v), {plain: true});
    const input = inputOf(el);
    document.body.append(el);
    input.value = 'query';
    input.dispatchEvent(new Event('input'));
    clearOf(el).dispatchEvent(new Event('click'));
    expect(input.value).toBe('');
    expect(clearOf(el).hidden).toBe(true);
    expect(phOf(el).hidden).toBe(false);
    expect(seen[seen.length - 1]).toBe('');
  });

  test.each([
    [550, 'phone', 'ms-1'],
    [551, 'tablet', 'ms-2'],
    [899, 'tablet', 'ms-2'],
    [900, 'laptop', 'ms-2']
  ] as const)('width %i maps to %s bucket and margin %s', (px, bucket, margin) => {
    setWidth(px);
    sync();
    expect(currentPresentation().width).toBe(bucket);
    const el = inputSearch('Search', undefined, {plain: true});
    expect(cls(el)).toContain(margin);
    expect(cls(el)).not.toContain(margin === 'ms-1' ? 'ms-2' : 'ms-1');
  });

  test('fine pointer paints a hover border when not focused', () => {
    const el = inputSearch('Search', undefined, {plain: true});
    const input = inputOf(el);
    expect(currentPresentation().pointer).toBe('fine');
    input.dispatchEvent(new Event('mouseenter'));
    expect(cls(input)).toContain('border-[#6b6b70]');
    input.dispatchEvent(new Event('mouseleave'));
    expect(cls(input)).toContain('border-transparent');
  });

  test('fine pointer tints the clear button on hover', () => {
    const el = inputSearch('Search', undefined, {plain: true});
    const input = inputOf(el);
    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('focus'));
    const clear = clearOf(el);
    clear.dispatchEvent(new Event('mouseenter'));
    expect(cls(clear)).toContain('bg-[rgba(150,96,47,0.1)]!');
    clear.dispatchEvent(new Event('mouseleave'));
    expect(cls(clear)).toContain('bg-transparent');
  });

  test('coarse pointer suppresses the hover border', () => {
    coarsePointer();
    sync();
    expect(currentPresentation().pointer).toBe('coarse');
    const el = inputSearch('Search', undefined, {plain: true});
    const input = inputOf(el);
    input.dispatchEvent(new Event('mouseenter'));
    expect(cls(input)).not.toContain('border-[#6b6b70]');
    expect(cls(input)).toContain('border-transparent');
  });

  test('a mounted search repaints when the theme changes', () => {
    const el = inputSearch('Search', undefined, {plain: true});
    document.body.append(el);
    expect(cls(inputOf(el))).toContain('bg-[#ece9e3]');
    setPresentationTheme('night');
    expect(cls(inputOf(el))).toContain('bg-[#0d0d0e]');
    expect(cls(inputOf(el))).not.toContain('bg-[#ece9e3]');
  });

  test('a mounted search repaints when the width bucket changes', () => {
    const el = inputSearch('Search', undefined, {plain: true});
    document.body.append(el);
    expect(cls(el)).toContain('ms-2');
    setWidth(550);
    sync();
    expect(cls(el)).toContain('ms-1');
    expect(cls(el)).not.toContain('ms-2');
  });

  test('a coalesced resize event repaints the width bucket', async () => {
    const el = inputSearch('Search', undefined, {plain: true});
    document.body.append(el);
    setWidth(550);
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    expect(cls(el)).toContain('ms-1');
  });

  test('detached searches are pruned and not repainted', () => {
    const before = presentationPainterCount();
    const el = inputSearch('Search', undefined, {plain: true});
    document.body.append(el);
    expect(presentationPainterCount()).toBe(before + 1);
    const painted = cls(inputOf(el));
    el.remove();
    setPresentationTheme('night');
    expect(presentationPainterCount()).toBe(before);
    expect(cls(inputOf(el))).toBe(painted);
  });

  test('teardown stops resize-driven repaints', async () => {
    const el = inputSearch('Search', undefined, {plain: true});
    document.body.append(el);
    teardown?.();
    teardown = undefined;
    setWidth(550);
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    expect(cls(el)).toContain('ms-2');
  });

  test('class strings carry no CSS-variable, relationship, or pointer-selector styling', () => {
    const el = inputSearch('Search', undefined, {plain: true});
    document.body.append(el);
    inputOf(el).value = 'x';
    inputOf(el).dispatchEvent(new Event('input'));
    inputOf(el).dispatchEvent(new Event('focus'));
    const parts = [
      cls(el),
      cls(inputOf(el)),
      cls(overlayOf(el)),
      cls(iconOf(el)),
      cls(clearOf(el)),
      cls(phOf(el))
    ];
    for (const s of parts) {
      expect(s).not.toContain('var(--');
      expect(s).not.toContain(':focus');
      expect(s).not.toContain('fine:');
      expect(s).not.toContain('data-theme');
      expect(s).not.toContain('data-pointer');
      expect(s).not.toContain('~');
      expect(s).not.toContain('peer');
      expect(s).not.toContain('group-');
      expect(s).not.toContain('@apply');
      expect(s).not.toContain('tab:');
      expect(s).not.toContain('desk:');
    }
    for (const hook of ['cyc-field-input', 'cyc-field-border', 'cyc-icon-btn']) {
      expect(parts.join(' ')).not.toContain(hook);
    }
  });
});
