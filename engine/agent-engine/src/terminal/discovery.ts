/* The engine announces itself to the app server and keeps it fresh.
 *
 * Discovery is the engine reaching OUT, not the app server reaching IN. On boot
 * and every HEARTBEAT_MS the engine POSTs /engines/announce; the app server
 * stores a lease and drops it when the engine goes quiet past the lease. The
 * app decides liveness by connecting to the ws url, never by a verdict somebody
 * else computed.
 *
 * Everything here is a pure-ish helper so a unit test can prove the payload
 * without booting a whole engine. The stable per-install id lives in the data
 * dir's keys.json now (sec.ts), not in a file of its own.
 */

export const HEARTBEAT_DEFAULT_MS = 5 * 60_000;

export type Announce = {
  engineId: string;
  host: string;
  user: string;
  url: string;
  rev: string;
  ts: number;
};

/** The exact body POSTed to /engines/announce. `ts` defaults to now. */
export function announceBody(
  engineId: string,
  host: string,
  user: string,
  url: string,
  rev: string,
  ts = Date.now(),
): Announce {
  return { engineId, host, user, url, rev, ts };
}

/** The engine's own ws url, the one a browser should dial.
 *
 * An explicit ENGINE_WS_URL wins (the deployment knows the reachable name the
 * engine cannot derive for itself). Otherwise ENGINE_PUBLIC_URL (https, for the
 * icons the OS fetches) is rewritten to the matching ws scheme with /ws on it;
 * and with neither, the loopback default is exactly what a single-machine
 * install wants. */
export function deriveWsUrl(host: string, port: number, publicUrl = ""): string {
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      const proto = u.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${u.host}${u.pathname.replace(/\/+$/, "")}/ws`;
    } catch {
      /* not a URL: fall through to the loopback default */
    }
  }
  return `ws://${host}:${port}/ws`;
}

/** One announce POST, bearing the engine's ISSUED token (the shared
 *  PUSH_TOKEN is gone). Returns {ok, status}: status 0 means there
 *  was no app server to tell or it was unreachable; a 401 tells the caller
 *  the token is dead and re-enrollment is due. Never throws -- the engine
 *  must keep running either way. */
export async function announceOnce(
  appServerUrl: string,
  payload: Announce,
  engineToken = "",
): Promise<{ ok: boolean; status: number }> {
  if (!appServerUrl) return { ok: false, status: 0 };
  try {
    const res = await fetch(`${appServerUrl}/engines/announce`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(engineToken ? { authorization: `Bearer ${engineToken}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[discovery] announce ${payload.engineId} REFUSED http ${res.status}`);
      return { ok: false, status: res.status };
    }
    console.log(`[discovery] announce ${payload.engineId} accepted (${payload.url})`);
    return { ok: true, status: res.status };
  } catch (e) {
    console.warn(`[discovery] announce ${payload.engineId} FAILED: ${(e as Error)?.message}`);
    return { ok: false, status: 0 };
  }
}
