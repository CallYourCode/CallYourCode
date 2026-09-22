/* THE ONE ENGINE BOOT THAT PROVES THE WHOLE PIPE, END TO END.
 *
 * WHAT THE BOOT IS BUYING, and it is the justification for the ~10 wall seconds
 * this file costs. Every claim below is about something that only exists once a
 * REAL `bun run server.ts` is listening on a real port with a real WebRTC
 * DataChannel underneath it:
 *
 *   - ENROLMENT AND ANNOUNCE are boot-time behaviour. A seam test can call
 *     `makeAnnounce(...).tick()` and prove the token rides the header
 *     (announce.test.ts does), but only a booted engine proves the engine
 *     ENROLS BEFORE IT SPEAKS. That ordering is a property of server.ts's
 *     startup, not of announce.ts.
 *   - THE RAW-WS REFUSAL is a property of the server's upgrade handler. In
 *     process you can only ask a fake; here a native WebSocket really does get
 *     `transport-required` and close 4426, and really does get no burst.
 *   - THE ONE-PIPE INVARIANT (E9) is a claim about TWO transports at once: what
 *     rode the signaling socket and what rode the DataChannel. There is no seam
 *     at which both exist unless both exist.
 *   - THE SEALED HANDSHAKE is werift talking SCTP to werift
 *     over loopback, with the engine's own keys.json minting the pair proof. A
 *     fake pipe would agree with whatever the code believes about framing.
 *   - MULTI-FRAGMENT is the reason the DataChannel is here at all: dcpipe splits
 *     at FRAG_MAX (16KB), and a frame over 64KB is five fragments that a real
 *     SCTP channel has to reassemble in order. In-process the framing is a
 *     no-op.
 *   - TYPED AND SUBMITTED is the herdr round trip. `typed()` is what the engine
 *     ASKED for; `submitted()` is what a real enter actually pushed into the
 *     agent, and the two differ (an enter into an emptied box types nothing and
 *     submits nothing). Only the fake herdr over its real JSON-RPC socket can
 *     tell them apart.
 *   - THE DATA-DIR REPAIR happens exactly once, at boot, over a tree that was
 *     already on disk. There is no function to call for it after the fact.
 *   - THE ONE-FRAME OPEN over a transcript this engine has never read (design
 *     A.4, A.5): the ingest's backfill runs in the booted process at the lowest
 *     priority, so only a real boot can show an attach painting ONE frame while
 *     the backfill is still running, and the tail streaming records after it.
 *
 * Sources carried across: enroll.test.ts (the booted half), announce.test.ts
 * (the token on the announce), wsflip.test.ts, onepipe.test.ts,
 * rtcserver.test.ts, contract.test.ts (its sealed-wire test), rtc.test.ts (the
 * large-frame half), runfiles.test.ts (its boot assertion).
 *
 *   bun test --preload ./e2e/testpreload.ts e2e/roundtrip.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { chmodSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSealedClient, startEngine, hasE2ETransport, seedTranscript, HARNESS_CWD, PANE, type Engine } from "./harness.ts";
import { TestClient, sealedSecOk } from "./testclient.ts";
import { DIR_MODE, FILE_MODE } from "../../../shared/runfiles.ts";
import { mungeCwd } from "../../../shared/claude-projects.ts";
import { loadRtc, adaptDc, adaptPc, RTC } from "../transport/rtc.ts";
import { dcPipe } from "../transport/dcpipe.ts";
import { newIdentity, SecureChannel, type SecFrame, type SealedFrame } from "../../../shared/e2e.ts";

let engine: Engine | null = null;
afterEach(async () => {
  /* A LEAKED ENGINE IS A LEAKED PORT AND A LEAKED SUBPROCESS, and this file is
   * one of four allowed to make either. */
  await engine?.stop();
  engine = null;
});

const modeOf = (p: string) => statSync(p).mode & 0o777;

/** Bounded poll. Real network I/O, so a condition, never a blind sleep. */
async function until<T>(f: () => T | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`never happened within ${ms}ms: ${what}`);
    await Bun.sleep(50);
  }
}

/** Open a RAW WS (not the shim), send one plain hello, and report what came
 *  back and how the socket died. wsflip.test.ts, verbatim in behaviour. */
