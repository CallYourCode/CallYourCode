import {beforeEach, afterEach, describe, expect, test, vi} from 'vitest';
vi.hoisted(() => {
  (globalThis as any).indexedDB = {open: () => ({})};
});
import {
  createComposerBlocks,
  type ComposerBlocksDeps
} from '../features/composer/components/composerBlocks';
import {setPresentationTheme, themePainterCount} from '../components/presentation';

beforeEach(() => {
  (URL as any).createObjectURL = vi.fn(() => 'blob:test');
  (URL as any).revokeObjectURL = vi.fn();
  document.body.innerHTML = '';
  setPresentationTheme('day');
});
afterEach(() => {
  setPresentationTheme('day');
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
  return {api, input, composerRows};
}
const png = (name = 'shot.png') => new File(['x'], name, {type: 'image/png'});
const chipOf = (api: ReturnType<typeof createComposerBlocks>) =>
  api.blocksRow.querySelector<HTMLElement>('.cyc-attach-chip')!;
const cls = (el: Element | null) => el?.className ?? '';

describe('upload structural state (was .cyc-attach-uploading .cyc-attach-ring/-thumb)', () => {
  test('mid-upload the ring shows (block) and the thumb dims; done clears both', async () => {
    let resolveUpload!: () => void;
    const onStage = vi.fn(() => new Promise<void>((res) => (resolveUpload = res)));
    const {api} = makeBlocks({onStage});
    api.stage(png());
    const chip = chipOf(api);
    const ring = chip.querySelector<HTMLElement>('.cyc-attach-ring')!;
    const thumb = chip.querySelector<HTMLElement>('.cyc-attach-thumb')!;
    expect(cls(ring)).toContain('block');
    expect(cls(ring)).not.toContain('hidden');
    expect(cls(thumb)).toContain('opacity-50');

    resolveUpload();
    await Promise.resolve();
    await Promise.resolve();
    expect(cls(ring)).toContain('hidden');
    expect(cls(ring)).not.toContain('block');
    expect(cls(thumb)).not.toContain('opacity-50');
  });
});

describe('failed relationship state (was .cyc-attach-failed)', () => {
  test('a rejected upload paints the danger fill, pointer and white name; retry clears it', async () => {
    let calls = 0;
    const onStage = vi.fn(() => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('nope')) : Promise.resolve();
    });
    const {api} = makeBlocks({onStage});
    api.stage(png());
    await Promise.resolve();
    await Promise.resolve();
    const chip = chipOf(api);
    const name = chip.querySelector<HTMLElement>('.cyc-attach-name')!;
    expect(cls(chip)).toContain('bg-[#d64246]!');
    expect(cls(chip)).toContain('cursor-pointer');
    expect(cls(name)).toContain('text-white!');

    setPresentationTheme('night');
    expect(cls(chip)).toContain('bg-[#ff6262]!');
    expect(cls(chip)).not.toContain('bg-[#d64246]!');

    chip.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(cls(chip)).not.toContain('bg-[#ff6262]!');
    expect(cls(chip)).not.toContain('cursor-pointer');
    expect(cls(name)).not.toContain('text-white!');
  });
});

describe('page-answer relationship state (was .cyc-attach-frompage)', () => {
  test('a page answer paints the primary fill and white ink on chip and cross', () => {
    const {api} = makeBlocks();
    api.stage(png('answer.png'), {label: 'Option B', page: 'quiz'});
    const chip = chipOf(api);
    const remove = chip.querySelector<HTMLElement>('.cyc-attach-remove')!;
    expect(cls(chip)).toContain('bg-[#96602f]!');
    expect(cls(chip)).toContain('text-white!');
    expect(cls(chip)).toContain('ps-1.5!');
    expect(cls(remove)).toContain('text-white!');

    setPresentationTheme('night');
    expect(cls(chip)).toContain('bg-[#c98652]!');
    expect(cls(chip)).not.toContain('bg-[#96602f]!');
  });
});

