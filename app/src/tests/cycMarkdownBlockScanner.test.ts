import {describe, expect, test} from 'vitest';
import {parseMarkdownDocument, type MarkdownBlock} from '../features/content/markdown';

// Collect node kinds from a parsed tree.
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

const blocks = (src: string): MarkdownBlock[] => parseMarkdownDocument(src).nodes;
const kindList = (src: string): string[] => blocks(src).map((n) => n.kind);
const only = (src: string): MarkdownBlock => {
  const nodes = blocks(src);
  expect(nodes).toHaveLength(1);
  return nodes[0];
};

describe('CYC block scanner edges', () => {
  describe('headings', () => {
    test('a run of seven hashes is not a heading', () => {
      expect(only('####### too deep').kind).toBe('paragraph');
    });

    test('a hash with no following space is a paragraph', () => {
      expect(only('#notaheading').kind).toBe('paragraph');
    });

    test('a heading made only of hashes keeps one character of text', () => {
      const node = only('# ##');
      expect(node).toMatchObject({kind: 'heading', level: 1});
      expect(JSON.stringify(node)).toContain('"value":"#"');
    });

    test('interior hashes survive while a trailing run is stripped', () => {
      const node = blocks('### a # b ###').find((n) => n.kind === 'heading');
      expect(JSON.stringify(node)).toContain('a # b');
      expect(JSON.stringify(node)).not.toContain('a # b #');
    });

    test('only levels two and up emit a navigation anchor', () => {
      expect(kindList('# one')).toEqual(['heading']);
      expect(kindList('## two')).toEqual(['anchor', 'heading']);
    });
  });

  describe('fences', () => {
    test('two backticks do not open a fence', () => {
      expect(only('``not a fence``').kind).toBe('paragraph');
    });

    test('a longer closing run still closes the fence', () => {
      const node = only('```\nbody\n`````');
      expect(node).toMatchObject({kind: 'code', value: 'body'});
    });

    test('a shorter run inside the fence is kept verbatim', () => {
      const node = only('````\n```\ninner\n````');
      expect(node).toMatchObject({kind: 'code', value: '```\ninner'});
    });

    test('mixed markers do not cross-close', () => {
      const node = only('```\n~~~\nstill open');
      expect(node).toMatchObject({kind: 'code', value: '~~~\nstill open'});
    });

    test('the info word stops at the first space', () => {
      const node = only('```  js  extra words\nx\n```');
      expect(node).toMatchObject({kind: 'code', language: 'js'});
    });

    test('closing fence tolerates trailing whitespace', () => {
      const node = only('```\nx\n```   ');
      expect(node).toMatchObject({kind: 'code', value: 'x'});
    });
  });

  describe('dividers and lists', () => {
    test('two dashes are not a divider', () => {
      expect(only('--').kind).toBe('paragraph');
    });

    test('a dash run with trailing text is not a divider', () => {
      expect(only('--- text').kind).toBe('paragraph');
    });

    test('spaced star run reads as a bullet list, not a rule', () => {
      expect(only('* * *').kind).toBe('list');
    });

    test('ordered markers accept both dot and paren closers', () => {
      expect(only('1. a\n2) b').kind).toBe('list');
    });

    test('a switch from ordered to bullet starts a second list', () => {
      expect(kindList('1. a\n- b')).toEqual(['list', 'list']);
    });

    test('nested items attach under the parent entry', () => {
      const node = only('- top\n  - child\n  - child2\n- top2');
      if (node.kind !== 'list') throw new Error('unreachable');
      expect(node.items).toHaveLength(2);
      expect(node.items[0].nodes?.[0].kind).toBe('list');
      expect(node.items[1].nodes).toBeUndefined();
    });

    test('task boxes toggle checked state', () => {
      const node = only('- [ ] open\n- [x] done\n- [X] also');
      if (node.kind !== 'list') throw new Error('unreachable');
      expect(node.items.map((i) => i.checked)).toEqual([false, true, true]);
    });

    test('a bare bullet with no body falls back to a paragraph', () => {
      expect(only('-').kind).toBe('paragraph');
    });
  });

  describe('tables', () => {
    test('a header row without an alignment row is just a paragraph', () => {
      expect(only('| a | b |\n| c | d |').kind).toBe('paragraph');
    });

    test('rows without bounding pipes are not a table', () => {
      expect(only('a | b\n--- | ---\nc | d').kind).toBe('paragraph');
    });

    test('escaped pipes stay inside one cell across body rows', () => {
      const node = only('| a \\| b | c |\n| - | - |\n| x \\| y | z |');
      if (node.kind !== 'table') throw new Error('unreachable');
      expect(node.rows[1]).toHaveLength(2);
      expect(JSON.stringify(node.rows[1][0])).toContain('x | y');
    });

    test('body ends at the first non-row line', () => {
      const nodes = blocks('| a | b |\n| - | - |\n| 1 | 2 |\nafter');
      expect(nodes.map((n) => n.kind)).toEqual(['table', 'paragraph']);
    });
  });

  describe('quotes, details and definitions', () => {
    test('a quote strips at most one leading space per line', () => {
      const node = only('>  two leading');
      expect(node.kind).toBe('quote');
      expect(JSON.stringify(node)).toContain(' two leading');
    });

    test('an unterminated details block still closes at end of input', () => {
      const node = only('<details>\n<summary>S</summary>\ninside');
      expect(node.kind).toBe('details');
    });

    test('detailsx is not a details block', () => {
      expect(only('<detailsx>hello</detailsx>').kind).toBe('paragraph');
    });

    test('reference and footnote definitions are consumed, not rendered', () => {
      const page = parseMarkdownDocument(
        'use [a][r] and [^n]\n\n[r]: https://r.test\n[^n]: the note'
      );
      const serial = JSON.stringify(page);
      expect(serial).toContain('https://r.test');
      expect(serial).toContain('the note');
      expect(
        page.nodes.some((n) => n.kind === 'paragraph' && JSON.stringify(n).includes('[r]:'))
      ).toBe(false);
    });

    test('a label opening with a caret is a footnote, not a link ref', () => {
      const page = parseMarkdownDocument('[^only]: text');
      expect(JSON.stringify(page)).toContain('text');
    });

    test('definitions tolerate up to three leading spaces but not four', () => {
      const three = parseMarkdownDocument('use [x][r]\n\n   [r]: https://ok.test');
      expect(JSON.stringify(three)).toContain('https://ok.test');
      const four = parseMarkdownDocument('    [r]: https://nope.test\n\nuse [x][r]');
      expect(four.nodes[0].kind).toBe('paragraph');
      expect(JSON.stringify(four)).toContain('[x][r]');
    });
  });

  describe('malformed and fuzz input never throws or loops', () => {
    const seeds = [
      '',
      '\n\n\n',
      '#',
      '```',
      '~~~',
      '$$',
      '>',
      '|',
      '||',
      '- ',
      '[x]',
      '<details>',
      '<summary>',
      '[]: ',
      '[^]: ',
      '* * *',
      '---',
      '#'.repeat(50),
      '`'.repeat(9),
      '|'.repeat(20),
      '> > > deep',
      '1.'.repeat(30)
    ];

    test('each seed parses to a finite node list', () => {
      for (const seed of seeds) {
        const started = Date.now();
        const page = parseMarkdownDocument(seed);
        expect(Array.isArray(page.nodes)).toBe(true);
        expect(Date.now() - started).toBeLessThan(1000);
      }
    });

    test('a deterministic pseudo-random corpus round-trips without error', () => {
      const alphabet = '#*-_`~|[]()^:. \n>abc123<>/=$';
      let state = 0x2f6e2b1;
      const rand = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
      };
      for (let trial = 0; trial < 400; trial++) {
        const length = 1 + Math.floor(rand() * 80);
        let src = '';
        for (let k = 0; k < length; k++) src += alphabet[Math.floor(rand() * alphabet.length)];
        const page = parseMarkdownDocument(src);
        expect(Array.isArray(page.nodes)).toBe(true);
        for (const kind of kinds(page.nodes))
          expect([
            'heading',
            'paragraph',
            'code',
            'math',
            'mathBlock',
            'divider',
            'anchor',
            'quote',
            'list',
            'table',
            'details',
            'text',
            'strong',
            'emphasis',
            'underline',
            'strike',
            'highlight',
            'subscript',
            'superscript',
            'link'
          ]).toContain(kind);
        expect(() => JSON.stringify(page)).not.toThrow();
      }
    });
  });
});
