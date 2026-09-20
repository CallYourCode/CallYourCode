import {cyclog} from '@/shared/logging';
import {isAction} from '@/features/settings/preferences';
import {pipeline} from '../../../audio/pipeline';
import {onMarkdownShortcut} from '@/features/composer/markup';
import {touchCapable} from '@/shared/capabilities';
import type {Recorder} from '../voice/voiceRecorder';
import type {CycReplyTo} from '../../../types';
import {
  sendPlan,
  renderParts,
  sendLayout,
  type ComposerBlock,
  type FileAnchor,
  type SendSettled,
  type Staged
} from './composerModel';

const recDebugOn = () => new URLSearchParams(location.search).has('audiodebug');
function recdbg(...a: unknown[]) {
  if (!recDebugOn()) return;
  console.debug('[rec]', ...a);
}

export type ComposerRecordGestureDeps = {
  el: HTMLElement;

  sendButton: HTMLButtonElement;

  setSendMode(record: boolean): void;

  lockChip: HTMLElement;

  input: HTMLElement;

  recPanel: Recorder;

  blocks: ComposerBlock[];
  staged(): Staged[];
  renderBlocks(): void;

  clear(sent?: ComposerBlock[]): ComposerBlock[];
  getText(): string;
  isEmpty(): boolean;
  setEmpty(empty?: boolean): void;
  setPartial(text: string, committed?: number): void;
  setCaption(text: string, committed?: number): void;

  cap: {live: boolean; stream: boolean; last: {text: string; committed?: number}};

  liveWords(): boolean;
  isDisabled(): boolean;
  voiceEnabled(): boolean;
  // The chat the box is showing (its draft's owner); null when none is. A
  // kept send belongs to the chat it was pressed in, and only that chat's
  // box clears for it.
  boxOwner?: () => string | null;
  // Settles once the message is durable (true), when nothing went (false),
  // or with the send the box keeps until the engine takes it ({kept}).
  onSend(text: string, replyTo?: CycReplyTo): SendSettled | Promise<SendSettled>;
  // Settles as onSend does (a bare resolve is true); rejects when the
  // attachment could not go.
  onAttach?: (
    files: Staged[],
    compose: (pending?: (staged: Staged) => string | undefined) => {
      text: string;
      anchors: FileAnchor[];
    },
    replyTo?: CycReplyTo
  ) => void | SendSettled | Promise<void | SendSettled>;
  onVoiceStart?: () => void;
  onVoiceEnd?: (how: 'release' | 'interrupted') => void;
  onLiveSend?: () => void;
  onVoiceCancel?: () => void;
};

