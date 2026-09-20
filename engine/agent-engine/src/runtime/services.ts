/* THE LONG-RUNNING SERVICES ON THIS HOST: started by the engine, restarted by
 * the engine, and answered for on /health.
 *
 * The architecture is launchd -> agent engine -> everything else on this
 * machine. Two things sat outside it until this file: kokoro (the TTS server)
 * and scripts/memory-guard.sh, both started by hand in a herdr tab and found
 * there on 2026-08-04 only because clearing the workspace left them as the last
 * two non-agent things running. A service in a tab dies with the tab, nothing
 * brings it back, and nothing anywhere can say whether it is up. The guard made
 * that worse than it sounds: it is the ceiling that exists BECAUSE kokoro once
 * reached 16 GB over four days unnoticed, so closing one tab silently removed
 * the protection against the exact failure it was written for.
 *
 * So this file is the guard, moved inside the process that is itself
 * supervised, plus the ability the guard never had: it can START kokoro, not
 * just notice it is missing.
 *
 * WHAT IT WILL AND WILL NOT DO TO A PROCESS
 *
 * It only kills what it can bring back. The guard ran once per machine, in one
 * tab; this runs in every agent engine on the host (example's :10101 and work's
 * :7790 are two processes), so an action taken on a shared port is now taken by
 * however many engines are running. Restarting kokoro twice is harmless -- the
 * second engine finds the port busy and adopts it. Killing something neither
 * engine can start again is not: it would take speech away and leave no one
 * responsible for bringing it back. On a host that only ADOPTS a service it
 * cannot start (kokoro under systemd on linux, with no ~/.voicemode checkout),
 * that service's footprint is REPORTED and never acted on. That is the one
 * deliberate difference from memory-guard.sh, which killed it and hoped the
 * owner noticed.
 *
 * A SERVICE THIS ENGINE DID NOT START IS STILL WATCHED
 *
 * If the port is already answering when the engine boots -- his kokoro from
 * before this existed, systemd's on linux, or the copy left behind by the
 * engine that just restarted -- it is adopted, not duplicated. `owned` says
 * which of the two it is, because "I started this and I am watching it exit"
 * and "something is listening and I can see its memory" are different amounts
 * of knowledge and /health may not blur them.
 *
 * `owned` IS NOT PROTECTION, and saying so plainly because it reads like it.
 * The ceiling restart kills the LISTENING pid, whoever started it, so an
 * adopted kokoro from a herdr pane does get SIGTERM'd and comes back as this
 * engine's child once it passes 6000 MB. That is what memory-guard.sh did and
 * it is the point of the ceiling: the leak that started all of this was in a
 * hand-started kokoro, and a leak is not less of a leak for who launched it.
 * `owned` reports provenance, not immunity.
 *
 * CHILDREN OUTLIVE THE ENGINE ON PURPOSE, AND THAT TAKES A PLIST KEY
 *
 * Nothing HERE kills its children on the way out, but that alone was not
 * enough and the header used to claim it was. Bun.spawn children share the
 * engine's process group, and launchd kills the group when the job goes: with
 * the plists as they were, `launchctl kickstart -k` -- exactly what
 * scripts/deploy-engines.sh runs -- killed a spawned child within 3 seconds,
 * measured. So deploy/macos/*.plist carry AbandonProcessGroup, and the promise
 * lives half in this file and half there. He restarts engines constantly,
 * kokoro takes ten seconds to load its models, and a deploy that took speech
 * away every time would be worse than the hand-started tab this replaced. The
 * next engine adopts what the last one left, which is the same path a fresh
 * boot already had to handle.
 *
 * REAL FOOTPRINT, NOT RSS. macOS compresses idle pages: kokoro showed 30 MB of
 * RSS against 16 GB of real footprint, so any ceiling reading RSS would have
 * missed the leak that motivated all of this. phys_footprint from
 * proc_pid_rusage is what Activity Monitor shows and what is read here, through
 * the same python3 shim memory-guard.sh used.
 */

import { chmodSync, existsSync, openSync, renameSync, statSync } from "node:fs";
import { servicesLogDir } from "../storage/datadir.ts";
import { FILE_MODE, mkdirPrivateSync } from "../../../shared/runfiles.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { HostLease, type LeaseView } from "./services-lease.ts";
import { rawModelChoices, whisperModelName, kokoroModelName,
  currentWhisperSize, currentKokoroVariant, modelPresencePaths } from "../voice/voicemodels.ts";

/** How the engine gets a service back when it is not there. */
export type Revive =
  /** The engine spawns it and owns the child. */
  | { how: "spawn"; cmd: string[]; cwd: string; env?: Record<string, string>;
      /** Paths that must exist for the command to be startable at all. A work
       *  account with no kokoro checkout says so instead of failing forever. */
      needs?: string[] }
  /** Somebody else's supervisor owns it; this is the net under that supervisor. */
  | { how: "launchd"; label: string; plist: string }
  /** Watched and reported, never touched. */
  | { how: "watch" };

export type ServiceSpec = {
  key: string;
  name: string;
  port: number;
  /** Real footprint, in MB, at which the service is restarted. */
  ceilingMb: number;
  revive: Revive;
  /** The model file this service is CONFIGURED to serve, or undefined for a
   *  service with no chosen model. Only an EXPLICIT choice in the voice-models
   *  store (voicemodels.ts) stamps this: with no choice on record the engine
   *  claims nothing about model files, so no existing install's /health
   *  changes. When it is set and the file is missing, every note this table
   *  writes says so LOUDLY (set()), and nothing ever substitutes another
   *  model. */
  model?: { name: string; path: string };
  /** THE PRESENCE GATE: the file(s) this service NEEDS on disk before it can
   *  run at all, stamped from the CURRENT (chosen-or-default) model. Distinct
   *  from `model` above on purpose: `model` is the loud /health claim only an
   *  explicit choice earns; this is a fact about what the process would load,
   *  and it exists for the fresh install whose models are still downloading in
   *  the background (modelwarmup.ts). While any path is missing:
   *    - a spawn service is NOT started (no crash-looping uvicorn over a
   *      missing .pth); it starts the moment the files land;
   *    - a watch-only unit member does NOT force its unit down (blockedUnits):
   *      it cannot possibly be up, and holding every startable member hostage
   *      for the whole first download would defeat per-capability warm-up. The
   *      unit still reports not-whole, so the mic stays hidden. */
  needsModel?: { name: string; paths: string[] };
  /** The unit this service belongs to, or undefined for one that stands alone.
   *
   *  A UNIT IS ALL-OR-NONE: every member up, or none of them. The voice services
   *  only make sense together (there is no use in kokoro's speech with no
   *  transcriber to answer, or a transcriber with nothing that speaks), so they
   *  share a unit name and the engine drives them as one thing: the unit is
   *  HEALTHY only when every member is listening, and a member that nothing on
   *  this host can start (an adopted-only kokoro, say) being down means the unit
   *  cannot be whole, so the members this engine CAN start are taken down rather
   *  than left in a partial state. See defaultServices() for the membership. */
  unit?: string;
};

/** What /health says about one service. Every field is something this process
 *  has looked at, never something it assumed. */
export type ServiceState = {
  key: string;
  name: string;
  port: number;
  ceilingMb: number;
  /** Something is listening on the port. Not "we started it once". */
  running: boolean;
  /** The listening pid right now, or null. Never a remembered one. */
  pid: number | null;
  /** This engine spawned the process that is listening. */
  owned: boolean;
  /** A child this engine started that has not bound its port yet. */
  starting: boolean;
  /** Real footprint in MB, or null when it could not be measured. Never 0 for
   *  "unknown": 0 MB is a reading, and this field has to be able to say it has
   *  none. */
  footprintMb: number | null;
  /** Times this engine has (re)started it since boot. */
  restarts: number;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
  /** When this engine last looked at the port. */
  checkedAt: number;
  /** Who supervises THIS service on this host, and whether it is this engine.
   *  Per service rather than per host because the ability to start one is per
   *  unix account: see services-lease.ts. */
  supervisor: LeaseView;
  /** The unit this service belongs to, echoed from its spec, or undefined for
   *  one that stands alone. A reader of one row can see it is part of a whole
   *  without cross-referencing the units summary. */
  unit?: string;
  /** The configured model file and whether it is actually on disk, for a
   *  service whose spec names one. `present:false` is the LOUD failure the
   *  voice-model commands promise: the chosen model is missing and the engine
   *  will not silently switch to another. Undefined when no model was ever
   *  chosen for this service. */
  model?: { name: string; path: string; present: boolean };
  /** The state in a sentence, for a person reading /health. */
  note: string;
};

