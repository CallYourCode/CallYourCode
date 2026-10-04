/* UPLOAD STAGING AND ADOPTION (L2 domain).
 *
 * POST /upload arrives before any session is named, so files land in the data
 * dir's staging area; when a message referencing one is accepted for a
 * session, the file is ADOPTED into that agent's own directory and the
 * persisted path is the adopted one. The store is the directory: a successful
 * upload writes `${dir}${uploadId}-${name}`, and that filename is the record.
 * A client attachment may name an uploadId and must not name a path; whatever
 * `path` it sent is ignored and replaced by this lookup, or the attachment is
 * dropped. Confinement is the files.ts pattern: realpath the directory,
 * realpath the file, then inside().
 *
 *   bun test agent-engine/src/chat/uploads-store.test.ts
 */

import { join } from "node:path";
import { readdir, rename, stat, unlink } from "node:fs/promises";
import { mkdirPrivate } from "../../../shared/runfiles.ts";
import { agentUploadsDir } from "../storage/datadir.ts";
import { rootOf, resolveInRoot } from "../storage/files.ts";
import { attachmentsOf, type ChatMsg, type UploadRec } from "./chatmsg.ts";

export const UPLOAD_MAX = 50 * 1024 * 1024;

/* Attachments were the one store with no bound at all. Same shape as the audio
 * cache: newest first, a count cap AND a byte cap, because one 50MB image is
 * under any count cap forever. The caps bound the DEBRIS (staged and never
 * sent); a referenced file is never deleted, whatever the caps say. */
export const UPLOAD_KEEP = 200; // attachment files retained, newest first
export const UPLOAD_KEEP_BYTES = 256 * 1024 * 1024;

const UPLOAD_ID_RE = /^[0-9a-f-]{36}$/i;

export type UploadsDeps = {
  /** the staging dir, with trailing slash (stagingUploadsDir() + "/") */
  stagingDir: string;
  /** uploadId -> owning agentId (the blob index; lazily read, the map is built later in boot) */
  blobOwner(): Map<string, string>;
  agentIdFor(sessionId: string): string;
  /** every uploadId a persisted or live message still points at */
  referencedIds(): Set<string>;
  log(event: string, fields: Record<string, unknown>): void;
};

export type Uploads = {
  readonly dir: string;
  /** every uploadId this process minted or inherited from disk at boot */
  readonly minted: Set<string>;
  ownedUploadPath(uploadId: string): Promise<string | null>;
  bindOwnedUploads(claimed: UploadRec[], cid?: string): Promise<{ ups: UploadRec[]; missing: string[] }>;
  adoptStagedUploads(sessionId: string, ups: UploadRec[]): Promise<void>;
  trimUploads(why: string): Promise<void>;
};

