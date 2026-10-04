/* THE ACK, THE DEDUPE, THE `have` AND THE PING (offline design v2, section 2b).
 *
 * The app keeps every send as a durable intent until the engine has TAKEN it,
 * and "taken" is the ack: sent first, before any delivery work, so a receipt
 * never waits on a recording being decoded or a pane being typed at. A frame
 * whose ack was lost is rewritten with the same cid, and the engine, which is
 * the one that knows whether the first copy landed, acks that as a dup and
 * delivers it nowhere. An attach that says what the app already holds gets
 * the metadata and no pages, and no event backlog past a cursor the app owns.
 * The app's liveness probe is a ping, answered with a pong, not an attach.
 *
 * NO ENGINE PROCESS: wireCore's in-process boot, frames through the shipped
 * dispatcher (dispatchClientFrame), the same path a sealed DataChannel reaches.
 *
 *   bun test agent-engine/src/chat/ack.test.ts
 */

import { test, expect, afterAll, afterEach } from "bun:test";

import { wireCore, wireId, type WireCore } from "../test-utils/wire-core.ts";
import { seedTranscript } from "../test-utils/builders.ts";
import { chatStore } from "../sessions/session-state.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { dispatchClientFrame } from "../transport/frames.ts";
import { dispatchSessionFrame } from "../runtime/mcp.ts";
import { recentCids } from "./deliver.ts";
import type { Sock } from "../transport/sock.ts";

const priorSettle = process.env.DELIVER_SETTLE_MS;
process.env.DELIVER_SETTLE_MS = "5";
afterAll(() => {
  if (priorSettle === undefined) delete process.env.DELIVER_SETTLE_MS;
  else process.env.DELIVER_SETTLE_MS = priorSettle;
});

let core: WireCore | null = null;
afterEach(async () => {
  await chatStore.flush();
  await core?.stop();
  core = null;
});

const U1 = "58358358-aaaa-4bbb-8ccc-000000000002";

async function boot(o: { sessionIds?: Record<string, string> } = {}): Promise<WireCore> {
  core = await wireCore({ with: ["delivery", "frames"], ...o });
  await until(() => core!.sessions.size === 1, { what: "the pane to reconcile" });
  return core;
}

function mcpSock(sessionId: string): Sock {
  return {
    data: { role: "session", sessionId, terms: new Map() },
    readyState: 1,
    remoteAddr: "127.0.0.1",
    send(s: string) { return s.length; },
    close() { /* nothing holds it */ },
  } as unknown as Sock;
}

async function seedReplies(c: WireCore, id: string, n: number): Promise<void> {
  const mcp = mcpSock(id);
  for (let i = 0; i < n; i++) {
    await dispatchSessionFrame(mcp, { t: "chat", text: `m${i}`, msgId: crypto.randomUUID() });
  }
  if (c.sessions.get(id)!.chat.length < n) throw new Error("seeding fell short");
}

test("the ack is written before any delivery work, on the sender's socket, with the cid", async () => {
  const c = await boot();
  const page = c.client();
  const other = c.client();
  await dispatchClientFrame(page.sock, { t: "utterance", id: wireId(PANE), text: "hello there", cid: "c-first" });
  /* Synchronous with the frame: the receipt is there before the dispatcher
   * has yielded once, while nothing has been typed at the pane yet. */
  expect(page.last("ack")).toEqual({ t: "ack", id: wireId(PANE), cid: "c-first", dup: false });
  expect(c.submitted.length, "the ack must not wait on delivery").toBe(0);
  expect(other.last("ack"), "the receipt is the sender's, not a broadcast").toBeUndefined();

  await until(() => c.submitted.length === 1, { what: "the message to reach the pane" });
  await until(() => page.last("chat") !== undefined, { what: "the user echo" });
  const t = page.frames.map((f) => f.t);
  expect(t.indexOf("ack")).toBeLessThan(t.indexOf("chat"));
  expect(page.last("chat")!.cid).toBe("c-first");
  expect(c.submitted[0].text).toContain("hello there");
});

test("a rewritten frame (same cid) is acked as a dup and delivered once", async () => {
  const c = await boot();
  const page = c.client();
  await dispatchClientFrame(page.sock, { t: "utterance", id: wireId(PANE), text: "only once", cid: "c-twice" });
  await until(() => c.submitted.length === 1, { what: "the first copy to land" });
  await until(() => page.of("chat").length === 1, { what: "the user echo" });

  await dispatchClientFrame(page.sock, { t: "utterance", id: wireId(PANE), text: "only once", cid: "c-twice" });
  expect(page.of("ack").length).toBe(2);
  expect(page.of("ack")[1]).toEqual({ t: "ack", id: wireId(PANE), cid: "c-twice", dup: true });
  await new Promise((r) => setTimeout(r, 50));
  expect(c.submitted.length, "the dup must not reach the pane").toBe(1);
  expect(c.byHandle(PANE)!.chat.filter((m) => m.role === "user").length).toBe(1);
  expect(page.of("chat").length, "the dup must not write a second row").toBe(1);

  /* And the index rebuilds from the chat itself, so the dedupe outlives the
   * in-memory map (a restart): drop it and the same cid is still a dup. */
  const s = c.byHandle(PANE)!;
  delete s.recentCids;
  expect(recentCids(s).has("c-twice")).toBe(true);
  await dispatchClientFrame(page.sock, { t: "utterance", id: wireId(PANE), text: "only once", cid: "c-twice" });
  expect(page.last("ack")!.dup).toBe(true);
  await new Promise((r) => setTimeout(r, 50));
  expect(c.submitted.length).toBe(1);

  // A rewrite that lands while the first copy is still being delivered is a dup too.
  await dispatchClientFrame(page.sock, { t: "utterance", id: wireId(PANE), text: "twin", cid: "c-race" });
  await dispatchClientFrame(page.sock, { t: "utterance", id: wireId(PANE), text: "twin", cid: "c-race" });
  const acks = page.of("ack").filter((a) => a.cid === "c-race");
  expect(acks.map((a) => a.dup)).toEqual([false, true]);
  await until(() => c.submitted.length === 2, { what: "the second message to land" });
  await new Promise((r) => setTimeout(r, 50));
  expect(c.submitted.length).toBe(2);
});

