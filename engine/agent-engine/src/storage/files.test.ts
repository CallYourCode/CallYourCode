/* The file explorer's engine side, against a real directory and a real repo.
 *
 * The half that matters most is CONFINEMENT, so it is tested the way an
 * attacker would reach for it: `..`, an absolute path, and a symlink pointing
 * out of the root -- the last one being the case a normaliser cannot see and
 * the reason resolveInRoot() asks the filesystem instead of the string.
 *
 * Everything else is parsed, so parsePorcelain and parseHunks are tested on
 * literal git output rather than on a repo that has to be built into a
 * particular state first: the shapes that break them (a rename's two records,
 * a hunk header with no comma) are one line each here and a fixture repo
 * there.
 */

import { test, expect, beforeAll } from "bun:test";
import { mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  rootOf, resolveInRoot, inside, relOf, listDir, readFile, gitStatus, gitDiff, runGit,
  parsePorcelain, parseHunks, codeOf, imageMimeOf, fmtBytes,
  LIST_MAX, READ_MAX_BYTES, READ_MAX_LINES, GIT_MAX_ENTRIES,
} from "./files.ts";
import { tmpDir } from "../test-utils/tmp.ts";

let dir = "";
let root = "";

/* MODULE SCOPE ON PURPOSE. tmp.ts registers its cleanup with afterAll the first
 * time it is called, and bun runs a hook registered from INSIDE a running hook
 * as soon as that hook returns: a first tmpDir() from within beforeAll deletes
 * the fixture before the first test sees it. Priming it here puts the afterAll
 * on the file, where it belongs, and every later tmpDir() is then free to be
 * called from anywhere. */
const scratch = tmpDir("cyc-files-");

beforeAll(async () => {
  /* realpath'd, and not as a nicety: macOS hands mkdtemp a path under
   * /var/folders, and /var is a symlink to /private/var. resolveInRoot()
   * realpaths whatever it is given, so a root left as the /var spelling would
   * fail its own prefix test for every file in it. This is the same reason
   * rootOf() exists on the real side. */
  dir = await realpath(await scratch);
  await mkdir(join(dir, "repo"), { recursive: true });
  root = await rootOf(join(dir, "repo"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "empty"));
  await writeFile(join(root, "README.md"), "# hi\nthere\n");
  await writeFile(join(root, "src", "a.ts"), "one\ntwo\nthree\nfour\n");
  await writeFile(join(root, ".gitignore"), "ignored/\n");
  await mkdir(join(root, "ignored"));
  await writeFile(join(root, "ignored", "junk.txt"), "junk\n");
  // the escape: a link inside the root pointing at the directory above it
  await symlink(dir, join(root, "out"));
  // ...and a link that stays inside, which must be allowed for the same reason
  await symlink(join(root, "src"), join(root, "inlink"));
  await symlink(join(root, "gone.txt"), join(root, "dangling"));
  await writeFile(join(dir, "secret.txt"), "not yours\n");
  // a real repo, so git status and git diff are answered by git
  await runGit(root, ["init", "-q", "-b", "main"]);
  await runGit(root, ["config", "user.email", "t@t"]);
  await runGit(root, ["config", "user.name", "t"]);
  await runGit(root, ["add", "README.md", "src/a.ts", ".gitignore"]);
  await runGit(root, ["commit", "-qm", "first"]);
  await writeFile(join(root, "src", "a.ts"), "one\nTWO\nthree\nfour\nfive\n");
  await writeFile(join(root, "new.txt"), "brand new\n");
});

// ------------------------------------------------------------- confinement

test("a relative escape is refused", async () => {
  expect(await resolveInRoot(root, "../secret.txt")).toBeNull();
  expect(await resolveInRoot(root, "../../../../etc/passwd")).toBeNull();
});

test("an absolute path outside the root is refused", async () => {
  expect(await resolveInRoot(root, "/etc/passwd")).toBeNull();
  expect(await resolveInRoot(root, join(dir, "secret.txt"))).toBeNull();
});

