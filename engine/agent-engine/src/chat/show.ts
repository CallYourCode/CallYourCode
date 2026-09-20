/* What the `show` tool will carry, and what it refuses.
 *
 * This is the WHITELIST. Every file an agent pushes is classified here into one
 * of five kinds, and the app has a renderer for each; anything unrecognised
 * falls through to `text`, which is a monospace pane and can render literally
 * anything without running any of it. There is one list, not two: the engine's
 * answer is written into the chat message and the app renders what it is told,
 * so a kind the app has never heard of cannot appear (the app's own parse in
 * app/src/engine/client.ts narrows to the same five).
 *
 * It lives in its own file because it is now a policy rather than a helper: an
 * `html` document is CODE THAT RUNS on the user's phone, so the rules about
 * what is accepted, how big it may be, and whether it may render itself inside
 * a chat bubble are decisions worth reading in one place and testing without
 * booting a server.
 *
 *   bun test agent-engine/src/chat/show.test.ts
 */

export type ShowKind = "markdown" | "diff" | "text" | "image" | "html" | "binary";

/* Images: an extension whitelist, not content sniffing. The bytes are served
 * back with this exact content-type, so a file that lies about its extension
 * gets rendered as the type it claimed and nothing else. */
export const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

export function imageMime(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : IMAGE_EXT[path.slice(dot).toLowerCase()];
}

/* Binary files: an mp3, a zip, a pdf. The app has no renderer for these, and
 * the failure this fixes (task 524) is exactly what happens when it tries: the
 * bytes are read as TEXT, mojibake fills a text card, and saving from that card
 * writes back the corrupted decode rather than the file. So a binary is never
 * read as text -- its raw bytes are stored untouched and served as a download.
 *
 * TWO signals, because neither alone is enough. The extension list catches a
 * known binary whose first bytes happen to be valid UTF-8 (a PDF starts "%PDF",
 * a zip "PK"); the byte sniff catches a binary with an unknown or absent
 * extension. A file is binary if EITHER fires -- but the sniff must never fire
 * on genuine text, so it looks only for a null byte or an actual UTF-8 decode
 * error in the first chunk, both of which real text never contains. Emoji, CJK
 * and accents are valid multi-byte UTF-8 and stay text. */
export const BINARY_EXT: ReadonlySet<string> = new Set([
  // audio
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".weba",
  // video
  ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".wmv", ".flv",
  // archives
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".tar", ".7z", ".rar",
  // documents / office
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
  // images the app does NOT render inline (heic/heif), plus raw camera
  ".heic", ".heif", ".raw", ".cr2", ".nef", ".dng",
  // fonts, wasm, native, misc binaries
  ".woff", ".woff2", ".ttf", ".otf", ".wasm", ".exe", ".dll", ".so", ".dylib",
  ".bin", ".dat", ".class", ".o", ".a", ".pyc", ".sqlite", ".db"
]);

const BINARY_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/opus", ".flac": "audio/flac",
  ".weba": "audio/webm",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
  ".zip": "application/zip", ".gz": "application/gzip", ".tgz": "application/gzip",
  ".tar": "application/x-tar", ".7z": "application/x-7z-compressed", ".rar": "application/vnd.rar",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".heic": "image/heic", ".heif": "image/heif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".wasm": "application/wasm"
};

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot).toLowerCase();
}

/* The content-type the download is served with. Unknown binaries fall to the
 * generic octet-stream, which downloads rather than opens -- exactly right for a
 * type the app has no renderer for. */
export function binaryMime(path: string): string {
  return BINARY_MIME[extOf(path)] ?? "application/octet-stream";
}

// How much of a file the byte sniff reads. A binary gives itself away early (a
// header, a null byte); reading more is only cost.
export const SNIFF_BYTES = 4096;

