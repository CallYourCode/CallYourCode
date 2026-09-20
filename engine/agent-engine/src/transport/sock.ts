/* THE SOCKET SHAPES (L1 wire layer): what a connection to this engine IS.
 *
 * One Role per socket, one SockData attached to every Bun ServerWebSocket, and
 * the RtcSock duck-type a DataChannel client wears so the shared dispatch and
 * close paths never care which transport carried the frames. Types only; the
 * behaviour that fills these lives with the feature that owns it.
 */

import type { Viewer } from "../terminal/terminal.ts";
import type { RtcAttempt } from "./rtc";
import type { EngineSecConn } from "../security/sec";

export type Role = "session" | "client" | "signal";

export type SockData = {
  role: Role | null;
  sessionId: string | null; // role=session: who this socket is
  attached: string | null; // role=client: which session it is listening to
  /* is that client's window actually in front? A tab attached to a chat in a
   * background window is not "watching" it, and a notification there is the
   * whole point. The page reports this; absent means unknown, treated as
   * watching, which is the behaviour that existed before. */
  visible: boolean;
  /* When the client last SAID it was visible.
   *
   * "visible" cannot be trusted as a latch. Minimising an installed PWA on
   * iOS freezes the page: visibilitychange fires and the frame telling us so
   * may or may not reach the socket before the process is suspended, and the
   * socket itself stays open either way. The engine then went on believing
   * somebody was looking at the chat and suppressed every notification.
   *
   * So the page repeats it while it is visible, and a claim that has gone
   * quiet stops counting. A frozen page cannot heartbeat, which is exactly
   * the property wanted here. What it CANNOT do on its own is answer the
   * question quickly, which is what notifyUnlessWatched's probe is for. */
  visibleAt: number;
  /* How long this page can go quiet and still be alive: the largest of its last
   * few gaps between visibility claims, so the engine waits on the cadence the
   * client actually has rather than a constant that has to be kept in step with
   * the app by hand. 0 until two claims have arrived. */
  beatMs: number;
  gaps: number[];
  /* The last time ANY frame arrived from this socket. A frame is proof the
   * page's javascript ran, which is the only trustworthy evidence that
   * somebody is really there. */
  lastFrame: number;
  pongAt: number;  // protocol-level pong; proof only if the browser's renderer answers it
  probeAt: number; // when we last poked, for the log
  probeSeq: number;
  cid: number;     // a name for this client in the log, since endpoints are secret
  /* When this socket opened. Read only by appConnected, to tell a page somebody
   * is sitting in front of from one that has been up for two seconds. */
  openedAt: number;
  tailing: string | null; // role=client: session whose overlay events it wants
  /* role=client: the terminal panes this socket has open, paneId -> viewer.
   * A Map because a laptop can have two chats open in two tabs, and because
   * the close handler needs to release every bridge this socket was holding
   * without knowing which ones those were. */
  terms: Map<string, Viewer>;
  /* The socket's peer address, captured at upgrade (server.requestIP is only
   * reachable there). require mode uses it to accept `register` from loopback
   * only: the MCP is this host talking to itself. */
  remoteAddr: string | null;
  /* #579. A `signal` socket carries one client's rtc-offer negotiation (rtc
   * points at its RtcAttempt). A `client` is born only from a DataChannel and
   * has transport:"rtc" and `sec` set to its per-connection sec state machine;
   * `send` on such a sock seals through it. signalWs is the signaling WS that
   * carried the offer (its close tears the DC down). There is no
   * plain WebSocket client any more: /ws is signaling-only. */
  transport?: "rtc";
  rtc?: RtcAttempt | null;
  sec?: EngineSecConn | null;
  signalWs?: Sock | null;
  /* #Plan-C tunnel: drain the DataChannel pipe's send buffer (dcpipe
   * backpressure), so a chunked {t:"res"} answer does not flood a slow link.
   * Set only on a DataChannel client (mintRtcClient); a no-op elsewhere. */
  pipeDrain?: (() => Promise<void>) | null;
  /* The Host header this socket arrived on, captured at upgrade. rtc.ts
   * advertises the ICE candidate for THIS address (his cross-machine
   * constraint), resolved to an interface IP in reachedAddrOf. */
  reachedHost?: string | null;
  /* Call-mode voice. The Opus media bridge for this DataChannel client, present
   * only when the offer carried m=audio. The engine's own DTLS fp (from its
   * answer SDP) and the peer's fp as it saw it over DTLS; the {t:"fp"} exchange
   * checks the app's reported view against these and, on a match, opens the
   * bridge's audio gate. All absent on a WS or media-less client. */
  audio?: import("../voice/voice-media.ts").AudioBridge | null;
  fpLocal?: string | null;
  fpRemote?: string | null;
};

export type Sock = import("bun").ServerWebSocket<SockData>;

/* A DataChannel client (#579): duck-types as a Sock for the shared
 * client dispatch/close/send, which only touch data/send/close. `send` seals
 * through the connection's EngineSecConn and writes the pipe. Cast to Sock at
 * the one rtc boundary rather than restructuring Sock across 9k lines. */
export type RtcSock = { data: SockData; send(s: string): void; close(code?: number, reason?: string): void; readonly remoteAddr: string | null };

