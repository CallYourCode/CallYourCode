import {describe, expect, test} from 'vitest';
import {parseMarkdownDocument, type MarkdownBlock} from '../features/content/markdown';

// Collect node and mark kinds recursively.
function kinds(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) kinds(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'kind' && typeof entry === 'string') out.push(entry);
      else kinds(entry, out);
    }
  }
  return out;
}

describe('markdown article parser', () => {
  test('parses headings, paragraphs, inline formatting, links and math', () => {
    const page = parseMarkdownDocument(
      '# Title\n\n**bold** *em* ++under++ ~~gone~~ ==mark== `code` [link](https://example.com) $x+y$'
    );
    expect(page.nodes[0]).toMatchObject({kind: 'heading', level: 1});
    expect(page.nodes[1]).toMatchObject({kind: 'paragraph'});
    const serial = JSON.stringify(page);
    for (const kind of ['strong', 'emphasis', 'underline', 'strike', 'highlight', 'code', 'link'])
      expect(serial).toContain(kind);
    expect(serial).toContain('https://example.com');
  });

  test('parses fenced code, dividers, quote, tables, details and nested task lists', () => {
    const page = parseMarkdownDocument(
      '```ts\nconst x = 1\n```\n\n---\n\n> quote\n\n| a | b |\n| :- | -: |\n| 1 | 2 |\n\n<details open>\n<summary>More</summary>\ninside\n</details>\n\n- [x] done\n  - child'
    );
    expect(page.nodes.map((node) => node.kind)).toEqual([
      'code',
      'divider',
      'quote',
      'table',
      'details',
      'list'
    ]);
    const list = page.nodes[5];
    expect(list.kind === 'list' && list.items[0].checked).toBe(true);
    expect(list.kind === 'list' && list.items[0].nodes?.[0].kind).toBe('list');
  });

  test('keeps notes and email links in the article model, and leaves phone numbers as text', () => {
    const page = parseMarkdownDocument('See [^a] and a@b.test or +1 555 0100.\n\n[^a]: note');
    const serial = JSON.stringify(page);
    expect(serial).toContain('note-1');
    expect(serial).toContain('mailto:a@b.test');
    expect(serial).not.toContain('tel:');
    expect(serial).toContain('+1 555 0100');
    expect(serial).not.toContain('"_":');
  });

  describe('block reader fixtures', () => {
    const only = (src: string): MarkdownBlock => {
      const {nodes} = parseMarkdownDocument(src);
      expect(nodes).toHaveLength(1);
      return nodes[0];
    };

    test('atx headings level 1..6, closing hashes stripped', () => {
      for (let level = 1; level <= 6; level++) {
        const nodes = parseMarkdownDocument('#'.repeat(level) + ' Head ' + '#'.repeat(level)).nodes;
        const heading = nodes.find((n) => n.kind === 'heading');
        expect(heading).toMatchObject({kind: 'heading', level});
        expect(nodes.some((n) => n.kind === 'anchor')).toBe(level > 1);
      }
    });

    test('tilde fences carry a language and keep inner backticks verbatim', () => {
      const node = only('~~~py\ncode = `x`\n~~~');
      expect(node).toMatchObject({kind: 'code', language: 'py', value: 'code = `x`'});
    });

    test('unterminated fence still closes at end of input', () => {
      const node = only('```\nno end');
      expect(node).toMatchObject({kind: 'code', value: 'no end', language: ''});
    });

    test('thematic breaks of ---, *** and ___', () => {
      for (const rule of ['---', '***', '___', '----'])
        expect(only(rule)).toEqual({kind: 'divider'});
    });

    test('lazy blockquotes join their lines', () => {
      const node = only('> one\n> two');
      expect(node.kind).toBe('quote');
      expect(kinds(node)).toContain('text');
    });

    test('ordered lists keep their explicit start numbers', () => {
      const node = only('3. third\n4. fourth');
      expect(node).toMatchObject({kind: 'list', ordered: true});
      expect(node.kind === 'list' && node.items.map((i) => i.number)).toEqual([3, 4]);
    });

    test('bullet markers -, + and * all open the same unordered list', () => {
      for (const marker of ['-', '+', '*']) {
        const node = only(`${marker} item`);
        expect(node).toMatchObject({kind: 'list', ordered: false});
      }
    });

    test('a non-CommonMark bullet character stays literal text', () => {
      expect(only('• item').kind).toBe('paragraph');
    });

    test('tables read alignment from the divider row', () => {
      const node = only('| L | C | R |\n| :- | :-: | -: |\n| 1 | 2 | 3 |');
      expect(node.kind).toBe('table');
      if (node.kind !== 'table') throw new Error('unreachable');
      expect(node.rows[0].map((c) => c.align)).toEqual(['left', 'center', 'right']);
      expect(node.rows[0].every((c) => c.header)).toBe(true);
      expect(node.rows[1].every((c) => !c.header)).toBe(true);
    });

    test('escaped pipes stay inside a single table cell', () => {
      const node = only('| a \\| b | c |\n| - | - |\n| x | y |');
      if (node.kind !== 'table') throw new Error('unreachable');
      expect(node.rows[0]).toHaveLength(2);
      expect(JSON.stringify(node.rows[0][0])).toContain('a | b');
    });

    test('collapsed details default to closed and parse their body as nodes', () => {
      const node = only('<details>\n<summary>Peek</summary>\n\n- a\n- b\n</details>');
      if (node.kind !== 'details') throw new Error('unreachable');
      expect(node.open).toBe(false);
      expect(node.nodes[0].kind).toBe('list');
    });

    test('paragraphs stop at the next block boundary', () => {
      const nodes = parseMarkdownDocument('text line\n## Heading').nodes;
      expect(nodes.map((n) => n.kind)).toEqual(['paragraph', 'anchor', 'heading']);
    });
  });

  describe('inline scan fixtures', () => {
    const marksOf = (src: string) => {
      const paragraph = parseMarkdownDocument(src).nodes.find((n) => n.kind === 'paragraph');
      if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');
      return paragraph.content;
    };

    test('backslash escapes the following character', () => {
      expect(marksOf('a \\*not bold\\* b')).toEqual([{kind: 'text', value: 'a *not bold* b'}]);
    });

    test('reference links resolve against their definition', () => {
      const page = parseMarkdownDocument('see [here][ref]\n\n[ref]: https://ref.test');
      expect(JSON.stringify(page)).toContain('https://ref.test');
    });

    test('unknown reference labels fall back to literal text', () => {
      expect(kinds(marksOf('[label][missing]'))).not.toContain('link');
    });

    test('html inline tags map onto their mark kinds', () => {
      expect(kinds(marksOf('<sub>lo</sub> <sup>hi</sup> <mark>on</mark> <u>u</u>'))).toEqual(
        expect.arrayContaining(['subscript', 'superscript', 'highlight', 'underline'])
      );
    });

    test('bare urls autolink while keeping their visible text', () => {
      const marks = marksOf('go to https://cyc.test/x now');
      expect(marks).toEqual(
        expect.arrayContaining([
          {
            kind: 'link',
            href: 'https://cyc.test/x',
            marks: [{kind: 'text', value: 'https://cyc.test/x'}]
          }
        ])
      );
    });

    test('inline code preserves its delimiter content as parsed marks', () => {
      expect(kinds(marksOf('run `npm test` please'))).toContain('code');
    });

    test('unterminated emphasis stays literal', () => {
      expect(marksOf('a *lonely star')).toEqual([{kind: 'text', value: 'a *lonely star'}]);
    });
  });
});
