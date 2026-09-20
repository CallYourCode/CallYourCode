/* THE ID GRAMMARS, in one place. Three kinds of id cross the engine and only
 * one of them may ever name a conversation:
 *
 *   agent id      `ag-` + 16 base64url chars: the engine's own, the key of
 *                 everything (agents/<agentId>/, the wire, the bindings).
 *   harness id    what the coding agent calls its session: a UUID (claude,
 *                 pi, codex's UUIDv7) or opencode's `ses_` + alphanumerics.
 *                 The ONLY shape meta.json's sessionId/pastSessions/lineage,
 *                 the boot session index and a pane's reconcile evidence
 *                 accept. Anything else the mux reports for a pane is not a
 *                 session id, whatever field it arrived in.
 *   pane id       where a harness runs: herdr's `w<ws>:p<pane>`, tmux's `%N`
 *                 (bare, or `%N~pid~epoch` as the engine keys it), either with
 *                 a `herdr:`/`tmux:` mux prefix. Never an identity: v1 keyed
 *                 a pane that had announced nothing yet by its pane id, and
 *                 the boot carry let those leak into metas (57 current, 52
 *                 past and 2 lineage ids in the 2026-09-02 survey; defect B/C).
 *
 * The gate is POSITIVE (a harness shape passes, everything else fails), not
 * "not pane-shaped": a grammar that lists what to refuse admits the next
 * leak. isPaneShapedId exists so a log line can say what it dropped.
 */

/* Any UUID version passes: the point is to tell a harness id from a pane id,
 * not to validate the harness. */
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/* opencode (and codex's `ses_` spelling): `ses_` + 20..40 alphanumerics. */
export const SES_RE = /^ses_[A-Za-z0-9]{20,40}$/;

/* The engine's own agent id (mintAgentId in agentmeta.ts). */
export const AGENT_ID_RE = /^ag-[A-Za-z0-9_-]{16}$/;

/* The pane shapes. herdr's public pane id is `w<ws>:p<pane>` (the ws and pane
 * parts are base36-ish tokens: "w7:p1", "w9:p1G", "wD:p1"); tmux's is `%N`,
 * which the engine keys as `%N~pid~epoch` (tmux.ts PANE_KEY_RE). Either may
 * arrive with its mux prefix ("herdr:w7:p1", "tmux:%3"). */
export const HERDR_PANE_RE = /^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/;
export const TMUX_PANE_RE = /^%\d+(~\d+~\d+)?$/;
const MUX_PREFIX_RE = /^(herdr|tmux):/;

/** A harness session id: the only shape that may name a conversation. */
export function isHarnessSessionId(id: unknown): id is string {
  return typeof id === "string" && (UUID_RE.test(id) || SES_RE.test(id));
}

/** A mux pane handle, prefixed or bare. For logging what was refused; the
 *  gates above never consult it. */
export function isPaneShapedId(id: unknown): boolean {
  if (typeof id !== "string") return false;
  const bare = id.replace(MUX_PREFIX_RE, "");
  return HERDR_PANE_RE.test(bare) || TMUX_PANE_RE.test(bare) || /^%\d+/.test(bare);
}

/** The engine's own agent id shape. */
export function isAgentId(id: unknown): id is string {
  return typeof id === "string" && AGENT_ID_RE.test(id);
}

/* What POST /harness/announce accepts as a session id: the charset a session
 * FILE name can carry (it becomes a transcript lookup key), 6..128 chars. A
 * pane id never passes it (":" , "%" and "~" are outside the charset); a
 * harness id always does. Kept looser than isHarnessSessionId on purpose: the
 * announce is the harness naming ITSELF, and a new harness's spelling must
 * reach the log rather than vanish at the door. */
export const ANNOUNCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/;
