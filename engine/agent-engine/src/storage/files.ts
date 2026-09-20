/* The file explorer's engine side: list a directory, read a file, ask git.
 *
 * The shape is terminal.ts's: a module that owns one capability, exports the
 * pure parts so a test can reach them without spawning anything, and leaves the
 * ws/HTTP wiring in server.ts. Nothing here knows what a panel looks like.
 *
 * THE ROOT IS THE SESSION'S CWD AND THAT IS THE WHOLE SECURITY MODEL.
 *
 * There is no folder picker, so there is exactly one directory a request may
 * name, and every path is relative to it. That makes the check a single
 * function -- inside() -- and it is written the way the `show` tool's was
 * written after clipOnDisk was fixed for this class of bug: RESOLVE
 * FIRST, then compare, and compare against the REAL path of both sides.
 *
 * Why realpath on both: `~/projects/x/../../../etc/passwd` is caught by any
 * normaliser, but `~/projects/x/link-to-etc/passwd` is not -- it normalises to
 * something that still looks like it is under the root, and only asking the
 * filesystem where it actually lands says otherwise. And the ROOT has to be
 * realpath'd too, because on this machine /Users is reached through /System's
 * firmlinks and a root that is itself a symlink would make every real path
 * under it fail the prefix test. So: realpath(root), realpath(target), prefix.
 *
 * A path that does not exist cannot be realpath'd, so the check falls back to
 * the deepest parent that does. That is not a hole: a file that does not exist
 * is refused a line later anyway, and the parent is what decides whether the
 * name could ever have been inside the root.
 *
 * NOTHING IS INTERPOLATED INTO A SHELL. Every git call is an argument array
 * through Bun.spawn, and the one place a path becomes an argument it is passed
 * after `--` so a file called `-n` is a file and not a flag.
 *
 * THE LIMITS ARE REAL AND THEY ARE HERE, not spread over the callers:
 *
 *   LIST_MAX          2000 entries per directory. node_modules has more than
 *                     that and a phone cannot draw them; the answer says
 *                     `truncated` and `total` so the app can say so too.
 *   CHILD_PROBES_MAX  1000 "does this folder have anything in it" probes per
 *                     listing. Past that the field is ABSENT rather than
 *                     guessed, and the app draws a chevron that may open onto
 *                     an empty folder -- which is the honest version.
 *   READ_MAX_BYTES    2 MB. Bigger is refused outright with the size, not
 *                     silently truncated: a file cut in half that does not say
 *                     so is the defect class this project keeps re-learning.
 *   READ_MAX_LINES    20000 lines. Longer IS truncated, and says so.
 *   GIT_TIMEOUT_MS    5 s per git call. A repo where status takes longer
 *                     answers `ok:false` with a reason and the tree still
 *                     draws -- without decoration, which is what "we do not
 *                     know" looks like.
 *   GIT_MAX_ENTRIES   20000 status lines. Past that the decoration is dropped
 *                     wholesale rather than half-applied.
 */

import type { Subprocess } from "bun";
import { readdir, lstat, stat, realpath, opendir } from "node:fs/promises";
import { join, dirname, resolve, relative, sep } from "node:path";

export const LIST_MAX = 2000;
export const CHILD_PROBES_MAX = 1000;
export const READ_MAX_BYTES = 2_000_000;
export const READ_MAX_LINES = 20_000;
export const RAW_MAX_BYTES = 10_000_000;
export const GIT_TIMEOUT_MS = 5_000;
export const GIT_MAX_ENTRIES = 20_000;

/* One row of a directory listing.
 *
 * `name` only. Size and date ride along because the FOOTER shows them for
 * whatever is selected -- his rule, and the reason the rows are single-line
 * with nothing but a name on them. A second fetch to fill a footer would make
 * moving the selection a network round trip.
 *
 * `children` is missing, not false, when nobody looked (see CHILD_PROBES_MAX).
 * `link` is a symlink we did not follow; opening one goes through the same
 * confinement check as anything else and is refused if it lands outside. */
export type FsEntry = {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
  children?: boolean;
  link?: boolean;
};

export type FsList =
  | { ok: true; path: string; entries: FsEntry[]; total: number; truncated: boolean }
  | { ok: false; error: string };

export type FsRead =
  | { ok: true; path: string; name: string; size: number; mtime: number; lines: number;
      text: string; truncated: boolean; kind: "text" }
  | { ok: true; path: string; name: string; size: number; mtime: number; kind: "image" | "binary" }
  | { ok: false; error: string };

/* The single letter a row wears, worst-first. The order IS the propagation
 * rule: a folder shows the worst thing inside it, and "worst" is this list read
 * left to right. Ignored is deliberately last and deliberately NOT propagated:
 * a folder is dim because it is itself ignored, never because something under
 * it was. */
export const GIT_SEVERITY = ["C", "D", "M", "A", "R", "U"] as const;
/** The codes that take part in the worst-wins ordering above. "I" does not. */
export type GitSeverity = (typeof GIT_SEVERITY)[number];
export type GitCode = GitSeverity | "I";

export type GitStatus =
  | { ok: true; repo: true; root: string; files: Record<string, GitCode>; truncated: boolean }
  | { ok: true; repo: false }
  | { ok: false; error: string };

export type DiffKind = "added" | "modified" | "deleted";
/* A gutter mark, in the coordinates of the file you are LOOKING at: `line` is
 * a line number in the working copy. A deletion has no line of its own, so it
 * is reported on the line it happened above, which is where VS Code draws its
 * wedge. */
export type DiffMark = { line: number; kind: DiffKind };

export type GitDiff =
  | { ok: true; repo: true; marks: DiffMark[]; added: number; modified: number; deleted: number }
  | { ok: true; repo: false }
  | { ok: false; error: string };

// ------------------------------------------------------------------ paths

/** realpath, or the deepest existing ancestor of a path that does not exist. */
async function realDeep(p: string): Promise<string> {
  let cur = resolve(p);
  const tail: string[] = [];
  // Bounded: a path is at most a few dozen segments, and a loop with no bound
  // would spin on a malformed one.
  for (let i = 0; i < 64; i++) {
    try {
      const real = await realpath(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return cur; // hit "/" and it still failed
      tail.push(cur.slice(parent.length + 1));
      cur = parent;
    }
  }
  return cur;
}

/** Is `real` the root itself or something under it? Both sides must already
 * be real paths; see the header for why the root is realpath'd too. */
export function inside(root: string, real: string): boolean {
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/* A request's `path` -> an absolute path we are willing to touch, or null.
 *
 * The wire sends a path RELATIVE to the root ("" is the root itself), because
 * a relative path cannot name anything outside without saying `..`, which is
 * a thing this can see. An absolute path is accepted too -- the app has one
 * for the breadcrumb -- and gets exactly the same treatment: it is resolved
 * and it has to land inside.
 */
export async function resolveInRoot(rootReal: string, wanted: string): Promise<string | null> {
  const abs = wanted.startsWith("/") ? wanted : join(rootReal, wanted);
  const real = await realDeep(abs);
  return inside(rootReal, real) ? real : null;
}

/** The session's cwd as a real path. Everything else is measured against it. */
export function rootOf(cwd: string): Promise<string> {
  return realpath(cwd).catch(() => resolve(cwd));
}

/** Path relative to the root, "/"-joined, "" for the root. What the app holds. */
export function relOf(rootReal: string, abs: string): string {
  const r = relative(rootReal, abs);
  return r === "" ? "" : r.split(sep).join("/");
}

// ------------------------------------------------------------------ listing

/* VS Code's explorer order, near enough to be unsurprising: folders first,
 * then files, each sorted case-insensitively with numbers compared as numbers
 * so `10-x.md` follows `9-x.md` rather than `1-x.md`. */
function byName(a: FsEntry, b: FsEntry): number {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  return a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });
}

/** Does this directory contain anything at all? One entry is enough to know. */
async function hasChildren(p: string): Promise<boolean | undefined> {
  try {
    const d = await opendir(p);
    const first = await d.read();
    await d.close();
    return first !== null;
  } catch {
    // unreadable (permissions): we do not know, so we do not say
    return undefined;
  }
}

