/* TmuxMux against REAL throwaway tmux servers (#480).
 *
 * The subject of this module IS driving the tmux binary, so faking tmux would
 * fake the thing under test: the five verbs are asserted against actual panes
 * with actual processes in them. What is faked is everything AROUND it. Each
 * test boots its own `tmux -L <unique>` server, so two tests (or two test files
 * in two parallel workers) can never see each other's panes, and afterAll kills
 * every server this file made even when a test throws. Nothing here touches the
 * user's tmux, the live herdr, or the real ~/.claude: CYC_PROJECTS_DIR is
 * pointed at a tmp tree for the whole file.
 *
 * NO SLEEPS. A shell coming up and a command producing output are real async
 * I/O with no logical clock to advance, so every wait is until() on the thing
 * actually being waited for, and a wrong answer says which condition never
 * became true instead of "expected 42 to contain".
 *
 *   bun test agent-engine/src/terminal/tmux.test.ts
 */

import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { TmuxMux, detachedBootPrefix, ensureUtf8Locale, paneKey, paneTargetOf, stillAwaitingSubmit } from "./tmux.ts";
import { handleAnnounce, pendingAnnounces, resetHookAnnounce } from "./hook-announce.ts";
import { TmuxLinker } from "../sessions/tmux-link.ts";
import type { MuxAgent } from "./mux.ts";
import { symlinkSync, writeFileSync, mkdirSync, utimesSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpDir } from "../test-utils/tmp.ts";
import { mungeCwd } from "../../../shared/claude-projects.ts";
import { until } from "../test-utils/wait.ts";

/** Spend `ms` of real time. Every other wait in this file polls the thing it is
 *  waiting for; proving an ABSENCE (no further emit after stop(), the last set
 *  surviving a dead server) is the one shape with nothing to poll, so it waits
 *  for the clock instead. until() is the only sanctioned way to spend it. */
async function elapse(ms: number): Promise<void> {
  const done = Date.now() + ms;
  await until(() => Date.now() >= done, { timeoutMs: ms + 2_000, what: `${ms}ms of quiet` });
}

/* THE SKIP IS LOUD ON PURPOSE.
 *
 * A box with no tmux binary cannot prove any of this, and a suite that goes
 * green while silently proving nothing is worse than a red one: the tmux path
 * is a whole supported multiplexer (CYC_MUX=tmux). So the file says exactly
 * what did not run and why, once, at load. */
const TMUX = Bun.which("tmux");
if (!TMUX) {
  console.warn(
    "\n[tmux.test.ts] SKIPPED: no `tmux` binary on PATH.\n" +
    "  NOT proven on this box: capture-pane -e keeps ANSI, send-keys -l types\n" +
    "  without submitting, Enter submits, new-window -d spawns unfocused, and\n" +
    "  engine-side agent detection/linking. Install tmux to run them.\n",
  );
}
const t = test.skipIf(!TMUX);

/* A "claude" whose only job is to exist under a pane long enough to be seen.
 * `sleep` symlinked under an agent's name: the kernel's comm becomes the link
 * name, which is exactly what pane_current_command and `ps -o comm=` report,
 * so detection sees a real process rather than a string the test handed it. */
const SLEEP = Bun.which("sleep") ?? "/bin/sleep";

let PROJECTS = "";       // the tmp stand-in for ~/.claude/projects
let BIN = "";            // holds the agent-named symlinks

/* ENV IS TOUCHED ONCE, AT FILE SCOPE, AND PUT BACK.
 *
 * CYC_PROJECTS_DIR is read per call by locateLatestClaude, so the whole file's
 * linking happens in a tree nobody else owns and the real ~/.claude is never
 * even stat'ed.
 *
 * TMUX_TMPDIR would have been the tidy way to keep the socket files out of the
 * shared /tmp/tmux-<uid>/ too, and it does not work: Bun snapshots the
 * environment at startup, so a spawned tmux never sees an env var this process
 * set after it booted (measured; `Bun.spawnSync(["sh","-c","echo $X"])` prints
 * nothing). The sockets are unlinked by hand instead, below. */
const SAVED: Record<string, string | undefined> = {};
/* CYC_DATA_DIR joins the swap: the announce store (hook-announce.ts) persists
 * pane binds under state/, and the poll's bind prune reads that store, so the
 * whole file must run against a tmp data dir, never ~/.callyourcode. */
const CLEARED = ["CYC_PROJECTS_DIR", "CYC_DATA_DIR"];

beforeAll(async () => {
  for (const k of CLEARED) SAVED[k] = process.env[k];
  const root = await tmpDir("cyc-tmux-");
  PROJECTS = join(root, "projects");
  mkdirSync(PROJECTS, { recursive: true });
  process.env.CYC_PROJECTS_DIR = PROJECTS;
  process.env.CYC_DATA_DIR = join(root, "data");
  resetHookAnnounce(); // forget any store loaded against the previous data dir
  BIN = join(root, "bin");
  mkdirSync(BIN, { recursive: true });
  for (const agent of ["claude", "codex"]) symlinkSync(SLEEP, join(BIN, agent));
});

afterAll(() => {
  for (const k of CLEARED) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k]!;
  }
  resetHookAnnounce();
});

/* ------------------------------------------------------------ a private tmux */

const servers: Array<{ sock: string; muxes: TmuxMux[]; socketPath?: string }> = [];

/** Every server this file made is killed here, whether its test passed, failed
 *  or threw: a leaked tmux server is a daemon left on his box, and a leaked
 *  socket file is litter in the dir his real tmux lives in. kill-server does
 *  the first and NOT the second (measured: the socket stays until something
 *  unlinks it), so both are done here. */
/* Every mux is stopped after EACH test, not only in the file-wide afterAll: a
 * running mux keeps polling its (still-alive) server and stays subscribed to
 * onHookAnnounce, and its poll prunes the SHARED announce-bind store against
 * its OWN live panes -- so a mux left over from one test (e.g. one whose body
 * timed out before reaching mux.stop()) deletes a bind the next test just made,
 * and the announce/witness tests fail only when a sibling leaked one. Stopping
 * per test cancels that async work before the next test starts (one tmux mux is
 * ever real in the app, so this cross-mux interference cannot arise there). */
afterEach(() => {
  for (const s of servers) {
    for (const m of s.muxes) { try { m.stop(); } catch { /* already stopped */ } }
  }
});

afterAll(() => {
  for (const s of servers) {
    for (const m of s.muxes) { try { m.stop(); } catch { /* already stopped */ } }
    Bun.spawnSync(["tmux", "-L", s.sock, "kill-server"]);
    if (s.socketPath) rmSync(s.socketPath, { force: true });
  }
});

function tmuxServer(name: string) {
  // pid + a counter + randomness: unique across tests, across files running in
  // parallel workers, and across two runs of the suite at once.
  const sock = `cyc-${name}-${process.pid}-${servers.length}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: { sock: string; muxes: TmuxMux[]; socketPath?: string } = { sock, muxes: [] };
  servers.push(entry);

  /** A raw tmux call against this socket, for setup and for assertions that
   *  must NOT go through the code under test. */
  const raw = (...args: string[]): string =>
    Bun.spawnSync(["tmux", "-L", sock, ...args]).stdout.toString();

  raw("new-session", "-d", "-s", "base", "-x", "200", "-y", "50");
  // asked rather than assembled: tmux, not this test, decides where the socket
  // for `-L <name>` lives (TMUX_TMPDIR, /tmp/tmux-<uid>/, a build default)
  entry.socketPath = raw("display-message", "-p", "#{socket_path}").trim() || undefined;

  const api = {
    sock,
    raw,
    /** A fresh unfocused window. With `cmd`, tmux runs it INSTEAD of a shell,
     *  which is how a pane gets a known foreground process with no prompt race. */
    window(cwd: string, ...cmd: string[]): string {
      const id = raw("new-window", "-d", "-P", "-F", "#{pane_id}", "-c", cwd, ...cmd).trim();
      expect(id).toMatch(/^%\d+$/);
      return id;
    },
    /** A window running a plain `sh`, waited on until its prompt is painted.
     *  `sh` rather than the user's login shell so the pane looks the same on
     *  every box; the prompt is the only honest "ready for keys" signal. */
    async shell(cwd = "/tmp"): Promise<string> {
      const pane = api.window(cwd, "sh");
      await until(() => raw("capture-pane", "-p", "-t", pane).trim().length > 0,
        { timeoutMs: 5_000, what: `a shell prompt in ${pane}` });
      return pane;
    },
    field(pane: string, fmt: string): string {
      return raw("list-panes", "-a", "-F", `#{pane_id}\t${fmt}`)
        .split("\n").find((l) => l.startsWith(pane + "\t"))?.split("\t")[1] ?? "";
    },
    panes(): string[] {
      return raw("list-panes", "-a", "-F", "#{pane_id}").split("\n").filter(Boolean);
    },
    capture(pane: string): string {
      return raw("capture-pane", "-p", "-t", pane);
    },
    /** Wait until the pane's foreground process is `cmd` (the exec landed). */
    async command(pane: string, cmd: string): Promise<void> {
      await until(() => api.field(pane, "#{pane_current_command}") === cmd,
        { timeoutMs: 5_000, what: `pane_current_command of ${pane} to be ${cmd}` });
    },
    async sees(pane: string, text: string): Promise<void> {
      await until(() => api.capture(pane).includes(text),
        { timeoutMs: 5_000, what: `${JSON.stringify(text)} on screen in ${pane}` });
    },
    mux(pollMs?: number): TmuxMux {
      const m = pollMs == null ? new TmuxMux(sock) : new TmuxMux(sock, pollMs);
      entry.muxes.push(m);
      return m;
    },
    alive(): boolean {
      return Bun.spawnSync(["tmux", "-L", sock, "list-sessions"]).exitCode === 0;
    },
    kill(): void {
      Bun.spawnSync(["tmux", "-L", sock, "kill-server"]);
    },
  };
  return api;
}

/* The tmux mux emits only RAW pane facts now (MuxAgent.tmuxLink); the
 * jsonl-linking DECISION -- the birth floors, the 571 refusal, the sticky
 * handover, the ambiguity degrade, the announce override -- moved behind the
 * identity layer (sessions/tmux-link.ts, design Gap 2). These end-to-end
 * tests still drive REAL tmux for the observation, then run each emit through
 * the SAME identity step the tmux adapter runs (a per-watch TmuxLinker), so the
 * `agentSession` they assert on is exactly what production produces. This is
 * the byte-for-byte mirror of TmuxMuxAdapter.refineAgents. */
