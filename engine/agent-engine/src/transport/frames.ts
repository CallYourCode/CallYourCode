/* CLIENT FRAMES (L4 interface): the one dispatcher a WS client and a
 * DataChannel client share, the terminal ws handlers over the hub, and
 * closeClient -- the only event guaranteed to arrive, so terminals and
 * presence are freed here.
 */

import { TerminalHub, clampCols, clampRows, safeInput, safeScroll,
  type ScrollMode, type TerminalHandlers, type TerminalSession, type Viewer } from "../terminal/terminal.ts";
import { clients, send } from "./wire.ts";
import { sessions } from "../sessions/session-state.ts";
import { onPresenceChange } from "../sessions/presence.ts";
import { onHeard } from "../chat/reply.ts";
import { onAttach, onProgress } from "../chat/attach.ts";
import { onUtterance } from "../chat/deliver.ts";
import { onInterrupt, onCompact, onAnswer } from "../sessions/session-verbs.ts";
import { onSttOpen, onSttChunk, onSttClose, closeSttClient } from "../voice/voice-proxy.ts";
import { onRegister, dispatchSessionFrame } from "../runtime/mcp.ts";
import { addRtcCand, closeRtc } from "./rtc";
import { onReq, onReqAbort, closeTunnelClient } from "./tunnel-glue.ts";
import { onVoiceFp, onVoiceCtl } from "../voice/voicectl.ts";
import { broadcastSessions } from "../sessions/sessions-frame.ts";
import type { Sock } from "./sock.ts";

const NOTIFY_DEBUG = process.env.NOTIFY_DEBUG === "1";

export type FramesDeps = {
  /* The adapter's terminal driver verbs (one driver, no second factory),
   * typed against terminal.ts's own vocabulary. They used to be spelled by
   * hand here -- paneMode as `"normal" | "alt"`, which is not what ScrollMode
   * has ever been, and openTerminal as unknown -> unknown -- and the object
   * built from them needed an `as any` to reach TerminalHub. That cast is what
   * made the four handler parameters below implicitly any. */
  terminalCanResize: boolean;
  terminalPaneMode(paneId: string): Promise<ScrollMode>;
  openTerminal(paneId: string, cols: number, rows: number, h: TerminalHandlers): TerminalSession;
  terminalViewer(): boolean;
  log(event: string, fields: Record<string, unknown>): void;
};

let deps: FramesDeps | null = null;
let terminals: TerminalHub | null = null;

/* WHICH SOCKET EACH VIEWER RIDES, so the hub's no-viewer watchdog can ask this
 * layer (the one that owns the client set) whether a viewer's transport is
 * still there. A WeakMap so a viewer that is gone is collected with its socket;
 * nothing here has to prune it. */
const viewerSock = new WeakMap<Viewer, Sock>();

/* The watchdog cadence, env-tunable. This is the half-open safety net, not a
 * hot path: sixty seconds is long enough that a live viewer between beats is
 * never mistaken for dead. */
const WATCHDOG_MS = Math.max(0, Number(process.env.CYC_TERMINAL_WATCHDOG_MS ?? 60_000) || 0);

export function initFrames(d: FramesDeps): void {
  deps = d;
  /* The bridge driver is the adapter's (openTerminal); the hub is core
   * (refcount + socket fanout). */
  terminals = new TerminalHub(
    {
      name: "mux",
      canResize: d.terminalCanResize,
      paneMode: (paneId) => d.terminalPaneMode(paneId),
      open: (paneId, cols, rows, h) => d.openTerminal(paneId, cols, rows, h),
    },
    (s) => d.log("terminal", { line: s }),
    {
      /* A viewer is live iff its socket is still an active client. closeClient
       * removes a socket the moment its transport drops, so a viewer whose
       * socket is gone from the set is one whose close event fired (or should
       * have). A viewer we never mapped is `undefined` -- cannot tell -- which
       * the hub treats as live, so an unknown viewer is never torn down. */
      isViewerLive: (v) => {
        const sock = viewerSock.get(v);
        if (!sock) return undefined;
        return clients.has(sock);
      },
      watchdogMs: WATCHDOG_MS,
    },
  );
}
const HUB = (): TerminalHub => {
  if (!terminals) throw new Error("frames not initialised");
  return terminals;
};
const D = (): FramesDeps => {
  if (!deps) throw new Error("frames not initialised");
  return deps;
};

