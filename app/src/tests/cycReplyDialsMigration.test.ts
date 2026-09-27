/* THE APP IS A VIEW/EDITOR OF THE ENGINE-OWNED REPLY DIALS (#585).
 *
 * store/dials.ts holds no dial state now. It does two things and this file pins
 * both:
 *
 *   1. EDIT -> plugin RPC. setReplyDial is a `set` op on the engine that owns the
 *      chat. It never writes the app server (no setGlobalSettings), so there is
 *      one writer, the plugin.
 *
 *   2. MIGRATE ONCE. On the connect edge a PRISTINE plugin (every field on its
 *      ship default) adopts the owner's old app-server values through the plugin's
 *      `import` op, exactly once; a plugin anyone has already touched is left
 *      alone, and there is NO connect-time push of the individual ops.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';

const fake = vi.hoisted(() => ({
  rpc: [] as Array<{engineKey: string; op: string; args: unknown}>,
  getResult: null as unknown,
  importOk: true,
  refreshed: 0,
  settings: {} as Record<string, unknown>,
  stated: null as {replyLevel: boolean; complexity: boolean} | null,
  conns: [] as Array<{key: string}>
}));

vi.mock('@/shared/logging', () => ({cyclog: vi.fn(), setLogAutoShip: vi.fn()}));
vi.mock('../engine/store/registry', () => ({
  conns: fake.conns
}));
vi.mock('../engine/settings', () => ({
  globalSettings: () => fake.settings,
  refreshGlobalSettings: vi.fn(async () => {
    fake.refreshed++;
  }),
  serverHasReplyDials: () => fake.stated
}));
vi.mock('../engine/store/plugins', () => ({
  pluginRpc: vi.fn(async (engineKey: string, _id: string, op: string, _s: unknown, args: unknown) => {
    fake.rpc.push({engineKey, op, args});
    if (op === 'get') return fake.getResult ? {ok: true, result: fake.getResult} : {ok: false};
    if (op === 'import') return {ok: fake.importOk};
    return {ok: true};
  })
}));

import {setReplyDial, syncReplyDials} from '../engine/store/dials';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

/* The plugin defaults the engine's `get` reports: verbosity on, complexity and
 * prompt-bits off (#585 follow-up), level/complexity at the middle rung, no
 * wording edits. */
const DEFAULTS = {
  level: 3,
  complexity: 3,
  verbosityOn: true,
  complexityOn: false,
  promptBitsOn: false,
  names: {1: 'Terminal', 2: 'Chat', 3: 'Read out', 4: 'Spoken', 5: 'Voice only'},
  texts: {1: ' (t1)', 2: ' (t2)', 3: ' (t3)', 4: ' (t4)', 5: ' (t5)'},
  complexityNames: {1: 'PM', 2: 'Jr', 3: 'SnS', 4: 'Multi', 5: 'Focused'},
  complexityTexts: {1: ' (c1)', 2: ' (c2)', 3: ' (c3)', 4: ' (c4)', 5: ' (c5)'},
  bits: ['a', 'b']
};

// A `get` result at a chosen state; unedited wording unless overridden.
function getResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  const clean = {name: false, text: false};
  const rungs = () => ({1: {edited: {...clean}}, 2: {edited: {...clean}}, 3: {edited: {...clean}}, 4: {edited: {...clean}}, 5: {edited: {...clean}}});
  return {
    level: 3,
    complexity: 3,
    migrated: false,
    verbosityOn: true,
    complexityOn: false,
    promptBitsOn: false,
    verbosity: rungs(),
    complexity_rungs: rungs(),
    bits: ['a', 'b'],
    defaults: DEFAULTS,
    ...over
  };
}

function reset(): void {
  fake.rpc = [];
  fake.getResult = null;
  fake.importOk = true;
  fake.refreshed = 0;
  fake.settings = {};
  fake.stated = null;
  fake.conns = [];
}
afterEach(reset);

const ops = (op: string) => fake.rpc.filter((r) => r.op === op);
const NO_PUSH_OPS = ['set', 'toggle', 'wording', 'bits'];

