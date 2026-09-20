import type {CycMessage} from '@/types';
import {h, transcriptDotWave} from '@/components/domHelpers';
import {makeIcon} from '@/components/iconGlyphs';
import {mmss} from '@/features/chat/content';
import {setFormatted} from '@/features/chat/content';
import {awaitingWords, hasRecording} from '@/features/chat/content';
import {
  flowStamp,
  createMessageNode,
  setMessageReply,
  MESSAGE_CONTENT_UTILS,
  MESSAGE_TEXT_UTILS,
  SEND_FAILED_CLASS,
  sendProgressNode
} from './messageContent';
import {messageFrameEl} from './messageFrame';
import {signalStrip, mountWaveform} from '@/features/composer/voice/waveform';

export function audioMessage(
  m: CycMessage,
  first: boolean,
  last: boolean,
  onPlay: (m: CycMessage, el: HTMLElement) => void,
  onSeek?: (m: CycMessage, ratio: number) => void,
  eager = false
): HTMLDivElement {
  const out = m.role === 'user';
  const messageNode = createMessageNode(out, first, last);
  const wrapper = messageFrameEl();
  const content = h('div', 'cyc-message-content ' + MESSAGE_CONTENT_UTILS);
  const message = h('div', 'cyc-message-text ' + MESSAGE_TEXT_UTILS + ' text-[length:14px]');

  const docWrapper = h('div', 'cyc-doc-wrap');

  if (hasRecording(m)) docWrapper.append(audioPlayer(m, out, onPlay, onSeek, eager));

  const transcript = h('div', 'cyc-transcript' + (out ? '' : ' cyc-karaoke'));

  if (awaitingWords(m) || m.transcriptPending) {
    const cut = Math.max(0, Math.min(m.draftCommitted ?? m.text.length, m.text.length));
    const done = h('span', 'cyc-vb-done');
    done.textContent = m.text.slice(0, cut);
    const tail = h('span', 'cyc-vb-tail opacity-50');
    tail.textContent = m.text.slice(cut);

    transcript.append(
      done,
      tail,
      (() => {
        const dots = h('span', 'cyc-transcript-dots relative');
        const bg = h('span', 'opacity-0 [.cyc-karaoke_&]:opacity-40!');
        bg.textContent = '...';
        dots.append(bg, transcriptDotWave());
        return dots;
      })()
    );
  } else {
    setFormatted(transcript, m.text);
  }
  docWrapper.append(transcript);

  // A failed send whose recording is still on this device (clipKey kept, not
  // clipLost) can be resent from the original bytes: say so, rather than the
  // "recording was not saved" copy that only fits a note whose clip is gone.
  // A refusal with a reason (the engine's size cap) names the reason instead.
  const keptForRetry = m.status === 'failed' && !!m.clipKey && !m.clipLost;
  const failedCopy = m.failReason
    ? `not sent: ${m.failReason}`
    : 'not sent, and the recording was not saved';
  if (m.status === 'failed' || !hasRecording(m)) {
    if (m.status === 'failed') {
      messageNode.classList.add('cyc-msg-failed');
    }
    // Kept for retry: the note is the tap, delegated the way the text
    // bubble's is (messageMenu.ts retries the row through retrySend).
    const note = keptForRetry
      ? h(
          'button',
          `cyc-voice-failed ${SEND_FAILED_CLASS} flex items-center gap-1.5 mt-1.5 border-0 bg-none p-0 text-start text-[0.8125rem] text-[color:var(--cyc-danger)] cursor-pointer`,
          {type: 'button', title: 'Try again'}
        )
      : h(
          'div',
          'cyc-voice-failed flex items-center gap-1.5 mt-1.5 text-[0.8125rem] text-[color:var(--cyc-danger)]'
        );
    note.append(
      makeIcon('deliveryFailed'),
      keptForRetry
        ? 'Not sent: tap to try again'
        : m.status === 'failed'
          ? failedCopy
          : 'sent as text, the recording was not saved'
    );
    docWrapper.append(note);
  } else if (m.status === 'sending' && typeof m.sendPct === 'number') {
    // The resumable transfer's progress, painted on the pending bubble as the
    // chunks land (Lane A). Cleared to a plain pending tick once it finishes.
    // The line doubles as the cancel (an X beside the percentage); the tap is
    // delegated in messageMenu.ts and routes the recording back to the box.
    docWrapper.append(sendProgressNode(m.sendPct));
  }

  message.append(docWrapper, flowStamp(m));
  content.append(message);

  setMessageReply(messageNode, content, m);
  wrapper.append(content);
  messageNode.append(wrapper);
  return messageNode;
}