/* THE ONE A STRING CHECK CANNOT SEE. `root/out/secret.txt` normalises to a
 * path that is textually under the root; only realpath says it is not. */
test("a symlink out of the root is refused", async () => {
  expect(await resolveInRoot(root, "out/secret.txt")).toBeNull();
  expect((await readFile(root, "out/secret.txt")).ok).toBe(false);
  expect((await listDir(root, "out")).ok).toBe(false);
});

test("a path inside the root resolves", async () => {
  expect(await resolveInRoot(root, "src/a.ts")).toBe(join(root, "src", "a.ts"));
  expect(await resolveInRoot(root, "")).toBe(root);
});

test("a link that stays inside the root is allowed", async () => {
  /* The other half of the symlink rule. Confinement is not "no links", it is
   * "resolve, then check": a link into the project's own src/ is an ordinary
   * part of a checkout and refusing it would make the explorer lie about the
   * tree. */
  expect(await resolveInRoot(root, "inlink")).toBe(join(root, "src"));
  expect(await resolveInRoot(root, "inlink/a.ts")).toBe(join(root, "src", "a.ts"));
  const r = await listDir(root, "inlink");
  expect(r.ok).toBe(true);
});

test("a path that does not exist yet still resolves, to where it would be", async () => {
  /* realDeep walks up to the deepest ancestor that IS there and re-joins the
   * tail, so "no such file" is answered by readFile with a sentence rather than
   * by the confinement check with a refusal. The two mean different things. */
  expect(await resolveInRoot(root, "src/not-written-yet.ts"))
    .toBe(join(root, "src", "not-written-yet.ts"));
  expect(await resolveInRoot(root, "a/b/c/d.txt")).toBe(join(root, "a", "b", "c", "d.txt"));
  // and a path that does not exist AND would be outside is still refused
  expect(await resolveInRoot(root, "../nowhere/at/all.txt")).toBeNull();
});

test("dots inside a path are normalised before the check, not after", async () => {
  expect(await resolveInRoot(root, "src/../README.md")).toBe(join(root, "README.md"));
  expect(await resolveInRoot(root, "./src/./a.ts")).toBe(join(root, "src", "a.ts"));
  expect(await resolveInRoot(root, ".")).toBe(root);
  // the classic: enough `..` to leave, then back in under a name that exists
  expect(await resolveInRoot(root, "src/../../repo/README.md")).toBe(join(root, "README.md"));
});

test("inside() is not fooled by a sibling with the same prefix", () => {
  expect(inside("/a/b", "/a/b")).toBe(true);
  expect(inside("/a/b", "/a/b/c")).toBe(true);
  expect(inside("/a/b", "/a/bc")).toBe(false);
  expect(inside("/a/b", "/a/b-old/x")).toBe(false);
  expect(inside("/a/b", "/a")).toBe(false);
  // a root that already ends in a separator must not grow a second one
  expect(inside("/a/b/", "/a/b/c")).toBe(true);
  expect(inside("/", "/anything")).toBe(true);
});

test("relOf is what the app holds: '/'-joined, empty for the root itself", () => {
  expect(relOf(root, root)).toBe("");
  expect(relOf(root, join(root, "src", "a.ts"))).toBe("src/a.ts");
});

// ------------------------------------------------------------------ listing

test("a listing is folders first, then files, and says what has children", async () => {
  const r = await listDir(root, "");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const names = r.entries.map((e) => e.name);
  // .git is a real directory and is listed; the app decides what to hide
  expect(names).toContain("README.md");
  expect(names).toContain("src");
  const dirs = r.entries.filter((e) => e.dir).map((e) => e.name);
  expect(names.slice(0, dirs.length)).toEqual(dirs);
  expect(r.entries.find((e) => e.name === "src")?.children).toBe(true);
  expect(r.entries.find((e) => e.name === "empty")?.children).toBe(false);
  expect(r.truncated).toBe(false);
  expect(r.total).toBe(names.length);
});

