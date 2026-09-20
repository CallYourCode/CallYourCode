import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

vi.mock('../engine/contract', () => ({
  engineObjectUrl: vi.fn((url: string) => Promise.resolve(url)),
  engineCapFetch: vi.fn(() => Promise.resolve({status: 200, ok: true}) as any),
  // the wire gate: up at once here (the gate itself is covered by cycMediaWireGate)
  whenEngineReady: vi.fn(() => Promise.resolve(true)),
  docUrl: (id: string) => `doc://${id}`
}));

import {engineCapFetch, engineObjectUrl} from '../engine/contract';
import {
  markMissingOnError,
  paintDocIcon,
  reserveMediaBox,
  setTunnelSrc
} from '../features/media/mediaBox';
import {createProfileAttachments} from '../features/profile/attachments';
import {renderMarkdown} from '../features/media/pageRenderer';
import {openImageViewer} from '../features/media/imageViewer';
import {openFileViewer} from '../features/media/fileViewer';
import {downloadMessage} from '../features/chat/messages/fileMessages';
import {attachmentMessage} from '../features/chat/messages/attachmentMessages';
import {photoMessage} from '../features/chat/messages/messageContent';
import {
  installPresentationReactivity,
  setPresentationTheme,
  themePainterCount
} from '../components/presentation';
import type {CycMediaItem} from '../types';

const cls = (el: Element | null) => el?.className ?? '';
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

class FakeIO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  (globalThis as any).IntersectionObserver = FakeIO;
  (URL as any).createObjectURL = vi.fn(() => 'blob:test');
  (URL as any).revokeObjectURL = vi.fn();
  (engineObjectUrl as any).mockImplementation((url: string) => Promise.resolve(url));
  (engineCapFetch as any).mockImplementation(() => Promise.resolve({status: 200, ok: true}));
  document.body.innerHTML = '';
  setPresentationTheme('day');
});
afterEach(() => {
  setPresentationTheme('day');
  document.body.innerHTML = '';
});

describe('document icon fill (was .cyc-doc.cyc-ext-* / .cyc-doc-submit --cyc-background-color)', () => {
  const mkIco = () => {
    const ico = document.createElement('div');
    document.body.append(ico);
    return ico;
  };

  test('zip and pdf paint theme-invariant literal fills; other extensions use primary', () => {
    const zip = mkIco();
    paintDocIcon(zip, 'zip', false);
    expect(cls(zip)).toContain('bg-[#b9772e]');
    const pdf = mkIco();
    paintDocIcon(pdf, 'pdf', false);
    expect(cls(pdf)).toContain('bg-[#b23a34]');
    const apk = mkIco();
    paintDocIcon(apk, 'apk', false);
    expect(cls(apk)).toContain('bg-[#96602f]');
    setPresentationTheme('night');
    expect(cls(zip)).toContain('bg-[#b9772e]');
  });

  test('any other extension paints the themed copper primary, repainted on flip', () => {
    const ico = mkIco();
    paintDocIcon(ico, 'txt', false);
    expect(cls(ico)).toContain('bg-[#96602f]');
    setPresentationTheme('night');
    expect(cls(ico)).toContain('bg-[#c98652]');
    expect(cls(ico)).not.toContain('bg-[#96602f]');
  });

  test('a page-answer submit doc forces primary over its extension colour', () => {
    const ico = mkIco();
    paintDocIcon(ico, 'pdf', true);
    expect(cls(ico)).toContain('bg-[#96602f]');
    expect(cls(ico)).not.toContain('bg-[#b23a34]');
  });
});

