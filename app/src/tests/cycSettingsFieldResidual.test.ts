import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, test} from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/features/settings/settings.css'), 'utf8');

describe('settings.css keeps the live field/global/hints rules exactly', () => {
  test('the resting focus ring stays', () => {
    expect(css).toMatch(
      /\.cyc-field-input \{\s*outline: 2px solid transparent;\s*outline-offset: -1px;\s*\}/
    );
  });

  test('focus paints the accent border and ring', () => {
    expect(css).toMatch(
      /\.cyc-field-input:focus \{\s*border-color: var\(--cyc-accent\);\s*outline-color: var\(--cyc-accent\);\s*\}/
    );
  });

  test('the Chrome autofill suppression stays', () => {
    expect(css).toMatch(/\.cyc-field-input:-webkit-autofill/);
    expect(css).toMatch(/-webkit-text-fill-color: var\(--cyc-text\)/);
  });

  test('the global native placeholder ink stays', () => {
    expect(css).toMatch(/::placeholder \{[^}]*var\(--cyc-text-muted\)/);
  });

  test('the per-feature radius copy + left-pane hints override stay', () => {
    expect(css).toMatch(/html body \.cyc-hints \{\s*border-radius: 6px !important;/);
    expect(css).toMatch(
      /html body #cyc-left-pane \.cyc-hints \{\s*margin-inline: 0\.5rem !important;/
    );
  });
});
