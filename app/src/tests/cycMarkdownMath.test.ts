import {describe, expect, test} from 'vitest';
import {parseMarkdownDocument, type MarkdownInline} from '../features/content/markdown';
import {renderMarkdown} from '../features/media/pageRenderer';

function mathIn(source: string): MarkdownInline[] {
  const paragraph = parseMarkdownDocument(source).nodes.find((n) => n.kind === 'paragraph');
  if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');
  return paragraph.content.filter((mark) => mark.kind === 'math');
}

describe('Inline math nodes', () => {
  test('carries arbitrary source verbatim on a dedicated node', () => {
    for (const source of ['x+y', '\\frac{a}{b}', 'α ≤ β', 'a|c*d`e', '💠 = √2']) {
      const marks = mathIn(`before $${source}$ after`);
      expect(marks).toEqual([{kind: 'math', source}]);
    }
  });

  test('parses inline math and renders it as a code element with the source', () => {
    const doc = parseMarkdownDocument('energy $E = mc^2$ here');
    const paragraph = doc.nodes.find((node) => node.kind === 'paragraph');
    expect(paragraph?.kind).toBe('paragraph');
    const serial = JSON.stringify(doc);
    expect(serial).not.toContain('$');
    expect(serial).toContain('E = mc^2');

    const article = renderMarkdown(doc.nodes);
    const code = article.querySelector('.cyc-md-code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('E = mc^2');
    expect(article.textContent).not.toContain('$');
  });

  test('leaves unclosed inline math as literal text', () => {
    const doc = parseMarkdownDocument('cost is $5 for one');
    const article = renderMarkdown(doc.nodes);
    expect(article.querySelector('.cyc-md-code')).toBeNull();
    expect(article.textContent).toContain('$5 for one');
  });

  test('routes block math to a dedicated math block', () => {
    const doc = parseMarkdownDocument('$$\n\\int_0^1 x\\,dx\n$$');
    expect(doc.nodes[0]).toEqual({kind: 'mathBlock', value: '\\int_0^1 x\\,dx'});
  });
});
