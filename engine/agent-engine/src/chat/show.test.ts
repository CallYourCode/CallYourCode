/* The `show` whitelist and its caps.
 *
 * The reason these are worth their own file: one of the five kinds RUNS. Every
 * assertion below is about a decision that, got wrong, either executes a
 * document that was never meant to execute or refuses one that was.
 *
 *   bun test agent-engine/src/chat/show.test.ts
 */

import { test, expect } from "bun:test";
import {
  showFileKind, imageMime, looksBinary, binaryMime, capFor, tooLargeMessage, canInline, fitsInline, isEmptyPage,
  showPathAllowed, IMAGE_EXT, BINARY_EXT, SNIFF_BYTES, SNIPPET_MAX_CHARS, SNIPPET_MAX_LINES,
  SHOW_MAX_BYTES, SHOW_HTML_MAX_BYTES,
} from "./show.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

// ------------------------------------------------------- what runs, and only that

test("an .html or .htm file is the page kind", () => {
  expect(showFileKind("/w/demo.html", "<canvas></canvas>")).toBe("html");
  expect(showFileKind("/w/demo.htm", "<canvas></canvas>")).toBe("html");
  expect(showFileKind("/w/DEMO.HTML", "")).toBe("html"); // extension match is case-insensitive
});

/* THE ONE THAT MATTERS. A file becomes executable because of its NAME, never
 * because of a line inside it. Without this, a bug report quoting a doctype, a
 * .md explaining how the viewer works, or a diff that patches an html file all
 * turn into live pages the moment somebody shows them. */
test("only the extension makes a page: content that looks like html does not", () => {
  const looksLikeAPage = '<!doctype html>\n<html><body><script>fetch("/x")</script></body></html>';
  expect(showFileKind("/w/notes.md", looksLikeAPage)).toBe("markdown");
  expect(showFileKind("/w/notes.txt", looksLikeAPage)).toBe("text");
  expect(showFileKind("/w/no-extension", looksLikeAPage)).toBe("text");
  expect(showFileKind("/w/page.html.bak", looksLikeAPage)).toBe("text");
});

// and the reverse: a .html file is a page even if its contents are prose
test("a .html file is a page whatever is in it", () => {
  expect(showFileKind("/w/x.html", "# not really html")).toBe("html");
  expect(showFileKind("/w/x.html", "diff --git a/x b/x")).toBe("html");
});

test("the other kinds are unchanged by the html rule", () => {
  expect(showFileKind("/w/r.md", "")).toBe("markdown");
  expect(showFileKind("/w/r.markdown", "")).toBe("markdown");
  expect(showFileKind("/w/p.patch", "")).toBe("diff");
  expect(showFileKind("/w/p.diff", "")).toBe("diff");
  expect(showFileKind("/w/anything", "diff --git a/x b/x\n")).toBe("diff"); // content sniff survives
  expect(showFileKind("/w/log.txt", "hello")).toBe("text");
});

test("every extension test is case-insensitive, because his files are not consistent", () => {
  expect(showFileKind("/w/R.MD", "")).toBe("markdown");
  expect(showFileKind("/w/R.MarkDown", "")).toBe("markdown");
  expect(showFileKind("/w/P.PATCH", "")).toBe("diff");
  expect(showFileKind("/w/P.Diff", "")).toBe("diff");
  expect(showFileKind("/w/x.HTM", "")).toBe("html");
});

/* MARKDOWN OUTRANKS THE DIFF SNIFF, and it has to: a note explaining a patch
 * quotes the patch. Rendered as a diff it would be an unreadable colour wash of
 * the prose around it. */
test("a markdown note that quotes a patch is still markdown", () => {
  expect(showFileKind("/w/notes.md", "Here is the fix:\n\ndiff --git a/x b/x\n")).toBe("markdown");
  expect(showFileKind("/w/notes.html", "diff --git a/x b/x\n")).toBe("html");
});

/* The diff sniff reads only the first 4096 characters. A `diff --git` line
 * further in is a mention inside a document, not the document's shape, and a
 * whole-file regex on a two megabyte text is cost for nothing. */
