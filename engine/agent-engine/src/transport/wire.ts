/* THE WIRE (L1): the one socket-write choke point, and the set of clients it
 * writes to.
 *
 * Everything the engine says to an attached client goes through send() here --
 * one place to seal, one place to fail quietly when a socket died between the
 * decision and the write. broadcast() fans one frame to every client; the
 * SESSIONS-frame dedupe lives with the sessions frame (its owner), not here.
 */

import type { Sock } from "./sock.ts";

/** Every attached client socket (role=client), whatever transport carried it. */
export const clients = new Set<Sock>();

/* Names a client in the log. Endpoints, tokens and subscription keys are
 * secrets and never appear in a line; "c7" is enough to follow one device
 * through a decision. */
let clientSeq = 0;
export function nextClientCid(): number {
  return ++clientSeq;
}

/* Plaintext write, bypassing the e2e envelope. Used only for the three
 * handshake frames themselves (can/e2e/e2e-required), which are plaintext by
 * design and go out before any frame key exists. */
export function rawSend(ws: Sock, msg: unknown) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // socket already gone; the close handler will clean up
  }
}

/* The one socket-write choke point. A DataChannel client's `send` seals
 * through its own EngineSecConn (sock.ts RtcSock), so sealing is per-socket
 * and this stays transport-blind. */
export function send(ws: Sock, msg: unknown) {
  rawSend(ws, msg);
}

export function broadcast(msg: unknown) {
  for (const c of clients) send(c, msg);
}

export function isLoopback(addr: string | null): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** TEST ONLY: drop every registered client and put the cid counter back to
 *  zero, so a second in-process wiring in the same worker starts with the
 *  empty client set a fresh process has. Nothing in production calls it: the
 *  client set only empties when the process does.
 *
 *  It deliberately does NOT close the sockets. Whoever registered them owns
 *  closing them; this only takes them off the broadcast list, which is what a
 *  re-wire needs and all it needs. */
export function resetForTest(): void {
  clients.clear();
  clientSeq = 0;
}