describe('media box reservation (was .cyc-media-reserve / .cyc-media-unknown)', () => {
  test('known dimensions reserve the intrinsic aspect and cap the height', () => {
    const box = document.createElement('div');
    reserveMediaBox(box, 96, 64);
    expect(cls(box)).toContain('cyc-media-reserve');
    expect(cls(box)).toContain('h-auto');
    expect(cls(box)).toContain('max-h-[22rem]');
    expect(cls(box)).toContain('rounded-[6px]!');
    expect(box.style.aspectRatio).toBe('96 / 64');
    expect(cls(box)).not.toContain('cyc-media-unknown');
  });

  test('unknown dimensions fall back to the 4/3 placeholder aspect', () => {
    const box = document.createElement('div');
    reserveMediaBox(box);
    expect(cls(box)).toContain('cyc-media-unknown');
    expect(box.style.aspectRatio).toBe('4 / 3');
  });
});

describe('photo load lifecycle (was .cyc-media-await / .cyc-media-loading)', () => {
  test('a photo hides until its bytes arrive, then reveals on load', async () => {
    const box = document.createElement('div');
    box.className = 'cyc-annex cyc-media-box';
    const img = document.createElement('img');
    img.className = 'cyc-still';
    box.append(img);
    document.body.append(box);

    setTunnelSrc(img, 'http://x/a.png');
    expect(img.classList.contains('invisible')).toBe(true);
    await flush();
    img.dispatchEvent(new Event('load'));
    expect(img.classList.contains('invisible')).toBe(false);
  });

  test('a grid tile (not a photo) is never hidden while it loads', async () => {
    const tile = document.createElement('div');
    tile.className = 'cyc-media-tile';
    const img = document.createElement('img');
    img.className = 'cyc-grid-media';
    tile.append(img);
    document.body.append(tile);

    setTunnelSrc(img, 'http://x/b.png');
    expect(img.classList.contains('invisible')).toBe(false);
  });

  test('a transient fetch retry shows the themed shimmer on the box, cleared on success', async () => {
    let calls = 0;
    (engineObjectUrl as any).mockImplementation((url: string) => {
      calls++;
      return calls === 1 ? Promise.reject({status: 500}) : Promise.resolve(url);
    });
    vi.useFakeTimers();
    const box = document.createElement('div');
    box.className = 'cyc-annex cyc-media-box';
    const img = document.createElement('img');
    img.className = 'cyc-still';
    box.append(img);
    document.body.append(box);

    setTunnelSrc(img, 'http://x/c.png');
    // the cache lookup and the wire gate sit in front of the first attempt
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(cls(box)).toContain('bg-[#ffffff]');
    expect(cls(box)).toContain('[animation:cyc-media-pulse_1.4s_ease-in-out_infinite]');
    await vi.advanceTimersByTimeAsync(600);
    await flush();
    expect(cls(box)).not.toContain('bg-[#ffffff]');
    expect(cls(box)).not.toContain('[animation:cyc-media-pulse_1.4s_ease-in-out_infinite]');
    vi.useRealTimers();
  });
});

describe('404/gone photo card (was buildMediaFailCard, engine 404 -> gone)', () => {
  test('a 404 on the media URL renders the gone card and drops the reserved aspect', async () => {
    (engineCapFetch as any).mockImplementation(() => Promise.resolve({status: 404, ok: false}));
    const holder = document.createElement('div');
    holder.className = 'cyc-annex cyc-media-box cyc-media-unknown';
    holder.style.aspectRatio = '4 / 3';
    const img = document.createElement('img');
    img.className = 'cyc-still';
    holder.append(img);
    document.body.append(holder);

    markMissingOnError(img);
    img.dataset.cycMediaUrl = 'http://x/gone.png';
    img.dispatchEvent(new Event('error'));
    await flush();

    const card = holder.querySelector('.cyc-media-gone');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('no longer on disk');
    expect(holder.style.aspectRatio).toBe('auto');
    expect(holder.classList.contains('cyc-media-unknown')).toBe(false);
  });

  test('a served-but-undecodable image reports the undecodable copy instead of gone', async () => {
    (engineCapFetch as any).mockImplementation(() => Promise.resolve({status: 200, ok: true}));
    const holder = document.createElement('div');
    holder.className = 'cyc-media-box';
    const img = document.createElement('img');
    img.className = 'cyc-still';
    holder.append(img);
    document.body.append(holder);

    markMissingOnError(img);
    img.dataset.cycMediaUrl = 'http://x/broken.png';
    img.dispatchEvent(new Event('error'));
    await flush();
    expect(holder.querySelector('.cyc-media-gone')!.textContent).toContain("can't be shown here");
  });
});

