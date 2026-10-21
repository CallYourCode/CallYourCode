import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join, relative } from "node:path";
import {
  pairKeyFacts,
  pairingUrl,
  appServerUrl,
  localAppUrl,
  renderQr,
  tailnetServeBase,
  DEFAULT_APP_URL,
} from "./pairkey";
import { b64urlencode, b64urldecode } from "../../../shared/e2e";
import { loadAppToken } from "./enroll";
import { loadOrCreateE2E, newestGen } from "./sec";
import { tmpDir } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/* ENV IS TOUCHED ONCE, AT FILE SCOPE, AND PUT BACK.
 *
 * appServerUrl() and dataDir() read these per call, so a stray APP_SERVER_URL
 * or CYC_DATA_DIR in the shell that started `bun test` would silently point
 * half this file at his real install. They are cleared for the whole file and
 * every value a test wants is passed explicitly (an argument in-process, an env
 * entry on the child). */
const SAVED: Record<string, string | undefined> = {};
const CLEARED = ["APP_SERVER_URL", "CYC_DATA_DIR", "ENGINE_HOST"];
beforeAll(() => {
  for (const k of CLEARED) { SAVED[k] = process.env[k]; delete process.env[k]; }
});
afterAll(() => {
  for (const k of CLEARED) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k]!;
  }
});

/** A fresh CYC_DATA_DIR laid out as the engine's, plus a HOME nothing real
 *  lives in. Per call: two runs of the command in one test are two installs
 *  unless the test deliberately points them at the same dir. */
async function scratch(): Promise<{ dataDir: string; keysFile: string; home: string }> {
  const root = await tmpDir("pairkey-");
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { dataDir, keysFile: join(dataDir, "keys.json"), home };
}

/* Every listener in this file is port 0 read back. A hard-coded port would put
 * two parallel workers (or this file and his real fleet) on the same socket. */
function stubServer(handler: (req: Request) => Response | Promise<Response>) {
  const hits: Array<{ path: string; auth: string | null; body: any }> = [];
  const srv = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      hits.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
        body: await req.json().catch(() => null),
      });
      return handler(req);
    },
  });
  return { url: `http://127.0.0.1:${srv.port}`, hits, stop: () => srv.stop(true) };
}

/** A url shaped like a real app server that is guaranteed to answer nothing:
 *  a port-0 listener, read back, then closed. Never a made-up port number. */
function deadUrl(): string {
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const url = `http://127.0.0.1:${srv.port}`;
  srv.stop(true);
  return url;
}

type Run = { out: string; err: string; code: number };

/** Drive the real command as its own process. `stdin` is written and closed;
 *  pass null to close it immediately (the EOF case the installer hits). */
