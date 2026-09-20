import {hydrateViewState} from './state';
import '@/shell/tailwind.css';
import './git.css';
import {openGitViewer} from './gitViewer';
import {installCodeCopy} from '@/features/code/viewer';
import {applyCycScrollTheme} from '@/plugins/scrollTheme';
import {cyc} from './cyc';

function applyTheme(): void {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

async function boot(): Promise<void> {
  applyTheme();
  document.body.innerHTML = '<div id="cyc-app"><div id="cyc-stage"></div></div>';
  // TS-own the native scrollbar tints on #cyc-app (was the git.css day/night
  // `--cyc-overflow*` value blocks); the retained pseudo/skin still reads them.
  const root = document.getElementById('cyc-app');
  if (root) applyCycScrollTheme(document.documentElement.dataset.theme === 'dark', root);
  installCodeCopy(document);
  await hydrateViewState();
  openGitViewer('page', '', () => cyc()?.close());
}

void boot();
