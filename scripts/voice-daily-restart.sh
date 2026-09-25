#!/bin/sh
# The voice engine's daily restart (owner, 2026-09-25): a long-lived sherpa-onnx
# process only grows, so it is recycled once a day. The timer that runs this
# already fires at a random time in a quiet window (systemd RandomizedDelaySec;
# on macOS the jitter is the sleep below). It never cuts off speech: it waits
# for the engine to report no live stream and nothing in flight, and gives up
# for the day if it never goes quiet. A `cyc voice off` install is left alone.
#
#   voice-daily-restart.sh [--dry-run]   (--dry-run prints the decision only)

set -u
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

DATA_DIR="${CYC_DATA_DIR:-$HOME/.callyourcode}"
if [ -f "$DATA_DIR/voice-disabled" ]; then
  echo "voice-restart: voice is off (cyc voice off); nothing to do"
  exit 0
fi

PORT="${VOICE_PORT:-}"
if [ -z "$PORT" ]; then
  if [ -n "${CYC_PORT_BASE:-}" ]; then PORT=$((CYC_PORT_BASE + 2)); else PORT=10102; fi
fi

# macOS has no RandomizedDelaySec: jitter here, up to JITTER_S (default 2h).
if [ "$(uname -s)" = "Darwin" ] && [ "$DRY" = 0 ]; then
  sleep $(( $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % ${JITTER_S:-7200} ))
fi

# Quiet means the engine answers and reports no stream and no batch work.
quiet() {
  body=$(curl -s --max-time 5 "http://127.0.0.1:$PORT/health") || return 1
  # the engine-wide load block, not a per-capability counter
  printf '%s' "$body" | grep -q '"load":{"active_streams":0,"batch_in_flight":0,"batch_queued":0}'

}

tries=${QUIET_TRIES:-60}   # one check a minute, up to an hour
while [ "$tries" -gt 0 ]; do
  if quiet; then
    if [ "$DRY" = 1 ]; then echo "voice-restart: quiet; would restart"; exit 0; fi
    if [ "$(uname -s)" = "Darwin" ]; then
      launchctl kickstart -k "gui/$(id -u)/com.callyourcode.voice-engine"
    else
      systemctl --user restart cyc-voice-engine.service
    fi
    echo "voice-restart: restarted"
    exit 0
  fi
  if [ "$DRY" = 1 ]; then echo "voice-restart: busy or not answering; would wait"; exit 0; fi
  tries=$((tries - 1))
  sleep 60
done
echo "voice-restart: never went quiet; skipped for today"
exit 0
