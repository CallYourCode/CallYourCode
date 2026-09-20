import type {EngineChatMessage} from '../contract';
import {markGrowing} from '../../audio/audioCache';
import type {CycMessage} from '../../types';
import {capSeen, seen} from './registry';
import {stampRowId} from './rows/core';
import {settleSend} from './sends';
import {reportSighting} from './readState';
import {noteClip} from './voiceNotes';
import {prefetchShownDoc} from './shownPrefetch';
import type {CycEngineMessage, CycEngineSession} from './types';

// The engine's copy of a user row reaches the app twice over: as the live
// echo of an utterance, and again inside a replayed page (an attach after a
// reload, a second tab, the history cache). The bubble the app already holds
// for that send and the engine's row are one message. This module is the one
// place that decides which local bubble a row belongs to and folds the
// engine's facts into it, so no path paints a twin.

const SPEAK_INSTRUCTION =
  'Reply with a concise, complete, simple answer in whole sentences; it will be read aloud.';

export function stripInstruction(text: string): string {
  const t = text.trimEnd();
  return t.endsWith(SPEAK_INSTRUCTION)
    ? t.slice(0, t.length - SPEAK_INSTRUCTION.length).trimEnd()
    : t;
}

export function insertSorted(messages: CycMessage[], m: CycMessage) {
  let i = messages.length;
  while (i > 0 && messages[i - 1].ts > m.ts) i--;
  messages.splice(i, 0, m);
}

// A DURABLE, restart- and renumber-invariant identity for a chat row, NEVER
// seq. seq is the shared paging axis: a session record inserted across a
// restart renumbers a row's seq (the engine's ensureSeqs), and the live log
// already carries message rows with COLLIDING seqs. Keying dedup on seq meant a
// row re-served under a changed seq missed the seen set and painted a verbatim
// twin of every row, both roles, after a reconnect (the dup-rows bug). `mid` is
// minted and persisted by the engine at write time, so it is identical on every
// re-serve. Legacy logs without it fall back to ts|role|text, which is also
// stable: ts is strictly increasing within a session, so it is unique per row.
export function dedupeKeyOf(m: EngineChatMessage): string {
  if (m.mid) return `mid:${m.mid}`;
  return `${m.ts}|${m.role}|${m.text}`;
}

// A row we already hold, re-served under a different seq: a session record
// inserted across a restart renumbers the shared axis, so the same logical row
// comes back with a new seq. Keep the paging axis current WITHOUT a twin, for
// BOTH roles (not just the user's own sends): find the held bubble by its
// durable id, else by its unique role+ts, and adopt the new seq.
export function refoldSeq(s: CycEngineSession, m: EngineChatMessage): void {
  if (m.seq === undefined) return;
  const ex = s.messages.find((x) => {
    const e = x as CycEngineMessage;
    if (m.mid && e.mid) return e.mid === m.mid;
    return x.role === m.role && x.ts === m.ts;
  }) as CycEngineMessage | undefined;
  if (ex && ex.seq !== m.seq) ex.seq = m.seq;
}

// The local bubble an engine user row belongs to, if the app holds one. A cid
// is definitive: the engine got it from this app's send, so a row carrying one
// merges only into the bubble with that cid (or, failing that, the same
// msgId). The text match is for rows without a cid only; with a cid it could
// settle a different pending send that happens to say the same words.
export function findLocalFor(
  s: CycEngineSession,
  m: EngineChatMessage,
  displayText: string
): CycEngineMessage | undefined {
  if (m.role !== 'user') return undefined;
  return s.messages.find((x) => {
    const ex = x as CycEngineMessage;
    if (x.role !== 'user' || ex.dedupeKey) return false;
    if (m.cid && ex.cid === m.cid) return true;
    if (m.msgId && ex.msgId === m.msgId) return true;
    if (m.cid) return false;
    if (x.status !== 'sending' && x.status !== 'sent') return false;
    return x.text === displayText || ex.wireText === displayText;
  }) as CycEngineMessage | undefined;
}

