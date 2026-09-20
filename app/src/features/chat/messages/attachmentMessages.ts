import type {CycMessage} from '@/types';
import {WebAudioClip} from '@/audio/webAudioClip';
import {h} from '@/components/domHelpers';
import {makeIcon} from '@/components/iconGlyphs';
import {mmss} from '@/features/chat/content';
import {setFormatted} from '@/features/chat/content';
import {clipAwaitingWords, isAudioUpload, uploadTitle, uploadsOf} from '@/features/chat/content';
import {
  flowStamp,
  footStamp,
  docFootRow,
  createMessageNode,
  setMessageReply,
  photoMessage,
  MESSAGE_CONTENT_UTILS,
  MESSAGE_TEXT_UTILS
} from './messageContent';
import {messageFrameEl, docFrameEl} from './messageFrame';
import {audioElement} from './audioMessages';
import {
  formatBytes,
  markMissingOnError,
  paintDocIcon,
  reserveMediaBox,
  setTunnelSrc,
  DOC_CHAT_UTILS,
  DOC_ICO_UTILS,
  DOC_NAME_UTILS,
  DOC_SIZE_UTILS
} from '@/features/media/mediaBox';
import {resolveAudioUrl} from '@/audio/audioCache';

let clipPlayer: WebAudioClip | null = null;

let clipPlayingSrc = '';

let clipFrame = 0;

type ClipRow = {
  el: HTMLElement;
  u: NonNullable<CycMessage['upload']>;

  rest: () => void;

  at: number;
};

const CLIP_ROW_GRACE_MS = 1000;

const clipRows = new Set<ClipRow>();

function liveClipRows(): ClipRow[] {
  const live: ClipRow[] = [];
  const now = performance.now();
  for (const row of clipRows) {
    if (row.el.isConnected) live.push(row);
    else if (now - row.at > CLIP_ROW_GRACE_MS) clipRows.delete(row);
  }
  return live;
}

function registerClipRow(row: ClipRow): void {
  liveClipRows();
  clipRows.add(row);
}

export function clipPlaybackState(): {
  src: string;
  paused: boolean;
  t: number;
  rows: number;
  live: number;
} {
  let live = 0;
  for (const row of clipRows) if (row.el.isConnected) live++;

  return {
    src: clipPlayingSrc,
    paused: !clipPlayer || clipPlayer.paused,
    t: clipPlayer?.currentTime ?? 0,
    rows: clipRows.size,
    live
  };
}

function stopClipPlayback(): void {
  if (clipFrame) {
    cancelAnimationFrame(clipFrame);
    clipFrame = 0;
  }
  clipPlayer?.pause();
  clipPlayingSrc = '';
  for (const row of liveClipRows()) row.rest();
}

function pauseClipPlayback(): void {
  if (clipFrame) {
    cancelAnimationFrame(clipFrame);
    clipFrame = 0;
  }
  clipPlayer?.pause();
  for (const row of liveClipRows()) {
    row.el.querySelector('.cyc-clip-toggle')?.classList.remove('playing');
  }
}

