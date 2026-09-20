import {describe, expect, test} from 'vitest';
import {createDialPanel} from '../components/replyLevel';

// Exercises dial event wiring in jsdom; cascade coverage runs in Chromium.

function pointer(type: string, clientX: number, pointerId = 1) {
  const event = new Event(type, {bubbles: true}) as PointerEvent;
  Object.assign(event, {button: 0, clientX, clientY: 0, pointerId});
  return event;
}

function key(name: string) {
  return new KeyboardEvent('keydown', {key: name, bubbles: true});
}

function mount() {
  const panel = createDialPanel({
    key: 'verbosity',
    title: 'verbosity',
    steps: [
      {n: 0, name: 'A'},
      {n: 1, name: 'B'},
      {n: 2, name: 'C'}
    ],
    value: 0,
    onPick: () => {}
  });
  document.body.append(panel.el);
  const dial = panel.el.querySelector('.cyc-steprange') as HTMLElement;
  const rail = panel.el.querySelector('.cyc-steprange-track') as HTMLElement;
  const stops = Array.from(panel.el.querySelectorAll('.cyc-steprange-notch'));
  rail.getBoundingClientRect = () =>
    ({left: 0, right: 100, width: 100, top: 0, bottom: 2, height: 2, x: 0, y: 0}) as DOMRect;
  return {panel, dial, rail, stops};
}

const activeMask = (stops: Element[]) =>
  stops.map((o) => (o as HTMLElement).dataset.reached === 'true');
const filledSegments = (dial: HTMLElement) =>
  Array.from(dial.querySelectorAll('.cyc-steprange-seg')).filter(
    (s) => (s as HTMLElement).dataset.reached === 'true'
  ).length;
const grabbing = (dial: HTMLElement) => dial.dataset.grabbing === 'true';

describe('reply dial interaction wiring (jsdom, real producer)', () => {
  test('pointer drag to the far end fills, activates crossed notches, toggles data-grabbing', () => {
    const {dial, rail, stops} = mount();
    expect(activeMask(stops)).toEqual([true, false, false]);
    expect(filledSegments(dial)).toBe(0);

    rail.dispatchEvent(pointer('pointerdown', 100));
    expect(grabbing(dial)).toBe(true);
    expect(activeMask(stops)).toEqual([true, true, true]);
    expect(filledSegments(dial)).toBe(2);

    rail.dispatchEvent(pointer('pointermove', 0));
    expect(activeMask(stops)).toEqual([true, false, false]);
    expect(filledSegments(dial)).toBe(0);

    rail.dispatchEvent(pointer('pointerup', 0));
    expect(grabbing(dial)).toBe(false);
  });

  test('keyboard arrows land + commit a selection without grabbing the rail', () => {
    const {dial, rail, stops} = mount();
    void rail;
    dial.dispatchEvent(key('End'));
    expect(activeMask(stops)).toEqual([true, true, true]);
    expect(filledSegments(dial)).toBe(2);
    expect(grabbing(dial)).toBe(false);

    dial.dispatchEvent(key('Home'));
    expect(activeMask(stops)).toEqual([true, false, false]);
    expect(filledSegments(dial)).toBe(0);
    expect(grabbing(dial)).toBe(false);
  });
});
