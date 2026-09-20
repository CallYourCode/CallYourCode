/* The terminal bridge: the parts that can go wrong without a herdr.
 *
 * Two fears, and they are different.
 *
 * The parsing half is about the WIRE being what the plan says it is. The
 * shapes here are not invented: they are lines from a real
 * `herdr terminal session observe` capture (the first frame full, the rest
 * deltas), so if herdr's field names move this fails rather than silently
 * rendering nothing. Line splitting gets its own test because the first full
 * frame is ~224KB of base64 and does NOT arrive in one chunk -- a reader that
 * treats a chunk as a line loses the only frame that matters.
 *
 * The hub half is about NEVER LEAKING A BRIDGE PROCESS. Every test ends by
 * asserting the hub is empty and that every session it handed out was
 * released, because a bridge nobody is watching survives until the engine
 * restarts and there is nothing in the UI that would ever show it.
 *
 *   bun test agent-engine/src/terminal/terminal.test.ts
 */

import { test, expect } from "bun:test";
import { LineSplitter, TerminalHub, clampCols, clampRows, parseBridgeLine, safeInput,
  safeScroll, safePaneId, wheelSeq, makeTerminalDriver,
  INPUT_MAX_BYTES, SCROLL_MAX_LINES, COLS_MIN, COLS_MAX, ROWS_MIN, ROWS_MAX,
  WHEEL_UP, WHEEL_DOWN,
  type ScrollMode, type TerminalDriver, type TerminalHandlers, type TerminalInput, type Viewer } from "./terminal.ts";

// ---------------------------------------------------------------- the wire

test("a full frame from a real capture parses into cols/rows/bytes", () => {
  const line = JSON.stringify({
    type: "terminal.frame", encoding: "ansi", full: true,
    width: 120, height: 40, seq: 1, bytes: "G1s/MjAyNmg=",
  });
  const ev = parseBridgeLine(line);
  expect(ev?.kind).toBe("frame");
  if (ev?.kind !== "frame") return;
  expect(ev.frame).toEqual({ full: true, seq: 1, cols: 120, rows: 40, bytes: "G1s/MjAyNmg=" });
});

test("a delta is a frame too, just not a full one", () => {
  const ev = parseBridgeLine(JSON.stringify({
    type: "terminal.frame", encoding: "ansi", full: false, width: 120, height: 40, seq: 9, bytes: "abc",
  }));
  expect(ev?.kind === "frame" && ev.frame.full).toBe(false);
});

test("size and closed are their own kinds", () => {
  expect(parseBridgeLine(JSON.stringify({ type: "terminal.size", width: 100, height: 30 })))
    .toEqual({ kind: "size", cols: 100, rows: 30 });
  expect(parseBridgeLine(JSON.stringify({ type: "terminal.closed", reason: "pane gone" })))
    .toEqual({ kind: "closed", why: "pane gone" });
});

// The protocol is versioned and a newer herdr is allowed to say things this
// engine has never heard of. Dropping them is correct; throwing is not.
test("garbage and unknown types are dropped, not thrown", () => {
  expect(parseBridgeLine("not json")).toBeNull();
  expect(parseBridgeLine("null")).toBeNull();
  expect(parseBridgeLine(JSON.stringify({ type: "terminal.something-new" }))).toBeNull();
  expect(parseBridgeLine(JSON.stringify({ type: "terminal.frame", full: true }))).toBeNull(); // no bytes
});

test("a frame split across chunks still arrives whole", () => {
  const payload = JSON.stringify({ type: "terminal.frame", full: true, width: 120, height: 40, seq: 1, bytes: "x".repeat(4000) }) + "\n";
  const raw = new TextEncoder().encode(payload);
  const splitter = new LineSplitter();
  const lines: string[] = [];
  // 1KB at a time, which is roughly how the first full frame really arrives
  for (let i = 0; i < raw.length; i += 1024) {
    splitter.push(raw.slice(i, i + 1024), (l) => lines.push(l));
  }
  expect(lines.length).toBe(1);
  const ev = parseBridgeLine(lines[0]!);
  expect(ev?.kind === "frame" && ev.frame.bytes.length).toBe(4000);
});

test("a frame with fields herdr left out reads as zeros, never NaN", () => {
  /* Every number goes through `Number(x) || 0`, so a missing width cannot reach
   * xterm.js as NaN and blank the pane. `full` is a strict === true: a string
   * "true" from a hand-rolled client is NOT a full frame, because treating a
   * delta as full would repaint garbage. */
  const ev = parseBridgeLine(JSON.stringify({ type: "terminal.frame", bytes: "AA==", full: "true" }));
  expect(ev?.kind === "frame" && ev.frame).toEqual({ full: false, seq: 0, cols: 0, rows: 0, bytes: "AA==" });
});

