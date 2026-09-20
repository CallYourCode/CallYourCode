/* Keeps the notification-icon store (notifIconDb.ts) in step with the roster:
 * every session gets a locally prepared icon -- its profile photo when one is
 * set (the 128px thumbnail, cache-first over the sealed wire), otherwise the
 * same name-derived robot SVG the app renders in the list. The service worker
 * reads the row by sessionId at push time; pushes themselves never carry an
 * icon (sealed transport, engine chat/notify.ts).
 *
 * Icons are stored as data URIs so showNotification never needs a fetch. The
 * SVG fallback is rasterized to PNG when a canvas is available (Android's tray
 * does not reliably render SVG icons); where it is not, the SVG data URI is
 * stored as-is. iOS ignores notification icons entirely either way. */

import {avatarFallbackSvg} from '@/components/avatarView';
import {engineImageBlob} from '@/engine/contract';
import {pruneNotifIcons, putNotifIcon} from './notifIconDb';

const ICON_PX = 128;

export function notifIconKey(s: {name: string; avatarUrl?: string}): string {
  return s.avatarUrl ? 'photo:' + s.avatarUrl : 'fallback:' + s.name;
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error as Error);
    r.readAsDataURL(blob);
  });
}

function svgDataUri(svg: string): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// SVG -> PNG data URI through a canvas; null when the environment cannot
// (no 2d context, image decode failure) -- the caller stores the SVG then.
async function rasterizeSvg(svg: string): Promise<string | null> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = ICON_PX;
    canvas.height = ICON_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const img = new Image();
    const loaded = new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 3000);
    });
    img.src = svgDataUri(svg);
    if (!(await loaded)) return null;
    ctx.drawImage(img, 0, 0, ICON_PX, ICON_PX);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

export async function notifFallbackIcon(name: string, seed: string): Promise<string> {
  const svg = avatarFallbackSvg(name, seed, ICON_PX);
  return (await rasterizeSvg(svg)) ?? svgDataUri(svg);
}

// sessionId -> the key whose icon the store already holds (or is being
// written). One write per change: the photo url carries `?v=` so a photo edit
// is a new key, and a rename moves the fallback key.
const synced = new Map<string, string>();

export async function syncNotifAvatar(s: {
  id: string;
  name: string;
  avatarUrl?: string;
}): Promise<void> {
  const key = notifIconKey(s);
  if (synced.get(s.id) === key) return;
  synced.set(s.id, key);
  try {
    let icon: string;
    if (s.avatarUrl && /^https?:/i.test(s.avatarUrl)) {
      const url = s.avatarUrl + (s.avatarUrl.includes('?') ? '&' : '?') + 'w=' + ICON_PX;
      icon = await blobToDataUri(await engineImageBlob(url));
    } else {
      icon = await notifFallbackIcon(s.name, s.id || s.name);
    }
    await putNotifIcon({sessionId: s.id, icon, key, at: Date.now()});
  } catch {
    // Fetch or store failed: forget the claim so the next roster pass retries.
    if (synced.get(s.id) === key) synced.delete(s.id);
  }
}

export function syncNotifAvatars(
  list: Array<{id: string; name: string; avatarUrl?: string}>
): void {
  for (const s of list) void syncNotifAvatar(s);
}

/* PRUNING (the other half of keeping the store in step with the roster):
 * rows whose session is gone from the roster are deleted, so the store never
 * grows past the sessions that exist. The rule, stated once:
 *
 *   - Prune ONLY on a CONNECTED engine's authoritative roster (the caller
 *     gates on a settled sessions frame). A briefly-down engine never prunes:
 *     its frame is not settled, and its sessions stay in the store map (greyed,
 *     not deleted), so they stay in the keep-set. No delete/rewrite thrash.
 *   - The keep-set spans EVERY engine's sessions (this DB is one flat store,
 *     not engine-partitioned); an offline engine's sessions ride in via the
 *     persisted roster, so its rows survive its outage.
 *   - Not armed until the cold-open roster hydration finishes (store.ts calls
 *     armNotifAvatarPrune then): a fast engine settling before a slow disk
 *     read must not see a half-hydrated map and prune another engine's rows.
 *   - An unchanged keep-set is free: the signature check below skips the DB
 *     entirely, so only a roster that actually changed touches it. */
let pruneArmed = false;
let prunedSig = '';

export function armNotifAvatarPrune(): void {
  pruneArmed = true;
}

export async function pruneNotifAvatars(keepIds: Iterable<string>): Promise<void> {
  if (!pruneArmed) return;
  const keep = new Set(keepIds);
  const sig = [...keep].sort().join('\n');
  if (sig === prunedSig) return;
  prunedSig = sig;
  const gone = await pruneNotifIcons(keep);
  // Drop the write claims of pruned rows so a session that comes back to the
  // roster is written afresh (its row is gone, the claim must not stand).
  for (const id of gone) if (!keep.has(id)) synced.delete(id);
}
