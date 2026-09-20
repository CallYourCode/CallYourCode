# Acting in the app: the `cyc` command

`cyc` is on your PATH. It talks to the agent engine on this machine for you, so
you never build a URL or a curl by hand. Every answer is `{ok, ...}` JSON printed
as-is; a refusal or an unreachable engine is a non-zero exit with the reason on
stderr.

Every command names its agent EXPLICITLY by the stable **agent id** (`ag-...`),
the one id that survives a restart; there is no "acts on self" guessing. Your
OWN id comes from the callyourcode MCP's `info` tool: call it, read `agentId`,
and pass that id to `cyc`. The engine answers `info` from your registered
connection, so it is right even in a hand-started pane. Other agents' ids come
from `cyc agents`. Pane ids never appear.

Engine origin: `CYC_ENGINE_URL`, else `VOICE_ENGINE_URL`, else
`http://127.0.0.1:10101`. Override only if the engine is not where cyc expects it.

## Identity (this conversation)

Get your own agent id first (the MCP `info` tool; returns `agentId`, `name`,
`cwd`, `harness`), then rename yourself (80 chars max; an empty name clears the
override):

    cyc agent rename ag-3fK9x2mPq81LbR0w "deploy watcher"
    cyc agent rename ag-3fK9x2mPq81LbR0w ""

Set that agent's photo (any image file; `-` reads the bytes from stdin), or
clear it:

    cyc agent photo ag-3fK9x2mPq81LbR0w ./face.jpg
    cyc agent photo ag-3fK9x2mPq81LbR0w --clear

## Other agents on this machine

List every agent the engine holds, docker-ps style (the pane id is never shown):

    cyc agents

    AGENT ID              NAME            FOLDER                     MUX    HARNESS  STATUS
    ag-3fK9x2mPq81LbR0w   deploy watcher  ~/projects/foo             herdr  claude   working
    ag-8Qw1nT5cZk2vXo9d   herdr           ~/projects/callyourcode  herdr  claude   idle

Feed another agent INPUT: a hand-off, a status ask, a wake. Both ids are
explicit: yours first (the sender, for the honest author line), the target's
second. It lands in that agent's pane as `<author>: <text>`; it never writes to
their chat, and the receiving agent decides what, if anything, to say:

    cyc agent message ag-3fK9x2mPq81LbR0w ag-8Qw1nT5cZk2vXo9d "staging is green; your turn"

If the reply says **pane busy, retry shortly**, the pane could not take it right
now (offline, or sitting on a permission prompt): try again in a moment.

## Reminders and crons (schedules)

Schedules are the `crons` plugin. A schedule delivers its `body` back to the
agent `--session` names, at the time it names. Use your own agent id (from the
`info` tool) to schedule for yourself.

List / create a one-off (`at` is epoch ms) / create a repeat (5-field cron):

    cyc plugin crons list --session ag-3fK9x2mPq81LbR0w
    cyc plugin crons create '{"kind":"once","name":"call mum","body":"ring her","at":1786990000000}' --session ag-3fK9x2mPq81LbR0w
    cyc plugin crons create '{"kind":"repeat","name":"morning-plan","body":"plan the day","cron":"0 9 * * *","tz":"Europe/Berlin"}' --session ag-3fK9x2mPq81LbR0w

Pause (update `enabled:false`) / edit (update any field) / remove one, by the id
create and list return; preview a cron before saving:

    cyc plugin crons update '{"id":"<schedId>","enabled":false}' --session ag-3fK9x2mPq81LbR0w
    cyc plugin crons update '{"id":"<schedId>","cron":"0 8 * * 1-5"}' --session ag-3fK9x2mPq81LbR0w
    cyc plugin crons remove '{"id":"<schedId>"}' --session ag-3fK9x2mPq81LbR0w
    cyc plugin crons preview '{"cron":"0 9 * * *"}' --session ag-3fK9x2mPq81LbR0w

## Plugins in general

Any plugin op is `cyc plugin <id> <op> [json-args] --session <agentId>`; the
JSON is passed straight through as the op's args, and `--session` (required)
names the agent whose scope the call runs in: your own id for yourself, another
agent's id to act in their scope.

    cyc plugin usage today --session ag-3fK9x2mPq81LbR0w
    cyc plugin crons count --session ag-8Qw1nT5cZk2vXo9d
