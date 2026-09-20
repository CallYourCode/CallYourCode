// pi-events: the engine side of the pi output extension. The extension
// (engine/harness/pi/cyc-output.js) is a unix-socket CLIENT; this is the
// SERVER cyc binds per pi pane before launching pi. It receives the extension's
// newline-delimited frames and turns them into the SAME two things the
// transcript path already feeds: session events (chat/ingest logSession) and a
// working/idle edge (chat/ingest applyJsonlStatus).
//
// ADDITIVE, DEDUPED. A message/tool frame carries the durable id pi also writes
// to the transcript record, so a frame and the transcript row it mirrors share
// one `src.rid` and logSession keeps exactly one (it is idempotent on
// h|sid|rid). A status frame goes to applyJsonlStatus, which already ignores a
// repeat of the edge it last recorded. So the extension is a faster live
// source, never a second copy of what the transcript produces.
//
// If no extension ever connects, the server just sits idle and the transcript
// path is unaffected.

import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, unlinkSync } from "node:fs";
import type { SessionEvent } from "../sessions/session-events.ts";

const TOOL_CAP = 200;
const BODY_CAP = 2000;

/** The identity frame: who this pi pane is, so cyc can bind from the extension
 *  as well as from the transcript/hook. */
export type PiSessionFrame = {
  t: "pi.session";
  sessionId?: string;
  cwd?: string;
  model?: string;
};

/** One renderable row, or a status edge. */
export type PiEventFrame = {
  t: "pi.event";
  kind: "prompt" | "reply" | "tool" | "status";
  id?: string;
  ts?: number;
  text?: string;
  tool?: string;
  status?: "working" | "idle";
};

export type PiFrame = PiSessionFrame | PiEventFrame;

/** Parse one line into a frame, or null when it is blank/malformed/unknown.
 *  Never throws: a bad line from a socket is dropped, not fatal. */
export function parsePiFrame(line: string): PiFrame | null {
  const t = line.trim();
  if (!t) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const tag = (obj as { t?: unknown }).t;
  if (tag === "pi.session") return obj as PiSessionFrame;
  if (tag === "pi.event") {
    const kind = (obj as { kind?: unknown }).kind;
    if (kind === "prompt" || kind === "reply" || kind === "tool" || kind === "status") {
      return obj as PiEventFrame;
    }
  }
  return null;
}

function cap(text: string, n: number): string {
  return text.length > n ? text.slice(0, n) + "…" : text;
}

/** A prompt/reply/tool frame -> the SessionEvent the log keeps, or null for a
 *  status frame (handled by piFrameStatus) or an unrenderable one. `uuid` is
 *  the frame's durable id so it dedupes against the transcript row; a frame
 *  without one (should not happen: messages carry the leaf id, tools the
 *  toolCallId) falls back to a per-frame synthetic id that still renders. */
export function piFrameToEvent(frame: PiFrame): SessionEvent | null {
  if (frame.t !== "pi.event") return null;
  if (frame.kind === "status") return null;
  const ts = typeof frame.ts === "number" ? frame.ts : Date.now();
  const kind = frame.kind;
  const raw = typeof frame.text === "string" ? frame.text : "";
  const text = cap(raw, kind === "tool" ? TOOL_CAP : BODY_CAP);
  const uuid = typeof frame.id === "string" && frame.id ? frame.id : `pievt:${kind}:${ts}`;
  const ev: SessionEvent = { uuid, ts, kind, text, off: 0 };
  if (kind === "tool" && typeof frame.tool === "string") ev.tool = frame.tool;
  return ev;
}

/** The working/idle edge a status frame carries, or null for a non-status
 *  frame. */
export function piFrameStatus(frame: PiFrame): "working" | "idle" | null {
  if (frame.t !== "pi.event" || frame.kind !== "status") return null;
  return frame.status === "working" || frame.status === "idle" ? frame.status : null;
}

/* --------------------------------------------------------------- the server */

/** A per-pane unix-socket server. It binds `sockPath` (0600), accepts the
 *  extension's client, and hands each parsed frame to the current handler.
 *  Frames that arrive before a handler is attached are held in a small bounded
 *  buffer and flushed on attach, so the launch->connect->subscribe race never
 *  drops the first events. */
