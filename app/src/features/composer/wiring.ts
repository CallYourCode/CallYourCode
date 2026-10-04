import {touchCapable} from '@/shared/capabilities';
import type {CycMessage, CycReplyTo} from '../../types';
import * as engine from '../../engine/store';
import {sessionState, dataState, unsentWork, stagedBlocks} from '../../sessionState';
import {speaker} from '../../audio/speaker';
import {pipeline} from '../../audio/pipeline';
import {ensureMic, mic, hiddenSilences} from '../../speechGate';
import {cyclog} from '@/shared/logging';
import {toast} from '../../components/widgets';
import {
  createComposer,
  type FileAnchor,
  type SendSettled,
  type Staged,
  type VoiceClip
} from './components/messageComposer';
import {createAskPanel} from '../../components/askPanel';
import {createCaptureState} from './voice/capture';
import {settledPartialOf} from './voice/captureState';
import {createComposerVaultBridge} from './persistence/vaultBridge';
import {settledReply} from '../../replyModel';
import {active, isDead} from '../../sessionSelectors';

const VOICE_TRANSCRIPTS = [
  'we did experiments to detect when we are speaking',
  'also make sure it gives up after ten attempts and surfaces an error',
  'read me the summary when it finishes'
];
let voiceTranscriptIndex = 0;

export interface ComposerWiringDeps {
  onTeardown(d: () => void): void;

  clearUnreadAnchor(): void;
  scrollToBottom(): void;
  render(): void;

  jumpToReply(r: CycReplyTo): void;
}

