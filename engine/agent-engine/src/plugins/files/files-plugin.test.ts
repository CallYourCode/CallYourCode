/* THE FILES PLUGIN'S RPC SEAM, DRIVEN AGAINST A REAL THROWAWAY REPO.
 *
 * The fs LOGIC (listing, reading, caps, traversal) is proven in files.test.ts.
 * This file proves the PLUGIN SEAM, end to end: a repo is built in a tmp dir
 * (one tracked file committed then modified, one untracked file), the session is
 * pointed at it, and every declared op is called the way the page calls it.
 * The assertions are on REAL output -- the tree lists the files, a read returns
 * the text, git status reports the change, the diff has the changed line, raw
 * refuses and caps -- so a seam that resolved the wrong root, dropped an arg or
 * swallowed a result fails here.
 *
 * The seam's own edges are here too: the raw-image op that replaced /fs/raw
 * (base64 + mime, and the TIGHTEST fit in the lane -- a raw image at the 10 MB
 * cap must serialize under the 16 MB reply cap), the traversal refusal carried
 * as a sentence, the missing-session sentence, and the page artifact's cap + sha.
 *
 *   bun test agent-engine/src/plugins/files/files-plugin.test.ts
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { filesPlugin } from "./index.ts";
import { rootOf, runGit, RAW_MAX_BYTES } from "../../storage/files.ts";
import { fsCapability, type PluginCore } from "../platform/core.ts";
import { PANEL_HTML_MAX_BYTES, RPC_REPLY_MAX_BYTES } from "../platform/spec.ts";
import { tmpDir } from "../../test-utils/tmp.ts";

const SID = "files-plugin-test-session";
const PAGE_PATH = resolve(import.meta.dir, "../../../../../app/dist/plugins/files-page.html");
let dir = "";

/* The plugin resolves cwd through core.read("cwd", id) and the fs verbs through
 * core.fs now; a fake core answers `dir` for this session and null for any other
 * (the missing-session path), backing core.fs with the real verbs. */
const core = {
  read: async (which: string, id: string) => (which === "cwd" && id === SID ? dir : null),
  fs: fsCapability,
} as unknown as PluginCore;
const plugin = filesPlugin(core);

const call = (op: string, args?: unknown, session: string | null = SID) =>
  plugin.rpc![op]({ session, agent: null }, args ?? {});

