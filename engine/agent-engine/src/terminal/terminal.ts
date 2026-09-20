/* Live terminal frames: the engine's side of the terminal pane.
 *
 * A viewer in the app wants to WATCH and USE a pane. herdr already has the
 * thing that does it -- a bridge process that renders the pane into a virtual
 * terminal and prints ANSI frames as newline-delimited JSON:
 *
 *   herdr terminal session control <paneId> --cols N --rows N
 *   {"type":"terminal.frame","encoding":"ansi","full":true,
 *    "width":120,"height":40,"seq":1,"bytes":"<base64 of raw ANSI>"}
 *
 * The first frame is `full:true` and runs to a couple of hundred kilobytes of
 * base64; everything after it is a delta of a few hundred characters. The
 * bytes are raw ANSI -- cursor positioning, truecolor, synchronized-output
 * markers -- which is exactly what xterm.js eats, so nothing here parses or
 * translates anything. The engine is a pipe with a refcount.
 *
 * `control`, NOT `observe`, AND THAT IS THE WHOLE SIZING BUG. Step one used
 * the read-only `observe` bridge, and its --cols/--rows do not do what the
 * name suggests: they set the size of the GRID herdr renders into, and then it
 * copies the pane's own screen into that grid and CROPS. Measured on the sink,
 * same pane, same second:
 *
 *   observe w9:p14 --cols 58 --rows 60 -> frame says 58x60, but every line is
 *     cut mid-word at column 58 ("...these are the w") and only 24 of the 60
 *     rows have anything in them. It is a photograph of a 132-column screen
 *     with the right-hand side torn off.
 *   control w9:p14 --cols 58 --rows 60 -> frame says 58x60 and the program
 *     inside the pane has actually REFLOWED to 58 columns: words wrap, and all
 *     60 rows are full.
 *
 * That is exactly the two symptoms he photographed (clipped at the right, black
 * at the bottom) and it is why the app's own two numbers agreed while the
 * picture was still wrong: the app was right, the bridge was cropping.
 *
 * The reason is that `control` resizes the pane's real pty, so the program
 * redraws itself. His call, and he had already checked it: the desktop client
 * is NOT evicted, the pane just takes the size of whoever attached last.
 *
 * `control` also reads stdin, one JSON object per line, which is where typing,
 * resizing and scrolling go. Fire and forget: a frame it does not like is
 * answered ONLY on stderr, with "herdr: terminal session control input
 * ignored: ...", so stderr is read and logged rather than dropped.
 *
 * THE DRIVER SEAM. tmux is meant to arrive behind this later, so the hub knows
 * only `TerminalDriver`: give it a pane id and a size, get something that
 * emits frames and takes input, resizes, scrolls and dies. herdr is the first
 * driver, not the only one, and nothing above this file names it.
 */

import type { Subprocess } from "bun";
import { readFileSync } from "node:fs";
import { paneTargetOf } from "./tmux.ts";
import { stateFile } from "../storage/datadir.ts";
import { writeAtomicPrivateSync } from "../../../shared/runfiles.ts";

export type TerminalFrame = {
  full: boolean;
  seq: number;
  cols: number;
  rows: number;
  bytes: string; // base64 of raw ANSI
};

export type TerminalHandlers = {
  onFrame(f: TerminalFrame): void;
  onSize(cols: number, rows: number): void;
  onClosed(why: string): void;
};

/* What a viewer can send INTO a pane. Exactly one of the two is set.
 *
 * `text` is for what somebody typed and is UTF-8 by the time herdr sees it.
 * `bytes` is base64 and is for everything that is not text: Ctrl-C is a single
 * 0x03, an arrow is a three-byte escape sequence, and both would be mangled by
 * a round trip through a JSON string in some client's idea of an encoding. */
export type TerminalInput = { text: string } | { bytes: string };

export type ScrollDirection = "up" | "down";

/* HOW A GESTURE REACHES THE PANE, and there are two answers because there are
 * two kinds of pane. Measured, both of them, on real panes (see paneMode).
 *
 *   "scroll" -- the pane is on the NORMAL screen and herdr is keeping its
 *     scrollback. `terminal.scroll` moves herdr's viewport and the next frame
 *     is the new view. Measured on a shell holding 3000 lines: up 5 moved the
 *     picture by exactly 5 and offset_from_bottom went 0 -> 5.
 *
 *   "wheel" -- a full-screen program owns the pane, so herdr HAS no scrollback
 *     for it and `terminal.scroll` does nothing at all. Measured against a pane
 *     running Claude Code: max_offset_from_bottom was 0, `terminal.scroll up 5`
 *     produced ZERO frames and changed ZERO rows. What that pane answers is the
 *     MOUSE WHEEL, typed in as SGR sequences: 30 notches streamed one per 16 ms
 *     came back as 29 frames, ~300 base64 bytes each, and the program scrolled
 *     its own view a line at a time. That is the mechanism a real terminal
 *     emulator uses on the alternate screen, and it is why it tracks a finger:
 *     the program in the pane is doing the scrolling and redrawing itself.
 *
 *   "none" -- a shell sitting at its prompt with nothing behind it. There is
 *     nothing to scroll AND nobody to hand a wheel event to, so nothing is
 *     sent. This case exists for one reason: a wheel sequence delivered to a
 *     program that never asked for mouse reporting is TYPED INTO IT as text.
 *     Measured, on a plain zsh prompt: five SGR wheel events left
 *     `64;20;10M64;20;10M...` sitting on his command line. That is the worst
 *     thing this feature could do, so the ambiguous case sends nothing.
 */
export type ScrollMode = "scroll" | "wheel" | "none";

export interface TerminalSession {
  resize(cols: number, rows: number): void;
  input(msg: TerminalInput): void;
  scroll(direction: ScrollDirection, lines: number): void;
  release(): void;
}

export interface TerminalDriver {
  readonly name: string;
  /* Can a running bridge be told a new size, or does the size only come from
   * how it was started?
   *
   * MEASURED, not assumed. `herdr terminal session control` reads stdin and
   * answers `{"type":"terminal.resize",...}` with frames at the new size, so
   * this is true for herdr. It stays on the interface because the read-only
   * `observe` bridge does NOT read stdin at all -- a deliberately malformed
   * frame written into it produced no answer on stderr and no change in the
   * frames, which is the shape of "nobody is listening" rather than "that was
   * rejected" -- and a driver like that has to be respawned to be resized
   * rather than have frames fired into a pipe nothing reads. */
  readonly canResize: boolean;
  open(paneId: string, cols: number, rows: number, h: TerminalHandlers): TerminalSession;
  /* Which of the two roads a gesture takes for THIS pane, right now. Asked of
   * the driver rather than decided here because the answer comes from the
   * driver's own idea of the pane; see herdrDriver.paneMode for how it is
   * worked out and what it cannot know. */
  paneMode(paneId: string): Promise<ScrollMode>;
}

