/* RTC GLUE (L4 interface): how a DataChannel becomes a client.
 *
 * An rtc-offer on a fresh /ws socket (role "signal") negotiates the channel;
 * on DataChannel open the sealed v2 sec handshake runs over the pipe and a
 * client Sock is minted whose send() seals through its EngineSecConn. A relay
 * conn wears the same signaling-Sock shape, so a channel negotiated THROUGH
 * the relay births exactly the same client as a local one.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { EngineSecConn, type E2EState } from "../security/sec";
import { onRtcOffer, closeRtc, RTC, fingerprintsOf } from "./rtc";
import type { RelayConn } from "./relay.ts";
import type { Pipe } from "./dcpipe";
import { AudioBridge } from "../voice/voice-media.ts";
import { clients, nextClientCid, rawSend, send } from "./wire.ts";
import { onPresenceChange } from "../sessions/presence.ts";
import { sendHelloBurst } from "../sessions/sessions-frame.ts";
import { dispatchClientFrame, closeClient } from "./frames.ts";
import type { Sock, SockData, RtcSock } from "./sock.ts";

export type RtcGlueDeps = {
  e2e: E2EState;
  engineUser: string;
  engineHost: string;
  log(event: string, fields: Record<string, unknown>): void;
};

let deps: RtcGlueDeps | null = null;
export function initRtcGlue(d: RtcGlueDeps): void {
  deps = d;
}
const D = (): RtcGlueDeps => {
  if (!deps) throw new Error("rtc-glue not initialised");
  return deps;
};

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/* The address the page reached THIS engine on, as an ICE-usable IP (his
 * cross-machine constraint). The signaling WS Host header's host: an IP is used
 * as-is; localhost -> 127.0.0.1; a hostname (his linux...ts.net) is resolved to
 * the interface IP the browser routed to, so rtc.ts advertises a candidate the
 * browser can actually reach. Loopback on any failure. */
