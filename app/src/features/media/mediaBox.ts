import {h} from '../../components/domHelpers';
import {makeIcon} from '../../components/iconGlyphs';
import {engineCapFetch} from '../../engine/contract';
import {currentPresentationTheme} from '../../components/presentation';
import {MEDIA_PRIMARY_BG, MEDIA_SURFACE_BG, MEDIA_SURFACE_HEX, paintOnTheme} from './mediaPaint';
import {ImageResolveError, isEngineUrl, resolveImageSource} from './resolveImage';

export {MEDIA_RETRY_WINDOW_MS, MEDIA_WIRE_WAIT_MS} from './resolveImage';


export const DOC_BASE_UTILS =
  'relative flex flex-col justify-center cursor-pointer ps-[calc(var(--cyc-doc-face,3rem)+0.75rem)]';
export const DOC_CHAT_UTILS = DOC_BASE_UTILS + ' h-12';
// Doc glyph sits in the start/top lane with a static folded corner.
export const DOC_ICO_UTILS =
  'absolute start-0 top-0 w-[var(--cyc-doc-face,3rem)] h-[var(--cyc-doc-face,3rem)] text-white bg-contain rounded-[0.4rem] leading-none text-[1rem] whitespace-nowrap overflow-hidden flex flex-col items-center justify-end px-1 pb-3' +
  " after:pointer-events-none after:content-[''] after:absolute after:top-0 after:end-0 after:h-2.5 after:w-2.5 after:[clip-path:polygon(0_0,100%_0,100%_100%)] after:bg-[color-mix(in_srgb,black_18%,transparent)]";
export const DOC_NAME_UTILS =
  'whitespace-nowrap text-ellipsis overflow-hidden font-medium text-[length:14px] leading-[1.4] mt-px';
export const DOC_SIZE_UTILS =
  'whitespace-nowrap text-ellipsis overflow-hidden text-[color:var(--cyc-text-muted)] text-[length:0.875rem] leading-[18px] [.cyc-message_&]:text-[length:14px]';

// The document icon fill. Zip and PDF keep a fixed ink; every other doc (and any
// page-answer submit doc) paints the themed copper primary live.
const DOC_ICO_EXT_FILL: Record<string, string> = {
  zip: 'bg-[#b9772e]',
  pdf: 'bg-[#b23a34]'
};
const ALL_DOC_ICO_PRIMARY = Object.values(MEDIA_PRIMARY_BG);
export function paintDocIcon(ico: HTMLElement, ext: string, submit: boolean): void {
  const fixed = submit ? undefined : DOC_ICO_EXT_FILL[ext];
  if (fixed) {
    ico.classList.add(fixed);
    return;
  }
  paintOnTheme(ico, ALL_DOC_ICO_PRIMARY, (t) => MEDIA_PRIMARY_BG[t]);
}

// Size bands, largest first. Whole numbers drop trailing zeros (`1 MB`).
const BYTE_UNITS: {
  threshold: number;
  divisor: number;
  unit: string;
  format: Intl.NumberFormat;
}[] = [
  {threshold: 1073741824, divisor: 1073741824, unit: 'GB', format: byteFormat(2)},
  {threshold: 1048576, divisor: 1048576, unit: 'MB', format: byteFormat(1)},
  {threshold: 1024, divisor: 1024, unit: 'KB', format: byteFormat(0)},
  {threshold: 0, divisor: 1, unit: 'B', format: byteFormat(0)}
];

function byteFormat(maximumFractionDigits: number): Intl.NumberFormat {
  return new Intl.NumberFormat('en-US', {maximumFractionDigits, useGrouping: false});
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  for (const {threshold, divisor, unit, format} of BYTE_UNITS) {
    if (bytes < threshold) continue;
    return `${format.format(bytes / divisor)} ${unit}`;
  }
  return '0 B';
}

async function classifyMediaFailure(src: string): Promise<'gone' | 'undecodable'> {
  if (!src) return 'gone';
  try {
    const res = await engineCapFetch(src, {cache: 'force-cache'});
    if (res.status === 404) return 'gone';
    if (res.ok) return 'undecodable';
    return 'gone';
  } catch {
    return 'gone';
  }
}

function buildMediaFailCard(kind: 'gone' | 'undecodable'): HTMLDivElement {
  const card = h(
    'div',
    `cyc-media-gone cyc-media-gone-${kind} flex w-full min-h-[4.5rem] flex-col items-center justify-center gap-2 box-border rounded-md px-4 py-5 text-center bg-[var(--cyc-surface)] border border-[color:var(--cyc-border-color,rgba(127,127,127,0.22))] text-[color:var(--cyc-text-muted)]`
  ) as HTMLDivElement;
  card.append(makeIcon('image', 'cyc-media-gone-icon text-[1.75rem] leading-none opacity-70'));
  const line = h(
    'div',
    'cyc-media-gone-line text-sm font-medium max-w-60 text-[color:var(--cyc-text)]'
  );
  line.textContent = kind === 'gone' ? 'Image no longer on disk' : "This image can't be shown here";
  card.append(line);
  return card;
}

const MEDIA_LOADING_PULSE = '[animation:cyc-media-pulse_1.4s_ease-in-out_infinite]';
const ALL_MEDIA_LOADING_BG = Object.values(MEDIA_SURFACE_BG);

