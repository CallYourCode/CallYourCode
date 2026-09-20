// Action controls retain the established touch target at each responsive width.
import {paintPresentation, type Presentation} from '@/components/presentation';

export function paintActionControlSize(el: HTMLElement): void {
  const run = (p: Presentation) => {
    el.style.setProperty('--cyc-circle-size', p.width === 'phone' ? '44px' : '52px');
  };
  paintPresentation(el, run);
}
