#!/bin/zsh
# Mutation runs for HOW OFTEN THE ACCOUNT IS ASKED (task 155).
#
# WHY THIS EXISTS, and it is the same argument as verified-run.sh's: green
# tests are not evidence that a condition is load-bearing. It matters more here
# than anywhere, because the defect this covers had NOTHING to fail. The poll
# ran every two minutes, forced past two caches, took 120 requests an hour off
# one account, got rate limited, and every test in the repo stayed green while
# the card told him his plan was in trouble. A suite that would have stayed
# green through that is a suite worth breaking on purpose.
#
# WHY IT IS ITS OWN FILE. verified-run.sh is the delivery guard's -- its
# mutations are all in herdr.ts's classifier and server.ts's deliver path, and
# its spec is multipart.test.ts. Nothing here touches either.
#
# USAGE
#
#   e2e/mutation/limits-run.sh          # every mutation
#   e2e/mutation/limits-run.sh A C      # only those
#
# A mutation that kills NOTHING is the finding: that condition has no test.
# A mutation that edits NO FILE is a failure of this script, not a result --
# a perl pattern that has stopped matching runs the suite against clean source
# and then prints the loudest sentence here about a condition it never broke.
# And a mutation judged by a marker bun did not print is the same failure by a
# different road: it happened here, to every mutation in the file at once, and
# run() below says what it looked like and what decides now.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
if [[ -n "$(git status --porcelain)" ]]; then
  echo "REFUSING: working tree is dirty. Commit first -- these mutations are"
  echo "undone with 'git checkout' and would discard whatever is uncommitted."
  exit 1
fi

