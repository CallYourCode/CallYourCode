import {h} from '../../../components/domHelpers';
import {makeIcon, makeIconButton, BTN_HOVER_UTILS} from '../../../components/iconGlyphs';
import {paintActionControlSize} from '@/components/circleButtonSize';
import type {CycReplyTo} from '../../../types';
import {pasteImageFile, sanitizeClipboardHtml} from '@/features/composer/paste';
import {createComposerBlocks} from './composerBlocks';
import {createComposerField} from './composerField';
import {createComposerRecordGesture} from './composerRecordGesture';
import {
  COMPOSER_ICON_TRANSITION,
  type ComposerPluginWidget,
  type Staged,
  type FileAnchor,
  type ComposerBlock,
  type VoiceClip,
  type VoiceHandle,
  type SendSettled
} from './composerModel';

export {liftQuotes, messageParts, sendPlan, renderParts, sendLayout} from './composerModel';
export type {
  ComposerPluginWidget,
  Staged,
  VoiceClip,
  VoiceHandle,
  SendSettled,
  ComposerBlock,
  MessagePart,
  FileAnchor
} from './composerModel';

// The composer's home-indicator safe-area reserve is the CSS var --cyc-composer-floor.
// The keyboard-aware form below subtracts --cyc-kb-inset from it: when the keyboard
// is up it already covers the home indicator, so the reserve must not be added on
// top of the --cyc-kb-inset lift (that double-count is the visible gap between the
// composer and the keyboard); when the keyboard is shut the inset is 0 and the full
// floor keeps the input above the home indicator. It is spelled out literally at
// each use so Tailwind's static scanner can generate the utility.
//   max(0px, calc(var(--cyc-composer-floor,0px) - var(--cyc-kb-inset,0px)))

type ComposerOptions = {
  // Settles once the message is durable (true), when nothing went (false),
  // or with the send the box keeps until the engine takes it ({kept}); the
  // box clears on true, and on a kept send's late true.
  onSend: (text: string, replyTo?: CycReplyTo) => SendSettled | Promise<SendSettled>;

  onJumpToReply?: (replyTo: CycReplyTo) => void;

  // Settles as onSend does (a bare resolve is true); rejects when the
  // attachment could not go, and the box keeps the composition then too.
  onAttach?: (
    files: Staged[],
    compose: (pending?: (staged: Staged) => string | undefined) => {
      text: string;
      anchors: FileAnchor[];
    },
    replyTo?: CycReplyTo
  ) => void | SendSettled | Promise<void | SendSettled>;

  onStage?: (file: File, onProgress: (ratio: number) => void) => Promise<unknown>;
  onVoiceStart?: () => void;

  onVoiceEnd?: (how: 'release' | 'interrupted') => void;

  onLiveSend?: () => void;

  onVoiceCancel?: () => void;
  placeholder?: string;
  // The chat the box is showing (its draft's owner); null when none is. A
  // kept send belongs to the chat it was pressed in: only that chat's box
  // clears when the engine takes it, and the same words in another chat are
  // a new message.
  boxOwner?: () => string | null;
};

export type Composer = {
  el: HTMLElement;

  setPluginWidgets(list: ComposerPluginWidget[]): void;

  mountAsk(el: HTMLElement): void;

  attach(file: File, fromPage?: {label: string; page: string}): void;

  getReplyTo(): CycReplyTo | undefined;
  setReplyTo(r: CycReplyTo | undefined): void;
  focus(): void;
  clear(): void;

  getDraft(): string;
  setDraft(text: string): void;

  getBlocks(): ComposerBlock[];
  setBlocks(blocks: ComposerBlock[]): void;

  addQuote(text: string, title?: string, source?: CycReplyTo): void;

  addVoice(clip: VoiceClip, onPlay?: (el: HTMLElement) => void): VoiceHandle;
  onInput(fn: () => void): void;

  onBlocks(fn: () => void): void;

  setLevel(db: number): void;

  setPartial(text: string, committed?: number): void;

  setDisabled(disabled: boolean): void;

  setVoiceEnabled(enabled: boolean): void;

  setPlaceholder(text: string): void;

  setLive(on: boolean): void;
  setLivePartial(text: string, committed?: number): void;

  setTranscribing(on: boolean): void;
};

