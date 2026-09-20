/* What stops journey.ts from telling a story it cannot support.
 *
 * The tool's whole value is the two things it says that a grep cannot: THIS id
 * and THAT id are the same message, and this hop has no line. Both are easy to
 * get quietly wrong -- a join on a coincidence reads exactly like a join on a
 * fact, and a hop dropped from the output reads exactly like a hop that never
 * happened. So the mutation here is the important one: take a real line out of
 * a complete journey and the report must SAY the hop is missing, in the place
 * where it should have been, rather than printing one line fewer.
 *
 *   bun test agent-engine/src/sessions/journey.test.ts
 */

import { test, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSources, resolve, render, measureSkew, parseAt, parseLine, parseFields,
  sameHost, localEngineHost, candidates } from "./journey.ts";
import { tmpDir } from "../test-utils/tmp.ts";

const CAP = "c-demo12345-abcd";
const UP = "aaaa1111-2222-4333-8444-555566667777";
const WIRE = "bbbb1111-2222-4333-8444-555566667777";

/* One send of a recording held as a block in the composer, which is the path
 * with the most id changes in it: the capture id never reaches the engine, the
 * upload id is minted there, and the wire cid is minted at the press. */
const APP = [
  `2026-08-05T18:55:10.868Z app capture.start dev=e9xw6 pg=uqx7b cid=${CAP} capture=4 session=(press) handsFree=false liveCaption=true`,
  `2026-08-05T18:55:13.061Z app capture.released dev=e9xw6 pg=uqx7b cid=${CAP} capture=4 heldMs=2193 wasPlaying=false`,
  `2026-08-05T18:55:13.664Z app capture.clip dev=e9xw6 pg=uqx7b cid=${CAP} capture=4 bytes=76194 durationS=3`,
  `2026-08-05T18:55:13.676Z app clip.held dev=e9xw6 pg=uqx7b cid=${CAP} capture=4 bytes=76194 durationS=3 why="released into the composer as a block"`,
  `2026-08-05T18:55:13.677Z app stt.batch.start dev=e9xw6 pg=uqx7b bytes=76194 mime=audio/webm;codecs=opus voice=https://macbook-air.tail0a1b2c.ts.net:8445/stt`,
  `2026-08-05T18:55:14.119Z app send.words-deferred dev=e9xw6 pg=uqx7b session=wss://macbook-air.tail0a1b2c.ts.net:8444/ws|w9:p4 uploads=${UP} chars=18 wireChars=50`,
  `2026-08-05T18:55:14.136Z app send.utterance dev=e9xw6 pg=uqx7b cid=${WIRE} session=w9:p4 kind=text chars=50 socket=open queuedBehind=0`,
  `2026-08-05T18:55:14.328Z app capture.verdict dev=e9xw6 pg=uqx7b cid=${CAP} capture=4 durationS=3 kept=true chars=30 heard="The save button looks cut off."`,
  `2026-08-05T18:55:14.897Z app stt.batch.done dev=e9xw6 pg=uqx7b bytes=76194 chars=30 ms=1220`,
];

const ENGINE = [
  `2026-08-05T18:55:03.750Z engine attach client=c21 session=w9:p4 known=true since=1785955941595 logged=3954`,
  `[notify] present macbook-air:w9:p4 msg=6d8ed221 chars=684 why=no client attached (clients=2)`,
  `2026-08-05T18:55:14.279Z engine utterance.in cid=${WIRE} session=w9:p4 kind=text chars=50 upload=${UP} known=true rescuable=false`,
  `2026-08-05T18:55:14.289Z engine words.start cid=${WIRE} upload=${UP} bytes=76194 mime=audio/webm;codecs=opus`,
  `2026-08-05T18:55:15.513Z engine words.done cid=${WIRE} upload=${UP} chars=30 text="The save button looks cut off."`,
  `2026-08-05T18:55:15.515Z engine words.filled cid=${WIRE} session=w9:p4 asked=${UP} filled=${UP} chars=30 was=50`,
  `2026-08-05T18:55:15.515Z engine utterance.accepted cid=${WIRE} session=w9:p4 kind=text chars=30 upload=${UP} herdr=true alive=true`,
  `2026-08-05T18:55:15.772Z engine utterance.delivered cid=${WIRE} session=w9:p4 ts=1785956115772 queued=true chars=30 how=TEXT`,
  `[utterance] w9:p4 <- The save button looks cut off.`,
  `2026-08-05T18:55:31.410Z engine attach client=c21 session=(none) known=false why="the client detached from every chat"`,
];

/* ONE temp dir for the file, at module scope, with a fresh checkout-shaped
 * subdirectory per call. tmp.ts registers its cleanup with afterAll on first
 * use, and bun runs a hook registered from inside a running hook the moment
 * that hook returns, so the first call cannot come from a beforeEach. */
