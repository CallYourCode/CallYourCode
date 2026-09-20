/* The engine lease list: discovery is the engine reaching OUT, not this server
 * reaching IN.
 *
 * The old AgentPool here polled each engine's /health on a timer and served an
 * "up/down" verdict. That is gone. Now each engine POSTs /engines/announce on
 * boot and on a heartbeat; this store keeps {engineId, owner, url, lastSeen}
 * and an entry DROPS once `now - lastSeen` passes the lease. The app connects
 * to the urls and the socket state is the truth, so nothing here ever says
 * "up" with any authority.
 *
 * Discovery is ANNOUNCE-ONLY: the engine list is exactly the engines that have
 * announced and are still inside their lease. There is no static seed anymore;
 * an engine that has never announced does not appear.
 *
 * The store is one small JSON file under the per-user state dir (0600,
 * bootstrap/server.ts: ~/.callyourcode/app-server), written atomically to a
 * temp name and renamed, like the other server state. Overridable with
 * ENGINE_LEASES_FILE for the same reason PUSH_FILE is: a test server on a spare
 * port must never write the store his real devices read from.
 */

import { dirname } from "node:path";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { mkdirPrivate } from "../../../engine/shared/runfiles.ts";

export const LEASE_DEFAULT_MS = 6 * 60 * 60 * 1000; // 6h, the agreed default

export type LeaseEntry = {
  engineId: string;
  owner: string;    // the host name the engine announced (host in the payload)
  user: string;     // the unix user the engine announced (ENGINE_USER)
  url: string;      // the ws url a browser should dial
  lastSeen: number; // ms, server clock, set on every announce
};

function isLease(v: unknown): v is LeaseEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.engineId === "string" && e.engineId.length > 0 &&
    typeof e.owner === "string" &&
    typeof e.user === "string" &&
    typeof e.url === "string" && e.url.length > 0 &&
    typeof e.lastSeen === "number" && Number.isFinite(e.lastSeen);
}

/* The /hosts payload shape the app already ingests (dormant.ts). Kept so the
 * app does not break in this slice. `up` is now always true: an announced url
 * is leased by construction (lapsed ones are dropped). Marked for removal in
 * the app-side follow-up, where the socket becomes the only truth and this
 * field dies. */
export type HostsVerdict = { seq: number; hosts: Array<{ url: string; up: boolean; downSince?: number }> };

/* One announced lease as the app ingests it from /config: the ws url, the
 * stable engineId a pairing URL (?pair=key&engine=<engineId>) names, and the
 * host the engine announced (for the ssh pairing command). host is omitted
 * when the lease stores none. */
export type EngineConfigEntry = { url: string; engineId: string; host?: string; user?: string };

export class EngineLeases {
  private entries = new Map<string, LeaseEntry>();
  private seqN = 0;
  private lastUp = new Map<string, boolean>();

  private constructor(private file: string, private leaseMs: number) {}

  /** Open the store: read it back off disk. Does not mkdir or write. */
  static async open(file: string, leaseMs = LEASE_DEFAULT_MS): Promise<EngineLeases> {
    const s = new EngineLeases(file, leaseMs);
    await s.load();
    return s;
  }

  private async load(): Promise<void> {
    const j = await Bun.file(this.file).json().catch(() => null) as any;
    if (j && Array.isArray(j.engines)) {
      for (const e of j.engines) {
        if (isLease(e)) this.entries.set(e.engineId, e);
      }
    }
  }

  private async persist(): Promise<void> {
    await mkdirPrivate(dirname(this.file));
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ engines: [...this.entries.values()] }));
      await chmod(tmp, 0o600).catch(() => {});
      await rename(tmp, this.file);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  /** Upsert one announce. Returns true when the engine was new or its url/owner/
   *  user changed (a new identity worth logging), false on a plain heartbeat. */
  async announce(e: { engineId: string; owner: string; user: string; url: string }): Promise<boolean> {
    const prev = this.entries.get(e.engineId);
    this.entries.set(e.engineId, {
      engineId: e.engineId,
      owner: e.owner,
      user: e.user,
      url: e.url,
      lastSeen: Date.now(),
    });
    const changed = !prev || prev.url !== e.url || prev.owner !== e.owner || prev.user !== e.user;
    await this.persist();
    return changed;
  }

  /** The still-leased entries, oldest first. Lapsed entries are dropped from the
   *  map and the disk, so the current list is exactly "announced and still
   *  leased". */
  async list(now = Date.now()): Promise<LeaseEntry[]> {
    const live: LeaseEntry[] = [];
    let dropped = false;
    for (const e of this.entries.values()) {
      if (now - e.lastSeen > this.leaseMs) { dropped = true; continue; }
      live.push(e);
    }
    if (dropped) {
      this.entries.clear();
      for (const e of live) this.entries.set(e.engineId, e);
      await this.persist();
    }
    live.sort((a, b) => a.lastSeen - b.lastSeen);
    return live;
  }

  /** The announced ws urls, deduped, in the order `live` gives them. */
  urls(live: LeaseEntry[]): string[] {
    const out: string[] = [];
    for (const e of live) if (!out.includes(e.url)) out.push(e.url);
    return out;
  }

  /** The /config engine list: ANNOUNCE-ONLY, one {url, engineId, host, user}
   *  object per still-leased engine, deduped by url (last announce wins). host
   *  is the lease's stored owner (the host name the engine announced) and user
   *  its ENGINE_USER, each omitted when empty. There is no seed: an engine that
   *  has never announced does not appear. */
  configEngines(live: LeaseEntry[]): EngineConfigEntry[] {
    const entryOf = (e: LeaseEntry): EngineConfigEntry => {
      const entry: EngineConfigEntry = { url: e.url, engineId: e.engineId };
      const host = e.owner.trim();
      if (host) entry.host = host;
      const user = e.user.trim();
      if (user) entry.user = user;
      return entry;
    };
    // Last announce wins on a duplicate url (same rule hostsPayload applies).
    const byUrl = new Map<string, LeaseEntry>();
    for (const e of live) {
      const have = byUrl.get(e.url);
      if (!have || e.lastSeen > have.lastSeen) byUrl.set(e.url, e);
    }
    const out: EngineConfigEntry[] = [];
    const seen = new Set<string>();
    for (const e of live) {
      if (seen.has(e.url)) continue;
      out.push(entryOf(byUrl.get(e.url)!));
      seen.add(e.url);
    }
    return out;
  }

  /** The /hosts verdict, keyed by the exact ws url so the app ingests it with
   *  zero translation. ANNOUNCE-ONLY: every url is a live lease, so `up` is
   *  always true (lapsed entries are already out of `live`); seq stays 0. */
  hostsPayload(live: LeaseEntry[], now = Date.now()): HostsVerdict {
    const byUrl = new Map<string, LeaseEntry>();
    for (const e of live) {
      const have = byUrl.get(e.url);
      if (!have || e.lastSeen > have.lastSeen) byUrl.set(e.url, e);
    }
    const hosts = this.urls(live).map((url) => {
      const e = byUrl.get(url)!;
      const up = now - e.lastSeen <= this.leaseMs;
      return { url, up, ...(up ? {} : { downSince: e.lastSeen + this.leaseMs }) };
    });
    for (const h of hosts) {
      const prev = this.lastUp.get(h.url);
      if (prev !== undefined && prev !== h.up) this.seqN++;
      this.lastUp.set(h.url, h.up);
    }
    return { seq: this.seqN, hosts };
  }
}
