import type {EngineSession, EngineTab} from '../../contract';
import type {CycEngineSession} from '../types';
import {effectiveMuted} from '../../settings';
import {cyclog} from '@/shared/logging';
import {
  engineThinking,
  lastSettledTabs,
  markedUnread,
  notify,
  sessions,
  type Conn
} from '../registry';
import {noteRosterSynced, persistRoster} from '../roster';
import {pruneNotifAvatars, syncNotifAvatars} from '@/features/media/notifAvatars';
import * as sync from '../../sync';
import type {HandlerCtx} from './types';
import {
  applyBroadcastReadThrough,
  forgetReadStateFresh,
  noteReadStateFresh
} from '../readState';

/* The engine's live read state for a session no longer holds "on this
 * connection" once the pipe drops: after a reconnect the owner may have read the
 * chat elsewhere while offline. Clear the freshness flag so speech-on-reconnect
 * waits for THIS connection's sessions frame before it decides what is unheard
 * (readState.readStateFreshOnConn), instead of speaking from the pre-drop state. */
sync.onDisconnected((engineKey) => {
  for (const s of sessions.values()) if (s.engineKey === engineKey) forgetReadStateFresh(s.id);
});

/* THE DEATH GRACE (dead-session archive): a session the engine still lists but
 * whose pane just ended (alive flipped true -> false in a frame) is not yanked
 * out of the live list on that very frame. It keeps churnGrey for this long --
 * the same grey the connection-churn grace paints -- so the row visibly greys,
 * THEN leaves the live list (projectMembership drops a dead, non-active,
 * non-churnGrey row) and is thereafter found in the archive lens. */
export const DEATH_GRACE_MS = 4000;
const deathGrace = new Map<string, ReturnType<typeof setTimeout>>();
const endDeathGrace = (id: string) => {
  const t = deathGrace.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    deathGrace.delete(id);
  }
};

/* Apply ONE wire row onto its live session, exactly the same way whether it
 * arrived in the full {t:"sessions"} list or in an additive one-row
 * {t:"session"} frame (Lane D). ONE place, so the two frames can never drift
 * into applying a field two ways. `knownBefore` is the set of session ids the
 * app held BEFORE this frame, so the death grace fires only on a seen
 * alive -> dead transition. Returns the live session it touched. */
