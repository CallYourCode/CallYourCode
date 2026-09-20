#!/bin/sh
#
# CallYourCode service lifecycle: start, stop, and uninstall the user services
# that scripts/install.sh installed. `cyc start|stop|uninstall` exec this.
#
#   scripts/services.sh start        bring the 4 services up
#   scripts/services.sh stop         take the 4 services down (leaves them installed)
#   scripts/services.sh uninstall    remove the services + the cyc shim
#   scripts/services.sh voice-off    stop + persistently disable ONLY the voice engine
#   scripts/services.sh voice-on     enable + start ONLY the voice engine
#   scripts/services.sh voice-status show whether the voice engine is enabled + active
#
# The services and their identifiers are exactly the ones install.sh writes:
#   macOS: 4 LaunchAgent plists at ~/Library/LaunchAgents/<label>.plist
#          (com.callyourcode.agent-engine, .app-server, .voice-engine, .turn)
#   Linux: 4 systemd user units at ~/.config/systemd/user/cyc-<name>.service
#          (cyc-agent-engine, cyc-app-server, cyc-voice-engine, cyc-turn)
#
# uninstall NEVER touches the data dir (~/.callyourcode) or the cloned repos:
# it only removes the service definitions and the cyc shim, so your account,
# recordings, and config all survive. Reinstall with the one-liner any time.
#
# --dry-run prints every action and touches nothing.
#
# Env knobs:
#   CYC_FAKE_OS   override uname -s so tests can assert both paths (Linux|Darwin)

set -eu

# The engine's data home. NAMED here only so the uninstall banner can promise
# it is kept; NOTHING in this script ever removes or writes under it.
DATA_DIR="$HOME/.callyourcode"

# The one generated launcher install.sh put on PATH.
CYC_SHIM="$HOME/.bun/bin/cyc"

# --- subcommand ---
CMD="${1:-}"
case "$CMD" in
  start | stop | uninstall | voice-off | voice-on | voice-status)
    ;;
  *)
    echo "usage: $0 <start|stop|uninstall|voice-off|voice-on|voice-status> [--dry-run]" >&2
    exit 2
    ;;
esac

DRY_RUN=0
case "${2:-}" in
  --dry-run)
    DRY_RUN=1
    ;;
  "")
    ;;
  *)
    echo "usage: $0 <start|stop|uninstall|voice-off|voice-on|voice-status> [--dry-run]" >&2
    exit 2
    ;;
esac

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

# --- helper: echo a command, run it (unless dry run), fail loudly ---
run() {
  printf '%s\n' "+ $*"
  if [ "$DRY_RUN" = 1 ]; then
    return 0
  fi
  if ! "$@"; then
    echo "FAILED: $*" >&2
    exit 1
  fi
}

# Like run, but a nonzero exit is tolerated: for idempotent pre-steps (e.g.
# booting out a service that may not be loaded) that must not abort the script.
run_ok() {
  printf '%s\n' "+ $*"
  if [ "$DRY_RUN" = 1 ]; then
    return 0
  fi
  "$@" || true
}

# The service identifiers, matching install.sh exactly.
if [ "$OS" = "Linux" ]; then
  START_UNITS="cyc-turn.service cyc-voice-engine.service cyc-app-server.service cyc-agent-engine.service"
  STOP_UNITS="cyc-agent-engine.service cyc-app-server.service cyc-voice-engine.service cyc-turn.service"
  UNIT_DIR="$HOME/.config/systemd/user"
else
  START_LABELS="com.callyourcode.turn com.callyourcode.voice-engine com.callyourcode.app-server com.callyourcode.agent-engine"
  STOP_LABELS="com.callyourcode.agent-engine com.callyourcode.app-server com.callyourcode.voice-engine com.callyourcode.turn"
  PLIST_DIR="$HOME/Library/LaunchAgents"
fi

# The ONE voice-engine identifier, matching install.sh, for the voice-* actions.
# The toggle touches only this unit; the other three services are never named.
VOICE_UNIT="cyc-voice-engine.service"
VOICE_LABEL="com.callyourcode.voice-engine"

