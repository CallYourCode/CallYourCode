/* THE ENGINE'S SEALED HANDSHAKE, frame by frame (#579).
 *
 * A device peer greets with hello{sec}, EngineSecConn answers with the signed
 * `sec` frame, the device proves itself with a sealed sec-ok, the engine enrols
 * it and seals sec-done, and a c2e app frame reaches the engine dispatcher
 * decoded. Enrolment is idempotent across reconnects; a second device key adds
 * one row; a bare hello gets sec-required. Then the whole refusal matrix, which
 * is the half that matters: every one of these closes exists because the
 * alternative is an unproven device holding a live channel.
 *
 * The transport is an in-process string link, not a real DataChannel. What
 * EngineSecConn consumes is "one plaintext string per logical message" and what
 * it produces is the same; dcpipe.ts is what turns that into fragments and is
 * proven in dcpipe.test.ts. rtc.ts carries those fragments, and it is proven in
 * two places now that rtc.test.ts is gone: e2e/roundtrip.test.ts opens a real
 * node-datachannel channel to a booted engine and round-trips a multi-fragment
 * frame through it, and rtc-ice.test.ts holds the candidate-advertising rules.
 * Standing a real peer up HERE cost 25 seconds a test and proved the transport a
 * third time, not the handshake once.
 *
 * The engine half below is wired exactly the way rtc-glue.ts mintRtcClient
 * wires it: send -> pipe.send(JSON.stringify), onFrame -> the dispatcher,
 * onClose -> pipe.close, and markClosed on the pipe's own close. */

import { test, expect } from "bun:test";
import { join } from "node:path";
import { until } from "../test-utils/wait.ts";
import { tmpDataDir } from "../test-utils/tmp.ts";
import {
  loadOrCreateE2E,
  enrolDevice,
  findDevice,
  newestGen,
  EngineSecConn,
  type E2EState,
} from "./sec";
import {
  newIdentity,
  SecureChannel,
  signId,
  secTranscript,
  b64encode,
  derivePairKey,
  secPairTag,
  type EngineIdentity,
  type SecFrame,
  type SecOffer,
  type SealedFrame,
} from "../../../shared/e2e";

const te = new TextEncoder();

function scratchState(): Promise<E2EState> {
  return tmpDataDir("secwire-").then(({ data }) => loadOrCreateE2E(join(data, "keys.json")));
}

/* --- the in-process link -------------------------------------------------- */

/** One end of a plaintext string pipe. Delivery is a microtask, not a
 *  synchronous call, because the real one is a network: a test that only passes
 *  when feed() runs inside send() is testing the fake. */
class Wire {
  peer!: Wire;
  onmessage: ((s: string) => void) | null = null;
  closed: { code: number; reason: string } | null = null;
  sent: string[] = [];

  send(s: string): void {
    this.sent.push(s);
    if (this.closed) return; // bytes written after close never leave
    queueMicrotask(() => this.peer.onmessage?.(s));
  }
  close(code = 1000, reason = ""): void {
    if (!this.closed) this.closed = { code, reason };
  }
}

function link(): { client: Wire; engine: Wire } {
  const client = new Wire();
  const engine = new Wire();
  client.peer = engine;
  engine.peer = client;
  return { client, engine };
}

/** The engine half, wired like rtc-glue.ts. `frames` is what the ordinary
 *  dispatcher would have received: opened inner frames, never sealed ones. */
function engineOver(wire: Wire, state: E2EState) {
  const frames: any[] = [];
  let readyCalls = 0;
  const sec = new EngineSecConn(
    state,
    "example",
    "linux",
    "rtc",
    (frame) => wire.send(JSON.stringify(frame)),
    () => readyCalls++,
    (inner) => frames.push(inner),
    (code, reason) => wire.close(code, reason),
  );
  wire.onmessage = (raw) => void sec.feed(raw);
  return { sec, frames, wire, readyCalls: () => readyCalls };
}

/** The device half: hello, accept, sec-ok, and an opened view of everything the
 *  engine sealed back. */
