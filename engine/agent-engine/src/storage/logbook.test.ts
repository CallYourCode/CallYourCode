/* What stops the log becoming the next .run/uploads.
 *
 * The extra logging is deliberately verbose, and this project has already
 * learned what an unbounded writer costs: .run/uploads reached 215 files before
 * anything swept it, and .run/audio still holds a thousand orphaned webm files.
 * The one condition on this work was that it must not balloon or crash
 * anything, so the bound is a claim and this is where it is checked: by writing
 * past the cap and looking at the directory, not by reading the constant back.
 *
 * UNIT. logbook.ts is a leaf (a rotating line writer over runfiles.ts) and this
 * file constructs the real one with a per-test tmp dir and its own caps. The old
 * version was marked as an engine-booting spec and reached the same subject by
 * setting CYC_LOG_* on the real process and re-importing the module behind a
 * `?fresh=` query string. That is what put four rescue.test.ts tests
 * permanently red in every full run: the harness spawned engines with
 * `{ ...process.env }`, so they inherited a deleted temp directory and a sixty
 * second flush interval. Nothing here touches process.env at all.
 *
 *   bun test logbook.test.ts
 */

import { test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openLog, safeCid, newCid, type LogOpts } from "../../../shared/logbook.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { manualClock } from "../runtime/clock.ts";
import { until } from "../test-utils/wait.ts";

/* THE CONSOLE MIRROR, CAPTURED RATHER THAN SILENCED.
 *
 * Every line goes to stdout before it goes to the queue, on purpose: start-v1.sh
 * points each service's stdout at .run/<service>.log and `tail -f` is what people
 * do while something is going wrong. It is also the copy that survives a full
 * disk, which is a claim two tests below actually check. Left unspied, the
 * rotation test alone would put nine hundred lines through this runner's output. */
let mirror: string[] = [];
let spy: { mockRestore: () => void };

beforeAll(() => {
  spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    mirror.push(a.map(String).join(" "));
  });
});
afterAll(() => spy.mockRestore());

/** A real logbook with its own directory, its own caps and no wall clock.
 *
 * The manual clock is never advanced unless a test asks for it, so the flush
 * timer never fires behind a test's back and every write reaches disk exactly
 * when the test says flush(). Service names must be unique: openLog memoises by
 * name and that is a contract of its own (see the last test). */
async function freshLog(
  service: string,
  o: Omit<LogOpts, "dir" | "clock"> = {},
) {
  const dir = await tmpDir("cyc-logbook-");
  const clock = manualClock();
  mirror = [];
  const book = openLog(service, { dir, clock, maxBytes: 1 << 20, queueMax: 10_000, flushMs: 200, ...o });
  return { dir, clock, book };
}

/** The lines actually on disk, blank-stripped, in write order. */
async function linesOf(path: string): Promise<string[]> {
  const text = await Bun.file(path).text().catch(() => "");
  return text.split("\n").filter(Boolean);
}

/* A LOG READER, written the way a log reader has to be written.
 *
 * The format is `<iso> <service> <event> k=v k=v ...`, space separated because
 * the thing you do with this file is grep it. That only holds if a value which
 * CONTAINS a space is quoted, so checking the escaping with a substring match
 * would be checking the wrong thing: `fake="x k2=v2"` and `fake=x k2=v2` both
 * contain the text `k2=v2`, and only one of them has invented a field. Parsing
 * the record back and comparing the whole map is the assertion that can tell
 * those two apart, and it fails loudly (a stray token, an extra key) rather than
 * quietly passing on a substring that happens to be there. */
function parseRecord(rec: string): { stamp: string; service: string; event: string; f: Record<string, string> } {
  /* [\s\S] rather than `.` on purpose: a quoted value may legitimately contain a
   * U+2028, which JSON leaves unescaped and which `.` refuses to cross. A reader
   * built on `.` would silently see no record at all for that line. */
  const m = /^(\S+) (\S+) (\S+)(?: ([\s\S]*))?$/.exec(rec);
  if (!m) throw new Error(`not a log record: ${JSON.stringify(rec)}`);
  const rest = m[4] ?? "";
  const f: Record<string, string> = {};
  let i = 0;
  while (i < rest.length) {
    while (rest[i] === " ") i++;
    if (i >= rest.length) break;
    const eq = rest.indexOf("=", i);
    if (eq < 0) throw new Error(`token with no key in ${JSON.stringify(rest.slice(i))}`);
    const key = rest.slice(i, eq);
    i = eq + 1;
    if (rest[i] === '"') {
      let j = i + 1;
      while (j < rest.length && rest[j] !== '"') j += rest[j] === "\\" ? 2 : 1;
      f[key] = JSON.parse(rest.slice(i, j + 1)) as string;
      i = j + 1;
    } else {
      let j = i;
      while (j < rest.length && rest[j] !== " ") j++;
      f[key] = rest.slice(i, j);
      i = j;
    }
  }
  return { stamp: m[1], service: m[2], event: m[3], f };
}