/* One keystroke is a byte or three; a paste is not much more. This is a guard
 * against a bug or a hostile client filling the bridge's stdin, not a limit
 * anyone typing will ever meet. */
export const INPUT_MAX_BYTES = 8192;

/* A scroll gesture is a few lines. Anything larger is a client bug: herdr
 * takes a line count, not a position, so a huge number is a long walk through
 * scrollback rather than a jump. */
export const SCROLL_MAX_LINES = 200;

/* The wire is untrusted, so this is the one place that decides what a control
 * frame may contain. Returns null for anything it will not send, and the
 * caller stays silent rather than guessing: an input frame that is dropped
 * here is a bug in the app, and inventing a substitute keystroke for the pane
 * would be worse than sending nothing. */
export function safeInput(m: { text?: unknown; bytes?: unknown }): TerminalInput | null {
  if (typeof m.text === "string" && m.text.length > 0) {
    if (Buffer.byteLength(m.text, "utf8") > INPUT_MAX_BYTES) return null;
    return { text: m.text };
  }
  if (typeof m.bytes === "string" && m.bytes.length > 0) {
    // Standard base64, and it has to decode: herdr answers a bad one only on
    // stderr, so a typo would look exactly like a key that did nothing.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(m.bytes)) return null;
    let n = 0;
    try {
      n = Buffer.from(m.bytes, "base64").length;
    } catch {
      return null;
    }
    if (n === 0 || n > INPUT_MAX_BYTES) return null;
    return { bytes: m.bytes };
  }
  return null;
}

/* A pane id, and nothing else, may reach a command line.
 *
 * Bun.spawn takes an argv array so there is no shell to interpolate into, but
 * the id also picks the pane whose history and process list get read, so it is
 * checked rather than trusted. herdr's ids are base36-ish (w9:p16, w6:pY,
 * wE:p1), which is wider than the hex-looking pattern they appear to use. */
export function safePaneId(id: unknown): string | null {
  const s = String(id ?? "");
  return /^w[0-9a-z]{1,8}:p[0-9a-z]{1,8}$/i.test(s) ? s : null;
}

/* THE WHEEL, as bytes.
 *
 * SGR encoding (`\x1b[<Cb;Cx;CyM`), Cb 64 for up and 65 for down. That is the
 * 1006 form, and it is the one measured to work against Claude Code; the older
 * X10 form was tried in the same run and moved nothing.
 *
 * The column and row are where the pointer "is". A wheel event has to name a
 * cell and there is no pointer on a phone, so it names the middle of the
 * screen -- inside whatever the program considers scrollable, rather than on
 * an edge it might treat specially.
 *
 * ONE WRITE FOR THE WHOLE BURST. A notch is 12 bytes, so even the cap fits in
 * one `terminal.input`, and the pty sees exactly the stream it would see from
 * a real trackpad. Measured: 30 notches in one write and 30 notches one per
 * 16 ms both moved the pane 30 lines; the difference is only how many frames
 * come back to draw it with.
 */
export const WHEEL_UP = 64;
export const WHEEL_DOWN = 65;

export function wheelSeq(direction: ScrollDirection, notches: number, col = 20, row = 10): string {
  const cb = direction === "up" ? WHEEL_UP : WHEEL_DOWN;
  return `\x1b[<${cb};${col};${row}M`.repeat(Math.max(0, notches));
}

/* How many notches one message may carry. INPUT_MAX_BYTES / 12 is the hard
 * ceiling; this is well under it and matches SCROLL_MAX_LINES so both roads
 * travel the same distance for the same gesture. */
export const WHEEL_MAX_NOTCHES = SCROLL_MAX_LINES;

export function safeScroll(m: { dir?: unknown; lines?: unknown }): { direction: ScrollDirection; lines: number } | null {
  const direction = m.dir === "up" ? "up" : m.dir === "down" ? "down" : null;
  if (!direction) return null;
  const lines = Math.round(Number(m.lines));
  if (!Number.isFinite(lines) || lines < 1) return null;
  return { direction, lines: Math.min(SCROLL_MAX_LINES, lines) };
}

// Sizes the app is allowed to ask for. A viewer that measures itself while
// hidden can report 0, and a bad number would either be rejected by herdr
// (silently, on stderr) or spawn a bridge rendering into nothing.
export const COLS_MIN = 20;
export const COLS_MAX = 400;
export const ROWS_MIN = 5;
export const ROWS_MAX = 200;

export function clampCols(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 80;
  return Math.min(COLS_MAX, Math.max(COLS_MIN, v));
}

export function clampRows(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 24;
  return Math.min(ROWS_MAX, Math.max(ROWS_MIN, v));
}

/* One line of the bridge's stdout -> a frame, or nothing.
 *
 * Exported so the shapes can be tested against the real capture in
 * scratchpad/obs.ndjson without spawning anything. Unknown `type` values are
 * dropped rather than logged: the protocol is versioned and a newer herdr is
 * allowed to say things this engine has never heard of.
 */
export function parseBridgeLine(line: string):
  | { kind: "frame"; frame: TerminalFrame }
  | { kind: "size"; cols: number; rows: number }
  | { kind: "closed"; why: string }
  | null {
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  if (m.type === "terminal.frame") {
    if (typeof m.bytes !== "string") return null;
    return {
      kind: "frame",
      frame: {
        full: m.full === true,
        seq: Number(m.seq) || 0,
        // herdr says width/height; everything above this file says cols/rows,
        // because that is what a terminal and xterm.js both call them.
        cols: Number(m.width) || 0,
        rows: Number(m.height) || 0,
        bytes: m.bytes,
      },
    };
  }
  if (m.type === "terminal.size") {
    return { kind: "size", cols: Number(m.width) || 0, rows: Number(m.height) || 0 };
  }
  if (m.type === "terminal.closed") {
    return { kind: "closed", why: typeof m.reason === "string" ? m.reason : "closed" };
  }
  return null;
}

/* Split a byte stream into lines, keeping the tail.
 *
 * The first full frame is ~224KB of base64 and does NOT arrive in one chunk,
 * so a reader that treats every chunk as a line loses it. This is the only
 * framing rule the bridge has: one JSON object per '\n'.
 */
export class LineSplitter {
  private buf = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array, onLine: (line: string) => void) {
    this.buf += this.decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  }
}