test("a big directory is cut at the cap and says so", async () => {
  const big = join(root, "big");
  await mkdir(big);
  await Promise.all(
    Array.from({ length: LIST_MAX + 25 }, (_, i) => writeFile(join(big, `f${i}.txt`), "x")),
  );
  const r = await listDir(root, "big");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.entries.length).toBe(LIST_MAX);
  expect(r.total).toBe(LIST_MAX + 25);
  expect(r.truncated).toBe(true);
  await rm(big, { recursive: true, force: true });
});

test("a directory that is not there is a 'no such directory', not a crash", async () => {
  const r = await listDir(root, "nope");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("no such");
});

test("a file asked for as a directory says which of the two it is", async () => {
  const r = await listDir(root, "README.md");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("not a directory");
});

test("a link is marked as one, and a dangling link is a row that opens to nothing", async () => {
  /* A link is followed only far enough to say what it IS; entering it still has
   * to pass the confinement check. A dangling one is drawn as a file rather
   * than dropped, because it is genuinely there in the tree. */
  const r = await listDir(root, "");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const inlink = r.entries.find((e) => e.name === "inlink")!;
  expect(inlink.link).toBe(true);
  expect(inlink.dir, "a link to a directory is drawn as a directory").toBe(true);
  const dangling = r.entries.find((e) => e.name === "dangling")!;
  expect(dangling.link).toBe(true);
  expect(dangling.dir).toBe(false);
  // an ordinary file carries no link flag at all
  expect(r.entries.find((e) => e.name === "README.md")!.link).toBeUndefined();
});

test("the order is the explorer's: folders first, then numbers compared as numbers", async () => {
  /* `10-x.md` after `9-x.md`, not after `1-x.md`, and case ignored. Sorted
   * BEFORE the cap is applied, so "the first 2000" is the first 2000 of the
   * order he will see rather than of whatever readdir returned. */
  const at = join(root, "order");
  await mkdir(at);
  for (const n of ["9-x.md", "10-x.md", "1-x.md", "Beta.md", "alpha.md"]) {
    await writeFile(join(at, n), "x");
  }
  await mkdir(join(at, "zdir"));
  const r = await listDir(root, "order");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.entries.map((e) => e.name))
    .toEqual(["zdir", "1-x.md", "9-x.md", "10-x.md", "alpha.md", "Beta.md"]);
  await rm(at, { recursive: true, force: true });
});

// ------------------------------------------------------------------ reading

test("a text file comes back with its line count", async () => {
  const r = await readFile(root, "src/a.ts");
  expect(r.ok).toBe(true);
  if (!r.ok || r.kind !== "text") throw new Error("expected text");
  expect(r.text).toContain("TWO");
  expect(r.lines).toBe(6); // five lines plus the empty one after the last \n
  expect(r.truncated).toBe(false);
  expect(r.name).toBe("a.ts");
});

test("a binary file is reported as binary rather than decoded", async () => {
  await writeFile(join(root, "blob.bin"), Buffer.from([1, 2, 0, 3, 4]));
  const r = await readFile(root, "blob.bin");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.kind).toBe("binary");
});

test("an empty file is text with no lines, not a binary and not an error", async () => {
  await writeFile(join(root, "blank.txt"), "");
  const r = await readFile(root, "blank.txt");
  expect(r.ok).toBe(true);
  if (!r.ok || r.kind !== "text") throw new Error("expected text");
  expect(r.lines).toBe(0);
  expect(r.text).toBe("");
  expect(r.size).toBe(0);
});

