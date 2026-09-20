export type SetiIcon = [char: string, dark: string, light: string];
type SetiTable = {
  fallback: SetiIcon;
  names: Record<string, SetiIcon>;
  exts: Record<string, SetiIcon>;
};
const setiIcon = (char: string, color: string): SetiIcon => [char, color, color];
const text = setiIcon('', '#519aba');
const code = setiIcon('', '#cbcb41');
const config = setiIcon('', '#6d8086');
const media = setiIcon('', '#a074c4');
export const SETI: SetiTable = {
  fallback: setiIcon('', '#bfc2c1'),
  names: {
    '.env': config,
    '.gitignore': config,
    '.gitattributes': config,
    '.gitmodules': config,
    dockerfile: setiIcon('', '#519aba'),
    makefile: setiIcon('', '#e37933'),
    'package.json': setiIcon('', '#8dc149'),
    'tsconfig.json': setiIcon('', '#519aba'),
    'vite.config.ts': code,
    'eslint.config.mjs': code,
    readme: text,
    'readme.md': text,
    'readme.txt': text,
    'changelog.md': text,
    license: text,
    'license.md': text,
    'yarn.lock': config,
    'pnpm-lock.yaml': config,
    'package-lock.json': config,
    'bun.lock': config
  },
  exts: {
    ts: setiIcon('', '#519aba'),
    tsx: setiIcon('', '#519aba'),
    js: code,
    jsx: code,
    mjs: code,
    cjs: code,
    json: setiIcon('', '#8dc149'),
    json5: setiIcon('', '#8dc149'),
    html: setiIcon('', '#e37933'),
    htm: setiIcon('', '#e37933'),
    xml: setiIcon('', '#e37933'),
    svg: setiIcon('', '#a074c4'),
    css: setiIcon('', '#519aba'),
    scss: setiIcon('', '#f55385'),
    sh: setiIcon('', '#519aba'),
    bash: setiIcon('', '#519aba'),
    zsh: setiIcon('', '#519aba'),
    ps1: setiIcon('', '#519aba'),
    py: setiIcon('', '#519aba'),
    go: setiIcon('', '#519aba'),
    rs: setiIcon('', '#6d8086'),
    java: setiIcon('', '#cc3e44'),
    c: setiIcon('', '#519aba'),
    h: setiIcon('', '#519aba'),
    cpp: setiIcon('', '#519aba'),
    cc: setiIcon('', '#519aba'),
    hpp: setiIcon('', '#519aba'),
    cs: setiIcon('', '#519aba'),
    sql: setiIcon('', '#f55385'),
    yml: setiIcon('', '#a074c4'),
    yaml: setiIcon('', '#a074c4'),
    md: text,
    markdown: text,
    diff: setiIcon('', '#a074c4'),
    patch: setiIcon('', '#a074c4'),
    toml: config,
    graphql: setiIcon('', '#f55385'),
    gql: setiIcon('', '#f55385'),
    kt: setiIcon('', '#e37933'),
    swift: setiIcon('', '#e37933'),
    rb: setiIcon('', '#cc3e44'),
    php: setiIcon('', '#e37933'),
    lua: setiIcon('', '#519aba'),
    png: media,
    jpg: media,
    jpeg: media,
    gif: media,
    webp: media,
    avif: media,
    mp3: setiIcon('', '#a074c4'),
    wav: setiIcon('', '#a074c4'),
    ogg: setiIcon('', '#a074c4'),
    flac: setiIcon('', '#a074c4'),
    mp4: setiIcon('', '#f55385'),
    webm: setiIcon('', '#f55385'),
    mov: setiIcon('', '#f55385'),
    pdf: setiIcon('', '#cc3e44'),
    doc: text,
    docx: text,
    txt: text,
    zip: setiIcon('', '#cc3e44'),
    tar: setiIcon('', '#cc3e44'),
    gz: setiIcon('', '#cc3e44'),
    exe: setiIcon('', '#8dc149'),
    bin: setiIcon('', '#8dc149')
  }
};
type IconPaint = {char: string; color: string};
function pick(icon: SetiIcon | undefined, dark: boolean): IconPaint | null {
  if (!icon) return null;
  return {char: icon[0], color: dark ? icon[1] : icon[2]};
}
export function fileIcon(name: string, dark: boolean): IconPaint {
  const lower = name.toLowerCase();
  const byName = SETI.names[lower];
  if (byName) return pick(byName, dark)!;
  const ext = lower.slice(lower.lastIndexOf('.') + 1);
  return pick(SETI.exts[ext] ?? SETI.fallback, dark)!;
}
export const FOLDER_SVG =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<path fill="none" stroke="currentColor" stroke-width="1.1" ' +
  'd="M1.6 3.2h4.2l1.3 1.5h7.3v8.1H1.6z"/></svg>';
