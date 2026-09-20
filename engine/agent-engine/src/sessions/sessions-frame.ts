/* THE SESSIONS FRAME (L3 feature): the one projection of the session list,
 * the tabs declaration built from the SAME order in the SAME frame, the
 * deduped broadcast, and the hello burst.
 *
 * This module reads nearly everything, so everything boot-owned arrives
 * INJECTED (initSessionsFrame): ENGINE_CAN, the live plugin decls, the voice
 * health probe, the tab grouping and the host identity. That kills the four
 * forward references the old module-level sendHelloBurst leaned on (ordering
 * hazard 2).
 *
 *   bun test agent-engine/src/sessions-frame.test.ts
 */

import { titleOf } from "./title.ts";
import { sortSessions } from "../chat/order.ts";
import { declareTabs, tabKeyOf, type Grouping } from "./tabs.ts";
import { unreadOf, readThroughOf } from "./readstate.ts";
import { isControlAnswer } from "../chat/chatmsg.ts";
import { askOf } from "../chat/asks.ts";
import { contextPctOf, modelOf, claudeTitleOf } from "./context-cache.ts";
import { sessions, getManualOrder, nameOverrideOf, settingsOf, photoOf,
  type Session } from "./session-state.ts";
import { clients, send } from "../transport/wire.ts";
import type { Sock } from "../transport/sock.ts";
import type { PluginDecl } from "../plugins/platform/spec.ts";

/* PER-CAPABILITY VOICE READINESS, carried on the same {t:"voice"} frame as the
 * unit health. `healthy` is the all-or-none unit (mic + call mode); `ready` is
 * each capability on its own, because on a fresh install the models download
 * in the background and kokoro's ~330 MB lands long before whisper's ~1.6 GB:
 * tts can serve while stt still warms up. `download`, when present, names the
 * capability whose model is downloading right now with a percent hint (or null
 * when the source declared no length). */
export type VoiceReady = {
  /** transcription: the whisper batch model is on disk and its service is up */
  stt: boolean;
  /** speech: the kokoro model is on disk and its service is up */
  tts: boolean;
  download?: { stt?: number | null; tts?: number | null };
};

/** The one spelling of the voice frame, used by the hello burst here and the
 *  server's diff-gated rebroadcast, so the two can never drift. */
export function voiceFrame(url: string, healthy: boolean, ready: VoiceReady) {
  return { t: "voice", url, healthy, ready: { stt: ready.stt, tts: ready.tts },
    ...(ready.download && Object.keys(ready.download).length ? { download: ready.download } : {}) };
}

export type SessionsFrameDeps = {
  engineCan: readonly string[];
  /** LIVE decls: re-read on every burst so a redeclare needs no re-init */
  pluginDecls(): readonly PluginDecl[];
  voiceHealthy(): boolean;
  /** Per-capability readiness for the voice frame. OPTIONAL: a wiring without
   *  it (older tests, a modifier) falls back to the unit health for both
   *  capabilities, which is what a whole-or-nothing view already meant. */
  voiceReady?(): VoiceReady;
  voicePublicUrl: string;
  engineUser: string;
  engineHost: string;
  tabs: Grouping;
  /** the one seam the reply-dials shim still rides on this frame */
  replyLevel(): number;
  /** Whether this agent kind's reader declares an activity-event source
   *  (the adapter's hasSessionEvents, off the READERS table). The wire's
   *  overlay-capable session id is derived from it, so core never names a
   *  harness. */
  hasSessionEvents(kind: string): boolean;
};

let cfg: SessionsFrameDeps | null = null;
export function initSessionsFrame(d: SessionsFrameDeps): void {
  cfg = d;
}
const C = (): SessionsFrameDeps => {
  if (!cfg) throw new Error("sessions-frame not initialised");
  return cfg;
};

/* The order you dragged the list into wins over herdr's; a pane you have never
 * placed keeps herdr's position and lands after the placed ones (order.ts). The
 * app is not told which of the two decided a row's place: it gets `order` as the
 * position in THIS list, so a client that sorts by the field and a client that
 * trusts the array agree.
 *
 * Its own function because the tabs declaration is built from the SAME order
 * (sessionsFrame below): the strip has to read left to right in the order the
 * rows under it read, and two calls to sortSessions is two chances for that to
 * stop being true. */
export function orderedSessions(): Session[] {
  return sortSessions([...sessions.values()], getManualOrder());
}