export async function listDir(rootReal: string, wanted: string): Promise<FsList> {
  const abs = await resolveInRoot(rootReal, wanted);
  if (!abs) return { ok: false, error: "path is outside the session directory" };
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(abs);
  } catch {
    return { ok: false, error: "no such directory" };
  }
  if (!st.isDirectory()) return { ok: false, error: "not a directory" };

  let names: string[];
  try {
    names = await readdir(abs);
  } catch (e) {
    return { ok: false, error: `cannot read directory (${(e as NodeJS.ErrnoException).code ?? "error"})` };
  }

  const total = names.length;
  /* Sort BEFORE cutting, so "the first 2000" is the first 2000 of the order he
   * will see rather than of whatever readdir happened to return. Cheap: 50k
   * strings sort in a couple of milliseconds, and the alternative is a listing
   * that changes when the filesystem feels like it. */
  const rows: FsEntry[] = [];
  for (const name of names) {
    let ls: Awaited<ReturnType<typeof lstat>>;
    try {
      ls = await lstat(join(abs, name));
    } catch {
      continue; // vanished between readdir and lstat; it is not there to show
    }
    const link = ls.isSymbolicLink();
    let dir = ls.isDirectory();
    let size = ls.size;
    let mtime = ls.mtimeMs;
    if (link) {
      // follow ONLY to learn what it is; entering it still has to pass inside()
      try {
        const t = await stat(join(abs, name));
        dir = t.isDirectory();
        size = t.size;
        mtime = t.mtimeMs;
      } catch {
        dir = false; // dangling link: a row that exists and opens to nothing
      }
    }
    rows.push({ name, dir, size, mtime: Math.round(mtime), ...(link ? { link: true } : {}) });
  }
  rows.sort(byName);
  const truncated = rows.length > LIST_MAX;
  const entries = truncated ? rows.slice(0, LIST_MAX) : rows;

  let probes = 0;
  for (const e of entries) {
    if (!e.dir) continue;
    if (probes >= CHILD_PROBES_MAX) break;
    probes++;
    const has = await hasChildren(join(abs, e.name));
    if (has !== undefined) e.children = has;
  }

  return { ok: true, path: relOf(rootReal, abs), entries, total, truncated };
}

// ------------------------------------------------------------------ reading

const IMAGE_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  avif: "image/avif",
};

export function imageMimeOf(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return IMAGE_EXT[ext] ?? null;
}

/* Text or not, decided the way every editor decides it: a NUL byte in the
 * first few kilobytes. Deliberately not a guess from the extension -- a `.log`
 * can be a core dump and a `.ts` written by a broken tool can be UTF-16 -- and
 * deliberately not "try to decode and see", because a decoder that replaces
 * bad bytes with U+FFFD succeeds on everything. */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export async function readFile(rootReal: string, wanted: string): Promise<FsRead> {
  const abs = await resolveInRoot(rootReal, wanted);
  if (!abs) return { ok: false, error: "path is outside the session directory" };
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(abs);
  } catch {
    return { ok: false, error: "no such file" };
  }
  if (st.isDirectory()) return { ok: false, error: "that is a directory" };

  const path = relOf(rootReal, abs);
  const name = abs.split("/").pop() ?? abs;
  const base = { path, name, size: st.size, mtime: Math.round(st.mtimeMs) };

  const mime = imageMimeOf(name);
  if (mime) return { ok: true, ...base, kind: "image" };

  /* REFUSED, not truncated, and the number is in the message. A 200 MB file
   * cut to 2 MB and rendered as if that were the file is exactly the lie this
   * codebase keeps having to undo; a refusal that says "18.4 MB, cap 2 MB" is
   * something he can act on. */
  if (st.size > READ_MAX_BYTES) {
    return { ok: false, error: `file is ${fmtBytes(st.size)}, over the ${fmtBytes(READ_MAX_BYTES)} cap` };
  }

  const bytes = new Uint8Array(await Bun.file(abs).arrayBuffer());
  if (looksBinary(bytes)) return { ok: true, ...base, kind: "binary" };

  const all = new TextDecoder("utf-8").decode(bytes);
  const lines = all.length === 0 ? 0 : all.split("\n").length;
  /* LINE cap as well as a byte cap, because they catch different files: a
   * minified bundle is one line and small, a generated log is a million short
   * ones. This one truncates rather than refusing, because the head of a log
   * is useful and says so. */
  const truncated = lines > READ_MAX_LINES;
  const text = truncated ? all.split("\n").slice(0, READ_MAX_LINES).join("\n") : all;
  return { ok: true, ...base, kind: "text", lines, text, truncated };
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------- git

/* One git call. Argument array, never a shell, and never allowed to hang.
 *
 * `--no-optional-locks` so a status on his working repo cannot fight the
 * editor he has open on it for the index lock. The timeout kills the process
 * rather than waiting: a repo on a cold network mount can take minutes, and a
 * tree that never draws is worse than one drawn without decoration.
 *
 * NOTHING MAY ASK A QUESTION. `GIT_TERMINAL_PROMPT=0` and the two empty askpass
 * variables turn "please enter your password for https://..." from a process
 * that waits forever on a tty nobody is attached to into a non-zero exit with a
 * sentence in it. That matters most for push, which is the one call here that
 * touches a network, but it is set for every call because a repo can be
 * configured to authenticate on almost anything.
 *
 * `okExit` is the one concession to git's exit codes not all meaning failure:
 * `diff --no-index` exits 1 to say "these differ", which is the ANSWER, not an
 * error. Nothing else passes it.
 */
export async function runGit(cwd: string, args: string[],
  opts: { timeoutMs?: number; okExit?: number[] } = {}):
  Promise<{ ok: boolean; out: string; err: string; code: number }> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const okExit = opts.okExit ?? [0];
  /* Spelled with the stdio this call actually asks for. `ReturnType<typeof
   * Bun.spawn>` is the DEFAULT shape (stderr inherited, so `proc.stderr` is
   * undefined), which is why reading stderr below needed a cast to a stream the
   * declared type said was not there. */
  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["git", "--no-optional-locks", ...args], {
      cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
    });
  } catch (e) {
    return { ok: false, out: "", err: `could not run git: ${e instanceof Error ? e.message : String(e)}`, code: -1 };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // already gone
    }
  }, timeoutMs);
  try {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (timedOut) return { ok: false, out: "", err: `git timed out after ${timeoutMs}ms`, code: -1 };
    return { ok: okExit.includes(code), out, err: err.trim(), code };
  } finally {
    clearTimeout(timer);
  }
}

/* A porcelain XY pair -> the one letter a row wears.
 *
 * Both columns matter and the worse of the two wins: a file that is staged as
 * added and then edited is `AM`, and calling it "added" would hide that there
 * is unstaged work in it. Unmerged states (the ones with U on either side,
 * plus AA and DD) are conflicts and outrank everything. */
export function codeOf(xy: string): GitCode | null {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";
  if (xy === "??") return "U";
  if (xy === "!!") return "I";
  if (x === "U" || y === "U" || xy === "AA" || xy === "DD") return "C";
  /* GitSeverity, not GitCode: this maps a porcelain letter onto the ordered
   * list and never answers "I" (that case returned above). Saying GitCode made
   * the two indexOf calls below type errors, because GIT_SEVERITY has no "I"
   * in it to find. */
  const one = (c: string): GitSeverity | null =>
    c === "M" || c === "T" ? "M" : c === "A" ? "A" : c === "D" ? "D" : c === "R" || c === "C" ? "R" : null;
  const a = one(x);
  const b = one(y);
  if (!a) return b;
  if (!b) return a;
  return GIT_SEVERITY.indexOf(a) <= GIT_SEVERITY.indexOf(b) ? a : b;
}

/* `git status --porcelain -z` -> {path: code}, paths relative to the REPO, and
 * the caller re-bases them onto the session's root.
 *
 * -z is not a nicety: the default format quotes and escapes any path with a
 * space or a non-ASCII byte in it, so a plain line split would hand back
 * `"docs/my file.md"` with the quotes on and never match the row it belongs
 * to. With -z the paths are literal and NUL-separated.
 *
 * A rename is `R  new\0old\0`: two records for one line. The old name is
 * consumed and dropped -- it is not on screen anymore.
 */
export function parsePorcelain(out: string): { files: Record<string, GitCode>; truncated: boolean } {
  const files: Record<string, GitCode> = {};
  const parts = out.split("\0");
  let n = 0;
  let truncated = false;
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (n >= GIT_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    if (!path) continue;
    const code = codeOf(xy);
    if (xy[0] === "R" || xy[0] === "C") i++; // the source name follows; not shown
    if (!code) continue;
    files[path.replace(/\/$/, "")] = code;
    n++;
  }
  return { files, truncated };
}

/* Everything git knows about the tree under the session's root.
 *
 * `--untracked-files=normal` on purpose, NOT `all`: normal collapses a wholly
 * untracked directory to one record (`experiments/`) instead of listing every
 * file under it, which is both what the design draws (a folder marked U) and
 * what keeps a fresh clone of something large from producing 50k records.
 *
 * `--ignored` for the same trade in the other direction: it reports ignored
 * DIRECTORIES collapsed, so `node_modules/` is one record rather than 40000.
 */
