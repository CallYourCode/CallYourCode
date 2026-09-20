import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, test} from 'vitest';

const wallpaper = readFileSync(resolve(process.cwd(), 'src/assets/glyphs-a.svg'), 'utf8');

describe('glyph wallpaper', () => {
  test('keeps the 8,100 code marks while inheriting shared paint attributes', () => {
    const marks = [...wallpaper.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)];

    expect(marks).toHaveLength(8100);
    expect(wallpaper).toContain(
      '<g transform="translate(-1000 -1000)" font-family="ui-monospace, Menlo, monospace" fill="#000">'
    );
    expect(marks.some(([, attributes]) => /\b(font-family|fill)=/.test(attributes))).toBe(false);
  });
});