async function rawHello(url: string, ms: number) {
  const ws = new TestClient.Native(url);
  const frames: any[] = [];
  let closed = false;
  let closeCode = 0;
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws failed"));
  });
  ws.onmessage = (ev) => {
    try { frames.push(JSON.parse(String(ev.data))); } catch { /* not ours */ }
  };
  ws.onclose = (ev) => { closed = true; closeCode = ev.code; };
  ws.send(JSON.stringify({ t: "hello" }));
  await Bun.sleep(ms);
  try { ws.close(); } catch { /* already gone */ }
  return { types: frames.map((f) => f.t), frames, closed, closeCode };
}

/* THE FRAME-TYPE HISTOGRAM (invariant E9, CONTRACT.md section 2). Drives its
 * OWN werift peer rather than the shim, because the shim hides which
 * socket each frame went out on and that is the entire question here. */
async function onePipeHistogram(e: Engine, closers: Array<() => void>) {
  const werift: any = await import("werift");
  await loadRtc();
  const wsTypes = new Set<string>();
  const dcTypes = new Set<string>();

  const ws = new WebSocket(e.url); // first frame is rtc-offer -> shim passthrough
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws failed"));
  });
  closers.push(() => { try { ws.close(); } catch { /* already gone */ } });
  const wsSend = (o: any) => { wsTypes.add(o.t); ws.send(JSON.stringify(o)); };

  const pc = new werift.RTCPeerConnection({ iceServers: [] });
  closers.push(() => { try { pc.close(); } catch { /* already gone */ } });
  // candidates gathered before the offer is on the wire wait for it
  let offerSent = false;
  const pendingCands: any[] = [];
  pc.onIceCandidate.subscribe((cand: any) => {
    if (!cand) return;
    const f = { t: "rtc-cand", id: "e9", cand: { candidate: String(cand.candidate ?? ""), sdpMid: cand.sdpMid ?? "0", sdpMLineIndex: 0 } };
    if (offerSent) wsSend(f); else pendingCands.push(f);
  });
  ws.onmessage = (ev) => {
    let m: any;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    wsTypes.add(m.t);
    if (m.t === "rtc-answer") void pc.setRemoteDescription({ type: "answer", sdp: m.sdp }).catch(() => {});
    else if (m.t === "rtc-cand" && m.cand) {
      void pc.addIceCandidate({ candidate: m.cand.candidate, sdpMid: m.cand.sdpMid ?? "0", sdpMLineIndex: 0 }).catch(() => {});
    }
  };

  // the pre-negotiated stream-0 channel the browser dialer creates
  const dc = pc.createDataChannel("cyc", { ordered: true, negotiated: true, id: 0 });
  await pc.setLocalDescription(await pc.createOffer());
  wsSend({ t: "rtc-offer", id: "e9", sdp: pc.localDescription.sdp });
  offerSent = true;
  for (const f of pendingCands.splice(0)) wsSend(f);
  const pipe = dcPipe(adaptDc(dc), adaptPc(pc));
  closers.push(() => { try { pipe.close(); } catch { /* already gone */ } });
  await Promise.race([
    new Promise<void>((r) => (pipe.open ? r() : (pipe.onopen = () => r()))),
    new Promise<void>((_, rej) => setTimeout(() => rej(new Error("DC never opened")), 12_000)),
  ]);

  const dev = await newIdentity(true);
  const offer = await SecureChannel.offer();
  let chan: SecureChannel | null = null;
  await new Promise<void>((resolve, reject) => {
    setTimeout(() => reject(new Error("no sec-done")), 8_000);
    pipe.onmessage = async (raw) => {
      const m = JSON.parse(raw);
      dcTypes.add(m.t === "x" ? "x" : m.v === 2 && m.ee ? "sec" : String(m.t));
      if (m.v === 2 && m.ee) {
        chan = await SecureChannel.accept(offer, m as SecFrame, null);
        // sec-ok rides sealed (t:"x") and carries the key-required pair proof
        pipe.send(JSON.stringify(await sealedSecOk(chan, dev, "e9", e.port)));
        dcTypes.add("x");
        return;
      }
      if (m.t === "x" && chan) {
        const inner = await chan.open(m as SealedFrame);
        if (inner?.t === "sec-done") resolve();
      }
    };
    dcTypes.add("hello");
    pipe.send(JSON.stringify({ t: "hello", sec: offer.hello }));
  });
  return { wsTypes, dcTypes };
}

