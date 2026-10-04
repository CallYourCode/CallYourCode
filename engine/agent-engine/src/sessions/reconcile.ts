/* RECONCILE (L3 feature): the adapter.onAgents rebuild.
 *
 * Every mux pane is a session, KEYED BY ITS AGENT ID (adapters lane 2). The
 * pane's evidence (an announced or guessed harness session id, a pre-minted
 * agent id, a pane binding, nothing) resolves to an agent through ONE rule,
 * resolvePane below, before the row is built; a gone pane stays listed dead
 * unless it never said anything; the held ask is kept in step with the
 * status; and the tail sets re-sync. The L1 invariant: every live pane the
 * mux reports is exactly one row, whatever agent it runs.
 *
 * THE RESOLUTION RULE (design section 1), evidence order:
 *   1. an explicit link (`link.from`, a harness's own "I came from session
 *      F") whose F is in the index -> that agent, before any pane matching
 *   2. an announced/guessed id X in the index -> that agent (adopt X)
 *   3. X unknown, pane bound to agent A (live row on the handle, or the
 *      persisted binding from before an engine restart) and A not live in
 *      another pane -> X joins A: the same-pane rollover
 *   4. X unknown, no binding -> a NEW agent. Matching is on session ids,
 *      never on the folder (owner decision 2026-09-02)
 *   5. no id yet: the pre-mint (CYC_AGENT_ID) or the binding names the agent;
 *      otherwise a PROVISIONAL agent that is never written to disk until a
 *      session id or a chat exists
 *   A guessed id (the mux's transcript locator, not an announce) counts only
 *   after ANNOUNCE_GRACE_MS from the pane's first sight, so a hook that
 *   announces within the grace always wins over the guess. A mergedInto chain
 *   is already followed by the index.
 *   "Live in another pane" (rules 1 and 3) is decided against the WHOLE tick
 *   (tickOf, liveElsewhere): an agent whose id is reported by any other pane
 *   of this poll keeps its row there, whichever pane the mux listed first.
 *
 *   bun test agent-engine/src/sessions/reconcile.test.ts
 */

import { turnSinceFor } from "../chat/turn.ts";
import { ANNOUNCED_SOURCE, PREMINT_SOURCE, PARKED_SOURCE, agentLabel } from "../runtime/agents.ts";
import { isHarnessSessionId } from "../runtime/ids.ts";
import { adoptSession, absorb } from "./carry.ts";
import { sessions, restoredChats, restoredLogs, restoredSeenOf, restoredNotifiedOf, restoredFiledOf,
  heardTsFor, agentMetas, metaFor, freshAgentId, sessionIndex,
  bindingOf, recordBinding, markBindingDead, savePaneBindings,
  purgeSessionState, scheduleAgentSave, type Session } from "./session-state.ts";
import { doneSeqFor, seenDoneSeqFor } from "./readstate.ts";
import { reduceStatus, deriveBusy } from "./status-reducer.ts";
import { refreshContext } from "./context-cache.ts";
import { stopIngest, syncIngest, syncStatusTails } from "../chat/ingest.ts";
import { asks, refreshAsk, ASK_POLL_MS } from "../chat/asks.ts";
import { askCommitted } from "../chat/asks.ts";
import { logSession, noticeChat } from "../chat/chatlog.ts";
import { utterQueue } from "../chat/deliver.ts";
import { unsubmitted } from "../chat/pane-deliver.ts";
import type { MuxAgentInfo } from "../adapters/mux-adapter.ts";
import type { AgentMeta } from "../runtime/agentmeta.ts";

/** How long a never-announced pane waits for its hook before the mux's guess
 *  (transcript locator) is allowed to name its session. Read per call so a
 *  seam test can shorten it. */
export function announceGraceMs(): number {
  const n = Number(process.env.CYC_ANNOUNCE_GRACE_MS ?? 10_000);
  return Number.isFinite(n) && n >= 0 ? n : 10_000;
}

export type ReconcileDeps = {
  hasTranscript(kind: string): boolean;
  canParseScreen(handle: string): boolean;
  /* Whether the mux emits its own `done` status (MuxCapabilities.nativeDone).
   * herdr does, so its idle/done value is authoritative and left alone; tmux
   * does not, so a closed jsonl turn is synthesized into `done` below. */
  nativeDone: boolean;
  sweepTails(): void;
  broadcastSessions(): void;
  now?: () => number;
  /** the engine log line writer (status.edge for mux-driven changes) */
  log?(event: string, fields: Record<string, unknown>): void;
};