test("a size frame with nothing usable in it is zeros, and a closed with no reason says 'closed'", () => {
  expect(parseBridgeLine(JSON.stringify({ type: "terminal.size" })))
    .toEqual({ kind: "size", cols: 0, rows: 0 });
  // the reason reaches the app as the sentence beside the dead terminal; a
  // number or an object there would render as "[object Object]"
  expect(parseBridgeLine(JSON.stringify({ type: "terminal.closed" })))
    .toEqual({ kind: "closed", why: "closed" });
  expect(parseBridgeLine(JSON.stringify({ type: "terminal.closed", reason: 42 })))
    .toEqual({ kind: "closed", why: "closed" });
});

test("a JSON value that is not an object is dropped", () => {
  // valid JSON, useless payload: a bare string or number must not reach the
  // property reads below it
  for (const line of ['"a string"', "42", "true", "[]"]) {
    if (line === "[]") continue; // an array IS an object; it simply matches no type
    expect(parseBridgeLine(line)).toBeNull();
  }
  expect(parseBridgeLine("[]")).toBeNull();
});

test("several frames in one chunk all come out, in order", () => {
  const splitter = new LineSplitter();
  const seqs: number[] = [];
  const blob = [1, 2, 3].map((seq) => JSON.stringify({ type: "terminal.frame", full: false, width: 1, height: 1, seq, bytes: "a" })).join("\n") + "\n";
  splitter.push(new TextEncoder().encode(blob), (l) => {
    const ev = parseBridgeLine(l);
    if (ev?.kind === "frame") seqs.push(ev.frame.seq);
  });
  expect(seqs).toEqual([1, 2, 3]);
});

test("an incomplete tail is held, not emitted, and blank lines are skipped", () => {
  /* One JSON object per newline is the ONLY framing rule the bridge has. Half a
   * line handed on would be unparseable JSON and the frame would be lost, and a
   * blank keep-alive line would be parsed as garbage every time. */
  const splitter = new LineSplitter();
  const lines: string[] = [];
  const push = (s: string) => splitter.push(new TextEncoder().encode(s), (l) => lines.push(l));
  push('{"type":"terminal.size","width":10,');
  expect(lines).toEqual([]);          // held: the object is not finished
  push('"height":5}\n\n   \n');
  expect(lines).toEqual(['{"type":"terminal.size","width":10,"height":5}']);
  expect(parseBridgeLine(lines[0]!)).toEqual({ kind: "size", cols: 10, rows: 5 });
});

test("a multi-byte character split across chunks is reassembled, not mangled", () => {
  /* The decoder is in streaming mode for exactly this: the first full frame is
   * ~224KB and a chunk boundary lands wherever the pipe felt like. A non-
   * streaming decode would put a replacement character mid-base64 and the frame
   * would decode to noise. */
  const payload = JSON.stringify({ type: "terminal.closed", reason: "パネルが消えた" }) + "\n";
  const raw = new TextEncoder().encode(payload);
  const splitter = new LineSplitter();
  const lines: string[] = [];
  for (const chunk of [raw.slice(0, 40), raw.slice(40, 41), raw.slice(41)]) {
    splitter.push(chunk, (l) => lines.push(l));
  }
  expect(lines).toHaveLength(1);
  expect(parseBridgeLine(lines[0]!)).toEqual({ kind: "closed", why: "パネルが消えた" });
});

// A viewer that measures itself while hidden reports 0, and a bridge rendering
// into nothing is answered only on stderr.
test("sizes are clamped to something a terminal can be", () => {
  expect(clampCols(0)).toBe(20);
  expect(clampRows(0)).toBe(5);
  expect(clampCols(NaN)).toBe(80);
  expect(clampRows(undefined)).toBe(24);
  expect(clampCols(10_000)).toBe(400);
  expect(clampCols(97.6)).toBe(98);
});

test("the clamps hold at both ends and for every kind of junk", () => {
  // the failure this prevents is silent on both sides: herdr rejects a bad size
  // on stderr only, and a bridge rendering into 0x0 just sends nothing
  expect(clampCols(COLS_MIN)).toBe(COLS_MIN);
  expect(clampCols(COLS_MAX)).toBe(COLS_MAX);
  expect(clampRows(ROWS_MIN)).toBe(ROWS_MIN);
  expect(clampRows(ROWS_MAX)).toBe(ROWS_MAX);
  expect(clampCols(-500)).toBe(COLS_MIN);
  expect(clampRows(-1)).toBe(ROWS_MIN);
  expect(clampRows(99_999)).toBe(ROWS_MAX);
  // a NUMERIC STRING is what a JSON client sends by accident; it must clamp
  // like the number it is, not fall to the default
  expect(clampCols("100")).toBe(100);
  expect(clampRows("30")).toBe(30);
  // anything that cannot be a number at all takes the sane default
  for (const junk of ["wide", {}, Infinity, -Infinity, NaN, undefined]) {
    expect(clampCols(junk)).toBe(80);
    expect(clampRows(junk)).toBe(24);
  }
  // null and [] coerce to 0, which is a number, so they clamp to the floor
  // rather than to the default. Pinned because it is the surprising half.
  expect(clampCols(null)).toBe(COLS_MIN);
  expect(clampCols([])).toBe(COLS_MIN);
});

// ---------------------------------------------------------------- the hub

