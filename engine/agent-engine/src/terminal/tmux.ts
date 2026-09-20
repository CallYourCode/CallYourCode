/* tmux behind the multiplexer seam (#480).
 *
 * A user who runs plain tmux instead of herdr points the engine here with
 * CYC_MUX=tmux (and CYC_TMUX_SOCKET to name a `tmux -L <name>` socket). tmux
 * satisfies the first four verbs of the contract out of the box; the fifth
 * (agent detection) it offers nothing for, so the engine derives it here, the
 * way the contract says it must: transcript for working/idle, screen for
 * blocked, and a jsonl link for identity.
 *
 * THE FIVE VERBS, per tmux command:
 *   1. enumerate  -> `list-panes -a -F ...` (pane %id, pid, command, cwd,
 *                    session, window). Ids are tmux's `%N`, stable for the
 *                    server's lifetime.
 *   2. read+ansi  -> `capture-pane -p -e -t %N`. `-e` keeps the SGR bytes the
 *                    delivery guard and blocked-detector both parse; `-p` prints
 *                    to stdout. capture-pane returns the whole visible viewport,
 *                    so it is never short of it (the #488 failure herdr had).
 *   3. type+submit-> `send-keys -l -- <text>` types literally without submitting;
 *                    `send-keys Enter` submits. The engine owns the guard around
 *                    it; tmux just types.
 *   4. spawn      -> `new-window -d -c <cwd>` creates unfocused; `-P -F` prints
 *                    the new pane id. The command is then typed into it, exactly
 *                    as the herdr path does, so a shell survives it.
 *   5. detect     -> ENGINE-SIDE (detectAgents below): a pane runs claude when a
 *                    live claude process sits under it. DETECTION is the mux's;
 *                    LINKING (which jsonl that pane owns) is NOT: the birth
 *                    floors, the 571 refusal, the sticky handover and the
 *                    ambiguity degrade moved behind the identity layer
 *                    (sessions/tmux-link.ts, design Gap 2). detectAgents
 *                    emits only RAW facts (MuxAgent.tmuxLink: the announce it
 *                    saw, the newest jsonl it can see with that file's birth,
 *                    the engine-spawn premint and spawn time, the first-seen
 *                    facts) and leaves agentSession null for the linker to fill.
 */

import { statSync } from "node:fs";
import { basename } from "node:path";
import { AGENT_IDS, PREMINT_SOURCE, agentIdOfProc, resolveProcExe,
  type AgentSessionRef } from "../runtime/agents.ts";
import { parseAsk } from "./blocked.ts";
import { hookBindFor, markParked, onHookAnnounce, pendingAnnounces, pruneHookBinds, takePending } from "./hook-announce.ts";
import type { AgentStatus, MuxAgent, Multiplexer } from "./mux.ts";
import type { TmuxLinkFacts } from "../sessions/tmux-link.ts";
import { locateLatestClaude } from "../readers/claude.ts";

// agentIdOfProc moved to agents.ts (the announce route's ancestor walk shares
// it); re-exported so existing imports from this module read unchanged.
export { agentIdOfProc };

// tmux is cheap to poll (a local CLI round trip of a couple of ms), so the pane
// set is re-read on a short cadence. There is no event bus to subscribe to the
// way herdr has one; the poll IS the enumeration.
const POLL_MS = 2000;

/* How much screen the blocked check reads: the same 60 rows the adapter's
 * ask read (ASK_READ_LINES) parses, so the two verdicts come off the same
 * slice of pane and cannot disagree about whether a dialog is on it. */
const BLOCKED_READ_LINES = 60;

/* The one enumeration format. listPanes and the empty-enum diagnostic must run
 * the IDENTICAL `list-panes -a -F` call: on the Mac launchd engine, plain
 * `list-panes -a` shows the pane while the -F variant comes back empty, so the
 * diag has to capture this exact string, defined once. The last two fields are
 * the SERVER's pid and start time: the boot-epoch half of the reuse-proof pane
 * key below. */
const LIST_PANES_FMT = [
  "#{pane_id}", "#{pane_pid}", "#{pane_current_command}", "#{pane_current_path}",
  "#{session_name}", "#{window_id}", "#{window_name}", "#{pid}", "#{start_time}",
].join("\t");

/* Service managers (launchd) start the engine with NO locale in the
 * environment; tmux then sanitizes control characters in `-F` output for
 * non-UTF-8 clients, so the TAB separators in LIST_PANES_FMT come back as `_`
 * and the parser sees one field and zero panes. Proven byte-for-byte on the
 * Mac: `env -i tmux list-panes -F "#{pane_id}\t#{pane_pid}"` prints `%0_24635`
 * while the same call with LANG=en_US.UTF-8 prints `%0\t24635`. Called at
 * engine boot (server.ts), before any mux exists, so every child (tmux calls,
 * spawned agents) inherits a UTF-8 locale. Mutates `env` only when none of
 * LC_ALL/LC_CTYPE/LANG is set; returns the LANG it injected, or null when a
 * locale was already present. Exported for the boot call and the unit test. */
export function ensureUtf8Locale(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.LC_ALL || env.LC_CTYPE || env.LANG) return null;
  const lang = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  env.LANG = lang;
  return lang;
}

/* Once per process: a mangled enumeration line names itself instead of being
 * dropped silently (the defense behind ensureUtf8Locale, should a future
 * regression strip the locale again). */
let warnedSanitizedSeparators = false;

// tmux pane ids are `%N`. Validated before any of them reaches a `-t` argument:
// they come from our own list-panes, but the id also picks which pane gets typed
// into or killed, so it is checked rather than trusted.
const PANE_RE = /^%\d+$/;

