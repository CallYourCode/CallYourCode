/* THE ONE TYPED CORE API PLUGINS PROGRAM AGAINST: `PluginCore`.
 *
 * No buckets, no needs declaration, no scoped handle. Core hands every plugin the
 * SAME typed API object at load; a plugin uses whatever subset it wants. This one
 * object is what will replace every bespoke untyped deps bag in
 * server.ts. It is DEFINED, CONSTRUCTED and unit-tested standalone here; no
 * existing plugin is routed through it yet, so the deps-bag
 * mechanism stays intact for now.
 *
 * The flat surface, with today's implementation behind each item:
 *   store / agentStore / deliver / agentIds   the minimal PluginHost (host.ts)
 *   read / command / has / usage              the capability dispatch (capability-dispatch.ts)
 *   tts.list / tts.sample                      the core voice engine, plain members
 *   inputTransform                             the outgoing-input prefix/postfix hook (the delivery site applies it)
 *   paneTerminalStream                         raw pane bytes for the terminal primitive
 *   notifyDevices                              the engine -> devices push (sealed wire)
 *   searchChat                                 the one neutral chat matcher
 *
 * Answers are VALUES, never live adapter references: a plugin cannot hold a mux
 * or harness object, and never sees a SessionRef.
 *
 *   bun test agent-engine/src/plugins/platform/core.test.ts
 */

import type { CommandKey, CommandResult, HarnessInfo, ReadKey, ReadResult, TranscriptOpts } from "../../runtime/capabilities.ts";
import type { CapabilityDispatch } from "../../runtime/capability-dispatch.ts";
import { makePluginHost, type HostWiring, type PluginDelivery, type PluginStore, type DeliveryResult } from "./host.ts";
import type { TerminalHandlers, TerminalSession } from "../../terminal/terminal.ts";
/* The filesystem/git VERBS a plugin reaches through `core.fs` (below). They are
 * PURE, root-scoped functions (no session state, no engine handle), so the
 * contract's implementation is just these functions namespaced: git.ts and
 * files.ts call `core.fs.*` instead of importing this module, and never touch
 * live session state. `files.ts` itself is engine code, so importing it HERE (in
 * the core layer) is allowed; a plugin importing it is what the layering forbids. */
import {
  RAW_MAX_BYTES, fmtBytes, imageMimeOf, resolveInRoot, rootOf,
  listDir, readFile, gitStatus, gitDiff,
  gitPane, gitBranches, gitRefLog, gitCompare, gitFilePatch, gitChange, gitCommitPatch,
} from "../../storage/files.ts";
import type {
  FsList, FsRead, GitStatus, GitDiff, GitPane, GitPatch,
  GitBranches, GitRefLog, GitCompare, GitChange, ChangeWhat, CompareAgainst,
} from "../../storage/files.ts";

/* ---- the core-service member shapes (plain members, no adapter seam) ---- */

/** The core VOICE service the voice plugin reads.
 *  `list`/`sample` are the TTS engine (`sample` answers base64 audio, or null
 *  when the engine could not render it). The rest is the per-session voice choice
 *  and the host default, backed by core session-state (voiceOverrideOf /
 *  setVoiceOverride / globalVoice / setDefaultVoice) -- NOT moved data, the same
 *  state the /voices and /session/<id>/voice routes use, so core's own `voiceFor`
 *  still resolves the voice. `sessionExists` is the panel's session guard (the
 *  gate must run before a host-wide setDefault). */
export type TtsService = {
  list(): Promise<string[]>;
  sample(voice: string): Promise<string | null>;
  /** the session's voice override, or '' when it is on the host/global default */
  voiceOf(sessionId: string): string;
  /** write ('' clears) the session's voice override, persisted */
  setVoice(sessionId: string, voice: string): void;
  /** the host default the override falls back to */
  globalDefault(): string;
  /** set ('' clears) the host default, persisted */
  setDefault(voice: string): void;
  /** whether the engine knows this session (the panel's session guard) */
  sessionExists(sessionId: string): boolean;
};