type FakeSession = {
  paneId: string; cols: number; rows: number; released: boolean;
  resizes: Array<[number, number]>;
  inputs: TerminalInput[];
  scrolls: Array<[string, number]>;
  h: TerminalHandlers;
};

function fakeDriver(canResize = true, mode: ScrollMode = "scroll") {
  const opened: FakeSession[] = [];
  const driver: TerminalDriver = {
    name: "fake",
    canResize,
    paneMode: async () => mode,
    open(paneId, cols, rows, h) {
      const s: FakeSession = { paneId, cols, rows, released: false, resizes: [], inputs: [], scrolls: [], h };
      opened.push(s);
      return {
        resize(c, r) { s.resizes.push([c, r]); s.cols = c; s.rows = r; },
        input(m) { s.inputs.push(m); },
        scroll(d, n) { s.scrolls.push([d, n]); },
        release() { s.released = true; },
      };
    },
  };
  return { driver, opened, live: () => opened.filter((s) => !s.released) };
}

function viewer(paneId: string, device: string, cols: number, rows: number, out: unknown[] = []): Viewer & { out: unknown[] } {
  return { paneId, device, cols, rows, send: (m) => out.push(m), out };
}

test("one viewer, one bridge, released when it leaves", () => {
  const { driver, opened, live } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p14", "phone", 80, 24);
  hub.open(v);
  expect(opened.length).toBe(1);
  expect(opened[0]).toMatchObject({ paneId: "w9:p14", cols: 80, rows: 24 });
  hub.close(v);
  expect(live().length).toBe(0);
  expect(hub.size).toBe(0);
});

test("frames reach the viewer as term-frame on its own socket", () => {
  const { driver, opened } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p14", "phone", 80, 24);
  hub.open(v);
  opened[0]!.h.onFrame({ full: true, seq: 1, cols: 80, rows: 24, bytes: "AA==" });
  expect(v.out).toEqual([{ t: "term-frame", id: "w9:p14", full: true, seq: 1, cols: 80, rows: 24, bytes: "AA==" }]);
  hub.close(v);
});

test("the bridge opens on the real pane but tags frames with the app's id (#355)", () => {
  // A conversation is now its stable claude session id (a UUID), not the pane it
  // sits on. The app opens a terminal by that id; the bridge must still be
  // spawned against the LIVE HERDR PANE, and the frames must go back tagged with
  // the id the app opened with, or the app drops them. Before this split the
  // driver was handed the UUID and herdr answered "terminal target ... not
  // found" -- blank on every session.
  const { driver, opened } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const out: unknown[] = [];
  const v: Viewer = { paneId: "w9:p16", routeId: "bd08d2c4-uuid", device: "phone", cols: 80, rows: 24, send: (m) => out.push(m) };
  hub.open(v);
  // spawned against the real herdr pane, NOT the session id
  expect(opened[0]!.paneId).toBe("w9:p16");
  opened[0]!.h.onFrame({ full: true, seq: 1, cols: 80, rows: 24, bytes: "AA==" });
  opened[0]!.h.onClosed("gone");
  // every frame back to the app carries the id it opened with
  expect(out).toEqual([
    { t: "term-frame", id: "bd08d2c4-uuid", full: true, seq: 1, cols: 80, rows: 24, bytes: "AA==" },
    { t: "term-closed", id: "bd08d2c4-uuid", why: "gone" },
  ]);
});

test("two tabs on the same phone at the same size share ONE bridge", () => {
  const { driver, live } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const a = viewer("w9:p14", "phone", 80, 24);
  const b = viewer("w9:p14", "phone", 80, 24);
  hub.open(a);
  hub.open(b);
  expect(live().length).toBe(1);
  expect(hub.size).toBe(1);
  // ...and the last one out releases it, not the first
  hub.close(a);
  expect(live().length).toBe(1);
  hub.close(b);
  expect(live().length).toBe(0);
});

/* The joiner problem, which is the reason the hub restarts rather than replays:
 * herdr sends `full:true` exactly once. A second viewer that only ever saw
 * deltas would render garbage. */
test("a joiner gets a fresh process, so a full frame is coming", () => {
  const { driver, opened, live } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const a = viewer("w9:p14", "phone", 80, 24);
  hub.open(a);
  const first = opened[0]!;
  hub.open(viewer("w9:p14", "phone", 80, 24));
  expect(first.released).toBe(true);
  expect(opened.length).toBe(2);
  expect(live().length).toBe(1);
  // and the new process still fans to BOTH viewers
  opened[1]!.h.onFrame({ full: true, seq: 1, cols: 80, rows: 24, bytes: "AA==" });
  expect(a.out.length).toBe(1);
});

test("a phone and a tablet never share: different sizes, different pictures", () => {
  const { driver, live } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const phone = viewer("w9:p14", "phone", 60, 40);
  const tablet = viewer("w9:p14", "tablet", 110, 40);
  hub.open(phone);
  hub.open(tablet);
  expect(live().length).toBe(2);
  hub.close(phone);
  hub.close(tablet);
  expect(live().length).toBe(0);
});

