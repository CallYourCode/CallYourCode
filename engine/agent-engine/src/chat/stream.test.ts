/* STREAMING TTS: THE DURABLE HALF (#525).
 *
 * A spoken reply is synthesised one sentence at a time and appended to ONE mp3
 * on disk, so the app can start playing at the first chunk (~1-2s) and follow
 * the file as it grows. This file is about the engine's promises to that file:
 *
 *   - mp3 chunks concatenate into a VALID playable file at EVERY append
 *     boundary (the container decision this whole lane rests on);
 *   - the first chunk is on disk and served before generation completes, so the
 *     app plays before the rest exists;
 *   - a growing clip is served UNCACHED and range-able, and a media element's
 *     open range gets a stream that follows the file (#531);
 *   - the growth beats climb (#543);
 *   - a restart caught mid-growth leaves a valid partial marked DONE, never a
 *     clip stuck growing for ever.
 *
 * NO ENGINE, AND NO SESSION GRAPH EITHER. tts.ts takes its session as a
 * structural {id, lastOrigin} and everything else through its deps bag, so the
 * whole growth path can be driven directly with a recorded broadcast and a
 * recorded persistPatch. What is real: clips.ts, tts.ts, appendPrivate, the
 * media route, and ffmpeg/ffprobe. What is fake: the voice engine (fake-voice
 * on port 0) and time (the manual clock).
 *
 * THE mp3 THE FAKE HANDS BACK IS A REAL TONE FROM ffmpeg, because "concatenates
 * legally" is only worth testing against bytes a decoder actually accepts. The
 * two binaries are this file's one dependency on the host, and it skips loudly
 * rather than failing if they are missing.
 */

import { test, expect, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { audioPath, growing, initClips, resetForTest as resetClips } from "./clips.ts";
import { chunkText } from "../voice/tts-stream.ts";
import { appendPrivate, writePrivate } from "../../../shared/runfiles.ts";
import { initTts, speakClip, sweepGrowingClips, resetForTest as resetTts } from "../voice/tts.ts";
import { mediaRoutes } from "../routes/media.ts";
import type { ChatMsg } from "./chatmsg.ts";
import { fakeVoice, type FakeVoice } from "../test-utils/fake-voice.ts";
import { manualClock } from "../runtime/clock.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";

/** ffprobe a file: its duration in SECONDS, fractional, or 0 if undecodable.
 *  clips.audioDurationS rounds to whole seconds (a bubble formats m:ss), which
 *  cannot tell a one-chunk clip from a two-chunk one. */
async function seconds(path: string): Promise<number> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration",
     "-of", "default=noprint_wrappers=1:nokey=1", path],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const v = Number(out.trim());
  return Number.isFinite(v) && v > 0 ? v : 0;
}

