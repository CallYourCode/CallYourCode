/* CARRY (L3 feature): what is left of "moving a conversation" now that the
 * agent id keys everything.
 *
 * Chat rows, display choices, read markers and the meta all live under the
 * agentId, and a Session is keyed by it, so a harness rolling its session id
 * (/clear, fork, resume), an engine restart, a pane restart or a tmux epoch
 * change move NOTHING: the row keeps its chat because its key never changed.
 * Two operations remain:
 *
 *   adoptSession(agentId, sessionId)  a harness id joins an agent: index
 *                                      insert, pastSessions push, meta flush
 *   absorb(provisional, target)       a pane the engine had to give a
 *                                      provisional agent (no announce yet)
 *                                      turns out to be a known agent: its
 *                                      rows append to the target, once
 *
 * The old relocate/rekey/boot-carry/quiet-pin machinery, and the aliases it
 * needed, are gone with the re-keying that needed them (adapters lane 2).
 *
 *   bun test agent-engine/src/sessions/carry.test.ts
 */

import { saveAgentMeta } from "../runtime/agentmeta.ts";
import { ensureSeqs } from "../chat/chatlog.ts";
import { bumpRowsGen } from "../chat/wirecache.ts";
import { evictContextFor } from "./context-cache.ts";
import { sessions, restoredChats, restoredLogs, agentMetas, chatStore, metaFor, indexSession,
  sessionIndex, flushAgentSave, getManualOrder, setManualOrder,
  bindingOf, markBindingDead, adoptAgentId, purgeSessionState, chatRefFor } from "./session-state.ts";
import type { ChatMsg } from "../chat/chatmsg.ts";
import { srcKey, type SessionRec } from "../chat/sessionrec.ts";
import { rowsBySeq } from "../chat/chatstore.ts";
import type { Session } from "./session-state.ts";

/** What makes one row THE SAME row under two agents. A ChatMsg's `id` is the
 *  session it belongs to (every row of one chat shares it), so it can not key
 *  a union; the audio id or the caller's idempotency key can, and a row with
 *  neither is the same row only when role, time and text all agree. */
function rowKey(m: ChatMsg): string {
  return m.msgId ? `m:${m.msgId}` : m.key ? `k:${m.key}` : `t:${m.role}|${m.ts}|${m.text}`;
}

export function mergeChats(a: ChatMsg[], b: ChatMsg[]): ChatMsg[] {
  // UNION -- rows written under either agent all survive, never overwrite.
  // Ordered by ts and re-sequenced, the same normalisation the restore path
  // (ensureSeqs) already applies to a log read off disk.
  const byKey = new Map<string, ChatMsg>();
  for (const m of a) byKey.set(rowKey(m), m);
  for (const m of b) if (!byKey.has(rowKey(m))) byKey.set(rowKey(m), m);
  const out = [...byKey.values()].sort((x, y) => x.ts - y.ts);
  ensureSeqs(out);
  return out;
}

/** The rows of `b` that `a` does not already hold (messages by rowKey,
 *  session records by their source key or their own id), stamped onto a's
 *  seq axis PAST ITS NEWEST ROW, in ts order among themselves. a's own rows
 *  never move: every device pages them by seq under the same chat, and the
 *  re-sequence this replaced (one status line folded into Hunter, 2026-10-03,
 *  renumbered every row from 0 into a new file) left them all on a dead axis.
 *  A row of b older than a's newest still goes on the end: chat order is seq
 *  order. */
function appendRows(
  a: { chat: ChatMsg[]; log: SessionRec[] }, b: { chat: ChatMsg[]; log: SessionRec[] },
): { chat: ChatMsg[]; log: SessionRec[] } {
  const recKey = (r: SessionRec) => srcKey(r) ?? `id:${r.id}`;
  const msgs = new Set(a.chat.map(rowKey));
  const recs = new Set(a.log.map(recKey));
  let next = 0;
  a.chat.forEach((m, i) => { next = Math.max(next, (m.seq ?? i) + 1); });
  for (const r of a.log) next = Math.max(next, r.seq + 1);
  const chat: ChatMsg[] = [];
  const log: SessionRec[] = [];
  for (const m of b.chat) if (!msgs.has(rowKey(m))) { msgs.add(rowKey(m)); chat.push({ ...m }); }
  for (const r of b.log) if (!recs.has(recKey(r))) { recs.add(recKey(r)); log.push({ ...r }); }
  for (const r of [...chat, ...log].sort((x, y) => x.ts - y.ts)) r.seq = next++;
  const bySeq = (x: { seq?: number }, y: { seq?: number }) => x.seq! - y.seq!;
  return { chat: chat.sort(bySeq), log: log.sort(bySeq) };
}