// ---------------------------------------------------------------- herdr driver

const HERDR_BIN = "herdr"; // on PATH

/* One herdr query, as JSON, or null. These are socket round trips to the
 * running herdr server and cost a couple of milliseconds; they are still not on
 * the gesture path (see the cache in the hub), because a gesture is sixty
 * events a second and this is per pane, not per notch. */
async function herdrJson(args: string[]): Promise<any | null> {
  try {
    const p = Bun.spawn([HERDR_BIN, ...args], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return null;
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/* WHICH ROAD THIS PANE'S GESTURES TAKE, worked out from herdr's own state.
 *
 * herdr does not say whether the alternate screen is active or whether the
 * program asked for mouse reporting -- checked: neither "mouse", "alt", "1049"
 * nor "mode" appears anywhere in `herdr api schema`, and the bridge's frames
 * are re-renders, so the DECSET never reaches this side either. So it is
 * inferred, from two things herdr does say:
 *
 *   scroll.max_offset_from_bottom > 0  ->  herdr is keeping scrollback for
 *     this pane, which it only does on the normal screen. `terminal.scroll`
 *     is the right road and is measured to work. ("scroll")
 *
 *   no scrollback, and the foreground process group is NOT the shell  ->  a
 *     program owns the pane and herdr has no history for it, which is what the
 *     alternate screen looks like from out here. That is the Claude Code case,
 *     measured: max_offset_from_bottom 0, terminal.scroll a no-op, wheel
 *     events answered a line per notch. ("wheel")
 *
 *   no scrollback, and the shell IS the foreground  ->  a prompt with nothing
 *     behind it. ("none")
 *
 * WHAT THIS CANNOT TELL APART, said plainly because it is the one way the app
 * could still type into his shell: a program that is NOT full-screen, running
 * in a pane that has no scrollback yet (a `sleep` in a fresh pane, a REPL that
 * has printed nothing). It looks exactly like the alternate-screen case from
 * here and would be sent wheel bytes it does not understand. Narrow, and it
 * needs herdr to expose the alternate-screen flag to close properly.
 */
async function herdrPaneMode(paneId: string): Promise<ScrollMode> {
  const id = safePaneId(paneId);
  if (!id) return "none";
  const info = await herdrJson(["pane", "get", id]);
  const scroll = info?.result?.pane?.scroll;
  if (typeof scroll?.max_offset_from_bottom === "number" && scroll.max_offset_from_bottom > 0) return "scroll";
  const proc = await herdrJson(["pane", "process-info", "--pane", id]);
  const pi = proc?.result?.process_info;
  if (typeof pi?.foreground_process_group_id !== "number" || typeof pi?.shell_pid !== "number") return "none";
  return pi.foreground_process_group_id === pi.shell_pid ? "none" : "wheel";
}

/* ---------------------------------------------------------- bridge registry
 *
 * WHY A FILE AND NOT JUST THE HUB'S MAP. Every `herdr terminal session control`
 * child holds the pane's single attach slot on the herdr side. The hub tracks
 * bridges in memory only (no pid field, nothing on disk), so a SIGKILL, a plain
 * SIGTERM, or a silent half-open phone leaves that child running and squatting
 * the slot, and the NEXT engine boot has no record of what its last life
 * spawned. This tiny on-disk registry is that record: one entry per live
 * control child, written crash-safe (writeAtomicPrivateSync, the same rename
 * idiom every other state file uses), so boot can target-kill exactly the
 * orphans it left behind and nothing else.
 */

export type BridgeEntry = { pid: number; paneId: string; startedAt: number };

/* Resolved per call, not captured at import, for the same reason settingsFile()
 * / paneBindingsFile() are in session-state.ts: a `const` frozen at module load
 * makes the data dir unswappable before a test can point CYC_DATA_DIR at its
 * own tree. */
export const bridgeRegistryFile = (): string => stateFile("terminal-bridges.json");

export function readBridges(file: string = bridgeRegistryFile()): BridgeEntry[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is BridgeEntry =>
        e && typeof e.pid === "number" && typeof e.paneId === "string" && typeof e.startedAt === "number",
    );
  } catch {
    // first boot, or a corrupt/half-written file: no bridges remembered
    return [];
  }
}

function writeBridges(entries: BridgeEntry[], file: string = bridgeRegistryFile()): void {
  try {
    writeAtomicPrivateSync(file, JSON.stringify(entries));
  } catch {
    // best-effort: a registry we cannot write only costs a reap we cannot do,
    // which is exactly today's behaviour, never a crash on the spawn path
  }
}

/** Add (or refresh) the entry for a freshly spawned control child. */
export function recordBridge(pid: number, paneId: string, file: string = bridgeRegistryFile()): void {
  const entries = readBridges(file).filter((e) => e.pid !== pid);
  entries.push({ pid, paneId, startedAt: Date.now() });
  writeBridges(entries, file);
}

/** Drop the entry for a child that has exited or been released. */
export function dropBridge(pid: number, file: string = bridgeRegistryFile()): void {
  const entries = readBridges(file);
  const kept = entries.filter((e) => e.pid !== pid);
  if (kept.length !== entries.length) writeBridges(kept, file);
}

/* Is this pid still a `herdr terminal session control` process?
 *
 * MANDATORY BEFORE ANY BOOT KILL: pids are reused, and the registry can name a
 * pid whose original owner died and whose number now belongs to an innocent
 * process. `cmdline` is the NUL-separated argv from /proc/<pid>/cmdline. We
 * match the binary basename `herdr` followed by the `terminal session control`
 * verb, which is the exact shape of the child we spawn (and the shape scenario
 * 11 hunts for) and nothing else on the box. */
export function matchesHerdrControl(cmdline: string | null): boolean {
  if (!cmdline) return false;
  const argv = cmdline.split("\0").filter((s) => s.length > 0);
  if (argv.length < 4) return false;
  const bin = argv[0]!.split("/").pop();
  if (bin !== HERDR_BIN) return false;
  return argv.join(" ").includes("terminal session control");
}

/* Registry-driven kills need MORE than the shape: they need the RIGHT pane.
 *
 * matchesHerdrControl proves the pid is a herdr control child, but two engines
 * under one user on one box each keep their own registry, and a pid engine A
 * orphaned can be reused by engine B's LIVE control child before A reboots. That
 * reused pid still passes matchesHerdrControl, so A's reap would kill B's live
 * bridge. The registry entry knows which pane the pid was ours for, and the
 * child carries its own pane as an argv token, so a reap only claims a pid whose
 * /proc still names the entry's own pane. A different pane is another engine's
 * child and is spared. Kept beside matchesHerdrControl, and just as pure. */
export function matchesHerdrControlForPane(cmdline: string | null, paneId: string): boolean {
  if (!matchesHerdrControl(cmdline)) return false;
  return cmdline!.split("\0").filter((s) => s.length > 0).includes(paneId);
}

/** The grace between SIGTERM and SIGKILL, env-tunable like the other timings. */
export const KILL_GRACE_MS = Math.max(0, Number(process.env.CYC_TERMINAL_KILL_GRACE_MS ?? 2000) || 0);

/** True if the pid exists (EPERM counts: it is alive, just not ours to signal). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type ReapDeps = {
  file?: string;
  readCmdline?: (pid: number) => string | null;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  wait?: (ms: number) => Promise<void>;
  graceMs?: number;
  log?: (s: string) => void;
};

const readProcCmdline = (pid: number): string | null => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
};

/* BOOT REAP: kill the control children a previous engine life orphaned.
 *
 * The registry is the authority; there is deliberately NO blind process-table
 * scan. For each entry: if /proc says the pid is a matching herdr control child
 * we SIGTERM it, wait the grace, SIGKILL if it is still there, then drop it. A
 * pid that is gone, or whose cmdline no longer matches (reuse), is left
 * untouched and only removed from the file. Returns the number actually killed.
 */
export async function reapOrphans(deps: ReapDeps = {}): Promise<number> {
  const file = deps.file ?? bridgeRegistryFile();
  const readCmdline = deps.readCmdline ?? readProcCmdline;
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const isAlive = deps.isAlive ?? pidAlive;
  const wait = deps.wait ?? sleep;
  const graceMs = deps.graceMs ?? KILL_GRACE_MS;
  const log = deps.log ?? console.log;

  const entries = readBridges(file);
  let reaped = 0;
  for (const e of entries) {
    // gone, reused, or another pane's control child: leave it (pane-scoped)
    if (!matchesHerdrControlForPane(readCmdline(e.pid), e.paneId)) continue;
    let delivered = false;
    try {
      kill(e.pid, "SIGTERM");
      delivered = true;
    } catch {
      // already gone between the cmdline read and here
    }
    if (graceMs > 0) await wait(graceMs);
    // Re-check the cmdline, not just liveness, before the delayed SIGKILL: a pid
    // the SIGTERM freed and the OS handed to an innocent inside the grace window
    // is alive but no longer ours, so it must not eat the SIGKILL.
    if (isAlive(e.pid) && matchesHerdrControlForPane(readCmdline(e.pid), e.paneId)) {
      try {
        kill(e.pid, "SIGKILL");
        delivered = true;
      } catch {
        // gone on the SIGTERM after all
      }
    }
    // Counted like killAllTrackedBridgesSync: only a signal that was actually
    // delivered, so a pid that vanished between the cmdline read and the kill
    // is not reported as reaped.
    if (delivered) {
      reaped++;
      log(`[terminal] reaped orphan bridge pid=${e.pid} pane=${e.paneId} (from a previous engine life)`);
    }
  }
  // Every entry we looked at is now dealt with: killed, gone, or reused. None of
  // them describes a live child of THIS engine, so the file starts empty.
  writeBridges([], file);
  return reaped;
}

/* CLEAN-SHUTDOWN KILL: synchronous, best-effort, tiny. Run from the SIGTERM /
 * SIGINT handlers, where there is no time for a grace timer. The registry is
 * the persisted mirror of the hub's live bridges, so it is the source here; the
 * cmdline guard keeps a reused pid safe even on the way out. */
export function killAllTrackedBridgesSync(deps: {
  file?: string;
  readCmdline?: (pid: number) => string | null;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
} = {}): number {
  const file = deps.file ?? bridgeRegistryFile();
  const readCmdline = deps.readCmdline ?? readProcCmdline;
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  let killed = 0;
  for (const e of readBridges(file)) {
    if (!matchesHerdrControlForPane(readCmdline(e.pid), e.paneId)) continue; // pane-scoped
    try {
      kill(e.pid, "SIGKILL");
      killed++;
    } catch {
      // already gone
    }
  }
  writeBridges([], file);
  return killed;
}

// ---------------------------------------------------------------- herdr driver

/* The seam a test uses to drive open()/release()/onClosed WITHOUT a real herdr:
 * substitute the spawn (a `sleep` stub stands in for the control child) and the
 * registry file (a tmp path). Production passes neither, so the live driver
 * spawns the real `herdr terminal session control` and writes the real state
 * file. */
export type HerdrDriverOpts = {
  spawnBridge?: (paneId: string, cols: number, rows: number) => Subprocess<"pipe", "pipe", "pipe">;
  registryFile?: string;
  graceMs?: number;
  readCmdline?: (pid: number) => string | null;
};

export function herdrDriver(
  log: (s: string) => void = console.log,
  opts: HerdrDriverOpts = {},
): TerminalDriver {
  const registryFile = opts.registryFile ?? bridgeRegistryFile();
  const graceMs = opts.graceMs ?? KILL_GRACE_MS;
  const readCmdline = opts.readCmdline ?? readProcCmdline;
  const spawnBridge =
    opts.spawnBridge ??
    ((paneId: string, cols: number, rows: number) =>
      Bun.spawn(
        [HERDR_BIN, "terminal", "session", "control", paneId, "--takeover", "--cols", String(cols), "--rows", String(rows)],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      ));
  return {
    name: "herdr",
    paneMode: herdrPaneMode,
    // `control` reads stdin and re-renders at whatever size it is told, so a
    // rotation is a frame rather than a respawn. Measured; see the interface.
    canResize: true,
    open(paneId, cols, rows, h) {
      let proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
      let released = false;

      try {
        /* `--takeover` IS passed, and it is the right default: it lets a new
         * viewer barge past a client that is stuck holding the pane's single
         * attach slot (a crashed engine's orphan, a dead phone) instead of
         * drawing a blank box forever. Measured on the sink: the desktop client
         * is not evicted for normal use, the pane just takes the size of
         * whoever attached last. Taking over the slot is not the same as
         * freeing it, though, so the orphan itself is dealt with by the
         * registry above (recorded here, reaped at boot, killed on release). */
        proc = spawnBridge(paneId, cols, rows);
      } catch (e) {
        // herdr not installed, or not on this engine's PATH. The viewer gets a
        // closed frame and says so, rather than watching an empty box forever.
        h.onClosed(`could not start ${HERDR_BIN}: ${e instanceof Error ? e.message : String(e)}`);
        return { resize() {}, input() {}, scroll() {}, release() {} };
      }

      const pid = proc.pid;
      // Persist the pid BEFORE anything can go wrong, so a crash a millisecond
      // from now still leaves a record the next boot can reap.
      recordBridge(pid, paneId, registryFile);
      log(`[terminal] + ${paneId} ${cols}x${rows} pid=${pid}`);

      const splitter = new LineSplitter();
      void (async () => {
        try {
          for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
            if (released) return;
            splitter.push(chunk, (line) => {
              const ev = parseBridgeLine(line);
              if (!ev) return;
              if (ev.kind === "frame") h.onFrame(ev.frame);
              else if (ev.kind === "size") h.onSize(ev.cols, ev.rows);
              else h.onClosed(ev.why);
            });
          }
        } catch {
          // stream torn down by release(); nothing to report
        }
        if (!released) {
          // The child died on its own (pane closed, herdr restarted). release()
          // will not run for it, so the registry entry is cleared here instead;
          // an orphan is only ever an engine that died WITH its children still
          // up, not a child that outlived a clean close.
          dropBridge(pid, registryFile);
          h.onClosed("bridge exited");
        }
      })();

      /* stderr is where the bridge complains, and it complains QUIETLY: a
       * malformed control frame is answered with
       * "herdr: terminal session control input ignored: ..." on stderr and
       * nothing else. Dropping it means a resize that never happens looks
       * exactly like a resize that did. */
      void (async () => {
        try {
          for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
            const s = new TextDecoder().decode(chunk).trim();
            if (s) log(`[terminal] ${paneId} stderr: ${s}`);
          }
        } catch {
          // torn down
        }
      })();

      const write = (obj: unknown) => {
        if (released || !proc) return;
        try {
          proc.stdin.write(JSON.stringify(obj) + "\n");
          proc.stdin.flush();
        } catch {
          // the bridge is gone; the stdout reader will report the close
        }
      };

      return {
        resize(nextCols, nextRows) {
          write({ type: "terminal.resize", cols: nextCols, rows: nextRows });
        },
        input(msg) {
          /* Straight through. The bytes were built by whoever pressed the key
           * and nothing here knows or should know what \x03 means -- a layer
           * that started translating keys would need a keymap, and a keymap
           * that disagreed with the program in the pane is worse than no key
           * bar at all. */
          write({ type: "terminal.input", ...msg });
        },
        scroll(direction, lines) {
          // Both fields are required by herdr; there is no absolute position.
          write({ type: "terminal.scroll", direction, lines });
        },
        release() {
          if (released) return;
          released = true;
          write({ type: "terminal.release" });
          // AUTHORITATIVE, not hopeful. The old release wrote the frame, sent one
          // SIGTERM, and trusted the child to go; a child that ignores SIGTERM
          // kept the attach slot forever. Now: SIGTERM, a short grace off the
          // event loop, then SIGKILL if it is still there, then clear the
          // registry entry. The timer is unref'd so it never holds the process
          // open, and the whole thing is best-effort: a throw here must not take
          // down the caller (Hub.close).
          try {
            proc?.kill(); // SIGTERM
          } catch {
            // already dead
          }
          const t = setTimeout(() => {
            try {
              // Re-check the cmdline, not just liveness: a pid the SIGTERM freed
              // and the OS reused inside the grace window is an innocent, and it
              // must not eat the SIGKILL. Only a still-live pid whose /proc still
              // reads as our herdr control child is ours to end.
              if (pidAlive(pid) && matchesHerdrControl(readCmdline(pid))) {
                process.kill(pid, "SIGKILL");
              }
            } catch {
              // gone on the SIGTERM after all
            }
            dropBridge(pid, registryFile);
          }, graceMs);
          (t as { unref?: () => void }).unref?.();
          log(`[terminal] - ${paneId} pid=${pid}`);
        },
      };
    },
  };
}