/* ------------------------------------------------------------------ *
 * THE DISK BOUND                                                      *
 * ------------------------------------------------------------------ */

test("the log rotates at its cap and keeps exactly one old generation", async () => {
  const CAP = 16 * 1024;
  const { book, dir } = await freshLog("rot", { maxBytes: CAP });

  // enough to blow through the cap several times over
  for (let i = 0; i < 900; i++) book.line("probe", { i, filler: "x".repeat(200) });
  await book.flush();

  const names = (await readdir(dir)).sort();
  expect(names,
    "the log did not rotate: one file grew past its cap. That is how .run/uploads got to " +
    "215 files, and a log is worse because nothing ever looks at it until something is " +
    `already wrong. Directory holds: ${names.join(", ")}`).toContain("rot.log.1");

  /* EXACTLY one generation. A rotation that kept every generation would be
   * unbounded with extra steps: the ceiling is 2 * cap per service, and that
   * is the number the whole design rests on. */
  const gens = names.filter((n) => /^rot\.log(\.\d+)?$/.test(n));
  expect(gens.sort(),
    `rotation kept ${gens.length} files (${gens.join(", ")}). One live file and one previous ` +
    "generation is the whole bound; a third means the ceiling does not exist.")
    .toEqual(["rot.log", "rot.log.1"]);

  let total = 0;
  for (const n of gens) total += (await stat(join(dir, n))).size;
  expect(total,
    `the two generations come to ${total} bytes against a cap of ${CAP}. The ceiling is ` +
    "2x the cap and nothing above that, however long a service runs.")
    .toBeLessThanOrEqual(CAP * 2);
});

test("rotation happens one byte past the cap, not at it", async () => {
  /* The boundary the old file could only approach from far above, by writing
   * thirteen times the cap and looking at what survived. The check is `bytes +
   * size > maxBytes`, and the difference between that and `>=` is one whole
   * generation of history thrown away for nothing every time a service happens
   * to land exactly on the number.
   *
   * It takes THREE flushes to test, not two. The very first append runs with
   * `bytes` at 0, and `bytes && ...` short-circuits there, so a first flush that
   * lands exactly on the cap proves nothing about the comparison at all: `>` and
   * `>=` behave identically. The 40-byte flush below is what puts a non-zero
   * byte count in front of the boundary. Sized so the arithmetic is exact:
   * a 19-byte line is 20 on disk with its newline, and five of them are the cap. */
  const LINE = "2026-01-01 bnd tick"; // 19 bytes, so 20 on disk with its newline
  const CAP = 100;
  const { book, dir } = await freshLog("bnd", { maxBytes: CAP });

  for (let i = 0; i < 2; i++) book.raw(LINE);
  await book.flush(); // 40 bytes down, and now the writer knows it

  for (let i = 0; i < 3; i++) book.raw(LINE);
  await book.flush(); // 40 + 60 lands exactly ON the cap

  expect((await readdir(dir)).sort(),
    "a file sitting exactly ON its cap was rotated. Nothing has overflowed yet, so a whole " +
    "generation of history was discarded for no reason at all.").toEqual(["bnd.log"]);
  expect((await stat(book.path)).size,
    "the boundary case is only a boundary case if the file really is at the cap; fix the " +
    "arithmetic in this test before trusting its verdict.").toBe(CAP);

  book.raw(LINE);
  await book.flush();

  expect((await readdir(dir)).sort(),
    "one byte past the cap did not rotate, so the file is now over its limit and the only " +
    "bound this design has is gone.").toEqual(["bnd.log", "bnd.log.1"]);
  expect((await stat(join(dir, "bnd.log.1"))).size).toBe(CAP);
  expect(await linesOf(book.path),
    "the line that triggered the rotation went into the generation being retired instead of " +
    "the fresh file, so the newest event is the hardest one to find.").toEqual([LINE]);
});