/** A harness session id becomes this agent's current one. Idempotent: the id
 *  it already answers to is a no-op; a different one pushes the previous
 *  current id to `pastSessions` (once) and flushes the meta NOW, so a restart
 *  in the next second still finds the new id in the index. Returns whether
 *  the current id changed (the caller's rollover signal). */
export function adoptSession(agentId: string, sessionId: string): boolean {
  const meta = metaFor(agentId);
  indexSession(sessionId, agentId);
  if (meta.sessionId === sessionId) return false;
  const prev = meta.sessionId;
  if (prev && !(meta.pastSessions ?? []).includes(prev)) {
    meta.pastSessions = [...(meta.pastSessions ?? []), prev];
  }
  // the id could already sit in pastSessions (a --resume of an older session)
  if (meta.pastSessions?.includes(sessionId)) {
    meta.pastSessions = meta.pastSessions.filter((x) => x !== sessionId);
    if (!meta.pastSessions.length) delete meta.pastSessions;
  }
  meta.sessionId = sessionId;
  const s = sessions.get(agentId);
  if (s) {
    // ONE session-id field for every harness now: the claude
    // jsonl id is not stored a second time, it is derived from this id and the
    // agent kind where a claude-only read needs it (sessions-frame, context-cache).
    s.harnessSessionId = sessionId;
  }
  flushAgentSave(agentId);
  return prev !== null;
}

/** ENGINE-OWNED DIRECT BIND (the pi socket tap, mux-adapter.ts spawn). The
 *  engine spawned this pane and owns its handle: adoptAgentId recorded the
 *  handle -> agentId pane binding at spawn, and pi's own per-pane unix socket
 *  now delivers pi's session id straight to the engine. This carries that id
 *  onto the bound agent IMMEDIATELY, through the very adoptSession above that
 *  reconcile uses, with no dependence on herdr classifying or snapshotting the
 *  pane (the intermittent miss: herdr.ts lifts hookBindFor only for panes it
 *  lists, so an unstamped/absent pi pane never has its bind carried).
 *
 *  Fills a NULL id ONLY. A no id yet -> adopt (returns false: not a roll). The
 *  same id already there -> adoptSession no-ops. A DIFFERENT id is left to
 *  reconcile's rollover/link semantics untouched: the socket carries no roll
 *  context, so it must never clobber a live id here. An id the index already
 *  gives ANOTHER agent (a resumed session, the reopen race) is left to
 *  reconcile too: carried here it would re-index the id onto the provisional
 *  the handle happens to be bound to, and its index rule could no longer fold
 *  that provisional into the agent the id belongs to. Idempotent with the later
 *  reconcile carry, which converges on the same value. Returns the agentId it
 *  carried onto, or null when the handle has no engine bind yet (a foreign or
 *  not-yet-adopted pane: nothing to carry, and nothing invented). */
export function carryDirectHandleBind(handle: string, sessionId: string): string | null {
  const b = bindingOf(handle);
  if (!b) return null; // not an engine-owned pane binding: nothing to carry onto
  const agentId = b.agentId;
  const cur = metaFor(agentId).sessionId;
  if (cur && cur !== sessionId) return null; // a live, different id: defer to rollover
  const owner = sessionIndex.get(sessionId);
  if (owner && owner !== agentId) return null; // another agent's id: reconcile's index rule decides
  adoptSession(agentId, sessionId); // fills the null id, or no-ops the same one
  return agentId;
}

/** THE SPAWN'S BIND WINS OVER A PROVISIONAL THE POLL MINTED FIRST.
 *  /new-session binds its agent id (a pre-mint, or the OLD id of a reopen) to
 *  the handle only once adapter.spawn returns, and herdr's newTab returns only
 *  after the agent has painted, so a reconcile tick in between can list the
 *  pane with no binding, key it by a fresh PROVISIONAL and bind the handle to
 *  that. adoptAgentId never takes a live binding, so the spawn's id was
 *  dropped: pi's socket then carried its session id onto the provisional and
 *  the reopened agent stayed dead (k8plus 2026-10-08, reopen-race.test.ts).
 *  A provisional on the spawned handle is only a placeholder for this very
 *  spawn, so it folds into the spawn's agent and the handle is re-bound. An
 *  ESTABLISHED agent on the handle (it has a session id) is never displaced. */