const scratch = tmpDir("cyc-journey-");
let nth = 0;

/** A checkout-shaped directory holding whatever logs a test wants. */
async function logs(files: { app?: string[]; engine?: string[]; mirror?: string[] }) {
  const dir = join(await scratch, `t${nth++}`);
  await mkdir(join(dir, ".run", "logs"), { recursive: true });
  if (files.app) await writeFile(join(dir, ".run", "frontend.log"), files.app.join("\n") + "\n");
  if (files.engine) await writeFile(join(dir, ".run", "engine.log"), files.engine.join("\n") + "\n");
  if (files.mirror) await writeFile(join(dir, ".run", "logs", "engine.log"), files.mirror.join("\n") + "\n");
  return dir;
}

const run = (root: string, seed: string) => {
  const all = loadSources(root);
  const id = resolve(all.events, [seed]);
  return { all, id, rep: render(all, id, seed) };
};

test("one capture id reaches the engine's own lines, across three id spaces", async () => {
  const root = await logs({ app: APP, engine: ENGINE });
  const { id, rep } = run(root, CAP);

  expect([...id.uploads],
    "the upload id was never found from the capture id. Nothing logs POST /upload at either " +
    "end, so the only bridge is the byte count on capture.clip and words.start; if that is " +
    "gone the tool can only ever show the browser's half of a held recording.").toContain(UP);
  expect([...id.cids],
    "the wire cid was never found, so no engine line could be attached to this recording.")
    .toContain(WIRE);

  const found = (k: string) => rep.hops.find((h) => h.key === k)!;
  for (const k of ["record", "clip", "heard", "gate", "wire", "in", "words", "accept", "deliver"]) {
    expect(found(k).found, `hop "${k}" found nothing in a journey where every line is present`)
      .toBeGreaterThan(0);
  }
  // and the guessed joins are labelled as guesses, wherever they were used
  expect(id.joins.some((j) => !j.exact && j.evidence.includes("76194")),
    "the byte bridge was used but not marked as a guess").toBe(true);
  expect(rep.text).toContain("GUESS");
});

test("a hop whose line is gone is reported as missing, not skipped", async () => {
  /* THE MUTATION. One line -- the engine typing the message into the pane --
   * removed from an otherwise complete journey. Everything else about the
   * message still exists, so a tool that prints only what it found would show a
   * clean, plausible, WRONG story that ends at "accepted". */
  const whole = await logs({ app: APP, engine: ENGINE });
  const before = run(whole, CAP).rep;

  const holed = await logs({
    app: APP,
    engine: ENGINE.filter((l) => !l.includes("utterance.delivered")),
  });
  const after = run(holed, CAP).rep;

  expect(after.hops.length,
    "the hop disappeared from the report along with its line. A journey must always have the " +
    "same hops; only their contents change, or the reader has no way to see what is not there.")
    .toBe(before.hops.length);

  const deliver = after.hops.find((h) => h.key === "deliver")!;
  expect(deliver.missing, "the delivery hop was not marked missing").toBe(true);
  expect(deliver.reason,
    "the engine log covers that minute in this fixture, so the absence is an absence and must " +
    "be reported as one rather than as an unreachable log").toBe("absent");
  expect(after.text).toContain("it was typed into the pane");
  expect(after.text).toContain("MISSING");
  expect(after.text.split("where the trail goes cold")[1],
    "the missing hop is not named in the summary a reader actually reads")
    .toContain("it was typed into the pane");

  // and the mutation really did land: the whole run does NOT say it is missing
  expect(before.hops.find((h) => h.key === "deliver")!.missing,
    "the mutation proved nothing: the unmutated journey reports the same hop missing").toBe(false);
});

test("an engine on another host is unanswerable here, not an absence", async () => {
  /* His fleet is three engines on two hosts with one app open across them, so
   * "the engine has no line for this message" is a claim about whichever engine
   * happens to log HERE. Said about a message linux answered, it is a lie with
   * a timestamp on it. */
  const app = APP.map((l) => l.replace("macbook-air.tail0a1b2c.ts.net:8444/ws|w9:p4",
    "linux.tail0a1b2c.ts.net:8444/ws|w9:p4"));
  const root = await logs({
    app,
    // the local engine is still busy, and it is not the one that answered
    engine: ENGINE.filter((l) => !l.includes(WIRE) && !l.includes(UP)),
  });
  const { rep } = run(root, CAP);
  const inHop = rep.hops.find((h) => h.key === "in")!;
  expect(inHop.reason,
    "an engine hop for a message another host answered was reported as an absence, which is " +
    "the app asserting what it does not know").toBe("unreachable");
  expect(rep.text).toContain("linux.tail0a1b2c.ts.net:8444");
  expect(rep.text).toContain("NOT this machine");
});