class Device {
  private offer: SecOffer | null = null;
  chan: SecureChannel | null = null;
  /** every plaintext frame the engine wrote, in wire order */
  wire: any[] = [];
  /** every sealed frame the engine wrote, opened */
  opened: any[] = [];
  /** a sealed frame we could not open (a forgery, or a counter refusal) */
  openErrors: string[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private side: Wire,
    readonly identity: EngineIdentity,
  ) {
    side.onmessage = (raw) => {
      const m = JSON.parse(raw);
      this.wire.push(m);
      // opens are chained so the frame counter sees arrival order
      this.queue = this.queue
        .then(async () => {
          if (m.v === 2 && m.ee && this.offer) {
            this.chan = await SecureChannel.accept(this.offer, m as SecFrame, null);
          } else if (m.t === "x" && this.chan) {
            this.opened.push(await this.chan.open(m as SealedFrame));
          }
        })
        .catch((e) => void this.openErrors.push((e as Error).message));
    };
  }

  /** hello{sec}, then wait for the engine's signed sec frame to be accepted. */
  async hello(): Promise<void> {
    this.offer = await SecureChannel.offer();
    this.side.send(JSON.stringify({ t: "hello", sec: this.offer.hello }));
    await until(() => this.chan !== null, { what: "the engine's sec frame" });
  }

  /** a hand-rolled client with no sec: the pre-579 shape. */
  helloBare(): void {
    this.side.send(JSON.stringify({ t: "hello" }));
  }

  raw(s: string): void {
    this.side.send(s);
  }

  transcript(): string {
    const t = this.chan!.transcript();
    return secTranscript("c", t.ce, t.ee, t.cn, t.en, t.id);
  }

  /** The sealed sec-ok. Every field is overridable so a refusal can be aimed at
   *  exactly one of them. */
  async secOk(o: { pairFrom?: E2EState; label?: string; sig?: string; dev?: string } = {}): Promise<void> {
    const transcript = this.transcript();
    const sig =
      o.sig ?? b64encode(await signId(this.identity.keyPair.privateKey, te.encode(transcript)));
    const inner: Record<string, unknown> = {
      t: "sec-ok",
      dev: o.dev ?? this.identity.spki,
      sig,
      label: o.label ?? "laptop",
    };
    if (o.pairFrom) {
      inner.pair = await secPairTag(await derivePairKey(newestGen(o.pairFrom).key), transcript);
    }
    await this.sealSend(inner);
  }

  async sealSend(inner: unknown): Promise<void> {
    this.side.send(JSON.stringify(await this.chan!.seal(inner)));
  }

  /** Wait for a sealed frame of this type and hand it back opened. */
  async sealed(t: string): Promise<any> {
    await until(() => this.opened.some((f) => f?.t === t), { what: `a sealed ${t}` });
    return this.opened.find((f) => f?.t === t);
  }

  /** Wait for a plaintext frame of this type. */
  async plain(t: string): Promise<any> {
    await until(() => this.wire.some((f) => f?.t === t), { what: `a plaintext ${t}` });
    return this.wire.find((f) => f?.t === t);
  }
}

/** hello -> sec -> sec-ok -> sec-done, the whole happy path. */
async function handshake(
  state: E2EState,
  identity: EngineIdentity,
  o: { label?: string; pairFrom?: E2EState } = {},
) {
  const { client, engine } = link();
  const eng = engineOver(engine, state);
  const dev = new Device(client, identity);
  await dev.hello();
  await dev.secOk({ label: o.label, pairFrom: o.pairFrom });
  const secDone = await dev.sealed("sec-done");
  return { eng, dev, secDone, clientWire: client, engineWire: engine };
}

/* --- the happy path ------------------------------------------------------- */

test("first contact enrols, sec-done is sealed, and a c2e app frame reaches the dispatcher", async () => {
  const state = await scratchState();
  const identity = await newIdentity(true);
  const { eng, dev, secDone } = await handshake(state, identity, {
    label: "Example's laptop",
    pairFrom: state,
  });

  expect(secDone.paired).toBe(true);
  expect(secDone.fp).toBe(state.identity.fp);
  expect(secDone.devices.map((d: any) => d.label)).toEqual(["Example's laptop"]);
  expect(secDone.content.length).toBe(1);
  /* No HTTP owner capability rides the sec-done any more: the cap bearer is
   * deleted (sealed-transport enforcement). The sealed channel itself is the
   * owner credential, so the frame carries nothing to hand out. */
  expect(secDone.cap).toBeUndefined();
  expect(secDone.dev).toBe(identity.fp);
  expect(eng.sec.ready).toBe(true);
  expect(eng.sec.devFp).toBe(identity.fp);
  expect(eng.readyCalls()).toBe(1);
  expect(state.devices.length).toBe(1);

  // a sealed c2e frame reaches the engine dispatcher, decoded
  await dev.sealSend({ t: "attach", id: "w1:p1" });
  await until(() => eng.frames.length > 0, { what: "the dispatcher to receive the attach frame" });
  expect(eng.frames).toContainEqual({ t: "attach", id: "w1:p1" });
  // and the cap is a real one: nothing else came out unsealed
  expect(eng.wire.closed).toBeNull();
});

