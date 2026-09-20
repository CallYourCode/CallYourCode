/* THE CROSS-MATRIX RELIABILITY SUITE, shared fixtures (LANE A, Gap 3).
 *
 * This module holds the ONE description of the identity + reliability matrix
 * {tmux, herdr} x {claude, codex, opencode, pi} plus the small builders every
 * suite file drives the reconcile / carry / lineage / hook-announce seams
 * through. It is DATA and PURE HELPERS only: no module singleton is touched at
 * import, so a suite file can import it without inheriting a data dir or a wired
 * chatlog it did not ask for. The reconcile rig (mountReconcile) is the one
 * stateful helper and it is a function a file calls once, explicitly.
 *
 * WHY A TABLE. The two follow-on refactors this suite guards (LANE B's real pi
 * reader, LANE C's tmux identity extraction) must not be free to quietly drop a
 * combination. A missing capability -- pi has no parseScreen, tmux does not
 * locate a codex transcript by folder -- is an EXPLICIT skip with a named
 * reason here, never a silent gap in a hand-written per-agent test.
 *
 * The contract asserted (design sections 1 + Gap 3), per supported
 * cell: START stable id; STOP/RESUME same id + conversation; a DIFFERENT
 * session in the SAME folder is a NEW agent (folder is not identity); MCP /
 * hook self-declare binds and survives restart; content lineage resolves a
 * renamed transcript; input reaches the agent; and the known rebind traps do
 * not reoccur.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as S from "../sessions/session-state.ts";
import {
  makeReconcile, resolvePane, evidenceOf, tickOf, resetReconcileForTest,
  type PaneEvidence,
} from "../sessions/reconcile.ts";
import { initChatlog } from "../chat/chatlog.ts";
import { initIngest } from "../chat/ingest.ts";
import { ANNOUNCED_SOURCE, PREMINT_SOURCE, PARKED_SOURCE } from "../runtime/agents.ts";
import { tmpDataDir } from "./tmp.ts";
import type { MuxAgentInfo } from "../adapters/mux-adapter.ts";
import type { AgentSessionRef, SessionLink } from "../runtime/agents.ts";
import type { Resolution } from "../sessions/reconcile.ts";

/* ------------------------------------------------------------------- matrix */

export type Mux = "tmux" | "herdr";
export type Harness = "claude" | "codex" | "opencode" | "pi";

export const MUXES: readonly Mux[] = ["tmux", "herdr"];
export const HARNESSES: readonly Harness[] = ["claude", "codex", "opencode", "pi"];

/** What a harness reader can and cannot do today (readers/*.ts). A capability
 *  a reader does not implement is an EXPLICIT skip in a suite file, never a
 *  silent gap: pi carries `placeholder` because design Gap 1 says its reader
 *  is a transcript stand-in until LANE B builds the real one. */
export type HarnessCaps = {
  /** the mux stamp for this pane kind */
  kind: string;
  /** parseScreen (permission dialogs / delivery guard): claude only */
  parseScreen: boolean;
  /** a launch/resume command in the reader (spawn from the app): all four */
  launch: boolean;
  /** a transcript reader (context/model/messages): all four */
  transcript: boolean;
  /** a first-class direct-input path (not mux keystrokes): pi only, LANE B */
  directInput: boolean;
  /** pi's reader is a placeholder until LANE B (design Gap 1) */
  placeholder: boolean;
};

export const HARNESS_CAPS: Record<Harness, HarnessCaps> = {
  claude: { kind: "claude", parseScreen: true, launch: true, transcript: true, directInput: false, placeholder: false },
  codex: { kind: "codex", parseScreen: false, launch: true, transcript: true, directInput: false, placeholder: false },
  opencode: { kind: "opencode", parseScreen: false, launch: true, transcript: true, directInput: false, placeholder: false },
  // pi is now a real HarnessReader (readers/pi.ts, LANE B / design Gap 1):
  // transcript + friendly model + launch/resume + a first-class direct-input
  // path. It still has no parseScreen (no pi TUI dialog parser yet).
  pi: { kind: "pi", parseScreen: false, launch: true, transcript: true, directInput: true, placeholder: false },
};

/** The whole matrix, one row per cell, with the supported flag and a reason
 *  when a cell is only partly supported. Every suite file iterates this. */
export type Cell = {
  mux: Mux;
  harness: Harness;
  caps: HarnessCaps;
  /** does the MUX itself hand this pane a harness session id (a "guess"), or
   *  does identity only ever arrive by announce? herdr's agent_session carries
   *  every agent's id; tmux only locates a CLAUDE transcript by folder, so a
   *  codex/opencode/pi pane on tmux has no mux guess and is identified by its
   *  announce alone. This is a real seam difference, not an incidental one. */
  muxGuess: boolean;
};

