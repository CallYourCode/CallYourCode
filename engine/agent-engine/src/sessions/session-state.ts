/* SESSION STATE (L2 domain): the Session model, the agent records, and THE
 * PARALLEL-MAPS CONSOLIDATION (blueprint 4d).
 *
 * Boot used to re-explode meta.json into ~8 session-keyed maps (names,
 * voices, photos, settings, heard, seen, notified, filed) plus a carry map;
 * rekey hand-moved each. Now ONE SessionState record per AGENT holds all of
 * it, and because the agent id is the key of everything (sessions, chats,
 * state, the meta) nothing is ever re-keyed: a harness rolling its session id
 * changes one attribute and one index entry. This is the in-memory half of
 * the design's meta.json model; meta.json stays the on-disk shape and
 * buildAgentMeta is the one writer-side translation.
 *
 * The metaSavesReady gate (blueprint hazard 3) lives here: saves requested
 * before boot finishes are parked, and the composition root flips the gate
 * with sessionStateReady() at boot end.
 *
 *   bun test agent-engine/src/sessions/session-state.test.ts
 */

import { writeAtomicPrivate } from "../../../shared/runfiles.ts";
import { settingsFile, stateFile, agentDocsDir, agentDocStateDir, agentPhotosDir, agentThumbsDir } from "../storage/datadir.ts";
import { ChatStore, newChatId } from "../chat/chatstore.ts";
import { loadAgentMetas, saveAgentMeta, mintAgentId, type AgentMeta } from "../runtime/agentmeta.ts";
import { isHarnessSessionId } from "../runtime/ids.ts";
import { parseOrder } from "../chat/order.ts";
import { attachmentsOf, type ChatMsg } from "../chat/chatmsg.ts";
import { ensureSeqs } from "../chat/chatlog.ts";
import { dropDeliveredReceiptRows } from "../chat/migrate-from-rows.ts";
import type { SessionRec } from "../chat/sessionrec.ts";
import type { AgentStatus } from "../terminal/herdr.ts";
import type { AgentLabel, AgentSessionRef } from "../runtime/agents.ts";
import type { Sock } from "../transport/sock.ts";

/* ------------------------------------------------------------- the Session */

export type Session = {
  /* THE STABLE AGENT ID, and the key of `sessions`: minted once, persisted in
   * the agent's meta, never re-keyed. NOT the pane id, NOT the harness session
   * uuid, NOT the coding agent's type id. `agentId` below is the same string,
   * kept as a named field because half the engine reads it by that name. */
  id: string;
  agentId: string;
  /* The live mux handle this session is on RIGHT NOW. Opaque to core;
   * NOT identity: a restart mints a new handle for the same conversation. */
  muxHandle: string;
  name: string;
  cwd: string;
  ws: Sock | null; // the speak-MCP socket (voice out); null when disconnected
  alive: boolean; // mux sessions: pane present; others: ws connected
  /* BUSY: the pane cannot take a message straight into context (`working` OR
   * `blocked`). NOT what goes on the wire as `thinking`. */
  busy: boolean;
  viaMux: boolean; // identity and liveness owned by the mux, not the ws
  agent: AgentLabel;
  hasTranscript: boolean;
  agentSession: AgentSessionRef | null;
  /* THE HARNESS SESSION ID this agent currently answers to (any harness), or
   * null while its pane has not said. An attribute, never the key: it rolls
   * on /clear, fork and resume while `id` stays. */
  harnessSessionId: string | null;
  status: AgentStatus; // five display keys; dead panes report "unknown"
  /* The jsonl tail's verdict on working/idle, when it has one (#490); never
   * carries blocked. Undefined until the transcript has said either, and
   * again after a rotation or a blocked snapshot (reconcile.ts).
   *
   * TYPED AS THE VALUES IT ACTUALLY HOLDS, not `AgentStatus`: tails.ts spells
   * its own view of a session with this narrow type, so a wide one here made
   * a Session unassignable to TailSession at the composition root. The idle
   * verdict is held since 2026-09-02 so a herdr poll cannot stamp its own
   * `working` over a turn the transcript has closed (turn-age.test.ts). */
  jsonlStatus?: "working" | "idle";
  workspace: string;
  tab: string | null;
  displayAgent: string | null;
  stateChangeSeq: number;
  turnSince: number;
  channels: string[];
  doneSeq: number;     // bumps each time this session finishes work
  seenDoneSeq: number; // the doneSeq that was current when the chat was opened
  /* THE READ MARKER, exactly one per session: a timestamp. */
  heardTs: number;
  /* THE NOTIFICATION FLAG: a SECOND fact, never the marker. */
  notified: boolean;
  /* The ceiling's clock: how long the engine has chosen to stay quiet. */
  silentSince?: number;
  /* HOW FAR HE HAS ACCOUNTED FOR THIS CHAT HIMSELF: a timestamp
   * that decays, never a flag. */
  filedTs: number;
  order: number;
  chat: ChatMsg[];
  /* THE SESSION RECORDS of the same log (chat/sessionrec.ts): what the
   * harness did, on the same seq axis as `chat`, replayed at boot and
   * appended by the ingest (chat/ingest.ts) and the engine's own edges. */
  log: SessionRec[];
  lastOrigin?: { id: string; ts: number };
  recentKeys?: Map<string, { msgId?: string; seq: number }>;
  recentSrc?: Set<string>;
  recentFacts?: Set<string>;
  inflightKeys?: Map<string, Promise<{ seq: number; msgId?: string }>>;
  /* The user-role twins (offline design v2, section 2b): the last 200 cids this
   * session took, lazily rebuilt from chat by deliver.ts recentCids, and the
   * cids acked but not yet committed. A rewrite of either is acked as a dup. */
  recentCids?: Map<string, { msgId?: string }>;
  inflightCids?: Set<string>;
};

