/* THE PICTURE HE PICKED FOR A SESSION LIVES HERE (task 331).
 *
 * WHY THIS FILE EXISTS
 *
 * "the photo then lives with the agent engine and it serves that as a profile
 * photo". The whole point of putting it on the engine rather than on a device
 * is that it is the same on his phone, his tablet and his laptop, and survives
 * the app being reinstalled. Four things have to be true for that sentence to
 * mean anything, and each one is a test below:
 *
 *   1. THE BYTES COME BACK. A POST stores them and a GET hands back exactly
 *      what was sent, with the type it was sent with. Not "a 200": the bytes,
 *      compared.
 *   2. EVERY DEVICE IS TOLD. Setting a photo broadcasts the sessions frame, so
 *      the tablet that did not upload it repaints without being asked. This is
 *      also the one thing a deduped broadcast can silently lose: the payload is
 *      compared against the previous one before it is sent, so a photo replaced
 *      with another photo has to serialize DIFFERENTLY or the second one never
 *      leaves the engine. That is what the `?v=` stamp is for.
 *   3. A REFUSAL CHANGES NOTHING. A type this engine will not store is answered
 *      with a status and a sentence, and the session keeps the picture it had.
 *      Half-applying it (clearing the record, or storing the file anyway) is the
 *      failure that would leave a device showing a face that is gone.
 *   4. NOBODY SWEEPS THIS DIRECTORY. trimUploads() bounds the staging uploads
 *      dir at 200 files and spares only what a chat message points at, and no
 *      message points at a profile photo. A photo stored there would survive
 *      until two hundred newer attachments existed and then vanish, which is
 *      the worst kind of failure because it is late and silent.
 *
 * AND THE TYPE WHITELIST IS A SECURITY CONTROL, not a tidiness rule. This file
 * is served straight back to a browser with the type it arrived with, and
 * `image/*` includes `image/svg+xml`, which is a document that runs script. So
 * what is REFUSED is tested at least as hard as what is accepted, and every
 * refusal is checked for having written nothing and changed nothing.
 *
 * NO ENGINE IS SPAWNED. wireCore performs server.ts's own boot wiring in
 * process over a fake herdr and a throwaway data dir; serveRoutes runs the REAL
 * routes/media.ts over a real Bun.serve on port 0. Nothing here goes near his
 * own data dir.
 *
 *   bun test agent-engine/src/chat/photo.test.ts
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { wireCore, sessionsFrame, wireId, type WireCore } from "../test-utils/wire-core.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { until } from "../test-utils/wait.ts";

import { mediaRoutes } from "../routes/media.ts";
import { photoDirFor, photoRecOf } from "../sessions/session-state.ts";
import { stagingUploadsDir } from "../storage/datadir.ts";

/* TWO REAL PNGs, not two buffers of zeroes called that. The engine keys on the
 * content-type header rather than sniffing, so a fake would pass every check
 * here, but the bytes are compared on the way out and a fixture that is
 * actually an image is the one that survives anything ever looking at it.
 *
 * 64x64, minted with pngjs: magenta with a white L, and blue with a white L in
 * the opposite corner. They are the same two the app-side spec uses
 * (callyourcode-app e2e/offline/profilephoto.spec.ts).
 *
 * THEY ARE DIFFERENT PICTURES, which is the whole of the replace test: the wire
 * path for a session's photo is keyed on the PANE, so replacing one picture
 * with another produces the same path, and the sessions broadcast is deduped
 * against its previous payload. Two identical fixtures would make that test
 * pass for the wrong reason. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAiElEQVR4AeXBQRHAIADAsK6HF3Sj" +
  "CjlsBvbm0eQ5Hy7ac3GTxEmcxEmcxA1+7LkokDiJkziJkziJkziJkziJkziJkziJkziJkziJkziJ" +
  "kziJkziJk7ix56JM4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO" +
  "4l64ugldPY2KUQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAjElEQVR4AeXBMQ2AMAAAwedTJWxV" +
  "hEUUsVULGGCH5O+2/bxuwiRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO" +
  "4iRO4iRO4gYR65i8kTiJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJG/zAOiZfkTiJ" +
  "kziJk7gHtyoF3XeCCF4AAAAASUVORK5CYII=",
  "base64",
);

/** The cap in routes/media.ts. Not exported there; asserted against the answer
 *  the route itself gives, so a change on either side is visible. */
