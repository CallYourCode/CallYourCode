import {engineObjectUrl} from '../../engine/contract';

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
