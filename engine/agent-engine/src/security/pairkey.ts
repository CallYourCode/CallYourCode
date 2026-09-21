/* pairkey.ts (#pairing-onboarding): the key-reveal + onboarding chooser.
 *
 * `bun run agent-engine/src/security/pairkey.ts` is the onboarding command. With no
 * subcommand it shows a Local/Cloud chooser, then prints the pairing key and
 * the app link for the chosen destination:
 *
 *   Local      blank line, the bare key, the localhost pairing url, one hint;
 *              the pairing page is opened in the local browser when one
 *              exists (the key stays in the #fragment, so it never leaves
 *              this machine)
 *   Cloud      the CLOUD ONBOARDING (device flow, auto-receive): start a
 *              device session at the hosted /enroll/device, OPEN the sign-in
 *              page (/enroll?code=...) in a browser ($BROWSER, `open`,
 *              `xdg-open`; headless just prints the url), and poll
 *              /enroll/device/poll until the signed-in page attaches the
 *              one-time cyg_ grant. Trade the grant (plus this engine's
 *              signed identity) for the long-lived engine token at
 *              /engines/enroll, save state/app-token.json, then print the
 *              pairing url + QR + key. When the server has no device flow (or
 *              the start call fails) fall back to the manual copy: print the
 *              /enroll url and wait for a pasted cyg_ code; Enter skips the
 *              paste and just prints the links.
 *
 * This command is CHOOSER-ONLY: it takes no subcommands. The secret is the
 * base64url of the newest LIVE content generation's keyBytes
 * (sec.ts newestGen): the one secret the app needs for the sealed wire.
 * It is read-only for a running engine: only the data
 * dir's keys.json is touched, through the existing loadOrCreateE2E (0600,
 * atomic), so the command works whether the engine is up or stopped. Nothing
 * here writes the key to a file or a logbook; stdout is the only surface the
 * key ever reaches. CYC_DATA_DIR is the one override (datadir.ts).
 */

import { hostname } from "node:os";
import { readFileSync, readSync } from "node:fs";
import { createPrompt, useState, useKeypress, isEnterKey, isUpKey, isDownKey } from "@inquirer/core";
import qrcode from "qrcode-terminal";
import { b64urlencode } from "../../../shared/e2e";
import { enrollOnce, saveAppToken } from "./enroll";
import { loadOrCreateE2E, newestGen } from "./sec";
import { dataDir, stateFile } from "../storage/datadir.ts";
import { mkdirPrivateSync } from "../../../shared/runfiles.ts";
import { join } from "node:path";

// Final paths are undecided.
export const CLOUD_APP_URL = "https://app.callyourcode.com";
export const INSTALL_URL = "https://callyourcode.com/install.sh";

/** The hosted base the cloud onboarding talks to. CYC_CLOUD_URL exists for
 * tests (point the flow at a scratch app server); real runs use the one
 * hosted deployment. */
export function cloudBaseUrl(): string {
  return (process.env.CYC_CLOUD_URL ?? CLOUD_APP_URL).replace(/\/+$/, "");
}

export const DEFAULT_APP_URL = "http://127.0.0.1:10100";

/** The host label exactly as server.ts derives it: ENGINE_HOST or
 * os.hostname(), .local stripped, lowercased. */
export function engineHost(): string {
  return (process.env.ENGINE_HOST ?? hostname()).replace(/\.local$/, "").toLowerCase();
}

/** APP_SERVER_URL with a trailing slash stripped. The env var wins; when it is
 * absent, the value the running engine wrote at boot (state/app-server-url in
 * the data dir) is read, so an ssh shell that did not inherit the
 * launchd/systemd env still prints a phone-reachable url. Loopback 10100 is the
 * last resort. */
export function appServerUrl(file = stateFile("app-server-url")): string {
  if (process.env.APP_SERVER_URL) return process.env.APP_SERVER_URL.replace(/\/+$/, "");
  try {
    const fromFile = readFileSync(file, "utf8").trim();
    if (fromFile) return fromFile.replace(/\/+$/, "");
  } catch {
    /* no boot file yet: fall through to the loopback default */
  }
  return DEFAULT_APP_URL;
}

/** `<APP_URL>/?engine=<engineId>#pair=<key>`, both parts URL-encoded.
 *
 * THE KEY RIDES IN THE FRAGMENT, NEVER THE QUERY (security hardening). A
 * fragment is never sent on the wire, so the E2E root cannot land in server
 * or proxy access logs, browser history sync, or a Referer header -- and for
 * the cloud link it never reaches callyourcode.com, the party the E2E design
 * must exclude. The engine id is not a secret and stays in the query, where
 * the app's fleet-pin parsing already reads it. */
