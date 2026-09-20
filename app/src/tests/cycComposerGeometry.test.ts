import {beforeEach, describe, expect, test, vi} from 'vitest';
vi.hoisted(() => {
  (globalThis as any).indexedDB = {open: () => ({})};
});
import {
  createComposerBlocks,
  type ComposerBlocksDeps
} from '../features/composer/components/composerBlocks';
import {installFileDrop} from '../features/composer/fileDropZone';
import {installComposerDropZone} from '../features/composer/fileCollection';

// Composer block and drop-target rendering.

beforeEach(() => {
  (URL as any).createObjectURL = vi.fn(() => 'blob:test');
  (URL as any).revokeObjectURL = vi.fn();
  document.body.innerHTML = '';
});

function makeBlocks(over: Partial<ComposerBlocksDeps> = {}) {
  const input = document.createElement('div');
  const composerRows = document.createElement('div');
  const btnAttach = document.createElement('button');
  const api = createComposerBlocks({
    input,
    composerRows,
    btnAttach,
    isDisabled: () => false,
    setEmpty: vi.fn(),
    applyPlaceholder: vi.fn(),
    ...over
  });
  composerRows.append(api.blocksRow, api.blocksThumb);
  document.body.append(composerRows);
  return {api, input};
}
const cls = (el: Element | null) => el?.className ?? '';
const q = (root: Element, s: string) => root.querySelector(s);

describe('block card skin', () => {
  test('reply, quote and voice cards carry the 6px block radius and an absolute corner cross', () => {
    const {api} = makeBlocks();
    api.addQuote('hello', 'Someone');
    api.addVoice({durationS: 2, text: 'hi there'});
    api.setReplyTo({ts: 1, text: 'prior', quote: false} as any);

    for (const sel of ['.cyc-block-reply', '.cyc-block-quote', '.cyc-block-voice']) {
      const card = q(api.blocksRow, sel)!;
      expect(cls(card)).toContain('rounded-[6px]!');
      const cross = q(card, ':scope > .cyc-block-remove')!;
      expect(cls(cross)).toContain('[.cyc-block>&]:absolute');
      expect(cls(cross)).toContain('[.cyc-block>&]:top-0.5');
      expect(cls(cross)).toContain('[.cyc-block>&]:end-0.5');
      expect(cls(cross)).toContain('w-5');
      expect(cls(cross)).toContain('text-[1rem]!');
      expect(cls(cross)).toContain('[background:none]!');
    }
  });

  test('removing a card drops the block (behaviour, not just class)', () => {
    const {api} = makeBlocks();
    api.addQuote('bye');
    const card = q(api.blocksRow, '.cyc-block-quote')!;
    expect(api.getBlocks()).toHaveLength(1);
    (q(card, ':scope > .cyc-block-remove') as HTMLButtonElement).click();
    expect(api.getBlocks()).toHaveLength(0);
    expect(q(api.blocksRow, '.cyc-block-quote')).toBeNull();
  });
});

describe('quote frame + voice player', () => {
  test('the quote frame gets the composer-context padding and type scale', () => {
    const {api} = makeBlocks();
    api.addQuote('quoted', 'Author');
    const frame = q(api.blocksRow, '.cyc-callout-surface')!;
    expect(cls(frame)).toContain('py-1!');
    expect(cls(frame)).toContain('ps-3!');
    expect(cls(frame)).toContain('pe-6!');
    expect(cls(frame)).toContain('text-[0.9375rem]!');
    expect(cls(frame)).toContain('leading-[1.25]!');
  });

  test('the voice player fills the card with room for the corner cross', () => {
    const {api} = makeBlocks();
    api.addVoice({durationS: 3, text: 'note'});
    const player = q(api.blocksRow, '.cyc-block-voice .cyc-clip')!;
    expect(cls(player)).toContain('block!');
    expect(cls(player)).toContain('w-full!');
    expect(cls(player)).toContain('[padding-inline-end:1.25rem]!');
  });
});

