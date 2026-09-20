# 02. Engine <> app (the sealed client wire)

## Purpose

The app is an offline-first chat surface over the user's own agents
(PRODUCT.md sections 3 and 4): one sealed end-to-end encrypted channel
carries everything (chat, voice, sessions, terminal, plugins, files), sends
are durable intents that never lie about delivery, and the engine exposes its
OWN stable ids so harness churn never breaks the conversation.

## Parties and transport

- engine: `engine/agent-engine/src/runtime/server.ts` (:10101). The WS at the
  engine origin is SIGNALING-ONLY; a plaintext `hello` there is refused with
  `transport-required` and close 4426 (`transport/frames.ts`).
- app: `app/src/engine/client.ts` (WsEngineClient). All data frames ride the
  WebRTC DataChannel `cyc` (contract 05) sealed by the v2 handshake
  (contract 06). One dispatcher serves each end whatever pipe carried it:
  engine `dispatchClientFrame` (`transport/frames.ts`), app `dispatchFrame`
  (`app/src/engine/frames/`).

## Contract

Shapes are normative in `app/src/engine/contract.ts` (EngineSession,
EngineChatMessage, EnginePage, EngineAttachOk, EngineAck, EngineSendFailed,
EngineEvents, EngineClient) and the engine's frame producers
(`sessions/sessions-frame.ts`, `chat/*`).

### App -> engine client frames (`frames.ts dispatchClientFrame`)

`visible {on}`, `ping {n}` / `pong`, `heard {id, msgId}`,
`attach {id, have?}`, `progress {id, seq, explicit?}`,
`utterance {id, text, origin, cid, kind?, msgId?, durationS?, upload(s)?,
words?, partials?}`, `interrupt {id}`, `compact {id}`,
`answer {id, fingerprint, choice}`, `session-tail {id, on}`,
`term-open/resize/input/scroll/close`, `req` / `req-abort` (the tunnel),
`fp`, `voice-ctl`, `stt-open/stt-b/stt-close` (contract 01).

`utterance.partials` is `[{id, text, upToS}]`: the words the device's
streaming decoder already SETTLED for a recording and how far into the audio
they reach (seconds). On a marker send (`words`) the id names the uploadId;
on an empty-bodied `kind:'voice'` note the id names the frame's own cid (the
msgId is accepted too, a voice note having no uploadId). The engine decodes
only the tail past `upToS` (`/stt?offset=`, contract 01) and prepends the
settled text; the settled words are a floor a shorter or failed decode never
replaces.

### Engine -> app frames

The hello burst first (`sendHelloBurst`): `can {list}`, `plugins {list}`
(only when the engine loaded any), `voice {url, healthy, ready, download?}`,
`host {user, host}`, `sessions {list, tabs?}`. Then event-driven:
`chat`, `attach-ok`, `ack {id, cid, dup, msgId?, err?}`,
`send-failed {id, cid, reason}`, `say` / `say-grow` / `say-done` /
`say-live` / `say-live-fail`, `session-event`, `dequeued`,
`term-frame` / `term-mode` / `term-size` / `term-closed`, `answer-result`,
`compact-result`, `session-id-changed`, `res` (tunnel), `stt-*`, `ping`.

### Attach and pages

A chat is pages of one seq axis (EnginePage: messages + session events).
`attach {have:{tailPage, tailVersion}}` matching the engine's tail answers
`attach-ok` with `pages: []` (metadata only); older pages come via tunneled
`GET /session/<id>/page/<n>`. Rows dedupe by the durable `mid` (`mr-...`),
falling back to ts|role|text when a message carries no mid. `attach-ok` also
carries `queued: number[]` (the ts of every still-queued user row,
authoritative): a dequeue changes no seq, so the tail-version check cannot
see it and a client that missed the live `dequeued` frame reconciles the
strip against this list on every open. A page's seq axis may be SPARSE, so
the back-pager steps one page down per probe regardless of what a page
admits, and an empty sealed page never wedges it.