/** Keyed by agentId (= Session.id). */
export const sessions = new Map<string, Session>();

export function sessionByHandle(handle: string): Session | undefined {
  /* ALIVE ONLY, on purpose. A mux handle names a live pane, and tmux reuses
   * handles across server generations: a fresh server's first pane is %0
   * again. A dead session kept for its history still remembers the handle it
   * died on, and answering with it late-resolved a fresh pane's replies into
   * an exited conversation (2026-08-23). The dead record stays reachable by
   * its own id; by handle, only the session whose pane is actually up. A
   * consumer holding a bare $TMUX_PANE goes through the adapter's
   * resolveHandle first, which is where the "%N" to "%N~pid~epoch" match lives. */
  for (const s of sessions.values()) if (s.muxHandle === handle && s.alive) return s;
  return undefined;
}

/** The live session for a harness session id, present or past. */
export function sessionBySessionId(sessionId: string): Session | undefined {
  const aid = sessionIndex.get(sessionId);
  return aid ? sessions.get(aid) : undefined;
}

/** THE ONE RESOLUTION LADDER for an id a consumer holds: the agent id, a
 *  harness session id (current or past, through the index), or a live mux
 *  handle. Every route that takes "some session id" resolves through here, so
 *  an MCP that registered under a session uuid and a cron that holds the
 *  agent id land on the same row. */
export function resolveSession(key: string): Session | undefined {
  return sessions.get(key) ?? sessionBySessionId(key) ?? sessionByHandle(key);
}

/* ------------------------------------------------- the ONE per-id record */

export type PhotoRec = { file: string; mime: string; ts: number };
export type SessionSettings = { muted?: boolean; notify?: boolean };
export type SeenRec = { doneSeq: number; seenDoneSeq: number };

/** Everything this engine keeps ABOUT an agent that is not the live Session
 *  object itself: what the user chose (display) and the persisted read state
 *  a not-yet-seen pane restores from. Keyed by agentId, like everything. */
export type SessionState = {
  display: { name?: string; voice?: string; photo?: PhotoRec; settings?: SessionSettings };
  read: { heardTs?: number; seen?: SeenRec; notified?: boolean; filedTs?: number };
};

const stateByAgent = new Map<string, SessionState>();

function stateOf(id: string): SessionState {
  let st = stateByAgent.get(id);
  if (!st) {
    st = { display: {}, read: {} };
    stateByAgent.set(id, st);
  }
  return st;
}
const peek = (id: string): SessionState | undefined => stateByAgent.get(id);

/** Whether ANY per-id state exists for this id (the state debug probe). */
export function hasSessionState(id: string): boolean {
  return stateByAgent.has(id);
}
export function sessionStateProbe(id: string): Record<string, boolean> {
  const st = peek(id);
  return {
    restoredHeardTs: st?.read.heardTs !== undefined,
    restoredSeen: st?.read.seen !== undefined,
    restoredNotified: st?.read.notified === true,
    restoredFiledTs: (st?.read.filedTs ?? 0) > 0,
    sessionSettings: !!st?.display.settings,
    nameOverrides: st?.display.name !== undefined,
    voiceOverrides: st?.display.voice !== undefined,
    sessionPhotos: st?.display.photo !== undefined,
  };
}

// ---- display: names -------------------------------------------------------

export function nameOverrideOf(id: string): string | undefined {
  return peek(id)?.display.name;
}
export function setNameOverride(id: string, name: string | null): void {
  const st = stateOf(id);
  if (name) st.display.name = name;
  else delete st.display.name;
  scheduleAgentSave(id);
}

// ---- display: voices ------------------------------------------------------

export function voiceOverrideOf(id: string): string | undefined {
  return peek(id)?.display.voice;
}
export function setVoiceOverride(id: string, voice: string): void {
  const st = stateOf(id);
  if (voice) st.display.voice = voice;
  else delete st.display.voice;
  scheduleAgentSave(id);
}

/* The host default voice is an ENGINE setting (settings.json, #584); the
 * per-session override is agent data, and the override wins. Empty string =
 * "use the voice engine's own default". */
let defaultVoice = "";
export function globalVoice(): string {
  return defaultVoice;
}
export function setDefaultVoice(v: string): void {
  defaultVoice = v;
  saveEngineSettings();
}
export function voiceFor(sessionId: string): string | undefined {
  return voiceOverrideOf(sessionId) || globalVoice() || undefined;
}

// ---- display: photos ------------------------------------------------------

export function photoRecOf(id: string): PhotoRec | undefined {
  return peek(id)?.display.photo;
}
export function setPhotoRec(id: string, rec: PhotoRec | null): void {
  const st = stateOf(id);
  if (rec) st.display.photo = rec;
  else delete st.display.photo;
  scheduleAgentSave(id);
}
/** The wire path for a session's photo: a PATH on this engine, null when none
 *  (null, not absent, so a removed photo can ARRIVE). */
