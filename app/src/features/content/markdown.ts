type WrapKind =
  | 'strong'
  | 'emphasis'
  | 'underline'
  | 'strike'
  | 'highlight'
  | 'subscript'
  | 'superscript'
  | 'code';

export type MarkdownInline =
  | {kind: 'text'; value: string}
  | {kind: 'math'; source: string}
  | {kind: WrapKind; marks: MarkdownInline[]}
  | {kind: 'link'; href: string; marks: MarkdownInline[]}
  | {kind: 'image'; src: string; alt: string}
  | {kind: 'anchor'; name: string; marks: MarkdownInline[]};

export type MarkdownTableCell = {
  content: MarkdownInline[];
  header: boolean;
  align: 'left' | 'center' | 'right';
};

export type MarkdownListItem = {
  content: MarkdownInline[];
  checked?: boolean;
  number?: number;
  nodes?: MarkdownBlock[];
};

export type MarkdownBlock =
  | {kind: 'heading'; level: number; content: MarkdownInline[]}
  | {kind: 'paragraph'; content: MarkdownInline[]}
  | {kind: 'code'; value: string; language: string}
  | {kind: 'mathBlock'; value: string}
  | {kind: 'divider'}
  | {kind: 'anchor'; name: string}
  | {kind: 'quote'; nodes: MarkdownBlock[]}
  | {kind: 'list'; ordered: boolean; items: MarkdownListItem[]}
  | {kind: 'table'; rows: MarkdownTableCell[][]}
  | {kind: 'details'; title: MarkdownInline[]; open: boolean; nodes: MarkdownBlock[]};

export type MarkdownDocument = {nodes: MarkdownBlock[]};

type Definitions = {
  links: Map<string, string>;
  notes: Array<[string, string]>;
  noteNumbers: Map<string, number>;
};

const HTML_INLINE_KIND: Readonly<Record<string, WrapKind>> = {
  strong: 'strong',
  b: 'strong',
  em: 'emphasis',
  i: 'emphasis',
  u: 'underline',
  s: 'strike',
  strike: 'strike',
  del: 'strike',
  mark: 'highlight',
  sub: 'subscript',
  sup: 'superscript'
};

const HTML_INLINE_RE = new RegExp(
  `^<(${Object.keys(HTML_INLINE_KIND).join('|')})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`,
  'i'
);

const DELIMITERS: ReadonlyArray<readonly [string, WrapKind]> = [
  ['**', 'strong'],
  ['__', 'strong'],
  ['++', 'underline'],
  ['~~', 'strike'],
  ['==', 'highlight'],
  ['`', 'code'],
  ['*', 'emphasis'],
  ['_', 'emphasis']
];

