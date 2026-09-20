// Plugin-page scrollbar tints, written on #cyc-app at boot.
const DAY: Record<string, string> = {
  '--cyc-overflow': 'rgba(100, 100, 100, 0.4)',
  '--cyc-overflow-hover': 'rgba(100, 100, 100, 0.7)',
  '--cyc-overflow-active': 'rgba(0, 0, 0, 0.6)'
};
const NIGHT: Record<string, string> = {
  '--cyc-overflow': 'rgba(121, 121, 121, 0.4)',
  '--cyc-overflow-hover': 'rgba(100, 100, 100, 0.7)',
  '--cyc-overflow-active': 'rgba(191, 191, 191, 0.4)'
};

// Write the three `--cyc-overflow*` tints inline on the plugin page root, matching
// the day/night value the git.css / files.css `#cyc-app` blocks used to define.
export function applyCycScrollTheme(dark: boolean, root: HTMLElement): void {
  const vars = dark ? NIGHT : DAY;
  for (const k in vars) root.style.setProperty(k, vars[k]);
}
