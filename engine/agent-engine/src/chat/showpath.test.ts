/* WHERE `show` MAY READ FROM (task 593).
 *
 * The session's cwd used to be the only root, which refused every page an agent
 * wrote into its scratchpad: the harness hands sessions a scratchpad under
 * /tmp/claude-<uid>/... and tells them to prefer it over the project tree, so
 * the natural place to write a throwaway page was exactly the place `show`
 * would not read. Three roots now: the cwd, the OS tmpdir, and the
 * /tmp/claude-* scratchpad tree (its own PREFIX, because on macOS the OS tmpdir
 * is /var/folders/... while the scratchpad stays under /tmp).
 *
 * Both halves live here. show.test.ts is the rest of the show policy (kinds,
 * caps, inline rules) and is owned elsewhere; the path boundary is one subject
 * and reads better in one file:
 *
 *   THE RULE (unit): showPathAllowed, including the two things that make it a
 *   confinement rather than a string test -- the trailing "/" that stops
 *   /tmp/notify-harness2 matching a root of /tmp/notify-harness, and the
 *   scratchpad being a prefix rather than a directory.
 *
 *   THE ROUTE (seam): onShow enforcing it over the real handler, with the real
 *   realpath resolution in front of it. This is where a symlink out of an
 *   allowed root, and a path that climbs out with .., have to die -- the rule
 *   itself never sees them, because resolve-then-prefix-check is the discipline
 *   and the resolve is the handler's job.
 *
 *   bun test agent-engine/src/chat/showpath.test.ts
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showPathAllowed } from "./show.ts";
import { initShowHandler, onShow, type ShowSession } from "./show-handler.ts";
import { initChatlog } from "./chatlog.ts";
import { blobOwner, docDirFor } from "../sessions/session-state.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import type { Sock } from "../transport/sock.ts";

/* ======================================================================= UNIT
 * showPathAllowed, on realpaths. The caller resolves first; this only decides.
 */

const ROOTS = { cwd: "/home/agent/project", tmp: "/var/folders/xy/T", claudeTmp: "/tmp/claude-" };

test("a file under the session cwd is allowed, and so is the cwd itself", () => {
  expect(showPathAllowed("/home/agent/project/notes.md", ROOTS)).toBe(true);
  expect(showPathAllowed("/home/agent/project/deep/nested/page.html", ROOTS)).toBe(true);
  expect(showPathAllowed("/home/agent/project", ROOTS)).toBe(true);
});

test("a file under the OS tmpdir is allowed even though it is nowhere near the cwd", () => {
  /* THE TASK-593 ALLOWANCE. An agent writing a throwaway page into its scratch
   * dir was refused by the cwd-only rule, which is why nobody could show one. */
  expect(showPathAllowed("/var/folders/xy/T/scratch-note.md", ROOTS)).toBe(true);
  expect(showPathAllowed("/var/folders/xy/T", ROOTS)).toBe(true);
});

test("the scratchpad is a PREFIX, so every per-session tree under it is allowed", () => {
  /* /tmp/claude-<uid>/<project-hash>/<session>/scratchpad. It is a prefix and
   * not a directory on purpose: the uid segment differs per user and macOS
   * keeps the OS tmpdir somewhere else entirely, so the tmp root above would
   * never cover it. */
  expect(showPathAllowed("/tmp/claude-1000/proj/sess/scratchpad/page.html", ROOTS)).toBe(true);
  expect(showPathAllowed("/tmp/claude-0/x", ROOTS)).toBe(true);
});

test("a prefix SIBLING of a root is refused: /tmp/notify-harness2 is not /tmp/notify-harness", () => {
  /* The "/" appended to each root is the whole reason this is a confinement and
   * not a startsWith. Without it a directory whose name merely begins with the
   * cwd's name is inside it, and an agent could show anything by making one. */
  const roots = { cwd: "/tmp/notify-harness", tmp: "/var/folders/xy/T", claudeTmp: null };
  expect(showPathAllowed("/tmp/notify-harness/a.md", roots)).toBe(true);
  expect(showPathAllowed("/tmp/notify-harness2/a.md", roots)).toBe(false);
  expect(showPathAllowed("/tmp/notify-harness-old/secrets.env", roots)).toBe(false);
  expect(showPathAllowed("/tmp/notify-harnessX", roots)).toBe(false);
});

test("the tmp root gets the same sibling treatment as the cwd", () => {
  const roots = { cwd: "/home/agent/project", tmp: "/var/folders/xy/T", claudeTmp: null };
  expect(showPathAllowed("/var/folders/xy/T2/leak", roots)).toBe(false);
  expect(showPathAllowed("/var/folders/xy/Table/leak", roots)).toBe(false);
});