// ---------------------------------------------------------------- tmux driver

/* tmux behind the SAME driver seam (#480). herdr ships a bridge that
 * renders a pane to a virtual terminal and streams full+delta ANSI frames; tmux
 * has no such process, so this driver builds the equivalent out of the two verbs
 * tmux does have: `capture-pane -e` (the visible screen, SGR bytes intact) and
 * `send-keys`.
 *
 * A FULL FRAME EVERY TICK, not deltas. herdr sends `full:true` once and diffs
 * after it; capture-pane hands back the whole viewport each time, so every frame
 * this driver emits is a repaint (home + clear + rows). xterm.js applies a
 * repaint cleanly, and a poll that finds the screen unchanged emits nothing, so
 * an idle pane costs one capture per tick and no wire traffic. This is correct,
 * not clever: no cursor tracking, no scrollback replay, just the current screen.
 *
 * THE FRAME REPORTS THE PANE'S REAL SIZE (`#{pane_width}x#{pane_height}`), so
 * the app sizes xterm to exactly what capture-pane measured and nothing is ever
 * clipped -- the failure mode recorded for herdr's `observe`. resize()
 * reflows the pane to the viewer (window-size manual + resize-window), best
 * effort; whether or not tmux honours it, the next frame still carries the true
 * dimensions.
 */