export async function gitStatus(rootReal: string): Promise<GitStatus> {
  const top = await runGit(rootReal, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { ok: true, repo: false }; // not a repo: not an error
  const repoRoot = top.out.trim();
  const st = await runGit(rootReal, [
    "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignored",
  ]);
  if (!st.ok) return { ok: false, error: st.err || "git status failed" };
  const { files, truncated } = parsePorcelain(st.out);

  /* Porcelain paths are relative to the REPO top, and the session's cwd may be
   * a subdirectory of it (an agent started in agent-engine/src/ inside this repo).
   * Re-base onto the root and drop anything that falls outside it: a change in
   * a sibling directory is real, but there is no row here for it to decorate. */
  const prefixReal = await realpath(repoRoot).catch(() => repoRoot);
  const out: Record<string, GitCode> = {};
  for (const [p, c] of Object.entries(files)) {
    const abs = join(prefixReal, p);
    if (!inside(rootReal, abs)) continue;
    out[relOf(rootReal, abs)] = c;
  }
  return { ok: true, repo: true, root: relOf(rootReal, prefixReal) || ".", files: out, truncated };
}

/* @@ -a,b +c,d @@ -> the marks a gutter draws.
 *
 * Exported so the parse can be tested against real `git diff -U0` output
 * without a repo. The three cases are the three marks:
 *   b === 0   nothing was there: the new lines are ADDED
 *   d === 0   nothing is there now: a DELETED wedge on the line above
 *   both      the lines that are there now are MODIFIED
 */
export function parseHunks(diff: string): { marks: DiffMark[]; added: number; modified: number; deleted: number } {
  const marks: DiffMark[] = [];
  let added = 0, modified = 0, deleted = 0;
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  for (const line of diff.split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    if (newCount === 0) {
      // a pure deletion sits BETWEEN two lines; newStart is the line before it
      marks.push({ line: Math.max(1, newStart), kind: "deleted" });
      deleted += oldCount;
      continue;
    }
    const kind: DiffKind = oldCount === 0 ? "added" : "modified";
    for (let i = 0; i < newCount; i++) marks.push({ line: newStart + i, kind });
    if (kind === "added") added += newCount;
    else {
      modified += Math.min(oldCount, newCount);
      if (oldCount > newCount) deleted += oldCount - newCount;
      else if (newCount > oldCount) added += newCount - oldCount;
    }
  }
  return { marks, added, modified, deleted };
}

/* The gutter for ONE file, against HEAD.
 *
 * HEAD and not the index, because the gutter is answering "what have I changed
 * in this file", and a change that has been staged is still a change he made.
 * That also makes the footer's counts agree with what the row's M means.
 *
 * An untracked file has no HEAD side at all, so git diff says nothing about
 * it; every line of it is new, and saying so is cheaper and truer than
 * diffing against /dev/null.
 */
export async function gitDiff(rootReal: string, wanted: string): Promise<GitDiff> {
  const abs = await resolveInRoot(rootReal, wanted);
  if (!abs) return { ok: false, error: "path is outside the session directory" };
  const top = await runGit(rootReal, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { ok: true, repo: false };

  const tracked = await runGit(rootReal, ["ls-files", "--error-unmatch", "--", abs]);
  if (!tracked.ok) {
    const ignored = await runGit(rootReal, ["check-ignore", "-q", "--", abs]);
    if (ignored.ok) return { ok: true, repo: true, marks: [], added: 0, modified: 0, deleted: 0 };
    let n = 0;
    try {
      const text = await Bun.file(abs).text();
      n = text.length === 0 ? 0 : text.split("\n").length;
    } catch {
      n = 0;
    }
    const marks: DiffMark[] = [];
    for (let i = 1; i <= Math.min(n, READ_MAX_LINES); i++) marks.push({ line: i, kind: "added" });
    return { ok: true, repo: true, marks, added: n, modified: 0, deleted: 0 };
  }

  const d = await runGit(rootReal, ["diff", "HEAD", "-U0", "--no-color", "--", abs]);
  if (!d.ok) return { ok: false, error: d.err || "git diff failed" };
  return { ok: true, repo: true, ...parseHunks(d.out) };
}

// ----------------------------------------------------------------- git pane

/* THE GIT PANE'S ENGINE SIDE, and it is the first thing in this file that
 * WRITES. Everything above answers questions; stage, unstage, commit, amend
 * and push change the repository, so the rules are tighter and they are all
 * here rather than spread over the routes.
 *
 * WHAT IT WILL DO, AND WHAT IT REFUSES TO DO. In: the branch and how far it
 * has drifted from its remote, the staged and unstaged lists, one file's diff
 * either side of the index, whole-file stage and unstage, commit, amend, the
 * recent log, one commit's diff, and push to the tracked remote. Out, on
 * purpose and not as a gap: force push, hard reset, discard/checkout of
 * changes, branch create or switch, merge, rebase, stash drop. Every one of
 * those can destroy work irreversibly, from a phone, with one mis-hit tap and
 * no undo -- and the person holding the phone has a keyboard for them.
 *
 * PER-HUNK STAGING IS OUT, and that is a decision with an argument rather than
 * a corner that was cut. Staging a hunk means rebuilding a patch and handing it
 * to `git apply --cached`, and the patch is derived from a diff that was
 * rendered some seconds ago. Nothing holds the index still in between: the
 * agent whose session this is may write the same file while the pane is on
 * screen. `git add -- <path>` is idempotent against that -- it stages whatever
 * is there NOW, which is what the CLI does and what the row promises -- whereas
 * a hunk patch applied to a file that moved either fails or, worse, applies at
 * an offset. A wrong file staged is visible in the very next line of the pane;
 * a hunk staged from a stale rendering is not. So: whole file, both directions.
 *
 * THE BOUNDARY IS THE REPOSITORY, AND WRITES ARE STILL THE SESSION'S CWD.
 * A repo view cropped to a subdirectory would report "clean" while the repo is
 * dirty, which is the app asserting what it does not know, so the pane LISTS
 * the whole repository the session's cwd is in. But a row that is not under
 * that cwd is marked `outside` and every write refuses it, because the cwd is
 * the confinement this engine grants a session and a git pane is not a way
 * around it. Both checks are realpath-based (see inside()), so a symlink out of
 * the repo is refused for the same reason it is refused above.
 *
 * THE LIMITS:
 *   GIT_LOG_MAX          30 commits. A phone scrolls; a log does not need to.
 *   GIT_ROWS_MAX         2000 status rows per side. A repo mid-rebase with
 *                        thousands of touched files says `truncated` rather
 *                        than building 40000 DOM rows on a phone.
 *   GIT_PATCH_MAX_BYTES  2 MB of patch text, REFUSED with the size rather than
 *                        cut -- the same call readFile makes, for the same
 *                        reason: half a diff that does not say so is a lie.
 *   GIT_PATCH_MAX_LINES  5000 rendered lines, TRUNCATED and said. A 50 MB file
 *                        with one changed byte is a small diff; a 50 MB file
 *                        rewritten is not one anybody reads on a phone.
 *   GIT_WRITE_TIMEOUT_MS 20 s for stage/unstage.
 *   GIT_COMMIT_TIMEOUT_MS 120 s, because a commit runs the repo's own
 *                        pre-commit hooks and those are as slow as the repo
 *                        made them. --no-verify is deliberately NOT passed:
 *                        silently skipping a repo's checks is the app deciding
 *                        something it was not asked to decide.
 *   GIT_PUSH_TIMEOUT_MS  120 s, and it cannot prompt (see runGit).
 */

export const GIT_LOG_MAX = 30;
export const GIT_ROWS_MAX = 2_000;
export const GIT_PATCH_MAX_BYTES = 2_000_000;
export const GIT_PATCH_MAX_LINES = 5_000;
export const GIT_WRITE_TIMEOUT_MS = 20_000;
export const GIT_COMMIT_TIMEOUT_MS = 120_000;
export const GIT_PUSH_TIMEOUT_MS = 120_000;
/** Lines of context in a rendered diff. git's own default. */
export const GIT_CONTEXT = 3;

/* One file on one side of the index.
 *
 * `code` is the letter for THIS side only, which is what makes a file that is
 * staged as added and then edited appear twice -- once under Staged as A and
 * once under Changes as M -- rather than once under a letter that hides half
 * of what happened to it. That is what `git status` says and what VS Code
 * draws.
 */
export type GitRow = {
  path: string; // relative to the REPO top
  code: GitCode;
  from?: string; // a rename's source, repo-relative
  outside?: true; // in the repo, not under the session's cwd: read-only here
};

export type GitCommit = {
  sha: string;
  short: string;
  subject: string;
  author: string;
  when: number; // unix seconds, author time
  refs: string; // "HEAD -> main, origin/main", or ""
};

export type GitPaneState = {
  ok: true;
  repo: true;
  root: string; // the repo top, absolute
  name: string; // its last path segment, which is what the header says
  cwdInRepo: string; // the session's cwd relative to the repo top; "" when they are the same
  branch: string; // "" when HEAD is detached
  detached: string; // the short sha when it is, "" when it is not
  upstream: string; // "origin/main", or "" when the branch tracks nothing
  ahead: number;
  behind: number;
  staged: GitRow[];
  unstaged: GitRow[];
  truncated: boolean;
  log: GitCommit[];
  /* Why the log is empty, when it is. A repo with no commits yet is the
   * ordinary case and it is not an error, but a log that is empty because
   * `git log` failed must not look like one that is empty because nothing has
   * been committed. */
  logError: string;
  lastMessage: string; // HEAD's full message, so Amend can start from it
};

export type GitPane = GitPaneState | { ok: true; repo: false } | { ok: false; error: string };

export type PatchLineKind = "add" | "del" | "ctx" | "hunk" | "meta";

/** One rendered row of a diff. `o`/`n` are the old- and new-side line numbers,
 * 0 where that side has no line (an addition has no old number). */
export type PatchLine = { k: PatchLineKind; o: number; n: number; t: string };

export type GitPatch =
  | {
      ok: true;
      lines: PatchLine[];
      added: number;
      deleted: number;
      files: number;
      binary: boolean;
      truncated: boolean;
    }
  | { ok: false; error: string };

// ----------------------------------------------------------------- the repo

/** The repo top for a session's cwd, as a real path, or null when there is none. */
export async function repoTop(rootReal: string): Promise<string | null> {
  const top = await runGit(rootReal, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  const p = top.out.trim();
  if (!p) return null;
  return realpath(p).catch(() => p);
}

/* `git status --porcelain=v2 --branch -z` -> the two lists and the branch.
 *
 * v2 and not v1, and that is the whole reason this does not reuse
 * parsePorcelain above. v1 gives one letter pair per file and nothing else;
 * v2 gives the same pair PLUS the branch, its upstream and the ahead/behind
 * pair in the same call, so the header and the lists cannot disagree with each
 * other the way two separate calls a second apart can.
 *
 * The record kinds, all NUL-terminated:
 *   "# branch.head <name>"     "(detached)" when it is
 *   "# branch.oid <sha>"       "(initial)" before the first commit
 *   "# branch.upstream <name>" absent when the branch tracks nothing
 *   "# branch.ab +N -M"        absent when there is no upstream
 *   "1 XY ... <path>"          an ordinary change
 *   "2 XY ... <path>\0<orig>"  a rename or copy: the SOURCE is its own record
 *   "u XY ... <path>"          unmerged, i.e. a conflict
 *   "? <path>"                 untracked
 *   "! <path>"                 ignored -- dropped: this pane lists CHANGES
 */
export function parseStatusV2(out: string): {
  branch: string;
  oid: string;
  upstream: string;
  ahead: number;
  behind: number;
  staged: GitRow[];
  unstaged: GitRow[];
  truncated: boolean;
} {
  const parts = out.split("\0");
  const staged: GitRow[] = [];
  const unstaged: GitRow[] = [];
  let branch = "";
  let oid = "";
  let upstream = "";
  let ahead = 0;
  let behind = 0;
  let truncated = false;

  const push = (list: GitRow[], row: GitRow) => {
    if (list.length >= GIT_ROWS_MAX) {
      truncated = true;
      return;
    }
    list.push(row);
  };

  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec.startsWith("# ")) {
      const sp = rec.indexOf(" ", 2);
      const key = sp < 0 ? rec.slice(2) : rec.slice(2, sp);
      const val = sp < 0 ? "" : rec.slice(sp + 1);
      if (key === "branch.head") branch = val === "(detached)" ? "" : val;
      else if (key === "branch.oid") oid = val === "(initial)" ? "" : val;
      else if (key === "branch.upstream") upstream = val;
      else if (key === "branch.ab") {
        const m = /^\+(-?\d+) -(-?\d+)$/.exec(val);
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      }
      continue;
    }
    if (rec.startsWith("? ")) {
      push(unstaged, { path: rec.slice(2), code: "U" });
      continue;
    }
    if (rec.startsWith("! ")) continue; // ignored: not a change
    const kind = rec[0];
    if (kind !== "1" && kind !== "2" && kind !== "u") continue;
    const xy = rec.slice(2, 4);
    /* The path is everything after the Nth space, and it is taken by INDEX
     * rather than by splitting, because a path may contain spaces and -z means
     * it is not quoted. Ordinary and unmerged records differ in how many fixed
     * fields come first (8 against 10), and a rename has one more (the score)
     * than an ordinary one. */
    const fixed = kind === "u" ? 10 : kind === "2" ? 9 : 8;
    let at = 0;
    for (let k = 0; k < fixed; k++) {
      at = rec.indexOf(" ", at) + 1;
      if (at === 0) break;
    }
    if (at === 0) continue; // malformed: drop the record rather than guess a path
    const path = rec.slice(at);
    if (!path) continue;
    let from = "";
    if (kind === "2") {
      from = parts[i + 1] ?? "";
      i++; // the source name is its own record
    }
    if (kind === "u") {
      /* Both columns of a conflict say the same thing, and it is neither
       * staged nor unstaged: it is a thing you have to resolve. It goes in the
       * working list, which is where the person looking at the pane will act. */
      push(unstaged, { path, code: "C" });
      continue;
    }
    /* v2's X and Y are v1's X and Y, so the letter map above is reused rather
     * than rewritten. A "." means "nothing on this side". */
    const x = codeOf(`${xy[0] ?? "."}.`);
    const y = codeOf(`.${xy[1] ?? "."}`);
    if (x) push(staged, from ? { path, code: x, from } : { path, code: x });
    if (y) push(unstaged, from ? { path, code: y, from } : { path, code: y });
  }
  const byPath = (a: GitRow, b: GitRow) => a.path.localeCompare(b.path, "en", { numeric: true });
  staged.sort(byPath);
  unstaged.sort(byPath);
  return { branch, oid, upstream, ahead, behind, staged, unstaged, truncated };
}

/* `git log -z --format=...` -> commits. The separator is 0x1f (unit
 * separator), which cannot appear in a subject, an author name or a ref list,
 * so the split is exact rather than a guess at where a subject ends. */
const LOG_FMT = "%H%x1f%h%x1f%s%x1f%an%x1f%at%x1f%D";

export function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const rec of out.split("\0")) {
    if (!rec.trim()) continue;
    const f = rec.replace(/^\n+/, "").split("\x1f");
    if (f.length < 6) continue;
    const when = Number(f[4]);
    commits.push({
      sha: f[0], short: f[1], subject: f[2], author: f[3],
      when: Number.isFinite(when) ? when : 0,
      refs: f[5].trim(),
    });
  }
  return commits;
}

