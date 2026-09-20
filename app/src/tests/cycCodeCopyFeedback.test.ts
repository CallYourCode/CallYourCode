import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const {copyText, toast} = vi.hoisted(() => ({
  copyText: vi.fn<(text: string) => Promise<boolean>>(),
  toast: vi.fn()
}));

vi.mock('../components/widgets', () => ({toast: (...args: unknown[]) => toast(...args)}));
vi.mock('../features/media/downloads', () => ({
  default: (element: HTMLElement) => copyText(element.textContent ?? ''),
  copyText
}));

import {installShell} from '../shell/viewport';

let dispose: () => void;

beforeEach(() => {
  copyText.mockReset();
  toast.mockReset();
  document.body.innerHTML = `
    <div id="cyc-app">
      <pre class="cyc-code-frame">
        <div class="cyc-src-head"><button class="cyc-code-copy">Copy</button></div>
        <code class="cyc-src-body">const value = false;</code>
      </pre>
    </div>`;
  dispose = installShell(document.getElementById('cyc-app')!);
});

afterEach(() => {
  dispose();
  document.body.innerHTML = '';
});

describe('code-block copy feedback', () => {
  test('does not toast success when copying fails', async () => {
    copyText.mockResolvedValue(false);

    document.querySelector<HTMLButtonElement>('.cyc-code-copy')!.click();

    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Copy failed'));
    expect(toast).not.toHaveBeenCalledWith('Code copied to clipboard');
  });
});