function linkEmit(linker: TmuxLinker, agents: MuxAgent[]): MuxAgent[] {
  const refs = linker.resolve(agents.flatMap((a) => (a.tmuxLink ? [a.tmuxLink] : [])), Date.now());
  return agents.map((a) =>
    a.tmuxLink ? { ...a, agentSession: refs.get(a.tmuxLink.handle) ?? null } : a);
}

/** Register a listener, keep every emit (identity-resolved), and wait for one
 *  that satisfies `pred`. Registered BEFORE start() so the very first poll is
 *  not missed. */
function watch(m: TmuxMux) {
  const emits: MuxAgent[][] = [];
  const linker = new TmuxLinker();
  m.onAgents((a) => emits.push(linkEmit(linker, a)));
  return {
    emits,
    /* The predicate is checked against the LATEST emit only, never the history.
     * Scanning the history looks more forgiving and is a trap: "wait for one
     * agent" would match the emit from before the pane was killed and hand the
     * test a set that stopped being true two laps ago. */
    async wait(pred: (a: MuxAgent[]) => boolean, what: string, timeoutMs = 8_000): Promise<MuxAgent[]> {
      await until(() => emits.length > 0 && pred(emits[emits.length - 1]), { timeoutMs, what });
      return emits[emits.length - 1];
    },
  };
}

/* Emitted paneIds are the reuse-proof composite key `%N~pid~epoch` now;
 * rawPane recovers the bare
 * %N a raw tmux call sees, KEY_RE pins the shape. */
const KEY_RE = /^%\d+~\d+~\d+$/;
const rawPane = (a: MuxAgent): string | null => paneTargetOf(a.paneId);

/** A claude transcript in the tmp projects tree, so a pane cwd can be LINKED.
 *  mtime is set explicitly: "newest" is the whole rule being tested and two
 *  files written in the same millisecond would decide it by luck. */
function seedTranscript(cwd: string, uuid: string, mtimeMs: number): string {
  const dir = join(PROJECTS, mungeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${uuid}.jsonl`);
  writeFileSync(path, "{}\n");
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}

/* ---------------------------------------------- the dropped-Enter rescue */

// The exact stuck pane from the field (2026-09-21): the whole launch command
// typed at a bash prompt, wrapped across two lines, cursor at the end, never
// submitted, so the foreground was still the login shell and the agent never
// started. stillAwaitingSubmit is the decision confirmSubmitted resends Enter
// on; it runs with no tmux, so it proves on every box.
const STUCK_CAP =
  "shikher@cyc-test-engine:~/callyourcode/engine$ env CYC_AGENT_ID=ag-vXZVTbqxl0-0F72D claude --dangero\n" +
  "usly-skip-permissions";
const LAUNCH = "env CYC_AGENT_ID=ag-vXZVTbqxl0-0F72D claude --dangerously-skip-permissions";

test("stillAwaitingSubmit: a login shell with the command still on the input line needs a resend", () => {
  // the field failure: bash foreground, command sitting unsubmitted.
  expect(stillAwaitingSubmit("bash", STUCK_CAP, LAUNCH)).toBe(true);
  expect(stillAwaitingSubmit("-bash", STUCK_CAP, LAUNCH)).toBe(true);
});

test("stillAwaitingSubmit: once the agent is the foreground process, never resend", () => {
  // Enter took: env exec'd claude, so pane_current_command is the agent, not a
  // shell. No resend regardless of what the screen still shows.
  expect(stillAwaitingSubmit("claude", STUCK_CAP, LAUNCH)).toBe(false);
  expect(stillAwaitingSubmit("node", STUCK_CAP, LAUNCH)).toBe(false);
});

test("stillAwaitingSubmit: a command that ran and returned to the shell is not resent", () => {
  // back at a shell (pane_current_command bash) but the launch line scrolled
  // away above fresh output, so it is not the trailing line: it already ran.
  const ran =
    "user@box:~$ env CYC_AGENT_ID=ag-vXZVTbqxl0-0F72D claude --dangerously-skip-permissions\n" +
    "claude: command completed\n" +
    "user@box:~$";
  expect(stillAwaitingSubmit("bash", ran, LAUNCH)).toBe(false);
});

/* ----------------------------------------------- server boot detachment */

test("detachedBootPrefix: Linux with systemd-run wraps the boot in its own scope", () => {
  // The prefix that keeps a freshly booted tmux server OUT of the engine's
  // cgroup, so an engine restart (cyc install runs one) never kills the
  // server and every agent in it.
  expect(detachedBootPrefix("linux", true))
    .toEqual(["systemd-run", "--user", "--scope", "--collect", "--quiet", "--"]);
});

test("detachedBootPrefix: no wrapping off Linux or without systemd-run", () => {
  // launchd has no cgroup kill; a box without systemd-run boots plain.
  expect(detachedBootPrefix("darwin", true)).toEqual([]);
  expect(detachedBootPrefix("linux", false)).toEqual([]);
});

/* ------------------------------------------------------------ the pane id */

t("a pane id that is not tmux's own %N is refused before any tmux runs", async () => {
  /* Ids come from our own list-panes, but the id also picks which pane gets
   * typed into or killed, so it is checked rather than trusted. These strings
   * are what a forged frame would carry; none of them may reach a `-t`. */
  const mux = new TmuxMux("cyc-never-started");
  for (const bad of ["", "1", "%", "%1x", "%-1", "%1 ; kill-server", "$0", "@1", "%1\n%2"]) {
    await expect(mux.readPane(bad, 50)).rejects.toThrow(/bad pane id/);
    await expect(mux.sendText(bad, "hi")).rejects.toThrow(/bad pane id/);
    await expect(mux.sendKeys(bad, "enter")).rejects.toThrow(/bad pane id/);
    await expect(mux.renamePane(bad, "x")).rejects.toThrow(/bad pane id/);
    await expect(mux.closePane(bad)).rejects.toThrow(/bad pane id/);
  }
});

t("no tmux server on the socket: reads fail loudly and the poll stays quiet", async () => {
  /* The engine can be started before tmux is. "no server running" on a socket
   * that never had a server, with nothing being tracked, must stay quiet: no
   * error spray, no emits at all (an empty emit is reserved for the case where
   * a tracked set just vanished, i.e. kill-server; that has its own test). */
  const sock = `cyc-absent-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const mux = new TmuxMux(sock, 20);
  // registered for the afterAll sweep in case a future tmux DOES autostart a
  // server for one of these commands; today none of them do (all exit 1).
  servers.push({ sock, muxes: [mux] });
  const seen = watch(mux);
  await expect(mux.readPane("%1", 50)).rejects.toThrow(/capture-pane/);
  // aimed at a session: still loud (a fresh-session newTab would BOOT a server
  // here instead; that shape has its own test below)
  await expect(mux.newTab({ workspaceId: "no-such-session", cwd: "/tmp", command: "echo hi" })).rejects.toThrow(/new-window/);
  mux.start();
  await elapse(120); // six poll laps at 20ms
  mux.stop();
  expect(seen.emits).toEqual([]);
  expect(mux.knownCwds()).toEqual([]);
  expect(mux.workspaceOf("%1")).toBeNull();
});

/* ------------------------------------------------------------ the four verbs */