const BULLETS = new Set(['-', '+', '*']);
const TASK_STATES = new Map([
  [' ', false],
  ['x', true]
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  // Built from the code point: the source tripwire bans the em-dash literal.
  mdash: String.fromCodePoint(0x2014),
  ndash: '\u2013',
  hellip: '\u2026',
  laquo: '\u00ab',
  raquo: '\u00bb',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bull: '\u2022',
  middot: '\u00b7',
  times: '\u00d7',
  divide: '\u00f7',
  deg: '\u00b0',
  plusmn: '\u00b1',
  larr: '\u2190',
  rarr: '\u2192',
  uarr: '\u2191',
  darr: '\u2193',
  harr: '\u2194',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  sect: '\u00a7',
  para: '\u00b6'
};

// An HTML entity reference, decoded; undefined leaves it as literal text.
function entity(ref: string): string | undefined {
  if (ref[0] !== '#') return NAMED_ENTITIES[ref];
  const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
}

const text = (value: string): MarkdownInline[] => (value ? [{kind: 'text', value}] : []);

function append(out: MarkdownInline[], mark: MarkdownInline): void {
  const prior = out[out.length - 1];
  if (mark.kind === 'text' && prior?.kind === 'text') prior.value += mark.value;
  else out.push(mark);
}

function acceptableUrl(value: string): string | undefined {
  return /^(?:https?:\/\/|mailto:|#)/i.test(value) ? value : undefined;
}

function inline(raw: string, defs: Definitions): MarkdownInline[] {
  const source = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/<br\s*\/?\s*>/gi, '\n');
  const out: MarkdownInline[] = [];
  let cursor = 0;
  const addText = (value: string) => append(out, {kind: 'text', value});

  while (cursor < source.length) {
    const rest = source.slice(cursor);

    if (rest[0] === '\\' && rest.length > 1) {
      addText(rest[1]);
      cursor += 2;
      continue;
    }

    const ref = /^&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]+);/.exec(rest);
    const decoded = ref && entity(ref[1]);
    if (ref && decoded) {
      addText(decoded);
      cursor += ref[0].length;
      continue;
    }

    const html = HTML_INLINE_RE.exec(rest);
    if (html) {
      append(out, {
        kind: HTML_INLINE_KIND[html[1].toLowerCase()],
        marks: inline(html[2], defs)
      });
      cursor += html[0].length;
      continue;
    }

    if (rest.startsWith('***')) {
      const end = rest.indexOf('***', 3);
      const body = end > 3 ? rest.slice(3, end) : '';
      if (body.trim()) {
        append(out, {kind: 'strong', marks: [{kind: 'emphasis', marks: inline(body, defs)}]});
        cursor += end + 3;
        continue;
      }
    }

    let wrapped = false;
    for (const [delimiter, kind] of DELIMITERS) {
      if (!rest.startsWith(delimiter)) continue;
      const end = rest.indexOf(delimiter, delimiter.length);
      if (end <= delimiter.length) continue;
      const body = rest.slice(delimiter.length, end);
      if (!body.trim()) continue;
      append(out, {kind, marks: kind === 'code' ? text(body) : inline(body, defs)});
      cursor += end + delimiter.length;
      wrapped = true;
      break;
    }
    if (wrapped) continue;

    const image = /^!\[([^\]\n]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (image) {
      const src = /^https?:\/\//i.test(image[2]) ? image[2] : undefined;
      if (src) append(out, {kind: 'image', src, alt: image[1]});
      else addText(image[1]);
      cursor += image[0].length;
      continue;
    }

    const direct = /^\[([^\]\n]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (direct) {
      const href = acceptableUrl(direct[2]);
      if (href) append(out, {kind: 'link', href, marks: inline(direct[1], defs)});
      else addText(direct[0]);
      cursor += direct[0].length;
      continue;
    }

    const shorthand = /^\[([^\]\n]+)\]\[([^\]\n]+)\]/.exec(rest);
    if (shorthand) {
      const href = acceptableUrl(defs.links.get(shorthand[2].toLowerCase()) ?? '');
      if (href) append(out, {kind: 'link', href, marks: inline(shorthand[1], defs)});
      else addText(shorthand[0]);
      cursor += shorthand[0].length;
      continue;
    }

    const noteRef = /^\[\^([^\]\n]+)\]/.exec(rest);
    if (noteRef) {
      const number = defs.noteNumbers.get(noteRef[1]);
      if (number !== undefined) {
        const value = String(number);
        append(out, {
          kind: 'anchor',
          name: `note-ref-${value}`,
          marks: [
            {
              kind: 'superscript',
              marks: [{kind: 'link', href: `#note-${value}`, marks: text(value)}]
            }
          ]
        });
        cursor += noteRef[0].length;
        continue;
      }
    }

    const math = /^\$([^$\n]+)\$/.exec(rest);
    if (math && !/^\s|\s$/.test(math[1])) {
      append(out, {kind: 'math', source: math[1]});
      cursor += math[0].length;
      continue;
    }

    const url = /^(https?:\/\/[^\s<]+)/i.exec(rest);
    if (url) {
      append(out, {kind: 'link', href: url[1], marks: text(url[1])});
      cursor += url[1].length;
      continue;
    }

    const email = /^([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/.exec(rest);
    if (email) {
      append(out, {kind: 'link', href: `mailto:${email[1]}`, marks: text(email[1])});
      cursor += email[1].length;
      continue;
    }

    addText(source[cursor++]);
  }
  return out;
}

function headingSlug(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\W_]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

type Fence = {marker: string; size: number; language: string};

function fenceAt(line: string): Fence | undefined {
  const found = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)/.exec(line);
  return found ? {marker: found[1][0], size: found[1].length, language: found[2]} : undefined;
}

function closesFence(line: string, open: Fence): boolean {
  const body = line.trim();
  if (body.length < open.size) return false;
  for (const char of body) if (char !== open.marker) return false;
  return true;
}

function isMathFence(line: string): boolean {
  return line.trim() === '$$';
}

function divider(line: string): boolean {
  return /^ {0,3}([*_-])\1{2,}\s*$/.test(line);
}

function heading(line: string): {level: number; label: string} | undefined {
  const found = /^ {0,3}(#{1,6})\s+(.*\S)\s*$/.exec(line);
  if (!found) return undefined;
  let label = found[2];
  const closing = /(?:^|\s)#+$/.exec(label);
  if (closing) label = label.slice(0, closing.index).trimEnd();
  return {level: found[1].length, label: label || '#'};
}

type ListStart = {indent: number; ordered: boolean; number?: number; body: string};

function listStart(line: string): ListStart | undefined {
  const found = /^(\s*)(\S+)\s+(\S.*)$/.exec(line);
  if (!found) return undefined;
  const indent = found[1].length;
  const marker = found[2];
  if (BULLETS.has(marker)) return {indent, ordered: false, body: found[3]};
  const ordered = /^(\d+)[.)]$/.exec(marker);
  if (!ordered) return undefined;
  return {indent, ordered: true, number: Number(ordered[1]), body: found[3]};
}

