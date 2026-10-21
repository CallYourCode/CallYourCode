# Setup: registration, identity, engine

## Registering the MCP

User-level (recommended, covers every project): run
`bun scripts/harness-integration.ts` (or `... claude` for claude only). Its
`installClaude` step adds `mcpServers.callyourcode` to `~/.claude.json`
pointing at `engine/mcp/src/server.ts`, installs the two hooks,
removes the legacy `voice` entry when it points at this repo's old path, and
installs this skill to `~/.claude/skills/callyourcode/`.

Per project instead: merge `engine/mcp/config/mcp.json.example` into that
project's `.mcp.json`, fixing the absolute path.

Either way, RESTART the session: MCP servers load at session start. A live
session keeps whatever it was born with until then (MIGRATION-NOTE.md).

## Identity

The MCP registers with the engine as the pane it runs in, read from the
environment, first match wins:

1. `HERDR_PANE_ID`: set automatically inside herdr panes
2. `VOICE_SESSION_ID`: the explicit override
3. `TMUX_PANE`: plain tmux stamps this into every pane

No identity means the engine cannot route to the session: the tools stay
listed but error, telling you to answer in the terminal instead.

## The engine

The MCP dials `ws://127.0.0.1:10101/ws` (override with `VOICE_ENGINE_URL`;
the HTTP origin in ACTIONS.md is derived from the same URL). It does not
have to be up when the session starts: the MCP reconnects with backoff, and
`speak`/`chat` wait a few seconds for a socket before erroring.

Is it up:

    curl -s http://127.0.0.1:10101/health

Install the local stack with `sh scripts/install.sh --local`, then use
`cyc start` / `cyc stop` for its user services. `cyc pair` prints a link and
QR for your own app-server, on localhost or Tailscale HTTPS. Phone access needs
the tailnet origin, not the phone's localhost. Browser data remains sealed
end-to-end through that app-server's WebSocket relay; do not expose the
loopback engine or voice ports. Preserve pairing keys and app-server state
when upgrading.
