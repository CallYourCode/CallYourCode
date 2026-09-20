/* dcpipe.ts framing vectors + drift, and the live
 * pipe those primitives are wrapped in.
 *
 * The vectors are computed from FIXED inputs and frozen into the single shared
 * copy engine/shared/fixtures/dcpipe-vectors.json. dcpipe.ts is one shared
 * module (engine/shared/dcpipe.ts) imported by both the engine and the app
 * bundle, and the app test asserts the SAME fixture, so a change to the
 * fragmentation on either side fails a test instead of silently splitting a
 * chat frame the other end cannot reassemble. sha256 over the concatenated wire pins every byte;
 * headers/lengths are kept for readability.
 *
 * The second half drives dcPipe() itself against a fake DataChannel and a fake
 * PeerConnection. Everything dcPipe does is a decision about a dead or hostile
 * peer (a protocol error, a CLOSE, ICE failing, backpressure), and none of it
 * needs a real socket to be wrong: the honest test is a channel object we can
 * hand any byte sequence to.
 */

import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  FRAG,
  LAST,
  PING,
  PONG,
  CLOSE,
  FRAG_MAX,
  MSG_MAX,
  PING_MS,
  DEAD_MS,
  fragment,
  dcPipe,
  Reassembler,
  PipeError,
  type DcLike,
  type PcLike,
  type Pipe,
} from "./dcpipe";

const FIXTURE = new URL("../../../shared/fixtures/dcpipe-vectors.json", import.meta.url).pathname;

// Fixed inputs, as recipes so the file stays small for the big ones. The set
// straddles the FRAG_MAX boundary and a multi-byte char across it.
type Recipe = { name: string; make: () => string };
const RECIPES: Recipe[] = [
  { name: "empty", make: () => "" },
  { name: "short-ascii", make: () => "hello" },
  { name: "json-ish", make: () => JSON.stringify({ t: "x", n: 3, ct: "abc" }) },
  { name: "exactly-frag-max", make: () => "a".repeat(FRAG_MAX) },
  { name: "one-over", make: () => "a".repeat(FRAG_MAX + 1) },
  { name: "two-frags", make: () => "a".repeat(FRAG_MAX * 2) },
  { name: "three-frags", make: () => "a".repeat(FRAG_MAX * 2 + 1) },
  // A 3-byte '€' straddles the first boundary: 1 byte ends frag 0, 2 open frag 1.
  { name: "multibyte-straddle", make: () => "a".repeat(FRAG_MAX - 1) + "€" },
];

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

function wireOf(frags: Uint8Array[]): Uint8Array {
  const total = frags.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const f of frags) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}

async function computeVectors() {
  const frag: Record<string, { headers: number[]; lengths: number[]; sha256: string }> = {};
  for (const r of RECIPES) {
    const frags = fragment(r.make());
    frag[r.name] = {
      headers: frags.map((f) => f[0]),
      lengths: frags.map((f) => f.length - 1),
      sha256: await sha256Hex(wireOf(frags)),
    };
  }
  return { frag };
}

/* --- the frozen wire ------------------------------------------------------ */

test("constants are the frozen wire values", () => {
  expect([FRAG, LAST, PING, PONG, CLOSE]).toEqual([0x00, 0x01, 0x02, 0x03, 0x04]);
  expect(FRAG_MAX).toBe(16 * 1024 - 1);
  expect(MSG_MAX).toBe(16 * 1024 * 1024);
  /* Liveness is part of the contract too: the app's own pipe pings on the same
   * cadence, and a DEAD_MS shorter than the peer's PING_MS would tear down a
   * healthy channel every time the user's phone was in a lift. */
  expect(PING_MS).toBe(30_000);
  expect(DEAD_MS).toBe(90_000);
  expect(DEAD_MS).toBeGreaterThan(PING_MS * 2);
});

