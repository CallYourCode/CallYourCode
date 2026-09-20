/* SPEAK/CHAT INGEST IS IDEMPOTENT UNDER A CALLER KEY (#505, #576).
 *
 * WHY THIS FILE EXISTS
 *
 * speak/chat are at-least-once. The tool's ack lands only after the engine has
 * logged the message; for a speak the ack no longer waits on TTS (the early ack,
 * #speak-latency), but a retry can still overlap a delivery, so the caller's key
 * remains the identity. The original duplicate came from a speak ack that
 * outran the MCP's 15s wait on a busy box: the wait fired "did not confirm
 * within 15s, Retry the tool call", the agent retried, and the FIRST delivery
 * also landed, so the engine recorded one utterance twice (the owner saw it in
 * conv 9cd55489, seq 66 and 67, identical text 7.5s apart). Third recurrence of
 * duplicates; the fix is the one every messaging system uses, an idempotency key.
 *
 * The MCP mints one key per logical utterance and REUSES it on retry. The engine
 * keeps a bounded per-session index of recent keys, records the first arrival,
 * and a later frame carrying a known key records NOTHING and re-acks the
 * ORIGINAL. THE PROOF IS THE SEQ: a second row would carry a new, higher one, so
 * a retry that comes back with the first record's seq recorded nothing.
 *
 * The last case drives the real engine/mcp/src/server.ts over its stdio protocol,
 * because the MCP's key SELECTION is where round 1 failed: a single text-keyed
 * slot lost its key when a different-text reply interleaved (the "both" turn:
 * chat A slow, speak B, retry chat A). That is a bounded map of unconfirmed text
 * -> key now, and the case reproduces that exact interleaving against a fake
 * engine that dedupes by key. It spawns the MCP and nothing else: no engine
 * process, no port anybody wrote down.
 *
 *   bun test agent-engine/src/chat/dedupe.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";

import { wireCore, type WireCore, wireId } from "../test-utils/wire-core.ts";
import { chatStore } from "../sessions/session-state.ts";
import { readChatLog, seedAgent } from "../test-utils/builders.ts";
import { PANE, defaultSessionIdOf } from "../test-utils/fake-herdr.ts";
/* The harness id the fake herdr reports for PANE: what the disk records
 * (meta.json sessionId, the chat log) are keyed by, never the pane id. */
const PANE_SID = defaultSessionIdOf(PANE);
import { until } from "../test-utils/wait.ts";
import { DEDUPE_KEEP } from "./chatlog.ts";
import { dispatchSessionFrame } from "../runtime/mcp.ts";
import type { Sock } from "../transport/sock.ts";

let core: WireCore | null = null;
const cleanups: Array<() => void> = [];
afterEach(async () => {
  /* Every queued chat append on disk before the tmp tree goes: an append still
   * in flight when the directory is removed prints an ENOENT nobody can act on. */
  await chatStore.flush();
  while (cleanups.length) { try { cleanups.pop()!(); } catch { /* already gone */ } }
  await core?.stop();
  core = null;
});

/* THE SESSION'S OWN MCP SOCKET, the way the voice MCP holds one: registered on a
 * pane id, then speak/chat frames carrying a wire msgId and (since #505) an
 * idempotency key. What comes back on it is the `said` ack and nothing else. */
function mcpSock(sessionId: string) {
  const said: Record<string, any>[] = [];
  const sock = {
    data: { role: "session", sessionId, terms: new Map() },
    readyState: 1, remoteAddr: "127.0.0.1",
    send(s: string) { try { said.push(JSON.parse(s)); } catch { /* not json */ } return s.length; },
    close() { /* nothing holds it */ },
  } as unknown as Sock;
  const say = async (f: Record<string, unknown>) => {
    const msgId = String(f.msgId ?? crypto.randomUUID());
    await dispatchSessionFrame(sock, { ...f, msgId });
    const ack = said.find((a) => a.t === "said" && a.msgId === msgId);
    if (!ack) throw new Error(`no ack for ${msgId}: ${JSON.stringify(said)}`);
    return ack;
  };
  return { sock, said, say };
}

/** A live pane with the reply path wired, over a fake herdr and no engine. */
async function boot(opts: Parameters<typeof wireCore>[0] = {}): Promise<WireCore> {
  core = await wireCore({ with: ["frames"], ...opts });
  await until(() => core!.sessions.size >= 1, { what: "the pane to reconcile" });
  return core;
}

