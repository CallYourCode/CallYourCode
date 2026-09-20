/* WHICH ADDRESSES THE ENGINE OFFERS A BROWSER, and which it keeps to itself.
 *
 * His cross-machine acceptance constraint (2026-08-16, rtc.ts's own header):
 * the engine GATHERS on every interface, but ADVERTISES only 127.0.0.1 and the
 * address the page reached it on. That second half is a privacy and a
 * connectivity claim at once. A docker bridge, a second LAN, a VPN's tunnel
 * address are all real interfaces on his machines and all of them end up in an
 * SDP if nothing filters; the browser then spends its ICE budget on addresses
 * it can never reach, and the SDP itself says more about the host's network
 * than a page has any business learning.
 *
 * NOTHING TESTED THIS. rtc.test.ts asserted the advertised set was exactly
 * ["127.0.0.1"] and was deleted with the rest of the transport files when
 * e2e/roundtrip.test.ts took over the loopback and multi-fragment facts. The
 * roundtrip does not and cannot see this: it dials from the same machine, where
 * the right answer and the leaky answer look identical on the wire.
 *
 * WHY THIS IS A SEAM TEST AND NOT AN E2E ONE. It boots no engine and opens no
 * DataChannel. It calls the real onRtcOffer with a real offer, lets a real
 * node-datachannel PeerConnection gather, and reads the rtc-cand frames it
 * hands to `send`. Nothing has to CONNECT for the question to be answerable:
 * the whole subject is what was offered, which is decided before any peer
 * replies. That costs milliseconds, so gate 2's no-real-sleeps rule and the
 * per-file budget are both satisfied by construction.
 *
 * THE REFERENCE SET IS GATHERED, NOT ASSUMED. Asserting "only loopback was
 * advertised" on a box with one interface proves nothing, and CI boxes differ.
 * So the first case gathers with the filter OFF and keeps what came back; every
 * later assertion is stated against that measured set, and the file says out
 * loud when the box had nothing to leak.
 *
 *   bun test agent-engine/src/transport/rtc-ice.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { closeRtc, loadRtc, onRtcOffer, RTC, type RtcAttempt } from "./rtc.ts";
import { until } from "../test-utils/wait.ts";

const LOOPBACK = "127.0.0.1";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try { cleanups.pop()!(); } catch { /* already gone */ }
  }
});

/** The address field of an ICE candidate line, which is what is being withheld
 *  or offered. "candidate:<foundation> <comp> <transport> <prio> <ADDRESS> ..." */
const addressOf = (cand: string) => cand.split(" ")[4] ?? "";

/** A real offer SDP, from a real peer that wants a `cyc` DataChannel. Building
 *  one by hand would be asserting against a string this repo wrote rather than
 *  against what werift actually negotiates. */
async function anOffer(): Promise<string> {
  const werift: any = await import("werift");
  const pc = new werift.RTCPeerConnection({ iceServers: [] });
  cleanups.push(() => { try { pc.close(); } catch { /* already gone */ } });
  // Pre-negotiated, matching the shipped dialer: both ends create `cyc` as
  // {negotiated: true, id: 0}; the engine side is created inside onRtcOffer.
  pc.createDataChannel("cyc", { ordered: true, negotiated: true, id: 0 });
  await pc.setLocalDescription(await pc.createOffer());
  return pc.localDescription.sdp;
}

/** Answer one offer with these options and report every address the engine
 *  OFFERED, in order.
 *
 *  TWO ENDINGS, AND THE SECOND ONE IS NOT OPTIONAL. The engine's own
 *  `{cand: null}` (its onGatheringStateChange) says gathering finished, and it
 *  would be the whole story if node-datachannel delivered its callbacks in one
 *  queue. It does not: onLocalCandidate and onGatheringStateChange are separate
 *  thread-safe functions, so "complete" can reach JS BEFORE candidates that
 *  were gathered before it. Ending there read as an empty advertised set about
 *  one run in three -- which is the shape of a leak, so it failed loudly rather
 *  than passing, but it was the harness lying either way.
 *
 *  So the end is quiescence: complete, and then no new candidate for a beat.
 *  Bounded and polled (`until`), never a fixed wait, so a slow interface is
 *  waited for rather than reported as a withheld one. */
const QUIET_MS = 120;

