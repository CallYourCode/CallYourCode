import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {markReloadDeparture, readReloadDeparture} from '../shared/selfReload';

// The update-reload breadcrumb (localStorage, so it survives the owner
// force-closing out of a black screen and relaunching): stamped just before the
// reload navigation and read exactly once at the next boot, so that boot can log
// how long the gap was and which builds it crossed.

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe('reload departure breadcrumb', () => {
  test('round-trips the builds and a sane timestamp', () => {
    const before = Date.now();
    markReloadDeparture('100', '200');
    const d = readReloadDeparture();
    expect(d).not.toBeNull();
    expect(d!.from).toBe('100');
    expect(d!.to).toBe('200');
    expect(d!.at).toBeGreaterThanOrEqual(before);
    expect(d!.at).toBeLessThanOrEqual(Date.now());
  });

  test('names a reload that left from the background (its gap is not a stuck reload)', () => {
    markReloadDeparture('100', '200', true);
    expect(readReloadDeparture()?.hidden).toBe(true);
    markReloadDeparture('100', '200');
    expect(readReloadDeparture()?.hidden).toBe(false);
  });

  test('is spent on read: the next boot does not re-log the same reload', () => {
    markReloadDeparture('100', '200');
    expect(readReloadDeparture()).not.toBeNull();
    expect(readReloadDeparture(), 'the breadcrumb was read twice').toBeNull();
  });

  test('no breadcrumb (a plain launch, not our reload) reads null', () => {
    expect(readReloadDeparture()).toBeNull();
  });

  test('a corrupt breadcrumb is ignored, not thrown', () => {
    localStorage.setItem('cyc-reload-depart', '{not json');
    expect(readReloadDeparture()).toBeNull();
    localStorage.setItem('cyc-reload-depart', JSON.stringify({from: 'x', to: 'y'}));
    expect(readReloadDeparture(), 'a record with no timestamp is not a real departure').toBeNull();
  });
});
