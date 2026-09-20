import {h} from '@/components/domHelpers';
import {makeIcon} from '@/components/iconGlyphs';
import {paintPresentation, type Presentation} from '@/components/presentation';

type JumpTarget = {id: string; name: string};

type JumpBar = {
  el: HTMLElement;

  update(waiting: JumpTarget[], activeId: string | null): void;
};

export function createJumpBar(onJump: (id: string) => void): JumpBar {
  const el = h('div', 'cyc-jump-bar cyc-off flex-auto min-w-0 flex items-stretch overflow-hidden');

  const paintZ = (p: Presentation) => {
    el.style.zIndex = p.width === 'phone' ? '2' : '';
  };
  paintPresentation(el, paintZ);

  const make = () => {
    const btn = h(
      'button',
      [
        'cyc-jump-btn cyc-jump-next',
        'relative flex flex-[1_1_100%] min-w-0 cursor-pointer items-center justify-end gap-1.5',
        'overflow-hidden border-none bg-transparent px-3 text-[0.875rem] text-[var(--cyc-accent)]',
        '[&.cyc-jump-empty]:text-[var(--cyc-text-muted)] [&.cyc-jump-empty]:opacity-40 [&.cyc-jump-empty]:cursor-default'
      ].join(' ')
    );
    const label = h('span', 'cyc-jump-label overflow-hidden text-ellipsis whitespace-nowrap');
    btn.append(label, makeIcon('next', 'cyc-jump-icon flex-none text-[1.25rem]'));
    return {btn, label};
  };

  const next = make();
  el.append(next.btn);

  let nextId: string | null = null;
  next.btn.addEventListener('click', () => {
    if (nextId) onJump(nextId);
  });

  const paint = (side: {btn: HTMLElement; label: HTMLElement}, t: JumpTarget | null) => {
    side.label.textContent = t ? t.name : '';
    side.btn.classList.toggle('cyc-jump-empty', !t);
    (side.btn as HTMLButtonElement).disabled = !t;
  };

  return {
    el,
    update(waiting, activeId) {
      const list = waiting.filter((t) => t.id !== activeId);
      el.classList.toggle('cyc-off', !list.length);
      if (!list.length) {
        nextId = null;
        return;
      }

      const at = waiting.findIndex((t) => t.id === activeId);
      const order = at >= 0 ? [...waiting.slice(at + 1), ...waiting.slice(0, at)] : list;
      const forward = order[0] ?? null;
      nextId = forward?.id ?? null;
      paint(next, forward);
    }
  };
}