export const MATRIX: readonly Cell[] = MUXES.flatMap((mux) =>
  HARNESSES.map((harness): Cell => ({
    mux, harness, caps: HARNESS_CAPS[harness],
    muxGuess: mux === "herdr" || harness === "claude",
  })));

/* -------------------------------------------------------------- session ids */

const CWD_DEFAULT = "/home/x/proj";
export const CWD = CWD_DEFAULT;

function hex12(n: number): string {
  return (n >>> 0).toString(16).padStart(12, "0");
}

/** A harness-shaped session id for a cell, distinct per `n`. opencode's is the
 *  `ses_` shape (ids.ts SES_RE); the others are v4-shaped uuids. Every id here
 *  passes isHarnessSessionId, which is what makes it name a conversation. */
export function sid(harness: Harness, n: number): string {
  if (harness === "opencode") {
    const body = (`opencode${n}`).padEnd(24, "0").slice(0, 30);
    return `ses_${body}`;
  }
  const head = { claude: "c1a0de00", codex: "c0dec000", pi: "b1000000" }[harness] ?? "a0000000";
  return `${head}-0000-4000-8000-${hex12(n)}`;
}

/* ------------------------------------------------------------- ref builders */

/** A mux GUESS ref (herdr's agent_session locator, tmux's folder link), or null
 *  when the cell has no mux guess. `announced` is false for these, so the
 *  announce grace applies exactly as in production. */
export function muxGuessRef(cell: Cell, id: string): AgentSessionRef | null {
  if (!cell.muxGuess) return null;
  const source = cell.mux === "herdr" ? `herdr:${cell.harness}` : "tmux:claude";
  return { id, kind: "id", source };
}

/** An ANNOUNCED ref: the harness said "I am session Y" through the hook. The
 *  strongest identity there is; it never waits out the grace. */
export function announcedRef(id: string, link?: SessionLink): AgentSessionRef {
  return { id, kind: "id", source: ANNOUNCED_SOURCE, ...(link ? { link } : {}) };
}

/** A PRE-MINTED ref: the engine spawned the pane and injected CYC_AGENT_ID; the
 *  ref id is that engine agent id, never a harness session id. */
export function premintRef(agentId: string): AgentSessionRef {
  return { id: agentId, kind: "id", source: PREMINT_SOURCE };
}

/** A PARKED ref: a hand-started pane whose harness has not written a transcript
 *  yet. The ref id is the pane handle (tmux) or empty (herdr limbo); it names
 *  no conversation and resolves as if the pane reported nothing. */
export function parkedRef(handleOrEmpty = ""): AgentSessionRef {
  return { id: handleOrEmpty, kind: "id", source: PARKED_SOURCE };
}

/** One pane as the mux reports it, canonical MuxAgentInfo. `harnessSessionId`
 *  is derived exactly as the adapter's toInfo does: a claude pane lifts its id,
 *  a non-claude one carries the ref and leaves harnessSessionId null (the
 *  adapter's lift of agent_session into harnessSessionId is claude-only), and
 *  a premint/parked ref is never lifted. */
export function paneFor(
  cell: Cell, handle: string, ref: AgentSessionRef | null, over: Partial<MuxAgentInfo> = {},
): MuxAgentInfo {
  const isClaude = cell.harness === "claude";
  const lifted = isClaude && ref && ref.kind === "id"
    && ref.source !== PREMINT_SOURCE && ref.source !== PARKED_SOURCE ? ref.id : null;
  return {
    handle, title: "proj", cwd: CWD_DEFAULT, lifecycle: "running", kind: cell.caps.kind,
    harnessSessionId: lifted, agentSession: ref, workspace: "w", tab: null, displayAgent: null,
    stateChangeSeq: 0, statusHint: "idle", ...over,
  };
}

/* ---------------------------------------------------------- the reconcile rig
 *
 * The exact wiring reconcile.test.ts uses -- session-state's maps in a throwaway
 * data dir, chatlog and the tails given the smallest deps they need, the poll
 * driven by hand -- packaged so the three identity-contract files share it
 * without each re-spelling sixty lines. It touches module singletons, so it is
 * a FUNCTION a file calls once at module scope, never an import side effect, and
 * bun isolates each test file in its own process so the singletons are the
 * file's alone. */