### Delivery guarantees (PRODUCT.md section 5)

The engine acks every utterance by cid BEFORE delivery work; `dup:true` marks
a re-sent cid; `err` / `send-failed` are definitive refusals that keep the
cid retriable. The app arms a per-cid ack deadline (`store/sends.ts armAck`);
a deadline reached with no ack redelivers the SAME cid (`drain.redeliver`)
and the row stays pending, never failed. A send composed while disconnected
promises nothing. Feature-gated content the app writes into a send (the
`{{cyc-words:<id>}}` marker, transfer routes, reply dials) is emitted only
when `client.can(feature)` says the connected engine announced it; on every
new pipe the app forgets what the last engine could do (`canDo.clear()`).

### Queued strip

A busy pane marks the row `queued`; the engine lifts it the moment the
harness takes the message into context. The consumption signal is the
message's own `user` record landing in the transcript, so the listener
pre-arms before the keystrokes go out (`chat/deliver.ts`) and consumption
often lands mid-type. The post-enter strand check (`adapters/mux-adapter.ts`)
re-reads after a settle before believing a stranded verdict: a busy TUI can
repaint its input box empty slower than the confirm window, and a single read
would false-strand a delivered message and drive a doubling retry.

### Tunneled HTTP

Every content route (`/upload`, `/user-audio`, `/audio/*`, `/doc/*`,
`/session/*/page/*`, `/plugin/*`, `/transfer/*`, `/voice/*`, ...) rides the
sealed channel as `{t:"req"}` -> `{t:"res"}` chunks. The codec is normative
in `engine/shared/tunnel.ts` (imported by the engine via the
`transport/tunnel.ts` re-export and by the app via `@shared/tunnel`), pinned
by `engine/shared/fixtures/tunnel-vectors.json`: `CHUNK` 256KB, meta on the
first frame only, `REASSEMBLE_MAX` 32MB. The engine feeds the same
`routeRequest` localhost uses and marks the request `markSealedTunnel`
(`transport/httpx.ts`), which with true loopback is the ONLY thing
`requireOwner` accepts. No bearer token exists.

### Message roles

Chat `role` is `user` (what the person sent) or `claude` (the agent's own
reply). Machine-delivered input (a cron fire, an agent-to-agent message, a
pane-typed line) reaches the app ONLY as `prompt`/`reply` session events on
the page axis, painted as activity pills; it is never a chat row.

## Capabilities

The `can` list announces engine features; the app checks `client.can(feature)`
before promising them. Unknown frames, unknown fields, and unknown
`EngineSessionEvent.kind` values are ignored or stored un-rendered by design.

## Failure semantics

- Not connected: frames queue app-side (`pending`); latest-wins coalescing
  for `progress` / `visible` / `attach`; `session-tail` is never queued
  (re-armed from state on the next pipe). Sends stay painted, queued, and
  drain in order (contract 10).
- Liveness: 5s check; after 20s inbound silence with a visible attached chat,
  one `ping`; no frame within 10s presumes the pipe dead, redelivers unacked,
  redials via the sync manager's backoff.
- Engine restart: sessions and chat come back from the engine's own store;
  the app re-attaches with `have` on the settled edge; terminal viewers and
  the tail re-arm per pipe (`sendPostHello`).
- Unknown session on attach/term-open: an explicit answer (`known:false`,
  `term-closed {why}`), never silence.

## Security invariants

- No plaintext after `sec`: any non-`x` frame post-handshake closes the
  socket 4400 (`security/sec.ts feed`).
- The terminal viewer opens ONLY onto sessions the engine tracks, never an
  arbitrary pane (`frames.ts onTermOpen` guard).
- The channel is the auth: no header, cookie or token opens any engine route
  from the network; loopback callers must have no `x-forwarded-for`.
- Chat text, audio, files and keys never leave this channel except sealed.
