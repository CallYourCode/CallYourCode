/* THE REPLY TRACE (L3, blueprint row 26): the Stop hook's evidence.
 *
 * The dials store is the plugin's own (plugins/reply-dials/index.ts); this module
 * keeps only what a DUMB Stop hook needs: the ReplyTrace (a message went out,
 * and something came back) and the hook state file the hook reads from inside
 * the agent's process tree. It holds no verbosity opinion at all: which channel
 * a level wants, and whether the reply matched it, dissolved with the old
 * dials-seam. The hook now asks one question -- did ANY reply come back after
 * the message went out -- so nothing here records a level or a channel.
 *
 * Append-only, capped, and nobody clears the trace: the hook decides for
 * itself how far it has judged. An engine restart loses the outstanding
 * deliveries, and that direction is deliberate: the hook then has nothing to
 * enforce and allows the stop.
 *
 *   bun test agent-engine/src/security/injection.test.ts agent-engine/src/plugins/dials.test.ts
 */

import { stateFile } from "../storage/datadir.ts";
import { writePrivate } from "../../../shared/runfiles.ts";

export type ReplyTraceDeps = {
  sessions(): Iterable<{ id: string; cwd: string; agent: { id: string }; harnessSessionId: string | null; muxHandle?: string | null }>;
  engineHost: string;
  /** Whether this agent kind's reader declares an activity-event source (the
   *  adapter's hasSessionEvents): the hook-state's session-id field is derived
   *  from it, same rule as the sessions frame. */
  hasSessionEvents(kind: string): boolean;
};

let cfg: ReplyTraceDeps | null = null;
export function initReplyTrace(d: ReplyTraceDeps): void {
  cfg = d;
}
const C = (): ReplyTraceDeps => {
  if (!cfg) throw new Error("reply-trace not initialised");
  return cfg;
};

/* WHAT TO APPEND to a message is not read here. The text transform is the
 * generalized `inputTransform` hook (platform/core.ts): the reply-dials plugin
 * registers a postfix hook that returns `askFor(channels).instruction`, and the
 * delivery site folds every hook at the one injection point (deliver.ts). This
 * module keeps only the Stop-hook EVIDENCE -- the trace and the hook state file
 * -- which is not a text transform. A delivery records nothing but when it went
 * out and how it was tagged; the hook needs no more than that. */

export type ReplyDelivery = { ts: number; how: string };
type ReplyTrace = {
  deliveries: ReplyDelivery[];
  replies: Array<{ ts: number }>;
};
const REPLY_TRACE_KEEP = 12; // a Stop only ever looks at the outstanding tail
const replyTrace = new Map<string, ReplyTrace>();

function traceOf(sessionId: string): ReplyTrace {
  let t = replyTrace.get(sessionId);
  if (!t) replyTrace.set(sessionId, (t = { deliveries: [], replies: [] }));
  return t;
}

/* A message went to the pane. Recorded BEFORE it is typed, so the hook can
 * never be asked about a delivery it has not been told about. Returns the entry
 * so a delivery that then FAILS can be taken back. */
export function noteDelivery(sessionId: string, how: string): ReplyDelivery {
  const t = traceOf(sessionId);
  const entry: ReplyDelivery = { ts: Date.now(), how };
  t.deliveries.push(entry);
  if (t.deliveries.length > REPLY_TRACE_KEEP) t.deliveries.shift();
  return entry;
}

export function forgetDelivery(sessionId: string, entry: ReplyDelivery) {
  const t = traceOf(sessionId);
  const at = t.deliveries.indexOf(entry);
  if (at >= 0) t.deliveries.splice(at, 1);
}

/* Something reached the user. Every output channel counts the same -- an MCP
 * reply is an MCP reply -- so which one it was is not recorded. Only ever
 * called where the reply really went out. */
export function noteReply(sessionId: string) {
  const t = traceOf(sessionId);
  t.replies.push({ ts: Date.now() });
  if (t.replies.length > REPLY_TRACE_KEEP) t.replies.shift();
  writeHookState();
}

/* The state file itself (hooks/enforce-voice-reply.py reads it). The hook
 * runs inside the agent's own process tree with no socket to the engine, so
 * anything it needs has to be a file. Rewritten on every delivery, every failed
 * retraction and every reply. Missing, unreadable, or a session it cannot find:
 * the hook allows the stop. */
/* RESOLVED PER WRITE, NOT CAPTURED AT IMPORT. It used to be a module-level
 * `const stateFile(...)`, which froze the data dir the moment anything
 * imported this module: an in-process wiring has to point CYC_DATA_DIR at its
 * own tmp tree after the imports have already run, and a frozen path would have
 * sent every hook-state write to the real ~/.callyourcode. A running engine
 * reads the same env var on every call and gets the same path. */
const hookStateFile = (): string => stateFile("reply-state.json");

export function writeHookState() {
  const d = C();
  const perSession: Record<string, unknown> = {};
  const live = new Set<string>();
  for (const s of d.sessions()) {
    live.add(s.id);
    const t = replyTrace.get(s.id);
    perSession[s.id] = {
      // the overlay-capable session id (or null), derived from the one
      // session-id field and the reader's DECLARED activity-event slot, the
      // same rule the sessions frame uses: the hook-state key keeps its name
      // for every reader of this file, and its value is unchanged for claude
      // and for every slotless harness.
      claudeSessionId: d.hasSessionEvents(s.agent.id) ? s.harnessSessionId : null,
      /* The pane this agent is hosted on right now. The entry is keyed by the
       * AGENT id (adapters lane 2), so a hook that only knows its pane
       * (HERDR_PANE_ID / TMUX_PANE) matches on this field, not on the key. */
      pane: s.muxHandle ?? null,
      cwd: s.cwd,
      deliveries: t?.deliveries ?? [],
      replies: t?.replies ?? [],
    };
  }
  for (const id of replyTrace.keys()) if (!live.has(id)) replyTrace.delete(id);
  const body = {
    writtenAt: Date.now(),
    host: d.engineHost,
    sessions: perSession,
  };
  writePrivate(hookStateFile(), JSON.stringify(body, null, 1))
    .catch((e: unknown) => console.error("[hook-state] could not persist:", e));
}

/** TEST ONLY: forget the deps and the outstanding delivery evidence, so a
 *  second in-process wiring starts with the empty trace a fresh engine has.
 *  A restart already loses the trace on purpose (see the header), so this is
 *  the same state production reaches by dying; nothing calls it there. */
export function resetForTest(): void {
  replyTrace.clear();
  cfg = null;
}