/** What one pane's mux evidence says, normalised. */
export type PaneEvidence = {
  /** the harness session id the pane reports, announced or guessed */
  sessionId: string | null;
  announced: boolean;
  /** the engine's own agent id, injected at spawn (CYC_AGENT_ID) */
  premintId: string | null;
  link: { kind: string; from?: string } | null;
};

/* Ids the mux reported for a pane that are not harness-shaped, logged once
 * each. v1 metas carry pane ids where a session id belongs (the survey behind
 * defect B), so whatever put them there, a pane id in this field is not a
 * session and must not become one again. */
const refused = new Set<string>();

export function evidenceOf(a: MuxAgentInfo): PaneEvidence {
  const ref = a.agentSession;
  const premintId = ref?.source === PREMINT_SOURCE ? ref.id : null;
  const parked = !ref || ref.source === PARKED_SOURCE || ref.kind !== "id";
  const reported = a.harnessSessionId ?? (premintId || parked ? null : ref!.id);
  /* THE SHAPE GATE: only a harness session id (ids.ts) names a conversation.
   * Anything else the mux put in the session field (a pane id, a label) is
   * no evidence at all: the pane resolves as if it had reported nothing. */
  const sessionId = isHarnessSessionId(reported) ? reported : null;
  if (reported && !sessionId && !refused.has(reported)) {
    refused.add(reported);
    console.log(`[session] ${a.handle} reports "${reported}" as its session id: not a harness id, ignored`);
  }
  return {
    sessionId,
    announced: ref?.source === ANNOUNCED_SOURCE,
    premintId,
    link: ref?.link ?? null,
  };
}

export type Resolution = {
  agentId: string;
  /** the id the pane reports, when it counts this tick */
  sessionId: string | null;
  /** how the agent was chosen, for the log and the rollover row */
  how: "link" | "index" | "pane-continuity" | "new" | "premint" | "binding" | "live" | "provisional";
};

/* First sight per handle, for the announce grace. Cleared when the handle
 * leaves the snapshot, so a reused herdr public id starts its own clock. */
const firstSeen = new Map<string, number>();

export function resetReconcileForTest(): void {
  firstSeen.clear();
  refused.clear();
}

/** What the WHOLE poll tick says, gathered before any pane is resolved, so
 *  a pane's answer cannot depend on the order the mux lists the panes in.
 *  The rules read this and nothing that the tick has rebuilt so far: the
 *  live `sessions` map is rewritten pane by pane inside the same tick
 *  (sessions.set below), so a rule that looked it up mid-tick would see
 *  last tick's row for one pane and this tick's for another. Last tick's
 *  rows are therefore snapshotted here (rowOn, holderOf) before the loop. */
export type Tick = {
  now: number;
  /** every handle in the snapshot */
  live: Set<string>;
  /** the session id each handle reports this tick, the announce grace applied */
  idOf: Map<string, string | null>;
  /** the handles reporting each session id */
  handlesOf: Map<string, Set<string>>;
  /** the handles carrying each pre-minted agent id */
  premintOf: Map<string, Set<string>>;
  /** each handle's cwd this tick (the binding's cwd check) */
  cwdOf: Map<string, string>;
  /** LAST tick's live row on each handle (sessionByHandle, frozen) */
  rowOn: Map<string, string>;
  /** LAST tick's handle of each agent's live row (frozen) */
  holderOf: Map<string, string>;
  /** the agent each UNKNOWN session id resolved to this tick (rule 3), so
   *  two panes reporting the same new id are one agent whichever is asked
   *  first; `minted` marks the ones that are fresh */
  agentOfUnknown: Map<string, string>;
  minted: Set<string>;
};

export function tickOf(agents: MuxAgentInfo[], evs: PaneEvidence[], now: number): Tick {
  const t: Tick = { now, live: new Set(), idOf: new Map(), handlesOf: new Map(), premintOf: new Map(),
    cwdOf: new Map(), rowOn: new Map(), holderOf: new Map(), agentOfUnknown: new Map(), minted: new Set() };
  for (const s of sessions.values()) {
    if (!s.alive || !s.muxHandle) continue;
    if (!t.rowOn.has(s.muxHandle)) t.rowOn.set(s.muxHandle, s.id);
    t.holderOf.set(s.id, s.muxHandle);
  }
  agents.forEach((a, i) => {
    const ev = evs[i]!;
    t.live.add(a.handle);
    t.cwdOf.set(a.handle, a.cwd);
    // a guess counts only once the pane has had its chance to announce: a
    // stale transcript in the cwd must not put a new pane on an old agent (or
    // mint one for it) in the seconds before its hook speaks
    const seen = firstSeen.get(a.handle) ?? now;
    let sessionId = ev.sessionId;
    if (sessionId && !ev.announced && now - seen < announceGraceMs()) sessionId = null;
    t.idOf.set(a.handle, sessionId);
    if (sessionId) {
      const hs = t.handlesOf.get(sessionId) ?? new Set<string>();
      hs.add(a.handle);
      t.handlesOf.set(sessionId, hs);
    }
    if (ev.premintId) {
      const hs = t.premintOf.get(ev.premintId) ?? new Set<string>();
      hs.add(a.handle);
      t.premintOf.set(ev.premintId, hs);
    }
  });
  return t;
}