describe('chip surface across the failed x page-answer matrix (base CSS precedence)', () => {
  const primary = {day: 'bg-[#96602f]!', night: 'bg-[#c98652]!'} as const;
  const danger = {day: 'bg-[#d64246]!', night: 'bg-[#ff6262]!'} as const;
  const allFills = ['bg-[#96602f]!', 'bg-[#c98652]!', 'bg-[#d64246]!', 'bg-[#ff6262]!'];
  const notFill = (chip: HTMLElement, keep: string) => {
    for (const f of allFills) if (f !== keep) expect(cls(chip)).not.toContain(f);
  };

  const stageOk = () => {
    const onStage = vi.fn(() => Promise.resolve());
    return makeBlocks({onStage});
  };
  const stageFail = () => {
    const onStage = vi.fn(() => Promise.reject(new Error('nope')));
    return makeBlocks({onStage});
  };
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  for (const theme of ['day', 'night'] as const) {
    test(`neither: a settled plain upload keeps the base fill, no retry (${theme})`, async () => {
      setPresentationTheme(theme);
      const {api} = stageOk();
      api.stage(png());
      await settle();
      const chip = chipOf(api);
      const name = chip.querySelector<HTMLElement>('.cyc-attach-name')!;
      notFill(chip, '');
      expect(cls(chip)).not.toContain('cursor-pointer');
      expect(cls(name)).not.toContain('text-white!');
      expect(name.textContent).not.toContain('tap to retry');
    });

    test(`failed-only: danger fill, retry cursor, white name and retry text (${theme})`, async () => {
      setPresentationTheme(theme);
      const {api} = stageFail();
      api.stage(png());
      await settle();
      const chip = chipOf(api);
      const name = chip.querySelector<HTMLElement>('.cyc-attach-name')!;
      expect(cls(chip)).toContain(danger[theme]);
      notFill(chip, danger[theme]);
      expect(cls(chip)).toContain('cursor-pointer');
      expect(cls(name)).toContain('text-white!');
      expect(name.textContent).toContain('tap to retry');
    });

    test(`fromPage-only: primary fill, no retry cursor or retry text (${theme})`, () => {
      setPresentationTheme(theme);
      const {api} = makeBlocks();
      api.stage(png('answer.png'), {label: 'Option B', page: 'quiz'});
      const chip = chipOf(api);
      const name = chip.querySelector<HTMLElement>('.cyc-attach-name')!;
      expect(cls(chip)).toContain(primary[theme]);
      notFill(chip, primary[theme]);
      expect(cls(chip)).not.toContain('cursor-pointer');
      expect(name.textContent).not.toContain('tap to retry');
    });

    test(`fromPage+failed: keeps the primary fill but gains retry cursor/name/text (${theme})`, async () => {
      setPresentationTheme(theme);
      const {api} = stageFail();
      api.stage(png('answer.png'), {label: 'Option B', page: 'quiz'});
      await settle();
      const chip = chipOf(api);
      const name = chip.querySelector<HTMLElement>('.cyc-attach-name')!;
      expect(cls(chip)).toContain(primary[theme]);
      expect(cls(chip)).not.toContain(danger[theme]);
      notFill(chip, primary[theme]);
      expect(cls(chip)).toContain('cursor-pointer');
      expect(cls(name)).toContain('text-white!');
      expect(name.textContent).toBe('Option B, tap to retry');
    });
  }
});

describe('prompt block paint (was .cyc-block-prompt)', () => {
  test('the prompt chip paints the light-primary fill and primary ink, cross included', () => {
    const {api} = makeBlocks();
    api.setBlocks([{kind: 'prompt', text: 'bit'}]);
    const chip = api.blocksRow.querySelector<HTMLElement>('.cyc-block-prompt')!;
    const remove = chip.querySelector<HTMLElement>('.cyc-block-remove')!;
    expect(cls(chip)).toContain('bg-[rgba(150,96,47,0.08)]!');
    expect(cls(chip)).toContain('text-[#96602f]!');
    expect(cls(remove)).toContain('text-[#96602f]!');

    setPresentationTheme('night');
    const nightChip = api.blocksRow.querySelector<HTMLElement>('.cyc-block-prompt')!;
    expect(cls(nightChip)).toContain('bg-[rgba(201,134,82,0.08)]!');
    expect(cls(nightChip)).toContain('text-[#c98652]!');
  });
});

describe('unsure voice transcript paint (was .cyc-block-voice-unsure .cyc-block-voice-text)', () => {
  test('a lost clip dims its transcript to the secondary ink, per theme', () => {
    const {api} = makeBlocks();
    api.addVoice({durationS: 2, text: 'frag', lost: true});
    const text = api.blocksRow.querySelector<HTMLElement>('.cyc-block-voice-text')!;
    expect(cls(text)).toContain('text-[#6b6b70]!');

    setPresentationTheme('night');
    const nightText = api.blocksRow.querySelector<HTMLElement>('.cyc-block-voice-text')!;
    expect(cls(nightText)).toContain('text-[#a0a0a6]!');
  });

  test('a settled clip leaves the transcript unpainted', () => {
    const {api} = makeBlocks();
    api.addVoice({durationS: 2, text: 'all done'});
    const text = api.blocksRow.querySelector<HTMLElement>('.cyc-block-voice-text')!;
    expect(cls(text)).not.toContain('text-[#6b6b70]!');
  });
});

describe('painter lifecycle', () => {
  test('a chip painter is pruned once its chip detaches', () => {
    const {api} = makeBlocks();
    const before = themePainterCount();
    api.setBlocks([{kind: 'prompt', text: 'bit'}]);
    expect(themePainterCount()).toBe(before + 1);
    api.setBlocks([]);
    setPresentationTheme('night');
    expect(themePainterCount()).toBe(before);
  });
});
