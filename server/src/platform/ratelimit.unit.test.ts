/* ratelimit.ts as a unit: pure window math with an injected clock, so nothing
 * here sleeps. Fresh per-module spec for the layered split; the live-process
 * proof of the same caps stays in distrust.test.ts. */

import { test, expect } from "bun:test";
import { grantRate, clientKeyOf, isLoopbackAddr, type RateBucket } from "./ratelimit";
import { PUSH_RATE_WINDOW_MS } from "./caps";

const silent = () => {};

test("grantRate charges up to the cap and no further", () => {
  const map = new Map<string, RateBucket>();
  const t0 = 1_000_000;
  expect(grantRate(map, "k", 60, 100, "ev", silent, t0)).toBe(60);
  expect(grantRate(map, "k", 60, 100, "ev", silent, t0 + 10)).toBe(40);
  expect(grantRate(map, "k", 5, 100, "ev", silent, t0 + 20)).toBe(0);
});

test("the window rolls: a full bucket refills after PUSH_RATE_WINDOW_MS", () => {
  const map = new Map<string, RateBucket>();
  const t0 = 5_000;
  expect(grantRate(map, "k", 100, 100, "ev", silent, t0)).toBe(100);
  expect(grantRate(map, "k", 1, 100, "ev", silent, t0 + PUSH_RATE_WINDOW_MS - 1)).toBe(0);
  expect(grantRate(map, "k", 1, 100, "ev", silent, t0 + PUSH_RATE_WINDOW_MS)).toBe(1);
});

test("the drop is logged ONCE per window, with the event name", () => {
  const map = new Map<string, RateBucket>();
  const events: string[] = [];
  const log = (event: string) => { events.push(event); };
  const t0 = 0;
  grantRate(map, "k", 100, 100, "push.rate.limited", log, t0);   // fills, no log
  grantRate(map, "k", 1, 100, "push.rate.limited", log, t0 + 1); // first refusal logs
  grantRate(map, "k", 1, 100, "push.rate.limited", log, t0 + 2); // silent
  grantRate(map, "k", 1, 100, "push.rate.limited", log, t0 + 3); // silent
  expect(events).toEqual(["push.rate.limited"]);
  // a new window logs again on its first refusal
  grantRate(map, "k", 100, 100, "push.rate.limited", log, t0 + PUSH_RATE_WINDOW_MS);
  grantRate(map, "k", 1, 100, "push.rate.limited", log, t0 + PUSH_RATE_WINDOW_MS + 1);
  expect(events).toEqual(["push.rate.limited", "push.rate.limited"]);
});

test("distinct keys hold distinct budgets", () => {
  const map = new Map<string, RateBucket>();
  expect(grantRate(map, "a", 100, 100, "ev", silent, 0)).toBe(100);
  expect(grantRate(map, "b", 100, 100, "ev", silent, 0)).toBe(100);
});

test("isLoopbackAddr: v4, v6 and mapped forms; nothing else", () => {
  expect(isLoopbackAddr("127.0.0.1")).toBe(true);
  expect(isLoopbackAddr("127.9.9.9")).toBe(true);
  expect(isLoopbackAddr("::1")).toBe(true);
  expect(isLoopbackAddr("::ffff:127.0.0.1")).toBe(true);
  expect(isLoopbackAddr("10.0.0.1")).toBe(false);
  expect(isLoopbackAddr(null)).toBe(false);
});

/* x-forwarded-for is only believed when the TCP peer is this host's own
 * loopback proxy; a remote caller cannot forge its way into a fresh bucket. */
test("clientKeyOf trusts x-forwarded-for from loopback only", () => {
  const req = (xff?: string) =>
    new Request("http://x/clientlog", xff ? { headers: { "x-forwarded-for": xff } } : {});
  const from = (address: string) => ({ requestIP: () => ({ address }) });
  expect(clientKeyOf(req("1.2.3.4"), from("127.0.0.1"))).toBe("xff:1.2.3.4");
  expect(clientKeyOf(req("1.2.3.4, 5.6.7.8"), from("::1"))).toBe("xff:1.2.3.4");
  expect(clientKeyOf(req("1.2.3.4"), from("100.64.0.9"))).toBe("100.64.0.9");
  expect(clientKeyOf(req(), from("127.0.0.1"))).toBe("127.0.0.1");
  expect(clientKeyOf(req(), { requestIP: () => null })).toBe("?");
});
