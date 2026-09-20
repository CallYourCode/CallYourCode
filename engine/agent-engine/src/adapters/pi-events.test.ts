/* pi-events: the engine consumer's pure frame mappers and its per-pane unix
 * socket server. A frame carries the durable id so it dedupes against the
 * transcript row; a status frame becomes a working/idle edge; the server reads
 * real newline frames off a real socket and buffers what arrives before a
 * consumer attaches.
 *
 *   bun test agent-engine/src/adapters/pi-events.test.ts
 */

import { describe, expect, test, afterEach } from "bun:test";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePiFrame, piFrameToEvent, piFrameStatus, PiEventServer, type PiFrame,
} from "./pi-events.ts";

describe("parsePiFrame", () => {
  test("keeps a well-formed session/event frame and drops junk", () => {
    expect(parsePiFrame(`{"t":"pi.session","sessionId":"s1","cwd":"/x","model":"grok-4.6"}`))
      .toMatchObject({ t: "pi.session", sessionId: "s1" });
    expect(parsePiFrame(`{"t":"pi.event","kind":"reply","id":"u1","text":"hi"}`))
      .toMatchObject({ t: "pi.event", kind: "reply" });
    expect(parsePiFrame("")).toBeNull();
    expect(parsePiFrame("not json")).toBeNull();
    expect(parsePiFrame(`{"t":"pi.event","kind":"bogus"}`)).toBeNull();
    expect(parsePiFrame(`{"t":"other"}`)).toBeNull();
  });
});

describe("piFrameToEvent", () => {
  test("a reply frame becomes a reply SessionEvent keyed by the durable id", () => {
    const ev = piFrameToEvent({ t: "pi.event", kind: "reply", id: "leaf-1", ts: 42, text: "done" });
    expect(ev).toMatchObject({ uuid: "leaf-1", ts: 42, kind: "reply", text: "done", off: 0 });
  });

  test("a tool frame carries its tool name and is capped", () => {
    const big = "x".repeat(500);
    const ev = piFrameToEvent({ t: "pi.event", kind: "tool", id: "call-9", tool: "bash", text: big })!;
    expect(ev.kind).toBe("tool");
    expect(ev.tool).toBe("bash");
    expect(ev.uuid).toBe("call-9");
    expect(ev.text.length).toBeLessThanOrEqual(201); // 200 + ellipsis
  });

  test("a status frame is not a row (null), and a frame without an id still renders", () => {
    expect(piFrameToEvent({ t: "pi.event", kind: "status", status: "working" })).toBeNull();
    const ev = piFrameToEvent({ t: "pi.event", kind: "prompt", ts: 7, text: "hey" })!;
    expect(ev.uuid).toBe("pievt:prompt:7"); // synthetic, still stable per frame
  });
});

describe("piFrameStatus", () => {
  test("reads the edge from a status frame only", () => {
    expect(piFrameStatus({ t: "pi.event", kind: "status", status: "working" })).toBe("working");
    expect(piFrameStatus({ t: "pi.event", kind: "status", status: "idle" })).toBe("idle");
    expect(piFrameStatus({ t: "pi.event", kind: "reply", text: "x" })).toBeNull();
    expect(piFrameStatus({ t: "pi.session" })).toBeNull();
  });
});

let server: PiEventServer | null = null;
afterEach(() => { if (server) { server.close(); server = null; } });

