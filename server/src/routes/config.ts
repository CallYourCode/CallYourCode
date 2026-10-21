/* Everything the page needs to know about the deployment: /config (the page
 * bootstrap), /hosts, /voice (the voice-engine pick) and /health.
 *
 * /config used to seed the engine list into localStorage from a constant baked
 * into the bundle, so adding a machine meant shipping a frontend. `engines` is
 * now ANNOUNCE-ONLY: every engine that has announced and is still inside its
 * lease, and nothing else. The app decides liveness by connecting to the ws;
 * each entry carries its engineId, host and user. */

import { json } from "../platform/httpx";
import type { EngineLeases } from "../engines/hosts";
import type { VoicePool } from "../engines/voice";
import type { OwnerStore } from "../access/owner-store";

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
  leases: EngineLeases;
  voice: VoicePool;

  localStore: OwnerStore | null;
  distDir: string;
};

export function makeConfigRoutes(deps: ConfigDeps) {
  const { leases, voice } = deps;

  return async (req: Request, path: string, url: URL): Promise<Response | null> => {
    if (path === "/hosts") {
      const live = await leases.list();
      return json(leases.hostsPayload(live));
    }

    if (path === "/config") {
      const live = await leases.list();
      const pick = await voice.pick("stream");

      const configEngines = leases.configEngines(live);
      const engineUrls = configEngines.map((e) => e.url);
      return json({
        engines: configEngines,
        voice: pick?.publicUrl ?? null,
        voiceLabel: pick?.label ?? null,
        auth: "none",
        /* voice-through-engine: each agent engine's own origin + /voice, in the
         * SAME order as `engines` (the leased list), so the
         * app can reach STT/TTS through the engine it is already talking to. */
        voiceBases: engineUrls.map(voiceBaseOf),

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
        mode: "local",
        devices: deps.localStore?.push.count ?? 0,
        dist: deps.distDir,
        voice: voice.list().map((e) => ({ label: e.label, up: e.up, load: e.load, rtf: e.rtf })),
      });
    }

    return null;
  };
}
