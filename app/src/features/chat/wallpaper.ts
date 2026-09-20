import {h} from '@/components/domHelpers';
import {paintPresentation, type Presentation} from '@/components/presentation';

const WASH_LIGHT =
  'cyc-thread-wash pointer-events-none absolute inset-0 ' +
  'bg-[radial-gradient(115%_115%_at_75%_10%,#ffffff_0%,rgba(255,255,255,0)_55%),radial-gradient(115%_115%_at_25%_35%,#e3e3e5_0%,rgba(227,227,229,0)_55%),radial-gradient(120%_120%_at_60%_85%,#ececee_0%,rgba(236,236,238,0)_60%)]';

const WASH_DARK =
  'cyc-thread-wash pointer-events-none absolute inset-0 opacity-[0.16] ' +
  'bg-[radial-gradient(115%_115%_at_75%_10%,#bdbdc0_0%,rgba(189,189,192,0)_55%),radial-gradient(115%_115%_at_25%_35%,#86868a_0%,rgba(134,134,138,0)_55%),radial-gradient(120%_120%_at_60%_85%,#5a5a5e_0%,rgba(90,90,94,0)_60%)] ' +
  '[-webkit-mask-image:var(--cyc-pattern)] [mask-image:var(--cyc-pattern)] ' +
  '[-webkit-mask-size:var(--cyc-pattern-size)] [mask-size:var(--cyc-pattern-size)] ' +
  '[-webkit-mask-position:center] [mask-position:center] ' +
  '[-webkit-mask-repeat:repeat] [mask-repeat:repeat]';

const PATTERN_LIGHT =
  'cyc-thread-pattern pointer-events-none absolute inset-0 bg-center bg-repeat opacity-[0.13] mix-blend-multiply ' +
  '[background-image:var(--cyc-pattern)] [background-size:var(--cyc-pattern-size)]';

const PATTERN_DARK = 'cyc-thread-pattern hidden';

export function paintChatWallpaper(el: HTMLElement, dark: boolean): void {
  el.classList.toggle('bg-[#08080a]', dark);
  if (!el.classList.contains('cyc-app-background')) {
    el.classList.toggle('bg-[#ece9e3]', !dark);
  }
  let wash = el.querySelector<HTMLElement>(':scope > .cyc-thread-wash');
  let pattern = el.querySelector<HTMLElement>(':scope > .cyc-thread-pattern');
  if (!wash) {
    wash = h('div', '');
    el.prepend(wash);
  }
  if (!pattern) {
    pattern = h('div', '');
    wash.after(pattern);
  }
  wash.className = dark ? WASH_DARK : WASH_LIGHT;
  pattern.className = dark ? PATTERN_DARK : PATTERN_LIGHT;
}

// Hide the app wallpaper on phone; the in-pane background paints there instead.
export function paintAppBackgroundWidth(el: HTMLElement): void {
  const run = (p: Presentation) => {
    el.classList.toggle('hidden', p.width === 'phone');
  };
  paintPresentation(el, run);
}

export function paintAllChatWallpapers(dark: boolean): void {
  document.querySelectorAll<HTMLElement>('.cyc-thread-background').forEach((el) => {
    paintChatWallpaper(el, dark);
  });
}