describe('profile attachments grid/tab + gone (was .cyc-media-tile.cyc-media-gone / .cyc-doc-gone)', () => {
  const image = (over: Partial<CycMediaItem> = {}): CycMediaItem => ({
    key: 'i' + Math.random(),
    kind: 'image',
    from: 'upload',
    refId: 'r',
    name: 'pic.png',
    size: 10,
    ts: 0,
    url: 'http://x/pic.png',
    ...over
  });
  const doc = (over: Partial<CycMediaItem> = {}): CycMediaItem => ({
    key: 'd' + Math.random(),
    kind: 'doc',
    from: 'shown',
    refId: 'r',
    name: 'notes.txt',
    size: 20,
    ts: 0,
    url: 'http://x/notes.txt',
    ...over
  });

  test('switching tabs shows one collection and hides the other', () => {
    const pa = createProfileAttachments({onOpen: vi.fn()});
    document.body.append(pa.el);
    pa.update([image(), doc()]);
    const grid = pa.el.querySelector('.cyc-shared-grid')!;
    const files = pa.el.querySelector('.cyc-shared-files')!;

    pa.el.querySelector<HTMLElement>('.cyc-seg[data-tab="files"]')!.click();
    expect(grid.classList.contains('cyc-off')).toBe(true);
    expect(files.classList.contains('cyc-off')).toBe(false);

    pa.el.querySelector<HTMLElement>('.cyc-seg[data-tab="media"]')!.click();
    expect(grid.classList.contains('cyc-off')).toBe(false);
    expect(files.classList.contains('cyc-off')).toBe(true);
    pa.destroy();
  });

  test('a swept image tile paints the themed gone surface/ink and reserves its square', () => {
    const pa = createProfileAttachments({onOpen: vi.fn()});
    document.body.append(pa.el);
    pa.update([image({key: 'gone1', url: ''})]);
    const tile = pa.el.querySelector<HTMLElement>('.cyc-media-tile')!;
    expect(cls(tile)).toContain('cyc-media-gone');
    expect(cls(tile)).toContain('bg-[#ffffff]');
    expect(cls(tile)).toContain('text-[#6b6b70]');
    expect(cls(tile)).toContain('pb-[100%]');
    expect(cls(tile)).not.toContain('cursor-pointer');

    setPresentationTheme('night');
    expect(cls(tile)).toContain('bg-[#17171a]');
    expect(cls(tile)).toContain('text-[#a0a0a6]');
    pa.destroy();
  });

  test('a swept file row goes gone: dimmed, italic size and the no-longer copy', () => {
    const pa = createProfileAttachments({onOpen: vi.fn()});
    document.body.append(pa.el);
    pa.update([doc({key: 'goneDoc', url: ''})]);
    const row = pa.el.querySelector<HTMLElement>('.cyc-account-document')!;
    expect(cls(row)).toContain('cyc-doc-gone');
    expect(cls(row)).toContain('opacity-60');
    const size = row.querySelector<HTMLElement>('.cyc-doc-size')!;
    expect(cls(size)).toContain('italic');
    expect(size.textContent).toBe('no longer on the engine');
    pa.destroy();
  });

  test('the profile doc icon keeps its 5px corner and paints its extension fill', () => {
    const pa = createProfileAttachments({onOpen: vi.fn()});
    document.body.append(pa.el);
    pa.update([doc({key: 'z', name: 'bundle.zip', url: 'http://x/bundle.zip'})]);
    const ico = pa.el.querySelector<HTMLElement>('.cyc-account-document .cyc-doc-ico')!;
    expect(cls(ico)).toContain('rounded-[5px]!');
    expect(cls(ico)).toContain('bg-[#b9772e]');
    pa.destroy();
  });
});

