# cyc testbench

The reliability matrix for the engine's mux + harness binding: one docker
container per (harness, version, mux, scenario), a fake model as the only
network peer, and a verdict per cell read from real evidence (sealed-wire
frames, transcript files, the engine log, the fake model's `requests.jsonl`,
pane captures). Design: adapters-design sections 9 and 10.

Nothing here runs under `bun test`; the folder sits outside every engine test
glob. The unit tests that do exist are run by path (below).

## Layout

- `matrix.yaml`: pins (harness primary + compat, tmux, herdr), the cell
  limits, the scenario list, the tiers (`pr`, `nightly`, `real`).
- `docker/`: `base.Dockerfile` (bun, tmux 3.4, herdr 0.8.2, python3),
  `harness-<name>.Dockerfile` (one image per harness x version),
  `tmux-multi.Dockerfile` (tmux compat builds for the nightly tier).
- `fake-model/`: `server.ts`, the fake provider (Anthropic messages SSE,
  OpenAI responses SSE, OpenAI chat completions SSE), scripted replies in
  `scripts/*.json`, scripted shell tool calls, slow-stream mode, and the
  `requests.jsonl` oracle.
- `cell/`: what runs inside a container. `entrypoint.sh` (fake model, the
  dummy interface, the scenario runner, artifact collection),
  `engine-boot.ts` (boots the engine from the bind-mounted tree as a library),
  `driver.ts` (the scenario API: `mux()`, `engine()`, `harness()`, `fake()`,
  `wire()`, `transcript()`), `mux.ts` (tmux and herdr behind one interface),
  `harness.ts` (claude, codex, opencode, pi adapters), `wire.ts` (a sealed
  WebRTC client, every frame recorded), `herdr-probe.ts`.
- `scenarios/01-bring-up.ts` .. `13-version-gate.ts`: given/when/then, one file
  each; `_lib.ts` holds the shared given/when steps.
- `run.ts`: builds images, expands cells, runs N-wide, writes
  `summary.json`, `summary.md`, `junit.xml`; exits 1 on any surprise against
  `expected/pr.json` or on an error.
- `lib/`: matrix expansion, image build/inspect, report aggregation, the
  artifacts layout and expectation map (`runs.ts`).
- `expected/pr.json`: the checked-in map cell -> expected verdict for the pr
  tier; regenerated with `--write-expected`, hand-edited when a fix changes
  a cell's expected verdict.
- `evidence/`: the herdr-in-docker probe verdict (`.json`) and log (`.log`,
  tracked through a negated rule in the root `.gitignore`).
- `artifacts/` (gitignored): the tier record (`summary.*`, `junit.xml`,
  `cells/<cell>/`), `history/<startedAt>/` (the previous record's summary
  files, archived before each full tier run), `only/<stamp>/` (every
  `--only` run, cells and summary; the record is never touched).

## Run

Everything below runs from the repo root (`callyourcode/`). Docker builds the
images the first time (a few minutes); `--no-build` skips the check.

One cell, one scenario:

    bun testbench/run.ts --only claude/2.1.257/tmux/01-bring-up