/** What /health says about one unit: the all-or-none whole its members form. */
export type UnitState = {
  name: string;
  /** Every member is listening. This is the only sense in which a unit is "up".
   *  A unit with one member down is not degraded, it is DOWN: that is the point
   *  of all-or-none, and "runs none at all" is a coherent down, not a fault. */
  healthy: boolean;
  /** Its members' keys, in table order. */
  members: string[];
  /** The unit in a sentence, for a person reading /health. */
  note: string;
};

export type ServicesOpts = {
  /** Routine readings: what the guard printed into its pane. */
  log?: (line: string) => void;
  /** Incidents: gone, started, exited, over the ceiling. The record that has to
   *  survive, so the question "how often does this happen" has an answer. */
  incident?: (line: string) => void;
  intervalMs?: number;
  /** Checks a launchd-owned service must be missing before this engine acts.
   *  Its own supervisor gets first refusal: KeepAlive is back inside a second,
   *  so seeing it down twice means supervision failed, not the service. */
  graceTicks?: number;
  /** First wait before restarting a child that exited, doubling to the max. */
  restartBaseMs?: number;
  restartMaxMs?: number;
  /** Where a child's stdout and stderr go. */
  logDir?: string;
  /** Where the one-supervisor-per-host lease lives. See services-lease.ts. */
  leaseDir?: string;
  /** How long an unrenewed lease may sit before another engine may take it.
   *  Defaults to three check intervals, so a holder has to miss three in a row. */
  leaseStaleMs?: number;
  /** How a launchctl subcommand is run, as (deadlineMs, argsAfterLaunchctl).
   *  Real by default (a bounded `launchctl <args>`). A test injects a fake so a
   *  spec can prove the STOP (bootout) and START (bootstrap) of a launchd unit
   *  member without ever touching a real com.callyourcode.* label or the running
   *  user's launchd domain -- which a test must never do. */
  launchctl?: (ms: number, args: string[]) =>
    Promise<{ code: number | null; out: string; timedOut: boolean }>;
  /** How a pid's real footprint in MB is read. The real one by default.
   *
   *  INJECTED FOR THE SAME REASON `launchctl` IS: the real reader is macOS
   *  only. It pulls proc_pid_rusage out of `/usr/lib/libSystem.dylib` (see
   *  footprintMb), which is the right answer on his Mac and the only answer
   *  that catches the leak this file exists for -- and it returns null on
   *  every other platform, so on Linux the ceiling branch could not be reached
   *  at all. Three specs that believed they were proving the ceiling were
   *  really watching python3 fail: `mb === null` took the "not being enforced"
   *  path every time. A spec supplies a reading instead of a machine, which is
   *  also what makes "over the ceiling" instant rather than a real leak.
   *
   *  It is a seam, not a shortcut: the DECISION (restart it, report it, leave a
   *  watch-only one alone, refuse when this engine does not hold the lease) is
   *  the shipped code either way. Only the number comes from elsewhere. */
  footprint?: (pid: number) => Promise<number | null>;
  /** Fired when a UNIT's all-or-none health FLIPS from the last observed value,
   *  once per flip and never every tick. A unit is healthy only when all its
   *  members are listening (units()), so this is the moment a member died mid
   *  session or came back. The first look at a unit only seeds the baseline and
   *  does not fire: a flip needs a previous value to differ from, and a client
   *  connecting now already reads the current value on its connect frame. The
   *  server rebroadcasts the voice frame on this, so a mic that would record
   *  into nothing is hidden without a reload. */
  onUnitHealth?: (unit: string, healthy: boolean) => void;
  /** Fired after EVERY settled pass (the periodic check and a child-exit
   *  recheck alike), once the rows and units are decidable. The server's
   *  per-capability voice-readiness broadcast hangs off this and diff-gates
   *  itself, so a pass that changed nothing reaches no client. */
  onCheck?: () => void;
};

/* How long ANY single launchctl call may take.
 *
 * `launchctl kickstart -k` does NOT return on a job that is loaded but whose
 * binary cannot spawn: launchd parks it in "spawn scheduled" with EX_CONFIG and
 * the client waits for a start that never happens (measured still blocked at
 * 50s, past 100s twice). Unbounded, that freezes the whole check loop and every
 * ceiling silently stops being enforced for as long as it lasts -- worse than
 * the outage this exists for, because nothing says it is happening.
 *
 * 30s, and not the obvious smaller number: a kickstart of a HEALTHY job takes
 * about 9s, because -k waits for the old instance to die and the new one to come
 * up. A 5 or 10 second bound would have killed the working path and looked like
 * a fix. */
const LAUNCHCTL_MS = 30_000;
/** `launchctl print` answers in about 0s whether the job is loaded or not, so it
 *  is asked first and nothing is inferred from a failure. */
const LAUNCHCTL_PRINT_MS = 10_000;
/** A revive through somebody else's supervisor backs off the way the guard did:
 *  60s doubling to half an hour, so a service failing for a real reason (port
 *  taken, bad build) is not hammered and every attempt is on the record. */
const LAUNCHD_BACKOFF_BASE_MS = 60_000;
const LAUNCHD_BACKOFF_MAX_MS = 1_800_000;
/** A child's log is rolled once past this, at its next start. */
const LOG_ROLL_BYTES = 64 * 1_048_576;

/** Physical footprint in MB: what Activity Monitor shows, including compressed
 *  pages. Null when it cannot be read, which is not the same as zero.
 *
 *  macOS only, deliberately: it reads proc_pid_rusage out of libSystem. On
 *  linux the answer is null and /health says the ceiling is not being enforced
 *  from here, which is the truth -- systemd's MemoryMax is doing it there
 *  (deploy/linux/README.md), and a second enforcer would only fight it. */
const FOOTPRINT_PY = `
import ctypes, sys
class R(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [
        (n, ctypes.c_uint64) for n in (
            "user_time system_time pkg_idle_wkups interrupt_wkups pageins wired_size "
            "resident_size phys_footprint proc_start_abstime proc_exit_abstime "
            "child_user_time child_system_time child_pkg_idle_wkups child_interrupt_wkups "
            "child_pageins child_elapsed_abstime diskio_bytesread diskio_byteswritten "
            "cpu_time_qos_default cpu_time_qos_maintenance cpu_time_qos_background "
            "cpu_time_qos_utility cpu_time_qos_legacy cpu_time_qos_user_initiated "
            "cpu_time_qos_user_interactive billed_system_time serviced_system_time"
        ).split()
    ]
lib = ctypes.CDLL("/usr/lib/libSystem.dylib")
r = R()
if lib.proc_pid_rusage(int(sys.argv[1]), 4, ctypes.byref(r)) != 0:
    raise SystemExit(1)
print(int(r.phys_footprint / 1048576))
`;

/** Run a command with a wall-clock deadline. macOS ships no timeout(1), and the
 *  deadline is wall clock rather than a count of sleeps: a nominal 30s bound
 *  built out of 120 sleeps took 44s and then logged "did not answer in 30s",
 *  which is a poor deadline that also misreports itself in the only account
 *  anybody gets. */
async function bounded(ms: number, cmd: string[]): Promise<{
  code: number | null; out: string; timedOut: boolean;
}> {
  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (e) {
    return { code: null, out: String(e), timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(9); }, ms);
  const out = await new Response(proc.stdout).text().catch(() => "");
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out, timedOut };
}

/** The pid listening on a TCP port, or null when nothing is. lsof answers only
 *  for sockets this user owns: a non-root process sees its own, never another
 *  user's. So a service another user on the same host is serving reads as null
 *  here even while it answers on loopback. Use portOpen to ask the port itself
 *  whether something is there; use this only when the owning pid is wanted. */