/** Every ingest.dedupe record the reply path wrote. wireCore captures the same
 *  log seam server.ts hands the engine log, so the suppression is observable
 *  here exactly as it is in a live log line (#489-style). */
const dedupeLogs = (c: WireCore) => c.logs.filter((l) => l.event === "ingest.dedupe");

const rowsSaying = (c: WireCore, id: string, text: string) =>
  (c.sessionOf(id)?.chat ?? []).filter((m) => m.text === text);

test("a retry that reuses its key records nothing and re-acks the original", async () => {
  const c = await boot();
  const mcp = mcpSock(PANE);
  const key = crypto.randomUUID();
  const text = "the ack was slow, so the tool retried the same utterance";

  const ackA = await mcp.say({ t: "chat", text, key });
  expect(ackA.ok, "the engine rejected the first delivery").toBe(true);
  expect(typeof ackA.seq, "the first ack carried no seq, so it was issued before logChat")
    .toBe("number");

  // the retry: a DIFFERENT wire msgId (the MCP mints one per attempt), SAME key
  const ackB = await mcp.say({ t: "chat", text, key });
  expect(ackB.ok,
    "the deduped retry was not acked as success, so the tool would keep retrying").toBe(true);
  expect(ackB.seq,
    "the retry got a new seq, so it wrote a second record instead of deduping").toBe(ackA.seq);

  expect(rowsSaying(c, PANE, text).length,
    `the engine kept ${rowsSaying(c, PANE, text).length} copies of one keyed utterance`).toBe(1);

  // and the suppression is observable, one record naming the suppressed key
  expect(dedupeLogs(c).length,
    "no ingest.dedupe record was written when a duplicate was suppressed").toBe(1);
  expect(dedupeLogs(c)[0].fields.key, "the ingest.dedupe record does not name the key").toBe(key);

  // the persisted log holds one row too: the dedupe is not a display trick
  await until(async () =>
    (await readChatLog(c.root, PANE_SID)).filter((m) => m.text === text).length === 1,
    { what: "exactly one row on disk" });
});

test("two different keys with identical text are two records", async () => {
  /* The other side of the guard: dedupe keys on the CALLER's key alone, never on
   * the text. Two genuinely separate utterances that happen to read the same
   * must both land, or the fix would eat real repeats ("yes", "yes"). */
  const c = await boot();
  const mcp = mcpSock(PANE);
  const text = "on it";

  const ackA = await mcp.say({ t: "chat", text, key: crypto.randomUUID() });
  const ackB = await mcp.say({ t: "chat", text, key: crypto.randomUUID() });
  expect(ackA.ok && ackB.ok, "the engine rejected one of two distinct utterances").toBe(true);
  expect(ackB.seq, "the second distinct utterance did not get its own seq").not.toBe(ackA.seq);
  expect(rowsSaying(c, PANE, text).length,
    "two distinct-key utterances did not make two rows").toBe(2);
  expect(dedupeLogs(c), "a dedupe fired for two genuinely distinct utterances").toEqual([]);
});

test("a reply with NO key keeps the old at-least-once behaviour", async () => {
  /* An MCP older than #505 sends no key. It must not be deduped by text, and it
   * must not be refused: the guard is opt-in per caller, and an engine that
   * started swallowing keyless repeats would silently lose real ones. */
  const c = await boot();
  const mcp = mcpSock(PANE);
  const a = await mcp.say({ t: "chat", text: "yes" });
  const b = await mcp.say({ t: "chat", text: "yes" });
  expect(a.ok && b.ok).toBe(true);
  expect(b.seq).not.toBe(a.seq);
  expect(rowsSaying(c, PANE, "yes").length, "a keyless repeat was swallowed").toBe(2);
  expect(dedupeLogs(c)).toEqual([]);
});

test("two overlapping same-key speaks write ONE row", async () => {
  /* THE #576 REPRO, kept for the same guarantee under the early ack. The key is
   * committed synchronously with the row now (the TTS await that used to sit
   * between the check and the commit has moved behind the ack), so a retry that
   * arrives while the first speak's synthesis is still running finds the
   * committed key and re-acks the original rather than writing a second row.
   * The TTS itself is a background enrichment against a voice engine that
   * refuses here, which is exactly the shape a failed synthesis has in
   * production: the written words stay. */
  const c = await boot();
  const mcp = mcpSock(PANE);
  const key = crypto.randomUUID();
  const text = "Two things running, both should land as one";

  const ackA = await mcp.say({ t: "speak", text, key });
  const ackB = await mcp.say({ t: "speak", text, key });
  expect(ackA.ok && ackB.ok,
    "an overlapping speak was not acked, so the MCP would keep retrying").toBe(true);
  expect(ackB.seq,
    "the overlapping retry got its own seq, so it wrote a second row (#576)").toBe(ackA.seq);
  expect(rowsSaying(c, PANE, text).length,
    `the engine kept ${rowsSaying(c, PANE, text).length} copies of one keyed speak`).toBe(1);
  // the row is a speak: it claims a msgId the audio will be filed under
  expect(rowsSaying(c, PANE, text)[0].role).toBe("claude");
});