t("capture-pane returns ANSI: the SGR bytes of a coloured word survive, bounded to the tail", async () => {
  const srv = tmuxServer("capture");
  const mux = srv.mux();
  // paint a red word, then hold the pane open so the window does not close
  const pane = srv.window("/tmp", "sh", "-c", 'printf "\\033[31mREDWORD\\033[0m\\n"; exec sleep 60');
  await srv.sees(pane, "REDWORD");

  const { text, truncated } = await mux.readPane(pane, 500);
  expect(text).toContain("REDWORD");
  // the ESC/SGR is still in the bytes: a stripped read would have thrown away
  // exactly what the delivery guard and the blocked-detector parse
  expect(text).toMatch(/\x1b\[[0-9;]*m/);
  // capture-pane always returns the whole visible viewport, so unlike herdr's
  // read it is never short of the box at the bottom
  expect(truncated).toBe(false);

  // the `lines` argument bounds it to the TAIL: the box being classified is
  // always at the bottom, so a head-first trim would cut off the thing that
  // matters and keep the scrollback nobody reads.
  const rows = text.split("\n");
  expect(rows.length).toBeGreaterThan(2);
  const two = await mux.readPane(pane, 2);
  expect(two.text).toBe(rows.slice(-2).join("\n"));
});

t("sendText types LITERALLY and does not submit; Enter is what submits", async () => {
  const srv = tmuxServer("send");
  const mux = srv.mux();
  const pane = await srv.shell();

  // arithmetic that only appears in the output if the line actually ran
  await mux.sendText(pane, "echo RESULT_$((6*7))");
  await srv.sees(pane, "echo RESULT_");
  /* THE HALF THAT MATTERS: typed is not sent. The whole delivery guard is built
   * on being able to put text in the box and decide afterwards whether to
   * commit it; a sendText that submitted would fire every draft. */
  expect(srv.capture(pane)).not.toContain("RESULT_42");

  await mux.sendKeys(pane, "enter");
  await srv.sees(pane, "RESULT_42");
});

t("sendText passes a leading dash and tmux key names through as text", async () => {
  /* `-l --` is the guard: without `--` a message starting with a dash is read
   * as tmux flags, and without `-l` the words "Enter" and "C-c" are keys. A
   * pasted shell snippet would then run itself in his pane. */
  const srv = tmuxServer("literal");
  const mux = srv.mux();
  const pane = await srv.shell();
  // the substitution is split so the SCREEN can hold the payload while "PWNED"
  // can only appear if the shell actually ran it
  const payload = "-n Enter C-c $(echo PWN''ED)";
  await mux.sendText(pane, payload);
  await srv.sees(pane, payload);
  expect(srv.capture(pane)).not.toContain("PWNED");
  expect(srv.panes()).toContain(pane); // a C-c read as a key would have killed it
});

t("sendKeys maps herdr key names to tmux: ctrl+c interrupts, a digit is typed", async () => {
  const srv = tmuxServer("keys");
  const mux = srv.mux();

  // ctrl+c -> C-c. The pane is a bare `sleep`, so the interrupt is visible as
  // the pane going away rather than as text on a screen.
  const sleeper = srv.window("/tmp", "sleep", "60");
  await srv.command(sleeper, "sleep");
  await mux.sendKeys(sleeper, "ctrl+c");
  await until(() => !srv.panes().includes(sleeper), { timeoutMs: 5_000, what: "the interrupted pane to die" });

  // a bare digit is the chooser answer the asks path presses; it must arrive as
  // the character 3, not as a key name lookup failure.
  const shell = await srv.shell();
  await mux.sendKeys(shell, "3");
  await srv.sees(shell, "3");
});

t("sendKeys maps ctrl+d to C-d: the pi restart's quit key reaches the pane", async () => {
  /* pi's quit sequence is ctrl+c then ctrl+d (readers/pi.ts quit.keys), so the
   * mapping the restart depends on is ctrl+d -> C-d. ctrl+d at an interactive
   * shell is EOF and the shell exits, so a correctly mapped key makes the pane
   * go away; a literal "ctrl+d" string would be typed as text (or rejected) and
   * the shell would stay. */
  const srv = tmuxServer("ctrld");
  const mux = srv.mux();
  const shell = await srv.shell();
  await mux.sendKeys(shell, "ctrl+d");
  await until(() => !srv.panes().includes(shell),
    { timeoutMs: 5_000, what: "the shell to exit on EOF (ctrl+d -> C-d)" });
});

t("renamePane sets the pane title and closePane kills exactly that pane", async () => {
  const srv = tmuxServer("rename");
  const mux = srv.mux();
  const a = srv.window("/tmp", "sleep", "60");
  const b = srv.window("/tmp", "sleep", "60");

  await mux.renamePane(a, "a nice label");
  expect(srv.field(a, "#{pane_title}")).toBe("a nice label");
  expect(srv.field(b, "#{pane_title}")).not.toBe("a nice label");

  await mux.closePane(a);
  await until(() => !srv.panes().includes(a), { timeoutMs: 5_000, what: "the closed pane to go" });
  expect(srv.panes()).toContain(b); // the neighbour is untouched
});

t("newTab spawns a window without stealing focus, runs the command, and takes a label", async () => {
  const srv = tmuxServer("newtab");
  const mux = srv.mux();
  const activeOf = () =>
    srv.raw("list-windows", "-t", "base", "-F", "#{window_id} #{window_active}")
      .split("\n").find((l) => l.endsWith(" 1"))?.split(" ")[0];
  const activeBefore = activeOf();

  const pane = await mux.newTab({
    workspaceId: "base", cwd: "/tmp", label: "spawned", command: "echo NEWTAB_RAN",
  });
  expect(pane).toMatch(KEY_RE); // the reuse-proof key is the public handle
  const target = paneTargetOf(pane)!;

  // -d did not focus it: the previously-active window is still the active one
  expect(activeBefore, "the fixture server has no active window to compare against").toBeTruthy();
  expect(activeOf()).toBe(activeBefore!);
  // and the new pane is really on the server, in the named session, labelled
  expect(srv.panes()).toContain(target);
  expect(srv.field(target, "#{session_name}")).toBe("base");
  expect(srv.field(target, "#{window_name}")).toBe("spawned");
  // the command was typed AND submitted: a newTab that only typed would leave
  // the agent sitting at a prompt with its own start line uncommitted
  await srv.sees(target, "NEWTAB_RAN");
});

t("newTab waits for the prompt: a shell slower than the old 400ms pause still gets the whole command", async () => {
  /* THE EATEN-FIRST-KEYSTROKE RACE (the Mac bug). newTab used to pause a blind
   * 400ms and then type; a shell still initializing past that ate the first
   * keys, so `env CYC_AGENT_ID=...` arrived as `nv ...` and nothing started.
   * Here every new pane in the session gets a shell that takes a full second
   * to come up (1s > 400ms, deterministically past the old pause). The proof
   * of ordering is the prompt itself: keys typed before the shell reads are
   * echoed by the tty at column 0 with no prompt in front of them, while keys
   * typed after the readiness wait land BEHIND the painted prompt. */
  const srv = tmuxServer("slowshell");
  srv.raw("set-option", "-t", "base", "default-command", "sh -c 'sleep 1; exec sh'");
  const mux = srv.mux();

  const pane = await mux.newTab({
    workspaceId: "base", cwd: "/tmp", label: "slow", command: "echo SLOWSHELL_RAN",
  });
  const target = paneTargetOf(pane)!;
  // the command ran to completion on the slow shell (its output on its own line)
  await until(() => /^SLOWSHELL_RAN\s*$/m.test(srv.capture(target)),
    { timeoutMs: 10_000, what: `SLOWSHELL_RAN output in ${pane}` });
  const cap = srv.capture(target);
  // typed AFTER the prompt was painted: the full command sits behind a prompt
  expect(cap).toMatch(/\$ echo SLOWSHELL_RAN/);
  // and the first character survived: no clipped echo of the command anywhere
  expect(cap).not.toMatch(/^cho SLOWSHELL_RAN/m);
});

t("newTab with no workspace gets its OWN session, booting the tmux server if needed", async () => {
  /* The app starting a fresh agent is the one-tmux-per-agent case: no
   * workspaceId means a NEW detached session, and new-session must work on a
   * machine where tmux has never been started (the Mac bug: new-window died
   * with "error connecting to ..." because there was no server to connect to). */
  const sock = `cyc-boot-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: { sock: string; muxes: TmuxMux[]; socketPath?: string } = { sock, muxes: [] };
  servers.push(entry);
  const mux = new TmuxMux(sock, 20);
  entry.muxes.push(mux);
  const raw = (...args: string[]): string => Bun.spawnSync(["tmux", "-L", sock, ...args]).stdout.toString();

  const pane = await mux.newTab({ workspaceId: null, cwd: "/tmp", label: "My Agent!", command: "echo BOOTED_RAN" });
  entry.socketPath = raw("display-message", "-p", "#{socket_path}").trim() || undefined;
  expect(pane).toMatch(KEY_RE);
  const target = paneTargetOf(pane)!;
  // its own session, named from the label with tmux-hostile characters folded
  expect(raw("display-message", "-p", "-t", target, "#{session_name}").trim()).toBe("My-Agent");
  // the command was typed AND submitted on the freshly-booted server
  await until(() => raw("capture-pane", "-p", "-t", target).includes("BOOTED_RAN"),
    { timeoutMs: 5_000, what: `"BOOTED_RAN" on screen in ${pane}` });

  // a second agent with the SAME label still starts: tmux rejects the duplicate
  // name and the retry lets it auto-number a distinct session
  const pane2 = await mux.newTab({ workspaceId: null, cwd: "/tmp", label: "My Agent!", command: "sleep 60" });
  expect(pane2).toMatch(KEY_RE);
  expect(pane2).not.toBe(pane);
  expect(raw("display-message", "-p", "-t", paneTargetOf(pane2)!, "#{session_name}").trim()).not.toBe("My-Agent");
});

t("newTab into a workspace that does not exist fails loudly rather than opening one anywhere", async () => {
  const srv = tmuxServer("newtab-bad");
  const mux = srv.mux();
  const before = srv.panes().length;
  await expect(mux.newTab({ workspaceId: "no-such-session", cwd: "/tmp", command: "echo hi" }))
    .rejects.toThrow(/new-window/);
  expect(srv.panes().length).toBe(before);
});

/* ------------------------------------------------ verb 5: engine-side detect */

t("a claude pane is detected, named after its cwd, and PARKED when no transcript exists", async () => {
  const srv = tmuxServer("detect");
  const cwd = await tmpDir("cyc-tmux-cwd-");
  const pane = srv.window(cwd, join(BIN, "claude"), "60");
  await srv.command(pane, "claude");

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const agents = await seen.wait((a) => a.length === 1, "the claude pane to be enumerated");

  const [a] = agents;
  expect(a.paneId).toMatch(KEY_RE); // the reuse-proof composite key, not bare %N
  expect(rawPane(a)).toBe(pane);
  expect(a.agent).toBe("claude");
  expect(a.cwd).toBe(cwd);
  expect(a.workspace).toBe("base");
  expect(a.name).toBe(basename(cwd));
  // NO TRANSCRIPT ANYWHERE UNDER THIS CWD: no borrowed uuid from some other
  // pane's project dir (invariant L1); the pane parks on its own handle so
  // the app can still list it (bug 15 remainder).
  expect(a.agentSession).toEqual({ id: a.paneId, kind: "id", source: "tmux:parked" });
  expect(a.status).toBe("idle");
  expect(mux.workspaceOf(pane)).toBe("base");
  expect(mux.knownCwds()).toEqual([cwd]);
  mux.stop();
});

t("a detected pane emits a BUMPED stateChangeSeq (edges move it; a quiet lap does not)", async () => {
  /* The old tmux mux hardcoded stateChangeSeq: 0, so anything the app keyed on
   * it never moved (herdr moves its own natively). logChanges already detects
   * the edges -- a pane appearing, an agent detected, a status flip -- so the
   * mux now carries a per-pane-key counter and emits it. A pane the mux has
   * just detected has crossed at least the appear + detected edges, so its seq
   * is BUMPED past the old 0; a poll where nothing moved keeps the number. */
  const srv = tmuxServer("seq");
  const cwd = await tmpDir("cyc-tmux-seq-");
  const pane = srv.window(cwd, join(BIN, "claude"), "60");
  await srv.command(pane, "claude");

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const agents = await seen.wait((a) => a.length === 1, "the claude pane to be enumerated");
  const seq = agents[0].stateChangeSeq;
  // an edge was seen, so the seq left the old hardcoded 0 behind
  expect(seq).toBeGreaterThan(0);

  // several quiet laps later, with nothing moving, the seq is unchanged: an
  // edge counter, not a heartbeat, so no churn downstream
  await elapse(120);
  const still = seen.emits[seen.emits.length - 1];
  expect(still.length).toBe(1);
  expect(still[0].stateChangeSeq).toBe(seq);
  mux.stop();
});

t("a status flip (idle -> blocked) bumps stateChangeSeq again", async () => {
  /* The per-key counter moves on a STATUS edge too, not only on detection: a
   * pane detected idle and then read as blocked (a modal on screen) crosses a
   * status flip, and its seq must step past the value it emitted while idle. */
  const srv = tmuxServer("seqflip");
  const cwd = await tmpDir("cyc-tmux-seqflip-");
  // a shell so the pane exists (and is detected as an agent) BEFORE the dialog
  // is painted; the fake claude execs after a short delay, and only once the
  // dialog is on screen does refineBlocked flip the status
  const dialog =
    " Do you trust the files in this folder?\\n\\n" +
    " \u276f 1. Yes, proceed\\n   2. No, exit\\n";
  const pane = srv.window(cwd, "sh", "-c",
    `exec ${join(BIN, "claude")} 60`);
  await srv.command(pane, "claude");

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const idle = await seen.wait((a) => a.length === 1 && a[0].status === "idle",
    "the claude pane to be detected idle");
  const idleSeq = idle[0].stateChangeSeq;
  expect(idleSeq).toBeGreaterThan(0);

  // paint the modal into the pane's screen; refineBlocked reads it next poll
  srv.raw("send-keys", "-t", pane, "-l", dialog.replace(/\\n/g, "\n"));
  const blocked = await seen.wait((a) => a.length === 1 && a[0].status === "blocked",
    "the pane to flip to blocked");
  // the status flip is an edge: the seq stepped past its idle value
  expect(blocked[0].stateChangeSeq).toBeGreaterThan(idleSeq);
  mux.stop();
});

t("an engine-spawned pane carries its pre-minted link until a transcript supersedes it", async () => {
  /* The cold-start gap: a fresh claude writes no jsonl for a while, so a pane
   * the ENGINE spawned (newTab with the CYC_AGENT_ID launch prefix) sat
   * unlinked and app-started sessions never appeared. newTab knows the pane id
   * and the pre-minted agent id at spawn time, so detection must emit that
   * link itself, and hand over to transcript discovery once a jsonl exists. */
  const srv = tmuxServer("premint");
  /* newTab spawns the pane's shell, then TYPES the launch command into it, so
   * the pane's shell must be a deterministic one that reaches a real prompt.
   * The box's login shell is not: an unconfigured zsh under the test's fake
   * HOME sits at its new-user-install wizard ("Type one of the keys..."),
   * whose text passes newTab's prompt-painted readiness check yet swallows the
   * typed command, so `claude` never execs and the pane stays a bare shell.
   * Pin `sh` for the session newTab lands in, the same lever the slow-shell
   * test uses, so the seam under test is the pre-mint link, not the host's
   * shell config. */
  srv.raw("set-option", "-t", "base", "default-command", "sh");
  const cwd = await tmpDir("cyc-tmux-premint-");
  /* An OLD transcript from SOME OTHER session already sits in the cwd BEFORE
   * the spawn (the live shakedown bug: the engine checkout is a common cwd,
   * full of other sessions' jsonls). The fresh pane must NOT adopt it. */
  seedTranscript(cwd, "99999999-9999-4999-8999-999999999999", Date.now() - 60_000);
  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();

  const aid = "ag-TESTPRELINK00001";
  const pane = await mux.newTab({
    workspaceId: "base", cwd, label: "premint",
    command: `env CYC_AGENT_ID=${aid} ${join(BIN, "claude")} 60`,
  });
  const agents = await seen.wait((x) => x.some((y) => y.paneId === pane),
    "the engine-spawned claude to be enumerated");
  const a = agents.find((y) => y.paneId === pane)!;
  expect(a.agent).toBe("claude");
  // No jsonl of ITS OWN yet, and the pane is linked anyway: the engine
  // spawned it and already knows who it is.
  expect(a.agentSession).toEqual({ id: aid, kind: "id", source: "tmux:premint" });

  // several poll laps later the pre-existing jsonl has STILL not been adopted:
  // it was born before this pane's spawn, so it belongs to someone else
  await elapse(120);
  const still = seen.emits[seen.emits.length - 1].find((y) => y.paneId === pane)!;
  expect(still.agentSession).toEqual({ id: aid, kind: "id", source: "tmux:premint" });

  // a transcript born AFTER the spawn is this pane's own: discovery hands over
  seedTranscript(cwd, "44444444-4444-4444-8444-444444444444", Date.now());
  const after = await seen.wait(
    (x) => x.some((y) => y.paneId === pane && y.agentSession?.source === "tmux:claude"),
    "transcript discovery to supersede the pre-minted link");
  expect(after.find((y) => y.paneId === pane)!.agentSession).toEqual({
    id: "44444444-4444-4444-8444-444444444444", kind: "id", source: "tmux:claude",
  });
  mux.stop();
});

t("a claude pane sitting at a modal dialog is reported blocked, even unlinked (first-boot trust prompt)", async () => {
  /* The user-visible bug: on CYC_MUX=tmux a fresh claude sat at the trust
   * prompt and the app showed nothing. Nothing on the tmux lane ever produced
   * status "blocked" (herdr scrapes it itself; the transcript never carries
   * it), and asks.ts only reads the screen of a blocked session, so the
   * question could never surface. The pane here is the first-boot shape
   * exactly: a live claude process, a numbered modal on screen, and NO
   * transcript jsonl anywhere under the cwd. */
  const srv = tmuxServer("blocked");
  const cwd = await tmpDir("cyc-tmux-blocked-");
  const dialog =
    " Do you trust the files in this folder?\\n\\n" +
    " ❯ 1. Yes, proceed\\n   2. No, exit\\n";
  const pane = srv.window(cwd, "sh", "-c",
    `printf '${dialog}'; exec ${join(BIN, "claude")} 60`);
  await srv.command(pane, "claude");
  await srv.sees(pane, "Do you trust");

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const agents = await seen.wait((a) => a.length === 1 && a[0].status === "blocked",
    "the dialog pane to be reported blocked");
  const [a] = agents;
  expect(a.agent).toBe("claude");
  // first boot: no jsonl yet, so the pane is PARKED on its own handle (bug 15
  // remainder: an unlinked hand-started pane was held out of the app's list,
  // so this very trust prompt could not be answered remotely)
  expect(a.agentSession).toEqual({ id: a.paneId, kind: "id", source: "tmux:parked" });
  mux.stop();
});

t("a claude pane is LINKED to the newest transcript in its project dir", async () => {
  const srv = tmuxServer("link");
  const cwd = await tmpDir("cyc-tmux-link-");
  const now = Date.now();
  // written second but stamped OLDER: if the rule were "last written" rather
  // than "newest mtime" this pane would be linked to the wrong conversation
  seedTranscript(cwd, "22222222-2222-4222-8222-222222222222", now);
  seedTranscript(cwd, "11111111-1111-4111-8111-111111111111", now - 60_000);

  const pane = srv.window(cwd, join(BIN, "claude"), "60");
  await srv.command(pane, "claude");
  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const [a] = await seen.wait((x) => x.length === 1 && x[0].agentSession != null, "the pane to be linked");
  // the identity everything downstream keys off (#490/#497): the NEWEST jsonl,
  // stamped with where it came from so a herdr link and a tmux link are never
  // confused for one another.
  expect(a.agentSession).toEqual({
    id: "22222222-2222-4222-8222-222222222222", kind: "id", source: "tmux:claude",
  });
  mux.stop();
});

t("an established link is held against a busier older jsonl; only a later-born jsonl takes over", async () => {
  /* The live 571 relapse, one layer up from the pre-mint guard: the pane was
   * linked correctly (handover logged), then the NEXT poll re-ran the
   * newest-mtime locate and adopted another active session's transcript in
   * the same cwd, because that file keeps being written and so keeps the
   * newest mtime. The link must be sticky: it moves only to a jsonl born at
   * or after the current link's own birth (a genuine roll), never to an
   * older-born neighbour whose mtime merely keeps moving. */
  const srv = tmuxServer("sticky");
  const cwd = await tmpDir("cyc-tmux-sticky-");
  const stranger = "bd000000-0000-4000-8000-000000000001"; // the busy neighbour, born FIRST
  const own = "9b000000-0000-4000-8000-000000000002";      // this pane's session, born later
  const strangerPath = seedTranscript(cwd, stranger, Date.now() - 120_000);
  await elapse(20); // distinct birth instants: stranger strictly older-born
  seedTranscript(cwd, own, Date.now());

  const pane = srv.window(cwd, join(BIN, "claude"), "60");
  await srv.command(pane, "claude");
  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const [a] = await seen.wait((x) => x.length === 1 && x[0].agentSession != null, "the pane to be linked");
  expect(a.agentSession!.id).toBe(own);

  // the neighbour keeps being written: newest mtime in the dir, every poll
  utimesSync(strangerPath, new Date(), new Date());
  await elapse(120);
  const held = seen.emits[seen.emits.length - 1][0];
  expect(held.agentSession).toEqual({ id: own, kind: "id", source: "tmux:claude" });

  // a genuine roll writes a FRESH jsonl, born after the link: handover follows
  const rolled = "77000000-0000-4000-8000-000000000003";
  seedTranscript(cwd, rolled, Date.now());
  const after = await seen.wait((x) => x.length === 1 && x[0].agentSession?.id === rolled,
    "the roll to a later-born jsonl to be followed");
  expect(after[0].agentSession).toEqual({ id: rolled, kind: "id", source: "tmux:claude" });
  mux.stop();
});

t("an announce beats the folder guess: the hook's session id overrides the linked jsonl at once", async () => {
  /* Option C's core promise (the flip-back heal this replaced): the pane's
   * claude says which session it IS, and that word overrides whatever the
   * newest-jsonl guess linked, immediately, with no floor and no quiet gate.
   * The announcing pid here is the pane's claude process itself, exactly the
   * agent pid the route's ancestor walk resolves for a real hook. Afterwards
   * a fresh, later-born stranger jsonl -- the shape that used to re-steal the
   * link -- changes nothing: guessing is retired for an announced pane. */
  const srv = tmuxServer("announce");
  const cwd = await tmpDir("cyc-tmux-ann-");
  const guessed = "aa000000-0000-4000-8000-000000000006";
  seedTranscript(cwd, guessed, Date.now());
  const pane = srv.window(cwd, join(BIN, "claude"), "60");
  await srv.command(pane, "claude");
  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  await seen.wait((x) => x.length === 1 && x[0].agentSession?.id === guessed,
    "the pane to link the guessed jsonl");

  // the hook announces: the REAL session id, from the pane's own claude pid
  const announced = "ab000000-0000-4000-8000-000000000007";
  const claudePid = Number(srv.field(pane, "#{pane_pid}"));
  expect(claudePid).toBeGreaterThan(1);
  const r = await handleAnnounce({ sessionId: announced, pid: claudePid, cwd });
  expect(r.ok).toBe(true);
  const after = await seen.wait((x) => x.length === 1 && x[0].agentSession?.id === announced,
    "the announced bind to override the guess");
  expect(after[0].agentSession).toEqual({ id: announced, kind: "id", source: "hook:announce" });

  // a later-born stranger jsonl in the cwd can no longer take the pane
  seedTranscript(cwd, "ac000000-0000-4000-8000-000000000008", Date.now());
  await elapse(120);
  const held = seen.emits[seen.emits.length - 1][0];
  expect(held.agentSession).toEqual({ id: announced, kind: "id", source: "hook:announce" });
  mux.stop();
});

t("a codex announce binds a codex pane: notify's thread id becomes the session ref", async () => {
  /* Codex has no SessionStart hook; its config.toml notify program announces
   * instead (hooks/announce-session.py --codex-notify), with sessionId = the
   * payload's thread-id, which IS the rollout uuid the codex reader locates
   * by. Engine-side that must ride the SAME rails as a claude announce: the
   * ancestor walk recognizes the codex process (agents.ts AGENT_IDS), the pid
   * matches the pane's detected agent, and the bind emits as the pane's
   * agentSession with kind "id", so the codex reader resolves the same record
   * the announce named. Before the widen, hookBindFor was consulted for
   * claude panes only and a codex announce bound but never surfaced. */
  const srv = tmuxServer("announce-codex");
  const cwd = await tmpDir("cyc-tmux-codex-");
  const pane = srv.window(cwd, join(BIN, "codex"), "60");
  await srv.command(pane, "codex");
  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const [before] = await seen.wait((x) => x.length === 1 && x[0].agent === "codex",
    "the codex pane to be listed");
  expect(before.agentSession).toBeNull(); // codex never gets the claude folder guess

  const codexPid = Number(srv.field(pane, "#{pane_pid}"));
  expect(codexPid).toBeGreaterThan(1);
  const threadId = "0199aaaa-bbbb-7ccc-8ddd-000000000042"; // a codex rollout uuid
  const r = await handleAnnounce({ sessionId: threadId, pid: codexPid, cwd });
  expect(r.ok).toBe(true);
  const [a] = await seen.wait((x) => x.length === 1 && x[0].agentSession?.id === threadId,
    "the codex announce to bind the pane");
  expect(a.agent).toBe("codex");
  expect(a.agentSession).toEqual({ id: threadId, kind: "id", source: "hook:announce" });
  mux.stop();
});

t("an announce whose pid no pane holds yet parks, and binds when the pane is first polled", async () => {
  /* The ordering the route cannot control: the hook can fire before this
   * mux's first enumeration ever saw the pane (engine booting, claude already
   * up). The announce parks keyed by the resolved agent pid and the first
   * poll that shows the pane binds it -- so the pane's FIRST emit already
   * wears the announced id and the guess fallback never runs. */
  const srv = tmuxServer("announce-park");
  const cwd = await tmpDir("cyc-tmux-park-ann-");
  seedTranscript(cwd, "ba000000-0000-4000-8000-000000000009", Date.now()); // a decoy the guess would take
  const pane = srv.window(cwd, join(BIN, "claude"), "60");
  await srv.command(pane, "claude");
  const announced = "bb000000-0000-4000-8000-000000000010";
  const claudePid = Number(srv.field(pane, "#{pane_pid}"));
  const r = await handleAnnounce({ sessionId: announced, pid: claudePid, cwd });
  expect(r.ok).toBe(true);
  expect(r.parked).toBe(true); // no mux has polled this pane yet

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const [a] = await seen.wait((x) => x.length === 1 && x[0].agentSession != null,
    "the pane's first linked emit");
  expect(a.agentSession).toEqual({ id: announced, kind: "id", source: "hook:announce" });
  mux.stop();
});

t("a stale herdr witness can never block the pid bind (the shakedown bug)", async () => {
  /* The live failure: a tmux pane inherits HERDR_PANE_ID from the herdr
   * session that started the tmux server, so the announce rides in with a
   * stale foreign-lane witness beside a perfectly good pid. PID IS PRIMARY
   * AND SUFFICIENT: the tmux lane binds on the pid hit and never even reads
   * herdrPane. */
  const srv = tmuxServer("announce-stale");
  const cwd = await tmpDir("cyc-tmux-stale-");
  const pane = srv.window(cwd, join(BIN, "claude"), "60");
  await srv.command(pane, "claude");
  const announced = "cc000000-0000-4000-8000-000000000011";
  const claudePid = Number(srv.field(pane, "#{pane_pid}"));
  const r = await handleAnnounce({ sessionId: announced, pid: claudePid, cwd, herdrPane: "w2:p1" });
  expect(r.ok).toBe(true);

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const [a] = await seen.wait((x) => x.length === 1 && x[0].agentSession?.id === announced,
    "the pid bind despite the stale herdr witness");
  expect(a.agentSession).toEqual({ id: announced, kind: "id", source: "hook:announce" });
  mux.stop();
});

t("pid unresolvable: the lane's own witness ($TMUX_PANE) binds as the fallback", async () => {
  /* The ancestor walk can come up empty (an exited chain, a ps hiccup). Then
   * and only then the tmux witness places the announce; the stale herdr id
   * beside it is a foreign-lane witness and is ignored, not preferred. */
  const srv = tmuxServer("announce-witness");
  const cwd = await tmpDir("cyc-tmux-witness-");
  const pane = srv.window(cwd, join(BIN, "claude"), "60");
  await srv.command(pane, "claude");
  const announced = "dd000000-0000-4000-8000-000000000012";
  const r = await handleAnnounce(
    { sessionId: announced, pid: 999, cwd, tmuxPane: pane, herdrPane: "w2:p1" },
    { resolveAgentPid: async () => null });
  expect(r.ok).toBe(true);

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const [a] = await seen.wait((x) => x.length === 1 && x[0].agentSession?.id === announced,
    "the witness fallback to bind the pane");
  expect(a.agentSession).toEqual({ id: announced, kind: "id", source: "hook:announce" });
  mux.stop();
});

t("a pid no pane holds plus a wrong witness parks WITH A LOGGED REASON, once, and never binds", async () => {
  /* The silent half of the shakedown bug: the receipt was logged, the bind
   * outcome was not, so a blocked bind looked like nothing at all. An
   * unplaceable announce now says why it parked, exactly once across laps,
   * and the pane keeps its own (non-announced) identity. */
  const srv = tmuxServer("announce-park-reason");
  const cwd = await tmpDir("cyc-tmux-parkreason-");
  const pane = srv.window(cwd, join(BIN, "claude"), "60");
  await srv.command(pane, "claude");
  const announced = "ee000000-0000-4000-8000-000000000013";
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    // a transient's shape: a resolved agent pid that is not any pane's topmost
    const r = await handleAnnounce({ sessionId: announced, pid: 999, cwd, herdrPane: "w2:p1" },
      { resolveAgentPid: async () => 999_999_983 });
    expect(r.ok).toBe(true);
    const mux = srv.mux(30);
    const seen = watch(mux);
    mux.start();
    await seen.wait((x) => x.length === 1 && x[0].agentSession != null, "the pane to surface");
    await elapse(150); // several laps: still parked, and the reason logged ONCE
    const held = seen.emits[seen.emits.length - 1][0];
    expect(held.agentSession?.source).not.toBe("hook:announce");
    expect(pendingAnnounces().length).toBe(1); // parked until the TTL sweeps it
    mux.stop();
  } finally {
    console.log = orig;
  }
  expect(lines.filter((l) => l.includes(`] parked ${announced}`)))
    .toEqual([`[announce] parked ${announced}: no pane for pid`]);
  expect(lines.some((l) => l.includes(`] bound ${announced}`))).toBe(false);
  resetHookAnnounce(); // do not leak the parked announce into later tests
});

t("a parked announce binds on a LATER lap once detection catches up (the shell-child race)", async () => {
  /* The live shakedown failure (CYC_MUX=tmux). Claude is started from an
   * interactive shell, so pane_pid is the SHELL and the claude is its child,
   * while pane_current_command already says "claude". The SessionStart
   * announce lands before the poll's ps has seen the fresh claude: it parks
   * with "no pane for pid". Parked is not final: the next enumeration lap
   * re-resolves it against the pane's ACTUAL claude process (never the pane
   * root shell), binds, and logs bound exactly once. The first lap's ps race
   * is simulated by hiding the claude from processTree for one stretch. */
  const srv = tmuxServer("announce-late");
  const cwd = await tmpDir("cyc-tmux-late-");
  const pane = await srv.shell(cwd);
  const shellPid = Number(srv.field(pane, "#{pane_pid}"));
  expect(shellPid).toBeGreaterThan(1);
  srv.raw("send-keys", "-t", pane, "-l", `${join(BIN, "claude")} 300`);
  srv.raw("send-keys", "-t", pane, "Enter");
  await srv.command(pane, "claude");
  // the claude is the SHELL'S CHILD (no exec), the everyday hand-started
  // shape: pane_pid stays the sh, which is the pid the retired fast path
  // used to answer and the announce could never match
  let claudePid = 0;
  await until(() => {
    const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,comm="]).stdout.toString();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
      if (m && Number(m[2]) === shellPid && m[3] === "claude") { claudePid = Number(m[1]); return true; }
    }
    return false;
  }, { timeoutMs: 5_000, what: `a claude child of the pane shell ${shellPid}` });
  expect(claudePid).not.toBe(shellPid);

  const announced = "ff000000-0000-4000-8000-000000000014";
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const mux = srv.mux(30);
    const real = (mux as any).processTree.bind(mux);
    let hide = true;
    (mux as any).processTree = async () => {
      const m = (await real()) as Map<number, Array<{ pid: number }>>;
      if (hide) for (const [k, nodes] of m) m.set(k, nodes.filter((n) => n.pid !== claudePid));
      return m;
    };
    const seen = watch(mux);
    mux.start();
    // detection sees "claude" (the command fallback) but ps hides the process
    await seen.wait((x) => x.length === 1 && x[0].agent === "claude", "the pane to surface");
    const r = await handleAnnounce({ sessionId: announced, pid: claudePid, cwd });
    expect(r.ok).toBe(true);
    await until(() => lines.some((l) => l.includes(`] parked ${announced}`)),
      { timeoutMs: 5_000, what: "the announce to park on the raced lap" });
    expect(seen.emits[seen.emits.length - 1][0].agentSession?.source).not.toBe("hook:announce");

    // ps catches up: the very next lap re-resolves the parked announce
    hide = false;
    const [a] = await seen.wait((x) => x.length === 1 && x[0].agentSession?.id === announced,
      "the parked announce to bind on a later lap");
    expect(a.agentSession).toEqual({ id: announced, kind: "id", source: "hook:announce" });
    expect(pendingAnnounces().length).toBe(0);
    mux.stop();
  } finally {
    console.log = orig;
  }
  expect(lines.filter((l) => l.includes(`] parked ${announced}`)))
    .toEqual([`[announce] parked ${announced}: no pane for pid`]);
  expect(lines.filter((l) => l.includes(`] bound ${announced}`)).length).toBe(1);
  resetHookAnnounce();
});

t("a hand-started claude parks on its pane handle, refuses a pre-existing stranger, adopts its own newborn", async () => {
  /* Bug 15 remainder. A claude the USER starts in his own pane has no
   * pre-mint, and before it writes a jsonl it used to be emitted unlinked and
   * held out of the app's list, so its trust prompt was unanswerable. Now it
   * parks on its pane handle, with the FIRST-SEEN instant as its adoption
   * floor: the old stranger jsonl already in the cwd is refused (the 571
   * disease), while the pane's own transcript, born after first-seen, takes
   * over. The pane is created AFTER the mux's first lap on purpose: that is
   * the hand-started shape (a pane appearing mid-run), and panes present at
   * the first enumeration keep the plain newest-jsonl restart rule instead. */
  const srv = tmuxServer("parked");
  const cwd = await tmpDir("cyc-tmux-parked-");
  const stranger = "cd000000-0000-4000-8000-000000000004"; // born before the pane existed
  seedTranscript(cwd, stranger, Date.now() - 120_000);
  await elapse(20); // distinct birth instants: stranger strictly before first-seen

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  await seen.wait((a) => a.length === 0, "the first (agentless) enumeration");

  const pane = srv.window(cwd, join(BIN, "claude"), "60");
  await srv.command(pane, "claude");
  const [a] = await seen.wait((x) => x.length === 1 && x[0].agentSession != null,
    "the hand-started pane to surface parked");
  expect(a.agentSession).toEqual({ id: a.paneId, kind: "id", source: "tmux:parked" });

  // laps later the stranger has STILL not been adopted: parked holds the floor
  await elapse(120);
  const held = seen.emits[seen.emits.length - 1][0];
  expect(held.agentSession).toEqual({ id: held.paneId, kind: "id", source: "tmux:parked" });

  // the pane's OWN transcript is born after first-seen: handover follows
  const own = "ef000000-0000-4000-8000-000000000005";
  seedTranscript(cwd, own, Date.now());
  const after = await seen.wait((x) => x.length === 1 && x[0].agentSession?.id === own,
    "handover from parked to the newborn jsonl");
  expect(after[0].agentSession).toEqual({ id: own, kind: "id", source: "tmux:claude" });
  mux.stop();
});

t("two claude panes in one cwd are both detected and BOTH left unlinked", async () => {
  /* Degrade, never guess. "Newest jsonl" cannot tell these two apart, and a
   * wrong guess hands one pane's conversation to the other pane's session. */
  const srv = tmuxServer("ambiguous");
  const cwd = await tmpDir("cyc-tmux-amb-");
  // a transcript IS there: the refusal is about ambiguity, not absence
  seedTranscript(cwd, "33333333-3333-4333-8333-333333333333", Date.now());
  const p1 = srv.window(cwd, join(BIN, "claude"), "60");
  const p2 = srv.window(cwd, join(BIN, "claude"), "60");
  await srv.command(p1, "claude");
  await srv.command(p2, "claude");

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const agents = await seen.wait((a) => a.length === 2, "both claude panes");
  expect(agents.map(rawPane).sort()).toEqual([p1, p2].sort());
  for (const a of agents) expect(a.agentSession).toBeNull();
  // and their display names are deduped, the way herdr.list does it: two tabs
  // both called "cyc-tmux-amb-xxxx" would be unpickable in the app
  const base = cwd.split("/").pop()!;
  expect(agents.map((a) => a.name).sort()).toEqual([`${base} (${p1})`, `${base} (${p2})`].sort());
  mux.stop();
});

t("every known agent is a session, a plain shell is not, and a nested agent is still found", async () => {
  const srv = tmuxServer("agents");
  const codexCwd = await tmpDir("cyc-tmux-codex-");
  const nestedCwd = await tmpDir("cyc-tmux-nested-");
  const shellCwd = await tmpDir("cyc-tmux-shell-");

  const codex = srv.window(codexCwd, join(BIN, "codex"), "60");
  /* An agent wrapped in a launcher: the agent is NOT the pane's foreground
   * command (the wrapper is, holding the tty), so the only way to see it is the
   * `ps on pane_pid's children` walk. This is the shape a `claude` shell
   * function or a project's run script actually has. */
  const nested = srv.window(nestedCwd, "sh", "-c", `${join(BIN, "claude")} 60 & wait`);
  await srv.shell(shellCwd); // a pane that is just a shell: never a session
  await srv.command(codex, "codex");
  await until(() => {
    const cmd = srv.field(nested, "#{pane_current_command}");
    return cmd.length > 0 && cmd !== "claude";
  }, { timeoutMs: 5_000, what: "the wrapper to hold the foreground" });

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const agents = await seen.wait((a) => a.length === 2, "codex and the nested claude, and nothing else");
  const byPane = new Map(agents.map((a) => [rawPane(a), a]));
  expect(srv.field(nested, "#{pane_current_command}")).not.toBe("claude");
  expect(byPane.get(codex)!.agent).toBe("codex");
  // L1: a codex pane is a session exactly as a claude one is, and it carries no
  // engine-side link, because the claude jsonl locate means nothing for codex.
  expect(byPane.get(codex)!.agentSession).toBeNull();
  expect(byPane.get(nested)!.agent).toBe("claude");
  expect(agents.some((a) => a.cwd === shellCwd)).toBe(false);
  mux.stop();
});

