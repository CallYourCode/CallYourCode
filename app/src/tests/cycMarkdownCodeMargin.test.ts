import {afterAll, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

// Chromium verifies markdown and chat code blocks resolve different spacing and wrapping.

import {parseMarkdownDocument} from '../features/content/markdown';
import {renderMarkdown} from '../features/media/pageRenderer';
import {setFormatted} from '../features/chat/content';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const SRC = resolve(HERE, '..');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

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

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

// Read class names directly to preserve arbitrary variants.
function candidatesOf(...roots: Element[]): string[] {
  const out = new Set<string>();
  for (const root of roots)
    for (const el of [root, ...root.querySelectorAll('*')])
      for (const c of el.classList) out.add(c);
  return [...out];
}

async function resolveCode(bodyHtml: string, candidates: string[]) {
  const utilities = await compileTailwind(candidates);
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SRC, 'features/media/media.css'), 'utf8');
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${utilities}\n/* un-layered shell */\n${shell}</style></head>` +
    `<body>${bodyHtml}</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(() => {
      const read = (pre: HTMLElement) => {
        const code = pre.querySelector('.cyc-src-body') as HTMLElement;
        return {
          marginTop: getComputedStyle(pre).marginTop,
          marginBottom: getComputedStyle(pre).marginBottom,
          overflowWrap: getComputedStyle(code).overflowWrap
        };
      };
      return {
        md: read(document.querySelector('.cyc-md pre.cyc-code-frame') as HTMLElement),
        chat: read(document.querySelector('.cyc-thread pre.cyc-code-frame') as HTMLElement)
      };
    });
  } finally {
    await page.close();
  }
}

afterAll(async () => {
  await browser?.close();
});

describe('markdown-vs-chat code block spacing and wrap drain', () => {
  test('markdown code resolves 0.75rem margin + normal wrap; chat code keeps 0.25rem + break', async () => {
    const article = renderMarkdown(parseMarkdownDocument('```js\nconst a = 1;\n```').nodes);

    const chat = document.createElement('div');
    chat.className = 'cyc-thread';
    setFormatted(chat, '```js\nconst a = 1;\n```');

    const body = `<div>${article.outerHTML}</div>${chat.outerHTML}`;
    const g = await resolveCode(body, candidatesOf(article, chat));

    expect(g.md.marginTop).toBe('12px');
    expect(g.md.marginBottom).toBe('12px');
    expect(g.md.overflowWrap).toBe('normal');

    expect(g.chat.marginTop).toBe('4px');
    expect(g.chat.marginBottom).toBe('4px');
    expect(g.chat.overflowWrap).not.toBe('normal');
  });
});
