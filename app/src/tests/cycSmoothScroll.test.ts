import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {blockFor, smoothScrollTo, smoothScrollToBottom} from '../shared/smoothScroll';

function boxed(height: number): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({height}) as DOMRect;
  return el;
}

describe('smoothScroll blockFor tall-element guard', () => {
  const container = boxed(100);

  test('a short element keeps the requested block', () => {
    const element = boxed(20);
    expect(blockFor({container, element, position: 'center'})).toBe('center');
    expect(blockFor({container, element, position: 'end'})).toBe('end');
  });

  test('an element taller than the container top-aligns (block:start)', () => {
    const element = boxed(200);
    expect(blockFor({container, element, position: 'end'})).toBe('start');
  });
});

describe('smoothScrollTo', () => {
  const original = window.matchMedia;

  beforeEach(() => {
    window.matchMedia = vi.fn().mockReturnValue({matches: true}) as never;
  });
  afterEach(() => {
    window.matchMedia = original;
  });

  // Geometry for a container sitting at viewport top with the element 250px
  // into its content: rects for both boxes plus the container's scroll range.
  function seatable(elementTop: number, elementHeight: number) {
    const container = document.createElement('div');
    const element = document.createElement('div');
    container.append(element);
    document.body.append(container);
    container.getBoundingClientRect = () => ({top: 0, height: 100}) as DOMRect;
    element.getBoundingClientRect = () => ({top: elementTop, height: elementHeight}) as DOMRect;
    Object.defineProperty(container, 'clientHeight', {get: () => 100});
    Object.defineProperty(container, 'scrollHeight', {get: () => 1000});
    const scrollTo = ((container as HTMLElement).scrollTo = vi.fn((o: ScrollToOptions) => {
      container.scrollTop = o.top ?? 0;
    }) as never);
    return {container, element, scrollTo: scrollTo as ReturnType<typeof vi.fn>};
  }

  test('scrolls ONLY the container, seating the element at center', () => {
    const {container, element, scrollTo} = seatable(250, 20);
    const spy = (element.scrollIntoView = vi.fn());

    smoothScrollTo({container, element, position: 'center'});

    // elementTop 250 in content coords; centered: 250 - (100 - 20) / 2 = 210.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({top: 210, behavior: 'auto'});
    // Never through scrollIntoView: ancestor boxes must not move.
    expect(spy).not.toHaveBeenCalled();
    container.remove();
  });

  test('a tall element top-aligns (block:start)', () => {
    const {container, element, scrollTo} = seatable(250, 400);

    smoothScrollTo({container, element, position: 'end'});

    expect(scrollTo).toHaveBeenCalledWith({top: 250, behavior: 'auto'});
    container.remove();
  });

  test('the target is clamped to the container scroll range', () => {
    const {container, element, scrollTo} = seatable(980, 20);

    smoothScrollTo({container, element, position: 'end'});

    // end-aligned would be 980 + 20 - 100 = 900, exactly the max; push the
    // element past the end via a negative-top rect for the floor clamp too.
    expect(scrollTo).toHaveBeenCalledWith({top: 900, behavior: 'auto'});
    container.scrollTop = 0;
    element.getBoundingClientRect = () => ({top: -50, height: 20}) as DOMRect;
    smoothScrollTo({container, element, position: 'start'});
    expect(scrollTo).toHaveBeenLastCalledWith({top: 0, behavior: 'auto'});
    container.remove();
  });

  test('an element outside the container does not scroll', () => {
    const container = document.createElement('div');
    const element = document.createElement('div');
    document.body.append(container, element);
    const spy = (element.scrollIntoView = vi.fn());
    const scrollTo = ((container as HTMLElement).scrollTo = vi.fn() as never);

    smoothScrollTo({container, element, position: 'center'});

    expect(spy).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
    container.remove();
    element.remove();
  });
});

describe('smoothScrollToBottom', () => {
  const original = window.matchMedia;

  beforeEach(() => {
    window.matchMedia = vi.fn().mockReturnValue({matches: true}) as never;
  });
  afterEach(() => {
    window.matchMedia = original;
  });

  function scrollable(scrollHeight: number, clientHeight: number): HTMLElement {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', {get: () => scrollHeight});
    Object.defineProperty(el, 'clientHeight', {get: () => clientHeight});
    (el as HTMLElement & {scrollTo: (o: ScrollToOptions) => void}).scrollTo = (
      o: ScrollToOptions
    ) => {
      el.scrollTop = o.top ?? 0;
    };
    return el;
  }

  test('scrolls the container itself to the exact end of its content', async () => {
    const container = scrollable(6019, 852);
    document.body.append(container);

    await smoothScrollToBottom(container);

    expect(container.scrollTop).toBe(6019 - 852);
    container.remove();
  });

  test('never calls scrollIntoView (ancestor boxes must not move)', async () => {
    const container = scrollable(6019, 852);
    const spy = (container.scrollIntoView = vi.fn());
    document.body.append(container);

    await smoothScrollToBottom(container);

    expect(spy).not.toHaveBeenCalled();
    container.remove();
  });
});
