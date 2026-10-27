/* Transport recovery belongs below both rescue and deferred words. Real local
 * sockets here exercise Bun's own fetch errors, not just a lookalike Error. */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { cacheAudio, clipOnDisk } from "./clips.ts";
import { inOrder, injectUserMessage, onUtterance } from "./deliver.ts";
import { initTranscribe, sttDecode, transcribeStored, WORDS_STT_TIMEOUT_MS } from "../voice/transcribe.ts";
import { restoredChats, sessionByHandle, sessions, type Session } from "../sessions/session-state.ts";
import { broadcast } from "../transport/wire.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { wireCore, wireId, type WireCore } from "../test-utils/wire-core.ts";
import type { UploadRec } from "./chatmsg.ts";

let core: WireCore;
let url: string;
let server: Server | undefined;
const originalFetch = globalThis.fetch;
const bytes = new Uint8Array(4096).fill(0x39);
const transcript = "all the recovered voice note words";
const errors: any[] = [];
const bodies: Uint8Array[] = [];
const retryLogs = () => core.logs.filter(l => l.event === "stt.transport-retry");
const transportError = () => Object.assign(new TypeError("socket closed"), { code: "ECONNRESET" });
const outcome = <T>(p: Promise<T>) => p.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));

function pointTranscribe(): void {
  initTranscribe({
    voiceUrl: async () => url,
    log: (e, f) => core.log(e, f), broadcast,
    inOrder, deliver: (s, opts) => injectUserMessage(s as Session, opts),
    sessionOf: id => sessions.get(id), restoredChats: () => restoredChats, clock: core.clock,
  });
}
beforeAll(async () => {
  core = await wireCore({ with: ["delivery"] });
  await until(() => core.sessions.size === 1, { what: "the scratch pane to reconcile" });
  pointTranscribe();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
  }
  server = undefined;
  errors.length = bodies.length = core.logs.length = core.submitted.length = 0;
});
afterAll(async () => { await core?.stop(); });

async function listen(drops = 0, port = 0): Promise<void> {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(new Uint8Array(Buffer.concat(chunks)));
    if (drops-- > 0) { req.socket.destroy(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ text: transcript }));
  });
  await new Promise<void>(resolve => server!.listen(port, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // Observe the actual exceptions while leaving the fetch and socket real.
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await originalFetch(...args); }
    catch (e) { errors.push(e); throw e; }
  }) as typeof fetch;
}
async function upload(): Promise<UploadRec> {
  const path = join(core.dir, "retry.webm");
  await Bun.write(path, bytes);
  return { uploadId: crypto.randomUUID(), name: "retry.webm", path,
    mime: "audio/webm", size: bytes.length, image: false };
}
async function sendNote(cid: string): Promise<{ msgId: string; delivery: Promise<void> }> {
  const msgId = crypto.randomUUID();
  await cacheAudio(msgId, bytes, "audio/webm");
  const client = core.client({ attach: wireId(PANE) });
  const delivery = onUtterance(client.sock, { t: "utterance", id: wireId(PANE),
    text: "", kind: "voice", msgId, durationS: 57, cid });
  return { msgId, delivery };
}
async function retryOrDelivered(n: number): Promise<void> {
  await until(() => retryLogs().length >= n || core.submitted.length > 0,
    { what: `transport retry ${n} or delivery` });
  expect(retryLogs().length).toBe(n);
  expect(core.submitted.length).toBe(0);
}

test.each([1, 3])("%i real dropped Bun connections recover stored audio with exactly one row and delivery", async drops => {
  await listen(drops);
  const cid = `connection-recovered-${drops}`;
  const { msgId, delivery } = await sendNote(cid);
  await retryOrDelivered(1);
  expect(errors[0]).toBeInstanceOf(TypeError);
  expect(errors[0].code).toBe("ECONNRESET");
  expect(errors[0].message).toContain("socket connection was closed unexpectedly");
  expect(retryLogs()[0].fields).toMatchObject({ cid, msgId, attempt: 1, waitMs: 1000, category: "connection-reset" });
  await core.clock.advance(999);
  expect(bodies.length).toBe(1);
  await core.clock.advance(1);
  for (let i = 1; i < drops; i++) {
    await retryOrDelivered(i + 1);
    await core.clock.advance(1000 * 2 ** i);
  }
  await delivery;
  const rows = sessionByHandle(PANE)!.chat.filter(m => m.cid === cid);
  expect(rows.length).toBe(1);
  expect(rows[0].text).toBe(transcript);
  expect(rows[0].msgId).toBe(msgId);
  expect(core.submitted.length).toBe(1);
  expect(core.submitted[0].text).toContain(transcript);
  expect(core.submitted[0].text).not.toContain("transcription failed");
  expect(bodies).toEqual(Array.from({ length: drops + 1 }, () => bytes));
  expect(await clipOnDisk(msgId)).toBeTruthy();
  expect(core.logs.some(l => l.event === "rescue.failed")).toBe(false);
});