test("the log directory is created on first write, owner only", async () => {
  /* First boot on a new machine, and every `rm -rf .run`. The directory is made
   * inside the flush rather than at openLog, so a service that never logs never
   * creates it; a missing parent must not turn into a lost log. 0700 because
   * these lines carry capture ids, filenames and transcript fragments, and the
   * umask on these hosts is 0002 (SECURITY-REVIEW #10). */
  const root = await tmpDir("cyc-logbook-");
  const dir = join(root, "logs", "engine");
  const book = openLog("new", { dir, clock: manualClock(), flushMs: 200 });

  book.line("boot");
  await book.flush();

  expect(await linesOf(book.path),
    "the log directory did not exist and the line was dropped instead of the directory " +
    "being made. That is the first line of the first boot, which is the one nobody can " +
    "reconstruct afterwards.").toHaveLength(1);
  expect((await stat(dir)).mode & 0o777,
    "a log directory left group-readable. It holds capture ids, filenames and transcript " +
    "fragments for every service.").toBe(0o700);
  expect((await stat(book.path)).mode & 0o777,
    "the log file itself is not 0600, so the append created it under the 0002 umask and " +
    "nothing put it back.").toBe(0o600);
});

test("a write that cannot land does not become a second failure", async () => {
  /* A logger that can fail a voice note is worse than no logger. The failure
   * mode here is a directory that cannot be created (a file already sits where
   * the parent should be, which is what a half-restored .run looks like); a full
   * disk and a read-only mount arrive at the same catch. flush() must resolve,
   * the queue must not spin, and the console mirror is what is left. */
  const root = await tmpDir("cyc-logbook-");
  const blocker = join(root, "blocker");
  await writeFile(blocker, "not a directory");
  const dir = join(blocker, "logs");
  mirror = [];
  const book = openLog("dead", { dir, clock: manualClock(), flushMs: 200 });

  book.line("probe", { cid: "c-1" });
  await expect(book.flush(),
    "flush() rejected on an unwritable directory. Nothing awaits the logger, so this " +
    "surfaces as an unhandled rejection far away from the line that caused it.")
    .resolves.toBeUndefined();

  expect(await Bun.file(book.path).exists()).toBe(false);
  expect(mirror.some((l) => l.includes("dead probe cid=c-1")),
    "the disk write failed AND the line never reached stdout, so the event left no trace " +
    "anywhere. The mirror is the copy that is supposed to survive a full disk.").toBe(true);

  // and it does not wedge: the next line still goes through the same path
  book.line("probe", { cid: "c-2" });
  await expect(book.flush()).resolves.toBeUndefined();
  expect(mirror.filter((l) => l.includes("dead probe")).length).toBe(2);
});

/* ------------------------------------------------------------------ *
 * LINE SAFETY                                                         *
 * ------------------------------------------------------------------ */

test("a value that could break a line, or hide inside one, is made safe", async () => {
  const { book } = await freshLog("safe");
  book.line("probe", {
    /* A newline in a field would end the record early and put the rest on a
     * line of its own, where it reads as a second event. Every field here is
     * attacker-adjacent: transcripts, filenames, error messages. */
    text: "first\nsecond\rthird\tfourth",
    huge: "y".repeat(5000),
    nothing: undefined,
    nul: null,
  });
  await book.flush();

  const lines = await linesOf(book.path);
  expect(lines.length,
    "one event became more than one line, so a log reader counting events would count " +
    "wrong and a grep would show half a record.").toBe(1);
  expect(lines[0], "a dropped field was written as the word undefined, which is worse than " +
    "silence in a file whose whole purpose is grep").not.toContain("nothing=");
  expect(lines[0]).not.toContain("nul=");
  expect(lines[0].length,
    `one event ran to ${lines[0].length} characters. A single enormous field can push the ` +
    "file to its cap on its own and take the history with it.").toBeLessThan(1200);

  const { f } = parseRecord(lines[0]);
  expect(Object.keys(f).sort(),
    "the record parsed back to fields nobody wrote, so the escaping let a value split into " +
    "pairs of its own.").toEqual(["huge", "text"]);
  expect(f.text,
    "the newline, carriage return and tab were meant to collapse to spaces so the value " +
    "stays one greppable field. It came back as something else.").toBe("first second third fourth");
  expect(f.huge.length,
    `a 5000 character field survived at ${f.huge.length} characters. A log line is a signpost; ` +
    "one field is not allowed to be the whole file.").toBe(401);
  expect(f.huge.endsWith("…"),
    "the value was truncated with no mark, so a reader cannot tell a short value from a cut " +
    "one and will chase the wrong difference.").toBe(true);
});

