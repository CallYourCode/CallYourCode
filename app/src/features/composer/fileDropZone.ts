import {makeIcon} from '@/components/iconGlyphs';

interface FileDropOptions {
  icon?: Icon;
  title: string;
  hint?: string;
  onDrop: (e: DragEvent) => void;
}

export interface FileDrop {
  container: HTMLDivElement;
  destroy(): void;
}

function div(...classNames: string[]): HTMLDivElement {
  const el = document.createElement('div');
  el.className = classNames.join(' ');
  return el;
}

export function installFileDrop(root: HTMLElement, opts: FileDropOptions): FileDrop {
  // One target that fills its layer (flex-1 in the layer's column), with the
  // glyph over the label, centred.
  const container = div(
    'cyc-file-drop',
    'relative flex flex-1 min-h-0 w-full flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed',
    'border-[color:var(--cyc-text-muted)] bg-[color:color-mix(in_srgb,var(--cyc-surface)_88%,transparent)]',
    'px-8 text-center text-[color:var(--cyc-text-muted)] transition-colors duration-150',
    '[&.cyc-file-drop-over]:border-[color:var(--cyc-accent)] [&.cyc-file-drop-over]:text-[color:var(--cyc-accent)]'
  );
  if (opts.icon) {
    const iconEl = div('cyc-file-drop-icon', 'text-5xl');
    iconEl.append(makeIcon(opts.icon));
    container.append(iconEl);
  }
  const title = div('cyc-file-drop-title', 'font-semibold', 'text-lg');
  title.textContent = opts.title;
  container.append(title);
  if (opts.hint) {
    const hint = div('cyc-file-drop-hint', 'text-sm', 'opacity-75');
    hint.textContent = opts.hint;
    container.append(hint);
  }
  root.append(container);

  let depth = 0;
  const over = (event: DragEvent) => {
    event.preventDefault();
    depth += 1;
    container.classList.add('cyc-file-drop-over');
  };
  const leave = (event: DragEvent) => {
    event.preventDefault();
    depth = Math.max(0, depth - 1);
    if (!depth) container.classList.remove('cyc-file-drop-over');
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    depth = 0;
    container.classList.remove('cyc-file-drop-over');
    opts.onDrop(event);
  };
  container.addEventListener('dragenter', over);
  container.addEventListener('dragover', over);
  container.addEventListener('dragleave', leave);
  container.addEventListener('drop', drop);

  return {
    container,
    destroy() {
      container.replaceChildren();
      container.removeEventListener('dragenter', over);
      container.removeEventListener('dragover', over);
      container.removeEventListener('dragleave', leave);
      container.removeEventListener('drop', drop);
      container.parentElement?.removeChild(container);
    }
  };
}
