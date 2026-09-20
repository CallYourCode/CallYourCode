/* TMUX JSONL-LINKING, moved out of the mux and behind the identity layer
 * (design Gap 2).
 *
 * tmux has no native session handle, so a pane is linked to "the newest jsonl
 * under its cwd" engine-side. The GUARDS against binding the WRONG jsonl -- the
 * spawn-time / first-seen birth FLOORS, the 571-disease refusal of a
 * pre-existing stranger's transcript, and the sticky handover rule that lets a
 * link move only to a LATER-born jsonl -- used to live INSIDE terminal/tmux.ts,
 * entangling identity inference with the mux. That leak was the recurring
 * folder-collision / uuid-rollover bug source.
 *
 * The seam is now clean: the tmux mux emits only RAW pane facts (TmuxLinkFacts:
 * the pane handle, its detected agent kind and cwd, any candidate transcript it
 * can SEE with that file's birth instant, the engine-spawn premint and its
 * spawn time, the first-seen instant, whether the pane was present at the mux's
 * first enumeration, and the announce bind it observed). This module is the
 * SINGLE identity step that turns those facts into the pane's AgentSessionRef,
 * applying the evidence order the resolver documents:
 *   1. an ANNOUNCED bind (the hook said "session Y") overrides everything, with
 *      no floor and no gate, and retires the guess for the pane;
 *   2. the folder GUESS (newest jsonl), gated by the birth floors and the
 *      ambiguity degrade;
 *   3. the sticky ESTABLISHED link, held against a busier older-born neighbour;
 *   4. the engine-spawn PREMINT, until a transcript supersedes it;
 *   5. a PARKED handle for a never-linked hand-started claude pane;
 *   6. nothing (a non-claude pane the mux cannot locate, or the ambiguous
 *      same-cwd case: degrade, never guess).
 * The ref it returns is byte-for-byte the ref the mux used to emit, so every
 * consumer downstream (the adapter's harnessSessionId lift, evidenceOf,
 * resolvePane) is unchanged: this is a MOVE of the seam, not a redesign.
 *
 * linkPane is a PURE function over (facts, prior link state, now, ambiguous):
 * it returns the ref and the link state to persist for the next poll, and
 * touches no module singleton, so the birth-floor / 571 / handover rules are
 * unit-testable in isolation. TmuxLinker is the thin stateful driver the tmux
 * adapter owns: it keeps one LinkState per live handle, computes the same-cwd
 * ambiguity across the whole pane set, prunes state for panes that left, and
 * calls linkPane once per pane per poll.
 *
 *   bun test agent-engine/src/sessions/tmux-link.test.ts
 */

import { ANNOUNCED_SOURCE, PARKED_SOURCE, type AgentSessionRef, type SessionLink } from "../runtime/agents.ts";
import { mungeCwd } from "../../../shared/claude-projects.ts";

/** The RAW facts the tmux mux emits per agent pane, with NO decision about
 *  which candidate is "the" session. Observation only; the decision is made
 *  here. herdr panes carry none of this (their agent_session is authoritative
 *  and needs no linking step), so `MuxAgent.tmuxLink` is optional. */
export type TmuxLinkFacts = {
  /** the reuse-proof pane key (paneKey); identity keys everything by it */
  handle: string;
  /** the detected agent kind ("claude","codex",...); the folder guess is
   *  claude-only, so a non-claude pane is only ever premint/announced/null */
  agent: string;
  cwd: string;
  /** the announce bind the mux observed for this pane (pid-matched by the
   *  mux's resolveAnnounces); the strongest evidence, applied first */
  announced: { sessionId: string; link?: SessionLink } | null;
  /** the newest claude jsonl the mux could SEE under this cwd, with the file's
   *  birth instant (fs birthtime, else first-sight mtime; null when unstattable).
   *  Only observation: whether it is adopted is decided below. */
  candidate: { sessionId: string; path: string; bornAt: number | null } | null;
  /** the engine-spawn premint ref (PREMINT_SOURCE, id = CYC_AGENT_ID), or null
   *  for a hand-started pane */
  premint: AgentSessionRef | null;
  /** the instant the engine spawned this pane (the premint's adoption floor) */
  spawnAt: number | null;
  /** the instant the mux first enumerated this handle (the hand-started
   *  adoption floor) */
  firstSeenAt: number | null;
  /** was this pane already present at the mux's FIRST enumeration? Such a pane
   *  is exempt from the first-seen floor: an engine restart must re-adopt live
   *  conversations by the plain newest-jsonl rule, and their transcripts
   *  necessarily predate the restart. */
  presentAtFirstEnum: boolean;
};

/** The per-pane memory the linker carries between polls. `linked` is the
 *  ESTABLISHED link and the birth of its jsonl (the sticky-handover floor);
 *  `rejectLogged` dedupes the 571-refusal log line to once per (pane, jsonl).
 *  A pane with neither has no entry. */
export type TmuxLinkState = {
  linked?: { id: string; bornAt: number };
  rejectLogged?: Set<string>;
};

const CLAUDE_LINK_SOURCE = "tmux:claude";

/** THE identity decision for one tmux pane, pure over its inputs. Returns the
 *  ref to emit and the link state to persist (undefined = drop the pane's
 *  state: an announce retires the guess, and a bare parked/unlinked pane has
 *  nothing to remember). `log` is the mux's own change-log writer; it fires
 *  only on the 571 refusal and the sticky handover, exactly as before. */
