// The app-facing write door and the open chat's projection. This is the one
// place the running app turns wire facts and the user's own sends into stored
// rows, and the one place the open chat's rendered arrays (s.messages/s.events)
// are rebuilt from those rows. Nothing on the wire writes the open chat's
// arrays directly: a frame upserts a row through here, and the store, if the
// write touched the open chat's visible window, tells us to re-project and
// repaint. A write below the window (or to another chat) updates the durable
// store and paints nothing.
//
// The open chat renders ENTIRELY from the store projection. A background chat
// is not windowed, so its s.messages holds only its own local pending sends
// (sends.ts manages those directly); its engine history lives in the store and
// is projected the moment the chat is opened.

import * as rowStore from './rowStore';
import {cyclog} from '@/shared/logging';
import {eventRow, messageRow, type StoreRow} from './core';
import {notify, sessions} from '../registry';
import {isLocalOnly} from '../sends';
import type {CycSessionEvent} from '../../../types';
import type {CycEngineMessage, CycEngineSession} from '../types';

// The newest-window size a chat opens on. One indexed read of this many rows,
// offline or online, cold or warm.
export const WINDOW = 300;

// The durable id of a not-yet-acked send: a provisional key derived from the
// send's cid, so the echo can rekey it to the engine's real mid without a twin.
export const pendingId = (cid: string): string => `m:pending:${cid}`;

// The signature of the last window projected onto each open chat: the ids, seqs
// and payload fingerprints of the rows plus the pending overlay, in order. A
// re-project whose signature matches paints NOTHING (see applyProjection): a
// periodic catchup tick re-attaches and re-snaps the same window every time, and
// without this guard applyProjection reassigned s.messages and notified on every
// tick, so the open chat visibly flashed with zero new data.
const lastSig = new Map<string, string>();

// A cheap fingerprint of one projected window: every row id, its seq, and the
// payload fields that actually change what is painted (the same fields the
// store's samePayload compares), plus the pending overlay, in order. Two ticks
// that project the identical window produce the identical string.
function projectionSig(
  messages: CycEngineMessage[],
  events: CycSessionEvent[],
  pending: CycEngineMessage[]
): string {
  const parts: string[] = ['m'];
  for (const m of messages) {
    const g = (m as {growing?: boolean}).growing ? 1 : 0;
    parts.push(
      `${m.id}#${m.seq ?? -1}#${m.text ?? ''}#${m.status ?? ''}#${m.queued ? 1 : 0}#${g}#${
        m.durationS ?? ''
      }#${m.transcriptPending ? 1 : 0}`
    );
  }
  parts.push('e');
  for (const e of events) parts.push(`${e.uuid}#${e.seq ?? -1}#${e.text ?? ''}#${e.kind ?? ''}`);
  parts.push('p');
  for (const p of pending) parts.push(`${p.id}#${p.cid ?? ''}#${p.status ?? ''}#${p.text ?? ''}`);
  return parts.join('|');
}

// Rebuild the open chat's rendered arrays from the store's loaded window. The
// engine history renders ENTIRELY from the store; the only thing layered on top
// is the user's own optimistic pending sends (status sending/failed), which are
// a local overlay until the engine's echo settles them into the store. A
// pending bubble whose cid the store now holds (its echo arrived) is dropped
// here, so a settled send never twins its optimistic bubble.
//
// Returns whether the projected window CHANGED. When it did not (the signature
// matches the window already painted), the rendered arrays are left exactly as
// they are and the caller must NOT notify: repainting an unchanged window is the
// flash a catchup tick's re-attach caused. The arrays are only reassigned on a
// real change, so the renderer's incremental diff sees new content when there is
// some, and nothing when there is not.
export function applyProjection(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  const {messages, events} = rowStore.projection(sessionId);
  const settled = new Set<string>();
  for (const m of messages) {
    const cid = (m as CycEngineMessage).cid;
    if (cid) settled.add(cid);
  }
  const pending = (s.messages as CycEngineMessage[]).filter(
    (m) => (isLocalOnly(m) || isUnsettledOwnSend(m)) && !(m.cid && settled.has(m.cid))
  );
  const sig = projectionSig(messages as CycEngineMessage[], events, pending);
  if (lastSig.get(sessionId) === sig) return false;
  lastSig.set(sessionId, sig);
  s.messages = pending.length
    ? [...(messages as CycEngineMessage[]), ...pending]
    : (messages as CycEngineMessage[]);
  s.events = events;
  return true;
}

// Forget a session's last-projected signature, so the next projection is treated
// as a change and paints (a fresh open, or a reset that must repaint even onto
// coincidentally equal content).
export function forgetProjection(sessionId: string): void {
  lastSig.delete(sessionId);
}

let inited = false;

// Register the ONE paint path: a store write that touched the open chat's
// window re-projects that chat and repaints. A below-window backfill never
// reaches here (rowStore fires onChange only for the open, window-touching
// write), so the flood is gone by construction.
export function initDoor(): void {
  if (inited) return;
  inited = true;
  rowStore.onChange((sessionId) => {
    if (applyProjection(sessionId)) notify();
  });
}

