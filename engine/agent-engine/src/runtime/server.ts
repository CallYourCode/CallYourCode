// agent-engine (:10101): sessions, herdr, delivery, chat log. The only process
// that knows what a "session" is. Speech itself lives in the voice engine
// (:10102); this process calls it for TTS and tells browsers where it is.
//
// The engine routes and remembers.
// It enforces nothing about who speaks -- the page does that.
//
// Sessions come from herdr: every claude agent pane is a session (id = pane
// id). The speak MCP socket that registers with the same id merges into that
// session as its voice-out channel. Utterances go IN via herdr send_text.

import { makeAdapter } from "../adapters/factory.ts";
import { ensureUtf8Locale } from "../terminal/tmux.ts";
import { reapOrphans, killAllTrackedBridgesSync } from "../terminal/terminal.ts";
import { PaneNotReady } from "../adapters/mux-adapter.ts";
import { registerRunEnricher, findTranscriptBySessionId } from "../readers/claude.ts";
import { titleOf } from "../sessions/title.ts";
import { warnRetiredEnv } from "./agents.ts";
import { warnOnDeadHarnessPaths, healCodexMcpPathAtBoot, healHarnessCopiesAtBoot } from "./harness-config-check.ts";
import type { Grouping } from "../sessions/tabs.ts";
import { openLog, newCid } from "../../../shared/logbook.ts";
import { Services, loadServices } from "./services.ts";
import { ModelWarmup, type WarmupKind } from "./modelwarmup.ts";
import { requiredModelFiles, modelPresencePaths, whisperModelName, kokoroModelName,
  currentWhisperSize, currentKokoroVariant } from "../voice/voicemodels.ts";
import { existsSync, unlinkSync, chmodSync } from "node:fs";
import { defaultSockPath } from "../../../shared/engine-url.ts";
import { resolvePorts } from "../../../shared/ports.ts";
import { loadPlugins, declarePlugins } from "../plugins/registry.ts";
import type { PluginSpec, PluginDecl } from "../plugins/platform/spec.ts";
import { scanChat } from "../chat/chat-search.ts";
import { replyDialsStore } from "../plugins/reply-dials/index.ts";
import { repairRunTree } from "../../../shared/runfiles.ts";
import { dataDir, ensureBaseTree, keysFile, stagingUploadsDir } from "../storage/datadir.ts";
import { type HostWiring } from "../plugins/platform/host.ts";
import { makeInputTransformRegistry, applyInputTransform, makePluginCore,
  type PluginCore, type PluginCoreServices } from "../plugins/platform/core.ts";
import { binaryOnPath } from "./which.ts";
import { makeCapabilityDispatch } from "./capability-dispatch.ts";
import { makeHarnessCaps } from "./harness-caps.ts";
import { limitsNow, takeAlerts, nextPollAt, pollPhaseMs, LIMITS_POLL_MS } from "../storage/limits.ts";
import type { AgentLifecycle } from "../readers/types.ts";
import type { SockData } from "../transport/sock.ts";
import { clients, nextClientCid, send, broadcast } from "../transport/wire.ts";
import { isTrustedLocal, isLoopbackTrusted, markLocalSocket, json as jsonAnswer, refuseForbiddenHost, refuseForbiddenOrigin, requireLocal } from "../transport/httpx.ts";
import { handleAnnounce, setLiveBindGuard } from "../terminal/hook-announce.ts";
import { liveBindGuard } from "../sessions/foreign-guard.ts";
import { searchableText } from "../chat/chatmsg.ts";
import { makeUploads, uploadIdsOf } from "../chat/uploads.ts";
import { initClips } from "../chat/clips.ts";
import { initReadState } from "../sessions/readstate.ts";
import { initContextCache, claudeTitleOf } from "../sessions/context-cache.ts";
import { initChatlog, logSession, sweepRestoredQueued } from "../chat/chatlog.ts";
import { initTts, ttsWithVoice, sweepGrowingClips } from "../voice/tts.ts";
import { makeAnnounce } from "../terminal/announce.ts";
import { initAsks, publishAsk } from "../chat/asks.ts";
import { initShowHandler, deliverShow, type ShowSession } from "../chat/show-handler.ts";
import { sessions, sessionByHandle, resolveSession, loadSessionState, sessionStateReady, agentMetas,
  blobOwner, restoredChats, restoredLogs, chatStore, indexMsgBlobs, agentIdFor, chatRefFor, persistPatch, metaFor,
  scheduleAgentSave, scheduleHeardSave, nameOverrideOf, voiceOverrideOf, setVoiceOverride, adoptAgentId,
  globalVoice, setDefaultVoice, voiceFor, docDirFor, type Session } from "../sessions/session-state.ts";
import { initPaneDeliver, onPaneKeyboard, deliverToPane } from "../chat/pane-deliver.ts";
import { initDeliver, inOrder, injectUserMessage, deliverToAgent } from "../chat/deliver.ts";
import { initReply, deliverReply } from "../chat/reply.ts";
import { initNotify, notifyUnlessWatched, notifyDevices, notifyEngineDevices, sendDismissal, flushUnread } from "../chat/notify.ts";
import { initPresence } from "../sessions/presence.ts";
import { initSessionsFrame, broadcastSessions, voiceFrame,
  type VoiceReady } from "../sessions/sessions-frame.ts";
import { initReplyTrace, noteDelivery, forgetDelivery, noteReply,
  writeHookState } from "../chat/reply-trace.ts";
import type { RoutesCtx, RouteGroup } from "../routes/ctx.ts";
import { voiceRoutes } from "../routes/voice.ts";
import { healthRoutes, revFromStamp } from "../routes/health.ts";
import { mediaRoutes } from "../routes/media.ts";
import { chatRoutes } from "../routes/chat.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";
import { pluginRoutes } from "../routes/plugin.ts";
import { transferRoutes, startTransferSweeper } from "../routes/transfer.ts";
import { makeReconcile } from "../sessions/reconcile.ts";
import { initMcp, agentInfo } from "./mcp.ts";
import { initFrames, makeWsHandlers } from "../transport/frames.ts";
import { initRtcGlue, onSignalOffer, relaySignalSock, mintRtcClient } from "../transport/rtc-glue.ts";
import { initVoiceCtl, speakToCalls } from "../voice/voicectl.ts";
import { initTunnel } from "../transport/tunnel-glue.ts";
import { initSessionVerbs, compactSession } from "../sessions/session-verbs.ts";
import { initIngest } from "../chat/ingest.ts";
import { runBackfillSweep, resolveBackfillSources, type MetaLike } from "../chat/backfill.ts";
import { initLineage, lineageOf } from "../sessions/lineage.ts";
import { initAttach } from "../chat/attach.ts";
import { voiceUrl, VOICE_URLS, listHostVoices } from "../voice/voice-proxy.ts";
import { initTranscribe, sweepPendingTranscripts } from "../voice/transcribe.ts";

import { homedir, userInfo, hostname } from "node:os";
import { dirname, join } from "node:path";
import { b64encode } from "../../../shared/e2e";
import { loadOrCreateE2E, verifyRelayAuth } from "../security/sec";
import { sealPushItem as sealPushItemForState, sealEngineItem as sealEngineItemForState } from "../security/sealpush";
import { loadRtc, RTC } from "../transport/rtc";
import { resolveRelayUrl, RelayLink } from "../transport/relay.ts";

/* ============================== BOOT =======================================
 *
 * ONE EXPLICIT BOOT (ordering hazard 1). The five scattered top-level awaits
 * became this single ordered sequence; extracted modules export constructors
 * and init functions, never top-level awaits. The order IS load-bearing and
 * is spelled by position:
 *
 *   1. env + identity, data tree, E2E keys, RTC stack
 *   2. discovery/enrolment (announce) + the relay link
 *   3. stores: uploads, clips, session state (agent metas + chat replay)
 *   4. module wiring (initX seams), boot sweeps
 *   5. plugins (the deps bags for view plugins, the minimal host for crons)
 *   6. services + the route table context
 *   7. reconcile subscription -> adapter.start() -> Bun.serve
 *   8. tail: hook state, the meta-save gate flip, the boot log line
 */
await boot();

async function boot(): Promise<void> {

/* Service managers (launchd) start the engine with no locale; tmux then
 * sanitizes the tab separators in list-panes -F output and the tmux lane goes
 * blind. Done first, before any tmux/mux construction, so ALL children
 * (tmux calls, spawned agents) inherit a UTF-8 locale. */
const injectedLang = ensureUtf8Locale();
if (injectedLang) {
  console.log(`[boot] no locale in the environment; set LANG=${injectedLang} (tmux -F output is sanitized without a UTF-8 locale)`);
}

/* The structured log. One line per decision, in the same format and the same
 * directory as the app server's and the browser's, so `scripts/cyclog.sh <cid>`
 * shows a recording's whole life across all three services. See logbook.ts for
 * what bounds it. */
const LOG = openLog("engine");

/* DIAGNOSTIC (dc-closed hunt): surface any throw that would otherwise be
 * invisible. No process.exit; the engine keeps running so we keep observing. */
process.on("uncaughtException", (err: unknown) => {
  console.error(`[fatal] uncaughtException: ${(err as Error)?.stack ?? String(err)}`);
  LOG.line("uncaughtException", { err: String(err), stack: (err as Error)?.stack ?? "" });
});
process.on("unhandledRejection", (reason: unknown) => {
  console.error(`[fatal] unhandledRejection: ${(reason as Error)?.stack ?? String(reason)}`);
  LOG.line("unhandledRejection", { err: String(reason), stack: (reason as Error)?.stack ?? "" });
});

/* RELEASE ON CLEAN SHUTDOWN. A plain SIGTERM (a service manager restart) or a
 * SIGINT (Ctrl-C) would otherwise orphan every `herdr terminal session control`
 * child exactly the way a SIGKILL does: nothing on the close path runs, the
 * attach slot stays squatted, and the next boot reap has to clean it up. These
 * handlers kill the tracked bridge pids synchronously (the registry is the
 * persisted mirror of the hub's live bridges, cmdline-guarded so a reused pid
 * is safe) and then exit with the signal's conventional 128+n code. Tiny and
 * synchronous on purpose: no async ceremony that could hang the shutdown. The
 * diagnostic uncaughtException/unhandledRejection handlers above are unchanged. */
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    try {
      const n = killAllTrackedBridgesSync();
      if (n > 0) console.log(`[terminal] killed ${n} bridge(s) on ${sig}`);
    } catch {
      // best-effort: a failure here must never stop the process from exiting
    }
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}