t("a claude retitled to its version (comm 2.1.241) is still detected via its command line", async () => {
  /* The real-Mac shape: Claude Code sets its process title to its VERSION, so
   * pane_current_command and `ps -o comm=` both say "2.1.241" and never
   * "claude". The args first token still carries the launched path
   * (".../bin/claude"), and detection matches its basename. Reproduced with a
   * real process: `exec -a` rewrites argv[0] to a path ending in /claude while
   * the executed file (sleep symlinked as "2.1.241") keeps comm at the version
   * string. bash is required for exec -a; skip-proof like tmux itself. */
  const bash = Bun.which("bash");
  if (!bash) { console.warn("[tmux.test.ts] retitle test skipped: no bash for exec -a"); return; }
  const srv = tmuxServer("retitle");
  const cwd = await tmpDir("cyc-tmux-retitle-");
  symlinkSync(SLEEP, join(BIN, "2.1.241"));
  const pane = srv.window(cwd, bash, "-c",
    `( exec -a ${join(BIN, "claude")} ${join(BIN, "2.1.241")} 60 ) & wait`);
  await srv.command(pane, "bash"); // the wrapper holds the tty, comm never says claude

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const agents = await seen.wait((a) => a.length === 1, "the retitled claude to be detected");
  expect(srv.field(pane, "#{pane_current_command}")).not.toBe("claude");
  expect(rawPane(agents[0])).toBe(pane);
  expect(agents[0].agent).toBe("claude");
  mux.stop();
});