test("fragmentation matches the frozen vectors (drift pin, shared with the app repo)", async () => {
  const computed = await computeVectors();
  if (!existsSync(FIXTURE)) {
    mkdirSync(new URL("../fixtures/", import.meta.url).pathname, { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify(computed, null, 2) + "\n");
  }
  const frozen = JSON.parse(readFileSync(FIXTURE, "utf8"));
  expect(computed).toEqual(frozen);
});

test("fragment always ends in exactly one LAST, and never exceeds the DataChannel limit", () => {
  /* The two properties every peer depends on: a message is terminated exactly
   * once (a second LAST would deliver a truncated frame and orphan the rest),
   * and no single write is bigger than the smallest limit in the fleet. */
  for (const r of RECIPES) {
    const frags = fragment(r.make());
    expect(frags.length, r.name).toBeGreaterThan(0);
    expect(frags.filter((f) => f[0] === LAST).length, r.name).toBe(1);
    expect(frags[frags.length - 1][0], r.name).toBe(LAST);
    expect(frags.slice(0, -1).every((f) => f[0] === FRAG), r.name).toBe(true);
    expect(Math.max(...frags.map((f) => f.length)), r.name).toBeLessThanOrEqual(1 + FRAG_MAX);
  }
  // an empty string is ONE empty LAST, not zero writes: the peer still gets a message
  expect(fragment("")).toEqual([new Uint8Array([LAST])]);
});

test("every input round-trips: fragment then reassemble is the identity", () => {
  const rx = new Reassembler();
  for (const r of RECIPES) {
    const s = r.make();
    let delivered: string | null = null;
    for (const f of fragment(s)) {
      const out = rx.push(f);
      if (out !== null) delivered = out;
    }
    expect(delivered, `round-trip for ${r.name}`).toBe(s);
  }
});

test("one Reassembler carries message after message with no bleed between them", () => {
  /* The size counter and the parts list have to reset on every LAST. If they
   * did not, a long-lived pipe would drift toward the oversize refusal and
   * start prefixing every frame with the previous one. */
  const rx = new Reassembler();
  const big = "b".repeat(FRAG_MAX + 10);
  for (const s of ["one", big, "", "three", big]) {
    let delivered: string | null = null;
    for (const f of fragment(s)) {
      const out = rx.push(f);
      if (out !== null) delivered = out;
    }
    expect(delivered).toBe(s);
  }
});

/* --- Reassembler refusals ------------------------------------------------- */

test("a message over MSG_MAX is refused with 1009", () => {
  const rx = new Reassembler();
  const bigFrag = new Uint8Array(1 + FRAG_MAX);
  bigFrag[0] = FRAG;
  // MSG_MAX / FRAG_MAX rounded up is how many max FRAGs it takes to cross it.
  const need = Math.ceil(MSG_MAX / FRAG_MAX) + 1;
  let threw: PipeError | null = null;
  try {
    for (let i = 0; i < need; i++) rx.push(bigFrag);
  } catch (e) {
    threw = e as PipeError;
  }
  expect(threw?.code).toBe(1009);
  expect(threw).toBeInstanceOf(Error);
  expect(threw!.message).toBe("oversize");
});

test("a PING or PONG arriving mid-message is a protocol error 1002", () => {
  const rx = new Reassembler();
  const frag0 = new Uint8Array([FRAG, 65]); // one FRAG, message not yet ended
  expect(rx.push(frag0)).toBeNull();
  expect(() => rx.push(new Uint8Array([PING]))).toThrow();
  const rx2 = new Reassembler();
  expect(rx2.push(frag0)).toBeNull();
  let code = 0;
  try {
    rx2.push(new Uint8Array([PONG]));
  } catch (e) {
    code = (e as PipeError).code;
  }
  expect(code).toBe(1002);
});

test("a CLOSE or an unknown header mid-message is the same protocol error", () => {
  /* Reassembly cannot absorb a control byte: the bytes after it would be read
   * as more of the half-built message. Anything that is not FRAG/LAST while
   * parts are pending is refused, including a header this version has never
   * heard of. */
  for (const header of [CLOSE, 0x05, 0xff]) {
    const rx = new Reassembler();
    expect(rx.push(new Uint8Array([FRAG, 65]))).toBeNull();
    let code = 0;
    try {
      rx.push(new Uint8Array([header]));
    } catch (e) {
      code = (e as PipeError).code;
    }
    expect(code, `header ${header}`).toBe(1002);
  }
});

test("a PING/PONG between whole messages is inert, not an error", () => {
  const rx = new Reassembler();
  // deliver one whole message, then a PING with no pending parts
  expect(rx.push(new Uint8Array([LAST, 65, 66]))).toBe("AB");
  expect(rx.push(new Uint8Array([PING]))).toBeNull();
  expect(rx.push(new Uint8Array([PONG]))).toBeNull();
  // and the next message still works
  expect(rx.push(new Uint8Array([LAST, 67]))).toBe("C");
});

test("an unknown header BETWEEN messages is ignored, so a newer peer can add one", () => {
  /* Back-compat by absence (CONTRACT.md): a peer built later may send a control
   * byte this build does not know. Between messages that must be survivable,
   * or upgrading one end breaks the other. */
  const rx = new Reassembler();
  expect(rx.push(new Uint8Array([0x09]))).toBeNull();
  expect(rx.push(new Uint8Array([LAST, 65]))).toBe("A");
});

/* --- the live pipe over a fake DataChannel -------------------------------- */

class FakeDc implements DcLike {
  readyState = "open";
  binaryType = "";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: Uint8Array[] = [];
  onmessage: ((ev: { data: ArrayBuffer | Uint8Array }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  private listeners = new Map<string, Array<(ev: unknown) => void>>();

  send(data: Uint8Array): void {
    if (this.readyState !== "open") throw new Error("dc closed");
    this.sent.push(new Uint8Array(data));
  }
  close(): void {
    this.readyState = "closed";
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    const l = this.listeners.get(type) ?? [];
    l.push(cb);
    this.listeners.set(type, l);
  }
  emit(type: string): void {
    for (const cb of this.listeners.get(type) ?? []) cb({});
  }
  /** one inbound DataChannel message */
  deliver(msg: Uint8Array | ArrayBuffer): void {
    this.onmessage?.({ data: msg });
  }
  /** the header bytes of everything written, for a one-glance assertion */
  headers(): number[] {
    return this.sent.map((f) => f[0]);
  }
}

class FakePc implements PcLike {
  connectionState = "connected";
  private listeners: Array<(ev: unknown) => void> = [];
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    if (type === "connectionstatechange") this.listeners.push(cb);
  }
  set(state: string): void {
    this.connectionState = state;
    for (const cb of this.listeners) cb({});
  }
}

/* Every pipe MUST be closed: dcPipe holds a PING_MS interval, and a leaked one
 * keeps the test worker alive long after the assertions are done. */
const pipes: Pipe[] = [];
afterEach(() => {
  while (pipes.length) {
    try {
      pipes.pop()!.close();
    } catch {}
  }
});

function livePipe() {
  const dc = new FakeDc();
  const pc = new FakePc();
  const pipe = dcPipe(dc, pc);
  pipes.push(pipe);
  const got: string[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  let pongs = 0;
  pipe.onmessage = (s) => got.push(s);
  pipe.onclose = (code, reason) => closes.push({ code, reason });
  pipe.onpong = () => pongs++;
  return { dc, pc, pipe, got, closes, pongs: () => pongs };
}

test("dcPipe configures the channel and fragments what it sends", () => {
  const { dc, pipe } = livePipe();
  /* binaryType must be arraybuffer or the browser hands us Blobs and every
   * inbound frame arrives as a promise nobody awaits. The low threshold is what
   * makes drain() ever resolve. */
  expect(dc.binaryType).toBe("arraybuffer");
  expect(dc.bufferedAmountLowThreshold).toBe(256 * 1024);

  expect(pipe.kind).toBe("dc");
  expect(pipe.open).toBe(true);
  expect(pipe.send("hello")).toBe(true);
  expect(dc.sent).toEqual(fragment("hello"));

  const big = "a".repeat(FRAG_MAX * 2 + 5);
  dc.sent.length = 0;
  expect(pipe.send(big)).toBe(true);
  expect(dc.sent).toEqual(fragment(big));
  expect(dc.headers()).toEqual([FRAG, FRAG, LAST]);
});

test("inbound fragments surface as ONE whole message, in both data shapes", () => {
  const { dc, pipe, got } = livePipe();
  const frags = fragment(JSON.stringify({ t: "x", n: 0, ct: "abc" }));
  for (const f of frags.slice(0, -1)) dc.deliver(f);
  expect(got).toEqual([]); // nothing surfaces until LAST
  dc.deliver(frags[frags.length - 1]);
  expect(got).toEqual([JSON.stringify({ t: "x", n: 0, ct: "abc" })]);

  /* The browser delivers an ArrayBuffer, node-datachannel a Uint8Array. Both
   * have to work or the pipe is byte-identical in the two repos in name only. */
  const ab = fragment("second")[0];
  dc.deliver(ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength) as ArrayBuffer);
  expect(got).toEqual([JSON.stringify({ t: "x", n: 0, ct: "abc" }), "second"]);
  expect(pipe.open).toBe(true);
});

test("an inbound PING is answered with a PONG and never surfaces upward", () => {
  const { dc, got } = livePipe();
  dc.deliver(new Uint8Array([PING]));
  expect(dc.headers()).toEqual([PONG]);
  expect(got).toEqual([]);
});

test("an inbound PONG fires onpong and nothing else", () => {
  const { dc, got, pongs } = livePipe();
  dc.deliver(new Uint8Array([PONG]));
  expect(pongs()).toBe(1);
  expect(dc.sent).toEqual([]);
  expect(got).toEqual([]);
});

test("an inbound CLOSE carries the peer's code and reason up, and a malformed one does not throw", () => {
  const a = livePipe();
  const body = new TextEncoder().encode(JSON.stringify({ code: 4403, reason: "sec:revoked" }));
  const msg = new Uint8Array(1 + body.length);
  msg[0] = CLOSE;
  msg.set(body, 1);
  a.dc.deliver(msg);
  expect(a.closes).toEqual([{ code: 4403, reason: "sec:revoked" }]);
  expect(a.pipe.open).toBe(false);
  expect(a.dc.readyState).toBe("closed");

  /* A CLOSE whose body is not JSON is still a close: the peer is going away,
   * and refusing to parse its excuse is not a reason to keep the pipe. */
  const b = livePipe();
  b.dc.deliver(new Uint8Array([CLOSE, 0x7b, 0x7b]));
  expect(b.closes).toEqual([{ code: 1000, reason: "" }]);
});

test("close() writes a CLOSE frame before tearing down, and is idempotent", () => {
  const { dc, pipe, closes } = livePipe();
  pipe.close(4009, "ice");
  expect(dc.headers()).toEqual([CLOSE]);
  expect(JSON.parse(new TextDecoder().decode(dc.sent[0].subarray(1)))).toEqual({
    code: 4009,
    reason: "ice",
  });
  expect(closes).toEqual([{ code: 4009, reason: "ice" }]);
  expect(pipe.open).toBe(false);

  // a second close writes nothing and fires nothing: teardown happens once
  pipe.close(1000, "again");
  expect(dc.sent.length).toBe(1);
  expect(closes.length).toBe(1);
  // and a send afterwards is refused rather than throwing at the call site
  expect(pipe.send("late")).toBe(false);
});

test("a protocol violation inbound closes the pipe with the code the framing chose", () => {
  const { dc, pipe, closes, got } = livePipe();
  dc.deliver(new Uint8Array([FRAG, 65])); // message in progress
  dc.deliver(new Uint8Array([0x05])); // a header nothing here knows, mid-message
  expect(closes).toEqual([{ code: 1002, reason: "protocol" }]);
  expect(pipe.open).toBe(false);
  expect(got).toEqual([]);
  // the peer is told why: a CLOSE frame went out before the channel dropped
  expect(dc.headers()[dc.headers().length - 1]).toBe(CLOSE);
});

test("the live pipe answers a mid-message PING instead of failing the message", () => {
  /* dcPipe handles PING/PONG/CLOSE ABOVE the Reassembler, so those three never
   * reach its mid-message refusal: a liveness ping that lands between two
   * fragments is answered and the half-built message survives. That is the
   * behaviour the fleet has, and it is the forgiving one, but it does mean
   * Reassembler's 1002 for PING/PONG (asserted above as the framing contract)
   * is reachable through the live pipe only for an unknown header. Written
   * down here so a future reader does not "fix" one of the two to match the
   * other by accident. */
  const { dc, pipe, got, closes } = livePipe();
  const frags = fragment("a".repeat(FRAG_MAX + 1));
  dc.deliver(frags[0]);
  dc.deliver(new Uint8Array([PING]));
  expect(dc.headers()).toEqual([PONG]);
  dc.deliver(frags[1]);
  expect(got).toEqual(["a".repeat(FRAG_MAX + 1)]);
  expect(closes).toEqual([]);
  expect(pipe.open).toBe(true);
});

test("the DataChannel closing under us surfaces as 1006, not silence", () => {
  const { dc, closes, pipe } = livePipe();
  dc.onclose!();
  expect(closes).toEqual([{ code: 1006, reason: "dc-closed" }]);
  expect(pipe.open).toBe(false);
});

test("a failed or closed peer connection kills the pipe immediately", () => {
  for (const state of ["failed", "closed"]) {
    const { pc, closes, pipe } = livePipe();
    pc.set(state);
    expect(closes, state).toEqual([{ code: 4009, reason: "ice" }]);
    expect(pipe.open, state).toBe(false);
  }
});

test("a `disconnected` blip that recovers does NOT kill the pipe", () => {
  /* Browsers flap through `disconnected` on a wifi handover and come back on
   * their own. Closing on the first sight of it (which an earlier build did)
   * dropped the chat every time he walked out of the room. */
  const { pc, closes, pipe } = livePipe();
  pc.set("disconnected");
  expect(closes).toEqual([]);
  expect(pipe.open).toBe(true);
  pc.set("connected");
  expect(closes).toEqual([]);
  expect(pipe.open).toBe(true);
});

test("drain resolves at once below the threshold, and waits for bufferedamountlow above it", async () => {
  const { dc, pipe } = livePipe();
  // nothing buffered: no reason to wait
  await pipe.drain();

  dc.bufferedAmount = 2 * 1024 * 1024;
  let drained = false;
  const p = pipe.drain().then(() => (drained = true));
  await Promise.resolve();
  expect(drained).toBe(false);

  // the event fires while still full: the waiter stays parked
  dc.emit("bufferedamountlow");
  await Promise.resolve();
  expect(drained).toBe(false);

  dc.bufferedAmount = 0;
  dc.emit("bufferedamountlow");
  await p;
  expect(drained).toBe(true);
});

test("a pending drain is released by teardown, so no caller waits on a dead pipe forever", () => {
  const { dc, pipe } = livePipe();
  dc.bufferedAmount = 2 * 1024 * 1024;
  const p = pipe.drain();
  pipe.close(1000, "bye");
  return p; // resolves, or this test times out
});

test("onopen fires through, and drain on a closed pipe never parks", async () => {
  const { dc, pipe } = livePipe();
  let opened = 0;
  pipe.onopen = () => opened++;
  dc.onopen!();
  expect(opened).toBe(1);

  pipe.close();
  dc.bufferedAmount = 2 * 1024 * 1024;
  await pipe.drain(); // closed pipes resolve immediately, they do not queue
});

test("a close on an already-dead channel still tears down locally", () => {
  /* dc.send throws once the channel is gone. The CLOSE frame is best effort;
   * the local teardown is not optional, or the engine keeps a client record for
   * a socket that no longer exists. */
  const { dc, pipe, closes } = livePipe();
  dc.readyState = "closed";
  pipe.close(4008, "quiet");
  expect(closes).toEqual([{ code: 4008, reason: "quiet" }]);
  expect(pipe.open).toBe(false);
});