/* Is the FIRST chunk valid UTF-8? A hand-rolled validator rather than
 * TextDecoder({fatal:true}) for one reason: a large file is sniffed only up to
 * SNIFF_BYTES, so its last multi-byte character is usually cut in half at the
 * boundary. That truncation is not a decode error -- the rest of the character
 * is simply past the chunk -- and a fatal decoder would call it one, flagging a
 * perfectly good text file as binary. So an incomplete sequence AT THE END of
 * the chunk is accepted; a malformed one anywhere before it is the real signal. */
function utf8PrefixOk(bytes: Uint8Array, len: number): boolean {
  let i = 0;
  while(i < len) {
    const b = bytes[i];
    if(b < 0x80) { i++; continue; }
    let extra: number, min: number;
    if((b & 0xe0) === 0xc0) { extra = 1; min = 0x80; }
    else if((b & 0xf0) === 0xe0) { extra = 2; min = 0x800; }
    else if((b & 0xf8) === 0xf0) { extra = 3; min = 0x10000; }
    else return false; // 0x80-0xbf continuation as a lead, or 0xf8+: not UTF-8
    if(i + extra >= len) return true; // sequence runs past the chunk: truncation, not corruption
    let cp = b & (0x7f >> extra);
    for(let k = 1; k <= extra; k++) {
      const cb = bytes[i + k];
      if((cb & 0xc0) !== 0x80) return false; // missing continuation byte
      cp = (cp << 6) | (cb & 0x3f);
    }
    if(cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false; // overlong / surrogate / out of range
    i += extra + 1;
  }
  return true;
}

/* The binary decision, taken on the raw BYTES before anything reads them as
 * text. Extension OR sniff (see BINARY_EXT). Note this is only ever asked about
 * a file the extension has already left as `text` (server.ts): a `.md`, `.diff`
 * or `.html` keeps its renderer and is never sent here, so a markdown note that
 * quotes a null byte in a fenced block stays markdown. */
export function looksBinary(path: string, bytes: Uint8Array): boolean {
  if(BINARY_EXT.has(extOf(path))) return true;
  const n = Math.min(bytes.length, SNIFF_BYTES);
  for(let i = 0; i < n; i++) if(bytes[i] === 0) return true; // a null byte is never text
  return !utf8PrefixOk(bytes, n);
}

/* Which renderer a non-image file gets.
 *
 * EXTENSION FIRST, CONTENT SECOND, and for html extension ONLY. Whether a page
 * runs must not depend on what a text file happens to contain: a markdown note
 * explaining a bug that quotes `<!doctype html>` would otherwise become a live
 * page, and a document that starts running because of a line inside it is
 * exactly the surprise this must not have. So `.html`/`.htm` runs, and a file
 * with any other name does not, whatever is in it.
 *
 * (Diffs keep their content sniff, because a diff cannot execute and the
 * failure mode of getting it wrong is a wrongly-coloured pane.) */
export function showFileKind(path: string, content: string): Exclude<ShowKind, "image"> {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".diff") || lower.endsWith(".patch")) return "diff";
  if (/^diff --git /m.test(content.slice(0, 4096))) return "diff";
  return "text";
}

/* THE CAPS, and why html gets a smaller one.
 *
 * A markdown or diff document is read; an html document is parsed into a live
 * DOM inside an iframe and then RUNS, on a phone, on top of an app that is
 * already holding a chat. The page also travels as one string: the engine
 * stores it, the app fetches it, holds it in JS, and hands it to `srcdoc`,
 * which is another copy. A megabyte of that is already a lot of phone, and a
 * self-contained page that needs more than a megabyte has inlined something
 * (a video, a font family, a photo set) that it should not have.
 *
 * Both are refusals, never truncation: half an html document is a page that
 * runs wrong rather than a page that is missing its end, and half a diff is a
 * diff that says the wrong thing. */
export const SHOW_MAX_BYTES = 16 * 1024 * 1024;
export const SHOW_HTML_MAX_BYTES = 1 * 1024 * 1024;

