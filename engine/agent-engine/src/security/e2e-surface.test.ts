/* The shared-crypto twin-drift guard (engine side).
 *
 * e2e.ts, tunnel.ts and dcpipe.ts used to be hand-synced app/engine twins. The
 * crypto pair had drifted at the export surface: the app twin carried the DEAD
 * cap exports deriveCapKey / mintCap / verifyCap (the x-cyc-cap bearer was
 * deleted) and was MISSING blobGen / fpDisplay / openPush; the engine twin was
 * MISSING constantTimeEqual (its timing-safe compare was the unexported
 * bytesEqual). Run against either OLD twin, the assertion below fails; that is
 * the recorded fail-before.
 *
 * There is now ONE module (engine/shared/e2e.ts) imported by both the engine
 * and the app bundle. This test and its app sibling (cycE2eSurface.test.ts)
 * both pin the SAME list (fixtures/e2e-surface.json), so after unification the
 * assertion passes trivially from each side. The wire itself is pinned
 * separately by e2e-vectors.json, exercised from both bundles. */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import * as e2e from "../../../shared/e2e";

const SURFACE = new URL("../../../shared/fixtures/e2e-surface.json", import.meta.url).pathname;
const expected: string[] = JSON.parse(readFileSync(SURFACE, "utf8")).exports;

test("shared e2e exposes exactly the pinned runtime export surface", () => {
  const actual = Object.keys(e2e).sort();
  expect(actual).toEqual([...expected].sort());
});