// Fold the engine's row into the bubble: the send is delivered (its intent
// goes), and the bubble takes the engine's timestamp, ids and text.
export function adoptEngineRow(
  s: CycEngineSession,
  local: CycEngineMessage,
  m: EngineChatMessage,
  displayText: string,
  dedupeKey: string
): void {
  local.status = 'delivered';
  settleSend(local.cid);
  local.dedupeKey = dedupeKey;

  const wasTs = local.ts;
  local.ts = m.ts;
  if (wasTs !== m.ts) {
    for (const other of s.messages) {
      const r = (other as CycEngineMessage).replyTo;
      if (r && r.ts === wasTs && r.role === local.role) r.ts = m.ts;
    }
  }
  if (m.msgId && !local.msgId) local.msgId = m.msgId;
  // Carry the engine's durable row id onto the adopted bubble so a later
  // re-serve (a renumber, another attach) dedups on it instead of twinning.
  if (m.mid && !local.mid) local.mid = m.mid;

  // A bubble still streaming the device's own transcript (draftCommitted set)
  // holds a PARTIAL: the engine's delivered text is the settled superset
  // (device words plus the decoded tail) and replaces it whole, one repaint,
  // no duplicate. A bubble with no text at all takes the engine's words as
  // before.
  if (displayText && (local.draftCommitted !== undefined || !local.text)) {
    local.text = displayText;
  }

  if (local.wordsPending) {
    local.text = displayText;
    const files = m.uploads?.length ? m.uploads : m.upload ? [m.upload] : [];
    if (files.length) {
      local.upload = files[0];
      if (files.length > 1) local.uploads = files;
      else delete local.uploads;
    }
    if (m.wordsFailed) local.wordsFailed = true;
    delete local.wordsPending;
    delete local.wireText;
  }
  if (m.queued) local.queued = true;

  if (m.transcriptPending) local.transcriptPending = true;

  if (m.seq !== undefined) local.seq = m.seq;
  // THE OWN ROW IS DELIVERED: report a SIGHTING of it by its durable identity
  // (fix-unread). The engine is the one authority and moves the marker to this
  // row for every device; there is no local ts-marking to drift. Reporting the
  // ROW (mid), not a press-time timestamp, is exactly what keeps a
  // delivery-restamped send read with no divider stranded above it: the marker
  // lands on this row's identity wherever the engine restamped it to.
  reportSighting(s.id, {mid: local.mid ?? m.mid, ts: local.ts});
  // A pending echo (a long note shown before its transcript) carries no words
  // yet: the device's streaming display stands and keeps growing, so
  // draftCommitted stays until the completion row lands (settleTranscript).
  if (!m.transcriptPending) delete local.draftCommitted;
  noteClip(local);
}

// A row from a page (replay or cache). True when it painted a new bubble;
// false when the app already held it, by dedupe key or as the pending bubble
// of one of its own sends (which is then delivered, never twinned).
export function admitEngineMessage(
  s: CycEngineSession,
  m: EngineChatMessage,
  fromReplay: boolean
): boolean {
  const key = dedupeKeyOf(m);
  let keys = seen.get(s.id);
  if (!keys) seen.set(s.id, (keys = new Set()));
  if (keys.has(key)) {
    refoldSeq(s, m);
    return false;
  }
  keys.add(key);
  capSeen(s.id, keys);
  const displayText = m.role === 'user' ? stripInstruction(m.text) : m.text;
  const local = findLocalFor(s, m, displayText);
  if (local) {
    adoptEngineRow(s, local, m, displayText, key);
    return false;
  }
  const msg: CycEngineMessage = {
    id: '',
    role: m.role,
    kind: m.kind === 'voice' ? 'voice' : 'text',
    text: displayText,
    ts: m.ts,
    dedupeKey: key
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
  if (m.scheduled) msg.scheduled = m.scheduled;
  if (m.role === 'user') {
    msg.status = 'sent';
    // A cid names one of this app's own sends: the engine has it, so the row
    // is that send's bubble, delivered. A pending bubble painted for it later
    // (the intents read from disk after the page) finds this one by cid.
    if (m.cid) {
      msg.cid = m.cid;
      msg.status = 'delivered';
      settleSend(m.cid);
    }
  }
  if (fromReplay) msg.fromReplay = true;
  // Stamp the one durable name now that every id-bearing field (mid, cid) is set,
  // so this overlay bubble carries the exact id its store row will (this row is
  // inserted straight into s.messages, not through messageRow).
  stampRowId(msg);
  noteClip(msg);
  insertSorted(s.messages, msg);
  return true;
}
