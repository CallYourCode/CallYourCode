# agent-engine

The agent engine: one process per host, the only process that knows what a
"session" is. It discovers agent panes from a terminal multiplexer, holds each
session's chat log, seals the transport to paired devices, delivers what an agent
says out to the page, and feeds what you say back into the pane as input. Speech
itself lives in the separate voice engine; this process calls it for TTS and STT
and tells browsers where it is.

Entry point: `src/runtime/server.ts` (`bun run start`). Its header names the wire
protocol and the routing rules; the boot sequence is documented at
`src/runtime/server.ts:100`.

## Process layout

- Listens on ONE port, bound in `src/runtime/server.ts:1167` via `Bun.serve`:
  `AGENT_PORT` (default `10101`) on `AGENT_HOST` (default `127.0.0.1`), from
  `src/runtime/server.ts:140`.
- Sessions come from a multiplexer, not from a register frame: every agent pane
  is a session (id = pane id). The default mux is tmux; `CYC_MUX=herdr` opts
  into the herdr upgrade (`src/routes/session-ops.ts:58`, adapters in
  `src/adapters/`).
- Calls the voice engine over HTTP for TTS and STT at `VOICE_URL` (default
  `http://127.0.0.1:10102`, `src/voice/voice-proxy.ts:17`).
- Dials the app server for device discovery (announce) and for the blind
  signaling relay, so a phone off the LAN still reaches this engine
  (`src/terminal/announce.ts`, `src/transport/relay.ts`).
- Persists to a data dir (`CYC_DATA_DIR`, else the platform default in
  `../shared/cycdir.ts`): the E2E key file `keys.json`, upload staging, and logs.
  Chat log, session registry and TTS cache are in memory.

## Ports actually bound

This process binds exactly one listener:

| Port | Env | Where |
|---|---|---|
| `10101` | `AGENT_PORT` / `AGENT_HOST` | `src/runtime/server.ts:140`, `:1167` |

The `10102` (voice engine) and `10100` (app server) it talks to are bound by
those other processes, not here.

## Environment

Operationally significant variables actually read (grep `process.env`):

| Env | Default | Read at |
|---|---|---|
| `AGENT_PORT` | `10101` | `src/runtime/server.ts:140` |
| `AGENT_HOST` | `127.0.0.1` | `src/runtime/server.ts:141` |
| `VOICE_URL` | `http://127.0.0.1:10102` (comma-list allowed, preferred first) | `src/voice/voice-proxy.ts:17` |
| `VOICE_PUBLIC_URL` | (empty; vestigial: rides the `voice` frame but the app reads only `healthy`) | `src/runtime/server.ts:165` |
| `APP_SERVER_URL` | `http://127.0.0.1:10100` | `src/terminal/announce.ts:68`, `src/security/pairkey.ts:70` |
| `ENGINE_WS_URL` | derived from `APP_SERVER_URL` | `src/terminal/announce.ts:70` |
| `ENGINE_PUBLIC_URL` | (empty) | `src/runtime/server.ts:171` |
| `ENGINE_HOST` | `hostname()` | `src/runtime/server.ts:176` |
| `RELAY_URL` | derived from `APP_SERVER_URL` | `src/runtime/server.ts:286` |
| `CYC_CLOUD_URL` | the hosted app url | `src/security/pairkey.ts:53` |
| `CYC_MUX` | `tmux` (`herdr` opts into the herdr upgrade) | `src/routes/session-ops.ts:58` |
| `HERDR_SOCKET_PATH` | `~/.config/herdr/herdr.sock` | `src/terminal/herdr.ts:108` |
| `CYC_DATA_DIR` | platform default | `../shared/cycdir.ts:26` |
| `CYC_PIAGENT_ADAPTER` | unset (off) | `src/runtime/server.ts` (gates the optional piagent adapter) |
| `HOME` | (the OS home) | resolves the data dir and mux socket paths |

Beyond these, many modules read `*_MS` timing knobs and test-only overrides
(for example `NOTIFY_*`, `DELIVER_*`, `CYC_LIMITS_*`, `CYC_LOCK_*`,
`CYC_SERVICES_*`); grep `process.env` across `src/` for the full set. They have
production defaults and are not needed to run the engine.

