/* The git pane's engine side, against REAL repositories.
 *
 * Almost nothing here is asserted against a fixture. The repo is built with
 * git, put into the states the pane exists to show -- staged, unstaged, added,
 * deleted, renamed, conflicted, untracked -- and then what gitPane() says is
 * compared with what `git status --porcelain` and `git diff` say about the same
 * repo at the same moment. A fixture would be a copy of whatever the parser
 * happened to produce on the day it was written, and would then be "fixed" by
 * copying whatever it produced on the day it broke.
 *
 * The two places a fixture IS right are parseStatusV2 and parsePatch on literal
 * git output: the shapes that break them (a rename's two records, a path with a
 * space, a hunk header with no comma, a binary file's one-line diff) are one
 * line each here and a whole repo state there.
 *
 * READ-ONLY (#368). The pane no longer writes: stage/unstage/commit/push are
 * gone, and one test asserts the module exports no way to change a repository.
 * The branch list, any ref's log and the two compares (vs merge-base, vs the
 * default branch's tip) are tested against a repo built with two diverged
 * branches, and a hostile ref name is refused everywhere it can reach git.
 *
 *   bun test agent-engine/src/terminal/gitpane.test.ts
 */

import { test, expect, beforeAll } from "bun:test";
import { mkdir, writeFile, rm, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  rootOf, runGit, gitPane, gitFilePatch, gitCommitPatch, gitChange,
  gitBranches, gitRefLog, gitCompare, validRef,
  parseStatusV2, parsePatch, parseLog, parseNumstat, parseNameStatus, repoTop,
  GIT_PATCH_MAX_LINES, GIT_CHANGE_FILE_EDITS_MAX, GIT_REF_MAX, type GitPaneState,
} from "../storage/files.ts";
import { tmpDir } from "../test-utils/tmp.ts";

let dir = "";
let root = "";
let bare = "";

/* MODULE SCOPE ON PURPOSE. tmp.ts registers its cleanup with afterAll the first
 * time it is called, and bun runs a hook registered from INSIDE a running hook
 * as soon as that hook returns: a first tmpDir() from within beforeAll would
 * delete every repo below before the first test ran. Everything else here is a
 * subdirectory of this one, so the whole file cleans up in one rm. */
const scratch = tmpDir("cyc-gitpane-");

/** A fresh directory under the file's scratch, made once per name. */
async function at(name: string): Promise<string> {
  const p = join(dir, name);
  await mkdir(p, { recursive: true });
  return rootOf(p);
}

/** git, run here rather than through the module under test: the point of the
 * comparisons below is that two different things agree. */
