/* ROUTES: blobs: user audio, uploads, clips, docs and session photos (L4 interface; blueprint 4b row 29).
 * Extracted verbatim from server.ts routeRequest; each handler answers a
 * Response or null (not mine). The auth gates stay per-route
 * (requireOwner/requireLocal), exactly as the if-chain had them. */

import type { RoutesCtx } from "./ctx.ts";
import { STATE_BODY_MAX_BYTES, UPLOAD_BODY_MAX_BYTES, readBodyCapped, readTextCapped } from "../storage/body-limits.ts";
import { cleanDuration } from "../chat/chatmsg.ts";
import { audio, audioCacheBytes, audioFromDisk, audioPath, cacheAudio, growing } from "../chat/clips.ts";
import { readState, writeState } from "../storage/docstate.ts";
import { json, requireOwner } from "../transport/httpx.ts";
import { newCid, safeCid } from "../../../shared/logbook.ts";
import { FILE_MODE, mkdirPrivate, mkdirPrivateSync, writePrivate } from "../../../shared/runfiles.ts";
import { docDirsOf, photoDirFor, photoOf, photoRecOf, sessions, setPhotoRec, thumbDirFor, type PhotoRec } from "../sessions/session-state.ts";
import { broadcastSessions } from "../sessions/sessions-frame.ts";
import { UPLOAD_MAX } from "../chat/uploads.ts";
import { chmod, unlink } from "node:fs/promises";
import { join } from "node:path";

/* Eight megabytes, well under UPLOAD_MAX's fifty. A camera-roll photo off a
 * phone is two to five; anything past this is not a face, and it is a file that
 * every device on the tailnet then downloads on every boot. */
const PHOTO_MAX = 8 * 1024 * 1024;
const PHOTO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
};
const USER_AUDIO_MAX = UPLOAD_BODY_MAX_BYTES; // voice-note upload cap (his call, 2026-08-09: 300MB, hours of speech)

