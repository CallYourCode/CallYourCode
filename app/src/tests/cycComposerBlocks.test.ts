import {beforeEach, describe, expect, test, vi} from 'vitest';
vi.hoisted(() => {
  (globalThis as any).indexedDB = {open: () => ({})};
});
import {
  createComposerBlocks,
  type ComposerBlocksDeps
} from '../features/composer/components/composerBlocks';

beforeEach(() => {
  (URL as any).createObjectURL = vi.fn(() => 'blob:test');
  (URL as any).revokeObjectURL = vi.fn();
});
function makeBlocks(over: Partial<ComposerBlocksDeps> = {}) {
  const input = document.createElement('div');
  const composerRows = document.createElement('div');
  const btnAttach = document.createElement('button');
  const setEmpty = vi.fn();
  const applyPlaceholder = vi.fn();
  const api = createComposerBlocks({
    input,
    composerRows,
    btnAttach,
    isDisabled: () => false,
    setEmpty,
    applyPlaceholder,
    ...over
  });

  composerRows.append(api.blocksRow, api.blocksThumb);
  return {api, input, composerRows, btnAttach, setEmpty, applyPlaceholder};
}
const png = (name = 'shot.png') => new File(['x'], name, {type: 'image/png'});
const pdf = (name = 'doc.pdf') => new File(['x'], name, {type: 'application/pdf'});
describe('attachments', () => {
  test('an empty composition hides the row', () => {
    const {api} = makeBlocks();
    expect(api.blocksRow.classList.contains('cyc-off')).toBe(true);
    expect(api.blocksRow.children.length).toBe(0);
  });
  test('staging an image renders a chip with a thumbnail and starts the upload', async () => {
    let resolveUpload!: () => void;
    const onStage = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveUpload = res;
        })
    );
    const {api, setEmpty} = makeBlocks({onStage});
    api.stage(png());
    expect(onStage).toHaveBeenCalledTimes(1);
    expect(api.blocksRow.classList.contains('cyc-off')).toBe(false);
    const chip = api.blocksRow.querySelector('.cyc-attach-chip');
    expect(chip).toBeTruthy();
    expect(chip.querySelector('img.cyc-attach-thumb')).toBeTruthy();
    expect(chip.querySelector('.cyc-attach-name').textContent).toBe('shot.png');

    expect(chip.classList.contains('cyc-attach-uploading')).toBe(true);
    resolveUpload();
    await Promise.resolve();
    await Promise.resolve();
    expect(chip.classList.contains('cyc-attach-uploading')).toBe(false);
    expect(api.staged()[0].done).toBe(true);
    expect(setEmpty).toHaveBeenCalled();
  });
  test('a non-image renders the document glyph, no thumbnail', () => {
    const {api} = makeBlocks();
    api.stage(pdf());
    const chip = api.blocksRow.querySelector('.cyc-attach-chip');
    expect(chip.querySelector('img.cyc-attach-thumb')).toBeNull();
    expect(chip.querySelector('.cyc-attach-name').textContent).toBe('doc.pdf');
  });
  test('a page answer is tinted and named by its label, not its file', () => {
    const {api} = makeBlocks();
    api.stage(png('answer.png'), {label: 'Option B', page: 'quiz'});
    const chip = api.blocksRow.querySelector('.cyc-attach-chip');
    expect(chip.classList.contains('cyc-attach-frompage')).toBe(true);
    expect(chip.querySelector('.cyc-attach-name').textContent).toBe('Option B');
    expect(chip.querySelector('.cyc-attach-from').textContent).toBe('quiz');
  });
  test('the remove cross round-trips: chip gone, row hidden again', () => {
    const {api} = makeBlocks();
    api.stage(png());
    const remove = api.blocksRow.querySelector<HTMLElement>('.cyc-block-remove');
    remove.click();
    expect(api.blocks.length).toBe(0);
    expect(api.blocksRow.children.length).toBe(0);
    expect(api.blocksRow.classList.contains('cyc-off')).toBe(true);
  });
  test('a failed upload marks the chip and a tap retries it', async () => {
    let calls = 0;
    const onStage = vi.fn(() => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('refused')) : Promise.resolve();
    });
    const {api} = makeBlocks({onStage});
    api.stage(png());
    await Promise.resolve();
    await Promise.resolve();
    const chip = api.blocksRow.querySelector<HTMLElement>('.cyc-attach-chip');
    expect(chip.classList.contains('cyc-attach-failed')).toBe(true);
    expect(chip.querySelector('.cyc-attach-name').textContent).toContain('tap to retry');
    chip.click();
    expect(onStage).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(chip.classList.contains('cyc-attach-failed')).toBe(false);
  });
});
describe('quotes and replies', () => {
  test('addQuote renders a quote card with its title and text', () => {
    const {api} = makeBlocks();
    api.addQuote('the words', 'Claude');
    const card = api.blocksRow.querySelector('.cyc-block-quote');
    expect(card.querySelector('.cyc-block-quote-from').textContent).toBe('Claude');
    expect(card.querySelector('.cyc-block-quote-text').textContent).toBe('the words');
  });
  test('setReplyTo puts the reply first and getReplyTo reads it back', () => {
    const {api} = makeBlocks();
    api.addQuote('a quote');
    const r = {ts: 9, role: 'claude' as const, title: 'Claude', text: 'answered'};
    api.setReplyTo(r);
    expect(api.blocks[0].kind).toBe('reply');
    expect(api.getReplyTo()).toBe(r);
    expect(api.blocksRow.querySelector('.cyc-block-reply')).toBeTruthy();
    api.setReplyTo(undefined);
    expect(api.getReplyTo()).toBeUndefined();
    expect(api.blocksRow.querySelector('.cyc-block-reply')).toBeNull();
  });
});
describe('voice cards', () => {
  test('a clip with provisional words draws the two-tone split and the dots', () => {
    const {api} = makeBlocks();
    api.addVoice({durationS: 3, text: 'hello there', committed: 5});
    const card = api.blocksRow.querySelector('.cyc-block-voice');
    expect(card.querySelector('.cyc-vb-done').textContent).toBe('hello');
    expect(card.querySelector('.cyc-vb-tail').textContent).toBe(' there');
    expect(card.querySelector('.cyc-transcript-dots')).toBeTruthy();
  });
  test('the handle streams words into the card and settles them', () => {
    const {api} = makeBlocks();
    const handle = api.addVoice({durationS: 3, text: ''});
    handle.update({text: 'all done', committed: undefined});
    const card = api.blocksRow.querySelector('.cyc-block-voice');
    expect(card.querySelector('.cyc-vb-done').textContent).toBe('all done');

    expect(card.querySelector('.cyc-transcript-dots')).toBeNull();
  });
  test('attach() stages the blob, carries the duration, and file() returns it', () => {
    const {api} = makeBlocks();
    const handle = api.addVoice({durationS: 7, text: 'words'});
    expect(handle.file()).toBeNull();
    const f = new File(['a'], 'take.webm', {type: 'audio/webm'});
    handle.attach(f);
    expect(handle.file()).toBe(f);
    expect(api.staged()[0].durationS).toBe(7);
    handle.remove();
    expect(handle.file()).toBeNull();
    expect(api.blocks.length).toBe(0);
  });
  test('lost, waiting, restored and unsure each say so on the card', () => {
    const {api} = makeBlocks();
    const handle = api.addVoice({durationS: 2, text: 'frag'});
    const note = () => api.blocksRow.querySelector('.cyc-block-voice-note')?.textContent ?? '';
    handle.update({waiting: true});
    expect(note()).toContain('waiting for this recording');
    handle.update({waiting: false, lost: true});
    expect(note()).toContain('never reached the app');
    handle.update({lost: false, restored: true});
    expect(note()).toContain('before the reload');
    handle.update({restored: false, unsure: true});
    expect(note()).toContain('transcript incomplete');
  });
});
describe('the block list contract', () => {
  test('onBlocks fires for a change and NOT for setBlocks', () => {
    const {api} = makeBlocks();
    const sub = vi.fn();
    api.onBlocks(sub);
    api.addQuote('q');
    expect(sub).toHaveBeenCalledTimes(1);
    api.setBlocks([{kind: 'prompt', text: 'bit'}]);
    expect(sub).toHaveBeenCalledTimes(1);
    expect(api.blocksRow.querySelector('.cyc-block-prompt')).toBeTruthy();
  });
  test('getBlocks returns a copy, not the live list', () => {
    const {api} = makeBlocks();
    api.addQuote('q');
    const copy = api.getBlocks();
    copy.length = 0;
    expect(api.blocks.length).toBe(1);
  });
});