const PHOTO_MAX = 8 * 1024 * 1024;

let core: WireCore;
let srv: ServedRoutes;

beforeAll(async () => {
  core = await wireCore({ with: ["sessions"] });
  await until(() => !!core.byHandle(PANE),
    { what: "the fake pane to become a session" });
  srv = serveRoutes({
    groups: [mediaRoutes],
    // the photo branches read sessions/photo state from the modules; uploads is
    // wired anyway so a route that reached for it would behave, not throw
    ctx: { uploads: core.uploads! },
  });
});

afterAll(async () => {
  srv.stop();
  await core.stop();
});

/* Every test starts with NO picture and NO file. Clearing through the real
 * route rather than by poking the map, so the clear path is exercised on every
 * run and a leftover file from a previous test can never make the next one pass
 * for the wrong reason. */
beforeEach(async () => {
  await setPhoto(new Uint8Array(0));
  await rm(join(photoDirFor(wireId(PANE)), "thumbs"), { recursive: true, force: true });
  expect(await photoFiles()).toEqual([]);
});

function setPhoto(body: Uint8Array | string, mime?: string, extra: Record<string, string> = {}) {
  return srv.fetch(`/session/${encodeURIComponent(wireId(PANE))}/photo`, {
    method: "POST",
    headers: { ...(mime ? { "content-type": mime } : {}), ...extra },
    body,
  });
}

/** The photo files on disk for PANE. The derived thumbs live in a subdirectory
 *  and are not one of them. */
async function photoFiles(): Promise<string[]> {
  const files = await readdir(photoDirFor(wireId(PANE))).catch(() => [] as string[]);
  return files.filter((f) => f !== "thumbs");
}

/** What this engine is putting on the wire for PANE right now. */
function wirePhoto(): string | null | undefined {
  const row = (sessionsFrame().list as Array<Record<string, any>>).find((s) => s.id === wireId(PANE));
  expect(row, `the engine did not list ${wireId(PANE)} at all`).toBeTruthy();
  return row!.photo;
}

/* --------------------------------------------------------- the bytes come back */

test("a session with no photo is told about as null, not left out", async () => {
  /* Absent would read to a client as "an engine too old to say", whose only
   * safe answer is to keep what it has, so a removed photo would linger on his
   * other device forever. null is an instruction; absent is a shrug. */
  expect(wirePhoto()).toBe(null);
  expect(photoRecOf(wireId(PANE))).toBeUndefined();
});

test("a photo is stored, served back byte for byte, and named on the wire", async () => {
  const res = await setPhoto(PNG, "image/png");
  const text = await res.text();
  expect(res.status, text).toBe(200);
  const said = JSON.parse(text) as { ok: boolean; photo: string };
  expect(said.ok).toBe(true);

  /* IT IS A PATH ON THIS ENGINE, NOT A URL. The same engine is `localhost` to
   * the laptop it runs on and a `.ts.net` name to the phone; an engine that
   * wrote its own idea of its address in here would hand the phone something it
   * cannot reach. */
  expect(said.photo, "the engine answered with an absolute URL, so it has guessed which " +
    "of its names the client dialled").toStartWith("/session-photo/");
  expect(wirePhoto(), "the sessions frame does not carry what the POST said").toBe(said.photo);

  // THE BYTES, compared. A 200 is not a photo.
  const got = await srv.get(said.photo);
  expect(got.status).toBe(200);
  expect(got.headers.get("content-type"), "the type it was stored with is not the type it " +
    "is served with, so a browser has to guess").toBe("image/png");
  const back = Buffer.from(await got.arrayBuffer());
  expect(back.equals(PNG), `${back.byteLength} bytes came back and ${PNG.byteLength} went in`)
    .toBe(true);

  // one file, named after nothing a client chose
  const files = await photoFiles();
  expect(files.length).toBe(1);
  expect(files[0]).toMatch(/^[0-9a-f-]{36}\.png$/);
});

test("the served path carries a ?v= stamp that moves with the picture", async () => {
  await setPhoto(PNG, "image/png");
  const first = wirePhoto()!;
  expect(first).toContain("?v=");
  /* The stamp is what makes a replaced photo a different URL to the browser
   * cache AND a different payload to the sessions dedupe. The serve route does
   * not read it: whatever the stamp says, the file answered with is the current
   * one, which is why a stale ?v= in a cached frame still shows the right face. */
  const stale = `${first.split("?")[0]}?v=1`;
  const got = await srv.get(stale);
  expect(got.status).toBe(200);
  expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
});

