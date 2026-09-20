/* The search PLUGIN's rpc, and the scan both it and /chat-search share.
 *
 * /chat-search's own behaviour (the count over the whole log, voice notes and
 * attachments findable, the cap, the edges) is proved against the live engine in
 * chatsearch.test.ts. THIS file proves the two things the plugin adds on top:
 * `query` pages NEWEST FIRST with a `before` cursor, and the count is still the
 * whole log's; plus the shared scan/normalize the two callers must agree on.
 *
 * ONE SCAN, TWO CALLERS is the property under test throughout. If the route and
 * the panel could disagree about what matches, the in-chat counter and the
 * results list would show two different searches of the same conversation.
 *
 *   bun test agent-engine/src/chat/search.test.ts
 */

import { test, expect } from "bun:test";
import { normalizeQuery, scanChat, Q_MAX, EXCERPT, type ScanRow } from "./chat-search.ts";
import { searchPlugin, PAGE } from "../plugins/search/index.ts";
import type { PluginCore } from "../plugins/platform/core.ts";
import type { RpcCtx } from "../plugins/platform/spec.ts";

/* A fake PluginCore factory whose searchChat is the stub the plugin reads (the
 * one matcher server.ts wires over a live session). */
function coreFor(searchChat: (session: string, q: string) => { total: number; matches: ScanRow[]; scanned: number } | null): (id: string) => PluginCore {
  const core = { searchChat } as unknown as PluginCore;
  return () => core;
}
/* `matches` are OLDEST FIRST (log order), as scanChat returns; scanned is a few
 * more than the match count so the tests can tell the two numbers apart. */
const matchesCore = (matches: ScanRow[]) => coreFor(() => ({ total: matches.length, matches, scanned: matches.length + 5 }));
const nullCore = () => coreFor(() => null);

type Row = { seq: number; ts: number; role: "user" | "claude"; text: string };
const log = (n: number, hit: (i: number) => boolean): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    seq: i, ts: 1_700_000_000_000 + i * 1000,
    role: (i % 2 ? "claude" : "user") as "user" | "claude",
    text: hit(i) ? `needle ${i}` : `filler ${i}`,
  }));
const textOf = (r: Row) => r.text;

// -------------------------------------------------------------- normalizeQuery

test("normalizeQuery trims, caps at 200 and lowercases", () => {
  expect(normalizeQuery("  Hello World  ")).toBe("hello world");
  expect(normalizeQuery("\t\n  ")).toBe("");
  expect(normalizeQuery("X".repeat(400)).length).toBe(Q_MAX);
  expect(Q_MAX).toBe(200);
  expect(normalizeQuery(undefined)).toBe("");
});

test("normalizeQuery answers a string for anything a client can send", () => {
  /* It feeds straight into `.includes()`. A null that came back as null, or a
   * number that came back as a number, is a 500 in the route rather than an
   * empty search. */
  expect(normalizeQuery(null)).toBe("");
  expect(normalizeQuery(42)).toBe("42");
  expect(normalizeQuery({}), "an object stringifies rather than throwing")
    .toBe("[object object]");
  expect(normalizeQuery(["a", "B"])).toBe("a,b");
});

test("the cap is applied to the TRIMMED query, so padding cannot eat it", () => {
  const padded = "   " + "z".repeat(Q_MAX + 50) + "   ";
  expect(normalizeQuery(padded).length).toBe(Q_MAX);
  expect(normalizeQuery(padded).startsWith("z")).toBe(true);
});

// -------------------------------------------------------------------- scanChat

test("scanChat returns every match in log order, each carrying its seq", () => {
  const rows = log(10, (i) => i === 2 || i === 7);
  const r = scanChat(rows, textOf, "needle");
  expect(r.total).toBe(2);
  expect(r.scanned).toBe(10);
  expect(r.matches.map((m) => m.seq)).toEqual([2, 7]); // oldest first
  expect(r.matches[0].excerpt).toBe("needle 2");
  expect(r.matches[0].role).toBe("user");
  expect(r.matches[0].ts).toBe(1_700_000_000_000 + 2000);
});

test("matching is case-insensitive against an already-lowercased query", () => {
  /* normalizeQuery lowercases the needle; the haystack is lowercased here. A
   * scan that compared raw bodies would find "Deploy" and miss "deploy". */
  const rows: Row[] = [
    { seq: 0, ts: 1, role: "user", text: "DEPLOY the thing" },
    { seq: 1, ts: 2, role: "claude", text: "deploying now" },
    { seq: 2, ts: 3, role: "user", text: "nothing here" },
  ];
  const r = scanChat(rows, textOf, normalizeQuery("Deploy"));
  expect(r.matches.map((m) => m.seq)).toEqual([0, 1]);
});

