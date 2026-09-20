import {h, transcriptDotWave} from '../../../components/domHelpers';
import {autosize} from '@/features/composer/editor';
import {createRecorder, RECORDER_EVENTS} from '../voice/voiceRecorder';
import {markupToText, reconcileFormatting} from '@/features/composer/markup';
import type {ComposerBlock} from './composerModel';

type ComposerFieldDeps = {
  el: HTMLElement;

  composerRows: HTMLElement;
  composerLine: HTMLElement;
  composerFieldBox: HTMLElement;

  input: HTMLElement;

  cluster: HTMLElement;

  setSendMode(record: boolean): void;
  placeholder: string;
  isDisabled(): boolean;
  voiceEnabled(): boolean;

  blocks: ComposerBlock[];

  blocksRow: HTMLElement;
  renderBlocks(): void;
  paintBlocksThumb(): void;

  stopHeld(): void;

  recordingOwnsButton(): boolean;

  cancelRecording(): void;
};

export function createComposerField(deps: ComposerFieldDeps) {
  const {
    el,
    composerRows,
    composerLine,
    composerFieldBox,
    input,
    cluster,
    setSendMode,
    placeholder,
    isDisabled,
    voiceEnabled,
    blocks,
    blocksRow,
    renderBlocks,
    paintBlocksThumb,
    stopHeld,
    recordingOwnsButton,
    cancelRecording
  } = deps;

  const placeholderEl = h(
    'span',
    'cyc-field-placeholder block absolute pointer-events-none opacity-0 z-[1] ' +
      'whitespace-nowrap overflow-hidden text-ellipsis text-[var(--cyc-text-muted)] ' +
      'pe-3 start-2 max-w-[calc(100%-var(--cyc-trail-w,0px))]! ' +
      'translate-y-1 transition-[opacity,translate] duration-100 ease-out ' +
      '[&.cyc-empty]:opacity-75 [&.cyc-empty]:translate-y-0'
  );

  let placeholderText = placeholder;
  placeholderEl.textContent = placeholderText;

  const applyPlaceholder = (text: string) => {
    if (placeholderText === text) return;
    placeholderText = text;
    if (!isDisabled()) placeholderEl.textContent = text;
  };

  const currentPlaceholder = () => placeholderText;

  const hasText = () => !!input.textContent.trim();

  const isEmpty = () => !hasText() && !blocks.some((b) => b.kind !== 'reply');

  const LIFTED = 'cyc-lifted';

  const clusterEl: HTMLElement | null = cluster;

  const textShape = (): {lines: number; right: number} | null => {
    if (!input.firstChild) return null;
    const r = document.createRange();
    r.selectNodeContents(input);
    const tops = new Set<number>();
    let bottom = -Infinity;
    let right = 0;
    for (const rect of r.getClientRects()) {
      if (!rect.width && !rect.height) continue;
      const top = Math.round(rect.top);
      tops.add(top);
      if (top > bottom) {
        bottom = top;
        right = rect.right;
      } else if (top === bottom) right = Math.max(right, rect.right);
    }
    return tops.size ? {lines: tops.size, right} : null;
  };

  const setLift = () => {
    const shape = textShape();
    const clusterL = clusterEl ? clusterEl.getBoundingClientRect().left : 0;
    const atCluster = !!shape && clusterL > 0 && shape.right > clusterL;
    el.classList.toggle(LIFTED, !!shape && (shape.lines > 1 || atCluster));
  };

  const setEmpty = (empty = isEmpty()) => {
    input.classList.toggle('cyc-empty', empty);
    placeholderEl.classList.toggle('cyc-empty', empty);
    setLift();
    if (recordingOwnsButton()) return;

    const wantRecord = voiceEnabled() && empty;
    setSendMode(wantRecord);
  };

  const inputSubs: Array<() => void> = [];
  const onInput = (fn: () => void) => {
    inputSubs.push(fn);
  };

  input.addEventListener('input', () => {
    if (isEmpty()) input.replaceChildren();

    reconcileFormatting(input);
    setEmpty();
    for (const fn of inputSubs) fn();
  });

  const sizer = autosize(input);

  composerFieldBox.append(input, placeholderEl);

  const recPanel = createRecorder({showPauseToggle: false});
  recPanel.element.addEventListener(RECORDER_EVENTS.cancel, () => cancelRecording());

  const slideHint = h(
    'span',
    'cyc-slide-hint hidden items-center whitespace-nowrap text-[var(--cyc-text-muted)] ' +
      'text-[0.875rem] [padding-inline:0.5rem] gap-1 [animation:cyc-slide-nudge_1.4s_ease-in-out_infinite] ' +
      '[.cyc-composer[data-cyc-recording]:not(.cyc-rec-locked)_&]:flex'
  );
  const slideChev = h('span');
  slideChev.textContent = '‹';
  const slideDesk = h('span', 'max-tab:hidden');
  slideDesk.textContent = 'slide to cancel';
  const slidePhone = h('span', 'hidden max-tab:inline');
  slidePhone.textContent = 'cancel';
  slideHint.append(slideChev, slideDesk, slidePhone);
  recPanel.element.insertBefore(slideHint, recPanel.element.children[1]);
  const recPartial = h(
    'span',
    [
      'cyc-pill-partial cyc-vacant hidden absolute bottom-[calc(100%+0.625rem)] start-1 end-15',
      '[.cyc-composer[data-cyc-recording]_&:not(.cyc-vacant)]:flex [.cyc-composer.cyc-hot-capture_&:not(.cyc-vacant)]:flex',
      '[.cyc-composer.cyc-transcribing_&:not(.cyc-vacant)]:flex',
      'flex-col justify-end z-[3] cursor-pointer overflow-hidden max-h-[5.4em]',
      'bg-[var(--cyc-surface)] rounded-2xl px-3 py-1.5 shadow-[0_1px_4px_rgba(0,0,0,0.3)]',
      'text-[var(--cyc-text-muted)] text-[0.875rem] leading-[1.35]',
      '[&.cyc-cap-open]:max-h-[60vh] [&.cyc-cap-open]:overflow-y-auto [&.cyc-cap-open]:justify-start'
    ].join(' ')
  );
  const recPartialText = h('span', 'cyc-pill-partial-text [overflow-wrap:anywhere]');

  const recPartialWords = h('span', 'cyc-pill-partial-words');

  const recPartialDots = h(
    'span',
    'cyc-transcript-dots hidden relative [.cyc-pill-partial.cyc-cap-more_&]:inline-block!'
  );
  const recDotsBg = h('span', 'opacity-40');
  recDotsBg.textContent = '...';
  recPartialDots.append(recDotsBg, transcriptDotWave());

  const recPartialHint = h(
    'span',
    'cyc-pill-partial-hint hidden opacity-60 italic [.cyc-pill-partial.cyc-cap-nostream_&]:inline'
  );
  recPartialHint.textContent = 'no live text for this one: transcribed after you release';
  recPartialText.append(recPartialWords, recPartialDots, recPartialHint);
  recPartial.append(recPartialText);

  const cap = {
    live: false,
    stream: true,

    last: {text: ''} as {text: string; committed?: number}
  };

  const setCaption = (text: string, committed?: number) => {
    cap.last = {text, committed};
    const cut =
      committed === undefined
        ? text.length
        : Math.max(0, Math.min(Math.floor(committed), text.length));

    const chunks: string[] = text ? (text.match(/\S+\s*|\s+/g) ?? []) : [];
    let at = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      let sp = recPartialWords.children[i] as HTMLElement;
      if (!sp) {
        sp = h('span', 'cyc-cap-w [&.cyc-cap-prov]:opacity-50');
        recPartialWords.append(sp);
      }
      if (sp.textContent !== chunk) sp.textContent = chunk;
      sp.classList.toggle('cyc-cap-prov', at + chunk.replace(/\s+$/, '').length > cut);
      at += chunk.length;
    }
    while (recPartialWords.children.length > chunks.length) {
      recPartialWords.lastElementChild.remove();
    }

    recPartial.classList.toggle('cyc-vacant', !text && !cap.live);

    recPartial.classList.toggle('cyc-cap-more', cap.live && cap.stream);
    recPartial.classList.toggle('cyc-cap-nostream', cap.live && !cap.stream);

    if (!text) recPartial.classList.remove('cyc-cap-open');
    recPartial.scrollTop = recPartial.scrollHeight;
  };
  const captionText = () => recPartialWords.textContent;

  recPartial.addEventListener('click', () => {
    if (!captionText()) return;
    const open = recPartial.classList.toggle('cyc-cap-open');
    if (open) recPartial.scrollTop = recPartial.scrollHeight;
  });

  const setPartial = (text: string, committed?: number) => {
    setCaption(text, committed);
  };

  const measure = () => {
    const pill = composerRows.getBoundingClientRect();
    const c = cluster.getBoundingClientRect();
    const field = composerFieldBox.getBoundingClientRect();
    const lead = field.left - pill.left;
    const lineH = parseFloat(getComputedStyle(input).lineHeight);
    if (c.height && lineH) {
      const row = composerLine.getBoundingClientRect();
      const rowPad = parseFloat(getComputedStyle(composerLine).paddingBottom);
      const textPad = parseFloat(getComputedStyle(input).paddingBottom);
      const gap = row.bottom - rowPad - field.bottom + textPad;
      const clear = c.height - gap;
      composerRows.style.setProperty(
        '--cyc-lift',
        `${clear > 0 ? Math.ceil(clear / lineH) * lineH : 0}px`
      );
    }
    if (lead > 0) composerRows.style.setProperty('--cyc-lead-w', `${Math.round(lead)}px`);

    const trail = field.right - c.left;
    if (trail > 0) composerRows.style.setProperty('--cyc-trail-w', `${Math.round(trail)}px`);
  };
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      measure();
      setLift();

      paintBlocksThumb();
    });
    ro.observe(cluster);
    ro.observe(composerLine);
    ro.observe(blocksRow);
  } else {
    requestAnimationFrame(() => {
      measure();
      setLift();
      paintBlocksThumb();
    });
  }

  const readText = () =>
    markupToText(input)
      .replace(/\u00a0/g, ' ')
      .trim();
  const getText = readText;
  const getDraftText = readText;

  const clear = (sent?: ComposerBlock[]) => {
    stopHeld();
    input.replaceChildren();

    const taken: ComposerBlock[] = [];
    if (sent) {
      for (const b of sent) {
        const at = blocks.indexOf(b);
        if (at >= 0) taken.push(...blocks.splice(at, 1));
      }
    } else {
      taken.push(...blocks.splice(0, blocks.length));
    }
    renderBlocks();
    setEmpty(true);

    sizer.update(true);
    return taken;
  };

  const setDraft = (text: string) => {
    if (getDraftText() === text) return;
    input.replaceChildren();

    if (text) input.append(document.createTextNode(text));
    setEmpty();

    sizer.update();
  };

  return {
    placeholderEl,
    applyPlaceholder,
    currentPlaceholder,
    isEmpty,
    setEmpty,
    onInput,
    recPanel,
    recPartial,
    cap,
    setCaption,
    captionText,
    setPartial,
    getText,
    getDraftText,
    clear,
    setDraft
  };
}