/* ------------------------------------------------------- every device is told */

test("replacing a photo reaches a device that did not upload it", async () => {
  /* A SECOND CLIENT, listening, because this is the whole claim: the photo
   * lives on the engine so it is the same on every device. This socket does not
   * upload anything; it must still learn about both. */
  const watcher = core.client();
  watcher.clear();

  await setPhoto(PNG, "image/png");

  /* WAIT FOR THE MILLISECOND TO TURN, and this is a finding rather than a
   * nicety: the `?v=` stamp is `rec.ts`, a plain Date.now(), so two photos
   * stored inside the SAME millisecond serialise to the identical wire value
   * and the sessions dedupe eats the second frame. A person cannot replace a
   * picture twice in a millisecond, so this is not a live defect, but the stamp
   * only promises what a clock promises. The old spec hid it behind a 400ms
   * sleep; this waits for the one thing that actually has to be true, and says
   * why. If the stamp ever becomes strictly increasing, this line can go. */
  const firstTs = photoRecOf(wireId(PANE))!.ts;
  await until(() => Date.now() > firstTs, { what: "the ?v= stamp's millisecond to turn" });

  /* A DIFFERENT PICTURE, and this is the case a deduped broadcast eats. The
   * wire path is keyed on the PANE, so a second photo has the same path as the
   * first; the sessions payload is compared against its predecessor before it
   * is sent, so without the `?v=` stamp the second frame is byte-identical to
   * the first and never leaves the engine. The watching device then keeps
   * showing a picture he replaced. */
  await setPhoto(PNG2, "image/png");

  const seen = watcher.of("sessions")
    .map((f) => (f.list as Array<Record<string, any>>).find((s) => s.id === wireId(PANE))?.photo ?? null)
    .filter((p): p is string => typeof p === "string");

  expect(seen.length,
    `the watching client was told about ${seen.length} photo(s), not two. If it saw one, ` +
    "the sessions broadcast deduped the second: the payload has to differ between two " +
    "photos, which is what the ?v= stamp is for.").toBeGreaterThanOrEqual(2);
  expect(seen[seen.length - 1],
    "the second photo produced the same wire value as the first").not.toBe(seen[0]);

  /* AND THE OLD FILE IS GONE. One file per pane, replaced rather than piled up:
   * this directory has no sweep, so nothing else would ever remove it. */
  const files = await photoFiles();
  expect(files.length,
    `${files.length} files after two uploads for one pane: ${JSON.stringify(files)}`).toBe(1);

  // the file on disk is the NEW picture, not the old one left in place
  const got = await srv.get(wirePhoto()!);
  expect(Buffer.from(await got.arrayBuffer()).equals(PNG2)).toBe(true);
  watcher.close();
});

test("clearing a photo is broadcast too, so a device stops showing a face he removed", async () => {
  await setPhoto(PNG, "image/png");
  const watcher = core.client();
  watcher.clear();

  const res = await setPhoto(new Uint8Array(0));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { photo: unknown }).photo).toBe(null);

  const rows = watcher.of("sessions")
    .map((f) => (f.list as Array<Record<string, any>>).find((s) => s.id === wireId(PANE)));
  expect(rows.length, "clearing a photo told nobody").toBeGreaterThanOrEqual(1);
  expect(rows[rows.length - 1]!.photo).toBe(null);
  expect(wirePhoto(), "the wire still names a photo after it was cleared").toBe(null);
  expect(await photoFiles(), "clearing left the file on disk").toEqual([]);
  watcher.close();
});

/* ------------------------------------------------------ the type whitelist */

/* WHAT THIS ENGINE WILL STORE, and what it will serve that file back as. Every
 * one of these round-trips with the type it arrived with, because that header
 * is what a browser renders by. */
const ACCEPTED: Array<[mime: string, ext: string]> = [
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
];

for (const [mime, ext] of ACCEPTED) {
  test(`${mime} is stored as .${ext} and served back as ${mime}`, async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const res = await setPhoto(bytes, mime);
    expect(res.status).toBe(200);
    const said = (await res.json()) as { ok: boolean; photo: string };
    expect(said.ok).toBe(true);
    expect((await photoFiles())[0]).toEndWith(`.${ext}`);

    const got = await srv.get(said.photo);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe(mime);
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([...bytes]);
  });
}

