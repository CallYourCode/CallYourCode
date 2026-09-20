/* Everything the page needs to know about the deployment: /config (the page
 * bootstrap), /hosts, /voice (the voice-engine pick) and /health.
 *
 * /config used to seed the engine list into localStorage from a constant baked
 * into the bundle, so adding a machine meant shipping a frontend. `engines` is
 * now ANNOUNCE-ONLY: every engine that has announced and is still inside its
 * lease, and nothing else. The app decides liveness by connecting to the ws;
 * each entry carries its engineId, host and user. */

import { json } from "../platform/httpx";
import { mintTurn, turnEnv, localIce, type IceServer } from "../../../engine/shared/turn";

/* LOCAL WebRTC traversal: our own turn-server (server/turn) reachable at the
 * box's tailnet host on TURN_PORT, minting against TURN_STATIC_SECRET. */
const TURN_HOST = process.env.TURN_HOST;
const TURN_PORT = Number(process.env.TURN_PORT ?? 3478);
const TURN_SECRET = process.env.TURN_STATIC_SECRET;
import type { EngineLeases } from "../engines/hosts";
import type { VoicePool } from "../engines/voice";
import type { Owners } from "../access/owners";
import type { OwnerStore } from "../access/owner-store";

/* ---------------------------------------------------- WebRTC traversal (rtc)
 *
 * Signaling is SAME-ORIGIN now: the relay is folded
 * onto this app-server (server.ts, the /engine and /device ws routes), so
 * /config no longer names a relay URL at all -- the app derives
 * `wss://<page-origin>/device?engine=<id>` from the origin it was served from,
 * and the engine dials `<app-server>/engine`. /config's only WebRTC job left is
 * the ICE list: which STUN/TURN servers to gather with.
 *
 * LOCAL emits an EMPTY list: a same-machine / tailscale dial gathers host
 * candidates (loopback, the tailnet IP) and needs no STUN or TURN, so local
 * stays iceServers []. HOSTED emits the STUN list (public data) plus, for an
 * authenticated caller when a coturn box is configured, per-owner TURN creds. */
const RTC_STUN_DEFAULT = "stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302";
const STUN_SERVERS: IceServer[] = (process.env.RTC_STUN ?? RTC_STUN_DEFAULT)
  .split(",").map((u) => u.trim()).filter(Boolean).map((u) => ({ urls: [u] }));
const TURN = turnEnv();

/** The rtc block one caller gets. LOCAL (`hosted` false) is always the empty
 *  list: host candidates alone connect on a trusted network. HOSTED emits STUN
 *  for everyone; `label` is the owner for the TURN username (never secret
 *  material), null means unauthenticated, so TURN creds are withheld. */
export function rtcBlock(hosted: boolean, label: string | null): Record<string, unknown> {
  // LOCAL: STUN (+TURN) at our own turn-server on the tailnet host. STUN gives a
  // tailnet client its tailscale IP so the direct pair forms (browser host
  // candidates are mDNS-hidden). Empty only when no turn host is configured.
  if (!hosted) return { iceServers: localIce(TURN_HOST, TURN_PORT, TURN_SECRET, label ?? "local") };
  const iceServers: IceServer[] = [...STUN_SERVERS];
  if (TURN && label !== null) iceServers.push(mintTurn(TURN, label));
  return { iceServers };
}

/* The engine-relative voice base for one agent engine ws URL: the same origin
 * over http(s), plus /voice. The app swaps from the picked voice engine's
 * publicUrl to its OWN engine's /voice origin (voice-through-engine). */
export function voiceBaseOf(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "/voice";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export type ConfigDeps = {
  hosted: boolean;
  leases: EngineLeases;
  voice: VoicePool;
  sessionSub: Owners["sessionSub"];
  /** LOCAL: the single store (device count for /health); HOSTED: null. */
  localStore: OwnerStore | null;
  ownerCount(): number;
  distDir: string;
};

export function makeConfigRoutes(deps: ConfigDeps) {
  const { hosted, leases, voice } = deps;

  return async (req: Request, path: string, url: URL): Promise<Response | null> => {
    if (path === "/hosts") {
      const live = await leases.list();
      return json(leases.hostsPayload(live));
    }

    if (path === "/config") {
      const live = await leases.list();
      /* The page bootstrap stays PUBLIC: `auth` and the publishable key must
       * reach a phone that has not signed in yet. The engines list, however, is
       * owner data in HOSTED, so it is scoped to the caller's session when one
       * is present and otherwise empty -- never another owner's announced
       * engine. The session is resolved ONCE here:
       * the engine scoping and the rtc block (TURN creds are per-owner) both
       * hang off it. */
      const sub = hosted ? await deps.sessionSub(req) : null;
      const own = !hosted ? live : sub ? live.filter((e) => e.owner === sub) : [];
      const pick = await voice.pick("stream");
      /* `engines` is the caller's OWN leased engines (owner-scoped in HOSTED;
       * the full leased list in LOCAL), each a {url, engineId, host, user}
       * object so the app can match a pairing URL's ?engine=<engineId> and
       * build the handshake's user@host. Announce-only: no seed strings. */
      const configEngines = leases.configEngines(own);
      const engineUrls = configEngines.map((e) => e.url);
      return json({
        engines: configEngines,
        voice: pick?.publicUrl ?? null,
        voiceLabel: pick?.label ?? null,
        auth: hosted ? "clerk" : "none",
        ...(hosted && process.env.CLERK_PUBLISHABLE_KEY
          ? { clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY }
          : {}),
        /* voice-through-engine: each agent engine's own origin + /voice, in the
         * SAME order as `engines` (the leased list), so the
         * app can reach STT/TTS through the engine it is already talking to. */
        voiceBases: engineUrls.map(voiceBaseOf),
        /* WebRTC traversal: empty in LOCAL (host
         * candidates connect); in HOSTED the STUN list for everyone plus TURN
         * creds for an authenticated caller when a coturn box is configured.
         * Signaling is same-origin (/device), derived by the app from the page
         * origin, so no relay URL rides here. */
        rtc: rtcBlock(hosted, hosted ? sub : "local"),
      });
    }

    // Which voice engine should this device use? One decision, made here,
    // from published health: idle beats busy, then measured speed.
    if (path === "/voice") {
      const role = (url.searchParams.get("role") ?? "stream") as any;
      const pick = await voice.pick(role);
      return json({
        url: pick?.publicUrl ?? null,
        label: pick?.label ?? null,
        role,
        engines: voice.list().map((e) => ({
          label: e.label,
          url: e.publicUrl,
          up: e.up,
          can: e.can,
          rtf: e.rtf,
          load: e.load,
          error: e.error,
        })),
      });
    }

    if (path === "/health") {
      await voice.refresh();
      return json({
        ok: true,
        mode: hosted ? "hosted" : "local",
        devices: deps.localStore ? deps.localStore.push.count : deps.ownerCount(),
        dist: deps.distDir,
        voice: voice.list().map((e) => ({ label: e.label, up: e.up, load: e.load, rtf: e.rtf })),
      });
    }

    return null;
  };
}
