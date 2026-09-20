/* The app server: the page, and everything that belongs to the DEVICE.
 *
 * The split (see the module banners for the full argument):
 *   voice engine   speech in and out, local to a machine
 *   agent engine   one per host, talks to that host's sessions
 *   app server     THIS: serves the page and owns everything device-shaped
 *
 * The browser subscribes for push here, same origin as the page, so there is
 * no CORS grant at all (and a disallowed browser Origin is refused before any
 * route; platform/httpx.ts). An engine that wants to notify posts to
 * /push/notify with its issued per-engine token; it never
 * sees a subscription, and this server maps token -> {engineId, owner}, so no
 * engine can announce or push into another owner's account.
 *
 *   VOICE_ENGINES comma separated "url|publicUrl|label" (see voice.ts)
 *   APP_PORT      (10100)
 *   DIST_DIR      the built frontend to serve
 *   VAPID_*       optional pinned pair; generated and stored otherwise
 *
 * THIS FILE IS THE COMPOSITION ROOT and nothing else: env and paths, the
 * singletons, the wiring of each route family, and Bun.serve. The behaviour
 * lives in the modules (layered, imports pointing inward only):
 *
 *   routes/*        the HTTP surface, one family per file
 *   owners.ts       how a request finds its owner (device session / engine token)
 *   owner-store.ts  one owner's world: push store, settings, badge, out-window
 *   reports.ts      bug-report ids, files and the reap
 *   static.ts       CSP + security headers + the static file answers
 *   ratelimit.ts    the rolling-minute buckets
 *   httpx.ts        the browser-origin gate, json, engine body reads
 *   caps.ts         every ceiling, in one place
 */

import { join } from "node:path";
import { dataDir } from "../../../engine/shared/cycdir.ts";
import { openLog } from "../../../engine/shared/logbook.ts";
import { mkdirPrivate, repairRunTree } from "../../../engine/shared/runfiles.ts";
import { HOSTED, modeLine } from "../access/auth";
import { VoicePool } from "../engines/voice";
import { EngineLeases, LEASE_DEFAULT_MS } from "../engines/hosts";
import { EngineTokens } from "../access/enroll";
import { EnrollDevices, EnrollGrants } from "../access/grants";
import { onboardRoutes } from "../onboarding/onboard";
import { OwnerStore } from "../access/owner-store";
import { makeOwners } from "../access/owners";
import { clientKeyOf } from "../platform/ratelimit";
import { refuseForbiddenHost, refuseForbiddenOrigin } from "../platform/httpx";
import { serveStatic, DOC_SECURITY_HEADERS, BASE_SECURITY_HEADERS } from "../platform/static";
import { Relay, mintConnId, type RelayWsData } from "../delivery/relay";
import { mintTurn, turnEnv, localIce, type IceServer } from "../../../engine/shared/turn";
import { resolvePorts } from "../../../engine/shared/ports.ts";
import { makeClientlogRoute } from "../routes/clientlog";
import { makeReportRoutes } from "../routes/reports";
import { makePushRoutes } from "../routes/push";
import { makeSettingsRoutes } from "../routes/settings";
import { makeConfigRoutes } from "../routes/config";
import { makeEngineRoutes } from "../routes/engines";

/* This server's own decisions, and the BROWSER'S: every line the page writes
 * is posted to /clientlog and appended to the shared log dir's app.log
 * (shared/cycdir.ts logsDir), next to engine.log, so the three services are
 * greppable together on one cid. */
const LOG = openLog("app-server");
const APPLOG = openLog("app");
const log = (event: string, fields: Record<string, unknown>) => LOG.line(event, fields);

/* ------------------------------------------------------------ env + paths
 * The store paths are overridable so a second app server (a test one, or a
 * spare on another port) can NEVER write to the stores that hold the real
 * phone. Resolved at module load: tests set them before spawning.
 *
 * The defaults live under the per-user data dir (shared/cycdir.ts:
 * ~/.callyourcode/app-server), like the engine's, NOT the repo .run: a
 * redeploy rsync excluded .run and silently stranded the VAPID keys, push
 * subscriptions and engine tokens with the old checkout. */
/* The port scheme (CYC_PORT_BASE) lives in shared/ports.ts so all four
 * services move together under one knob; the individual vars still win. */
const PORTS = resolvePorts(process.env);
const PORT = PORTS.APP_PORT;
const HOST = process.env.APP_HOST ?? "127.0.0.1";
const DIST_DIR = (process.env.DIST_DIR ??
  new URL("../../app/dist", import.meta.url).pathname).replace(/\/$/, "");
