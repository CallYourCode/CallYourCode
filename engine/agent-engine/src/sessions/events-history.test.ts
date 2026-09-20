/* #583: EVENTS IN HISTORY (invariant E9, CONTRACT.md "The page vocabulary").
 *
 * WHY THIS FILE EXISTS
 *
 * Third recurrence of "scrolling up shows chat with no session activity beside
 * it". Fix #1 (2026-08-07, f377384) read the whole transcript on attach; #413
 * (2026-08-08) bounded that read to a newest byte window for liveness and
 * declared older events dropped, not paged; #583 paged the window back over a
 * byte cursor (GET /session-events). Every one of those read the HARNESS
 * transcript on the attach path, so the activity beside the chat was only ever
 * as complete as the read that attach could afford.
 *
 * THE INVARIANT NOW (E9, design A.4): the transcript is read ONCE, by the
 * ingest (chat/ingest.ts), into the agent's own log as `t:"s"` session records
 * on the same seq axis as the messages; a transcript this engine has never read
 * is backfilled in bounded spans, one job at a time. An attach is then ONE
 * frame of pages over that log, messages and records together, and paging to
 * page 0 walks every transcript event exactly once. Both #413's liveness (every
 * read bounded) and fix #1's completeness (all history reachable) hold, and
 * neither is on the attach path any more.
 *
 * NO ENGINE PROCESS. The first half drives the backward reader directly (it is
 * still the reader behind the adapter's conversation() snapshot); the second
 * half is wireCore's in-process boot plus the SHIPPED page route over a real
 * Bun.serve on port 0.
 *
 *   bun test agent-engine/src/sessions/events-history.test.ts
 */

import { test, expect, afterEach, beforeAll } from "bun:test";
import { join } from "node:path";
import { unlink } from "node:fs/promises";

import { readEventsTail } from "./session-events.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { seedTranscript } from "../test-utils/builders.ts";
import { wireCore, type WireCore } from "../test-utils/wire-core.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { chatRoutes } from "../routes/chat.ts";
import { dispatchClientFrame } from "../transport/frames.ts";
import { logChat } from "../chat/chatlog.ts";
import { BACKFILL_SPAN, hasIngest } from "../chat/ingest.ts";
import { chatStore, flushAgentSave } from "./session-state.ts";
import { PAGE_SIZE } from "../runtime/pages.ts";

const BLOCK = 1 << 20; // must match session-events.ts BLOCK

function recLine(i: number, base: number, pad: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `u${i.toString().padStart(9, "0")}`,
    timestamp: new Date(base + i).toISOString(),
    message: { content: [{ type: "text", text: `line ${i} ${pad}` }] },
  }) + "\n";
}

/** A transcript of at least `bytes`, one ordinary assistant record per line. */
function author(bytes: number): { content: string; total: number } {
  const base = Date.UTC(2026, 0, 1);
  const pad = "y".repeat(900);
  let content = "", i = 0;
  while (content.length < bytes) { content += recLine(i, base, pad); i++; }
  return { content, total: i };
}

const uuidsTo = (n: number) => Array.from({ length: n }, (_, i) => `u${i.toString().padStart(9, "0")}`);

// ------------------------------------------------------- the reader's cursor

let dir = "";
let P = "";
const P_BYTES = 2 * 1024 * 1024;
const BUDGET = 256 * 1024;
let P_TOTAL = 0;

beforeAll(async () => {
  dir = await tmpDir("cyc-583-");
  P = join(dir, "cursor.jsonl");
  const a = author(P_BYTES);
  await Bun.write(P, a.content);
  P_TOTAL = a.total;
});