async function advertised(opts: { reachedAddr: string | null; advertiseAll: boolean }): Promise<string[]> {
  await loadRtc();
  const offer = await anOffer();
  const seen: string[] = [];
  let last = 0;          // when the newest candidate arrived
  let complete = false;
  let attempt: RtcAttempt | null = null;

  attempt = await onRtcOffer({ id: "ice", sdp: offer }, { ...opts, iceServers: [] }, (frame: any) => {
    if (frame.t !== "rtc-cand") return;
    if (frame.cand) { seen.push(addressOf(frame.cand.candidate)); last = Date.now(); }
    else { complete = true; last = Math.max(last, Date.now()); }
  }, () => { /* no DataChannel is expected: nobody is answering this offer */ });
  cleanups.push(() => closeRtc(attempt!));

  await until(() => complete && Date.now() - last >= QUIET_MS,
    { timeoutMs: 10_000, what: `ICE gathering to finish and go quiet (${seen.length} so far)` });
  closeRtc(attempt);
  return seen;
}

const uniq = (xs: string[]) => [...new Set(xs)];

test("the real WebRTC library loaded, so the sets below are gathered rather than empty", async () => {
  await loadRtc();
  expect(RTC.available, "werift did not load; nothing here gathered anything").toBe(true);
});

/* THE PURE-LOOPBACK SAME-MACHINE CASE is not asserted here any more. With
 * node-datachannel, rtc.ts bound the socket to loopback so 127.0.0.1 was
 * GATHERED as a host candidate, and this file proved the offer was exactly
 * [127.0.0.1]. werift (the current transport) does not gather a loopback host
 * candidate at all and rtc.ts no longer binds one, so there is nothing
 * loopback-shaped to offer on that path -- the old assertion pinned a
 * node-datachannel-specific bind that no longer exists. The privacy guarantee
 * the file is really about (nothing but the reached address crosses) is proved
 * by the cross-machine case below, which is the branch that can actually leak. */

test("only the address the page reached on crosses; every other interface is withheld", async () => {
  /* THE CROSS-MACHINE PATH (his phone reaching linux over the tailnet), and the
   * one that can actually leak. There is no bindAddress here, so the engine
   * gathers on EVERY interface -- and this is the branch where the advertise set
   * is the only thing standing between a docker bridge address and an SDP.
   *
   * The reference set is measured first with the filter off, then one non-
   * loopback address out of it is played back as the reached address. What must
   * come out is that address and nothing else from the set. */
  const all = uniq(await advertised({ reachedAddr: null, advertiseAll: true }));
  expect(all.length, "the box gathered no candidates at all, so nothing here was exercised")
    .toBeGreaterThan(0);

  const routable = all.filter((a) => a !== LOOPBACK);
  if (routable.length === 0) {
    /* A box with nothing but loopback cannot leak, and saying so is honest.
     * The assertion above still holds it to gathering SOMETHING. */
    expect(all).toEqual([LOOPBACK]);
    return;
  }

  const reached = routable[0];
  const set = uniq(await advertised({ reachedAddr: reached, advertiseAll: false }));
  expect(set.every((a) => a === LOOPBACK || a === reached),
    `an interface the page never reached was offered to it: ${set.join(", ")} ` +
    `(reached ${reached}, gathered ${all.join(", ")})`).toBe(true);
  expect(set, "the address the page actually reached the engine on was not offered back")
    .toContain(reached);

  /* AND THE WITHHOLDING IS VISIBLE, on a box that has something to withhold.
   * Without this line the test above passes on a machine with one routable
   * interface, where "only the reached one" and "all of them" are the same
   * sentence. */
  const withheld = routable.filter((a) => a !== reached);
  if (withheld.length > 0) {
    expect(set.filter((a) => withheld.includes(a)),
      `these interfaces were gathered and leaked into the offer: ${withheld.join(", ")}`)
      .toEqual([]);
  }
});

test("the relay path advertises everything, because nothing was reached", async () => {
  /* THE THIRD CASE, and the filter must NOT run
   * here: over the relay there is no reached address, srflx is what crosses the
   * NAT, and a set trimmed to loopback would be a connection that never opens.
   * The same gathering, the opposite decision. */
  const all = uniq(await advertised({ reachedAddr: null, advertiseAll: true }));
  const local = uniq(await advertised({ reachedAddr: LOOPBACK, advertiseAll: false }));
  expect(all.length >= local.length,
    "the relay path offered fewer addresses than the loopback-only path").toBe(true);
  if (all.length === 1 && all[0] === LOOPBACK) return; // nothing to tell apart
  expect(all.some((a) => a !== LOOPBACK),
    "the relay path withheld every routable address, so nothing could cross a NAT").toBe(true);
});