describe('edits go to the plugin', () => {
  test('setReplyDial is a plugin `set`, and writes nothing to the app server', async () => {
    const ok = await setReplyDial('ws://e1/ws', 'verbosity', 4);
    expect(ok).toBe(true);
    expect(fake.rpc).toEqual([{engineKey: 'ws://e1/ws', op: 'set', args: {key: 'verbosity', n: 4}}]);
    // the app-server settings module exposes no writer here; a write would have to
    // go through pluginRpc, and only the `set` op did
    expect(ops('import')).toHaveLength(0);
  });

  test('setReplyDial refuses an unknown dial key without a round trip', async () => {
    const ok = await setReplyDial('ws://e1/ws', 'nope', 2);
    expect(ok).toBe(false);
    expect(fake.rpc).toHaveLength(0);
  });
});

describe('migrate once, no connect-time push', () => {
  test('a pristine plugin adopts the old app-server dials through `import`, exactly once', async () => {
    const RUNG2 = ' (edited two)';
    fake.settings = {
      replyLevel: 2,
      complexity: 3,
      verbosityOn: true,
      complexityOn: false,
      promptBitsOn: false,
      strings: {reply: {2: {text: RUNG2}}}
    };
    fake.stated = {replyLevel: true, complexity: true};
    fake.getResult = getResult(); // pristine

    syncReplyDials('ws://m1/ws');
    await flush();

    const imp = ops('import');
    expect(imp, 'a pristine plugin was not migrated').toHaveLength(1);
    expect(imp[0].args).toMatchObject({
      level: 2,
      complexity: 3,
      verbosityOn: true,
      complexityOn: false,
      promptBitsOn: false,
      strings: {reply: {2: {text: RUNG2}}}
    });
    // NO connect-time push: the old set/toggle/wording/bits fan-out is gone
    for (const op of NO_PUSH_OPS) expect(ops(op), `a ${op} push escaped on connect`).toHaveLength(0);

    // a second connect edge does not migrate again
    syncReplyDials('ws://m1/ws');
    await flush();
    expect(ops('import'), 'the migration ran a second time').toHaveLength(1);
  });

  test('a plugin someone already touched is never migrated over', async () => {
    fake.settings = {replyLevel: 2, complexity: 3, verbosityOn: true, complexityOn: false, promptBitsOn: false, strings: {}};
    fake.stated = {replyLevel: true, complexity: true};
    fake.getResult = getResult({level: 5}); // a stated level: not pristine

    syncReplyDials('ws://m2/ws');
    await flush();

    expect(ops('import'), 'a touched plugin was overwritten').toHaveLength(0);
    for (const op of NO_PUSH_OPS) expect(ops(op)).toHaveLength(0);
  });

  test('a pristine plugin with nothing new on the app server is left untouched', async () => {
    // the app server holds only the ship defaults (and states no level)
    fake.settings = {replyLevel: 3, complexity: 3, verbosityOn: true, complexityOn: false, promptBitsOn: false, strings: {}};
    fake.stated = {replyLevel: false, complexity: false};
    fake.getResult = getResult();

    syncReplyDials('ws://m3/ws');
    await flush();

    expect(ops('import'), 'nothing differed, yet a migration ran').toHaveLength(0);
  });

  test('an override equal to the shipped default is not a difference (no migration)', async () => {
    // the owner's rung-2 override now equals the shipped default text, so it must
    // read as "no edit" and not by itself trigger a migration
    fake.settings = {
      replyLevel: 3,
      complexity: 3,
      verbosityOn: true,
      complexityOn: false,
      promptBitsOn: false,
      strings: {reply: {2: {text: DEFAULTS.texts[2]}}}
    };
    fake.stated = {replyLevel: false, complexity: false};
    fake.getResult = getResult();

    syncReplyDials('ws://m4/ws');
    await flush();

    expect(ops('import'), 'an override equal to the default triggered a migration').toHaveLength(0);
  });
});
