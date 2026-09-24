/* wireCore: THE SEAM TIER'S REPLACEMENT FOR startEngine().
 *
 * server.ts's boot() is an ordered sequence of `initX({deps})` calls over a
 * route table and an adapter. That decomposition is what makes this possible:
 * almost every behaviour the old suite proved by spawning `bun run server.ts`
 * and dialling a real WebRTC DataChannel can be proven by performing the SAME
 * ordered wiring in-process, with fakes at the architecture seams.
 *
 * What is real here: every engine module, the herdr JSON-RPC framing, the
 * MuxAdapter, the delivery guard, the reconcile loop, the chat log on disk, the
 * sessions frame, the reply trace and its hook-state file.
 *
 * What is fake: herdr itself (a FakeHerdr on a unix socket in this test's tmp
 * dir), the app server (a pushSink on port 0, only when a test asks), the
 * clients (plain recorded Sock objects pushed into wire.ts's `clients`, every
 * frame captured), the voice engine (a refusing url), the live terminal bridge
 * (a refusing driver) and time (a manualClock). There is no Bun.serve for the
 * engine, no announce loop, no relay link, no services, no rtc, no subprocess.
 *
 * ONE wireCore PER TEST FILE by default: bun test --parallel gives each file a
 * fresh module registry in its own worker, so the module singletons a wiring
 * writes into belong to that file alone. A file whose tests need a clean slate
 * per test calls reset() (which calls every module's resetForTest and wires
 * again), and a file that wants two engines' worth of state in sequence calls
 * wireCore() twice with a stop() in between.
 *
 * THE ORDER IS THE POINT. server.ts documents four ordering hazards and every
 * one of them is load bearing, so the boot below is ONE linear sequence in
 * server.ts's own order with per-layer `if` guards inline, rather than a set of
 * per-layer builders that could each be right and collectively wrong:
 *
 *   hazard 1  the reconcile subscribes right before adapter.start(), once every
 *             module's deps are wired: a snapshot arriving mid-boot must not
 *             land on an uninitialised module.
 *   hazard 2  initSessionsFrame runs AFTER the plugin decls exist, because the
 *             frame declares them.
 *   hazard 3  sessionStateReady() is the last line: it flips the meta-save gate
 *             and flushes what boot parked.
 *   hazard 4  the route table's one context. NOT reproduced here (there is no
 *             Bun.serve); test-utils/serve-routes.ts is that seam.
 *
 * The duplication of server.ts's wiring lives HERE and nowhere else; shape
 * drift is caught by the type system and behaviour drift by e2e/roundtrip.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { HerdrClient } from "../terminal/herdr.ts";
import { MuxAdapter } from "../adapters/mux-adapter.ts";
import type { MultiplexerAdapter } from "../adapters/mux-adapter.ts";
import type { TerminalDriver } from "../terminal/terminal.ts";
import type { Sock, SockData } from "../transport/sock.ts";
import type { PluginDecl } from "../plugins/platform/spec.ts";

import { dataDir, ensureBaseTree, keysFile, stagingUploadsDir } from "../storage/datadir.ts";
import { repairRunTree } from "../../../shared/runfiles.ts";
import { makeUploads, type Uploads } from "../chat/uploads.ts";
import { groupingFrom, type Grouping } from "../sessions/tabs.ts";
import { titleOf } from "../sessions/title.ts";
import { makeReconcile, resetReconcileForTest as resetReconcile } from "../sessions/reconcile.ts";
import { loadOrCreateE2E, type E2EState } from "../security/sec.ts";
import { sealPushItem, sealEngineItem } from "../security/sealpush.ts";
import { scanChat } from "../chat/chat-search.ts";
import { searchableText } from "../chat/chatmsg.ts";
import { loadPlugins, declarePlugins } from "../plugins/registry.ts";
import type { PluginSpec } from "../plugins/platform/spec.ts";

import { clients, send, broadcast, resetForTest as resetWire } from "../transport/wire.ts";
import { initReadState, resetForTest as resetReadState } from "../sessions/readstate.ts";
import { initClips } from "../chat/clips.ts";
import { initContextCache, claudeTitleOf,
  resetForTest as resetContextCache } from "../sessions/context-cache.ts";
import { sessions, sessionByHandle, resolveSession, loadSessionState, sessionStateReady,
  agentMetas, blobOwner, restoredChats, chatStore, indexMsgBlobs, agentIdFor,
  chatRefFor, persistPatch, metaFor, scheduleAgentSave, scheduleHeardSave,
  nameOverrideOf, voiceFor, docDirFor, adoptAgentId,
  resetForTest as resetSessionState, type Session } from "../sessions/session-state.ts";
import { initChatlog, logSession, sweepRestoredQueued, resetForTest as resetChatlog } from "../chat/chatlog.ts";
import { initTts, sweepGrowingClips, resetForTest as resetTts } from "../voice/tts.ts";
import { initAsks, publishAsk, resetForTest as resetAsks } from "../chat/asks.ts";
import { resetHookAnnounce } from "../terminal/hook-announce.ts";
import { initPaneDeliver, deliverToPane, onPaneKeyboard,
  resetForTest as resetPaneDeliver } from "../chat/pane-deliver.ts";
import { PaneNotReady } from "../adapters/mux-adapter.ts";
import { newCid } from "../../../shared/logbook.ts";
import { replyDialsStore, resetForTest as resetReplyDials } from "../plugins/reply-dials/index.ts";
import { initReplyTrace, noteDelivery, forgetDelivery, noteReply,
  writeHookState, resetForTest as resetReplyTrace } from "../chat/reply-trace.ts";
import { makeInputTransformRegistry, applyInputTransform, makePluginCore,
  type PluginCore, type PluginCoreServices, type InputTransformHook } from "../plugins/platform/core.ts";
import { makeCapabilityDispatch } from "../runtime/capability-dispatch.ts";
import { makeHarnessCaps } from "../runtime/harness-caps.ts";
import type { AgentLifecycle } from "../readers/types.ts";
import type { HostWiring } from "../plugins/platform/host.ts";
import { initIngest, resetForTest as resetIngest } from "../chat/ingest.ts";
import { initReply } from "../chat/reply.ts";
import { initLineage, lineageOf, resetForTest as resetLineage } from "../sessions/lineage.ts";
import { initAttach } from "../chat/attach.ts";
import { initSessionsFrame, broadcastSessions, sessionsFrame, sendHelloBurst,
  resetForTest as resetSessionsFrame } from "../sessions/sessions-frame.ts";
import { initDeliver, injectUserMessage, inOrder, deliverToAgent,
  resetForTest as resetDeliver } from "../chat/deliver.ts";
import { initTranscribe } from "../voice/transcribe.ts";
import { initShowHandler } from "../chat/show-handler.ts";
import { initSessionVerbs, compactSession } from "../sessions/session-verbs.ts";
import { initMcp } from "../runtime/mcp.ts";
import { initFrames } from "../transport/frames.ts";
import { initPresence, resetForTest as resetPresence } from "../sessions/presence.ts";
import { initNotify, notifyUnlessWatched, sendDismissal, flushUnread,
  resetForTest as resetNotify } from "../chat/notify.ts";

import { fakeHerdr, defaultSessionIdOf, PANE, type FakeHerdr, type Hooks } from "./fake-herdr.ts";
import { pushSink } from "./push-sink.ts";
import { manualClock, type ManualClock } from "../runtime/clock.ts";
import { tmpDataDir, sockPath } from "./tmp.ts";

/* A TERMINAL DRIVER THAT REFUSES. The live-terminal bridge spawns
 * `herdr terminal session control`, a real subprocess against a real herdr, and
 * no seam test wants one. terminal.test.ts drives the drivers directly with
 * fakes of its own; anything here that reaches for one is a bug in the test. */
