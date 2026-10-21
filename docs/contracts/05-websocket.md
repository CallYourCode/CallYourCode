# 05. Sealed WebSocket transport

## Purpose and topology

The app connects to the user's own app-server, locally or over Tailscale.
The app-server is a blind, load-bearing data relay, not a key holder:

```text
PWA -> same-origin /device?engine=<engineId>
    -> app-server -> outbound engine /engine?engine=<engineId>
    -> sealed client -> engine dispatch
```

Normative sources:
- `engine/shared/ws-pipe.ts`: Pipe, WS adapter and byte bounds.
- `server/src/delivery/relay.ts`: routing, authentication deadline and limits.
- `engine/agent-engine/src/transport/relay.ts`: outbound link and multiplexing.
- `engine/agent-engine/src/transport/client-glue.ts`: sealed client lifecycle.
- `app/src/engine/client.ts`: browser dial, handshake and reconnect.

The engine's loopback `/ws` is reserved for local MCP/session registration.
It is not a browser data path. Persisted engine URLs remain stable identities;
the browser derives the relay URL from the page origin and engine ID.

## Authentication and envelopes

1. The engine signs enrolment (contract 03), receives a `cyt_` token, and
   authenticates `/engine` with `Authorization: Bearer <token>`. The query's
   engine ID must match the token's engine ID.
2. A device opens `/device?engine=<engineId>`. The relay sends
   `r-challenge {nonce}`. The device answers `r-auth {spki, sig}` with a
   signature over `nonce|engineId|cyc-relay-auth-v1`.
3. The relay forwards `r-open {c, auth:{nonce, spki, sig}}` to the engine.
   The engine verifies the proof: known devices are admitted, unknown devices
   may enter the pairing lane, revoked devices are refused.
4. The engine sends `r-accept {c}` or `r-reject {c}`. Acceptance produces
   `r-ok` on the device leg; rejection closes it with 4401.
5. The device now sends `hello {sec}` on the same socket. Contract 06's
   unchanged sealed handshake authenticates identities and requires a live
   pairing-key proof for enrolment. Relay admission alone grants no data access.

After admission, each device message is one opaque string. On the shared
engine leg it is wrapped as `{t:"r", c, f:"<opaque string>"}` in either
direction. The relay parses routing envelopes, not their content. `r-close
{c, code}` tears down one logical connection.

## Framing and backpressure, as built

There is one logical string per WS message, without application fragmentation.
`MSG_MAX` is 16 MiB in UTF-8 bytes. The engine envelope allowance is
`ENVELOPE_MAX = 6 * MSG_MAX + 1024`, accounting for JSON escaping. Socket
queues are bounded by `QUEUE_MAX = ENVELOPE_MAX + 1 MiB`.

The WS adapter's `drain()` waits until `bufferedAmount <= 256 KiB`, polling
at 10 ms while backpressured. The engine multiplexed Pipe drains against the
shared socket. The sealed writer keeps control/bulk scheduling above this
layer; the HTTP tunnel retains 256 KiB chunks, streaming, aborts and spool
files. Ciphertext order must not change after sealing.

The relay checks downstream queued bytes before writing. Bun's queued write
result is accepted once, never retried; a dropped write closes the socket.
Congestion past the bound disconnects rather than buffering without limit.
There is no credit protocol in the current runtime.

Additional bounds: 32 device legs per engine, 30 opens per engine per fixed
60-second window, 15 seconds to authenticate, and 16 KiB for pre-auth device
frames. Each engine's window starts at its first open and resets on the first
open at least 60 seconds later. This is not a rolling limit: opens clustered
around a reset can exceed 30 within a rolling minute.
Authenticated connections have no fixed lifetime or frame-count cutoff;
server WS `idleTimeout` is zero. The sealed client also bounds its pending
reader to 1024 frames / 32 MiB and its handshake to 15 seconds.

## Lifecycle and failure semantics

- Device close sends `r-close` to the engine. Engine-leg loss closes all its
  device legs (4404); a newer engine socket supersedes the old one (4409).
- App-server restart interrupts active chats, terminals, STT and tunnels.
  Engine local sessions keep running, but browsers cannot sync until the
  app-server and outbound engine link return.
- Client cleanup is guarded once: `EngineSecConn.markClosed`, terminal release,
  STT cleanup and tunnel abort run via `closeClient`.
- The engine redials with exponential backoff (5 to 60 seconds plus jitter).
  The app uses its sync-manager backoff, ping/pong and foreground verification.
  Reconnect performs a fresh sealed handshake and reattaches normally; dead
  connection counters are never resumed. Durable sends retry with their cid.
- Binary messages, oversize frames, queue overflow and invalid sealed frames
  close the connection. There is no plaintext content fallback.

## Voice and trust

Mic capture remains mono 16 kHz Float32 PCM in sealed `stt-*` frames, with
batch voice-note fallback. Growing MP3 replies travel through the sealed
request tunnel. Voice uses the same Pipe, not a separate browser socket.

TLS on a Tailscale HTTPS origin protects the network hop; contract 06's seal
protects end-to-end content from the relay. The app-server sees routing IDs,
public-key dial proofs, opaque ciphertext and traffic sizes/timing, not chat,
file or audio plaintext. Keep the pairing key out of server requests and logs.