test("a file with more lines than the cap is TRUNCATED and says so", async () => {
  /* Byte cap and line cap catch different files: a minified bundle is one line
   * and small, a generated log is a million short ones. This one truncates
   * rather than refusing, because the head of a log is useful. */
  const many = join(root, "huge.log");
  await writeFile(many, Array.from({ length: READ_MAX_LINES + 25 }, (_, i) => `line ${i}`).join("\n"));
  const r = await readFile(root, "huge.log");
  expect(r.ok).toBe(true);
  if (!r.ok || r.kind !== "text") throw new Error("expected text");
  expect(r.truncated).toBe(true);
  expect(r.lines, "the real line count is still reported").toBe(READ_MAX_LINES + 25);
  expect(r.text.split("\n").length).toBe(READ_MAX_LINES);
  expect(r.text.startsWith("line 0\n"), "the HEAD of the log is what is kept").toBe(true);
  await rm(many, { force: true });
});

test("a file over the byte cap is REFUSED with its size, never cut and served", async () => {
  /* A 200 MB file cut to 2 MB and rendered as if that were the file is exactly
   * the lie this codebase keeps having to undo. */
  const big = join(root, "over.txt");
  await writeFile(big, "x".repeat(READ_MAX_BYTES + 1024));
  const r = await readFile(root, "over.txt");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("over the");
  expect(r.error).toContain(fmtBytes(READ_MAX_BYTES));
  await rm(big, { force: true });
});

test("a file that is not there is a 'no such file'", async () => {
  const r = await readFile(root, "src/nope.ts");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("no such file");
});

test("an image is reported as an image, by name", async () => {
  expect(imageMimeOf("a/b/x.PNG")).toBe("image/png");
  expect(imageMimeOf("x.ts")).toBeNull();
});

test("an image is decided by name before its bytes are ever read", async () => {
  /* The bytes are served back with the type the extension claimed, and nothing
   * else, so a file that lies about its name renders as what it claimed. The
   * point here is that readFile does not decode it as text on the way. */
  await writeFile(join(root, "photo.png"), Buffer.from([0, 1, 2, 3]));
  const r = await readFile(root, "photo.png");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.kind).toBe("image");
  expect((r as { text?: string }).text, "an image must not come back decoded").toBeUndefined();
});

test("imageMimeOf reads the last extension, and only a known one", () => {
  expect(imageMimeOf("x.svg")).toBe("image/svg+xml");
  expect(imageMimeOf("x.webp")).toBe("image/webp");
  expect(imageMimeOf("x.ico")).toBe("image/x-icon");
  expect(imageMimeOf("archive.png.gz"), "the LAST extension decides").toBeNull();
  expect(imageMimeOf("README")).toBeNull();
  expect(imageMimeOf("")).toBeNull();
});

test("fmtBytes says B, KB and MB, and the refusal reads as a size", () => {
  expect(fmtBytes(0)).toBe("0 B");
  expect(fmtBytes(1023)).toBe("1023 B");
  expect(fmtBytes(1024)).toBe("1.0 KB");
  expect(fmtBytes(1024 * 1024 - 1)).toBe("1024.0 KB");
  expect(fmtBytes(1024 * 1024)).toBe("1.0 MB");
  expect(fmtBytes(18_400_000)).toBe("17.5 MB");
});

test("a directory asked for as a file says so", async () => {
  const r = await readFile(root, "src");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("directory");
});

// ---------------------------------------------------------------------- git

test("git status matches what git itself reports", async () => {
  const g = await gitStatus(root);
  expect(g.ok).toBe(true);
  if (!g.ok || !g.repo) throw new Error("expected a repo");
  expect(g.files["src/a.ts"]).toBe("M");
  expect(g.files["new.txt"]).toBe("U");
  // the ignored directory is collapsed to one record, not listed file by file
  expect(g.files["ignored"]).toBe("I");
  expect(g.files["ignored/junk.txt"]).toBeUndefined();
});