test("the content-type is parsed the way a browser sends it: parameters and case", async () => {
  /* A phone's upload arrives as `image/png` and a desktop's as
   * `image/PNG; charset=UTF-8`. Both are the same type, and refusing the second
   * would be a photo that works on one device and not the other. The route
   * splits at the semicolon and lowercases, and the SERVED type is the
   * normalised one, so the whitelist and the response header cannot drift. */
  const res = await setPhoto(PNG, "image/PNG; charset=UTF-8");
  expect(res.status).toBe(200);
  const said = (await res.json()) as { photo: string };
  const got = await srv.get(said.photo);
  expect(got.headers.get("content-type")).toBe("image/png");
});

/* WHAT IT WILL NOT STORE. Each of these is a real thing a client could send,
 * and the first one is the reason the list is a whitelist rather than a
 * `startsWith("image/")`. */
const REFUSED: Array<[what: string, mime: string | undefined, body: string]> = [
  /* AN SVG IS A DOCUMENT THAT RUNS SCRIPT. It matches image/*, a browser
   * renders it inline from this route's own origin, and this engine serves the
   * file back with the type it arrived with. Storing one would be a stored XSS
   * on the engine's origin with a one-request upload. */
  ["an svg", "image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"],
  ["html dressed as a photo", "text/html", "<html><script>1</script></html>"],
  ["a pdf", "application/pdf", "%PDF-1.4"],
  ["an unlabelled blob", "application/octet-stream", "whatever"],
  ["a bitmap this engine has no decoder for", "image/bmp", "BM"],
  ["a tiff", "image/tiff", "II*"],
  /* image/svg+xml with a parameter, because the normalisation must not be a way
   * back in: `image/svg+xml; charset=utf-8` splits to the same refused type. */
  ["an svg with a charset parameter", "image/svg+xml; charset=utf-8", "<svg/>"],
  ["no content-type at all", undefined, "bytes with no type"],
];

for (const [what, mime, body] of REFUSED) {
  test(`${what} is refused, and the session keeps the picture it had`, async () => {
    await setPhoto(PNG, "image/png");
    const before = wirePhoto() ?? null;
    expect(typeof before).toBe("string");
    const filesBefore = await photoFiles();

    const res = await setPhoto(body, mime);
    expect(res.status, `${mime ?? "an untyped body"} was accepted as a profile photo`).toBe(415);
    const said = (await res.json()) as { ok: boolean; error: string };
    expect(said.ok).toBe(false);
    expect(said.error, "the refusal does not say what it will store, so the client can only " +
      'report "it failed"').toContain("image/png");
    expect(said.error, "the refusal does not say that nothing changed, which is the half the " +
      "client repeats to him").toContain("keeps the picture it had");

    /* NOTHING WAS HALF-APPLIED. The record still names the picture that was
     * there, it is still servable, and the refused bytes are not on disk under
     * any name. A refusal that cleared the record would take his photo off
     * three devices to tell him about one bad file. */
    expect(wirePhoto(), "the refused upload changed what the engine says this session's " +
      "photo is").toBe(before);
    expect(await photoFiles(), "the refused body was written to disk anyway")
      .toEqual(filesBefore);
    const still = await srv.get(before as string);
    expect(still.status).toBe(200);
    expect(Buffer.from(await still.arrayBuffer()).equals(PNG)).toBe(true);
  });
}

test("a refusal names every type this engine WILL store", async () => {
  const res = await setPhoto("<svg/>", "image/svg+xml");
  const said = (await res.json()) as { error: string };
  // the message is the client's whole vocabulary for this failure; a list that
  // has drifted from the whitelist is a user retrying a format that cannot work
  const [offered, sent] = said.error.split(", and the body was sent as ");
  for (const [mime] of ACCEPTED) expect(offered).toContain(mime);
  // and the refused type is named in the SENT half, never in the offered one
  expect(offered, "the refusal offers the very type it just refused").not.toContain("svg");
  expect(sent).toContain("image/svg+xml");
});