const TMUX_POLL_MS = 150;
// pane handles arrive as the reuse-proof pane key (`%N~pid~epoch`, tmux.ts) or
// a bare %N; paneTargetOf recovers the `-t` target and rejects anything else
const SHELL_COMMANDS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh"]);

/** One tmux CLI call on this driver's socket. argv, so no shell to interpolate. */
async function tmuxCall(sockArgs: string[], args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(["tmux", ...sockArgs, ...args], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    return { ok: (await p.exited) === 0, out };
  } catch {
    return { ok: false, out: "" };
  }
}

async function tmuxPaneMode(sockArgs: string[], paneId: string): Promise<ScrollMode> {
  // the handle is the reuse-proof pane key (`%N~pid~epoch`) or a bare %N; the
  // `-t` argument wants the bare pane id and rejects anything else
  const target = paneTargetOf(paneId);
  if (!target) return "none";
  const { ok, out } = await tmuxCall(sockArgs, ["display-message", "-p", "-t", target, "#{alternate_on}\t#{pane_current_command}"]);
  if (!ok) return "none";
  const [alt, cmd] = out.trim().split("\t");
  // A full-screen program (claude, an editor) owns the alternate screen: herdr
  // measured this as the wheel road, and tmux's own scrollback is empty for it.
  if (alt === "1") return "wheel";
  // A bare shell prompt: nothing behind it and nobody to hand a wheel to.
  if (SHELL_COMMANDS.has((cmd ?? "").trim())) return "none";
  // A normal-screen program with output above it: tmux keeps scrollback, so
  // copy-mode scroll is the right road.
  return "scroll";
}