export function createComposerRecordGesture(deps: ComposerRecordGestureDeps) {
  const {
    el,
    sendButton,
    setSendMode,
    lockChip,
    input,
    recPanel,
    blocks,
    staged,
    renderBlocks,
    clear,
    getText,
    isEmpty,
    setEmpty,
    setPartial,
    setCaption,
    cap,
    liveWords,
    isDisabled,
    voiceEnabled,
    boxOwner = () => null,
    onSend,
    onAttach,
    onVoiceStart,
    onVoiceEnd,
    onLiveSend,
    onVoiceCancel
  } = deps;

  let holding = false;
  let locked = false;

  const recordingOwnsButton = () => holding || locked;

  const buzz = (ms: number | number[]) => {
    try {
      navigator.vibrate?.(ms);
    } catch {}
  };

  const stalledClips = (blocks_: ComposerBlock[]) => {
    for (const b of blocks_) {
      if (b.kind !== 'voice' || b.staged) continue;
      b.clip.lost = true;
      b.clip.waiting = false;
    }
    renderBlocks();
  };

  const markWaiting = (blocks_: ComposerBlock[], on: boolean) => {
    for (const b of blocks_) {
      if (b.kind !== 'voice') continue;
      b.clip.waiting = on && !b.staged;
    }
    renderBlocks();
  };

  let awaitingClip = false;
  // A press whose delivery is not yet known: the box keeps the message until
  // the engine settles it, and takes no second press for it. The send gate is
  // released on dispatch; only this same-message dedup waits for delivery.
  let awaitingCommit = false;
  // Sends that are out but not yet taken by the engine, by the chat they were
  // pressed in. Each is still owed from this tab's memory, so the same words
  // pressed again in that chat are that send, not a second one. This record
  // remains until delivery settles, however late. Another chat's box is never
  // touched for it, and the record outlives a switch away and back.
  const kept = new Map<string, {typed: string; snapshot: ComposerBlock[]}>();
  const ownerKey = () => boxOwner() ?? '';

  const sameBlocks = (a: ComposerBlock[], b: ComposerBlock[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);

  const holdKept = (
    owner: string,
    typed: string,
    snapshot: ComposerBlock[],
    settles: Promise<boolean>
  ) => {
    const k = {typed, snapshot};
    kept.set(owner, k);
    cyclog('send.kept', {
      blocks: snapshot.length,
      chars: typed.length,
      why: 'the send is out; its delivery signal prevents a duplicate until it settles'
    });
    const forget = () => {
      if (kept.get(owner) === k) kept.delete(owner);
    };
    // `settles` is the engine delivery signal, not the durable-write wait.
    // A delayed disk write must not make an already dispatched message send
    // again under a second cid.
    void settles.then(forget, forget);
  };

  // What the press settled to. A bare resolve (onAttach with nothing to say)
  // is a durable send.
  const settle = (
    r: void | SendSettled,
    owner: string,
    typed: string,
    snapshot: ComposerBlock[]
  ) => {
    if (r === false) return;
    if (r && typeof r === 'object') {
      holdKept(owner, typed, snapshot, r.delivered ?? r.kept);
      // The wire already has this send. Keep its draft until disk settles,
      // but free the visible composer and its send gate now.
      if (ownerKey() === owner) clear(snapshot);
      return;
    }
    // The box is another chat's by now: its draft is dropped from the vault
    // by the sender; what is showing is not this send's.
    if (ownerKey() !== owner) return;
    clear(snapshot);
  };

  const doSend = (afterWait = false) => {
    if (isDisabled()) return;
    if (liveWords()) {
      onLiveSend?.();
      return;
    }

    const waitingFor = blocks.filter((b) => b.kind === 'voice' && !b.staged && !b.clip.lost);

    if (!afterWait) {
      cyclog('send.pressed', {
        blocks: blocks.length,
        waitingForClip: waitingFor.length,
        chars: getText().length,
        why: 'the send button was pressed; the box empties from here'
      });
    }
    if (waitingFor.length && !awaitingClip && !afterWait) {
      awaitingClip = true;
      markWaiting(waitingFor, true);
      const until = Date.now() + 10_000;
      const again = () => {
        const stillWaiting = waitingFor.some(
          (b) => blocks.includes(b) && b.kind === 'voice' && !b.staged
        );
        if (stillWaiting && Date.now() < until) {
          setTimeout(again, 100);
          return;
        }
        awaitingClip = false;
        markWaiting(waitingFor, false);

        stalledClips(waitingFor);
        doSend(true);
      };
      setTimeout(again, 100);
      return;
    }
    if (awaitingClip || awaitingCommit) return;

    const typed = getText();
    const {parts, answering} = sendPlan(blocks, typed);
    const text = renderParts(parts);
    const files = staged();

    const snapshot = blocks.slice();
    const owner = ownerKey();
    const held = kept.get(owner);
    if (held && held.typed === typed && sameBlocks(held.snapshot, snapshot)) {
      cyclog('send.kept-press', {
        blocks: snapshot.length,
        chars: typed.length,
        why:
          'these words are the send the box keeps, still owed to the engine from this tab; ' +
          'pressing again is not a second message'
      });
      return;
    }
    if (files.length) {
      awaitingCommit = true;
      void Promise.resolve(
        onAttach?.(files, (pending) => sendLayout(snapshot, typed, pending), answering)
      )
        .then(
          (r) => settle(r, owner, typed, snapshot),
          () => {}
        )
        .finally(() => {
          awaitingCommit = false;
        });
      return;
    }
    if (!text) return;
    awaitingCommit = true;
    void Promise.resolve(onSend(text, answering))
      .then(
        (r) => settle(r, owner, typed, snapshot),
        () => {}
      )
      .finally(() => {
        awaitingCommit = false;
      });
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
      return;
    }
    if (!e.isComposing && isAction(e, 'newline')) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      onMarkdownShortcut(input, e);
    }
  });

  sendButton.addEventListener('click', () => {
    if (!voiceEnabled()) {
      if (!isEmpty()) doSend();
      return;
    }
    if (liveWords()) doSend();
  });

  let recTimer = 0;
  let recStart = 0;
  const startRecordUi = () => {
    recStart = Date.now();
    recPanel.renderRecorder({phase: 'recording', reset: true, elapsedMs: 0});
    recTimer = window.setInterval(() => {
      recPanel.renderRecorder({elapsedMs: Date.now() - recStart});
    }, 100);
  };
  const stopRecordUi = () => {
    clearInterval(recTimer);
    recPanel.renderRecorder({reset: true});
  };

  let slideFromX = 0;

  let liveX = 0;

  let pressAt = 0;
  let offPartial: (() => void) | null = null;
  let offRecState: (() => void) | null = null;

  const dropCaption = () => {
    if (offPartial) {
      offPartial();
      offPartial = null;
    }
    if (offRecState) {
      offRecState();
      offRecState = null;
    }
    cap.live = false;
    cap.stream = true;
    setCaption('');
  };

  const beginRecording = (lockedStart: boolean) => {
    if (!voiceEnabled()) return;
    holding = !lockedStart;
    locked = lockedStart;

    slideFromX = liveX;
    el.classList.remove('cyc-pressing');
    buzz(lockedStart ? [14, 40, 22] : 18);
    el.toggleAttribute('data-cyc-recording', true);
    el.classList.toggle('cyc-rec-locked', locked);

    setSendMode(true);
    startRecordUi();
    dropCaption();

    offPartial = pipeline.on('partial', (text, _sessionId, committed, captureId) => {
      if (captureId !== undefined && captureId !== pipeline.liveCaptureId) return;
      setPartial(text, committed);
    });

    offRecState = pipeline.on('recording', () => {
      const live = pipeline.liveCaptionOpen;
      if (live === cap.stream) return;
      cap.stream = live;
      setCaption(cap.last.text, cap.last.committed);
    });
    cap.live = true;
    cap.stream = true;
    setCaption('');
    onVoiceStart?.();
  };

  const lockNow = () => {
    recdbg('lockNow', {holding, locked});
    if (!holding || locked) return;
    holding = false;
    locked = true;
    el.classList.add('cyc-rec-locked');
    buzz([14, 40, 22]);

    setSendMode(true);
  };

  type RecordingEnd = 'release' | 'interrupted' | 'cancel';
  const endRecording = (end: RecordingEnd, why = '?') => {
    const cancelled = end === 'cancel';
    recdbg('end', {end, cancelled, why, holding, locked});
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (!holding && !locked) return;
    holding = false;
    locked = false;
    dropCaption();

    stopRecordUi();
    el.toggleAttribute('data-cyc-recording', false);
    el.classList.remove('cyc-rec-locked', 'cyc-pressing');
    buzz(cancelled ? [10, 30, 10] : 12);
    setEmpty();
    if (cancelled) onVoiceCancel?.();
    else onVoiceEnd?.(end === 'interrupted' ? 'interrupted' : 'release');
  };

  const HOLD_MS = 400;
  const TAP_MS = 650;
  let lockArmedAt = 0;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;

  let activePointerId: number | null = null;

  sendButton.addEventListener('pointerdown', (e) => {
    recdbg('pointerdown', {locked, holding, empty: isEmpty()});
    if (isDisabled()) return;
    if (!voiceEnabled()) return;

    if (liveWords()) return;
    if (locked) return;
    if (activePointerId !== null) return;
    e.preventDefault();
    activePointerId = e.pointerId;

    liveX = e.clientX;
    pressAt = Date.now();

    el.classList.add('cyc-pressing');
    buzz(12);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      beginRecording(false);
    }, HOLD_MS);
  });

  document.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activePointerId) return;

    liveX = e.clientX;
    if (!holding) return;
    if (slideFromX - e.clientX > 70) {
      endRecording('cancel', 'slide-left ' + (slideFromX - e.clientX));
      return;
    }
    const chip = lockChip.getBoundingClientRect();
    if (
      chip.width &&
      e.clientY <= chip.bottom &&
      e.clientX >= chip.x - 8 &&
      e.clientX <= chip.right + 8
    ) {
      lockNow();
    }
  });
  lockChip.addEventListener('click', lockNow);

  document.addEventListener('pointerup', (e) => {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
      el.classList.remove('cyc-pressing');
      recdbg('tap under threshold', {empty: isEmpty()});

      if (!isEmpty()) {
        doSend();
        return;
      }
      beginRecording(true);
      lockArmedAt = Date.now();
      return;
    }
    if (!holding) return;
    const overTrash = (e.target as HTMLElement | null)?.closest?.('.cyc-rec-cancel');
    if (overTrash) {
      endRecording('cancel', 'pointerup-trash');
      return;
    }

    const heldMs = Date.now() - pressAt;
    if (heldMs < TAP_MS) {
      recdbg('slow tap, not a recording', {heldMs, empty: isEmpty()});
      if (isEmpty()) {
        lockNow();

        lockArmedAt = Date.now();
        return;
      }

      endRecording('release', 'slow-tap ' + heldMs);
      doSend();
      return;
    }
    endRecording('release', 'pointerup');
  });

  document.addEventListener('pointercancel', (e) => {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
      el.classList.remove('cyc-pressing');
      return;
    }
    if (holding) endRecording('interrupted', 'pointercancel');
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || !touchCapable) return;
    activePointerId = null;
    el.classList.remove('cyc-pressing');
    endRecording('interrupted', 'page-hidden');
  });

  sendButton.addEventListener('click', () => {
    if (locked && Date.now() - lockArmedAt > 400) endRecording('release', 'locked-send');
  });

  return {
    recordingOwnsButton,
    endRecording,
    doSend
  };
}