/* THE REUSE-PROOF PANE KEY.
 *
 * A bare `%N` names one pane only for the lifetime of ONE tmux server: servers
 * exit with their last pane and a fresh server's first pane is %0 again, so
 * every per-pane memory keyed by bare handle aliased across that reuse and a
 * new pane inherited a dead stranger's identity (pre-links, sticky links,
 * heal-back, core's paneBindings/aliases/carry gate -- symptoms a-d in the
 * doc). The handle the engine keys EVERYTHING by is therefore the composite
 * `%N~pane_pid~server_epoch`: a new server is a new epoch, a new pane is a new
 * pid, so a recycled %N is a NEW key and inherits nothing, even when the old
 * pane's death was never observed. Core stores the handle opaquely, so every
 * handle-keyed map there becomes reuse-proof for free. The bare `%N` is
 * recovered ONLY at the `-t` argument boundary (paneTargetOf). */
const PANE_KEY_SEP = "~";
const PANE_KEY_RE = /^(%\d+)~\d+~\d+$/;

/** THE one PaneKey constructor: handle + pane pid + server boot epoch. The
 *  epoch is the server's `#{start_time}` (its boot instant), falling back to
 *  the server's `#{pid}` on a tmux too old to report it; either changes when
 *  the server does, which is the property the key needs. */
export function paneKey(paneId: string, panePid: number, epoch: number): string {
  return `${paneId}${PANE_KEY_SEP}${panePid}${PANE_KEY_SEP}${epoch}`;
}

/** The tmux `-t` target inside a pane key (a bare `%N` passes through, for the
 *  raw-id call sites tests exercise); null when the string is neither shape,
 *  so a forged handle never reaches a `-t`. */
export function paneTargetOf(handle: string): string | null {
  if (PANE_RE.test(handle)) return handle;
  const m = PANE_KEY_RE.exec(handle);
  return m ? m[1] : null;
}

/* listPanes sentinel: tmux answered, and the answer was "there is no server".
 * Distinct from [] (server up, zero panes) and from null (unreachable). */
const NO_SERVER = Symbol("no-server");

type Pane = {
  paneId: string;      // %N (the `-t` target; NEVER a memory key)
  key: string;         // the reuse-proof pane key (paneKey above): the handle
  pid: number;         // pane_pid (the pane's top process, usually the shell)
  command: string;     // pane_current_command (foreground process comm)
  cwd: string;         // pane_current_path
  session: string;     // session_name -- the workspace
  windowId: string;    // @N
  windowName: string;
};

type ProcNode = { pid: number; ppid: number; comm: string; args: string };

/* ONE TmuxMux PER ENGINE PROCESS (per socket). makeMux (mux.ts) and the
 * TmuxMuxAdapter default (adapters/tmux-adapter.ts) used to each build their
 * own instance, so the mux a spawn path pre-linked could be a different object
 * from the mux the adapter polled; the pre-link then sat in an instance nobody
 * enumerated and the spawned agent never surfaced. Both factories now resolve
 * through this memo, so the pre-link map, the poll and newTab share one
 * instance no matter which factory a caller went through. Direct `new TmuxMux`
 * remains for tests, which want isolated instances. */
const SHARED = new Map<string, TmuxMux>();
export function sharedTmuxMux(socket?: string): TmuxMux {
  const key = socket ?? "";
  let m = SHARED.get(key);
  if (!m) {
    m = new TmuxMux(socket);
    SHARED.set(key, m);
  }
  return m;
}

export class TmuxMux implements Multiplexer {
  private readonly sockArgs: string[];
  private agents: MuxAgent[] = [];
  private listeners: Array<(agents: MuxAgent[]) => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  // session_name for each live pane, so workspaceOf can answer without a fresh
  // tmux call on the /new-session path.
  private sessionByPane = new Map<string, string>();
  /* PRE-LINKS for panes THIS ENGINE spawned (the /new-session pre-mint). A
   * fresh claude writes no transcript jsonl for a while, so a cold-start pane
   * has nothing for the locate to link and used to sit unlinked, which kept
   * app-started sessions out of the app. newTab knows both halves of the link
   * at spawn time (the pane id it just created, and the CYC_AGENT_ID the launch
   * command carries), so it records the pair here and emits it as a RAW FACT;
   * the identity layer (sessions/tmux-link.ts) emits it as the pane's ref until
   * transcript discovery supersedes it. This is a spawn observation the mux
   * owns, not a linking decision: which jsonl wins is decided downstream. */
  private preLinks = new Map<string, AgentSessionRef>();
  /* Spawn instant per pre-linked pane, the identity layer's premint adoption
   * floor: a fresh spawn in a cwd that already holds transcripts from OTHER
   * sessions must not adopt their newest jsonl. A raw spawn fact; the floor
   * comparison itself is the identity layer's. */
  private preLinkSpawnAt = new Map<string, number>();
  /** The unregister for this mux's hook-announce poke (see start/stop). */
  private offHookAnnounce: (() => void) | null = null;
  /* FIRST-SEEN instant per pane: the poll at which the mux first enumerated
   * this handle. A pure observation the mux owns; the identity layer uses it as
   * a hand-started pane's adoption floor (a pane that APPEARS mid-run may only
   * adopt a jsonl born at or after this instant), refusing a pre-existing
   * stranger jsonl (the 571 disease) while the pane's own newborn transcript
   * still clears. */
  private firstSeenAt = new Map<string, number>();
  /* Handles present at the mux's FIRST successful enumeration. The identity
   * layer exempts these from the first-seen floor: an engine restart must
   * re-adopt live conversations by the plain newest-jsonl rule, and their
   * transcripts necessarily predate the restart. */
  private firstEnum = new Set<string>();
  // birth time per jsonl path: fs birthtime when the fs has one, else the
  // mtime at first sight (a live transcript's mtime keeps moving, so only the
  // first sighting approximates birth)
  private jsonlBornAt = new Map<string, number>();
  // last logged pane/agent state, so the log carries CHANGES only (no per-poll
  // spam when nothing moved)
  private lastPanes = new Map<string, { command: string; cwd: string }>();
  private lastAgents = new Map<string, { agent: string; status: AgentStatus; link: string | null }>();
  // per-pane-key state-change counter, bumped on each edge logChanges detects
  // (a pane appearing/going, an agent detected/lost, a status flip, a
  // link/unlink). Emitted in place of the old hardcoded stateChangeSeq: 0 so
  // anything keyed on this seq (herdr moves it natively) finally moves on tmux.
  // Keyed by the reuse-proof pane key, so a recycled %N inherits nothing; a
  // vanished pane's counter is dropped when the pane leaves.
  private stateChangeSeq = new Map<string, number>();
  // first-poll narration + unreachable-edge logging (see poll below)
  private everListed = false;
  private unreachable = false;
  // edge flag for the authoritative no-server answer (see poll below)
  private noServer = false;
  /* Bounded diagnostic for the launchd mystery: list-panes exiting 0 with NO
   * output while every terminal sees the panes. Modern tmux resolves its
   * socket dir as TMUX_TMPDIR, else TMPDIR, else /tmp, and a launchd service
   * can carry a different TMPDIR than a terminal, so the leading theory is
   * socket-dir divergence inside THIS process. The first empty enumerations
   * name it from inside; capped so it can never spam. */
  private emptyEnumDiags = 0;

