import {h, swapClasses} from '../../../components/domHelpers';
import {
  currentPresentationTheme,
  paintTheme,
  registerThemePainter,
  type PresentationTheme
} from '../../../components/presentation';
import {
  makeIcon,
  makeIconOrText,
  makeIconButton,
  BTN_HOVER_UTILS
} from '../../../components/iconGlyphs';
import {replyPanel} from '@/features/chat/messages/messageContent';
import {applyQuoteDecor} from '@/features/chat/quoteDecor';
import {audioElement} from '@/features/chat/messages/audioMessages';
import {createDialPanel, type DialPanel, type DialStep} from '../../../components/replyLevel';
import type {CycReplyTo} from '../../../types';
import {openMenu, openSheet, type CycMenuItem} from '../../../components/popupMenu';
import {touchCapable} from '@/shared/capabilities';
import {WebAudioClip} from '../../../audio/webAudioClip';
import {isHeic, heicToJpegForUpload} from '@/features/media/heic';
import {
  COMPOSER_ICON_TRANSITION,
  type ComposerBlock,
  type ComposerPluginWidget,
  type Staged,
  type VoiceClip,
  type VoiceHandle
} from './composerModel';

const SHEET_MAX_WIDTH = 900;

// Chip fills. `!` beats the base light-secondary utility.
const CHIP_BG_PRIMARY: Record<PresentationTheme, string> = {
  day: 'bg-[#96602f]!',
  night: 'bg-[#c98652]!'
};
const CHIP_BG_DANGER: Record<PresentationTheme, string> = {
  day: 'bg-[#d64246]!',
  night: 'bg-[#ff6262]!'
};
const ALL_CHIP_BG = [...Object.values(CHIP_BG_PRIMARY), ...Object.values(CHIP_BG_DANGER)];
const PROMPT_BG: Record<PresentationTheme, string> = {
  day: 'bg-[rgba(150,96,47,0.08)]!',
  night: 'bg-[rgba(201,134,82,0.08)]!'
};
const PRIMARY_TEXT: Record<PresentationTheme, string> = {
  day: 'text-[#96602f]!',
  night: 'text-[#c98652]!'
};
const SECONDARY_TEXT: Record<PresentationTheme, string> = {
  day: 'text-[#6b6b70]!',
  night: 'text-[#a0a0a6]!'
};
const ALL_PROMPT_BG = Object.values(PROMPT_BG);
const ALL_PRIMARY_TEXT = Object.values(PRIMARY_TEXT);
const ALL_SECONDARY_TEXT = Object.values(SECONDARY_TEXT);

export type ComposerBlocksDeps = {
  input: HTMLElement;

  composerRows: HTMLElement;

  btnAttach: HTMLButtonElement;
  isDisabled(): boolean;

  setEmpty(): void;

  applyPlaceholder(text: string): void;
  onStage?: (file: File, onProgress: (ratio: number) => void) => Promise<unknown>;
  onJumpToReply?: (replyTo: CycReplyTo) => void;
};