async function haveBinary(name: string): Promise<boolean> {
  try {
    const p = Bun.spawn([name, "-version"], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch { return false; }
}

const HAVE_FF = (await haveBinary("ffmpeg")) && (await haveBinary("ffprobe"));
if (!HAVE_FF) {
  console.warn(
    "[stream.test] SKIPPING: ffmpeg/ffprobe are not on PATH. This file's subject is that a " +
    "GROWING mp3 stays decodable at every append boundary, which is a claim about bytes a " +
    "decoder accepts; asserting it against a decoder that is not there would prove nothing. " +
    "The engine shells out to ffprobe for every clip's duration, so this is the same " +
    "dependency production has.");
}
const ff = test.skipIf(!HAVE_FF);

/** ~0.9s of tone as real mp3 frames: concatenating N of them yields a longer
 *  valid mp3, which is the entire reason streaming can append to one file. */
let MP3: Uint8Array = new Uint8Array();

let dir = "";
let voice: FakeVoice;
let http: ServedRoutes;
let broadcasts: Record<string, any>[] = [];
let patches: Array<{ id: string; ts: number; set?: Partial<ChatMsg>; unset: string[] }> = [];
const restored = new Map<string, ChatMsg[]>();
const clock = manualClock();

beforeAll(async () => {
  if (HAVE_FF) {
    const proc = Bun.spawn(
      ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.9",
       "-c:a", "libmp3lame", "-b:a", "64k", "-f", "mp3", "pipe:1"],
      { stdout: "pipe", stderr: "ignore" },
    );
    MP3 = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    await proc.exited;
    if (MP3.byteLength < 100) throw new Error("ffmpeg produced no mp3");
  }

  dir = await tmpDir("cyc-stream-");
  /* Nothing owns these clips (no blob index entry), so every one of them is
   * filed in the staging dir this test just made. No CYC_DATA_DIR, no session
   * state, no agent tree. */
  await initClips({
    blobOwner: () => new Map(),
    agentIdFor: () => { throw new Error("no session state in this file"); },
    stagingDir: join(dir, "audio") + "/",
  });
  voice = fakeVoice({ ttsBytes: MP3 });
  http = serveRoutes({ groups: [mediaRoutes] });
});

/* THE ONE WIRING, re-applied before every test.
 *
 * Two tests below re-wire it (one to watch each append boundary from inside the
 * broadcast, one to point at an upstream it is about to kill), and a re-wire
 * that outlived its test would leave the next one speaking to a stopped server.
 * `onFrame` is a synchronous hook on the broadcast, which is the only place some
 * of these questions can be asked: it is the exact instant the engine claims
 * something about the clip. */
function wireTts(v: FakeVoice, onFrame?: (m: Record<string, any>) => void): void {
  initTts({
    voiceUrl: async () => v.base,
    voiceFor: () => undefined,
    persistPatch: (id, ts, set, unset) => { patches.push({ id, ts, set, unset }); },
    broadcast: (m) => {
      broadcasts.push(m as Record<string, any>);
      onFrame?.(m as Record<string, any>);
    },
    restoredChats: () => restored,
    clock,
  });
}

beforeEach(() => { if (HAVE_FF) wireTts(voice); });

afterAll(() => {
  http?.stop();
  voice?.stop();
  resetTts();
  resetClips();
});

afterEach(() => {
  broadcasts = [];
  patches = [];
  restored.clear();
  growing.clear();
  voice.mode = "NORMAL";
  voice.reset();
});

const session = { id: "w1:p1" };
const frames = (t: string) => broadcasts.filter((f) => f.t === t);

/** The row reply.ts writes before it speaks, and the growing flag it sets. */
function rowFor(text: string, msgId: string, multi: boolean): ChatMsg {
  if (multi) growing.add(msgId);
  return { id: session.id, role: "claude", text, ts: clock.now(), msgId,
    ...(multi ? { growing: true } : {}) } as ChatMsg;
}

// A reply that chunks into three, so there is a RUN of growth to check across
// rather than one step. The count is asserted, not assumed.
const LONG =
  "This first sentence is deliberately long enough to stand as its own chunk here. " +
  "This is the second sentence of the reply and it carries a fair few characters too. " +
  "A third sentence follows on so the middle chunk fills up toward the target size. " +
  "Then a fourth sentence keeps the reply going past the two-hundred character mark. " +
  "A fifth sentence starts the final chunk of the spoken reply as it streams. " +
  "And a sixth sentence closes the reply out so the clip finishes growing.";

ff("a growing mp3 is decodable at EVERY append boundary, and each beat is longer", async () => {
  const chunks = chunkText(LONG);
  expect(chunks.length, "the test's own text stopped being multi-chunk").toBeGreaterThanOrEqual(3);
  const msgId = crypto.randomUUID();
  const msg = rowFor(LONG, msgId, true);
  const path = audioPath(msgId, "audio/mpeg");

  /* THE SNAPSHOT IS TAKEN SYNCHRONOUSLY, inside the broadcast the engine makes
   * after each append. Reading the file afterwards would read whatever the NEXT
   * append had already made of it; ffprobe cannot be awaited from inside a
   * synchronous broadcast, so the bytes are copied here and probed below. Each
   * snapshot is the file exactly as the app would have found it at that beat. */
  const snapshots: Uint8Array[] = [];
  wireTts(voice, (m) => {
    if (m.t === "say" || m.t === "say-grow" || m.t === "say-done") {
      try { snapshots.push(new Uint8Array(readFileSync(path))); } catch { /* not on disk yet */ }
    }
  });

  await speakClip(session, msg, chunks, msgId);
  await until(() => frames("say-done").length === 1, { what: "the clip to finish growing" });

  /* EVERY BOUNDARY, not just the last one. A container that only concatenated
   * legally at the end would still let the app play a truncated first chunk. */
  expect(snapshots.length,
    "no boundary was observed at all").toBeGreaterThanOrEqual(chunks.length);
  let prev = 0;
  for (const [i, bytes] of snapshots.entries()) {
    const probe = join(dir, `boundary-${i}.mp3`);
    await writePrivate(probe, bytes);
    const dur = await seconds(probe);
    expect(dur, `the clip was not decodable at append boundary ${i}`).toBeGreaterThan(0);
    expect(dur, `boundary ${i} did not make the clip longer than boundary ${i - 1}`)
      .toBeGreaterThanOrEqual(prev - 0.001);
    prev = dur;
  }
  expect(prev, "the finished clip is no longer than the first chunk was")
    .toBeGreaterThan(await seconds(join(dir, "boundary-0.mp3")) - 0.001);

  /* #543: the app runs a growing clip's clock and read-along off these beats.
   * Both numbers may only ever CLIMB, or the fill jumps backwards and the
   * highlight lights words the voice has not reached. */
  const grows = frames("say-grow").filter((f) => f.msgId === msgId);
  expect(grows.length,
    "a multi-chunk reply sent fewer than two growth beats, so the clip's length never " +
    "updated as it grew").toBeGreaterThanOrEqual(2);
  for (let i = 1; i < grows.length; i++) {
    expect(grows[i].chars, `growth beat ${i} did not voice more characters than the one before`)
      .toBeGreaterThan(grows[i - 1].chars);
    expect(grows[i].durS, `growth beat ${i} reported a shorter clip than the one before`)
      .toBeGreaterThanOrEqual(grows[i - 1].durS);
  }
  expect(grows.at(-1)!.chars,
    "the read-along cap ran past the end of the reply's text").toBeLessThanOrEqual(LONG.length);

  // and the bubble closes out as an ordinary finished voice note
  const done = frames("say-done").at(-1)!;
  expect(done.durationS, "say-done carried no final duration").toBeGreaterThan(0);
  expect(msg.growing, "the row is still marked growing after completion").toBeUndefined();
  expect(patches.some((p) => p.unset.includes("growing")),
    "the persisted row was never told the clip stopped growing").toBe(true);
});

ff("the first chunk is on disk and served before generation completes", async () => {
  /* THE HOLD, and how it is made deterministic: the fake is switched to HANGING
   * from inside the `say` broadcast, which tts.ts emits after the first chunk is
   * on disk and BEFORE it kicks off growClip. So the second chunk's POST is
   * accepted and never answered, and the clip on disk stays the one-chunk
   * partial the app is already playing. */
  const held = fakeVoice({ ttsBytes: MP3 });
  const chunks = chunkText(LONG);
  const msgId = crypto.randomUUID();
  const msg = rowFor(LONG, msgId, true);
  wireTts(held, (m) => { if (m.t === "say") held.mode = "HANGING"; });

  try {
    await speakClip(session, msg, chunks, msgId);

    // the say frame carries `growing`, which is the app's cue to start playing
    const say = frames("say").find((f) => f.msgId === msgId);
    expect(say, "no say frame arrived, so the app has nothing to start playing until the " +
      "whole reply is synthesised: the ~25s wait this lane removes").toBeTruthy();
    expect(say!.growing, "the say frame did not say the clip is still growing").toBe(true);
    expect(growing.has(msgId), "the clip is not in the growing set").toBe(true);

    // ...and the first growth beat rides out with it, so the clock starts at once
    const first = frames("say-grow").find((f) => f.msgId === msgId);
    expect(first, "no say-grow rode out with the growing say").toBeTruthy();
    expect(first!.durS, "the first beat has no duration to run the clock on").toBeGreaterThan(0);
    expect(first!.chars).toBe(chunks[0].length);

    const path = audioPath(msgId, "audio/mpeg");
    expect(await seconds(path),
      "the partial clip the app is already playing is not a decodable mp3").toBeGreaterThan(0);

    /* AND IT SERVES, uncached. A device that fetched the short version must
     * re-request the grown one instead of a browser cache answering with the
     * stale length. */
    const res = await http.fetch(`/audio/${msgId}.mp3`);
    expect(res.ok, "the growing clip did not serve").toBe(true);
    expect(res.headers.get("cache-control"),
      "the growing clip was served cacheable, so a device that fetched the short version " +
      "will never see it grow").toContain("no-store");
    expect(res.headers.get("accept-ranges"),
      "the growing clip does not advertise range support").toBe("bytes");
    const partialLen = Number(res.headers.get("content-length"));
    expect(partialLen, "no content-length on the growing clip").toBe(MP3.byteLength);

    // a bounded range is answered 206 with a content-range: the shape an element
    // uses to fetch only the newly-grown bytes
    const ranged = await http.fetch(`/audio/${msgId}.mp3`, { headers: { range: "bytes=0-9" } });
    expect(ranged.status, "a bounded range on the growing clip was not answered 206").toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 0-9/${MP3.byteLength}`);

    /* THE UPSTREAM DIES while the clip is still growing, which is the failure
     * growClip's finally exists for: what landed is closed out to a valid
     * playable partial rather than left stuck growing for ever. */
    held.stop();
    await until(() => frames("say-done").some((f) => f.msgId === msgId),
      { what: "the abandoned clip to be closed out", timeoutMs: 5000 });
    expect(growing.has(msgId), "the clip is still marked growing after the upstream died")
      .toBe(false);
    expect(await seconds(path), "the closed-out partial is not playable").toBeGreaterThan(0);

    // once done it is an ordinary cacheable clip again, served whole
    const after = await http.fetch(`/audio/${msgId}.mp3`);
    expect(after.headers.get("cache-control"), "the finished clip is still uncacheable")
      .toContain("max-age");
    expect((await after.arrayBuffer()).byteLength).toBe(MP3.byteLength);
  } finally {
    held.stop();
  }
});

ff("a media element's open range gets a stream that follows the growing file (#531)", async () => {
  /* Chrome opens a clip with `Range: bytes=0-` (WebKit probes `bytes=0-1`).
   * Answering that with the file's CURRENT length makes the element treat the
   * clip as finished at that length, so playback stopped at the first chunk and
   * the app had to wait for say-done. Those requests get a held-open 200 stream
   * instead: current bytes first, then every appended byte as it lands, closed
   * only when the growing flag clears.
   *
   * Driven against the route directly, with the file grown by hand: the subject
   * is the route's follow loop, and a real synthesis would only add a second
   * clock to the same assertion. */
  const msgId = crypto.randomUUID();
  const path = audioPath(msgId, "audio/mpeg");
  growing.add(msgId);
  await writePrivate(path, MP3 as unknown as ArrayBuffer);

  const res = await http.fetch(`/audio/${msgId}.mp3`, { headers: { range: "bytes=0-" } });
  expect(res.status, "the media open was not answered as a stream").toBe(200);
  expect(res.headers.get("content-length"),
    "the stream states a total, so the element ends at the partial's length").toBeNull();
  expect(res.headers.get("cache-control"), "the stream is cacheable").toContain("no-store");

  const reader = res.body!.getReader();
  let received = 0;
  let ended = false;
  const readAll = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value!.byteLength;
    }
    ended = true;
  })();

  await until(() => received >= MP3.byteLength, { what: "the first chunk's bytes on the stream" });
  const atHold = received;
  expect(ended, "the stream closed while the clip was still growing").toBe(false);

  // the clip grows, and the SAME response carries the new bytes
  await appendPrivate(path, MP3);
  await until(() => received > atHold, { what: "the appended bytes on the held-open stream" });

  // and it closes by itself once the clip finalises
  growing.delete(msgId);
  await until(() => ended, { what: "the stream to close after generation finished", timeoutMs: 5000 });
  expect(received, "the stream did not carry the whole grown file").toBe(MP3.byteLength * 2);
  await readAll;
});

ff("a restart caught mid-growth leaves a valid clip marked done, not stuck growing", async () => {
  /* The state a restart finds: a chat row still marked growing, and a valid
   * partial mp3 on disk for it. Boot sweeps the flag, measures what survived,
   * and persists the correction, so the app that reloads gets a finished voice
   * note instead of following a file that will never grow again. */
  const msgId = crypto.randomUUID();
  await writePrivate(audioPath(msgId, "audio/mpeg"), MP3 as unknown as ArrayBuffer);
  const row: ChatMsg = { id: session.id, role: "claude",
    text: "A reply whose clip was still growing when the engine restarted.",
    ts: 1_000, msgId, growing: true, seq: 0 } as ChatMsg;
  restored.set(session.id, [row]);

  await sweepGrowingClips();

  expect(row.growing,
    "the restored message is still marked growing, so the app follows a file that will " +
    "never grow again").toBeUndefined();
  expect(row.durationS,
    "the swept clip has no duration, so its bubble has a dead clock").toBeGreaterThan(0);
  const measured = row.durationS!; // non-null from the line above
  const patch = patches.find((p) => p.ts === 1_000);
  expect(patch, "the correction was never persisted, so the next restart sweeps it again")
    .toBeTruthy();
  expect(patch!.unset).toContain("growing");
  expect(patch!.set!.durationS).toBe(measured);

  // the partial is still a valid playable clip, served the ordinary way
  const res = await http.fetch(`/audio/${msgId}.mp3`);
  expect(res.ok, "the swept partial clip does not serve").toBe(true);
  expect((await res.arrayBuffer()).byteLength, "the served clip is empty").toBe(MP3.byteLength);
});

ff("a single-chunk reply closes out without ever claiming to grow", async () => {
  /* THE CONTROL. Every case above drives the growth path, so all of them would
   * pass on an engine that marked every reply growing for ever. A one-sentence
   * reply is one write: no growing flag, no growth beats, and a say-done all the
   * same, because the bubble's duration arrives the same way either way. */
  const TEXT = "Short one.";
  const chunks = chunkText(TEXT);
  expect(chunks.length).toBe(1);
  const msgId = crypto.randomUUID();
  const msg = rowFor(TEXT, msgId, false);

  await speakClip(session, msg, chunks, msgId);
  await until(() => frames("say-done").some((f) => f.msgId === msgId),
    { what: "the single-chunk clip to close out" });

  const say = frames("say").find((f) => f.msgId === msgId)!;
  expect(say.growing, "a one-chunk reply announced itself as growing").toBeUndefined();
  expect(frames("say-grow"), "a one-chunk reply sent growth beats").toEqual([]);
  expect(growing.has(msgId)).toBe(false);
  expect(msg.durationS, "the finished bubble has no duration").toBeGreaterThan(0);
});