test("a value cannot forge a second field, quote its way out, or vanish", async () => {
  /* The field separator IS a space, so a value containing one has to be quoted
   * or it becomes extra pairs. `fake` is the attack written out: a transcript
   * fragment or an error message that contains `k=v` and tries to become a
   * field of its own in a file the operator greps by field. */
  const { book } = await freshLog("sep");
  book.line("probe", {
    sep: "a b c",
    fake: "x k2=v2",
    quoted: 'he said "hi"',
    empty: "",
    obj: { a: 1 },
    n: 7,
    yes: false,
  });
  await book.flush();

  const lines = await linesOf(book.path);
  expect(lines).toHaveLength(1);
  const rec = parseRecord(lines[0]);
  expect(rec.service).toBe("sep");
  expect(rec.event).toBe("probe");
  expect(rec.f,
    "the record did not survive a round trip through a reader. An extra key means a value " +
    "forged a field; a missing one means a value swallowed the pairs after it; a changed " +
    "one means the quoting is not reversible and the log lies about what happened.")
    .toEqual({
      sep: "a b c",
      fake: "x k2=v2",
      quoted: 'he said "hi"',
      empty: "",
      obj: '{"a":1}',
      n: "7",
      yes: "false",
    });
  expect(Number.isNaN(Date.parse(rec.stamp)),
    "the leading field is not a timestamp a reader can parse, so `cyclog.sh` cannot order " +
    "two services against each other, which is the only reason the three logs share a format.")
    .toBe(false);
});

test("control bytes cannot forge a line", async () => {
  /* Everything below arrives from outside: a filename, a transcript, an error
   * message from a tool. The contract is narrow, so it is worth stating exactly.
   * A value may not end the record, and it may not break the k=v shape. Anything
   * carrying whitespace or a quote is JSON-quoted, which also escapes the
   * vertical tab, the form feed and the U+2028 line separator.
   *
   * A raw ESC or NUL still goes through. Neither can end a record or split a
   * pair, so both are outside the bound this file defends, and they are pinned
   * here as CURRENT behaviour rather than as something anyone wanted: an
   * operator who cats this file hands the ESC straight to their terminal.
   * Written with fromCharCode so the bytes under test are visible in the source
   * rather than being invisible characters an editor might eat. */
  const ESC = String.fromCharCode(0x1b);
  const NUL = String.fromCharCode(0x00);
  const VTAB = String.fromCharCode(0x0b);
  const FEED = String.fromCharCode(0x0c);
  const LSEP = String.fromCharCode(0x2028);

  const { book } = await freshLog("ctl");
  book.line("probe", {
    esc: `${ESC}[31mRED${ESC}[0m`,
    zero: `a${NUL}b`,
    vtab: `a${VTAB}b`,
    feed: `a${FEED}b`,
    lsep: `a${LSEP}b`,
    crlf: "a\r\nb",
  });
  await book.flush();

  const lines = await linesOf(book.path);
  expect(lines.length,
    "a control byte ended the record and the remainder became a line of its own, which is " +
    "one caller-supplied string inventing an event that never happened.").toBe(1);
  expect(parseRecord(lines[0]).f,
    "a control byte broke the k=v shape: the record no longer reads back as the fields it " +
    "was written with, so a reader either loses a field or invents one.").toEqual({
    esc: `${ESC}[31mRED${ESC}[0m`,
    zero: `a${NUL}b`,
    vtab: `a${VTAB}b`,
    feed: `a${FEED}b`,
    lsep: `a${LSEP}b`,
    crlf: "a b",
  });
});