/** THE FILESYSTEM/GIT CAPABILITY a plugin reaches through `core.fs`. Every verb
 *  is ROOT-SCOPED: the caller turns the session's `cwd` (from
 *  `core.read("cwd", id)`) into a real root with `rootOf`, then asks these
 *  root-relative questions. Nothing here holds a session or an engine handle, so
 *  a plugin gets the fs/git verbs it always used without importing files.ts and
 *  without reaching live session state. `RAW_MAX_BYTES`/`fmtBytes` ride along as
 *  the pure cap/format helpers the file panel needs. */
export type FsCapability = {
  /** the session's cwd as a real path; everything else is measured against it */
  rootOf(cwd: string): Promise<string>;
  /** a root-relative path -> an absolute path inside the root, or null (outside) */
  resolveInRoot(rootReal: string, wanted: string): Promise<string | null>;
  imageMimeOf(name: string): string | null;
  fmtBytes(n: number): string;
  readonly RAW_MAX_BYTES: number;
  // ---- file browser reads ----
  listDir(rootReal: string, wanted: string): Promise<FsList>;
  readFile(rootReal: string, wanted: string): Promise<FsRead>;
  gitStatus(rootReal: string): Promise<GitStatus>;
  gitDiff(rootReal: string, wanted: string): Promise<GitDiff>;
  // ---- git pane reads ----
  gitPane(rootReal: string): Promise<GitPane>;
  gitBranches(rootReal: string): Promise<GitBranches>;
  gitRefLog(rootReal: string, ref: string): Promise<GitRefLog>;
  gitCompare(rootReal: string, ref: string, against: CompareAgainst): Promise<GitCompare>;
  gitFilePatch(rootReal: string, wanted: string, side: "staged" | "unstaged"): Promise<GitPatch>;
  gitChange(rootReal: string, what: ChangeWhat, sha: string): Promise<GitChange>;
  gitCommitPatch(rootReal: string, sha: string): Promise<GitPatch>;
};

/** The one implementation: the pure files.ts verbs, namespaced. Stateless, so a
 *  single shared object backs every plugin's `core.fs`. */
export const fsCapability: FsCapability = {
  rootOf, resolveInRoot, imageMimeOf, fmtBytes, RAW_MAX_BYTES,
  listDir, readFile, gitStatus, gitDiff,
  gitPane, gitBranches, gitRefLog, gitCompare, gitFilePatch, gitChange, gitCommitPatch,
};

/** One neutral chat match, in log order, as the shared matcher returns them. */
export type ChatSearchHit = { seq: number; ts: number; role: "user" | "claude"; excerpt: string };
export type ChatSearchResult = { total: number; matches: ChatSearchHit[]; scanned: number };

/** What the engine pushes to devices (section 4: rides the sealed wire, never
 *  HTTP). Structural so plugin-core stays a leaf; the composition root passes the
 *  real notifyDevices. */
export type NotifyPayload = {
  title: string;
  body: string;
  sessionId: string;
  tag?: string;
};

/** An ENGINE-LEVEL, session-less push (e.g. the usage-card plugin's plan-usage
 *  threshold alert): it belongs to a PLUGIN, not a chat, and `plugin` is its
 *  identifier (what sessionId is to a session push). Sealed under the engine
 *  notify key (never a per-session key); `open` is the sealed tap target
 *  ("usage:<host>"). The device dedup tag is built by notify.ts from the plugin
 *  id plus the optional non-sensitive `subTag` (e.g. a window label), so no
 *  account or other secret ever rides in cleartext beside the seal. The app
 *  server does no content logic on it (it forwards as-is). Structural so
 *  plugin-core stays a leaf; the composition root passes the real
 *  notifyEngineDevices. */
export type EngineNotifyPayload = {
  plugin: string;
  title: string;
  body: string;
  subTag?: string;
  open?: string;
};

/** The outgoing input a transform hook sees at the one delivery site (which
 *  applies it). A hook returns a prefix and/or postfix to wrap what gets sent;
 *  returning nothing leaves the message untouched. Generalizes the old
 *  deliveryInstruction seam, losing its "documented exception". */
