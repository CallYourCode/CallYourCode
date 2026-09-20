#!/bin/zsh
# Mutation runs for THE APP SERVER NOT BLINDLY TRUSTING AN ENGINE (#325, item 9).
#
# WHY THIS EXISTS, same argument as limits-run.sh's: a green suite is not
# evidence that a bound is load-bearing. Each bound this lane added is meant to
# stop a modified or buggy engine from exhausting the app server; if reverting
# one keeps the suite green, that bound has no test behind it and the next
# refactor will quietly drop it. So each mutation reverts exactly one bound and
# must redden the NAMED test in app-server/distrust.test.ts that owns it.
#
# THE VERDICT IS THE FAIL COUNT, from bun's summary, never a marker character:
# piped to a file bun writes "(fail)", not the terminal's "✗", and judging by
# the marker reports every kill as "nothing failed". This is the same run() that
# limits-run.sh settled on, for the same reason.
#
# USAGE
#   e2e/mutation/distrust-run.sh          # every mutation
#   e2e/mutation/distrust-run.sh A D      # only those

set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
if [[ -n "$(git status --porcelain)" ]]; then
  echo "REFUSING: working tree is dirty. Commit first -- these mutations are"
  echo "undone with 'git checkout' and would discard whatever is uncommitted."
  exit 1
fi

