import {beforeEach, describe, expect, test} from 'vitest';

import {createAgentsBar} from '../features/sessions/components/agentsBar';
import type {EngineAgentRun} from '../engine/contract';

const run = (over: Partial<EngineAgentRun> = {}): EngineAgentRun => ({
  toolUseId: 't1',
  agentId: 'a1',
  ts: Date.now(),
  desc: 'compiling',
  endedTs: null,
  tokens: null,
  ...over
});

const cls = (el: Element | null) => (el as HTMLElement | null)?.className ?? '';

let bar: ReturnType<typeof createAgentsBar>;
let el: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  bar = createAgentsBar();
  el = bar.el;
  document.body.append(el);
});

describe('agents-strip static utilities current from sessions.css', () => {
  test('strip-wrap carries the current flex/min/max/relative box', () => {
    const wrap = cls(el.querySelector('.cyc-agents-strip-wrap'));
    expect(wrap).toContain('max-w-full');
    expect(wrap).toContain('min-w-0');
    expect(wrap).toContain('flex-[1_1_0%]');
    expect(wrap).toContain('relative');
  });

  test('bar-content carries the pointer gate, has-stop gutter and the current content-column box', () => {
    const content = cls(el.querySelector('.cyc-agents-strip-content'));
    expect(content).toContain('pointer-events-none');
    expect(content).toContain('[.cyc-agents-has-stop_&]:pe-9');
    for (const tok of [
      'flex',
      'flex-col',
      'justify-end',
      'overflow-visible!',
      'min-w-0',
      'ms-2',
      'h-10',
      'relative'
    ]) {
      expect(content).toContain(tok);
    }
  });

  test('title carries the idle-dim variant plus the current base ink/weight and shared line box', () => {
    const t = cls(el.querySelector('.cyc-agents-strip-title'));
    expect(t).toContain('[.cyc-agents-idle_&]:text-[var(--cyc-text-muted)]');
    for (const tok of [
      'text-[var(--cyc-accent)]',
      'font-medium',
      'mb-[-2px]',
      '[font-size:0.875rem]',
      '[line-height:calc(0.875rem+4px)]',
      'whitespace-nowrap',
      'text-ellipsis',
      'overflow-hidden',
      'h-5',
      'min-h-5',
      '[transform:translateX(0)]',
      '[transition:transform_0.2s_ease-in-out]'
    ]) {
      expect(t).toContain(tok);
    }
  });

  test('subtitle carries the base ink, the done-entry fade self variant and the shared line box', () => {
    const sub = cls(el.querySelector('.cyc-agents-strip-subtitle'));
    expect(sub).toContain('text-[var(--cyc-text-muted)]');
    expect(sub).toContain('[&.cyc-agents-entry-done]:opacity-[0.65]');
    for (const tok of [
      '[font-size:0.875rem]',
      '[line-height:calc(0.875rem+4px)]',
      'whitespace-nowrap',
      'overflow-hidden',
      'flex',
      'items-baseline',
      'h-5',
      'min-h-5',
      '[transform:translateX(0)]',
      '[transition:transform_0.2s_ease-in-out]'
    ]) {
      expect(sub).toContain(tok);
    }
  });

  test('subtitle is a task span that truncates plus an age span that never shrinks', () => {
    bar.update([run({desc: 'a very long running task description that will not fit', ts: Date.now() - 20_000})]);
    const sub = el.querySelector('.cyc-agents-strip-subtitle') as HTMLElement;
    const task = sub.querySelector('.cyc-agents-task') as HTMLElement;
    const age = sub.querySelector('.cyc-agents-age') as HTMLElement;
    expect(Array.from(sub.children)).toEqual([task, age]);
    for (const tok of ['min-w-0', 'overflow-hidden', 'text-ellipsis', 'whitespace-nowrap']) {
      expect(task.className).toContain(tok);
    }
    for (const tok of ['flex-none', 'whitespace-pre']) {
      expect(age.className).toContain(tok);
    }
    expect(task.textContent).toBe('a very long running task description that will not fit');
    expect(age.textContent).toBe(' · 20s');
    expect(sub.textContent).toBe('a very long running task description that will not fit · 20s');
  });

  test('a done entry keeps the task in its span and the done suffix in the age span', () => {
    bar.update([run({desc: 'compiling', endedTs: Date.now(), tokens: '128'})]);
    const sub = el.querySelector('.cyc-agents-strip-subtitle') as HTMLElement;
    expect(sub.querySelector('.cyc-agents-task')!.textContent).toBe('compiling');
    expect(sub.querySelector('.cyc-agents-age')!.textContent).toBe(' · done, 128 tokens');
  });

  test('a pi run puts the model badge before the task span, with a logical end margin', () => {
    bar.update([run({source: 'pi', model: 'opus'})]);
    const sub = el.querySelector('.cyc-agents-strip-subtitle') as HTMLElement;
    const kids = Array.from(sub.children).map((k) => k.className.split(' ')[0]);
    expect(kids).toEqual(['cyc-agents-pi-badge', 'cyc-agents-task', 'cyc-agents-age']);
    const badge = sub.querySelector('.cyc-agents-pi-badge') as HTMLElement;
    expect(badge.textContent).toBe('opus');
    expect(badge.className).toContain('me-[0.4em]');
    expect(badge.className).toContain('flex-none');
    expect(badge.className).not.toContain('mr-[0.4em]');
  });

  test('stop control carries the absolute danger box and glyph size', () => {
    const stop = cls(el.querySelector('.cyc-agents-stop'));
    for (const tok of [
      'absolute',
      'end-1',
      'top-1/2',
      '-translate-y-1/2',
      'w-8',
      'h-8',
      'z-[1]',
      'pointer-events-auto',
      'text-[var(--cyc-danger)]',
      '[&_.cyc-icon]:text-[1.25rem]'
    ]) {
      expect(stop).toContain(tok);
    }
  });

  test('the rail box carries the idle-dim variant plus the fixed geometry and base name', () => {
    const rail = el.querySelector('.cyc-agents-rail') as HTMLElement;
    expect(cls(rail)).toContain('[.cyc-agents-idle_&]:opacity-45');
    for (const tok of ['cyc-agents-rail', 'relative', 'h-10', 'w-[0.1875rem]', 'flex-[0_0_auto]']) {
      expect(rail.classList.contains(tok)).toBe(true);
    }
    const slots = cls(rail.querySelector('.cyc-agents-rail-slots'));
    expect(slots).toContain('[background:repeating-linear-gradient(');
    expect(slots).toContain('var(--cyc-rail-slot)');
    expect(slots).toContain('opacity-40');
    expect(rail.style.getPropertyValue('--cyc-rail-slot')).toBe('100%');
  });

  test('the multi-run rail paints one dim gradient plus a single active overlay (no per-run pool)', () => {
    bar.update([run({toolUseId: 'a'}), run({toolUseId: 'b'})]);
    const rail = el.querySelector('.cyc-agents-rail') as HTMLElement;
    expect(rail.style.getPropertyValue('--cyc-rail-slot')).toBe('50%');
    expect(rail.children.length).toBe(2);
    expect(rail.querySelectorAll('.cyc-agents-rail-slots').length).toBe(1);
    expect(rail.querySelectorAll('.cyc-agents-rail-active').length).toBe(1);
    expect(rail.querySelector('svg')).toBeNull();
    expect(rail.querySelector('[clip-path]')).toBeNull();
    const active = el.querySelector('.cyc-agents-rail-active') as HTMLElement;
    for (const tok of [
      'absolute',
      'inset-x-0',
      'rounded-[3px]',
      'bg-(--cyc-accent)',
      '[transition:top_0.25s_ease-in-out]'
    ]) {
      expect(active.className).toContain(tok);
    }
  });

  test('the active overlay tracks the active cycle index via its normalized slot top', () => {
    bar.update([
      run({toolUseId: 'a'}),
      run({toolUseId: 'b'}),
      run({toolUseId: 'c'}),
      run({toolUseId: 'd'})
    ]);
    const active = el.querySelector('.cyc-agents-rail-active') as HTMLElement;
    const halfGap = (1 - 0.85) / 2;
    expect(active.style.top).toBe(`${(0 + halfGap) * 25}%`);
    expect(active.style.height).toBe(`${0.85 * 25}%`);
    (el.querySelector('.cyc-agents-strip-wrap') as HTMLElement).click();
    expect(active.style.top).toBe(`${(1 + halfGap) * 25}%`); // slot 1 + half-gap
  });

  test('dense slots fade the rail ends with a CSS mask, sparse slots do not', () => {
    const rail = el.querySelector('.cyc-agents-rail') as HTMLElement;
    Object.defineProperty(rail, 'clientHeight', {value: 37.5, configurable: true});
    bar.update([run({toolUseId: 'a'}), run({toolUseId: 'b'})]);
    expect(rail.style.getPropertyValue('mask-image')).toBe('');
    bar.update([
      run({toolUseId: 'a'}),
      run({toolUseId: 'b'}),
      run({toolUseId: 'c'}),
      run({toolUseId: 'd'}),
      run({toolUseId: 'e'}),
      run({toolUseId: 'f'})
    ]);
    expect(rail.style.getPropertyValue('mask-image')).toContain('linear-gradient');
  });
});

describe('agents-strip product-state classes the current variants key off', () => {
  test('a running pi agent is not idle and reveals the stop gutter', () => {
    bar.update([run({source: 'pi'})]);
    expect(el.classList.contains('cyc-agents-idle')).toBe(false);
    const wrap = el.querySelector('.cyc-agents-strip-wrap') as HTMLElement;
    expect(wrap.classList.contains('cyc-agents-has-stop')).toBe(true);
    expect(
      (el.querySelector('.cyc-agents-stop') as HTMLElement).classList.contains('cyc-off')
    ).toBe(false);
  });

  test('a freshly-done agent goes idle and fades the entry', () => {
    bar.update([run({endedTs: Date.now(), tokens: '128'})]);
    expect(el.classList.contains('cyc-agents-idle')).toBe(true);
    expect(
      (el.querySelector('.cyc-agents-strip-subtitle') as HTMLElement).classList.contains(
        'cyc-agents-entry-done'
      )
    ).toBe(true);
  });
});
