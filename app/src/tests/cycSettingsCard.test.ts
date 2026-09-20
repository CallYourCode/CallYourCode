import {beforeEach, afterEach, describe, expect, test} from 'vitest';
import {settingsCard} from '../components/widgets';
import {
  currentPresentation,
  installPresentationReactivity,
  presentationPainterCount,
  setPresentationTheme
} from '../components/presentation';

const innerOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.cyc-block')!;
const contentOf = (el: HTMLElement) =>
  el.querySelector<HTMLElement>('.cyc-block-content:not(.cyc-card-footer)')!;
const headingOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.cyc-card-heading');
const footerOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.cyc-card-footer');
const cls = (el: HTMLElement) => el.className;

const ORIGINAL_WIDTH = window.innerWidth;
const setWidth = (px: number) =>
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: px});

let teardown: (() => void) | undefined;
const sync = () => {
  teardown?.();
  teardown = installPresentationReactivity();
};

beforeEach(() => {
  document.documentElement.dir = '';
  document.body.innerHTML = '';
  setWidth(1024);
  setPresentationTheme('day');
  sync();
});

afterEach(() => {
  teardown?.();
  teardown = undefined;
  setWidth(ORIGINAL_WIDTH);
  document.body.innerHTML = '';
  setPresentationTheme('day');
});

