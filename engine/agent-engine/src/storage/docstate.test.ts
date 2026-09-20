/* WHAT A SHOWN PAGE SAVED, on the engine that owns the page.
 *
 * The defect this exists for is one he hit himself: he spent an afternoon
 * reordering and annotating a page `show` had pushed, the app reloaded, and all
 * of it was gone. A shown page had no way to keep anything -- the sandbox denies
 * it localStorage and IndexedDB on purpose, and re-opening a card starts the
 * document over from the top.
 *
 * These run against a REAL DIRECTORY under the OS temp dir, never .run, so
 * nothing here can touch a document or a saved state of his. Every test writes
 * and reads through the same two functions the HTTP routes call, so a pass here
 * is a pass for the route.
 *
 * WHAT IS DELIBERATELY ASSERTED, and why each one is a behaviour rather than a
 * shape:
 *
 *   - the round trip, because it is the feature;
 *   - that a save REPLACES rather than appends, because one record per document
 *     is what makes this bounded without an eviction policy;
 *   - that "nothing saved yet" and "could not answer" are different answers,
 *     because a page that cannot tell them apart autosaves over his work;
 *   - that a docId with no document behind it is refused, because otherwise this
 *     is an unbounded key-value store keyed by a made-up UUID;
 *   - that the cap refuses rather than truncates, and says so.
 *
 *   bun test agent-engine/src/storage/docstate.test.ts
 */

import { test, expect, beforeEach } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  readState, writeState, statePath, docPath, stateTooLargeMessage,
  DOC_STATE_MAX_BYTES,
} from "./docstate.ts";
import { tmpDir } from "../test-utils/tmp.ts";

let root = "";
let docDir = "";
let stateDir = "";

/* ONE temp dir for the file, at module scope, with a fresh SUBDIRECTORY per
 * test inside it. Two reasons for that shape rather than a tmpDir() per test:
 * tmp.ts registers its cleanup with afterAll on first use and bun runs a hook
 * registered from inside a running hook the moment that hook returns (so the
 * first call must not be made from within beforeEach), and directories made
 * with node's mkdir cost nothing, whereas the `mkdir -p` this used to shell out
 * to was a spawned process per test in a tier that is not allowed one. */
const scratch = tmpDir("cyc-docstate-");
let nth = 0;

