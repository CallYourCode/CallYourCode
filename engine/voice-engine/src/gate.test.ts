/* The request gate's policy, proven as pure functions (gate.ts), plus the
 * static CORS tripwire.
 *
 *   bun test src/gate.test.ts
 *
 * The wire-level proof (real server, real sockets, the /stt-stream upgrade)
 * lives in server-gate.test.ts; this file pins the predicate itself, including
 * the one case a loopback-bound server can never receive over a real socket:
 * a non-loopback TCP peer. */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isLoopbackHost, isLoopbackPeer, isSelfOrigin, outsiderReason } from "./gate";

const PORT = 8455; // an arbitrary port for predicate calls; nothing binds it
const HOST = `127.0.0.1:${PORT}`; // the Host every real caller's dial stamps

// ------------------------------------------------------------ loopback peer

test("loopback peers, all three shapes bun reports", () => {
  expect(isLoopbackPeer("127.0.0.1")).toBe(true);
  expect(isLoopbackPeer("::1")).toBe(true);
  expect(isLoopbackPeer("::ffff:127.0.0.1")).toBe(true);
});

test("non-loopback and missing peers are not loopback (fails closed)", () => {
  expect(isLoopbackPeer("100.64.0.7")).toBe(false); // a tailnet peer
  expect(isLoopbackPeer("192.168.1.20")).toBe(false);
  expect(isLoopbackPeer("10.0.0.1")).toBe(false);
  expect(isLoopbackPeer(null)).toBe(false);
  expect(isLoopbackPeer(undefined)).toBe(false);
  expect(isLoopbackPeer("")).toBe(false);
});

// -------------------------------------------------------------- self origin

test("the engine's own origin is the ONLY allowed origin", () => {
  expect(isSelfOrigin(`http://127.0.0.1:${PORT}`, PORT)).toBe(true);
  expect(isSelfOrigin(`http://localhost:${PORT}`, PORT)).toBe(true);
  expect(isSelfOrigin(`http://[::1]:${PORT}`, PORT)).toBe(true);
  expect(isSelfOrigin(`HTTP://LOCALHOST:${PORT}`, PORT)).toBe(true); // URL lowercases
});

test("any other origin is refused: other ports, schemes, hosts, junk", () => {
  // Another loopback port is NOT this engine: the agent engine's own pages
  // (:10101) and the app server (:10100) must ride voice-proxy, never fetch here.
  expect(isSelfOrigin(`http://127.0.0.1:${PORT + 1}`, PORT)).toBe(false);
  expect(isSelfOrigin("http://127.0.0.1:10101", PORT)).toBe(false);
  expect(isSelfOrigin(`https://127.0.0.1:${PORT}`, PORT)).toBe(false); // engine never serves https
  expect(isSelfOrigin(`http://evil.example:${PORT}`, PORT)).toBe(false);
  expect(isSelfOrigin("https://drive-by.example", PORT)).toBe(false);
  expect(isSelfOrigin(`http://machine.tail1234.ts.net:${PORT}`, PORT)).toBe(false);
  expect(isSelfOrigin("null", PORT)).toBe(false); // sandboxed iframe
  expect(isSelfOrigin("", PORT)).toBe(false);
  expect(isSelfOrigin("about:blank", PORT)).toBe(false);
  expect(isSelfOrigin(`file:///tmp/x.html`, PORT)).toBe(false);
});

test("a portless http origin means port 80, nothing else", () => {
  expect(isSelfOrigin("http://localhost", 80)).toBe(true);
  expect(isSelfOrigin("http://localhost", PORT)).toBe(false);
});

// ------------------------------------------------------------ loopback host

test("loopback Hosts pass: the three names, any port, port optional", () => {
  expect(isLoopbackHost(HOST)).toBe(true);
  expect(isLoopbackHost("127.0.0.1:10102")).toBe(true); // the agent engine's dial
  expect(isLoopbackHost(`localhost:${PORT}`)).toBe(true);
  expect(isLoopbackHost(`[::1]:${PORT}`)).toBe(true);
  expect(isLoopbackHost("localhost")).toBe(true);
  expect(isLoopbackHost("127.0.0.1")).toBe(true);
  expect(isLoopbackHost(`LOCALHOST:${PORT}`)).toBe(true); // URL lowercases
});

test("any non-loopback Host is refused: the DNS-rebinding shapes", () => {
  expect(isLoopbackHost("evil.com")).toBe(false); // the rebound page's Host
  expect(isLoopbackHost("evil.com:10102")).toBe(false); // even naming this port
  expect(isLoopbackHost(`machine.tail1234.ts.net:${PORT}`)).toBe(false); // no tailnet name: not a caller of THIS engine
  expect(isLoopbackHost("192.168.1.20:10102")).toBe(false);
  expect(isLoopbackHost("localhost.evil.com")).toBe(false);
});

