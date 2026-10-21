/* A relay Pipe becomes a sealed client. The relay cannot read application frames. */
import { EngineSecConn, type E2EState } from "../security/sec";
import type { Pipe } from "../../../shared/ws-pipe";
import { clients, nextClientCid } from "./wire.ts";
import { onPresenceChange } from "../sessions/presence.ts";
import { sendHelloBurst } from "../sessions/sessions-frame.ts";
import { dispatchClientFrame, closeClient } from "./frames.ts";
import type { Sock, SockData, SealedSock } from "./sock.ts";

export type ClientGlueDeps = {
  e2e: E2EState;
  engineUser: string;
  engineHost: string;
  log(event: string, fields: Record<string, unknown>): void;
};

let deps: ClientGlueDeps | null = null;
export function initClientGlue(d: ClientGlueDeps): void {
  deps = d;
}
const D = (): ClientGlueDeps => {
  if (!deps) throw new Error("client-glue not initialised");
  return deps;
};

export function mintSealedClient(pipe: Pipe): void {
  const data: SockData = {
    role: "client", sessionId: null, attached: null,
    visible: true, visibleAt: Date.now(), lastVisibleAt: Date.now(), beatMs: 0, gaps: [], lastFrame: Date.now(),
    pongAt: 0, probeAt: 0, probeSeq: 0, cid: nextClientCid(), openedAt: Date.now(),
    tailing: null, terms: new Map(), remoteAddr: null, sec: null,
  };
  const sealedSock: SealedSock = {
    data,
    send(s) { void data.sec?.sealSend(JSON.parse(s)); },
    close(code, reason) { pipe.close(code, reason); },
    get remoteAddr() { return null; },
  };
  const sock = sealedSock as unknown as Sock;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    sec.markClosed();
    closeClient(sock);
  };
  const sec = new EngineSecConn(
    D().e2e, D().engineUser, D().engineHost,
    (frame) => pipe.send(JSON.stringify(frame)),
    () => {
      if (closed) return;
      clearTimeout(deadline);
      clients.add(sock);
      onPresenceChange();
      sendHelloBurst(sock);
      D().log("client.open", {client: `c${data.cid}`, clients: clients.size, transport: "ws", sec: true,
        dev: sec.devFp ?? undefined});
    },
    (inner) => void dispatchClientFrame(sock, inner),
    (code, reason) => { cleanup(); pipe.close(code, reason); },
    () => pipe.drain(),
  );
  const deadline = setTimeout(() => pipe.close(4401, "handshake-timeout"), 15_000);
  data.sec = sec;
  data.pipeDrain = () => pipe.drain();
  let pendingBytes = 0;
  let readChain = Promise.resolve();
  pipe.onmessage = (raw) => {
    const bytes = new TextEncoder().encode(raw).byteLength;
    if (pendingBytes + bytes > 32 * 1024 * 1024) { pipe.close(1009, "reader-limit"); return; }
    pendingBytes += bytes;
    readChain = readChain.then(async () => { if (!closed) await sec.feed(raw); })
      .catch(() => pipe.close(4400, "bad-frame"))
      .finally(() => { pendingBytes -= bytes; });
  };
  pipe.onclose = cleanup;
}
