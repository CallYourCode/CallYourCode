import {describe, expect, test} from 'vitest';
import {findSyntax, renderSyntax} from '../features/code/languages';
import {codeBlockElement} from '../features/chat/content';

const PRISM_IDS = [
  'markup',
  'css',
  'scss',
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'json',
  'json5',
  'bash',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'sql',
  'yaml',
  'markdown',
  'diff',
  'docker',
  'toml',
  'graphql',
  'kotlin',
  'swift',
  'ruby',
  'php',
  'lua',
  'powershell'
];

describe('code language metadata', () => {
  test('maps TypeScript JSX, JSON and Diff aliases', () => {
    expect(findSyntax('tsx')).toMatchObject({title: 'TSX', prismId: 'tsx'});
    expect(findSyntax('JSON')).toMatchObject({title: 'JSON', prismId: 'json'});
    expect(findSyntax('patch')).toMatchObject({title: 'Diff', prismId: 'diff'});
  });

  test('every alias resolves to its display label', () => {
    expect(findSyntax('patch')?.title).toBe('Diff');
    expect(findSyntax('ts')?.title).toBe('TypeScript');
    expect(findSyntax('plaintext')?.title).toBe('text');
  });

  // The block stores the prism id, not the display title, so a grammar whose title
  // is not one of its own aliases (C# -> csharp) still resolves on the way back.
  test('every prism id is itself an alias of its entry', () => {
    for (const tag of PRISM_IDS) expect(findSyntax(tag)?.prismId, tag).toBe(tag);
  });

  test('highlights supported code and safely escapes unknown code', async () => {
    await expect(renderSyntax('const App = () => <main />', 'tsx')).resolves.toContain(
      'class="token'
    );
    await expect(renderSyntax('{"ok":true}', 'json')).resolves.toContain('class="token');
    await expect(renderSyntax('+ added', 'diff')).resolves.toContain('class="token');
    await expect(renderSyntax('<unsafe>', 'not-a-language')).resolves.toBe('&lt;unsafe&gt;');
  });
});

describe('code block caption and fence', () => {
  const captionOf = (pre: HTMLElement) =>
    pre.querySelector<HTMLElement>('.cyc-src-head-name')!.textContent;
  const languageOf = (pre: HTMLElement) =>
    pre.querySelector<HTMLElement>('.cyc-src-body')!.dataset.language;

  test('a recognised fence captions with its title and highlights via its prism id', () => {
    const pre = codeBlockElement('int x = 1;', 'cs');
    expect(captionOf(pre)).toBe('C#');
    expect(languageOf(pre)).toBe('csharp');
    expect(pre.dataset.cycFence).toBe('cs');
  });

  test('an unrecognised fence is shown verbatim and left unhighlighted', () => {
    const pre = codeBlockElement('x', 'brainfuck');
    expect(captionOf(pre)).toBe('brainfuck');
    expect(languageOf(pre)).toBeUndefined();
    expect(pre.dataset.cycFence).toBe('brainfuck');
  });

  test('a bare fence carries no caption and no stored fence', () => {
    const pre = codeBlockElement('x', '');
    expect(captionOf(pre)).toBe('');
    expect(pre.dataset.cycFence).toBeUndefined();
  });
});