/* The port scheme (CYC_PORT_BASE) lives in shared/ports.ts so all four
 * services move together under one knob; AGENT_PORT still wins when set. */
const PORT = resolvePorts(process.env).AGENT_PORT;
const HOST = process.env.AGENT_HOST ?? "127.0.0.1";

/* WHICH CODE THIS PROCESS IS ACTUALLY RUNNING, read once at start-up and
 * reported on /health.
 *
 * scripts/deploy-engines.sh writes .deployed-rev BEFORE it restarts a host, so
 * a process that came back reads the new rev and a process that never restarted
 * keeps answering with the old one. That difference is the whole point: without
 * it the deploy report could only read back the file it had just written, which
 * says what was asked for and not what happened -- and "merged on the machine I
 * was sitting at" going unnoticed for three days is the reason that script
 * exists at all.
 *
 * This machine's engine is a git checkout with no .deployed-rev, so it falls
 * back to HEAD. Both are read here, at start-up, never per request: a rev that
 * moved while the process kept running would be the same lie in a new place. */
const REV = await (async () => {
  const stamped = await Bun.file(new URL("../../.deployed-rev", import.meta.url).pathname)
    .text().catch(() => "");
  const fromFile = revFromStamp(stamped);
  if (fromFile) return fromFile;
  return (await Bun.$`git rev-parse --short HEAD`.cwd(import.meta.dir).quiet()
    .text().catch(() => "")).trim();
})();
const VOICE_PUBLIC_URL = (process.env.VOICE_PUBLIC_URL ?? "").replace(/\/$/, "");

/* The engine's own public address, as announce reports it to the app server.
 * It no longer feeds push icons: pushes stop referencing engine photo URLs
 * (sealed-transport plan -- /session-photo is owner-gated now, so an OS icon
 * fetch could never answer), and in-app avatars ride the tunnel as blobs. */
const ENGINE_PUBLIC_URL = (process.env.ENGINE_PUBLIC_URL ?? "").replace(/\/$/, "");

// Who this engine is: drives the app's host tabs ("user@host"; the user part
// only shows when a host runs engines for several users).
const ENGINE_USER = userInfo().username;
const ENGINE_HOST = (process.env.ENGINE_HOST ?? hostname()).replace(/\.local$/, "").toLowerCase();
/* HOW THIS HOST'S CONVERSATIONS ARE GROUPED INTO TABS (tabs.ts).
 *
 * Hardcoded "off": this engine declares no tabs and the app draws it as one
 * list under one tab, which is what it has always done and what every engine
 * older than this file does. */
const ENGINE_TABS: Grouping = "off";
/* THE HOST'S HOME, and it is asked of the machine rather than guessed.
 *
 * The three engines run as three different users on two operating systems, so
 * there is no path the app could assume: /Users/user on the primary mac,
 * /Users/work on the work profile beside it, /home/user on linux. Whatever
 * this process's own user has is the real answer, and it is the one place a
 * new session can always be started (see /new-session/places). */
const ENGINE_HOME = homedir();
/* NO PREFERRED CHECKOUT: the new-session default is this user's HOME, not the
 * engine's own source tree.
 *
 * This used to be `dirname(import.meta.dir)` -- the directory above
 * agent-engine/src/, offered as the `def` of /new-session/places: the checkout the
 * engine runs from is the one directory already TCC-blessed on macOS, and the
 * natural place to begin a coding session. Post-collapse the engine lives at
 * <repo>/engine/agent-engine, so the MONOREPO ROOT is two levels up (his call,
 * 2026-08-24: the repo root, not the engine subdir and not Home). */
const ENGINE_REPO: string | null = dirname(dirname(dirname(import.meta.dir)));

/* THE DATA DIR (~/.callyourcode, or CYC_DATA_DIR): made and permission-repaired
 * before anything reads or writes in it. An empty dir is a fresh engine. */
await ensureBaseTree();
await repairRunTree(dataDir());

/* E2E v3 + WebRTC transport (#579), loaded at boot, always (no mode).
 * The engine id, identity + content keys live in the data dir's keys.json
 * (sec.ts); node-datachannel is the DataChannel stack (rtc.ts). An rtc-offer on
 * /ws opens the sealed transport; the WS is signaling-only, so a plain `hello`
 * gets transport-required. */
const E2E_STATE = await loadOrCreateE2E(keysFile());
/* requireOwner (httpx.ts) reads NO key state: it admits true loopback and the
 * in-process sealed-tunnel mark only. The x-cyc-cap bearer is deleted. */
if (E2E_STATE.migrated) LOG.line("keys.regenerated", { backedUp: "keys.bak.json" });
LOG.line("e2e", { fp: E2E_STATE.identity.fp, devices: E2E_STATE.devices.length });
await loadRtc();
if (RTC.available) console.log(`[rtc] bind=127.0.0.1+reached lib=${RTC.lib}@${RTC.version}`);
else LOG.line("rtc.unavailable", {});
console.log(`[e2e] fp=${E2E_STATE.identity.fp} devices=${E2E_STATE.devices.length}`);

/* #579: the WS is signaling-only. A plain WS `hello` is answered with
 * `transport-required` (dial the DataChannel), and the client wire only ever
 * rides the sealed DataChannel. /ws carries rtc-offer/answer/cand and nothing
 * else. */
console.log("[transport] ws=signaling-only (rtc DataChannel required)");
LOG.line("transport.mode", { wsData: false, rtc: RTC.available });


// ---------------------------------------------------------------- state


/* UPLOAD STAGING moved to uploads.ts (L2): staging dir, minted set, owner
 * paths, bind/adopt, retention. Wired here over the blob index and the
 * reference scan, which stay with the session state that owns them. */
const uploads = await makeUploads({
  stagingDir: stagingUploadsDir() + "/",
  blobOwner: () => blobOwner,
  agentIdFor: (id) => agentIdFor(id),
  referencedIds: () => referencedUploads(),
  log: (e, f) => LOG.line(e, f),
});
const mintedUploads = uploads.minted;

/* Doc + photo directory resolution lives in session-state.ts (the blob
 * index owns the mapping). PHOTO_MAX/PHOTO_TYPES stay with the media routes. */


/* WHAT MAY BE STORED, by content-type and by the extension it is written with.
 *
 * A whitelist rather than a `startsWith("image/")` test, because this file is
 * served straight back to a browser with the type it was sent with: "image/*"
 * includes image/svg+xml, and an SVG is a document that runs script. The app
 * only ever posts what a camera roll produced. */

/* DISCOVERY + ENROLMENT moved to announce.ts (L3): the engine reaches OUT to
 * the app server (announce heartbeat, engine-token enrolment, the 401 token
 * drop). Constructed here at boot; started right away. */
const announce = makeAnnounce({
  e2e: E2E_STATE,
  engineHost: ENGINE_HOST,
  engineUser: ENGINE_USER,
  host: HOST,
  port: PORT,
  enginePublicUrl: ENGINE_PUBLIC_URL,
  rev: REV,
});
await announce.writeAppServerUrl();
announce.start();
const APP_SERVER_URL = announce.appServerUrl;
const ensureEnrolled = () => announce.ensureEnrolled();
const dropAppToken = (why: string) => announce.dropAppToken(why);

/* THE SIGNALING PATH: one outbound WS to the
 * app-server's same-origin relay (/engine leg), the ONE path in every mode.
 * This engine no longer listens for signaling itself; every device hands it an
 * rtc-offer through the app-server, so a phone that cannot reach this engine
 * directly (behind a home NAT, on cellular) works exactly as a same-machine one
 * does. Nothing but signaling crosses the relay; the DataChannel it negotiates
 * carries the same sealed wire.
 *
 * The address is the APP_SERVER_URL the engine already holds for push (default
 * http://127.0.0.1:10100 -> ws://127.0.0.1:10100/engine), resolved fresh on
 * every dial. RELAY_URL pins the /engine ws url explicitly. */
const relayLink = new RelayLink({
  url: async () => resolveRelayUrl(APP_SERVER_URL, E2E_STATE.engineId, process.env.RELAY_URL ?? ""),
  token: () => ensureEnrolled(),
  onAuthReject: (why) => dropAppToken(why),
  /* Device-key dial auth: the blind relay hands us the device's signed
   * proof on r-open; verify it against THIS engine's enrolled device list (the
   * one trust root that governs the seal too). The relay opens or closes the
   * device leg on this verdict; no Clerk token ever rode the URL. */
  onRelayAuth: async (auth) => {
    const v = await verifyRelayAuth(E2E_STATE, auth as any);
    LOG.line("relay.auth", { ok: v.ok, reason: v.reason });
    return v.ok;
  },
  log: (event, fields) => LOG.line(event, fields ?? {}),
  onPipe: (pipe, conn) => mintRtcClient(pipe, relaySignalSock(conn)),
});
relayLink.start();

/* Presence first (presence.ts): notify asks it, and its one call back into
 * notify -- "the grace expired, flush what is owed" -- is this onAway seam. */
initPresence({
  clients: () => clients,
  onAway: () => flushUnread(),
});

// Notify: notify.ts.
initNotify({
  clients: () => clients,
  sessions: () => sessions.values(),
  broadcastSessions: () => broadcastSessions(),
  engineHost: ENGINE_HOST,
  appServerUrl: APP_SERVER_URL,
  token: () => ensureEnrolled(),
  peekToken: () => announce.peekToken(),
  dropToken: (why) => dropAppToken(why),
  seal: (sid, title, body, count) => sealPushItemForState(E2E_STATE, sid, title, body, count),
  sealEngine: (t, b, o) => sealEngineItemForState(E2E_STATE, t, b, o),
  sessionPushTitle: (s) => sessionPushTitle(s),
});

/* The one text-size cap a route enforces itself: /session/<id>/agent-message
 * bodies (deliver.ts owns the semantics). */