function taskAt(body: string): {checked: boolean; rest: string} | undefined {
  if (body[0] !== '[' || body[2] !== ']') return undefined;
  const checked = TASK_STATES.get(body[1].toLowerCase());
  if (checked === undefined) return undefined;
  const rest = body.slice(3).replace(/^\s+/, '');
  if (!rest || rest === body.slice(3)) return undefined;
  return {checked, rest};
}

function tableCells(line: string | undefined): string[] | undefined {
  const trimmed = line?.trim();
  if (trimmed === undefined) return undefined;
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined;
  const cells: string[] = [];
  let current = '';
  for (let i = 1; i < trimmed.length - 1; i++) {
    if (trimmed[i] === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i++;
    } else if (trimmed[i] === '|') {
      cells.push(current.trim());
      current = '';
    } else current += trimmed[i];
  }
  cells.push(current.trim());
  return cells;
}

function alignment(row: string[]): Array<'left' | 'center' | 'right'> | undefined {
  if (!row.length) return undefined;
  const result: Array<'left' | 'center' | 'right'> = [];
  for (const cell of row) {
    if (!/^:?-+:?$/.test(cell)) return undefined;
    const leading = cell.startsWith(':');
    const trailing = cell.endsWith(':');
    result.push(leading && trailing ? 'center' : trailing ? 'right' : 'left');
  }
  return result;
}

function isTableHead(lines: string[], index: number): boolean {
  const cells = tableCells(lines[index]);
  return !!cells && !!alignment(tableCells(lines[index + 1]) ?? []);
}

function closingBracket(line: string, from: number): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === ']') return i;
  }
  return -1;
}

type Definition = {label: string; value: string; note: boolean};

