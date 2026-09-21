#!/bin/sh
#
# CallYourCode install one-liner (onboarding).
#
#   curl -fsSL https://callyourcode.com/install.sh | sh
#
# The seamless one-shot: installs bun if needed, clones or updates the repo to
# ~/callyourcode, builds the app frontend at app/,
# the dist bundle the app server serves), installs the voice dependency
# with no prompts (herdr, and the sherpa-onnx prebuilt addon via bun install --
# no python, no venv, no compile; the ~1 GB of voice MODELS are downloaded by
# the engine in the background on its first boot, never here), creates the
# engine's data dir (~/.callyourcode, empty;
# the engine mints its own files), installs per-harness integration for every
# detected harness (claude, opencode, codex), installs the user services, and
# ends by running the pair command (the Local/Cloud chooser -- the ONE choice
# in the whole flow).
# Idempotent: re-running updates the repos and skips everything already done.
#
# --dry-run prints every action and touches nothing (no clone, no installs, no
# writes, no systemctl, no launchctl, no harness config edits, no pair
# command).
#
# --local installs from the repos already on disk ($HOME/callyourcode and
# $HOME/callyourcode): it skips the git clone/pull and runs everything
# else. For a from-source or air-gapped install, or a local build/test; the
# repos must already be in place or it fails loudly.
#
# --debug echoes every command and streams its full output. Without it the
# installer prints just the step it is on, line by line, and shows a failing
# command's output only when it fails.
#
# Env knobs:
#   CYC_REPO_URL        where to clone from (defaults to the GitHub repo)
#   CYC_FAKE_OS         override uname -s so tests can assert both paths
#   CYC_FAKE_HARNESSES  when SET (even empty), the authoritative comma list of
#                       installed harnesses ("claude,codex"), read by the
#                       harness installer (scripts/harness-integration.ts);
#                       unset = it detects. For tests.
#   CYC_FAKE_HERDR      "present" or "absent": override herdr detection so
#                       tests can assert both mux paths. Unset = detect.
#   CYC_FAKE_TMUX       "present" or "absent": override tmux detection the
#                       same way. Unset = detect.
#   CYC_MUX             set to "herdr" to opt into the herdr upgrade instead
#                       of the tmux default (installs/updates herdr via the
#                       herdr.dev installer). Unset = tmux, the default.

set -eu

REPO_URL="${CYC_REPO_URL:-https://github.com/CallYourCode/CallYourCode.git}"

REPO_DIR="$HOME/callyourcode"
# The app frontend lives IN this monorepo at app/. The app server serves its
# built dist bundle.
APP_DIR="$REPO_DIR/app"
DIST_DIR="$APP_DIR/dist"
BUN_BIN="$HOME/.bun/bin/bun"

# The bun version this stack is verified against. The installer pins it when it
# has to install bun (an existing bun is left alone; `cyc doctor` warns on a
# mismatch or on the known-bad 1.4.2, which crashes the TTS worker with a
# DataCloneError). bun's installer takes the tag as its first positional arg
# (`bash -s "bun-v1.4.0"`), verified against the current install script.
BUN_PIN="bun-v1.4.0"

# The engine's data home (the engine is moving to it). Created empty at 0700;
# the engine mints its own files on first boot, the installer writes NONE.
DATA_DIR="$HOME/.callyourcode"

# The persisted "voice off" choice. `cyc voice off` (scripts/services.sh) writes
# this marker; when it is present a REINSTALL must NOT re-enable or start the
# voice unit (and so the engine does not download ~1 GB of voice models). Only
# the voice unit is affected; the other three services install as always.
VOICE_DISABLED_MARKER="$DATA_DIR/voice-disabled"

# Voice stack: the voice engine's sherpa-onnx backend (voice-engine/src/backend/sherpa.ts)
# serves TTS and STT in-process off the prebuilt sherpa-onnx-node addon (bun
# install below; no python, no venv, no compile). Model files themselves are
# downloaded by the ENGINE in the background on its first boot
# (agent-engine/src/runtime/modelwarmup.ts, reusing voicemodels.ts), never here: install
# must stay snappy and the engine must come alive instantly.

DRY_RUN=0
LOCAL=0
DEBUG=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    --local)
      LOCAL=1
      ;;
    --debug)
      DEBUG=1
      ;;
    *)
      echo "usage: $0 [--local] [--dry-run] [--debug]" >&2
      exit 2
      ;;
  esac