test("an absent, empty, or games-playing Host fails closed", () => {
  expect(isLoopbackHost(null)).toBe(false); // every real caller sends Host
  expect(isLoopbackHost("")).toBe(false);
  expect(isLoopbackHost("   ")).toBe(false);
  expect(isLoopbackHost("127.0.0.1@evil.com")).toBe(false); // parser games
  expect(isLoopbackHost("127.0.0.1/evil")).toBe(false);
  expect(isLoopbackHost("127.0.0.1 evil.com")).toBe(false);
  expect(isLoopbackHost("http://127.0.0.1:10102")).toBe(false); // a URL is not a Host
});

// ---------------------------------------------------------- the whole policy

test("a loopback peer+Host with no Origin and no x-forwarded-for passes", () => {
  expect(outsiderReason("127.0.0.1", null, HOST, null, PORT)).toBeNull();
  expect(outsiderReason("::1", null, `[::1]:${PORT}`, null, PORT)).toBeNull();
  expect(outsiderReason("::ffff:127.0.0.1", null, HOST, null, PORT)).toBeNull();
});

test("the engine's own test bench passes: loopback peer+Host, self origin", () => {
  expect(outsiderReason("127.0.0.1", null, HOST, `http://127.0.0.1:${PORT}`, PORT)).toBeNull();
  expect(outsiderReason("127.0.0.1", null, `localhost:${PORT}`, `http://localhost:${PORT}`, PORT)).toBeNull();
});

test("a non-loopback peer is refused whatever else it presents", () => {
  expect(outsiderReason("100.64.0.7", null, HOST, null, PORT)).toBe("non-loopback peer");
  expect(outsiderReason(null, null, HOST, null, PORT)).toBe("non-loopback peer"); // fails closed
  // ...and peer wins over the other checks: refused as a peer, not as a browser
  expect(outsiderReason("100.64.0.7", null, HOST, `http://127.0.0.1:${PORT}`, PORT)).toBe("non-loopback peer");
});

test("x-forwarded-for marks a proxied peer: refused, never read as a credential", () => {
  expect(outsiderReason("127.0.0.1", "100.64.0.7", HOST, null, PORT))
    .toBe("forwarded request (x-forwarded-for)");
  // even a header CLAIMING loopback: presence means forwarded, content is noise
  expect(outsiderReason("127.0.0.1", "127.0.0.1", HOST, null, PORT))
    .toBe("forwarded request (x-forwarded-for)");
  expect(outsiderReason("127.0.0.1", "", HOST, null, PORT))
    .toBe("forwarded request (x-forwarded-for)"); // empty header is still present
});

test("the rebound page's exact shape is refused on its Host alone", () => {
  // loopback peer, no x-forwarded-for, NO Origin (top-level GET): only Host
  // names the attack, and it does.
  expect(outsiderReason("127.0.0.1", null, "evil.com", null, PORT))
    .toBe("non-loopback Host header (DNS-rebinding shapes are refused)");
  expect(outsiderReason("127.0.0.1", null, "evil.com:10102", null, PORT))
    .toBe("non-loopback Host header (DNS-rebinding shapes are refused)");
  expect(outsiderReason("127.0.0.1", null, null, null, PORT))
    .toBe("non-loopback Host header (DNS-rebinding shapes are refused)"); // absent: fails closed
});

test("any Origin that is not this engine's own is refused", () => {
  expect(outsiderReason("127.0.0.1", null, HOST, "https://evil.example", PORT))
    .toBe("cross-origin browser call");
  expect(outsiderReason("127.0.0.1", null, HOST, "http://127.0.0.1:10101", PORT))
    .toBe("cross-origin browser call");
  expect(outsiderReason("127.0.0.1", null, HOST, "null", PORT))
    .toBe("cross-origin browser call");
});

/* ------------------------------------------------------- the CORS tripwire
 *
 * The fix DELETED the wildcard CORS grant (server.ts used to spread it into
 * every response and serve an OPTIONS preflight for it). This scan keeps it
 * deleted mechanically, the same shape as the agent engine lane's static route-gate scan:
 * no source file under src/ may name the grant header at all. The needle is
 * concatenated so this test file never matches itself. */

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("T-static: no source file grants CORS (the grant headers are gone for good)", () => {
  const needle = "access-control-" + "allow"; // covers -origin, -methods, -headers
  const srcDir = new URL("./", import.meta.url).pathname;
  const offenders = tsFilesUnder(srcDir)
    .filter((p) => readFileSync(p, "utf8").toLowerCase().includes(needle));
  expect(offenders).toEqual([]);
});
