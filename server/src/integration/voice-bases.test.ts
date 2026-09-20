/* THE ENGINE-RELATIVE VOICE BASE ON /config (voice-through-engine).
 *
 * The app is being moved off "talk to the voice engine directly". /config keeps
 * its existing `voice`/`voiceLabel` fields for the current app, and now also
 * emits `voiceBases`: one entry per `engines` entry, in the same order, each
 * being that engine's own origin over http(s) plus /voice. The app swaps its
 * voice base to the entry matching the engine it already talks to, and reaches
 * /voice/stt, /voice/stt-stream, /voice/tts and /voice/voices there.
 *
 * The server boots on a scratch port; two engines announce loopback ws/wss urls
 * that nothing listens on, so no real engine or voice engine is ever touched.
 * Discovery is announce-only: the engines list comes from those announces.
 *
 *   bun test app-server/voice-bases.test.ts
 */

import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrolledBearer, fakeEngine } from "../test-support/enrollkit";

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

test("/config emits voiceBases, each engine's own origin + /voice, aligned with engines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-voicebases-"));
  const port = await freePort();
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../bootstrap/server.ts")], {
    env: {
      ...process.env,
      APP_PORT: String(port),
      APP_HOST: "127.0.0.1",
      DIST_DIR: dir,
      PUSH_FILE: join(dir, "push-subs.json"),
      SETTINGS_FILE: join(dir, "app-settings.json"),
      ENGINE_LEASES_FILE: join(dir, "leases.json"),
      ENGINE_TOKENS_FILE: join(dir, "engine-tokens.json"),
      CYC_LOG_DIR: join(dir, "logs"),
      VOICE_ENGINES: "http://127.0.0.1:1|http://127.0.0.1:1|none",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const said = async () => {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ]);
    return `${out}${err}`.trim() || "(it printed nothing at all)";
  };
  const stop = async () => { proc.kill(); await proc.exited; };

  await writeFile(join(dir, "index.html"), "<!doctype html>");

  const url = `http://127.0.0.1:${port}`;
  let ok = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`app server exited ${proc.exitCode}: ${await said()}`);
    }
    ok = await fetch(`${url}/health`).then((r) => r.ok).catch(() => false);
    if (ok) break;
    await Bun.sleep(100);
  }
  if (!ok) throw new Error(`app server never answered /health: ${await said()}`);

  try {
    // two engines announce (announce-only discovery), one ws and one wss, in
    // order; each enrolls first for its per-engine token
    const post = (u: string, body: unknown, headers: Record<string, string>) =>
      fetch(u, { method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body) });
    const a = await enrolledBearer(url, await fakeEngine("e-ws"));
    await post(`${url}/engines/announce`,
      { engineId: "e-ws", host: "h1", user: "u", url: "ws://127.0.0.1:1/ws", rev: "r", ts: Date.now() },
      a.bearer);
    await Bun.sleep(5); // keep the lastSeen order deterministic
    const b = await enrolledBearer(url, await fakeEngine("e-wss"));
    await post(`${url}/engines/announce`,
      { engineId: "e-wss", host: "h2", user: "u", url: "wss://127.0.0.1:1/ws", rev: "r", ts: Date.now() },
      b.bearer);

    const res = await fetch(`${url}/config`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.engines.map((e: any) => e.url)).toEqual(["ws://127.0.0.1:1/ws", "wss://127.0.0.1:1/ws"]);
    // same order, own origin over http(s), path /voice
    expect(j.voiceBases).toEqual(["http://127.0.0.1:1/voice", "https://127.0.0.1:1/voice"]);
    // the existing fields stay for the current app
    expect("voice" in j).toBe(true);
    expect("voiceLabel" in j).toBe(true);
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, 40_000);
