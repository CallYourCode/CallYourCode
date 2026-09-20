# 03. Engine <> server

## Purpose

"The server is only for notifications and login and engine discovery"
(PRODUCT.md). The engine reaches OUT to the app server for exactly three
things: enrolling its identity for a token, announcing its address into the
discovery lease list, and posting sealed push items. Plus one outbound socket
so signaling can reach an engine behind NAT. The server is never the transport
and never sees content.

## Parties and transport

- engine: `terminal/announce.ts` (+ `terminal/discovery.ts`,
  `security/enroll.ts`) dials `APP_SERVER_URL` (default
  `http://127.0.0.1:10100`); `transport/relay.ts` holds ONE outbound WS to
  `<app-server>/engine`.
- server: `server/src/routes/engines.ts`, `routes/push.ts`,
  `bootstrap/server.ts` (/engine upgrade), `delivery/relay.ts`.

## Enrollment (normative: `engine/shared/enroll-wire.ts`)

The engine signs the canonical string `cyc-enroll-v1\n<engineId>\n<spki>\n<ts>`
with its ECDSA identity key and POSTs
`/engines/enroll {engineId, pubkey, ts, sig}`. The server verifies the
signature, bounds `ts` by `ENROLL_SKEW_MS` (10 min), and answers a per-engine
opaque `cyt_` token. HOSTED additionally requires WHO: a one-time `cyg_`
onboarding grant (redeemed exactly once, signature checked first) or the
owner's Clerk session; the owner is the verified sub, never a body claim.
LOCAL enrolls open on the trusted network as owner "local". A re-enroll for
the same engineId under a different key or owner is refused.

Tokens are opaque. `/engines/verify` is a possession-proof introspection that
trades a token for `{ok, engineId, owner}`.

## Announce

On boot and every heartbeat the engine POSTs
`/engines/announce {engineId, host, user, url, rev, ts}` with
`Authorization: Bearer cyt_`. The body's engineId must equal the token's
(403 "engine mismatch"); the lease owner is the token's owner in HOSTED;
`lastSeen` is the SERVER's clock, never the engine's ts. The lease list is
what `/engines` and `/config` serve; a lapsed lease drops silently. The app,
not the server, decides online/offline by connecting. Batch push replies name
`truncated` and `dropped` so an engine can requeue instead of trusting a bare
200.

## Push

`/push/notify` and `/push/batch`, Bearer cyt_, sealed items (contract 07 owns
the shapes and batching rules).

## Relay leg (normative: the `transport/relay.ts` header)

The engine holds one outbound WS to `/engine` (HOSTED: authed by the cyt_
bearer, introspected in-process; LOCAL: `?engine=<id>` open). Down it the
server forwards each device leg inside its envelope:
- in `{t:"r-open", c, rtc:{iceServers}, auth?}` / `{t:"r", c, f:"<frame
  string>"}` / both `{t:"r-close", c, code}`;
- out `{t:"r"}` answers and `r-accept` / `r-reject` verdicts.

The engine, not the relay, verifies the device-key dial proof carried in
`r-open.auth` (`sec.ts verifyRelayAuth`: signature over
`nonce | engineId | "cyc-relay-auth-v1"` (`RELAY_AUTH_CONTEXT`); enrolled
devices always admitted, unknown keys through a pairing lane, revoked
refused). A conn dying before the DataChannel opened tears the attempt down;
after, the pipe stands alone, so chats survive server restarts.

## Settings poll

The engine reads `/settings`, bearing its token when it has one and polling
bare otherwise (`chat/notify.ts`, `announce.ts peekToken`), so a local
tokenless engine is never forced to enroll.

## Failure semantics

- No APP_SERVER_URL: announce and push are no-ops; the engine boots and serves
  regardless. The server is never load-bearing for a local session.
- 401 anywhere drops the stored token; the next tick re-enrolls, with a
  `ENROLL_RETRY_MS` (30s) backoff, so a wiped server store self-heals.
- The relay WS redials with jittered exponential backoff
  (`RELAY_BACKOFF_MIN_MS` 5s .. `RELAY_BACKOFF_MAX_MS` 60s); a relay refusal
  (close 4401) drops the token via `onAuthReject`.
- The engine writes `state/app-server-url` at boot so `cyc pair` prints a
  phone-reachable link even from an env-less ssh shell.

## Security invariants

- The engine never holds a Clerk credential; the page mints the one-time grant
  and the engine trades it plus its signed identity (`pairkey.ts` cloud flow).
- A token speaks only for its own engineId and owner; cross-owner announce or
  push is impossible by the token->owner map (`enroll.ts`).
- The E2E pairing key NEVER rides any of these calls; nothing on this boundary
  can decrypt content or push previews.
- Engine identity private keys never leave `keys.json` (0600, atomic).