beforeEach(async () => {
  root = join(await scratch, `t${nth++}`);
  docDir = `${root}/docs/`;
  stateDir = `${root}/docstate/`;
  await mkdir(docDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
});

const exists = (p: string) => Bun.file(p).exists();
const readJson = (p: string) => Bun.file(p).json().catch(() => null);
const write = async (p: string, text: string) => { await Bun.write(p, text); };

/** A document `show` pushed, so there is something for a state to belong to. */
async function showADocument(docId: string): Promise<void> {
  await Bun.write(docPath(docDir, docId),
    JSON.stringify({ name: "plan.html", fileKind: "html", content: "<p>plan</p>" }));
}

const save = (docId: string, body: string, now = Date.now()) =>
  writeState(docDir, stateDir, docId, body, exists, write, now);
const load = (docId: string) => readState(docDir, stateDir, docId, exists, readJson);

const DOC = "11111111-2222-3333-4444-555555555555";

// ------------------------------------------------------------ the round trip

/* THE FEATURE. He reorders and annotates, the app reloads, the page opens again
 * and asks the engine what it had. */
test("what a page saved is what the next open gets back", async () => {
  await showADocument(DOC);

  const annotated = {
    order: ["auth", "billing", "search"],
    notes: { billing: "ask finance about the proration case" },
  };
  const wrote = await save(DOC, JSON.stringify(annotated), 1_700_000_000_000);
  expect(wrote.ok, `the save was refused: ${JSON.stringify(wrote)}`).toBe(true);

  const got = await load(DOC);
  expect(got.ok).toBe(true);
  expect(got).toMatchObject({ saved: true, savedAt: 1_700_000_000_000 });
  expect((got as { data: unknown }).data).toEqual(annotated);
});

/* THE SAME DOCUMENT ON A SECOND DEVICE. There is nothing device-shaped anywhere
 * in the key, which is the whole reason this is on the engine and not in the
 * browser: the phone and the tablet ask the same engine for the same docId and
 * get the same answer. A read is a read; this test is what says so out loud. */
test("a second device reading the same docId gets what the first one saved", async () => {
  await showADocument(DOC);
  await save(DOC, JSON.stringify({ from: "the tablet" }));

  const onThePhone = await load(DOC);
  expect((onThePhone as { data: unknown }).data,
    "the phone did not see what the tablet saved, so this is not shared state")
    .toEqual({ from: "the tablet" });
});

/* ONE RECORD PER DOCUMENT, OVERWRITTEN. This is what bounds the store without an
 * eviction policy, and it is why there is no count cap: the hundredth save costs
 * exactly what the first did. */
test("saving again replaces, so a page cannot accumulate", async () => {
  await showADocument(DOC);
  for (let i = 0; i < 5; i++) await save(DOC, JSON.stringify({ round: i }));

  const got = await load(DOC);
  expect((got as { data: unknown }).data).toEqual({ round: 4 });

  const onDisk = await Bun.file(statePath(stateDir, DOC)).text();
  expect(JSON.parse(onDisk).data).toEqual({ round: 4 });
  const files = await Array.fromAsync(new Bun.Glob("*.json").scan(stateDir));
  expect(files, "five saves left more than one file behind").toEqual([`${DOC}.json`]);
});

/* Two documents do not see each other. The docId is the key precisely so a page
 * cannot read or clobber another page's data by guessing a name. */
test("two shown pages have separate state", async () => {
  const other = "99999999-8888-7777-6666-555555555555";
  await showADocument(DOC);
  await showADocument(other);
  await save(DOC, JSON.stringify({ page: "one" }));
  await save(other, JSON.stringify({ page: "two" }));

  expect((await load(DOC) as { data: unknown }).data).toEqual({ page: "one" });
  expect((await load(other) as { data: unknown }).data).toEqual({ page: "two" });
});

// ---------------------------------------- nothing saved is not "cannot answer"

/* THE DEFECT CLASS THIS PRODUCT KEEPS HITTING: the app asserting what it does
 * not know. A page that reads "no state" out of a failure and then autosaves has
 * just replaced his afternoon with an empty document. So the two are different
 * answers and a page can tell them apart without parsing a sentence. */
test("a document that has never been saved to answers saved:false, not an error", async () => {
  await showADocument(DOC);
  const got = await load(DOC);
  expect(got).toEqual({ ok: true, saved: false, data: null });
});

test("a state file that will not parse is a failure, never an empty page", async () => {
  await showADocument(DOC);
  await Bun.write(statePath(stateDir, DOC), "{ this is not json");

  const got = await load(DOC);
  expect(got.ok,
    "an unreadable state file read as 'nothing saved', so a page that autosaves " +
    "would overwrite whatever is actually on the disk").toBe(false);
  expect((got as { error: string }).error).toContain("Do not save over it");
  expect((got as { error: string }).error,
    "the refusal has to name the file, or nobody can go and look at it")
    .toContain(statePath(stateDir, DOC));
  expect(got).toMatchObject({ status: 500 });
});

/* A file that parses but is not one of ours. Same class as the torn one: it is
 * SOMETHING on the disk under his docId, and reading it as "nothing saved" is
 * the answer that then overwrites it. */
test("a state file of the wrong shape is a failure too, not an empty page", async () => {
  await showADocument(DOC);
  for (const body of ['"a string"', "[1,2,3]", "null", '{"savedAt":1}']) {
    await Bun.write(statePath(stateDir, DOC), body);
    const got = await load(DOC);
    expect(got.ok, `a state file holding ${body} was read as an answer`).toBe(false);
    expect(got).toMatchObject({ status: 500 });
  }
});

/* savedAt is what the page shows him ("your notes, saved at 14:12"). A record
 * whose stamp is missing or garbage still has his DATA in it, so the data comes
 * back and only the time is given up. */
test("a record with an unusable savedAt still returns the data, with savedAt 0", async () => {
  await showADocument(DOC);
  await Bun.write(statePath(stateDir, DOC),
    JSON.stringify({ docId: DOC, savedAt: "not a time", data: { keep: "this" } }));
  const got = await load(DOC);
  expect(got).toMatchObject({ ok: true, saved: true, savedAt: 0 });
  expect((got as { data: unknown }).data).toEqual({ keep: "this" });
});

// -------------------------------------------- the document is what keys it all

/* Without this the route is a key-value store: any client can POST anything to
 * any UUID it invents and the engine fills up with data no card will ever open. */
test("saving to a docId this engine never showed is refused", async () => {
  const r = await save("00000000-0000-0000-0000-000000000000", JSON.stringify({ x: 1 }));
  expect(r.ok).toBe(false);
  expect(r).toMatchObject({ status: 404 });
  expect(await exists(statePath(stateDir, "00000000-0000-0000-0000-000000000000")),
    "a state file was written for a document that does not exist").toBe(false);
});

test("loading a docId this engine never showed is refused, not answered empty", async () => {
  const r = await load("00000000-0000-0000-0000-000000000000");
  expect(r.ok).toBe(false);
  expect(r).toMatchObject({ status: 404 });
});

/* THE DOCUMENT CHECK IS ALSO THE PATH CHECK. The docId lands in a filename by
 * concatenation, so a traversal in it would name a state file outside the
 * directory. It cannot get there: nothing answers for the DOCUMENT at the
 * matching traversed path, so the save is refused before any write. (The route
 * validates the shape of a docId as well; this is the belt under that.) */
test("a docId that tries to climb out is refused, and writes nothing anywhere", async () => {
  for (const bad of ["../escape", "../../etc/passwd", "..%2Fescape", "sub/dir"]) {
    const r = await save(bad, JSON.stringify({ x: 1 }));
    expect(r.ok, `save(${JSON.stringify(bad)}) was allowed`).toBe(false);
    expect(r).toMatchObject({ status: 404 });
    expect(await exists(statePath(stateDir, bad)),
      `a state file was written at ${statePath(stateDir, bad)}`).toBe(false);
  }
});

test("statePath and docPath keep the two trees apart", () => {
  /* Not a second extension inside .run/docs, on purpose: the documents there
   * are disposable bytes an agent pushed, and anything that ever sweeps them
   * must be unable to take his typing with it by accident. */
  expect(docPath(docDir, DOC)).toBe(`${docDir}${DOC}.json`);
  expect(statePath(stateDir, DOC)).toBe(`${stateDir}${DOC}.json`);
  expect(statePath(stateDir, DOC)).not.toBe(docPath(docDir, DOC));
});

// ------------------------------------------------------------------- the cap

test("over the cap is refused, and the refusal says nothing was saved", async () => {
  await showADocument(DOC);
  await save(DOC, JSON.stringify({ keep: "this" }));

  const huge = JSON.stringify({ blob: "x".repeat(DOC_STATE_MAX_BYTES) });
  const r = await save(DOC, huge);
  expect(r.ok).toBe(false);
  expect(r).toMatchObject({ status: 413 });
  expect((r as { error: string }).error).toContain("NOTHING WAS SAVED");

  /* AND THE PREVIOUS SAVE IS STILL THERE, which is what "refusal, not
   * truncation" has to mean on the disk as well as in the sentence. */
  expect((await load(DOC) as { data: unknown }).data).toEqual({ keep: "this" });
});

test("the refusal names the size and the cap", () => {
  const msg = stateTooLargeMessage(3 * 256 * 1024);
  expect(msg).toContain("768KB");
  expect(msg).toContain("256KB");
  expect(msg.toLowerCase()).toContain("not a truncation");
});

/* THE EXACT EDGE. The cap is `> DOC_STATE_MAX_BYTES`, so a body of exactly the
 * cap is a save. A page that measured its own payload and stopped at the number
 * the engine published would otherwise be refused at the boundary it was told
 * to aim for. */
test("a body of exactly the cap is saved; one byte more is refused", async () => {
  await showADocument(DOC);
  const exact = '"' + "a".repeat(DOC_STATE_MAX_BYTES - 2) + '"'; // valid JSON, cap bytes
  expect(new TextEncoder().encode(exact).length).toBe(DOC_STATE_MAX_BYTES);
  const ok = await save(DOC, exact);
  expect(ok.ok, `the boundary body was refused: ${JSON.stringify(ok)}`).toBe(true);
  expect((ok as { bytes: number }).bytes).toBe(DOC_STATE_MAX_BYTES);

  const over = '"' + "a".repeat(DOC_STATE_MAX_BYTES - 1) + '"';
  const r = await save(DOC, over);
  expect(r.ok).toBe(false);
  expect(r).toMatchObject({ status: 413 });
});

/* THE ORDER OF THE TWO CHECKS. Size is measured before the parse, so a 40 MB
 * blob of nonsense is refused on its size rather than after JSON.parse has been
 * asked to walk all of it. The refusal that comes back is the 413, which is
 * also the one that tells the agent what to do about it. */
test("an oversized body is refused on its size even when it is not JSON", async () => {
  await showADocument(DOC);
  const r = await save(DOC, "x".repeat(DOC_STATE_MAX_BYTES + 10));
  expect(r).toMatchObject({ status: 413 });
});

test("a save reports the byte count it wrote, and the stamp it wrote", async () => {
  await showADocument(DOC);
  const body = JSON.stringify({ hello: "world" });
  const r = await save(DOC, body, 1_700_000_000_777);
  expect(r).toEqual({ ok: true, savedAt: 1_700_000_000_777, bytes: body.length });
  const onDisk = JSON.parse(await Bun.file(statePath(stateDir, DOC)).text());
  expect(onDisk.docId, "the record names its own document, so a stray file is identifiable")
    .toBe(DOC);
  expect(onDisk.savedAt).toBe(1_700_000_000_777);
});

/* Bytes and not characters: the cap is about what crosses the wire from his
 * phone and what sits on the engine's disk, and an emoji is four of them. A page
 * measuring its own payload in .length would otherwise be refused at a number it
 * has no way to see. */
test("the cap counts bytes, so multi-byte text is measured as it travels", async () => {
  await showADocument(DOC);
  /* Each 🧠 is two UTF-16 units and FOUR bytes, so this is comfortably under the
   * cap counted in .length and comfortably over it counted as it travels. */
  const body = JSON.stringify({ note: "🧠".repeat(Math.floor(DOC_STATE_MAX_BYTES / 3)) });
  expect(body.length,
    "this fixture is already over the cap in characters, so it proves nothing " +
    "about bytes").toBeLessThan(DOC_STATE_MAX_BYTES);
  const r = await save(DOC, body);
  expect(r.ok, "a body over the cap in bytes was accepted because it was counted " +
    "in characters").toBe(false);
});

test("a body that is not JSON is refused rather than stored", async () => {
  await showADocument(DOC);
  const r = await save(DOC, "not json at all");
  expect(r.ok).toBe(false);
  expect(r).toMatchObject({ status: 400 });
  expect(await exists(statePath(stateDir, DOC))).toBe(false);
});

test("a refused body never touches the save that came before it", async () => {
  /* The other half of "refusal, not truncation": a bad second save must leave
   * the good first one on the disk, byte for byte. */
  await showADocument(DOC);
  await save(DOC, JSON.stringify({ keep: "this" }));
  const before = await Bun.file(statePath(stateDir, DOC)).text();
  expect((await save(DOC, "{ half a save")).ok).toBe(false);
  expect(await Bun.file(statePath(stateDir, DOC)).text()).toBe(before);
});

/* Anything JSON.parse accepts is a state, because the page decides what its own
 * state looks like and the engine is not in the business of having an opinion
 * about it. */
test("any JSON value is a state: scalars, arrays and nested objects all round-trip", async () => {
  await showADocument(DOC);
  for (const value of [0, false, "", [1, [2, [3]]], { a: { b: [null, true] } }]) {
    const r = await save(DOC, JSON.stringify(value));
    expect(r.ok, `saving ${JSON.stringify(value)} was refused`).toBe(true);
    expect((await load(DOC) as { data: unknown }).data).toEqual(value);
  }
});

/* `null` is a legitimate thing to save: it is how a page says "I have nothing to
 * restore" without inventing a delete verb. It must survive the JSON check and
 * come back as saved:true with null data, which is a different answer from
 * saved:false. */
test("saving null is a save, and is distinguishable from never having saved", async () => {
  await showADocument(DOC);
  const r = await save(DOC, "null");
  expect(r.ok).toBe(true);
  expect(await load(DOC)).toMatchObject({ ok: true, saved: true, data: null });
});