test("nothing rides the wire in the clear once the channel exists", async () => {
  /* Invariant E9 in miniature: before sec the wire carries hello and sec, and
   * from then on every single frame is {t:"x"}. A field the engine "just
   * logged" plaintext beside a sealed frame is exactly the leak the whole slice
   * exists to close. */
  const state = await scratchState();
  const { dev, eng } = await handshake(state, await newIdentity(true), { pairFrom: state });
  await dev.sealSend({ t: "attach", id: "w1:p1" });
  await until(() => eng.frames.length > 0, { what: "the dispatcher to receive the attach frame" });

  const kinds = dev.wire.map((m) => (m.t === "x" ? "x" : m.t ?? "sec"));
  expect(kinds[0]).toBe("sec");
  expect(new Set(kinds.slice(1))).toEqual(new Set(["x"]));
  // no plaintext copy of an inner frame ever appeared
  expect(dev.wire.some((m) => m.t === "sec-done" || m.t === "attach")).toBe(false);
});

test("reconnect is idempotent: the same device key stays one row, paired flips to false", async () => {
  const state = await scratchState();
  const identity = await newIdentity(true);

  const first = await handshake(state, identity, { pairFrom: state });
  expect(first.secDone.paired).toBe(true);
  const addedAt = findDevice(state, identity.fp)!.addedAt;

  /* No pairFrom on the second connection: a KNOWN device needs no proof, which
   * is the whole point of enrolling it. If this ever starts needing one, every
   * phone in the house shows the pairing screen after a restart. */
  const second = await handshake(state, identity);
  expect(second.secDone.paired).toBe(false);
  expect(second.secDone.dev).toBe(identity.fp);
  expect(state.devices.length).toBe(1);
  // the row is the SAME row, re-stamped rather than replaced
  expect(findDevice(state, identity.fp)!.addedAt).toBe(addedAt);
  expect(findDevice(state, identity.fp)!.lastSeenAt).toBeGreaterThanOrEqual(addedAt);
});

test("a second device key adds one row", async () => {
  const state = await scratchState();
  const a = await newIdentity(true);
  const b = await newIdentity(true);

  await handshake(state, a, { label: "A", pairFrom: state });
  const second = await handshake(state, b, { label: "B", pairFrom: state });

  expect(state.devices.length).toBe(2);
  expect(second.secDone.devices.map((d: any) => d.label).sort()).toEqual(["A", "B"]);
});

test("a bare hello (no sec) gets sec-required and nothing else", async () => {
  const state = await scratchState();
  const { client, engine } = link();
  const eng = engineOver(engine, state);
  const dev = new Device(client, await newIdentity(true));

  dev.helloBare();
  const got = await dev.plain("sec-required");
  expect(got.v).toBe(2);
  expect(got.fp).toBe(state.identity.fp);
  expect(got.user).toBe("example");
  expect(got.host).toBe("linux");
  /* Nothing else: no session list, no device list, no content keys. A
   * hand-rolled client that never proves itself learns only that this engine
   * exists and which identity it has. */
  expect(Object.keys(got).sort()).toEqual(["fp", "host", "t", "user", "v"]);
  expect(dev.wire.length).toBe(1);
  expect(eng.wire.closed).toBeNull();
  expect(state.devices.length).toBe(0);
});

/* --- the refusal matrix --------------------------------------------------- */

test("an unknown device with no pair proof is refused and nothing is enrolled", async () => {
  const state = await scratchState();
  const { client, engine } = link();
  const eng = engineOver(engine, state);
  const dev = new Device(client, await newIdentity(true));

  await dev.hello();
  await dev.secOk(); // no pairFrom: no proof
  const fail = await dev.sealed("sec-fail");
  expect(fail.reason).toBe("unknown-device");
  await until(() => eng.wire.closed !== null, { what: "the engine to close the pipe" });
  expect(eng.wire.closed).toEqual({ code: 4403, reason: "sec:unknown-device" });
  expect(state.devices.length).toBe(0);
  expect(eng.sec.ready).toBe(false);
  expect(eng.readyCalls()).toBe(0);
});