// Needs the DataChannel transport the e2e preload installs (`bun run test:e2e`);
// under a bare `bun test` the sealed handshake cannot complete, so skip loudly
// rather than time out. See hasE2ETransport in harness.ts.
test.skipIf(!hasE2ETransport)("one engine, one round trip: enrolled, raw wire refused, sealed pipe carrying a chat both ways", async () => {
  const closers: Array<() => void> = [];
  try {
    /* Booted over a data dir that is ALREADY world-readable, which is the only
     * way to ask whether the boot repair runs: a fresh tree is 0700 because
     * every write made it so, and that proves nothing about repairRunTree.
     * runfiles.test.ts's boot assertion, carried across. */
    engine = await startEngine({
      seed: async (dir) => {
        const data = join(dir, "data");
        await writeFile(join(data, "settings.json"), JSON.stringify({}), { mode: 0o664 });
        chmodSync(data, 0o775);
      },
    });
    const e = engine;

    /* ------------------------------------------------- (1) it enrolled first */

    /* enroll.test.ts's booted half plus announce.test.ts's header assertion. An
     * engine that announces without a token is an engine the app server has no
     * reason to believe, and an announce bearing a DIFFERENT token than the one
     * it was issued is the bug enrolment exists to make impossible. */
    await until(() => e.sink.announces.length > 0, 15_000, "the engine to announce");
    expect(e.sink.enrolls.length,
      "the engine announced without enrolling first: nothing issued the token it is bearing")
      .toBeGreaterThanOrEqual(1);
    expect(e.sink.announces[0].auth, "the announce did not bear the issued token")
      .toBe(e.sink.enrolls[0]);
    expect(e.sink.announces[0].host, "the announce does not say which host it is")
      .toBe("probe");

    /* ---------------------------------- (2) a plain WS hello is refused, 4426 */

    /* #579: the WS is signaling-only. Over the RAW socket (never the shim, which
     * would take the hello onto the DataChannel), a plain hello is answered
     * `transport-required` and closed, and the plaintext burst never rides it.
     * wsflip.test.ts, carried across whole. */
    const raw = await rawHello(e.url, 700);
    expect(raw.types).toContain("transport-required");
    expect(raw.types, "the plaintext burst rode the WS").not.toContain("can");
    expect(raw.types, "the plaintext burst rode the WS").not.toContain("host");
    expect(raw.types, "the plaintext burst rode the WS").not.toContain("sessions");
    expect(raw.closed).toBe(true);
    expect(raw.closeCode, "the CONTRACT ws-transport close code").toBe(4426);
    expect(raw.frames.find((f) => f.t === "transport-required")!.transport,
      "the refusal must tell the app which transport to dial instead").toBe("rtc");

    /* ------------------------------------------- (3) E9: one pipe, one purpose */

    const { wsTypes, dcTypes } = await onePipeHistogram(e, closers);
    expect([...wsTypes].sort(),
      "a non-rtc frame rode the signaling socket; the WS is signaling-only")
      .toEqual(["rtc-answer", "rtc-cand", "rtc-offer"]);
    expect([...dcTypes].every((t) => t === "hello" || t === "sec" || t === "x"),
      `something unsealed rode the DataChannel after sec: ${[...dcTypes].join(",")}`).toBe(true);
    expect(dcTypes.has("hello")).toBe(true);
    expect(dcTypes.has("sec")).toBe(true);
    expect(dcTypes.has("x")).toBe(true);
    while (closers.length) { try { closers.pop()!(); } catch { /* already gone */ } }

    /* ----------------------------- (4) the sealed client gets the hello burst */

    /* rtcserver.test.ts plus contract.test.ts's sealed-wire test: the pair proof
     * enrols a device with no prior row, and what comes back is APPLICATION
     * frames, not a refusal and not a sec-fail. */
    const { ws, frames } = await openSealedClient(e);
    const burst = frames.map((f) => f.t);
    expect(burst, "a sealed hello must not be refused as a raw-WS data frame")
      .not.toContain("transport-required");
    expect(burst, "a valid pair proof must not fail enrolment").not.toContain("sec-fail");
    expect(burst).toContain("can");
    expect(burst).toContain("host");
    expect(burst).toContain("sessions");
    // the plugins frame is additive and sits after `can` (#479)
    await until(() => frames.some((f) => f.t === "plugins"), 4_000,
      "the plugins frame to arrive in the burst");
    expect(frames.findIndex((f) => f.t === "plugins"),
      "the plugins frame must follow `can`, not precede it")
      .toBeGreaterThan(frames.findIndex((f) => f.t === "can"));
    expect(frames.find((f) => f.t === "can")!.list,
      "the `can` list must advertise plugins so the app knows to expect the frame").toContain("plugins");

    const keys = JSON.parse(await Bun.file(join(e.dir, "data", "keys.json")).text());
    expect(keys.devices.length,
      "key-required enrolment with a valid pair proof must add a device row")
      .toBeGreaterThanOrEqual(1);

    /* -------------------------- (5) an app message is typed AND submitted */

    const session = await e.session();
    // the wire names the AGENT, never the pane: the id comes off the sessions frame
    const agentId = await e.wireIdOf(PANE);
    ws.send(JSON.stringify({ t: "attach", id: agentId, since: 0 }));
    const ok = await until(() => frames.find((f) => f.t === "attach-ok"), 5_000,
      "the attach to be answered");
    expect(ok.known, "the success attach-ok must say known: true out loud").toBe(true);

    const said = `typed from the app ${crypto.randomUUID()}`;
    ws.send(JSON.stringify({ t: "utterance", id: agentId, text: said, cid: "cid-roundtrip" }));

    /* THE TWO ARE DIFFERENT QUESTIONS. `typed` is what the engine asked herdr
     * for; `submitted` is what a real enter pushed into the agent, and an enter
     * into an emptied box types nothing and submits nothing. Asserting only the
     * send_text rpc would pass against an engine that never pressed enter. */
    await until(() => e.typed().some((t) => t.includes(said)), 8_000,
      "the message to be typed into the pane");
    const submitted = await until(
      () => e.submitted().find((t) => t.includes(said)), 8_000,
      "the enter to actually submit the typed line into the agent");
    /* TAGGED `TEXT:`, not VOICE. Everything used to arrive tagged VOICE,
     * including what was typed, which is the one clue the agent has that a
     * sentence may be a mis-hearing rather than what he meant. It is part of
     * the line the agent actually reads, so it is asserted on the line the
     * agent actually received. */
    expect(submitted.startsWith(`TEXT: ${said}`),
      `the agent received something other than the tagged line that was typed: ${submitted}`)
      .toBe(true);
    // the echo IS the delivery ack (E4): it carries the sender's cid back
    const echo = await until(
      () => frames.find((f) => f.t === "chat" && f.role === "user" && f.cid === "cid-roundtrip"),
      5_000, "the utterance echo to be broadcast back");
    expect(echo.text).toBe(said);

    /* ------------------------------- (6) the agent's reply comes back sealed */

    const answer = `the agent answers ${crypto.randomUUID()}`;
    session.send(JSON.stringify({ t: "chat", text: answer, msgId: crypto.randomUUID() }));
    const reply = await until(
      () => frames.find((f) => f.t === "chat" && f.role === "claude" && f.text === answer),
      8_000, "the agent reply to arrive as a chat frame");
    expect(reply.id, "the reply must name the agent it belongs to").toBe(agentId);

    /* --------------------- (7) a frame over 64KB survives real SCTP framing */

    /* dcpipe splits at FRAG_MAX (16KB - 1), so this is six fragments the real
     * channel has to carry and reassemble IN ORDER, sealed. rtc.test.ts proved
     * this over a bare loopback pipe; here it is a whole application frame the
     * engine broadcast, through sec, up to a caller. A reassembly bug shows as
     * a truncated or scrambled reply, never as an error. */
    const big = "x".repeat(80_000);
    session.send(JSON.stringify({ t: "chat", text: big, msgId: crypto.randomUUID() }));
    const huge = await until(
      () => frames.find((f) => f.t === "chat" && f.role === "claude" && (f.text ?? "").length === 80_000),
      15_000, "the multi-fragment frame to arrive whole");
    expect(huge.text, "the 80KB frame came back changed: fragments were lost or reordered")
      .toBe(big);
    ws.close();

    /* ------------------------------ (8) the boot repaired the data directory */

    const data = join(e.dir, "data");
    expect(modeOf(data),
      "the boot did not repair a world-readable data dir that was already on disk")
      .toBe(DIR_MODE);
    expect(modeOf(join(data, "settings.json")),
      "the boot did not repair a world-readable file that was already on disk")
      .toBe(FILE_MODE);
  } finally {
    while (closers.length) { try { closers.pop()!(); } catch { /* already gone */ } }
  }
}, 120_000);