test("a retry that lands MID-INGEST waits for the original and re-acks its record", async () => {
  /* THE RESERVATION BRANCH (#576). A same-key delivery whose row is not
   * committed yet cannot be seen by the recentKeys check, so first sight
   * RESERVES the key synchronously and a retry awaits that reservation.
   *
   * There is no await between the reservation and the commit any more, so this
   * window cannot be reached by two ordinary frames -- which is exactly why it
   * is asserted directly. The branch is the guard against an await creeping back
   * in front of the commit; if it stopped waiting, the retry would fall through
   * and write the second row #576 is about. */
  const c = await boot();
  const mcp = mcpSock(PANE);
  const s = c.byHandle(PANE)!;
  const key = crypto.randomUUID();

  let commit!: (rec: { seq: number; msgId?: string }) => void;
  (s.inflightKeys ??= new Map()).set(key,
    new Promise<{ seq: number; msgId?: string }>((res) => { commit = res; }));

  const inflight = mcp.say({ t: "chat", text: "the retry of a delivery still landing", key });
  await Promise.resolve();
  expect(mcp.said.filter((a) => a.t === "said"),
    "the retry acked before the original had landed, so it was not waiting on it").toEqual([]);
  expect(s.chat.length, "the retry wrote a row while the original was still in flight").toBe(0);

  commit({ seq: 41, msgId: "the-original" });
  const ack = await inflight;
  expect(ack.ok).toBe(true);
  expect(ack.seq, "the retry did not re-ack the in-flight original's record").toBe(41);
  expect(s.chat.length, "the retry wrote a second row after all").toBe(0);
  expect(dedupeLogs(c)[0]?.fields).toMatchObject({ key, inflight: true });
});

test("a keyed reply is deduped after a RESTART (index rebuilt from disk)", async () => {
  /* The committed half of the guard must survive a boot: the key rides on the
   * persisted ChatMsg, so a freshly booted engine rebuilds its dedupe index from
   * the chat log and a retry that lands after the restart is still suppressed. */
  const key = crypto.randomUUID();
  const text = "survived the restart, still one row";
  core = await wireCore({ with: ["frames"], start: false });
  const c = core;
  await seedAgent(c.root, PANE_SID,
    [{ id: wireId(PANE), role: "claude", text, key, msgId: crypto.randomUUID(), ts: 1000, seq: 0 }]);
  await c.reset({ start: true });
  await until(() => c.byHandle(PANE)?.chat.length === 1, { what: "the restored row" });

  // the seq the row settled at once the boot restore renumbered it (ensureSeqs)
  const origSeq = c.byHandle(PANE)!.chat[0].seq;
  const mcp = mcpSock(PANE);
  const ack = await mcp.say({ t: "chat", text, key });
  expect(ack.ok, "the post-restart retry was not acked").toBe(true);
  /* Re-acks the ORIGINAL's seq. A row NOT deduped would log after the restored
   * one and carry origSeq + 1, so equality is the proof the disk index was read. */
  expect(ack.seq,
    "the retry re-acked a different seq, so the on-disk index was not consulted").toBe(origSeq);
  expect(rowsSaying(c, PANE, text).length,
    "a keyed reply was duplicated after a restart").toBe(1);
  expect(dedupeLogs(c).some((l) => l.fields.key === key),
    "no dedupe record named the key after the restart").toBe(true);
});