export async function makeUploads(deps: UploadsDeps): Promise<Uploads> {
  const dir = deps.stagingDir;
  await mkdirPrivate(dir);

  /* Minted at POST /upload, and inherited from whatever was already on disk at
   * boot. The sweep may delete the file; the id stays, so a composer that
   * still names it fails the whole message instead of sending a hole. An id
   * that was never ours is a forge and is dropped. */
  const minted = new Set<string>();
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const id = /^([0-9a-f-]{36})-/.exec(name)?.[1];
    if (id) minted.add(id);
  }

  async function ownedUploadPath(uploadId: string): Promise<string | null> {
    if (!UPLOAD_ID_RE.test(uploadId)) return null;
    /* Staging first (the common just-posted case), then the owning agent's own
     * uploads dir (the blob index knows which agent's message adopted it). */
    const dirs = [dir];
    const aid = deps.blobOwner().get(uploadId);
    if (aid) dirs.push(agentUploadsDir(aid) + "/");
    for (const d of dirs) {
      let matches: string[] = [];
      try {
        matches = [...new Bun.Glob(`${uploadId}-*`).scanSync({ cwd: d })];
      } catch {
        continue; // the dir is not there (an agent with no adopted uploads yet)
      }
      if (!matches.length) continue;
      const stored = `${d}${matches[0]}`;
      const rootReal = await rootOf(d);
      // resolveInRoot realpaths both sides and refuses anything outside the root.
      if (await resolveInRoot(rootReal, matches[0])) return stored;
    }
    return null;
  }

  /** Client attachment records with `path` rebound from this engine's store.
   *  A forge (id this engine never had) is dropped. An id we minted whose file
   *  is gone is `missing`, and the caller refuses the whole message. */
  async function bindOwnedUploads(claimed: UploadRec[], cid?: string):
    Promise<{ ups: UploadRec[]; missing: string[] }> {
    const ups: UploadRec[] = [];
    const missing: string[] = [];
    for (const u of claimed) {
      const path = await ownedUploadPath(u.uploadId);
      if (path) {
        ups.push({ ...u, path });
        continue;
      }
      if (u.uploadId && minted.has(u.uploadId)) {
        missing.push(u.name || u.uploadId);
        continue;
      }
      deps.log("utterance.attach-dropped", { cid, upload: u.uploadId,
        why: "no engine upload record for this uploadId, or the file is not confined under the staging dir" });
    }
    return { ups, missing };
  }

  async function adoptStagedUploads(sessionId: string, ups: UploadRec[]): Promise<void> {
    if (!ups.length) return;
    const aid = deps.agentIdFor(sessionId);
    const destDir = agentUploadsDir(aid);
    for (const u of ups) {
      if (!u.path || !u.path.startsWith(dir)) continue; // already adopted, or not ours
      const name = u.path.slice(u.path.lastIndexOf("/") + 1);
      const dest = join(destDir, name);
      try {
        await mkdirPrivate(destDir);
        await rename(u.path, dest);
        u.path = dest;
        deps.blobOwner().set(u.uploadId, aid);
      } catch (e) {
        console.error(`[upload] could not adopt ${u.uploadId} into ${aid}:`, e);
      }
    }
  }

  /* Bring staging back under the caps, newest first. REFERENCED FILES ARE
   * NEVER DELETED: a message in the log points at a real path and the agent
   * can be asked to read it days later. A referenced file still counts toward
   * the totals, so an enormous conversation ends up over the cap rather than
   * losing anything. Best effort throughout. */
  async function trimUploads(why: string) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    const files: { name: string; id: string; size: number; mtime: number }[] = [];
    for (const name of names) {
      const id = /^([0-9a-f-]{36})-/.exec(name)?.[1];
      if (!id) continue; // not ours: leave anything we did not name alone
      const st = await stat(join(dir, name)).catch(() => null);
      if (!st?.isFile()) continue;
      files.push({ name, id, size: st.size, mtime: st.mtimeMs });
    }
    files.sort((a, b) => b.mtime - a.mtime); // newest first

    const keep = deps.referencedIds();
    let n = 0, bytes = 0, dropped = 0, freed = 0;
    for (const f of files) {
      n++;
      bytes += f.size;
      if (n <= UPLOAD_KEEP && bytes <= UPLOAD_KEEP_BYTES) continue;
      if (keep.has(f.id)) continue; // a message still points at this one
      if (await unlink(join(dir, f.name)).then(() => true).catch(() => false)) {
        dropped++;
        freed += f.size;
      }
    }
    if (dropped) {
      console.log(`[upload] trim (${why}): removed ${dropped} unreferenced file(s), ` +
        `${Math.round(freed / 1024)}KB; ${files.length - dropped} left`);
    }
  }

  return { dir, minted, ownedUploadPath, bindOwnedUploads, adoptStagedUploads, trimUploads };
}

/** The one attachment reader the trim's reference set uses, exported so the
 *  caller building referencedIds() cannot drift from attachmentsOf. */
export function uploadIdsOf(msgs: Iterable<ChatMsg>, into = new Set<string>()): Set<string> {
  for (const m of msgs) {
    for (const u of attachmentsOf(m)) if (u.uploadId) into.add(u.uploadId);
    if (m.upload?.uploadId) into.add(m.upload.uploadId);
  }
  return into;
}