const SEND_MSG_MAX = 64 * 1024;

/* Debug surface toggle, shared by the state probe route and the visibility
 * heartbeat log (notify.ts keeps its own copy for its internal lines). */
const NOTIFY_DEBUG = process.env.NOTIFY_DEBUG === "1";

// Session model + the ONE per-id state record: session-state.ts (4d).

// Audio clips: clips.ts.
await initClips({ blobOwner: () => blobOwner, agentIdFor: (id) => agentIdFor(id) });

// Read state: readstate.ts.
initReadState({
  scheduleHeardSave: (id) => scheduleHeardSave(id),
  sendDismissal: (s) => sendDismissal(s as Session),
  broadcastSessions: () => broadcastSessions(),
});

// Context/model/title caches: context-cache.ts.
initContextCache({
  sessions: () => sessions.values(),
  transcriptFile: (h) => adapter.transcriptFile(h),
  contextRead: (h) => adapter.contextRead(h),
  claudeTranscriptPath: (c, csid) => adapter.transcriptPathFor(c, csid),
  claudeContextRead: (c, csid) => adapter.contextModelRead(c, csid),
  claudeTitleRead: (c, csid) => adapter.readTitle(c, csid),
  broadcastSessions: () => broadcastSessions(),
});

// The sessions frame: sessions-frame.ts (deps injected below, hazard 2).

/* THE AGENT RECORDS, chat replay and the ONE per-id record: session-state.ts.
 * Loaded here, before anything reads a session. */
await loadSessionState({
  noteMinted: (id) => { mintedUploads.add(id); },
  broadcastSessions: () => broadcastSessions(),
  lineageOf: (id) => lineageOf(id),
});

// Chat log + queued-flag lifecycle: chatlog.ts.
initChatlog({
  chatOf: (id) => sessions.get(id)?.chat ?? restoredChats.get(id),
  restoredChats: () => restoredChats,
  persistPatch: (id, mts, set, unset) => persistPatch(id, mts, set, unset),
  broadcast: (m) => broadcast(m),
  chatRefFor: (id) => chatRefFor(id),
  indexMsgBlobs: (aid, m) => indexMsgBlobs(aid, m),
  appendMsg: (aid, chatId, m) => chatStore.appendMsg(aid, chatId, m),
  appendRec: (aid, chatId, rec) => chatStore.appendRec(aid, chatId, rec),
  /* A live record goes to every client attached to the session, the same
   * way a chat line does: one delta frame, painted into the page the app
   * already holds. */
  sendSessionRec: (id, rec) => {
    for (const ws of clients) if (ws.data.attached === id) send(ws, { t: "session-event", id, ev: rec });
  },
});

// called below, once persistPatch's state exists to write through

/* Which voice a session speaks in.
 *
 * kokoro serves dozens; using one for everything means you cannot tell who is
 * talking until you have listened to the words. A default per host, an
 * override per session, and the override wins. Empty string = "use the voice
 * engine's own default", which is what an unset value means to it. */
// The line a voice sample speaks, for the voice plugin's Play button. Same
// phrase the app server's sampler uses, so a voice sounds the same wherever it
// is auditioned.
const SAMPLE_LINE = "Hey, this is how I will read your replies.";
/* THE PUSH TITLE IS THE ONE STRING THE ROWS DRAW. It used to be the raw pane
 * name (or "CallYourCode" when that was empty), which ignored your rename and
 * Claude Code's own session title, so a chat called "Shalu AI" on screen
 * buzzed as its directory name on the phone. title.ts is the seam; the push
 * path is just another reader of the same resolved title. */
function sessionPushTitle(s: Session): string {
  return titleOf(nameOverrideOf(s.id), claudeTitleOf(s), s.name).text;
}

/* The push icon is GONE (sealed-transport enforcement): /session-photo is
 * owner-gated, so an OS-side icon fetch could never answer. Pushes carry the
 * generic app icon; avatars load in-app over the sealed tunnel. */


/* The user's global notify default + the bell resolution live in notify.ts. */


/* Re-derive the restored queued flags now, before a single client can be told
 * about one. Each cleared flag is one appended patch line in its chat. */
sweepRestoredQueued();

/* Close out any clip a restart caught mid-growth (#525), before a client can be
 * told about one. A stranded `growing: true` would make the app follow a file
 * that never grows again. */
// Spoken replies: tts.ts.
initTts({
  voiceUrl: () => voiceUrl(),
  voiceFor: (id) => voiceFor(id),
  persistPatch: (id, mts, set, unset) => persistPatch(id, mts, set, unset),
  broadcast: (m) => broadcast(m),
  restoredChats: () => restoredChats,
  /* Agent->you live speech: the same chunks stream down any fp-gated call on
   * the session (voicectl.ts) while the clip grows. Un-awaited: the clip is
   * the record and the fallback, the stream is the live enrichment. */
  streamSay: (s, msgId, chunks) => void speakToCalls(s.id, msgId, chunks, voiceFor(s.id)),
});

await sweepGrowingClips();

/* Every uploadId any chat log still mentions.
 *
 * The same union scheduleChatSave() writes: live sessions plus the restored
 * logs for panes herdr has not reported yet. Anything in there is a message
 * the app will replay, whose bubble is a thumbnail or a document card, and
 * whose `path` an agent may still be told to open. CHAT_KEEP is Infinity, so
 * once a message is in the log it stays, and so does its file.
 */
/* AND IT READS A UNION, WHERE EVERY OTHER READER READS THE ORDERED LIST.
 *
 * The asymmetry is on purpose, and it is the difference between the two jobs.
 * attachmentsOf() answers "what does this message SHOW", so when `uploads` is
 * there it wins outright and `upload` is ignored as the copy of its first
 * entry that it is supposed to be. This function answers "what could anything
 * still be pointing at", and it is the one that DELETES.
 *
 * Those come apart the moment the two fields disagree -- a half-written
 * message, an entry from a bundle that set one and not the other, a hand-edit
 * of chat.json. Then `upload` names a file the ordered list does not, an older
 * app bundle draws exactly that file, and reading the list alone would sweep
 * it. So the delete side adds both, and being too generous here costs one
 * unreclaimed file while being too clever costs the file itself.
 */
function referencedUploads(): Set<string> {
  const ids = new Set<string>();
  for (const msgs of restoredChats.values()) uploadIdsOf(msgs, ids);
  for (const s of sessions.values()) uploadIdsOf(s.chat, ids);
  return ids;
}

// The backlog is bounded at boot as well as on every upload, or a directory
// that grew while this was unbounded would sit there until the next
// attachment. restoredChats is already loaded here, so the reference set is
// complete even though no session has been seen yet.
await uploads.trimUploads("startup");

// ---------------------------------------------------------------- mux

/* turnPhase / turnSinceFor moved to ./turn.ts so the restart-age rule (#411)
 * can be tested without booting the server. The behaviour is unchanged for a
 * live transition; what changed is the boot seed (see turn.ts). */

/* THE ADAPTER SEAM. herdr by default; tmux when CYC_MUX=tmux, selected by
 * makeAdapter() (adapters/factory.ts): a MuxAdapter over its own HerdrClient, or a
 * TmuxMuxAdapter over TmuxMux + tmuxDriver. The adapter owns its Multiplexer;
 * core no longer holds a raw `mux` reference. Discovery, ask, deliver, spawn,
 * terminal and MCP all go through the adapter; the two shell-typing keystroke
 * sites (restart command, chooser digit) route through adapter.sendText /
 * adapter.sendKeys. */
const adapter = makeAdapter();

// The ask poll machine: asks.ts.
initAsks({
  readBlocked: async (paneId) => (await adapter.conversation(paneId)).blocked,
  canParseScreen: (paneId) => adapter.canParseScreen(paneId),
  sessions: () => sessions.values(),
  broadcastSessions: () => broadcastSessions(),
  logAsk: (paneId, ask, ts) => {
    const s = sessionByHandle(paneId);
    if (s) logSession(s, { ts, kind: "ask", text: ask.question });
  },
});

/* RECONCILE (reconcile.ts): the onAgents rebuild that keeps the L1
 * invariant; identity resolves through the session index (session-state)
 * and the two carry operations left in carry.ts. */
// Pane delivery: pane-deliver.ts.
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
const CLAUDE_COMMAND = adapter.launchCommand("claude")!;

/* SCHEDULES LIVE IN THE CRONS PLUGIN NOW (blueprint section 2). The store,
 * the cron math, the ticker, the fire wording and the seeding are all owned by
 * plugins/crons/, reached over the one /plugin/crons/rpc/<op> route; the
 * engine core keeps zero schedule knowledge. What used to ride the same 10s
 * boot delay as the first schedule tick stays on it: herdr has reported by
 * then, so the sessions a pending note must be delivered to exist (#458). */
setTimeout(() => {
  void sweepPendingTranscripts();
}, 10_000);

/* THE REPLY TRACE (#585 + blueprint row 26): the store is the plugin's own
 * (plugins/reply-dials/index.ts replyDialsStore); this engine keeps only the Stop
 * hook's evidence in reply-trace.ts -- noteDelivery/noteReply and the hook
 * state file. The dials themselves are a pure input transform (the plugin's own
 * postfix hook); nothing about them travels to the hook. */
const replyDials = await replyDialsStore();
initReplyTrace({
  sessions: () => sessions.values(),
  engineHost: ENGINE_HOST,
  hasSessionEvents: (kind) => adapter.hasSessionEvents(kind),
});
/* THE INPUT-TRANSFORM REGISTRY: the outgoing body is wrapped by every
 * registered plugin hook at the one delivery site (deliver.ts). The registry is
 * generic; the reply-dials plugin registers its own postfix hook when it loads
 * (plugins/reply-dials/index.ts, via core.inputTransform), so the append is the
 * plugin's own and no reply-dials-specific registration lives here at the root. */
const inputTransforms = makeInputTransformRegistry();

// Transcript ingest (the session log + the thinking indicator): ingest.ts.
initIngest({
  sessionOf: (id) => sessions.get(id),
  sessions: () => sessions.values(),
  broadcastSessions: () => broadcastSessions(),
  subscribe: (h, cb, from) => adapter.subscribe(h, cb, from),
  readTranscriptSpan: (p, from, to, handle) => adapter.readTranscriptSpan(p, from, to, handle),
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
  log: (e, f) => LOG.line(e, f),
});