// Overlay toggle: kept as the client's stated preference only. The session
// records reach every attached client in the pages and as `session-event`
// deltas whether or not the overlay is on (design A.3); showing them is the
// app's render filter, and the engine ingests regardless of watchers.
export function onSessionTail(ws: Sock, m: any) {
  const id = String(m.id ?? "");
  if (!id) return;
  if (m.on) ws.data.tailing = id;
  else if (ws.data.tailing === id) ws.data.tailing = null;
}

// ---------------------------------------------------------------- terminal

/* The live terminal pane: watch AND use.
 *
 * The hub owns the bridge processes and the refcount; this is only the ws
 * side of it. Five frames in -- open, resize, input, scroll, close -- and the
 * ones out (term-frame, term-size, term-closed) are fanned by the hub straight
 * to the sockets that asked, on this same connection. No second socket, no
 * polling.
 *
 * THE APP DECIDES THE SIZE, and that is the point of `cols`/`rows` riding the
 * open frame rather than being chosen here. The app measures its own box, and
 * the ONE number it measured drives both the bridge (here) and its own xterm,
 * so the two cannot drift into rendering different shapes of the same pane.
 */

export function onTermOpen(ws: Sock, m: any) {
  const id = String(m.id ?? "");
  if (!id) return;
  /* The mux decides whether a terminal can be shown at all. A mux with
   * terminalViewer:false (a Hermes-shaped agent with no pane) is refused here
   * -- the equivalent of a "400" -- as a term-closed frame, the contract's
   * terminal refusal; there is no HTTP status on the ws wire. */
  if (!D().terminalViewer()) {
    send(ws, { t: "term-closed", id, why: "this engine's mux cannot show a terminal" });
    return;
  }
  /* A pane this engine does not have. Answer, rather than going quiet: a
   * viewer that gets nothing back cannot tell "this engine has no such pane"
   * from "the bridge is still starting", and it draws an empty terminal for
   * both. (Same reasoning as the chat-start for an unknown session.)
   *
   * `sessions` HOLDS THE PANES RUNNING A CLAUDE AGENT, AND THAT IS THE WHOLE
   * POINT OF THE CHECK. A client on the network can open a terminal onto a
   * session this engine already knows and tracks, and onto nothing else. Not
   * an arbitrary pane, not a plain shell someone left a password in.
   *
   * It was relaxed for half a day on 2026-08-03 so the viewer could be pointed
   * at a scratch shell full of numbered lines while the scroll behaviour was
   * worked out, and put back the moment that was done. The owner's decision on
   * it: the guard is crucial; the engine may only ever expose the sessions it
   * tracks to the viewer.
   *
   * If it ever needs relaxing again, relax it in the APP with a named override
   * (the empty TERMINAL_PANE_OVERRIDE seam in app/src/engine/store/terminal.ts) and a
   * temporary change here, together, and put both back together. Never leave
   * this one open on its own: the app-side seam is visible in a diff, and a
   * widened engine guard is not. */
  const s = sessions.get(id);
  if (!s) {
    send(ws, { t: "term-closed", id, why: "no such pane on this engine" });
    return;
  }
  const prev = ws.data.terms.get(id);
  if (prev) HUB().close(prev);
  const v: Viewer = {
    /* THE LIVE HERDR PANE, not the id the app opened with. A conversation is
     * now its stable claude session id (2026-08-07), so `id` here is that id,
     * and herdr has no pane by that name -- spawning the bridge against it
     * exited on every session and the terminal was blank everywhere (#355). The
     * pane the session is sitting in right now is what the bridge needs. */
    paneId: s.muxHandle,
    // ...and the app keys its open terminal by the id it sent, so frames go back
    // tagged with that, not the raw pane. See Viewer.routeId.
    routeId: id,
    // The DEVICE, not the socket: one phone gets one bridge however many tabs
    // it has open on it. Absent from an older app: fall back to the socket's
    // own name, which is unique per connection and so never shares.
    device: String(m.dev ?? `c${ws.data.cid}`),
    cols: clampCols(m.cols),
    rows: clampRows(m.rows),
    send: (msg) => send(ws, msg),
  };
  ws.data.terms.set(id, v);
  viewerSock.set(v, ws); // so the watchdog can ask if this viewer's socket is still alive
  HUB().open(v);
  D().log("term.open", { client: `c${ws.data.cid}`, session: id, pane: s.muxHandle, cols: v.cols, rows: v.rows });
}

