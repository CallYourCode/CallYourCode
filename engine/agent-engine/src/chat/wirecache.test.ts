/* THE WIRE-ROWS CACHE (attach.ts + wirecache.ts): the merged page rows are
 * built once per conversation and reused until a mutation bumps the session's
 * generation counter, so a device pulling every page no longer re-merges the
 * whole log per page. This file proves the two things that must both hold:
 *
 *   EQUIVALENCE  the cached serve is byte-identical to a fresh merge, on every
 *                page, after appends, an edit, a record and a reload; and
 *   INVALIDATION every mutation path the fix lists bumps the counter, so the
 *                next serve reflects the change rather than a stale merge.
 *
 * The oracle is a fresh, uncached merge computed straight from s.chat / s.log
 * the same way wireRows does; each assertion compares the cached wirePage
 * against buildPage over that oracle. A missed invalidation would leave
 * wirePage on a stale merge and the two would differ.
 *
 *   bun test agent-engine/src/chat/wirecache.test.ts
 */

import { test, expect, afterEach } from "bun:test";

import { wireCore, wireId, type WireCore } from "../test-utils/wire-core.ts";
import { chatStore } from "../sessions/session-state.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { dispatchSessionFrame } from "../runtime/mcp.ts";
import { buildPage, tailPage } from "../runtime/pages.ts";
import { wirePage, wireRows, type AttachSession, type WireRow } from "./attach.ts";
import { logChat, logSession, clearQueued } from "./chatlog.ts";
import { ensureSeqs } from "./chatlog.ts";
import { rowsBySeq } from "./chatstore.ts";
import type { SessionRec } from "./sessionrec.ts";
import type { ChatMsg } from "./chatmsg.ts";
import type { Sock } from "../transport/sock.ts";

let core: WireCore | null = null;
afterEach(async () => {
  await chatStore.flush();
  await core?.stop();
  core = null;
});

function mcpSock(sessionId: string): Sock {
  return {
    data: { role: "session", sessionId, terms: new Map() },
    readyState: 1,
    remoteAddr: "127.0.0.1",
    send(s: string) { return s.length; },
    close() {},
  } as unknown as Sock;
}

async function boot(): Promise<WireCore> {
  core = await wireCore({ with: ["frames"] });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  return core;
}

/* Seed `n` agent replies through the real reply path (stampTs, ensureSeqs,
 * logChat), exactly as a live reply lands. */
async function seedReplies(c: WireCore, n: number, prefix = "m"): Promise<void> {
  const sock = mcpSock(PANE);
  for (let i = 0; i < n; i++) {
    await dispatchSessionFrame(sock, { t: "chat", text: `${prefix}${i}`, msgId: crypto.randomUUID() });
  }
  await until(() => c.byHandle(PANE)!.chat.length >= n, { what: `${n} replies seeded` });
}

/* THE ORACLE: a fresh, uncached merge, computed the way wireRows does but
 * without ever reading the cache. Used only as the reference to compare the
 * cached serve against. */
function oracleRows(s: AttachSession): WireRow[] {
  ensureSeqs(s.chat, s.log);
  const recs = new Set<unknown>(s.log);
  return rowsBySeq(s.chat, s.log).map((r) =>
    recs.has(r) ? { t: "s" as const, ...(r as SessionRec) } : { ...(r as ChatMsg & { seq: number }), id: s.id });
}

/* Assert the cached serve is byte-identical to the oracle on EVERY page, and
 * a page past the tail too (a well-defined empty answer). */
function expectPagesMatchOracle(s: AttachSession, note: string): void {
  const rows = oracleRows(s);
  const top = tailPage(rows);
  for (let n = 0; n <= top + 1; n++) {
    expect(JSON.stringify(wirePage(s, n)), `${note}: page ${n} drifted from a fresh merge`)
      .toBe(JSON.stringify(buildPage(rows, n)));
  }
}

test("cached wire pages equal a fresh merge across every page", async () => {
  const c = await boot();
  await seedReplies(c, 250);
  const s = c.byHandle(PANE)!;
  // warm the cache, then assert every page still matches an independent merge
  wirePage(s, 0);
  expectPagesMatchOracle(s, "after a 250-message seed");
});

