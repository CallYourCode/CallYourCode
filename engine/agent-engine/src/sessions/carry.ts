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
 *                                      rows fold into the target, once
 *
 * The old relocate/rekey/boot-carry/quiet-pin machinery, and the aliases it
 * needed, are gone with the re-keying that needed them (adapters lane 2).
 *
 *   bun test agent-engine/src/sessions/carry.test.ts
 */

import { saveAgentMeta } from "../runtime/agentmeta.ts";
import { ensureSeqs } from "../chat/chatlog.ts";
import { evictContextFor } from "./context-cache.ts";
import { sessions, restoredChats, restoredLogs, agentMetas, chatStore, metaFor, indexSession,
  sessionIndex, flushAgentSave, scheduleAgentSave, getManualOrder, setManualOrder,
  bindingOf, purgeSessionState } from "./session-state.ts";
import type { ChatMsg } from "../chat/chatmsg.ts";
import { srcKey, type SessionRec } from "../chat/sessionrec.ts";
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

/** The same union over BOTH kinds of row: messages by rowKey, session
 *  records by their source key (or their own id when engine-authored), all
 *  of it ordered by ts and re-sequenced along ONE seq axis so the merged
 *  log pages exactly as a log written in that order would. */
export function mergeLogs(
  a: { chat: ChatMsg[]; log: SessionRec[] }, b: { chat: ChatMsg[]; log: SessionRec[] },
): { chat: ChatMsg[]; log: SessionRec[] } {
  const msgs = new Map<string, ChatMsg>();
  for (const m of a.chat) msgs.set(rowKey(m), m);
  for (const m of b.chat) if (!msgs.has(rowKey(m))) msgs.set(rowKey(m), m);
  const recs = new Map<string, SessionRec>();
  const recKey = (r: SessionRec) => srcKey(r) ?? `id:${r.id}`;
  for (const r of a.log) recs.set(recKey(r), r);
  for (const r of b.log) if (!recs.has(recKey(r))) recs.set(recKey(r), r);
  const recSet = new Set<unknown>(recs.values());
  const rows: (ChatMsg | SessionRec)[] = [...msgs.values(), ...recs.values()].sort((x, y) => x.ts - y.ts);
  rows.forEach((r, i) => { r.seq = i; });
  return {
    chat: rows.filter((r) => !recSet.has(r)) as ChatMsg[],
    log: rows.filter((r) => recSet.has(r)) as SessionRec[],
  };
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
 *  context, so it must never clobber a live id here. Idempotent with the later
 *  reconcile carry, which converges on the same value. Returns the agentId it
 *  carried onto, or null when the handle has no engine bind yet (a foreign or
 *  not-yet-adopted pane: nothing to carry, and nothing invented). */
export function carryDirectHandleBind(handle: string, sessionId: string): string | null {
  const b = bindingOf(handle);
  if (!b) return null; // not an engine-owned pane binding: nothing to carry onto
  const agentId = b.agentId;
  const cur = metaFor(agentId).sessionId;
  if (cur && cur !== sessionId) return null; // a live, different id: defer to rollover
  adoptSession(agentId, sessionId); // fills the null id, or no-ops the same one
  return agentId;
}

/** FOLD A PROVISIONAL AGENT INTO THE AGENT IT TURNED OUT TO BE. Runs when a
 *  pane the engine had to key by a fresh provisional id (no announce within
 *  the grace, or none yet at boot) announces an id the index already maps to
 *  `target`. The provisional's rows (anything said in the window) union into
 *  the target by message id; the provisional record is marked `mergedInto`
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
    ? mergeLogs({ chat: targetRows, log: targetLog },
        { chat: provisional.chat.map((m) => ({ ...m, id: targetId })), log: provisional.log })
    : null;
  // THE IN-MEMORY MOVE IS SYNCHRONOUS (reconcile builds the target's row in
  // the same tick); the disk writes follow in order: the tombstone first, the
  // merged chat after, so a crash between them leaves a pointer, never a twin.
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
  if (rows) {
    if (target) { target.chat = rows.chat; target.log = rows.log; }
    else { restoredChats.set(targetId, rows.chat); restoredLogs.set(targetId, rows.log); }
    void disk.then(async () => {
      try {
        const tm = metaFor(targetId);
        const cid = await chatStore.writeNew(targetId,
          rows.chat as unknown as Parameters<typeof chatStore.writeNew>[1], rows.log);
        tm.chat = cid;
        tm.chats = [...(tm.chats ?? []), { id: cid, createdAt: Date.now() }];
        scheduleAgentSave(targetId);
      } catch (e) {
        console.error(`[carry] could not write the merged chat for ${targetId}:`, e);
      }
    });
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
    (rows ? ` (${rows.chat.length} messages, ${rows.log.length} records)` : ""));
}
