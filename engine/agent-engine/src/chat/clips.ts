/* AUDIO CLIPS (L2 domain): the hot cache, the on-disk store, staging adoption
 * and the growing-set for streaming TTS.
 *
 * A clip is agent data: it lives in agents/<agentId>/audio/ once anything
 * knows whose it is (the blob index answers that); a clip nobody has claimed
 * yet (POST /user-audio runs before the message exists) stages in
 * staging/audio and is adopted when its message lands. The hot cache is a
 * CACHE, bounded by count and bytes; the disk copy is the record.
 *
 * The blob index and the agent-id map belong to the session state, injected
 * once at boot (initClips) so this module stays below it in the layering.
 *
 *   bun test agent-engine/src/chat/clips.test.ts
 */

import { rename } from "node:fs/promises";
import { agentAudioDir, stagingAudioDir } from "../storage/datadir.ts";
import { mkdirPrivate, writePrivate } from "../../../shared/runfiles.ts";
import { safeCid } from "../../../shared/logbook.ts";

export const AUDIO_KEEP = 200; // clips retained in the hot cache, newest first
// The hot cache is bounded by count AND bytes: voice notes run to megabytes,
// so a count cap alone could pin gigabytes. A clip bigger than the whole
// budget evicts even itself, which is fine: the disk copy is written
// regardless, and serving re-reads from disk.
export const AUDIO_KEEP_BYTES = 64 * 1024 * 1024;

/** msgId -> clip (hot cache). Insertion-order eviction; disk re-warms. */
export const audio = new Map<string, { bytes: Uint8Array; mime: string }>();
let audioBytes = 0;
export const audioCacheBytes = (): number => audioBytes;

/* msgIds whose mp3 is still being appended to on disk (#525, streaming TTS).
 * While an id is in here /audio/<id>.mp3 serves the CURRENT disk bytes with
 * `no-store`, so a device that fetched the short version re-requests the
 * grown one instead of a browser cache answering with the stale length. */
export const growing = new Set<string>();

const MIME_EXT: Record<string, string> = {
  "audio/mpeg": "mp3", "audio/webm": "webm", "audio/webm;codecs=opus": "webm",
  "audio/ogg": "ogg", "audio/ogg;codecs=opus": "ogg", "audio/mp4": "m4a",
};
export const EXT_MIME: Record<string, string> = {
  mp3: "audio/mpeg", webm: "audio/webm", ogg: "audio/ogg", m4a: "audio/mp4",
};

type ClipsDeps = {
  /** msgId -> owning agentId (the blob index, owned by the session state) */
  blobOwner(): Map<string, string>;
  agentIdFor(sessionId: string): string;
  /** staging/audio with trailing slash; a test points it at a scratch dir */
  stagingDir?: string;
};

let deps: ClipsDeps = {
  blobOwner: () => new Map(),
  agentIdFor: () => { throw new Error("clips not initialised"); },
};
let stagingDir = "";

/** Wire the session-state seams and make the staging dir. Called once at boot. */
export async function initClips(d: ClipsDeps): Promise<void> {
  deps = d;
  stagingDir = d.stagingDir ?? stagingAudioDir() + "/";
  await mkdirPrivate(stagingDir);
}

/** TEST ONLY: empty the hot cache AND its byte counter, drop the growing set,
 *  and forget the injected seams, so a second in-process wiring does not read
 *  the first one's clips out of a staging dir that no longer exists.
 *
 *  `audio.clear()` on its own is NOT this: audioBytes is a separate running
 *  total, and a cleared map left with a stale total makes the very next
 *  cacheAudio evict on sight. No-op in production, which wires once at boot. */
export function resetForTest(): void {
  audio.clear();
  audioBytes = 0;
  growing.clear();
  deps = {
    blobOwner: () => new Map(),
    agentIdFor: () => { throw new Error("clips not initialised"); },
  };
  stagingDir = "";
}

export function audioDirFor(msgId: string): string {
  const aid = deps.blobOwner().get(msgId);
  return aid ? agentAudioDir(aid) + "/" : stagingDir;
}

export function audioPath(msgId: string, mime: string): string {
  return `${audioDirFor(msgId)}${msgId}.${MIME_EXT[mime] ?? "bin"}`;
}

/** The dirs a clip could be in: its owner's, then staging (a clip written
 *  before its message landed, or one whose adoption move failed). */
export function audioDirsFor(msgId: string): string[] {
  const own = audioDirFor(msgId);
  return own === stagingDir ? [stagingDir] : [own, stagingDir];
}