export function attachmentMessage(
  m: CycMessage,
  first: boolean,
  last: boolean,
  srcOf: (u: NonNullable<CycMessage['upload']>) => string,
  onOpenUpload?: (u: NonNullable<CycMessage['upload']>) => void
): HTMLDivElement {
  const out = m.role === 'user';
  const files = uploadsOf(m);
  const messageNode = createMessageNode(out, first, last, ' cyc-multipart');
  const wrapper = messageFrameEl();
  const content = h('div', 'cyc-message-content ' + MESSAGE_CONTENT_UTILS);
  const message = h('div', 'cyc-message-text ' + MESSAGE_TEXT_UTILS + ' text-[length:14px]');

  const playing = () => clipPlayingSrc;

  const lengthOf = (u: NonNullable<CycMessage['upload']>) => {
    const mine = playing() && playing() === srcOf(u);
    if (mine && clipPlayer && isFinite(clipPlayer.duration) && clipPlayer.duration > 0) {
      return clipPlayer.duration;
    }
    return u.durationS && u.durationS > 0 ? u.durationS : 0;
  };
  const clock = (el: HTMLElement, seconds: number, total: number) => {
    const t = el.querySelector<HTMLElement>('.cyc-clip-time');
    if (!t) return;

    t.textContent =
      total > 0 ? (seconds >= 0 ? `${mmss(seconds)} / ${mmss(total)}` : mmss(total)) : '·:··';
  };
  const paint = (el: HTMLElement, on: boolean, ratio = 0) => {
    const toggle = el.querySelector('.cyc-clip-toggle');
    toggle?.classList.toggle('playing', on);
    if (!on) toggle?.classList.remove('cyc-clip-wait');
    const fill = el.querySelector<HTMLElement>('.cyc-signal-progress');
    if (fill)
      fill.style.clipPath = on
        ? `inset(0 ${100 - Math.round(ratio * 100)}% 0 0)`
        : 'inset(0 100% 0 0)';
  };

  const follow = (el: HTMLElement, u: NonNullable<CycMessage['upload']>) => {
    let paintedPct = -1;
    let paintedSec = -1;
    const toggle = el.querySelector('.cyc-clip-toggle');
    const step = () => {
      if (!el.isConnected || !clipPlayer) {
        stopClipPlayback();
        return;
      }

      if (clipPlayer.paused) {
        pauseClipPlayback();
        return;
      }
      clipFrame = requestAnimationFrame(step);
      const total = lengthOf(u);
      const ratio = total ? Math.min(1, clipPlayer.currentTime / total) : 0;

      const pct = Math.round(ratio * 100);
      if (pct !== paintedPct) {
        paintedPct = pct;
        paint(el, true, ratio);
      }
      const sec = Math.floor(clipPlayer.currentTime);
      if (sec !== paintedSec) {
        paintedSec = sec;
        clock(el, clipPlayer.currentTime, total);
      }

      toggle?.classList.toggle('cyc-clip-wait', clipPlayer.waitingFirstAudio);
    };
    if (clipFrame) cancelAnimationFrame(clipFrame);
    clipFrame = requestAnimationFrame(step);
    clipPlayer!.onended = () => {
      stopClipPlayback();
    };
  };

  type Slot = {u?: NonNullable<CycMessage['upload']>; text?: string};
  const body = m.text;
  const anchored = files.length > 0 && files.every((u) => typeof u.at === 'number');
  const slots: Slot[] = [];
  if (anchored) {
    let pos = 0;
    const order = files.map((u, i) => ({u, i})).sort((a, b) => a.u.at! - b.u.at! || a.i - b.i);
    for (const {u} of order) {
      const at = Math.min(Math.max(u.at!, pos), body.length);
      if (at > pos) slots.push({text: body.slice(pos, at)});
      const len = Math.max(0, Math.min(u.textLen ?? 0, body.length - at));
      slots.push({u, text: len ? body.slice(at, at + len) : undefined});
      pos = at + len;
    }
    if (pos < body.length) slots.push({text: body.slice(pos)});
  } else {
    for (const u of files) slots.push({u});
    slots.push({text: body});
  }

  let album: HTMLElement | null = null;

  const imageMedia: {
    el: HTMLElement;
    u: NonNullable<CycMessage['upload']>;
    img: HTMLImageElement;
  }[] = [];
  const closeAlbum = () => {
    if (!album) return;
    const n = album.childElementCount;
    const cols = n === 1 ? 1 : n === 2 || n === 4 ? 2 : 3;

    album.dataset.n = String(n);
    album.dataset.cols = String(cols);
    album.classList.add(
      cols === 1
        ? 'grid-cols-[1fr]'
        : cols === 2
          ? 'grid-cols-[repeat(2,1fr)]'
          : 'grid-cols-[repeat(3,1fr)]'
    );
    // A multi-image album keeps its fixed media column. A single image instead
    // fills the bubble content width so it lines up with a sibling voice clip
    // (which pins the frame wide via `--cyc-msg-frame-max`) rather than floating
    // narrow with a background gap; it stretches between a sensible floor and a
    // 30rem cap (the reading column max).
    if (cols === 1) album.classList.add('w-full', 'min-w-[min(20rem,62vw)]', 'max-w-[30rem]');
    else album.classList.add('w-[min(20rem,62vw)]');
    album = null;
  };

  for (const slot of slots) {
    const u = slot.u;
    if (!u) {
      closeAlbum();
      const words = (slot.text ?? '').trim();
      if (!words) continue;
      const para = h('div', 'cyc-multipart-text whitespace-pre-wrap [word-break:break-word]');
      setFormatted(para, words);
      message.append(para);
      continue;
    }

    const words = (slot.text ?? '').trim();

    const pending = isAudioUpload(u) && clipAwaitingWords(m, u);
    const unread = isAudioUpload(u) && !!m.wordsFailed && !u.textLen;
    const card =
      words || pending || unread ? h('div', 'cyc-multipart-voice flex flex-col gap-0.5') : null;

    if (card || isAudioUpload(u) || !u.image) closeAlbum();
    else if (!album) {
      // grid/gap migrate `.cyc-multipart-album { display:grid; gap:2px }`;
      // closeAlbum() appends the per-column track and the width (a single image
      // fills the bubble, a multi-image grid keeps the fixed min(20rem,62vw)).
      album = h('div', 'cyc-multipart-album grid gap-[2px]');
      message.append(album);
    }
    const host = card ?? album ?? message;
    if (isAudioUpload(u)) {
      const url = srcOf(u);
      const el = audioElement({
        durationS: u.durationS,

        msgId: u.uploadId,
        out,
        eager: true,
        onPlay: () => {
          if (!url) return;
          if (playing() === url && clipPlayer && !clipPlayer.paused) {
            pauseClipPlayback();
            return;
          }

          const resuming =
            clipPlayer &&
            clipPlayingSrc === url &&
            clipPlayer.paused &&
            clipPlayer.currentTime > 0 &&
            !clipPlayer.ended;

          if (resuming) pauseClipPlayback();
          else stopClipPlayback();
          clipPlayer ??= new WebAudioClip();

          clipPlayingSrc = url;
          void (async () => {
            if (!resuming) {
              let src: string;
              try {
                src = await resolveAudioUrl(u.uploadId, url);
              } catch {
                if (clipPlayingSrc === url) stopClipPlayback();
                return;
              }
              if (clipPlayingSrc !== url) return;
              clipPlayer!.src = src;
            }
            follow(el, u);
            void clipPlayer!
              .play()
              .then(
                () =>
                  paint(
                    el,
                    true,
                    lengthOf(u) ? Math.min(1, clipPlayer!.currentTime / lengthOf(u)) : 0
                  ),
                stopClipPlayback
              );
          })();
        },
        onSeek: (ratio) => {
          const total = lengthOf(u);
          if (playing() !== srcOf(u) || !total || !clipPlayer) return;
          clipPlayer.currentTime = total * ratio;
          paint(el, true, ratio);
          clock(el, total * ratio, total);
        }
      });
      el.classList.add('cyc-multipart-clip');

      if (url) el.dataset.audioSrc = url;

      registerClipRow({
        el,
        u,
        at: performance.now(),
        rest: () => {
          paint(el, false);
          clock(el, -1, lengthOf(u));
        }
      });

      if (url && clipPlayingSrc === url && clipPlayer && !clipPlayer.paused) {
        follow(el, u);
        const total = lengthOf(u);
        paint(el, true, total ? Math.min(1, clipPlayer.currentTime / total) : 0);
        clock(el, clipPlayer.currentTime, total);
      }
      host.append(el);
    } else if (u.image) {
      const media = h(
        'div',
        'cyc-annex cyc-media-box rounded-[6px]! block! overflow-hidden h-auto relative [font-size:0] max-h-[min(400px,100%)]! bg-[#000]! cursor-pointer'
      );
      // Photo geometry migrates the `.cyc-still` half: static! wins over the
      // unlayered chrome.css `.cyc-still { position:absolute }`, block/w-full/
      // h-full/cursor-pointer/image-orientation restate the rest; object-fit is
      // painted per column count below (contain vs cover).
      const img = markMissingOnError(
        h(
          'img',
          'cyc-still static! block w-full h-full cursor-pointer [image-orientation:from-image]'
        ) as HTMLImageElement
      );

      setTunnelSrc(img, srcOf(u));
      img.alt = uploadTitle(u);
      img.loading = 'lazy';
      media.append(img);
      media.addEventListener('click', () => onOpenUpload?.(u));
      host.append(media);

      imageMedia.push({el: media, u, img});
    } else {
      const row = h('div', 'cyc-multipart-file');
      const dot = u.name.lastIndexOf('.');
      const ext = (dot > 0 ? u.name.slice(dot + 1) : 'file').toLowerCase().slice(0, 4) || 'file';
      const doc = h(
        'div',
        `cyc-doc cyc-ext-${ext} ${DOC_CHAT_UTILS}` + (u.fromPage ? ' cyc-doc-submit' : '')
      );
      const ico = h('div', 'cyc-doc-ico ' + DOC_ICO_UTILS);
      paintDocIcon(ico, ext, !!u.fromPage);
      const icoText = h('span', 'cyc-doc-ico-text');
      icoText.textContent = ext;
      ico.append(icoText);
      const nameDiv = h('div', 'cyc-doc-name ' + DOC_NAME_UTILS);
      nameDiv.textContent = uploadTitle(u);
      const sizeDiv = h('div', 'cyc-doc-size ' + DOC_SIZE_UTILS);
      sizeDiv.textContent = u.fromPage
        ? `${u.fromPage.label} · ${formatBytes(u.size)}`
        : formatBytes(u.size);
      doc.append(ico, nameDiv, sizeDiv);
      doc.addEventListener('click', () => onOpenUpload?.(u));
      row.append(doc);
      host.append(row);
    }
    if (card) {
      // Was the grouped `.cyc-transcript, .cyc-message.cyc-multipart .cyc-multipart-cap`
      // rule; its `.cyc-multipart-cap` term drains here (margin-top 0.375rem = mt-1.5,
      // font-size 0.9375rem, line-height 1.3, opacity 0.9, white-space pre-wrap). The
      // `.cyc-transcript` term stays authored in chat.css (owned by audio/composer).
      const para = h(
        'div',
        'cyc-multipart-text cyc-multipart-cap mt-1.5 whitespace-pre-wrap text-[0.9375rem] leading-[1.3] opacity-90 [word-break:break-word]'
      );
      setFormatted(para, words);

      if (pending) para.append(h('span', 'cyc-transcript-dots'));
      host.append(para);

      if (unread) {
        const note = h(
          'div',
          'cyc-voice-failed flex items-center gap-1.5 mt-1.5 text-[0.8125rem] text-[color:var(--cyc-danger)]'
        );
        note.append(
          makeIcon('deliveryFailed'),
          'could not be transcribed; the recording was saved and sent'
        );
        host.append(note);
      }
      message.append(host);
    }
  }
  closeAlbum();

  for (const {el, u, img} of imageMedia) {
    const grid = el.closest('.cyc-multipart-album');
    if (grid && grid.getAttribute('data-cols') !== '1') {
      el.classList.add('w-auto!', 'aspect-square');
      img.classList.add('object-cover');
      continue;
    }
    // A single image fills the (stretched) album width instead of a fixed sliver,
    // and drops the tight 400px height cap so a tall portrait grows taller rather
    // than letterboxing narrow. Its height follows aspect (reserveMediaBox sets
    // aspect-ratio) under a 70vh ceiling, so the box matches the image and leaves
    // no side/bottom gap.
    el.classList.add('w-full!');
    img.classList.add('object-contain!');
    reserveMediaBox(el, u.width, u.height);
    el.classList.remove('max-h-[min(400px,100%)]!', 'max-h-[22rem]');
    el.classList.add('max-h-[70vh]');
  }

  // The body is a flex column (composer.css), so a stamp appended to it is its
  // own inline-end item. When the bubble ends in text (a plain paragraph, or the
  // transcript inside a trailing voice card) the stamp rides that paragraph's
  // last line instead, as in a text bubble.
  const tail = message.lastElementChild;
  const tailPara = tail?.classList.contains('cyc-multipart-voice') ? tail.lastElementChild : tail;
  if (tailPara?.classList.contains('cyc-multipart-text')) tailPara.append(flowStamp(m));
  else message.append(flowStamp(m));
  content.append(message);

  setMessageReply(messageNode, content, m);
  wrapper.append(content);
  messageNode.append(wrapper);
  return messageNode;
}