test("a pair proof from ANOTHER engine's content key does not enrol", async () => {
  /* The proof is keyed by the content generation, so "some engine's key" is not
   * a credential here. Without this the pairing screen would accept a key
   * pasted from a different install. */
  const state = await scratchState();
  const stranger = await scratchState();
  const { client, engine } = link();
  const eng = engineOver(engine, state);
  const dev = new Device(client, await newIdentity(true));

  await dev.hello();
  await dev.secOk({ pairFrom: stranger });
  expect((await dev.sealed("sec-fail")).reason).toBe("unknown-device");
  expect(state.devices.length).toBe(0);
});

test("a pair proof against a RETIRED generation does not enrol", async () => {
  const state = await scratchState();
  const { client, engine } = link();
  engineOver(engine, state);
  const dev = new Device(client, await newIdentity(true));

  await dev.hello();
  const transcript = dev.transcript();
  const proof = await secPairTag(await derivePairKey(newestGen(state).key), transcript);
  state.content[0].retiredAt = Date.now(); // rotated away between paste and connect
  const sig = b64encode(await signId(dev.identity.keyPair.privateKey, te.encode(transcript)));
  await dev.sealSend({ t: "sec-ok", dev: dev.identity.spki, sig, label: "laptop", pair: proof });

  expect((await dev.sealed("sec-fail")).reason).toBe("unknown-device");
  expect(state.devices.length).toBe(0);
});

test("a sec-ok whose signature does not cover this transcript is refused", async () => {
  /* Without the transcript binding, a signature captured from any other
   * handshake would enrol its bearer here. */
  const state = await scratchState();
  const identity = await newIdentity(true);
  const { client, engine } = link();
  const eng = engineOver(engine, state);
  const dev = new Device(client, identity);

  await dev.hello();
  const wrong = b64encode(
    await signId(identity.keyPair.privateKey, te.encode("cyc-sec-v2|c|not|this|handshake|at|all")),
  );
  await dev.secOk({ sig: wrong, pairFrom: state });

  expect((await dev.sealed("sec-fail")).reason).toBe("bad-sig");
  await until(() => eng.wire.closed !== null, { what: "the engine to close the pipe" });
  expect(eng.wire.closed).toEqual({ code: 4403, reason: "sec:bad-sig" });
  expect(state.devices.length).toBe(0);
});

test("a sec-ok signed by a DIFFERENT key than the one it presents is refused", async () => {
  const state = await scratchState();
  const real = await newIdentity(true);
  const impostor = await newIdentity(true);
  const { client, engine } = link();
  engineOver(engine, state);
  const dev = new Device(client, impostor);

  await dev.hello();
  // the impostor signs honestly but claims the real device's public key
  await dev.secOk({ dev: real.spki, pairFrom: state });
  expect((await dev.sealed("sec-fail")).reason).toBe("bad-sig");
  expect(state.devices.length).toBe(0);
});

test("a revoked device is refused on reconnect even though it is in the list", async () => {
  /* Revocation is the "my phone was stolen" story. The row stays as a tombstone
   * and the check is on revokedAt, so a device already in the list must not
   * ride through on the known-device path. */
  const state = await scratchState();
  const identity = await newIdentity(true);
  await handshake(state, identity, { pairFrom: state });
  findDevice(state, identity.fp)!.revokedAt = Date.now();

  const { client, engine } = link();
  const eng = engineOver(engine, state);
  const dev = new Device(client, identity);
  await dev.hello();
  await dev.secOk({ pairFrom: state }); // even WITH a valid pair proof

  expect((await dev.sealed("sec-fail")).reason).toBe("revoked");
  await until(() => eng.wire.closed !== null, { what: "the engine to close the pipe" });
  expect(eng.wire.closed).toEqual({ code: 4403, reason: "sec:revoked" });
  expect(eng.sec.ready).toBe(false);
});