/* The clock the roster shows for a session: the ts of the newest row that is a
 * real message, skipping any control-answer row at the tail (a terminal prompt
 * answered from the app). Falls through to the last row when every row is a
 * control answer, so a session that has only ever recorded one still shows a
 * time. undefined when the log is empty. */
function lastActivityOf(chat: readonly { role: string; text: string; ts: number }[]): number | undefined {
  for (let i = chat.length - 1; i >= 0; i--) if (!isControlAnswer(chat[i])) return chat[i].ts;
  return chat.at(-1)?.ts;
}

export function sessionList(ordered: readonly Session[] = orderedSessions()) {
  return ordered
    .map((s, rank) => {
      /* ONE title for the whole session, resolved here (title.ts): your rename
       * wins, then Claude Code's own session title, then the pane name. Both the
       * row and the app's topbar draw it -- the row reads `title`, the topbar
       * reads `name` -- so both are fed from this single value and cannot drift
       * into disagreeing about what the session is called. */
      const title = titleOf(nameOverrideOf(s.id), claudeTitleOf(s), s.name);
      return {
      id: s.id,
      name: title.text,
      cwd: s.cwd,
      alive: s.alive,
      /* WORKING, and only working. `busy` above is the other question (can
       * this pane take a message now), and answering both with one field is
       * how the topbar came to say "thinking…" over a session that was
       * stopped waiting for him. */
      thinking: s.status === "working",
      unread: unreadOf(s),
      /* This session's overrides, raw. An absent key means "no override:
       * follow the user's global default", and only the CLIENT can resolve
       * that honestly, because the client is what fetches the global live
       * while this engine caches it. */
      settings: settingsOf(s.id),
      /* THE FACE HE PICKED FOR THIS SESSION, or null (task 331).
       *
       * A path on this engine, resolved against whatever base the client
       * dialled; photoOf() says why it is not an absolute URL and why null is
       * sent rather than the field being left out. */
      photo: photoOf(s.id),
      /* THE OVERLAY-CAPABLE SESSION ID, or null. The wire key keeps its
       * historical name (CONTRACT.md additive rule: the app's overlay gate and
       * rotation/gained detection already read `claudeSessionId`), but the
       * value is derived from the reader's DECLARED activity-event slot, not
       * the agent kind: any harness whose reader tails session events (claude,
       * codex, opencode today) advertises its one harness session id here, so
       * the app paints the activity rows the ingest already logs. A reader
       * without the slot (pi: its live events ride its socket, and its rows
       * are claude-shaped none) stays null, exactly the old claude-only
       * value for every such harness. */
      claudeSessionId: C().hasSessionEvents(s.agent.id) ? s.harnessSessionId : null,
      /* THE HARNESS SESSION ID this agent currently answers to, any harness,
       * or null while its pane has not said. An attribute of the row: it
       * changes in place on /clear, fork and resume while `id` stays. */
      harnessSessionId: s.harnessSessionId,
      /* THE STABLE AGENT ID. Since adapters lane 2 `id` above IS this value
       * (rows are keyed by agent, never by pane or harness session); the
       * field stays because that name already rides this row and a client
       * keys on it. The coding agent's TYPE stamp is `agentId` below (#587). */
      sessionAgentId: s.agentId,
      /* HOW MUCH OF THIS SESSION'S CONTEXT IS USED, 0-100, or null.
       *
       * USED, not left. Null is a real answer and it is the honest one: no
       * session file yet, or no assistant turn in it yet. An unknown model is
       * NOT null since 2026-09-02: the window fails open to 1M
       * (session-events.ts contextWindowFor), so a reading always has a
       * number. The app draws nothing at all for null rather than guessing,
       * because at the top of the range the two readings of this field mean
       * opposite things. */
      contextPct: contextPctOf(s),
      /* WHICH MODEL THIS SESSION IS RUNNING ON, as a display name ("Opus 4.8"),
       * or null. Same source as contextPct beside it -- the newest assistant
       * record in the transcript -- and composed here (modelName) rather than
       * shipped as a raw id, the same render-it-compose-nothing rule as `agent`
       * below: the app draws it under the session name as "Claude · Opus 4.8"
       * and owns none of the naming. Null is the honest answer for a model this
       * engine cannot name, a session with no assistant turn yet, or one
       * compacted and silent since; the app then shows the harness alone. */
      model: modelOf(s),
      /* Already looked at => downgrade herdr's unseen "done" to plain idle.
       * Deliberately not called "read": this is the session activity
       * indicator's seen-state, and it must never be added to `unread` above.
       * See doneSeq's own comment. */
      status: s.status === "done" && s.seenDoneSeq >= s.doneSeq ? "idle" : s.status,
      /* THE MARKER, and the only one on this wire. `heardMsgId` used to ride
       * here beside it and the app preferred it, so a reply with no msgId (any
       * `show`, any written reply) left the two pointing at different places.
       * A timestamp answers every question the msgId answered -- what is
       * unread, where the divider goes, where speech starts -- and answers them
       * for messages that never had a msgId to be named by. */
      heardTs: s.heardTs,
      /* THE READ-THROUGH ROW IDENTITY (fix-unread): the durable key and instant
       * of the newest row read. The app anchors its divider, its landing and
       * where speech resumes on THIS row, found by id, so a restamp or a
       * mis-sorted legacy page can never move the marker under it. `heardTs`
       * above stays as the derived clock for older apps and the persistence;
       * this is the authority the current app reads. Null when nothing is
       * read yet. */
      readThrough: readThroughOf(s) ?? null,
      /* The title, ready to render (title.ts).
       *
       * `workspace` and `tab` deliberately do NOT go on the wire any more.
       * They are herdr's vocabulary, the only thing the app ever did with them
       * was compose this string pair, and it composed it wrongly: the workspace
       * was the bold first text, which is the least specific fact about a
       * session and identical for every row in a project. */
      title,
      /* WHAT TO CALL THE THING READING THIS SESSION'S MESSAGES.
       *
       * The app used to compile the word in: "Queued for Claude" over a message
       * still in the agent's input, and "claude" on the row's second line when
       * nothing else had anything to say. Both are claims about which coding
       * agent is running, which only this engine can know, and both were wrong
       * the moment a pane ran something else.
       *
       * Sent PER SESSION even though one engine answers the same for all of
       * them today, for the reason `replyLevel` is: the row is where it is read,
       * and an engine that one day drives a claude pane and a codex pane side by
       * side has somewhere to say so without a new frame.
       *
       * Always present. An app that does not see it is talking to an engine
       * older than this field and falls back to its own default; the app must
       * never render it blank.
       *
       * PER ROW FOR REAL NOW (not just in shape): one engine used to answer the
       * same HARNESS.name for every row, but a codex pane and a claude pane list
       * side by side today, and each says its own agent's name. */
      agent: s.agent.name,
      /* THE AGENT ID, the raw stamp the name is a label for (agents.ts).
       *
       * The name is for a sentence ("Queued for Codex"); the id is for the app to
       * key on -- an icon per agent, a filter -- without parsing the display name.
       * Optional by absence: an older engine never sends it and the app keys
       * nothing on it (the-absent-is-unknown rule). */
      agentId: s.agent.id,
      /* WHICH DECLARED TAB THIS ROW BELONGS TO (tabs.ts).
       *
       * Always present, and "" when this engine declares no tabs, so a client
       * groups by this field and gets one group rather than having to know that
       * not grouping is a thing. Every value here is a key in the `tabs` array
       * that travels in the same frame: declareTabs is derived from these very
       * sessions, so a row can never name a tab the strip does not have. */
      tab: tabKeyOf(s, C().tabs),
      displayAgent: s.displayAgent,
      stateChangeSeq: s.stateChangeSeq,
      turnSince: s.turnSince,
      /* WHEN THIS SESSION LAST SAID ANYTHING, epoch ms, so the row can show its
       * top-right clock without the chat being opened. The app draws that clock
       * from the newest message it holds, and it holds none until you attach the
       * chat -- so an unopened row showed no time at all. The engine keeps the
       * whole history in s.chat (restored across restarts), so the newest
       * message's ts is here for the taking. Absent when the session has no
       * messages yet, which is a row with no time anyway. A control-answer row
       * (a terminal prompt he answered from the app) is skipped: it is a control
       * input, not something the session said, so it must not push the clock. */
      lastActivity: lastActivityOf(s.chat),
      /* The same value on every row now: it is one user setting, not a property
       * of this pane. Still sent per session because that is the shape the
       * deployed app reads, and it is what the ENGINE will actually write onto
       * the next message, which is a different question from what the app thinks
       * the setting is. Complexity is deliberately NOT here: no client reads it,
       * and a wire field nobody reads is a claim nobody checks. It is in the
       * hook state file, which is where "why did it answer like that" is asked. */
      replyLevel: C().replyLevel(),
      // What this session's MCP said it can deliver, so the app can grey out a
      // level it cannot honour and say "restart this session" instead of
      // silently doing nothing. Empty means the MCP predates the declaration and
      // did not say, which is not the same as "has none".
      channels: s.channels,
      /* WHAT THIS SESSION IS WAITING FOR, when it is waiting for anything.
       *
       * `ask` is a question with choices, ready to draw as buttons.
       * `askUnknown` is the honest other half: herdr says this pane is stopped
       * on something, and we cannot show what. The app must say so rather than
       * drawing nothing (which reads as "fine") or guessing (which is worse).
       * Never both.
       *
       * `askWhy` says WHICH not-known it is, because the app has been rendering
       * one sentence for two different facts: `unread` (we never got the screen)
       * and `unrecognised` (we have it and cannot say what it offers). Only the
       * first one is the terminal being unreadable. */
      ...askOf(s),
      /* WHERE THIS ROW SITS IN THIS LIST, not herdr's pane number any more.
       * The two used to be the same thing, which is why the field kept its
       * name; now that you can drag rows, the app must never be handed the
       * provider's number and left to guess. */
      order: rank,
      };
    });
}

