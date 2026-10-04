/* The upload store (uploads.ts): minted inheritance, owner-path confinement,
 * bind (forge drop / missing refusal), adoption, retention. A scratch dir per
 * test; no engine.
 *
 * CYC_DATA_DIR is set ONCE at file scope (agentUploadsDir resolves under it)
 * and restored in afterAll; every test takes its own staging directory and its
 * own agent id under that one base, so nothing is shared but the root.
 *
 *   bun test agent-engine/src/chat/uploads-store.test.ts
 */

import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdir, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeUploads, uploadIdsOf, UPLOAD_KEEP, type Uploads } from "./uploads.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import type { ChatMsg, UploadRec } from "./chatmsg.ts";

let base = "";
const oldEnv = process.env.CYC_DATA_DIR;
beforeAll(async () => {
  base = await tmpDir("cyc-up-");
  process.env.CYC_DATA_DIR = base; // agentUploadsDir resolves under here
});
afterAll(() => {
  if (oldEnv === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = oldEnv;
});

const ID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ID_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const rec = (id: string, name = "f.txt"): UploadRec =>
  ({ uploadId: id, name, mime: "text/plain", size: 1, path: "/forged/by/client", image: false });

type Store = { u: Uploads; staging: string; logged: string[]; owner: Map<string, string>; agentId: string };

/** One store, in a staging dir and under an agent id nobody else in this file
 *  uses, so the tests can share one CYC_DATA_DIR without sharing state. */
async function store(name: string, referenced: string[] = []): Promise<Store> {
  const staging = join(base, name, "staging", "uploads") + "/";
  const owner = new Map<string, string>();
  const logged: string[] = [];
  const agentId = `ag-${name}`;
  const u = await makeUploads({
    stagingDir: staging,
    blobOwner: () => owner,
    agentIdFor: () => agentId,
    referencedIds: () => new Set(referenced),
    log: (e) => logged.push(e),
  });
  return { u, staging, logged, owner, agentId };
}

test("minted set inherits what was already on disk at boot", async () => {
  const staging = join(base, "boot", "staging", "uploads");
  await Bun.write(join(staging, `${ID_A}-old.txt`), "x");
  const { u } = await store("boot");
  expect(u.minted.has(ID_A)).toBe(true);
  expect(u.minted.has(ID_B)).toBe(false);
});

test("boot inheritance takes only well-formed ids, and keeps the file's own id", async () => {
  /* The sweep may have deleted the file but the id stays minted, so a composer
   * that still names it fails the whole message instead of sending a hole. That
   * only works if boot reads the id off the NAME and refuses anything else. */
  const staging = join(base, "boot2", "staging", "uploads");
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, `${ID_A}-a.txt`), "x");
  await writeFile(join(staging, "not-an-id.txt"), "x");
  await writeFile(join(staging, `${ID_B}.txt`), "x");        // no dash after the id
  await writeFile(join(staging, `${ID_B.toUpperCase()}-u.txt`), "x"); // uppercase hex is not our mint
  const { u } = await store("boot2");
  expect([...u.minted]).toEqual([ID_A]);
});

test("a staging dir that does not exist yet boots to an empty minted set", async () => {
  const { u, staging } = await store("fresh");
  expect([...u.minted]).toEqual([]);
  // and the store made its own dir, private
  expect(await readdir(staging)).toEqual([]);
});

test("ownedUploadPath refuses junk ids and files outside the store", async () => {
  const { u } = await store("junk");
  expect(await u.ownedUploadPath("../etc/passwd")).toBeNull();
  expect(await u.ownedUploadPath("short")).toBeNull();
  expect(await u.ownedUploadPath(ID_A)).toBeNull(); // nothing staged
});