test("byte-bounded cursor pages reconstruct the whole file exactly once", async () => {
  const full = await readEventsTail(P, { limit: 1e9 });
  expect(full.events.length).toBe(P_TOTAL);

  const pages = [await readEventsTail(P, { limit: 1e9, maxBytes: BUDGET })];
  while (pages[pages.length - 1].resumeAt > 0) {
    const prev = pages[pages.length - 1].resumeAt;
    const r = await readEventsTail(P, { limit: 1e9, maxBytes: BUDGET, from: prev });
    expect(r.bytesRead).toBeLessThanOrEqual(BUDGET + BLOCK); // every step bounded (#413 liveness)
    expect(r.resumeAt).toBeLessThan(prev); // every step progresses (no stall, no loop)
    pages.push(r);
    expect(pages.length).toBeLessThan(100); // terminates
  }
  expect(pages.length).toBeGreaterThan(2); // the file really was windowed
  expect(pages[pages.length - 1].more).toBe(false);

  /* Pages arrive newest-window-first, each ascending: stitched oldest-first
   * they are the full parse, exactly once -- no holes, no duplicates. A hole is
   * "no session activity beside this chat"; a duplicate is the same tool call
   * drawn twice. Both were live symptoms. */
  const stitched = pages.slice().reverse().flatMap((p) => p.events.map((e) => e.uuid));
  expect(stitched).toEqual(full.events.map((e) => e.uuid));
});

test("a limit-stopped page resumes without loss or duplication", async () => {
  /* The other way a read stops: the event LIMIT rather than the byte budget.
   * The line the limit was looking at was not returned, so the cursor has to
   * resume just past its end -- one off in either direction is a dropped event
   * or a doubled one. */
  const p = join(dir, "limit.jsonl");
  const a = author(64 * 1024);
  await Bun.write(p, a.content);
  const full = await readEventsTail(p, { limit: 1e9 });

  const pages = [await readEventsTail(p, { limit: 7 })];
  while (pages[pages.length - 1].resumeAt > 0) {
    const prev = pages[pages.length - 1].resumeAt;
    const r = await readEventsTail(p, { limit: 7, from: prev });
    expect(r.resumeAt).toBeLessThan(prev);
    pages.push(r);
    expect(pages.length).toBeLessThan(100);
  }
  const stitched = pages.slice().reverse().flatMap((x) => x.events.map((e) => e.uuid));
  expect(stitched).toEqual(full.events.map((e) => e.uuid));
  await unlink(p).catch(() => {});
});

test("a single line larger than the budget is skipped, the walk still progresses and terminates",
  async () => {
    /* THE ONE DOCUMENTED EXCEPTION. A record bigger than the whole byte window
     * (a base64 image; 743 KB lines are real) cannot be cleared inside one
     * call, so the cursor falls back to the block boundary and that record is
     * later skipped as a partial. Progress and boundedness are what must
     * survive: a walk that stalled on it would hang the scroll-up forever,
     * which is worse than losing one pill. */
    const p = join(dir, "huge.jsonl");
    const base = Date.UTC(2026, 0, 1);
    const normal = author(128 * 1024); // older, ordinary lines
    const huge = JSON.stringify({
      type: "assistant", uuid: "uHUGE",
      timestamp: new Date(base + 1e6).toISOString(),
      message: { content: [{ type: "text", text: "z".repeat(3 * BUDGET) }] },
    }) + "\n";
    await Bun.write(p, normal.content + huge);

    const pages = [await readEventsTail(p, { limit: 1e9, maxBytes: BUDGET })];
    while (pages[pages.length - 1].resumeAt > 0) {
      const prev = pages[pages.length - 1].resumeAt;
      const r = await readEventsTail(p, { limit: 1e9, maxBytes: BUDGET, from: prev });
      expect(r.resumeAt).toBeLessThan(prev); // the fallback cursor still progresses
      pages.push(r);
      expect(pages.length).toBeLessThan(100); // and the walk terminates
    }
    const stitched = pages.slice().reverse().flatMap((x) => x.events.map((e) => e.uuid));
    // the oversized record is dropped; every ordinary record still arrives once
    expect(stitched.filter((u) => u !== "uHUGE")).toEqual(uuidsTo(normal.total));
    await unlink(p).catch(() => {});
  });

test("a file that does not exist is an empty answer, not a throw", async () => {
  const r = await readEventsTail(join(dir, "never-written.jsonl"), { limit: 100 });
  expect(r).toEqual({ events: [], more: false, bytesRead: 0, resumeAt: 0 });
});

// -------------------------------------------- the wire (ingest + attach + pages)