function applySessionRow(
  conn: Conn,
  ctx: HandlerCtx,
  es: EngineSession,
  knownBefore: Set<string>
): CycEngineSession {
  const client = conn.client;
  {
      const s = ctx.ensureSession(conn.key, es.id);
      s.name = es.name;
      s.cwd = es.cwd;

      s.tabKey = es.tab ?? '';

      s.settings = s.confirmedSettings = es.settings;
      s.muted = effectiveMuted(es);
      const wasAlive = knownBefore.has(s.id) && s.alive !== false;
      s.alive = es.alive;
      if (es.alive === false && wasAlive) {
        // The death edge: grey the row now, drop it from the live list when
        // the grace ends (unless a restart flips it back first).
        s.churnGrey = true;
        endDeathGrace(s.id);
        deathGrace.set(
          s.id,
          setTimeout(() => {
            deathGrace.delete(s.id);
            const cur = sessions.get(s.id);
            if (cur && cur.alive === false && cur.churnGrey) {
              cur.churnGrey = false;
              notify();
            }
          }, DEATH_GRACE_MS)
        );
      } else if (es.alive === false && deathGrace.has(s.id)) {
        // Still inside the grace: a re-broadcast must not yank the grey row early.
        s.churnGrey = true;
      } else {
        if (es.alive !== false) endDeathGrace(s.id);
        s.churnGrey = false;
      }
      /* THE ENGINE'S COUNT, for the attached chat too (owner, 2026-10-03). It
       * used to be zeroed here for the open chat ("you are reading it"), which
       * was a read nobody saw: on a phone, back to the list keeps the chat
       * attached, so replies that landed meanwhile showed 0, the re-open landed
       * at the bottom with no divider, and the rows above were read on every
       * device. The count now falls only as rows are actually seen (sightings
       * move the engine's marker). */
      s.unread = es.unread;
      s.engineUnread = es.unread;

      /* THE ENGINE IS THE ONE AUTHORITY (fix-unread): adopt its broadcast
       * read-through IDENTITY verbatim, no max()-of-timestamps reconcile with a
       * client clock (that reconcile, and the client clock, are gone). An
       * engine too old to send readThrough still carries heardTs, so seed the
       * identity from that instant for back-compat; heardTs is otherwise kept
       * only as the legacy field a stray consumer may still read. */
      if (es.readThrough !== undefined) applyBroadcastReadThrough(s, es.readThrough);
      else if (es.heardTs !== undefined) applyBroadcastReadThrough(s, {ts: es.heardTs});
      if (es.heardTs !== undefined) s.heardTs = es.heardTs;
      // The engine has now served this session's read state on the live pipe:
      // speech deferred at open (readStateFreshOnConn) may run, on this truth.
      noteReadStateFresh(s.id);
      if (es.thinking !== undefined) {
        engineThinking.add(s.id);

        s.thinking = es.thinking && es.status !== 'blocked';
      }

      if (es.status !== undefined) s.status = es.status;

      s.contextPct = es.contextPct ?? undefined;
      // absent (count dropped to 0) clears the chip, the same way contextPct does
      s.subagentsRunning = es.subagentsRunning ?? undefined;

      s.avatarUrl = es.photo ?? undefined;
      if (es.title !== undefined) s.title = es.title;

      if (es.agent !== undefined) s.agentName = es.agent;

      s.agentId = es.agentId;

      if (es.sessionAgentId !== undefined) s.sessionAgentId = es.sessionAgentId;
      if (es.displayAgent !== undefined) s.agentLabel = es.displayAgent ?? undefined;

      s.model = es.model ?? undefined;
      if (es.turnSince !== undefined) s.turnSince = es.turnSince;
      if (es.lastActivity !== undefined) s.lastActivity = es.lastActivity;

      s.ask = es.ask ?? null;
      s.askUnknown = es.askUnknown === true;
      if (es.replyLevel !== undefined) s.replyLevel = es.replyLevel;
      if (es.order !== undefined) s.order = es.order;

      const rotated =
        s.claudeSessionId !== null &&
        es.claudeSessionId !== null &&
        s.claudeSessionId !== es.claudeSessionId;
      const gained = s.claudeSessionId === null && es.claudeSessionId !== null;
      s.claudeSessionId = es.claudeSessionId;

      /* A rotation or a newly minted session id changes nothing the app holds:
       * the records of the new transcript land on the same log, on the same
       * pages, as live deltas. */
      if ((rotated || gained) && s.id === ctx.attachedId() && ctx.overlayOn(s.id)) {
        if (gained) client.setSessionTail(s.paneId, true);
      }
      return s;
  }
}