test("scanned counts the whole log even when nothing matched", () => {
  const r = scanChat(log(25, () => false), textOf, "needle");
  expect(r.total).toBe(0);
  expect(r.matches).toEqual([]);
  expect(r.scanned, "'searched 25 messages, found none' is a different answer from silence")
    .toBe(25);
});

test("an excerpt is capped, and the cap is characters of the body it matched", () => {
  const long = "a".repeat(EXCERPT + 500) + " needle";
  const r = scanChat([{ seq: 0, ts: 1, role: "user", text: long }], textOf, "needle");
  expect(r.total).toBe(1);
  expect(r.matches[0].excerpt.length).toBe(EXCERPT);
  expect(r.matches[0].excerpt).toBe(long.slice(0, EXCERPT));
});

test("a message with no seq is addressed as 0 rather than as undefined", () => {
  /* Every served log has been through ensureSeqs, so this is the belt: a hit
   * whose seq is undefined would make the app's jump travel to page NaN. */
  const r = scanChat([{ ts: 1, role: "user" as const, text: "needle" }], (c) => c.text, "needle");
  expect(r.matches[0].seq).toBe(0);
});

test("scanChat asks the caller what a message's text is, and searches only that", () => {
  /* textOf is the seam that keeps this free of the engine's ChatMsg shape, and
   * it is how an attachment's name becomes findable. */
  const rows = [{ seq: 0, ts: 1, role: "user" as const, text: "", name: "budget.xlsx" }];
  const r = scanChat(rows, (c) => c.name, "budget");
  expect(r.total).toBe(1);
  expect(r.matches[0].excerpt).toBe("budget.xlsx");
});

test("an empty log scans to an empty answer", () => {
  expect(scanChat([], textOf, "needle")).toEqual({ total: 0, matches: [], scanned: 0 });
});

// ------------------------------------------------------------------- the rpc

/* THE RPC CONTEXT PRODUCTION PASSES. routes/plugin.ts:188 calls an op as
 * `fn({ session, agent }, args)`, never with a bare id. These tests used to
 * hand `query` the string "sess" directly, which is the shape the op was first
 * written for; the op kept reading its first argument as an id long after the
 * ctx landed, and the tests agreed with it instead of with the route. Every
 * call below goes through C() so the suite exercises the real calling
 * convention. */
const C = (s: string | null) => ({ session: s, agent: null });

const rowsOf = (seqs: number[]): ScanRow[] =>
  seqs.map((s) => ({ seq: s, ts: 1_700_000_000_000 + s * 1000, role: "claude" as const, excerpt: `hit ${s}` }));

test("query returns the whole-log count and pages newest first", async () => {
  const plugin = searchPlugin(matchesCore(rowsOf([0, 1, 2, 3, 4])));
  const r = (await plugin.rpc!.query(C("sess"), { q: "needle" })) as
    { total: number; hits: ScanRow[]; scanned: number };
  expect(r.total).toBe(5);
  expect(r.scanned).toBe(10);
  expect(r.hits.map((h) => h.seq)).toEqual([4, 3, 2, 1, 0]); // newest first
});

test("query pages by the `before` seq cursor, older each call", async () => {
  const plugin = searchPlugin(matchesCore(rowsOf(Array.from({ length: 120 }, (_, i) => i))));
  const first = (await plugin.rpc!.query(C("sess"), { q: "x" })) as { total: number; hits: ScanRow[] };
  expect(first.total).toBe(120);
  expect(first.hits.length).toBe(PAGE);         // one page
  expect(first.hits[0].seq).toBe(119);          // newest
  const oldestShown = first.hits[first.hits.length - 1].seq; // 70
  expect(oldestShown).toBe(70);
  const next = (await plugin.rpc!.query(C("sess"), { q: "x", before: oldestShown })) as { hits: ScanRow[] };
  expect(next.hits[0].seq).toBe(69);            // strictly older than the cursor
  expect(next.hits.every((h) => h.seq < oldestShown)).toBe(true);
});

test("the total stays the whole log's on every page, not the page's own size", async () => {
  /* The panel prints "shown of total". A total that shrank with each page would
   * make the More button vanish while there were still results. */
  const plugin = searchPlugin(matchesCore(rowsOf(Array.from({ length: 120 }, (_, i) => i))));
  const page2 = (await plugin.rpc!.query(C("sess"), { q: "x", before: 70 })) as
    { total: number; hits: ScanRow[]; scanned: number };
  expect(page2.total).toBe(120);
  expect(page2.scanned).toBe(125);
});