/* ---------------------------------- the one-frame open over a cold transcript */

const U_LOG = "5efab003-3333-4eee-8fff-000000000003";

/** A claude transcript of at least `bytes`: one assistant record per line, the
 *  uuid counting up from u000000000 so the pages can be checked for holes. */
function authorTranscript(bytes: number): { content: string; total: number } {
  const base = Date.UTC(2026, 0, 1);
  const pad = "y".repeat(900);
  const line = (i: number) => JSON.stringify({
    type: "assistant", uuid: `u${i.toString().padStart(9, "0")}`,
    timestamp: new Date(base + i).toISOString(),
    message: { content: [{ type: "text", text: `line ${i} ${pad}` }] },
  }) + "\n";
  let content = "", i = 0;
  while (content.length < bytes) { content += line(i); i++; }
  return { content, total: i };
}

test.skipIf(!hasE2ETransport)("one engine over a transcript it has never read: the open is ONE frame while the backfill runs, then the tail streams", async () => {
  /* The pane boots in the no-session-id limbo (a null agent_session), the app
   * dials and is sealed, and only THEN does claude mint its uuid over a
   * transcript of 8 spans' worth (BACKFILL_SPAN is 1 MB). The engine finds
   * that transcript cold: no pointer, so the tail starts at EOF and the
   * backfill owes [0, EOF). The attach goes out on the sessions frame that
   * lists the uuid, the same snapshot that started the backfill, so the first
   * paint lands a few spans in. */
  const big = authorTranscript(8 * 1024 * 1024);
  engine = await startEngine({ noSession: [PANE] });
  const e = engine;
  const { ws, frames } = await openSealedClient(e);
  await e.writeTranscript(U_LOG, { content: big.content });

  /* ------------------------------------ (1) the cold open: one frame, painted */
  await e.mintSession(U_LOG);
  const row = await until(() => [...frames].reverse().find((f) => f.t === "sessions")?.list
    ?.find((s: any) => s.harnessSessionId === U_LOG), 10_000, "the row under the minted uuid");
  const agentId: string = row.id;
  const t0 = Date.now();
  ws.send(JSON.stringify({ t: "attach", id: agentId, since: 0 }));
  const ok = await until(() => frames.find((f) => f.t === "attach-ok"), 10_000, "attach-ok");
  const paintMs = Date.now() - t0;
  expect(ok.known).toBe(true);
  expect(frames.filter((f) => f.t === "attach-ok").length, "exactly ONE attach frame").toBe(1);
  expect(frames.some((f) => f.t === "session-events"), "no second frame for the activity").toBe(false);
  const painted = (ok.pages as any[]).flatMap((p) => p.messages as any[]);
  expect(painted.length, "the first frame is not empty: records are rows on the page").toBeGreaterThan(0);
  expect(painted.some((r) => r.t === "s" && r.src?.rid === "u000000000"),
    "the transcript's first event is on the pointer page of the first paint").toBe(true);
  expect(painted.every((r) => r.t === "s" ? typeof r.seq === "number" && typeof r.kind === "string" : typeof r.seq === "number"),
    "every row carries its seq; a record row is tagged t:s").toBe(true);

  /* ------------------------------ (2) it painted while the backfill still ran */
  const attachAt = e.lines.findIndex((l) => / engine attach .*known=true/.test(l));
  const doneAt = e.lines.findIndex((l) => l.includes(" engine ingest.backfill.done "));
  expect(attachAt, "the attach was logged").toBeGreaterThanOrEqual(0);
  expect(doneAt === -1 || doneAt > attachAt,
    `the first paint (${ok.total} rows, ${paintMs} ms) came before the backfill finished`).toBe(true);
  expect(ok.total, "a partial log at the first paint: the backfill was mid-way").toBeLessThan(big.total);

  /* -------- (3) the rest streams in as live deltas; the pages hold everything */
  await until(() => e.lines.some((l) => l.includes(" engine ingest.backfill.done ")), 60_000, "the backfill to finish");
  const done = e.lines.find((l) => l.includes(" engine ingest.backfill.done "))!;
  expect(done).toMatch(new RegExp(` added=${big.total} `));
  expect(Number(/ spans=(\d+)/.exec(done)?.[1]), "one bounded span per MB").toBeGreaterThanOrEqual(8);
  const rid = (r: any) => (r?.t === "s" || r?.kind) && r?.src?.rid;
  const uuidOf = (i: number) => `u${i.toString().padStart(9, "0")}`;
  /* The open held the pointer page and the tail page; what the log gained
   * AFTER the tail page's last row (seq ok.total onward) reaches an attached
   * client as one session-event delta per record, in seq order, no hole and
   * no repeat. The rows between the two held pages are never pushed: the app
   * fetches those pages when it scrolls to them. */
  const streamed = await until(() => {
    const evs = frames.filter((f) => f.t === "session-event" && f.id === agentId).map((f) => f.ev);
    return evs.length >= big.total - ok.total ? evs : undefined;
  }, 30_000, "the backfilled records past the first paint, as session-event deltas");
  const streamedAt = Date.now();
  expect(streamed.map((ev) => ev.seq)).toEqual(Array.from({ length: big.total - ok.total }, (_, i) => ok.total + i));
  expect(streamed.map(rid)).toEqual(Array.from({ length: big.total - ok.total }, (_, i) => uuidOf(ok.total + i)));
  expect(streamed.every((ev) => ev.kind === "reply" && typeof ev.id === "string" && ev.src?.sid === U_LOG)).toBe(true);
  const tailPage = ok.pages[ok.pages.length - 1] as { page: number; messages: any[] };
  expect(tailPage.messages.at(-1)?.seq, "the deltas continue exactly where the painted tail page ended").toBe(ok.total - 1);
  /* And the pages hold the whole transcript, every event exactly once, in file
   * order: the store the app pages from and the deltas it folded in agree. */
  const seen = Array.from({ length: big.total }, (_, i) => uuidOf(i));
  const pages: any[][] = [];
  for (let n = 0; ; n++) {
    const r = await fetch(`${e.http}/session/${encodeURIComponent(agentId)}/page/${n}`);
    expect(r.status).toBe(200);
    const page = await r.json() as { messages: any[]; sealed: boolean };
    pages.push(page.messages);
    if (!page.sealed) break;
  }
  expect(pages.flat().filter(rid).map(rid), "the pages hold the same transcript, once, in order").toEqual(seen);

  /* --------------------------- (4) the tail streams a new line as it lands */
  const path = join(e.dir, "projects", mungeCwd(HARNESS_CWD), `${U_LOG}.jsonl`);
  expect(await Bun.file(path).exists(), "the transcript this engine tails").toBe(true);
  const live = JSON.stringify({ type: "assistant", uuid: "u-live-0001", timestamp: new Date().toISOString(),
    message: { content: [{ type: "text", text: "streamed after the open" }] } }) + "\n";
  await appendFile(path, live);
  const ev = await until(() => frames.find((f) => f.t === "session-event" && f.ev?.src?.rid === "u-live-0001"),
    10_000, "the live record as a session-event delta");
  expect(ev.id).toBe(agentId);
  // (no expect.any(Number) in a toMatchObject here: bun 1.4.0 replaces the matched property with {})
  expect(ev.ev).toMatchObject({ kind: "reply", text: "streamed after the open" });
  expect(typeof ev.ev.seq).toBe("number");
  expect(ev.ev.seq, "the live record continues the same seq axis").toBeGreaterThanOrEqual(big.total);
  ws.close();
  const bf = / ms=(\d+)/.exec(done)?.[1];
  console.log(`[roundtrip] cold open over ${big.total} events (${big.content.length} bytes): first paint ${paintMs} ms painting ${painted.length} rows of the ${ok.total} logged so far; backfill ${bf} ms; the rest streamed by +${streamedAt - t0} ms; ${pages.length} pages after`);
}, 120_000);