done

# --local uses the repo THIS SCRIPT is being run from (its own location), not
# the hardcoded ~/callyourcode. The online curl|sh flow keeps the default set
# above, because nothing is on disk yet and it must pick a canonical place to
# clone into; --local already has the repo, wherever it happens to live. The
# data dir (~/.callyourcode) is unchanged either way -- data location must not
# follow the repo. Note: the service units below bake this REPO_DIR into their
# ExecStart paths, so a --local install expects the repo to stay put.
if [ "$LOCAL" = 1 ]; then
  _script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
  REPO_DIR=$(CDPATH= cd -- "$_script_dir/.." && pwd -P)
  APP_DIR="$REPO_DIR/app"
  DIST_DIR="$APP_DIR/dist"
fi

# --- os (CYC_FAKE_OS overrides detection so tests can assert both paths) ---
if [ -n "${CYC_FAKE_OS:-}" ]; then
  OS="$CYC_FAKE_OS"
else
  OS="$(uname -s)"
fi
case "$OS" in
  Linux | Darwin)
    ;;
  *)
    echo "FAILED: unsupported OS: $OS (need Linux or Darwin)" >&2
    exit 1
    ;;
esac
echo "os: $OS"

# --- helpers ---
# Echo a command, run it (unless dry run), and fail loudly with the command
# when it does not come back clean.
# Quiet by default: the caller's step label ("deps: ...", "app build: ...") is
# the line-by-line progress; the command's own noise is captured and shown only
# if it fails. --debug echoes the command and streams its full output live.
run() {
  if [ "$DRY_RUN" = 1 ] || [ "$DEBUG" = 1 ]; then printf '%s\n' "+ $*"; fi
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  if [ "$DEBUG" = 1 ]; then
    if ! "$@"; then echo "FAILED: $*" >&2; exit 1; fi
    return 0
  fi
  _log="$(mktemp)"
  if ! "$@" >"$_log" 2>&1; then
    echo "FAILED: $*" >&2
    echo "  (last 40 lines; re-run with --debug for the full output)" >&2
    tail -40 "$_log" >&2
    rm -f "$_log"
    exit 1
  fi
  rm -f "$_log"
}

# Like run, but the action is a shell command line (installer pipes).
run_sh() {
  if [ "$DRY_RUN" = 1 ] || [ "$DEBUG" = 1 ]; then printf '%s\n' "+ $1"; fi
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  if [ "$DEBUG" = 1 ]; then
    if ! sh -c "$1"; then echo "FAILED: $1" >&2; exit 1; fi
    return 0
  fi
  _log="$(mktemp)"
  if ! sh -c "$1" >"$_log" 2>&1; then
    echo "FAILED: $1" >&2
    echo "  (last 40 lines; re-run with --debug for the full output)" >&2
    tail -40 "$_log" >&2
    rm -f "$_log"
    exit 1
  fi
  rm -f "$_log"
}

# Write a unit/plist to a full path; content arrives on stdin. In dry-run the
# path is named and nothing is created.
write_file() {
  _path="$1"
  if [ "$DRY_RUN" = 1 ]; then
    printf '%s\n' "would write: $_path"
    cat >/dev/null
    return 0
  fi
  if ! mkdir -p "$(dirname "$_path")"; then
    echo "FAILED: mkdir -p $(dirname "$_path")" >&2
    exit 1
  fi
  if ! cat >"$_path"; then
    echo "FAILED: write $_path" >&2
    exit 1
  fi
  printf '%s\n' "wrote: $_path"
}

# --- prerequisites (we name what to install; we NEVER install it ourselves) ---
# Three things we cannot get without a package manager, so we check them up
# front and stop with ONE combined message naming exactly what is missing:
#   unzip  -- only if bun must be installed (its installer unpacks a .zip); a
#             machine that already has bun never needs it.
#   tmux   -- the multiplexer, since tmux is the default (people already have
#             it); not required when the user opted into herdr (CYC_MUX=herdr).
#   bzip2  -- the voice models ship as .tar.bz2 and the engine unpacks them
#             with tar at first boot; tar needs the bzip2 binary for that.
# _present TOOL is true when TOOL is on PATH, with a CYC_FAKE_<TOOL>
# present/absent override so the tests can drive every branch.
_present() {
  eval "_f=\${CYC_FAKE_$(printf '%s' "$1" | tr 'a-z' 'A-Z'):-}"
  case "$_f" in present) return 0 ;; absent) return 1 ;; esac
  command -v "$1" >/dev/null 2>&1
}
_need=""
if [ ! -x "$BUN_BIN" ] && ! _present bun && ! _present unzip; then _need="unzip"; fi
if [ "${CYC_MUX:-}" = "herdr" ]; then
  if ! _present herdr; then _need="${_need:+$_need }herdr"; fi