export function onTermResize(ws: Sock, m: any) {
  const v = ws.data.terms.get(String(m.id ?? ""));
  if (!v) return;
  HUB().resize(v, clampCols(m.cols), clampRows(m.rows));
}

/* Keys, from the app into the pane.
 *
 * Deliberately NOT arming anything. The plan left "which sessions are typeable"
 * open and he closed it: every session, no arm switch. A pane he can watch is a
 * pane he can type into, because the point of the whole thing is that when a
 * session asks him a question he can answer it from his phone.
 *
 * The frame carries either `text` (what was typed) or `b64` (a key that is not
 * text: Ctrl-C is one byte, an arrow is three). safeInput() in terminal.ts is
 * the only thing that decides what may go through; a frame it rejects is
 * dropped here in silence, because the honest answer to "that key was
 * malformed" is not to send the pane some other key instead.
 */
export function onTermInput(ws: Sock, m: any) {
  const v = ws.data.terms.get(String(m.id ?? ""));
  if (!v) return;
  const input = safeInput({ text: m.text, bytes: m.b64 });
  if (!input) return;
  HUB().input(v, input);
}

export function onTermScroll(ws: Sock, m: any) {
  const v = ws.data.terms.get(String(m.id ?? ""));
  if (!v) return;
  const s = safeScroll({ dir: m.dir, lines: m.lines });
  if (!s) return;
  HUB().scroll(v, s.direction, s.lines);
}

export function onTermClose(ws: Sock, m: any) {
  const id = String(m.id ?? "");
  const v = ws.data.terms.get(id);
  if (!v) return;
  ws.data.terms.delete(id);
  HUB().close(v);
  D().log("term.close", { client: `c${ws.data.cid}`, session: id });
}


/* The client-frame dispatcher, shared by a WS client (websocket.message) and a
 * DataChannel client (the RtcSock's EngineSecConn hands it the opened inner
 * frame). ws is a Sock or a Sock-shaped RtcSock; only data/send are touched. */
