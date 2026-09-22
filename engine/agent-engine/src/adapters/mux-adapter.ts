// MultiplexerAdapter: the agent-shaped seam core sees.
// It adds the interface plus a herdr impl that WRAPS today's Multiplexer and
// today's server helpers. `deliverToPane` now lives HERE as the single
// definition: server.ts imports it (and `PaneNotReady`) instead of keeping its
// own copy, so the two can no longer drift. Server still owns `const mux`
// and still compiles against Multiplexer.
//
// The adapter OWNS its Multiplexer/HerdrClient instance (a fresh HerdrClient by
// default, injectable in tests). Nothing here imports server.ts.

import { classifyPaneBox, parseAsk, type PaneBox } from "../terminal/blocked.ts";
import { runDeliveryMachine } from "../chat/delivery-machine.ts";
import { agentLabel, PREMINT_SOURCE, PARKED_SOURCE, type AgentSessionRef } from "../runtime/agents.ts";
import { HerdrClient } from "../terminal/herdr.ts";
import { makeTerminalDriver } from "../terminal/terminal.ts";
import type { AgentStatus, Multiplexer, MuxAgent } from "../terminal/mux.ts";
import { claudeReader, readAgentRuns, readEventsTail, sessionFilePath } from "../readers/claude.ts";
import { codexReader } from "../readers/codex.ts";
import { opencodeReader } from "../readers/opencode.ts";
import { piReader } from "../readers/pi.ts";
import type { DirectInputEndpoint } from "./pi-direct.ts";
import { piEventSockPath, programToken } from "./pi-launch.ts";
import { recordHookBind } from "../terminal/hook-announce.ts";
import { carryDirectHandleBind } from "../sessions/carry.ts";
import { isHarnessSessionId } from "../runtime/ids.ts";
import { preTrustLaunchFolder } from "./trust-folder.ts";
import { PiEventServer, type PiFrame } from "./pi-events.ts";
import { join } from "node:path";
import { mkdirSync, statSync } from "node:fs";
import { COMPACTED, contextPct, contextWindowFor, modelAcronymOf, modelIdOf,
  modelName, readContextUsage, readSessionTitle, streamLinesForward,
  SessionTailParser, TurnStatusParser, turnEdgeFromLine, tailSideOf, tailEventOf,
  type AgentRun, type DeliveredRecord, type QueueOp, type SessionEvent,
  type TurnEdge } from "../sessions/session-events.ts";
import type { ScrollMode, TerminalDriver, TerminalHandlers, TerminalSession } from "../terminal/terminal.ts";
import { WatcherPool } from "../runtime/watcher-pool.ts";

import type { AgentConversation, AgentEvent, AgentLifecycle, HarnessCaps, HarnessReader, InputDelivery } from "../readers/types.ts";
export type { AgentConversation, AgentEvent, AgentLifecycle };
export type { DirectInputEndpoint } from "./pi-direct.ts";

/** Opaque; minted or adopted by core, never a pane id. */
export type AgentId = string;

export type MuxAgentInfo = {
  handle: string; // mux-opaque. Core stores it, never parses it.
  title: string; // fallback display name (today: basename(cwd))
  cwd: string;
  lifecycle: AgentLifecycle;
  kind: string; // mux stamp ("claude","codex","opencode","pi",...)
  harnessSessionId: string | null; // the harness's own id; lifted claude-only (see toInfo)
  /* The pane's own session ref for ANY agent (herdr agent_session / tmux linked
   * uuid). Carried through so codex/opencode transcript locate keeps working
   * (this locate path must stay behaviour-identical). Core stores it, never opens a file with
   * it. */
  agentSession: AgentSessionRef | null;
  workspace: string;
  tab: string | null;
  displayAgent: string | null;
  stateChangeSeq: number;
  statusHint: AgentStatus;
};

export type MuxCapabilities = {
  terminalViewer: boolean; // herdr/tmux true; Hermes false
  typedInput: boolean; // sendInput is keystrokes vs an API
  // Whether the mux emits its own `done` status (the finished-while-away
  // activity edge). herdr does (agent_status); tmux never does, so the engine
  // synthesizes done from the jsonl turn edge for tmux only (reconcile). This
  // flag is the one gate for that synthesis; a false here opts a mux in.
  nativeDone: boolean;
};

/* One drain of the transcript tail (was server.ts startTail's pump batch),
 * or one span of a backfill read. The queue-op / consumed pieces are core
 * read-state signals read off the same jsonl, not wire frames; they ride
 * here so the ingest's markInContext / applyQueueOp keep exactly the order
 * and batch shape they had. `offset` is the byte just past the last complete
 * line this batch covered: the ingest's pointer (design A.4). */
export type OverlayBatch = {
  events: SessionEvent[];
  queueOps: QueueOp[];
  consumed: string[];
  delivered: DeliveredRecord[];
  offset: number;
};

/** A live tail: where it started reading (the backfill's end) and its stop. */
export type TailSub = { stop(): void; at: number };

export interface MultiplexerAdapter {
  capabilities(): MuxCapabilities;

  start(): void;
  listAgents(): MuxAgentInfo[];
  onAgents(cb: (agents: MuxAgentInfo[]) => void): void;

  /* The MCP register resolution. Core passes the raw pane-scoped id the
   * MCP was born with (HERDR_PANE_ID / TMUX_PANE); the mux answers with the
   * opaque handle core keys sessions by, or null when no listed agent sits on
   * that pane. Core never sees the pane id again. */
  resolveHandle(envId: string): string | null;

  conversation(handle: string): Promise<AgentConversation>;
  /* The pinned-bar read (today server.ts /session-agents): conversation()'s
   * runs without the screen/model/messages work, keyed by cwd + session id so a
   * dead session's runs still resolve. */
  conversationRuns(cwd: string, sessionId: string | null): Promise<{
    harnessSessionId: string | null;
    logExists: boolean;
    runs: AgentRun[];
  }>;
  /* The permission-dialog / delivery-guard screen read (today server.ts
   * readPaneScreen), moved behind the adapter. */
  parseScreen(handle: string): Promise<{ box: PaneBox | { kind: "unreadable" }; text: string }>;
  /* The jsonl transcript locate that used to be server.ts transcriptFile.
   * The one place the claude-path-first / generic-locate choice lives now. */
  transcriptFile(handle: string): { sessionId: string; path: string } | null;

  /* The reader-seam bypass verbs. The four core leaves
   * that used to value-import session-events.ts (carry, lineage, context-cache,
   * session-ops) reach every transcript fact through these instead. Keyed by
   * cwd + harness session id (or a raw path for the sibling walk), reader-backed
   * and byte-identical to the functions they delegate to. */
  /** The claude transcript path for a cwd + session id, byte-identical to
   *  sessionFilePath. Null when no path can be built. */
  transcriptPathFor(cwd: string, sessionId: string): string | null;
  /** Claude's own title for a session's transcript, or null (readSessionTitle). */
  readTitle(cwd: string, sessionId: string): Promise<string | null>;
  /** ONE backward scan of the transcript answering the context bar's whole
   *  reading -- pct, used/total tokens (window math included), and the model in
   *  its three spellings -- so the consumer never touches a model id. Null when
   *  no path. */
  contextModelRead(cwd: string, sessionId: string): Promise<{
    pct: number | null;
    used: number | null;
    total: number | null;
    modelId: string | null;
    modelName: string | null;
    modelAcronym: string | null;
  } | null>;
  /** Stream a transcript's jsonl lines forward (missing file: no-op). Takes a
   *  raw path because lineage's sibling walk scans OTHER transcripts it found by
   *  readdir; the adapter owns the jsonl reading, the caller owns the walk. */
  streamTranscriptLines(path: string, onLine: (line: string) => void): Promise<void>;
  /* The transcript tail (was server.ts startTail/stopTail). `from` is
   * the ingest's saved pointer, or null for a transcript never read before:
   * the tail then starts at EOF and reports that offset in `at`, which is
   * where the backfill ends. */
  subscribe(handle: string, cb: (batch: OverlayBatch) => void, from: number | null): TailSub | null;
  /* The backfill read (design A.4): [from, to) of one transcript forward,
   * handed back as one batch; returns the byte just past the last complete
   * line read (a partial trailing line is left for the next span). */
  readTranscriptSpan(path: string, from: number, to: number, handle?: string): Promise<OverlayBatch>;
  /* The thinking-indicator tail (was server.ts startStatusTail/stopStatusTail). */
  subscribeStatus(handle: string, cb: (edge: TurnEdge) => void): (() => void) | null;
  /* Close pooled watchers whose file has been quiet and untailed (was
   * server.ts fileWatchers.sweep()). */
  sweepTails(): void;

  /* THE PI EXTENSION EVENT STREAM (additive to the transcript tail). For a pi
   * pane cyc launched with the output extension, spawn bound a unix socket and
   * the extension connects to it; this hands each frame to `cb`. Returns an
   * unsubscribe, or null for a pane with no such server (any non-pi pane, a
   * hand-started pi, an old pi). The transcript tail stays the source of truth
   * and the fallback; this is only a faster live source. */
  subscribePiEvents(handle: string, cb: (frame: PiFrame) => void): (() => void) | null;