export function createComposer({
  onSend,
  onJumpToReply,
  onAttach,
  onStage,
  onVoiceStart,
  onVoiceEnd,
  onLiveSend,
  onVoiceCancel,
  placeholder = 'Message',
  boxOwner
}: ComposerOptions): Composer {
  const el = h(
    'div',
    // The root's geometry (bottom: --cyc-kb-inset) is per-frame keyboard
    // tracking and must never pass through a CSS transition: a transition here
    // turns every visualViewport step during the keyboard slide into its own
    // lagging animation of the composer (and, via the spacer, the thread). The
    // root therefore carries NO transition utility at all; translate3d stays as
    // the compositor-layer promotion for cheap per-frame moves. Pinned by
    // cycKeyboardNoTransition.test.ts.
    'cyc-composer cyc-composer-main absolute inset-x-0 bottom-[var(--cyc-kb-inset,0px)] z-[2] mx-auto flex w-full max-w-full flex-none flex-col ' +
      '[transform:translate3d(0,0,0)] ' +
      '[&.cyc-lifted]:[--cyc-band-air:2px] [&.cyc-lifted]:[--cyc-text-air:6px] ' +
      'max-tab:bg-[var(--cyc-composer-surface)]'
  );
  const container = h(
    'div',
    'cyc-composer-box cyc-composer-main-box relative mx-auto flex w-full max-w-[var(--cyc-chat-width)] flex-none items-end justify-center'
  );
  const composerRowsOuter = h('div', 'cyc-composer-rows-outer flex w-full');
  const composerRows = h(
    'div',
    [
      'cyc-composer-rows cyc-composer-pill cyc-composer-main-pill cyc-composer-rows-inner',
      'relative z-[3] flex w-full max-w-full flex-none flex-col items-center justify-end',
      '[--cyc-pill-max:min(30rem,45dvh)]',
      'min-h-12 max-h-[var(--cyc-pill-max)] rounded-2xl max-tab:rounded-none',
      'bg-[var(--cyc-composer-surface)] cyc-elevation-low',
      // Disabled never dims: the pill stays opaque so bubbles cannot show through.
      // The floor is the home-indicator safe-area reserve below the input. When the
      // keyboard is up the keyboard already covers the home indicator, so keeping
      // the floor AND lifting the whole composer by --cyc-kb-inset double-counts the
      // safe area and leaves a surface-coloured gap between the input and the
      // keyboard. Collapse the floor by the keyboard inset so the input rests flush
      // on the keyboard when it is open, and keeps its full reserve when it is shut.
      'max-tab:[padding-bottom:max(0px,calc(var(--cyc-composer-floor,0px)-var(--cyc-kb-inset,0px)))] rounded-[6px]!'
    ].join(' ')
  );
  const composerLine = h(
    'div',
    'cyc-composer-line cyc-composer-row relative flex w-full flex-none items-end justify-between gap-1 bg-inherit p-1 ps-3 rounded-[inherit] ' +
      'min-h-12 [.cyc-composer.cyc-lifted_&]:[padding-block-end:calc(4px+var(--cyc-lift,0px)+var(--cyc-text-air,6px))]'
  );
  const liftBand = h(
    'div',
    // Uses the same keyboard-aware floor so the lifted band never extends its
    // background strip over the keyboard when the keyboard is open.
    'cyc-lift-band hidden absolute inset-x-0 [inset-block-end:calc(-1*max(0px,calc(var(--cyc-composer-floor,0px)-var(--cyc-kb-inset,0px))))] ' +
      'h-[calc(var(--cyc-lift,0px)+4px+var(--cyc-band-air,6px)+max(0px,calc(var(--cyc-composer-floor,0px)-var(--cyc-kb-inset,0px))))] ' +
      'bg-(--cyc-background-color) [border-end-start-radius:inherit] [border-end-end-radius:inherit] ' +
      'pointer-events-none [.cyc-composer.cyc-lifted_&]:block'
  );
  const composerFieldBox = h(
    'div',
    'cyc-composer-field relative flex min-h-10 w-px flex-auto items-center self-center overflow-hidden ' +
      '[.cyc-composer.cyc-lifted_&]:min-h-0'
  );

  const btnAttach = makeIconButton(
    'attach',
    // Composer-scoped `p-0!` outranks the icon-button `p-2!`.
    'cyc-attach-btn flex-none [.cyc-composer_&]:p-0! w-10 h-10 ' +
      `${COMPOSER_ICON_TRANSITION} ` +
      '[&[data-cyc-menu-open]]:text-[var(--cyc-accent)] [&[data-cyc-menu-open]]:bg-[var(--cyc-accent-tint)]! ' +
      '[.cyc-composer.cyc-composer-disabled_&]:pointer-events-none max-tab:ms-2.5 ' +
      '[.cyc-composer.cyc-composer-disabled_&]:text-[var(--cyc-text-muted)] ' +
      '[.cyc-composer[data-cyc-recording]_&]:opacity-0 [.cyc-composer[data-cyc-recording]_&]:pointer-events-none'
  );

  const input = h(
    'div',
    // Important max-height and break-spaces; plaintext bidi per line.
    'cyc-composer-input w-full border-0 bg-transparent p-[0.5rem_0] text-[15px] leading-[var(--cyc-line-height)] outline-none cursor-text select-text [transition:height_0.1s] [unicode-bidi:plaintext] ' +
      'max-h-[calc(var(--cyc-pill-max)-1rem)]! [white-space:break-spaces]! [word-break:break-word] ' +
      '[.cyc-composer.cyc-composer-disabled_&]:pointer-events-none [&_pre]:inline [&_pre]:m-0',
    {contenteditable: 'true', dir: 'auto'}
  );

  const sendButtonBox = h(
    'div',
    'cyc-send-box relative isolate z-[3] flex flex-none items-center justify-center ' +
      'w-9! h-9! min-w-9! ms-2 me-0! ' +
      // Locked reads as muted ink, never as transparency (opacity stays 1).
      '[.cyc-composer.cyc-composer-disabled_&]:text-[var(--cyc-text-muted)] ' +
      '[.cyc-composer.cyc-composer-disabled_&]:pointer-events-none'
  );
  const sendGlow = h(
    'div',
    'cyc-send-glow absolute -inset-[10px] rounded-full bg-(--cyc-danger) blur-[6px] opacity-0 pointer-events-none z-0 ' +
      '[.cyc-composer.cyc-pressing_&]:opacity-55 [.cyc-composer[data-cyc-recording]_&]:opacity-55 ' +
      '[.cyc-composer[data-cyc-recording]_&]:[animation:cycRecPulse_1.6s_ease-in-out_infinite]'
  );
  sendButtonBox.append(sendGlow);
  const sendButton = h(
    'button',
    // Recording and pressing paint gates use the send-mode state attribute.
    'cyc-icon-btn cyc-ctl-round cyc-send-btn ' +
      'fine:hover:[.cyc-composer:not([data-cyc-recording]):not(.cyc-pressing)_&]:bg-(--cyc-accent-pressed)! ' +
      'fine:active:[.cyc-composer:not([data-cyc-recording]):not(.cyc-pressing)_&]:bg-(--cyc-accent-pressed)! ' +
      '[.cyc-composer[data-cyc-recording]_&]:pointer-events-auto ' +
      '[.cyc-composer[data-cyc-recording]_&[data-cyc-send-mode=record]]:bg-(--cyc-danger)! ' +
      '[.cyc-composer.cyc-pressing_&[data-cyc-send-mode=record]]:bg-(--cyc-danger)! ' +
      '[.cyc-composer[data-cyc-recording]_&[data-cyc-send-mode=record]]:[transform:scale(1.06)] ' +
      '[.cyc-composer.cyc-pressing_&]:[transform:scale(1.06)] ' +
      '[.cyc-composer[data-cyc-recording]_&[data-cyc-send-mode=record]]:[transition:transform_0.12s_ease-out] ' +
      '[.cyc-composer.cyc-pressing_&]:[transition:transform_0.12s_ease-out] ' +
      '[.cyc-composer.cyc-pressing:not([data-cyc-recording])_&[data-cyc-send-mode=record]]:transition-none ' +
      '[.cyc-composer[data-cyc-recording]_&]:relative [.cyc-composer.cyc-pressing_&]:relative ' +
      '[.cyc-composer[data-cyc-recording]_&]:z-[1] [.cyc-composer.cyc-pressing_&]:z-[1] ' +
      'z-[3] opacity-100! leading-[1.5rem]! touch-none flex items-center justify-center relative flex-none p-0! ' +
      'w-9! h-9! min-w-9! text-[1.5rem]! ' +
      // The button's own `text-white!` beats the send box's muted colour, so the
      // disabled ink is set here (same `!`, higher specificity) where it wins.
      '[.cyc-composer.cyc-composer-disabled_&]:text-[var(--cyc-text-muted)]! ' +
      `bg-[var(--cyc-fill-color)]! text-white! ${COMPOSER_ICON_TRANSITION}`
  );
  // The mode setter swaps the single glyph and replays its animation.
  const sendGlyph = makeIcon('record', 'cyc-send-glyph h-6 leading-6');
  sendButton.dataset.cycSendMode = 'record';
  sendButton.append(sendGlyph);
  sendButtonBox.append(sendButton);

  const setSendMode = (record: boolean) => {
    const mode = record ? 'record' : 'send';
    if (sendButton.dataset.cycSendMode === mode) return;
    sendButton.dataset.cycSendMode = mode;
    sendGlyph.innerHTML = makeIcon(record ? 'record' : 'send').innerHTML;
    sendGlyph.classList.remove('cyc-swapping');
    // Force a reflow so the re-added animation restarts from its first frame.
    sendGlyph.getBoundingClientRect();
    sendGlyph.classList.add('cyc-swapping');
  };

  let disabled = false;

  let voiceEnabled = true;

  const lockChip = h(
    'button',
    // ABSOLUTE, anchored to the send box (its `relative isolate` parent), so
    // the lock is taken OUT of the send box's flex flow. In flow it was a
    // second flex child that the fixed-width box squeezed in beside the mic,
    // shoving the mic icon sideways when recording began (the "mic drifts"
    // bug) and leaving the lock floating off to the side (the "lock is
    // somewhere on the right" bug). Centred horizontally and lifted above the
    // mic, it now sits directly ABOVE it, on the slide-up-to-lock path, and the
    // mic no longer moves. The pointer-slide lock detection reads the chip's
    // live rect, so it follows the chip to its new position.
    'cyc-icon-btn cyc-ctl-round cyc-rec-lock absolute left-1/2 -translate-x-1/2 [bottom:calc(100%+0.625rem)] ' +
      'flex-none items-center justify-center text-[1.5rem]! text-(--cyc-text-muted) p-0! w-10! h-10! ' +
      'leading-[var(--cyc-circle-size)] ' +
      'bg-[var(--cyc-surface)] [box-shadow:0_1px_4px_rgba(0,0,0,0.35)] z-[3] hidden! ' +
      `${COMPOSER_ICON_TRANSITION} [.cyc-composer[data-cyc-recording]:not(.cyc-rec-locked)_&]:flex! ${BTN_HOVER_UTILS}`
  );
  paintActionControlSize(lockChip);
  lockChip.append(makeIcon('lock'));

  sendButtonBox.append(lockChip);

  const cluster = h(
    'div',
    'cyc-send-cluster pointer-events-none absolute end-1.5 bottom-1 flex items-center gap-1 [&>*]:pointer-events-auto'
  );

  const blocksApi = createComposerBlocks({
    input,
    composerRows,
    btnAttach,
    isDisabled: () => disabled,
    setEmpty: () => field.setEmpty(),
    applyPlaceholder: (text) => field.applyPlaceholder(text),
    onStage,
    onJumpToReply
  });
  const {
    blocks,
    blocksRow,
    blocksThumb,
    filePicker,
    imagePicker,
    pluginExtras,
    stage,
    setPluginWidgets
  } = blocksApi;

  const field = createComposerField({
    el,
    composerRows,
    composerLine,
    composerFieldBox,
    input,
    cluster,
    setSendMode,
    placeholder,
    isDisabled: () => disabled,
    voiceEnabled: () => voiceEnabled,
    blocks,
    blocksRow,
    renderBlocks: blocksApi.renderBlocks,
    paintBlocksThumb: blocksApi.paintBlocksThumb,
    stopHeld: blocksApi.stopHeld,
    recordingOwnsButton: () => gesture.recordingOwnsButton(),
    cancelRecording: () => gesture.endRecording('cancel', 'trash')
  });

  const gesture = createComposerRecordGesture({
    el,
    sendButton,
    setSendMode,
    lockChip,
    input,
    recPanel: field.recPanel,
    blocks,
    staged: blocksApi.staged,
    renderBlocks: blocksApi.renderBlocks,
    clear: field.clear,
    getText: field.getText,
    isEmpty: field.isEmpty,
    setEmpty: field.setEmpty,
    setPartial: field.setPartial,
    setCaption: field.setCaption,
    cap: field.cap,
    liveWords: () => liveWords(),
    isDisabled: () => disabled,
    voiceEnabled: () => voiceEnabled,
    boxOwner,
    onSend,
    onAttach,
    onVoiceStart,
    onVoiceEnd,
    onLiveSend,
    onVoiceCancel
  });

  cluster.append(btnAttach, pluginExtras, sendButtonBox);
  composerLine.append(liftBand, composerFieldBox, field.recPanel.element, cluster);
  el.append(filePicker, imagePicker);
  composerRows.append(blocksRow, blocksThumb, composerLine, field.recPartial);
  composerRowsOuter.append(composerRows);
  container.append(composerRowsOuter);
  el.append(container);

  input.addEventListener('paste', (e) => {
    const data = (e as ClipboardEvent).clipboardData;
    const file = pasteImageFile(data);
    if (file) {
      e.preventDefault();
      stage(file);
      return;
    }

    e.preventDefault();

    const html = data?.getData('text/html');
    if (html) {
      const clean = sanitizeClipboardHtml(html);
      if (clean.rich) {
        document.execCommand('insertHTML', false, clean.html);
        return;
      }
    }

    const text = (data?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
    if (!text) return;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i) document.execCommand('insertLineBreak');
      if (lines[i]) document.execCommand('insertText', false, lines[i]);
    }
  });

  let liveMode = false;
  const setLive = (on: boolean) => {
    if (on === liveMode) return;
    liveMode = on;
    el.classList.toggle('cyc-hot-capture', on);
    if (on) {
      field.cap.live = true;
      field.cap.stream = true;
      field.setCaption('');
    } else {
      field.cap.live = false;
      field.cap.stream = true;
      field.setCaption('');
      field.setEmpty();
    }
  };
  const setLivePartial = (text: string, committed?: number) => {
    if (!liveMode) return;
    field.setCaption(text, committed);
    if (gesture.recordingOwnsButton()) return;

    const wantRecord = voiceEnabled && !text;
    setSendMode(wantRecord);
  };

  const liveWords = () => liveMode && !!field.captionText();

  field.setEmpty(true);

  const setTranscribing = (on: boolean) => {
    el.classList.toggle('cyc-transcribing', on);
  };

  return {
    el,

    setPluginWidgets,

    mountAsk(askEl: HTMLElement) {
      composerRows.insertBefore(askEl, composerRows.firstChild);
    },
    attach(file: File, fromPage?: {label: string; page: string}) {
      stage(file, fromPage);
    },
    getReplyTo: blocksApi.getReplyTo,
    setReplyTo: blocksApi.setReplyTo,
    addQuote: blocksApi.addQuote,
    addVoice: blocksApi.addVoice,
    setLive,
    setLivePartial,
    setTranscribing,
    focus() {
      input.focus({preventScroll: true});

      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    },
    clear: field.clear,
    getDraft: field.getDraftText,
    setDraft: field.setDraft,
    getBlocks: blocksApi.getBlocks,
    setBlocks: blocksApi.setBlocks,
    onInput: field.onInput,
    onBlocks: blocksApi.onBlocks,
    setLevel(db: number) {
      if (!gesture.recordingOwnsButton()) return;
      field.recPanel.renderRecorder({peak: Math.pow(10, db / 20)});
    },
    setPartial: field.setPartial,
    setDisabled(v: boolean) {
      const text = v ? 'session offline' : field.currentPlaceholder();
      if (disabled === v && field.placeholderEl.textContent === text) return;
      const becoming = v && !disabled;
      disabled = v;

      if (becoming) gesture.endRecording('interrupted', 'disabled');
      el.classList.toggle('cyc-composer-disabled', v);
      input.contentEditable = v ? 'false' : 'true';
      sendButton.disabled = v;
      btnAttach.disabled = v;
      field.placeholderEl.textContent = text;
    },
    setPlaceholder(text: string) {
      field.applyPlaceholder(text);
    },
    setVoiceEnabled(v: boolean) {
      if (voiceEnabled === v) return;
      voiceEnabled = v;

      if (!v && gesture.recordingOwnsButton()) gesture.endRecording('interrupted', 'voice-off');
      el.classList.toggle('cyc-voice-off', !v);

      const wantRecord = voiceEnabled && field.isEmpty();
      setSendMode(wantRecord);
    }
  };
}
