# CallYourCode boundary contracts

One document per boundary. Each names the boundary's purpose (traceable to
cyc-builder PRODUCT.md), the parties and transport, the explicit contract with
the real type names and file paths, the failure semantics, and the security
invariants that must hold across it.

Where a code artifact already IS the contract (doc-commented types, a frozen
vector fixture), the document points at it as NORMATIVE and summarizes. On any
disagreement between these documents and a normative source, the normative
source wins and the document is the bug.

| # | boundary | doc | normative source |
|---|----------|-----|------------------|
| 1 | agent engine <> voice engine | [01-engine-voice.md](01-engine-voice.md) | `engine/voice-engine/src/server.ts` header + `gate.ts` |
| 2 | engine <> app (sealed wire) | [02-engine-app.md](02-engine-app.md) | `app/src/engine/contract.ts`, `engine/agent-engine/src/transport/frames.ts` |
| 3 | engine <> server | [03-engine-server.md](03-engine-server.md) | `engine/shared/enroll-wire.ts`, `server/src/routes/engines.ts` |
| 4 | server <> app | [04-server-app.md](04-server-app.md) | `server/src/routes/*.ts` |
| 5 | Sealed WebSocket transport | [05-websocket.md](05-websocket.md) | `engine/shared/ws-pipe.ts`, `server/src/delivery/relay.ts`, `engine/agent-engine/src/transport/relay.ts` |
| 6 | end-to-end encryption | [06-e2ee.md](06-e2ee.md) | `engine/shared/e2e.ts` + `engine/shared/fixtures/e2e-vectors.json` |
| 7 | notifications | [07-notifications.md](07-notifications.md) | `server/src/routes/push.ts`, `engine/agent-engine/src/security/sealpush.ts` |
| 8 | plugins | [08-plugins.md](08-plugins.md) | `engine/agent-engine/src/plugins/platform/spec.ts` |
| 9 | adapters (harness + mux) | [09-adapters.md](09-adapters.md) | `engine/agent-engine/src/readers/types.ts`, `adapters/mux-adapter.ts` |
| 10 | app <> ui | [10-app-ui.md](10-app-ui.md) | `app/src/engine/store.ts`, `app/src/engine/intents.ts` |

## Repo-wide rules every boundary inherits

**Capability is announced, never assumed.** The engine says what it can do in
the hello burst's `can` list (`sessions-frame.ts sendHelloBurst`), and the app
promises nothing (`{{cyc-words:}}` markers, transfer routes, reply dials) to an
engine that did not announce it (`client.can`). Unknown frame types, unknown
fields, and unknown `kind` values are ignored or held un-rendered, never
errors. A new feature is a new frame or a new optional field.

**Sealed wire only.** Everything content-bearing between app and engine rides
the one sealed WebSocket relay channel: chat, sessions, terminal, voice, plugins, files
(tunneled HTTP as `req`/`res` frames). There is no browser content-route bearer token; the
sealed channel is the auth (`transport/httpx.ts`). The engine trusts exactly two
callers: its own host over true loopback, and the sealed tunnel.

**The server is blind.** The local app-server serves the page, discovery, settings,
notifications and the load-bearing data relay. It forwards sealed frames and
push blobs it cannot open. No content key, chat text or audio plaintext
crosses it. App-server loss interrupts browser connections.

**Records match what was measured.** An ack names the exact send (cid); a
refusal says why and stays retriable; unread counts come from the one read
marker the engine holds; nothing asserts a state it did not measure.