/** Everything the pane draws, in one answer. */
export async function gitPane(rootReal: string): Promise<GitPane> {
  const top = await repoTop(rootReal);
  if (!top) return { ok: true, repo: false };

  const st = await runGit(rootReal, [
    "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal",
  ]);
  if (!st.ok) return { ok: false, error: st.err || "git status failed" };
  const s = parseStatusV2(st.out);

  /* Which rows this session may write. Everything in the repo is LISTED --
   * cropping the list would make "clean" a lie -- and everything outside the
   * session's cwd is marked so the pane can draw it read-only and the write
   * routes can refuse it. When the cwd IS the repo top, which is the ordinary
   * case, nothing is marked and the loop does not run at all. */
  const cwdInRepo = relOf(top, rootReal);
  if (cwdInRepo) {
    const mark = (rows: GitRow[]) => {
      for (const r of rows) {
        if (!inside(rootReal, join(top, r.path))) r.outside = true;
      }
    };
    mark(s.staged);
    mark(s.unstaged);
  }

  const lg = await runGit(rootReal, ["log", "-z", `--format=${LOG_FMT}`, "-n", String(GIT_LOG_MAX)]);
  /* A repo with no commits is not a failure and must not be drawn as one, but
   * a `git log` that failed for any OTHER reason must not be drawn as a repo
   * with no commits either. `branch.oid` being empty is what tells them apart. */
  const logError = lg.ok ? "" : s.oid ? lg.err || "git log failed" : "";
  const log = lg.ok ? parseLog(lg.out) : [];

  /* HEAD's message, in full, so the Amend box can open with what is already
   * there instead of making him retype it. Empty before the first commit. */
  let lastMessage = "";
  if (s.oid) {
    const m = await runGit(rootReal, ["log", "-1", "--format=%B"]);
    if (m.ok) lastMessage = m.out.replace(/\n+$/, "");
  }

  return {
    ok: true, repo: true,
    root: top,
    name: top.split("/").pop() ?? top,
    cwdInRepo,
    branch: s.branch,
    detached: s.branch ? "" : s.oid.slice(0, 7),
    upstream: s.upstream,
    ahead: s.ahead, behind: s.behind,
    staged: s.staged, unstaged: s.unstaged,
    truncated: s.truncated,
    log, logError, lastMessage,
  };
}