test("a directory that is not a repo answers repo:false, not an error", async () => {
  const plain = await realpath(await tmpDir("cyc-plain-"));
  const g = await gitStatus(await rootOf(plain));
  expect(g.ok).toBe(true);
  if (!g.ok) return;
  expect(g.repo).toBe(false);
});

test("git is run as an argument array, so a path that looks like a command is a path", async () => {
  /* Never a shell (runGit spawns argv directly). A file literally named
   * `; rm -rf /` has to come back as an ordinary untracked row and nothing
   * else may happen. */
  const name = "$(touch pwned); echo hi.txt";
  const nasty = join(root, name);
  await writeFile(nasty, "harmless\n");
  try {
    const g = await gitStatus(root);
    expect(g.ok && g.repo).toBe(true);
    if (!g.ok || !g.repo) return;
    expect(g.files[name]).toBe("U");
    // and the argument really did reach git as one argument, not as a command
    const r = await runGit(root, ["rev-parse", "--verify", name]);
    expect(r.ok, "git resolved a shell string as a ref").toBe(false);
    expect(await Bun.file(join(root, "pwned")).exists(),
      "the substitution ran, so something put this through a shell").toBe(false);
  } finally {
    await rm(nasty, { force: true });
  }
});

test("runGit reports a failure with git's own sentence rather than throwing", async () => {
  const r = await runGit(root, ["cat-file", "-p", "0000000000000000000000000000000000000000"]);
  expect(r.ok).toBe(false);
  expect(r.code).not.toBe(0);
  expect(r.err.length, "the failure came back with nothing to read").toBeGreaterThan(0);
});

test("runGit's okExit lets 'these differ' be an answer instead of a failure", async () => {
  /* `diff --no-index` exits 1 to SAY they differ. Nothing else passes okExit,
   * which is why it is a parameter rather than a blanket tolerance. */
  const a = join(root, "cmp-a.txt");
  const b = join(root, "cmp-b.txt");
  await writeFile(a, "one\n");
  await writeFile(b, "two\n");
  try {
    const bad = await runGit(root, ["diff", "--no-index", "--", a, b]);
    expect(bad.ok, "exit 1 is a failure unless the caller said otherwise").toBe(false);
    const good = await runGit(root, ["diff", "--no-index", "--", a, b], { okExit: [0, 1] });
    expect(good.ok).toBe(true);
    expect(good.out).toContain("-one");
    expect(good.out).toContain("+two");
  } finally {
    await rm(a, { force: true });
    await rm(b, { force: true });
  }
});

test("the status is re-based onto the session root, which may be below the repo", async () => {
  /* An agent started in a subdirectory of a repo. The paths git prints are
   * relative to the repo TOP, and a row for a sibling directory has nothing on
   * screen to decorate, so it is dropped rather than shown at a wrong path. */
  const sub = await rootOf(join(root, "src"));
  const g = await gitStatus(sub);
  expect(g.ok && g.repo).toBe(true);
  if (!g.ok || !g.repo) return;
  expect(g.files["a.ts"], "the path is relative to the session root now").toBe("M");
  expect(g.files["src/a.ts"], "the repo-relative spelling must not survive").toBeUndefined();
  expect(g.files["new.txt"], "a change above the session root has no row here").toBeUndefined();
  expect(g.root, "the repo top, said relative to the session root").toBe("..");
});

test("the gutter for a modified file is the lines git changed", async () => {
  const d = await gitDiff(root, "src/a.ts");
  expect(d.ok).toBe(true);
  if (!d.ok || !d.repo) throw new Error("expected a repo");
  expect(d.marks).toContainEqual({ line: 2, kind: "modified" }); // two -> TWO
  expect(d.marks).toContainEqual({ line: 5, kind: "added" }); // five
  expect(d.modified).toBe(1);
  expect(d.added).toBe(1);
});

