/* THE FOREIGN-STEAL GUARD (defense in depth; the 2026-09-18 aiusage-grok bug).
 *
 * A witness-placed announce (hook-announce.ts) carries a session id onto a pane
 * named only by an inherited HERDR_PANE_ID / TMUX_PANE. That is legitimate for
 * the pane's OWN harness rolling its session, and it is a theft when the id
 * belongs to a THIRD PARTY: a grok/codex/cursor claude-compat layer ran
 * claude's SessionStart hook inside its own session and POSTed that id with the
 * stale herdr pane it inherited. The steal rolls the pane's live claude binding
 * to a session whose transcript does not exist, and the sessions frame
 * broadcasts null ctx/model until the real claude re-announces (the "Ctx n/a"
 * flap that recurs every 10-20 min).
 *
 * This is the engine half of the fix. The hook (announce-session.py) already
 * stays silent under a foreign harness; this guard makes a foreign announce
 * that reaches the engine by any other route unable to steal a LIVE binding.
 *
 * It refuses ONLY the genuinely foreign case, so real rollovers are untouched:
 *   - a claude /clear, /compact or plain rollover re-announces from the pane's
 *     OWN process, so the announcing agent pid EQUALS the pid on the current
 *     bind: not foreign, allowed (reconcile then rolls it as today).
 *   - a --resume/reopen comes from a fresh process but names an id the agent
 *     already knows (current, past or proven lineage): not foreign, allowed.
 *   - a pane with no live session, or an id the agent knows, or the pane's own
 *     process: all pass, so pre-mint adoption, re-announce after an engine
 *     restart and the never-announced fallback are all left alone.
 * Only a DIFFERENT live process announcing an id UNKNOWN to the agent that is
 * live on the pane is refused.
 *
 *   bun test agent-engine/src/sessions/foreign-guard.test.ts
 */

import { agentMetas, bindingOf, sessions, sessionIndex } from "./session-state.ts";
import { lineageOf } from "./lineage.ts";
import type { LiveBindGuard } from "../terminal/hook-announce.ts";

/** True when `sessionId` is one this agent already answers to or came from:
 *  its current id, a past id (a --resume), a proven predecessor (lineage), or
 *  an id the index already maps to this same agent. Such an id is a genuine
 *  rollover/resume, never a foreign steal. */
function idKnownToAgent(agentId: string, sessionId: string): boolean {
  const meta = agentMetas.get(agentId);
  if (meta?.sessionId === sessionId) return true;
  if ((meta?.pastSessions ?? []).includes(sessionId)) return true;
  if ((lineageOf(agentId) ?? []).includes(sessionId)) return true;
  return sessionIndex.get(sessionId) === agentId;
}

/** The wired guard: refuse a witness placement that would steal a live binding.
 *  Returns a reason (refuse) or null (allow). Pure over the session-state maps
 *  it reads. */
export const liveBindGuard: LiveBindGuard = (handle, incoming, current) => {
  // the pane's OWN process re-announcing (a claude /clear, /compact, plain
  // rollover): same agent pid, always the pane's own tree, allowed.
  if (incoming.pid === current.pid) return null;
  const bound = bindingOf(handle);
  if (!bound) return null; // no engine binding on the pane: nothing to protect
  const row = sessions.get(bound.agentId);
  if (!row?.alive) return null; // the pane's session is not live: a legit takeover
  // a resume/reopen from a fresh process that names an id the agent already
  // knows is a genuine rollover, not a steal.
  if (idKnownToAgent(bound.agentId, incoming.sessionId)) return null;
  // a DIFFERENT live process announcing an id UNKNOWN to the agent that is live
  // on this pane: a third party. Refuse and keep the live bind.
  return { reason: `pane holds live session ${current.sessionId} (pid ${current.pid}); announced id unknown to it` };
};