test("a harness engine holds a made-up token, and reaches nothing at all", async () => {
  /* THE GUARDRAILS' TWO OUTCOMES, ON A RUNNING ENGINE. The three specs below
   * prove startEngine REFUSES the bad values; this one is the other half, and
   * it is the half that is about what a spawned engine is actually holding and
   * actually reaching. Both used to live in limits.test.ts, which booted
   * engines; they were dropped when it stopped, and neither is provable without
   * a process.
   *
   * ONE BOOT FOR BOTH, because they are two readings of the same engine and a
   * second boot would cost six seconds to ask a question this one can answer. */
  engine = await startEngine();
  const e = engine;

  /* (1) THE TOKEN IS ON DISK, MADE UP. e2e/harness.ts writes this file, and a
   * line that fixes something is a line somebody deletes -- asserting the value
   * the harness passes would pass whether or not the file it names says this.
   * "Nothing leaked" is a fact about where requests went; this is the other
   * sentence, about what the process was holding, and only that file can say
   * it. Every harness engine was holding his real OAuth token until it was
   * measured. */
  const creds = JSON.parse(await Bun.file(join(e.dir, "credentials.json")).text()) as
    { claudeAiOauth?: { accessToken?: string } };
  expect(creds.claudeAiOauth?.accessToken,
    "a harness engine is signed in with something that is not a made-up token")
    .toBe("harness-not-a-real-token");

  /* (2) AND THE DEFAULT UPSTREAM REALLY IS DEAD rather than merely different.
   * The engine boots, answers, and says it could not check -- which is the
   * state every spec in this repo runs against, so it is worth proving once
   * that it is the state and not an accident.
   *
   * Read through the usage card (the /limits route is gone). This engine has
   * no LIVE agent, so the card route REFUSES with the no-active-harness
   * sentence (the app hides the card on it): the strongest possible form of
   * "no numbers were reached from anywhere" -- there is no face at all. */
  const card = await (await fetch(`${e.http}/plugin/usage-card/card`)).json() as
    { ok?: boolean; html?: string; error?: string };
  expect(card.ok, "a harnessless engine must refuse the usage card").toBe(false);
  expect(String(card.error)).toContain("no active harness on this engine answers plan usage");
  expect(String(card.html ?? ""),
    "the card drew usage bars, so this engine reached an upstream that answered with numbers")
    .not.toContain(String.raw`class="uc-track"`);
}, 60_000);

