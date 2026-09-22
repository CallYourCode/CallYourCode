/* pairkey.test.ts (#pairing-onboarding): the key-reveal command's proofs.
 *
 * The subject here IS the command, so the flows that go through the chooser run
 * the real CLI as its own bun process with piped stdin. That is not an engine
 * boot: nothing listens, nothing announces, and the only servers in the file are
 * port-0 stubs standing in for a hosted app server. Every run gets its own tmp
 * data dir AND its own tmp HOME, so a bug that reached for the real
 * ~/.callyourcode would fail here rather than rewriting his keys.
 *
 * What is protected: the printed key round-trips (base64url -> newestGen
 * keyBytes), the url carries the key in the #fragment and NEVER in the query, a
 * missing keys.json is created 0600 and an existing one is reused (printing a
 * key must not rotate a running engine's wire), the chooser's stdin flows
 * including the junk ones, and the cloud onboarding grant trade.
 *
 *   bun test agent-engine/src/security/pairkey.test.ts
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join, relative } from "node:path";
import {
  pairKeyFacts,
  pairingUrl,
  appServerUrl,
  localAppUrl,
  renderQr,
  restartEngineService,
  tailnetServeBase,
  CLOUD_APP_URL,
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
const CLEARED = ["APP_SERVER_URL", "CYC_DATA_DIR", "CYC_CLOUD_URL", "ENGINE_HOST"];
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
     * CYC_DATA_DIR, APP_SERVER_URL and CYC_CLOUD_URL; anything else inherited
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

  /* THE KEY RIDES IN THE FRAGMENT. A fragment is never put on the wire, so
   * the E2E root cannot land in an access log, in history sync, or in a Referer
   * header, and for the cloud link it never reaches callyourcode.com at all. */
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

/* --------------------------------------------------------- the chooser */

test("chooser: Local and Cloud flows via piped stdin", async () => {
  const { dataDir, keysFile, home } = await scratch();
  // a real app server address that this command must never dial
  const app = stubServer(() => new Response("ok"));
  /* The hosted deployment's stand-in (CYC_CLOUD_URL): picking Cloud now dials
   * it for the device-flow start, so the real callyourcode.com must never be
   * the base in a test. This one refuses the device flow (an older server),
   * which lands on the manual fallback; EOF skips the paste. */
  const cloudStub = stubServer(() => new Response("not found", { status: 404 }));
  try {
    const local = await runPairkey({ stdin: "1\n", dataDir, home, appUrl: app.url });
    const cloud = await runPairkey({
      stdin: "2\n", dataDir, home, appUrl: app.url, env: { CYC_CLOUD_URL: cloudStub.url },
    });

    expect(local.code).toBe(0);
    expect(cloud.code).toBe(0);
    expect(local.err).toBe("");
    expect(cloud.err).toBe("");

    const st = await loadOrCreateE2E(keysFile);
    const key = b64urlencode(newestGen(st).keyBytes);
    const engineId = st.engineId;

    const localUrl = urlLine(local.out);
    const cloudUrl = urlLine(cloud.out);
    expect(localUrl).toBe(pairingUrl(localAppUrl(app.url), key, engineId));
    expect(cloudUrl).toBe(pairingUrl(cloudStub.url, key, engineId));

    // Local points at this machine; Cloud points at the cloud base. The two
    // must not be the same host, or "stays on this machine" is a lie. Outside
    // tests the cloud base is the hosted deployment.
    expect(new URL(localUrl).hostname).toBe("localhost");
    expect(new URL(cloudUrl).host).toBe(new URL(cloudStub.url).host);
    expect(new URL(cloudUrl).hostname).not.toBe("localhost");
    expect(new URL(CLOUD_APP_URL).hostname).toBe("app.callyourcode.com");

    // the bare key is printed on its own line in both runs, so it can be
    // selected without dragging the url along
    expect(local.out.split("\n")).toContain(key);
    expect(cloud.out.split("\n")).toContain(key);

    // Cloud prints the QR for the cloud url; Local prints no QR at all
    expect(cloud.out).toContain(renderQr(cloudUrl));
    expect(local.out).not.toContain(renderQr(localUrl));

    // and neither flow dialed the app server: the key comes off disk. Cloud
    // dialed its base exactly once, for the refused device-flow start.
    expect(app.hits).toEqual([]);
    expect(cloudStub.hits.map((h) => h.path)).toEqual(["/enroll/device"]);
  } finally { app.stop(); cloudStub.stop(); }
});

