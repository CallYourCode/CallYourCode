/* A BINARY THAT WAS SHOWN DOWNLOADS, IT DOES NOT OPEN AS TEXT (task 524).
 *
 * He passed an .mp3 to `show`. The old pipeline read every non-image file as
 * text, so the mp3 became a "text card": opening it rendered mojibake, and
 * saving from that card wrote the corrupted decode back rather than the file.
 * The source on disk was fine; the download was not.
 *
 * show.test.ts proves the classifier catches a binary. This proves the whole
 * `show` path does the right thing with one, end to end but with no engine:
 * the real show-handler wired over fakes, and the real media routes served by
 * serveRoutes on port 0.
 *
 *   1. the shown mp3 arrives as kind `binary`, with no `content` and no
 *      `inline` -- nothing that would make the app render its bytes as text;
 *   2. /doc/<id>/raw hands back the EXACT bytes that were shown, with the real
 *      audio type and an `attachment` disposition so the browser saves it;
 *   3. a genuine UTF-8 markdown file shown the same way still arrives markdown,
 *      because the fix must not reclassify what the app really renders.
 *
 *   bun test agent-engine/src/chat/showbinary.test.ts
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initShowHandler, onShow, type ShowSession } from "./show-handler.ts";
import { initChatlog } from "./chatlog.ts";
import { mediaRoutes } from "../routes/media.ts";
import { blobOwner, docDirFor } from "../sessions/session-state.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import type { Sock } from "../transport/sock.ts";

const SID = "w5:p2";
const AGENT_ID = "ag-showbinary";
const OLD_DATA_DIR = process.env.CYC_DATA_DIR;

/* A real-shaped mp3 head: the "ID3" tag, a null-padded size, and an 0xFFFB
 * frame sync. The null bytes are what the sniff keys on, but the whole point is
 * the ROUND TRIP, so these have to be bytes worth comparing rather than zeroes.
 * 0xFF is never valid UTF-8: read as text, this is exactly the corruption the
 * bug produced. */
const MP3 = new Uint8Array([
  0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21, // "ID3" v2.4 header
  0xff, 0xfb, 0x90, 0x64, 0x00, 0x0f, 0xf0, 0x00, 0x00, 0x69, // frame sync + junk
  0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x0d, 0x20, 0x00, 0x00,
]);

/* A PDF's first bytes are "%PDF-1.7" and a newline: PERFECTLY VALID UTF-8 with
 * no null byte in sight. The byte sniff alone says "text" for this, which is
 * why the extension list exists beside it. */
const PDF_HEAD = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n";

let cwd = "";
let srv: ServedRoutes;
const frames: Array<Record<string, any>> = [];
const acks: Array<Record<string, any>> = [];
const ws = { data: { sessionId: SID } } as unknown as Sock;
const session: ShowSession = { id: SID, chat: [], cwd: "" };

beforeAll(async () => {
  const data = await tmpDir("cyc-showbin-data-");
  process.env.CYC_DATA_DIR = data;
  cwd = await tmpDir("cyc-showbin-cwd-");
  session.cwd = cwd;

  initChatlog({
    chatOf: () => session.chat,
    restoredChats: () => new Map(),
    persistPatch: () => {},
    broadcast: () => {},
    chatRefFor: () => ({ aid: AGENT_ID, chatId: "chat-1" }),
    indexMsgBlobs: () => {},
    appendMsg: () => {},
    appendRec: () => {},
  });
  initShowHandler({
    sessionOf: (id) => id === SID ? session : undefined,
    agentIdFor: () => AGENT_ID,
    /* THE INDEX THE RAW ROUTE READS. show-handler claims the docId for the
     * agent BEFORE the bytes land, and docDirsOf resolves every later id-only
     * fetch through it; wiring the real map here is what makes the served route
     * below the real one rather than a re-implementation. */
    claimBlob: (docId, aid) => { blobOwner.set(docId, aid); },
    docDirFor,
    send: (_ws, msg) => { acks.push(msg as Record<string, any>); },
    broadcast: (msg) => { frames.push(msg as Record<string, any>); },
    notifyUnlessWatched: () => {},
    sessionPushTitle: () => "showbinary",
    noteReply: () => {},
  });
  srv = serveRoutes({ groups: [mediaRoutes] });
});

