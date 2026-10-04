import {cyclog} from './logging';
import {markSelfReload} from './selfReload';

// Every dynamic import() in the app goes through lazy(). The engine serves
// app/dist from disk, and a rebuild swaps in new hashed chunk names; a page
// that is already open then asks for a chunk that no longer exists and the
// import rejects. Instead of doing nothing, the page reloads itself once so it
// boots on the new build. A sessionStorage mark survives that reload, so if a
// load fails again soon after (a genuinely broken deploy) the page does not
// loop: it tells the user and rethrows.

const RELOADED_KEY = 'cyc:chunk-reloaded';
// A reload takes seconds; a mark older than this is from an earlier rebuild
// and must not stop the next one-shot reload.
const RELOAD_MARK_FRESH_MS = 5 * 60_000;

type Notify = (message: string) => void;

let notify: Notify = () => {};
let reloadRequested = false;

// The boot entry (src/boot.ts) also lazy-loads main, before any UI exists, so
// this module deliberately imports nothing that renders. main registers the
// real toast once it is up.
export function setLazyNotifier(fn: Notify): void {
  notify = fn;
}

function reloadedRecently(): boolean {
  try {
    const at = Number(sessionStorage.getItem(RELOADED_KEY) ?? '');
    return Number.isFinite(at) && at > 0 && Date.now() - at < RELOAD_MARK_FRESH_MS;
  } catch {
    return false;
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch {}
}

export function lazy<T>(load: () => Promise<T>, what: string): Promise<T> {
  return load().catch((err: unknown) => {
    cyclog('chunk.missing', {what, err: String(err)});
    if (reloadRequested) throw err;
    if (reloadedRecently()) {
      notify(`Could not load ${what}; reload the app`);
      throw err;
    }
    reloadRequested = true;
    markReloaded();
    notify('The app was updated; reloading');
    markSelfReload();
    location.reload();
    throw err;
  });
}

// Test seam: forget the in-page one-shot so a fresh page can be simulated.
export function resetLazyForTests(): void {
  reloadRequested = false;
}