export function linkPane(
  f: TmuxLinkFacts,
  prior: TmuxLinkState | undefined,
  now: number,
  ambiguous: boolean,
  log: (line: string) => void = () => {},
): { ref: AgentSessionRef | null; state: TmuxLinkState | undefined } {
  /* (i) an ANNOUNCED bind: authoritative. It overrides the premint, the parked
   * handle and any guess immediately, with no floor and no quiet gate, and it
   * retires the guess (the dropped link state) for this pane. */
  if (f.announced) {
    const ref: AgentSessionRef = {
      id: f.announced.sessionId, kind: "id", source: ANNOUNCED_SOURCE,
      ...(f.announced.link ? { link: f.announced.link } : {}),
    };
    return { ref, state: undefined };
  }

  const isClaude = f.agent === "claude";
  // the folder guess is claude-only, and the ambiguous same-cwd case degrades
  // rather than guessing (two panes cannot be told apart by "newest")
  let located = isClaude && !ambiguous ? f.candidate : null;
  const current = prior?.linked ?? null;
  let state = prior;

  /* THE BIRTH FLOOR (the 571 guards). The link's birth is a floor: an
   * already-linked pane hands over only to a jsonl born at or after its current
   * link's birth; a pre-linked (engine-spawn) pane, only to one born at or
   * after its spawn; a hand-started pane that appeared mid-run, only to one
   * born at or after the poll first saw it. A pane present at the first
   * enumeration takes its first link by the plain newest-jsonl restart rule
   * (floor undefined). The cwd often holds OTHER sessions' transcripts whose
   * mtime keeps moving; "newest in the dir" without the floor adopts one of
   * those and flips the pane's identity. A genuine roll writes a FRESH file, so
   * it always clears the floor. */
  const floor = current ? current.bornAt
    : f.premint ? f.spawnAt ?? undefined
    : f.presentAtFirstEnum ? undefined
    : f.firstSeenAt ?? undefined;

  if (located && floor !== undefined && located.sessionId !== current?.id) {
    const held = current ? current.id : f.premint ? "pre-mint" : "parked";
    const floorName = current ? "the link" : f.premint ? "spawn" : "first-seen";
    const born = located.bornAt;
    if (born === null || born < floor) {
      const rejectKey = `${f.handle}:${located.sessionId}`;
      const logged = prior?.rejectLogged ?? new Set<string>();
      if (!logged.has(rejectKey)) {
        logged.add(rejectKey);
        log(`[tmux] ${f.handle} keeping ${held}; ` +
          `newest jsonl ${located.sessionId} predates ${floorName}`);
      }
      state = { ...(prior ?? {}), rejectLogged: logged };
      located = null;
    } else {
      log(`[tmux] ${f.handle} handover ${held} -> ` +
        `${located.sessionId} (jsonl born after ${floorName})`);
    }
  }

  /* Transcript discovery supersedes the premint: once a (post-floor) jsonl
   * exists the link is the harness's own session id. The accepted link is
   * remembered with its birth so the next poll's locate cannot override it
   * (only a later-born jsonl can). */
  if (located && located.sessionId !== current?.id) {
    state = { linked: { id: located.sessionId, bornAt: located.bornAt ?? now },
      ...(prior?.rejectLogged ? { rejectLogged: prior.rejectLogged } : {}) };
  }

  /* THE EMITTED REF, strongest first: the freshly located link, the sticky
   * established link, the engine-spawn premint, then a parked handle for a
   * never-linked hand-started claude pane (the ambiguous case and every
   * non-claude pane without a premint stay null: degrade, never guess). */
  const ref: AgentSessionRef | null =
    located ? { id: located.sessionId, kind: "id", source: CLAUDE_LINK_SOURCE }
    : current ? { id: current.id, kind: "id", source: CLAUDE_LINK_SOURCE }
    : f.premint
    ?? (isClaude && !ambiguous ? { id: f.handle, kind: "id", source: PARKED_SOURCE } : null);

  return { ref, state };
}

/** The thin STATEFUL driver the tmux adapter owns: one LinkState per live
 *  handle, the same-cwd ambiguity computed across the whole pane set, and
 *  linkPane called once per pane per poll. It holds no other state, so the
 *  identity rules stay in the pure function above. */
export class TmuxLinker {
  private state = new Map<string, TmuxLinkState>();

  /** Resolve every pane's ref from its raw facts, advancing and pruning the
   *  per-handle state. Returns handle -> ref (null when the pane cannot be
   *  linked). `now` is only the fallback birth for a just-accepted jsonl whose
   *  file could not be stat'ed. */
  resolve(facts: TmuxLinkFacts[], now: number, log: (line: string) => void = console.log): Map<string, AgentSessionRef | null> {
    // per-handle state dies with its pane, exactly as the mux's maps did; the
    // reuse-proof handle means a recycled %N is a new key that inherits nothing
    const live = new Set(facts.map((f) => f.handle));
    for (const h of [...this.state.keys()]) if (!live.has(h)) this.state.delete(h);

    // the ambiguous same-cwd case: count the claude panes per project dir.
    // mungeCwd collapses two panes in the same folder to one key, so the
    // ambiguity check ("newest jsonl" cannot tell two same-cwd panes apart)
    // reads exactly the claude project-dir shape, the way the mux used to.
    const perDir = new Map<string, number>();
    for (const f of facts) {
      if (f.agent !== "claude") continue;
      const key = mungeCwd(f.cwd);
      perDir.set(key, (perDir.get(key) ?? 0) + 1);
    }

    const out = new Map<string, AgentSessionRef | null>();
    for (const f of facts) {
      const ambiguous = f.agent === "claude" && (perDir.get(mungeCwd(f.cwd)) ?? 0) > 1;
      const { ref, state } = linkPane(f, this.state.get(f.handle), now, ambiguous, log);
      if (state === undefined) this.state.delete(f.handle);
      else this.state.set(f.handle, state);
      out.set(f.handle, ref);
    }
    return out;
  }
}
