import {afterAll, afterEach, beforeEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

import {codeBlockElement, setFormatted} from '../features/chat/content';
import {
  resolveCodeAction,
  flipCodeFlow,
  paintCodeBlocks,
  paintCodeTokens,
  codeSelectionText
} from '../features/code/viewer';
import {openCodeViewer} from '../features/code/codeViewer';
import {renderSyntax} from '../features/code/languages';
import {setPresentationTheme} from '../components/presentation';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const CHAT = resolve(HERE, '..', 'features', 'chat');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

const NIGHT_SURFACE = 'bg-[rgba(0,0,0,0.8)]!';

function selOf(range: Range): Selection {
  return {isCollapsed: false, rangeCount: 1, getRangeAt: () => range} as unknown as Selection;
}

// jsdom reads colors as rgb values.
const normColor = (value: string): string => {
  const p = document.createElement('div');
  p.style.color = value;
  return p.style.color;
};

// Expected Prism token colors by theme.
const INK = {
  day: {secondary: '#6b6b70', danger: '#d64246', primary: '#96602f', text: '#1c1c1e'},
  night: {secondary: '#a0a0a6', danger: '#ff6262', primary: '#c98652', text: '#ededee'}
} as const;
type InkKey = keyof (typeof INK)['day'];
const ROLE: Record<string, {day: InkKey; night: InkKey}> = {
  comment: {day: 'secondary', night: 'secondary'},
  punctuation: {day: 'secondary', night: 'secondary'},
  number: {day: 'danger', night: 'danger'},
  deleted: {day: 'danger', night: 'danger'},
  string: {day: 'secondary', night: 'primary'},
  'attr-name': {day: 'secondary', night: 'primary'},
  operator: {day: 'danger', night: 'danger'},
  keyword: {day: 'primary', night: 'danger'},
  'attr-value': {day: 'primary', night: 'danger'},
  function: {day: 'danger', night: 'text'},
  'class-name': {day: 'danger', night: 'text'},
  variable: {day: 'text', night: 'text'},
  regex: {day: 'text', night: 'text'}
};
const tokenSpan = (parent: ParentNode, roles: string): HTMLElement => {
  const el = document.createElement('span');
  el.className = `token ${roles}`;
  parent.appendChild(el);
  return el;
};

beforeEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});
afterEach(() => {
  document.body.innerHTML = '';
  setPresentationTheme('day');
});

