import {setViewStorage, type ViewStorage} from '@/features/code/viewer';
import {cyc} from './cyc';

const cache = new Map<string, string>();

const store: ViewStorage = {
  get: (key) => (cache.has(key) ? cache.get(key)! : null),
  set: (key, value) => {
    cache.set(key, value);
    scheduleFlush();
  }
};

let flushTimer: number | null = null;
function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    const keys: Record<string, string> = {};
    for (const [k, v] of cache) keys[k] = v;
    void cyc().save({v: 1, keys});
  }, 250);
}

export async function hydrateViewState(): Promise<void> {
  setViewStorage(store);
  try {
    const r = await cyc().load();
    const data = r && r.ok && r.saved ? r.data : null;
    const keys = data && typeof data === 'object' ? (data as {keys?: unknown}).keys : null;
    if (keys && typeof keys === 'object') {
      for (const [k, v] of Object.entries(keys as Record<string, unknown>)) {
        if (typeof v === 'string') cache.set(k, v);
      }
    }
  } catch {}
}
