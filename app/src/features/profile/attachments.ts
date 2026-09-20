import type {CycMediaItem} from '@/types';
import {
  formatBytes,
  paintDocIcon,
  setTunnelSrc,
  DOC_BASE_UTILS,
  DOC_ICO_UTILS,
  DOC_SIZE_UTILS
} from '@/features/media/mediaBox';
import {MEDIA_SECONDARY_TEXT, MEDIA_SURFACE_BG, paintOnTheme} from '@/features/media/mediaPaint';
import {engineCapFetch} from '@/engine/contract';
import {dayLabel} from '@/features/chat/content';
import {h} from '@/components/domHelpers';
import {makeIcon} from '@/components/iconGlyphs';

type ProfileAttachments = {
  el: HTMLElement;
  update: (items: CycMediaItem[]) => void;

  retryUnreachable: () => void;
  destroy: () => void;
};

type Tab = 'media' | 'files';

const AT_ONCE = 4;

const TABS_UTILS =
  'relative z-[2] flex h-12 w-full flex-auto items-center justify-around py-1 text-[var(--cyc-text-muted)] bg-[var(--cyc-surface)]';
const TAB_UTILS =
  'relative mx-1 flex h-full min-w-px flex-auto cursor-pointer items-center justify-center rounded-xl px-4 text-center text-base font-medium leading-[1.3]';
const TAB_HOVER_UTILS =
  'fine:hover:bg-(--cyc-text-muted-tint)! fine:active:bg-(--cyc-text-muted-tint)!';
const TAB_BG_UTILS =
  'pointer-events-none absolute inset-0 z-[1] rounded-[inherit] bg-[var(--cyc-text-muted-tint)] opacity-0';
const TAB_LABEL_UTILS =
  'relative z-[2] inline-flex items-center overflow-visible pointer-events-none whitespace-nowrap';

