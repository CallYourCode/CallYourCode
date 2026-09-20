#!/bin/zsh
# Mutation runs for WHAT A SHOWN PAGE SAVED (agent-engine/src/storage/docstate.ts).
#
# WHY THIS EXISTS. The defect being fixed is one of his: an afternoon of
# reordering and annotating a shown page, gone on a reload, because a page had
# nowhere to put anything. The fix is a store, and a store is exactly the kind of
# code that passes tests while doing nothing load-bearing -- a round trip through
# a Map would pass the happy path and lose everything that matters about it. So
# each condition is broken on purpose and the suite has to die.
#
# THE VERDICT IS THE FAIL COUNT, never a marker: bun writes `✗ name` to a
# terminal and `(fail) name` to a pipe, and this script pipes. That exact mistake
# was shipped here once and reported twenty-one real kills as "this condition has
# no test behind it", with the contradicting counts printed two lines under the
# claim. `0 pass 0 fail` and a missing summary are LOUD NON-RESULTS, not green.
# All of that is verified-run.sh's judge, copied deliberately rather than
# reinvented.
#
# USAGE
#
#   e2e/mutation/docstate-run.sh                     # every mutation
#   e2e/mutation/docstate-run.sh NO_CAP NO_DOC_CHECK # only those
#
# The mutants themselves are in e2e/mutation/docstate.py, with a paragraph each
# on what wrong answer they restore; a swap that does not apply EXACTLY once is
# an error there rather than a mutant that changed nothing and then "survived".

set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
if [[ -n "$(git status --porcelain)" ]]; then
  echo "REFUSING: working tree is dirty. Commit first -- these mutations are"
  echo "undone with 'git checkout' and would discard whatever is uncommitted,"
  echo "INCLUDING the change being proved."
  exit 1
fi

# Restored by a trap, not by the happy path: ctrl+c, or a `set -u` death in the
# middle, must not leave a mutated engine in somebody's working tree.
cleanup() { git checkout -- . 2>/dev/null || true; }
trap cleanup EXIT INT TERM

SPEC=agent-engine/src/storage/docstate.test.ts
OUT=$(mktemp -d)
WANT=("$@")
NOOP=()
KILLED=0
SURVIVED=()

want() { [[ ${#WANT[@]} -eq 0 ]] && return 0; [[ " ${WANT[*]} " == *" $1 "* ]]; }

run() {  # $1 = name, $2 = description
  if [[ "$1" != BASE && -z "$(git status --porcelain)" ]]; then
    echo "---------- $1: $2"
    echo "   REFUSING: this mutation changed NO FILE -- its anchor does not match"
    echo "   the source any more. The suite is not run; whatever it would have said"
    echo "   would be about an unmutated tree."
    NOOP+=("$1")
    return
  fi
  bun test $SPEC > "$OUT/$1.txt" 2>&1
  echo "---------- $1: $2"
  local clean count passed failed
  clean=$(sed 's/\x1b\[[0-9;]*m//g' "$OUT/$1.txt")
  count=$(print -r -- "$clean" | sed -n 's/^ *\([0-9][0-9]*\) fail[[:space:]]*$/\1/p' | tail -1)
  passed=$(print -r -- "$clean" | sed -n 's/^ *\([0-9][0-9]*\) pass[[:space:]]*$/\1/p' | tail -1)
  failed=$(print -r -- "$clean" | grep -E '^(✗|\(fail\))' | awk '!seen[$0]++' || true)

  if [[ -z "$count" ]]; then
    echo "   NO RESULT: the suite printed no fail count at all -- it crashed, or"
    echo "   bun's summary has changed shape. This is not 'nothing failed'."
    print -r -- "$clean" | tail -6 | sed 's/^/   | /'
    NOOP+=("$1")
  elif (( count == 0 )) && [[ "${passed:-0}" == "0" ]]; then
    echo "   NO RESULT: the suite ran zero tests -- 0 pass, 0 fail. Nothing was"
    echo "   executed, so nothing was proved. This is not 'nothing failed'."
    print -r -- "$clean" | tail -6 | sed 's/^/   | /'
    NOOP+=("$1")
  elif (( count == 0 )); then
    if [[ "$1" == BASE ]]; then
      echo "   green, as a baseline should be."
    else
      echo "   NOTHING FAILED -- this condition has no test behind it."
      SURVIVED+=("$1")
    fi
  elif [[ -z "$failed" ]]; then
    echo "   $count FAILED, and this script cannot name them: neither of bun's"
    echo "   markers matched. The kill is real; the read-out is broken. $OUT/$1.txt"
    (( KILLED++ ))
  else
    print -r -- "$failed" | sed 's/^/   /'
    (( KILLED++ ))
  fi
  print -r -- "$clean" | grep -E '^\s*[0-9]+ (pass|fail)' | sed 's/^/   /'
  cleanup
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "   STOPPING: the tree is still dirty after reverting $1. Every result"
    echo "   after this one would be about a mutated tree."
    git status --porcelain | sed 's/^/   /'
    exit 1
  fi
}

mutate() { python3 e2e/mutation/docstate.py "$1"; }

echo "===== baseline"
run BASE "no mutation"

# name:what wrong answer it restores. The long version of each is a paragraph in
# e2e/mutation/docstate.py; this is the line that prints beside the result.
MUTANTS=(
  'NO_DOC_CHECK:any docId at all may be saved to'
  'LOAD_NO_DOC_CHECK:an unknown docId answers "nothing saved"'
  'UNREADABLE_IS_EMPTY:a state file that will not parse reads as an empty page'
  'NULL_IS_UNSAVED:falsy saved data reads as never having been saved'
  'NO_CAP:no cap on what one page may push to the engine'
  'CAP_IN_CHARACTERS:the cap counts characters, not bytes'
  'NO_JSON_CHECK:the body is stored without ever being parsed'
  'A_FILE_PER_SAVE:every save writes a new file instead of replacing one record'
  'STATE_IN_DOC_DIR:his data is written in among the disposable shown documents'
)

for entry in "${MUTANTS[@]}"; do
  m="${entry%%:*}"
  why="${entry#*:}"
  want "$m" || continue
  if ! mutate "$m"; then
    echo "---------- $m: $why"
    echo "   COULD NOT APPLY -- the anchor moved, so this proves nothing."
    NOOP+=("$m")
    cleanup
    continue
  fi
  run "$m" "$why"
done

echo
echo "===== summary"
echo "killed: $KILLED"
if (( ${#SURVIVED[@]} )); then
  echo "SURVIVED (each one is a condition with no test behind it): ${SURVIVED[*]}"
fi
if (( ${#NOOP[@]} )); then
  echo "NON-RESULTS (these proved nothing, and are not survivors): ${NOOP[*]}"
fi
(( ${#SURVIVED[@]} == 0 && ${#NOOP[@]} == 0 ))