beforeAll(async () => {
  dir = await rootOf(await tmpDir("cyc-filesplugin-"));
  await runGit(dir, ["init", "-q", "-b", "main"]);
  await runGit(dir, ["config", "user.email", "t@t"]);
  await runGit(dir, ["config", "user.name", "Tester"]);
  await runGit(dir, ["config", "commit.gpgsign", "false"]);

  // a tracked file, committed then modified -> a real `git` status and `diff`
  await writeFile(join(dir, "tracked.txt"), "line one\nline two\n");
  await runGit(dir, ["add", "tracked.txt"]);
  await runGit(dir, ["commit", "-q", "-m", "first"]);
  await writeFile(join(dir, "tracked.txt"), "line one\nline TWO\n");

  // an untracked file -> list, read, and a U row in status
  await writeFile(join(dir, "hello.txt"), "hello world\n");
  // the fake core answers this cwd for SID; no session-state needed
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

test("list resolves the session's cwd, returning root, name and the entries", async () => {
  const r = (await call("list", { path: "" })) as
    { ok: boolean; root?: string; name?: string; entries?: { name: string }[] };
  expect(r.ok).toBe(true);
  expect(r.root).toBe(dir);
  expect(r.name).toBe(dir.split("/").pop()!);
  const names = r.entries!.map((e) => e.name);
  expect(names).toContain("hello.txt");
  expect(names).toContain("tracked.txt");
});

test("read returns the file's text", async () => {
  const r = (await call("read", { path: "hello.txt" })) as { ok: boolean; kind?: string; text?: string };
  expect(r.ok).toBe(true);
  expect(r.kind).toBe("text");
  expect(r.text).toBe("hello world\n");
});

test("git reports the repo's real status: the modified file M, the new file U", async () => {
  const r = (await call("git")) as
    { ok: boolean; repo?: boolean; files?: Record<string, string> };
  expect(r.ok).toBe(true);
  expect(r.repo).toBe(true);
  expect(r.files!["tracked.txt"]).toBe("M");
  expect(r.files!["hello.txt"]).toBe("U");
});

test("diff of a tracked file carries the change as a modified mark", async () => {
  const r = (await call("diff", { path: "tracked.txt" })) as
    { ok: boolean; repo?: boolean; marks?: { line: number; kind: string }[]; modified?: number };
  expect(r.ok).toBe(true);
  expect(r.repo).toBe(true);
  // line two changed in place: one modified mark, on the working-copy line
  expect(r.modified).toBe(1);
  expect(r.marks!.some((m) => m.kind === "modified" && m.line === 2)).toBe(true);
});

test("diff of an untracked file is the whole file, added", async () => {
  const r = (await call("diff", { path: "hello.txt" })) as
    { ok: boolean; added?: number; marks?: { kind: string }[] };
  expect(r.ok).toBe(true);
  // "hello world\n" is one line of text; split on "\n" counts the trailing empty
  expect(r.added).toBe(2);
  expect(r.marks!.every((m) => m.kind === "added")).toBe(true);
});

// -------------------------------------------------------------- the raw op edges

test("raw round-trips a real image's bytes as base64 with its mime", async () => {
  // a one-pixel PNG, written as bytes and asked back through the op
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64");
  await writeFile(join(dir, "pixel.png"), png);
  const r = (await call("raw", { path: "pixel.png" })) as
    { ok: boolean; base64?: string; mime?: string };
  expect(r.ok).toBe(true);
  expect(r.mime).toBe("image/png");
  expect(Buffer.from(r.base64!, "base64").equals(png)).toBe(true);
});

test("a missing session answers the native sentence", async () => {
  const r = (await call("read", { path: "hello.txt" }, "no-such-session")) as { ok: boolean; error?: string };
  expect(r.ok).toBe(false);
  expect(r.error).toBe("no such session on this engine");
});

test("raw refuses a path outside the session directory", async () => {
  const r = (await call("raw", { path: "../escape.png" })) as { ok: boolean; error?: string };
  expect(r.ok).toBe(false);
  expect(r.error).toBe("path is outside the session directory");
});

test("raw refuses a non-image", async () => {
  const r = (await call("raw", { path: "hello.txt" })) as { ok: boolean; error?: string };
  expect(r.ok).toBe(false);
  expect(r.error).toBe("not an image");
});

test("raw over the 10 MB cap answers the same sentence the native route did", async () => {
  const p = join(dir, "huge.png");
  await writeFile(p, Buffer.alloc(RAW_MAX_BYTES + 1024));
  const r = (await call("raw", { path: "huge.png" })) as { ok: boolean; error?: string };
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/^image is .* over the .* cap$/);
});

test("a raw image AT the cap serializes under the 16 MB reply cap (the tightest fit)", async () => {
  // a .png at RAW_MAX_BYTES: base64 is ~13.4 MB, plus the JSON envelope must
  // still fit RPC_REPLY_MAX_BYTES (16 MB). imageMimeOf keys on the extension,
  // so zero bytes with a .png name is a valid image for this fit check.
  const p = join(dir, "atcap.png");
  await writeFile(p, Buffer.alloc(RAW_MAX_BYTES));
  const r = (await call("raw", { path: "atcap.png" })) as
    { ok: boolean; base64?: string; mime?: string };
  expect(r.ok).toBe(true);
  expect(r.mime).toBe("image/png");
  expect(typeof r.base64).toBe("string");
  const wire = JSON.stringify({ ok: true, result: r });
  const bytes = new TextEncoder().encode(wire).length;
  expect(bytes).toBeLessThanOrEqual(RPC_REPLY_MAX_BYTES);
});

test("the read ops are exactly the panel's declared ops", () => {
  const ops = Object.keys(plugin.rpc!).sort();
  expect(ops).toEqual(["diff", "git", "list", "raw", "read"].sort());
});