test("ownedUploadPath refuses every id shape that could reach out of the dir", async () => {
  /* The id is the ONLY thing a client controls that touches a path here, so the
   * charset is the whole defence. Anything with a slash, a dot segment, a null
   * or a glob character has to be null before it ever reaches the scan. */
  const { u } = await store("traversal");
  for (const bad of [
    "", "..", "../../etc/passwd", `../${ID_A}`, `${ID_A}/..`, `${ID_A}\0`,
    "a".repeat(36), "*".repeat(36), `${ID_A}*`, `${ID_A} `, ID_A.slice(0, 35),
    `${ID_A}a`, "/etc/passwd/aaaaaaaaaaaaaaaaaaaaaaaa",
  ]) {
    expect(await u.ownedUploadPath(bad)).toBeNull();
  }
});

test("a symlink inside staging pointing OUT of it is refused", async () => {
  /* The confinement is the files.ts pattern: realpath the root, realpath the
   * file, then inside(). A name that matches the glob is not enough; if the
   * bytes live outside the store it is not ours to hand out. */
  const { u, staging } = await store("symlink");
  const outside = join(base, "symlink", "secret.txt");
  await writeFile(outside, "not yours");
  await symlink(outside, join(staging, `${ID_A}-innocent.txt`));
  expect(await u.ownedUploadPath(ID_A)).toBeNull();
});

test("ownedUploadPath falls through to the owning agent's dir via the blob index", async () => {
  const { u, owner, agentId } = await store("owned");
  const agentDir = join(base, "agents", agentId, "uploads");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, `${ID_A}-adopted.txt`), "x");
  // with no index entry the engine does not know where to look
  expect(await u.ownedUploadPath(ID_A)).toBeNull();
  owner.set(ID_A, agentId);
  expect(await u.ownedUploadPath(ID_A)).toBe(join(agentDir, `${ID_A}-adopted.txt`));
});

test("an index entry naming an agent with no uploads dir is answered null, not thrown", async () => {
  const { u, owner } = await store("noagentdir");
  owner.set(ID_A, "ag-nevercreated");
  expect(await u.ownedUploadPath(ID_A)).toBeNull();
});

test("bindOwnedUploads: found rebinds path, forged drops, minted-but-gone is missing", async () => {
  const { u, staging, logged } = await store("bind");
  await Bun.write(join(staging, `${ID_A}-real.txt`), "content");
  u.minted.add(ID_A);
  u.minted.add(ID_B); // minted once, file swept
  const { ups, missing } = await u.bindOwnedUploads([rec(ID_A), rec(ID_B), rec(ID_C)]);
  expect(ups.length).toBe(1);
  expect(ups[0].path).toBe(`${staging}${ID_A}-real.txt`); // the client's forged path is replaced
  expect(missing).toEqual(["f.txt"]);
  expect(logged).toContain("utterance.attach-dropped"); // the forge
});

test("bind keeps every other field of the record and only replaces the path", async () => {
  const { u, staging } = await store("bindfields");
  await Bun.write(join(staging, `${ID_A}-pic.png`), "png");
  const claimed: UploadRec = { uploadId: ID_A, name: "pic.png", mime: "image/png", size: 99,
    path: "/etc/shadow", image: true, at: 7 };
  const { ups } = await u.bindOwnedUploads([claimed]);
  expect(ups[0]).toEqual({ ...claimed, path: `${staging}${ID_A}-pic.png` });
  expect(claimed.path).toBe("/etc/shadow"); // the caller's record is not mutated in place
});

test("a minted-but-gone upload reports its id when the client sent no name", async () => {
  const { u } = await store("bindnoname");
  u.minted.add(ID_A);
  const { missing } = await u.bindOwnedUploads([rec(ID_A, "")]);
  // the refusal sentence has to name SOMETHING the person can recognise
  expect(missing).toEqual([ID_A]);
});

test("binding nothing is nothing: no logs, no missing", async () => {
  const { u, logged } = await store("bindempty");
  expect(await u.bindOwnedUploads([])).toEqual({ ups: [], missing: [] });
  expect(logged).toEqual([]);
});

