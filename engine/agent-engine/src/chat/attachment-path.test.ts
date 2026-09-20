/* AN ATTACHMENT PATH COMES FROM THIS ENGINE'S UPLOAD RECORD, NEVER THE CLIENT.
 *
 * SECURITY-REVIEW #7: a forged utterance can name any readable host file as
 * `path` (`/etc/passwd`, `~/.ssh/id_rsa`). The old check only asked whether that
 * path exists, then typed it into a pane running
 * `--dangerously-skip-permissions` -- so the answer came back in the agent's own
 * transcript, and from there onto his phone.
 *
 * THE ID MINTED AT POST /upload IS THE ONLY KEY. bindOwnedUploads throws the
 * client's `path` away and puts back the file this engine wrote for that
 * uploadId; a record for an id this engine never minted is DROPPED, and an id it
 * did mint whose file is gone fails the whole message (multipart.test.ts).
 *
 * Three shapes, and the third is the one a narrow fix misses: a message whose
 * ONLY content was the forgery has nothing left in it, so it must be dropped
 * whole rather than delivered as an empty line.
 *
 * POST /upload here is the real media route on a port-0 Bun.serve over this
 * wiring's own store, so the legitimate half arrives the way a real one does.
 *
 *   bun test agent-engine/src/chat/attachment-path.test.ts
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";

import { onUtterance } from "./deliver.ts";
import { mediaRoutes } from "../routes/media.ts";
import type { UploadRec } from "./chatmsg.ts";
import { wireCore, type WireCore, wireId } from "../test-utils/wire-core.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";

/* The settle between a delivery's text and its enter, shortened at file scope
 * (adapters/mux-adapter.ts reads it on every use). */
const priorSettle = process.env.DELIVER_SETTLE_MS;
beforeAll(() => { process.env.DELIVER_SETTLE_MS = "5"; });
afterAll(() => {
  if (priorSettle === undefined) delete process.env.DELIVER_SETTLE_MS;
  else process.env.DELIVER_SETTLE_MS = priorSettle;
});

let core: WireCore | null = null;
let http: ServedRoutes | null = null;
afterEach(async () => {
  http?.stop();
  http = null;
  await core?.stop();
  core = null;
});

async function rig(): Promise<WireCore> {
  core = await wireCore({ with: ["delivery"] });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  http = serveRoutes({ groups: [mediaRoutes], ctx: { uploads: core.uploads! } });
  return core;
}

/** POST /upload, the way the composer stages a file. */
async function stage(name: string, body: string): Promise<UploadRec> {
  const res = await http!.fetch("/upload", {
    method: "POST",
    headers: { "content-type": "text/plain", "x-filename": name },
    body,
  });
  if (!res.ok) throw new Error(`POST /upload ${name}: HTTP ${res.status}`);
  return (await res.json()) as UploadRec;
}

/** A record this engine never minted, naming a host file the client wants read. */
const forged = (path: string, uploadId = "00000000-0000-4000-8000-000000000000"): UploadRec => ({
  uploadId, name: "secret.txt", mime: "text/plain", size: 20, path, image: false,
});

const bubbleFor = (cl: { of(t: string): Record<string, any>[] }, text: string) =>
  cl.of("chat").find((f) => f.role === "user" && f.text === text);

test("a forged attachment path is not typed into the pane", async () => {
  const c = await rig();
  const cl = c.client();

  await onUtterance(cl.sock, {
    id: wireId(PANE), text: "read this for me", upload: forged("/etc/passwd"),
  });

  const bubble = bubbleFor(cl, "read this for me");
  expect(bubble, "the caption never reached the chat").toBeDefined();
  expect(bubble!.upload, "the forged record was kept on the bubble").toBeUndefined();
  expect(bubble!.uploads, "the forged record was kept as uploads").toBeUndefined();

  expect(c.submitted.length, "the caption was not delivered to the agent").toBe(1);
  const delivered = c.submitted[0].text;
  expect(delivered, `the agent was handed /etc/passwd: ${delivered}`).not.toContain("/etc/passwd");
  expect(delivered, "the words he actually typed were lost with the forgery").toContain(
    "read this for me");
  expect(
    c.logs.some((l) => l.event === "utterance.attach-dropped"),
    "the engine never logged that it dropped the forged attachment",
  ).toBe(true);
});