// Open a chat onto the store: mark it open, load its newest window, project it.
// One indexed read; the network is not consulted (offline-first).
export async function openChatWindow(sessionId: string): Promise<void> {
  rowStore.setOpen(sessionId);
  await rowStore.openWindow(sessionId, WINDOW);
  warnIfWindowHidesMessages(sessionId);
  // A fresh open must paint (store.ts fires firstPaint after this): forget any
  // stale signature from a previous open so the projection always registers.
  forgetProjection(sessionId);
  applyProjection(sessionId);
}

// Re-snap the open chat's window onto the newest stored tail. A cold open began
// with an empty window whose floor is 0, so every backfilled row would count as
// "in the window" and paint. Once the engine's initial delta has landed the
// newest rows, this snaps the floor up to that tail, so the replicator's older
// backfill falls BELOW the window and paints nothing (the flood is gone even on
// a cold device). One paint, for the settled tail.
export async function resnapOpenWindow(sessionId: string): Promise<void> {
  if (!rowStore.isOpen(sessionId)) return;
  await rowStore.openWindow(sessionId, WINDOW);
  warnIfWindowHidesMessages(sessionId);
  // Only paint when the re-snapped window actually differs: a catchup tick's
  // re-attach re-snaps the identical tail every time, and painting it flashes
  // the open chat with zero new data.
  if (applyProjection(sessionId)) notify();
}

// The cold-open blank chat, named cheaply in the field. When the open window
// projects ZERO messages yet the session holds message rows BELOW the floor, the
// conversation is stored but the window floored above it, so the chat opens
// blank (with the overlay off) or shows only session pills (with it on) -- the
// exact defect a busy agent's renderable-event tail used to cause. Logged once
// per open transition (a signature guard suppresses the catchup-tick repeat), so
// a phone that hits it emits one line instead of the silent blank the field saw.
const blankSig = new Map<string, string>();
function warnIfWindowHidesMessages(sessionId: string): void {
  const {inWindow, belowFloor} = rowStore.messageWindowSplit(sessionId);
  if (inWindow > 0 || belowFloor === 0) {
    blankSig.delete(sessionId);
    return;
  }
  const sig = `${belowFloor}@${rowStore.windowFloorSeq(sessionId)}`;
  if (blankSig.get(sessionId) === sig) return;
  blankSig.set(sessionId, sig);
  cyclog('rowstore.window.blank', {
    session: sessionId,
    belowFloor,
    floorSeq: rowStore.windowFloorSeq(sessionId),
    why: 'the open window projected no messages while message rows are held below its floor; the conversation is stored but the window floored above it'
  });
}

// Extend the open chat's window upward from the store. Returns whether the
// store ran dry below the floor (the caller then hints the replicator).
export async function extendChatWindow(sessionId: string): Promise<boolean> {
  const r = await rowStore.extendWindow(sessionId, WINDOW);
  applyProjection(sessionId);
  return r.dry;
}

// The one write for a batch of engine rows (a live frame, a page the app is
// folding). Synchronous through the warm door when the session is warm (the
// open chat, or one the store is already holding), else the async door. The
// open chat repaints through onChange; a warm-but-not-open session only
// persists.
export function writeMessage(sessionId: string, msg: CycEngineMessage): void {
  writeRow(sessionId, messageRow(sessionId, msg));
}

export function writeEvent(sessionId: string, ev: CycSessionEvent): void {
  writeRow(sessionId, eventRow(sessionId, ev));
}

export function writeRow(sessionId: string, row: StoreRow, tag = 'wire'): void {
  if (rowStore.upsertSync(sessionId, [row], tag) === null)
    void rowStore.upsert(sessionId, [row], tag);
}

// A user send the engine has not confirmed: no durable id (no mid) and no
// dedupeKey (which adoptEngineRow stamps only once an engine echo settles the
// send). Such a bubble is an optimistic overlay ONLY. It must never reach the
// durable store: persisting it wrote a row under the VOLATILE fallback id
// m@<clientTs>|user|<text>, and the later authoritative re-serve (carrying the
// engine mid and a SERVER ts, and no client-only cid) never bridged that client
// ts, so the two rows stood side by side and the owner saw his own message
// twice. The send settles into the store the one right way: adoptEngineRow +
// settleEcho, keyed by the engine's durable id. applyProjection keeps this
// bubble visible as an overlay until then.
export function isUnsettledOwnSend(m: CycEngineMessage): boolean {
  return m.role === 'user' && !m.mid && !m.dedupeKey;
}

// Persist a mutation to an already-loaded row (a delivery tick, a transcript
// fill, a queued-flag release) and repaint the open chat if it is loaded. An
// unsettled optimistic own send is refused here at the one door every in-place
// patch funnels through (an ack promoting the bubble to sent, a voice note
// settling through cacheTail, a queued-flag release): it is overlay-only, and
// writing it under the volatile fallback id was the root of the double message.
export function patchMessage(s: CycEngineSession, msg: CycEngineMessage): void {
  if (isUnsettledOwnSend(msg)) return;
  writeRow(s.id, messageRow(s.id, msg), 'patch');
}

// Settle an engine echo into the store under its durable mid, carrying the
// optimistic bubble's local render id forward (the delivered row IS the mutated
// bubble object). Any provisional pending row is dropped so the send never
// twins; applyProjection then filters the optimistic overlay by cid.
export function settleEcho(sessionId: string, cid: string, delivered: CycEngineMessage): void {
  rowStore.rekey(sessionId, pendingId(cid), messageRow(sessionId, delivered));
}
