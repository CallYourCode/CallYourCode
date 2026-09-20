# 05. WebRTC transport

## Purpose

"It works on webrtc" (PRODUCT.md): one peer-to-peer DataChannel between app
and engine carries the whole product, so the data path needs no company server
even across NATs; the app server only matchmakes. The transport survives the
server dying and never falls back to anything unsealed.

## Parties and transport

- app dialer: `app/src/engine/rtc.ts` (RtcDial over a Signal), signaling via
  the app server's `/device` leg (contract 04).
- engine answerer: `engine/agent-engine/src/transport/rtc.ts` (werift, pure-TS
  WebRTC) fed either by a direct signaling WS at the engine origin
  (`transport/frames.ts` role "signal") or by the relay leg (contract 03).
- framing: `engine/shared/dcpipe.ts` (imported by the engine via the
  `transport/dcpipe.ts` re-export and by the app), pinned by
  `engine/shared/fixtures/dcpipe-vectors.json`.

## Signaling frames (verbatim, forwarded blind by the relay)

- app -> engine: `rtc-offer {id, sdp}` (always the app offers),
  `rtc-cand {id, cand|null}` (null = end of candidates), `rtc-abort {id}`.
- engine -> app: `rtc-answer {id, sdp}`, `rtc-cand`,
  `rtc-fail {id, reason: "bad-offer"|"answer-failed"|"timeout"}`.

The answer is sent BEFORE any candidate; candidates trickle. Both sides queue
candidates that race the remote description.

## The channel

Label `cyc`, `negotiated: true, id: 0, ordered: true`, created by BOTH ends;
the engine also accepts an in-band (DCEP) `cyc` channel. The pipe is minted
exactly once per attempt when the channel opens. Timeouts: 10s on both ends
(`DIAL_MS` / `RTC_OPEN_MS`); `rtc-fail {reason:"timeout"}` closes the attempt.

## Candidate policy (`rtc.ts` header)

The engine gathers everywhere but ADVERTISES only 127.0.0.1 plus the address
the page reached it on; on the relay path (`advertiseAll`) everything flows,
STUN/TURN included. Third-party interfaces (docker bridges, other LANs) are
never offered. ICE servers come from `/config` (app) and `r-open` (engine),
the same list both ends (`bootstrap/server.ts rtcFor`).

## Lifecycle

Once the pipe opens, the app closes the signaling WS (`close(1000,
"upgraded")`); a signaling WS closing BEFORE open tears the attempt down;
after open the pipe stands alone. On the direct path the signaling WS close is
the sub-second "engine restarted / tab gone" signal and DOES tear the
DataChannel down with it (`frames.ts` close handler).

## Framing (normative: `dcpipe.ts` + vectors)

Strings fragmented into `FRAG_MAX` (16KB) DataChannel writes, reassembled to
whole messages, `MSG_MAX` 16MB per side, backpressure via bufferedAmountLow
(`pipe.drain()`), close codes carried through. Everything above sees
`send(string)` / `onmessage(string)`. A change to the codec requires new
frozen vectors, by construction.

## Media (dormant)

The dial reserves an m=audio shape (`RtcDial withAudio`, AudioChannel, DTLS fp
binding, engine AudioBridge) but BOTH ends run data-only: the app passes
`withAudio=false` (`client.ts`) and the engine's werift path never
reciprocates a track (`rtc.ts`, `track` stays null). The sealed `fp` frame
gate (contracts 01, 06) is the required binding if this lane is ever lit.

## Failure semantics

- Any dial failure (`no-webrtc`, `offer-failed`, `bad-answer`, `ice-failed`,
  `signal-closed`, `timeout`, engine `rtc-fail`) is a plain disconnect: there
  is NO WS-data fallback (`client.ts`), the sync manager backs off and
  redials.
- werift import failure at engine boot: the engine still runs (MCP, schedules,
  sessions); no client can connect and the log says so loudly.
- Connection-state failed/closed after open closes the pipe with its code; the
  app redelivers unacked sends (contract 02).

## Security invariants

- The DataChannel is transport, not trust: everything on it is opened by the
  sec handshake (contract 06); a peer that can open a channel has proven
  nothing yet, and malformed pre-handshake bytes are dropped, not thrown
  (`sec.ts feed`).
- DTLS protects the hop, the sealed layer protects end-to-end; a TURN relay is
  assumed on-path and untrusted.
- Signaling servers see SDP and candidates only, never a content byte.