export function tmuxDriver(socket?: string, log: (s: string) => void = console.log): TerminalDriver {
  const sockArgs = socket ? ["-L", socket] : [];
  return {
    name: "tmux",
    // resize() reflows the pane's window in place, so a rotation is a reflow, not
    // a respawn -- and either way the frames carry the pane's true size.
    canResize: true,
    paneMode: (paneId) => tmuxPaneMode(sockArgs, paneId),
    open(paneId, cols, rows, h) {
      const target = paneTargetOf(paneId);
      if (!target) {
        h.onClosed(`bad tmux pane id ${paneId}`);
        return { resize() {}, input() {}, scroll() {}, release() {} };
      }
      let released = false;
      let seq = 0;
      let lastPaint = "";
      let ticking = false;
      let lastCols = cols;
      let lastRows = rows;

      // Reflow the pane's window to the viewer, best effort. window-size manual
      // stops tmux from snapping the detached window back to a client's size.
      void (async () => {
        const { out } = await tmuxCall(sockArgs, ["display-message", "-p", "-t", target, "#{window_id}"]);
        const win = out.trim();
        if (!win) return;
        await tmuxCall(sockArgs, ["set-option", "-w", "-t", win, "window-size", "manual"]);
        await tmuxCall(sockArgs, ["resize-window", "-t", win, "-x", String(cols), "-y", String(rows)]);
      })();

      log(`[terminal] + ${paneId} (tmux) ${cols}x${rows}`);

      const tick = async () => {
        if (released || ticking) return;
        ticking = true;
        try {
          const dim = await tmuxCall(sockArgs, ["display-message", "-p", "-t", target, "#{pane_width}\t#{pane_height}"]);
          if (released) return;
          if (!dim.ok) { h.onClosed("pane gone"); return; }
          const [pw, ph] = dim.out.trim().split("\t");
          const w = Number(pw) || lastCols;
          const hgt = Number(ph) || lastRows;
          const cap = await tmuxCall(sockArgs, ["capture-pane", "-p", "-e", "-t", target]);
          if (released) return;
          if (!cap.ok) { h.onClosed("pane gone"); return; }
          // The screen, its trailing blank rows trimmed off the raw capture but
          // its geometry preserved by the reported cols/rows.
          const paint = cap.out.replace(/\n+$/, "");
          const sizeChanged = w !== lastCols || hgt !== lastRows;
          if (paint === lastPaint && !sizeChanged && seq > 0) return; // nothing new
          lastPaint = paint;
          lastCols = w;
          lastRows = hgt;
          // A repaint xterm.js can apply as-is: clear scrollback + screen, home,
          // then the rows. \r\n because capture-pane joins on \n alone and a
          // terminal needs the carriage return to return to column 0.
          const body = "\x1b[3J\x1b[2J\x1b[H" + paint.replace(/\n/g, "\r\n");
          h.onFrame({ full: true, seq: seq++, cols: w, rows: hgt, bytes: Buffer.from(body, "utf8").toString("base64") });
        } finally {
          ticking = false;
        }
      };

      const timer = setInterval(() => void tick(), TMUX_POLL_MS);
      void tick(); // first frame straight away

      return {
        resize(nextCols, nextRows) {
          void (async () => {
            const { out } = await tmuxCall(sockArgs, ["display-message", "-p", "-t", target, "#{window_id}"]);
            const win = out.trim();
            if (!win) return;
            await tmuxCall(sockArgs, ["resize-window", "-t", win, "-x", String(nextCols), "-y", String(nextRows)]);
          })();
        },
        input(msg) {
          if (released) return;
          if ("text" in msg) {
            void tmuxCall(sockArgs, ["send-keys", "-t", target, "-l", "--", msg.text]);
          } else {
            // Arbitrary bytes (Ctrl-C, arrows, a wheel burst) sent by hex value so
            // tmux delivers them verbatim rather than looking them up as key names.
            const bytes = Buffer.from(msg.bytes, "base64");
            const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
            void tmuxCall(sockArgs, ["send-keys", "-t", target, "-H", ...hex]);
          }
        },
        scroll(direction, lines) {
          // Only reached for a "scroll"-road pane (normal screen with scrollback).
          // Enter copy-mode if needed, then walk the viewport by `lines`.
          void (async () => {
            await tmuxCall(sockArgs, ["copy-mode", "-t", target]);
            const verb = direction === "up" ? "scroll-up" : "scroll-down";
            await tmuxCall(sockArgs, ["send-keys", "-t", target, "-X", "-N", String(lines), verb]);
          })();
        },
        release() {
          if (released) return;
          released = true;
          clearInterval(timer);
          log(`[terminal] - ${paneId} (tmux)`);
        },
      };
    },
  };
}

// ---------------------------------------------------------------- the hub

/* A viewer: one open terminal pane in one app tab. `key` is what decides
 * which viewers may SHARE a bridge process.
 */
/* WHETHER A VIEWER'S TRANSPORT IS STILL THERE, asked of whoever owns the
 * sockets (frames.ts). The hub deliberately does not know sockets, so the
 * no-viewer watchdog cannot decide liveness itself. `true` = live, `false` =
 * the transport is gone, `undefined` = cannot tell. Undefined is treated as
 * live: the watchdog must never close a terminal someone might still be
 * watching. */
export type ViewerLiveness = (v: Viewer) => boolean | undefined;

export type Viewer = {
  /* THE REAL HERDR PANE, e.g. `w9:p16`. This is what the bridge is spawned
   * against and what herdr resolves, so it MUST be the live pane, never the
   * app's session id. The two diverged on 2026-08-07 when a conversation became
   * its stable claude session id (a UUID) instead of the pane it sits on: the
   * app now opens a terminal by that UUID, and spawning `herdr ... control
   * <uuid>` finds no pane and the bridge exits, blank on every session (#355).
   * onTermOpen resolves the session's live pane into this field. */
  paneId: string;
  /* WHAT THE APP OPENED WITH, and what every frame going back to it is tagged
   * with (`id:`). The app keys its open terminals by the id it sent -- the
   * session id -- so a frame tagged with the raw herdr pane would be dropped.
   * Absent (older callers, the tests): the id is the pane, which is what it was
   * before the two diverged. */
  routeId?: string;
  device: string; // the app's clientId: one phone, one tablet
  cols: number;
  rows: number;
  send(msg: unknown): void;
};

