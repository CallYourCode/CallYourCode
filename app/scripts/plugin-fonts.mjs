import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS_CSS = join(repo, 'src/shell/chrome.css');
const FONTS_DIR = join(repo, 'public/assets/fonts');
const SETI_SUBSET_FILE = 'seti-cyc.woff';
const SETI_SUBSET_RANGE =
  'U+E005,U+E007,U+E00B-E00C,U+E015,U+E019-E01A,U+E01D,U+E022-E023,U+E025,U+E03A,U+E03E,' +
  'U+E048,U+E04C-E04D,U+E050-E051,U+E055,U+E058,U+E05E-E05F,U+E06D,U+E070,U+E074,U+E07B,' +
  'U+E07D,U+E081-E082,U+E084,U+E089,U+E091-E092,U+E097,U+E099,U+E09B,U+E0A5,U+E0A7,U+E0A9';

const FAMILIES = new Set(['Inter', 'JetBrains Mono', 'seti']);

function isBasicLatin(range) {
  const first = range.split(',')[0].trim().replace(/^U\+?/i, '');
  const [lo, hi = lo] = first.split('-');
  return parseInt(lo, 16) === 0x0 && parseInt(hi, 16) === 0xff;
}

export function fontFaces() {
  const css = readFileSync(FONTS_CSS, 'utf8');
  const blocks = css.match(/@font-face\s*\{[^}]*\}/g) || [];
  const groups = new Map();

  for (const b of blocks) {
    const family = (b.match(/font-family:\s*["']([^"']+)["']/) || [])[1];
    if (!family || !FAMILIES.has(family)) continue;

    const range = (b.match(/unicode-range:\s*([^;]+);/) || [, ''])[1].trim();
    if (family !== 'seti' && (!range || !isBasicLatin(range))) continue;

    const file = (b.match(/url\(["'][^"']*\/([^"/]+\.woff2?)["']\)/) || [])[1];
    if (!file) continue;

    const style = (b.match(/font-style:\s*([a-z]+)/) || [, 'normal'])[1];
    const weight = (b.match(/font-weight:\s*([0-9 ]+?)\s*;/) || [, '400'])[1].trim();
    const display = (b.match(/font-display:\s*([a-z]+)/) || [, 'swap'])[1];
    const pluginFile = family === 'seti' ? SETI_SUBSET_FILE : file;
    const pluginRange = family === 'seti' ? SETI_SUBSET_RANGE : range;
    const key = `${family}|${style}|${pluginFile}`;
    const g = groups.get(key) || {
      family,
      style,
      display,
      range: pluginRange,
      file: pluginFile,
      weight
    };
    groups.set(key, g);
  }

  const out = [];
  for (const g of groups.values()) {
    const bytes = readFileSync(join(FONTS_DIR, g.file));
    const ext = g.file.endsWith('.woff2') ? 'woff2' : 'woff';
    const mime = ext === 'woff2' ? 'font/woff2' : 'font/woff';
    out.push(
      `@font-face{font-family:"${g.family}";font-style:${g.style};font-weight:${g.weight};` +
        `font-display:${g.display};` +
        `src:url(data:${mime};base64,${bytes.toString('base64')}) format("${ext}");` +
        (g.range ? `unicode-range:${g.range};` : '') +
        '}'
    );
  }
  return out.join('\n');
}
