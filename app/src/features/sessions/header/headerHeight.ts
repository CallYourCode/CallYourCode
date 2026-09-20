// Header height from viewport bucket and extra-row count.

import {paintPresentation} from '../../../components/presentation';

export type HeaderWidthBucket = 'subphone' | 'phone' | 'wide';

export function headerWidthBucket(vw: number): HeaderWidthBucket {
  if (vw <= 360) return 'subphone';
  if (vw <= 550) return 'phone';
  return 'wide';
}

function headerHeightRem(bucket: HeaderWidthBucket, extra: number): string {
  if (bucket === 'wide') {
    if (extra === 1) return '7.125';
    if (extra === 2) return '10.25';
    return '4';
  }
  if (extra === 0) return '3.625';
  if (extra === 1) return '6.625';
  if (extra === 2) return '9.9375';
  return bucket === 'subphone' ? '9.9375' : '6.625';
}

export function headerHeightValue(bucket: HeaderWidthBucket, extra: number): string {
  return `calc(${headerHeightRem(bucket, extra)}rem + var(--cyc-safe-top))`;
}

// Count of live raw-resize hooks (see below). Introspection for tests, mirroring
// presentation.ts's painterCount helpers; nothing in production reads it.
let rawResizeHooks = 0;
export function headerResizePainterCount(): number {
  return rawResizeHooks;
}

// Paint `--cyc-chat-header-height` on the owning `.cyc-thread`. Extra resize hook covers the 360px edge.
export function paintHeaderHeight(headerEl: HTMLElement): (extra: number) => void {
  let lastExtra = 0;
  const paint = () => {
    const chat = headerEl.closest<HTMLElement>('.cyc-thread');
    if (!chat) return;
    const vw = typeof window === 'undefined' ? 0 : window.innerWidth;
    chat.style.setProperty(
      '--cyc-chat-header-height',
      headerHeightValue(headerWidthBucket(vw), lastExtra)
    );
  };
  paintPresentation(headerEl, paint);

  if (typeof window !== 'undefined') {
    let lastBucket = headerWidthBucket(window.innerWidth);
    rawResizeHooks++;
    const onResize = () => {
      if (!headerEl.isConnected) {
        window.removeEventListener('resize', onResize);
        rawResizeHooks--;
        return;
      }
      const bucket = headerWidthBucket(window.innerWidth);
      if (bucket === lastBucket) return;
      lastBucket = bucket;
      paint();
    };
    window.addEventListener('resize', onResize);
  }

  return (extra: number) => {
    lastExtra = extra;
    paint();
  };
}