type Bridge = {
  key: string;
  paneId: string;
  // The id every outbound frame carries; see Viewer.routeId.
  routeId: string;
  cols: number;
  rows: number;
  session: TerminalSession;
  viewers: Set<Viewer>;
  /* Which road this pane's gestures take, and when that was last asked. It
   * starts at "none" -- the road that sends nothing -- so a gesture that
   * arrives before herdr has answered cannot type into a shell. */
  mode: ScrollMode;
  modeAt: number;
  modeAsking: boolean;
};

/* How long a pane's answer is believed. A pane changes road when a program
 * starts or exits, so this is about being right within a second of that, not
 * about the gesture, which never waits for it. */
const MODE_TTL_MS = 1000;

/* ONE BRIDGE PER (SESSION, DEVICE, SIZE), refcounted over viewers.
 *
 * (session, device) is the rule from the plan. The size is in the key too, and
 * that is not a hedge: a bridge renders into ONE virtual terminal, so two
 * viewers of different sizes sharing one would mean at least one of them is
 * being sent a picture of the wrong shape. Two tabs on the same phone have the
 * same size and do share; a phone and a tablet never do.
 *
 * A JOINER RESTARTS THE BRIDGE, and this is the part worth explaining. herdr
 * sends `full:true` exactly once, as its first frame, and everything after it
 * is a delta against that. A viewer that joins an already-running bridge would
 * therefore be handed deltas against a screen it has never seen and would
 * render garbage. Rather than keep every delta since the last full frame in
 * memory forever so a joiner can be replayed (unbounded, and the buffer can
 * never be compacted without emulating a terminal), the bridge is simply
 * restarted: the new process opens with `full:true`, every viewer repaints
 * from it, and the cost is one full frame that the joiner needed anyway. The
 * old process is released by pid first, so nothing is leaked.
 */
