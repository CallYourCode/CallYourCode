import {h} from './domHelpers';

export type UsageSource = 'claude' | 'codex' | 'grok' | 'deepseek';
export const isUsageSource = (value: unknown): value is UsageSource =>
  value === 'claude' || value === 'codex' || value === 'grok' || value === 'deepseek';
const ORDER: UsageSource[] = ['claude', 'codex', 'grok', 'deepseek'];
const LOGOS = {
  claude: {
    name: 'Claude',
    bg: '#d97757',
    svg: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 1.5l1.6 7.3 6.3-4-4 6.3 7.3 1.6-7.3 1.6 4 6.3-6.3-4L12 22.5l-1.6-7.3-6.3 4 4-6.3L.8 12l7.3-1.6-4-6.3 6.3 4z"/></svg>'
  },
  codex: {
    name: 'Codex',
    bg: '#111111',
    // OpenAI blossom: Simple Icons v11.15.0 openai.svg (CC0), unchanged path.
    svg: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>'
  },
  grok: {
    name: 'Grok',
    bg: '#2a2a2e',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="6.5"/><path d="M4 20L20 4"/></svg>'
  },
  deepseek: {
    name: 'DeepSeek',
    bg: '#4d6bfe',
    svg: '<svg viewBox="2 6 18 18" fill="#fff"><path d="M3 13c2.5 0 3.5-3 7-3 4 0 5 4 9 3-1 4-4 6-8 6-4.5 0-7.5-2.5-8-6z"/><circle cx="16" cy="13.2" r="1" fill="#4d6bfe"/></svg>'
  }
};

// App chrome only. Variant C circles with provider marks, not frame content.
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
        for (const key of ORDER) {
          const logo = LOGOS[key];
          const button = h(
            'button',
            'cyc-usage-source border-0 p-0 bg-transparent inline-flex items-center justify-center flex-none enabled:cursor-pointer enabled:active:scale-[.88] disabled:cursor-default'
          ) as HTMLButtonElement;
          button.type = 'button';
          button.dataset.source = key;
          button.setAttribute('aria-label', logo.name);
          button.title = logo.name;
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
            if (!current) return;
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
        const size =
          button.dataset.source === 'deepseek'
            ? active
              ? 16
              : 14
            : button.dataset.source === 'codex'
              ? active
                ? 14
                : 12
              : active
                ? 12
                : 10;
        svg.style.width = svg.style.height = `${size}px`;
      }
    }
  };
}