function definitionAt(line: string): Definition | undefined {
  const opener = /^ {0,3}\[/.exec(line);
  if (!opener) return undefined;
  const from = opener[0].length;
  const close = closingBracket(line, from);
  if (close < 0 || line[close + 1] !== ':') return undefined;
  const tail = line.slice(close + 2);
  if (!/^\s/.test(tail)) return undefined;
  const value = tail.trim();
  if (!value) return undefined;
  const raw = line.slice(from, close);
  const note = raw.startsWith('^');
  const label = note ? raw.slice(1) : raw;
  if (!label || label.includes('[')) return undefined;
  return {label, value: note ? value : value.split(/\s+/)[0], note};
}

function collectDefinitions(lines: string[]): {body: string[]; defs: Definitions} {
  const links = new Map<string, string>();
  const notes: Array<[string, string]> = [];
  const body = lines.map((line) => {
    const found = definitionAt(line);
    if (!found) return line;
    if (found.note) notes.push([found.label, found.value]);
    else links.set(found.label.toLowerCase(), found.value);
    return '';
  });
  return {
    body,
    defs: {links, notes, noteNumbers: new Map(notes.map(([id], i) => [id, i + 1]))}
  };
}

function detailsAt(line: string): {open: boolean} | undefined {
  return /^\s*<details(?:\s|>|$)/i.test(line) ? {open: /\bopen\b/i.test(line)} : undefined;
}

function splitSummary(body: string): {title: string; rest: string} {
  const opener = /<summary\b[^>]*>/i.exec(body);
  if (!opener) return {title: '', rest: body};
  const from = opener.index + opener[0].length;
  const closer = /<\/summary\s*>/i.exec(body.slice(from));
  if (!closer) return {title: '', rest: body};
  return {
    title: body.slice(from, from + closer.index),
    rest: body.slice(0, opener.index) + body.slice(from + closer.index + closer[0].length)
  };
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  if (!line.trim()) return true;
  return (
    !!fenceAt(line) ||
    isMathFence(line) ||
    !!heading(line) ||
    divider(line) ||
    !!detailsAt(line) ||
    line.startsWith('>') ||
    isTableHead(lines, index) ||
    !!listStart(line)
  );
}

function parseList(
  lines: string[],
  start: number,
  defs: Definitions
): {node: MarkdownBlock; next: number} {
  const first = listStart(lines[start])!;
  const items: MarkdownListItem[] = [];
  let i = start;

  while (i < lines.length) {
    const current = listStart(lines[i]);
    if (!current || current.indent !== first.indent || current.ordered !== first.ordered) break;

    const task = taskAt(current.body);
    const item: MarkdownListItem = {content: inline(task ? task.rest : current.body, defs)};
    if (first.ordered) item.number = current.number;
    if (task) item.checked = task.checked;
    i++;

    if (i < lines.length && (listStart(lines[i])?.indent ?? -1) > first.indent) {
      const nested = parseList(lines, i, defs);
      item.nodes = [nested.node];
      i = nested.next;
    }
    items.push(item);
  }
  return {node: {kind: 'list', ordered: first.ordered, items}, next: i};
}

function readUntil(
  lines: string[],
  from: number,
  stop: (line: string) => boolean
): {
  body: string[];
  next: number;
} {
  const body: string[] = [];
  let i = from;
  while (i < lines.length && !stop(lines[i])) body.push(lines[i++]);
  return {body, next: i < lines.length ? i + 1 : i};
}

function parseLines(lines: string[], defs: Definitions): MarkdownBlock[] {
  const nodes: MarkdownBlock[] = [];

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    if (/^(?: {4}|\t)/.test(line) && nodes[nodes.length - 1]?.kind !== 'list') {
      const body: string[] = [];
      while (i < lines.length && (/^(?: {4}|\t)/.test(lines[i]) || !lines[i].trim()))
        body.push(lines[i++].replace(/^(?: {4}|\t)/, ''));
      while (!body[body.length - 1].trim()) body.pop();
      nodes.push({kind: 'code', value: body.join('\n'), language: ''});
      continue;
    }

    const open = fenceAt(line);
    if (open) {
      const {body, next} = readUntil(lines, i + 1, (l) => closesFence(l, open));
      nodes.push({kind: 'code', value: body.join('\n'), language: open.language});
      i = next;
      continue;
    }

    if (isMathFence(line)) {
      const {body, next} = readUntil(lines, i + 1, isMathFence);
      nodes.push({kind: 'mathBlock', value: body.join('\n')});
      i = next;
      continue;
    }

    const title = heading(line);
    if (title) {
      if (title.level > 1) {
        const name = headingSlug(title.label);
        if (name) nodes.push({kind: 'anchor', name});
      }
      nodes.push({kind: 'heading', level: title.level, content: inline(title.label, defs)});
      i++;
      continue;
    }

    if (divider(line)) {
      nodes.push({kind: 'divider'});
      i++;
      continue;
    }

    const details = detailsAt(line);
    if (details) {
      const {body, next} = readUntil(lines, i + 1, (l) => /^\s*<\/details\s*>\s*$/i.test(l));
      const {title: summary, rest} = splitSummary(body.join('\n'));
      nodes.push({
        kind: 'details',
        title: inline(summary, defs),
        open: details.open,
        nodes: parseLines(rest.split('\n'), defs)
      });
      i = next;
      continue;
    }

    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith('>'))
        quote.push(lines[i++].replace(/^> ?/, ''));
      nodes.push({kind: 'quote', nodes: parseLines(quote, defs)});
      continue;
    }

    if (isTableHead(lines, i)) {
      const align = alignment(tableCells(lines[i + 1]) ?? [])!;
      const rows: MarkdownTableCell[][] = [
        tableCells(line)!.map((value, col) => ({
          content: inline(value, defs),
          header: true,
          align: align[col] ?? 'left'
        }))
      ];
      i += 2;
      while (i < lines.length) {
        const values = tableCells(lines[i]);
        if (!values || alignment(values)) break;
        rows.push(
          values.map((value, col) => ({
            content: inline(value, defs),
            header: false,
            align: align[col] ?? 'left'
          }))
        );
        i++;
      }
      nodes.push({kind: 'table', rows});
      continue;
    }

    if (listStart(line)) {
      const parsed = parseList(lines, i, defs);
      nodes.push(parsed.node);
      i = parsed.next;
      continue;
    }

    const paragraph: string[] = [line];
    i++;
    while (i < lines.length && !startsBlock(lines, i)) paragraph.push(lines[i++]);
    nodes.push({kind: 'paragraph', content: inline(paragraph.join('\n'), defs)});
  }
  return nodes;
}

function notesSection(defs: Definitions): MarkdownBlock[] {
  if (!defs.notes.length) return [];
  const items: MarkdownListItem[] = defs.notes.map(([, value], index) => {
    const n = index + 1;
    return {
      number: n,
      content: [
        {
          kind: 'anchor',
          name: `note-${n}`,
          marks: [{kind: 'link', href: `#note-ref-${n}`, marks: text(String(n))}]
        },
        {kind: 'text', value: '. '},
        ...inline(value, defs)
      ]
    };
  });
  return [
    {kind: 'heading', level: 3, content: text('Notes')},
    {kind: 'list', ordered: true, items}
  ];
}

export function parseMarkdownDocument(raw: string): MarkdownDocument {
  const {body, defs} = collectDefinitions(raw.replace(/\r\n?/g, '\n').split('\n'));
  return {nodes: [...parseLines(body, defs), ...notesSection(defs)]};
}