export async function audioFromDisk(msgId: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  for (const dir of audioDirsFor(msgId)) {
    for (const [ext, mime] of Object.entries(EXT_MIME)) {
      const f = Bun.file(`${dir}${msgId}.${ext}`);
      if (await f.exists()) {
        const entry = { bytes: new Uint8Array(await f.arrayBuffer()), mime };
        await cacheAudio(msgId, entry.bytes, entry.mime, false); // warm the hot cache, no re-write
        return entry;
      }
    }
  }
  return null;
}

/* Where this msgId's clip is on disk, or null. Reads no bytes.
 *
 * THE msgId IS A RAW WIRE STRING and it is pasted straight into a path, so it
 * goes through the same filter `m.cid` does (safeCid: 64 chars of
 * [A-Za-z0-9_.-], no slash, no dot-dot). The answer GATES BEHAVIOUR: haveClip
 * feeds `rescuable`, whose transcript becomes chat content, so a traversal
 * here is a path from the wire to chat content, not just to a boolean. */
export async function clipOnDisk(msgId: string): Promise<string | null> {
  if (!safeCid(msgId)) return null;
  for (const dir of audioDirsFor(msgId)) {
    for (const ext of Object.keys(EXT_MIME)) {
      const p = `${dir}${msgId}.${ext}`;
      if (await Bun.file(p).exists().catch(() => false)) return p;
    }
  }
  return null;
}

/* ADOPTION (the design): a staged blob whose message just committed to a
 * session MOVES into that agent's own directory. Best-effort: a file that
 * will not move keeps its staged path and every reader falls back to staging,
 * so nothing is lost to a failed rename -- it is just not yet home. */
export async function adoptStagedClip(sessionId: string, msgId: string): Promise<void> {
  if (!safeCid(msgId)) return;
  const aid = deps.agentIdFor(sessionId);
  for (const ext of Object.keys(EXT_MIME)) {
    const staged = `${stagingDir}${msgId}.${ext}`;
    if (!(await Bun.file(staged).exists().catch(() => false))) continue;
    try {
      const dir = agentAudioDir(aid); // resolved once, before the awaits (agentmeta.ts saveAgentMeta)
      await mkdirPrivate(dir);
      await rename(staged, `${dir}/${msgId}.${ext}`);
      deps.blobOwner().set(msgId, aid);
    } catch (e) {
      console.error(`[audio] could not adopt ${msgId} into ${aid}:`, e);
    }
    return;
  }
}

/* Does this engine hold the recording behind this msgId, anywhere. NOT
 * `audio.has(msgId)` alone: the hot cache is capped and restarts empty it,
 * while the clip itself is on disk from the moment /user-audio answers. */
export async function haveClip(msgId: string): Promise<boolean> {
  return audio.has(msgId) || (await clipOnDisk(msgId)) !== null;
}

// Length of an audio file, via ffprobe (already a dependency: the voice
// engine shells out to ffmpeg). Best effort: a failure just means the bubble
// falls back to learning the duration on play, as it always did.
export async function audioDurationS(path: string): Promise<number> {
  try {
    const proc = Bun.spawn(
      ["ffprobe", "-v", "error", "-show_entries", "format=duration",
       "-of", "default=noprint_wrappers=1:nokey=1", path],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const v = Number(out.trim());
    // whole seconds: the bubble formats m:ss and voice notes already use ints
    return Number.isFinite(v) && v > 0 ? Math.max(1, Math.round(v)) : 0;
  } catch {
    return 0;
  }
}

/* Hot-cache a clip and, unless told otherwise, put it on disk.
 *
 * AWAITS the write and THROWS if it fails: the app's single tick means "your
 * recording cannot be lost", and it must never be drawn on "a write has been
 * queued". Every caller decides for itself what a failure means, because for
 * a voice note it means the tick is a lie and for TTS it does not. */
export async function cacheAudio(msgId: string, bytes: Uint8Array, mime = "audio/mpeg", persist = true) {
  const prev = audio.get(msgId);
  if (prev) audioBytes -= prev.bytes.byteLength;
  audio.set(msgId, { bytes, mime });
  audioBytes += bytes.byteLength;
  while (audio.size > AUDIO_KEEP || audioBytes > AUDIO_KEEP_BYTES) {
    const oldest = audio.keys().next().value;
    if (oldest === undefined) break;
    audioBytes -= audio.get(oldest)!.bytes.byteLength;
    audio.delete(oldest);
  }
  if (persist) {
    await mkdirPrivate(audioDirFor(msgId));
    await writePrivate(audioPath(msgId, mime), bytes as unknown as ArrayBuffer);
  }
}