// ---------------------------------------------------------------- speech

// ---------------------------------------------------------------- http

// The HTTP API is NOT CORS-open any more (H1 fix): no browser fetches this
// engine cross-origin (the app rides the sealed tunnel), so no response
// carries a CORS grant and a disallowed browser Origin is refused outright
// (refuseForbiddenOrigin, wired on the TCP feed below).
/* The /voice/* proxy and the voice-engine pick moved to voice-proxy.ts (L3). */

/* THE ONE REQUEST ROUTER. Two feeds, one route table: the localhost HTTP
 * server (Bun.serve fetch) hands it the requests it reads off the socket, and
 * the sealed tunnel (tunnel-glue.ts onReq) hands it the requests it
 * synthesizes from sealed {t:"req"} frames. Every route, gate, and body limit
 * behaves identically on both feeds because they meet here. */
async function routeRequest(req: Request, server: import("bun").Server): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  /* /ws is the LOCAL AGENT CHANNEL now, loopback only (#relay-fold): browser
   * signaling moved to the app-server's same-origin relay (this engine dials
   * OUT via relayLink), but the callyourcode MCP -- a process on THIS machine,
   * beside the agent -- still speaks plain WS here (chat/speak/show delivery).
   * Loopback is the sealed-wire trust boundary (requireOwner: true loopback +
   * the sealed tunnel only), so a non-loopback upgrade is refused outright. */
  if (path === "/ws") {
    /* /ws gates on isLoopbackTrusted, NOT isTrustedLocal, ON PURPOSE: this is
     * the herdr/agent channel and the mux readers dial loopback TCP, so it
     * must keep passing on loopback regardless of the CYC_ALLOW_LOOPBACK_LOCAL
     * transition flag (which flips the local-trust HTTP surfaces to socket-only
     * a release from now). Moving /ws onto the unix socket is OUT OF SCOPE here;
     * the mux lane owns that residual. isLoopbackTrusted still refuses a browser
     * page's disallowed Origin (H2), same as before. */
    if (!isLoopbackTrusted(req, server)) return new Response("loopback only", { status: 403 });
    const ok = server.upgrade(req, {
      data: { role: null, sessionId: null, attached: null,
        visible: true, visibleAt: Date.now(), beatMs: 0, gaps: [], lastFrame: Date.now(),
        pongAt: 0, probeAt: 0, probeSeq: 0, cid: nextClientCid(), openedAt: Date.now(),
        tailing: null, terms: new Map(),
        remoteAddr: server.requestIP(req)?.address ?? null,
        reachedHost: req.headers.get("host") ?? null } satisfies SockData,
    });
    return ok ? undefined as unknown as Response : new Response("expected websocket", { status: 400 });
  }

  if (req.method === "OPTIONS") {
    /* A bodyless 204 with NO CORS grant: the engine stopped advertising
     * cross-origin access entirely (H1 fix, httpx.ts), so a browser preflight
     * finds nothing allowed and blocks the caller. Nothing legitimate
     * preflights this engine: the app rides the sealed tunnel, and local
     * scripts never send OPTIONS. Kept as a polite no-op, not a grant. */
    return new Response(null, { status: 204 });
  }

  /* THE HOOK ANNOUNCE (hook-announce.ts): claude's own
   * SessionStart/UserPromptSubmit hook says "session Y, pid N" over loopback.
   * requireLocal, like /agent-message: the hook runs ON this machine, the app
   * never calls this, and no new auth surface exists for it. */
  if (req.method === "POST" && path === "/harness/announce") {
    const denied = requireLocal(req, server);
    if (denied) return denied;
    let body: unknown;
    try { body = await req.json(); } catch { return jsonAnswer({ ok: false, error: "bad json" }, 400); }
    /* `cyc doctor` round-trips this route with {probe:true} to prove the
     * announce lane is reachable without minting or rebinding any session:
     * answer ok and change NOTHING (no handleAnnounce). */
    if (body && typeof body === "object" && (body as { probe?: unknown }).probe === true) {
      return jsonAnswer({ ok: true, probe: true }, 200);
    }
    const r = await handleAnnounce(body);
    return jsonAnswer(r, r.ok ? 200 : 400);
  }

  /* THE LOOPBACK REPLY POST (mcp-http): the callyourcode MCP delivers
   * speak/chat/show here, ONE POST per tool call, and the HTTP response IS the
   * ack. Stateless: no register frame, no persistent socket, no reconnect -- an
   * engine restart cannot strand a session's delivery the way the /ws register
   * did (a socket left holding a raw pane id, every reply on it dropped).
   *
   * LOOPBACK-ONLY, EXACTLY LIKE /ws AND /harness/announce, and this gate is the
   * whole of the trust: the route puts a message into the user's app WITHOUT the
   * sealed handshake, admitted only because the caller is a process on this box
   * (the MCP beside the agent). isTrustedLocal is loopback peer AND no
   * x-forwarded-for, so a reverse-proxied or tailnet caller is refused 403; it
   * is never reachable over the wire even by a paired device. Do not weaken. */
  if (req.method === "POST" && path === "/agent/reply") {
    if (!isTrustedLocal(req, server)) {
      return jsonAnswer({ ok: false, error: "agent-reply is local-only (this machine)" }, 403);
    }
    let body: any;
    try { body = await req.json(); } catch { return jsonAnswer({ ok: false, error: "bad json" }, 400); }
    /* `cyc doctor`'s reply-leg probe: answer ok and deliver NOTHING (no pane
     * resolution, no session write), the reply twin of the announce probe. */
    if (body?.probe === true) return jsonAnswer({ ok: true, probe: true }, 200);
    const pane = String(body?.pane ?? "").trim();
    /* The SAME resolution onRegister uses: the mux resolves the raw pane id to
     * the opaque handle core keys sessions by (sessionByHandle is handle-segment
     * aware, so a bare $TMUX_PANE still matches). Falls back to a direct id
     * lookup for a socket that is not a mux pane, exactly as onRegister does. */
    const handle = pane ? (adapter.resolveHandle(pane) ?? null) : null;
    const s = handle ? sessionByHandle(handle) : (pane ? sessions.get(pane) : undefined);
    if (!s) {
      /* No live session: the SAME wording onReply uses for its DROPPED case, at
       * HTTP 200 (never 500), so the agent's Stop hook retries the reply in a
       * moment rather than treating it as a hard failure. */
      return jsonAnswer({ ok: false,
        message: "this session is not registered with the engine yet; retry the reply in a moment" }, 200);
    }
    /* The MCP declares its CHANNELS on every reply now that register is gone;
     * keep them on the session so askFor's wording bend still knows what this
     * build can deliver (the one thing onRegister used to set that delivery
     * needs). Same filter onRegister applied. */
    if (Array.isArray(body?.channels)) {
      s.channels = body.channels.filter((c: unknown) => typeof c === "string").slice(0, 16);
    }
    const kind = body?.kind;
    if (kind === "show") {
      const ack = await deliverShow(s as unknown as ShowSession, String(body?.path ?? ""));
      return jsonAnswer(ack, 200);
    }
    if (kind === "speak" || kind === "chat") {
      const ack = await deliverReply(s, {
        aloud: kind === "speak", text: String(body?.text ?? ""), msgId: body?.msgId, key: body?.key,
      });
      // A null ack is empty text (the MCP never sends it): answer ok-shaped.
      if (!ack) return jsonAnswer({ ok: true, message: kind === "speak" ? "spoke" : "sent to the chat" }, 200);
      return jsonAnswer({ ok: ack.ok, message: ack.message, ...(ack.seq !== undefined ? { seq: ack.seq } : {}) }, 200);
    }
    return jsonAnswer({ ok: false, message: `unknown reply kind: ${String(kind)}` }, 200);
  }

  /* THE LOOPBACK INFO POST (mcp-http): the `info` tool's stateless twin. The MCP
   * no longer holds a socket to ask over, so it POSTs its pane here and the
   * engine answers who the agent on that pane IS (stable agent id, name, cwd,
   * harness). Loopback-only, same gate as /agent/reply. */
  if (req.method === "POST" && path === "/agent/info") {
    if (!isTrustedLocal(req, server)) {
      return jsonAnswer({ ok: false, error: "agent-info is local-only (this machine)" }, 403);
    }
    let body: any;
    try { body = await req.json(); } catch { return jsonAnswer({ ok: false, error: "bad json" }, 400); }
    const pane = String(body?.pane ?? "").trim();
    const handle = pane ? (adapter.resolveHandle(pane) ?? null) : null;
    const s = handle ? sessionByHandle(handle) : (pane ? sessions.get(pane) : undefined);
    if (!s) return jsonAnswer({ ok: false, message: "this connection is not a registered agent" }, 200);
    return jsonAnswer({ ok: true, ...agentInfo(s) }, 200);
  }

  /* The voice contract on THIS engine's origin (/voice/*, in the route table).
   * The app talks to this engine, which forwards to the configured voice engine
   * (VOICE_URL), so the app no longer needs a second host. The mic STREAM does
   * not upgrade here any more: /voice/stt-stream is REMOVED because a WS
   * upgrade can never carry the in-process sealed-tunnel
   * mark and so could never be owner-gated. Streaming STT rides the sealed
   * DataChannel as stt-open/stt-b/stt-close client frames (frames.ts), bridged
   * to the voice engine over loopback by voice-proxy.ts. */

  /* THE ROUTE TABLE (hazard 4): one context object built at boot, one walk.
   * Group order preserves the old if-chain's matching order. */
  for (const group of ROUTE_GROUPS) {
    const r = await group(routesCtx, req, url, path, server);
    if (r) return r;
  }


  /* The engine's own root no longer serves the old public/ voice page (deleted:
   * its ws dial and mute frame are dead ends on the sealed wire). Point it at
   * the app front instead. */
  if (req.method === "GET" && path === "/") {
    return new Response("the engine UI is the app front", {
      status: 302,
      headers: { location: APP_SERVER_URL },
    });
  }
  return new Response("not found", { status: 404 });
}

