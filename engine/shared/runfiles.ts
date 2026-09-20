/* Owner-only writes for everything under .run (SECURITY-REVIEW #10).
 *
 * The umask on these hosts is 0002, so a plain Bun.write leaves 0664 and a
 * plain mkdir leaves 0775. .run holds the VAPID private key, device push
 * keys, chat, photos, audio, uploads and settings. Group/other should not
 * read any of that. Files are 0600. Directories are 0700.
 *
 * writePrivate is Bun.write plus chmod, because mode on create is ignored
 * when the file already exists. mkdirPrivate chmods the leaf for the same
 * reason: recursive mkdir only sets the last component, and umask still
 * applies.
 *
 * repairRunTree walks an existing tree at boot and fixes what was already
 * written world-readable. Best-effort: a missing path is not a crash.
 * Symlinks are skipped so a stray link cannot chmod something outside .run.
 *
 *   bun test agent-engine/src/storage/runfiles.test.ts
 */

import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { appendFile, chmod, lstat, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

/* SPELLED OUT, NOT DERIVED. This was `Parameters<typeof Bun.write>[1]`, which
 * looks like "whatever Bun.write accepts" and is not: Bun.write is overloaded,
 * and `Parameters<>` over an overloaded function resolves the LAST overload
 * alone. That one takes a BunFile (the file-copy form), so the alias quietly
 * meant `BunFile` and every writePrivate(path, "...json...") in the engine was
 * a type error. It was the single biggest class in the check. */
type WriteData = string | Blob | NodeJS.TypedArray | ArrayBufferLike | Bun.BlobPart[];

/** Write `path` and leave it 0600, even if the file already existed. */
export async function writePrivate(path: string, data: WriteData): Promise<number> {
  const n = await Bun.write(path, data);
  await chmod(path, FILE_MODE).catch(() => {});
  return n;
}

/** Append and leave the file 0600 (a first create would otherwise be 0664). */
export async function appendPrivate(path: string, data: string | Uint8Array): Promise<void> {
  await appendFile(path, data);
  await chmod(path, FILE_MODE).catch(() => {});
}

/** mkdir -p with the leaf forced to 0700. */
export async function mkdirPrivate(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
  await chmod(path, DIR_MODE).catch(() => {});
}

export function mkdirPrivateSync(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  try { chmodSync(path, DIR_MODE); } catch { /* best-effort */ }
}

export function writePrivateSync(path: string, data: string | NodeJS.ArrayBufferView): void {
  writeFileSync(path, data);
  try { chmodSync(path, FILE_MODE); } catch { /* best-effort */ }
}

/* ATOMIC PRIVATE WRITE: the "write a neighbour, then rename over the real name"
 * idiom that a handful of call sites each spelled for themselves (agentmeta,
 * session settings, the usage-card cache, the plugin kv store, ...). Rename is
 * the only atomic step here, so a process killed mid-write leaves the OLD file
 * whole -- or nothing -- never half of a new one. The temp name carries the pid
 * AND a random tag, so two writers (two processes, or two calls in one process
 * racing the same path) never share a temp and cannot corrupt each other. The
 * final file lands 0600 like everything else under .run. On any failure the
 * temp is removed and the error rethrown, so a failed write leaves no scrap.
 *
 * The caller makes the directory (sites differ on when/how) and owns its error
 * policy (rethrow, log-and-continue, swallow): this does only the write, the
 * rename, and the temp cleanup. */
function atomicTmp(path: string): string {
  return `${path}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
}

export async function writeAtomicPrivate(path: string, data: WriteData): Promise<void> {
  const tmp = atomicTmp(path);
  try {
    await writePrivate(tmp, data);
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export function writeAtomicPrivateSync(path: string, data: string | NodeJS.ArrayBufferView): void {
  const tmp = atomicTmp(path);
  try {
    writePrivateSync(tmp, data);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}

/** chmod one path: 0700 if a dir, 0600 if a file. Missing is fine. */
export async function chmodPrivate(path: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) await chmod(path, DIR_MODE);
    else if (st.isFile()) await chmod(path, FILE_MODE);
  } catch {
    /* absent, or we cannot touch it */
  }
}

/** Walk `root` and force dirs 0700 / files 0600. Does not follow symlinks. */
export async function repairRunTree(root: string): Promise<void> {
  let st;
  try { st = await lstat(root); } catch { return; }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    await chmod(root, DIR_MODE).catch(() => {});
    let names: string[] = [];
    try { names = await readdir(root); } catch { return; }
    for (const name of names) await repairRunTree(join(root, name));
    return;
  }
  if (st.isFile()) await chmod(root, FILE_MODE).catch(() => {});
}