export function photoOf(id: string): string | null {
  const rec = photoRecOf(id);
  return rec ? `/session-photo/${encodeURIComponent(id)}?v=${rec.ts}` : null;
}

// ---- display: settings (mute + the bell) ----------------------------------

export function settingsOf(sessionId: string): SessionSettings {
  return peek(sessionId)?.display.settings ?? {};
}

/** Merge a partial update; `null` CLEARS a key back to "follow the global".
 *  Every change is broadcast so the other devices move in the same breath. */
export function applySessionSettings(
  sessionId: string,
  patch: Partial<Record<keyof SessionSettings, boolean | null>>,
): void {
  const cur: SessionSettings = { ...settingsOf(sessionId) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete cur[k as keyof SessionSettings];
    else (cur as Record<string, unknown>)[k] = v;
  }
  const st = stateOf(sessionId);
  if (Object.keys(cur).length) st.display.settings = cur;
  else delete st.display.settings;
  scheduleAgentSave(sessionId);
  deps?.broadcastSessions();
}

// ---- restored read state --------------------------------------------------

export function restoredHeardOf(id: string): number | undefined {
  return peek(id)?.read.heardTs;
}
export function restoredSeenOf(id: string): SeenRec | undefined {
  return peek(id)?.read.seen;
}
export function restoredNotifiedOf(id: string): boolean | undefined {
  return peek(id)?.read.notified;
}
export function restoredFiledOf(id: string): number | undefined {
  return peek(id)?.read.filedTs;
}

/* This session's marker, and it is scheduled to disk before this returns: a
 * session whose marker is still at its first-sight value has never been read,
 * and the next boot must not take the first-sight branch again and mark its
 * waiting backlog read. Deciding and remembering are the same step. */
export function heardTsFor(prev: Pick<Session, "heardTs"> | undefined, id: string): number {
  const known = prev?.heardTs ?? restoredHeardOf(id);
  if (known !== undefined) return known;
  const ts = restoredChats.get(id)?.at(-1)?.ts ?? 0;
  stateOf(id).read.heardTs = ts; // so the writer sees it even before a read
  scheduleAgentSave(id);
  return ts;
}

/* --------------------------------------------- the agent records + chats */

export const chatStore = new ChatStore((e, p) => console.error(`[chat] append failed (${p}):`, e));

/* agentMetas is by agentId: every NON-merged record this engine holds. */
export const agentMetas = new Map<string, AgentMeta>();

/* THE SESSION INDEX: harness session id -> agentId, rebuilt at boot from every
 * meta (current id, past ids, content-proved lineage) and extended live by
 * indexSession. Memory only, never a file of its own: the metas are the
 * record, this is their inverse. A `mergedInto` chain resolves to the
 * survivor, so an id that once named a merged record finds the conversation
 * that absorbed it. */
export const sessionIndex = new Map<string, string>();

/** The survivor of a meta's `mergedInto` chain, or null when the chain leads
 *  to a record that does not exist (bounded; a cycle is a broken chain). */
export function survivorOf(meta: AgentMeta, all: Map<string, AgentMeta>): AgentMeta | null {
  let cur: AgentMeta | undefined = meta;
  const seen = new Set<string>();
  while (cur?.mergedInto) {
    if (seen.has(cur.agentId)) return null;
    seen.add(cur.agentId);
    cur = all.get(cur.mergedInto);
  }
  return cur ?? null;
}

/** Build the index from every meta (merged ones included, for their chains).
 *  Pure, so the test can hand it shapes. Current ids are placed first, then
 *  past ids, then lineage, and an id already placed is never overwritten: if
 *  two records disagree about an id, the one it is CURRENT for wins. Only a
 *  harness-shaped id (ids.ts) is placed: a pane id in a meta (the v1 leak)
 *  must never make a pane resolve to an old agent through the index. */
export function buildSessionIndex(all: Map<string, AgentMeta>): Map<string, string> {
  const out = new Map<string, string>();
  const place = (id: string | null | undefined, aid: string) => {
    if (isHarnessSessionId(id) && !out.has(id)) out.set(id, aid);
  };
  const rows: [AgentMeta, AgentMeta][] = [];
  for (const meta of all.values()) {
    const sv = survivorOf(meta, all);
    if (sv) rows.push([meta, sv]);
  }
  for (const [meta, sv] of rows) place(meta.sessionId, sv.agentId);
  for (const [meta, sv] of rows) for (const id of meta.pastSessions ?? []) place(id, sv.agentId);
  for (const [meta, sv] of rows) for (const id of meta.lineage ?? []) place(id, sv.agentId);
  return out;
}

/** Point a harness session id at an agent, live. The one live writer of the
 *  index; adoptSession (carry.ts) is the caller that also records it in the
 *  meta. Idempotent. */
export function indexSession(sessionId: string, agentId: string): void {
  sessionIndex.set(sessionId, agentId);
}

/* THE BLOB INDEX: uploadId / msgId / docId -> the agent whose directory holds
 * the bytes. A LOCATION index: a rekey merge retires an agent record but
 * leaves its files where they are, and this map keeps serving them. */
export const blobOwner = new Map<string, string>();