test("deferred sttDecode recovers Bun ConnectionRefused using the saved upload body", async () => {
  await listen();
  const port = (server!.address() as { port: number }).port;
  await new Promise<void>(resolve => server!.close(() => resolve()));
  const result = outcome(sttDecode(await upload(), 0, "refused-upload"));
  await until(() => errors.length > 0, { what: "Bun's real refused connection exception" });
  await core.clock.tick();
  expect(errors[0]).toBeInstanceOf(TypeError);
  expect(errors[0].code).toBe("ConnectionRefused");
  expect(retryLogs().length).toBe(1);
  // Removing the upload after it was read proves retries reuse the body.
  await Bun.write(join(core.dir, "retry.webm"), "changed after original fetch");
  await listen(0, port);
  await core.clock.advance(1000);
  expect((await result).value?.text).toBe(transcript);
  expect(bodies).toEqual([bytes]);
});

test("three retries then exhaustion delivers the failed placeholder exactly once", async () => {
  await listen(100);
  const cid = "connection-exhausted";
  const { msgId, delivery } = await sendNote(cid);
  for (const [i, wait] of [1000, 2000, 4000].entries()) {
    await retryOrDelivered(i + 1);
    expect(retryLogs()[i].fields.waitMs).toBe(wait);
    await core.clock.advance(wait);
  }
  await delivery;
  expect(bodies).toEqual([bytes, bytes, bytes, bytes]);
  expect(retryLogs().length).toBe(3);
  expect(core.submitted.length).toBe(1);
  expect(core.submitted[0].text).toContain("(voice note: transcription failed)");
  const rows = sessionByHandle(PANE)!.chat.filter(m => m.cid === cid);
  expect(rows.length).toBe(1);
  expect(rows[0].msgId).toBe(msgId);
  expect(core.logs.filter(l => l.event === "rescue.failed").length).toBe(1);
});

test("an exhausted tail decode still takes the existing whole-clip fallback only once", async () => {
  const offsets: string[] = [];
  globalThis.fetch = (async target => {
    const offset = new URL(String(target)).searchParams.get("offset") ?? "0";
    offsets.push(offset);
    if (offset !== "0") throw transportError();
    return Response.json({ text: transcript });
  }) as typeof fetch;
  url = "http://127.0.0.1:1";
  const msgId = crypto.randomUUID();
  await cacheAudio(msgId, bytes, "audio/webm");
  const result = transcribeStored(msgId, "exhausted-tail", { text: "settled prefix", upToS: 3 });
  for (const [i, wait] of [1000, 2000, 4000].entries()) {
    await until(() => retryLogs().length > i, { what: `tail retry ${i + 1}` });
    await core.clock.advance(wait);
  }
  expect(await result).toBe(transcript);
  expect(offsets).toEqual(["3", "3", "3", "3", "0"]);
  expect(core.logs.filter(l => l.event === "rescue.tail-failed").length).toBe(1);
});

test("the existing overall deadline interrupts a retry sleep without another fetch", async () => {
  let calls = 0;
  let fail!: (e: unknown) => void;
  let signal: AbortSignal | undefined;
  globalThis.fetch = (async (_url, opts) => {
    calls++; signal = opts?.signal as AbortSignal;
    return await new Promise<Response>((_resolve, reject) => { fail = reject; });
  }) as typeof fetch;
  const result = outcome(sttDecode(await upload(), 0));
  await until(() => calls === 1, { what: "first fetch to start" });
  await core.clock.advance(WORDS_STT_TIMEOUT_MS - 500);
  fail(transportError());
  await core.clock.tick();
  expect(retryLogs().length).toBe(1);
  await core.clock.advance(500);
  expect((await result).error?.name).toBe("TimeoutError");
  expect(signal?.aborted).toBe(true);
  await core.clock.advance(10_000);
  expect(calls).toBe(1);
});

