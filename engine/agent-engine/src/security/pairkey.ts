import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import qrcode from "qrcode-terminal";
import { b64urlencode } from "../../../shared/e2e";
import { loadOrCreateE2E, newestGen } from "./sec";
import { dataDir, stateFile } from "../storage/datadir.ts";
import { mkdirPrivateSync } from "../../../shared/runfiles.ts";
import { join } from "node:path";

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

/** The tailnet https base for the LOCAL pairing link, or null for the plain
 *  localhost link. When tailscale runs on this machine, `tailscale serve` puts
 *  the app on https://<machine>.<tailnet>.ts.net with a real certificate,
 *  which the phone wants anyway: PWA install, the mic and the service worker
 *  all need a secure context, and localhost is not one from another device.
 *  Simple by order (Shikher, 2026-09-22): tailscale present -> try the serve;
 *  can't -> say why and fall back to the localhost link. The only silent
 *  refusals are the ones with nothing to tell a user: a scoped instance
 *  (CYC_DATA_DIR: a test or dev run must never rewrite the machine's serve
 *  config), an operator-chosen non-loopback base, and no tailscale at all. */
export async function tailnetServeBase(
  base: string,
  run: (cmd: string[]) => Promise<{ code: number; out: string }> = runOut,
  say: (line: string) => void = () => {},
  /* Called with tailscale's enable-serve approval link when the tailnet
   * needs a one-time admin OK. Answer true to retry the serve, false to
   * fall back. No `ask` (tests, non-tty) falls back straight away. */
  ask?: (enableUrl: string) => Promise<boolean>,
  probeFn: (url: string) => Promise<boolean> = probe,
): Promise<string | null> {
  const skip = (why: string): null => {
    say(`tailscale skipped: ${why} (using the localhost link)`);
    return null;
  };
  if (process.env.CYC_DATA_DIR) return null;
  let u: URL;
  try { u = new URL(base); } catch { return null; }
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return null;
  if (!u.port) return null;
  const present = await run(["tailscale", "version"]);
  if (present.code !== 0) return null; // no tailscale on this machine: nothing to say
  /* Tailnet features (Serve, HTTPS certificates) each need a one-time admin
   * approval, and tailscale's error hands back the approval link. Walk the
   * user through it right here (live 2026-09-22: burying the link in a
   * fallback line made a working setup look broken) and retry once they say
   * it is enabled. */
  const withApproval = async (cmd: string[]) => {
    let r = await run(cmd);
    const link = r.code !== 0 ? r.out.match(/https:\/\/login\.tailscale\.com\/\S+/) : null;
    if (link && ask) {
      while (r.code !== 0 && (await ask(link[0]))) r = await run(cmd);
    }
    return r;
  };
  const served = await withApproval(["tailscale", "serve", "--bg", u.port]);
  if (served.code !== 0) return skip(`\`tailscale serve --bg ${u.port}\` failed: ${served.out.trim().slice(0, 200) || "no output"}`);
  const st = await run(["tailscale", "status", "--json"]);
  let dns = "";
  if (st.code === 0) {
    try {
      /* A version-skewed tailscale prints warning lines around the JSON;
       * parse from the first brace so a warning never hides the name. */
      const j = JSON.parse(st.out.slice(st.out.indexOf("{"))) as { Self?: { DNSName?: string } };
      dns = (j?.Self?.DNSName ?? "").replace(/\.+$/, "");
    } catch { /* fall through to the skip below */ }
  }
  if (!dns) return skip("served, but no tailnet machine name found");
  /* Serve accepting the port is NOT a working link (live 2026-09-22: the
   * printed link answered TLS internal errors because the tailnet's HTTPS
   * certificates toggle was off, a separate approval from Serve). Mint the
   * certificate now, walking through its approval link the same way, then
   * prove the page answers before the link is ever printed. */
  const cert = await withApproval(["tailscale", "cert", "--cert-file", "/dev/null", "--key-file", "/dev/null", dns]);
  if (cert.code !== 0 && /login\.tailscale\.com/.test(cert.out)) {
    return skip(
      "the tailnet's HTTPS Certificates toggle is off; enable it at" +
      " https://login.tailscale.com/admin/dns and rerun",
    );
  }
  /* Any other cert stumble (slow first mint, version skew) is not a verdict;
   * the probe below is. A first Let's Encrypt mint can take a minute. */
  const answers = await probeFn(`https://${dns}/`);
  if (!answers) return skip(`https://${dns}/ is served but not answering; the https certificate may still be minting -- rerun in a minute`);
  return `https://${dns}`;
}

/* The final proof: the link cyc pair prints must actually answer. Certificate
 * minting can lag a few seconds behind `tailscale cert`, so poll briefly. */
async function probe(url: string, tries = 5, fetcher: typeof fetch = fetch): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetcher(url, { signal: AbortSignal.timeout(5_000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 2_000));
  }
  return false;
}

/* Hard cap on every tailscale call. `tailscale serve` can sit waiting on
 * interactive input (enable-HTTPS prompts and the like); with stdin ignored
 * that is a forever-hang, and it froze a live `cyc pair` on 2026-09-22. */
const RUN_CAP_MS = 15_000;

async function runOut(cmd: string[]): Promise<{ code: number; out: string }> {
  try {
    // stderr rides along so a failed command's reason survives into the skip line.
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, RUN_CAP_MS);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(timer);
    if (code !== 0) {
      const detail = `${out}\n${err}`.trim();
      return { code, out: detail || `timed out or was killed after ${RUN_CAP_MS / 1000}s` };
    }
    return { code, out };
  } catch {
    return { code: -1, out: "" };
  }
}

async function runPair(): Promise<void> {
  const base = appServerUrl();
  const facts = await pairKeyFacts({appUrl: base});
  const tail = await tailnetServeBase(base, undefined, console.log);
  const url = pairingUrl(tail ?? localAppUrl(base), facts.key, facts.engineId);
  console.log("Open locally or on your Tailscale network, or scan:");
  console.log(url);
  console.log(renderQr(url));
  console.log(facts.key);
  if (openInBrowser(url)) console.log("Opening the pairing page in your browser...");
}
if (import.meta.main) await runPair();
