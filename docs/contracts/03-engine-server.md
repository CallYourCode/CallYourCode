# 03. Engine <> server

## Purpose and topology

The engine reaches the user's local or Tailscale app-server for signed
identity enrolment, discovery leases, settings, encrypted push delivery and
one outbound data-relay WebSocket. The app-server is load-bearing for browser
connections, but holds no content keys and cannot decrypt payloads.

Parties: `terminal/announce.ts`, `security/enroll.ts`, `chat/notify.ts`,
`transport/relay.ts` in the engine; `routes/engines.ts`, `routes/push.ts`,
`bootstrap/server.ts` and `delivery/relay.ts` in the server.
`APP_SERVER_URL` defaults to `http://127.0.0.1:10100`.

## Enrolment (normative: `engine/shared/enroll-wire.ts`)

The engine signs `cyc-enroll-v1\n<engineId>\n<spki>\n<ts>` with its ECDSA
identity and POSTs `/engines/enroll {engineId, pubkey, ts, sig}`. The server
checks the signature and `ENROLL_SKEW_MS` (10 minutes), then issues an opaque
per-engine `cyt_` token. Re-enrolment with a different identity key is refused.
There is one local store, no account chooser or remote onboarding service.

`GET /engines/enrolled` lists records; `POST /engines/revoke {engineId,
restore?}` revokes or restores one. These are trusted-deployment management
routes, protected by the server Host/Origin gates, not a login boundary.

## Announce and settings

On boot and heartbeat the engine POSTs `/engines/announce {engineId, host,
user, url, rev, ts}`, bearing its issued token. The body's engine ID must
match the token (403 otherwise). `lastSeen` is the server's clock. `/engines`
and `/config` serve leased entries; expired leases disappear. The app tests
liveness by connecting. Existing engine URLs remain persisted identities.

The engine polls `/settings` using its token when available, bare otherwise.
It writes `state/app-server-url` so `cyc pair` can print the deployment's link
from an environment-less shell.

## Relay (normative: contract [05](05-websocket.md))

The engine dials `/engine?engine=<engineId>` with its issued bearer token,
including on localhost. The upgrade binds the socket to that engine ID.

Inbound `r-open {c, auth:{nonce, spki, sig}}` carries the device-key dial
proof. The engine verifies `nonce|engineId|cyc-relay-auth-v1` against its
device state: enrolled devices admitted, unknown devices through the pairing
lane, revoked devices refused. `r-accept` / `r-reject` return the verdict.
Both directions carry `{t:"r", c, f:"<opaque string>"}` and `r-close`.

After acceptance, contract 06's handshake and all sealed application traffic
continue over this same relay connection. A relay loss closes clients;
there is no detached browser path.

## Push

`/push/notify` and `/push/batch` accept sealed items with the engine token.
Contract 07 owns shapes, batching, truncation and drop acknowledgement.
The engine never receives browser subscriptions or VAPID private keys.

## Failure semantics

- Without a reachable app-server, local agent sessions still run, but browser
  sync and notifications cannot work.
- 401 drops the stored token; the announce tick re-enrols with a 30s retry
  backoff. A relay 4401 invokes the same auth-rejection path.
- Relay retry uses 5 to 60 seconds exponential backoff plus jitter. Replacing
  an engine socket closes its clients, not their underlying terminal sessions.

## Security invariants

- A token speaks only for its engine ID; it is not a content-decryption key.
- The pairing/content key never rides these HTTP calls or relay envelopes
  except encrypted inside the end-to-end handshake.
- Engine identity private keys remain in `keys.json` (0600, atomic).
- The app-server must be exposed only locally or on the user's tailnet.