type Rig = { core: WireCore; http: ServedRoutes };
let rig: Rig | null = null;

afterEach(async () => {
  rig?.http?.stop();
  await rig?.core?.stop();
  rig = null;
});

const U1 = "58358358-aaaa-4bbb-8ccc-000000000001";

/** wireCore with the frames layer, a pane whose claude session id is U1, and the
 *  shipped chat routes over a real Bun.serve on port 0. */
async function boot(): Promise<Rig> {
  const core = await wireCore({ sessionIds: { [PANE]: U1 }, with: ["frames"] });
  await until(() => !!core.sessionOf(U1), { what: "the pane to reconcile under its claude id" });
  const http = serveRoutes({ groups: [chatRoutes], ctx: { adapter: core.adapter } });
  rig = { core, http };
  return rig;
}

/** The wire id of the session running under harness session id `sid`: the
 *  attach frame and the route are keyed by the agent id, never by the claude id. */
const wireIdOf = (core: WireCore, sid: string): string => core.sessionOf(sid)!.id;

/** Seed a transcript for U1 and make the engine look (a status event is what
 *  makes herdr's client resnapshot, and the snapshot's reconcile starts the
 *  ingest). Resolves once the ingest's backfill has finished. */
async function ingested(core: WireCore, content: string): Promise<void> {
  await seedTranscript(core.root, U1, { content });
  core.herdr.setStatus(PANE, "working");
  await until(() => hasIngest(wireIdOf(core, U1)), { what: "the ingest to start on the new transcript" });
  await until(() => core.logs.some((l) => l.event === "ingest.backfill.done"),
    { what: "the backfill to finish", timeoutMs: 20_000 });
}

/** Attach once and return every frame the client got for it. */
async function attach(core: WireCore, sid: string) {
  const page = core.client();
  await dispatchClientFrame(page.sock, { t: "attach", id: wireIdOf(core, sid) });
  await until(() => page.of("attach-ok").length > 0, { what: "the attach answer" });
  await new Promise((r) => setTimeout(r, 30)); // anything fired after it would land by now
  return page;
}

/** Walk every page of a session over the route, page 0 first. */
async function allPages(http: ServedRoutes, id: string, tail: number): Promise<any[]> {
  const pages: any[] = [];
  for (let n = 0; n <= tail; n++) {
    const res = await http.get(`/session/${encodeURIComponent(id)}/page/${n}`);
    expect(res.status).toBe(200);
    pages.push(await res.json());
  }
  return pages;
}

/** The transcript's own records on a page: those with a src (an engine-authored
 *  fact, the status edge the snapshot logged, has none). */
const ridsOf = (rows: any[]) => rows.filter((r) => r.t === "s" && r.src).map((r) => r.src.rid);

