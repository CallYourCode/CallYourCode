/* SEND-FAILED AND CID DEDUP (offline design v2, section 2b; lane B round 6).
 *
 * Two seam contracts the app is proven against here, over the real dispatcher
 * (dispatchClientFrame), no engine process:
 *
 *   F1  A send to a DEAD pane (a session this engine kept but that is no longer
 *       alive) is failed on its cid: `send-failed {cid, reason}`, no positive
 *       ack, nothing typed and nothing written. A positive ack would have told
 *       the app the frame was taken and deleted its intent, stranding a message
 *       that landed nowhere; the row learns it failed and keeps the reason.
 *
 *   F2  A send the engine already took, sent again with the SAME cid, reaches
 *       the pane once and is acked both times (dup on the rewrite): the engine,
 *       which is the one that knows the first copy landed, dedups by cid. No
 *       engine-side change was needed for F2; this pins the contract the app's
 *       one-frame-per-cid reconnect replay relies on.
 *
 *   bun test agent-engine/src/chat/send-failed.test.ts
 */

import { test, expect, afterAll, afterEach } from "bun:test";
import { wireCore, wireId, type WireCore } from "../test-utils/wire-core.ts";
import { chatStore } from "../sessions/session-state.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { dispatchClientFrame } from "../transport/frames.ts";
import { dispatchSessionFrame } from "../runtime/mcp.ts";
import { OFFLINE_REASON } from "./deliver.ts";
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

function mcpSock(sessionId: string): Sock {
  return {
    data: { role: "session", sessionId, terms: new Map() },
    readyState: 1,
    remoteAddr: "127.0.0.1",
    send(s: string) { return s.length; },
    close() { /* nothing holds it */ },
  } as unknown as Sock;
}

test("a send to a dead pane is failed on its cid, not acked, and nothing is delivered", async () => {
  core = await wireCore({ with: ["delivery", "frames"] });
  const c = core;
  await until(() => c.sessions.size === 1, { what: "the pane to reconcile" });
  const page = c.client();
  const other = c.client();
  const s = c.byHandle(PANE)!;

  // The agent said something, so the session is KEPT (alive:false) when its
  // pane goes -- the dead-pane branch, not the unknown-session one.
  await dispatchSessionFrame(mcpSock(s.id), { t: "chat", text: "last words", msgId: crypto.randomUUID() });
  await until(() => s.chat.length === 1, { what: "the reply row" });
  page.clear();
  other.clear();
  await c.herdr.setAgentGone(PANE, true);
  expect(s.alive, "the pane is a dead-but-kept session").toBe(false);

  await dispatchClientFrame(page.sock, { t: "utterance", id: s.id, text: "into a dead pane", cid: "c-dead" });
  /* Synchronous with the frame, the way the ack is for a live pane: the send
   * fails on its cid, no delivery work waited on. */
  expect(page.last("send-failed")).toEqual({ t: "send-failed", id: s.id, cid: "c-dead", reason: OFFLINE_REASON });
  expect(page.of("ack"), "a dead pane is not positively acked").toEqual([]);

  await new Promise((r) => setTimeout(r, 100));
  expect(c.submitted, "nothing reaches a dead pane").toEqual([]);
  // No user row was written (the message landed nowhere) and no bubble echoed.
  expect(s.chat.filter((m) => m.role === "user"), "no user row for a failed send").toEqual([]);
  expect(page.of("chat"), "no bubble for a message that did not land").toEqual([]);
  expect(other.frames.filter((f) => f.t !== "sessions"), "the failure is the sender's, not a broadcast").toEqual([]);
  expect(c.logs.filter((l) => l.event === "utterance.dropped").map((l) => String(l.fields.why)))
    .toEqual([expect.stringContaining("the session is offline")]);
});

test("the same cid sent twice to a live pane reaches the pane once and is acked both times", async () => {
  core = await wireCore({ with: ["delivery", "frames"] });
  const c = core;
  await until(() => c.sessions.size === 1, { what: "the pane to reconcile" });
  const page = c.client();
  const id = wireId(PANE);

  await dispatchClientFrame(page.sock, { t: "utterance", id, text: "only once", cid: "c-dup" });
  await until(() => c.submitted.length === 1, { what: "the first copy to land" });
  await until(() => page.of("chat").length === 1, { what: "the user echo" });
  expect(page.of("ack")[0]).toEqual({ t: "ack", id, cid: "c-dup", dup: false, ...page.of("ack")[0] as object });
  expect(page.of("ack")[0].dup).toBe(false);

  // The rewrite: the app's ack for the first copy was lost, so it writes the
  // same frame again. The engine acks it as a dup and delivers it nowhere.
  await dispatchClientFrame(page.sock, { t: "utterance", id, text: "only once", cid: "c-dup" });
  expect(page.of("ack").length).toBe(2);
  expect(page.of("ack")[1].dup).toBe(true);
  await new Promise((r) => setTimeout(r, 100));
  expect(c.submitted.length, "the dup must not reach the pane twice").toBe(1);
  expect(c.byHandle(PANE)!.chat.filter((m) => m.role === "user").length, "one row, not two").toBe(1);
  expect(page.of("chat").length, "one bubble, not two").toBe(1);
});