/* THE MCP SOCKET (mcp.ts, L4): register + the session-role frame routing. */

// The agent->app path: reply.ts.
initReply({
  sessionOf: (id) => sessions.get(id),
  sessionByHandle: (handle) => sessionByHandle(handle),
  resolveSession: (id) => resolveSession(id),
  send: (ws, m) => send(ws, m),
  broadcast: (m) => broadcast(m),
  broadcastSessions: () => broadcastSessions(),
  log: (e, f) => LOG.line(e, f),
  noteReply: (id) => noteReply(id),
  notifyUnlessWatched: (s, n) => notifyUnlessWatched(s as Session, n),
  sessionPushTitle: (s) => sessionPushTitle(s as Session),
});

// Attach + lineage: attach.ts / lineage.ts.
initLineage(
  { scheduleAgentSave: (id) => scheduleAgentSave(id), log: (e, f) => LOG.line(e, f),
    streamLines: (p, onLine) => adapter.streamTranscriptLines(p, onLine) },
  [...agentMetas.values()]
    .filter((m) => Array.isArray(m.lineage) && m.lineage.length)
    .map((m) => [m.agentId, m.lineage!] as [string, string[]]),
);
initAttach({
  sessionOf: (id) => sessions.get(id),
  send: (ws, m) => send(ws, m),
  broadcastSessions: () => broadcastSessions(),
  scheduleHeardSave: (id) => scheduleHeardSave(id),
  log: (e, f) => LOG.line(e, f),
});

/** Everything this engine will promise an app it can do. See the `can` frame.
 *  "plugins" (#479) says this engine speaks the plugin protocol: it may send a
 *  `{t:"plugins"}` frame and answer /plugin/<id>/* routes. Additive, per the
 *  CONTRACT.md back-compat rule -- an old app ignores an unknown capability. */
const ENGINE_CAN = ["words", "plugins"];

/* THE PLUGINS THIS ENGINE LOADED, and their wire declarations, computed once at
 * start-up from the same list in the same statement (the sessionsFrame rule:
 * declaring from a second list is a second answer that can drift). Functions
 * stay in PLUGINS (render/rpc/html/dedupe are engine-side); only PLUGIN_DECLS
 * ever crosses the wire. */
/* The crons plugin is a FULL plugin now (blueprint section 2): it owns the
 * schedules store, the cron math, its own ticker, the fire wording and the
 * seeding, and it reaches this engine only through the minimal PluginHost --
 * the two stores plus deliver() with the guardCwd identity check. Sessions
 * are keyed by the agent id, so the lookup is the map read. */
const sessionByAgent = (aid: string): Session | undefined => sessions.get(aid);

/* ONE PluginHost WIRING, shared by the crons host and every migrated plugin's
 * PluginCore: the live-session lookup and the deliverToAgent primitive (the
 * shape the crons bag already built). */
const hostWiring: HostWiring = {
  sessionFor: (aid) => {
    const s = sessionByAgent(aid);
    return s ? { cwd: s.cwd } : null;
  },
  deliverText: async (aid, m) => {
    const s = sessionByAgent(aid);
    /* Between sessionFor and here the session can only have vanished; the
     * same retriable answer the host gives for no-session-at-all. */
    if (!s) {
      return { ok: false, retriable: true,
        why: "this engine has no live session for that agent right now" };
    }
    const res = await deliverToAgent(s, m);
    return { ok: res.ok, why: res.why, retriable: res.retriable };
  },
};

/* ============ THE TYPED PLUGIN CORE ============================
 *
 * The ONE typed API a migrated plugin programs against (platform/core.ts). Built
 * once here over the capability dispatch (real harness caps + the mux keystroke
 * baseline) and the core services, then handed to each plugin by id. As a plugin
 * moves onto `core.read/command/tts/searchChat/...` (below), its bespoke deps
 * bag in loadPlugins() dies. */

/** The coarse lifecycle a harness cap answers `status()` with, off the live
 *  session snapshot (mirrors the adapter's own lifecycleOf mapping). */
function lifecycleOfHandle(handle: string): AgentLifecycle {
  const s = sessionByHandle(handle);
  if (!s || !s.alive) return "gone";
  switch (s.status) {
    case "blocked": return "blocked";
    case "working":
    case "done": return "running";
    default: return "started"; // idle, unknown: listed and alive, no turn in flight
  }
}

/* The one source of truth for the harness kinds + their capabilities: the READERS
 * table, surfaced by the adapter. The caps resolver is built from it and the
 * usage-card's kind list is folded over it, so pi (and any future reader) is
 * included automatically -- no hardcoded harness list. */
const harnessProfiles = adapter.harnessProfiles();

const harnessFor = makeHarnessCaps({
  profiles: harnessProfiles,
  muxContextRead: (h) => adapter.contextRead(h),
  /* the native model/context read, routed through the adapter seam (byte-identical
   * to the old in-file claude jsonl read); claude's caps read {used,total,pct} off it. */
  contextModelRead: (c, csid) => adapter.contextModelRead(c, csid),
  conversation: (h) => adapter.conversation(h),
  lifecycle: (h) => lifecycleOfHandle(h),
  /* /compact keeps its exact {ok, tell} tells: resolve the live session by
   * handle and delegate to the one compactSession body (session-verbs.ts). */
  claudeCompact: async (h) => {
    const s = sessionByHandle(h);
    return s ? compactSession(s.id)
      : { ok: false, tell: "that session is not running, so nothing was compacted" };
  },
  claudeUsage: (force) => limitsNow(force),
});

const dispatch = makeCapabilityDispatch({
  /* Accepts an agent id too, so a read/command may be addressed by agent id.
   * RESOLVES LIKE THE REPLY PATH: exact id, then the live pane by handle, then
   * the re-key alias (superseded id -> successor), then the stable agent id.
   * An attached app keeps addressing the id it captured before a park->uuid
   * mint or a uuid roll; the chat path always resolved those, but the dispatch
   * only did exact-id + agent-id, so every read (model, contextPct, status)
   * answered null for a live linked session the app was actively chatting with. */
  sessionOf: (id) => {
    const s = resolveSession(id);
    if (!s) return undefined;
    // The one session-id field. Only the NATIVE (claude)
    // caps read ref.harnessSessionId (harness-caps.ts nativeModel/nativeContext);
    // every non-claude cap resolves by handle and ignores it, and the claude
    // value is unchanged, so this is byte-identical to the retired claudeSessionId.
    return { handle: s.muxHandle, cwd: s.cwd, harnessSessionId: s.harnessSessionId,
      kind: s.agent.id, name: s.agent.name, viaMux: s.viaMux, alive: s.alive };
  },
  harnessFor,
  /* The harness kinds this engine can answer usage for, DERIVED from the READERS
   * table (harnessProfiles), each flagged ACTIVE when a live session runs that
   * harness. The usage-card folds account usage across the active ones; `s.agent.id`
   * is the normalized harness tag (agents.ts), matching the reader tag. */
  harnessKinds: () => harnessProfiles.map(({ tag }) => ({
    kind: tag, active: [...sessions.values()].some((s) => s.alive && s.agent.id === tag),
  })),
  muxInput: {
    sendText: async (ref, text) => {
      // A raw "type this into the pane" with no user cid: a synthetic delivery id
      // for the unsubmitted keying only (per-call, like deliverToAgent's).
      try { await deliverToPane(ref.handle, text, newCid("mux")); return { ok: true, tell: "typed" }; }
      catch (e) {
        return { ok: false,
          tell: e instanceof PaneNotReady ? e.tell : "that pane would not take the keystrokes" };
      }
    },
    interrupt: async (ref) => { await adapter.interrupt(ref.handle); return { ok: true, tell: "sent the interrupt key" }; },
  },
});

const pluginServices: PluginCoreServices = {
  dispatch,
  tts: {
    list: () => listHostVoices(),
    sample: async (v) => {
      const bytes = await ttsWithVoice(SAMPLE_LINE, v || globalVoice() || undefined, "voice-sample");
      return bytes ? b64encode(bytes) : null;
    },
    // the per-session voice choice + host default, the SAME state
    // the /voices/default and /session/<id>/voice routes use.
    voiceOf: (id) => voiceOverrideOf(id) ?? "",
    setVoice: (id, v) => { setVoiceOverride(id, v); },
    globalDefault: () => globalVoice(),
    setDefault: (v) => { setDefaultVoice(v); },
    sessionExists: (id) => sessions.has(id),
  },
  searchChat: (id, q) => {
    const s = sessions.get(id);
    return s ? scanChat(s.chat, searchableText, q) : null;
  },
  notifyDevices: (n) => notifyDevices(n),
  notifyEngine: (n) => notifyEngineDevices(n),
  registerInputTransform: (pid, hook) => inputTransforms.register(pid, hook),
  paneTerminalStream: (id, cols, rows, h) => {
    const s = sessions.get(id);
    return s ? adapter.openTerminal(s.muxHandle, cols, rows, h as any) : null;
  },
};

const pluginCore = (id: string): PluginCore => makePluginCore(id, hostWiring, pluginServices);

