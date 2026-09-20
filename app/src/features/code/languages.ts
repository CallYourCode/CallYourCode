import {lazy} from '@/shared/lazy';

export type SyntaxDescriptor = {
  title: string;
  prismId?: string;
  tags: readonly string[];
};

const SYNTAX_CATALOGUE: readonly SyntaxDescriptor[] = [
  {title: 'text', tags: ['text', 'plain', 'plaintext', 'txt']},
  {title: 'HTML', prismId: 'markup', tags: ['html', 'markup', 'xml', 'svg']},
  {title: 'CSS', prismId: 'css', tags: ['css']},
  {title: 'SCSS', prismId: 'scss', tags: ['scss', 'sass']},
  {title: 'JavaScript', prismId: 'javascript', tags: ['javascript', 'js', 'mjs', 'cjs']},
  {title: 'TypeScript', prismId: 'typescript', tags: ['typescript', 'ts', 'mts', 'cts']},
  {title: 'JSX', prismId: 'jsx', tags: ['jsx', 'react']},
  {title: 'TSX', prismId: 'tsx', tags: ['tsx']},
  {title: 'JSON', prismId: 'json', tags: ['json']},
  {title: 'JSON5', prismId: 'json5', tags: ['json5']},
  {title: 'Bash', prismId: 'bash', tags: ['bash', 'sh', 'shell', 'zsh', 'fish']},
  {title: 'Python', prismId: 'python', tags: ['python', 'py']},
  {title: 'Go', prismId: 'go', tags: ['go', 'golang']},
  {title: 'Rust', prismId: 'rust', tags: ['rust', 'rs']},
  {title: 'Java', prismId: 'java', tags: ['java']},
  {title: 'C', prismId: 'c', tags: ['c', 'h']},
  {title: 'C++', prismId: 'cpp', tags: ['cpp', 'c++', 'cc', 'cxx', 'hpp']},
  {title: 'C#', prismId: 'csharp', tags: ['csharp', 'cs']},
  {title: 'SQL', prismId: 'sql', tags: ['sql']},
  {title: 'YAML', prismId: 'yaml', tags: ['yaml', 'yml']},
  {title: 'Markdown', prismId: 'markdown', tags: ['markdown', 'md']},
  {title: 'Diff', prismId: 'diff', tags: ['diff', 'patch']},
  {title: 'Dockerfile', prismId: 'docker', tags: ['dockerfile', 'docker']},
  {title: 'TOML', prismId: 'toml', tags: ['toml']},
  {title: 'GraphQL', prismId: 'graphql', tags: ['graphql', 'gql']},
  {title: 'Kotlin', prismId: 'kotlin', tags: ['kotlin', 'kt']},
  {title: 'Swift', prismId: 'swift', tags: ['swift']},
  {title: 'Ruby', prismId: 'ruby', tags: ['ruby', 'rb']},
  {title: 'PHP', prismId: 'php', tags: ['php']},
  {title: 'Lua', prismId: 'lua', tags: ['lua']},
  {title: 'PowerShell', prismId: 'powershell', tags: ['powershell', 'ps1', 'ps']}
];

const syntaxByTag = new Map<string, SyntaxDescriptor>();
for (const entry of SYNTAX_CATALOGUE) {
  for (const tag of entry.tags) syntaxByTag.set(tag.toLowerCase(), entry);
}

export function findSyntax(tag: string): SyntaxDescriptor | undefined {
  return syntaxByTag.get(tag.trim().toLowerCase());
}

function escapeForCode(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let prismModule: Promise<typeof import('./prism').default> | null = null;

async function prismEngine(): Promise<typeof import('./prism').default> {
  prismModule ??= lazy(() => import('./prism'), 'syntax highlighting').then(
    (module) => module.default
  );
  return prismModule;
}

export async function renderSyntax(source: string, tag: string): Promise<string> {
  const syntax = findSyntax(tag);
  if (!syntax?.prismId) return escapeForCode(source);
  const Prism = await prismEngine();
  const grammar = Prism.languages[syntax.prismId];
  return grammar ? Prism.highlight(source, grammar, syntax.prismId) : escapeForCode(source);
}