test("a malformed device key is refused before any signature work", async () => {
  const state = await scratchState();
  const { client, engine } = link();
  const eng = engineOver(engine, state);
  const dev = new Device(client, await newIdentity(true));

  await dev.hello();
  await dev.sealSend({ t: "sec-ok", dev: "not-a-key-at-all", sig: "AAAA", label: "x" });
  await until(() => eng.wire.closed !== null, { what: "the engine to close the pipe" });
  expect(eng.wire.closed).toEqual({ code: 4401, reason: "sec:bad-dev-key" });
  /* No sec-fail here on purpose: the frame was structurally wrong, so there is
   * nothing to tell a legitimate device about. */
  expect(dev.opened).toEqual([]);
});

test("the first sealed frame MUST be a sec-ok, and a malformed one closes the pipe", async () => {
  const state = await scratchState();
  for (const [name, inner] of [
    ["an app frame", { t: "attach", id: "w1:p1" }],
    ["a sec-ok with no dev", { t: "sec-ok", sig: "AAAA" }],
    ["a sec-ok with no sig", { t: "sec-ok", dev: "spki" }],
    ["a sec-ok with a non-string dev", { t: "sec-ok", dev: 7, sig: "AAAA" }],
    ["a bare object", {}],
    ["null", null],
  ] as const) {
    const { client, engine } = link();
    const eng = engineOver(engine, state);
    const dev = new Device(client, await newIdentity(true));
    await dev.hello();
    await dev.sealSend(inner);
    await until(() => eng.wire.closed !== null, { what: `a close for ${name}` });
    expect(eng.wire.closed, name).toEqual({ code: 4400, reason: "sec:want-sec-ok" });
    expect(eng.frames, name).toEqual([]);
  }
});

test("a plaintext frame after the channel exists closes the pipe", async () => {
  /* Invariant E9's teeth: once sec is up, an unsealed frame is either a bug or
   * someone splicing into the pipe. Either way the channel is over. */
  const state = await scratchState();
  const { client, engine } = link();
  const eng = engineOver(engine, state);
  const dev = new Device(client, await newIdentity(true));

  await dev.hello();
  dev.raw(JSON.stringify({ t: "attach", id: "w1:p1" }));
  await until(() => eng.wire.closed !== null, { what: "the engine to close the pipe" });
  expect(eng.wire.closed).toEqual({ code: 4400, reason: "sec:plaintext-after-sec" });
  expect(eng.frames).toEqual([]);
});

test("a forged sealed frame closes the pipe rather than reaching the dispatcher", async () => {
  const state = await scratchState();
  const { client, engine } = link();
  const eng = engineOver(engine, state);
  const dev = new Device(client, await newIdentity(true));

  await dev.hello();
  dev.raw(JSON.stringify({ t: "x", n: 0, ct: "AAAAAAAAAAAAAAAAAAAAAAAA" }));
  await until(() => eng.wire.closed !== null, { what: "the engine to close the pipe" });
  expect(eng.wire.closed).toEqual({ code: 4401, reason: "sec:bad-frame" });
  expect(eng.frames).toEqual([]);
});

test("a replayed c2e frame is refused after the channel is up, and the pipe closes", async () => {
  /* The counter lives in the channel, so a frame the engine already accepted
   * cannot be re-sent to make it act twice ("approve" replayed at the right
   * moment). The refusal surfaces here as a bad-frame close. */
  const state = await scratchState();
  const { dev, eng, engineWire } = await handshake(state, await newIdentity(true), { pairFrom: state });
  const sealed = await dev.chan!.seal({ t: "attach", id: "w1:p1" });
  dev.raw(JSON.stringify(sealed));
  await until(() => eng.frames.length > 0, { what: "the dispatcher to receive the attach frame" });
  dev.raw(JSON.stringify(sealed)); // the same bytes again
  await until(() => engineWire.closed !== null, { what: "the engine to close the pipe" });
  expect(engineWire.closed).toEqual({ code: 4401, reason: "sec:bad-frame" });
  expect(eng.frames.length).toBe(1);
});