/* THE SESSIONS FRAME, AND THE TABS DECLARATION IN IT.
 *
 * ONE FRAME, ON PURPOSE. The tabs could have been their own message beside
 * `can` and `voice`, and then there would be an instant on every connect, and
 * again on every workspace rename, where the app holds sessions naming a tab it
 * has not been told about yet -- and the app's only two answers to that are to
 * invent the tab or to drop the row, which are the two failures this whole
 * change exists to make impossible. Sent together they cannot disagree:
 * declareTabs is computed from the same list, in the same statement.
 *
 * `tabs` is absent when this engine declares none (tabs.ts says why an absent
 * declaration is the honest answer rather than a one-entry one), so the bytes
 * an unconfigured engine puts on the wire are exactly what they were before
 * this existed.
 */
export function sessionsFrame(): Record<string, unknown> {
  const ordered = orderedSessions();
  const list = sessionList(ordered);
  const tabs = declareTabs(ordered, C().tabs);
  return tabs.length ? { t: "sessions", list, tabs } : { t: "sessions", list };
}

// Deduped: the herdr side resnapshots on a poll and on chatty events
// (pane.focused fires on every terminal focus switch), most of which change
// nothing the clients can see. Only a payload that actually differs goes out.
let lastSessionsPayload = "";
export function broadcastSessions() {
  const frame = sessionsFrame();
  const payload = JSON.stringify(frame);
  if (payload === lastSessionsPayload) return;
  lastSessionsPayload = payload;
  // dedupe is on the INNER frame; each socket then seals its own copy in send()
  for (const c of clients) send(c, frame);
}

