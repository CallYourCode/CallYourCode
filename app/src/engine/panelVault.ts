import {cyclog} from '@/shared/logging';
import {openNamespace, ownDbTx} from '@/shared/blobStore';

// Panel HTML cache keyed by (engineKey, pluginId, version). A plugin frontend
// is a large HTML bundle fetched over the sealed RTC tunnel; before this store
// every open paid that round-trip (a visible blank stage). Now a version-
// matched open renders from memory or IndexedDB with no fetch at all.
//
// Two tiers, both behind the same key:
//   - an in-memory Map for the session, so a repeat open is synchronous; and
//   - an IndexedDB store for cross-reload persistence, one keyPath:'key' store
//     behind the shared blob-store engine.

const DB_NAME = 'cyc-panels';
const STORE = 'panels';

// A handful of panels, each maybe hundreds of KB. Cap total bytes and count;
// when a write would breach either, drop the oldest rows first.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 24;

const SEP = '\u0000';

type PanelRow = {
  key: string;

  engineKey: string;
  pluginId: string;
  version: number;

  html: string;
  bytes: number;

  ts: number;
};

function keyOf(engineKey: string, pluginId: string, version: number): string {
  return engineKey + SEP + pluginId + SEP + version;
}

const mem = new Map<string, PanelRow>();

const store = openNamespace<PanelRow>({
  tx: ownDbTx(DB_NAME, STORE, 'key'),
  keyPath: 'key',
  maxBytes: MAX_BYTES,
  maxItems: MAX_ROWS,
  countNoun: 'row',
  bytesOf: (r) => r.bytes,
  tsOf: (r) => r.ts,
  serializedWrites: true,
  onEvict: (rec, cap) => {
    cyclog('plugin.panel.cache.evict', {
      plugin: rec.pluginId,
      version: rec.version,
      bytes: rec.bytes,
      ageMs: Date.now() - rec.ts,
      cap,
      why:
        'the panel cache is over a cap; oldest panels go first, so opening that ' +
        'plugin again is a fetch over the tunnel'
    });
    mem.delete(rec.key);
  }
});

async function allRows(): Promise<PanelRow[]> {
  return store.getAll();
}

// The row for an exact (engineKey, pluginId, version), memory first then IDB
// (populating memory on the way through). A usable version means this is a
// definite hit or a definite miss; there is no ambiguity to revalidate.
async function getExact(
  engineKey: string,
  pluginId: string,
  version: number
): Promise<PanelRow | null> {
  const key = keyOf(engineKey, pluginId, version);
  const hot = mem.get(key);
  if (hot) return hot;
  const rec = await store.get(key);
  if (rec) mem.set(key, rec);
  return rec ?? null;
}

// The newest cached row for a plugin regardless of version. Used by the
// no-version stale-while-revalidate path and by the offline fallback, where
// any held bytes beat a blank stage.
async function getNewest(engineKey: string, pluginId: string): Promise<PanelRow | null> {
  let best: PanelRow | null = null;
  for (const r of mem.values()) {
    if (r.engineKey !== engineKey || r.pluginId !== pluginId) continue;
    if (!best || r.ts > best.ts) best = r;
  }
  const all = await allRows();
  for (const r of all) {
    if (r.engineKey !== engineKey || r.pluginId !== pluginId) continue;
    mem.set(r.key, r);
    if (!best || r.ts > best.ts) best = r;
  }
  return best;
}

// Write a fresh panel and drop every stale version of the same plugin: only one
// version of a plugin is ever the live one, so keeping the others just wastes
// the cap. Serialized behind prior writes so an evict-then-put never races.
async function put(
  engineKey: string,
  pluginId: string,
  version: number,
  html: string
): Promise<void> {
  const bytes = html.length;
  const key = keyOf(engineKey, pluginId, version);
  const row: PanelRow = {key, engineKey, pluginId, version, html, bytes, ts: Date.now()};
  await store.put(row, {
    before: async () => {
      // Drop stale versions of this plugin (memory + IDB) before the write.
      for (const r of [...mem.values()]) {
        if (r.engineKey === engineKey && r.pluginId === pluginId && r.key !== key) {
          mem.delete(r.key);
        }
      }
      for (const r of await allRows()) {
        if (r.engineKey === engineKey && r.pluginId === pluginId && r.key !== key) {
          await store.del(r.key);
        }
      }
      mem.set(key, row);
    }
  });
}

function log(pluginId: string, result: 'hit' | 'miss' | 'revalidate', bytes: number): void {
  cyclog('plugin.panel.cache', {plugin: pluginId, result, bytes});
}

// Load a plugin panel's HTML through the cache, rendering as soon as any usable
// bytes exist and fetching only when the cache cannot serve the open:
//   - version-matched cache hit  -> render, NO fetch (hit);
//   - miss or version mismatch   -> fetch, render, write, drop stale (miss);
//   - no usable version -> paint cached, refetch in the background, swap only
//     if the bytes differ (revalidate). This is NOT only the old-engine case:
//     it ALSO covers the live race where the plugins list has not arrived yet,
//     so `version` is not known for a real, current engine (proven in the
//     frontier verify). The path is load-bearing today, not compat to remove;
//   - engine unreachable + any cached version -> render it (offline win);
//   - engine unreachable + nothing cached -> the fetch's throw propagates, so
//     the caller shows its offline error.
// `render` may be called twice (the no-version revalidate path); it must clear
// and rebuild the stage each time.
export async function loadPanel(
  engineKey: string,
  pluginId: string,
  version: number,
  fetchFresh: () => Promise<string>,
  render: (html: string) => void
): Promise<void> {
  const usableVersion = Number.isFinite(version) && version > 0;

  if (usableVersion) {
    const exact = await getExact(engineKey, pluginId, version);
    if (exact) {
      render(exact.html);
      log(pluginId, 'hit', exact.bytes);
      return;
    }
    try {
      const html = await fetchFresh();
      render(html);
      log(pluginId, 'miss', html.length);
      void put(engineKey, pluginId, version, html);
      return;
    } catch (err) {
      const stale = await getNewest(engineKey, pluginId);
      if (stale) {
        render(stale.html);
        log(pluginId, 'hit', stale.bytes);
        return;
      }
      throw err;
    }
  }

  // No usable version: stale-while-revalidate. Paint any cached bytes at once,
  // then refetch and swap only if the bytes changed.
  const cached = await getNewest(engineKey, pluginId);
  if (cached) {
    render(cached.html);
    log(pluginId, 'revalidate', cached.bytes);
    try {
      const html = await fetchFresh();
      if (html !== cached.html) {
        render(html);
        void put(engineKey, pluginId, version, html);
      }
    } catch {
      // Offline or a failed revalidate leaves the painted cached bytes in place.
    }
    return;
  }
  const html = await fetchFresh();
  render(html);
  log(pluginId, 'miss', html.length);
  void put(engineKey, pluginId, version, html);
}

// Test and diagnostics helper: forget the in-memory tier (the IDB tier is left
// as the durable record). Not used by the app at runtime.
export function _resetMemory(): void {
  mem.clear();
}
