/* The engine's RelayLink (agent-engine/src/transport/relay.ts) against an IN-TEST fake relay
 * service: the Bearer dial, the r envelope, a real DataChannel negotiated
 * through it (werift on both sides), the 4401 token drop, the 4409
 * supersede, the refusals, and resolveRelayUrl. The real relay service has its
 * own suite (server/src/relay.test.ts); this proves the ENGINE half.
 *
 * Nothing here boots an engine and nothing here opens a port anybody else knows
 * about: every listener is `port: 0` read back, and every socket dies with its
 * test. The one real-time thing in the file is the DataChannel handshake, which
 * is genuine async I/O and is waited on with until(), never slept through.
 *
 *   bun test agent-engine/src/transport/relaylink.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import {
  RelayLink,
  resolveRelayUrl,
  RELAY_BACKOFF_MIN_MS,
  RELAY_BACKOFF_MAX_MS,
  RELAY_JITTER_MS,
  type RelayConn,
} from "./relay";
import { loadRtc, adaptDc, adaptPc, RTC } from "./rtc";
import { dcPipe, type Pipe } from "./dcpipe";
import { until } from "../test-utils/wait.ts";

/* THE ENGINE'S OWN OUTBOUND SOCKET RIDES THE REAL WIRE.
 *
 * `bun run test:e2e` preloads e2e/testpreload.ts, which swaps
 * globalThis.WebSocket for the app-client TestClient shim so an app-side hello
 * lands on a DataChannel. This file is in the default (no-preload) run, so the
 * global is already the real ctor; the `.Native` unwrap is the belt for anyone
 * who runs it WITH the preload, because dialing a relay through the app-client
 * shim would prove nothing about the engine leg. Importing e2e/testclient from
 * here is forbidden (gate 1) and unnecessary: the shim hangs the original ctor
 * off itself. */
const NativeWS: typeof WebSocket =
  ((globalThis.WebSocket as any)?.Native as typeof WebSocket | undefined) ?? globalThis.WebSocket;

let werift: any = null;
const cleanups: Array<() => void> = [];

/** The device stand-in: a real werift peer that pre-negotiates the `cyc`
 *  DataChannel the shipped dialer does ({negotiated:true, id:0}) and trickles
 *  its offer + candidates out through `onOffer`/`onCand`, exactly as the relay
 *  service would wrap them into the r envelope. */
async function clientPeer(
  onOffer: (sdp: string) => void,
  onCand: (c: { candidate: string; sdpMid: string }) => void,
): Promise<{ pc: any; dc: any }> {
  if (!werift) werift = await import("werift");
  const pc = new werift.RTCPeerConnection({ iceServers: [] });
  cleanups.push(() => { try { pc.close(); } catch { /* already gone */ } });
  pc.onIceCandidate.subscribe((cand: any) => {
    if (cand) onCand({ candidate: String(cand.candidate ?? ""), sdpMid: cand.sdpMid ?? "0" });
  });
  const dc = pc.createDataChannel("cyc", { ordered: true, negotiated: true, id: 0 });
  // createDataChannel first, then the offer, so the m=application section is in it.
  await pc.setLocalDescription(await pc.createOffer());
  onOffer(pc.localDescription.sdp);
  return { pc, dc };
}

/** Feed the engine's rtc-answer / rtc-cand frames back into the client peer. */
function feedAnswer(clientPc: any, f: any): void {
  if (f.t === "rtc-answer") void clientPc.setRemoteDescription({ type: "answer", sdp: f.sdp }).catch(() => {});
  else if (f.t === "rtc-cand" && f.cand)
    void clientPc.addIceCandidate({ candidate: f.cand.candidate, sdpMid: f.cand.sdpMid ?? "0", sdpMLineIndex: 0 }).catch(() => {});
}
afterEach(() => {
  while (cleanups.length) {
    try { cleanups.pop()!(); } catch { /* teardown */ }
  }
});

/** Spend `ms` of real time. Proving an ABSENCE (nothing redialed after a 4409)
 *  is the one shape that cannot be polled for, so it waits for the clock to
 *  pass instead. until() is the only sanctioned way to spend real time. */
async function elapse(ms: number): Promise<void> {
  const done = Date.now() + ms;
  await until(() => Date.now() >= done, { timeoutMs: ms + 2_000, what: `${ms}ms of quiet` });
}

/** A fake relay: one ws endpoint that records every dial's auth header, hands
 *  the test the live socket, and lets it speak raw envelope frames. `refuse`
 *  turns it into a relay that rejects the upgrade outright (a bearer the
 *  app-server no longer introspects), which is NOT the same wire event as a
 *  4401 close and must not be treated as one. */
