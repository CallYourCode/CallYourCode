/* ONE ID, FROM THE CLIP UPLOAD TO THE CHAT LOG, ON DISK.
 *
 * WHY THIS FILE EXISTS
 *
 * "I recorded a message, it seemed to send, and then it was not there." Two long
 * clips uploaded successfully and then never appeared, and nobody could say
 * where they were lost. The reason nobody could say is that no identifier
 * survived a hop: the browser knew a capture number that restarts at 1 on every
 * page load, the engine knew a msgId it minted itself, and the two stories had
 * nothing in common to join on.
 *
 * So the bar is not "logging exists". It is: ONE GREP ON A CAPTURE'S ID SHOWS
 * ITS WHOLE LIFE. These tests take an id the browser would have minted, push it
 * through the engine's hops, and read the FILE afterwards -- not a spy, not a
 * mock, not "the log function was called". If the id fails to travel, or the
 * file is not written, they fail.
 *
 * WHERE THE FILE COMES FROM WITHOUT AN ENGINE PROCESS. logbook.ts is the
 * engine's one writer: `openLog(service).line(event, fields)` formats
 * `<iso> <service> <event> k=v ...` and batches it to disk. server.ts hands that
 * same `line` to every route and every module as `ctx.log`, which is what the
 * records below are. So the media route here writes THROUGH the real logbook as
 * it runs, and the delivery records the wiring collected are then written
 * through the same book in the order they were made. What is being asserted is
 * what an operator actually does: grep one id over the file on disk and read the
 * story out.
 *
 * The browser end of the same claim is in the app repo:
 * e2e/cyc/cyc-trace.spec.ts records a real note and follows the id from the mic
 * to the app server's copy of this directory.
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { join } from "node:path";

import { openLog, type Logbook } from "../../../shared/logbook.ts";
import { onUtterance } from "./deliver.ts";
import { mediaRoutes } from "../routes/media.ts";
import { sessionByHandle } from "../sessions/session-state.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";
import { wireCore, type FakeClient, type WireCore, wireId } from "../test-utils/wire-core.ts";

let core: WireCore;
let http: ServedRoutes;
let client: FakeClient;
let book: Logbook;
/** how many of the wiring's records have already been handed to the book */
let mirrored = 0;
/** how many lines have been written at all, so a read can wait for the writer */
let written = 0;

beforeAll(async () => {
  const dir = await tmpDir("cyc-trace-");
  /* The real writer, pointed at this test's own directory through its own
   * injectable options (the seam logbook.ts grew precisely so a test never has
   * to set CYC_LOG_DIR on the process). One service name, one file. */
  book = openLog("trace-probe", { dir, flushMs: 1 });

  core = await wireCore({ with: ["delivery"] });
  await until(() => core.sessions.size === 1, { what: "the pane to reconcile" });
  /* The upload hop writes through the book as it happens, exactly as server.ts
   * wires it: ctx.log IS LOG.line. */
  http = serveRoutes({
    groups: [mediaRoutes],
    ctx: { uploads: core.uploads!, log: (event, fields) => { book.line(event, fields); written++; } },
  });
  client = core.client({ attach: PANE });
});

afterAll(async () => {
  http?.stop();
  await core?.stop();
});

afterEach(() => {
  client.clear();
});

/** Write everything the wiring has recorded since the last call, in order, and
 *  hand back the whole file ON DISK.
 *
 *  The wait is the logbook's own promise, not a fudge: nothing in it awaits or
 *  blocks a caller (a logger that can fail a voice note is worse than no
 *  logger), so a line is queued and batched, and "it is on disk" is a claim
 *  about a moment shortly afterwards. Reading in the same breath as the request
 *  would fail as "the engine logged nothing", which is the exact conclusion this
 *  file has to be able to draw honestly. */
async function trail(): Promise<string[]> {
  for (const l of core.logs.slice(mirrored)) { book.line(l.event, l.fields); written++; }
  mirrored = core.logs.length;
  await book.flush();
  let lines: string[] = [];
  await until(async () => {
    lines = (await Bun.file(book.path).text().catch(() => "")).split("\n").filter(Boolean);
    return lines.length >= written;
  }, { what: `all ${written} written lines to reach ${book.path}` });
  return lines;
}

const post = (bytes: Uint8Array, cid: string) =>
  http.fetch(`/user-audio?cid=${encodeURIComponent(cid)}`, {
    method: "POST", headers: { "content-type": "audio/webm" },
    body: bytes as unknown as BodyInit,
  });

function clipBytes(n = 4096): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 29 + 7) & 0xff;
  return b;
}