/** Chat logs replayed at boot, keyed by agentId, handed to the live Session
 *  the first time its agent is seen (reconcile) and deleted here then. */
export const restoredChats = new Map<string, ChatMsg[]>();
/** The session records replayed at boot, keyed by agentId, alongside
 *  restoredChats; handed to the live Session by reconcile the same way. */
export const restoredLogs = new Map<string, SessionRec[]>();

export type SessionStateDeps = {
  /** the minted-uploads set (uploads.ts), stamped by the blob index rebuild */
  noteMinted(uploadId: string): void;
  broadcastSessions(): void;
  /** the meta save's lineage read (lineage.ts is L3; injected to stay inward) */
  lineageOf(agentId: string): string[] | undefined;
};

let deps: SessionStateDeps | null = null;

export function indexMsgBlobs(agentId: string, m: ChatMsg): void {
  if (m.msgId) blobOwner.set(m.msgId, agentId);
  if (m.file?.docId) blobOwner.set(m.file.docId, agentId);
  /* an adopted upload is still one this engine minted: the minted set is what
   * turns "file gone" into an honest refusal rather than a silent forge-drop */
  for (const u of attachmentsOf(m)) {
    if (u.uploadId) { blobOwner.set(u.uploadId, agentId); deps?.noteMinted(u.uploadId); }
  }
  if (m.upload?.uploadId) { blobOwner.set(m.upload.uploadId, agentId); deps?.noteMinted(m.upload.uploadId); }
}

/* -------------------------------------------------- engine-level settings */

/* RESOLVED PER SAVE, NOT CAPTURED AT IMPORT. This was `const SETTINGS_FILE =
 * settingsFile()`, evaluated while the module graph was still being built, so
 * the data dir became unswappable the moment anything imported this file --
 * and a seam test that wires the engine in-process has to point CYC_DATA_DIR
 * at its own tmp tree AFTER the imports have run. Resolved at the top of the
 * save (before the write chain, so the file a save was requested against is
 * the file it lands in), which for a running engine is the same string every
 * time. */
let engineSettingsOnDisk: Record<string, unknown> = {};
let settingsWriteChain: Promise<void> = Promise.resolve();

function saveEngineSettings(): void {
  /* the spread keeps any field a newer build wrote that this one does not know */
  const out = { ...engineSettingsOnDisk, v: 1, defaultVoice, order: manualOrder };
  const SETTINGS_FILE = settingsFile();
  settingsWriteChain = settingsWriteChain.then(async () => {
    try {
      await writeAtomicPrivate(SETTINGS_FILE, JSON.stringify(out, null, 2) + "\n");
    } catch (e) {
      console.error("[settings.json] could not persist:", e);
    }
  });
}

/* The order you dragged the chats into (order.ts): a fact about the host. */
let manualOrder: string[] = [];
export function getManualOrder(): string[] {
  return manualOrder;
}
export function setManualOrder(order: string[]): void {
  manualOrder = order;
  saveEngineSettings();
}
/* ------------------------------------------------------------- boot load */

/** Load the agent metas, replay the chat logs, and re-fold every meta field
 *  into the ONE record. Called once by the composition root, before anything
 *  reads a session. */
