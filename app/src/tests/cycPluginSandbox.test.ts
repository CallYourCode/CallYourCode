import {expect, test} from 'vitest';
import {SANDBOX_SHELL_URL} from '../features/plugins/sandbox';

test('plugin panels use the iframe-safe sandbox route', () => {
  expect(SANDBOX_SHELL_URL).toBe('/cyc-sandbox.html');
});