export type OutgoingInput = { sessionId: string; text: string; channels: string[] };
export type InputTransformHook = (input: OutgoingInput) => { prefix?: string; postfix?: string } | void;

/* -------------------------------- PluginCore -------------------------------- */

export interface PluginCore {
  // ---- the three host verbs + the enumerator (durable data + delivery) ----
  /** durable engine-scope store for this plugin */
  store(): PluginStore;
  /** durable agent-scope store for this plugin */
  agentStore(agentId: string): PluginStore;
  /** deliver a line into an agent's pane, guardCwd identity check included */
  deliver(agentId: string, msg: PluginDelivery): Promise<DeliveryResult>;
  /** enumerate known agents (a readdir, not a session fact) */
  agentIds(): Promise<string[]>;

  // ---- meta reads / commands / probe / adapter facts (the dispatch) ----
  read(which: "model", sessionId: string): Promise<ReadResult["model"]>;
  read(which: "contextPct", sessionId: string): Promise<ReadResult["contextPct"]>;
  read(which: "transcript", sessionId: string, opts?: TranscriptOpts): Promise<ReadResult["transcript"]>;
  read(which: "status", sessionId: string): Promise<ReadResult["status"]>;
  read(which: "blocked", sessionId: string): Promise<ReadResult["blocked"]>;
  /** the session's working directory (a session-identity fact, sourced
   *  adapter->core off the session model); null when the session is unknown */
  read(which: "cwd", sessionId: string): Promise<ReadResult["cwd"]>;
  read(which: ReadKey, sessionId: string, opts?: TranscriptOpts): Promise<ReadResult[ReadKey]>;

  command(which: "sendText", sessionId: string, args: { text: string }): Promise<CommandResult>;
  command(which: "interrupt", sessionId: string): Promise<CommandResult>;
  command(which: "compact", sessionId: string): Promise<CommandResult>;
  command(which: "setModel", sessionId: string, args: { model: string }): Promise<CommandResult>;
  command(which: "answer", sessionId: string, args: { choice: string; fingerprint: string }): Promise<CommandResult>;
  command(which: CommandKey, sessionId: string, args?: Record<string, unknown>): Promise<CommandResult>;

  has(which: CommandKey, sessionId: string): boolean;
  /** an adapter fact in the owning harness's own shape (section 5.3), forwarded.
   *  Usage is a HARNESS-ACCOUNT fact: it keys on the harness KIND and takes an
   *  optional `force` (skip the cached lease, re-read upstream). */
  usage(kind: string, force?: boolean): Promise<unknown>;
  /** every harness kind this engine knows, with a live-agent flag; the usage-card
   *  folds account usage across the ACTIVE ones */
  harnesses(): HarnessInfo[];

  // ---- core services (plain members, reached directly) ----
  /** the filesystem/git verbs (root-scoped); git/files reach these instead of
   *  importing files.ts, so no plugin touches engine-internal fs code */
  fs: FsCapability;
  tts: TtsService;
  /** the one neutral chat matcher; null when the session is unknown */
  searchChat(sessionId: string, q: string): ChatSearchResult | null;
  /** the engine -> devices push (sealed wire) */
  notifyDevices(n: NotifyPayload): Promise<void>;
  /** an engine-level, session-less push sealed under the engine key (a plan-usage
   *  threshold alert): about the account, not a chat */
  notifyEngine(n: EngineNotifyPayload): Promise<void>;

  // ---- the input-transform hook (a capability, never a surface) ----
  /** register a prefix/postfix transform on the outgoing input (the delivery
   *  site applies it) */
  inputTransform(hook: InputTransformHook): void;

  // ---- the pane terminal stream (wired to the app's terminal primitive) ----
  /** open the raw pane byte stream for a session's terminal, or null when the
   *  mux cannot show one; the terminal primitive + sendText is the whole `opens:
   *  terminal` wiring (section 3.1) */
  paneTerminalStream(sessionId: string, cols: number, rows: number, h: TerminalHandlers): TerminalSession | null;
}