test("junk before hello is ignored, not answered and not fatal", async () => {
  /* A port scanner, a stray health probe, a half-written frame. None of them
   * should get an answer (which would confirm what this is) and none should
   * kill a pipe a real client is about to use. */
  const state = await scratchState();
  const { client, engine } = link();
  const eng = engineOver(engine, state);
  const dev = new Device(client, await newIdentity(true));

  /* THE LITERAL `null` IS IN THIS LIST, and it is the reason the list exists.
   * JSON.parse("null") SUCCEEDS, so the try/catch in feed() never saw it, and
   * the next line read `m.t` off null: "TypeError: null is not an object".
   * rtc-glue calls feed as `void sec.feed(raw)`, so that was an unhandled
   * rejection reachable by any peer that could open a DataChannel, before it
   * had proved anything at all. `null`, `123` and `"a string"` are all valid
   * JSON and none of them is a frame; feed() drops every non-object now. */
  for (const junk of ["{not json", "null", '"a string"', "123", '{"t":"attach"}',
                      '{"t":"x","n":0,"ct":"AA"}']) {
    dev.raw(junk);
  }
  await until(() => engine.sent.length === 0 && client.sent.length === 6, { what: "the junk to be consumed" });
  expect(dev.wire).toEqual([]);
  expect(eng.wire.closed).toBeNull();

  // and the pipe still works: a real hello gets a real sec frame
  await dev.hello();
  expect(dev.chan).not.toBeNull();
});

test("a hello with a malformed sec offer falls back to sec-required, it does not throw", async () => {
  const state = await scratchState();
  const { client, engine } = link();
  const eng = engineOver(engine, state);
  const dev = new Device(client, await newIdentity(true));

  dev.raw(JSON.stringify({ t: "hello", sec: { v: 2 } })); // no ce
  const got = await dev.plain("sec-required");
  expect(got.fp).toBe(state.identity.fp);
  expect(eng.wire.closed).toBeNull();
});

test("markClosed stops the state machine: a frame arriving after the pipe died does nothing", async () => {
  /* rtc-glue calls markClosed from pipe.onclose. Without it a frame still in
   * flight when the DataChannel dies would enrol a device onto a connection
   * that no longer exists. */
  const state = await scratchState();
  const { client, engine } = link();
  const eng = engineOver(engine, state);
  const dev = new Device(client, await newIdentity(true));

  await dev.hello();
  eng.sec.markClosed();
  await dev.secOk({ pairFrom: state });
  await until(() => client.sent.length === 2, { what: "the sec-ok to be delivered" });
  expect(state.devices.length).toBe(0);
  expect(eng.sec.ready).toBe(false);
  expect(dev.opened).toEqual([]);
});

/* --- sealed sends from the engine side ------------------------------------ */

test("sealSend before the channel exists is a no-op, not a throw", async () => {
  /* The hello burst is fired from onReady, but presence and log frames can be
   * queued from anywhere. A send on a connection that never got past hello has
   * to be dropped quietly; throwing would take down whatever fired it. */
  const state = await scratchState();
  const { engine } = link();
  const eng = engineOver(engine, state);
  await eng.sec.sealSend({ t: "presence", n: 1 });
  expect(engine.sent).toEqual([]);
});

test("a burst of sealSends reaches the device in counter order", async () => {
  /* The GCM counter is per-frame and the receiver refuses anything out of
   * order, so sealing concurrently and writing whenever each finishes would
   * make the device drop the tail of every burst. EngineSecConn chains its
   * writes; this fires ten without awaiting to prove the chain holds. */
  const state = await scratchState();
  const { eng, dev } = await handshake(state, await newIdentity(true), { pairFrom: state });
  const sends = [];
  for (let i = 0; i < 10; i++) sends.push(eng.sec.sealSend({ t: "presence", i }));
  await Promise.all(sends);

  await until(() => dev.opened.filter((f) => f?.t === "presence").length === 10, {
    what: "ten sealed presence frames",
  });
  expect(dev.opened.filter((f) => f?.t === "presence").map((f) => f.i)).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
  expect(dev.openErrors).toEqual([]);
});

/* --- what a returning device is told -------------------------------------- */

test("sec-done hands a returning device every content generation and the live device list", async () => {
  const state = await scratchState();
  const identity = await newIdentity(true);
  await handshake(state, identity, { label: "laptop", pairFrom: state });
  // a second device enrols and is then revoked; the returning laptop must not see it
  const gone = enrolDevice(state, "fp-gone", "spki-gone", "old phone");
  gone.revokedAt = Date.now();

  const { secDone } = await handshake(state, identity);
  expect(secDone.content.map((c: any) => c.gen)).toEqual([1]);
  expect(secDone.content[0].key).toEqual(expect.any(String));
  expect(secDone.devices.map((d: any) => d.label)).toEqual(["laptop"]);
  expect(secDone.cap).toBeUndefined();
});