export function pairingUrl(appUrl: string, key: string, engineId: string): string {
  const base = appUrl.replace(/\/+$/, "");
  return `${base}/?engine=${encodeURIComponent(engineId)}#pair=${encodeURIComponent(key)}`;
}

export type PairFacts = { engineId: string; host: string; key: string; url: string };

/** Load (or create) the keys.json v3 state, then derive the pairing key and
 * url. Pure computation: no server, no port, no logbook. `dataDir` (or
 * CYC_DATA_DIR) points a test at a scratch dir so nothing touches the real
 * ~/.callyourcode; the engine id rides in the same file as the keys. */
export async function pairKeyFacts(
  opts: { dataDir?: string; appUrl?: string; host?: string } = {},
): Promise<PairFacts> {
  const base = (opts.dataDir ?? dataDir()).replace(/\/+$/, "");
  const appUrl = (opts.appUrl ?? appServerUrl(join(base, "state", "app-server-url"))).replace(/\/+$/, "");
  const host = opts.host ?? engineHost();

  // the data dir must exist before loadOrCreateE2E writes keys.json into it
  // (server.ts does the same via ensureBaseTree at boot).
  mkdirPrivateSync(base);

  const st = await loadOrCreateE2E(join(base, "keys.json"));
  const key = b64urlencode(newestGen(st).keyBytes);
  return { engineId: st.engineId, host, key, url: pairingUrl(appUrl, key, st.engineId) };
}

/** The terminal QR for a string. qrcode-terminal calls back synchronously. */
export function renderQr(text: string): string {
  let out = "";
  qrcode.generate(text, { small: true }, (qr: string) => {
    out = qr;
  });
  return out;
}

/** The local app base: the appServerUrl() base with a loopback host rewritten
 * to `localhost`, so the printed link is copy/paste-able on this machine.
 * Scheme and port are kept; the path is still added by pairingUrl(). */
export function localAppUrl(base: string = appServerUrl()): string {
  try {
    const u = new URL(base);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
      u.hostname = "localhost";
    }
    return u.toString().replace(/\/+$/, "");
  } catch {
    return base.replace(/\/+$/, "");
  }
}

type Choice = "local" | "cloud";

/** Read one line from `fd`, or "" on EOF. Used only for the non-interactive
 * chooser and the cloud paste prompt (both read plain stdin, fd 0). */
function readLineSync(fd: number): string {
  const buf = Buffer.alloc(1);
  let out = "";
  for (;;) {
    let n = 0;
    try {
      n = readSync(fd, buf, 0, 1, null);
    } catch {
      n = 0;
    }
    if (n <= 0) return out;
    const ch = buf.toString("utf8", 0, 1);
    if (ch === "\n" || ch === "\r") return out;
    out += ch;
  }
}

/** The chooser when stdin is not a TTY (tests, and the curl|sh installer):
 * print the two options and read one line. "1"/"local"/empty/EOF -> Local,
 * "2"/"cloud" -> Cloud. */
function chooseNonTty(): Choice {
  console.log("Local");
  console.log("All data stays on this machine.");
  console.log("Cloud");
  console.log("Access from anywhere: phone or your tablet, and all communication end-to-end encrypted.");
  process.stdout.write("Choice [1 Local / 2 Cloud] (default 1):");
  const line = readLineSync(0);
  process.stdout.write("\n");
  const v = line.trim().toLowerCase();
  return v === "2" || v === "cloud" ? "cloud" : "local";
}

/** A minimal radio selector: each option is its name with the explanation on
 * the line under it; up/down (or j/k) moves the dot, 1/2 jumps, Enter
 * confirms. @inquirer/core owns the tty and key handling (the hand-rolled
 * reader kept hitting ENXIO); only this plain render is ours. */
type RadioChoice = { value: Choice; label: string; detail: string };
const radioSelect = createPrompt<Choice, { message: string; choices: RadioChoice[] }>(
  (config, done) => {
    const [index, setIndex] = useState(0);
    const [picked, setPicked] = useState<Choice | null>(null);

    useKeypress((key) => {
      if (picked) return;
      if (isEnterKey(key)) {
        setPicked(config.choices[index].value);
        done(config.choices[index].value);
      } else if (isUpKey(key)) {
        setIndex(index === 0 ? config.choices.length - 1 : index - 1);
      } else if (isDownKey(key)) {
        setIndex(index === config.choices.length - 1 ? 0 : index + 1);
      } else if (/^[1-9]$/.test(key.name ?? "")) {
        const i = Number(key.name) - 1;
        if (i < config.choices.length) {
          setPicked(config.choices[i].value);
          done(config.choices[i].value);
        }
      }
    });

    if (picked) {
      const c = config.choices.find((x) => x.value === picked);
      return `${config.message} ${c ? c.label : String(picked)}`;
    }
    const body = config.choices
      .map((c, i) => `  ${i === index ? "●" : "◯"} ${c.label}\n      ${c.detail}`)
      .join("\n");
    return `${config.message}\n\n${body}\n`;
  },
);

