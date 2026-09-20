/* THE GIT PLUGIN'S RPC SEAM, DRIVEN AGAINST A REAL THROWAWAY REPO.
 *
 * The git LOGIC (parsers, caps, traversal) is proven against real repos in
 * gitpane.test.ts. This file proves the PLUGIN SEAM the plugin conversion added, and
 * it proves it end to end: a repo is built in a tmp dir with git (a commit, a
 * staged change, a later unstaged edit, a diverged branch), the session is
 * pointed at it, and every declared op is called the way the page calls it. The
 * assertions are on REAL output -- a diff carries its changed lines, the branch
 * list names the branches, a commit's diff is the commit -- so a seam that
 * resolved the wrong root, dropped an arg, or swallowed a result would fail here
 * and not only in the logic tests one layer down.
 *
 * The seam's own rules are here too: session -> cwd resolution, the validation
 * refusals carried as result sentences (not thrown), the missing-session
 * sentence, that the old write paths are absent as ops, and that the served page
 * artifact is under the cap and matches the sha the app build recorded.
 *
 *   bun test agent-engine/src/plugins/git/git-plugin.test.ts
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gitPlugin } from "./index.ts";
import { runGit, rootOf } from "../../storage/files.ts";
import { fsCapability, type PluginCore } from "../platform/core.ts";
import { PANEL_HTML_MAX_BYTES } from "../platform/spec.ts";
import { tmpDir } from "../../test-utils/tmp.ts";

const SID = "git-plugin-test-session";
const PAGE_PATH = resolve(import.meta.dir, "../../../../../app/dist/plugins/git-page.html");
let dir = "";
let firstSha = "";

/* The plugin resolves the session's cwd through core.read("cwd", id) now, not by
 * reaching session-state: a fake core answers `dir` for this session (and null
 * for any other, which is the missing-session path), and backs core.fs with the
 * real fs/git verbs. This is what proves the layering -- the seam goes through
 * the contract, not the engine internals. */
const core = {
  read: async (which: string, id: string) => (which === "cwd" && id === SID ? dir : null),
  fs: fsCapability,
} as unknown as PluginCore;
const plugin = gitPlugin(core);

/* Call an op exactly as routes/plugin.ts would: {session, agent} ctx + args. */
const call = (op: string, args?: unknown, session: string | null = SID) =>
  plugin.rpc![op]({ session, agent: null }, args ?? {});

