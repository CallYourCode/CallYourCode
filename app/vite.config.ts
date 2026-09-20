import {defineConfig, configDefaults} from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import checker from 'vite-plugin-checker';
import {visualizer} from 'rollup-plugin-visualizer';
import autoprefixer from 'autoprefixer';
import {resolve} from 'node:path';
import type {Plugin} from 'vite';
import {WSOLA_WORKLET_JS} from './src/audio/wsola';

const appRoot = resolve(import.meta.dirname);
const pluginEntries = {
  'git-page': 'src/plugins/git/plugin.html',
  'files-page': 'src/plugins/files/plugin.html'
} as const;

function emitWsolaWorklet(): Plugin {
  return {
    name: 'emit-cyc-wsola-worklet',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'cyc-wsola.js',
        source: WSOLA_WORKLET_JS
      });
    }
  };
}

function pluginConfig() {
  const entryName = process.env.CYC_PLUGIN_ENTRY as keyof typeof pluginEntries | undefined;
  const outputDirectory = process.env.CYC_PLUGIN_OUT_DIR;
  if (!entryName || !pluginEntries[entryName]) {
    throw new Error(`Unknown plugin entry: ${entryName ?? '(not set)'}`);
  }
  if (!outputDirectory) throw new Error('CYC_PLUGIN_OUT_DIR is required for a plugin build');

  return {
    base: './',
    build: {
      outDir: outputDirectory,
      target: 'es2020',
      sourcemap: false,
      emptyOutDir: true,
      copyPublicDir: false,
      cssCodeSplit: false,
      rollupOptions: {
        input: resolve(appRoot, pluginEntries[entryName]),
        output: {
          format: 'iife' as const,
          inlineDynamicImports: true,
          entryFileNames: 'plugin.js',
          assetFileNames: 'plugin.[ext]'
        }
      }
    }
  };
}

export default defineConfig(({mode}) => {
  const pluginMode = mode === 'plugins';
  const releaseBuild = Boolean(process.env.CYC_BUILD_STAMP);

  return {
    plugins: [
      tailwindcss(),
      !process.env.VITEST && !releaseBuild
        ? checker({
            typescript: true,
            eslint: {lintCommand: 'eslint "src/**/*.ts"', useFlatConfig: true}
          })
        : undefined,
      process.env.ANALYZE ? visualizer({template: 'treemap', gzipSize: true}) : undefined,
      emitWsolaWorklet()
    ].filter(Boolean),
    resolve: {
      alias: {
        '@shared': resolve(appRoot, '../engine/shared'),
        '@': resolve(appRoot, 'src')
      }
    },
    define: {__CYC_BUILD__: JSON.stringify(process.env.CYC_BUILD_STAMP ?? '')},
    server: {host: 'localhost', port: 8080},
    test: {
      environment: 'jsdom',
      globals: true,
      pool: 'forks',
      exclude: [...configDefaults.exclude, '**/e2e/**', '**/.lane-probe/**', '**/.verify-shots/**']
    },
    optimizeDeps: {entries: ['index.html']},
    css: {devSourcemap: true, postcss: {plugins: [autoprefixer()]}},
    worker: {format: 'es'},
    build: {
      target: 'es2020',
      outDir: 'dist',
      sourcemap: true,
      emptyOutDir: true,
      copyPublicDir: true,
      rollupOptions: {input: resolve(appRoot, 'index.html')}
    },
    ...(releaseBuild ? {base: './'} : {}),
    ...(pluginMode ? pluginConfig() : {})
  };
});