describe('reply + attach chrome', () => {
  test('the reply icon and cancel take the sender tint; the cancel keeps the shared cross', () => {
    const {api} = makeBlocks();
    api.setReplyTo({ts: 2, text: 'earlier', quote: false} as any);
    const wrap = q(api.blocksRow, '.cyc-reply-wrap')!;
    const icon = q(wrap, '.cyc-reply-icon')!;
    const cancel = q(wrap, '.cyc-reply-cancel')!;
    const tint = 'text-[rgb(var(--cyc-sender-rgb,var(--cyc-accent-rgb)))]!';
    expect(cls(icon)).toContain(tint);
    expect(cls(icon)).toContain('pointer-events-none');
    expect(cls(cancel)).toContain(tint);
    expect(cls(cancel)).toContain('cyc-block-remove');
    expect(cls(icon)).toContain('mb-0!');
    expect(cls(cancel)).toContain('mb-0!');
    expect(cls(wrap)).toContain('overflow-hidden');
    expect(cls(wrap)).toContain('select-none');
    expect(cls(icon)).toContain('[transition:0.2s_opacity]!');
    expect(cls(cancel)).toContain('[transition:0.2s_opacity]!');
  });

  test('the composer-context reply panel takes its injected order/flex and inner overrides', () => {
    const {api} = makeBlocks();
    api.setReplyTo({ts: 3, text: 'earlier', quote: false} as any);
    const wrap = q(api.blocksRow, '.cyc-reply-wrap')!;
    const panel = q(wrap, '.cyc-reply')!;
    expect(cls(panel)).toContain('order-1');
    expect(cls(panel)).toContain('flex-[1_1_auto]');
    expect(cls(panel)).toContain('min-h-10!');
    expect(cls(q(panel, '.cyc-reply-content'))).toContain('py-0.5!');
    const subtitle = q(panel, '.cyc-reply-subtitle')!;
    expect(cls(subtitle)).toContain('text-(--cyc-text-muted)!');
    expect(cls(subtitle)).toContain('h-[1.125rem]');
  });

  test('the attach chip cross is the 1.5rem variant', () => {
    const onStage = vi.fn(() => Promise.resolve());
    const {api} = makeBlocks({onStage});
    api.stage(new File(['x'], 'a.png', {type: 'image/png'}));
    const remove = q(api.blocksRow, '.cyc-attach-chip .cyc-attach-remove')!;
    expect(cls(remove)).toContain('w-6!');
    expect(cls(remove)).toContain('h-6!');
  });
});

describe('drop target and its layer', () => {
  test('the drop target surface carries the fill, radius, dashed border and header weight', () => {
    const host = document.createElement('div');
    document.body.append(host);
    let dropped = false;
    const zone = installFileDrop(host, {
      icon: 'document',
      title: 'Drop files here',
      onDrop: () => (dropped = true)
    });
    expect(cls(zone.container)).toContain('cyc-file-drop');
    // Fills its layer (flex-1 in the layer's column), glyph over label, centred.
    expect(cls(zone.container)).toContain('flex-1');
    expect(cls(zone.container)).toContain('flex-col');
    expect(cls(zone.container)).toContain('items-center');
    expect(cls(zone.container)).toContain('justify-center');
    expect(cls(zone.container)).not.toContain('min-h-52');
    expect(cls(zone.container)).toContain('rounded-3xl');
    expect(cls(zone.container)).toContain('border-2');
    expect(cls(zone.container)).toContain('border-dashed');
    const header = q(host, '.cyc-file-drop-title')!;
    expect(cls(header)).toContain('font-semibold');
    expect(cls(header)).toContain('text-lg');
    const iconEl = q(host, '.cyc-file-drop-icon')!;
    expect(cls(iconEl)).toContain('text-5xl');
    zone.container.dispatchEvent(new Event('dragenter'));
    expect(zone.container.classList.contains('cyc-file-drop-over')).toBe(true);
    zone.container.dispatchEvent(new Event('dragleave'));
    expect(zone.container.classList.contains('cyc-file-drop-over')).toBe(false);
    zone.container.dispatchEvent(new Event('drop'));
    expect(dropped).toBe(true);
  });

  test('installComposerDropZone mounts the overlay with its current cascade utilities', () => {
    const pane = document.createElement('div');
    document.body.append(pane);
    const teardown = installComposerDropZone({
      pane,
      onFiles: vi.fn(),
      canDrop: () => true
    });
    const layer = pane.querySelector('.cyc-drop-layer')!;
    expect(cls(layer)).toContain('absolute!');
    expect(cls(layer)).not.toContain('w-auto!');
    expect(cls(layer)).toContain('[&:not(.cyc-drop-mounted)]:hidden');
    teardown();
    expect(pane.querySelector('.cyc-drop-layer')).toBeNull();
  });
});
