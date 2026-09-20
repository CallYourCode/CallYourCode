# 07. Notifications

## Purpose

A reply landing while nobody watches must buzz the phone with a REAL preview,
without the server ever being able to read it (PRODUCT.md section 4). The
engine decides WHEN (watched-detection with proof of life), the server decides
HOW MANY (windowing, rate caps, cross-engine merge), the service worker
decrypts WHAT.

## Parties and transport

engine (`chat/notify.ts`, seal: `security/sealpush.ts`) -> POST to the app
server (`server/src/routes/push.ts`, Bearer cyt_) -> Web Push
(`delivery/push.ts`, VAPID) -> the app's service worker
(`app/public/cyc-sw.js`) -> the page (`app/src/engine/pushNotify.ts`).

## Engine -> server items

- `/push/notify {title, body, sessionId, unread?, icon?, tag?, plugin?, kid,
  enc}`: one message. The REAL title/body/count ride ONLY inside `enc`, sealed
  under `deriveSessionKey(newestGen.key, sessionId)` (or the engine-level
  `deriveEngineNotifyKey` for session-less items like the usage alert, with a
  sealed `open` tap target). The plaintext fields carry the generic fallback.
  The wire carries `{kid: newestGen.kid, enc}`.
- `/push/batch {host, new:[items], dismiss:[sessionIds]}`: one 10s
  wall-aligned window's worth. The server does NOT trust engine batching; it
  re-windows on its own aligned clock and merges across engines, because only
  it sees all of one owner's machines.

## Server enforcement (`push.ts`)

Whenever `enc` is present the visible title/body are FORCED to `GENERIC_TITLE`
("CallYourCode") / `GENERIC_BODY` ("New message") before logging or
forwarding; a plaintext preview beside `enc` never reaches a log or a device.
Unread is THE ENGINE'S NUMBER: no fallback counting server-side; a missing
field leaves the badge untouched. Badge = sum of per-session counts across
every host. Rate cap per engine (`PUSH_RATE_MAX`); over-cap messages drop with
`ok:true` (and `dropped:true`) so engines do not retry into the cap. Batches
answer `truncated` (per-batch cap `BATCH_ITEMS_MAX`) + `dropped` (per-minute
rate cap) so the engine requeues what was cut when `truncated + dropped > 0`.

## Worker (`cyc-sw.js`)

A sealed item is opened by `kid`: the worker reads the `cyc-keys` IndexedDB,
derives the session key (info `session:<id>`) or the notify key (info
`notify`), and AES-GCM-opens `enc`; on any failure it shows the generic
fallback, never nothing (a push that renders nothing costs the permission on
iOS). Tap posts `{t:"open-chat", sessionId}` to the page
(`pushNotify.onNotificationOpen`).

## Device side (contract 04)

Subscribe with the VAPID key; `POST /push/read` on opening a chat clears the
banner on OTHER devices through the same outgoing dismiss window (one read =
one dismiss push).

## Engine timing (`notify.ts`)

Notify only when NOT watched, where "watched" requires proof of life (a frame
proves the page's JS ran; a stale `visible` claim does not), a 10s batch
window, and a ten-minute ceiling for a chat that stays unread.

## Failure semantics

- A failed seal sends NOTHING, never plaintext (`sealpush.ts`: a throw is fatal
  for that item; there is no unsealed mode).
- Push endpoints that answer gone are pruned; `test:true` subscriptions are
  quarantined and reaped so e2e runs leave the store clean.
- A device with no stored key for `kid` (never paired, wiped DB) sees the
  generic banner; tapping opens the app which syncs the real message over the
  sealed wire.
- Server down: notifications silently stop; nothing else degrades, and the
  engine's posts are fire-and-forget with the announce token machinery
  handling 401s (contract 03).

## Security invariants

- The server and the push transport (FCM/APNs/Mozilla) see only: generic
  title/body, sessionId, tag, icon URL, counts, and an opaque `enc` blob.
- Preview content is sealed under per-session keys, so handing one session
  over (a future share) never exposes another chat's pushes.
- Logs record lengths and sealedness, never a content byte (`push.ts`).
- The worker holds keys only in the same origin-locked IndexedDB the app uses;
  no key ever rides a push payload.