export async function loadSessionState(d: SessionStateDeps): Promise<void> {
  deps = d;

  // engine-level settings.json (manual order + host default voice)
  try {
    const f = Bun.file(settingsFile()); // resolved per call: see saveEngineSettings
    if (await f.exists()) {
      const j = (await f.json()) as Record<string, unknown>;
      if (j && typeof j === "object") engineSettingsOnDisk = j;
    }
  } catch (e) {
    console.error("[settings.json] could not read:", e);
  }
  defaultVoice = typeof engineSettingsOnDisk.defaultVoice === "string"
    ? engineSettingsOnDisk.defaultVoice : "";
  try {
    manualOrder = parseOrder(engineSettingsOnDisk.order);
    if (manualOrder.length) console.log(`[order] restored ${manualOrder.length} placed session(s)`);
  } catch (e) {
    console.error("[order] could not read:", e);
  }

  const all = await loadAgentMetas(
    (id, why) => console.error(`[agents] skipped ${id}: ${why}`),
    (id, changes) => console.log(`[agents] migrated ${id} to meta v2: ${changes.join("; ")}`),
  );
  for (const [id, aid] of buildSessionIndex(all)) sessionIndex.set(id, aid);
  for (const meta of all.values()) {
    if (meta.mergedInto) continue; // its conversation lives on in the survivor's record
    agentMetas.set(meta.agentId, meta);
    const id = meta.agentId;
    if (meta.chat) {
      const loaded = await chatStore.loadLog(id, meta.chat);
      /* One-shot cleanup of the reverted agent-message-rows feature's
       * role:user+from receipt rows (migrate-from-rows.ts): a clean log
       * comes back as-is; a dirty one is rewritten to a new chat file
       * (append-only discipline, old file kept) and served filtered. */
      const msgs = await dropDeliveredReceiptRows(
        chatStore, meta, loaded.msgs, loaded.recs) as ChatMsg[];
      for (const m of msgs) indexMsgBlobs(id, m);
      if (loaded.torn) console.log(`[agents] ${id}: chat ${meta.chat} had a torn last line (skipped)`);
      if (msgs.length) { ensureSeqs(msgs, loaded.recs); restoredChats.set(id, msgs); }
      if (loaded.recs.length) restoredLogs.set(id, loaded.recs);
    }
    // fold every persisted per-agent fact into the one record
    if (meta.name) stateOf(id).display.name = meta.name;
    if (meta.voice) stateOf(id).display.voice = meta.voice;
    const p = meta.photo;
    if (p && typeof p.file === "string" && p.file && typeof p.mime === "string") {
      stateOf(id).display.photo = { file: p.file, mime: p.mime, ts: Number(p.ts) || 0 };
    }
    const o = meta.settings;
    if (o && typeof o === "object") {
      const st: SessionSettings = {};
      if (typeof o.muted === "boolean") st.muted = o.muted;
      if (typeof o.notify === "boolean") st.notify = o.notify;
      if (Object.keys(st).length) stateOf(id).display.settings = st;
    }
    const r = meta.read;
    if (r && typeof r === "object") {
      const read = stateOf(id).read;
      if (Number.isFinite(r.heardTs)) read.heardTs = Number(r.heardTs);
      if (r.notified === true) read.notified = true;
      if (Number.isFinite(r.filedTs) && Number(r.filedTs) > 0) read.filedTs = Number(r.filedTs);
      if (Number.isFinite(r.doneSeq) || Number.isFinite(r.seenDoneSeq)) {
        read.seen = { doneSeq: Number(r.doneSeq) || 0, seenDoneSeq: Number(r.seenDoneSeq) || 0 };
      }
    }
  }
  console.log(`[agents] restored ${agentMetas.size} agent(s), chat logs for ${restoredChats.size}, ` +
    `${sessionIndex.size} session id(s) indexed`);

  // pane bindings v2: which agent each handle last hosted (continuity of an
  // unannounced pane across an engine restart within one mux epoch)
  const fillBindings = (text: string): number => {
    const saved = JSON.parse(text) as Record<string, Partial<PaneBinding>>;
    let n = 0;
    for (const [pane, b] of Object.entries(saved)) {
      // a v1 entry ({uuid, alive, ts}) names no agent and is dropped: the
      // index answers for the uuid it held, which is all it was ever for
      if (b && typeof b.agentId === "string" && b.agentId) {
        paneBindings.set(pane, { agentId: b.agentId,
          sessionId: typeof b.sessionId === "string" && b.sessionId ? b.sessionId : null,
          cwd: typeof b.cwd === "string" ? b.cwd : "", alive: b.alive === true, ts: Number(b.ts) || 0 });
        n++;
      }
    }
    return n;
  };
  const bakFile = paneBindingsFile() + ".bak";
  try {
    const f = Bun.file(paneBindingsFile());
    if (await f.exists()) {
      const text = await f.text();
      fillBindings(text);
      /* This snapshot parsed clean: refresh the backup with it, so a future
       * unreadable main file falls back to the last good boot instead of
       * re-keying every idle pane. */
      await writeAtomicPrivate(bakFile, text).catch(() => {});
    }
    // no file is a quiet first boot; anything else must be LOUD (below)
  } catch (e) {
    /* A file that exists but does not parse is lost identity, not a shrug:
     * every idle unannounced pane would re-key as a blank twin this boot.
     * Salvage the last known-good snapshot, and say so at the top of the
     * journal either way. */
    console.error("[bindings] pane-bindings.json unreadable:", e);
    try {
      const g = Bun.file(bakFile);
      if (await g.exists()) {
        const n = fillBindings(await g.text());
        console.error(`[bindings] restored ${n} binding(s) from the last good boot's backup`);
      } else {
        console.error("[bindings] no backup; idle unannounced panes will re-key");
      }
    } catch (e2) {
      console.error("[bindings] backup also unreadable; idle unannounced panes will re-key:", e2);
    }
  }
}

/* --------------------------------------------------------- the meta save */

/* A SHORT debounce (a burst of changes is one write). GATED ON BOOT: saves
 * requested before the module graph finishes evaluating are parked and the
 * root flushes them via sessionStateReady() (blueprint hazard 3). */
const META_SAVE_DEBOUNCE_MS = 150;
const metaSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let metaSavesReady = false;
const pendingMetaSaves = new Set<string>();
/* Every meta write in flight, so a caller that must know the disk is quiet
 * (a test about to throw the data dir away) can wait for all of them. */
const inflightMetaSaves = new Set<Promise<void>>();

function writeMeta(aid: string, meta: AgentMeta): Promise<void> {
  const p = saveAgentMeta(meta)
    .catch((e: unknown) => console.error(`[agents] could not persist ${aid}:`, e))
    .finally(() => inflightMetaSaves.delete(p));
  inflightMetaSaves.add(p);
  return p;
}

/** Resolves once every meta write started so far has landed (or failed). */
export async function settleAgentSaves(): Promise<void> {
  while (inflightMetaSaves.size) await Promise.all([...inflightMetaSaves]);
}

/* A PROVISIONAL AGENT IS NOT WRITTEN. A pane the engine saw but that never
 * announced gets an in-memory agent so its row can exist; until that agent
 * has a harness session id or a chat of its own there is nothing on disk
 * worth a directory, and writing one per unannounced pane is exactly the
 * blind-mint loop that littered agents/ with nameless records (TODOS.md). */