/** The shared services every plugin's PluginCore is composed over (built once by
 *  the composition root). The host verbs are per-plugin (bound to a plugin id);
 *  everything below is shared. */
export type PluginCoreServices = {
  dispatch: CapabilityDispatch;
  tts: TtsService;
  searchChat(sessionId: string, q: string): ChatSearchResult | null;
  notifyDevices(n: NotifyPayload): Promise<void>;
  notifyEngine(n: EngineNotifyPayload): Promise<void>;
  /** the outgoing-input transform registry: `register` records a hook; the
   *  delivery site consumes them. Only registration is wired here. */
  registerInputTransform(pluginId: string, hook: InputTransformHook): void;
  paneTerminalStream(sessionId: string, cols: number, rows: number, h: TerminalHandlers): TerminalSession | null;
};

/** Build ONE plugin's PluginCore: its own host (store/agentStore/deliver/
 *  agentIds), fronting the shared dispatch and core services. Composition-root
 *  ready; nothing here boots an engine. */
export function makePluginCore(pluginId: string, hostWiring: HostWiring, services: PluginCoreServices): PluginCore {
  const host = makePluginHost(pluginId, hostWiring);
  const d = services.dispatch;
  return {
    store: () => host.store(),
    agentStore: (aid) => host.agentStore(aid),
    deliver: (aid, msg) => host.deliver(aid, msg),
    agentIds: () => host.agentIds(),

    read: ((which: ReadKey, sessionId: string, opts?: TranscriptOpts) =>
      d.read(which as "transcript", sessionId, opts)) as PluginCore["read"],
    command: ((which: CommandKey, sessionId: string, args?: Record<string, unknown>) =>
      d.command(which as "sendText", sessionId, args as { text: string })) as PluginCore["command"],
    has: (which, sessionId) => d.has(which, sessionId),
    usage: (kind, force = false) => d.usage(kind, force),
    harnesses: () => d.harnesses(),

    fs: fsCapability,
    tts: services.tts,
    searchChat: (sessionId, q) => services.searchChat(sessionId, q),
    notifyDevices: (n) => services.notifyDevices(n),
    notifyEngine: (n) => services.notifyEngine(n),

    inputTransform: (hook) => services.registerInputTransform(pluginId, hook),

    paneTerminalStream: (sessionId, cols, rows, h) => services.paneTerminalStream(sessionId, cols, rows, h),
  };
}

/** A tiny in-core registry for input-transform hooks (used by the composition
 *  root to back `registerInputTransform`; the delivery site reads `hooks()` in
 *  the delivery site). Kept here so the shape is one definition. */
export function makeInputTransformRegistry() {
  const byPlugin = new Map<string, InputTransformHook>();
  return {
    register(pluginId: string, hook: InputTransformHook): void { byPlugin.set(pluginId, hook); },
    hooks(): InputTransformHook[] { return [...byPlugin.values()]; },
    clear(pluginId: string): void { byPlugin.delete(pluginId); },
  };
}

/** Fold every registered hook over one outgoing input, in registration order:
 *  each hook wraps the running text as `prefix + text + postfix`, so the
 *  FIRST-registered hook sits closest to the body and later ones wrap around it.
 *  A hook that returns nothing leaves the text untouched. With a single postfix
 *  hook this is exactly `text + postfix`, which is what the reply-dials
 *  instruction append was before it became a hook (byte-identical delivery).
 *  The delivery site (deliver.ts injectUserMessage) calls this once, in the same
 *  synchronous stretch that reads the dial state for the Stop-hook trace, so the
 *  appended text and the recorded ask can never see two different dial states. */
export function applyInputTransform(hooks: InputTransformHook[], input: OutgoingInput): string {
  let text = input.text;
  for (const hook of hooks) {
    const r = hook({ sessionId: input.sessionId, text, channels: input.channels });
    if (!r) continue;
    text = (r.prefix ?? "") + text + (r.postfix ?? "");
  }
  return text;
}