test("a picture over the cap is refused and nothing is stored", async () => {
  await setPhoto(PNG, "image/png");
  const before = wirePhoto() ?? null;
  const res = await setPhoto(new Uint8Array(PHOTO_MAX + 1).fill(7), "image/png");
  expect(res.status).toBe(413);
  const said = (await res.json()) as { error: string; max: number };
  /* The cap is enforced while the body is being READ, so this is body-limits'
   * refusal and not the route's own (which is the belt behind it, unreachable
   * while the read cap is the same number). Either way: nothing stored. */
  expect(said.error).toBe("body too large");
  expect(said.max).toBe(PHOTO_MAX);
  expect(wirePhoto() ?? null).toBe(before);
  expect(await photoFiles()).toHaveLength(1);
});

/* ------------------------------------------------------------ who may set it */

test("a proxied request cannot set a photo, and nothing is stored", async () => {
  /* Behind `tailscale serve` every tailnet peer arrives from 127.0.0.1, so the
   * loopback check alone is no gate at all: the presence of x-forwarded-for is
   * what says a proxy was in the path. Without this, any tailnet peer could
   * reface his agents. */
  const res = await setPhoto(PNG, "image/png", { "x-forwarded-for": "100.64.0.9" });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toContain("enrolled device");
  expect(await photoFiles()).toEqual([]);
  expect(wirePhoto()).toBe(null);
});

test("a photo for a session this engine does not have is a 404", async () => {
  const res = await srv.fetch("/session/no-such-pane/photo", {
    method: "POST", headers: { "content-type": "image/png" }, body: PNG,
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe("no such session");
  // and it wrote nothing anywhere for the pane it does have
  expect(await photoFiles()).toEqual([]);
});

/* --------------------------------------------------------------- serving out */

test("an unknown session photo is a 404, and a traversal attempt is just unknown", async () => {
  expect((await srv.get("/session-photo/nobody")).status).toBe(404);
  /* The id is a MAP KEY, never a path fragment: the file is looked up by the
   * record the map holds, so a crafted id has nothing to traverse into. */
  expect((await srv.get("/session-photo/..%2F..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
  expect((await srv.get("/session-photo/" + encodeURIComponent("../../keys.json"))).status)
    .toBe(404);
});

test("a record whose file is gone is a 404, and the record is left alone", async () => {
  await setPhoto(PNG, "image/png");
  const path = wirePhoto()!;
  const rec = photoRecOf(wireId(PANE))!;
  await rm(join(photoDirFor(wireId(PANE)), rec.file), { force: true });

  const got = await srv.get(path);
  expect(got.status).toBe(404);
  /* THE RECORD SURVIVES. The map says there is a photo and the disk says there
   * is not; the app draws its robot letter for a picture that will not load. A
   * directory that has been moved, or is not mounted yet, must never be turned
   * into a deletion. */
  expect(photoRecOf(wireId(PANE))).toEqual(rec);
  expect(wirePhoto()).toBe(path);

  // put a real file back under the record, so the next test's clear has
  // something to unlink instead of logging an ENOENT this test caused
  await setPhoto(PNG, "image/png");
});

/* ------------------------------------------------- and NOT in the swept dir */

test("the photo is not in the swept uploads directory", async () => {
  await setPhoto(PNG, "image/png");

  /* THE DIRECTORY IS THE DECISION. trimUploads() bounds the staging uploads dir
   * at 200 files and spares only what a chat message points at; no message
   * points at a profile photo, so one stored there is exactly the "unreferenced
   * debris" that sweep exists to delete. It would survive until two hundred
   * newer attachments existed and then go, silently, months later.
   *
   * This asserts the CHOICE rather than the sweep: the sweep is proven in
   * uploads.test.ts, and reproducing it here would take 200 POSTs to say
   * something one readdir says. */
  const uploads = await readdir(stagingUploadsDir()).catch(() => [] as string[]);
  expect(uploads.length,
    "a profile photo was written into the staging uploads dir, which trimUploads sweeps " +
    "down to 200 files sparing only what a chat message references. Nothing references a " +
    `profile photo: ${JSON.stringify(uploads)}`).toBe(0);

  // it is under the AGENT's own tree, which nothing bounds
  expect(await photoFiles()).toHaveLength(1);
  expect(photoDirFor(wireId(PANE))).toContain("/agents/");
  expect(photoDirFor(wireId(PANE))).toEndWith("/photos");
  expect(photoDirFor(wireId(PANE)).startsWith(stagingUploadsDir())).toBe(false);
});