function audioPlayer(
  m: CycMessage,
  out: boolean,
  onPlay: (m: CycMessage, el: HTMLElement) => void,
  onSeek: ((m: CycMessage, ratio: number) => void) | undefined,

  eager: boolean
): HTMLElement {
  const growing = (m as CycMessage & {growing?: boolean}).growing === true;
  return audioElement({
    durationS: m.durationS,
    msgId: (m as CycMessage & {msgId?: string}).msgId,
    out,
    eager,
    growing,
    onPlay: (el) => onPlay(m, el),
    onSeek: onSeek && ((ratio) => onSeek(m, ratio))
  });
}

export function audioElement(opts: {
  durationS?: number;
  msgId?: string;
  out?: boolean;
  eager?: boolean;

  growing?: boolean;
  onPlay: (el: HTMLElement) => void;
  onSeek?: (ratio: number) => void;
}): HTMLElement {
  const audioEl = document.createElement('cyc-voice-card');
  audioEl.className =
    'cyc-clip cyc-voice' +
    (opts.out ? ' cyc-msg-sent' : '') +
    (opts.growing ? ' is-growing' : '') +
    // Play button sits in a logical start gutter so RTL flips it.
    ' relative p-0 ps-14 h-[3.25rem] flex flex-col justify-center cursor-pointer overflow-visible whitespace-normal [.cyc-one-document_&]:my-2';

  if (opts.msgId) audioEl.setAttribute('data-msg-id', opts.msgId);

  const toggle = h(
    'div',
    'cyc-clip-toggle cyc-clip-ico absolute start-0 w-10! h-10! text-white! flex items-center justify-center rounded-[6px]! bg-[var(--cyc-fill-color)]! cursor-pointer' +
      " [&.cyc-pending]:after:content-[''] [&.cyc-pending]:after:absolute [&.cyc-pending]:after:inset-[15%] [&.cyc-pending]:after:rounded-full [&.cyc-pending]:after:border-[2.5px] [&.cyc-pending]:after:border-solid [&.cyc-pending]:after:border-[rgba(255,255,255,0.35)] [&.cyc-pending]:after:border-t-white [&.cyc-pending]:after:[animation:cyc-spin_0.8s_linear_infinite]" +
      ' [&.cyc-clip-wait]:[animation:cyc-clip-wait_900ms_ease-in-out_infinite]' +
      ' [.is-growing_&]:cursor-default [.is-growing_&]:[animation:cyc-grow-pulse_1.4s_ease-in-out_infinite]' +
      ' text-[0px]'
  );
  const playIcon = h(
    'div',
    'cyc-clip-play absolute inset-0 max-w-full max-h-full overflow-hidden rounded-[inherit] [.cyc-pending_&]:opacity-0'
  );
  // White glyph fill; `!` beats the bubble-glyph chat.css rule on outgoing night rows.
  playIcon.append(
    h('div', 'cyc-clip-play-part is-one bg-white!'),
    h('div', 'cyc-clip-play-part is-two bg-white!')
  );
  toggle.append(playIcon);

  toggle.addEventListener('click', () => opts.onPlay(toggle));

  const wfContainer = h(
    'div',
    'cyc-signal-meter relative h-5 mt-1 flex items-center overflow-hidden ms-[-0.25rem]! [.is-growing_&]:opacity-[0.55] [.is-growing_&]:cursor-default'
  );
  wfContainer.append(
    signalStrip('cyc-signal-track h-full w-full'),
    signalStrip(
      'cyc-signal-progress absolute inset-0 pointer-events-none [clip-path:inset(0_100%_0_0)]'
    )
  );

  const onSeek = opts.growing ? undefined : opts.onSeek;
  if (onSeek) {
    wfContainer.classList.add('cyc-seekable', 'cursor-pointer');
    wfContainer.addEventListener('click', (e) => {
      const r = wfContainer.getBoundingClientRect();
      if (r.width > 0) onSeek(Math.min(1, Math.max(0, (e.clientX - r.x) / r.width)));
    });
  }

  mountWaveform(wfContainer, !!opts.eager);

  const timeEl = h(
    'div',
    // `[.cyc-msg-received_&]:text-[color:var(--cyc-text-muted)]!` was the un-layered
    // `.cyc-message.cyc-msg-received .cyc-clip-time{color:var(--cyc-text-muted)!important}`
    // incoming variant, preserving its `!important` cascade; the base above already
    // paints the same token, so this is faithful-but-inert.
    'cyc-clip-time flex items-center whitespace-nowrap text-ellipsis overflow-hidden text-[0.875rem] text-[color:var(--cyc-text-muted)] leading-none -ml-px mt-[7px] [.cyc-msg-received_&]:text-[color:var(--cyc-text-muted)]!'
  );
  if (opts.durationS !== undefined) {
    timeEl.dataset.known = '1';
    timeEl.textContent = mmss(opts.durationS);
  } else {
    timeEl.textContent = '·:··';
  }

  audioEl.append(toggle, wfContainer, timeEl);
  return audioEl;
}