export async function dispatchClientFrame(ws: Sock, m: any): Promise<void> {
  /* Same proof the WS path records in websocket.message: a frame arrived, so
   * this page's javascript is running RIGHT NOW. Sealed DC frames never pass
   * that handler, and leaving lastFrame at mint time made every live DataChannel
   * look frozen once BEAT_ASSUMED_MS elapsed. */
  ws.data.lastFrame = Date.now();
  if (m.t === "visible") {
    const now = Date.now();
    /* Learn how long this page can plausibly go quiet while alive, rather than
     * hardcoding a cadence. The statistic is the LARGEST of the last few gaps,
     * not an average: a focus/visibilitychange fires a claim out of turn and an
     * average would teach a cadence shorter than the real timer. */
    if (m.on !== false && ws.data.visible && ws.data.visibleAt) {
      const gap = now - ws.data.visibleAt;
      if (gap > 1_000 && gap < 60_000) {
        ws.data.gaps.push(gap);
        if (ws.data.gaps.length > 4) ws.data.gaps.shift();
        ws.data.beatMs = Math.max(...ws.data.gaps);
      }
    }
    if (NOTIFY_DEBUG) {
      console.log(`[notify] beat c${ws.data.cid} on=${m.on !== false} ` +
        `gap=${now - ws.data.visibleAt}ms beat=${ws.data.beatMs}ms chat=${ws.data.attached ?? "-"}`);
    }
    ws.data.visible = m.on !== false;
    ws.data.visibleAt = now;
    return;
  }
  // The answer to pokeForProof: recording the frame above proves the page alive.
  if (m.t === "pong") return;
  /* The app's own liveness probe (offline design v2, section 2b): the mirror
   * of the engine-originated pair, answered at once with the same n. It
   * replaced the attach the app used to probe with, which re-sent the whole
   * event log every time. */
  if (m.t === "ping") { send(ws, { t: "pong", n: m.n }); return; }
  if (m.t === "heard") onHeard(m);
  else if (m.t === "attach") onAttach(ws, m);
  else if (m.t === "progress") onProgress(m);
  /* NOT AWAITED: a message held while its recording decodes must not stop this
   * socket reading the next frame; onUtterance decides delivery order. */
  else if (m.t === "utterance") {
    void onUtterance(ws, m).catch((e) => D().log("utterance.threw",
      { session: String(m.id ?? ""), err: String(e) }));
  }
  else if (m.t === "interrupt") onInterrupt(m);
  else if (m.t === "compact") onCompact(ws, m);
  else if (m.t === "answer") await onAnswer(ws, m);
  else if (m.t === "session-tail") onSessionTail(ws, m);
  else if (m.t === "term-open") onTermOpen(ws, m);
  else if (m.t === "term-resize") onTermResize(ws, m);
  else if (m.t === "term-input") onTermInput(ws, m);
  else if (m.t === "term-scroll") onTermScroll(ws, m);
  else if (m.t === "term-close") onTermClose(ws, m);
  /* The sealed request/response tunnel. A {t:"req"} rides the same
   * sealed channel every other client frame does; onReq feeds the same
   * routeRequest the localhost server uses and seals the {t:"res"} chunks
   * back. The channel is the auth. */
  else if (m.t === "req") await onReq(ws, m);
  /* Step 4c: the app walked away from an in-flight tunnelled request. Stops
   * the engine's spool (and deletes its temp file) and any streamed reply. */
  else if (m.t === "req-abort") await onReqAbort(ws, m);
  /* Call-mode voice: the DTLS fp binding and call-mode control. Audio itself never
   * touches this dispatch -- it rides the media track; only the text control
   * (fp, start/stop/speak) does. */
  else if (m.t === "fp") onVoiceFp(ws, m);
  else if (m.t === "voice-ctl") await onVoiceCtl(ws, m);
  /* The mic stream AS DATA. Replaces the removed
   * /voice/stt-stream WS route (a WS upgrade can never carry the sealed-tunnel
   * mark): PCM rides the sealed channel as base64 chunks, the bridge in
   * voice-proxy.ts carries them to the voice engine over loopback, and
   * stt-partial/stt-final/stt-error ride back sealed under the same id. */
  else if (m.t === "stt-open") onSttOpen(ws, m);
  else if (m.t === "stt-b") onSttChunk(ws, m);
  else if (m.t === "stt-close") onSttClose(ws, m);
}

/* Release everything a client (WS or DataChannel) was holding. The only event
 * guaranteed to arrive, so terminals + presence are freed here. */
export function closeClient(ws: Sock): void {
  clients.delete(ws);
  closeTunnelClient(ws); // delete any half-spooled tunnel request bodies
  closeSttClient(ws); // tear down any live voice-engine stream sockets
  for (const v of ws.data.terms.values()) HUB().close(v);
  ws.data.terms.clear();
  onPresenceChange(); // last one out starts the 30s grace
  D().log("client.close", { client: `c${ws.data.cid}`, clients: clients.size,
    wasAttachedTo: ws.data.attached ?? undefined });
}


/* onSignalOffer is passed IN rather than imported: rtc-glue imports this
 * module (dispatchClientFrame/closeClient), and siblings talk through
 * injected functions, never a cycle. */
