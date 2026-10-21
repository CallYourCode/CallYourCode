import type { Viewer } from "../terminal/terminal.ts";
import type { EngineSecConn } from "../security/sec";

export type Role = "session" | "client";

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
  /* The last time this page was actually VISIBLE: `now` while it says it is
   * visible, and the moment it went hidden otherwise. Unlike `visibleAt` (which
   * stamps every visibility claim, hidden ones included) this never moves while
   * a tab stays backgrounded, so "how long ago was he last looking at this
   * device" is `now - lastVisibleAt`. 0 until the page has been visible once,
   * which is how a never-visible socket (a tab opened in the background) is told
   * from one he set down a moment ago. Read by presence.recentlyUsed. */
  lastVisibleAt: number;
  /* Whether this is a laptop/desktop, as the app reports it in the visible
   * frame (a fine pointer, not a mobile OS). ONLY a desktop holds a push via
   * recentlyUsed (owner decision, 2026-10-01): a phone or tablet he locked a
   * moment ago buzzes right away as before, because the device he set down is
   * the one he might come back to without a nudge. Absent or false on an older
   * app or a device whose kind could not be told, which recentlyUsed reads as
   * NOT desktop, so an unknown client never delays a push. Read by
   * recentlyUsed; stamped in frames.ts off the visible frame. */
  desktop?: boolean;
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
  sec?: EngineSecConn | null;
  pipeDrain?: (() => Promise<void>) | null;
};
export type Sock = import("bun").ServerWebSocket<SockData>;
export type SealedSock = { data: SockData; send(s: string): void; close(code?: number, reason?: string): void; readonly remoteAddr: string | null };