for (const [label, answer] of [
  ["programmer TypeError", () => { throw new TypeError("cannot read properties of undefined"); }],
  ["generic fetch TypeError", () => { throw new TypeError("fetch failed"); }],
  ["AbortError", () => { throw new DOMException("cancelled", "AbortError"); }],
  ["abort with transport code", () => { throw Object.assign(new Error("cancelled"), { name: "AbortError", code: "ECONNRESET" }); }],
  ["TimeoutError", () => { throw new DOMException("deadline", "TimeoutError"); }],
  ...[400, 401, 403, 422, 500].map(status => [`HTTP ${status}`, () => new Response("invalid", { status })] as const),
  ["bad JSON", () => new Response("{bad json")],
  ["response-body transport error", () => Object.assign(Response.json({}), { json: async () => { throw transportError(); } })],
  ["permanent broken decode", () => Response.json({ text: "", mode: "broken" })],
] as const) {
  test(`${label} is not retried`, async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return answer(); }) as typeof fetch;
    await outcome(sttDecode(await upload(), 0));
    await core.clock.advance(10_000);
    expect(calls).toBe(1);
    expect(retryLogs().length).toBe(0);
  });
}

for (const [label, error, category] of [
  ["ECONNREFUSED", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), "connection-refused"],
  ["EPIPE", Object.assign(new Error("closed"), { code: "EPIPE" }), "socket-closed"],
  ["nested reset", new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }), "connection-reset"],
  ["Bun message without code", new TypeError("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"), "socket-closed"],
] as const) {
  test(`${label} is a recognized transient fetch failure`, async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      if (++calls === 1) throw error;
      return Response.json({ text: transcript });
    }) as typeof fetch;
    const result = outcome(sttDecode(await upload(), 0));
    await until(() => retryLogs().length === 1, { what: "recognized transport retry" });
    expect(retryLogs()[0].fields.category).toBe(category);
    await core.clock.advance(1000);
    expect((await result).value?.text).toBe(transcript);
    expect(calls).toBe(2);
  });
}

test("an already expired signal wins over a transport-shaped fetch exception", async () => {
  let calls = 0;
  let fail!: (e: unknown) => void;
  globalThis.fetch = (async () => {
    calls++;
    return await new Promise<Response>((_resolve, reject) => { fail = reject; });
  }) as typeof fetch;
  const result = outcome(sttDecode(await upload(), 0));
  await until(() => calls === 1, { what: "fetch to start before deadline" });
  await core.clock.advance(WORDS_STT_TIMEOUT_MS);
  fail(transportError());
  expect((await result).error?.name).toBe("TimeoutError");
  expect(retryLogs().length).toBe(0);
  expect(calls).toBe(1);
});

test("503 waits neither consume nor reset the transport retry budget", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls % 2 === 1) throw transportError();
    return Response.json({ error: "busy" }, { status: 503 });
  }) as typeof fetch;
  const result = outcome(sttDecode(await upload(), 0));
  const waits = [1000, 500, 2000, 1000, 4000, 2000];
  for (const [i, wait] of waits.entries()) {
    await until(() => core.logs.filter(l => ["stt.transport-retry", "stt.queued", "stt.retry"].includes(l.event)).length > i,
      { what: `mixed retry ${i + 1}` });
    await core.clock.advance(wait);
  }
  expect((await result).error?.code).toBe("ECONNRESET");
  expect(calls).toBe(7);
  expect(retryLogs().length).toBe(3);
});

test("more than three 503 responses still wait for a free slot", async () => {
  let calls = 0;
  globalThis.fetch = (async () => ++calls <= 5
    ? Response.json({ error: "busy" }, { status: 503 })
    : Response.json({ text: transcript })) as typeof fetch;
  const result = outcome(sttDecode(await upload(), 0));
  for (const [i, wait] of [500, 1000, 2000, 4000, 5000].entries()) {
    await until(() => core.logs.filter(l => l.event === "stt.queued" || l.event === "stt.retry").length > i,
      { what: `busy response ${i + 1}` });
    await core.clock.advance(wait);
  }
  expect((await result).value?.text).toBe(transcript);
  expect(calls).toBe(6);
  expect(retryLogs().length).toBe(0);
});
