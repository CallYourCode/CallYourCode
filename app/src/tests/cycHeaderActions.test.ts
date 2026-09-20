import {afterEach, beforeAll, describe, expect, test} from 'vitest';
import {
  createHeaderActions,
  captioned,
  type HeaderActions
} from '../features/sessions/header/actions';
import {CORE_TOOLBAR_ACTION_IDS} from '../features/settings/preferences';
const ENGINE = 'test-engine';

const PLUGINS = new Set(['crons', 'model-indicator', 'persona', 'git', 'files']);

const CANON = [
  'speed',
  'sound',
  'activity',
  'crons',
  'call',
  'notify',
  'ctx',
  'model-indicator',
  'terminal',
  'git',
  'files',
  'persona',
  'stop'
];
beforeAll(() => {
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  localStorage.clear();
  document.body.textContent = '';
});
function pin(shown: Record<string, boolean>) {
  for (const id of CORE_TOOLBAR_ACTION_IDS) {
    localStorage.setItem(`cyc-toolbar-${id}`, shown[id] ? '1' : '0');
  }
}
function makeBar(plugins: ReadonlySet<string> = PLUGINS): {
  el: HTMLElement;
  utils: HTMLElement;
  actions: HeaderActions;
} {
  const el = document.createElement('div');
  const utils = document.createElement('div');
  el.append(utils);
  document.body.append(el);
  const actions = createHeaderActions({
    el,
    utils,
    sessionId: () => 'sess-1',
    toolbarEngine: () => ({engineKey: ENGINE, plugins})
  });
  utils.append(actions.headerBreak);
  return {el, utils, actions};
}