t("a retitled claude that IS the pane's own top process is detected", async () => {
  /* The `split-window claude` shape seen live on the Mac: the pane has NO
   * shell, claude is pane_pid itself with only MCP children under it. Claude
   * retitles, so pane_current_command says the version ("2.1.241") and the
   * fast path misses; a descendants-only walk never examines pane_pid, so the
   * agent was invisible. Here `bash -c 'exec -a 2.2.0 .../claude'` replaces
   * bash with the fake claude retitled to a version string: pane_pid IS the
   * agent, tmux reports the retitle, and ps comm still says "claude", the
   * exact shape ps showed on the Mac. */
  const bash = Bun.which("bash");
  if (!bash) { console.warn("[tmux.test.ts] pane-top test skipped: no bash for exec -a"); return; }
  const srv = tmuxServer("panetop");
  const cwd = await tmpDir("cyc-tmux-panetop-");
  const pane = srv.window(cwd, bash, "-c",
    `exec -a 2.2.0 ${join(BIN, "claude")} 60`);
  await srv.command(pane, "2.2.0"); // exec replaced bash: the fake claude IS pane_pid

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const agents = await seen.wait((a) => a.length === 1, "the pane-top claude to be detected");
  expect(srv.field(pane, "#{pane_current_command}")).not.toBe("claude");
  expect(rawPane(agents[0])).toBe(pane);
  expect(agents[0].agent).toBe("claude");
  mux.stop();
});