test("a resizeable driver is told the new size, not respawned", () => {
  const { driver, opened, live } = fakeDriver(true);
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p14", "phone", 80, 24);
  hub.open(v);
  hub.resize(v, 100, 30);
  expect(opened.length).toBe(1); // no respawn
  expect(opened[0]!.resizes).toEqual([[100, 30]]);
  // and it is now keyed at the new size: closing still releases it
  hub.close(v);
  expect(live().length).toBe(0);
  expect(hub.size).toBe(0);
});

/* A driver whose size only comes from argv (herdr's read-only `observe` is
 * one) has to respawn to be resized, and the old process must be released by
 * pid on the way. */
test("a driver that cannot resize respawns, leaking nothing", () => {
  const { driver, opened, live } = fakeDriver(false);
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p14", "phone", 80, 24);
  hub.open(v);
  hub.resize(v, 100, 30);
  expect(opened.length).toBe(2);
  expect(opened[0]!.released).toBe(true);
  expect(opened[1]).toMatchObject({ cols: 100, rows: 30 });
  expect(live().length).toBe(1);
  hub.close(v);
  expect(live().length).toBe(0);
  expect(hub.size).toBe(0);
});

test("resizing off a shared bridge leaves the other viewer alone", () => {
  const { driver, live } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const a = viewer("w9:p14", "phone", 80, 24);
  const b = viewer("w9:p14", "phone", 80, 24);
  hub.open(a);
  hub.open(b);
  hub.resize(a, 100, 30);
  expect(live().length).toBe(2);
  hub.close(a);
  hub.close(b);
  expect(live().length).toBe(0);
  expect(hub.size).toBe(0);
});

test("the bridge dying tells the viewers and drops itself", () => {
  const { driver, opened } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p14", "phone", 80, 24);
  hub.open(v);
  opened[0]!.h.onClosed("pane gone");
  expect(v.out).toEqual([{ t: "term-closed", id: "w9:p14", why: "pane gone" }]);
  expect(hub.size).toBe(0);
  hub.close(v); // the app's back button, after the fact: must not throw
  expect(hub.size).toBe(0);
});

// -------------------------------------------------------------- typing in

/* The wire is untrusted and herdr answers a bad frame ONLY on stderr, so a
 * malformed key would look exactly like a key that did nothing. Everything
 * that will not go through is rejected here, where it can be seen. */
test("input is either text or bytes, and bytes must really be base64", () => {
  expect(safeInput({ text: "!ls\r" })).toEqual({ text: "!ls\r" });
  // Ctrl-C, the one that has to work
  expect(safeInput({ bytes: "Aw==" })).toEqual({ bytes: "Aw==" });
  // text wins when both are set: they are mutually exclusive on the wire
  expect(safeInput({ text: "a", bytes: "Aw==" })).toEqual({ text: "a" });
  expect(safeInput({})).toBeNull();
  expect(safeInput({ text: "" })).toBeNull();
  expect(safeInput({ text: 7 })).toBeNull();
  expect(safeInput({ bytes: "not base64!" })).toBeNull();
  expect(safeInput({ bytes: "" })).toBeNull();
  expect(safeInput({ text: "x".repeat(INPUT_MAX_BYTES + 1) })).toBeNull();
});

test("the input cap counts BYTES, not characters", () => {
  /* A paste of CJK text is three bytes a character. Counting characters would
   * let a 3x oversized write reach herdr, which answers a too-large frame on
   * stderr only, so the paste would just silently vanish. */
  const wide = "あ".repeat(INPUT_MAX_BYTES / 3);
  expect(Buffer.byteLength(wide, "utf8")).toBeLessThanOrEqual(INPUT_MAX_BYTES);
  expect(safeInput({ text: wide })).toEqual({ text: wide });
  expect(safeInput({ text: wide + "あ" })).toBeNull();
  // and a single byte under the cap still goes
  expect(safeInput({ text: "x".repeat(INPUT_MAX_BYTES) })).not.toBeNull();
});

test("base64 bytes must be strict base64 that decodes to something sendable", () => {
  // Buffer.from is famously forgiving: it would happily "decode" whitespace and
  // punctuation into whatever it could salvage, so the charset is checked first
  expect(safeInput({ bytes: "AA ==" })).toBeNull();      // whitespace
  expect(safeInput({ bytes: "AA\n==" })).toBeNull();
  expect(safeInput({ bytes: "AA-_" })).toBeNull();       // url-safe alphabet
  expect(safeInput({ bytes: "=AAA" })).toBeNull();       // padding first
  expect(safeInput({ bytes: "====" })).toBeNull();
  // and a payload over the cap once decoded is refused on the DECODED length
  const big = Buffer.alloc(INPUT_MAX_BYTES + 1).toString("base64");
  expect(big.length).toBeGreaterThan(INPUT_MAX_BYTES);
  expect(safeInput({ bytes: big })).toBeNull();
  const atCap = Buffer.alloc(INPUT_MAX_BYTES).toString("base64");
  expect(safeInput({ bytes: atCap })).toEqual({ bytes: atCap });
});