function persistable(meta: AgentMeta): boolean {
  return meta.sessionId !== null || !!meta.chat;
}

export function scheduleAgentSave(agentId: string): void {
  if (!metaSavesReady) { pendingMetaSaves.add(agentId); return; }
  const aid = agentIdFor(agentId);
  if (metaSaveTimers.has(aid)) return;
  metaSaveTimers.set(aid, setTimeout(() => {
    metaSaveTimers.delete(aid);
    const meta = agentMetas.get(aid);
    if (!meta) return;
    buildAgentMeta(meta);
    if (!persistable(meta)) return;
    void writeMeta(aid, meta);
  }, META_SAVE_DEBOUNCE_MS));
}

/** Persist an agent's meta NOW (the adopt path: a restart right after a
 *  session id arrives must find it in the index). Resolves when the write
 *  has landed; a caller that does not care may drop the promise. */
export function flushAgentSave(agentId: string): Promise<void> {
  if (!metaSavesReady) { pendingMetaSaves.add(agentId); return Promise.resolve(); }
  const aid = agentIdFor(agentId);
  const t = metaSaveTimers.get(aid);
  if (t) { clearTimeout(t); metaSaveTimers.delete(aid); }
  const meta = agentMetas.get(aid);
  if (!meta) return Promise.resolve();
  buildAgentMeta(meta);
  if (!persistable(meta)) return Promise.resolve();
  return writeMeta(aid, meta);
}

/** Flip the boot gate and flush every parked save. The composition root calls
 *  this once, at the end of boot. */
export function sessionStateReady(): void {
  metaSavesReady = true;
  for (const aid of pendingMetaSaves) scheduleAgentSave(aid);
  pendingMetaSaves.clear();
}

/** Read-state persistence rides the agent's meta.json now. */
export function scheduleHeardSave(agentId: string): void {
  scheduleAgentSave(agentId);
}

/** Gather one agent's live values into its meta record, in place: THE one
 *  writer-side translation (the design). `sessionId`/`pastSessions` are NOT
 *  gathered here: adoptSession (carry.ts) is their only writer. `harness` and
 *  `cwd` are anchored once, from the first live sighting. */
export function buildAgentMeta(meta: AgentMeta): void {
  const id = meta.agentId;
  const put = <K extends keyof AgentMeta>(k: K, v: AgentMeta[K] | undefined) => {
    if (v === undefined) delete meta[k];
    else meta[k] = v;
  };
  const st = peek(id);
  put("name", st?.display.name);
  put("voice", st?.display.voice);
  put("photo", st?.display.photo);
  const so = st?.display.settings;
  put("settings", so && Object.keys(so).length ? so : undefined);
  const s = sessions.get(id);
  if (s) {
    if (!meta.harness && s.agent.id) meta.harness = s.agent.id;
    if (!meta.cwd && s.cwd) meta.cwd = s.cwd;
    put("read", { heardTs: s.heardTs, doneSeq: s.doneSeq, seenDoneSeq: s.seenDoneSeq,
      ...(s.notified ? { notified: true } : {}),
      ...(s.filedTs ? { filedTs: s.filedTs } : {}) });
  } else {
    const read = st?.read;
    if (read && (read.heardTs !== undefined || read.seen || read.notified || read.filedTs)) {
      put("read", { heardTs: read.heardTs ?? 0, doneSeq: read.seen?.doneSeq ?? 0,
        seenDoneSeq: read.seen?.seenDoneSeq ?? 0,
        ...(read.notified ? { notified: true } : {}),
        ...(read.filedTs ? { filedTs: read.filedTs } : {}) });
    } else {
      put("read", undefined);
    }
  }
  const lin = deps?.lineageOf(id);
  put("lineage", lin && lin.length ? lin : undefined);
}

/** The agent's meta record, minted (in memory, sessionId null) on first need. */
export function metaFor(agentId: string): AgentMeta {
  const aid = agentIdFor(agentId);
  let meta = agentMetas.get(aid);
  if (!meta) {
    meta = { v: 2, agentId: aid, sessionId: null };
    agentMetas.set(aid, meta);
  }
  return meta;
}

/** The (agentId, chatId) an agent's chat lines append to; mints the chat
 *  file id on the first line. */
export function chatRefFor(agentId: string): { aid: string; chatId: string } {
  const meta = metaFor(agentId);
  if (!meta.chat) {
    meta.chat = newChatId();
    meta.chats = [...(meta.chats ?? []), { id: meta.chat, createdAt: Date.now() }];
    scheduleAgentSave(agentId);
  }
  return { aid: meta.agentId, chatId: meta.chat };
}

/** One appended patch line: edit the message whose ts is `mts`. */
export function persistPatch(agentId: string, mts: number,
  set?: Record<string, unknown>, del?: string[]): void {
  const { aid, chatId } = chatRefFor(agentId);
  chatStore.appendPatch(aid, chatId, { mts, set, del });
}

/* A stable agent id no live session or persisted meta already holds: the mint
 * re-rolls on a collision. The ONLY minter; reconcile calls it for a pane
 * whose announced id is in no record, and /new-session calls it to inject the
 * id into the child's env before the pane exists. */
export function freshAgentId(): string {
  let fresh = mintAgentId();
  while (agentMetas.has(fresh) || sessions.has(fresh)) fresh = mintAgentId();
  return fresh;
}