else
  if ! _present tmux; then _need="${_need:+$_need }tmux"; fi
fi
if ! _present bzip2; then _need="${_need:+$_need }bzip2"; fi
if [ -n "$_need" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    echo "prereqs: missing ($_need); install would stop here"
  else
    echo "FAILED: missing prerequisite(s): $_need -- install them, then re-run this installer" >&2
    exit 1
  fi
fi

# --- bun ---
if [ -x "$BUN_BIN" ]; then
  BUN="$BUN_BIN"
elif command -v bun >/dev/null 2>&1; then
  BUN="$(command -v bun)"
else
  echo "bun: not found; installing $BUN_PIN via https://bun.sh/install"
  run_sh "curl -fsSL https://bun.sh/install | bash -s \"$BUN_PIN\""
  BUN="$BUN_BIN"
  if [ "$DRY_RUN" = 0 ] && [ ! -x "$BUN" ]; then
    echo "FAILED: bun installer ran but $BUN is missing" >&2
    exit 1
  fi
fi
echo "bun: $BUN"

# --- repo ---
# --local: the repos are already on disk (rsynced, or a manual clone); install
# from them in place instead of cloning. Everything else in this script runs the
# same. This is the from-source / air-gapped path when callyourcode.com is not
# the source of truth.
if [ "$LOCAL" = 1 ]; then
  echo "repo: local mode -- using existing $REPO_DIR (no clone/pull)"
elif [ -d "$REPO_DIR/.git" ]; then
  echo "repo: update $REPO_DIR"
  run git -C "$REPO_DIR" pull --ff-only
elif [ -d "$REPO_DIR" ]; then
  echo "FAILED: $REPO_DIR exists but is not a git checkout (no .git)." >&2
  echo "  Re-run with --local to install from it as-is, or remove it to clone fresh." >&2
  exit 1
else
  echo "repo: clone $REPO_URL -> $REPO_DIR"
  run git clone --depth 1 "$REPO_URL" "$REPO_DIR"
fi

# --- dependencies (repo) ---
echo "deps: bun install in agent-engine"
run "$BUN" install --cwd "$REPO_DIR/engine/agent-engine"
echo "deps: bun install in app-server"
run "$BUN" install --cwd "$REPO_DIR/server"
echo "deps: bun install in callyourcode-mcp"
run "$BUN" install --cwd "$REPO_DIR/engine/mcp"
# The voice engine's ONE native dependency: the prebuilt sherpa-onnx addon
# (linux-x64/arm64, darwin-arm64/x64 all ship prebuilt on npm; nothing
# compiles on the user's machine).
echo "deps: bun install in voice-engine (sherpa-onnx, prebuilt)"
run "$BUN" install --cwd "$REPO_DIR/engine/voice-engine"
# The STUN/TURN service (server/turn): turn-server is a pure-JS, zero-dep bun
# package (no system package, no sudo; 3478 is unprivileged).
echo "deps: bun install in turn (turn-server, pure JS)"
run "$BUN" install --cwd "$REPO_DIR/server/turn"

# --- the app frontend (dist, what the app server serves) ---
if [ "$DRY_RUN" = 0 ] && [ ! -d "$APP_DIR" ]; then
  echo "FAILED: $APP_DIR missing (broken checkout)" >&2; exit 1
fi
# For --local the repo (hence the checked-in dist) is already on disk right now,
# so validate it even under --dry-run and fail loudly on a dist-less or broken
# source tree. The online path has no dist yet at dry-run time (it clones later),
# so there the check stays gated on a real, non-dry-run install.
if [ "$LOCAL" = 1 ] || [ "$DRY_RUN" -eq 0 ]; then
  for bundle_file in index.html build.txt plugins/git-page.html plugins/files-page.html; do
    if [ ! -f "$DIST_DIR/$bundle_file" ]; then
      echo "FAILED: checked-in app bundle is missing $DIST_DIR/$bundle_file" >&2
      exit 1
    fi
  done
fi
echo "app bundle: $DIST_DIR"

# --- data dir (created empty; the engine mints its own files on first boot) ---
echo "data: $DATA_DIR (0700, no files written)"
run mkdir -p -m 0700 "$DATA_DIR"
run chmod 0700 "$DATA_DIR"

# --- STUN/TURN config (shared turn.env) ---
# One env file all of the turn-touching services read: the cyc-turn service
# itself (server/turn/src/server.ts) and the two that build ICE server lists off it
# (app-server's rtcBlock/rtcFor, agent-engine's shared/turn.ts). It lives in the
# runtime data dir at 0600 because it holds the shared static auth secret.
#   TURN_STATIC_SECRET  generated ONCE with openssl; a re-install KEEPS the
#                       existing secret (rotating it would break live creds).
#   TURN_HOST           this box's tailnet MagicDNS name (clients STUN it there).
#   TURN_EXTERNAL_IP    this box's tailnet IPv4 (TURN relay candidate address).
TURN_ENV="$DATA_DIR/turn.env"
TURN_REALM=callyourcode

# --- port scheme (CYC_PORT_BASE) ---
# One knob moves all four service ports so a second install on this box does not
# collide on the silent defaults. This MUST match engine/shared/ports.ts:
#   APP=B, AGENT=B+1, VOICE=B+2, TURN=B+3378.
# Unset base keeps today's exact defaults (10100/10101/10102/3478). The units
# below stamp CYC_PORT_BASE (so each service's own resolvePorts agrees, e.g. the
# app server's VOICE_ENGINES default) alongside the explicit port each service
# reads; an explicit port wins and both are derived here, so they never differ.
if [ -n "${CYC_PORT_BASE:-}" ]; then
  APP_PORT_VAL=$CYC_PORT_BASE
  AGENT_PORT_VAL=$((CYC_PORT_BASE + 1))
  VOICE_PORT_VAL=$((CYC_PORT_BASE + 2))
  TURN_PORT=$((CYC_PORT_BASE + 3378))
  UNIT_PORT_BASE_ENV="Environment=CYC_PORT_BASE=$CYC_PORT_BASE"
  PLIST_PORT_BASE_ENV="		<key>CYC_PORT_BASE</key>
		<string>$CYC_PORT_BASE</string>"
  echo "ports: CYC_PORT_BASE=$CYC_PORT_BASE -> app=$APP_PORT_VAL agent=$AGENT_PORT_VAL voice=$VOICE_PORT_VAL turn=$TURN_PORT"
else
  APP_PORT_VAL=10100
  AGENT_PORT_VAL=10101
  VOICE_PORT_VAL=10102
  TURN_PORT=3478
  UNIT_PORT_BASE_ENV=""
  PLIST_PORT_BASE_ENV=""
fi

# Tailnet identity for the ICE list: MagicDNS name (trailing dot stripped) and
# IPv4. Both are read-only probes that fall back when tailscale is not up.
_ts_json="$(tailscale status --json 2>/dev/null || true)"
TURN_HOST="$(printf '%s' "$_ts_json" | "$BUN" -e 'const t=await Bun.stdin.text();let d={};try{d=JSON.parse(t)}catch{}process.stdout.write((((d.Self||{}).DNSName)||"").replace(/\.$/,""))' 2>/dev/null || true)"
[ -n "$TURN_HOST" ] || TURN_HOST="$(hostname 2>/dev/null || echo localhost)"
TURN_EXTERNAL_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"

# The static secret: reuse the one already on disk, else mint a fresh one. In
# dry-run we neither read nor write; a placeholder keeps the service templates
# below well-formed (write_file discards their bodies in dry-run anyway).
if [ "$DRY_RUN" = 1 ]; then
  TURN_STATIC_SECRET="DRYRUN_PLACEHOLDER_SECRET"
  echo "turn: would write $TURN_ENV (mode 600; secret kept if present, else openssl rand -hex 32)"
  echo "turn: host=$TURN_HOST ip=${TURN_EXTERNAL_IP:-(none)} port=$TURN_PORT realm=$TURN_REALM"
else
  if [ -f "$TURN_ENV" ] && grep -q '^TURN_STATIC_SECRET=' "$TURN_ENV"; then
    TURN_STATIC_SECRET="$(grep '^TURN_STATIC_SECRET=' "$TURN_ENV" | head -1 | cut -d= -f2-)"
    echo "turn: reusing existing secret in $TURN_ENV"
  else
    TURN_STATIC_SECRET="$(openssl rand -hex 32)"
    echo "turn: minted a new static secret"
  fi
  # Create at 0600 BEFORE writing so the secret is never briefly world-readable
  # (cat > truncates in place and keeps the mode).
  if ! (umask 177 && : >"$TURN_ENV"); then
    echo "FAILED: create $TURN_ENV" >&2; exit 1
  fi
  chmod 600 "$TURN_ENV"
  cat >"$TURN_ENV" <<EOF
TURN_STATIC_SECRET=$TURN_STATIC_SECRET
TURN_HOST=$TURN_HOST
TURN_PORT=$TURN_PORT
TURN_EXTERNAL_IP=$TURN_EXTERNAL_IP
TURN_REALM=$TURN_REALM
EOF
  echo "wrote: $TURN_ENV (mode 600)"
  echo "turn: host=$TURN_HOST ip=${TURN_EXTERNAL_IP:-(none)} port=$TURN_PORT realm=$TURN_REALM"
fi

# The turn vars the two ICE-building services need in their macOS plists (Linux
# gets them via EnvironmentFile). Two-tab indent to match the plist dicts below.
PLIST_TURN_ENV="		<key>TURN_HOST</key>
		<string>$TURN_HOST</string>
		<key>TURN_PORT</key>
		<string>$TURN_PORT</string>
		<key>TURN_STATIC_SECRET</key>
		<string>$TURN_STATIC_SECRET</string>"

# --- dependency: the multiplexer (tmux the default, herdr the opt-in) ---
# The engine needs ONE terminal multiplexer for the sessions to live in. tmux
# is the default: people already have it, so the default path never touches
# the network for this step and never runs the herdr.dev installer; it only
# confirms tmux is present (guaranteed by the prereq gate above).
# CYC_MUX=herdr opts into the herdr upgrade: keep it CURRENT, not merely
# present (an out-of-date herdr breaks the engine's pane subscription -- the
# engine needs herdr's newer event API, e.g. pane.updated -- so a stale herdr
# means the engine sees zero agents). Update via the manager that owns it:
# brew on macOS if brew installed it, else the herdr.dev installer.
echo "deps: multiplexer"
_herdr_before=none
_herdr_after=none
HERDR_RESTART_NEEDED=0
if [ "${CYC_MUX:-}" = "herdr" ]; then
  MUX=herdr
  echo "deps: herdr (opted in via CYC_MUX=herdr)"
  _herdr_before="$(herdr --version 2>/dev/null | head -1 || echo none)"
  if command -v brew >/dev/null 2>&1 && brew list herdr >/dev/null 2>&1; then
    run_sh "brew upgrade herdr 2>/dev/null || brew install herdr"
  else
    run_sh "curl -fsSL https://herdr.dev/install.sh | sh"
  fi
  _herdr_after="$(herdr --version 2>/dev/null | head -1 || echo none)"
  echo "herdr: $_herdr_after"
  # If the binary was actually upgraded, the RUNNING herdr server is still the
  # old version and the engine cannot use it until it is restarted (herdr has no
  # in-place restart; `herdr server stop` is the only way, and the next herdr
  # use starts the new-version server). We do that at the very END of the
  # installer, after the closing message, since the stop exits pane processes.
  if [ "$_herdr_before" != "none" ] && [ "$_herdr_before" != "$_herdr_after" ]; then
    HERDR_RESTART_NEEDED=1
  fi
  echo "mux: herdr (opt-in)"
else
  MUX=tmux
  echo "deps: tmux"
  # tmux presence is guaranteed by the prereq gate above.
  if _present tmux; then echo "tmux: present"; fi
  echo "mux: tmux (default)"
fi

# CYC_MUX reaches the engine through the service environment written below:
# one Environment= line in the systemd unit, one EnvironmentVariables entry in
# the launchd plist. Empty when tmux is the mux, so the default path's service
# files carry no CYC_MUX (the engine's own default is already tmux).
if [ "$MUX" = "herdr" ]; then
  UNIT_MUX_ENV="Environment=CYC_MUX=herdr"
  PLIST_MUX_ENV="		<key>CYC_MUX</key>
		<string>herdr</string>"
else
  UNIT_MUX_ENV=""
  PLIST_MUX_ENV=""
fi

# --- voice models (downloaded by the engine, NOT here) ---
# The voice engine loads sherpa-onnx models (kokoro-multi-lang-v1_0 for TTS,
# whisper turbo -- large-v3-turbo -- for STT) from the models dir
# (shared/voicepaths.ts). The engine fetches them in the background on first
# boot (agent-engine/src/runtime/modelwarmup.ts) and each capability comes up the moment
# its files land, so install stays snappy and nothing crash-loops over a
# missing model.
if [ -f "$HOME/.local/share/cyc/models/kokoro-multi-lang-v1_0/model.onnx" ] \
  || [ -f "$HOME/Library/Application Support/cyc/models/kokoro-multi-lang-v1_0/model.onnx" ]; then
  echo "voice models: present"
else
  echo "voice models: missing; the engine downloads them in the background on first boot"
fi

# --- harness integration ---
# One installer for every detected harness (claude, opencode, codex). It gives
# each present harness the MCP registration (speak/chat/show), the skill, and
# the harness's own hook mechanism for BOTH hooks: reply-goes-to-app (Stop) and
# no-blocking-foreground-command (PreToolUse). Detection, merge-never-clobber,
# backups, the legacy-skill archival and idempotency all live in the installer;
# it no-ops for absent harnesses. CYC_FAKE_HARNESSES, when set, overrides
# detection there exactly as it did here.
echo "harness: integrate detected harnesses (claude, opencode, codex)"
if [ "$DRY_RUN" = 1 ]; then
  run "$BUN" "$REPO_DIR/scripts/harness-integration.ts" --dry-run
else
  run "$BUN" "$REPO_DIR/scripts/harness-integration.ts"
fi

# --- service (Linux/systemd-user vs macOS/launchd) ---
if [ "$OS" = "Linux" ]; then
  # Survive logout: without linger, systemd tears the user manager (and every
  # cyc-* unit) down when the last session closes.
  run loginctl enable-linger "$(id -un)"

  ENGINE_UNIT="$HOME/.config/systemd/user/cyc-agent-engine.service"
  APP_UNIT="$HOME/.config/systemd/user/cyc-app-server.service"
  VOICE_UNIT="$HOME/.config/systemd/user/cyc-voice-engine.service"
  TURN_UNIT="$HOME/.config/systemd/user/cyc-turn.service"

  write_file "$ENGINE_UNIT" <<EOF
[Unit]
Description=CallYourCode agent engine
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=VOICE_URL=http://127.0.0.1:$VOICE_PORT_VAL
EnvironmentFile=$TURN_ENV
$UNIT_MUX_ENV
$UNIT_PORT_BASE_ENV
ExecStart=$BUN run engine/agent-engine/src/runtime/server.ts
Restart=always
RestartSec=2
MemoryMax=2G
MemoryHigh=1500M

[Install]
WantedBy=default.target
EOF

  write_file "$APP_UNIT" <<EOF
[Unit]
Description=CallYourCode app server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
Environment=APP_PORT=$APP_PORT_VAL
Environment=DIST_DIR=$DIST_DIR
EnvironmentFile=$TURN_ENV
$UNIT_PORT_BASE_ENV
ExecStart=$BUN run server/src/bootstrap/server.ts
Restart=always
RestartSec=2
MemoryMax=2G
MemoryHigh=1500M

[Install]
WantedBy=default.target
EOF

  write_file "$VOICE_UNIT" <<EOF
[Unit]
Description=CallYourCode voice engine
After=network-online.target

[Service]
WorkingDirectory=$REPO_DIR
Environment=VOICE_PORT=$VOICE_PORT_VAL
$UNIT_PORT_BASE_ENV
ExecStart=$BUN run engine/voice-engine/src/server.ts
Restart=always
RestartSec=3
MemoryHigh=4G
MemoryMax=6G
OOMPolicy=kill

[Install]
WantedBy=default.target
EOF

  write_file "$TURN_UNIT" <<EOF
[Unit]
Description=CallYourCode STUN/TURN
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
EnvironmentFile=$TURN_ENV
ExecStart=$BUN run server/turn/src/server.ts
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

  run systemctl --user daemon-reload
  # Honor a persisted `cyc voice off`: drop ONLY the voice unit from the enable +
  # restart set, so a reinstall leaves it off (and the engine skips the model
  # download). Without the marker, all four come up exactly as before.
  if [ -f "$VOICE_DISABLED_MARKER" ]; then
    echo "voice: disabled (cyc voice off); leaving it off"
    CYC_ENABLE_UNITS="cyc-turn.service cyc-app-server.service cyc-agent-engine.service"
  else
    CYC_ENABLE_UNITS="cyc-turn.service cyc-voice-engine.service cyc-app-server.service cyc-agent-engine.service"
  fi
  run systemctl --user enable $CYC_ENABLE_UNITS
  run systemctl --user restart $CYC_ENABLE_UNITS
else
  ENGINE_PLIST="$HOME/Library/LaunchAgents/com.callyourcode.agent-engine.plist"
  APP_PLIST="$HOME/Library/LaunchAgents/com.callyourcode.app-server.plist"
  VOICE_PLIST="$HOME/Library/LaunchAgents/com.callyourcode.voice-engine.plist"
  TURN_PLIST="$HOME/Library/LaunchAgents/com.callyourcode.turn.plist"

  # launchd redirects the stdout logs into the data dir's logs/ (the repo
  # .run is retired: logs and state live in ~/.callyourcode now, like the
  # engine's shared/cycdir.ts spells), so it must exist first.
  run mkdir -p "$DATA_DIR/logs"

  write_file "$ENGINE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AbandonProcessGroup</key>
	<true/>
	<key>EnvironmentVariables</key>
	<dict>
$PLIST_MUX_ENV
$PLIST_PORT_BASE_ENV
		<key>PATH</key>
		<string>$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>VOICE_URL</key>
		<string>http://127.0.0.1:$VOICE_PORT_VAL</string>
$PLIST_TURN_ENV
	</dict>
	<key>KeepAlive</key>
	<true/>
	<key>Label</key>
	<string>com.callyourcode.agent-engine</string>
	<key>ProgramArguments</key>
	<array>
		<string>$BUN</string>
		<string>run</string>
		<string>engine/agent-engine/src/runtime/server.ts</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardErrorPath</key>
	<string>$DATA_DIR/logs/engine.log</string>
	<key>StandardOutPath</key>
	<string>$DATA_DIR/logs/engine.log</string>
	<key>WorkingDirectory</key>
	<string>$REPO_DIR</string>
</dict>
</plist>
EOF

  write_file "$APP_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>APP_PORT</key>
		<string>$APP_PORT_VAL</string>
		<key>DIST_DIR</key>
		<string>$DIST_DIR</string>
$PLIST_PORT_BASE_ENV
		<key>PATH</key>
		<string>$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
$PLIST_TURN_ENV
	</dict>
	<key>KeepAlive</key>
	<true/>
	<key>Label</key>
	<string>com.callyourcode.app-server</string>
	<key>ProgramArguments</key>
	<array>
		<string>$BUN</string>
		<string>run</string>
		<string>server/src/bootstrap/server.ts</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardErrorPath</key>
	<string>$DATA_DIR/logs/frontend.log</string>
	<key>StandardOutPath</key>
	<string>$DATA_DIR/logs/frontend.log</string>
	<key>WorkingDirectory</key>
	<string>$REPO_DIR</string>
</dict>
</plist>
EOF

  write_file "$VOICE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>VOICE_PORT</key>
		<string>$VOICE_PORT_VAL</string>
$PLIST_PORT_BASE_ENV
	</dict>
	<key>KeepAlive</key>
	<true/>
	<key>Label</key>
	<string>com.callyourcode.voice-engine</string>
	<key>ProgramArguments</key>
	<array>
		<string>$BUN</string>
		<string>run</string>
		<string>engine/voice-engine/src/server.ts</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardErrorPath</key>
	<string>$DATA_DIR/logs/voice-engine.log</string>
	<key>StandardOutPath</key>
	<string>$DATA_DIR/logs/voice-engine.log</string>
	<key>WorkingDirectory</key>
	<string>$REPO_DIR</string>
</dict>
</plist>
EOF

  write_file "$TURN_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>TURN_EXTERNAL_IP</key>
		<string>$TURN_EXTERNAL_IP</string>
		<key>TURN_HOST</key>
		<string>$TURN_HOST</string>
		<key>TURN_PORT</key>
		<string>$TURN_PORT</string>
		<key>TURN_REALM</key>
		<string>$TURN_REALM</string>
		<key>TURN_STATIC_SECRET</key>
		<string>$TURN_STATIC_SECRET</string>
	</dict>
	<key>KeepAlive</key>
	<true/>
	<key>Label</key>
	<string>com.callyourcode.turn</string>
	<key>ProgramArguments</key>
	<array>
		<string>$BUN</string>
		<string>run</string>
		<string>server/turn/src/server.ts</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardErrorPath</key>
	<string>$DATA_DIR/logs/turn.log</string>
	<key>StandardOutPath</key>
	<string>$DATA_DIR/logs/turn.log</string>
	<key>WorkingDirectory</key>
	<string>$REPO_DIR</string>
</dict>
</plist>
EOF

  # Load + start each service, idempotently. Already loaded (a re-install over a
  # running one) -> restart with kickstart; not loaded -> bootstrap. Checking
  # first avoids the bootout->bootstrap race that throws
  # "Bootstrap failed: 5: Input/output error".
  GUI="gui/$(id -u)"
  # Honor a persisted `cyc voice off`: drop ONLY the voice plist from the load
  # set, so a reinstall leaves it off (and the engine skips the model download).
  # Without the marker, all four bootstrap exactly as before.
  if [ -f "$VOICE_DISABLED_MARKER" ]; then
    echo "voice: disabled (cyc voice off); leaving it off"
    CYC_BOOTSTRAP_PLISTS="$TURN_PLIST $APP_PLIST $ENGINE_PLIST"
  else
    CYC_BOOTSTRAP_PLISTS="$TURN_PLIST $VOICE_PLIST $APP_PLIST $ENGINE_PLIST"
  fi
  for plist in $CYC_BOOTSTRAP_PLISTS; do
    label=$(basename "$plist" .plist)
    if [ "$DRY_RUN" != 1 ] && launchctl print "$GUI/$label" >/dev/null 2>&1; then
      run launchctl kickstart -k "$GUI/$label"
    else
      run launchctl bootstrap "$GUI" "$plist"
    fi
  done
fi

# --- cyc CLI shim ---
# One generated launcher on PATH so an agent runs `cyc ...` instead of raw curls
# (skills/callyourcode/CLI.md). ~/.bun/bin is already on PATH for bun installs;
# the shim is generated, never hand-edited, so it is overwritten every install.
CYC_SHIM="$HOME/.bun/bin/cyc"
echo "cyc: install shim -> $CYC_SHIM"
write_file "$CYC_SHIM" <<EOF
#!/bin/sh
exec "$BUN" "$REPO_DIR/scripts/cyc.ts" "\$@"
EOF
run chmod 755 "$CYC_SHIM"

# --- done: point at `cyc pair` (never run the chooser from here) ---
# The Local/Cloud chooser is interactive and needs a clean controlling tty.
# Buried at the tail of this installer (which has spawned many subprocesses),
# even a fresh /dev/tty open comes back unreadable (ENXIO), so the chooser
# cannot run reliably from here. The install ends by pointing at `cyc pair`,
# which the user runs in their own shell where the tty is clean.
echo
echo "Setup complete: agent-engine, app-server, voice-engine and turn are installed and running."
echo
# THE SAME-SHELL PATH GAP: the cyc shim lands in ~/.bun/bin, and when THIS
# install put bun there, the shell that ran the installer has not re-read its
# rc yet, so `cyc` is not found until a new shell. Print the exact line rather
# than letting the very next advertised command fail with "command not found".
if ! command -v cyc >/dev/null 2>&1; then
  echo "cyc lives in ~/.bun/bin, which this shell has not picked up yet. Run:"
  echo
  echo "    export PATH=\"\$HOME/.bun/bin:\$PATH\""
  echo
  echo "(New shells have it already.)"
  echo
fi
echo "Next, link this machine or a phone by running:"
echo
echo "    cyc pair"
echo
echo "That is the one interactive step: a Local / Cloud menu, then the link to open."
echo "Run 'cyc help' to see every command."

if [ "$HERDR_RESTART_NEEDED" = 1 ] && [ "$DRY_RUN" != 1 ]; then
  echo
  echo "herdr was updated ($_herdr_before -> $_herdr_after); restarting its server so"
  echo "the new version takes effect. This EXITS any current herdr panes; herdr"
  echo "starts fresh on next use and the engine reconnects on its own."
  herdr server stop 2>/dev/null || true
fi