test("adoption moves a staged file into the agent's own dir and stamps the index", async () => {
  const { u, staging, owner, agentId } = await store("adopt");
  await Bun.write(join(staging, `${ID_A}-note.txt`), "content");
  const r = rec(ID_A);
  r.path = `${staging}${ID_A}-note.txt`;
  await u.adoptStagedUploads("w1:p1", [r]);
  expect(r.path).toBe(join(base, "agents", agentId, "uploads", `${ID_A}-note.txt`));
  expect(await Bun.file(r.path).text()).toBe("content");
  expect(owner.get(ID_A)).toBe(agentId);
  // and the owner-dir lookup finds it there now
  u.minted.add(ID_A);
  expect(await u.ownedUploadPath(ID_A)).toBe(r.path);
});

test("adoption is idempotent: an already-adopted record is left where it is", async () => {
  const { u, staging, agentId } = await store("adopt2");
  await Bun.write(join(staging, `${ID_A}-note.txt`), "content");
  const r = rec(ID_A);
  r.path = `${staging}${ID_A}-note.txt`;
  await u.adoptStagedUploads("w1:p1", [r]);
  const adopted = r.path;
  await u.adoptStagedUploads("w1:p1", [r]); // the second accept of the same message
  expect(r.path).toBe(adopted);
  expect(await readdir(join(base, "agents", agentId, "uploads"))).toEqual([`${ID_A}-note.txt`]);
});

test("adoption ignores a path that is not under this engine's staging dir", async () => {
  // a record that came back from the log with an absolute path elsewhere must
  // not be dragged into an agent dir
  const { u, agentId } = await store("adopt3");
  const r = rec(ID_A);
  r.path = "/etc/passwd";
  await u.adoptStagedUploads("w1:p1", [r]);
  expect(r.path).toBe("/etc/passwd");
  expect(await readdir(join(base, "agents", agentId, "uploads")).catch(() => null)).toBeNull();
});

test("adopting an empty list creates no agent directory at all", async () => {
  const { u, agentId } = await store("adopt4");
  await u.adoptStagedUploads("w1:p1", []);
  expect(await readdir(join(base, "agents", agentId)).catch(() => null)).toBeNull();
});

test("a failed adoption leaves the record on its staged path rather than a dead one", async () => {
  /* The destination cannot be made (something else is sitting at that name). The
   * message still has to go with a path that resolves, so `path` is only moved
   * after the rename succeeded. */
  const { u, staging, agentId } = await store("adoptfail");
  await Bun.write(join(staging, `${ID_A}-note.txt`), "content");
  await mkdir(join(base, "agents", agentId), { recursive: true });
  await writeFile(join(base, "agents", agentId, "uploads"), "a file where the dir should be");
  const r = rec(ID_A);
  r.path = `${staging}${ID_A}-note.txt`;
  await u.adoptStagedUploads("w1:p1", [r]);
  expect(r.path).toBe(`${staging}${ID_A}-note.txt`);
  expect(await Bun.file(r.path).text()).toBe("content");
});

test("trim removes only unreferenced files past the caps, oldest first", async () => {
  const { u, staging } = await store("trim", [ID_A]);
  // 202 files: one referenced OLDEST file + 201 debris (the cap is 200), so
  // two files sit past the cap: the referenced one and one debris.
  await Bun.write(join(staging, `${ID_A}-keep.txt`), "keep");
  await utimes(join(staging, `${ID_A}-keep.txt`), new Date(1000), new Date(1000)); // oldest
  for (let i = 0; i < 201; i++) {
    const id = `${String(i).padStart(8, "0")}-1111-1111-1111-111111111111`;
    await writeFile(join(staging, `${id}-d.txt`), "x");
  }
  await u.trimUploads("test");
  const left = await readdir(staging);
  expect(left).toContain(`${ID_A}-keep.txt`); // referenced: never deleted, even at the back
  expect(left.length).toBe(202 - 1); // exactly the one unreferenced file over the cap went
});