export async function reachedAddrOf(signalWs: Sock): Promise<string> {
  const hostHeader = signalWs.data.reachedHost ?? "";
  const host = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") return "127.0.0.1";
  if (IPV4.test(host)) return host;
  try {
    const { address } = await dnsLookup(host, { family: 4 });
    return address || "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}

/* Answer an rtc-offer on a fresh /ws socket (role "signal"). On DataChannel open
 * the sealed sec handshake runs over the pipe and a client is born. */
export async function onSignalOffer(signalWs: Sock, m: { id: string; sdp: string }): Promise<void> {
  if (!RTC.available) {
    console.log(`[rtc] signal.offer id=${m.id} refused reason=rtc-unavailable`);
    rawSend(signalWs, { t: "rtc-fail", id: m.id, reason: "unavailable" });
    signalWs.close(4403, "rtc-unavailable");
    return;
  }
  const reachedAddr = await reachedAddrOf(signalWs);
  console.log(`[rtc] signal.offer id=${m.id} reached=${reachedAddr} audio=${/^m=audio/m.test(m.sdp)}`);
  signalWs.data.rtc = await onRtcOffer(m,
    /* the LOCAL policy, byte-identical to before opts existed: no ICE
     * servers, advertise only loopback + the reached address */
    { reachedAddr, iceServers: [], advertiseAll: false },
    (f) => rawSend(signalWs, f),
    (pipe) => mintRtcClient(pipe, signalWs));
}

/* A relay conn wearing the signaling-Sock shape mintRtcClient expects, so a
 * DataChannel negotiated THROUGH the relay service births exactly the same
 * client as one negotiated on a local /ws. Its close sends r-close for the
 * conn (a no-op once the device leg detached after upgrade); there is no
 * remote address (nothing dialed us) and no reached host (nothing was
 * reached: the relay path advertises all candidates instead). */
export function relaySignalSock(conn: RelayConn): Sock {
  const data: SockData = {
    role: "signal", sessionId: null, attached: null,
    visible: true, visibleAt: Date.now(), beatMs: 0, gaps: [], lastFrame: Date.now(),
    pongAt: 0, probeAt: 0, probeSeq: 0, cid: nextClientCid(), openedAt: Date.now(),
    tailing: null, terms: new Map(), remoteAddr: null,
    rtc: conn.attempt, sec: null, signalWs: null, reachedHost: null,
  };
  const sock = {
    data,
    send(_s: string) { /* signaling back to the device rides conn.send inside rtc.ts */ },
    close(code?: number, reason?: string) { conn.close(code, reason); },
    get remoteAddr() { return null; },
  };
  return sock as unknown as Sock;
}

/* The cyc DataChannel opened: mint the client Sock + its per-connection sec
 * state machine. send() on this sock seals through the channel; incoming opened
 * frames run the ordinary client dispatch; a pipe close runs closeClient. */
export function mintRtcClient(pipe: Pipe, signalWs: Sock): void {
  const data: SockData = {
    role: "client", sessionId: null, attached: null,
    visible: true, visibleAt: Date.now(), beatMs: 0, gaps: [], lastFrame: Date.now(),
    pongAt: 0, probeAt: 0, probeSeq: 0, cid: nextClientCid(), openedAt: Date.now(),
    tailing: null, terms: new Map(), remoteAddr: signalWs.data.remoteAddr,
    transport: "rtc", rtc: signalWs.data.rtc, sec: null, signalWs, reachedHost: signalWs.data.reachedHost,
  };
  D().log("rtc.dc.open", { client: `c${data.cid}` });
  const rtcSock: RtcSock = {
    data,
    send(s: string) {
      void data.sec?.sealSend(JSON.parse(s));
    },
    close(code?: number, reason?: string) {
      if (signalWs.data.rtc) closeRtc(signalWs.data.rtc);
      try {
        signalWs.close(code ?? 1000, reason ?? "");
      } catch {}
    },
    get remoteAddr() {
      return data.remoteAddr;
    },
  };
  const sock = rtcSock as unknown as Sock;

  /* Call-mode voice: bind the Opus media bridge to this client. The reciprocated
   * track may already be here (onTrack fires before onDataChannel in
   * libdatachannel's sequence) or arrive right after; subscribe both ways. The
   * bridge starts MUTED and only carries audio once the fp exchange opens its
   * gate. A DC-only offer never yields a track and this stays null. */
  const attach = (track: any) => {
    if (data.audio) return;
    /* DIAGNOSTIC: an audio-path throw must never tear down the transport, so
     * a failure here is logged and swallowed (the client just has no audio). */
    try {
      data.audio = new AudioBridge(track, {
        seal: (frame) => send(sock, frame),
        log: (event, fields) => D().log(event, { client: `c${data.cid}`, ...fields }),
      });
    } catch (e) {
      console.error(`[rtc] callback-threw cb=audio-attach client=c${data.cid} err=${(e as Error)?.stack ?? String(e)}`);
    }
  };
  const attempt = signalWs.data.rtc;
  if (attempt) {
    if (attempt.track) attach(attempt.track);
    else attempt.onAudioTrack = attach;
  }

  const sec = new EngineSecConn(
    D().e2e, D().engineUser, D().engineHost, "rtc",
    (frame) => pipe.send(JSON.stringify(frame)),
    () => {
      clients.add(sock);
      onPresenceChange();
      sendHelloBurst(sock);
      D().log("client.open", { client: `c${data.cid}`, clients: clients.size, transport: "rtc", sec: true,
        dev: sec.devFp ?? undefined });
      /* The fingerprint binding. Once the sealed channel is
       * up, tell the app the DTLS fps this engine sees -- its own (from the
       * answer SDP) and the app's (from remoteFingerprint). The app checks them
       * against what it saw in signaling and replies with its own view; the
       * {t:"fp"} handler opens the audio gate on a match. Only when there is a
       * media track to gate. */
      if (data.audio && attempt) {
        const fp = fingerprintsOf(attempt);
        data.fpLocal = fp.local;
        data.fpRemote = fp.remote;
        send(sock, { t: "fp", local: fp.local, remote: fp.remote });
      }
    },
    (inner) => void dispatchClientFrame(sock, inner),
    (code, reason) => {
      closeClient(sock);
      try {
        pipe.close(code, reason);
      } catch {}
    },
  );
  data.sec = sec;
  // The sealed tunnel: chunked {t:"res"} answers drain against this pipe's buffer.
  data.pipeDrain = () => pipe.drain();
  let __rx = 0;
  pipe.onmessage = (raw) => {
    if (__rx++ === 0) D().log("rtc.rx.first", { client: `c${data.cid}`,
      bytes: typeof raw === "string" ? raw.length : (raw as ArrayBuffer)?.byteLength ?? 0,
      head: typeof raw === "string" ? raw.slice(0, 30) : "binary" });
    void sec.feed(raw);
  };
  pipe.onclose = () => {
    sec.markClosed();
    data.audio?.close();
    data.audio = null;
    closeClient(sock);
  };
}