// ------------------------------------------------------------------ the diff

/* A unified diff -> the rows a reader sees, each carrying the line numbers it
 * has on either side.
 *
 * The numbers are COUNTED from the hunk headers rather than taken from the
 * text, because the text does not have them: `git diff` writes
 * `@@ -12,7 +12,9 @@` once and then twenty lines with a single leading
 * character. So a hunk header resets both counters and every line after it
 * advances the sides it belongs to -- context both, an addition only the new
 * side, a deletion only the old.
 *
 * Anything that is not one of those four is META and is drawn as such: the
 * `diff --git` line, the mode lines, the `Binary files ... differ` line, and
 * `\ No newline at end of file`. Meta is not silently dropped -- "binary files
 * differ" is the ONLY thing the diff has to say about a PNG, and a reader
 * shown an empty panel instead would conclude nothing had changed.
 */
export function parsePatch(text: string, max = GIT_PATCH_MAX_LINES): {
  lines: PatchLine[]; added: number; deleted: number; files: number; binary: boolean; truncated: boolean;
} {
  const lines: PatchLine[] = [];
  let added = 0, deleted = 0, files = 0, binary = false, truncated = false;
  let o = 0, n = 0;
  const re = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const raw = text.split("\n");
  // a trailing newline is not a row
  if (raw.length && raw[raw.length - 1] === "") raw.pop();
  for (const t of raw) {
    if (lines.length >= max) {
      truncated = true;
      break;
    }
    if (t.startsWith("diff --git ")) {
      files++;
      o = 0; n = 0;
      lines.push({ k: "meta", o: 0, n: 0, t });
      continue;
    }
    const m = re.exec(t);
    if (m) {
      o = Number(m[1]);
      n = Number(m[2]);
      lines.push({ k: "hunk", o: 0, n: 0, t });
      continue;
    }
    if (t.startsWith("Binary files ") || t.startsWith("GIT binary patch")) {
      binary = true;
      lines.push({ k: "meta", o: 0, n: 0, t });
      continue;
    }
    /* Only INSIDE a hunk do +/- mean added and deleted. `+++ b/x` and `--- a/x`
     * are headers, and the counters being 0 is exactly the fact that says we
     * are not in a hunk yet. */
    if (!o && !n) {
      lines.push({ k: "meta", o: 0, n: 0, t });
      continue;
    }
    const c = t[0];
    if (c === "+") {
      lines.push({ k: "add", o: 0, n, t: t.slice(1) });
      n++; added++;
    } else if (c === "-") {
      lines.push({ k: "del", o, n: 0, t: t.slice(1) });
      o++; deleted++;
    } else if (c === " ") {
      lines.push({ k: "ctx", o, n, t: t.slice(1) });
      o++; n++;
    } else {
      // "\ No newline at end of file", and anything else git decides to say
      lines.push({ k: "meta", o: 0, n: 0, t });
    }
  }
  return { lines, added, deleted, files, binary, truncated };
}

/** Turn one git-diff answer into a patch, refusing rather than cutting when the
 * TEXT is too big -- the same call readFile makes and for the same reason. */
function toPatch(out: string): GitPatch {
  if (out.length > GIT_PATCH_MAX_BYTES) {
    return { ok: false, error: `the diff is ${fmtBytes(out.length)}, over the ${fmtBytes(GIT_PATCH_MAX_BYTES)} cap` };
  }
  return { ok: true, ...parsePatch(out) };
}

/* One file's diff, on ONE side of the index, which is the distinction the two
 * lists in the pane are made of.
 *
 * "staged"   what committing right now would record: the index against HEAD.
 * "unstaged" what committing right now would MISS: the working tree against
 *            the index.
 *
 * An untracked file has neither side -- git says nothing about it -- so it is
 * diffed against /dev/null with --no-index, which produces a real unified diff
 * of the real file rather than a synthesised one. That call exits 1 to mean
 * "they differ", which is the answer and not a failure; see runGit's okExit.
 */
export async function gitFilePatch(rootReal: string, wanted: string,
  side: "staged" | "unstaged"): Promise<GitPatch> {
  const top = await repoTop(rootReal);
  if (!top) return { ok: false, error: "not a git repository" };
  const abs = await resolveInRoot(top, wanted);
  if (!abs) return { ok: false, error: "path is outside the repository" };

  if (side === "unstaged") {
    const tracked = await runGit(rootReal, ["ls-files", "--error-unmatch", "--", abs]);
    if (!tracked.ok) {
      const d = await runGit(rootReal,
        ["diff", "--no-index", "--no-color", `-U${GIT_CONTEXT}`, "--", "/dev/null", abs],
        { okExit: [0, 1] });
      if (!d.ok) return { ok: false, error: d.err || "git diff failed" };
      return toPatch(d.out);
    }
    const d = await runGit(rootReal, ["diff", "--no-color", `-U${GIT_CONTEXT}`, "--", abs]);
    if (!d.ok) return { ok: false, error: d.err || "git diff failed" };
    return toPatch(d.out);
  }

  /* --cached against HEAD, except before the first commit, when there is no
   * HEAD to name. `--cached` alone falls back to the empty tree there, which
   * is what makes a brand new repo's staged list readable. */
  const head = await runGit(rootReal, ["rev-parse", "--verify", "-q", "HEAD"]);
  const args = ["diff", "--cached", "--no-color", `-U${GIT_CONTEXT}`];
  if (head.ok) args.push("HEAD");
  args.push("--", abs);
  const d = await runGit(rootReal, args);
  if (!d.ok) return { ok: false, error: d.err || "git diff failed" };
  return toPatch(d.out);
}

/** One commit's own diff, against its first parent -- which is what `git show`
 * does with a merge too, and the only reading of one that fits a column of
 * lines. */
export async function gitCommitPatch(rootReal: string, sha: string): Promise<GitPatch> {
  if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) return { ok: false, error: "that is not a commit id" };
  const top = await repoTop(rootReal);
  if (!top) return { ok: false, error: "not a git repository" };
  /* `sha^{commit}` refuses anything that is not a commit, so a blob id cannot
   * be shown as if it were one, and the trailing `--` ends the revision list so
   * a 40-hex FILE NAME cannot be read as a revision. */
  const d = await runGit(rootReal,
    ["show", "--no-color", `-U${GIT_CONTEXT}`, "--format=", `${sha}^{commit}`, "--"]);
  if (!d.ok) return { ok: false, error: d.err || "git show failed" };
  return toPatch(d.out);
}

// ------------------------------------------------------------ a whole change

/* ONE CHANGE, ALL OF ITS FILES, IN ONE ANSWER -- the multi-file diff.
 *
 * The routes above answer "this file, on this side" and "this commit, flat".
 * Neither is how a change is read: a change is several files, and reading it
 * means going through them without asking again between each one. So this
 * answers the whole thing at once -- the file list AND every file's diff,
 * already split by file -- and the app pays exactly one round trip for a screen
 * it can then navigate for free. That is the whole point: navigation between
 * files inside one change must not be a network operation.
 *
 * THREE SOURCES, and they are the three things "a change" means here:
 *   commit    `git show <sha>`, against its FIRST PARENT and said so out loud,
 *             because git's own default for a merge is the combined diff and
 *             that is not a reading a column of lines can carry.
 *   staged    what committing right now would record: the index against HEAD.
 *   unstaged  what committing right now would MISS: the working tree against
 *             the index, PLUS the untracked files, which git diff says nothing
 *             about and which are the ones most likely to be new work.
 *
 * A RANGE OR BRANCH COMPARE IS NOT HERE. It is one more argument shape on the
 * engine, but nothing on a phone can choose two refs today -- there is no
 * branch list and no ref picker in the app -- so the argument would be a
 * parameter no caller can produce. It goes in when there is something to pick
 * with.
 *
 * THE CAPS, and this is the part a phone lives or dies by. A single file's
 * diff has two limits already (2 MB of patch text refused, 5000 rendered lines
 * truncated); a change with four hundred files needs a different shape of
 * answer, because the failure is not one big file, it is a thousand small ones.
 *
 *   GIT_CHANGE_FILES_MAX      300 files in the list. Past that the LIST is cut
 *                             and says so; `fileCount` is still the true total.
 *   GIT_CHANGE_FILE_EDITS_MAX 1500 changed lines for one file to have its diff
 *                             fetched at all. One rewritten generated file must
 *                             not be able to hide the other forty.
 *   GIT_CHANGE_EDITS_MAX      6000 changed lines across the whole change. This
 *                             is spent in list order and it is what bounds the
 *                             work: files past it are LISTED, with their real
 *                             counts, and marked `skipped`.
 *   GIT_CHANGE_LINES_MAX      12000 rendered rows across the change, and
 *                             GIT_CHANGE_FILE_LINES_MAX 3000 for one file. The
 *                             edit budget does not bound context: 6000 edits
 *                             scattered over 2000 hunks carry 14000 lines of
 *                             context with them.
 *
 * AND THE BUDGET IS SPENT BEFORE THE PATCH IS ASKED FOR, not after. `--numstat`
 * gives every file's changed-line count for a few milliseconds and no memory,
 * so the files that fit are known BEFORE any diff text exists; the patch is
 * then asked for with those files as pathspecs. A 300 MB patch is never read
 * into this process and then thrown away -- it is never produced. That is the
 * difference between a cap and a refusal, and on a phone it is the difference
 * between a screen and a spinner.
 *
 * WHAT A SKIPPED FILE CARRIES. Its real added/deleted counts, because numstat
 * measured them, and no diff. The one exception is an untracked file past the
 * budget: nothing measured it, so its counts are zero and the app is told never
 * to print a zero. The totals below are over EVERY file in the list, skipped
 * ones included, so the header's "+430 -112" is the change's own arithmetic
 * rather than a sum of what happened to fit.
 */