export function refusingDriver(): TerminalDriver {
  const no = () => { throw new Error("a seam test asked for a live terminal bridge"); };
  return { open: no, canResize: no, paneMode: no } as unknown as TerminalDriver;
}

/* AND A VOICE ENGINE THAT REFUSES, for the same reason. voiceUrl() probes real
 * hosts over the network to pick a healthy one; tts.ts and transcribe.ts are
 * wired over this instead, so a seam test that accidentally reaches for speech
 * fails loudly here rather than hanging on a probe or, worse, reaching his
 * actual voice engine. A test about speech fakes the fetch itself. */
async function refusingVoiceUrl(): Promise<string> {
  throw new Error("a seam test asked for the voice engine");
}

/** One recorded client socket: every frame the engine wrote to it, in order. */
export type FakeClient = {
  sock: Sock;
  /** every frame sent to this client, parsed, in order */
  frames: Record<string, any>[];
  /** frames of one type, in order */
  of(t: string): Record<string, any>[];
  /** the newest frame of a type, or undefined */
  last(t: string): Record<string, any> | undefined;
  /** forget everything so far: "what happened AFTER this point" */
  clear(): void;
  /** the socket says it is (or is not) looking at the chat */
  setVisible(on: boolean, at?: number): void;
  /** attach it to a session, the way the attach frame does */
  attached(id: string | null): void;
  /** drop it from wire.ts's client set, as a close would */
  close(): void;
};

let cid = 0;

/** A client socket the engine can write to, registered in wire.ts's `clients`.
 *
 * A plain object, not a WebSocket: `send`, `close` and `data` are every member
 * the wire and the client dispatch touch, and a recorded object is the only way
 * to ask "what did this device receive, in what order" without a transport. */
export function fakeClient(o: { now?: () => number; attach?: string | null; visible?: boolean } = {}): FakeClient {
  const frames: Record<string, any>[] = [];
  const now = o.now ?? Date.now;
  const data: SockData = {
    role: "client",
    sessionId: null,
    attached: o.attach ?? null,
    visible: o.visible ?? true,
    visibleAt: now(),
    beatMs: 0,
    gaps: [],
    lastFrame: now(),
    pongAt: 0,
    probeAt: 0,
    probeSeq: 0,
    cid: ++cid,
    openedAt: now(),
    tailing: null,
    terms: new Map(),
    remoteAddr: "127.0.0.1",
  };
  const sock = {
    data,
    readyState: 1,
    send(s: string) {
      try { frames.push(JSON.parse(s)); } catch { frames.push({ t: "<unparsable>", raw: s }); }
      return s.length;
    },
    close() { clients.delete(sock as unknown as Sock); },
    remoteAddr: "127.0.0.1",
  } as unknown as Sock;
  clients.add(sock);
  return {
    sock,
    frames,
    of: (t) => frames.filter((f) => f.t === t),
    last: (t) => [...frames].reverse().find((f) => f.t === t),
    clear: () => { frames.length = 0; },
    setVisible(on, at) {
      sock.data.visible = on;
      sock.data.visibleAt = at ?? now();
      sock.data.lastFrame = at ?? now();
    },
    attached(id) { sock.data.attached = id; },
    close() { clients.delete(sock); },
  };
}

/* THE LAYERS, and why they are opt-in.
 *
 * The whole graph is one ordered sequence, but no test needs all of it, and a
 * layer nobody asked for is state nobody asserts on that can still fail a run.
 * A delivery test does not want a plugin registry; a notify test does not want
 * a terminal. So each layer is a set of initX() calls that stay in server.ts's
 * order wherever they are included:
 *
 *   "sessions"  the session graph: the stores, the caches, the ask poll, the
 *               carry, the tails, the sessions frame, and the reconcile
 *               subscription that turns fake panes into real Session rows.
 *               Everything else implies it.
 *   "delivery"  the ONE way a message gets into a session: uploads binding,
 *               the pane-delivery guard, the dials instruction, the hook state
 *               file, the chat row. Implies "sessions".
 *   "notify"    presence + notify over a real E2E state and a pushSink standing
 *               in for the app server. Implies "sessions" and starts the sink.
 *   "plugins"   loadPlugins/declarePlugins and the LIVE decls the sessions
 *               frame carries. Implies "sessions".
 *   "frames"    the client-frame surface: reply, attach, show, session verbs,
 *               the MCP register and the ws dispatch. Implies "sessions".
 */
export type WireLayer = "sessions" | "delivery" | "notify" | "plugins" | "frames";