describe('rendered markdown paint (was .cyc-md .cyc-md-list/-checkbox/-link)', () => {
  test('lists carry their markers/spacing, checkboxes the primary accent, links the primary ink', () => {
    const article = renderMarkdown([
      {
        kind: 'list',
        ordered: false,
        items: [
          {content: [{kind: 'text', value: 'plain'}]},
          {content: [{kind: 'text', value: 'task'}], checked: false}
        ]
      } as any,
      {
        kind: 'paragraph',
        content: [{kind: 'link', href: 'https://x', marks: [{kind: 'text', value: 'a'}]}]
      } as any
    ]);
    document.body.append(article);
    const ul = article.querySelector<HTMLElement>('ul.cyc-md-list')!;
    expect(cls(ul)).toContain('list-disc');
    expect(cls(ul)).toContain('ps-6');
    const task = article.querySelector<HTMLElement>('li.cyc-md-task')!;
    expect(cls(task)).toContain('list-none');
    expect(cls(task)).toContain('ms-[-1.25rem]');
    const box = article.querySelector<HTMLElement>('.cyc-md-checkbox')!;
    expect(cls(box)).toContain('accent-[#96602f]');
    expect(cls(box)).toContain('pointer-events-none');
    const link = article.querySelector<HTMLElement>('.cyc-md-link')!;
    expect(cls(link)).toContain('no-underline');
    expect(cls(link)).toContain('text-[#96602f]');

    setPresentationTheme('night');
    expect(cls(box)).toContain('accent-[#c98652]');
    expect(cls(link)).toContain('text-[#c98652]');
  });
});