export const GIT_CHANGE_FILES_MAX = 300;
export const GIT_CHANGE_EDITS_MAX = 6_000;
export const GIT_CHANGE_FILE_EDITS_MAX = 1_500;
export const GIT_CHANGE_LINES_MAX = 12_000;
export const GIT_CHANGE_FILE_LINES_MAX = 3_000;

export type ChangeWhat = "commit" | "staged" | "unstaged";

/** One file inside a change: what happened to it, and the rows of its diff. */
export type ChangeFile = {
  path: string; // repo-relative, the name it has NOW
  from?: string; // a rename's source
  code: GitCode;
  added: number;
  deleted: number;
  binary: boolean;
  lines: PatchLine[];
  truncated: boolean; // its diff was cut at GIT_CHANGE_FILE_LINES_MAX
  skipped: boolean; // no diff fetched: the change is over one of the caps
};

export type GitChange =
  | {
      ok: true;
      what: ChangeWhat;
      /* The commit this is, when it is one. Null for the working change: there
       * is nothing to name it but what was asked for. */
      commit: GitCommit | null;
      files: ChangeFile[];
      fileCount: number; // before GIT_CHANGE_FILES_MAX cut the list
      added: number;
      deleted: number;
      truncated: boolean; // the FILE LIST was cut
    }
  | { ok: false; error: string };

/* `--numstat -z` -> one row per file.
 *
 * The records are `<added>\t<deleted>\t<path>`, and a rename is the same three
 * fields with an EMPTY path followed by two more records, the old name and the
 * new one. A binary file has "-" for both counts, which is git saying it did
 * not count rather than that it counted zero.
 */
export function parseNumstat(out: string): Array<{
  path: string; from?: string; added: number; deleted: number; binary: boolean;
}> {
  const rows: Array<{ path: string; from?: string; added: number; deleted: number; binary: boolean }> = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const a = rec.indexOf("\t");
    if (a < 0) continue;
    const b = rec.indexOf("\t", a + 1);
    if (b < 0) continue;
    const added = rec.slice(0, a);
    const deleted = rec.slice(a + 1, b);
    let path = rec.slice(b + 1);
    let from: string | undefined;
    if (!path) {
      from = parts[i + 1] ?? "";
      path = parts[i + 2] ?? "";
      i += 2;
      if (!path) continue;
    }
    const binary = added === "-" || deleted === "-";
    rows.push({
      path, ...(from ? { from } : {}),
      added: binary ? 0 : Number(added) || 0,
      deleted: binary ? 0 : Number(deleted) || 0,
      binary,
    });
  }
  return rows;
}

/* `--name-status -z` -> the letter each file wears.
 *
 * numstat cannot say this: a file with 12 added and 0 deleted is a new file or
 * an appended one, and the difference is the whole reason the row is drawn
 * green or not. The records are the status ("M", "R100") and then the path, or
 * two paths for a rename. Same alphabet as everything else here, through
 * codeOf, so a letter means the same thing in the pane and in the change.
 */
export function parseNameStatus(out: string): Map<string, GitCode> {
  const out2 = new Map<string, GitCode>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const letter = rec[0];
    const renamed = letter === "R" || letter === "C";
    const path = renamed ? (parts[i + 2] ?? "") : (parts[i + 1] ?? "");
    i += renamed ? 2 : 1;
    if (!path) continue;
    const code = codeOf(`${letter}.`);
    if (code) out2.set(path, code);
  }
  return out2;
}

/** A pathspec that is a NAME, not a glob: a file called `v[1].ts` is that file
 * and not a character class. */
const literal = (p: string) => `:(literal)${p}`;

/** Split a parsed patch at its `diff --git` markers: one array of rows per
 * file, in the order git wrote them, which is the order numstat used. */
function splitByFile(lines: PatchLine[]): PatchLine[][] {
  const out: PatchLine[][] = [];
  let cur: PatchLine[] | null = null;
  for (const l of lines) {
    if (l.k === "meta" && l.t.startsWith("diff --git ")) {
      cur = [];
      out.push(cur);
      continue;
    }
    if (!cur) continue; // before the first marker there is nothing git said
    cur.push(l);
  }
  return out;
}

/* The header lines that only repeat what the file's own row already says.
 *
 * A change view draws a header per file with the path, the letter and the
 * counts on it, so `--- a/x`, `+++ b/x`, `index abc..def` and the rename pair
 * under it are the same fact a second time in a smaller font. Mode lines are
 * NOT in this list: a chmod is the entire content of some diffs, and dropping
 * it would leave a file that says nothing changed.
 */
const NOISE = ["index ", "--- ", "+++ ", "similarity index ", "dissimilarity index ",
  "rename from ", "rename to ", "copy from ", "copy to "];

const isNoise = (l: PatchLine) => l.k === "meta" && NOISE.some((p) => l.t.startsWith(p));

/** Everything one change is, in one answer. */
export async function gitChange(rootReal: string, what: ChangeWhat, sha: string): Promise<GitChange> {
  const top = await repoTop(rootReal);
  if (!top) return { ok: false, error: "not a git repository" };

  /* The base of every call below, so numstat, name-status and the patch are
   * three readings of ONE question and cannot disagree about which change they
   * are describing. */
  let base: string[];
  let commit: GitCommit | null = null;
  if (what === "commit") {
    if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) return { ok: false, error: "that is not a commit id" };
    /* `^{commit}` refuses a blob id, and `--` ends the revision list so a
     * 40-hex FILE NAME cannot be read as one. Both are gitCommitPatch's rules.
     *
     * `--diff-merges=first-parent` IS NOT OPTIONAL, and a merge is the whole
     * reason. Plain `git show` reads a merge as a COMBINED diff, which prints
     * only what differs from every parent at once -- so an ordinary merge shows
     * nothing at all. `--numstat` does not follow it there: it falls back to
     * the first parent and reports the files with their real counts. The two
     * then disagree, and this route believes both: it lists the files numstat
     * named, finds no patch section for any of them, and marks every one
     * "no diff, the change is too big". A two-line merge would come back as an
     * unreadable one. Naming the reading makes all three calls the same one. */
    base = ["show", "--no-color", "--format=", "--diff-merges=first-parent", `${sha}^{commit}`];
    const h = await runGit(rootReal, ["show", "-s", `--format=${LOG_FMT}`, `${sha}^{commit}`]);
    if (!h.ok) return { ok: false, error: h.err || "git show failed" };
    commit = parseLog(h.out)[0] ?? null;
    if (!commit) return { ok: false, error: "there is no such commit" };
  } else if (what === "staged") {
    const head = await runGit(rootReal, ["rev-parse", "--verify", "-q", "HEAD"]);
    base = head.ok ? ["diff", "--cached", "--no-color", "HEAD"] : ["diff", "--cached", "--no-color"];
  } else {
    base = ["diff", "--no-color"];
  }

  const core = await assembleFromBase(rootReal, top, base, what === "unstaged");
  if (!core.ok) return core;
  return {
    ok: true, what, commit, files: core.files, fileCount: core.fileCount,
    added: core.added, deleted: core.deleted, truncated: core.truncated,
  };
}

