import {engineObjectUrl} from '../../engine/contract';
import {cyclog} from '@/shared/logging';

/** True on an iPhone/iPad/iPod, including an iPadOS that reports itself as a
 *  MacIntel with a touch screen. WebKit ignores an `<a download>` on a blob:
 *  URL in a home-screen (standalone) PWA, so the OS share sheet is the reliable
 *  save path here. Mirrors the iOS test in engine/pushNotify.ts. */
export function iosLike(): boolean {
  const nav = navigator;
  return (
    /iPad|iPhone|iPod/.test(nav.userAgent) ||
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  );
}

type FileShareNav = Navigator & {
  canShare?: (data?: {files?: File[]; title?: string}) => boolean;
  share?: (data?: {files?: File[]; title?: string}) => Promise<void>;
};

function fileFor(name: string, blob: Blob): File {
  return new File([blob], name, {type: blob.type || 'application/octet-stream'});
}

/** True when this browser can hand `blob` to the OS share sheet as a file
 *  (navigator.canShare({files})). This is the save path that works from a
 *  home-screen PWA on iOS, where it offers Save Video / Save to Files. */
export function canShareFile(name: string, blob: Blob): boolean {
  const nav = navigator as FileShareNav;
  if (typeof nav.canShare !== 'function' || typeof nav.share !== 'function') return false;
  try {
    return nav.canShare({files: [fileFor(name, blob)]});
  } catch {
    return false;
  }
}

/** How saving `blob` should reach the device: the OS share sheet on iOS, else
 *  a download via an `<a download>` link. On iOS there is no other path: WebKit
 *  ignores `<a download>` in a home-screen app and opens the bytes as a page
 *  inside it, with no way back, so a file the share sheet will not take is
 *  'none' there, never a link. Desktop Chrome also reports canShare({files})
 *  but must download straight to disk, never open the share sheet. The share
 *  sheet must be opened from a user gesture, so a caller that has awaited a
 *  fetch settles this only once it has a fresh tap and the bytes in hand. */
export function saveMethodFor(name: string, blob: Blob): 'share' | 'download' | 'none' {
  if (!iosLike()) return 'download';
  return canShareFile(name, blob) ? 'share' : 'none';
}

/** Save `blob` to the device from within a user gesture: the OS share sheet on
 *  iOS, else an `<a download>` link (desktop needs no gesture for that and must
 *  not open the share sheet). Returns the method actually used; a share the
 *  user dismisses still counts as handled. On iOS a share that fails is
 *  'none': it is never retried as a link to the bytes (see saveMethodFor). */
export async function shareOrSaveBlob(
  name: string,
  blob: Blob
): Promise<'share' | 'download' | 'none'> {
  if (iosLike()) {
    if (!canShareFile(name, blob)) {
      cyclog('download.share.unavailable', {
        name,
        bytes: blob.size,
        why: 'the iOS share sheet does not take this file, and a link to it would open it inside the app'
      });
      return 'none';
    }
    const nav = navigator as FileShareNav;
    try {
      await nav.share!({files: [fileFor(name, blob)], title: name});
      cyclog('download.saved', {name, via: 'share', bytes: blob.size});
      return 'share';
    } catch (err) {
      if ((err as {name?: string})?.name === 'AbortError') {
        cyclog('download.saved', {name, via: 'share-cancelled', bytes: blob.size});
        return 'share';
      }
      cyclog('download.share.failed', {
        name,
        err,
        why:
          'the OS share sheet threw for a reason other than the user cancelling; ' +
          'nothing else is tried, a link to the bytes would open them inside the app'
      });
      return 'none';
    }
  }
  saveBlob(name, blob);
  cyclog('download.saved', {name, via: 'download', bytes: blob.size});
  return 'download';
}

function triggerDownload(name: string, url: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

export function saveHref(name: string, url: string) {
  void engineObjectUrl(url).then((resolved) => {
    triggerDownload(name, resolved);
    if (resolved !== url) window.setTimeout(() => URL.revokeObjectURL(resolved));
  });
}

export function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  triggerDownload(name, url);
  window.setTimeout(() => URL.revokeObjectURL(url));
}

export function saveText(name: string, text: string, type = 'text/plain;charset=utf-8') {
  saveBlob(name, new Blob([text], {type}));
}

function copyWithSelection(text: string): boolean {
  const active = document.activeElement as HTMLElement | null;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({length: selection.rangeCount}, (_, i) => selection.getRangeAt(i))
    : [];
  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.width = '2em';
  area.style.height = '2em';
  area.style.padding = '0';
  area.style.border = '0';
  area.style.outline = '0';
  area.style.boxShadow = 'none';
  area.style.background = 'transparent';
  document.body.append(area);

  try {
    area.focus({preventScroll: true});
    area.setSelectionRange(0, area.value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    try {
      selection?.removeAllRanges();
      for (const range of ranges) selection?.addRange(range);
    } catch {}
    try {
      active?.focus({preventScroll: true});
    } catch {}
  }
}

export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  return copyWithSelection(text);
}

export default function copyElementText(element: HTMLElement): Promise<boolean> {
  return copyText(element.textContent ?? '');
}