describe('image viewer open/close (was .cyc-imgview scrim/chrome)', () => {
  test('opening paints the resting scrim + fade-in and the rounded chrome; closing removes it', async () => {
    openImageViewer([{url: 'http://x/one.png', name: 'one'}], 0);
    const overlay = document.querySelector<HTMLElement>('.cyc-imgview')!;
    expect(overlay).not.toBeNull();
    expect(cls(overlay)).toContain('bg-[rgba(0,0,0,0.92)]');
    expect(cls(overlay)).toContain('[animation:cyc-imgview-in_0.12s_ease-out]');
    expect(cls(overlay.querySelector('.cyc-imgview-head'))).toContain('rounded-[6px]!');
    expect(cls(overlay.querySelector('.cyc-imgview-close'))).toContain('rounded-[6px]!');

    const esc = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true});
    document.dispatchEvent(esc);
    await flush();
    expect(document.querySelector('.cyc-imgview')).toBeNull();
  });

  // Pointer-drag paging thresholds: micro-jitters and taps never page, a
  // sub-threshold drag snaps back, a past-threshold drag pages. (A vertical lead
  // belongs to the dismiss gesture, which the paging swipe bows out of.)
  test('pointer paging: 5px and sub-threshold drags never page; past-threshold commits', async () => {
    openImageViewer(
      [
        {url: 'http://x/one.png', name: 'one'},
        {url: 'http://x/two.png', name: 'two'}
      ],
      0
    );
    const stage = document.querySelector<HTMLElement>('.cyc-imgview-stage')!;
    // jsdom has no pointer capture; the pinch tracker calls it unconditionally.
    (stage as any).setPointerCapture = () => {};
    (stage as any).releasePointerCapture = () => {};
    (stage as any).hasPointerCapture = () => false;
    const count = document.querySelector<HTMLElement>('.cyc-imgview-count')!;
    const pev = (type: string, x: number, y: number, id = 1) => {
      const e = new Event(type, {bubbles: true, cancelable: true}) as any;
      Object.assign(e, {pointerId: id, clientX: x, clientY: y, button: 0});
      return e as PointerEvent;
    };
    expect(count.textContent).toBe('1 of 2');

    // A 5px jiggle: under the arm slop, nothing pages.
    stage.dispatchEvent(pev('pointerdown', 200, 50));
    stage.dispatchEvent(pev('pointermove', 195, 50));
    stage.dispatchEvent(pev('pointerup', 195, 50));
    await new Promise((r) => setTimeout(r, 160));
    expect(count.textContent).toBe('1 of 2');

    // A 30px drag: armed but under the commit threshold, snaps back.
    stage.dispatchEvent(pev('pointerdown', 200, 50));
    stage.dispatchEvent(pev('pointermove', 170, 50));
    stage.dispatchEvent(pev('pointerup', 170, 50));
    await new Promise((r) => setTimeout(r, 160));
    expect(count.textContent).toBe('1 of 2');

    // A 100px drag: past the commit threshold, pages to the next image.
    stage.dispatchEvent(pev('pointerdown', 200, 50));
    stage.dispatchEvent(pev('pointermove', 100, 50));
    stage.dispatchEvent(pev('pointerup', 100, 50));
    await new Promise((r) => setTimeout(r, 160));
    expect(count.textContent).toBe('2 of 2');

    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    await flush();
  });

  test('a committed horizontal wheel pages to the next image (local swipe)', async () => {
    openImageViewer(
      [
        {url: 'http://x/one.png', name: 'one'},
        {url: 'http://x/two.png', name: 'two'}
      ],
      0
    );
    const stage = document.querySelector<HTMLElement>('.cyc-imgview-stage')!;
    const count = document.querySelector<HTMLElement>('.cyc-imgview-count')!;
    expect(count.textContent).toBe('1 of 2');
    const e = new Event('wheel', {bubbles: true, cancelable: true});
    Object.assign(e, {deltaX: 100, deltaY: 0});
    stage.dispatchEvent(e);
    await new Promise((r) => setTimeout(r, 160));
    expect(count.textContent).toBe('2 of 2');
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    await flush();
  });
});

describe('download card button (was .cyc-download-card .cyc-download-btn)', () => {
  test('the download affordance is placed and inked with the themed secondary text', () => {
    const m: any = {
      role: 'claude',
      text: 'here it is',
      ts: 0,
      file: {docId: 'd', name: 'log.txt', fileKind: 'text', size: 5}
    };
    const node = downloadMessage(m, true, true, vi.fn());
    document.body.append(node);
    const dl = node.querySelector<HTMLElement>('.cyc-download-btn')!;
    expect(cls(dl)).toContain('absolute');
    expect(cls(dl)).toContain('end-1.5');
    expect(cls(dl)).toContain('w-8');
    expect(cls(dl)).toContain('h-8');
    expect(cls(dl)).toContain('text-[#6b6b70]');
    setPresentationTheme('night');
    expect(cls(dl)).toContain('text-[#a0a0a6]');
  });
});

describe('file-viewer diff toggle geometry + laptop reveal (was .cyc-fv-diff-toggle @media)', () => {
  test('the toggle carries its geometry and is shown only at laptop width', async () => {
    (window as any).innerWidth = 1200;
    installPresentationReactivity()();
    openFileViewer(
      {docId: 'd', name: 'p.diff', fileKind: 'diff', size: 0} as any,
      undefined,
      '',
      undefined,
      async () => ({fileKind: 'diff', content: '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n'})
    );
    await flush();
    const toggle = document.querySelector<HTMLElement>('.cyc-fv-diff-toggle')!;
    expect(toggle).not.toBeNull();
    expect(cls(toggle)).toContain('h-[2.125rem]');
    expect(cls(toggle)).toContain('px-3');
    expect(toggle.classList.contains('block!')).toBe(true);
    expect(toggle.classList.contains('hidden!')).toBe(false);

    (window as any).innerWidth = 390;
    installPresentationReactivity()();
    expect(toggle.classList.contains('hidden!')).toBe(true);
    expect(toggle.classList.contains('block!')).toBe(false);

    (window as any).innerWidth = 1024;
    installPresentationReactivity()();
  });
});

