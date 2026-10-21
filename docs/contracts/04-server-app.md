# 04. Server <> app

## Purpose and transport

The user's own app-server serves the PWA, bootstrap config, settings, reports,
push subscriptions and the blind sealed data relay. Deploy on localhost or
expose its origin with Tailscale HTTPS. The app uses same-origin fetches and
one long-lived `/device` WebSocket per engine connection.

Normative: `server/src/bootstrap/server.ts`, `routes/*`, `delivery/relay.ts`
and the app's `contract.ts` / `client.ts`. Default app-server port is 10100.

## `GET /config`

- `engines`: live announce leases `{url, engineId, host, user}`. The app uses
  engine IDs to match pairing links and keeps URL identities stable.
- `auth`: always `"none"`. Retained Clerk setup modules are dormant; no
  shipped boot/config path enables login.
- `voice`, `voiceLabel`, `voiceBases`: discovery metadata. Browser voice
  traffic actually goes through the engine's sealed channel (contract 01).

The app caches config in localStorage for offline startup. It derives
`ws(s)://<page-origin>/device?engine=<id>`, not a second public engine port.

## `/device?engine=<engineId>`

The relay sends `r-challenge {nonce}`; the device answers `r-auth {spki,
sig}`. The relay forwards the proof in `r-open` to the engine. Only the
engine's `r-accept` permits `r-ok`; rejection closes the socket (4401).
Unknown/offline engine legs close 4404. The engine may admit an unknown
device to the pairing lane, but sealed enrolment still requires the live
pairing-key proof (contract 06).

After `r-ok`, `hello {sec}`, the sealed handshake and encrypted data all use
the same socket. The server forwards opaque strings inside engine-leg `r`
envelopes. Full wire, limits and cleanup: [05-websocket.md](05-websocket.md).

## Push and other routes

`GET /push/key` returns the VAPID public key. Device routes include
`POST /push/subscribe {subscription, label, deviceId, test?}`,
`/push/unsubscribe`, `/push/devices`, `/push/read {sessionId}`,
`/push/shown` and `/push/test`. One local store holds subscriptions and
settings; encrypted previews remain unreadable to the server (contract 07).

Also: `/clientlog`, `/report`, `/reports`, `/settings`, `/hosts`, `/voice`,
`/health` and static dist. The request body allowance is 320 MiB. Host and
browser Origin gates run before routes and upgrades. These are trusted-local
management APIs, not a public multi-user service.

## Failure semantics

- Server down: cached UI can cold-start offline, but all active relay
  connections close. New browser connections wait for the server and engine
  outbound link to return. The sync manager retries; reconnect handshakes
  afresh and reattaches. Notifications also stop until service returns.
- VAPID identity is generated and persisted unless explicitly supplied; an
  ordinary reinstall must preserve it and the subscriptions it identifies.

## Security invariants

- The server sees routing IDs, public dial proofs, ciphertext and traffic
  metadata, not chat, file or audio plaintext. It stores no E2E content keys.
- Pairing keys ride only in URL fragments, never HTTP requests or logs.
- Client logs stay on this deployment; reports are explicit submissions.
- Keep this origin on localhost or the tailnet. Dormant Clerk code is not
  a substitute for that deployment boundary.