export type ReconcileRig = {
  root: string;
  data: string;
  S: typeof S;
  reconcile: (agents: MuxAgentInfo[]) => void;
  /** resolvePane over a one-pane tick, for the direct-call assertions */
  resolveOne: (p: MuxAgentInfo) => Resolution;
  evidenceOf: (a: MuxAgentInfo) => PaneEvidence;
  boot: () => Promise<void>;
  /** the seed root for THIS test: dataDirOf(seedRoot()) === the live
   *  CYC_DATA_DIR, so builders.seedAgent(seedRoot(), ...) writes where boot()
   *  reads. Changes every resetPerTest. */
  seedRoot: () => string;
  /** call in beforeEach: reset state, fresh data dir, grace 0, clock reset */
  resetPerTest: () => Promise<void>;
  clock: { t: number };
  rowOn: (handle: string) => S.Session;
  systemRows: (agentId: string) => string[];
};

export async function mountReconcile(prefix = "cyc-suite-"): Promise<ReconcileRig> {
  const { root, data } = await tmpDataDir(prefix);
  process.env.CYC_DATA_DIR = data;
  let runNo = 0;
  const current = { root: data };

  const deps: S.SessionStateDeps = {
    noteMinted: () => {}, broadcastSessions: () => {}, lineageOf: () => undefined,
  };
  const clock = { t: 1_000_000 };

  initChatlog({
    chatOf: (id) => S.sessions.get(id)?.chat ?? S.restoredChats.get(id),
    restoredChats: () => S.restoredChats,
    persistPatch: (id, mts, set, unset) => S.persistPatch(id, mts, set, unset),
    broadcast: () => {},
    chatRefFor: (id) => S.chatRefFor(id),
    indexMsgBlobs: (aid, m) => S.indexMsgBlobs(aid, m),
    appendMsg: (aid, chatId, m) => S.chatStore.appendMsg(aid, chatId, m),
    appendRec: (aid, chatId, rec) => S.chatStore.appendRec(aid, chatId, rec),
  });
  initIngest({
    sessionOf: (id) => S.sessions.get(id),
    sessions: () => S.sessions.values(),
    broadcastSessions: () => {},
    subscribe: () => null,
    readTranscriptSpan: async () => ({ events: [], queueOps: [], consumed: [], delivered: [], offset: 0 }),
    subscribeStatus: () => null,
    transcriptFile: () => null,
    tailOf: () => undefined,
    setTail: () => {},
    log: () => {},
  });

  const reconcile = makeReconcile({
    hasTranscript: () => false,
    canParseScreen: () => false,
    // default to the native-done (herdr-shaped) mux, so this generic rig keeps
    // its prior behavior; the tmux done-synthesis path is exercised directly.
    nativeDone: true,
    sweepTails: () => {},
    broadcastSessions: () => {},
    now: () => clock.t,
  });

  const resetPerTest = async () => {
    S.resetForTest();
    resetReconcileForTest();
    await S.chatStore.flush();
    /* A FRESH DATA DIR PER TEST, never an rm of the shared one. resetForTest
     * clears the debounced meta-save timers, but a flushAgentSave the last
     * test fired is an immediate async write with no timer to cancel; deleting
     * the tree under it makes its atomic rename land ENOENT. A brand-new empty
     * subdir sidesteps the race entirely: a late write finishes harmlessly in
     * the previous dir, and this test's boot reads an empty one. */
    const root = join(data, `run-${++runNo}`);
    const dir = join(root, "data");
    await mkdir(dir, { recursive: true });
    current.root = root; // dataDirOf(root) === dir === the live CYC_DATA_DIR
    process.env.CYC_DATA_DIR = dir;
    process.env.CYC_ANNOUNCE_GRACE_MS = "0";
    clock.t = 1_000_000;
  };

  const boot = async () => { await S.loadSessionState(deps); S.sessionStateReady(); };
  const resolveOne = (p: MuxAgentInfo) =>
    resolvePane(p, evidenceOf(p), tickOf([p], [evidenceOf(p)], clock.t));

  const rowOn = (handle: string) => S.sessionByHandle(handle)!;
  const systemRows = (agentId: string) =>
    (S.sessions.get(agentId)?.chat ?? []).filter((m) => m.kind === "system").map((m) => m.text);

  return { root, data, S, reconcile, resolveOne, evidenceOf, boot,
    seedRoot: () => current.root, resetPerTest, clock, rowOn, systemRows };
}

/* -------------------------------------------------------- skip bookkeeping
 *
 * Every skip in the suite names why, and every reason is one of these, so the
 * report can tabulate the gaps rather than leaving them as bare `.skip`s. */
export const SKIP = {
  noMuxGuess: (cell: Cell) =>
    `${cell.mux} does not locate a ${cell.harness} transcript by folder; identity arrives by announce only`,
  piPlaceholder: "pi reader is a transcript placeholder until LANE B (design Gap 1)",
  piDirectInput: "pi direct-input path is LANE B; keystroke path is the only one today",
  muxLevelInTmuxTest: "the mux-level guard is proven against real tmux in terminal/tmux.test.ts",
} as const;
