/* resolveEngine / parseEngineUrl / engineFetch / defaultSockPath
 * (engine/shared/engine-url.ts): the canonical CYC_ENGINE_URL resolution.
 *
 * The socket-exists default is proved with a REAL temp socket (a Bun.serve on a
 * unix path), because that branch is exactly the "prefer the socket if it is
 * there" behaviour and a mock would not exercise existsSync.
 *
 *   bun test scripts/engine-url.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveEngine, parseEngineUrl, engineLabel, engineFetch, defaultSockPath,
} from "../engine/shared/engine-url.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

test("parseEngineUrl: http origin, trailing slash and path stripped to origin", () => {
  expect(parseEngineUrl("http://host:1234/", {})).toEqual({ kind: "tcp", origin: "http://host:1234" });
  expect(parseEngineUrl("http://127.0.0.1:10101", {})).toEqual({ kind: "tcp", origin: "http://127.0.0.1:10101" });
  expect(parseEngineUrl("https://front.example.com:8443/x", {})).toEqual({
    kind: "tcp", origin: "https://front.example.com:8443",
  });
});

test("parseEngineUrl: unix form, with ~ expansion against the passed HOME", () => {
  expect(parseEngineUrl("unix:/abs/engine.sock", {})).toEqual({ kind: "unix", path: "/abs/engine.sock" });
  expect(parseEngineUrl("unix:~/x.sock", { HOME: "/home/t" })).toEqual({ kind: "unix", path: "/home/t/x.sock" });
});

test("parseEngineUrl: an unsupported scheme throws (a typo fails loud)", () => {
  expect(() => parseEngineUrl("ws://127.0.0.1:10101/ws", {})).toThrow();
  expect(() => parseEngineUrl("garbage", {})).toThrow();
});

test("defaultSockPath: CYC_ENGINE_SOCK wins, else <dataDir>/engine.sock for the DEFAULT engine, ~ expanded", () => {
  expect(defaultSockPath({ HOME: "/home/t" })).toBe("/home/t/.callyourcode/engine.sock");
  expect(defaultSockPath({ HOME: "/home/t", CYC_DATA_DIR: "/data/" })).toBe("/data/engine.sock");
  expect(defaultSockPath({ HOME: "/home/t", CYC_ENGINE_SOCK: "~/s.sock" })).toBe("/home/t/s.sock");
  expect(defaultSockPath({ CYC_ENGINE_SOCK: "/tmp/a.sock" })).toBe("/tmp/a.sock");
  // AGENT_PORT pinned to the default (10101) is still the default engine: bare name
  expect(defaultSockPath({ HOME: "/home/t", AGENT_PORT: "10101" })).toBe("/home/t/.callyourcode/engine.sock");
});

test("defaultSockPath: an offset-port instance gets its OWN engine-<port>.sock (D2, no collision)", () => {
  // CYC_PORT_BASE moves AGENT_PORT to B+1 and the socket NAME with it, so two
  // same-datadir engines cannot land on one path and hijack each other.
  expect(defaultSockPath({ HOME: "/home/t", CYC_PORT_BASE: "20200" }))
    .toBe("/home/t/.callyourcode/engine-20201.sock");
  // an explicit AGENT_PORT does the same
  expect(defaultSockPath({ HOME: "/home/t", AGENT_PORT: "9999" }))
    .toBe("/home/t/.callyourcode/engine-9999.sock");
  // and CYC_ENGINE_SOCK still overrides the derived name outright
  expect(defaultSockPath({ HOME: "/home/t", CYC_PORT_BASE: "20200", CYC_ENGINE_SOCK: "/tmp/x.sock" }))
    .toBe("/tmp/x.sock");
});

test("resolveEngine: explicit CYC_ENGINE_URL wins (unix or tcp)", () => {
  expect(resolveEngine({ CYC_ENGINE_URL: "unix:/x.sock" })).toEqual({ kind: "unix", path: "/x.sock" });
  expect(resolveEngine({ CYC_ENGINE_URL: "http://h:2" })).toEqual({ kind: "tcp", origin: "http://h:2" });
});

test("resolveEngine: unset + NO socket falls back to the TCP loopback port (CYC_PORT_BASE moves it)", () => {
  // a HOME with no ~/.callyourcode/engine.sock: the socket branch misses
  const home = mkdtempSync(join(tmpdir(), "cyc-eu-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  expect(resolveEngine({ HOME: home })).toEqual({ kind: "tcp", origin: "http://127.0.0.1:10101" });
  expect(resolveEngine({ HOME: home, CYC_PORT_BASE: "20200" })).toEqual({
    kind: "tcp", origin: "http://127.0.0.1:20201",
  });
});

test("resolveEngine: unset + an existing socket is PREFERRED over TCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-eu-"));
  const sock = join(dir, "engine.sock");
  const srv = Bun.serve({ unix: sock, fetch: () => new Response("ok") });
  cleanups.push(() => { srv.stop(true); rmSync(dir, { recursive: true, force: true }); });
  // point the default sock path at the live socket via CYC_ENGINE_SOCK
  expect(resolveEngine({ CYC_ENGINE_SOCK: sock })).toEqual({ kind: "unix", path: sock });
});

test("engineLabel: origin for tcp, unix:<path> for the socket", () => {
  expect(engineLabel({ kind: "tcp", origin: "http://h:1" })).toBe("http://h:1");
  expect(engineLabel({ kind: "unix", path: "/x.sock" })).toBe("unix:/x.sock");
});

test("engineFetch: reaches a real engine over BOTH transports", async () => {
  // tcp
  const tcp = Bun.serve({ port: 0, fetch: (r) => Response.json({ where: "tcp", path: new URL(r.url).pathname }) });
  cleanups.push(() => tcp.stop(true));
  const tcpRes = await engineFetch({ kind: "tcp", origin: `http://127.0.0.1:${tcp.port}` }, "/health");
  expect(await tcpRes.json()).toEqual({ where: "tcp", path: "/health" });

  // unix
  const dir = mkdtempSync(join(tmpdir(), "cyc-eu-"));
  const sock = join(dir, "e.sock");
  const unix = Bun.serve({ unix: sock, fetch: (r) => Response.json({ where: "unix", path: new URL(r.url).pathname }) });
  cleanups.push(() => { unix.stop(true); rmSync(dir, { recursive: true, force: true }); });
  const unixRes = await engineFetch({ kind: "unix", path: sock }, "/health");
  expect(await unixRes.json()).toEqual({ where: "unix", path: "/health" });
});