test("an untracked file is all-added, without asking git to diff it", async () => {
  const d = await gitDiff(root, "new.txt");
  expect(d.ok).toBe(true);
  if (!d.ok || !d.repo) throw new Error("expected a repo");
  expect(d.marks.length).toBe(2); // "brand new\n" -> one line plus the tail
  expect(d.marks.every((m) => m.kind === "added")).toBe(true);
});

test("an ignored file has no gutter, and is not diffed as if it were new", async () => {
  /* Without the check-ignore branch every line of every file in node_modules
   * would come back marked added the first time somebody opened one. */
  const d = await gitDiff(root, "ignored/junk.txt");
  expect(d.ok).toBe(true);
  if (!d.ok || !d.repo) throw new Error("expected a repo");
  expect(d.marks).toEqual([]);
  expect([d.added, d.modified, d.deleted]).toEqual([0, 0, 0]);
});

test("an unchanged tracked file has an empty gutter", async () => {
  const d = await gitDiff(root, "README.md");
  expect(d.ok).toBe(true);
  if (!d.ok || !d.repo) throw new Error("expected a repo");
  expect(d.marks).toEqual([]);
});

test("a diff outside a repo answers repo:false rather than failing", async () => {
  const plain = await rootOf(await realpath(await tmpDir("cyc-nodiff-")));
  await writeFile(join(plain, "x.txt"), "hi\n");
  const d = await gitDiff(plain, "x.txt");
  expect(d.ok).toBe(true);
  if (!d.ok) return;
  expect(d.repo).toBe(false);
});

test("a diff for a path outside the root is refused", async () => {
  const d = await gitDiff(root, "out/secret.txt");
  expect(d.ok).toBe(false);
  expect((await gitDiff(root, "../secret.txt")).ok).toBe(false);
  expect((await gitDiff(root, "/etc/passwd")).ok).toBe(false);
});

// -------------------------------------------------------------- the parsers

test("porcelain: a path with a space survives, and a rename eats its old name", () => {
  const out = "M  docs/my file.md\0R  new.ts\0old.ts\0?? fresh.txt\0!! node_modules\0";
  const { files } = parsePorcelain(out);
  expect(files["docs/my file.md"]).toBe("M");
  expect(files["new.ts"]).toBe("R");
  expect(files["old.ts"]).toBeUndefined();
  expect(files["fresh.txt"]).toBe("U");
  expect(files["node_modules"]).toBe("I");
});

test("porcelain: a copy record eats its source, and a directory loses its slash", () => {
  const out = "C  copy.ts\0orig.ts\0?? newdir/\0!! build/\0";
  const { files } = parsePorcelain(out);
  expect(files["copy.ts"]).toBe("R");
  expect(files["orig.ts"], "the source of a copy is not a row of its own").toBeUndefined();
  expect(files["newdir"], "an untracked directory is one row, without the slash").toBe("U");
  expect(files["build"]).toBe("I");
});

test("porcelain: a record it cannot read is skipped rather than guessed at", () => {
  const { files } = parsePorcelain("ZZ weird.ts\0M  real.ts\0   \0");
  expect(files["weird.ts"], "an unknown XY pair was invented a code").toBeUndefined();
  expect(files["real.ts"], "one bad record must not eat the rest of the status").toBe("M");
});

test("porcelain: a status bigger than the cap is cut and SAYS it was cut", () => {
  /* A repo mid-rebase, or a fresh clone of something enormous, is 50k records.
   * Truncating silently would draw a tree that claims the rest is clean. */
  let out = "";
  for (let i = 0; i < GIT_MAX_ENTRIES + 25; i++) out += `?? f${i}.txt\0`;
  const { files, truncated } = parsePorcelain(out);
  expect(truncated).toBe(true);
  expect(Object.keys(files).length).toBe(GIT_MAX_ENTRIES);
  expect(parsePorcelain("?? one.txt\0").truncated).toBe(false);
});

