import {describe, it, expect} from 'vitest';
import {sanitizeClipboardHtml} from '../features/composer/paste';
import {codeSelectionText} from '../features/code/viewer';
import {codeBlockElement, setFormatted} from '../features/chat/content';

const THREE = '/cyc-sw.js        200\n/pwa/icons/app-192.png 200\n/pwa/icons/app-512.png 200';

function selOf(range: Range): Selection {
  return {isCollapsed: false, rangeCount: 1, getRangeAt: () => range} as unknown as Selection;
}

describe('code copy: the bug (paste sanitiser collapses code html)', () => {
  it('a chat code block selection html folds to one backticked line', () => {
    const html = `<pre class="code"><code class="cyc-src-body">${THREE}</code></pre>`;
    const out = sanitizeClipboardHtml(html);
    console.log('CHAT SANITISED =>', JSON.stringify(out));
    expect(out.rich).toBe(true);
    expect(out.html).not.toContain('<br>');
  });

  it('a file/line-view selection html folds to one backticked line', () => {
    const rows = THREE.split('\n')
      .map(
        (t, i) =>
          `<div class="cyc-fx-line"><span class="cyc-fx-num">${i + 1}</span>` +
          `<span class="cyc-fx-gline"></span><code class="cyc-fx-ln">${t}</code></div>`
      )
      .join('');
    const html = `<pre class="cyc-fx-code-wrap cyc-fx-code">${rows}</pre>`;
    const out = sanitizeClipboardHtml(html);
    console.log('FILES SANITISED =>', JSON.stringify(out));
    expect(out.rich).toBe(true);
    expect(out.html).not.toContain('<br>');
  });
});

describe('code copy: the fix (codeSelectionText yields clean multiline)', () => {
  it('conversation code blocks pan by default, same as standalone blocks', () => {
    const message = document.createElement('div');
    setFormatted(message, `\`\`\`js\n${THREE}\n\`\`\``);

    expect(message.querySelector<HTMLElement>('pre.cyc-code-frame')!.dataset.cycCodeFlow).toBe('pan');
    expect(codeBlockElement(THREE, 'js').dataset.cycCodeFlow).toBe('pan');
  });

  it('chat code block: whole block, real newlines, no backticks', () => {
    const pre = codeBlockElement(THREE, 'js');
    document.body.appendChild(pre);
    const code = pre.querySelector('.cyc-src-body')!;
    const range = document.createRange();
    range.selectNodeContents(code);
    const text = codeSelectionText(selOf(range));
    console.log('CHAT FIX =>', JSON.stringify(text));
    expect(text).toBe(THREE);
    document.body.removeChild(pre);
  });

  it('file/line view: rows joined with newlines, gutter numbers excluded', () => {
    const pre = document.createElement('pre');
    pre.className = 'cyc-fx-code-wrap cyc-fx-code';
    THREE.split('\n').forEach((t, i) => {
      const div = document.createElement('div');
      div.className = 'cyc-fx-line';
      div.innerHTML =
        `<span class="cyc-fx-num">${i + 1}</span>` +
        `<span class="cyc-fx-gline"></span><code class="cyc-fx-ln"></code>`;
      div.querySelector('.cyc-fx-ln')!.textContent = t;
      pre.appendChild(div);
    });
    document.body.appendChild(pre);
    const range = document.createRange();
    range.selectNodeContents(pre);
    const text = codeSelectionText(selOf(range));
    console.log('FILES FIX =>', JSON.stringify(text));

    expect(text).toBe(THREE);
    document.body.removeChild(pre);
  });

  it('prose selection is left alone (returns null)', () => {
    const p = document.createElement('p');
    p.textContent = 'just some words';
    document.body.appendChild(p);
    const range = document.createRange();
    range.selectNodeContents(p);
    expect(codeSelectionText(selOf(range))).toBeNull();
    document.body.removeChild(p);
  });
});
