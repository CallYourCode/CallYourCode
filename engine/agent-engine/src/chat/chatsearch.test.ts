/* SEARCHING A CONVERSATION HAPPENS HERE, over the whole log.
 *
 * WHY THIS FILE EXISTS
 *
 * The count is the whole reason the route exists: search runs on the agent
 * engine, not in the app, so the answer is the full count across the whole
 * session rather than a count over whatever rows the app happens to hold.
 * A count taken in the browser is a count of what the browser fetched, and an
 * attach only ever hands it the pointer page and the tail. So the number this
 * route returns has to be the number for the CONVERSATION, including matches far
 * above anything the app is holding, and that is what the first test proves: a
 * 900-message log with matches planted at both ends, searched next to an attach
 * that demonstrably received only the tail page.
 *
 * The rest are the edges that would each make the app say something false:
 *
 *   - a voice note's transcript IS its text, so it must be findable. A search
 *     that skipped voice notes would report "no results" about a conversation
 *     that plainly contains the words;
 *   - a message with NO text (an attachment sent with no caption) still has a
 *     name, and being told a chat that contains report.pdf has no results is
 *     the app lying about its own contents;
 *   - an empty query is an error, not "everything". Answering with the whole
 *     log would make "I have not typed anything yet" and "this matched
 *     everything" the same frame;
 *   - the search is case-insensitive, because nobody types the case back;
 *   - a query with regex punctuation in it is TEXT. `.*` matching everything is
 *     a search box behaving like a programming language.
 *
 * THE CAP was reasoned about and never run until 2026-08-03: `total` stays the
 * whole log's and `hits` keeps the NEWEST window, because the app numbers hit i
 * as match i+1 from the newest end. There is no `capped` field any more (it was
 * total > hits.length, which the app can see from the two numbers beside it).
 *
 * THE ROUTE IS WHAT IS UNDER TEST HERE. scanChat/normalizeQuery, the matching
 * itself, are unit-tested in search.test.ts; this file is the HTTP surface over
 * a real Bun.serve on port 0, against the real session store, with no engine.
 *
 *   bun test agent-engine/src/chat/chatsearch.test.ts
 */

import { test, expect, afterEach } from "bun:test";

import { wireCore, type WireCore, wireId } from "../test-utils/wire-core.ts";
import { chatStore } from "../sessions/session-state.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { seedAgent } from "../test-utils/builders.ts";
import { PANE, defaultSessionIdOf } from "../test-utils/fake-herdr.ts";
/* The harness id the fake herdr reports for PANE: what the disk records
 * (meta.json sessionId, the chat log) are keyed by, never the pane id. */
const PANE_SID = defaultSessionIdOf(PANE);
import { until } from "../test-utils/wait.ts";
import { chatRoutes } from "../routes/chat.ts";
import { dispatchClientFrame } from "../transport/frames.ts";

type Seeded = {
  id: string; role: "user" | "claude"; text: string; ts: number;
  kind?: "voice"; upload?: Record<string, unknown>;
};

let core: WireCore | null = null;
let http: ServedRoutes | null = null;
afterEach(async () => {
  /* Every queued chat append on disk before the tmp tree goes: an append still
   * in flight when the directory is removed prints an ENOENT nobody can act on. */
  await chatStore.flush();
  http?.stop();
  http = null;
  await core?.stop();
  core = null;
});

/* Plant a chat log on disk and boot ONTO it, the way a restart finds one.
 *
 * Two wirings: the first only exists to own the tmp tree (wireCore mints it),
 * the second is the one that reads what was seeded. `start:false` on the first
 * keeps the adapter quiet so nothing reconciles against an empty log. */
async function bootWith(msgs: Seeded[]): Promise<ServedRoutes> {
  core = await wireCore({ with: ["frames"], start: false });
  await seedAgent(core.root, PANE_SID, msgs as unknown as Record<string, unknown>[]);
  await core.reset({ start: true });
  await until(() => core!.byHandle(PANE)?.chat.length === msgs.length,
    { what: `the seeded ${msgs.length}-message log to be adopted by the pane` });
  http = serveRoutes({ groups: [chatRoutes], ctx: { adapter: core.adapter } });
  return http;
}

const search = async (q: string, id = wireId(PANE)) => {
  const res = await http!.get(`/chat-search/${encodeURIComponent(id)}?q=${encodeURIComponent(q)}`);
  return { status: res.status, body: await res.json() as Record<string, any> };
};

/* A long conversation with the needles at the two ends. The base is one hour
 * ago stepping forward, so the ordering is the ordering a real log has, and the
 * ts assertions below are arithmetic rather than a race with the clock. */
const BASE = Date.now() - 3_600_000;
function longLog(): Seeded[] {
  const msgs: Seeded[] = [];
  for (let i = 0; i < 900; i++) {
    msgs.push({ id: wireId(PANE), role: i % 2 ? "claude" : "user",
      text: i === 3 ? "the OLDEST needle, right at the top" :
        i === 890 ? "the newest needle, near the bottom" : `filler line ${i}`,
      ts: BASE + i });
  }
  return msgs;
}

