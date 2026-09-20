import {h} from '../../components/domHelpers';
import {makeIcon, makeIconButton} from '../../components/iconGlyphs';
import {saveBlob, saveHref} from '@/features/media/downloads';
import {engineCapFetch} from '../../engine/contract';
import {cyclog} from '@/shared/logging';
import {touchCapable} from '@/shared/capabilities';
import {clampNumber} from '@/shared/numbers';
import * as interactionWindow from '@/shared/browser';
import {ImageResolveError, resolveImageSource, srcScheme, type ImageHow} from './resolveImage';

// Image paging/dismiss thresholds and timing, owned by the viewer. The paging
// drag arms once travel passes ARM_PX and clearly leads horizontally (by
// ARM_RATIO); a release past COMMIT_PX (or a wheel run past WHEEL_COMMIT_FRACTION
// of the stage width, capped) pages to the neighbour image. ANIM_MS is the shared
// slide/settle/dismiss duration; a wheel run ends after WHEEL_QUIET_MS of silence.
const IMG_ARM_PX = 12;
const IMG_ARM_RATIO = 1.25;
// Once armed, paint from zero at the arm point (subtract the slop) so the image
// does not jump by the full finger/wheel travel the instant the gesture arms;
// commit still measures the raw travel below, so the commit distance is unchanged.
const imgSlop = (d: number) => Math.sign(d) * Math.max(0, Math.abs(d) - IMG_ARM_PX);
const IMG_COMMIT_PX = 60;
const IMG_WHEEL_COMMIT_FRACTION = 0.25;
const IMG_WHEEL_COMMIT_CAP_PX = IMG_COMMIT_PX * 4;
const IMG_WHEEL_QUIET_MS = 160;
const IMG_ANIM_MS = 110;

let close: (() => void) | null = null;

export type ViewerItem = {
  // The engine URL of the picture: the key the bubble cached it under. A
  // non-http URL (data:, blob:) is applied as-is.
  url: string;
  name: string;

  docId?: string;

  bytes?: () => Promise<Blob | null>;
  // The local object URL of a picture this device sent, looked up when the
  // viewer resolves it (never a URL captured earlier that may since have been
  // revoked); tried after the cache, before the wire.
  local?: () => string | undefined;
};

// The viewer's own states over the stage, so the stage is never a silent black
// box or a broken picture: `waiting` while the wire is dialing, `tap` when the
// picture is not on this device and the wire did not come up (a tap retries the
// whole path), `gone` when the engine said it no longer has it.
type StageCardKind = 'waiting' | 'tap' | 'gone';
const STAGE_CARD_TEXT: Record<StageCardKind, string> = {
  waiting: 'Waiting for the engine',
  tap: 'Tap to load',
  gone: 'Image no longer on disk'
};
function buildStageCard(kind: StageCardKind, onTap: (() => void) | null): HTMLDivElement {
  const card = h(
    'div',
    `cyc-imgview-${kind} ` +
      // A line with no tap lets the tap through to the stage (which closes).
      (onTap ? 'cursor-pointer ' : 'pointer-events-none ') +
      (kind === 'waiting' ? '[animation:cyc-media-pulse_1.4s_ease-in-out_infinite] ' : '') +
      'absolute inset-0 z-[3] flex flex-col items-center justify-center gap-2 box-border px-4 py-5 text-center select-none text-white'
  ) as HTMLDivElement;
  card.append(makeIcon('image', 'cyc-imgview-card-icon text-[2.25rem] leading-none opacity-70'));
  const line = h('div', 'cyc-imgview-card-line text-[0.9375rem] font-medium max-w-60 opacity-85');
  line.textContent = STAGE_CARD_TEXT[kind];
  card.append(line);
  if (onTap) {
    // The stage captures the pointer on pointerdown (pinch, pan, swipe to
    // dismiss); under capture the browser aims the click at the stage, and the
    // overlay reads a click on the stage as "close". Keep the pointer here so
    // the tap lands on the card, not on the stage.
    card.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    card.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      card.remove();
      onTap();
    });
  }
  return card;
}

type ImageViewerOptions = {
  onShow?: (item: ViewerItem) => void;
  onClose?: () => void;
};