/* The file-and-diff CORE of a change, given the diff command that DEFINES it.
 *
 * `base` is the argv prefix -- `git show <sha>`, `git diff --cached HEAD`, or a
 * `git diff <range>` for a branch compare -- and every reading below (numstat,
 * name-status, the patch) is that same command with one more flag, so the three
 * cannot disagree about which change they describe. gitChange and gitCompare
 * both hand it a base and get back the same file list, the same caps and the
 * same skipped marks; the only thing that differs is what NAMES the change,
 * which the caller attaches.
 *
 * `includeUntracked` is only ever true for the working change: a commit and a
 * range have no untracked side, and a compare against another ref is not about
 * files git is not tracking yet.
 */
type ChangeCore =
  | { ok: true; files: ChangeFile[]; fileCount: number; added: number; deleted: number; truncated: boolean }
  | { ok: false; error: string };

async function assembleFromBase(rootReal: string, top: string, base: string[],
  includeUntracked: boolean): Promise<ChangeCore> {
  const ns = await runGit(rootReal, [...base, "--numstat", "-z", "--"]);
  if (!ns.ok) return { ok: false, error: ns.err || "git diff failed" };
  const st = await runGit(rootReal, [...base, "--name-status", "-z", "--"]);
  if (!st.ok) return { ok: false, error: st.err || "git diff failed" };
  const letters = parseNameStatus(st.out);

  const tracked: ChangeFile[] = parseNumstat(ns.out).map((r) => ({
    path: r.path,
    ...(r.from ? { from: r.from } : {}),
    code: letters.get(r.path) ?? "M",
    added: r.added, deleted: r.deleted, binary: r.binary,
    lines: [], truncated: false, skipped: false,
  }));

  /* THE WORKING CHANGE INCLUDES WHAT GIT DIFF CANNOT SEE. An untracked file is
   * not in `git diff` at all, and a review of "everything not staged" that
   * quietly left out the three files you just wrote would be the app answering
   * a different question from the one asked. `--untracked-files=all` rather
   * than `normal` on purpose: normal collapses a new directory to one record,
   * and a directory is not something a diff can be taken of. */
  const untracked: string[] = [];
  if (includeUntracked) {
    const s = await runGit(rootReal, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (!s.ok) return { ok: false, error: s.err || "git status failed" };
    for (const rec of s.out.split("\0")) {
      // v1 spells untracked "?? path"; v2's one-character "? path" is a
      // different format, and reading one as the other loses every new file
      if (rec.startsWith("?? ")) untracked.push(rec.slice(3));
    }
  }

  /* THE LIST IS SORTED FOR READING; THE ZIP BELOW IS NOT.
   *
   * The display order is one sorted list of everything, tracked and untracked
   * together, because a reader wants the files of a change in one order and
   * not in two runs. The PATCH, though, arrives in git's own order, and the
   * sections in it are matched to files by POSITION -- so the array that is
   * zipped has to stay in git's order. Sorting a second array of the same
   * objects is free (they are the same objects) and it is what keeps the two
   * facts apart. Getting this wrong is not a subtle bug: it hangs one file's
   * diff under another file's name. */
  const all = [...tracked, ...untracked.map((path): ChangeFile => ({
    path, code: "U", added: 0, deleted: 0, binary: false,
    lines: [], truncated: false, skipped: false,
  }))].sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true }));

  const fileCount = all.length;
  const truncated = fileCount > GIT_CHANGE_FILES_MAX;
  const files = truncated ? all.slice(0, GIT_CHANGE_FILES_MAX) : all;
  const listed = new Set(files);

  /* WHICH FILES GET A DIFF, decided from the counts alone -- before a byte of
   * patch text exists anywhere. A file over its own cap is skipped whatever the
   * budget, so one rewritten lockfile cannot be the reason the other forty
   * files have nothing to show. */
  const wanted: ChangeFile[] = [];
  let spend = 0;
  for (const f of tracked) {
    if (!listed.has(f)) continue; // cut from the list by GIT_CHANGE_FILES_MAX
    const edits = f.added + f.deleted;
    if (edits > GIT_CHANGE_FILE_EDITS_MAX || spend + edits > GIT_CHANGE_EDITS_MAX) {
      f.skipped = true;
      continue;
    }
    spend += edits;
    wanted.push(f);
  }

  if (wanted.length) {
    /* The pathspec is omitted when everything fits, which is the ordinary case
     * and saves a few hundred arguments. A rename needs BOTH names in it: with
     * only the new one git has nothing to detect the rename against and reports
     * an add and a delete instead. */
    const paths = wanted.length === tracked.length ? [] :
      wanted.flatMap((f) => (f.from ? [literal(f.from), literal(f.path)] : [literal(f.path)]));
    const d = await runGit(rootReal, [...base, `-U${GIT_CONTEXT}`, "--", ...paths]);
    if (!d.ok) return { ok: false, error: d.err || "git diff failed" };
    const parsed = parsePatch(d.out, GIT_CHANGE_LINES_MAX);
    const sections = splitByFile(parsed.lines);
    for (let i = 0; i < wanted.length; i++) {
      const rows = sections[i];
      /* No section: the whole-change line cap cut the patch short before this
       * file. Same answer as running out of budget, because it is the same
       * fact -- there is more change here than a phone can be handed. */
      if (!rows) {
        wanted[i].skipped = true;
        continue;
      }
      const kept = rows.filter((l) => !isNoise(l));
      wanted[i].truncated = kept.length > GIT_CHANGE_FILE_LINES_MAX;
      wanted[i].lines = wanted[i].truncated ? kept.slice(0, GIT_CHANGE_FILE_LINES_MAX) : kept;
    }
  }

  /* Untracked files, one call each, against /dev/null -- the same call
   * gitFilePatch makes for a single one, for the same reason: a real unified
   * diff of the real file, rather than one synthesised here that would differ
   * from what the single-file view shows. Run from the repo top with the
   * repo-relative name, so the rows name the file rather than this machine's
   * directory layout. They spend the same budget as everything else, so a
   * fresh clone with four hundred new files lists them and diffs as many as
   * fit.
   *
   * THE SIZE IS CHECKED BEFORE THE DIFF IS ASKED FOR, and that is not the same
   * caution as everywhere else here: `--no-index` against a 500 MB log would
   * write 500 MB of "+" lines into this process before any cap could look at
   * it. readFile's 2 MB is the same number for the same reason.
   *
   * The count comes from the hunk header rather than from counting rows,
   * because there is exactly one hunk -- `@@ -0,0 +1,N @@` -- and N is the
   * whole file. Counting rows would report the CAP for a file over it.
   */
  for (const f of files) {
    if (f.code !== "U") continue;
    const abs = await resolveInRoot(top, f.path);
    if (!abs || spend >= GIT_CHANGE_EDITS_MAX) {
      f.skipped = true;
      continue;
    }
    const size = await stat(abs).then((s) => s.size).catch(() => -1);
    if (size < 0 || size > READ_MAX_BYTES) {
      f.skipped = true;
      continue;
    }
    const d = await runGit(top,
      ["diff", "--no-index", "--no-color", `-U${GIT_CONTEXT}`, "--", "/dev/null", f.path],
      { okExit: [0, 1] });
    if (!d.ok) {
      f.skipped = true;
      continue;
    }
    const p = parsePatch(d.out, GIT_CHANGE_FILE_LINES_MAX + 1);
    const hunk = p.lines.find((l) => l.k === "hunk");
    const m = hunk ? /^@@ -\d+(?:,\d+)? \+\d+(?:,(\d+))? @@/.exec(hunk.t) : null;
    const n = m ? (m[1] === undefined ? 1 : Number(m[1])) : 0;
    f.added = n;
    f.binary = p.binary;
    spend += n;
    /* The per-file cap applies here too, and it can only be applied after the
     * fact: a tracked file's size is in numstat before anything is read, and an
     * untracked one's is not known until git has counted it. Doing the diff and
     * then dropping it is a few milliseconds; letting one new 40000-line file
     * through because it happened to be untracked would be the same cap meaning
     * two different things. */
    if (n > GIT_CHANGE_FILE_EDITS_MAX) {
      f.skipped = true;
      continue;
    }
    const kept = p.lines.filter((l) => !isNoise(l) && !l.t.startsWith("diff --git "));
    f.truncated = kept.length > GIT_CHANGE_FILE_LINES_MAX;
    f.lines = f.truncated ? kept.slice(0, GIT_CHANGE_FILE_LINES_MAX) : kept;
  }

  return {
    ok: true, files, fileCount,
    added: files.reduce((n, f) => n + f.added, 0),
    deleted: files.reduce((n, f) => n + f.deleted, 0),
    truncated,
  };
}

// ----------------------------------------------------- refs, branches, compare