const STATE_DIR = join(dataDir(), "app-server");
const PUSH_FILE = process.env.PUSH_FILE ?? join(STATE_DIR, "push-subs.json");
const ENGINE_TOKENS_FILE = process.env.ENGINE_TOKENS_FILE ?? join(STATE_DIR, "engine-tokens.json");
const SETTINGS_FILE = process.env.SETTINGS_FILE ?? join(STATE_DIR, "app-settings.json");
const REPORTS_DIR = (process.env.REPORTS_DIR ?? join(STATE_DIR, "reports")).replace(/\/$/, "");
const LEASES_FILE = process.env.ENGINE_LEASES_FILE ?? join(STATE_DIR, "engine-leases.json");
const ENGINE_LEASE_MS = Number(process.env.ENGINE_LEASE_MS ?? LEASE_DEFAULT_MS);
const OWNERS_DIR = (process.env.OWNERS_DIR ?? join(STATE_DIR, "owners")).replace(/\/$/, "");

/* Tests override the stores onto scratch paths. Walking the default state dir
 * in that case would chmod the real per-user tree, which a test must never
 * touch. Production leaves those unset and repairs the real tree. */
const scratchStores = !!(process.env.PUSH_FILE || process.env.SETTINGS_FILE ||
  process.env.REPORTS_DIR || process.env.CYC_LOG_DIR || process.env.OWNERS_DIR ||
  process.env.ENGINE_LEASES_FILE || process.env.ENGINE_TOKENS_FILE);
if (!scratchStores) {
  await mkdirPrivate(STATE_DIR);
  await repairRunTree(STATE_DIR);
}

/* In HOSTED there is one push identity for the whole server: the pinned VAPID
 * pair. If it is unset, /push/key serves an empty key while each owner's store
 * silently generates its own random pair, so push breaks with no error. Refuse
 * to boot instead, naming both vars, so a misconfigured host fails loudly. */
if (HOSTED && !(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)) {
  console.error(
    "FATAL: HOSTED mode requires both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY " +
    "to be set (they are the server's shared push identity); refusing to boot.",
  );
  process.exit(1);
}

/* A HOSTED deploy fronts this server on a real public domain, which the
 * host-header gate (platform/httpx.ts) only allows when APP_SERVER_URL names
 * it (the loopback/own-machine/tailnet allowances never cover a cloud front).
 * Unset, every browser request would 403 on the Host gate; refuse to boot
 * loudly instead, the same way the missing VAPID pair does. LOCAL needs
 * nothing: loopback and the machine's own tailnet name are allowed as-is. */
if (HOSTED && !process.env.APP_SERVER_URL) {
  console.error(
    "FATAL: HOSTED mode requires APP_SERVER_URL to name this server's public " +
    "URL (the host-header gate refuses every unrecognized Host); refusing to boot.",
  );
  process.exit(1);
}

/* ------------------------------------------------------------- singletons */
const leases = await EngineLeases.open(LEASES_FILE, ENGINE_LEASE_MS);
const engineTokens = await EngineTokens.open(ENGINE_TOKENS_FILE);
/* One-time cyg_ onboarding grants (grants.ts): minted only by the Clerk-gated
 * /enroll/grant route (onboard.ts), redeemed once by /engines/enroll.
 * In-memory: a grant lives minutes, a restart only reloads the page. */
const enrollGrants = new EnrollGrants();
/* Device sessions for the auto-receive flow (grants.ts): started by the
 * engine, granted by the page, drained by the engine's poll. In-memory too. */
const enrollDevices = new EnrollDevices();
// Voice engines, chosen by measurement rather than by whoever answers first.
const voice = new VoicePool(
  // The default names the resolved voice port (CYC_PORT_BASE moves it), so a
  // based install points at its own voice engine, not a hardcoded 10102.
  process.env.VOICE_ENGINES ??
    `http://127.0.0.1:${PORTS.VOICE_PORT}|http://127.0.0.1:${PORTS.VOICE_PORT}|this machine`,
);
/* LOCAL: the one owner store, at the same paths as always. HOSTED: none;
 * owners.ts opens one per Clerk sub under OWNERS_DIR. An empty engine-token
 * store verifies NOTHING, so a fresh HOSTED deploy fails closed by
 * construction rather than by a boot check. */
const localStore: OwnerStore | null = HOSTED
  ? null
  : await OwnerStore.open(PUSH_FILE, SETTINGS_FILE, REPORTS_DIR, log);
const owners = makeOwners({ hosted: HOSTED, localStore, ownersDir: OWNERS_DIR,
  engineTokens, log });

/* ------------------------------------------------------------ route wiring */
const clientlogRoute = makeClientlogRoute({ hosted: HOSTED,
  deviceOwner: owners.deviceOwner, log, applog: APPLOG });