/* THE LOCAL UNIX SOCKET, END TO END (item 1). A booted engine listens on its
 * own <CYC_DATA_DIR>/engine-<port>.sock beside its loopback TCP port. This was
 * e2e/socket.test.ts, a whole 8th engine-booting file that tripped gates.ts's
 * "at most seven files boot an engine": folded here (gate 6's real reason is the
 * subprocess/OOM cost of a file that boots, and this reuses one boot rather than
 * standing up a new booting file). It does NOT need the DataChannel preload --
 * the socket answers plain HTTP -- so it runs under a bare `bun test` too.
 *
 * Proves the socket the engine ACTUALLY binds:
 *   - it takes the port-scoped name: the harness runs on a free, non-
 *     default port, so the socket is engine-<port>.sock, which is what keeps two
 *     same-datadir engines from colliding on one path;
 *   - it is mode 0600, so only this uid can open it;
 *   - GET /health over it (Bun fetch {unix}) answers 200 {ok:true};
 *   - the doctor probe markers answer {ok:true,probe:true} and mint nothing. */
test("the local unix socket: engine-<port>.sock at 0600, with /health and the doctor probes riding it", async () => {
  engine = await startEngine();
  const e = engine;
  const sock = join(e.dir, "data", `engine-${e.port}.sock`);

  expect(modeOf(sock), "only this uid may open the socket").toBe(0o600);

  const over = (path: string, init?: RequestInit) =>
    fetch(`http://localhost${path}`, { ...init, unix: sock } as RequestInit & { unix: string });

  const health = await over("/health");
  expect(health.status).toBe(200);
  expect((await health.json()).ok).toBe(true);

  const probe = (path: string) =>
    over(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ probe: true }),
    }).then((r) => r.json());
  expect(await probe("/harness/announce")).toEqual({ ok: true, probe: true });
  expect(await probe("/agent/reply")).toEqual({ ok: true, probe: true });
}, 60_000);

