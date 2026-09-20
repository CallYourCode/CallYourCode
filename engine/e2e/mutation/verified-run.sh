#!/bin/zsh
# Mutation runs for the delivery guard, reproducible by anyone.
#
# WHY THIS EXISTS
#
# Green tests are not evidence that a condition is load-bearing. Four rounds
# running, a condition in classifyPaneBox turned out to have no test behind it
# -- twice because reordering the branches quietly moved the screen that used
# to cover it under a different branch, and every test stayed green. The only
# thing that catches that is breaking each condition on purpose and checking
# that exactly one named test dies.
#
# It also has to be reproducible. Earlier rounds were run from scripts in /tmp
# and reported by letter, which nobody else could re-run; agent-engine/src/
# audio.test.ts already referenced this path before the file existed.
#
# USAGE
#
#   e2e/mutation/verified-run.sh            # every mutation
#   e2e/mutation/verified-run.sh N L        # only those
#
# Each mutation prints the tests that failed under it. A mutation that kills
# NOTHING is the finding: that condition has no test.
#
# BUT ONLY IF THE MUTATION ACTUALLY APPLIED. A perl pattern that no longer
# matches the source edits no file, the suite then runs against an UNMUTATED
# tree, everything passes, and this script prints its loudest sentence about a
# condition it never broke. That shipped: R's pattern still named an expression
# server.ts had stopped containing, so "no test behind it" was a report about
# nothing. A runner that cannot tell "no test" from "no mutation" is worth less
# than no runner, because it is believed. So every mutation is now checked to
# have changed a file, and a no-op is a FAILURE of this script, not a result.
#
# The tree must be committed first. Each mutation is undone with `git checkout`,
# which would otherwise throw away uncommitted work -- that has already happened
# once on this branch and silently turned two mutation results into nonsense.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
if [[ -n "$(git status --porcelain)" ]]; then
  echo "REFUSING: working tree is dirty. Commit first -- these mutations are"
  echo "undone with 'git checkout' and would discard whatever is uncommitted."
  exit 1
fi