  /* `takenAt` and `deps` are optional and the implementation has always taken
   * them (the server passes its own delivery collaborators until those clusters
   * move behind the adapter). The interface named only the first two, so
   * the composition root's call was "expected 2 arguments, but got 4". */
  sendInput(handle: string, text: string, deliveryId: string, takenAt?: number,
    deps?: Omit<DeliverDeps, "mux">): Promise<void>;
  interrupt(handle: string): Promise<void>;

  /* LANE B (design Gap 1): the input-delivery SEAM. `inputMethod` answers
   * how a pane's harness prefers to take input -- "direct" (a first-class path
   * into the live session, today pi's RPC `prompt`) or "keystroke" (type into
   * the pane, the only method for claude/codex/opencode). It reads the pane's
   * reader (readers/*.ts inputDelivery) and defaults to "keystroke". */
  inputMethod(handle: string): InputDelivery;
  /* Register (or clear, with null) the live direct-input endpoint for a pane.
   * When a "direct" pane has an endpoint registered, sendInput routes his
   * message THROUGH it (no keystrokes); without one it falls back to keystrokes,
   * so declaring "direct" never strands a message. The pi RPC channel is the
   * only endpoint kind today (adapters/pi-direct.ts). */
  registerDirectInput(handle: string, endpoint: DirectInputEndpoint | null): void;

  /* Raw keystroke pass-throughs for the two shell-typing call sites that are
   * NOT deliverToPane: the restart command (pane-deliver.ts, typed into a bare
   * shell after the agent quits) and the chooser digit press (session-verbs.ts
   * onAnswer). Both need the mux's typed-input verbs without the chooser guard
   * sendInput wraps, so the adapter names them here (the "shell-typing verb" the
   * shell-typing scope notes deferred). They forward straight to the wrapped mux; core no
   * longer holds a raw mux reference for them. */
  sendText(handle: string, text: string): Promise<void>;
  sendKeys(handle: string, ...keys: string[]): Promise<void>;

  /* READER CAPABILITIES. Core asks the adapter what a pane's reader can do
   * instead of branching on s.agent.dialogs / .composer / .launch itself. These
   * were implemented on the concrete adapter and used from the composition root
   * and routes/session-ops.ts, but never declared here, so `adapter` typed as
   * this interface did not have them: the type check called every one of these
   * call sites an error while they worked perfectly at runtime. */
  /** Whether this pane's reader can parse a screen (permission dialogs, guard). */
  canParseScreen(handle: string): boolean;
  /** Whether the mux has a transcript reader for this agent kind. */
  hasTranscript(kind: string): boolean;
  /** Whether this agent kind's reader declares an activity-event source
   *  (readers/types.ts sessionEvents): the app's overlay gate is derived from
   *  this, so a harness that tails events advertises the overlay-capable id. */
  hasSessionEvents(kind: string): boolean;
  /** The command that starts a fresh instance of this agent kind, or null. */
  launchCommand(kind: string): string | null;
  /** The command that resumes a session of this kind, or null. */
  resumeCommand(kind: string, sessionId: string): string | null;
  /** The kinds the plus menu can offer (every reader with a launch), READERS order. */
  launchableKinds(): Array<{ kind: string; command: string }>;
  /** Every harness kind this engine knows and its declared meta capabilities, in
   *  READERS order (the ONE source of truth). The capability core derives its
   *  resolver and the usage-card's kind list from this, so adding a reader adds
   *  its kind and profile automatically -- no hardcoded harness list. */
  harnessProfiles(): ReadonlyArray<{ tag: string; caps: HarnessCaps }>;
  /** This kind's own restart gone-wait ceiling (reader.quit.waitMs), or null
   *  for the shipped default. Only a harness that quits slowly declares one. */
  quitWaitMs(kind: string): number | null;
  /** This kind's own restart quit key sequence (reader.quit.keys), or null for
   *  the shipped default (RESTART_QUIT_PRESSES x "ctrl+c"). Only a harness whose
   *  quit is not repeated ctrl+c declares one (readers/pi.ts). */
  quitKeys(kind: string): string[] | null;
  /** The non-claude context/model read, or null when there is no reader. */
  contextRead(handle: string): Promise<{ pct: number | null; model: string | null } | null>;
  /** The two terminal-driver facts TerminalHub asks the adapter to pass through. */
  terminalPaneMode(handle: string): Promise<ScrollMode>;
  readonly terminalCanResize: boolean;

  /* Genuinely optional: no adapter implements `answer` yet, so a caller must
   * check capabilities (and the chooser path types digits through sendKeys
   * instead). */
  answer?(handle: string, choice: string, fingerprint: string): Promise<void>;

  /* THE SPAWN-SIDE VERBS ARE REQUIRED, not optional. Every adapter this
   * factory can return has them -- MuxAdapter implements all four and
   * TmuxMuxAdapter extends it -- and core calls them unguarded from
   * routes/session-ops.ts. Declaring them optional described an adapter that
   * does not exist, and made four working call sites type errors. What
   * capabilities actually gate is whether the APP offers the verb, not whether
   * the adapter has it. */
  spawn(opts: { cwd: string; nearHandle?: string | null; command: string }): Promise<{ handle: string }>;
  rename(handle: string, label: string): Promise<void>;
  close(handle: string): Promise<void>;
  knownCwds(): string[];

  /* Wired unconditionally by the composition root; capabilities().terminalViewer
   * is what decides whether frames.ts ever calls it. Same reasoning as the
   * spawn-side verbs above: present on every adapter, gated at the caller. */
  openTerminal(handle: string, cols: number, rows: number, h: TerminalHandlers): TerminalSession;
}

/** MuxAgent.status -> the coarse lifecycle core keys `alive` on. */
function lifecycleOf(status: AgentStatus): AgentLifecycle {
  switch (status) {
    case "blocked": return "blocked";
    case "working":
    case "done": return "running";
    default: return "started"; // idle, unknown: listed and alive, no turn in flight
  }
}

/** MuxAgent -> the canonical MuxAgentInfo core sees. `handle` is today's paneId
 *  inside this impl; core never parses it. */
function toInfo(a: MuxAgent): MuxAgentInfo {
  return {
    handle: a.paneId,
    title: a.name,
    cwd: a.cwd,
    lifecycle: lifecycleOf(a.status),
    kind: a.agent,
    /* A pre-minted ref (PREMINT_SOURCE) is the ENGINE's stable agent id for a
     * pane it spawned before the harness wrote anything; it is not a harness
     * session id and must not open a transcript, so it is never lifted here.
     * The session stays keyed by its pane handle, exactly the parked shape the
     * herdr lane has before claude mints its uuid (#405 carry). A PARKED ref
     * (PARKED_SOURCE, the hand-started twin) carries the pane handle itself and
     * is refused for the same reason. */
    /* THE LIFT STAYS CLAUDE-ONLY, on purpose. Its consumers are claude-shaped:
     * resolvePath (sessionFilePath) and conversation() (claudeReader) build a
     * claude jsonl path from this field, so a non-claude id lifted here would be
     * fed into a claude transcript path. Non-claude capture does not need it:
     * evidenceOf reads `a.harnessSessionId ?? ref.id` (reconcile.ts), so an
     * ANNOUNCED (or pi-socket) ref for any harness already flows into
     * adoptSession through the ref.id fallback. Widening this would only harm. */
    harnessSessionId: a.agent === "claude" && a.agentSession?.kind === "id"
      && a.agentSession.source !== PREMINT_SOURCE
      && a.agentSession.source !== PARKED_SOURCE
      ? a.agentSession.id : null,
    agentSession: a.agentSession,
    workspace: a.workspace,
    tab: a.tab,
    displayAgent: a.displayAgent,
    stateChangeSeq: a.stateChangeSeq,
    statusHint: a.status,
  };
}

/* THE READERS TABLE: the pane-kind dispatch that used to live in
 * agents.ts profileFor + transcripts.ts. claude is the default/first entry;
 * codex and opencode bring their own real HarnessReader (readers/codex.ts,
 * readers/opencode.ts). pi is now a real HarnessReader too (readers/pi.ts,
 * LANE B / design Gap 1): it replaces the transcript-only placeholder
 * `readerFromTranscript("pi", PI_TRANSCRIPT)` while KEEPING that behaviour --
 * piReader delegates locate/turnEdge/contextPct/model/messages to the same
 * fixture-proven PI_TRANSCRIPT -- and ADDS a friendly model name, launch/resume
 * commands, and a declared direct-input method. The pi-agent LANE recognizer
 * (adapters/piagent.ts) is NOT a pane kind and stays where it was: inside
 * session-events.ts readAgentRuns, gated by CYC_PIAGENT_ADAPTER. */
const READERS: readonly HarnessReader[] = [
  claudeReader, // claude (default): parseScreen + launch + runs + title + messages
  codexReader, // codex: transcript locate/edge/model/context/messages
  opencodeReader, // opencode: same class as codex; transcript not append-only
  piReader, // pi: real reader; transcript + friendly model + launch/resume + direct input
];