test("a path outside every root is refused", () => {
  for (const outside of ["/etc/hosts", "/etc/passwd", "/home/agent/.ssh/id_ed25519",
                         "/home/agent/other-project/secrets.env", "/", "/usr/bin/env"]) {
    expect(showPathAllowed(outside, ROOTS), `${outside} was allowed`).toBe(false);
  }
});

test("no scratchpad prefix means no scratchpad allowance", () => {
  /* claudeTmp is null when /tmp cannot be resolved at all. The honest answer is
   * to allow nothing extra, never to fall back to a bare "/tmp" that would open
   * every temp file on the host. */
  const roots = { ...ROOTS, claudeTmp: null };
  expect(showPathAllowed("/tmp/claude-1000/proj/page.html", roots)).toBe(false);
  expect(showPathAllowed("/tmp/anything", roots)).toBe(false);
});

test("a near-miss on the scratchpad prefix is not the scratchpad", () => {
  expect(showPathAllowed("/tmp/claudex/page.html", ROOTS)).toBe(false);
  expect(showPathAllowed("/tmp/claude/page.html", ROOTS)).toBe(false);
  expect(showPathAllowed("/tmpclaude-1000/page.html", ROOTS)).toBe(false);
});

test("the rule is a prefix check on a REALPATH, and is not safe on a raw one", () => {
  /* Written down because it is the sharpest edge in this file. showPathAllowed
   * does string work; it is not a resolver, so an UNRESOLVED climb out of the
   * cwd still starts with the cwd and it says yes. That is not a bug in the
   * rule, it is its contract -- and it is precisely why onShow realpaths both
   * the candidate and the cwd BEFORE asking. If anyone ever moves this call in
   * front of the resolve, the seam tests below fail; this one says why. */
  expect(showPathAllowed("/home/agent/project/../../etc/hosts", ROOTS)).toBe(true);
  // resolved, which is what the handler actually passes, it is a refusal
  expect(showPathAllowed("/etc/hosts", ROOTS)).toBe(false);
});

/* ======================================================================= SEAM
 * The real onShow, with the real realpath in front of the rule. No engine.    */

const SID = "w4:p1";
const AGENT_ID = "ag-showpath";
const OLD_DATA_DIR = process.env.CYC_DATA_DIR;

let cwdDir = "";
let elsewhere = "";
const replies: Array<Record<string, any>> = [];
const ws = { data: { sessionId: SID } } as unknown as Sock;
const session: ShowSession = { id: SID, chat: [], cwd: "" };

beforeAll(async () => {
  const data = await tmpDir("cyc-showpath-data-");
  process.env.CYC_DATA_DIR = data;
  cwdDir = await tmpDir("cyc-showpath-cwd-");
  elsewhere = await tmpDir("cyc-showpath-else-");
  session.cwd = cwdDir;

  initChatlog({
    chatOf: () => session.chat,
    restoredChats: () => new Map(),
    persistPatch: () => {},
    broadcast: () => {},
    chatRefFor: () => ({ aid: AGENT_ID, chatId: "chat-1" }),
    indexMsgBlobs: () => {},
    appendMsg: () => {},        // this file is about the path gate, not the log
    appendRec: () => {},
  });
  initShowHandler({
    sessionOf: (id) => id === SID ? session : undefined,
    agentIdFor: () => AGENT_ID,
    claimBlob: (docId, aid) => { blobOwner.set(docId, aid); },
    docDirFor,
    send: (_ws, msg) => { replies.push(msg as Record<string, any>); },
    broadcast: () => {},
    notifyUnlessWatched: () => {},
    sessionPushTitle: () => "showpath",
    noteReply: () => {},
  });
});