export function bindSpawnedPane(handle: string, agentId: string): void {
  const b = bindingOf(handle);
  const prov = b && b.alive && b.agentId !== agentId ? sessions.get(b.agentId) : undefined;
  if (prov && prov.alive && prov.muxHandle === handle && agentMetas.get(prov.id)?.sessionId === null) {
    absorb(prov, agentId);
    markBindingDead(handle); // the provisional's binding retires, so adoptAgentId takes the handle
  }
  adoptAgentId(handle, agentId);
}

/** FOLD A PROVISIONAL AGENT INTO THE AGENT IT TURNED OUT TO BE. Runs when a
 *  pane the engine had to key by a fresh provisional id (no announce within
 *  the grace, or none yet at boot) announces an id the index already maps to
 *  `target`. The provisional's rows (anything said in the window) the target
 *  does not already hold are appended to the target's own chat file on its
 *  seq axis (appendRows); the provisional record is marked `mergedInto`
 *  FIRST and saved atomically, so a crash between the two writes leaves a
 *  record that points at the survivor rather than a duplicate row. At most
 *  once: a provisional already merged is skipped. Only a provisional is ever
 *  absorbed; adopting an id that belongs to another established agent moves
 *  the pane to that agent and never merges chats. */
export function absorb(provisional: Session, targetId: string): void {
  if (provisional.id === targetId) return;
  const pm = agentMetas.get(provisional.id);
  if (pm?.mergedInto) return;
  // a row the engine no longer lists with no record either was absorbed
  // already (or never existed): a stale reference folds nothing twice
  if (!pm && sessions.get(provisional.id) !== provisional) return;
  // the target's rows: its live row, or the log restored at boot for an agent
  // no pane has hosted yet this run
  const target = sessions.get(targetId);
  const targetRows = target?.chat ?? restoredChats.get(targetId) ?? [];
  const targetLog = target?.log ?? restoredLogs.get(targetId) ?? [];
  // a row's `id` is the session it is shown under: the survivor's from now on
  const rows = provisional.chat.length || provisional.log.length
    ? appendRows({ chat: targetRows, log: targetLog },
        { chat: provisional.chat.map((m) => ({ ...m, id: targetId })), log: provisional.log })
    : null;
  // THE IN-MEMORY MOVE IS SYNCHRONOUS (reconcile builds the target's row in
  // the same tick); the disk writes follow in order: the tombstone first, the
  // appended rows after, so a crash between them leaves a pointer, never a twin.
  let disk: Promise<void> = Promise.resolve();
  if (pm) {
    pm.mergedInto = targetId;
    // a provisional that never reached disk (no chat file) leaves no tombstone:
    // there is no directory for a pointer to live in, and minting one now is
    // the nameless-record litter this whole rule exists to stop
    if (pm.chat) {
      disk = saveAgentMeta(pm).catch((e) => console.error(`[carry] could not mark ${provisional.id} merged:`, e));
    }
  }
  // any past ids the provisional gathered point at the survivor now
  for (const [sid, aid] of sessionIndex) if (aid === provisional.id) sessionIndex.set(sid, targetId);
  if (rows && (rows.chat.length || rows.log.length)) {
    if (target) { target.chat.push(...rows.chat); target.log.push(...rows.log); bumpRowsGen(target); }
    else {
      restoredChats.set(targetId, [...targetRows, ...rows.chat]);
      restoredLogs.set(targetId, [...targetLog, ...rows.log]);
    }
    // queued now, so a line the target logs next lands after these and the
    // file stays in seq order; held behind the tombstone (ChatStore.after)
    const { aid, chatId } = chatRefFor(targetId);
    chatStore.after(aid, chatId, disk);
    const recSet = new Set<unknown>(rows.log);
    for (const r of rowsBySeq(rows.chat, rows.log)) {
      if (recSet.has(r)) chatStore.appendRec(aid, chatId, r as SessionRec);
      else chatStore.appendMsg(aid, chatId, r as ChatMsg);
    }
  }
  // the provisional row leaves the list; its place in the manual order goes too
  sessions.delete(provisional.id);
  agentMetas.delete(provisional.id);
  restoredChats.delete(provisional.id);
  restoredLogs.delete(provisional.id);
  purgeSessionState(provisional.id);
  evictContextFor(provisional);
  const order = getManualOrder();
  if (order.includes(provisional.id)) setManualOrder(order.filter((x) => x !== provisional.id));
  console.log(`[carry] ${provisional.id} absorbed into ${targetId}` +
    (rows ? ` (appended ${rows.chat.length} messages, ${rows.log.length} records)` : ""));
}