describe("PiEventServer", () => {
  test("reads newline frames off a real socket and buffers pre-attach frames", async () => {
    const sockPath = join(tmpdir(), `pi-evt-test-${process.pid}-${Date.now()}.sock`);
    server = new PiEventServer(sockPath);
    await server.listen();

    // a client (the extension's role) connects and sends before any consumer
    const client = createConnection(sockPath);
    await new Promise<void>((r, j) => { client.on("connect", () => r()); client.on("error", j); });
    client.write(`{"t":"pi.session","sessionId":"s1","cwd":"/x"}\n`);
    client.write(`{"t":"pi.event","kind":"reply","id":"u1","text":"hel`);
    client.write(`lo"}\n{"t":"pi.event","kind":"status","status":"idle"}\n`);
    // let the bytes land
    await new Promise((r) => setTimeout(r, 30));

    const got: PiFrame[] = [];
    server.onFrame((f) => got.push(f)); // attaching flushes the buffer, then streams live
    // and a live frame after attach
    client.write(`{"t":"pi.event","kind":"tool","id":"c1","tool":"bash","text":"ls"}\n`);
    await new Promise((r) => setTimeout(r, 30));
    client.end();

    // the split "hel"+"lo" frame reassembled; ordering preserved
    expect(got.map((f) => f.t)).toEqual(["pi.session", "pi.event", "pi.event", "pi.event"]);
    const reply = got[1] as Extract<PiFrame, { t: "pi.event" }>;
    expect(reply).toMatchObject({ kind: "reply", id: "u1", text: "hello" });
    const tool = got[3] as Extract<PiFrame, { t: "pi.event" }>;
    expect(tool).toMatchObject({ kind: "tool", id: "c1", tool: "bash" });
  });

  test("offFrame detaches the consumer: later frames buffer for the next attach, and a replaced consumer is left alone", async () => {
    const sockPath = join(tmpdir(), `pi-evt-off-${process.pid}-${Date.now()}.sock`);
    server = new PiEventServer(sockPath);
    await server.listen();
    const client = createConnection(sockPath);
    await new Promise<void>((r, j) => { client.on("connect", () => r()); client.on("error", j); });

    const first: PiFrame[] = [];
    const firstCb = (f: PiFrame) => first.push(f);
    server.onFrame(firstCb);
    client.write(`{"t":"pi.event","kind":"reply","id":"u1","text":"one"}\n`);
    await new Promise((r) => setTimeout(r, 30));
    expect(first.length).toBe(1);

    // detached: the next frame buffers instead of reaching the old consumer
    server.offFrame(firstCb);
    client.write(`{"t":"pi.event","kind":"reply","id":"u2","text":"two"}\n`);
    await new Promise((r) => setTimeout(r, 30));
    expect(first.length).toBe(1);

    // the buffered frame flushes to the next consumer
    const second: PiFrame[] = [];
    server.onFrame((f) => second.push(f));
    expect(second.length).toBe(1);
    expect(second[0]).toMatchObject({ t: "pi.event", id: "u2" });

    // a stale unsubscribe never displaces the CURRENT consumer
    server.offFrame(firstCb);
    client.write(`{"t":"pi.event","kind":"reply","id":"u3","text":"three"}\n`);
    await new Promise((r) => setTimeout(r, 30));
    expect(second.length).toBe(2);
    client.end();
  });

  test("a pi.session frame reaches onSession BEFORE any onFrame attach, and pi.event frames still buffer/flush in order", async () => {
    const sockPath = join(tmpdir(), `pi-evt-sess-${process.pid}-${Date.now()}.sock`);
    server = new PiEventServer(sockPath);
    await server.listen();

    // the identity tap is attached (as spawn does), but NO frame consumer yet
    const seen: string[] = [];
    server.onSession((sid) => seen.push(sid));

    const client = createConnection(sockPath);
    await new Promise<void>((r, j) => { client.on("connect", () => r()); client.on("error", j); });
    const UUID = "01a01059-2c50-729b-93ba-9e0c814a537b";
    client.write(`{"t":"pi.session","sessionId":"${UUID}"}\n`);
    client.write(`{"t":"pi.event","kind":"reply","id":"u1","text":"one"}\n`);
    client.write(`{"t":"pi.event","kind":"status","status":"idle"}\n`);
    await new Promise((r) => setTimeout(r, 30));

    // onSession fired the moment the frame arrived, with no consumer attached
    expect(seen).toEqual([UUID]);

    // and the frames (pi.session included) were still buffered; a later onFrame
    // flushes them in the SAME order, so ingest loses nothing (E7: the tap is
    // additive, the handler/pending path is byte-identical to before)
    const got: PiFrame[] = [];
    server.onFrame((f) => got.push(f));
    await new Promise((r) => setTimeout(r, 10));
    client.end();
    expect(got.map((f) => f.t)).toEqual(["pi.session", "pi.event", "pi.event"]);
    expect((got[1] as Extract<PiFrame, { t: "pi.event" }>).id).toBe("u1");
  });

  test("onSession fires for every pi.session and never for a pi.event", async () => {
    const sockPath = join(tmpdir(), `pi-evt-sess2-${process.pid}-${Date.now()}.sock`);
    server = new PiEventServer(sockPath);
    await server.listen();
    const seen: string[] = [];
    server.onSession((sid) => seen.push(sid));
    server.onFrame(() => {}); // a live consumer, so nothing buffers

    const client = createConnection(sockPath);
    await new Promise<void>((r, j) => { client.on("connect", () => r()); client.on("error", j); });
    client.write(`{"t":"pi.event","kind":"reply","id":"u1","text":"x"}\n`);
    client.write(`{"t":"pi.session","sessionId":"s-A"}\n`);
    client.write(`{"t":"pi.session","sessionId":"s-B"}\n`);
    client.write(`{"t":"pi.session"}\n`); // no sessionId: ignored by the tap
    await new Promise((r) => setTimeout(r, 30));
    client.end();
    expect(seen).toEqual(["s-A", "s-B"]);
  });
});