describe('code producer paint: geometry, wrap state and dark surface', () => {
  test('conversation fenced code scrolls (pan) by default, like standalone', () => {
    const message = document.createElement('div');
    setFormatted(message, '```js\nconst a = 1;\n```');

    const pre = message.querySelector<HTMLElement>('pre.cyc-code-frame')!;
    const code = message.querySelector<HTMLElement>('.cyc-src-body')!;
    expect(pre.dataset.cycCodeFlow).toBe('pan');
    expect(pre.querySelector('.cyc-code-toggle-wrap')!.getAttribute('aria-pressed')).toBe('false');
    expect(code.className).not.toContain('overflow-auto');
    expect(code.className).not.toContain('whitespace-pre');
    expect(code.className).toContain('block');
    expect(code.className).toContain('px-2.5');
    expect(code.className).toContain('py-1');

    const standalone = codeBlockElement('const a = 1;', 'js');
    expect(standalone.dataset.cycCodeFlow).toBe('pan');
    expect(standalone.querySelector('.cyc-code-toggle-wrap')!.getAttribute('aria-pressed')).toBe(
      'false'
    );
  });

  test('header, name, button and content geometry moved onto the DOM', () => {
    const pre = codeBlockElement('x', 'ts');
    const header = pre.querySelector<HTMLElement>('.cyc-src-head')!;
    expect(header.className).toContain('flex');
    expect(header.className).toContain('items-center');
    expect(header.className).toContain('cursor-pointer');
    expect(header.className).toContain('ps-2.5');
    expect(header.className).toContain('font-medium');

    const name = pre.querySelector<HTMLElement>('.cyc-src-head-name')!;
    expect(name.className).toContain('flex-auto');
    expect(name.className).toContain('text-ellipsis');

    const toggle = pre.querySelector<HTMLElement>('.cyc-code-toggle-wrap')!;
    expect(toggle.className).toContain('ms-3.5');
    expect(toggle.className).toContain('rounded-full');
    expect(toggle.className).toContain('p-1');

    expect(pre.querySelector<HTMLElement>('.cyc-src-pane')!.className).toContain('leading-[19px]');
  });

  test('wrap toggle round-trips the code flow state on the container', () => {
    const pre = codeBlockElement('x\ny', 'js'); // pan
    document.body.append(pre);
    const toggleBtn = pre.querySelector<HTMLElement>('.cyc-code-toggle-wrap')!;
    const action = resolveCodeAction(toggleBtn)!;
    expect(action.flowControl).toBe(true);

    flipCodeFlow(action);
    expect(pre.dataset.cycCodeFlow).toBe('wrap');
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('true');

    flipCodeFlow(action);
    expect(pre.dataset.cycCodeFlow).toBe('pan');
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');
  });

  test('paintCodeBlocks paints the dark surface only in night and repaints live', () => {
    const message = document.createElement('div');
    document.body.append(message);
    setFormatted(message, '```js\nconst a = 1;\n```');
    const pre = message.querySelector<HTMLElement>('pre.cyc-code-frame')!;

    expect(pre.classList.contains(NIGHT_SURFACE)).toBe(false);
    setPresentationTheme('night');
    expect(pre.classList.contains(NIGHT_SURFACE)).toBe(true);
    setPresentationTheme('day');
    expect(pre.classList.contains(NIGHT_SURFACE)).toBe(false);
  });

  test('a block rendered while night starts already dark', () => {
    setPresentationTheme('night');
    const message = document.createElement('div');
    document.body.append(message);
    setFormatted(message, '```js\nconst a = 1;\n```');
    const pre = message.querySelector<HTMLElement>('pre.cyc-code-frame')!;
    expect(pre.classList.contains(NIGHT_SURFACE)).toBe(true);
  });

  test('paintCodeBlocks is idempotent per block', () => {
    const message = document.createElement('div');
    document.body.append(message);
    setFormatted(message, '```js\nx\n```');
    const pre = message.querySelector<HTMLElement>('pre.cyc-code-frame')!;
    paintCodeBlocks(message);
    paintCodeBlocks(message);
    expect(pre.dataset.codePainted).toBe('1');
  });

  test('selection copy still yields the whole block as real newlines', () => {
    const THREE = 'a\nb\nc';
    const pre = codeBlockElement(THREE, 'js');
    document.body.appendChild(pre);
    const code = pre.querySelector('.cyc-src-body')!;
    const range = document.createRange();
    range.selectNodeContents(code);
    expect(codeSelectionText(selOf(range))).toBe(THREE);
  });
});

describe('prism token ink: current shell/prism.css inks (paintCodeTokens)', () => {
  test('every prism role takes the copper SKIN ink prism.css chose, per theme', () => {
    for (const theme of ['day', 'night'] as const) {
      const root = document.createElement('div');
      const els = Object.keys(ROLE).map((role) => [role, tokenSpan(root, role)] as const);
      paintCodeTokens(root, theme);
      for (const [role, el] of els) {
        expect(el.style.color, `${role} @ ${theme}`).toBe(normColor(INK[theme][ROLE[role][theme]]));
      }
    }
  });

  test('non-theme statics: dim, weight, italic and cursor match prism.css', () => {
    const root = document.createElement('div');
    const comment = tokenSpan(root, 'comment');
    const namespace = tokenSpan(root, 'namespace');
    const important = tokenSpan(root, 'important');
    const bold = tokenSpan(root, 'bold');
    const italic = tokenSpan(root, 'italic');
    const entity = tokenSpan(root, 'entity');

    paintCodeTokens(root, 'day');
    expect(comment.style.opacity).toBe('');
    expect(namespace.style.opacity).toBe('0.7');
    expect(important.style.fontWeight).toBe('500');
    expect(bold.style.fontWeight).toBe('500');
    expect(italic.style.fontStyle).toBe('italic');
    expect(entity.style.cursor).toBe('help');
    expect(important.style.color).toBe(normColor(INK.day.text));
    expect(entity.style.color).toBe(normColor(INK.day.danger));

    paintCodeTokens(root, 'night');
    expect(comment.style.opacity).toBe('0.5');
    expect(namespace.style.opacity).toBe('0.7');
  });

  test('paintCodeBlocks inks tokens and repaints them live on theme flip', () => {
    const container = document.createElement('div');
    const pre = document.createElement('pre');
    pre.className = 'cyc-code-frame';
    const code = document.createElement('code');
    code.className = 'cyc-src-body';
    const kw = tokenSpan(code, 'keyword');
    pre.appendChild(code);
    container.appendChild(pre);
    document.body.append(container);

    paintCodeBlocks(container); // day render
    expect(kw.style.color).toBe(normColor(INK.day.primary));
    setPresentationTheme('night');
    expect(kw.style.color).toBe(normColor(INK.night.danger));
    setPresentationTheme('day');
    expect(kw.style.color).toBe(normColor(INK.day.primary));
    paintCodeTokens(container, 'day');
    expect(kw.style.color).toBe(normColor(INK.day.primary));
  });
});