/** First reader whose detect is true for the normalized kind stamp, or null
 *  (an unknown agent: name-only, no reader capabilities -- exactly profileFor's
 *  unknownProfile). The detect predicates are disjoint kind matches, so the
 *  order cannot hide one pane kind behind another. */
function readerFor(kind: string): HarnessReader | null {
  for (const r of READERS) {
    if (r.detect({ kindStamp: kind, cwd: "", sessionRef: null })) return r;
  }
  return null;
}

/** The reader that OWNS a launch command, matched by its launch PROGRAM TOKEN
 *  (pi owns `pi`, claude `claude`, codex `codex`, opencode `opencode`), or
 *  null for a command no reader launches. This is how spawn learns the harness
 *  from the command string alone so it can dispatch on the reader's own
 *  declarations (eventSocket / launchAugment) instead of sniffing for pi.
 *
 *  The match is the SAME program-token test isPiLaunchCommand does internally,
 *  lifted to the whole READERS table: strip any `env NAME=VALUE` prefix
 *  (programToken), take the basename of the launch program, and compare it to a
 *  reader's declared launch program. For pi that is exactly isPiLaunchCommand's
 *  `/(?:^|\/)pi$/` -- a bare `pi` or a `.../bin/pi` path form both resolve to
 *  the pi reader, and nothing else does -- so the spawn dispatch is byte-for-byte
 *  the pi behaviour it replaces, and no new capability. */
function readerForLaunchCommand(command: string): HarnessReader | null {
  const prog = programToken(command);
  if (prog == null) return null;
  const base = prog.split("/").pop() ?? prog;
  for (const r of READERS) {
    const launch = r.launch?.command;
    if (launch == null) continue;
    if (programToken(launch) === base) return r;
  }
  return null;
}

/* THE ONE TRANSCRIPT LOCATE (was server.ts transcriptFile). The agent's
 * own transcript reader locates the file. claude's reader is the same
 * sessionFilePath build the deleted special case used, so the answers are
 * identical. */
function transcriptFileOf(info: MuxAgentInfo): { sessionId: string; path: string } | null {
  // A pre-minted or parked ref is engine identity, never a transcript id:
  // locating a file from it would fabricate a path for a session that does
  // not exist.
  const ref = info.agentSession?.source === PREMINT_SOURCE
    || info.agentSession?.source === PARKED_SOURCE ? null : info.agentSession;
  return readerFor(info.kind)?.locate(ref, info.cwd) ?? null;
}

/** The poll tail's cheap change gate: mtime+size of the store file and its
 *  sqlite -wal sidecar (where commits land between checkpoints). "" when the
 *  store file itself is missing. */