/** TEST ONLY: forget the deps AND the dedupe fingerprint, so a second
 *  in-process wiring's first sessions frame really goes out. Without the
 *  second half the dedupe is the bug: two wirings over the same fake panes
 *  produce byte-identical payloads, so the fresh clients of the second one
 *  would be told nothing at all and the frame would look lost. No-op in
 *  production, which never re-wires. */
export function resetForTest(): void {
  cfg = null;
  lastSessionsPayload = "";
}

/* The opening burst a fresh client gets: what this engine can do, its voice
 * state, who it is, the session list (+tabs) and its schedules. Extracted from
 * the hello branch so any future sealed path can send the identical burst. */
export function sendHelloBurst(ws: Sock) {
  send(ws, { t: "can", list: C().engineCan });
  /* The plugin declarations, right after `can`, absent when this engine loaded
   * none (the tabs rule: an absent declaration is the honest "nothing to
   * render", and an old engine that never had this sends the identical bytes).
   * Functions never ride here; PLUGIN_DECLS is the decl-only shape. */
  const decls = C().pluginDecls();
  if (decls.length) send(ws, { t: "plugins", list: decls });
  {
    const healthy = C().voiceHealthy();
    send(ws, voiceFrame(C().voicePublicUrl, healthy,
      C().voiceReady?.() ?? { stt: healthy, tts: healthy }));
  }
  send(ws, { t: "host", user: C().engineUser, host: C().engineHost });
  send(ws, sessionsFrame());
}