const reportRoutes = makeReportRoutes({ deviceOwner: owners.deviceOwner, log });
const pushRoutes = makePushRoutes({ owners, log });
const settingsRoutes = makeSettingsRoutes({ hosted: HOSTED, owners, log });
const configRoutes = makeConfigRoutes({ hosted: HOSTED, leases, voice,
  sessionSub: owners.sessionSub,
  localStore, ownerCount: owners.ownerCount, distDir: DIST_DIR });
const engineRoutes = makeEngineRoutes({ hosted: HOSTED, engineTokens,
  enrollGrants, leases, engineLeaseMs: ENGINE_LEASE_MS,
  sessionSub: owners.sessionSub, engineAuth: owners.engineAuth, log });

/* ------------------------------------------------------ signaling relay
 * The rtc-* signaling relay is FOLDED onto this app-server so signaling is
 * SAME-ORIGIN (this one port) for local, tailscale and hosted alike: an engine
 * registers its one outbound socket at /engine, a device opens a signaling
 * attempt at /device, and the Relay core (relay.ts) forwards each side's
 * frames BLINDLY -- it parses only its own envelope, never a device frame, and
 * carries no content (the sealed DataChannel it negotiates does that). The
 * The former standalone relay introspected cyt_ tokens over HTTP and
 * minted TURN creds; both move here, in-process.
 *
 * ICE for the ENGINE leg (r-open): empty in LOCAL (host candidates connect),
 * the STUN list plus per-attempt TURN in HOSTED -- the mirror of /config's
 * rtcBlock, so both ends gather with the same servers. */
const RTC_STUN_DEFAULT = "stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302";
const RELAY_STUN: IceServer[] = (process.env.RTC_STUN ?? RTC_STUN_DEFAULT)
  .split(",").map((u) => u.trim()).filter(Boolean).map((u) => ({ urls: [u] }));
const RELAY_TURN = turnEnv();
const TURN_HOST = process.env.TURN_HOST;
const TURN_PORT = PORTS.TURN_PORT;
const TURN_SECRET = process.env.TURN_STATIC_SECRET;
const rtcFor = (engineId: string) => ({
  iceServers: HOSTED
    ? [...RELAY_STUN, ...(RELAY_TURN ? [mintTurn(RELAY_TURN, engineId)] : [])]
    : localIce(TURN_HOST, TURN_PORT, TURN_SECRET, engineId),
});
const relay = new Relay((event, fields) => log(event, fields), rtcFor);

