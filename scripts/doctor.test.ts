/* `cyc doctor` (scripts/doctor.ts): the pure config diffing and the round-trip.
 *
 * The diffing is plain string-in / lines-out. The round-trip runs runDoctor
 * against a FAKE engine on a real temp unix socket that answers the probe
 * markers and RECORDS any non-probe body, so "no side effects" is asserted
 * directly (the probes must never carry a real announce/reply).
 *
 *   bun test scripts/doctor.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  unitEnvFromCat, showEnvironment, diffLines, bunVersionNote, runDoctor,
  type DoctorIO,
} from "./doctor.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

// --------------------------------------------------------------------- pure

test("unitEnvFromCat pulls Environment= lines, tolerating the quoted form", () => {
  const cat = [
    "[Service]",
    "Environment=CYC_PORT_BASE=20200",
    'Environment="CYC_ENGINE_URL=unix:/x.sock"',
    "EnvironmentFile=/home/t/.callyourcode/turn.env",
    "ExecStart=bun run x.ts",
  ].join("\n");
  expect(unitEnvFromCat(cat)).toEqual({
    CYC_PORT_BASE: "20200",
    CYC_ENGINE_URL: "unix:/x.sock",
  });
});

test("showEnvironment parses KEY=VALUE lines", () => {
  expect(showEnvironment("AGENT_PORT=10101\nCYC_ENGINE_URL=unix:/x.sock\n")).toEqual({
    AGENT_PORT: "10101", CYC_ENGINE_URL: "unix:/x.sock",
  });
});

test("diffLines names a disagreement, is silent when sources agree or only one sets a key", () => {
  // agreement: no diff
  expect(diffLines([
    { name: "units", env: { CYC_ENGINE_URL: "unix:/x.sock" } },
    { name: "settings.json", env: { CYC_ENGINE_URL: "unix:/x.sock" } },
  ])).toEqual([]);
  // only one source sets it: not a diff
  expect(diffLines([
    { name: "units", env: { AGENT_PORT: "10101" } },
    { name: "settings.json", env: {} },
  ])).toEqual([]);
  // disagreement: named
  const d = diffLines([
    { name: "units", env: { CYC_ENGINE_URL: "unix:/x.sock" } },
    { name: "mcp.callyourcode", env: { CYC_ENGINE_URL: "http://127.0.0.1:10101" } },
  ]);
  expect(d).toHaveLength(1);
  expect(d[0]).toContain("DIFF CYC_ENGINE_URL");
  expect(d[0]).toContain("units=unix:/x.sock");
  expect(d[0]).toContain("mcp.callyourcode=http://127.0.0.1:10101");
});

test("bunVersionNote: null for the pinned 1.4.0, a WARN for the known-bad 1.4.2 and any other", () => {
  expect(bunVersionNote("1.4.0")).toBeNull();
  expect(bunVersionNote("1.4.2")).toContain("known-bad");
  expect(bunVersionNote("1.5.0")).toContain("not the pinned 1.4.0");
});

// ----------------------------------------------------------------- round-trip

type FakeEngine = { sock: string; nonProbe: Array<{ path: string; body: any }>; stop: () => void };

function fakeSocketEngine(opts: { health?: boolean } = {}): FakeEngine {
  const dir = mkdtempSync(join(tmpdir(), "cyc-doc-"));
  const sock = join(dir, "engine.sock");
  const nonProbe: Array<{ path: string; body: any }> = [];
  const srv = Bun.serve({
    unix: sock,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health") {
        return opts.health === false
          ? new Response("no", { status: 500 })
          : Response.json({ ok: true, rev: "test" });
      }
      if (req.method === "POST" && (path === "/harness/announce" || path === "/agent/reply")) {
        const body = await req.json().catch(() => ({}));
        // The engine's real behaviour: a probe answers ok+probe and changes
        // nothing; a real body would be recorded (a side effect the probe must
        // never cause).
        if (body?.probe === true) return Response.json({ ok: true, probe: true });
        nonProbe.push({ path, body });
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const stop = () => { srv.stop(true); rmSync(dir, { recursive: true, force: true }); };
  cleanups.push(stop);
  return { sock, nonProbe, stop };
}

function io(sock: string, over: Partial<DoctorIO> = {}): DoctorIO {
  return {
    run: async () => "", // systemctl absent: empty sources
    readFile: async () => null, // no config files
    bunVersion: "1.4.0",
    home: "/home/tester",
    ...over,
  };
}

test("round-trip: all three legs PASS against the socket engine, exit 0, and NO side effect", async () => {
  const fake = fakeSocketEngine();
  const env = { CYC_ENGINE_SOCK: fake.sock, CYC_ENGINE_URL: `unix:${fake.sock}` };
  const res = await runDoctor(env, io(fake.sock));
  expect(res.text).toContain("PASS socket /health");
  expect(res.text).toContain("PASS announce probe");
  expect(res.text).toContain("PASS reply probe");
  expect(res.code).toBe(0);
  // the probes minted nothing: the engine recorded no non-probe body
  expect(fake.nonProbe).toEqual([]);
});

test("round-trip: a dead engine FAILs the legs and exits 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-doc-"));
  const sock = join(dir, "engine.sock"); // nothing listening
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const res = await runDoctor({ CYC_ENGINE_SOCK: sock, CYC_ENGINE_URL: `unix:${sock}` }, io(sock));
  expect(res.text).toContain("FAIL socket /health");
  expect(res.code).toBe(1);
});

test("a CONFIG diff alone forces exit 1 even when the round-trip passes", async () => {
  const fake = fakeSocketEngine();
  const env = { CYC_ENGINE_SOCK: fake.sock, CYC_ENGINE_URL: `unix:${fake.sock}` };
  // units disagree with the mcp env on CYC_ENGINE_URL
  const res = await runDoctor(env, io(fake.sock, {
    run: async (_cmd, args) =>
      args.includes("cat") ? "Environment=CYC_ENGINE_URL=unix:/other.sock\n" : "",
    readFile: async (p) =>
      p.endsWith(".claude.json")
        ? JSON.stringify({ mcpServers: { callyourcode: { env: { CYC_ENGINE_URL: "http://127.0.0.1:10101" } } } })
        : null,
  }));
  expect(res.text).toContain("DIFF CYC_ENGINE_URL");
  expect(res.code).toBe(1);
});

test("the bun WARN surfaces in RESOLVED for the known-bad 1.4.2", async () => {
  const fake = fakeSocketEngine();
  const env = { CYC_ENGINE_SOCK: fake.sock, CYC_ENGINE_URL: `unix:${fake.sock}` };
  const res = await runDoctor(env, io(fake.sock, { bunVersion: "1.4.2" }));
  expect(res.text).toContain("known-bad");
});