/** The Local/Cloud chooser. On a real terminal: the radio selector above. With
 * no tty (tests, curl|sh): a one-line prompt that defaults to Local. */
async function choose(): Promise<Choice> {
  if (!process.stdin.isTTY) return chooseNonTty();
  try {
    return await radioSelect({
      message: "How should this machine be reached?",
      choices: [
        { value: "local", label: "Local", detail: "All data stays on this machine." },
        { value: "cloud", label: "Cloud", detail: "Access from anywhere: phone or your tablet, all communication end-to-end encrypted." },
      ],
    });
  } catch {
    process.exit(130); // Ctrl-C / cancel
  }
}

function printLocal(key: string, url: string): void {
  console.log();
  console.log(key);
  console.log(url);
  console.log("Run this again to switch.");
}

function printCloud(key: string, url: string): void {
  console.log(url);
  console.log(renderQr(url));
  console.log(key);
  console.log("Run this again to switch.");
}

/* ---------------------------------------- the cloud onboarding (see header)
 *
 * The engine never sees a Clerk JWT: the page authenticates the owner and
 * mints a one-time cyg_ grant (app-server/onboard.ts); the device-flow poll
 * (or, falling back, a paste) carries it here; enrollOnce presents it beside
 * the signed identity proof and the answer is the long-lived cyt_ token,
 * saved for the boot path server.ts already runs (loadAppToken against
 * APP_SERVER_URL). */

/** Poll cadence for the device flow. Env-dialable so a test does not wait
 *  wall-clock seconds; the default matches the server's suggested interval. */
const ENROLL_POLL_MS = Number(process.env.CYC_ENROLL_POLL_MS ?? 2000);

/** The opener for this box, or null when there is no way to show a browser
 *  (a headless linux box: no $BROWSER, no display). The platform openers are
 *  only used when a human is at the terminal (stdin is a TTY): a scripted or
 *  piped run must never pop a window. An explicit $BROWSER always wins. */
function browserCommand(): string[] | null {
  if (process.env.BROWSER) return [process.env.BROWSER];
  if (!process.stdin.isTTY) return null;
  if (process.platform === "darwin") return ["open"];
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return ["xdg-open"];
  return null;
}

/** Try to open `url` in the user's browser; false when the box has no way.
 *  Fire-and-forget: the url is ALWAYS printed too, so a browser that fails to
 *  appear costs nothing but the click the user makes instead. */
