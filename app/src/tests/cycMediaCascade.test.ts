import {afterAll, beforeEach, describe, expect, test, vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

// Chromium cascade coverage for media rendering.

vi.mock('../engine/contract', () => ({
  engineCapFetch: vi.fn(
    () => new Promise(() => {}) // never resolves: the viewers keep their buttons disabled
  ),
  engineObjectUrl: vi.fn((url: string) => Promise.resolve(url)),
  whenEngineReady: vi.fn(() => Promise.resolve(true)),
  docUrl: (id: string) => `doc://${id}`
}));

import {downloadMessage} from '../features/chat/messages/fileMessages';
import {openFileViewer} from '../features/media/fileViewer';
import {openHtmlViewer} from '../features/media/htmlViewer';
import {attachmentMessage} from '../features/chat/messages/attachmentMessages';
import {photoMessage} from '../features/chat/messages/messageContent';
import {installPresentationReactivity, setPresentationTheme} from '../components/presentation';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const CHAT_CSS = resolve(HERE, '..', 'features', 'chat', 'chat.css');
const MEDIA_CSS = resolve(HERE, '..', 'features', 'media', 'media.css');
const COMPOSER_CSS = resolve(HERE, '..', 'features', 'composer', 'composer.css');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

// Compile the emitted utility classes with the app entry sheet.
async function compileTailwind(candidates: string[]): Promise<string> {
  const entry = readFileSync(resolve(SHELL, 'tailwind.css'), 'utf8');
  const compiler = await compile(entry, {
    base: SHELL,
    async loadStylesheet(id: string, base: string) {
      const path =
        id === 'tailwindcss'
          ? resolve(TW_DIR, 'index.css')
          : resolve(base, id.replace(/^tailwindcss\//, `${TW_DIR}/`));
      return {base: dirname(path), content: readFileSync(path, 'utf8'), path};
    },
    async loadModule(id: string) {
      return {path: id, base: SHELL, module: {} as never};
    }
  });
  return compiler.build(candidates);
}

const tokenize = (className: string) => className.trim().split(/\s+/).filter(Boolean);

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

// Match the app's layered utility and shell stylesheet order.
async function measure(
  bodyHtml: string,
  candidates: string[],
  probes: Record<string, {selector: string; props: string[]}>
): Promise<Record<string, Record<string, string>>> {
  const utilities = await compileTailwind(candidates);
  const shell =
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n/* un-layered shell */\n${shell}</style></head><body>${bodyHtml}</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(
      ({probes}) => {
        const out: Record<string, Record<string, string>> = {};
        for (const [key, {selector, props}] of Object.entries(probes)) {
          const el = document.querySelector(selector);
          if (!el) throw new Error(`probe ${key}: selector ${selector} matched nothing`);
          const s = getComputedStyle(el);
          out[key] = {};
          for (const p of props) out[key][p] = s.getPropertyValue(p);
        }
        return out;
      },
      {probes}
    );
  } finally {
    await page.close();
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});
afterAll(async () => {
  await browser?.close();
});

describe('media cascade: layered utilities must beat the un-layered shell skin', () => {
  test('diff toggle: important geometry beats the final btn-primary/flat literals', async () => {
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
    const label = toggle.textContent || 'Side-by-side';
    const toggleClass = toggle.className;
    (window as any).innerWidth = 1024;
    installPresentationReactivity()();

    const styles = await measure(
      `<div id="row" style="display:flex;align-items:center;width:600px"><button id="toggle" class="${toggleClass}">${label}</button></div>`,
      tokenize(toggleClass),
      {
        toggle: {
          selector: '#toggle',
          props: [
            'display',
            'width',
            'height',
            'padding-left',
            'padding-right',
            'flex-grow',
            'flex-shrink'
          ]
        },
        root: {selector: ':root', props: ['font-size']}
      }
    );
    const t = styles.toggle;
    const rem = parseFloat(styles.root['font-size']); // app html font-size (15px)
    expect(t.display).toBe('block'); 
    expect(parseFloat(t.height)).toBeCloseTo(2.125 * rem, 1); // 2.125rem, not 3rem
    expect(parseFloat(t['padding-left'])).toBeCloseTo(0.75 * rem, 1); // 0.75rem, not 1rem
    expect(parseFloat(t['padding-right'])).toBeCloseTo(0.75 * rem, 1);
    expect(t['flex-grow']).toBe('0');
    expect(t['flex-shrink']).toBe('0');
    expect(parseFloat(t.width)).toBeLessThan(200);
  });

  test('download-card button: absolute wins over the un-layered .cyc-icon-btn relative', async () => {
    const m: any = {
      role: 'claude',
      text: 'here it is',
      ts: 0,
      file: {docId: 'd', name: 'log.bin', fileKind: 'binary', size: 5}
    };
    const node = downloadMessage(m, true, true, vi.fn());
    const dl = node.querySelector<HTMLElement>('.cyc-download-btn')!;
    expect(dl).not.toBeNull();
    const dlClass = dl.className;

    const styles = await measure(
      `<button id="dl" class="${dlClass}"></button>`,
      tokenize(dlClass),
      {dl: {selector: '#dl', props: ['position']}}
    );
    expect(styles.dl.position).toBe('absolute');
  });

  test('multipart album box/photo: important geometry beats the un-layered chat.css/chrome.css skin', async () => {
    const imgUpload = (id: string) => ({
      uploadId: id,
      name: `${id}.png`,
      mime: 'image/png',
      size: 10,
      path: `${id}.png`,
      image: true,
      width: 96,
      height: 64
    });
    const build = (n: number, tag: string) => {
      const node = attachmentMessage(
        {
          role: 'claude',
          kind: 'text',
          text: '',
          ts: 0,
          uploads: Array.from({length: n}, (_, i) => imgUpload(`${tag}${i}`))
        } as any,
        true,
        true,
        (u: any) => `http://x/${u.uploadId}`
      );
      node.id = tag;
      return node;
    };
    const multi = build(3, 'multi');
    const single = build(1, 'single');
    const tokens = (el: Element) =>
      [el, ...el.querySelectorAll('*')].flatMap((e) =>
        (e.getAttribute('class') || '').split(/\s+/)
      );
    const candidates = [...tokens(multi), ...tokens(single)].filter(Boolean);

    const utilities = await compileTailwind(candidates);
    const shell =
      readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') + '\n' + readFileSync(CHAT_CSS, 'utf8');
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n/* un-layered shell */\n${shell}</style></head>` +
      `<body>${multi.outerHTML}${single.outerHTML}</body></html>`;
    const page = await (await getBrowser()).newPage();
    let styles: {
      multiBox: Record<string, string>;
      singleBox: Record<string, string>;
      multiPhoto: Record<string, string>;
      singlePhoto: Record<string, string>;
      spinnerInMulti: number;
      videoInMulti: number;
      videoRow: boolean;
    };
    try {
      await page.setContent(html, {waitUntil: 'load'});
      styles = await page.evaluate(() => {
        const read = (sel: string, props: string[]) => {
          const s = getComputedStyle(document.querySelector(sel)!);
          const o: Record<string, string> = {};
          for (const p of props) o[p] = s.getPropertyValue(p);
          return o;
        };
        return {
          multiBox: read('#multi .cyc-media-box', [
            'display',
            'background-color',
            'border-top-width',
            'position',
            'font-size',
            'cursor'
          ]),
          singleBox: read('#single .cyc-media-box', [
            'background-color',
            'border-top-width',
            'position',
            'font-size',
            'cursor'
          ]),
          multiPhoto: read('#multi .cyc-still', ['position', 'object-fit']),
          singlePhoto: read('#single .cyc-still', ['position', 'object-fit']),
          spinnerInMulti: document.querySelectorAll('#multi .cyc-loader-box').length,
          videoInMulti: document.querySelectorAll('#multi .cyc-annex video').length,
          videoRow:
            document.getElementById('multi')!.classList.contains('video') ||
            document.getElementById('single')!.classList.contains('video')
        };
      });
    } finally {
      await page.close();
    }
    expect(styles.multiBox.display).toBe('block');
    expect(styles.multiPhoto.position).toBe('static');
    expect(styles.singlePhoto.position).toBe('static');
    expect(styles.multiPhoto['object-fit']).toBe('cover');
    expect(styles.singlePhoto['object-fit']).toBe('contain');
    for (const box of [styles.multiBox, styles.singleBox]) {
      expect(box['background-color']).toBe('rgb(0, 0, 0)');
      expect(parseFloat(box['border-top-width'])).toBe(0);
      expect(box.position).toBe('relative');
      expect(parseFloat(box['font-size'])).toBe(0);
      expect(box.cursor).toBe('pointer');
    }
    expect(styles.spinnerInMulti).toBe(0);
    expect(styles.videoInMulti).toBe(0);
    expect(styles.videoRow).toBe(false);
  });

  test('single photo box/photo/caption: important geometry beats the un-layered chat.css/chrome.css skin at phone/tablet/desktop', async () => {
    const m: any = {role: 'claude', kind: 'text', text: 'a caption', ts: 0};
    const node = photoMessage(m, true, true, 'http://x/pic.png', 'pic', undefined, {
      width: 96,
      height: 64
    });
    node.id = 'photo';
    const tall = photoMessage(m, true, true, 'http://x/tall.png', 'pic', undefined, {
      width: 100,
      height: 2000
    });
    tall.id = 'tall';
    const candidates = [node, tall, ...node.querySelectorAll('*'), ...tall.querySelectorAll('*')]
      .flatMap((e) => (e.getAttribute('class') || '').split(/\s+/))
      .filter(Boolean);

    const utilities = await compileTailwind(candidates);
    const shell =
      readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
      '\n' +
      readFileSync(CHAT_CSS, 'utf8') +
      '\n' +
      readFileSync(MEDIA_CSS, 'utf8') +
      // Seed the runtime message background token.
      '\n:root{--cyc-bubble-in-surface: rgb(200, 210, 220);}';
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n/* un-layered shell */\n${shell}</style></head>` +
      `<body>${node.outerHTML}${tall.outerHTML}</body></html>`;
    const page = await (await getBrowser()).newPage();
    const cases = [
      {label: 'phone', width: 360, expectBox: Math.min(320, 0.62 * 360)},
      {label: 'tablet', width: 768, expectBox: Math.min(320, 0.62 * 768)},
      {label: 'desktop', width: 1280, expectBox: Math.min(320, 0.62 * 1280)}
    ];
    try {
      await page.setContent(html, {waitUntil: 'load'});
      for (const c of cases) {
        await page.setViewportSize({width: c.width, height: 900});
        const styles = await page.evaluate(() => {
          const read = (sel: string, props: string[]) => {
            const s = getComputedStyle(document.querySelector(sel)!);
            const o: Record<string, string> = {};
            for (const p of props) o[p] = s.getPropertyValue(p);
            return o;
          };
          return {
            box: read('#photo .cyc-media-box', [
              'display',
              'width',
              'height',
              'border-top-left-radius',
              'aspect-ratio',
              'background-color',
              'border-top-width',
              'border-top-color'
            ]),
            photo: read('#photo .cyc-still', ['position', 'object-fit', 'height']),
            caption: read('#photo .caption', ['max-width', 'margin-top'])
          };
        });
        expect(styles.box.display, c.label).toBe('block');
        expect(parseFloat(styles.box.width), c.label).toBeCloseTo(c.expectBox, 0);
        expect(parseFloat(styles.box['border-top-left-radius']), c.label).toBeCloseTo(6, 1);
        expect(styles.box['aspect-ratio'].replace(/\s/g, ''), c.label).toBe('96/64');
        expect(parseFloat(styles.box.height), c.label).toBeCloseTo((c.expectBox * 64) / 96, 0);
        expect(styles.photo.position, c.label).toBe('static');
        expect(styles.photo['object-fit'], c.label).toBe('contain');
        expect(parseFloat(styles.photo.height), c.label).toBeCloseTo(
          parseFloat(styles.box.height) - 2,
          0
        );
        expect(parseFloat(styles.caption['max-width']), c.label).toBeCloseTo(c.expectBox, 0);
        expect(parseFloat(styles.caption['margin-top']), c.label).toBeCloseTo(0.25 * 16, 1);
        expect(styles.box['background-color'], c.label).toBe('rgb(0, 0, 0)');
        expect(parseFloat(styles.box['border-top-width']), c.label).toBeCloseTo(1, 1);
        expect(styles.box['border-top-color'], c.label).toBe('rgb(200, 210, 220)');
      }
      await page.setViewportSize({width: 1280, height: 900});
      const tallHeight = await page.evaluate(() => {
        const box = document.querySelector<HTMLElement>('#tall .cyc-media-box')!;
        box.parentElement!.style.height = '5000px';
        return parseFloat(getComputedStyle(box).height);
      });
      expect(tallHeight).toBeCloseTo(400, 0);
    } finally {
      await page.setViewportSize({width: 1024, height: 900});
      await page.close();
    }
  });

  test('a single image in a mixed image+audio+text bubble fills the content width instead of floating narrow', async () => {
    // A voice clip pins the frame to `--cyc-msg-frame-max`, so the bubble is wide.
    // The single image must fill that width (line up with the waveform), not sit
    // at the old fixed min(20rem,62vw) sliver with a background gap beside it.
    const m: any = {
      role: 'user',
      kind: 'text',
      text: 'look at this',
      ts: 0,
      uploads: [
        {
          uploadId: 'pic',
          name: 'pic.png',
          mime: 'image/png',
          size: 10,
          path: 'pic.png',
          image: true,
          width: 600,
          height: 900
        },
        {
          uploadId: 'clip',
          name: 'clip.webm',
          mime: 'audio/webm',
          size: 10,
          path: 'clip.webm',
          durationS: 4
        }
      ]
    };
    const node = attachmentMessage(m, true, true, (u: any) => `http://x/${u.uploadId}`);
    node.id = 'mixed';
    // Pin the frame width the way paintMessageFrameWidth does on a desktop bucket.
    node.querySelector<HTMLElement>('.cyc-message-frame')!.style.setProperty(
      '--cyc-msg-frame-max',
      '30rem'
    );
    const candidates = [node, ...node.querySelectorAll('*')]
      .flatMap((e) => (e.getAttribute('class') || '').split(/\s+/))
      .filter(Boolean);
    const utilities = await compileTailwind(candidates);
    const shell =
      readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
      '\n' +
      readFileSync(CHAT_CSS, 'utf8') +
      '\n' +
      readFileSync(MEDIA_CSS, 'utf8') +
      '\n' +
      readFileSync(COMPOSER_CSS, 'utf8');
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n/* un-layered shell */\n${shell}</style></head>` +
      `<body>${node.outerHTML}</body></html>`;
    const page = await (await getBrowser()).newPage();
    try {
      await page.setViewportSize({width: 1280, height: 900});
      await page.setContent(html, {waitUntil: 'load'});
      const w = await page.evaluate(() => {
        const width = (sel: string) =>
          document.querySelector<HTMLElement>(sel)!.getBoundingClientRect().width;
        return {
          body: width('#mixed .cyc-message-text'),
          box: width('#mixed .cyc-media-box'),
          album: width('#mixed .cyc-multipart-album'),
          clip: width('#mixed .cyc-clip.cyc-voice')
        };
      });
      // The image now fills the bubble content column: it matches the audio
      // waveform width and the message body width within a couple of pixels, and
      // is far wider than the old 320px (20rem) sliver.
      expect(Math.abs(w.box - w.clip)).toBeLessThanOrEqual(2);
      expect(Math.abs(w.box - w.body)).toBeLessThanOrEqual(2);
      expect(w.album).toBeCloseTo(w.box, 0);
      expect(w.box).toBeGreaterThan(400);
    } finally {
      await page.setViewportSize({width: 1024, height: 900});
      await page.close();
    }
  });

  test('disabled copy/download/html buttons: opacity 0.4 wins over .cyc-icon-btn:disabled 0.3', async () => {
    openFileViewer({docId: 'd', name: 'note.txt', fileKind: 'text', size: 0} as any, undefined, '');
    await flush();
    const copy = document.querySelector<HTMLElement>('.cyc-fv-copy')!;
    const download = document.querySelector<HTMLElement>('.cyc-fv-download')!;
    expect(copy).not.toBeNull();
    expect(download).not.toBeNull();
    const copyClass = copy.className;
    const downloadClass = download.className;

    document.body.innerHTML = '';
    openHtmlViewer({docId: 'h', name: 'page.html', fileKind: 'html', size: 0} as any);
    const hv = document.querySelector<HTMLElement>('.cyc-hv-download')!;
    expect(hv).not.toBeNull();
    const hvClass = hv.className;

    const candidates = [...tokenize(copyClass), ...tokenize(downloadClass), ...tokenize(hvClass)];
    const styles = await measure(
      `<button id="copy" class="${copyClass}" disabled></button>` +
        `<button id="download" class="${downloadClass}" disabled></button>` +
        `<button id="hv" class="${hvClass}" disabled></button>` +
        `<button id="copy-enabled" class="${copyClass}"></button>`,
      candidates,
      {
        copy: {selector: '#copy', props: ['opacity']},
        download: {selector: '#download', props: ['opacity']},
        hv: {selector: '#hv', props: ['opacity']},
        enabled: {selector: '#copy-enabled', props: ['opacity']}
      }
    );
    expect(styles.copy.opacity).toBe('0.4');
    expect(styles.download.opacity).toBe('0.4');
    expect(styles.hv.opacity).toBe('0.4');
    expect(styles.enabled.opacity).toBe('1');
  });
});