test("wireRows caches: the same instance is reused until a mutation, then rebuilt", async () => {
  const c = await boot();
  await seedReplies(c, 30);
  const s = c.byHandle(PANE)!;
  const first = wireRows(s);
  expect(wireRows(s), "a second call with no mutation reuses the cached merge").toBe(first);
  await seedReplies(c, 1, "again");
  expect(wireRows(s), "an append bumped the generation: the merge is rebuilt").not.toBe(first);
  expectPagesMatchOracle(s, "after one more append");
});

test("appending invalidates the cache: the new tail appears and matches a fresh merge", async () => {
  const c = await boot();
  await seedReplies(c, 101); // page 0 sealed, page 1 is the tail with one row
  const s = c.byHandle(PANE)!;
  const gen0 = s.rowsGen ?? 0;
  expect(wirePage(s, 1).messages.length).toBe(1);
  await seedReplies(c, 50, "later");
  expect((s.rowsGen ?? 0) > gen0, "each logged reply bumped the generation").toBe(true);
  expect(wirePage(s, 1).messages.length).toBe(51);
  expectPagesMatchOracle(s, "after appending past the tail");
});

test("a session record on the axis invalidates the cache", async () => {
  const c = await boot();
  await seedReplies(c, 5);
  const s = c.byHandle(PANE)!;
  wirePage(s, 0); // warm
  const gen0 = s.rowsGen ?? 0;
  const rec = logSession(s, { ts: Date.now() + 1, kind: "status", text: "status: working", status: "working" });
  expect(rec, "the record was appended").not.toBeNull();
  expect((s.rowsGen ?? 0) > gen0, "logSession bumped the generation").toBe(true);
  expectPagesMatchOracle(s, "after a session record");
  expect(wirePage(s, 0).messages.some((r: any) => r.t === "s" && r.kind === "status"),
    "the record rides in the page").toBe(true);
});

test("an edit (dequeue) invalidates the cache through the real persistPatch", async () => {
  const c = await boot();
  await seedReplies(c, 3);
  const s = c.byHandle(PANE)!;
  // a user row that went in queued, appended the real way (as commitDelivery does)
  const ts = Date.now() + 1000;
  logChat(s, { id: s.id, role: "user", text: "queued input", ts, queued: true } as ChatMsg);
  wirePage(s, 0); // warm the cache with the queued flag present
  expect(wirePage(s, 0).messages.some((m: any) => m.ts === ts && m.queued === true),
    "the queued flag rides in the page before the dequeue").toBe(true);
  const gen0 = s.rowsGen ?? 0;
  // the real dequeue: clears the flag and persists a patch, which bumps the
  // generation in session-state.persistPatch (the one chokepoint for edits)
  expect(clearQueued(s.id, ts)).toBe(true);
  expect((s.rowsGen ?? 0) > gen0, "persistPatch bumped the generation on the edit").toBe(true);
  expect(wirePage(s, 0).messages.some((m: any) => m.ts === ts && m.queued === true),
    "the stale queued flag must be gone from the served page").toBe(false);
  expectPagesMatchOracle(s, "after a dequeue");
});

test("a reload (arrays replaced) with a seq repair is reflected and cached", async () => {
  const c = await boot();
  await seedReplies(c, 4);
  const s = c.byHandle(PANE)!;
  wirePage(s, 0); // warm

  // A reload replaces both arrays (carry / trim do this and bump the counter).
  // The new message run is broken (seq 3 sits after seq 5, out of order), so
  // ensureSeqs must repair it; the cache must reflect the repaired axis.
  s.chat = [
    { id: s.id, role: "claude", text: "a", ts: 10, seq: 0 },
    { id: s.id, role: "claude", text: "b", ts: 20, seq: 5 },
    { id: s.id, role: "claude", text: "c", ts: 30, seq: 3 }, // breaks the run: 3 < 5
  ] as ChatMsg[];
  s.log = [{ seq: 2, ts: 25, id: "se-x", kind: "status", text: "mid" } as SessionRec];
  s.rowsGen = (s.rowsGen ?? 0) + 1; // the reload bump (bumpRowsGen at the mutation site)

  expectPagesMatchOracle(s, "after a reload with a seq repair");
  // idempotent: a second serve is the same bytes (the repair does not re-run)
  const once = JSON.stringify(wirePage(s, 0));
  expect(JSON.stringify(wirePage(s, 0))).toBe(once);
});

test("a wireId round-trips so the session under test is the one being served", async () => {
  // guards the harness: PANE resolves to the reconciled session id used above
  const c = await boot();
  expect(c.byHandle(PANE)!.id).toBe(wireId(PANE));
});