/** Is `agentId` running in a pane other than `handle` this tick? True when
 *  another pane REPORTS one of the agent's ids (current, past, lineage, or
 *  a merged record's, i.e. anything the index maps to it) or carries its
 *  pre-mint. Evidence only: the pane that merely HOLDS the agent's row from
 *  last tick does not count, because a row lands on a silent pane through
 *  its binding (or the tick's own tie-break) and says nothing about where
 *  the agent runs; counting it made the answer depend on which of two
 *  silent bound panes the previous tick happened to list first. Reads the
 *  tick snapshot only, never the rows rebuilt so far. */
export function liveElsewhere(agentId: string, handle: string, tick: Tick): boolean {
  for (const [id, hs] of tick.handlesOf) {
    if (sessionIndex.get(id) !== agentId) continue;
    for (const h of hs) if (h !== handle) return true;
  }
  for (const h of tick.premintOf.get(agentId) ?? []) if (h !== handle) return true;
  return false;
}

/** An agent this handle was pre-bound to that never captured a harness session
 *  id: a /new-session pre-mint (adoptAgentId) or a parked provisional, marked
 *  by its binding's null sessionId. Reclaimable by a LATER announce even after
 *  the pane blinked out of the snapshot, so the binding may be DEAD here (the
 *  pane-gone purge keeps a pending binding for exactly this). NEVER an
 *  established session: its binding carries the adopted id, so a dead binding
 *  there still never rejoins (the pane exited, whatever comes back is new). The
 *  caller gates this on an ANNOUNCED id and the live-elsewhere guard. */
function pendingBoundAgentOf(handle: string, tick: Tick): string | null {
  const bound = bindingOf(handle);
  const cwd = tick.cwdOf.get(handle);
  if (bound && bound.sessionId === null && (!bound.cwd || bound.cwd === cwd)) return bound.agentId;
  return null;
}

/** The agent a handle carries into this tick without reporting anything:
 *  last tick's row on it, else its persisted binding (alive, same cwd). */
function carriedAgentOf(handle: string, tick: Tick): { agentId: string; how: "live" | "binding" } | null {
  const onHandle = tick.rowOn.get(handle);
  if (onHandle) return { agentId: onHandle, how: "live" };
  const bound = bindingOf(handle);
  const cwd = tick.cwdOf.get(handle);
  if (bound && bound.alive && (!bound.cwd || bound.cwd === cwd)) return { agentId: bound.agentId, how: "binding" };
  return null;
}

/** Rule 3 over the WHOLE tick: an id the index does not know joins the
 *  agent carried by a pane that reports it, when that agent is not live
 *  elsewhere; otherwise it is a new agent. Decided once per id, for every
 *  pane reporting it, so the same new id in two panes is one agent (claude
 *  interleaves both into one transcript) whichever the mux listed first.
 *  Two panes carrying DIFFERENT agents and reporting the same new id is a
 *  genuine tie, broken by list order. */
function agentForUnknown(sessionId: string, tick: Tick): string {
  const memo = tick.agentOfUnknown.get(sessionId);
  if (memo) return memo;
  let chosen: string | null = null;
  for (const h of tick.handlesOf.get(sessionId) ?? []) {
    const carried = carriedAgentOf(h, tick);
    if (carried && !liveElsewhere(carried.agentId, h, tick)) { chosen = carried.agentId; break; }
  }
  const agentId = chosen ?? freshAgentId();
  if (!chosen) tick.minted.add(agentId);
  tick.agentOfUnknown.set(sessionId, agentId);
  return agentId;
}

/** THE RULE. Pure over the maps it reads (index, bindings) and the tick
 *  snapshot; the caller applies the answer. */