// The "tap to load" state: the wire never came up (or the window ran out with
// the wire flapping). Not a silent black box; a tap retries the whole path.
function buildTapCard(onTap: () => void): HTMLDivElement {
  const card = h(
    'div',
    'cyc-media-tap absolute inset-0 z-[1] flex flex-col items-center justify-center gap-2 box-border px-4 py-5 text-center cursor-pointer select-none bg-[var(--cyc-surface)] text-[color:var(--cyc-text-muted)]'
  ) as HTMLDivElement;
  card.append(makeIcon('image', 'cyc-media-tap-icon text-[1.75rem] leading-none opacity-70'));
  const line = h('div', 'cyc-media-tap-line text-sm font-medium max-w-60 text-[color:var(--cyc-text)]');
  line.textContent = 'Tap to load';
  card.append(line);
  card.addEventListener('click', (ev) => {
    // The box itself opens the viewer on click; a tap here is a retry, not that.
    ev.stopPropagation();
    ev.preventDefault();
    card.remove();
    onTap();
  });
  return card;
}

export function setTunnelSrc(img: HTMLImageElement, url: string): void {
  if (!url) return;
  // The source this element was painted from, before any resolve/mint step
  // rewrites img.src. The message list matches on it to carry a decoded
  // <img> across a row rebuild whose picture did not change.
  img.dataset.cycSrc = url;
  const holder = () => img.parentElement;
  const mediaBox = (): HTMLElement | null => {
    const box = holder();
    return box && box.classList.contains('cyc-media-box') ? box : null;
  };
  // The loading surface has to beat the box's own `bg-[#000]!` (the photo's
  // letterbox), or the wait paints as a black box: inline, important.
  const loading = (on: boolean) => {
    const box = mediaBox();
    if (!box) return;
    box.classList.remove(...ALL_MEDIA_LOADING_BG, MEDIA_LOADING_PULSE);
    box.style.removeProperty('background-color');
    if (!on) return;
    const theme = currentPresentationTheme();
    box.classList.add(MEDIA_SURFACE_BG[theme], MEDIA_LOADING_PULSE);
    box.style.setProperty('background-color', MEDIA_SURFACE_HEX[theme], 'important');
  };

  // Full photos stay hidden until bytes arrive; grid tiles stay visible.
  const awaits = img.classList.contains('cyc-still');
  if (awaits) img.classList.add('invisible');
  const reveal = () => img.classList.remove('invisible');
  const apply = (u: string, minted: boolean) => {
    loading(false);
    if (minted) {
      const done = () => URL.revokeObjectURL(u);
      img.addEventListener('load', done, {once: true});
      img.addEventListener('error', done, {once: true});
    }

    img.addEventListener('load', reveal, {once: true});
    img.src = u;
  };
  // The engine answered and does not have it (404): the existing failure
  // cascade classifies it ("no longer on disk" / "can't be shown").
  const giveUp = () => {
    loading(false);

    img.dataset.cycMediaUrl = url;
    img.dispatchEvent(new Event('error'));
  };
  // The wire never came up: a photo shows the tap card; a grid tile (no media
  // box) keeps its own unreachable state via the error path.
  const stall = () => {
    loading(false);
    const box = mediaBox();
    if (!box) return giveUp();
    if (box.querySelector('.cyc-media-tap') || box.querySelector('.cyc-media-gone')) return;
    box.append(buildTapCard(() => setTunnelSrc(img, url)));
  };

  if (!isEngineUrl(url)) return apply(url, false);

  void resolveImageSource({key: url}, {onWaiting: () => loading(true)}).then(
    (found) => apply(found.src, found.minted),
    (err: unknown) => {
      if (err instanceof ImageResolveError && err.reason === 'gone') return giveUp();
      stall();
    }
  );
}

export function markMissingOnError(img: HTMLImageElement): HTMLImageElement {
  img.addEventListener(
    'error',
    () => {
      const holder = img.parentElement;
      if (!holder || holder.querySelector('.cyc-media-gone')) return;
      img.classList.add('cyc-off');
      void classifyMediaFailure(img.dataset.cycMediaUrl || img.currentSrc || img.src).then(
        (kind) => {
          if (!holder.isConnected || holder.querySelector('.cyc-media-gone')) return;

          holder.style.aspectRatio = 'auto';
          holder.classList.remove('cyc-media-unknown');
          holder.append(buildMediaFailCard(kind));
        }
      );
    },
    {once: true}
  );
  return img;
}

export function reserveMediaBox(container: HTMLElement, width?: number, height?: number): void {
  // Was part of `html body .cyc-media-box,.cyc-annex { border-radius:
  // 6px! }` (chrome.css 6px): the media box's corner, painted
  // directly on the box (`!` beats the residual `.cyc-message.cyc-media-tile/.cyc-multipart
  // .cyc-media-box { border-radius: 0.5rem }`).
  container.classList.add('cyc-media-reserve', 'h-auto', 'max-h-[22rem]', 'rounded-[6px]!');
  if (width && height && width > 0 && height > 0) {
    container.style.aspectRatio = `${width} / ${height}`;
  } else {
    container.classList.add('cyc-media-unknown');
    container.style.aspectRatio = '4 / 3';
  }
}