export function openImageViewer(
  items: ViewerItem[] | string,
  index: number | string = 0,
  opts: ImageViewerOptions = {}
) {
  const list: ViewerItem[] = Array.isArray(items)
    ? items
    : [{url: items, name: typeof index === 'string' ? index : ''}];
  if (!list.length) return;
  let at = typeof index === 'number' ? index : 0;
  if (at < 0) at = 0;
  if (at > list.length - 1) at = list.length - 1;

  close?.();

  const overlay = h(
    'div',
    'cyc-imgview absolute inset-0 z-[12] flex flex-col overflow-hidden bg-[rgba(0,0,0,0.92)] [animation:cyc-imgview-in_0.12s_ease-out]'
  );
  const HEAD_FADE_UTILS =
    '[transition:opacity_0.11s_ease] [.cyc-imgview-dragging_&]:opacity-0 [.cyc-imgview-dragging_&]:pointer-events-none';
  const header = h(
    'div',
    'cyc-imgview-head flex-none flex items-center gap-2 p-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-white rounded-[6px]! ' +
      HEAD_FADE_UTILS
  );
  const btnClose = makeIconButton(
    'close',
    'cyc-imgview-close text-white! flex-none rounded-[6px]!'
  );
  const title = h(
    'div',
    'cyc-imgview-title min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.9375rem] opacity-85'
  );
  const count = h(
    'div',
    'cyc-imgview-count flex-none ms-auto pe-1 text-[0.8125rem] opacity-60 tabular-nums'
  );

  const btnSave = makeIconButton('download', 'cyc-imgview-save text-white! flex-none');
  btnSave.title = 'Download';
  btnSave.setAttribute('aria-label', 'Download');
  const saveCurrent = async () => {
    const item = list[at];
    const name = item.name || 'image';
    let blob: Blob | null = null;
    try {
      blob = item.bytes ? await item.bytes() : null;
    } catch {}
    if (!blob) {
      try {
        const res = await engineCapFetch(item.url, {signal: AbortSignal.timeout(15_000)});
        if (res.ok) blob = await res.blob();
      } catch {}
    }
    if (closed) return;
    if (blob) saveBlob(name, blob);
    else saveHref(name, item.url);
  };
  btnSave.addEventListener('click', (e) => {
    e.stopPropagation();
    void saveCurrent();
  });
  header.append(btnClose, title, count, btnSave);

  const stage = h(
    'div',
    'cyc-imgview-stage flex-auto min-h-0 flex items-center justify-center [--cyc-imgview-pad:0.5rem] p-[var(--cyc-imgview-pad)] pb-[max(var(--cyc-imgview-pad),env(safe-area-inset-bottom))] touch-none overflow-hidden will-change-transform [&.cyc-imgview-zoomed]:cursor-grab'
  );

  const track = h(
    'div',
    'cyc-imgview-track relative w-full h-full flex items-center justify-center will-change-transform'
  );
  const IMG_UTILS =
    'max-w-full max-h-full object-contain origin-center will-change-transform [image-orientation:from-image]';
  const NEIGHBOUR_UTILS = 'absolute top-0 bottom-0 m-auto pointer-events-none';
  const img = h('img', 'cyc-imgview-img ' + IMG_UTILS) as HTMLImageElement;
  const neighbourPrev = h(
    'img',
    `cyc-imgview-img ${IMG_UTILS} cyc-imgview-neighbour ${NEIGHBOUR_UTILS} cyc-imgview-neighbour-prev [inset-inline-start:calc(-100%_-_var(--cyc-imgview-pad)*2)] [inset-inline-end:calc(100%_+_var(--cyc-imgview-pad)*2)] cyc-off`
  ) as HTMLImageElement;
  const neighbourNext = h(
    'img',
    `cyc-imgview-img ${IMG_UTILS} cyc-imgview-neighbour ${NEIGHBOUR_UTILS} cyc-imgview-neighbour-next [inset-inline-start:calc(100%_+_var(--cyc-imgview-pad)*2)] [inset-inline-end:calc(-100%_-_var(--cyc-imgview-pad)*2)] cyc-off`
  ) as HTMLImageElement;
  track.append(neighbourPrev, img, neighbourNext);
  stage.append(track);

  const NAV_UTILS =
    'absolute! top-1/2 -translate-y-1/2 z-[2] w-11 h-11 flex items-center justify-center text-white! bg-[rgba(0,0,0,0.35)]! rounded-[6px]! [&_.cyc-icon]:text-[1.5rem] ' +
    HEAD_FADE_UTILS;
  const btnPrev = makeIconButton(
    'previous',
    'cyc-imgview-nav cyc-imgview-prev start-2 ' + NAV_UTILS
  );
  const btnNext = makeIconButton('next', 'cyc-imgview-nav cyc-imgview-next end-2 ' + NAV_UTILS);
  overlay.append(header, stage, btnPrev, btnNext);

  // Zoom floor: even a small picture gets the 6x look-closer stretch. The real
  // ceiling is per picture: whatever scale puts one image pixel on one device
  // pixel, so a 7000px-wide chart on a phone can be read at full resolution
  // (under the old fixed 6 it could not, on most screens).
  const ZOOM_FLOOR = 6;
  // Ceiling on the baked raster (bakeSharp below): its device-px area may
  // reach at most this multiple of the stage content box's device-px area.
  // Sized so the real flagship case (a 7000px-wide chart read at device 1:1
  // on a phone, about 17x the viewport area) clears it with room, while a
  // pathological huge square can no longer bake a multi-hundred-MB raster.
  const BAKE_AREA_BUDGET = 32;
  let scale = 1,
    tx = 0,
    ty = 0;
  // The picture's natural pixel size, read when it decodes; zero until then
  // (in that window the zoom ceiling falls back to the floor).
  let natW = 0,
    natH = 0;
  // The upscale baked into the img's LAYOUT size (bakeSharp below). The browser
  // rasterizes an <img> at its layout size; a transform scale only stretches
  // that raster, so the transform carries scale/sharp and the rest is layout.
  let sharp = 1;
  const dpr = () => Math.max(1, window.devicePixelRatio || 1);
  // The box the picture actually fits within: the stage's padded CONTENT box.
  // The stage rect is its border box (it includes the p-[--cyc-imgview-pad]
  // padding and the safe-area bottom), so measuring it overshoots the fit;
  // the track cannot be measured either (it shrinks to the picture, so its
  // size IS the picture's, not the available room). clientWidth/Height minus
  // the computed paddings is the content box, whatever the padding resolves
  // to (the bottom one is a max() over env(safe-area-inset-bottom)).
  const contentBox = () => {
    if (!stage.clientWidth || !stage.clientHeight) return null;
    const cs = getComputedStyle(stage);
    const w =
      stage.clientWidth - ((parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0));
    const h =
      stage.clientHeight - ((parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0));
    if (w <= 0 || h <= 0) return null;
    return {w, h};
  };
  // The CSS box object-contain gives the picture at scale 1: contained in the
  // stage's content box, never above its natural CSS size (max-w-full/max-h-full).
  const fitBox = () => {
    if (!natW || !natH) return null;
    const box = contentBox();
    if (!box) return null;
    const s = Math.min(box.w / natW, box.h / natH, 1);
    return {w: natW * s, h: natH * s};
  };
  const maxZoom = () => {
    const fit = fitBox();
    if (!fit) return ZOOM_FLOOR;
    return Math.max(ZOOM_FLOOR, natW / (fit.w * dpr()));
  };
  const apply = () => {
    img.style.transform =
      scale === 1 && sharp === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale / sharp})`;

    stage.classList.toggle('cyc-imgview-zoomed', scale > 1);
  };
  const clearSharp = () => {
    sharp = 1;
    img.style.width = '';
    img.style.height = '';
    img.style.maxWidth = '';
    img.style.maxHeight = '';
  };
  // Bake the settled zoom into the img's layout size so the browser
  // re-rasterizes the picture at the size it is being looked at. Without this
  // the raster is the fit-size one (a phone-width strip for a wide chart) and
  // pinching in just stretches it: the full-resolution original paints as a
  // blurry thumbnail no matter what bytes arrived (WebKit never re-rasterizes
  // for a transform scale). Layout is capped at the picture's own pixels per
  // device pixel, so one full-resolution raster is the most this ever holds,
  // and only for the picture on stage; scale 1 puts the fit layout back.
  const bakeSharp = () => {
    const fit = fitBox();
    const box = contentBox();
    let cap = 1;
    if (fit && box) {
      // Never bake a raster whose device-px area tops BAKE_AREA_BUDGET times
      // the stage content box's device-px area (dpr cancels out of the ratio,
      // so CSS-px areas compare the same). A pathological huge picture stays
      // bounded by the viewer, not by its own pixels; the zoom ceiling is
      // untouched, past the budget the transform stretches the budget raster.
      const budgetCap = Math.sqrt((BAKE_AREA_BUDGET * box.w * box.h) / (fit.w * fit.h));
      cap = Math.max(1, Math.min(natW / (fit.w * dpr()), budgetCap));
    }
    const next = clampNumber(scale, 1, cap);
    if (next === sharp) return;
    if (next === 1 || !fit) {
      clearSharp();
    } else {
      sharp = next;
      img.style.maxWidth = 'none';
      img.style.maxHeight = 'none';
      img.style.width = `${fit.w * sharp}px`;
      img.style.height = `${fit.h * sharp}px`;
    }
    apply();
  };
  img.addEventListener('load', () => {
    natW = img.naturalWidth || 0;
    natH = img.naturalHeight || 0;
    // A new picture landed in this slot: back to the fit layout, and if the
    // viewer is already zoomed (a retry mid-zoom), bake for the new pixels.
    clearSharp();
    if (scale > 1) bakeSharp();
    apply();
  });
  const clampPan = () => {
    const r = stage.getBoundingClientRect();
    const limX = Math.max(0, (r.width * scale - r.width) / 2);
    const limY = Math.max(0, (r.height * scale - r.height) / 2);
    tx = Math.max(-limX, Math.min(limX, tx));
    ty = Math.max(-limY, Math.min(limY, ty));
  };
  const zoomTo = (next: number, cx: number, cy: number) => {
    const r = stage.getBoundingClientRect();
    const px = cx - r.left - r.width / 2;
    const py = cy - r.top - r.height / 2;
    const prev = scale;
    scale = Math.max(1, Math.min(maxZoom(), next));

    const k = scale / prev;
    tx = (tx - px) * k + px;
    ty = (ty - py) * k + py;
    if (scale === 1) {
      tx = 0;
      ty = 0;
    }
    clampPan();
    apply();
  };

  const points = new Map<number, {x: number; y: number}>();
  let startDist = 0,
    startScale = 1,
    lastX = 0,
    lastY = 0,
    lastTap = 0;

  let downX = 0,
    downY = 0,
    travelled = false;

  let dismissing = false;
  const TAP_SLOP = 8;

  const mid = () => {
    const p = [...points.values()];
    return {x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2};
  };
  const dist = () => {
    const p = [...points.values()];
    return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  };

  stage.addEventListener('pointerdown', (e) => {
    points.set(e.pointerId, {x: e.clientX, y: e.clientY});
    stage.setPointerCapture(e.pointerId);
    if (points.size === 2) {
      startDist = dist();
      startScale = scale;
    } else {
      lastX = e.clientX;
      lastY = e.clientY;
      downX = e.clientX;
      downY = e.clientY;
      travelled = false;
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!points.has(e.pointerId)) return;
    points.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > TAP_SLOP) travelled = true;
    if (points.size >= 2) {
      if (!startDist) return;
      const m = mid();
      zoomTo(startScale * (dist() / startDist), m.x, m.y);
      e.preventDefault();
      return;
    }
    if (scale === 1) return;
    tx += e.clientX - lastX;
    ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    clampPan();
    apply();
    e.preventDefault();
  });
  const up = (e: PointerEvent) => {
    points.delete(e.pointerId);
    if (points.size < 2) startDist = 0;
    // The gesture settled: rasterize the picture at the committed zoom.
    if (!points.size) bakeSharp();
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);

  img.addEventListener('click', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
      zoomTo(scale > 1 ? 1 : 2.5, e.clientX, e.clientY);
      bakeSharp();
      lastTap = 0;
      return;
    }
    lastTap = now;
  });

  let zoomWheelTimer: number | undefined;
  stage.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && Math.abs(e.deltaY) < 2) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomTo(scale * step, e.clientX, e.clientY);
      // A wheel run settles when it goes quiet; then rasterize at that zoom.
      window.clearTimeout(zoomWheelTimer);
      zoomWheelTimer = window.setTimeout(bakeSharp, IMG_WHEEL_QUIET_MS);
    },
    {passive: false}
  );

  const srcs = new Map<number, string>();
  const hows = new Map<number, ImageHow>();
  const minted: string[] = [];
  let closed = false;

  let card: HTMLDivElement | null = null;
  const clearCard = () => {
    card?.remove();
    card = null;
  };
  const showCard = (i: number, kind: StageCardKind, onTap: (() => void) | null) => {
    if (closed || i !== at) return;
    clearCard();
    card = buildStageCard(kind, onTap);
    track.append(card);
  };

  // The picture for slot `i` resolves the way the bubble did (the image cache
  // under the same key, then the caller's bytes, then a live local object URL,
  // then the wire behind the same gate); a resolved source is kept per slot so
  // paging back is free. `fresh` skips what this device held and fetches.
  function setSrc(el: HTMLImageElement, i: number, fresh = false) {
    el.dataset.want = String(i);
    el.alt = list[i].name;
    const had = srcs.get(i);
    if (had !== undefined) {
      if (el.getAttribute('src') !== had) el.src = had;
      return;
    }
    const item = list[i];
    const main = el === img;

    void resolveImageSource(
      {key: item.url, bytes: item.bytes, local: item.local},
      {
        fresh,
        onWaiting: () => {
          if (main && !card) showCard(i, 'waiting', null);
        }
      }
    ).then(
      (found) => {
        if (closed) {
          if (found.minted) URL.revokeObjectURL(found.src);
          return;
        }
        if (main && i === at) clearCard();
        let u = found.src;
        const winner = srcs.get(i);
        if (winner !== undefined) {
          if (found.minted) URL.revokeObjectURL(found.src);
          u = winner;
        } else {
          if (found.minted) minted.push(u);
          srcs.set(i, u);
          hows.set(i, found.how);
          cyclog('viewer.image.src', {
            key: item.url,
            how: found.how,
            scheme: srcScheme(u),
            name: item.name,
            fresh
          });
        }
        if (el.dataset.want === String(i)) el.src = u;
      },
      (err: unknown) => {
        if (closed) return;
        const reason = err instanceof ImageResolveError ? err.reason : `threw: ${String(err)}`;
        cyclog('viewer.image.error', {
          key: item.url,
          scheme: '(none)',
          reason,
          name: item.name,
          why:
            reason === 'gone'
              ? 'the engine answered that it no longer has this picture'
              : 'this device does not hold the picture and the wire did not come up, so the viewer shows tap to load instead of a broken picture'
        });
        if (!main || i !== at) return;
        if (reason === 'gone') showCard(i, 'gone', null);
        else showCard(i, 'tap', () => retry(i));
      }
    );
  }
  function retry(i: number, fresh = false) {
    if (closed || i !== at) return;
    clearCard();
    srcs.delete(i);
    hows.delete(i);
    setSrc(img, i, fresh);
  }

  // What the browser was handed did not decode. A source this device held (a
  // local object URL since revoked, a cache row that is not a picture) goes
  // straight back to the wire; a fetched one shows the tap card.
  const onImgError = (el: HTMLImageElement) => () => {
    if (closed) return;
    const i = Number(el.dataset.want);
    const item = list[i];
    if (!item) return;
    const src = el.getAttribute('src') ?? '';
    const how = hows.get(i);
    cyclog('viewer.image.error', {
      key: item.url,
      scheme: srcScheme(src),
      how: how ?? '(none)',
      reason: 'img-error',
      name: item.name,
      why: 'the browser could not decode what the viewer handed it'
    });
    if (srcs.get(i) === src) {
      srcs.delete(i);
      hows.delete(i);
    }
    if (el !== img || i !== at) return;
    el.removeAttribute('src');
    if (how === 'local' || how === 'cache' || how === 'bytes') retry(i, true);
    else showCard(i, 'tap', () => retry(i));
  };
  img.addEventListener('error', onImgError(img));
  neighbourPrev.addEventListener('error', onImgError(neighbourPrev));
  neighbourNext.addEventListener('error', onImgError(neighbourNext));

  const show = (to: number) => {
    if (to < 0 || to >= list.length || to === at) return;
    at = to;
    scale = 1;
    tx = 0;
    ty = 0;
    // The incoming picture's size lands with its own load event; until then
    // the slot has no fit box and the zoom ceiling is the floor.
    natW = 0;
    natH = 0;
    clearSharp();
    apply();
    clearCard();
    setSrc(img, at);
    paint();
  };
  function paint() {
    title.textContent = list[at].name;
    count.textContent = list.length > 1 ? `${at + 1} of ${list.length}` : '';
    btnPrev.classList.toggle('cyc-off', list.length < 2 || at === 0);
    btnNext.classList.toggle('cyc-off', list.length < 2 || at === list.length - 1);

    opts.onShow?.(list[at]);
  }
  paint();
  setSrc(img, at);
  btnPrev.addEventListener('click', (e) => {
    e.stopPropagation();
    show(at - 1);
  });
  btnNext.addEventListener('click', (e) => {
    e.stopPropagation();
    show(at + 1);
  });

  const neighbourOf = (dir: 1 | -1) => (dir > 0 ? neighbourNext : neighbourPrev);
  const clearNeighbours = () => {
    neighbourPrev.classList.add('cyc-off');
    neighbourNext.classList.add('cyc-off');
  };
  // Horizontal paging between images: a pointer drag or horizontal wheel stages the
  // neighbour image underneath and pages the track over to it. dir>0 goes to the
  // next image, dir<0 to the previous.
  const swipe = (() => {
    const surface = stage;
    const moves = track;
    const surfaceWidth = () => surface.clientWidth || 1;
    const enabled = () => list.length > 1 && scale === 1;
    const canGo = (dir: 1 | -1) =>
      scale === 1 && points.size < 2 && !dismissing && at + dir >= 0 && at + dir < list.length;
    const prepare = (dir: 1 | -1) => {
      const to = at + dir;
      if (to < 0 || to >= list.length) return false;
      const neighbour = neighbourOf(dir);
      setSrc(neighbour, to);
      neighbour.classList.remove('cyc-off');
      return true;
    };
    const runGo = (dir: 1 | -1) => {
      show(at + dir);
      clearNeighbours();
    };

    let prepared: 1 | -1 | 0 = 0;
    let windowToken = 0;
    const openWindow = () => {
      if (!windowToken) windowToken = interactionWindow.begin('gesture', 'imageViewer');
    };
    const closeWindow = () => {
      if (windowToken) {
        interactionWindow.end(windowToken);
        windowToken = 0;
      }
    };
    const paint = (offset: number, animate: boolean, w: number = surfaceWidth()) => {
      moves.style.transition = animate
        ? `transform ${IMG_ANIM_MS}ms ease, opacity ${IMG_ANIM_MS}ms ease`
        : 'none';
      moves.style.transform = offset === 0 ? '' : `translateX(${offset}px)`;
      moves.style.opacity =
        !offset || prepared ? '' : String(Math.max(0.4, 1 - Math.abs(offset) / w));
    };
    const releasePrepared = () => {
      if (!prepared) return;
      prepared = 0;
      window.setTimeout(() => {
        if (!prepared) clearNeighbours();
      }, IMG_ANIM_MS);
    };

    // Wheel paging.
    let wheelOffset = 0;
    let quietTimer: number | undefined;
    let cooling = false;
    let cooldownDir: 1 | -1 = 1;
    let baseWidth = 0;
    let wheelOpen = false;
    const finishWheel = () => {
      wheelOffset = 0;
      cooling = false;
      baseWidth = 0;
      paint(0, true);
      releasePrepared();
      if (wheelOpen) {
        wheelOpen = false;
        closeWindow();
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (!enabled()) return;
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(finishWheel, IMG_WHEEL_QUIET_MS);
      const incomingDir: 1 | -1 = e.deltaX > 0 ? 1 : -1;
      if (cooling) {
        if (incomingDir === cooldownDir) return;
        cooling = false;
        wheelOffset = 0;
      }
      e.preventDefault();
      const dir: 1 | -1 = wheelOffset - e.deltaX < 0 ? 1 : -1;
      if (!canGo(dir)) {
        wheelOffset = 0;
        paint(0, false);
        return;
      }
      wheelOffset -= e.deltaX;
      if (prepared !== dir && prepare(dir)) prepared = dir;
      if (!baseWidth) baseWidth = surfaceWidth();
      if (!wheelOpen) {
        wheelOpen = true;
        openWindow();
      }
      paint(clampNumber(imgSlop(wheelOffset), -baseWidth, baseWidth), false, baseWidth);
      const w = baseWidth;
      const commitAt = Math.min(w * IMG_WHEEL_COMMIT_FRACTION, IMG_WHEEL_COMMIT_CAP_PX);
      if (Math.abs(wheelOffset) <= commitAt) return;
      cooling = true;
      cooldownDir = dir;
      paint(dir > 0 ? -w : w, true, w);
      window.setTimeout(() => {
        runGo(dir);
        prepared = 0;
        paint(0, false);
      }, IMG_ANIM_MS);
    };
    surface.addEventListener('wheel', onWheel, {passive: false});

    // Pointer drag.
    let pointerId: number | null = null;
    let originX = 0;
    let originY = 0;
    let armed = false;
    let dragOffset = 0;
    let dragOpen = false;
    const advance = (dx: number) => {
      dragOffset = dx;
      const dir: 1 | -1 = dragOffset < 0 ? 1 : -1;
      if (!canGo(dir)) {
        dragOffset = 0;
        paint(0, false);
        return;
      }
      if (!dragOpen) {
        dragOpen = true;
        openWindow();
      }
      if (prepared !== dir && prepare(dir)) prepared = dir;
      paint(clampNumber(imgSlop(dragOffset), -surfaceWidth(), surfaceWidth()), false);
    };
    const release = () => {
      const w = surfaceWidth();
      const dir: 1 | -1 = dragOffset < 0 ? 1 : -1;
      const commit = Math.abs(dragOffset) > IMG_COMMIT_PX && canGo(dir);
      if (dragOpen) {
        dragOpen = false;
        closeWindow();
      }
      dragOffset = 0;
      if (!commit) {
        paint(0, true);
        releasePrepared();
        return;
      }
      paint(dir > 0 ? -w : w, true);
      setTimeout(() => {
        runGo(dir);
        prepared = 0;
        paint(0, false);
      }, IMG_ANIM_MS);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const dx = e.clientX - originX;
      const dy = e.clientY - originY;
      if (!armed) {
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        if (Math.hypot(dx, dy) < IMG_ARM_PX) return;
        if (absX >= absY * IMG_ARM_RATIO) {
          armed = true;
          surface.setPointerCapture?.(e.pointerId);
        } else if (absY > absX) {
          finishPointer();
          return;
        } else return;
      }
      e.preventDefault();
      advance(dx);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId === pointerId) finishPointer();
    };
    function finishPointer() {
      if (pointerId === null) return;
      const id = pointerId;
      pointerId = null;
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerup', onUp);
      surface.removeEventListener('pointercancel', onUp);
      if (surface.hasPointerCapture?.(id)) surface.releasePointerCapture(id);
      const wasArmed = armed;
      armed = false;
      if (wasArmed) release();
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || pointerId !== null || !enabled()) return;
      pointerId = e.pointerId;
      originX = e.clientX;
      originY = e.clientY;
      armed = false;
      surface.addEventListener('pointermove', onMove);
      surface.addEventListener('pointerup', onUp);
      surface.addEventListener('pointercancel', onUp);
    };
    surface.addEventListener('pointerdown', onDown);

    return {
      removeListeners() {
        finishPointer();
        surface.removeEventListener('pointerdown', onDown);
        surface.removeEventListener('wheel', onWheel);
      }
    };
  })();

  let teardownDismiss: (() => void) | null = null;

  let told = false;

  const done = () => {
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', onPop);
    window.clearTimeout(zoomWheelTimer);
    teardownDismiss?.();
    teardownDismiss = null;

    swipe.removeListeners();
    overlay.remove();

    closed = true;
    for (const u of minted) URL.revokeObjectURL(u);
    minted.length = 0;
    srcs.clear();
    hows.clear();

    if (close === done) close = null;

    if (!told) {
      told = true;
      opts.onClose?.();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      done();
      return;
    }
    if (!e.key.startsWith('Arrow')) return;

    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      show(at + (e.key === 'ArrowRight' ? 1 : -1));
  };

  const onPop = () => done();

  btnClose.addEventListener('click', done);

  overlay.addEventListener('click', (e) => {
    if (scale > 1) return;

    if (travelled) {
      travelled = false;
      return;
    }
    if (e.target === overlay || e.target === stage || e.target === track) done();
  });
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('popstate', onPop);

  if (touchCapable) {
    // Pointer travel (px) before the drag arms, and the extra vertical travel
    // (past the arm) that must accrue before we commit to a downward dismiss.
    const ARM_SLOP = 8;
    const AXIS_SLOP = 20;
    const VELOCITY_K = 0.1;
    const height = () => overlay.clientHeight || 1;
    const closeOn = () => Math.min(125, height() * 0.2);

    let dismissId: number | null = null;
    let dsDownX = 0;
    let dsDownY = 0;
    let dsArmed = false;
    let axisY = false;
    let dragY = 0;
    let lastDy = 0;
    let startedAt = 0;

    let lastMoveAt = 0,
      lastFrameMs = 1;

    let cancelled = false;

    const setDrag = (y: number, animate: boolean) => {
      stage.style.transition = animate ? `transform ${IMG_ANIM_MS}ms ease` : 'none';
      overlay.style.transition = animate ? `background-color ${IMG_ANIM_MS}ms ease` : 'none';
      const f = y ? Math.max(0.4, 1 - y / height()) : 1;
      stage.style.transform = y ? `translateY(${y}px) scale(${f})` : '';
      // Was the `--cyc-imgview-fade` var feeding `.cyc-imgview`'s rgba scrim;
      // paint the faded scrim inline instead (clearing falls back to the 0.92
      // resting class).
      overlay.style.backgroundColor = y ? `rgba(0, 0, 0, ${0.92 * f})` : '';
      overlay.classList.toggle('cyc-imgview-dragging', !!y);
    };

    // The drag streams the raw vertical delta; a release (or projected fling)
    // past `closeOn` slides the stage out and closes the viewer.
    const upDismiss = () => {
      const y = dragY;
      axisY = false;
      dragY = 0;

      dismissing = false;

      if (!y) return;

      if (cancelled) {
        setDrag(0, true);
        return;
      }

      const now = Date.now();
      const recentDy = (lastDy * lastFrameMs) / Math.max(lastFrameMs, now - lastMoveAt);
      const elapsed = Math.max(1, now - startedAt);
      const v = y / elapsed;
      const projected = y + y * v * VELOCITY_K * recentDy;
      if (projected <= closeOn()) {
        setDrag(0, true);
        return;
      }

      overlay.style.pointerEvents = 'none';
      stage.style.transition = `transform ${IMG_ANIM_MS}ms ease`;
      overlay.style.transition = `background-color ${IMG_ANIM_MS}ms ease`;
      stage.style.transform = `translateY(${height()}px) scale(.4)`;
      overlay.style.backgroundColor = 'rgba(0, 0, 0, 0)';
      window.setTimeout(done, IMG_ANIM_MS);
    };

    const dismissMove = (e: PointerEvent) => {
      if (e.pointerId !== dismissId) return;
      const xDiff = e.clientX - dsDownX;
      const yDiff = e.clientY - dsDownY;
      if (!dsArmed) {
        if (Math.abs(xDiff) < ARM_SLOP && Math.abs(yDiff) < ARM_SLOP) return;
        dsArmed = true;
        stage.setPointerCapture?.(e.pointerId);
      }

      if (!axisY) {
        if (Math.abs(yDiff) <= AXIS_SLOP) return;
        // A horizontal lead belongs to the paging swipe, not us: bow out.
        if (Math.abs(xDiff) > Math.abs(yDiff)) return endDismiss();
        axisY = dismissing = true;
        dragY = Math.max(0, yDiff);
      }

      if (scale !== 1 || points.size >= 2) {
        dragY = 0;
        setDrag(0, true);
        return endDismiss();
      }
      // Capturing the pointer keeps the vertical drag ours while it runs.
      e.preventDefault();
      const y = Math.max(0, yDiff);
      const now = Date.now();
      lastFrameMs = Math.max(1, now - lastMoveAt);
      lastMoveAt = now;
      lastDy = y - dragY;
      dragY = y;
      setDrag(dragY, false);
    };

    const dismissUp = (e: PointerEvent) => {
      if (e.pointerId !== dismissId) return;
      cancelled = e.type === 'pointercancel';
      endDismiss();
      cancelled = false;
    };

    function endDismiss() {
      if (dismissId === null) return;
      const id = dismissId;
      dismissId = null;
      stage.removeEventListener('pointermove', dismissMove);
      stage.removeEventListener('pointerup', dismissUp);
      stage.removeEventListener('pointercancel', dismissUp);
      if (stage.hasPointerCapture?.(id)) stage.releasePointerCapture(id);
      const wasArmed = dsArmed;
      dsArmed = false;
      if (wasArmed) upDismiss();
    }

    const dismissDown = (e: PointerEvent) => {
      if (e.button !== 0 || dismissId !== null) return;
      if (scale !== 1 || points.size >= 2) return;
      dismissId = e.pointerId;
      dsDownX = e.clientX;
      dsDownY = e.clientY;
      dsArmed = false;
      axisY = false;
      dragY = lastDy = 0;
      startedAt = lastMoveAt = Date.now();
      lastFrameMs = 1;
      stage.addEventListener('pointermove', dismissMove);
      stage.addEventListener('pointerup', dismissUp);
      stage.addEventListener('pointercancel', dismissUp);
    };

    stage.addEventListener('pointerdown', dismissDown);
    teardownDismiss = () => {
      endDismiss();
      stage.removeEventListener('pointerdown', dismissDown);
    };
  }

  (document.getElementById('cyc-stage') ?? document.body).append(overlay);
  close = done;
}