test("an attach with a matching `have` sends the metadata and no pages; the records ride the pages, not a backlog", async () => {
  const c = await boot({ sessionIds: { [PANE]: U1 } });
  await until(() => c.sessionOf(U1) !== undefined, { what: "the pane under its claude id" });
  // The wire addresses the agent, not the harness session: U1 names the
  // transcript on disk, A names the row on the wire.
  const A = c.sessionOf(U1)!.id;
  const lines = Array.from({ length: 3 }, (_, i) => JSON.stringify({
    type: "assistant", uuid: `u${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    message: { content: [{ type: "text", text: `line ${i}` }] },
  })).join("\n") + "\n";
  await seedReplies(c, A, 5);
  await seedTranscript(c.root, U1, { content: lines });
  // The status edge makes the fake herdr resnapshot; reconcile starts the
  // ingest, which reads the transcript ONCE into the agent's log as t:"s"
  // records. There is no separate read path for the activity.
  c.herdr.setStatus(PANE, "working");
  await until(() => c.logs.some((l) => l.event === "ingest.backfill.done"),
    { what: "the transcript backfill to finish", timeoutMs: 20_000 });

  // The cold answer: ONE attach-ok whose pages carry the messages AND the
  // records; no `session-events` frame follows it.
  const cold = c.client();
  await dispatchClientFrame(cold.sock, { t: "attach", id: A });
  await until(() => cold.last("attach-ok") !== undefined, { what: "attach-ok" });
  await new Promise((r) => setTimeout(r, 50)); // anything fired after it would land by now
  const full = cold.last("attach-ok")!;
  const tail = full.tailPage as number;
  const tailVersion = full.pages.find((p: any) => p.page === tail).version as number;
  const rids = full.pages.flatMap((p: any) => p.messages).filter((r: any) => r.t === "s" && r.src);
  expect(rids.length, "the three transcript records ride in the pages").toBe(3);
  expect(cold.of("session-events").length, "no second frame for the activity").toBe(0);

  // The app holds that tail: metadata only, nothing replayed, no backlog.
  const warm = c.client();
  await dispatchClientFrame(warm.sock, { t: "attach", id: A, have: { tailPage: tail, tailVersion } });
  await until(() => warm.last("attach-ok") !== undefined, { what: "attach-ok" });
  const ok = warm.last("attach-ok")!;
  expect(ok).toMatchObject({ known: true, tailPage: tail, pointer: 0, pages: [] });
  await new Promise((r) => setTimeout(r, 100));
  expect(warm.of("session-events").length, "no backlog frame exists any more").toBe(0);

  // A stale tail (the chat grew) gets the pages again.
  await seedReplies(c, A, 1);
  const stale = c.client();
  await dispatchClientFrame(stale.sock, { t: "attach", id: A, have: { tailPage: tail, tailVersion } });
  await until(() => stale.last("attach-ok") !== undefined, { what: "attach-ok" });
  expect(stale.last("attach-ok")!.pages.length).toBeGreaterThan(0);
});

test("a session this engine does not have is nacked, not acked, and nothing is delivered", async () => {
  const c = await boot();
  const page = c.client();
  await dispatchClientFrame(page.sock, { t: "utterance", id: "no-such-pane", text: "into the void", cid: "c-void" });
  /* The definitive answer, at once: the app keeps the message as not
   * delivered (its intent is not deleted) and a tap sends it again. */
  expect(page.last("ack")).toEqual({ t: "ack", id: "no-such-pane", cid: "c-void", dup: false, err: "unknown-session" });
  await new Promise((r) => setTimeout(r, 50));
  expect(c.submitted, "a message for a session the engine has not got must reach no pane").toEqual([]);
  expect(page.of("chat"), "no bubble either").toEqual([]);
  expect(c.logs.filter((l) => l.event === "utterance.dropped").map((l) => String(l.fields.why)))
    .toEqual([expect.stringContaining("no session with that id")]);
  // A session it does have is acked clean, no err.
  await dispatchClientFrame(page.sock, { t: "utterance", id: wireId(PANE), text: "hello", cid: "c-real" });
  expect(page.last("ack")).toEqual({ t: "ack", id: wireId(PANE), cid: "c-real", dup: false });
  await until(() => c.submitted.length === 1, { what: "the real message to land" });
});

test("a ping is answered with a pong carrying the same n", async () => {
  const c = await boot();
  const page = c.client();
  await dispatchClientFrame(page.sock, { t: "ping", n: 7 });
  expect(page.last("pong")).toEqual({ t: "pong", n: 7 });
  expect(page.last("attach-ok"), "a probe is not an attach").toBeUndefined();
  expect(page.of("session-events").length).toBe(0);
});