test("input from a client that sent the wrong types is refused, never coerced", () => {
  for (const m of [{ text: null }, { text: [] }, { bytes: 3 }, { bytes: null }, { text: undefined, bytes: undefined }]) {
    expect(safeInput(m as { text?: unknown; bytes?: unknown })).toBeNull();
  }
});

test("scroll needs a direction and a positive line count", () => {
  expect(safeScroll({ dir: "up", lines: 3 })).toEqual({ direction: "up", lines: 3 });
  expect(safeScroll({ dir: "down", lines: 1 })).toEqual({ direction: "down", lines: 1 });
  expect(safeScroll({ dir: "up", lines: 1e6 })?.lines).toBe(200);
  expect(safeScroll({ dir: "sideways", lines: 3 })).toBeNull();
  expect(safeScroll({ dir: "up", lines: 0 })).toBeNull();
  expect(safeScroll({ dir: "up" })).toBeNull();
});

test("a fractional or stringified line count is rounded, and junk is refused", () => {
  // the app measures a gesture in CSS pixels and divides; the result is rarely
  // a whole number of rows
  expect(safeScroll({ dir: "up", lines: 3.6 })?.lines).toBe(4);
  expect(safeScroll({ dir: "down", lines: "5" })?.lines).toBe(5);
  expect(safeScroll({ dir: "up", lines: 0.4 })).toBeNull();   // rounds to 0
  expect(safeScroll({ dir: "up", lines: -3 })).toBeNull();
  expect(safeScroll({ dir: "up", lines: "many" })).toBeNull();
  expect(safeScroll({ dir: "up", lines: Infinity })).toBeNull();
  expect(safeScroll({ dir: "UP", lines: 1 })).toBeNull();     // exact strings only
  expect(safeScroll({ lines: 1 })).toBeNull();
  expect(safeScroll({ dir: "up", lines: SCROLL_MAX_LINES })?.lines).toBe(SCROLL_MAX_LINES);
});

test("keys reach the bridge this viewer is on, and only that one", async () => {
  const { driver, opened } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const phone = viewer("w9:p14", "phone", 60, 40);
  const tablet = viewer("w9:p14", "tablet", 110, 40);
  hub.open(phone);
  hub.open(tablet);
  hub.input(phone, { text: "!ls\r" });
  await Promise.resolve(); // the pane's scroll mode is asked for, not waited on
  hub.scroll(phone, "up", 3);
  expect(opened[0]!.inputs).toEqual([{ text: "!ls\r" }]);
  expect(opened[0]!.scrolls).toEqual([["up", 3]]);
  expect(opened[1]!.inputs).toEqual([]);
  hub.close(phone);
  hub.close(tablet);
  expect(hub.size).toBe(0);
});

/* A key pressed after the pane died. The viewer has already been told
 * term-closed; there is nothing left to type into and nothing useful to say. */
test("typing into a viewer with no bridge is a no-op, not a throw", () => {
  const { driver, opened } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p14", "phone", 80, 24);
  hub.open(v);
  opened[0]!.h.onClosed("pane gone");
  hub.input(v, { bytes: "Aw==" });
  hub.scroll(v, "down", 1);
  expect(hub.size).toBe(0);
});

/* The leak that survives an engine restart: a phone walks out of wifi range
 * and never sends term-close. The ws close handler is the only notice. */
test("a socket dropping releases every bridge it held", () => {
  const { driver, live } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const a = viewer("w9:p14", "phone", 80, 24);
  const b = viewer("w6:p1", "phone", 80, 24);
  const other = viewer("w9:p14", "tablet", 80, 24);
  hub.open(a);
  hub.open(b);
  hub.open(other);
  expect(live().length).toBe(3);
  hub.closeAll((v) => v.device === "phone");
  expect(live().length).toBe(1);
  hub.close(other);
  expect(live().length).toBe(0);
  expect(hub.size).toBe(0);
});

// ------------------------------------------------------- the wheel, and safety

/* SGR, because that is the form measured to work. Against a pane running Claude
 * Code, `\x1b[<64;20;10M` moved it a line per notch; the older X10 form moved
 * nothing. Cb 64 is up, 65 is down. */
test("a wheel burst is SGR notches, one per line asked for", () => {
  expect(wheelSeq("up", 1)).toBe("\x1b[<64;20;10M");
  expect(wheelSeq("down", 3)).toBe("\x1b[<65;20;10M".repeat(3));
  expect(wheelSeq("up", 0)).toBe("");
  // even the cap fits one terminal.input, which is what lets a burst be one write
  expect(Buffer.byteLength(wheelSeq("up", 200), "latin1")).toBeLessThan(INPUT_MAX_BYTES);
});

/* The id picks the pane whose history and process list get read, so it is
 * checked. herdr's ids are base36-ish: w6:pY and wE:p1 are real. */