  /** `pollMs` is the enumeration cadence. It is a parameter only so a test can
   *  watch the loop do its second lap without spending two real seconds on it;
   *  every production caller (adapters/factory.ts, mux.ts) omits it and gets
   *  POLL_MS. */
  constructor(socket?: string, private readonly pollMs: number = POLL_MS) {
    this.sockArgs = socket ? ["-L", socket] : [];
  }

  onAgents(cb: (agents: MuxAgent[]) => void): void {
    this.listeners.push(cb);
    if (this.agents.length) cb(this.agents);
  }

  start(): void {
    /* IDEMPOTENT: the instance is shared (sharedTmuxMux), so two owners both
     * calling start() must not stack a second interval. A stopped mux can be
     * started again (stop() clears the timer). */
    if (this.timer) return;
    this.stopped = false;
    /* Logged so a boot that never starts the poll is visible by its absence:
     * the live "zero [tmux] lines" failure was indistinguishable from a quiet
     * poll until this line existed. */
    const sock = this.sockArgs.length ? ` (socket ${this.sockArgs[1]})` : "";
    console.log(`[tmux] poll started${sock}, every ${this.pollMs}ms`);
    // a fresh hook announce triggers an immediate lap, so the bind lands in
    // milliseconds rather than waiting out the poll cadence
    this.offHookAnnounce ??= onHookAnnounce(() => void this.poll());
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.offHookAnnounce?.();
    this.offHookAnnounce = null;
  }

  // ---------------------------------------------------------------- verbs

  /** The `-t` target for a handle (composite pane key or bare %N); throws on
   *  anything else, so no forged handle reaches tmux. */
  private targetOf(handle: string): string {
    const t = paneTargetOf(handle);
    if (!t) throw new Error(`bad pane id ${handle}`);
    return t;
  }

  async readPane(paneId: string, lines: number): Promise<{ text: string; truncated: boolean }> {
    const target = this.targetOf(paneId);
    // `-p` print, `-e` keep escape sequences (ANSI IS THE SUPERSET; see
    // herdr.readPane). capture-pane returns the full visible viewport, so it is
    // never truncated the way herdr's read could be.
    const { ok, out, err } = await this.tmux(["capture-pane", "-p", "-e", "-t", target]);
    if (!ok) throw new Error(`capture-pane ${paneId}: ${err.trim() || "failed"}`);
    // Bound to the last `lines` rows, the same contract herdr.readPane has. The
    // box the delivery guard classifies is always at the bottom, so tailing keeps
    // exactly what matters and drops only scrollback above it.
    const rows = out.replace(/\n$/, "").split("\n");
    const text = (rows.length > lines ? rows.slice(rows.length - lines) : rows).join("\n");
    return { text, truncated: false };
  }

  async sendText(paneId: string, text: string): Promise<void> {
    const target = this.targetOf(paneId);
    // `-l` sends the string literally (no key-name lookup); `--` guards text that
    // begins with a dash. It does NOT submit; the caller sends Enter separately.
    const { ok, err } = await this.tmux(["send-keys", "-t", target, "-l", "--", text]);
    if (!ok) throw new Error(`send-keys -l ${paneId}: ${err.trim() || "failed"}`);
  }

  async sendKeys(paneId: string, ...keys: string[]): Promise<void> {
    const target = this.targetOf(paneId);
    const mapped = keys.map(tmuxKey);
    const { ok, err } = await this.tmux(["send-keys", "-t", target, ...mapped]);
    if (!ok) throw new Error(`send-keys ${paneId} ${mapped.join(" ")}: ${err.trim() || "failed"}`);
  }

  async renamePane(paneId: string, label: string): Promise<void> {
    const target = this.targetOf(paneId);
    // The closest tmux analog to herdr's pane label is the pane title. Best
    // effort, exactly as the herdr rename is: the engine keeps its own name
    // either way (names.ts), so a tmux that refuses this changes nothing here.
    const { ok, err } = await this.tmux(["select-pane", "-t", target, "-T", label]);
    if (!ok) throw new Error(`select-pane -T ${paneId}: ${err.trim() || "failed"}`);
  }

  async closePane(paneId: string): Promise<void> {
    const target = this.targetOf(paneId);
    const { ok, err } = await this.tmux(["kill-pane", "-t", target]);
    if (!ok) throw new Error(`kill-pane ${paneId}: ${err.trim() || "failed"}`);
  }

  workspaceOf(paneId: string): string | null {
    return this.sessionByPane.get(paneId) ?? null;
  }

  knownCwds(): string[] {
    const out: string[] = [];
    for (const a of this.agents) if (a.cwd && !out.includes(a.cwd)) out.push(a.cwd);
    return out;
  }