/* A SECOND ENGINE ON A LIVE SOCKET REFUSES, RATHER THAN HIJACKING IT.
 *
 * The old code unlinked the socket path UNCONDITIONALLY before bind, so a second
 * same-datadir engine stole a live one's path (the first kept its open listen
 * fd; new local callers reached the second). Now the boot probes the path: a
 * live listener answers, so it exits fatally naming the path instead of
 * unlinking it. Here a squatter (a plain Bun.serve on a socket) stands in for
 * the first engine, pointed at via CYC_ENGINE_SOCK; startEngine's boot must see
 * the child exit non-zero. (The stale-socket case -- unlink-then-rebind -- is
 * exercised by every harness reboot(), which SIGKILLs and boots again on the
 * same datadir with its stale socket still on disk.) */
test("a second engine refuses to boot over a LIVE socket instead of stealing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-livesock-"));
  const sock = join(dir, "engine.sock");
  const squatter = Bun.serve({ unix: sock, fetch: () => new Response("busy") });
  try {
    await expect(startEngine({ env: { CYC_ENGINE_SOCK: sock } }),
      "a live socket must make the second engine refuse, not hijack")
      .rejects.toThrow(/already listening/);
  } finally {
    squatter.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

/* THE GUARDRAILS ARE WIRED IN, NOT MERELY PRESENT.
 *
 * test-utils/guardrails.test.ts proves the three whyNot* functions decide
 * correctly. That is a different sentence from "startEngine actually asks
 * them", and only the second one protects anything: the functions could be
 * perfect and unreferenced, and a harness engine would go back to polling the
 * live usage endpoint with his real OAuth token, which is what one run already
 * did before this check existed.
 *
 * These belong beside a boot because the subject IS the boot path, but none of
 * them boots: startEngine refuses BEFORE it spawns anything, so all three
 * together cost milliseconds. They were deleted from limits.test.ts when that
 * file stopped booting engines, and this is the home they were owed. */

test("startEngine refuses an upstream that is not on this machine", async () => {
  /* `...env` wins over the harness defaults, which is deliberate: a spec about
   * the limits path needs its own upstream. It has to be a LOCAL one, and this
   * is the only thing standing between a careless override and his token.
   *
   * THE HOST HERE IS NOT api.anthropic.com, AND THAT IS THE POINT OF THIS
   * COMMENT. test-utils/guardrails.test.ts names the real one, because it calls
   * a function and spawns nothing. This one is a startEngine call, so under the
   * mutation that turns the guard off (e2e/mutation/limits-run.sh, M and O) it
   * would really start an engine against whatever is written here -- and a
   * mutation run that sends requests to Anthropic is the exact defect the
   * guardrails exist to have fixed, committed by the test that proves it fixed.
   *
   * `.invalid` is reserved and never resolves (RFC 2606), so the mutated version
   * fails at DNS and nothing leaves the machine. It is still not this machine,
   * which is all the guard is being asked about. */
  await expect(startEngine({ env: { CYC_LIMITS_API: "http://usage.invalid:1" } }))
    .rejects.toThrow(/usage\.invalid/);
  // and the default being deleted rather than overridden fails the same way
  await expect(startEngine({ env: { CYC_LIMITS_API: "" } }))
    .rejects.toThrow(/refusing to start an engine/);
});

test("startEngine refuses an engine that would read his keychain", async () => {
  await expect(startEngine({ env: { CYC_LIMITS_CREDENTIALS: `${process.env.HOME}/.claude/.credentials.json` } }))
    .rejects.toThrow(/not inside this engine's own/);
});

test("startEngine refuses to supervise anything of his", async () => {
  /* The reserved list is this fleet's real port map. A spec cannot reach one by
   * accident or by copy-paste, and a test run has no business taking his speech
   * away, exactly as a test run had no business being his mute button for an
   * afternoon. */
  await expect(startEngine({
    seed: async (dir) => {
      await writeFile(join(dir, "services.json"),
        JSON.stringify([{ name: "kokoro", port: 10104 }]));
    },
  })).rejects.toThrow(/10104/);

  // and the shared directory both his real engines look in
  await expect(startEngine({ env: { CYC_SERVICES_LEASE_DIR: "/Users/Shared/callyourcode" } }))
    .rejects.toThrow(/which of them supervises this Mac/);
});

/* THE TRANSPORT IS REALLY THERE, and it is worth one cheap assertion because
 * everything above is written as if it is. If werift failed to load,
 * `RTC.available` would be false and every
 * DataChannel test in this file would fail somewhere deep and confusing
 * instead of here, in one line, saying which library did not load.
 *
 * The last surviving fact from rtc.test.ts, which is deleted: its loopback and
 * multi-fragment halves are the sealed round trip above, and its fragmentation
 * arithmetic is dcpipe.test.ts's frozen vectors. */
test("the real WebRTC library loaded, so the claims above are about a real transport", async () => {
  await loadRtc();
  expect(RTC.available, "werift did not load, so nothing here proved a transport")
    .toBe(true);
  expect(RTC.lib).toBe("werift");
});