export class PiEventServer {
  private server: Server | null = null;
  private handler: ((frame: PiFrame) => void) | null = null;
  private sessionCb: ((sessionId: string) => void) | null = null;
  private lastSessionId: string | null = null;
  private readonly pending: PiFrame[] = [];
  private readonly sockets = new Set<Socket>();
  private closed = false;
  private static readonly PENDING_MAX = 512;

  constructor(readonly sockPath: string) {}

  /** Bind the socket. Removes a stale socket file first (a crashed prior
   *  engine). Resolves once listening; rejects on a bind error the caller can
   *  log and move past (the transcript path still covers the pane). */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        unlinkSync(this.sockPath);
      } catch {
        // nothing stale to remove
      }
      const server = createServer((socket) => this.accept(socket));
      server.on("error", (e) => {
        if (this.closed) return;
        reject(e);
      });
      server.listen(this.sockPath, () => {
        try {
          chmodSync(this.sockPath, 0o600);
        } catch {
          // best effort: a filesystem that cannot chmod a socket is rare
        }
        this.server = server;
        resolve();
      });
    });
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const frame = parsePiFrame(line);
        if (frame) this.deliver(frame);
      }
    });
    const drop = () => this.sockets.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
  }

  private deliver(frame: PiFrame): void {
    /* THE IDENTITY TAP, ahead of the handler/pending path and independent of
     * it. A pi.session frame names who this pane is; spawn (mux-adapter.ts)
     * attaches onSession before the pane command is typed, so the session id is
     * recorded as a pane bind the moment it arrives, without waiting for the
     * ingest consumer (which only subscribes once a sid already exists: the
     * chicken-and-egg this tap breaks). The frame then continues UNCHANGED
     * through the handler/pending path below (applyPiFrame no-ops it), so the
     * buffering and ordering of pi.event frames are byte-identical to before. */
    if (frame.t === "pi.session" && typeof frame.sessionId === "string" && frame.sessionId) {
      /* Remember the last named session so onSession, if it attaches AFTER the
       * frame arrived, still gets it (spawn attaches the tap right after the
       * pane is created, which can race the extension's re-send on connect).
       * With this, the identity is order-independent: an early frame is
       * replayed on attach, and every later frame calls the cb live. */
      this.lastSessionId = frame.sessionId;
      try { this.sessionCb?.(frame.sessionId); } catch { /* a consumer bug must not tear down the socket */ }
    }
    if (this.handler) {
      try {
        this.handler(frame);
      } catch {
        // a consumer bug must not tear down the socket
      }
      return;
    }
    if (this.pending.length < PiEventServer.PENDING_MAX) this.pending.push(frame);
  }

  /** Attach (or replace) the frame consumer, flushing anything buffered. */
  onFrame(cb: (frame: PiFrame) => void): void {
    this.handler = cb;
    if (this.pending.length) {
      const held = this.pending.splice(0, this.pending.length);
      for (const f of held) {
        try {
          cb(f);
        } catch {
          // ignore
        }
      }
    }
  }

  /** Detach `cb` if it is still the attached consumer. Frames buffer (bounded)
   *  again until the next onFrame, exactly like before the first attach. A
   *  different attached consumer is left alone. */
  offFrame(cb: (frame: PiFrame) => void): void {
    if (this.handler === cb) this.handler = null;
  }

  /** Attach a session-identity callback, invoked for every pi.session frame
   *  (before and independent of the frame handler). One per server; spawn sets
   *  it right after listen(). */
  onSession(cb: (sessionId: string) => void): void {
    this.sessionCb = cb;
    // replay a session id that arrived before this tap was attached, so a frame
    // the engine received during the spawn->attach window still binds the pane.
    if (this.lastSessionId) {
      try { cb(this.lastSessionId); } catch { /* a consumer bug must not tear down the socket */ }
    }
  }

  /** Stop accepting and remove the socket file. */
  close(): void {
    this.closed = true;
    this.handler = null;
    this.sessionCb = null;
    this.lastSessionId = null;
    for (const s of this.sockets) {
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // ignore
      }
      this.server = null;
    }
    try {
      unlinkSync(this.sockPath);
    } catch {
      // already gone
    }
  }
}
