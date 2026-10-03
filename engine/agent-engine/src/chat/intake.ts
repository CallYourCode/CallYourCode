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
 * So the frame is written here BEFORE the ack, one file per take, and removed
 * when handleUtterance has finished with it AND its row is on disk (delivered,
 * shown pending, or refused with a send-failed the app acts on). A file still
 * here at boot is a message taken and never finished: deliver.ts drives it
 * again when its session is picked up, deduped by cid against the chat log and
 * guided by how far its keystrokes got (Stage below).
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
  /** names this take's file, so removing one take never removes another
   *  take of the same cid (a resend taken fresh while an old one waited) */
  attempt: string;
  /** the client frame, as read */
  frame: Record<string, unknown>;
  /** how many times a boot has driven this one again */
  redrives?: number;
};

/* HOW FAR THE KEYSTROKES GOT, per (session, cid), for frames and for the
 * completion of a note shown pending alike. `typing` is written before the
 * body is typed and `entering` before the Enter (keystroke panes); pi's direct
 * input writes `typing` before the send and `submitted` after it. A redrive
 * reads it (deliver.ts typeAndCommit, delivery-machine noteCheck). */
export type Stage = "typing" | "entering" | "submitted";

const dir = (): string => join(stateDir(), "intake");
const enc = encodeURIComponent;
const fileOf = (t: Pick<Taken, "sessionId" | "cid" | "attempt">): string =>
  join(dir(), `${enc(t.sessionId)}~${enc(t.cid)}~${enc(t.attempt)}.json`);
const stageOf = (sessionId: string, cid: string): string =>
  join(dir(), `${enc(sessionId)}~${enc(cid)}.stage`);

export const newAttempt = (): string => crypto.randomUUID().slice(0, 8);

export async function noteTaken(t: Taken): Promise<void> {
  await mkdirPrivate(dir());
  await writeAtomicPrivate(fileOf(t), JSON.stringify(t));
}

export async function forgetTaken(t: Pick<Taken, "sessionId" | "cid" | "attempt">): Promise<void> {
  await unlink(fileOf(t)).catch(() => {});
}

/** Every taken-and-unfinished frame for one session (all sessions when
 *  absent), oldest first. */
export async function takenFor(sessionId?: string): Promise<Taken[]> {
  const prefix = sessionId === undefined ? "" : `${enc(sessionId)}~`;
  const names = await readdir(dir()).catch(() => [] as string[]);
  const out: Taken[] = [];
  for (const n of names) {
    if (!n.startsWith(prefix) || !n.endsWith(".json")) continue;
    try {
      const t = JSON.parse(await readFile(join(dir(), n), "utf8")) as Taken;
      if (t && (sessionId === undefined || t.sessionId === sessionId) &&
        typeof t.cid === "string" && t.frame) out.push(t);
    } catch { /* a torn file is not a message; the atomic write never leaves one */ }
  }
  return out.sort((a, b) => a.takenAt - b.takenAt);
}

export async function noteStage(sessionId: string, cid: string, stage: Stage): Promise<void> {
  await mkdirPrivate(dir());
  await writeAtomicPrivate(stageOf(sessionId, cid), stage);
}

export async function stageFor(sessionId: string, cid: string): Promise<Stage | null> {
  const s = await readFile(stageOf(sessionId, cid), "utf8").catch(() => "");
  return s === "typing" || s === "entering" || s === "submitted" ? s : null;
}

export async function forgetStage(sessionId: string, cid: string): Promise<void> {
  await unlink(stageOf(sessionId, cid)).catch(() => {});
}

/* SENDS GIVEN UP ON, told to every app that connects (sessions-frame
 * sendHelloBurst) as well as broadcast when it happens, so the sender's bubble
 * goes to failed with a retry even if it was not connected at that moment.
 * This process's memory only: a further restart before any app connects does
 * not repeat it (docs/contracts/02-engine-app.md). */
const failed = new Map<string, { t: "send-failed"; id: string; cid: string; reason: string }>();
export function noteFailed(sessionId: string, cid: string, reason: string) {
  const f = { t: "send-failed" as const, id: sessionId, cid, reason };
  failed.set(`${sessionId}|${cid}`, f);
  return f;
}
export function clearFailed(sessionId: string, cid: string): void {
  failed.delete(`${sessionId}|${cid}`);
}
export function failedFrames(): unknown[] {
  return [...failed.values()];
}
export function resetForTest(): void {
  failed.clear();
}