test("only something shaped like a pane id may reach a herdr command", () => {
  expect(safePaneId("w9:p16")).toBe("w9:p16");
  expect(safePaneId("w6:pY")).toBe("w6:pY");
  expect(safePaneId("wE:p1")).toBe("wE:p1");
  expect(safePaneId("w9:p16; rm -rf /")).toBeNull();
  expect(safePaneId("$(id)")).toBeNull();
  expect(safePaneId("../../etc/passwd")).toBeNull();
  expect(safePaneId("")).toBeNull();
  expect(safePaneId(undefined)).toBeNull();
});

test("the pane id shape is exact at both ends", () => {
  // Bun.spawn takes an argv array so there is no shell to interpolate into, but
  // the id still PICKS the pane whose history and process list get read
  expect(safePaneId("W9:P16")).toBe("W9:P16");          // case-insensitive
  expect(safePaneId("w12345678:p12345678")).not.toBeNull();
  expect(safePaneId("w123456789:p1")).toBeNull();       // one segment too long
  expect(safePaneId("w:p1")).toBeNull();                // empty window segment
  expect(safePaneId("w9:p")).toBeNull();
  expect(safePaneId("w9p16")).toBeNull();               // no separator
  expect(safePaneId(" w9:p16")).toBeNull();             // whitespace is not trimmed away
  expect(safePaneId("w9:p16\n")).toBeNull();
  expect(safePaneId("w9:p16 w9:p17")).toBeNull();
  expect(safePaneId(null)).toBeNull();
  expect(safePaneId(123)).toBeNull();
});

/* A full-screen pane has no scrollback for herdr to move, so the gesture goes
 * in as wheel events and the program scrolls itself. Measured against Claude
 * Code: terminal.scroll produced zero frames there, wheel moved it a line a
 * notch. */
test("a wheel-mode pane gets notches as input, never terminal.scroll", async () => {
  const { driver, opened } = fakeDriver(true, "wheel");
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p19", "phone", 80, 22);
  hub.open(v);
  await Promise.resolve();
  hub.scroll(v, "up", 4);
  expect(opened[0]!.scrolls).toEqual([]);
  expect(opened[0]!.inputs.length).toBe(1);
  const bytes = Buffer.from((opened[0]!.inputs[0] as { bytes: string }).bytes, "base64").toString("latin1");
  expect(bytes).toBe(wheelSeq("up", 4));
  hub.close(v);
  expect(hub.size).toBe(0);
});

/* THE ONE THAT MATTERS. A shell sitting at its prompt never asked for mouse
 * reporting, so a wheel sequence delivered to it is TYPED IN: measured on a real
 * zsh, five notches left `64;20;10M64;20;10M...` on his command line. When the
 * engine cannot tell, it sends nothing at all. */
test("a pane with nothing to scroll is sent nothing, not wheel bytes", async () => {
  const { driver, opened } = fakeDriver(true, "none");
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p18", "phone", 80, 22);
  hub.open(v);
  await Promise.resolve();
  hub.scroll(v, "up", 9);
  expect(opened[0]!.inputs).toEqual([]);
  expect(opened[0]!.scrolls).toEqual([]);
  hub.close(v);
});

/* Before herdr has answered, the road is unknown, and the unknown road is the
 * one that sends nothing. A first gesture must not be able to type into a shell
 * just because it arrived early. */
test("a gesture before the mode is known sends nothing", () => {
  const { driver, opened } = fakeDriver(true, "wheel");
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p19", "phone", 80, 22);
  hub.open(v);
  hub.scroll(v, "up", 5); // no await: the answer has not come back yet
  expect(opened[0]!.inputs).toEqual([]);
  expect(opened[0]!.scrolls).toEqual([]);
  hub.close(v);
});

test("the viewer is told which road it got", async () => {
  const { driver } = fakeDriver(true, "wheel");
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p19", "phone", 80, 22);
  hub.open(v);
  await Promise.resolve();
  await Promise.resolve();
  expect(v.out).toContainEqual({ t: "term-mode", id: "w9:p19", mode: "wheel" });
  hub.close(v);
});

test("the FIRST answer is news even when it agrees with the placeholder", async () => {
  /* `mode` starts at "none" because that is the road that sends nothing, not
   * because anyone measured it. A viewer told only about CHANGES would sit on
   * "unknown" for ever whenever the pane really is a bare prompt, which is
   * exactly the case where it has something to say about a dead-feeling swipe. */
  const { driver } = fakeDriver(true, "none");
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p18", "phone", 80, 22);
  hub.open(v);
  await Promise.resolve();
  await Promise.resolve();
  expect(v.out).toContainEqual({ t: "term-mode", id: "w9:p18", mode: "none" });
  hub.close(v);
});