test("the diff sniff is a HEAD sniff: a diff line past the first 4096 chars is prose", () => {
  const early = "x\n".repeat(100) + "diff --git a/x b/x\n";
  expect(showFileKind("/w/log", early)).toBe("diff");
  const late = "x\n".repeat(4096) + "diff --git a/x b/x\n";
  expect(showFileKind("/w/log", late)).toBe("text");
});

test("the diff sniff wants the line at a line start, not anywhere in a sentence", () => {
  expect(showFileKind("/w/log", "I ran diff --git a/x b/x and it said nothing\n")).toBe("text");
});

test("images are still decided by extension alone", () => {
  expect(imageMime("/w/a.png")).toBe("image/png");
  expect(imageMime("/w/a.PNG")).toBe("image/png");
  expect(imageMime("/w/a.html")).toBeUndefined();
  expect(imageMime("/w/noext")).toBeUndefined();
});

test("every image extension on the list maps to the type it is served as", () => {
  /* The bytes go back with this exact content-type, so a wrong entry renders a
   * png as an svg, which is a document that can carry script. Each one is
   * checked rather than trusted to the table being read correctly. */
  expect(Object.keys(IMAGE_EXT).sort())
    .toEqual([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
  for (const [ext, mime] of Object.entries(IMAGE_EXT)) {
    expect(imageMime(`/w/photo${ext}`), ext).toBe(mime);
    expect(imageMime(`/w/photo${ext.toUpperCase()}`), `${ext} uppercase`).toBe(mime);
  }
  // a dot in a directory name is not an extension
  expect(imageMime("/w/v1.2/README")).toBeUndefined();
});

// ----------------------------------------------- a binary downloads, never text

/* THE DEFECT (task 524): an mp3 read as text is mojibake in a card, and saving
 * from that card writes the corrupt decode. A binary is caught before any read,
 * by its bytes OR its extension. */
test("a file with a null byte in its first chunk is binary, extension or not", () => {
  const withNull = new Uint8Array([0x49, 0x44, 0x33, 0x00, 0x00, 0xff, 0xfb]); // "ID3\0\0..."
  expect(looksBinary("/w/clip.mp3", withNull)).toBe(true);
  expect(looksBinary("/w/no-extension", withNull)).toBe(true); // sniff alone catches it
});

test("a known binary extension is binary even when its first bytes are ascii", () => {
  // a zip starts "PK\3\4", a pdf "%PDF" -- valid ascii, so the sniff would miss
  // them; the extension list is what catches these.
  expect(looksBinary("/w/a.zip", bytes("PK"))).toBe(true);
  expect(looksBinary("/w/a.pdf", bytes("%PDF-1.7\n"))).toBe(true);
  expect(looksBinary("/w/a.heic", bytes("ftypheic"))).toBe(true);
});

test("invalid UTF-8 in the first chunk is binary", () => {
  // 0xff is never a valid UTF-8 byte; a lone continuation byte 0x80 is malformed
  expect(looksBinary("/w/x", new Uint8Array([0x68, 0x69, 0xff, 0xfe]))).toBe(true);
  expect(looksBinary("/w/x", new Uint8Array([0x80, 0x81]))).toBe(true);
});

/* THE ONE THAT MUST NOT MISFIRE. Real text -- including emoji, CJK and accents,
 * which are multi-byte UTF-8 -- stays text. A markdown or diff note is never
 * even asked (server.ts only sniffs files the extension leaves as `text`), but
 * the sniff itself has to be right about honest bytes. */
test("genuine UTF-8 text is not binary, unusual characters included", () => {
  expect(looksBinary("/w/notes.txt", bytes("hello world"))).toBe(false);
  expect(looksBinary("/w/notes.txt", bytes("café naïve · résumé"))).toBe(false); // 2-byte
  expect(looksBinary("/w/notes.txt", bytes("你好 こんにちは 🚀🎉"))).toBe(false); // 3- and 4-byte
  expect(looksBinary("/w/empty", new Uint8Array(0))).toBe(false);
});

/* The three ways a byte sequence can be valid-looking UTF-8 and still be wrong.
 * A decoder that accepted any of them would read a crafted file as text, and
 * the sniff would then hand mojibake to a card that can save it back. */
test("overlong, surrogate and out-of-range sequences are binary, not text", () => {
  // 0xC0 0x80: the two-byte spelling of NUL, which real UTF-8 never uses
  expect(looksBinary("/w/x", new Uint8Array([0xc0, 0x80]))).toBe(true);
  // 0xED 0xA0 0x80: U+D800, a surrogate half, which is not a character
  expect(looksBinary("/w/x", new Uint8Array([0xed, 0xa0, 0x80]))).toBe(true);
  // 0xF5 ...: a four-byte lead past U+10FFFF
  expect(looksBinary("/w/x", new Uint8Array([0xf5, 0x80, 0x80, 0x80]))).toBe(true);
  // a lead byte followed by something that is not a continuation
  expect(looksBinary("/w/x", new Uint8Array([0xe4, 0xbd, 0x41]))).toBe(true);
});

/* The sniff reads SNIFF_BYTES and no further, so a null byte past the chunk is
 * a file this cannot know about. That is the honest bound: the alternative is
 * reading a two megabyte file to answer a question about its first page. */
test("the sniff stops at SNIFF_BYTES, in both directions", () => {
  const late = new Uint8Array(SNIFF_BYTES + 16).fill(0x61);
  late[SNIFF_BYTES] = 0; // one past the window
  expect(looksBinary("/w/big.txt", late)).toBe(false);
  const justInside = new Uint8Array(SNIFF_BYTES + 16).fill(0x61);
  justInside[SNIFF_BYTES - 1] = 0;
  expect(looksBinary("/w/big.txt", justInside)).toBe(true);
});

test("the extension list fires before any byte is looked at", () => {
  /* A `.mp3` whose first bytes happen to be clean ascii is still an mp3, and
   * an empty file with a binary extension is still served as a download. */
  expect(looksBinary("/w/clip.mp3", bytes("hello, this is not really an mp3"))).toBe(true);
  expect(looksBinary("/w/clip.MP3", new Uint8Array(0))).toBe(true);
  for (const ext of [".wasm", ".sqlite", ".docx", ".woff2", ".dylib"]) {
    expect(BINARY_EXT.has(ext), `${ext} should be on the binary list`).toBe(true);
    expect(looksBinary(`/w/a${ext}`, bytes("plain text")), ext).toBe(true);
  }
  // and a text extension that merely resembles one is not on it
  expect(looksBinary("/w/a.binary", bytes("plain text"))).toBe(false);
});

/* A multi-byte character cut in half at the 4096-byte sniff boundary is
 * truncation, not corruption: it must NOT read as binary. */
test("a multi-byte character split at the chunk boundary stays text", () => {
  const filler = new Uint8Array(4095).fill(0x61); // 4095 'a's
  const withCutRocket = new Uint8Array(4096);
  withCutRocket.set(filler);
  withCutRocket[4095] = 0xf0; // first byte of a 4-byte sequence, rest is past the chunk
  expect(looksBinary("/w/big.txt", withCutRocket)).toBe(false);
});

test("binaryMime maps known types and falls back to octet-stream", () => {
  expect(binaryMime("/w/a.mp3")).toBe("audio/mpeg");
  expect(binaryMime("/w/a.pdf")).toBe("application/pdf");
  expect(binaryMime("/w/a.zip")).toBe("application/zip");
  expect(binaryMime("/w/a.unknownext")).toBe("application/octet-stream");
  expect(binaryMime("/w/noext")).toBe("application/octet-stream");
});

// ------------------------------------------------------------------- the caps

test("a page gets a smaller cap than a document", () => {
  expect(capFor("html")).toBe(SHOW_HTML_MAX_BYTES);
  expect(capFor("markdown")).toBe(SHOW_MAX_BYTES);
  expect(capFor("text")).toBe(SHOW_MAX_BYTES);
  expect(capFor("diff")).toBe(SHOW_MAX_BYTES);
  expect(capFor("image")).toBe(SHOW_MAX_BYTES);
  expect(SHOW_HTML_MAX_BYTES).toBeLessThan(SHOW_MAX_BYTES);
});

/* The refusal is read by a model that can fix the page, so it has to say what
 * to do about it. "too large" on its own gets the same file pushed again. */
test("the refusal names the cap, the reason, and that nothing was shown", () => {
  const msg = tooLargeMessage("html", 3 * 1024 * 1024);
  expect(msg).toContain("3072KB");
  expect(msg).toContain("1024KB");
  expect(msg.toLowerCase()).toContain("refusal");
  expect(msg.toLowerCase()).toContain("not a truncation");
  expect(msg, "the agent reading this is the one who can shrink the page")
    .toContain("data: URIs");
});

test("a document's refusal names its own cap, not the page one", () => {
  const msg = tooLargeMessage("markdown", 5 * 1024 * 1024);
  expect(msg).toContain(String(5 * 1024 * 1024));
  expect(msg).toContain(String(SHOW_MAX_BYTES));
  expect(msg, "a document was refused against the smaller page cap")
    .not.toContain(String(SHOW_HTML_MAX_BYTES));
});

test("the caps are exact numbers, not 'about a megabyte'", () => {
  /* Written down here because the app publishes them to the agent and a change
   * to either is a change to what `show` will carry. */
  expect(SHOW_MAX_BYTES).toBe(16 * 1024 * 1024);
  expect(SHOW_HTML_MAX_BYTES).toBe(1 * 1024 * 1024);
  expect(capFor("binary"), "a binary download is a document, not a page").toBe(SHOW_MAX_BYTES);
});

/* The document cap is 16MB, not the old 2MB: a 10MB report is a document the
 * shown-docs vault (24MB total) can hold, but a 20MB one would evict the whole
 * vault on receipt, so it stays refused. The html cap is untouched. */
test("the document cap carries a 10MB report and still refuses a 20MB one", () => {
  expect(10 * 1024 * 1024 <= capFor("markdown"), "a 10MB document is carried").toBe(true);
  expect(20 * 1024 * 1024 <= capFor("markdown"), "a 20MB document is refused").toBe(false);
});

// ------------------------------------------------------- a page is never inline

/* A snippet renders wherever the conversation paints. Three pages scrolled
 * past would be three pages started at once, unasked. */
test("html can never render inside a bubble; the other kinds can", () => {
  expect(canInline("html")).toBe(false);
  expect(canInline("markdown")).toBe(true);
  expect(canInline("diff")).toBe(true);
  expect(canInline("text")).toBe(true);
  expect(canInline("image")).toBe(true);
  expect(canInline("binary")).toBe(true);
});

test("fitsInline still bounds both length and line count", () => {
  expect(fitsInline("- one\n- two")).toBe(true);
  expect(fitsInline("x".repeat(2001))).toBe(false);
  expect(fitsInline("y\n".repeat(41))).toBe(false);
});

/* THE EXACT EDGES OF BOTH CAPS, because they are two different failures: 200
 * short lines is as unreadable in a bubble as one enormous line, and an
 * off-by-one on either turns a snippet that should have been a card into one
 * the conversation has to paint on every scroll. */
test("both inline caps are inclusive at the boundary and refuse one past it", () => {
  expect(SNIPPET_MAX_CHARS).toBe(2000);
  expect(SNIPPET_MAX_LINES).toBe(40);
  expect(fitsInline("x".repeat(SNIPPET_MAX_CHARS))).toBe(true);
  expect(fitsInline("x".repeat(SNIPPET_MAX_CHARS + 1))).toBe(false);
  // n newlines is n+1 lines by split, so the cap is reached at 39 newlines
  expect(fitsInline("y\n".repeat(SNIPPET_MAX_LINES - 1) + "y")).toBe(true);
  expect(fitsInline("y\n".repeat(SNIPPET_MAX_LINES) + "y")).toBe(false);
  expect(fitsInline(""), "an empty snippet fits, and the pane shows it as one").toBe(true);
});

// ------------------------------------------------- where show may read from

/* Three roots (task 593): the session cwd, the OS tmpdir, and the
 * /tmp/claude-* scratchpad tree. Everything else is refused. The inputs are
 * realpaths; resolving them is the caller's job (server.ts onShow). */
const ROOTS = { cwd: "/home/u/project", tmp: "/tmp", claudeTmp: "/tmp/claude-" };

test("a path under the cwd or the cwd itself is allowed", () => {
  expect(showPathAllowed("/home/u/project/notes.md", ROOTS)).toBe(true);
  expect(showPathAllowed("/home/u/project/deep/dir/page.html", ROOTS)).toBe(true);
  expect(showPathAllowed("/home/u/project", ROOTS)).toBe(true);
});

test("a path under the OS tmpdir is allowed, outside every root is not", () => {
  expect(showPathAllowed("/tmp/scratch/page.html", ROOTS)).toBe(true);
  expect(showPathAllowed("/home/u/elsewhere/page.html", ROOTS)).toBe(false);
  expect(showPathAllowed("/etc/hosts", ROOTS)).toBe(false);
});

/* The classic startsWith footgun: a SIBLING whose name extends the root must
 * not ride the prefix in. */
test("a prefix-sibling of a root is outside it", () => {
  expect(showPathAllowed("/home/u/project2/x.md", ROOTS)).toBe(false);
  expect(showPathAllowed("/home/u/project-old/x.md", ROOTS)).toBe(false);
  expect(showPathAllowed("/tmpfs/page.html", ROOTS), "a sibling of the tmp root").toBe(false);
  expect(showPathAllowed("/home/u/project.bak", ROOTS)).toBe(false);
});

/* The inputs are REALPATHS, resolved by the caller, so `..` never reaches here
 * as a segment. What DOES reach here is a resolved path that landed outside,
 * and the answer to that is the same no as any other outside path. */
test("a resolved path that landed outside is refused however it got there", () => {
  expect(showPathAllowed("/home/u/secrets/id_rsa", ROOTS)).toBe(false);
  expect(showPathAllowed("/", ROOTS)).toBe(false);
  expect(showPathAllowed("", ROOTS)).toBe(false);
  expect(showPathAllowed("relative/page.html", ROOTS),
    "a path that was never resolved must not be allowed by accident").toBe(false);
});

test("the parent of a root is not the root", () => {
  expect(showPathAllowed("/home/u", ROOTS)).toBe(false);
  expect(showPathAllowed("/home", ROOTS)).toBe(false);
});

/* macOS shape: the OS tmpdir lives under /var/folders while the scratchpad
 * stays under /tmp/claude-*, which is why the claude tree is its own prefix
 * root rather than a consequence of the tmpdir one. */
test("the /tmp/claude-* scratchpad tree is allowed even when tmpdir is elsewhere", () => {
  const mac = { cwd: "/Users/u/project", tmp: "/private/var/folders/ab/T", claudeTmp: "/private/tmp/claude-" };
  expect(showPathAllowed("/private/tmp/claude-501/sess/scratchpad/page.html", mac)).toBe(true);
  expect(showPathAllowed("/private/tmp/other/page.html", mac)).toBe(false);
  expect(showPathAllowed("/private/tmp/claude-501/x.md", { ...mac, claudeTmp: null })).toBe(false);
});

// --------------------------------------------------------------- an empty page

/* A blank sandbox looks exactly like a page whose script threw, so the user
 * would debug the app rather than be told the file was empty. */
test("an empty page is recognisable, and whitespace does not count as content", () => {
  expect(isEmptyPage("")).toBe(true);
  expect(isEmptyPage("  \n\t\n ")).toBe(true);
  expect(isEmptyPage("<p>x</p>")).toBe(false);
});

test("a page that is only a comment or a doctype is not empty", () => {
  /* The rule is "the file has nothing in it", not "the file renders nothing".
   * A page that draws on a canvas from script, or one still being written that
   * has its doctype down, has content and gets shown as it is. */
  expect(isEmptyPage("<!doctype html>")).toBe(false);
  expect(isEmptyPage("<!-- todo -->")).toBe(false);
  expect(isEmptyPage("\n\n<html></html>\n")).toBe(false);
});