case "$CMD" in

  start)
    if [ "$OS" = "Linux" ]; then
      for unit in $START_UNITS; do
        run systemctl --user start "$unit"
      done
    else
      # Ensure each service is loaded and running, idempotently. Already loaded
      # (from install or a previous start) -> restart in place with kickstart;
      # not loaded (after cyc stop, or a fresh machine) -> bootstrap. Checking
      # first avoids the bootout->bootstrap race that throws
      # "Bootstrap failed: 5: Input/output error".
      GUI="gui/$(id -u)"
      for label in $START_LABELS; do
        if [ "$DRY_RUN" != 1 ] && launchctl print "$GUI/$label" >/dev/null 2>&1; then
          run launchctl kickstart -k "$GUI/$label"
        else
          run launchctl bootstrap "$GUI" "$PLIST_DIR/$label.plist"
        fi
      done
    fi
    echo
    echo "Services started. Link a device with: cyc pair"
    ;;

  stop)
    if [ "$OS" = "Linux" ]; then
      for unit in $STOP_UNITS; do
        run systemctl --user stop "$unit"
      done
    else
      # Idempotent: booting out an already-stopped service is not an error.
      GUI="gui/$(id -u)"
      for label in $STOP_LABELS; do
        run_ok launchctl bootout "$GUI/$label"
      done
    fi
    ;;

  uninstall)
    if [ "$OS" = "Linux" ]; then
      # Disable (stops + removes the enable symlinks), delete the unit files,
      # then reload so systemd forgets the removed units.
      for unit in $STOP_UNITS; do
        run systemctl --user disable --now "$unit"
      done
      for unit in $STOP_UNITS; do
        run rm -f "$UNIT_DIR/$unit"
      done
      run systemctl --user daemon-reload
    else
      GUI="gui/$(id -u)"
      for label in $STOP_LABELS; do
        run_ok launchctl bootout "$GUI/$label"
        run rm -f "$PLIST_DIR/$label.plist"
      done
    fi

    # The cyc shim, on both OSes.
    run rm -f "$CYC_SHIM"

    # The data dir and the repos are DELIBERATELY left in place.
    echo "kept: $DATA_DIR (your data) and the repos"
    ;;

  voice-off | voice-on | voice-status)
    # The voice toggle: a voiceless install is a supported setting, not a manual
    # reach past cyc into systemd/launchd. Touches ONLY the voice unit; the other
    # three services are never named here. The engine already degrades cleanly
    # when voice is down (server.ts voiceHealthy() reports false), so `voice off`
    # needs no engine change to make the app hide/grey voice.
    if [ "$OS" = "Linux" ]; then
      # Defensive: a not-installed unit is a clean message, never a stack trace.
      if [ ! -f "$UNIT_DIR/$VOICE_UNIT" ]; then
        echo "voice: not installed (no $UNIT_DIR/$VOICE_UNIT); nothing to do"
        exit 0
      fi
      case "$CMD" in
        voice-off)
          # stop + disable, both idempotent (already-off is a clean no-op), so a
          # tolerant run: disabling an already-disabled unit is not an error.
          run_ok systemctl --user stop "$VOICE_UNIT"
          run_ok systemctl --user disable "$VOICE_UNIT"
          echo "voice: OFF (stopped and disabled; it will NOT start on boot)"
          ;;
        voice-on)
          run systemctl --user enable "$VOICE_UNIT"
          run systemctl --user start "$VOICE_UNIT"
          echo "voice: ON (enabled and started)"
          ;;
        voice-status)
          # Read-only: echo the probes, run them only when not a dry run. Both
          # is-enabled and is-active exit nonzero off the happy path, so tolerate.
          printf '%s\n' "+ systemctl --user is-enabled $VOICE_UNIT"
          printf '%s\n' "+ systemctl --user is-active $VOICE_UNIT"
          if [ "$DRY_RUN" != 1 ]; then
            enabled=$(systemctl --user is-enabled "$VOICE_UNIT" 2>/dev/null || true)
            active=$(systemctl --user is-active "$VOICE_UNIT" 2>/dev/null || true)
            echo "voice: enabled=${enabled:-unknown} active=${active:-unknown}"
          fi
          ;;
      esac
    else
      GUI="gui/$(id -u)"
      PLIST="$PLIST_DIR/$VOICE_LABEL.plist"
      # Defensive: a not-installed plist is a clean message, never a stack trace.
      if [ ! -f "$PLIST" ]; then
        echo "voice: not installed (no $PLIST); nothing to do"
        exit 0
      fi
      case "$CMD" in
        voice-off)
          # bootout stops it now; disable makes the disable persist so it does
          # NOT relaunch on the next login. Both idempotent, so tolerate nonzero.
          run_ok launchctl bootout "$GUI/$VOICE_LABEL"
          run_ok launchctl disable "$GUI/$VOICE_LABEL"
          echo "voice: OFF (booted out and disabled; it will NOT start on login)"
          ;;
        voice-on)
          # Clear a prior persistent disable, then bootstrap it back in.
          run_ok launchctl enable "$GUI/$VOICE_LABEL"
          run launchctl bootstrap "$GUI" "$PLIST"
          echo "voice: ON (enabled and bootstrapped)"
          ;;
        voice-status)
          printf '%s\n' "+ launchctl print $GUI/$VOICE_LABEL"
          if [ "$DRY_RUN" != 1 ]; then
            if launchctl print "$GUI/$VOICE_LABEL" >/dev/null 2>&1; then
              echo "voice: loaded (plist at $PLIST)"
            else
              echo "voice: not loaded (plist at $PLIST)"
            fi
          fi
          ;;
      esac
    fi

    # Persist the choice so a REINSTALL honors it. install.sh reads this marker
    # and, when present, skips enabling+starting ONLY the voice unit (the other
    # three services come up as always). Cross-platform, one file; reached only
    # once the voice unit exists (the not-installed cases above exit early).
    MARKER="$DATA_DIR/voice-disabled"
    case "$CMD" in
      voice-off)
        # Create the data dir (0700) if absent, then touch the marker. Both via
        # run() so --dry-run only prints and a missing dir is never a crash.
        run mkdir -p -m 0700 "$DATA_DIR"
        run touch "$MARKER"
        echo "voice: persisted OFF ($MARKER); a reinstall will leave voice off"
        ;;
      voice-on)
        # Clear the persisted choice so the next reinstall brings voice back.
        run rm -f "$MARKER"
        echo "voice: persisted-off marker cleared ($MARKER)"
        ;;
      voice-status)
        if [ -f "$MARKER" ]; then
          echo "voice: persisted off (marker $MARKER present; run cyc voice on to clear)"
        else
          echo "voice: no persisted-off marker"
        fi
        ;;
    esac
    ;;

esac