test("the mode is cached: a burst of gestures is not a burst of herdr calls", async () => {
  /* Waiting on a herdr round trip per notch is exactly the pacing that made
   * this feel late. The answer is remembered for a second and refreshed in the
   * background, never on the path of the gesture. */
  let asks = 0;
  const { driver, opened } = fakeDriver(true, "wheel");
  const counting: TerminalDriver = { ...driver, paneMode: async () => { asks++; return "wheel"; } };
  const hub = new TerminalHub(counting, () => {});
  const v = viewer("w9:p19", "phone", 80, 22);
  hub.open(v);           // asks once, straight away
  await Promise.resolve();
  await Promise.resolve();
  for (let i = 0; i < 20; i++) hub.scroll(v, "up", 1);
  expect(asks).toBe(1);
  expect(opened[0]!.inputs).toHaveLength(20); // every gesture still went
  hub.close(v);
});

test("a paneMode that rejects leaves the safe road in place", async () => {
  // herdr not answering is not a licence to type escape sequences into a shell
  const { driver, opened } = fakeDriver(true, "wheel");
  const failing: TerminalDriver = { ...driver, paneMode: async () => { throw new Error("herdr is gone"); } };
  const hub = new TerminalHub(failing, () => {});
  const v = viewer("w9:p19", "phone", 80, 22);
  hub.open(v);
  await Promise.resolve();
  await Promise.resolve();
  hub.scroll(v, "up", 3);
  expect(opened[0]!.inputs).toEqual([]);
  expect(opened[0]!.scrolls).toEqual([]);
  hub.close(v);
  expect(hub.size).toBe(0);
});

test("a wheel burst is capped at the same distance a scroll gesture travels", async () => {
  // both roads have to travel the same distance for the same gesture, or a
  // flick means two different things depending on what is running in the pane
  const { driver, opened } = fakeDriver(true, "wheel");
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p19", "phone", 80, 22);
  hub.open(v);
  await Promise.resolve();
  hub.scroll(v, "down", 5_000);
  const bytes = Buffer.from((opened[0]!.inputs[0] as { bytes: string }).bytes, "base64").toString("latin1");
  expect(bytes).toBe(wheelSeq("down", SCROLL_MAX_LINES));
  expect(Buffer.byteLength(bytes, "latin1")).toBeLessThan(INPUT_MAX_BYTES);
  hub.close(v);
});

// ------------------------------------------------------- more hub behaviour

test("re-opening the same viewer at the same size changes nothing", () => {
  /* A reconnect that re-sends term-open must not restart the bridge, or a flaky
   * socket becomes a repaint loop. */
  const { driver, opened } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p14", "phone", 80, 24);
  hub.open(v);
  hub.open(v);
  hub.open(v);
  expect(opened.length).toBe(1);
  expect(hub.size).toBe(1);
  hub.close(v);
  expect(hub.size).toBe(0);
});

test("re-opening the same viewer after a rotation moves it to the new bridge", () => {
  const { driver, opened, live } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p14", "phone", 80, 24);
  hub.open(v);
  v.cols = 40; v.rows = 60;   // the app measured itself again before re-opening
  hub.open(v);
  expect(opened[0]!.released).toBe(true);
  expect(opened[1]).toMatchObject({ cols: 40, rows: 60 });
  expect(live().length).toBe(1);
  hub.close(v);
  expect(hub.size).toBe(0);
});

test("a resize to the size it already has is a no-op", () => {
  const { driver, opened } = fakeDriver(true);
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p14", "phone", 80, 24);
  hub.open(v);
  hub.resize(v, 80, 24);
  expect(opened[0]!.resizes).toEqual([]);
  expect(opened.length).toBe(1);
  hub.close(v);
});

test("resizing onto a size another bridge already has joins it rather than making a third", () => {
  /* The hop path: the viewer is not the sole owner of its own bridge OR the
   * target key is taken, so it closes and re-opens, which lands on the existing
   * bridge and restarts it for the joiner's full frame. */
  const { driver, live } = fakeDriver(true);
  const hub = new TerminalHub(driver, () => {});
  const small = viewer("w9:p14", "phone", 60, 20);
  const big = viewer("w9:p14", "phone", 100, 30);
  hub.open(small);
  hub.open(big);
  expect(live().length).toBe(2);
  hub.resize(small, 100, 30); // now both want the same picture
  expect(hub.size).toBe(1);
  expect(live().length).toBe(1);
  hub.close(small);
  hub.close(big);
  expect(live().length).toBe(0);
  expect(hub.size).toBe(0);
});

test("a joiner is replayed the mode the bridge already learned", async () => {
  // it missed the term-mode that went out when the bridge learned it, and a
  // viewer that never hears one cannot say why a swipe is doing nothing
  const { driver } = fakeDriver(true, "wheel");
  const hub = new TerminalHub(driver, () => {});
  const a = viewer("w9:p19", "phone", 80, 22);
  hub.open(a);
  await Promise.resolve();
  await Promise.resolve();
  const b = viewer("w9:p19", "phone", 80, 22);
  hub.open(b);
  expect(b.out).toContainEqual({ t: "term-mode", id: "w9:p19", mode: "wheel" });
  hub.close(a);
  hub.close(b);
  expect(hub.size).toBe(0);
});

