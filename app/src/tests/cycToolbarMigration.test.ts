import {afterEach, describe, expect, test} from 'vitest';
import {
  migrateToolbarActionIds,
  migrateToolbarKeys,
  toolbarActionShown,
  CORE_TOOLBAR_ACTION_IDS
} from '../features/settings/preferences';
afterEach(() => {
  localStorage.clear();
});

function dump(): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    o[k] = localStorage.getItem(k)!;
  }
  return o;
}
describe('migrateToolbarActionIds', () => {
  test('the catalog ids are the engine plugin ids, not the old action ids', () => {
    expect(CORE_TOOLBAR_ACTION_IDS).toContain('ctx');
    expect(CORE_TOOLBAR_ACTION_IDS).toContain('model-indicator');
    expect(CORE_TOOLBAR_ACTION_IDS).toContain('persona');
    expect(CORE_TOOLBAR_ACTION_IDS).not.toContain('context');
    expect(CORE_TOOLBAR_ACTION_IDS).not.toContain('model');
    expect(CORE_TOOLBAR_ACTION_IDS).not.toContain('voice');
  });
  test('rewrites the legacy show/hide bits, leaving unrenamed ids alone', () => {
    localStorage.setItem('cyc-toolbar-model', '1');
    localStorage.setItem('cyc-toolbar-context', '0');
    localStorage.setItem('cyc-toolbar-voice', '1');
    localStorage.setItem('cyc-toolbar-speed', '1');
    migrateToolbarActionIds();
    expect(localStorage.getItem('cyc-toolbar-model-indicator')).toBe('1');
    expect(localStorage.getItem('cyc-toolbar-ctx')).toBe('0');
    expect(localStorage.getItem('cyc-toolbar-persona')).toBe('1');
    expect(localStorage.getItem('cyc-toolbar-speed')).toBe('1');

    expect(localStorage.getItem('cyc-toolbar-model')).toBeNull();
    expect(localStorage.getItem('cyc-toolbar-context')).toBeNull();
    expect(localStorage.getItem('cyc-toolbar-voice')).toBeNull();
  });
  test('rewrites the per-engine bits and the per-session eye overrides', () => {
    localStorage.setItem('cyc-tb::e1#t1::model', '0');
    localStorage.setItem('cyc-tb::e1#t1::context', '1');
    localStorage.setItem('cyc-tb-sess::sess-1::voice', '0');
    localStorage.setItem('cyc-tb::e1#t1::search', '1');
    migrateToolbarActionIds();
    expect(localStorage.getItem('cyc-mast::e1#t1::model-indicator')).toBe('0');
    expect(localStorage.getItem('cyc-mast::e1#t1::ctx')).toBe('1');
    expect(localStorage.getItem('cyc-mast-session::sess-1::persona')).toBe('0');
    expect(localStorage.getItem('cyc-mast::e1#t1::search')).toBe('1');
    expect(localStorage.getItem('cyc-tb::e1#t1::model')).toBeNull();
    expect(localStorage.getItem('cyc-tb::e1#t1::context')).toBeNull();
    expect(localStorage.getItem('cyc-tb-sess::sess-1::voice')).toBeNull();
  });
  test('rewrites the ids inside the drag-order arrays, legacy and per-engine', () => {
    localStorage.setItem(
      'cyc-toolbar-order',
      JSON.stringify(['speed', 'context', 'model', 'voice', 'stop'])
    );
    localStorage.setItem('cyc-tb-order::e1#t1', JSON.stringify(['model', 'ctx', 'speed']));
    migrateToolbarActionIds();
    expect(JSON.parse(localStorage.getItem('cyc-toolbar-order')!)).toEqual([
      'speed',
      'ctx',
      'model-indicator',
      'persona',
      'stop'
    ]);

    expect(JSON.parse(localStorage.getItem('cyc-mast-order::e1#t1')!)).toEqual([
      'model-indicator',
      'ctx',
      'speed'
    ]);
  });
  test('never clobbers a plugin-id key that already holds a value', () => {
    localStorage.setItem('cyc-toolbar-model', '1');
    localStorage.setItem('cyc-toolbar-model-indicator', '0');
    migrateToolbarActionIds();
    expect(localStorage.getItem('cyc-toolbar-model-indicator')).toBe('0');
    expect(localStorage.getItem('cyc-toolbar-model')).toBeNull();
  });
  test('is idempotent: a second run changes nothing', () => {
    localStorage.setItem('cyc-toolbar-model', '1');
    localStorage.setItem('cyc-tb::e1#t1::context', '0');
    localStorage.setItem('cyc-tb-sess::sess-1::voice', '1');
    localStorage.setItem('cyc-toolbar-order', JSON.stringify(['model', 'context', 'stop']));
    migrateToolbarActionIds();
    const afterFirst = dump();
    migrateToolbarActionIds();
    expect(dump()).toEqual(afterFirst);
  });
  test('moves the per-engine migration marker and leaves unrelated keys alone', () => {
    localStorage.setItem('cyc-tb-migrated::e1#t1', '1');
    localStorage.setItem('cyc-skin', 'dark');
    localStorage.setItem('cyc-engaged', 'sess-9');
    migrateToolbarActionIds();
    expect(localStorage.getItem('cyc-mast-keys-migrated::e1#t1')).toBe('1');
    expect(localStorage.getItem('cyc-skin')).toBe('dark');
    expect(localStorage.getItem('cyc-engaged')).toBe('sess-9');
  });
});
describe('migrateToolbarKeys: visibility collapses to one global set', () => {
  test('per-engine bits seed the global keys, then the per-engine keys go', () => {
    localStorage.setItem('cyc-mast::e1#t1::files', '1');
    localStorage.setItem('cyc-mast::e1#t1::speed', '0');
    migrateToolbarKeys();
    expect(localStorage.getItem('cyc-toolbar-files')).toBe('1');
    expect(localStorage.getItem('cyc-toolbar-speed')).toBe('0');
    expect(localStorage.getItem('cyc-mast::e1#t1::files')).toBeNull();
    expect(localStorage.getItem('cyc-mast::e1#t1::speed')).toBeNull();
    expect(toolbarActionShown('e1#t1', 'files')).toBe(true);
    expect(toolbarActionShown('other-engine', 'files')).toBe(true);
  });
  test('an existing global bit wins over per-engine values', () => {
    localStorage.setItem('cyc-toolbar-files', '0');
    localStorage.setItem('cyc-mast::e1#t1::files', '1');
    migrateToolbarKeys();
    expect(localStorage.getItem('cyc-toolbar-files')).toBe('0');
    expect(localStorage.getItem('cyc-mast::e1#t1::files')).toBeNull();
  });
  test('disagreeing engines resolve deterministically: first sorted key wins', () => {
    localStorage.setItem('cyc-mast::b-engine::files', '1');
    localStorage.setItem('cyc-mast::a-engine::files', '0');
    migrateToolbarKeys();
    expect(localStorage.getItem('cyc-toolbar-files')).toBe('0');
  });
  test('per-session overrides and old markers are dropped, unrelated keys stay', () => {
    localStorage.setItem('cyc-mast-session::sess-1::files', '1');
    localStorage.setItem('cyc-mast-keys-migrated::e1#t1', '1');
    localStorage.setItem('cyc-skin', 'dark');
    migrateToolbarKeys();
    expect(localStorage.getItem('cyc-mast-session::sess-1::files')).toBeNull();
    expect(localStorage.getItem('cyc-mast-keys-migrated::e1#t1')).toBeNull();
    expect(localStorage.getItem('cyc-skin')).toBe('dark');
  });
  test('runs once: a later stray per-engine key is left alone by the flag', () => {
    migrateToolbarKeys();
    localStorage.setItem('cyc-mast::e1#t1::files', '1');
    migrateToolbarKeys();
    expect(localStorage.getItem('cyc-mast::e1#t1::files')).toBe('1');
    expect(localStorage.getItem('cyc-toolbar-files')).toBeNull();
  });
  test('the very old cyc-tb keys ride the id migration into the collapse', () => {
    localStorage.setItem('cyc-tb::e1#t1::model', '0');
    localStorage.setItem('cyc-tb-sess::sess-1::voice', '1');
    migrateToolbarKeys();
    expect(localStorage.getItem('cyc-toolbar-model-indicator')).toBe('0');
    expect(localStorage.getItem('cyc-mast::e1#t1::model-indicator')).toBeNull();
    expect(localStorage.getItem('cyc-mast-session::sess-1::persona')).toBeNull();
  });
});