function fakeRelay(o: { refuse?: (auth: string | null) => boolean } = {}) {
  const dials: Array<string | null> = [];
  const inbox: any[] = [];
  let sock: any = null;
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, s) {
      const auth = req.headers.get("authorization");
      dials.push(auth);
      if (o.refuse?.(auth)) return new Response("no", { status: 401 });
      return s.upgrade(req) ? undefined : new Response("no", { status: 426 });
    },
    websocket: {
      open(ws) { sock = ws; },
      message(_ws, raw) { inbox.push(JSON.parse(String(raw))); },
      close(ws) { if (sock === ws) sock = null; },
    },
  });
  const api = {
    url: `ws://127.0.0.1:${srv.port}/engine`,
    /** Every dial's Authorization header, in order. Length IS the dial count. */
    dials,
    /** Everything the engine has said, still unread. */
    inbox,
    get auth() { return dials.length ? dials[dials.length - 1] : null; },
    get sock() { return sock; },
    send: (m: unknown) => sock.send(JSON.stringify(m)),
    /** The raw string form, for frames that are not JSON at all. */
    sendRaw: (s: string) => sock.send(s),
    next: async (pred: (m: any) => boolean = () => true, timeoutMs = 5_000): Promise<any> => {
      let hit: any = null;
      await until(() => {
        const i = inbox.findIndex(pred);
        if (i < 0) return false;
        hit = inbox.splice(i, 1)[0];
        return true;
      }, { timeoutMs, what: "an envelope frame from the engine" });
      return hit;
    },
    connected: () => until(() => !!sock, { timeoutMs: 5_000, what: "the engine link to connect" }),
    stop: () => srv.stop(true),
  };
  cleanups.push(api.stop);
  return api;
}

function startLink(
  url: string | null,
  over: Partial<ConstructorParameters<typeof RelayLink>[0]> = {},
) {
  const pipes: Array<{ pipe: Pipe; conn: RelayConn }> = [];
  const rejected: string[] = [];
  const link = new RelayLink({
    url: async () => url,
    token: async () => "cyt_live",
    onAuthReject: (why) => rejected.push(why),
    onPipe: (pipe, conn) => pipes.push({ pipe, conn }),
    log: () => {},
    // A redial the test can time: a short ladder with the fleet-spreading
    // jitter pinned off. Production keeps RELAY_BACKOFF_MIN_MS/JITTER.
    backoffMinMs: 20, backoffMaxMs: 40, jitterMs: 0,
    wsCtor: NativeWS,
    ...over,
  });
  cleanups.push(() => link.stop());
  link.start();
  return { link, pipes, rejected };
}

/* ------------------------------------------------------------------ the dial */

test("dials with the Bearer; unavailable rtc answers rtc-fail through the envelope", async () => {
  // RTC deliberately NOT loaded in this test's path: force the flag off, so the
  // answer has to be an honest refusal rather than a hang.
  const was = RTC.available;
  RTC.available = false;
  cleanups.push(() => { RTC.available = was; });

  const relay = fakeRelay();
  const { link } = startLink(relay.url);
  await relay.connected();
  expect(relay.auth).toBe("Bearer cyt_live");
  expect(link.connected).toBe(true);

  relay.send({ t: "r-open", c: "c1", rtc: { iceServers: [] } });
  relay.send({ t: "r", c: "c1", f: JSON.stringify({ t: "rtc-offer", id: "o1", sdp: "v=0" }) });
  const m = await relay.next((x) => x.t === "r" && x.c === "c1");
  // The refusal rides the SAME conn the offer came in on. A rtc-fail on the
  // wrong c would leave the device waiting forever on a leg nobody answers.
  expect(m.c).toBe("c1");
  expect(JSON.parse(m.f)).toEqual({ t: "rtc-fail", id: "o1", reason: "unavailable" });
  // and it said that ONCE: no second frame, no retry storm behind it.
  await elapse(60);
  expect(relay.inbox).toEqual([]);
});

test("no relay url and no token: the link stays idle rather than dialing anything", async () => {
  // Every local install: /config names no relay, so resolveRelayUrl is null and
  // the link must sit there. A bug here is an engine hammering a URL it made up.
  const relay = fakeRelay();
  startLink(null);
  await elapse(200); // ~10 backoff cycles at 20ms
  expect(relay.dials).toEqual([]);
});