/* THE AGENT ID FOR A KEY A CALLER HOLDS: the agent id itself (the common case
 * now that every row is keyed by it), or a harness session id through the
 * index. Never mints: an unknown key is answered as itself, so a module that
 * writes files for an agent it has not met yet (uploads, photos) writes them
 * under the id reconcile will key the row by. */
export function agentIdFor(key: string): string {
  if (agentMetas.has(key) || sessions.has(key)) return key;
  return sessionIndex.get(key) ?? key;
}

/* BIND A PRE-MINTED AGENT ID TO A PANE (cyc-cli plan section 3): the
 * /new-session path mints the id (freshAgentId), injects it into the child's
 * env, then adopts it onto the returned mux handle here. The pane binding is
 * how reconcile learns it (rule 2: a bound handle whose announce is not yet
 * in, or whose fresh id is in no record, resolves to the bound agent); the
 * tmux adapter also reads CYC_AGENT_ID straight off the pane. A no-op when
 * the handle already hosts an agent. */
export function adoptAgentId(handle: string, agentId: string): void {
  const b = paneBindings.get(handle);
  if (b && b.alive) return;
  if (!agentMetas.has(agentId)) agentMetas.set(agentId, { v: 2, agentId, sessionId: null });
  recordBinding(handle, { agentId, sessionId: null, cwd: "" });
}

/* ---------------------------------------------------------- pane bindings */

/* WHICH AGENT EACH HANDLE LAST HOSTED, and whether the pane was still up when
 * we last saw it. Two uses and no third: (a) an unannounced pane after an
 * engine restart within one mux epoch keeps its agent (the handle is the
 * same, so the binding says who was there); (b) the same-pane rollover rule,
 * where a fresh id announced from a handle bound to agent A joins A. It never
 * keys the chat and never decides identity when an announce is in the index. */
/* Resolved per call, for the same reason settingsFile() above is: a `const`
 * evaluated at import froze the data dir before a test could choose one. */
const paneBindingsFile = (): string => stateFile("pane-bindings.json");
export type PaneBinding = { agentId: string; sessionId: string | null; cwd: string; alive: boolean; ts: number };
export const paneBindings = new Map<string, PaneBinding>();

/* ATOMIC AND SERIALIZED. This file is the only identity an idle, unannounced
 * pane keeps across an engine restart: a truncated write (SIGTERM mid-flight,
 * or two fire-and-forget writes interleaving) parses as nothing at the next
 * boot, and every such pane re-keys as a blank provisional twin (2026-09-06,
 * five agents lost their rows to exactly this shape). tmp+rename can tear
 * nothing; the busy/again pair coalesces a burst into a trailing write. */
let bindingsSaveBusy = false;
let bindingsSaveAgain = false;
export function savePaneBindings(): void {
  if (bindingsSaveBusy) { bindingsSaveAgain = true; return; }
  bindingsSaveBusy = true;
  void (async () => {
    do {
      bindingsSaveAgain = false;
      await writeAtomicPrivate(
        paneBindingsFile(), JSON.stringify(Object.fromEntries(paneBindings)),
      ).catch(() => {}); // best effort: the next change retries
    } while (bindingsSaveAgain);
    bindingsSaveBusy = false;
  })();
}
export function bindingOf(handle: string): PaneBinding | undefined {
  return paneBindings.get(handle);
}
export function recordBinding(handle: string, b: { agentId: string; sessionId: string | null; cwd: string }): void {
  const cur = paneBindings.get(handle);
  if (cur && cur.alive && cur.agentId === b.agentId && cur.sessionId === b.sessionId && cur.cwd === b.cwd) return;
  paneBindings.set(handle, { ...b, alive: true, ts: Date.now() });
  savePaneBindings();
}
export function markBindingDead(handle: string): void {
  const b = paneBindings.get(handle);
  if (b && b.alive) { b.alive = false; b.ts = Date.now(); savePaneBindings(); }
}

/** Folders any agent has run in, newest first, for the plus menu's Recent
 *  group (the one consumer: routes/session-ops.ts). Deduped by cwd keeping the
 *  newest ts, minus the `exclude` set (the folders already offered as live), so
 *  a folder never shows in both groups. Capped at `cap`.
 *
 *  BOUNDEDNESS: paneBindings is uncapped and unpruned on disk, but the cap here
 *  makes the derivation cheap and the response small; ts is already recorded on
 *  every entry, so capping at derivation (not in the store) needs no extra
 *  state. Both alive and dead bindings feed the map; the exclude set is what
 *  keeps the currently-live ones out of Recent. */
export function recentCwds(exclude: ReadonlySet<string>, cap = 8): string[] {
  const newest = new Map<string, number>();       // cwd -> max ts
  for (const b of paneBindings.values()) {
    if (!b.cwd) continue;                          // adoptAgentId stubs record cwd ""
    const t = newest.get(b.cwd);
    if (t === undefined || b.ts > t) newest.set(b.cwd, b.ts);
  }
  return [...newest.entries()]
    .filter(([cwd]) => !exclude.has(cwd))
    .sort((a, b) => b[1] - a[1])                   // newest first
    .slice(0, cap)
    .map(([cwd]) => cwd);
}

