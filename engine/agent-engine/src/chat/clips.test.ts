/* The audio clip store (clips.ts): staging vs owned dirs, adoption, the hot
 * cache's two caps, and the traversal filter on clipOnDisk. Scratch dirs; no
 * engine, no ffprobe (durations are not asserted here).
 *
 * clips.ts is a singleton: one hot cache, one byte counter, one injected deps
 * bag. resetForTest() in beforeEach drops all three, and each test wires its own
 * staging dir and agent id under one file-scoped CYC_DATA_DIR, so no test can
 * read another's clip or another's byte total.
 *
 *   bun test agent-engine/src/chat/clips.test.ts
 */

import { expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initClips, resetForTest, audio, audioCacheBytes, growing, cacheAudio,
  audioDirFor, audioDirsFor, audioPath, audioFromDisk, clipOnDisk, adoptStagedClip,
  haveClip, EXT_MIME, AUDIO_KEEP, AUDIO_KEEP_BYTES } from "./clips.ts";
import { tmpDir } from "../test-utils/tmp.ts";

let base = "";
const oldEnv = process.env.CYC_DATA_DIR;

beforeAll(async () => {
  base = await tmpDir("cyc-clips-");
  process.env.CYC_DATA_DIR = base;
});
afterAll(() => {
  if (oldEnv === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = oldEnv;
  resetForTest();
});

beforeEach(() => resetForTest());

/** Wire the singleton for ONE test: its own staging dir and its own agent, so
 *  the agent audio dirs under the shared data dir never collide. */
async function wire(name: string): Promise<{ staging: string; owner: Map<string, string>; aid: string; home: string }> {
  const staging = join(base, name, "staging", "audio") + "/";
  const owner = new Map<string, string>();
  const aid = `ag-${name}`;
  await initClips({ blobOwner: () => owner, agentIdFor: () => aid, stagingDir: staging });
  return { staging, owner, aid, home: join(base, "agents", aid, "audio") + "/" };
}

test("an unclaimed clip lives in staging; a claimed one in its agent's dir", async () => {
  const { staging, owner, home } = await wire("dirs");
  expect(audioDirFor("m1")).toBe(staging);
  owner.set("m1", "ag-dirs");
  expect(audioDirFor("m1")).toBe(home);
  expect(audioPath("m2", "audio/mpeg")).toBe(`${staging}m2.mp3`);
  expect(audioPath("m2", "audio/webm;codecs=opus")).toBe(`${staging}m2.webm`);
});

test("a mime this engine has no extension for becomes .bin, never a bare path", async () => {
  // the extension is how the disk copy is FOUND again; a clip written with no
  // extension at all would be invisible to every reader below
  const { staging } = await wire("mime");
  expect(audioPath("m1", "audio/flac")).toBe(`${staging}m1.bin`);
  expect(audioPath("m1", "")).toBe(`${staging}m1.bin`);
});

test("the search order is owner-dir first, then staging (a failed adoption)", async () => {
  /* A rename that did not happen leaves the clip staged while the index already
   * says who owns it. Both dirs are searched, in that order, so nothing is lost
   * to a half-finished adoption. */
  const { staging, owner, home } = await wire("dirsfor");
  expect(audioDirsFor("m1")).toEqual([staging]);
  owner.set("m1", "ag-dirsfor");
  expect(audioDirsFor("m1")).toEqual([home, staging]);
});

test("cacheAudio persists to disk and audioFromDisk re-warms after eviction", async () => {
  const { staging } = await wire("rewarm");
  const bytes = new TextEncoder().encode("mp3bytes");
  await cacheAudio("m1", bytes, "audio/mpeg");
  expect(await Bun.file(`${staging}m1.mp3`).text()).toBe("mp3bytes");
  resetForTest();
  await wire("rewarm"); // a restart: same disk, empty cache
  const back = await audioFromDisk("m1");
  expect(back?.mime).toBe("audio/mpeg");
  expect(new TextDecoder().decode(back!.bytes)).toBe("mp3bytes");
  expect(audio.has("m1")).toBe(true); // warmed
});

test("the re-warm does NOT write a second copy of what it just read", async () => {
  /* audioFromDisk warms with persist:false. If it persisted, a clip found in
   * staging for an OWNED msgId would be copied into the agent dir on every read,
   * which is a silent duplicate of every megabyte the engine serves. */
  const { staging, owner, home } = await wire("nocopy");
  await Bun.write(`${staging}m1.mp3`, "bytes");
  owner.set("m1", "ag-nocopy");
  expect((await audioFromDisk("m1"))?.mime).toBe("audio/mpeg");
  expect(await readdir(home).catch(() => null)).toBeNull(); // nothing written home
});

test("audioFromDisk answers null when the clip is nowhere, and caches nothing", async () => {
  await wire("nodisk");
  expect(await audioFromDisk("m1")).toBeNull();
  expect(audio.has("m1")).toBe(false);
});

test("every extension the store knows round-trips back to its mime", async () => {
  const { staging } = await wire("exts");
  for (const [ext, mime] of Object.entries(EXT_MIME)) {
    await Bun.write(`${staging}clip-${ext}.${ext}`, ext);
    const got = await audioFromDisk(`clip-${ext}`);
    expect(got?.mime).toBe(mime);
    expect(new TextDecoder().decode(got!.bytes)).toBe(ext);
  }
});

test("the hot cache is bounded by count, oldest out, disk copy untouched", async () => {
  const { staging } = await wire("countcap");
  for (let i = 0; i < AUDIO_KEEP + 5; i++) {
    await cacheAudio(`m${i}`, new Uint8Array([1]), "audio/mpeg");
  }
  expect(audio.size).toBe(AUDIO_KEEP);
  expect(audio.has("m0")).toBe(false); // evicted
  expect(await clipOnDisk("m0")).toBe(`${staging}m0.mp3`); // still on disk
  expect(await haveClip("m0")).toBe(true); // and haveClip says so
});

test("the count cap is exact: AUDIO_KEEP in, the next one evicts exactly one", async () => {
  await wire("countedge");
  for (let i = 0; i < AUDIO_KEEP; i++) await cacheAudio(`m${i}`, new Uint8Array([1]), "audio/mpeg", false);
  expect(audio.size).toBe(AUDIO_KEEP);
  expect(audio.has("m0")).toBe(true); // at the cap, nothing has gone yet
  await cacheAudio("one-more", new Uint8Array([1]), "audio/mpeg", false);
  expect(audio.size).toBe(AUDIO_KEEP);
  expect(audio.has("m0")).toBe(false);
  expect(audio.has("m1")).toBe(true); // and only the oldest went
});

test("the byte counter tracks the cache, including a replaced entry", async () => {
  /* The counter is separate state from the map, which is the thing that rots:
   * a replace that forgot to subtract the old length would drift the total up
   * until every later clip evicted on sight. */
  await wire("bytes");
  expect(audioCacheBytes()).toBe(0);
  await cacheAudio("m1", new Uint8Array(10), "audio/mpeg", false);
  expect(audioCacheBytes()).toBe(10);
  await cacheAudio("m2", new Uint8Array(5), "audio/mpeg", false);
  expect(audioCacheBytes()).toBe(15);
  await cacheAudio("m1", new Uint8Array(1), "audio/mpeg", false); // same id, smaller clip
  expect(audioCacheBytes()).toBe(6);
  expect(audio.size).toBe(2);
});

test("a clip bigger than the whole byte budget evicts even itself", async () => {
  /* The documented behaviour: the disk copy is written regardless and serving
   * re-reads from disk, so refusing to cache a monster is better than letting
   * one clip pin the entire budget. persist:false keeps this test off the disk. */
  await wire("bytecap");
  await cacheAudio("small", new Uint8Array(10), "audio/mpeg", false);
  await cacheAudio("monster", new Uint8Array(AUDIO_KEEP_BYTES + 1), "audio/mpeg", false);
  expect(audio.has("monster")).toBe(false);
  expect(audio.has("small")).toBe(false); // it took the rest of the cache with it
  expect(audioCacheBytes()).toBe(0);
});

test("resetForTest zeroes the byte counter, not just the map", async () => {
  /* THE ORDER-DEPENDENCE this replaces: the old test called audio.clear(), which
   * left audioBytes holding the previous test's total. The next cacheAudio then
   * evicted immediately and the failure looked like a cap bug. */
  await wire("resetbytes");
  await cacheAudio("m1", new Uint8Array(1024), "audio/mpeg", false);
  expect(audioCacheBytes()).toBeGreaterThan(0);
  resetForTest();
  expect(audio.size).toBe(0);
  expect(audioCacheBytes()).toBe(0);
  expect(growing.size).toBe(0);
});

test("persist:false leaves nothing on disk at all", async () => {
  const { staging } = await wire("nopersist");
  await cacheAudio("m1", new Uint8Array([1]), "audio/mpeg", false);
  expect(audio.has("m1")).toBe(true);
  expect(await readdir(staging)).toEqual([]);
  expect(await clipOnDisk("m1")).toBeNull();
  expect(await haveClip("m1")).toBe(true); // the cache still answers
});

test("a disk write that cannot happen THROWS rather than reporting a saved clip", async () => {
  /* The app's single tick means "your recording cannot be lost". It must never
   * be drawn on "a write has been queued", so a failing write has to reach the
   * caller. */
  const { staging } = await wire("writefail");
  await mkdir(staging, { recursive: true });
  await mkdir(`${staging}m1.mp3`, { recursive: true }); // a directory in the file's place
  await expect(cacheAudio("m1", new Uint8Array([1]), "audio/mpeg")).rejects.toThrow();
});

test("clipOnDisk refuses a traversal msgId outright", async () => {
  await wire("traversal");
  expect(await clipOnDisk("../../../etc/passwd")).toBeNull();
  expect(await clipOnDisk("a/b")).toBeNull();
});

test("the msgId filter refuses every shape that could leave the audio dir", async () => {
  /* haveClip feeds `rescuable`, whose transcript becomes chat content, so a
   * traversal here is a path from the wire to chat content and not merely to a
   * boolean. Anything with a slash, a backslash, a null or a length over 64 is
   * refused before it is pasted into a path. */
  await wire("filter");
  for (const bad of [
    "", "/etc/passwd", "..%2f..%2fetc", "a\\b", "a\0b", "a b", "x".repeat(65),
    "m1;rm -rf", "m1\n", "~/secret", "$HOME",
  ]) {
    expect(await clipOnDisk(bad)).toBeNull();
    expect(await haveClip(bad)).toBe(false);
  }
  // the alphabet the minters actually use is accepted
  expect("x".repeat(64).length).toBe(64);
  await cacheAudio("x".repeat(64), new Uint8Array([1]), "audio/mpeg");
  expect(await clipOnDisk("x".repeat(64))).not.toBeNull();
});

test("adoption moves the staged clip into the agent's dir and stamps the index", async () => {
  const { staging, owner, home } = await wire("adopt");
  await Bun.write(`${staging}note1.webm`, "opus");
  await adoptStagedClip("w1:p1", "note1");
  expect(owner.get("note1")).toBe("ag-adopt");
  expect(await Bun.file(`${home}note1.webm`).text()).toBe("opus");
  expect(await Bun.file(`${staging}note1.webm`).exists()).toBe(false);
  // and lookups now find it at home
  expect(await clipOnDisk("note1")).toBe(`${home}note1.webm`);
});

test("adoption with nothing staged stamps no owner", async () => {
  // the index is what tells every later reader where to look; claiming an agent
  // owns a clip that does not exist would send every lookup to the wrong dir
  const { owner } = await wire("adoptnone");
  await adoptStagedClip("w1:p1", "ghost");
  expect(owner.has("ghost")).toBe(false);
});

test("adoption refuses an unsafe msgId without touching the session state", async () => {
  const { owner } = await wire("adoptbad");
  let asked = 0;
  await initClips({
    blobOwner: () => owner,
    agentIdFor: () => { asked++; return "ag-adoptbad"; },
    stagingDir: join(base, "adoptbad", "staging", "audio") + "/",
  });
  await adoptStagedClip("w1:p1", "../../etc/passwd");
  expect(asked).toBe(0);
  expect(owner.size).toBe(0);
});

test("adoption is idempotent and moves the clip only once", async () => {
  const { staging, owner, home } = await wire("adopt2");
  await Bun.write(`${staging}n.mp3`, "a");
  await adoptStagedClip("w1:p1", "n");
  await adoptStagedClip("w1:p1", "n"); // the message committed twice (a resend)
  expect(owner.get("n")).toBe("ag-adopt2");
  expect(await readdir(home)).toEqual(["n.mp3"]);
  expect(await readdir(staging)).toEqual([]);
});

test("haveClip is cache OR disk, never cache alone", async () => {
  /* The hot cache is capped and a restart empties it, while the clip is on disk
   * from the moment /user-audio answers. Asking the cache alone would tell a
   * device its recording is gone. */
  const { staging } = await wire("have");
  await writeFile(`${staging}ondisk.mp3`, "x");
  expect(audio.has("ondisk")).toBe(false);
  expect(await haveClip("ondisk")).toBe(true);
  await cacheAudio("incache", new Uint8Array([1]), "audio/mpeg", false);
  expect(await clipOnDisk("incache")).toBeNull();
  expect(await haveClip("incache")).toBe(true);
  expect(await haveClip("neither")).toBe(false);
});

test("the growing set is plain state the reset clears", async () => {
  // while an id is in here /audio/<id>.mp3 serves the CURRENT disk bytes with
  // no-store, so a device that fetched the short version re-requests the grown one
  await wire("growing");
  growing.add("m1");
  expect(growing.has("m1")).toBe(true);
  resetForTest();
  expect(growing.has("m1")).toBe(false);
});