test("E9: the ingest backfills the transcript in bounded spans; ONE attach frame carries " +
  "messages and events, and the pages reach the transcript's first event exactly once", async () => {
  const { core, http } = await boot();
  const s = core.sessionOf(U1)!;
  logChat(s, { id: s.id, ts: Date.now(), role: "user", text: "hello from the app" });

  /* Far larger than one span, the shape his live sessions are in (months of
   * chat): the backfill MUST read it in pieces, yielding between them. */
  const a = author(3 * 1024 * 1024);
  await ingested(core, a.content);
  const done = core.logs.find((l) => l.event === "ingest.backfill.done")!.fields;
  expect(done.spans, "the transcript was not read in bounded spans").toBeGreaterThanOrEqual(
    Math.floor(a.content.length / BACKFILL_SPAN));
  expect(done.added).toBe(a.total);

  const page = await attach(core, U1);
  // ONE frame, and none of the old activity frames behind it
  expect(page.of("attach-ok").length).toBe(1);
  expect(page.of("session-events").length).toBe(0);
  const ok = page.of("attach-ok")[0];
  expect(ok.known).toBe(true);
  // the message, every transcript event, and the status edge the snapshot logged
  expect(ok.total).toBe(a.total + 2);
  expect(ok.pageSize).toBe(PAGE_SIZE);
  // the tail page is in the frame, and it holds records, tagged
  const tail = ok.pages.find((p: any) => p.page === ok.tailPage);
  expect(tail.messages.some((r: any) => r.t === "s")).toBe(true);
  expect(tail.messages.every((r: any) => r.t !== "s" || (r.kind && r.src?.rid && typeof r.seq === "number")))
    .toBe(true);

  // page 0 holds the message AND the first records, on the one axis
  const pages = await allPages(http, wireIdOf(core, U1), ok.tailPage);
  expect(pages[0].messages[0]).toMatchObject({ text: "hello from the app", seq: 0 });
  expect(pages[0].messages[1]).toMatchObject({ t: "s", seq: 1, kind: "status", status: "working" });
  expect(pages[0].messages[2]).toMatchObject({ t: "s", seq: 2, kind: "reply", src: { rid: "u000000000" } });
  expect(pages[0].messages.length).toBe(PAGE_SIZE);
  expect(pages.slice(0, -1).every((p) => p.sealed)).toBe(true);
  expect(pages[pages.length - 1].sealed).toBe(false);

  // the union of the pages is the whole transcript, exactly once, oldest first
  const stitched = pages.flatMap((p) => ridsOf(p.messages));
  expect(stitched,
    "the pages are not the transcript exactly once, which is the third " +
    "recurrence of 'scrolled-up chat has no activity beside it' (#583)")
    .toEqual(uuidsTo(a.total));
  // and the records keep the transcript's own instants (ts is display order)
  expect(pages[0].messages[2].ts).toBe(Date.UTC(2026, 0, 1));
});

test("a transcript inside one span is backfilled whole, in one span", async () => {
  const { core, http } = await boot();
  const a = author(16 * 1024);
  await ingested(core, a.content);
  const done = core.logs.find((l) => l.event === "ingest.backfill.done")!.fields;
  expect(done.spans).toBe(1);
  const page = await attach(core, U1);
  const ok = page.of("attach-ok")[0];
  const pages = await allPages(http, wireIdOf(core, U1), ok.tailPage);
  expect(pages.flatMap((p) => ridsOf(p.messages))).toEqual(uuidsTo(a.total));
});

test("the transcript is read ONCE: after an engine reboot the attach is served from the kept log, " +
  "in one frame, and the ingest resumes at its pointer without a backfill", async () => {
  const { core, http } = await boot();
  const s = core.sessionOf(U1)!;
  logChat(s, { id: s.id, ts: Date.now(), role: "user", text: "before the reboot" });
  const a = author(32 * 1024);
  await ingested(core, a.content);
  const id = wireIdOf(core, U1);
  const before = (await attach(core, U1)).of("attach-ok")[0];
  expect(before.total).toBe(a.total + 2); // message + events + the status edge

  // the reboot: everything the engine keeps lands first, then a fresh process
  await chatStore.flush();
  await flushAgentSave(id);
  core.logs.length = 0;
  await core.reset();
  await until(() => !!core.sessionOf(U1), { what: "the pane to reconcile again after the reboot" });
  rig!.http.stop();
  rig!.http = serveRoutes({ groups: [chatRoutes], ctx: { adapter: core.adapter } });
  await until(() => hasIngest(wireIdOf(core, U1)), { what: "the ingest to resume after the reboot" });

  const page = await attach(core, U1);
  expect(page.of("attach-ok").length).toBe(1);
  expect(page.of("session-events").length).toBe(0);
  const ok = page.of("attach-ok")[0];
  expect(ok.id).toBe(id);
  expect(ok.total, "the log did not survive the reboot whole").toBe(before.total);
  const pages = await allPages(rig!.http, id, ok.tailPage);
  expect(pages[0].messages[0]).toMatchObject({ text: "before the reboot", seq: 0 });
  expect(pages.flatMap((p) => ridsOf(p.messages))).toEqual(uuidsTo(a.total));
  // resumed at the pointer: no second read of the file
  expect(core.logs.some((l) => l.event === "ingest.resume")).toBe(true);
  expect(core.logs.some((l) => l.event === "ingest.backfill.start"),
    "the reboot re-read a transcript it had already ingested").toBe(false);
  expect(core.logs.some((l) => l.event === "ingest.start")).toBe(false);
});
