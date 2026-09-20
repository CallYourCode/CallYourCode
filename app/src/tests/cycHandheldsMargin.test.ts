import {afterEach, describe, expect, test} from 'vitest';

import {
  messageFrameEl,
  paintMessageFrameWidth,
  paintServiceRowWidth
} from '../features/chat/messages/messageFrame';
import {dateMessage} from '../features/chat/messages/sessionEventMessages';
import {installPresentationReactivity, currentPresentation} from '../components/presentation';

const setWidth = (px: number) =>
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: px});
const ORIGINAL_WIDTH = window.innerWidth;

const withWidth = (px: number, fn: () => void) => {
  setWidth(px);
  const teardown = installPresentationReactivity();
  try {
    fn();
  } finally {
    teardown();
  }
};

afterEach(() => {
  setWidth(ORIGINAL_WIDTH);
});

describe('the phone message inset flips at the phone/tablet boundary', () => {
  test('frame width insets 2.75rem and pills 2.25rem on phone; 4rem/30rem above it', () => {
    const at = (px: number) => {
      let frame = '';
      let pill = '';
      let bucket = '';
      withWidth(px, () => {
        bucket = currentPresentation().width;
        const inner = document.createElement('div');
        paintMessageFrameWidth(inner);
        frame = inner.style.getPropertyValue('--cyc-msg-frame-max');
        const row = document.createElement('div');
        paintServiceRowWidth(row);
        pill = row.style.maxWidth;
      });
      return {bucket, frame, pill};
    };
    expect(at(400)).toEqual({
      bucket: 'phone',
      frame: 'calc(100% - 2.75rem)',
      pill: 'calc(100% - 2.25rem)'
    });
    expect(at(550)).toEqual({
      bucket: 'phone',
      frame: 'calc(100% - 2.75rem)',
      pill: 'calc(100% - 2.25rem)'
    });
    expect(at(551)).toEqual({bucket: 'tablet', frame: '30rem', pill: 'calc(100% - 4rem)'});
    expect(at(1200)).toEqual({bucket: 'laptop', frame: '30rem', pill: 'calc(100% - 4rem)'});
  });

  test('the bubble frame carries the phone edge margin; centered service rows do not', () => {
    // The 0.5rem side margin (max-tab:mx-2) is what keeps a bubble off the
    // screen edge on phone: received frames sit at flex-start (left), sent
    // frames at flex-row-reverse start (right), so one class covers both.
    const frame = messageFrameEl();
    expect(frame.classList.contains('max-tab:mx-2')).toBe(true);
    expect(frame.classList.contains('max-w-[var(--cyc-msg-frame-max)]')).toBe(true);
    // Service rows (date chips and the like) center with their own inset and
    // must not pick up the bubble margin.
    const chip = dateMessage('Today');
    expect(chip.className).not.toContain('mx-2');
  });
});
