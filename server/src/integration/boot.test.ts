/* THE APP SERVER STARTS. That is the whole claim, and nothing made it before.
 *
 * WHY THIS FILE EXISTS. This process serves dist and holds the global
 * settings, so if it does not come up the app goes quiet on every device and the
 * first report is "it stopped working". Nothing checked it. The app repo's
 * offline suite deliberately pins a DEAD engine port and serves the bundle from
 * its own python static server, which is right and is also why a syntax error or
 * a boot-time throw in server.ts is invisible to all 154 of those tests: they
 * never ask this process for anything. The other app-server specs
 * (settings.test.ts, push.test.ts) do spawn it, but they spawn it to ask about
 * settings and push, so a boot failure reaches them as an eight second wait and
 * the words "app server did not start", with the reason discarded on a pipe
 * nobody read.
 *
 * WHAT IT CATCHES. Everything between `bun run server.ts` and the first answered
 * request: a file that does not parse, an import that does not resolve, a
 * missing dependency, any top-level `await` that rejects (Push.open, the
 * settings read, VAPID generation), a Bun.serve that will not bind, a crash in
 * the first request. The check is a real process on a scratch port, so it is the
 * boot, not a type-checker's opinion of it: `bun build --target=bun` and `tsc`
 * both pass a module that parses and then throws on line one.
 *
 * WHAT IT DOES NOT CATCH. Anything that needs the real deployment: the values in
 * .run/fleet.env and .run/vapid.env, a real voice engine, a real agent engine,
 * a real push service, the state in the real .run/*.json. Anything after boot:
 * anything on a timer is long after this test is finished. And any route beyond
 * the two asked below -- this is a smoke test for "is it alive", and the routes
 * that have behaviour worth asserting have their own files.
 *
 *   bun test app-server/boot.test.ts
 */

import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A port nothing is on, taken by binding it and letting go. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

test("it boots on a scratch port, answers /health, and serves the directory it was given", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyc-appboot-"));
  const port = await freePort();
  /* Every path this server writes to, pointed at the scratch directory, and
   * every service it talks to pointed at a port nothing listens on. A boot
   * check that touched .run/push-subs.json would be competing with the real
   * phone for a slot, and one that hit :10102 would be putting load on kokoro to
   * find out whether a file parses. */
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../bootstrap/server.ts")], {
    env: {
      ...process.env,
      APP_PORT: String(port),
      APP_HOST: "127.0.0.1",
      DIST_DIR: dir,
      PUSH_FILE: join(dir, "push-subs.json"),
      SETTINGS_FILE: join(dir, "app-settings.json"),
      CYC_LOG_DIR: join(dir, "logs"),
      VOICE_ENGINES: "http://127.0.0.1:1|http://127.0.0.1:1|none",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  /* The boot's own words, kept. This is the difference between this check and
   * the incidental one the other specs make: a server that threw on import says
   * exactly why on stderr, and a test that discards it reports a timeout. */
  const said = async () => {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ]);
    return `${out}${err}`.trim() || "(it printed nothing at all)";
  };
  const stop = async () => { proc.kill(); await proc.exited; };

  await writeFile(join(dir, "index.html"), "<!doctype html><title>scratch bundle</title>");

  const url = `http://127.0.0.1:${port}`;
  let health: Response | null = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    /* An exit is an answer, and a faster one than the deadline: a server that
     * threw on import is never going to answer, so waiting the full twenty
     * seconds only delays the message that already exists. */
    if (proc.exitCode !== null) {
      const why = await said();
      throw new Error(
        `THE APP SERVER DID NOT BOOT. It exited with code ${proc.exitCode} before ` +
        `answering ${url}/health. It said:\n\n${why}\n`);
    }
    health = await fetch(`${url}/health`).catch(() => null);
    if (health?.ok) break;
    await Bun.sleep(100);
  }
  if (!health?.ok) {
    const why = await said();
    await stop();
    throw new Error(
      `THE APP SERVER NEVER ANSWERED. It was still running after 20s but ` +
      `${url}/health did not return 200. It said:\n\n${why}\n`);
  }

  try {
    const body = (await health.json()) as { ok: boolean; dist: string };
    expect(body.ok).toBe(true);
    /* It is serving the directory it was TOLD to serve. A boot that fell back
     * to the built-in DIST_DIR would answer /health just as cheerfully while
     * serving somebody else's bundle. */
    expect(body.dist).toBe(dir);

    /* And the static route is wired, which is the half of this process the
     * whole app depends on. `/` is index.html. */
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("scratch bundle");
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, 40_000);