// Embedded CSS strings use a contextual token color.
describe('prism embedded-CSS string context (current .language-css/.style rule)', () => {
  const stringUnder = (root: ParentNode, ...ancestors: string[]): HTMLElement => {
    let parent: ParentNode = root;
    for (const role of ancestors) parent = tokenSpan(parent, role);
    return tokenSpan(parent, 'string');
  };

  test('embedded string inks danger in day and ordinary primary in night; plain string stays ordinary', () => {
    for (const theme of ['day', 'night'] as const) {
      const root = document.createElement('div');
      const plain = tokenSpan(root, 'string');
      const underCss = stringUnder(root, 'language-css');
      const underStyle = stringUnder(root, 'style');
      const nested = stringUnder(root, 'style', 'language-css');
      paintCodeTokens(root, theme);

      expect(plain.style.color, `plain @ ${theme}`).toBe(
        normColor(INK[theme][ROLE['string'][theme]])
      );
      const ctx = theme === 'day' ? normColor(INK.day.danger) : normColor(INK.night.primary);
      expect(underCss.style.color, `language-css @ ${theme}`).toBe(ctx);
      expect(underStyle.style.color, `style @ ${theme}`).toBe(ctx);
      expect(nested.style.color, `nested @ ${theme}`).toBe(ctx);
    }
  });

  test('the context recolours only strings; a sibling selector under the same ancestor is untouched', () => {
    const root = document.createElement('div');
    const ctx = tokenSpan(root, 'language-css');
    const sel = tokenSpan(ctx, 'selector');
    const num = tokenSpan(ctx, 'number');

    paintCodeTokens(root, 'day');
    expect(sel.style.color).toBe(normColor(INK.day.secondary));
    expect(num.style.color).toBe(normColor(INK.day.danger));
    paintCodeTokens(root, 'night');
    expect(sel.style.color).toBe(normColor(INK.night.primary));
    expect(num.style.color).toBe(normColor(INK.night.danger));
  });
});

describe('code viewer overlay: layout, chrome opt-out and close', () => {
  test('opening a code block builds the fullscreen block and closes on Escape', () => {
    const source = codeBlockElement('const a = 1;', 'ts');
    document.body.append(source);
    openCodeViewer(source);

    const overlay = document.querySelector<HTMLElement>('.cyc-code-viewer')!;
    expect(overlay).not.toBeNull();
    expect(overlay.className).toContain('select-text');
    expect(overlay.querySelector('.cyc-pane-back')!.className).toContain('select-none');

    const block = overlay.querySelector<HTMLElement>('pre.cyc-code-frame')!;
    expect(block.className).toContain('flex-col');
    expect(block.className).toContain('m-0!');
    expect(block.className).toContain('rounded-none!');
    const code = block.querySelector<HTMLElement>('.cyc-src-body')!;
    expect(code.className).toContain('overflow-auto!');
    expect(code.className).toContain('pb-6!');
    expect(block.querySelector('.cyc-src-head-fullscreen')).toBeNull();
    expect(block.querySelector('.cyc-src-head')!.className).toContain('select-none');

    const esc = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true});
    document.dispatchEvent(esc);
    expect(document.querySelector('.cyc-code-viewer')).toBeNull();
  });

  test('opening a table clones the box, drops its fullscreen and opts chrome out', () => {
    const box = document.createElement('div');
    box.className = 'cyc-snippet-table-box';
    box.innerHTML =
      '<div class="cyc-snippet-table-bar">' +
      '<span class="cyc-snippet-table-toggle-wrap"></span>' +
      '<span class="cyc-snippet-table-fullscreen"></span></div>' +
      '<div class="cyc-snippet-table-wrap"><table class="cyc-snippet-table">' +
      '<tbody><tr><td>Ada</td></tr></tbody></table></div>';
    document.body.append(box);
    openCodeViewer(box);

    const overlay = document.querySelector<HTMLElement>('.cyc-code-viewer')!;
    expect(overlay.querySelector('.cyc-cv-title')!.textContent).toBe('Table');
    expect(
      overlay.querySelector('.cyc-snippet-table-wrap')!.classList.contains('cyc-overflower')
    ).toBe(true);
    expect(overlay.querySelector('.cyc-snippet-table-fullscreen')).toBeNull();
    expect(overlay.querySelector('.cyc-snippet-table-bar')!.className).toContain('select-none');

    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    expect(document.querySelector('.cyc-code-viewer')).toBeNull();
  });
});

