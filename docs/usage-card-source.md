# Conversation usage card source

The engine's `usage-card` plugin defaults to `claude`, retaining the existing
Claude card, all Claude windows, freshness, refresh and alert behavior.
`codex` displays only the **weekly** limit of the active Pi Codex account.
This is a display preference, not an account switch or credential operation.
There are no UI controls or window settings.

## Agent API

Use a standard authorized engine request: on the engine host via its local
socket/loopback transport, or an enrolled device's sealed engine channel.
These commands use the default engine socket; set `CYC_ENGINE_SOCK` to the
actual socket for a custom data directory or offset-port engine.
All RPC operations are POSTs with the existing `{args: ...}` envelope, without
a session. The same engine preference applies to every device and survives
restarts in the plugin's engine-scoped store (`source.json`).

Read the preference:

```sh
curl --unix-socket "${CYC_ENGINE_SOCK:-$HOME/.callyourcode/engine.sock}" -H 'Content-Type: application/json' \
  -d '{"args":{}}' http://localhost/plugin/usage-card/rpc/get-source
```

Show the active Pi Codex weekly limit:

```sh
curl --unix-socket "${CYC_ENGINE_SOCK:-$HOME/.callyourcode/engine.sock}" -H 'Content-Type: application/json' \
  -d '{"args":{"source":"codex"}}' http://localhost/plugin/usage-card/rpc/set-source
```

Show Claude again by replacing `codex` with `claude`. No other source is accepted.
The reply is `{"ok":true,"result":{"source":"codex"}}` (or `claude`).
The existing `GET /plugin/usage-card/card` returns the selected card; ordinary
app polling observes changes without reloading the app. `?refresh=1` retains
the existing refresh floor. Successful RPC invalidates the route's old card
body, and identity changes invalidate both report and dedupe state.

## Codex reader configuration

Prefer an externally maintained, read-only cache:

```sh
CYC_CODEX_USAGE_CACHE=/absolute/path/to/codex-usage-cache.json
```

No cache location is assumed. The active identity comes from
`~/.pi/agent/auth.json`, `openai-codex.accountId` and the access JWT's email,
not the CLI `~/.codex` symlink. `CYC_PI_AUTH_FILE` optionally overrides the Pi
auth path (useful for isolated tests).

Cache schema: `{ts, accounts:[{accountId?, email, acct?, plan?, fetchedAt?,
windows:[{used_percent, limit_window_seconds, reset_at}], error?}]}`.
Timestamps are Unix seconds. Match exact accountId first, then legacy email
only for entries without accountId. Ambiguous/unmatched entries fail closed.
Per-account `fetchedAt` is preferred; legacy account `ts` or root `ts` is the
fallback. Original timestamps date the card, not the time we read the file.
Expired (15 minutes), undated, invalid and error entries show a clear failure,
never another account's last-good numbers. Only duration 604800 qualifies as
weekly, regardless of primary/secondary position. A missing weekly window is
not replaced by a short window.

When the cache is unconfigured or absent, the reader uses a single read-only
GET to `https://chatgpt.com/backend-api/wham/usage` with the active Pi access
credential, accountId header and `codex_cli_rs` user agent. It has a six-second
timeout, fifteen-minute in-memory identity-scoped cache and the existing manual
refresh floor. A present but invalid/unmatched/expired cache does not trigger
fallback polling. The reader never refreshes, rotates, swaps or writes tokens,
and never writes the external monitor cache.

Claude threshold alerts remain Claude-owned and independent of display source.
This change adds no Codex alerts or swapping automation.