test("a pre-stamped line is written through, but still cannot forge a record", async () => {
  /* raw() is for the browser's lines, which arrive at /clientlog already stamped
   * in the BROWSER. Re-stamping here would record when the batch arrived rather
   * than when the event happened, and the gap between those two is exactly what
   * a "did it happen before I navigated away" question turns on. So the body is
   * trusted. The line boundary is not: /clientlog is reachable by anything that
   * can talk to the engine, and a newline there would let a caller write records
   * with any service name and any timestamp it likes. */
  const { book } = await freshLog("raw");
  book.raw("2026-01-01T00:00:00.000Z app client.tick cid=c-9");
  book.raw("2026-01-01T00:00:01.000Z app client.tick\n2026-01-01T00:00:02.000Z engine forged");
  await book.flush();

  const lines = await linesOf(book.path);
  expect(lines.length,
    "a caller-supplied newline became a second record. Anything that can reach /clientlog " +
    "could then write lines under the engine's own name.").toBe(2);
  expect(lines[0],
    "raw() re-stamped or reshaped a line that was already stamped in the browser, so the " +
    "log now says when the batch arrived instead of when the event happened.")
    .toBe("2026-01-01T00:00:00.000Z app client.tick cid=c-9");
  expect(lines[1]).toBe(
    "2026-01-01T00:00:01.000Z app client.tick 2026-01-01T00:00:02.000Z engine forged");
});

/* ------------------------------------------------------------------ *
 * THE MEMORY BOUND                                                    *
 * ------------------------------------------------------------------ */

test("a queue that cannot drain drops the oldest and says how many", async () => {
  /* The memory half of the bound. The disk cap does nothing if a service that
   * cannot write simply accumulates lines in a growing array; the queue has its
   * own cap and it announces what it lost, so a gap in the log is visible as a
   * gap rather than as a quiet absence.
   *
   * The manual clock is what makes this deterministic. The old version set
   * CYC_LOG_FLUSH_MS to sixty seconds to be sure nothing flushed mid-burst, and
   * then left it set for every engine the rest of the suite started. Here the
   * timer simply never fires because nothing advances the clock. */
  const { book } = await freshLog("q", { queueMax: 50 });

  for (let i = 0; i < 500; i++) book.line("probe", { i });
  await book.flush();

  const lines = await linesOf(book.path);
  expect(lines.length,
    `${lines.length} lines came out of a queue capped at 50 plus its own notice. The cap ` +
    "is what stops a stalled disk turning into unbounded memory.").toBeLessThanOrEqual(51);

  const notices = lines.filter((l) => l.includes("log.dropped"));
  expect(notices.length,
    "lines were dropped and the file does not say so. A silent gap in a log is the same " +
    `failure the log exists to fix.\n${lines.slice(0, 3).join("\n")}`).toBe(1);

  /* The COUNT, not just the notice. 500 written, 50 survived, so 450 went. A
   * notice that says the wrong number is worse than none: it tells whoever is
   * reading that they have the whole story minus n, and they believe it. */
  const drop = parseRecord(notices[0]);
  expect(drop.event).toBe("log.dropped");
  expect(drop.f,
    "the drop notice does not account for the lines that actually went missing. 500 were " +
    "written into a queue of 50, so 450 were dropped and the notice has to say 450.")
    .toEqual({ n: "450", why: "queue-full", cap: "50" });

  /* And it is the OLDEST that went. Checking only that the LAST line is i=499
   * is not enough to prove that: a queue that evicted the newest on every
   * overflow would still end with i=499 sitting on top of a window of ancient
   * lines, and the notice would still say 450. The survivors have to be the
   * contiguous newest run, because the lines worth keeping are the ones next to
   * whatever went wrong. */
  const survivors = lines.filter((l) => !l.includes("log.dropped"))
    .map((l) => Number(parseRecord(l).f.i));
  expect(survivors,
    "the surviving window is not the newest 50 lines. Whatever was evicted, it was not the " +
    "oldest, so the moments closest to the failure are the ones missing.")
    .toEqual(Array.from({ length: 50 }, (_, k) => 450 + k));
  expect(lines[0],
    "the notice is not the first thing in the batch, so a reader scanning down the file " +
    "meets the surviving lines before being told anything is missing.").toContain("log.dropped");
});