test("the index is bounded: a key older than the window is no longer remembered", async () => {
  /* A retry lands within seconds of its first attempt, so the match is always
   * among the newest few replies and DEDUPE_KEEP is far more window than one
   * needs. The bound is what stops a long conversation carrying every key it
   * ever saw; the cost of falling off it is the old at-least-once behaviour,
   * which is the safe direction. Seeded rather than sent: writing 257 replies
   * through the socket would be the same assertion at ten times the cost. */
  const key = crypto.randomUUID();
  const text = "the oldest keyed reply in the log";
  const rows: Record<string, unknown>[] = [
    { id: wireId(PANE), role: "claude", text, key, ts: 1000, seq: 0 },
  ];
  for (let i = 1; i <= DEDUPE_KEEP; i++) {
    rows.push({ id: wireId(PANE), role: "claude", text: `filler ${i}`, key: crypto.randomUUID(),
      ts: 1000 + i, seq: i });
  }
  core = await wireCore({ with: ["frames"], start: false });
  const c = core;
  await seedAgent(c.root, PANE_SID, rows);
  await c.reset({ start: true });
  await until(() => c.byHandle(PANE)?.chat.length === rows.length, { what: "the restored log" });

  const mcp = mcpSock(PANE);
  const ack = await mcp.say({ t: "chat", text, key });
  expect(ack.ok).toBe(true);
  expect(rowsSaying(c, PANE, text).length,
    "a key that fell off the bounded index was still deduped, so the index is unbounded " +
    "and grows with the conversation").toBe(2);
  expect(ack.seq).toBe(rows.length);
});

test("a key recorded before a uuid ROLL still dedupes after the roll", async () => {
  /* The dedupe index rides the Session object, and a roll keeps that object's
   * key (the agent id) and everything on it. A retry that reuses its key after
   * the session id rolled must still find the original and record nothing --
   * otherwise every auto-compaction is a window in which a retry duplicates. */
  const U1 = "aaaaaaaa-1111-4aaa-8bbb-000000000001";
  const U2 = "bbbbbbbb-2222-4ccc-8ddd-000000000002";
  const c = await boot({ sessionIds: { [PANE]: U1 } });
  await until(() => !!c.sessionOf(U1), { what: "the pane under its first claude id" });

  const key = crypto.randomUUID();
  const text = "said once, before the session-id rolled";
  const mcp = mcpSock(U1);
  const ackA = await mcp.say({ t: "chat", text, key });

  // the roll U1 -> U2 on the live pane: the same agent, now answering to U2
  const agentId = c.sessionOf(U1)!.agentId;
  await c.herdr.rollSession(PANE, U2);
  await until(() => c.sessionOf(agentId)?.harnessSessionId === U2,
    { what: "the roll onto the new uuid" });
  expect(c.sessionOf(U2)!.agentId).toBe(agentId);
  expect(c.sessionOf(U2)!.chat.filter((m) => m.kind !== "system").map((m) => m.text),
    "the roll lost the conversation").toEqual([text]);

  // the MCP reconnects after a roll; the retry reuses the SAME key
  const mcp2 = mcpSock(U2);
  const ackB = await mcp2.say({ t: "chat", text, key });
  expect(ackB.ok, "the retry after a roll was not acked").toBe(true);
  expect(ackB.seq,
    "the retry after a roll wrote a new row instead of deduping").toBe(ackA.seq);
  expect(rowsSaying(c, U2, text).length,
    "the roll left more than one copy of a single keyed row").toBe(1);
});

// ------------------------------------ the real MCP, the round-1 interleaving

const MCP_DIR = join(import.meta.dir, "..", "..", "..", "mcp");

/* Drive the real engine/mcp/src/server.ts over its stdio MCP protocol: initialize,
 * then tools/call, reading the JSON-RPC result. "The tool reused the key" is a
 * fact about the TOOL, and the tool is that process; nothing else can answer it.
 * No engine is booted -- the fake below is the only thing it talks to. */
async function mcpProc(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    cwd: MCP_DIR,
    env: { ...process.env, ...env },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  cleanups.push(() => { try { proc.kill(); } catch { /* gone */ } });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const drain = async () => {
    const reader = (proc.stdout as ReadableStream).getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      buf += dec.decode(value as Uint8Array);
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && pending.has(m.id)) {
          const p = pending.get(m.id)!; pending.delete(m.id);
          if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
        }
      }
    }
  };
  void drain();
  let nextId = 1;
  const write = (o: unknown) => {
    (proc.stdin as any).write(JSON.stringify(o) + "\n");
    (proc.stdin as any).flush?.();
  };
  const rpc = (method: string, params: unknown) => {
    const id = nextId++;
    return new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write({ jsonrpc: "2.0", id, method, params });
    });
  };
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "dedupe-test", version: "1" } });
  write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  return { call: (name: string, args: unknown) => rpc("tools/call", { name, arguments: args }) };
}

