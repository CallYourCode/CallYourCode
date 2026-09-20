/* MCP `show` (L3 feature): a session pushes a file (by path) for the app to
 * render. Storage per kind, path allow-list, caps, the one success-path
 * reply. Wired at boot (initShowHandler) over the session lookup, the blob
 * index, the notify path and the wire.
 *
 *   bun test agent-engine/src/chat/show.test.ts (the policy half stays show.ts)
 */

import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import { mkdirPrivate, writePrivate } from "../../../shared/runfiles.ts";
import { showFileKind, imageMime, looksBinary, binaryMime, capFor, tooLargeMessage,
  canInline, fitsInline, isEmptyPage, showPathAllowed, type ShowKind } from "./show.ts";
import { stampTs, logChat, clearQueuedByReply, type ChatSession } from "./chatlog.ts";
import type { ChatMsg } from "./chatmsg.ts";
import type { Sock } from "../transport/sock.ts";

export type ShowSession = ChatSession & { cwd: string };

export type ShowDeps = {
  sessionOf(id: string): ShowSession | undefined;
  agentIdFor(sessionId: string): string;
  claimBlob(docId: string, agentId: string): void;
  docDirFor(agentId: string): string;
  send(ws: Sock, msg: unknown): void;
  broadcast(msg: unknown): void;
  notifyUnlessWatched(s: ShowSession, n: { title: string; body: string; msgKey: string; ts: number }): Promise<void> | void;
  sessionPushTitle(s: ShowSession): string;
  noteReply(sessionId: string): void;
};

let deps: ShowDeps | null = null;
export function initShowHandler(d: ShowDeps): void {
  deps = d;
}
const D = (): ShowDeps => {
  if (!deps) throw new Error("show-handler not initialised");
  return deps;
};

/* MCP `show`: a session pushes a file (by path) for the app to render.
 * The engine reads it here and stores the CONTENT in the chat log, so the
 * bubble keeps working after the file changes or the pane dies. Reads are
 * confined to the session's cwd, the OS tmpdir, and the /tmp/claude-*
 * scratchpad tree (show.ts, showPathAllowed); size-capped.
 *
 * An `.html` file is the one kind that RUNS (see agent-engine/src/chat/show.ts for the
 * whitelist and the caps, app/src/features/media/htmlViewer.ts for the sandbox it
 * runs in). Nothing here inspects what is inside it, deliberately: a scanner
 * would refuse honest pages, miss a dozen ways of writing the same thing, and
 * teach whoever reads this that the document has been vetted. It has not been.
 * The containment is the sandbox on the device, which holds for a document
 * nobody read: since 2026-08-03 such a page may load libraries over https and
 * may send what the agent put in it, but it still cannot read the app, its
 * storage or its chats. */
/* The temp roots `show` accepts beside the cwd (show.ts says why), resolved
 * once: they are properties of the host, not of a request. `claudeTmp` is the
 * realpath of /tmp plus "/claude-", the scratchpad tree's prefix -- distinct
 * from the tmpdir root because macOS puts the OS tmpdir under /var/folders
 * while the scratchpad stays under /tmp. */
let showTmpRootsP: Promise<{ tmp: string; claudeTmp: string | null }> | null = null;
function showTmpRoots(): Promise<{ tmp: string; claudeTmp: string | null }> {
  showTmpRootsP ??= (async () => {
    const tmp = await realpath(tmpdir()).catch(() => tmpdir());
    const slashTmp = await realpath("/tmp").catch(() => null);
    return { tmp, claudeTmp: slashTmp ? slashTmp + "/claude-" : null };
  })();
  return showTmpRootsP;
}

/* The `shown` ack fields, decoupled from HOW they reach the caller: the /ws
 * frame (onShow) sends them over the socket; the loopback POST /agent/reply
 * route returns them as the HTTP response. */
export type ShowAck = { ok: boolean; message: string; path: string };

export async function onShow(ws: Sock, m: any) {
  const reqPath = String(m.path ?? "");
  const s = ws.data.sessionId ? D().sessionOf(ws.data.sessionId) : undefined;
  if (!s) return D().send(ws, { t: "shown", ok: false, path: reqPath,
    message: "session not registered with the engine (not a live agent?)" });
  const ack = await deliverShow(s, reqPath);
  D().send(ws, { t: "shown", ...ack });
}

/* THE SHOW DELIVERY CORE (mcp-http): everything from a resolved session to the
 * `shown` ack fields -- the path allow-list, the per-kind cap, the write, the
 * chat-log row, the broadcast and the notification -- with the transport gone.
 * onShow calls this and sends the ack over /ws; the loopback POST route calls it
 * and returns the ack as the HTTP response, so a shown file lands identically
 * whichever door it came in. */