test("the hop nothing writes down says so, instead of reading as a loss", async () => {
  const root = await logs({ app: APP, engine: ENGINE });
  const { rep } = run(root, CAP);
  const upload = rep.hops.find((h) => h.key === "upload")!;
  expect(upload.reason,
    "the block upload has no line at either end, and that is a fact about the code, not about " +
    "this message").toBe("unlogged");
  expect(rep.text).toContain("nothing would have written it");
  expect(rep.text).toContain("/upload");
});

test("the clock offset between the phone and the engine is measured, not assumed", async () => {
  /* The browser stamps its own lines. Here its clock is 1.000s ahead, and the
   * upload's round trip brackets it from both sides. */
  const cid = "c-skew-1";
  const app = [
    `2026-08-05T12:00:01.000Z app upload.start dev=e9xw6 pg=uqx7b cid=${cid} bytes=10 mime=audio/webm engine=https://macbook-air.tail0a1b2c.ts.net:8444`,
    `2026-08-05T12:00:01.300Z app upload.done dev=e9xw6 pg=uqx7b cid=${cid} msgId=${UP} bytes=10 ms=300`,
  ];
  const engine = [`2026-08-05T12:00:00.150Z engine user-audio.stored cid=${cid} msgId=${UP} bytes=10 mime=audio/webm`];
  const root = await logs({ app, engine });
  const all = loadSources(root);
  const skew = measureSkew(all.events, "e9xw6", Date.parse("2026-08-05T12:00:01.000Z"));
  expect(skew, "no offset was measured from an upload seen from both sides").not.toBeNull();
  // start-stored = +0.850s, done-stored = +1.150s, so the bracket's middle is +1.000s
  expect(skew!.lo).toBeGreaterThan(900);
  expect(skew!.hi).toBeLessThan(1100);
  expect(render(all, resolve(all.events, [cid]), cid).text).toContain("ahead of the engine host's");
});

test("a line in both the stdout log and the mirror is one line, not two", async () => {
  /* The logbook console.logs the same string it queues, and an engine started
   * from a worktree mirrors somewhere else entirely, so both files have to be
   * read and the overlap has to go. */
  const root = await logs({ engine: ENGINE, mirror: ENGINE });
  const all = loadSources(root);
  const delivered = all.events.filter((e) => e.event === "utterance.delivered");
  expect(delivered.length, "the same delivery was counted twice").toBe(1);
});

test("an id nothing carries says so, and names what it read", async () => {
  const root = await logs({ app: APP, engine: ENGINE });
  const { rep } = run(root, "c-not-a-real-id");
  expect(rep.text).toContain("Nothing anywhere carries that id");
  expect(rep.text).toContain(".run/engine.log");
  expect(rep.hops.length, "a journey with no lines must not invent hops").toBe(0);
});

test("a log the tool cannot read is named as read, not silently skipped", async () => {
  /* The report ends with which files it read and how many lines it used. A run
   * against the wrong --root otherwise reads as "this message does not exist"
   * when the truth is "I read nothing". */
  const root = await logs({ app: APP, engine: ENGINE });
  const all = loadSources(root);
  const paths = all.files.map((f) => f.path).sort();
  expect(paths).toEqual([".run/engine.log", ".run/frontend.log"]);
  expect(all.files.every((f) => f.used > 0)).toBe(true);
  // the two bracket prints in ENGINE have no timestamp and are kept as notes
  expect(all.notes.map((n) => n.text.slice(0, 11)))
    .toEqual(["[notify] pr", "[utterance]"]);
  expect(all.notes[0].after, "a bracket line is pinned after the last timestamped one")
    .toBe(Date.parse("2026-08-05T18:55:03.750Z"));
});

test("a root with no logs in it at all is empty, not a crash", () => {
  const all = loadSources("/nonexistent-root-for-this-test");
  expect(all).toEqual({ events: [], notes: [], files: [] });
});

test("events come back in time order however the files were read", async () => {
  /* The app's file and the engine's are read one after the other, and the story
   * only reads as a story if the two are interleaved by their stamps. */
  const root = await logs({ app: APP, engine: ENGINE });
  const { events } = loadSources(root);
  for (let i = 1; i < events.length; i++) {
    expect(events[i].ts >= events[i - 1].ts, "the merged log is not in time order").toBe(true);
  }
  expect(events.some((e) => e.service === "app")).toBe(true);
  expect(events.some((e) => e.service === "engine")).toBe(true);
});

