/* The shared-crypto twin-drift guard (app side).
 *
 * e2e.ts was a hand-synced app/engine twin. The app copy carried the DEAD cap
 * exports deriveCapKey / mintCap / verifyCap (the x-cyc-cap bearer was deleted)
 * and was MISSING blobGen / fpDisplay / openPush, while the engine copy was
 * MISSING constantTimeEqual. Against the OLD app twin this assertion failed;
 * that is the recorded fail-before.
 *
 * The app now imports the ONE shared module (@shared/e2e -> engine/shared/e2e).
 * This test and its engine sibling (e2e-surface.test.ts) pin the SAME list from
 * @shared/fixtures/e2e-surface.json, so it passes trivially from each bundle. */

import {describe, expect, test} from 'vitest';
import * as e2e from '@shared/e2e';
import surface from '@shared/fixtures/e2e-surface.json';

describe('shared e2e export surface (twin-drift guard)', () => {
  test('the app bundle sees exactly the pinned runtime export surface', () => {
    const actual = Object.keys(e2e).sort();
    expect(actual).toEqual([...surface.exports].sort());
  });
});
