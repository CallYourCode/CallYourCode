#!/usr/bin/env bash
# One cell, inside its container. Order (adapters-design 9.3):
#   stage the engine tree -> fake model -> (mux server, engine: from the
#   scenario runner) -> scenario -> EXIT trap: artifacts to /out.
# Env in: CELL_ID CELL_HARNESS CELL_VERSION CELL_MUX CELL_SCENARIO
#         [CELL_TMUX_BIN] [CELL_DEADLINE_S] [CELL_FAKE_SCRIPT] [CELL_UID CELL_GID]
set -u

ENGINE_SRC=${CELL_ENGINE_SRC:-/engine}
ROOT=${CELL_ROOT:-/cell}
OUT=${CELL_OUT:-/out}
FAKE_PORT=${CELL_FAKE_PORT:-4141}
ENGINE_PORT=${CELL_ENGINE_PORT:-10101}
REPO=$ROOT/repo
mkdir -p "$OUT" "$ROOT" "$ROOT/home" "$ROOT/work/proj" "$ROOT/tmux"
export CELL_ROOT=$ROOT CELL_OUT=$OUT CELL_ENGINE_SRC=$ENGINE_SRC
export CELL_FAKE_URL="http://127.0.0.1:$FAKE_PORT" CELL_ENGINE_PORT=$ENGINE_PORT
echo "cell $CELL_ID start $(date -u +%FT%TZ)" > "$OUT/cell.log"

# The sealed wire is WebRTC and werift never offers loopback candidates (it
# drops `internal` interfaces), so a netns holding only `lo` can never open a
# DataChannel. A dummy interface gives the cell one private address that
# routes nowhere: the netns still has no link to anything (--network none;
# NET_ADMIN is only for this ip command). The engine stays on loopback; the
# dialer names this address in its signaling Host header, so both ends offer
# it as their ICE candidate (sealed-client.ts).
CELL_ADDR=127.0.0.1
if ip link add cell0 type dummy 2>>"$OUT/cell.log" \
   && ip addr add 10.99.0.1/24 dev cell0 2>>"$OUT/cell.log" \
   && ip link set cell0 up 2>>"$OUT/cell.log"; then
  CELL_ADDR=10.99.0.1
else
  echo "no dummy interface (run with --cap-add NET_ADMIN); the sealed wire cannot open" >> "$OUT/cell.log"
fi
export CELL_ADDR
ip -o addr >> "$OUT/cell.log" 2>&1

# The private engine copy: the mount is read-only and shared by every cell;
# node_modules come from the image (/opt/engine-deps), never from the host.
stage() {
  local rel
  for rel in engine/agent-engine/src engine/agent-engine/package.json engine/agent-engine/public \
             engine/shared engine/hooks engine/harness engine/skills engine/mcp/src engine/mcp/package.json scripts \
             testbench/cell testbench/fake-model testbench/lib testbench/scenarios testbench/matrix.yaml; do
    [ -e "$ENGINE_SRC/$rel" ] || continue
    mkdir -p "$REPO/$(dirname "$rel")"
    cp -R "$ENGINE_SRC/$rel" "$REPO/$rel"
  done
  rm -rf "$REPO/engine/agent-engine/node_modules" "$REPO/engine/mcp/node_modules"
  ln -s /opt/engine-deps/agent-engine/node_modules "$REPO/engine/agent-engine/node_modules"
  ln -s /opt/engine-deps/mcp/node_modules "$REPO/engine/mcp/node_modules"
}
stage 2>>"$OUT/cell.log" || { echo "stage failed" >> "$OUT/cell.log"; }

# The fake model: the only network peer, on loopback, logging every request.
FAKE_MODEL_PORT=$FAKE_PORT FAKE_MODEL_LOG="$OUT/fake-requests.jsonl" FAKE_MODEL_SCRIPT="${CELL_FAKE_SCRIPT:-$CELL_SCENARIO}" \
  bun "$REPO/testbench/fake-model/server.ts" >"$OUT/fake-model.log" 2>&1 &
FAKE_PID=$!
for _ in $(seq 1 50); do
  curl -fs "http://127.0.0.1:$FAKE_PORT/_control/health" >/dev/null 2>&1 && break
  sleep 0.1
done

cleanup() {
  local rc=$?
  echo "cell $CELL_ID exit rc=$rc $(date -u +%FT%TZ)" >> "$OUT/cell.log"
  kill "$FAKE_PID" 2>/dev/null
  tmux -L cell kill-server 2>/dev/null; tmux -L cell2 kill-server 2>/dev/null
  pkill -f "herdr server" 2>/dev/null
  # whatever the runner did not get to (a crash before collect)
  if [ ! -f "$OUT/verdict.json" ]; then
    cp -R "$ROOT/data" "$OUT/data" 2>/dev/null
    printf '{"cell":"%s","harness":"%s","version":"%s","mux":"%s","scenario":"%s","verdict":"error","reason":"runner exited rc=%s without a verdict","checks":[],"artifacts":{}}\n' \
      "$CELL_ID" "$CELL_HARNESS" "$CELL_VERSION" "$CELL_MUX" "$CELL_SCENARIO" "$rc" > "$OUT/verdict.json"
  fi
  ps -eo pid,ppid,etimes,comm,args --width 200 > "$OUT/ps-at-exit.txt" 2>/dev/null
  # the container runs as root; hand the artifacts back to the host user
  if [ -n "${CELL_UID:-}" ]; then chown -R "${CELL_UID}:${CELL_GID:-$CELL_UID}" "$OUT" 2>/dev/null; fi
}
trap cleanup EXIT

cd "$REPO"
bun "$REPO/testbench/cell/run-scenario.ts" >"$OUT/runner.log" 2>&1
RC=$?
exit $RC