/** True when `cwd` is a folder the engine's own pane-binding history records
 *  (the one consumer: the /new-session cwd gate in routes/session-ops.ts, which
 *  widens the allow-list by this bounded, server-derived set). Exact string
 *  equality against b.cwd, never normalization or prefix matching, so an
 *  arbitrary client path that is not byte-identical to a recorded one is
 *  refused. Empty cwd is refused independently (the "" stub adoptAgentId
 *  records is never a real directory). */
export function isRecentCwd(cwd: string): boolean {
  if (!cwd) return false;
  for (const b of paneBindings.values()) if (b.cwd === cwd) return true;
  return false;
}

/* ---------------------------- doc + photo directory resolution ---------- */

/* SHOWN DOCUMENTS LIVE WITH THEIR AGENT (the design): `show` always knows its
 * session, so the bytes land in agents/<agentId>/docs/ and the docId -> agent
 * index (blobOwner, rebuilt from the chat logs at boot) resolves every id-only
 * read route. The trailing slash matches how docstate.ts concatenates. */
export const docDirFor = (agentId: string): string => agentDocsDir(agentId) + "/";
export const docStateDirFor = (agentId: string): string => agentDocStateDir(agentId) + "/";
/** The dirs a docId's files live in, or null when no chat message ever carried
 *  it -- which is the same "not found" a missing file already was. */
export function docDirsOf(docId: string): { docDir: string; stateDir: string } | null {
  const aid = blobOwner.get(docId);
  return aid ? { docDir: docDirFor(aid), stateDir: docStateDirFor(aid) } : null;
}
/* WHAT A SHOWN PAGE SAVED, and it is deliberately NOT inside DOC_DIR.
 *
 * The documents in there are the immutable bytes an agent pushed; every one of
 * them can be produced again by showing the file again, and the app treats its
 * own copy of them as a cache it may evict. This is the opposite kind of thing:
 * it is what HE did to the page -- the order he dragged things into, the notes
 * he typed -- and there is nowhere to fetch it from if it goes. Two directories
 * so that anything which ever sweeps shown documents cannot take his work with
 * it by accident. agent-engine/src/storage/docstate.ts is the whole policy; the dirs are
 * the per-agent pair docDirsOf() resolves above. */

/* THE PICTURE YOU CHOSE FOR A SESSION, and it is deliberately NOT in
 * the uploads store (task 331).
 *
 * "the photo then lives with the agent engine and it serves that as a profile
 * photo": the point of putting it here rather than on a device is that the
 * session's face is a fact about the session, so it is the same on his phone,
 * his tablet and his laptop, and a different engine can answer with its own.
 *
 * ITS OWN DIRECTORY, for the reason docstate has its own: trimUploads()
 * sweeps staging/uploads down to 200 files and spares only what a chat message
 * points at. A profile photo is pointed at by no message, so it is exactly the
 * "unreferenced debris" that sweep is built to delete -- it would survive until
 * two hundred newer attachments existed and then vanish, which is the worst
 * possible failure because it is late and silent. Nothing sweeps this. There is
 * at most one file per pane and he picked every one of them.
 *
 * ONE FILE PER AGENT, its record in that agent's meta.json, so setting a new
 * photo replaces the old one rather than accumulating. The extension carries
 * the type, so serving it needs no side-car metadata. The bytes live in
 * agents/<agentId>/photos/, with derived thumbs beside them (the ?w= branch of
 * GET /session-photo), keyed by source filename so a replaced photo (fresh
 * uuid) never meets a stale thumb. */
export const photoDirFor = (agentId: string): string => agentPhotosDir(agentIdFor(agentId));
export const thumbDirFor = (agentId: string): string => agentThumbsDir(agentIdFor(agentId));

/* ------------------------------------------------------------- purge (4d) */

/** The 4d payoff, purge half: one delete (plus this module's other keys). The
 *  pane-keyed companions other modules own (asks, the delivery queue, the
 *  unsubmitted memory) are purged by their owners; reconcile composes. */
export function purgeSessionState(agentId: string, handle?: string): void {
  stateByAgent.delete(agentId);
  restoredChats.delete(agentId);
  restoredLogs.delete(agentId);
  if (handle) paneBindings.delete(handle);
}

/* ------------------------------------------------------------- test reset */

/** TEST ONLY: cancel the debounced meta saves and empty every map this module
 *  owns, so a second in-process wiring starts from the state a fresh process
 *  would have. Nothing in production calls it (an engine's session state dies
 *  with the process), so it is a no-op there.
 *
 *  The meta-save timers are the part that matters: they are real setTimeouts
 *  armed by reconcile, and one left running fires 150ms later against a data
 *  dir the test has already thrown away. */
export function resetForTest(): void {
  for (const t of metaSaveTimers.values()) clearTimeout(t);
  metaSaveTimers.clear();
  pendingMetaSaves.clear();
  metaSavesReady = false; // back behind the boot gate, exactly as a fresh process is
  sessions.clear();
  stateByAgent.clear();
  agentMetas.clear();
  sessionIndex.clear();
  blobOwner.clear();
  restoredChats.clear();
  restoredLogs.clear();
  paneBindings.clear();
  engineSettingsOnDisk = {};
  settingsWriteChain = Promise.resolve();
  defaultVoice = "";
  manualOrder = [];
  deps = null;
}