export function openInBrowser(url: string): boolean {
  const cmd = browserCommand();
  if (!cmd) return false;
  try {
    Bun.spawn([...cmd, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return true;
  } catch {
    return false;
  }
}

type DeviceStart = { device: string; code: string; expiresAt: number };

/** POST /enroll/device: a fresh device session, or null when the server does
 *  not offer the flow (LOCAL, an older deploy) or cannot be reached. Null
 *  sends the caller to the manual-paste fallback. */
async function startDeviceSession(base: string): Promise<DeviceStart | null> {
  try {
    const res = await fetch(`${base}/enroll/device`, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
    });
    const j = (await res.json().catch(() => null)) as any;
    if (!res.ok || typeof j?.device !== "string" || typeof j?.code !== "string") return null;
    const expiresAt = Number(j.expiresAt);
    return { device: j.device, code: j.code,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 10 * 60_000 };
  } catch {
    return null;
  }
}

/** Poll until the sign-in completes and the grant arrives, the session dies
 *  (404: expired or already drained), or the deadline passes. Transient
 *  errors keep polling: the deadline is the only clock. */
async function pollForGrant(base: string, d: DeviceStart): Promise<string | null> {
  while (Date.now() < d.expiresAt) {
    await Bun.sleep(ENROLL_POLL_MS);
    try {
      const res = await fetch(`${base}/enroll/device/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device: d.device }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) return null;
      const j = (await res.json().catch(() => null)) as any;
      if (res.ok && j?.status === "granted" && typeof j.grant === "string") return j.grant;
    } catch {
      /* transient (offline blip, server restart): the deadline decides */
    }
  }
  return null;
}

export async function runCloudOnboard(facts: PairFacts, base = cloudBaseUrl()): Promise<void> {
  let grant = "";
  const dev = await startDeviceSession(base);
  if (dev) {
    /* AUTO-RECEIVE (the default): open the sign-in page, poll for the grant. */
    const signInUrl = `${base}/enroll?code=${encodeURIComponent(dev.code)}`;
    console.log("Sign in with Google to link this machine to your account:");
    console.log();
    console.log(`  ${signInUrl}`);
    console.log();
    if (openInBrowser(signInUrl)) {
      console.log("Your browser should open; finish signing in there.");
    } else {
      console.log("Open that url in a browser (any device) to sign in.");
    }
    console.log("Waiting for sign-in to complete (Ctrl-C to abort)...");
    grant = (await pollForGrant(base, dev)) ?? "";
    console.log();
    if (!grant) {
      console.log("Sign-in did not complete in time. Run this again to retry.");
      process.exitCode = 1;
      console.log();
      printCloud(facts.key, pairingUrl(base, facts.key, facts.engineId));
      return;
    }
  } else {
    /* MANUAL FALLBACK: the original copy-paste flow. */
    console.log("Sign in with Google to link this machine to your account:");
    console.log();
    console.log(`  ${base}/enroll`);
    console.log();
    console.log("The page shows a one-time code after you sign in.");
    process.stdout.write("Paste the code here (Enter to skip): ");
    grant = readLineSync(0).trim();
    console.log();
    if (!grant) {
      console.log("No code pasted. Run this again to finish linking.");
      console.log();
      printCloud(facts.key, pairingUrl(base, facts.key, facts.engineId));
      return;
    }
  }

  const st = await loadOrCreateE2E(join(dataDir(), "keys.json"));
  const token = await enrollOnce(base, st, grant);
  if (token) {
    saveAppToken(stateFile("app-token.json"), base, token);
    console.log("Linked: this machine is enrolled with your account.");
    /* GO LIVE NOW, not after homework. The engine resolves its app-server
     * base from the token file just saved (announce.ts enrolledAppServerUrl),
     * so all it needs is a restart, and that is ours to do, not the user's. */
    if (await restartEngineService()) {
      console.log("The engine restarted and is connecting to your account now.");
    } else {
      console.log(`Restart the engine to go live: ${restartHint()}`);
    }
  } else {
    console.log("Enrollment failed: the code may be used, expired, or mistyped.");
    console.log("Run this again to get a fresh code.");
    process.exitCode = 1;
  }
  console.log();
  printCloud(facts.key, pairingUrl(base, facts.key, facts.engineId));
}

/** Bounce the installed engine service so a fresh enrollment takes effect.
 *  The names are the installer's own (scripts/install.sh): a systemd user
 *  unit on Linux, a LaunchAgent on macOS. Two refusals matter:
 *  - CYC_DATA_DIR set means a scoped instance (a test, a dev run): it does
 *    not own the machine's installed service, so touching it would bounce
 *    somebody else's engine. Never.
 *  - The service manager absent or refusing (a container, --local): false,
 *    and the caller prints the manual hint instead. */
export async function restartEngineService(
  run: (cmd: string[]) => Promise<number> = runQuiet,
): Promise<boolean> {
  if (process.env.CYC_DATA_DIR) return false;
  const cmd = process.platform === "darwin"
    ? ["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? 0}/com.callyourcode.agent-engine`]
    : ["systemctl", "--user", "restart", "cyc-agent-engine.service"];
  return (await run(cmd)) === 0;
}

function restartHint(): string {
  return process.platform === "darwin"
    ? "launchctl kickstart -k gui/$UID/com.callyourcode.agent-engine"
    : "systemctl --user restart cyc-agent-engine";
}

async function runQuiet(cmd: string[]): Promise<number> {
  try {
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return await p.exited;
  } catch {
    return -1;
  }
}

async function runChooser(): Promise<void> {
  const base = appServerUrl();
  const facts = await pairKeyFacts({ appUrl: base });
  const choice = await choose();
  if (choice === "cloud") {
    await runCloudOnboard(facts);
  } else {
    /* Local onboarding is engine-initiated too: open the pairing page (key in
     * the #fragment, so it never leaves this machine) in the local browser
     * when one exists; the printed link and key are the same either way. */
    const url = pairingUrl(localAppUrl(base), facts.key, facts.engineId);
    if (openInBrowser(url)) console.log("Opening the pairing page in your browser...");
    printLocal(facts.key, url);
  }
}

if (import.meta.main) {
  // Chooser-only: no subcommands. Any extra argv is ignored.
  await runChooser();
}