test("a fresh install with no token yet never dials, and picks the token up when enrollment lands", async () => {
  const relay = fakeRelay();
  let token = "";
  startLink(relay.url, { token: async () => token });
  await elapse(200);
  expect(relay.dials).toEqual([]); // the announce tick owns enrollment; this waits

  token = "cyt_issued";
  await until(() => relay.dials.length >= 1, { timeoutMs: 3_000, what: "the dial after enrollment" });
  expect(relay.dials[0]).toBe("Bearer cyt_issued");
});

test("a url() that throws is not fatal: the link schedules and comes back", async () => {
  const relay = fakeRelay();
  let boom = true;
  startLink(relay.url, {
    url: async () => { if (boom) throw new Error("/config unreachable"); return relay.url; },
  });
  await elapse(120);
  expect(relay.dials).toEqual([]);
  boom = false;
  await relay.connected();
  expect(relay.auth).toBe("Bearer cyt_live");
});

test("a relay that refuses the bearer outright is redialed, and NO token is dropped", async () => {
  /* 401 on the upgrade is not the 4401 close. The app-server may simply be down
   * for introspection; dropping the token here would force a pointless
   * re-enrollment every time the relay hiccups. */
  const relay = fakeRelay({ refuse: () => true });
  const { rejected } = startLink(relay.url);
  await until(() => relay.dials.length >= 3, { timeoutMs: 3_000, what: "three refused dials" });
  expect(rejected).toEqual([]);
  expect(new Set(relay.dials)).toEqual(new Set(["Bearer cyt_live"]));
});

test("a 4401 close drops the token and redials; a 4409 close means a newer socket won and stops", async () => {
  const a = fakeRelay();
  const { rejected } = startLink(a.url);
  await a.connected();
  a.sock.close(4401, "unauthorized");
  // the token is dropped so the announce tick re-enrolls...
  await until(() => rejected.length > 0, { timeoutMs: 3_000, what: "the 4401 auth reject" });
  expect(rejected).toEqual(["relay 4401"]);
  // ...and the link comes back for the fresh one, because 4401 is recoverable.
  await until(() => a.dials.length >= 2, { timeoutMs: 3_000, what: "the redial after 4401" });

  const b = fakeRelay();
  const second = startLink(b.url);
  await b.connected();
  expect(b.dials.length).toBe(1);
  b.sock.close(4409, "superseded");
  /* 4409 says another process of THIS engine holds the leg. Redialing would
   * knock the good socket off in turn and the two would trade the relay
   * forever, which is the loop this branch exists to prevent. */
  await elapse(300); // ~15 backoff cycles: a redial would have landed
  expect(b.dials.length).toBe(1);
  expect(second.rejected).toEqual([]);
  expect(second.link.connected).toBe(false);
});

test("the default backoff is the documented one, so a dead relay is not hammered", async () => {
  /* No backoffMinMs override: the real ladder. A redial inside 200ms would mean
   * someone turned the constants into a hot loop against the relay box. */
  const relay = fakeRelay({ refuse: () => true });
  startLink(relay.url, { backoffMinMs: undefined, backoffMaxMs: undefined, jitterMs: 0 });
  await until(() => relay.dials.length >= 1, { timeoutMs: 3_000, what: "the first dial" });
  await elapse(200);
  expect(relay.dials.length).toBe(1);
  expect(RELAY_BACKOFF_MIN_MS).toBe(5_000);
  expect(RELAY_BACKOFF_MAX_MS).toBe(60_000);
  expect(RELAY_JITTER_MS).toBe(1_000);
});

test("stop() closes the socket and never dials again", async () => {
  const relay = fakeRelay();
  const { link } = startLink(relay.url);
  await relay.connected();
  link.stop();
  await elapse(200);
  expect(relay.dials.length).toBe(1);
  expect(link.connected).toBe(false);
});

/* -------------------------------------------------------------- the envelope */

test("frames the relay could never have meant are ignored, and the link stays usable", async () => {
  const was = RTC.available;
  RTC.available = false;
  cleanups.push(() => { RTC.available = was; });

  const relay = fakeRelay();
  startLink(relay.url);
  await relay.connected();

  relay.sendRaw("not json at all");                       // a torn frame
  relay.send({ t: "r", f: "{}" });                        // no conn id
  relay.send({ t: "r", c: "ghost", f: JSON.stringify({ t: "rtc-offer", id: "x", sdp: "v=0" }) });
  relay.send({ t: "r-close", c: "ghost", code: 1000 });   // a conn that never opened
  relay.send({ t: "r", c: "c1", f: "}{ not json" });      // an r for a conn that never opened
  await elapse(80);
  expect(relay.inbox).toEqual([]); // not one of them earned an answer

  // and the link is still the same live link: a real conn still gets served.
  relay.send({ t: "r-open", c: "c1", rtc: { iceServers: [] } });
  relay.send({ t: "r", c: "c1", f: "}{ still not json" }); // torn INNER frame, known conn
  relay.send({ t: "r", c: "c1", f: JSON.stringify({ t: "rtc-offer", id: "o9", sdp: "v=0" }) });
  const m = await relay.next((x) => x.t === "r");
  expect(JSON.parse(m.f)).toEqual({ t: "rtc-fail", id: "o9", reason: "unavailable" });
});