export function wireSessions(conn: Conn, ctx: HandlerCtx): void {
  const client = conn.client;

  client.on('sessions', (list: EngineSession[], declared: EngineTab[]) => {
    conn.tabs = declared;

    if (declared.length) lastSettledTabs.set(conn.key, declared);
    // Which sessions the app already held BEFORE this frame: the death grace
    // fires only on a seen alive -> dead transition. A session this frame
    // introduces already dead (a cold list of the archive) gets no grace.
    const knownBefore = new Set(sessions.keys());
    const listed = new Set<string>();
    for (const es of list) {
      const s = applySessionRow(conn, ctx, es, knownBefore);
      listed.add(s.id);
    }

    const settled = conn.state === 'connected' && conn.helloSettled;
    let reclaimed = 0;
    for (const s of [...sessions.values()]) {
      if (s.engineKey !== conn.key || listed.has(s.id)) continue;
      if (settled && s.id !== ctx.attachedId()) {
        sessions.delete(s.id);
        endDeathGrace(s.id);
        markedUnread.delete(s.id);

        if (ctx.reclaimDead(s.id)) reclaimed++;
        continue;
      }
      s.alive = false;

      s.churnGrey = !settled;
      s.thinking = false;
      if (s.status !== undefined) s.status = 'unknown';

      s.ask = null;
      s.askUnknown = false;
    }
    if (reclaimed) cyclog('store.sessions.reclaimed', {engine: conn.key, count: reclaimed});

    // Every sessions frame is the engine serving the roster: persist it now,
    // settled or not, so a cold open paints what the engine last said.
    noteRosterSynced(conn.key, Date.now());
    persistRoster(conn.key);
    // Keep the local notification-icon store current (photo thumbnail or the
    // name-derived fallback); sealed pushes carry no icon, the worker reads
    // this store by sessionId. Fire-and-forget, deduped inside.
    syncNotifAvatars(
      [...sessions.values()]
        .filter((s) => s.engineKey === conn.key && listed.has(s.id))
        .map((s) => ({id: s.id, name: s.name, avatarUrl: s.avatarUrl}))
    );
    /* And the other direction: icon rows of departed sessions are pruned, but
     * ONLY off a settled (connected + hello) frame, this engine's authoritative
     * roster. The keep-set is every session still in the map, ALL engines: the
     * icon store is one flat DB, and a down engine's sessions (greyed above,
     * never deleted unsettled) must keep their rows. Deduped and gated inside
     * (armed only after cold-open hydration; an unchanged keep-set is free). */
    if (settled) void pruneNotifAvatars([...sessions.keys()]);
    notify();
    // Roster applied and persisted: the engine may settle now (step 1 of the
    // connected-edge order).
    sync.noteSessions(conn.key);
  });

  /* ONE roster row's fields changed (Lane D): apply exactly that row, persist,
   * and re-key exactly that list row. No reclaim loop (the set did not move --
   * a set/order/tabs change still arrives as a full `sessions` frame) and no
   * sync.noteSessions (a mid-stream patch is not the full roster the connected
   * edge waits for). */
  client.on('session', (es: EngineSession) => {
    // An unknown id means the app missed the full frame that introduced this
    // row: do NOT guess a phantom into the list. Ask for the whole roster and
    // let the next full frame reconcile it.
    const held = [...sessions.values()].some(
      (x) => x.engineKey === conn.key && x.paneId === es.id
    );
    if (!held) {
      client.resyncSessions();
      return;
    }
    // The set the app held before this frame (it holds the row, so the death
    // grace still fires on a seen alive -> dead edge, exactly as in the full
    // frame's loop).
    const knownBefore = new Set(sessions.keys());
    const s = applySessionRow(conn, ctx, es, knownBefore);

    // The engine served this row: stamp freshness (excluded from the persist
    // guard's fingerprint) and persist. persistRoster writes at most one IDB
    // record and skips when no persisted field moved (V2b guard).
    noteRosterSynced(conn.key, Date.now());
    persistRoster(conn.key);
    syncNotifAvatars([{id: s.id, name: s.name, avatarUrl: s.avatarUrl}]);
    notify();
  });

  client.on('sessionIdChanged', (from: string, to: string) => {
    ctx.rekeySession(conn.key, from, to);
  });

  client.on('compactResult', (paneId: string, ok: boolean, tell: string) => {
    const s = [...sessions.values()].find((x) => x.engineKey === conn.key && x.paneId === paneId);
    ctx.fireCompactResult(s?.id ?? paneId, ok, tell);
  });

  client.on('answerResult', (paneId: string, ok: boolean, reason?: string, detail?: string) => {
    const s = [...sessions.values()].find((x) => x.engineKey === conn.key && x.paneId === paneId);
    ctx.fireAnswerResult(s?.id ?? paneId, ok, reason, detail);
  });
}
