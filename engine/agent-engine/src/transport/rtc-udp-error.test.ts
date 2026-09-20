/* THE werift UDP SOCKET MUST NOT KILL THE PROCESS WHEN AN ICE CHECK IS REFUSED.
 *
 * werift's UdpTransport (common/src/transport.ts, and the same class in the
 * shipped lib/index.mjs bundle) does `dgram.createSocket` and attaches only a
 * "message" listener. An ICE connectivity check aimed at a closed port makes
 * the kernel return ICMP port unreachable; node raises that as a "recvmsg
 * ECONNREFUSED" "error" event on the socket, and an "error" event with no
 * listener is a throw that node re-raises as an uncaughtException. Live proof
 * is in ~/.callyourcode/logs/engine.log: eight lines of
 * `engine uncaughtException err="Error: recvmsg ECONNREFUSED"`. The engine
 * survived only because server.ts installs a diagnostic catch-all; a refused
 * check is a failed candidate pair, not a dead transport, and it should never
 * have reached that catch-all at all.
 *
 * THE FIX is a patch hunk (patches/werift@0.24.4.patch) that attaches an
 * "error" listener on the UdpTransport socket in both the .js and the .mjs
 * copies: it logs through werift's own debug logger and does nothing when the
 * transport is already closed. This file proves the listener is there and does
 * its job, without booting an engine or opening a DataChannel.
 *
 * HOW THE ERROR IS MADE DETERMINISTIC. Sending to a closed port from an
 * unconnected UDP socket does not reliably surface the ICMP error on Linux (the
 * async error is only guaranteed to reach userspace on a CONNECTED socket), and
 * production hit it precisely because ICE hammers one destination. So the test
 * connects the transport's own socket to a port it just closed and sends: that
 * is the exact "recvmsg ECONNREFUSED" event the patch exists to catch, raised
 * on the real werift socket.
 *
 * WHY THE TEST DOES NOT ADD ITS OWN "error" LISTENER. An EventEmitter throws on
 * "error" only when it has NO listener; the moment the test attaches one of its
 * own to witness the event, the process stops crashing whether werift's
 * listener is there or not, and the test proves nothing. So it takes werift's
 * own listener (asserting exactly one is present, which is the patch) and wraps
 * it: the wrapper counts the event and delegates, so there is still exactly one
 * listener and the crash behaviour is untouched. On an unpatched werift there
 * is no listener to wrap, the count assertion fails first, and nothing masks
 * the crash it is looking for.
 *
 *   bun test agent-engine/src/transport/rtc-udp-error.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { createSocket } from "node:dgram";
import { until } from "../test-utils/wait.ts";

const LOOPBACK = "127.0.0.1";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch { /* already gone */ }
  }
});

/** A loopback UDP port with nothing listening on it: bind one, read the number,
 *  give it back. A datagram to it draws an ICMP port-unreachable rather than an
 *  assumption that some low port happens to be free. */
async function aClosedPort(): Promise<number> {
  const probe = createSocket("udp4");
  await new Promise<void>((r) => probe.bind(0, LOOPBACK, r));
  const port = probe.address().port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

test("a refused ICE check on a werift UDP socket does not become an uncaughtException", async () => {
  const werift: any = await import("werift");
  const closedPort = await aClosedPort();

  /* The whole point: count process-level crashes for the duration of this test
   * and take the counter back down at the end, exactly as the brief asks. */
  let uncaught = 0;
  const onUncaught = () => { uncaught++; };
  process.on("uncaughtException", onUncaught);
  cleanups.push(() => { process.off("uncaughtException", onUncaught); });

  const transport = await werift.UdpTransport.init("udp4", {});
  cleanups.push(() => transport.close());

  /* The patch attaches werift's own "error" listener in the constructor, and
   * nothing else has touched this socket, so exactly one must be present. This
   * is the direct proof the patch is in force; on an unpatched werift it is
   * zero and the test stops here rather than sending anything. */
  const attached = transport.socket.listeners("error");
  expect(attached.length, "werift's UdpTransport did not attach an error listener; the patch is " +
    "missing, so a refused ICE check will crash the engine").toBe(1);

  /* Wrap that single listener rather than adding a second one, so the socket
   * still has exactly one handler and its crash behaviour is unchanged, while
   * the test can still witness that the ECONNREFUSED event genuinely fired. */
  let socketErrors = 0;
  let lastError = "";
  const original = attached[0] as (err: Error) => void;
  transport.socket.off("error", original);
  transport.socket.on("error", (err: Error) => { socketErrors++; lastError = String(err); original(err); });
  transport.socket.on("message", () => { /* drain, as werift does */ });

  await new Promise<void>((r) => transport.socket.connect(closedPort, LOOPBACK, () => r()));

  /* Poll rather than sleep: each turn fires a fresh datagram at the dead port
   * and checks whether the ICMP error has come back on recvmsg yet. No wall-
   * clock wait, and it fails with a sentence if the error never lands. */
  await until(() => {
    for (let i = 0; i < 4; i++) {
      try { transport.socket.send(Buffer.from("x")); } catch { /* between errors */ }
    }
    return socketErrors > 0;
  }, { timeoutMs: 10_000, what: "the werift UDP socket to raise recvmsg ECONNREFUSED" });

  expect(socketErrors, "the socket never raised the error the patch is meant to catch")
    .toBeGreaterThan(0);
  expect(lastError, "the error that fired was not the refused-check one this is about")
    .toContain("ECONNREFUSED");
  expect(uncaught, `a refused ICE check crashed the process ${uncaught} time(s); the werift ` +
    "UDP error listener is missing or was removed").toBe(0);
});

test("the werift UDP error listener stays quiet once the transport is closed", async () => {
  /* The listener's second clause: after close() the socket is being torn down
   * and a late error is nothing to act on. Closing then emitting a synthetic
   * error on the socket must not throw or crash; the real path here is a
   * teardown race, and the guard is `if (this.closed) return`. */
  const werift: any = await import("werift");

  let uncaught = 0;
  const onUncaught = () => { uncaught++; };
  process.on("uncaughtException", onUncaught);
  cleanups.push(() => { process.off("uncaughtException", onUncaught); });

  const transport = await werift.UdpTransport.init("udp4", {});
  const socket = transport.socket;
  socket.on("message", () => {});
  await transport.close();
  expect(transport.closed, "close() did not mark the transport closed").toBe(true);

  /* A listener is present (werift's own), so this does not throw for lack of
   * one; the assertion is that the closed-guard path is exercised without
   * incident. */
  socket.emit("error", new Error("recvmsg ECONNREFUSED"));
  await until(() => true, { timeoutMs: 1_000, what: "the event loop to turn once" });
  expect(uncaught, "emitting an error after close crashed the process").toBe(0);
});