export async function mediaRoutes(ctx: RoutesCtx, req: Request, url: URL, path: string,
  server: import("bun").Server): Promise<Response | null> {

  /* The v1 E2E capability gate (task 527) was deleted here (#579). It
   * only ran in allow/require mode, which the OSS local install never entered,
   * so the shipped path was already ungated loopback HTTP. The HTTP sideband is
   * authenticated by the transport in the fold-in (loopback + the DC tunnel in
   * a later slice), not a per-URL cap. */

  // User voice-note upload: the page posts its recorded clip BEFORE the
  // utterance frame, then references the returned msgId in it -- so history
  // replay can rebuild a playable voice bubble instead of a text-only one.
  if (path === "/user-audio" && req.method === "POST") {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    /* THE JOIN BETWEEN THE TWO ID SPACES.
     *
     * The browser minted `cid` when the microphone opened; the engine mints
     * `msgId` here. Every line below carries both, so a grep on the cid crosses
     * into the engine's world and a grep on the msgId crosses back. Without it
     * the browser's story and the engine's story were about the same recording
     * and shared no identifier at all. */
    const cid = safeCid(url.searchParams.get("cid")) || newCid("u");
    const got = await readBodyCapped(req, USER_AUDIO_MAX);
    if (!got.ok) return got.response;
    const bytes = got.value;
    if (bytes.byteLength === 0) {
      ctx.log("user-audio.rejected", { cid, bytes: 0, status: 400,
        why: "the body was empty, so there is no recording to store" });
      return json({ error: "empty body" }, 400);
    }
    if (bytes.byteLength > USER_AUDIO_MAX) {
      ctx.log("user-audio.rejected", { cid, bytes: bytes.byteLength, cap: USER_AUDIO_MAX,
        status: 413, why: "the clip is over the size cap and is not stored at all" });
      return json({ error: "too large" }, 413);
    }
    const msgId = crypto.randomUUID();
    /* The msgId is only worth having once the clip behind it is on disk. This
     * is the one recording in the system with no other copy anywhere: the
     * phone hands it over and forgets it, so if the write fails the bytes are
     * gone the moment the hot cache evicts them. Answering with a 500 is what
     * lets the app NOT draw the tick (client.ts uploadAudio throws on any
     * non-ok status), and no tick beats a wrong one. Same shape as /upload
     * below, which has always awaited its write. */
    try {
      await cacheAudio(msgId, bytes, req.headers.get("content-type") || "audio/webm");
    } catch (e) {
      ctx.log("user-audio.persist-failed", { cid, msgId, bytes: bytes.byteLength,
        err: String(e), status: 500,
        why: "the clip could not be written to disk, so no msgId is handed out and " +
          "the app will not draw a tick" });
      return json({ error: "persist failed" }, 500);
    }
    ctx.log("user-audio.stored", { cid, msgId, bytes: bytes.byteLength,
      mime: req.headers.get("content-type") || "audio/webm",
      cached: audio.size, cachedBytes: audioCacheBytes() });
    return json({ msgId });
  }


  // Attachments from the page: images and arbitrary files. Kept on disk and
  // handed to the session as a real path, so the agent can just read it.
  if (path === "/upload" && req.method === "POST") {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const got = await readBodyCapped(req, UPLOAD_MAX);
    if (!got.ok) return got.response;
    const bytes = got.value;
    if (bytes.byteLength === 0) return json({ error: "empty body" }, 400);
    if (bytes.byteLength > UPLOAD_MAX) return json({ error: "too large" }, 413);
    const mime = req.headers.get("content-type") || "application/octet-stream";
    const raw = req.headers.get("x-filename") || "upload";
    // never let a client-supplied name escape the directory
    const name = (decodeURIComponent(raw).split("/").pop() || "upload").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
    const uploadId = crypto.randomUUID();
    const stored = `${ctx.uploads.dir}${uploadId}-${name}`;
    await writePrivate(stored, bytes);
    ctx.uploads.minted.add(uploadId);
    // after the write, and not awaited: the answer is what the page is waiting
    // on, and this file is the newest so the sweep cannot touch it
    void ctx.uploads.trimUploads("upload");
    /* HOW LONG THE RECORDING IS, minted here with the file rather than taken
     * on trust later.
     *
     * It has to come from the client because nothing on this side can work it
     * out (see UploadRec.durationS), so the boundary is this header and the
     * sanitiser behind it, not the record a client hands back afterwards.
     * Absent unless the header was sane, which is what an attachment that is
     * not a recording looks like. */
    const durationS = cleanDuration(req.headers.get("x-duration-s"));
    return json({
      uploadId,
      name,
      mime,
      size: bytes.byteLength,
      path: stored,
      image: mime.startsWith("image/"),
      ...(durationS ? { durationS } : {}),
    });
  }


  const up = path.match(/^\/upload\/([0-9a-f-]+)$/);
  if (up) {
    // Attachment bytes: the tunnel and the host only. The app
    // fetches this as a blob: URL over the tunnel now (engineObjectUrl).
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const stored = await ctx.uploads.ownedUploadPath(up[1]);
    if (!stored) return new Response("not found", { status: 404 });
    const f = Bun.file(stored);
    return new Response(f, {
      headers: { "cache-control": "public, max-age=86400" },
    });
  }


  const clip = path.match(/^\/audio\/([^/]+)\.mp3$/);
  if (clip) {
    // Spoken-reply + voice-note audio: the tunnel and the host only. The app
    // fetches clips as blob: URLs over the tunnel (audioCache);
    // call-mode audio rides the media track, not this route.
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    /* A GROWING CLIP (#525) is served from its CURRENT disk bytes, never the hot
     * cache (which holds nothing until the clip finishes) and never cached by the
     * browser: `no-store` is what makes a device that fetched the short version
     * re-request the grown one instead of a stale-length cache answering. Range
     * is honoured so an <audio> element or a MediaSource can follow the file as
     * it grows; a plain fetch with no Range gets the whole current file (200). */
    if (growing.has(clip[1])) {
      const msgId = clip[1];
      const f = Bun.file(audioPath(msgId, "audio/mpeg"));
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      const range = req.headers.get("range");
      /* PLAY WHILE GROWING (#531). A media element opens its clip with an
       * open-from-zero range (Chrome `bytes=0-`, WebKit's `bytes=0-1` probe);
       * answering that with the file's CURRENT length makes the element treat
       * the clip as finished at that length, so playback stopped at the first
       * chunk and the app had to wait for say-done. Those requests now get a
       * 200 chunked stream instead: current bytes first, then every appended
       * byte as it lands, closed when finalizeClip clears the growing flag.
       * No accept-ranges and no content-length, so the element plays it like
       * a radio stream and `ended` fires only at the true end of the reply.
       * Plain fetches (waveform decode, cache warm) and bounded mid-file
       * ranges keep the snapshot answers below: a fetch that wants bytes now
       * must not block until generation finishes. */
      const mediaOpen = range && /^bytes=0-(1)?$/.test(range.trim());
      if (mediaOpen) {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let sent = 0;
            const started = Date.now();
            try {
              // still-growing safety: a finalize that never comes (engine bug,
              // sweep raced) must not hold the socket forever
              while (Date.now() - started < 10 * 60_000) {
                const cur = Bun.file(audioPath(msgId, "audio/mpeg"));
                const size = (await cur.exists()) ? cur.size : 0;
                if (size > sent) {
                  const all = new Uint8Array(await cur.arrayBuffer());
                  controller.enqueue(all.subarray(sent));
                  sent = all.byteLength;
                }
                if (!growing.has(msgId) && sent >= size) break;
                await new Promise((r) => setTimeout(r, 150));
              }
            } catch { /* client went away; nothing to clean up */ }
            try { controller.close(); } catch {}
          },
        });
        return new Response(stream, {
          // x-cyc-stream: the tunnel flushes this body as each read lands instead
          // of holding sub-CHUNK bytes until the stream closes, so the reply plays
          // as it is generated rather than only when finalize closes the stream
          // (tunnel-glue.ts reply(), tunnel.ts StreamEncoder.flush). Stripped
          // there, so a direct/localhost fetch is the only place it is visible.
          headers: { "content-type": "audio/mpeg", "cache-control": "no-store",
            "x-cyc-stream": "live" },
        });
      }
      const bytes = new Uint8Array(await f.arrayBuffer());
      const total = bytes.byteLength;
      const growHeaders: Record<string, string> = {
        "content-type": "audio/mpeg",
        "cache-control": "no-store",
        "accept-ranges": "bytes",
      };
      const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] !== "" || m[2] !== "")) {
        let start = m[1] === "" ? 0 : Number(m[1]);
        let end = m[2] === "" ? total - 1 : Number(m[2]);
        if (m[1] === "" && m[2] !== "") { start = Math.max(0, total - Number(m[2])); end = total - 1; }
        if (!Number.isFinite(start) || start >= total || start < 0) {
          return new Response("range not satisfiable", {
            status: 416, headers: { "content-range": `bytes */${total}`, ...growHeaders },
          });
        }
        end = Math.min(end, total - 1);
        const slice = bytes.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: { ...growHeaders,
            "content-range": `bytes ${start}-${end}/${total}`,
            "content-length": String(slice.byteLength) },
        });
      }
      return new Response(bytes, {
        headers: { ...growHeaders, "content-length": String(total) },
      });
    }
    const entry = audio.get(clip[1]) ?? await audioFromDisk(clip[1]);
    if (!entry) return new Response("not found", { status: 404 });
    return new Response(entry.bytes, {
      headers: {
        // user clips are webm/ogg from MediaRecorder; the .mp3 suffix is
        // cosmetic, the content-type is what the <audio> element decodes by
        "content-type": entry.mime,
        "content-length": String(entry.bytes.byteLength),
        "cache-control": "public, max-age=3600",
      },
    });
  }


  /* THE PICTURE FOR ONE SESSION (task 331): the bytes in, the bytes out.
   *
   * IN: POST /session/<paneId>/photo with the image as the WHOLE BODY, the same
   * raw-bytes shape POST /upload uses, because a photo off a camera roll is one
   * file and multipart would be a parser for a thing with one part.
   *
   * AN EMPTY BODY CLEARS IT, which is the contract /session/<id>/voice already
   * has ("empty clears it"), and it keeps the surface to GET and POST -- the
   * same reason removing a schedule is POST .../remove. (The engine grants no
   * CORS at all now, so no browser method reaches here cross-origin anyway.)
   *
   * EVERY REFUSAL IS A STATUS AND A SENTENCE, and nothing is half-applied. The
   * app draws the new face only when the sessions broadcast brings it back, so
   * a refusal here leaves every device showing exactly what it showed before.
   */
  if (req.method === "POST" && path.startsWith("/session/") && path.endsWith("/photo")) {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const id = decodeURIComponent(path.slice("/session/".length, -"/photo".length));
    if (!sessions.has(id)) return json({ ok: false, error: "no such session" }, 404);
    const prev = photoRecOf(id);
    const got = await readBodyCapped(req, PHOTO_MAX);
    if (!got.ok) return got.response;
    const bytes = got.value;

    /* Clearing. The map entry goes first and the file after it: the map is what
     * the wire is built from, so a file that will not unlink leaves a stray
     * ~2MB in .run/photos and nothing else -- whereas the other order would
     * leave a session pointing at a file that is gone. */
    if (bytes.byteLength === 0) {
      setPhotoRec(id, null);
      broadcastSessions();
      if (prev) {
        await unlink(join(photoDirFor(id), prev.file)).catch((e: unknown) =>
          console.error(`[photos] could not remove ${prev.file}:`, e));
      }
      console.log(`[photos] cleared ${id}`);
      return json({ ok: true, photo: null });
    }

    const mime = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const ext = PHOTO_TYPES[mime];
    if (!ext) {
      return json({ ok: false, error:
        `this engine stores photos as ${Object.keys(PHOTO_TYPES).join(", ")}, and ` +
        `the body was sent as ${mime || "no content-type at all"}. Nothing was ` +
        "stored, so this session keeps the picture it had." }, 415);
    }
    if (bytes.byteLength > PHOTO_MAX) {
      return json({ ok: false, error:
        `the picture is ${Math.round(bytes.byteLength / 1024)}KB and the cap is ` +
        `${PHOTO_MAX / 1024 / 1024}MB. NOTHING WAS STORED: this is a refusal, not a ` +
        "resize, so this session keeps the picture it had." }, 413);
    }

    /* Written under a NEW name every time, never over the old one. The old file
     * may be on its way to a device right now (the app fetches it as an <img>),
     * and overwriting it in place would hand that request half a picture. The
     * previous file is removed only after the map has moved on. */
    const file = `${crypto.randomUUID()}.${ext}`;
    try {
      await mkdirPrivate(photoDirFor(id));
      await writePrivate(join(photoDirFor(id), file), bytes);
    } catch (e) {
      console.error(`[photos] could not store for ${id}:`, e);
      return json({ ok: false, error:
        "the picture could not be written to disk, so nothing changed and this " +
        "session keeps the one it had." }, 500);
    }
    const rec: PhotoRec = { file, mime, ts: Date.now() };
    setPhotoRec(id, rec);
    broadcastSessions();
    if (prev) {
      await unlink(join(photoDirFor(id), prev.file)).catch((e: unknown) =>
        console.error(`[photos] could not remove ${prev.file}:`, e));
    }
    console.log(`[photos] set ${id}: ${file}, ${bytes.byteLength} bytes, ${mime}`);
    return json({ ok: true, photo: photoOf(id) });
  }


  /* OUT. Its own prefix rather than /session/<id>/photo, because this is the
   * one route a browser puts in an <img src> and those are cached, ranged and
   * retried by the platform; keeping it off the /session/ family means no
   * method or shape it grows later can reach it.
   *
   * The `?v=` the app carries is not read here. It exists so that a REPLACED
   * photo is a different URL to the browser and to the sessions dedupe; the
   * file this answers with is always the current one. */
  const photoReq = path.match(/^\/session-photo\/(.+)$/);
  if (photoReq && req.method === "GET") {
    /* GATED now (sealed-transport enforcement). This was the last deliberately
     * ungated content surface: the iOS push icon, which the OS fetched itself.
     * Pushes stopped referencing engine photo URLs (notify carries no icon; the
     * worker keeps the app logo), so nothing legitimate dials this from outside
     * any more. The in-app face fetch rides the tunnel (engineObjectUrl blob). */
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const photoSid = decodeURIComponent(photoReq[1]);
    const rec = photoRecOf(photoSid);
    if (!rec) return new Response("not found", { status: 404 });
    const f = Bun.file(join(photoDirFor(photoSid), rec.file));
    if (!(await f.exists())) {
      /* The map says there is a photo and the disk says there is not. Say 404
       * and leave the record alone: the app draws its robot letter for a
       * picture that will not load, and a directory that has been moved or is
       * not mounted yet must not be turned into a deletion. */
      console.error(`[photos] ${rec.file} is in the map and not on disk`);
      return new Response("not found", { status: 404 });
    }
    /* ?w= asks for a display-sized copy. The originals are the multi-megabyte
     * images he generates; a 54px list circle was downloading all of it. Two
     * fixed rungs rather than a free number, so the thumb store holds at most
     * two files per photo and the query can't be used to grind ffmpeg. The
     * thumb is derived once, named after the source file so a replaced photo
     * (a fresh uuid) can never collide with a stale thumb, and any failure
     * falls back to the original: slower is better than a broken face. */
    const wRaw = url.searchParams.get("w");
    const w = wRaw === "128" ? 128 : wRaw === "640" ? 640 : null;
    if (w) {
      const thumbPath = join(thumbDirFor(photoSid), `${rec.file}-w${w}.jpg`);
      if (!(await Bun.file(thumbPath).exists())) {
        try {
          mkdirPrivateSync(thumbDirFor(photoSid));
          const proc = Bun.spawn([
            "ffmpeg", "-y", "-i", join(photoDirFor(photoSid), rec.file),
            "-vf", `scale=${w}:-2`, "-q:v", "4", thumbPath,
          ], { stdout: "ignore", stderr: "ignore" });
          await proc.exited;
          await chmod(thumbPath, FILE_MODE).catch(() => {});
        } catch { /* fall through to the original below */ }
      }
      /* a FRESH BunFile: the pre-generation handle caches its stat, so asking
       * it again after ffmpeg wrote the file still said "absent" and the first
       * request for every photo shipped the original */
      const t = Bun.file(thumbPath);
      if (await t.exists()) {
        return new Response(t, {
          headers: {
            "content-type": "image/jpeg",
            "cache-control": "public, max-age=86400",
          },
        });
      }
    }
    return new Response(f, {
      headers: {
        "content-type": rec.mime,
        // immutable in practice: a new picture is a new ?v=, and the file it
        // names is a fresh uuid either way
        "cache-control": "public, max-age=86400",
      },
    });
  }


  const docRaw = path.match(/^\/doc\/([0-9a-f-]+)\/raw$/);
  if (docRaw) {
    // Shown-document bytes: the tunnel and the host only.
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const rawDirs = docDirsOf(docRaw[1]);
    if (!rawDirs) return new Response("not found", { status: 404 });
    const meta = Bun.file(`${rawDirs.docDir}${docRaw[1]}.json`);
    const bin = Bun.file(`${rawDirs.docDir}${docRaw[1]}.bin`);
    if (!(await bin.exists())) return new Response("not found", { status: 404 });
    const j = await meta.json().catch(() => ({} as any));
    const headers: Record<string, string> = {
      "content-type": j?.mime || "application/octet-stream",
      "cache-control": "public, max-age=86400",
    };
    /* A binary (task 524) is a DOWNLOAD, never rendered: tell the browser to save
     * it under its real name rather than open it inline as whatever the type
     * suggests. The name is quoted and stripped of the two characters that could
     * break out of the header (a quote and a newline); the app also passes the
     * name to its own save, so this header is the belt to that suspenders. */
    if (j?.fileKind === "binary" && typeof j?.name === "string") {
      const safe = j.name.replace(/["\r\n]/g, "_");
      headers["content-disposition"] = `attachment; filename="${safe}"`;
    }
    return new Response(bin, { headers });
  }


  const docState = path.match(/^\/doc\/([0-9a-f-]+)\/state$/);
  if (docState && req.method === "GET") {
    // Saved document state: the tunnel and the host only.
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const dirs = docDirsOf(docState[1]);
    if (!dirs) return json({ ok: false, error: "no such document on this engine", status: 404 }, 404);
    const r = await readState(dirs.docDir, dirs.stateDir, docState[1],
      (p) => Bun.file(p).exists(),
      (p) => Bun.file(p).json().catch(() => null));
    return json(r, r.ok ? 200 : r.status);
  }
  if (docState && req.method === "POST") {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const dirs = docDirsOf(docState[1]);
    if (!dirs) return json({ ok: false, error: "no such document on this engine", status: 404 }, 404);
    const got = await readTextCapped(req, STATE_BODY_MAX_BYTES);
    if (!got.ok) return got.response;
    await mkdirPrivate(dirs.stateDir);
    const r = await writeState(dirs.docDir, dirs.stateDir, docState[1], got.value,
      (p) => Bun.file(p).exists(),
      async (p, text) => { await writePrivate(p, text); });
    if (!r.ok) console.log(`[docstate] ${docState[1]} refused: ${r.error.split("\n")[0]}`);
    return json(r, r.ok ? 200 : r.status);
  }


  const doc = path.match(/^\/doc\/([0-9a-f-]+)$/);
  if (doc) {
    // Shown-document metadata: the tunnel and the host only.
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const dirs = docDirsOf(doc[1]);
    if (!dirs) return new Response("not found", { status: 404 });
    const f = Bun.file(`${dirs.docDir}${doc[1]}.json`);
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    return new Response(f, {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" },
    });
  }

  return null;
}