# THE TREE IS RESTORED BY A TRAP, NOT BY THE HAPPY PATH.
#
# It used to be one `git checkout --` at the end of run(), NAMING TWO FILES.
# A mutation of a third (restart.ts) was therefore never undone, and this script
# exited leaving `restartLogsToChat` returning a constant in the working tree of
# whoever ran it. That is not a bug to fix once; it is a shape that must not
# exist, so the revert now covers everything tracked and fires on every way out,
# including ctrl+c and a `set -u` death mid-run. The dirty-tree refusal above is
# what makes `git checkout -- .` safe to say.
cleanup() { git checkout -- . 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# WHAT THE NO-OP GUARD IS ACTUALLY FOR, because it has now been defeated twice
# in two different ways and both times it went on printing its loudest sentence.
#
# It reads "the tree is unchanged" as "the perl pattern matched nothing". That
# inference only holds while the tree is otherwise clean, so ANYTHING that
# leaves a file mutated disarms it for every mutation after that one -- a
# leftover from an earlier letter did exactly that, and T, R, G and U all
# reported "no test behind it" on patterns that had in fact matched nothing.
# The other way it was defeated was subtler: a pattern that matched nothing
# because the source contained a NON-BREAKING space where the pattern had an
# ordinary one. Both end in the same false report, which is the one report
# nobody double-checks, because it reads like a finding.
#
# So: revert everything, always (the trap), and check the tree is clean BEFORE
# each mutation rather than only after.

# Not every condition lives under the same spec: the classifier's are in
# multipart.test.ts, the restart's in restart.test.ts. run() takes the spec as
# its THIRD ARGUMENT, so a mutation is never checked against a suite that could
# not have seen it either way. C and V shipped with this comment already
# written and run() ignoring it, so both were checked against multipart.test.ts
# and both were reported as having no test behind them. They have two and one.
SPEC=agent-engine/src/chat/multipart.test.ts
RESTART_SPEC=agent-engine/src/terminal/restart.test.ts
WEDGED_SPEC=agent-engine/src/chat/wedged.test.ts
# the dialog parser's own conditions, and the wire field that says which kind of
# not-known a blocked session is in
BLOCKED_SPEC=agent-engine/src/terminal/blocked.test.ts
ANSWER_SPEC=agent-engine/src/chat/answer.test.ts
OUT=$(mktemp -d)
WANT=("$@")
NOOP=()

want() { [[ ${#WANT[@]} -eq 0 ]] && return 0; [[ " ${WANT[*]} " == *" $1 "* ]]; }

run() {  # $1 = letter, $2 = description, $3 = spec (default $SPEC)
  local spec="${3:-$SPEC}"
  # A mutation that edited no file proves nothing. Say so and keep the letter,
  # rather than running the suite against clean source and calling it a result.
  if [[ "$1" != "BASE" && -z "$(git status --porcelain)" ]]; then
    echo "---------- $1: $2"
    echo "   REFUSING: this mutation changed NO FILE -- its pattern does not match"
    echo "   the source any more. The suite is not run; whatever it would have said"
    echo "   would be about an unmutated tree. Fix the pattern, then re-run."
    NOOP+=("$1")
    return
  fi
  bun test $spec > "$OUT/$1.txt" 2>&1
  echo "---------- $1: $2  [$spec]"
  local clean failed count passed
  clean=$(sed 's/\x1b\[[0-9;]*m//g' "$OUT/$1.txt")
  # THE VERDICT IS THE FAIL COUNT; the names are only how it is read out. This
  # used to be decided by the marker, and that is the third way the no-op guard
  # above has been defeated. bun writes `✗ name` to a terminal and `(fail) name`
  # to a pipe, and this script has always piped. So the pattern matched nothing,
  # every letter printed "NOTHING FAILED -- this condition has no test behind
  # it", and the counted line two rows below it said `1 fail` at the same time.
  # A run that says both is worse than one that says neither: the sentence is
  # the one that gets read, and it is the one nobody double-checks.
  #
  # A missing summary, a marker that stops matching, and a spec that executed
  # nothing are each a LOUD non-result rather than a quiet green -- `0 pass  0
  # fail` is what a vanished spec prints, and reading only the fail count turns
  # that into "this condition has no test behind it" all over again.
  count=$(print -r -- "$clean" | sed -n 's/^ *\([0-9][0-9]*\) fail[[:space:]]*$/\1/p' | tail -1)
  passed=$(print -r -- "$clean" | sed -n 's/^ *\([0-9][0-9]*\) pass[[:space:]]*$/\1/p' | tail -1)
  # bun names a failure twice, where it happened and again in its summary.
  failed=$(print -r -- "$clean" | grep -E '^(✗|\(fail\))' | awk '!seen[$0]++' || true)

  if [[ -z "$count" ]]; then
    echo "   NO RESULT: the suite printed no fail count at all -- it crashed, or"
    echo "   bun's summary has changed shape. This is not 'nothing failed'."
    print -r -- "$clean" | tail -5 | sed 's/^/   | /'
  elif (( count == 0 )) && [[ "${passed:-0}" == "0" ]]; then
    echo "   NO RESULT: the suite ran zero tests -- 0 pass, 0 fail. Nothing was"
    echo "   executed, so nothing was proved. This is not 'nothing failed'."
    print -r -- "$clean" | tail -5 | sed 's/^/   | /'
  elif (( count == 0 )); then
    if [[ "$1" == "BASE" ]]; then
      echo "   green, as a baseline should be."
    else
      echo "   NOTHING FAILED -- this condition has no test behind it."
    fi
  elif [[ -z "$failed" ]]; then
    echo "   $count FAILED, and this script cannot name them: neither of bun's"
    echo "   markers matched. The kill is real; the read-out is broken. $OUT/$1.txt"
  else
    print -r -- "$failed" | sed 's/^/   /'
  fi
  sed 's/\x1b\[[0-9;]*m//g' "$OUT/$1.txt" | grep -E '^\s*[0-9]+ (pass|fail)' | sed 's/^/   /'
  cleanup
  # ...and the next letter's no-op guard is only meaningful if this one really
  # went back. Said here rather than trusted, because the whole point of the
  # guard is that a silent failure downstream reads as a finding.
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "   STOPPING: the tree is still dirty after reverting $1. Every result"
    echo "   after this one would be about a mutated tree."
    git status --porcelain | sed 's/^/   /'
    exit 1
  fi
}

echo "===== baseline"
run BASE "no mutation"

if want L; then
  # the truecolor introducer read as SGR 2 (dim): a running pane stops looking
  # like a pane, and delivery is refused for most of every turn
  perl -0pi -e 's/      if \(c === 38 \|\| c === 48 \|\| c === 58\) \{\n        i \+= codes\[i \+ 1\] === 5 \? 2 : codes\[i \+ 1\] === 2 \? 4 : 1;\n        continue;\n      \}\n//' agent-engine/src/terminal/herdr.ts
  run L "truecolor skip removed"
fi

if want N; then
  # the below-the-last-rule check: a permission prompt whose panel pairs with a
  # rule in the prose above it reads as a box, and enter selects Yes
  perl -0pi -e 's/  if \(rules\.length && looksLikeChooser\(rows\.slice\(last \+ 1\)\.map\(bare\)\)\) \{\n    return \{ kind: "chooser" \};\n  \}\n//' agent-engine/src/terminal/herdr.ts
  run N "below-the-rule chooser check removed"
fi

if want P; then
  # the box paired two rules again instead of being found from its bottom edge:
  # a lid with anything drawn on it stops existing, which is every pane on his
  # machines once Claude Code started printing a tip inside the top edge
  perl -0pi -e 's/  let bottom = last;\n.*\n  let open = -1;\n  for \(let i = bottom - 1; i >= 0; i--\) \{\n.*\n.*\n.*\n.*\n.*\n  \}/  const open = [...rules.slice(0, -1)].reverse().find((i) => marked(rows[i + 1])) ?? -1;\n  const bottom = last;/' agent-engine/src/terminal/herdr.ts
  perl -0pi -e 's/  const inner = open < 0 \? \[\] : rows\.slice\(open, bottom\);/  const inner = open < 0 ? [] : rows.slice(open + 1, bottom);/' agent-engine/src/terminal/herdr.ts
  run P "the box paired from two rules again"
fi

if want E; then
  # the walk up to the prompt marker unbounded: it crosses the transcript above
  # the box and reads somebody else's output as though it had been typed
  # NOTE the class in that regex is [\s U+00A0], a NON-BREAKING space. Matching
  # it with a plain one edits nothing, and a mutation that edits nothing is what
  # the no-op guard above exists to catch. Matched loosely for that reason.
  perl -0pi -e 's/    const row = bare\(rows\[i\]\);\n[^\n]*\n[^\n]*\n    if \(row\.trim\(\)[^\n]*break;\n//' agent-engine/src/terminal/herdr.ts
  run E "the walk to the marker is unbounded"
fi

if want C; then
  # every restart outcome logged as a permanent claude message, including the
  # one that says we could not tell what happened
  perl -0pi -e 's/  return s\.seen !== "nothing";/  return true;/' agent-engine/src/terminal/restart.ts
  run C "every outcome written into his chat" "$RESTART_SPEC"
fi

if want V; then
  # the route reports a constant verdict: the app confirms on this and on
  # nothing else, so a constant is a restart claimed over any screen at all
  perl -0pi -e 's/verdict: sighting\.seen, mode,/verdict: "ready", mode,/' agent-engine/src/runtime/server.ts
  run V "the route reports a constant verdict" "$RESTART_SPEC"
fi

if want T; then
  # the last branch: a chooser that draws no rules at all (/model picker)
  perl -0pi -e 's/  if \(looksLikeChooser\(rows\.slice\(-14\)\.map\(bare\)\)\) return \{ kind: "chooser" \};\n//' agent-engine/src/terminal/herdr.ts
  run T "no-rules chooser branch removed"
fi

# --------------------------------------------------------------- the /model picker
# Three conditions, one screen. Each of them on its own was enough to make the
# picker parse as nothing, which made classifyPaneBox answer `unknown`, which
# made the app tell him the terminal was showing something it could not read --
# about six models listed 1 to 6.

if want M; then
  # the effort control ("● High effort (default) ←/→ to adjust") read as content
  # rather than as the key hint it is: a content line below the last choice
  # disqualifies the screen, so the whole picker parses as nothing
  perl -0pi -e 's/\|to set as default\|to adjust\)/|to set as default)/' agent-engine/src/terminal/blocked.ts
  run M "the effort control is not a hint" "$BLOCKED_SPEC"
fi

if want X; then
  # a content line below the last choice judged ON SIGHT again, before the choice
  # it belongs to is known. At 60 columns the last model's blurb wraps onto a row
  # of its own, so the picker dies at exactly his terminal width
  perl -0pi -e 's/    if \(!sawChoice\) \{ trailing\.push\(i\); continue; \}/    if (!sawChoice) return null;/' agent-engine/src/terminal/blocked.ts
  run X "a wrapped description under the last choice ends the run" "$BLOCKED_SPEC"
fi

if want Z; then
  # the context walk allowed past the viewport rule again: it crosses into the
  # transcript and hands the app the Claude Code welcome box, ASCII logo and all,
  # as what the question is about
  perl -0pi -e 's/    if \(VIEWPORT_RULE_RE\.test\(line\)\) break; \/\/ transcript above, panel below\n//' agent-engine/src/terminal/blocked.ts
  run Z "the context walk crosses the viewport rule" "$BLOCKED_SPEC"
fi

if want Q; then
  # the two kinds of not-known collapsed back into one: a screen we read and did
  # not recognise reported as a screen we never got, which is the sentence the
  # app draws and the reason it names
  perl -0pi -e 's/askWhy: "unrecognised"/askWhy: "unread"/' agent-engine/src/runtime/server.ts
  run Q "a screen we read is reported as one we never got" "$ANSWER_SPEC"
fi

if want R; then
  # the pane read itself: the note is believed without checking the pane
  perl -0pi -e 's/const stillThere = believable && box\.hasContent;/const stillThere = believable;/' agent-engine/src/runtime/server.ts
  run R "pane read removed from delivery"
fi

# ---------------------------------------------------------------------------
# THE TWO THAT SURVIVE. Both are here so the gap is visible and measured; they
# are not fixed, and this script is the record that they are not.

if want G; then
  # `>` dropped from the prompt-marker class, leaving `❯` only. SURVIVES.
  # Nothing in the suite tells the two apart. The one screen whose interior
  # opens with "> quoted" is pane-prompt-after-rule-in-prose.txt, and it never
  # reaches this line: the below-the-last-rule chooser check answers it first,
  # so the marker test is never asked about a `>`. Covering it needs a screen
  # where `>` is the marker of a REAL input box, which nothing has captured.
  perl -0pi -e 's/\[❯>\]\/\.test\(nonDimText/[❯]\/.test(nonDimText/' agent-engine/src/terminal/herdr.ts
  run G "prompt marker accepts only the heavy angle"
fi

if want U; then
  # the trailing-blank trim removed, so padding rows count as part of the
  # screen. SURVIVES. Every capture here ends at its last drawn row or close
  # enough that neither `last` nor the below-the-rule slice changes. It matters
  # on a live pane, where the viewport pads to full height, and no fixture
  # carries that padding.
  perl -0pi -e 's/  while \(end > 0 && bare\(all\[end - 1\]\)\.trim\(\) === ""\) end--;\n//' agent-engine/src/terminal/herdr.ts
  run U "trailing-blank trim removed"
fi

if want W; then
  # the deadline check at the front of the queue removed: a message whose turn
  # comes long after it was sent is delivered anyway, and every message behind a
  # wedged pane goes back to paying herdr's full 5s rpc timeout for it
  perl -0pi -e 's/    if \(outOfTime\(\)\) throw gaveUp\("it never reached the front of the pane queue"\);\n//' agent-engine/src/runtime/server.ts
  run W "queue-front deadline removed" "$WEDGED_SPEC"
fi

if want Y; then
  # the last check before anything is typed removed: a read that spent the whole
  # remaining budget is followed by the send_text anyway
  perl -0pi -e 's/      if \(outOfTime\(\)\) throw gaveUp\("the pane was still not answering when its turn came"\);\n//' agent-engine/src/runtime/server.ts
  run Y "pre-send_text deadline removed" "$WEDGED_SPEC"
fi

if want D; then
  # the deadline tightened under a chain that is slow and completely fine: two
  # messages at a pane answering every rpc 4s late put the second one's turn
  # 12s after he sent it. This is task #256's shape, and 8s was NOT it -- the
  # checks only ever run before anything is typed, so a delivery whose read came
  # back in time finishes however long it takes, and 8s refused nothing.
  perl -0pi -e 's/\|\| 45_000;/|| 10_000;/' agent-engine/src/runtime/server.ts
  run D "delivery deadline cut to 10s" "$WEDGED_SPEC"
fi

echo "===== tree: $(git status --porcelain | wc -l | tr -d ' ') modified (should be 0)"
rm -rf "$OUT"

if (( ${#NOOP[@]} )); then
  echo "===== FAILED: mutation(s) ${NOOP[*]} applied to nothing."
  echo "      This run says NOTHING about the conditions they name."
  exit 1
fi