  async newTab(opts: { workspaceId?: string | null; cwd: string; label?: string; command: string }): Promise<string> {
    // Two shapes. With a workspaceId the caller wants the pane INSIDE that
    // existing session (`new-window -t`), and a missing session fails loudly.
    // Without one (the app starting a fresh agent) each agent gets its OWN tmux
    // session: `new-session -d` needs no running server (it boots one), so this
    // works on a machine where tmux has never been started. `-P -F` prints the
    // new pane id; `-c` sets the start directory; `-x/-y` because a detached
    // session otherwise defaults to 80x24.
    // The print carries the pane id AND the reuse-proof key's other two parts
    // (pane pid, server pid, server start time), so the key the pre-link is
    // recorded under is IDENTICAL to the key the next enumeration builds.
    const SPAWN_FMT = "#{pane_id}\t#{pane_pid}\t#{pid}\t#{start_time}";
    let res: { ok: boolean; out: string; err: string };
    if (opts.workspaceId) {
      const args = ["new-window", "-d", "-P", "-F", SPAWN_FMT, "-c", opts.cwd, "-t", opts.workspaceId];
      if (opts.label) args.push("-n", opts.label);
      res = await this.tmux(args);
      if (!res.ok || !PANE_RE.test(res.out.trim().split("\t")[0] ?? "")) {
        throw new Error(`new-window: ${res.err.trim() || res.out.trim() || "no pane"}`);
      }
    } else {
      const base = ["new-session", "-d", "-P", "-F", SPAWN_FMT, "-c", opts.cwd, "-x", "200", "-y", "50"];
      // Session named after the label (tmux forbids `.`/`:`; keep it simple).
      // A duplicate name is not worth failing over: retry unnamed and tmux
      // auto-numbers the session.
      const name = (opts.label ?? "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
      res = await this.tmux(name ? [...base, "-s", name] : base);
      if (!res.ok && name && /duplicate session/i.test(res.err)) res = await this.tmux(base);
      if (!res.ok || !PANE_RE.test(res.out.trim().split("\t")[0] ?? "")) {
        throw new Error(`new-session: ${res.err.trim() || res.out.trim() || "no pane"}`);
      }
    }
    const f = res.out.trim().split("\t");
    const paneId = paneKey(f[0], Number(f[1]) || 0, Number(f[3]) || Number(f[2]) || 0);
    /* Record the pre-minted link BEFORE the prompt wait: a poll can enumerate
     * the pane while the shell is still coming up, and it must already carry
     * its identity. The id is parsed back out of the launch command because the
     * command prefix (agent-env.ts withAgentEnv) is the one mechanism both
     * spawn paths hand the child its id through; a hand-started pane never has
     * the prefix and never lands here. */
    const mint = opts.command.match(/\bCYC_AGENT_ID=(ag-[A-Za-z0-9_-]{16})\b/);
    if (mint) {
      this.preLinks.set(paneId, { id: mint[1], kind: "id", source: PREMINT_SOURCE });
      this.preLinkSpawnAt.set(paneId, Date.now());
      console.log(`[tmux] + pre-linked ${paneId} -> ${mint[1]} (engine spawn)`);
    }
    // A new shell must be READY before it is typed at. A blind 400ms pause
    // raced shell startup: on a freshly booted server the shell was still
    // initializing past 400ms and ate the first keystrokes, so `env CYC_...`
    // arrived as `nv CYC_...` and the agent never started. The only honest
    // ready signal is the prompt being painted, so wait for it (both the
    // new-window and new-session paths land here; a slow shell races either).
    await this.awaitPrompt(paneId);
    await this.sendText(paneId, opts.command);
    await this.sendKeys(paneId, "enter");
    return paneId;
  }

  /** Poll capture-pane until the pane shows any non-whitespace output (the
   *  shell's prompt is painted), so keys sent next cannot land before the
   *  shell is reading. Same wait the tmux tests use for their fixture shells.
   *  Capped at 5s and returns either way: the caller types regardless, since
   *  typing late beats never typing. */
  private async awaitPrompt(paneId: string): Promise<void> {
    const target = this.targetOf(paneId);
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { ok, out } = await this.tmux(["capture-pane", "-p", "-t", target]);
      if (ok && out.trim().length > 0) return;
      if (Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Retire a pre-link and the spawn instant recorded alongside it. */
  private dropPreLink(paneId: string): void {
    this.preLinks.delete(paneId);
    this.preLinkSpawnAt.delete(paneId);
  }

  /** Birth instant of a jsonl: the fs birthtime when the fs provides one, else
   *  the mtime the FIRST time this mux saw the file (cached; a live
   *  transcript's mtime keeps moving). null when the file cannot be stat'ed. */
  private bornAt(path: string): number | null {
    const cached = this.jsonlBornAt.get(path);
    if (cached !== undefined) return cached;
    try {
      const st = statSync(path);
      const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
      this.jsonlBornAt.set(path, born);
      return born;
    } catch {
      return null;
    }
  }

  /** The newest claude jsonl the mux can SEE under a cwd, with the file's birth
   *  instant, as a RAW candidate. Pure observation: whether it is adopted (the
   *  birth floor, the 571 refusal, the ambiguity degrade) is the identity
   *  layer's decision, not the mux's. */
  private candidateOf(cwd: string): TmuxLinkFacts["candidate"] {
    const loc = locateLatestClaude(cwd);
    if (!loc) return null;
    return { sessionId: loc.sessionId, path: loc.path, bornAt: this.bornAt(loc.path) };
  }

  // ---------------------------------------------------------------- internals

  /** One tmux CLI call. argv, so there is no shell to interpolate into. */
  private async tmux(args: string[]): Promise<{ ok: boolean; out: string; err: string; exit: number }> {
    try {
      // env passed explicitly: Bun snapshots the environment at startup for
      // default-inherit spawns, so the LANG that ensureUtf8Locale injects at
      // boot would never reach the tmux child without spreading the live
      // process.env here.
      const proc = Bun.spawn(["tmux", ...this.sockArgs, ...args],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      return { ok: code === 0, out, err, exit: code };
    } catch (e) {
      return { ok: false, out: "", err: e instanceof Error ? e.message : String(e), exit: -1 };
    }
  }

  /** One "[tmux] empty-enum diag" block per ok-but-empty enumeration, at most
   *  three per process. Pure logging: nothing here changes what the poll does
   *  with the empty list. display-message may error with no attached session;
   *  whatever comes back is logged as-is. */
  private async logEmptyEnumDiag(): Promise<void> {
    if (this.emptyEnumDiags >= 3) return;
    this.emptyEnumDiags++;
    const raw = (r: { out: string; err: string; exit: number }) =>
      JSON.stringify({ out: r.out, err: r.err, exit: r.exit });
    const lp = await this.tmux(["list-panes", "-a"]);
    const lpf = await this.tmux(["list-panes", "-a", "-F", LIST_PANES_FMT]);
    const ls = await this.tmux(["ls"]);
    const sp = await this.tmux(["display-message", "-p", "#{socket_path}"]);
    // per raw line of the -F variant: how many tab-separated fields it carries
    const fieldCounts = lpf.out.split("\n")
      .filter((l) => l.length > 0)
      .map((l) => l.split("\t").length);
    console.log(
      `[tmux] empty-enum diag ${this.emptyEnumDiags}/3: list-panes ok with zero panes\n` +
      `  TMUX_TMPDIR=${process.env.TMUX_TMPDIR ?? "(unset)"}\n` +
      `  TMPDIR=${process.env.TMPDIR ?? "(unset)"}\n` +
      `  sockArgs=${JSON.stringify(this.sockArgs)}\n` +
      `  list-panes -a: ${raw(lp)}\n` +
      `  list-panes -a -F FMT: ${raw(lpf)}\n` +
      `  FMT=${JSON.stringify(LIST_PANES_FMT)}\n` +
      `  -F line field counts: ${JSON.stringify(fieldCounts)}\n` +
      `  ls: ${raw(ls)}\n` +
      `  socket_path: ${raw(sp)}`,
    );
  }

  /** Enumerate panes, derive agents, emit. Never throws; a poll that cannot
   *  reach tmux keeps the last known set rather than declaring everything dead. */
  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      /* Snapshot the pre-link keys BEFORE list-panes runs: a newTab landing
       * mid-poll records its link after this poll's pane list was taken, and
       * pruning that fresh link against the stale list would drop it before
       * the pane was ever enumerated. Only links that predate the snapshot
       * are eligible for pruning this lap. */
      const preLinksBefore = new Set(this.preLinks.keys());
      const listed = await this.listPanes();
      if (listed === null) {
        /* tmux unreachable this tick; keep the last set. Logged ON THE EDGE
         * only: a poll that silently returned here forever was
         * indistinguishable from a poll that never ran. */
        if (!this.unreachable) {
          this.unreachable = true;
          console.log("[tmux] server unreachable; keeping the last agent set");
        }
        return;
      }
      if (this.unreachable) {
        this.unreachable = false;
        console.log("[tmux] server reachable again");
      }
      let panes: Pane[];
      if (listed === NO_SERVER) {
        /* "no server running" is an AUTHORITATIVE zero, not a transient
         * failure: after kill-server every pane is gone, and keeping the last
         * set would list dead agents forever. When nothing was being tracked
         * (engine booted before tmux ever started) stay quiet: no emit, so the
         * app's list is untouched until a server actually appears. */
        if (this.agents.length === 0 && this.lastPanes.size === 0 &&
            this.preLinks.size === 0) {
          if (!this.noServer) {
            this.noServer = true;
            console.log("[tmux] no server yet; waiting for one to start");
          }
          return;
        }
        if (!this.noServer) {
          this.noServer = true;
          console.log("[tmux] no server; all panes gone");
        }
        panes = [];
      } else {
        this.noServer = false;
        panes = listed;
        if (panes.length === 0) await this.logEmptyEnumDiag();
      }
      const procs = await this.processTree();
      /* STOPPED IS CHECKED AGAIN HERE, after the two awaits. A poll already in
       * flight when stop() lands used to run to completion and emit, so a
       * listener that had just been torn down still got one more set of agents
       * after the mux was shut down. Cheap to check, and it makes stop() mean
       * stopped rather than "stopped once the current lap finishes". */
      if (this.stopped) return;
      /* THE ANNOUNCE RESOLUTION runs before detection so a bind landed this
       * lap is already visible in this lap's emit. The enumeration here is
       * authoritative (unreachable ticks returned above), so it may also prune
       * binds whose pane is gone -- scoped to tmux-shaped handles only. */
      this.resolveAnnounces(panes, procs);
      /* RAW OBSERVATION recorded before detection: the first-sight instant of
       * every pane (the identity layer's hand-started floor) and, on the first
       * successful enumeration, which panes were already present (exempt from
       * that floor). No linking decision is made here or in detectAgents; both
       * only report facts. */
      for (const p of panes) if (!this.firstSeenAt.has(p.key)) this.firstSeenAt.set(p.key, Date.now());
      if (!this.everListed) for (const p of panes) this.firstEnum.add(p.key);
      const agents = this.detectAgents(panes, procs);
      await this.refineBlocked(agents);
      if (this.stopped) return; // refineBlocked awaited; same rule as above
      /* Every per-pane memory below is keyed by the REUSE-PROOF pane key, so
       * these prunes are hygiene, not correctness: even when a death is never
       * observed (the 2s blind spot, a dead server behind a live socket), a
       * recycled %N arrives under a NEW key and can inherit nothing. */
      // a pre-link dies with its pane
      for (const id of [...this.preLinks.keys()]) {
        if (preLinksBefore.has(id) && !panes.some((p) => p.key === id)) this.dropPreLink(id);
      }
      // the first-seen floor dies with its pane too
      for (const id of [...this.firstSeenAt.keys()]) {
        if (!panes.some((p) => p.key === id)) this.firstSeenAt.delete(id);
      }
      /* The FIRST successful enumeration narrates what it found, even when
       * that is nothing: a restart against a live tmux server must say what it
       * sees. logChanges below then lists each pane/agent (its "last" maps are
       * empty on the first lap), and quiet laps afterwards stay silent. */
      if (!this.everListed) {
        this.everListed = true;
        console.log(`[tmux] first poll: ${panes.length} pane(s), ${agents.length} agent(s)`);
      }
      this.logChanges(panes, agents);
      /* Keyed by BOTH shapes: the composite key (what core hands back) and the
       * bare %N (raw-id callers, e.g. a spawn path that only has the target).
       * Rebuilt whole every poll, so neither entry can outlive its pane. */
      this.sessionByPane = new Map(panes.flatMap((p) =>
        [[p.key, p.session], [p.paneId, p.session]] as Array<[string, string]>));
      this.agents = agents;
      this.emit();
    } catch (e) {
      console.error("[tmux] poll:", e);
    }
  }

  /* STATE-CHANGE LOG, "[tmux]"-prefixed. Only edges are written: a pane
   * appearing or going, an agent being detected or lost in one, a status flip,
   * a link/unlink. A poll where nothing moved writes nothing, so the log reads
   * as a timeline rather than a heartbeat. */
  private logChanges(panes: Pane[], agents: MuxAgent[]): void {
    // bump one pane key's state-change counter, one step per detected edge
    const bump = (id: string) =>
      this.stateChangeSeq.set(id, (this.stateChangeSeq.get(id) ?? 0) + 1);
    const nowPanes = new Map(panes.map((p) => [p.key, { command: p.command, cwd: p.cwd }]));
    for (const [id, p] of nowPanes) {
      if (!this.lastPanes.has(id)) { console.log(`[tmux] + pane ${id} (${p.command}, ${p.cwd})`); bump(id); }
    }
    for (const [id, p] of this.lastPanes) {
      if (!nowPanes.has(id)) console.log(`[tmux] - pane ${id} (${p.command}, ${p.cwd})`);
    }
    const nowAgents = new Map(agents.map((a) => [a.paneId, {
      agent: a.agent, status: a.status,
      link: a.agentSession ? `${a.agentSession.id} (${a.agentSession.source})` : null,
    }]));
    for (const [id, a] of nowAgents) {
      const was = this.lastAgents.get(id);
      if (!was) {
        console.log(`[tmux] agent ${a.agent} detected in ${id} (${a.status})`);
        if (a.link) console.log(`[tmux] ${id} linked ${a.link}`);
        bump(id);
        continue;
      }
      if (was.status !== a.status) { console.log(`[tmux] ${id} status ${was.status} -> ${a.status}`); bump(id); }
      if (was.link !== a.link) {
        if (a.link) console.log(`[tmux] ${id} linked ${a.link}${was.link ? `, was ${was.link}` : ""}`);
        else console.log(`[tmux] ${id} unlinked (was ${was.link})`);
        bump(id);
      }
    }
    for (const [id, a] of this.lastAgents) {
      if (!nowAgents.has(id)) { console.log(`[tmux] agent ${a.agent} lost in ${id}`); bump(id); }
    }
    this.lastPanes = nowPanes;
    this.lastAgents = nowAgents;
    // Publish the counter onto each emitted agent (detectAgents left it 0), and
    // drop counters for panes that have left so the map cannot outlive them. A
    // key with no edge this poll keeps its number, so a quiet lap causes no
    // churn downstream.
    for (const a of agents) a.stateChangeSeq = this.stateChangeSeq.get(a.paneId) ?? 0;
    for (const id of [...this.stateChangeSeq.keys()]) {
      if (!nowPanes.has(id)) this.stateChangeSeq.delete(id);
    }
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try {
        cb(this.agents);
      } catch (e) {
        console.error("[tmux] onAgents listener threw:", e);
      }
    }
  }

  /** All panes on the server. An empty array means the server is up with no
   *  panes. NO_SERVER means tmux said outright that no server exists ("no
   *  server running" / "error connecting ... No such file or directory"): that
   *  is an AUTHORITATIVE statement of zero panes (kill-server, first boot),
   *  not a transient failure. null is reserved for every OTHER failure (the
   *  truly ambiguous "could not reach tmux this tick"), which the poll treats
   *  as keep-the-last-set. */
  private async listPanes(): Promise<Pane[] | typeof NO_SERVER | null> {
    const { ok, out, err } = await this.tmux(["list-panes", "-a", "-F", LIST_PANES_FMT]);
    if (!ok) {
      /* The connect-failure family is all the SAME fact: there is no live
       * server on this socket. "No such file or directory" is the socket being
       * gone; "Connection refused" (and a reset) is a DEAD server behind a
       * still-present socket file -- the hole through which a recycled %0 used
       * to inherit a dead pane's memory, because the poll read it as transient
       * and kept the last agent set forever. */
      if (/no server running/i.test(err) ||
          /error connecting to .*(No such file or directory|Connection refused|Connection reset)/i.test(err)) {
        return NO_SERVER;
      }
      return null;
    }
    const panes: Pane[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const f = line.split("\t");
      if (f.length < 7) {
        // No tabs but the underscore-mangled shape (`%0_24635_...`): tmux
        // sanitized the -F separators because the client has no UTF-8 locale.
        // Do not guess at fields; name the failure once per process.
        if (!warnedSanitizedSeparators && !line.includes("\t") && /^%\d+_/.test(line)) {
          warnedSanitizedSeparators = true;
          console.error("[tmux] enumeration separators sanitized; locale missing?");
        }
        continue;
      }
      const pid = Number(f[1]) || 0;
      // server boot epoch: start_time when this tmux reports it, else the
      // server pid (both change when the server does, which is the property
      // the reuse-proof key needs)
      const epoch = Number(f[8]) || Number(f[7]) || 0;
      panes.push({
        paneId: f[0], key: paneKey(f[0], pid, epoch), pid, command: f[2], cwd: f[3],
        session: f[4], windowId: f[5], windowName: f[6],
      });
    }
    return panes;
  }

  /** Every process as {pid, ppid, comm}, so a pane's descendants can be walked
   *  for a claude process. One `ps` per poll, not one per pane. */
  private async processTree(): Promise<Map<number, ProcNode[]>> {
    const byPpid = new Map<number, ProcNode[]>();
    const { ok, out } = await this.psAll();
    if (!ok) return byPpid;
    for (const line of out.split("\n")) {
      // pid and ppid are numeric, comm is taken as the next whitespace-free
      // token, and everything after it is the command line (args holds spaces).
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
      if (!m) continue;
      const node: ProcNode = {
        pid: Number(m[1]), ppid: Number(m[2]), comm: m[3], args: (m[4] ?? "").trim(),
      };
      const arr = byPpid.get(node.ppid) ?? [];
      arr.push(node);
      byPpid.set(node.ppid, arr);
    }
    return byPpid;
  }

  private async psAll(): Promise<{ ok: boolean; out: string }> {
    try {
      const proc = Bun.spawn(["ps", "-axo", "pid=,ppid=,comm=,args="], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(proc.stdout).text();
      return { ok: (await proc.exited) === 0, out };
    } catch {
      return { ok: false, out: "" };
    }
  }

  /* AGENT DETECTION, engine-side (contract verb 5).
   *
   * A pane runs an agent when its foreground command is a known agent id
   * (agents.ts), or a descendant process under its pane pid is (the `ps on
   * pane_pid's children` half of the contract, for an agent wrapped in a shell
   * script). agentOf returns which one, or null.
   *
   * LINKING is NOT done here (design Gap 2). Linking is identity inference --
   * which jsonl a pane owns, gated by the birth floors, the 571 refusal, the
   * sticky handover and the ambiguity degrade -- and it moved behind the
   * identity layer (sessions/tmux-link.ts). This function only OBSERVES: it
   * pairs each pane with its detected agent and emits the RAW facts the linker
   * needs (the announce it saw, the newest jsonl it can see with that file's
   * birth, the premint and spawn time, the first-seen facts) on
   * MuxAgent.tmuxLink, leaving agentSession null for the linker to fill.
   */
  private detectAgents(panes: Pane[], procs: Map<number, ProcNode[]>): MuxAgent[] {
    // Each pane paired with the agent id running in it, or dropped when none is.
    // Was a boolean filter against the single HARNESS.id; now every known agent
    // (agents.ts) is detected the same way, so a tmux user running codex is a
    // session exactly as one running claude (invariant L1).
    const agentPanes = panes
      .map((p) => ({ p, agent: this.agentProcOf(p, procs) }))
      .filter((x): x is { p: Pane; agent: { id: string; pid: number } } => x.agent !== null);
    const claudePanes = agentPanes.map((x) => x.p);
    // EVERY per-pane map below keys on p.key (the reuse-proof pane key), never
    // on the bare %N: a recycled %N is a new key and inherits nothing.
    const agentById = new Map(agentPanes.map((x) => [x.p.key, x.agent.id]));

    // window count per session, to hide a lone auto-named tab the way herdr does
    const windowsPerSession = new Map<string, Set<string>>();
    for (const p of panes) {
      const set = windowsPerSession.get(p.session) ?? new Set<string>();
      set.add(p.windowId);
      windowsPerSession.set(p.session, set);
    }

    // dedupe display names across the whole set, exactly as herdr.list does
    const nameCount = new Map<string, number>();
    for (const p of claudePanes) {
      const base = p.cwd ? basename(p.cwd) : p.paneId;
      nameCount.set(base, (nameCount.get(base) ?? 0) + 1);
    }

    return claudePanes.map((p) => {
      const base = p.cwd ? basename(p.cwd) : p.paneId;
      const agent = agentById.get(p.key)!;
      const lone = windowsPerSession.get(p.session)?.size === 1;
      const status: AgentStatus = "idle"; // working/idle/blocked come from engine-side signals
      /* THE RAW jsonl-linking FACTS, with NO decision (design Gap 2). Which
       * candidate becomes the pane's session -- the announce override, the
       * birth floors, the 571 refusal, the sticky handover, the ambiguity
       * degrade -- is the identity layer's job (sessions/tmux-link.ts, driven
       * by the tmux adapter's TmuxLinker), not the mux's. The mux only
       * OBSERVES: the announce it saw land on this pane (any agent may
       * announce, so this is read for every kind), the newest claude jsonl it
       * can see under the cwd with that file's birth, the engine-spawn premint
       * and its spawn time, and the pane's first-seen / present-at-first-enum
       * facts. */
      const facts: TmuxLinkFacts = {
        handle: p.key,
        agent,
        cwd: p.cwd,
        announced: hookBindFor(p.key),
        candidate: agent === "claude" ? this.candidateOf(p.cwd) : null,
        premint: this.preLinks.get(p.key) ?? null,
        spawnAt: this.preLinkSpawnAt.get(p.key) ?? null,
        firstSeenAt: this.firstSeenAt.get(p.key) ?? null,
        presentAtFirstEnum: this.firstEnum.has(p.key),
      };
      return {
        // the reuse-proof key IS the pane's public handle: core keys every
        // per-pane memory by it, and the bare %N resurfaces only at `-t`
        paneId: p.key,
        name: (nameCount.get(base) ?? 0) > 1 ? `${base} (${p.paneId})` : base,
        cwd: p.cwd,
        status,
        agent,
        // no decision here: agentSession is filled by the identity layer. A raw
        // mux emit (a caller that never runs the linker) carries null rather
        // than a stale guess; production and the seam tests run the linker.
        agentSession: null,
        tmuxLink: facts,
        workspace: p.session,
        tab: lone ? null : p.windowName,
        displayAgent: null,
        // a level default; logChanges (run before emit) overwrites it with the
        // pane key's real edge counter, so a status/agent edge emits a bump.
        stateChangeSeq: 0,
      };
    });
  }

  /* BLOCKED, read off the screen (the header's contract: "screen for
   * blocked"). herdr reports blocked itself, via its own screen-scraping rule
   * manifest; tmux has no scraper, and the transcript can never carry blocked
   * (a permission dialog never reaches the jsonl), so without this read the
   * status never left "idle". Downstream that made every modal invisible in
   * the app: asks.ts only reads the screen of a session whose status is
   * "blocked" (initAsks poll, askOf), so a tmux claude sitting at the
   * first-boot trust prompt showed nothing at all. The check is the SAME
   * parser the ask path uses (parseAsk), over the same 60 rows, so a pane
   * called blocked here always has a question the ask read can render.
   * Linking is irrelevant to it on purpose: the trust prompt happens before
   * the first jsonl exists, so an unlinked pane must surface too. A pane that
   * cannot be read stays "idle" rather than guessing. */
  private async refineBlocked(agents: MuxAgent[]): Promise<void> {
    await Promise.all(agents.map(async (a) => {
      if (a.agent !== "claude") return; // parseAsk reads claude's dialogs only
      try {
        const { text } = await this.readPane(a.paneId, BLOCKED_READ_LINES);
        if (parseAsk(text)) a.status = "blocked";
      } catch {
        // unreadable screen: leave "idle"; the ask path reports its own unread
      }
    }));
  }

  /** Which known agent (agents.ts) runs in this pane -- as the foreground
   *  command, or as a descendant of the pane's process -- or null if none.
   *  Was a boolean against the single HARNESS.id; matching a set is what lets
   *  tmux list codex and opencode panes, not just claude. Answers the agent's
   *  PID too: the walk is top-down, so the pid is the TOPMOST agent process in
   *  the pane, which is what an announce's nearest-agent-ancestor must equal
   *  to bind (a background transient claude deeper in the tree never can). */
  private agentProcOf(p: Pane, procs: Map<number, ProcNode[]>): { id: string; pid: number } | null {
    /* THE PROCESS TREE ANSWERS FIRST, because the PID it answers is load
     * bearing: announce binding compares it against the announce's resolved
     * agent pid. The retired pane_current_command fast path answered p.pid,
     * the PANE ROOT -- for the everyday shape (claude started from an
     * interactive shell) that is the SHELL's pid, so a parked announce
     * retried every lap and could never match (the live shakedown bug: parked
     * "no pane for pid" forever while the pane visibly ran claude). */
    if (p.pid) {
      // The pane's own top process is a candidate too: a pane created running
      // claude directly (`tmux split-window claude`) has claude AS pane_pid,
      // no shell above it, and a descendants-only walk never looks at
      // pane_pid itself. procs is keyed by ppid, so find the node by pid.
      for (const nodes of procs.values()) {
        for (const node of nodes) {
          if (node.pid === p.pid) {
            const hit = agentIdOfProc(node.comm, node.args, () => resolveProcExe(node.pid));
            if (hit) return { id: hit, pid: node.pid };
          }
        }
      }
      const seen = new Set<number>();
      const stack = [p.pid];
      while (stack.length) {
        const pid = stack.pop()!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        for (const child of procs.get(pid) ?? []) {
          const hit = agentIdOfProc(child.comm, child.args, () => resolveProcExe(child.pid));
          if (hit) return { id: hit, pid: child.pid };
          stack.push(child.pid);
        }
      }
    }
    /* pane_current_command as the LAST resort, for a ps hiccup that hid the
     * process this lap: detection stays up, though the pid is the pane root's
     * and cannot bind an announce until ps shows the real process again. */
    if (AGENT_IDS.includes(p.command)) return { id: p.command, pid: p.pid };
    return null;
  }

  /* THE ANNOUNCE RESOLUTION. PID IS PRIMARY AND SUFFICIENT: each
   * parked announce is placed onto the pane whose detected (topmost) agent
   * process IS the announce's nearest agent ancestor -- the pid that survives
   * the hook's own exit -- and a pid hit binds REGARDLESS of any witness. A
   * background transient claude inside the same pane is its OWN nearest agent
   * ancestor, never the pane's topmost one, so its announce can never steal
   * the pane and simply expires (that is also why the witness fallback below
   * applies ONLY when the pid walk yielded nothing, never when it resolved a
   * pid no pane holds). When the walk yielded nothing (an exited chain, a ps
   * hiccup) the LANE'S OWN witness -- tmuxPane, the $TMUX_PANE from inside
   * the announcing claude -- is the fallback; only live panes are matched, so
   * at most one generation of a %N can answer. herdrPane is the OTHER lane's
   * witness and is never consulted here: a tmux pane routinely inherits a
   * stale HERDR_PANE_ID from the herdr session that started the tmux server,
   * and letting it shadow the tmux id silently blocked real binds. Every
   * unplaced announce logs its parked reason once. Binds whose pane is gone
   * are pruned against the same authoritative enumeration every other
   * per-pane memory prunes against, scoped to tmux-shaped handles. */
  private resolveAnnounces(panes: Pane[], procs: Map<number, ProcNode[]>): void {
    const pend = pendingAnnounces();
    if (pend.length) {
      const detected = panes
        .map((p) => ({ p, agent: this.agentProcOf(p, procs) }))
        .filter((x) => x.agent !== null);
      for (const a of [...pend]) {
        if (a.agentPid !== null) {
          const byPid = detected.find((x) => x.agent!.pid === a.agentPid);
          if (byPid) takePending(a, byPid.p.key, "pid");
          else markParked(a, "no pane for pid");
          continue;
        }
        const byWitness = a.tmuxPane !== null
          ? detected.find((x) => x.p.paneId === a.tmuxPane) : undefined;
        if (byWitness) takePending(a, byWitness.p.key, "witness");
        else markParked(a, a.tmuxPane !== null ? "unknown witness" : "ttl-wait");
      }
    }
    pruneHookBinds(new Set(panes.map((x) => x.key)), (h) => PANE_KEY_RE.test(h));
  }
}

/** herdr key names -> tmux key names. The engine only ever sends "enter",
 *  "ctrl+c", or a single digit for a chooser selection. */
function tmuxKey(key: string): string {
  const k = key.toLowerCase();
  if (k === "enter") return "Enter";
  const ctrl = k.match(/^ctrl\+(.+)$/);
  if (ctrl) return `C-${ctrl[1]}`;
  return key; // a digit, or an already-tmux key name
}
