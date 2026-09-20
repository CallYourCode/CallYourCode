/* WHAT BOUNDS THE ATTACHMENT STORE, AND WHAT THAT BOUND IS NOT ALLOWED TO TOUCH.
 *
 * WHY THIS FILE EXISTS
 *
 * Attachments were the one store in this engine with no bound at all. Staging a
 * file POSTs it to /upload; SENDING it is a separate act the user may never
 * perform, so every attachment test left four small .txt files behind and
 * nothing ever removed them. 215 files had piled up that way, and because none
 * of it is irreplaceable nobody was ever going to notice.
 *
 * The sweep is the easy half. The half worth a test is the EXCEPTION: a file a
 * message in the chat log still points at must never be swept, whatever the
 * caps say. That path is a real path in a bubble and in an agent's hands, and
 * CHAT_KEEP is Infinity, so the message outlives any cap you pick. Deleting
 * under it turns a thumbnail into a 404 and a document card into a lie.
 *
 * WHAT IS REAL HERE, AND WHERE THE OLD FILE'S ENGINE WENT
 *
 * The old version booted an engine to get at two things: the real POST /upload
 * (which is what fires the sweep) and the BOOT sweep, whose reference set comes
 * from `restoredChats` rather than from live sessions. Both are reachable
 * without one:
 *
 *   - the route half is the REAL mediaRoutes over serveRoutes on port 0, over a
 *     REAL makeUploads instance in this test's own tmp dir. Real POSTs, real
 *     writes, the real sweep deciding on real mtimes.
 *   - the boot half is wireCore's own boot, which performs server.ts's ordering:
 *     uploads is built first, the agent records are restored NINTH, and the
 *     startup trim runs FOURTEENTH. Moving that trim above the restore would
 *     give it an empty reference set and a directory full of files it believes
 *     nobody wants, and the log would still say it worked. reset() re-runs that
 *     boot over a data dir this test has filled in between, which is exactly
 *     what a restart onto an inherited backlog is.
 *
 * The per-caller trim rules (the count boundary, a referenced file still
 * counting toward the cap, ids this engine never named) are unit-tested against
 * makeUploads directly in uploads-store.test.ts. This file is the two paths that
 * only exist once the module is wired into something.
 */

import { test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeUploads, UPLOAD_KEEP, type Uploads } from "./uploads.ts";
import { mediaRoutes } from "../routes/media.ts";
import { PANE, defaultSessionIdOf } from "../test-utils/fake-herdr.ts";
/* The harness id the fake herdr reports for PANE: what the disk records
 * (meta.json sessionId, the chat log) are keyed by, never the pane id. */
const PANE_SID = defaultSessionIdOf(PANE);
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { seedAgent, userMsg } from "../test-utils/builders.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";
import { wireCore, type WireCore } from "../test-utils/wire-core.ts";

/** An upload record as POST /upload answers with one. */
type Upload = { uploadId: string; name: string; path: string; image: boolean; size: number };

/* ---------------------------------------------------------------- the route */

let staging = "";
let uploads: Uploads | null = null;
let referenced = new Set<string>();
let owner = new Map<string, string>();
let http: ServedRoutes | null = null;

beforeAll(async () => {
  const root = await tmpDir("cyc-uploads-");
  staging = join(root, "staging", "uploads") + "/";
  referenced = new Set<string>();
  owner = new Map<string, string>();
  uploads = await makeUploads({
    stagingDir: staging,
    blobOwner: () => owner,
    /* The agent an adopted file moves under. A real agent id shape, because
     * agentUploadsDir() refuses anything else and a test that dodged that would
     * be proving adoption against a path the engine cannot build. */
    agentIdFor: () => "ag-uploads-test",
    referencedIds: () => referenced,
    log: () => {},
  });
  http = serveRoutes({ groups: [mediaRoutes], ctx: { uploads: uploads! } });
});

afterAll(() => { http?.stop(); });