function statKeyOf(statPath: string): string {
  let key: string;
  try {
    const s = statSync(statPath);
    key = `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
  try {
    const w = statSync(statPath + "-wal");
    key += `|${w.mtimeMs}:${w.size}`;
  } catch { /* no wal yet: the db stat alone gates */ }
  return key;
}

// Tail state, the same two-parser shape server.ts held (two
// parsers: the overlay replays a cached offset, the thinking tail starts at
// EOF). Both share the per-path watcher pool below.
type OverlayTail = {
  path: string;
  parser: SessionTailParser;
  pump: () => void;
  chain: Promise<void>;
  cb: (batch: OverlayBatch) => void;
};

type StatusTail = {
  path: string;
  parser: TurnStatusParser;
  pump: () => void;
  chain: Promise<void>;
  cb: (edge: TurnEdge) => void;
};

/* A POLL-MODE activity tail (readers/types.ts SessionEventSource "poll"): the
 * harness's store is not an append-only file (opencode's sqlite db), so the
 * tail keeps a reader-defined cursor instead of a byte offset and asks the
 * reader's `since` for everything newer on each pump. The pump is stat-gated:
 * the heartbeat's 250ms beat costs two statSync calls until the store (db or
 * its -wal sidecar) actually changes. `statPath` is the real file behind the
 * locate's `db#sessionId` shape. */
type PollTail = {
  path: string; // the locate's path, handed to since() verbatim
  statPath: string; // the store file the change gate stats
  since: (path: string, cursor: number) => Promise<{ events: SessionEvent[]; cursor: number } | null>;
  cursor: number;
  statKey: string; // last seen mtime/size of statPath (+wal)
  pump: () => void;
  chain: Promise<void>;
  cb: (batch: OverlayBatch) => void;
};

// ------------------------------------------------------------- deliverToPane
//
// THE delivery guard, moved out of server.ts (single definition). The function
// takes the four things that differ between server and this adapter as a deps
// object, so server can pass its own `herdr`, `unsubmitted` map, keyboard queue,
// session lookup and paneBox and get byte-identical behaviour, while
// MuxAdapter.sendInput passes its own.

/* The delivery guard's screen-read size. Must exceed any real viewport height:
 * herdr 0.8.0 marks a read `truncated` when fewer lines than the visible screen
 * were asked for, and the guard refuses a truncated screen. At 40 lines on his
 * 47-row panes that refused every message sent on this host. (Moved from
 * server.ts alongside readPaneScreen.) */
const BOX_READ_LINES = 500;
/* How much screen a dialog can occupy (the ask-state read). The same number
 * server.ts readAskNow used before this move: the plan approval fits inside 40, 60
 * is that with room, and still one small RPC. */
const ASK_READ_LINES = 60;
/** Settle between keystrokes and before a retry. Server's restart path imports
 *  this same constant so both stay one number. */
export const DELIVER_SETTLE_MS = 250;

/* THE THREE DELIVERY TIMINGS, READ ON EVERY USE RATHER THAN AT IMPORT.
 *
 * Two of them were already environment knobs; the third (the settle) was a
 * literal. What changes here is only WHEN the environment is read, and it
 * changes for one reason: a module const is fixed by the import statement at the
 * top of whoever loaded this file, which in a test is the test file's own first
 * line. Nothing the file then does at file scope can reach it. Production sets
 * these once before the process starts, or never, so it reads the same numbers
 * it always did on every call.
 *
 * The defaults are the shipped ones and each is load bearing:
 *
 *   settle    250ms between the text and the enter. Measured: claude's TUI takes
 *             a rapid burst as one bracketed paste and an enter inside that
 *             window becomes a NEWLINE in the input instead of a submit, which
 *             looks like "typed but never sent".
 *   stranded  60s. How long a note saying "the body is already in that pane" may
 *             be believed. It bounds the AGE OF THE BODY, not the gap between
 *             retries (see the restamp bug below).
 *   deadline  45s. How long HIS message may be held -- by the per-session queue
 *             and by the global keyboard chain -- before somebody says so rather
 *             than letting it wait behind a wedged pane. It must comfortably
 *             clear a delivery that is merely SLOW: refusing one of those is
 *             task #256, the four hours the guard refused everything he sent.
 */
export const settleMs = (): number => Number(process.env.DELIVER_SETTLE_MS) || DELIVER_SETTLE_MS;
export const strandedTtlMs = (): number => Number(process.env.STRANDED_TTL_MS) || 60_000;
export const deliverDeadlineMs = (): number => Number(process.env.DELIVER_DEADLINE_MS) || 45_000;
/* How long to wait after the enter before reading the pane back to confirm the
 * body was submitted rather than left sitting in the input box. Read on every
 * use like the three above, and for the same reason (a module const is frozen
 * by the import that loaded this file, so a seam test cannot shorten it at file
 * scope). Default 250ms: one settle's worth for the composer to redraw.
 *
 * It falls back to the DELIVERY SETTLE, not straight to 250, so a caller that
 * already shrank the type-settle (every seam test does, to run in ms) gets a
 * confirm that runs in ms too, without also having to know this knob's name.
 * Production sets neither and reads 250 either way; a caller that wants the
 * confirm at a value of its own sets CONFIRM_SETTLE_MS and that wins. */
export const confirmSettleMs = (): number =>
  Number(process.env.CONFIRM_SETTLE_MS) || Number(process.env.DELIVER_SETTLE_MS) || 250;
/* The RE-CONFIRM settle for a stranded verdict. A busy pane's claude TUI can
 * take longer than the confirm settle to clear its input box after it consumes
 * the enter: the message is submitted (a `user` record lands in the transcript)
 * but the box still shows the body when the confirm read fires, so a single
 * read false-strands, and the app's retry then doubles the message (measured
 * live 2026-09-07: BZ Builder, record landed 4s after the stranded verdict,
 * two identical user records). A second read after this longer settle lets a
 * slow clear resolve; only a box STILL holding content after both reads is a
 * real strand. Falls back to the delivery settle so seam tests stay fast. */
export const restrandSettleMs = (): number =>
  Number(process.env.RESTRAND_SETTLE_MS) || Number(process.env.DELIVER_SETTLE_MS) || 1200;
/* The RE-ECHO settle for the pre-enter echo gate. The mirror of the re-confirm
 * settle above, on the OTHER side of the enter. A busy pane's TUI can take
 * longer than the type-settle to paint the typed body into its composer: the
 * paste is accepted but the echo has not repainted when the echo-gate read
 * fires, so a single read false-refuses as swallowed and no enter is ever sent
 * (measured live 2026-09-20: testbox, opencode 1.18.31 under tmux, the gate
 * ruled swallowed while the body visibly sat in the composer; the deployed
 * matcher run against that same final screen returns true, so the read was
 * early, not wrong). A second read after this longer settle lets a slow paint
 * resolve; only a screen STILL lacking the echo after both reads is a swallow.
 * The safety property is untouched: no enter is pressed until an echo is seen,
 * so a modal still swallows zero enters and the second read only delays the
 * refusal by one settle. Falls back to the delivery settle so seam tests stay
 * fast, and a caller that wants it at a value of its own sets REECHO_SETTLE_MS. */
export const reEchoSettleMs = (): number =>
  Number(process.env.REECHO_SETTLE_MS) || Number(process.env.DELIVER_SETTLE_MS) || 1200;
/** The settle, for the one other keyboard sequence that shares it (the restart
 *  command in pane-deliver.ts): two numbers for one measured pause is how they
 *  drift apart. */
export const deliverSettleMs = settleMs;
const CONVERSATION_EVENT_LIMIT = 200;
const CONVERSATION_EVENT_BYTES = Number(process.env.CYC_ATTACH_EVENT_BYTES) || 16 * 1024 * 1024;
/** Thrown when the pane is in no state to be typed at. Carries a sentence for
 *  the user, because "not delivered" without a reason is the thing this
 *  codebase keeps having to apologise for. Every throw promises nothing was
 *  submitted and no enter was pressed: the text is not sitting in any input
 *  box, which is why the caller may offer the message again (retriable) with no
 *  risk of doubling it. */
export class PaneNotReady extends Error {
  /** `showingPrompt` marks the refusals where the pane is sitting on a prompt,
   *  menu or notice a person has to answer in the terminal (chooser, blocked,
   *  swallowed) -- as opposed to a pane that timed out or could not be read.
   *  The caller words the user-facing notice off it. */
  constructor(readonly why: string, readonly tell: string,
    readonly showingPrompt = false) { super(why); }
}

/** Thrown when the body WAS typed and an enter WAS pressed, but the pane still
 *  shows it sitting in the input box: the enter did not submit it. NOT a
 *  subclass of PaneNotReady, because their retry contracts are opposite -- a
 *  PaneNotReady retry types the body fresh (nothing was typed), a
 *  DeliveryStranded retry presses enter only (the body is already there, the
 *  unsubmitted note is kept). */
export class DeliveryStranded extends Error {
  constructor(readonly why: string, readonly tell: string) { super(why); }
}

/** The slice of a session the delivery guard reads: its agent label and its
 *  current (engine-refined) status. Server supplies the Session registry; the
 *  adapter supplies its own agent snapshot. Capabilities are the mux's own
 *  (canParseScreen below), not fields on the agent here. */
export type DeliverSession = {
  agent: { id: string; name: string };
  status: AgentStatus;
};

export type DeliverDeps = {
  mux: Pick<Multiplexer, "sendText" | "sendKeys">;
  unsubmitted: Map<string, { deliveryId: string; at: number }>;
  onPaneKeyboard: <T>(fn: () => Promise<T>) => Promise<T>;
  sessionFor: (handle: string) => DeliverSession | undefined;
  /** The screen read the guard makes. Widened from a box-only reader to
   *  { box, text }: the box is the parser's verdict (used only when
   *  canParseScreen), and the raw `text` is what the echo gate and the
   *  non-claude tail checks measure against, since we cannot ask a foreign
   *  screen for a box. Both suppliers already return this shape (pane-deliver's
   *  readPaneScreen, which also publishes choosers, and MuxAdapter.parseScreen). */
  readScreen: (handle: string) => Promise<{ box: PaneBox | { kind: "unreadable" }; text: string }>;
  /** Whether the mux can parse this agent's screen (dialogs AND input box):
   *  the reader's parseScreen presence, folded from the old dialogs/composer
   *  profile fields. */
  canParseScreen: (handle: string) => boolean;
};

/* `takenAt` is WHEN THE ENGINE TOOK THIS MESSAGE, and it is a parameter rather
 * than a `Date.now()` in here because there are TWO queues between the frame and
 * the keystroke, not one:
 *
 *   utterQueue  per session, holds a whole utterance (a recording being
 *               decoded, an upload being read) so one chat's messages reach the
 *               agent in the order he sent them;
 *   deliverChain  global, holds every keystroke for every pane.
 *
 * Both of them hold HIS message, and a clock started in here starts after the
 * first one has already been waited out, which is exactly what it must measure.
 * Default for the callers with no queue in front of them (/compact, a schedule
 * firing): now. */
export function deliverToPane(
  deps: DeliverDeps,
  paneId: string,
  text: string,
  deliveryId: string,
  takenAt?: number,
): Promise<void> {
  const took = takenAt ?? Date.now();
  /* The seam, unchanged: take the ONE keyboard queue, run the state machine
   * inside that single slot, and map its typed outcome back to the exact
   * PaneNotReady / DeliveryStranded this function has always thrown, with the
   * verbatim message strings. The machine owns every timing, read, log line and
   * refusal; the only thing that lives out here is the queue and the throw. */
  return deps.onPaneKeyboard(async () => {
    const { onPaneKeyboard: _queue, ...io } = deps;
    const outcome = await runDeliveryMachine(io, paneId, text, deliveryId, took);
    switch (outcome.kind) {
      case "delivered":
      case "unconfirmed":
        return;
      case "stranded":
        throw new DeliveryStranded(outcome.why, outcome.tell);
      case "refusedTimeout":
      case "refusedUnreadable":
        throw new PaneNotReady(outcome.why, outcome.tell);
      case "refusedBlocked":
      case "refusedChooser":
      case "refusedSwallowed":
        throw new PaneNotReady(outcome.why, outcome.tell, true);
    }
  });
}

/* The per-pane socket dir. CYC_PI_EVENT_DIR overrides it (a test points it at
 * a short tmp path; sun_path is ~108 bytes). Default: <data>/run beside the
 * engine's other runtime state. Kept out of datadir.ts so this file stays the
 * one place the pi-event wiring lives. */
function piRunDir(): string {
  return process.env.CYC_PI_EVENT_DIR
    || join(process.env.CYC_DATA_DIR || join(process.env.HOME || "", ".callyourcode"), "run");
}

/* The per-pane socket key. The launch command carries the pane's stable agent
 * id (env-agent.ts prefixes `env CYC_AGENT_ID=<id>`), which is known here and
 * stable, so the socket name and the pane agree without a round trip. A launch
 * without one (a test) falls back to a random token, still unique per spawn. */
function piSockKey(command: string): string {
  const m = command.match(/CYC_AGENT_ID=(ag-[A-Za-z0-9_-]{1,64})/);
  if (m) return m[1];
  return `p${Math.random().toString(36).slice(2, 12)}`;
}

export class MuxAdapter implements MultiplexerAdapter {
  private mux: Multiplexer;
  private terminal: TerminalDriver;
  /* THE IDENTITY REFINEMENT of a mux emit, injected by the subclass rather than
   * overridden as a method, so a purpose-built adapter (the tmux one) reimple-
   * ments no verb (adapters/tmux-adapter.test.ts). Default: pass the mux's emit
   * through unchanged (herdr's agent_session is authoritative). The tmux adapter
   * injects the jsonl-linking identity step (sessions/tmux-link.ts) over the raw
   * pane facts, filling each pane's agentSession. It runs once per poll (see the
   * single mux listener below), never per callback: a stateful refine run once
   * per callback would double-advance its link state. */
  private readonly refine: (agents: MuxAgent[]) => MuxAgent[];
  private latest: MuxAgent[] = [];
  /* onAgents fan-out: ONE listener is registered on the underlying mux, so
   * refineAgents (the tmux identity step) runs exactly once per poll no matter
   * how many onAgents callbacks are registered; a per-callback mux subscription
   * would run a stateful refine once per callback and double-advance its link
   * state. */
  private agentCbs: Array<(agents: MuxAgentInfo[]) => void> = [];
  private muxBound = false;
  private unsubmitted = new Map<string, { deliveryId: string; at: number }>();
  private deliverChain: Promise<void> = Promise.resolve();
  // LANE B: live direct-input endpoints, one per pane that has a pi RPC channel.
  private directEndpoints = new Map<string, DirectInputEndpoint>();

  // The two jsonl tails, moved out of server.ts. One pooled watcher per
  // file (fileWatchers) fans out to both, exactly as server.ts did.
  private fileWatchers: WatcherPool;
  private overlayTails = new Map<string, OverlayTail>(); // handle -> active overlay watch
  private statusTails = new Map<string, StatusTail>(); // handle -> active status watch
  private pollTails = new Map<string, PollTail>(); // handle -> active poll-mode activity tail
  /* THE TAIL HEARTBEAT (activity latency). fs.watch is the fast path, but its
   * delivery is not a guarantee: measured on the live engine (2026-09-05),
   * appended tool/reply records that were on disk within ~30ms of
   * their record timestamp reached the drain 1.6-3.9s later in bursts, i.e.
   * the change events for several consecutive appends arrived late or
   * coalesced, and a lost event would strand the tail until the NEXT append.
   * The heartbeat re-pumps every live tail on a short interval, so the worst
   * case is bounded at ~TAIL_POLL_MS + drain instead of "whenever the next
   * fs.watch event lands". A quiet pump costs one stat per tail (both parsers
   * return early on size === offset); it never re-reads consumed bytes and
   * logSession is idempotent past it, so a pump racing a watch event is safe. */
  private tailPoll: ReturnType<typeof setInterval> | null = null;
  // The pi output extension's socket servers, one per cyc-launched pi pane.
  private piServers = new Map<string, PiEventServer>(); // handle -> live server

  /* Whether this mux emits its own `done` status. Injected by the subclass
   * rather than overridden as a method, exactly like `refine` above, so the
   * purpose-built tmux adapter reimplements no verb (tmux-adapter.test.ts).
   * herdr (the default) does; the tmux adapter passes false and the engine
   * synthesizes done from the jsonl turn edge for it (reconcile). */
  private readonly nativeDoneCap: boolean;

  constructor(mux?: Multiplexer, terminal?: TerminalDriver,
    refine: (agents: MuxAgent[]) => MuxAgent[] = (agents) => agents,
    fileWatchers?: WatcherPool, nativeDone = true) {
    this.mux = mux ?? new HerdrClient();
    this.refine = refine;
    this.nativeDoneCap = nativeDone;
    /* Injectable for the tail-poll seam test ONLY: an inert watchFn proves the
     * heartbeat moves bytes with no fs.watch help. Production always takes the
     * default pool. */
    this.fileWatchers = fileWatchers ?? new WatcherPool();
    /* The live terminal bridge driver, owned here beside the mux so
     * server.ts no longer builds a second factory reading the same CYC_MUX env.
     * The driver is the same makeTerminalDriver terminal.ts exports (herdr by
     * default, tmux when CYC_MUX=tmux); nothing above this file names either. */
    this.terminal = terminal ?? makeTerminalDriver();
  }

  /** The one Multiplexer behind every verb here. Exposed (read-only) so the
   *  factory seam test can pin that spawn and enumeration share a single
   *  instance; the tmux lane once split them and pre-links landed in a mux
   *  nobody polled. */
  get backingMux(): Multiplexer {
    return this.mux;
  }

  capabilities(): MuxCapabilities {
    // nativeDone is the one cap that differs by mux (herdr true, tmux false);
    // it is injected at construction so no subclass overrides this verb.
    return { terminalViewer: true, typedInput: true, nativeDone: this.nativeDoneCap };
  }

  /* The mux's terminalViewer verb. Server's TerminalHub (core refcount +
   * ws fanout) calls this through a thin driver binding, so the bridge process
   * is the mux's while the hub's bookkeeping stays core. The gate for a mux
   * that cannot show a terminal (terminalViewer:false) lives in server's
   * onTermOpen, the one place a viewer asks for a terminal. */
  openTerminal(handle: string, cols: number, rows: number, h: TerminalHandlers): TerminalSession {
    return this.terminal.open(handle, cols, rows, h);
  }

  /* The two driver facts TerminalHub still asks for, passed through so the hub
   * holds exactly one driver (this one), not a second factory. */
  terminalPaneMode(handle: string): Promise<ScrollMode> {
    return this.terminal.paneMode(handle);
  }

  get terminalCanResize(): boolean {
    return this.terminal.canResize;
  }

  start(): void {
    this.mux.start();
  }

  listAgents(): MuxAgentInfo[] {
    return this.latest.map(toInfo);
  }

  onAgents(cb: (agents: MuxAgentInfo[]) => void): void {
    this.ensureMuxListener();
    this.agentCbs.push(cb);
    // the mux's own "emit now if we already have a snapshot" semantics: a late
    // subscriber gets the last refined snapshot at once rather than waiting a lap
    if (this.latest.length) cb(this.latest.map(toInfo));
  }

  /** Bind ONE listener to the underlying mux, lazily on the first onAgents so
   *  nothing subscribes before a caller asks. It refines each poll once, caches
   *  the refined snapshot, and fans it out to every registered callback. */
  private ensureMuxListener(): void {
    if (this.muxBound) return;
    this.muxBound = true;
    this.mux.onAgents((agents) => {
      this.latest = this.refine(agents);
      const infos = this.latest.map(toInfo);
      for (const cb of this.agentCbs) cb(infos);
    });
  }

  private infoFor(handle: string): MuxAgentInfo | undefined {
    return this.latest.map(toInfo).find((a) => a.handle === handle);
  }

  /* The MCP register resolution. The raw HERDR_PANE_ID / TMUX_PANE is a
   * pane-shaped value only this mux owns; the mux answers with the opaque
   * handle (today the pane id, but core never parses it) or null when the mux
   * does not list that pane. */
  resolveHandle(envId: string): string | null {
    if (!envId) return null;
    /* Exact match first (herdr: the env id IS the handle). The tmux lane's
     * handle is the reuse-proof pane key `%N~pid~epoch` while TMUX_PANE only
     * carries the bare `%N`, so a composite handle whose pane-id segment is
     * the env id resolves too; only live panes are in `latest`, so at most one
     * generation of a %N can match. The `~` separator never appears in a herdr
     * pane id, so the prefix rule cannot misfire there. */
    const info = this.latest.map(toInfo).find((a) =>
      a.handle === envId || a.handle.startsWith(`${envId}~`));
    return info ? info.handle : null;
  }

  async conversation(handle: string): Promise<AgentConversation> {
    const info = this.infoFor(handle);
    const lifecycle = info?.lifecycle ?? "gone";
    /* The ask-state read (readAskNow) moves behind the adapter. It is a
     * screen observation made on every call, the way readAskNow always read
     * rather than answering from any cache. */
    const blocked = await this.readBlocked(handle);
    const { harnessSessionId, path } = this.resolvePath(handle);
    if (!path) {
      return {
        harnessSessionId, model: null, contextPct: null, title: null, blocked,
        lifecycle, messages: [], events: [], runs: [],
      };
    }
    // REAL: transcriptFile (sessionFilePath, above) + readEventsTail +
    // readAgentRuns, reached through the readers/claude.ts seam.
    const events = (await readEventsTail(path, {
      limit: CONVERSATION_EVENT_LIMIT,
      maxBytes: CONVERSATION_EVENT_BYTES,
    })).events;
    const runs = await readAgentRuns(path);
    const [model, contextPct, title, messages] = await Promise.all([
      claudeReader.model(path),
      claudeReader.contextPct(path),
      /* `title` is optional on a Reader (readers/types.ts:72) even though the
       * claude one has it; called plainly it was an unguarded invoke of a
       * possibly-absent method. The `?? null` is the same answer title() gives
       * when it cannot read one. */
      claudeReader.title?.(path) ?? null,
      claudeReader.messages?.(path) ?? [],
    ]);
    return {
      harnessSessionId,
      model,
      contextPct,
      title,
      blocked,
      lifecycle,
      messages: messages.map((m) => ({
        role: (m.role === "claude" ? "agent" : "user"),
        text: m.text,
        ts: m.ts,
      })),
      events,
      runs,
    };
  }

  /* The handle -> transcript path resolution for conversation()'s live
   * snapshot. The overlay read (conversationRuns) resolves
   * by cwd + harness session id instead, so a dead session's transcript still
   * resolves after its pane leaves the mux snapshot. */
  private resolvePath(handle: string): { harnessSessionId: string | null; path: string | null } {
    const info = this.latest.map(toInfo).find((a) => a.handle === handle);
    const harnessSessionId = info?.harnessSessionId ?? null;
    const path = harnessSessionId && info ? sessionFilePath(info.cwd, harnessSessionId) : null;
    return { harnessSessionId, path };
  }

  async conversationRuns(cwd: string, sessionId: string | null): Promise<{
    harnessSessionId: string | null;
    logExists: boolean;
    runs: AgentRun[];
  }> {
    const path = sessionId ? sessionFilePath(cwd, sessionId) : null;
    if (!path || !(await Bun.file(path).exists())) {
      return { harnessSessionId: sessionId, logExists: false, runs: [] };
    }
    return { harnessSessionId: sessionId, logExists: true, runs: await readAgentRuns(path) };
  }

  /* The transcript locate that used to be server.ts transcriptFile. The
   * single claude-path-first / generic-locate choice. */
  transcriptFile(handle: string): { sessionId: string; path: string } | null {
    const info = this.infoFor(handle);
    return info ? transcriptFileOf(info) : null;
  }

  /* The reader-seam bypass verbs. sessionFilePath / readSessionTitle /
   * readContextUsage + the pure model mappers, reached here so carry, lineage
   * and context-cache stop value-importing session-events.ts. The path answers
   * are byte-identical to sessionFilePath; the reads are one scan each. */
  transcriptPathFor(cwd: string, sessionId: string): string | null {
    return sessionFilePath(cwd, sessionId);
  }

  async readTitle(cwd: string, sessionId: string): Promise<string | null> {
    const path = this.transcriptPathFor(cwd, sessionId);
    if (!path) return null;
    return readSessionTitle(path);
  }

  async contextModelRead(cwd: string, sessionId: string): Promise<{
    pct: number | null;
    used: number | null;
    total: number | null;
    modelId: string | null;
    modelName: string | null;
    modelAcronym: string | null;
  } | null> {
    const path = this.transcriptPathFor(cwd, sessionId);
    if (!path) return null;
    /* ONE reading feeds every field, exactly as context-cache used to derive
     * them: pct from contextPct, used = the reading's tokens, total from
     * contextWindowFor (which strips [1m]/date pins), the model in three
     * spellings off modelIdOf. COMPACTED/null carry no tokens or model. */
    const reading = await readContextUsage(path);
    const usage = reading && reading !== COMPACTED ? reading : null;
    return {
      pct: contextPct(reading),
      used: usage ? usage.tokens : null,
      total: usage ? contextWindowFor(usage.model) : null,
      /* The three model spellings come off the reading, which carries a /model
       * switch's override when one is newer than the usage record; without a
       * switch each derives from the usage model exactly as before. */
      modelId: modelIdOf(reading),
      modelName: modelName(reading),
      modelAcronym: modelAcronymOf(reading),
    };
  }

  async streamTranscriptLines(path: string, onLine: (line: string) => void): Promise<void> {
    const f = Bun.file(path);
    if (!(await f.exists())) return; // missing file: no-op, the caller's walk skips it
    await streamLinesForward(f, 0, f.size, onLine);
  }

  /* How often the tail heartbeat re-pumps every live tail (see the tailPoll
   * field). Short enough that a missed fs.watch event costs a beat, not the
   * seconds the live engine measured; long enough that a quiet beat (one stat
   * per tail) is invisible even with dozens of panes. */
  static readonly TAIL_POLL_MS = 250;

  /** One interval for ALL tails, alive exactly while any tail is. */
  private ensureTailPoll(): void {
    if (this.tailPoll) return;
    this.tailPoll = setInterval(() => {
      for (const w of this.overlayTails.values()) w.pump();
      for (const w of this.statusTails.values()) w.pump();
      for (const w of this.pollTails.values()) w.pump();
    }, MuxAdapter.TAIL_POLL_MS);
  }

  private maybeStopTailPoll(): void {
    if (!this.tailPoll || this.overlayTails.size > 0 || this.statusTails.size > 0
      || this.pollTails.size > 0) return;
    clearInterval(this.tailPoll);
    this.tailPoll = null;
  }

  /* The transcript tail (was server.ts startTail). Watches the harness's
   * transcript from the ingest's pointer (or EOF when there is none) and hands
   * each drain back as one batch, with the offset it stands at after it. A
   * drain is capped (TAIL_DRAIN_MAX) and the pump re-runs while it is behind,
   * so a pointer that is far behind catches up in pieces rather than in one
   * read. Returns null when there is no log yet; the caller retries on the
   * next snapshot.
   *
   * HARNESS DISPATCH is the reader's declared sessionEvents slot
   * (readers/types.ts): no slot, no tail (pi's live events ride its socket).
   * The file is the reader's own locate (transcriptFileOf), the same answer
   * transcriptFile() gives the ingest's gate. For claude both derivations are
   * the same bytes: toInfo lifts harnessSessionId from the id-kind, non-premint,
   * non-parked agentSession ref, and claudeReader.locate builds
   * sessionFilePath(cwd, ref.id) from exactly that ref, so the path the old
   * claude-only code built here is the path locate answers. A "lines" source
   * rides the SessionTailParser with the reader's eventOf (claude's is the
   * tailEventOf the parser always defaulted to); a "poll" source (opencode's
   * sqlite) rides the heartbeat with a reader-defined cursor, below. */
  subscribe(handle: string, cb: (batch: OverlayBatch) => void, from: number | null): TailSub | null {
    const info = this.infoFor(handle);
    if (!info) return null;
    const src = readerFor(info.kind)?.sessionEvents;
    if (!src) return null; // this harness declares no activity tail
    const located = transcriptFileOf(info);
    if (!located) return null; // no session log; retried on the next snapshot
    const path = located.path;
    const sessionId = located.sessionId || handle;
    if (src.mode === "poll") return this.subscribePoll(handle, sessionId, path, src.since, cb, from);
    if (path.includes("#")) return null; // a lines source needs an append-only file
    const existing = this.overlayTails.get(handle);
    if (existing) {
      existing.cb = cb; // defensive re-subscribe: swap the callback, keep the watch
      return { stop: () => this.stopOverlayTail(handle), at: existing.parser.offset };
    }
    const parser = new SessionTailParser(path, src.eventOf);
    const size = Bun.file(path).size;
    parser.offset = from !== null && from >= 0 && from <= size ? from : size;
    const at = parser.offset;

    const w: OverlayTail = { path, parser, pump: () => {}, chain: Promise.resolve(), cb };
    w.pump = () => {
      w.chain = w.chain
        .then(async () => {
          const before = w.parser.offset;
          const events = await w.parser.drain();
          const { queueOps, consumed, delivered } = w.parser;
          // only a drain that consumed bytes has fresh side lists (a quiet
          // drain returns early and leaves the previous drain's copies behind)
          if (w.parser.offset !== before) {
            w.cb({ events, queueOps, consumed, delivered, offset: w.parser.offset });
          }
          // still behind the file's end: the next piece, after a turn of the loop
          if (w.parser.behind && this.overlayTails.get(handle) === w) setTimeout(w.pump, 0);
        })
        .catch((e) => console.error(`[session-tail] ${sessionId} drain:`, e));
    };
    if (!this.fileWatchers.add(path, w.pump)) return null; // file not there yet; retried on the next snapshot
    this.overlayTails.set(handle, w);
    this.ensureTailPoll();
    console.log(`[session-tail] + ${sessionId} -> ${path} @${at}`);
    w.pump(); // flush the pointer gap right away
    return { stop: () => this.stopOverlayTail(handle), at };
  }

  /* The backfill's span read. `handle` names whose pane the file belongs to,
   * so the span parses lines with that harness's own eventOf; absent (or an
   * unknown pane, or a poll-mode harness, which never backfills by bytes) it
   * parses as claude, the exact function every existing caller got. */
  async readTranscriptSpan(path: string, from: number, to: number, handle?: string): Promise<OverlayBatch> {
    const batch: OverlayBatch = { events: [], queueOps: [], consumed: [], delivered: [], offset: from };
    const f = Bun.file(path);
    if (!(await f.exists())) return batch;
    const end = Math.min(to, f.size);
    if (end <= from) return batch;
    const info = handle ? this.infoFor(handle) : undefined;
    const src = info ? readerFor(info.kind)?.sessionEvents : undefined;
    const eventOf = src?.mode === "lines" ? src.eventOf : tailEventOf;
    batch.offset = await streamLinesForward(f, from, end, (line, off) => {
      const t = line.trim();
      tailSideOf(t, off, batch);
      const ev = eventOf(t, off);
      if (ev) batch.events.push(ev);
    });
    return batch;
  }

  private stopOverlayTail(handle: string): void {
    const w = this.overlayTails.get(handle);
    if (!w) return;
    this.overlayTails.delete(handle);
    this.fileWatchers.remove(w.path, w.pump);
    this.maybeStopTailPoll();
  }

  /* The poll-mode activity tail (opencode). The store is not append-only, so
   * there is nothing to fs.watch line by line: the reader's `since` answers
   * everything newer than the cursor, the heartbeat pumps it, and a statSync
   * of the store (+ its -wal sidecar, where sqlite lands commits) gates the
   * query so a quiet beat costs two stats and no db open. `from` is the saved
   * cursor (the ingest keeps it in the same tail pointer bytes live in); null
   * means never read, cursor 0, so the FIRST drain returns the whole session
   * -- the poll form's backfill, one batch, deduped downstream by rid.
   * fs.watch on the store file is armed as the fast path when it exists, but
   * the heartbeat alone is sufficient (the tail-poll test's inert-pool rule). */
  private subscribePoll(handle: string, sessionId: string, path: string,
    since: (path: string, cursor: number) => Promise<{ events: SessionEvent[]; cursor: number } | null>,
    cb: (batch: OverlayBatch) => void, from: number | null): TailSub | null {
    const existing = this.pollTails.get(handle);
    if (existing) {
      existing.cb = cb; // defensive re-subscribe: swap the callback, keep the poll
      return { stop: () => this.stopPollTail(handle), at: existing.cursor };
    }
    const statPath = path.includes("#") ? path.slice(0, path.lastIndexOf("#")) : path;
    if (!statKeyOf(statPath)) return null; // store not there yet; retried on the next snapshot
    const at = from !== null && from >= 0 ? from : 0;
    const w: PollTail = { path, statPath, since, cursor: at, statKey: "", pump: () => {}, chain: Promise.resolve(), cb };
    w.pump = () => {
      w.chain = w.chain
        .then(async () => {
          const key = statKeyOf(w.statPath);
          if (!key || key === w.statKey) return; // store unchanged since last drain
          const got = await w.since(w.path, w.cursor);
          if (!got) return; // unreadable this beat (locked): statKey untouched, retried next beat
          w.statKey = key;
          if (got.cursor === w.cursor && got.events.length === 0) return;
          w.cursor = got.cursor;
          w.cb({ events: got.events, queueOps: [], consumed: [], delivered: [], offset: got.cursor });
        })
        .catch((e) => console.error(`[session-poll] ${sessionId} drain:`, e));
    };
    // fast path only; a missing watcher is fine, the heartbeat is the guarantee
    this.fileWatchers.add(w.statPath, w.pump);
    this.pollTails.set(handle, w);
    this.ensureTailPoll();
    console.log(`[session-poll] + ${sessionId} -> ${w.statPath} @${at}`);
    w.pump(); // flush the cursor gap right away
    return { stop: () => this.stopPollTail(handle), at };
  }

  private stopPollTail(handle: string): void {
    const w = this.pollTails.get(handle);
    if (!w) return;
    this.pollTails.delete(handle);
    this.fileWatchers.remove(w.statPath, w.pump);
    this.maybeStopTailPoll();
  }

  /* The thinking-indicator tail (was server.ts startStatusTail). Watches
   * the session's transcript from EOF and emits only the newest turn edge per
   * drain. Returns null when the file cannot be resolved or is not append-only
   * (opencode's `db#id`); the caller retries on the next snapshot. */
  subscribeStatus(handle: string, cb: (edge: TurnEdge) => void): (() => void) | null {
    const info = this.infoFor(handle);
    if (!info) return null;
    const located = transcriptFileOf(info);
    const csid = located?.sessionId ?? info.harnessSessionId;
    const path = located?.path ?? null;
    if (!path || !csid || path.includes("#")) return null; // no append-only file; retried on the next snapshot
    const sessionId = info.harnessSessionId ?? handle;
    const edgeOf = readerFor(info.kind)?.turnEdge ?? turnEdgeFromLine;
    const existing = this.statusTails.get(handle);
    if (existing) {
      existing.cb = cb;
      return () => this.stopStatusTail(handle);
    }
    const parser = new TurnStatusParser(path, edgeOf);
    parser.offset = Bun.file(path).size; // only edges appended from now on matter
    const w: StatusTail = { path, parser, pump: () => {}, chain: Promise.resolve(), cb };
    w.pump = () => {
      w.chain = w.chain
        .then(async () => {
          const edge = await w.parser.drain();
          if (edge) w.cb(edge);
        })
        .catch((e) => console.error(`[status-tail] ${sessionId} drain:`, e));
    };
    if (!this.fileWatchers.add(path, w.pump)) return null; // file not there yet; retried on the next snapshot
    this.statusTails.set(handle, w);
    this.ensureTailPoll();
    return () => this.stopStatusTail(handle);
  }

  private stopStatusTail(handle: string): void {
    const w = this.statusTails.get(handle);
    if (!w) return;
    this.statusTails.delete(handle);
    this.fileWatchers.remove(w.path, w.pump);
    this.maybeStopTailPoll();
  }

  /* Close pooled watchers whose file has been quiet and untailed (was
   * server.ts fileWatchers.sweep()). */
  sweepTails(): void {
    this.fileWatchers.sweep();
  }

  /* sendInput IS deliverToPane: the adapter's own collaborators, the same
   * single function.
   *
   * The server's deliver call sites route through this verb. The server's
   * own collaborators -- its `unsubmitted` map (shared with the onAgents purge
   * and restart), its single keyboard queue (`onPaneKeyboard`, shared with
   * restart), its `sessionByHandle` lookup and its chooser-publishing `paneBox` --
   * are still the ones delivery must use until those clusters move behind the
   * adapter. They arrive as `deps`; when absent (standalone, mux.test.ts) the
   * adapter's own collaborators answer instead. */
  /* LANE B (design Gap 1): how this pane's harness takes input. The pane's
   * reader declares it (readers/pi.ts is "direct"); everything else, and any
   * unknown pane, is "keystroke". */
  inputMethod(handle: string): InputDelivery {
    const info = this.infoFor(handle);
    return (info && readerFor(info.kind)?.inputDelivery) ?? "keystroke";
  }

  /* Register or clear the live direct-input endpoint for a pane (the pi RPC
   * channel). A registered endpoint is used by sendInput only for a pane whose
   * reader is "direct"; clearing it falls delivery back to keystrokes. */
  registerDirectInput(handle: string, endpoint: DirectInputEndpoint | null): void {
    if (endpoint) this.directEndpoints.set(handle, endpoint);
    else this.directEndpoints.delete(handle);
  }

  async sendInput(handle: string, text: string, deliveryId: string, takenAt?: number,
    deps?: Omit<DeliverDeps, "mux">): Promise<void> {
    /* LANE B: the DIRECT path. When this pane's harness takes input directly
     * (pi) AND a live endpoint is registered, hand his message to that endpoint
     * -- pi's RPC `prompt` command -- instead of typing it into the pane. No
     * sendText, no Enter: the direct channel submits it. Absent an endpoint we
     * fall through to the keystroke guard below, so "direct" never strands a
     * message on a pane whose channel is not up. */
    if (this.inputMethod(handle) === "direct") {
      const endpoint = this.directEndpoints.get(handle);
      if (endpoint) {
        await endpoint.send(text);
        return;
      }
    }
    return deliverToPane({
      mux: this.mux,
      unsubmitted: deps?.unsubmitted ?? this.unsubmitted,
      onPaneKeyboard: deps?.onPaneKeyboard ?? ((fn) => this.onPaneKeyboard(fn)),
      sessionFor: deps?.sessionFor ?? ((h) => this.sessionFor(h)),
      readScreen: deps?.readScreen ?? ((h) => this.parseScreen(h)),
      canParseScreen: deps?.canParseScreen ?? ((h) => this.canParseScreen(h)),
    }, handle, text, deliveryId, takenAt);
  }

  async interrupt(handle: string): Promise<void> {
    await this.mux.sendKeys(handle, "ctrl+c");
  }

  /* The raw typed-input pass-throughs (see the interface note): the shell-typing
   * call sites route through the adapter instead of a raw mux reference. No
   * chooser guard, no delivery queue; the callers own those where they need
   * them (pane-deliver's restart holds onPaneKeyboard; session-verbs' onAnswer
   * checks the ask under the lock before pressing). */
  async sendText(handle: string, text: string): Promise<void> {
    await this.mux.sendText(handle, text);
  }

  async sendKeys(handle: string, ...keys: string[]): Promise<void> {
    await this.mux.sendKeys(handle, ...keys);
  }

  /* The spawn-side pane ops (new-session / places / rename / exit). Each
   * is the Multiplexer verb verbatim, under the agent-shaped name core sees.
   * `spawn` folds the workspace derivation (workspaceOf(near)) and the label
   * (basename(cwd)) that server.ts used to compute beside newTab into one call,
   * so core asks only for a cwd and a command and never names a workspace. */
  async spawn(opts: { cwd: string; nearHandle?: string | null; command: string }):
    Promise<{ handle: string }> {
    /* PRE-TRUST THE FOLDER (trust-folder.ts). Before the pane is created, mark
     * opts.cwd trusted in the harness's own config so an engine-spawned claude
     * or codex never opens on the first-run "Do you trust this folder?" dialog,
     * whose default is "No, exit" -- where the app's first message would type
     * itself and quit the harness. Starting a session in a folder from the app
     * IS the trust; this writes the exact bit a human clears the dialog to set.
     * Idempotent, and a missing/locked config falls back to today's behavior
     * without throwing, so it can never fail the spawn. */
    preTrustLaunchFolder(opts.cwd, opts.command);
    /* EVENT-SOCKET HARNESS (additive): a reader that declares `eventSocket`
     * (today only pi) binds a per-pane unix socket and decorates its own launch
     * through `reader.launchAugment` before the harness starts, so the harness
     * connects to a server that is already listening. The reader is resolved
     * from the launch command's program token (readerForLaunchCommand), the
     * same match the old isPiLaunchCommand sniff did -- so the generic spawn
     * path dispatches on the reader declaration, not a pi command-string test.
     * Every non-eventSocket command is passed through byte-identical, and a bind
     * failure just leaves the plain command (the transcript reader still covers
     * the pane). */
    let command = opts.command;
    let server: PiEventServer | null = null;
    const reader = readerForLaunchCommand(command);
    if (reader?.eventSocket) {
      const key = piSockKey(command);
      try {
        const dir = piRunDir();
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const sockPath = piEventSockPath(dir, key);
        server = new PiEventServer(sockPath);
        await server.listen();
        command = reader.launchAugment
          ? reader.launchAugment(opts.command, { sockPath, agentId: key })
          : opts.command;
      } catch (e) {
        if (server) { try { server.close(); } catch { /* ignore */ } }
        server = null;
        command = opts.command; // fall back to the plain launch; transcript covers it
        console.error(`[pi-events] could not bind for a pi launch: ${(e as Error)?.message}`);
      }
    }
    const handle = await this.mux.newTab({
      workspaceId: opts.nearHandle ? this.mux.workspaceOf(opts.nearHandle) : null,
      cwd: opts.cwd,
      label: opts.cwd.split("/").filter(Boolean).pop() ?? "claude",
      command,
    });
    if (server) {
      // a re-spawn onto the same handle replaces any prior server
      this.stopPiServer(handle);
      this.piServers.set(handle, server);
      /* THE pi IDENTITY TAP. The pi output extension emits a pi.session frame
       * with the session's own uuid; recording it as this pane's announced bind
       * (recordHookBind, idempotent, latest-wins) lets the next poll flow it
       * through the normal evidence order with every fork/steal protection, the
       * same as an announce. Attached BEFORE the pane command is typed, so the
       * first frame is not missed. isHarnessSessionId gates it to a real uuid;
       * pid 0 is log-only (the bind carries no process).
       *
       * AND, THE ENGINE-OWNED DIRECT CARRY. pi is engine-spawned, so the engine
       * owns this pane's handle (adoptAgentId's pane binding). The announced
       * bind above still needs herdr to classify/snapshot the pane before
       * herdr.ts lifts hookBindFor into the session, which is exactly the step
       * that intermittently misses for pi (herdr often leaves our pi pane
       * unstamped/absent). So we ALSO carry the id straight onto the bound
       * agent here, through the same adoptSession reconcile uses, the instant
       * the socket delivers -- deterministic regardless of herdr. It fills a
       * null id only and defers a different id to rollover, so it is idempotent
       * with (and converges on) the later reconcile carry. This is scoped to
       * the engine's OWN spawned pane + handle, so no announce/witness/fence is
       * touched, and no non-pi harness reaches this tap. */
      server.onSession((sid) => {
        if (!isHarnessSessionId(sid)) return;
        recordHookBind(handle, sid, 0);
        carryDirectHandleBind(handle, sid);
      });
    }
    return { handle };
  }

  /* THE PI EXTENSION EVENT STREAM. Attach a consumer to the pane's socket
   * server (bound by spawn); frames buffered before now are flushed on attach.
   * Null for a pane with no server (non-pi, hand-started, old pi). */
  subscribePiEvents(handle: string, cb: (frame: PiFrame) => void): (() => void) | null {
    const server = this.piServers.get(handle);
    if (!server) return null;
    server.onFrame(cb);
    // The server outlives one subscriber (close is on pane close); detach just
    // this consumer, so a stopped ingest's callback stops receiving frames
    // instead of the unsubscribe being a no-op.
    return () => { server.offFrame(cb); };
  }

  private stopPiServer(handle: string): void {
    const server = this.piServers.get(handle);
    if (!server) return;
    this.piServers.delete(handle);
    try { server.close(); } catch { /* ignore */ }
  }

  async rename(handle: string, label: string): Promise<void> {
    await this.mux.renamePane(handle, label);
  }

  async close(handle: string): Promise<void> {
    this.stopPiServer(handle);
    await this.mux.closePane(handle);
  }

  knownCwds(): string[] {
    return this.mux.knownCwds();
  }

  /* The reader capabilities server asks about instead of branching on
   * s.agent.dialogs / s.agent.composer / s.agent.launch. */
  canParseScreen(handle: string): boolean {
    const info = this.infoFor(handle);
    return info ? !!readerFor(info.kind)?.parseScreen : false;
  }

  /** Whether the mux has a transcript reader for this agent kind (context/model). */
  hasTranscript(kind: string): boolean {
    return !!readerFor(kind);
  }

  /** Whether this kind's reader declares the activity-event slot (claude,
   *  codex, opencode today); read off the READERS table, never a kind list. */
  hasSessionEvents(kind: string): boolean {
    return !!readerFor(kind)?.sessionEvents;
  }

  /** The command that starts a fresh instance of this agent, or null. */
  launchCommand(kind: string): string | null {
    return readerFor(kind)?.launch?.command ?? null;
  }

  /** The command that resumes a session, or null. */
  resumeCommand(kind: string, sessionId: string): string | null {
    return readerFor(kind)?.launch?.resume(sessionId) ?? null;
  }

  /** Every reader kind that can be launched fresh, in READERS order. The plus
   *  menu offers these (each still filtered by a PATH probe in the route). */
  launchableKinds(): Array<{ kind: string; command: string }> {
    return READERS.filter((r) => r.launch)
      .map((r) => ({ kind: r.tag, command: r.launch!.command }));
  }

  /** Every harness kind + its declared capabilities, in READERS order: the one
   *  source of truth the capability core (harness-caps.ts) and the usage-card's
   *  kind list are derived from. */
  harnessProfiles(): ReadonlyArray<{ tag: string; caps: HarnessCaps }> {
    return READERS.map((r) => ({ tag: r.tag, caps: r.capabilities }));
  }

  /** This kind's own restart gone-wait ceiling, or null when its reader does
   *  not declare one (the shipped default applies). pane-deliver.ts asks this
   *  so the one place that spells out how slowly a harness quits is its
   *  reader, not a literal in the restart ladder. */
  quitWaitMs(kind: string): number | null {
    return readerFor(kind)?.quit?.waitMs ?? null;
  }

  /** This kind's own restart quit key sequence, or null when its reader does
   *  not declare one (the shipped RESTART_QUIT_PRESSES x "ctrl+c" applies).
   *  pane-deliver.ts asks this so the quit KEYS, like the gone-wait, live in
   *  the reader and not in the restart ladder. */
  quitKeys(kind: string): string[] | null {
    return readerFor(kind)?.quit?.keys ?? null;
  }

  /** The non-claude context/model read (was server.ts refreshContext's generic
   *  branch): locate the transcript, then read contextPct and model through the
   *  reader. Null when there is no reader or the transcript cannot be located. */
  async contextRead(handle: string): Promise<{ pct: number | null; model: string | null } | null> {
    const info = this.infoFor(handle);
    if (!info) return null;
    const reader = readerFor(info.kind);
    const located = reader ? transcriptFileOf(info) : null;
    if (!reader || !located) return null;
    const [pct, model] = await Promise.all([
      reader.contextPct(located.path),
      reader.model(located.path),
    ]);
    return { pct, model };
  }

  /** The adapter's session-shaped guard, from its own agent snapshot. */
  private sessionFor(handle: string): DeliverSession | undefined {
    const info = this.infoFor(handle);
    if (!info) return undefined;
    return { agent: agentLabel(info.kind), status: info.statusHint };
  }

  /* THE ONE QUEUE for anything that touches a pane's keyboard, moved from
   * server.ts alongside deliverToPane. */
  private onPaneKeyboard<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.deliverChain.then(fn);
    this.deliverChain = next.then(() => {}, () => {});
    return next;
  }

  /* The delivery-guard screen read (today server.ts readPaneScreen),
   * exposed so server's readPaneScreen/paneBox route through the adapter
   * instead of the raw herdr client. Same read: 500 lines, classifyPaneBox,
   * truncated fails closed. */
  async parseScreen(handle: string):
    Promise<{ box: PaneBox | { kind: "unreadable" }; text: string }> {
    try {
      const { text, truncated } = await this.mux.readPane(handle, BOX_READ_LINES);
      if (truncated) {
        console.error(`[deliver] ${handle}: read came back truncated; treating the pane as unreadable`);
        return { box: { kind: "unreadable" }, text: "" };
      }
      return { box: classifyPaneBox(text), text };
    } catch {
      return { box: { kind: "unreadable" }, text: "" };
    }
  }

  /* The ask-state screen read that used to live in server.ts readAskNow.
   * Reads the pane and parses the ask exactly as readAskNow did (60 lines,
   * control sequences stripped inside parseAsk). Returns the
   * AgentConversation.blocked shape; core maps it back to its AskState cache. */
  private async readBlocked(handle: string): Promise<AgentConversation["blocked"]> {
    const info = this.infoFor(handle);
    if (info && !readerFor(info.kind)?.parseScreen) {
      /* An agent whose dialogs this mux cannot parse: no screen read, no claude
       * parser pointed at a foreign screen. The "unsupported" why is what
       * server.ts askOf used to produce from s.agent.dialogs === null. */
      return { ask: null, why: "unsupported" };
    }
    try {
      const { text, truncated } = await this.mux.readPane(handle, ASK_READ_LINES);
      if (truncated) {
        console.error(`[ask] read ${handle}: truncated; treating as unreadable`);
        return { ask: null, why: "unread" };
      }
      const ask = parseAsk(text);
      return ask ? { ask } : { ask: null, why: "unrecognised" };
    } catch (e) {
      console.error(`[ask] read ${handle}:`, e);
      return { ask: null, why: "unread" };
    }
  }
}
