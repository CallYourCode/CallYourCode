import {build} from 'vite';
import {readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {fontFaces} from './plugin-fonts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');

const PANEL_HTML_MAX_BYTES = 1024 * 1024;

const PLUGINS = [
  {id: 'git-page', title: 'Git'},
  {id: 'files-page', title: 'Files'}
];

async function buildPlugin(id) {
  const tempDir = mkdtempSync(join(tmpdir(), 'callyourcode-plugin-'));
  const outDir = join(tempDir, id);
  process.env.CYC_PLUGIN_ENTRY = id;
  process.env.CYC_PLUGIN_OUT_DIR = outDir;
  try {
    await build({configFile: resolve(repo, 'vite.config.ts'), mode: 'plugins'});
    const js = readFileSync(join(outDir, 'plugin.js'), 'utf8');
    const cssPath = join(outDir, 'plugin.css');
    const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
    return {js, css};
  } finally {
    delete process.env.CYC_PLUGIN_ENTRY;
    delete process.env.CYC_PLUGIN_OUT_DIR;
    rmSync(tempDir, {recursive: true, force: true});
  }
}

export function assemble({title}, {js, css}, fonts) {
  const safeJs = js.replace(/<\/script>/gi, '<\\/script>');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${title}</title>` +
    '<style>' +
    fonts +
    '\n' +
    css +
    '</style>' +
    '</head><body>' +
    '<script>' +
    safeJs +
    '</script>' +
    '</body></html>'
  );
}

export async function buildPlugins() {
  const fonts = fontFaces();
  // build-cyc.sh builds into a staging dir (dist.next) and swaps it into dist
  // afterwards; a bare `npm run build:plugins` writes straight into dist.
  const distPlugins = join(repo, process.env.CYC_DIST_DIR || 'dist', 'plugins');
  rmSync(distPlugins, {recursive: true, force: true});
  mkdirSync(distPlugins, {recursive: true});

  let failed = false;
  for (const plugin of PLUGINS) {
    const parts = await buildPlugin(plugin.id);
    const html = assemble(plugin, parts, fonts);
    const bytes = Buffer.byteLength(html, 'utf8');
    const pct = ((bytes / PANEL_HTML_MAX_BYTES) * 100).toFixed(1);
    console.log(`${plugin.id}: ${bytes} bytes (${pct}% of the 1 MB cap)`);
    if (bytes > PANEL_HTML_MAX_BYTES) {
      console.error(`  OVER CAP by ${bytes - PANEL_HTML_MAX_BYTES} bytes`);
      failed = true;
    }

    writeFileSync(join(distPlugins, `${plugin.id}.html`), html);
  }

  if (failed) process.exitCode = 1;
  else console.log('plugins built.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPlugins();
}
