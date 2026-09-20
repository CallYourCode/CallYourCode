import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {markupToText, reconcileFormatting, onMarkdownShortcut} from '../features/composer/markup';

let input: HTMLElement;

function mount(html: string): HTMLElement {
  input = document.createElement('div');
  input.setAttribute('contenteditable', 'true');
  input.innerHTML = html;
  document.body.appendChild(input);
  return input;
}

function selectText(node: Node, start: number, end: number): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

function caretAt(node: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

function press(code: string, shift = false): void {
  onMarkdownShortcut(input, new KeyboardEvent('keydown', {code, shiftKey: shift}));
}

afterEach(() => {
  input?.remove();
  window.getSelection()?.removeAllRanges();
});

describe('markupToText: DOM -> markdown', () => {
  it('serialises the canonical semantic tags', () => {
    mount('<strong>b</strong> <em>i</em> <u>u</u> <s>s</s> <code>c</code>');
    expect(markupToText(input)).toBe('**b** *i* ++u++ ~~s~~ `c`');
  });

  it('serialises the paste-sanitiser variants (b/i/ins/del)', () => {
    mount('<b>bold</b> and <i>it</i> and <ins>u</ins> and <del>x</del>');
    expect(markupToText(input)).toBe('**bold** and *it* and ++u++ and ~~x~~');
  });

  it('turns <br> into newlines and DIV blocks into leading newlines', () => {
    mount('one<br>two<div>three</div>');
    expect(markupToText(input)).toBe('one\ntwo\nthree');
  });

  it('prefixes a quote container line with `> ` and drops its decor spans', () => {
    mount('<blockquote>quoted</blockquote>');
    reconcileFormatting(input);
    expect(input.querySelector('.cyc-callout-bar')).not.toBeNull();
    expect(markupToText(input)).toBe('> quoted\n');
  });
});

describe('inline toggle: non-collapsed selection', () => {
  it('bold wraps the selection in <strong> and serialises with **', () => {
    mount('hello world');
    selectText(input.firstChild!, 0, 5);
    press('KeyB');

    const strong = input.querySelector('strong');
    expect(strong?.textContent).toBe('hello');
    expect(markupToText(input)).toBe('**hello** world');
  });

  it('a second bold toggle strips the format back off', () => {
    mount('hello world');
    selectText(input.firstChild!, 0, 5);
    press('KeyB');
    press('KeyB');

    expect(input.querySelector('strong')).toBeNull();
    expect(markupToText(input)).toBe('hello world');
  });

  it('mono (Ctrl+Shift+M) wraps in <code> and serialises with backticks', () => {
    mount('run cmd');
    selectText(input.firstChild!, 4, 7);
    press('KeyM', true);

    expect(input.querySelector('code')?.textContent).toBe('cmd');
    expect(markupToText(input)).toBe('run `cmd`');
  });

  it('stripping a format from the middle of a run keeps the flanks formatted', () => {
    mount('<strong>abcdef</strong>');
    const text = input.querySelector('strong')!.firstChild!;
    selectText(text, 2, 4); // "cd"
    press('KeyB');

    expect(markupToText(input)).toBe('**ab**cd**ef**');
  });
});

describe('inline toggle: collapsed selection is inert', () => {
  it('a collapsed caret does not apply a format or preventDefault', () => {
    mount('hello');
    caretAt(input.firstChild!, 2);
    const e = new KeyboardEvent('keydown', {code: 'KeyB', cancelable: true});
    onMarkdownShortcut(input, e);

    expect(input.querySelector('strong')).toBeNull();
    expect(e.defaultPrevented).toBe(false);
    expect(markupToText(input)).toBe('hello');
  });
});

describe('quote toggle + normalization', () => {
  it('quote (Ctrl+Shift+Q) wraps the selection and dresses the container', () => {
    mount('say this');
    selectText(input.firstChild!, 0, 8);
    press('KeyQ', true);

    const q = input.querySelector('blockquote')!;
    expect(q).not.toBeNull();
    for (const cls of [
      'cyc-callout',
      'cyc-callout-body',
      'cyc-callout-surface',
      'cyc-callout-marked',
      'cyc-callout-rail'
    ]) {
      expect(q.classList.contains(cls)).toBe(true);
    }
    expect(q.querySelector('.cyc-callout-bar')).not.toBeNull();
    expect(q.querySelector('.cyc-callout-mark')).not.toBeNull();
    expect(q.getAttribute('dir')).toBe('auto');
    expect(markupToText(input)).toBe('> say this\n');
  });

  it('a second quote toggle unwraps the container and its decor', () => {
    mount('say this');
    selectText(input.firstChild!, 0, 8);
    press('KeyQ', true);
    const q = input.querySelector('blockquote')!;
    selectText(q.lastChild!, 0, 8);
    press('KeyQ', true);

    expect(input.querySelector('blockquote')).toBeNull();
    expect(input.querySelector('.cyc-callout-bar')).toBeNull();
    expect(markupToText(input)).toBe('say this');
  });

  it('reconcile sheds the container class + decor off a nested quote (outer owns the frame)', () => {
    mount('<blockquote><blockquote>inner</blockquote></blockquote>');
    reconcileFormatting(input);

    const [outer, inner] = Array.from(input.querySelectorAll('blockquote'));
    expect(outer.classList.contains('cyc-callout')).toBe(true);
    expect(outer.querySelector(':scope > .cyc-callout-bar')).not.toBeNull();

    expect(inner.classList.contains('cyc-callout')).toBe(false);
    expect(inner.querySelector('.cyc-callout-bar')).toBeNull();
    expect(markupToText(input)).toBe('> > inner\n> \n');
  });

  it('reconcile is idempotent (decor is not duplicated on repeat runs)', () => {
    mount('<blockquote>x</blockquote>');
    reconcileFormatting(input);
    reconcileFormatting(input);
    const q = input.querySelector('blockquote')!;
    expect(q.querySelectorAll(':scope > .cyc-callout-bar').length).toBe(1);
    expect(q.querySelectorAll(':scope > .cyc-callout-mark').length).toBe(1);
  });
});

describe('reconcile: empty format shells', () => {
  it('drops an emptied inline element left by an edit', () => {
    mount('before<strong></strong>after');
    reconcileFormatting(input);
    expect(input.querySelector('strong')).toBeNull();
    expect(markupToText(input)).toBe('beforeafter');
  });

  it('keeps an empty inline that only holds a <br>', () => {
    mount('<u><br></u>');
    reconcileFormatting(input);
    expect(input.querySelector('u')).not.toBeNull();
  });
});