test("an rtc-abort for a conn with no attempt is a no-op, not a throw", async () => {
  const was = RTC.available;
  RTC.available = false;
  cleanups.push(() => { RTC.available = was; });

  const relay = fakeRelay();
  const { link } = startLink(relay.url);
  await relay.connected();
  relay.send({ t: "r-open", c: "c1", rtc: { iceServers: [] } });
  relay.send({ t: "r", c: "c1", f: JSON.stringify({ t: "rtc-abort", id: "o1" }) });
  relay.send({ t: "r", c: "c1", f: JSON.stringify({ t: "rtc-cand", id: "o1", cand: { candidate: "x", sdpMid: "0" } }) });
  await elapse(80);
  expect(relay.inbox).toEqual([]);
  expect(link.connected).toBe(true);
});

test("a real DataChannel opens THROUGH the envelope and survives r-close after open", async () => {
  await loadRtc();
  if (!RTC.available) throw new Error("werift unavailable under bun");

  const relay = fakeRelay();
  const { pipes } = startLink(relay.url);
  await relay.connected();
  relay.send({ t: "r-open", c: "c1", rtc: { iceServers: [] } });

  // the device stand-in: a werift peer whose signaling frames the test wraps
  // into the envelope by hand, exactly as the relay service would. Its
  // candidates deliberately race the offer, which is the path relay.ts queues
  // in conn.candQ; a link that dropped them would never open.
  const { pc: clientPc, dc: clientDc } = await clientPeer(
    (sdp) => relay.send({ t: "r", c: "c1", f: JSON.stringify({ t: "rtc-offer", id: "o1", sdp }) }),
    (c) => relay.send({ t: "r", c: "c1", f: JSON.stringify({ t: "rtc-cand", id: "o1", cand: c }) }),
  );
  const client = dcPipe(adaptDc(clientDc), adaptPc(clientPc));
  cleanups.push(() => { try { client.close(); } catch {} });

  // the engine's answer and candidates flow back; feed them to the client
  const feeding = (async () => {
    for (;;) {
      const m = await relay.next((x) => x.t === "r" && x.c === "c1", 20_000);
      const f = JSON.parse(m.f);
      if (f.t === "rtc-fail") throw new Error("rtc-fail " + f.reason);
      feedAnswer(clientPc, f);
    }
  })().catch(() => { /* the loop dies with the test */ });

  // the engine pipe arrives via onPipe once the DC opens, carrying ITS conn:
  // server.ts mints the sealed client against that conn, so a wrong one would
  // seal a chat onto the wrong device leg.
  await until(() => pipes.length > 0, { timeoutMs: 20_000, what: "the engine pipe to open" });
  expect(pipes.length).toBe(1);
  expect(pipes[0].conn.id).toBe("c1");
  const engine = pipes[0].pipe;
  cleanups.push(() => { try { engine.close(); } catch {} });
  engine.onmessage = (s) => engine.send("echo:" + s);

  const echo = async (msg: string): Promise<string> => {
    let got: string | null = null;
    client.onmessage = (s) => { got = s; };
    await until(() => client.open, { timeoutMs: 10_000, what: "the client DataChannel to open" });
    client.send(msg);
    await until(() => got !== null, { timeoutMs: 10_000, what: `the echo of ${msg}` });
    return got!;
  };
  expect(await echo("ping")).toBe("echo:ping");

  // THE DETACH RULE: the signaling conn dies (device leg closed after upgrade,
  // or the relay restarted); the OPEN pipe lives on. This is the property that
  // lets a chat survive an app-server restart: the relay is a matchmaker,
  // never the transport.
  relay.send({ t: "r-close", c: "c1", code: 1000 });
  await elapse(150);
  expect(engine.open).toBe(true);
  expect(await echo("ping2")).toBe("echo:ping2");

  // and the whole link going down does not take the opened pipe with it either
  relay.sock.close(1006, "relay restarted");
  await elapse(150);
  expect(engine.open).toBe(true);
  expect(await echo("ping3")).toBe("echo:ping3");
  void feeding;
}, 40_000);