/** Stage one attachment the way the composer does: POST /upload, raw body. */
async function stage(name: string, body: string): Promise<Upload> {
  const res = await http!.fetch("/upload", {
    method: "POST",
    headers: { "content-type": "text/plain", "x-filename": name },
    body,
  });
  if (!res.ok) throw new Error(`POST /upload ${name}: HTTP ${res.status}`);
  return (await res.json()) as Upload;
}

test("posting an attachment bounds the store, newest first", async () => {
  /* The sweep is fired by the route AFTER the write and is not awaited (the
   * answer is what the page is waiting on), so this waits for it to settle
   * rather than assuming it ran inside the response. */
  const debris = UPLOAD_KEEP + 5;
  const first = await stage("oldest.txt", "the first thing ever staged");
  for (let i = 0; i < debris; i++) await stage(`debris-${i}.txt`, `staged ${i}, never sent`);

  await until(async () => (await readdir(staging)).length <= UPLOAD_KEEP,
    { what: "the trim to bring staging back under the cap", timeoutMs: 4000 });

  const left = await readdir(staging);
  expect(left.length,
    `nothing bounds staging/uploads: ${left.length} files after staging ${debris + 1}`)
    .toBeLessThanOrEqual(UPLOAD_KEEP);
  // and it spent the OLDEST, which is what "newest first" means
  expect(left.some((n) => n.startsWith(first.uploadId)),
    "the trim kept the oldest file and deleted newer ones").toBe(false);

  /* The id OUTLIVES the file, deliberately: a composer that still names it
   * fails the whole message rather than sending a hole (bindOwnedUploads
   * reports it as missing instead of silently dropping the attachment). */
  expect(uploads!.minted.has(first.uploadId)).toBe(true);
  const bound = await uploads!.bindOwnedUploads([
    { uploadId: first.uploadId, name: first.name, path: "/forged", mime: "text/plain",
      size: 1, image: false } as never,
  ]);
  expect(bound.ups).toEqual([]);
  expect(bound.missing).toEqual(["oldest.txt"]);
});

test("the file a message points at is not what the trim spends", async () => {
  /* Staged FIRST so it is the oldest file in the directory and therefore the
   * first thing a newest-first sweep reaches, then buried under more than
   * UPLOAD_KEEP unreferenced ones. Nothing is stubbed: real POSTs, and the real
   * sweep deciding on real mtimes. */
  const kept = await stage("referenced.txt", "a message points at this");
  referenced.add(kept.uploadId);

  const debris = UPLOAD_KEEP + 5;
  for (let i = 0; i < debris; i++) await stage(`more-debris-${i}.txt`, `staged ${i}`);
  await until(async () => (await readdir(staging)).length <= UPLOAD_KEEP + 1,
    { what: "the trim to settle", timeoutMs: 4000 });

  const left = await readdir(staging);
  expect(left.some((n) => n.startsWith(kept.uploadId)),
    "the attachment a message still points at was swept. That path is in a bubble and in " +
    "an agent's hands, and CHAT_KEEP is Infinity: the message outlives any cap you pick, " +
    "so deleting under it turns a thumbnail into a 404 and a document card into a lie.")
    .toBe(true);

  // and it still SERVES, which is what the bubble and the agent need
  const res = await http!.fetch(`/upload/${kept.uploadId}`);
  expect(res.status, "the referenced attachment no longer serves").toBe(200);
  expect(await res.text()).toBe("a message points at this");
});

test("an adopted file is out of the sweep's reach for good, and still serves", async () => {
  /* ADOPTION is what really takes a sent attachment out of staging: the file
   * moves into its agent's own uploads dir when the message commits, so the
   * staging sweep cannot see it at all whatever the reference set says. */
  const sent = await stage("sent.txt", "this one was actually sent");
  await uploads!.adoptStagedUploads(PANE, [
    { uploadId: sent.uploadId, name: sent.name, path: sent.path, mime: "text/plain",
      size: sent.size, image: false } as never,
  ]);

  expect((await readdir(staging)).some((n) => n.startsWith(sent.uploadId)),
    "the adopted file is still sitting in staging").toBe(false);
  expect(owner.get(sent.uploadId), "adoption did not stamp the blob index").toBe("ag-uploads-test");

  // the sweep runs over a store that no longer holds it, and it still serves
  await uploads!.trimUploads("test");
  const res = await http!.fetch(`/upload/${sent.uploadId}`);
  expect(res.status, "an adopted attachment stopped serving").toBe(200);
  expect(await res.text()).toBe("this one was actually sent");
});