# Restored by a trap, not by the happy path: ctrl+c, or a `set -u` death in the
# middle, must not leave a mutated engine in somebody's working tree.
cleanup() { git checkout -- . 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# THE SPEC IS PER MUTATION NOW, because the suite this file was written against
# no longer exists in one piece. limits.test.ts used to boot engines and hold
# the guardrail tests as well; the rewrite split that three ways, so the
# mutations below name the file that would catch them:
#
#   SPEC_LIMITS   the seam file over the real limits.ts against a fake upstream
#   SPEC_GUARDS   the pure whyNot* predicates, no process anywhere
#   SPEC_BOOT     the one file that boots an engine, and therefore the only
#                 place "the harness ASKS the guardrails" can be broken
#
# SPEC_BOOT carries the preload the e2e script sets (package.json test:e2e),
# because e2e/roundtrip.test.ts dials over a DataChannel and the shim that
# swaps WebSocket for it lives there. Running it without the preload would fail
# for a reason that has nothing to do with the mutation.
SPEC_LIMITS=agent-engine/src/storage/limits.test.ts
SPEC_GUARDS=agent-engine/src/test-utils/guardrails.test.ts
SPEC_BOOT="--preload ./agent-engine/src/e2e/testpreload.ts agent-engine/src/e2e/roundtrip.test.ts"
SPEC=$SPEC_LIMITS
OUT=$(mktemp -d)
WANT=("$@")
NOOP=()

want() { [[ ${#WANT[@]} -eq 0 ]] && return 0; [[ " ${WANT[*]} " == *" $1 "* ]]; }

run() {  # $1 = letter, $2 = description
  if [[ "$1" != "BASE" && -z "$(git status --porcelain)" ]]; then
    echo "---------- $1: $2"
    echo "   REFUSING: this mutation changed NO FILE -- its pattern does not match"
    echo "   the source any more. The suite is not run; whatever it would have said"
    echo "   would be about an unmutated tree. Fix the pattern, then re-run."
    NOOP+=("$1")
    return
  fi
  # ${=SPEC} so a multi-word spec (the preload flag) splits into arguments; zsh
  # does not word-split unquoted parameters the way sh does.
  bun test ${=SPEC} > "$OUT/$1.txt" 2>&1
  echo "---------- $1: $2"
  local clean count names
  clean=$(sed 's/\x1b\[[0-9;]*m//g' "$OUT/$1.txt")

  # THE VERDICT IS THE FAIL COUNT. The names are how it is read out, and they
  # are not allowed to decide anything.
  #
  # This used to be `grep '^✗'`, and ✗ is what bun prints ON A TERMINAL. Every
  # run of this script sends the suite to a file, so bun was printing "(fail)"
  # and the grep matched nothing, ever. Twenty-two mutations, twenty-one of them
  # killing tests, and every single one was reported as
  #
  #     NOTHING FAILED -- this condition has no test behind it
  #        33 pass
  #        2 fail
  #
  # with the contradiction printed two lines under the claim. A mutation script
  # exists to say which conditions are load-bearing; this one said none of them
  # were, in the same file that already carried one false conclusion about
  # mutation I. The count line is unambiguous and comes from bun's summary
  # rather than from its per-test decoration, so that is what decides now, and
  # a summary that is missing or a marker that stops matching are each a LOUD
  # non-result rather than a quiet green.
  count=$(print -r -- "$clean" | sed -n 's/^ *\([0-9][0-9]*\) fail[[:space:]]*$/\1/p' | tail -1)
  # bun names a failure twice, where it happened and again in its summary, and
  # a list that says it twice reads as twice as many kills. Order kept.
  names=$(print -r -- "$clean" | grep -E '^(✗|\(fail\))' | awk '!seen[$0]++' || true)

  # A RUN THAT EXECUTED NOTHING SAYS "0 fail" TOO. A spec whose tests all
  # vanished -- a renamed file, a describe that never registered, a testMatch
  # that stopped matching -- prints `0 pass  0 fail`, and reading only the fail
  # count turns that into "this condition has no test behind it", which is the
  # same false conclusion this script already had once. The pass count is what
  # separates "ran and survived" from "never ran".
  passed=$(print -r -- "$clean" | sed -n 's/^ *\([0-9][0-9]*\) pass[[:space:]]*$/\1/p' | tail -1)

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
  elif [[ -z "$names" ]]; then
    echo "   $count FAILED, and this script cannot name them: neither of bun's"
    echo "   markers matched. The kill is real; the read-out is broken. $OUT/$1.txt"
  else
    print -r -- "$names" | sed 's/^/   /'
  fi
  print -r -- "$clean" | grep -E '^\s*[0-9]+ (pass|fail)' | sed 's/^/   /'
  cleanup
  # back to the default, so a mutation that named its own spec cannot make the
  # next one report about a file it never mutated
  SPEC=$SPEC_LIMITS
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "   STOPPING: the tree is still dirty after reverting $1. Every result"
    echo "   after this one would be about a mutated tree."
    git status --porcelain | sed 's/^/   /'
    exit 1
  fi
}

echo "===== baseline"
run BASE "no mutation"

if want A; then
  # THE INTERVAL: back to two minutes, which is the rate that got us 429ed
  perl -0pi -e 's/export const LIMITS_POLL_MS = 15 \* 60_000;/export const LIMITS_POLL_MS = 2 * 60_000;/' agent-engine/src/storage/limits.ts
  run A "the poll is every two minutes again"
fi

if want B; then
  # THE GRID: an interval measured from now, so every restart buys a request
  perl -0pi -e 's/  return \(Math\.floor\(\(now - phaseMs\) \/ intervalMs\) \+ 1\) \* intervalMs \+ phaseMs;/  return now + intervalMs;/' agent-engine/src/storage/limits.ts
  run B "the next poll is an interval from now, not a grid slot"
fi

if want C; then
  # THE JITTER IS STABLE: a coin instead of a hash, so a restart re-rolls it
  perl -0pi -e 's/  return createHash\("sha256"\)\.update\(engineKey\)\.digest\(\)\.readUInt32BE\(0\) % spreadMs;/  return Math.floor(Math.random() * spreadMs);/' agent-engine/src/storage/limits.ts
  run C "the phase is redrawn on every boot"
fi

if want D; then
  # THE JITTER IS PER ENGINE: one phase for everybody, so both engines on this
  # Mac ask at the same second for ever
  perl -0pi -e 's/  return createHash\("sha256"\)\.update\(engineKey\)\.digest\(\)\.readUInt32BE\(0\) % spreadMs;/  return 0;/' agent-engine/src/storage/limits.ts
  run D "every engine gets the same phase"
fi

if want E; then
  # THE CACHE IS CONSULTED: the gate never hits, which is what passing force
  # did for two years
  perl -0pi -e 's/  if \(!force && cached && usable\(askedAt\)\) return cached;/  if (false \&\& cached) return cached;/' agent-engine/src/storage/limits.ts
  run E "the in-process gate never hits (force, in effect)"
fi

if want F; then
  # THE LAST ATTEMPT SURVIVES A RESTART: an engine that comes back asks again,
  # and a KeepAlive crash loop is a request every few seconds
  perl -0pi -e 's/  if \(!askedAt\) askedAt = state\.askedAt \?\? 0;\n//' agent-engine/src/storage/limits.ts
  run F "the persisted ask time no longer seeds the gate"
fi

if want G; then
  # TWO ENGINES, ONE ASK: the machine's shared answer is never read, so every
  # engine asks for itself
  perl -0pi -e 's/      if \(s && usable\(s\.at\)\) return fromShared\(s, state\);/      if (false \&\& s) return fromShared(s, state);/' agent-engine/src/storage/limits.ts
  run G "the shared reading is never used"
fi

if want H; then
  # THE LEASE: losing it means asking anyway, which is the second request the
  # whole file exists to prevent
  perl -0pi -e 's/    if \(res\.kind === "busy"\) \{/    if (false) {/' agent-engine/src/storage/limits.ts
  run H "the loser of the lease asks as well"
fi

if want I; then
  # THE LEASE IS TAKEN BY LINKING, and see the section at the bottom: this one
  # KILLS NOTHING, on purpose, and the reason is worth more than the mutation.
  perl -0pi -e 's/      await link\(tmp, path\);/      await writeFile(path, "", { flag: "wx" });\n      await writeFile(path, JSON.stringify({ pid: process.pid, at: Date.now() }));/' agent-engine/src/storage/limits-share.ts
  run I "the lease is created rather than linked"
fi

if want J; then
  # A FAILED ATTEMPT IS PUBLISHED: a 429 that nobody hears about is a 429 the
  # next engine earns for itself a second later
  perl -0pi -e 's/    if \(usageRes\.status === 429\) return settle\(staleFrom\(state, "rate limited", "throttled"\), true\);/    if (usageRes.status === 429) return settle(staleFrom(state, "rate limited", "throttled"), false);/' agent-engine/src/storage/limits.ts
  run J "a 429 is not published to the machine"
fi

if want K; then
  # THE WAITER WAITS FOR THE HOLDER'S START, not for its own: waiting for an
  # answer stamped after the instant you began waiting never gets one, because
  # the request you are waiting for started before that
  perl -0pi -e 's/        const s = await awaitShared\(account, res\.since, leaseWaitMs\(\)\);/        const s = await awaitShared(account, Date.now(), leaseWaitMs());/' agent-engine/src/storage/limits.ts
  run K "the waiter waits for an answer that cannot arrive"
fi

if want L; then
  # SHARING IS NEVER A DEPENDENCY: a directory it cannot make must not stop the
  # card from having numbers
  perl -0pi -e 's/      return false;\n    \}\n  \}\)\(\)\);/      throw e;\n    }\n  })());/' agent-engine/src/storage/limits-share.ts
  run L "an unusable shared directory becomes an error"
fi

if want P; then
  # THE INTERVAL IS MEASURED FROM WHEN WE ASKED, not from how old the numbers
  # are: a 429 leaves the numbers' timestamp alone, so this is the difference
  # between a throttled engine asking four times an hour and on every card read
  perl -0pi -e 's/  if \(!force && cached && usable\(askedAt\)\) return cached;/  if (!force \&\& cached \&\& usable(cached.fetchedAt)) return cached;/' agent-engine/src/storage/limits.ts
  run P "the interval is measured from the numbers again, not from the ask"
fi

if want Q; then
  # NO LOWER BOUND ON THE TTL: one timestamp in the future latches the poll off
  # for ever and the card calls an arbitrarily old number brand new
  perl -0pi -e 's/  const age = now\(\) - at;\n  return age >= 0 && age < ttlMs;/  return now() - at < ttlMs;/' agent-engine/src/storage/limits.ts
  run Q "a reading from the future counts as fresh"
fi

if want Y; then
  # THE AGE IS CLAMPED RATHER THAN DROPPED: a reading from the future comes out
  # as zero and the card calls a number of unknown age "just now". Q is the
  # cache half of the same clock step; this is the half that reaches the screen
  perl -0pi -e 's/  const ageMs = rawAge !== null && rawAge >= 0 \? rawAge : null;/  const ageMs = rawAge !== null ? Math.max(0, rawAge) : null;/' agent-engine/src/plugins/usage-card/index.ts
  run Y "a future reading's age is clamped to zero instead of dropped"
fi

if want R; then
  # THE REFRESH ARROW WAITS FOR THE LEASE AGAIN: eleven seconds against the
  # card's twelve, on the button he complained about
  perl -0pi -e 's/      if \(!force\) \{\n        const s = await awaitShared/      if (true) {\n        const s = await awaitShared/' agent-engine/src/storage/limits.ts
  run R "a forced read waits for somebody else's lease"
fi

if want S; then
  # ABSENT READ AS DEAD: the claim that failed a moment ago is gone because the
  # holder released it, and unlinking now deletes whoever took it since
  perl -0pi -e 's/    if \(!held\) continue;/    if (!held) { await unlink(path).catch(() => {}); continue; }/' agent-engine/src/storage/limits-share.ts
  run S "a lease that went away is treated as a dead one"
fi

if want W; then
  # ADOPTING SOMEBODY ELSE'S READING WITHOUT RECORDING WHEN IT WAS TAKEN: the
  # adopting engine's gate never closes, so every card read goes back to the
  # shared file for an answer it already holds
  perl -0pi -e 's/  askedAt = at;\n  state\.askedAt = at;\n  if \(report\.ok && report\.windows\) \{/  if (report.ok \&\& report.windows) {/' agent-engine/src/storage/limits.ts
  run W "an adopted reading carries no ask time"
fi

if want X; then
  # WHAT A CRASHED PUBLISHER LEFT BEHIND stays there for ever: one more file in
  # a directory two unix accounts share, per crash, in /Users/Shared
  perl -0pi -e 's/      await sweep\(\);\n//' agent-engine/src/storage/limits-share.ts
  run X "nothing is ever swept"
fi

if want T; then
  # AN ENTRY IS BELIEVED BECAUSE IT PARSED: `{at, report:{}}` becomes a refusal
  # the endpoint never made
  perl -0pi -e 's/  return !!x && typeof x\.ok === "boolean" && typeof x\.fetchedAt === "number";/  return !!x;/' agent-engine/src/storage/limits-share.ts
  run T "anything that parses counts as a reading"
fi

# M TURNS THE GUARD OFF, so under it a harness engine really does start against
# whatever upstream the test names. That is why the spawning test
# (e2e/roundtrip.test.ts, "startEngine refuses an upstream that is not on this
# machine") names a `.invalid` host rather than api.anthropic.com: a mutation
# run that asks Anthropic for his usage numbers would be this branch's own
# defect, committed by the test that proves it fixed. Said here as well as
# there, because the two have to stay in step.
#
# O AND V ARE THE SAME HOLE ONE LAYER DOWN and spawn nothing at all: the whyNot*
# predicates are pure, so their spec is test-utils/guardrails.test.ts and no
# process is ever started under them. M, N and U are the only ones here that
# boot an engine, which is why they are the only three on SPEC_BOOT.

if want M; then
  # THE GUARD IS CHECKED, not merely written down: without the throw, a spec
  # can point a harness engine anywhere at all, with his real token
  SPEC=$SPEC_BOOT
  perl -0pi -e 's/  const why = whyNotLocalUpstream\(engineEnv\.CYC_LIMITS_API\) \?\?[\s\S]*?engineEnv\.CYC_SERVICES_LEASE_DIR\);/  const why = null;/' agent-engine/src/e2e/harness.ts
  run M "the harness no longer checks its upstream or its credentials"
fi

if want N; then
  # THE DEFAULT IS THERE: delete it and every harness engine goes back to the
  # live usage endpoint. This is the deletion the guard exists to survive, and
  # what it must do is FAIL LOUDLY rather than quietly reach the internet
  SPEC=$SPEC_BOOT
  perl -0pi -e 's/^    CYC_LIMITS_API: "http:\/\/127\.0\.0\.1:1",\n//m' agent-engine/src/e2e/harness.ts
  run N "the harness default upstream is deleted"
fi

if want O; then
  # WHAT COUNTS AS LOCAL: a guard that accepts everything is not a guard
  SPEC=$SPEC_GUARDS
  perl -0pi -e 's/  if \(host === "127\.0\.0\.1" \|\| host === "localhost" \|\| host === "::1" \|\| host === "\[::1\]"\) return null;/  return null;/' agent-engine/src/test-utils/guardrails.ts
  run O "every host counts as this machine"
fi

if want U; then
  # THE TOKEN: without the credentials override a harness engine reads his real
  # OAuth token out of the login keychain. Nothing reaches the wire either way,
  # which is exactly why this needed a check of its own
  SPEC=$SPEC_BOOT
  perl -0pi -e 's/^    CYC_LIMITS_CREDENTIALS: join\(dir, "credentials\.json"\),\n//m' agent-engine/src/e2e/harness.ts
  run U "the harness lets the engine reach the keychain"
fi

if want V; then
  # ...and the check on it, which is what makes deleting the default fail loudly
  SPEC=$SPEC_GUARDS
  perl -0pi -e 's/  if \(!path\) \{\n    return "there is no CYC_LIMITS_CREDENTIALS[^;]*;\n  \}/  if (!path) return null;/' agent-engine/src/test-utils/guardrails.ts
  run V "a missing credentials override is accepted"
fi

# ---------------------------------------------------------------------------
# I KILLS NOTHING, AND THAT IS THE RESULT RATHER THAN A GAP. Three corrections
# in a row live here, because each one was believed until it was measured.
#
# FIRST, what this section used to say: that I could not be killed from outside
# the process "without a hook in the module", and that the race would cost one
# duplicate request. Both false. A verifier raced sixty real processes against
# one instant with no hook at all and killed it in 3 rounds of 13, against 0 of
# 12 clean. It needed nothing clever, only ENOUGH ATTEMPTS.
#
# SECOND, writing that test found a race in the LINK version, which had been
# sitting behind the belief that none of this was testable. `readLease` answered
# null both for "there is no lease file" and for "it says nothing usable", and
# the caller read null as "dead, remove it". Absent is not dead: the holder had
# released it and somebody else had already claimed it. SIXTY-EIGHT overlapping
# holds, on code with no `wx` in it anywhere. That is mutation S, and S kills.
#
# THIRD -- and this is why I is still here saying nothing -- fixing that made
# `wx` HARMLESS. The empty-file window still opens, but nothing acts on it any
# more: a reader that cannot parse the lease no longer removes it. Measured, I
# run twice on its own: 33 pass, 0 fail, both times. (In one full run it took a
# test with it at 10119ms, which is the fetch timeout, i.e. a busy laptop and
# not a kill. A mutation that "kills" once in three runs is not a result.)
#
# So `link()` stays as defence in depth -- the same amount of code, and the bad
# state never exists rather than merely never being acted on -- and the thing
# under test is S. If somebody later removes the `!held` guard because "the link
# covers it", S will say so.

echo
echo "===== summary"
if (( ${#NOOP[@]} )); then
  echo "MUTATIONS THAT EDITED NOTHING (not results, bugs in this script): ${NOOP[*]}"
else
  echo "every mutation applied to a file."
fi