async function runPairkey(o: {
  args?: string[];
  stdin?: string | null;
  dataDir: string;
  home: string;
  appUrl?: string;
  env?: Record<string, string>;
  path?: string;
}): Promise<Run> {
  const proc = Bun.spawn([process.execPath, "run", "src/security/pairkey.ts", ...(o.args ?? [])], {
    cwd: REPO_ROOT,
    /* A CURATED env, not a spread of this process's. The command reads
     * CYC_DATA_DIR, APP_SERVER_URL; anything else inherited
     * from the developer's shell is a way for a test to pass on his machine and
     * fail on the box (or, worse, touch his real install). */
    env: {
      PATH: o.path ?? process.env.PATH ?? "",
      HOME: o.home,
      CYC_DATA_DIR: o.dataDir,
      ...(o.appUrl ? { APP_SERVER_URL: o.appUrl } : {}),
      ...(o.env ?? {}),
    },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  if (o.stdin != null) proc.stdin.write(o.stdin);
  proc.stdin.end();
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { out, err, code: await proc.exited };
}

/** The one line of output that is a pairing url. */
const urlLine = (out: string): string =>
  out.split("\n").find((l) => /^https?:\/\/[^\s]+\/\?engine=/.test(l)) ?? "";

/* ------------------------------------------------------------- the facts */

test("pairKeyFacts derives the key from newestGen and a parseable url", async () => {
  const { dataDir, keysFile } = await scratch();
  const facts = await pairKeyFacts({ dataDir, appUrl: DEFAULT_APP_URL, host: "box" });

  // the engine id is the stable e-<hex> form, host is the override
  expect(facts.engineId).toMatch(/^e-[a-f0-9]+$/);
  expect(facts.host).toBe("box");

  // the key decodes back to the newest content generation's raw keyBytes
  const st = await loadOrCreateE2E(keysFile);
  expect(newestGen(st).gen).toBe(1);
  expect(Array.from(b64urldecode(facts.key))).toEqual(Array.from(newestGen(st).keyBytes));
  expect(facts.engineId).toBe(st.engineId);

  const u = new URL(facts.url);
  expect(u.pathname).toBe("/");
  expect(u.searchParams.get("engine")).toBe(facts.engineId);
  expect(u.searchParams.has("pair")).toBe(false);
  expect(u.hash).toBe(`#pair=${facts.key}`);
  // and not just absent from the query: absent from EVERY byte before the #
  expect(facts.url.slice(0, facts.url.indexOf("#"))).not.toContain(facts.key);
});

test("pairingUrl encodes both parts, key in the fragment only", () => {
  expect(pairingUrl("https://app.example/", "a/b+c=", "e-1")).toBe(
    "https://app.example/?engine=e-1#pair=a%2Fb%2Bc%3D",
  );
  // a trailing slash pile is one base, not three
  expect(pairingUrl("https://app.example///", "k", "e-1")).toBe(
    "https://app.example/?engine=e-1#pair=k",
  );
});

test("appServerUrl prefers the engine's boot file over the loopback default", async () => {
  const root = await tmpDir("pairkey-url-");
  const file = join(root, "app-server-url");
  writeFileSync(file, "https://linux.example.ts.net/\n");
  expect(appServerUrl(file)).toBe("https://linux.example.ts.net");

  // no boot file at all: the loopback default is the last resort
  expect(appServerUrl(join(root, "missing"))).toBe(DEFAULT_APP_URL);
  // an EMPTY boot file is not an answer either (a half-written file at boot)
  const empty = join(root, "empty");
  writeFileSync(empty, "\n  \n");
  expect(appServerUrl(empty)).toBe(DEFAULT_APP_URL);
  // and a directory where a file should be degrades instead of throwing
  expect(appServerUrl(root)).toBe(DEFAULT_APP_URL);
});

test("localAppUrl rewrites only a loopback host, and keeps scheme and port", () => {
  const stub = stubServer(() => new Response("ok"));
  try {
    const u = new URL(localAppUrl(stub.url));
    expect(u.hostname).toBe("localhost");
    expect(u.port).toBe(String(new URL(stub.url).port));
    expect(u.protocol).toBe("http:");
  } finally { stub.stop(); }
  // a tailnet or LAN base is left exactly alone: rewriting it to localhost
  // would print a link that only works on the machine nobody is holding
  expect(localAppUrl("https://box.example.ts.net")).toBe("https://box.example.ts.net");
  expect(localAppUrl("not a url at all")).toBe("not a url at all");
});

/* ------------------------------------------------------------- keys.json */

test("a missing keys.json is created 0600, engine id inside it", async () => {
  const { dataDir, keysFile } = await scratch();
  expect(existsSync(keysFile)).toBe(false);

  await pairKeyFacts({ dataDir });

  expect(existsSync(keysFile)).toBe(true);
  expect(statSync(keysFile).mode & 0o777).toBe(0o600);
  const j = JSON.parse(readFileSync(keysFile, "utf8"));
  expect(j.v).toBe(3);
  expect(j.engineId).toMatch(/^e-[0-9a-f]{32}$/);
});

test("an existing keys.json is REUSED, and a world-readable one is repaired to 0600", async () => {
  /* Printing a pairing key must be read-only for a running engine. If this
   * minted a new generation, every paired device would go dark the moment
   * somebody ran the command to look at the key. */
  const { dataDir, keysFile } = await scratch();
  const first = await pairKeyFacts({ dataDir });

  chmodSync(keysFile, 0o644); // as a careless restore or a `cp` would leave it
  const before = readFileSync(keysFile, "utf8");

  const second = await pairKeyFacts({ dataDir });
  expect(second.key).toBe(first.key);
  expect(second.engineId).toBe(first.engineId);
  expect(readFileSync(keysFile, "utf8")).toBe(before); // not one byte rewritten
  // ...but the mode IS repaired: a keys.json anybody on the box can read is the
  // whole E2E root sitting in the open
  expect(statSync(keysFile).mode & 0o777).toBe(0o600);
});

test("a keys.json that is not a v3 file is backed up, never silently overwritten", async () => {
  const { dataDir, keysFile } = await scratch();
  writeFileSync(keysFile, '{"v":2,"note":"an older or foreign file"}\n');

  const facts = await pairKeyFacts({ dataDir });
  expect(facts.key.length).toBeGreaterThan(0);

  // the old bytes are still on disk under keys.bak.json: the operator gets to
  // look at what was displaced rather than finding it gone
  const bak = join(dataDir, "keys.bak.json");
  expect(existsSync(bak)).toBe(true);
  expect(JSON.parse(readFileSync(bak, "utf8")).note).toBe("an older or foreign file");
  expect(JSON.parse(readFileSync(keysFile, "utf8")).v).toBe(3);
});

test("local onboarding opens the pairing page in the browser when one exists", async () => {
  /* Onboarding is engine-initiated in BOTH modes: with a way to show a browser
   * ($BROWSER here; a TTY with a display otherwise) Local opens the pairing
   * url itself. The printed key and link are unchanged, and a scripted run
   * with no $BROWSER (every other test in this file) never pops a window. */
  const { dataDir, keysFile, home } = await scratch();
  const app = stubServer(() => new Response("ok"));
  const opener = join(home, "record-open.sh");
  writeFileSync(opener, `#!/bin/sh\nprintf '%s' "$1" > "${join(home, "opened.txt")}"\n`);
  chmodSync(opener, 0o755);
  try {
    const r = await runPairkey({ stdin: "1\n", dataDir, home, appUrl: app.url, env: { BROWSER: opener } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Opening the pairing page in your browser");

    await until(() => existsSync(join(home, "opened.txt")), { what: "the $BROWSER recorder file" });
    const st = await loadOrCreateE2E(keysFile);
    const key = b64urlencode(newestGen(st).keyBytes);
    const expected = pairingUrl(localAppUrl(app.url), key, st.engineId);
    expect(readFileSync(join(home, "opened.txt"), "utf8")).toBe(expected);
    expect(urlLine(r.out)).toBe(expected); // the link still prints beside the open
    expect(app.hits).toEqual([]);
  } finally { app.stop(); }
});

test("APP_SERVER_URL wins over the engine's boot file, end to end", async () => {
  const { dataDir, home } = await scratch();
  mkdirSync(join(dataDir, "state"), { recursive: true });
  writeFileSync(join(dataDir, "state", "app-server-url"), "https://from-boot-file.example\n");

  const withEnv = await runPairkey({ stdin: "1\n", dataDir, home, appUrl: "https://from-env.example" });
  expect(urlLine(withEnv.out)).toStartWith("https://from-env.example/?engine=");

  // and with no env, the file the running engine wrote is what an ssh shell
  // that never inherited launchd's environment gets to print
  const noEnv = await runPairkey({ stdin: "1\n", dataDir, home });
  expect(urlLine(noEnv.out)).toStartWith("https://from-boot-file.example/?engine=");
});

test("the key reaches stdout and no file other than keys.json", async () => {
  /* The header's promise: "Nothing here writes the key to a file or a logbook;
   * stdout is the only surface the key ever reaches." keys.json is where the
   * key LIVES (0600); anything else holding it is a leak. */
  const { dataDir, home } = await scratch();
  const r = await runPairkey({ stdin: "1\n", dataDir, home, appUrl: deadUrl() });
  const key = urlLine(r.out).split("#pair=")[1];
  expect(key.length).toBeGreaterThan(20);

  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (relative(dataDir, p) === "keys.json") continue;
      if (readFileSync(p, "utf8").includes(decodeURIComponent(key))) offenders.push(relative(dataDir, p));
    }
  };
  walk(dataDir);
  expect(offenders).toEqual([]);
});

test("tailnetServeBase: scoped instance or a non-loopback base refuses before any command", async () => {
  const calls: string[][] = [];
  const run = async (cmd: string[]) => { calls.push(cmd); return { code: 0, out: "" }; };

  const prior = process.env.CYC_DATA_DIR;
  process.env.CYC_DATA_DIR = "/tmp/scoped";
  try {
    expect(await tailnetServeBase(DEFAULT_APP_URL, run)).toBeNull();
  } finally {
    if (prior === undefined) delete process.env.CYC_DATA_DIR;
    else process.env.CYC_DATA_DIR = prior;
  }
  expect(await tailnetServeBase("https://app.example.test", run)).toBeNull();
  expect(calls).toHaveLength(0);
});

const TS_PORT = new URL(DEFAULT_APP_URL).port;
const TS_RUNNING = JSON.stringify({Self: {DNSName: "box.tail42.ts.net."}});
const PROBE_OK = async () => true;

test("tailnetServeBase: present -> serve -> cert -> probed https base, in that order", async () => {
  const calls: string[][] = [];
  const run = async (cmd: string[]) => {
    calls.push(cmd);
    if (cmd[1] === "status") return { code: 0, out: TS_RUNNING };
    return { code: 0, out: "" };
  };
  const probed: string[] = [];
  const probeFn = async (url: string) => { probed.push(url); return true; };
  expect(await tailnetServeBase(DEFAULT_APP_URL, run, () => {}, undefined, probeFn)).toBe("https://box.tail42.ts.net");
  expect(calls.map((c) => c.join(" "))).toEqual([
    "tailscale version",
    `tailscale serve --bg ${TS_PORT}`,
    "tailscale status --json",
    "tailscale cert --cert-file /dev/null --key-file /dev/null box.tail42.ts.net",
  ]);
  expect(probed).toEqual(["https://box.tail42.ts.net/"]);
});

test("tailnetServeBase: a dead link is never printed; certs-off names the toggle", async () => {
  const said: string[] = [];
  const okRun = async (cmd: string[]) =>
    cmd[1] === "status" ? { code: 0, out: TS_RUNNING } : { code: 0, out: "" };

  // everything green but the page never answers: fall back, loudly
  expect(await tailnetServeBase(DEFAULT_APP_URL, okRun, (l) => said.push(l), undefined, async () => false)).toBeNull();
  expect(said.join("\n")).toContain("not answering");

  // cert refused with a tailscale approval link and nobody to ask: name the toggle
  said.length = 0;
  const certOff = async (cmd: string[]) => {
    if (cmd[1] === "cert") return { code: 1, out: "HTTPS cert support not enabled: https://login.tailscale.com/f/https?node=n1" };
    if (cmd[1] === "status") return { code: 0, out: TS_RUNNING };
    return { code: 0, out: "" };
  };
  expect(await tailnetServeBase(DEFAULT_APP_URL, certOff, (l) => said.push(l), undefined, PROBE_OK)).toBeNull();
  expect(said.join("\n")).toContain("HTTPS Certificates");
});

test("tailnetServeBase: no tailscale is a silent fallback; a failed serve says why", async () => {
  const said: string[] = [];
  const say = (l: string) => said.push(l);

  // no tailscale binary at all: nothing to tell a user
  expect(await tailnetServeBase(DEFAULT_APP_URL, async () => ({ code: -1, out: "" }), say)).toBeNull();
  expect(said).toHaveLength(0);

  // serve refusing (operator rights, version skew, whatever): loud
  const refusing = async (cmd: string[]) =>
    cmd[1] === "serve" ? { code: 1, out: "config: unable to reach tailscaled" } : { code: 0, out: TS_RUNNING };
  expect(await tailnetServeBase(DEFAULT_APP_URL, refusing, say)).toBeNull();
  expect(said.join("\n")).toContain(`tailscale serve --bg ${TS_PORT}`);
  expect(said.join("\n")).toContain("unable to reach tailscaled");

  // served but no machine name to build the link with: loud
  said.length = 0;
  const nameless = async (cmd: string[]) =>
    cmd[1] === "status" ? { code: 0, out: JSON.stringify({ Self: {} }) } : { code: 0, out: "" };
  expect(await tailnetServeBase(DEFAULT_APP_URL, nameless, say)).toBeNull();
  expect(said.join("\n")).toContain("no tailnet machine name");
});

test("tailnetServeBase: serve-not-enabled hands the approval link to ask and retries on yes", async () => {
  const ENABLE = "https://login.tailscale.com/f/serve?node=nABC123CNTRL";
  let serveTries = 0;
  const run = async (cmd: string[]) => {
    if (cmd[1] === "serve") {
      serveTries += 1;
      if (serveTries === 1) return { code: 1, out: `Serve is not enabled on your tailnet.\nTo enable, visit:\n\n\t${ENABLE}` };
      return { code: 0, out: "" };
    }
    if (cmd[1] === "status") return { code: 0, out: TS_RUNNING };
    return { code: 0, out: "" };
  };

  const asked: string[] = [];
  const yes = async (u: string) => { asked.push(u); return true; };
  expect(await tailnetServeBase(DEFAULT_APP_URL, run, () => {}, yes, PROBE_OK)).toBe("https://box.tail42.ts.net");
  expect(asked).toEqual([ENABLE]);
  expect(serveTries).toBe(2);

  // declining the retry falls back loudly; without ask it falls back too
  serveTries = 0;
  const said: string[] = [];
  const failing = async (cmd: string[]) =>
    cmd[1] === "serve" ? { code: 1, out: `Serve is not enabled on your tailnet.\n${ENABLE}` } : { code: 0, out: TS_RUNNING };
  const no = async () => false;
  expect(await tailnetServeBase(DEFAULT_APP_URL, failing, (l) => said.push(l), no)).toBeNull();
  expect(said.join("\n")).toContain("not enabled");
  expect(await tailnetServeBase(DEFAULT_APP_URL, failing, () => {})).toBeNull();
});

test("tailnetServeBase: a version-skew warning around the status JSON still parses (2026-09-22 field case)", async () => {
  const warned = async (cmd: string[]) => {
    if (cmd[1] === "status") return { code: 0, out: `Warning: client version "1.98.8" != tailscaled server version "1.102.4"\n${TS_RUNNING}` };
    return { code: 0, out: "" };
  };
  expect(await tailnetServeBase(DEFAULT_APP_URL, warned, () => {}, undefined, PROBE_OK)).toBe("https://box.tail42.ts.net");
});
