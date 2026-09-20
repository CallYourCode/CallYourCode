# callyourcode-mcp

The **output** MCP server that gives **one Claude Code session** a voice: the thin
doorway between that session and the agent engine. One process per session.
(Directory and server key were `voice-channel` / `voice`, since renamed.)

It is deliberately minimal, because an MCP process runs the code it was born with
for the life of its session, so every line here is a line that can go stale in a
running session. It does three things: identify this session, POST to the engine
over stateless loopback HTTP, and expose the output tools.

```
  Claude Code session
        │ stdio (MCP)
  callyourcode-mcp  ──HTTP POST /agent/reply──>  agent engine :10101
        │                                          │
   speak(text) ───────────────────────────────> Kokoro ──> the page's <audio>
   chat(text)  ───────────────────────────────> the chat log ──> the app
   show(path)  ───────────────────────────────> file / diff / image / html page
```

Delivery is **stateless**: no persistent socket, no register, no reconnect. Each
tool call is ONE POST naming this session's pane, and the HTTP response IS the ack.
An engine restart cannot strand the process. The very next POST reaches the fresh
engine. (The old persistent `/ws` register broke delivery on every restart, which
is why this is stateless now.)

The user's messages do NOT arrive through this server. They come in as ordinary
terminal input prefixed `VOICE:` (spoken) or `TEXT:` (typed). This server is
output only.

## Install

```sh
cd engine/mcp
bun install
```

## Add it to a session

`cyc install` (scripts/harness-integration.ts) wires this into every detected
harness for you, so you should not normally hand-edit anything. It writes the
**path-independent launcher**, never an absolute engine path:

```json
{
  "mcpServers": {
    "callyourcode": {
      "command": "cyc",
      "args": ["mcp"]
    }
  }
}
```

`cyc mcp` (the `cyc` shim the installer puts on PATH) runs this server against
the LOCAL checkout, so the config text is identical on every machine and never
carries a machine-specific path that breaks when a config is copied across boxes
or the engine dir moves. If a configured path ever does go missing, the engine
warns about it at boot (`[harness-check] ...`); re-run `cyc install` to rewire.

Start Claude Code in that directory. The session appears as a card on the engine's
page. The tool names derive from the server key, so the session calls
`mcp__callyourcode__speak` (a session still running the pre-rename process keeps
`mcp__voice__*` until it restarts; the engine accepts both).

## Identity

The engine keys a session by its **live pane id**, so the MCP tells the engine
which pane it runs in, from the first of these that is set:

| env | who sets it |
|---|---|
| `HERDR_PANE_ID` | herdr, per pane |
| `VOICE_SESSION_ID` | explicit override |
| `TMUX_PANE` | plain tmux, `%N`, the same id TmuxMux reports |

There is **no fallback identity**. A session with none of these cannot be routed
to, so the output tools return an error saying so rather than registering as
garbage. The session's display name is not set here: the engine owns it and
returns it from `info`.

## Config

| env | default | |
|---|---|---|
| `VOICE_ENGINE_URL` | `ws://127.0.0.1:10101/ws` | where the engine is. Kept as a `ws://` url for back-compat with existing config; delivery is HTTP, so the base is derived from it (swap the scheme for http, drop the path). |
| `VOICE_ENGINE_HTTP_URL` | derived from the above | overrides the HTTP base outright. |
| `CYC_MCP_CONFIRM_MS` | `15000` | how long a POST waits for the engine to confirm. Test-only; production waits the default. |

The engine does not have to be running when the session starts. Because delivery
is per-call HTTP, a tool called while the engine is down fails immediately (nothing
listening), and the next call after the engine is back just works. There is no
persistent connection to re-establish.

## The tools

- **`speak(text)`** say it out loud. TTS output, the only way the user hears you.
  Short, conversational, no markdown, no file paths.
- **`chat(text)`** a written reply as a message in the app's chat. Light markdown
  is fine.
- **`show(path)`** display a file: an image inline, short markdown or a diff inline,
  a longer one as a card, and an `.html` file as a full-screen sandboxed
  interactive page (`cyc.submit` / `cyc.save` / `cyc.load`; see `examples/`).
- **`info`** ask the engine who this agent is: its stable `ag-...` id, name, cwd
  and harness. Call it whenever a `cyc` command needs the agent id, and pass the
  returned id explicitly (`--session <agentId>`). The engine answers from the
  registered pane, so it is right even for a hand-started pane whose env carries
  no agent id.

`speak`, `chat` and `show` POST to `/agent/reply` with `{ pane, kind, ... }` and a
`channels` list of what this build can deliver, so the engine knows what a session
can do without a register frame. `info` POSTs to `/agent/info`. The tool set is
fixed at startup on purpose (ListTools is answered once), so the reply level (spoken
/ written / both) rides on each delivered message instead of the tool list.

## Delivery guarantees

A POST waits up to `CONFIRM_MS` for the engine's ack (the ack means the message is
in the chat log). On timeout or a transport error the tool errors **naming the
retry**, and the Stop hook re-sends rather than dropping the reply. That makes
`speak`/`chat` at-least-once, so the server mints one idempotency key per logical
utterance and reuses it on the retry; the engine records the first arrival and
dedupes the rest (#505).

## Scheduling

When the session has an id, the server's MCP instructions tell the agent how to
schedule messages to itself (reminders, repeats) through its own CLI
(`cyc plugin crons <op> --session <agentId>`), so the user can just ask this
session to set a reminder. The agent calls `info` first to get its agent id.

## Lifecycle

stdio transport. The process exits on SIGINT/SIGTERM (the session that spawned it
going away). There is no socket to tear down and no card heartbeat: with stateless
HTTP, liveness is simply whether a session is still POSTing.
