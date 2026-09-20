import {describe, expect, test} from 'vitest';
import {fontFaces} from '../../scripts/plugin-fonts.mjs';

describe('standalone plugin fonts', () => {
  test('embeds the app text faces and the Seti subset', () => {
    const css = fontFaces();

    expect(css).toContain('font-family:"Inter"');
    expect(css).toContain('font-family:"JetBrains Mono"');
    expect(css).toContain('font-family:"seti"');
    expect(css).toContain('unicode-range:U+E005,U+E007');
    expect(css).toContain('data:font/woff;base64,');
  });
});