test("a size frame from the bridge reaches every viewer of it", () => {
  const { driver, opened } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const a = viewer("w9:p14", "phone", 80, 24);
  const b = viewer("w9:p14", "phone", 80, 24);
  hub.open(a);
  hub.open(b);
  a.out.length = 0; b.out.length = 0;
  opened[1]!.h.onSize(100, 30);
  expect(a.out).toEqual([{ t: "term-size", id: "w9:p14", cols: 100, rows: 30 }]);
  expect(b.out).toEqual([{ t: "term-size", id: "w9:p14", cols: 100, rows: 30 }]);
  hub.close(a);
  hub.close(b);
});

test("a viewer whose socket throws does not stop the others being told", () => {
  /* The socket is already gone and the close path will remove it; what must not
   * happen is the throw taking the frame away from the phone beside it. */
  const { driver, opened } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const dead: Viewer = { paneId: "w9:p14", device: "phone", cols: 80, rows: 24,
    send: () => { throw new Error("socket closed"); } };
  const alive = viewer("w9:p14", "phone", 80, 24);
  hub.open(dead);
  hub.open(alive);
  alive.out.length = 0;
  opened[1]!.h.onFrame({ full: true, seq: 2, cols: 80, rows: 24, bytes: "AA==" });
  expect(alive.out).toEqual([{ t: "term-frame", id: "w9:p14", full: true, seq: 2, cols: 80, rows: 24, bytes: "AA==" }]);
  hub.close(dead);
  hub.close(alive);
  expect(hub.size).toBe(0);
});

test("a closed frame from a bridge that was already replaced is ignored", () => {
  /* A dying process can report its own exit after the hub has moved on. Acting
   * on that would delete the LIVE bridge at the same key and leave the viewers
   * watching a process nothing points at, which is the leak this whole file is
   * about. The guard is the bridge IDENTITY, not the key.
   *
   * (The other half of this is in the drivers: herdrDriver and tmuxDriver both
   * latch `released` and never call a handler after release(), so the restart
   * path cannot produce a stale close at all.) */
  const { driver, opened, live } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const a = viewer("w9:p14", "phone", 80, 24);
  hub.open(a);
  const stale = opened[0]!;
  hub.close(a);           // that bridge is gone from the map
  hub.open(a);            // a NEW bridge object takes the same key
  expect(hub.size).toBe(1);
  stale.h.onClosed("the old process finally noticed");
  expect(hub.size).toBe(1);        // the live one survived
  expect(live().length).toBe(1);
  expect(a.out).toEqual([]);       // and the viewer was not told its pane died
  hub.close(a);
  expect(hub.size).toBe(0);
  expect(live().length).toBe(0);
});

test("closing or resizing a viewer the hub never had is a silent no-op", () => {
  const { driver } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const stranger = viewer("w9:p14", "phone", 80, 24);
  hub.close(stranger);
  hub.resize(stranger, 100, 30);
  hub.input(stranger, { text: "x" });
  hub.scroll(stranger, "up", 1);
  hub.closeAll(() => true);
  expect(hub.size).toBe(0);
});

test("closeAll leaves the viewers the predicate did not name", () => {
  const { driver, live } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const a = viewer("w9:p14", "phone", 80, 24);
  hub.open(a);
  hub.closeAll(() => false);
  expect(live().length).toBe(1);
  hub.closeAll((v) => v === a);
  expect(live().length).toBe(0);
  expect(hub.size).toBe(0);
});

test("makeTerminalDriver picks the multiplexer from CYC_MUX, defaulting to tmux", () => {
  /* The viewer's bridge is the one place the engine drives the multiplexer
   * outside the five-verb Multiplexer interface, so it needs its own factory: a
   * tmux engine that spawned `herdr terminal session control` would draw a
   * blank terminal on every pane. Env is passed IN rather than read from
   * process.env, so this asserts it without mutating anything. */
  expect(makeTerminalDriver({}).name).toBe("tmux");
  expect(makeTerminalDriver({ CYC_MUX: "herdr" }).name).toBe("herdr");
  expect(makeTerminalDriver({ CYC_MUX: " TMUX " }).name).toBe("tmux");
  expect(makeTerminalDriver({ CYC_MUX: "something-else" }).name).toBe("tmux");
});

test("the wheel bytes are the SGR form, one notch per line, with the pointer mid-screen", () => {
  /* Measured against a pane running Claude Code: `\x1b[<64;20;10M` moved it a
   * line per notch and the older X10 form moved nothing. The cell named is the
   * middle of the screen rather than an edge a program might treat specially. */
  expect(wheelSeq("up", 1)).toBe(`\x1b[<${WHEEL_UP};20;10M`);
  expect(wheelSeq("down", 1)).toBe(`\x1b[<${WHEEL_DOWN};20;10M`);
  expect(wheelSeq("up", 2, 5, 7)).toBe(`\x1b[<${WHEEL_UP};5;7M`.repeat(2));
  // a negative count is nothing, not a thrown RangeError from String.repeat
  expect(wheelSeq("up", -3)).toBe("");
  // 12 bytes a notch, which is what lets a whole burst be one write
  expect(Buffer.byteLength(wheelSeq("up", 1), "latin1")).toBe(12);
});