/* A ref NAME the client is allowed to hand to git.
 *
 * runGit passes its args as an array, so no shell ever parses a ref and the
 * classic `$(...)`/`;` injections cannot land. What is left is the argument git
 * ITSELF reads specially, and those are refused here rather than trusted:
 *   - a leading "-" is an OPTION, so `--upload-pack=...` is not a branch;
 *   - ".." and "..." are RANGE syntax and would smuggle a second rev in;
 *   - "~", "^", ":", "@{", "?", "*", "[", "\", whitespace and control bytes
 *     are the revision-navigation and glob alphabet, none of which a plain
 *     branch name needs.
 * What is allowed is the ordinary branch/tag/remote alphabet -- letters,
 * digits, and `._/-` -- with a length cap so nothing unbounded reaches argv.
 * This is the clipOnDisk precedent: a name is validated, never interpolated.
 */
export const GIT_REF_MAX = 255;
export function validRef(ref: unknown): ref is string {
  if (typeof ref !== "string") return false;
  if (!ref || ref.length > GIT_REF_MAX) return false;
  if (ref.startsWith("-")) return false;
  if (ref.includes("..")) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  // git's own rules that the class above does not already catch
  if (ref.endsWith("/") || ref.endsWith(".") || ref.endsWith(".lock")) return false;
  if (ref.startsWith("/") || ref.includes("//")) return false;
  return true;
}

export type GitBranch = {
  name: string;
  current: boolean;
  upstream: string; // "origin/main", or "" when it tracks nothing
  ahead: number;
  behind: number;
};

export type GitBranches =
  | { ok: true; repo: true; branches: GitBranch[]; head: string; detached: string; defaultBranch: string }
  | { ok: true; repo: false }
  | { ok: false; error: string };

/* The default branch this repo forks from, for the two compares.
 *
 * `origin/HEAD` is what the remote calls its default and is the honest answer
 * when there is a remote; without one, the ordinary local names are tried in
 * order. Null when none of them exist, which a compare turns into a refusal
 * rather than a guess. Returned as a LOCAL ref name (no `origin/`), because the
 * compares are against the branch as this repo has it. */
async function defaultBranch(rootReal: string): Promise<string | null> {
  const sym = await runGit(rootReal, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (sym.ok) {
    const name = sym.out.trim().replace(/^origin\//, "");
    if (name) return name;
  }
  for (const cand of ["main", "master", "trunk", "develop"]) {
    const r = await runGit(rootReal, ["rev-parse", "--verify", "-q", `refs/heads/${cand}`]);
    if (r.ok) return cand;
  }
  return null;
}

/* Every LOCAL branch, the current one marked, with each one's drift from its
 * own upstream. Read-only: nothing here checks anything out. `for-each-ref` is
 * one call and its `%(...)` fields carry the upstream and the ahead/behind pair,
 * so the list cannot disagree with itself the way N `rev-list` calls would. */
export async function gitBranches(rootReal: string): Promise<GitBranches> {
  const top = await repoTop(rootReal);
  if (!top) return { ok: true, repo: false };

  const head = await runGit(rootReal, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const current = head.ok ? head.out.trim() : "";
  const detached = current ? "" : await runGit(rootReal, ["rev-parse", "--short", "HEAD"])
    .then((r) => (r.ok ? r.out.trim() : "")).catch(() => "");

  const US = "\x1f"; // unit separator: cannot appear in a ref name
  const fmt = ["%(refname:short)", "%(upstream:short)", "%(upstream:track,nobracket)"].join(US);
  const r = await runGit(rootReal, ["for-each-ref", "--sort=-committerdate", `--format=${fmt}`, "refs/heads"]);
  if (!r.ok) return { ok: false, error: r.err || "git for-each-ref failed" };

  const branches: GitBranch[] = [];
  for (const line of r.out.split("\n")) {
    if (!line.trim()) continue;
    const [name, upstream = "", track = ""] = line.split(US);
    if (!name) continue;
    const a = /ahead (\d+)/.exec(track);
    const b = /behind (\d+)/.exec(track);
    branches.push({
      name,
      current: name === current,
      upstream,
      ahead: a ? Number(a[1]) : 0,
      behind: b ? Number(b[1]) : 0,
    });
  }

  const def = await defaultBranch(rootReal);
  return { ok: true, repo: true, branches, head: current, detached, defaultBranch: def ?? "" };
}

/* The recent log of ANY ref, for when the pane is showing a branch other than
 * the one that is checked out. Same shape and cap as the pane's own log, so a
 * switched view reads identically to the live one. The ref is validated, never
 * interpolated, and `--` ends the revision list so a ref that is also a path is
 * still read as a ref. */
export type GitRefLog =
  | { ok: true; ref: string; log: GitCommit[] }
  | { ok: false; error: string };

export async function gitRefLog(rootReal: string, ref: string): Promise<GitRefLog> {
  if (!validRef(ref)) return { ok: false, error: "that is not a branch name" };
  const top = await repoTop(rootReal);
  if (!top) return { ok: false, error: "not a git repository" };
  const exists = await runGit(rootReal, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  if (!exists.ok) return { ok: false, error: `no such ref: ${ref}` };
  const lg = await runGit(rootReal, ["log", "-z", `--format=${LOG_FMT}`, "-n", String(GIT_LOG_MAX), ref, "--"]);
  if (!lg.ok) return { ok: false, error: lg.err || "git log failed" };
  return { ok: true, ref, log: parseLog(lg.out) };
}

/* A COMPARE: one ref against a base, as a commit list AND the aggregate file
 * diff, in one answer.
 *
 * Two readings, both against the DEFAULT branch this repo forks from:
 *   "mergebase"  what the branch added since it forked. The base is
 *                `git merge-base <ref> <default>` and the diff is `base..ref`,
 *                so main's own newer commits are not in it.
 *   "main"       the branch against the tip of the default branch, `default...ref`
 *                (three-dot: from the fork point on the ref's side), which is
 *                the reading a pull request shows.
 * The commit list matches each diff: `base..ref` for the merge-base compare,
 * and `default..ref` for the main compare (the commits on the ref not yet on
 * the default). Both refs are validated and both are ended with `--`.
 */
export type CompareAgainst = "mergebase" | "main";

export type GitCompare =
  | {
      ok: true;
      ref: string;
      against: CompareAgainst;
      base: string; // the ref the diff is taken FROM, resolved to a name or short sha
      commits: GitCommit[];
      files: ChangeFile[];
      fileCount: number;
      added: number;
      deleted: number;
      truncated: boolean;
    }
  | { ok: false; error: string };

export async function gitCompare(rootReal: string, ref: string, against: CompareAgainst): Promise<GitCompare> {
  if (!validRef(ref)) return { ok: false, error: "that is not a branch name" };
  if (against !== "mergebase" && against !== "main") {
    return { ok: false, error: "against must be mergebase or main" };
  }
  const top = await repoTop(rootReal);
  if (!top) return { ok: false, error: "not a git repository" };

  const refExists = await runGit(rootReal, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  if (!refExists.ok) return { ok: false, error: `no such ref: ${ref}` };

  const def = await defaultBranch(rootReal);
  if (!def) return { ok: false, error: "this repository has no default branch to compare against" };

  let base: string; // the rev the diff is taken from
  let range: string[]; // the two-rev argv for numstat/name-status/patch
  let logRange: string[]; // the argv for the commit list
  if (against === "mergebase") {
    const mb = await runGit(rootReal, ["merge-base", ref, def]);
    if (!mb.ok || !mb.out.trim()) {
      return { ok: false, error: `${ref} and ${def} share no history` };
    }
    base = mb.out.trim().slice(0, 12);
    range = [`${mb.out.trim()}..${ref}`];
    logRange = [`${mb.out.trim()}..${ref}`];
  } else {
    base = def;
    range = [`${def}...${ref}`];
    logRange = [`${def}..${ref}`];
  }

  const lg = await runGit(rootReal, ["log", "-z", `--format=${LOG_FMT}`, "-n", String(GIT_LOG_MAX), ...logRange, "--"]);
  if (!lg.ok) return { ok: false, error: lg.err || "git log failed" };
  const commits = parseLog(lg.out);

  const diffBase = ["diff", "--no-color", ...range];
  const core = await assembleFromBase(rootReal, top, diffBase, false);
  if (!core.ok) return core;

  return {
    ok: true, ref, against, base, commits,
    files: core.files, fileCount: core.fileCount,
    added: core.added, deleted: core.deleted, truncated: core.truncated,
  };
}

// ------------------------------------------------------------ NO WRITES HERE
//
// This pane is READ-ONLY (#368). Stage, unstage, commit and push used to live
// below this line; they were the only routes on this engine that changed a
// repository, and the phone does not need them -- the person holding it has a
// keyboard for a commit. What remains is the read plumbing above: the pane, a
// file or commit diff, a whole change, the branch list, any ref's log, and the
// two branch compares. The server refuses the old write paths with 405 so a
// bookmarked POST gets an answer rather than a 404 that reads like a typo.