test("a queue that overflowed and then drains stops apologising", async () => {
  /* The other half of the drop counter: it resets. A counter that kept its total
   * would put a log.dropped line at the head of every flush for the rest of the
   * process, which reads as an ongoing loss long after the disk came back and
   * would send someone looking for a fault that has already healed. */
  const { book } = await freshLog("drain", { queueMax: 10 });

  for (let i = 0; i < 100; i++) book.line("probe", { i });
  await book.flush();
  const afterBurst = await linesOf(book.path);
  expect(afterBurst).toHaveLength(11); // 10 survivors plus the notice

  book.line("probe", { i: 100 });
  book.line("probe", { i: 101 });
  await book.flush();

  const lines = await linesOf(book.path);
  expect(lines).toHaveLength(13);
  expect(lines.filter((l) => l.includes("log.dropped")).length,
    "a second drop notice was written for a flush that dropped nothing. The counter did not " +
    "reset, so the log reports a loss that already stopped.").toBe(1);
  expect(lines.filter((l) => !l.includes("log.dropped")).map((l) => Number(parseRecord(l).f.i)),
    "the file is not the newest ten of the burst followed by the two that drained after it. " +
    "Either the wrong end of the queue was evicted or the file is out of write order, and " +
    "either way a reader cannot trust the sequence.")
    .toEqual([90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101]);
});

/* ------------------------------------------------------------------ *
 * THE TIMER, AND THE BOOK ITSELF                                      *
 * ------------------------------------------------------------------ */

test("a line reaches disk on the flush timer with nobody calling flush", async () => {
  /* Nothing on the hot path awaits the logger, so every line in production
   * reaches disk on this timer and on nothing else. If it never armed, an idle
   * service would hold its last words in memory until it died, which is the one
   * moment the log is read. Logical time only: advance() fires it, and then
   * until() waits for the real file write it kicked off. */
  const { book, clock } = await freshLog("tmr", { flushMs: 200 });

  book.line("tick", { i: 1 });
  expect(await Bun.file(book.path).exists(),
    "the line went to disk before its flush window, which means one syscall per line " +
    "instead of one per busy second.").toBe(false);
  expect(clock.pending,
    "no timer was armed for a queued line, so it will sit in memory until something else " +
    "happens to flush.").toBe(1);

  await clock.advance(200);
  await until(async () => (await linesOf(book.path)).length === 1,
    { what: "the flush timer to put the queued line on disk" });

  expect(clock.pending,
    "the one-shot timer re-armed itself with an empty queue, so an idle service keeps a " +
    "timer alive forever.").toBe(0);

  book.line("tick", { i: 2 });
  expect(clock.pending,
    "the next line after a flush did not arm a new timer, so everything written from here " +
    "on waits for someone to call flush() by hand.").toBe(1);
  await clock.advance(200);
  await until(async () => (await linesOf(book.path)).length === 2,
    { what: "the second line to land after the timer re-armed" });
});

test("the same service name gives back the same book", async () => {
  /* Idempotent on purpose: openLog is called from wherever a line is needed, not
   * once at boot. Two books for one service would be two queues, two flush
   * timers and two appenders racing on one path, each with its own idea of how
   * many bytes are in the file, which is how a rotation loses a generation. */
  const a = await tmpDir("cyc-logbook-");
  const b = await tmpDir("cyc-logbook-");
  const first = openLog("dup", { dir: a, clock: manualClock() });
  const second = openLog("dup", { dir: b, clock: manualClock() });

  expect(second,
    "a second openLog for one service handed back a second book, so two queues and two " +
    "flush timers now append to one file.").toBe(first);
  expect(second.path,
    "the second call's options won, which means whichever call site happens to run first " +
    "decides where a service's log lives.").toBe(join(a, "dup.log"));
});

/* ------------------------------------------------------------------ *
 * CORRELATION IDS                                                     *
 * ------------------------------------------------------------------ */

test("a cid off the wire is restricted to the alphabet the minters use", async () => {
  /* safeCid guards attacker-controlled text on its way into a file the operator
   * reads and greps. Anything outside the minted alphabet becomes "" and the
   * call site falls back to its own id, so a hostile cid costs one hop of
   * correlation rather than a forged line or an unusable grep. */
  expect(safeCid(newCid()),
    "the minter produces ids its own guard rejects, so every server-side line would fall " +
    "back and no two hops would share a cid.").not.toBe("");
  expect(safeCid("c-abc_1.2-Z")).toBe("c-abc_1.2-Z");

  for (const bad of ["a b", "a\nb", 'a"b', "a=b", "a/b", "", "x".repeat(65), 42, null, undefined]) {
    expect(safeCid(bad), `safeCid let ${JSON.stringify(bad)} through into a log line`).toBe("");
  }
});