const PLUGINS: PluginSpec[] = loadPlugins({
  core: pluginCore,
  /* The usage card's limits poll: the plugin OWNS its ticker now (it runs the
   * grid loop through its own clock). A threshold crossing goes out as an
   * engine-level sealed push via core.notifyEngine, so no push seam is wired
   * here; this bag is only the poll grid + phase + interval from limits.ts. */
  usage: {
    phaseKey: `${ENGINE_HOST}:${ENGINE_USER}:${PORT}`,
    host: ENGINE_HOST,
    // the limits side, injected so the plugin imports no limits.ts (usage is an
    // adapter fact): the crossings drain and the poll grid/phase/interval.
    takeAlerts: () => takeAlerts(),
    nextPollAt: (now, phase) => nextPollAt(now, phase),
    pollPhaseMs: (key) => pollPhaseMs(key),
    pollIntervalMs: LIMITS_POLL_MS,
  },
  /* Crons takes its host verbs off the typed core now (core("crons")), so the
   * bag is just the marker that this engine wires the schedules vertical. */
  crons: true,
  // search reads core.searchChat now (the one chat-search.ts matcher); the marker
  // just says this engine wires the Search panel.
  search: true,
  /* The model reading is core.read("model") now (harness-caps answers the raw id
   * for claude, the transcript model string for others; the plugin maps it). The
   * one residual is the HARNESS KIND, which has no PluginCore read: the agent id,
   * for the panel's "Harness: <name>" line. */
  model: {
    harness: (id) => sessions.get(id)?.agent.id ?? null,
  },
  // persona reads core.tts (list/sample + the voiceOf/setVoice/globalDefault/
  // setDefault members above) now; the marker just says this engine wires it.
  persona: true,
  /* The reply dials (#585): verbosity, complexity and the prompt-bits menu, over
   * the store built at boot. Its composer surface is a live function of the
   * store's state, so a dial change re-declares (redeclarePlugins below). */
  dials: { store: replyDials },
  // ctx reads core.read("contextPct") and core.command("compact") now; the marker
  // just says this engine wires the Context button.
  ctx: true,
  // stop is a plugin like any other now (the flag defaults on): the marker says
  // this engine wires the Ctrl-C interrupt button.
  stop: true,
});
/* LIVE decls (#585): a plugin state change re-declares the whole list and
 * broadcasts it, so every attached client repaints the composer from the new
 * decl (its slider `value` moved). `let`, not `const`, for exactly that. */
let PLUGIN_DECLS: PluginDecl[] = declarePlugins(PLUGINS);
const pluginById = (id: string): PluginSpec | undefined => PLUGINS.find((p) => p.id === id);
function redeclarePlugins() {
  PLUGIN_DECLS = declarePlugins(PLUGINS);
  broadcast({ t: "plugins", list: PLUGIN_DECLS });
}

/* The sessions frame's boot deps, injected once the decls exist (hazard 2). */
initSessionsFrame({
  engineCan: ENGINE_CAN,
  pluginDecls: () => PLUGIN_DECLS,
  voiceHealthy: () => voiceHealthy(),
  voiceReady: () => voiceReady(),
  voicePublicUrl: VOICE_PUBLIC_URL,
  engineUser: ENGINE_USER,
  engineHost: ENGINE_HOST,
  tabs: ENGINE_TABS,
  replyLevel: () => replyDials.level(),
  hasSessionEvents: (kind) => adapter.hasSessionEvents(kind),
});
/* Now that redeclarePlugins exists, wire the store's onChange: every dial
 * mutation re-declares (new slider value) and rebroadcasts the sessions frame
 * (replyLevel shim). It does NOT touch the hook state: the hook reads no dial
 * state, so a dial change writes nothing there. */
replyDials.onChange = () => { redeclarePlugins(); broadcastSessions(); };

/* The plugin route helpers (state file paths, caps, card cache) live in
 * routes/plugin.ts with the routes that use them. */

// Transcription: transcribe.ts.
initTranscribe({
  voiceUrl: () => voiceUrl(),
  log: (e, f) => LOG.line(e, f),
  broadcast: (m) => broadcast(m),
  inOrder: (id, f) => inOrder(id, f),
  deliver: (s, opts) => injectUserMessage(s as Session, opts),
  sessionOf: (id) => sessions.get(id),
  restoredChats: () => restoredChats,
});

// Delivery: deliver.ts.
initDeliver({
  sessionOf: (id) => sessions.get(id),
  send: (ws, m) => send(ws, m),
  broadcast: (m) => broadcast(m),
  log: (e, f) => LOG.line(e, f),
  transformOutgoing: (input) => applyInputTransform(inputTransforms.hooks(), input),
  noteDelivery: (id, how) => noteDelivery(id, how),
  forgetDelivery: (id, entry) => forgetDelivery(id, entry),
  writeHookState: () => writeHookState(),
  bindOwnedUploads: (claimed, cid) => uploads.bindOwnedUploads(claimed, cid),
  adoptStagedUploads: (id, ups) => uploads.adoptStagedUploads(id, ups),
});

// MCP show: show-handler.ts.
initShowHandler({
  sessionOf: (id) => sessions.get(id),
  agentIdFor: (id) => agentIdFor(id),
  claimBlob: (docId, aid) => blobOwner.set(docId, aid),
  docDirFor: (aid) => docDirFor(aid),
  send: (ws, m) => send(ws, m),
  broadcast: (m) => broadcast(m),
  notifyUnlessWatched: (s, n) => notifyUnlessWatched(s as Session, n),
  sessionPushTitle: (s) => sessionPushTitle(s as Session),
  noteReply: (id) => noteReply(id),
});

// Session verbs: session-verbs.ts.
initSessionVerbs({
  sessionOf: (id) => sessions.get(id),
  launchCommand: (agentId) => adapter.launchCommand(agentId),
  // /compact and friends carry no user cid: a synthetic delivery id for the
  // unsubmitted keying only (per-call, like deliverToAgent's).
  deliverToPane: (paneId, text) => deliverToPane(paneId, text, newCid("compact")),
  paneNotReadyTell: (e) => (e instanceof PaneNotReady ? e.tell : null),
  interrupt: (paneId) => adapter.interrupt(paneId),
  onPaneKeyboard: (f) => onPaneKeyboard(f),
  sendKeys: (paneId, keys) => adapter.sendKeys(paneId, keys),
  send: (ws, m) => send(ws, m),
  broadcast: (m) => broadcast(m),
  broadcastSessions: () => broadcastSessions(),
  log: (e, f) => LOG.line(e, f),
});

/* The client-frame dispatch, the terminal ws handlers and closeClient live
 * in frames.ts (L4). */

/* THE SERVICES THIS HOST RUNS, started before the first request is answered.
 *
 * kokoro and the memory guard used to be processes in a herdr tab, started by
 * hand: they died with the tab, nothing brought them back, and their state
 * lived in a scrollback rather than anywhere the app could see. The engine is
 * the thing launchd keeps alive, so the engine is where they belong (see
 * services.ts for what it will and will not do to a process).
 *
 * The first check is AWAITED. An engine that answered /health while still
 * describing its services from a default would be asserting what it has not
 * looked at, which is the failure this whole endpoint exists to avoid. */
const serviceSpecs = await loadServices();

/* The voice-frame diff gate's memory. Declared BEFORE the supervisor exists:
 * broadcastVoice (hoisted, defined below) already runs during the awaited
 * first check, and a `let` still in its temporal dead zone there would crash
 * the boot. */
let lastVoiceKey: string | null = null;

/* THE VOICE MODELS DOWNLOAD IN THE BACKGROUND (modelwarmup.ts): a fresh
 * install boots the engine INSTANTLY and whisper's ~1.6 GB + kokoro's ~330 MB
 * land while it serves. Which kinds this engine warms is decided from its OWN
 * service table -- a test engine's scratch table (CYC_SERVICES_FILE) has no
 * whisper/kokoro rows, so no test ever downloads anything -- and only when the
 * service's install directory exists at all: an account with no kokoro
 * checkout does not get 330 MB poured into a directory nothing would read.
 * Every later boot finds the files present and this does nothing. */
const warmKinds: { kind: WarmupKind; files: { url: string; dest: string }[] }[] = [];
/* Both models are stamped on the ONE voice-engine row now (its sherpa backend
 * serves TTS and STT in-process, and polls the disk to come ready when these
 * land). A scratch table (CYC_SERVICES_FILE) stamps no needsModel, so no test
 * ever downloads anything. No existsSync guard on the models dir: it does not
 * pre-exist on a fresh install, and download() mkdirs it. */
if (serviceSpecs.some((s) => s.key === "voice-engine" && s.needsModel)) {
  warmKinds.push({ kind: "whisper", files: requiredModelFiles("whisper") });
  warmKinds.push({ kind: "kokoro", files: requiredModelFiles("kokoro") });
}
const modelWarmup = new ModelWarmup(warmKinds, {
  log: (line) => console.log(`[models] ${line}`),
  incident: (line) => {
    console.log(`[models] ${line}`);
    LOG.line("model.download", { why: line });
  },
  /* The model just landed: have the supervisor look NOW (the presence gate
   * opens and the service starts this pass, not next tick), and tell every
   * client the download hint cleared. Readiness itself flips when the service
   * binds its port, on the check pass that sees it. */
  onSettled: () => {
    void services.check();
    broadcastVoice();
  },
});

const services = new Services(serviceSpecs, {
  log: (line) => console.log(`[services] ${line}`),
  incident: (line) => {
    console.log(`[services] ${line}`);
    LOG.line("service.incident", { why: line });
  },
  intervalMs: Number(process.env.CYC_SERVICES_INTERVAL_MS) || undefined,
  restartBaseMs: Number(process.env.CYC_SERVICES_RESTART_MS) || undefined,
  leaseStaleMs: Number(process.env.CYC_SERVICES_LEASE_STALE_MS) || undefined,
  /* A connect-time voice frame goes stale the moment the voice unit's health
   * changes: a member dies mid-session and the app keeps showing a mic that
   * records into nothing, or the supervisor's post-restart warm-up flips a
   * fresh false to true. So when the unit flips, every client is told on the
   * same {t:"voice"} frame the connect handler sends. Services diff-gates this,
   * so it is a flip and not a per-tick frame. */
  onUnitHealth: (name) => {
    if (name !== "voice") return;
    broadcastVoice();
  },
  /* Per-capability readiness can flip WITHOUT the unit flipping (kokoro comes
   * up while whisper still downloads), so every settled pass re-reads it;
   * broadcastVoice diff-gates, so a pass that changed nothing sends nothing. */
  onCheck: () => broadcastVoice(),
});
await services.start();
/* AFTER the awaited first check, and never awaited itself: the engine is
 * already alive and serving; the models arrive when they arrive. */
modelWarmup.start();

/* The voice unit's health for the app's item-8 half: the app hides the mic,
 * press-and-hold and call mode when a live {t:"voice"} frame carries
 * healthy:false. A "voice" unit with every member up is true; a member down is
 * false (units() is all-or-none). NO "voice" unit at all -- a modifier that
 * runs no voice services -- is an honest false: no voice means no mic, which is
 * the truthful report rather than "assume voice is on". This engine always
 * sends the field; the absent-field-means-healthy back-compat is the app's, for
 * old engines, and is not emulated here. */