test("paging walks off the end into an empty page rather than repeating one", async () => {
  const plugin = searchPlugin(matchesCore(rowsOf([0, 1, 2])));
  const r = (await plugin.rpc!.query(C("sess"), { q: "x", before: 0 })) as
    { total: number; hits: ScanRow[] };
  expect(r.hits).toEqual([]);
  expect(r.total, "the count is still the log's, so the panel can say 3 of 3").toBe(3);
});

test("a cursor that is not a number is ignored, never read as seq 0", async () => {
  /* `before: "banana"` used to filter every hit away, so the panel's second
   * page was silently empty for anything that mangled the cursor. */
  const plugin = searchPlugin(matchesCore(rowsOf([0, 1, 2])));
  for (const before of ["banana", null, Number.NaN, Infinity, undefined]) {
    const r = (await plugin.rpc!.query(C("sess"), { q: "x", before })) as { hits: ScanRow[] };
    expect(r.hits.map((h) => h.seq), `before: ${String(before)}`).toEqual([2, 1, 0]);
  }
});

test("query trims/caps the query and answers an empty one with total 0", async () => {
  const plugin = searchPlugin(matchesCore(rowsOf([0, 1, 2])));
  const empty = (await plugin.rpc!.query(C("sess"), { q: "   " })) as { total: number; hits: ScanRow[] };
  expect(empty.total).toBe(0);
  expect(empty.hits.length).toBe(0);
});

test("'nothing typed' still reports how big the log is, and never throws", async () => {
  /* An empty query is not a failure and not a miss: the panel opens on it. It
   * still asks the engine so the status line can say what would be searched. */
  const plugin = searchPlugin(matchesCore(rowsOf([0, 1, 2])));
  const r = (await plugin.rpc!.query(C("sess"), {})) as { total: number; hits: ScanRow[]; scanned: number };
  expect(r).toEqual({ total: 0, hits: [], scanned: 8 });

  // and when the session is gone underneath it, an empty query is still an
  // answer rather than an exception the panel has to render
  const gone = searchPlugin(nullCore());
  expect(await gone.rpc!.query(C("sess"), { q: "" })).toEqual({ total: 0, hits: [], scanned: 0 });
});

test("query on no session throws (the app resolves the session, never the page)", async () => {
  const plugin = searchPlugin(matchesCore(rowsOf([0])));
  /* Deliberately NOT an RpcCtx: these are the shapes a caller reaching past the
   * route could hand it, and the point is that the op refuses rather than
   * searching some other session. The casts are what let a test hand a typed
   * parameter something the type forbids. */
  await expect(plugin.rpc!.query(null as unknown as RpcCtx, { q: "x" })).rejects.toThrow();
  await expect(plugin.rpc!.query("" as unknown as RpcCtx, { q: "x" })).rejects.toThrow();
});

test("a real query against a session the engine cannot find is an error, not an empty result", async () => {
  /* "this conversation has no matches" and "there is no such conversation" are
   * different facts, and a panel that showed the first for the second would be
   * asserting something it does not know. */
  const plugin = searchPlugin(nullCore());
  await expect(plugin.rpc!.query(C("sess"), { q: "needle" })).rejects.toThrow(/no such session/);
});

/* THE REGRESSION. The op used to take its whole RpcCtx and call it `session`,
 * then hand that object to the matcher as an id. Both halves are pinned here:
 * the id the op forwards is the STRING out of the ctx, and a ctx carrying no
 * session is refused rather than scanned. Either check fails against the old
 * shape -- the first because searchChat would see an object, the second because
 * an RpcCtx is truthy however empty it is, so the guard never ran. */
test("the op reads the session id OUT of the rpc ctx, and refuses a ctx without one", async () => {
  const seen: unknown[] = [];
  const plugin = searchPlugin(coreFor((session, _q) => {
    seen.push(session);
    return { total: 0, matches: [], scanned: 0 };
  }));
  await plugin.rpc!.query(C("w1:p1"), { q: "needle" });
  expect(seen).toEqual(["w1:p1"]);
  expect(seen.every((s) => typeof s === "string"),
    "scan takes a session id; handing it the ctx object finds no session, ever").toBe(true);

  await expect(plugin.rpc!.query(C(null), { q: "needle" }))
    .rejects.toThrow(/needs a session/);
});

test("the panel declares itself as a side dock that needs a session", async () => {
  /* The decl is the contract with the app: a panel that forgot needsSession
   * opens on the phone with no conversation behind it and every query throws. */
  const plugin = searchPlugin(matchesCore([]));
  expect(plugin.id).toBe("search");
  expect(plugin.panel?.needsSession).toBe(true);
  expect(plugin.panel?.dock).toBe("side");
  expect(plugin.panel?.ops).toEqual(["query"]);
  const html = await plugin.panel!.html();
  expect(html).toContain("<!doctype html>");
  expect(html, "the page must not reach the network on its own").not.toContain("fetch(");
});