export async function listeningPid(port: number): Promise<number | null> {
  const { out } = await bounded(5_000,
    ["lsof", "-tnP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  const first = out.trim().split(/\s+/)[0];
  const pid = Number(first);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Whether something is listening on the loopback port, asked by connecting to
 *  it rather than by listing processes. A TCP connect crosses users: it sees a
 *  service another account on the same host serves, which lsof under a non-root
 *  user cannot. This is the true test of "is the port up"; the pid is a bonus
 *  only the owning user gets. */
export async function portOpen(port: number, ms = 2_000): Promise<boolean> {
  let socket: { end(): void } | null = null;
  try {
    socket = await Promise.race([
      Bun.connect({
        hostname: "127.0.0.1", port,
        socket: { data() {}, open() {}, error() {}, close() {} },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("connect timed out")), ms)),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    try { socket?.end(); } catch { /* already gone */ }
  }
}

/** Real footprint of a pid in MB, or null when it could not be measured. */
export async function footprintMb(pid: number): Promise<number | null> {
  const { code, out, timedOut } = await bounded(10_000,
    ["python3", "-c", FOOTPRINT_PY, String(pid)]);
  if (timedOut || code !== 0) return null;
  const mb = Number(out.trim());
  return Number.isFinite(mb) ? mb : null;
}

const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

type Runtime = {
  spec: ServiceSpec;
  child: Subprocess | null;
  /** Consecutive checks this service has been missing. */
  down: number;
  /** Revive attempts since it was last seen listening. Drives the backoff. */
  attempts: number;
  /** No attempt before this moment. */
  nextAttemptAt: number;
  /** Set while a restart is in flight, so a tick cannot start a second one. */
  busy: boolean;
  /** This service's supervision lease, or null for one nothing can start. */
  lease: HostLease | null;
  state: ServiceState;
};

/** Why this engine cannot start this service RIGHT NOW, or null when it can.
 *
 *  This is the qualification to hold its lease, and it is deliberately asked of
 *  the filesystem on every check rather than remembered: `homedir()` is the
 *  running account's, so the same table answers differently in his engine and
 *  in `work`'s, and a checkout that goes away should cost the lease rather than
 *  leave a supervisor that cannot supervise. */
/** A revive this engine can actually drive. `watch` is somebody else's job. */
export type StartableRevive = Exclude<Revive, { how: "watch" }>;

/* THE SAME RULE cannotStart's first line states, in the form the checker can
 * follow. cannotStart answers a REASON, for a person; this answers a TYPE, and
 * the two agree by construction because both test `how === "watch"`. Without it
 * the three start/revive paths below -- each already unreachable for a watched
 * service, but only via `cannotStart(...) === null` or `holds(rt)`, which are
 * opaque to narrowing -- passed a possible `{how:"watch"}` to helpers that take
 * only the spawn or launchd arm. */
export function startable(revive: Revive): revive is StartableRevive {
  return revive.how !== "watch";
}

/** The first needsModel path that is not on disk, or null when the gate is
 *  open (no gate declared, or every file present). A `.part` temp file never
 *  opens the gate: the atomic downloader (voicemodels.ts download) renames the
 *  finished file into place, so the gated path existing means a whole model. */
export function missingModelPath(spec: ServiceSpec): string | null {
  return spec.needsModel?.paths.find((p) => !existsSync(p)) ?? null;
}

export function cannotStart(spec: ServiceSpec): string | null {
  const r = spec.revive;
  if (r.how === "watch") return "nothing on this engine starts it";
  if (r.how === "spawn") {
    const missing = (r.needs ?? []).find((p) => !existsSync(p));
    return missing ? `${missing} does not exist` : null;
  }
  /* launchd: `gui/<uid>/<label>` is the RUNNING user's domain, and the plist
   * path is built from that user's home, so an account without the LaunchAgent
   * cannot kickstart or bootstrap the job however loaded it is elsewhere. */
  return existsSync(r.plist) ? null : `${r.plist} does not exist`;
}

export class Services {
  private rts: Runtime[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;
  private readonly log: (line: string) => void;
  private readonly incident: (line: string) => void;
  private readonly intervalMs: number;
  private readonly graceTicks: number;
  private readonly restartBaseMs: number;
  private readonly restartMaxMs: number;
  private readonly logDir: string;
  /** How a launchctl subcommand is run. Real by default; a test injects a fake
   *  so a launchd member can be stopped and started without a real label. */
  private readonly runLaunchctl: (ms: number, args: string[]) =>
    Promise<{ code: number | null; out: string; timedOut: boolean }>;
  /** How a pid's footprint is read. Real by default; see ServicesOpts.footprint. */
  private readonly readFootprint: (pid: number) => Promise<number | null>;
  /** Told when a unit's health flips. Diff-gated against lastUnitHealthy so it
   *  fires on a change, not every tick. */
  private readonly onUnitHealth: (unit: string, healthy: boolean) => void;
  /** Told after every settled pass. See ServicesOpts.onCheck. */
  private readonly onCheck: () => void;
  /** The last health seen for each unit, so a flip can be told from a repeat.
   *  A unit missing from the map has not been looked at yet: its first look
   *  seeds this and does not fire. */
  private readonly lastUnitHealthy = new Map<string, boolean>();
  /** Set while a pass is running. A real pass can take longer than the interval
   *  (a bounded `launchctl print` is 10s and a `kickstart` 30s, before four
   *  services' worth of lsof), and two passes over the same runtime both
   *  deciding a service is missing is two starts. */
  private checking = false;

  constructor(specs: ServiceSpec[], opts: ServicesOpts = {}) {
    this.log = opts.log ?? (() => {});
    this.incident = opts.incident ?? this.log;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.graceTicks = opts.graceTicks ?? 2;
    this.restartBaseMs = opts.restartBaseMs ?? 1_000;
    this.restartMaxMs = opts.restartMaxMs ?? 60_000;
    this.logDir = opts.logDir ?? servicesLogDir() + "/";
    this.runLaunchctl = opts.launchctl ?? ((ms, args) => bounded(ms, ["launchctl", ...args]));
    this.readFootprint = opts.footprint ?? footprintMb;
    this.onUnitHealth = opts.onUnitHealth ?? (() => {});
    this.onCheck = opts.onCheck ?? (() => {});
    this.rts = specs.map((spec) => ({
      spec, child: null, down: 0, attempts: 0, nextAttemptAt: 0, busy: false,
      /* A LEASE PER SERVICE, and none for one nothing can start. A watch-only
       * service (an adopted-only kokoro on linux) is watched by every engine and
       * touched by none, so there is nothing for an engine to be the one of, and
       * a lease for it would only be a file. */
      lease: spec.revive.how === "watch" ? null : new HostLease({
        name: spec.key,
        dir: opts.leaseDir,
        staleMs: opts.leaseStaleMs ?? this.intervalMs * 3,
        log: (line) => this.incident(`supervision (${spec.name}): ${line}`),
      }),
      state: {
        key: spec.key, name: spec.name, port: spec.port, ceilingMb: spec.ceilingMb,
        running: false, pid: null, owned: false, starting: false, footprintMb: null,
        restarts: 0, lastExit: null, checkedAt: 0,
        supervisor: { holder: false, pid: null, since: null, note: "not looked at yet" },
        unit: spec.unit,
        note: "not looked at yet",
      },
    }));
  }

  /** Look at everything once, THEN start the loop. The first check is awaited so
   *  that by the time this engine answers /health, no service is being described
   *  from a default. "not looked at yet" is a state nothing outside this file
   *  should ever see. */
  async start(): Promise<void> {
    await this.check();
    this.timer = setInterval(() => { void this.check(); }, this.intervalMs);
  }

  /** Stop watching. Children are deliberately left running: see the header.
   *  The lease is given back, so the engine that replaces this one takes it on
   *  its first check instead of waiting for the pid check or the stale window. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
    for (const rt of this.rts) void rt.lease?.release();
  }

  health(): ServiceState[] {
    return this.rts.map((rt) => ({ ...rt.state }));
  }

  /** The units on this host and whether each is whole, from the last look at
   *  every member. A unit is HEALTHY only when all of its members are listening;
   *  anything less is DOWN, deliberately, so a partial voice stack reads as a
   *  coherent "not whole" rather than a mix of green rows that together do not
   *  work. This is the one decision that covers all members at once. */
  units(): UnitState[] {
    const names: string[] = [];
    for (const rt of this.rts) {
      const u = rt.spec.unit;
      if (u !== undefined && !names.includes(u)) names.push(u);
    }
    return names.map((name) => {
      const members = this.rts.filter((rt) => rt.spec.unit === name);
      const down = members.filter((rt) => !rt.state.running);
      const healthy = down.length === 0;
      return {
        name,
        healthy,
        members: members.map((rt) => rt.spec.key),
        note: healthy
          ? `whole: all ${members.length} members are listening`
          : `not whole: ${down.map((rt) => rt.spec.name).join(", ")} ` +
            `${down.length === 1 ? "is" : "are"} not up, so the whole unit is down`,
      };
    });
  }

  /** Tell onUnitHealth about any unit whose all-or-none health FLIPPED since the
   *  last look, and about no others. The first look at a unit only records its
   *  value: a flip needs a previous one to differ from, and a client connecting
   *  then already has the current value on its connect frame, so seeding is not
   *  a change to broadcast. Synchronous and diff-gated, so a pass that changed
   *  nothing emits nothing and a pass cannot fire the same value twice. */
  private emitUnitHealthChanges(): void {
    for (const u of this.units()) {
      const prev = this.lastUnitHealthy.get(u.name);
      this.lastUnitHealthy.set(u.name, u.healthy);
      if (prev !== undefined && prev !== u.healthy) this.onUnitHealth(u.name, u.healthy);
    }
  }

  async check(): Promise<void> {
    /* ONE PASS AT A TIME. A pass is not instant and is not bounded by the
     * interval: `launchctl print` may take 10s and a kickstart 30s, and four
     * services' lsof sit behind them, so a 60s tick can land on a pass still
     * running. Two of them walking the same runtimes would each see a service
     * missing and each start one. */
    if (this.checking) {
      this.log("a check was still running when the next one came round; skipping this tick");
      return;
    }
    this.checking = true;
    try {
      /* WHICH UNITS CANNOT BE WHOLE, decided ONCE before any member is acted on.
       * A unit is blocked when a member nothing on this host can start (a
       * watch-only one, e.g. an adopted-only kokoro) is not listening: all-or-none
       * then means the startable members must come down, not stay up in a partial
       * state. This is asked first, in its own pass, because table order does not
       * guarantee the blocker is seen before the members it blocks, and deciding a
       * startable member on a stale view of the blocker is the whole bug this pass
       * prevents. */
      const blocked = await this.blockedUnits();
      for (const rt of this.rts) {
        if (this.stopped) return;
        await this.checkOne(rt, blocked);
      }
      /* A whole pass has settled every member, so the units are now decidable
       * without a half-checked view. This is the one place a full pass ends, so
       * it is where a flip is told. */
      this.emitUnitHealthChanges();
      this.onCheck();
    } finally {
      this.checking = false;
    }
  }

  /** The units that cannot be whole right now, by name. A unit is blocked when a
   *  member this host cannot start -- a watch-only one -- is not listening. That
   *  is the only kind of down that forces the unit down: a startable member that
   *  is merely down is on its way back up (revive), and tearing the unit down
   *  over it would thrash. See ServiceSpec.unit and defaultServices(). */
  private async blockedUnits(): Promise<Set<string>> {
    const blocked = new Set<string>();
    for (const rt of this.rts) {
      const u = rt.spec.unit;
      if (u === undefined || rt.spec.revive.how !== "watch") continue;
      /* A watch-only member whose MODEL IS NOT ON DISK YET does not block: it
       * cannot possibly come up until the background download lands, and
       * all-or-none read strictly would hold the other members down for the whole
       * multi-GB fetch on a first install. The unit still reports not-whole
       * (units() reads `running`, and this member is not running), so the mic
       * stays hidden; what this carve-out buys is per-capability warm-up: the
       * members whose own models are here get to serve. */
      if (missingModelPath(rt.spec) !== null) continue;
      /* Not blocked if the port answers, even when lsof cannot name the pid: a
       * watch-only member another user on this host serves is up, and the unit
       * is whole through it. */
      if ((await listeningPid(rt.spec.port)) === null && !(await portOpen(rt.spec.port))) {
        blocked.add(u);
      }
    }
    return blocked;
  }

  /** Whether this engine is the one that acts on THIS service, asked fresh.
   *
   *  Nothing reads a cached answer: `checkOne` is also entered from a child's
   *  exit watcher, minutes after the pass that set it, and a restart decided on
   *  a remembered lease is exactly the unowned kill this file exists to
   *  prevent. */
  private async holds(rt: Runtime): Promise<boolean> {
    /* A watch-only service has no lease and `cannotStart` says so in the same
     * sentence, so there is one answer here rather than a second one for the
     * case with no lease object. */
    const why = cannotStart(rt.spec);
    if (why !== null) {
      /* NOT QUALIFIED, so not a candidate. Giving it back matters as much as
       * never taking it: a holder whose checkout was deleted underneath it must
       * not go on holding the lease of a service it can no longer start, or the
       * engine that can never gets its turn. */
      await rt.lease?.release();
      this.set(rt, { supervisor: { holder: false, pid: null, since: null,
        note: `this engine does not supervise it: ${why}` } });
      return false;
    }
    const holding = await rt.lease!.acquireOrRenew();
    this.set(rt, { supervisor: rt.lease!.view() });
    return holding;
  }

  /** The sentence a non-holder's row ends with, so /health never leaves the
   *  reader wondering whether anything is going to happen. */
  private whoActs(rt: Runtime): string {
    const v = rt.state.supervisor;
    if (cannotStart(rt.spec) !== null) return v.note[0].toUpperCase() + v.note.slice(1) + ".";
    return v.pid !== null
      ? `This engine only watches: pid ${v.pid} on this host supervises it.`
      : "This engine only watches: another engine on this host supervises it.";
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => { this.pending.delete(t); fn(); }, ms);
    this.pending.add(t);
  }

  private async checkOne(rt: Runtime, blocked: Set<string>): Promise<void> {
    if (this.stopped || rt.busy) return;
    const { spec } = rt;
    /* WHO ACTS ON THIS ONE, asked before anything is decided and on every entry
     * to this function, including the one a dying child schedules. */
    const holding = await this.holds(rt);
    const pid = await listeningPid(spec.port);
    const at = Date.now();

    /* SERVED BY ANOTHER USER ON THIS HOST. lsof under a non-root user lists only
     * that user's own sockets, so a service another account serves (the shared
     * voice stack, one kokoro/stt for every engine on the Mac) reads as
     * pid-null here though it answers on loopback. A connect sees it. Report it
     * up and unsupervised, and decide it before the unit and revive logic: this
     * engine must never try to start or hold down a port someone else serves. A
     * port this engine's own child holds is our user's, so lsof returns its pid
     * and we never reach here for it. */
    if (pid === null && await portOpen(spec.port)) {
      rt.down = 0;
      rt.attempts = 0;
      rt.nextAttemptAt = 0;
      this.set(rt, { running: true, pid: null, owned: false, starting: false,
        footprintMb: null, checkedAt: at,
        note: `listening on :${spec.port}, served by another user on this host; ` +
          "this engine does not supervise it" });
      return;
    }

    /* THE UNIT IS NOT WHOLE, AND THIS IS A STARTABLE MEMBER OF IT. All-or-none:
     * a member nothing here can start (an adopted-only kokoro) is down, so this member -- which
     * this engine CAN start -- must not stay up, or the host sits in the partial
     * state the unit rule exists to forbid. Decided here, before revive and
     * before the ceiling, and only ever ACTED ON by the engine that holds this
     * member's lease: a watcher reports the unit is not whole and touches
     * nothing, exactly as it does for the ceiling. A watch-only member is never
     * handled here -- it is the gate, not a thing this engine stops. */
    if (spec.unit !== undefined && spec.revive.how !== "watch" && blocked.has(spec.unit)) {
      const child = rt.child && rt.child.exitCode === null ? rt.child : null;
      if (pid === null && !child) {
        rt.down += 1;
        rt.attempts = 0;
        rt.nextAttemptAt = 0;
        this.set(rt, { running: false, pid: null, owned: false, starting: false,
          footprintMb: null, checkedAt: at,
          note: `nothing is listening on :${spec.port}; the "${spec.unit}" unit is not whole, ` +
            "so this engine holds it down until every member can be up" });
        return;
      }
      if (!holding) {
        this.set(rt, { running: pid !== null, pid, owned: false, starting: false,
          footprintMb: null, checkedAt: at,
          note: `the "${spec.unit}" unit is not whole. ${this.whoActs(rt)}` });
        return;
      }
      await this.stopForUnit(rt, pid);
      return;
    }

    if (pid === null) {
      /* A child we started that has not bound its port yet. kokoro loads models
       * for about ten seconds before it listens, and calling that "not running"
       * and starting a second one is how a supervisor makes an outage. */
      if (rt.child && rt.child.exitCode === null) {
        this.set(rt, { running: false, pid: null, owned: false, footprintMb: null, starting: true,
          checkedAt: at, note: `started by this engine, not listening on :${spec.port} yet` });
        return;
      }
      this.set(rt, { running: false, pid: null, owned: false, footprintMb: null, starting: false,
        checkedAt: at });
      rt.down += 1;
      if (!holding) {
        this.set(rt, { note: `nothing is listening on :${spec.port}. ${this.whoActs(rt)}` });
        this.log(`${spec.name}: not running (this engine does not supervise it)`);
        return;
      }
      await this.reviveIfDue(rt);
      return;
    }

    const owned = rt.child !== null && rt.child.exitCode === null && rt.child.pid === pid;
    if (rt.down > 0) {
      this.incident(`${spec.name}: answering again on :${spec.port} (pid ${pid})`);
      rt.down = 0;
      rt.attempts = 0;
      rt.nextAttemptAt = 0;
    }

    /* MEASURED FIRST, PUBLISHED ONCE. The reading takes a moment, and a row
     * written in pieces around it can be read half done: "running, pid 123,
     * footprint unknown" was on /health for as long as python3 took, which is a
     * process being described as unmeasurable while it was being measured. */
    const mb = await this.readFootprint(pid);
    const seen = { running: true, pid, owned, starting: false, footprintMb: mb,
      checkedAt: Date.now() };

    if (mb === null) {
      this.set(rt, { ...seen,
        note: `listening on :${spec.port} (pid ${pid}); its footprint could not be measured, ` +
          "so the ceiling is not being enforced on it right now" });
      this.log(`${spec.name}: listening on :${spec.port}, footprint unreadable`);
      return;
    }
    if (mb < spec.ceilingMb) {
      this.set(rt, { ...seen,
        note: `listening on :${spec.port} (pid ${pid}), ${mb}MB of the ${spec.ceilingMb}MB ceiling` });
      this.log(`${spec.name}: ${mb}MB / ${spec.ceilingMb}MB`);
      return;
    }

    if (spec.revive.how === "watch") {
      /* Reported, not killed. Nothing here can start it again, and taking a
       * service down with no one responsible for bringing it back is worse than
       * the memory it is holding. */
      this.set(rt, { ...seen,
        note: `listening on :${spec.port} (pid ${pid}), ${mb}MB is OVER the ${spec.ceilingMb}MB ` +
          "ceiling; nothing on this engine can start it again, so it is left alone" });
      this.incident(`${spec.name}: ${mb}MB over the ${spec.ceilingMb}MB ceiling, ` +
        "and this engine has no way to start it again, so it is left alone");
      return;
    }

    /* OVER THE CEILING AND NOT OUR CALL. This is the half of the two-engine
     * problem that would have done real damage: without the lease, the `work`
     * engine's ceiling check could restart the kokoro that is speaking to him,
     * a process on a port it shares by accident and did not start. It is
     * reported instead, on both engines, saying who is expected to deal with
     * it. */
    if (!holding) {
      this.set(rt, { ...seen,
        note: `listening on :${spec.port} (pid ${pid}), ${mb}MB is OVER the ${spec.ceilingMb}MB ` +
          `ceiling. ${this.whoActs(rt)}` });
      this.log(`${spec.name}: ${mb}MB over the ${spec.ceilingMb}MB ceiling, ` +
        "and this engine does not supervise it");
      return;
    }

    this.incident(`${spec.name}: ${mb}MB over the ${spec.ceilingMb}MB ceiling, restarting`);
    this.set(rt, { ...seen, note: `${mb}MB was over the ${spec.ceilingMb}MB ceiling, restarting` });
    await this.restartOverCeiling(rt, pid);
  }

  /** One row, replaced whole. Everything a caller reads was true together,
   *  rather than being assembled field by field across awaits. `checkedAt`
   *  belongs to whoever actually looked at the port, so it is part of the patch
   *  rather than stamped here: a restart scheduled from a child's exit has not
   *  looked at anything.
   *
   *  THE CONFIGURED MODEL IS RE-CHECKED HERE, on every write, because this is
   *  the one place every branch of every check funnels through: a missing
   *  chosen model must be loud in /health no matter which sentence the check
   *  ended on, and never depend on which early return wrote the note. */
  private set(rt: Runtime, patch: Partial<ServiceState>): void {
    const next = { ...rt.state, ...patch };
    const model = rt.spec.model;
    if (model) {
      const present = existsSync(model.path);
      next.model = { name: model.name, path: model.path, present };
      if (!present && patch.note !== undefined) {
        next.note = `${patch.note}; its configured model ${model.name} is MISSING at ` +
          `${model.path}, and this engine will NOT silently switch models`;
      }
    }
    rt.state = next;
  }

  /** Restart ONE service, on request (a model change), through the same
   *  machinery the ceiling uses: kill the LISTENING pid, whoever started it,
   *  wait for the port to drain, and start our own child; a launchd job is
   *  handed to launchd (kickstart restarts, bootstrap starts). Only the lease
   *  holder acts, exactly as everywhere else in this file, and a watch-only
   *  service is refused with the reason: this engine must never kill what it
   *  cannot bring back. */
  async restart(key: string): Promise<{ ok: boolean; message: string }> {
    const rt = this.rts.find((r) => r.spec.key === key);
    if (!rt) return { ok: false, message: `no service named "${key}" in this engine's table` };
    const { spec } = rt;
    const why = cannotStart(spec);
    /* The `startable` half is what cannotStart's first line already refuses, so
     * this never changes the answer; it is here so the arm is narrowed for the
     * spawnChild at the end of the method. */
    if (why !== null || !startable(spec.revive)) {
      return { ok: false, message: `this engine cannot start ${spec.name}: ` +
        `${why ?? "nothing on this engine starts it"}` };
    }
    /* The presence gate applies to a requested restart too: starting a service
     * over a model file that is not there yet is a crash loop on demand. */
    const missingModel = missingModelPath(spec);
    if (missingModel !== null) {
      return { ok: false, message: `cannot start ${spec.name}: its model ` +
        `${spec.needsModel!.name} is not on disk yet (${missingModel} is missing; ` +
        "it downloads in the background and the service starts when it lands)" };
    }
    if (!(await this.holds(rt))) {
      return { ok: false, message: `this engine does not supervise ${spec.name}: ` +
        "another engine on this host holds its lease" };
    }
    if (rt.busy) return { ok: false, message: `${spec.name} is busy with another restart` };

    this.incident(`${spec.name}: restart requested`);
    // The restart is wanted NOW: no backoff earned by earlier failures applies.
    rt.down = 0;
    rt.attempts = 0;
    rt.nextAttemptAt = 0;

    if (spec.revive.how === "launchd") {
      rt.busy = true;
      try {
        const ok = await this.reviveLaunchd(rt, spec.revive);
        return ok
          ? { ok: true, message: `restarted ${spec.name} through launchd` }
          : { ok: false, message: `could not restart ${spec.name} through launchd: ${rt.state.note}` };
      } finally {
        rt.busy = false;
      }
    }

    // spawn: take the listening process down (adopted or owned alike), then
    // start our own. The exit watcher stands down; this restart owns the
    // outcome, the same discipline restartOverCeiling keeps.
    const pid = await listeningPid(spec.port);
    rt.busy = true;
    const child = rt.child;
    rt.child = null;
    try {
      if (pid !== null) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
      if (child) {
        const code = await child.exited.catch(() => null);
        this.set(rt, { lastExit: { code, signal: child.signalCode ?? null, at: Date.now() } });
      }
      for (let i = 0; i < 40; i++) {
        if ((await listeningPid(spec.port)) === null) break;
        await Bun.sleep(250);
      }
      const still = await listeningPid(spec.port);
      if (still !== null) {
        try { process.kill(still, "SIGKILL"); } catch { /* already gone */ }
        await Bun.sleep(250);
      }
    } finally {
      rt.busy = false;
    }
    this.set(rt, { running: false, pid: null, owned: false, starting: false, footprintMb: null,
      checkedAt: Date.now() });
    this.spawnChild(rt, spec.revive);
    return { ok: true, message: pid !== null
      ? `restarted ${spec.name}: stopped pid ${pid} and started a new one`
      : `started ${spec.name}: nothing was listening on :${spec.port}` };
  }

  /** Over the ceiling and startable: take it down and bring it back.
   *
   *  THE LISTENING PID IS KILLED, whoever started it. An adopted process --
   *  kokoro started by hand in a herdr pane, `owned:false` on /health -- gets
   *  the SIGTERM too and comes back as this engine's child. That is deliberate
   *  and it is what memory-guard.sh did: the ceiling exists because kokoro
   *  reached 16 GB over four days, and a leak is not less of a leak for having
   *  been started by hand. `owned` says who started it, not who is safe from
   *  it. */
  private async restartOverCeiling(rt: Runtime, pid: number): Promise<void> {
    const { spec } = rt;
    /* NOTHING IS KILLED THAT CANNOT BE BROUGHT BACK, and that is now settled
     * before this function rather than inside it. It used to be possible to
     * arrive here unable to spawn -- `reviveIfDue` checked `needs` and this
     * path did not, so an engine that had already said "cannot start it" would
     * still kill it on the ceiling and turn a service using too much memory
     * into no service at all. Being able to start it is what qualifies an
     * engine to hold the lease (`holds`), and only a holder reaches this line,
     * so the question is asked once, in one place, with one sentence. */
    /* That "one sentence" is `holds`, which is opaque to the checker, so the
     * rule is restated here as a narrowing. A watched service reaching this
     * line would be a bug in `holds`, not something to kill and respawn. */
    if (!startable(spec.revive)) return;
    if (spec.revive.how === "launchd") {
      // kickstart -k IS kill-and-restart, and the supervisor owns the
      // environment, so this beats killing the pid and hoping.
      await this.reviveLaunchd(rt, spec.revive);
      return;
    }
    const revive = spec.revive;
    rt.busy = true;
    /* This restart owns the outcome, so the child's own exit watcher stands
     * down: two paths both deciding to start the service again is how a
     * supervisor ends up running two of them. */
    const child = rt.child;
    rt.child = null;
    try {
      /* The listening pid, not the child handle: the process over the ceiling is
       * whatever is on the port, which may be one this engine adopted. Killing
       * it and starting our own is how an adopted service becomes a supervised
       * one. */
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      if (child) {
        const code = await child.exited.catch(() => null);
        this.set(rt, { lastExit: { code, signal: child.signalCode ?? null, at: Date.now() } });
      }
      for (let i = 0; i < 40; i++) {
        if ((await listeningPid(spec.port)) === null) break;
        await Bun.sleep(250);
      }
      const still = await listeningPid(spec.port);
      if (still !== null) {
        try { process.kill(still, "SIGKILL"); } catch { /* already gone */ }
        await Bun.sleep(250);
      }
    } finally {
      rt.busy = false;
    }
    this.set(rt, { running: false, pid: null, owned: false, footprintMb: null,
      checkedAt: Date.now() });
    this.spawnChild(rt, revive);
  }

  /** Take a unit member DOWN and leave it down. This is the stop half of
   *  all-or-none: the unit cannot be whole (a member nothing here can start is
   *  missing), so a member this engine can start must not go on running in a
   *  partial unit.
   *
   *  HOW A MEMBER IS STOPPED DEPENDS ON WHO SUPERVISES IT.
   *
   *  A spawn child (kokoro, stt) is stopped by killing the LISTENING pid,
   *  whoever started it (an adopted kokoro from a herdr pane is taken down too,
   *  the same way and for the same reason), and dropping the child handle so its
   *  exit watcher does not respawn it.
   *
   *  A launchd job (the voice engine) is NOT stopped by killing its pid: it has
   *  KeepAlive, so launchd would start it straight back and the teardown would
   *  flap. It is stopped by `launchctl bootout`, which removes the job from the
   *  domain -- KeepAlive only applies to a loaded job -- so it stays down until
   *  this engine BOOTSTRAPS it again. Bootout without a way back would leave it
   *  dead for ever; the way back is the ordinary launchd revive (reviveLaunchd,
   *  whose "not loaded -> bootstrap" branch is exactly the state bootout leaves).
   *
   *  In both cases the backoff is left clear, so the moment the unit CAN be
   *  whole again the member is started at once rather than after a wait. Only a
   *  holder reaches here (checkOne gates it on `holding`), so a watcher never
   *  stops another engine's member, launchd or spawn.
   *
   *  TODO(#330, awaiting his confirmation): restart-the-unit on a ceiling trip.
   *  All-or-none taken to its conclusion says that when ANY member trips its
   *  ceiling the WHOLE unit should cycle, so the members come back together. It
   *  is deliberately NOT built: kokoro pays a ~10s model reload on every restart,
   *  and making one member's ceiling trip reload all of them is the expensive
   *  consequence he wanted to confirm before it ships. Today a ceiling trip
   *  still restarts only the member that tripped (restartOverCeiling). */
  private async stopForUnit(rt: Runtime, pid: number | null): Promise<void> {
    const { spec } = rt;
    /* Leave the backoff clear either way, so recovery is immediate when the
     * unit can be whole again rather than sat behind a wait it did not earn. */
    rt.down = 0;
    rt.attempts = 0;
    rt.nextAttemptAt = 0;
    if (spec.revive.how === "launchd") {
      await this.stopLaunchd(rt, spec.revive);
      return;
    }
    rt.busy = true;
    /* The exit watcher stands down: this stop owns the outcome, and a child that
     * respawns itself into a unit that is still not whole is the partial state
     * we are here to remove. */
    const child = rt.child;
    rt.child = null;
    try {
      if (pid !== null) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
      if (child) {
        const code = await child.exited.catch(() => null);
        this.set(rt, { lastExit: { code, signal: child.signalCode ?? null, at: Date.now() } });
      }
      for (let i = 0; i < 40; i++) {
        if ((await listeningPid(spec.port)) === null) break;
        await Bun.sleep(250);
      }
      const still = await listeningPid(spec.port);
      if (still !== null) {
        try { process.kill(still, "SIGKILL"); } catch { /* already gone */ }
        await Bun.sleep(250);
      }
    } finally {
      rt.busy = false;
    }
    this.set(rt, { running: false, pid: null, owned: false, starting: false, footprintMb: null,
      checkedAt: Date.now(),
      note: `stopped: the "${spec.unit}" unit is not whole (a member nothing on this engine can ` +
        "start is not up), so this engine took this member down too" });
    this.incident(`${spec.name}: stopped because the "${spec.unit}" unit is not whole ` +
      "(all-or-none: a member this engine cannot start is missing)");
  }

  /** Bootout a launchd unit member for a teardown. This is the STOP that a
   *  KeepAlive job needs: killing its pid only makes launchd restart it, so the
   *  job is removed from the domain instead. It comes back the ordinary way, by
   *  bootstrap, once the unit can be whole again (reviveLaunchd), so this is a
   *  reversible stop, not a kill.
   *
   *  Bootout returning non-zero is not treated as failure on its own: a job that
   *  is already unloaded returns non-zero and that is the state we want. The
   *  test is the PORT -- if nothing is listening after, the member is down. If
   *  something is still listening, the teardown is half-done and /health SAYS
   *  so, with the member still up, rather than reporting a clean stop it did not
   *  achieve. The pid is never killed to force it: that would restart under
   *  KeepAlive, which is the exact flap bootout exists to avoid. */
  private async stopLaunchd(rt: Runtime, revive: Extract<Revive, { how: "launchd" }>): Promise<void> {
    const { spec } = rt;
    const uid = process.getuid?.() ?? 0;
    const target = `gui/${uid}/${revive.label}`;
    rt.busy = true;
    try {
      const out = await this.runLaunchctl(LAUNCHCTL_MS, ["bootout", target]);
      if (out.timedOut) {
        this.incident(`${spec.name}: bootout of ${revive.label} did not answer in ${secs(LAUNCHCTL_MS)}`);
      }
      for (let i = 0; i < 40; i++) {
        if ((await listeningPid(spec.port)) === null) break;
        await Bun.sleep(250);
      }
    } finally {
      rt.busy = false;
    }
    const still = await listeningPid(spec.port);
    if (still !== null) {
      this.set(rt, { running: true, pid: still, owned: false, starting: false, footprintMb: null,
        checkedAt: Date.now(),
        note: `the "${spec.unit}" unit is not whole and this engine bootout'd ${revive.label}, ` +
          `but something is still listening on :${spec.port}, so the unit is not down yet` });
      this.incident(`${spec.name}: bootout'd ${revive.label} but :${spec.port} is still held`);
      return;
    }
    this.set(rt, { running: false, pid: null, owned: false, starting: false, footprintMb: null,
      checkedAt: Date.now(),
      note: `stopped: the "${spec.unit}" unit is not whole, so this engine bootout'd ${revive.label} ` +
        "and will bootstrap it again when every member can be up" });
    this.incident(`${spec.name}: bootout'd ${revive.label} because the "${spec.unit}" unit is not whole`);
  }

  /* Not there, and this engine is the one that acts on it.
   *
   * "Can this engine start it?" is NOT asked again here. It is `holds()`'s
   * question, it is what qualifies this engine to hold the lease at all, and
   * this function is only reached by a holder. It used to be asked in both
   * places with two different sentences for the same fact, which is how a row
   * ends up saying one thing while the lease says another. */
  private async reviveIfDue(rt: Runtime): Promise<void> {
    const { spec } = rt;
    const now = Date.now();

    /* Same rule as the header states, made narrowable: only a lease holder gets
     * here, and holding requires being able to start it, so a watched service
     * has nothing due. */
    if (!startable(spec.revive)) return;

    if (spec.revive.how === "spawn") {
      /* THE PRESENCE GATE: a spawn service whose model file is not on disk yet
       * is HELD DOWN, quietly, instead of being started into a crash loop over
       * a file that is not there. The background warm-up (modelwarmup.ts) is
       * filling the file in; the backoff is left clear so the moment it lands
       * the service starts at once, not after a wait it never earned. */
      const missingModel = missingModelPath(spec);
      if (missingModel !== null) {
        rt.attempts = 0;
        rt.nextAttemptAt = 0;
        this.set(rt, { note: `nothing is listening on :${spec.port}; its model ` +
          `${spec.needsModel!.name} is not on disk yet (${missingModel} is missing, ` +
          "downloading in the background), so this engine holds it down until the model lands" });
        return;
      }
      if (now < rt.nextAttemptAt) {
        this.set(rt, { note: `nothing is listening on :${spec.port}; ${rt.attempts} start ` +
          `attempts have failed, next in ${secs(rt.nextAttemptAt - now)}` });
        return;
      }
      this.spawnChild(rt, spec.revive);
      return;
    }

    // launchd: its own supervisor gets first refusal.
    if (rt.down < this.graceTicks) {
      this.set(rt, { note: `nothing is listening on :${spec.port} (check ${rt.down}/` +
        `${this.graceTicks}, leaving it to its own supervisor)` });
      this.log(`${spec.name}: not running (check ${rt.down}/${this.graceTicks})`);
      return;
    }
    if (now < rt.nextAttemptAt) {
      this.set(rt, { note: `nothing is listening on :${spec.port}; still gone after ` +
        `${rt.attempts} revive attempts, next in ${secs(rt.nextAttemptAt - now)}` });
      this.log(`${spec.name}: still gone, next attempt in ${secs(rt.nextAttemptAt - now)}`);
      return;
    }
    rt.attempts += 1;
    this.incident(`${spec.name}: gone from :${spec.port} for ${rt.down} checks, ` +
      `reviving (attempt ${rt.attempts})`);
    rt.busy = true;
    try {
      await this.reviveLaunchd(rt, spec.revive);
    } finally {
      rt.busy = false;
    }
    /* Back off whether the attempt succeeded, failed, or had to be abandoned on
     * its deadline. All three look the same from here and only the next check
     * settles it: a kickstart that returns 0 and then exits is indistinguishable
     * from one that never returned. The clock is re-read AFTER the call, which
     * matters now that an attempt can legitimately take half a minute. */
    let wait = LAUNCHD_BACKOFF_BASE_MS;
    for (let i = 1; i < rt.attempts && wait < LAUNCHD_BACKOFF_MAX_MS; i++) wait *= 2;
    rt.nextAttemptAt = Date.now() + Math.min(wait, LAUNCHD_BACKOFF_MAX_MS);
    this.set(rt, { note: `nothing is listening on :${spec.port}; revive attempt ${rt.attempts} ` +
      `made, next in ${secs(rt.nextAttemptAt - Date.now())}` });
  }

  private spawnChild(rt: Runtime, revive: Extract<Revive, { how: "spawn" }>): void {
    const { spec } = rt;
    rt.attempts += 1;
    let out: number;
    try {
      mkdirPrivateSync(this.logDir);
      const logPath = this.rollLog(spec.key);
      out = openSync(logPath, "a");
      try { chmodSync(logPath, FILE_MODE); } catch { /* best-effort */ }
    } catch (e) {
      this.set(rt, { note: `cannot start ${spec.name}: its log file could not be opened (${String(e)})` });
      this.incident(`${spec.name}: cannot open its log file: ${String(e)}`);
      return;
    }
    let child: Subprocess;
    try {
      child = Bun.spawn(revive.cmd, {
        cwd: revive.cwd,
        env: { ...process.env, ...(revive.env ?? {}) },
        stdin: "ignore",
        stdout: out,
        stderr: out,
      });
    } catch (e) {
      this.set(rt, { note: `nothing is listening on :${spec.port} and starting it failed: ${String(e)}` });
      this.incident(`${spec.name}: start failed: ${String(e)}`);
      rt.nextAttemptAt = Date.now() + this.backoff(rt.attempts);
      return;
    }
    rt.child = child;
    this.set(rt, { restarts: rt.state.restarts + 1, starting: true,
      note: `started by this engine (pid ${child.pid}), not listening on :${spec.port} yet` });
    this.incident(`${spec.name}: started (pid ${child.pid}, attempt ${rt.attempts})`);

    void child.exited.then((code) => {
      if (rt.child !== child) return; // superseded by a restart
      rt.child = null;
      /* It died: nothing is on that port and this process watched it happen. A
       * row that kept saying "running, pid 4123" until the next check would be
       * the engine asserting what it knows to be untrue. */
      this.set(rt, { lastExit: { code, signal: child.signalCode ?? null, at: Date.now() },
        starting: false, running: false, pid: null, owned: false, footprintMb: null,
        checkedAt: Date.now(),
        note: `it exited (code ${code}${child.signalCode ? `, ${child.signalCode}` : ""}); ` +
          "the engine is starting it again" });
      if (this.stopped) return;
      const wait = this.backoff(rt.attempts);
      rt.nextAttemptAt = Date.now() + wait;
      this.incident(`${spec.name}: exited (code ${code}${child.signalCode ? `, ${child.signalCode}` : ""}), ` +
        `starting it again in ${secs(wait)}`);
      /* Restarted from the exit, not from the next tick. A child that dies must
       * not be gone for up to a whole check interval when the process that
       * started it watched it die. The unit blockers are re-read here, not
       * assumed: a member whose sibling went missing while it was down must be
       * held down rather than started back into a partial unit. */
      this.later(wait + 50, () => { void this.recheckOne(rt); });
    });
  }

  /** One member, rechecked off the main pass -- from a child's exit watcher --
   *  with the unit blockers read fresh so the all-or-none decision is made on
   *  what is true now, not on what the last full pass saw. */
  private async recheckOne(rt: Runtime): Promise<void> {
    if (this.stopped) return;
    await this.checkOne(rt, await this.blockedUnits());
    /* A member's death or return off the main pass can flip its unit's health
     * too: a voice member exiting mid-session must hide the mic without waiting
     * for the next tick. Diff-gated, so a recheck that changed nothing is
     * silent. */
    this.emitUnitHealthChanges();
    this.onCheck();
  }

  /* One generation back, and no more. kokoro logs a line per request and these
   * files were opened "a" and never touched again, so the only thing bounding
   * `.run/services/kokoro.log` was how long the machine stayed up. Rolled at
   * spawn rather than on a timer: it is the only moment the file is not already
   * open, so there is nothing to reopen and nothing writing into a renamed
   * inode. A service that never restarts never rolls, and a service that never
   * restarts is not the one filling a disk. */
  private rollLog(key: string): string {
    const path = join(this.logDir, `${key}.log`);
    try {
      if (statSync(path).size > LOG_ROLL_BYTES) {
        renameSync(path, `${path}.1`);
        this.log(`${key}.log passed ${LOG_ROLL_BYTES / 1_048_576}MB and was rolled to ${key}.log.1`);
      }
    } catch { /* not there yet, or not ours to rename: the open below decides */ }
    return path;
  }

  private backoff(attempts: number): number {
    let wait = this.restartBaseMs;
    for (let i = 1; i < attempts && wait < this.restartMaxMs; i++) wait *= 2;
    return Math.min(wait, this.restartMaxMs);
  }

  /* Hand it back to launchd. Every call is bounded, and `print` is asked first
   * because it answers in 0s whether the job is loaded or not, so the job's
   * state is READ rather than inferred from a failure. */
  private async reviveLaunchd(rt: Runtime, revive: Extract<Revive, { how: "launchd" }>): Promise<boolean> {
    const { spec, state } = rt;
    const uid = process.getuid?.() ?? 0;
    const target = `gui/${uid}/${revive.label}`;

    const printed = await this.runLaunchctl(LAUNCHCTL_PRINT_MS, ["print", target]);
    if (printed.timedOut) {
      state.note = `launchctl print on ${revive.label} did not answer in ` +
        `${secs(LAUNCHCTL_PRINT_MS)}, leaving it for the backoff`;
      this.incident(`${spec.name}: ${state.note}`);
      return false;
    }

    if (printed.code !== 0) {
      // Not loaded at all: a fresh machine, or somebody bootout'd it. bootstrap
      // has RunAtLoad, so it starts it; there is no need to also kickstart,
      // which is what would add a second call that can hang.
      if (!existsSync(revive.plist)) {
        state.note = `cannot revive: ${revive.label} is not loaded and ${revive.plist} does not exist`;
        this.incident(`${spec.name}: ${state.note}`);
        return false;
      }
      const boot = await this.runLaunchctl(LAUNCHCTL_MS, ["bootstrap", `gui/${uid}`, revive.plist]);
      if (boot.code === 0) {
        this.incident(`${spec.name}: bootstrapped ${revive.label}`);
        return true;
      }
      state.note = `bootstrap of ${revive.label} failed or did not answer in ${secs(LAUNCHCTL_MS)}`;
      this.incident(`${spec.name}: ${state.note}`);
      return false;
    }

    /* LOADED. Is launchd already trying and failing to start it on its own?
     * That is the state kickstart does not come back from, and also the state
     * where kickstarting adds nothing: launchd is retrying already. So say what
     * is wrong and let the backoff do the waiting. A parse miss here is
     * harmless: it falls through to the bounded call below, which is the
     * guarantee. This is the fast path, not the fix. */
    if (printed.out.includes("state = spawn scheduled") && !printed.out.includes("last exit code = 0")) {
      const exit = /last exit code = (\S+)/.exec(printed.out)?.[1] ?? "unknown";
      state.note = `${revive.label} is loaded but launchd cannot spawn it (last exit ${exit}). ` +
        "Not kickstarting: that call does not return in this state.";
      this.incident(`${spec.name}: ${state.note}`);
      return false;
    }

    const kick = await this.runLaunchctl(LAUNCHCTL_MS, ["kickstart", "-k", target]);
    if (kick.code === 0) {
      this.incident(`${spec.name}: kickstarted ${revive.label}`);
      return true;
    }
    state.note = `kickstart of ${revive.label} failed or did not answer in ${secs(LAUNCHCTL_MS)}`;
    this.incident(`${spec.name}: ${state.note}`);
    return false;
  }
}

/* WHAT THIS HOST RUNS, and the ceilings memory-guard.sh carried.
 *
 * ONE voice service now: the voice engine, whose sherpa-onnx backend serves
 * TTS (kokoro) and STT (whisper) in-process. The python stack this table used
 * to drive -- kokoro-FastAPI on :10104, the stt venv on :10105 -- is gone,
 * and with it the three-member "voice" unit choreography: the unit still
 * exists (the app's voice frame reads it) but it has one member, so
 * all-or-none is simply "is the voice engine up".
 *
 * The voice engine has a supervisor of its own (launchd on macOS, systemd on
 * Linux), so this table is the net UNDER it, deliberately slower than it
 * (graceTicks) so it can never race KeepAlive. The ceiling covers both models
 * loaded at once (whisper turbo int8 + kokoro, ~2.5 GB working set) with
 * honest headroom; systemd's own MemoryMax enforces it on Linux where
 * footprintMb reads null. */
export function defaultServices(): ServiceSpec[] {
  const home = homedir();
  /* THE CHOSEN MODELS, stamped onto the row. Only an EXPLICIT choice in
   * state/voice-models.json (voicemodels.ts) stamps `model` (the loud /health
   * claim); the presence gate (needsModel) is stamped ALWAYS from the current
   * chosen-or-default models, because a fresh install whose models are still
   * downloading needs the gate on day one. The voice engine itself boots
   * without the files (its backend polls and flips ready when they land), so
   * the gate's job here is honest /health and the restart refusal, not
   * holding the process down. */
  const chosen = rawModelChoices();
  const whisperSize = currentWhisperSize();
  const kokoroVariant = currentKokoroVariant();
  const chosenName = [
    chosen.whisper !== null ? whisperModelName(chosen.whisper) : null,
    chosen.kokoro !== null ? kokoroModelName(chosen.kokoro) : null,
  ].filter((n): n is string => n !== null);
  const model = chosenName.length > 0
    ? { name: chosenName.join(" + "),
        path: modelPresencePaths(chosen.whisper !== null ? "whisper" : "kokoro")[0] }
    : undefined;
  return [
    {
      key: "voice-engine", name: "voice engine (sherpa tts+stt)", port: 10102, ceilingMb: 6000,
      unit: "voice",
      model,
      needsModel: {
        name: `${whisperModelName(whisperSize)} + ${kokoroModelName(kokoroVariant)}`,
        paths: [...modelPresencePaths("whisper"), ...modelPresencePaths("kokoro")],
      },
      revive: {
        how: "launchd",
        label: "com.callyourcode.voice-engine",
        plist: join(home, "Library", "LaunchAgents", "com.callyourcode.voice-engine.plist"),
      },
    },
  ];
}

/* The table this engine will actually use.
 *
 * CYC_SERVICES_FILE is how a test says "these, and nothing of his". Without it
 * every test that boots an engine would adopt the real kokoro on :10104, measure
 * it, and be one ceiling away from restarting the machine's live speech. The
 * harness always points it at a file of its own for exactly that reason. */
export async function loadServices(): Promise<ServiceSpec[]> {
  const file = process.env.CYC_SERVICES_FILE;
  if (!file) return defaultServices();
  const text = await Bun.file(file).text().catch(() => "[]");
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as ServiceSpec[]) : [];
  } catch {
    return [];
  }
}