export function createProfileAttachments(opts: {
  onOpen: (item: CycMediaItem) => void;

  loadOlder?: () => Promise<boolean>;
}): ProfileAttachments {
  const el = h('div', 'cyc-account-attachments self-stretch mt-6');

  const navWrap = h(
    'div',
    'cyc-account-attachments-navwrap sticky -top-8 z-[2] mt-0 -mx-4 mb-3 pt-8 px-4 pb-2 bg-[var(--cyc-surface)]'
  );
  const nav = h(
    'div',
    'cyc-account-attachments-nav cyc-segstrip-scroll m-0 h-12 overflow-hidden rounded-3xl bg-[var(--cyc-surface)] shadow-[0px_2px_6px_0px_rgba(17,20,26,0.09)]'
  );
  const navScroll = h('div', 'cyc-overflow-x');
  const tabsEl = h('nav', 'cyc-shared-tabs cyc-segstrip ' + TABS_UTILS);
  navScroll.append(tabsEl);
  nav.append(navScroll);
  navWrap.append(nav);

  const content = h('div', 'cyc-account-attachments-content');
  const grid = h(
    'div',
    'cyc-shared-grid grid w-full grid-cols-3 auto-rows-[1fr] gap-1 overflow-hidden rounded-[24px]'
  );
  const files = h('div', 'cyc-shared-files');

  const sentinel = h('div', 'cyc-account-attachments-sentinel h-px');
  content.append(grid, files, sentinel);

  const empty = h(
    'div',
    'cyc-account-attachments-empty text-center px-2 py-4 text-[0.9375rem] text-[color:var(--cyc-text-muted)]'
  );
  empty.textContent = 'Nothing has been shared in this conversation yet';

  el.append(navWrap, content, empty);

  const tabButtons = new Map<Tab, HTMLElement>();
  for (const [tab, label] of [
    ['media', 'Media'],
    ['files', 'Files']
  ] as [Tab, string][]) {
    const item = h('div', 'cyc-seg ' + TAB_HOVER_UTILS + ' ' + TAB_UTILS);
    item.dataset.tab = tab;
    const bg = h('i', 'cyc-seg-bg ' + TAB_BG_UTILS);
    const span = h('span', 'cyc-seg-label ' + TAB_LABEL_UTILS);
    span.textContent = label;
    item.append(bg, span);
    item.addEventListener('click', () => {
      chosen = tab;
      pick(tab);
    });
    tabsEl.append(item);
    tabButtons.set(tab, item);
  }

  let tab: Tab = 'media';

  let chosen: Tab | null = null;

  let sig: string | null = null;

  const gone = new Set<string>();

  const unreachable = new Map<HTMLElement, () => void>();

  const tilesByKey = new Map<string, HTMLElement>();
  const rowsByKey = new Map<string, HTMLElement>();

  let hasMore = true;

  let loadingOlder = false;
  let lastItemCount = 0;

  const moreIo = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          void maybeOlder();
          break;
        }
    },
    {root: null, rootMargin: '300px'}
  );
  moreIo.observe(sentinel);

  function paintShell(itemCount: number) {
    const waiting = itemCount === 0 && !!opts.loadOlder && hasMore;
    empty.classList.toggle('cyc-off', itemCount > 0 || waiting);
    content.classList.toggle('cyc-off', itemCount === 0 && !waiting);
  }

  function maybeOlder(): Promise<void> {
    if (loadingOlder || !hasMore || !opts.loadOlder) return Promise.resolve();
    loadingOlder = true;
    return opts.loadOlder().then(
      (more) => {
        hasMore = more;
        loadingOlder = false;
        paintShell(lastItemCount);
        if (hasMore) {
          moreIo.unobserve(sentinel);
          moreIo.observe(sentinel);
        }
      },
      () => {
        loadingOlder = false;
      }
    );
  }

  let io: IntersectionObserver | null = null;
  const pending = new Map<Element, () => void>();
  const queue: (() => Promise<void>)[] = [];
  let running = 0;

  function pump() {
    while (running < AT_ONCE && queue.length) {
      const job = queue.shift()!;
      running++;
      void job().finally(() => {
        running--;
        pump();
      });
    }
  }

  function whenVisible(node: HTMLElement, load: () => Promise<void>) {
    io ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const start = pending.get(e.target);
          if (!start) continue;
          pending.delete(e.target);
          io!.unobserve(e.target);
          start();
        }
      },
      {root: null, rootMargin: '200px'}
    );
    pending.set(node, () => {
      queue.push(load);
      pump();
    });
    io.observe(node);
  }

  const isSwept = (url: string) =>
    engineCapFetch(url, {method: 'HEAD', signal: AbortSignal.timeout(8000)})
      .then((r) => r.status === 404)
      .catch(() => false);

  function imageTile(item: CycMediaItem): HTMLElement {
    const tile = h('div', 'cyc-tile cyc-media-tile cursor-pointer bg-[var(--cyc-text-muted-tint)]');
    tile.dataset.key = item.key;
    tile.addEventListener('click', () => {
      if (tile.classList.contains('cyc-media-gone')) return;

      if (tile.classList.contains('cyc-media-unreachable')) {
        load();
        return;
      }
      opts.onOpen(item);
    });
    if (gone.has(item.key) || !item.url) {
      markTileGone(tile, item);
      return tile;
    }

    function load() {
      tile.textContent = '';
      tile.classList.remove('cyc-media-unreachable');
      tile.removeAttribute('title');
      unreachable.delete(tile);
      const img = h('img', 'cyc-grid-media block w-full h-full object-cover') as HTMLImageElement;
      img.alt = item.name;
      img.decoding = 'async';
      tile.append(img);
      whenVisible(
        tile,
        () =>
          new Promise<void>((done) => {
            if (!tile.isConnected) {
              done();
              return;
            }
            img.addEventListener('load', () => done(), {once: true});
            img.addEventListener(
              'error',
              () => {
                img.remove();
                void isSwept(item.url).then((swept) => {
                  if (swept) {
                    gone.add(item.key);
                    markTileGone(tile, item);
                  } else {
                    unreachable.set(tile, load);
                    markTileUnreachable(tile, item);
                  }
                  done();
                });
              },
              {once: true}
            );

            setTunnelSrc(img, item.url);
          })
      );
    }

    load();
    return tile;
  }

  const ALL_MEDIA_SURFACE_BG = Object.values(MEDIA_SURFACE_BG);
  const ALL_MEDIA_SECONDARY_TEXT = Object.values(MEDIA_SECONDARY_TEXT);
  function markTileGone(tile: HTMLElement, item: CycMediaItem) {
    tile.classList.remove('cursor-pointer', 'bg-[var(--cyc-text-muted-tint)]');
    tile.classList.add(
      'cyc-media-gone',
      'text-center',
      'cursor-default',
      'min-h-0',
      'pt-0',
      'px-0',
      'pb-[100%]',
      'border-0',
      'rounded-none'
    );
    paintOnTheme(tile, ALL_MEDIA_SURFACE_BG, (t) => MEDIA_SURFACE_BG[t]);
    paintOnTheme(tile, ALL_MEDIA_SECONDARY_TEXT, (t) => MEDIA_SECONDARY_TEXT[t]);
    tile.title = `${item.name} is no longer on the engine`;
    tile.append(tileNote('image', 'gone'));
  }

  function markTileUnreachable(tile: HTMLElement, item: CycMediaItem) {
    tile.classList.add('cyc-media-unreachable');
    paintOnTheme(tile, ALL_MEDIA_SECONDARY_TEXT, (t) => MEDIA_SECONDARY_TEXT[t]);
    tile.title = `${item.name} could not be fetched. Tap to try again.`;
    tile.append(tileNote('download', 'not loaded'));
  }

  function tileNote(glyph: 'image' | 'download', text: string): HTMLElement {
    const box = h(
      'div',
      'cyc-media-gone-inner absolute inset-0 flex flex-col items-center justify-center gap-0.5'
    );
    box.append(makeIcon(glyph, 'cyc-media-gone-icon text-2xl leading-none opacity-55'));
    const label = h('div', 'cyc-media-gone-label text-[0.6875rem] opacity-75');
    label.textContent = text;
    box.append(label);
    return box;
  }

  function docRow(item: CycMediaItem): HTMLElement {
    const dot = item.name.lastIndexOf('.');
    const ext = (dot > 0 ? item.name.slice(dot + 1) : 'file').toLowerCase().slice(0, 4) || 'file';
    const row = h(
      'div',
      `cyc-account-document cyc-doc cyc-ext-${ext} ${DOC_BASE_UTILS} h-[calc(48px+1.5rem)] relative pe-2 rounded-lg`
    );
    row.dataset.key = item.key;
    const ico = h('div', 'cyc-doc-ico rounded-[5px]! ' + DOC_ICO_UTILS);
    paintDocIcon(ico, ext, false);
    const icoText = h('span', 'cyc-doc-ico-text');
    icoText.textContent = ext;
    ico.append(icoText);
    const name = h(
      'div',
      'cyc-doc-name whitespace-nowrap text-ellipsis overflow-hidden font-normal w-full max-w-full text-[length:1rem] leading-[21px]'
    );
    name.textContent = item.name;
    const size = h('div', 'cyc-doc-size ' + DOC_SIZE_UTILS);
    size.textContent = `${formatBytes(item.size)} · ${dayLabel(item.ts)}`;
    row.append(ico, name, size);
    row.addEventListener('click', () => {
      if (row.classList.contains('cyc-doc-gone')) return;
      opts.onOpen(item);
    });

    if (gone.has(item.key) || !item.url) {
      markRowGone(row, size);
      return row;
    }

    whenVisible(row, async () => {
      if (!(await isSwept(item.url))) return;
      gone.add(item.key);
      markRowGone(row, size);
    });
    return row;
  }

  function markRowGone(row: HTMLElement, size: HTMLElement) {
    row.classList.remove('cursor-pointer');
    row.classList.add('cyc-doc-gone', 'cursor-default', 'opacity-60');
    size.classList.add('italic');
    size.textContent = 'no longer on the engine';
  }

  function pick(next: Tab) {
    tab = next;
    for (const [t, btn] of tabButtons) btn.classList.toggle('active', t === tab);
    grid.classList.toggle('cyc-off', tab !== 'media');
    files.classList.toggle('cyc-off', tab !== 'files');
    refresh();
  }

  function refresh() {
    if (!io) return;
    for (const node of pending.keys()) io.observe(node);
  }

  function dropNode(node: HTMLElement) {
    io?.unobserve(node);
    pending.delete(node);
    unreachable.delete(node);
  }

  function reconcile(
    container: HTMLElement,
    desired: CycMediaItem[],
    make: (item: CycMediaItem) => HTMLElement,
    byKey: Map<string, HTMLElement>
  ) {
    const want = new Set(desired.map((i) => i.key));
    for (const [key, node] of byKey) {
      if (!want.has(key)) {
        dropNode(node);
        node.remove();
        byKey.delete(key);
      }
    }
    let ref = container.firstChild;
    for (const item of desired) {
      let node = byKey.get(item.key);
      if (!node) {
        node = make(item);
        byKey.set(item.key, node);
      }
      if (node === ref) ref = ref.nextSibling;
      else container.insertBefore(node, ref);
    }
  }

  function update(items: CycMediaItem[]) {
    const next = items.map((i) => i.key).join(',');
    lastItemCount = items.length;
    if (next === sig) {
      refresh();
      paintShell(items.length);
      if (items.length === 0 && opts.loadOlder && hasMore) void maybeOlder();
      return;
    }
    sig = next;

    hasMore = true;

    const images = items.filter((i) => i.kind === 'image');
    const docs = items.filter((i) => i.kind === 'doc');

    reconcile(grid, [...images].reverse(), imageTile, tilesByKey);
    reconcile(files, [...docs].reverse(), docRow, rowsByKey);

    paintShell(items.length);

    const both = images.length > 0 && docs.length > 0;
    navWrap.classList.toggle('cyc-off', !both);
    tabButtons.get('media')!.classList.toggle('cyc-off', images.length === 0);
    tabButtons.get('files')!.classList.toggle('cyc-off', docs.length === 0);

    const keep =
      chosen === 'files' && docs.length
        ? 'files'
        : chosen === 'media' && images.length
          ? 'media'
          : images.length
            ? 'media'
            : 'files';
    pick(keep);
  }

  function retryUnreachable() {
    if (!unreachable.size) return;
    const again = [...unreachable.values()];
    unreachable.clear();
    for (const load of again) load();
  }

  function destroy() {
    io?.disconnect();
    io = null;
    moreIo.disconnect();
    pending.clear();
    queue.length = 0;
    unreachable.clear();
    tilesByKey.clear();
    rowsByKey.clear();
  }

  update([]);
  return {el, update, retryUnreachable, destroy};
}