afterAll(() => {
  blobOwner.clear();
  if (OLD_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = OLD_DATA_DIR;
});

/** Run one `show` and hand back the `shown` ack it replied with. */
async function show(path: string): Promise<{ ok: boolean; message: string; path: string }> {
  const before = replies.length;
  await onShow(ws, { t: "show", path });
  const ack = replies.slice(before).find((m) => m.t === "shown" && m.path === path);
  if (!ack) throw new Error(`no shown ack for ${path}: ${JSON.stringify(replies.slice(before))}`);
  return ack as { ok: boolean; message: string; path: string };
}

test("a file under the OS tmpdir but outside the session cwd is shown", async () => {
  /* The acceptance case for 593, at the handler. `elsewhere` is a sibling of
   * the cwd under the same tmp root, so only the tmpdir allowance can have let
   * it through: the cwd rule alone would refuse it, which is what it did. */
  const path = join(elsewhere, "scratch-note.md");
  await writeFile(path, "# From the scratchpad\n\nWritten outside the cwd, shown anyway.\n");
  const m = await show(path);
  expect(m.ok, `refused: ${m.message}`).toBe(true);
});

test("a file inside the session cwd is shown", async () => {
  const path = join(cwdDir, "in-cwd.md");
  await writeFile(path, "# in the cwd\n");
  expect((await show(path)).ok).toBe(true);
});

test("a file outside every root is refused, and the refusal NAMES the roots", async () => {
  /* The agent reading this is the one who can move the file, and "not allowed"
   * with no list sends it guessing. All three roots have to be in the sentence:
   * the cwd it is in, the OS temp dir, and the scratchpad prefix. */
  const m = await show("/etc/hosts");
  expect(m.ok).toBe(false);
  expect(m.message).toContain("outside the allowed roots");
  expect(m.message).toContain(cwdDir);              // the cwd, spelled out
  expect(m.message).toContain("the OS temp dir");
  expect(m.message).toContain("/tmp/claude-*");
});

test("a path that CLIMBS out of an allowed root is refused after it is resolved", async () => {
  /* The prefix check happens on the realpath, so `<cwd>/../../etc/hosts` is
   * /etc/hosts by the time the rule sees it. If the resolve were ever dropped,
   * this string starts with the cwd and would sail through. */
  const climb = join(cwdDir, "..", "..", "etc", "hosts");
  const m = await show(climb);
  expect(m.ok, "a .. climb out of the cwd was shown").toBe(false);
  expect(m.message).toContain("outside the allowed roots");
});

test("a SYMLINK inside an allowed root cannot reach outside it", async () => {
  /* The other half of resolve-then-check, and the one an agent can create for
   * itself: a link in its own cwd pointing at /etc/hosts. Refusing this is why
   * the handler realpaths rather than normalising. */
  const link = join(cwdDir, "innocent.md");
  await symlink("/etc/hosts", link).catch(() => {});
  const m = await show(link);
  expect(m.ok, "a symlink out of the cwd was followed and shown").toBe(false);
  expect(m.message).toContain("outside the allowed roots");
});

test("a symlink that stays inside an allowed root is still shown", async () => {
  // the confinement must not become "no symlinks": a link within the roots is
  // an ordinary file and refusing it would break real project layouts
  const target = join(cwdDir, "real-note.md");
  await writeFile(target, "# real\n");
  const link = join(cwdDir, "link-note.md");
  await symlink(target, link).catch(() => {});
  expect((await show(link)).ok).toBe(true);
});

test("a relative path is refused before anything is resolved", async () => {
  // "../../etc/hosts" resolved against the ENGINE's cwd would be a different
  // tree entirely; the only safe answer to a path with no root is to refuse it
  for (const rel of ["notes.md", "../../etc/hosts", "./x", ""]) {
    const m = await show(rel);
    expect(m.ok, `${JSON.stringify(rel)} was accepted as a path`).toBe(false);
    expect(m.message).toBe("path must be absolute");
  }
});

test("a path that does not exist is 'file not found', not a root complaint", async () => {
  const m = await show(join(cwdDir, "never-written.md"));
  expect(m.ok).toBe(false);
  expect(m.message).toBe("file not found");
});

test("a session the engine does not know shows nothing at all", async () => {
  /* The gate before the path gate: a socket with no registered session has no
   * cwd, so there is no root to check against and nothing may be read. */
  const stranger = { data: { sessionId: "not-a-session" } } as unknown as Sock;
  const before = replies.length;
  await onShow(stranger, { t: "show", path: join(cwdDir, "in-cwd.md") });
  const ack = replies.slice(before).at(-1)!;
  expect(ack.ok).toBe(false);
  expect(ack.message).toContain("not registered with the engine");
});

test("the roots the handler resolved really are this host's temp roots", async () => {
  /* A sanity pin on the seam above: the tmpdir allowance only means anything if
   * the fixture dirs this file writes are actually under the root the handler
   * computed. On a host where TMPDIR pointed elsewhere the acceptance test
   * would pass for the wrong reason, and this says so. */
  const tmpReal = await realpath(tmpdir());
  expect(await realpath(elsewhere)).toStartWith(tmpReal + "/");
  await mkdir(join(cwdDir, "nested"), { recursive: true });
  expect(showPathAllowed(await realpath(join(cwdDir, "nested")),
    { cwd: await realpath(cwdDir), tmp: tmpReal, claudeTmp: null })).toBe(true);
});