/** git, run beside the module under test so the two can be compared. */
async function git(args: string[]): Promise<string> {
  const r = await runGit(dir, args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.err}`);
  return r.out;
}

beforeAll(async () => {
  dir = await rootOf(await tmpDir("cyc-gitplugin-"));
  await runGit(dir, ["init", "-q", "-b", "main"]);
  await runGit(dir, ["config", "user.email", "t@t"]);
  await runGit(dir, ["config", "user.name", "Tester"]);
  await runGit(dir, ["config", "commit.gpgsign", "false"]);

  // one commit on main -> HEAD, the log, and what `show` renders
  await writeFile(join(dir, "a.txt"), "one\n");
  await runGit(dir, ["add", "a.txt"]);
  await runGit(dir, ["commit", "-q", "-m", "first"]);
  firstSha = (await git(["rev-parse", "HEAD"])).trim();

  // a branch that forks and gains a commit of its own -> branches, log, compare
  await runGit(dir, ["branch", "feature"]);
  await runGit(dir, ["checkout", "-q", "feature"]);
  await writeFile(join(dir, "feat.txt"), "brand new\n");
  await runGit(dir, ["add", "feat.txt"]);
  await runGit(dir, ["commit", "-q", "-m", "add feat"]);
  await runGit(dir, ["checkout", "-q", "main"]);

  /* a.txt: staged one line, then a SECOND edit left unstaged. The two sides are
   * different diffs, which is the whole point of `side` being validated and not
   * defaulted -- patch/change must answer the side they were asked for. */
  await writeFile(join(dir, "a.txt"), "one\nstaged line\n");
  await runGit(dir, ["add", "a.txt"]);
  await writeFile(join(dir, "a.txt"), "one\nstaged line\nunstaged line\n");
  // the fake core answers this cwd for SID (set above); no session-state needed
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("the panel serves the repository dist plugin page under the 1 MB cap", async () => {
  const html = await plugin.panel!.html();
  expect(html).toBe(await Bun.file(PAGE_PATH).text());
  const bytes = new TextEncoder().encode(html).length;
  expect(bytes).toBeLessThanOrEqual(PANEL_HTML_MAX_BYTES);
});

// ------------------------------------------------------- real output per op

test("pane resolves the session's cwd and reads the repo's real state", async () => {
  const r = (await call("pane")) as {
    ok: boolean; repo?: boolean; branch?: string;
    staged?: { path: string; code: string }[]; unstaged?: { path: string; code: string }[];
  };
  expect(r.ok).toBe(true);
  expect(r.repo).toBe(true);
  expect(r.branch).toBe("main");
  // the staged edit and the later unstaged edit are both a.txt, in both lists
  expect(r.staged!.find((x) => x.path === "a.txt")?.code).toBe("M");
  expect(r.unstaged!.find((x) => x.path === "a.txt")?.code).toBe("M");
});

test("patch answers the staged side, and it is not the unstaged side", async () => {
  const r = (await call("patch", { path: "a.txt", side: "staged" })) as
    { ok: boolean; lines?: { k: string; t: string }[]; added?: number };
  expect(r.ok).toBe(true);
  expect(r.lines!.some((l) => l.k === "add" && l.t === "staged line")).toBe(true);
  expect(r.lines!.some((l) => l.k === "add" && l.t === "unstaged line")).toBe(false);
  expect(r.added).toBe(1);
});

test("patch answers the unstaged side, and it is not the staged side", async () => {
  const r = (await call("patch", { path: "a.txt", side: "unstaged" })) as
    { ok: boolean; lines?: { k: string; t: string }[] };
  expect(r.ok).toBe(true);
  expect(r.lines!.some((l) => l.k === "add" && l.t === "unstaged line")).toBe(true);
  expect(r.lines!.some((l) => l.k === "add" && l.t === "staged line")).toBe(false);
});

test("show renders a commit's own diff by its sha", async () => {
  const r = (await call("show", { sha: firstSha })) as
    { ok: boolean; files?: number; lines?: { k: string; t: string }[] };
  expect(r.ok).toBe(true);
  expect(r.files).toBe(1);
  // the first commit added a.txt with its single line
  expect(r.lines!.some((l) => l.k === "add" && l.t === "one")).toBe(true);
});

test("change lists the staged files, each carrying its own diff", async () => {
  const r = (await call("change", { what: "staged" })) as {
    ok: boolean; commit?: unknown;
    files?: { path: string; code: string; lines: { k: string; t: string }[] }[];
  };
  expect(r.ok).toBe(true);
  expect(r.commit).toBe(null); // a working change is not a commit
  const a = r.files!.find((f) => f.path === "a.txt")!;
  expect(a.code).toBe("M");
  expect(a.lines.some((l) => l.k === "add" && l.t === "staged line")).toBe(true);
  expect(a.lines.some((l) => l.k === "add" && l.t === "unstaged line")).toBe(false);
});

test("change lists the unstaged files, with the later edit and not the staged one", async () => {
  const r = (await call("change", { what: "unstaged" })) as {
    ok: boolean; files?: { path: string; lines: { k: string; t: string }[] }[];
  };
  expect(r.ok).toBe(true);
  const a = r.files!.find((f) => f.path === "a.txt")!;
  expect(a.lines.some((l) => l.k === "add" && l.t === "unstaged line")).toBe(true);
  expect(a.lines.some((l) => l.k === "add" && l.t === "staged line")).toBe(false);
});

test("change reads a commit by sha, and says who made it", async () => {
  const r = (await call("change", { what: "commit", sha: firstSha })) as {
    ok: boolean; commit?: { sha: string; subject: string; author: string };
    files?: { path: string; code: string }[];
  };
  expect(r.ok).toBe(true);
  expect(r.commit?.sha).toBe(firstSha);
  expect(r.commit?.subject).toBe("first");
  expect(r.commit?.author).toBe("Tester");
  expect(r.files!.find((f) => f.path === "a.txt")?.code).toBe("A");
});

test("branches names every local branch and marks the one checked out", async () => {
  const r = (await call("branches")) as {
    ok: boolean; repo?: boolean; head?: string; defaultBranch?: string;
    branches?: { name: string; current: boolean }[];
  };
  expect(r.ok).toBe(true);
  expect(r.repo).toBe(true);
  expect(r.branches!.map((b) => b.name).sort()).toEqual(["feature", "main"]);
  expect(r.head).toBe("main");
  expect(r.defaultBranch).toBe("main");
  expect(r.branches!.find((b) => b.name === "feature")?.current).toBe(false);
  expect(r.branches!.find((b) => b.name === "main")?.current).toBe(true);
});

test("log is a ref's history, newest first", async () => {
  const onMain = (await call("log", { ref: "main" })) as
    { ok: boolean; log?: { subject: string }[] };
  expect(onMain.ok).toBe(true);
  expect(onMain.log!.map((c) => c.subject)).toEqual(["first"]);

  const onFeat = (await call("log", { ref: "feature" })) as
    { ok: boolean; log?: { subject: string }[] };
  expect(onFeat.ok).toBe(true);
  expect(onFeat.log!.map((c) => c.subject)).toEqual(["add feat", "first"]);
});

test("compare vs merge-base is what the branch added since it forked", async () => {
  const r = (await call("compare", { ref: "feature", against: "mergebase" })) as {
    ok: boolean; commits?: { subject: string }[];
    files?: { path: string; code: string; lines: { k: string; t: string }[] }[];
  };
  expect(r.ok).toBe(true);
  expect(r.commits!.map((c) => c.subject)).toEqual(["add feat"]);
  const feat = r.files!.find((f) => f.path === "feat.txt")!;
  expect(feat.code).toBe("A");
  expect(feat.lines.some((l) => l.k === "add" && l.t === "brand new")).toBe(true);
});

// -------------------------------------------------------------- the seam's rules

test("a missing session answers the native sentence, not a throw", async () => {
  const r = (await call("pane", {}, "no-such-session")) as { ok: boolean; error?: string };
  expect(r.ok).toBe(false);
  expect(r.error).toBe("no such session on this engine");
});

test("patch refuses an unknown side as a result sentence (not defaulted, not thrown)", async () => {
  const r = (await call("patch", { path: "a.txt", side: "bogus" })) as { ok: boolean; error?: string };
  expect(r.ok).toBe(false);
  expect(r.error).toBe("side must be staged or unstaged");
});

test("change refuses an unknown what", async () => {
  const r = (await call("change", { what: "bogus" })) as { ok: boolean; error?: string };
  expect(r.ok).toBe(false);
  expect(r.error).toBe("what must be commit, staged or unstaged");
});

test("compare refuses an unknown against", async () => {
  const r = (await call("compare", { ref: "main", against: "bogus" })) as { ok: boolean; error?: string };
  expect(r.ok).toBe(false);
  expect(r.error).toBe("against must be mergebase or main");
});

test("the read ops are exactly the panel's declared ops; the write paths are absent", () => {
  const ops = Object.keys(plugin.rpc!).sort();
  expect(ops).toEqual(["branches", "change", "compare", "log", "pane", "patch", "show"].sort());
  // #368: the pane is read-only. stage/unstage/commit/push are not ops -- an
  // unknown op 404s at the route, replacing fsgit's old 405.
  for (const w of ["stage", "unstage", "commit", "push"]) {
    expect(plugin.rpc![w]).toBeUndefined();
  }
});