test("porcelain: the worse of the two columns wins", () => {
  expect(codeOf("AM")).toBe("M");
  expect(codeOf(" M")).toBe("M");
  expect(codeOf("A ")).toBe("A");
  expect(codeOf("UU")).toBe("C");
  expect(codeOf("DD")).toBe("C");
  expect(codeOf("??")).toBe("U");
  expect(codeOf("!!")).toBe("I");
});

test("porcelain: 'worse' means the severity order, on every pair", () => {
  /* C > D > M > A > R > U. A staged add that was then deleted is a deletion, a
   * rename that was then edited is an edit; calling either by the other letter
   * hides work he has not committed. */
  expect(codeOf("MD")).toBe("D");
  expect(codeOf("AD")).toBe("D");
  expect(codeOf("RM")).toBe("M");
  expect(codeOf("MA")).toBe("M");
  expect(codeOf("T ")).toBe("M");   // a type change reads as a modification
  expect(codeOf("C ")).toBe("R");   // a copy reads as a rename
  expect(codeOf("AU")).toBe("C");   // any U on either side is a conflict
  expect(codeOf("UD")).toBe("C");
  expect(codeOf("AA")).toBe("C");
});

test("porcelain: a pair with nothing in it is not a change", () => {
  expect(codeOf("  ")).toBeNull();
  expect(codeOf("")).toBeNull();
  expect(codeOf("XY")).toBeNull();
});

test("hunks: added, modified and deleted are three different marks", () => {
  const diff = [
    "@@ -0,0 +1,2 @@",
    "@@ -10,2 +12,2 @@",
    "@@ -20,3 +22,0 @@",
    "@@ -30 +32 @@", // no comma: one line each
  ].join("\n");
  const { marks, added, modified, deleted } = parseHunks(diff);
  expect(marks).toContainEqual({ line: 1, kind: "added" });
  expect(marks).toContainEqual({ line: 2, kind: "added" });
  expect(marks).toContainEqual({ line: 12, kind: "modified" });
  expect(marks).toContainEqual({ line: 22, kind: "deleted" });
  expect(marks).toContainEqual({ line: 32, kind: "modified" });
  expect(added).toBe(2);
  expect(modified).toBe(3);
  expect(deleted).toBe(3);
});

test("hunks: an uneven replacement counts the overlap as modified and the rest as its own", () => {
  /* Two lines becoming five is two modifications and three additions, not five
   * of either; the footer's counts are what he reads to decide whether the
   * change is small. */
  const grew = parseHunks("@@ -10,2 +10,5 @@");
  expect([grew.modified, grew.added, grew.deleted]).toEqual([2, 3, 0]);
  expect(grew.marks.length).toBe(5);
  expect(grew.marks.every((m) => m.kind === "modified")).toBe(true);

  const shrank = parseHunks("@@ -10,5 +10,2 @@");
  expect([shrank.modified, shrank.added, shrank.deleted]).toEqual([2, 0, 3]);
  expect(shrank.marks.length).toBe(2);
});

test("hunks: a deletion at the top of a file has nowhere above to sit, so it sits on line 1", () => {
  /* `@@ -1,3 +0,0 @@`: git says the new-side line before the deletion is 0, and
   * there is no line 0 to draw a wedge on. */
  const { marks, deleted } = parseHunks("@@ -1,3 +0,0 @@");
  expect(marks).toEqual([{ line: 1, kind: "deleted" }]);
  expect(deleted).toBe(3);
});

test("hunks: text that is not a hunk header contributes nothing", () => {
  const { marks, added, modified, deleted } = parseHunks([
    "diff --git a/x b/x",
    "index 111..222 100644",
    "--- a/x",
    "+++ b/x",
    "not @@ a header @@",
    " @@ -1,1 +1,1 @@",   // indented: not a header either
  ].join("\n"));
  expect(marks).toEqual([]);
  expect([added, modified, deleted]).toEqual([0, 0, 0]);
  expect(parseHunks("")).toEqual({ marks: [], added: 0, modified: 0, deleted: 0 });
});