test("a capture's id joins the upload, the delivery and the chat log", async () => {
  /* The id the BROWSER would have minted when the microphone opened. It is not
   * generated by the engine anywhere in this test: the whole question is
   * whether an id from outside survives the trip. */
  const cid = "c-trace-" + Math.random().toString(36).slice(2, 7);

  // hop 1: the clip is parked, and the engine's own msgId is minted here
  const up = await post(clipBytes(), cid);
  const { msgId } = (await up.json()) as { msgId: string };
  expect(msgId, "the engine did not store the clip, so there is no trip to follow").toBeTruthy();

  const afterUpload = (await trail()).filter((l) => l.includes(`cid=${cid}`));
  expect(afterUpload.length,
    `the upload of ${cid} left no line naming it. The browser's id stops at the engine's ` +
    "door, so a note that vanishes after this point can only be followed by guessing.")
    .toBeGreaterThan(0);
  expect(afterUpload.join("\n"),
    "the upload line does not carry the engine's own msgId beside the browser's cid. That one " +
    "line is the ONLY join between the two id spaces: without it, following a recording means " +
    "grepping for one id, reading a uuid out by eye, and grepping again.")
    .toContain(`msgId=${msgId}`);

  // hop 2: the message itself, carrying the same id and the msgId from hop 1
  await onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), text: "trace probe", kind: "voice", msgId, durationS: 3, cid,
  });
  await until(() => core.submitted.length > 0, { what: "the note to reach the pane" });

  /* ONE GREP, ONE STORY. This is the actual claim of the whole change, so it is
   * asserted as one: every hop, matched by the single id. */
  const mine = (await trail()).filter((l) => l.includes(`cid=${cid}`));
  const hops = ["user-audio.stored", "utterance.in", "utterance.accepted", "utterance.delivered"];
  const missing = hops.filter((h) => !mine.some((l) => l.includes(` ${h} `)));
  expect(missing,
    `grepping the log for ${cid} shows ${mine.length} line(s) and misses ${missing.join(", ")}. ` +
    "The point of the id is that ONE grep shows the whole life of one recording; a gap in the " +
    `middle is where a lost clip hides.\n${mine.join("\n")}`).toEqual([]);

  /* And the same id is on the PERSISTED message, which is the thing that is
   * still there tomorrow. Given a note that looks wrong in the chat log, this is
   * what makes it possible to go back and read how it got there. */
  const note = sessionByHandle(PANE)!.chat.find((m) => m.text === "trace probe");
  expect(note, "the engine never persisted the probe message").toBeTruthy();
  expect(note!.cid,
    "the persisted message does not carry the capture's id. The chat log is the record that " +
    "survives a restart, and a message in it with no id cannot be traced back to the " +
    "recording it came from.").toBe(cid);
  // ...and the msgId joins the two directions: a grep on it crosses back
  expect(mine.some((l) => l.includes(`msgId=${msgId}`)),
    "no line ties the delivered message to the clip it was made from").toBe(true);
});

test("a wordless note whose clip the engine has forgotten says so instead of vanishing", async () => {
  /* THE SILENT DROP, as a test.
   *
   * A voice note with no transcript is delivered with EMPTY text on purpose: the
   * engine is meant to read its own copy of the clip. If it does not have that
   * copy, the message hit one early return shared with "unknown session" and
   * disappeared without a single line anywhere. The clip upload had already
   * succeeded, so the app had drawn its tick.
   *
   * This does not test that the drop is right or wrong -- rescue.test.ts owns
   * that -- only that it is no longer SILENT, which is what makes it findable at
   * all. */
  const cid = "c-lost-" + Math.random().toString(36).slice(2, 7);
  await onUtterance(client.sock, {
    t: "utterance", id: wireId(PANE), text: "", kind: "voice",
    msgId: crypto.randomUUID(), durationS: 12, cid,
  });

  const mine = (await trail()).filter((l) => l.includes(`cid=${cid}`));
  const dropped = mine.find((l) => l.includes(" utterance.dropped "));
  expect(dropped,
    "a voice note was thrown away and the engine said nothing at all. This is the exact shape " +
    "of the failure that could not be diagnosed: the clip uploaded, the app drew a tick, and " +
    `the message never arrived, with no line anywhere saying why.\n${mine.join("\n")}`)
    .toBeTruthy();
  expect(dropped,
    "the drop was logged without a reason, so the log says a message was lost and not why. A " +
    "reason is what makes the difference between 'the session is gone' and 'the clip fell out " +
    "of the cache', which are different bugs with different fixes.").toContain("why=");
  expect(dropped, "the drop does not say whether the recording is on disk, which is what turns " +
    "'a message vanished' into 'the message is recoverable and here is the file'")
    .toContain("onDisk=false");

  /* AND THE ARRIVAL WAS LOGGED TOO, which is the half that makes the drop
   * findable: a grep that finds only a drop cannot say whether the engine ever
   * had the message at all. */
  expect(mine.some((l) => l.includes(" utterance.in ")),
    "nothing recorded that the message arrived, so the drop has no before").toBe(true);
});

test("a hostile cid cannot break the line it is written on", async () => {
  /* The cid is attacker-controlled text on its way into a file the operator
   * reads and greps. A newline in it would end the line early and write the rest
   * as a second, forged record; a space would break the k=v shape. safeCid is
   * the filter, applied at every entry point, and the fallback is an id the
   * engine mints for itself -- so a hostile cid costs the trail its join and
   * costs the file nothing. */
  const forged = "c-evil\n2026-01-01T00:00:00.000Z engine utterance.delivered cid=c-forged";
  const before = (await trail()).length;
  await onUtterance(client.sock, { t: "utterance", id: wireId(PANE), text: "hostile id", cid: forged });
  await until(() => core.submitted.some((s) => s.text.includes("hostile id")),
    { what: "the message to reach the pane" });

  const lines = await trail();
  expect(lines.some((l) => l.includes("cid=c-forged")),
    "a cid carrying a newline wrote a second, forged line into the log").toBe(false);
  expect(lines.some((l) => l.includes("c-evil")),
    "the hostile cid was written into the log unfiltered").toBe(false);
  /* The message still went, and it still has an id to grep: a refusal here would
   * cost him the message to punish a field. */
  const delivered = lines.slice(before).filter((l) => l.includes(" utterance.delivered "));
  expect(delivered.length, "the message with the hostile id was never delivered").toBe(1);
  expect(delivered[0], "the delivery was written with no correlation id at all").toMatch(/ cid=\S/);
});