t("EVERY agent pane is listed: splits in one window, sibling windows, and other sessions", async () => {
  /* The user's requirement in one fixture: an app-started agent gets its own
   * tmux, but a human who runs several claude sessions inside ONE tmux (split
   * panes, several windows) or across SEVERAL tmux sessions must see ALL of
   * them in the agent list. list-panes -a is per-PANE across the whole server;
   * nothing may collapse to one-per-session or one-per-window. */
  const srv = tmuxServer("every");
  const cwdA = await tmpDir("cyc-tmux-evA-");
  const cwdB = await tmpDir("cyc-tmux-evB-");
  const cwdC = await tmpDir("cyc-tmux-evC-");
  const cwdD = await tmpDir("cyc-tmux-evD-");

  // one window in "base"...
  const p1 = srv.window(cwdA, join(BIN, "claude"), "60");
  // ...SPLIT into a second claude pane (same window, two panes)
  const p2 = srv.raw("split-window", "-d", "-t", p1, "-c", cwdB,
    "-P", "-F", "#{pane_id}", join(BIN, "claude"), "60").trim();
  expect(p2).toMatch(/^%\d+$/);
  // a whole OTHER tmux session with its own claude...
  const p3 = srv.raw("new-session", "-d", "-s", "second", "-x", "200", "-y", "50",
    "-c", cwdC, "-P", "-F", "#{pane_id}", join(BIN, "claude"), "60").trim();
  expect(p3).toMatch(/^%\d+$/);
  // ...and a codex window beside it in that second session
  const p4 = srv.raw("new-window", "-d", "-t", "second", "-c", cwdD,
    "-P", "-F", "#{pane_id}", join(BIN, "codex"), "60").trim();
  expect(p4).toMatch(/^%\d+$/);
  await srv.command(p1, "claude");
  await srv.command(p2, "claude");
  await srv.command(p3, "claude");
  await srv.command(p4, "codex");

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const agents = await seen.wait((a) => a.length === 4,
    "all four agent panes across splits, windows and sessions");
  expect(agents.map(rawPane).sort()).toEqual([p1, p2, p3, p4].sort());
  const byPane = new Map(agents.map((a) => [rawPane(a), a]));
  // distinct rows, each carrying its own cwd and its own tmux session
  expect(byPane.get(p1)!.cwd).toBe(cwdA);
  expect(byPane.get(p2)!.cwd).toBe(cwdB);
  expect(byPane.get(p1)!.workspace).toBe("base");
  expect(byPane.get(p2)!.workspace).toBe("base");
  expect(byPane.get(p3)!.workspace).toBe("second");
  expect(byPane.get(p4)!.workspace).toBe("second");
  expect(byPane.get(p4)!.agent).toBe("codex");
  mux.stop();
});

