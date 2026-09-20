import {describe, expect, test} from 'vitest';
import createSteppedRange from '../features/sessions/controls/steppedRangeSlider';

function pointer(type: string, clientX: number, pointerId = 1) {
  const event = new Event(type, {bubbles: true}) as PointerEvent;
  Object.assign(event, {button: 0, clientX, clientY: 0, pointerId});
  return event;
}

describe('pointer controls', () => {
  test('maps a native pointer drag on the rail into the nearest stop', () => {
    const previews: string[] = [];
    const dial = createSteppedRange<string>({onPreview: (value) => previews.push(value)});
    dial.setOptions([
      {label: 'a', value: 'a'},
      {label: 'b', value: 'b'},
      {label: 'c', value: 'c'}
    ]);
    const track = dial.container.querySelector('.cyc-steprange-track') as HTMLElement;
    track.getBoundingClientRect = () =>
      ({left: 10, right: 110, width: 100, top: 0, bottom: 2, height: 2}) as DOMRect;

    track.dispatchEvent(pointer('pointerdown', 60)); // midpoint -> index 1
    track.dispatchEvent(pointer('pointermove', 60));
    track.dispatchEvent(pointer('pointerup', 60));

    expect(dial.value).toBe('b');
    expect(previews).toContain('b');
    expect(dial.container.querySelectorAll('.cyc-steprange-seg')).toHaveLength(2);
    expect(dial.container.querySelector('.cyc-steprange-notch[data-current="true"]')).toBeTruthy();
  });

  test('keeps a stepped dial bounded and reports its selected value', () => {
    const picked: string[] = [];
    const dial = createSteppedRange<string>({onPreview: (value) => picked.push(value)});
    dial.setOptions(
      [
        {label: 'low', value: 'low'},
        {label: 'high', value: 'high'}
      ],
      99
    );

    expect(dial.value).toBe('high');
    expect(picked).toEqual(['high']);
  });
});
