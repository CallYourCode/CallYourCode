import {isHeic} from '@/features/media/heic';

// The first pasted item to attach as an image: any image/* file, or a HEIC/HEIF
// whose MIME the clipboard dropped (matched on extension so an iPhone paste of a
// bare `.heic` still attaches). Returns the raw File so the caller routes it
// through the shared intake helper, exactly like the picker and drop paths.
export function pasteImageFile(data: DataTransfer | null): File | null {
  for (const item of Array.from(data?.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (file.type.startsWith('image/') || isHeic(file)) return file;
  }
  return null;
}

const BOLD_TAGS = new Set(['B', 'STRONG']);
const ITALIC_TAGS = new Set(['I', 'EM']);
const UNDERLINE_TAGS = new Set(['U', 'INS']);
const STRIKE_TAGS = new Set(['S', 'STRIKE', 'DEL']);
const CODE_TAGS = new Set(['CODE', 'TT', 'KBD', 'SAMP', 'PRE']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE']);

const BLOCK_TAGS = new Set([
  'DIV',
  'P',
  'LI',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'PRE',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'FIGURE',
  'FIGCAPTION',
  'ADDRESS',
  'DD',
  'DT',
  'DL',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6'
]);

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isBoldWeight(weight: string): boolean {
  if (weight === 'bold' || weight === 'bolder') return true;
  const n = parseInt(weight, 10);
  return !isNaN(n) && n >= 600;
}

type Marks = {bold: boolean; italic: boolean; underline: boolean; strike: boolean};

function marksOf(el: HTMLElement): Marks {
  const style = el.style;
  const weight = style.fontWeight;
  const fontStyle = style.fontStyle;
  const decoRaw = style.textDecorationLine || style.textDecoration;
  const deco = (decoRaw || '').toLowerCase();
  return {
    bold: weight ? isBoldWeight(weight) : BOLD_TAGS.has(el.nodeName),
    italic: fontStyle
      ? fontStyle === 'italic' || fontStyle === 'oblique'
      : ITALIC_TAGS.has(el.nodeName),
    underline: decoRaw ? deco.includes('underline') : UNDERLINE_TAGS.has(el.nodeName),
    strike: decoRaw ? deco.includes('line-through') : STRIKE_TAGS.has(el.nodeName)
  };
}

function isCode(el: HTMLElement): boolean {
  return CODE_TAGS.has(el.nodeName) || (el.style.fontFamily || '').toLowerCase().includes('mono');
}

function render(node: Node, out: {rich: boolean}): string {
  let s = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      s += esc((child.textContent || '').replace(/\s+/g, ' '));
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;

    const el = child as HTMLElement;
    if (SKIP_TAGS.has(el.nodeName)) return;
    if (el.nodeName === 'BR') {
      s += '\n';
      return;
    }

    if (isCode(el)) {
      const body = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (body) {
        s += '`' + esc(body) + '`';
        out.rich = true;
      }
      return;
    }

    let inner = render(el, out);

    if (inner.trim()) {
      const m = marksOf(el);
      if (m.strike) {
        inner = '<s>' + inner + '</s>';
        out.rich = true;
      }
      if (m.underline) {
        inner = '<u>' + inner + '</u>';
        out.rich = true;
      }
      if (m.italic) {
        inner = '<i>' + inner + '</i>';
        out.rich = true;
      }
      if (m.bold) {
        inner = '<b>' + inner + '</b>';
        out.rich = true;
      }
    }

    if (BLOCK_TAGS.has(el.nodeName)) {
      const isLi = el.nodeName === 'LI';
      if (isLi) out.rich = true;
      if (s && !s.endsWith('\n')) s += '\n';
      s += (isLi ? '- ' : '') + inner;
      if (!s.endsWith('\n')) s += '\n';
    } else {
      s += inner;
    }
  });
  return s;
}

export function sanitizeClipboardHtml(html: string): {html: string; rich: boolean} {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = {rich: false};
  let s = render(doc.body, out);

  s = s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');

  return {html: s.split('\n').join('<br>'), rich: out.rich};
}