t("the poll keeps going, empties the set on kill-server, and stops on stop()", async () => {
  const srv = tmuxServer("poll");
  const cwd = await tmpDir("cyc-tmux-poll-");
  const pane = srv.window(cwd, join(BIN, "claude"), "60");
  await srv.command(pane, "claude");

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  await seen.wait((a) => a.length === 1, "the first enumeration");

  // the loop really does lap: a pane that goes away leaves the set on a LATER
  // emit, with no help from anything the test called on the mux
  srv.raw("kill-pane", "-t", pane);
  await seen.wait((a) => a.length === 0, "the closed pane to leave the set");

  // onAgents on a live mux hands the newcomer the snapshot already held, so a
  // late subscriber does not sit blank until the next lap
  const late: MuxAgent[][] = [];
  const pane2 = srv.window(cwd, join(BIN, "claude"), "60");
  await srv.command(pane2, "claude");
  await seen.wait((a) => a.length === 1, "the replacement pane");
  mux.onAgents((a) => late.push(a));
  expect(late.length).toBe(1);
  expect(rawPane(late[0][0])).toBe(pane2);

  // stop() means stopped: the emit count freezes and stays frozen
  const before = seen.emits.length;
  mux.stop();
  await elapse(150); // five laps at 30ms, had it still been running
  expect(seen.emits.length).toBe(before);

  /* THE SERVER DIES UNDER IT (kill-server). tmux's "no server running" is an
   * AUTHORITATIVE zero, not a transient failure: every pane is gone, so the
   * next poll must emit the EMPTY set (panes logged gone, links pruned)
   * instead of freezing the dead agents in the app forever. Only genuinely
   * ambiguous failures keep the last set; that shape has its own test below. */
  srv.kill();
  await until(() => !srv.alive(), { timeoutMs: 5_000, what: "the tmux server to be gone" });
  mux.start();
  await seen.wait((a) => a.length === 0, "the empty set after kill-server");
  expect(mux.knownCwds()).toEqual([]);
  expect(mux.workspaceOf(pane2)).toBeNull();
  mux.stop();
});

t("a transient list-panes failure keeps the last agent set", async () => {
  /* The unreachable guard the kill-server fix must NOT have weakened: an
   * ambiguous failure (listPanes null; any error that is not the no-server
   * answer) keeps the last known set and emits nothing, so a hiccuping tmux
   * CLI never blanks the app's session list. */
  const srv = tmuxServer("transient");
  const cwd = await tmpDir("cyc-tmux-transient-");
  const pane = srv.window(cwd, join(BIN, "claude"), "60");
  await srv.command(pane, "claude");

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  await seen.wait((a) => a.length === 1, "the first enumeration");
  mux.stop();
  // let a lap already in flight drain: start() below un-sets `stopped`, and an
  // immediate restart would let that old lap finish and emit one extra set
  await elapse(120);

  const before = seen.emits.length;
  (mux as any).listPanes = async () => null; // the ambiguous-failure shape
  mux.start();
  await elapse(120);
  expect(seen.emits.length).toBe(before);
  expect(mux.knownCwds()).toEqual([cwd]);
  expect(mux.workspaceOf(pane)).toBe("base");
  mux.stop();
});

t("a stop that lands INSIDE a poll is a stop: that poll emits nothing", async () => {
  /* THE RACE, MADE DETERMINISTIC. The test above proves stop() clears the
   * interval, which is the easy half: after it, no NEW poll starts. The half
   * that had a real bug in it is the poll ALREADY IN FLIGHT -- it ran to
   * completion and emitted, so a listener that had just been torn down got one
   * more set of agents after its mux was shut down.
   *
   * That is why poll() checks `stopped` a SECOND time, after its two awaits.
   * And that check was only sometimes covered: whether a poll happened to be
   * mid-await at the moment the test called stop() was up to the scheduler, so
   * deleting the line failed about three runs in five. A guard that a revert
   * survives two runs in five is not a guard, it is a coin.
   *
   * So the poll is HELD here rather than caught. listPanes is replaced on this
   * one instance with a deferred the test resolves: the poll parks inside its
   * first await, stop() lands while it is parked, and only then is it let go.
   * The ordering is a fact about the test rather than about the machine, and
   * deleting the second check fails five runs out of five.
   *
   * Reaching past `private` is deliberate and is the smallest seam that exists:
   * the alternative is a production hook whose only caller is this test. It is
   * one instance, in one test, restored by the instance going out of scope. */
  const srv = tmuxServer("stopmid");
  const cwd = await tmpDir("cyc-tmux-stopmid-");
  const pane = srv.window(cwd, join(BIN, "claude"), "60");
  await srv.command(pane, "claude");

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  await seen.wait((a) => a.length === 1, "the first enumeration");
  mux.stop(); // the ticking loop off, so the only poll in flight is the one below

  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  let letGo!: () => void;
  const held = new Promise<void>((resolve) => { letGo = resolve; });
  const realListPanes = (mux as any).listPanes.bind(mux);
  (mux as any).listPanes = async () => {
    entered();
    await held;
    return await realListPanes();
  };

  mux.start();       // start() polls once immediately: that poll parks
  await inside;
  const before = seen.emits.length;
  mux.stop();        // ...and the stop lands strictly inside it
  letGo();

  /* Long enough for the released poll to finish its remaining awaits (a real
   * `ps` and a real list-panes) and reach the emit it must not make. */
  await elapse(200);
  expect(seen.emits.length,
    "a poll that was already in flight when stop() landed emitted anyway, so a listener that " +
    "had been torn down got one more set of agents").toBe(before);
});

t("tab is null for a lone window and the window name once the workspace has more", async () => {
  /* A session with one auto-named window has no tab worth showing; the app
   * would print "claude" as a tab label next to a session already called that. */
  const srv = tmuxServer("tabs");
  const cwd = await tmpDir("cyc-tmux-tab-");
  // a session whose ONLY window is the agent, created in one call so there is
  // never a stray default window to make the count wrong
  const lone = srv.raw("new-session", "-d", "-s", "solo", "-x", "200", "-y", "50",
    "-c", cwd, "-n", "only", "-P", "-F", "#{pane_id}", join(BIN, "claude"), "60").trim();
  expect(lone).toMatch(/^%\d+$/);
  await srv.command(lone, "claude");

  const mux = srv.mux(30);
  const seen = watch(mux);
  mux.start();
  const [a] = await seen.wait((x) => x.length === 1, "the lone claude pane");
  expect(a.workspace).toBe("solo");
  expect(a.tab).toBeNull();

  // a second window in that session and the tab name starts carrying weight
  srv.raw("new-window", "-d", "-t", "solo", "-n", "sibling", "sleep", "60");
  const [b] = await seen.wait((x) => x.length === 1 && x[0].tab !== null, "the tab name to appear");
  expect(b.tab).toBe("only");
  mux.stop();
});

test("empty-enum diag fires on ok-but-zero-panes polls and caps at three", async () => {
  /* The launchd mystery's instrumentation: list-panes exiting 0 with no output
   * logs one "[tmux] empty-enum diag" block, at most three per process. tmux is
   * stubbed on this one instance (the same seam the stop-mid-poll test uses),
   * so every command returns ok and empty: each poll is an empty enumeration,
   * and no real tmux binary is needed. Plain `test`, not `t`, on purpose. */
  const mux = new TmuxMux("cyc-empty-diag");
  (mux as any).tmux = async () => ({ ok: true, out: "", err: "", exit: 0 });
  const orig = console.log;
  let diags = 0;
  console.log = (...args: unknown[]) => {
    if (String(args[0] ?? "").includes("[tmux] empty-enum diag")) diags++;
  };
  try {
    for (let i = 0; i < 6; i++) await (mux as any).poll();
  } finally {
    console.log = orig;
  }
  expect(diags).toBe(3);
});

t("start() narrates: poll-started line, first poll lists what exists, quiet laps stay silent", async () => {
  /* A restart against a live tmux server must SAY what it sees. The live
   * "zero [tmux] lines since boot" failure was unreadable precisely because a
   * running poll over an unchanged server and a poll that never started
   * looked identical in the log. */
  const srv = tmuxServer("narrate");
  const pane = await srv.shell("/tmp");
  const mux = srv.mux(20);
  const seen = watch(mux);
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    mux.start();
    mux.start(); // shared instance: a second start() must not stack a second interval
    await seen.wait(() => true, "the first emit");
    await elapse(100); // a few quiet laps at 20ms
  } finally {
    console.log = orig;
    mux.stop();
  }
  const tl = lines.filter((l) => l.startsWith("[tmux]"));
  expect(tl.filter((l) => l.includes("poll started")).length).toBe(1); // once, not per start()
  // the fixture server boots with its own base window, so pin the shape, not
  // the count: exactly one first-poll summary, and no agents in a bare shell
  expect(tl.filter((l) => /first poll: \d+ pane\(s\), 0 agent\(s\)/.test(l)).length).toBe(1);
  expect(tl.filter((l) => l.includes(`+ pane ${pane}`)).length).toBe(1); // narrated once, never re-spammed
});

/* ------------------------------------------------- locale under launchd (#?) */

/* Service managers start the engine with NO locale; tmux then sanitizes the
 * TAB separators in list-panes -F output to `_` and enumeration parses zero
 * panes. The boot fix is ensureUtf8Locale: pure env logic, so it is unit
 * tested directly (no tmux needed), plus one live probe against a real server
 * below. */

test("ensureUtf8Locale injects the platform LANG into a locale-free env", () => {
  const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
  const want = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  expect(ensureUtf8Locale(env)).toBe(want);
  expect(env.LANG).toBe(want);
});

test("ensureUtf8Locale changes nothing when LC_ALL is already set", () => {
  const env: Record<string, string | undefined> = { LC_ALL: "C", PATH: "/usr/bin" };
  expect(ensureUtf8Locale(env)).toBeNull();
  expect(env).toEqual({ LC_ALL: "C", PATH: "/usr/bin" });
});

test("ensureUtf8Locale changes nothing when LC_CTYPE is already set", () => {
  const env: Record<string, string | undefined> = { LC_CTYPE: "en_US.UTF-8" };
  expect(ensureUtf8Locale(env)).toBeNull();
  expect(env.LANG).toBeUndefined();
});

