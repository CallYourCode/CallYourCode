#!/bin/zsh
# Mutation runs for ONE SUPERVISOR PER HOST, reproducible by anyone.
#
# WHY THIS EXISTS, and why it is a separate file from verified-run.sh.
#
# The lease in agent-engine/src/runtime/services-lease.ts decides which of the agent engines
# on a Mac starts, restarts and memory-caps the services on it. Getting it wrong
# is not a cosmetic failure: without it the `work` account's engine can restart
# the kokoro that is speaking to him, a process on a host-wide port that it did
# not start and has no business touching. A green suite is not evidence that any
# part of that is load-bearing, and this lease has one shape that is very good at
# passing tests it is not doing any work in -- a service that binds instantly is
# adopted by the second engine before it can decide anything, and the whole
# lease can be deleted with every spec still green. That happened on this branch.
#
# So each condition is broken on purpose and exactly one spec has to die.
#
# THE VERDICT IS THE FAIL COUNT, never the marker: bun writes `✗ name` to a
# terminal and `(fail) name` to a pipe, and this script pipes. `0 pass 0 fail`
# and a missing summary are LOUD non-results, not green. All of that is
# verified-run.sh's judge, copied deliberately rather than reinvented.
#
# USAGE
#
#   e2e/mutation/services-run.sh            # every mutation
#   e2e/mutation/services-run.sh A D        # only those
#
# The engine specs start real processes and take about twenty seconds each; the
# lease's own specs are in-process and take a tenth of one. That is why the
# mechanism is proved against SERVICES_LEASE_SPEC and the outcome against SPEC.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
if [[ -n "$(git status --porcelain)" ]]; then
  echo "REFUSING: working tree is dirty. Commit first -- these mutations are"
  echo "undone with 'git checkout' and would discard whatever is uncommitted."
  exit 1
fi

# Restored by a trap, not by the happy path: a mutation left in the tree makes
# every result after it a report about a file nobody meant to change.
cleanup() { git checkout -- . 2>/dev/null || true; }
trap cleanup EXIT INT TERM

SPEC=agent-engine/src/runtime/services.test.ts
LEASE_SPEC=agent-engine/src/runtime/services-lease.test.ts
OUT=$(mktemp -d)
WANT=("$@")
NOOP=()

