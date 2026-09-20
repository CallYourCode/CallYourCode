import {cyclog} from '@/shared/logging';
import {PAGE_SIZE} from '@shared/pages';
import type {EngineChatMessage} from '../../contract';
import {markGrowing} from '../../../audio/audioCache';
import {engineThinking, notify, sessions, sid, type Conn} from '../registry';
import {stampRowId} from '../rows/core';
import {failSend, settleSend} from '../sends';
import {adoptEngineRow, dedupeKeyOf, findLocalFor} from '../admit';
import {prefetchShownDoc} from '../shownPrefetch';
import * as sync from '../../sync';
import {noteClip} from '../voiceNotes';
import type {CycEngineMessage, CycEngineSession} from '../types';
import type {HandlerCtx} from './types';
import {patchMessage, settleEcho, writeMessage} from '../rows/door';
import {isResumeControlRow} from '@/features/chat/content';
import {feedAttachOk, noteLive} from '../rows/repl';

export function wireChat(conn: Conn, ctx: HandlerCtx): void {
  const client = conn.client;

  client.on('attachOk', (a) => {
    const s = ctx.ensureSession(conn.key, a.id);
    s.awaitingChatStart = false;

    if (!a.known) {
      s.notOnEngine = true;
      s.historyPending = false;
      ctx.endReplayHold(s.id);
      ctx.firstPaint(s.id, 'replay');
      notify();
      return;
    }
    s.notOnEngine = false;
    /* attach-ok always carries pageSize today (the engine's only sender fills
     * it in). If one arrives without it, say so out loud and fall back to the
     * one shared page size rather than let a silent default hide a wire skew. */
    if (a.pageSize) s.pageSize = a.pageSize;
    else {
      cyclog('history.pagesize-missing', {session: a.id});
      s.pageSize = PAGE_SIZE;
    }
    if (a.total !== undefined) s.engineTotal = a.total;
    if (a.pointer !== undefined) s.pointer = a.pointer;
    if (a.pointerPage !== undefined) s.pointerPage = a.pointerPage;
    if (a.tailPage !== undefined) s.tailPage = a.tailPage;

    // The delta's pages and its tail bookkeeping go to the replicator, the ONE
    // consumer of the wire: it appends the rows to the store (which repaints the
    // open window only if it changed) and backfills the rest in the background.
    // No page ever paints s.messages directly, so a cold flood cannot repaint
    // per page.
    // The replay paint waits for feedAttachOk to RESOLVE, which is when this
    // attach-ok's whole run finished (a stale-axis heal's purge -> admit ->
    // resnap, or a plain resnap). Painting synchronously here, while the heal was
    // still mid-flight between its purge and its admit, is what put the phone's
    // `chat.painted source=replay count=0` on screen 5ms after the stale-axis
    // line: the empty window the purge had just opened. Deferring firstPaint to
    // the heal's completion means the FIRST paint the open chat shows is the
    // healed served tail, never the mid-heal empty window. historyPending stays
    // set until then, so the chat shows its busy state rather than an empty one.
    void feedAttachOk(s.id, conn.key, s.paneId, {
      sessionId: s.id,
      pageSize: s.pageSize ?? PAGE_SIZE,
      total: a.total,
      tailPage: a.tailPage,
      pointerPage: a.pointerPage,
      pages: a.pages ?? [],
      deltaBase: a.deltaBase
    }).then(() => {
      const st = sessions.get(s.id);
      if (!st) return;
      reconcileQueued(st, a.queued, ctx);
      st.historyPending = false;
      ctx.endReplayHold(st.id);
      ctx.firstPaint(st.id, 'replay');
      notify();
    });

    sync.noteSynced(s.id, Date.now());
  });

  // The engine acked the utterance (section 2b): it took the frame, so the
  // send is settled here, its intent deleted, the bubble one tick ('sent').
  // The ack is delivery-blind: it fires before the pane is fed, so a later
  // send-failed on the same cid can still demote this row to failed. An ack
  // with err is the nack: the engine has no session for the send.
  client.on('ack', (a) => {
    const s = sessions.get(sid(conn.key, a.id));
    const m = s?.messages.find((x) => (x as CycEngineMessage).cid === a.cid) as
      CycEngineMessage | undefined;
    if (a.err) {
      const why = a.err === 'unknown-session' ? 'the engine has no such session' : a.err;
      if (m && s) {
        m.status = 'failed';
        m.failReason = why;
        patchMessage(s, m);
        notify();
      }
      failSend(a.cid, why);
      return;
    }
    if (m && s) {
      if (m.status === 'sending') m.status = 'sent';
      if (a.msgId && !m.msgId) m.msgId = a.msgId;
      patchMessage(s, m);
      notify();
    }
    settleSend(a.cid);
  });

  // The engine could not deliver the send: the row is painted failed with the
  // engine's reason and kept, owed again on the retry tap.
  client.on('sendFailed', (f) => {
    const s = sessions.get(sid(conn.key, f.id));
    const m = s?.messages.find((x) => (x as CycEngineMessage).cid === f.cid) as
      CycEngineMessage | undefined;
    if (m && s) {
      m.status = 'failed';
      m.failReason = f.reason;
      patchMessage(s, m);
      notify();
    }
    failSend(f.cid, f.reason);
  });

  client.on('chat', (m: EngineChatMessage) => {
    const s = ctx.ensureSession(conn.key, m.id);
    s.awaitingChatStart = false;

    if (m.role === 'claude') ctx.releaseQueuedBefore(s, m.ts);

    // A control-answer row (a terminal prompt answered from the app) is real
    // history but not something the session said, so it never advances the
    // last-activity clock the roster shows.
    if (m.ts && !isResumeControlRow(m) && (s.lastActivity === undefined || m.ts > s.lastActivity))
      s.lastActivity = m.ts;

    const displayText = m.role === 'user' ? ctx.stripInstruction(m.text) : m.text;

    // A live user echo that belongs to one of this app's own pending sends: fold
    // the engine's facts into the pending bubble and settle it into the store
    // under the engine's durable id, keeping the painted node (no twin).
    const local = findLocalFor(s, m, displayText);
    if (local) {
      const cid = local.cid;
      adoptEngineRow(s, local, m, displayText, dedupeKeyOf(m));
      if (cid) settleEcho(s.id, cid, local);
      else writeMessage(s.id, local);
      noteLive(s.id, m.seq);
      if (!engineThinking.has(s.id)) s.thinking = false;
      notify();
      return;
    }

    // Any other row (a claude reply, another tab's user row, a re-serve): build
    // it and enter the one door. The store dedupes by durable id, so a re-serve
    // under a renumbered seq rewrites the one row in place instead of twinning,
    // and a completed transcript replaces its pending predecessor's payload.
    const msg: CycEngineMessage = {
      id: '',
      role: m.role,
      kind: m.kind === 'voice' ? 'voice' : 'text',
      text: displayText,
      ts: m.ts,
      dedupeKey: dedupeKeyOf(m)
    };
    if (m.seq !== undefined) msg.seq = m.seq;
    if (m.mid) msg.mid = m.mid;
    if (m.msgId) msg.msgId = m.msgId;
    if (m.durationS !== undefined) msg.durationS = m.durationS;
    if (m.growing) {
      msg.growing = true;
      if (m.msgId) markGrowing(m.msgId);
    }
    if (m.file) {
      msg.file = m.file;
      prefetchShownDoc(s, m.file);
    }
    if (m.upload) msg.upload = m.upload;
    if (m.uploads?.length) msg.uploads = m.uploads;
    if (m.queued) msg.queued = true;

    if (m.wordsFailed) msg.wordsFailed = true;

    if (m.transcriptPending) msg.transcriptPending = true;

    if (m.scheduled) msg.scheduled = m.scheduled;
    if (m.role === 'user') {
      msg.status = 'sent';
      // Another tab's send, or one whose bubble is not painted yet: the engine
      // has it, so a pending bubble painted for it later finds it by cid.
      if (m.cid) {
        msg.cid = m.cid;
        msg.status = 'delivered';
        settleSend(m.cid);
      }
    }

    stampRowId(msg);
    noteClip(msg);
    writeMessage(s.id, msg);
    noteLive(s.id, m.seq);

    if (!engineThinking.has(s.id)) s.thinking = false;
    notify();
  });

  client.on('dequeued', (paneId, ts) => {
    const sessionId = sid(conn.key, paneId);
    const s = sessions.get(sessionId);
    const m = s?.messages.find((x) => x.ts === ts && x.role === 'user');
    if (!s || !m) return;
    if (!ctx.releaseQueued(s, m as CycEngineMessage)) return;
    notify();
  });
}

// Reconcile the engine's authoritative queued-user-row list against the open
// window: clear a stale "Queued for Claude" a missed `dequeued` frame left set,
// and set one the app has not learned yet. Each changed row is patched back to
// the store so the flag persists.
function reconcileQueued(s: CycEngineSession, queued: number[] | undefined, ctx: HandlerCtx): void {
  if (queued) {
    const want = new Set(queued);
    for (const m of s.messages) {
      if (m.role !== 'user') continue;
      const em = m as CycEngineMessage & {queued?: boolean};
      if (em.queued && !want.has(m.ts)) {
        delete em.queued;
        patchMessage(s, em);
      } else if (!em.queued && want.has(m.ts)) {
        em.queued = true;
        patchMessage(s, em);
      }
    }
  } else {
    // an older engine sends no list: keep the latest-reply heuristic
    let latestReplyTs = 0;
    for (const m of s.messages)
      if (m.role === 'claude' && m.ts > latestReplyTs) latestReplyTs = m.ts;
    if (latestReplyTs) ctx.releaseQueuedBefore(s, latestReplyTs);
  }
  notify();
}