describe('multipart album geometry (was .cyc-multipart-album + combined box/photo)', () => {
  const imgUpload = (id: string, width?: number, height?: number) => ({
    uploadId: id,
    name: `${id}.png`,
    mime: 'image/png',
    size: 10,
    path: `${id}.png`,
    image: true,
    width,
    height
  });
  const mk = (n: number) =>
    attachmentMessage(
      {
        role: 'claude',
        kind: 'text',
        text: '',
        ts: 0,
        uploads: Array.from({length: n}, (_, i) => imgUpload('u' + i, 96, 64))
      } as any,
      true,
      true,
      (u: any) => `http://x/${u.uploadId}`
    );

  test('a multi-image album paints its grid track and square/cover tiles', () => {
    const node = mk(3);
    document.body.append(node);
    const album = node.querySelector<HTMLElement>('.cyc-multipart-album')!;
    expect(cls(album)).toContain('grid');
    expect(cls(album)).toContain('gap-[2px]');
    expect(cls(album)).toContain('w-[min(20rem,62vw)]');
    expect(cls(album)).not.toContain('w-full');
    expect(cls(album)).toContain('grid-cols-[repeat(3,1fr)]');
    expect(album.dataset.cols).toBe('3');

    const box = album.querySelector<HTMLElement>('.cyc-media-box')!;
    expect(cls(box)).toContain('block!');
    expect(cls(box)).toContain('w-auto!');
    expect(cls(box)).toContain('aspect-square');
    expect(cls(box)).not.toContain('cyc-media-reserve');
    const photo = box.querySelector<HTMLElement>('.cyc-still')!;
    expect(cls(photo)).toContain('static!');
    expect(cls(photo)).toContain('object-cover');
    expect(cls(photo)).not.toContain('object-contain!');
  });

  test('a two-image album selects the two-column track', () => {
    const node = mk(2);
    const album = node.querySelector<HTMLElement>('.cyc-multipart-album')!;
    expect(cls(album)).toContain('grid-cols-[repeat(2,1fr)]');
    expect(album.dataset.cols).toBe('2');
  });

  test('a single-image album fills the bubble width, reserves aspect, and paints the contain tile', () => {
    const node = mk(1);
    const album = node.querySelector<HTMLElement>('.cyc-multipart-album')!;
    expect(cls(album)).toContain('grid-cols-[1fr]');
    expect(album.dataset.cols).toBe('1');
    // A single image stretches to fill the bubble (so it lines up with a voice
    // clip that pins the frame wide) rather than sitting at a fixed sliver.
    expect(cls(album)).toContain('w-full');
    expect(cls(album)).toContain('min-w-[min(20rem,62vw)]');
    expect(cls(album)).toContain('max-w-[30rem]');
    // Not the fixed multi-image track width (guarded by the leading space so the
    // shared `min-w-[min(20rem,62vw)]` substring above does not match).
    expect(cls(album)).not.toContain(' w-[min(20rem,62vw)]');

    const box = album.querySelector<HTMLElement>('.cyc-media-box')!;
    expect(cls(box)).toContain('cyc-media-reserve');
    expect(cls(box)).toContain('w-full!');
    // The tight 400px/22rem caps are dropped for a taller 70vh ceiling so a tall
    // portrait grows taller instead of going narrow with a side/bottom gap.
    expect(cls(box)).not.toContain('max-h-[min(400px,100%)]!');
    expect(cls(box)).not.toContain('max-h-[22rem]');
    expect(cls(box)).toContain('max-h-[70vh]');
    expect(box.style.aspectRatio).toBe('96 / 64');
    const photo = box.querySelector<HTMLElement>('.cyc-still')!;
    expect(cls(photo)).toContain('static!');
    expect(cls(photo)).toContain('object-contain!');
    expect(cls(photo)).not.toContain('object-cover');
  });
});