test("the count is the whole log's, not the pages a client was handed", async () => {
  await bootWith(longLog());

  /* THE ASYMMETRY, MADE REAL FIRST. An attach hands the app the pointer page
   * and the tail page and nothing else; on a restored log with nothing unread
   * both collapse to the tail. So the app is holding the newest hundred lines,
   * which is exactly the position an app-side search would be counting from. */
  const page = core!.client();
  await dispatchClientFrame(page.sock, { t: "attach", id: wireId(PANE) });
  await until(() => page.last("attach-ok") !== undefined, { what: "the attach answer" });
  const ok = page.last("attach-ok")!;
  const held = (ok.pages as any[]).flatMap((p) => p.messages as any[]);
  expect(held.length,
    "the attach handed over the whole log, so there is no window here and this test " +
    "cannot show the difference between counting in the app and counting on the engine")
    .toBeLessThan(200);
  expect(held.some((m) => String(m.text).includes("OLDEST needle")),
    "the oldest needle was in the attach answer, so a page COULD have counted it and " +
    "this test proves nothing about where the count comes from").toBe(false);

  const { status, body } = await search("needle");
  expect(status).toBe(200);
  expect(body.total,
    `the engine found ${body.total} matches for "needle" in a log that has two, one of them ` +
    "above anything the app was handed. That count is the only reason this route exists").toBe(2);
  expect(body.scanned,
    "the route reported scanning fewer messages than the log holds, so it is searching a " +
    "window of its own").toBe(900);
  expect(body.hits.length, "both matches should come back as jumpable positions").toBe(2);
  expect(body.hits[0].ts, "the oldest hit is not the oldest match, so the hits are not in log order")
    .toBe(BASE + 3);
  expect(body.hits[0].role).toBe("claude"); // i=3 is odd
  /* Every hit carries its `seq`, the page address the app fetches to reach a
   * match older than its held pages (ensureMessageHeld). ensureSeqs numbers a
   * seeded log 0..n-1, so the needle at index 3 is seq 3 and the one at index
   * 890 is seq 890. Without this the app cannot compute the hit's page and the
   * counter strands at "still loading" (the #530 bug). */
  expect(body.hits[0].seq, "the hit does not carry its seq, so the app cannot fetch its page").toBe(3);
  expect(body.hits[1].seq, "the newest hit's seq is wrong").toBe(890);
});

test("a voice note is found by its transcript, and an attachment by its name", async () => {
  const ts = Date.now() - 10_000;
  await bootWith([
    { id: wireId(PANE), role: "user", text: "remember to rotate the tailscale key", ts, kind: "voice" },
    { id: wireId(PANE), role: "user", text: "", ts: ts + 1,
      upload: { uploadId: "u1", name: "quarterly-report.pdf", mime: "application/pdf",
        size: 12, path: "/tmp/quarterly-report.pdf", image: false } },
    { id: wireId(PANE), role: "claude", text: "done", ts: ts + 2 },
  ]);

  const spoken = await search("tailscale");
  expect(spoken.body.total,
    "a voice note's transcript IS its text (onUtterance stores it there), so a search that " +
    "misses it tells the user a conversation they can plainly read has no results").toBe(1);
  expect(spoken.body.hits[0].excerpt).toContain("rotate the tailscale key");

  const named = await search("quarterly");
  expect(named.body.total,
    "an attachment sent with no caption has text:\"\" and its name on `upload`. Reporting no " +
    "results for a file the conversation visibly contains is the app lying about itself").toBe(1);
  expect(named.body.hits[0].excerpt,
    "the hit for a text-less message came back with nothing to show for it")
    .toBe("quarterly-report.pdf");
});

test("case is ignored, an empty query is refused, and an unknown session is a 404", async () => {
  const ts = Date.now() - 10_000;
  await bootWith([{ id: wireId(PANE), role: "claude", text: "The Deploy Script is in scripts/", ts }]);

  expect((await search("deploy script")).body.total,
    "the search is case-sensitive, so finding anything depends on typing it back the way it " +
    "was written, which nobody does").toBe(1);

  const empty = await search("   ");
  expect(empty.status,
    "a whitespace query was answered with a result set. \"I have not typed anything yet\" and " +
    "\"this matched nothing\" would then be the same frame, and the app cannot draw both").toBe(400);
  expect(empty.body.error).toBeTruthy();

  const missing = await search("hello", "w9:pNOSUCH");
  expect(missing.status,
    "searching a session this engine does not have answered as though it did, so an empty " +
    "result would read as 'this conversation has none' rather than 'wrong engine'").toBe(404);
});

/* ---------------------------------------------------------- the verifier's */

const CAP_BASE = Date.now() - 7_200_000;

/** 2500 messages that ALL match, which is 500 past the route's HITS_MAX. */
function overCap(): Seeded[] {
  const msgs: Seeded[] = [];
  for (let i = 0; i < 2500; i++) {
    msgs.push({ id: wireId(PANE), role: i % 2 ? "claude" : "user",
      text: `needle number ${i}`, ts: CAP_BASE + i });
  }
  return msgs;
}