async function git(at: string, args: string[]): Promise<string> {
  const r = await runGit(at, args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.err}`);
  return r.out;
}

/** gitPane, narrowed. Every test here runs against a repo, so a pane that is
 * not one is a broken rig rather than a case to handle. */
async function pane(at = root): Promise<GitPaneState> {
  const p = await gitPane(at);
  expect(p.ok, `gitPane failed: ${p.ok ? "" : p.error}`).toBe(true);
  expect((p as { repo: boolean }).repo, "the fixture is not a repo").toBe(true);
  return p as GitPaneState;
}

beforeAll(async () => {
  // realpath'd for the reason files.test.ts gives: /var is a symlink on macOS
  dir = await realpath(await scratch);
  root = join(dir, "work");
  bare = join(dir, "remote.git");
  await mkdir(root);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "deep", "nested"), { recursive: true });

  await runGit(root, ["init", "-q", "-b", "main"]);
  await runGit(root, ["config", "user.email", "t@t"]);
  await runGit(root, ["config", "user.name", "Tester"]);
  await runGit(root, ["config", "commit.gpgsign", "false"]);

  await writeFile(join(root, "README.md"), "# title\nline two\nline three\n");
  await writeFile(join(root, "src", "keep.ts"), "one\ntwo\nthree\nfour\nfive\nsix\n");
  await writeFile(join(root, "src", "goes.ts"), "delete me\n");
  await writeFile(join(root, "src", "moves.ts"), "rename me\n");
  await writeFile(join(root, "with space.txt"), "spaces in the name\n");
  await writeFile(join(root, "deep", "nested", "far.ts"), "far away\n");
  await runGit(root, ["add", "-A"]);
  await runGit(root, ["commit", "-qm", "first commit"]);
  await writeFile(join(root, "README.md"), "# title\nline TWO\nline three\nline four\n");
  await runGit(root, ["commit", "-aqm", "second commit"]);

  /* The five states the pane has to draw at once, made with git so the
   * comparison below is against something real:
   *   MODIFIED+STAGED   src/keep.ts, edited, added, then edited again -> two rows
   *   DELETED           src/goes.ts, staged as a deletion
   *   RENAMED           src/moves.ts -> src/moved.ts, staged
   *   UNTRACKED         fresh.txt
   *   MODIFIED ONLY     README.md, edited and not staged
   */
  await writeFile(join(root, "src", "keep.ts"), "ONE\ntwo\nthree\nfour\nfive\nsix\n");
  await unlink(join(root, "src", "goes.ts"));
  await rename(join(root, "src", "moves.ts"), join(root, "src", "moved.ts"));
  await runGit(root, ["add", "-A", "--", join(root, "src")]);
  /* The SECOND edit comes after the staging, and the order is the test: a file
   * that is staged and then edited again has to appear in both lists, and any
   * `git add` between the two would quietly collapse that into one row. */
  await writeFile(join(root, "src", "keep.ts"), "ONE\ntwo\nthree\nfour\nFIVE\nsix\n");
  await writeFile(join(root, "fresh.txt"), "brand new\nsecond line\n");
  await writeFile(join(root, "README.md"), "# title\nline TWO\nline three\nline FOUR\n");

  // a real remote to push to, so the push test is a push and not a mock
  await runGit(dir, ["init", "-q", "--bare", bare]);
  await runGit(root, ["remote", "add", "origin", bare]);
  await runGit(root, ["push", "-q", "-u", "origin", "main"]);
});

// ------------------------------------------------------------- the two lists

test("the pane's two lists are exactly what git status says, both columns", async () => {
  const p = await pane();

  /* THE COMPARISON, and it is against git rather than against a list written
   * here: porcelain v1 -z gives one XY pair per path, so the X column is the
   * staged side and the Y column is the unstaged one, and every path with a
   * non-space in a column must appear in that list and only that list. */
  const raw = await git(root, ["status", "--porcelain", "-z", "-uall"]);
  const wantStaged = new Set<string>();
  const wantUnstaged = new Set<string>();
  const recs = raw.split("\0").filter(Boolean);
  for (let i = 0; i < recs.length; i++) {
    const xy = recs[i].slice(0, 2);
    const path = recs[i].slice(3);
    if (xy[0] === "R" || xy[0] === "C") i++; // the source name is its own record
    if (xy === "??") {
      wantUnstaged.add(path);
      continue;
    }
    if (xy[0] !== " " && xy[0] !== "?") wantStaged.add(path);
    if (xy[1] !== " " && xy[1] !== "?") wantUnstaged.add(path);
  }

  expect([...p.staged.map((r) => r.path)].sort()).toEqual([...wantStaged].sort());
  expect([...p.unstaged.map((r) => r.path)].sort()).toEqual([...wantUnstaged].sort());
  expect(wantStaged.size, "the fixture staged nothing, so this proves nothing").toBeGreaterThan(2);
});

test("a file staged and then edited again is in BOTH lists, with its own letter", async () => {
  const p = await pane();
  const staged = p.staged.find((r) => r.path === "src/keep.ts");
  const unstaged = p.unstaged.find((r) => r.path === "src/keep.ts");
  expect(staged?.code, "the staged edit vanished").toBe("M");
  expect(unstaged?.code, "the later edit vanished").toBe("M");
});

test("a deletion is staged as D and a rename carries where it came from", async () => {
  const p = await pane();
  expect(p.staged.find((r) => r.path === "src/goes.ts")?.code).toBe("D");
  const moved = p.staged.find((r) => r.path === "src/moved.ts");
  expect(moved?.code, "a rename should read as R").toBe("R");
  expect(moved?.from, "a rename must say what it used to be called").toBe("src/moves.ts");
});

test("an untracked file is U and unstaged, and nothing else claims it", async () => {
  const p = await pane();
  expect(p.unstaged.find((r) => r.path === "fresh.txt")?.code).toBe("U");
  expect(p.staged.some((r) => r.path === "fresh.txt")).toBe(false);
});

test("the header names the repository, not the session's corner of it", async () => {
  const p = await pane();
  const top = await repoTop(root);
  expect(top, "the fixture is not inside a git repository at all").not.toBeNull();
  expect(p.root).toBe(top!);
  expect(p.name, "the header shows the repo's own last segment").toBe("work");
  expect(p.cwdInRepo, "the session cwd IS the repo top here").toBe("");
  expect(p.staged.every((r) => !r.outside)).toBe(true);
  expect(p.unstaged.every((r) => !r.outside)).toBe(true);
});

/* THE PANE FROM A SUBDIRECTORY. A repo view cropped to the cwd would report
 * "clean" while the repo is dirty, which is the app asserting what it does not
 * know. So the WHOLE repository is listed, and a row that is not under the
 * session's cwd is marked `outside` so it can be drawn read-only. */
test("a session below the repo top still lists the whole repo, marking what is not its own", async () => {
  const sub = await rootOf(join(root, "src"));
  const p = await pane(sub);
  expect(p.cwdInRepo).toBe("src");
  const top = await repoTop(root);
  expect(top, "the fixture is not inside a git repository at all").not.toBeNull();
  expect(p.root, "the boundary is the repository, wherever the session started").toBe(top!);

  const keep = p.staged.find((r) => r.path === "src/keep.ts")!;
  expect(keep, "a row under the cwd vanished").toBeTruthy();
  expect(keep.outside, "a row under the session cwd is writable, not outside").toBeUndefined();

  const readme = p.unstaged.find((r) => r.path === "README.md")!;
  expect(readme, "a change above the cwd was cropped out of the list").toBeTruthy();
  expect(readme.outside, "a row above the session cwd must be marked read-only").toBe(true);
  // the paths stay REPO-relative on both sides, so one address means one thing
  expect(p.staged.concat(p.unstaged).every((r) => !r.path.startsWith("/"))).toBe(true);
});

test("repoTop is the same answer from the top and from a subdirectory", async () => {
  const top = await repoTop(root);
  expect(top).toBe(root);
  expect(await repoTop(join(root, "deep", "nested"))).toBe(top);
});

test("branch, upstream and ahead/behind agree with git's own answer", async () => {
  const p = await pane();
  expect(p.branch).toBe((await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim());
  expect(p.upstream).toBe(
    (await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).trim());
  // pushed a moment ago, so level with the remote
  expect([p.ahead, p.behind]).toEqual([0, 0]);
  expect(p.detached, "not detached here").toBe("");
});

test("the log is the log, newest first, with the message Amend would start from", async () => {
  const p = await pane();
  expect(p.logError).toBe("");
  const subjects = (await git(root, ["log", "--format=%s"])).trim().split("\n");
  expect(p.log.map((c) => c.subject)).toEqual(subjects);
  expect(p.log[0].short).toBe((await git(root, ["rev-parse", "--short", "HEAD"])).trim());
  expect(p.log[0].author).toBe("Tester");
  expect(p.lastMessage).toBe("second commit");
});

// ------------------------------------------------------------------- diffs

test("a file's unstaged diff is the diff git prints for that file", async () => {
  const r = await gitFilePatch(root, "README.md", "unstaged");
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
  if (!r.ok) return;
  const real = await git(root, ["diff", "--no-color", "-U3", "--", "README.md"]);
  /* Rebuilt from the parse and compared to git's own text: every line has to
   * come back with the character that made it, in order, or the parse dropped
   * or invented something. */
  const rebuilt = r.lines.map((l) =>
    l.k === "add" ? `+${l.t}` : l.k === "del" ? `-${l.t}` : l.k === "ctx" ? ` ${l.t}` : l.t).join("\n");
  expect(rebuilt).toBe(real.replace(/\n$/, ""));
  expect(r.added).toBe(1);
  expect(r.deleted).toBe(1);
});

test("the staged and unstaged sides of one file are different diffs", async () => {
  const s = await gitFilePatch(root, "src/keep.ts", "staged");
  const u = await gitFilePatch(root, "src/keep.ts", "unstaged");
  expect(s.ok && u.ok).toBe(true);
  if (!s.ok || !u.ok) return;
  // the first edit is what is staged; the second is what is not
  expect(s.lines.some((l) => l.k === "add" && l.t === "ONE")).toBe(true);
  expect(s.lines.some((l) => l.k === "add" && l.t === "FIVE")).toBe(false);
  expect(u.lines.some((l) => l.k === "add" && l.t === "FIVE")).toBe(true);
  expect(u.lines.some((l) => l.k === "add" && l.t === "ONE")).toBe(false);
});

test("an untracked file's diff is the whole file, added", async () => {
  const r = await gitFilePatch(root, "fresh.txt", "unstaged");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.added).toBe(2);
  expect(r.deleted).toBe(0);
  expect(r.lines.filter((l) => l.k === "add").map((l) => l.t)).toEqual(["brand new", "second line"]);
});

test("line numbers count up the sides they belong to", async () => {
  const r = await gitFilePatch(root, "README.md", "unstaged");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  for (const l of r.lines) {
    if (l.k === "add") expect(l.o, "an added line has no old number").toBe(0);
    if (l.k === "del") expect(l.n, "a deleted line has no new number").toBe(0);
    if (l.k === "ctx") expect(l.o > 0 && l.n > 0, "context is on both sides").toBe(true);
  }
  const ctx = r.lines.filter((l) => l.k === "ctx");
  expect(ctx.length).toBeGreaterThan(0);
  // strictly increasing on each side, which is the only thing a gutter needs
  for (let i = 1; i < ctx.length; i++) expect(ctx[i].n).toBeGreaterThan(ctx[i - 1].n);
});

test("a commit's diff is what git show prints for it", async () => {
  const sha = (await git(root, ["rev-parse", "HEAD"])).trim();
  const r = await gitCommitPatch(root, sha);
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
  if (!r.ok) return;
  expect(r.files).toBe(1);
  expect(r.lines.some((l) => l.k === "add" && l.t === "line TWO")).toBe(true);
  expect(r.lines.some((l) => l.k === "del" && l.t === "line two")).toBe(true);
});

test("a commit id that is not one is refused, and so is a blob", async () => {
  expect((await gitCommitPatch(root, "not-a-sha")).ok).toBe(false);
  expect((await gitCommitPatch(root, "; rm -rf /")).ok).toBe(false);
  const blob = (await git(root, ["rev-parse", "HEAD:README.md"])).trim();
  const r = await gitCommitPatch(root, blob);
  expect(r.ok, "a blob id must not be shown as a commit").toBe(false);
});

test("a diff for a path outside the repository is refused", async () => {
  expect((await gitFilePatch(root, "../secret.txt", "unstaged")).ok).toBe(false);
  expect((await gitFilePatch(root, "/etc/passwd", "unstaged")).ok).toBe(false);
  const r = await gitFilePatch(root, "../../etc/passwd", "staged");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("outside the repository");
});

test("a diff asked for outside a repository says so rather than running git somewhere else", async () => {
  const plain = await at("nodiff");
  const r = await gitFilePatch(plain, "x.txt", "unstaged");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("not a git repository");
});

test("a file with no changes on a side is an empty patch, not a failure", async () => {
  /* The pane asks for both sides of whatever row was tapped. The staged side of
   * a file that is only edited in the working tree has nothing in it, and an
   * error there would put a red box under a row that is perfectly fine. */
  const r = await gitFilePatch(root, "README.md", "staged");
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
  if (!r.ok) return;
  expect(r.lines).toEqual([]);
  expect([r.added, r.deleted, r.files]).toEqual([0, 0, 0]);
});

test("a diff of a path under a subdirectory is found from the repo top", async () => {
  /* The path is resolved against the REPO, not the session cwd, because the
   * rows the pane hands back are repo-relative. */
  const r = await gitFilePatch(root, "src/keep.ts", "staged");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.lines.some((l) => l.k === "add" && l.t === "ONE")).toBe(true);
});

// ------------------------------------------------------------ whole changes

/* THE MULTI-FILE DIFF. Same rule as everything above: what gitChange() says a
 * change contains is compared with what `git diff --numstat` and `git status`
 * say about the same repository at the same moment, so a parser that started
 * dropping a file, or claiming one, is caught by git rather than by a fixture
 * written on a good day. */

test("the staged change is every staged file, with git's own counts", async () => {
  const r = await gitChange(root, "staged", "");
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
  if (!r.ok) return;

  const want = new Map<string, [number, number]>();
  for (const rec of (await git(root, ["diff", "--cached", "HEAD", "--numstat", "-z"])).split("\0")) {
    if (!rec) continue;
    const f = rec.split("\t");
    if (f.length < 3) continue;
    if (f[2]) want.set(f[2], [Number(f[0]), Number(f[1])]);
  }
  // the rename's record has an empty path and its two names follow it
  const moved = r.files.find((f) => f.path === "src/moved.ts");
  expect(moved?.from, "the rename lost where it came from").toBe("src/moves.ts");
  expect(moved?.code).toBe("R");

  for (const [path, [a, d]] of want) {
    const got = r.files.find((f) => f.path === path);
    expect(got, `${path} is staged and the change did not list it`).toBeTruthy();
    expect([got!.added, got!.deleted], `${path}'s counts are not git's`).toEqual([a, d]);
  }
  expect(r.files.find((f) => f.path === "src/goes.ts")?.code, "a staged deletion").toBe("D");
  expect(r.fileCount).toBe(r.files.length);
  expect(r.truncated).toBe(false);
  expect(r.commit, "the working change is not a commit").toBe(null);
});

test("every file in a change carries its OWN diff, not one flat patch", async () => {
  const r = await gitChange(root, "staged", "");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const keep = r.files.find((f) => f.path === "src/keep.ts")!;
  const goes = r.files.find((f) => f.path === "src/goes.ts")!;
  /* The point of the whole route: the rows under one file belong to that file
   * and to no other. keep.ts's staged edit is ONE -> one, and goes.ts is a
   * deletion, so neither file's rows may appear in the other's. */
  expect(keep.lines.some((l) => l.k === "add" && l.t === "ONE")).toBe(true);
  expect(keep.lines.some((l) => l.t === "delete me")).toBe(false);
  expect(goes.lines.some((l) => l.k === "del" && l.t === "delete me")).toBe(true);
  expect(goes.lines.some((l) => l.t === "ONE")).toBe(false);
  // and the header lines the file's own row already says are not repeated
  for (const f of r.files) {
    expect(f.lines.some((l) => l.t.startsWith("diff --git ")), `${f.path} repeats its own name`)
      .toBe(false);
    expect(f.lines.some((l) => l.t.startsWith("+++ b/")), `${f.path} repeats its own name`)
      .toBe(false);
  }
});

test("a file's rows are the rows git prints for that file alone", async () => {
  const r = await gitChange(root, "unstaged", "");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const readme = r.files.find((f) => f.path === "README.md")!;
  const real = await git(root, ["diff", "--no-color", "-U3", "--", "README.md"]);
  const rebuilt = readme.lines
    .map((l) => (l.k === "add" ? `+${l.t}` : l.k === "del" ? `-${l.t}` : l.k === "ctx" ? ` ${l.t}` : l.t))
    .join("\n");
  // git's own text, minus the four header lines the change view drops
  const wanted = real.split("\n").filter((t) => t &&
    !t.startsWith("diff --git ") && !t.startsWith("index ") &&
    !t.startsWith("--- ") && !t.startsWith("+++ ")).join("\n");
  expect(rebuilt).toBe(wanted);
});

test("the unstaged change includes untracked files, which git diff cannot see", async () => {
  const r = await gitChange(root, "unstaged", "");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  /* The one thing `git diff` leaves out and a review must not: a file you just
   * wrote is the most likely thing in the change. */
  const fresh = r.files.find((f) => f.path === "fresh.txt");
  expect(fresh, "an untracked file vanished from the working change").toBeTruthy();
  expect(fresh!.code).toBe("U");
  expect(fresh!.added, "every line of a new file is added").toBe(2);
  expect(fresh!.lines.filter((l) => l.k === "add").map((l) => l.t))
    .toEqual(["brand new", "second line"]);
  expect(fresh!.lines.some((l) => l.k === "del")).toBe(false);
});

test("a commit's change is every file in it, and the commit says who and when", async () => {
  const first = (await git(root, ["rev-list", "--max-parents=0", "HEAD"])).trim();
  const r = await gitChange(root, "commit", first);
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
  if (!r.ok) return;
  const names = (await git(root, ["show", "--name-only", "--format=", first]))
    .trim().split("\n").filter(Boolean).sort();
  expect(r.files.map((f) => f.path).sort()).toEqual(names);
  expect(r.files.every((f) => f.code === "A"), "every file of a first commit is added").toBe(true);
  expect(r.commit?.sha).toBe(first);
  expect(r.commit?.subject).toBe("first commit");
  expect(r.commit?.author).toBe("Tester");
  // the totals are the change's own arithmetic
  expect(r.added).toBe(r.files.reduce((n, f) => n + f.added, 0));
  expect(r.files.some((f) => f.path === "with space.txt"), "a path with a space")
    .toBe(true);

  /* EVERY FILE'S ROWS ARE ITS OWN, checked against git one file at a time.
   *
   * This is the assertion that matters most in this whole section, because the
   * way it fails is silent: the list is sorted for reading and the patch
   * arrives in git's order, so a version that matched them by position hung
   * README.md's four lines under docs/notes.md and every name and count on
   * screen still looked right. Measured, not imagined -- that was the first
   * version of this route. */
  for (const f of r.files) {
    const own = await git(root, ["show", "--no-color", "-U3", "--format=", first, "--", f.path]);
    const mine = f.lines
      .filter((l) => l.k === "add" || l.k === "del" || l.k === "ctx")
      .map((l) => (l.k === "add" ? `+${l.t}` : l.k === "del" ? `-${l.t}` : ` ${l.t}`));
    // git's own body for that one file: everything inside its hunks
    const theirs: string[] = [];
    let inHunk = false;
    for (const t of own.split("\n")) {
      if (t.startsWith("@@ ")) {
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (t === "" || t[0] === "+" || t[0] === "-" || t[0] === " ") theirs.push(t);
    }
    while (theirs.length && theirs[theirs.length - 1] === "") theirs.pop();
    expect(mine.length, `${f.path} has no rows of its own`).toBeGreaterThan(0);
    expect(mine, `${f.path}'s rows are not ${f.path}'s`).toEqual(theirs);
  }
});

test("a change asks for a commit id that is one, and refuses anything else", async () => {
  expect((await gitChange(root, "commit", "not-a-sha")).ok).toBe(false);
  expect((await gitChange(root, "commit", "; rm -rf /")).ok).toBe(false);
  const blob = (await git(root, ["rev-parse", "HEAD:README.md"])).trim();
  expect((await gitChange(root, "commit", blob)).ok,
    "a blob id must not be read as a change").toBe(false);
});

test("a change over the caps still LISTS every file, and says which have no diff", async () => {
  /* A change bigger than a phone can be handed, made rather than imagined: one
   * file with more edits than GIT_CHANGE_FILE_EDITS_MAX allows. It has to be
   * listed, with its real counts, and marked skipped -- a file quietly missing
   * from a review is the app answering a smaller question than it was asked. */
  const big = join(root, "big.txt");
  const lines: string[] = [];
  for (let i = 0; i < GIT_CHANGE_FILE_EDITS_MAX + 50; i++) lines.push(`line ${i}`);
  await writeFile(big, lines.join("\n") + "\n");
  await runGit(root, ["add", "--", big]);
  try {
    const r = await gitChange(root, "staged", "");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = r.files.find((f) => f.path === "big.txt")!;
    expect(got, "the oversized file was dropped from the list").toBeTruthy();
    expect(got.skipped, "it is over the per-file cap, so it has no diff here").toBe(true);
    expect(got.lines.length).toBe(0);
    expect(got.added, "its real size is still reported").toBe(GIT_CHANGE_FILE_EDITS_MAX + 50);
    // and the files that DO fit are unaffected by the one that does not
    expect(r.files.find((f) => f.path === "src/keep.ts")!.lines.length).toBeGreaterThan(0);
  } finally {
    await runGit(root, ["restore", "--staged", "--", big]);
    await rm(big, { force: true });
  }
});

test("the per-file cap means the same thing for an untracked file", async () => {
  /* A new file's size is not known until git has counted it, so the cap can
   * only be applied after the diff is taken. Letting one 40000-line file
   * through because it happened to be untracked would make one number mean two
   * different things. */
  const big = join(root, "brand-new.txt");
  const lines: string[] = [];
  for (let i = 0; i < GIT_CHANGE_FILE_EDITS_MAX + 20; i++) lines.push(`new ${i}`);
  await writeFile(big, lines.join("\n") + "\n");
  try {
    const r = await gitChange(root, "unstaged", "");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = r.files.find((f) => f.path === "brand-new.txt")!;
    expect(got, "the new file was dropped from the list").toBeTruthy();
    expect(got.skipped).toBe(true);
    expect(got.lines.length).toBe(0);
    expect(got.added, "its real size is still reported").toBe(GIT_CHANGE_FILE_EDITS_MAX + 20);
    // the small untracked file beside it is unaffected
    expect(r.files.find((f) => f.path === "fresh.txt")!.lines.length).toBeGreaterThan(0);
  } finally {
    await rm(big, { force: true });
  }
});

test("numstat: a rename's empty path takes its two names from the records after it", () => {
  const rows = parseNumstat("1\t0\tone.txt\x000\t0\t\x00two.txt\x00three.txt\x00-\t-\tlogo.png\x00");
  expect(rows).toEqual([
    { path: "one.txt", added: 1, deleted: 0, binary: false },
    { path: "three.txt", from: "two.txt", added: 0, deleted: 0, binary: false },
    { path: "logo.png", added: 0, deleted: 0, binary: true },
  ]);
});

test("name-status: a rename eats two path records and a score is not a letter", () => {
  const m = parseNameStatus("M\x00a b.txt\x00R100\x00old.ts\x00new.ts\x00A\x00add.ts\x00D\x00gone.ts\x00");
  expect([...m]).toEqual([["a b.txt", "M"], ["new.ts", "R"], ["add.ts", "A"], ["gone.ts", "D"]]);
});

// ------------------------------------------------ READ-ONLY: no write path (#368)

test("this module exports no way to change a repository", async () => {
  /* The pane is read-only. stage/unstage/commit/push were removed, not hidden,
   * so a future caller cannot reintroduce one by importing it back. */
  const mod = await import("../storage/files.ts") as Record<string, unknown>;
  for (const name of ["gitStage", "gitCommit", "gitPush"]) {
    expect(mod[name], `${name} must not be exported anymore`).toBeUndefined();
  }
});

// --------------------------------------------------- branches, ref logs, compares

/* A repo with two branches that forked and diverged: `main` gained a commit
 * after the fork, `feature` gained two of its own. Everything the branch list
 * and the two compares are made to show, made with git so the comparisons are
 * against something real.
 *
 * Built ONCE and shared: everything that reads it is read-only (the pane no
 * longer writes at all, #368), and six independent `git init` + five commits
 * each was most of this file's wall time for no extra coverage. */
let forkedOnce: Promise<string> | null = null;
const buildForked = (): Promise<string> => (forkedOnce ??= (async () => {
  const repo = await at("forked");
  await runGit(repo, ["init", "-q", "-b", "main"]);
  await runGit(repo, ["config", "user.email", "t@t"]);
  await runGit(repo, ["config", "user.name", "t"]);
  await runGit(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(repo, "README.md"), "one\ntwo\nthree\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "-qm", "base"]);
  await runGit(repo, ["branch", "feature"]);
  // main moves on after the fork
  await writeFile(join(repo, "README.md"), "one\ntwo\nthree\nmain-added\n");
  await runGit(repo, ["commit", "-aqm", "M1 on main"]);
  // feature gets two of its own
  await runGit(repo, ["checkout", "-q", "feature"]);
  await writeFile(join(repo, "feat.txt"), "brand new\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "-qm", "F1 add feat"]);
  await writeFile(join(repo, "README.md"), "one\nTWO\nthree\n");
  await runGit(repo, ["commit", "-aqm", "F2 edit readme"]);
  return repo;
})());

test("the branch list names every local branch and marks the one that is checked out", async () => {
  const at = await buildForked();
  const r = await gitBranches(at);
  expect(r.ok && r.repo, r.ok ? "" : (r as {error: string}).error).toBe(true);
  if (!r.ok || !r.repo) return;
  const names = r.branches.map((b) => b.name).sort();
  expect(names).toEqual(["feature", "main"]);
  expect(r.head).toBe("feature");
  expect(r.defaultBranch).toBe("main");
  expect(r.branches.find((b) => b.name === "feature")?.current).toBe(true);
  expect(r.branches.find((b) => b.name === "main")?.current).toBe(false);
});

test("a ref's log is that ref's history, newest first, for a branch you are not on", async () => {
  const at = await buildForked();
  const onMain = await gitRefLog(at, "main");
  expect(onMain.ok, onMain.ok ? "" : onMain.error).toBe(true);
  if (!onMain.ok) return;
  expect(onMain.log.map((c) => c.subject)).toEqual(["M1 on main", "base"]);

  const onFeat = await gitRefLog(at, "feature");
  if (!onFeat.ok) throw new Error(onFeat.error);
  expect(onFeat.log.map((c) => c.subject)).toEqual(["F2 edit readme", "F1 add feat", "base"]);
});

test("compare vs merge-base is what the branch added since it forked, not main's own commits", async () => {
  const at = await buildForked();
  const r = await gitCompare(at, "feature", "mergebase");
  expect(r.ok, r.ok ? "" : (r as {error: string}).error).toBe(true);
  if (!r.ok) return;
  // the two commits feature made, and NOT main's M1
  expect(r.commits.map((c) => c.subject)).toEqual(["F2 edit readme", "F1 add feat"]);
  const paths = r.files.map((f) => f.path).sort();
  expect(paths).toEqual(["README.md", "feat.txt"]);
  // feat.txt is new, and its diff is carried, not just its name
  const feat = r.files.find((f) => f.path === "feat.txt");
  expect(feat?.code).toBe("A");
  expect(feat?.lines.some((l) => l.k === "add" && l.t === "brand new")).toBe(true);
});

test("compare vs latest main lists the branch's commits and its files against the default tip", async () => {
  const at = await buildForked();
  const r = await gitCompare(at, "feature", "main");
  expect(r.ok, r.ok ? "" : (r as {error: string}).error).toBe(true);
  if (!r.ok) return;
  expect(r.against).toBe("main");
  expect(r.base).toBe("main");
  expect(r.commits.map((c) => c.subject)).toEqual(["F2 edit readme", "F1 add feat"]);
  expect(r.files.map((f) => f.path).sort()).toEqual(["README.md", "feat.txt"]);
});

test("a hostile ref name is refused everywhere it can be handed to git", async () => {
  const at = await buildForked();
  const hostile = [
    "--upload-pack=touch /tmp/pwned",
    "; rm -rf /",
    "$(rm -rf /)",
    "feature..main",
    "-n",
    "refs/heads/feature\nmain",
    "..",
  ];
  for (const bad of hostile) {
    expect(validRef(bad), `validRef must reject ${JSON.stringify(bad)}`).toBe(false);
    expect((await gitRefLog(at, bad)).ok, `gitRefLog must refuse ${JSON.stringify(bad)}`).toBe(false);
    expect((await gitCompare(at, bad, "mergebase")).ok,
      `gitCompare must refuse ${JSON.stringify(bad)}`).toBe(false);
  }
  // and a well-formed but nonexistent ref is refused too, without a shell ever
  // seeing it
  expect((await gitRefLog(at, "no-such-branch")).ok).toBe(false);
  expect(validRef("feature"), "a real branch name is allowed").toBe(true);
  expect(validRef("release/1.2.x"), "slashes and dots are allowed").toBe(true);
});

/* THE WHOLE ALPHABET, in one table, because the argument for this validator is
 * that a name is CHECKED and never interpolated: everything git's revision
 * syntax can navigate with, and everything argv can be confused by, has to be
 * out. A miss here is a ref that reaches `git log` and means something other
 * than a branch. */
test("validRef admits ordinary names and nothing from git's revision alphabet", () => {
  for (const good of ["main", "feature", "release/1.2.x", "a", "v1.0.0", "fix-a_b.c",
    "users/example/wip", "0", "x".repeat(GIT_REF_MAX)]) {
    expect(validRef(good), `validRef must allow ${JSON.stringify(good)}`).toBe(true);
  }
  for (const bad of [
    "", " ", "a b", "\t", "a\nb", "a\0b",
    "HEAD@{1}", "main^", "main~2", "main:file", "refs/heads/*", "ma?n", "a[b]", "a\\b",
    "-main", "--all", "/main", "main/", "main.", "main.lock", "a//b", "a..b",
    "héllo", "main#1", "main;ls", "main|x", "main&x", "main$x", "main'x", 'main"x',
    "x".repeat(GIT_REF_MAX + 1),
  ]) {
    expect(validRef(bad), `validRef must reject ${JSON.stringify(bad)}`).toBe(false);
  }
  // and anything that is not a string at all
  for (const junk of [null, undefined, 7, {}, [], true, ["main"]]) {
    expect(validRef(junk), `validRef must reject ${JSON.stringify(junk)}`).toBe(false);
  }
});

test("a compare against a ref that does not exist is refused, and says nothing about a shell", async () => {
  const at = await buildForked();
  const r = await gitCompare(at, "no-such-branch", "mergebase");
  expect(r.ok).toBe(false);
  const other = await gitCompare(at, "feature", "no-such-branch" as never);
  expect(other.ok, "an `against` naming nothing is not a silent fall back to the default")
    .toBe(false);
});

test("the branch list carries each branch's own drift from its own upstream", async () => {
  /* The fixture repo tracks origin/main and is level with it; the forked repo
   * tracks nothing at all, and "no upstream" must read as "" and 0/0 rather
   * than as being level with something. */
  const tracked = await gitBranches(root);
  expect(tracked.ok && tracked.repo).toBe(true);
  if (!tracked.ok || !tracked.repo) return;
  const main = tracked.branches.find((b) => b.name === "main")!;
  expect(main.upstream).toBe("origin/main");
  expect([main.ahead, main.behind]).toEqual([0, 0]);

  const at = await buildForked();
  const untracked = await gitBranches(at);
  if (!untracked.ok || !untracked.repo) throw new Error("expected a repo");
  for (const b of untracked.branches) {
    expect(b.upstream, `${b.name} claims an upstream it does not have`).toBe("");
    expect([b.ahead, b.behind]).toEqual([0, 0]);
  }
});

test("compare against a bad `against` value is refused, not defaulted", async () => {
  const at = await buildForked();
  // @ts-expect-error the route validates this string; the function guards it too
  const r = await gitCompare(at, "feature", "sideways");
  expect(r.ok).toBe(false);
});

// ---------------------------------------------------------------- not a repo

test("a directory that is not a repo answers repo:false, which is not an error", async () => {
  const plain = await at("norepo");
  const p = await gitPane(plain);
  expect(p.ok).toBe(true);
  expect((p as { repo: boolean }).repo).toBe(false);
  expect(await repoTop(plain)).toBeNull();
  // and the reads say so rather than running git somewhere unexpected
  const b = await gitBranches(plain);
  expect(b.ok && (b as { repo: boolean }).repo).toBe(false);
  expect((await gitRefLog(plain, "main")).ok).toBe(false);
  expect((await gitCompare(plain, "main", "mergebase")).ok).toBe(false);
});

test("a repo with no commits yet has an empty log and no logError", async () => {
  const fresh = await at("empty");
  await runGit(fresh, ["init", "-q", "-b", "main"]);
  await runGit(fresh, ["config", "user.email", "t@t"]);
  await runGit(fresh, ["config", "user.name", "t"]);
  await writeFile(join(fresh, "a.txt"), "hello\n");
  const p = await gitPane(fresh);
  expect(p.ok && (p as GitPaneState).log).toEqual([]);
  expect(p.ok && (p as GitPaneState).logError, "no commits is not a failure").toBe("");
  expect(p.ok && (p as GitPaneState).lastMessage).toBe("");

  // the staged diff of a file with no HEAD side still reads: stage it with git
  // itself (the pane no longer writes), then read it back
  await runGit(fresh, ["add", "a.txt"]);
  const d = await gitFilePatch(fresh, "a.txt", "staged");
  expect(d.ok && d.added).toBe(1);
});

// ------------------------------------------------------------- the conflict

test("an unmerged file is one row marked C, in the working list", async () => {
  const c = await at("conflict");
  await runGit(c, ["init", "-q", "-b", "main"]);
  await runGit(c, ["config", "user.email", "t@t"]);
  await runGit(c, ["config", "user.name", "t"]);
  await writeFile(join(c, "f.txt"), "base\n");
  await runGit(c, ["add", "-A"]);
  await runGit(c, ["commit", "-qm", "base"]);
  await runGit(c, ["checkout", "-q", "-b", "side"]);
  await writeFile(join(c, "f.txt"), "side\n");
  await runGit(c, ["commit", "-aqm", "side"]);
  await runGit(c, ["checkout", "-q", "main"]);
  await writeFile(join(c, "f.txt"), "main\n");
  await runGit(c, ["commit", "-aqm", "main"]);
  const merged = await runGit(c, ["merge", "side"]);
  expect(merged.ok, "the fixture did not actually conflict").toBe(false);

  const p = await gitPane(c);
  expect(p.ok && (p as GitPaneState).unstaged.find((r) => r.path === "f.txt")?.code).toBe("C");
  expect(p.ok && (p as GitPaneState).staged.some((r) => r.path === "f.txt"),
    "a conflict is not a staged change").toBe(false);
});

// ---------------------------------------------------------------- the parses

test("status v2: a path with a space survives and a rename eats its source record", () => {
  const out = [
    "# branch.oid abc123",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -3",
    "1 M. N... 100644 100644 100644 aaa bbb src/with a space.ts",
    "2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts",
    "old/name.ts",
    "? untracked.txt",
    "! node_modules/",
  ].join("\0") + "\0";
  const s = parseStatusV2(out);
  expect(s.branch).toBe("main");
  expect(s.upstream).toBe("origin/main");
  expect([s.ahead, s.behind]).toEqual([2, 3]);
  expect(s.staged.map((r) => r.path).sort()).toEqual(["new/name.ts", "src/with a space.ts"]);
  expect(s.staged.find((r) => r.path === "new/name.ts")?.from).toBe("old/name.ts");
  expect(s.unstaged.map((r) => r.path)).toEqual(["untracked.txt"]);
  // an ignored record is not a change and must not be listed as one
  expect(s.staged.concat(s.unstaged).some((r) => r.path === "node_modules/")).toBe(false);
});

test("status v2: a detached head has no branch, and an initial one has no oid", () => {
  const det = parseStatusV2(["# branch.oid deadbee", "# branch.head (detached)"].join("\0"));
  expect(det.branch).toBe("");
  expect(det.oid).toBe("deadbee");
  const init = parseStatusV2(["# branch.oid (initial)", "# branch.head main"].join("\0"));
  expect(init.oid).toBe("");
  expect(init.branch).toBe("main");
});

test("status v2: an unmerged record is a conflict and is not split across the lists", () => {
  const s = parseStatusV2("u UU N... 100644 100644 100644 100644 a b c both.txt\0");
  expect(s.unstaged).toEqual([{ path: "both.txt", code: "C" }]);
  expect(s.staged).toEqual([]);
});

test("patch: a hunk header with no comma still counts one line", () => {
  const p = parsePatch("@@ -3 +3 @@\n-old\n+new\n");
  expect(p.added).toBe(1);
  expect(p.deleted).toBe(1);
  expect(p.lines.find((l) => l.k === "del")?.o).toBe(3);
  expect(p.lines.find((l) => l.k === "add")?.n).toBe(3);
});

test("patch: a header's +++ and --- are not counted as a change", () => {
  const p = parsePatch([
    "diff --git a/x.ts b/x.ts",
    "index 111..222 100644",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-gone",
    "+here",
  ].join("\n"));
  expect(p.added).toBe(1);
  expect(p.deleted).toBe(1);
  expect(p.files).toBe(1);
  expect(p.lines.filter((l) => l.k === "meta").length).toBe(4);
});

test("patch: a binary file says so rather than coming back empty", () => {
  const p = parsePatch([
    "diff --git a/logo.png b/logo.png",
    "index 111..222 100644",
    "Binary files a/logo.png and b/logo.png differ",
  ].join("\n"));
  expect(p.binary).toBe(true);
  expect(p.added + p.deleted).toBe(0);
  expect(p.lines.some((l) => l.t.startsWith("Binary files"))).toBe(true);
});

test("patch: a diff longer than the cap is cut and SAYS it was cut", () => {
  const body = Array.from({ length: GIT_PATCH_MAX_LINES + 500 }, (_, i) => `+line ${i}`).join("\n");
  const p = parsePatch(`@@ -0,0 +1,${GIT_PATCH_MAX_LINES + 500} @@\n${body}\n`);
  expect(p.truncated).toBe(true);
  expect(p.lines.length).toBe(GIT_PATCH_MAX_LINES);
});

test("patch: 'no newline at end of file' is a note, not a change", () => {
  const p = parsePatch("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n");
  expect(p.added).toBe(1);
  expect(p.deleted).toBe(1);
  expect(p.lines[p.lines.length - 1].k).toBe("meta");
});

test("log: the unit separator survives a subject that contains everything else", () => {
  const rec = ["abc1234def", "abc1234", "fix: a, b | c -- \"d\"", "A Name", "1700000000", "HEAD -> main"];
  const l = parseLog(rec.join("\x1f") + "\0");
  expect(l).toEqual([{
    sha: "abc1234def", short: "abc1234", subject: 'fix: a, b | c -- "d"',
    author: "A Name", when: 1_700_000_000, refs: "HEAD -> main",
  }]);
});

/* THE EMPTY AND THE MALFORMED, for every parser here. Each of these is what a
 * parser is handed when git answered nothing (a repo with no commits, a clean
 * tree, a file with no changes), and each of them used to be a place where a
 * `[0]` on an empty array walked off the end. */
test("every parser answers emptily for empty input rather than inventing a row", () => {
  expect(parseLog("")).toEqual([]);
  expect(parseLog("\0")).toEqual([]);
  expect(parseNumstat("")).toEqual([]);
  expect([...parseNameStatus("")]).toEqual([]);
  expect(parsePatch("")).toEqual({ lines: [], added: 0, deleted: 0, files: 0, binary: false, truncated: false });

  const s = parseStatusV2("");
  expect([s.staged, s.unstaged]).toEqual([[], []]);
  expect([s.branch, s.oid, s.upstream]).toEqual(["", "", ""]);
  expect([s.ahead, s.behind]).toEqual([0, 0]);
  expect(s.truncated).toBe(false);
});

test("status v2: a record it does not recognise is skipped, not guessed at", () => {
  const s = parseStatusV2([
    "# something.new value",
    "9 an unknown record kind",
    "",
    "1 M. N... 100644 100644 100644 aaa bbb real.ts",
  ].join("\0") + "\0");
  expect(s.staged.map((r) => r.path)).toEqual(["real.ts"]);
  expect(s.unstaged).toEqual([]);
});

test("status v2: a branch with no upstream reports no drift rather than zero drift it measured", () => {
  const s = parseStatusV2(["# branch.oid abc123", "# branch.head main"].join("\0") + "\0");
  expect(s.upstream).toBe("");
  expect([s.ahead, s.behind]).toEqual([0, 0]);
});

test("patch: a diff with no hunk at all is all meta and counts nothing", () => {
  /* A mode change, or a rename with no content edit: git prints headers and
   * stops. The rows still have to come back, or the panel shows an empty box
   * for a change that really happened. */
  const p = parsePatch([
    "diff --git a/x.ts b/x.ts",
    "old mode 100644",
    "new mode 100755",
  ].join("\n"));
  expect(p.files).toBe(1);
  expect([p.added, p.deleted]).toEqual([0, 0]);
  expect(p.lines.every((l) => l.k === "meta")).toBe(true);
  expect(p.lines.length).toBe(3);
});

test("patch: two files in one diff reset the line counters at the second one", () => {
  /* Without the reset the second file's rows carry the first file's numbers,
   * which is a gutter that points at the wrong lines and looks plausible. */
  const p = parsePatch([
    "diff --git a/a.ts b/a.ts",
    "@@ -10,1 +10,1 @@",
    "-old a",
    "+new a",
    "diff --git a/b.ts b/b.ts",
    "@@ -1,1 +1,1 @@",
    "-old b",
    "+new b",
  ].join("\n"));
  expect(p.files).toBe(2);
  const dels = p.lines.filter((l) => l.k === "del");
  expect(dels.map((l) => l.o)).toEqual([10, 1]);
  const adds = p.lines.filter((l) => l.k === "add");
  expect(adds.map((l) => l.n)).toEqual([10, 1]);
});

test("patch: the cap is a LINE cap that keeps the head of the diff", () => {
  const body = Array.from({ length: 20 }, (_, i) => `+line ${i}`).join("\n");
  const p = parsePatch(`@@ -0,0 +1,20 @@\n${body}\n`, 5);
  expect(p.truncated).toBe(true);
  expect(p.lines.length).toBe(5);
  expect(p.lines[0].k, "the hunk header is the first row kept").toBe("hunk");
  expect(p.lines[1].t).toBe("line 0");
});

test("numstat and name-status ignore a record they cannot read", () => {
  expect(parseNumstat("garbage\x001\t2\tok.txt\x00")).toEqual([
    { path: "ok.txt", added: 1, deleted: 2, binary: false },
  ]);
  expect([...parseNameStatus("\x00M\x00ok.txt\x00")]).toEqual([["ok.txt", "M"]]);
});