describe('single photo message (was .cyc-message.cyc-media-tile box/photo/caption)', () => {
  const mk = (text: string, onOpen?: (m: any) => void) =>
    photoMessage(
      {role: 'claude', kind: 'text', text, ts: 0} as any,
      true,
      true,
      'http://x/pic.png',
      'pic',
      onOpen,
      {width: 96, height: 64}
    );

  test('a captioned photo paints the final box/photo/caption literals and reserves its aspect', () => {
    const node = mk('a caption');
    document.body.append(node);
    const box = node.querySelector<HTMLElement>('.cyc-media-box')!;
    expect(cls(box)).toContain('block!');
    expect(cls(box)).toContain('w-[min(20rem,62vw)]!');
    expect(cls(box)).toContain('overflow-hidden');
    expect(cls(box)).toContain('[font-size:0]');
    expect(cls(box)).toContain('cyc-media-reserve');
    expect(cls(box)).toContain('rounded-[6px]!');
    expect(cls(box)).toContain('max-h-[22rem]');
    expect(box.style.aspectRatio).toBe('96 / 64');
    const photo = node.querySelector<HTMLElement>('.cyc-still')!;
    expect(cls(photo)).toContain('static!');
    expect(cls(photo)).toContain('object-contain!');
    expect(cls(photo)).toContain('[image-orientation:from-image]');
    const cap = node.querySelector<HTMLElement>('.caption')!;
    expect(cap).not.toBeNull();
    expect(cls(cap)).toContain('max-w-[min(20rem,62vw)]');
    expect(cls(cap)).toContain('mt-1');
    expect(node.classList.contains('cyc-media-tile')).toBe(true);
    expect(node.classList.contains('cyc-msg-media-only')).toBe(false);
  });

  test('a caption-only-alt photo collapses to cyc-msg-media-only with no caption node', () => {
    const node = mk('pic');
    expect(node.classList.contains('cyc-msg-media-only')).toBe(true);
    expect(node.querySelector('.caption')).toBeNull();
    const content = node.querySelector('.cyc-message-content')!;
    expect(cls(content)).toContain('[.cyc-message.cyc-msg-media-only_&]:bg-transparent!');
    expect(cls(content)).toContain('[.cyc-message.cyc-msg-media-only_&]:shadow-none');
    expect(cls(content)).toContain('[.cyc-media-tile_&]:w-min');
    const act = node.querySelector('.cyc-stamp-act')!;
    expect(cls(act)).toContain('[.cyc-message.cyc-msg-media-only_&]:hidden');
    const time = node.querySelector('.cyc-stamp')!;
    expect(cls(time)).toContain('cyc-stamp-flow');
    expect(cls(time)).toContain('float-end'); // 2026-09-02: floats inline-end, no baseline span
    expect(cls(time)).toContain('ms-2');
    expect(cls(node.querySelector('.cyc-still'))).toContain(
      '[.cyc-message.cyc-msg-media-only_&]:object-contain'
    );
  });

  test('clicking the media box opens the viewer for that message', () => {
    const seen: any[] = [];
    const node = mk('a caption', (m) => seen.push(m));
    document.body.append(node);
    node.querySelector<HTMLElement>('.cyc-media-box')!.click();
    expect(seen.length).toBe(1);
    expect(seen[0].text).toBe('a caption');
  });
});

describe('painter lifecycle', () => {
  test('a themed media painter is pruned once its element detaches', () => {
    const ico = document.createElement('div');
    document.body.append(ico);
    const before = themePainterCount();
    paintDocIcon(ico, 'txt', false);
    expect(themePainterCount()).toBe(before + 1);
    ico.remove();
    setPresentationTheme('night');
    expect(themePainterCount()).toBe(before);
  });
});