test("past the cap the count is still the whole log's, and the hits are the newest window",
  async () => {
    await bootWith(overCap());

    const { status, body } = await search("needle");
    expect(status).toBe(200);
    expect(body.scanned, "the log did not survive the restore, so nothing here is about the cap")
      .toBe(2500);
    expect(body.total, "the count stopped being the whole log's the moment it outran the cap, " +
      "which is the one number this route exists to be right about").toBe(2500);
    expect(body.hits.length, "the hit list is not exactly the cap").toBe(2000);
    expect(body.hits.length, "2500 matches must come back as 2000 hits, the newest end")
      .toBeLessThan(body.total);

    /* The NEWEST window, not the oldest: the app numbers hit i as match i+1 from
     * the newest end, so keeping the wrong end would make every number a lie. */
    expect(body.hits[0].ts, "the kept window starts at the wrong end of the log")
      .toBe(CAP_BASE + 500);
    expect(body.hits[body.hits.length - 1].ts, "the newest match is not in the window")
      .toBe(CAP_BASE + 2499);
    // ...and the hits stay in log order, so the app's reversal numbers them right
    expect(body.hits[0].seq).toBe(500);
    expect(body.hits[body.hits.length - 1].seq).toBe(2499);
  });

test("a query that matches nothing is a 200 with an honest zero", async () => {
  const ts = Date.now() - 10_000;
  await bootWith([
    { id: wireId(PANE), role: "user", text: "the first thing said here", ts },
    { id: wireId(PANE), role: "claude", text: "the last thing said here", ts: ts + 1 },
  ]);

  const none = await search("zzzqqxnothingmatches");
  expect(none.status).toBe(200);
  expect(none.body.total).toBe(0);
  expect(none.body.hits.length).toBe(0);
  expect(none.body.scanned, "an honest zero still says how much was looked at").toBe(2);
});

test("the very newest and the very oldest message are both findable", async () => {
  const ts = Date.now() - 10_000;
  const msgs: Seeded[] = [{ id: wireId(PANE), role: "user", text: "alpha at the very top", ts }];
  for (let i = 1; i < 50; i++) msgs.push({ id: wireId(PANE), role: "claude", text: `filler ${i}`, ts: ts + i });
  msgs.push({ id: wireId(PANE), role: "user", text: "omega at the very bottom", ts: ts + 50 });
  await bootWith(msgs);

  const first = await search("alpha");
  expect(first.body.total, "the first message in the log is not searchable").toBe(1);
  expect(first.body.hits[0].ts).toBe(ts);
  expect(first.body.hits[0].seq, "the first message's page address is wrong").toBe(0);
  const last = await search("omega");
  expect(last.body.total, "the last message in the log is not searchable").toBe(1);
  expect(last.body.hits[0].ts).toBe(ts + 50);
  expect(last.body.hits[0].seq).toBe(50);
});

test("regex and glob characters are matched as text, not compiled", async () => {
  const ts = Date.now() - 10_000;
  await bootWith([
    { id: wireId(PANE), role: "claude", text: "run a.b*c[d] to rebuild", ts },
    { id: wireId(PANE), role: "claude", text: "and then anything else", ts: ts + 1 },
    { id: wireId(PANE), role: "user", text: "cost is $5 (plus tax)", ts: ts + 2 },
  ]);

  expect((await search("a.b*c[d]")).body.total,
    "a query with regex punctuation in it found nothing, so the query is being compiled " +
    "rather than compared").toBe(1);
  expect((await search(".*")).body.total,
    "`.*` matched messages that do not contain those two characters: the query is a regular " +
    "expression, which nobody typing into a search box expects").toBe(0);
  expect((await search("$5 (plus")).body.total).toBe(1);
  expect((await search("\\d")).body.total,
    "a backslash escape matched, so the query is a pattern").toBe(0);
  expect((await search("^and")).body.total,
    "an anchor matched, so the query is a pattern").toBe(0);
});

test("an all-whitespace query is refused, a very long one is cut, and a padded one is trimmed",
  async () => {
    const ts = Date.now() - 10_000;
    await bootWith([{ id: wireId(PANE), role: "claude", text: "a line with spaces in it", ts }]);

    expect((await search("\t\n  ")).status,
      "a tab-and-newline query was answered as a search").toBe(400);
    /* 200 characters is the cap; a longer query is CUT rather than refused, and
     * the cut must not accidentally start matching. */
    expect((await search("x".repeat(400))).body.total).toBe(0);
    expect((await search(" a line ")).body.total,
      "the query is trimmed, so leading and trailing spaces must not change what matches").toBe(1);
    // and a query missing entirely is the same refusal as an empty one
    const bare = await http!.get(`/chat-search/${encodeURIComponent(wireId(PANE))}`);
    expect(bare.status, "a request with no q at all was answered as a search").toBe(400);
  });