export function resolvePane(a: MuxAgentInfo, ev: PaneEvidence, tick: Tick): Resolution {
  const carried = carriedAgentOf(a.handle, tick);
  const boundAgent = carried?.agentId ?? null;
  const boundHow: Resolution["how"] = carried?.how ?? "binding";
  const sessionId = tick.idOf.get(a.handle) ?? null;
  if (sessionId) {
    // rule 1: the link names the agent unless that agent is running in
    // another pane this tick (then this id is a fork of it: a new agent)
    const from = ev.link?.from;
    const linked = from ? sessionIndex.get(from) : undefined;
    if (linked && !agentMetas.get(linked)?.mergedInto && !liveElsewhere(linked, a.handle, tick)) {
      return { agentId: linked, sessionId, how: "link" };
    }
    const known = sessionIndex.get(sessionId);
    if (known) return { agentId: known, sessionId, how: "index" };
    /* IDENTITY ARRIVES ONTO A PRE-BOUND PANE. An ANNOUNCED id the index does
     * not know, on a pane the engine pre-minted (/new-session) or parked but
     * that never captured an id, reclaims THAT agent rather than minting a
     * stranger -- even when the pane blinked out of the snapshot in between and
     * its binding went dead (a node-launched pi herdr is slow to stamp; the
     * pre-mint row is purged on the empty tick but its pending binding is kept
     * for this). Announced only: a folder guess is not identity, so it waits out
     * the announce grace and never rides this, keeping the transient-transcript
     * fence. The live-elsewhere guard keeps it from stealing an agent running in
     * another pane. Established sessions are excluded by pendingBoundAgentOf
     * (their binding carries an id), so the dead-binding fence is untouched. */
    if (ev.announced) {
      const pending = pendingBoundAgentOf(a.handle, tick);
      if (pending && !liveElsewhere(pending, a.handle, tick)) {
        return { agentId: pending, sessionId, how: "pane-continuity" };
      }
    }
    // rule 3: an unknown id joins the agent a pane reporting it carries,
    // only while none of that agent's ids is live in another pane this tick;
    // otherwise the id is a new agent and the pane running the agent's own
    // id keeps its row
    const agentId = agentForUnknown(sessionId, tick);
    const how: Resolution["how"] = tick.minted.has(agentId) ? "new"
      : agentId === boundAgent ? "pane-continuity" : "index";
    return { agentId, sessionId, how };
  }
  if (ev.premintId) return { agentId: ev.premintId, sessionId: null, how: "premint" };
  if (boundAgent) return { agentId: boundAgent, sessionId: null, how: boundHow };
  return { agentId: freshAgentId(), sessionId: null, how: "provisional" };
}

/** A row for an agent that has no live pane: the chat log on disk is the
 *  conversation, greyed out, resumable from its row. */
function deadRow(meta: AgentMeta, chat: Session["chat"], log: Session["log"], order: number, d: ReconcileDeps): Session {
  const harness = meta.harness ?? "claude";
  const id = meta.agentId;
  return {
    id, agentId: id, muxHandle: "", name: nameFromCwd(meta.cwd), cwd: meta.cwd ?? "",
    ws: null, alive: false, busy: false /* deriveBusy("unknown", false): a dead row is never busy */, viaMux: true, agent: agentLabel(harness),
    hasTranscript: d.hasTranscript(harness), agentSession: null,
    harnessSessionId: meta.sessionId,
    status: "unknown", workspace: "", tab: null, displayAgent: null, stateChangeSeq: 0,
    turnSince: turnSinceFor(undefined, "unknown", chat.at(-1)?.ts, d.now),
    doneSeq: restoredSeenOf(id)?.doneSeq ?? 0, seenDoneSeq: restoredSeenOf(id)?.seenDoneSeq ?? 0,
    heardTs: heardTsFor(undefined, id),
    notified: restoredNotifiedOf(id) ?? false, filedTs: restoredFiledOf(id) ?? 0,
    order, chat, log, channels: [],
  };
}
function nameFromCwd(cwd: string | undefined): string {
  if (!cwd) return "";
  const parts = cwd.split("/").filter(Boolean);
  return parts.at(-1) ?? cwd;
}

