import {describe, expect, test} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {makeIcon} from '../components/iconGlyphs';

(globalThis as {ResizeObserver?: unknown}).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import {createComposer, type Composer} from '../features/composer/components/messageComposer';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSER_DIR = resolve(HERE, '..', 'features', 'composer');
const read = (p: string) => readFileSync(resolve(COMPOSER_DIR, p), 'utf8');

function makeComposer(): Composer {
  return createComposer({
    onSend: () => {},
    onJumpToReply: () => {},
    onAttach: () => {},
    onStage: () => {},
    onVoiceStart: () => {},
    onVoiceEnd: () => {},
    onLiveSend: () => {},
    onVoiceCancel: () => {}
  } as never);
}

const MIC = makeIcon('record').innerHTML;
const ARROW = makeIcon('send').innerHTML;

describe('send-mode swap: one glyph flips send<->record', () => {
  test('the button ships a single glyph and the record mode by default', () => {
    const c = makeComposer();
    const btn = c.el.querySelector('.cyc-send-btn') as HTMLButtonElement;
    expect(btn.tagName).toBe('BUTTON');

    const glyphs = btn.querySelectorAll('.cyc-send-glyph');
    expect(glyphs.length).toBe(1);
    expect(btn.querySelector('.cyc-send-glyph-send')).toBeNull();
    expect(btn.querySelector('.cyc-send-glyph-record')).toBeNull();
    expect(btn.classList.contains('cyc-swap-icon')).toBe(false);

    expect(btn.dataset.cycSendMode).toBe('record');
    const glyph = glyphs[0] as HTMLElement;
    expect(glyph.innerHTML).toBe(MIC);
    expect(glyph.classList.contains('cyc-swapping')).toBe(false);
  });

  test('flipping voice off swaps to the send arrow and replays the pop', () => {
    const c = makeComposer();
    const btn = c.el.querySelector('.cyc-send-btn') as HTMLButtonElement;
    const glyph = btn.querySelector('.cyc-send-glyph') as HTMLElement;

    c.setVoiceEnabled(false);
    expect(btn.dataset.cycSendMode).toBe('send');
    expect(glyph.innerHTML).toBe(ARROW);
    expect(glyph.classList.contains('cyc-swapping')).toBe(true);

    c.setVoiceEnabled(true);
    expect(btn.dataset.cycSendMode).toBe('record');
    expect(glyph.innerHTML).toBe(MIC);
  });

  test('disabling the composer still disables the button (a11y preserved)', () => {
    const c = makeComposer();
    const btn = c.el.querySelector('.cyc-send-btn') as HTMLButtonElement;
    c.setDisabled(true);
    expect(btn.disabled).toBe(true);
    c.setDisabled(false);
    expect(btn.disabled).toBe(false);
  });
});

// Bug 3 (voice-record overlay layout): the mic icon must not drift while
// recording, and the lock indicator belongs directly above the mic (the
// slide-up-to-lock path), not floating off to the side.
describe('voice-record overlay layout (Bug 3)', () => {
  test('the lock chip is absolutely anchored above the mic, out of the send-box flow', () => {
    const c = makeComposer();
    const lock = c.el.querySelector('.cyc-rec-lock') as HTMLElement;
    const mic = c.el.querySelector('.cyc-send-btn') as HTMLButtonElement;
    expect(lock).toBeTruthy();
    // Out of flow: it can no longer be a flex sibling that squeezes the mic
    // sideways when it appears (the "mic drifts" bug).
    expect(lock.className).toContain('absolute');
    expect(lock.className).not.toContain('relative');
    // Centred horizontally and lifted directly above the mic (slide-up path),
    // no longer offset to the side (the "lock is somewhere on the right" bug).
    expect(lock.className).toContain('left-1/2');
    expect(lock.className).toContain('-translate-x-1/2');
    expect(lock.className).toContain('[bottom:calc(100%+0.625rem)]');
    // It shares the (relative) send box with the mic, so `absolute` anchors it
    // over the mic rather than over the whole composer.
    expect(lock.parentElement).toBe(mic.parentElement);
  });

  test('the mic button carries no horizontal translate, so it does not wander', () => {
    const c = makeComposer();
    const mic = c.el.querySelector('.cyc-send-btn') as HTMLButtonElement;
    // The only recording transform is a centred scale pulse; nothing shifts it
    // left or right.
    expect(mic.className).toContain('scale(1.06)');
    expect(mic.className).not.toContain('translateX');
    expect(mic.className).not.toContain('translate-x');
  });
});