test("a bare time is read as today in UTC, which is what the log is written in", () => {
  const now = new Date("2026-08-05T21:00:00Z");
  expect(parseAt("18:55", now)).toBe(Date.parse("2026-08-05T18:55:00Z"));
  expect(parseAt("2026-08-04T10:00:00", now)).toBe(Date.parse("2026-08-04T10:00:00Z"));
  expect(Number.isNaN(parseAt("banana", now))).toBe(true);
  expect(Number.isNaN(parseAt("", now))).toBe(true);
});

test("a quoted field with spaces in it stays one field", () => {
  const e = parseLine(
    `2026-08-05T18:55:13.676Z app clip.held cid=c-1 why="released into the composer as a block" bytes=7`,
    "x.log", 1)!;
  expect(e.f.why).toBe("released into the composer as a block");
  expect(e.f.bytes).toBe("7");
});

test("a line that is not a log line is not an event", () => {
  /* Everything the tool says rests on the parse. A line it half-understands
   * would join a message to a coincidence. */
  expect(parseLine("", "x.log", 1)).toBeNull();
  expect(parseLine("[notify] present macbook-air:w9:p4 msg=6d8ed221", "x.log", 1)).toBeNull();
  expect(parseLine("2026-08-05 18:55:13 app clip.held", "x.log", 1), "no T, no Z").toBeNull();
  expect(parseLine("2026-08-05T18:55:13.676Z app", "x.log", 1), "no event name").toBeNull();
  const bare = parseLine("2026-08-05T18:55:13.676Z app clip.held", "x.log", 7)!;
  expect(bare.event).toBe("clip.held");
  expect(bare.f).toEqual({});
  expect([bare.file, bare.line]).toEqual(["x.log", 7]);
});

test("the FIRST spelling of a repeated key wins, so a quoted why cannot shadow one", () => {
  /* `why="... bytes=3 ..."` puts a second `bytes=` inside a quoted sentence.
   * Last-wins would make the report quote the prose as the byte count, which is
   * exactly the kind of confident wrong number this tool must not print. */
  const f = parseFields('cid=c-1 bytes=76194 why="held because bytes=3 looked wrong"');
  expect(f.bytes).toBe("76194");
  expect(f.why).toBe("held because bytes=3 looked wrong");
});

test("a field with an escaped quote in it survives the unquoting", () => {
  const f = parseFields('text="The save \\"button\\" looks cut off." chars=30');
  expect(f.text).toBe('The save "button" looks cut off.');
  expect(f.chars).toBe("30");
});

test("hosts written short and fully qualified are the same host", () => {
  /* The engine prints `macbook-air`; the app prints the socket URL. Comparing
   * them as strings would report every message as answered elsewhere. */
  expect(sameHost("macbook-air", "macbook-air.tail0a1b2c.ts.net:8444")).toBe(true);
  expect(sameHost("MacBook-Air", "macbook-air.tail0a1b2c.ts.net")).toBe(true);
  expect(sameHost("macbook-air", "linux.tail0a1b2c.ts.net:8444")).toBe(false);
  expect(sameHost("macbook-air:8444", "macbook-air:8445"),
    "two engines on one box are one HOST, which is what this asks").toBe(true);
});

test("the local engine's own host is read from its prints, by majority", () => {
  const notes = [
    { after: 0, service: "engine", text: "[notify] present macbook-air:w9:p4 msg=1", file: "e.log", line: 1 },
    { after: 0, service: "engine", text: "[notify] present macbook-air:w7:p2 msg=2", file: "e.log", line: 2 },
    { after: 0, service: "engine", text: "[utterance] w9:p4 <- hello", file: "e.log", line: 3 },
  ];
  expect(localEngineHost(notes)).toBe("macbook-air");
  expect(localEngineHost([]), "no prints means no claim about the host").toBeNull();
});

test("candidates offers what else was in the same session at that instant", () => {
  /* The fallback when nothing carries the id he typed: here is what the session
   * WAS doing then, so he can pick the right one rather than be told nothing. */
  const at = Date.parse("2026-08-05T18:55:14.136Z");
  const events = loadSourcesOf(APP.concat(ENGINE));
  const near = candidates(events, "w9:p4", at, 5_000);
  expect(near.length).toBeGreaterThan(0);
  expect(near.every((e) => Math.abs(e.ts - at) <= 5_000)).toBe(true);
  expect(candidates(events, "w9:p4", at, 1), "a one-millisecond window holds almost nothing")
    .not.toEqual(near);
  expect(candidates(events, "no-such-session", at, 5_000)).toEqual([]);
});

/** Parse a pile of raw lines into events, without going near a directory. */
function loadSourcesOf(lines: string[]) {
  return lines.map((l, i) => parseLine(l, "x.log", i + 1)).filter((e): e is NonNullable<typeof e> => !!e);
}