## HTTP surface

Routes are grouped under `src/routes/` and dispatched from
`src/runtime/server.ts`. The paths this process answers:

- `GET /health` (`src/routes/health.ts`), `GET /agents`, `GET /`
- `POST /agent/reply`, `POST /agent/info` (the MCP output/identity calls)
- `POST /new-session`, `GET /new-session/places`, `/session/...`
  (`/rename`, `/photo`, `/agent-message`, `/restart`, `/exit`, `/transfer`,
  `/trim-log`, `/unread`), `POST /sessions/order`
- `POST /upload`, `POST /user-audio`, `GET|POST /voice/tts`, `/voice/stt`,
  `/voice/voices`, `/voices/default`, `/voice-log`
- `POST /harness/announce`, `GET /settings`, `/services/...`
- `GET /ws` (the one WebSocket): a connection elects its role in its first
  frame; local signaling and the sealed client transports ride it
  (`src/transport/frames.ts`, `src/transport/wire.ts`).

Localhost callers pass the local/owner gates for free (`isTrustedLocal`,
`requireLocal`, `requireOwner` in `src/transport/httpx.ts`).

## src directory map

- `runtime/`: boot and composition (`server.ts`), the route dispatch, agent
  metadata, model selection, voice model warmup, the MCP glue, service leases.
- `routes/`: the HTTP surface, one family per file (`health`, `chat`, `voice`,
  `media`, `session-ops`, `transfer`, `plugin`, `ctx`).
- `transport/`: the sealed transports and framing: `rtc.ts`, `rtc-glue.ts`,
  `dcpipe.ts` (DataChannel fragmentation), `relay.ts` (outbound relay leg),
  `tunnel.ts`, `frames.ts`, `wire.ts`, `sock.ts`, `httpx.ts`.
- `security/`: the engine key model and sealed handshake (`sec.ts`), enrolment
  (`enroll.ts`), pairing (`pair.ts`, `pairkey.ts`), sealed push (`sealpush.ts`).
- `sessions/`: the session registry and lifecycle: `session-state.ts`,
  `session-events.ts`, `reconcile.ts`, `presence.ts`, `title.ts`, `journey.ts`.
- `chat/`: the chat log, delivery and notifications: `chatlog.ts`, `deliver.ts`,
  `pane-deliver.ts`, `reply.ts`, `notify.ts`, `show-handler.ts`, `uploads.ts`,
  `clips.ts`, `asks.ts`.
- `voice/`: TTS/STT proxying and audio: `voice-proxy.ts`, `tts.ts`,
  `transcribe.ts`, `voicemodels.ts`, `opus.ts`, `rtp.ts`, `audiopcm.ts`.
- `terminal/`: the mux and terminal glue: `herdr.ts`, `tmux.ts`, `mux.ts`,
  `announce.ts`, `discovery.ts`, `restart.ts`.
- `adapters/`: the mux adapter seam (`factory.ts`, `mux-adapter.ts`,
  `tmux-adapter.ts`) and the optional `piagent.ts`.
- `readers/`: per-harness run readers (`claude.ts`, `codex.ts`, `opencode.ts`).
- `plugins/`: the plugin platform and the shipped plugins (crons, files, git,
  usage-card, and more).
- `storage/`: the data dir, files, and usage limits (`datadir.ts`, `files.ts`,
  `limits.ts`).
- `test-utils/`, `e2e/`, `fixtures/`: the test rig, the specs that boot a real
  engine, and captured pane fixtures.

## Run and test

From this directory (scripts are `package.json`):

```sh
bun run start        # bun run src/runtime/server.ts
bun run test         # unit and seam; parallel; no engine boots
bun run test:e2e     # the specs that boot a real engine
bun run typecheck    # tsc against tsconfig.check.json and tsconfig.tests.json
bun run pair-key     # bun run src/security/pairkey.ts
```

See `src/fixtures/README.md` for the pane-capture fixtures the tests read.
