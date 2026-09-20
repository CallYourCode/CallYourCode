import {describe, it, expect, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

async function makeRecorder() {
  const {createRecorder, RECORDER_EVENTS} =
    await import('../features/composer/voice/voiceRecorder');
  return {rec: createRecorder(), RECORDER_EVENTS};
}

function stubRect(el: HTMLElement, left: number, width: number, height = 36) {
  el.getBoundingClientRect = () =>
    ({
      left,
      width,
      height,
      top: 0,
      right: left + width,
      bottom: height,
      x: left,
      y: 0,
      toJSON() {}
    }) as DOMRect;
}

const litSlots = (strip: Element) =>
  [...strip.querySelectorAll<HTMLElement>('.cyc-rec-level')].filter(
    (bar) => bar.style.height !== '0%'
  );

describe('recorder DOM + level strip', () => {
  it('builds the recording pill and a fixed-budget level strip', async () => {
    const {rec} = await makeRecorder();
    expect(rec.element.classList.contains('cyc-rec-panel')).toBe(true);
    expect(rec.element.dataset.cycRec).toBe('recording');
    const strip = rec.element.querySelector('.cyc-rec-strip');
    expect(strip).toBeInstanceOf(HTMLDivElement);
    expect(strip!.getAttribute('role')).toBe('slider');
    expect(strip!.querySelectorAll('.cyc-rec-level').length).toBe(56);
    expect(litSlots(strip!).length).toBe(0);
  });

  it('does not stamp a 0:00,0 timer fingerprint at construction', async () => {
    const {rec} = await makeRecorder();
    expect(rec.element.querySelector('.cyc-rec-timer')!.textContent).toBe('');
  });

  it('lights one trailing slot per sample and clears on reset', async () => {
    const {rec} = await makeRecorder();
    const strip = rec.element.querySelector('.cyc-rec-strip')!;
    rec.renderRecorder({peak: 0.2});
    rec.renderRecorder({peak: 0.5});
    const lit = litSlots(strip);
    expect(lit.length).toBe(2);
    const all = [...strip.querySelectorAll<HTMLElement>('.cyc-rec-level')];
    expect(all.slice(-2)).toEqual(lit);
    rec.renderRecorder({reset: true});
    expect(litSlots(strip).length).toBe(0);
  });

  it('caps the rolling window at the slot budget', async () => {
    const {rec} = await makeRecorder();
    const strip = rec.element.querySelector('.cyc-rec-strip')!;
    for (let i = 0; i < 80; i++) rec.renderRecorder({peak: 0.4});
    expect(litSlots(strip).length).toBe(56);
  });

  it('normalises quiet samples against a rolling reference, not a lifetime peak', async () => {
    const {rec} = await makeRecorder();
    const strip = rec.element.querySelector('.cyc-rec-strip')!;
    const last = () =>
      [...strip.querySelectorAll<HTMLElement>('.cyc-rec-level')].at(-1)!.style.height;
    rec.renderRecorder({peak: 0.9});
    expect(last()).toBe('100%');
    for (let i = 0; i < 40; i++) rec.renderRecorder({peak: 0.1});
    expect(parseInt(last(), 10)).toBeGreaterThan(50);
  });

  it('formats elapsed time as a whole-second M:SS readout (no comma-decimal tenths)', async () => {
    const {rec} = await makeRecorder();
    const timer = rec.element.querySelector('.cyc-rec-timer')!;
    rec.renderRecorder({elapsedMs: 3400});
    expect(timer.textContent).toBe('0:03');
    expect(timer.textContent).not.toContain(',');
    rec.renderRecorder({elapsedMs: 67_000});
    expect(timer.textContent).toBe('1:07');
    rec.renderRecorder({elapsedMs: 67_900});
    expect(timer.textContent).toBe('1:07');
  });

  it('phase review flips to the paused pill', async () => {
    const {rec} = await makeRecorder();
    rec.renderRecorder({phase: 'review'});
    expect(rec.element.dataset.cycRec).toBe('review');
    expect(rec.element.hasAttribute('data-cyc-playing')).toBe(false);
    rec.renderRecorder({playing: true});
    expect(rec.element.hasAttribute('data-cyc-playing')).toBe(true);
    rec.renderRecorder({playing: false});
    expect(rec.element.hasAttribute('data-cyc-playing')).toBe(false);
  });

  it('dims the unplayed tail via a class once a playhead is set', async () => {
    const {rec} = await makeRecorder();
    const strip = rec.element.querySelector('.cyc-rec-strip')!;
    for (let i = 0; i < 56; i++) rec.renderRecorder({peak: 0.5});
    const bars = [...strip.querySelectorAll('.cyc-rec-level')];
    expect(bars.some((b) => b.classList.contains('is-ahead'))).toBe(false);
    rec.renderRecorder({playhead: 0.5});
    expect(bars[0].classList.contains('is-ahead')).toBe(false);
    expect(bars.at(-1)!.classList.contains('is-ahead')).toBe(true);
    rec.renderRecorder({playhead: null});
    expect(bars.some((b) => b.classList.contains('is-ahead'))).toBe(false);
  });
});

describe('recorder events', () => {
  it('cancel/pause/play buttons dispatch CustomEvents', async () => {
    const {rec, RECORDER_EVENTS} = await makeRecorder();
    const cancel = vi.fn();
    const pause = vi.fn();
    const play = vi.fn();
    rec.element.addEventListener(RECORDER_EVENTS.cancel, cancel);
    rec.element.addEventListener(RECORDER_EVENTS.pause, pause);
    rec.element.addEventListener(RECORDER_EVENTS.play, play);
    (rec.element.querySelector('.cyc-rec-cancel') as HTMLButtonElement).click();
    (rec.element.querySelector('.cyc-rec-pause-toggle') as HTMLButtonElement).click();
    (rec.element.querySelector('.cyc-rec-play') as HTMLButtonElement).click();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('scrubbing the strip emits a clamped seek only when seekable', async () => {
    const {rec, RECORDER_EVENTS} = await makeRecorder();
    const strip = rec.element.querySelector('.cyc-rec-strip') as HTMLElement;
    stubRect(strip, 0, 100);
    const seen: number[] = [];
    rec.element.addEventListener(RECORDER_EVENTS.seek, (e) => {
      seen.push((e as CustomEvent<number>).detail);
    });

    strip.dispatchEvent(new MouseEvent('click', {clientX: 50}));
    expect(seen).toEqual([]);

    rec.renderRecorder({seekable: true});
    expect(strip.classList.contains('is-scrubbable')).toBe(true);
    expect(strip.tabIndex).toBe(0);

    strip.dispatchEvent(new MouseEvent('click', {clientX: 50}));
    expect(seen.at(-1)).toBe(0.5);
    strip.dispatchEvent(new MouseEvent('click', {clientX: -20}));
    expect(seen.at(-1)).toBe(0);
    strip.dispatchEvent(new MouseEvent('click', {clientX: 250}));
    expect(seen.at(-1)).toBe(1);

    rec.renderRecorder({seekable: false});
    expect(strip.classList.contains('is-scrubbable')).toBe(false);
    expect(strip.tabIndex).toBe(-1);
  });

  it('keyboard arrows nudge the seek from the current playhead when seekable', async () => {
    const {rec, RECORDER_EVENTS} = await makeRecorder();
    const strip = rec.element.querySelector('.cyc-rec-strip') as HTMLElement;
    const seen: number[] = [];
    rec.element.addEventListener(RECORDER_EVENTS.seek, (e) => {
      seen.push((e as CustomEvent<number>).detail);
    });
    rec.renderRecorder({seekable: true, playhead: 0.5});
    strip.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight'}));
    expect(seen.at(-1)).toBeCloseTo(0.55, 5);
    strip.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowLeft'}));
    expect(seen.at(-1)).toBeCloseTo(0.45, 5);
    rec.renderRecorder({seekable: false});
    seen.length = 0;
    strip.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight'}));
    expect(seen).toEqual([]);
  });

  it('does not seek when the strip rect has no width', async () => {
    const {rec, RECORDER_EVENTS} = await makeRecorder();
    const strip = rec.element.querySelector('.cyc-rec-strip') as HTMLElement;
    rec.renderRecorder({seekable: true});
    stubRect(strip, 0, 0);
    const seek = vi.fn();
    rec.element.addEventListener(RECORDER_EVENTS.seek, seek);
    strip.dispatchEvent(new MouseEvent('click', {clientX: 10}));
    expect(seek).not.toHaveBeenCalled();
  });
});