export const FOLDER_OPEN_SVG =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<path fill="none" stroke="currentColor" stroke-width="1.1" ' +
  'd="M1.6 12.8V3.2h4.2l1.3 1.5h5.6v2.1M1.6 12.8l2-6h11.1l-2.1 6z"/></svg>';
export const CHEVRON_SVG =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<path fill="none" stroke="currentColor" stroke-width="1.3" ' +
  'stroke-linecap="round" stroke-linejoin="round" d="M6 3.5L10.5 8L6 12.5"/></svg>';
const PRISM_OF: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  json5: 'json',
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  lua: 'lua',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'docker',
  makefile: 'makefile',
  graphql: 'graphql',
  gql: 'graphql'
};
const PRISM_BY_NAME: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'makefile',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.env': 'bash'
};
export function prismLanguage(name: string): string {
  const lower = name.toLowerCase();
  if (PRISM_BY_NAME[lower]) return PRISM_BY_NAME[lower];
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return '';
  return PRISM_OF[lower.slice(dot + 1)] ?? '';
}
export const TABLER = {
  sessions:
    '<path d="M13 9a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-6a1 1 0 0 1 -1 -1v-10"/><path d="M18 8v-3a1 1 0 0 0 -1 -1h-13a1 1 0 0 0 -1 1v12a1 1 0 0 0 1 1h9"/><path d="M16 9h2"/>',
  darkMode:
    '<path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454l0 .008"/>',
  edit: '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/>',
  eye: '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>',
  eyeOff:
    '<path d="M10.585 10.587a2 2 0 0 0 2.829 2.828"/><path d="M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87"/><path d="M3 3l18 18"/>',
  image:
    '<path d="M15 8h.01"/><path d="M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12"/><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5"/><path d="M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3"/>',
  keyboard:
    '<path d="M2 8a2 2 0 0 1 2 -2h16a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2l0 -8"/><path d="M6 10l0 .01"/><path d="M10 10l0 .01"/><path d="M14 10l0 .01"/><path d="M18 10l0 .01"/><path d="M6 14l0 .01"/><path d="M18 14l0 .01"/><path d="M10 14l4 .01"/>',
  send: '<path d="M12 5l0 14"/><path d="M16 9l-4 -4"/><path d="M8 9l4 -4"/>',
  newConversation:
    '<path d="M3 20l1.3 -3.9c-2.324 -3.437 -1.426 -7.872 2.1 -10.374c3.526 -2.501 8.59 -2.296 11.845 .48c3.255 2.777 3.695 7.266 1.029 10.501c-2.666 3.235 -7.615 4.215 -11.574 2.293l-4.7 1"/>',
  replace:
    '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>',
  add: '<path d="M12 5l0 14"/><path d="M5 12l14 0"/>',
  arrowDown: '<path d="M12 5l0 14"/><path d="M18 13l-6 6"/><path d="M6 13l6 6"/>',
  attach:
    '<path d="M15 7l-6.5 6.5a1.5 1.5 0 0 0 3 3l6.5 -6.5a3 3 0 0 0 -6 -6l-6.5 6.5a4.5 4.5 0 0 0 9 9l6.5 -6.5"/>',
  check: '<path d="M5 12l5 5l10 -10"/>',
  deliveryAccepted: '<path d="M5 12l5 5l10 -10"/>',
  deliveryConfirmed: '<path d="M7 12l5 5l10 -10"/><path d="M2 12l5 5m5 -5l5 -5"/>',
  qr: '<path d="M4 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M7 17l0 .01"/><path d="M14 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M7 7l0 .01"/><path d="M4 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M17 7l0 .01"/><path d="M14 14l3 0"/><path d="M20 14l0 .01"/><path d="M14 14l0 3"/><path d="M14 20l3 0"/><path d="M17 17l3 0"/><path d="M20 17l0 3"/>',
  close: '<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>',
  copy: '<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666"/><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"/>',
  delete:
    '<path d="M4 7l16 0"/><path d="M10 11l0 6"/><path d="M14 11l0 6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/>',
  document:
    '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2"/><path d="M9 9l1 0"/><path d="M9 13l6 0"/><path d="M9 17l6 0"/>',
  download:
    '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/>',
  down: '<path d="M6 9l6 6l6 -6"/>',
  equalizer:
    '<path d="M12 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M4 6l8 0"/><path d="M16 6l4 0"/><path d="M6 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M4 12l2 0"/><path d="M10 12l10 0"/><path d="M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M4 18l11 0"/><path d="M19 18l1 0"/>',
  contextbar: '<rect x="8" y="3" width="8" height="18" rx="2.5"/>',
  folder:
    '<path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/>',
  gitbranch:
    '<path d="M5 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M5 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M15 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M7 8l0 8"/><path d="M9 18h6a2 2 0 0 0 2 -2v-5"/><path d="M14 14l3 -3l3 3"/>',
  hand: '<path d="M8 13v-7.5a1.5 1.5 0 0 1 3 0v6.5"/><path d="M11 5.5v-2a1.5 1.5 0 1 1 3 0v8.5"/><path d="M14 5.5a1.5 1.5 0 0 1 3 0v6.5"/><path d="M17 7.5a1.5 1.5 0 0 1 3 0v8.5a6 6 0 0 1 -6 6h-2h.208a6 6 0 0 1 -5.012 -2.7a69.74 69.74 0 0 1 -.196 -.3c-.312 -.479 -1.407 -2.388 -3.286 -5.728a1.5 1.5 0 0 1 .536 -2.022a1.867 1.867 0 0 1 2.28 .28l1.47 1.47"/>',
  info: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 9h.01"/><path d="M11 12h1v4h1"/>',
  left: '<path d="M15 6l-6 6l6 6"/>',
  lock: '<path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6"/><path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"/><path d="M8 11v-4a4 4 0 1 1 8 0v4"/>',
  list: '<path d="M9 6l11 0"/><path d="M9 12l11 0"/><path d="M9 18l11 0"/><path d="M5 6l0 .01"/><path d="M5 12l0 .01"/><path d="M5 18l0 .01"/>',
  menu: '<path d="M4 6l16 0"/><path d="M4 12l16 0"/><path d="M4 18l16 0"/>',
  microphone:
    '<path d="M9 5a3 3 0 0 1 3 -3a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3a3 3 0 0 1 -3 -3l0 -5"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M8 21l8 0"/><path d="M12 17l0 4"/>',
  record:
    '<path d="M9 5a3 3 0 0 1 3 -3a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3a3 3 0 0 1 -3 -3l0 -5"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M8 21l8 0"/><path d="M12 17l0 4"/>',
  mute: '<path d="M9.346 5.353c.21 -.129 .428 -.246 .654 -.353a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3m-1 3h-13a4 4 0 0 0 2 -3v-3a6.996 6.996 0 0 1 1.273 -3.707"/><path d="M9 17v1a3 3 0 0 0 6 0v-1"/><path d="M3 3l18 18"/>',
  next: '<path d="M9 6l6 6l-6 6"/>',
  speakerMuted:
    '<path d="M15 8a5 5 0 0 1 1.912 4.934m-1.377 2.602a5 5 0 0 1 -.535 .464"/><path d="M17.7 5a9 9 0 0 1 2.362 11.086m-1.676 2.299a9 9 0 0 1 -.686 .615"/><path d="M9.069 5.054l.431 -.554a.8 .8 0 0 1 1.5 .5v2m0 4v8a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l1.294 -1.664"/><path d="M3 3l18 18"/>',
  pause:
    '<path d="M6 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12"/><path d="M14 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12"/>',
  phone:
    '<path d="M5 4h4l2 5l-2.5 1.5a11 11 0 0 0 5 5l1.5 -2.5l5 2v4a2 2 0 0 1 -2 2a16 16 0 0 1 -15 -15a2 2 0 0 1 2 -2"/>',
  play: '<path d="M7 4v16l13 -8l-13 -8"/>',
  previous: '<path d="M15 6l-6 6l6 6"/>',
  reply: '<path d="M9 14l-4 -4l4 -4"/><path d="M5 10h11a4 4 0 1 1 0 8h-1"/>',
  robot:
    '<path d="M6 4m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z"/><path d="M12 2v2"/><path d="M9 12v9"/><path d="M15 12v9"/><path d="M5 16l4 -2"/><path d="M15 14l4 2"/><path d="M9 18h6"/><path d="M10 8v.01"/><path d="M14 8v.01"/>',
  refresh: '<path d="M19.95 11a8 8 0 1 0 -.5 4m.5 5v-5h-5"/>',
  search: '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/>',
  deliveryPending: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 7v5l3 3"/>',
  deliveryFailed:
    '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  settings:
    '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>',
  speaker:
    '<path d="M15 8a5 5 0 0 1 0 8"/><path d="M17.7 5a9 9 0 0 1 0 14"/><path d="M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5"/>',
  speakerOff:
    '<path d="M15 8a5 5 0 0 1 1.912 4.934m-1.377 2.602a5 5 0 0 1 -.535 .464"/><path d="M17.7 5a9 9 0 0 1 2.362 11.086m-1.676 2.299a9 9 0 0 1 -.686 .615"/><path d="M9.069 5.054l.431 -.554a.8 .8 0 0 1 1.5 .5v2m0 4v8a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l1.294 -1.664"/><path d="M3 3l18 18"/>',
  terminal:
    '<path d="M8 9l3 3l-3 3"/><path d="M13 15l3 0"/><path d="M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12"/>',
  tools:
    '<path d="M3 21h4l13 -13a1.5 1.5 0 0 0 -4 -4l-13 13v4"/><path d="M14.5 5.5l4 4"/><path d="M12 8l-5 -5l-4 4l5 5"/><path d="M7 8l-1.5 1.5"/><path d="M16 12l5 5l-4 4l-5 -5"/><path d="M16 17l-1.5 1.5"/>',
  toolsOff:
    '<path d="M16 12l4 -4a2.828 2.828 0 1 0 -4 -4l-4 4m-2 2l-7 7v4h4l7 -7"/><path d="M14.5 5.5l4 4"/><path d="M12 8l-5 -5m-2 2l-2 2l5 5"/><path d="M7 8l-1.5 1.5"/><path d="M16 12l5 5m-2 2l-2 2l-5 -5"/><path d="M16 17l-1.5 1.5"/><path d="M3 3l18 18"/>',
  unmute:
    '<path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6"/><path d="M9 17v1a3 3 0 0 0 6 0v-1"/>',
  up: '<path d="M6 15l6 -6l6 6"/>',
  user: '<path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0"/><path d="M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/>',
  volumeUp:
    '<path d="M15 8a5 5 0 0 1 0 8"/><path d="M17.7 5a9 9 0 0 1 0 14"/><path d="M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5"/>',
  bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7h-6z"/><path d="M13 12h1a3.5 3.5 0 0 1 0 7h-7v-7"/>',
  bug: '<path d="M9 9v-1a3 3 0 0 1 6 0v1"/><path d="M8 9h8a6 6 0 0 1 1 3v3a5 5 0 0 1 -10 0v-3a6 6 0 0 1 1 -3"/><path d="M3 13l4 0"/><path d="M17 13l4 0"/><path d="M12 20l0 -6"/><path d="M4 19l3.35 -2"/><path d="M20 19l-3.35 -2"/><path d="M4 7l3.75 2.4"/><path d="M20 7l-3.75 2.4"/>',
  cameraAdd:
    '<path d="M12 20h-7a3 3 0 0 1 -3 -3v-9a3 3 0 0 1 3 -3h1a2 2 0 0 0 2 -2a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a3 3 0 0 1 3 3v3.5"/><path d="M16 19h6"/><path d="M19 16v6"/><path d="M9 13a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>',
  fullscreen:
    '<path d="M4 8v-2a2 2 0 0 1 2 -2h2"/><path d="M4 16v2a2 2 0 0 0 2 2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M16 20h2a2 2 0 0 0 2 -2v-2"/>',
  group:
    '<path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/>',
  help: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 17l0 .01"/><path d="M12 13.5a1.5 1.5 0 0 1 1 -1.5a2.6 2.6 0 1 0 -3 -4"/>',
  italic: '<path d="M11 5l6 0"/><path d="M7 19l6 0"/><path d="M14 5l-4 14"/>',
  message:
    '<path d="M8 9h8"/><path d="M8 13h6"/><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"/>',
  quote:
    '<path d="M10 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5"/><path d="M19 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5"/>',
  quoteOutline:
    '<path d="M10 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5"/><path d="M19 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5"/>',
  markRead: '<path d="M7 12l5 5l10 -10"/><path d="M2 12l5 5m5 -5l5 -5"/>',
  sortByDate: '<path d="M3 9l4 -4l4 4m-4 -4v14"/><path d="M21 15l-4 4l-4 -4m4 4v-14"/>',
  statistics:
    '<path d="M3 13a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M15 9a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M9 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M4 20h14"/>',
  strikethrough:
    '<path d="M5 12l14 0"/><path d="M16 6.5a4 2 0 0 0 -4 -1.5h-1a3.5 3.5 0 0 0 0 7h2a3.5 3.5 0 0 1 0 7h-1.5a4 2 0 0 1 -4 -1.5"/>',
  underline: '<path d="M7 5v5a5 5 0 0 0 10 0v-5"/><path d="M5 19h14"/>',
  unread:
    '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/>'
} satisfies Record<string, string>;
import {
  ROBOT_DECO,
  ROBOT_KITS,
  ROBOT_SKELETON,
  ROBOT_STROKE,
  ROBOT_VIEWBOX
} from '../../data/robotLetters';
const A = 'A'.charCodeAt(0);
function hasRobotLetter(ch: string): boolean {
  return ch.length === 1 && ch >= 'A' && ch <= 'Z';
}
const cache = new Map<string, string>();
const TILE_VAR = 'var(--cyc-avatar-tile,#fff)';
function skeleton(letter: string, kit: number, tile = TILE_VAR): string {
  const [ink, hollow] = ROBOT_STROKE[kit];
  const ds = ROBOT_SKELETON[letter].split(';');
  const paths = ds.map((d) => `<path d="${d}"/>`).join('');
  return (
    `<g stroke-width="${ink}">${paths}</g>` +
    `<g class="h" stroke-width="${hollow}" style="stroke:${tile}">${paths}</g>`
  );
}
function decoration(letter: string, kit: number, fill = 'currentColor', tile = TILE_VAR): string {
  const src = ROBOT_DECO[kit][letter.charCodeAt(0) - A];
  if (!src) return '';
  let out = '';
  for (const el of src.split(';')) {
    const f = el.slice(1).split(' ');
    if (el[0] === 'c') {
      const paint = f[3];
      const cls =
        paint === 'f'
          ? ` class="f" style="fill:${fill};stroke:none"`
          : paint === 't'
            ? ` class="t" style="fill:${tile}" stroke-width="1.8"`
            : '';
      const w = paint[0] === 'o' ? ` stroke-width="${paint.slice(1)}"` : '';
      out += `<circle cx="${f[0]}" cy="${f[1]}" r="${f[2]}"${cls}${w}/>`;
    } else if (el[0] === 'l') {
      out += `<line x1="${f[0]}" y1="${f[1]}" x2="${f[2]}" y2="${f[3]}" stroke-width="${f[4]}"/>`;
    } else {
      const cx = Number(f[0]) + Number(f[2]) / 2,
        cy = Number(f[1]) + Number(f[3]) / 2;
      out +=
        `<rect x="${f[0]}" y="${f[1]}" width="${f[2]}" height="${f[3]}" rx="${f[4]}"` +
        ` stroke-width="${f[5]}" transform="rotate(${f[6]} ${cx} ${cy})"/>`;
    }
  }
  return out;
}
function robotLetterMarkup(letter: string, kit: number): string {
  const key = kit + letter;
  let svg = cache.get(key);
  if (svg === undefined) {
    svg =
      `<svg class="cyc-robot" viewBox="${ROBOT_VIEWBOX[letter]}" aria-hidden="true"` +
      ' style="position:absolute;top:8%;left:8%;width:84%;height:84%;fill:none;' +
      'stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;pointer-events:none">' +
      skeleton(letter, kit) +
      decoration(letter, kit) +
      '</svg>';
    cache.set(key, svg);
  }
  return svg;
}
export function robotLetter(letter: string, kit: number): SVGSVGElement | null {
  if (!hasRobotLetter(letter)) return null;
  const holder = document.createElement('div');
  holder.innerHTML = robotLetterMarkup(letter, kit % ROBOT_KITS.length);
  return holder.firstElementChild as SVGSVGElement;
}

/** The robot-letter fallback as a STANDALONE SVG document: literal colors, no
 *  CSS vars, no cascade -- renderable as a notification icon or a data URI.
 *  Deterministic for a given (letter, kit, tile, ink). Empty string when the
 *  letter has no robot glyph (the caller draws an initials tile instead). */
export function robotLetterBadge(
  letter: string,
  kit: number,
  tile: string,
  ink: string,
  size = 96
): string {
  if (!hasRobotLetter(letter)) return '';
  const k = kit % ROBOT_KITS.length;
  const inset = size * 0.08;
  const box = size * 0.84;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"` +
    ` viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${Math.round(size * 0.25)}" fill="${tile}"/>` +
    `<svg x="${inset}" y="${inset}" width="${box}" height="${box}"` +
    ` viewBox="${ROBOT_VIEWBOX[letter]}" fill="none" stroke="${ink}"` +
    ' stroke-linecap="round" stroke-linejoin="round">' +
    skeleton(letter, k, tile) +
    decoration(letter, k, ink, tile) +
    '</svg></svg>'
  );
}