test("trim at exactly the count cap deletes nothing", async () => {
  // the boundary: n <= UPLOAD_KEEP is kept, so the 200th file survives and only
  // a 201st is even considered
  const { u, staging } = await store("trimcap");
  for (let i = 0; i < UPLOAD_KEEP; i++) {
    const id = `${String(i).padStart(8, "0")}-2222-2222-2222-222222222222`;
    await writeFile(join(staging, `${id}-d.txt`), "x");
  }
  await u.trimUploads("test");
  expect((await readdir(staging)).length).toBe(UPLOAD_KEEP);
});

test("trim leaves anything this engine did not name alone", async () => {
  /* The staging dir is ours, but a stray file (a half-written multipart part, a
   * .DS_Store) is not something to delete on a retention rule that was written
   * for our own blobs. */
  const { u, staging } = await store("trimforeign");
  await writeFile(join(staging, "README"), "x");
  await writeFile(join(staging, ".DS_Store"), "x");
  await mkdir(join(staging, `${ID_B}-a-directory`), { recursive: true });
  for (let i = 0; i < UPLOAD_KEEP + 5; i++) {
    const id = `${String(i).padStart(8, "0")}-3333-3333-3333-333333333333`;
    await writeFile(join(staging, `${id}-d.txt`), "x");
  }
  await u.trimUploads("test");
  const left = await readdir(staging);
  expect(left).toContain("README");
  expect(left).toContain(".DS_Store");
  expect(left).toContain(`${ID_B}-a-directory`); // a directory is not a file to unlink
  expect(left.filter((n) => n.endsWith("-d.txt")).length).toBe(UPLOAD_KEEP);
});

test("a referenced file still COUNTS toward the cap, it is just never deleted", async () => {
  /* The consequence, spelled out: an enormous conversation ends up over the cap
   * rather than losing anything. With 205 files of which the newest 3 are
   * referenced, the count still starts at 1 for the newest, so exactly the
   * unreferenced ones past 200 go. */
  const referenced = [0, 1, 2].map((i) => `${String(i).padStart(8, "0")}-4444-4444-4444-444444444444`);
  const { u, staging } = await store("trimref", referenced);
  for (let i = 0; i < 205; i++) {
    const id = `${String(i).padStart(8, "0")}-4444-4444-4444-444444444444`;
    await writeFile(join(staging, `${id}-d.txt`), "x");
    await utimes(join(staging, `${id}-d.txt`), new Date(10_000 - i), new Date(10_000 - i));
  }
  await u.trimUploads("test");
  const left = await readdir(staging);
  for (const id of referenced) expect(left).toContain(`${id}-d.txt`);
  expect(left.length).toBe(200);
});

test("trim on a store whose dir has gone returns quietly", async () => {
  const { u } = await store("trimgone");
  const { rm } = await import("node:fs/promises");
  await rm(join(base, "trimgone"), { recursive: true, force: true });
  await u.trimUploads("test"); // must not throw
});

test("uploadIdsOf reads the union of upload and uploads (the delete-side rule)", () => {
  const m: ChatMsg = { id: "s", role: "user", text: "", ts: 1,
    upload: rec(ID_A), uploads: [rec(ID_B)] };
  expect([...uploadIdsOf([m])].sort()).toEqual([ID_A, ID_B].sort());
});

test("uploadIdsOf dedupes across messages and skips records with no id", () => {
  // the reference set is what stops trim deleting a live attachment; a duplicate
  // is harmless but an empty string in the set would match nothing and hide a bug
  const msgs: ChatMsg[] = [
    { id: "1", role: "user", text: "", ts: 1, uploads: [rec(ID_A), rec(ID_A)] },
    { id: "2", role: "user", text: "", ts: 2, uploads: [rec(ID_A), { ...rec(ID_B), uploadId: "" }] },
  ];
  expect([...uploadIdsOf(msgs)]).toEqual([ID_A]);
});

test("uploadIdsOf accumulates into a set the caller already has", () => {
  const into = new Set([ID_C]);
  const m: ChatMsg = { id: "1", role: "user", text: "", ts: 1, uploads: [rec(ID_A)] };
  expect(uploadIdsOf([m], into)).toBe(into);
  expect([...into].sort()).toEqual([ID_A, ID_C].sort());
});
