/* Engine discovery for pairing entry points.
 *
 * The signal already exists on the wire: /config's `engines` list is
 * ANNOUNCE-ONLY (every engine that told the app server it is alive, contract
 * 04), and the keyring knows which userHosts this device holds an E2E key
 * for. "Known but not paired" is the difference of the two; nothing new
 * crosses the wire and the app server never sees key material.
 *
 * The screen, the conversation-list banner and the settings Engines section
 * all derive from this one module so their notions of "paired" cannot drift.
 */

import {
  configuredEngines,
  onConfiguredEngines,
  loadAppConfig,
  type AppEngineInfo
} from '@/engine/contract';
import * as keyring from '@/engine/keyring';

/** The userHost the E2E handshake mapped this url to (sync/connection.ts
 *  writes it), so an engine announced under a fresh host name still counts
 *  as paired when its key is held under the mapped name. */
export function mappedUserHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return localStorage.getItem('cyc:e2e:uh:' + url);
  } catch {
    return null;
  }
}

/** Does this device hold an E2E key for the engine at userHost/url? */
export function userHostPaired(userHost: string, url: string | null, paired: Set<string>): boolean {
  if (paired.has(userHost)) return true;
  const mapped = mappedUserHost(url);
  return !!(mapped && paired.has(mapped));
}

export type KnownEngines = {paired: AppEngineInfo[]; unpaired: AppEngineInfo[]};

/** Every engine the app server announced, split by whether this device holds
 *  its E2E key. `unpaired` drives the pair affordances. */
export async function knownEngines(): Promise<KnownEngines> {
  const pairedSet = await keyring.pairedUserHosts();
  const paired: AppEngineInfo[] = [];
  const unpaired: AppEngineInfo[] = [];
  for (const e of configuredEngines()) {
    (userHostPaired(e.userHost, e.url || null, pairedSet) ? paired : unpaired).push(e);
  }
  return {paired, unpaired};
}

/** Fires when either half of the split can have changed: a new /config
 *  ingested, or the keyring gained/lost a key. */
export function onKnownEnginesChange(fn: () => void): () => void {
  const offConfig = onConfiguredEngines(fn);
  const offKeys = keyring.onKeyringChange(fn);
  return () => {
    offConfig();
    offKeys();
  };
}

/* /config used to be fetched once per page load, so an engine announced
 * mid-session stayed invisible until a reload. The affordances want to see it
 * sooner: re-ingest /config when the app comes back to the foreground and on
 * a slow timer while visible. loadAppConfig already tolerates failure and
 * only notifies listeners on a real engines list, so this is safe to run
 * forever. */
const REFRESH_MS = 5 * 60_000;
let refreshStarted = false;

export function startEngineDiscoveryRefresh(): void {
  if (refreshStarted) return;
  refreshStarted = true;
  const poke = () => {
    if (!document.hidden) void loadAppConfig();
  };
  window.setInterval(poke, REFRESH_MS);
  document.addEventListener('visibilitychange', poke);
}
