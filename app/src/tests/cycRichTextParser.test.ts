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

    test('a quote holds real blocks: nested quotes and lists', () => {
      const node = only('> para\n>\n> > deeper\n>\n> - item\n> - item two');
      expect(node.kind === 'quote' && node.nodes.map((n) => n.kind)).toEqual([
        'paragraph',
        'quote',
        'list'
      ]);
    });

    test('four-space indented lines are a code block, but not under a list', () => {
      expect(only('    one\n\n    two\n')).toEqual({
        kind: 'code',
        value: 'one\n\ntwo',
        language: ''
      });
      const nested = only('- a\n\n    - b');
      expect(nested.kind === 'list' && nested.items[0].nodes?.map((n) => n.kind)).toEqual(['list']);
    });

    test('indented paragraphs after blank lines stay inside their list item', () => {
      const node = only('- item\n\n    para1\n\n    para2\n- next');
      expect(node.kind).toBe('list');
      const items = node.kind === 'list' ? node.items : [];
      expect(items).toHaveLength(2);
      expect(items[0].nodes).toEqual([
        {kind: 'paragraph', content: [{kind: 'text', value: 'para1'}]},
        {kind: 'paragraph', content: [{kind: 'text', value: 'para2'}]}
      ]);
    });

    test('an item keeps code indented past its text, and lazy lines join its text', () => {
      const node = only('1. run\n   this too\n\n       npm test');
      const item = node.kind === 'list' ? node.items[0] : undefined;
      expect(item?.content).toEqual([{kind: 'text', value: 'run\nthis too'}]);
      expect(item?.nodes).toEqual([{kind: 'code', value: 'npm test', language: ''}]);
    });

    test('deep quote nesting stops at a cap and renders the rest as text', () => {
      let node = only('>'.repeat(5000) + ' deep');
      let depth = 0;
      while (node.kind === 'quote') {
        node = node.nodes[0];
        depth++;
      }
      expect(depth).toBeLessThan(40);
      expect(node.kind).toBe('paragraph');
      expect(JSON.stringify(node)).toContain('> deep');
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

    test('triple stars are bold italic with no stray asterisks', () => {
      expect(marksOf('***both***')).toEqual([
        {kind: 'strong', marks: [{kind: 'emphasis', marks: [{kind: 'text', value: 'both'}]}]}
      ]);
    });

    test('images take http(s) sources; others fall back to their alt text', () => {
      expect(marksOf('![pic](https://img.test/a.png)')).toEqual([
        {kind: 'image', src: 'https://img.test/a.png', alt: 'pic'}
      ]);
      expect(marksOf('![pic](./local.png)')).toEqual([{kind: 'text', value: 'pic'}]);
    });

    test('image alt text is plain, entity-decoded text', () => {
      expect(marksOf('![Tom &amp; **Jerry**](https://img.test/a.png)')).toEqual([
        {kind: 'image', src: 'https://img.test/a.png', alt: 'Tom & Jerry'}
      ]);
    });

    test('html entities decode, unknown ones stay literal', () => {
      expect(marksOf('&amp; &lt;b&gt; &#8364; &#x2713; &bogus;')).toEqual([
        {kind: 'text', value: '& <b> \u20ac \u2713 &bogus;'}
      ]);
    });

    test('numeric entities naming no character become the replacement character', () => {
      expect(marksOf('a&#55296;b&#xDFFF;c&#0;d&#9999999;')).toEqual([
        {kind: 'text', value: 'a\ufffdb\ufffdc\ufffdd\ufffd'}
      ]);
    });

    test('unterminated emphasis stays literal', () => {
      expect(marksOf('a *lonely star')).toEqual([{kind: 'text', value: 'a *lonely star'}]);
    });
  });
});