/* ------------------------------------------------------------- the boot sweep
 *
 * A DIFFERENT PATH, AND THE ONE THAT RUNS FIRST.
 *
 * Above, the reference set comes from a caller that has the message in hand. At
 * startup there are no sessions at all: herdr has reported nothing yet, and
 * every reference lives in `restoredChats`, read off the agent's chat log
 * seconds earlier. That is the OTHER branch of referencedUploads(), and it is
 * the branch that decides the fate of a directory which grew while there was no
 * bound -- the actual situation on the machine this ships to.
 *
 * So: a store already over the cap before the wiring exists, with the
 * referenced file deliberately the OLDEST, which is the last place a
 * newest-first sweep looks and the first place it deletes.
 */

let core: WireCore | null = null;
afterEach(async () => { await core?.stop(); core = null; });

test("the startup sweep bounds a backlog it inherited, and spares the referenced file", async () => {
  const keptId = "00000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const keptName = `${keptId}-referenced.txt`;
  const debris = UPLOAD_KEEP + 10;

  /* The first wiring exists only to own the dirs; everything below is written
   * into them while nothing is running, which is what a stopped engine's data
   * dir looks like (start: false, so no agent record is minted for the pane
   * before the seeded one below). reset() then performs server.ts's boot over it. */
  core = await wireCore({ with: ["sessions"], start: false });
  const dir = join(core.dir, "staging", "uploads");
  await mkdir(dir, { recursive: true });

  /* mtimes are set by hand: writing 211 files takes well under a second, so the
   * real ones would all share a timestamp and "oldest" would mean nothing. */
  const base = Date.now() / 1000 - 100_000;
  await writeFile(join(dir, keptName), "a message points at this");
  await utimes(join(dir, keptName), base, base);
  for (let i = 1; i <= debris; i++) {
    const n = `${String(i).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa-debris.txt`;
    await writeFile(join(dir, n), `staged ${i}, never sent`);
    await utimes(join(dir, n), base + i, base + i); // every one newer
  }

  // the chat log the engine restores, shaped exactly as a delivery writes it
  await seedAgent(core.root, PANE_SID, [userMsg("have a look", {
    upload: { uploadId: keptId, name: "referenced.txt", mime: "text/plain",
      size: 24, path: join(dir, keptName), image: false },
  })]);

  await core.reset({ start: true });
  await until(() => core!.sessions.size === 1, { what: "the re-booted pane to reconcile" });

  /* THE PREMISE, checked rather than assumed: without the restore there is
   * nothing referencing anything, and this would be a test of the ordinary case
   * wearing the exception's name. */
  const restored = core.byHandle(PANE)!.chat;
  expect(restored.some((m) => (m as { upload?: { uploadId?: string } }).upload?.uploadId === keptId),
    "the wiring restored no chat log, so nothing referenced anything").toBe(true);

  const left = await readdir(dir);
  expect(left.length,
    `the backlog was still ${left.length} files after boot, so nothing swept it`)
    .toBeLessThanOrEqual(UPLOAD_KEEP + 1);
  expect(left.includes(keptName),
    "the boot sweep deleted the attachment a RESTORED message still points at. The sweep is " +
    "a top-level await in boot: moving it above the chat restore hands it an empty reference " +
    "set and a directory of files it believes nobody wants, and the log still says it worked.")
    .toBe(true);

  /* And boot INHERITED the ids, so a composer naming one of the files this
   * sweep just took fails its message rather than sending a hole. */
  expect(core.uploads!.minted.has(keptId)).toBe(true);
});