export type WireCoreOpts = {
  /** which layers of server.ts's boot to perform; [] is the base wiring alone */
  with?: WireLayer[];

  // ---- the fake herdr's shape -------------------------------------------
  /** herdr's agent_status for every pane */
  agentStatus?: string;
  /** the panes herdr reports, in herdr's own order */
  panes?: string[];
  /** panes whose agent has not minted a session id yet (the #405 limbo) */
  noSession?: string[];
  /** claude session id per pane; unset panes report their own pane id */
  sessionIds?: Record<string, string>;
  /** which agent each pane runs; claude for any pane not named */
  agents?: Record<string, string>;
  /** make herdr refuse a keystroke: the failure that strands a typed body */
  failKeys?: (keys: string[]) => boolean;
  /** screens pane.read answers with, instead of the box this fake would draw */
  screens?: Record<string, string>;

  // ---- time --------------------------------------------------------------
  /** where logical time starts */
  startMs?: number;
  /** the ask poll's cadence, on the manual clock (default ASK_POLL_MS) */
  askPollMs?: number;
  /** the context poll's cadence, on the manual clock (default CONTEXT_POLL_MS) */
  contextPollMs?: number;
  /** how long reconcile holds a never-announced pane's GUESSED session id
   *  before it counts (reconcile.ts announceGraceMs, on the manual clock).
   *  Default 0 here: the fake herdr's ids are the rig's own evidence and
   *  every test that does not study the grace wants them to count at once. */
  announceGraceMs?: number;

  // ---- identity, the ENGINE_* env reads server.ts does at boot -----------
  engineHost?: string;
  engineUser?: string;
  /** VOICE_PUBLIC_URL, as it rides the sessions frame */
  voicePublicUrl?: string;
  /** ENGINE_TABS, as groupingFrom() reads it */
  tabs?: string;

  // ---- what to start -----------------------------------------------------
  /** start the adapter's own snapshot/subscribe loop (most tests want this) */
  start?: boolean;
  /** start the push sink even without the notify layer (it opens a real port) */
  push?: boolean;
};

export type WireCore = {
  /** the test's throwaway root; the engine's data dir is <root>/data */
  root: string;
  /** what CYC_DATA_DIR points at while this wiring is up */
  dir: string;
  /** what CYC_PROJECTS_DIR points at: this wiring's ~/.claude/projects */
  projects: string;
  /** the fake terminal: what its screens say, what was typed at it */
  readonly herdr: FakeHerdr;
  /** move a pane behind the engine's back, the way a person at the keyboard would */
  readonly hooks: Hooks;
  /** the REAL MuxAdapter, over a REAL HerdrClient, over the fake's socket */
  readonly adapter: MultiplexerAdapter;
  /** every message the fake pane actually SUBMITTED (text + enter), in order.
   *  herdr.texts says what was typed; this says what the agent received. */
  readonly submitted: Array<{ pane: string; text: string }>;
  /** where the app server would be, or null when no layer asked for one */
  readonly pushSink: ReturnType<typeof pushSink> | null;
  /** logical time; the modules threaded with it read no wall clock */
  clock: ManualClock;
  /** session-state.ts's live map, keyed by AGENT id, after loadSessionState + reconcile */
  sessions: Map<string, Session>;
  /** the live session hosted by a pane handle (alive rows only), the way a
   *  test at the keyboard names one: by the pane it is looking at */
  byHandle(handle: string): Session | undefined;
  /** the session any wire key names: agent id, harness session id or pane
   *  handle, exactly what the routes and the ws dispatch resolve */
  sessionOf(key: string): Session | undefined;
  /** the recorded client sockets this test made */
  clients: FakeClient[];
  /** add one more */
  client(o?: { attach?: string | null; visible?: boolean }): FakeClient;
  /** frames written to a given client */
  framesOf(c: FakeClient): Record<string, any>[];
  /** every ctx.log()/LOG.line() event a wired module wrote */
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
  log(event: string, fields: Record<string, unknown>): void;
  /** which layers this wiring performed */
  readonly layers: WireLayer[];
  /** the uploads instance (sessions layer and up), or null */
  readonly uploads: Uploads | null;
  /** the E2E identity notify seals previews under (notify layer), or null */
  readonly e2e: E2EState | null;
  /** the plugin specs and their wire declarations (plugins layer) */
  readonly plugins: PluginSpec[];
  readonly pluginDecls: PluginDecl[];
  /** the opening burst a fresh client gets (can/plugins/voice/host/sessions) */
  hello(c: FakeClient): void;
  /* Register an input-transform hook into the live registry, the way a plugin's
   * core.inputTransform does. A delivery-layer test that asserts the reply-dials
   * append WITHOUT loading the plugins layer (which is what registers it in a
   * real engine) wires it here over its own store. A re-wire (reset) builds a
   * fresh registry, so re-register after a reset. */
  registerInputTransform(pluginId: string, hook: InputTransformHook): void;
  /* Reset every module and perform the wiring again, in the SAME dirs, over a
   * fresh fake herdr and a fresh adapter. The handles that a re-wire replaces
   * (herdr, adapter, submitted, uploads, pushSink, plugins) are getters, so a
   * caller holding `core` keeps reading the live ones.
   *
   * `next` overrides options for the new wiring: different panes, a different
   * agent status, more or fewer layers. `reset({ with: [] })` is the honest
   * leak check -- the base wiring arms no module timers at all, so a nonzero
   * clock.pending after it is a timer the previous wiring left behind. */
  reset(next?: Partial<WireCoreOpts>): Promise<void>;
  /** close the clients, stop the herdr, the adapter and the sink, cancel the
   *  timers, reset every module and put the env back. */
  stop(): Promise<void>;
};

/* Every module singleton this wiring writes into, reset in one call. Order does
 * not matter (each is independent), but the list does: a module wired below and
 * missing here is state the NEXT wiring in this worker silently inherits. */
function resetAllModules(): void {
  resetWire();
  resetSessionState();
  resetChatlog();
  resetTts();
  resetAsks();
  resetContextCache();
  resetReadState();
  resetReconcile();
  resetHookAnnounce();
  resetLineage();
  resetIngest();
  resetPaneDeliver();
  resetDeliver();
  resetReplyTrace();
  resetSessionsFrame();
  resetPresence();
  resetNotify();
  resetReplyDials();
}

/** THE WIRE ID OF THE CONVERSATION ON A PANE. A row's public id is its stable
 *  agent id and a client frame (attach, utterance, progress...) is addressed
 *  by it, never by the pane, so a test that thinks in panes asks here. Off the
 *  process-wide session map wireCore boots on, so it needs no rig in scope.
 *  Falls back to a dead row that still answers to the harness session id the
 *  fake herdr derives for the pane (defaultSessionIdOf), and to the raw
 *  handle when nothing answers: the engine's own "no such pane" refusal is
 *  then what the test sees, which is what a test that addresses a missing
 *  pane is after. */
export function wireId(handle: string): string {
  return sessionByHandle(handle)?.id ?? resolveSession(defaultSessionIdOf(handle))?.id ?? handle;
}