want() { [[ ${#WANT[@]} -eq 0 ]] && return 0; [[ " ${WANT[*]} " == *" $1 "* ]]; }

run() {  # $1 = letter, $2 = description, $3 = spec (default $SPEC)
  local spec="${3:-$SPEC}"
  # A mutation that edited no file proves nothing. Say so and keep the letter,
  # rather than running the suite against clean source and calling it a result.
  # BASE and BASE2 are the two unmutated runs, one per spec, so an unchanged
  # tree is what they are FOR. Anything else changing no file is a non-result.
  if [[ "$1" != BASE* && -z "$(git status --porcelain)" ]]; then
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
  count=$(print -r -- "$clean" | sed -n 's/^ *\([0-9][0-9]*\) fail[[:space:]]*$/\1/p' | tail -1)
  passed=$(print -r -- "$clean" | sed -n 's/^ *\([0-9][0-9]*\) pass[[:space:]]*$/\1/p' | tail -1)
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
    if [[ "$1" == BASE* ]]; then
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
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "   STOPPING: the tree is still dirty after reverting $1. Every result"
    echo "   after this one would be about a mutated tree."
    git status --porcelain | sed 's/^/   /'
    exit 1
  fi
}

echo "===== baseline"
run BASE "no mutation"
run BASE2 "no mutation" "$LEASE_SPEC"

# ---------------------------------------------------------------------------
# WHAT THE LEASE IS FOR: the two things a non-holding engine must never do.

if want A; then
  # the lease is taken and then ignored, which is exactly what this branch did
  # before services-lease.ts existed: every engine on the host supervises, so
  # kokoro is started by however many of them are up
  perl -0pi -e 's/    const holding = await this\.holds\(rt\);/    await this.holds(rt); const holding = true;/' agent-engine/src/runtime/services.ts
  run A "the lease is ignored: every engine acts"
fi

if want B; then
  # a watching engine fills an empty port: two supervisors both starting kokoro
  perl -0pi -e 's/      if \(!holding\) \{\n        this\.set\(rt, \{ note:/      if (false) {\n        this.set(rt, { note:/' agent-engine/src/runtime/services.ts
  run B "a watching engine starts the service anyway"
fi

if want C; then
  # THE ONE THAT WOULD HAVE DONE REAL DAMAGE: a watching engine acts on its own
  # ceiling reading, so the `work` engine restarts the kokoro he is listening to
  perl -0pi -e 's/    if \(!holding\) \{\n      this\.set\(rt, \{ \.\.\.seen,/    if (false) {\n      this.set(rt, { ...seen,/' agent-engine/src/runtime/services.ts
  run C "a watching engine restarts what is over the ceiling"
fi

# ---------------------------------------------------------------------------
# THE BOUND: a lease must not outlive its holder.

if want D; then
  # the pid is never asked about, so a crashed holder's lease is waited out
  # instead of taken. The takeover spec's stale window is a MINUTE and its
  # deadline is five seconds, so this is the only thing that can explain a pass.
  perl -0pi -e 's/      const gone = held\.kind === "held" && held\.pid > 0 && !pidAlive\(held\.pid\);/      const gone = false;/' agent-engine/src/runtime/services-lease.ts
  run D "a dead holder's lease is waited out instead of taken"
fi

if want E; then
  perl -0pi -e 's/      const gone = held\.kind === "held" && held\.pid > 0 && !pidAlive\(held\.pid\);/      const gone = false;/' agent-engine/src/runtime/services-lease.ts
  run E "the same, against the lease's own specs" "$LEASE_SPEC"
fi

if want F; then
  # EPERM read as "no such process": the other unix user's LIVE engine looks
  # dead from here, so both engines on his Mac take the lease off each other for
  # ever. This is the one mistake that turns the lease itself into the race.
  perl -0pi -e 's/    return \(e as NodeJS\.ErrnoException\)\?\.code === "EPERM";/    return false;/' agent-engine/src/runtime/services-lease.ts
  run F "another unix user's live engine reads as dead" "$LEASE_SPEC"
fi

if want G; then
  # the stamp is never judged old, so an engine that is running but has stopped
  # checking holds this host for ever and nothing says so
  perl -0pi -e 's/      const fresh = age >= 0 && age < this\.staleMs;/      const fresh = true;/' agent-engine/src/runtime/services-lease.ts
  run G "a stale lease is honoured for ever" "$LEASE_SPEC"
fi

if want H; then
  # only the upper bound kept: a stamp from a clock that ran ahead can never age
  # out, so a single bad write leaves the host unsupervised permanently
  perl -0pi -e 's/const fresh = age >= 0 && age < this\.staleMs;/const fresh = age < this.staleMs;/' agent-engine/src/runtime/services-lease.ts
  run H "a stamp from the future counts as fresh" "$LEASE_SPEC"
fi

# ---------------------------------------------------------------------------
# THE IDENTITY OF THE FILE: the name is shared, the claim is the inode.

if want I; then
  # an engine standing down unlinks whatever is on the name, including the lease
  # of whoever took over while it was wedged
  perl -0pi -e 's/      if \(\(await stat\(this\.path\)\)\.ino === ino\) await unlink\(this\.path\);/      await unlink(this.path);/' agent-engine/src/runtime/services-lease.ts
  run I "release deletes whatever is on the name" "$LEASE_SPEC"
fi

if want J; then
  # /health says this engine has supervised since its last renewal, which is
  # always a moment ago: the one number on that row that means anything is gone
  perl -0pi -e 's/since: this\.since \?\? at,/since: at,/' agent-engine/src/runtime/services-lease.ts
  run J "the holder has supervised since its last renewal" "$LEASE_SPEC"
fi

if want K; then
  # a renewal that writes nothing: the holder goes on holding a lease whose
  # stamp is ageing, and is taken over while it is healthy and checking
  perl -0pi -e 's/        await writeFile\(this\.path, JSON\.stringify\(\{ pid: process\.pid, at, who: this\.who \} satisfies LeaseFile\)\)\n          \.catch\(\(\) => \{\}\);\n//' agent-engine/src/runtime/services-lease.ts
  run K "a renewal does not refresh the stamp" "$LEASE_SPEC"
fi

if want L; then
  # no shared directory, so supervise anyway -- which is every engine on the
  # host supervising at once, the defect the whole file exists to prevent
  perl -0pi -e 's/      this\.mine = null;\n      return false;/      this.mine = null;\n      return true;/' agent-engine/src/runtime/services-lease.ts
  run L "an engine that cannot take the lease supervises anyway" "$LEASE_SPEC"
fi

# ---------------------------------------------------------------------------
# GETTING IN AT ALL. Both of these were real on his Mac before they were fixed:
# /Users/Shared/callyourcode is 0755 and `work`'s, so the other account's
# engine could neither create the leaf nor, having failed once, ever try again.

if want M; then
  # the first "no" is remembered for the life of the process: an engine that
  # started before the directory was reachable watches for ever
  perl -0pi -e 's/    if \(!ok\) this\.dirReady = null;\n//' agent-engine/src/runtime/services-lease.ts
  run M "a lease directory that was missing once is missing for ever" "$LEASE_SPEC"
fi

if want N; then
  # the leaf is left at whatever the umask made it (0755), so the other account
  # can read the lease and never take it over: an unlink needs write on the dir
  perl -0pi -e 's/      await chmod\(this\.dir, 0o777\)\.catch\(\(\) => \{\}\);\n//' agent-engine/src/runtime/services-lease.ts
  run N "the lease directory is left shut to the other account" "$LEASE_SPEC"
fi

if want S; then
  # the default goes back beside the limits lease, under a directory owned by
  # whichever account created it first. THIS IS THE ONE THAT SHIPPED: only
  # `work` could create the leaf, and `work` is the account with no kokoro.
  perl -0pi -e 's{"/Users/Shared/callyourcode-services"}{"/Users/Shared/callyourcode/services"}' agent-engine/src/runtime/services-lease.ts
  run S "the default lease directory needs its parent's owner" "$LEASE_SPEC"
fi

# ---------------------------------------------------------------------------
# THE PARTITION. The lease is per (host, SERVICE) and only an engine that can
# start that service contends for it. A host lease held by an account that can
# start nothing is a machine with no supervisor and a /health that says it has
# one, which is what this branch shipped before the verifier measured it.

if want O; then
  # capability ignored: an engine holds the supervision of a service it cannot
  # start, and since deploy-engines.sh restarts `work` FIRST, that is the one
  # that wins on every deploy
  #
  # THE PATTERN WENT STALE ONCE, and the no-op guard caught it: the commit that
  # collapsed this to one question ("one answer to does this engine supervise
  # it, not two") left the old two-clause pattern matching nothing, so the one
  # condition a verification had blocked on was the one nothing proved. It now
  # targets the line that exists. Keeping the watch-service half (`rt.lease ===
  # null`) is deliberate: without it the mutant dereferences a null lease and
  # fails for the wrong reason.
  perl -0pi -e 's/    if \(why !== null\) \{/    if (why !== null \&\& rt.lease === null) {/' agent-engine/src/runtime/services.ts
  run O "an engine holds supervision of what it cannot start"
fi

if want P; then
  # one lease for the whole host again: two services become one contest, so the
  # engine that can start either one stands down over both
  perl -0pi -e 's{    this\.path = .*\n}{    this.path = this.dir + "/supervisor.lease";\n}' agent-engine/src/runtime/services-lease.ts
  run P "the lease is per host again, not per service" "$LEASE_SPEC"
fi

if want Q; then
  # no re-entrancy guard: a pass that outlives the interval is walked by two
  # ticks at once, and each can start what the other just started
  perl -0pi -e 's/    if \(this\.checking\) \{\n      this\.log\("a check was still running when the next one came round; skipping this tick"\);\n      return;\n    \}\n//' agent-engine/src/runtime/services.ts
  run Q "two checks may run at once"
fi

if want R; then
  # the child's log is opened and never rolled, which is what it did before:
  # kokoro writes a line per request and the file grows until the disk does
  perl -0pi -e 's/openSync\(this\.rollLog\(spec\.key\), "a"\)/openSync(join(this.logDir, spec.key + ".log"), "a")/' agent-engine/src/runtime/services.ts
  run R "a child's log is never rolled"
fi

# ---------------------------------------------------------------------------
# THE VOICE UNIT: all-or-none (#330). kokoro, stt and whisper are one thing --
# every member up, or none. Each mutation breaks one half of that and exactly
# one of the three unit specs has to die. These are the engine specs (real
# processes), so they take about twenty seconds each; that is why the whole
# suite is not re-run per mutation in CI, only these letters when the rule
# changes.

if want U; then
  # the all-or-none GATE is neutralised: a member is never held down for its
  # unit, so kokoro and stt start (and stay up) while whisper is absent -- the
  # partial voice stack the rule exists to forbid
  perl -0pi -e 's/ && blocked\.has\(spec\.unit\)\) \{/ && false) {/' agent-engine/src/runtime/services.ts
  run U "a unit member is never held down for the unit"
fi

if want V; then
  # the STOP is removed: when whisper goes away, a running kokoro/stt is no
  # longer taken down, so the unit sits half-up for ever. This is the
  # load-bearing half -- taking the unit down must stop every member it can.
  perl -0pi -e 's/      await this\.stopForUnit\(rt, pid\);\n//' agent-engine/src/runtime/services.ts
  run V "a running member is not stopped when the unit cannot be whole"
fi

if want W; then
  # the health predicate is stuck false: a whole unit never reports healthy, so
  # "all members up = healthy" has nothing behind it
  perl -0pi -e 's/      const healthy = down\.length === 0;/      const healthy = false;/' agent-engine/src/runtime/services.ts
  run W "a whole unit never reports healthy"
fi

if want X; then
  # the health predicate is stuck true: a unit with a member down still reports
  # healthy, so "any member down = unit down" has nothing behind it
  perl -0pi -e 's/      const healthy = down\.length === 0;/      const healthy = true;/' agent-engine/src/runtime/services.ts
  run X "a unit with a member down still reports healthy"
fi

# ---------------------------------------------------------------------------
# THE LAUNCHD UNIT MEMBER: the voice engine is a KeepAlive job, so its stop is a
# `launchctl bootout` and its start a `bootstrap` -- not a pid kill, which
# KeepAlive would flap. Each of these breaks one half and exactly one launchd
# spec dies.

if want Y; then
  # the launchd STOP dispatch is removed: a launchd member takes the spawn kill
  # path (SIGTERM its pid) instead of a bootout, which under KeepAlive would
  # start straight back -- no bootout is ever issued
  perl -0pi -e 's/if \(spec\.revive\.how === "launchd"\) \{\n      await this\.stopLaunchd/if (false) {\n      await this.stopLaunchd/' agent-engine/src/runtime/services.ts
  run Y "a launchd unit member is not bootout'\''d on teardown"
fi

if want Z; then
  # the bring-back is broken: the revive no longer bootstraps the bootout'd job,
  # so a stop becomes a kill -- the member is down for ever
  perl -0pi -e 's/\["bootstrap", /["print", /' agent-engine/src/runtime/services.ts
  run Z "a bootout'\''d launchd member is never bootstrapped back"
fi

if want AA; then
  # the holder gate on the unit teardown is removed, so a WATCHER bootouts the
  # launchd member -- the `work` engine taking down the voice engine his engine
  # supervises
  perl -0pi -e 's/      if \(!holding\) \{\n        this\.set\(rt, \{ running: pid !== null, pid, owned: false, starting: false,/      if (false) {\n        this.set(rt, { running: pid !== null, pid, owned: false, starting: false,/' agent-engine/src/runtime/services.ts
  run AA "a watcher bootouts a launchd member it does not supervise"
fi

# ---------------------------------------------------------------------------
# THE VOICE FRAME (item 8): the voice unit's health rides the live {t:"voice"}
# frame, so the app hides the mic, press-and-hold and call mode when there is no
# voice. Each mutation breaks one half and a NAMED spec dies. The connect-frame
# proofs run against the server spec (a real engine); the flip callback is the
# in-process services spec.

VOICE_SPEC=agent-engine/src/voice/voiceframe.test.ts

if want VA; then
  # the connect frame drops the health field, so the app cannot tell a new engine
  # that means healthy:false from an old one that never heard of the field
  perl -0pi -e 's/send\(ws, \{ t: "voice", url: VOICE_PUBLIC_URL, healthy: voiceHealthy\(\) \}\);/send(ws, { t: "voice", url: VOICE_PUBLIC_URL });/' agent-engine/src/runtime/server.ts
  run VA "the connect voice frame carries no healthy field" "$VOICE_SPEC"
fi

if want VB; then
  # no voice unit defaults to healthy:true, which is the app assuming a mic that
  # is not there -- the exact "assert what it does not know" this item kills
  perl -0pi -e 's/  return u \? u\.healthy : false;/  return u ? u.healthy : true;/' agent-engine/src/runtime/server.ts
  run VB "no voice unit defaults to healthy:true" "$VOICE_SPEC"
fi

if want VC; then
  # the flip is never broadcast: a member dies mid-session and every client keeps
  # the connect-time frame, so the app shows a mic that records into nothing
  perl -0pi -e 's/    broadcast\(\{ t: "voice", url: VOICE_PUBLIC_URL, healthy \}\);\n//' agent-engine/src/runtime/server.ts
  run VC "a mid-session flip is not rebroadcast to clients" "$VOICE_SPEC"
fi

if want VD; then
  # Services never tells the server a unit's health changed, so the flip callback
  # fires on no flip at all -- the whole live-update path has nothing behind it
  perl -0pi -e 's/      this\.emitUnitHealthChanges\(\);\n(    \} finally \{)/$1/' agent-engine/src/runtime/services.ts
  run VD "a unit health flip is never reported to onUnitHealth"
fi

echo "===== tree: $(git status --porcelain | wc -l | tr -d ' ') modified (should be 0)"
rm -rf "$OUT"

if (( ${#NOOP[@]} )); then
  echo "===== FAILED: mutation(s) ${NOOP[*]} applied to nothing."
  echo "      This run says NOTHING about the conditions they name."
  exit 1
fi