function voiceHealthy(): boolean {
  const u = services.units().find((unit) => unit.name === "voice");
  return u ? u.healthy : false;
}

/* PER-CAPABILITY VOICE READINESS (the background-model-download story): each
 * half of voice on its own, because on a fresh install kokoro's model lands
 * long before whisper's and tts can serve while stt still warms up. A
 * capability is ready when its model files are on disk AND its service is
 * listening; an engine whose table has no such service answers false, the same
 * honest no-assumption voiceHealthy makes. */
function capReady(kind: "whisper" | "kokoro"): boolean {
  const row = services.health().find((r) => r.key === "voice-engine");
  if (!row || !row.running) return false;
  const spec = serviceSpecs.find((s) => s.key === "voice-engine");
  /* A spec with no gate (a scratch table) claims nothing about models, so a
   * running voice engine is taken at its word, exactly as before. */
  if (spec === undefined || spec.needsModel === undefined) return true;
  return modelPresencePaths(kind).every((p) => existsSync(p));
}

function voiceReady(): VoiceReady {
  const download: { stt?: number | null; tts?: number | null } = {};
  /* The warm-up KIND names the model family (whisper/kokoro); the ONE service
   * that serves both is the voice engine. */
  const whisper = modelWarmup.status("whisper");
  const kokoro = modelWarmup.status("kokoro");
  if (whisper.downloading) download.stt = whisper.pct;
  if (kokoro.downloading) download.tts = kokoro.pct;
  return { stt: capReady("whisper"), tts: capReady("kokoro"),
    ...(Object.keys(download).length ? { download } : {}) };
}

/* The one voice-frame rebroadcast, DIFF-GATED on what a client acts on (the
 * unit health, each capability's readiness, and whether a download is in
 * flight -- not the moving percent, which would be a frame per chunk). Wired
 * to the unit flip, to every settled supervision pass, and to a model
 * landing. */
function broadcastVoice(): void {
  const ready = voiceReady();
  const healthy = voiceHealthy();
  const key = `${healthy}|${ready.stt}|${ready.tts}|` +
    (ready.download ? Object.keys(ready.download).sort().join(",") : "");
  if (key === lastVoiceKey) return;
  lastVoiceKey = key;
  broadcast(voiceFrame(VOICE_PUBLIC_URL, healthy, ready));
}

/* WHY A VOICE CAPABILITY MUST BE REFUSED RIGHT NOW, or null to let the proxy
 * answer. Only the failure mode this engine positively knows -- the model
 * files are not on disk yet -- is refused here, with the one clear sentence;
 * a service that is merely down keeps its old 502 through the proxy. */
function voiceGate(cap: "stt" | "tts"): string | null {
  // ONE service serves both capabilities now; the warm-up KIND still names
  // the model family behind each.
  const warmKind: WarmupKind = cap === "stt" ? "whisper" : "kokoro";
  const spec = serviceSpecs.find((s) => s.key === "voice-engine");
  if (!spec?.needsModel) return null;
  if (modelPresencePaths(warmKind).every((p) => existsSync(p))) return null;
  const st = modelWarmup.status(warmKind);
  const what = cap === "stt" ? "transcription" : "speech";
  const name = warmKind === "whisper"
    ? whisperModelName(currentWhisperSize()) : kokoroModelName(currentKokoroVariant());
  return `voice not ready: the ${what} model ${name} is still ` +
    (st.downloading ? `downloading${st.pct !== null ? ` (${st.pct}%)` : ""}` : "missing") +
    "; it is fetched in the background and this capability comes up when it lands";
}

// A modifier who set the retired ENGINE_AGENT / ENGINE_AGENT_NAME learns at boot
// that they are ignored (every agent-stamped pane is listed now); agents.ts.
warnRetiredEnv();

/* The rtc client glue (reachedAddrOf, onSignalOffer, mintRtcClient) lives in
 * rtc-glue.ts (L4). */

const server = Bun.serve<SockData>({
  port: PORT,
  hostname: HOST,
  // Above Bun's 128MB default, or a 300MB voice note dies at the HTTP layer
  // before USER_AUDIO_MAX ever sees it. Headroom over the cap for envelope.
  maxRequestBodySize: 320 * 1024 * 1024,
  /* Above Bun's 10s default so a slow-but-legitimate request can answer (#577). A
   * forced usage-card refresh runs limitsNow(true): two parallel 10s upstream
   * fetches, so the render can sit near CARD_RENDER_TIMEOUT_MS.refresh (12s). At
   * the 10s default Bun closes the socket first and the app sees a dropped
   * connection instead of the engine's own 500. 30s clears the 12s budget with
   * margin; streaming responses write data and reset the timer on their own. */
  idleTimeout: 30,
  /* THE HOST GATE, THEN THE BROWSER ORIGIN GATE, ON THE TCP FEED (H1 fix +
   * the DNS-rebinding residual). First the Host header: a request whose Host
   * is not a name this engine is legitimately reached by (loopback, the bound
   * address, this machine's own/tailnet name, a configured front) is a
   * DNS-rebound page -- the shape that carries NO Origin at all and arrives
   * from a true loopback peer -- and it is refused before the router runs; a
   * missing Host fails closed too (httpx.ts refuseForbiddenHost). Then the
   * Origin header: a request naming a disallowed origin is a web page in a
   * browser on this host reaching into the loopback port; refused on every
   * route including the ungated ones (/health, the / redirect, OPTIONS, the
   * /ws upgrade). A request with a loopback Host and NO Origin header (the
   * cyc CLI, the harness hooks, the MCP, cron, the app-server's /health poll)
   * passes untouched. The sealed tunnel feed (initTunnel) calls routeRequest
   * directly and never passes through either, so the app's own path is
   * byte-identical. The gated routes ALSO refuse a disallowed Host or Origin
   * inside isTrustedLocal (httpx.ts), so this line is the uniform surface and
   * that one is the defense in depth. */
  fetch: (req, server) => refuseForbiddenHost(req) ?? refuseForbiddenOrigin(req) ?? routeRequest(req, server),
  /* The five ws handlers (role election, session frames, client dispatch,
   * signaling, voice relay) live in frames.ts: makeWsHandlers(). */
  websocket: makeWsHandlers({ onSignalOffer }),
});

/* THE SECOND LISTENER: the local API on a unix domain socket (engine-socket
 * plan, item 1). Loopback TCP is not user-scoped -- any local uid can POST
 * /new-session, /agent/reply, /agent/info -- so the same-uid callers (the MCP,
 * the harness hooks, the cyc CLI, cron) get a filesystem-scoped door instead:
 * the socket lives at ~/.callyourcode/engine.sock (that dir is already 0700)
 * and is chmod 0600, so only this user can open it.
 *
 * ZERO ROUTE DUPLICATION: it feeds the SAME routeRequest, with the SAME body
 * limit and idle timeout as the TCP serve (uploads can ride the socket). Two
 * differences from the TCP feed, both deliberate:
 *   - it marks every request it builds (markLocalSocket), so isTrustedLocal
 *     trusts the peer before the requestIP look-up that a unix peer has no
 *     answer for;
 *   - it SKIPS refuseForbiddenHost/refuseForbiddenOrigin: a unix request may
 *     carry no meaningful Host, and a filesystem-permission peer is not a
 *     browser drive-by, so the DNS-rebinding / cross-origin gates do not apply.
 * A stale socket from a SIGKILLed previous life is unlinked before bind; chmod
 * tightens the freshly-bound socket to 0600. The TCP listener is untouched --
 * it stays up all through the transition (the distribution instance).
 *
 * LIVENESS BEFORE UNLINK (footgun the port-base feature invites). A path on
 * disk is either a live engine's socket or a stale file from a SIGKILLed
 * previous life. Unlinking it UNCONDITIONALLY (the first cut of this code) let
 * a second same-datadir engine HIJACK a live one: the first process keeps its
 * already-open listen fd, but the path now points at the second, so new local
 * callers (MCP, hook, cyc) silently reach the wrong engine. Now: probe the
 * socket first (a connect attempt); if something ANSWERS, refuse to boot with a
 * fatal line naming the path, rather than stealing it. Two same-datadir engines
 * that want to coexist set CYC_PORT_BASE (which moves the socket NAME too, see
 * defaultSockPath) or a distinct CYC_DATA_DIR / CYC_ENGINE_SOCK. */
const SOCK_PATH = defaultSockPath(process.env);

/** Does a live listener answer on this unix socket? A successful connect means
 *  a process is bound (do not touch it); ECONNREFUSED (stale file) or ENOENT
 *  (already gone) means it is safe to unlink and rebind. */
async function socketAnswers(path: string): Promise<boolean> {
  try {
    const conn = await Bun.connect({ unix: path, socket: { data() {}, error() {} } });
    conn.end();
    return true;
  } catch {
    return false; // ECONNREFUSED (stale) or ENOENT (gone): not a live engine
  }
}

if (existsSync(SOCK_PATH)) {
  if (await socketAnswers(SOCK_PATH)) {
    LOG.line("socket.busy", { path: SOCK_PATH });
    console.error(
      `[cyc] another engine is already listening on ${SOCK_PATH}; refusing to start a second engine on the same datadir. ` +
        `Run the second instance under a distinct CYC_PORT_BASE (which moves this socket too), CYC_DATA_DIR, or CYC_ENGINE_SOCK.`,
    );
    process.exit(1);
  }
  try {
    unlinkSync(SOCK_PATH);
  } catch {
    // raced away between the probe and here: the bind below recreates it
  }
}
const socketServer = Bun.serve<SockData>({
  unix: SOCK_PATH,
  maxRequestBodySize: 320 * 1024 * 1024,
  fetch: (req, srv) => {
    markLocalSocket(req);
    return routeRequest(req, srv);
  },
  websocket: makeWsHandlers({ onSignalOffer }),
  /* idleTimeout mirrors the TCP serve so a slow upload can ride the socket.
   * Spread (not a literal key) because bun-types 1.2.0 omits idleTimeout from
   * the unix serve variant -- GenericServeOptions lacks it -- though the pinned
   * bun 1.4.0 honours it; the spread carries it past the stale type. */
  ...({ idleTimeout: 30 } as { idleTimeout: number }),
});
void socketServer; // held by Bun for the process lifetime; named for the log/intent above
try {
  chmodSync(SOCK_PATH, 0o600);
} catch (e) {
  LOG.line("socket.chmod.error", { error: String(e), path: SOCK_PATH });
}
LOG.line("socket.listen", { path: SOCK_PATH });