// Real-Chromium cascade coverage.
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

// Build the production stylesheet stack for Chromium probes.
async function measure(
  bodyHtml: string,
  candidates: string[],
  probes: Record<string, {selector: string; props: string[]}>,
  rootStyle = ''
): Promise<Record<string, Record<string, string>>> {
  const utilities = await compileTailwind(candidates);
  const shell =
    readFileSync(resolve(SHELL, 'reset.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(CHAT, 'chat.css'), 'utf8');
  const html =
    `<!DOCTYPE html><html style="${rootStyle}"><head><meta charset="utf-8">` +
    `<style>${utilities}\n/* un-layered shell */\n${shell}</style></head><body>${bodyHtml}</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(
      ({probes}) => {
        const out: Record<string, Record<string, string>> = {};
        for (const [key, {selector, props}] of Object.entries(probes)) {
          const el = document.querySelector(selector);
          if (!el) throw new Error(`probe ${key}: ${selector} matched nothing`);
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

afterAll(async () => {
  await browser?.close();
});

describe('code cascade: layered utilities beat the un-layered shell', () => {
  test('pan flow pins white-space:pre + overflow:auto over base pre-wrap', async () => {
    const pre = codeBlockElement('a\nb', 'js'); // pan
    expect(pre.dataset.cycCodeFlow).toBe('pan');
    const code = pre.querySelector<HTMLElement>('.cyc-src-body')!;
    const styles = await measure(
      `<div id="cyc-app">${pre.outerHTML}</div>`,
      [...tokenize(pre.className), ...tokenize(code.className)],
      {code: {selector: '#cyc-app .cyc-src-body', props: ['white-space', 'overflow-x']}}
    );
    expect(styles.code['white-space']).toBe('pre'); // not the un-layered pre-wrap
    expect(styles.code['overflow-x']).toBe('auto');
  });

  test('the two flows diverge on the same code element: pan scrolls, wrap reflows', async () => {
    const pan = codeBlockElement('a\nb', 'js');
    const wrap = codeBlockElement('a\nb', 'js', true);
    const code = pan.querySelector<HTMLElement>('.cyc-src-body')!;
    const styles = await measure(
      `<div id="cyc-app">${pan.outerHTML}${wrap.outerHTML}</div>`,
      [...tokenize(pan.className), ...tokenize(code.className)],
      {
        pan: {
          selector: "#cyc-app .cyc-code-frame[data-cyc-code-flow='pan'] .cyc-src-body",
          props: ['white-space', 'overflow-x']
        },
        wrap: {
          selector: "#cyc-app .cyc-code-frame[data-cyc-code-flow='wrap'] .cyc-src-body",
          props: ['white-space', 'overflow-x']
        }
      }
    );
    expect(styles.pan['white-space']).toBe('pre');
    expect(styles.pan['overflow-x']).toBe('auto');
    expect(styles.wrap['white-space']).toBe('pre-wrap');
    expect(styles.wrap['overflow-x']).toBe('visible');
  });

  test('wrapped conversation code keeps base white-space:pre-wrap', async () => {
    const message = document.createElement('div');
    setFormatted(message, '```js\na\n```');
    const code = message.querySelector<HTMLElement>('.cyc-src-body')!;
    const styles = await measure(
      `<pre class="${message.querySelector('pre.cyc-code-frame')!.className}">` +
        `<code id="c" class="${code.className}">a</code></pre>`,
      tokenize(code.className),
      {code: {selector: '#c', props: ['white-space']}}
    );
    expect(styles.code['white-space']).toBe('pre-wrap');
  });

  test('night dark surface (important) beats the chat.css quote tint', async () => {
    const message = document.createElement('div');
    document.body.append(message);
    setPresentationTheme('night');
    setFormatted(message, '```js\na\n```');
    const pre = message.querySelector<HTMLElement>('pre.cyc-code-frame')!;
    expect(pre.classList.contains(NIGHT_SURFACE)).toBe(true);
    const styles = await measure(
      `<pre id="p" class="${pre.className}"></pre>`,
      tokenize(pre.className),
      {pre: {selector: '#p', props: ['background-color']}},
      '--cyc-accent-rgb: 201, 134, 82;'
    );
    expect(styles.pre['background-color']).toBe('rgba(0, 0, 0, 0.8)');
  });

  test('fullscreen viewer block: margin 0 / radius 0 / code overflow auto win', async () => {
    const source = codeBlockElement('a\nb', 'ts');
    document.body.append(source);
    openCodeViewer(source);
    const block = document.querySelector<HTMLElement>('.cyc-code-viewer pre.cyc-code-frame')!;
    const code = block.querySelector<HTMLElement>('.cyc-src-body')!;
    const styles = await measure(
      `<div class="cyc-code-viewer"><pre id="p" class="${block.className}">` +
        `<code id="c" class="${code.className}">a</code></pre></div>`,
      [...tokenize(block.className), ...tokenize(code.className)],
      {
        block: {selector: '#p', props: ['margin-top', 'border-top-left-radius', 'display']},
        code: {selector: '#c', props: ['overflow-y']}
      },
      '--cyc-accent-rgb: 201, 134, 82;'
    );
    expect(parseFloat(styles.block['margin-top'])).toBe(0); // m-0! over my-1
    expect(parseFloat(styles.block['border-top-left-radius'])).toBe(0); // rounded-none! over quote-frame
    expect(styles.block.display).toBe('flex');
    expect(styles.code['overflow-y']).toBe('auto');
  });

  test('the current .cyc-src-body reset resolves in the real stack sans prism.css', async () => {
    const pre = codeBlockElement('a', 'js');
    const code = pre.querySelector<HTMLElement>('.cyc-src-body')!;
    const styles = await measure(
      `<pre class="${pre.className}"><code id="c" class="${code.className}">a</code></pre>`,
      tokenize(code.className),
      {code: {selector: '#c', props: ['direction', 'tab-size', 'text-align', 'hyphens']}}
    );
    expect(styles.code.direction).toBe('ltr');
    expect(styles.code['tab-size']).toBe('4');
    expect(styles.code['text-align']).toBe('left');
    expect(styles.code.hyphens).toBe('none');
  });

  test('with prism.css gone the shell inks no token; the paint is the sole source', async () => {
    const styles = await measure(
      `<pre class="code"><code class="cyc-src-body">` +
        `<span id="bare" class="token keyword">const</span>` +
        `<span id="lit" class="token keyword" style="color: rgb(150, 96, 47)">const</span>` +
        `</code></pre>`,
      [],
      {
        bare: {selector: '#bare', props: ['color']},
        lit: {selector: '#lit', props: ['color']}
      }
    );
    expect(styles.bare.color).toBe('rgb(0, 0, 0)');
    expect(styles.lit.color).toBe('rgb(150, 96, 47)');
  });

  test('embedded-CSS string paints danger in day and ordinary primary in night on real prism output', async () => {
    for (const [theme, embExpect] of [
      ['day', 'rgb(214, 66, 70)'], // day danger string ink
      ['night', 'rgb(201, 134, 82)'] // --cyc-accent night: the dark override wins, so not danger
    ] as const) {
      const embedded = document.createElement('code');
      embedded.innerHTML = await renderSyntax('<style>a{content:"x"}</style>', 'html');
      const plain = document.createElement('code');
      plain.innerHTML = await renderSyntax('a{content:"x"}', 'css'); // bare CSS: no context ancestor
      paintCodeTokens(embedded, theme);
      paintCodeTokens(plain, theme);
      embedded.querySelector<HTMLElement>('.string')!.id = 'emb';
      plain.querySelector<HTMLElement>('.string')!.id = 'plain';
      const styles = await measure(
        `<pre class="code"><code class="cyc-src-body">${embedded.innerHTML}</code>` +
          `<code class="cyc-src-body">${plain.innerHTML}</code></pre>`,
        [],
        {emb: {selector: '#emb', props: ['color']}, plain: {selector: '#plain', props: ['color']}}
      );
      const plainExpect = theme === 'day' ? 'rgb(107, 107, 112)' : 'rgb(201, 134, 82)';
      expect(styles.emb.color, `embedded @ ${theme}`).toBe(embExpect);
      expect(styles.plain.color, `plain @ ${theme}`).toBe(plainExpect);
    }
  });
});