export function makeWsHandlers(glue: { onSignalOffer(ws: Sock, m: { id: string; sdp: string }): Promise<void> }): import("bun").WebSocketHandler<import("./sock.ts").SockData> {
  return {
    open(_ws) {
      // Role is unknown until the first message declares it.
    },

    /* The browser's answer to a protocol ping. Recorded, and only TRUSTED as
     * proof of a live page when PONG_IS_PROOF (notify.ts) says the measurement in
     * freeze-probe.ts found it comes from the page rather than from the
     * browser's network stack. */
    pong(ws) {
      ws.data.pongAt = Date.now();
    },

    async message(ws, raw) {
      // A frame arrived, so this page's javascript is running RIGHT NOW.
      // That is the evidence notifyUnlessWatched waits for; a frozen page
      // cannot produce it however fresh its last "visible" claim looks.
      ws.data.lastFrame = Date.now();
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }

      // First message picks the role.
      if (ws.data.role === null) {
        if (m.t === "register") {
          onRegister(ws, m);
          return;
        }
        if (m.t === "hello") {
          /* #579: the WS is signaling-only. A plain WS `hello` never gets the
           * plaintext burst; the engine answers `transport-required` and the app
           * dials the DataChannel + runs the sealed v2 sec handshake there
           * (onSignalOffer -> mintRtcClient).
           *
           * `can` is WHAT THIS ENGINE CAN DO, said out loud, before it is asked.
           * There is one deployment of the app and several engines updated at
           * different times, so "the other end is older than me" is an ordinary
           * Tuesday. `words` (task 292) is a promise the app must not make to an
           * engine that never heard of it; a list, not a boolean, so the next
           * such capability is not a second frame. */
          D().log("client.blocked", { client: `c${ws.data.cid}`, reason: "ws-transport" });
          try { ws.send(JSON.stringify({ t: "transport-required", transport: "rtc" })); } catch {}
          try { ws.close(4426, "transport-required"); } catch {}
          return;
        }
        /* #579: a client's signaling leg. The rtc-offer is the FIRST frame; this
         * socket becomes the DataChannel's signaling channel and carries only
         * rtc-*. The sealed client wire rides the DataChannel. */
        if (m.t === "rtc-offer" && typeof m.sdp === "string" && typeof m.id === "string") {
          ws.data.role = "signal";
          await glue.onSignalOffer(ws, m);
          return;
        }
        return; // undeclared socket, ignore
      }

      if (ws.data.role === "signal") {
        // Only rtc-* rides a signaling WS; a data frame here is dropped + logged.
        if (m.t === "rtc-cand") addRtcCand(ws.data.rtc!, m.cand ?? null);
        else if (m.t === "rtc-abort") {
          if (ws.data.rtc) closeRtc(ws.data.rtc);
          try { ws.close(1000, "abort"); } catch {}
        } else D().log("signal.reject", { client: `c${ws.data.cid}`, t: String(m.t) });
        return;
      }

      if (ws.data.role === "session") {
        await dispatchSessionFrame(ws, m);
        return;
      }

      // role === "client": one dispatcher for a WS client AND a DataChannel
      // client (the RtcSock feeds it the OPENED inner frame, #579).
      await dispatchClientFrame(ws, m);
    },

    close(ws) {
      if (ws.data.role === "client") {
        closeClient(ws);
        return;
      }
      /* A signaling WS closing tears the DataChannel down with it: its close is
       * the sub-second "engine restarted / tab gone" signal. The
       * pipe close then runs closeClient on the RtcSock it spawned. */
      if (ws.data.role === "signal") {
        if (ws.data.rtc) closeRtc(ws.data.rtc);
        return;
      }
      // For non-herdr sessions the socket closing IS the liveness signal --
      // but the session does not disappear. It stays listed, dead
      // (alive:false), chat intact, so the page can show it greyed and
      // read-only. Re-registering with the same id brings it back. No
      // heartbeat, no reaper, no disk. For herdr sessions liveness belongs
      // to the pane; losing the voice-out socket changes nothing visible.
      const id = ws.data.sessionId;
      const s = id ? sessions.get(id) : undefined;
      if (s && s.ws === ws) {
        s.ws = null;
        if (!s.viaMux) {
          s.alive = false;
          broadcastSessions();
          console.log(`[session] - ${id} (kept, dead)`);
        } else {
          console.log(`[session] ~ ${id} voice-out detached`);
        }
      }
    },
  };
}