afterAll(() => {
  srv?.stop();
  blobOwner.clear();
  if (OLD_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = OLD_DATA_DIR;
});

/** Write a fixture in the session's cwd and `show` it; hand back the `file`
 *  block of the chat frame the engine broadcast for it. */
async function show(name: string, data: Uint8Array | string): Promise<Record<string, any>> {
  const path = join(cwd, name);
  await writeFile(path, data as never);
  const before = frames.length;
  await onShow(ws, { t: "show", path });
  const chat = frames.slice(before).find((f) => f.t === "chat" && f.file);
  if (!chat) {
    const ack = acks.at(-1);
    throw new Error(`no chat frame for ${name}: ${JSON.stringify(ack)}`);
  }
  return chat.file as Record<string, any>;
}

const raw = (docId: string) => srv.get(`/doc/${docId}/raw`);

test("a shown mp3 is a binary download card, and the endpoint serves its exact bytes", async () => {
  const f = await show("clip.mp3", MP3);
  expect(f.fileKind, `shown as ${f.fileKind}, not binary: ${JSON.stringify(f)}`).toBe("binary");
  // nothing that would make the app render the bytes as text
  expect(f.content).toBeUndefined();
  expect(f.inline).toBeFalsy();
  expect(f.size).toBe(MP3.length);
  expect(f.name).toBe("clip.mp3");

  const res = await raw(f.docId);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("audio/mpeg");
  expect(res.headers.get("content-disposition")).toBe('attachment; filename="clip.mp3"');
  const back = new Uint8Array(await res.arrayBuffer());
  expect(back.length).toBe(MP3.length);
  expect([...back], "the bytes changed on the way through").toEqual([...MP3]); // the acceptance bar
});

test("the ack tells the agent it was a download card, not a document", async () => {
  /* The agent decides what to say next from this sentence. "shown as text card"
   * for an mp3 is how the original bug stayed invisible on the engine side. */
  const before = acks.length;
  await show("ack.mp3", MP3);
  const ack = acks.slice(before).find((m) => m.t === "shown")!;
  expect(ack.ok).toBe(true);
  expect(ack.message).toBe("shown as download card");
});

test("a file with no extension but binary bytes is still a download", async () => {
  // the sniff alone caught it: nothing about the name says binary
  const f = await show("noext-fixture", MP3);
  expect(f.fileKind).toBe("binary");
  const back = new Uint8Array(await (await raw(f.docId)).arrayBuffer());
  expect([...back]).toEqual([...MP3]);
  /* An unknown binary is served as octet-stream, which downloads rather than
   * opens -- exactly right for a type the app has no renderer for. */
  expect((await raw(f.docId)).headers.get("content-type")).toBe("application/octet-stream");
});

test("a PDF is caught by its EXTENSION, because its first bytes read as text", async () => {
  /* The two signals, and why neither alone is enough. "%PDF-1.7\n..." is valid
   * UTF-8 with no null byte, so the sniff says text; the extension list is what
   * stops a PDF becoming a mojibake card. */
  const f = await show("paper.pdf", PDF_HEAD);
  expect(f.fileKind, "a PDF whose head is valid UTF-8 slipped through as text").toBe("binary");
  expect(f.content).toBeUndefined();
  expect((await raw(f.docId)).headers.get("content-type")).toBe("application/pdf");
  expect(await (await raw(f.docId)).text()).toBe(PDF_HEAD);
});

test("a .txt with a null byte is caught by the SNIFF, because its name says text", async () => {
  // the other direction: an ordinary text extension over bytes that are not
  const bytes = new Uint8Array([0x68, 0x69, 0x00, 0x74, 0x68, 0x65, 0x72, 0x65]);
  const f = await show("looks-textual.txt", bytes);
  expect(f.fileKind).toBe("binary");
  expect([...new Uint8Array(await (await raw(f.docId)).arrayBuffer())]).toEqual([...bytes]);
});

test("the served type follows the extension, per binary family", async () => {
  for (const [name, mime] of [["a.zip", "application/zip"], ["a.wasm", "application/wasm"],
                              ["a.mp4", "video/mp4"], ["a.woff2", "font/woff2"]] as const) {
    const f = await show(name, MP3);
    expect(f.fileKind, `${name} was not classified binary`).toBe("binary");
    expect((await raw(f.docId)).headers.get("content-type"), `${name} served wrong`).toBe(mime);
  }
});

test("a UTF-8 markdown file shown the same way still classifies markdown", async () => {
  /* Two-, three- and four-byte UTF-8 in one line. Every one of these is
   * multi-byte and none of them is a decode error, so the sniff must leave
   * them alone: flagging accents, CJK or emoji as binary would turn half his
   * notes into downloads. */
  const md = "# Notes\n\nA quote with unusual characters: café … 你好 🚀\n";
  const f = await show("notes.md", md);
  expect(f.fileKind, `markdown must not be reclassified: ${JSON.stringify(f)}`).toBe("markdown");
  /* Small enough to ride in the bubble, so the content travels with the frame
   * and no download card is drawn. This is the field the mp3 must never have. */
  expect(f.inline).toBe(true);
  expect(f.content).toBe(md);
});

test("a .md is never sent to the sniff, so a null byte inside one stays markdown", async () => {
  /* Only files the EXTENSION already left as `text` reach the byte sniff. A
   * markdown note that quotes a null byte in a fenced block keeps its renderer;
   * reclassifying it would turn a document into an unopenable download. */
  const bytes = new TextEncoder().encode("# doc\n\n```\n\u0000\n```\n");
  expect(bytes.includes(0), "the fixture has no null byte, so it proves nothing").toBe(true);
  const f = await show("has-nul.md", bytes);
  expect(f.fileKind, "a markdown note quoting a null byte became an unopenable download").toBe("markdown");
});

test("a binary card carries no bytes on the wire, however small the file is", async () => {
  /* Size is not what decides. A four-byte binary is still a card: the inline
   * path is where `content` is set, and a binary must never take it, or the app
   * renders its bytes as a text snippet in the conversation. */
  const tiny = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
  const f = await show("tiny.bin", tiny);
  expect(f.fileKind).toBe("binary");
  expect(f.inline).toBeFalsy();
  expect(f.content).toBeUndefined();
  expect(f.size).toBe(4);
});

test("the download filename cannot break out of the header", async () => {
  /* content-disposition is a header, and the name in it comes from the
   * FILESYSTEM, which an agent controls. A quote would end the filename token
   * and a CR/LF would start a new header; both are replaced rather than
   * escaped. The app also passes the name to its own save, so this header is
   * the belt to that suspenders. */
  const nasty = 'evil".mp3';
  const f = await show(nasty, MP3);
  const cd = (await raw(f.docId)).headers.get("content-disposition")!;
  expect(cd).toBe('attachment; filename="evil_.mp3"');
  expect(cd).not.toContain('"evil"');
});

test("a document is NOT served as an attachment", async () => {
  /* The disposition is set only for `fileKind: "binary"`. A markdown or html
   * doc is fetched and rendered by the app; telling the browser to save it
   * would turn every opened card into a download. */
  // over SNIPPET_MAX_CHARS, so it is a card rather than an inline bubble: the
  // shape a document and a binary actually share, minus the disposition
  const f = await show("doc-not-attachment.md", "# heading\n\n" + "x".repeat(5000));
  expect(f.fileKind).toBe("markdown");
  const meta = await srv.get(`/doc/${f.docId}`);
  expect(meta.status).toBe(200);
  expect(meta.headers.get("content-disposition")).toBeNull();
  const j = await meta.json();
  expect(j.fileKind).toBe("markdown");
  expect(typeof j.content).toBe("string");   // a doc keeps its text in the meta
});

test("the meta beside a binary holds no decoded text at all", async () => {
  /* THE ORIGINAL BUG, at its source. The old path read the file as text and
   * stored that string; saving from the card wrote the corrupted decode back.
   * The binary meta carries a name, a kind and a mime, and nothing else. */
  const f = await show("meta.mp3", MP3);
  const j = await (await srv.get(`/doc/${f.docId}`)).json();
  expect(j).toEqual({ name: "meta.mp3", fileKind: "binary", mime: "audio/mpeg" });
  expect("content" in j, "the decoded bytes were stored beside the binary").toBe(false);
});

test("a docId nobody ever shipped is a 404, not somebody else's file", async () => {
  /* The id-only routes resolve through the blob index, so an id that no chat
   * message ever carried has no directory to read from. A guess must not become
   * a read of another agent's documents. */
  expect((await raw(crypto.randomUUID())).status).toBe(404);
  expect((await srv.get(`/doc/${crypto.randomUUID()}`)).status).toBe(404);
});

test("two shows of the same file get their own docIds and both still serve", async () => {
  // the bytes are immutable per docId: showing again mints a new document
  // rather than mutating one a device may be fetching right now
  const a = await show("twice.mp3", MP3);
  const b = await show("twice.mp3", MP3);
  expect(a.docId).not.toBe(b.docId);
  for (const f of [a, b]) {
    expect([...new Uint8Array(await (await raw(f.docId)).arrayBuffer())]).toEqual([...MP3]);
  }
});