export async function deliverShow(s: ShowSession, reqPath: string): Promise<ShowAck> {
  const reply = (ok: boolean, message: string): ShowAck => ({ ok, message, path: reqPath });
  const d = D();
  if (!reqPath.startsWith("/")) return reply(false, "path must be absolute");
  let real: string;
  try {
    real = await Bun.$`realpath ${reqPath}`.text().then((t) => t.trim());
  } catch {
    return reply(false, "file not found");
  }
  const cwdReal = await Bun.$`realpath ${s.cwd}`.text().then((t) => t.trim()).catch(() => s.cwd);
  if (!showPathAllowed(real, { cwd: cwdReal, ...(await showTmpRoots()) })) {
    return reply(false,
      `path is outside the allowed roots: the session cwd (${s.cwd}), the OS temp dir, and /tmp/claude-*`);
  }
  const f = Bun.file(real);
  if (!(await f.exists())) return reply(false, "file not found");
  const name = real.split("/").pop() ?? real;
  const mime = imageMime(real);
  /* The cap is per KIND, and the kind has to be known before the bytes are
   * read: an interactive page has a smaller one than a document (show.ts says
   * why), and reading 2MB to then refuse it is work nobody asked for. Only the
   * extension is consulted here, which is all `html` ever depends on; the
   * content sniff below can still turn `text` into `diff`, and neither of
   * those changes the cap. */
  const earlyKind: ShowKind = mime ? "image" : showFileKind(real, "");
  if (f.size > capFor(earlyKind)) return reply(false, tooLargeMessage(earlyKind, f.size));
  const docId = crypto.randomUUID();
  /* The document is agent data: claim the docId for this session's agent
   * BEFORE the bytes land, so the write below and every later id-only read
   * resolve to the same agents/<agentId>/docs/. */
  const docAid = d.agentIdFor(s.id);
  d.claimBlob(docId, docAid);
  const DOC_WRITE_DIR = d.docDirFor(docAid);
  await mkdirPrivate(DOC_WRITE_DIR);

  let file: NonNullable<ChatMsg["file"]>;
  if (mime) {
    // an image is always shown, never a card to open: bytes stay on disk and
    // the app fetches /doc/<id>/raw
    await writePrivate(`${DOC_WRITE_DIR}${docId}.bin`, f);
    await writePrivate(`${DOC_WRITE_DIR}${docId}.json`, JSON.stringify({ name, fileKind: "image", mime }));
    file = { docId, name, fileKind: "image", size: f.size, inline: true };
  } else if (showFileKind(real, "") === "text" &&
             looksBinary(real, new Uint8Array(await f.slice(0, 4096).arrayBuffer()))) {
    /* A BINARY (task 524): an mp3, a zip, a pdf. The app has no renderer for it,
     * so reading it as text would fill a card with mojibake and, worse, saving
     * from that card would write the corrupted decode back. Its bytes are stored
     * UNTOUCHED -- exactly like an image above -- and served as a download; the
     * app renders a card, never the content. Only files the extension already
     * left as `text` reach here, so a `.md`/`.diff`/`.html` keeps its renderer. */
    await writePrivate(`${DOC_WRITE_DIR}${docId}.bin`, f);
    const binMime = binaryMime(real);
    await writePrivate(`${DOC_WRITE_DIR}${docId}.json`, JSON.stringify({ name, fileKind: "binary", mime: binMime }));
    file = { docId, name, fileKind: "binary", size: f.size };
  } else {
    const content = await f.text();
    const fileKind = showFileKind(real, content);
    if (fileKind === "html" && isEmptyPage(content)) {
      return reply(false, "the page is empty, so there is nothing to run. Nothing was shown.");
    }
    await writePrivate(`${DOC_WRITE_DIR}${docId}.json`, JSON.stringify({ name, fileKind, content }));
    /* A page is always a card. `canInline` is a property of the KIND and
     * overrules the size heuristic: a running page in a chat bubble would
     * start itself as the conversation scrolled past it (show.ts). Inline vs
     * card is decided here, on size, alone: the tool no longer carries an
     * `as` override (task 593). */
    const inline = canInline(fileKind) && fitsInline(content);
    file = { docId, name, fileKind, size: content.length, ...(inline ? { inline, content } : {}) };
  }

  const msg: ChatMsg = {
    id: s.id,
    role: "claude",
    // the card's caption is the file name; the tool no longer carries a title
    text: file.inline && file.fileKind !== "image" ? "" : name,
    ts: stampTs(s),
    file,
  };
  logChat(s, msg);
  clearQueuedByReply(s, msg.ts); // a shown file is a reply too: it drains the queue before it (#456)
  d.broadcast({ t: "chat", ...msg });

  /* A file pushed here is a reply like any other, and it was the one kind that
   * never buzzed anyone: notification lived only in the speak path, so a
   * session that answered by showing a diff or a page went out silently.
   * Same rule as a spoken reply: only when somebody can prove they are looking
   * at this chat. */
  void d.notifyUnlessWatched(s, {
    title: d.sessionPushTitle(s),
    body: msg.text || name,
    msgKey: docId,
    ts: msg.ts,
  });

  /* Only here, on the success path. Every early return above is a `show` that
   * put nothing in front of the user (no such file, outside the cwd, too big),
   * and counting one of those as a reply would wave a lost answer through. */
  d.noteReply(s.id);

  return reply(true, file.inline ? `shown inline as ${file.fileKind}` :
    file.fileKind === "html" ?
      "shown as an interactive page card. It opens full screen in a sandbox that can load " +
      "libraries over https but cannot read the app; it starts running when the user taps " +
      "it, not before." :
      file.fileKind === "binary" ?
      "shown as download card" :
      `shown as ${file.fileKind} card`);
}