cleanup() { git checkout -- . 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# The six memory bounds and the 4 MB backstop live in the app server and its
# spec; the source-side body truncation lives in the engine and its notify spec.
# SPEC and TFILTER are set per mutation.
SPEC=app-server/distrust.test.ts
TFILTER=""
OUT=$(mktemp -d)
WANT=("$@")
NOOP=()

want() { [[ ${#WANT[@]} -eq 0 ]] && return 0; [[ " ${WANT[*]} " == *" $1 "* ]]; }

run() {  # $1 = letter, $2 = description
  if [[ "$1" != BASE* && -z "$(git status --porcelain)" ]]; then
    echo "---------- $1: $2"
    echo "   REFUSING: this mutation changed NO FILE -- its pattern does not match"
    echo "   the source any more. The suite is not run. Fix the pattern, re-run."
    NOOP+=("$1")
    return
  fi
  if [[ -n "$TFILTER" ]]; then
    bun test $SPEC -t "$TFILTER" > "$OUT/$1.txt" 2>&1
  else
    bun test $SPEC > "$OUT/$1.txt" 2>&1
  fi
  echo "---------- $1: $2"
  local clean count passed names
  clean=$(sed 's/\x1b\[[0-9;]*m//g' "$OUT/$1.txt")
  count=$(print -r -- "$clean" | sed -n 's/^ *\([0-9][0-9]*\) fail[[:space:]]*$/\1/p' | tail -1)
  passed=$(print -r -- "$clean" | sed -n 's/^ *\([0-9][0-9]*\) pass[[:space:]]*$/\1/p' | tail -1)
  names=$(print -r -- "$clean" | grep -E '^(✗|\(fail\))' | awk '!seen[$0]++' || true)

  if [[ -z "$count" ]]; then
    echo "   NO RESULT: no fail count at all -- it crashed, or bun's summary changed"
    echo "   shape. This is not 'nothing failed'."
    print -r -- "$clean" | tail -6 | sed 's/^/   | /'
  elif (( count == 0 )) && [[ "${passed:-0}" == "0" ]]; then
    echo "   NO RESULT: the suite ran zero tests -- 0 pass, 0 fail. Nothing proved."
    print -r -- "$clean" | tail -6 | sed 's/^/   | /'
  elif (( count == 0 )); then
    if [[ "$1" == BASE* ]]; then
      echo "   green, as a baseline should be."
    else
      echo "   NOTHING FAILED -- this bound has no test behind it."
    fi
  elif [[ -z "$names" ]]; then
    echo "   $count FAILED, and this script cannot name them: neither of bun's"
    echo "   markers matched. The kill is real; the read-out is broken. $OUT/$1.txt"
  else
    print -r -- "$names" | sed 's/^/   /'
  fi
  print -r -- "$clean" | grep -E '^\s*[0-9]+ (pass|fail)' | sed 's/^/   /'
  cleanup
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "   STOPPING: the tree is still dirty after reverting $1."
    git status --porcelain | sed 's/^/   /'
    exit 1
  fi
}

echo "===== baseline"
run BASE "no mutation"

if want A; then
  # THE BODY IS NEVER TOO BIG: a modified engine's oversize POST is buffered and
  # parsed as if it were fine, the 128 MB Bun default the only wall left
  perl -0pi -e 's/if \(raw\.byteLength > PUSH_BODY_MAX_BYTES\) \{/if (false) {/' app-server/server.ts
  run A "the engine-body size check never fires"
fi

if want B; then
  # THE SESSION ID IS NOT BOUNDED: it keys three maps and rides to devices at
  # whatever length the engine chose
  perl -0pi -e 's/const engineSessionId = \(v: unknown\) => String\(v \?\? ""\)\.slice\(0, SESSION_ID_MAX\);/const engineSessionId = (v: unknown) => String(v ?? "");/' app-server/server.ts
  run B "the session id is stored and logged un-sliced"
fi

if want C; then
  # THE BADGE MAPS GROW FOR EVER: every fresh chat is tracked, so a message with
  # a new session id each time is an unbounded leak
  perl -0pi -e 's/  if \(map\.has\(key\) \|\| map\.size < TRACKED_CHATS_MAX\) return true;/  return true;/' app-server/server.ts
  run C "a new chat past the cap is tracked anyway"
fi

if want D; then
  # THE BATCH ARRAY IS NEVER CUT: the loop runs over the whole thing, however
  # long the engine made it
  perl -0pi -e 's/      const fresh = freshAll\.slice\(0, BATCH_ITEMS_MAX\);/      const fresh = freshAll;/' app-server/server.ts
  run D "the batch new[] is processed whole"
fi

if want E; then
  # THE REMEMBERED-FACTS MAP NEVER EVICTS: a fresh account every alert grows it
  # without bound
  perl -0pi -e 's/    if \(!this\.said\.has\(key\) && this\.said\.size >= SAID_MAX\) \{/    if (false) {/' app-server/usage.ts
  run E "the usage merge forgets nothing, so its map is unbounded"
fi

if want F; then
  # ONE FACT'S HOST LIST NEVER STOPS: a fresh host every alert grows the array
  # inside one entry
  perl -0pi -e 's/      if \(!prev\.hosts\.includes\(a\.host\) && prev\.hosts\.length < HOSTS_MAX\) prev\.hosts\.push\(a\.host\);/      if (!prev.hosts.includes(a.host)) prev.hosts.push(a.host);/' app-server/usage.ts
  run F "one fact's host list is unbounded"
fi

if want G; then
  # RESETSAT IS NOT BOUNDED: it goes straight into the merge key at any length
  perl -0pi -e 's/    resetsAt: typeof u\.resetsAt === "string" \? u\.resetsAt\.slice\(0, 100\) : null,/    resetsAt: typeof u.resetsAt === "string" ? u.resetsAt : null,/' app-server/usage.ts
  run G "resetsAt off the wire is stored un-sliced"
fi

# ---- the source-side body truncation, in the engine and its notify spec ----
if want H; then
  SPEC=agent-engine/src/chat/notify.test.ts
  TFILTER="preview"
  echo "===== engine baseline"
  run BASE2 "no mutation (engine notify spec)"
  # THE ENGINE SENDS THE WHOLE REPLY: a long one crosses the app server's POST
  # cap and the notification is lost, which is the false positive this fixed
  perl -0pi -e 's/  queuedNew\.set\(key, \{ \.\.\.q, body: q\.body\.slice\(0, NOTIFY_BODY_MAX\) \}\);/  queuedNew.set(key, q);/' agent-engine/src/runtime/server.ts
  run H "queueNotify puts the whole reply on the wire"
fi

echo
echo "===== summary"
if (( ${#NOOP[@]} )); then
  echo "MUTATIONS THAT EDITED NOTHING (bugs in this script): ${NOOP[*]}"
else
  echo "every mutation applied to a file."
fi