/* THE ROUTE TABLE'S ONE CONTEXT (hazard 4), built here where boot owns the
 * handles; the groups import everything else from the modules that own it. */
const routesCtx: RoutesCtx = {
  adapter,
  uploads,
  services,
  rev: REV,
  engineHost: ENGINE_HOST,
  engineUser: ENGINE_USER,
  engineHome: ENGINE_HOME,
  engineRepo: ENGINE_REPO,
  voiceUrlPublic: VOICE_PUBLIC_URL,
  claudeCommand: CLAUDE_COMMAND,
  binaryOnPath,
  sendMsgMax: SEND_MSG_MAX,
  notifyDebug: NOTIFY_DEBUG,
  routeRequest,
  voiceHealthy: () => voiceHealthy(),
  voiceGate: (cap) => voiceGate(cap),
  plugins: () => PLUGINS,
  pluginById: (id) => pluginById(id),
  log: (e, f) => LOG.line(e, f),
};

/* THE ONLY PLACE CORE TOUCHES THE OUT-OF-TREE piagent ADAPTER,
 * gated and dynamic. A vanilla engine never loads the module; behind the flag
 * it registers the run enricher (recognize + enrich pi-lanes) and the agent
 * stop handler (kill a pi-lane by its recorded task). Nothing static in core
 * imports piagent; this dynamic import is the whole seam. */
if (process.env.CYC_PIAGENT_ADAPTER === "1") {
  const pi = await import("../adapters/piagent.ts");
  registerRunEnricher({
    fromToolUse: (b, ts) => pi.piLaneFromToolUse(b, ts),
    enrichRuns: (runs) => pi.enrichPiRuns(runs),
  });
  routesCtx.agentStopHandler = async (runs, agentId) => {
    const run = pi.piRunByAgentId(runs, agentId);
    if (!run) return { ok: false, error: "unknown agent", status: 404 };
    const killed = await pi.killPiRunByTask(pi.piTaskText(run.command ?? ""));
    if (!killed) return { ok: false, error: "not running" };
    return { ok: true };
  };
}

const ROUTE_GROUPS: RouteGroup[] = [
  voiceRoutes, healthRoutes, mediaRoutes, chatRoutes, sessionOpsRoutes,
  pluginRoutes, transferRoutes,
];

/* Lane A resumable transfers: sweep chunk dirs older than 7 days, now and
 * daily. The chunk store is under the datadir and nothing else touches it. */
startTransferSweeper((e, f) => LOG.line(e, f));

/* BOOT REAP of orphaned terminal bridges, BEFORE initFrames wires the hub and a
 * viewer can open. A previous engine life that was SIGKILLed (or died before its
 * SIGTERM handler ran) left its `herdr terminal session control` children
 * running, each squatting a pane's single attach slot. The registry file names
 * them; reapOrphans reads /proc/<pid>/cmdline for each and kills ONLY the ones
 * that are still a matching herdr control process (pids get reused, so the
 * cmdline check is mandatory), then empties the file. Awaited so no bridge opens
 * against a slot that is about to be freed. Wrapped: a reap fault never fails
 * boot. */
try {
  const reaped = await reapOrphans({ log: (s) => console.log(s) });
  if (reaped > 0) LOG.line("terminal.reap", { reaped });
} catch (e) {
  LOG.line("terminal.reap.error", { error: String(e) });
}

initMcp({ resolveHandle: (id) => adapter.resolveHandle(id) });
initFrames({
  terminalCanResize: adapter.terminalCanResize,
  terminalPaneMode: (paneId) => adapter.terminalPaneMode(paneId),
  openTerminal: (paneId, cols, rows, h) => adapter.openTerminal(paneId, cols, rows, h),
  terminalViewer: () => adapter.capabilities().terminalViewer,
  log: (e, f) => LOG.line(e, f),
});
initRtcGlue({ e2e: E2E_STATE, engineUser: ENGINE_USER, engineHost: ENGINE_HOST,
  log: (e, f) => LOG.line(e, f) });
/* Call-mode voice: the sealed-DC control (fp binding, call start/stop/speak). The
 * media path (Opus/RTP) rides the reciprocated track; this only logs and, by
 * default, sources call-mode TTS from the configured voice engine. */
initVoiceCtl({ log: (e, f) => LOG.line(e, f) });
/* The sealed req/res tunnel. onReq (frames.ts dispatch) feeds this same
 * routeRequest verbatim; the sealed channel proves the device, so onReq marks
 * the request as owner-authenticated (httpx markSealedTunnel), no cap header
 * needed. */
initTunnel({
  routeRequest,
  server,
  log: (e, f) => LOG.line(e, f),
});

/* The foreign-steal guard: a witness-placed announce may never roll a pane's
 * LIVE binding to a third party's session id (the 2026-09-18 aiusage-grok
 * bug). Wired here, once the session-state maps and lineage it reads exist. */
setLiveBindGuard(liveBindGuard);

/* The reconcile subscribes right before the adapter starts, once every module's deps are wired: a mux
 * snapshot arriving mid-boot must not land on an uninitialised module
 * (ordering hazard 1). */
adapter.onAgents(makeReconcile({
  hasTranscript: (kind) => adapter.hasTranscript(kind),
  canParseScreen: (h) => adapter.canParseScreen(h),
  nativeDone: adapter.capabilities().nativeDone,
  sweepTails: () => adapter.sweepTails(),
  broadcastSessions: () => broadcastSessions(),
  log: (e, f) => LOG.line(e, f),
}));
adapter.start();

/* HARNESS WIRING SELF-CHECK: a harness config copied across machines (or a
 * moved engine dir) can still carry a dead absolute cyc path, which kills voice
 * self-identify + codex's outbound reply path SILENTLY. Read the present host
 * configs and warn per dead path so it is a visible boot diagnostic, not a
 * mystery. Reads only, never writes; wrapped so a check fault never fails boot. */
warnOnDeadHarnessPaths((line) => console.warn(line));

/* SELF-HEAL the ONE config the installer cannot migrate in place: codex's
 * config.toml is TOML (not round-trippable), so a stale [mcp_servers.callyourcode]
 * absolute path is left intact by `cyc install` and only WARNED above. Rewrite it
 * to the path-free `cyc mcp` launcher so codex's outbound reply path is never
 * silently dead after an engine move. Idempotent; writes only on change; wrapped
 * so a heal fault never fails boot. */
healCodexMcpPathAtBoot((line) => console.warn(line));

/* SELF-HEAL the harness-side artifacts the installer COPIES out of the repo
 * (opencode's plugin file, claude's + codex's skill dirs). A deploy that moves
 * the engine dir refreshes nothing physical, so an old copy drifts stale
 * silently -- a plugin copy predating the session-announce left opencode unbound
 * until it was refreshed by hand. Rewrite each copy that already exists on disk
 * from its repo source; REFRESH-ONLY, so an absent copy stays absent (the
 * installer owns creation, opencode's absent skill copy is deliberate). Writes
 * only on drift; wrapped per target so a heal fault never fails boot. */
healHarnessCopiesAtBoot((line) => console.warn(line));

/* Boot is over: every store buildAgentMeta reads exists now. Flush the meta
 * saves the boot sweeps parked (see scheduleAgentSave's gate). */
sessionStateReady(); // flip the meta-save gate and flush the parked saves (hazard 3)

/* BACKFILL THE OLD CONVERSATIONS' SESSION MARKERS, once, in the background
 * (chat/backfill.ts). A conversation opened before the ingest existed has a
 * chat log with messages but no `t:"s"` records, and nothing re-derives them
 * on open; its transcript is still on disk. The candidates are exactly the
 * restored chats that carried no records (restoredChats minus restoredLogs):
 * each one's transcript(s) are read forward and the records appended (to disk
 * via logSession, and to restoredLogs so the dead row serves them without a
 * restart). Idempotent -- the on-disk records are the guard, so a second boot
 * finds them present and skips. Fire-and-forget: boot does not wait on it.
 *
 * OFF BY DEFAULT: this rewrites live chat logs, so it only runs when the
 * operator opts in with CYC_BACKFILL_MARKERS="1". Unset (or anything else) and
 * the sweep never fires -- no disk reads, no log writes, boot is unchanged. */
if (process.env.CYC_BACKFILL_MARKERS === "1") {
  LOG.line("backfill.sweep.enabled", {});
  void runBackfillSweep({
    candidates: () => {
      const out: { id: string; meta: MetaLike; chat: Session["chat"] }[] = [];
      for (const [id, chat] of restoredChats) {
        if (restoredLogs.has(id)) continue; // already carries records: not an old convo
        const meta = agentMetas.get(id);
        if (!meta || !chat.length) continue;
        out.push({ id, meta, chat });
      }
      return out;
    },
    resolve: (meta) => resolveBackfillSources(meta, {
      pathFor: (cwd, sid) => adapter.transcriptPathFor(cwd, sid),
      findBySid: (sid) => findTranscriptBySessionId(sid),
      exists: (p) => { try { return Bun.file(p).size > 0; } catch { return false; } },
    }),
    streamLines: (p, onLine) => adapter.streamTranscriptLines(p, onLine),
    rememberLog: (id, log) => {
      restoredLogs.set(id, log);
      const row = sessions.get(id);
      if (row && row.log.length === 0) row.log.push(...log); // paint the open dead row now
      broadcastSessions();
    },
    log: (e, f) => LOG.line(e, f),
  }).catch((e) => LOG.line("backfill.sweep.error", { error: String(e) }));
}

console.log(`agent-engine  http://${server.hostname}:${server.port}`);
console.log(`  voice    ${VOICE_URLS.join(" -> ")}${VOICE_PUBLIC_URL ? ` (public ${VOICE_PUBLIC_URL})` : ""}`);
}
