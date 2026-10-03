/* THE INTAKE RECORD: an utterance this engine has acked is on disk until its
 * delivery has run.
 *
 * The ack tells the app the message is TAKEN, and the app deletes its intent
 * on that receipt: from then on this engine is the only copy. Delivery comes
 * after the ack and can take a while (a recording read inline for up to
 * RESCUE_INLINE_MS, a message queued behind it in the per-session chain), and
 * a process that died in that window used to lose the message with nothing
 * left anywhere to send it again.
 *
 * So the frame is written here BEFORE the ack, one file per (session, cid), and
 * removed when handleUtterance has finished with it (delivered, shown pending
 * with its row on disk, or refused with a send-failed the app acts on). A file
 * still here at boot is a message taken and never finished: deliver.ts drives
 * it again when its session is picked up, deduped by cid against the chat log,
 * so one that did reach the log is never delivered twice.
 *
 * The frame is what the app sent, and everything handleUtterance needs: the
 * clip and the uploads it names are on this engine's disk already (the
 * transfer finished before the frame was written).
 */

import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { stateDir } from "../storage/datadir.ts";
import { mkdirPrivate, writeAtomicPrivate } from "../../../shared/runfiles.ts";

export type Taken = {
  sessionId: string;
  cid: string;
  takenAt: number;
  /** the client frame, as read */
  frame: Record<string, unknown>;
  /** how many times a boot has driven this one again */
  redrives?: number;
};

const dir = (): string => join(stateDir(), "intake");
const fileOf = (sessionId: string, cid: string): string =>
  join(dir(), `${encodeURIComponent(sessionId)}~${encodeURIComponent(cid)}.json`);

export async function noteTaken(t: Taken): Promise<void> {
  await mkdirPrivate(dir());
  await writeAtomicPrivate(fileOf(t.sessionId, t.cid), JSON.stringify(t));
}

export async function forgetTaken(sessionId: string, cid: string): Promise<void> {
  await unlink(fileOf(sessionId, cid)).catch(() => {});
}

/** Every taken-and-unfinished frame for one session, oldest first. */
export async function takenFor(sessionId: string): Promise<Taken[]> {
  const prefix = `${encodeURIComponent(sessionId)}~`;
  const names = await readdir(dir()).catch(() => [] as string[]);
  const out: Taken[] = [];
  for (const n of names) {
    if (!n.startsWith(prefix) || !n.endsWith(".json")) continue;
    try {
      const t = JSON.parse(await readFile(join(dir(), n), "utf8")) as Taken;
      if (t && t.sessionId === sessionId && typeof t.cid === "string" && t.frame) out.push(t);
    } catch { /* a torn file is not a message; the atomic write never leaves one */ }
  }
  return out.sort((a, b) => a.takenAt - b.takenAt);
}