test("ensureUtf8Locale changes nothing when LANG is already set", () => {
  const env: Record<string, string | undefined> = { LANG: "en_GB.UTF-8" };
  expect(ensureUtf8Locale(env)).toBeNull();
  expect(env.LANG).toBe("en_GB.UTF-8");
});

/* The live shape of the bug: the same tmux client, once with the locale
 * stripped (launchd) and once with the LANG ensureUtf8Locale injects. Some
 * boxes ship a tmux/libc pairing that does not sanitize here (Linux locale
 * availability varies), so the test proves the fix only where the bug
 * reproduces and says so when it cannot. */
t("tmux -F tabs: sanitized without a locale, intact with the injected LANG", () => {
  const srv = tmuxServer("locale");
  const bare: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null || k === "LANG" || k.startsWith("LC_")) continue;
    bare[k] = v;
  }
  const probe = (env: Record<string, string>): string =>
    Bun.spawnSync(
      ["tmux", "-L", srv.sock, "list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}"],
      { env },
    ).stdout.toString();

  const mangled = probe(bare);
  if (!/^%\d+_\d+/m.test(mangled)) {
    console.warn(
      "[tmux.test.ts] locale probe NOT proven: this tmux/libc does not sanitize\n" +
      "  -F tabs without a locale, so only the unit tests above ran.",
    );
    return;
  }
  expect(mangled).not.toContain("\t");

  const fixed = { ...bare };
  expect(ensureUtf8Locale(fixed)).not.toBeNull();
  expect(probe(fixed)).toMatch(/^%\d+\t\d+/m);
});

/* ------------------------------------ reuse-proof pane identity */

test("PaneKey: one constructor, %N recovered only at the -t boundary", () => {
  const k = paneKey("%7", 4242, 1_700_000_000);
  expect(k).toBe("%7~4242~1700000000");
  expect(paneTargetOf(k)).toBe("%7");
  expect(paneTargetOf("%7")).toBe("%7");      // a bare id still translates
  expect(paneTargetOf("%7~x~1")).toBeNull();  // anything else never reaches -t
  expect(paneTargetOf("w1:p1")).toBeNull();
});

test("a dead server behind a live socket (Connection refused) is NO_SERVER, not a transient", async () => {
  /* The connection-refused hole (design doc section 2): a dead server whose
   * socket file survives answers "Connection refused", which matched neither
   * NO_SERVER regex, so the poll kept the last agent set forever and the old
   * %0 never died in the engine's eyes. It must be the authoritative zero. */
  const mux = new TmuxMux("cyc-refused-unit");
  const emits: MuxAgent[][] = [];
  mux.onAgents((a) => emits.push(a));
  const line = ["%0", "123", "claude", "/tmp/cyc-refused-unit", "ws", "@1", "w0",
    "999", "1700000000"].join("\t");
  let refused = false;
  (mux as any).tmux = async (args: string[]) => {
    if (args[0] === "list-panes") {
      return refused
        ? { ok: false, out: "", err: "error connecting to /private/tmp/tmux-501/default (Connection refused)", exit: 1 }
        : { ok: true, out: line + "\n", err: "", exit: 0 };
    }
    return { ok: true, out: "", err: "", exit: 0 }; // capture-pane etc: quiet
  };
  await (mux as any).poll();
  expect(emits.length).toBe(1);
  expect(emits[0].length).toBe(1);
  // the emitted handle IS the reuse-proof key: %N + pane_pid + server epoch
  expect(emits[0][0].paneId).toBe(paneKey("%0", 123, 1700000000));
  refused = true;
  await (mux as any).poll();
  expect(emits[emits.length - 1]).toEqual([]); // the set empties; nothing is kept
});

t("a recycled %0 on a fresh server is a NEW pane key and inherits NOTHING", async () => {
  /* THE REUSE TRAP (design doc symptoms a and c). tmux servers exit with their
   * last pane and a fresh server's first pane is %0 again; every handle-keyed
   * memory used to alias across that churn, so the new pane inherited the dead
   * pane's link, its heal-back uuid and (in core) its whole conversation. With
   * the composite key a recycled %0 is a NEW identity: no pre-link, no sticky
   * link, no prevLink heal, and the dead generation's transcript is refused. */
  const sock = `cyc-reuse-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: { sock: string; muxes: TmuxMux[]; socketPath?: string } = { sock, muxes: [] };
  servers.push(entry);
  const raw = (...args: string[]): string =>
    Bun.spawnSync(["tmux", "-L", sock, ...args]).stdout.toString();
  const cwd = await tmpDir("cyc-tmux-reuse-");
  const oldUuid = "ab000000-0000-4000-8000-000000000010";
  seedTranscript(cwd, oldUuid, Date.now() - 60_000);

  // generation 1: the server's FIRST pane runs claude and, being present at
  // the mux's first enumeration, links the existing transcript (restart rule)
  const p1 = raw("new-session", "-d", "-s", "one", "-x", "200", "-y", "50",
    "-c", cwd, "-P", "-F", "#{pane_id}", join(BIN, "claude"), "60").trim();
  entry.socketPath = raw("display-message", "-p", "#{socket_path}").trim() || undefined;
  const mux = new TmuxMux(sock, 30);
  entry.muxes.push(mux);
  const seen = watch(mux);
  mux.start();
  const [g1] = await seen.wait((x) => x.length === 1 && x[0].agentSession?.id === oldUuid,
    "generation 1 to link the existing transcript");
  expect(paneTargetOf(g1.paneId)).toBe(p1);

  // the server dies with its pane: the authoritative zero empties the set
  Bun.spawnSync(["tmux", "-L", sock, "kill-server"]);
  await seen.wait((a) => a.length === 0, "the set to empty when the server dies");

  // generation 2: a FRESH server on the same socket; its first pane wears the
  // SAME %N, with a claude in the SAME cwd -- the exact reuse shape
  const p2 = raw("new-session", "-d", "-s", "two", "-x", "200", "-y", "50",
    "-c", cwd, "-P", "-F", "#{pane_id}", join(BIN, "claude"), "60").trim();
  expect(p2).toBe(p1); // tmux really did recycle the handle
  const g2 = (await seen.wait((x) => x.length === 1 && x[0].agentSession != null,
    "generation 2 to be enumerated"))[0];
  // a NEW identity, even though the %N is identical...
  expect(paneTargetOf(g2.paneId)).toBe(p1);
  expect(g2.paneId).not.toBe(g1.paneId);
  // ...that inherits nothing: parked on its OWN key, not linked to the dead
  // generation's uuid (no sticky link, no prevLink heal, no pre-link)
  expect(g2.agentSession).toEqual({ id: g2.paneId, kind: "id", source: "tmux:parked" });
  // laps later the dead generation's transcript has STILL not been adopted
  await elapse(120);
  const held = seen.emits[seen.emits.length - 1][0];
  expect(held.agentSession!.id).not.toBe(oldUuid);
  // while the pane's OWN newborn jsonl (born after first-seen) still clears
  const newUuid = "cd000000-0000-4000-8000-000000000011";
  seedTranscript(cwd, newUuid, Date.now());
  const after = await seen.wait((x) => x.length === 1 && x[0].agentSession?.id === newUuid,
    "generation 2 to adopt its own newborn transcript");
  expect(after[0].agentSession).toEqual({ id: newUuid, kind: "id", source: "tmux:claude" });
  mux.stop();
});

test("pane continuity is PaneKey-scoped: a recycled %N joins neither a live agent nor a persisted binding", async () => {
  /* The reuse-proof rule: an unannounced new id may only ever join the agent
   * on the SAME PaneKey (reconcile rule 2, pane continuity). That holds by
   * construction -- both inputs (the live session's muxHandle, the persisted
   * pane binding) key on the reuse-proof handle -- and this pins it: the
   * same-key shapes still join, the cross-generation shapes never do. */
  const { resolvePane, evidenceOf, tickOf, resetReconcileForTest: reconcileReset } =
    await import("../sessions/reconcile.ts");
  const { sessions, paneBindings, metaFor, resetForTest: stateReset } =
    await import("../sessions/session-state.ts");
  try {
    const g1 = paneKey("%0", 111, 1000); // one pane generation...
    const g2 = paneKey("%0", 222, 2000); // ...and the next server's %0
    expect(g2).not.toBe(g1);
    const A = "ag-liveAAAAAAAAAAAAA";
    const B = "ag-bootBBBBBBBBBBBBB";
    // harness-shaped ids: anything else is no evidence at all (ids.ts)
    const U_OLD = "a0000000-0000-4000-8000-00000000001d";
    const U_NEW = "a0000000-0000-4000-8000-00000000002e";
    const B_OLD = "b0000000-0000-4000-8000-00000000001d";
    const B_NEW = "b0000000-0000-4000-8000-00000000002e";
    const pane = (handle: string, id: string) => ({
      handle, cwd: "/w", kind: "claude", agentSession: { id, kind: "id", source: "hook:announce" },
    }) as never;
    const resolve = (handle: string, id: string) => {
      const a = pane(handle, id);
      return resolvePane(a, evidenceOf(a), tickOf([a], [evidenceOf(a)], 10_000));
    };

    // live half: the agent on the pane joins under ITS OWN key only
    metaFor(A).sessionId = U_OLD;
    sessions.set(A, {
      id: A, agentId: A, muxHandle: g1, harnessSessionId: U_OLD, alive: true,
      agent: { id: "claude" }, cwd: "/w", chat: [{ id: A, ts: 1, seq: 1 }],
    } as never);
    expect(resolve(g1, U_NEW)).toEqual({ agentId: A, sessionId: U_NEW, how: "pane-continuity" }); // same key: the roll shape
    const stolen = resolve(g2, U_NEW);
    expect(stolen.how, "a recycled %N joined the previous generation's live agent").toBe("new");
    expect(stolen.agentId).not.toBe(A);

    // boot half (no live rows yet): the persisted binding proves lineage for
    // ITS OWN key only
    sessions.clear();
    metaFor(B).sessionId = B_OLD;
    paneBindings.set(g1, { agentId: B, sessionId: B_OLD, cwd: "/w", alive: true, ts: Date.now() });
    expect(resolve(g1, B_NEW)).toEqual({ agentId: B, sessionId: B_NEW, how: "pane-continuity" }); // same key: still joins
    const recycled = resolve(g2, B_NEW);
    expect(recycled.how, "a recycled %N inherited the dead generation's binding").toBe("new");
    expect(recycled.agentId).not.toBe(B);
  } finally {
    reconcileReset();
    stateReset();
  }
});
