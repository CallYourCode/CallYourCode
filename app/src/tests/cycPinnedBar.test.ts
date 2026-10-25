import {afterEach, describe, expect, test, vi} from 'vitest';
import type {CycMenuItem} from '../components/popupMenu';
import type {MessagePin} from '@shared/message-pins';
import type {EngineAgentRun} from '../engine/contract';
const opened = vi.hoisted(() => [] as CycMenuItem[][]);
vi.mock('../components/popupMenu', () => ({openMenu: (items: CycMenuItem[]) => opened.push(items)}));
import {createAgentsBar} from '../features/sessions/components/agentsBar';
const pin = (id: string, pinnedAt: number): MessagePin => ({id, ts: 1, role: 'user', snippet: id, pinnedAt});
const run = (id: string, ts: number, endedTs: number | null = null): EngineAgentRun => ({
  toolUseId: id, agentId: id, ts, desc: id, endedTs, tokens: null
});
const snippet = (bar: ReturnType<typeof createAgentsBar>) => bar.el.querySelector('.cyc-agents-task')!.textContent;
const cycle = (bar: ReturnType<typeof createAgentsBar>) => (bar.el.querySelector('.cyc-agents-strip-wrap') as HTMLElement).click();
afterEach(() => { vi.useRealTimers(); opened.length = 0; });

describe('pins in the existing agents strip', () => {
  test('running then recent agents retain their order, then newest pins, and all slots cycle', () => {
    const bar = createAgentsBar();
    const now = Date.now();
    bar.update([run('done', now + 3, now), run('older run', now), run('newer run', now + 1),
      run('expired', now - 700_000, now - 700_000)], [pin('older pin', 1), pin('newer pin', 2)]);
    const rail = bar.el.querySelector<HTMLElement>('.cyc-agents-rail')!;
    expect(rail.style.getPropertyValue('--cyc-rail-slot')).toBe('20%');
    for (const text of ['newer run', 'older run', 'done', 'newer pin', 'older pin', 'newer run']) {
      expect(snippet(bar)).toBe(text);
      cycle(bar);
    }
  });
  test('pins alone show the bar and quiet go-to does not cycle', () => {
    const goTo = vi.fn();
    const bar = createAgentsBar({goTo});
    const newer = pin('new', 2);
    bar.update([], [pin('old', 1), newer]);
    expect(bar.el.classList.contains('cyc-off')).toBe(false);
    expect(bar.el.classList.contains('cyc-agents-idle')).toBe(true);
    expect(bar.el.querySelector('.cyc-agents-strip-title')!.textContent).toBe('Pinned, you');
    expect(bar.el.querySelector('.cyc-agents-strip-title svg')).not.toBeNull();
    const button = bar.el.querySelector<HTMLButtonElement>('.cyc-pin-goto')!;
    expect(button.className).toContain('text-base!');
    expect(button.className).not.toContain('accent');
    button.click();
    expect(goTo).toHaveBeenCalledWith(newer);
    expect(snippet(bar)).toBe('new');
    cycle(bar);
    expect(snippet(bar)).toBe('old');
    bar.update([], []);
    expect(bar.el.classList.contains('cyc-off')).toBe(true);
  });
  test('agent entries have no go-to; a pin context menu targets the shown pin', () => {
    const goTo = vi.fn(), unpin = vi.fn();
    const bar = createAgentsBar({goTo, unpin});
    const p = pin('target', 1);
    bar.update([run('agent', Date.now())], [p]);
    const wrapper = bar.el.querySelector<HTMLElement>('.cyc-agents-strip-wrap')!;
    expect(bar.el.querySelector('.cyc-pin-goto')!.classList.contains('cyc-off')).toBe(true);
    wrapper.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true}));
    expect(opened).toHaveLength(0);
    cycle(bar);
    wrapper.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true}));
    expect(opened[0].map((i) => i.text)).toEqual(['Go to message', 'Unpin']);
    opened[0][0].onClick({} as MouseEvent);
    opened[0][1].onClick({} as MouseEvent);
    expect(goTo).toHaveBeenCalledWith(p);
    expect(unpin).toHaveBeenCalledWith(p);
    expect(snippet(bar)).toBe('target');
  });
  test('long-press opens the pin menu and its release does not cycle; scrolling cancels it', () => {
    vi.useFakeTimers();
    const bar = createAgentsBar();
    bar.update([], [pin('new', 2), pin('old', 1)]);
    const wrapper = bar.el.querySelector<HTMLElement>('.cyc-agents-strip-wrap')!;
    const pointer = (type: string, x = 1) => {
      const event = new MouseEvent(type, {bubbles: true, clientX: x, clientY: 1});
      Object.defineProperty(event, 'pointerType', {value: 'touch'});
      wrapper.dispatchEvent(event);
    };
    pointer('pointerdown');
    vi.advanceTimersByTime(650);
    expect(opened).toHaveLength(1);
    pointer('pointerup');
    cycle(bar);
    expect(snippet(bar)).toBe('new');
    pointer('pointerdown'); pointer('pointermove', 30);
    vi.advanceTimersByTime(700);
    expect(opened).toHaveLength(1);
  });
});