export function createComposerWiring(deps: ComposerWiringDeps) {
  let voiceHoldStart = 0;
  let pttHolding = false;

  // Keep a granted microphone stream alive for this long after a push-to-talk
  // release before disposing it, so a second recording started inside the
  // window reuses the live stream (pipeline.init's `if (this.stream)` guard)
  // and getUserMedia is not called -- and, on iOS/WebKit, not re-prompted --
  // once per recording. iOS still re-prompts across cold starts and some
  // lifecycle transitions; this only removes the within-session per-recording
  // prompt.
  const MIC_GRACE_MS = 90_000;
  let micGraceTimer = 0;
  const cancelMicGrace = () => {
    if (micGraceTimer) {
      clearTimeout(micGraceTimer);
      micGraceTimer = 0;
    }
  };
  // Teardown is a hard release: drop any grace-held stream at once so keep-alive
  // never leaves the mic (and its iOS in-use indicator) alive with no owner.
  deps.onTeardown(() => {
    cancelMicGrace();
    if (mic.ready && !pttHolding && !pipeline.handsFreeSessionId) {
      pipeline.dispose();
      mic.ready = null;
    }
  });

  // `grace` keeps the stream open for MIC_GRACE_MS across back-to-back PTT
  // recordings. The hard-release triggers (backgrounding on a touch device via
  // hiddenSilences, hands-free end, teardown) call this without it, so they
  // dispose at once and never hold the mic (or its iOS in-use indicator) in the
  // background.
  function releaseMicIfIdle(grace = false) {
    const p = mic.ready;
    if (!p) return;
    const attempt = (retries: number) => {
      if (mic.ready !== p) return;
      if (pttHolding) return;
      if (pipeline.handsFreeSessionId) return;
      if (sessionState.activeId && sessionState.chatConversationMode.has(sessionState.activeId))
        return;
      if (pipeline.captureBusy) {
        if (retries > 0) window.setTimeout(() => attempt(retries - 1), 400);
        return;
      }
      // A backgrounded touch device is a hard release even on the grace path:
      // the mic must not stay lit in the background.
      if (grace && !hiddenSilences()) {
        cancelMicGrace();
        micGraceTimer = window.setTimeout(() => {
          micGraceTimer = 0;
          releaseMicIfIdle(false);
        }, MIC_GRACE_MS);
        return;
      }
      cancelMicGrace();
      pipeline.dispose();
      mic.ready = null;
    };
    void p.catch(() => {}).then(() => window.setTimeout(() => attempt(4), 0));
  }

  const cap = createCaptureState();

  unsentWork.inFlight = () =>
    cap.voiceDraft !== null ||
    cap.draftsByCapture.size > 0 ||
    cap.uploading > 0 ||
    pttHolding ||
    stagedBlocks.held();

  if (new URLSearchParams(location.search).get('testhooks')) {
    (window as never as {__cycVoiceState: () => unknown}).__cycVoiceState = () => ({
      liveCapture: pipeline.liveCaptureId,
      capturesInFlight: pipeline.capturesInFlight,
      openDrafts: [...cap.draftsByCapture.keys()],
      inFlight: unsentWork.inFlight!()
    });

    (window as never as {__cycTabSelection: () => Record<string, string>}).__cycTabSelection = () =>
      Object.fromEntries(sessionState.tabSelection);

    (
      window as never as {
        __cycSetContextPct: (pct: number | undefined) => void;
      }
    ).__cycSetContextPct = (pct) => {
      const s = active();
      if (!s) return;
      s.contextPct = pct;
      deps.render();
    };
  }
  // The kept-send notice, per chat: how many of the chat's sends are still
  // kept (neither on disk nor taken), and the toast last raised for it. The
  // notice is the chat's state, not the screen's: it is raised when the chat
  // is showing, leaving the chat takes it down, coming back raises it afresh,
  // and the engine taking the last kept send takes it down for good.
  const KEPT_NOTICE = 'Could not save the message; it is kept in the box';
  const keptNotices = new Map<string, {owed: number; notice: {dismiss(): void} | null}>();
  const raiseKept = (sessionId: string) => {
    const k = keptNotices.get(sessionId);
    if (!k) return;
    k.notice?.dismiss();
    k.notice = toast(KEPT_NOTICE);
  };
  const lowerKept = (sessionId: string) => {
    const k = keptNotices.get(sessionId);
    if (!k?.notice) return;
    k.notice.dismiss();
    k.notice = null;
  };
  const tellKept = (sessionId: string) => {
    const k = keptNotices.get(sessionId) ?? {owed: 0, notice: null};
    k.owed++;
    keptNotices.set(sessionId, k);
    if (vaultBridge.draftOwner() === sessionId) raiseKept(sessionId);
  };
  const keptSettled = (sessionId: string) => {
    const k = keptNotices.get(sessionId);
    if (!k) return;
    k.owed--;
    if (k.owed > 0) return;
    lowerKept(sessionId);
    keptNotices.delete(sessionId);
  };
  // The box changes chats: the notice follows the chat, not the box.
  const showDraft = (sessionId: string | null) => {
    for (const id of keptNotices.keys()) if (id !== sessionId) lowerKept(id);
    vaultBridge.loadDraft(sessionId);
    if (sessionId) raiseKept(sessionId);
  };

  // A send whose rows did not reach disk, followed from here until the engine
  // takes it. Taken within the ack deadline: the box clears as usual. Not by
  // then (the engine is away, silent, or refused it): the user is told the
  // box keeps it, once per send, and the wait goes on unbounded, through the
  // retry tap if it comes to that; the engine taking it clears the box and
  // the notice then. False only for a send gone untaken (discarded).
  const followUnsaved = async (
    sessionId: string,
    localId: string,
    settling: Promise<boolean>
  ): Promise<boolean> => {
    if (await engine.sendTaken(sessionId, localId)) {
      cyclog('send.taken-unsaved', {
        session: sessionId,
        localId,
        why: 'the engine took the send its row never reached disk for; the box clears as usual'
      });
      return true;
    }
    tellKept(sessionId);
    // The box is the retry surface for a kept send, so the optimistic thread
    // bubble is withdrawn: the same message must not show twice (a stuck
    // "sending" bubble in the thread AND staged in the box). sendSettles reads
    // the send's cid before the row goes, so its wait outlives the withdrawal;
    // the in-memory intent still drains and the engine's echo paints the
    // delivered row once it takes it.
    engine.withdrawSend(sessionId, localId);
    const taken = await settling;
    keptSettled(sessionId);
    if (taken) {
      cyclog('send.taken-late', {
        session: sessionId,
        localId,
        why: 'the engine took the kept send after all; the notice comes down with it'
      });
    }
    return taken;
  };

  // The send's rows (its intent, its transfer rows) are written after the
  // wire send. A failed write leaves the message in this tab's memory only;
  // it remains protected by the draft until the engine takes it.
  const committed = async (
    sessionId: string,
    localId: string,
    settling: Promise<boolean>
  ): Promise<boolean> => {
    if (await engine.sendCommitted(sessionId, localId)) return true;
    cyclog('send.uncommitted', {
      session: sessionId,
      localId,
      why:
        'the rows of this send did not reach disk; it is in memory only and goes ' +
        'while this tab lives, a reload loses it; the draft stays until the engine takes it'
    });
    return followUnsaved(sessionId, localId, settling);
  };

  // The draft (the box's copy in localStorage, and the other tabs' copies)
  // goes with the send: now when its rows are on disk, or once the engine
  // takes a send the box kept.
  const dropOnSent = (
    settled: SendSettled,
    owner: string | null,
    sent: {text: string; version: number} | null
  ): SendSettled => {
    if (!owner || !sent || settled === false) return settled;
    if (settled === true) {
      dropDraft(owner, sent);
      return true;
    }
    const kept = settled.kept.then((ok) => {
      if (ok) dropDraft(owner, sent);
      return ok;
    });
    // A committed row protects reload survival, but it is not a delivery
    // signal and therefore must not release the composer's duplicate guard.
    const delivered = settled.delivered?.then((taken) => {
      if (taken) dropDraft(owner, sent);
      return taken;
    });
    return {...(delivered ? {delivered} : {}), kept};
  };

  // Sends the text. Once dispatched, the box clears and its send gate
  // releases at once; its same-message guard waits only for engine delivery.
  // `alongside` names what the send supersedes on disk; it goes in the
  // intent row's own write.
  const sendCurrent = async (
    text: string,
    kind: CycMessage['kind'] = 'text',
    durationS?: number,
    replyTo?: CycReplyTo,
    alongside?: engine.Alongside
  ): Promise<SendSettled> => {
    const s = active();
    if (!s) return false;
    deps.clearUnreadAnchor();
    if (dataState.mode !== 'live') return false;
    if (isDead(s)) {
      toast('Session is offline');
      return false;
    }
    speaker.stopAll();
    unsentWork.hold(5000);
    const id = engine.sendText(s.id, text, {kind, durationS, replyTo, alongside});
    deps.scrollToBottom();
    if (!id) return false;
    // Capture the cid's delivery wait before any durable operation can remove
    // its local row. The committed wait is only for reload survival.
    const settling = engine.sendSettles(s.id, id);
    return {kept: committed(s.id, id, settling), delivered: settling};
  };

  const vaultBridge = createComposerVaultBridge({box: () => composer});
  const {
    saveDraft,
    dropDraft,
    sentAlongside,
    persistComposition,
    putBlocksBack,
    restoreVoiceBlock,
    clipCid,
    vaultKeyOf
  } = vaultBridge;

  const settleHeldWords = async (ms = 10_000) => {
    const until = Date.now() + ms;
    while (cap.heldClips.size && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (cap.heldClips.size) {
      cyclog('send.words-unsettled', {
        captures: [...cap.heldClips.keys()],
        waitedMs: ms,
        why: 'the composition is going with the words the cards had; the clips go with it'
      });
    }
  };

  const sendAttachments = (
    staged: Staged[],
    compose: (pending?: (st: Staged) => string | undefined) => {
      text: string;
      anchors: FileAnchor[];
    },
    replyTo?: CycReplyTo,
    alongside?: engine.Alongside
  ): Promise<SendSettled> => {
    const s = active();
    if (!s || !staged.length) return Promise.resolve(false);
    if (dataState.mode !== 'live') {
      toast('Attachments need a live engine');
      return Promise.reject(new Error('no live engine'));
    }
    deps.clearUnreadAnchor();

    // A lone voice recording is a voice note, not a generic file: send it over the
    // reliable clip-upload path so it lands as a message row that goes pending ->
    // accepted, or failed-with-retry, keeping its recorded bytes for a resend --
    // rather than a silent /upload that, on a weak link, could stall away with the
    // recording surfaced only back in the composer box.
    let loneCap: number | undefined;
    for (const [capId, handle] of cap.heldClips) {
      if (handle.file() === staged[0].file) loneCap = capId;
    }
    if (staged.length === 1 && loneCap !== undefined) {
      const st = staged[0];
      deps.scrollToBottom();
      // Bug 1 (send frozen on transcription): the lone note used to `await
      // settleHeldWords()` here -- up to 10s on the on-device decoder -- before
      // it read the body, made the bubble or cleared the composer, so a plain
      // record-then-Enter froze. An engine that advertises `words` transcribes
      // an uploaded clip server-side (engine/.../voice/transcribe.ts, task
      // 292): a `kind:'voice'` note shipped with an EMPTY body and just its
      // clip is read by the engine off its own disk and the transcript filled
      // in, while the bubble renders "transcribing" (content.ts awaitingWords)
      // until the words land. So a plain note ships AT ONCE with no body and no
      // wait; the composer clears synchronously.
      //
      // The engine only fills a voice note whose body is empty (a non-empty
      // body is the device's own words and is left alone), so when the user
      // typed a caption or is answering with a reply excerpt -- text that MUST
      // ride the wire -- the engine will NOT server-fill this note. In that
      // case, and on an engine without server words at all, the on-device
      // decoder is the only transcript source, so we bound-wait
      // (`settleHeldWords`, up to 10s) for it to settle before reading the
      // body, restoring the full device transcript alongside the caption
      // rather than shipping whatever partial the card happened to hold.
      // `words` markers do not apply here: they fill uploads listed on a text
      // message, not a voice note's own clip.
      const canWords = engine.engineCan(s.id, 'words');
      const hasReplyExcerpt = !!replyTo?.text?.trim();
      // The caption/quote typed alongside the recording, with the recording's
      // own (still-settling) words suppressed.
      const alongsideText = compose((sg) => (sg === st ? '' : undefined)).text.trim();
      const needsBody = !!alongsideText || hasReplyExcerpt;
      const shipVoice = (
        body: string,
        extra?: {partial?: {text: string; upToS: number}; streaming?: boolean}
      ): Promise<SendSettled> => {
        const capId = loneCap!;
        cap.heldClips.delete(capId);
        const heard = cap.heardOn(capId);
        const id = engine.sendVoiceClip(s.id, st.file, {
          durationS: st.durationS,
          text: body,
          ...(extra?.partial ? {partial: extra.partial} : {}),
          // An empty-body ship paints the device's own transcript-so-far on
          // the sent bubble, and (draftCommitted set, even at zero chars)
          // keeps the row OPEN so the capture's later partials grow it live.
          ...(extra?.streaming ? {display: {text: heard.text, committed: heard.committed}} : {}),
          ...(replyTo ? {replyTo} : {}),
          ...(alongside ? {alongside} : {})
        });
        if (!id) return Promise.reject(new Error('no such session'));
        // The capture's decoder is still running: its later events belong to
        // this SENT row now. Partials keep painting the bubble, the settled
        // utterance updates it once, and neither may reach the hands-free
        // fallback in settleUtterance, which would upload the clip again and
        // send a twin message.
        cap.sentByCapture.set(capId, {sessionId: s.id, localId: id});
        if (cap.sentByCapture.size > 8) {
          for (const k of [...cap.sentByCapture.keys()].slice(0, cap.sentByCapture.size - 8)) {
            cap.sentByCapture.delete(k);
          }
        }
        // Capture delivery before any durable operation can remove its row.
        const settling = engine.sendSettles(s.id, id);
        return Promise.resolve({
          kept: committed(s.id, id, settling),
          delivered: settling
        });
      };
      if (canWords && !needsBody) {
        // Instant, no wait (the owner's common record-then-Enter case), and
        // the words this device already settled go WITH the send: the point
        // of streaming transcription is that the engine never re-reads audio
        // the device already turned into text.
        const p = settledPartialOf(cap.partialByCapture.get(loneCap), st.durationS);
        if (p?.whole) {
          // The streaming decoder finalized the whole clip: the settled text
          // IS the transcript. It ships as the body; the engine decodes
          // nothing and the bubble is final at once.
          return shipVoice(p.text);
        }
        // Empty body plus the settled prefix: the engine decodes only the
        // tail past upToS and prepends this text. No prefix settled yet: the
        // engine reads the whole clip, exactly as before.
        return shipVoice('', {
          ...(p ? {partial: {text: p.text, upToS: p.upToS}} : {}),
          streaming: true
        });
      }
      // A body must ride the wire (caption/reply) or the engine cannot fill
      // it (`!canWords`): the device is the only transcript source, so wait
      // for it to settle, then bake the full transcript in.
      return (async () => {
        await settleHeldWords();
        return shipVoice(compose().text.trim());
      })();
    }

    deps.scrollToBottom();
    cap.uploading++;
    return (async () => {
      try {
        const held = new Set<File>();

        const heldCap = new Map<File, number>();
        for (const [capId, h] of cap.heldClips) {
          const f = h.file();
          if (f) {
            held.add(f);
            heldCap.set(f, capId);
          }
        }

        const canWords = held.size > 0 && engine.engineCan(s.id, 'words');

        if (staged.some((st) => st.durationS)) {
          cyclog('send.words-gate', {
            session: s.id,
            clips: held.size,
            engineCan: engine.engineCan(s.id, 'words'),
            path: canWords ? 'markers' : held.size ? 'wait' : 'already-heard',
            why: held.size
              ? 'a recording in this message has no words on this device yet'
              : 'every recording in this message was already transcribed here, so there is ' +
                'nothing for the engine to fill in and nothing to wait for'
          });
        }
        if (held.size && !canWords) {
          cyclog('send.words-wait', {
            session: s.id,
            clips: held.size,
            why:
              'this engine cannot transcribe a held message, so the send waits for the ' +
              'decoder exactly as it did before task 292 rather than promising words ' +
              'nobody on the other end is going to produce'
          });
          await settleHeldWords();
        }
        unsentWork.hold(5000);

        // Each file gets a transfer key now; the wire's words markers name that
        // key, and the store swaps in the uploadId once the file is on the engine.
        const keyOf = new Map<File, string>();
        for (const st of staged) keyOf.set(st.file, crypto.randomUUID());
        const byFile = new Map<File, string>();
        staged.forEach((st) => {
          if (canWords && held.has(st.file)) byFile.set(st.file, keyOf.get(st.file)!);
        });
        const marker = (st: Staged) => {
          const key = byFile.get(st.file);
          return key ? engine.wordsMarker(key) : undefined;
        };

        const wire = compose(byFile.size ? marker : undefined);
        const {text, anchors} = compose();
        const words = [...byFile.values()];

        const partials: {id: string; text: string; upToS: number}[] = [];
        staged.forEach((st) => {
          const id = byFile.get(st.file);
          if (!id) return;
          const capId = heldCap.get(st.file);
          const rec = capId !== undefined ? cap.partialByCapture.get(capId) : undefined;
          if (!rec || !rec.text.trim()) return;
          const settled = rec.text.slice(0, rec.committed).trim();
          if (!settled) return;
          const fully = rec.committed >= rec.text.length;
          const upToS = fully ? (st.durationS ?? rec.committedS ?? 0) : (rec.committedS ?? 0);
          if (upToS > 0) partials.push({id, text: settled, upToS});
        });
        if (words.length) {
          cyclog('send.words-deferred', {
            session: s.id,
            uploads: words.join(','),
            chars: text.length,
            wireChars: wire.text.length,
            partials: partials.length
              ? partials.map((p) => `${p.id}@${p.upToS.toFixed(1)}s:${p.text.length}c`).join(',')
              : undefined,
            why:
              'the message goes once its files are on the engine, which reads these ' +
              'recordings and puts the words where the markers are; partials name what ' +
              'this device already settled so the engine finishes only the tail'
          });
        }

        const files: engine.AttachFile[] = staged.map((st, i) => ({
          key: keyOf.get(st.file)!,
          file: st.file,
          name: st.file.name,
          mime: st.file.type || 'application/octet-stream',
          ...(st.durationS ? {durationS: st.durationS} : {}),
          ...(st.width && st.height ? {width: st.width, height: st.height} : {}),
          ...(st.fromPage ? {fromPage: st.fromPage} : {}),
          at: anchors[i].at,
          ...(anchors[i].textLen ? {textLen: anchors[i].textLen} : {}),
          wireAt: wire.anchors[i].at,
          ...(wire.anchors[i].textLen ? {wireTextLen: wire.anchors[i].textLen} : {})
        }));
        const id = engine.sendAttachments(s.id, {
          text,
          wireText: wire.text,
          files,
          words,
          ...(partials.length ? {partials} : {}),
          ...(replyTo ? {replyTo} : {}),
          ...(alongside ? {alongside} : {})
        });
        if (!id) throw new Error('no such session');
        // Delivery, rather than disk completion, owns same-message dedup.
        const settling = engine.sendSettles(s.id, id);
        return {kept: committed(s.id, id, settling), delivered: settling};
      } catch (err) {
        cyclog('send.attach-failed', {
          session: s.id,
          files: staged.length,
          err: err instanceof Error ? err.message : String(err),
          why:
            'an attachment could not be queued, so the whole composition is kept in ' +
            'the box to retry rather than sent half-formed'
        });
        toast('Could not queue an attachment; it is kept in the box');

        throw err;
      } finally {
        cap.uploading--;
      }
    })();
  };

  const askPanel = createAskPanel({
    onAnswer: (fingerprint, choice) => {
      const s = active();
      if (!s) return;

      if (!engine.answerAsk(s.id, fingerprint, choice)) {
        askPanel.result(false, 'gone');
      }
    }
  });
  deps.onTeardown(
    engine.onAnswerResult((sessionId, ok, reason, detail) => {
      if (sessionId !== active()?.id) return;
      askPanel.result(ok, reason, detail);
    })
  );

  deps.onTeardown(
    engine.onCompactResult((sessionId, ok, tell) => {
      if (sessionId !== active()?.id) return;
      toast(ok ? 'Compacting this context' : tell || 'Nothing was compacted');
    })
  );

  // The visible box clears on dispatch. Its durable draft remains until the
  // send reaches disk, so a reload can still recover an unpersisted send.
  const composer = createComposer({
    boxOwner: () => vaultBridge.draftOwner(),
    onSend: async (text, replyTo) => {
      const owner = vaultBridge.draftOwner();
      const sentDraft = owner ? vaultBridge.draftIdentity(owner, text) : null;
      const sent = await sendCurrent(
        text,
        'text',
        undefined,
        settledReply(replyTo),
        owner ? sentAlongside(owner) : undefined
      );
      return dropOnSent(sent, owner, sentDraft);
    },
    onJumpToReply: (r) => deps.jumpToReply(r),

    onAttach: async (files, compose, replyTo) => {
      const owner = vaultBridge.draftOwner();
      const sentText = compose().text;
      const sentDraft = owner ? vaultBridge.draftIdentity(owner, sentText) : null;
      const sent = await sendAttachments(
        files,
        compose,
        settledReply(replyTo),
        owner ? sentAlongside(owner) : undefined
      );
      return dropOnSent(sent, owner, sentDraft);
    },

    // No onStage: a staged file's bytes move after the press, over the persisted
    // transfer queue (engine.sendAttachments), never eagerly from the box.
    onLiveSend: () => pipeline.forceEnd(),
    onVoiceCancel: () => {
      pttHolding = false;
      pipeline.cancelCapture();

      speaker.setBusy(false, 'press');

      releaseMicIfIdle(true);
    },
    onVoiceStart: () => {
      voiceHoldStart = Date.now();
      // A new recording claims the stream: cancel any pending grace-window
      // dispose so it cannot pull the mic out from under this recording.
      cancelMicGrace();
      cap.lastPartial = {text: '', committed: 0};

      if (dataState.mode !== 'live') return;

      speaker.pause();
      speaker.setBusy(true, 'press');
      pttHolding = true;
      void ensureMic()
        .then(() => {
          if (pttHolding) pipeline.startPTT();
          else speaker.setBusy(false, 'press');
        })
        .catch(() => {
          pttHolding = false;
          speaker.setBusy(false, 'press');
          speaker.resume();
          toast('Microphone unavailable');
        });
    },
    onVoiceEnd: (how) => {
      const seconds = Math.max(1, Math.round((Date.now() - voiceHoldStart) / 1000));
      const interrupted = how === 'interrupted';

      const sayInterrupted = (capture: number) => {
        cyclog('voice.interrupted', {
          heldS: seconds,
          capture,
          cid: pipeline.cidOf(capture),
          why:
            'the recording was ended by something that was not the user (a cancelled ' +
            'touch, a dead session, or the page being backgrounded); it is KEPT and ' +
            'released into the composer, never cancelled'
        });
        toast('Recording interrupted, kept in the box');
      };

      const held = (clip: VoiceClip) => {
        const handle = composer.addVoice(clip);

        if (!touchCapable) composer.focus();
        return handle;
      };
      if (dataState.mode !== 'live') {
        held({
          durationS: seconds,
          text: VOICE_TRANSCRIPTS[voiceTranscriptIndex++ % VOICE_TRANSCRIPTS.length]
        });

        if (interrupted) sayInterrupted(pipeline.pressCaptureId);
        return;
      }
      pttHolding = false;

      const captureId = pipeline.pressCaptureId;
      if (!captureId) {
        cyclog('release.no-clip', {
          cid: pipeline.cidOf(undefined),
          capture: captureId,
          heldS: seconds,
          why: 'the release beat getUserMedia: nothing was ever recorded, so no block was made'
        });

        if (interrupted) {
          cyclog('voice.interrupted-nothing', {
            heldS: seconds,
            capture: captureId,
            why:
              'the interruption beat getUserMedia: nothing was ever recorded, so the ' +
              'composer is left exactly as it was and no card is shown or claimed'
          });
        }
      } else {
        const heard = cap.heardOn(captureId);
        cap.heldClips.set(
          captureId,
          held({
            durationS: seconds,
            text: heard.text,
            committed: heard.committed
          })
        );

        if (cap.heldClips.size > 8) {
          for (const k of [...cap.heldClips.keys()].slice(0, cap.heldClips.size - 8)) {
            cap.heldClips.get(k)?.update({committed: undefined, unsure: true});
            cyclog('held.evicted', {
              capture: k,
              why:
                'more than 8 captures are in flight; this card can no longer be found by ' +
                'the events that would fill in its words'
            });
            cap.heldClips.delete(k);
            // Consumed with no row to fill: the card is still in the box, so
            // its settlement events must stand down (never the hands-free
            // fallback, which would send a message for a card still held).
            cap.sentByCapture.set(k, null);
          }
        }

        if (interrupted) sayInterrupted(captureId);
      }
      pipeline.endPTT();

      releaseMicIfIdle(true);
    }
  });

  stagedBlocks.held = () => vaultBridge.anyBlocksHeld();

  composer.onInput(() => saveDraft());

  composer.onBlocks(() => {
    saveDraft();
    const owner = vaultBridge.draftOwner();
    if (owner) void persistComposition(owner);
  });
  return {
    releaseMicIfIdle,
    cap,
    composer,
    askPanel,
    sendCurrent,
    vaultBridge,
    saveDraft,
    loadDraft: showDraft,
    dropDraft,
    putBlocksBack,
    restoreVoiceBlock,
    clipCid,
    vaultKeyOf
  };
}