export const capFor = (kind: ShowKind): number =>
  kind === "html" ? SHOW_HTML_MAX_BYTES : SHOW_MAX_BYTES;

/* The refusal a too-large file gets. It names the cap AND why the html one is
 * lower, because the agent reading it is the one who can fix the page, and
 * "too large" on its own invites a retry with the same file. */
export function tooLargeMessage(kind: ShowKind, size: number): string {
  const cap = capFor(kind);
  const kb = (n: number) => `${Math.round(n / 1024)}KB`;
  if (kind === "html") {
    return `page too large (${kb(size)}, cap ${kb(cap)}). An interactive page is parsed and ` +
      `run inside the app on a phone, so it gets a smaller cap than a document. Shrink the ` +
      `inlined assets (data: URIs are a third bigger than the bytes they carry), or show a ` +
      `smaller page. Nothing was shown: this is a refusal, not a truncation.`;
  }
  return `file too large (${size} bytes, cap ${cap})`;
}

/* Does the file's KIND allow it to render inside a chat bubble?
 *
 * No for html, always, and this one is not a size judgement. An inline snippet
 * is rendered by the chat every time the conversation paints: scrolling past
 * three of them would start three pages at once, mid-scroll, each with its own
 * timers and canvases, and a page that runs because it drifted into view is
 * not something the user asked for. A page is a card, and it starts when it is
 * opened. `as: "inline"` is ignored for html rather than honoured. */
export const canInline = (kind: ShowKind): boolean => kind !== "html";

// What fits in a bubble. A task list or a ten-line patch belongs in the
// conversation; a whole document belongs behind a card. Both caps matter:
// 200 short lines is as unreadable in a bubble as one enormous line.
export const SNIPPET_MAX_CHARS = 2000;
export const SNIPPET_MAX_LINES = 40;
export const fitsInline = (content: string): boolean =>
  content.length <= SNIPPET_MAX_CHARS &&
  content.split("\n").length <= SNIPPET_MAX_LINES;

/* WHERE `show` MAY READ FROM (task 593).
 *
 * The session's cwd was the only root, which refused every page an agent wrote
 * into its scratchpad -- the harness hands sessions a scratchpad under
 * /tmp/claude-<uid>/... and tells them to prefer it over the project tree, so
 * the natural place to write a throwaway page was exactly the place `show`
 * would not read. Three roots now: the cwd, the OS tmpdir, and the
 * /tmp/claude-* scratchpad tree (its own prefix because on macOS the OS tmpdir
 * is /var/folders/... while the scratchpad stays under /tmp).
 *
 * The caller passes REALPATHS, both for the candidate and the roots: the
 * confinement discipline is resolve first, then prefix-check, so a symlink
 * inside an allowed root cannot reach outside it. `claudeTmp` is a PREFIX
 * ("/tmp/claude-" after realpath), not a directory: it matches every
 * per-session tree under it. The "/" appended to each root is what keeps
 * /tmp/notify-harness2 from matching a root of /tmp/notify-harness. */
export function showPathAllowed(
  real: string,
  roots: { cwd: string; tmp: string; claudeTmp: string | null },
): boolean {
  const under = (root: string) => real === root || real.startsWith(root + "/");
  if (under(roots.cwd) || under(roots.tmp)) return true;
  return roots.claudeTmp !== null && real.startsWith(roots.claudeTmp);
}

/* An EMPTY page is a refusal, and only a page.
 *
 * `show` on a page the agent is still writing (or wrote to the wrong path)
 * would otherwise put a card in the chat that opens on nothing: a blank
 * sandbox is indistinguishable from a page whose script threw, so the user
 * would be debugging the app instead of being told the file was empty. An
 * empty .md or .txt is left alone, because that is a document that happens to
 * be empty and the pane shows it as one. */
export const isEmptyPage = (content: string): boolean => content.trim().length === 0;