const toolText = (r: any) => (r?.content ?? []).map((c: any) => c?.text ?? "").join("");

/* A fake engine that dedupes by key exactly as the real deliverReply does, and
 * loses ONE ack the way a busy box does: the first speak/chat POST is RECORDED
 * (it landed) but the engine answers 503 before confirming, so the MCP fails
 * that call fast and the agent retries. Every later POST acks; a key already
 * recorded is a dedupe hit and records nothing. It captures the key on every
 * POST so the test can prove the retry reused attempt 1's key. Plain HTTP for
 * POST /agent/reply, the transport the tool uses now. */
function fakeDedupeEngine() {
  const received: Array<{ text: string; key: string; kind: string }> = [];
  const recordedSeq = new Map<string, number>(); // key -> seq
  const recordCount = new Map<string, number>(); // text -> times actually recorded
  let seq = 0;
  let droppedOne = false;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/agent/reply") {
        return new Response("no", { status: 404 });
      }
      let m: any; try { m = await req.json(); } catch { return new Response("bad", { status: 400 }); }
      if (m.kind !== "speak" && m.kind !== "chat") return new Response("no", { status: 404 });
      received.push({ text: m.text, key: m.key, kind: m.kind });
      if (recordedSeq.has(m.key)) {
        // known key: dedupe, record nothing, re-ack the original seq
        return Response.json({ ok: true, seq: recordedSeq.get(m.key) });
      }
      // first sight of this key: it lands (recorded) ...
      recordedSeq.set(m.key, seq);
      recordCount.set(m.text, (recordCount.get(m.text) ?? 0) + 1);
      seq += 1;
      // ... but the very first POST's ack is LOST (the engine answers 503), the
      // exact busy-box condition #505 is about
      if (!droppedOne) { droppedOne = true; return new Response("gone", { status: 503 }); }
      return Response.json({ ok: true, seq: recordedSeq.get(m.key) });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `ws://127.0.0.1:${server.port}/ws`, received, recordCount };
}

test("a 'both' reply (chat A slow, speak B, retry chat A) reuses A's key -> A recorded once",
  async () => {
    /* THE ROUND-1 DEFECT, reproduced against the real MCP. A single text-keyed
     * slot lost A's key when speak B passed through between A's failed delivery
     * and its retry, so the retry minted a fresh key and the engine recorded A
     * twice. The bounded unconfirmed map keeps A's key through B. */
    const eng = fakeDedupeEngine();
    const mcp = await mcpProc({ HERDR_PANE_ID: PANE, VOICE_ENGINE_URL: eng.url });

    const A = "the written detail, longer, meant to be read";
    const B = "short spoken line";

    // 1) chat(A): lands at the engine, but its ack is lost -> the tool errors and
    //    the agent is told to retry
    const r1 = await mcp.call("chat", { text: A });
    expect(r1.isError, "chat A should have failed (its ack was dropped)").toBe(true);
    expect(toolText(r1), "the failed chat did not name the retry").toMatch(/retry/i);

    // 2) speak(B): a DIFFERENT text in the same turn, confirmed
    const r2 = await mcp.call("speak", { text: B });
    expect(r2.isError, `speak B should have confirmed, got: ${toolText(r2)}`).toBeFalsy();

    // 3) retry chat(A): must reuse attempt 1's key, so the engine dedupes it
    const r3 = await mcp.call("chat", { text: A });
    expect(r3.isError, `the retry of chat A should have confirmed, got: ${toolText(r3)}`).toBeFalsy();

    const aFrames = eng.received.filter((f) => f.text === A);
    const bFrames = eng.received.filter((f) => f.text === B);
    expect(aFrames.length, "chat A should have been sent twice (attempt + retry)").toBe(2);
    expect(bFrames.length, "speak B should have been sent once").toBe(1);
    /* THE FIX: A's retry carries the SAME key as A's first attempt, even though B
     * passed through in between. Round 1 minted a fresh key here. */
    expect(aFrames[1].key,
      "the retry of chat A minted a FRESH key instead of reusing attempt 1's -- #505 reopens")
      .toBe(aFrames[0].key);
    expect(bFrames[0].key, "speak B must not share A's key").not.toBe(aFrames[0].key);

    // and the consequence the whole change is for: A is recorded exactly once
    expect(eng.recordCount.get(A),
      `the engine recorded A ${eng.recordCount.get(A)} times, not once`).toBe(1);
  });