export function createComposerBlocks(deps: ComposerBlocksDeps) {
  const {
    input,
    composerRows,
    btnAttach,
    isDisabled,
    setEmpty,
    applyPlaceholder,
    onStage,
    onJumpToReply
  } = deps;

  const filePicker = h('input', '', {
    type: 'file',
    multiple: 'true',
    hidden: 'true'
  }) as HTMLInputElement;
  const imagePicker = h('input', '', {
    type: 'file',
    accept: 'image/*',
    multiple: 'true',
    hidden: 'true'
  }) as HTMLInputElement;

  const blocks: ComposerBlock[] = [];
  const blocksRow = h(
    'div',
    [
      'cyc-blocks cyc-attach-strip cyc-off',
      'flex w-full flex-[0_1_auto] flex-wrap items-start gap-1.5',
      'min-h-0 overflow-y-auto overscroll-contain pt-2 ps-3 pe-2'
    ].join(' ')
  );

  const blocksThumb = h(
    'div',
    'cyc-overflow-thumb cyc-blocks-thumb absolute end-[1px] w-[5px] bg-[var(--cyc-overflowbar-color)] ' +
      'cursor-default opacity-0! rounded-[6px]! [transition:opacity_0.1s_ease-in-out] ' +
      'pointer-events-none [&.cyc-shown]:opacity-100 [.cyc-overflow:hover_&]:opacity-100!'
  );
  const paintBlocksThumb = () => {
    const {scrollHeight, clientHeight, scrollTop, offsetTop} = blocksRow;
    const over = scrollHeight > clientHeight + 1;
    blocksThumb.classList.toggle('cyc-shown', over && !blocksRow.classList.contains('cyc-off'));
    if (!over) return;

    const tall = Math.max(24, Math.round((clientHeight * clientHeight) / scrollHeight));
    const travel = clientHeight - tall;
    const at = Math.round(travel * (scrollTop / (scrollHeight - clientHeight)));
    blocksThumb.style.height = `${tall}px`;
    blocksThumb.style.top = `${offsetTop + at}px`;
  };
  blocksRow.addEventListener('scroll', paintBlocksThumb);

  const staged = () =>
    blocks.flatMap((b) =>
      b.kind === 'attach' ? [b.staged] : b.kind === 'voice' && b.staged ? [b.staged] : []
    );

  // Page chips stay primary even on failure; other failures use danger fill.
  const applyChipSurface = (st: Staged) => {
    const chip = st.chip;
    if (!chip) return;
    const theme = currentPresentationTheme();
    chip.classList.remove(...ALL_CHIP_BG, 'cursor-pointer');
    st.nameEl?.classList.remove('text-white!');
    if (st.fromPage) {
      chip.classList.add(CHIP_BG_PRIMARY[theme]);
    } else if (st.error) {
      chip.classList.add(CHIP_BG_DANGER[theme]);
    }
    if (st.error) {
      chip.classList.add('cursor-pointer');
      st.nameEl?.classList.add('text-white!');
    }
  };

  const paintChip = (st: Staged) => {
    const uploading = !st.done && !st.error;
    st.chip?.classList.toggle('cyc-attach-uploading', uploading);
    st.chip?.classList.toggle('cyc-attach-failed', !!st.error);
    if (st.ring) {
      st.ring.classList.toggle('hidden', !uploading);
      st.ring.classList.toggle('block', uploading);
      st.ring.style.setProperty('--cyc-attach-progress', `${Math.round(st.progress * 100)}`);
    }
    st.chip?.querySelector('.cyc-attach-thumb')?.classList.toggle('opacity-50', uploading);
    applyChipSurface(st);

    if (st.error && st.nameEl) {
      st.nameEl.textContent = `${st.fromPage?.label ?? st.file.name}, tap to retry`;
    }
  };

  const beginUpload = (st: Staged) => {
    if (!onStage) {
      st.done = true;
      return;
    }
    st.error = null;
    st.progress = 0;
    st.upload = onStage(st.file, (r: number) => {
      st.progress = r;
      paintChip(st);
    });
    paintChip(st);
    st.upload.then(
      () => {
        st.done = true;
        st.progress = 1;
        paintChip(st);
      },
      (e: unknown) => {
        st.error = e instanceof Error ? e : new Error('upload failed');
        paintChip(st);
      }
    );
  };

  const removeBtn = (extra: string, what: string) => {
    const b = makeIconButton(
      'close',
      (
        `cyc-block-remove ${COMPOSER_ICON_TRANSITION} hover:opacity-100! w-5 h-5 text-[1rem]! opacity-65 [background:none]! ` +
        '[.cyc-block>&]:absolute [.cyc-block>&]:top-0.5 [.cyc-block>&]:end-0.5 [.cyc-block>&]:z-[2] ' +
        extra
      ).trim(),
      false
    );
    b.title = `remove ${what}`;
    b.setAttribute('aria-label', `remove ${what}`);
    return b;
  };

  const drop = (block: ComposerBlock) => {
    const i = blocks.indexOf(block);
    if (i < 0) return;
    if (heldOn === block) stopHeld();
    blocks.splice(i, 1);
    renderBlocks();
  };

  const attachChip = (block: ComposerBlock & {kind: 'attach'}): HTMLElement => {
    const st = block.staged;
    const chip = h(
      'div',
      'cyc-attach-chip cyc-block-chip relative flex max-w-56 flex-none items-center gap-1.5 rounded-2xl bg-[var(--cyc-text-muted-tint)] pt-1 pr-1 pb-1 pl-2'
    );
    st.chip = chip;
    // Repaint the chip's themed surface on live day/night flips; pruned when the
    // chip detaches on the next re-render.
    registerThemePainter(chip, () => applyChipSurface(st));
    const remove = removeBtn('cyc-attach-remove w-6! h-6!', st.fromPage?.label ?? st.file.name);
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      drop(block);
    });

    chip.addEventListener('click', () => {
      if (!st.error) return;
      // A HEIC that failed to decode retries the conversion; an upload failure
      // retries the upload. Either way the raw .heic never reaches the server.
      if (st.retry) st.retry();
      else beginUpload(st);
    });
    if (st.fromPage) {
      chip.classList.add('cyc-attach-frompage', 'ps-1.5!', 'text-white!');
      remove.classList.add('text-white!');
      chip.append(
        makeIcon(
          'check',
          'cyc-attach-glyph flex h-6 w-6 flex-none items-center justify-center rounded-full bg-[rgba(255,255,255,0.22)] text-sm'
        )
      );
      const text = h('span', 'cyc-attach-text flex min-w-0 flex-col leading-[1.15]');
      const label = h(
        'span',
        'cyc-attach-name overflow-hidden text-ellipsis whitespace-nowrap text-sm text-white'
      );
      label.textContent = st.fromPage.label;
      const from = h(
        'span',
        'cyc-attach-from overflow-hidden text-ellipsis whitespace-nowrap text-[0.6875rem] opacity-75'
      );
      from.textContent = st.fromPage.page;
      st.nameEl = label;
      text.append(label, from);
      chip.append(text, remove);
      chip.title = `${st.fromPage.label} (answered on ${st.fromPage.page})`;
      paintChip(st);
      return chip;
    }
    if (st.file.type.startsWith('image/')) {
      const img = h('img', 'cyc-attach-thumb h-7 w-7 rounded-md object-cover') as HTMLImageElement;
      const url = URL.createObjectURL(st.file);
      img.src = url;

      img.addEventListener('load', () => URL.revokeObjectURL(url), {once: true});
      chip.append(img);
    } else {
      chip.append(makeIcon('document'));
    }

    const ring = h(
      'span',
      [
        'cyc-attach-ring hidden absolute start-2 inset-y-1 w-7 rounded-full pointer-events-none',
        'bg-[conic-gradient(#fff_calc(var(--cyc-attach-progress,0)*1%),rgba(255,255,255,0.28)_0)]',
        '[mask:radial-gradient(circle,transparent_60%,#000_62%)]',
        '[-webkit-mask:radial-gradient(circle,transparent_60%,#000_62%)]'
      ].join(' ')
    );
    st.ring = ring;
    chip.append(ring);
    const name = h(
      'span',
      'cyc-attach-name overflow-hidden text-ellipsis whitespace-nowrap text-sm'
    );
    name.textContent = st.file.name;
    st.nameEl = name;
    chip.append(name, remove);
    paintChip(st);
    return chip;
  };

  const replyCard = (block: ComposerBlock & {kind: 'reply'}): HTMLElement => {
    const wrapper = h(
      'div',
      'cyc-block cyc-block-reply cyc-reply-wrap relative min-w-0 flex-[1_1_100%] mb-1 rounded-[6px]! ' +
        'w-full p-0 select-none z-[2] pointer-events-auto overflow-hidden'
    );
    const content = h('div', 'cyc-reply-wrap-content flex w-full items-center gap-[inherit] pe-5');

    const panel = replyPanel(block.reply, true);
    panel.classList.add('order-1', 'flex-[1_1_auto]', 'min-h-10!');
    panel.querySelector('.cyc-reply-content')?.classList.add('py-0.5!');
    panel
      .querySelector('.cyc-reply-subtitle')
      ?.classList.add('text-(--cyc-text-muted)!', 'h-[1.125rem]');
    content.append(
      makeIconButton(
        'reply',
        `cyc-reply-icon ${COMPOSER_ICON_TRANSITION} text-[rgb(var(--cyc-sender-rgb,var(--cyc-accent-rgb)))]! order-0 pointer-events-none mb-0!`
      ),
      panel
    );
    const cancel = removeBtn(
      'cyc-reply-cancel text-[rgb(var(--cyc-sender-rgb,var(--cyc-accent-rgb)))]! order-2 mb-0!',
      'the reply'
    );

    cancel.addEventListener('click', () => {
      drop(block);

      if (!touchCapable) input.focus({preventScroll: true});
    });

    content.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.cyc-reply.cyc-callout-surface')) return;
      onJumpToReply?.(block.reply);
    });
    wrapper.append(content, cancel);
    return wrapper;
  };

  const quoteCard = (block: ComposerBlock & {kind: 'quote'}): HTMLElement => {
    const card = h(
      'div',
      'cyc-block cyc-block-quote relative min-w-0 flex-[1_1_100%] rounded-[6px]!'
    );
    const quote = h(
      'div',
      'cyc-callout-surface cyc-callout-rail cyc-callout-marked py-1! ps-3! pe-6! text-[0.9375rem]! leading-[1.25]!'
    );
    applyQuoteDecor(quote);
    if (block.title) {
      const who = h(
        'div',
        'cyc-block-quote-from text-[0.8125rem] font-medium text-[rgb(var(--cyc-sender-rgb,var(--cyc-accent-rgb)))]'
      );
      who.textContent = block.title;
      quote.append(who);
    }
    const body = h('div', 'cyc-block-quote-text whitespace-pre-wrap [word-break:break-word]');
    body.textContent = block.text;
    quote.append(body);
    const remove = removeBtn('', 'this quote');
    remove.addEventListener('click', () => drop(block));
    card.append(quote, remove);
    return card;
  };

  let heldAudio: WebAudioClip | null = null;
  let heldUrl = '';
  let heldOn: ComposerBlock | null = null;

  const paintHeld = (playing: boolean, ratio = 0) => {
    for (const el of blocksRow.querySelectorAll<HTMLElement>('.cyc-block-voice')) {
      const mine = playing && el.dataset.playing === '1';
      el.querySelector('.cyc-clip-toggle')?.classList.toggle('playing', mine);
      const fill = el.querySelector<HTMLElement>('.cyc-signal-progress');
      if (fill)
        fill.style.clipPath = mine
          ? `inset(0 ${100 - Math.round(ratio * 100)}% 0 0)`
          : 'inset(0 100% 0 0)';
    }
  };

  const stopHeld = () => {
    heldAudio?.pause();
    if (heldUrl) {
      URL.revokeObjectURL(heldUrl);
      heldUrl = '';
    }
    heldOn = null;
    for (const el of blocksRow.querySelectorAll<HTMLElement>('.cyc-block-voice')) {
      delete el.dataset.playing;
    }
    paintHeld(false);
  };

  const playHeld = (block: ComposerBlock & {kind: 'voice'}, from: HTMLElement) => {
    const card = from.closest<HTMLElement>('.cyc-block-voice');
    const clip = block.clip.blob;
    if (!card || !clip) return;
    if (heldOn === block && heldAudio && !heldAudio.paused) {
      heldAudio.pause();
      paintHeld(false);
      return;
    }
    stopHeld();
    heldAudio ??= new WebAudioClip();
    heldUrl = URL.createObjectURL(clip);
    heldAudio.src = heldUrl;
    heldOn = block;
    card.dataset.playing = '1';
    heldAudio.ontimeupdate = () =>
      paintHeld(true, heldAudio!.duration ? heldAudio!.currentTime / heldAudio!.duration : 0);
    heldAudio.onended = stopHeld;
    void heldAudio.play().then(() => paintHeld(true, 0), stopHeld);
  };

  const seekHeld = (block: ComposerBlock & {kind: 'voice'}, ratio: number) => {
    if (heldOn !== block || !heldAudio?.duration) return;
    heldAudio.currentTime = heldAudio.duration * ratio;
    paintHeld(true, ratio);
  };

  const voiceCard = (block: ComposerBlock & {kind: 'voice'}): HTMLElement => {
    const card = h(
      'div',
      'cyc-block cyc-block-voice relative min-w-0 flex-[1_1_100%] rounded-lg rounded-[6px]! bg-[var(--cyc-text-muted-tint)] px-2 py-1.5'
    );
    const player = audioElement({
      durationS: block.clip.durationS,
      out: true,
      eager: true,
      onPlay: (el) => {
        block.onPlay?.(el);
        playHeld(block, el);
      },
      onSeek: (ratio) => seekHeld(block, ratio)
    });
    player.classList.add('block!', 'w-full!', '[padding-inline-end:1.25rem]!');
    card.append(player);
    const transcript = h(
      'div',
      'cyc-transcript cyc-block-voice-text text-[0.9375rem] leading-[1.25] [word-break:break-word]'
    );
    const {text, committed} = block.clip;
    const cut =
      committed === undefined ? text.length : Math.max(0, Math.min(committed, text.length));
    const done = h('span', 'cyc-vb-done');
    done.textContent = text.slice(0, cut);
    const tail = h('span', 'cyc-vb-tail');
    tail.textContent = text.slice(cut);
    transcript.append(done, tail);

    if (block.clip.lost) {
      card.classList.add('cyc-block-voice-unsure');
      const note = h('span', 'cyc-block-voice-note block text-xs italic opacity-80');
      note.textContent = text
        ? 'the recording never reached the app; only these words can be sent'
        : 'this recording never reached the app, so it cannot be sent';
      transcript.append(note);
    } else if (block.clip.waiting) {
      card.classList.add('cyc-block-voice-unsure');
      const note = h('span', 'cyc-block-voice-note block text-xs italic opacity-80');
      note.textContent = 'waiting for this recording before the message goes';
      transcript.append(note);
    } else if (block.clip.restored) {
      card.classList.add('cyc-block-voice-unsure');
      const note = h('span', 'cyc-block-voice-note block text-xs italic opacity-80');
      note.textContent = 'a recording from before the reload; it was never sent';
      transcript.append(note);
    } else if (block.clip.unsure) {
      card.classList.add('cyc-block-voice-unsure');
      const note = h('span', 'cyc-block-voice-note block text-xs italic opacity-80');
      note.textContent = text
        ? 'transcript incomplete, the recording goes with it'
        : 'no transcript, the recording goes with it';
      transcript.append(note);
    } else if (committed !== undefined || !text) {
      transcript.append(h('span', 'cyc-transcript-dots'));
    }
    if (card.classList.contains('cyc-block-voice-unsure')) {
      const paintUnsure = () => {
        const theme = currentPresentationTheme();
        swapClasses(transcript, ALL_SECONDARY_TEXT, [SECONDARY_TEXT[theme]]);
      };
      paintTheme(card, paintUnsure);
    }
    card.append(transcript);
    const remove = removeBtn('', 'this recording');
    remove.addEventListener('click', () => drop(block));
    card.append(remove);
    return card;
  };

  const promptChip = (block: ComposerBlock & {kind: 'prompt'}): HTMLElement => {
    const chip = h(
      'div',
      'cyc-attach-chip cyc-block-chip cyc-block-prompt relative flex max-w-56 flex-none items-center gap-1.5 rounded-2xl bg-[var(--cyc-text-muted-tint)] pt-1 pr-1 pb-1 pl-2'
    );
    const name = h(
      'span',
      'cyc-attach-name overflow-hidden text-ellipsis whitespace-nowrap text-sm'
    );
    name.textContent = block.text;
    const remove = removeBtn('', block.text);
    remove.addEventListener('click', () => drop(block));
    chip.append(name, remove);
    chip.title = block.text;
    const paintPrompt = () => {
      const theme = currentPresentationTheme();
      swapClasses(
        chip,
        [...ALL_PROMPT_BG, ...ALL_PRIMARY_TEXT],
        [PROMPT_BG[theme], PRIMARY_TEXT[theme]]
      );
      swapClasses(remove, ALL_PRIMARY_TEXT, [PRIMARY_TEXT[theme]]);
    };
    paintTheme(chip, paintPrompt);
    return chip;
  };

  let shownBlocks = 0;

  const blockSubs: Array<() => void> = [];
  let handingBack = false;

  function renderBlocks() {
    blocksRow.replaceChildren();
    blocksRow.classList.toggle('cyc-off', !blocks.length);
    for (const b of blocks) {
      blocksRow.append(
        b.kind === 'attach'
          ? attachChip(b)
          : b.kind === 'reply'
            ? replyCard(b)
            : b.kind === 'quote'
              ? quoteCard(b)
              : b.kind === 'voice'
                ? voiceCard(b)
                : promptChip(b)
      );
    }
    const grew = blocks.length > shownBlocks;
    shownBlocks = blocks.length;
    setEmpty();

    if (grew) blocksRow.scrollTop = blocksRow.scrollHeight;
    paintBlocksThumb();
    if (!handingBack) for (const fn of blockSubs) fn();
  }

  const beginUploadAndDims = (st: Staged) => {
    const f = st.file;
    beginUpload(st);
    renderBlocks();
    if (f.type.startsWith('image/') && typeof createImageBitmap === 'function') {
      void createImageBitmap(f, {imageOrientation: 'from-image'}).then(
        (bmp) => {
          if (bmp.width > 0 && bmp.height > 0) {
            st.width = bmp.width;
            st.height = bmp.height;
          }
          bmp.close();
        },
        () => {}
      );
    }
  };

  // Normalize a HEIC attachment through the shared intake helper before it is
  // queued for upload. The chip shows immediately (the same pending affordance
  // the picker path has always shown) while the decode runs; a decode failure
  // marks the chip failed with a retry that re-runs the conversion, so a raw
  // undecodable .heic is never uploaded behind the user's back.
  const convertThenUpload = (st: Staged, source: File) => {
    st.error = null;
    st.retry = () => convertThenUpload(st, source);
    renderBlocks();
    heicToJpegForUpload(source).then(
      (jpeg) => {
        st.retry = undefined;
        st.file = jpeg;
        beginUploadAndDims(st);
      },
      (e: unknown) => {
        st.error = e instanceof Error ? e : new Error('HEIC conversion failed');
        renderBlocks();
      }
    );
  };

  const stage = (f: File, fromPage?: {label: string; page: string}) => {
    const st: Staged = {file: f, upload: null, progress: 0, done: false, error: null, fromPage};
    blocks.push({kind: 'attach', staged: st});

    if (isHeic(f)) {
      convertThenUpload(st, f);
    } else {
      beginUploadAndDims(st);
    }
  };

  const takeFile = (picker: HTMLInputElement) => {
    const files = Array.from(picker.files ?? []);
    picker.value = '';
    if (!files.length) return;

    for (const f of files) stage(f);

    if (!touchCapable) input.focus({preventScroll: true});
  };
  filePicker.addEventListener('change', () => takeFile(filePicker));
  imagePicker.addEventListener('change', () => takeFile(imagePicker));

  const attachItems = (): CycMenuItem[] => [
    {icon: 'image', text: 'Photo or Video', onClick: () => imagePicker.click()},
    {icon: 'document', text: 'File', onClick: () => filePicker.click()}
  ];

  btnAttach.addEventListener('click', (e) => {
    if (isDisabled()) return;
    if (touchCapable || window.innerWidth <= SHEET_MAX_WIDTH) {
      openSheet(attachItems(), {triggerElement: btnAttach});
    } else {
      openMenu(attachItems(), e, {triggerElement: btnAttach});
    }
  });

  const insertBitText = (text: string) => {
    input.focus({preventScroll: true});
    const selection = window.getSelection();

    if (
      !selection ||
      selection.rangeCount === 0 ||
      !selection.anchorNode ||
      !input.contains(selection.anchorNode)
    ) {
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }

    let before = '';
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = document.createRange();
      r.selectNodeContents(input);
      const cur = sel.getRangeAt(0);
      r.setEnd(cur.endContainer, cur.endOffset);
      before = r.toString();
    }
    const out = (before && !/\s$/.test(before) ? ' ' : '') + text;

    const lines = out.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i) document.execCommand('insertLineBreak');
      if (lines[i]) document.execCommand('insertText', false, lines[i]);
    }
  };

  const pluginExtras = h('div', 'cyc-plugin-extras contents');

  const pluginDials: {key: string; btn: HTMLElement; panel: DialPanel}[] = [];
  const closePluginDials = (except?: DialPanel) => {
    for (const d of pluginDials) if (d.panel !== except) d.panel.close();
  };

  let dialGrabInside = false;
  document.addEventListener(
    'pointerdown',
    (e) => {
      dialGrabInside = pluginDials.some((d) => d.panel.el.contains(e.target as Node));
    },
    {capture: true}
  );
  document.addEventListener(
    'click',
    (e) => {
      const fromInside = dialGrabInside;
      dialGrabInside = false;
      if (fromInside) return;
      const t = e.target as Node;
      for (const d of pluginDials) {
        if (d.panel.isOpen() && !d.panel.el.contains(t) && !d.btn.contains(t)) d.panel.close();
      }
    },
    {capture: true}
  );

  const buildPluginWidget = (item: ComposerPluginWidget): HTMLElement => {
    const w = item.widget;
    const btn = h(
      'button',
      
      // (transition overridden by COMPOSER_ICON_TRANSITION).
      `cyc-icon-btn cyc-plugin-extra flex items-center justify-center text-center leading-none relative ` +
        `text-[1.5rem]! p-2! text-(--cyc-text-muted) ${COMPOSER_ICON_TRANSITION} ${BTN_HOVER_UTILS}`
    );

    btn.append(
      makeIconOrText(
        w.icon,
        'cyc-plugin-extra-icon flex items-center justify-center text-xl leading-none'
      )
    );
    btn.title = w.label;
    btn.setAttribute('aria-label', w.label);
    if (w.type === 'menu') {
      const rows: CycMenuItem[] = w.items.map((it) => ({
        text: it.text,
        onClick: () => insertBitText(it.insert)
      }));
      btn.addEventListener('click', (e) => {
        if (isDisabled()) return;
        if (touchCapable || window.innerWidth <= SHEET_MAX_WIDTH) {
          openSheet(rows, {triggerElement: btn, className: 'cyc-plugin-widget cyc-bits'});
        } else {
          openMenu(rows, e, {triggerElement: btn, className: 'cyc-plugin-widget cyc-bits'});
        }
      });
    } else {
      const panel = createDialPanel({
        key: w.key,
        title: w.label,
        steps: w.steps as readonly DialStep[],
        value: w.value,
        onPick: (n) => item.onSet?.(n)
      });
      panel.el.classList.add('flex-[0_1_auto]', 'min-h-0', 'overflow-y-auto', 'overscroll-contain');
      composerRows.insertBefore(panel.el, blocksRow);
      pluginDials.push({key: w.key, btn, panel});
      btn.addEventListener('click', () => {
        if (isDisabled()) return;
        const willOpen = !panel.isOpen();
        closePluginDials(panel);
        if (willOpen) panel.toggle();
        else panel.close();
      });
    }
    return btn;
  };

  let pluginStructureStamp = '';
  const structureOf = (list: ComposerPluginWidget[]) =>
    JSON.stringify(
      list.map((x) => {
        const w = x.widget;
        return w.type === 'slider'
          ? {t: 'slider', key: w.key, icon: w.icon, label: w.label, steps: w.steps}
          : {t: 'menu', key: (w as any).key, icon: w.icon, label: w.label, items: w.items};
      })
    );
  const paintPluginPlaceholder = (list: ComposerPluginWidget[]) => {
    const names = list.flatMap((x) => {
      const w = x.widget;
      if (w.type !== 'slider' || w.value == null) return [];
      const step = w.steps.find((s) => s.n === w.value);
      return step ? [step.name] : [];
    });
    if (names.length) applyPlaceholder(names.join(' · '));
  };
  const setPluginWidgets = (list: ComposerPluginWidget[]) => {
    const stamp = structureOf(list);
    if (stamp === pluginStructureStamp) {
      for (const x of list) {
        if (x.widget.type !== 'slider') continue;
        const d = pluginDials.find((p) => p.key === x.widget.key);
        if (d) d.panel.update(x.widget.steps as readonly DialStep[], x.widget.value);
      }
      paintPluginPlaceholder(list);
      return;
    }
    pluginStructureStamp = stamp;

    for (const d of pluginDials) d.panel.el.remove();
    pluginDials.length = 0;
    pluginExtras.replaceChildren();
    for (const item of list) pluginExtras.append(buildPluginWidget(item));
    paintPluginPlaceholder(list);
  };

  const alive = (b: ComposerBlock) => blocks.includes(b);

  const getReplyTo = () => blocks.find((b) => b.kind === 'reply')?.reply;

  const setReplyTo = (r: CycReplyTo | undefined) => {
    const at = blocks.findIndex((b) => b.kind === 'reply');
    const had = at < 0 ? undefined : (blocks[at] as ComposerBlock & {kind: 'reply'}).reply;

    if (had === r || (!had && !r)) return;
    if (had && r && had.ts === r.ts && had.text === r.text && !!had.quote === !!r.quote) return;
    if (at >= 0) blocks.splice(at, 1);

    if (r) blocks.unshift({kind: 'reply', reply: r});
    renderBlocks();
  };

  const addQuote = (text: string, title?: string, source?: CycReplyTo) => {
    blocks.push({kind: 'quote', text, title, source});
    renderBlocks();
  };

  const addVoice = (clip: VoiceClip, onPlay?: (el: HTMLElement) => void): VoiceHandle => {
    const block: ComposerBlock & {kind: 'voice'} = {kind: 'voice', clip: {...clip}, onPlay};
    blocks.push(block);
    renderBlocks();
    return {
      update(next: Partial<VoiceClip>) {
        if (!alive(block)) return;
        Object.assign(block.clip, next);
        renderBlocks();
      },

      attach(file: File) {
        if (!alive(block)) return;

        block.clip.lost = false;

        block.staged = {
          file,
          upload: null,
          progress: 0,
          done: false,
          error: null,
          durationS: block.clip.durationS
        };
        beginUpload(block.staged);
        renderBlocks();
      },
      remove() {
        drop(block);
      },

      file() {
        return alive(block) ? (block.staged?.file ?? null) : null;
      }
    };
  };

  const getBlocks = () => blocks.slice();

  const setBlocks = (next: ComposerBlock[]) => {
    if (!next.length && !blocks.length) return;
    blocks.splice(0, blocks.length, ...next);
    handingBack = true;
    try {
      renderBlocks();
    } finally {
      handingBack = false;
    }
  };

  const onBlocks = (fn: () => void) => {
    blockSubs.push(fn);
  };

  return {
    blocks,
    blocksRow,
    blocksThumb,
    paintBlocksThumb,
    filePicker,
    imagePicker,
    pluginExtras,
    staged,
    renderBlocks,
    stage,
    stopHeld,
    setPluginWidgets,
    getReplyTo,
    setReplyTo,
    addQuote,
    addVoice,
    getBlocks,
    setBlocks,
    onBlocks
  };
}