export function makeReconcile(d: ReconcileDeps): (agents: MuxAgentInfo[]) => void {
  return (agents) => {
  const now = (d.now ?? Date.now)();
  const live = new Set(agents.map((a) => a.handle));
  for (const h of [...firstSeen.keys()]) if (!live.has(h)) firstSeen.delete(h);
  for (const a of agents) if (!firstSeen.has(a.handle)) firstSeen.set(a.handle, now);

  // the whole tick's evidence first, then the panes one by one: a pane's
  // answer must not depend on where the mux listed it
  const evs = agents.map(evidenceOf);
  const tick = tickOf(agents, evs, now);
  const rs = agents.map((a, i) => resolvePane(a, evs[i]!, tick));
  /* The same agent claimed by two panes gets ONE row (claude interleaves both
   * into one transcript). The pane that REPORTED a session id keeps it over a
   * pane that has none (a silent pane resolves to the agent through its
   * binding or its row, which is not evidence that the agent runs there), and
   * the pane whose own continuity named the agent over one that merely
   * reports the same id; between equals, the first the mux listed. Decided
   * over the whole tick before any row is rebuilt, so the mux's order cannot
   * pick the holder when the evidence can. */
  const claim = (r: Resolution) => (r.sessionId ? 2 : 0) + (r.how === "pane-continuity" || r.how === "link" ? 1 : 0);
  const holder = new Map<string, number>();
  rs.forEach((r, i) => {
    const j = holder.get(r.agentId);
    if (j === undefined || claim(r) > claim(rs[j]!)) holder.set(r.agentId, i);
  });
  /* FOLD EACH PROVISIONAL INTO THE AGENT IT TURNED OUT TO BE, before any row
   * is rebuilt and INDEPENDENT of the single-row holder election above. A pane
   * the engine had to key by a provisional agent (no announce yet) that now
   * resolves to a DIFFERENT agent folds its rows into that agent, once. This
   * runs for the provisional's OWN handle whether or not that handle wins the
   * holder election: when the survivor is already live in ANOTHER pane this
   * tick, the survivor's own pane can win the election, and gating the absorb
   * on holdership left the provisional orphaned as a dead ghost with no
   * `mergedInto` that a reload does not fix (merge-ghost-race.test.ts). A
   * provisional is not a real second session, only a placeholder resolving to
   * the same one, so it must absorb even into an agent that is live elsewhere.
   * Only a PROVISIONAL (meta.sessionId === null, never its own chat/announce)
   * is ever absorbed: an ESTABLISHED pane that announces another live agent's
   * id simply loses its pane (it goes dead below) and chats never merge, which
   * keeps the "live elsewhere" steal protection intact (case a). Each
   * provisional sits on exactly one handle, so this folds it at most once. */
  rs.forEach((r, i) => {
    const onHandleId = tick.rowOn.get(agents[i]!.handle);
    const onHandle = onHandleId ? sessions.get(onHandleId) : undefined;
    if (onHandle && onHandle.id !== r.agentId) {
      const pm = agentMetas.get(onHandle.id);
      if (pm && pm.sessionId === null) absorb(onHandle, r.agentId);
    }
  });
  const seen = new Set<string>();
  agents.forEach((a, i) => {
    const ev = evs[i]!;
    const r = rs[i]!;
    if (holder.get(r.agentId) !== i) return;
    const key = r.agentId;
    seen.add(key);
    const meta = metaFor(key);
    const prev = sessions.get(key);
    /* The CLAUDE JSONL TAIL KEY the row answered to LAST tick, read BEFORE
     * adoptSession: it rewrites harnessSessionId on this same live row
     * (carry.ts), so reading the id after it would compare the new id to itself
     * and the rotation tick would rotate nothing: the old tail stayed on the old
     * file, and the backlog and the transcript's verdict rode into the new one
     * (rollover-tail.test.ts). Derived from the agent kind, not a second id
     * field: non-claude has no jsonl tail here, so its key is
     * null and its id roll never trips this claude-only rotation. */
    const prevClaudeTailId = prev && prev.agent.id === "claude" ? prev.harnessSessionId : null;
    let rollover: string | null = null;
    if (r.sessionId && adoptSession(key, r.sessionId)) {
      // the agent had a session id and now answers to another: a rollover.
      // The harness's own word for it when it gave one (clear, fork, resume,
      // compact); otherwise what the evidence was: a past id come back
      // (resume) or a fresh id in the agent's own pane (rollover)
      rollover = ev.link?.kind ?? (r.how === "index" ? "resume" : "rollover");
    }
    if (r.how === "new" || r.how === "provisional" || (r.how !== "live" && !prev)) {
      console.log(`[session] ${a.handle} -> ${key} (${r.how}` +
        `${r.sessionId ? `, session ${r.sessionId}` : ""}${ev.link ? `, link ${ev.link.kind}` : ""})`);
    }
    const harnessSessionId = meta.sessionId;
    // the claude jsonl tail key for this pane: claude's own id, null otherwise
    // (the old claudeSessionId field, derived in place).
    const claudeTailId = a.kind === "claude" ? harnessSessionId : null;
    // a rolled harness session (new transcript file): drop the old tail
    // watch; syncIngest below re-resolves against the new file. Compared
    // against the pre-adopt id (above), never prev's live field.
    const rotated = !prev || prevClaudeTailId !== claudeTailId;
    if (prev && rotated) stopIngest(key, "session rotated");
    /* THE STATUS PRECEDENCE (thinking indicator #490, done synthesis
     * #doneParity) is the ONE rule table in status-reducer.ts. This is the mux
     * observation: herdr's hint folded against the carried transcript verdict
     * (prev.jsonlStatus, the outlive-the-poll seam), the tmux-parity nativeDone
     * seam, and rotation. The reducer returns the new status and the new carry;
     * the caller keeps every side effect below. See status-reducer.ts for the
     * full precedence (the thinking-7m rule, tmux-only done synthesis, and the
     * rotated/blocked carry drop). */
    const { status, jsonlStatus } = reduceStatus(
      { status: prev?.status ?? "unknown", jsonlStatus: prev?.jsonlStatus },
      { source: "mux", hint: a.statusHint, nativeDone: d.nativeDone, rotated },
    );
    /* Every status change this rebuild makes is logged like a jsonl edge, so
     * engine.log shows who moved the row: a jsonl edge whose `from` is not
     * what the last logged edge left is otherwise unexplained. */
    if (prev && prev.status !== status) {
      d.log?.("status.edge", { session: key, pane: a.handle, from: prev.status, to: status, source: "mux" });
    }
    const s: Session = {
      id: key,
      agentId: key,
      muxHandle: a.handle, // adopt whatever pane is live for this agent now
      name: a.title,
      cwd: a.cwd,
      ws: prev?.ws ?? null,
      alive: true,
      busy: deriveBusy(status, true), // the one busy rule (status-reducer.ts)
      viaMux: true,
      // The wire label for this pane's agent, resolved from the mux stamp. Every
      // row has one; an unknown agent gets its normalized id and a capitalised
      // name. Capabilities live in the mux's reader table, not here.
      agent: agentLabel(a.kind),
      // Whether the mux has a transcript reader for this kind: the old
      // `agent.transcript !== null` gate, resolved once here at rebuild.
      hasTranscript: d.hasTranscript(a.kind),
      agentSession: a.agentSession,
      harnessSessionId,
      status,
      jsonlStatus,
      workspace: a.workspace,
      tab: a.tab,
      displayAgent: a.displayAgent,
      stateChangeSeq: a.stateChangeSeq,
      // When the CURRENT turn began: working since the prompt went in, idle
      // since the reply landed. Stamped on the edge rather than parsed out of
      // the transcript every minute, so it costs nothing and cannot drift.
      // The client renders and ticks it; we only ever send the instant.
      // restoredChats still holds this agent's log here (it is deleted below,
      // after this object is built): on the first poll after a restart `prev`
      // is undefined, so the seed comes from the newest stored message rather
      // than from now(), and the row keeps its real age across the restart.
      turnSince: turnSinceFor(prev, status, restoredChats.get(key)?.at(-1)?.ts, () => now),
      // ENTERING done is the "something new happened" edge, and only we get to
      // decide what is new here.
      //
      // A pane can sit in herdr's done state for hours; that is herdr's unread,
      // not ours. Counting the first snapshot as an edge meant every restart of
      // this engine re-lit the blue dot on every finished pane at once, as if
      // all of it had happened while you were away. So a bump needs a PREVIOUS
      // observation to be an edge against, and a pane we have never seen starts
      // level: whatever herdr thinks, this app has nothing unread on it yet.
      /* doneSeqFor keys on statusHint. herdr's is its native done, so herdr
       * passes `a` unchanged. tmux's raw statusHint is only ever idle, so the
       * SYNTHESIZED status (which carries `done`) is fed in its place, or the
       * bump would never fire. Same for seenDoneSeq's first-sight seeding. */
      doneSeq: doneSeqFor(prev, d.nativeDone ? a : { handle: a.handle, statusHint: status }, restoredSeenOf(key)),
      seenDoneSeq: seenDoneSeqFor(prev, d.nativeDone ? a : { handle: a.handle, statusHint: status }, restoredSeenOf(key)),
      /* A pane this engine is meeting for the first time starts LEVEL, exactly
       * as doneSeq does above and for the same reason: whatever is already in
       * the restored log happened before this process existed, and counting all
       * of it would light every row on every restart. A marker we persisted
       * wins over that; only the absence of one falls back to "everything here
       * is already read".
       *
       * THE FALLBACK IS A ONE-TIME EVENT AND IT MUST STAY THAT WAY. It fires
       * for every session on the first boot after this change, marking the
       * fleet read once, which is a deliberate and acceptable cost. It must not
       * fire twice, so heardTsFor persists what it decided immediately (below):
       * a marker that only reached the file once something was read would leave
       * a session with unread waiting unpersisted, and the next restart would
       * take the fallback again and eat the backlog. */
      heardTs: heardTsFor(prev, key),
      /* Persisted like the marker, and for the same reason: a restart that
       * forgot it would push again for a notification already sitting on the
       * phone, and would never send the dismissal that takes it down. */
      notified: prev?.notified ?? restoredNotifiedOf(key) ?? false,
      // ...and so is how far he had filed it: see restoredFiledTs
      filedTs: prev?.filedTs ?? restoredFiledOf(key) ?? 0,
      order: i, // agents arrive in herdr's "spaces" order
      chat: prev?.chat ?? restoredChats.get(key) ?? [],
      /* THE SESSION RECORDS travel with the chat: the same log, the same seq
       * axis, owned by the live row from here (chat/ingest.ts appends to it).
       * A rotation does not drop them: the records are the engine's own copy,
       * not a reading of the old transcript (design A.3). */
      log: prev?.log ?? restoredLogs.get(key) ?? [],
      recentSrc: prev?.recentSrc,
      recentFacts: prev?.recentFacts,
      // declared by the MCP at register time, not by herdr: a pane snapshot
      // must not forget what its voice-out socket already told us
      channels: prev?.channels ?? [],
      // carry the reply-routing origin across the rebuild: this callback
      // fires the moment the pane flips to working, i.e. right between the
      // utterance and its speak, and dropping it made every device play
      lastOrigin: prev?.lastOrigin,
      // carry the idempotency index across the rebuild (#505): this callback
      // mints a fresh Session on every herdr poll, and dropping it would empty
      // the dedupe window seconds after each poll -- right inside the retry gap
      // it exists to cover. Undefined for a cold session; lazy-built from chat.
      recentKeys: prev?.recentKeys,
      /* And the in-flight reservations that close the TTS-window race (#576): a
       * poll can land between a same-key delivery's reservation and its commit,
       * and a fresh Session without them would let the concurrent retry write a
       * second row. Same lifetime as recentKeys, carried the same way. */
      inflightKeys: prev?.inflightKeys,
      // The user-cid dedupe (section 2b), same lifetime, carried the same way.
      recentCids: prev?.recentCids,
      inflightCids: prev?.inflightCids,
    };
    sessions.set(key, s);
    restoredChats.delete(key); // owned by the live session now
    restoredLogs.delete(key);
    // the edge the log line above reported, as a record in the agent's own log
    if (prev && prev.status !== status) {
      logSession(s, { ts: now, kind: "status", text: `status: ${status}`, status });
    }
    /* THE ROLLOVER DIVIDER: the harness rolled its session (/clear, fork, a
     * resume of another id) and the agent kept its row; one system line says
     * so, in the log like every engine-authored line (E7).
     *
     * The chat pill is painted ONLY for a genuinely user-meaningful
     * conversation reset: `clear` (the user wiped the conversation) and `fork`
     * (the user branched it) -- for those the divider is real information.
     * Every same-conversation continuation (compact, resume, rollover, parent,
     * startup) is machine churn and gets NO pill (owner call 2026-09-08, "this
     * is not needed"): a claude compact re-announces the pane twice in quick
     * succession ("link compact" then plain), so ONE compact minted TWO pills,
     * and the compact already paints its own "Conversation compacted" session
     * event while identity and history carry automatically. The console.log
     * below stays for ALL kinds so diagnostics are unaffected. */
    if (rollover) {
      if (rollover === "clear" || rollover === "fork") {
        noticeChat(s, `new session (${rollover})`, "system");
      }
      console.log(`[session] ${key} rolled to ${harnessSessionId} (${rollover})`);
    }
    // Remember which agent this handle hosts, and that it is alive: the
    // continuity an unannounced pane keeps across an engine restart.
    recordBinding(a.handle, { agentId: key, sessionId: harnessSessionId, cwd: a.cwd });
    /* No boot-time cron seeding any more: the crons plugin seeds its
     * disabled examples on the first panel list of a fresh agent. */
    // a non-claude transcript (codex/opencode/pi) is read through the mux by
    // handle, so its first reading is asked for here rather than left to the poll.
    // The claude jsonl id (claudeTailId) is null for every non-claude pane and
    // for a claude pane that has not minted its uuid yet; either way its first
    // read is the mux-by-handle one (refreshContext no-ops without a claude path).
    if (!claudeTailId && s.hasTranscript) {
      void refreshContext(s).then((changed) => { if (changed) d.broadcastSessions(); });
    }
  });
  /* EVERY AGENT WITH A CONVERSATION ON DISK IS A ROW, live pane or not
   * (TODOS.md dead-session visibility): a history-only agent lists greyed out
   * so its chat can be read and resumed from its row. An empty meta (a session
   * id and nothing said) has nothing to show and gets no row. */
  let order = agents.length;
  for (const meta of agentMetas.values()) {
    if (sessions.has(meta.agentId)) continue;
    const chat = restoredChats.get(meta.agentId);
    if (!chat?.length) continue;
    sessions.set(meta.agentId, deadRow(meta, chat, restoredLogs.get(meta.agentId) ?? [], order++, d));
    restoredChats.delete(meta.agentId);
    restoredLogs.delete(meta.agentId);
  }
  // `seen` holds agent ids, so a row dies only when no live pane resolves to
  // its agent. A restart (new pane, same session id) re-attaches above through
  // the index and never reaches here.
  for (const s of sessions.values()) {
    if (s.viaMux && !seen.has(s.id)) {
      if (s.muxHandle) markBindingDead(s.muxHandle);
      s.alive = false;
      s.busy = deriveBusy(s.status, false); // dead: never busy (status-reducer.ts)
      s.status = "unknown"; // a gone pane has no detectable state
      s.displayAgent = null; // a frozen timer stamp would mislead
      /* A closed pane that never said anything is not a conversation.
       *
       * A dead session is deliberately KEPT so its transcript survives the
       * pane: you close a tab, the chat greys out, the history is still there.
       * But a session with an empty log has nothing to survive, so keeping it
       * only adds a permanent grey row nobody can dismiss. Eighteen of them
       * arrived at once from a batch of throwaway test sessions, which is how
       * this came up. */
      if (s.chat.length === 0) {
        sessions.delete(s.id);
        // Stop first, so a late drain cannot append to a purged row.
        stopIngest(s.id, "session gone");
        /* THE 4d PURGE: one record delete in session-state, plus each
         * companion module purging its own pane-keyed state (asks here, the
         * delivery queue and the unsubmitted memory below). session-
         * companions.ts is gone. */
        /* THE PANE-BINDING SURVIVES A PRE-MINT/PROVISIONAL PURGE, dead. A pane
         * the engine pre-minted (/new-session's adoptAgentId) or parked never
         * captured a harness id, so its binding carries sessionId === null --
         * the "identity still pending" marker. A node-launched pi blinks out of
         * herdr's stamped snapshot for a beat and this purge fires on the empty
         * pre-mint row; deleting the binding too would strand the pre-minted
         * agent id, and the late /harness/announce would then mint a stranger,
         * orphaning the id /new-session handed the app (resume: "never seen a
         * session id"). Kept (dead), the binding lets resolvePane reclaim THAT
         * agent when the announce lands (the reclaim is announced-only, so a
         * folder guess never rides it, and an ESTABLISHED binding carries an id,
         * so its dead binding still never rejoins). */
        const idPending = agentMetas.get(s.id)?.sessionId == null;
        purgeSessionState(s.id, idPending ? undefined : (s.muxHandle || undefined));
        asks.delete(s.muxHandle);
        askCommitted.delete(s.muxHandle);
        utterQueue.delete(s.id);
        unsubmitted.delete(s.muxHandle);
        const meta = agentMetas.get(s.id);
        if (meta && meta.sessionId === null && !meta.chat) {
          agentMetas.delete(s.id); // a provisional that never reached disk leaves nothing
          for (const [sid, aid] of sessionIndex) if (aid === s.id) sessionIndex.delete(sid);
        } else {
          scheduleAgentSave(s.id); // one meta write carries every purged field
        }
        savePaneBindings();
        console.log(`[session] - ${s.id} (pane gone, nothing was said)`);
      }
    }
  }
  /* Keep the held question in step with the status it belongs to.
   *
   * A pane that STOPPED being blocked must lose its question in the same beat
   * as the status, before broadcastSessions goes out: a leftover entry is how a
   * chat ends up offering buttons for a prompt that was answered in the
   * terminal thirty seconds ago. A pane that just BECAME blocked gets read at
   * once rather than waiting for the poll, because the whole point is that he
   * finds out without opening anything. */
  for (const s of sessions.values()) {
    if (s.alive && s.status === "blocked" && d.canParseScreen(s.muxHandle)) {
      /* Read on arrival, and read again if what we hold has gone stale. It used
       * to be "only if we have never read this pane", which left a prompt that
       * was REPLACED without the status leaving `blocked` showing the previous
       * question until the next poll tick. Skipped for a null-dialogs agent: its
       * blocked row is answered without a screen read (askOf, askWhy "unsupported"). */
      const held = asks.get(s.muxHandle);
      if (!held || Date.now() - held.at > ASK_POLL_MS) void refreshAsk(s.muxHandle);
    } else {
      asks.delete(s.muxHandle);
    }
  }
  syncIngest(); // also retries ingests that failed on a missing file
  syncStatusTails(); // thinking-indicator tails: one per live session (#490)
  d.sweepTails(); // close watchers whose session has been dead+quiet (#589)
  d.broadcastSessions();
  };
}
