/* The guardrails, on what they accept and what they refuse.
 *
 * These three functions are the only thing standing between a careless override
 * in a spec and his Anthropic token, his real engine's upstream, his kokoro on
 * :10104 and the supervision lease his two real engines argue over. They are
 * defaults that are CHECKED rather than merely set, because a default that is
 * only a default is a default somebody deletes; and they are unit tested here,
 * away from anything that boots, because a guard nobody tests is a guard that
 * quietly starts returning null.
 *
 * Moved out of limits.test.ts (which booted an engine to reach them) with the
 * assertions unchanged.
 */

import { test, expect } from "bun:test";
import { whyNotFakeCredentials, whyNotFakeServices, whyNotLocalUpstream } from "./guardrails.ts";

test("an upstream that is not on this machine is refused", () => {
  /* Every engine the boot harness starts is a real one signed in with his real
   * token, and a real one polls its plan limits on the way up. That is not a
   * hazard somebody might introduce: it is what every spec in this repo was
   * doing until it was measured, and one run wrote his real usage numbers into
   * /Users/Shared. */
  expect(whyNotLocalUpstream("http://127.0.0.1:1")).toBeNull();
  expect(whyNotLocalUpstream("http://localhost:8123")).toBeNull();
  expect(whyNotLocalUpstream("http://[::1]:8123")).toBeNull();

  // the real one, which is the whole point
  expect(whyNotLocalUpstream("https://api.anthropic.com")).toContain("api.anthropic.com");
  // and the shape a deleted default leaves behind
  expect(whyNotLocalUpstream(undefined)).toContain("real one");
  // a tailnet host is not this machine either, however trusted it feels
  expect(whyNotLocalUpstream("http://macbook-air.tail0a1b2c.ts.net:10101")).toContain("not this machine");
  expect(whyNotLocalUpstream("not a url")).toContain("not a URL");
});

test("an engine that would read his keychain is refused", () => {
  /* THE OTHER SENTENCE. A dead upstream stops anything reaching the wire; it
   * does not stop the engine pulling his OAuth token out of the login keychain
   * and building an Authorization header round it, which every harness engine
   * was doing. "Nothing leaked" is a fact about where requests went, not about
   * what the process was holding. */
  expect(whyNotFakeCredentials("/tmp/eng-1/credentials.json", "/tmp/eng-1")).toBeNull();
  expect(whyNotFakeCredentials(undefined, "/tmp/eng-1")).toContain("keychain");
  expect(whyNotFakeCredentials(`${process.env.HOME}/.claude/.credentials.json`, "/tmp/eng-1"))
    .toContain("not inside this engine's own");
});

test("a services table of his own, or a lease his real engines share, is refused", () => {
  const dir = "/tmp/eng-1";
  const lease = "/tmp/eng-1/lease";
  const table = `${dir}/services.json`;

  // the shape the harness itself writes: its own table, its own lease dir
  expect(whyNotFakeServices(table, dir, "[]", lease)).toBeNull();
  // and a service of its own on a port nobody uses
  expect(whyNotFakeServices(table, dir, JSON.stringify([{ name: "toy", port: 0 }]), lease)).toBeNull();

  // no lease dir at all: a test engine could take the one his real engines use
  expect(whyNotFakeServices(table, dir, "[]", undefined)).toContain("CYC_SERVICES_LEASE_DIR");
  // the shared directory both his real engines look in
  expect(whyNotFakeServices(table, dir, "[]", "/Users/Shared/callyourcode"))
    .toContain("which of them supervises this Mac");
  // no table: the engine would supervise the machine's real services
  expect(whyNotFakeServices(undefined, dir, "[]", lease)).toContain("real services");
  // a table outside the engine's own throwaway directory
  expect(whyNotFakeServices("/etc/services.json", dir, "[]", lease))
    .toContain("not inside this engine's own throwaway");

  // and every port of his real fleet, by name, so a copy-paste cannot reach one
  for (const [port, what] of [[10103, "whisper"], [10101, "agent engine"], [10102, "voice engine"],
                              [7790, "work agent engine"], [10100, "app server"], [10104, "kokoro"],
                              [10105, "streaming stt"]] as Array<[number, string]>) {
    const why = whyNotFakeServices(table, dir, JSON.stringify([{ name: "x", port }]), lease);
    expect(why).toContain(String(port));
    expect(why?.toLowerCase()).toContain(what.toLowerCase());
  }
});

test("a table that is not a list of services is refused loudly", () => {
  const dir = "/tmp/eng-1";
  expect(whyNotFakeServices(`${dir}/s.json`, dir, "{}", `${dir}/lease`)).toContain("not a list");
  expect(whyNotFakeServices(`${dir}/s.json`, dir, "not json", `${dir}/lease`)).toContain("not JSON");
});