test("the chooser takes junk, aliases and EOF, and never GUESSES Cloud", async () => {
  /* Local is the default because Cloud is the choice that sends anything
   * anywhere. Anything the parser does not recognise, including a closed stdin
   * (the curl|sh installer), has to land on Local. */
  const { dataDir, home } = await scratch();
  const app = stubServer(() => new Response("ok"));
  /* Cloud dials its base for the device-flow start now, so the base must be a
   * dead local port, never the real hosted deployment. The refused connect
   * lands on the manual fallback; EOF skips the paste. */
  const gone = deadUrl();
  const wants: Array<[string | null, "local" | "cloud"]> = [
    ["1\n", "local"],
    ["\n", "local"],
    [null, "local"],           // EOF: stdin closed without a byte
    ["banana\n", "local"],
    ["3\n", "local"],
    ["   \n", "local"],
    ["local\n", "local"],
    ["LOCAL\n", "local"],
    ["12\n", "local"],         // not "1", not "2": still not a licence to phone home
    ["2\n", "cloud"],
    [" 2 \n", "cloud"],
    ["cloud\n", "cloud"],
    ["CLOUD\n", "cloud"],
  ];
  try {
    /* ONE AT A TIME, deliberately. Thirteen copies of the command racing to
     * create the same keys.json is a different test (and one the command does
     * not claim to pass); what is under test here is the parser. */
    const got: string[] = [];
    for (const [stdin] of wants) {
      const r = await runPairkey({
        stdin, dataDir, home, appUrl: app.url, env: { CYC_CLOUD_URL: gone },
      });
      expect(r.code).toBe(0);
      // Local prints the localhost link; Cloud prints the cloud base's.
      got.push(new URL(urlLine(r.out)).hostname === "localhost" ? "local" : "cloud");
    }
    expect(got).toEqual(wants.map(([, want]) => want));
    expect(app.hits).toEqual([]);
  } finally { app.stop(); }
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

/* ---- the cloud onboarding (device flow) -----------------------------------
 *
 * A stub app server stands in for the hosted deployment (CYC_CLOUD_URL). The
 * DEFAULT flow is auto-receive: start a device session, open the sign-in url
 * in a browser (or just print it), poll for the cyg_ grant. The FALLBACK
 * (server without the device flow) is the manual paste. Either way the grant
 * must ride as the bearer beside the signed identity proof, and the issued
 * cyt_ token must land in state/app-token.json bound to the cloud base. The
 * app-server side is proved in app-server/onboard.test.ts; this is the
 * terminal half. */

/** A stateful hosted-deployment stub for the auto-receive flow: a device
 *  session, N pending polls, then the grant, then enrollment. */
function cloudDeviceStub(o: { pendingPolls?: number; expiresInMs?: number } = {}) {
  let polls = 0;
  return stubServer((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/enroll/device") {
      return Response.json({ device: "cyd_stubdev", code: "cyu_stubuser",
        expiresAt: Date.now() + (o.expiresInMs ?? 60_000), intervalMs: 10 });
    }
    if (path === "/enroll/device/poll") {
      polls++;
      return polls <= (o.pendingPolls ?? 1)
        ? Response.json({ status: "pending" })
        : Response.json({ status: "granted", grant: "cyg_autogrant" });
    }
    if (path === "/engines/enroll") {
      return Response.json({ ok: true, token: "cyt_auto", owner: "user_x" });
    }
    return new Response("not found", { status: 404 });
  });
}

test("cloud onboarding: auto-receive opens the browser and needs no paste", async () => {
  const { dataDir, home } = await scratch();
  const cloud = cloudDeviceStub({ pendingPolls: 2 });
  /* A $BROWSER that records what it was asked to open: the sign-in url with
   * the user code, and nothing else. */
  const opener = join(home, "record-open.sh");
  writeFileSync(opener, `#!/bin/sh\nprintf '%s' "$1" > "${join(home, "opened.txt")}"\n`);
  chmodSync(opener, 0o755);
  try {
    const r = await runPairkey({
      stdin: "2\n", dataDir, home,
      env: { CYC_CLOUD_URL: cloud.url, CYC_ENROLL_POLL_MS: "10", BROWSER: opener },
    });
    expect(r.code).toBe(0);

    // no paste prompt: the grant arrived over the poll
    expect(r.out).not.toContain("Paste the code");
    expect(r.out).toContain("Your browser should open");
    expect(r.out).toContain("Linked");
    const signInUrl = `${cloud.url}/enroll?code=cyu_stubuser`;
    expect(r.out).toContain(signInUrl);

    // the browser was asked to open exactly the sign-in url (the spawn is
    // fire-and-forget, so give the recorder a moment)
    await until(() => existsSync(join(home, "opened.txt")), { what: "the $BROWSER recorder file" });
    expect(readFileSync(join(home, "opened.txt"), "utf8")).toBe(signInUrl);

    // start, pending+granted polls, then exactly one enrollment with the
    // polled grant as bearer and the signed identity in the body
    expect(cloud.hits.map((h) => h.path)).toEqual([
      "/enroll/device", "/enroll/device/poll", "/enroll/device/poll",
      "/enroll/device/poll", "/engines/enroll",
    ]);
    const enroll = cloud.hits[cloud.hits.length - 1];
    expect(enroll.auth).toBe("Bearer cyg_autogrant");
    expect(typeof enroll.body?.engineId).toBe("string");
    expect(typeof enroll.body?.sig).toBe("string");

    // the token file is saved and bound to the cloud base
    const file = join(dataDir, "state", "app-token.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadAppToken(file, cloud.url)).toBe("cyt_auto");
    expect(urlLine(r.out)).toStartWith(`${cloud.url}/?engine=`);
  } finally { cloud.stop(); }
});

test("cloud onboarding: headless (no browser) still auto-receives over the poll", async () => {
  /* No BROWSER, no DISPLAY in the curated child env: the command prints the
   * url prominently and keeps polling, exactly like `claude` login does. */
  const { dataDir, home } = await scratch();
  const cloud = cloudDeviceStub();
  try {
    const r = await runPairkey({
      stdin: "2\n", dataDir, home,
      env: { CYC_CLOUD_URL: cloud.url, CYC_ENROLL_POLL_MS: "10" },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${cloud.url}/enroll?code=cyu_stubuser`);
    expect(r.out).toContain("Open that url in a browser");
    expect(r.out).not.toContain("Paste the code");
    expect(loadAppToken(join(dataDir, "state", "app-token.json"), cloud.url)).toBe("cyt_auto");
  } finally { cloud.stop(); }
});

test("cloud onboarding: a sign-in that never completes times out with exit 1", async () => {
  const { dataDir, home } = await scratch();
  const cloud = cloudDeviceStub({ pendingPolls: 1_000_000, expiresInMs: 250 });
  try {
    const r = await runPairkey({
      stdin: "2\n", dataDir, home,
      env: { CYC_CLOUD_URL: cloud.url, CYC_ENROLL_POLL_MS: "25" },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("did not complete");
    expect(existsSync(join(dataDir, "state", "app-token.json"))).toBe(false);
    // and the links still print, so the run is never a dead end
    expect(urlLine(r.out)).toStartWith(`${cloud.url}/?engine=`);
  } finally { cloud.stop(); }
});

test("cloud onboarding fallback: the pasted grant is traded for a saved engine token", async () => {
  /* A server without the device flow (404 on /enroll/device): the original
   * manual copy still works, pasted with the whitespace a terminal copy
   * drags along. */
  const { dataDir, home } = await scratch();
  const cloud = stubServer((req) =>
    new URL(req.url).pathname === "/enroll/device"
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify({ ok: true, token: "cyt_fromstub", owner: "user_x" }),
          { headers: { "content-type": "application/json" } }));
  try {
    const r = await runPairkey({
      stdin: "2\n  cyg_pastedcode  \n", dataDir, home, env: { CYC_CLOUD_URL: cloud.url },
    });
    expect(r.code).toBe(0);

    // the terminal printed the auth-page url and the success line
    expect(r.out).toContain(`${cloud.url}/enroll`);
    expect(r.out).toContain("Linked");

    // the refused device-flow probe, then exactly one enrollment: the grant
    // as bearer, the signed identity in the body
    expect(cloud.hits.length).toBe(2);
    expect(cloud.hits[0].path).toBe("/enroll/device");
    expect(cloud.hits[1].path).toBe("/engines/enroll");
    expect(cloud.hits[1].auth).toBe("Bearer cyg_pastedcode");
    const body = cloud.hits[1].body;
    expect(typeof body?.engineId).toBe("string");
    expect(typeof body?.pubkey).toBe("string");
    expect(typeof body?.sig).toBe("string");
    expect(Math.abs(Date.now() - Number(body?.ts))).toBeLessThan(60_000);

    // the token file is saved, 0600, and BOUND to the cloud base: a token
    // presented to a different app server is not this token
    const file = join(dataDir, "state", "app-token.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadAppToken(file, cloud.url)).toBe("cyt_fromstub");
    expect(loadAppToken(file, "https://elsewhere.example")).toBeNull();

    // the pairing url printed for the app points at the same cloud base
    expect(urlLine(r.out)).toStartWith(`${cloud.url}/?engine=`);
  } finally { cloud.stop(); }
});

test("cloud onboarding: a refused grant saves nothing and exits 1", async () => {
  const { dataDir, home } = await scratch();
  const cloud = stubServer(() =>
    new Response(JSON.stringify({ error: "bad grant" }),
      { status: 401, headers: { "content-type": "application/json" } }));
  try {
    const r = await runPairkey({
      stdin: "2\ncyg_expiredcode\n", dataDir, home, env: { CYC_CLOUD_URL: cloud.url },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Enrollment failed");
    expect(existsSync(join(dataDir, "state", "app-token.json"))).toBe(false);
  } finally { cloud.stop(); }
});

test("cloud onboarding: a 200 that carries no token is a refusal, not a token", async () => {
  /* What a captive portal or a misconfigured proxy answers. Saving "" (or the
   * word "undefined") as the engine token would send the engine into a boot
   * loop of 401s with no way to tell why. */
  const { dataDir, home } = await scratch();
  const cloud = stubServer(() => Response.json({ ok: true }));
  try {
    const r = await runPairkey({
      stdin: "2\ncyg_code\n", dataDir, home, env: { CYC_CLOUD_URL: cloud.url },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Enrollment failed");
    expect(existsSync(join(dataDir, "state", "app-token.json"))).toBe(false);
  } finally { cloud.stop(); }
});

test("cloud onboarding: an empty paste skips enrollment and still prints the links", async () => {
  const { dataDir, home } = await scratch();
  // a base that answers nothing: if the command dialed anyway, the run would
  // hang on the connect instead of returning in milliseconds
  const gone = deadUrl();
  const r = await runPairkey({ stdin: "2\n\n", dataDir, home, env: { CYC_CLOUD_URL: gone } });
  expect(r.code).toBe(0);
  expect(r.out).toContain("No code pasted");
  expect(r.out).toContain(`${gone}/enroll`);
  expect(urlLine(r.out)).toStartWith(`${gone}/?engine=`);
  expect(existsSync(join(dataDir, "state", "app-token.json"))).toBe(false);
});

/* --------------------------------------- the post-enroll engine restart.
 * cyc pair -> Cloud must JUST WORK: the enrollment saves the token file and
 * the pair bounces the installed engine itself. The two hard rules: a scoped
 * instance (CYC_DATA_DIR set) never touches the machine's service, and a
 * refusing service manager reports false rather than throwing. */

test("restartEngineService refuses under CYC_DATA_DIR: a scoped instance never bounces the installed service", async () => {
  const prior = process.env.CYC_DATA_DIR;
  process.env.CYC_DATA_DIR = "/tmp/some-scoped-instance";
  try {
    const calls: string[][] = [];
    expect(await restartEngineService(async (cmd) => { calls.push(cmd); return 0; })).toBe(false);
    expect(calls).toHaveLength(0);
  } finally {
    if (prior === undefined) delete process.env.CYC_DATA_DIR;
    else process.env.CYC_DATA_DIR = prior;
  }
});

test("restartEngineService bounces the installer's own unit, and a refusal is false, not a throw", async () => {
  const prior = process.env.CYC_DATA_DIR;
  delete process.env.CYC_DATA_DIR;
  try {
    const calls: string[][] = [];
    expect(await restartEngineService(async (cmd) => { calls.push(cmd); return 0; })).toBe(true);
    expect(calls).toHaveLength(1);
    if (process.platform === "darwin") {
      expect(calls[0]!.join(" ")).toContain("com.callyourcode.agent-engine");
    } else {
      expect(calls[0]).toEqual(["systemctl", "--user", "restart", "cyc-agent-engine.service"]);
    }
    expect(await restartEngineService(async () => 1)).toBe(false);
  } finally {
    if (prior === undefined) delete process.env.CYC_DATA_DIR;
    else process.env.CYC_DATA_DIR = prior;
  }
});

/* --------------------------------------------- the tailnet-served Local link.
 * Pair Local + tailscale running: the app goes on the tailnet over https and
 * the link points there (a phone needs the secure context anyway). The rules
 * proven: scoped instances and non-loopback bases never run a command, an
 * existing foreign serve config is never clobbered, and every refusal falls
 * back to null (the plain localhost link). */

const TS_PORT = new URL(DEFAULT_APP_URL).port;
const TS_RUNNING = JSON.stringify({ BackendState: "Running", Self: { DNSName: "box.tail42.ts.net." } });

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