const server = Bun.serve<RelayWsData>({
  port: PORT,
  hostname: HOST,
  // The proxy in front of the engine's voice-note upload: match the engine's
  // 320MB body allowance or a 300MB note dies here with the engine never asked.
  maxRequestBodySize: 320 * 1024 * 1024,
  async fetch(req, srv) {
    /* THE HOST GATE, before anything at all (platform/httpx.ts). A request
     * whose Host header is not a name this server is legitimately reached by
     * (loopback, the bound address, this machine's own/tailnet name, a
     * configured APP_SERVER_URL front) is a DNS-rebound page: it arrives from
     * a loopback peer with NO Origin, or with an Origin whose host EQUALS its
     * attacker Host -- the one shape the same-origin rule below would have
     * accepted. Refused outright; a missing Host fails closed. It runs before
     * the `new URL(req.url)` parse because a no-Host HTTP/1.0 request arrives
     * with a relative req.url that parse would throw on. */
    const badHost = refuseForbiddenHost(req);
    if (badHost) return badHost;

    const url = new URL(req.url);
    const path = url.pathname;

    /* THE BROWSER ORIGIN GATE, before any route (platform/httpx.ts). A request
     * carrying a disallowed Origin is a web page reaching into this server
     * cross-origin (the shape that could mint and READ a cyt_ bearer off the
     * LOCAL-open /engines/enroll when CORS was a wildcard); it is refused
     * outright. Same-origin pages, loopback-hosted pages, and every no-Origin
     * caller (engines, the CLI) pass untouched -- and the same-origin compare
     * is anchored now: the Host it compares against already passed the host
     * gate above. */
    const badOrigin = refuseForbiddenOrigin(req);
    if (badOrigin) return badOrigin;

    if (req.method === "OPTIONS") return new Response(null, { status: 204 });

    /* SIGNALING RELAY (folded on, same origin). Authentication happens HERE at
     * upgrade because it is HTTP; the engine/owner MATCH happens in relay.open,
     * after upgrade, so a wrong engineId answers a ws close code and never an
     * enumerable HTTP error.
     *
     *   /engine  the engine's one outbound socket. HOSTED auths it by its issued
     *            cyt_ bearer (introspected in-process against the enroll store).
     *            LOCAL is open on the trusted network: the engineId rides ?engine=
     *            and the owner is "local".
     *   /device  one socket per device signaling attempt, ?engine=<engineId>.
     *            HOSTED requires the caller's Clerk session AND that the session's
     *            owner OWNS that engine (same scoping /config applies to the
     *            engine list). LOCAL is open. Either way the device-key nonce
     *            challenge over the socket, verified by the ENGINE, is the real
     *            proof; the relay itself stays blind. */
    if (path === "/engine") {
      let engineId: string;
      let owner: string;
      if (HOSTED) {
        const authz = req.headers.get("authorization") ?? "";
        const bearer = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
        const rec = engineTokens.verify(bearer || null);
        if (!rec) return new Response(JSON.stringify({ error: "unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } });
        engineId = rec.engineId;
        owner = rec.owner;
      } else {
        engineId = (url.searchParams.get("engine") ?? "").slice(0, 100).trim();
        if (!engineId) return new Response(JSON.stringify({ error: "engine required" }),
          { status: 400, headers: { "content-type": "application/json" } });
        owner = "local";
      }
      const data: RelayWsData = { relay: "engine", engineId, owner };
      return srv.upgrade(req, { data }) ? undefined : new Response("upgrade required", { status: 426 });
    }

    if (path === "/device") {
      const engineId = (url.searchParams.get("engine") ?? "").slice(0, 100).trim();
      if (!engineId) return new Response(JSON.stringify({ error: "engine required" }),
        { status: 400, headers: { "content-type": "application/json" } });
      if (HOSTED) {
        const sub = await owners.sessionSub(req);
        if (!sub) return new Response(JSON.stringify({ error: "unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } });
        /* Owner scope: a caller may only signal an engine they own. The lease
         * owner is the engine's Clerk sub in HOSTED (routes/engines.ts), the
         * exact scoping /config filters the engine list by. */
        const mine = (await leases.list()).some((e) => e.engineId === engineId && e.owner === sub);
        if (!mine) return new Response(JSON.stringify({ error: "forbidden" }),
          { status: 403, headers: { "content-type": "application/json" } });
      }
      const data: RelayWsData = { relay: "device", engineId, connId: mintConnId() };
      return srv.upgrade(req, { data }) ? undefined : new Response("upgrade required", { status: 426 });
    }

    const answered =
      (await clientlogRoute(req, path, srv)) ??
      (await reportRoutes(req, path)) ??
      (await pushRoutes(req, path)) ??
      (await settingsRoutes(req, path)) ??
      (await configRoutes(req, path, url)) ??
      (await engineRoutes(req, path));
    if (answered) return answered;

    /* CLOUD ONBOARDING (onboard.ts): the /enroll page, its same-origin
     * script, the Clerk-gated grant mint, and the device-flow endpoints. */
    if (path === "/enroll" || path === "/enroll.js" || path.startsWith("/enroll/")) {
      const r = await onboardRoutes(req, path, {
        hosted: HOSTED, grants: enrollGrants, devices: enrollDevices,
        sessionSub: owners.sessionSub,
        docHeaders: DOC_SECURITY_HEADERS, baseHeaders: BASE_SECURITY_HEADERS,
        log,
        rateKey: (r) => clientKeyOf(r, srv),
      });
      if (r) return r;
    }

    if (req.method === "GET") return serveStatic(DIST_DIR, path);
    return new Response("not found", { status: 404 });
  },
  /* The relay's two ws legs (/engine, /device). Data was stamped at upgrade
   * above; the Relay core does the matching and the blind forwarding. */
  websocket: {
    open(ws) { relay.open(ws); },
    message(ws, raw) { relay.message(ws, typeof raw === "string" ? raw : new Uint8Array()); },
    close(ws) { relay.close(ws); },
  },
});

LOG.line("boot", { url: `http://${HOST}:${server.port}`, dist: DIST_DIR,
  mode: HOSTED ? "hosted" : "local",
  devices: localStore ? localStore.push.count : 0, engines: engineTokens.count,
  clientLog: APPLOG.path, reports: REPORTS_DIR });
console.log(`app-server   http://${HOST}:${server.port}`);
console.log(`  serving    ${DIST_DIR}`);
console.log(`  ${modeLine()}`);
if (localStore) {
  console.log(`  push       ${localStore.push.count} device(s)`);
} else {
  console.log(`  push       per-owner under ${OWNERS_DIR}`);
}
console.log(`  engines    ${engineTokens.count} enrolled (push/announce require an issued token)`);
console.log(`  signaling  same-origin relay (engine leg /engine, device leg /device)`);