test("a real uploadId still reaches the agent even if the client lies about path", async () => {
  const c = await rig();
  const cl = c.client();

  const kept = await stage("notes.txt", "the real file");
  await onUtterance(cl.sock, {
    id: wireId(PANE), text: "have a look",
    uploads: [
      { ...kept, path: "/etc/passwd" },                                   // real id, forged path
      forged("/etc/shadow", "11111111-1111-4111-8111-111111111111"),       // forged outright
    ],
  });

  const bubble = bubbleFor(cl, "have a look");
  expect(bubble, "the message never came back to the page").toBeDefined();
  expect(bubble!.upload?.uploadId, "the real upload did not stay on the message")
    .toBe(kept.uploadId);
  /* The path on the bubble is the ENGINE's, twice over: never the client's
   * forgery, and since the data-model move it is the ADOPTED copy in the agent's
   * own uploads dir (the staged path the /upload response named was the file's
   * waiting room, not its home). */
  const enginePath = String(bubble!.upload?.path ?? "");
  expect(enginePath.includes("/agents/") && enginePath.includes(`/uploads/${kept.uploadId}-`),
    `the bubble's path is not the adopted engine copy: ${enginePath}`).toBe(true);
  expect(await Bun.file(enginePath).exists(), "the adopted path does not exist").toBe(true);
  expect(bubble!.uploads?.length, "the forged record rode along beside the real one").toBe(1);
  expect(bubble!.uploads?.[0]?.uploadId).toBe(kept.uploadId);

  expect(c.submitted.length).toBe(1);
  const delivered = c.submitted[0].text;
  expect(delivered, `the real file never reached the agent: ${delivered}`).toContain(enginePath);
  expect(delivered).toContain("have a look");
  expect(delivered).not.toContain("/etc/passwd");
  expect(delivered).not.toContain("/etc/shadow");
});

test("a wordless utterance whose only attachment is forged is dropped whole", async () => {
  /* NOTHING IS LEFT IN IT. Dropping the forgery and delivering what remains is
   * right for a message that also carried words; here there are none, so a
   * narrow fix delivers an empty line into a pane running with permissions
   * skipped. The whole message goes, and the engine says so. */
  const c = await rig();
  const cl = c.client();

  await onUtterance(cl.sock, { id: wireId(PANE), upload: forged("/etc/passwd") });

  expect(c.herdr.texts, "a forged-only message was still typed into the pane").toEqual([]);
  expect(c.submitted, "a forged-only message reached the agent").toEqual([]);
  expect(cl.of("chat").filter((f) => f.role === "user"),
    "a forged-only message was written into the chat log").toEqual([]);
  expect(
    c.logs.some((l) => l.event === "utterance.dropped" || l.event === "utterance.attach-dropped"),
    "the engine said nothing about refusing the forged-only message",
  ).toBe(true);
});

test("an uploadId shaped like a path escape is dropped before anything looks for it", async () => {
  /* The other half of "the id is the only key": the id itself goes into a glob
   * over the staging dir, so a traversal-shaped one is refused by SHAPE
   * (UPLOAD_ID_RE) rather than by where it happens to resolve. */
  const c = await rig();
  const cl = c.client();

  await onUtterance(cl.sock, {
    id: wireId(PANE), text: "and this one",
    upload: { ...forged("/etc/passwd"), uploadId: "../../../../etc/passwd" },
  });

  const bubble = bubbleFor(cl, "and this one")!;
  expect(bubble.upload, "a traversal-shaped uploadId was kept on the bubble").toBeUndefined();
  expect(c.submitted[0].text).not.toContain("etc/passwd");
  expect(c.logs.some((l) => l.event === "utterance.attach-dropped")).toBe(true);
});