/** The base wiring plus whatever layers were asked for.
 *
 * With no layers this is dirs, clock, fake herdr, real adapter and recorded
 * clients: what the mux, delivery-guard and identity families want. With
 * "sessions" and up it is server.ts's boot, in server.ts's order, in process. */
export async function wireCore(initial: WireCoreOpts = {}): Promise<WireCore> {
  /* The options are a `let`, not the parameter: reset({...}) merges into them
   * so a re-wire can change the fleet (different panes, a blocked status, more
   * or fewer layers) without a second tmp dir and a second engine's worth of
   * teardown. Everything derived from them is derived inside boot(). */
  let o: WireCoreOpts = { ...initial };
  const { root, data } = await tmpDataDir("cyc-seam-");
  /* THIS WIRING'S ~/.claude/projects. session-events.ts resolves it per call
   * (it used to be captured at import, which is exactly the hazard this rig
   * cannot inherit), so pointing the env var here keeps every transcript stat,
   * every context read and every status tail inside the test's own tree. */
  const projects = join(root, "projects");
  await mkdir(projects, { recursive: true });

  /* THE ENV SWAP, and the one place in this file that touches process.env.
   *
   * Both vars are read lazily by the modules that use them, so this is a
   * choice made at wiring time rather than at import time, and stop() puts the
   * previous values back. ONE wireCore at a time per worker: two live at once
   * would be two engines fighting over one data dir, which is not a shape any
   * seam test wants and not one this rig pretends to support. */
  const prevData = process.env.CYC_DATA_DIR;
  const prevProjects = process.env.CYC_PROJECTS_DIR;
  const prevGrace = process.env.CYC_ANNOUNCE_GRACE_MS;
  process.env.CYC_DATA_DIR = data;
  process.env.CYC_PROJECTS_DIR = projects;
  process.env.CYC_ANNOUNCE_GRACE_MS = String(o.announceGraceMs ?? 0);

  const clock = manualClock(o.startMs);
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const log = (event: string, fields?: Record<string, unknown>) => {
    logs.push({ event, fields: fields ?? {} });
  };
  const made: FakeClient[] = [];

  /* WHICH LAYERS ARE UP, re-derived on every boot() so a reset can change them.
   * Every layer implies the session graph: there is nothing to deliver to,
   * notify about, declare plugins for or dispatch frames against without it. */
  let want = new Set<WireLayer>();
  const has = (l: WireLayer) => want.has(l);

  /* server.ts reads each of these from the environment once at boot; here they
   * come off the options, re-read on every boot() for the same reason. */
  let ENGINE_HOST = "seam-host";
  let ENGINE_USER = "seam-user";
  let VOICE_PUBLIC_URL = "";
  let ENGINE_TABS: Grouping = groupingFrom(undefined);
  /** Everything this engine promises an app it can do (server.ts ENGINE_CAN). */
  const ENGINE_CAN = ["words", "plugins"];

  /* ---- the inline glue server.ts defines inside boot() -------------------
   *
   * None of it is importable: it closes over boot's own consts. Each one is a
   * named function here with the same body, so a change on either side is a
   * visible difference rather than a silent divergence. */

  /** Mirrors server.ts sessionPushTitle: the ONE resolved title (title.ts),
   *  so a push says what the row says rather than the raw pane name. */
  function sessionPushTitle(s: Session): string {
    return titleOf(nameOverrideOf(s.id), claudeTitleOf(s), s.name).text;
  }

  /* No pushIconOf mirror any more: pushes carry no engine photo URL
   * (sealed-transport enforcement; /session-photo is owner-gated). */

  /** Mirrors server.ts sessionByAgent: sessions are keyed by the agent id. */
  function sessionByAgent(aid: string): Session | undefined {
    return sessions.get(aid);
  }

  /** Mirrors server.ts voiceHealthy: with no "voice" services unit the honest
   *  answer is false, and this rig runs no services at all. */
  function voiceHealthy(): boolean {
    return false;
  }

  /** Mirrors server.ts referencedUploads: the union a sweep must spare. */
  function referencedUploads(): Set<string> {
    const ids = new Set<string>();
    const add = (msgs: Iterable<any>) => {
      for (const m of msgs) {
        if (m?.upload?.uploadId) ids.add(m.upload.uploadId);
        for (const u of m?.uploads ?? []) if (u?.uploadId) ids.add(u.uploadId);
      }
    };
    for (const msgs of restoredChats.values()) add(msgs);
    for (const s of sessions.values()) add(s.chat);
    return ids;
  }

  /* ---- the mutable handles a re-wire replaces --------------------------- */

  let herdr!: FakeHerdr;
  let hooks!: Hooks;
  let mux!: HerdrClient;
  let adapter!: MuxAdapter;
  let submitted!: Array<{ pane: string; text: string }>;
  let uploads: Uploads | null = null;
  let e2e: E2EState | null = null;
  let sink: ReturnType<typeof pushSink> | null = null;
  /* The generic input-transform registry, an outer handle so a delivery-layer
   * test can register the reply-dials hook into the LIVE one (registerInputTransform
   * below). A re-wire replaces it, mirroring server.ts's one registry per boot. */
  let inputTransforms = makeInputTransformRegistry();
  let PLUGINS: PluginSpec[] = [];
  /* LIVE decls (#585): `let`, not `const`, because a dial change
   * re-declares the whole list and rebroadcasts it. */
  let PLUGIN_DECLS: PluginDecl[] = [];
  let sockSeq = 0;

  /** Mirrors server.ts redeclarePlugins: a plugin state change re-declares the
   *  whole list and broadcasts it, so every client repaints the composer. */
  function redeclarePlugins(): void {
    PLUGIN_DECLS = declarePlugins(PLUGINS);
    broadcast({ t: "plugins", list: PLUGIN_DECLS });
  }

  /* ---- the boot ---------------------------------------------------------- */

  async function boot(): Promise<void> {
    /* server.ts reads its env and decides its identity first; so does this. */
    want = new Set<WireLayer>(o.with ?? []);
    if (want.size) want.add("sessions");
    ENGINE_HOST = o.engineHost ?? "seam-host";
    ENGINE_USER = o.engineUser ?? "seam-user";
    VOICE_PUBLIC_URL = (o.voicePublicUrl ?? "").replace(/\/$/, "");
    ENGINE_TABS = groupingFrom(o.tabs);
    PLUGINS = [];
    PLUGIN_DECLS = [];
    uploads = null;

    /* THE FAKE TERMINAL AND THE REAL ADAPTER OVER IT.
     *
     * A unix socket in this test's own tmp dir, never a port: two files in two
     * parallel workers cannot collide on a path nobody else knows. The socket
     * name carries a sequence number so a reset()'s fresh herdr does not have
     * to unlink the old one out from under a client that is still closing. */
    const path = sockPath(root, `herdr-${++sockSeq}.sock`);
    submitted = [];
    hooks = {};
    herdr = fakeHerdr(
      path, o.agentStatus, o.panes ?? [PANE], [], o.failKeys, submitted, hooks,
      new Map(Object.entries(o.sessionIds ?? {})),
      new Set(o.noSession ?? []),
      new Map(Object.entries(o.agents ?? {})),
    );
    for (const [pane, screen] of Object.entries(o.screens ?? {})) herdr.screens.set(pane, screen);
    /* The adapter seam, exactly as makeAdapter() builds it for herdr: a
     * MuxAdapter over its own HerdrClient. The client is held so stop() can
     * cancel its 15s resnapshot poll and close its event socket; MuxAdapter
     * itself has no stop(). */
    mux = new HerdrClient(path);
    adapter = new MuxAdapter(mux, refusingDriver());

    /* 1. the data tree, made and permission-repaired before anything reads or
     *    writes in it. An empty dir is a fresh engine. */
    await ensureBaseTree();
    await repairRunTree(dataDir());

    /* THE BASE WIRING STOPS HERE: a real MuxAdapter over a real HerdrClient
     * over a fake herdr, and not one engine module initialised. Nothing has
     * subscribed to onAgents, so a snapshot lands nowhere; the adapter still
     * starts, because "what does the adapter make of this fleet" is exactly
     * what the mux and identity families ask it. */
    if (!has("sessions")) {
      if (o.start !== false) adapter.start();
      return;
    }

    /* E2E v3: the engine identity and content keys. Only the notify layer needs
     * them (the sealed push preview), and generating a keypair is not free, so
     * a sessions/delivery test does not pay for one. */
    if (has("notify")) e2e = await loadOrCreateE2E(keysFile());

    /* 2. UPLOAD STAGING (uploads.ts), built first because the blob index
     *    rebuild in loadSessionState stamps its minted set. */
    uploads = await makeUploads({
      stagingDir: stagingUploadsDir() + "/",
      blobOwner: () => blobOwner,
      agentIdFor: (id) => agentIdFor(id),
      referencedIds: () => referencedUploads(),
      log: (e, f) => log(e, f),
    });
    const mintedUploads = uploads.minted;

    /* 3. DISCOVERY + ENROLMENT (announce.ts) is deliberately NOT wired: it is
     *    an outbound heartbeat loop against the app server and nothing in the
     *    seam tier wants one running. The four seams it hands notify are
     *    supplied below straight from the push sink instead. */
    if (has("notify") || o.push) sink = pushSink();

    /* 4. Presence first: notify asks it, and its one call back into notify --
     *    "the grace expired, flush what is owed" -- is this onAway seam. */
    if (has("notify")) {
      initPresence({
        clients: () => clients,
        onAway: () => flushUnread(),
        clock,
      });

      /* 5. Notify, over the sink standing in for the app server. `token` is
       *    the sink's own enrolment (it issues a fresh scratch token per call),
       *    so a test can watch a 401 force a re-enrol. */
      let token = "";
      const enrol = async (): Promise<string> => {
        if (token) return token;
        const res = await fetch(`${sink!.url}/engines/enroll`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ engineId: e2e!.identity.fp, host: ENGINE_HOST }),
        }).catch(() => null);
        const body = res && res.ok ? await res.json().catch(() => null) as any : null;
        token = typeof body?.token === "string" ? body.token : "";
        return token;
      };
      initNotify({
        clients: () => clients,
        sessions: () => sessions.values(),
        broadcastSessions: () => broadcastSessions(),
        engineHost: ENGINE_HOST,
        appServerUrl: sink!.url,
        token: () => enrol(),
        peekToken: () => token,
        dropToken: (why) => { token = ""; log("app-token.dropped", { why }); },
        seal: (sid, title, body, count) => sealPushItem(e2e!, sid, title, body, count),
        sealEngine: (t, b, o) => sealEngineItem(e2e!, t, b, o),
        sessionPushTitle: (s) => sessionPushTitle(s),
        /* THE SAME clock presence got four lines up, and it has to be the same
         * object: notify asks presence whether he is there and presence calls
         * back into notify when the grace expires, so two clocks would be two
         * answers to "what time is it" on either side of one decision. With it,
         * the 10s batch window, the 10 minute ceiling and the 13s proof-of-life
         * wait are all arithmetic and nothing sleeps. */
        clock,
      });
    }

    // 6. Audio clips: clips.ts.
    await initClips({ blobOwner: () => blobOwner, agentIdFor: (id) => agentIdFor(id) });

    // 7. Read state: readstate.ts.
    initReadState({
      scheduleHeardSave: (id) => scheduleHeardSave(id),
      sendDismissal: (s) => { if (has("notify")) sendDismissal(s as Session); },
      broadcastSessions: () => broadcastSessions(),
    });

    /* 8. Context/model/title caches, on the MANUAL CLOCK: the 8s poll costs a
     *    test one advance() rather than eight seconds of wall time. */
    initContextCache({
      sessions: () => sessions.values(),
      transcriptFile: (h) => adapter.transcriptFile(h),
      contextRead: (h) => adapter.contextRead(h),
      claudeTranscriptPath: (c, csid) => adapter.transcriptPathFor(c, csid),
      claudeContextRead: (c, csid) => adapter.contextModelRead(c, csid),
      claudeTitleRead: (c, csid) => adapter.readTitle(c, csid),
      broadcastSessions: () => broadcastSessions(),
      clock,
    }, o.contextPollMs);

    /* 9. THE AGENT RECORDS, chat replay and the ONE per-id record, loaded here
     *    before anything reads a session. */
    await loadSessionState({
      noteMinted: (id) => { mintedUploads.add(id); },
      broadcastSessions: () => broadcastSessions(),
      lineageOf: (id) => lineageOf(id),
    });

    // 10. Chat log + the queued-flag lifecycle: chatlog.ts.
    initChatlog({
      chatOf: (id) => sessions.get(id)?.chat ?? restoredChats.get(id),
      restoredChats: () => restoredChats,
      persistPatch: (id, mts, set, unset) => persistPatch(id, mts, set, unset),
      broadcast: (m) => broadcast(m),
      chatRefFor: (id) => chatRefFor(id),
      indexMsgBlobs: (aid, m) => indexMsgBlobs(aid, m),
      appendMsg: (aid, chatId, m) => chatStore.appendMsg(aid, chatId, m),
      appendRec: (aid, chatId, rec) => chatStore.appendRec(aid, chatId, rec),
      sendSessionRec: (id, rec) => {
        for (const ws of clients) if (ws.data.attached === id) send(ws, { t: "session-event", id, ev: rec });
      },
      /* The stuck-queue deadline is a five minute window in production. On the
       * manual clock a test spends one advance() on it instead of five
       * minutes, and stop()'s resetForTest cancels whatever is still armed. */
      clock,
    });

    /* 11. Re-derive the restored queued flags before a single client can be
     *     told about one. */
    sweepRestoredQueued();

    // 12. Spoken replies: tts.ts, over a voice engine that refuses.
    initTts({
      voiceUrl: () => refusingVoiceUrl(),
      voiceFor: (id) => voiceFor(id),
      persistPatch: (id, mts, set, unset) => persistPatch(id, mts, set, unset),
      broadcast: (m) => broadcast(m),
      restoredChats: () => restoredChats,
    });

    // 13. Close out any clip a restart caught mid-growth (#525).
    await sweepGrowingClips();

    // 14. The backlog is bounded at boot as well as on every upload.
    await uploads.trimUploads("startup");

    /* 15. The ask poll machine, on the MANUAL CLOCK: a blocked pane's 3s
     *     re-read is one advance() and no sleeping. */
    initAsks({
      readBlocked: async (paneId) => (await adapter.conversation(paneId)).blocked,
      canParseScreen: (paneId) => adapter.canParseScreen(paneId),
      sessions: () => sessions.values(),
      broadcastSessions: () => broadcastSessions(),
      logAsk: (paneId, ask, ts) => {
        const s = sessionByHandle(paneId);
        if (s) logSession(s, { ts, kind: "ask", text: ask.question });
      },
      clock,
    }, o.askPollMs);

    // 17. Pane delivery: pane-deliver.ts (the delivery guard's collaborators).
    if (has("delivery")) {
      initPaneDeliver({
        parseScreen: (paneId) => adapter.parseScreen(paneId),
        publishAsk: (paneId, ask) => publishAsk(paneId, ask),
        sendInput: (paneId, text, deliveryId, takenAt, deps) =>
          adapter.sendInput(paneId, text, deliveryId, takenAt, deps),
        canParseScreen: (paneId) => adapter.canParseScreen(paneId),
        interrupt: (paneId) => adapter.interrupt(paneId),
        sendText: (paneId, text) => adapter.sendText(paneId, text),
        sendKeys: (paneId, keys) => adapter.sendKeys(paneId, keys),
        adoptAgentId: (handle, agentId) => adoptAgentId(handle, agentId),
        sessionOf: (id) => sessions.get(id),
        sessionByHandle: (handle) => sessionByHandle(handle),
        quitWaitMs: (kind) => adapter.quitWaitMs(kind),
        quitKeys: (kind) => adapter.quitKeys(kind),
      });
    }

    /* 18. THE REPLY TRACE (#585): the store is the plugin's own; core keeps only
     *     the Stop hook's evidence. Wired for the session graph and not only for
     *     delivery, because the sessions frame carries replyLevel on every row
     *     and an invented number there is a second answer. */
    const replyDials = await replyDialsStore();
    initReplyTrace({
      sessions: () => sessions.values(),
      engineHost: ENGINE_HOST,
      hasSessionEvents: (kind) => adapter.hasSessionEvents(kind),
    });
    /* The input-transform registry, mirroring server.ts: generic, one per boot,
     * with NO reply-dials-specific registration at the root. The reply-dials
     * plugin registers its own postfix hook when the plugins layer loads it (via
     * core.inputTransform); a delivery-only test wires it through
     * registerInputTransform. transformOutgoing folds whatever is registered at
     * the delivery site. */
    inputTransforms = makeInputTransformRegistry();

    // 19. Transcript ingest: ingest.ts (the session log + the thinking indicator).
    initIngest({
      sessionOf: (id) => sessions.get(id),
      sessions: () => sessions.values(),
      broadcastSessions: () => broadcastSessions(),
      subscribe: (h, cb, from) => adapter.subscribe(h, cb, from),
      readTranscriptSpan: (p, from, to) => adapter.readTranscriptSpan(p, from, to),
      subscribeStatus: (h, cb) => adapter.subscribeStatus(h, cb),
      subscribePiEvents: (h, cb) => adapter.subscribePiEvents(h, cb),
      transcriptFile: (h) => adapter.transcriptFile(h),
      tailOf: (aid, sid) => agentMetas.get(aid)?.tails?.[sid],
      setTail: (aid, sid, ptr) => {
        const meta = metaFor(aid);
        if (ptr) (meta.tails ??= {})[sid] = ptr;
        else if (meta.tails) { delete meta.tails[sid]; if (!Object.keys(meta.tails).length) delete meta.tails; }
        scheduleAgentSave(aid);
      },
      log: (e, f) => log(e, f),
    });

    // 20. The agent->app path: reply.ts.
    if (has("frames")) {
      initReply({
        sessionOf: (id) => sessions.get(id),
        sessionByHandle: (handle) => sessionByHandle(handle),
        resolveSession: (id) => resolveSession(id),
        send: (ws, m) => send(ws, m),
        broadcast: (m) => broadcast(m),
        broadcastSessions: () => broadcastSessions(),
        log: (e, f) => log(e, f),
        noteReply: (id) => noteReply(id),
        notifyUnlessWatched: (s, n) => { if (has("notify")) return notifyUnlessWatched(s, n); },
        sessionPushTitle: (s) => sessionPushTitle(s),
      });
    }

    // 21. Lineage, seeded from the metas loadSessionState just restored.
    initLineage(
      { scheduleAgentSave: (id) => scheduleAgentSave(id), log: (e, f) => log(e, f),
        streamLines: (p, onLine) => adapter.streamTranscriptLines(p, onLine) },
      [...agentMetas.values()]
        .filter((m) => Array.isArray(m.lineage) && m.lineage.length)
        .map((m) => [m.agentId, m.lineage!] as [string, string[]]),
    );

    // 22. Attach: attach.ts.
    if (has("frames")) {
      initAttach({
        sessionOf: (id) => sessions.get(id),
        send: (ws, m) => send(ws, m),
        broadcastSessions: () => broadcastSessions(),
        scheduleHeardSave: (id) => scheduleHeardSave(id),
        log: (e, f) => log(e, f),
      });
    }

    /* 23. THE PLUGINS THIS ENGINE LOADED, and their wire declarations, computed
     *     once from the same list in the same statement.
     *
     *     Two of server.ts's deps bags are deliberately absent: `usage` starts
     *     a real limits poll against his upstream account, and `crons` starts a
     *     ticker. Both are their own plugins' machinery, both reach the network
     *     or the clock on their own terms, and a seam test that wants either
     *     builds it directly. What is here is the set whose behaviour is a pure
     *     function of this engine's own state. */
    if (has("plugins")) {
      /* THE TYPED PLUGIN CORE, mirroring server.ts: the capability dispatch over
       * real harness caps + the mux baseline, and the core services. Migrated
       * plugins take `core`; the tts/notify/terminal services are refusing stubs
       * here because no seam test loads the plugins that use them (voice, usage,
       * tui build those directly). */
      const lifecycleOfHandle = (handle: string): AgentLifecycle => {
        const s = sessionByHandle(handle);
        if (!s || !s.alive) return "gone";
        switch (s.status) {
          case "blocked": return "blocked";
          case "working":
          case "done": return "running";
          default: return "started";
        }
      };
      const dispatch = makeCapabilityDispatch({
        /* Mirrors server.ts: the one resolution ladder (agent id, harness
         * session id through the index, live handle), the same one the reply
         * path has, so a read addressed by any id the app holds resolves. */
        sessionOf: (id) => {
          const s = resolveSession(id);
          if (!s) return undefined;
          return { handle: s.muxHandle, cwd: s.cwd, harnessSessionId: s.harnessSessionId,
            kind: s.agent.id, name: s.agent.name, viaMux: s.viaMux, alive: s.alive };
        },
        harnessFor: makeHarnessCaps({
          profiles: adapter.harnessProfiles(),
          muxContextRead: (h) => adapter.contextRead(h),
          contextModelRead: (c, csid) => adapter.contextModelRead(c, csid),
          conversation: (h) => adapter.conversation(h),
          lifecycle: (h) => lifecycleOfHandle(h),
          claudeCompact: async (h) => {
            const s = sessionByHandle(h);
            return s ? compactSession(s.id)
              : { ok: false, tell: "that session is not running, so nothing was compacted" };
          },
          // refusing: a seam test must never reach the real claude plan usage
          // (limitsNow reads credentials); nothing here renders the usage card.
          claudeUsage: async () => { throw new Error("a seam test asked for plan usage"); },
        }),
        // the harness kinds this engine can answer usage for, DERIVED from the
        // READERS table and flagged active off the live sessions (mirrors server.ts)
        harnessKinds: () => adapter.harnessProfiles().map(({ tag }) => ({
          kind: tag, active: [...sessions.values()].some((s) => s.alive && s.agent.id === tag),
        })),
        muxInput: {
          sendText: async (ref, text) => {
            try { await deliverToPane(ref.handle, text, newCid("mux")); return { ok: true, tell: "typed" }; }
            catch (e) {
              return { ok: false,
                tell: e instanceof PaneNotReady ? e.tell : "that pane would not take the keystrokes" };
            }
          },
          interrupt: async (ref) => { await adapter.interrupt(ref.handle); return { ok: true, tell: "sent the interrupt key" }; },
        },
      });
      const hostWiring: HostWiring = {
        sessionFor: (aid) => { const s = sessionByAgent(aid); return s ? { cwd: s.cwd } : null; },
        deliverText: async (aid, m) => {
          const s = sessionByAgent(aid);
          if (!s) return { ok: false, retriable: true,
            why: "this engine has no live session for that agent right now" };
          const res = await deliverToAgent(s, m);
          return { ok: res.ok, why: res.why, retriable: res.retriable };
        },
      };
      const pluginServices: PluginCoreServices = {
        dispatch,
        tts: {
          list: async () => { throw new Error("a seam test asked for the voice engine"); },
          sample: async () => { throw new Error("a seam test asked for the voice engine"); },
          voiceOf: (id) => voiceFor(id) ?? "",
          setVoice: () => {},
          globalDefault: () => "",
          setDefault: () => {},
          sessionExists: (id) => sessions.has(id),
        },
        searchChat: (id, q) => {
          const s = sessions.get(id);
          return s ? scanChat(s.chat, searchableText, q) : null;
        },
        notifyDevices: async () => {},
        notifyEngine: async () => {},
        registerInputTransform: (pid, hook) => inputTransforms.register(pid, hook),
        paneTerminalStream: (id, cols, rows, h) => {
          const s = sessions.get(id);
          return s ? adapter.openTerminal(s.muxHandle, cols, rows, h as any) : null;
        },
      };
      const pluginCore = (id: string): PluginCore => makePluginCore(id, hostWiring, pluginServices);
      PLUGINS = loadPlugins({
        core: pluginCore,
        search: true,
        model: {
          harness: (id) => sessions.get(id)?.agent.id ?? null,
        },
        dials: { store: replyDials },
        ctx: true,
      });
      PLUGIN_DECLS = declarePlugins(PLUGINS);
    }

    /* 24. The sessions frame's boot deps, injected once the decls exist
     *     (ordering hazard 2). */
    initSessionsFrame({
      engineCan: ENGINE_CAN,
      pluginDecls: () => PLUGIN_DECLS,
      voiceHealthy: () => voiceHealthy(),
      voicePublicUrl: VOICE_PUBLIC_URL,
      engineUser: ENGINE_USER,
      engineHost: ENGINE_HOST,
      tabs: ENGINE_TABS,
      replyLevel: () => replyDials.level(),
      hasSessionEvents: (kind) => adapter.hasSessionEvents(kind),
    });
    /* Now that redeclarePlugins exists, wire the store's onChange: every dial
     * mutation re-declares, rewrites the hook state and rebroadcasts. */
    replyDials.onChange = () => {
      if (has("plugins")) redeclarePlugins();
      broadcastSessions();
    };

    if (has("delivery")) {
      // 25. Transcription: transcribe.ts, over a voice engine that refuses.
      initTranscribe({
        voiceUrl: () => refusingVoiceUrl(),
        log: (e, f) => log(e, f),
        broadcast: (m) => broadcast(m),
        inOrder: (id, f) => inOrder(id, f),
        deliver: (s, opts) => injectUserMessage(s as Session, opts),
        sessionOf: (id) => sessions.get(id),
        restoredChats: () => restoredChats,
      });

      // 26. Delivery: deliver.ts. THE one way a message gets into a session.
      initDeliver({
        sessionOf: (id) => sessions.get(id),
        send: (ws, m) => send(ws, m),
        broadcast: (m) => broadcast(m),
        log: (e, f) => log(e, f),
        transformOutgoing: (input) => applyInputTransform(inputTransforms.hooks(), input),
        noteDelivery: (id, how) => noteDelivery(id, how),
        forgetDelivery: (id, entry) => forgetDelivery(id, entry),
        writeHookState: () => writeHookState(),
        bindOwnedUploads: (claimed, c) => uploads!.bindOwnedUploads(claimed, c),
        adoptStagedUploads: (id, ups) => uploads!.adoptStagedUploads(id, ups),
      });
    }

    if (has("frames")) {
      // 27. MCP show: show-handler.ts.
      initShowHandler({
        sessionOf: (id) => sessions.get(id),
        agentIdFor: (id) => agentIdFor(id),
        claimBlob: (docId, aid) => blobOwner.set(docId, aid),
        docDirFor: (aid) => docDirFor(aid),
        send: (ws, m) => send(ws, m),
        broadcast: (m) => broadcast(m),
        notifyUnlessWatched: (s, n) => { if (has("notify")) return notifyUnlessWatched(s as Session, n); },
        sessionPushTitle: (s) => sessionPushTitle(s as Session),
        noteReply: (id) => noteReply(id),
      });

      // 28. Session verbs: session-verbs.ts.
      initSessionVerbs({
        sessionOf: (id) => sessions.get(id),
        launchCommand: (agentId) => adapter.launchCommand(agentId),
        deliverToPane: (paneId, text) => deliverToPane(paneId, text, newCid("compact")),
        paneNotReadyTell: (e) => (e instanceof PaneNotReady ? e.tell : null),
        interrupt: (paneId) => adapter.interrupt(paneId),
        onPaneKeyboard: (f) => onPaneKeyboard(f),
        sendKeys: (paneId, keys) => adapter.sendKeys(paneId, keys),
        send: (ws, m) => send(ws, m),
        broadcast: (m) => broadcast(m),
        broadcastSessions: () => broadcastSessions(),
        log: (e, f) => log(e, f),
      });

      // 29. The MCP register + the ws client dispatch.
      initMcp({ resolveHandle: (id) => adapter.resolveHandle(id) });
      initFrames({
        terminalCanResize: adapter.terminalCanResize,
        terminalPaneMode: (paneId) => adapter.terminalPaneMode(paneId),
        openTerminal: (paneId, cols, rows, h) => adapter.openTerminal(paneId, cols, rows, h as any),
        terminalViewer: () => adapter.capabilities().terminalViewer,
        log: (e, f) => log(e, f),
      });
    }

    /* 30. THE RECONCILE SUBSCRIBES RIGHT BEFORE THE ADAPTER STARTS, once every
     *     module's deps are wired: a mux snapshot arriving mid-boot must not
     *     land on an uninitialised module (ordering hazard 1). */
    adapter.onAgents(makeReconcile({
      hasTranscript: (kind) => adapter.hasTranscript(kind),
      canParseScreen: (h) => adapter.canParseScreen(h),
      nativeDone: adapter.capabilities().nativeDone,
      sweepTails: () => adapter.sweepTails(),
      broadcastSessions: () => broadcastSessions(),
      now: () => clock.now(),
    }));
    if (o.start !== false) adapter.start();

    /* 31. Boot is over: every store buildAgentMeta reads exists now. Flip the
     *     meta-save gate and flush the parked saves (ordering hazard 3). */
    sessionStateReady();
  }

  /** Tear down everything a boot() built, without touching the dirs or the env:
   *  what both reset() and stop() do first. */
  async function teardown(): Promise<void> {
    for (const c of made) c.close();
    made.length = 0;
    try { mux?.stop(); } catch { /* never started */ }
    try { herdr?.stop(true); } catch { /* never listened */ }
    /* The app server goes with the wiring that dialled it: a re-wire that kept
     * the old sink would carry the previous wiring's pushes into the new one's
     * `hits`, and the port would leak one listener per reset. */
    sink?.stop();
    sink = null;
    resetAllModules();
  }

  await boot();

  const core: WireCore = {
    root,
    dir: data,
    projects,
    get herdr() { return herdr; },
    get hooks() { return hooks; },
    get adapter() { return adapter; },
    get submitted() { return submitted; },
    get pushSink() { return sink; },
    get uploads() { return uploads; },
    get e2e() { return e2e; },
    clock,
    sessions,
    byHandle: (handle) => sessionByHandle(handle),
    sessionOf: (key) => resolveSession(key),
    clients: made,
    get plugins() { return PLUGINS; },
    get pluginDecls() { return PLUGIN_DECLS; },
    client(opts = {}) {
      const c = fakeClient({ now: () => clock.now(), ...opts });
      made.push(c);
      return c;
    },
    framesOf: (c) => c.frames,
    logs,
    log: (event, fields) => log(event, fields),
    get layers() { return [...want]; },
    hello: (c) => sendHelloBurst(c.sock),
    registerInputTransform: (pluginId, hook) => inputTransforms.register(pluginId, hook),
    async reset(next) {
      await teardown();
      if (next) o = { ...o, ...next };
      await boot();
    },
    async stop() {
      await teardown(); // which also stops the push sink
      /* The env goes back exactly as it was, `undefined` included: a test file
       * that ran a wireCore must leave the process no more configured than it
       * found it, or the next file in a shared worker inherits a data dir that
       * has already been deleted. */
      if (prevData === undefined) delete process.env.CYC_DATA_DIR;
      else process.env.CYC_DATA_DIR = prevData;
      if (prevProjects === undefined) delete process.env.CYC_PROJECTS_DIR;
      else process.env.CYC_PROJECTS_DIR = prevProjects;
      if (prevGrace === undefined) delete process.env.CYC_ANNOUNCE_GRACE_MS;
      else process.env.CYC_ANNOUNCE_GRACE_MS = prevGrace;
    },
  };
  return core;
}

/* Re-exported for convenience, because a seam test that has a wireCore almost
 * always wants one of these next: `sessionsFrame()` is the whole projection
 * this wiring would send right now (for an assertion that needs no client to
 * receive it), and `broadcastSessions()` is the push a test makes after
 * mutating a session by hand. Both are the SAME functions the wiring uses; a
 * test importing them from here and a module calling them internally cannot
 * end up talking to two different sessions frames. */
export { sessionsFrame, broadcastSessions };