export function uploadMessage(
  m: CycMessage,
  first: boolean,
  last: boolean,
  src: string,
  onOpenUpload?: (u: NonNullable<CycMessage['upload']>) => void
): HTMLDivElement {
  const u = m.upload!;
  const out = m.role === 'user';
  const caption = m.text.trim();

  if (u.image)
    return photoMessage(m, first, last, src, u.name, () => onOpenUpload?.(u), {
      width: u.width,
      height: u.height
    });

  const messageNode = createMessageNode(out, first, last, ' cyc-doc-message cyc-one-document');
  const wrapper = docFrameEl();
  const content = h('div', 'cyc-message-content ' + MESSAGE_CONTENT_UTILS);
  const message = h('div', 'cyc-message-text ' + MESSAGE_TEXT_UTILS + ' text-[length:14px]');
  const container = h('div', 'cyc-doc-box');
  const docWrapper = h('div', 'cyc-doc-wrap');

  const dot = u.name.lastIndexOf('.');
  const ext = (dot > 0 ? u.name.slice(dot + 1) : 'file').toLowerCase().slice(0, 4) || 'file';
  const doc = h(
    'div',
    `cyc-doc cyc-ext-${ext} my-2 ${DOC_CHAT_UTILS}` + (u.fromPage ? ' cyc-doc-submit' : '')
  );
  const ico = h('div', 'cyc-doc-ico ' + DOC_ICO_UTILS);
  paintDocIcon(ico, ext, !!u.fromPage);
  const icoText = h('span', 'cyc-doc-ico-text');
  icoText.textContent = ext;
  ico.append(icoText);
  const nameDiv = h('div', 'cyc-doc-name ' + DOC_NAME_UTILS);
  nameDiv.textContent = uploadTitle(u);
  const sizeDiv = h('div', 'cyc-doc-size ' + DOC_SIZE_UTILS);

  sizeDiv.textContent = u.fromPage
    ? `${u.fromPage.label} · ${formatBytes(u.size)}`
    : formatBytes(u.size);
  doc.append(ico, nameDiv);
  doc.addEventListener('click', () => onOpenUpload?.(u));
  docWrapper.append(doc);
  if (caption) {
    // The stamp rides the caption's last line (or its own line under a long one).
    const cap = h('div', 'cyc-doc-message mt-[-0.125rem]');
    const inner = h('div', '');
    setFormatted(inner, caption);
    inner.append(flowStamp(m));
    cap.append(inner);
    docWrapper.append(cap);
  }
  // A lone card carries the stamp at the inline end of its size row.
  doc.append(docFootRow(sizeDiv, caption ? null : footStamp(m)));
  container.append(docWrapper);
  message.append(container);
  content.append(message);
  wrapper.append(content);
  messageNode.append(wrapper);
  return messageNode;
}
