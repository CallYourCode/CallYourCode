# The CallYourCode test suites

After the test-trim, the Playwright end-to-end tests are a small core. Two
directories, three configs, and no `testMatch` anywhere: a spec is in exactly
one suite, decided by which directory it lives in.

## The suites

### `offline/` -- the hermetic core (default)

Four specs that need none of the user's live stack and must never reach it. They
run against a static server for the built bundle (`dist`, served at `/`), so
there is no engine to lease and nothing machine-specific to pin.

- `bootgate.spec.ts` -- the app boots and the list, toolbar and composer render.
- `contract-render.spec.ts` -- a chat window paints from the page contract:
  local-first paint, backfill that holds the view, no-op notifies touch nothing.
- `seal-window.spec.ts` -- no app frame ever hits the pipe unsealed, including
  mid-handshake and on reconnect (the sealed-wire / CSP guarantee).
- `pairing-screen.spec.ts` -- the pairing screen: cold-open copy, `#pair`
  arrival, and the scanned-URL parser.

Run it (this is also the default config):

    npx playwright test

The config serves `dist` itself, so the bundle must be built first
(`bash scripts/build-cyc.sh`) or the config throws a one-line "bundle not built"
error. It runs chromium only.

### `gate/` -- the happy-path gate against a real app server

`happy.spec.ts` is five journeys (J1-J5: open-with-unread, queued send, a
settings write that survives reload, session switch, next-agent jump) run
against a SCRATCH real app server that the runner starts and owns. There is no
static server here on purpose: the page must talk to the real `/config` and
`/settings`.

    CYC_PAGE=http://127.0.0.1:<port> npm run test:playwright:gate

The spec refuses to run without `CYC_PAGE`, or against a live/offline-rig port.

## The guard (`offline/guard.ts`)

The offline config's reporter, so a green run can be believed. It fails the run
if the collected count is not `FLOOR` (in either direction) or if a test skipped
without being named in `KNOWN_SKIPS`. After the trim, `FLOOR = 15` and
`KNOWN_SKIPS` is empty (the correct state). Narrowed runs (`-g`, a single file)
are exempt. `guard-common.ts` holds the argv parsing it shares with nothing else
now, kept as its own module.

## Screenshots

Two kinds, one flag. `toHaveScreenshot` baselines live in `<spec>-snapshots/`
and a normal run compares against them. Evidence PNGs under `screenshots/` (a
state a spec proved, recorded for a human) go through `rig.ts` `evidenceShot()`:
a normal run writes them under `test-results/` and attaches them to the report,
never into the tree. Both change only under `--update-snapshots`; narrow the run
to the spec you mean to refresh (`npx playwright test transfer-resume -u`). Two
consecutive full runs leave `git status --porcelain e2e` empty.

## Shared helpers

- `offline/rig.ts` -- boots the page against the static bundle, isolation,
  key seeding, fixtures.
- `offline/engine.ts` -- a fake sealed engine over the DataChannel wire.
- `offline/wsshim.ts` -- a WebSocket stand-in for `RTCPeerConnection` so specs
  can carry frames without real RTC.
- `gate/gaterig.ts` -- the gate's engine harness.
