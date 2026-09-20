/* announce-session.py over the unix socket (item 2): the hook must POST to the
 * engine named by CYC_ENGINE_URL=unix:<path> using its stdlib UnixHTTPConnection.
 * A fake engine on a real temp socket records the announce; the test drives the
 * real python hook with a claude SessionStart payload on stdin and asserts the
 * body arrived.
 *
 *   bun test scripts/announce-hook.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", "engine", "hooks", "announce-session.py");
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function socketEngine() {
  const dir = mkdtempSync(join(tmpdir(), "cyc-hook-"));
  const sock = join(dir, "engine.sock");
  const got: any[] = [];
  const srv = Bun.serve({
    unix: sock,
    async fetch(req) {
      if (new URL(req.url).pathname === "/harness/announce" && req.method === "POST") {
        got.push(await req.json().catch(() => ({})));
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  cleanups.push(() => { srv.stop(true); rmSync(dir, { recursive: true, force: true }); });
  return { sock, got };
}

async function runHook(env: Record<string, string>, payload: unknown) {
  const proc = Bun.spawn(["python3", HOOK], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const code = await proc.exited;
  return { code };
}

test("CYC_ENGINE_URL=unix: the hook POSTs the announce over the socket", async () => {
  const eng = socketEngine();
  const { code } = await runHook(
    { CYC_ENGINE_URL: `unix:${eng.sock}` },
    { session_id: "sess-123", cwd: "/tmp", hook_event_name: "SessionStart", source: "startup" },
  );
  expect(code).toBe(0);
  // give the async recorder a beat if needed
  for (let i = 0; i < 20 && eng.got.length === 0; i++) await Bun.sleep(10);
  expect(eng.got).toHaveLength(1);
  expect(eng.got[0].sessionId).toBe("sess-123");
  expect(eng.got[0].cwd).toBe("/tmp");
});

test("a dead socket is exit 0 (the hook never breaks claude)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-hook-"));
  const sock = join(dir, "engine.sock"); // nothing listening
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const { code } = await runHook(
    { CYC_ENGINE_URL: `unix:${sock}` },
    { session_id: "sess-x", cwd: "/tmp", hook_event_name: "SessionStart" },
  );
  expect(code).toBe(0);
});