The artifacts land under `testbench/artifacts/only/<stamp>/cells/claude_2.1.257_tmux_01-bring-up/`
(a full tier run writes the same layout under `testbench/artifacts/cells/`):
`verdict.json` (checks with details), `scenario.log`, `engine.log`,
`wire-frames.jsonl` (every sealed-wire frame, both directions),
`fake-requests.jsonl`, `transcripts/` (the harness's own session files),
`pane-NN-<step>-<pane>.txt` and `.ansi` (pane captures at each step),
`tmux.log` or `herdr.log`, `data/` (the engine's data dir: agents, chats,
pane-bindings), `docker-cmd.txt`, `ps-at-exit.txt`.

The pr tier (every harness at its primary pin, tmux and herdr, all 13
scenarios, 3 containers at a time):

    bun testbench/run.ts --tier pr --jobs 3

`--only` takes `harness/version/mux/scenario` with globs per segment, comma
lists, and `;` to join patterns:

    bun testbench/run.ts --tier pr --only 'claude/*/tmux/0[1-4]*'
    bun testbench/run.ts --tier pr --only 'codex,pi/*/herdr/*;*/*/both/10*'

Other flags: `--build-only`, `--force-build`, `--probe-herdr`, `--keep`
(leave the container), `--host` (run a cell on this machine against a herdr
server already at `HERDR_SOCKET_PATH`; never installs anything).

Exit code: the run is judged against `--expect <file>` (default
`testbench/expected/pr.json` for the pr tier and for a bare `--only`); the
process exits 1 when any cell's verdict differs from its expectation, in
either direction (a red that went green is a finding, not a pass), when a
cell is not in the map, or on an error; 0 when the set matches. The diff is
printed after the summary. Regenerate the map from the tier record with

    bun testbench/run.ts --write-expected

(reads `artifacts/summary.json`, merges over the file's other cells) or add
`--write-expected` to a run to take that run's verdicts.

Unit tests (by path, never by glob):

    bun test testbench/fake-model/server.test.ts testbench/lib/matrix.test.ts testbench/lib/report.test.ts testbench/lib/runs.test.ts

## What a cell is

    timeout --kill-after=10 420 docker run --rm --network none --memory 2g --cpus 2 \
      --pids-limit 512 --cap-add NET_ADMIN \
      -v <engine tree>:/engine:ro -v testbench/artifacts/cells/<cell>:/out \
      -e CELL_ID -e CELL_HARNESS -e CELL_VERSION -e CELL_MUX -e CELL_SCENARIO \
      cyc-testbench/<harness>:<version>

Inside: the fake model on `127.0.0.1:4141`, the engine on `127.0.0.1:10101`
booted from `/engine` with `CYC_DATA_DIR=/cell/data`, the harness home under
`/cell/home` (the harness config points at the fake model with a dummy key),
the work dirs `/cell/work/proj` and `/cell/work/proj2`, the mux (`tmux -L cell -f
/dev/null`, or `herdr server --session cell`). The container has no network:
the fake model is the only peer, over loopback.

`NET_ADMIN` is there for one thing: `entrypoint.sh` adds a dummy interface
`cell0` (10.99.0.1). werift never offers loopback ICE candidates, so a netns
with only `lo` could never open the sealed DataChannel; the sealed client in
`wire.ts` names that address in its signaling Host header. The netns still
links to nothing (`ip link add ... type dummy`). If the cap is missing the
cell falls back to 127.0.0.1 and the wire check reports it.

Expected verdict on today's tree: `expected/pr.json`, cell by cell (the
lane-1 prediction of design 10 was 1 to 11 red, 12 and 13 green; the pr run
of 2026-09-02 found claude 05, claude/codex/pi 06 and every 11 green; the
bench fixes since made 06 red on every cell (leg B: the rebooted engine
types into the busy pane at once) and 13 red on every cell (no engine
version verdict); those 16 entries are hand-set, the rest come from that
run via `--write-expected`). `summary.md` lists every cell
whose verdict differs from the map under "Surprises"; a green where red was
expected is a finding, not a pass, and it fails the run.

`summary.md` prints two sizes per image: content (`docker image inspect
.Size`, the compressed layers under the containerd store, about 200 to 330
MB) and on disk (the `docker images` SIZE column, about 0.9 to 1.4 GB).

## Add a harness version

1. Add the pin to `matrix.yaml` under `harnesses.<name>.compat` (or move it
   to `primary`).
2. Build the image: `bun testbench/run.ts --build-only --tier nightly`
   (each `harness-<name>.Dockerfile` takes the version as a build arg and
   installs with `npm i -g <package>@<version>` inside the image; the build
   fails on the key tripwire `grep -rl "sk-" /root`).
3. Run the gate for it: `bun testbench/run.ts --tier nightly --only '<name>/<version>/tmux/13*'`.
   The verdict's `facts` record the detected binary version and the pin
   list the cell was launched with; the supported/unsupported check reads
   the ENGINE's verdict (a version field on the wire row, or an engine log
   line naming the detected version and the decision). Today's engine
   exposes neither, so 13 is red on every pin with the reason "engine
   exposes no version verdict".
4. If the harness changed its TUI chrome, adjust `ready` / `quit` /
   `newSessionCommand` in `cell/harness.ts` and the transcript parser there.

Never install a harness on the host; every install lives in a Dockerfile.

## Herdr in docker

Verdict: **herdr 0.8.2 runs in docker** (probe of 2026-09-02, `evidence/
herdr-probe-2026-09-02.{json,log}`, rerun with `bun testbench/run.ts
--probe-herdr`). Every step passed inside the base image with no network:
the binary runs, `herdr server --session cell` brings the api socket up under
`~/.config/herdr/sessions/cell/`, `status` reports protocol 20 compatible,
`workspace create --cwd /cell/work` returns a root pane (`w1:p1`) with a
shell pid, `pane send-text` + Enter + `pane read` round-trips a command
(`HERDR-PROBE-42`), the socket api answers `session.snapshot` and streams
`events.subscribe`, `pane close` and `server stop` are clean. Log excerpt:

    [ok] herdr binary runs: herdr 0.8.2
    [ok] server socket appears: /cell/home/.config/herdr/sessions/cell/herdr.sock exists=true after <10s
    [ok] herdr status: ... server: status: running, version: 0.8.2, protocol: 20, compatible: yes
    [ok] workspace create: {"root_pane":{"pane_id":"w1:p1","cwd":"/cell/work", ...}}
    [ok] send-text + Enter + read: # echo HERDR-PROBE-$((6*7)) / HERDR-PROBE-42
    [ok] socket events.subscribe streams: {"type":"subscription_started"} ... pane_created, workspace_created
    VERDICT: herdr runs in docker

So `muxes.herdr.in_docker: true` in `matrix.yaml`, and herdr cells run in
containers like tmux cells. The `--host` mode stays for a herdr on a box
without docker. The cell writes `~/.config/herdr/config.toml` with
`[update] version_check = false` (and `manifest_check`, `auto_update`):
without it herdr 0.8.2 forks a `curl https://herdr.dev/latest` on boot, which
the netns cannot reach but which shows up in the cell's process table.

## Fake model scripts

A script is `{ default, rules: [{ match, reply, slowMs?, chunks?, delayMs?,
tool? }] }`; `match` is a regex against the last user text, `{{last}}` in a
reply echoes it. `scripts/default.json` carries `SLOW-TURN`, `LONG-TURN` and
`ECHO`. A rule with `tool: { command }` answers the first matching request
with a shell tool call (the tool picked from the ones the request declares:
`Bash`, `bash`, `shell`, `local_shell`; input shaped to its schema) and the
follow-up carrying the tool result with `reply`. `POST /_control` swaps the
script (`{script: "<name>" | {...}}`) or the pace (`{slow: true|false|ms}`).
Every request is one line in `requests.jsonl`: dialect, path, user texts,
last user text, the reply, declared tools, tool call, tool result.