test("an r-close BEFORE the DataChannel opens tears the attempt down and mints no pipe", async () => {
  await loadRtc();
  if (!RTC.available) throw new Error("werift unavailable under bun");

  const relay = fakeRelay();
  const { pipes } = startLink(relay.url);
  await relay.connected();
  relay.send({ t: "r-open", c: "c1", rtc: { iceServers: [] } });

  // an offer from a peer that will never be answered to: the engine starts an
  // attempt, then the leg dies before any DataChannel could open.
  await clientPeer(
    (sdp) => relay.send({ t: "r", c: "c1", f: JSON.stringify({ t: "rtc-offer", id: "o1", sdp }) }),
    (c) => relay.send({ t: "r", c: "c1", f: JSON.stringify({ t: "rtc-cand", id: "o1", cand: c }) }),
  );

  await relay.next((x) => x.t === "r" && JSON.parse(x.f).t === "rtc-answer", 20_000);
  relay.send({ t: "r-close", c: "c1", code: 1000 });
  await elapse(300);
  expect(pipes.length).toBe(0);
}, 40_000);

test("device-key auth (step 8): a good proof answers r-accept, a bad one r-reject and drops the conn", async () => {
  const was = RTC.available;
  RTC.available = false;
  cleanups.push(() => { RTC.available = was; });

  // the verifier stands in for sec.verifyRelayAuth: accept the "good" key only.
  const relay = fakeRelay();
  const { link } = startLink(relay.url, {
    onRelayAuth: async (auth: any) => auth?.spki === "good",
  });
  await relay.connected();

  // a good proof: r-accept rides the SAME conn, and only that.
  relay.send({ t: "r-open", c: "cA", rtc: { iceServers: [] }, auth: { nonce: "n", spki: "good", sig: "s" } });
  const acc = await relay.next((x) => x.t === "r-accept");
  expect(acc.c).toBe("cA");

  // a bad proof: r-reject, and the conn is torn down (a later r for it is ignored).
  relay.send({ t: "r-open", c: "cB", rtc: { iceServers: [] }, auth: { nonce: "n", spki: "bad", sig: "s" } });
  const rej = await relay.next((x) => x.t === "r-reject");
  expect(rej.c).toBe("cB");
  relay.send({ t: "r", c: "cB", f: JSON.stringify({ t: "rtc-offer", id: "o1", sdp: "v=0" }) });
  await elapse(80);
  expect(relay.inbox).toEqual([]); // the rejected conn answers nothing further
  expect(link.connected).toBe(true);
});

/* ------------------------------------------------------------ discovery */

test("resolveRelayUrl: the RELAY_URL pin wins and still names this engine", () => {
  // The explicit pin is the /engine ws base; ?engine= is stamped onto it.
  expect(resolveRelayUrl("http://127.0.0.1:18080", "eng-1", "wss://pinned/engine"))
    .toBe("wss://pinned/engine?engine=eng-1");
  // and the pin does not even need an app server url to be present
  expect(resolveRelayUrl("", "eng-1", "wss://pinned/engine"))
    .toBe("wss://pinned/engine?engine=eng-1");
});

test("resolveRelayUrl: derives the app-server /engine url in every mode", () => {
  // LOCAL default: http app-server -> ws /engine leg naming the engine.
  expect(resolveRelayUrl("http://127.0.0.1:18080", "eng-1"))
    .toBe("ws://127.0.0.1:18080/engine?engine=eng-1");
  // HOSTED: https -> wss, host preserved.
  expect(resolveRelayUrl("https://app.example.com", "eng-1"))
    .toBe("wss://app.example.com/engine?engine=eng-1");
  // no app server url at all, or no engineId: null (the link idles)
  expect(resolveRelayUrl("", "eng-1")).toBeNull();
  expect(resolveRelayUrl("http://127.0.0.1:18080", "")).toBeNull();
});

test("resolveRelayUrl refuses a base that is not http(s)/ws(s), and never throws", () => {
  // The answer becomes `new WebSocket(url)`, so a non-ws(s) result must be null.
  expect(resolveRelayUrl("ftp://relay.example.com", "eng-1")).toBeNull();
  expect(resolveRelayUrl("not a url", "eng-1")).toBeNull();
  expect(resolveRelayUrl("", "eng-1", "javascript:alert(1)")).toBeNull();
  // an https(s) base -- pin or app-server -- is normalised to wss, never refused.
  expect(resolveRelayUrl("", "eng-1", "https://relay.example.com/engine"))
    .toBe("wss://relay.example.com/engine?engine=eng-1");
});