function barReading(utils: HTMLElement, actions: HeaderActions): string[] {
  const out: string[] = [];
  for (const child of Array.from(utils.children) as HTMLElement[]) {
    if (child === actions.headerBreak) {
      out.push('BREAK');
      continue;
    }
    if (child.classList.contains('cyc-off')) continue;
    const id = child.dataset.cycAction;
    if (id) out.push(id);
  }
  return out;
}
describe('captioned', () => {
  test('wraps the control and its name in one slot', () => {
    const btn = document.createElement('button');
    const slot = captioned(btn, 'Files');
    expect(slot.classList.contains('cyc-mast-slot')).toBe(true);
    expect(slot.contains(btn)).toBe(true);
    expect(slot.querySelector('.cyc-mast-caption')?.textContent).toBe('Files');
  });
  test('the short spelling rides beside the long one, both in the DOM', () => {
    const slot = captioned(document.createElement('button'), 'Context', 'CTX');
    expect(slot.querySelector('.cyc-mast-caption-long')?.textContent).toBe('Context');
    expect(slot.querySelector('.cyc-mast-caption-short')?.textContent).toBe('CTX');
  });
});
describe('refreshToolbarActions: what lands in the bar', () => {
  test('all toolbar actions on: canonical order, break after the third shown', () => {
    pin(Object.fromEntries(CORE_TOOLBAR_ACTION_IDS.map((id) => [id, true])));
    const {utils, actions} = makeBar();
    actions.refreshToolbarActions();
    expect(barReading(utils, actions)).toEqual([
      'speed',
      'sound',
      'activity',
      'BREAK',
      'crons',
      'call',
      'notify',
      'ctx',
      'model-indicator',
      'terminal',
      'git',
      'files',
      'persona',
      'stop'
    ]);
  });
  test('the default phone actions fit the title row: no break at all', () => {
    pin({speed: true, ctx: true, stop: true});
    const {utils, actions} = makeBar();
    actions.refreshToolbarActions();
    expect(barReading(utils, actions)).toEqual(['speed', 'ctx', 'stop']);
    expect(actions.headerBreak.parentElement).toBeNull();
  });
  test('four shown keep a single title row', () => {
    pin({call: true, notify: true, ctx: true, stop: true});
    const {utils, actions} = makeBar();
    actions.refreshToolbarActions();
    expect(barReading(utils, actions)).toEqual(['call', 'notify', 'ctx', 'stop']);
  });
  test('a hidden slot keeps its DOM and its wiring: actionButton still finds it', () => {
    pin({speed: true, ctx: true, stop: true});
    const {utils, actions} = makeBar();
    actions.refreshToolbarActions();
    const filesSlot = utils.querySelector<HTMLElement>('[data-cyc-action="files"]');
    expect(filesSlot?.classList.contains('cyc-off')).toBe(true);
    expect(actions.actionButton('files')).not.toBeNull();
  });
  test('an undeclared plugin action never lands in the bar', () => {
    pin(Object.fromEntries(CORE_TOOLBAR_ACTION_IDS.map((id) => [id, true])));

    const {utils, actions} = makeBar(new Set<string>());
    actions.refreshToolbarActions();
    const ids = barReading(utils, actions).filter((x) => x !== 'BREAK');
    expect(ids).not.toContain('crons');
    expect(ids).not.toContain('model-indicator');
    expect(ids).not.toContain('persona');
    expect(ids).toContain('speed');
    expect(ids).toContain('stop');
  });
  test('a slot whose plugin the engine stopped declaring is hidden, not orphaned', () => {
    pin(Object.fromEntries(CORE_TOOLBAR_ACTION_IDS.map((id) => [id, true])));
    let plugins: ReadonlySet<string> = PLUGINS;
    const el = document.createElement('div');
    const utils = document.createElement('div');
    el.append(utils);
    document.body.append(el);
    const actions = createHeaderActions({
      el,
      utils,
      sessionId: () => 'sess-1',
      toolbarEngine: () => ({engineKey: ENGINE, plugins})
    });
    utils.append(actions.headerBreak);
    actions.refreshToolbarActions();
    plugins = new Set<string>();
    actions.refreshToolbarActions();
    const cronsSlot = utils.querySelector<HTMLElement>('[data-cyc-action="crons"]');
    expect(cronsSlot).not.toBeNull();
    expect(cronsSlot!.classList.contains('cyc-off')).toBe(true);
    expect(barReading(utils, actions)).not.toContain('crons');
  });
  test('the visibility bit is global: one change lands in every session bar', () => {
    pin({speed: true, ctx: true, stop: true});
    const mk = (sessionId: string) => {
      const el = document.createElement('div');
      const utils = document.createElement('div');
      el.append(utils);
      document.body.append(el);
      const actions = createHeaderActions({
        el,
        utils,
        sessionId: () => sessionId,
        toolbarEngine: () => ({engineKey: ENGINE, plugins: PLUGINS})
      });
      utils.append(actions.headerBreak);
      return {utils, actions};
    };
    const a = mk('sess-1');
    const b = mk('sess-2');
    a.actions.refreshToolbarActions();
    b.actions.refreshToolbarActions();
    expect(barReading(a.utils, a.actions)).not.toContain('files');
    expect(barReading(b.utils, b.actions)).not.toContain('files');
    localStorage.setItem('cyc-toolbar-files', '1');
    a.actions.refreshToolbarActions();
    b.actions.refreshToolbarActions();
    expect(barReading(a.utils, a.actions)).toContain('files');
    expect(barReading(b.utils, b.actions)).toContain('files');
  });

  test('a stale per-session override key is ignored: the global bit rules', () => {
    pin({speed: true, ctx: true, stop: true});
    localStorage.setItem('cyc-mast-session::sess-1::files', '1');
    const {utils, actions} = makeBar();
    actions.refreshToolbarActions();
    const ids = barReading(utils, actions).filter((x) => x !== 'BREAK');
    expect(ids).not.toContain('files');
    expect(ids).toHaveLength(3);
  });
  test('a stored drag order re-homes the row, unknown ids dropped', () => {
    pin(Object.fromEntries(CORE_TOOLBAR_ACTION_IDS.map((id) => [id, true])));
    localStorage.setItem(
      `cyc-mast-order::${ENGINE}`,
      JSON.stringify(['stop', 'no-such-action', 'speed'])
    );
    const {utils, actions} = makeBar();
    actions.refreshToolbarActions();
    const ids = barReading(utils, actions).filter((x) => x !== 'BREAK');

    expect(ids.slice(0, 2)).toEqual(['stop', 'speed']);
    expect(ids).toHaveLength(CANON.length);
    expect(new Set(ids).size).toBe(CANON.length);
  });
  test('a registered slot is reused, not rebuilt', () => {
    pin(Object.fromEntries(CORE_TOOLBAR_ACTION_IDS.map((id) => [id, true])));
    const {utils, actions} = makeBar();
    const mine = captioned(document.createElement('button'), 'Stop');
    actions.reg('stop', mine);
    actions.refreshToolbarActions();
    expect(utils.querySelector('[data-cyc-action="stop"]')).toBe(mine);

    actions.refreshToolbarActions();
    expect(utils.querySelectorAll('[data-cyc-action="stop"]')).toHaveLength(1);
  });
});
describe('actionButton', () => {
  test('returns the clickable inside a slot, null for an unknown id', () => {
    pin(Object.fromEntries(CORE_TOOLBAR_ACTION_IDS.map((id) => [id, true])));
    const {actions} = makeBar();
    actions.refreshToolbarActions();
    const btn = actions.actionButton('crons');
    expect(btn).not.toBeNull();
    expect(btn!.classList.contains('cyc-icon-btn')).toBe(true);
    expect(actions.actionButton('never-registered')).toBeNull();
  });
});