describe('settings card presentation is chosen by TS', () => {
  test('day paints the literal copper surface, shadow and 6px radius', () => {
    const el = settingsCard({});
    const inner = innerOf(el);
    expect(cls(el)).toContain('px-4');
    expect(cls(inner)).toContain('mb-4');
    expect(cls(inner)).toContain('rounded-[6px]');
    expect(cls(inner)).toContain('py-2');
    expect(cls(inner)).toContain('bg-[#ffffff]');
    expect(cls(inner)).toContain('shadow-[0px_1px_4px_0px_rgba(0,0,0,0.05)]');
  });

  test('night paints the dark surface and heavier shadow', () => {
    setPresentationTheme('night');
    const inner = innerOf(settingsCard({}));
    expect(cls(inner)).toContain('bg-[#17171a]');
    expect(cls(inner)).toContain('shadow-[0px_1px_4px_0px_rgba(0,0,0,0.12)]');
    expect(cls(inner)).not.toContain('bg-[#ffffff]');
  });

  test('heading option renders the heading with the day/night primary colour', () => {
    const day = settingsCard({heading: 'Settings'});
    const dayName = headingOf(day)!;
    expect(dayName.textContent).toBe('Settings');
    expect(cls(dayName)).toContain('font-semibold');
    expect(cls(dayName)).toContain('text-[length:1rem]');
    expect(cls(dayName)).toContain('text-[#96602f]');
    setPresentationTheme('night');
    expect(cls(headingOf(settingsCard({heading: 'Help'}))!)).toContain('text-[#c98652]');
  });

  test('no heading option means no heading element', () => {
    expect(headingOf(settingsCard({}))).toBeNull();
  });

  test('footer option renders the muted trailing caption on the container', () => {
    const el = settingsCard({footer: 'A note'});
    const caption = footerOf(el)!;
    expect(caption.textContent).toBe('A note');
    expect(el.lastElementChild).toBe(caption);
    expect(cls(caption)).toContain('-mt-1.5');
    expect(cls(caption)).toContain('mb-4');
    expect(cls(caption)).toContain('text-[length:0.875rem]');
    expect(cls(caption)).toContain('leading-[18px]');
    expect(cls(caption)).toContain('text-[#6b6b70]');
    setPresentationTheme('night');
    expect(cls(footerOf(settingsCard({footer: 'x'}))!)).toContain('text-[#a0a0a6]');
  });

  test('no footer option means no caption element', () => {
    expect(footerOf(settingsCard({}))).toBeNull();
  });

  test('children are appended into the section content', () => {
    const a = document.createElement('div');
    a.className = 'child-a';
    const b = document.createElement('div');
    b.className = 'child-b';
    const content = contentOf(settingsCard({heading: 'N'}, a, b));
    expect(content.children[0].classList.contains('cyc-card-heading')).toBe(true);
    expect(content.children[1]).toBe(a);
    expect(content.children[2]).toBe(b);
  });

  test.each([
    [550, 'phone', 'mx-0'],
    [551, 'tablet', 'mx-2'],
    [899, 'tablet', 'mx-2'],
    [900, 'laptop', 'mx-2']
  ] as const)('width %i maps to %s bucket and content inset %s', (px, bucket, inset) => {
    setWidth(px);
    sync();
    expect(currentPresentation().width).toBe(bucket);
    const content = contentOf(settingsCard({}));
    expect(cls(content)).toContain(inset);
    expect(cls(content)).not.toContain(inset === 'mx-0' ? 'mx-2' : 'mx-0');
  });

  test('a mounted section repaints when the theme changes', () => {
    const el = settingsCard({heading: 'N', footer: 'C'});
    document.body.append(el);
    expect(cls(innerOf(el))).toContain('bg-[#ffffff]');
    expect(cls(headingOf(el)!)).toContain('text-[#96602f]');
    expect(cls(footerOf(el)!)).toContain('text-[#6b6b70]');
    setPresentationTheme('night');
    expect(cls(innerOf(el))).toContain('bg-[#17171a]');
    expect(cls(innerOf(el))).not.toContain('bg-[#ffffff]');
    expect(cls(headingOf(el)!)).toContain('text-[#c98652]');
    expect(cls(footerOf(el)!)).toContain('text-[#a0a0a6]');
  });

  test('a mounted section repaints when the width bucket changes', () => {
    const el = settingsCard({});
    document.body.append(el);
    expect(cls(contentOf(el))).toContain('mx-2');
    setWidth(550);
    sync();
    expect(cls(contentOf(el))).toContain('mx-0');
    expect(cls(contentOf(el))).not.toContain('mx-2');
  });

  test('a coalesced resize event repaints the width bucket', async () => {
    const el = settingsCard({});
    document.body.append(el);
    setWidth(550);
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    expect(cls(contentOf(el))).toContain('mx-0');
  });

  test('detached sections are pruned and not repainted', () => {
    const before = presentationPainterCount();
    const el = settingsCard({});
    document.body.append(el);
    expect(presentationPainterCount()).toBe(before + 1);
    const painted = cls(innerOf(el));
    el.remove();
    setPresentationTheme('night');
    expect(presentationPainterCount()).toBe(before);
    expect(cls(innerOf(el))).toBe(painted);
  });

  test('teardown stops resize-driven repaints', async () => {
    const el = settingsCard({});
    document.body.append(el);
    teardown?.();
    teardown = undefined;
    setWidth(550);
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    expect(cls(contentOf(el))).toContain('mx-2');
  });

  test('class strings carry no CSS-variable, relationship, media or pointer styling', () => {
    const el = settingsCard({heading: 'N', footer: 'C'}, document.createElement('div'));
    document.body.append(el);
    const parts = [
      cls(el),
      cls(innerOf(el)),
      cls(contentOf(el)),
      cls(headingOf(el)!),
      cls(footerOf(el)!)
    ];
    for (const s of parts) {
      expect(s).not.toContain('var(--');
      expect(s).not.toContain('data-theme');
      expect(s).not.toContain('data-pointer');
      expect(s).not.toContain('fine:');
      expect(s).not.toContain(':checked');
      expect(s).not.toContain('~');
      expect(s).not.toContain('peer');
      expect(s).not.toContain('group-');
      expect(s).not.toContain('@apply');
      expect(s).not.toContain('tab:');
      expect(s).not.toContain('desk:');
      expect(s).not.toContain('@media');
    }
    expect(parts.join(' ')).not.toContain('max-tab');
    expect(parts.join(' ')).not.toContain('rounded-[24px]');
  });
});
