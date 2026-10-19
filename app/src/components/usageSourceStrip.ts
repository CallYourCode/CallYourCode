import {h} from './domHelpers';

export type UsageSource = 'claude' | 'codex' | 'grok';
export const isUsageSource = (value: unknown): value is UsageSource =>
  value === 'claude' || value === 'codex' || value === 'grok';
const ORDER: UsageSource[] = ['claude', 'codex', 'grok'];
const LOGOS = {
  claude: {
    name: 'Claude',
    bg: '#d97757',
    svg: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 1.5l1.6 7.3 6.3-4-4 6.3 7.3 1.6-7.3 1.6 4 6.3-6.3-4L12 22.5l-1.6-7.3-6.3 4 4-6.3L.8 12l7.3-1.6-4-6.3 6.3 4z"/></svg>'
  },
  codex: {
    name: 'Codex',
    bg: '#111111',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7l5 5-5 5M13 18h7"/></svg>'
  },
  grok: {
    name: 'Grok',
    bg: '#2a2a2e',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="6.5"/><path d="M4 20L20 4"/></svg>'
  },
  deepseek: {
    name: 'DeepSeek',
    bg: '#4d6bfe',
    svg: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M3 13c2.5 0 3.5-3 7-3 4 0 5 4 9 3-1 4-4 6-8 6-4.5 0-7.5-2.5-8-6z"/><circle cx="16" cy="13.2" r="1" fill="#4d6bfe"/></svg>'
  }
};

// App chrome only. These static glyphs are the owner's variant C, not frame content.
export function createUsageSourceStrip() {
  const el = h(
    'div',
    'cyc-usage-source-strip cyc-off absolute top-1.5 start-2 z-[1] flex items-center gap-[3px] h-[22px]'
  );
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Usage source');
  let current: UsageSource | undefined;
  let onChange: ((source: UsageSource) => void) | undefined;
  let buttons: HTMLButtonElement[] = [];
  return {
    el,
    update(source?: UsageSource, change?: (source: UsageSource) => void) {
      current = source;
      onChange = change;
      el.classList.toggle('cyc-off', !source);
      if (!source) {
        el.replaceChildren();
        buttons = [];
        return;
      }
      if (!buttons.length) {
        for (const key of [...ORDER, 'deepseek'] as const) {
          const logo = LOGOS[key];
          const button = h(
            'button',
            'cyc-usage-source border-0 p-0 bg-transparent inline-flex items-center justify-center flex-none enabled:cursor-pointer enabled:active:scale-[.88] disabled:cursor-default'
          ) as HTMLButtonElement;
          button.type = 'button';
          button.dataset.source = key;
          button.setAttribute('aria-label', logo.name);
          button.title = key === 'deepseek' ? 'DeepSeek (not available yet)' : logo.name;
          if (key === 'deepseek') {
            button.disabled = true;
            button.setAttribute('aria-disabled', 'true');
          }
          const circle = h(
            'span',
            'rounded-full grid place-items-center flex-none [[data-theme=dark]_&]:shadow-[0_0_0_1px_rgba(255,255,255,.28)]'
          );
          circle.style.background = logo.bg;
          circle.innerHTML = logo.svg;
          circle.setAttribute('aria-hidden', 'true');
          button.append(circle);
          button.addEventListener('click', (event) => {
            event.stopPropagation();
            if (key === 'deepseek' || !current) return;
            onChange?.(key === current ? ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] : key);
          });
          buttons.push(button);
          el.append(button);
        }
      }
      for (const button of buttons) {
        const active = button.dataset.source === source;
        button.setAttribute('aria-pressed', String(active));
        const circle = button.firstElementChild as HTMLElement;
        circle.style.width = circle.style.height = active ? '18px' : '16px';
        circle.style.opacity = active ? '1' : '.35';
        circle.style.filter = active ? 'none' : 'grayscale(1)';
        const svg = circle.firstElementChild as SVGElement;
        svg.style.width = svg.style.height = active ? '12px' : '10px';
      }
    }
  };
}