export class TerminalHub {
  private readonly bridges = new Map<string, Bridge>();
  private readonly byViewer = new Map<Viewer, Bridge>();
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly driver: TerminalDriver,
    private readonly log: (s: string) => void = console.log,
    private readonly opts: { isViewerLive?: ViewerLiveness; watchdogMs?: number } = {},
  ) {
    /* THE NO-VIEWER WATCHDOG, the safety net for the half-open phone. Release
     * runs from close events (a ws close, an RTC pipe close, an explicit
     * term-close); a phone that locks or leaves wifi with neither a TCP FIN nor
     * an ICE close delivered fires none of them, and the bridge (and the attach
     * slot behind it) stays up. This periodic sweep closes any bridge every one
     * of whose viewers the liveness predicate calls dead. It only runs when a
     * predicate AND an interval are wired (production, via frames.ts); the tests
     * that construct a bare hub get no timer and drive sweepDeadViewers()
     * directly. */
    const ms = opts.watchdogMs ?? 0;
    if (opts.isViewerLive && ms > 0) {
      this.watchdog = setInterval(() => this.sweepDeadViewers(), ms);
      (this.watchdog as { unref?: () => void }).unref?.();
    }
  }

  /** How many bridge processes are alive. Tests assert this is 0 at the end. */
  get size(): number {
    return this.bridges.size;
  }

  /* One watchdog pass. A viewer is closed ONLY when the predicate says false
   * outright; true and undefined (cannot tell) both leave it, so a terminal is
   * never torn out from under a watcher we merely lost sight of. Closing the
   * last viewer of a bridge releases it through the ordinary refcount path,
   * which SIGTERM/grace/SIGKILLs the control child and frees the attach slot. */
  sweepDeadViewers(): void {
    const isLive = this.opts.isViewerLive;
    if (!isLive) return;
    for (const v of [...this.byViewer.keys()]) {
      let alive: boolean | undefined = true;
      try {
        alive = isLive(v);
      } catch {
        alive = undefined; // a throwing predicate is "cannot tell", so: live
      }
      if (alive === false) {
        this.log(`[terminal] watchdog closing dead viewer on ${v.paneId}`);
        this.close(v);
      }
    }
  }

  /** Stop the watchdog timer (nothing in production calls this; it keeps a test
   * or a shutdown from leaving an interval behind). */
  stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private keyOf(v: Viewer): string {
    return `${v.paneId}|${v.device}|${v.cols}x${v.rows}`;
  }

  open(v: Viewer) {
    // Re-opening what this viewer already has: treat it as a resize, which is
    // what a rotation or a reconnect actually is.
    const had = this.byViewer.get(v);
    if (had) {
      if (had.key === this.keyOf(v)) return;
      this.close(v);
    }

    const key = this.keyOf(v);
    const existing = this.bridges.get(key);
    if (existing) {
      existing.viewers.add(v);
      this.byViewer.set(v, existing);
      // The joiner missed the term-mode that went out when this bridge learned
      // it, and a viewer that never hears one cannot say why a swipe is doing
      // nothing.
      if (existing.modeAt) v.send({ t: "term-mode", id: existing.routeId, mode: existing.mode });
      // See the comment above: the joiner needs a `full:true`, so everyone gets
      // a fresh one from a fresh process.
      this.restart(existing);
      return;
    }

    const bridge: Bridge = {
      key,
      paneId: v.paneId,
      routeId: v.routeId ?? v.paneId,
      cols: v.cols,
      rows: v.rows,
      session: { resize() {}, input() {}, scroll() {}, release() {} },
      viewers: new Set([v]),
      mode: "none",
      modeAt: 0,
      modeAsking: false,
    };
    this.bridges.set(key, bridge);
    this.byViewer.set(v, bridge);
    bridge.session = this.spawn(bridge);
    // Ask straight away, so the first gesture already knows the road rather
    // than spending itself on "none".
    this.modeOf(bridge);
  }

  private spawn(b: Bridge): TerminalSession {
    return this.driver.open(b.paneId, b.cols, b.rows, {
      onFrame: (f) => this.fan(b, { t: "term-frame", id: b.routeId, full: f.full, seq: f.seq, cols: f.cols, rows: f.rows, bytes: f.bytes }),
      onSize: (cols, rows) => this.fan(b, { t: "term-size", id: b.routeId, cols, rows }),
      onClosed: (why) => {
        // The bridge died on its own (pane closed, herdr restarted, protocol
        // mismatch). Tell the viewers and drop the bridge; they decide whether
        // to ask again. Never respawned here: a pane that is gone would spin.
        if (this.bridges.get(b.key) !== b) return;
        this.bridges.delete(b.key);
        for (const v of b.viewers) this.byViewer.delete(v);
        this.fan(b, { t: "term-closed", id: b.routeId, why });
        this.log(`[terminal] x ${b.paneId} (${why})`);
      },
    });
  }

  private restart(b: Bridge) {
    b.session.release();
    b.session = this.spawn(b);
  }

  private fan(b: Bridge, msg: unknown) {
    for (const v of b.viewers) {
      try {
        v.send(msg);
      } catch {
        // socket gone; the close path removes it
      }
    }
  }

  /* The viewer measured itself again (rotation, a window drag on the laptop).
   * The size is part of the bridge key, so this is a move between keys: it may
   * be a plain resize of a bridge this viewer owns alone, or a hop onto
   * another bridge that already has the size asked for.
   */
  resize(v: Viewer, cols: number, rows: number) {
    const b = this.byViewer.get(v);
    if (!b) return;
    if (b.cols === cols && b.rows === rows) return;
    v.cols = cols;
    v.rows = rows;
    if (b.viewers.size === 1 && !this.bridges.has(this.keyOf(v))) {
      // Sole owner and nothing else wants this size: rekey in place. A driver
      // that can be resized is told; one that cannot (herdr's `observe`) gets
      // a fresh process at the new size, which also re-sends `full:true`,
      // which is what the viewer needs after a reflow anyway.
      this.bridges.delete(b.key);
      b.cols = cols;
      b.rows = rows;
      b.key = this.keyOf(v);
      this.bridges.set(b.key, b);
      if (this.driver.canResize) b.session.resize(cols, rows);
      else this.restart(b);
      return;
    }
    this.close(v);
    this.open(v);
  }

  /* Keys from one viewer, into the pane.
   *
   * Nothing is echoed back here and nothing is queued. The pane's own program
   * decides what a keystroke looks like on screen, and the picture of that
   * comes back the same way every other change does: as the next frame, to
   * EVERY viewer of the pane. So a phone and a laptop watching the same
   * session see each other type, which is right -- they are looking at one
   * terminal, not two copies of one.
   *
   * A viewer with no bridge (it closed, or the pane died) is dropped in
   * silence. There is no useful thing to say to a key pressed at a terminal
   * that is no longer there, and the viewer has already been told `term-closed`.
   */
  input(v: Viewer, msg: TerminalInput) {
    this.byViewer.get(v)?.session.input(msg);
  }

  /* A GESTURE, AND THE ENGINE PICKS THE ROAD.
   *
   * The app sends the same thing it always sent -- a direction and a number of
   * rows -- because the app cannot know which road is right: the answer comes
   * from herdr's view of the pane, and only this side can ask. So the decision
   * lives here, in one place, and the viewer is told which road it got
   * (`onMode`) so the log can say it rather than the app guessing.
   *
   * NOTHING BLOCKS ON THE ANSWER. The mode is cached per pane and refreshed in
   * the background; a gesture arriving before the first answer is sent the way
   * the pane was last known to want, and the very first one of all takes the
   * safe road, which is to send nothing until we know. Waiting on a herdr round
   * trip per notch is exactly the pacing that made this feel late.
   */
  scroll(v: Viewer, direction: ScrollDirection, lines: number) {
    const b = this.byViewer.get(v);
    if (!b) return;
    const mode = this.modeOf(b);
    if (mode === "scroll") b.session.scroll(direction, lines);
    else if (mode === "wheel") {
      const n = Math.min(WHEEL_MAX_NOTCHES, lines);
      b.session.input({ bytes: Buffer.from(wheelSeq(direction, n), "latin1").toString("base64") });
    }
    // "none": a prompt with nothing behind it. Sending anything here is how the
    // app would type escape sequences into his shell. See ScrollMode.
  }

  /* The cached answer, and the refresh that keeps it honest.
   *
   * A pane changes road when a program starts or stops (claude opens, claude
   * exits back to the shell), which is seconds apart, not milliseconds. So the
   * answer is remembered for MODE_TTL_MS and re-asked in the background when it
   * goes stale -- never on the path of the gesture itself. */
  private modeOf(b: Bridge): ScrollMode {
    const now = Date.now();
    if (now - b.modeAt >= MODE_TTL_MS && !b.modeAsking) {
      b.modeAsking = true;
      void this.driver
        .paneMode(b.paneId)
        .then((m) => {
          if (this.bridges.get(b.key) !== b) return;
          /* The FIRST answer is always news, even when it agrees with the
           * placeholder. `mode` starts at "none" because that is the road that
           * sends nothing, not because anyone measured it; a viewer that only
           * heard about changes would sit on "unknown" forever whenever the
           * pane really is a bare prompt -- which is exactly the case where it
           * has something to say. */
          const changed = m !== b.mode || b.modeAt === 0;
          b.mode = m;
          b.modeAt = Date.now();
          if (changed) {
            this.log(`[terminal] ~ ${b.paneId} scroll mode: ${m}`);
            this.fan(b, { t: "term-mode", id: b.routeId, mode: m });
          }
        })
        .catch(() => {})
        .finally(() => {
          b.modeAsking = false;
        });
    }
    return b.mode;
  }

  /** This viewer is done (back button, tab closed, socket dropped). */
  close(v: Viewer) {
    const b = this.byViewer.get(v);
    if (!b) return;
    this.byViewer.delete(v);
    b.viewers.delete(v);
    if (b.viewers.size > 0) return;
    this.bridges.delete(b.key);
    b.session.release();
  }

  /** Everything this socket had open. Called from the ws close handler, which
   * is the only guaranteed notice that a phone walked out of wifi range. */
  closeAll(pred: (v: Viewer) => boolean) {
    for (const v of [...this.byViewer.keys()]) if (pred(v)) this.close(v);
  }
}

/* THE TERMINAL DRIVER for the live terminal viewer, decided the same
 * way and from the same env as makeMux (mux.ts). The viewer's bridge is the one
 * place the engine drives the multiplexer OUTSIDE the five-verb Multiplexer
 * interface, so it needs its own factory: a tmux engine that built its agent
 * list through TmuxMux but spawned `herdr terminal session control` for the
 * viewer would draw a blank terminal on every pane.
 *
 * It lives HERE, not in mux.ts, because mux-adapter.ts needs it and mux.ts is
 * the module mux-adapter.ts's own importers pull in: `mux-adapter -> mux ->
 * tmux-adapter -> extends MuxAdapter` dereferenced MuxAdapter while
 * mux-adapter.ts was still evaluating (a TDZ throw under `bun test --parallel`).
 * terminal.ts imports nothing from mux.ts, so this home has no cycle at all. */
export function makeTerminalDriver(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): TerminalDriver {
  const which = (env.CYC_MUX ?? "tmux").trim().toLowerCase();
  if (which === "herdr") return herdrDriver();
  return tmuxDriver(env.CYC_TMUX_SOCKET?.trim() || undefined);
}
